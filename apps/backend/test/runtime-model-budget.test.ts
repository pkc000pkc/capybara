import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { clearSessionContexts } from '#core/context-storage-lifecycle'
import { RuntimeModelBudgetError, RuntimeModelMeter, type ModelMeterOptions } from '#core/runtime-model-budget'
import { initializeProjectDirectory } from '#core/project-initializer'
import { createProjectLlmService } from '#core/project-llm'
import { ProjectResources } from '#core/project-resources'
import type { RuntimeLlm } from '#core/runtime-loop'
import { createFailoverLlmService, createLlmService, type LlmChatRequest } from '#util/llm'
import { fixtureChatTemplate, writeChatTokenizerFixture } from './fixtures/chat-tokenizer.ts'

const config = { provider: 'custom', protocol: 'chat-completions', model: 'test-model',
  baseUrl: 'http://127.0.0.1/unused', maxRetries: 0, timeoutMs: 5_000 } as const
const request: LlmChatRequest = { messages: [{ role: 'user', content: '来源 A 和 B 的原件' }] }
const scope = { sessionId: 'parent', taskId: 'task', runId: 'run' }
const options: ModelMeterOptions = {
  scope, actorSessionId: scope.sessionId, role: 'main', limits: { maxAttempts: 4, maxTokens: 5_000 },
  maxInputTokens: 2_000, maxOutputTokens: 100, contextWindowTokens: 2_100, assertActive() {},
}
const code = (expected: string) => (error: unknown) => error instanceof RuntimeModelBudgetError && error.code === expected

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-model-budget-'))
  fs.mkdirSync(path.join(root, '.capybara'))
  const meter = new RuntimeModelMeter(root)
  const db = new DatabaseSync(meter.store.file)
  return { meter, root, db, close() { db.close(); meter.close(); fs.rmSync(root, { recursive: true, force: true }) } }
}

async function serve(handler: (raw: string, response: http.ServerResponse) => void) {
  const server = http.createServer(async (req, response) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    handler(raw, response)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

test('a built-in retry is denied before a second network send and preserves the failed HTTP status', async () => {
  const f = fixture()
  const bodies: string[] = []
  const api = await serve((raw, response) => {
    bodies.push(raw)
    response.writeHead(500).end('unavailable')
  })
  try {
    const base = createLlmService({ ...config, baseUrl: api.baseUrl, maxRetries: 1 })
    const llm = f.meter.wrap(base, { ...options, limits: { maxAttempts: 1, maxTokens: 5_000 } })
    await assert.rejects(llm.chat(request), code('RUNTIME_MODEL_BUDGET_EXHAUSTED'))
    assert.equal(bodies.length, 1)
    assert.equal(JSON.parse(bodies[0]!).max_tokens, options.maxOutputTokens)
    const row = f.db.prepare('SELECT status,http_status,payload_hash,reported_total FROM runtime_model_budget_attempts').get()!
    assert.equal(row.status, 'failed')
    assert.equal(row.http_status, 500)
    assert.equal(row.payload_hash, createHash('sha256').update(bodies[0]!).digest('hex'))
    assert.equal(row.reported_total, null)
    assert.equal(f.meter.store.totals(scope)?.remainingAttempts, 0)
  } finally { await api.close(); f.close() }
})

test('SSE profile switching uses the same limits and records the second profile with its reported usage', async () => {
  const f = fixture()
  const calls: string[] = []
  const api = await serve((raw, response) => {
    const { model } = JSON.parse(raw)
    calls.push(model)
    if (model === 'unavailable') { response.writeHead(500).end('unavailable'); return }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const chunk of [
      { choices: [{ index: 0, delta: { content: '已整理' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 250, completion_tokens: 6, total_tokens: 256 } },
    ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  try {
    const failover = () => createFailoverLlmService([
      { id: 'first', config: { ...config, baseUrl: api.baseUrl, model: 'unavailable' } },
      { id: 'second', config: { ...config, baseUrl: api.baseUrl, model: 'healthy' } },
    ], { retriesPerCandidate: 0, initialDelayMs: 1, maxDelayMs: 2 })
    const limited = { ...scope, runId: 'limited' }
    await assert.rejects(f.meter.wrap(failover(), { ...options, scope: limited, limits: { maxAttempts: 1, maxTokens: 5000 } })
      .stream!(request, () => {}), code('RUNTIME_MODEL_BUDGET_EXHAUSTED'))
    assert.deepEqual(calls.splice(0), ['unavailable'])
    const deltas: string[] = []
    const result = await f.meter.wrap(failover(), options).stream!(request, delta => deltas.push(delta))
    assert.equal(result.text, '已整理')
    assert.equal(deltas.join(''), result.text)
    assert.deepEqual(calls, ['unavailable', 'healthy'])
    const rows = f.db.prepare('SELECT model, status, charged_tokens, reported_total FROM runtime_model_budget_attempts WHERE run_id=? ORDER BY rowid').all(scope.runId)
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map(row => [row.model, row.status]), [['unavailable', 'failed'], ['healthy', 'returned']])
    assert.equal(rows[1]!.reported_total, 256)
    assert.equal(rows[1]!.charged_tokens, 256)
  } finally { await api.close(); f.close() }
})

test('configured counters see the full wire body and check the context before sending it', async () => {
  const f = fixture()
  let calls = 0
  let serialized = ''
  const api = await serve((raw, response) => {
    calls++
    assert.equal(raw, serialized)
    response.end(JSON.stringify({ model: 'test-model', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } }))
  })
  try {
    const base = createLlmService({ ...config, baseUrl: api.baseUrl })
    const withTool: LlmChatRequest = { ...request, tools: [{ name: 'read_file', description: 'Read the source', parameters: { type: 'object' } }] }
    const count = (tokens: number): ModelMeterOptions['countTokens'] => input => {
      serialized = input.serializedBody
      const body = JSON.parse(serialized)
      assert.equal(body.tools[0].function.name, 'read_file')
      assert.equal(body.messages[0].content, request.messages[0]!.content)
      assert.equal(input.maxOutputTokens, options.maxOutputTokens)
      return tokens
    }
    await assert.rejects(f.meter.wrap(base, { ...options, countTokens: count(2_001) }).chat(withTool), code('RUNTIME_MODEL_CONTEXT_WINDOW'))
    assert.equal(calls, 0)
    assert.equal(f.meter.store.totals(scope), undefined)
    assert.equal((await f.meter.wrap(base, { ...options, countTokens: count(40) }).chat(withTool)).text, 'ok')
    const row = f.db.prepare('SELECT estimation, input_tokens, output_reserve, charged_tokens, reported_total FROM runtime_model_budget_attempts').get()!
    assert.deepEqual(Object.values(row), ['configured_tokenizer', 40, 100, 140, 22])
  } finally { await api.close(); f.close() }
})

test('a 128K input and 64K output reservation fits the configured 256K model window', async () => {
  const f = fixture()
  let calls = 0
  const base: RuntimeLlm = {
    getConfig: () => config,
    chat: async requestValue => {
      calls += 1
      assert.equal(requestValue.maxTokens, 65_536)
      return { provider: 'custom', model: config.model, text: '{}', finishReason: 'stop', raw: {}, usage: { totalTokens: 128_010 } }
    },
  }
  const large: ModelMeterOptions = {
    ...options,
    limits: { maxAttempts: 1, maxTokens: 200_000 },
    maxInputTokens: 128_000,
    maxOutputTokens: 65_536,
    contextWindowTokens: 256_000,
    countTokens: () => 128_000,
  }
  try {
    await f.meter.wrap(base, large).chat(request)
    assert.equal(calls, 1)
    const row = f.db.prepare('SELECT input_tokens, output_reserve, charged_tokens FROM runtime_model_budget_attempts').get() as {
      input_tokens: number
      output_reserve: number
      charged_tokens: number
    }
    assert.deepEqual({ ...row }, { input_tokens: 128_000, output_reserve: 65_536, charged_tokens: 193_536 })
  } finally { f.close() }
})

test('a saved text model profile counts its template on the wire and enforces the model window', async () => {
  const f = fixture()
  const bodies: string[] = []
  const api = await serve((raw, response) => {
    bodies.push(raw)
    if (JSON.parse(raw).model === 'unavailable') { response.writeHead(500).end('switch model'); return }
    response.end(JSON.stringify({ model: config.model, choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }))
  })
  try {
    initializeProjectDirectory(f.root)
    const directory = path.join(f.root, 'tokenizer')
    const templateFile = writeChatTokenizerFixture(directory)
    const resources = new ProjectResources(f.root)
    const settings = (window: number) => {
      resources.saveSettings({ llm: { provider: config.provider, protocol: config.protocol, model: config.model,
        base_url: api.baseUrl, max_retries: 0, chat_template_tokenizer: { directory, context_window_tokens: window } } })
      return resources.readSettings().llm
    }
    const testRequest: LlmChatRequest = { messages: [{ role: 'user', content: '中'.repeat(1000) }] }
    const lowWindow = createProjectLlmService(settings(1100))
    await assert.rejects(f.meter.wrap(lowWindow, options).chat(testRequest), code('RUNTIME_MODEL_CONTEXT_WINDOW'))
    assert.equal(bodies.length, 0)
    const profile = settings(1101)
    assert.deepEqual(profile.profiles[0]!.chat_template_tokenizer, { directory, context_window_tokens: 1101 })
    const bound = f.meter.wrap(createProjectLlmService(profile), options)
    assert.equal((await bound.chat(testRequest)).text, 'ok')
    const ledger = () => f.db.prepare('SELECT estimation, input_tokens, payload_hash FROM runtime_model_budget_attempts ORDER BY rowid').all()
    assert.equal(ledger()[0]!.input_tokens, 1001)
    assert.match(String(ledger()[0]!.estimation), /^chat_template:[a-f0-9]{64}$/)
    assert.equal(ledger()[0]!.payload_hash, createHash('sha256').update(bodies[0]!).digest('hex'))

    fs.writeFileSync(templateFile, `${fixtureChatTemplate} G`)
    await assert.rejects(bound.chat(testRequest), code('RUNTIME_MODEL_CONTEXT_WINDOW'))
    const refreshed = f.meter.wrap(createProjectLlmService(settings(1102)), options)
    await refreshed.chat(testRequest)
    assert.equal(ledger()[1]!.input_tokens, 1002)
    assert.notEqual(ledger()[0]!.estimation, ledger()[1]!.estimation)
    await assert.rejects(refreshed.chat({ ...testRequest, model: 'unbound-model' }), code('RUNTIME_MODEL_BUDGET_TOKEN_COUNT'))
    await assert.rejects(refreshed.chat({ ...testRequest,
      tools: [{ name: 'read_file', description: 'Read the source', parameters: { type: 'object' } }],
    }), code('RUNTIME_MODEL_BUDGET_TOKEN_COUNT'))
    assert.equal(bodies.length, 2)
    assert.equal(ledger().length, 2)

    const failover = createFailoverLlmService([
      { id: 'primary', config: { ...config, baseUrl: api.baseUrl, model: 'unavailable' } },
      { id: 'bound', config: { ...config, baseUrl: api.baseUrl,
        chatTemplateTokenizer: { directory, contextWindowTokens: 1101 } } },
    ], { retriesPerCandidate: 0, initialDelayMs: 1, maxDelayMs: 2 })
    await assert.rejects(f.meter.wrap(failover, options).chat(testRequest), code('RUNTIME_MODEL_CONTEXT_WINDOW'))
    assert.deepEqual(bodies.map(raw => JSON.parse(raw).model), [config.model, config.model, 'unavailable'])
    resources.saveSettings({ llm: { model: 'replacement' } })
    assert.equal(resources.readSettings().llm.profiles[0]!.chat_template_tokenizer, undefined)
  } finally { await api.close(); f.close() }
})

test('durable reservations bind all roles across connections and cannot be restored after clearing the session', async () => {
  const f = fixture()
  const reopened = new RuntimeModelMeter(f.root)
  let calls = 0
  let respond!: (value: Awaited<ReturnType<RuntimeLlm['chat']>>) => void
  const base: RuntimeLlm = { getConfig: () => config, chat: async () => {
    calls++
    return new Promise(resolve => { respond = resolve })
  } }
  try {
    const first = f.meter.wrap(base, { ...options, limits: { maxTokens: 5_000, maxAttempts: 1 } }).chat(request)
    assert.equal(calls, 1)
    f.meter.close()
    const other = reopened.wrap(base, { ...options, role: 'reflection', actorSessionId: 'child' })
    await assert.rejects(other.chat(request), code('RUNTIME_MODEL_BUDGET_EXHAUSTED'))
    assert.equal(reopened.store.totals(scope)?.attemptsWithUsage, 0)
    f.db.exec('BEGIN IMMEDIATE')
    clearSessionContexts(f.db)
    f.db.exec('COMMIT')
    respond({ provider: 'custom', model: config.model, text: 'late', raw: {}, usage: { totalTokens: 155 } })
    await first
    await assert.rejects(other.chat(request), code('CONTEXT_SESSION_CLEARED'))
    assert.equal(calls, 1)
    assert.equal(reopened.store.totals(scope), undefined)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM runtime_model_budget_attempts').get()?.count, 0)
  } finally { reopened.close(); f.close() }
})

test('organizer reservations use an isolated budget scope from the actor run', async () => {
  const f = fixture()
  const calls: string[] = []
  const base: RuntimeLlm = {
    getConfig: () => config,
    chat: async () => {
      calls.push('model')
      return { provider: 'custom', model: config.model, text: 'ok', finishReason: 'stop', raw: {}, usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 } }
    },
  }
  const organizerScope = { ...scope, runId: `${scope.runId}:organize` }
  try {
    await f.meter.wrap(base, { ...options, limits: { maxAttempts: 1, maxTokens: 500 }, role: 'main' }).chat(request)
    await f.meter.wrap(base, { ...options, scope: organizerScope, actorSessionId: scope.sessionId, limits: { maxAttempts: 1, maxTokens: 500 }, role: 'organize' }).chat(request)
    assert.equal(calls.length, 2)
    assert.equal(f.meter.store.totals(scope)?.attempts, 1)
    assert.equal(f.meter.store.totals(scope)?.remainingAttempts, 0)
    assert.equal(f.meter.store.totals(organizerScope)?.attempts, 1)
    assert.equal(f.meter.store.totals(organizerScope)?.remainingAttempts, 0)
    await assert.rejects(
      f.meter.wrap(base, { ...options, scope, limits: { maxAttempts: 1, maxTokens: 500 }, role: 'main' }).chat(request),
      code('RUNTIME_MODEL_BUDGET_EXHAUSTED'),
    )
  } finally { f.close() }
})
