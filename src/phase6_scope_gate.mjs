import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { digest, fileDigest, readJson, within } from './phase0_run.mjs'
import { packagePath, validateExportPlan } from './phase2_export.mjs'
import { auditSubmissionPackage } from './phase2_audit.mjs'
import { readNativeResult } from './phase1_official.mjs'
import { validateRuntimeEvidence } from './phase3_runtime_evidence.mjs'
import { auditPhase6Run } from '../scripts/phase6_result_audit.mjs'
import { selectPhase6ExecutionIds, selectionIdentityHash } from './phase6_selection.mjs'

const HASH = /^[a-f0-9]{64}$/
const portable = path => path.replaceAll('\\', '/')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const bindingKeys = ['runId', 'manifestHash', 'planFingerprint', 'runtimeHash', 'selectionIdentityHash']
const withoutTime = value => { const { generatedAt, ...contents } = value; return contents }
const identity = task => ({ executionId: task.executionId, phase: task.phase, config: task.config, scenarioId: task.scenarioId, runNumber: task.runNumber })

/** Pure contract comparison after source/results/export have been verified. */
export function phase6ScopeEvidenceErrors({ binding, executionIds, sourceRefs, budget, recomputedBudget, http, verifiedHttp }) {
  if (!object(binding) || !Array.isArray(executionIds) || executionIds.length === 0 || !object(sourceRefs)) return ['scope_contract_invalid']
  const errors = [], check = (condition, code) => { if (!condition) errors.push(code) }
  const same = (a, b) => digest(a ?? null) === digest(b ?? null)
  check(budget?.schemaVersion === 'gaia2-phase6-budget-report-v1' && budget.status === 'audited' && digest(Object.fromEntries(bindingKeys.map(key => [key, budget?.binding?.[key]]))) === digest(binding), 'budget_binding_mismatch')
  check(same(budget?.scope?.executionIds, executionIds) && budget?.scope?.selectedExecutions === executionIds.length && budget?.scope?.scopeExecutionComplete === true, 'budget_scope_mismatch')
  for (const key of ['manifest', 'state', 'runtime']) check(same(budget?.binding?.[key], sourceRefs[key]), 'budget_source_snapshot_mismatch')
  check(object(budget) && object(recomputedBudget) && digest(withoutTime(budget)) === digest(withoutTime(recomputedBudget)), 'budget_recomputation_mismatch')
  check(verifiedHttp?.status === 'passed' && same(verifiedHttp?.binding, binding) && same(verifiedHttp?.scope?.executionIds, executionIds), 'production_http_scope_invalid')
  check(object(http) && object(verifiedHttp) && digest(withoutTime(http)) === digest(withoutTime(verifiedHttp)), 'production_http_recomputation_mismatch')
  return errors
}

/** Selected-scope acceptance is NOT whole-package or financial readiness.
 * All evidence is read-only; official conversion must already have completed.
 */
export async function auditPhase6Scope({ root, manifest, state = null, selection = {}, exportDir, exportReportRef, budgetRef, productionHttpRef, verifyProductionHttpEvidence = null, recomputeBudget = null } = {}) {
  root = resolve(root)
  const errors = [], selectedRows = [], sourceRefs = {}
  let ids = [], binding = null, exportAudit = null, budget = null, http = null
  const check = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { scopeGateCode: code }) }
  const file = path => {
    check(typeof path === 'string' && path, 'evidence_path_invalid')
    const target = isAbsolute(path) ? resolve(path) : resolve(root, path)
    check(within(root, target) && target !== root, 'evidence_path_escape')
    const checked = packagePath(root, portable(relative(root, target)))
    check(existsSync(checked) && lstatSync(checked).isFile(), 'evidence_file_missing')
    return checked
  }
  const readRef = (ref, label) => {
    check(object(ref) && Object.keys(ref).length === 2 && typeof ref.path === 'string' && HASH.test(ref.sha256 ?? ''), `${label}_reference_invalid`)
    const path = file(ref.path)
    check(fileDigest(path) === ref.sha256, `${label}_reference_hash_mismatch`)
    return readJson(path)
  }
  const refFor = path => ({ path: portable(relative(root, path)), sha256: fileDigest(path) })
  const healthy = value => value?.schemaVersion === 'gaia2-process-result-v1' && value.exitCode === 0 && value.childExited === true && value.childClosed === true
    && value.supervisionDetached === false && value.manualInspectionRequired === false && !value.signal && !value.timedOut && !value.interrupted && !value.spawnError && !value.loggingError && !value.heartbeatError
    && Array.isArray(value.terminationErrors) && value.terminationErrors.length === 0 && value.processIdentity?.verified === true
  try {
    check(object(selection) && Object.keys(selection).every(key => ['executionIds', 'onlyPhase', 'onlyRunNumber', 'rule'].includes(key)), 'selection_fields_invalid')
    validateExportPlan(root, manifest)
    ids = selectPhase6ExecutionIds(manifest, selection)
    const manifestPath = file(join(manifest.runRoot, 'run-manifest.json'))
    check(digest(readJson(manifestPath)) === digest(manifest), 'source_manifest_mismatch')
    const statePath = file(manifest.stateFile), runtimePath = file(join(manifest.runRoot, 'runtime-settings.json'))
    const actualState = readJson(statePath)
    check(state === null || digest(state) === digest(actualState), 'source_state_mismatch')
    state = actualState
    const runtime = readJson(runtimePath)
    check(digest(runtime) === state.runtimeHash, 'runtime_binding_mismatch')
    const stateAudit = auditPhase6Run({ root, manifest, state })
    check(stateAudit.errors.length === 0, 'state_ledger_invalid')
    sourceRefs.manifest = refFor(manifestPath); sourceRefs.state = refFor(statePath); sourceRefs.runtime = refFor(runtimePath)
    binding = { runId: manifest.runId, manifestHash: manifest.manifestHash, planFingerprint: manifest.planFingerprint, runtimeHash: state.runtimeHash, selectionIdentityHash: selectionIdentityHash(manifest, ids) }
    const selected = new Set(ids), tasks = manifest.tasks.filter(task => selected.has(task.executionId)), byId = new Map(state.tasks.map(record => [record.executionId, record]))
    for (const task of tasks) {
      const record = byId.get(task.executionId)
      check(record?.status === 'completed', `selected_not_completed:${task.executionId}`)
      const session = record.sessions.at(-1), resultPath = file(record.resultPath), result = readJson(resultPath)
      check(fileDigest(resultPath) === record.resultSha256, `selected_result_changed:${task.executionId}`)
      check(result.evaluationComplete === true && result.realHooksReady === true && typeof result.businessPassed === 'boolean' && result.score === (result.businessPassed ? 1 : 0), `selected_judgment_or_hooks_invalid:${task.executionId}`)
      check(result.runtimeAttestation?.modelHttpDispatchRequired === true, `production_http_guard_not_required:${task.executionId}`)
      const events = readFileSync(file(join(session.outputDir, 'runtime-events.jsonl')), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
      const hooks = validateRuntimeEvidence({ manifest, task, session, events, runtimeAttestation: result.runtimeAttestation, runtimeEvidence: result.runtimeEvidence, nativeProcessSourceBytes: readFileSync(file(join(session.outputDir, 'process-result.json'))), readEvidence: path => readFileSync(file(path)) })
      check(hooks.realHooksReady === true, `selected_hooks_unverified:${task.executionId}`)
      check(healthy(readJson(file(join(session.outputDir, 'process-result.json')))) && healthy(readJson(file(result.runtimeAttestation.hostProcessPath))), `selected_process_cleanup_invalid:${task.executionId}`)
      const native = readNativeResult({ root, outputDir: session.outputDir, task, session, events })
      check(native.report.evaluationComplete && native.report.businessPassed === result.businessPassed && digest(native.artifacts) === digest(result.artifacts), `selected_native_result_mismatch:${task.executionId}`)
      selectedRows.push({ ...identity(task), sessionId: session.sessionId, score: result.score, result: refFor(resultPath), realHooksReady: true })
    }
    const packageRoot = resolve(root, exportDir)
    check(within(root, packageRoot) && packageRoot !== root, 'export_directory_escape')
    const sidecar = readJson(file(join(packageRoot, 'export-manifest.json')))
    check(sidecar.evidenceKind === 'native_runtime' && sidecar.syntheticFixtureOnly === false && sidecar.sourceRunId === manifest.runId && sidecar.manifestHash === manifest.manifestHash && sidecar.runtimeHash === state.runtimeHash, 'export_binding_mismatch')
    check(Array.isArray(sidecar.records) && sidecar.records.length === ids.length && new Set(sidecar.records.map(row => row.executionId)).size === ids.length, 'export_selected_identity_set_mismatch')
    const expected = new Map(selectedRows.map(row => [row.executionId, row]))
    for (const row of sidecar.records) {
      const wanted = expected.get(row.executionId)
      check(wanted && digest(identity(row)) === digest(identity(wanted)) && row.sessionId === wanted.sessionId && row.result?.sha256 === wanted.result.sha256, 'export_selected_identity_set_mismatch')
    }
    check(sidecar.state?.sha256 === sourceRefs.state.sha256 && sidecar.sourceManifest?.sha256 === sourceRefs.manifest.sha256 && sidecar.runtimeSettings?.sha256 === sourceRefs.runtime.sha256, 'export_source_snapshot_mismatch')
    const exportReport = readRef(exportReportRef, 'export_report')
    check(resolve(exportReport.packageRoot) === packageRoot && exportReport.sourceRunId === manifest.runId && exportReport.exportedRows === ids.length && exportReport.noModelExecution === true, 'export_report_binding_mismatch')
    exportAudit = auditSubmissionPackage({ packageRoot, officialCheck: exportReport.officialCheck })
    check(exportAudit.format_valid === true && exportAudit.officialCheckPassed === true && exportAudit.metrics.rowCount === ids.length && exportAudit.metrics.evaluatedRows === ids.length && exportAudit.metrics.realHookRows === ids.length
      && exportAudit.issues.filter(issue => issue.gate !== 'coverage').length === 0, 'strict_selected_export_failed')
    budget = readRef(budgetRef, 'budget')
    const budgetBuilder = recomputeBudget ?? (await import('./phase6_budget.mjs')).buildPhase6BudgetReport
    check(typeof budgetBuilder === 'function', 'budget_recomputation_unavailable')
    const recomputedBudget = await budgetBuilder({ root, manifestPath, executionIds: ids, exportDir: budget.export?.package?.directory ?? null, healthReportPaths: (budget.healthChecks?.records ?? []).map(record => record.source.path) })
    http = readRef(productionHttpRef, 'production_http')
    const httpVerifier = verifyProductionHttpEvidence ?? (await import('./phase6_http_evidence.mjs')).verifyPhase6HttpScope
    check(typeof httpVerifier === 'function', 'production_http_verifier_unavailable')
    const verifiedHttp = await httpVerifier({ root, manifest, state, executionIds: ids })
    const contractErrors = phase6ScopeEvidenceErrors({ binding, executionIds: ids, sourceRefs, budget, recomputedBudget, http, verifiedHttp })
    check(contractErrors.length === 0, contractErrors[0])
    check(fileDigest(statePath) === sourceRefs.state.sha256, 'state_changed_during_scope_audit')
  } catch (error) {
    // A malformed evidence file can contain secrets. Never echo JSON parser
    // snippets or arbitrary callback exceptions in the public gate report.
    const helperCode = typeof error?.message === 'string' && /^Phase (?:6 selection|3 runtime evidence): [a-z0-9_]+$/.test(error.message) ? error.message.split(': ').at(-1) : null
    errors.push({ code: error?.scopeGateCode ?? helperCode ?? 'scope_evidence_read_or_validation_failed' })
  }
  return {
    schemaVersion: 'gaia2-phase6-scope-gate-v1', status: errors.length ? 'rejected' : 'accepted', binding, selection, scope: { executionIds: ids, selectedExecutions: ids.length, validatedExecutions: selectedRows.length },
    sourceRefs, evidenceRefs: { exportReport: exportReportRef ?? null, budget: budgetRef ?? null, productionHttp: productionHttpRef ?? null }, selectedRows,
    scopeAcceptancePassed: errors.length === 0, wholePackageCoverageComplete: exportAudit?.coverage_complete ?? false,
    wholePackageEvaluationComplete: exportAudit?.evaluation_complete ?? false, officialSubmissionReady: false,
    budgetAccountingBound: budget !== null && errors.length === 0, budgetForecastAvailable: budget?.forecast !== null && budget?.forecast !== undefined,
    financialLimitDecision: 'not_evaluated', errors, noModelExecution: true,
  }
}
