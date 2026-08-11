export type LlmProviderName = 'openai' | 'ollama' | 'deepseek' | 'custom'

export type LlmProtocol = 'responses' | 'chat-completions'

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
  attempt: number
  maxAttempts: number
  delayMs: number
  reason: string
  statusCode?: number
}

export type LlmRetryHandler = (notification: LlmRetryNotification) => void

export interface LlmChatRequest {
  messages: LlmMessage[]
  model?: string
  temperature?: number
  maxTokens?: number
  responseFormat?: 'text' | 'json'
  tools?: LlmToolDefinition[]
  signal?: AbortSignal
  onRetry?: LlmRetryHandler
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
}

export interface LlmProvider {
  chat(request: LlmChatRequest): Promise<LlmChatResponse>
  stream(request: LlmChatRequest, onTextDelta: LlmTextDeltaHandler): Promise<LlmChatResponse>
  getConfig(): Readonly<LlmConfig>
}
