import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { RuntimeLoop, type RuntimeLlm, type RuntimeLoopState } from '#core/runtime-loop'
import { initializeProjectDirectory } from '#core/project-initializer'
import { mcpToolName } from '#core/mcp/client-manager'
import { readMcpInputs } from '#core/mcp/input'
import { ContextCommitStore } from '#core/context-commit-store'
import type { ClientCommand, ControlEnvelopeV2, RuntimeRequestBinding, ServerEvent } from '#protocol/runtime-protocol'
import type { LlmChatRequest, LlmChatResponse } from '#util/llm'

const fixtureFile = fileURLToPath(new URL('./fixtures/mcp-fixture.mjs', import.meta.url))
function binding(request: LlmChatRequest): RuntimeRequestBinding {
  return JSON.parse(request.messages[0]!.content.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)![0])
}
function reply(request: LlmChatRequest, changes: Partial<ControlEnvelopeV2>): LlmChatResponse {
  return { provider: 'custom', model: 'mcp-test', text: JSON.stringify({ envelopeVersion: 2, binding: binding(request), decision: 'continue', userMessage: '', actions: [], planProposal: null,
    candidateDiffs: [], evidenceRequests: [], uncertainties: [], waitSpec: null, completionCheck: null, ...changes }), raw: {} }
}
function call(name: string, id: string, args: Record<string, unknown>): LlmChatResponse {
  return { provider: 'custom', model: 'mcp-test', text: '', raw: {}, toolCalls: [{ id, name, arguments: args }] }
}
function finish(request: LlmChatRequest, actions: string[] = []): LlmChatResponse {
  return reply(request, { decision: 'finish', userMessage: '来源已核对。', completionCheck: { taskId: binding(request).taskId, requiredActions: actions, requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '真实 MCP 结果与收据可追溯' } })
}
function fixture(actor: (request: LlmChatRequest) => LlmChatResponse, grants = ['mcp:evidence:lookup', 'mcp:evidence:mutate'], verification?: 'applied' | 'not_applied' | 'pending', scenario: { verify_key?: string; report_original?: boolean; pollMs?: number; humanForm?: boolean; formKey?: string; formWrite?: 'multi' | 'disconnect' | 'decline' | 'journal'; url?: string; openExternalMcpUrl?: (url: string) => Promise<void> } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-mcp-runtime-'))
  initializeProjectDirectory(root)
  const { openExternalMcpUrl, ...control } = scenario
  const mode = scenario.url ? 'url' : scenario.formWrite ? 'write-form' : scenario.humanForm ? 'form' : 'normal'
  fs.writeFileSync(path.join(root, 'control.json'), JSON.stringify({ mode, verification, ...control }))
  const configPath = path.join(root, '.capybara/config.json'), config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  config.mcp_servers = [{ id: 'evidence', enabled: true, transport: { type: 'stdio', command: process.execPath, args: [fixtureFile, root] }, timeout_ms: 5000,
    tool_policies: { lookup: { permissions: [], sideEffects: 'none', replay: 'safe', ...(scenario.url ? { human_input: 'url' } : scenario.humanForm ? { human_input: 'form' } : {}) }, ...(verification ? {
      mutate: { permissions: [], sideEffects: 'external', replay: 'never', verification_tool: 'verify', ...(scenario.pollMs ? { verification_poll_ms: scenario.pollMs } : {}),
        ...(scenario.formWrite ? { human_input: 'form' } : {}) },
      verify: { permissions: [], sideEffects: 'none', replay: 'safe' },
    } : {}) } }]
  if (verification || scenario.humanForm || scenario.url) config.context = { ...config.context, context_window_tokens: 22_000, max_input_tokens: 19_000 }
  config.tool_permissions = grants; fs.writeFileSync(configPath, JSON.stringify(config))
  const llm: RuntimeLlm = { chat: async request => actor(request), getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'mcp-test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }) }
  const loop = new RuntimeLoop({ projectDir: root, sessionId: 'mcp-session', llm, contextOrganization: { minGroups: 100 },
    stepDelayMs: 0, streamDelayMs: 0, ...(openExternalMcpUrl ? { openExternalMcpUrl } : {}) })
  const events: ServerEvent[] = []; loop.onEvent(event => events.push(event as ServerEvent))
  let seq = 0
  const send = (type: ClientCommand['type'], payload: unknown, runtime = loop) => {
    const command = { version: 1, kind: 'command', type, payload, id: `mcp-command-${++seq}`, sessionId: 'mcp-session', timestamp: new Date().toISOString() } as ClientCommand
    runtime.validate(command); runtime.execute(command, seq)
  }
  return { root, configPath, loop, llm, events, send,
    start() { send('chat.message.send', { clientMessageId: 'mcp-task', content: [{ type: 'text', text: '核对 MCP 来源，保留来源 A 的 125 和来源 B 的 120。' }], autoStart: true }) },
    wait(status: 'completed' | 'paused' | 'failed', runtime = loop, timeoutMs = 30_000, ready = () => true) { return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('MCP runtime did not settle: '+JSON.stringify(runtime.exportState().snapshot.run))) }, timeoutMs)
      const off = runtime.onEvent(event => {
        if (event.type !== 'run.state.changed') return
        if (event.payload.status === status && ready()) { clearTimeout(timer); off(); resolve() }
        else if (event.payload.status === 'failed') { clearTimeout(timer); off(); reject(new Error(JSON.stringify(event.payload.failure))) }
      })
    }) },
    async close() { await loop.shutdown(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 80 }) },
  }
}

test('MCP URL input validates the navigation scheme and isolates the service key and full URL', () => {
  const make = (url: string) => ({ inputRequests: {
    'https://private-key.example/connect': { method: 'elicitation/create', params: { mode: 'url', message: 'Connect the report service', url } },
  } })
  for (const url of ['javascript:alert(1)', 'file:///somefile', 'http://example.invalid/path', 'https://user:pass@example.invalid',
    'https://example.invalid\\@other.invalid/', 'https://example.invalid/\npath']) {
    assert.throws(() => readMcpInputs(make(url), () => true), /MCP_URL_INVALID/)
  }
  const example = make('https://bücher.example/connect?state=private')
  assert.throws(() => readMcpInputs(example, mode => mode === 'form'), /MCP_URL_MODE_UNAVAILABLE/)
  const [id, view] = Object.entries(readMcpInputs(example, mode => mode === 'url').urls)[0]!
  assert.match(id, /^mcp-url-[a-f0-9-]{36}$/)
  assert.equal(view.remoteId, 'https://private-key.example/connect')
  assert.equal(view.host, 'xn--bcher-kva.example')
  assert.equal(view.url, 'https://xn--bcher-kva.example/connect?state=private')
  assert.equal(Object.values(readMcpInputs(make('http://127.0.0.1:4875/local'), () => true).urls)[0]?.host, '127.0.0.1:4875')
})

for (const mode of ['cancel', 'headless'] as const) test(`MCP URL input ${mode} preserves the original reply boundary`, async () => {
  let round = 0, opened = 0
  const name = mcpToolName('evidence', 'lookup'), grants = ['mcp:evidence:lookup']
  const f = fixture(request => {
    ++round
    assert.doesNotMatch(JSON.stringify(request), /private-url-state|private-cancel-fixture/)
    if (round === 1) return call('load_resources', 'cancel-url-load', { ids: grants })
    if (round === 2) return call(name, 'cancel-url-original', { key: 'cancel-url' })
    const view = f.loop.getSnapshot(0).mcp!.inputRequests?.[0]
    const observed = (id: string) => JSON.parse(request.messages.find(message => message.toolCallId === id)!.content)
    if (mode === 'headless') {
      assert.equal(view, undefined)
      assert.equal(observed('cancel-url-original').result.structuredContent.value, 'url-capability-unavailable')
      return finish(request)
    }
    if (round === 3) {
      assert.ok(view?.urls?.length)
      const runtimeState = JSON.parse(request.messages[0]!.content.split('\n').find(line => line.startsWith('{"taskId"') && line.includes('"inputRequests"'))!)
      const waitSpec = runtimeState.mcp.inputRequests.find((item: { id: string }) => item.id === view.id)?.waitSpec
      assert.equal(waitSpec?.signalType, 'runtime')
      assert.equal(waitSpec?.condition.eventType, 'mcp.input.responded')
      assert.deepEqual(waitSpec?.correlationIds, [view.id])
      return reply(request, { decision: 'wait', waitSpec })
    }
    if (round === 4) return call('resume_mcp_input', 'cancel-url-continuation', { request_id: view!.id })
    assert.equal(observed('cancel-url-continuation').result.structuredContent.value, 'cancel')
    return finish(request, ['call:cancel-url-original'])
  }, grants, undefined, { url: 'https://reports.example/authorize?state=private-cancel-fixture',
    ...(mode === 'cancel' ? { openExternalMcpUrl: async () => { opened++ } } : {}) })
  try {
    const initial = f.wait(mode === 'cancel' ? 'paused' : 'completed'); f.start(); await initial
    if (mode === 'cancel') {
      const view = f.loop.getSnapshot(0).mcp!.inputRequests![0]!, urlId = view.urls![0]!.id
      const input = { requestId: view.id, responses: { [urlId]: { action: 'cancel' } } }
      await f.loop.openMcpInputUrl(view.id, urlId)
      const done = f.wait('completed')
      f.send('runtime.mcp.input.reply', input)
      assert.throws(() => f.send('runtime.mcp.input.reply', input), /MCP_FORM_REPLY_NOT_PENDING/)
      assert.throws(() => f.loop.readMcpInputUrl(view.id, urlId), /MCP_URL_REQUEST_UNAVAILABLE/)
      await done
      assert.equal(opened, 1)
      const dispatch = JSON.parse(fs.readFileSync(path.join(f.root, 'url-rpc.jsonl'), 'utf8'))
      assert.deepEqual(dispatch.answers, { connect: { action: 'cancel' } })
    } else assert.equal(fs.existsSync(path.join(f.root, 'url-rpc.jsonl')), false)
    assert.doesNotMatch(JSON.stringify(f.loop.exportState()), /private-url-state|private-cancel-fixture/)
  } finally { await f.close() }
})

test('RuntimeLoop discovers, loads and calls a real MCP tool through the ordinary capability and evidence path', async () => {
  let calls = 0
  const name = mcpToolName('evidence', 'lookup')
  const f = fixture(request => {
    if (++calls === 1) { assert.ok(!request.tools!.some(t => t.name === name)); return call('load_resources', 'load-mcp', { ids: ['mcp:evidence:lookup'] }) }
    if (calls === 2) { assert.ok(request.tools!.some(t => t.name === name)); return call(name, 'actual-mcp-read', { key: 'A:125; B:120' }) }
    const result = JSON.parse(request.messages.find(m => m.role === 'tool' && m.toolCallId === 'actual-mcp-read')!.content)
    assert.equal(result.runtime_receipt.source.type, 'mcp'); assert.equal(result.result.structuredContent.value, 'A:125; B:120')
    return finish(request, ['call:actual-mcp-read'])
  })
  try {
    const done = f.wait('completed'); f.start(); await done
    const state = f.loop.exportState()
    assert.equal(calls, 3); assert.equal(state.snapshot.mcp!.servers[0]!.status, 'ready')
    const completed = f.events.find(e => e.type === 'tool.call.completed' && e.payload.callId === 'actual-mcp-read') as Extract<ServerEvent, { type: 'tool.call.completed' }>
    const receipt = completed.payload.receipt as unknown as { source: { rpcRequestId: number; serverId: string }; capabilityBinding: { capabilityId: string } }
    assert.equal(receipt.source.rpcRequestId, JSON.parse(fs.readFileSync(path.join(f.root, 'calls.jsonl'), 'utf8').trim()).rpcId)
    assert.equal(receipt.capabilityBinding.capabilityId, 'mcp:evidence:lookup')
    assert.ok(state.contextDocument!.candidates.some(c => c.source.actor === 'tool' && c.normalizedContent.includes('A:125; B:120')))
    assert.ok(f.events.some(e => e.type === 'runtime.mcp.updated' && e.payload.servers.some(s => s.status === 'ready')))
  } finally { await f.close() }
})

test('an opted-in MCP form uses bound human replies and continues the original request across a restart', async () => {
  let round = 0, runId = '', requestId = ''
  let active: RuntimeLoop
  const f = fixture(request => {
    const state = binding(request)
    assert.equal(state.runId, runId ||= state.runId)
    const wire = JSON.stringify(request)
    assert.doesNotMatch(wire, /private-mcp-token|private-form-answer|Which report should be returned/)
    switch (++round) {
      case 1: return call('load_resources', 'load-form-reader', { ids: ['mcp:evidence:lookup'] })
      case 2:
        assert.doesNotMatch(request.messages[0]!.content, /MCP 工具需要人工输入时/)
        return call(mcpToolName('evidence', 'lookup'), 'original-form-call', { key: 'original-key' })
      case 3:
      case 5: {
        assert.match(request.messages[0]!.content, /MCP 工具需要人工输入时/)
        const snapshot = active.getSnapshot(0)
        const form = snapshot.mcp!.inputRequests?.[0]
        assert.ok(form, JSON.stringify({ servers: snapshot.mcp?.servers, error: snapshot.observations.items.at(-1)?.error }))
        assert.equal(form.round, round === 3 ? 1 : 2)
        assert.equal(form.callId, 'original-form-call')
        requestId = form.id
        return reply(request, { decision: 'wait', waitSpec: { reason: '等待人工核对报告范围', signalType: 'runtime',
          condition: { eventType: 'mcp.input.responded' }, correlationIds: [requestId], deadlineRef: null } })
      }
      case 4:
      case 6:
        assert.ok(request.tools?.some(tool => tool.name === 'resume_mcp_input'))
        return call('resume_mcp_input', `continue-form-${round}`, { request_id: requestId })
      case 7:
        assert.match(wire, /report-receipt/)
        return finish(request, ['call:original-form-call', 'call:continue-form-6'])
      default: throw new Error(`unexpected round ${round}`)
    }
  }, ['mcp:evidence:lookup'], undefined, { humanForm: true })
  active = f.loop
  const valid = () => ({ requestId, responses: { report: { action: 'accept', content: { identifier: 'private-form-answer' } } } })
  try {
    const pause = f.wait('paused'); f.start(); await pause
    const state = f.loop.exportState(), firstId = requestId
    assert.equal(state.snapshot.mcp!.inputRequests![0]!.forms[0]!.fields[0]!.id, 'identifier')
    assert.throws(() => f.send('runtime.mcp.input.reply', { requestId, responses: { report: { action: 'accept', content: { identifier: 'x' } } } }), /MCP_FORM_REPLY_INVALID/)
    assert.throws(() => f.send('runtime.wait.signal', { id: 'forged-form', taskId: state.taskControl!.taskId, runId, signalType: 'external',
      eventType: 'mcp.input.responded', correlationId: requestId }), /WAIT_SIGNAL_RESERVED_EVENT/)
    await f.loop.shutdown()
    active = new RuntimeLoop({ projectDir: f.root, sessionId: 'mcp-session', llm: f.llm, initialState: state, contextOrganization: { minGroups: 100 }, stepDelayMs: 0, streamDelayMs: 0 })
    const second = f.wait('paused', active); f.send('runtime.mcp.input.reply', valid(), active)
    assert.throws(() => f.send('runtime.mcp.input.reply', valid(), active), /MCP_FORM_REPLY_NOT_PENDING/)
    await second
    assert.notEqual(requestId, firstId)
    const done = f.wait('completed', active)
    f.send('runtime.mcp.input.reply', { requestId, responses: { narrow: { action: 'decline' } } }, active)
    await done
    const calls = fs.readFileSync(path.join(f.root, 'form-rpc.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(calls, [
      { token: 'private-mcp-token-round-1', answers: { report: { action: 'accept', content: { identifier: 'private-form-answer' } } }, args: { key: 'original-key' } },
      { token: 'private-mcp-token-round-2', answers: { narrow: { action: 'decline' } }, args: { key: 'original-key' } },
    ])
    assert.doesNotMatch(JSON.stringify({ restored: active.exportState(), events: f.events }), /private-mcp-token|private-form-answer/)
    assert.ok(!active.getSnapshot(0).mcp!.inputRequests)
  } finally { if (active !== f.loop) await active.shutdown(); await f.close() }
})

for (const scenario of ['multi', 'disconnect', 'decline', 'journal'] as const) {
  test(`MCP write form ${scenario} keeps a single operation and requires real settlement`, async () => {
    let round = 0, requestId = '', operationId = '', active: RuntimeLoop
    const f = fixture(request => {
      const wire = JSON.stringify(request)
      assert.doesNotMatch(wire, /private-mcp-token|private-write-answer/)
      if (++round === 1) return call('load_resources', 'authorize-write-form', { ids: ['mcp:evidence:mutate', 'mcp:evidence:verify'] })
      if (round === 2) return call(mcpToolName('evidence', 'mutate'), 'original-write-with-form', { key: 'original-key' })
      if (round === 3 || round === 5 && scenario === 'multi') {
        const view = active.getSnapshot(0).mcp!.inputRequests?.[0]
        assert.ok(view, JSON.stringify(active.getSnapshot(0).observations.items.at(-1)?.error))
        assert.ok(view.operationId)
        assert.equal(view.operationId, operationId ||= view.operationId)
        assert.equal(view.callId, 'original-write-with-form')
        requestId = view.id
        return reply(request, { decision: 'wait', waitSpec: { reason: '等待人工写入确认', signalType: 'runtime',
          condition: { eventType: 'mcp.input.responded' }, correlationIds: [requestId], deadlineRef: null } })
      }
      if (round === 4 && scenario === 'decline') {
        assert.ok(!request.tools?.some(tool => tool.name === 'resume_mcp_write_input'))
        const signalId = active.getSnapshot(0).waits!.subscriptions[0]!.matchedSignalIds[0]
        return call('read_wait_signal', 'read-write-decision', { signal_id: signalId })
      }
      if (round === 4 || round === 6 && scenario === 'multi') {
        assert.ok(request.tools?.some(tool => tool.name === 'resume_mcp_write_input'))
        assert.ok(!request.tools?.some(tool => tool.name === 'resume_mcp_input'))
        return call('resume_mcp_write_input', `write-continuation-${round}`, { request_id: requestId })
      }
      if (scenario === 'decline' || scenario === 'journal') {
        if (scenario === 'decline') assert.equal(JSON.parse(request.messages.find(message => message.name === 'read_wait_signal')!.content).result.status, 'declined')
        else assert.equal(JSON.parse(request.messages.find(message => message.name === 'resume_mcp_write_input')!.content).error.code, 'MCP_JOURNAL_FAILED')
        return finish(request)
      }
      if (scenario === 'disconnect' && round === 5) return call('verify_mcp_side_effect', 'check-form-write', { operation_id: operationId })
      if (scenario === 'disconnect') assert.equal(JSON.parse(request.messages.find(message => message.name === 'verify_mcp_side_effect')!.content).result.outcome, 'applied')
      else assert.match(wire, /write-receipt/)
      return finish(request, ['call:original-write-with-form', ...(scenario === 'multi' ? ['call:write-continuation-6'] : [])])
    }, ['mcp:evidence:mutate', 'mcp:evidence:verify'], 'pending', { formWrite: scenario })
    active = f.loop
    const accepted = (form: string, key: string) => ({ requestId, responses: { [form]: { action: 'accept', content: { [key]: 'private-write-answer' } } } })
    const dispatches = () => fs.readFileSync(path.join(f.root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(call => call.name === 'mutate')
    try {
      const paused = f.wait('paused'); f.start(); await paused
      assert.equal(dispatches().length, 1)
      const state = active.exportState()
      const originalForm = requestId
      if (scenario === 'multi') {
        await active.shutdown()
        active = new RuntimeLoop({ projectDir: f.root, sessionId: 'mcp-session', llm: f.llm, initialState: state, contextOrganization: { minGroups: 100 }, stepDelayMs: 0, streamDelayMs: 0 })
        assert.equal(active.getSnapshot(0).mcp!.inputRequests![0]!.id, originalForm)
      }
      if (scenario === 'journal') {
        const db = new DatabaseSync(path.join(f.root, '.capybara/sessions.sqlite'))
        try { db.exec("CREATE TRIGGER reject_form_dispatch BEFORE UPDATE OF attempt_json ON runtime_mcp_inputs WHEN NEW.attempt_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture-dispatch-journal-failure'); END") }
        finally { db.close() }
      }
      const failed = scenario === 'decline' || scenario === 'journal'
      let settled = f.wait(scenario === 'multi' ? 'paused' : failed ? 'failed' : 'completed', active, 45_000)
      f.send('runtime.mcp.input.reply', scenario === 'decline' ? { requestId, responses: { report: { action: 'decline' } } } : accepted('report', 'identifier'), active)
      await settled
      if (scenario === 'multi') {
        assert.notEqual(requestId, originalForm)
        settled = f.wait('completed', active, 45_000)
        f.send('runtime.mcp.input.reply', accepted('narrow', 'region'), active)
        await settled
      }
      const calls = dispatches()
      assert.equal(calls.length, failed ? 1 : scenario === 'multi' ? 3 : 2)
      assert.ok(calls.every(call => call.operationId === operationId && call.args.key === 'original-key'))
      const store = new ContextCommitStore(f.root)
      try {
        const operation = store.readMcpOperation('mcp-session', operationId)!
        assert.equal(operation.binding?.callId, 'original-write-with-form')
        if (failed) {
          assert.equal(operation.source.outcome, 'unknown')
          assert.equal(active.getSnapshot(0).mcp!.unknownCallCount, 1)
          assert.equal(fs.existsSync(path.join(f.root, 'writes.txt')), false)
          assert.match(active.getSnapshot(0).run.failure!.message, /unknown_mcp_side_effect/)
        } else {
          assert.equal(fs.readFileSync(path.join(f.root, 'writes.txt'), 'utf8'), 'w')
          assert.equal(active.getSnapshot(0).mcp!.unknownCallCount, 0)
          if (scenario === 'multi') {
            assert.equal(operation.continuation?.callId, 'write-continuation-6')
            assert.equal(operation.continuation?.source.operationId, operationId)
            assert.notEqual(operation.source.connectionId, operation.continuation!.source.connectionId)
            assert.equal(store.readArtifactSource(operation.continuation!.artifactId, 'mcp-session')?.meta.hash, operation.continuation!.artifactHash)
          } else assert.equal(operation.verification?.outcome, 'applied')
        }
        const attempt = store.mcpInputs.writeAttempt({ sessionId: 'mcp-session', taskId: state.taskControl!.taskId, runId: state.snapshot.run.runId! }, 'write-continuation-4')
        assert.equal(attempt?.source.operationId, failed ? undefined : operationId)
      } finally { store.close() }
      assert.doesNotMatch(JSON.stringify(active.exportState()), /private-mcp-token|private-write-answer/)
    } finally { if (active !== f.loop) await active.shutdown(); await f.close() }
  })
}

for (const scenario of ['read', 'write', 'decline', 'disconnect'] as const) {
  test(`Workflow MCP form ${scenario} preserves the original node, prior actions and terminal proof`, async () => {
    const read = scenario === 'read'
    const lookup = mcpToolName('evidence', 'lookup'), mutate = mcpToolName('evidence', 'mutate')
    const grants = ['mcp:evidence:lookup', ...(!read ? ['mcp:evidence:mutate', 'mcp:evidence:verify'] : [])]
    const steps = read ? [
      { id: 'input', type: 'foreach', input: ['prefix', 'form-key', 'last'], tool: lookup, arguments: { key: { $ref: 'item' } } },
      { id: 'tail', type: 'tool', tool: lookup, arguments: { key: { $ref: 'steps.input.output.1.output.structuredContent.value' } } },
    ] : [
      { id: 'prefix', type: 'tool', tool: lookup, arguments: { key: 'prefix' } },
      { id: 'input', type: 'tool', tool: mutate, arguments: { key: { $ref: 'steps.prefix.output.structuredContent.value' } } },
      { id: 'tail', type: 'tool', tool: lookup, arguments: { key: { $ref: 'steps.input.output.structuredContent.value' } } },
    ]
    let round = 0, formId = '', workflowId = '', operationId = '', receiptId = '', active: RuntimeLoop
    const f = fixture(request => {
      const toolResult = (id: string) => JSON.parse(request.messages.find(item => item.toolCallId === id)!.content)
      assert.doesNotMatch(JSON.stringify(request), /private-mcp-token|private-workflow-answer/)
      if (++round === 1) return call('load_resources', 'workflow-form-load', { ids: grants })
      if (round === 2) return call('execute_workflow', 'workflow-form-original', { version: 1, goal: '核对记录与真实回执', steps })
      if (round === 3 || round === 5 && (scenario === 'read' || scenario === 'write')) {
        if (round === 3) {
          const partial = toolResult('workflow-form-original')
          assert.equal(partial.status, 'awaiting_input')
          workflowId = partial.workflowId
          assert.equal(read ? partial.steps.input.output[0].output.structuredContent.value : partial.steps.prefix.output.structuredContent.value, 'prefix')
          assert.equal(partial.recovery.inputRequestId, active.getSnapshot(0).mcp!.inputRequests![0]!.id)
        }
        const form = active.getSnapshot(0).mcp!.inputRequests![0]!
        formId = form.id
        assert.equal(form.workflow!.id, workflowId)
        operationId = form.operationId ?? ''
        return reply(request, { decision: 'wait', waitSpec: { reason: '等待 Workflow 人工输入', signalType: 'runtime', correlationIds: [formId],
          condition: { eventType: 'mcp.input.responded' }, deadlineRef: null } })
      }
      if (scenario === 'decline') {
        assert.equal(active.getSnapshot(0).workflows!.items[0]!.status, 'cancelled')
        assert.ok(!request.tools?.some(tool => tool.name === 'resume_workflow' || tool.name === 'resume_mcp_write_input'))
        if (round === 4) return call('verify_mcp_side_effect', 'verify-declined-operation', { operation_id: operationId })
        assert.equal(toolResult('verify-declined-operation').result.outcome, 'not_applied')
        return finish(request)
      }
      if (round === 4 || round === 6 && scenario !== 'disconnect') return call(read ? 'resume_mcp_input' : 'resume_mcp_write_input', `workflow-form-${round}`, { request_id: formId })
      if (scenario === 'disconnect' && round === 5) {
        assert.equal(toolResult('workflow-form-4').ok, false)
        assert.ok(!request.tools?.some(tool => tool.name === 'resume_workflow'))
        return call('verify_mcp_side_effect', 'verify-interrupted-form', { operation_id: operationId })
      }
      if (scenario === 'disconnect' && round === 6) {
        const verification = toolResult('verify-interrupted-form').result
        assert.equal(verification.outcome, 'applied')
        receiptId = verification.id
        assert.ok(receiptId)
        return call('resume_workflow', 'workflow-form-resume', { workflow_id: workflowId, verification_receipt_id: receiptId })
      }
      if (scenario !== 'disconnect' && round === 7) {
        receiptId = toolResult('workflow-form-6').runtime_receipt.resultArtifactId
        assert.ok(request.messages[0]!.content.includes(`"inputReceiptId":"${receiptId}"`))
        return call('resume_workflow', 'workflow-form-wrong', { workflow_id: workflowId, input_receipt_id: 'wrong-receipt' })
      }
      if (scenario !== 'disconnect' && round === 8) {
        assert.equal(toolResult('workflow-form-wrong').error.code, 'WORKFLOW_RESUME_REJECTED')
        return call('resume_workflow', 'workflow-form-resume', { workflow_id: workflowId, input_receipt_id: receiptId })
      }
      const completed = toolResult('workflow-form-resume')
      assert.equal(completed.ok, true)
      const value = read ? 'report-receipt' : 'write-receipt'
      assert.equal(completed.steps.tail.output.structuredContent.value, value)
      if (read) assert.deepEqual(completed.steps.input.output.map((entry: { output: { structuredContent: { value: string } } }) => entry.output.structuredContent.value), ['prefix', value, 'last'])
      return finish(request, ['call:workflow-form-original', 'call:workflow-form-resume'])
    }, grants, read ? undefined : 'pending', read ? { humanForm: true, formKey: 'form-key' } : { formWrite: scenario === 'disconnect' ? 'disconnect' : 'multi' })
    active = f.loop
    let stale: RuntimeLoopState | undefined, recordedFormId: string | undefined
    if (read) f.loop.onEvent(event => {
      if (event.type === 'tool.call.started' && (event.payload.arguments as { key?: string }).key === 'form-key') stale = f.loop.exportState()
      if (event.type === 'tool.call.failed' && event.payload.callId === 'workflow-form-original') {
        recordedFormId = f.loop.getSnapshot(0).mcp!.inputRequests?.[0]?.id
        f.send('run.pause', {})
      }
    })
    const submission = (form: string, key: string) => ({ requestId: formId, responses: { [form]: { action: 'accept', content: { [key]: 'private-workflow-answer' } } } })
    try {
      const paused = f.wait('paused', active, 60_000); f.start(); await paused
      if (read) {
        assert.ok(stale && recordedFormId)
        await active.shutdown()
        active = new RuntimeLoop({ projectDir: f.root, sessionId: 'mcp-session', llm: f.llm, initialState: stale, contextOrganization: { minGroups: 100 }, stepDelayMs: 0, streamDelayMs: 0 })
        const recovered = f.wait('paused', active, 60_000)
        f.send('run.resume', {}, active)
        await recovered
        assert.equal(formId, recordedFormId)
      }
      const checkpoint = active.exportState(), partial = checkpoint.snapshot.workflows!.items[0]!
      assert.equal(partial.status, 'suspended')
      assert.equal(partial.nodes.find(node => node.id === partial.recovery!.nodeId)!.status, 'awaiting_input')
      const partialId = partial.resultArtifactId
      if (scenario === 'decline') {
        fs.writeFileSync(path.join(f.root, 'operation-records.json'), JSON.stringify({ [operationId]: 'not_applied' }))
        const done = f.wait('completed', active, 60_000)
        f.send('runtime.mcp.input.reply', { requestId: formId, responses: { report: { action: 'decline' } } }, active)
        await done
      } else {
        await active.shutdown()
        active = new RuntimeLoop({ projectDir: f.root, sessionId: 'mcp-session', llm: f.llm, initialState: checkpoint, contextOrganization: { minGroups: 100 }, stepDelayMs: 0, streamDelayMs: 0 })
        if (scenario === 'disconnect') {
          const done = f.wait('completed', active, 60_000)
          f.send('runtime.mcp.input.reply', submission('report', 'identifier'), active)
          await done
        } else {
          const firstRequestId = formId
          const next = f.wait('paused', active, 60_000, () => formId !== firstRequestId)
          f.send('runtime.mcp.input.reply', submission('report', 'identifier'), active)
          await next
          const done = f.wait('completed', active, 60_000); f.send('runtime.mcp.input.reply', submission('narrow', 'region'), active); await done
        }
      }
      const plan = active.getSnapshot(0).workflows!.items[0]!
      assert.equal(plan.id, workflowId)
      const calls = fs.readFileSync(path.join(f.root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      assert.equal(calls.filter(item => item.name === 'lookup' && item.args.key === 'prefix').length, 1)
      if (scenario === 'decline') {
        assert.equal(plan.status, 'cancelled')
        assert.equal(calls.filter(item => item.name === 'mutate').length, 1)
        assert.equal(fs.existsSync(path.join(f.root, 'writes.txt')), false)
        assert.ok(!plan.continuations)
      } else {
        assert.equal(plan.status, 'completed')
        const proof = scenario === 'disconnect' ? { verificationReceiptId: receiptId } : { inputReceiptId: receiptId }
        assert.deepEqual(plan.continuations, [{ callId: 'workflow-form-resume', ...proof, partialArtifactId: partialId }])
        assert.ok(plan.nodes.every(node => node.status === 'completed'))
        if (read) assert.deepEqual(calls.map(item => item.args.key), ['prefix', 'form-key', 'form-key', 'form-key', 'last', 'report-receipt'])
        else {
          assert.equal(fs.readFileSync(path.join(f.root, 'writes.txt'), 'utf8'), 'w')
          assert.ok(calls.filter(item => item.name === 'mutate').every(item => item.operationId === operationId && item.args.key === 'prefix'))
          assert.equal(calls.filter(item => item.name === 'mutate').length, scenario === 'disconnect' ? 2 : 3)
        }
      }
    } finally { if (active !== f.loop) await active.shutdown(); await f.close() }
  })
}

test('an answered MCP form cannot dispatch after the original capability is revoked', async () => {
  let round = 0, requestId = ''
  const f = fixture(request => {
    if (++round === 1) return call('load_resources', 'load-revoked-reader', { ids: ['mcp:evidence:lookup'] })
    if (round === 2) return call(mcpToolName('evidence', 'lookup'), 'revocable-form', { key: 'original-key' })
    if (round === 3) {
      requestId = f.loop.getSnapshot(0).mcp!.inputRequests![0]!.id
      return reply(request, { decision: 'wait', waitSpec: { reason: '等待报告表单', signalType: 'runtime',
        condition: { eventType: 'mcp.input.responded' }, correlationIds: [requestId], deadlineRef: null } })
    }
    if (round === 4) {
      assert.ok(!request.tools?.some(tool => tool.name === mcpToolName('evidence', 'lookup')))
      return call('resume_mcp_input', 'revoked-form-continuation', { request_id: requestId })
    }
    assert.equal(round, 5)
    assert.match(request.messages.filter(message => message.name === 'resume_mcp_input').at(-1)!.content, /outside the bound request projection/)
    return finish(request)
  }, ['mcp:evidence:lookup'], undefined, { humanForm: true })
  try {
    const pause = f.wait('paused'); f.start(); await pause
    const config = JSON.parse(fs.readFileSync(f.configPath, 'utf8'))
    config.tool_permissions = []
    fs.writeFileSync(f.configPath, JSON.stringify(config))
    const failed = f.wait('failed')
    f.send('runtime.mcp.input.reply', { requestId, responses: { report: { action: 'accept', content: { identifier: 'restricted-form-answer' } } } })
    await failed
    assert.match(f.loop.getSnapshot(0).run.failure!.message, /pending_mcp_input/)
    assert.equal(fs.existsSync(path.join(f.root, 'form-rpc.jsonl')), false)
    assert.doesNotMatch(JSON.stringify(f.loop.exportState()), /restricted-form-answer/)
  } finally { await f.close() }
})

for (const scenario of ['reconnect', 'revoked'] as const) {
  test(`a typed MCP wait ${scenario === 'reconnect' ? 'reconnects and wakes on the original operation proof' : 'stops probing after permission revocation and expires'}`, async () => {
    let round = 0, operationId = '', runId = ''
    const f = fixture(request => {
      assert.equal(binding(request).runId, runId ||= binding(request).runId)
      switch (++round) {
        case 1: return call('load_resources', 'load-wait-tools', { ids: ['mcp:evidence:mutate', 'mcp:evidence:verify'] })
        case 2: return call(mcpToolName('evidence', 'mutate'), 'mcp-write-to-wait', { key: 'pending-key' })
        case 3: {
          const records = JSON.parse(fs.readFileSync(path.join(f.root, 'operation-records.json'), 'utf8'))
          operationId = Object.keys(records)[0]!
          assert.ok(request.messages[0]!.content.includes('"verificationPollIntervalMs":1000'))
          return call('create_wait_deadline', 'mcp-wait-deadline', { timeout_ms: scenario === 'reconnect' ? 30000 : 9000 })
        }
        case 4: {
          const deadline = request.messages.find(message => message.role === 'tool' && message.name === 'create_wait_deadline')!
          return reply(request, { decision: 'wait', waitSpec: { reason: '等待原写入的实际结算', signalType: 'runtime',
            correlationIds: [operationId], condition: { eventType: 'mcp.operation.settled' }, deadlineRef: JSON.parse(deadline.content).result.deadlineRef } })
        }
        case 5: {
          const state = active.getSnapshot(0).waits!.subscriptions[0]!
          if (scenario === 'revoked') { assert.equal(state.status, 'timed_out'); return finish(request) }
          assert.equal(state.status, 'satisfied')
          return call('read_wait_signal', 'mcp-read-proof', { signal_id: state.matchedSignalIds[0] })
        }
        case 6: {
          const proof = JSON.parse(request.messages.find(message => message.role === 'tool' && message.name === 'read_wait_signal')!.content).result
          assert.equal(proof.status, 'applied')
          assert.equal(proof.correlationId, operationId)
          assert.equal(proof.data.receiptId, `mcp-verification-${operationId}`)
          return finish(request, ['call:mcp-write-to-wait'])
        }
        default: throw new Error(`unexpected round ${round}`)
      }
    }, ['mcp:evidence:mutate', 'mcp:evidence:verify'], 'pending', { pollMs: 1000 })
    let active = f.loop
    const calls = () => fs.readFileSync(path.join(f.root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    try {
      const paused = f.wait('paused'); f.start(); await paused
      const state = active.exportState()
      assert.throws(() => f.send('runtime.wait.signal', { id: 'forged-proof', taskId: state.taskControl!.taskId, runId,
        signalType: 'external', eventType: 'mcp.operation.settled', correlationId: operationId, status: 'applied' }), /WAIT_SIGNAL_RESERVED_EVENT/)
      const probeUntil = Date.now() + 9000
      while (!calls().some(call => call.name === 'verify') && Date.now() < probeUntil) await delay(25)
      const probes = calls().filter(call => call.name === 'verify').length
      assert.ok(probes > 0)
      if (scenario === 'reconnect') {
        await active.shutdown()
        fs.writeFileSync(path.join(f.root, 'operation-records.json'), JSON.stringify({ [operationId]: 'applied' }))
        active = new RuntimeLoop({ projectDir: f.root, sessionId: 'mcp-session', llm: f.llm, initialState: state, contextOrganization: { minGroups: 100 }, stepDelayMs: 0, streamDelayMs: 0 })
        await f.wait('completed', active)
        assert.equal(round, 6)
        assert.equal(active.getSnapshot(0).mcp!.unknownCallCount, 0)
      } else {
        const config = JSON.parse(fs.readFileSync(f.configPath, 'utf8'))
        config.tool_permissions = ['mcp:evidence:mutate']
        fs.writeFileSync(f.configPath, JSON.stringify(config))
        fs.writeFileSync(path.join(f.root, 'operation-records.json'), JSON.stringify({ [operationId]: 'applied' }))
        await f.wait('failed', active)
        assert.equal(round, 5)
        assert.equal(active.getSnapshot(0).mcp!.unknownCallCount, 1)
        assert.equal(calls().filter(call => call.name === 'verify').length, probes)
        assert.match(active.getSnapshot(0).run.failure!.message, /unknown_mcp_side_effect/)
      }
      assert.equal(calls().filter(call => call.name === 'mutate').length, 1)
      assert.ok(calls().filter(call => call.name === 'verify').every(call => call.args.operation_id === operationId))
    } finally { if (active !== f.loop) await active.shutdown(); await f.close() }
  })
}

test('an MCP tool without the exact host grant is rejected before tools/call', async () => {
  let calls = 0
  const f = fixture(() => ++calls === 1 ? call('load_resources', 'load-denied', { ids: ['mcp:evidence:lookup'] }) : call(mcpToolName('evidence', 'lookup'), 'forbidden', { key: 'denied' }), [])
  try {
    const done = f.wait('failed'); f.start(); await done
    assert.equal(f.loop.exportState().snapshot.run.failure!.code, 'RUNTIME_ENVELOPE_TOOL_UNAUTHORIZED')
    assert.equal(fs.existsSync(path.join(f.root, 'calls.jsonl')), false)
  } finally { await f.close() }
})

test('investigation projects host-approved MCP reads and excludes a remotely claimed readonly write', async () => {
  let calls = 0
  const task = { id: 'inspect', title: '核对来源', phase: 'investigation' as const, owner: 'parent', dependsOn: [], capabilityIds: ['mcp:evidence:lookup', 'mcp:evidence:mutate'],
    completionConditions: ['读取有证据的来源'], requiredActions: ['call:investigate-mcp'], evidenceRefs: [], status: 'pending' as 'pending' | 'completed' }
  const f = fixture(request => {
    calls++
    if (calls === 1 || calls === 4) return reply(request, { decision: 'propose_plan', planProposal: { basePlanRevision: calls === 1 ? 0 : 1, goal: '只读核对', tasks: [{ ...task, requiredActions: calls === 1 ? [] : task.requiredActions, status: calls === 1 ? 'pending' : 'completed' }] } })
    if (calls === 2) return call('load_resources', 'load-both', { ids: ['mcp:evidence:lookup', 'mcp:evidence:mutate'] })
    if (calls === 3) {
      assert.ok(request.tools!.some(t => t.name === mcpToolName('evidence', 'lookup')))
      assert.ok(!request.tools!.some(t => t.name === mcpToolName('evidence', 'mutate')))
      return call(mcpToolName('evidence', 'lookup'), 'investigate-mcp', { key: 'host-policy-wins' })
    }
    return finish(request)
  })
  try {
    const done = f.wait('completed'); f.start(); await done
    assert.equal(calls, 5); assert.equal(fs.existsSync(path.join(f.root, 'writes.txt')), false)
  } finally { await f.close() }
})

test('a restored queued MCP call gets a new connection and model decision instead of reusing the old authorization', async () => {
  let calls = 0, paused = false, restored: RuntimeLoop | undefined
  const name = mcpToolName('evidence', 'lookup')
  const f = fixture(request => {
    if (++calls === 1) return call('load_resources', 'load-restore', { ids: ['mcp:evidence:lookup'] })
    if (calls === 2) return call(name, 'old-queued', { key: 'must-not-dispatch' })
    if (calls === 3) {
      assert.ok(request.messages.some(m => m.role === 'tool' && m.toolCallId === 'old-queued' && JSON.parse(m.content).error.dispatched === false))
      assert.ok(request.tools!.some(t => t.name === name))
      return call(name, 'fresh-after-reopen', { key: 'fresh-result' })
    }
    return finish(request, ['call:fresh-after-reopen'])
  })
  f.loop.onEvent(event => {
    if (paused || event.type !== 'timeline.step.upserted' || event.payload.step.detail?.callId !== 'old-queued' || event.payload.step.status !== 'pending') return
    paused = true; f.send('run.pause', {})
  })
  try {
    const ready = f.wait('paused'); f.start(); await ready
    const before = f.loop.exportState(), connection = before.snapshot.mcp!.servers[0]!.connectionId
    await f.loop.shutdown()
    restored = new RuntimeLoop({ projectDir: f.root, sessionId: 'mcp-session', initialState: before, llm: f.llm, contextOrganization: { minGroups: 100 }, stepDelayMs: 0, streamDelayMs: 0 })
    const done = f.wait('completed', restored); f.send('run.resume', {}, restored); await done
    const after = restored.exportState()
    assert.equal(calls, 4); assert.equal(after.taskControl!.taskId, before.taskControl!.taskId)
    assert.equal(after.snapshot.run.runId, before.snapshot.run.runId); assert.equal(after.taskControl!.capabilityRecovery!.attempts, 1)
    assert.notEqual(after.snapshot.mcp!.servers[0]!.connectionId, connection)
    const actual = fs.readFileSync(path.join(f.root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(actual.length, 1); assert.equal(actual[0].args.key, 'fresh-result')
  } finally { await restored?.shutdown(); await f.close() }
})

test('an unknown MCP write blocks completion and its signature persists in runtime state', async () => {
  let calls = 0
  const f = fixture(request => {
    if (++calls === 1) return call('load_resources', 'load-mutate', { ids: ['mcp:evidence:mutate'] })
    if (calls === 2) return call(mcpToolName('evidence', 'mutate'), 'unknown-write', { key: 'write-once' })
    return finish(request)
  })
  try {
    fs.writeFileSync(path.join(f.root, 'control.json'), '{"mode":"timeout"}')
    const done = f.wait('failed'); f.start(); await done
    const state = f.loop.exportState()
    assert.equal(calls, 3); assert.equal(state.snapshot.run.failure!.code, 'RUNTIME_TASK_COMPLETION_BLOCKED')
    assert.equal(state.mcp!.unknownCalls.length, 1); assert.equal(state.mcp!.unknownCalls[0]![1].outcome, 'unknown')
    assert.ok(state.snapshot.timeline.steps.some(step => step.detail?.unknownOutcome === true))
    assert.equal(fs.readFileSync(path.join(f.root, 'writes.txt'), 'utf8'), 'w')
  } finally { await f.close() }
})

for (const outcome of ['applied', 'not_applied'] as const) test(`MCP ${outcome} is verified against the original operation after reopening`, async () => {
  const mutate = mcpToolName('evidence', 'mutate')
  let round = 0, operationId = '', paused = false, restored: RuntimeLoop | undefined, stale: RuntimeLoopState | undefined
  const restoredEvents: ServerEvent[] = []
  const forgedView = () => path.join(f.root, 'verification-view')
  const f = fixture(request => {
    if (request.messages[0]?.content.includes('# Capybara Context Organizer Prompt')) {
      const { organizationVersion, snapshotId, mode } = JSON.parse(request.messages[1]!.content)
      return { provider: 'custom', model: 'mcp-test', raw: {}, text: JSON.stringify({ organizationVersion, snapshotId, mode,
        observations: [], diffProposals: [], archiveProposals: [], recallProposals: [], coverageProposal: null, uncertainties: [] }) }
    }
    const result = (id: string) => JSON.parse(request.messages.filter(message => message.toolCallId === id).at(-1)!.content)
    if (++round === 1) return call('load_resources', 'load-verification-tools', { ids: ['mcp:evidence:mutate', 'mcp:evidence:verify'] })
    if (round === 2) return call(mutate, 'original-write', { key: 'deduplicated-effect' })
    if (round === 3) {
      const original = result('original-write')
      assert.equal(original.runtime_receipt.source.outcome, 'unknown')
      assert.equal(original.runtime_receipt.source.operationId, operationId)
      assert.match(request.messages[0]!.content, new RegExp(operationId))
      assert.ok(request.tools?.some(tool => tool.name === 'verify_mcp_side_effect'))
      fs.writeFileSync(forgedView(), '00000000-0000-4000-8000-000000000000')
      return call('verify_mcp_side_effect', 'misbound-read', { operation_id: operationId })
    }
    if (round === 4) {
      assert.equal(result('misbound-read').result.outcome, 'unknown')
      assert.equal(restored?.getSnapshot(0).mcp?.unknownCallCount, 1)
      fs.unlinkSync(forgedView())
      return call('verify_mcp_side_effect', 'real-verification', { operation_id: operationId })
    }
    if (round === 5) {
      const confirmed = result('real-verification').result
      assert.equal(confirmed.outcome, outcome, JSON.stringify(restored?.exportState().artifacts.find(item => item.meta.id === confirmed.verificationArtifactId)?.value))
      assert.equal(confirmed.operationId, operationId)
      assert.ok(confirmed.artifactId)
      assert.ok(!request.tools?.some(tool => tool.name === 'verify_mcp_side_effect'))
      if (outcome === 'applied') return finish(request, ['call:original-write'])
      return call(mutate, 'original-write', { key: 'deduplicated-effect' })
    }
    if (round === 6) {
      const rejected = result('original-write')
      assert.equal(rejected.error.code, 'RECOVERY_BLOCKED')
      assert.equal(rejected.runtime_receipt.source.dispatched, false)
      return call(mutate, 'fresh-write', { key: 'deduplicated-effect' })
    }
    assert.equal(round, 7)
    return finish(request, ['call:fresh-write'])
  }, ['mcp:evidence:mutate', 'mcp:evidence:verify'], outcome)
  f.loop.onEvent(event => {
    if (outcome === 'applied' && event.type === 'tool.call.started' && event.payload.callId === 'original-write') stale = f.loop.exportState()
    if (paused || event.type !== 'tool.call.failed' || event.payload.callId !== 'original-write') return
    paused = true
    const receipt = event.payload.receipt as unknown as { source: { operationId: string } }
    operationId = receipt.source.operationId
    f.send('run.pause', {})
  })
  try {
    const pause = f.wait('paused'); f.start(); await pause
    const before = f.loop.exportState()
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'operation-records.json'), 'utf8'))[operationId], outcome)
    await f.loop.shutdown()
    assert.equal(Boolean(stale), outcome === 'applied')
    restored = new RuntimeLoop({ projectDir: f.root, sessionId: 'mcp-session', initialState: stale ?? before, llm: f.llm,
      contextOrganization: { minGroups: 100 }, stepDelayMs: 0, streamDelayMs: 0 })
    restored.onEvent(event => restoredEvents.push(event as ServerEvent))
    const done = f.wait('completed', restored, 60_000); f.send('run.resume', {}, restored); await done
    const after = restored.exportState()
    assert.equal(after.snapshot.run.runId, before.snapshot.run.runId)
    assert.equal(after.snapshot.mcp?.unknownCallCount, 0)
    assert.equal(after.mcp?.unknownCalls.length, 0)
    assert.equal(fs.readFileSync(path.join(f.root, 'writes.txt'), 'utf8'), 'w')
    const calls = fs.readFileSync(path.join(f.root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(calls.map(call => call.name), ['mutate', 'verify', 'verify', ...(outcome === 'not_applied' ? ['mutate'] : [])])
    assert.equal(calls[0].operationId, operationId)
    if (outcome === 'applied') assert.ok(!restoredEvents.some(event => event.type === 'tool.call.started' && event.payload.callId === 'original-write'))
    if (outcome === 'not_applied') assert.notEqual(calls[3].operationId, operationId)
    const store = new ContextCommitStore(f.root)
    try {
      const actual = store.readMcpOperation('mcp-session', operationId)
      assert.equal(actual?.verification?.outcome, outcome)
      assert.equal(actual?.source.outcome, 'unknown')
      assert.equal(actual?.verification?.source.rpcRequestId, calls[2].rpcId)
      assert.ok(store.readArtifactSource(actual!.verification!.artifactId, 'mcp-session'))
      assert.throws(() => store.settleMcpOperation('mcp-session', actual!.source), /MCP_OPERATION_REBOUND/)
      assert.equal(store.loadUnknownMcpOperations('mcp-session').length, 0)
      assert.equal(store.readMcpOperation('foreign-session', operationId), undefined)
    } finally { store.close() }
  } finally { await restored?.shutdown(); await f.close() }
})

for (const scenario of ['applied', 'not_applied', 'missing_output', 'late_output', 'independent'] as const) test(`Workflow recovers recorded MCP steps and ${scenario} proof under fresh authority`, async () => {
  const foreach = scenario === 'not_applied'
  const mutate = mcpToolName('evidence', 'mutate')
  const lookup = mcpToolName('evidence', 'lookup')
  const steps = foreach ? [
    { id: 'write', type: 'foreach', input: ['first', 'second', 'third'], tool: mutate, arguments: { key: { $ref: 'item' } } },
    { id: 'check', type: 'tool', tool: lookup, arguments: { key: { $ref: 'steps.write.output.0.output.structuredContent.value' } } },
  ] : [
    { id: 'prefix', type: 'tool', tool: lookup, arguments: { key: 'known-prefix' } },
    { id: 'write', type: 'tool', tool: mutate, arguments: { key: { $ref: 'steps.prefix.output.structuredContent.value' } } },
    { id: 'check', type: 'tool', tool: lookup, arguments: { key: scenario === 'independent' ? 'independent-check' : { $ref: 'steps.write.output.structuredContent.value' } } },
  ]
  let round = 0, workflowId = '', operationId = '', partialArtifactId = '', paused = false
  let verificationReceiptId = '', verificationArtifactId = '', supplementalArtifactId = ''
  let restored: RuntimeLoop | undefined, stale: RuntimeLoopState | undefined
  const f = fixture(request => {
    if (request.messages[0]?.content.includes('# Capybara Context Organizer Prompt')) {
      const { organizationVersion, snapshotId, mode } = JSON.parse(request.messages[1]!.content)
      return { provider: 'custom', model: 'mcp-test', raw: {}, text: JSON.stringify({ organizationVersion, snapshotId, mode,
        observations: [], diffProposals: [], archiveProposals: [], recallProposals: [], coverageProposal: null, uncertainties: [] }) }
    }
    const result = (id: string) => JSON.parse(request.messages.filter(message => message.toolCallId === id).at(-1)!.content)
    if (++round === 1) return call('load_resources', 'workflow-load', { ids: ['mcp:evidence:lookup', 'mcp:evidence:mutate', 'mcp:evidence:verify'] })
    if (round === 2) return call('execute_workflow', 'workflow-original', { version: 1, goal: '写入并使用实际结果核查', steps })
    if (round === 3) {
      const partial = result('workflow-original')
      assert.equal(partial.ok, false)
      assert.equal(partial.workflowId, workflowId)
      assert.equal(partial.recovery.operationId, operationId)
      assert.equal(partial.steps.check.status, 'skipped')
      if (foreach) assert.equal(partial.steps.write.output[0].output.structuredContent.value, 'first')
      else assert.equal(partial.steps.prefix.output.structuredContent.value, 'known-prefix')
      assert.ok(!request.tools?.some(tool => tool.name === 'resume_workflow'))
      return call('verify_mcp_side_effect', 'workflow-verify', { operation_id: operationId })
    }
    if (round === 4) {
      const proof = result('workflow-verify').result
      assert.equal(proof.outcome, foreach ? 'not_applied' : 'applied')
      assert.ok(request.tools?.some(tool => tool.name === 'resume_workflow'))
      verificationReceiptId = proof.id
      verificationArtifactId = proof.artifactId
      return call('resume_workflow', 'workflow-continue', { workflow_id: workflowId, verification_receipt_id: proof.id })
    }
    if (scenario === 'late_output' && round === 5) {
      assert.match(result('workflow-continue').error.message, /needs the original MCP result/)
      assert.ok(request.tools?.some(tool => tool.name === 'verify_mcp_side_effect'))
      fs.writeFileSync(path.join(f.root, 'verification-original'), JSON.stringify({ content: [{ type: 'text', text: 'known-prefix' }], structuredContent: { value: 'known-prefix' } }))
      return call('verify_mcp_side_effect', 'workflow-read-original', { operation_id: operationId })
    }
    if (scenario === 'late_output' && round === 6) {
      const proof = result('workflow-read-original').result
      assert.equal(proof.originalResultAvailable, true)
      assert.equal(proof.id, verificationReceiptId)
      assert.equal(proof.artifactId, verificationArtifactId)
      supplementalArtifactId = proof.originalResult.artifactId
      assert.notEqual(supplementalArtifactId, verificationArtifactId)
      return call('resume_workflow', 'workflow-continue-late', { workflow_id: workflowId, verification_receipt_id: proof.id })
    }
    assert.equal(round, scenario === 'late_output' ? 7 : 5)
    const resumeCall = scenario === 'late_output' ? 'workflow-continue-late' : 'workflow-continue'
    const resumed = result(resumeCall)
    if (scenario === 'missing_output') {
      assert.equal(resumed.ok, false)
      assert.match(resumed.error.message, /needs the original MCP result/)
      return finish(request)
    }
    assert.equal(resumed.ok, true, JSON.stringify(resumed))
    assert.equal(resumed.workflowId, workflowId)
    assert.equal(resumed.steps.check.output.structuredContent.value, foreach ? 'first' : scenario === 'independent' ? 'independent-check' : 'known-prefix')
    if (scenario === 'independent') {
      assert.equal(resumed.steps.write.outputUnavailable, true)
      assert.equal(resumed.steps.write.output, undefined)
    }
    if (foreach) assert.deepEqual(resumed.steps.write.output.map((item: { output: { structuredContent: { value: string } } }) => item.output.structuredContent.value), ['first', 'second', 'third'])
    return finish(request, ['call:workflow-original', `call:${resumeCall}`])
  }, ['mcp:evidence:lookup', 'mcp:evidence:mutate', 'mcp:evidence:verify'], foreach ? 'not_applied' : 'applied', {
    verify_key: foreach ? 'second' : 'known-prefix', report_original: scenario === 'applied',
  })
  f.loop.onEvent(event => {
    if (!stale && event.type === 'tool.call.started' && event.payload.toolName === mutate) stale = f.loop.exportState()
    if (paused || event.type !== 'tool.call.failed' || event.payload.callId !== 'workflow-original') return
    paused = true
    const plan = f.loop.getSnapshot(0).workflows.items[0]!
    assert.ok(plan.recovery?.operationId)
    workflowId = plan.id; operationId = plan.recovery.operationId; partialArtifactId = plan.resultArtifactId!
    f.send('run.pause', {})
  })
  try {
    const pause = f.wait('paused', f.loop, 60_000); f.start(); await pause
    assert.ok(stale && operationId && partialArtifactId)
    await f.loop.shutdown()
    restored = new RuntimeLoop({ projectDir: f.root, sessionId: 'mcp-session', initialState: stale, llm: f.llm,
      contextOrganization: { minGroups: 100 }, stepDelayMs: 0, streamDelayMs: 0 })
    const done = f.wait(scenario === 'missing_output' ? 'failed' : 'completed', restored, 60_000)
    f.send('run.resume', {}, restored); await done
    const final = restored.exportState()
    const plan = final.snapshot.workflows.items[0]!
    assert.equal(final.snapshot.run.runId, stale.snapshot.run.runId)
    assert.equal(plan.id, workflowId)
    assert.equal(plan.status, scenario === 'missing_output' ? 'failed' : 'completed')
    if (scenario === 'missing_output') assert.equal(final.snapshot.run.failure?.code, 'RUNTIME_TASK_COMPLETION_BLOCKED')
    else {
      assert.equal(plan.continuations?.at(-1)?.callId, scenario === 'late_output' ? 'workflow-continue-late' : 'workflow-continue')
      assert.notEqual(plan.continuations?.at(-1)?.partialArtifactId, plan.resultArtifactId)
      assert.ok(final.artifacts.some(item => item.meta.id === plan.continuations?.at(-1)?.partialArtifactId))
      if (scenario === 'late_output') assert.equal(plan.nodes.find(node => node.id === 'write')?.outputArtifactId, supplementalArtifactId)
    }
    const calls = fs.readFileSync(path.join(f.root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    if (foreach) {
      assert.deepEqual(calls.map(call => [call.name, call.args.key]), [['mutate', 'first'], ['mutate', 'second'], ['verify', undefined], ['mutate', 'second'], ['mutate', 'third'], ['lookup', 'first']])
      assert.notEqual(calls[1].operationId, calls[3].operationId)
      assert.equal(fs.readFileSync(path.join(f.root, 'writes.txt'), 'utf8'), 'www')
    } else {
      assert.deepEqual(calls.map(call => call.name), ['lookup', 'mutate', 'verify', ...(scenario === 'late_output' ? ['verify', 'lookup'] : scenario === 'missing_output' ? [] : ['lookup'])])
      assert.equal(fs.readFileSync(path.join(f.root, 'writes.txt'), 'utf8'), 'w')
    }
  } finally { await restored?.shutdown(); await f.close() }
})
