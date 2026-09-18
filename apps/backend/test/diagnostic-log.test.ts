import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diagnosticContext, diagnosticLog, networkDiagnostic } from '#util/llm/diagnostic-log'

test('network diagnostics correlate, redact bodies, and terminate once on cancellation', () => {
  const original = process.stderr.write
  const lines: string[] = []
  process.stderr.write = ((chunk: unknown) => { lines.push(String(chunk)); return true }) as typeof original
  try {
    diagnosticContext.run({ hookId: 'review', requestId: 'request-test' }, () => {
      const controller = new AbortController()
      const log = networkDiagnostic('SECRET REQUEST BODY', controller.signal)
      log.headers(200, 'upstream-id')
      log.data('PRIVATE RESPONSE')
      log.sse()
      controller.abort()
      log.close('http.completed')
    })
    const events = lines.map(line => JSON.parse(line.replace('CAPYBARA_DIAGNOSTIC ', '')))
    assert.deepEqual(events.map(e => e.event), ['http.started', 'http.headers', 'http.cancelled'])
    assert.ok(events.every(e => e.hookId === 'review' && e.requestId === 'request-test'))
    assert.equal(events.at(-1).eventCount, 1)
    assert.equal(events.at(-1).bytes, 16)
    assert.ok(!lines.join('').includes('SECRET REQUEST BODY'))
    assert.ok(!lines.join('').includes('PRIVATE RESPONSE'))
    process.stderr.write = (() => { throw new Error('sink failed') }) as typeof original
    assert.doesNotThrow(() => diagnosticLog('test'))
  } finally { process.stderr.write = original }
})
