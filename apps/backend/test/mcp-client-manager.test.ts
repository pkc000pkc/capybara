import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { Readable } from 'node:stream'
import { pathToFileURL, fileURLToPath } from 'node:url'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { McpClientManager, mcpToolName } from '#core/mcp/client-manager'
import { validateMcpServers, type McpServerConfig } from '#core/mcp/config'
import type { McpInputContinuation } from '#core/mcp/input'
import { emptyTaskControl } from '#core/runtime-control'
import { ContextCommitStore } from '#core/context-commit-store'
import { clearSessionContexts } from '#core/context-storage-lifecycle'
import { projectRuntimeCapabilities } from '#core/runtime-capability-projection'
import type { ToolCallRequest } from '#core/tools/types'

const fixtureFile = fileURLToPath(new URL('./fixtures/mcp-fixture.mjs', import.meta.url))
function setup(supportsUrlInput = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-mcp-client-'))
  fs.writeFileSync(path.join(root, 'control.json'), JSON.stringify({ mode: 'normal' }))
  const config = validateMcpServers([{ id: 'evidence', enabled: true, transport: { type: 'stdio', command: process.execPath, args: [fixtureFile, root] }, timeout_ms: 5000,
    tool_policies: { lookup: { permissions: [], sideEffects: 'none', replay: 'safe' } } }])[0]!
  const manager = new McpClientManager(root, undefined, undefined, [], supportsUrlInput)
  const grant = new Set(['mcp:evidence:lookup', 'mcp:evidence:mutate'])
  let counter = 0
  const request = (raw: string, args: Record<string, unknown> = { key: 'source-A:125; source-B:120' }, configs: McpServerConfig[] = [config], active = manager): ToolCallRequest => {
    const capabilities = active.capabilities(configs, grant, new Set(active.definitions().map(t => t.name)), false)
    const task = emptyTaskControl('mcp-task', '查询真实 MCP 来源')
    const projection = projectRuntimeCapabilities(task, { sessionId: 'mcp-session', taskId: task.taskId, runId: 'mcp-run', requestId: `request-${++counter}`, stateRevision: task.stateRevision }, capabilities)
    return { id: `call-${counter}`, name: mcpToolName(config.id, raw), arguments: args, authorization: { projection, admittedStateRevision: task.stateRevision } }
  }
  return { root, config, manager, grant, request,
    state(value: Record<string, unknown>) { fs.writeFileSync(path.join(root, 'control.json'), JSON.stringify(value)) },
    calls() { const file = path.join(root, 'calls.jsonl'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [] },
    async close() { await manager.close(); fs.rmSync(root, { recursive: true, force: true }) },
  }
}

test('MCP configuration requires explicit enablement, unique identities and credential references', () => {
  assert.deepEqual(validateMcpServers(undefined), [])
  for (const config of [
    [{ id: 'server', transport: { type: 'stdio', command: 'node' } }],
    [{ id: 'server', enabled: true, transport: { type: 'streamable-http', url: 'https://user:secret@example.com/mcp' } }],
    [{ id: 'server', enabled: true, transport: { type: 'streamable-http', url: 'https://example.com/mcp', header_refs: { Authorization: 'Bearer secret' } } }],
    [{ id: 'server', enabled: true, transport: { type: 'stdio', command: 'node' }, tool_policies: { lookup: { permissions: [], sideEffects: 'none' } } }],
  ]) assert.throws(() => validateMcpServers(config))
  const valid = { id: 'server', enabled: false, transport: { type: 'stdio', command: 'node' } }
  assert.throws(() => validateMcpServers([valid, valid]))
})

test('real stdio MCP discovery paginates, namespaces tools and preserves actual RPC provenance', async () => {
  const f = setup()
  try {
    await f.manager.prepare([f.config])
    assert.equal(f.manager.snapshot().servers[0]!.status, 'ready', JSON.stringify(f.manager.snapshot()))
    assert.equal(f.manager.definitions().length, 2)
    const request = f.request('lookup'), result = await f.manager.call(request, [f.config], f.grant)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal((result.output as { structuredContent: { value: string } }).structuredContent.value, 'source-A:125; source-B:120')
    assert.equal(result.source!.rpcRequestId, f.calls()[0].rpcId)
    assert.equal(result.source!.serverId, 'evidence'); assert.equal(result.source!.toolName, 'lookup')
    assert.ok(result.source!.protocolVersion); assert.equal(result.source!.outcome, 'succeeded')
    assert.ok(request.name.length <= 64); assert.notEqual(mcpToolName('other', 'lookup'), request.name)
    const version = f.manager.definitions()[0]!.origin!.sourceVersion
    await f.manager.prepare([f.config])
    assert.equal(f.manager.definitions()[0]!.origin!.sourceVersion, version)
  } finally { await f.close() }
})

test('MCP annotations never override host policy, exact permission, load state or child boundaries', async () => {
  const f = setup()
  try {
    await f.manager.prepare([f.config])
    const names = new Set(f.manager.definitions().map(tool => tool.name))
    const caps = f.manager.capabilities([f.config], f.grant, names, false)
    assert.equal(caps.find(c => c.name === mcpToolName('evidence', 'mutate'))!.sideEffects, 'external')
    assert.equal(f.manager.capabilities([f.config], new Set(), names, false).every(c => !c.available), true)
    assert.equal(f.manager.capabilities([f.config], f.grant, new Set(), false).every(c => !c.available), true)
    assert.equal(f.manager.capabilities([f.config], f.grant, names, true).find(c => c.name === mcpToolName('evidence', 'mutate'))!.unavailableReason, 'child_readonly')
    const denied = await f.manager.call(f.request('lookup'), [f.config], new Set())
    assert.equal(denied.error!.code, 'PERMISSION_DENIED'); assert.equal(f.calls().length, 0)
    const invalid = await f.manager.call(f.request('lookup', { key: 42 } as unknown as Record<string, unknown>), [f.config], f.grant)
    assert.equal(invalid.error!.code, 'INVALID_ARGUMENTS'); assert.equal(f.calls().length, 0)
  } finally { await f.close() }
})

test('MCP schema changes invalidate old calls and refresh before a new invocation', async () => {
  const f = setup()
  try {
    await f.manager.prepare([f.config]); const old = f.request('lookup')
    f.state({ mode: 'normal', schema: 'replacement' }); await f.manager.prepare([f.config])
    const stale = await f.manager.call(old, [f.config], f.grant)
    assert.equal(stale.ok, false); assert.equal(f.calls().length, 0)
    const next = f.request('lookup', { replacement: 'new-schema-value' })
    const grantVersion = (request: ToolCallRequest) => request.authorization!.projection.bindings.find(binding => binding.name === request.name)!.delegationVersion
    assert.notEqual(grantVersion(old), grantVersion(next))
    const fresh = await f.manager.call(next, [f.config], f.grant)
    assert.equal(fresh.ok, true); assert.equal(f.calls()[0].args.replacement, 'new-schema-value')
  } finally { await f.close() }
})

test('an MCP disconnect is not retried and a new discovery has a distinct connection identity', async () => {
  const f = setup()
  try {
    await f.manager.prepare([f.config]); const original = f.manager.snapshot().servers[0]!.connectionId
    const lookup = f.request('lookup')
    const getGrant = (request: ToolCallRequest) => request.authorization!.projection.bindings.find(binding => binding.name === request.name)!
    f.state({ mode: 'disconnect' })
    const result = await f.manager.call(f.request('lookup'), [f.config], f.grant)
    assert.equal(result.ok, false); assert.equal(result.source!.outcome, 'failed'); assert.equal(f.calls().length, 1)
    f.state({ mode: 'normal' }); await f.manager.prepare([f.config])
    assert.notEqual(f.manager.snapshot().servers[0]!.connectionId, original)
    assert.equal(f.calls().length, 1)
    const newLookup = f.request('lookup')
    assert.notEqual(getGrant(newLookup).sourceVersion, getGrant(lookup).sourceVersion)
    assert.ok(getGrant(lookup).delegationVersion)
    assert.equal(getGrant(newLookup).delegationVersion, getGrant(lookup).delegationVersion)
    assert.equal((await f.manager.call(newLookup, [f.config], f.grant)).ok, true)
    assert.equal(f.calls().length, 2)
  } finally { await f.close() }
})

test('timed out MCP writes remain unknown and are not repeated after restoring the ledger', async () => {
  const f = setup(); let reopened: McpClientManager | undefined
  try {
    await f.manager.prepare([f.config]); f.state({ mode: 'timeout' })
    const result = await f.manager.call(f.request('mutate', { key: 'one-write' }), [f.config], f.grant)
    assert.equal(result.ok, false); assert.equal(result.error!.code, 'TIMEOUT'); assert.equal(result.source!.outcome, 'unknown')
    assert.equal(fs.readFileSync(path.join(f.root, 'writes.txt'), 'utf8'), 'w')
    const state = f.manager.exportState(); await f.manager.close(); f.state({ mode: 'normal' })
    reopened = new McpClientManager(f.root); reopened.restoreState(state); await reopened.prepare([f.config])
    const task = emptyTaskControl('restored', '核查未知结果'), caps = reopened.capabilities([f.config], f.grant, new Set(reopened.definitions().map(t => t.name)), false)
    const projection = projectRuntimeCapabilities(task, { sessionId: 's', taskId: 'restored', runId: 'r', requestId: 'q', stateRevision: 0 }, caps)
    const blocked = await reopened.call({ id: 'retry', name: mcpToolName('evidence', 'mutate'), arguments: { key: 'one-write' }, authorization: { projection, admittedStateRevision: task.stateRevision } }, [f.config], f.grant)
    assert.equal(blocked.error!.code, 'RECOVERY_BLOCKED'); assert.equal(f.calls().length, 1)
    assert.equal(fs.readFileSync(path.join(f.root, 'writes.txt'), 'utf8'), 'w')
  } finally { await reopened?.close(); await f.close() }
})

test('MCP business errors and invalid output are never reported as successful observations', async () => {
  const f = setup()
  try {
    await f.manager.prepare([f.config]); f.state({ mode: 'error' })
    const result = await f.manager.call(f.request('lookup'), [f.config], f.grant)
    assert.equal(result.error!.code, 'MCP_TOOL_ERROR'); assert.equal(result.source!.outcome, 'failed')
    f.state({ mode: 'invalid-output' }); await f.manager.prepare([f.config])
    const invalid = await f.manager.call(f.request('lookup'), [f.config], f.grant)
    assert.equal(invalid.ok, false); assert.equal(invalid.source!.outcome, 'failed')
  } finally { await f.close() }
})

test('malformed MCP transport data closes the connection and never becomes a successful result', async () => {
  const f = setup()
  try {
    f.state({ mode: 'malformed' }); await f.manager.prepare([f.config])
    const result = await f.manager.call(f.request('lookup'), [f.config], f.grant)
    assert.equal(result.ok, false); assert.equal(result.error!.code, 'MCP_PROTOCOL_ERROR', JSON.stringify(f.manager.snapshot()))
    assert.equal(result.source!.outcome, 'failed'); assert.equal(f.calls().length, 1)
  } finally { await f.close() }
})

test('non-JSON stdout without a valid MCP reply times out instead of supplying an observation', async () => {
  const f = setup()
  try {
    f.state({ mode: 'non-json' }); await f.manager.prepare([f.config])
    const result = await f.manager.call(f.request('lookup'), [f.config], f.grant)
    assert.equal(result.ok, false); assert.equal(result.error!.code, 'TIMEOUT')
    assert.equal(result.output, undefined); assert.equal(f.calls().length, 1)
  } finally { await f.close() }
})

test('real Streamable HTTP uses environment-referenced credentials without publishing them', async () => {
  const f = setup(true), requests: Array<{ auth?: string; method?: string }> = []
  let excessiveOutput = false
  const { createFixtureServer } = await import(pathToFileURL(fixtureFile).href)
  const handler = createMcpHandler(() => createFixtureServer(f.root))
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString('utf8')
    requests.push({ auth: req.headers.authorization, method: body ? JSON.parse(body).method : undefined })
    if (excessiveOutput && body && JSON.parse(body).method === 'tools/call') {
      const oversized = JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body).id, result: { resultType: 'complete', content: [{ type: 'text', text: 'x'.repeat(6 * 1024 * 1024) }] } })
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(oversized) }); res.end(oversized); return
    }
    const response = await handler.fetch(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, ...(body ? { body } : {}) }))
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (response.body) Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).pipe(res)
    else res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const secretName = 'CAPYBARA_MCP_TEST_AUTH', previous = process.env[secretName]
  process.env[secretName] = 'Bearer controlled-private-fixture-token'
  try {
    const config = validateMcpServers([{ ...f.config, transport: { type: 'streamable-http', url: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/mcp`, header_refs: { Authorization: secretName } } }])[0]!
    await f.manager.prepare([config])
    assert.equal(f.manager.snapshot().servers[0]!.status, 'ready', JSON.stringify(f.manager.snapshot()))
    const result = await f.manager.call(f.request('lookup', { key: 'http-result' }, [config]), [config], f.grant)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.ok(requests.some(r => r.method === 'tools/call')); assert.ok(requests.every(r => r.auth === process.env[secretName]))
    assert.equal(JSON.stringify({ snapshot: f.manager.snapshot(), definitions: f.manager.definitions(), state: f.manager.exportState(), result }).includes(process.env[secretName]!), false)
    assert.equal(result.source!.protocolVersion, '2026-07-28')
    excessiveOutput = true
    const oversized = await f.manager.call(f.request('lookup', { key: 'over-limit' }, [config]), [config], f.grant)
    assert.equal(oversized.ok, false); assert.equal(oversized.output, undefined)

    excessiveOutput = false
    const address = 'https://reports.example/connect?state=private-url-http'
    f.state({ mode: 'url', url: address })
    const urlConfig = validateMcpServers([{ ...config, tool_policies: {
      lookup: { permissions: [], sideEffects: 'none', replay: 'safe', human_input: 'url' },
    } }])[0]!
    await f.manager.prepare([urlConfig])
    const args = { key: 'http-url-report' }
    const original = f.request('lookup', args, [urlConfig])
    let continuation: McpInputContinuation | undefined
    const assisted = await f.manager.call(original, [urlConfig], f.grant, undefined, undefined, {
      register(authority, _source, input) {
        const target = Object.values(input.urls)[0]!
        assert.equal(target.url, address)
        continuation = { id: 'http-url-test', authority, tool: original.name, args, round: 1, originCallId: original.id,
          originStepId: 'http-url-step', binding: original.authorization!.projection.request,
          ...(input.requestState === undefined ? {} : { requestState: input.requestState }), answers: { [target.remoteId]: { action: 'accept' } } }
        return continuation.id
      },
    })
    assert.ok(continuation)
    assert.equal(assisted.error?.code, 'MCP_INPUT_REQUIRED')
    assert.doesNotMatch(JSON.stringify(assisted), /private-url-http|private-url-state/)
    fs.writeFileSync(path.join(f.root, 'external-interaction-complete'), 'local HTTP fixture response')
    const continued = await f.manager.call(f.request('lookup', args, [urlConfig]), [urlConfig], f.grant, undefined, undefined, {
      continuation, register: () => assert.fail('service had already completed the external interaction'),
    })
    assert.equal(continued.ok, true, JSON.stringify(continued))
    assert.equal((continued.output as { structuredContent: { value: string } }).structuredContent.value, 'url-report-receipt')
    assert.ok(requests.every(request => request.auth === process.env[secretName]))
  } finally {
    if (previous === undefined) delete process.env[secretName]; else process.env[secretName] = previous
    await f.manager.close(); await handler.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close()
  }
})

test('two real MCP servers with identical reported names and tool names remain isolated', async () => {
  const f = setup()
  try {
    const other = { ...f.config, id: 'second' }
    await f.manager.prepare([f.config, other])
    assert.equal(f.manager.definitions().length, 4)
    assert.equal(new Set(f.manager.definitions().map(t => t.id)).size, 4)
    assert.equal(new Set(f.manager.definitions().map(t => t.name)).size, 4)
    const request = f.request('lookup'), result = await f.manager.call(request, [f.config, other], f.grant)
    assert.equal(result.ok, true); assert.equal(result.source!.serverId, 'evidence')
    assert.equal(f.manager.capabilities([f.config, other], f.grant, new Set(f.manager.definitions().map(t => t.name)), false).filter(c => c.capabilityId.startsWith('mcp:second:')).every(c => c.unavailableReason === 'permission_denied'), true)
  } finally { await f.close() }
})

test('a real tools/list_changed notification revokes the old catalog until it is refreshed', async () => {
  const f = setup()
  try {
    await f.manager.prepare([f.config])
    f.state({ mode: 'normal', schema: 'replacement' })
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && !f.manager.capabilities([f.config], f.grant, new Set(f.manager.definitions().map(t => t.name)), false).some(c => c.unavailableReason === 'catalog_stale')) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(f.manager.capabilities([f.config], f.grant, new Set(f.manager.definitions().map(t => t.name)), false).some(c => c.unavailableReason === 'catalog_stale'))
    await f.manager.prepare([f.config])
    assert.deepEqual(f.manager.definitions().find(t => t.origin!.toolName === 'lookup')!.inputSchema.required, ['replacement'])
  } finally { await f.close() }
})

test('a change during a paginated MCP refresh revokes the old catalog and retries discovery', async () => {
  const f = setup()
  const release = path.join(f.root, 'catalog-page-release')
  const lookup = () => f.manager.definitions().find(tool => tool.origin!.toolName === 'lookup')!
  const active = () => f.manager.capabilities([f.config], f.grant, new Set([lookup().name]), false).find(capability => capability.name === lookup().name)!
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 3000
    while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(condition(), 'Expected the real MCP request or notification')
  }
  let interrupted: Promise<void> | undefined
  try {
    await f.manager.prepare([f.config])
    assert.equal(active().available, true)
    const old = f.request('lookup')
    f.state({ mode: 'normal', holdCatalogPage: true })
    interrupted = f.manager.prepare([f.config])
    await until(() => fs.existsSync(path.join(f.root, 'catalog-page-held')))
    const previousRevision = f.manager.snapshot().revision
    f.state({ mode: 'normal', schema: 'replacement' })
    await until(() => f.manager.snapshot().revision > previousRevision)
    assert.equal(f.manager.snapshot().servers[0]!.status, 'ready')
    assert.equal(active().unavailableReason, 'catalog_stale')
    assert.equal((await f.manager.call(old, [f.config], f.grant)).ok, false)
    assert.deepEqual(f.calls(), [])

    fs.writeFileSync(release, '')
    await interrupted
    assert.equal(active().available, true)
    assert.deepEqual(lookup().inputSchema.required, ['replacement'])
    assert.equal((await f.manager.call(old, [f.config], f.grant)).ok, false)
    assert.deepEqual(f.calls(), [])
    assert.equal((await f.manager.call(f.request('lookup', { replacement: 'current' }), [f.config], f.grant)).ok, true)
  } finally {
    if (interrupted) { fs.writeFileSync(release, ''); await interrupted }
    await f.close()
  }
})

function journalManager(root: string, store: ContextCommitStore): McpClientManager {
  return new McpClientManager(root, () => {}, {
    loadUnknown: () => store.loadUnknownMcpOperations('durable-session'),
    reserve: (signature, source) => store.reserveMcpOperation('durable-session', signature, source),
    settle: source => store.settleMcpOperation('durable-session', source),
  })
}

test('a fresh process view uses the durable pre-dispatch ledger instead of an empty or stale snapshot', async () => {
  const f = setup(), store = new ContextCommitStore(f.root), secondStore = new ContextCommitStore(f.root)
  const first = journalManager(f.root, store), second = journalManager(f.root, secondStore), controller = new AbortController()
  let running: Promise<unknown> | undefined
  try {
    f.state({ mode: 'timeout' }); await first.prepare([f.config])
    running = first.call(f.request('mutate', { key: 'durable-write' }, [f.config], first), [f.config], f.grant, controller.signal)
    const deadline = Date.now() + 3000
    while (!fs.existsSync(path.join(f.root, 'writes.txt')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(fs.readFileSync(path.join(f.root, 'writes.txt'), 'utf8'), 'w')
    assert.equal(secondStore.loadUnknownMcpOperations('durable-session').length, 1)
    second.restoreState({ unknownCalls: [] })
    assert.equal(second.exportState().unknownCalls.length, 1)
    f.state({ mode: 'normal' }); await second.prepare([f.config])
    const blocked = await second.call(f.request('mutate', { key: 'durable-write' }, [f.config], second), [f.config], f.grant)
    assert.equal(blocked.error!.code, 'RECOVERY_BLOCKED'); assert.equal(f.calls().length, 1)
    controller.abort(); await running
    assert.equal(secondStore.loadUnknownMcpOperations('durable-session').length, 1)
    const database = new DatabaseSync(store.databaseFile)
    try { database.exec('BEGIN IMMEDIATE'); clearSessionContexts(database); database.exec('COMMIT') } finally { database.close() }
    assert.throws(() => store.loadUnknownMcpOperations('durable-session'), /CONTEXT_SESSION_CLEARED/)
  } finally { controller.abort(); await running; await first.close(); await second.close(); store.close(); secondStore.close(); await f.close() }
})

test('an MCP reservation persistence failure prevents the actual remote write', async () => {
  const f = setup(), store = new ContextCommitStore(f.root), manager = journalManager(f.root, store), database = new DatabaseSync(store.databaseFile)
  try {
    await manager.prepare([f.config])
    database.exec("CREATE TRIGGER fail_mcp_reserve BEFORE INSERT ON runtime_mcp_operations BEGIN SELECT RAISE(ABORT,'injected reserve failure'); END")
    const result = await manager.call(f.request('mutate', { key: 'must-not-write' }, [f.config], manager), [f.config], f.grant)
    assert.equal(result.error!.code, 'MCP_JOURNAL_FAILED'); assert.equal(result.source!.dispatched, false)
    assert.equal(f.calls().length, 0); assert.equal(fs.existsSync(path.join(f.root, 'writes.txt')), false)
    assert.equal(store.loadUnknownMcpOperations('durable-session').length, 0)
  } finally { await manager.close(); database.close(); store.close(); await f.close() }
})

test('a confirmed MCP write keeps its real success when final journal persistence fails', async () => {
  const f = setup(), store = new ContextCommitStore(f.root), manager = journalManager(f.root, store), database = new DatabaseSync(store.databaseFile)
  try {
    await manager.prepare([f.config])
    database.exec("CREATE TRIGGER fail_mcp_settle BEFORE UPDATE ON runtime_mcp_operations WHEN NEW.outcome='succeeded' BEGIN SELECT RAISE(ABORT,'injected settle failure'); END")
    const result = await manager.call(f.request('mutate', { key: 'confirmed-write' }, [f.config], manager), [f.config], f.grant)
    assert.equal(result.ok, true); assert.equal(result.source!.outcome, 'succeeded')
    assert.equal(fs.readFileSync(path.join(f.root, 'writes.txt'), 'utf8'), 'w')
    assert.equal(manager.snapshot().unknownCallCount, 1); assert.equal(store.loadUnknownMcpOperations('durable-session').length, 1)
    assert.equal(manager.snapshot().servers[0]!.errorCode, 'MCP_OUTCOME_PERSIST_FAILED')
    const blocked = await manager.call(f.request('mutate', { key: 'confirmed-write' }, [f.config], manager), [f.config], f.grant)
    assert.equal(blocked.error!.code, 'RECOVERY_BLOCKED'); assert.equal(f.calls().length, 1)
  } finally { await manager.close(); database.close(); store.close(); await f.close() }
})
