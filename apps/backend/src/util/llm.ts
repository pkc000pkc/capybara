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
  LlmResponseValidator,
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
  /** Number of retries after the initial request before switching candidates. */
  retriesPerCandidate?: number
  initialDelayMs?: number
  maxDelayMs?: number
}

/**
 * Keep a model/provider in rotation long enough to ride out a transient
 * upstream outage. Five retries means six requests in total (the initial
 * request plus five retries) before failover is attempted.
 */
export const DEFAULT_FAILOVER_RETRIES_PER_CANDIDATE = 5

export class LlmResponseValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmResponseValidationError'
  }
}

/** Match only explicit context-window/token-limit failures, not generic input errors. */
export function isLlmContextLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /context[_\s-]*length[_\s-]*exceeded/i.test(message)
    || /maximum context length/i.test(message)
    || /(?:prompt|input) (?:is )?too (?:long|large)/i.test(message)
    || /context.{0,24}(window|length).{0,24}(exceed|limit|maximum|too (?:large|long))/i.test(message)
    || /(?:prompt|input).{0,24}(exceed|too (?:large|long)).{0,24}(?:token|context|limit)/i.test(message)
    || /too many (?:input )?tokens/i.test(message)
    || /token (?:count|length).{0,24}(exceed|limit|maximum)/i.test(message)
}

export function isLlmRequestRejection(error: unknown): boolean {
  return error instanceof LlmRequestError
    && [400, 413, 422].includes(error.diagnostics.statusCode ?? 0)
    && !isLlmContextLimitError(error)
}

function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason
  return new Error(signal?.reason ? String(signal.reason) : 'LLM request was aborted')
}

function failoverAllowed(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return false
  const message = error instanceof Error ? error.message : String(error)
  if (isLlmContextLimitError(error)) return false
  if (/tool messages require|requires request metadata|base URL is required|at least one message/i.test(message)) {
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
    this.retriesPerCandidate = options.retriesPerCandidate ?? DEFAULT_FAILOVER_RETRIES_PER_CANDIDATE
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
    return this.invoke(request, async (provider, candidateRequest) => {
      if (!request.validateResponse) return provider.stream(candidateRequest, onTextDelta)
      // Do not expose deltas from a candidate that may later fail semantic
      // validation; otherwise a fallback attempt would be appended to stale
      // output from the rejected response.
      const deltas: string[] = []
      const response = await provider.stream(candidateRequest, delta => deltas.push(delta))
      const validationFailure = request.validateResponse(response)
      if (validationFailure) {
        throw new LlmResponseValidationError(`model response validation failed: ${validationFailure}`)
      }
      for (const delta of deltas) onTextDelta(delta)
      return response
    })
  }

  private async invoke(
    request: LlmChatRequest,
    operation: (provider: OpenAiCompatibleProvider, request: LlmChatRequest) => Promise<LlmChatResponse>,
  ): Promise<LlmChatResponse> {
    let candidateIndex = this.preferredIndex
    let completedRounds = 0
    let notificationAttempt = 1
    // Transport failures are retried by OpenAiCompatibleProvider. Response
    // validation happens above that provider, so keep a separate counter for
    // syntactically successful but unusable model responses. Those responses
    // must receive the same per-candidate retry budget before failover.
    let candidateValidationRetries = 0
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
        const validationFailure = request.validateResponse?.(response)
        if (validationFailure) {
          throw new LlmResponseValidationError(`model response validation failed: ${validationFailure}`)
        }
        this.preferredIndex = candidateIndex
        return response
      } catch (error) {
        if (!failoverAllowed(error, request.signal)) throw error
        if (
          error instanceof LlmResponseValidationError
          && (this.retriesPerCandidate === -1 || candidateValidationRetries < this.retriesPerCandidate)
        ) {
          candidateValidationRetries += 1
          const delayMs = failoverDelay(candidateValidationRetries, this.initialDelayMs, this.maxDelayMs)
          const failedElapsedMs = Date.now() - startedAt
          const message = error instanceof Error ? error.message : String(error)
          const reason = `${candidate.id} (${candidate.config.model}) returned an unusable response: ${message}; retrying the same model`
          const attempt = ++notificationAttempt
          request.onRetry?.({
            phase: 'waiting',
            kind: 'request_retry',
            attempt,
            maxAttempts: this.retriesPerCandidate === -1 ? -1 : this.retriesPerCandidate + 1,
            delayMs,
            excludedMs: Math.max(0, failedElapsedMs - innerExcludedMs) + delayMs,
            reason,
            profileId: candidate.id,
            provider: candidate.config.provider,
            model: candidate.config.model,
          })
          await waitForFailover(delayMs, request.signal)
          request.onRetry?.({
            phase: 'attempting',
            kind: 'request_retry',
            attempt,
            maxAttempts: this.retriesPerCandidate === -1 ? -1 : this.retriesPerCandidate + 1,
            delayMs: 0,
            reason,
            profileId: candidate.id,
            provider: candidate.config.provider,
            model: candidate.config.model,
          })
          continue
        }
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
        candidateValidationRetries = 0
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
