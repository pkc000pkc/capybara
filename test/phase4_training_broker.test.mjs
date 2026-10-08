import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { createTrainingBroker } from '../src/phase4_training_broker.mjs'
import { within } from '../src/phase0_run.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
async function fixture(t, handler) {
  mkdirSync(join(root, 'runs'), { recursive: true })
  const workspaceDir = mkdtempSync(join(root, 'runs', 'phase4-broker-test-'))
  t.after(() => { assert(within(join(root, 'runs'), workspaceDir)); rmSync(workspaceDir, { recursive: true, force: true }) })
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const active = createTrainingBroker({ root, workspaceDir,
    models: { actor: { model: 'gpt-6-luna', provider: 'local', protocol: 'chat-completions' } }, connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'training-test-key-not-real' },
    settings: { processTimeoutMs: 30000, heartbeatIntervalMs: 100, modelRequestTimeoutSeconds: 3,
      modelRetry: { maxAttempts: 3, backoffBaseSeconds: 0, backoffMaxSeconds: 0, maxRetryWaitSeconds: 0 } } })
  return { ...active, workspaceDir }
}
const input = { input: 'Return JSON containing only fixed method enums.', max_output_tokens: 256 }
const context = signal => ({ signal, requestId: 'provider-1', hookId: 'gaia2-correction', checkpoint: 'after_evaluation', executionId: 'correction-test', sessionId: 'training-test' })

test('real pinned Python broker sends only methods, retries 429, returns bounded facade without raw/provider credentials', async t => {
  let requests = 0, payload
  const { broker, operationalReceipts } = await fixture(t, async (req, res) => {
    requests++; let body = ''; for await (const chunk of req) body += chunk
    payload = JSON.parse(body)
    if (requests === 1) { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' }); res.end(JSON.stringify({ error: { message: 'dummy secret raw body', code: 'rate_limit' } })); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'fake-completion', object: 'chat.completion', created: 1, model: 'gpt-6-luna',
      choices: [{ index: 0, message: { role: 'assistant', content: '{"defectCode":"read_failed"}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 }, raw: 'must not cross facade', api_key: 'must not cross facade' }))
  })
  const result = await broker(input, context(new AbortController().signal))
  assert.equal(requests, 2); assert.equal(payload.model, 'gpt-6-luna')
  assert.deepEqual(payload.messages, [{ role: 'user', content: input.input }]); assert.equal(payload.max_tokens, 256)
  assert.deepEqual(payload.response_format, { type: 'json_object' })
  assert.deepEqual(result, { output_text: '{"defectCode":"read_failed"}', usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 } })
  const receipt = operationalReceipts[0]; assert.equal(receipt.processHealthy, true)
  assert.equal(receipt.events.filter(e => e.type === 'model_request_attempt').length, 2)
  assert.equal(receipt.events.filter(e => e.type === 'model_retry_scheduled').length, 1)
  assert(receipt.events.every(e => e.modelRole === 'correction'))
  assert.doesNotMatch(JSON.stringify(result), /raw|api_key|must not cross/)
  assert.doesNotMatch(JSON.stringify(receipt.events), /dummy secret|training-test-key|http:\/\//)
})

test('permanent correction provider rejection is terminal and does not retry or expose the HTTP body', async t => {
  let requests = 0
  const { broker, operationalReceipts } = await fixture(t, async (req, res) => {
    requests++; for await (const _ of req) {}
    res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'training-test-key-not-real RAW_EXPECTED_ANSWER', code: 'invalid_request_error' } }))
  })
  await assert.rejects(broker(input, context(new AbortController().signal)), /TRAINING_PROVIDER_FAILED/)
  assert.equal(requests, 1)
  const receipt = operationalReceipts[0]
  assert.equal(receipt.processHealthy, false)
  assert.equal(receipt.events.find(e => e.type === 'model_request_failed').category, 'configuration_error')
  assert.equal(receipt.events.filter(e => e.type === 'model_retry_scheduled').length, 0)
  assert.doesNotMatch(JSON.stringify(receipt.events), /RAW_EXPECTED_ANSWER|training-test-key/)
  assert.doesNotMatch(readFileSync(join(receipt.directory, 'process/stderr.log'), 'utf8'), /RAW_EXPECTED_ANSWER|training-test-key-not-real/)
})

test('broker rejects arbitrary RPC options before starting Python or making HTTP requests', async t => {
  let requests = 0
  const { broker, operationalReceipts } = await fixture(t, (_req, res) => { requests++; res.end('{}') })
  for (const request of [{ ...input, api_key: 'cannot pass key' }, { ...input, raw: true }, { ...input, max_output_tokens: 100000 }]) {
    await assert.rejects(broker(request, context(new AbortController().signal)), /TRAINING_PROVIDER_REQUEST_INVALID/)
  }
  assert.equal(requests, 0); assert.equal(operationalReceipts.length, 0)
})

test('corrupt event evidence preserves the actual supervised child receipt and marks attempts unknown', async t => {
  let workspace
  const active = await fixture(t, async (req, res) => {
    for await (const _ of req) {}
    const provider = join(workspace, 'provider')
    const directories = readdirSync(provider)
    assert.equal(directories.length, 1)
    appendFileSync(join(provider, directories[0], 'model-events.jsonl'), '{broken-json\n')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'fake-completion', object: 'chat.completion', created: 1, model: 'gpt-6-luna',
      choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }] }))
  })
  workspace = active.workspaceDir
  await assert.rejects(active.broker(input, context(new AbortController().signal)), /TRAINING_PROVIDER_EVIDENCE_UNREADABLE/)
  assert.equal(active.operationalReceipts.length, 1)
  const receipt = active.operationalReceipts[0]
  assert.equal(receipt.eventsReadable, false)
  assert.equal(receipt.evidenceError, 'model_event_evidence_unreadable')
  assert.equal(receipt.process.childExited, true); assert.equal(receipt.process.childClosed, true)
  assert.equal(receipt.process.exitCode, 0)
  assert.equal(receipt.processHealthy, true)
})
