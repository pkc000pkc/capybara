import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'

export const diagnosticContext = new AsyncLocalStorage<Record<string, unknown>>()
export function diagnosticLog(event: string, fields: Record<string, unknown> = {}): void {
  try { process.stderr.write(`CAPYBARA_DIAGNOSTIC ${JSON.stringify({ ...diagnosticContext.getStore(), ...fields, event, timestamp: new Date().toISOString() })}\n`) } catch { /* Diagnostics must not interrupt execution. */ }
}

/** One physical HTTP attempt; never records request/response bodies or credentials. */
export function networkDiagnostic(body: string, signal?: AbortSignal) {
  const started = Date.now()
  const id = randomUUID()
  let bytes = 0, lastByteAt: number | null = null, firstByteAt: number | null = null
  let lastEventAt: number | null = null, eventCount = 0, closed = false
  const emit = (event: string, fields: Record<string, unknown> = {}) => diagnosticLog(event, {
    httpAttemptId: id, elapsedMs: Date.now() - started, bytes, firstByteAt, lastByteAt, lastEventAt, eventCount, ...fields,
  })
  emit('http.started', { payloadHash: createHash('sha256').update(body).digest('hex'), payloadBytes: Buffer.byteLength(body) })
  const timer = setInterval(() => emit('http.waiting'), 60000)
  timer.unref()
  const close = (event: string, fields: Record<string, unknown> = {}) => {
    if (closed) return
    closed = true
    clearInterval(timer)
    signal?.removeEventListener('abort', aborted)
    emit(event, fields)
  }
  const aborted = () => close('http.cancelled', { reasonType: signal?.reason instanceof Error ? signal.reason.name : 'unknown' })
  signal?.addEventListener('abort', aborted, { once: true })
  return {
    headers: (statusCode: number, upstreamRequestId?: string) => emit('http.headers', { statusCode, upstreamRequestId }),
    data: (chunk: string) => { bytes += Buffer.byteLength(chunk); firstByteAt ??= Date.now(); lastByteAt = Date.now() },
    sse: () => { eventCount++; lastEventAt = Date.now() },
    close,
  }
}
