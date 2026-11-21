import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { initializeProjectDirectory } from '#core/project-initializer'
import { RuntimeLoop, type RuntimeChildAgentResult, type RuntimeLoopOptions, type RuntimeLlm } from '#core/runtime-loop'
import { RuntimeChildStore, terminalChild, type ChildSpec } from '#core/runtime-child-store'
import type { RuntimeLoopState } from '#core/runtime-loop-state'
import type { ClientCommand, ControlEnvelopeV2, RuntimePlanTask, RuntimeRequestBinding, ServerEvent } from '#protocol/runtime-protocol'
import type { LlmChatRequest, LlmChatResponse } from '#util/llm'

function binding(request: LlmChatRequest): RuntimeRequestBinding {
  const match = request.messages[0]!.content.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)
  assert.ok(match); return JSON.parse(match[0])
}
function response(request: LlmChatRequest, fields: Partial<ControlEnvelopeV2>): LlmChatResponse {
  return { provider: 'custom', model: 'child-test', raw: {}, text: JSON.stringify({ envelopeVersion: 2, binding: binding(request), decision: 'continue', userMessage: '', actions: [], planProposal: null,
    candidateDiffs: [], evidenceRequests: [], uncertainties: [], waitSpec: null, completionCheck: null, ...fields }) }
}
function finish(request: LlmChatRequest): LlmChatResponse {
  return response(request, { decision: 'finish', userMessage: '已核对真实子结果和来源。', completionCheck: { taskId: binding(request).taskId, requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '必要结果均经父层消费' } })
}
function ask(request: LlmChatRequest): LlmChatResponse {
  return response(request, { decision: 'ask_user', userMessage: '需要补充来源。', actions: [{ kind: 'ask_user', question: '需要补充来源。', blockingTaskIds: [binding(request).taskId] }] })
}
function call(name: string, id: string, args: Record<string, unknown>): LlmChatResponse { return { provider: 'custom', model: 'child-test', text: '', raw: {}, toolCalls: [{ name, id, arguments: args }] } }
function result(request: LlmChatRequest, name: string): any {
  const message = request.messages.filter(item => item.role === 'tool' && item.name === name).at(-1)
  assert.ok(message, `missing ${name} result`)
  const parsed = JSON.parse(message.content); assert.equal(parsed.ok, true, message.content); return parsed.result
}
function waitChild(request: LlmChatRequest, ref: string): LlmChatResponse {
  return response(request, { decision: 'wait', waitSpec: { reason: '等待子任务就绪或需要输入', signalType: 'runtime', correlationIds: [ref], condition: { eventType: 'child.ready' }, deadlineRef: null } })
}
function review(request: LlmChatRequest, decision = 'accept'): LlmChatResponse {
  const read = result(request, 'read_child_result')
  return call('consume_child_result', `review-${binding(request).requestId}`, { child_id: read.childId, result_hash: read.result_hash, read_receipt_id: read.read_receipt_id, decision, reason: '已核对来源身份、执行状态与结果；观点保持为候选。' })
}
function fixture(actor: (request: LlmChatRequest) => LlmChatResponse | Promise<LlmChatResponse>, options: Partial<RuntimeLoopOptions> = {}, contextWindow?: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-child-runtime-'))
  initializeProjectDirectory(root)
  if (contextWindow) {
    const file = path.join(root, '.capybara/config.json')
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    settings.context = { ...settings.context, context_window_tokens: contextWindow, max_input_tokens: contextWindow - 2_000 }
    fs.writeFileSync(file, JSON.stringify(settings))
  }
  const llm: RuntimeLlm = { getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'child-test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }), chat: async request => actor(request) }
  const config = { projectDir: root, sessionId: 'child-parent', llm, childAgentEnabled: true, streamDelayMs: 0, stepDelayMs: 0, contextOrganization: { minGroups: 100 }, ...options }
  let loop = new RuntimeLoop(config)
  const events: ServerEvent[] = []
  loop.onEvent(event => events.push(event as ServerEvent))
  let sequence = 0
  const send = (type: ClientCommand['type'], payload: unknown) => { const command = { version: 1, kind: 'command', id: `child-command-${++sequence}`, sessionId: 'child-parent', type, timestamp: new Date().toISOString(), payload } as ClientCommand; loop.validate(command); loop.execute(command, sequence) }
  return { root, events, send, get loop() { return loop },
    start() { send('chat.message.send', { clientMessageId: `message-${++sequence}`, content: [{ type: 'text', text: '委派只读工作，继续独立检查，再核对真实子结果。' }], autoStart: true }) },
    until(status: string) { return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`parent did not reach ${status}: ${JSON.stringify(loop.exportState().snapshot.run)}`)) }, 20000)
      const off = loop.onEvent(event => { if (event.type !== 'run.state.changed') return; if (event.payload.status === status) { clearTimeout(timer); off(); resolve() }
        else if (event.payload.status === 'failed') { clearTimeout(timer); off(); console.error('CHILD_TEST_FAILURE', JSON.stringify(loop.exportState().artifacts.find(artifact => artifact.meta.id === event.payload.failure?.errorArtifactId)?.value)); reject(new Error(event.payload.failure?.message)) } })
    }) },
    reopen(state = loop.exportState()) { loop.close(); loop = new RuntimeLoop({ ...config, initialState: state }); loop.onEvent(event => events.push(event as ServerEvent)); return state },
    close() { loop.close(); fs.rmSync(root, { recursive: true, force: true }) },
  }
}

test('async delegation returns a real handle, allows independent work, waits and requires a later source review', async () => {
  let calls = 0, resolveChild!: (result: RuntimeChildAgentResult) => void, childId = '', waitRef = ''
  let hostBinding: Parameters<NonNullable<RuntimeLoopOptions['childAgentHost']>>[0] | undefined
  const f = fixture(request => {
    calls++
    if (calls === 1) return call('delegate_task', 'delegate-async', { goal: '核对来源分歧', prompt: '只读整理 A/B 的不同观点。', mode: 'async' })
    if (calls === 2) {
      const handle = result(request, 'delegate_task'); childId = handle.childId; waitRef = handle.waitRef
      assert.equal(f.loop.exportState().snapshot.children!.items[0]!.consumption, undefined)
      return call('search_resources', 'independent-read', { query: 'files' })
    }
    if (calls === 3) return waitChild(request, waitRef)
    if (calls === 4) return call('read_child_result', 'read-child', { child_id: childId })
    if (calls === 5) {
      const read = result(request, 'read_child_result')
      assert.ok(read.output_excerpt.includes('A 认为应处理 X；B 认为不应处理 X'))
      assert.equal(read.local_evidence, undefined)
      return review(request)
    }
    assert.equal(calls, 6); return finish(request)
  }, { childAgentHost: async input => new Promise(resolve => { hostBinding = input; resolveChild = resolve }) })
  try {
    const paused = f.until('paused'); f.start(); await paused
    assert.equal(calls, 3); assert.ok(f.events.some(event => event.type === 'tool.call.completed' && event.payload.toolName === 'search_resources'))
    const done = f.until('completed'); resolveChild({ ok: true, output: 'A 认为应处理 X；B 认为不应处理 X。两方证据均保留。', evidence: { sourceA: 'A', sourceB: 'B' } }); await done
    const state = f.loop.exportState()
    const child = state.snapshot.children!.items[0]!
    assert.ok(hostBinding)
    assert.equal(hostBinding.parentSessionId, 'child-parent')
    assert.equal(hostBinding.parentTaskId, state.taskControl!.taskId)
    assert.equal(hostBinding.parentRunId, state.snapshot.run.runId)
    const dispatch = state.snapshot.timeline.steps.find(step => step.type === 'tool' && step.detail?.callId === 'delegate-async')
    assert.ok(dispatch)
    assert.equal(hostBinding.parentStepId, dispatch.id)
    assert.equal(child.id, childId); assert.equal(child.status, 'succeeded'); assert.equal(child.consumption!.decision, 'accept')
    assert.ok(child.resultArtifactId); assert.equal(f.loop.exportState().contextDocument!.candidates.find(item => item.source.actor === 'child-agent')!.status, 'pending')
    assert.equal(f.loop.exportState().contextDocument!.information.length, 0)
  } finally { f.close() }
})

for (const runner of ['host', 'local'] as const) {
  test(`queued ${runner} child recovery preserves its registered runner after the host configuration changes`, async () => {
    let localCalls = 0, hostCalls = 0
    const actor = (request: LlmChatRequest) => {
      if (binding(request).sessionId === 'child-parent') return ask(request)
      localCalls += 1
      return finish(request)
    }
    const f = fixture(actor)
    let restored: RuntimeLoop | undefined
    const store = new RuntimeChildStore(f.root)
    try {
      const paused = f.until('paused')
      f.start()
      await paused
      const state = f.loop.exportState()
      const scope = { sessionId: 'child-parent', taskId: state.taskControl!.taskId, runId: state.snapshot.run.runId! }
      const spec: ChildSpec = { goal: '检查来源', prompt: '只读核对来源。', mode: 'async', timeoutMs: 10000,
        capabilityIds: [], maxModelRounds: 2, maxToolRounds: 1, maxTotalTokens: 40000, parentContext: '{}', runner }
      const job = store.reserve(scope, 'queued-before-dispatch', spec, 'original-dispatch').record
      assert.equal(store.reserve(scope, job.callId, spec, 'replayed-dispatch').record.parentStepId, 'original-dispatch')
      f.loop.close()
      restored = new RuntimeLoop({ projectDir: f.root, sessionId: scope.sessionId, initialState: state, childAgentEnabled: true,
        llm: { getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'child-test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }),
          chat: async request => actor(request) }, streamDelayMs: 0, stepDelayMs: 0,
        ...(runner === 'local' ? { childAgentHost: async () => { hostCalls += 1; return { ok: true, output: 'unexpected host reroute' } } } : {}),
      })
      const until = Date.now() + 7000
      let result = store.load(scope, job.id)
      while (!terminalChild(result.status) && Date.now() < until) {
        await delay(20)
        result = store.load(scope, job.id)
      }
      assert.equal(result.spec.runner, runner)
      assert.equal(result.parentStepId, 'original-dispatch')
      assert.equal(hostCalls, 0)
      if (runner === 'local') {
        assert.equal(result.status, 'succeeded')
        assert.equal(localCalls, 1)
      } else {
        assert.equal(result.status, 'failed')
        assert.match(JSON.stringify(result.error), /registered child host is unavailable/)
        assert.equal(localCalls, 0)
      }
    } finally {
      restored?.close()
      store.close()
      f.close()
    }
  })
}

test('a real child.ready event unlocks its plan branch after independent work completes', async () => {
  const tasks: RuntimePlanTask[] = [
    { id: 'delegated', title: '读取并审核委派结果', phase: 'execution', owner: 'parent', dependsOn: [], capabilityIds: ['delegate_task', 'search_resources'],
      completionConditions: ['通过真实读取回执审核'], requiredActions: ['call:scope-child-review'], evidenceRefs: [], status: 'pending' },
    { id: 'local', title: '独立核对本地资源', phase: 'investigation', owner: 'parent', dependsOn: [], capabilityIds: ['search_resources'],
      completionConditions: ['读取目录'], requiredActions: ['call:scope-child-independent'], evidenceRefs: [], status: 'pending' },
  ]
  let calls = 0, childId = '', waitRef = '', resolveChild!: (value: RuntimeChildAgentResult) => void
  const f = fixture(request => {
    calls++
    if ([1, 6, 9].includes(calls)) {
      if (calls === 6) tasks[1]!.status = 'completed'
      if (calls === 9) tasks[0]!.status = 'completed'
      return response(request, { decision: 'propose_plan',
        planProposal: { basePlanRevision: calls === 1 ? 0 : calls === 6 ? 1 : 2, goal: '子任务和本地核对分别结算', tasks: tasks.map(node => node.status === 'pending' ? { ...node, requiredActions: [] } : node) } })
    }
    if (calls === 2) return call('delegate_task', 'scope-child-start', { goal: '核对原件', prompt: '只读返回两方来源。', mode: 'async', plan_task_id: 'delegated' })
    if (calls === 3) {
      const handle = result(request, 'delegate_task'); childId = handle.childId; waitRef = handle.waitRef
      assert.equal(handle.planTaskId, 'delegated')
      return response(request, { decision: 'wait', waitSpec: { reason: '混合运行时事件关联值', signalType: 'runtime', correlationIds: [waitRef, childId],
        condition: { eventType: 'child.ready' }, deadlineRef: null, blockingTaskIds: ['delegated'] } })
    }
    if (calls === 4) {
      assert.match(request.messages.at(-1)!.content, /WAIT_RUNTIME_BINDING_UNKNOWN/)
      return response(request, { decision: 'wait', waitSpec: { reason: '等待委派分支的真实结果', signalType: 'runtime', correlationIds: [waitRef],
        condition: { eventType: 'child.ready' }, deadlineRef: null, blockingTaskIds: ['delegated'] } })
    }
    if (calls === 5) {
      assert.ok(!request.tools?.some(tool => tool.name === 'delegate_task'))
      return call('search_resources', 'scope-child-independent', { query: 'files' })
    }
    if (calls === 7) {
      assert.match(request.messages[0]!.content, /"phase":"delegation"/)
      assert.ok(!request.tools?.some(tool => ['delegate_task', 'search_resources'].includes(tool.name)))
      return call('read_child_result', 'scope-child-read', { child_id: childId })
    }
    if (calls === 8) {
      const read = result(request, 'read_child_result')
      assert.equal(read.planTaskId, 'delegated')
      assert.match(read.output_excerpt, /保留两方来源/)
      return call('consume_child_result', 'scope-child-review', { child_id: childId, result_hash: read.result_hash,
        read_receipt_id: read.read_receipt_id, decision: 'accept', reason: '审核真实子结果，保留来源' })
    }
    assert.equal(calls, 10)
    return finish(request)
  }, { planningRequired: true, childAgentHost: async input => {
    assert.equal(input.planTaskId, 'delegated')
    assert.deepEqual(input.allowedCapabilityIds, ['runtime:search_resources'])
    assert.ok(input.allowedCapabilities?.every(capability => capability.schemaHash && capability.sourceVersion))
    return new Promise(resolve => { resolveChild = resolve })
  } })
  try {
    const paused = f.until('paused'); f.start(); await paused
    const view = f.loop.getSnapshot(0)
    assert.equal(calls, 6)
    assert.equal(view.taskControl!.tasks[1]!.status, 'completed')
    assert.deepEqual(view.taskControl!.branchBlocks?.map(block => block.taskIds), [['delegated']])
    assert.deepEqual(view.waits?.subscriptions.map(wait => wait.spec.correlationIds), [[waitRef]])
    assert.deepEqual(view.taskControl!.childAssignments, [{ planTaskId: 'delegated', childId, state: 'delegated' }])
    assert.equal(view.children!.items[0]!.consumption, undefined)
    const done = f.until('completed')
    resolveChild({ ok: true, output: '保留两方来源。', evidence: { sourceA: 'A', sourceB: 'B' } })
    await done
    const state = f.loop.getSnapshot(0)
    assert.equal(state.children!.items[0]!.consumption?.decision, 'accept')
    assert.equal(state.children!.items[0]!.planTaskId, 'delegated')
    assert.deepEqual(state.taskControl!.childAssignments, [{ planTaskId: 'delegated', childId, state: 'accepted' }])
    assert.equal(state.waits?.subscriptions.find(wait => wait.spec.correlationIds.includes(waitRef))?.status, 'satisfied')
    assert.ok(!state.taskControl!.branchBlocks?.length)
    f.reopen()
    assert.deepEqual(f.loop.getSnapshot(0).taskControl!.childAssignments, state.taskControl!.childAssignments)
  } finally { f.close() }
})

test('child review receipts belong to the delegated node while independent work is active', async () => {
  const tasks: RuntimePlanTask[] = [
    { id: 'delegated', title: '审核子来源', phase: 'execution', owner: 'parent', dependsOn: [], capabilityIds: ['delegate_task', 'search_resources'],
      completionConditions: ['审核子来源'], requiredActions: [], evidenceRefs: [], status: 'pending' },
    { id: 'local', title: '独立查目录', phase: 'execution', owner: 'parent', dependsOn: [], capabilityIds: ['search_resources'],
      completionConditions: ['查目录'], requiredActions: [], evidenceRefs: [], status: 'pending' },
  ]
  let calls = 0
  const f = fixture(request => {
    switch (++calls) {
      case 1:
        return response(request, { decision: 'propose_plan', planProposal: { goal: '两项只读工作', basePlanRevision: 0, tasks } })
      case 2:
        return call('delegate_task', 'review-source-child', { goal: '核对来源', prompt: '只读核对。', mode: 'sync', plan_task_id: 'delegated' })
      case 3:
        return call('read_child_result', 'read-assigned-child', { child_id: result(request, 'delegate_task').childId })
      case 4: {
        const read = request.messages.find(message => message.toolCallId === 'read-assigned-child')!
        const receipt = JSON.parse(read.content).runtime_receipt
        assert.deepEqual(receipt.activePlanTaskIds, ['local'])
        assert.deepEqual(receipt.completionPlanTaskIds, ['delegated'])
        return review(request)
      }
      case 5: {
        const consumed = request.messages.filter(message => message.name === 'consume_child_result').at(-1)!
        const receipt = JSON.parse(consumed.content).runtime_receipt
        assert.deepEqual(receipt.activePlanTaskIds, ['local'])
        assert.deepEqual(receipt.completionPlanTaskIds, ['delegated'])
        const state = JSON.parse(request.messages[0]!.content.split('\n').find(line => line.startsWith('{"taskId":'))!)
        const reviewActions = state.recentPlanActions.filter((action: { toolName: string }) => ['read_child_result', 'consume_child_result'].includes(action.toolName))
        assert.deepEqual(reviewActions.map((action: { taskIds: string[] }) => action.taskIds), [['delegated'], ['delegated']])
        return response(request, { decision: 'complete_plan_nodes', planProgress: { basePlanRevision: 1,
          nodes: [{ id: 'delegated', actionRefs: ['call:read-assigned-child', receipt.completionActionRef], evidenceRefs: [] }] } })
      }
      case 6:
        return call('search_resources', 'independent-directory', { query: 'files' })
      case 7:
        return response(request, { decision: 'complete_plan_nodes', planProgress: { basePlanRevision: 2,
          nodes: [{ id: 'local', actionRefs: ['call:independent-directory'], evidenceRefs: [] }] } })
      default:
        return finish(request)
    }
  }, { planningRequired: true, childAgentHost: async () => ({ ok: true, output: '已核对只读来源。' }) })
  try {
    const done = f.until('completed'); f.start(); await done
    assert.equal(calls, 8)
    const settled = f.loop.exportState().taskControl!.tasks
    assert.deepEqual(settled.map(task => task.status), ['completed', 'completed'])
    assert.deepEqual(settled[1]!.requiredActions, ['call:independent-directory'])
  } finally { f.close() }
})

test('planned delegation rejects a sibling-only capability and a dependency-blocked target', async () => {
  let calls = 0, workers = 0
  const f = fixture(request => {
    calls++
    if (calls === 1) {
      const task = (id: string, capabilityIds: string[], dependsOn: string[] = []): RuntimePlanTask =>
        ({ id, title: id, owner: 'parent', phase: 'execution', capabilityIds, dependsOn, completionConditions: ['完成节点'], requiredActions: [], evidenceRefs: [], status: 'pending' })
      return response(request, { decision: 'propose_plan', planProposal: { basePlanRevision: 0, goal: '检查窄授权', tasks: [
        task('child', ['delegate_task']), task('sibling', ['search_resources']), task('blocked', ['delegate_task'], ['sibling']),
      ] } })
    }
    if (calls === 2) {
      assert.ok(request.tools?.some(tool => tool.name === 'search_resources'))
      return call('delegate_task', 'leak', { goal: '越过节点能力', prompt: '不要启动', plan_task_id: 'child', capability_ids: ['runtime:search_resources'] })
    }
    const previous = request.messages.filter(message => message.role === 'tool' && message.name === 'delegate_task').at(-1)
    assert.ok(previous)
    assert.equal(JSON.parse(previous.content).ok, false)
    if (calls === 3) {
      assert.match(previous.content, /CHILD_CAPABILITY_NOT_GRANTED/)
      assert.ok(JSON.parse(previous.content).error.message.includes(JSON.stringify({ basePlanRevision: 1,
        updateTasks: [{ id: 'child', addCapabilityIds: ['runtime:search_resources'] }] })))
      return call('delegate_task', 'blocked-id', { goal: '未就绪节点', prompt: '不要启动', plan_task_id: 'blocked' })
    }
    assert.match(previous.content, /CHILD_PLAN_TASK_NOT_ACTIVE_OR_AMBIGUOUS/)
    if (calls > 4) assert.match(request.messages.at(-1)!.content, /CHILD_PLAN_DELEGATION_MUST_BE_EXCLUSIVE/)
    return { provider: 'custom', model: 'child-test', text: '', raw: {}, toolCalls: [
      { name: 'delegate_task', id: 'delegate-batched', arguments: { goal: '混合派发', prompt: '不应执行', plan_task_id: 'child' } },
      { name: 'search_resources', id: 'sibling-batched', arguments: { query: 'files' } },
    ] }
  }, { planningRequired: true, childAgentHost: async () => { workers++; return { ok: true, output: 'unexpected worker' } } })
  try {
    const failed = f.until('failed'); f.start(); await failed
    assert.equal(workers, 0)
    assert.equal(calls, 7)
    assert.equal(f.loop.getSnapshot(0).run.failure?.code, 'CHILD_PLAN_DELEGATION_MUST_BE_EXCLUSIVE')
    assert.ok(!f.events.some(event => event.type === 'tool.call.started' && event.payload.callId === 'sibling-batched'))
    assert.ok(!f.loop.getSnapshot(0).taskControl?.childAssignments)
  } finally { f.close() }
})

test('a durable child assignment restores its accepted plan from a stale parent snapshot', async () => {
  let calls = 0, stale!: RuntimeLoopState
  const f = fixture(request => {
    if (++calls === 1) {
      stale = f.loop.exportState()
      assert.equal(stale.taskControl?.planRevision, 0)
      return response(request, { decision: 'propose_plan', planProposal: { basePlanRevision: 0, goal: '保存委派义务', tasks: [
        { id: 'job', title: '验证资料来源', phase: 'investigation', owner: 'parent', capabilityIds: ['delegate_task'], dependsOn: [],
          requiredActions: ['tool:read_child_result'], evidenceRefs: [], completionConditions: ['读取真实子结果'], status: 'pending' },
      ] } })
    }
    if (calls === 2) return call('delegate_task', 'durable-assignment', { plan_task_id: 'job', goal: '查资料', prompt: '读取实际资料' })
    assert.equal(calls, 3)
    assert.match(request.messages[0]!.content, /"phase":"delegation"/)
    return ask(request)
  }, { planningRequired: true, childAgentHost: async () => ({ ok: true, output: '保留的子结果' }) })
  try {
    const paused = f.until('paused'); f.start(); await paused
    const original = f.loop.getSnapshot(0)
    const childId = original.taskControl!.childAssignments![0]!.childId
    f.reopen(stale)
    const recovered = f.loop.getSnapshot(0)
    assert.equal(recovered.run.runId, original.run.runId)
    assert.equal(recovered.taskControl?.planRevision, 1)
    assert.deepEqual(recovered.taskControl?.requiredActions, ['tool:read_child_result'])
    assert.deepEqual(recovered.taskControl!.childAssignments, [{ planTaskId: 'job', childId, state: 'delegated' }])
  } finally { f.close() }
})

test('parent takeover preserves failed child evidence and redelivers its own durable action after restart', async () => {
  const tasks: RuntimePlanTask[] = [
    { id: 'source', title: '核对目录来源', phase: 'investigation', owner: 'parent', dependsOn: [],
      capabilityIds: ['delegate_task', 'search_resources'], completionConditions: ['完成目录检查'],
      requiredActions: ['call:takeover-review'], evidenceRefs: [], status: 'pending' },
    { id: 'dependent', title: '复核已查目录', phase: 'verification', owner: 'parent', dependsOn: ['source'],
      capabilityIds: ['search_resources'], completionConditions: ['按前一节点结果复核'],
      requiredActions: ['call:takeover-dependent'], evidenceRefs: [], status: 'pending' },
  ]
  let calls = 0, childId = '', stale!: RuntimeLoopState
  const f = fixture(request => {
    if (request.messages[0]?.content.includes('# Capybara Context Organizer Prompt')) {
      const input = JSON.parse(request.messages[1]!.content)
      return { provider: 'custom', model: 'child-test', raw: {}, text: JSON.stringify({
        organizationVersion: 1, mode: input.mode, snapshotId: input.snapshotId, observations: [], diffProposals: [], archiveProposals: [],
        recallProposals: [], coverageProposal: null, uncertainties: [],
      }) }
    }
    calls++
    const plan = (basePlanRevision: number) => response(request, { decision: 'propose_plan', planProposal: {
      basePlanRevision, goal: '父层接管并保持原完成条件', tasks: tasks.map(node => node.status === 'pending' ? { ...node, requiredActions: [] } : node),
    } })
    if (calls === 1) return plan(0)
    if (calls === 2) return call('delegate_task', 'takeover-delegate', { plan_task_id: 'source', goal: '核对目录', prompt: '请检查来源。', mode: 'sync' })
    if (calls === 3) {
      const child = result(request, 'delegate_task')
      assert.equal(child.status, 'failed')
      childId = child.childId
      return call('read_child_result', 'takeover-read', { child_id: childId })
    }
    if (calls === 4) {
      const read = result(request, 'read_child_result')
      return call('consume_child_result', 'takeover-review', { child_id: childId, decision: 'reject', reason: '子任务未取得来源',
        result_hash: read.result_hash, read_receipt_id: read.read_receipt_id })
    }
    if (calls === 5) {
      const review = result(request, 'consume_child_result')
      return call('take_over_child_task', 'takeover-control', { child_id: childId, plan_task_id: 'source',
        review_receipt_id: review.reviewReceipt.receiptId, reason: '父层直接核对目录' })
    }
    if (calls === 6) {
      return response(request, { decision: 'propose_plan', planProposal: { basePlanRevision: 1, goal: '父层接管并保持原完成条件',
        tasks: [{ ...tasks[0]!, status: 'completed' }, { ...tasks[1]!, requiredActions: [] }] } })
    }
    if (calls === 7 || calls === 8) {
      assert.match(request.messages[0]!.content, /"parentTakeover":\{"planTaskId":"source"/)
      assert.ok(!request.tools?.some(tool => tool.name === 'delegate_task'))
      if (calls === 7) {
        assert.match(request.messages.at(-1)!.content, /RUNTIME_PLAN_COMPLETION_UNVERIFIED.*source.*takeoverId/)
        stale = f.loop.exportState()
      }
      return call('search_resources', 'takeover-proof', { query: 'files', limit: 1 })
    }
    if (calls === 9) {
      result(request, 'search_resources')
      tasks[0]!.requiredActions.push('call:takeover-proof')
      tasks[0]!.status = 'completed'
      return plan(1)
    }
    if (calls === 10) {
      assert.match(request.messages[0]!.content, /"activeTaskIds":\["dependent"\]/)
      assert.doesNotMatch(request.messages[0]!.content, /"parentTakeover":/)
      return call('search_resources', 'takeover-dependent', { query: 'files', limit: 1 })
    }
    if (calls === 11) { tasks[1]!.status = 'completed'; return plan(2) }
    assert.equal(calls, 12)
    return finish(request)
  }, { planningRequired: true, childAgentHost: async () => ({ ok: false, error: { code: 'SOURCE_UNAVAILABLE', message: '来源读取失败' } }) }, 24_000)
  try {
    const off = f.loop.onEvent(event => {
      if (event.type === 'tool.call.completed' && event.payload.callId === 'takeover-proof') { off(); f.send('run.pause', {}) }
    })
    const paused = f.until('paused'); f.start(); await paused
    const first = f.loop.getSnapshot(0)
    const takeoverId = first.taskControl!.childAssignments![0]!.takeoverId
    assert.ok(takeoverId)
    assert.equal(first.children!.items[0]?.status, 'failed')
    assert.equal(first.children!.items[0]?.consumption?.decision, 'reject')
    f.reopen(stale)
    assert.equal(f.loop.getSnapshot(0).taskControl?.childAssignments?.[0]?.takeoverId, takeoverId)
    const complete = f.until('completed'); f.send('run.resume', {}); await complete
    assert.equal(f.events.filter(event => event.type === 'tool.call.started' && event.payload.callId === 'takeover-proof').length, 1)
    const receipts = f.events.flatMap(event => event.type === 'tool.call.completed' && event.payload.callId === 'takeover-proof' ? [event.payload.receipt as any] : [])
    assert.equal(receipts.length, 2)
    assert.ok(receipts[1].redelivered)
    assert.equal(receipts[0].resultArtifactId, receipts[1].resultArtifactId)
    assert.equal(receipts[1].parentTakeover.takeoverId, takeoverId)
    assert.equal(f.loop.getSnapshot(0).run.runId, first.run.runId)
    const db = new DatabaseSync(path.join(f.root, '.capybara/sessions.sqlite'))
    try { assert.equal((db.prepare('SELECT COUNT(*) AS n FROM runtime_child_takeover_actions').get() as { n: number }).n, 1) }
    finally { db.close() }
  } finally { f.close() }
})

test('Parent Merge uses the real child result and produces a candidate-only session proposal', async () => {
  let calls = 0
  let assistantCalls = 0
  const f = fixture(request => {
    if (++calls === 1) return call('delegate_task', 'merge-child', { goal: '核对来源', prompt: '保留双方观点', mode: 'sync' })
    if (calls === 2) return call('read_child_result', 'read-merge-child', { child_id: result(request, 'delegate_task').childId })
    if (calls === 3) {
      const { mergeAdvice } = result(request, 'read_child_result')
      assert.equal(mergeAdvice.candidateDiffCount, 1, JSON.stringify(mergeAdvice))
      assert.ok(mergeAdvice.rawArtifactId)
      assert.equal(f.loop.exportState().snapshot.children!.items[0]!.consumption, undefined)
      return review(request, 'conflict')
    }
    return finish(request)
  }, { childAgentHost: async () => ({ ok: true, output: '来源 A 支持处理；来源 B 反对处理。' }),
    contextAssistant: { modes: ['parent_merge'], llm: {
      getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'merge-test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }),
      chat: async request => {
        assistantCalls++
        assert.equal(request.tools, undefined)
        const input = request.messages[0]!.content.split('\n')
        const { snapshotId } = JSON.parse(input.find(line => line.startsWith('{"organizationVersion":1,"snapshotId":'))!)
        const { candidateId, evidenceRefs, output, childId } = JSON.parse(input.find(line => line.startsWith('{"childId":'))!)
        assert.match(output, /A 支持处理；来源 B 反对处理/)
        assert.equal(childId, f.loop.exportState().snapshot.children!.items[0]!.id)
        const session = input.filter(line => line.startsWith('{"sessionId":"child-parent","scope":"session"')).map(line => JSON.parse(line))[0]
        return { provider: 'custom', model: 'merge-test', raw: {}, text: JSON.stringify({ organizationVersion: 1, mode: 'parent_merge', snapshotId, uncertainties: [],
          evidenceRequests: [], candidateDiffs: [{ scope: 'session', documentId: session.documentId, baseRevision: session.projection.documentRevision,
            projectionId: session.projection.id, projectionHash: session.projection.contentHash, candidateId, operation: 'add_entry',
            target: { section: 'information', headingPath: ['待核对分歧'] }, payload: { body: output, evidenceRefs }, idempotencyKey: 'child-merge-advice' }] }) }
      },
    } } })
  try {
    const done = f.until('completed')
    f.start()
    await done
    assert.equal(assistantCalls, 1)
    const state = f.loop.exportState()
    assert.equal(state.contextDocument!.information.length, 0)
    assert.equal(state.contextDocument!.candidates.find(candidate => candidate.source.actor === 'child-agent')!.status, 'pending')
    assert.equal(state.snapshot.children!.items[0]!.consumption!.decision, 'conflict')
  } finally { f.close() }
})

for (const pending of [true, false]) test(`parent completion rejects ${pending ? 'running' : 'successful but unconsumed'} child work`, async () => {
  let calls = 0
  const f = fixture(request => ++calls === 1 ? call('delegate_task', 'dispatch', { goal: '核对', prompt: '只读核对。', mode: pending ? 'async' : 'sync' }) : finish(request),
    { childAgentHost: async () => pending ? new Promise(() => {}) : { ok: true, output: '来源结果' } })
  try {
    const failed = f.until('failed'); f.start(); await failed
    assert.equal(f.loop.exportState().snapshot.run.failure!.code, 'RUNTIME_TASK_COMPLETION_BLOCKED')
    assert.equal(f.loop.exportState().snapshot.children!.items[0]!.consumption, undefined)
  } finally { f.close() }
})

test('a child deadline settles timed_out, wakes the parent and permits only failure acknowledgement', async () => {
  let calls = 0, childId = '', ref = ''
  const f = fixture(request => {
    if (++calls === 1) return call('delegate_task', 'short-child', { goal: '有限等待', prompt: '读取外部来源。', timeout_ms: 300 })
    if (calls === 2) { const handle = result(request, 'delegate_task'); childId = handle.childId; ref = handle.waitRef; return waitChild(request, ref) }
    if (calls === 3) return call('read_child_result', 'read-timeout', { child_id: childId })
    if (calls === 4) { assert.equal(result(request, 'read_child_result').status, 'timed_out'); return review(request, 'reject') }
    return finish(request)
  }, { childAgentHost: async () => new Promise(() => {}) })
  try { const done = f.until('completed'); f.start(); await done; assert.equal(calls, 5); assert.equal(f.loop.exportState().snapshot.children!.items[0]!.status, 'timed_out') }
  finally { f.close() }
})

test('a local child is successful only after its real run completes and has exact readonly grants', async () => {
  let parentCalls = 0, childCalls = 0, childId = ''
  const f = fixture(request => {
    const child = request.messages[0]!.content.includes('Capybara A2A Child Agent Prompt')
    if (child) {
      childCalls++; const names = new Set(request.tools?.map(tool => tool.name))
      for (const name of ['delegate_task', 'write_file', 'run_command', 'run_skill_script', 'consume_child_result']) assert.ok(!names.has(name), name)
      assert.ok(request.messages[0]!.content.includes('childId'))
      return finish(request)
    }
    if (++parentCalls === 1) return call('delegate_task', 'local-sync', { goal: '分析来源', prompt: '根据已有项目背景返回只读结论。', mode: 'sync' })
    if (parentCalls === 2) { childId = result(request, 'delegate_task').childId; return call('read_child_result', 'read-local', { child_id: childId }) }
    if (parentCalls === 3) return review(request)
    return finish(request)
  })
  try {
    const done = f.until('completed'); f.start(); await done
    assert.equal(childCalls, 1); assert.equal(parentCalls, 4)
    const child = f.loop.exportState().snapshot.children!.items[0]!
    assert.equal(child.status, 'succeeded'); assert.ok(child.childRunId); assert.equal(child.id, childId)
    const db = new DatabaseSync(path.join(f.root, '.capybara/sessions.sqlite'))
    try {
      const charges = db.prepare('SELECT DISTINCT session_id,actor_session_id FROM runtime_model_budget_attempts').all()
      assert.equal(charges.length, 2)
      assert.ok(charges.every(row => row.session_id === 'child-parent'))
      assert.ok(charges.some(row => row.actor_session_id === child.childSessionId))
      assert.equal(f.loop.getModelBudgetSummary()?.attempts, parentCalls + childCalls)
    } finally { db.close() }
  } finally { f.close() }
})

test('a child prose result and an artifact used as evidence get JSON-only repair with the actual search receipt', async () => {
  const deliverable = '注册目录返回 project-files:read_file。'
  const longDeliverable = `${deliverable}\n${'目录检索已核对。'.repeat(200)}`
  let childBinding: RuntimeRequestBinding | undefined, childCalls = 0, searchRef: string | undefined
  let childResultArtifactId: string | undefined
  let firstChildRead: { read_receipt_id: string; rawArtifactId: string; result_hash: string } | undefined
  const f = fixture(request => {
    const system = request.messages[0]!.content
    if (system.includes('Capybara A2A Child Agent Prompt')) {
      childCalls++
      if (childCalls === 1) {
        childBinding = binding(request)
        assert.deepEqual(request.tools?.map(tool => tool.name), ['search_resources'])
        return call('search_resources', 'child-registry-search', { query: 'read_file', kinds: ['tool'] })
      }
      const tool = request.messages.find(item => item.role === 'tool' && item.name === 'search_resources')
      assert.ok(tool)
      const receipt = JSON.parse(tool.content).runtime_receipt
      assert.equal(receipt.status, 'succeeded')
      searchRef = receipt.completionActionRef
      childResultArtifactId = receipt.resultArtifactId
      assert.equal(searchRef, 'call:child-registry-search')
      if (childCalls === 2) {
        assert.deepEqual(request.tools, [])
        assert.equal(request.responseFormat, 'json')
        assert.match(request.messages.at(-1)!.content, /Catalog checkpoint.*call:child-registry-search/)
        return { ...finish(request), text: deliverable }
      }
      assert.ok(childCalls === 3 || childCalls === 4)
      assert.deepEqual(request.tools, [])
      assert.equal(request.responseFormat, 'json')
      assert.match(system, /"toolNames":\[\]/)
      assert.equal(binding(request).taskId, childBinding?.taskId)
      assert.equal(binding(request).runId, childBinding?.runId)
      assert.notEqual(binding(request).requestId, childBinding?.requestId)
      if (childCalls === 3) {
        assert.ok(request.messages.some(item => item.role === 'assistant' && item.content === deliverable))
        assert.match(request.messages.at(-1)!.content, /decision "finish"/)
      } else {
        assert.ok(request.messages.some(item => item.role === 'assistant' && item.content === longDeliverable))
        assert.match(request.messages.at(-1)!.content, /evidence IDs absent from the current documents/)
      }
      return response(request, { decision: 'finish', userMessage: longDeliverable,
        completionCheck: { taskId: binding(request).taskId, requiredActions: [searchRef!],
          requiredEvidenceRefs: childCalls === 3 ? [childResultArtifactId!] : [],
          unresolvedUncertaintyIds: [], summary: '核对目录回执' } })
    }
    if (request.messages.some(item => item.role === 'tool' && item.name === 'consume_child_result')) return finish(request)
    if (request.messages.some(item => item.role === 'tool' && item.name === 'read_child_result')) {
      const read = result(request, 'read_child_result')
      assert.equal(read.partial_view, true)
      assert.equal(read.output_total_characters, longDeliverable.length)
      assert.equal(read.local_evidence.runId, childBinding?.runId)
      assert.equal(read.local_evidence.actionCount, 1)
      const [action] = read.local_evidence.actions
      assert.equal(action.toolName, 'search_resources')
      assert.equal(action.completionActionRef, searchRef)
      assert.equal(action.resultArtifactId, childResultArtifactId)
      assert.match(action.resultHash, /^[a-f0-9]{64}$/)
      assert.equal(JSON.parse(action.resultPreview).result.results[0].id, 'project-files:read_file')
      assert.equal(createHash('sha256').update(action.resultPreview).digest('hex'), action.resultHash)
      if (!firstChildRead) {
        assert.equal(read.output_excerpt, longDeliverable.slice(0, 1000))
        assert.equal(read.output_offset, 0)
        assert.equal(read.output_next_offset, 1000)
        firstChildRead = read
        return call('read_child_result', 'read-deliverable-page', { child_id: read.childId, output_offset: read.output_next_offset })
      }
      assert.equal(read.output_excerpt, longDeliverable.slice(1000, 2000))
      assert.equal(read.rawArtifactId, firstChildRead.rawArtifactId)
      assert.equal(read.result_hash, firstChildRead.result_hash)
      assert.notEqual(read.read_receipt_id, firstChildRead.read_receipt_id)
      return review(request)
    }
    if (request.messages.some(item => item.role === 'tool' && item.name === 'delegate_task')) {
      return call('read_child_result', 'read-registry-child', { child_id: result(request, 'delegate_task').childId })
    }
    return call('delegate_task', 'delegate-registry-child', { goal: '核对注册能力', prompt: '只查询能力目录，报告读取能力。',
      mode: 'sync', capability_ids: ['runtime:search_resources'] })
  })
  try {
    const done = f.until('completed'); f.start(); await done
    assert.equal(childCalls, 4)
    const child = f.loop.exportState().snapshot.children!.items[0]!
    assert.equal(child.status, 'succeeded')
    assert.equal(child.consumption?.decision, 'accept')
    assert.equal(f.events.filter(event => event.type === 'tool.call.started' && event.payload.toolName === 'search_resources').length, 1)
  } finally { f.close() }
})

for (const transport of ['JSON', 'carrier'] as const) test(`a child can request another catalog lookup after an exact match and cannot repeat the first lookup (${transport})`, async () => {
  let calls = 0
  const carrier = transport === 'carrier'
  const control = (request: LlmChatRequest, fields: Partial<ControlEnvelopeV2>) => {
    const envelope = response(request, fields)
    return carrier ? call('submit_capybara_control', `child-control-${calls}`, { envelope: JSON.parse(envelope.text) }) : envelope
  }
  const actor = (request: LlmChatRequest): LlmChatResponse => {
    const system = request.messages[0]!.content
    if (system.includes('Capybara A2A Child Agent Prompt')) {
      switch (++calls) {
        case 1: return call('search_resources', 'child-original-search', { query: 'read_file', kinds: ['tool'] })
        case 2:
          assert.equal(result(request, 'search_resources').results[0].id, 'project-files:read_file')
          assert.deepEqual(request.tools?.map(tool => tool.name), carrier ? ['submit_capybara_control'] : [])
          assert.equal(request.responseFormat, carrier ? 'text' : 'json')
          assert.match(request.messages.at(carrier ? -2 : -1)!.content, /Catalog checkpoint.*call:child-original-search/)
          return control(request, { decision: 'continue', reasoningNextStep: '仍需要列目录工具的正式注册 ID。' })
        case 3:
          assert.deepEqual(request.tools?.map(tool => tool.name), ['search_resources'])
          return call('search_resources', 'child-different-search', { query: 'list_files', kinds: ['tool'] })
        case 4:
          assert.ok(result(request, 'search_resources').results.some((item: { id: string }) => item.id === 'project-files:list_files'))
          return call('search_resources', 'child-redundant-search', { query: ' READ_FILE ' })
        default:
          assert.equal(calls, 5)
          assert.deepEqual(request.tools?.map(tool => tool.name), carrier ? ['submit_capybara_control'] : [])
          assert.equal(request.responseFormat, carrier ? 'text' : 'json')
          assert.match(request.messages.at(carrier ? -2 : -1)!.content, /CHILD_CATALOG_SEARCH_REPEATED.*call:child-original-search/)
          assert.ok(request.messages.some(item => item.role === 'tool' && item.content.includes('call:child-original-search')))
          return control(request, { decision: 'finish', userMessage: '已核对文件工具的注册 ID。\n两项回执均可查看。', completionCheck: {
            taskId: binding(request).taskId, requiredActions: ['call:child-original-search', 'call:child-different-search'],
            requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '按真实目录回执验收',
          } })
      }
    }
    if (request.messages.some(item => item.role === 'tool' && item.name === 'consume_child_result')) return finish(request)
    if (request.messages.some(item => item.role === 'tool' && item.name === 'read_child_result')) return review(request)
    if (request.messages.some(item => item.role === 'tool' && item.name === 'delegate_task')) {
      return call('read_child_result', 'read-deduplicated-child', { child_id: result(request, 'delegate_task').childId })
    }
    return call('delegate_task', 'delegate-deduplicated-child', { goal: '核对两个注册项', prompt: '仅搜索目录并报告读取和列目录能力。',
      mode: 'sync', capability_ids: ['runtime:search_resources'] })
  }
  const f = fixture(actor, carrier ? { llm: {
    getConfig: () => ({ provider: 'deepseek', protocol: 'chat-completions', model: 'child-test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }),
    chat: async request => actor(request),
  } } : {})
  try {
    const done = f.until('completed'); f.start(); await done
    const executed = f.events.flatMap(event => event.type === 'tool.call.started' && event.payload.toolName === 'search_resources' ? [event.payload.callId] : [])
    assert.deepEqual(executed, ['child-original-search', 'child-different-search'])
    const child = f.loop.getSnapshot(0).children!.items[0]!
    assert.equal(child.status, 'succeeded')
    assert.equal(child.consumption?.decision, 'accept')
    assert.ok(!f.events.some(event => event.type === 'tool.call.started' && event.payload.toolName === 'submit_capybara_control'))
  } finally { f.close() }
})

test('unpredictable read receipts reject a forged review token after reading', async () => {
  let calls = 0
  const f = fixture(request => {
    if (++calls === 1) return call('delegate_task', 'child-result', { goal: '检查', prompt: '只读检查。', mode: 'sync' })
    if (calls === 2) return call('read_child_result', 'actual-read', { child_id: result(request, 'delegate_task').childId })
    if (calls === 3) { const read = result(request, 'read_child_result'); return call('consume_child_result', 'forged-read', { child_id: read.childId, result_hash: read.result_hash, read_receipt_id: 'guessed-token', decision: 'accept', reason: '试图伪造读取回执' }) }
    const failed = JSON.parse(request.messages.find(message => message.role === 'tool' && message.name === 'consume_child_result')!.content)
    assert.equal(failed.ok, false); assert.ok(failed.error.message.includes('CHILD_READ_RECEIPT_REQUIRED')); return ask(request)
  }, { childAgentHost: async () => ({ ok: true, output: '真实结果，但尚未读取' }) })
  try { const paused = f.until('paused'); f.start(); await paused; assert.equal(f.loop.exportState().snapshot.children!.items[0]!.consumption, undefined) }
  finally { f.close() }
})

test('unread child results cannot project the consume capability', async () => {
  let calls = 0
  const f = fixture(request => {
    if (++calls === 1) return call('delegate_task', 'unread-child', { goal: '检查', prompt: '只读检查。', mode: 'sync' })
    assert.ok(!request.tools?.some(tool => tool.name === 'consume_child_result'))
    const handle = result(request, 'delegate_task')
    return call('consume_child_result', 'unseen-review', { child_id: handle.childId, result_hash: handle.resultHash, read_receipt_id: 'invented', decision: 'accept', reason: '不得在未读时消费' })
  }, { childAgentHost: async () => ({ ok: true, output: '未读来源' }) })
  try { const failed = f.until('failed'); f.start(); await failed; assert.equal(f.loop.exportState().snapshot.run.failure!.code, 'RUNTIME_ENVELOPE_TOOL_UNAUTHORIZED') }
  finally { f.close() }
})

test('cancelled child results retain late observations without becoming successful', async () => {
  let calls = 0, childId = '', resolveLate!: (result: RuntimeChildAgentResult) => void
  const f = fixture(request => {
    if (++calls === 1) return call('delegate_task', 'late-child', { goal: '检查迟到结果', prompt: '只读检查。' })
    if (calls === 2) { childId = result(request, 'delegate_task').childId; return call('cancel_child_task', 'cancel-job', { child_id: childId, reason: '用户范围已变化，停止此分支' }) }
    if (calls === 3) return call('read_child_result', 'read-cancelled', { child_id: childId })
    if (calls === 4) { assert.equal(result(request, 'read_child_result').status, 'cancelled'); return review(request, 'reject') }
    return finish(request)
  }, { childAgentHost: async () => new Promise(resolve => { resolveLate = resolve }) })
  try {
    const done = f.until('completed'); f.start(); await done
    resolveLate({ ok: true, output: '取消之后才返回的来源' }); await delay(40)
    assert.equal(f.loop.exportState().snapshot.children!.items[0]!.status, 'cancelled')
    const db = new DatabaseSync(path.join(f.root, '.capybara/sessions.sqlite'))
    try { assert.equal((db.prepare('SELECT COUNT(*) AS n FROM runtime_child_late_results').get() as { n: number }).n, 1) } finally { db.close() }
  } finally { f.close() }
})

test('a local child question stays waiting and a scoped answer resumes its original run', async () => {
  let parentCalls = 0, childCalls = 0, childId = '', childRunId = '', ref = ''
  const f = fixture(request => {
    if (request.messages[0]!.content.includes('Capybara A2A Child Agent Prompt')) {
      if (++childCalls === 1) { childRunId = binding(request).runId; return ask(request) }
      assert.equal(binding(request).runId, childRunId)
      assert.ok(request.messages.some(message => message.role === 'user' && message.content === '使用来源 A。'))
      return finish(request)
    }
    parentCalls++
    if (parentCalls === 1) return call('delegate_task', 'question-child', { goal: '澄清来源', prompt: '先询问缺少的来源，再完成只读分析。', mode: 'sync' })
    if (parentCalls === 2) {
      const handle = result(request, 'delegate_task'); childId = handle.childId
      assert.equal(handle.status, 'waiting')
      assert.ok(handle.input_request_id)
      return call('respond_child_task', 'answer-child', { child_id: childId, input_request_id: handle.input_request_id, message: '使用来源 A。' })
    }
    if (parentCalls === 3) { const handle = result(request, 'respond_child_task'); ref = handle.waitRef; return waitChild(request, ref) }
    if (parentCalls === 4) return call('read_child_result', 'read-answer-result', { child_id: childId })
    if (parentCalls === 5) return review(request)
    return finish(request)
  })
  try {
    const done = f.until('completed'); f.start(); await done
    assert.equal(childCalls, 2); assert.equal(parentCalls, 6)
    assert.equal(f.loop.exportState().snapshot.children!.items[0]!.childRunId, childRunId)
    assert.equal(f.loop.exportState().snapshot.children!.items[0]!.inputRequestId, undefined)
  } finally { f.close() }
})

test('closing and reconnecting resumes the same readonly local child with its original budget', async () => {
  let parentCalls = 0, childCalls = 0, childId = '', originalChildRun = '', resolveOld!: (response: LlmChatResponse) => void, oldRequest!: LlmChatRequest
  let childStarted!: () => void
  const started = new Promise<void>(resolve => { childStarted = resolve })
  const f = fixture(request => {
    if (request.messages[0]!.content.includes('Capybara A2A Child Agent Prompt')) {
      childCalls++
      if (childCalls === 1) { oldRequest = request; originalChildRun = binding(request).runId; childStarted(); return new Promise(resolve => { resolveOld = resolve }) }
      assert.equal(binding(request).runId, originalChildRun); return finish(request)
    }
    if (++parentCalls === 1) return call('delegate_task', 'recover-child', { goal: '恢复局部检查', prompt: '只读完成局部检查。' })
    if (parentCalls === 2) { const handle = result(request, 'delegate_task'); childId = handle.childId; return waitChild(request, handle.waitRef) }
    if (parentCalls === 3) return call('read_child_result', 'read-recovered', { child_id: childId })
    if (parentCalls === 4) return review(request)
    return finish(request)
  })
  try {
    const paused = f.until('paused'); f.start(); await paused
    // Parent waiting and actual child model dispatch are independent events.
    // Close only after the first request is really in flight, as this scenario requires.
    await Promise.race([started, delay(10000, undefined, { ref: false }).then(() => { throw new Error('child model request did not start before closing') })])
    assert.equal(childCalls, 1, JSON.stringify(f.loop.exportState().snapshot.children))
    const before = f.reopen(), done = f.until('completed'); await done
    assert.equal(childCalls, 2); assert.equal(parentCalls, 5)
    assert.equal(f.loop.exportState().snapshot.run.runId, before.snapshot.run.runId)
    assert.equal(f.loop.exportState().snapshot.children!.items[0]!.childRunId, originalChildRun)
    resolveOld(finish(oldRequest)); await delay(30)
    const db = new DatabaseSync(path.join(f.root, '.capybara/sessions.sqlite'))
    try { const record = JSON.parse((db.prepare('SELECT state_json FROM runtime_child_tasks WHERE id=?').get(childId) as { state_json: string }).state_json); assert.equal(record.modelRounds, 2); assert.equal(record.status, 'succeeded') }
    finally { db.close() }
  } finally { f.close() }
})

test('local child model budgets stop extra calls without resetting on a new round', async () => {
  let parentCalls = 0, childCalls = 0, childId = ''
  const f = fixture(request => {
    if (request.messages[0]!.content.includes('Capybara A2A Child Agent Prompt')) { childCalls++; return call('search_resources', 'child-read', { query: 'files' }) }
    if (++parentCalls === 1) return call('delegate_task', 'limited-child', { goal: '有界分析', prompt: '只读检索一次。', mode: 'sync', max_model_rounds: 1 })
    if (parentCalls === 2) { const handle = result(request, 'delegate_task'); childId = handle.childId; assert.equal(handle.status, 'failed'); return call('read_child_result', 'read-budget-failure', { child_id: childId }) }
    if (parentCalls === 3) return review(request, 'reject')
    return finish(request)
  })
  try { const done = f.until('completed'); f.start(); await done; assert.equal(childCalls, 1); assert.equal(f.loop.exportState().snapshot.children!.items[0]!.status, 'failed') }
  finally { f.close() }
})

test('model activity projection retains every active or unknown process and keeps the complete ledger', async () => {
  const f = fixture(request => ask(request))
  const state = f.loop.exportState()
  f.loop.close()
  state.processes = state.snapshot.processes = { revision: 10, items: [
    ...(['running', 'unknown'] as const).map(status => ({ id: `retained-${status}`, name: `important-${status}`, kind: 'tool' as const, projectId: f.root, runId: 'previous-run', status })),
    ...Array.from({ length: 8 }, (_, index) => ({ id: `settled-${index}`, name: `settled-old-${index}`, kind: 'tool' as const, projectId: f.root, status: 'succeeded' as const })),
  ] }
  let calls = 0
  const loop: RuntimeLoop = new RuntimeLoop({ projectDir: f.root, sessionId: 'child-parent', initialState: state, contextOrganization: { minGroups: 100 }, streamDelayMs: 0, stepDelayMs: 0,
    llm: { getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'child-test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }), chat: async request => {
      calls++
      const system = request.messages[0]!.content
      assert.ok(system.includes('important-running')); assert.ok(system.includes('important-unknown'))
      assert.ok(!system.includes('settled-old-0')); assert.ok(system.includes('settled-old-7'))
      assert.equal(loop.exportState().snapshot.processes!.items.length, 10)
      return ask(request)
    } } })
  try {
    const paused = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('activity projection run did not pause')), 20000)
      loop.onEvent(event => { if (event.type === 'run.state.changed' && ['paused', 'failed'].includes(event.payload.status)) { clearTimeout(timer); event.payload.status === 'paused' ? resolve() : reject(new Error(event.payload.failure!.message)) } })
    })
    const command: ClientCommand = { version: 1, kind: 'command', id: 'project-activity', sessionId: 'child-parent', type: 'chat.message.send', timestamp: new Date().toISOString(),
      payload: { clientMessageId: 'activity-user', content: [{ type: 'text', text: '检查前次运行的真实状态。' }], autoStart: true } }
    loop.validate(command); loop.execute(command, 1); await paused
    assert.equal(calls, 1); assert.equal(loop.exportState().snapshot.processes!.items.length, 10)
  } finally { loop.close(); f.close() }
})
