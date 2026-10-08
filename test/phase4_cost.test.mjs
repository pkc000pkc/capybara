import assert from 'node:assert/strict'
import test from 'node:test'
import { aggregateOperationalUsage } from '../src/phase4_cost.mjs'
const event = (type, modelRole, requestId, extra = {}) => ({ type, modelRole, requestId, ...extra })

test('usage separates initial Actor/Judge and correction cost; no provider price is fabricated', () => {
  const result = aggregateOperationalUsage({ executions: [
    { executionId: 'initial-1', kind: 'initial', elapsedMs: 2000, events: [event('model_request_attempt', 'actor', 'a'), event('model_request_succeeded', 'actor', 'a', { usageAvailable: true, usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } }), event('model_request_attempt', 'judge', 'j'), event('model_request_succeeded', 'judge', 'j', { usageAvailable: true, usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 } })] },
    { executionId: 'training-1', kind: 'training', elapsedMs: 500, events: [event('model_request_attempt', 'correction', 'c'), event('model_request_failed', 'correction', 'c'), event('model_retry_scheduled', 'correction', 'c'), event('model_request_attempt', 'correction', 'c'), event('model_request_succeeded', 'correction', 'c', { usageAvailable: true, usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } })] },
  ] })
  assert.equal(result.byKind.initial.correction.successfulCompletions, 0)
  assert.equal(result.byRole.correction.requestAttempts, 2); assert.equal(result.byRole.correction.retriesScheduled, 1)
  assert.equal(result.byRole.actor.totalTokens, 13); assert.equal(result.totalElapsedMs, 2500)
  assert.equal(result.monetaryCost, null); assert.equal(result.correctionExecutionsCountedAsInitial, 0)
})

test('missing or partial usage remains unknown instead of fabricated zero tokens or elapsed time', () => {
  const result = aggregateOperationalUsage({ executions: [{ executionId: 'replay-1', kind: 'replay', events: [
    event('model_request_succeeded', 'actor', 'a', { usageAvailable: true, usage: { inputTokens: 5 } }),
    event('model_request_succeeded', 'actor', 'b'),
  ] }] })
  assert.equal(result.byRole.actor.inputTokens, null); assert.equal(result.byRole.actor.totalTokens, null)
  assert.equal(result.byRole.actor.unknownInputTokenCompletions, 1); assert.equal(result.byRole.actor.unknownTotalTokenCompletions, 2)
  assert.equal(result.totalElapsedMs, null); assert.equal(result.unknownElapsedExecutions, 1)
})

test('duplicate completions, raw usage text and unsafe counters cannot inflate observed costs', () => {
  const item = { executionId: 'initial-1', kind: 'initial', elapsedMs: 1, events: [] }
  for (const events of [[event('model_request_succeeded', 'actor', 'a'), event('model_request_succeeded', 'actor', 'a')],
    [event('model_request_succeeded', 'actor', 'a', { usageAvailable: true, usage: { raw: 'secret' } })],
    [event('model_request_succeeded', 'actor', 'a', { usageAvailable: true, usage: { inputTokens: true } })],
    [event('model_request_succeeded', 'actor', 'a', { usageAvailable: true })]]) {
    assert.throws(() => aggregateOperationalUsage({ executions: [{ ...item, events }] }))
  }
  assert.throws(() => aggregateOperationalUsage({ executions: [item, item] }), /execution identity/)
})
