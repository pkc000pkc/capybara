import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileDigest, readJson } from '../src/phase0_run.mjs'
import { auditPhase6Scope, phase6ScopeEvidenceErrors } from '../src/phase6_scope_gate.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
function contract() {
  const binding = { runId: 'controlled', manifestHash: 'a'.repeat(64), planFingerprint: 'b'.repeat(64), runtimeHash: 'c'.repeat(64), selectionIdentityHash: 'd'.repeat(64) }, executionIds = ['one', 'two']
  const sourceRefs = Object.fromEntries(['manifest', 'state', 'runtime'].map(key => [key, { path: `${key}.json`, sha256: 'e'.repeat(64) }]))
  const budget = { schemaVersion: 'gaia2-phase6-budget-report-v1', status: 'audited', binding: { ...binding, ...structuredClone(sourceRefs) }, scope: { executionIds: [...executionIds], selectedExecutions: 2, scopeExecutionComplete: true }, tokenUsageComplete: false, totalTokens: null, forecast: null, generatedAt: 'old' }
  const verifiedHttp = { status: 'passed', binding, scope: { executionIds }, counts: { dispatched: 2 }, generatedAt: 'new' }
  return { binding, executionIds, sourceRefs, budget, recomputedBudget: { ...structuredClone(budget), generatedAt: 'new' }, http: { ...structuredClone(verifiedHttp), generatedAt: 'old' }, verifiedHttp }
}

test('pure evidence comparison accepts bound unknown tokens without calling it zero or a financial decision', () => {
  const f = contract()
  assert.deepEqual(phase6ScopeEvidenceErrors(f), [])
  assert.equal(f.budget.totalTokens, null)
  assert.equal(f.budget.tokenUsageComplete, false)
  assert.equal(f.budget.forecast, null)
})

for (const [name, change, code] of [
  ['foreign manifest binding', f => { f.budget.binding.manifestHash = 'f'.repeat(64) }, 'budget_binding_mismatch'],
  ['reordered IDs', f => { f.budget.scope.executionIds = ['two', 'one'] }, 'budget_scope_mismatch'],
  ['missing selected ID', f => { f.budget.scope.executionIds = ['one'] }, 'budget_scope_mismatch'],
  ['incomplete selected scope', f => { f.budget.scope.scopeExecutionComplete = false }, 'budget_scope_mismatch'],
  ['changed source state SHA', f => { f.budget.binding.state.sha256 = 'f'.repeat(64) }, 'budget_source_snapshot_mismatch'],
  ['invented budget amount', f => { f.budget.amount = 0 }, 'budget_recomputation_mismatch'],
  ['HTTP report flag without recomputed proof', f => { f.verifiedHttp.status = 'rejected' }, 'production_http_scope_invalid'],
  ['HTTP wrong selection', f => { f.verifiedHttp.scope.executionIds = ['one'] }, 'production_http_scope_invalid'],
  ['HTTP extra dispatch hidden in saved report', f => { f.http.counts.dispatched = 1 }, 'production_http_recomputation_mismatch'],
]) test(`scope evidence rejects ${name}`, () => { const f = contract(); change(f); assert.ok(phase6ScopeEvidenceErrors(f).includes(code)) })

test('missing budget or HTTP evidence fails closed in the pure comparison', () => {
  const f = contract(); f.budget = null; f.http = null; f.verifiedHttp = null
  const errors = phase6ScopeEvidenceErrors(f)
  assert.ok(errors.includes('budget_binding_mismatch'))
  assert.ok(errors.includes('production_http_scope_invalid'))
})

test('historical stage5 real Hooks cannot masquerade as stage6 production HTTP evidence', async () => {
  const run = 'phase5-a2a-service-revalidation-20261013-r17', manifest = readJson(join(root, 'runs', run, 'run-manifest.json'))
  const statePath = join(root, manifest.stateFile), before = fileDigest(statePath)
  const report = await auditPhase6Scope({ root, manifest, selection: { executionIds: ['agent2agent-mini-bae7575395a64a6d'] }, exportDir: 'unused' })
  assert.equal(report.scopeAcceptancePassed, false)
  assert.equal(report.officialSubmissionReady, false)
  assert.equal(report.financialLimitDecision, 'not_evaluated')
  assert.ok(report.errors.some(e => e.code.startsWith('production_http_guard_not_required:')))
  assert.equal(fileDigest(statePath), before)
})

test('unknown selected IDs reject before result inspection and leave the historical state intact', async () => {
  const manifest = readJson(join(root, 'runs/phase5-a2a-service-revalidation-20261013-r17/run-manifest.json'))
  const report = await auditPhase6Scope({ root, manifest, selection: { executionIds: ['does-not-exist'] }, exportDir: 'unused' })
  assert.equal(report.scopeAcceptancePassed, false)
  assert.deepEqual(report.errors, [{ code: 'unknown_execution_id' }])
})
