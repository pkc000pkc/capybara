import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { digest, fileDigest, readJson, within, writeJson } from '../../src/phase0_run.mjs'
import { canonicalScenarioHash, scenarioIdSetSha256 } from '../../src/phase0_dataset.mjs'
import { runChildProcess } from '../../src/phase1_process.mjs'
import { collectRuntimeEvidence, pythonEventHash } from '../../src/phase3_runtime_evidence.mjs'
import { CORRECTION_CONTRACT, parseCorrectionPlan, renderTrustedCorrection } from '../../src/phase4_correction_contract.mjs'
import { healthyTrainingProcess } from '../../src/phase4_training_broker.mjs'
import { loadTrainingParent, trainingEvidenceReader } from '../../src/phase4_training.mjs'
import { readSealedTrainingParent, sealTrainingBaseline, sealTrainingParent } from '../../src/phase4_training_proof.mjs'
import { runtimeFixture } from './runtime_evidence_fixture.mjs'

const PROJECT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const portable = value => value.replaceAll('\\', '/')
const sha = value => createHash('sha256').update(value).digest('hex')
const SOURCES = {
  project: ['src/phase4_training.mjs', 'src/phase4_training_proof.mjs', 'src/phase4_training_broker.mjs', 'src/phase4_correction_contract.mjs', 'scripts/phase4_training_host.ts', 'scripts/phase4_training_broker.py', 'scripts/gaia2_model_retry.py', 'scripts/gaia2_model_diagnostics.py'],
  backend: ['src/core/plugins/training-plugin-host.ts', 'src/core/system-variable-values.ts'],
}
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name)
    assert(!entry.isSymbolicLink(), 'fixture source must not contain links')
    return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : []
  })
}

// This controls proof wiring only. Its initial native/runtime envelopes are
// synthetic evidence fixtures, NOT benchmark executions or real model calls.
function createControlledParent({ root, fixtureRoot, kind, fullInitialPlan }) {
  const f = runtimeFixture({ root: fixtureRoot }), prefix = portable(relative(root, fixtureRoot))
  const rebase = value => `${prefix}/${portable(value)}`
  const put = (path, value) => { writeJsonOrText(join(root, path), value); return { path, sha256: fileDigest(join(root, path)) } }
  const scenario = { version: 'controlled-scenario-v1', metadata: { definition: { scenario_id: f.task.scenarioId, run_number: f.task.runNumber } },
    world_logs: [], apps: [], events: [], completed_events: [], context: {}, augmentation: null }
  const controlledSourceRef = put(rebase('controlled-source.json'), scenario)
  const task = { ...f.task, ...Object.fromEntries(['outputDir', 'fixtureDir', 'workspaceDir'].map(key => [key, rebase(f.task[key])])),
    scenarioHash: canonicalScenarioHash(scenario), scenarioVersion: scenario.version, sourcePath: controlledSourceRef.path, rowIndex: 0 }
  const session = { ...f.session, ...Object.fromEntries(['outputDir', 'fixtureDir', 'workspaceDir'].map(key => [key, rebase(f.session[key])])) }
  const caps = readJson(join(fixtureRoot, f.manifest.lockRefs.capabilities.path))
  for (const plugin of caps.plugins) plugin.snapshotRoot = rebase(plugin.snapshotRoot)
  const capabilitiesRef = put(rebase(f.manifest.lockRefs.capabilities.path), caps)
  const { manifestHash: ignored, ...old } = f.manifest
  const tasks = fullInitialPlan ? ['execution', 'search', 'adaptability', 'time', 'ambiguity'].flatMap(config => {
    const otherScenario = config === 'execution' ? scenario : { ...scenario, metadata: { definition: { scenario_id: `scenario-${config}`, run_number: 1 } } }
    const source = config === 'execution' ? controlledSourceRef : put(rebase(`controlled-source-${config}.json`), otherScenario)
    return Array.from({ length: 5 }, (_, index) => {
      if (config === 'execution' && index === 0) return task
      const executionId = `controlled-${config}-${index + 1}`
      return { ...task, executionId, config, scenarioId: otherScenario.metadata.definition.scenario_id, scenarioHash: canonicalScenarioHash(otherScenario),
        sourcePath: source.path, runNumber: index + 1, attemptIndex: index + 1,
        outputDir: rebase(`runs/fixture/executions/${executionId}`), fixtureDir: rebase(`runs/fixture/fixtures/${executionId}`), workspaceDir: rebase(`runs/fixture/workspaces/${executionId}`) }
    })
  }) : [task]
  const base = { ...old, schemaVersion: 'gaia2-run-manifest-v1', controlledFixtureOnly: true,
    dataset: { kind: 'source' }, runRoot: rebase(old.runRoot), stateFile: rebase(old.stateFile), tasks,
    selection: { ...old.selection, expectedInitialExecutions: tasks.length },
    lockRefs: { capabilities: capabilitiesRef } }
  const manifest = { ...base, manifestHash: digest(base) }
  const evidenceDirectory = join(root, session.workspaceDir, 'plugin-runtime')
  let calls = readdirSync(evidenceDirectory).map(name => ({ path: `${session.workspaceDir}/plugin-runtime/${name}`, value: readJson(join(evidenceDirectory, name)) })).filter(item => item.value.schemaVersion === 'capybara-runtime-plugin-invocation-v1')
  const events = structuredClone(f.events), before = calls.find(item => item.value.input.checkpoint === 'before_tool').value
  const after = calls.find(item => item.value.input.checkpoint === 'after_tool').value
  calls[0].value.input.messages = [{ role: 'user', content: 'FUTURE_USER_SENTINEL_MUST_NOT_ENTER_TRAINING' }]
  before.input.action.arguments = { recordId: 'OLD_RECORD_SENTINEL_DO_NOT_REPLAY' }
  after.input.action = structuredClone(before.input.action)
  if (kind === 'read_failed') {
    after.input.outcome.status = 'failed_before_execution'
    events.find(event => event.type === 'tool_call_completed').status = 'failed_before_execution'
  } else if (kind === 'multi_tool_response_rejected') {
    const at = events.findIndex(event => event.type === 'model_request')
    events.splice(at + 1, 0, { ...events[at], type: 'model_response', toolCallCount: 2, hasContent: false })
    const started = events.find(event => event.type === 'tool_call_started')
    started.type = 'tool_call_blocked'; started.reason = 'multiple_tool_calls_not_supported'
    events.splice(events.findIndex(event => event.type === 'tool_call_completed'), 1)
    events.splice(events.findIndex(event => event.type === 'live_hook_completed' && event.checkpoint === 'after_tool'), 1)
    const removed = calls.find(item => item.value.input.checkpoint === 'after_tool')
    unlinkSync(join(root, removed.path)); calls = calls.filter(item => item !== removed)
    const last = calls.at(-1); unlinkSync(join(root, last.path))
    last.path = `${session.workspaceDir}/plugin-runtime/000004-attempt_end.json`; last.value.sequence = 4
  } else throw new Error('unsupported controlled parent defect')
  for (const item of calls) {
    put(item.path, item.value)
    events.find(event => event.type === 'live_hook_completed' && event.checkpoint === item.value.input.checkpoint).hookReceiptsHash = pythonEventHash(item.value.hookReceipts)
  }
  events.find(event => event.type === 'attempt_execution_ended').terminationReason = 'conversation_turn_limit'
  events.find(event => event.type === 'official_validation_completed').validationSuccess = false
  put(`${session.outputDir}/runtime-events.jsonl`, events.map(event => JSON.stringify(event)).join('\n') + '\n')
  const hostProcess = { ...f.hostProcess, childExited: true, childClosed: true,
    processIdentity: { verified: true, platform: 'controlled_fixture', pid: 123, creationTime: 'controlled-parent-generation', fixtureOnly: true } }
  put(`${session.outputDir}/hook-host/process-result.json`, hostProcess)
  // Re-run the production collector after rebinding all paths to the real
  // project root, so each unique fixture has independently bound references.
  const firstCapture = join(root, session.workspaceDir, 'plugin-runtime-sources'), preservedCapture = join(fixtureRoot, 'unbound-first-control-capture')
  assert(within(fixtureRoot, firstCapture) && within(fixtureRoot, preservedCapture))
  renameSync(firstCapture, preservedCapture)
  const collected = collectRuntimeEvidence({ root, manifest, task, session, events, hostProcess })
  put(`${session.outputDir}/process-result.json`, hostProcess)
  const runtime = { processTimeoutMs: 0 }
  put(`${manifest.runRoot}/runtime-settings.json`, runtime)
  const traceRef = put(`${session.outputDir}/hf/trace.json`, { world_logs: [], apps: [], events: [], completed_events: [], version: 'controlled-evidence-fixture', context: {}, augmentation: null, metadata: { definition: { scenario_id: task.scenarioId, run_number: task.runNumber, has_exception: false } } })
  const nativeRef = put(`${session.outputDir}/output.jsonl`, JSON.stringify({ task_id: task.scenarioId, trace_id: 'hf/trace.json', score: 0, metadata: { scenario_id: task.scenarioId, run_number: task.runNumber, status: 'failed', has_exception: false } }) + '\n')
  const result = { schemaVersion: 'gaia2-task-result-v1', runId: manifest.runId, manifestHash: manifest.manifestHash, runtimeHash: digest(runtime), sessionId: session.sessionId,
    ...Object.fromEntries(['executionId', 'scenarioId', 'phase', 'config', 'runNumber'].map(key => [key, task[key]])),
    evaluationComplete: true, businessPassed: false, score: 0, failure: { category: 'business_failure', retryable: false },
    process: { exitCode: 0, signal: null, timedOut: false, interrupted: false }, artifacts: [nativeRef, traceRef],
    runtimeEvidenceRequired: true, realHooksReady: true, ...collected }
  const resultRef = put(`${session.workspaceDir}/task-result.json`, result)
  put(manifest.stateFile, { schemaVersion: 'gaia2-run-state-v1', runId: manifest.runId, manifestHash: manifest.manifestHash, runtimeHash: result.runtimeHash,
    tasks: [{ executionId: task.executionId, status: 'completed', sessions: [session], resultPath: resultRef.path, resultSha256: resultRef.sha256, failure: result.failure }] })
  const manifestPath = join(fixtureRoot, 'parent-manifest.json'); writeJson(manifestPath, manifest)
  return { manifestPath, parent: loadTrainingParent({ root, manifestPath, executionId: task.executionId }), put, scenario, controlledSourceRef }
}
function writeJsonOrText(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  if (typeof value === 'string') writeFileSync(path, value)
  else writeJson(path, value)
}

/** File-only teardown gate: uncertain replay processes retain the entire fixture. */
export function cleanupTrainingProofFixture({ runDirectory, fixtureRoot, trainingCleanupSafe }) {
  const directory = resolve(runDirectory), fixture = resolve(fixtureRoot)
  assert(within(directory, fixture) && fixture !== directory)
  if (trainingCleanupSafe !== true) return false
  try {
    const rootStat = lstatSync(fixture)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false
    for (const entry of readdirSync(fixture, { withFileTypes: true })) {
      if (!entry.name.startsWith('replay-')) continue
      const replay = join(fixture, entry.name), output = join(replay, 'output'), host = join(output, 'hook-host')
      for (const path of [replay, output, host]) {
        const stat = lstatSync(path)
        if (!stat.isDirectory() || stat.isSymbolicLink()) return false
      }
      const processDirectories = [host], actor = join(output, 'actor-process')
      let actorStat
      try { actorStat = lstatSync(actor) } catch (error) {
        // Startup can fail before creating Actor output. lstat (not existsSync)
        // still observes dangling links, which must never count as absent.
        if (error.code !== 'ENOENT') throw error
      }
      if (actorStat) {
        if (!actorStat.isDirectory() || actorStat.isSymbolicLink()) return false
        processDirectories.push(actor)
      }
      for (const processDirectory of processDirectories) {
        const resultPath = join(processDirectory, 'process-result.json'), resultStat = lstatSync(resultPath)
        if (!resultStat.isFile() || resultStat.isSymbolicLink()) return false
        const result = JSON.parse(readFileSync(resultPath, 'utf8'))
        if (result?.schemaVersion !== 'gaia2-process-result-v1'
          || result.childExited !== true || result.childClosed !== true
          || result.manualInspectionRequired !== false
          || !Array.isArray(result.terminationErrors) || result.terminationErrors.length !== 0) return false
      }
    }
  } catch {
    // Missing, damaged, unreadable, or linked evidence never proves cleanup.
    return false
  }
  rmSync(fixture, { recursive: true, force: true })
  return true
}

/** Real frozen TS Host -> pinned Python/LiteLLM -> local HTTP control. */
export async function trainingProofFixture(t, { kind = 'multi_tool_response_rejected', rawResponse = null, fullInitialPlan = false } = {}) {
  const root = PROJECT_ROOT, runDirectory = join(root, 'runs')
  mkdirSync(runDirectory, { recursive: true })
  const fixtureRoot = mkdtempSync(join(runDirectory, 'phase4-training-proof-test-'))
  let cleanupSafe = false
  t.after(() => {
    // Preserve diagnostics if native cleanup became uncertain; never delete
    // a running/unknown process's workspace or authorize a bare PID kill.
    cleanupTrainingProofFixture({ runDirectory, fixtureRoot, trainingCleanupSafe: cleanupSafe })
  })
  const { parent, manifestPath: parentManifestPath, put, scenario, controlledSourceRef } = createControlledParent({ root, fixtureRoot, kind, fullInitialPlan })
  assert.equal(parent.evidence.trainingAllowed, true)
  const defect = parent.evidence.sealed.observableSummary.defects[0]
  const candidate = { schemaVersion: 'gaia2-correction-plan-v1', ...Object.fromEntries(['defectCode', 'procedureIds', 'verificationIds', 'evidenceHash'].map(key => [key, defect[key]])) }
  const httpRequests = []
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    const payload = JSON.parse(body); httpRequests.push({ method: request.method, url: request.url, payload })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ id: 'controlled-correction', object: 'chat.completion', created: 1, model: 'gpt-6-luna',
      choices: [{ index: 0, message: { role: 'assistant', content: typeof rawResponse === 'function' ? rawResponse(candidate) : rawResponse ?? JSON.stringify(candidate) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 } }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const protocol = readJson(join(root, 'config/phase0-protocol.json'))
  const localCredentials = join(fixtureRoot, 'dummy-connection.txt')
  writeFileSync(localCredentials, `base_url: http://127.0.0.1:${server.address().port}/v1\nkey: controlled-test-key-not-real\n`, { flag: 'wx' })
  const configPath = join(fixtureRoot, 'controlled-model-config.json'); writeJson(configPath, { apiKeySource: localCredentials }, { immutable: true })
  const models = { actor: { model: 'gpt-6-luna', provider: 'openai' }, judge: { model: 'gpt-6-luna', provider: 'openai' }, configurationSource: portable(relative(root, configPath)) }
  const plugins = ['gaia2-runtime', 'gaia2-evaluation'].map(id => {
    const snapshotRoot = join(fixtureRoot, 'frozen-plugins', id)
    cpSync(join(root, 'plugins', id), snapshotRoot, { recursive: true })
    return { id, snapshotRoot, files: files(snapshotRoot).map(file => ({ relativePath: portable(relative(snapshotRoot, file)), sha256: fileDigest(file) })).sort((a, b) => a.relativePath.localeCompare(b.relativePath)) }
  })
  assert.equal(readJson(join(plugins[1].snapshotRoot, 'capybara.plugin.json')).version, '1.2.0')
  const capabilities = { plugins }
  const baselinePath = path => portable(relative(root, join(fixtureRoot, 'controlled-baseline', path)))
  const capabilitiesRef = put(baselinePath('locks/capability-inventory.json'), capabilities)
  const codeInputs = SOURCES.project.map(path => ({ path, sha256: fileDigest(join(root, path)) }))
  const backendInputs = SOURCES.backend.map(path => ({ path, sha256: fileDigest(join(protocol.runtime.backendRoot, path)) }))
  const environmentRef = put(baselinePath('locks/environment-lock.json'), { controlledFixtureOnly: true, codeInputs, backend: { codeInputs: backendInputs } })
  // Match the real five-lock formats, including a multi-row JSONL index. The
  // source rows remain explicitly controlled fixtures, not a dataset freeze.
  const indexRows = [...new Map(parent.manifest.tasks.map(task => [`${task.config}/${task.scenarioId}`, {
    datasetKind: 'source', config: task.config, id: task.scenarioId, path: task.sourcePath,
    rowIndex: task.rowIndex, scenarioHash: task.scenarioHash, scenarioVersion: task.scenarioVersion,
  }])).values()]
  if (indexRows.length === 1) {
    const otherScenario = { ...scenario, metadata: { definition: { scenario_id: 'controlled-training-index-extra', run_number: 1 } } }
    const sourceRef = put(baselinePath('source/controlled-index-extra.json'), otherScenario)
    indexRows.push({ datasetKind: 'source', config: 'search', id: otherScenario.metadata.definition.scenario_id,
      path: sourceRef.path, rowIndex: 0, scenarioHash: canonicalScenarioHash(otherScenario), scenarioVersion: otherScenario.version })
  }
  assert(indexRows.length >= 2)
  const scenarioIndexRef = put(baselinePath('data/scenario-index.jsonl'), indexRows.map(row => JSON.stringify(row)).join('\n') + '\n')
  const protocolRef = put(baselinePath('config/phase0-protocol.json'), { ...protocol, models, controlledFixtureOnly: true })
  const sourceSpec = protocol.datasets.source
  const datasetRef = put(baselinePath('locks/dataset-lock.json'), {
    schemaVersion: 1, controlledFixtureOnly: true,
    canonicalScenarioHash: 'sha256(canonical JSON; recursively sorted object keys; array order and every field retained)',
    scenarioIdSetHash: 'sha256(JSON.stringify(sorted unique scenario IDs))',
    datasets: { source: { id: sourceSpec.id, revision: sourceSpec.revision, split: sourceSpec.split,
      cacheDir: baselinePath('source'), configs: [...new Set(indexRows.map(row => row.config))], count: indexRows.length,
      scenarioIdSetSha256: scenarioIdSetSha256(indexRows.map(row => row.id)),
      files: indexRows.map(row => ({ config: row.config, remotePath: 'controlled-fixture-only', path: row.path,
        bytes: readFileSync(join(root, row.path)).length, sha256: fileDigest(join(root, row.path)), count: 1,
        scenarioIdSetSha256: scenarioIdSetSha256([row.id]), scenarioVersions: [row.scenarioVersion] })) } },
    scenarioIndex: { ...scenarioIndexRef, count: indexRows.length },
  })
  const trainingBase = { ...Object.fromEntries(Object.entries(parent.manifest).filter(([key]) => key !== 'manifestHash')),
    runId: 'controlled-training-proof', models,
    lockRefs: { protocol: protocolRef, environment: environmentRef, capabilities: capabilitiesRef, dataset: datasetRef, scenarioIndex: scenarioIndexRef },
    controlledFixtureOnly: true }
  const trainingManifest = { ...trainingBase, manifestHash: digest(trainingBase) }
  const trainingManifestPath = join(fixtureRoot, 'training-manifest.json'); writeJson(trainingManifestPath, trainingManifest, { immutable: true })
  const outputDir = join(fixtureRoot, 'training'); mkdirSync(outputDir)
  const readEvidence = trainingEvidenceReader(root)
  const parentEvidence = sealTrainingParent({ root, outputDir, parent })
  const sealed = readSealedTrainingParent({ parentEvidence, readEvidence })
  const { manifestRef, baseline } = sealTrainingBaseline({ root, outputDir, manifest: trainingManifest, manifestPath: trainingManifestPath, protocol, readEvidence })
  const input = { phase: 'training', evaluation: { evaluated: true, category: 'business_failure', passed: false }, summary: sealed.evidence.sealed.observableSummary,
    source: { executionId: parent.task.executionId, sessionId: parent.session.sessionId, attemptIndex: parent.task.attemptIndex },
    evidence: { runtimeAttestationHash: digest(parent.result.runtimeAttestation), resultHash: parent.resultHash, manifestHash: parent.manifest.manifestHash } }
  const inputPath = join(outputDir, 'sanitized-training-input.json'); writeJson(inputPath, input, { immutable: true })
  const options = { projectDir: root, workspaceDir: outputDir, plugins, executionId: 'controlled-correction', sessionId: 'controlled-training', scenarioId: parent.task.scenarioId,
    contract: CORRECTION_CONTRACT, providerCleanupTimeoutMs: 30000 }
  const resultPath = join(outputDir, 'host-result.json'), specPath = join(outputDir, 'host-spec.json')
  const settings = { processTimeoutMs: 30000, heartbeatIntervalMs: 100, modelRequestTimeoutSeconds: 3,
    modelRetry: { maxAttempts: 1, backoffBaseSeconds: 0, backoffMaxSeconds: 0, maxRetryWaitSeconds: 0 } }
  const spec = { backendRoot: protocol.runtime.backendRoot, projectDir: root, workspaceDir: outputDir, models, settings, resultPath, options, invocation: { checkpoint: 'after_evaluation', training: input } }
  writeJson(specPath, spec, { immutable: true })
  const filtered = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|ACCESS_TOKEN|AUTHORIZATION|HF_TOKEN|HUGGINGFACE_TOKEN|GAIA2_HOOK_TOKEN)/i.test(key)))
  const processResult = await runChildProcess({ command: process.execPath,
    args: [`--import=${pathToFileURL(join(protocol.runtime.backendRoot, 'node_modules/tsx/dist/loader.mjs')).href}`, '--conditions=development', join(root, 'scripts/phase4_training_host.ts'), '--spec', specPath],
    cwd: outputDir, env: { ...filtered, TMP: outputDir, TEMP: outputDir, TMPDIR: outputDir },
    outputDir: join(outputDir, 'host-process'), processTimeoutMs: 60000, heartbeatIntervalMs: 100, secrets: ['controlled-test-key-not-real'] })
  cleanupSafe = processResult.childExited === true && processResult.childClosed === true && !processResult.manualInspectionRequired
    && Array.isArray(processResult.terminationErrors) && processResult.terminationErrors.length === 0
  const hostResult = existsSync(resultPath) ? readJson(resultPath) : null
  cleanupSafe = cleanupSafe && hostResult?.cleanupCompleted === true && hostResult.manualInspectionRequired === false
    && Array.isArray(hostResult.operationalReceipts) && hostResult.operationalReceipts.every(receipt =>
      receipt.process?.childExited === true && receipt.process.childClosed === true && !receipt.process.manualInspectionRequired
      && Array.isArray(receipt.process.terminationErrors) && receipt.process.terminationErrors.length === 0)
  const ref = file => ({ path: portable(relative(root, file)), sha256: fileDigest(file) })
  if (!hostResult || hostResult.status !== 'passed') return { root, fixtureRoot, manifest: parent.manifest, parent, trainingManifest, trainingManifestPath, capabilities, spec, processResult, hostResult, httpRequests, readEvidence, put, candidate, scenario, controlledSourceRef, status: 'training_failed' }
  assert.equal(healthyTrainingProcess(processResult), true)
  const proposal = hostResult.result.proposals[0].output.correction
  const { freshReplayRequired, attemptCountDelta, ...planInput } = proposal
  assert.equal(freshReplayRequired, true); assert.equal(attemptCountDelta, 0)
  const plan = parseCorrectionPlan({ candidate: planInput, evidence: sealed.evidence }), strategy = { plan, ...renderTrustedCorrection(plan) }
  const evidence = files(outputDir).map(ref), events = hostResult.operationalReceipts.flatMap(receipt => receipt.events)
  const report = { schemaVersion: 'gaia2-phase4-training-probe-v1', status: 'strategy_ready', parentExecutionId: parent.task.executionId,
    parentSessionId: parent.session.sessionId, parentResultHash: parent.resultHash, parentManifestIdentity: portable(relative(root, parentManifestPath)),
    trainingManifestIdentity: portable(relative(root, trainingManifestPath)), taskLocalOnly: true, projectExperiencePromoted: false,
    correctionOrdinal: 1, initialAttemptCountDelta: 0, replayExecuted: false, officialSubmissionReady: false,
    sanitizedInput: parent.evidence.sealed, environmentAudit: { phase0Passed: true, controlledFixtureOnly: true }, finalEnvironmentAudit: { phase0Passed: true, controlledFixtureOnly: true },
    failureCode: null, strategy, parentEvidence, trainingManifest: manifestRef, trainingBaseline: baseline,
    requestAttempts: events.filter(event => event.type === 'model_request_attempt').length,
    successfulCompletions: events.filter(event => event.type === 'model_request_succeeded').length,
    realModelCalls: events.filter(event => event.type === 'model_request_succeeded').length,
    trainingInput: ref(inputPath), trainingInputHash: digest(input), hostSpec: ref(specPath), hostProcess: ref(join(outputDir, 'host-process/process-result.json')),
    hostProcessHealthy: true, hostResult: ref(resultPath), evidence, generatedAt: new Date().toISOString(),
    controlledFixtureOnly: true, liveModelRequests: 0, benchmarkExecutions: 0 }
  const reportPath = join(outputDir, 'training-probe.json'); writeJson(reportPath, report, { immutable: true })
  return { root, fixtureRoot, manifest: parent.manifest, parent, trainingManifest, trainingManifestPath, outputDir, capabilities,
    trainingReportRef: ref(reportPath), report, spec, processResult, hostResult, httpRequests, readEvidence, put, candidate, scenario, controlledSourceRef, status: 'strategy_ready' }
}

/** An immutable byte mapping supports relocation and nonmutating tamper tests. */
export function trainingProofBundle(fixture) {
  const mapping = new Map([fixture.trainingReportRef, ...fixture.report.evidence].map(ref => [ref.path, Buffer.from(fixture.readEvidence(ref.path))]))
  return { mapping, readEvidence: path => { assert(mapping.has(path), `missing bundled evidence: ${path}`); return Buffer.from(mapping.get(path)) } }
}
