import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { digest, fileDigest, readJson, within } from '../src/phase0_run.mjs'

const root = dirname(dirname(new URL(import.meta.url).pathname.replace(/^\/[A-Za-z]:/, match => match.slice(1))))
const STATUSES = new Set(['pending', 'running', 'completed', 'retry_pending', 'terminal_failure'])

function portable(value) { return String(value).replaceAll('\\', '/') }
function issue(errors, code, executionId = null, detail = null) { errors.push({ code, executionId, ...(detail ? { detail } : {}) }) }
function parseArgs(argv) {
  const values = {}
  const allowed = new Set(['--manifest', '--output', '--export-dir'])
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index], value = argv[index + 1]
    if (!allowed.has(flag) || !value || value.startsWith('--') || Object.hasOwn(values, flag)) throw new Error('usage: phase6-result-audit --manifest <path> [--output <path>] [--export-dir <dir>]')
    values[flag] = value
    index += 1
  }
  if (!values['--manifest']) throw new Error('manifest is required')
  return values
}

function resolveInside(base, value) {
  if (typeof value !== 'string' || !value || isAbsolute(value)) return null
  const target = resolve(root, value)
  return within(base, target) && target !== resolve(base) ? target : null
}

function validateSession(errors, manifest, task, session, index) {
  const id = task.executionId
  if (!session || typeof session !== 'object') { issue(errors, 'invalid_session', id, index); return }
  if (session.sessionOrdinal !== index + 1 || session.parentSessionId !== (index ? task.__sessions[index - 1]?.sessionId ?? null : null)) issue(errors, 'session_lineage_invalid', id, index)
  if (typeof session.sessionId !== 'string' || !/^\d{4}-[0-9a-f-]{12}$/.test(session.sessionId)) issue(errors, 'session_id_invalid', id, index)
  for (const key of ['outputDir', 'fixtureDir', 'workspaceDir']) {
    const expected = portable(join(task[key], 'sessions', session.sessionId))
    if (portable(session[key]) !== expected) issue(errors, 'session_path_mismatch', id, `${key}:${index}`)
    if (!resolveInside(resolve(root, manifest.runRoot), session[key])) issue(errors, 'session_path_escape', id, `${key}:${index}`)
  }
}

function validateResult(errors, manifest, task, record, session) {
  const id = task.executionId
  if (!record.resultPath || typeof record.resultSha256 !== 'string') { issue(errors, 'result_reference_missing', id); return null }
  const path = resolveInside(resolve(root, manifest.runRoot), record.resultPath)
  if (!path || !existsSync(path)) { issue(errors, 'result_missing', id); return null }
  let result
  try { result = readJson(path) } catch { issue(errors, 'result_json_invalid', id); return null }
  try { if (fileDigest(path) !== record.resultSha256) issue(errors, 'result_hash_mismatch', id) } catch { issue(errors, 'result_unreadable', id); return null }
  for (const [key, expected] of [['schemaVersion', 'gaia2-task-result-v1'], ['runId', manifest.runId], ['manifestHash', manifest.manifestHash], ['executionId', id], ['scenarioId', task.scenarioId], ['runNumber', task.runNumber], ['phase', task.phase], ['config', task.config]]) {
    if (result[key] !== expected) issue(errors, 'result_identity_mismatch', id, key)
  }
  if (result.evaluationComplete === true && typeof result.businessPassed !== 'boolean') issue(errors, 'judgment_invalid', id)
  return result
}

export function auditPhase6Run({ manifest, state = null, exportManifest = null } = {}) {
  const errors = []
  if (!manifest || manifest.schemaVersion !== 'gaia2-run-manifest-v1' || !Array.isArray(manifest.tasks)) return { schemaVersion: 'gaia2-phase6-result-audit-v1', status: 'rejected', errors: [{ code: 'manifest_invalid' }], noModelExecution: true }
  const expectedIds = manifest.tasks.map(task => task.executionId)
  const records = state?.tasks ?? []
  if (state !== null) {
    for (const [key, expected] of [['schemaVersion', 'gaia2-run-state-v1'], ['runId', manifest.runId], ['manifestHash', manifest.manifestHash]]) if (state[key] !== expected) issue(errors, 'state_binding_mismatch', null, key)
    if (!Array.isArray(state.tasks) || digest(records.map(item => item?.executionId)) !== digest(expectedIds)) issue(errors, 'state_task_set_mismatch')
    const runtimePath = resolve(root, manifest.runRoot, 'runtime-settings.json')
    let runtime = null
    try { runtime = existsSync(runtimePath) ? readJson(runtimePath) : null } catch { runtime = null }
    // phase1_runner binds runtimeHash to the canonical settings value, not
    // to the raw file bytes; use the same digest rule during read-only audit.
    if (!state.runtimeHash || runtime === null || digest(runtime) !== state.runtimeHash) issue(errors, 'runtime_binding_mismatch')
  }
  const byId = new Map(records.map(record => [record?.executionId, record]))
  const rows = []
  for (const task of manifest.tasks) {
    const record = byId.get(task.executionId) ?? { executionId: task.executionId, status: 'pending', sessions: [], resultPath: null, resultSha256: null, failure: null }
    const status = record.status
    if (!STATUSES.has(status)) issue(errors, 'state_status_invalid', task.executionId, status)
    const sessions = Array.isArray(record.sessions) ? record.sessions : []
    if (!Array.isArray(record.sessions)) issue(errors, 'session_list_invalid', task.executionId)
    if (status === 'pending' && sessions.length !== 0) issue(errors, 'pending_has_sessions', task.executionId)
    if (status !== 'pending' && sessions.length === 0) issue(errors, 'used_task_has_no_session', task.executionId)
    const taskForSession = { ...task, __sessions: sessions }
    sessions.forEach((session, index) => validateSession(errors, manifest, taskForSession, session, index))
    const session = sessions.at(-1)
    const result = session ? validateResult(errors, manifest, task, record, session) : null
    if (status === 'completed' && (!result || result.evaluationComplete !== true || typeof result.businessPassed !== 'boolean')) issue(errors, 'completed_without_judgment', task.executionId)
    if (status === 'terminal_failure' && (record.failure?.retryable !== false || record.failure?.category === 'business_failure')) issue(errors, 'terminal_failure_invalid', task.executionId)
    const outcome = status === 'completed' ? (result?.businessPassed === true ? 'business_success' : 'business_failure') : status
    rows.push({ executionId: task.executionId, phase: task.phase, config: task.config, scenarioId: task.scenarioId, runNumber: task.runNumber, status, outcome, sessionCount: sessions.length, resultPath: record.resultPath ?? null })
  }
  const counts = Object.fromEntries([...STATUSES].map(status => [status, rows.filter(row => row.status === status).length]))
  const outcomeCounts = { business_success: rows.filter(row => row.outcome === 'business_success').length, business_failure: rows.filter(row => row.outcome === 'business_failure').length }
  const exportedIds = new Set(Array.isArray(exportManifest?.records) ? exportManifest.records.map(record => record?.executionId).filter(Boolean) : [])
  const missingExportIds = exportManifest ? expectedIds.filter(id => !exportedIds.has(id)) : []
  const report = {
    schemaVersion: 'gaia2-phase6-result-audit-v1', status: errors.length ? 'rejected' : 'audited', runId: manifest.runId, manifestHash: manifest.manifestHash,
    plannedInitialExecutions: manifest.tasks.length, statePresent: state !== null, counts, outcomes: outcomeCounts,
    export: exportManifest ? { records: exportedIds.size, missingExecutions: missingExportIds.length, missingExecutionIds: missingExportIds } : null,
    rows, errors, noModelExecution: true, officialSubmissionReady: false,
    canProceedToNextBatch: errors.length === 0 && counts.pending === 0 && counts.running === 0 && counts.retry_pending === 0 && counts.terminal_failure === 0,
  }
  return report
}

export function runAudit({ manifestPath, outputPath = null, exportDir = null } = {}) {
  const manifest = readJson(manifestPath)
  const statePath = resolve(root, manifest.stateFile)
  const state = existsSync(statePath) ? readJson(statePath) : null
  let exportManifest = null
  if (exportDir) {
    const exportPath = resolve(root, exportDir, 'export-manifest.json')
    if (!existsSync(exportPath)) throw new Error('export-manifest.json is missing')
    exportManifest = readJson(exportPath)
  }
  const report = auditPhase6Run({ manifest, state, exportManifest })
  if (outputPath) writeFileSync(resolve(root, outputPath), `${JSON.stringify(report, null, 2)}\n`)
  return report
}

if (process.argv[1] && process.argv[1].endsWith('phase6_result_audit.mjs')) {
  try {
    const values = parseArgs(process.argv.slice(2))
    const report = runAudit({ manifestPath: resolve(root, values['--manifest']), outputPath: values['--output'], exportDir: values['--export-dir'] })
    console.log(JSON.stringify(report, null, 2))
    if (report.status === 'rejected') process.exitCode = 2
  } catch (error) {
    console.error(JSON.stringify({ schemaVersion: 'gaia2-phase6-result-audit-v1', status: 'configuration_error', error: String(error?.message ?? error).slice(0, 240), noModelExecution: true }, null, 2))
    process.exitCode = 2
  }
}
