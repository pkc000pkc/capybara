import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { digest, fileDigest } from '../src/phase0_run.mjs'
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

function liveFixture(status = 'running', sessions = 1) {
  const root = mkdtempSync(join(tmpdir(), 'gaia2-phase6-state-audit-')), value = manifest(), task = value.tasks[0]
  const runtime = { concurrency: 1, minimal: false }
  mkdirSync(join(root, value.runRoot), { recursive: true })
  writeFileSync(join(root, value.runRoot, 'runtime-settings.json'), JSON.stringify(runtime))
  const lineage = Array.from({ length: sessions }, (_, index) => {
    const sessionId = `${String(index + 1).padStart(4, '0')}-12345678-abc`
    return { sessionId, sessionOrdinal: index + 1, parentSessionId: index ? `${String(index).padStart(4, '0')}-12345678-abc` : null,
      outputDir: `${task.outputDir}/sessions/${sessionId}`, fixtureDir: `${task.fixtureDir}/sessions/${sessionId}`, workspaceDir: `${task.workspaceDir}/sessions/${sessionId}`, endedAt: index === sessions - 1 && status === 'running' ? null : '2026-10-13T00:00:00Z' }
  })
  const record = { executionId: task.executionId, status, sessions: lineage, resultPath: null, resultSha256: null, failure: null }
  const state = { schemaVersion: 'gaia2-run-state-v1', runId: value.runId, manifestHash: value.manifestHash, runtimeHash: digest(runtime), tasks: [record] }
  const saveResult = (session = lineage.at(-1), changes = {}) => {
    record.resultPath = `${session.workspaceDir}/task-result.json`
    mkdirSync(join(root, session.workspaceDir), { recursive: true })
    writeFileSync(join(root, record.resultPath), JSON.stringify({ schemaVersion: 'gaia2-task-result-v1', runId: value.runId, manifestHash: value.manifestHash, runtimeHash: state.runtimeHash, ...Object.fromEntries(['executionId', 'phase', 'config', 'scenarioId', 'runNumber'].map(key => [key, task[key]])), sessionId: session.sessionId, evaluationComplete: true, businessPassed: false, ...changes }))
    record.resultSha256 = fileDigest(join(root, record.resultPath))
  }
  return { root, value, record, state, lineage, saveResult, audit: () => auditPhase6Run({ root, manifest: value, state }) }
}

test('running current session may have two null references and cannot pass the whole gate', () => {
  const f = liveFixture()
  const report = f.audit()
  assert.deepEqual(report.errors, [])
  assert.equal(report.counts.running, 1)
  assert.equal(report.canProceedToNextBatch, false)
})

test('half-filled running result references fail closed without inventing a missing result', () => {
  const f = liveFixture(); f.record.resultSha256 = 'b'.repeat(64)
  const codes = f.audit().errors.map(e => e.code)
  assert.ok(codes.includes('result_reference_incomplete'))
  assert.ok(codes.includes('nonterminal_has_result'))
  assert.ok(!codes.includes('result_reference_missing'))
})

test('running cannot carry a prior completed session result', () => {
  const f = liveFixture('running', 2); f.saveResult(f.lineage[0])
  assert.ok(f.audit().errors.some(e => e.code === 'nonterminal_has_result'))
})

test('completed current record cannot point to a previous session directory', () => {
  const f = liveFixture('completed', 2); f.saveResult(f.lineage[0])
  assert.ok(f.audit().errors.some(e => e.code === 'result_session_path_mismatch'))
})

test('current result must bind the latest session identity and runtime hash', () => {
  for (const changes of [{ sessionId: '0000-deadbeef-abc' }, { runtimeHash: 'c'.repeat(64) }]) {
    const f = liveFixture('completed'); f.saveResult(undefined, changes)
    assert.ok(f.audit().errors.some(e => e.code === 'result_identity_mismatch'))
  }
})

test('completed valid source still passes and changed bytes do not', () => {
  const f = liveFixture('completed'); f.saveResult()
  assert.deepEqual(f.audit().errors, [])
  assert.equal(f.audit().canProceedToNextBatch, true)
  f.record.resultSha256 = 'e'.repeat(64)
  assert.ok(f.audit().errors.some(e => e.code === 'result_hash_mismatch'))
})
