/** Ten immutable original validation tasks; explicit prepare, then explicit run. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { canonicalScenarioHash } from '../src/phase0_dataset.mjs'
import { freezePluginSnapshot, inspectPluginResources } from '../src/phase0_inventory.mjs'
import { digest, fileDigest, readJson, within } from '../src/phase0_run.mjs'
import { readModelConnection, modelRuntimeEnvironment, taskReconciliationEnvironment, resolveModelRetrySettings, resolveTransportProvider, fixtureFromScenario, readNativeResult } from '../src/phase1_official.mjs'
import { resolveRuntimeSettings } from '../src/phase1_config.mjs'
import { writeOfficialEntryManifest } from '../src/phase1_official_entry.mjs'
import { runChildProcess } from '../src/phase1_process.mjs'
import { startRuntimeHookService } from '../src/phase3_hook_service.mjs'
import { ROOT, portable, processClean, save, filesBelow, temporalSources, verifyTemporalReceipts } from './temporal_e2e.mjs'

export const SELECTION = Object.freeze([['time', 6], ['adaptability', 2], ['execution', 1], ['search', 1]])
export const SELECTION_RULE = 'official validation Standard: first 6 time, first 2 adaptability, first 1 execution and first 1 search, native Parquet row order; IDs selected before reading selected data; no oracle, prompt, historic score or success-based filtering; 1 run each, no correction'
const CODE = /\.(?:[cm]?js|ts|json|py|pyd|dll|node|exe)$/i
/** Actual source bytes, not stale assertions from an old environment lock. */
export function collectTemporalFrozenSources(root, protocol) {
  const records = new Map()
  const add = (path, category) => {
    const absolute = resolve(path)
    const key = portable(relative(root, absolute))
    records.set(key, { path: key, sha256: fileDigest(absolute), category })
  }
  for (const subdir of ['src', 'scripts']) for (const path of filesBelow(join(root, subdir)).filter(path => CODE.test(path))) add(path, 'work-project-code')
  for (const path of filesBelow(join(protocol.runtime.backendRoot, 'src')).filter(path => CODE.test(path))) add(path, 'backend-code')
  for (const packageName of ['are', 'openai', 'litellm', 'httpx', 'httpcore', 'requests']) {
    for (const path of filesBelow(resolve(root, protocol.runtime.officialPythonPath, packageName)).filter(path => CODE.test(path))) add(path, `python-${packageName}`)
  }
  for (const packageName of ['tsx', 'esbuild', 'nunjucks', 'get-tsconfig', 'resolve-pkg-maps', '@esbuild/win32-x64']) {
    const directory = join(protocol.runtime.backendRoot, 'node_modules', packageName)
    if (existsSync(directory)) for (const path of filesBelow(directory).filter(path => CODE.test(path))) add(path, `node-${packageName}`)
  }
  for (const [path, category] of [[process.execPath, 'node-runtime'], [resolve(root, protocol.runtime.python), 'python-runtime'],
    [join(root, 'package-lock.json'), 'work-dependencies'], [join(protocol.runtime.backendRoot, 'package-lock.json'), 'backend-dependencies'],
    [join(root, 'config/phase0-protocol.json'), 'protocol'], [join(root, 'locks/dataset-lock.json'), 'dataset-lock'],
    [join(root, 'locks/environment-lock.json'), 'historical-environment-reference']]) add(path, category)
  return [...records.values()].sort((a, b) => a.path.localeCompare(b.path))
}
export function parseTemporalTenArgs(argv) {
  if (argv.length === 1 && argv[0] === '--prepare') return { mode: 'prepare' }
  if (argv.length === 2 && ['--run', '--verify'].includes(argv[0]) && argv[1] && !argv[1].startsWith('--')) return { mode: argv[0].slice(2), path: argv[1] }
  throw new Error('Usage: node scripts/temporal_official_ten.mjs --prepare | --run <manifest.json> | --verify <manifest.json>; no resume or old campaign')
}
export function unsafeProcessResult(result) {
  if (!result) return false
  if (result.manualInspectionRequired || result.supervisionDetached || result.terminationErrors?.length) return true
  const spawned = Number.isInteger(result.pid) && result.pid > 0
  return spawned && (result.childExited !== true || result.childClosed !== true)
}
/** A missing return is not proof that the child was never spawned. */
export function supervisionSafety(directory, returned = null) {
  const resultPath = join(directory, 'process-result.json')
  const reservationPath = join(directory, 'process-reservation.json')
  const heartbeatPath = join(directory, 'heartbeat.json')
  try {
    const result = returned ?? (existsSync(resultPath) ? readJson(resultPath) : null)
    if (result) return { safeToDispatchNext: !unsafeProcessResult(result),
      reason: unsafeProcessResult(result) ? 'process_not_proven_closed' : 'closed_or_confirmed_not_spawned',
      pid: result.pid ?? null, childExited: result.childExited === true, childClosed: result.childClosed === true }
    const reservation = existsSync(reservationPath) ? readJson(reservationPath) : null
    const heartbeat = existsSync(heartbeatPath) ? readJson(heartbeatPath) : null
    if (reservation || heartbeat) return { safeToDispatchNext: false, reason: 'spawn_reservation_without_terminal_receipt', pid: heartbeat?.pid ?? reservation?.pid ?? null }
    return { safeToDispatchNext: true, reason: 'no_process_was_reserved', pid: null }
  } catch { return { safeToDispatchNext: false, reason: 'malformed_supervision_evidence', pid: null } }
}
function assertFrozen(root, manifest) {
  const { manifestHash, ...base } = manifest
  assert.equal(digest(base), manifestHash)
  assert.equal(manifest.schemaVersion, 'gaia2-temporal-official-ten-manifest-v1')
  assert.match(manifest.runRoot, /^runs\/temporal-official-ten-[A-Za-z0-9-]+$/)
  assert.equal(manifest.runRoot, `runs/${manifest.runId}`)
  assert.equal(manifest.originalTaskCount, 10); assert.equal(manifest.syntheticFixtureOnly, false)
  assert.equal(manifest.selectionRule, SELECTION_RULE); assert.equal(manifest.officialSubmissionReady, false)
  assert.deepEqual(manifest.tasks.map(t => t.config), SELECTION.flatMap(([config, count]) => Array(count).fill(config)))
  for (const ref of [...manifest.sources, ...manifest.runtimeSources, ...manifest.dataset.files]) assert.equal(fileDigest(resolve(root, ref.path)), ref.sha256, `frozen source changed: ${ref.path}`)
  assert.equal(fileDigest(resolve(root, manifest.lockRefs.capabilities.path)), manifest.lockRefs.capabilities.sha256)
  assert.equal(typeof manifest.models.actor.model, 'string'); assert.ok(manifest.models.actor.model.length > 0)
  assert.equal(typeof manifest.models.judge.model, 'string'); assert.ok(manifest.models.judge.model.length > 0)
  for (const task of manifest.tasks) { assert.equal(task.phase, 'standard'); assert.equal(task.runNumber, 1); assert.equal(task.correctionOrdinal, 0) }
}
export async function prepareTemporalTen({ root = ROOT } = {}) {
  root = resolve(root)
  const protocol = readJson(join(root, 'config/phase0-protocol.json'))
  const datasetLock = readJson(join(root, 'locks/dataset-lock.json'))
  const dataset = datasetLock.datasets.submission
  assert.equal(dataset.id, protocol.datasets.submission.id); assert.equal(dataset.revision, protocol.datasets.submission.revision)
  assert.equal(dataset.split, 'validation')
  const runId = `temporal-official-ten-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`
  const runRoot = `runs/${runId}`, directory = join(root, runRoot)
  assert.ok(!existsSync(directory)); mkdirSync(directory)
  // Select by row number and IDs only. The complete selected JSON is read later solely to bind its immutable hash.
  const selections = [], datasetFiles = []
  for (const [config, count] of SELECTION) {
    const refs = dataset.files.filter(file => file.config === config).sort((a, b) => a.path.localeCompare(b.path))
    assert.ok(refs.length > 0)
    let remaining = count
    for (const ref of refs) {
      assert.equal(fileDigest(resolve(root, ref.path)), ref.sha256)
      const file = await asyncBufferFromFile(resolve(root, ref.path))
      const ids = await parquetReadObjects({ file, columns: ['scenario_id'], rowStart: 0, rowEnd: remaining, compressors })
      if (ids.length) datasetFiles.push({ path: ref.path, sha256: ref.sha256, config })
      ids.forEach((row, rowIndex) => selections.push({ config, scenarioId: row.scenario_id, sourcePath: ref.path, rowIndex }))
      remaining -= ids.length
      if (remaining === 0) break
    }
    assert.equal(remaining, 0, `not enough ${config} rows`)
  }
  assert.equal(selections.length, 10); assert.equal(new Set(selections.map(t => t.scenarioId)).size, 10)
  const selectionReceipt = save(join(directory, 'selection.json'), { schemaVersion: 'gaia2-temporal-selection-v1', selectionRule: SELECTION_RULE, selectedBeforeScenarioDataRead: true, selections })
  const tasks = []
  for (const [index, selected] of selections.entries()) {
    const file = await asyncBufferFromFile(resolve(root, selected.sourcePath))
    const [row] = await parquetReadObjects({ file, columns: ['scenario_id', 'data'], rowStart: selected.rowIndex, rowEnd: selected.rowIndex + 1, compressors })
    assert.equal(row.scenario_id, selected.scenarioId)
    const scenario = JSON.parse(row.data)
    assert.equal(scenario.metadata?.definition?.scenario_id, selected.scenarioId)
    tasks.push({ ...selected, executionId: `${runId}-task-${String(index + 1).padStart(2, '0')}`,
      scenarioVersion: scenario.version, scenarioHash: canonicalScenarioHash(scenario), runNumber: 1,
      attemptIndex: 0, correctionOrdinal: 0, phase: 'standard' })
  }
  const plugins = ['gaia2-runtime', 'gaia2-evaluation'].map(id => inspectPluginResources(freezePluginSnapshot({ root, id, sourceRoot: join(root, 'plugins', id) })))
  const capabilityRef = save(join(directory, 'capabilities.json'), { schemaVersion: 'gaia2-temporal-capabilities-v1', plugins })
  const sources = [...temporalSources(root), ...['config/phase0-protocol.json', 'locks/dataset-lock.json', 'src/phase1_official.mjs', 'src/phase1_official_entry.mjs', 'src/phase1_process.mjs']
    .map(path => ({ path, sha256: fileDigest(join(root, path)) }))]
  const runtimeSources = collectTemporalFrozenSources(root, protocol)
  const settings = { ...resolveRuntimeSettings({ protocol, entrypoint: 'pilot' }), modelRetry: resolveModelRetrySettings() }
  assert.equal(settings.minimal, false)
  const base = { schemaVersion: 'gaia2-temporal-official-ten-manifest-v1', runId, runRoot, mode: 'temporal_diagnostic',
    originalTaskCount: 10, syntheticFixtureOnly: false, officialSubmissionReady: false,
    selectionRule: SELECTION_RULE, selectionReceipt: { path: portable(relative(root, selectionReceipt.path)), sha256: selectionReceipt.sha256 },
    temporal: { enabled: true }, executionBinding: 'phase3_live_plugin_host_required', models: protocol.models, settings,
    dataset: { kind: 'submission', id: dataset.id, revision: dataset.revision, split: dataset.split, files: datasetFiles },
    lockRefs: { capabilities: { path: portable(relative(root, capabilityRef.path)), sha256: capabilityRef.sha256 } },
    knownJudgeDefect: 'ARE 1.2.0 Boolean marker case incompatibility retained unchanged; raw scores are diagnostic, not a corrected official result.',
    originalCampaignModified: false, tasks, sources, runtimeSources,
    sourceFreezeCoverage: 'all work src/scripts code; backend src; ARE/OpenAI/LiteLLM/HTTP SDK code; actual Node/Python executables; Host loader/worker dependencies and package locks; plugin trees frozen separately in capabilities' }
  const manifest = { ...base, manifestHash: digest(base) }
  assertFrozen(root, manifest)
  const path = join(directory, 'manifest.json'); save(path, manifest)
  return { runId, status: 'prepared_not_executed', originalTaskCount: 10, manifestPath: portable(path), taskIds: tasks.map(t => t.scenarioId) }
}
async function executeTask({ root, manifest, task, index, connection, signal }) {
  const protocol = readJson(join(root, 'config/phase0-protocol.json'))
  const sessionBase = join(root, manifest.runRoot, `task-${String(index + 1).padStart(2, '0')}`)
  assert.ok(!existsSync(sessionBase), 'task cannot silently rerun or resume')
  const output = join(sessionBase, 'output'), workspace = join(sessionBase, 'workspace'), datasetRoot = join(sessionBase, 'fixture')
  mkdirSync(output, { recursive: true }); mkdirSync(workspace); mkdirSync(join(datasetRoot, task.config), { recursive: true })
  const session = { sessionId: `task-${index + 1}-${randomUUID().slice(0, 8)}`, outputDir: portable(relative(root, output)),
    workspaceDir: portable(relative(root, workspace)), fixtureDir: portable(relative(root, datasetRoot)) }
  const file = await asyncBufferFromFile(resolve(root, task.sourcePath))
  const [row] = await parquetReadObjects({ file, columns: ['scenario_id', 'data'], rowStart: task.rowIndex, rowEnd: task.rowIndex + 1, compressors })
  assert.equal(row.scenario_id, task.scenarioId)
  const fixture = fixtureFromScenario(JSON.parse(row.data), task)
  save(join(datasetRoot, task.config, 'scenario.json'), fixture)
  const entry = writeOfficialEntryManifest({ root, manifest, task, session })
  const settings = manifest.settings
  const args = [join(root, 'scripts/temporal_official_entry.py'), 'run', '--dataset', datasetRoot, '--config', task.config,
    '--agent', 'default', '--model', manifest.models.actor.model, '--provider', resolveTransportProvider(manifest.models.actor.provider), '--endpoint', connection.baseUrl,
    '--judge_model', manifest.models.judge.model, '--judge_provider', resolveTransportProvider(manifest.models.judge.provider), '--judge_endpoint', connection.baseUrl,
    '--limit', '1', '--num_runs', '1', '--max_concurrent_scenarios', '1', '--scenario_timeout', String(settings.scenarioTimeoutSeconds),
    '--output_dir', output, '--trace_dump_format', 'both', '--log-level', 'INFO']
  let service, actor, host, runnerError
  try {
    service = await startRuntimeHookService({ root, manifest, task, session, settings, signal, entry, temporal: { enabled: true } })
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|ACCESS_TOKEN|AUTHORIZATION|HF_TOKEN|HUGGINGFACE_TOKEN|GAIA2_HOOK_|GAIA2_A2A_|GAIA2_CORRECTION_|GAIA2_RETRIEVAL_|GAIA2_TEMPORAL_|GAIA2_OFFICIAL_ENTRY_|GAIA2_MODEL_HTTP_GUARD_|GAIA2_E2E_TOOL_ALLOWLIST)/i.test(key)))
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
        GAIA2_TEMPORAL_EVIDENCE_DIR: join(output, 'temporal-evidence'), TMP: workspace, TEMP: workspace, TMPDIR: workspace,
        HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', LITELLM_LOCAL_MODEL_COST_MAP: 'True', LITELLM_TELEMETRY: 'False' } })
  } catch (error) { runnerError = { errorType: error?.name ?? 'Error', code: 'temporal_task_runner_error' } }
  finally { if (service) host = await service.close() }
  let events = [], native = null, receiptError = null, receipts = []
  try {
    const path = join(output, 'runtime-events.jsonl')
    if (existsSync(path)) events = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    assert.ok(events.every(e => e.executionId === task.executionId && e.sessionId === session.sessionId))
    native = readNativeResult({ root, outputDir: session.outputDir, task, session, events })
  } catch { receiptError = 'native_result_or_events_invalid' }
  try {
    const evidenceRoot = join(output, 'temporal-evidence')
    const captures = existsSync(evidenceRoot) ? filesBelow(evidenceRoot).filter(path => /hook-\d{6}-/.test(path)).map(readJson) : []
    receipts = verifyTemporalReceipts({ root, workspace, executionId: task.executionId, sessionId: session.sessionId, captures })
    assert.ok(receipts.length > 0)
  } catch { receiptError = receiptError ?? 'host_temporal_receipts_invalid' }
  const artifacts = [...filesBelow(output), ...filesBelow(workspace)].map(path => ({ path: portable(relative(root, path)), sha256: fileDigest(path) }))
  const modelInputs = artifacts.filter(ref => /model-\d{6}-input\.json$/.test(ref.path)).length
  const temporalEvents = events.filter(e => /temporal|wait_watch/.test(e.type ?? ''))
  const controllerSignals = events.filter(e => e.type === 'temporal_watch_completed')
  const watchStartedCount = events.filter(e => e.type === 'temporal_watch_started').length
  const watchCompletedCount = controllerSignals.length
  const nativeControllerCalls = events.filter(e => e.type === 'tool_call_completed' && e.dispatchSource === 'temporal_controller')
  const controllerNativeWaitCount = nativeControllerCalls.filter(e => e.canonicalName === 'SystemApp__wait_for_notification').length
  const controllerNativeScanCount = nativeControllerCalls.length - controllerNativeWaitCount
  const technicalError = runnerError?.code ?? receiptError ?? (!processClean(actor) ? 'actor_process_unclean' : !processClean(host) ? 'host_process_unclean' : native?.report.evaluationComplete !== true ? 'official_evaluation_incomplete' : null)
  const report = { schemaVersion: 'gaia2-temporal-original-task-report-v1', scenarioId: task.scenarioId, config: task.config,
    executionId: task.executionId, sessionId: session.sessionId, originalScenarioHash: task.scenarioHash, runNumber: 1,
    status: technicalError ? 'technical_error' : 'evaluated', technicalError, runnerError, native: native?.report ?? null,
    rawScore: native?.report?.score ?? null, knownJudgeDefect: manifest.knownJudgeDefect, officialSubmissionReady: false,
    modelInputCount: modelInputs, modelSdkAttempts: events.filter(e => e.type === 'model_request_attempt').length,
    controllerEventCount: temporalEvents.length, controllerEventCountIncludesInventoryAndBookkeeping: true,
    watchStartedCount, watchCompletedCount, controllerNativeWaitCount, controllerNativeScanCount,
    controllerActuallyUsed: watchStartedCount > 0, controllerSignals, hostReceipts: receipts,
    actorProcess: actor, hostProcess: host, artifacts,
    dispatchSafety: { actor: supervisionSafety(output, actor), host: supervisionSafety(join(output, 'hook-host'), host) } }
  report.fatalSupervision = !report.dispatchSafety.actor.safeToDispatchNext || !report.dispatchSafety.host.safeToDispatchNext
  save(join(sessionBase, 'report.json'), report)
  return report
}
export async function runTemporalTen({ root = ROOT, path, signal } = {}) {
  root = resolve(root); path = resolve(root, path)
  assert.ok(within(join(root, 'runs'), path)); const manifest = readJson(path); assertFrozen(root, manifest)
  assert.ok(!existsSync(join(root, manifest.runRoot, 'execution-start.json')), 'prepared plan has already started; do not resume or rerun implicitly')
  save(join(root, manifest.runRoot, 'execution-start.json'), { startedAt: new Date().toISOString(), manifestHash: manifest.manifestHash, taskCount: 10 })
  const connection = readModelConnection(root, manifest.models), reports = []
  let safetyStop = false
  for (const [index, task] of manifest.tasks.entries()) {
    if (signal?.aborted) break
    assertFrozen(root, manifest)
    console.log(JSON.stringify({ status: 'running', task: index + 1, taskCount: 10, scenarioId: task.scenarioId, config: task.config }))
    let report
    try { report = await executeTask({ root, manifest, task, index, connection, signal }) }
    catch (error) {
      const taskOutput = join(root, manifest.runRoot, `task-${String(index + 1).padStart(2, '0')}`, 'output')
      const dispatchSafety = { actor: supervisionSafety(taskOutput), host: supervisionSafety(join(taskOutput, 'hook-host')) }
      report = { scenarioId: task.scenarioId, config: task.config, status: 'technical_error', technicalError: 'task_setup_or_verification_failed', errorType: error?.name ?? 'Error', officialSubmissionReady: false, artifacts: [], dispatchSafety,
        fatalSupervision: !dispatchSafety.actor.safeToDispatchNext || !dispatchSafety.host.safeToDispatchNext }
      const failurePath = join(root, manifest.runRoot, `task-${String(index + 1).padStart(2, '0')}`, 'runner-failure.json')
      if (!existsSync(failurePath)) save(failurePath, report)
    }
    reports.push(report)
    console.log(JSON.stringify({ status: report.status, task: index + 1, scenarioId: task.scenarioId, rawScore: report.rawScore ?? null, technicalError: report.technicalError, controllerEventCount: report.controllerEventCount ?? 0 }))
    if (report.fatalSupervision) { safetyStop = true; break }
  }
  const evaluated = reports.filter(r => r.status === 'evaluated')
  const report = { schemaVersion: 'gaia2-temporal-official-ten-report-v1', runId: manifest.runId,
    status: safetyStop ? 'stopped_for_safety' : reports.length === 10 ? 'completed' : 'interrupted',
    stopReason: safetyStop ? 'unresolved_process_supervision_no_further_dispatch' : signal?.aborted ? 'user_or_process_interrupt' : null,
    originalTaskCount: 10, tasksAttempted: reports.length,
    evaluatedCount: evaluated.length, technicalErrorCount: reports.filter(r => r.status === 'technical_error').length,
    rawPassedCount: evaluated.filter(r => r.rawScore === 1).length, syntheticFixtureOnly: false, officialSubmissionReady: false,
    knownJudgeDefect: manifest.knownJudgeDefect, originalCampaignModified: false, reports }
  const reportPath = join(root, manifest.runRoot, 'report.json'); save(reportPath, report)
  return { ...report, reportPath: portable(reportPath) }
}
export async function verifyTemporalTen({ root = ROOT, path } = {}) {
  root = resolve(root); const manifest = readJson(resolve(root, path)); assertFrozen(root, manifest)
  const reportPath = join(root, manifest.runRoot, 'report.json'); const report = readJson(reportPath)
  assert.equal(report.runId, manifest.runId); assert.equal(report.officialSubmissionReady, false)
  assert.equal(report.reports.length, report.tasksAttempted)
  assert.ok(report.tasksAttempted <= 10)
  assert.equal(new Set(report.reports.map(task => task.scenarioId)).size, report.tasksAttempted)
  let verifiedArtifactCount = 0
  let nativeResultsRevalidated = 0, hostReceiptsRevalidated = 0, fixtureIdentitiesRevalidated = 0
  for (const [index, taskReport] of report.reports.entries()) {
    const task = manifest.tasks[index]
    assert.equal(taskReport.scenarioId, task.scenarioId); assert.equal(taskReport.config, task.config)
    const taskRoot = join(root, manifest.runRoot, `task-${String(index + 1).padStart(2, '0')}`)
    const ownReportPath = join(taskRoot, existsSync(join(taskRoot, 'report.json')) ? 'report.json' : 'runner-failure.json')
    assert.deepEqual(readJson(ownReportPath), taskReport)
    assert.equal(taskReport.fatalSupervision, !taskReport.dispatchSafety.actor.safeToDispatchNext || !taskReport.dispatchSafety.host.safeToDispatchNext)
    if (taskReport.fatalSupervision) { assert.equal(index, report.reports.length - 1); assert.equal(report.status, 'stopped_for_safety') }
    for (const ref of taskReport.artifacts ?? []) {
      const target = resolve(root, ref.path)
      assert.ok(within(join(root, manifest.runRoot), target)); assert.equal(fileDigest(target), ref.sha256)
      verifiedArtifactCount += 1
    }
    const fixturePath = join(taskRoot, 'fixture', task.config, 'scenario.json')
    if (existsSync(fixturePath)) {
      const file = await asyncBufferFromFile(resolve(root, task.sourcePath))
      const [row] = await parquetReadObjects({ file, columns: ['scenario_id', 'data'], rowStart: task.rowIndex, rowEnd: task.rowIndex + 1, compressors })
      assert.equal(row.scenario_id, task.scenarioId)
      assert.deepEqual(readJson(fixturePath), fixtureFromScenario(JSON.parse(row.data), task))
      fixtureIdentitiesRevalidated += 1
    }
    if (taskReport.executionId) {
      assert.equal(taskReport.executionId, task.executionId); assert.equal(taskReport.originalScenarioHash, task.scenarioHash)
      assert.equal(taskReport.runNumber, 1)
      const output = join(taskRoot, 'output'), workspace = join(taskRoot, 'workspace')
      const eventPath = join(output, 'runtime-events.jsonl')
      const events = existsSync(eventPath) ? readFileSync(eventPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : []
      let native = null
      try { native = readNativeResult({ root, outputDir: portable(relative(root, output)), task, session: { sessionId: taskReport.sessionId }, events }) }
      catch { assert.equal(taskReport.native, null); assert.equal(taskReport.status, 'technical_error') }
      if (native) {
        assert.deepEqual(native.report, taskReport.native)
        assert.equal(native.report.score, taskReport.rawScore)
        nativeResultsRevalidated += 1
      }
      const evidenceRoot = join(output, 'temporal-evidence')
      const captures = existsSync(evidenceRoot) ? filesBelow(evidenceRoot).filter(path => /hook-\d{6}-/.test(path)).map(readJson) : []
      const rebuilt = verifyTemporalReceipts({ root, workspace, executionId: task.executionId, sessionId: taskReport.sessionId, captures })
      assert.deepEqual(rebuilt, taskReport.hostReceipts)
      hostReceiptsRevalidated += rebuilt.length
      assert.equal(taskReport.watchStartedCount, events.filter(e => e.type === 'temporal_watch_started').length)
      assert.deepEqual(taskReport.controllerSignals, events.filter(e => e.type === 'temporal_watch_completed'))
    }
  }
  const evaluated = report.reports.filter(task => task.status === 'evaluated')
  assert.equal(report.evaluatedCount, evaluated.length)
  assert.equal(report.technicalErrorCount, report.reports.filter(task => task.status === 'technical_error').length)
  assert.equal(report.rawPassedCount, evaluated.filter(task => task.rawScore === 1).length)
  const result = { schemaVersion: 'gaia2-temporal-official-ten-verification-v1', runId: manifest.runId, status: 'verified',
    completedAllTen: report.tasksAttempted === 10 && report.status === 'completed', evaluatedCount: report.evaluatedCount,
    technicalErrorCount: report.technicalErrorCount, rawPassedCount: report.rawPassedCount,
    officialSubmissionReady: false, rawScoreReliabilityQualified: true, verifiedArtifactCount,
    nativeResultsRevalidated, hostReceiptsRevalidated, fixtureIdentitiesRevalidated,
    controllerUsedTaskCount: report.reports.filter(task => task.controllerActuallyUsed).length,
    report: { path: portable(relative(root, reportPath)), sha256: fileDigest(reportPath) } }
  const target = join(root, manifest.runRoot, 'verification.json')
  if (!existsSync(target)) save(target, result)
  else assert.deepEqual(readJson(target), result)
  return result
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort())
  try {
    const args = parseTemporalTenArgs(process.argv.slice(2))
    const result = args.mode === 'prepare' ? await prepareTemporalTen() : args.mode === 'run' ? await runTemporalTen({ path: args.path, signal: controller.signal }) : await verifyTemporalTen({ path: args.path })
    console.log(JSON.stringify(args.mode === 'run' ? { status: result.status, tasksAttempted: result.tasksAttempted, evaluatedCount: result.evaluatedCount, technicalErrorCount: result.technicalErrorCount, rawPassedCount: result.rawPassedCount, reportPath: result.reportPath, officialSubmissionReady: false } : result))
    if (args.mode === 'run' && result.status !== 'completed') process.exitCode = 2
  } catch (error) { console.error(JSON.stringify({ status: 'failed', code: 'temporal_ten_runner_failed', errorType: error?.name ?? 'Error' })); process.exitCode = 2 }
}
