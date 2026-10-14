import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import test from 'node:test'
import { digest, fileDigest, readJson, writeJson } from '../../src/phase0_run.mjs'
import { runChildProcess } from '../../src/phase1_process.mjs'
import { startRuntimeHookService, prepareCorrectionReadonlyInitialization } from '../../src/phase3_hook_service.mjs'
import { collectRuntimeEvidence, pythonEventHash, validateRuntimeEvidence } from '../../src/phase3_runtime_evidence.mjs'
import { createCorrectionReplayPlan, verifyCorrectionReplay } from '../../src/phase4_replay.mjs'
import { fixtureFromScenario } from '../../src/phase1_official.mjs'
import { verifyCorrectionReplayAuthority } from '../../src/phase4_replay_authority.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const portable = value => value.replaceAll('\\', '/')

/** Real IPC/Host/ARE, fake Actor. Private proof fixture has no real model calls. */
export async function controlledReplayFixture(t, { caseName = 'unknown', training = null, fullInitialPlan = false, passed = null } = {}) {
  const { trainingProofFixture } = await import('./training_proof_fixture.mjs')
  const f = training ?? await trainingProofFixture(t, { fullInitialPlan })
  assert.ok(f.status === 'strategy_ready' && typeof f.trainingReportRef?.path === 'string'
    && /^[a-f0-9]{64}$/.test(f.trainingReportRef?.sha256 ?? ''),
  `CONTROLLED_REPLAY_TRAINING_NOT_READY ${JSON.stringify({
    trainingFailed: f.status === 'training_failed',
    hostFailureCode: ['training_host_or_provider_failure', 'training_provider_cleanup_unresolved'].includes(f.hostResult?.failureCode)
      ? f.hostResult.failureCode : null,
    hostCleanupCompleted: f.hostResult?.cleanupCompleted === true,
    timedOut: f.processResult?.timedOut === true,
    childClosed: f.processResult?.childClosed === true,
  })}`)
  const { root, trainingManifest: initialManifest, parent, trainingReportRef } = f
  const directory = join(f.fixtureRoot, `replay-${caseName}-${randomUUID()}`)
  const plan = createCorrectionReplayPlan({ root, manifest: initialManifest, parent, trainingReportRef, outputDir: directory })
  const { manifest, task, session } = plan
  mkdirSync(directory)
  for (const key of ['workspaceDir', 'outputDir', 'fixtureDir']) mkdirSync(resolve(root, session[key]))
  const protocol = readJson(join(root, 'config/phase0-protocol.json'))
  const settings = { processTimeoutMs: 120000, heartbeatIntervalMs: 1000 }
  const service = await startRuntimeHookService({ root, manifest, task, session, settings })
  let actorProcess, hostProcess
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|ACCESS_TOKEN|AUTHORIZATION|HF_TOKEN|HUGGINGFACE_TOKEN|GAIA2_HOOK_|GAIA2_CORRECTION_)/i.test(key)))
    actorProcess = await runChildProcess({ command: resolve(root, protocol.runtime.python),
      args: [join(root, 'scripts/phase4_replay_controlled.py'), '--case', caseName, '--report', resolve(root, session.outputDir, 'fixture-report.json'), ...(typeof passed === 'boolean' ? ['--grade', passed ? 'passed' : 'failed'] : [])],
      cwd: resolve(root, session.workspaceDir), outputDir: resolve(root, session.outputDir, 'actor-process'),
      env: { ...env, PYTHONPATH: resolve(root, protocol.runtime.officialPythonPath), PYTHONUTF8: '1',
        HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', LITELLM_LOCAL_MODEL_COST_MAP: 'True', LITELLM_TELEMETRY: 'False',
        GAIA2_EXECUTION_ID: task.executionId, GAIA2_SESSION_ID: session.sessionId, GAIA2_RUNTIME_EVENT_FILE: resolve(root, session.outputDir, 'runtime-events.jsonl'),
        GAIA2_E2E_MAX_ACTIONS: '30', GAIA2_E2E_ATTEMPT_INDEX: String(task.attemptIndex), GAIA2_E2E_CORRECTION_ORDINAL: '1',
        GAIA2_CORRECTION_STRATEGY_TEXT: service.correctionAuthority.initializer.value,
        GAIA2_CORRECTION_STRATEGY_HASH: task.correctionContext.strategyHash, GAIA2_CORRECTION_CONTEXT_HASH: digest(task.correctionContext),
        GAIA2_CONTROLLED_SCENARIO_ID: task.scenarioId,
        GAIA2_HOOK_URL: service.endpoint, GAIA2_HOOK_TOKEN: service.token },
      processTimeoutMs: settings.processTimeoutMs, heartbeatIntervalMs: settings.heartbeatIntervalMs, secrets: [service.token] })
  } finally { hostProcess = await service.close() }
  assert.equal(actorProcess.exitCode, 0, 'actual controlled ARE process failed')
  assert.equal(hostProcess.exitCode, 0)
  const events = readFileSync(resolve(root, session.outputDir, 'runtime-events.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
  const runtime = collectRuntimeEvidence({ root, manifest, task, session, events, hostProcess })
  const readEvidence = path => readFileSync(resolve(root, path))
  const verified = validateRuntimeEvidence({ manifest, task, session, events, ...runtime, readEvidence })
  const actors = readJson(resolve(root, session.outputDir, 'actor-inputs.json'))
  const receipts = readdirSync(resolve(root, session.workspaceDir, 'plugin-runtime')).sort().map(name => readJson(resolve(root, session.workspaceDir, 'plugin-runtime', name)))
  const proof = readJson(resolve(root, session.outputDir, 'strategy-consumption.json'))
  const authority = verifyCorrectionReplayAuthority({ root, manifest, task })
  assert.equal(verified.trainingHooksExecuted, false)
  assert.equal(verified.actorInputHashReconstructed, false, 'production collector must not overclaim full Actor prompt reconstruction')
  assert.equal(verified.readonlyInitializationVerified, true)
  assert.equal(verified.typedVariableCount, 14); assert.equal(verified.persistentHarnessCount, 2)
  assert.equal(verified.strategyConsumedModelRequests, actors.length)
  assert.equal(proof.actorInputHashReconstructed, true)
  assert.equal(proof.realModelCalls, 0); assert.equal(proof.externalNetworkAttempts, 0)
  assert.notEqual(task.executionId, parent.task.executionId); assert.notEqual(session.sessionId, parent.session.sessionId)
  assert.notEqual(session.workspaceDir, parent.session.workspaceDir)
  assert.equal(task.runNumber, parent.task.runNumber); assert.equal(task.attemptIndex, parent.task.attemptIndex)
  assert.equal(task.scenarioHash, parent.task.scenarioHash)
  assert.equal(receipts[0].readonlySessionInitializations[0].value, authority.initializer.value)
  for (const receipt of receipts.slice(1)) assert.equal(receipt.variables.gaia2_experiment_context, authority.initializer.value)
  const injections = events.filter(event => event.type === 'dynamic_context_injected')
  for (const [index, actor] of actors.entries()) {
    assert.equal(pythonEventHash(actor.messages), injections[index].actorInputHash)
    assert.ok(actor.messages[1].content.includes(authority.initializer.value))
    assert.equal(injections[index].consumedStrategyHash, authority.context.strategyHash)
    assert.equal(injections[index].correctionContextHash, digest(authority.context))
    assert.equal(sha(actor.context), injections[index].contextHash)
  }
  const first = receipts.find(item => item.input?.checkpoint === 'before_model')
  // ARE's real clock includes wall time between notifications and the first
  // Hook; never round, replace or pretend it is a frozen synthetic timestamp.
  assert.ok(first.input.clock.now >= proof.freshClockOrigin && first.input.clock.now < proof.freshClockOrigin + 10)
  assert.deepEqual(first.variables.gaia2_write_state.unknown, [])
  if (caseName === 'unknown') {
    assert.equal(proof.actualCallbackCounts.write, 1); assert.equal(proof.actualCallbackCounts.read, 1)
    for (const id of [...(passed === null ? ['unknown-retry'] : []), 'unknown-after-read']) {
      assert.equal(receipts.find(item => item.input?.action?.id === id && item.input.checkpoint === 'before_tool').decision.action, 'read_back')
      assert.equal(receipts.some(item => item.input?.action?.id === id && item.input.checkpoint === 'after_tool'), false)
    }
  } else {
    assert.equal(proof.actualCallbackCounts.write, 1)
    assert.ok(events.some(event => event.type === 'tool_call_blocked' && event.reason === 'stale_dynamic_context'))
    assert.notEqual(actors[0].contextHash, actors[1].contextHash)
  }
  const bindingPaths = ['src/phase4_replay_authority.mjs', 'src/phase4_replay.mjs', 'src/phase3_hook_service.mjs', 'src/phase3_runtime_evidence.mjs', 'scripts/capybara_official_bridge.py', 'scripts/phase4_replay_controlled.py']
  const report = { schemaVersion: 'gaia2-phase4-controlled-replay-v1', syntheticFixtureOnly: true, status: 'passed',
    benchmarkExecuted: false, realModelCalls: 0, actualRuntimeHost: true, actualARE: true, case: caseName,
    correctionContext: task.correctionContext, productionRuntime: verified, independentlyReconstructedActorInputs: actors.length,
    sourceBindings: bindingPaths.map(path => ({ path, sha256: fileDigest(join(root, path)) })), runtime }
  writeFileSync(resolve(root, session.outputDir, 'controlled-replay-report.json'), JSON.stringify(report) + '\n', { flag: 'wx' })
  return { ...f, plan, service, actorProcess, hostProcess, events, runtime, actors, receipts, proof, authority, readEvidence, report }
}

/** Build a clearly controlled native envelope around actual state-only ARE validation.
 * This verifies grade/provenance logic, not the GAIA2 benchmark or real model ability. */
export async function controlledReplayEvidenceFixture(t, { passed = true, fullInitialPlan = true, ...options } = {}) {
  const f = await controlledReplayFixture(t, { ...options, passed, fullInitialPlan })
  const { root, plan: { manifest, task, session, directory } } = f
  const put = (path, value) => { writeJsonOrText(resolve(root, path), value); return { path, sha256: fileDigest(resolve(root, path)) } }
  const settings = { processTimeoutMs: 0, controlledFixtureOnly: true }
  const manifestRef = put(`${manifest.runRoot}/replay-manifest.json`, manifest), settingsRef = put(`${manifest.runRoot}/runtime-settings.json`, settings)
  const original = put(`${session.workspaceDir}/fixture-source.json`, f.scenario)
  const executed = put(`${session.fixtureDir}/${task.config}/scenario.json`, fixtureFromScenario(f.scenario, task))
  const freshReplayFixture = { schemaVersion: 'gaia2-phase4-fresh-fixture-v1', originalScenarioHash: task.scenarioHash, original, executed }
  const trace = { world_logs: [], apps: [], events: [], completed_events: [], version: 'controlled-replay-native-envelope', context: {}, augmentation: null,
    metadata: { controlledFixtureOnly: true, definition: { scenario_id: task.scenarioId, run_number: task.runNumber, has_exception: false } } }
  const traceRef = put(`${session.outputDir}/hf/trace.json`, trace)
  const nativeRef = put(`${session.outputDir}/output.jsonl`, JSON.stringify({ task_id: task.scenarioId, trace_id: 'hf/trace.json', score: Number(passed),
    metadata: { controlledFixtureOnly: true, scenario_id: task.scenarioId, run_number: task.runNumber, status: passed ? 'success' : 'failed', has_exception: false } }) + '\n')
  const processRef = put(`${session.outputDir}/process-result.json`, f.actorProcess)
  const result = { schemaVersion: 'gaia2-task-result-v1', runId: manifest.runId, manifestHash: manifest.manifestHash, runtimeHash: digest(settings),
    executionId: task.executionId, sessionId: session.sessionId, scenarioId: task.scenarioId, phase: task.phase, config: task.config,
    runNumber: task.runNumber, attemptIndex: task.attemptIndex, correctionOrdinal: 1, correctionContext: task.correctionContext,
    initialAttemptCountDelta: 0, officialSubmissionReady: false, controlledFixtureOnly: true,
    evaluationComplete: true, businessPassed: passed, score: Number(passed), failure: passed ? null : { category: 'business_failure', retryable: false },
    process: { exitCode: 0, signal: null, timedOut: false, interrupted: false }, artifacts: [nativeRef, traceRef],
    runtimeEvidenceRequired: true, realHooksReady: true, ...f.runtime, freshReplayFixture, finishedAt: new Date().toISOString() }
  const resultRef = put(`${session.workspaceDir}/task-result.json`, result)
  const endedSession = { ...session, endedAt: result.finishedAt }
  const stateRef = put(`${manifest.runRoot}/replay-state.json`, { schemaVersion: 'gaia2-correction-replay-state-v1', runId: manifest.runId,
    manifestHash: manifest.manifestHash, runtimeHash: result.runtimeHash, correctionContext: task.correctionContext, initialAttemptCountDelta: 0,
    status: 'replay_evaluated', task: { executionId: task.executionId, session: endedSession, resultPath: resultRef.path, resultSha256: resultRef.sha256 } })
  const eventsRef = { path: `${session.outputDir}/runtime-events.jsonl`, sha256: fileDigest(resolve(root, session.outputDir, 'runtime-events.jsonl')) }
  const replayReportRef = put(`${manifest.runRoot}/replay-report.json`, { schemaVersion: 'gaia2-phase4-replay-report-v1', status: 'replay_evaluated',
    initialAttemptCountDelta: 0, officialSubmissionReady: false, controlledFixtureOnly: true, correctionContext: task.correctionContext,
    manifest: manifestRef, state: stateRef, settings: settingsRef, result: resultRef, events: eventsRef, process: processRef,
    baselineAudit: { phase0Passed: true, controlledFixtureOnly: true }, finalBaselineAudit: { phase0Passed: true, controlledFixtureOnly: true } })
  const replayVerified = verifyCorrectionReplay({ root, replayReportRef })
  const entry = { executionId: f.parent.task.executionId, status: 'evaluated', session: f.parent.session, result: f.parent.result, events: f.parent.events, readEvidence: f.parent.readEvidence }
  return { ...f, initialManifest: f.parent.manifest, entry, replayReportRef, replayResult: result, replayVerified, endedSession }
}

function writeJsonOrText(path, value) {
  if (typeof value === 'string') { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, value, { flag: 'wx' }) }
  else writeJson(path, value, { immutable: true })
}
