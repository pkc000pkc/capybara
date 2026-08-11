import http from 'node:http'
import https from 'node:https'

import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmConfig,
  LlmProvider,
  LlmRetryHandler,
  LlmTextDeltaHandler,
  LlmToolCall,
  LlmUsage,
} from '#util/llm/types'

interface HttpResult {
  statusCode: number
  statusMessage: string
  text: string
}

function postJson(
  target: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const url = new URL(target)
    const transport = url.protocol === 'https:' ? https : http
    const request = transport.request(
      url,
      { method: 'POST', headers, timeout: timeoutMs },
      (response) => {
        response.setEncoding('utf8')
        let text = ''
        response.on('data', (chunk: string) => {
          text += chunk
        })
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            statusMessage: response.statusMessage ?? '',
            text,
          })
        })
      },
    )
    request.on('timeout', () => request.destroy(new Error('LLM request timed out')))
    request.on('error', reject)
    const abort = () => request.destroy(new Error('LLM request aborted'))
    signal?.addEventListener('abort', abort, { once: true })
    request.once('close', () => signal?.removeEventListener('abort', abort))
    request.end(JSON.stringify(body))
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
      reject(new Error('LLM request aborted'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function retryableStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 429 || statusCode >= 500
}

class RetryableLlmStreamError extends Error {
  readonly retryableAfterEvent = true
}

function retryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error instanceof RetryableLlmStreamError) return true
  const code = 'code' in error ? String(error.code) : ''
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)
    || /timed out|socket hang up/i.test(error.message)
}

async function waitForRetry(
  failedAttempt: number,
  maxRetries: number,
  reason: string,
  signal?: AbortSignal,
  onRetry?: LlmRetryHandler,
  statusCode?: number,
): Promise<void> {
  const delayMs = Math.min(1_000 * 2 ** (failedAttempt - 1), 8_000)
  const notification = {
    attempt: failedAttempt + 1,
    maxAttempts: maxRetries + 1,
    reason,
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
): Promise<HttpResult> {
  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let retryReason = 'Retrying model request'
    let retryStatusCode: number | undefined
    try {
      signal?.throwIfAborted()
      const result = await postJson(target, headers, body, timeoutMs, signal)
      if (!retryableStatus(result.statusCode) || attempt === maxRetries) return result
      lastError = new Error(`LLM request failed with retryable status ${result.statusCode}`)
      retryReason = `HTTP ${result.statusCode}${result.statusMessage ? ` ${result.statusMessage}` : ''}`
      retryStatusCode = result.statusCode
    } catch (error) {
      lastError = error
      if (!retryableError(error) || attempt === maxRetries) throw error
      retryReason = error instanceof Error ? error.message : String(error)
    }
    await waitForRetry(
      attempt + 1,
      maxRetries,
      retryReason,
      signal,
      onRetry,
      retryStatusCode,
    )
  }
  throw lastError
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
  body: unknown,
  timeoutMs: number,
  onEvent: (event: string, data: string) => void,
  signal?: AbortSignal,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const url = new URL(target)
    const transport = url.protocol === 'https:' ? https : http
    let settled = false
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
      { method: 'POST', headers, timeout: timeoutMs },
      (response) => {
        response.setEncoding('utf8')
        const statusCode = response.statusCode ?? 0
        const statusMessage = response.statusMessage ?? ''
        let text = ''
        if (statusCode < 200 || statusCode >= 300) {
          response.on('data', (chunk: string) => { text += chunk })
          response.on('end', () => finish({ statusCode, statusMessage, text }))
          response.on('error', fail)
          return
        }
        const decoder = new SseDecoder(onEvent)
        response.on('data', (chunk: string) => {
          try {
            decoder.push(chunk)
          } catch (error) {
            request.destroy()
            fail(error instanceof Error ? error : new Error(String(error)))
          }
        })
        response.on('end', () => {
          try {
            decoder.finish()
            finish({ statusCode, statusMessage, text: '' })
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)))
          }
        })
        response.on('error', fail)
      },
    )
    request.on('timeout', () => request.destroy(new Error('LLM request timed out')))
    request.on('error', fail)
    const abort = () => request.destroy(new Error('LLM request aborted'))
    signal?.addEventListener('abort', abort, { once: true })
    request.once('close', () => signal?.removeEventListener('abort', abort))
    request.end(JSON.stringify(body))
  })
}

async function postSseWithRetry(
  target: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  maxRetries: number,
  onEvent: (event: string, data: string) => void,
  signal?: AbortSignal,
  onRetry?: LlmRetryHandler,
): Promise<HttpResult> {
  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let receivedEvent = false
    let retryReason = 'Retrying model request'
    let retryStatusCode: number | undefined
    try {
      const result = await postSse(
        target,
        headers,
        body,
        timeoutMs,
        (event, data) => {
          receivedEvent = true
          onEvent(event, data)
        },
        signal,
      )
      if (!retryableStatus(result.statusCode) || attempt === maxRetries) return result
      lastError = new Error(`LLM request failed with retryable status ${result.statusCode}`)
      retryReason = `HTTP ${result.statusCode}${result.statusMessage ? ` ${result.statusMessage}` : ''}`
      retryStatusCode = result.statusCode
    } catch (error) {
      lastError = error
      const retryableAfterEvent = error instanceof RetryableLlmStreamError && error.retryableAfterEvent
      if ((receivedEvent && !retryableAfterEvent) || !retryableError(error) || attempt === maxRetries) throw error
      retryReason = error instanceof Error ? error.message : String(error)
    }
    await waitForRetry(
      attempt + 1,
      maxRetries,
      retryReason,
      signal,
      onRetry,
      retryStatusCode,
    )
  }
  throw lastError
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

function requestHeaders(config: LlmConfig): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    ...config.headers,
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
  constructor(private readonly config: LlmConfig) {}

  getConfig(): Readonly<LlmConfig> {
    return this.config
  }

  async stream(
    request: LlmChatRequest,
    onTextDelta: LlmTextDeltaHandler,
  ): Promise<LlmChatResponse> {
    if (!this.config.baseUrl) throw new Error('LLM base URL is required')
    return this.config.protocol === 'responses'
      ? this.responsesStream(request, onTextDelta)
      : this.chatCompletionsStream(request, onTextDelta)
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    if (!this.config.baseUrl) throw new Error('LLM base URL is required')

    if (this.config.protocol === 'responses') {
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
    )

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`LLM request failed (${response.statusCode} ${response.statusMessage}): ${response.text}`)
    }

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
    let responseModel = model
    let text = ''
    let finishReason: string | undefined
    let usage: LlmUsage | undefined
    let raw: unknown
    let receivedPayload = false
    const calls = new Map<number, { id: string; name: string; arguments: string }>()
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
      (_event, data) => {
        const payload = parseStreamData(data) as ChatCompletionChunk | undefined
        if (!payload) return
        receivedPayload = true
        raw = payload
        responseModel = payload.model ?? responseModel
        usage = usageFromResponse(payload.usage) ?? usage
        const choice = payload.choices?.[0]
        if (choice?.finish_reason) finishReason = choice.finish_reason
        const delta = choice?.delta?.content
        if (typeof delta === 'string' && delta) {
          text += delta
          onTextDelta(delta)
        }
        for (const part of choice?.delta?.tool_calls ?? []) {
          const index = part.index ?? 0
          const call = calls.get(index) ?? { id: '', name: '', arguments: '' }
          call.id = part.id ?? call.id
          call.name += part.function?.name ?? ''
          call.arguments += part.function?.arguments ?? ''
          calls.set(index, call)
        }
      },
      request.signal,
      request.onRetry,
    )
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`LLM request failed (${response.statusCode} ${response.statusMessage}): ${response.text}`)
    }
    if (!receivedPayload) throw new Error('LLM stream completed without SSE events')
    const toolCalls = [...calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => ({
        id: call.id,
        name: call.name,
        arguments: parseArguments(call.arguments, call.name),
      }))
    return {
      provider: this.config.provider,
      model: responseModel,
      text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason,
      usage,
      raw,
    }
  }

  private async responses(request: LlmChatRequest): Promise<LlmChatResponse> {
    const model = request.model ?? this.config.model
    const instructions = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n')
    const input = responsesInput(request.messages)
    const response = await postJsonWithRetry(
      `${this.config.baseUrl.replace(/\/$/, '')}/responses`,
      {
        'content-type': 'application/json',
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        ...this.config.headers,
      },
      {
        model,
        instructions: instructions || undefined,
        input,
        tools: requestTools(request.tools),
        temperature: request.temperature,
        max_output_tokens: request.maxTokens,
        store: false,
        stream: false,
      },
      this.config.timeoutMs,
      this.config.maxRetries,
      request.signal,
      request.onRetry,
    )

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`LLM request failed (${response.statusCode} ${response.statusMessage}): ${response.text}`)
    }

    const payload = JSON.parse(response.text) as ResponsesApiResponse
    const failed = responsesFailure(payload)
    if (failed) throw new Error(`LLM response failed (${failed.code}): ${failed.message}`)
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
    const instructions = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n')
    let responseModel = model
    let text = ''
    let finishReason: string | undefined
    let usage: LlmUsage | undefined
    let completed: ResponsesApiResponse | undefined
    let raw: unknown
    let receivedPayload = false
    const output = new Map<number, NonNullable<ResponsesApiResponse['output']>[number]>()
    const response = await postSseWithRetry(
      `${this.config.baseUrl.replace(/\/$/, '')}/responses`,
      requestHeaders(this.config),
      {
        model,
        instructions: instructions || undefined,
        input: responsesInput(request.messages),
        tools: requestTools(request.tools),
        temperature: request.temperature,
        max_output_tokens: request.maxTokens,
        store: false,
        stream: true,
      },
      this.config.timeoutMs,
      this.config.maxRetries,
      (eventName, data) => {
        const value = parseStreamData(data)
        if (!value) return
        const event = value as ResponsesStreamEvent
        const type = event.type ?? eventName
        receivedPayload = true
        raw = value
        if (type === 'response.created' && event.response) {
          responseModel = event.response.model ?? responseModel
        } else if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
          text += event.delta
          onTextDelta(event.delta)
        } else if (
          (type === 'response.output_item.added' || type === 'response.output_item.done') &&
          event.item
        ) {
          output.set(event.output_index ?? output.size, { ...event.item })
        } else if (type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
          const index = event.output_index ?? 0
          const item = output.get(index) ?? { type: 'function_call', arguments: '' }
          item.arguments = `${item.arguments ?? ''}${event.delta}`
          output.set(index, item)
        } else if (type === 'response.completed' && event.response) {
          completed = event.response
          responseModel = event.response.model ?? responseModel
          finishReason = event.response.status
          usage = usageFromResponsesApi(event.response.usage)
        } else if (type === 'response.failed' && event.response) {
          const failed = responsesFailure(event.response) ?? {
            code: 'response_failed',
            message: 'LLM response failed',
            retryable: false,
          }
          const message = `LLM response failed (${failed.code}): ${failed.message}`
          if (failed.retryable && !text && output.size === 0) throw new RetryableLlmStreamError(message)
          throw new Error(message)
        }
      },
      request.signal,
      request.onRetry,
    )
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`LLM request failed (${response.statusCode} ${response.statusMessage}): ${response.text}`)
    }
    if (!receivedPayload) throw new Error('LLM stream completed without SSE events')
    if (completed) {
      const completedText = textFromResponsesApi(completed)
      if (completedText.startsWith(text)) {
        const remaining = completedText.slice(text.length)
        if (remaining) onTextDelta(remaining)
        text = completedText
      }
    }
    const payload: ResponsesApiResponse = completed ?? {
      model: responseModel,
      status: finishReason,
      output: [...output.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, item]) => item),
    }
    return {
      provider: this.config.provider,
      model: payload.model ?? responseModel,
      text: text || textFromResponsesApi(payload),
      toolCalls: toolCallsFromResponsesApi(payload),
      finishReason: payload.status ?? finishReason,
      usage: usage ?? usageFromResponsesApi(payload.usage),
      raw: completed ?? raw,
    }
  }
}
