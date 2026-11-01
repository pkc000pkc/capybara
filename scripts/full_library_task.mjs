/** One fresh, original full-library execution. No task retry, correction or regrade. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { digest, fileDigest, readJson, within } from '../src/phase0_run.mjs'
import { hostInvocationDigest } from '../src/host_invocation_digest.mjs'
import { fixtureFromScenario, modelRuntimeEnvironment, readNativeResult, resolveTransportProvider, taskReconciliationEnvironment } from '../src/phase1_official.mjs'
import { writeOfficialEntryManifest } from '../src/phase1_official_entry.mjs'
import { runChildProcess } from '../src/phase1_process.mjs'
import { startRuntimeHookService } from '../src/phase3_hook_service.mjs'
import { verifyOfficialA2ARuntimeEvidence } from '../src/phase5_a2a_evidence.mjs'
import { verifyModelHttpDispatchEvidence } from '../src/phase6_http_evidence.mjs'
import { verifyPhase6NativeProcessIdentity } from '../src/phase6_process_identity.mjs'
import { filesBelow, portable, processClean, save, verifyTemporalReceipts } from './temporal_e2e.mjs'
import { supervisionSafety } from './temporal_official_ten.mjs'
import { verifyConflictReceipts } from './conflict_recovery_e2e.mjs'
import { verifyRuntimeSemanticReceipts } from './runtime_semantics_e2e.mjs'
import { classifyJudgeReliability } from '../src/judge_reliability.mjs'

const STANDARD_CONFIGS = ['execution', 'search', 'adaptability', 'time', 'ambiguity']
const jsonHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Pure phase boundary: enhanced official mini profiles never receive Standard-only extensions. */
export function fullLibraryProfileOptions({ manifest, task }) {
  assert.equal(manifest.mode, 'full_library_once')
  assert.equal(manifest.dataset.kind, 'submission')
  assert.equal(manifest.dataset.split, 'validation')
  assert.equal(manifest.executionBinding, 'phase3_live_plugin_host_required')
  assert.equal(manifest.syntheticFixtureOnly, false)
  assert.equal(manifest.officialSubmissionReady, false)
  assert.equal(manifest.correctionEnabled, false)
  assert.equal(Object.hasOwn(manifest, 'taskContract'), false, 'retired task-contract profile cannot execute')
  assert.equal(Object.hasOwn(manifest, 'correctionContext'), false)
  assert.equal(Object.hasOwn(task, 'correctionContext'), false)
  assert.equal(task.runNumber, 1)
  assert.equal(task.attemptIndex, 0)
  assert.equal(task.correctionOrdinal, 0)
  assert.ok(['standard', 'agent2agent', 'noise'].includes(task.phase))
  assert.ok(task.phase === 'standard' ? STANDARD_CONFIGS.includes(task.config) : task.config === 'mini')
  assert.equal(manifest.settings.minimal, false)
  assert.equal(manifest.settings.concurrency, 1)
  for (const name of ['temporal', 'conflictRecovery', 'entitySemantics', 'mutationReceipts']) assert.deepEqual(manifest[name], { enabled: true })
  assert.deepEqual(manifest.retrieval, { enabled: true, profile: 'standard-search' })
  return task.phase === 'standard' ? {
    temporal: { enabled: true }, conflictRecovery: { enabled: true },
    entitySemantics: { enabled: true }, mutationReceipts: { enabled: true },
    ...(task.config === 'search' ? { retrieval: { enabled: true, profile: 'standard-search' } } : {}),
  } : {}
}

/** Pure launch envelope; only trusted configuration supplies endpoint/model/transport. */
export function buildFullLibraryLaunch({ root, protocol, manifest, task, session, connection, entry, service, env = process.env, windowObligationSource = null, windowPipelineEnabled = false }) {
  const profile = fullLibraryProfileOptions({ manifest, task })
  const settings = manifest.settings
  const datasetRoot = resolve(root, session.fixtureDir), output = resolve(root, session.outputDir), workspace = resolve(root, session.workspaceDir)
  const augmentationArgs = task.phase === 'agent2agent'
    ? ['--a2a_app_prop', '1.0', '--a2a_app_agent', 'default_app_agent', '--a2a_model', manifest.models.actor.model,
      '--a2a_model_provider', resolveTransportProvider(manifest.models.actor.provider), '--a2a_endpoint', connection.baseUrl]
    : task.phase === 'noise' ? ['--noise'] : []
  const args = [join(root, 'scripts/temporal_official_entry.py'), 'run', '--dataset', datasetRoot, '--config', task.config,
    '--agent', 'default', '--model', manifest.models.actor.model, '--provider', resolveTransportProvider(manifest.models.actor.provider), '--endpoint', connection.baseUrl,
    '--judge_model', manifest.models.judge.model, '--judge_provider', resolveTransportProvider(manifest.models.judge.provider), '--judge_endpoint', connection.baseUrl,
    '--limit', '1', '--num_runs', '1', '--max_concurrent_scenarios', '1', '--scenario_timeout', String(settings.scenarioTimeoutSeconds),
    '--output_dir', output, '--trace_dump_format', 'both', '--log-level', 'INFO', ...augmentationArgs]
  // Remove inherited run/profile/diagnostic authority, credentials and Python import overrides.
  const inherited = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(?:GAIA2_|PYTHONPATH$|PYTHONHOME$|PYTHONSTARTUP$|PYTHONINSPECT$|NODE_OPTIONS$)/i.test(key)
    && !/(?:API_KEY|ACCESS_TOKEN|AUTHORIZATION|HF_TOKEN|HUGGINGFACE_TOKEN)/i.test(key)))
  const retrievalEnabled = manifest.retrieval?.enabled === true && task.phase === 'standard' && task.config === 'search'
  const childEnv = { ...inherited, ...modelRuntimeEnvironment(settings),
    PYTHONPATH: resolve(root, protocol.runtime.officialPythonPath), PYTHONUTF8: '1', OPENAI_API_KEY: connection.apiKey,
    GAIA2_E2E_MINIMAL: '0', GAIA2_E2E_MAX_ACTIONS: String(settings.maxActions), GAIA2_E2E_TOOL_ALLOWLIST: '',
    ...taskReconciliationEnvironment(),
    GAIA2_E2E_ATTEMPT_INDEX: '0', GAIA2_E2E_CORRECTION_ORDINAL: '0',
    GAIA2_EXECUTION_ID: task.executionId, GAIA2_SESSION_ID: session.sessionId,
    GAIA2_RUNTIME_EVENT_FILE: join(output, 'runtime-events.jsonl'), GAIA2_HOOK_URL: service.endpoint, GAIA2_HOOK_TOKEN: service.token,
    GAIA2_OFFICIAL_ENTRY_REQUIRED: '1', GAIA2_OFFICIAL_ENTRY_PATH: entry.path, GAIA2_OFFICIAL_ENTRY_SHA256: entry.sha256,
    GAIA2_MODEL_HTTP_GUARD_REQUIRED: '1', GAIA2_TOOL_ROUND_WORKSPACE: workspace, GAIA2_HOOK_TIMEOUT_SECONDS: '900',
    ...(windowObligationSource !== null ? { GAIA2_WINDOW_OBLIGATION_SOURCE_JSON: JSON.stringify(windowObligationSource) } : {}),
    ...(windowPipelineEnabled ? { GAIA2_WINDOW_PIPELINE_ENABLED: '1', GAIA2_WINDOW_EVIDENCE_DIR: join(workspace, 'window-registration-evidence') } : {}),
    GAIA2_RETRIEVAL_ENABLED: retrievalEnabled ? '1' : '0', GAIA2_RETRIEVAL_WORKSPACE: workspace,
    GAIA2_NOISE_ENABLED: task.phase === 'noise' ? '1' : '0',
    ...(profile.temporal ? { GAIA2_TEMPORAL_ENABLED: '1', GAIA2_TEMPORAL_WORKSPACE: workspace,
      GAIA2_CONFLICT_RECOVERY_ENABLED: '1', GAIA2_CONFLICT_RECOVERY_WORKSPACE: workspace,
      GAIA2_ENTITY_SEMANTICS_ENABLED: '1', GAIA2_ENTITY_SEMANTICS_WORKSPACE: workspace,
      GAIA2_MUTATION_RECEIPTS_ENABLED: '1', GAIA2_MUTATION_RECEIPTS_WORKSPACE: workspace } : {}),
    // This name belongs to the evidence-only bootstrap, not the temporal capability.
    GAIA2_TEMPORAL_EVIDENCE_DIR: join(output, 'model-evidence'), TMP: workspace, TEMP: workspace, TMPDIR: workspace,
    HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', LITELLM_LOCAL_MODEL_COST_MAP: 'True', LITELLM_TELEMETRY: 'False' }
  if (task.phase === 'agent2agent') {
    const pipe = service.ready?.a2a
    assert.equal(pipe?.host, '127.0.0.1')
    assert.ok(Number.isInteger(pipe.port) && pipe.port > 0 && pipe.port <= 65535)
    assert.match(pipe.channelId, /^[a-f0-9]{64}$/); assert.match(pipe.bindingHash, /^[a-f0-9]{64}$/)
    Object.assign(childEnv, { GAIA2_A2A_PIPE_HOST: pipe.host, GAIA2_A2A_PIPE_PORT: String(pipe.port),
      GAIA2_A2A_PIPE_CHANNEL: pipe.channelId, GAIA2_A2A_PIPE_BINDING: pipe.bindingHash,
      GAIA2_A2A_MODEL: manifest.models.actor.model, GAIA2_A2A_PROVIDER: resolveTransportProvider(manifest.models.actor.provider),
      GAIA2_A2A_ENDPOINT: connection.baseUrl, GAIA2_A2A_WORKSPACE: workspace })
  }
  return { command: resolve(root, protocol.runtime.python), args, cwd: workspace, outputDir: output,
    processTimeoutMs: settings.processTimeoutMs, heartbeatIntervalMs: settings.heartbeatIntervalMs,
    secrets: [connection.apiKey, service.token], env: childEnv }
}

function readEvents(output, task, session) {
  const path = join(output, 'runtime-events.jsonl')
  const events = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : []
  assert.ok(events.every(event => event.executionId === task.executionId && event.sessionId === session.sessionId))
  return events
}

function capturesAt(output) {
  const directory = join(output, 'model-evidence')
  return existsSync(directory) ? filesBelow(directory).filter(path => /hook-\d{6}-/.test(path)).sort().map(readJson) : []
}

/** Original session-relative sealed files only; absolute A2A source identities are never opened. */
function evidenceFile(root, path, parent) {
  assert.equal(typeof path, 'string')
  assert.ok(path.length > 0 && !/^(?:[\\/]|[A-Za-z]:)/.test(path) && !/[\\:\0]/.test(path)
    && !path.split('/').some(part => !part || part === '.' || part === '..'))
  const target = resolve(root, path), boundary = resolve(root, parent)
  assert.ok(within(boundary, target) && target !== boundary)
  for (let at = target; ; at = dirname(at)) {
    assert.ok(!lstatSync(at).isSymbolicLink())
    if (at === boundary) break
  }
  assert.ok(lstatSync(target).isFile())
  return target
}

/** Shared immutable identity sent to the independent HTTP verifier, never derived from saved scores. */
export function fullLibraryEvidenceIdentity({ manifest, task, session }) {
  return { runId: manifest.runId, manifestHash: manifest.manifestHash,
    executionId: task.executionId, sessionId: session.sessionId, scenarioId: task.scenarioId,
    runNumber: task.runNumber, phase: task.phase, config: task.config,
    scenarioVersion: task.scenarioVersion, scenarioHash: task.scenarioHash,
    attemptIndex: task.attemptIndex, correctionOrdinal: task.correctionOrdinal }
}

/** Independent current A2A source/child/native/model/deadline proof; no broad legacy business validator. */
export function verifyFullLibraryA2AEvidence({ root, manifest, task, session, events }) {
  assert.equal(task.phase, 'agent2agent')
  const readEvidence = path => readFileSync(evidenceFile(root, path, session.workspaceDir))
  const summary = verifyOfficialA2ARuntimeEvidence({ events,
    identity: { executionId: task.executionId, sessionId: session.sessionId },
    deadlineRequestTimeoutMs: Math.max(1, Math.min(2147483647, Math.trunc(manifest.settings.scenarioTimeoutSeconds * 1000))),
    readEvidence })
  const consumedRefs = summary.consumedEvidencePaths.map(path => ({ path,
    sha256: fileDigest(evidenceFile(root, path, session.workspaceDir)) }))
  return { status: 'verified', summary, consumedRefs }
}

/** Independently bind every SDK dispatch to the actual closed Python generation and original entry. */
export function verifyFullLibraryHttpEvidence({ root, manifest, task, session, events, actor }) {
  const paths = { journal: `${session.outputDir}/model-http-dispatch.jsonl`,
    process: `${session.outputDir}/process-result.json`, entry: `${session.outputDir}/official-entry/run-manifest.json` }
  const bytes = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key,
    readFileSync(evidenceFile(root, path, session.outputDir))]))
  const nativeProcess = JSON.parse(bytes.process.toString('utf8'))
  assert.deepEqual(nativeProcess, actor, 'returned actor process differs from actual terminal receipt')
  const processIdentity = verifyPhase6NativeProcessIdentity({ nativeProcess,
    officialEntry: JSON.parse(bytes.entry.toString('utf8')), pythonProcessId: nativeProcess.pid })
  const summary = verifyModelHttpDispatchEvidence({ journalBytes: bytes.journal, events,
    identity: fullLibraryEvidenceIdentity({ manifest, task, session }),
    officialEntryBytes: bytes.entry, pythonProcessId: nativeProcess.pid })
  const consumedRefs = Object.values(paths).map(path => ({ path,
    sha256: fileDigest(evidenceFile(root, path, session.outputDir)) }))
  return { status: 'verified', summary, processIdentity, consumedRefs }
}

/** Source-bound parent Host evidence for every phase, independent of optional controller receipts. */
export function verifyFullLibraryBaseReceipts({ root, workspace, task, session, captures, initialization }) {
  let priorHash = initialization.variablesHash, sequence = 1, revision = 1
  return captures.map(item => {
    const response = item.response
    assert.equal(typeof response?.evidencePath, 'string')
    const path = resolve(response.evidencePath)
    const rel = portable(relative(workspace, path))
    assert.match(rel, /^plugin-runtime\/\d{6}-(?:before_model|before_tool|after_tool|attempt_end)-[a-f0-9-]+\.json$/)
    assert.ok(within(workspace, path))
    for (let at = path; ; at = dirname(at)) {
      assert.ok(!lstatSync(at).isSymbolicLink())
      if (at === resolve(workspace)) break
    }
    const source = readJson(path)
    assert.equal(source.schemaVersion, 'capybara-runtime-plugin-invocation-v1')
    assert.equal(source.executionId, task.executionId); assert.equal(source.sessionId, session.sessionId)
    assert.equal(source.scenarioId, task.scenarioId); assert.equal(source.sequence, ++sequence)
    // RuntimePluginHost appends trusted argument hashes after admission. They
    // remain in the immutable Host report and are validated by the dedicated
    // argument-evidence checks; the base receipt identity compares the same
    // caller-visible invocation projection as the Python bridge.
    assert.equal(hostInvocationDigest(source.input), hostInvocationDigest({ ...item.request, checkpoint: item.checkpoint }))
    for (const key of ['decision', 'context', 'contextHash', 'hookReceipts', 'variablesHash', 'revision']) assert.deepEqual(response[key], source[key])
    assert.equal(createHash('sha256').update(source.context).digest('hex'), source.contextHash)
    assert.equal(jsonHash(source.variables), source.variablesHash)
    assert.equal(source.beforeVariablesHash, priorHash)
    assert.ok(Number.isInteger(source.revision) && source.revision >= revision)
    assert.ok(Array.isArray(source.hookReceipts) && source.hookReceipts.length > 0 && source.hookReceipts.every(hook => hook.status === 'passed'))
    priorHash = source.variablesHash; revision = source.revision
    return { checkpoint: item.checkpoint, sequence: source.sequence, revision,
      sourcePath: portable(relative(root, path)), sha256: fileDigest(path) }
  })
}

function usageFrom(events) {
  const temporalNative = events.filter(event => event.type === 'tool_call_completed' && event.dispatchSource === 'temporal_controller')
  const temporalNativeWaits = temporalNative.filter(event => event.canonicalName === 'SystemApp__wait_for_notification').length
  return { temporalWatchStarted: events.filter(event => event.type === 'temporal_watch_started').length,
    temporalWatchCompleted: events.filter(event => event.type === 'temporal_watch_completed').length,
    temporalNativeWaits, temporalNativeScans: temporalNative.length - temporalNativeWaits,
    temporalSignals: events.filter(event => event.type === 'temporal_watch_completed'),
    conflictRecoveryStarted: events.filter(event => event.type === 'conflict_recovery_started').length,
    conflictRecoveryCompleted: events.filter(event => event.type === 'conflict_recovery_completed').length,
    conflictRecoveryNativeReads: events.filter(event => event.type === 'tool_call_completed' && event.dispatchSource === 'conflict_recovery').length,
    conflictRecoveryResults: events.filter(event => event.type === 'conflict_recovery_completed'),
    executionFactsInjected: events.filter(event => event.type === 'execution_facts_injected').length,
    a2aChildSnapshots: events.filter(event => event.type === 'a2a_client_snapshot').length }
}

function semanticUsageFrom(events, captures) {
  const kinds = captures.map(item => item.request?.outcome?.semanticEvidence?.kind).filter(Boolean)
  return { actorModelRequests: events.filter(event => event.type === 'model_request').length,
    contractModelRequests: events.filter(event => event.type === 'task_contract_model_request').length,
    entityEvidenceCounts: Object.fromEntries(['delete_succeeded', 'entity_absent', 'entity_present'].map(kind => [kind, kinds.filter(value => value === kind).length])),
    taskSignals: events.filter(event => event.type === 'task_obligation_signaled'),
    taskStateCommits: events.filter(event => event.type === 'task_contract_committed').length }
}

/** Aggregate answer-blind Judge observations emitted at the frozen ARE seam. */
export function judgeEvidenceFromEvents(events) {
  const rows = (Array.isArray(events) ? events : []).filter(event => event?.type === 'judge_response_observed')
  if (!rows.length) return null
  const normalizations = (Array.isArray(events) ? events : [])
    .filter(event => event?.type === 'judge_protocol_normalized'
      && typeof event.rawResponseHash === 'string' && /^[a-f0-9]{64}$/.test(event.rawResponseHash)
      && typeof event.normalizedResponseHash === 'string' && /^[a-f0-9]{64}$/.test(event.normalizedResponseHash)
      && event.caseFoldBooleanMarkers === true)
  const normalizedHashes = new Set(normalizations.flatMap(event => [event.rawResponseHash, event.normalizedResponseHash]))
  const rowWasNormalized = event => normalizedHashes.has(event.rawResponseHash)
    || normalizedHashes.has(event.checkerResponseHash)
  const valid = rows.every(event => event.modelRole === 'judge'
    && typeof event.requestId === 'string' && /^[a-f0-9]{32}$/.test(event.requestId)
    && Number.isInteger(event.requestAttempt) && event.requestAttempt > 0
    && typeof event.rawResponseHash === 'string' && /^[a-f0-9]{64}$/.test(event.rawResponseHash)
    && typeof event.checkerResponseHash === 'string' && /^[a-f0-9]{64}$/.test(event.checkerResponseHash)
    && ['parsed', 'unparsed', 'unknown'].includes(event.parseStatus)
    && typeof event.checkerPath === 'string' && event.checkerPath.length > 0
    && typeof event.markerConflict === 'boolean')
  if (!valid) return { schemaVersion: 'gaia2-judge-reliability-v1', checkerPath: null,
    parseStatus: 'unparsed', rawResponseHash: null, markerConflict: false,
    source: 'runtime_judge_response_evidence_invalid' }
  const checkerPaths = [...new Set(rows.map(event => event.checkerPath))]
  const rawMarkerConflict = rows.some(event => event.markerConflict === true)
  const markerConflict = rows.some(event => event.markerConflict === true && !rowWasNormalized(event))
  const parseStatus = rows.every(event => event.parseStatus === 'parsed' || rowWasNormalized(event))
    ? 'parsed' : 'unparsed'
  // Both Boolean outcomes are part of the same official protocol.  Do not
  // treat `[[False]]` -> `[[false]]` differently from the corresponding
  // `True` case; otherwise a historical false verdict could lose its
  // protocol evidence and be silently admitted as a model score.
  const evidencedConflict = markerConflict && rows.some(event => event.markerConflict === true
    && !rowWasNormalized(event)
    && ['true', 'false'].some(name => event.rawMarkers?.upper?.[name] === true
      && event.checkerMarkers?.lower?.[name] === true
      && event.checkerMarkers?.upper?.[name] !== true))
  const rawResponseHash = digest(rows.map(event => ({ requestId: event.requestId, requestAttempt: event.requestAttempt,
    rawResponseHash: event.rawResponseHash, checkerResponseHash: event.checkerResponseHash,
    parseStatus: event.parseStatus, markerConflict: event.markerConflict })))
  const markerConflictEvidence = evidencedConflict ? { rawHasExpected: true, checkerHasExpected: false,
    checkerHasLower: true, transformEvidence: true } : null
  return { schemaVersion: 'gaia2-judge-reliability-v1', checkerPath: checkerPaths.length === 1 ? checkerPaths[0] : null,
    parseStatus, rawResponseHash, markerConflict, rawMarkerConflict,
    protocolNormalization: normalizations.length ? {
      schemaVersion: 'gaia2-judge-normalization-v1', applied: true, count: normalizations.length,
      records: normalizations.map(event => ({ rawResponseHash: event.rawResponseHash,
        normalizedResponseHash: event.normalizedResponseHash })),
    } : null,
    markerConflictEvidence,
    source: 'runtime_judge_response_evidence', callCount: rows.length }
}

/** A native diagnostic score is retained, but only a clean, complete execution is a scored task. */
export function fullLibraryTaskOutcome({ runnerError = null, receiptError = null, actor, host, native, judgeEvidence = null }) {
  const technicalError = runnerError?.code ?? receiptError ?? (!processClean(actor) ? 'actor_process_unclean'
    : !processClean(host) ? 'host_process_unclean' : native?.report.evaluationComplete !== true ? 'official_evaluation_incomplete' : null)
  const evaluationComplete = technicalError === null && native?.report.evaluationComplete === true
  const judgeReliability = classifyJudgeReliability({
    evaluationComplete,
    rawScore: native?.report?.score ?? null,
    technicalError,
    judgeEvidence: native?.report?.judgeEvidence ?? native?.report?.judgeProtocolEvidence ?? judgeEvidence,
    officialEvidence: native?.report?.officialEvidence ?? null,
  })
  return { status: technicalError ? 'technical_error' : 'evaluated', technicalError,
    evaluationComplete, rawScore: native?.report?.score ?? null,
    judgeProtocolAffected: judgeReliability.judgeProtocolAffected,
    scoreReliability: judgeReliability.scoreReliability,
    judgeReliability, officialEvidence: native?.report?.officialEvidence ?? null }
}

export async function executeFullLibraryTask({ root, manifest, task, index, connection, signal,
  windowObligationSource = null, windowPipelineEnabled = false }) {
  root = resolve(root)
  assert.ok(Number.isInteger(index) && index >= 0)
  assert.ok(!signal?.aborted)
  const profile = fullLibraryProfileOptions({ manifest, task })
  assert.equal(manifest.tasks.filter(item => item.executionId === task.executionId && digest(item) === digest(task)).length, 1)
  const protocol = readJson(join(root, 'config/phase0-protocol.json'))
  const ordinal = `task-${String(index + 1).padStart(4, '0')}`
  const taskRoot = resolve(root, manifest.runRoot, ordinal)
  assert.ok(within(resolve(root, 'runs'), taskRoot) && within(resolve(root, manifest.runRoot), taskRoot))
  assert.ok(!existsSync(taskRoot), 'task cannot silently rerun or resume')
  const output = join(taskRoot, 'output'), workspace = join(taskRoot, 'workspace'), datasetRoot = join(taskRoot, 'fixture')
  mkdirSync(output, { recursive: true }); mkdirSync(workspace); mkdirSync(join(datasetRoot, task.config), { recursive: true })
  const session = { sessionId: `${ordinal}-${randomUUID().slice(0, 8)}`, outputDir: portable(relative(root, output)),
    workspaceDir: portable(relative(root, workspace)), fixtureDir: portable(relative(root, datasetRoot)) }
  const file = await asyncBufferFromFile(resolve(root, task.sourcePath))
  const [row] = await parquetReadObjects({ file, columns: ['scenario_id', 'data'], rowStart: task.rowIndex, rowEnd: task.rowIndex + 1, compressors })
  assert.equal(row?.scenario_id, task.scenarioId)
  // Every original field/event/app/duration survives; only official run_number is bound to one.
  save(join(datasetRoot, task.config, 'scenario.json'), fixtureFromScenario(JSON.parse(row.data), task))
  const entry = writeOfficialEntryManifest({ root, manifest, task, session })
  let service, actor, host, runnerError = null
  try {
    service = await startRuntimeHookService({ root, manifest, task, session, settings: manifest.settings, signal, entry, ...profile })
    actor = await runChildProcess({ ...buildFullLibraryLaunch({ root, protocol, manifest, task, session, connection, entry, service,
      windowObligationSource, windowPipelineEnabled }), signal })
  } catch (error) { runnerError = { code: 'full_library_task_execution_error', errorType: error?.name ?? 'Error' } }
  finally {
    if (service) {
      try { host = await service.close() }
      catch (error) { runnerError ??= { code: 'full_library_host_close_error', errorType: error?.name ?? 'Error' } }
    }
  }
  let events = [], native = null, receiptError = null, baseHostReceipts = [], temporalHostReceipts = [], conflictHostReceipts = [], semanticHostReceipts = [], semanticUsage = null
  let modelHttpEvidence = null, a2aRuntimeEvidence = null
  try {
    events = readEvents(output, task, session)
    native = readNativeResult({ root, outputDir: session.outputDir, task, session, events })
  } catch { receiptError = 'native_result_or_events_invalid' }
  try {
    const captures = capturesAt(output)
    baseHostReceipts = verifyFullLibraryBaseReceipts({ root, workspace, task, session, captures, initialization: service.ready.initialization })
    assert.ok(baseHostReceipts.length > 0)
    if (task.phase === 'standard') {
      temporalHostReceipts = verifyTemporalReceipts({ root, workspace, executionId: task.executionId, sessionId: session.sessionId, captures })
      conflictHostReceipts = await verifyConflictReceipts({ root, workspace, executionId: task.executionId, sessionId: session.sessionId, captures })
      semanticHostReceipts = await verifyRuntimeSemanticReceipts({ root, workspace, executionId: task.executionId, sessionId: session.sessionId, captures })
      for (const receipts of [temporalHostReceipts, conflictHostReceipts, semanticHostReceipts]) assert.equal(receipts.length, captures.length)
      semanticUsage = semanticUsageFrom(events, captures)
    } else {
      assert.ok(captures.every(item => !['temporalReceipt', 'conflictReceipt', 'semanticReceipt', 'retrievalReceipt'].some(key => Object.hasOwn(item.response, key))))
    }
    if (native?.report.evaluationComplete === true) assert.equal(baseHostReceipts.at(-1).checkpoint, 'attempt_end')
  } catch { receiptError ??= 'host_controller_receipts_invalid' }
  try { modelHttpEvidence = verifyFullLibraryHttpEvidence({ root, manifest, task, session, events, actor }) }
  catch { receiptError ??= 'model_http_dispatch_evidence_invalid' }
  if (task.phase === 'agent2agent') {
    try { a2aRuntimeEvidence = verifyFullLibraryA2AEvidence({ root, manifest, task, session, events }) }
    catch { receiptError ??= 'a2a_runtime_evidence_invalid' }
  }
  const artifacts = filesBelow(taskRoot).map(path => ({ path: portable(relative(root, path)), sha256: fileDigest(path) }))
  const judgeEvidence = judgeEvidenceFromEvents(events)
  const outcome = fullLibraryTaskOutcome({ runnerError, receiptError, actor, host, native, judgeEvidence })
  const dispatchSafety = { actor: supervisionSafety(output, actor), host: supervisionSafety(join(output, 'hook-host'), host) }
  const eventPath = join(output, 'runtime-events.jsonl')
  const report = { schemaVersion: 'gaia2-full-library-once-task-report-v1', scenarioId: task.scenarioId,
    config: task.config, executionId: task.executionId, sessionId: session.sessionId, originalScenarioHash: task.scenarioHash,
    runNumber: 1, attemptIndex: 0, correctionOrdinal: 0, phase: task.phase, ...outcome, runnerError,
    native: native?.report ?? null, officialSubmissionReady: false, knownJudgeDefect: manifest.knownJudgeDefect,
    officialEvaluationEvidence: native?.report?.officialEvidence ?? null,
    judgeProtocolAffected: outcome.judgeProtocolAffected, scoreReliability: outcome.scoreReliability,
    judgeReliability: outcome.judgeReliability,
    judgeEvidence,
    modelInputCount: artifacts.filter(ref => /model-\d{6}-input\.json$/.test(ref.path)).length,
    modelOutputCount: artifacts.filter(ref => /model-\d{6}-output\.json$/.test(ref.path)).length,
    modelSdkAttempts: events.filter(event => event.type === 'model_request_attempt').length,
    runtimeEventCount: events.length, eventsHash: digest(events),
    runtimeEvents: existsSync(eventPath) ? { path: portable(relative(root, eventPath)), sha256: fileDigest(eventPath) } : null,
    controllerUsage: usageFrom(events), baseHostReceipts, temporalHostReceipts, conflictHostReceipts, semanticHostReceipts, semanticUsage,
    modelHttpEvidence, a2aRuntimeEvidence,
    actorProcess: actor ?? null, hostProcess: host ?? null, dispatchSafety,
    fatalSupervision: !dispatchSafety.actor.safeToDispatchNext || !dispatchSafety.host.safeToDispatchNext, artifacts }
  save(join(taskRoot, 'report.json'), report)
  return report
}
