import test from 'node:test'
import assert from 'node:assert/strict'
import { ObservationLedger } from '../src/observation_ledger.mjs'
import { Pass5Orchestrator } from '../src/pass5_orchestrator.mjs'
import { RuntimeAttempt } from '../src/runtime_attempt.mjs'

test('observation ledger classifies duplicates, incomplete data, stale data, and conflicts', () => {
  const ledger = new ObservationLedger({ now: 100, staleAfterMs: 20 })
  const first = ledger.observe({ kind: 'tool', subject: 'mail', source: 'api-a', content: { count: 1 }, sourceTimestamp: 95 })
  const duplicate = ledger.observe({ kind: 'tool', subject: 'mail', source: 'api-a', content: { count: 1 }, sourceTimestamp: 95 })
  const incomplete = ledger.observe({ kind: 'tool', subject: 'preview', source: 'api-a', content: '', truncated: true })
  const conflicting = ledger.observe({ kind: 'tool', subject: 'mail', source: 'api-b', content: { count: 2 }, sourceTimestamp: 98 })
  ledger.observe({ kind: 'tool', subject: 'calendar', source: 'api-a', content: { count: 1 }, sourceTimestamp: 95 })
  assert.equal(first.status, 'observed')
  assert.equal(duplicate.status, 'duplicate')
  assert.equal(incomplete.status, 'incomplete')
  assert.equal(conflicting.status, 'conflicting')
  assert.equal(ledger.unresolved({ subject: 'mail' }).length, 2)
  ledger.setNow(200)
  assert.ok(ledger.unresolved().some((record) => record.status === 'stale'))
})

test('runtime attempt withholds oracle events and blocks writes on unresolved evidence', async () => {
  const attempt = new RuntimeAttempt({ scenarioId: 's-1', capability: 'execution', attemptIndex: 1, seed: 1 })
  await attempt.run({
    eventPlan: [
      { id: 'user-1', type: 'USER', scheduledAt: 0, payload: { request: 'send' } },
      { id: 'oracle-1', type: 'AGENT', scheduledAt: 1, dependencies: ['user-1'], payload: { expected: true } },
    ],
    plan: { steps: ['observe'] },
  })
  assert.equal(attempt.result().oracleWithheld, 1)
  attempt.observe({ kind: 'tool', subject: 'write', source: 'preview', content: '', truncated: true })
  assert.throws(() => attempt.startWrite({ actionId: 'a-1', toolName: 'mail.send', operation: 'send', args: {}, mutationKey: 'm-1' }), /write blocked/)
})

test('pass@5 runs five isolated attempts and correction does not add attempts', async () => {
  const seen = []
  const orchestrator = new Pass5Orchestrator({
    rootSeed: 42,
    noiseProfile: 'off',
    maxCorrections: 1,
    correction: async ({ attemptIndex }) => ({ procedure: `verify-${attemptIndex}` }),
  })
  const report = await orchestrator.runScenario({
    scenarioId: 's-2',
    capability: 'search',
    eventPlan: [{ id: 'user-1', type: 'USER', scheduledAt: 0, payload: { query: 'x' } }],
    runAttempt: async ({ attemptIndex, mode, strategy }) => {
      seen.push({ attemptIndex, mode, strategy })
      return { passed: mode === 'correction', failureReason: mode === 'initial' ? 'insufficient evidence' : undefined }
    },
  })
  assert.equal(report.attempts.length, 5)
  assert.equal(report.passAt5, 1)
  assert.equal(report.attemptPassRate, 1)
  assert.equal(report.taskPassAll5, true)
  assert.equal(report.attempts.reduce((sum, item) => sum + item.correctionCount, 0), 5)
  assert.deepEqual([...new Set(seen.filter((item) => item.mode === 'initial').map((item) => item.attemptIndex))], [1, 2, 3, 4, 5])
  assert.equal(seen.filter((item) => item.mode === 'correction').length, 5)
  assert.equal(new Set(report.attempts.map((item) => item.initialStateHash)).size, 5)
})

test('pass@5 keeps infrastructure failures separate from business failures', async () => {
  const orchestrator = new Pass5Orchestrator({ rootSeed: 1 })
  const report = await orchestrator.runScenario({
    scenarioId: 's-3', capability: 'time', eventPlan: [],
    runAttempt: async ({ attemptIndex }) => ({ passed: attemptIndex === 1, infrastructureError: attemptIndex === 2 }),
  })
  assert.equal(report.passAt5, null)
  assert.equal(report.observedPassAt5, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.validAttemptCount, 4)
  assert.equal(report.technicalAttemptCount, 1)
  assert.equal(report.infrastructureErrorRate, 0.2)
  assert.equal(report.unresolvedRate, 0.6)
})

test('pass@5 never counts a passed technical or judge-protocol attempt', () => {
  const orchestrator = new Pass5Orchestrator({ rootSeed: 3 })
  const report = orchestrator.aggregate({ scenarioId: 's-4', capability: 'search', outcomes: [
    { attemptIndex: 1, passed: true, correctionCount: 0 },
    { attemptIndex: 2, passed: true, infrastructureError: true, correctionCount: 0 },
    { attemptIndex: 3, passed: true, judgeProtocolAffected: true, correctionCount: 0 },
    { attemptIndex: 4, passed: false, correctionCount: 0 },
    { attemptIndex: 5, passed: false, correctionCount: 0 },
  ] })
  assert.equal(report.passAt5, null)
  assert.equal(report.observedPassAt5, 1)
  assert.equal(report.validAttemptCount, 3)
  assert.equal(report.technicalAttemptCount, 1)
  assert.equal(report.judgeProtocolAttemptCount, 1)
  assert.equal(report.status, 'incomplete')
})
