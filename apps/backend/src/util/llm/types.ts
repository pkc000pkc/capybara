export type LlmProviderName = 'openai' | 'ollama' | 'deepseek' | 'custom'

export type LlmProtocol = 'responses' | 'codex-like' | 'chat-completions'

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool'

export interface LlmMessage {
  role: LlmRole
  content: string
  name?: string
  toolCallId?: string
  toolCalls?: LlmToolCall[]
}

export interface LlmToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  strict?: boolean
}

export interface LlmToolCall {
  id: string
  name: string
  arguments: unknown
}

export interface LlmUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
}

export interface LlmRetryNotification {
  phase: 'waiting' | 'attempting'
  kind?: 'request_retry' | 'profile_switch'
  attempt: number
  /** -1 indicates an unlimited number of attempts. */
  maxAttempts: number
  delayMs: number
  /** Failed request time plus scheduled backoff, excluded from task runtime budgets. */
  excludedMs?: number
  reason: string
  statusCode?: number
  profileId?: string
  provider?: LlmProviderName
  model?: string
  nextProfileId?: string
  nextProvider?: LlmProviderName
  nextModel?: string
}

export interface LlmRequestDiagnostics {
  attempt: number
  /** -1 indicates an unlimited number of attempts. */
  maxAttempts: number
  elapsedMs: number
  statusCode?: number
  requestId?: string
  responseHeaders: Record<string, string>
  payloadHash: string
  payloadBytes: number
  messageCount: number
  toolCount: number
}

export type LlmRetryHandler = (notification: LlmRetryNotification) => void

/**
 * Return a reason when a syntactically successful provider response is not
 * usable by the caller. This callback is local-only and is never serialized
 * into an OpenAI-compatible request body.
 */
/** A runtime recovery retains the candidate for repair without publishing its deltas. */
export type LlmResponseValidator = (response: LlmChatResponse) => string | { recovery: 'runtime' } | undefined

export interface LlmClientMetadata {
  sessionId?: string
  threadId?: string
  turnId?: string
}

/** Local transport admission. The serialized body is the body about to be sent. */
export interface LlmAttemptInput {
  provider: LlmProviderName
  protocol: LlmProtocol
  model: string
  serializedBody: string
  maxOutputTokens: number
  chatTemplateTokenizer?: {
    contextWindowTokens: number
    measure: () => { inputTokens: number; identity: string }
  }
}

export type LlmAttemptAdmission = (input: LlmAttemptInput) => (
  outcome: { status: 'returned' | 'failed' | 'unknown'; usage?: LlmUsage; statusCode?: number },
) => void

export interface LlmChatRequest {
  messages: LlmMessage[]
  model?: string
  temperature?: number
  maxTokens?: number
  responseFormat?: 'text' | 'json'
  tools?: LlmToolDefinition[]
  clientMetadata?: LlmClientMetadata
  signal?: AbortSignal
  onRetry?: LlmRetryHandler
  validateResponse?: LlmResponseValidator
  admitAttempt?: LlmAttemptAdmission
}

export interface LlmChatResponse {
  provider: LlmProviderName
  model: string
  text: string
  toolCalls?: LlmToolCall[]
  finishReason?: string
  usage?: LlmUsage
  raw: unknown
}

export type LlmTextDeltaHandler = (delta: string) => void

export interface LlmConfig {
  provider: LlmProviderName
  protocol: LlmProtocol
  model: string
  baseUrl: string
  apiKey?: string
  timeoutMs: number
  maxRetries: number
  headers?: Record<string, string>
  chatTemplateTokenizer?: { directory: string; contextWindowTokens: number }
}

export interface LlmProvider {
  readonly admitsTransportAttempts?: boolean
  chat(request: LlmChatRequest): Promise<LlmChatResponse>
  stream(request: LlmChatRequest, onTextDelta: LlmTextDeltaHandler): Promise<LlmChatResponse>
  getConfig(): Readonly<LlmConfig>
}
