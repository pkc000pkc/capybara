import { createHash, randomUUID } from 'node:crypto'
import http, { type IncomingHttpHeaders } from 'node:http'
import https from 'node:https'
import { modelProxyAgent } from './proxy.js'
import { networkDiagnostic } from './diagnostic-log.js'

import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmConfig,
  LlmProvider,
  LlmRequestDiagnostics,
  LlmRetryHandler,
  LlmTextDeltaHandler,
  LlmToolCall,
  LlmUsage,
} from '#util/llm/types'

interface HttpResult {
  statusCode: number
  statusMessage: string
  text: string
  responseHeaders: Record<string, string>
}

interface RetriedHttpResult extends HttpResult {
  diagnostics: LlmRequestDiagnostics
}

interface SerializedRequest {
  json: string
  payloadHash: string
  payloadBytes: number
  messageCount: number
  toolCount: number
}

interface RequestCounts {
  messageCount: number
  toolCount: number
}

interface CodexRequestContext {
  installationId: string
  sessionId: string
  threadId: string
  turnId: string
  windowId: string
  turnMetadata: string
}

// Compatibility fingerprint verified against the official Codex CLI wire protocol.
const CODEX_CLIENT_VERSION = '0.146.0'
const CODEX_ORIGINATOR = 'codex_exec'
const CODEX_USER_AGENT = `codex_exec/${CODEX_CLIENT_VERSION} (Windows 10.0.26200; x86_64) dumb (codex_exec; ${CODEX_CLIENT_VERSION})`
const CODEX_BETA_FEATURES = 'remote_compaction_v2'

const SAFE_RESPONSE_HEADERS = new Set([
  'cf-ray',
  'date',
  'request-id',
  'retry-after',
  'server',
  'server-timing',
  'traceparent',
  'via',
  'x-correlation-id',
  'x-envoy-upstream-service-time',
  'x-openai-request-id',
  'x-request-id',
  'x-response-time',
])

const REQUEST_ID_HEADERS = [
  'x-request-id',
  'x-openai-request-id',
  'request-id',
  'x-correlation-id',
  'traceparent',
  'cf-ray',
]

function safeResponseHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase()
    if (!SAFE_RESPONSE_HEADERS.has(normalized) || value === undefined) continue
    result[normalized] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return result
}

function serializeRequest(body: unknown, counts?: RequestCounts): SerializedRequest {
  const json = JSON.stringify(body)
  if (json === undefined) throw new Error('LLM request body cannot be serialized')
  const record = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {}
  const messages = Array.isArray(record.messages)
    ? record.messages
    : Array.isArray(record.input)
      ? record.input
      : []
  const tools = Array.isArray(record.tools) ? record.tools : []
  return {
    json,
    payloadHash: createHash('sha256').update(json).digest('hex'),
    payloadBytes: Buffer.byteLength(json),
    messageCount: counts?.messageCount ?? messages.length,
    toolCount: counts?.toolCount ?? tools.length,
  }
}

function requestDiagnostics(
  request: SerializedRequest,
  attempt: number,
  maxRetries: number,
  startedAt: number,
  statusCode?: number,
  responseHeaders: Record<string, string> = {},
): LlmRequestDiagnostics {
  const requestId = REQUEST_ID_HEADERS
    .map((name) => responseHeaders[name])
    .find((value) => Boolean(value))
  return {
    attempt,
    maxAttempts: maxRetries === -1 ? -1 : maxRetries + 1,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(requestId ? { requestId } : {}),
    responseHeaders,
    payloadHash: request.payloadHash,
    payloadBytes: request.payloadBytes,
    messageCount: request.messageCount,
    toolCount: request.toolCount,
  }
}

export class LlmRequestError extends Error {
  constructor(
    message: string,
    readonly diagnostics: LlmRequestDiagnostics,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'LlmRequestError'
  }
}

class HttpAttemptError extends Error {
  constructor(
    error: Error,
    readonly statusCode?: number,
    readonly responseHeaders: Record<string, string> = {},
  ) {
    super(error.message, { cause: error })
    this.name = error.name
  }
}

function finalRequestError(
  error: unknown,
  request: SerializedRequest,
  attempt: number,
  maxRetries: number,
  startedAt: number,
): LlmRequestError {
  if (error instanceof LlmRequestError) return error
  const attemptError = error instanceof HttpAttemptError ? error : undefined
  const message = error instanceof Error ? error.message : String(error)
  return new LlmRequestError(
    message,
    requestDiagnostics(
      request,
      attempt,
      maxRetries,
      startedAt,
      attemptError?.statusCode,
      attemptError?.responseHeaders,
    ),
    error,
  )
}

function httpResultError(
  result: HttpResult,
  request: SerializedRequest,
  attempt: number,
  maxRetries: number,
  startedAt: number,
  message = `LLM request failed (${result.statusCode} ${result.statusMessage}): ${result.text}`,
): LlmRequestError {
  return new LlmRequestError(
    message,
    requestDiagnostics(
      request,
      attempt,
      maxRetries,
      startedAt,
      result.statusCode,
      result.responseHeaders,
    ),
  )
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason
  return new Error(signal?.reason === undefined ? 'LLM request aborted' : String(signal.reason))
}

function postJson(
  target: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const diagnostic = networkDiagnostic(body, signal)
    const url = new URL(target)
    const transport = url.protocol === 'https:' ? https : http
    const request = transport.request(
      url,
      { method: 'POST', headers, timeout: timeoutMs, agent: modelProxyAgent },
      (response) => {
        response.setEncoding('utf8')
        const statusCode = response.statusCode ?? 0
        const responseHeaders = safeResponseHeaders(response.headers)
        diagnostic.headers(statusCode, responseHeaders['x-request-id'] ?? responseHeaders['request-id'])
        response.on('data', (chunk: string) => diagnostic.data(chunk))
        response.on('end', () => diagnostic.close('http.completed', { statusCode }))
        response.on('error', () => diagnostic.close('http.response_error', { statusCode }))
        let text = ''
        response.on('data', (chunk: string) => {
          text += chunk
        })
        response.on('end', () => {
          resolve({
            statusCode,
            statusMessage: response.statusMessage ?? '',
            text,
            responseHeaders,
          })
        })
        response.on('error', (error) => reject(new HttpAttemptError(error, statusCode, responseHeaders)))
      },
    )
    request.on('timeout', () => request.destroy(new Error('LLM request timed out')))
    request.on('error', reject)
    request.on('error', (error: NodeJS.ErrnoException) => diagnostic.close('http.failed', { code: error.code ?? error.name }))
    request.once('close', () => diagnostic.close('http.closed'))
    const abort = () => request.destroy(abortError(signal))
    signal?.addEventListener('abort', abort, { once: true })
    request.once('close', () => signal?.removeEventListener('abort', abort))
    request.end(body)
  })
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const done = () => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(done, ms)
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(abortError(signal))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

const PERMANENT_CLIENT_ERROR_STATUSES = new Set([
  400, 401, 402, 404, 405, 406, 407, 410, 411, 412, 413, 414, 415, 416,
  417, 418, 421, 422, 426, 428, 431, 451,
])

export function retryableLlmStatus(statusCode: number): boolean {
  if (statusCode >= 500 && statusCode <= 599) return true
  return statusCode >= 400
    && statusCode <= 499
    && !PERMANENT_CLIENT_ERROR_STATUSES.has(statusCode)
}

function canRetry(failedAttempt: number, maxRetries: number): boolean {
  return maxRetries === -1 || failedAttempt <= maxRetries
}

export function retryDelayMs(failedAttempt: number, randomValue = Math.random()): number {
  // Infinite provider retries use a bounded probe interval. The request's
  // wall-clock budget is accounted for by the caller; deterministic context
  // errors never enter this path.
  const exponent = Math.min(Math.max(failedAttempt - 1, 0), 8)
  const baseDelayMs = Math.min(1_000 * 2 ** exponent, 180_000)
  const boundedRandom = Math.max(0, Math.min(1, randomValue))
  return Math.round(baseDelayMs * (0.5 + boundedRandom * 0.5))
}

class RetryableLlmStreamError extends Error {
  readonly retryableAfterEvent = true
}

function retryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error instanceof HttpAttemptError) return retryableError(error.cause)
  if (error instanceof RetryableLlmStreamError) return true
  const code = 'code' in error ? String(error.code) : ''
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)
    || /timed out|socket hang up/i.test(error.message)
}

async function waitForRetry(
  failedAttempt: number,
  maxRetries: number,
  reason: string,
  failedRequestMs: number,
  signal?: AbortSignal,
  onRetry?: LlmRetryHandler,
  statusCode?: number,
): Promise<void> {
  const delayMs = retryDelayMs(failedAttempt)
  const notification = {
    attempt: failedAttempt + 1,
    maxAttempts: maxRetries === -1 ? -1 : maxRetries + 1,
    reason,
    excludedMs: Math.max(0, failedRequestMs) + delayMs,
    ...(statusCode === undefined ? {} : { statusCode }),
  }
  onRetry?.({ ...notification, phase: 'waiting', delayMs })
  await sleep(delayMs, signal)
  onRetry?.({ ...notification, phase: 'attempting', delayMs: 0 })
}

async function postJsonWithRetry(
  target: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  maxRetries: number,
  signal?: AbortSignal,
  onRetry?: LlmRetryHandler,
  retryableResponse?: (result: HttpResult) => string | undefined,
  counts?: RequestCounts,
): Promise<RetriedHttpResult> {
  const serialized = serializeRequest(body, counts)
  const startedAt = Date.now()
  for (let attempt = 0; ; attempt += 1) {
    const attemptStartedAt = Date.now()
    const failedAttempt = attempt + 1
    let result: HttpResult
    try {
      signal?.throwIfAborted()
      result = await postJson(target, headers, serialized.json, timeoutMs, signal)
    } catch (error) {
      if (!retryableError(error) || !canRetry(failedAttempt, maxRetries)) {
        throw finalRequestError(error, serialized, failedAttempt, maxRetries, startedAt)
      }
      await waitForRetry(
        failedAttempt,
        maxRetries,
        error instanceof Error ? error.message : String(error),
        Date.now() - attemptStartedAt,
        signal,
        onRetry,
      )
      continue
    }
    const successfulHttp = result.statusCode >= 200 && result.statusCode < 300
    const semanticRetryReason = successfulHttp
      ? (result.text.trim() ? retryableResponse?.(result) : 'empty_response_body')
      : undefined
    if (successfulHttp && !semanticRetryReason) {
      return {
        ...result,
        diagnostics: requestDiagnostics(
          serialized,
          failedAttempt,
          maxRetries,
          startedAt,
          result.statusCode,
          result.responseHeaders,
        ),
      }
    }
    const retryReason = semanticRetryReason
      ?? `HTTP ${result.statusCode}${result.statusMessage ? ` ${result.statusMessage}` : ''}`
    if (
      (!semanticRetryReason && !retryableLlmStatus(result.statusCode))
      || !canRetry(failedAttempt, maxRetries)
    ) {
      throw httpResultError(result, serialized, failedAttempt, maxRetries, startedAt, semanticRetryReason)
    }
    await waitForRetry(
      failedAttempt,
      maxRetries,
      retryReason,
      Date.now() - attemptStartedAt,
      signal,
      onRetry,
      semanticRetryReason ? undefined : result.statusCode,
    )
  }
}

class SseDecoder {
  private buffer = ''
  private event = ''
  private data: string[] = []

  constructor(private readonly handler: (event: string, data: string) => void) {}

  push(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      this.line(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  finish(): void {
    if (this.buffer) this.line(this.buffer.replace(/\r$/, ''))
    this.dispatch()
  }

  private line(line: string): void {
    if (!line) {
      this.dispatch()
    } else if (line.startsWith('event:')) {
      this.event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      this.data.push(line.slice(5).replace(/^ /, ''))
    }
  }

  private dispatch(): void {
    if (this.data.length > 0) this.handler(this.event, this.data.join('\n'))
    this.event = ''
    this.data = []
  }
}

function postSse(
  target: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  onEvent: (event: string, data: string) => void,
  signal?: AbortSignal,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const url = new URL(target)
    const transport = url.protocol === 'https:' ? https : http
    let settled = false
    const diagnostic = networkDiagnostic(body, signal)
    const finish = (result: HttpResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const request = transport.request(
      url,
      { method: 'POST', headers, timeout: timeoutMs, agent: modelProxyAgent },
      (response) => {
        response.setEncoding('utf8')
        const statusCode = response.statusCode ?? 0
        const statusMessage = response.statusMessage ?? ''
        const responseHeaders = safeResponseHeaders(response.headers)
        diagnostic.headers(statusCode, responseHeaders['x-request-id'] ?? responseHeaders['request-id'])
        response.on('data', (chunk: string) => diagnostic.data(chunk))
        response.on('end', () => diagnostic.close('http.completed', { statusCode }))
        response.on('error', () => diagnostic.close('http.response_error', { statusCode }))
        let text = ''
        if (statusCode < 200 || statusCode >= 300) {
          response.on('data', (chunk: string) => { text += chunk })
          response.on('end', () => finish({ statusCode, statusMessage, text, responseHeaders }))
          response.on('error', (error) => fail(new HttpAttemptError(error, statusCode, responseHeaders)))
          return
        }
        const decoder = new SseDecoder((event, data) => { diagnostic.sse(); onEvent(event, data) })
        response.on('data', (chunk: string) => {
          try {
            decoder.push(chunk)
          } catch (error) {
            request.destroy()
            const normalized = error instanceof Error ? error : new Error(String(error))
            fail(new HttpAttemptError(normalized, statusCode, responseHeaders))
          }
        })
        response.on('end', () => {
          try {
            decoder.finish()
            finish({ statusCode, statusMessage, text: '', responseHeaders })
          } catch (error) {
            const normalized = error instanceof Error ? error : new Error(String(error))
            fail(new HttpAttemptError(normalized, statusCode, responseHeaders))
          }
        })
        response.on('error', (error) => fail(new HttpAttemptError(error, statusCode, responseHeaders)))
      },
    )
    request.on('timeout', () => request.destroy(new Error('LLM request timed out')))
    request.on('error', fail)
    request.on('error', (error: NodeJS.ErrnoException) => diagnostic.close('http.failed', { code: error.code ?? error.name }))
    request.once('close', () => diagnostic.close('http.closed'))
    const abort = () => request.destroy(abortError(signal))
    signal?.addEventListener('abort', abort, { once: true })
    request.once('close', () => signal?.removeEventListener('abort', abort))
    request.end(body)
  })
}

interface SseRetryController {
  onAttemptStart(): void
  onEvent(event: string, data: string): void
  hasReceivedPayload(): boolean
  hasCompletedPayload(): boolean
  hasExposedOutput(): boolean
}

async function postSseWithRetry(
  target: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  maxRetries: number,
  controller: SseRetryController,
  signal?: AbortSignal,
  onRetry?: LlmRetryHandler,
  counts?: RequestCounts,
): Promise<RetriedHttpResult> {
  const serialized = serializeRequest(body, counts)
  const startedAt = Date.now()
  for (let attempt = 0; ; attempt += 1) {
    const attemptStartedAt = Date.now()
    const failedAttempt = attempt + 1
    controller.onAttemptStart()
    let result: HttpResult
    try {
      result = await postSse(
        target,
        headers,
        serialized.json,
        timeoutMs,
        (event, data) => controller.onEvent(event, data),
        signal,
      )
    } catch (error) {
      if (
        controller.hasExposedOutput()
        || !retryableError(error)
        || !canRetry(failedAttempt, maxRetries)
      ) {
        throw finalRequestError(error, serialized, failedAttempt, maxRetries, startedAt)
      }
      await waitForRetry(
        failedAttempt,
        maxRetries,
        error instanceof Error ? error.message : String(error),
        Date.now() - attemptStartedAt,
        signal,
        onRetry,
        error instanceof HttpAttemptError && (error.statusCode ?? 0) >= 400
          ? error.statusCode
          : undefined,
      )
      continue
    }
    if (result.statusCode >= 200 && result.statusCode < 300) {
      if (!controller.hasReceivedPayload() || !controller.hasCompletedPayload()) {
        const error = new RetryableLlmStreamError('LLM stream ended before a completion event')
        if (controller.hasExposedOutput() || !canRetry(failedAttempt, maxRetries)) {
          throw finalRequestError(error, serialized, failedAttempt, maxRetries, startedAt)
        }
        await waitForRetry(
          failedAttempt, maxRetries, error.message, Date.now() - attemptStartedAt, signal, onRetry,
        )
        continue
      }
      return {
        ...result,
        diagnostics: requestDiagnostics(
          serialized,
          failedAttempt,
          maxRetries,
          startedAt,
          result.statusCode,
          result.responseHeaders,
        ),
      }
    }
    if (!retryableLlmStatus(result.statusCode) || !canRetry(failedAttempt, maxRetries)) {
      throw httpResultError(result, serialized, failedAttempt, maxRetries, startedAt)
    }
    await waitForRetry(
      failedAttempt,
      maxRetries,
      `HTTP ${result.statusCode}${result.statusMessage ? ` ${result.statusMessage}` : ''}`,
      Date.now() - attemptStartedAt,
      signal,
      onRetry,
      result.statusCode,
    )
  }
}

interface OpenAiResponse {
  model?: string
  choices?: Array<{
    finish_reason?: string
    message?: {
      content?: string
      tool_calls?: Array<{
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

interface ResponsesApiResponse {
  model?: string
  status?: string
  error?: {
    code?: string
    message?: string
  }
  output_text?: string
  output?: Array<{
    type?: string
    id?: string
    call_id?: string
    name?: string
    arguments?: string
    content?: Array<{
      type?: string
      text?: string
    }>
  }>
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
    input_tokens_details?: {
      cached_tokens?: number
    }
  }
}

interface ChatCompletionChunk {
  model?: string
  choices?: Array<{
    finish_reason?: string | null
    delta?: {
      content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
  }>
  usage?: OpenAiResponse['usage']
}

interface ResponsesStreamEvent {
  type?: string
  delta?: string
  output_index?: number
  item?: NonNullable<ResponsesApiResponse['output']>[number]
  response?: ResponsesApiResponse
}

function endpoint(baseUrl: string): string {
  if (/\/chat\/completions\/?$/i.test(baseUrl)) return baseUrl
  return `${baseUrl.replace(/\/$/, '')}/chat/completions`
}

function usageFromResponse(usage: OpenAiResponse['usage']): LlmUsage | undefined {
  if (!usage) return undefined
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  }
}

function usageFromResponsesApi(usage: ResponsesApiResponse['usage']): LlmUsage | undefined {
  if (!usage) return undefined
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    cacheReadTokens: usage.input_tokens_details?.cached_tokens,
  }
}

function textFromResponsesApi(payload: ResponsesApiResponse): string {
  if (payload.output_text) return payload.output_text
  return (payload.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === 'output_text' && item.text)
    .map((item) => item.text)
    .join('')
}

function responsesFailure(payload: ResponsesApiResponse): { code: string; message: string; retryable: boolean } | undefined {
  if (payload.status !== 'failed' && !payload.error) return undefined
  const code = payload.error?.code ?? 'response_failed'
  return {
    code,
    message: payload.error?.message ?? 'LLM response failed',
    retryable: [
      'server_error',
      'internal_server_error',
      'server_is_overloaded',
      'rate_limit_exceeded',
      'temporarily_unavailable',
      'upstream_error',
      'bad_response_status_code',
    ].includes(code),
  }
}

function parseArguments(value: string | undefined, toolName: string): unknown {
  try {
    return JSON.parse(value || '{}')
  } catch {
    throw new Error(`LLM returned invalid JSON arguments for tool ${toolName}`)
  }
}

function toolCallsFromResponsesApi(payload: ResponsesApiResponse): LlmToolCall[] {
  return (payload.output ?? [])
    .filter((item) => item.type === 'function_call' && item.name)
    .map((item) => ({
      id: item.call_id ?? item.id ?? '',
      name: item.name as string,
      arguments: parseArguments(item.arguments, item.name as string),
    }))
}

function responsesInput(messages: LlmChatRequest['messages']): unknown[] {
  return messages.flatMap((message) => {
    if (message.role === 'system') return []
    if (message.role === 'tool') {
      if (!message.toolCallId) throw new Error('tool messages require toolCallId')
      return [{
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: message.content,
      }]
    }
    const items: unknown[] = message.content
      ? [{ role: message.role, content: message.content }]
      : []
    for (const call of message.toolCalls ?? []) {
      items.push({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      })
    }
    return items
  })
}

function codexLikeResponsesInput(messages: LlmChatRequest['messages']): unknown[] {
  return messages.flatMap((message) => {
    if (message.role === 'system') return []
    if (message.role === 'tool') {
      if (!message.toolCallId) throw new Error('tool messages require toolCallId')
      return [{
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: message.content,
      }]
    }
    const items: unknown[] = []
    if (message.content) {
      items.push({
        type: 'message',
        role: message.role,
        content: [{
          type: message.role === 'assistant' ? 'output_text' : 'input_text',
          text: message.content,
        }],
      })
    }
    for (const call of message.toolCalls ?? []) {
      items.push({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      })
    }
    return items
  })
}

function chatMessages(messages: LlmChatRequest['messages']): unknown[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      if (!message.toolCallId) throw new Error('tool messages require toolCallId')
      return {
        role: 'tool',
        content: message.content,
        tool_call_id: message.toolCallId,
      }
    }
    return {
      role: message.role,
      content: message.content || null,
      ...(message.name ? { name: message.name } : {}),
      ...(message.toolCalls?.length ? {
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      } : {}),
    }
  })
}

function requestTools(tools: LlmChatRequest['tools']) {
  return tools?.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.strict === undefined ? {} : { strict: tool.strict }),
  }))
}

function createCodexRequestContext(
  request: LlmChatRequest,
  installationId: string,
  defaultSessionId: string,
): CodexRequestContext {
  const sessionId = request.clientMetadata?.sessionId?.trim() || defaultSessionId
  const threadId = request.clientMetadata?.threadId?.trim() || sessionId
  const turnId = request.clientMetadata?.turnId?.trim() || randomUUID()
  const windowId = `${sessionId}:0`
  return {
    installationId,
    sessionId,
    threadId,
    turnId,
    windowId,
    turnMetadata: JSON.stringify({
      installation_id: installationId,
      session_id: sessionId,
      thread_id: threadId,
      turn_id: turnId,
      window_id: windowId,
      request_kind: 'turn',
      thread_source: 'user',
      sandbox: 'none',
      turn_started_at_unix_ms: 0,
    }),
  }
}

function requestHeaders(
  config: LlmConfig,
  codexContext?: CodexRequestContext,
  stream = true,
): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(stream || codexContext ? { accept: 'text/event-stream' } : {}),
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    ...(codexContext
      ? {
          originator: CODEX_ORIGINATOR,
          'user-agent': CODEX_USER_AGENT,
          'x-openai-internal-codex-responses-lite': 'true',
          'x-client-request-id': codexContext.sessionId,
          'session-id': codexContext.sessionId,
          'thread-id': codexContext.threadId,
          'x-codex-window-id': codexContext.windowId,
          'x-codex-turn-metadata': codexContext.turnMetadata,
          'x-codex-beta-features': CODEX_BETA_FEATURES,
        }
      : {}),
    ...config.headers,
  }
}

function responsesRequestBody(
  config: LlmConfig,
  request: LlmChatRequest,
  model: string,
  instructions: string,
  codexContext: CodexRequestContext | undefined,
  stream: boolean,
): Record<string, unknown> {
  const codexLike = config.protocol === 'codex-like'
  if (codexLike && !codexContext) throw new Error('Codex-like requests require request metadata')
  return {
    model,
    instructions: instructions || undefined,
    input: codexLike
      ? codexLikeResponsesInput(request.messages)
      : responsesInput(request.messages),
    tools: requestTools(request.tools),
    ...(codexLike
      ? {
          tool_choice: 'auto',
          parallel_tool_calls: false,
          reasoning: { effort: 'medium', context: 'all_turns', summary: 'auto' },
          text: { verbosity: 'low' },
          include: ['reasoning.encrypted_content'],
          prompt_cache_key: codexContext?.sessionId,
          client_metadata: {
            installation_id: codexContext?.installationId,
            session_id: codexContext?.sessionId,
            thread_id: codexContext?.threadId,
            turn_id: codexContext?.turnId,
            window_id: codexContext?.windowId,
          },
        }
      : { temperature: request.temperature }),
    max_output_tokens: request.maxTokens,
    store: false,
    stream,
  }
}

function parseStreamData(data: string): Record<string, unknown> | undefined {
  if (data === '[DONE]') return undefined
  try {
    return JSON.parse(data) as Record<string, unknown>
  } catch {
    throw new Error(`LLM stream returned invalid JSON event: ${data.slice(0, 200)}`)
  }
}

export class OpenAiCompatibleProvider implements LlmProvider {
  private readonly codexInstallationId = randomUUID()
  private readonly codexSessionId = randomUUID()

  constructor(private readonly config: LlmConfig) {}

  getConfig(): Readonly<LlmConfig> {
    return this.config
  }

  async stream(
    request: LlmChatRequest,
    onTextDelta: LlmTextDeltaHandler,
  ): Promise<LlmChatResponse> {
    if (!this.config.baseUrl) throw new Error('LLM base URL is required')
    return this.config.protocol !== 'chat-completions'
      ? this.responsesStream(request, onTextDelta)
      : this.chatCompletionsStream(request, onTextDelta)
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    if (!this.config.baseUrl) throw new Error('LLM base URL is required')

    if (this.config.protocol !== 'chat-completions') {
      return this.responses(request)
    }

    const model = request.model ?? this.config.model
    const response = await postJsonWithRetry(
      endpoint(this.config.baseUrl),
      {
        'content-type': 'application/json',
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        ...this.config.headers,
      },
      {
        model,
        messages: chatMessages(request.messages),
        tools: request.tools?.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            ...(tool.strict === undefined ? {} : { strict: tool.strict }),
          },
        })),
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        response_format:
          request.responseFormat === 'json' ? { type: 'json_object' } : undefined,
        stream: false,
      },
      this.config.timeoutMs,
      this.config.maxRetries,
      request.signal,
      request.onRetry,
      (result) => {
        try {
          JSON.parse(result.text)
          return undefined
        } catch {
          return 'invalid_json_response'
        }
      },
      { messageCount: request.messages.length, toolCount: request.tools?.length ?? 0 },
    )

    const payload = JSON.parse(response.text) as OpenAiResponse
    const choice = payload.choices?.[0]
    const toolCalls = (choice?.message?.tool_calls ?? []).map((call) => {
      const name = call.function?.name ?? ''
      return {
        id: call.id ?? '',
        name,
        arguments: parseArguments(call.function?.arguments, name),
      }
    })
    return {
      provider: this.config.provider,
      model: payload.model ?? model,
      text: choice?.message?.content ?? '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: choice?.finish_reason,
      usage: usageFromResponse(payload.usage),
      raw: payload,
    }
  }

  private async chatCompletionsStream(
    request: LlmChatRequest,
    onTextDelta: LlmTextDeltaHandler,
  ): Promise<LlmChatResponse> {
    const model = request.model ?? this.config.model
    type AttemptState = {
      responseModel: string
      text: string
      finishReason?: string
      usage?: LlmUsage
      raw?: unknown
      receivedPayload: boolean
      completed: boolean
      calls: Map<number, { id: string; name: string; arguments: string }>
    }
    const newAttemptState = (): AttemptState => ({
      responseModel: model,
      text: '',
      receivedPayload: false,
      completed: false,
      calls: new Map(),
    })
    let state = newAttemptState()
    const response = await postSseWithRetry(
      endpoint(this.config.baseUrl),
      requestHeaders(this.config),
      {
        model,
        messages: chatMessages(request.messages),
        tools: request.tools?.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            ...(tool.strict === undefined ? {} : { strict: tool.strict }),
          },
        })),
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        response_format:
          request.responseFormat === 'json' ? { type: 'json_object' } : undefined,
        stream: true,
        stream_options: { include_usage: true },
      },
      this.config.timeoutMs,
      this.config.maxRetries,
      {
        onAttemptStart() {
          state = newAttemptState()
        },
        onEvent(_event, data) {
          if (data === '[DONE]') {
            state.receivedPayload = true
            state.completed = true
            return
          }
          const payload = parseStreamData(data) as ChatCompletionChunk | undefined
          if (!payload) return
          state.receivedPayload = true
          state.raw = payload
          state.responseModel = payload.model ?? state.responseModel
          state.usage = usageFromResponse(payload.usage) ?? state.usage
          const choice = payload.choices?.[0]
          if (choice?.finish_reason) state.finishReason = choice.finish_reason
          const delta = choice?.delta?.content
          if (typeof delta === 'string' && delta) {
            state.text += delta
          }
          for (const part of choice?.delta?.tool_calls ?? []) {
            const index = part.index ?? 0
            const call = state.calls.get(index) ?? { id: '', name: '', arguments: '' }
            call.id = part.id ?? call.id
            call.name += part.function?.name ?? ''
            call.arguments += part.function?.arguments ?? ''
            state.calls.set(index, call)
          }
        },
        hasExposedOutput() {
          return false
        },
        hasReceivedPayload() {
          return state.receivedPayload
        },
        hasCompletedPayload() {
          return state.completed || state.finishReason !== undefined
        },
      },
      request.signal,
      request.onRetry,
      { messageCount: request.messages.length, toolCount: request.tools?.length ?? 0 },
    )
    if (!state.receivedPayload) {
      throw new LlmRequestError('LLM stream completed without SSE events', response.diagnostics)
    }
    if (state.text) onTextDelta(state.text)
    const toolCalls = [...state.calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => ({
        id: call.id,
        name: call.name,
        arguments: parseArguments(call.arguments, call.name),
      }))
    return {
      provider: this.config.provider,
      model: state.responseModel,
      text: state.text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: state.finishReason,
      usage: state.usage,
      raw: state.raw,
    }
  }

  private async responses(request: LlmChatRequest): Promise<LlmChatResponse> {
    const model = request.model ?? this.config.model
    const codexContext = this.config.protocol === 'codex-like'
      ? createCodexRequestContext(request, this.codexInstallationId, this.codexSessionId)
      : undefined
    const instructions = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n')
    const response = await postJsonWithRetry(
      `${this.config.baseUrl.replace(/\/$/, '')}/responses`,
      requestHeaders(this.config, codexContext, false),
      responsesRequestBody(
        this.config,
        request,
        model,
        instructions,
        codexContext,
        false,
      ),
      this.config.timeoutMs,
      this.config.maxRetries,
      request.signal,
      request.onRetry,
      (result) => {
        try {
          const failed = responsesFailure(JSON.parse(result.text) as ResponsesApiResponse)
          return failed?.retryable
            ? `LLM response failed (${failed.code}): ${failed.message}`
            : undefined
        } catch {
          return 'invalid_json_response'
        }
      },
      { messageCount: request.messages.length, toolCount: request.tools?.length ?? 0 },
    )

    const payload = JSON.parse(response.text) as ResponsesApiResponse
    const failed = responsesFailure(payload)
    if (failed) {
      throw new LlmRequestError(
        `LLM response failed (${failed.code}): ${failed.message}`,
        response.diagnostics,
      )
    }
    return {
      provider: this.config.provider,
      model: payload.model ?? model,
      text: textFromResponsesApi(payload),
      toolCalls: toolCallsFromResponsesApi(payload),
      finishReason: payload.status,
      usage: usageFromResponsesApi(payload.usage),
      raw: payload,
    }
  }

  private async responsesStream(
    request: LlmChatRequest,
    onTextDelta: LlmTextDeltaHandler,
  ): Promise<LlmChatResponse> {
    const model = request.model ?? this.config.model
    const codexContext = this.config.protocol === 'codex-like'
      ? createCodexRequestContext(request, this.codexInstallationId, this.codexSessionId)
      : undefined
    const instructions = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n')
    type AttemptState = {
      responseModel: string
      text: string
      finishReason?: string
      usage?: LlmUsage
      completed?: ResponsesApiResponse
      raw?: unknown
      receivedPayload: boolean
      streamDone: boolean
      output: Map<number, NonNullable<ResponsesApiResponse['output']>[number]>
    }
    const newAttemptState = (): AttemptState => ({
      responseModel: model,
      text: '',
      receivedPayload: false,
      streamDone: false,
      output: new Map(),
    })
    let state = newAttemptState()
    const response = await postSseWithRetry(
      `${this.config.baseUrl.replace(/\/$/, '')}/responses`,
      requestHeaders(this.config, codexContext),
      responsesRequestBody(
        this.config,
        request,
        model,
        instructions,
        codexContext,
        true,
      ),
      this.config.timeoutMs,
      this.config.maxRetries,
      {
        onAttemptStart() {
          state = newAttemptState()
        },
        onEvent(eventName, data) {
          if (data === '[DONE]') {
            state.receivedPayload = true
            state.streamDone = true
            return
          }
          const value = parseStreamData(data)
          if (!value) return
          const event = value as ResponsesStreamEvent
          const type = event.type ?? eventName
          state.receivedPayload = true
          state.raw = value
          if (type === 'response.created' && event.response) {
            state.responseModel = event.response.model ?? state.responseModel
          } else if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
            state.text += event.delta
          } else if (
            (type === 'response.output_item.added' || type === 'response.output_item.done') &&
            event.item
          ) {
            state.output.set(event.output_index ?? state.output.size, { ...event.item })
          } else if (type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
            const index = event.output_index ?? 0
            const item = state.output.get(index) ?? { type: 'function_call', arguments: '' }
            item.arguments = `${item.arguments ?? ''}${event.delta}`
            state.output.set(index, item)
          } else if (type === 'response.completed' && event.response) {
            state.completed = event.response
            state.responseModel = event.response.model ?? state.responseModel
            state.finishReason = event.response.status
            state.usage = usageFromResponsesApi(event.response.usage)
          } else if (type === 'response.failed' && event.response) {
            const failed = responsesFailure(event.response) ?? {
              code: 'response_failed',
              message: 'LLM response failed',
              retryable: false,
            }
            const message = `LLM response failed (${failed.code}): ${failed.message}`
            if (failed.retryable) throw new RetryableLlmStreamError(message)
            throw new Error(message)
          }
        },
        hasExposedOutput() {
          return false
        },
        hasReceivedPayload() {
          return state.receivedPayload
        },
        hasCompletedPayload() {
          return state.completed !== undefined
            || (state.streamDone && (state.text.length > 0 || state.output.size > 0))
        },
      },
      request.signal,
      request.onRetry,
      { messageCount: request.messages.length, toolCount: request.tools?.length ?? 0 },
    )
    if (!state.receivedPayload) {
      throw new LlmRequestError('LLM stream completed without SSE events', response.diagnostics)
    }
    if (state.completed) {
      const completedText = textFromResponsesApi(state.completed)
      if (completedText) state.text = completedText
    }
    if (state.text) onTextDelta(state.text)
    const payload: ResponsesApiResponse = state.completed ?? {
      model: state.responseModel,
      status: state.finishReason,
      output: [...state.output.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, item]) => item),
    }
    return {
      provider: this.config.provider,
      model: payload.model ?? state.responseModel,
      text: state.text || textFromResponsesApi(payload),
      toolCalls: toolCallsFromResponsesApi(payload),
      finishReason: payload.status ?? state.finishReason,
      usage: state.usage ?? usageFromResponsesApi(payload.usage),
      raw: state.completed ?? state.raw,
    }
  }
}
