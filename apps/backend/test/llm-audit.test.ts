import assert from 'node:assert/strict'
import test from 'node:test'
import { auditedLlm, type ExperimentLlmAudit } from '#core/experiments/llm-audit'
import type { RuntimeLlm } from '#core/runtime-loop'
import type { LlmChatRequest } from '#util/llm'
import { diagnosticContext } from '#util/llm/diagnostic-log'

test('LLM audit preserves callbacks, records retries, and leaves missing usage unknown', async () => {
  const events: ExperimentLlmAudit[] = []
  let callbacks = 0
  const request: LlmChatRequest = { messages: [{ role: 'user', content: 'private content' }] }
  const validateResponse = () => undefined
  Object.defineProperty(request, 'validateResponse', { value: validateResponse })
  Object.defineProperty(request, 'onRetry', { value: () => { callbacks += 1 } })
  const llm: RuntimeLlm = {
    getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'test', baseUrl: 'http://local', timeoutMs: 1000, maxRetries: 1 }),
    chat: async next => {
      assert.equal(next.validateResponse, validateResponse)
      next.onRetry?.({ phase: 'waiting', attempt: 1, maxAttempts: 1, delayMs: 1, reason: 'private error' })
      return { provider: 'custom', model: 'actual', text: 'private response', raw: {} }
    },
  }
  await auditedLlm(llm, 'actor', events).chat(request)
  assert.equal(callbacks, 1)
  assert.equal(events[0]?.usage, null)
  assert.equal(events[0]?.model, 'actual')
  assert.equal(events[0]?.retries.length, 1)
  assert.doesNotMatch(JSON.stringify(events), /private/)
  llm.chat = async () => { throw new Error('private failure') }
  await assert.rejects(auditedLlm(llm, 'scorer', events).chat(request))
  assert.equal(events[1]?.status, 'failed')
  assert.equal(events[1]?.usage, null)
})

test('streaming usage is recorded once and Hook role attribution survives async execution', async () => {
  const events: ExperimentLlmAudit[] = []
  const llm: RuntimeLlm = {
    getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'test', baseUrl: 'http://local', timeoutMs: 1000, maxRetries: 0 }),
    chat: async () => { throw new Error('stream expected') },
    stream: async (_request, onText) => {
      await Promise.resolve()
      onText('delta')
      return { provider: 'custom', model: 'stream-model', text: 'delta', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, raw: {} }
    },
  }
  const deltas: string[] = []
  await diagnosticContext.run({ hookId: 'review-hook' }, () => auditedLlm(llm, 'actor', events).stream!({ messages: [] }, delta => deltas.push(delta)))
  assert.deepEqual(deltas, ['delta'])
  assert.equal(events.length, 1)
  assert.equal(events[0]?.role, 'runtime_hook')
  assert.equal(events[0]?.hookId, 'review-hook')
  assert.equal(events[0]?.usage?.totalTokens, 12)
})
