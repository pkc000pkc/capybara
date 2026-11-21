import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { initializeProjectDirectory } from '#core/project-initializer'
import { RuntimeLoop, type RuntimeLlm } from '#core/runtime-loop'
import { RuntimeWaitStore } from '#core/runtime-wait-store'
import type { RuntimeLoopState } from '#core/runtime-loop-state'
import type { ClientCommand, ControlEnvelopeV2, RuntimeRequestBinding, ServerEvent } from '#protocol/runtime-protocol'
import type { LlmChatRequest, LlmChatResponse } from '#util/llm'

function binding(request: LlmChatRequest): RuntimeRequestBinding {
  const match = request.messages[0]!.content.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)
  assert.ok(match); return JSON.parse(match[0])
}
function reply(request: LlmChatRequest, fields: Partial<ControlEnvelopeV2>): LlmChatResponse {
  return { provider: 'custom', model: 'wait-test', text: JSON.stringify({ envelopeVersion: 2, binding: binding(request), decision: 'continue', userMessage: '', actions: [], planProposal: null,
    candidateDiffs: [], evidenceRequests: [], uncertainties: [], waitSpec: null, completionCheck: null, ...fields }), raw: {} }
}
function wait(request: LlmChatRequest, ids = ['source-A'], deadlineRef: string | null = null) {
  return reply(request, { decision: 'wait', waitSpec: { reason: '等待来源就绪', signalType: 'external', correlationIds: ids, condition: { eventType: 'ready', status: 'ready' }, deadlineRef } })
}
function finish(request: LlmChatRequest): LlmChatResponse {
  return reply(request, { decision: 'finish', userMessage: '已重新检查等待结果。', completionCheck: { taskId: binding(request).taskId, requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '收到真实等待结算' } })
}
function call(name: string, id: string, args: Record<string, unknown>): LlmChatResponse {
  return { provider: 'custom', model: 'wait-test', text: '', raw: {}, toolCalls: [{ id, name, arguments: args }] }
}
function fixture(actor: (request: LlmChatRequest) => LlmChatResponse) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-runtime-wait-'))
  initializeProjectDirectory(root)
  const llm: RuntimeLlm = { getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'wait-test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }), chat: async request => actor(request) }
  let loop = new RuntimeLoop({ projectDir: root, sessionId: 'wait-session', llm, stepDelayMs: 0, streamDelayMs: 0, contextOrganization: { minGroups: 100 } })
  const events: ServerEvent[] = []
  loop.onEvent(event => events.push(event as ServerEvent))
  let sequence = 0
  const command = (type: ClientCommand['type'], payload: unknown) => ({ version: 1, kind: 'command', id: `wait-command-${++sequence}`, type, sessionId: 'wait-session', timestamp: new Date().toISOString(), payload } as ClientCommand)
  const send = (type: ClientCommand['type'], payload: unknown) => { const cmd = command(type, payload); loop.validate(cmd); loop.execute(cmd, sequence) }
  return { root, events, llm, command, send, get loop() { return loop },
    start() { send('chat.message.send', { clientMessageId: `wait-message-${++sequence}`, content: [{ type: 'text', text: '按真实信号继续。' }], autoStart: true }) },
    signal(id: string, correlationId = 'source-A', status = 'ready') { const state = loop.exportState(); send('runtime.wait.signal', { id, taskId: state.taskControl!.taskId, runId: state.snapshot.run.runId!, signalType: 'external', eventType: 'ready', correlationId, status }) },
    until(status: string) { return new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { off(); reject(new Error(`wait run did not reach ${status}: ${JSON.stringify(loop.exportState().snapshot.run)}`)) }, 15000)
      const off = loop.onEvent(event => { if (event.type !== 'run.state.changed') return; if (event.payload.status === status) { clearTimeout(timer); off(); resolve() }
        else if (event.payload.status === 'failed') { clearTimeout(timer); off(); reject(new Error(event.payload.failure?.message)) } }) }) },
    reopen(initialState: RuntimeLoopState) { loop.close(); loop = new RuntimeLoop({ projectDir: root, sessionId: 'wait-session', initialState, llm, stepDelayMs: 0, streamDelayMs: 0, contextOrganization: { minGroups: 100 } }); loop.onEvent(event => events.push(event as ServerEvent)) },
    close() { loop.close(); fs.rmSync(root, { recursive: true, force: true }) },
  }
}

test('a real wait requires every correlation, deduplicates signals and cannot be bypassed by resume or a new run', async () => {
  let calls = 0
  const f = fixture(request => ++calls === 1 ? wait(request, ['source-A', 'source-B']) : finish(request))
  try {
    const paused = f.until('paused'); f.start(); await paused
    for (const type of ['run.resume', 'run.start', 'run.step', 'run.restartStep', 'run.restorePrevious', 'run.restoreCheckpoint'] as const) assert.throws(() => f.loop.validate(f.command(type, {})), /WAIT_PENDING/)
    assert.throws(() => f.loop.execute(f.command('run.step', {}), 100), /WAIT_PENDING/)
    f.signal('wrong', 'source-A', 'not-ready'); f.signal('first'); f.signal('first')
    await delay(60); assert.equal(calls, 1)
    assert.equal(f.loop.exportState().snapshot.waits!.subscriptions[0]!.status, 'pending')
    assert.throws(() => f.signal('first', 'source-B'), /WAIT_SIGNAL_ID_CONFLICT/)
    const done = f.until('completed'); f.signal('second', 'source-B'); await done
    assert.equal(calls, 2)
    const result = f.loop.exportState().snapshot.waits!.subscriptions[0]!
    assert.equal(result.status, 'satisfied'); assert.deepEqual(result.matchedSignalIds, ['first', 'second'])
  } finally { f.close() }
})

test('a host-clock deadline resumes with timed_out and never claims business success', async () => {
  let calls = 0, expiresAt = 0
  const f = fixture(request => {
    if (++calls === 1) return call('create_wait_deadline', 'timer-1', { timeout_ms: 1200 })
    if (calls === 2) {
      const result = JSON.parse(request.messages.find(message => message.role === 'tool' && message.name === 'create_wait_deadline')!.content).result
      expiresAt = Date.parse(result.expiresAt)
      return reply(request, { decision: 'wait', waitSpec: { reason: '等待观察窗口结束', signalType: 'runtime', correlationIds: [result.deadlineRef], condition: { eventType: 'deadline' }, deadlineRef: result.deadlineRef } })
    }
    assert.ok(Date.now() >= expiresAt)
    assert.ok(request.messages[0]!.content.includes('timed_out'))
    return finish(request)
  })
  try {
    const done = f.until('completed'); f.start(); await done
    assert.equal(calls, 3); assert.equal(f.loop.exportState().snapshot.waits!.subscriptions[0]!.status, 'timed_out')
  } finally { f.close() }
})

test('a durable wait checkpoint replaces an older directory cursor and consumes an offline signal on the original task', async () => {
  let calls = 0, stale: RuntimeLoopState | undefined
  const f = fixture(request => { if (++calls === 1) { stale = f.loop.exportState(); return wait(request) } return finish(request) })
  try {
    const paused = f.until('paused'); f.start(); await paused
    const current = f.loop.exportState(); f.loop.close()
    const store = new RuntimeWaitStore(f.root)
    try { store.recordSignal({ id: 'offline-ready', sessionId: 'wait-session', taskId: current.taskControl!.taskId, runId: current.snapshot.run.runId!, signalType: 'external', eventType: 'ready', correlationId: 'source-A', status: 'ready' }) }
    finally { store.close() }
    f.reopen(stale!)
    const done = f.until('completed'); await done
    assert.equal(calls, 2); assert.equal(f.loop.exportState().snapshot.run.runId, current.snapshot.run.runId)
    assert.equal(f.loop.exportState().taskControl!.taskId, current.taskControl!.taskId)
    assert.equal(f.loop.exportState().snapshot.waits!.subscriptions[0]!.status, 'satisfied')
  } finally { f.close() }
})

test('reopening a deadline that elapsed while closed delivers one real timeout', async () => {
  let calls = 0, expires = 0
  const f = fixture(request => {
    if (++calls === 1) return call('create_wait_deadline', 'offline-timer', { timeout_ms: 1200 })
    if (calls === 2) { const result = JSON.parse(request.messages.find(message => message.role === 'tool' && message.name === 'create_wait_deadline')!.content).result; expires = Date.parse(result.expiresAt); return wait(request, ['source-A'], result.deadlineRef) }
    return finish(request)
  })
  try {
    const paused = f.until('paused'); f.start(); await paused
    const saved = f.loop.exportState(); f.loop.close(); await delay(Math.max(1, expires - Date.now() + 20))
    f.reopen(saved); const done = f.until('completed'); await done
    assert.equal(calls, 3)
    assert.equal(f.loop.exportState().artifacts.filter(a => JSON.stringify(a.value).includes('"kind":"wait-receipt"')).length, 1)
  } finally { f.close() }
})

test('clients cannot forge tool/runtime wait signals or cross-task events', async () => {
  const f = fixture(request => wait(request))
  try {
    const paused = f.until('paused'); f.start(); await paused
    const state = f.loop.exportState()
    const payload = { id: 'forged', taskId: state.taskControl!.taskId, runId: state.snapshot.run.runId!, signalType: 'tool', eventType: 'ready', correlationId: 'source-A', status: 'ready' }
    assert.throws(() => f.loop.validate(f.command('runtime.wait.signal', payload)), /external or user/)
    assert.throws(() => f.loop.execute(f.command('runtime.wait.signal', payload), 100), /external or user/)
    assert.throws(() => f.loop.validate(f.command('runtime.wait.signal', { ...payload, signalType: 'external', id: 'tool:reserved-host-id' })), /host namespace/)
    assert.throws(() => f.loop.validate(f.command('runtime.wait.signal', { ...payload, signalType: 'external', taskId: 'other-task' })), /BINDING_MISMATCH/)
    assert.equal(f.loop.exportState().snapshot.waits!.subscriptions[0]!.status, 'pending')
  } finally { f.close() }
})

test('explicit wait cancellation settles the wait separately from task completion', async () => {
  let calls = 0
  const f = fixture(request => ++calls === 1 ? wait(request) : finish(request))
  try {
    const paused = f.until('paused'); f.start(); await paused
    const waitId = f.loop.exportState().contextControl!.waitId!
    const done = f.until('completed'); f.send('runtime.wait.cancel', { waitId, reason: '用户取消等待，重新核对任务' }); await done
    assert.equal(calls, 2); assert.equal(f.loop.exportState().snapshot.waits!.subscriptions[0]!.status, 'cancelled')
  } finally { f.close() }
})

test('the resumed model reads a matched signal payload through the ordinary source and evidence path', async () => {
  let calls = 0
  const f = fixture(request => {
    if (++calls === 1) return wait(request)
    if (calls === 2) {
      assert.ok(request.tools?.some(tool => tool.name === 'read_wait_signal'))
      return call('read_wait_signal', 'inspect-signal', { signal_id: 'source-payload' })
    }
    const observation = request.messages.find(message => message.role === 'tool' && message.name === 'read_wait_signal')!
    assert.ok(observation.content.includes('来源 A 的原始说明')); return finish(request)
  })
  try {
    const paused = f.until('paused'); f.start(); await paused
    const state = f.loop.exportState(), done = f.until('completed')
    f.send('runtime.wait.signal', { id: 'source-payload', taskId: state.taskControl!.taskId, runId: state.snapshot.run.runId!, signalType: 'external', eventType: 'ready', correlationId: 'source-A', status: 'ready', data: { text: '来源 A 的原始说明', claim: 125 } })
    await done; assert.equal(calls, 3)
    assert.ok(f.loop.exportState().artifacts.some(artifact => artifact.meta.kind === 'tool-result' && JSON.stringify(artifact.value).includes('来源 A 的原始说明')))
  } finally { f.close() }
})

test('cancelling a waiting run leaves no timer-driven model continuation', async () => {
  let calls = 0
  const f = fixture(request => { calls++; return wait(request) })
  try {
    const paused = f.until('paused'); f.start(); await paused
    f.send('run.cancel', {}); f.signal('late-signal'); await delay(60)
    assert.equal(calls, 1); assert.equal(f.loop.exportState().snapshot.run.status, 'cancelled')
    assert.equal(f.loop.exportState().snapshot.waits!.subscriptions[0]!.status, 'cancelled')
  } finally { f.close() }
})

test('explicit checkpoint restoration cannot resurrect a settled wait subscription', async () => {
  let calls = 0
  const f = fixture(request => ++calls === 1 ? wait(request) : finish(request))
  try {
    const paused = f.until('paused'); f.start(); await paused
    const saved = f.loop.exportState(), checkpoint = saved.checkpoints.at(-1)!
    f.send('run.cancel', {})
    f.send('run.restoreCheckpoint', { checkpointId: checkpoint.id })
    assert.equal(f.loop.exportState().contextControl!.status, 'idle')
    const done = f.until('completed'); f.send('run.resume', {}); await done
    assert.equal(calls, 2)
    assert.equal(f.loop.exportState().snapshot.waits!.subscriptions[0]!.status, 'cancelled')
  } finally { f.close() }
})

test('an older paused snapshot cannot resurrect a run whose wait was cancelled by the user', async () => {
  let calls = 0
  const f = fixture(request => { calls++; return wait(request) })
  try {
    const paused = f.until('paused'); f.start(); await paused
    const old = f.loop.exportState(); f.send('run.cancel', {})
    f.reopen(old); await delay(80)
    assert.equal(calls, 1); assert.equal(f.loop.exportState().snapshot.run.status, 'cancelled')
    assert.equal(f.loop.exportState().snapshot.waits!.subscriptions[0]!.cancelledBy, 'run')
  } finally { f.close() }
})

test('user cancellation wins the resume race even when the signal already settled the wait', async () => {
  let calls = 0
  const f = fixture(request => { calls++; return wait(request) })
  try {
    const paused = f.until('paused'); f.start(); await paused
    const old = f.loop.exportState(); f.signal('settled-before-cancel'); f.send('run.cancel', {})
    f.reopen(old); await delay(80)
    assert.equal(calls, 1); assert.equal(f.loop.exportState().snapshot.run.status, 'cancelled')
    const receipt = f.loop.exportState().snapshot.waits!.subscriptions[0]!
    assert.equal(receipt.status, 'satisfied'); assert.ok(receipt.runCancelledAt)
  } finally { f.close() }
})

test('runtime process waits use real host lifecycle events, including those observed before subscription', async () => {
  let calls = 0
  const f = fixture(request => {
    if (++calls === 1) return call('search_resources', 'process-lookup', { query: 'files' })
    if (calls === 2) {
      const process = f.loop.exportState().snapshot.processes!.items.find(item => item.name === 'search_resources')!
      assert.equal(process.status, 'succeeded')
      return reply(request, { decision: 'wait', waitSpec: { reason: '核对实际进程结算', signalType: 'runtime', correlationIds: [process.id], condition: { eventType: 'process.status', status: 'succeeded' }, deadlineRef: null } })
    }
    return finish(request)
  })
  try { const done = f.until('completed'); f.start(); await done; assert.equal(calls, 3); assert.equal(f.loop.exportState().snapshot.waits!.subscriptions[0]!.status, 'satisfied') }
  finally { f.close() }
})

test('a tool receipt that arrived before subscription is not lost', async () => {
  let calls = 0
  const f = fixture(request => {
    if (++calls === 1) return call('search_resources', 'lookup-complete', { query: 'files' })
    if (calls === 2) return reply(request, { decision: 'wait', waitSpec: { reason: '核对真实工具结算', signalType: 'tool', correlationIds: ['lookup-complete'], condition: { eventType: 'tool.completed', status: 'succeeded' }, deadlineRef: null } })
    return finish(request)
  })
  try { const done = f.until('completed'); f.start(); await done; assert.equal(calls, 3); assert.equal(f.loop.exportState().snapshot.waits!.subscriptions[0]!.status, 'satisfied') }
  finally { f.close() }
})

for (const invalid of ['deadline', 'tool'] as const) test(`a fabricated ${invalid} binding is rejected without publishing a wait`, async () => {
  const f = fixture(request => reply(request, { decision: 'wait', waitSpec: { reason: '不得伪造宿主身份', signalType: invalid === 'tool' ? 'tool' : 'external', correlationIds: ['not-real'], condition: { eventType: 'ready' }, deadlineRef: invalid === 'deadline' ? 'not-real' : null } }))
  try {
    const done = f.until('failed'); f.start(); await done
    assert.ok(!f.events.some(event => event.type === 'runtime.waits.updated'))
    assert.equal(f.loop.exportState().contextControl!.status, 'idle')
  } finally { f.close() }
})

test('SQL failure before registration publishes no successful wait or partial subscription', async () => {
  const f = fixture(request => wait(request))
  const db = new DatabaseSync(path.join(f.root, '.capybara/sessions.sqlite'))
  try {
    db.exec("CREATE TRIGGER wait_registration_fault BEFORE INSERT ON runtime_waits BEGIN SELECT RAISE(ABORT,'WAIT_REGISTRATION_FAULT'); END")
    const done = f.until('failed'); f.start(); await done
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM runtime_waits').get() as { count: number }).count, 0)
    assert.ok(!f.events.some(event => event.type === 'runtime.context.v2.control.pending'))
    assert.equal(f.loop.exportState().contextControl!.status, 'idle')
  } finally { db.close(); f.close() }
})

test('a crash after the wait intent but before registration restores an honest interruption and fresh decision', async () => {
  let calls = 0, captured: RuntimeLoopState | undefined
  const f = fixture(request => ++calls === 1 ? wait(request) : finish(request))
  try {
    const stopped = new Promise<void>(resolve => f.loop.onEvent(event => {
      if (captured || event.type !== 'timeline.step.upserted' || event.payload.step.type !== 'model' || event.payload.step.status !== 'success') return
      captured = f.loop.exportState(); f.loop.close(); resolve()
    }))
    f.start(); await stopped
    assert.equal(captured!.contextControl!.status, 'waiting')
    f.reopen(captured!)
    assert.equal(f.loop.exportState().snapshot.run.status, 'interrupted')
    assert.equal(f.loop.exportState().snapshot.run.failure!.code, 'WAIT_REGISTRATION_NOT_COMMITTED')
    assert.equal(f.loop.exportState().contextControl!.status, 'idle')
    const done = f.until('completed'); f.send('run.resume', {}); await done
    assert.equal(calls, 2)
    assert.equal(f.loop.exportState().snapshot.waits?.subscriptions.length ?? 0, 0)
  } finally { f.close() }
})

test('all unexpired host deadlines remain visible beyond the old three-item projection limit', async () => {
  let calls = 0
  const ids: string[] = []
  const f = fixture(request => {
    if (++calls === 1) {
      const store = new RuntimeWaitStore(f.root)
      try { for (let index = 0; index < 4; index++) ids.push(store.createDeadline(binding(request), `host-window-${index}`, 60000).id) }
      finally { store.close() }
      return { provider: 'custom', model: 'wait-test', raw: {}, text: '', toolCalls: [{ id: 'create-fifth-window', name: 'create_wait_deadline', arguments: { timeout_ms: 60000 } }] }
    }
    const result = JSON.parse(request.messages.filter(message => message.role === 'tool' && message.name === 'create_wait_deadline').at(-1)!.content)
    assert.equal(result.ok, true)
    ids.push(result.result.deadlineRef)
    for (const id of ids) assert.ok(request.messages[0]!.content.includes(id), `missing live host deadline ${id}`)
    assert.equal(f.loop.exportState().snapshot.waits!.deadlines.length, 5)
    return finish(request)
  })
  try { const done = f.until('completed'); f.start(); await done; assert.equal(calls, 2); assert.equal(new Set(ids).size, 5) }
  finally { f.close() }
})
