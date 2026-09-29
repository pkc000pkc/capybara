import test from 'node:test'
import assert from 'node:assert/strict'
import { A2AChannel } from '../src/a2a_channel.mjs'
import { NoiseAdapter } from '../src/noise_adapter.mjs'

test('A2A channel enforces capability and de-duplicates request IDs', async () => {
  const channel = new A2AChannel()
  channel.register({ agentId: 'calendar-agent', capabilities: ['find_slot'] }, async ({ payload }) => ({ slot: payload.day }))
  const first = await channel.request({
    requestId: 'req-1', from: 'main', to: 'calendar-agent', capability: 'find_slot', payload: { day: 'monday' },
  })
  assert.equal(first.state, 'fulfilled')
  assert.deepEqual(first.response, { slot: 'monday' })
  const duplicate = await channel.request({
    requestId: 'req-1', from: 'main', to: 'calendar-agent', capability: 'find_slot', payload: { day: 'tuesday' },
  })
  assert.deepEqual(duplicate, first)
  await assert.rejects(
    () => channel.request({ requestId: 'req-2', from: 'main', to: 'calendar-agent', capability: 'send_mail', payload: {} }),
    /does not provide/,
  )
})

test('Noise adapter is reproducible from seed and preserves decisions in trace', () => {
  const options = { seed: 17, toolFailureProbability: 0.5, environmentEventRate: 0.25 }
  const a = new NoiseAdapter(options)
  const b = new NoiseAdapter(options)
  const aDecisions = ['tool-1', 'tool-2', 'event-1'].map((key) => key.startsWith('tool')
    ? a.injectToolFailure(key) : a.injectEnvironmentEvent(key))
  const bDecisions = ['tool-1', 'tool-2', 'event-1'].map((key) => key.startsWith('tool')
    ? b.injectToolFailure(key) : b.injectEnvironmentEvent(key))
  assert.deepEqual(aDecisions, bDecisions)
  assert.deepEqual(a.snapshot().config, options)
  assert.equal(a.snapshot().decisions.length, 3)
})
