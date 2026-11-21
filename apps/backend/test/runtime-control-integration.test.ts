import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { initializeProjectDirectory } from '#core/project-initializer'
import { ProjectResources } from '#core/project-resources'
import { RuntimeLoop, type RuntimeLlm } from '#core/runtime-loop'
import type { ClientCommand, ControlEnvelopeV2, RuntimePlanTask, RuntimeRequestBinding, ServerEvent } from '#protocol/runtime-protocol'
import type { LlmChatRequest, LlmChatResponse } from '#util/llm'

function binding(request: LlmChatRequest): RuntimeRequestBinding {
  const system = request.messages.find((message) => message.role === 'system')?.content ?? ''
  const match = system.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)
  assert.ok(match, 'actual model request must include its full runtime binding')
  return JSON.parse(match[0]) as RuntimeRequestBinding
}

function response(request: LlmChatRequest, overrides: Partial<ControlEnvelopeV2>): LlmChatResponse {
  const value: ControlEnvelopeV2 = {
    envelopeVersion: 2, binding: binding(request), decision: 'continue', userMessage: '',
    actions: [], candidateDiffs: [], evidenceRequests: [], uncertainties: [], planProposal: null, waitSpec: null, completionCheck: null,
    ...overrides,
  }
  return { provider: 'custom', model: 'test', finishReason: 'stop', raw: {}, text: JSON.stringify(value) }
}

function command(type: 'chat.message.send', payload: Extract<ClientCommand, { type: 'chat.message.send' }>['payload']): ClientCommand {
  return { version: 1, kind: 'command', id: `command-${payload.clientMessageId}`, type, sessionId: 'control-session', timestamp: new Date().toISOString(), payload }
}

function waitFor(loop: RuntimeLoop, status: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`run did not reach ${status}`)) }, 8000)
    const unsubscribe = loop.onEvent((event) => {
      if (event.type !== 'run.state.changed') return
      if (event.payload.status === status) { clearTimeout(timer); unsubscribe(); resolve() }
      else if (event.payload.status === 'failed' && status !== 'failed') { clearTimeout(timer); unsubscribe(); reject(new Error(event.payload.failure?.message)) }
    })
  })
}

async function withLoop(chat: (request: LlmChatRequest) => LlmChatResponse,
  run: (loop: RuntimeLoop, projectDir: string, llm: RuntimeLlm) => Promise<void>, maxToolRounds?: number,
  transport: Pick<ReturnType<RuntimeLlm['getConfig']>, 'provider' | 'protocol'> = { provider: 'custom', protocol: 'responses' }): Promise<void> {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-control-integration-'))
  initializeProjectDirectory(projectDir)
  if (maxToolRounds !== undefined) new ProjectResources(projectDir).saveSettings({ max_tool_rounds: maxToolRounds })
  const llm: RuntimeLlm = { chat: async (request) => chat(request), getConfig: () => ({ ...transport, model: 'test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }) }
  const loop = new RuntimeLoop({ projectDir, llm, stepDelayMs: 0, streamDelayMs: 0, contextOrganization: { minGroups: 1000 } })
  try { await run(loop, projectDir, llm) } finally { loop.close(); fs.rmSync(projectDir, { recursive: true, force: true }) }
}

for (const mixed of [false, true]) test(`a control carrier ${mixed ? 'rejects a mixed batch' : 'publishes a verified response without dispatching a tool'}`, async () => {
  let calls = 0
  await withLoop(request => {
    const requestBinding = binding(request)
    const finish = response(request, { decision: 'finish', userMessage: '核查完成。',
      completionCheck: { taskId: requestBinding.taskId, requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '确认交付' } })
    if (++calls === 1) {
      assert.ok(!request.tools?.some(tool => tool.name === 'submit_capybara_control'))
      return { ...finish, text: '', toolCalls: [{ id: 'wrong-channel', name: 'finish', arguments: {} }] }
    }
    assert.deepEqual(request.tools?.map(tool => tool.name), ['submit_capybara_control'])
    assert.match(request.messages.at(-1)!.content, /executes no tool/)
    return { ...finish, text: '', toolCalls: [
      { id: 'finish-carrier', name: 'submit_capybara_control', arguments: { envelope: JSON.parse(finish.text) } },
      ...(mixed ? [{ id: 'not-authorized', name: 'search_resources', arguments: { query: 'files' } }] : []),
    ] }
  }, async loop => {
    const done = waitFor(loop, mixed ? 'failed' : 'completed')
    const send = command('chat.message.send', { clientMessageId: 'control-carrier', content: [{ type: 'text', text: '核查可交付状态。' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1); await done
    const state = loop.exportState()
    assert.equal(calls, 2)
    assert.equal(state.snapshot.observations.items.length, 0)
    assert.ok(state.artifacts.some(item => JSON.stringify(item.value).includes('finish-carrier')))
    assert.equal(state.snapshot.run.failure?.code, mixed ? 'RUNTIME_ACTION_TRANSPORT_CONFLICT' : undefined)
    if (!mixed) assert.ok(state.contextHistory?.messages.some(item => item.message.content === '核查完成。'))
  }, undefined, { provider: 'deepseek', protocol: 'chat-completions' })
})

test('a planned document node offers a control carrier alongside its observation tools', async () => {
  const node: RuntimePlanTask = { id: 'document-index', title: '补写会话索引', phase: 'execution', owner: 'parent',
    dependsOn: [], completionConditions: ['会话索引已有原句'], capabilityIds: [], requiredActions: [], evidenceRefs: [], status: 'pending' }
  let calls = 0
  let committedRef = ''
  const carrier = (value: LlmChatResponse): LlmChatResponse => ({ ...value, text: '', toolCalls: [
    { id: 'document-control', name: 'submit_capybara_control', arguments: { envelope: JSON.parse(value.text) } },
  ] })
  await withLoop(request => {
    calls++
    if (calls === 1) return response(request, { decision: 'propose_plan',
      planProposal: { basePlanRevision: 0, goal: '补写会话索引', tasks: [node] } })
    if (calls <= 3) {
      const names = request.tools?.map(tool => tool.name)
      assert.ok(names?.includes('search_resources'))
      assert.ok(names?.includes('submit_capybara_control'))
      const system = request.messages[0]!.content
      const notice = calls === 2 ? /managed documents/ : /Batch rejected.*No call ran/
      assert.ok(request.messages.some(message => notice.test(message.content)))
      const session = system.split('# Session Context')[1]!
      const context = JSON.parse(session.match(/<!-- capybara:context-binding data=(\{[^\n]+?\}) -->/)![1]!)
      const candidate = [...session.matchAll(/<!-- capybara:candidate-ref data=(\{[^\n]+?\}) -->/g)]
        .map(match => JSON.parse(match[1]!)).find(item => item.source.sourceId === 'planned-document-carrier')
      assert.ok(candidate)
      const edit = carrier(response(request, { decision: 'propose_diff', candidateDiffs: [{ ...context, scope: 'session',
        planTaskId: node.id, candidateId: candidate.id, operation: 'add_entry', target: { section: 'information', headingPath: ['阶段索引'] },
        payload: { body: '两项记录待核对。', evidenceRefs: candidate.evidence.map((item: { id: string }) => item.id) },
        idempotencyKey: 'planned-document-index' }] }))
      if (calls === 2) edit.toolCalls!.push({ id: 'mixed-catalog', name: 'search_resources',
        arguments: { query: 'read_file' } })
      return edit
    }
    if (calls === 4) {
      assert.deepEqual(request.tools?.map(tool => tool.name), ['submit_capybara_control'])
      const state = JSON.parse(request.messages[0]!.content.split('\n').find(line => line.startsWith('{"taskId":'))!)
      committedRef = state.recentContextEdits[0].completionActionRef
      assert.match(committedRef, /^context:receipt-/)
      return carrier(response(request, { decision: 'complete_plan_nodes', planProgress: {
        basePlanRevision: state.planRevision, nodes: [{ id: node.id, actionRefs: [committedRef], evidenceRefs: [] }],
      } }))
    }
    return response(request, { decision: 'finish', userMessage: '已补写会话索引。', completionCheck: {
      taskId: binding(request).taskId, requiredActions: [committedRef], requiredEvidenceRefs: [],
      unresolvedUncertaintyIds: [], summary: '已核对原句与编辑回执',
    } })
  }, async (loop, projectDir) => {
    const resources = new ProjectResources(projectDir)
    try { resources.saveSettings({ context_organization_version: 4 }) } finally { resources.close() }
    const done = waitFor(loop, 'completed')
    const send = command('chat.message.send', { clientMessageId: 'planned-document-carrier', planningRequired: true,
      content: [{ type: 'text', text: '把「两项记录待核对。」加入会话文档的阶段索引。' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1); await done
    const state = loop.exportState()
    assert.equal(calls, 5)
    assert.ok(!state.contextHistory?.messages.some(item => item.message.toolCallId === 'mixed-catalog'))
    assert.deepEqual(state.taskControl?.tasks[0]?.requiredActions, [committedRef])
    assert.deepEqual(state.contextDocument?.information.filter(entry => entry.body === '两项记录待核对。').map(entry => entry.headingPath), [['阶段索引']])
  }, undefined, { provider: 'deepseek', protocol: 'chat-completions' })
})

for (const sufficient of [true, false]) test(`the tool round limit keeps a control-only request with ${sufficient ? 'usable' : 'incomplete'} evidence`, async () => {
  let calls = 0
  await withLoop(request => {
    calls += 1
    if (calls === 1) {
      assert.ok(request.tools?.some(tool => tool.name === 'search_resources'))
      return { provider: 'custom', model: 'test', finishReason: 'tool_calls', raw: {}, text: '',
        toolCalls: [{ id: 'last-allowed', name: 'search_resources', arguments: { query: 'files', limit: 1 } }] }
    }
    assert.equal(calls, 2)
    assert.deepEqual(request.tools, [])
    assert.equal(request.responseFormat, 'json')
    const state = JSON.parse(request.messages[0]!.content.split('\n').find(line => line.startsWith('{"taskId":'))!)
    assert.equal(state.budget.usedToolRounds, 1)
    assert.equal(state.budget.toolRoundsExhausted, true)
    assert.ok(request.messages.some(message => message.toolCallId === 'last-allowed'))
    if (!sufficient) return { provider: 'custom', model: 'test', finishReason: 'tool_calls', raw: {}, text: '',
      toolCalls: [{ id: 'denied-extra', name: 'search_resources', arguments: { query: 'missing source', limit: 1 } }] }
    return response(request, { decision: 'finish', userMessage: '已核对实际资料。', completionCheck: { taskId: binding(request).taskId,
      requiredActions: ['call:last-allowed'], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '复用已完成的工具回执' } })
  }, async loop => {
    const done = waitFor(loop, sufficient ? 'completed' : 'failed')
    const send = command('chat.message.send', { clientMessageId: 'tool-budget', content: [{ type: 'text', text: '找出文件能力。' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1); await done
    const state = loop.exportState()
    assert.equal(calls, 2)
    assert.equal(state.snapshot.observations.items.filter(item => item.toolName === 'search_resources').length, 1)
    if (!sufficient) assert.equal(state.snapshot.run.failure?.code, 'MODEL_TOOL_ROUND_LIMIT')
  }, 1)
})

test('one rejection identifies all of a previous node’s tool receipts and the current node can use its own', async () => {
  const lookup = (id: string) => ({ provider: 'custom' as const, model: 'test', finishReason: 'tool_calls', raw: {}, text: '',
    toolCalls: [{ id, name: 'search_resources', arguments: { query: 'files', limit: 1 } }] })
  const nodes: RuntimePlanTask[] = ['index', 'confirm'].map((id, index) => ({ id, title: id,
    owner: 'parent', dependsOn: index ? ['index'] : [], capabilityIds: ['search_resources'],
    completionConditions: ['核验本节点查询'], requiredActions: [], evidenceRefs: [], status: 'pending' }))
  let callCount = 0
  let firstStepRef = ''
  await withLoop(request => {
    const complete = (basePlanRevision: number, id: string, actionRefs: string[]) => response(request, {
      decision: 'complete_plan_nodes', planProgress: { basePlanRevision, nodes: [{ id, actionRefs, evidenceRefs: [] }] },
    })
    callCount += 1
    if (callCount === 1) return response(request, { decision: 'propose_plan', planProposal: { basePlanRevision: 0, goal: '独立核验两轮', tasks: nodes } })
    if (callCount === 2) return lookup('index-receipt')
    if (callCount === 3) {
      const result = request.messages.find(message => message.toolCallId === 'index-receipt')!
      firstStepRef = `step:${JSON.parse(result.content).runtime_receipt.stepId}`
      return complete(1, 'index', ['call:index-receipt'])
    }
    if (callCount === 4) {
      assert.ok(request.messages[0]!.content.includes('"not":{"enum":['))
      return complete(2, 'confirm', [firstStepRef, 'call:index-receipt'])
    }
    if (callCount === 5) {
      const repair = request.messages.at(-1)!.content
      for (const ref of [firstStepRef, 'call:index-receipt']) {
        assert.ok(repair.includes(`Remove "${ref}" from the actions of "confirm". That receipt belongs to ["index"].`))
      }
      return lookup('confirm-receipt')
    }
    if (callCount === 6) return complete(2, 'confirm', ['call:confirm-receipt'])
    assert.equal(callCount, 7)
    return response(request, { decision: 'finish', userMessage: '两个环节已核验。', completionCheck: { taskId: binding(request).taskId,
      requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '两节点各自都有实际回执' } })
  }, async loop => {
    const done = waitFor(loop, 'completed')
    const send = command('chat.message.send', { clientMessageId: 'cross-node-receipts', content: [{ type: 'text', text: '独立核验两轮' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1); await done
    assert.deepEqual(loop.exportState().taskControl?.tasks.map(task => [task.id, task.status, task.requiredActions]), [
      ['index', 'completed', ['call:index-receipt']], ['confirm', 'completed', ['call:confirm-receipt']],
    ])
  })
})

test('ask_user is visible and a desktop-style autoStart reply resumes the same task and run', async () => {
  let calls = 0
  await withLoop((request) => {
    calls += 1
    const current = binding(request)
    if (calls === 1) return response(request, {
      decision: 'ask_user', userMessage: '请提供源数据目录。',
      actions: [{ kind: 'ask_user', question: '请提供源数据目录。', blockingTaskIds: [current.taskId] }],
    })
    assert.ok(request.messages.some((message) => message.role === 'user' && message.content === 'D:/data'))
    return response(request, { decision: 'finish', userMessage: '已收到目录。', completionCheck: { taskId: current.taskId, requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '已取得所需输入' } })
  }, async (loop) => {
    const events: ServerEvent[] = []
    loop.onEvent((event) => events.push(event as ServerEvent))
    const paused = waitFor(loop, 'paused')
    const send = command('chat.message.send', { clientMessageId: 'initial', content: [{ type: 'text', text: '确认输入目录' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1)
    await paused
    const before = loop.exportState()
    assert.equal(before.contextControl?.status, 'awaiting_user')
    assert.ok(before.contextControl?.humanRequestId)
    assert.ok(before.snapshot.conversation.messages.some((message) => message.role === 'assistant' && message.content.some((part) => part.text === '请提供源数据目录。') && message.status === 'completed'))
    assert.ok(events.some((event) => event.type === 'chat.assistant.delta' && event.payload.delta.includes('源数据目录')))
    const stale = command('chat.message.send', { clientMessageId: 'stale', content: [{ type: 'text', text: 'D:/other' }], autoStart: true, humanRequestId: 'another-request' })
    assert.throws(() => loop.validate(stale), /HUMAN_REQUEST_MISMATCH/)
    const completed = waitFor(loop, 'completed')
    const reply = command('chat.message.send', { clientMessageId: 'reply', content: [{ type: 'text', text: 'D:/data' }], autoStart: true, humanRequestId: before.contextControl!.humanRequestId })
    loop.validate(reply); loop.execute(reply, 2)
    await completed
    const after = loop.exportState()
    assert.equal(after.snapshot.run.runId, before.snapshot.run.runId)
    assert.equal(after.taskControl?.taskId, before.taskControl?.taskId)
    assert.equal(after.contextControl?.status, 'idle')
    assert.equal(calls, 2)
    assert.ok(after.artifacts.some((artifact) => artifact.meta.label === 'Runtime completion verification'))
  })
})

test('a final answer submitted as continue is repaired before changing task state', async () => {
  const answer = '资料 A 建议 09:20，资料 B 建议 14:30 复查，由负责人决定。'
  const uncertainties = [{ id: 'decision-owner', statement: '预览发布时间由资料负责人决定。', blocking: false, relatedTaskIds: [], evidenceRefs: [] }]
  let calls = 0
  await withLoop((request) => {
    const current = binding(request)
    calls += 1
    assert.equal(current.stateRevision, 0)
    if (calls === 1) return response(request, { userMessage: answer, uncertainties })
    assert.match(request.messages.at(-1)!.content, /RUNTIME_REASONING_STEP_REQUIRED/)
    assert.ok(request.messages.some(message => message.role === 'assistant' && message.content.includes(answer)))
    return response(request, { decision: 'finish', userMessage: answer, uncertainties, reasoningNextStep: '交付整理结果',
      completionCheck: { taskId: current.taskId, requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '已交付两个观点' } })
  }, async (loop) => {
    const completed = waitFor(loop, 'completed')
    const send = command('chat.message.send', { clientMessageId: 'continue-draft', content: [{ type: 'text', text: '整理观点给负责人。' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1)
    await completed
    const state = loop.exportState()
    assert.equal(calls, 2)
    assert.equal(state.taskControl?.stateRevision, 1)
    assert.deepEqual(state.taskControl?.uncertainties.map(item => item.id), ['decision-owner'])
    assert.equal(state.snapshot.conversation.messages.filter(message => message.role === 'assistant' && message.status === 'completed').length, 1)
    assert.ok(state.artifacts.some(artifact => artifact.meta.label === 'Runtime completion verification'))
  })
})

test('distinct reasoning advances and a repeated step exhausts only the output repair budget', async () => {
  let calls = 0
  await withLoop((request) => {
    const current = binding(request)
    calls += 1
    if (calls === 1) return response(request, { reasoningNextStep: '核对时点  对应用途。',
      uncertainties: [{ id: 'time-purpose', statement: '尚未核对时点用途。', blocking: true, relatedTaskIds: [current.taskId], evidenceRefs: [] }] })
    if (calls === 2) return response(request, { reasoningNextStep: '列出对应的必要条件' })
    assert.equal(current.stateRevision, 2)
    return response(request, { reasoningNextStep: '核对时点 对应用途!' })
  }, async (loop) => {
    const failed = waitFor(loop, 'failed')
    const send = command('chat.message.send', { clientMessageId: 'repeated-reasoning', content: [{ type: 'text', text: '核对时点和条件。' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1)
    await failed
    const state = loop.exportState()
    assert.equal(calls, 6)
    assert.equal(state.snapshot.run.failure?.code, 'RUNTIME_REASONING_STEP_REPEATED')
    assert.equal(state.taskControl?.stateRevision, 2)
    assert.ok(state.taskControl?.uncertainties.some(item => item.id === 'time-purpose' && item.blocking))
    assert.ok(!state.artifacts.some(artifact => artifact.meta.label === 'Runtime completion verification'))
  })
})

test('real tool results allow reconsidering an earlier reasoning step', async () => {
  let calls = 0
  await withLoop((request) => {
    calls += 1
    if (calls === 2) return { ...response(request, {}), text: '', toolCalls: [{ id: 'check-resource', name: 'search_resources', arguments: { query: 'read_file' } }] }
    if (calls === 1 || calls === 3) return response(request, { reasoningNextStep: '核对文件读取能力' })
    return response(request, { decision: 'finish', userMessage: '已核对读取能力。', completionCheck: {
      taskId: binding(request).taskId, requiredActions: ['call:check-resource'], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '已查询目录',
    } })
  }, async (loop) => {
    const completed = waitFor(loop, 'completed')
    const send = command('chat.message.send', { clientMessageId: 'reasoning-after-tool', content: [{ type: 'text', text: '核对文件读取能力。' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1)
    await completed
    assert.equal(calls, 4)
    assert.deepEqual(loop.exportState().taskControl?.requiredActions, ['call:check-resource'])
  })
})

test('distinct pure reasoning without new observations is bounded and repair can dispatch a real tool', async () => {
  let calls = 0
  await withLoop((request) => {
    calls += 1
    if (calls <= 4) return response(request, { reasoningNextStep: `准备查找证据第 ${calls} 次` })
    if (calls === 5) {
      assert.match(request.messages.at(-1)!.content, /RUNTIME_REASONING_CONTINUATION_LIMIT/)
      return { ...response(request, {}), text: '', toolCalls: [{ id: 'after-continuation-limit', name: 'search_resources', arguments: { query: 'read_file' } }] }
    }
    if (calls === 6) {
      assert.ok(request.messages.every(message => message.role !== 'user' || !message.content.includes('RUNTIME_REASONING_CONTINUATION_LIMIT')))
      return response(request, { reasoningNextStep: '根据目录结果核对能力' })
    }
    return response(request, { decision: 'finish', userMessage: '已核对资源目录。', completionCheck: {
      taskId: binding(request).taskId, requiredActions: ['call:after-continuation-limit'], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '目录已核对',
    } })
  }, async (loop) => {
    const completed = waitFor(loop, 'completed')
    const send = command('chat.message.send', { clientMessageId: 'reasoning-limit', content: [{ type: 'text', text: '核对文件读取能力。' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1)
    await completed
    assert.equal(calls, 7)
    assert.deepEqual(loop.exportState().taskControl?.requiredActions, ['call:after-continuation-limit'])
  })
})

test('legacy completed cannot erase a previously accepted task plan', async () => {
  let calls = 0
  await withLoop((request) => {
    calls += 1
    if (calls === 1) return response(request, {
      decision: 'propose_plan', planProposal: { basePlanRevision: 0, goal: '先检查再完成', tasks: [{
        id: 'inspect', title: '查找工具', owner: 'parent', dependsOn: [], capabilityIds: [], completionConditions: ['工具查找成功'],
        requiredActions: ['tool:search_resources'], evidenceRefs: [], status: 'pending',
      }] },
    })
    return { provider: 'custom', model: 'test', finishReason: 'stop', raw: {}, text: '{"status":"completed","content":"完成"}' }
  }, async (loop) => {
    const failed = waitFor(loop, 'failed')
    const send = command('chat.message.send', { clientMessageId: 'plan', content: [{ type: 'text', text: '执行检查' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1)
    await failed
    const state = loop.exportState()
    assert.equal(state.snapshot.run.failure?.code, 'RUNTIME_ENVELOPE_ACTIONS_INCOMPLETE')
    assert.deepEqual(state.taskControl?.requiredActions, ['tool:search_resources'])
    assert.equal(state.taskControl?.planRevision, 1)
    assert.equal(calls, 2)
  })
})

test('stale task-state binding is rejected before actions run', async () => {
  await withLoop((request) => response(request, { binding: { ...binding(request), stateRevision: 1 }, decision: 'tool_call', actions: [{ kind: 'tool_call', toolName: 'search_resources', arguments: { query: 'files' } }] }), async (loop) => {
    const failed = waitFor(loop, 'failed')
    const send = command('chat.message.send', { clientMessageId: 'stale-state', content: [{ type: 'text', text: '检查状态' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1)
    await failed
    assert.equal(loop.exportState().snapshot.run.failure?.code, 'RUNTIME_ENVELOPE_STATE_MISMATCH')
    assert.equal(loop.exportState().snapshot.observations.items.some((item) => item.toolName === 'search_resources'), false)
  })
})

test('a stale request in continue is repaired with the exact current binding', async () => {
  let calls = 0
  let priorRequestId = ''
  await withLoop(request => {
    calls += 1
    const current = binding(request)
    const schema = JSON.parse(request.messages[0]!.content.split('\n').find(line => line.startsWith('{"type":"object"'))!)
    assert.deepEqual(schema.properties.binding.const, current)
    if (calls === 1) {
      priorRequestId = current.requestId
      return response(request, { reasoningNextStep: '核对来源和范围' })
    }
    if (calls === 2) return response(request, { binding: { ...current, requestId: priorRequestId }, reasoningNextStep: '重复检查' })
    assert.equal(calls, 3)
    assert.match(request.messages.at(-1)!.content, /used a previous request ID/)
    assert.ok(!request.messages.some(message => message.content === '重复检查'))
    return response(request, { decision: 'finish', userMessage: '来源已核对。', completionCheck: { taskId: current.taskId,
      requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '来自已知资料' } })
  }, async loop => {
    const done = waitFor(loop, 'completed')
    const send = command('chat.message.send', { clientMessageId: 'stale-continue', content: [{ type: 'text', text: '核对来源' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1); await done
    assert.equal(calls, 3)
    assert.equal(loop.exportState().taskControl?.stateRevision, 2)
  })
})

test('a mixed native/JSON action response cannot execute either action twice', async () => {
  await withLoop((request) => ({
    ...response(request, { decision: 'tool_call', actions: [{ kind: 'tool_call', toolName: 'search_resources', arguments: { query: 'files' } }] }),
    toolCalls: [{ id: 'native-1', name: 'search_resources', arguments: { query: 'files' } }],
  }), async (loop) => {
    const failed = waitFor(loop, 'failed')
    const send = command('chat.message.send', { clientMessageId: 'mixed', content: [{ type: 'text', text: '搜索' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1)
    await failed
    assert.equal(loop.exportState().snapshot.run.failure?.code, 'RUNTIME_ACTION_TRANSPORT_CONFLICT')
    assert.equal(loop.exportState().snapshot.observations.items.length, 0)
  })
})

for (const withUnknownTool of [false, true]) test(`a native batch with a misplaced control decision ${withUnknownTool ? 'and an unknown tool is rejected' : 'must be submitted again'}`, async () => {
  let calls = 0
  const lookup = (id: string) => ({ id, name: 'search_resources', arguments: { query: 'files', limit: 1 } })
  await withLoop(request => {
    calls += 1
    if (calls === 1) return { provider: 'custom', model: 'test', raw: {}, text: '', finishReason: 'tool_calls',
      toolCalls: [lookup('rejected-search'), { id: 'rejected-edit', name: 'propose_diff', arguments: {} },
        ...(withUnknownTool ? [{ id: 'unknown', name: 'unprojected_tool', arguments: {} }] : [])] }
    if (calls === 2) {
      assert.match(request.messages.at(-1)!.content, /RUNTIME_ACTION_TRANSPORT_CONFLICT.*No action ran/)
      assert.ok(!request.messages.some(message => message.toolCallId === 'rejected-search'))
      assert.ok(request.tools?.some(tool => tool.name === 'search_resources'))
      return { provider: 'custom', model: 'test', raw: {}, text: '', finishReason: 'tool_calls', toolCalls: [lookup('retried-search')] }
    }
    assert.ok(request.messages.some(message => message.toolCallId === 'retried-search'))
    return response(request, { decision: 'finish', userMessage: '已核对目录。', completionCheck: { taskId: binding(request).taskId,
      requiredActions: ['call:retried-search'], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '独立工具调用已取得回执' } })
  }, async loop => {
    const terminal = waitFor(loop, withUnknownTool ? 'failed' : 'completed')
    const send = command('chat.message.send', { clientMessageId: 'native-control-conflict', content: [{ type: 'text', text: '核对目录' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1); await terminal
    const snapshot = loop.exportState().snapshot
    assert.equal(calls, withUnknownTool ? 1 : 3)
    assert.equal(snapshot.observations.items.filter(item => item.toolName === 'search_resources').length, withUnknownTool ? 0 : 1)
    if (withUnknownTool) assert.equal(snapshot.run.failure?.code, 'RUNTIME_ENVELOPE_TOOL_UNAUTHORIZED')
  })
})

test('an unwrapped structured reply is retained as a draft for a control-only finish', async () => {
  const answer = '{"claims":[{"file":"source.txt","line":3,"quote":"原文。"}]}'
  let calls = 0
  let draftRequestId = ''
  await withLoop(request => {
    calls += 1
    if (calls === 1) {
      draftRequestId = binding(request).requestId
      const draft: LlmChatResponse = { provider: 'custom', model: 'test', raw: {}, text: answer }
      assert.deepEqual(request.validateResponse?.(draft), { recovery: 'runtime' })
      return draft
    }
    assert.equal(calls, 2)
    assert.notEqual(binding(request).requestId, draftRequestId)
    assert.equal(binding(request).stateRevision, 0)
    assert.deepEqual(request.tools, [])
    assert.equal(request.responseFormat, 'json')
    assert.ok(request.messages.some(message => message.role === 'assistant' && message.content === answer))
    assert.match(request.messages.at(-1)!.content, /unverified user reply/)
    return response(request, { decision: 'finish', userMessage: answer, completionCheck: { taskId: binding(request).taskId,
      requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '按指定格式交付已有资料' } })
  }, async loop => {
    const done = waitFor(loop, 'completed')
    const send = command('chat.message.send', { clientMessageId: 'structured-draft', content: [{ type: 'text', text: '来源 source.txt 第 3 行是「原文。」。仅回复 JSON。' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1); await done
    const completed = loop.exportState().snapshot.conversation.messages.filter(message => message.role === 'assistant' && message.status === 'completed')
    assert.equal(completed.length, 1)
    assert.equal(completed[0]?.content[0]?.text, answer)
  })
})

test('printed provider tool calls change control repair to JSON without invoking or echoing a tool', async () => {
  let calls = 0
  const printed = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="search_resources">\n</｜｜DSML｜｜ calls>'
  await withLoop(request => {
    calls += 1
    if (calls === 1) return { provider: 'custom', model: 'test', raw: {}, text: '', finishReason: 'tool_calls',
      toolCalls: [{ id: 'misplaced-diff', name: 'propose_diff', arguments: {} }] }
    assert.deepEqual(request.tools, [])
    if (calls === 2) {
      assert.equal(request.responseFormat, 'text')
      const draft: LlmChatResponse = { provider: 'custom', model: 'test', raw: {}, text: printed }
      assert.deepEqual(request.validateResponse?.(draft), { recovery: 'runtime' })
      return draft
    }
    assert.equal(calls, 3)
    assert.equal(request.responseFormat, 'json')
    assert.match(request.messages.at(-1)!.content, /No call ran/)
    assert.ok(!request.messages.some(message => message.content.includes(printed)))
    return response(request, { decision: 'finish', userMessage: '已按当前资料完成。', completionCheck: { taskId: binding(request).taskId,
      requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '仅用已有资料' } })
  }, async loop => {
    const done = waitFor(loop, 'completed')
    const send = command('chat.message.send', { clientMessageId: 'printed-tool-call', content: [{ type: 'text', text: '根据现有资料完成' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1); await done
    assert.equal(calls, 3)
    assert.deepEqual(loop.exportState().snapshot.observations.items, [])
  })
})

for (const kind of ['action', 'evidence'] as const) test(`an invalid finish ${kind} reference gets a bounded repair without creating an obligation`, async () => {
  let calls = 0
  await withLoop(request => {
    calls++
    assert.match(request.messages[0]!.content, /"completionActionRefs":\[\]/)
    if (calls === 2) assert.ok(request.messages.some(message => message.content.includes(
      kind === 'action' ? 'outside the current completed action ledger' : 'evidence IDs absent from the current documents')))
    return response(request, { decision: 'finish', userMessage: '已根据历史资料答复。',
      completionCheck: { taskId: binding(request).taskId, requiredActions: calls === 1 && kind === 'action' ? ['call:prior-run'] : [],
        requiredEvidenceRefs: calls === 1 && kind === 'evidence' ? ['evidence-not-registered'] : [],
        unresolvedUncertaintyIds: [], summary: '本轮没有工具动作' } })
  }, async loop => {
    const completed = waitFor(loop, 'completed')
    const send = command('chat.message.send', { clientMessageId: 'repair-action', content: [{ type: 'text', text: '继续说明' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1)
    await completed
    assert.equal(calls, 2)
    const state = loop.exportState()
    assert.deepEqual(state.taskControl?.requiredActions, [])
    assert.deepEqual(state.taskControl?.requiredEvidenceRefs, [])
    assert.equal(state.snapshot.observations.items.length, 0)
  })
})

test('planning, native execution, receipt verification and finish persist as one recoverable task', async () => {
  let calls = 0
  await withLoop((request) => {
    calls += 1
    if (calls === 2) return { provider: 'custom', model: 'test', finishReason: 'tool_calls', raw: {}, text: '', toolCalls: [{ id: 'search-1', name: 'search_resources', arguments: { query: 'files', kinds: ['tool'], limit: 1 } }] }
    if (calls === 3) {
      const observed = request.messages.find(message => message.toolCallId === 'search-1')
      const receipt = JSON.parse(observed!.content).runtime_receipt
      assert.equal(receipt.completionActionRef, 'call:search-1')
      assert.equal(receipt.runId, binding(request).runId)
    }
    if (calls === 1 || calls === 3) return response(request, {
      decision: 'propose_plan', planProposal: { basePlanRevision: calls === 1 ? 0 : 1, goal: '查找文件工具', tasks: [{
        id: 'search', title: '查找工具', owner: 'parent', dependsOn: [], capabilityIds: ['search_resources'],
        completionConditions: ['成功取得工具检索结果'], requiredActions: calls === 1 ? [] : ['call:search-1'], evidenceRefs: [], status: calls === 1 ? 'pending' : 'completed',
      }] },
    })
    assert.equal(calls, 4)
    return response(request, { decision: 'finish', userMessage: '检索完成。', completionCheck: { taskId: binding(request).taskId, requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '任务账本中的检索已经有成功收据' } })
  }, async (loop, projectDir, llm) => {
    const done = waitFor(loop, 'completed')
    const send = command('chat.message.send', { clientMessageId: 'positive-plan', content: [{ type: 'text', text: '查找文件工具' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1)
    await done
    const state = loop.exportState()
    assert.equal(state.taskControl?.planRevision, 2)
    assert.equal(state.taskControl?.tasks[0]?.status, 'completed')
    assert.deepEqual(state.taskControl?.requiredActions, ['call:search-1'])
    assert.equal(state.snapshot.observations.items.filter((item) => item.toolName === 'search_resources').length, 1)
    assert.equal(calls, 4)
    const restored = new RuntimeLoop({ projectDir, llm, stepDelayMs: 0, streamDelayMs: 0, initialState: state })
    try { assert.deepEqual(restored.exportState().taskControl, state.taskControl) } finally { restored.close() }
  })
})

test('native calls outside the request projection are rejected before dispatch', async () => {
  await withLoop(() => ({ provider: 'custom', model: 'test', finishReason: 'tool_calls', raw: {}, text: '', toolCalls: [{ id: 'unknown', name: 'not_in_the_request', arguments: {} }] }), async (loop) => {
    const failed = waitFor(loop, 'failed')
    const send = command('chat.message.send', { clientMessageId: 'unknown-native', content: [{ type: 'text', text: '查找' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1)
    await failed
    assert.equal(loop.exportState().snapshot.run.failure?.code, 'RUNTIME_ENVELOPE_TOOL_UNAUTHORIZED')
    assert.equal(loop.exportState().snapshot.observations.items.length, 0)
  })
})

for (const variant of ['exact', 'bounded', 'different-file', 'outside-range', 'committed-edit']) test(`a settled file read outside the active projection recognizes the ${variant} request`, async () => {
  const rejected = variant === 'different-file' || variant === 'outside-range'
  const edited = variant === 'committed-edit'
  const investigation: RuntimePlanTask = { id: 'investigate', title: '读取材料', phase: 'investigation', owner: 'parent', dependsOn: [],
    capabilityIds: ['project-files:read_file'], completionConditions: ['取得读取回执'], requiredActions: [], evidenceRefs: [], status: 'pending' }
  const execution: RuntimePlanTask = { ...investigation, id: 'inspect-catalog', title: '核对目录', phase: 'execution',
    dependsOn: [investigation.id], capabilityIds: ['search_resources'], completionConditions: [edited ? '提交已核对的记录' : '已实际核对目录'] }
  const native = (id: string, name: string, args: Record<string, unknown>): LlmChatResponse =>
    ({ provider: 'custom', model: 'test', raw: {}, text: '', toolCalls: [{ id, name, arguments: args }] })
  let calls = 0
  let editRef = ''
  await withLoop(request => {
    const progress = (basePlanRevision: number, id: string, ref: string) => response(request, {
      decision: 'complete_plan_nodes', planProgress: { basePlanRevision, nodes: [{ id, actionRefs: [ref], evidenceRefs: [] }] },
    })
    calls++
    if (edited && (calls === 5 || calls === 6)) {
      if (calls === 6) {
        assert.deepEqual(request.tools, [])
        assert.match(request.messages.at(-1)?.content ?? '', /RUNTIME_CONTEXT_PLAN_NODE_REQUIRED.*No diff was committed/)
        const state = JSON.parse(request.messages[0]!.content.split('\n').find(line => line.startsWith('{"taskId":'))!)
        assert.equal(state.recentContextEdits, undefined)
      }
      const session = request.messages[0]!.content.split('# Session Context')[1]!
      const context = JSON.parse(session.match(/<!-- capybara:context-binding data=(\{[^\n]+?\}) -->/)![1]!)
      const candidate = [...session.matchAll(/<!-- capybara:candidate-ref data=(\{[^\n]+?\}) -->/g)]
        .map(match => JSON.parse(match[1]!)).find(item => item.source.sourceId === 'settled-investigation')
      assert.ok(candidate)
      return response(request, { decision: 'propose_diff', candidateDiffs: [{ ...context, scope: 'session',
        ...(calls === 6 ? { planTaskId: execution.id } : {}),
        candidateId: candidate.id, operation: 'add_entry', target: { section: 'information', headingPath: ['已查记录'] },
        payload: { body: '两项记录待核对。', evidenceRefs: candidate.evidence.map((item: { id: string }) => item.id) }, idempotencyKey: 'settled-record' }] })
    }
    if (edited && calls === 7) {
      const state = JSON.parse(request.messages[0]!.content.split('\n').find(line => line.startsWith('{"taskId":'))!)
      editRef = state.recentContextEdits.find((edit: { planTaskId: string }) => edit.planTaskId === execution.id).completionActionRef
      assert.match(editRef, /^context:receipt-/)
      return native('outdated-file', 'read_file', { include_line_numbers: true, file_name: 'record.txt', start_line: 1, end_line: 32 })
    }
    if (edited && calls === 8) {
      assert.deepEqual(request.tools, [])
      assert.ok(request.messages.at(-1)?.content.includes(editRef))
      assert.match(request.messages.at(-1)?.content ?? '', /RUNTIME_FILE_READ_ALREADY_SETTLED.*complete_plan_nodes/)
      return progress(2, execution.id, editRef)
    }
    switch (calls) {
      case 1: return response(request, { decision: 'propose_plan', planProposal: {
        basePlanRevision: 0, goal: '核对材料和目录', tasks: [investigation, execution],
      } })
      case 2: return native('select-file', 'load_resources', { ids: ['project-files:read_file'] })
      case 3: return native('original-file', 'read_file', { file_name: 'record.txt', include_line_numbers: true })
      case 4: return progress(1, investigation.id, 'call:original-file')
      case 5:
        assert.ok(!request.tools?.some(tool => tool.name === 'read_file'))
        return native('outdated-file', 'read_file', { include_line_numbers: true, file_name: variant === 'different-file' ? 'other.txt' : 'record.txt',
          ...(variant === 'bounded' || variant === 'outside-range' ? { start_line: variant === 'bounded' ? 1 : 2, end_line: 32 } : {}) })
      case 6:
        assert.match(request.messages.at(-1)?.content ?? '', /RUNTIME_FILE_READ_ALREADY_SETTLED.*call:original-file/)
        return native('check-catalog', 'search_resources', { query: 'read_file', limit: 1 })
      case 7: return progress(2, execution.id, 'call:check-catalog')
      default: return response(request, { decision: 'finish', userMessage: '资料和目录均已核对。', completionCheck: {
        taskId: binding(request).taskId, requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '读取与查询成功',
      } })
    }
  }, async (loop, projectDir) => {
    fs.writeFileSync(path.join(projectDir, 'record.txt'), '两项记录待核对。')
    if (edited) {
      const resources = new ProjectResources(projectDir)
      try { resources.saveSettings({ context_organization_version: 4 }) } finally { resources.close() }
    }
    const terminal = waitFor(loop, rejected ? 'failed' : 'completed')
    const send = command('chat.message.send', { clientMessageId: 'settled-investigation', content: [{ type: 'text', text: '检查资料与工具目录。' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1); await terminal
    const state = loop.exportState()
    assert.equal(calls, rejected ? 5 : edited ? 9 : 8)
    if (rejected) assert.equal(state.snapshot.run.failure?.code, 'RUNTIME_ENVELOPE_TOOL_UNAUTHORIZED')
    assert.equal(state.snapshot.observations.items.filter(item => item.toolName === 'read_file').length, 1)
    assert.equal(state.taskControl?.planRevision, rejected ? 2 : 3)
    if (edited) {
      assert.deepEqual(state.taskControl?.tasks[1]?.requiredActions, [editRef])
      assert.equal(state.contextDocument?.information.filter(entry => entry.headingPath.join('/') === '已查记录').length, 1)
    }
  })
})

test('an unprojected native human question is repaired before a bound request is published', async () => {
  let calls = 0
  await withLoop((request) => {
    const current = binding(request)
    if (++calls === 1) return { ...response(request, {}), text: '', toolCalls: [{ id: 'unprojected-question', name: 'ask_user',
      arguments: { question: '伪造问题', blockingTaskIds: ['invented-task'] } }] }
    assert.match(request.messages.at(-1)!.content, /RUNTIME_HUMAN_REQUEST_TRANSPORT.*ControlEnvelopeV2/)
    assert.deepEqual(request.tools, [])
    assert.equal(request.responseFormat, 'json')
    assert.doesNotMatch(JSON.stringify(request.messages), /伪造问题|invented-task/)
    return response(request, { decision: 'ask_user', userMessage: '请确认是否只读汇报。',
      actions: [{ kind: 'ask_user', question: '请确认是否只读汇报。', blockingTaskIds: [current.taskId] }] })
  }, async (loop) => {
    const paused = waitFor(loop, 'paused')
    const send = command('chat.message.send', { clientMessageId: 'unprojected-question', content: [{ type: 'text', text: '先确认授权。' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1)
    await paused
    assert.equal(calls, 2)
    assert.equal(loop.exportState().contextControl?.question, '请确认是否只读汇报。')
  })
})

test('an unprojected native finish and an incorrect request ID are repaired before completion', async () => {
  let calls = 0
  let rejectedBinding: RuntimeRequestBinding
  await withLoop(request => {
    const current = binding(request)
    assert.ok(request.tools?.every(tool => tool.name !== 'finish'))
    if (++calls === 1) return { ...response(request, {}), text: '', finishReason: 'tool_calls',
      toolCalls: [{ id: 'read-before-finish', name: 'search_resources', arguments: { query: 'files' } }] }
    if (calls === 2) {
      rejectedBinding = current
      return { ...response(request, {}), text: '', finishReason: 'tool_calls',
        toolCalls: [{ id: 'unprojected-finish', name: 'finish', arguments: { forged: 'not-evidence' } }] }
    }
    assert.equal(current.taskId, rejectedBinding.taskId)
    assert.equal(current.runId, rejectedBinding.runId)
    assert.equal(current.stateRevision, rejectedBinding.stateRevision)
    assert.notEqual(current.requestId, rejectedBinding.requestId)
    assert.ok(request.messages.some(message => message.role === 'tool' && message.toolCallId === 'read-before-finish'))
    assert.doesNotMatch(JSON.stringify(request.messages), /not-evidence|unprojected-finish/)
    const finish = { decision: 'finish' as const, userMessage: '资源目录已核对。', completionCheck: {
      taskId: current.taskId, requiredActions: ['call:read-before-finish'], requiredEvidenceRefs: [],
      unresolvedUncertaintyIds: [], summary: '凭真实工具结果交付',
    } }
    if (calls === 3) {
      assert.match(request.messages.at(-1)!.content, /RUNTIME_COMPLETION_TRANSPORT.*ControlEnvelopeV2/)
      assert.deepEqual(request.tools, [])
      assert.equal(request.responseFormat, 'json')
      return response(request, { ...finish, binding: { ...current, requestId: 'mistyped-request-id' } })
    }
    assert.equal(calls, 4)
    assert.match(request.messages.at(-1)!.content, /Copy the entire binding/)
    return response(request, finish)
  }, async loop => {
    const done = waitFor(loop, 'completed')
    const send = command('chat.message.send', { clientMessageId: 'native-finish-repair', content: [{ type: 'text', text: '核对资源目录。' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1); await done
    const state = loop.exportState()
    assert.equal(calls, 4)
    assert.deepEqual(state.snapshot.observations.items.map(item => item.toolName), ['search_resources'])
    assert.deepEqual(state.taskControl?.requiredActions, ['call:read-before-finish'])
    assert.ok(state.snapshot.timeline.steps.some(step => step.detail?.outputRepair === true && step.detail.controlRejection === 'RUNTIME_COMPLETION_TRANSPORT'))
    assert.ok(state.artifacts.some(artifact => artifact.meta.label === 'Runtime completion verification'))
  })
})

test('completion repairs distinguish fields, a missing check and reportable uncertainty without replaying a tool', async () => {
  let calls = 0
  let revision: number
  const reply = '两份材料均已核对，发布日期由资料负责人判断。'
  await withLoop(request => {
    calls++
    const current = binding(request)
    if (calls === 1) return { ...response(request, {}), text: '', toolCalls: [{ id: 'finish-lookup', name: 'search_resources', arguments: { query: 'files' } }] }
    const check = { taskId: current.taskId, requiredActions: ['call:finish-lookup'], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '已核对实际工具收据' }
    const uncertainty = { id: 'release-time', statement: '发布时间由资料负责人判断。', blocking: true, relatedTaskIds: [current.taskId], evidenceRefs: [] }
    const finish = (overrides: Partial<ControlEnvelopeV2>) => response(request, { decision: 'finish', userMessage: reply, completionCheck: check, ...overrides })
    if (calls === 2) {
      revision = current.stateRevision
      const invalid = { ...check, verified: 'MODEL_ADDED_FIELD_9d3a' }
      const result = finish({ completionCheck: invalid })
      assert.deepEqual(request.validateResponse?.(result), { recovery: 'runtime' })
      return result
    }
    assert.equal(current.stateRevision, revision)
    const repair = request.messages.at(-1)!.content
    if (calls === 3) {
      assert.match(repair, /RUNTIME_COMPLETION_CHECK_SCHEMA.*exactly taskId, requiredEvidenceRefs, requiredActions, unresolvedUncertaintyIds, summary/)
      assert.doesNotMatch(repair, /MODEL_ADDED_FIELD_9d3a/)
      return finish({ completionCheck: null })
    }
    if (calls === 4) {
      assert.match(repair, /RUNTIME_COMPLETION_CHECK_SCHEMA.*completionCheck to an object/)
      return finish({ uncertainties: [uncertainty] })
    }
    assert.match(repair, /RUNTIME_COMPLETION_CHECK_BLOCKED.*Keep genuine blockers/)
    assert.ok(request.messages.some(message => message.role === 'tool' && message.toolCallId === 'finish-lookup'))
    return finish({ uncertainties: [{ ...uncertainty, blocking: false }] })
  }, async loop => {
    const done = waitFor(loop, 'completed')
    const send = command('chat.message.send', { clientMessageId: 'completion-repair', content: [{ type: 'text', text: '核对并整理交接。' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1); await done
    const state = loop.exportState()
    assert.equal(calls, 5)
    assert.equal(state.snapshot.observations.items.filter(item => item.toolName === 'search_resources').length, 1)
    assert.deepEqual(state.taskControl?.requiredActions, ['call:finish-lookup'])
    assert.equal(state.taskControl?.stateRevision, revision + 1)
    assert.deepEqual(state.snapshot.timeline.steps.filter(step => step.detail?.outputRepair).map(step => step.detail?.controlRejection),
      ['RUNTIME_COMPLETION_CHECK_SCHEMA', 'RUNTIME_COMPLETION_CHECK_SCHEMA', 'RUNTIME_COMPLETION_CHECK_BLOCKED'])
  })
})

test('completion repair cannot clear an existing blocker without registered evidence', async () => {
  let calls = 0
  await withLoop(request => {
    calls++
    const current = binding(request)
    const blocker = { id: 'source-required', statement: '缺少必要原件。', blocking: calls !== 3, relatedTaskIds: [current.taskId], evidenceRefs: [] }
    if (calls === 1) return response(request, { reasoningNextStep: '核查状态中的原件来源', uncertainties: [blocker] })
    if (calls === 3) assert.match(request.messages.at(-1)!.content, /RUNTIME_COMPLETION_CHECK_BLOCKED.*Keep genuine blockers/)
    return response(request, { decision: 'finish', userMessage: '任务完成。', uncertainties: [blocker], completionCheck: {
      taskId: current.taskId, requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '全部检查完成',
    } })
  }, async loop => {
    const failed = waitFor(loop, 'failed')
    const send = command('chat.message.send', { clientMessageId: 'completion-blocker', content: [{ type: 'text', text: '取得必要原件再完成。' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1); await failed
    const state = loop.exportState()
    assert.equal(calls, 3)
    assert.equal(state.snapshot.run.failure?.code, 'RUNTIME_TASK_COMPLETION_BLOCKED')
    assert.equal(state.taskControl?.uncertainties[0]?.blocking, true)
    assert.ok(!state.artifacts.some(artifact => artifact.meta.label === 'Runtime completion verification'))
  })
})

test('an unverified initial completion and a repeated graph return to the active work without advancing the plan revision', async () => {
  const node: RuntimePlanTask = { id: 'lookup', title: '核对能力', owner: 'parent', phase: 'execution', dependsOn: [],
    capabilityIds: ['search_resources'], completionConditions: ['取得实际查找回执'], requiredActions: [], evidenceRefs: [], status: 'pending' }
  let calls = 0
  await withLoop(request => {
    calls++
    if (calls <= 3) {
      if (calls === 2) assert.match(request.messages.at(-1)?.content ?? '', /RUNTIME_PLAN_COMPLETION_UNVERIFIED.*lookup.*pending/)
      return response(request, { decision: 'propose_plan', planProposal: {
        basePlanRevision: calls === 3 ? 1 : 0, goal: calls === 3 ? '原先计划的另一种表述' : '核对能力',
        tasks: [{ ...node, status: calls === 1 ? 'completed' : 'pending' }],
      } })
    }
    if (calls === 4) {
      assert.match(request.messages.at(-1)?.content ?? '', /already contains those nodes \(revision 1\)/)
      assert.match(request.messages.at(-1)?.content ?? '', /Advance active nodes \["lookup"\]/)
      assert.ok(request.tools?.some(tool => tool.name === 'search_resources'))
      return { provider: 'custom', model: 'test', raw: {}, text: '',
        toolCalls: [{ id: 'lookup-action', name: 'search_resources', arguments: { query: 'files', limit: 1 } }] }
    }
    if (calls === 5) return response(request, { decision: 'complete_plan_nodes',
      planProgress: { basePlanRevision: 1, nodes: [{ id: node.id, actionRefs: ['call:lookup-action'], evidenceRefs: [] }] } })
    return response(request, { decision: 'finish', userMessage: '能力已核对。', completionCheck: {
      taskId: binding(request).taskId, requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '实际查找成功',
    } })
  }, async loop => {
    const done = waitFor(loop, 'completed')
    const send = command('chat.message.send', { clientMessageId: 'unchanged-plan', content: [{ type: 'text', text: '核对能力。' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1); await done
    const state = loop.exportState()
    assert.equal(calls, 6)
    assert.equal(state.taskControl?.planRevision, 2)
    assert.equal(state.taskControl?.planGoal, '核对能力')
  })
})

test('pending plan revisions admit only verifiable new references and repair without changing the accepted plan', async () => {
  let calls = 0
  let toolSourceRequest = ''
  const task = { id: 'search', title: '查找工具', owner: 'parent', dependsOn: [], capabilityIds: ['search_resources'],
    completionConditions: ['成功取得工具检索结果'], requiredActions: ['tool:search_resources'], evidenceRefs: [] as string[], status: 'pending' as const }
  await withLoop(request => {
    calls++
    const plan = (basePlanRevision: number, node: RuntimePlanTask) => response(request, {
      decision: 'propose_plan', planProposal: { basePlanRevision, goal: '查找文件工具', tasks: [node] },
    })
    const finish = (requestBinding = binding(request)) => response(request, { binding: requestBinding, decision: 'finish',
      userMessage: '已核对实际查找结果。', completionCheck: { taskId: requestBinding.taskId,
        requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '依据真实检索回执完成' } })
    if (calls === 1) return plan(0, task)
    if (calls === 2) return plan(1, { ...task, requiredActions: [...task.requiredActions, 'propose_diff'] })
    if (calls === 3) return plan(1, { ...task, requiredActions: [...task.requiredActions, 'call:future-native'] })
    if (calls === 4) {
      assert.match(request.messages.at(-1)?.content ?? '', /Remove the rejected action reference "call:future-native" from "search"\. No eligible successful receipt/)
      return plan(1, { ...task, evidenceRefs: ['invented-evidence'] })
    }
    if (calls === 5) {
      const state = JSON.parse(request.messages[0]!.content.split('\n').find(line => line.startsWith('{"taskId":'))!)
      assert.equal(state.planRevision, 1)
      assert.deepEqual(state.requiredActions, task.requiredActions)
      assert.deepEqual(state.requiredEvidenceRefs, [])
      assert.match(request.messages.at(-1)?.content ?? '', /RUNTIME_PLAN_EVIDENCE_UNBOUND/)
      assert.ok(!request.messages.some(message => message.content.includes('invented-evidence')))
      toolSourceRequest = binding(request).requestId
      return { provider: 'custom', model: 'test', finishReason: 'tool_calls', raw: {}, text: '', toolCalls: [{ id: 'actual-lookup', name: 'search_resources', arguments: { query: 'files', limit: 1 } }] }
    }
    if (calls === 6) return finish({ ...binding(request), requestId: toolSourceRequest })
    if (calls === 7) {
      assert.match(request.messages.at(-1)?.content ?? '', /previous request ID/)
      return finish()
    }
    if (calls === 8) {
      assert.match(request.messages.at(-1)?.content ?? '', /unfinished nodes/)
      const output = request.messages.find(message => message.toolCallId === 'actual-lookup')
      assert.ok(output)
      const receipt = JSON.parse(output.content).runtime_receipt
      assert.equal(receipt.completionActionRef, 'call:actual-lookup')
      return plan(1, { ...task, status: 'completed', requiredActions: [...task.requiredActions, receipt.completionActionRef] })
    }
    return finish()
  }, async loop => {
    const done = waitFor(loop, 'completed')
    const send = command('chat.message.send', { clientMessageId: 'plan-proof-admission', content: [{ type: 'text', text: '查找文件工具' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1); await done
    const state = loop.exportState()
    assert.equal(calls, 9)
    assert.equal(state.taskControl?.planRevision, 2)
    assert.deepEqual(state.taskControl?.requiredActions, ['tool:search_resources', 'call:actual-lookup'])
    const rejected = state.artifacts.filter(item => item.meta.label === 'Rejected runtime plan references')
      .map(item => item.value as { code: string; responseArtifactId: string; planRevision: number })
    assert.deepEqual(rejected.map(item => item.code), ['RUNTIME_PLAN_ACTION_UNBOUND', 'RUNTIME_PLAN_ACTION_UNBOUND', 'RUNTIME_PLAN_EVIDENCE_UNBOUND'])
    assert.ok(rejected.every(item => item.planRevision === 1 && state.artifacts.some(artifact => artifact.meta.id === item.responseArtifactId)))
    assert.equal(state.snapshot.observations.items.filter(item => item.toolName === 'search_resources').length, 1)
  })
})

test('repeated unbound plan references exhaust repair without creating a plan or executing actions', async () => {
  let calls = 0
  await withLoop(request => {
    calls++
    return response(request, { decision: 'propose_plan', planProposal: { basePlanRevision: 0, goal: '查找文件工具', tasks: [{
      id: 'search', title: '查找工具', owner: 'parent', dependsOn: [], capabilityIds: ['search_resources'],
      completionConditions: ['需要实际检索'], requiredActions: ['step:future-tool-step'], evidenceRefs: [], status: 'pending',
    }] } })
  }, async loop => {
    const failed = waitFor(loop, 'failed')
    const send = command('chat.message.send', { clientMessageId: 'repeated-plan-forgery', content: [{ type: 'text', text: '查找文件工具' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1); await failed
    const state = loop.exportState()
    assert.equal(calls, 4)
    assert.equal(state.snapshot.run.failure?.code, 'RUNTIME_PLAN_ACTION_UNBOUND')
    assert.equal(state.taskControl?.planRevision, 0)
    assert.deepEqual(state.taskControl?.requiredActions, [])
    assert.equal(state.snapshot.observations.items.length, 0)
  })
})

for (const phase of ['investigation', 'execution'] as const) test(`document edit claims cannot escape the active execution node in ${phase}`, async () => {
  let calls = 0
  await withLoop(request => {
    if (++calls === 1) return response(request, { decision: 'propose_plan', planProposal: {
      basePlanRevision: 0, goal: '检查并整理章节', tasks: [{ id: 'inspect', title: '定位章节', owner: 'parent', phase, dependsOn: [],
        capabilityIds: [], completionConditions: ['定位实际章节'], requiredActions: [], evidenceRefs: [], status: 'pending' }],
    } })
    return response(request, { decision: 'propose_diff', candidateDiffs: [{
      planTaskId: phase === 'investigation' ? 'inspect' : 'other-node',
      scope: 'session', documentId: 'document', baseRevision: 0, projectionId: 'projection', projectionHash: '0'.repeat(64),
      target: { section: 'information' }, operation: 'add_entry', payload: { body: '不应写入', evidenceRefs: ['source'] },
      candidateId: 'candidate', idempotencyKey: 'invalid-node',
    }] })
  }, async loop => {
    const failed = waitFor(loop, 'failed')
    const send = command('chat.message.send', { clientMessageId: 'inactive-node', content: [{ type: 'text', text: '整理章节' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1); await failed
    assert.equal(calls, 2)
    const state = loop.exportState()
    assert.equal(state.snapshot.run.failure?.code, 'RUNTIME_CONTEXT_PLAN_NODE_INACTIVE')
    assert.deepEqual(state.taskControl?.requiredActions, [])
    assert.deepEqual(state.contextDocument?.information, [])
  })
})
