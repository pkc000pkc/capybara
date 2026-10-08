import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path'
import { digest, fileDigest, writeJson, within } from './phase0_run.mjs'
import { auditPhase0 } from './phase0_audit.mjs'
import { classifyExecutionFailure } from './phase1_errors.mjs'
import { safeEvidenceGateCode } from './phase1_diagnostics.mjs'
import { executeOfficialTask, fixtureFromScenario } from './phase1_official.mjs'
import { validateRuntimeEvidence } from './phase3_runtime_evidence.mjs'
import { trainingEvidenceReader, verifyTrainingProbe } from './phase4_training.mjs'
import { verifyCorrectionReplayAuthority } from './phase4_replay_authority.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const portable = value => value.replaceAll('\\', '/')
const healthy = p => p?.schemaVersion === 'gaia2-process-result-v1' && p.exitCode === 0 && p.childExited === true && p.childClosed === true && !p.signal && !p.timedOut && !p.interrupted && !p.spawnError && !p.loggingError && !p.heartbeatError && !p.manualInspectionRequired && Array.isArray(p.terminationErrors) && p.terminationErrors.length === 0 && Number.isFinite(Date.parse(p.finishedAt))
function check(value, code) { if (!value) throw new Error(`Phase 4 replay: ${code}`) }
const ref = (root, path) => ({ path: portable(relative(root, path)), sha256: fileDigest(path) })
function safePath(path) { check(typeof path === 'string' && path && !isAbsolute(path) && !win32.isAbsolute(path) && !/[\\\0:]/.test(path) && !path.split('/').some(part => !part || part === '.' || part === '..'), 'unsafe_replay_evidence_path'); return path }
function strictRef(value) { check(value && typeof value === 'object' && !Array.isArray(value) && digest(Object.keys(value).sort()) === digest(['path', 'sha256']) && /^[a-f0-9]{64}$/.test(value.sha256 ?? ''), 'invalid_replay_evidence_ref'); safePath(value.path); return value }

export function assertFreshReplayProcessGeneration({ process, parentProcess }) {
  check(healthy(process) && process.processIdentity?.verified === true && parentProcess.processIdentity?.verified === true
    && digest(process.processIdentity) !== digest(parentProcess.processIdentity), 'ARE_process_generation_not_fresh')
}

function verifyFreshNativeArtifacts({ task, session, fixture, artifacts, expectedPassed, readEvidence }) {
  const json = value => { strictRef(value); const bytes = readEvidence(value.path); check(Buffer.isBuffer(bytes) && sha(bytes) === value.sha256, 'fresh_native_SHA_changed'); return JSON.parse(bytes) }
  check(fixture?.schemaVersion === 'gaia2-phase4-fresh-fixture-v1' && fixture.originalScenarioHash === task.scenarioHash
    && fixture.original.path === `${session.workspaceDir}/fixture-source.json` && fixture.executed.path === `${session.fixtureDir}/${task.config}/scenario.json`, 'fresh_fixture_proof_missing')
  check(digest(json(fixture.executed)) === digest(fixtureFromScenario(json(fixture.original), task)), 'fresh_fixture_not_original')
  check(Array.isArray(artifacts) && artifacts.length === 2 && new Set(artifacts.map(item => item.path)).size === 2, 'replay_native_artifacts_missing')
  artifacts.forEach(strictRef)
  const nativeRef = artifacts.find(item => item.path.endsWith('/output.jsonl')), traceRef = artifacts.find(item => item !== nativeRef)
  check(nativeRef && traceRef && artifacts.every(item => item.path.startsWith(`${session.outputDir}/`)), 'replay_native_paths')
  const nativeBytes = readEvidence(nativeRef.path); check(Buffer.isBuffer(nativeBytes) && sha(nativeBytes) === nativeRef.sha256, 'replay_native_SHA_changed')
  const rows = nativeBytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse), trace = json(traceRef), row = rows[0], definition = trace.metadata?.definition
  const nativeTrace = portable(row?.trace_id ?? '')
  check(typeof row?.trace_id === 'string' && !nativeTrace.split('/').includes('..')
    && (nativeTrace === traceRef.path || nativeTrace.endsWith(`/${traceRef.path}`) || nativeTrace === portable(relative(dirname(nativeRef.path), traceRef.path))), 'replay_native_trace_binding')
  check(rows.length === 1 && row.task_id === task.scenarioId && row.metadata.scenario_id === task.scenarioId && definition?.scenario_id === task.scenarioId
    && definition.run_number === task.runNumber && (row.metadata.run_number === undefined || row.metadata.run_number === task.runNumber)
    && row.score === Number(expectedPassed) && row.metadata.status === (expectedPassed ? 'success' : 'failed')
    && row.metadata.has_exception !== true && definition.has_exception !== true && !row.metadata.exception_type && !definition.exception_type, 'replay_native_grade_mismatch')
  check(['world_logs', 'apps', 'events', 'completed_events'].every(key => Array.isArray(trace[key])) && typeof trace.version === 'string' && Object.hasOwn(trace, 'context') && Object.hasOwn(trace, 'augmentation'), 'replay_native_trace_incomplete')
}

/** Pure plan construction; the execution entry point separately audits the frozen baseline. */
export function createCorrectionReplayPlan({ root, manifest, parent = null, trainingReportRef, outputDir }) {
  const { manifestHash, ...base } = manifest ?? {}
  check(manifest?.schemaVersion === 'gaia2-run-manifest-v1' && manifest.mode === 'internal_pass5' && manifestHash === digest(base)
    && manifest.executionBinding === 'phase3_live_plugin_host_required' && manifest.dataset.kind === 'source' && manifest.syntheticFixtureOnly !== true, 'invalid_initial_baseline')
  const verified = verifyTrainingProbe({ root, trainingReportRef }), source = verified.verifiedParent
  if (parent) check(parent.task?.executionId === source.task.executionId && parent.resultHash === source.resultHash, 'caller_parent_differs_from_verified_receipt')
  const archivedManifest = JSON.parse(trainingEvidenceReader(root)(verified.report.trainingManifest.path))
  check(manifest.manifestHash === archivedManifest.manifestHash, 'training_and_replay_baseline_changed')
  const directory = resolve(root, outputDir)
  check(within(resolve(root, 'runs'), directory) && directory !== resolve(root, 'runs') && !existsSync(directory), 'new_replay_directory_required')
  for (let at = dirname(directory); ; at = dirname(at)) { if (existsSync(at)) check(!lstatSync(at).isSymbolicLink(), 'symbolic_replay_path'); if (at === dirname(at)) break }
  const runId = `correction-${randomUUID()}`, runRoot = portable(relative(root, directory)), executionId = `replay-${randomUUID()}`
  const task = { ...structuredClone(source.task), executionId, correctionOrdinal: 1,
    workspaceDir: `${runRoot}/workspace`, outputDir: `${runRoot}/output`, fixtureDir: `${runRoot}/fixture` }
  delete task.correctionContext
  const replayBase = { schemaVersion: 'gaia2-correction-replay-manifest-v1', runId, runRoot,
    mode: 'correction_replay', executionBinding: 'phase3_live_plugin_host_required', initialAttemptCountDelta: 0,
    officialSubmissionReady: false, trainingManifestHash: manifest.manifestHash,
    initialManifestHash: source.manifest.manifestHash, dataset: structuredClone(manifest.dataset),
    models: structuredClone(manifest.models), lockRefs: structuredClone(manifest.lockRefs),
    requestedRuntime: structuredClone(manifest.requestedRuntime ?? {}), tasks: [task] }
  task.correctionContext = verifyCorrectionReplayAuthority({ root, manifest: replayBase, task, trainingReportRef }).context
  const replayManifest = { ...replayBase, manifestHash: digest(replayBase) }
  const session = { sessionId: `fresh-${randomUUID()}`, sessionOrdinal: 1, parentSessionId: null,
    recoveryKind: 'fresh_correction_environment_not_ARE_checkpoint', ...Object.fromEntries(['workspaceDir', 'outputDir', 'fixtureDir'].map(key => [key, task[key]])),
    startedAt: new Date().toISOString(), endedAt: null }
  check(session.sessionId !== source.session.sessionId && [session.workspaceDir, session.outputDir, session.fixtureDir].every(path => ![source.session.workspaceDir, source.session.outputDir, source.session.fixtureDir].includes(path)), 'reused_parent_session')
  return { manifest: replayManifest, task, session, directory }
}

/** One execution only. There is no automatic mutation, scenario or correction retry. */
export async function runCorrectionReplay({ root, manifest, parent = null, trainingReportRef, outputDir, settings, signal }) {
  root = resolve(root)
  const audit = await auditPhase0(root, { manifest, deep: false, env: {} })
  check(audit.phase0Passed === true && settings.minimal === false && settings.concurrency === 1, 'frozen_replay_baseline_audit_failed')
  const plan = createCorrectionReplayPlan({ root, manifest, parent, trainingReportRef, outputDir })
  const { manifest: replayManifest, task, session, directory } = plan
  mkdirSync(directory)
  for (const path of [session.workspaceDir, session.outputDir, session.fixtureDir]) mkdirSync(resolve(root, path))
  const manifestPath = join(directory, 'replay-manifest.json'), settingsPath = join(directory, 'runtime-settings.json'), statePath = join(directory, 'replay-state.json')
  writeJson(manifestPath, replayManifest, { immutable: true }); writeJson(settingsPath, settings, { immutable: true })
  const state = { schemaVersion: 'gaia2-correction-replay-state-v1', runId: replayManifest.runId, manifestHash: replayManifest.manifestHash,
    runtimeHash: digest(settings), correctionContext: task.correctionContext, initialAttemptCountDelta: 0,
    status: 'running', task: { executionId: task.executionId, session, resultPath: null, resultSha256: null } }
  writeJson(statePath, state)
  let execution
  try { execution = await executeOfficialTask({ root, manifest: replayManifest, task, session, settings, signal }) }
  catch { execution = { processResult: { exitCode: null, spawnError: { code: 'REPLAY_ADAPTER_FAILURE' } }, events: [], report: null } }
  let runtimeReady = false
  try { runtimeReady = validateRuntimeEvidence({ manifest: replayManifest, task, session, events: execution.events,
    runtimeAttestation: execution.runtimeAttestation, runtimeEvidence: execution.runtimeEvidence, readEvidence: trainingEvidenceReader(root) }).realHooksReady } catch (error) {
    if (execution.processResult) execution.processResult.evidenceGateCode ??= safeEvidenceGateCode(error)
    /* Technical, never a business zero. */
  }
  const p = execution.processResult, report = execution.report
  let freshGeneration = false
  if (runtimeReady) {
    try {
      const reader = trainingEvidenceReader(root), index = JSON.parse(reader(execution.runtimeAttestation.correctionAuthorityPath))
      const mapping = new Map(index.files.map(ref => [ref.originalPath, ref]))
      const authority = verifyCorrectionReplayAuthority({ manifest: replayManifest, task, readEvidence: path => {
        const ref = mapping.get(path); check(ref, 'unsealed_replay_authority')
        const bytes = reader(ref.path); check(sha(bytes) === ref.sha256, 'sealed_replay_authority_changed'); return bytes
      } })
      const source = authority.verified.verifiedParent
      assertFreshReplayProcessGeneration({ process: p, parentProcess: JSON.parse(source.readEvidence(`${source.session.outputDir}/process-result.json`)) })
      freshGeneration = true
    } catch { p.loggingError = 'fresh_replay_process_generation_unverified' }
  }
  const finalAudit = await auditPhase0(root, { manifest, deep: false, env: {} })
  if (finalAudit.phase0Passed !== true) p.loggingError = 'frozen_replay_baseline_changed'
  let nativeReady = false
  if (typeof report?.businessPassed === 'boolean') {
    try { verifyFreshNativeArtifacts({ task, session, fixture: execution.freshReplayFixture, artifacts: execution.artifacts, expectedPassed: report.businessPassed, readEvidence: trainingEvidenceReader(root) }); nativeReady = true }
    catch { p.loggingError = 'fresh_replay_native_proof_invalid' }
  }
  const evaluated = healthy(p) && runtimeReady && freshGeneration && nativeReady && finalAudit.phase0Passed === true && report?.evaluationComplete === true && report.hasException === false
    && !report.exceptionType && report.scenarioId === task.scenarioId && report.runNumber === task.runNumber && typeof report.businessPassed === 'boolean'
  const failure = evaluated ? report.businessPassed ? null : { category: 'business_failure', retryable: false }
    : classifyExecutionFailure({ processResult: p, report: { ...report, evaluationComplete: false }, events: execution.events })
  const result = { schemaVersion: 'gaia2-task-result-v1', runId: replayManifest.runId, manifestHash: replayManifest.manifestHash,
    runtimeHash: state.runtimeHash, executionId: task.executionId, sessionId: session.sessionId, scenarioId: task.scenarioId,
    runNumber: task.runNumber, attemptIndex: task.attemptIndex, correctionOrdinal: 1, phase: task.phase, config: task.config,
    correctionContext: task.correctionContext, initialAttemptCountDelta: 0, officialSubmissionReady: false,
    evaluationComplete: evaluated, businessPassed: evaluated ? report.businessPassed : null, score: evaluated ? Number(report.businessPassed) : null,
    failure, process: { exitCode: p?.exitCode ?? null, signal: p?.signal ?? null, timedOut: p?.timedOut === true, interrupted: p?.interrupted === true, elapsedMs: p?.elapsedMs ?? null },
    artifacts: execution.artifacts ?? [], runtimeEvidenceRequired: true, runtimeAttestation: execution.runtimeAttestation ?? null,
    runtimeEvidence: execution.runtimeEvidence ?? [], realHooksReady: runtimeReady, freshReplayFixture: execution.freshReplayFixture ?? null, finishedAt: new Date().toISOString() }
  const resultPath = resolve(root, session.workspaceDir, 'task-result.json'); writeJson(resultPath, result, { immutable: true })
  state.status = evaluated ? 'replay_evaluated' : 'replay_technical'; session.endedAt = result.finishedAt
  Object.assign(state.task, { resultPath: portable(relative(root, resultPath)), resultSha256: fileDigest(resultPath) }); writeJson(statePath, state)
  const replayReport = { schemaVersion: 'gaia2-phase4-replay-report-v1', status: state.status, initialAttemptCountDelta: 0,
    officialSubmissionReady: false, correctionContext: task.correctionContext, manifest: ref(root, manifestPath), state: ref(root, statePath),
    settings: ref(root, settingsPath), result: ref(root, resultPath), events: existsSync(resolve(root, session.outputDir, 'runtime-events.jsonl')) ? ref(root, resolve(root, session.outputDir, 'runtime-events.jsonl')) : null,
    process: existsSync(resolve(root, session.outputDir, 'process-result.json')) ? ref(root, resolve(root, session.outputDir, 'process-result.json')) : null,
    baselineAudit: audit, finalBaselineAudit: finalAudit, generatedAt: new Date().toISOString() }
  const reportPath = join(directory, 'replay-report.json'); writeJson(reportPath, replayReport, { immutable: true })
  return { report: replayReport, reportRef: ref(root, reportPath), manifest: replayManifest, task, session, result }
}

/** Independent completed-replay grade. No ledger flag or caller verdict is trusted. */
export function verifyCorrectionReplay({ root, replayReportRef, readEvidence = trainingEvidenceReader(root) }) {
  const consumed = new Map(), bytes = path => { safePath(path); if (!consumed.has(path)) { const value = readEvidence(path); check(Buffer.isBuffer(value), 'non_byte_replay_evidence'); consumed.set(path, Buffer.from(value)) } return consumed.get(path) }
  const json = ref => { strictRef(ref); const value = bytes(ref.path); check(sha(value) === ref.sha256, 'replay_evidence_SHA_changed'); return JSON.parse(value) }
  const report = json(replayReportRef)
  check(report.schemaVersion === 'gaia2-phase4-replay-report-v1' && report.status === 'replay_evaluated' && report.initialAttemptCountDelta === 0 && report.officialSubmissionReady === false, 'replay_not_evaluated')
  check(report.baselineAudit?.phase0Passed === true && report.finalBaselineAudit?.phase0Passed === true, 'replay_baseline_audit_missing')
  check(new Set([report.manifest, report.state, report.settings, report.result, report.events, report.process].map(value => strictRef(value).path)).size === 6, 'duplicate_replay_evidence_ref')
  const manifest = json(report.manifest), { manifestHash, ...content } = manifest
  check(manifestHash === digest(content) && manifest.mode === 'correction_replay' && manifest.tasks?.length === 1, 'replay_manifest_changed')
  const task = manifest.tasks[0], state = json(report.state), settings = json(report.settings), result = json(report.result), session = state.task?.session
  for (const [field, suffix] of [['manifest', 'replay-manifest.json'], ['state', 'replay-state.json'], ['settings', 'runtime-settings.json']]) check(report[field].path === `${manifest.runRoot}/${suffix}`, 'replay_control_path_changed')
  for (const key of ['workspaceDir', 'outputDir', 'fixtureDir']) check(session?.[key] === task[key], 'replay_session_path_changed')
  check(report.result.path === `${session.workspaceDir}/task-result.json`, 'replay_result_path_changed')
  check(state.schemaVersion === 'gaia2-correction-replay-state-v1' && state.status === 'replay_evaluated' && state.runId === manifest.runId && state.manifestHash === manifestHash
    && state.runtimeHash === digest(settings) && state.initialAttemptCountDelta === 0 && state.task.executionId === task.executionId && state.task.resultPath === report.result.path && state.task.resultSha256 === report.result.sha256
    && session.sessionOrdinal === 1 && session.parentSessionId === null && session.recoveryKind === 'fresh_correction_environment_not_ARE_checkpoint', 'fresh_replay_state_binding')
  check(result.schemaVersion === 'gaia2-task-result-v1' && result.runId === manifest.runId && result.manifestHash === manifestHash && result.runtimeHash === state.runtimeHash
    && result.executionId === task.executionId && result.sessionId === session.sessionId && result.correctionOrdinal === 1 && result.initialAttemptCountDelta === 0
    && result.officialSubmissionReady === false && result.evaluationComplete === true && typeof result.businessPassed === 'boolean' && result.score === Number(result.businessPassed)
    && (result.businessPassed ? result.failure === null : result.failure?.category === 'business_failure' && result.failure.retryable === false), 'replay_result_binding')
  for (const key of ['scenarioId', 'config', 'phase', 'runNumber', 'attemptIndex']) check(result[key] === task[key], 'replay_task_identity_changed')
  for (const value of [report.correctionContext, state.correctionContext, result.correctionContext]) check(digest(value) === digest(task.correctionContext), 'replay_context_changed')
  const process = json(report.process)
  check(healthy(process) && report.process.path === `${session.outputDir}/process-result.json` && report.events.path === `${session.outputDir}/runtime-events.jsonl`, 'fresh_ARE_process_missing')
  const eventBytes = bytes(report.events.path); check(sha(eventBytes) === report.events.sha256, 'replay_event_SHA_changed')
  const events = eventBytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
  const runtime = validateRuntimeEvidence({ manifest, task, session, events, runtimeAttestation: result.runtimeAttestation, runtimeEvidence: result.runtimeEvidence, readEvidence: bytes })
  check(runtime.realHooksReady === true && runtime.readonlyInitializationVerified === true && runtime.consumedStrategyHash === task.correctionContext.strategyHash, 'replay_runtime_not_ready')
  const authorityIndex = JSON.parse(bytes(result.runtimeAttestation.correctionAuthorityPath))
  const sealed = new Map(authorityIndex.files.map(ref => [ref.originalPath, ref.path]))
  const authority = verifyCorrectionReplayAuthority({ manifest, task, readEvidence: path => { check(sealed.has(path), 'unsealed_replay_authority'); return bytes(sealed.get(path)) } })
  const parent = authority.verified.verifiedParent
  check(task.executionId !== parent.task.executionId && session.sessionId !== parent.session.sessionId && session.workspaceDir !== parent.session.workspaceDir
    && session.outputDir !== parent.session.outputDir, 'parent_runtime_reused')
  const originalProcess = JSON.parse(parent.readEvidence(`${parent.session.outputDir}/process-result.json`))
  assertFreshReplayProcessGeneration({ process, parentProcess: originalProcess })
  verifyFreshNativeArtifacts({ task, session, fixture: result.freshReplayFixture, artifacts: result.artifacts, expectedPassed: result.businessPassed, readEvidence: bytes })
  check(events.findLast(event => event.type === 'official_validation_completed')?.validationSuccess === result.businessPassed, 'replay_official_validation_missing')
  return { schemaVersion: 'gaia2-phase4-replay-verification-v1', executionId: task.executionId, parentExecutionId: parent.task.executionId,
    parentSessionId: parent.session.sessionId, parentResultHash: task.correctionContext.parentResultHash, correctionOrdinal: 1, initialAttemptCountDelta: 0,
    businessPassed: result.businessPassed, score: result.score, strategyHash: task.correctionContext.strategyHash,
    sanitizedInputHash: task.correctionContext.sanitizedInputHash, trainingReceipt: authority.trainingReceipt,
    trainingReceiptHash: task.correctionContext.trainingReceiptHash, sourceHash: digest([...consumed].map(([path, value]) => ({ path, sha256: sha(value) }))),
    runtimeProof: runtime, evidenceRefs: [...consumed].map(([path, value]) => ({ path, sha256: sha(value) })) }
}
