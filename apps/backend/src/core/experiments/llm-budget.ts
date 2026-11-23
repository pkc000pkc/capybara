import type { RuntimeLlm } from '#core/runtime-loop'
import type { LlmChatRequest, LlmChatResponse } from '#util/llm'

export interface LlmTokenBudget {
  used: number
}

/** Request-boundary guard; input is estimated until the provider reports usage. */
export function budgetedLlm(llm: RuntimeLlm, limit: number, budget: LlmTokenBudget = { used: 0 }): RuntimeLlm {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Token budget must be a positive integer')
  const prepare = (request: LlmChatRequest): LlmChatRequest => {
    const input = Math.ceil(JSON.stringify({ messages: request.messages, tools: request.tools }).length / 4)
    const available = Math.floor(limit - budget.used - input)
    if (available < 1) throw new Error(`TOKEN_BUDGET_EXHAUSTED: used ${budget.used}, estimated next input ${input}, limit ${limit}`)
    const next = { ...request, maxTokens: Math.min(request.maxTokens ?? 6000, available) }
    // Runtime callbacks are intentionally non-enumerable and must survive wrapping.
    Object.defineProperty(next, 'onRetry', { value: request.onRetry, enumerable: false })
    Object.defineProperty(next, 'validateResponse', { value: request.validateResponse, enumerable: false })
    return next
  }
  const record = (response: LlmChatResponse, request: LlmChatRequest) => {
    budget.used += response.usage?.totalTokens ?? ((response.usage?.inputTokens ?? Math.ceil(JSON.stringify(request.messages).length / 4))
      + (response.usage?.outputTokens ?? Math.ceil(response.text.length / 4)))
    return response
  }
  return {
    admitsTransportAttempts: llm.admitsTransportAttempts,
    getConfig: () => llm.getConfig(),
    chat: async request => { const next = prepare(request); return record(await llm.chat(next), next) },
    ...(llm.stream ? { stream: async (request: LlmChatRequest, onText: (text: string) => void) => {
      const next = prepare(request); return record(await llm.stream!(next, onText), next)
    } } : {}),
  }
}
