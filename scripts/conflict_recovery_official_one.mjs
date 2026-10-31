/** One fixed, unmodified official task. Explicit prepare/run/verify; never a batch. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { canonicalScenarioHash } from '../src/phase0_dataset.mjs'
import { freezePluginSnapshot, inspectPluginResources } from '../src/phase0_inventory.mjs'
import { digest, fileDigest, readJson, within } from '../src/phase0_run.mjs'
import { fixtureFromScenario, modelRuntimeEnvironment, taskReconciliationEnvironment, readModelConnection, readNativeResult, resolveModelRetrySettings, resolveTransportProvider } from '../src/phase1_official.mjs'
import { resolveRuntimeSettings } from '../src/phase1_config.mjs'
import { writeOfficialEntryManifest } from '../src/phase1_official_entry.mjs'
import { runChildProcess } from '../src/phase1_process.mjs'
import { startRuntimeHookService } from '../src/phase3_hook_service.mjs'
import { ROOT, filesBelow, portable, processClean, save, verifyTemporalReceipts } from './temporal_e2e.mjs'
import { collectTemporalFrozenSources, supervisionSafety } from './temporal_official_ten.mjs'
import { verifyConflictPluginSnapshots, verifyConflictReceipts } from './conflict_recovery_e2e.mjs'
import { verifyRuntimeSemanticReceipts } from './runtime_semantics_e2e.mjs'

export const TARGET_ID = 'scenario_universe_22_9pq84p'
export const THIN_RUNTIME_MODE = 'temporal_entity_runtime_diagnostic'
export const REFERENCE_MANIFEST = 'runs/temporal-official-ten-20261019T154626382Z-7082b888/manifest.json'
export const SELECTION_RULE = `Explicit human-requested diagnostic rerun of fixed task ${TARGET_ID}; original official validation/time task, Standard/run1, one fresh attempt, no correction, resume or scenario trimming; not a blind benchmark sample or a success-rate estimate`
const SCHEMA = 'gaia2-conflict-recovery-official-one-manifest-v1'

export function parseConflictOfficialOneArgs(argv) {
  if (argv.length === 1 && argv[0] === '--prepare') return { mode: 'prepare' }
  if (argv.length === 2 && ['--run', '--verify'].includes(argv[0]) && argv[1] && !argv[1].startsWith('--')) return { mode: argv[0].slice(2), path: argv[1] }
  throw new Error('Usage: node scripts/conflict_recovery_official_one.mjs --prepare | --run <manifest.json> | --verify <manifest.json>; fixed task only, no batch/resume/retry-task')
}

export function assertUnchangedPublicConfiguration({ models, settings }, reference) {
  const differences = []
  const walk = (actual, previous, path) => {
    if (actual && previous && typeof actual === 'object' && typeof previous === 'object') {
      for (const key of new Set([...Object.keys(actual), ...Object.keys(previous)])) walk(actual[key], previous[key], `${path}.${key}`)
    } else if (actual !== previous) differences.push(path)
  }
  walk(models, reference.models, 'models'); walk(settings, reference.settings, 'settings')
  if (differences.length) {
    const error = new Error('Current public model/runtime configuration differs from the previous task-02 freeze')
    error.code = 'official_one_public_configuration_changed'
    error.configurationDifferences = differences
    throw error
  }
  return true
}

function referenceAt(root) {
  const reference = readJson(join(root, REFERENCE_MANIFEST))
  const { manifestHash, ...base } = reference
  assert.equal(digest(base), manifestHash)
  assert.equal(reference.schemaVersion, 'gaia2-temporal-official-ten-manifest-v1')
  const tasks = reference.tasks.filter(task => task.scenarioId === TARGET_ID)
  assert.equal(tasks.length, 1)
  return { reference, task: tasks[0] }
}

/** Pure, independently testable single-task and unchanged-config authority. */
export function validateOfficialOneIdentity(manifest, reference) {
  assert.equal(manifest.schemaVersion, SCHEMA)
  assert.match(manifest.runId, /^conflict-recovery-official-one-[A-Za-z0-9-]+$/)
  assert.equal(manifest.runRoot, `runs/${manifest.runId}`)
  assert.equal(manifest.originalTaskCount, 1)
  assert.equal(manifest.syntheticFixtureOnly, false)
  assert.equal(manifest.officialSubmissionReady, false)
  assert.equal(manifest.selectionRule, SELECTION_RULE)
  assert.deepEqual(manifest.temporal, { enabled: true })
  assert.deepEqual(manifest.conflictRecovery, { enabled: true })
  if (manifest.taskContract !== undefined) {
    assert.deepEqual(manifest.entitySemantics, { enabled: true })
    assert.deepEqual(manifest.taskContract, { enabled: true })
    assert.equal(manifest.mode, 'temporal_conflict_entity_wait_diagnostic')
  } else if (manifest.entitySemantics !== undefined) {
    assert.deepEqual(manifest.entitySemantics, { enabled: true })
    assert.deepEqual(manifest.mutationReceipts, { enabled: true })
    assert.equal(manifest.mode, THIN_RUNTIME_MODE)
  } else {
    assert.equal(manifest.mode, 'temporal_conflict_recovery_diagnostic')
  }
  if (manifest.mutationReceipts !== undefined) assert.deepEqual(manifest.mutationReceipts, { enabled: true })
  assert.deepEqual(manifest.models, reference.models)
  assert.equal(typeof manifest.models.actor.model, 'string')
  assert.ok(manifest.models.actor.model.length > 0)
  assert.equal(typeof manifest.models.judge.model, 'string')
  assert.ok(manifest.models.judge.model.length > 0)
  assert.deepEqual(manifest.settings, reference.settings)
  assert.equal(manifest.settings.minimal, false)
  assert.equal(manifest.settings.concurrency, 1)
  assert.equal(manifest.tasks.length, 1)
  const task = manifest.tasks[0]
  const original = reference.tasks.find(item => item.scenarioId === TARGET_ID)
  assert.ok(original)
  for (const key of ['scenarioId', 'scenarioVersion', 'scenarioHash', 'sourcePath', 'rowIndex', 'config']) assert.equal(task[key], original[key])
  assert.equal(task.scenarioId, TARGET_ID)
  assert.equal(task.config, 'time')
  assert.equal(task.phase, 'standard')
  assert.equal(task.runNumber, 1)
  assert.equal(task.attemptIndex, 0)
  assert.equal(task.correctionOrdinal, 0)
  assert.equal(task.executionId, `${manifest.runId}-task-02`)
  assert.equal(manifest.dataset.kind, 'submission')
  for (const key of ['id', 'revision', 'split']) assert.equal(manifest.dataset[key], reference.dataset[key])
  assert.equal(manifest.dataset.split, 'validation')
  assert.equal(manifest.dataset.files.length, 1)
  const datasetFile = reference.dataset.files.find(item => item.path === original.sourcePath)
  assert.ok(datasetFile)
  assert.deepEqual(manifest.dataset.files[0], datasetFile)
  assert.equal(manifest.referenceManifest.path, REFERENCE_MANIFEST)
  assert.equal(manifest.modelConfigurationRef.path, manifest.models.configurationSource)
  assert.equal(manifest.modelConfigurationRef.contentNotCopied, true)
  assert.equal(manifest.modelConfigurationRef.credentialFileNotHashed, true)
  assert.equal(manifest.correctionEnabled, false)
  assert.equal(manifest.originalCampaignModified, false)
  assert.equal(manifest.executionBinding, 'phase3_live_plugin_host_required')
  return true
}

function assertFrozen(root, manifest) {
  const { manifestHash, ...base } = manifest
  assert.equal(digest(base), manifestHash)
  const { reference } = referenceAt(root)
  validateOfficialOneIdentity(manifest, reference)
  for (const ref of [...manifest.runtimeSources, ...manifest.dataset.files, manifest.referenceManifest, manifest.modelConfigurationRef, manifest.lockRefs.capabilities]) {
    assert.equal(fileDigest(resolve(root, ref.path)), ref.sha256)
  }
  const capabilities = readJson(resolve(root, manifest.lockRefs.capabilities.path))
  assert.deepEqual(capabilities.plugins.map(plugin => plugin.id), ['gaia2-runtime', 'gaia2-evaluation'])
  assert.ok(verifyConflictPluginSnapshots(capabilities.plugins))
  return capabilities
}

function loadPlan(root, path) {
  const absolute = resolve(root, path)
  assert.ok(within(join(root, 'runs'), absolute))
  const manifest = readJson(absolute)
  assertFrozen(root, manifest)
  assert.equal(absolute, resolve(root, manifest.runRoot, 'manifest.json'))
  return manifest
}

async function readOriginalScenario(root, task) {
  const file = await asyncBufferFromFile(resolve(root, task.sourcePath))
  const [row] = await parquetReadObjects({ file, columns: ['scenario_id', 'data'], rowStart: task.rowIndex, rowEnd: task.rowIndex + 1, compressors })
  assert.equal(row?.scenario_id, TARGET_ID)
  const scenario = JSON.parse(row.data)
  assert.equal(canonicalScenarioHash(scenario), task.scenarioHash)
  assert.equal(scenario.metadata?.definition?.scenario_id, TARGET_ID)
  assert.equal(scenario.version, task.scenarioVersion)
  return scenario
}

export async function prepareConflictOfficialOne({ root = ROOT, runtimeSemantics = true } = {}) {
  root = resolve(root)
  assert.equal(typeof runtimeSemantics, 'boolean')
  const protocol = readJson(join(root, 'config/phase0-protocol.json'))
  const { reference, task: original } = referenceAt(root)
  const models = structuredClone(protocol.models)
  const settings = { ...resolveRuntimeSettings({ protocol, entrypoint: 'pilot' }), modelRetry: resolveModelRetrySettings() }
  assertUnchangedPublicConfiguration({ models, settings }, reference)
  const datasetFile = reference.dataset.files.find(item => item.path === original.sourcePath)
  assert.ok(datasetFile)
  assert.equal(fileDigest(resolve(root, datasetFile.path)), datasetFile.sha256)
  // The user fixed this diagnostic ID; opening the source cannot change selection.
  await readOriginalScenario(root, original)
  const runId = `conflict-recovery-official-one-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`
  const runRoot = `runs/${runId}`, directory = join(root, runRoot)
  assert.ok(!existsSync(directory)); mkdirSync(directory)
  const task = { ...original, executionId: `${runId}-task-02`, runNumber: 1, attemptIndex: 0, correctionOrdinal: 0, phase: 'standard' }
  const plugins = ['gaia2-runtime', 'gaia2-evaluation'].map(id => inspectPluginResources(freezePluginSnapshot({ root, id, sourceRoot: join(root, 'plugins', id) })))
  const capabilities = save(join(directory, 'capabilities.json'), { schemaVersion: 'gaia2-conflict-official-one-capabilities-v1', plugins })
  const base = { schemaVersion: SCHEMA, runId, runRoot, mode: runtimeSemantics ? THIN_RUNTIME_MODE : 'temporal_conflict_recovery_diagnostic',
    originalTaskCount: 1, syntheticFixtureOnly: false, officialSubmissionReady: false, selectionRule: SELECTION_RULE,
    temporal: { enabled: true }, conflictRecovery: { enabled: true }, correctionEnabled: false,
    ...(runtimeSemantics ? { entitySemantics: { enabled: true }, mutationReceipts: { enabled: true } } : {}),
    executionBinding: 'phase3_live_plugin_host_required', models, settings,
    modelConfigurationRef: { path: models.configurationSource, sha256: fileDigest(resolve(root, models.configurationSource)), contentNotCopied: true, credentialFileNotHashed: true },
    dataset: { kind: 'submission', id: reference.dataset.id, revision: reference.dataset.revision, split: reference.dataset.split, files: [datasetFile] },
    referenceManifest: { path: REFERENCE_MANIFEST, sha256: fileDigest(join(root, REFERENCE_MANIFEST)), purpose: 'original task identity and unchanged public runtime/model settings only; no old trajectory or score supplied to Actor' },
    lockRefs: { capabilities: { path: portable(relative(root, capabilities.path)), sha256: capabilities.sha256 } },
    runtimeSources: collectTemporalFrozenSources(root, protocol), tasks: [task],
    sourceFreezeCoverage: 'all work src/scripts; backend src; ARE/model/HTTP SDKs; actual Node/Python runtimes; Host loader/worker dependencies; package/protocol locks; plugin content-addressed snapshots',
    knownJudgeDefect: reference.knownJudgeDefect, originalCampaignModified: false }
  const manifest = { ...base, manifestHash: digest(base) }
  assertFrozen(root, manifest)
  const manifestPath = join(directory, 'manifest.json'); save(manifestPath, manifest)
  return { status: 'prepared_not_executed', runId, manifestPath: portable(manifestPath), originalTaskCount: 1, scenarioId: TARGET_ID }
}

function readEvents(output, task, session) {
  const path = join(output, 'runtime-events.jsonl')
  const events = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : []
  assert.ok(events.every(event => event.executionId === task.executionId && event.sessionId === session.sessionId))
  return events
}

function capturesAt(output) {
  const directory = join(output, 'model-evidence')
  return existsSync(directory) ? filesBelow(directory).filter(path => /hook-\d{6}-/.test(path)).map(readJson) : []
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
    conflictRecoveryResults: events.filter(event => event.type === 'conflict_recovery_completed') }
}

function semanticUsageFrom(events, captures) {
  const kinds = captures.map(item => item.request?.outcome?.semanticEvidence?.kind).filter(Boolean)
  return { actorModelRequests: events.filter(event => event.type === 'model_request').length,
    contractModelRequests: events.filter(event => event.type === 'task_contract_model_request').length,
    entityEvidenceCounts: Object.fromEntries(['delete_succeeded', 'entity_absent', 'entity_present'].map(kind => [kind, kinds.filter(value => value === kind).length])),
    taskSignals: events.filter(event => event.type === 'task_obligation_signaled'),
    taskStateCommits: events.filter(event => event.type === 'task_contract_committed').length }
}

async function executeOne({ root, manifest, connection, signal }) {
  const protocol = readJson(join(root, 'config/phase0-protocol.json'))
  const task = manifest.tasks[0]
  const taskRoot = join(root, manifest.runRoot, 'task-02')
  assert.ok(!existsSync(taskRoot), 'single task cannot silently rerun or resume')
  const output = join(taskRoot, 'output'), workspace = join(taskRoot, 'workspace'), datasetRoot = join(taskRoot, 'fixture')
  mkdirSync(output, { recursive: true }); mkdirSync(workspace); mkdirSync(join(datasetRoot, task.config), { recursive: true })
  const session = { sessionId: `task-02-${randomUUID().slice(0, 8)}`, outputDir: portable(relative(root, output)),
    workspaceDir: portable(relative(root, workspace)), fixtureDir: portable(relative(root, datasetRoot)) }
  // The official importer receives every original field, event, app and duration.
  save(join(datasetRoot, task.config, 'scenario.json'), fixtureFromScenario(await readOriginalScenario(root, task), task))
  const entry = writeOfficialEntryManifest({ root, manifest, task, session })
  const settings = manifest.settings
  const args = [join(root, 'scripts/temporal_official_entry.py'), 'run', '--dataset', datasetRoot, '--config', task.config,
    '--agent', 'default', '--model', manifest.models.actor.model, '--provider', resolveTransportProvider(manifest.models.actor.provider), '--endpoint', connection.baseUrl,
    '--judge_model', manifest.models.judge.model, '--judge_provider', resolveTransportProvider(manifest.models.judge.provider), '--judge_endpoint', connection.baseUrl,
    '--limit', '1', '--num_runs', '1', '--max_concurrent_scenarios', '1', '--scenario_timeout', String(settings.scenarioTimeoutSeconds),
    '--output_dir', output, '--trace_dump_format', 'both', '--log-level', 'INFO']
  let service, actor, host, runnerError = null
  try {
    service = await startRuntimeHookService({ root, manifest, task, session, settings, signal, entry,
      temporal: { enabled: true }, conflictRecovery: { enabled: true },
      ...(manifest.entitySemantics ? { entitySemantics: manifest.entitySemantics } : {}),
      ...(manifest.mutationReceipts ? { mutationReceipts: manifest.mutationReceipts } : {}) })
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|ACCESS_TOKEN|AUTHORIZATION|HF_TOKEN|HUGGINGFACE_TOKEN|GAIA2_HOOK_|GAIA2_A2A_|GAIA2_CORRECTION_|GAIA2_RETRIEVAL_|GAIA2_TEMPORAL_|GAIA2_CONFLICT_RECOVERY_|GAIA2_ENTITY_SEMANTICS_|GAIA2_TASK_CONTRACT_|GAIA2_MUTATION_RECEIPTS_|GAIA2_OFFICIAL_ENTRY_|GAIA2_MODEL_HTTP_GUARD_|GAIA2_E2E_)/i.test(key)))
    actor = await runChildProcess({ command: resolve(root, protocol.runtime.python), args, cwd: workspace, outputDir: output,
      processTimeoutMs: settings.processTimeoutMs, heartbeatIntervalMs: settings.heartbeatIntervalMs, signal,
      secrets: [connection.apiKey, service.token], env: { ...inherited, ...modelRuntimeEnvironment(settings), ...taskReconciliationEnvironment(),
        PYTHONPATH: resolve(root, protocol.runtime.officialPythonPath), PYTHONUTF8: '1', OPENAI_API_KEY: connection.apiKey,
        GAIA2_E2E_MINIMAL: '0', GAIA2_E2E_MAX_ACTIONS: String(settings.maxActions), GAIA2_E2E_TOOL_ALLOWLIST: '',
        GAIA2_E2E_ATTEMPT_INDEX: '0', GAIA2_E2E_CORRECTION_ORDINAL: '0',
        GAIA2_EXECUTION_ID: task.executionId, GAIA2_SESSION_ID: session.sessionId,
        GAIA2_RUNTIME_EVENT_FILE: join(output, 'runtime-events.jsonl'), GAIA2_HOOK_URL: service.endpoint, GAIA2_HOOK_TOKEN: service.token,
        GAIA2_OFFICIAL_ENTRY_REQUIRED: '1', GAIA2_OFFICIAL_ENTRY_PATH: entry.path, GAIA2_OFFICIAL_ENTRY_SHA256: entry.sha256,
        GAIA2_MODEL_HTTP_GUARD_REQUIRED: '1', GAIA2_TEMPORAL_ENABLED: '1', GAIA2_TEMPORAL_WORKSPACE: workspace,
        GAIA2_CONFLICT_RECOVERY_ENABLED: '1', GAIA2_CONFLICT_RECOVERY_WORKSPACE: workspace,
        ...(manifest.entitySemantics ? { GAIA2_ENTITY_SEMANTICS_ENABLED: '1', GAIA2_ENTITY_SEMANTICS_WORKSPACE: workspace } : {}),
        ...(manifest.mutationReceipts ? { GAIA2_MUTATION_RECEIPTS_ENABLED: '1', GAIA2_MUTATION_RECEIPTS_WORKSPACE: workspace } : {}),
        GAIA2_TEMPORAL_EVIDENCE_DIR: join(output, 'model-evidence'), TMP: workspace, TEMP: workspace, TMPDIR: workspace,
        HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', LITELLM_LOCAL_MODEL_COST_MAP: 'True', LITELLM_TELEMETRY: 'False' } })
  } catch (error) { runnerError = { code: 'official_one_execution_error', errorType: error?.name ?? 'Error' } }
  finally { if (service) host = await service.close() }
  let events = [], native = null, receiptError = null, temporalHostReceipts = [], conflictHostReceipts = [], semanticHostReceipts = [], semanticUsage = null
  try {
    events = readEvents(output, task, session)
    native = readNativeResult({ root, outputDir: session.outputDir, task, session, events })
  } catch { receiptError = 'native_result_or_events_invalid' }
  try {
    const captures = capturesAt(output)
    temporalHostReceipts = verifyTemporalReceipts({ root, workspace, executionId: task.executionId, sessionId: session.sessionId, captures })
    conflictHostReceipts = await verifyConflictReceipts({ root, workspace, executionId: task.executionId, sessionId: session.sessionId, captures })
    if (manifest.entitySemantics) {
      semanticHostReceipts = await verifyRuntimeSemanticReceipts({ root, workspace, executionId: task.executionId, sessionId: session.sessionId, captures })
      assert.equal(semanticHostReceipts.length, captures.length)
      assert.ok(semanticHostReceipts.length > 0)
      semanticUsage = semanticUsageFrom(events, captures)
    }
    assert.ok(temporalHostReceipts.length > 0 && conflictHostReceipts.length > 0)
  } catch { receiptError ??= 'host_controller_receipts_invalid' }
  const artifacts = filesBelow(taskRoot).map(path => ({ path: portable(relative(root, path)), sha256: fileDigest(path) }))
  const technicalError = runnerError?.code ?? receiptError ?? (!processClean(actor) ? 'actor_process_unclean' : !processClean(host) ? 'host_process_unclean' : native?.report.evaluationComplete !== true ? 'official_evaluation_incomplete' : null)
  const dispatchSafety = { actor: supervisionSafety(output, actor), host: supervisionSafety(join(output, 'hook-host'), host) }
  const taskReport = { schemaVersion: 'gaia2-conflict-recovery-original-one-task-report-v1', scenarioId: TARGET_ID,
    config: task.config, executionId: task.executionId, sessionId: session.sessionId, originalScenarioHash: task.scenarioHash,
    runNumber: 1, phase: 'standard', status: technicalError ? 'technical_error' : 'evaluated', technicalError, runnerError,
    native: native?.report ?? null, rawScore: native?.report?.score ?? null, officialSubmissionReady: false,
    knownJudgeDefect: manifest.knownJudgeDefect, modelInputCount: artifacts.filter(ref => /model-\d{6}-input\.json$/.test(ref.path)).length,
    modelOutputCount: artifacts.filter(ref => /model-\d{6}-output\.json$/.test(ref.path)).length,
    modelSdkAttempts: events.filter(event => event.type === 'model_request_attempt').length,
    controllerUsage: usageFrom(events), temporalHostReceipts, conflictHostReceipts,
    ...(manifest.entitySemantics ? { semanticHostReceipts, semanticUsage } : {}),
    actorProcess: actor ?? null, hostProcess: host ?? null, dispatchSafety,
    fatalSupervision: !dispatchSafety.actor.safeToDispatchNext || !dispatchSafety.host.safeToDispatchNext, artifacts }
  save(join(taskRoot, 'report.json'), taskReport)
  return taskReport
}

export async function runConflictOfficialOne({ root = ROOT, path, signal } = {}) {
  root = resolve(root)
  const manifest = loadPlan(root, path)
  assertRunnableOfficialOneProfile(manifest)
  assert.ok(!signal?.aborted)
  const startPath = join(root, manifest.runRoot, 'execution-start.json')
  assert.ok(!existsSync(startPath), 'prepared single task has already started; never resume or rerun it')
  save(startPath, { startedAt: new Date().toISOString(), manifestHash: manifest.manifestHash, taskCount: 1, scenarioId: TARGET_ID })
  let taskReport
  try { taskReport = await executeOne({ root, manifest, connection: readModelConnection(root, manifest.models), signal }) }
  catch (error) {
    const taskRoot = join(root, manifest.runRoot, 'task-02'), output = join(taskRoot, 'output')
    const dispatchSafety = { actor: supervisionSafety(output), host: supervisionSafety(join(output, 'hook-host')) }
    taskReport = { scenarioId: TARGET_ID, config: 'time', status: 'technical_error', technicalError: 'single_task_setup_or_verification_failed',
      errorType: error?.name ?? 'Error', rawScore: null, officialSubmissionReady: false, dispatchSafety,
      fatalSupervision: !dispatchSafety.actor.safeToDispatchNext || !dispatchSafety.host.safeToDispatchNext,
      artifacts: existsSync(taskRoot) ? filesBelow(taskRoot).map(path => ({ path: portable(relative(root, path)), sha256: fileDigest(path) })) : [] }
    save(join(taskRoot, 'runner-failure.json'), taskReport)
  }
  let frozenSourcesVerified = true
  try { assertFrozen(root, manifest) } catch { frozenSourcesVerified = false }
  const report = { schemaVersion: 'gaia2-conflict-recovery-official-one-report-v1', runId: manifest.runId,
    status: taskReport.fatalSupervision ? 'stopped_for_safety' : signal?.aborted ? 'interrupted' : 'completed',
    originalTaskCount: 1, tasksAttempted: 1, evaluatedCount: taskReport.status === 'evaluated' ? 1 : 0,
    technicalErrorCount: taskReport.status === 'technical_error' ? 1 : 0, rawPassedCount: taskReport.rawScore === 1 ? 1 : 0,
    syntheticFixtureOnly: false, officialSubmissionReady: false, knownJudgeDefect: manifest.knownJudgeDefect,
    originalCampaignModified: false, frozenSourcesVerified, taskReport }
  const reportPath = join(root, manifest.runRoot, 'report.json'); save(reportPath, report)
  return { ...report, reportPath: portable(reportPath) }
}

/** Historical manifests remain evidence, never authority to re-enable retired gates. */
export function assertRunnableOfficialOneProfile(manifest) {
  assert.equal(Object.hasOwn(manifest, 'taskContract'), false, 'retired task-contract manifests are verification-only; prepare a fresh thin runtime plan')
  if (manifest.entitySemantics) assert.equal(manifest.mode, THIN_RUNTIME_MODE)
  return true
}

export async function verifyConflictOfficialOne({ root = ROOT, path } = {}) {
  root = resolve(root)
  const manifest = loadPlan(root, path)
  const reportPath = join(root, manifest.runRoot, 'report.json'), report = readJson(reportPath)
  assert.equal(report.schemaVersion, 'gaia2-conflict-recovery-official-one-report-v1')
  assert.equal(report.runId, manifest.runId)
  assert.equal(report.originalTaskCount, 1); assert.equal(report.tasksAttempted, 1)
  assert.equal(report.officialSubmissionReady, false); assert.equal(report.syntheticFixtureOnly, false)
  assert.equal(report.originalCampaignModified, false); assert.equal(report.frozenSourcesVerified, true)
  const task = manifest.tasks[0], own = report.taskReport
  assert.equal(own.scenarioId, TARGET_ID)
  const taskRoot = join(root, manifest.runRoot, 'task-02'), output = join(taskRoot, 'output'), workspace = join(taskRoot, 'workspace')
  const ownPath = join(taskRoot, existsSync(join(taskRoot, 'report.json')) ? 'report.json' : 'runner-failure.json')
  assert.deepEqual(readJson(ownPath), own)
  assert.equal(own.fatalSupervision, !own.dispatchSafety.actor.safeToDispatchNext || !own.dispatchSafety.host.safeToDispatchNext)
  if (own.fatalSupervision) assert.equal(report.status, 'stopped_for_safety')
  for (const ref of own.artifacts) {
    const target = resolve(root, ref.path)
    assert.ok(within(taskRoot, target)); assert.equal(fileDigest(target), ref.sha256)
  }
  let fixtureIdentityVerified = false, nativeResultRevalidated = false, temporalReceiptsRevalidated = 0, conflictReceiptsRevalidated = 0, semanticReceiptsRevalidated = 0
  const fixturePath = join(taskRoot, 'fixture', task.config, 'scenario.json')
  if (existsSync(fixturePath)) {
    assert.deepEqual(readJson(fixturePath), fixtureFromScenario(await readOriginalScenario(root, task), task))
    fixtureIdentityVerified = true
  }
  if (own.executionId) {
    assert.equal(own.executionId, task.executionId); assert.equal(own.originalScenarioHash, task.scenarioHash)
    assert.equal(own.runNumber, 1); assert.equal(own.phase, 'standard')
    const session = { sessionId: own.sessionId }
    const events = readEvents(output, task, session)
    let native = null
    try { native = readNativeResult({ root, outputDir: portable(relative(root, output)), task, session, events }) }
    catch { assert.equal(own.native, null); assert.equal(own.status, 'technical_error') }
    if (native) {
      assert.deepEqual(native.report, own.native); assert.equal(native.report.score, own.rawScore)
      nativeResultRevalidated = true
    }
    const captures = capturesAt(output)
    const temporal = verifyTemporalReceipts({ root, workspace, executionId: task.executionId, sessionId: own.sessionId, captures })
    const conflict = await verifyConflictReceipts({ root, workspace, executionId: task.executionId, sessionId: own.sessionId, captures })
    assert.deepEqual(temporal, own.temporalHostReceipts); assert.deepEqual(conflict, own.conflictHostReceipts)
    temporalReceiptsRevalidated = temporal.length; conflictReceiptsRevalidated = conflict.length
    if (manifest.entitySemantics) {
      const semantic = await verifyRuntimeSemanticReceipts({ root, workspace, executionId: task.executionId, sessionId: own.sessionId, captures })
      assert.deepEqual(semantic, own.semanticHostReceipts)
      assert.deepEqual(semanticUsageFrom(events, captures), own.semanticUsage)
      semanticReceiptsRevalidated = semantic.length
    }
    assert.deepEqual(usageFrom(events), own.controllerUsage)
    assert.equal(own.modelInputCount, own.artifacts.filter(ref => /model-\d{6}-input\.json$/.test(ref.path)).length)
    assert.equal(own.modelOutputCount, own.artifacts.filter(ref => /model-\d{6}-output\.json$/.test(ref.path)).length)
    assert.equal(own.modelSdkAttempts, events.filter(event => event.type === 'model_request_attempt').length)
  }
  assert.equal(report.evaluatedCount, own.status === 'evaluated' ? 1 : 0)
  assert.equal(report.technicalErrorCount, own.status === 'technical_error' ? 1 : 0)
  assert.equal(report.rawPassedCount, own.rawScore === 1 ? 1 : 0)
  const verification = { schemaVersion: 'gaia2-conflict-recovery-official-one-verification-v1', runId: manifest.runId, status: 'verified',
    scenarioId: TARGET_ID, originalTaskCount: 1, completedSingleTask: report.status === 'completed', evaluatedCount: report.evaluatedCount,
    technicalErrorCount: report.technicalErrorCount, rawScore: own.rawScore, officialSubmissionReady: false,
    rawScoreReliabilityQualified: true, verifiedArtifactCount: own.artifacts.length, fixtureIdentityVerified, nativeResultRevalidated,
    temporalReceiptsRevalidated, conflictReceiptsRevalidated,
    ...(manifest.entitySemantics ? { semanticReceiptsRevalidated } : {}),
    report: { path: portable(relative(root, reportPath)), sha256: fileDigest(reportPath) } }
  const target = join(root, manifest.runRoot, 'verification.json')
  if (!existsSync(target)) save(target, verification)
  else assert.deepEqual(readJson(target), verification)
  return verification
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort())
  try {
    const args = parseConflictOfficialOneArgs(process.argv.slice(2))
    const result = args.mode === 'prepare' ? await prepareConflictOfficialOne() : args.mode === 'run'
      ? await runConflictOfficialOne({ path: args.path, signal: controller.signal }) : await verifyConflictOfficialOne({ path: args.path })
    console.log(JSON.stringify(args.mode === 'run' ? { status: result.status, scenarioId: TARGET_ID,
      tasksAttempted: 1, evaluatedCount: result.evaluatedCount, technicalErrorCount: result.technicalErrorCount,
      rawScore: result.taskReport.rawScore, reportPath: result.reportPath, officialSubmissionReady: false } : result))
    if (args.mode === 'run' && result.status !== 'completed') process.exitCode = 2
  } catch (error) { console.error(JSON.stringify({ status: 'failed', code: error?.code === 'official_one_public_configuration_changed' ? error.code : 'conflict_official_one_runner_failed',
    errorType: error?.name ?? 'Error', ...(Array.isArray(error?.configurationDifferences) ? { configurationDifferences: error.configurationDifferences } : {}) })); process.exitCode = 2 }
}
