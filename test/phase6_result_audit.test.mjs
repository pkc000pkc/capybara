import test from 'node:test'
import assert from 'node:assert/strict'
import { auditPhase6Run } from '../scripts/phase6_result_audit.mjs'

function manifest() {
  return { schemaVersion: 'gaia2-run-manifest-v1', runId: 'audit-fixture', manifestHash: 'a'.repeat(64), runRoot: 'runs/audit-fixture', tasks: [
    { executionId: 'standard-execution-one', phase: 'standard', config: 'execution', scenarioId: 'scenario-one', runNumber: 1, outputDir: 'runs/audit-fixture/executions/standard-execution-one', fixtureDir: 'runs/audit-fixture/fixtures/standard-execution-one', workspaceDir: 'runs/audit-fixture/workspaces/standard-execution-one' },
  ] }
}

test('result audit reports an unexecuted frozen plan without treating it as a failure', () => {
  const report = auditPhase6Run({ manifest: manifest() })
  assert.equal(report.status, 'audited')
  assert.equal(report.counts.pending, 1)
  assert.equal(report.outcomes.business_failure, 0)
  assert.equal(report.canProceedToNextBatch, false)
  assert.equal(report.noModelExecution, true)
})

test('result audit rejects a state bound to another manifest', () => {
  const value = manifest()
  const report = auditPhase6Run({ manifest: value, state: { schemaVersion: 'gaia2-run-state-v1', runId: 'foreign', manifestHash: value.manifestHash, runtimeHash: 'b'.repeat(64), tasks: [] } })
  assert.equal(report.status, 'rejected')
  assert.ok(report.errors.some(error => error.code === 'state_binding_mismatch'))
})
