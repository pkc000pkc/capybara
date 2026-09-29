import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTrace } from '../src/trace_normalizer.mjs'
import { VerifierBridge } from '../src/verifier_bridge.mjs'

test('trace normalizer excludes raw action arguments and creates a stable hash', () => {
  const trace = normalizeTrace({
    scenarioId: 's-1',
    capability: 'execution',
    events: [{ id: 'user-1', type: 'user', payload: { secret: 'hidden' } }],
    actions: [{ actionId: 'a-1', toolName: 'mail.send', operation: 'send', args: { body: 'secret' }, argsHash: 'hash', result: 'success' }],
  })
  assert.equal(trace.actions[0].args, undefined)
  assert.equal(trace.events[0].payload, undefined)
  assert.match(trace.traceHash, /^[a-f0-9]{64}$/)
})

test('verifier bridge makes missing official judge explicit', async () => {
  const bridge = new VerifierBridge()
  const result = await bridge.evaluate({ traceHash: 'abc' })
  assert.equal(result.status, 'not_configured')
  assert.equal(result.benchmarkOutcome, null)
  assert.equal(result.executionOutcome, 'not_evaluated')
})

test('verifier bridge preserves raw verifier output only when configured', async () => {
  const bridge = new VerifierBridge(async () => ({ benchmarkOutcome: 'pass', executionOutcome: 'completed', raw: { score: 1 } }))
  const result = await bridge.evaluate({ traceHash: 'abc' })
  assert.equal(result.status, 'evaluated')
  assert.deepEqual(result.raw, { score: 1 })
})
