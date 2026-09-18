import { loadLlmConfig } from '#util/llm/config'
import { LlmRequestError, OpenAiCompatibleProvider } from '#util/llm/openai-compatible'
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmClientMetadata,
  LlmConfig,
  LlmProvider,
  LlmTextDeltaHandler,
} from '#util/llm/types'

export { LlmRequestError } from '#util/llm/openai-compatible'

export type {
  LlmChatRequest,
  LlmChatResponse,
  LlmConfig,
  LlmMessage,
  LlmProtocol,
  LlmProviderName,
  LlmRequestDiagnostics,
  LlmRetryHandler,
  LlmRetryNotification,
  LlmRole,
  LlmToolCall,
  LlmToolDefinition,
  LlmTextDeltaHandler,
  LlmUsage,
} from '#util/llm/types'

export class LlmService {
  constructor(private readonly provider: LlmProvider) {}

  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    if (request.messages.length === 0) {
      throw new Error('LLM chat requires at least one message')
    }
    return this.provider.chat(request)
  }

  async stream(
    request: LlmChatRequest,
    onTextDelta: LlmTextDeltaHandler,
  ): Promise<LlmChatResponse> {
    if (request.messages.length === 0) {
      throw new Error('LLM chat requires at least one message')
    }
    return this.provider.stream(request, onTextDelta)
  }

  async prompt(prompt: string): Promise<LlmChatResponse> {
    return this.chat({ messages: [{ role: 'user', content: prompt }] })
  }

  getConfig(): Readonly<LlmConfig> {
    return this.provider.getConfig()
  }
}

export interface LlmFailoverCandidate {
  id: string
  config: Partial<LlmConfig>
}

export interface LlmFailoverOptions {
  retriesPerCandidate?: number
  initialDelayMs?: number
  maxDelayMs?: number
}

function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason
  return new Error(signal?.reason ? String(signal.reason) : 'LLM request was aborted')
}

function failoverAllowed(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return false
  const message = error instanceof Error ? error.message : String(error)
  if (/context.{0,20}(length|limit|window)|maximum context|prompt is too long|too many tokens/i.test(message)) {
    return false
  }
  if (/tool messages require|requires request metadata|base URL is required|at least one message/i.test(message)) {
    return false
  }
  if (error instanceof LlmRequestError
    && [400, 413, 422].includes(error.diagnostics.statusCode ?? 0)
    && /token|context|prompt|input/i.test(message)) {
    return false
  }
  return true
}

function failoverDelay(round: number, initialDelayMs: number, maxDelayMs: number): number {
  if (round <= 0) return 0
  const ceiling = Math.min(maxDelayMs, initialDelayMs * (2 ** Math.min(round - 1, 20)))
  return Math.max(1, Math.round(ceiling * (0.5 + Math.random() * 0.5)))
}

async function waitForFailover(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) throw abortReason(signal)
  if (delayMs <= 0) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    timer.unref()
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortReason(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

class FailoverLlmProvider implements LlmProvider {
  private preferredIndex = 0
  private readonly candidates: Array<{ id: string; provider: OpenAiCompatibleProvider; config: LlmConfig }>
  private readonly retriesPerCandidate: number
  private readonly initialDelayMs: number
  private readonly maxDelayMs: number

  constructor(candidates: readonly LlmFailoverCandidate[], options: LlmFailoverOptions) {
    if (candidates.length < 2) throw new Error('LLM failover requires at least two candidates')
    this.retriesPerCandidate = options.retriesPerCandidate ?? 0
    this.initialDelayMs = options.initialDelayMs ?? 1_000
    this.maxDelayMs = options.maxDelayMs ?? 30_000
    this.candidates = candidates.map((candidate) => {
      const config = loadLlmConfig({ ...candidate.config, maxRetries: this.retriesPerCandidate })
      return { id: candidate.id, config, provider: new OpenAiCompatibleProvider(config) }
    })
  }

  getConfig(): Readonly<LlmConfig> {
    return (this.candidates[this.preferredIndex] as typeof this.candidates[number]).config
  }

  chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    return this.invoke(request, (provider, candidateRequest) => provider.chat(candidateRequest))
  }

  stream(request: LlmChatRequest, onTextDelta: LlmTextDeltaHandler): Promise<LlmChatResponse> {
    return this.invoke(request, (provider, candidateRequest) => provider.stream(candidateRequest, onTextDelta))
  }

  private async invoke(
    request: LlmChatRequest,
    operation: (provider: OpenAiCompatibleProvider, request: LlmChatRequest) => Promise<LlmChatResponse>,
  ): Promise<LlmChatResponse> {
    let candidateIndex = this.preferredIndex
    let completedRounds = 0
    let notificationAttempt = 1
    while (true) {
      if (request.signal?.aborted) throw abortReason(request.signal)
      const candidate = this.candidates[candidateIndex] as typeof this.candidates[number]
      const startedAt = Date.now()
      let innerNotificationAttempt = notificationAttempt
      let innerExcludedMs = 0
      const candidateRequest: LlmChatRequest = {
        ...request,
        ...(request.model === undefined ? { model: candidate.config.model } : {}),
        onRetry: request.onRetry
          ? (retry) => {
              if (retry.phase === 'waiting') innerNotificationAttempt = ++notificationAttempt
              if (retry.phase === 'waiting') innerExcludedMs += retry.excludedMs ?? 0
              request.onRetry?.({
                ...retry,
                kind: 'request_retry',
                attempt: innerNotificationAttempt,
                maxAttempts: -1,
                profileId: candidate.id,
                provider: candidate.config.provider,
                model: candidate.config.model,
              })
            }
          : undefined,
      }
      try {
        const response = await operation(candidate.provider, candidateRequest)
        this.preferredIndex = candidateIndex
        return response
      } catch (error) {
        if (!failoverAllowed(error, request.signal)) throw error
        const nextIndex = (candidateIndex + 1) % this.candidates.length
        const nextCandidate = this.candidates[nextIndex] as typeof this.candidates[number]
        const wrapped = nextIndex === 0
        if (wrapped) completedRounds += 1
        const delayMs = wrapped
          ? failoverDelay(completedRounds, this.initialDelayMs, this.maxDelayMs)
          : 0
        const failedElapsedMs = Date.now() - startedAt
        const message = error instanceof Error ? error.message : String(error)
        const reason = `${candidate.id} (${candidate.config.model}) failed: ${message}; switching to ${nextCandidate.id} (${nextCandidate.config.model})`
        const attempt = ++notificationAttempt
        request.onRetry?.({
          phase: 'waiting',
          kind: 'profile_switch',
          attempt,
          maxAttempts: -1,
          delayMs,
          excludedMs: Math.max(0, failedElapsedMs - innerExcludedMs) + delayMs,
          reason,
          statusCode: error instanceof LlmRequestError ? error.diagnostics.statusCode : undefined,
          profileId: candidate.id,
          provider: candidate.config.provider,
          model: candidate.config.model,
          nextProfileId: nextCandidate.id,
          nextProvider: nextCandidate.config.provider,
          nextModel: nextCandidate.config.model,
        })
        await waitForFailover(delayMs, request.signal)
        request.onRetry?.({
          phase: 'attempting',
          kind: 'profile_switch',
          attempt,
          maxAttempts: -1,
          delayMs: 0,
          reason: `trying ${nextCandidate.id} (${nextCandidate.config.model})`,
          nextProfileId: nextCandidate.id,
          nextProvider: nextCandidate.config.provider,
          nextModel: nextCandidate.config.model,
        })
        candidateIndex = nextIndex
      }
    }
  }
}

export function createLlmService(overrides: Partial<LlmConfig> = {}): LlmService {
  const config = loadLlmConfig(overrides)
  return new LlmService(new OpenAiCompatibleProvider(config))
}

export function createFailoverLlmService(
  candidates: readonly LlmFailoverCandidate[],
  options: LlmFailoverOptions = {},
): LlmService {
  return new LlmService(new FailoverLlmProvider(candidates, options))
}
