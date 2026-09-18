import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockedToolRequest } from '#core/tools/recovery-policy'

test('network cooldown covers another URL but permits a different access tool', () => {
  const state = { run_id: 'r', blocked_requests: [{ tool: 'web_fetch', origin: 'https://example.com', until: 2000, reason: 'cooldown' }] }
  assert.equal(blockedToolRequest(state, 'r', 'web_fetch', { url: 'https://example.com/other' }, 1000), 'cooldown')
  assert.equal(blockedToolRequest(state, 'r', 'browser_read_page', { url: 'https://example.com/other' }, 1000), undefined)
  assert.equal(blockedToolRequest(state, 'r', 'web_fetch', { url: 'https://elsewhere.com' }, 1000), undefined)
  assert.equal(blockedToolRequest(state, 'r', 'web_fetch', { url: 'https://example.com' }, 2001), undefined)
})
