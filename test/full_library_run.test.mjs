import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runFullLibrary, scoredWindow } from '../scripts/full_library_run.mjs'

const evaluated = (index, score = 0) => ({ executionId: `e${index}`, scenarioId: `q${index}`, phase: 'standard',
  status: 'evaluated', technicalError: null, evaluationComplete: true, rawScore: score,
  scoreReliability: 'reliable', judgeProtocolAffected: false })
test('first forty actual scored outcomes stop exactly at forty', () => {
  assert.equal(scoredWindow(Array.from({ length: 39 }, (_, i) => evaluated(i))).shouldStop, false)
  assert.equal(scoredWindow(Array.from({ length: 40 }, (_, i) => evaluated(i))).shouldStop, true)
})
test('technical diagnostic zeros, nulls and malformed scores do not count', () => {
  const rows = Array.from({ length: 39 }, (_, i) => evaluated(i))
  for (const extra of [{ ...evaluated(40), status: 'technical_error', technicalError: 'failed' },
    { ...evaluated(41), evaluationComplete: false }, evaluated(42, null), evaluated(43, NaN), evaluated(44, -1)]) {
    assert.equal(scoredWindow([...rows, extra]).collected, 39)
  }
})
test('rows without judge provenance remain diagnostic and do not enter the scored window', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ ...evaluated(i), scoreReliability: 'unknown', judgeProtocolAffected: null }))
  const result = scoredWindow(rows)
  assert.equal(result.collected, 0)
  assert.equal(result.shouldStop, false)
  assert.equal(result.reliability.unknown, 40)
})
test('only initial window matters, not a later forty-zero streak', () => {
  const rows = [evaluated(0, 1), ...Array.from({ length: 80 }, (_, i) => evaluated(i + 1))]
  assert.equal(scoredWindow(rows).shouldStop, false)
  assert.equal(scoredWindow(rows).nonzeroCount, 1)
})

function fixture(count = 90) {
  const root = mkdtempSync(join(tmpdir(), 'gaia2-full-library-loop-'))
  const tasks = Array.from({ length: count }, (_, i) => ({ executionId: `e${i}`, scenarioId: `q${i}`, config: 'time', phase: 'standard' }))
  const manifest = { mode: 'full_library_once', runId: 'test', runRoot: 'runs/test', manifestHash: 'a'.repeat(64), tasks,
    stopPolicy: { firstScoredOutcomes: 40, stopIfAllScoresZero: true, technicalAndUnscoredExcluded: true } }
  let calls = 0
  const dependencies = { loadPlan: () => manifest, assertFrozen: () => {}, readConnection: () => ({}), readOwnerIdentity: async () => ({ verified: true, pid: process.pid }),
    executeTask: async ({ index }) => { calls++; return evaluated(index) } }
  return { root, manifest, dependencies, calls: () => calls }
}
test('runner never schedules question41 after forty scored zeros', async () => {
  const f = fixture(), result = await runFullLibrary({ root: f.root, path: 'ignored' }, f.dependencies)
  assert.equal(f.calls(), 40); assert.equal(result.status, 'stopped_first40_all_zero')
  assert.equal(result.totals.attempted, 40)
  assert.ok(existsSync(join(f.root, 'runs/test/report.json')))
  await assert.rejects(runFullLibrary({ root: f.root, path: 'ignored' }, f.dependencies), /already started/)
})
test('technical failures are excluded and no task is retried', async () => {
  const f = fixture()
  f.dependencies.executeTask = async ({ index }) => index < 2
    ? { ...evaluated(index), status: 'technical_error', technicalError: 'service', evaluationComplete: false }
    : evaluated(index)
  const result = await runFullLibrary({ root: f.root, path: 'ignored' }, f.dependencies)
  assert.equal(result.totals.attempted, 42); assert.equal(result.totals.technical, 2)
  assert.equal(result.first40.collected, 40); assert.equal(result.status, 'stopped_first40_all_zero')
})
test('nonzero among first forty permits rest of bank', async () => {
  const f = fixture(45)
  f.dependencies.executeTask = async ({ index }) => evaluated(index, index === 4 ? 1 : 0)
  const result = await runFullLibrary({ root: f.root, path: 'ignored' }, f.dependencies)
  assert.equal(result.status, 'completed'); assert.equal(result.totals.attempted, 45)
})
test('unclosed child prevents dispatch of next question regardless of score', async () => {
  const f = fixture()
  f.dependencies.executeTask = async ({ index }) => ({ ...evaluated(index), fatalSupervision: true })
  const result = await runFullLibrary({ root: f.root, path: 'ignored' }, f.dependencies)
  assert.equal(result.status, 'stopped_for_safety'); assert.equal(result.totals.attempted, 1)
})
test('source drift is fenced before any next question', async () => {
  const f = fixture(); let checks = 0
  f.dependencies.assertFrozen = () => { if (++checks === 3) throw new Error('changed') }
  const result = await runFullLibrary({ root: f.root, path: 'ignored' }, f.dependencies)
  assert.equal(result.status, 'stopped_for_safety'); assert.equal(f.calls(), 1)
  assert.equal(result.frozenSourcesVerified, false)
})

test('bounded scope stops after the requested task count and records a task-list hash', async () => {
  const f = fixture(6), result = await runFullLibrary({ root: f.root, path: 'ignored', maxTasks: 3, checkpointEvery: 3 }, f.dependencies)
  assert.equal(result.status, 'completed_scope')
  assert.equal(result.totals.attempted, 3)
  assert.equal(result.requestedTaskLimit, 3)
  assert.equal(result.scope.taskLimit, 3)
  assert.equal(result.scope.executionIds.length, 3)
  assert.match(result.scope.taskListHash, /^[a-f0-9]{64}$/)
  assert.equal(result.checkpoint.ordinal, 3)
  assert.ok(existsSync(join(f.root, 'runs/test/checkpoint-0003.json')))
})

test('checkpoint pause waits for an explicit continuation marker', async () => {
  const f = fixture(4)
  const result = await runFullLibrary({ root: f.root, path: 'ignored', maxTasks: 4, checkpointEvery: 2, pauseAtCheckpoint: true,
    onProgress: value => { if (value.status === 'checkpoint_waiting') writeFileSync(join(f.root, 'runs/test/CHECKPOINT_CONTINUE_0002.json'), JSON.stringify({
      schemaVersion: 'gaia2-checkpoint-gate-v1', manifestHash: 'a'.repeat(64), scopeHash: value.scope.taskListHash,
      ordinal: 2, decision: 'continue', principal: 'test', createdAt: new Date().toISOString() })) } }, f.dependencies)
  assert.equal(result.status, 'completed')
  assert.equal(f.calls(), 4)
  assert.equal(result.checkpoint.ordinal, 4)
  assert.equal(existsSync(join(f.root, 'runs/test/checkpoint-0002.json')), true)
})
