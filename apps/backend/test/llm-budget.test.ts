import { test } from 'node:test'
import assert from 'node:assert/strict'
import { budgetedLlm } from '#core/experiments/llm-budget'
import type { RuntimeLlm } from '#core/runtime-loop'
import type { LlmChatRequest } from '#util/llm'

test('budget preserves non-enumerable retry callbacks for chat and streaming', async () => {
  let retries = 0
  const invoke = async (request: LlmChatRequest) => {
    assert.equal(Object.keys(request).includes('onRetry'), false)
    request.onRetry?.({ phase: 'waiting', attempt: 1, maxAttempts: 3, delayMs: 100, reason: 'retry', statusCode: 503 })
    return { text: 'ok', usage: { totalTokens: 10 }, raw: {} }
  }
  const guarded = budgetedLlm({ getConfig: () => ({}), chat: invoke, stream: invoke } as unknown as RuntimeLlm, 1000)
  const request: LlmChatRequest = { messages: [{ role: 'user', content: 'hello' }] }
  Object.defineProperty(request, 'onRetry', { enumerable: false, value: () => { retries++ } })
  await guarded.chat(request)
  await guarded.stream!(request, () => {})
  assert.equal(retries, 2)
})

test('budget prevents the next request and clamps output without discarding reported usage', async () => {
  let calls = 0
  const llm = { getConfig: () => ({}), chat: async (request: { maxTokens?: number }) => {
    calls++
    assert.ok(request.maxTokens! < 100)
    return { text: 'ok', usage: { totalTokens: 100 }, raw: {} }
  } } as unknown as RuntimeLlm
  const guarded = budgetedLlm(llm, 100)
  assert.equal((await guarded.chat({ messages: [{ role: 'user', content: 'hello' }], maxTokens: 500 })).usage?.totalTokens, 100)
  await assert.rejects(guarded.chat({ messages: [{ role: 'user', content: 'again' }] }), /TOKEN_BUDGET_EXHAUSTED/)
  assert.equal(calls, 1)
})
