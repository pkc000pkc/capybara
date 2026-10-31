import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkModelService } from '../scripts/model_service_health.mjs'

test('model service health requires both models and chat completion checks', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const report = await checkModelService({
      root: fileURLToPath(new URL('../', import.meta.url)),
      timeoutMs: 1000,
    })
    assert.equal(report.status, 'healthy')
    assert.equal(report.keyRecorded, false)
    assert.equal(report.noBenchmarkExecution, true)
    assert.equal(calls.length, 2)
    assert.match(calls[0].url, /\/v1\/models$/)
    assert.match(calls[1].url, /\/v1\/chat\/completions$/)
    const root = fileURLToPath(new URL('../', import.meta.url))
    const protocol = JSON.parse(readFileSync(join(root, 'config/phase0-protocol.json'), 'utf8'))
    assert.equal(JSON.parse(calls[1].init.body).model, protocol.models.actor.model)
  } finally {
    globalThis.fetch = originalFetch
  }
})
