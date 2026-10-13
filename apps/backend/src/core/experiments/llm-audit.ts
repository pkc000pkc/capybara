import { randomUUID } from 'node:crypto'
import type { RuntimeLlm } from '#core/runtime-loop'
import type { LlmChatRequest, LlmChatResponse, LlmRetryNotification, LlmUsage } from '#util/llm'
import { diagnosticContext } from '#util/llm/diagnostic-log'

export interface ExperimentLlmAudit {
  id: string
  role: string
  hookId?: string
  status: 'completed' | 'failed'
  model: string
  durationMs: number
  usage: LlmUsage | null
  retries: Array<Pick<LlmRetryNotification, 'phase' | 'kind' | 'attempt' | 'delayMs' | 'statusCode'>>
}

/** Logical requests including retry notices; missing provider usage stays unknown. */
export function auditedLlm(llm: RuntimeLlm, role: string, events: ExperimentLlmAudit[]): RuntimeLlm {
  const execute = async (
    request: LlmChatRequest,
    invoke: (request: LlmChatRequest) => Promise<LlmChatResponse>,
  ) => {
    const started = Date.now()
    const hookId = diagnosticContext.getStore()?.hookId
    const event: ExperimentLlmAudit = {
      id: randomUUID(), role: typeof hookId === 'string' ? 'runtime_hook' : role,
      ...(typeof hookId === 'string' ? { hookId } : {}),
      status: 'failed', model: request.model ?? llm.getConfig().model,
      durationMs: 0, usage: null, retries: [],
    }
    // Preserve non-enumerable local callbacks and cancellation metadata.
    const descriptors = Object.getOwnPropertyDescriptors(request)
    delete descriptors.onRetry
    const next = Object.defineProperties({}, descriptors) as LlmChatRequest
    Object.defineProperty(next, 'onRetry', {
      configurable: true,
      value: (notice: LlmRetryNotification) => {
        event.retries.push({ phase: notice.phase, kind: notice.kind, attempt: notice.attempt, delayMs: notice.delayMs, statusCode: notice.statusCode })
        request.onRetry?.(notice)
      },
    })
    try {
      const response = await invoke(next)
      event.status = 'completed'
      event.model = response.model
      event.usage = response.usage ? { ...response.usage } : null
      return response
    } finally {
      event.durationMs = Date.now() - started
      events.push(event)
    }
  }
  return {
    getConfig: () => llm.getConfig(),
    chat: request => execute(request, next => llm.chat(next)),
    ...(llm.stream ? { stream: (request: LlmChatRequest, onText: (text: string) => void) => execute(request, next => llm.stream!(next, onText)) } : {}),
  }
}
