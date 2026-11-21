import assert from 'node:assert/strict'
import test from 'node:test'

import { createHttpBrowserExecutor } from '#core/http-browser-executor'

function request(kind: 'navigate' | 'read' | 'click' = 'read') {
  return {
    action: { id: 'action-1', runId: 'run-1', sessionId: 'session-1', tabId: 'tab-1', sequence: 1, kind, target: { url: 'https://example.com' }, arguments: {}, preconditions: [], risk: 'read' as const, idempotencyKey: 'idempotent-1', status: 'admitted' as const },
    profile: {} as never,
    session: {} as never,
    tab: { id: 'tab-1', sessionId: 'session-1', index: 0, url: 'https://example.com', origin: 'https://example.com', status: 'open' } as never,
    attempt: 1,
  }
}

test('HTTP browser executor reads a public page into evidence', async () => {
  const executor = createHttpBrowserExecutor({
    fetchImpl: async () => new Response('<html><title>东方电子</title><body><h1>000682</h1><p>公开资料</p></body></html>', { status: 200 }),
  })
  const result = await executor(request('read'))
  assert.equal(result.status, 'succeeded')
  assert.equal(result.evidence?.[0]?.type, 'page-snapshot')
  assert.match(String(result.result?.textExcerpt), /000682/)
})

test('HTTP browser executor preserves unknown for interactive actions', async () => {
  const result = await createHttpBrowserExecutor()(request('click'))
  assert.equal(result.status, 'unknown')
  assert.equal(result.error?.code, 'HTTP_BROWSER_ACTION_UNSUPPORTED')
})
