import http from 'node:http'
import https from 'node:https'
import type { JsonObject, JsonValue, RuntimeCapabilityBinding } from '#protocol/runtime-protocol'
import { toJsonValue } from '#core/runtime-loop-utils'
import { isLoopbackModelHost, modelProxyAgent } from '#util/llm/proxy'

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const PROTOCOL = 'capybara.a2a.child.v1'

export interface HttpChildAgentHostInput {
  goal: string
  prompt: string
  projectPath: string
  parentContext: string
  parentSessionId?: string
  parentTaskId: string
  parentRunId?: string
  parentStepId?: string
  planTaskId?: string
  callId: string
  childId: string
  childSessionId: string
  signal: AbortSignal
  allowedCapabilityIds: string[]
  allowedCapabilities?: RuntimeCapabilityBinding[]
  executionMode?: 'readonly' | 'action'
  attemptId?: string
  maxModelRounds: number
  maxToolRounds: number
  maxTotalTokens: number
  llm?: unknown
}

export interface HttpChildAgentHostResult {
  ok: boolean
  output?: JsonValue
  evidence?: JsonValue
  actionReceipts?: JsonValue
  error?: { code: string; message: string; details?: JsonValue }
  startedAt?: string
  completedAt?: string
  durationMs?: number
}

export interface HttpChildAgentHostOptions {
  url: string | URL
  headers?: Record<string, string> | (() => Record<string, string>)
  timeoutMs?: number
  maxResponseBytes?: number
  fetch?: typeof globalThis.fetch
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(jsonValue)
  return isObject(value) && Object.values(value).every(jsonValue)
}

function errorResult(code: string, message: string, details?: JsonValue): HttpChildAgentHostResult {
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } }
}

function boundedHeaders(input: HttpChildAgentHostOptions): Record<string, string> {
  const headers = typeof input.headers === 'function' ? input.headers() : input.headers ?? {}
  const result: Record<string, string> = { ...headers, 'content-type': 'application/json' }
  for (const key of Object.keys(result)) {
    if (['content-length', 'host', 'connection'].includes(key.toLowerCase())) delete result[key]
  }
  return result
}

async function readResponse(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!response.body) {
    const text = await response.text()
    if (Buffer.byteLength(text) > maxBytes) throw new Error('CHILD_HOST_RESPONSE_TOO_LARGE')
    return text
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      if (signal.aborted) throw new Error('CHILD_HOST_ABORTED')
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new Error('CHILD_HOST_RESPONSE_TOO_LARGE')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(body)
}

function fetchChildThroughNode(target: URL, init?: RequestInit): Promise<Response> {
  const headers = Object.fromEntries(new Headers(init?.headers).entries())
  const body = init?.body
  const bodyBytes = body === undefined || body === null ? undefined
    : typeof body === 'string' ? Buffer.from(body)
      : body instanceof Uint8Array ? Buffer.from(body)
        : body instanceof ArrayBuffer ? Buffer.from(body) : undefined
  if (body !== undefined && body !== null && !bodyBytes) return Promise.reject(new Error('CHILD_HOST_REQUEST_BODY_UNSUPPORTED'))
  return new Promise((resolve, reject) => {
    const transport = target.protocol === 'https:' ? https : http
    const request = transport.request(target, { method: init?.method ?? 'GET', headers, agent: modelProxyAgent }, response => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        response.resume(); reject(new Error('CHILD_HOST_REDIRECT_FORBIDDEN')); return
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          response.on('data', chunk => controller.enqueue(new Uint8Array(chunk)))
          response.on('end', () => controller.close())
          response.on('error', error => controller.error(error))
        },
        cancel(reason) { response.destroy(reason instanceof Error ? reason : undefined) },
      })
      const responseHeaders: Record<string, string> = {}
      for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value
      resolve(new Response(stream, { status: response.statusCode ?? 500, statusText: response.statusMessage, headers: responseHeaders }))
    })
    const signal = init?.signal
    const abort = () => request.destroy(new Error('CHILD_HOST_ABORTED'))
    if (signal?.aborted) { abort(); reject(new Error('CHILD_HOST_ABORTED')); return }
    signal?.addEventListener('abort', abort, { once: true })
    request.once('error', error => reject(error))
    request.once('close', () => signal?.removeEventListener('abort', abort))
    if (bodyBytes) request.end(bodyBytes); else request.end()
  })
}

function validateResponse(value: unknown, input: HttpChildAgentHostInput): HttpChildAgentHostResult {
  if (!isObject(value) || value.protocol !== PROTOCOL || value.requestId !== input.callId
    || value.childId !== input.childId || value.childSessionId !== input.childSessionId) {
    return errorResult('CHILD_HOST_IDENTITY_MISMATCH', 'External child host response does not match the dispatched child identity')
  }
  if (typeof value.ok !== 'boolean') return errorResult('CHILD_HOST_RESPONSE_INVALID', 'External child host response must include boolean ok')
  const result: HttpChildAgentHostResult = { ok: value.ok }
  for (const key of ['output', 'evidence', 'actionReceipts'] as const) {
    if (value[key] !== undefined) {
      if (!jsonValue(value[key])) return errorResult('CHILD_HOST_RESPONSE_INVALID', `${key} must be JSON serializable`)
      result[key] = value[key]
    }
  }
  if (value.error !== undefined) {
    if (!isObject(value.error) || typeof value.error.code !== 'string' || typeof value.error.message !== 'string') {
      return errorResult('CHILD_HOST_RESPONSE_INVALID', 'error must contain code and message')
    }
    result.error = { code: value.error.code, message: value.error.message,
      ...(value.error.details === undefined ? {} : jsonValue(value.error.details) ? { details: value.error.details } : {}) }
  }
  for (const key of ['startedAt', 'completedAt'] as const) if (value[key] !== undefined) {
    if (typeof value[key] !== 'string') return errorResult('CHILD_HOST_RESPONSE_INVALID', `${key} must be a string`)
    result[key] = value[key]
  }
  if (value.durationMs !== undefined) {
    if (typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0) return errorResult('CHILD_HOST_RESPONSE_INVALID', 'durationMs must be a non-negative number')
    result.durationMs = value.durationMs
  }
  if (!result.ok && !result.error) return errorResult('CHILD_HOST_RESPONSE_INVALID', 'failed child host result must include error')
  return result
}

/**
 * Adapt an independent HTTP child host to RuntimeLoop's childAgentHost callback.
 * The wire contract deliberately excludes callbacks and model closures. Readonly
 * children can therefore run in another process without sharing parent memory.
 */
export function createHttpChildAgentHost(options: HttpChildAgentHostOptions): (input: HttpChildAgentHostInput) => Promise<HttpChildAgentHostResult> {
  const endpoint = new URL(options.url)
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('CHILD_HOST_URL_INVALID')
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 10 * 60_000))
  const maxResponseBytes = Math.max(1024, Math.min(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, 16 * 1024 * 1024))
  const fetchImpl = options.fetch ?? (isLoopbackModelHost(endpoint.hostname) ? globalThis.fetch : (input: string | URL | Request, init?: RequestInit) => fetchChildThroughNode(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url), init))
  if (typeof fetchImpl !== 'function') throw new Error('CHILD_HOST_FETCH_UNAVAILABLE')
  return async input => {
    if ((input.executionMode ?? 'readonly') !== 'readonly') return errorResult('CHILD_HOST_ACTION_UNSUPPORTED', 'External HTTP child hosts currently accept readonly children only')
    const controller = new AbortController()
    const signal = AbortSignal.any([input.signal, controller.signal])
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const request: JsonObject = {
      protocol: PROTOCOL,
      requestId: input.callId,
      parent: { sessionId: input.parentSessionId ?? null, taskId: input.parentTaskId, runId: input.parentRunId ?? null, stepId: input.parentStepId ?? null, planTaskId: input.planTaskId ?? null },
      child: { childId: input.childId, sessionId: input.childSessionId },
      attemptId: input.attemptId ?? null,
      mode: 'readonly', goal: input.goal, prompt: input.prompt, parentContext: input.parentContext, projectPath: input.projectPath,
      capabilityIds: input.allowedCapabilityIds, capabilities: toJsonValue(input.allowedCapabilities ?? []),
      budget: { maxModelRounds: input.maxModelRounds, maxToolRounds: input.maxToolRounds, maxTotalTokens: input.maxTotalTokens },
    }
    try {
      const response = await fetchImpl(endpoint, { method: 'POST', headers: boundedHeaders(options), body: JSON.stringify(request), signal })
      const body = await readResponse(response, maxResponseBytes, signal)
      if (!response.ok) return errorResult('CHILD_HOST_HTTP_ERROR', `External child host returned HTTP ${response.status}`)
      let parsed: unknown
      try { parsed = JSON.parse(body) } catch { return errorResult('CHILD_HOST_RESPONSE_INVALID', 'External child host returned invalid JSON') }
      return validateResponse(parsed, input)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (signal.aborted) return errorResult(input.signal.aborted ? 'CHILD_HOST_ABORTED' : 'CHILD_HOST_TIMEOUT', message)
      if (message === 'CHILD_HOST_RESPONSE_TOO_LARGE') return errorResult(message, 'External child host response exceeded the configured byte limit')
      return errorResult('CHILD_HOST_UNAVAILABLE', message)
    } finally { clearTimeout(timeout) }
  }
}

export const httpChildAgentHostProtocol = PROTOCOL
