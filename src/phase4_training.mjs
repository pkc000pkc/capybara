import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, isAbsolute, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { digest, fileDigest, readJson, writeJson, within } from './phase0_run.mjs'
import { auditPhase0 } from './phase0_audit.mjs'
import { modelRuntimeEnvironment, readModelConnection, resolveModelRetrySettings } from './phase1_official.mjs'
import { resolveRuntimeSettings } from './phase1_config.mjs'
import { runChildProcess } from './phase1_process.mjs'
import { healthyTrainingProcess } from './phase4_training_broker.mjs'
import { CORRECTION_CONTRACT, deriveCorrectionEvidence, parseCorrectionPlan, renderTrustedCorrection } from './phase4_correction_contract.mjs'
import { readSealedTrainingParent, sealTrainingParent, sealTrainingBaseline, verifyTrainingProbeEvidence } from './phase4_training_proof.mjs'

const portable = value => value.replaceAll('\\', '/')
const sha = value => createHash('sha256').update(value).digest('hex')
function check(condition, code) { if (!condition) throw new Error(`Phase 4 training: ${code}`) }
export function trainingEvidenceReader(root) {
  root = resolve(root)
  return value => {
    check(typeof value === 'string' && !isAbsolute(value) && !win32.isAbsolute(value)
      && !/[\\\0:]/.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..'), 'unsafe evidence path')
    const path = resolve(root, value); check(within(root, path), 'evidence escapes project')
    for (let at = path; ; at = dirname(at)) { check(!lstatSync(at).isSymbolicLink(), 'symbolic evidence'); if (at === dirname(at)) break }
    check(lstatSync(path).isFile(), 'nonfile evidence')
    return readFileSync(path)
  }
}

export function loadTrainingParent({ root, manifestPath, executionId }) {
  root = resolve(root); manifestPath = resolve(root, manifestPath)
  check(within(root, manifestPath), 'parent manifest outside project')
  const evidenceBytes = new Map(), rawReader = trainingEvidenceReader(root)
  const readEvidence = value => { if (!evidenceBytes.has(value)) evidenceBytes.set(value, rawReader(value)); return Buffer.from(evidenceBytes.get(value)) }
  const manifest = JSON.parse(readEvidence(portable(relative(root, manifestPath)))), { manifestHash, ...content } = manifest
  check(manifest.schemaVersion === 'gaia2-run-manifest-v1' && manifestHash === digest(content)
    && manifest.mode === 'internal_pass5' && manifest.dataset.kind === 'source' && manifest.syntheticFixtureOnly !== true, 'invalid parent manifest')
  const task = manifest.tasks.find(item => item.executionId === executionId)
  check(task && task.correctionOrdinal === 0, 'parent must be an initial attempt')
  const state = JSON.parse(readEvidence(portable(manifest.stateFile)))
  const record = state.tasks.find(item => item.executionId === executionId)
  check(record?.resultPath && record.sessions?.length, 'parent has no result')
  const session = record.sessions.at(-1), resultBytes = readEvidence(record.resultPath), result = JSON.parse(resultBytes)
  check(sha(resultBytes) === record.resultSha256, 'parent result SHA changed')
  const eventsPath = portable(join(session.outputDir, 'runtime-events.jsonl'))
  const events = JSON.parse(JSON.stringify(readEvidence(eventsPath).toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)))
  const evidence = deriveCorrectionEvidence({ manifest, task, session, result, events, readEvidence })
  return { manifest, manifestPath, task, session, result, resultPath: record.resultPath, resultHash: record.resultSha256, events, readEvidence, evidence, evidenceBytes }
}

export function verifyTrainingProbe({ root, trainingReportRef, readEvidence = null }) {
  return verifyTrainingProbeEvidence({ trainingReportRef, readEvidence: readEvidence ?? trainingEvidenceReader(root) })
}

/** A real training Hook probe; it neither executes replay nor promotes experience. */
export async function runTrainingProbe({ root, parent, trainingManifest, trainingManifestPath, outputDir, signal }) {
  root = resolve(root); outputDir = resolve(root, outputDir); trainingManifestPath = resolve(root, trainingManifestPath)
  check(within(root, outputDir) && outputDir !== root && !existsSync(outputDir), 'new isolated training directory required')
  for (let at = outputDir; ; at = dirname(at)) {
    if (existsSync(at)) check(!lstatSync(at).isSymbolicLink(), 'symbolic training workspace')
    if (at === dirname(at)) break
  }
  check(digest(JSON.parse(trainingEvidenceReader(root)(portable(relative(root, trainingManifestPath))))) === digest(trainingManifest), 'training manifest argument differs from file')
  const audit = await auditPhase0(root, { manifest: trainingManifest, deep: false, env: {} })
  check(audit.phase0Passed === true, 'training code/data/dependencies differ from frozen baseline')
  mkdirSync(outputDir, { recursive: true })
  const ref = path => ({ path: portable(relative(root, path)), sha256: fileDigest(path) })
  const base = { schemaVersion: 'gaia2-phase4-training-probe-v1', parentExecutionId: parent.task.executionId,
    parentSessionId: parent.session.sessionId, parentResultHash: parent.resultHash, parentManifestIdentity: portable(relative(root, parent.manifestPath)),
    trainingManifestIdentity: portable(relative(root, trainingManifestPath)), taskLocalOnly: true, projectExperiencePromoted: false,
    correctionOrdinal: 1, initialAttemptCountDelta: 0, replayExecuted: false, officialSubmissionReady: false,
    sanitizedInput: parent.evidence.sealed ?? null, environmentAudit: audit }
  const reportPath = join(outputDir, 'training-probe.json')
  if (!parent.evidence.eligible || !parent.evidence.trainingAllowed) {
    const report = { ...base, status: 'skipped', reason: parent.evidence.reason, requestAttempts: 0, successfulCompletions: 0, realModelCalls: 0, strategy: null }
    writeJson(reportPath, report, { immutable: true }); return report
  }
  const protocol = readJson(join(root, 'config/phase0-protocol.json'))
  const parentEvidence = sealTrainingParent({ root, outputDir, parent })
  const sealedParent = readSealedTrainingParent({ parentEvidence, readEvidence: trainingEvidenceReader(root) })
  const { manifestRef, baseline } = sealTrainingBaseline({ root, outputDir, manifest: trainingManifest, manifestPath: trainingManifestPath, protocol, readEvidence: trainingEvidenceReader(root) })
  const capabilityPath = resolve(root, trainingManifest.lockRefs.capabilities.path)
  check(fileDigest(capabilityPath) === trainingManifest.lockRefs.capabilities.sha256, 'training capabilities SHA changed')
  const capabilities = readJson(capabilityPath)
  const settings = { ...resolveRuntimeSettings({ protocol: { requestedRuntime: trainingManifest.requestedRuntime }, entrypoint: 'pilot', env: {} }), modelRetry: resolveModelRetrySettings({}) }
  const connection = readModelConnection(root, trainingManifest.models)
  const sessionId = `training-${randomUUID()}`, executionId = `correction-${randomUUID()}`
  const summary = sealedParent.evidence.sealed.observableSummary
  const input = { phase: 'training', evaluation: { evaluated: true, category: 'business_failure', passed: false }, summary,
    source: { executionId: parent.task.executionId, sessionId: parent.session.sessionId, attemptIndex: parent.task.attemptIndex },
    evidence: { runtimeAttestationHash: digest(parent.result.runtimeAttestation), resultHash: parent.resultHash, manifestHash: parent.manifest.manifestHash } }
  const inputPath = join(outputDir, 'sanitized-training-input.json'); writeJson(inputPath, input, { immutable: true })
  const specPath = join(outputDir, 'host-spec.json'), resultPath = join(outputDir, 'host-result.json')
  const options = { projectDir: root, workspaceDir: outputDir, plugins: capabilities.plugins.map(({ id, snapshotRoot, files }) => ({ id, snapshotRoot, files })),
    executionId, sessionId, scenarioId: parent.task.scenarioId, contract: CORRECTION_CONTRACT, providerCleanupTimeoutMs: 30000, hookTimeoutMs: 900000 }
  writeJson(specPath, { backendRoot: protocol.runtime.backendRoot, projectDir: root, workspaceDir: outputDir,
    models: trainingManifest.models, settings, resultPath, options, invocation: { checkpoint: 'after_evaluation', training: input } }, { immutable: true })
  const filtered = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|ACCESS_TOKEN|AUTHORIZATION|HF_TOKEN|HUGGINGFACE_TOKEN|GAIA2_HOOK_TOKEN)/i.test(key)))
  const processResult = await runChildProcess({ command: process.execPath,
    args: [`--import=${pathToFileURL(join(protocol.runtime.backendRoot, 'node_modules/tsx/dist/loader.mjs')).href}`, '--conditions=development', join(root, 'scripts/phase4_training_host.ts'), '--spec', specPath],
    cwd: outputDir, env: { ...filtered, ...modelRuntimeEnvironment(settings), TMP: outputDir, TEMP: outputDir, TMPDIR: outputDir },
    outputDir: join(outputDir, 'host-process'), processTimeoutMs: settings.processTimeoutMs,
    heartbeatIntervalMs: settings.heartbeatIntervalMs, signal, secrets: [connection.apiKey] })
  let status = 'training_failed', strategy = null, hostResult = null, failureCode = null
  try { if (existsSync(resultPath)) hostResult = readJson(resultPath) } catch { failureCode = 'training_host_result_unreadable' }
  if (healthyTrainingProcess(processResult) && hostResult?.status === 'passed') {
    try {
      check(hostResult.schemaVersion === 'gaia2-phase4-training-host-result-v1' && hostResult.result.status === 'passed', 'host result did not pass')
      const proposals = hostResult.result.proposals.filter(item => item.hookId === 'gaia2-correction')
      check(proposals.length === 1, 'missing correction proposal')
      const candidate = proposals[0].output.correction
      check(candidate.freshReplayRequired === true && candidate.attemptCountDelta === 0, 'replay contract weakened')
      const { freshReplayRequired, attemptCountDelta, ...planInput } = candidate
      const plan = parseCorrectionPlan({ candidate: planInput, evidence: sealedParent.evidence })
      strategy = { plan, ...renderTrustedCorrection(plan) }; status = 'strategy_ready'
    } catch { failureCode = 'training_hook_or_candidate_rejected' }
  } else failureCode ??= 'training_process_or_provider_failure'
  const finalEnvironmentAudit = await auditPhase0(root, { manifest: trainingManifest, deep: false, env: {} })
  if (!finalEnvironmentAudit.phase0Passed) { status = 'training_failed'; strategy = null; failureCode = 'training_baseline_drifted' }
  const files = [], providerEvents = []
  let modelEventsReadable = hostResult?.operationalReceipts?.every(item => item.eventsReadable !== false) ?? false
  const walk = directory => { for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name); check(!entry.isSymbolicLink(), 'symbolic training evidence')
    if (entry.isDirectory()) walk(path)
    else if (entry.isFile() && path !== reportPath) {
      files.push(ref(path))
      if (entry.name === 'model-events.jsonl') {
        try { providerEvents.push(...readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)) }
        catch { modelEventsReadable = false }
      }
    }
  } }
  walk(outputDir)
  if (!modelEventsReadable) { status = 'training_failed'; strategy = null; failureCode = 'training_model_evidence_unreadable' }
  const requestAttempts = modelEventsReadable ? providerEvents.filter(event => event.type === 'model_request_attempt').length : null
  const successfulCompletions = modelEventsReadable ? providerEvents.filter(event => event.type === 'model_request_succeeded').length : null
  let report = { ...base, status, failureCode, strategy, parentEvidence, trainingManifest: manifestRef, trainingBaseline: baseline,
    modelEventsReadable, requestAttempts, successfulCompletions, realModelCalls: successfulCompletions,
    trainingInput: ref(inputPath), trainingInputHash: digest(input), hostSpec: ref(specPath), hostProcess: ref(join(outputDir, 'host-process/process-result.json')),
    hostProcessHealthy: healthyTrainingProcess(processResult), hostResult: hostResult ? ref(resultPath) : null,
    manualInspectionRequired: processResult.manualInspectionRequired === true || hostResult?.manualInspectionRequired === true,
    finalEnvironmentAudit, evidence: files, generatedAt: new Date().toISOString() }
  if (status === 'strategy_ready') {
    const bytes = Buffer.from(JSON.stringify(report)), virtualRef = { path: portable(relative(root, reportPath)), sha256: sha(bytes) }, reader = trainingEvidenceReader(root)
    try { verifyTrainingProbe({ root, trainingReportRef: virtualRef, readEvidence: path => path === virtualRef.path ? bytes : reader(path) }) }
    catch { report = { ...report, status: 'training_failed', failureCode: 'training_evidence_verification_failed', strategy: null } }
  }
  writeJson(reportPath, report, { immutable: true }); return report
}
