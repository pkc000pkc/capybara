import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RuntimeLoop, type RuntimeLlm, type RuntimeLoopOptions } from '#core/runtime-loop'
import { initializeProjectDirectory } from '#core/project-initializer'
import type { ClientCommand, ControlEnvelopeV2, RuntimePlanTask, RuntimeRequestBinding, ServerEvent } from '#protocol/runtime-protocol'
import { LlmToolArgumentsError, type LlmChatRequest, type LlmChatResponse } from '#util/llm'

function binding(request: LlmChatRequest): RuntimeRequestBinding {
  const match = request.messages[0]!.content.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)
  assert.ok(match); return JSON.parse(match[0])
}
function phase(request: LlmChatRequest): string {
  const match = request.messages[0]!.content.match(/"execution":(\{[^{}]+\})/)
  assert.ok(match); return JSON.parse(match[1]!).phase
}
function reply(request: LlmChatRequest, overrides: Partial<ControlEnvelopeV2>): LlmChatResponse {
  return { provider: 'custom', model: 'stage-test', finishReason: 'stop', raw: {}, text: JSON.stringify({
    envelopeVersion: 2, binding: binding(request), decision: 'continue', userMessage: '', actions: [], planProposal: null, candidateDiffs: [], evidenceRequests: [], uncertainties: [], waitSpec: null, completionCheck: null, ...overrides,
  }) }
}
function call(name: string, id: string, args: Record<string, unknown> = {}): LlmChatResponse {
  return { provider: 'custom', model: 'stage-test', text: '', finishReason: 'tool_calls', raw: {}, toolCalls: [{ id, name, arguments: args }] }
}
function ask(request: LlmChatRequest, question = '需要根据当前能力调整任务。'): LlmChatResponse {
  return reply(request, { decision: 'ask_user', userMessage: question, actions: [{ kind: 'ask_user', question, blockingTaskIds: [binding(request).taskId] }] })
}
function fixture(actor: (request: LlmChatRequest) => LlmChatResponse, options: Partial<RuntimeLoopOptions> = {}, setup?: (root: string, config: Record<string, unknown>) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-planning-projection-'))
  initializeProjectDirectory(root)
  const configFile = path.join(root, '.capybara/config.json'), manifestDir = path.join(root, 'tools/stage')
  fs.mkdirSync(manifestDir, { recursive: true })
  const runner = path.join(manifestDir, 'runner.mjs')
  fs.writeFileSync(runner, `import fs from 'node:fs'; import path from 'node:path';
let raw=''; for await(const chunk of process.stdin) raw+=chunk;
const request=JSON.parse(raw), root=process.env.CAPYBARA_PROJECT_DIR;
let result;
if(request.tool==='stage_write'){fs.writeFileSync(path.join(root,'output.txt'),request.arguments.value);result={written:true};}
else result={content:fs.readFileSync(path.join(root,fs.existsSync(path.join(root,'output.txt'))?'output.txt':'input.txt'),'utf8')};
process.stdout.write(JSON.stringify({id:request.id,ok:true,result}));`)
  fs.writeFileSync(path.join(manifestDir, 'manifest.json'), JSON.stringify({ version: 1, package: 'stage', runner: { type: 'stdio', entry: 'runner.mjs' }, tools: [
    { name: 'stage_read', description: 'Read the fixture source or result', permissions: ['filesystem:read'], sideEffects: 'none', replay: 'safe', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'stage_write', description: 'Write the fixture result', permissions: ['filesystem:write'], sideEffects: 'workspace-write', replay: 'confirm', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } },
  ] }))
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  config.tools = ['tools/stage/manifest.json']; config.tool_permissions = ['filesystem:read', 'filesystem:write']
  setup?.(root, config)
  fs.writeFileSync(configFile, JSON.stringify(config)); fs.writeFileSync(path.join(root, 'input.txt'), '真实来源')
  const llm: RuntimeLlm = { getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'stage-test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }), chat: async request => actor(request) }
  const loop = new RuntimeLoop({ projectDir: root, sessionId: 'stage-session', llm, stepDelayMs: 0, streamDelayMs: 0, contextOrganization: { minGroups: 100 }, ...options })
  const events: ServerEvent[] = []
  loop.onEvent(event => events.push(event as ServerEvent))
  let sequence = 0
  const send = (type: ClientCommand['type'], payload: unknown, runtime = loop) => {
    const command = { version: 1, kind: 'command', id: `stage-${++sequence}`, type, sessionId: 'stage-session', timestamp: new Date().toISOString(), payload } as ClientCommand
    runtime.validate(command); runtime.execute(command, sequence)
  }
  for (const name of ['stage_read', 'stage_write']) {
    const tools = loop.exportState().snapshot.tools
    send('runtime.tools.attach', { toolId: tools.catalog.find(tool => tool.name === name)!.id, baseRevision: tools.revision })
  }
  return { root, runner, configFile, loop, llm, events, send,
    start(planningRequired = false) { send('chat.message.send', { clientMessageId: `message-${++sequence}`, content: [{ type: 'text', text: '读取来源，写入结果并验证。' }], autoStart: true, planningRequired }) },
    wait(status: 'completed' | 'failed' | 'paused' | 'cancelled', runtime = loop) { return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`run did not reach ${status}: ${JSON.stringify(runtime.exportState().snapshot.run)}`)) }, 20000)
      const off = runtime.onEvent(event => {
        if (event.type !== 'run.state.changed') return
        if (event.payload.status === status) { clearTimeout(timer); off(); resolve() }
        else if (event.payload.status === 'failed') { clearTimeout(timer); off(); reject(new Error(event.payload.failure?.message)) }
      })
    }) },
    close() { loop.close(); fs.rmSync(root, { recursive: true, force: true }) },
  }
}

function addSkill(root: string, id: string, body: string, references: Record<string, string> = {}, requiredTools: string[] = []): string {
  const relative = `skills/${id}`
  const directory = path.join(root, relative)
  fs.mkdirSync(path.join(directory, 'references'), { recursive: true })
  const metadata = requiredTools.length ? `metadata:\n  capybara-required-tools: "${requiredTools.join(' ')}"\n` : ''
  fs.writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${id}\ndescription: Project guide ${id}\n${metadata}---\n${body}`)
  for (const [file, content] of Object.entries(references)) fs.writeFileSync(path.join(directory, 'references', file), content)
  return relative
}

test('Skill activation follows its plan node across reconnect and stays outside other model stages', async () => {
  const nodes: RuntimePlanTask[] = [
    { id: 'read', title: '核对来源', phase: 'investigation', dependsOn: [], owner: 'parent', capabilityIds: ['stage_read'],
      completionConditions: ['确认来源'], requiredActions: ['call:scoped-skill-proof'], evidenceRefs: [], status: 'pending' },
    { id: 'write', title: '写入结果', phase: 'execution', dependsOn: ['read'], owner: 'parent', capabilityIds: ['stage_write'],
      completionConditions: ['核对实际写入'], requiredActions: ['call:scoped-write'], evidenceRefs: [], status: 'pending' },
  ]
  let round = 0
  const f = fixture(request => {
    const system = request.messages[0]!.content
    const plan = (basePlanRevision: number) => reply(request, { decision: 'propose_plan', planProposal: { basePlanRevision, goal: '按真实来源写入', tasks: nodes.map(node => node.status === 'pending' ? { ...node, requiredActions: [] } : node) } })
    const scopedBody = 'INVESTIGATION_ONLY_GUIDE'
    if (++round === 1) {
      assert.equal(phase(request), 'planning')
      assert.match(system, /Project guide scoped-guide/)
      assert.doesNotMatch(system, /EXPLICIT_MANUAL_GUIDE|INVESTIGATION_ONLY_GUIDE/)
      return plan(0)
    }
    if (round === 2) {
      assert.equal(phase(request), 'investigation')
      assert.match(system, /EXPLICIT_MANUAL_GUIDE/)
      assert.doesNotMatch(system, new RegExp(scopedBody))
      return call('load_resources', 'scoped-skill-load', { ids: ['scoped-guide'] })
    }
    if (round === 3) {
      assert.match(system, new RegExp(scopedBody))
      return call('read_skill_resource', 'scoped-skill-read', { skill_id: 'scoped-guide', path: 'references/source.md' })
    }
    if (round === 4) {
      assert.match(system, /SCOPE_SOURCE_REFERENCE/)
      return reply(request, { decision: 'ask_user', userMessage: '确认来源？', actions: [{ kind: 'ask_user', question: '确认来源？', blockingTaskIds: ['read'] }] })
    }
    if (round === 5) {
      assert.match(system, /INVESTIGATION_ONLY_GUIDE[\s\S]*SCOPE_SOURCE_REFERENCE/)
      assert.match(request.messages.find(message => message.toolCallId === 'scoped-skill-read')?.content ?? '', /active_skill_context/)
      return call('stage_read', 'scoped-skill-proof')
    }
    if (round === 6) { nodes[0]!.status = 'completed'; return plan(1) }
    if (round === 7) {
      assert.equal(phase(request), 'execution')
      const projectPrompt = system.split('## Project System Prompt (lower priority)')[1]!.split('# Project Context')[0]!
      assert.doesNotMatch(projectPrompt, /INVESTIGATION_ONLY_GUIDE|SCOPE_SOURCE_REFERENCE/)
      assert.match(system, /EXPLICIT_MANUAL_GUIDE/)
      assert.ok(request.tools?.some(tool => tool.name === 'read_skill_resource'))
      assert.match(request.messages.find(message => message.toolCallId === 'scoped-skill-read')?.content ?? '', /SCOPE_SOURCE_REFERENCE/)
      return call('read_skill_resource', 'outside-scope-read', { skill_id: 'scoped-guide', path: 'references/source.md' })
    }
    if (round === 8) {
      const refused = request.messages.find(message => message.toolCallId === 'outside-scope-read')
      assert.match(refused?.content ?? '', /Skill is not active in this model stage/)
      return call('stage_write', 'scoped-write', { value: '已核对' })
    }
    if (round === 9) { nodes[1]!.status = 'completed'; return plan(2) }
    assert.equal(round, 10)
    return reply(request, { decision: 'finish', userMessage: '已核对并写入。', completionCheck: { taskId: binding(request).taskId,
      requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '已核对工具回执' } })
  }, {}, (root, config) => {
    config.context = { ...(config.context as object), context_window_tokens: 22_000, max_input_tokens: 19_000 }
    config.skills = [addSkill(root, 'scoped-guide', 'INVESTIGATION_ONLY_GUIDE', { 'source.md': 'SCOPE_SOURCE_REFERENCE' }),
      addSkill(root, 'manual-guide', 'EXPLICIT_MANUAL_GUIDE', { 'manual.md': 'Manual resource' })]
  })
  let restored: RuntimeLoop | undefined
  try {
    f.send('runtime.skills.attach', { skillId: 'manual-guide', baseRevision: f.loop.getSnapshot(0).skills.revision })
    const paused = f.wait('paused'); f.start(true); await paused
    const saved = f.loop.exportState()
    const question = saved.taskControl!.branchBlocks![0]!
    const scoped = saved.snapshot.skills.items.find(skill => skill.id === 'scoped-guide')
    assert.deepEqual(scoped?.activation, { taskId: saved.taskControl!.taskId, stages: { investigation: ['read'] } })
    f.loop.close()
    restored = new RuntimeLoop({ projectDir: f.root, sessionId: 'stage-session', llm: f.llm, initialState: saved,
      stepDelayMs: 0, streamDelayMs: 0, contextOrganization: { minGroups: 100 } })
    const completed = f.wait('completed', restored)
    f.send('chat.message.send', { clientMessageId: 'confirm-skill-source', humanRequestId: question.id, autoStart: true,
      content: [{ type: 'text', text: '已确认。' }] }, restored)
    await completed
    const receipts = restored.exportState().artifacts.filter(item => item.meta.kind === 'model-request').map(item => item.value as {
      skillProjection: { phase: string; selected: Array<{ id: string; version?: string; references: Array<{ path: string; hash: string }> }> }
    }).map(item => item.skillProjection)
    const included = receipts.find(item => item.selected.some(skill => skill.id === 'scoped-guide' && skill.references.length))
    const reference = included?.selected.find(skill => skill.id === 'scoped-guide')
    assert.ok(reference?.version && reference.references[0]?.hash)
    assert.equal(reference?.version, scoped?.sourceVersion)
    assert.equal(reference?.references[0]?.hash, scoped?.resources.find(resource => resource.kind === 'reference')?.hash)
    assert.equal(receipts.find(item => item.phase === 'execution')?.selected.some(skill => skill.id === 'scoped-guide'), false)
  } finally { restored?.close(); f.close() }
})

test('unloading a Skill releases only its exclusive tool attachments after reconnect', () => {
  const f = fixture(() => assert.fail('Skill attachment management requires no model call'), {}, (root, config) => {
    config.skills = [addSkill(root, 'first-guide', 'First guide.', {}, ['stage:stage_read', 'stage:stage_write']),
      addSkill(root, 'second-guide', 'Second guide.', {}, ['stage:stage_read'])]
  })
  let restored: RuntimeLoop | undefined
  try {
    for (const toolId of ['stage:stage_read', 'stage:stage_write']) {
      f.send('runtime.tools.detach', { toolId, baseRevision: f.loop.getSnapshot(0).tools.revision })
    }
    for (const skillId of ['first-guide', 'second-guide']) {
      f.send('runtime.skills.attach', { skillId, baseRevision: f.loop.getSnapshot(0).skills.revision })
    }
    const tools = f.loop.getSnapshot(0).tools
    assert.ok(tools.items.find(tool => tool.id === 'stage:stage_read')?.attachedBySkill)
    assert.ok(tools.items.find(tool => tool.id === 'stage:stage_write')?.attachedBySkill)
    f.send('runtime.tools.attach', { toolId: 'stage:stage_write', baseRevision: tools.revision })
    const saved = f.loop.exportState()
    f.loop.close()
    restored = new RuntimeLoop({ projectDir: f.root, sessionId: 'stage-session', llm: f.llm, initialState: saved })
    f.send('runtime.skills.detach', { skillId: 'first-guide', baseRevision: restored.getSnapshot(0).skills.revision }, restored)
    const remaining = restored.getSnapshot(0).tools.items
    assert.ok(remaining.find(tool => tool.id === 'stage:stage_read')?.attachedBySkill)
    assert.equal(remaining.find(tool => tool.id === 'stage:stage_write')?.attachedBySkill, undefined)
    f.send('runtime.skills.detach', { skillId: 'second-guide', baseRevision: restored.getSnapshot(0).skills.revision }, restored)
    assert.deepEqual(restored.getSnapshot(0).tools.items.map(tool => tool.id), ['stage:stage_write'])
  } finally { restored?.close(); f.close() }
})

test('the actual request fits complete Skill blocks while the session preserves oversized bodies and references', async () => {
  const largeBody = `LARGE_GUIDE_START_${'A'.repeat(48_000)}_LARGE_GUIDE_END`
  const largeReference = `LARGE_REFERENCE_START_${'B'.repeat(48_000)}_LARGE_REFERENCE_END`
  let round = 0, artifactId: string
  const f = fixture(request => {
    const system = request.messages[0]!.content
    const prompt = system.split('## Project System Prompt (lower priority)')[1]!.split('# Project Context')[0]!
    assert.match(prompt, /SMALL_GUIDE_BODY[\s\S]*COMPLETE_SMALL_REFERENCE/)
    assert.doesNotMatch(prompt, /LARGE_GUIDE_START|LARGE_GUIDE_END|LARGE_REFERENCE_START|LARGE_REFERENCE_END/)
    assert.match(system, /# Session Context/)
    assert.ok(JSON.stringify({ messages: request.messages, tools: request.tools }).length / 4 < 12_000)
    if (++round === 1) return call('read_skill_resource', 'read-large-guide', { skill_id: 'large-guide', path: 'SKILL.md' })
    if (round === 2) {
      const observed = JSON.parse(request.messages.find(message => message.toolCallId === 'read-large-guide')!.content)
      assert.equal(observed.abbreviated, true)
      artifactId = observed.artifact_id
      assert.ok(artifactId)
      return call('read_runtime_artifact', 'original-guide-page', { artifact_id: artifactId, offset: 0, limit: 600 })
    }
    assert.equal(round, 3)
    const page = JSON.parse(request.messages.find(message => message.toolCallId === 'original-guide-page')!.content).result
    assert.equal(page.artifact_id, artifactId)
    assert.match(page.content, /LARGE_GUIDE_START/)
    assert.equal(page.next_offset, 600)
    return reply(request, { decision: 'finish', userMessage: '已核对预算。', completionCheck: { taskId: binding(request).taskId,
      requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '当前资料完整' } })
  }, { contextOrganization: { enabled: false } }, (root, config) => {
    config.context = { ...(config.context as object), context_window_tokens: 16_000, max_input_tokens: 12_000 }
    config.skills = [addSkill(root, 'large-guide', largeBody), addSkill(root, 'small-guide', 'SMALL_GUIDE_BODY',
      { 'large.md': largeReference, 'small.md': 'COMPLETE_SMALL_REFERENCE' })]
  })
  try {
    for (const skillId of ['large-guide', 'small-guide']) f.send('runtime.skills.attach', { skillId, baseRevision: f.loop.getSnapshot(0).skills.revision })
    for (const file of ['large.md', 'small.md']) f.send('runtime.skills.reference.load', { skillId: 'small-guide', path: `references/${file}`, baseRevision: f.loop.getSnapshot(0).skills.revision })
    const done = f.wait('completed'); f.start(); await done
    const saved = f.loop.exportState().snapshot
    assert.equal(saved.skills.items.find(skill => skill.id === 'large-guide')?.instructions, largeBody)
    assert.equal(saved.skills.items.find(skill => skill.id === 'small-guide')?.resources.find(resource => resource.path === 'references/large.md')?.content, largeReference)
  } finally { f.close() }
})

test('a required planning round leads through investigation, execution and verification with real file receipts', async () => {
  let calls = 0
  const nodes: RuntimePlanTask[] = [
    { id: 'read', title: '读取来源', phase: 'investigation', dependsOn: [], owner: 'parent', capabilityIds: ['stage:stage_read'], completionConditions: ['读取真实来源'], requiredActions: ['call:read'], evidenceRefs: [], status: 'pending' },
    { id: 'write', title: '写入结果', phase: 'execution', dependsOn: ['read'], owner: 'parent', capabilityIds: ['stage:stage_write'], completionConditions: ['写入结果文件'], requiredActions: ['call:write'], evidenceRefs: [], status: 'pending' },
    { id: 'verify', title: '验证结果', phase: 'verification', dependsOn: ['write'], owner: 'parent', capabilityIds: ['stage:stage_read'], completionConditions: ['读回结果'], requiredActions: ['call:verify'], evidenceRefs: [], status: 'pending' },
  ]
  const f = fixture(request => {
    calls++
    const round = calls > 3 ? calls - 1 : calls
    const names = new Set(request.tools?.map(tool => tool.name))
    assert.equal(request.responseFormat, names.size > 0 ? 'text' : 'json')
    if (calls === 1) {
      assert.equal(phase(request), 'planning'); assert.deepEqual(request.tools, [])
      assert.ok(request.messages[0]!.content.includes('stage:stage_write'))
      assert.match(request.messages[0]!.content, /按 `execution\.activeTaskIds` 处理当前节点/)
      assert.doesNotMatch(request.messages[0]!.content, /"status":"running","content":"brief reason/)
      assert.doesNotMatch(request.messages[0]!.content, /System variable authoring protocol|^- stage_(read|write):/m)
    }
    if (calls === 1) {
      return reply(request, { decision: 'propose_plan', planProposal: { basePlanRevision: 0, goal: '按来源生成结果并验证', tasks: nodes.map(node => ({ ...node, requiredActions: [] })) },
        uncertainties: [{ id: 'verify-content', statement: '尚未读回写入结果', blocking: false, relatedTaskIds: ['verify'], evidenceRefs: [] }] })
    }
    if ([3, 5, 7].includes(round)) {
      const node = nodes[(round - 3) / 2]!
      const state = JSON.parse(request.messages[0]!.content.split('\n').find(line => line.startsWith('{"taskId":'))!)
      assert.deepEqual(state.execution.activeTaskIds, [node.id])
      const schema = JSON.parse(request.messages[0]!.content.split('\n').find(line => line.startsWith('{"type":"object","additionalProperties":false,"required":["envelopeVersion"'))!)
      const progress = schema.properties.planProgress.anyOf[0].properties
      assert.equal(progress.basePlanRevision.const, state.planRevision)
      assert.deepEqual(progress.nodes.items.properties.id.enum, [node.id])
      assert.equal(progress.nodes.maxItems, 1)
      assert.equal(state.recentPlanActions.at(-1).completionActionRef, node.requiredActions[0])
      assert.deepEqual(state.recentPlanActions.at(-1).taskIds, [node.id])
      if (calls === 4) {
        assert.equal(state.planRevision, 1)
        assert.match(request.messages.at(-1)!.content, /RUNTIME_PLAN_EVIDENCE_UNBOUND.*Remove artifact IDs/)
      }
      const tool = request.messages.filter(message => message.role === 'tool' && message.name === 'stage_read').at(-1)
      const evidenceRefs = calls === 3 ? [JSON.parse(tool!.content).runtime_receipt.resultArtifactId] : []
      return reply(request, { decision: 'complete_plan_nodes', planProgress: { basePlanRevision: state.planRevision,
        nodes: [{ id: node.id, actionRefs: node.requiredActions, evidenceRefs }] } })
    }
    if (round === 2 || round === 6) {
      assert.equal(phase(request), round === 2 ? 'investigation' : 'verification')
      assert.ok(names.has('stage_read')); assert.ok(!names.has('stage_write')); assert.ok(!names.has('run_skill_script'))
      assert.doesNotMatch(request.messages[0]!.content, /apply_system_variable_changes|^- stage_write:/m)
      assert.ok(request.messages.every(message => message.role !== 'assistant' || !message.content.includes('"decision":"propose_plan"')))
      return call('stage_read', round === 2 ? 'read' : 'verify')
    }
    if (round === 4) {
      assert.equal(phase(request), 'execution'); assert.ok(names.has('stage_write')); assert.ok(!names.has('stage_read'))
      return call('stage_write', 'write', { value: '验证后的结果' })
    }
    assert.equal(calls, 9)
    const output = request.messages.filter(message => message.role === 'tool' && message.name === 'stage_read').at(-1)!.content
    assert.ok(output.includes('验证后的结果'))
    return reply(request, { decision: 'finish', userMessage: '已写入并验证。', completionCheck: { taskId: binding(request).taskId, requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '三项真实动作已完成' } })
  })
  try {
    const done = f.wait('completed'); f.start(true); await done
    assert.equal(calls, 9); assert.equal(fs.readFileSync(path.join(f.root, 'output.txt'), 'utf8'), '验证后的结果')
    const state = f.loop.exportState()
    assert.equal(state.taskControl!.planRevision, 4)
    assert.equal(f.loop.getModelBudgetSummary()?.attempts, 9)
    assert.ok(state.taskControl!.tasks.every(node => node.status === 'completed'))
    assert.equal(state.snapshot.observations.items.filter(item => item.status === 'completed' && ['stage_read', 'stage_write'].includes(item.toolName ?? '')).length, 3)
    const requests = state.artifacts.filter(a => a.meta.kind === 'model-request')
    assert.equal(requests.length, 9)
    assert.ok(requests.every(a => (a.value as { capabilityProjection?: unknown }).capabilityProjection))
    const receipts = f.events.filter(e => e.type === 'tool.call.completed' && ['stage_read', 'stage_write'].includes(e.payload.toolName))
      .map(e => (e as Extract<ServerEvent, { type: 'tool.call.completed' }>).payload.receipt as unknown as { capabilityBinding: { phase: string; projectionId: string } })
    assert.deepEqual(receipts.map(r => r.capabilityBinding.phase), ['investigation', 'execution', 'verification'])
    assert.ok(receipts.every(r => r.capabilityBinding.projectionId.length === 64))
  } finally { f.close() }
})

test('an early finish and draft leave the accepted plan intact until its original node is verified', async () => {
  let calls = 0
  let earlyBinding: RuntimeRequestBinding
  const f = fixture(request => {
    const system = request.messages[0]!.content
    const state = JSON.parse(system.split('\n').find(line => line.startsWith('{"taskId":'))!)
    const schema = JSON.parse(system.split('\n').find(line => line.startsWith('{"type":"object","additionalProperties":false,"required":["envelopeVersion"'))!)
    if (++calls === 1) return reply(request, { decision: 'propose_plan', planProposal: { basePlanRevision: 0, goal: '写入结果', tasks: [{
      id: 'write', title: '写入结果', phase: 'execution', owner: 'parent', dependsOn: [], capabilityIds: ['stage_write'],
      completionConditions: ['完成写入'], requiredActions: [], evidenceRefs: [], status: 'pending',
    }] } })
    const current = binding(request)
    const completionCheck = { taskId: current.taskId, requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '' }
    assert.equal(state.execution.allowedDecisions.includes('finish'), calls === 7)
    assert.equal(schema.properties.decision.enum.includes('finish'), calls === 7)
    if (calls === 2) {
      earlyBinding = current
      assert.deepEqual(schema.properties.completionCheck, { type: 'null' })
      return reply(request, { decision: 'finish', completionCheck, userMessage: '过早汇报',
        uncertainties: [{ id: 'premature-note', statement: '未提交的过早汇报', blocking: false, relatedTaskIds: ['write'], evidenceRefs: [] }] })
    }
    if (calls === 3 || calls === 4) {
      assert.equal(current.runId, earlyBinding!.runId)
      assert.equal(current.taskId, earlyBinding!.taskId)
      assert.equal(current.stateRevision, earlyBinding!.stateRevision)
      assert.notEqual(current.requestId, earlyBinding!.requestId)
      assert.deepEqual(state.uncertainties, [])
      assert.ok(request.tools?.some(tool => tool.name === 'stage_write'))
      assert.match(request.messages.at(-1)!.content, /accepted plan still has work on active nodes \["write"\]/)
      assert.ok(!request.messages.some(message => message.content.includes('已经完成的草稿')))
      if (calls === 3) return { provider: 'custom', model: 'stage-test', raw: {}, text: '已经完成的草稿' }
      return call('stage_write', 'confirmed-write', { value: '实际交付' })
    }
    if (calls === 5 || calls === 6) {
      const planProgress = { basePlanRevision: state.planRevision, nodes: [{ id: 'write', actionRefs: ['call:confirmed-write'], evidenceRefs: [] }] }
      if (calls === 5) return reply(request, { decision: 'complete_plan_nodes', planProgress,
        uncertainties: [{ id: 'extra-note', statement: '应在其他控制轮登记', blocking: false, relatedTaskIds: ['write'], evidenceRefs: [] }] })
      assert.deepEqual(request.tools, [])
      assert.equal(state.tasks[0].status, 'pending')
      assert.deepEqual(state.uncertainties, [])
      assert.match(request.messages.at(-1)!.content, /RUNTIME_CONTROL_PAYLOAD_CONFLICT.*evidenceRequests: \[\] and uncertainties: \[\]/)
      return reply(request, { decision: 'complete_plan_nodes', planProgress })
    }
    assert.equal(calls, 7)
    return reply(request, { decision: 'finish', completionCheck: { ...completionCheck, requiredActions: ['call:confirmed-write'] }, userMessage: '已写入。' })
  })
  try {
    const done = f.wait('completed'); f.start(true); await done
    assert.equal(calls, 7)
    assert.equal(fs.readFileSync(path.join(f.root, 'output.txt'), 'utf8'), '实际交付')
    assert.equal(f.loop.exportState().taskControl!.tasks[0]!.status, 'completed')
    assert.equal(f.events.filter(event => event.type === 'tool.call.completed' && event.payload.toolName === 'stage_write').length, 1)
  } finally { f.close() }
})

test('a plan amendment activates an added prerequisite and preserves the earlier read receipt', async () => {
  const read: RuntimePlanTask = { id: 'read', title: '读取来源', phase: 'investigation', owner: 'parent', dependsOn: [],
    capabilityIds: ['stage:stage_read'], completionConditions: ['原件已读'], requiredActions: [], evidenceRefs: [], status: 'pending' }
  const verify: RuntimePlanTask = { ...read, id: 'verify', title: '核对交付', phase: 'verification', dependsOn: ['read'], completionConditions: ['写入结果已复核'] }
  let calls = 0
  const f = fixture(request => {
    calls++
    const system = request.messages[0]!.content
    const state = JSON.parse(system.split('\n').find(line => line.startsWith('{"taskId":'))!)
    const progress = (id: string, ref: string) => ({ decision: 'complete_plan_nodes' as const,
      planProgress: { basePlanRevision: state.planRevision, nodes: [{ id, actionRefs: [ref], evidenceRefs: [] }] } })
    if (calls === 1) {
      assert.doesNotMatch(system, /"planAmendment":/)
      return reply(request, { decision: 'propose_plan', planProposal: { basePlanRevision: 0, goal: '生成并核对结果', tasks: [read, verify] } })
    }
    if (calls === 2) return call('stage_read', 'original-source')
    if (calls === 3) return reply(request, progress('read', 'call:original-source'))
    if (calls === 4) {
      assert.match(system, /"planAmendment":/)
      assert.deepEqual(state.execution.activeTaskIds, ['verify'])
      return reply(request, { decision: 'propose_plan', planAmendment: { basePlanRevision: state.planRevision,
        addTasks: [{ id: 'write', title: '写入结果', owner: 'parent', phase: 'execution', dependsOn: ['read'],
          capabilityIds: ['stage:stage_write'], completionConditions: ['实际写入结果'] }],
        updateTasks: [{ id: 'verify', addDependsOn: ['write'] }] } })
    }
    assert.deepEqual(state.tasks[0], { ...read, status: 'completed', requiredActions: ['call:original-source'] })
    if (calls === 5) {
      assert.deepEqual(state.execution.activeTaskIds, ['write'])
      assert.ok(request.tools?.some(tool => tool.name === 'stage_write'))
      return call('stage_write', 'confirmed-prerequisite', { value: '更新后的交付' })
    }
    if (calls === 6) return reply(request, progress('write', 'call:confirmed-prerequisite'))
    if (calls === 7) {
      assert.deepEqual(state.execution.activeTaskIds, ['verify'])
      return call('stage_read', 'confirmed-review')
    }
    if (calls === 8) return reply(request, progress('verify', 'call:confirmed-review'))
    return reply(request, { decision: 'finish', userMessage: '结果已写入并核对。', completionCheck: { taskId: binding(request).taskId,
      requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '完成写入和复核' } })
  })
  try {
    const completed = f.wait('completed'); f.start(true); await completed
    assert.equal(calls, 9)
    assert.equal(fs.readFileSync(path.join(f.root, 'output.txt'), 'utf8'), '更新后的交付')
    assert.deepEqual(f.events.flatMap(event => event.type === 'tool.call.started' ? [event.payload.callId] : []),
      ['original-source', 'confirmed-prerequisite', 'confirmed-review'])
  } finally { f.close() }
})

test('a project model limit stops the next round before dispatch and restores the spent budget', async () => {
  let calls = 0
  const f = fixture(request => {
    calls++
    assert.ok(request.tools?.some(tool => tool.name === 'stage_read'))
    return call('stage_read', 'read-before-budget-stop')
  })
  let restored: RuntimeLoop | undefined
  try {
    const settings = JSON.parse(fs.readFileSync(f.configFile, 'utf8'))
    settings.context = { ...settings.context, max_model_attempts: 1 }
    fs.writeFileSync(f.configFile, JSON.stringify(settings))
    // Use the saved project setting before the first request instead of waiting for a file watcher.
    const initial = f.loop.exportState()
    f.loop.close()
    restored = new RuntimeLoop({ projectDir: f.root, sessionId: 'stage-session', llm: f.llm, stepDelayMs: 0, streamDelayMs: 0,
      initialState: initial, contextOrganization: { minGroups: 100 } })
    const stopped = f.wait('failed', restored)
    f.send('chat.message.send', { clientMessageId: 'budget-test', content: [{ type: 'text', text: '读取来源并返回。' }], autoStart: true }, restored)
    await stopped
    const state = restored.exportState()
    assert.equal(calls, 1)
    assert.equal(state.snapshot.run.failure?.code, 'RUNTIME_MODEL_BUDGET_EXHAUSTED')
    assert.ok(state.snapshot.observations.items.some(item => item.toolName === 'stage_read' && item.status === 'completed'))
    const budget = restored.getModelBudgetSummary()
    assert.equal(budget?.remainingAttempts, 0)
    restored.close()
    restored = new RuntimeLoop({ projectDir: f.root, sessionId: 'stage-session', llm: f.llm, initialState: state })
    assert.deepEqual(restored.getModelBudgetSummary(), budget)
  } finally { restored?.close(); f.close() }
})

test('a bound branch question leaves independent work runnable and is answered on the same run after reconnect', async () => {
  const nodes: RuntimePlanTask[] = [
    { id: 'input', title: '核对人类确认的来源', phase: 'investigation', owner: 'parent', dependsOn: [],
      capabilityIds: ['stage:stage_read'], completionConditions: ['读到确认后的来源'], requiredActions: ['call:branch-read'], evidenceRefs: [], status: 'pending' },
    { id: 'prepare', title: '预先写入独立结果', phase: 'execution', owner: 'parent', dependsOn: [],
      capabilityIds: ['stage:stage_write'], completionConditions: ['写出独立结果'], requiredActions: ['call:branch-write'], evidenceRefs: [], status: 'pending' },
  ]
  const plan = (request: LlmChatRequest, basePlanRevision: number) => reply(request, {
    decision: 'propose_plan', planProposal: { basePlanRevision, goal: '核对来源并完成独立准备', tasks: nodes.map(node => node.status === 'pending' ? { ...node, requiredActions: [] } : node) },
  })
  let calls = 0, humanAction: string, questionId: string
  const f = fixture(request => {
    calls++
    const round = calls > 4 ? calls - 2 : calls
    const names = request.tools?.map(tool => tool.name)
    if (calls === 1) return plan(request, 0)
    if (calls === 2) {
      assert.equal(phase(request), 'investigation')
      return reply(request, { decision: 'ask_user', userMessage: '请确认读取的来源。', actions: [{ kind: 'ask_user', question: '请确认读取的来源。', blockingTaskIds: ['input'] }] })
    }
    if (calls === 3) {
      const system = request.messages[0]!.content
      const schema = JSON.parse(system.split('\n').find(line => line.startsWith('{"type":"object"'))!)
      assert.deepEqual(schema.properties.actions.items.properties.blockingTaskIds.items.enum, [binding(request).taskId, 'prepare'])
      questionId = f.loop.exportState().taskControl!.branchBlocks![0]!.id
      return reply(request, { decision: 'ask_user', userMessage: '请再次确认读取的来源。',
        actions: [{ kind: 'ask_user', question: '请再次确认读取的来源。', blockingTaskIds: [binding(request).taskId, 'prepare'] }] })
    }
    if (calls === 4) {
      assert.match(request.messages.at(-1)!.content, /RUNTIME_BRANCH_SCOPE_MIXED.*independent active nodes \["prepare"\]/)
      assert.equal(f.loop.exportState().taskControl!.branchBlocks![0]!.id, questionId!)
      return reply(request, { decision: 'ask_user', userMessage: '请再次确认读取的来源。',
        actions: [{ kind: 'ask_user', question: '请再次确认读取的来源。', blockingTaskIds: ['input'] }] })
    }
    if (round === 3) {
      assert.equal(phase(request), 'execution')
      assert.ok(names?.includes('stage_write'))
      assert.ok(!names?.includes('stage_read'))
      const repair = request.messages.at(-1)!.content
      assert.match(repair, /RUNTIME_BRANCH_NOT_ACTIVE/)
      assert.ok(repair.includes(questionId))
      assert.match(repair, /independent active nodes \["prepare"\]/)
      return call('stage_write', 'branch-write', { value: '独立分支已执行' })
    }
    if (round === 4) { nodes[1]!.status = 'completed'; return plan(request, 1) }
    if (round === 5) {
      assert.equal(phase(request), 'investigation')
      assert.ok(names?.includes('stage_read'))
      assert.ok(!names?.includes('stage_write'))
      assert.ok(request.messages.some(message => message.content.includes('确认读取现有结果')))
      const runtime = JSON.parse(request.messages[0]!.content.split('\n').find(line => line.startsWith('{"taskId":'))!)
      const humanReply = runtime.branchHumanReplies[0]
      assert.deepEqual(humanReply.taskIds, ['input'])
      assert.equal(humanReply.replyMessageId, 'answer-branch')
      humanAction = humanReply.completionActionRef
      assert.equal(humanAction, `human:${humanReply.requestId}`)
      assert.ok(runtime.completionActionRefs.includes(humanAction))
      return reply(request, { decision: 'propose_plan', planProposal: { basePlanRevision: 2, goal: '核对来源并完成独立准备',
        tasks: [{ ...nodes[0]!, requiredActions: [] }, { ...nodes[1]!, requiredActions: ['call:branch-write', humanAction] }] } })
    }
    if (round === 6) {
      assert.match(request.messages.at(-1)!.content, /RUNTIME_PLAN_ACTION_UNBOUND/)
      assert.ok(request.messages.at(-1)!.content.includes(`Remove "${humanAction}" from the actions of "prepare". That receipt belongs to ["input"].`))
      return call('stage_read', 'branch-read')
    }
    if (round === 7) {
      nodes[0]!.status = 'completed'
      nodes[0]!.requiredActions.push(humanAction)
      return plan(request, 2)
    }
    assert.equal(calls, 10)
    return reply(request, { decision: 'finish', userMessage: '两个分支均完成。', completionCheck: {
      taskId: binding(request).taskId, requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '两个工具回执均已核对',
    } })
  })
  let restored: RuntimeLoop | undefined
  try {
    const blocked = f.wait('paused'); f.start(true); await blocked
    assert.equal(calls, 6)
    assert.equal(fs.readFileSync(path.join(f.root, 'output.txt'), 'utf8'), '独立分支已执行')
    const saved = f.loop.exportState()
    const question = saved.taskControl!.branchBlocks![0]!
    assert.equal(saved.taskControl!.branchBlocks!.length, 1)
    assert.equal(question.id, questionId!)
    assert.equal(question.reason, '请确认读取的来源。')
    assert.deepEqual(question.taskIds, ['input'])
    assert.equal(question.kind, 'human')
    const scope = { taskId: saved.taskControl!.taskId, runId: saved.snapshot.run.runId }
    assert.throws(() => f.send('runtime.wait.signal', { ...scope, id: 'fake-reply', signalType: 'user',
      eventType: 'capybara.human.reply', correlationId: question.id }), /WAIT_SIGNAL_RESERVED_EVENT/)
    assert.throws(() => f.send('run.resume', {}), /WAIT_PENDING/)
    f.loop.close()
    restored = new RuntimeLoop({ projectDir: f.root, sessionId: 'stage-session', llm: f.llm, initialState: saved,
      stepDelayMs: 0, streamDelayMs: 0, contextOrganization: { minGroups: 100 } })
    const payload = { clientMessageId: 'answer-branch', content: [{ type: 'text', text: '确认读取现有结果' }], autoStart: true }
    assert.throws(() => f.send('chat.message.send', { ...payload, humanRequestId: 'wrong-branch' }, restored), /HUMAN_REQUEST_MISMATCH/)
    const done = f.wait('completed', restored)
    f.send('chat.message.send', { ...payload, humanRequestId: question.id }, restored)
    assert.throws(() => f.send('chat.message.send', { ...payload, clientMessageId: 'duplicate-branch', humanRequestId: question.id }, restored), /HUMAN_REQUEST_MISMATCH/)
    await done
    const state = restored.exportState()
    assert.equal(state.snapshot.run.runId, scope.runId)
    assert.equal(state.snapshot.conversation.messages.filter(message => message.id === payload.clientMessageId).length, 1)
    assert.ok(!state.taskControl!.branchBlocks?.length)
    assert.ok(state.taskControl!.tasks.every(task => task.status === 'completed'))
    assert.ok(state.taskControl!.tasks[0]!.requiredActions.includes(`human:${question.id}`))
    assert.ok(state.taskControl!.tasks[1]!.requiredActions.every(ref => !ref.startsWith('human:')))
  } finally { restored?.close(); f.close() }
})

test('a human-input phase keeps tools on the independent branch and resumes with the original reply receipt', async () => {
  let calls = 0
  const authorize: RuntimePlanTask = { id: 'authorize', title: '确认只读报告授权', phase: 'human_input', dependsOn: [], owner: 'parent',
    capabilityIds: [], completionConditions: ['收到用户明确答复'], requiredActions: [], evidenceRefs: [], status: 'pending' }
  const lookup: RuntimePlanTask = { id: 'lookup', title: '独立核对原件', phase: 'investigation', dependsOn: [], owner: 'parent',
    capabilityIds: ['stage:stage_read'], completionConditions: ['核对原件读取回执'], requiredActions: [], evidenceRefs: [], status: 'pending' }
  const lookedUp: RuntimePlanTask = { ...lookup, status: 'completed', requiredActions: ['call:auth-parallel-read'] }
  const plan = (request: LlmChatRequest, basePlanRevision: number, tasks: RuntimePlanTask[]) => reply(request, {
    decision: 'propose_plan', planProposal: { basePlanRevision, goal: '核对来源并在授权后汇报', tasks },
  })
  const f = fixture(request => {
    switch (++calls) {
      case 1: return plan(request, 0, [authorize, lookup])
      case 2:
        assert.equal(phase(request), 'human_input')
        assert.deepEqual(request.tools, [])
        assert.equal(request.responseFormat, 'json')
        return ask(request, '请确认是否只读汇报。')
      case 3:
        assert.match(request.messages.at(-1)!.content, /RUNTIME_HUMAN_INPUT_SCOPE/)
        assert.deepEqual(request.tools, [])
        return reply(request, { decision: 'ask_user', userMessage: '请确认是否只读汇报。',
          actions: [{ kind: 'ask_user', question: '请确认是否只读汇报。', blockingTaskIds: ['authorize'] }] })
      case 4:
        assert.equal(phase(request), 'investigation')
        assert.ok(request.tools?.some(tool => tool.name === 'stage_read'))
        return call('stage_read', 'auth-parallel-read')
      case 5: {
        const state = JSON.parse(request.messages[0]!.content.split('\n').find(line => line.startsWith('{"taskId":'))!)
        return reply(request, { decision: 'wait', waitSpec: { signalType: 'user', reason: '等已登记的授权',
          correlationIds: [state.branchBlocks[0].id], condition: { eventType: 'capybara.human.reply' }, deadlineRef: null, blockingTaskIds: ['authorize'] } })
      }
      case 6:
        assert.match(request.messages.at(-1)!.content, /WAIT_SIGNAL_RESERVED_EVENT/)
        return plan(request, 1, [{ ...authorize, owner: 'user' }, lookedUp])
      case 7:
        assert.match(request.messages.at(-1)!.content, /RUNTIME_PLAN_BLOCKED_BRANCH_CHANGED/)
        assert.match(request.messages[0]!.content, /"planRevision":1/)
        return plan(request, 1, [authorize, lookedUp])
      case 8: {
        assert.equal(phase(request), 'human_input')
        assert.deepEqual(request.tools, [])
        const state = JSON.parse(request.messages[0]!.content.split('\n').find(line => line.startsWith('{"taskId":'))!)
        const response = state.branchHumanReplies[0]
        assert.equal(response.replyMessageId, 'authorized-only-report')
        assert.deepEqual(response.taskIds, ['authorize'])
        return plan(request, 2, [{ ...authorize, status: 'completed', requiredActions: [response.completionActionRef] },
          { ...lookedUp, completionConditions: ['使用最新答复汇报'] }])
      }
      case 9: {
        assert.match(request.messages.at(-1)!.content, /RUNTIME_PLAN_OBLIGATION_REMOVED/)
        const state = JSON.parse(request.messages[0]!.content.split('\n').find(line => line.startsWith('{"taskId":'))!)
        assert.equal(state.planRevision, 2)
        assert.deepEqual(state.tasks[1].completionConditions, lookup.completionConditions)
        const response = state.branchHumanReplies[0]
        return plan(request, 1, [{ ...authorize, status: 'completed', requiredActions: [response.completionActionRef] }, lookedUp])
      }
      case 10: {
        assert.match(request.messages.at(-1)!.content, /RUNTIME_PLAN_REVISION_MISMATCH.*basePlanRevision 2/)
        const state = JSON.parse(request.messages[0]!.content.split('\n').find(line => line.startsWith('{"taskId":'))!)
        assert.equal(state.planRevision, 2)
        const response = state.branchHumanReplies[0]
        return plan(request, 2, [{ ...authorize, status: 'completed', requiredActions: [response.completionActionRef] }, lookedUp])
      }
      default:
        assert.equal(calls, 11)
        assert.equal(phase(request), 'verification')
        return reply(request, { decision: 'finish', userMessage: '已获准只读汇报并核对原件。', completionCheck: {
          taskId: binding(request).taskId, requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '原件和原回复已核对',
        } })
    }
  }, {}, (_root, config) => { config.max_tool_rounds = 12 })
  let restored: RuntimeLoop | undefined
  try {
    const paused = f.wait('paused'); f.start(true); await paused
    const checkpoint = f.loop.exportState(), request = checkpoint.taskControl!.branchBlocks![0]!
    assert.deepEqual(request.taskIds, ['authorize'])
    assert.equal(checkpoint.taskControl!.tasks[1]!.status, 'completed')
    assert.equal(checkpoint.taskControl!.tasks[0]!.owner, authorize.owner)
    f.loop.close()
    restored = new RuntimeLoop({ projectDir: f.root, sessionId: 'stage-session', llm: f.llm, initialState: checkpoint,
      stepDelayMs: 0, streamDelayMs: 0, contextOrganization: { minGroups: 100 } })
    const completed = f.wait('completed', restored)
    f.send('chat.message.send', { clientMessageId: 'authorized-only-report', content: [{ type: 'text', text: '同意只读汇报。' }],
      autoStart: true, humanRequestId: request.id }, restored)
    await completed
    const state = restored.exportState()
    assert.equal(state.snapshot.run.runId, checkpoint.snapshot.run.runId)
    assert.deepEqual(state.taskControl!.tasks[0]!.requiredActions, [`human:${request.id}`])
    assert.ok(state.taskControl!.tasks.every(task => task.status === 'completed'))
  } finally { restored?.close(); f.close() }
})

test('planning repairs a native control intent and a legacy response before registering a human request', async () => {
  let calls = 0
  const f = fixture(request => {
    assert.equal(phase(request), 'planning')
    assert.equal(binding(request).stateRevision, 0)
    if (++calls === 1) return reply(request, { decision: 'propose_plan', planProposal: { basePlanRevision: 0, goal: '查证材料',
      tasks: [{ id: binding(request).taskId, title: '使用根任务身份', dependsOn: [], completionConditions: ['已有材料'], owner: 'parent', capabilityIds: [],
        requiredActions: [], evidenceRefs: [], status: 'pending' }] } })
    if (calls === 2) {
      assert.match(request.messages.at(-1)!.content, /RUNTIME_PLAN_ROOT_ID_RESERVED.*distinct local ID/)
      return call('propose_plan', 'unprojected-plan', { planRevision: 900 })
    }
    if (calls === 3) {
      assert.match(request.messages.at(-1)!.content, /RUNTIME_CONTROL_TRANSPORT.*propose_plan.*ControlEnvelopeV2/)
      assert.ok(!JSON.stringify(request.messages).includes('unprojected-plan'))
      return { ...reply(request, {}), text: '{"status":"running","content":"等下一轮"}' }
    }
    assert.match(request.messages.at(-1)!.content, /Planned control requires ControlEnvelopeV2/)
    assert.ok(!request.messages.some(message => message.content === '{"status":"running","content":"等下一轮"}'))
    return ask(request, '请确认需要读取的材料。')
  })
  try {
    const paused = f.wait('paused'); f.start(true); await paused
    assert.equal(calls, 4)
    assert.equal(f.loop.exportState().contextControl?.question, '请确认需要读取的材料。')
  } finally { f.close() }
})

test('a blank JSON-mode control response gets a text-mode repair without granting native tools', async () => {
  let calls = 0
  let firstBinding: RuntimeRequestBinding
  const f = fixture(request => {
    assert.equal(phase(request), 'planning')
    assert.deepEqual(request.tools, [])
    if (++calls === 1) {
      assert.equal(request.responseFormat, 'json')
      firstBinding = binding(request)
      return { ...reply(request, {}), text: ' \n  \n ' }
    }
    assert.equal(calls, 2)
    assert.equal(request.responseFormat, 'text')
    assert.equal(binding(request).taskId, firstBinding.taskId)
    assert.equal(binding(request).stateRevision, firstBinding.stateRevision)
    assert.notEqual(binding(request).requestId, firstBinding.requestId)
    assert.match(request.messages.at(-1)!.content, /response was empty.*ControlEnvelopeV2/)
    assert.ok(!request.messages.some(message => message.role === 'assistant' && !message.content.trim()))
    return ask(request, '请确认应读取哪份材料。')
  })
  try {
    const paused = f.wait('paused'); f.start(true); await paused
    assert.equal(f.loop.exportState().contextControl?.question, '请确认应读取哪份材料。')
    assert.equal(f.loop.exportState().taskControl?.planRevision, 0)
  } finally { f.close() }
})

test('a transport-only field is rejected and removed on the next bound planning response', async () => {
  let calls = 0
  const f = fixture(request => {
    const question = ask(request, '请确认应读取哪份材料。')
    assert.deepEqual(request.tools, [])
    assert.equal(request.responseFormat, 'json')
    if (++calls === 1) return { ...question, text: JSON.stringify({ type: 'json_object', ...JSON.parse(question.text) }) }
    assert.match(request.messages.at(-1)!.content, /RUNTIME_CONTROL_UNKNOWN_FIELD.*Remove unrecognized top-level fields \["type"\]/)
    return question
  })
  try {
    const paused = f.wait('paused'); f.start(true); await paused
    assert.equal(calls, 2)
    assert.equal(f.loop.exportState().contextControl?.question, '请确认应读取哪份材料。')
    assert.equal(f.loop.exportState().taskControl?.planRevision, 0)
  } finally { f.close() }
})

test('a plain draft answer keeps the original result and requires a verified finish in a control-only round', async () => {
  const draft = '材料要求先核对来源，核对结果为真实来源。'
  let calls = 0
  const f = fixture(request => {
    calls++
    if (calls === 1) return call('stage_read', 'proof-read', {})
    if (calls === 2) {
      assert.ok(request.tools?.length)
      return { ...reply(request, {}), text: draft }
    }
    assert.equal(calls, 3)
    assert.equal(request.responseFormat, 'text')
    assert.deepEqual(request.tools, [])
    assert.ok(request.messages.some(message => message.role === 'assistant' && message.content === draft))
    assert.ok(request.messages.some(message => message.role === 'tool' && message.toolCallId === 'proof-read'))
    assert.match(request.messages.at(-1)!.content, /draft answer.*verification|draft answer.*visible evidence/)
    return reply(request, { decision: 'finish', userMessage: draft, completionCheck: {
      taskId: binding(request).taskId, requiredActions: ['call:proof-read'], requiredEvidenceRefs: [],
      unresolvedUncertaintyIds: [], summary: '核对原读取回执',
    } })
  })
  try {
    const completed = f.wait('completed'); f.start(); await completed
    assert.equal(calls, 3)
    assert.equal(f.events.filter(event => event.type === 'tool.call.completed').length, 1)
  } finally { f.close() }
})

test('scoped evidence requests allow independent work and validate each bound user and external observation', async () => {
  const tasks: RuntimePlanTask[] = [
    { id: 'source', title: '核对来源', phase: 'investigation', owner: 'parent', dependsOn: [], capabilityIds: ['stage_read'],
      completionConditions: ['核对来源'], requiredActions: ['call:evidence-read'], evidenceRefs: [], status: 'pending' },
    { id: 'independent', title: '独立准备', phase: 'execution', owner: 'parent', dependsOn: [], capabilityIds: ['stage_write'],
      completionConditions: ['写入独立文件'], requiredActions: ['call:evidence-independent'], evidenceRefs: [], status: 'pending' },
  ]
  let calls = 0
  const f = fixture(request => {
    calls++
    if ([1, 4, 6].includes(calls)) {
      if (calls === 4) tasks[1]!.status = 'completed'
      if (calls === 6) tasks[0]!.status = 'completed'
      return reply(request, { decision: 'propose_plan', planProposal: { basePlanRevision: calls === 1 ? 0 : calls === 4 ? 1 : 2, goal: '分支补证据', tasks: tasks.map(node => node.status === 'pending' ? { ...node, requiredActions: [] } : node) } })
    }
    if (calls === 2) return reply(request, { evidenceRequests: [
      { id: 'human', relatedTaskIds: ['source'], question: '确认原件范围', sourceKinds: ['user'] },
      { id: 'remote', relatedTaskIds: ['source'], question: '等待来源服务的说明', sourceKinds: ['external'] },
    ] })
    if (calls === 3) {
      assert.equal(phase(request), 'execution')
      assert.ok(!request.tools?.some(tool => tool.name === 'stage_read'))
      return call('stage_write', 'evidence-independent', { value: '准备就绪' })
    }
    if (calls === 5) {
      assert.equal(phase(request), 'investigation')
      return call('stage_read', 'evidence-read')
    }
    assert.equal(calls, 7)
    return reply(request, { decision: 'finish', userMessage: '原件已核对。', completionCheck: {
      taskId: binding(request).taskId, summary: '核对实际来源', requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [],
    } })
  })
  let restored: RuntimeLoop | undefined
  try {
    const paused = f.wait('paused'); f.start(true); await paused
    assert.equal(calls, 4)
    assert.equal(fs.readFileSync(path.join(f.root, 'output.txt'), 'utf8'), '准备就绪')
    const saved = f.loop.exportState()
    const [human, external] = saved.taskControl!.branchBlocks!
    assert.ok(human && external)
    assert.equal(human.evidenceRequest?.id, 'human')
    assert.deepEqual(external.taskIds, ['source'])
    f.loop.close()
    restored = new RuntimeLoop({ projectDir: f.root, sessionId: 'stage-session', llm: f.llm, initialState: saved,
      stepDelayMs: 0, streamDelayMs: 0, contextOrganization: { minGroups: 100 } })
    const current = restored
    const base = { taskId: saved.taskControl!.taskId, runId: saved.snapshot.run.runId!, signalType: 'external', id: 'publisher-1',
      eventType: 'evidence.available', data: { sourceId: 'external-record-47', text: '来源方声明交付范围另需核对' } } as const
    assert.throws(() => current.publishWaitSignal({ ...base, correlationId: human.id }), /BRANCH_EVIDENCE_SOURCE_MISMATCH/)
    assert.throws(() => current.publishWaitSignal({ ...base, correlationId: external.id, eventType: 'capybara.evidence.observed' }), /WAIT_SIGNAL_RESERVED_EVENT/)
    assert.throws(() => f.send('runtime.wait.cancel', { waitId: human.id, reason: '跳过补证据' }, current), /HUMAN_REQUEST_REQUIRES_BOUND_REPLY/)
    const partial = new Promise<void>((resolve, reject) => {
      const off = current.onEvent(event => {
        if (event.type === 'runtime.snapshot' && event.payload.taskControl?.branchBlocks?.length === 1) {
          clearTimeout(timer); off(); resolve()
        }
      })
      const timer = setTimeout(() => { off(); reject(new Error('partial evidence state not published')) }, 5000)
    })
    f.send('chat.message.send', { clientMessageId: 'evidence-user', content: [{ type: 'text', text: '用户确认限定原件范围' }], autoStart: true, humanRequestId: human.id }, current)
    await partial
    assert.equal(current.getSnapshot(0).run.status, 'paused')
    assert.equal(calls, 4)
    assert.equal(current.getSnapshot(0).taskControl!.branchBlocks![0]!.id, external.id)
    const done = f.wait('completed', current)
    current.publishWaitSignal({ ...base, correlationId: external.id })
    current.publishWaitSignal({ ...base, correlationId: external.id })
    await done
    const end = current.exportState()
    assert.equal(end.snapshot.run.runId, base.runId)
    assert.equal(end.contextDocument!.information.length, 0)
    for (const text of ['用户确认限定原件范围', '来源方声明交付范围另需核对']) {
      assert.ok(end.contextDocument!.candidates.some(candidate => candidate.status === 'pending' && candidate.normalizedContent.includes(text)))
    }
    assert.equal(end.artifacts.filter(artifact => (artifact.value as { kind?: string } | null)?.kind === 'branch-evidence-receipt').length, 2)
  } finally { restored?.close(); f.close() }
})

test('scoped tool evidence limits the collection round and rejects an invented observation', async () => {
  const node: RuntimePlanTask = { id: 'verify', title: '独立证据', phase: 'execution', owner: 'parent', dependsOn: [], capabilityIds: ['stage_read', 'stage_write'],
    completionConditions: ['读取可核验来源'], requiredActions: ['call:real-evidence-read'], evidenceRefs: [], status: 'pending' }
  let calls = 0
  const f = fixture(request => {
    calls++
    if (calls === 1 || calls === 6) return reply(request, { decision: 'propose_plan', planProposal: {
      basePlanRevision: calls === 1 ? 0 : 1, goal: '核对真实工具材料', tasks: [{ ...node, requiredActions: calls === 1 ? [] : node.requiredActions, status: calls === 1 ? 'pending' : 'completed' }],
    } })
    if (calls === 2) return reply(request, { evidenceRequests: [{ id: 'check-file', question: '核对文件原件', sourceKinds: ['tool'], relatedTaskIds: ['verify'] }] })
    if (calls <= 5) {
      assert.equal(phase(request), 'evidence')
      assert.ok(request.tools?.some(tool => tool.name === 'stage_read'))
      assert.ok(!request.tools?.some(tool => tool.name === 'stage_write'))
      const state = f.loop.exportState()
      const block = state.taskControl!.branchBlocks![0]!
      if (calls === 4) {
        assert.match(request.messages.at(-1)!.content, /BRANCH_TOOL_EVIDENCE_UNVERIFIED/)
        return call('stage_read', 'real-evidence-read')
      }
      const source = calls === 3 ? 'invented-observation' : state.snapshot.observations.items.find(item => item.callId === 'real-evidence-read')!.id
      const candidate = state.contextDocument!.candidates.find(item => item.source.sourceId === source)!
      assert.ok(candidate)
      return call('submit_branch_evidence', calls === 3 ? 'forged' : 'accepted-source', { request_id: block.id, candidate_id: candidate.id })
    }
    return reply(request, { decision: 'finish', userMessage: '真实原件已核对。', completionCheck: {
      taskId: binding(request).taskId, summary: '只有真实文件观察', requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [],
    } })
  })
  try {
    f.send('runtime.context.v2.observe', { observation: { candidate: {
      source: { actor: 'tool', sourceId: 'invented-observation', capturedAt: new Date().toISOString() },
      rawArtifactId: 'invented-original', normalizedContent: '伪造工具输出',
    } } })
    const completed = f.wait('completed'); f.start(true); await completed
    const end = f.loop.exportState()
    assert.equal(calls, 7)
    assert.equal(end.snapshot.observations.items.find(item => item.callId === 'forged')?.status, 'failed')
    assert.ok(end.artifacts.some(artifact => (artifact.value as { kind?: string; sourceKind?: string } | null)?.kind === 'branch-evidence-receipt'))
    assert.ok(!fs.existsSync(path.join(f.root, 'output.txt')))
  } finally { f.close() }
})

test('settlement of one scoped wait runs only its unlocked branch while another wait stays pending', async () => {
  const nodes: RuntimePlanTask[] = [
    { id: 'first', title: '等待外部来源', phase: 'investigation', owner: 'parent', dependsOn: [], capabilityIds: ['stage:stage_read'],
      completionConditions: ['核对外部来源'], requiredActions: ['call:first-read'], evidenceRefs: [], status: 'pending' },
    { id: 'second', title: '等待独立写入指示', phase: 'execution', owner: 'parent', dependsOn: [], capabilityIds: ['stage:stage_write'],
      completionConditions: ['写入授权结果'], requiredActions: ['call:second-write'], evidenceRefs: [], status: 'pending' },
  ]
  let calls = 0
  const f = fixture(request => {
    calls++
    if ([1, 5, 7].includes(calls)) {
      if (calls === 5) nodes[0]!.status = 'completed'
      if (calls === 7) nodes[1]!.status = 'completed'
      return reply(request, { decision: 'propose_plan', planProposal: { basePlanRevision: calls === 1 ? 0 : calls === 5 ? 1 : 2, goal: '跟踪独立信号', tasks: nodes.map(node => node.status === 'pending' ? { ...node, requiredActions: [] } : node) } })
    }
    if (calls === 2 || calls === 3) {
      const id = calls === 2 ? 'first' : 'second'
      assert.equal(phase(request), calls === 2 ? 'investigation' : 'execution')
      return reply(request, { decision: 'wait', waitSpec: { reason: '等待对应外部结果', signalType: 'external',
        correlationIds: [id], condition: { eventType: 'ready' }, deadlineRef: null, blockingTaskIds: [id] } })
    }
    if (calls === 4) {
      assert.equal(phase(request), 'investigation')
      assert.ok(!request.tools?.some(tool => tool.name === 'stage_write'))
      return call('stage_read', 'first-read')
    }
    if (calls === 6) {
      assert.equal(phase(request), 'execution')
      return call('stage_write', 'second-write', { value: '第二个真实信号已核对' })
    }
    assert.equal(calls, 8)
    return reply(request, { decision: 'finish', userMessage: '两个分支均完成。', completionCheck: {
      taskId: binding(request).taskId, requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '两个独立回执均完成',
    } })
  })
  try {
    const blocked = f.wait('paused'); f.start(true); await blocked
    const snapshot = f.loop.getSnapshot(0)
    assert.deepEqual(snapshot.taskControl!.branchBlocks!.map(block => block.taskIds), [['first'], ['second']])
    const signal = (id: string) => f.loop.publishWaitSignal({ id: `external-${id}`, correlationId: id, signalType: 'external',
      taskId: snapshot.taskControl!.taskId, runId: snapshot.run.runId!, eventType: 'ready' })
    const partial = f.wait('paused'); signal('first'); await partial
    assert.equal(calls, 5)
    const state = f.loop.getSnapshot(0)
    assert.deepEqual(state.taskControl!.branchBlocks!.map(block => block.taskIds), [['second']])
    assert.equal(state.taskControl!.tasks[0]!.status, 'completed')
    assert.ok(!fs.existsSync(path.join(f.root, 'output.txt')))
    const done = f.wait('completed'); signal('second'); await done
    assert.equal(fs.readFileSync(path.join(f.root, 'output.txt'), 'utf8'), '第二个真实信号已核对')
  } finally { f.close() }
})

test('the model can request an independent planning round, whose human question remains visible', async () => {
  let calls = 0
  const f = fixture(request => {
    calls++
    if (calls <= 2) {
      const planning = call('request_planning', 'need-plan', { reason: '多步骤任务需要先澄清输入' })
      if (calls === 1) {
        planning.toolCalls!.push({ id: 'mixed-read', name: 'stage_read', arguments: {} })
        return planning
      }
      assert.match(request.messages.at(-1)!.content, /RUNTIME_PLANNING_CALL_MUST_BE_EXCLUSIVE/)
      return planning
    }
    assert.equal(phase(request), 'planning'); assert.deepEqual(request.tools, [])
    return reply(request, { decision: 'ask_user', userMessage: '本次使用哪份来源？', actions: [{ kind: 'ask_user', question: '本次使用哪份来源？', blockingTaskIds: [binding(request).taskId] }] })
  })
  try {
    const done = f.wait('paused'); f.start(); await done
    assert.equal(calls, 3); assert.equal(f.loop.exportState().taskControl!.planning!.required, true)
    assert.ok(!f.events.some(event => event.type === 'tool.call.started' && event.payload.callId === 'mixed-read'))
    assert.ok(f.loop.exportState().snapshot.conversation.messages.some(message => message.role === 'assistant' && message.content.some(part => part.text === '本次使用哪份来源？')))
    assert.equal(fs.existsSync(path.join(f.root, 'output.txt')), false)
  } finally { f.close() }
})

test('an independent review resumes the accepted plan and preserves its original investigation receipt', async () => {
  const node: RuntimePlanTask = { id: 'read', title: '核对来源', owner: 'parent', phase: 'investigation', dependsOn: [],
    capabilityIds: ['stage:stage_read'], completionConditions: ['读取真实来源'], requiredActions: [], evidenceRefs: [], status: 'pending' }
  let calls = 0
  let reviewRevision = 0
  const f = fixture(request => {
    calls++
    const state = JSON.parse(request.messages[0]!.content.split('\n').find(line => line.startsWith('{"taskId":'))!)
    if (calls === 1) {
      assert.equal(phase(request), 'planning')
      assert.ok(!state.execution.allowedDecisions.includes('resume_plan'))
      return reply(request, { decision: 'propose_plan', planProposal: { basePlanRevision: 0, goal: '核对来源', tasks: [node] } })
    }
    if (calls === 2) return call('stage_read', 'original-investigation')
    if (calls === 3) return call('request_planning', 'request-review', { reason: '核对计划是否需要变更' })
    if (calls === 4) {
      assert.equal(phase(request), 'planning')
      assert.deepEqual(request.tools, [])
      assert.ok(state.execution.allowedDecisions.includes('resume_plan'))
      assert.equal(state.planRevision, 1)
      assert.match(request.messages.at(-1)!.content, /Use resume_plan to return to its current work/)
      reviewRevision = binding(request).stateRevision
      return reply(request, { decision: 'resume_plan' })
    }
    if (calls === 5) {
      assert.equal(phase(request), 'investigation')
      assert.ok(!state.execution.allowedDecisions.includes('resume_plan'))
      assert.ok(request.tools?.some(tool => tool.name === 'stage_read'))
      assert.equal(binding(request).stateRevision, reviewRevision + 1)
      assert.equal(state.planRevision, 1)
      assert.deepEqual(state.tasks, [node])
      assert.ok(state.recentPlanActions.some((action: { completionActionRef: string }) => action.completionActionRef === 'call:original-investigation'))
      return call('request_planning', 'repeated-review', { reason: '再次审查同一批证据' })
    }
    if (calls === 6) {
      assert.equal(phase(request), 'investigation')
      assert.deepEqual(request.tools, [])
      assert.match(request.messages.at(-1)!.content, /RUNTIME_PLAN_ALREADY_REVIEWED.*complete_plan_nodes/)
      return reply(request, { decision: 'complete_plan_nodes', planProgress: { basePlanRevision: 1,
        nodes: [{ id: node.id, actionRefs: ['call:original-investigation'], evidenceRefs: [] }] } })
    }
    return reply(request, { decision: 'finish', userMessage: '来源已核对。', completionCheck: { taskId: binding(request).taskId,
      requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '来源已核对' } })
  })
  try {
    const done = f.wait('completed'); f.start(true); await done
    assert.equal(calls, 7)
    assert.equal(f.loop.exportState().taskControl!.planRevision, 2)
    assert.equal(f.events.filter(event => event.type === 'tool.call.started' && event.payload.toolName === 'stage_read').length, 1)
    assert.deepEqual(f.events.flatMap(event => event.type === 'tool.call.started' && event.payload.toolName === 'request_planning'
      ? [event.payload.callId] : []), ['request-review'])
  } finally { f.close() }
})

test('rejecting a later node keeps current stage tools available for unfinished work', async () => {
  const nodes: RuntimePlanTask[] = ['investigation', 'verification'].map((phase, index) => ({
    id: index === 0 ? 'read' : 'review', title: index === 0 ? '读取来源' : '核对来源', phase: phase as 'investigation' | 'verification',
    owner: 'parent', dependsOn: [], capabilityIds: ['stage:stage_read'], completionConditions: ['读取真实来源'],
    requiredActions: [], evidenceRefs: [], status: 'pending',
  }))
  let calls = 0
  const f = fixture(request => {
    calls++
    const state = JSON.parse(request.messages[0]!.content.split('\n').find(line => line.startsWith('{"taskId":'))!)
    if (calls === 1) return reply(request, { decision: 'propose_plan', planProposal: { basePlanRevision: 0, goal: '读取并核对来源', tasks: nodes } })
    const progress = (id: string, actionRefs: string[]) => ({ basePlanRevision: state.planRevision, nodes: [{ id, actionRefs, evidenceRefs: [] }] })
    if (calls >= 2 && calls <= 4) {
      assert.deepEqual(state.execution.readyTaskIds, ['read', 'review'])
      assert.deepEqual(state.execution.activeTaskIds, ['read'])
      assert.ok(request.tools?.some(tool => tool.name === 'stage_read'))
      assert.deepEqual(state.tasks, nodes)
      if (calls > 2) assert.match(request.messages.at(-1)!.content, /RUNTIME_PLAN_PROGRESS_NODE_INACTIVE.*active investigation nodes.*"read"/)
    }
    if (calls === 2) return call('complete_plan_nodes', 'premature-native-review', progress('review', []))
    if (calls === 3) return reply(request, { decision: 'complete_plan_nodes', planProgress: progress('review', []) })
    if (calls === 4) return call('stage_read', 'actual-read')
    if (calls === 5) return reply(request, { decision: 'complete_plan_nodes', planProgress: progress('read', ['call:actual-read']) })
    if (calls === 6) {
      assert.deepEqual(state.execution.activeTaskIds, ['review'])
      return call('stage_read', 'actual-review')
    }
    if (calls === 7) return reply(request, { decision: 'complete_plan_nodes', planProgress: progress('review', ['call:actual-review']) })
    return reply(request, { decision: 'finish', userMessage: '来源已核对。', completionCheck: { taskId: binding(request).taskId,
      requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '来源已核对' } })
  })
  try {
    const done = f.wait('completed'); f.start(true); await done
    assert.equal(calls, 8)
    assert.deepEqual(f.events.flatMap(event => event.type === 'tool.call.started' ? [event.payload.callId] : []), ['actual-read', 'actual-review'])
    assert.ok(f.loop.exportState().taskControl!.tasks.every(node => node.status === 'completed'))
  } finally { f.close() }
})

test('resource discovery reports registered child tools without projecting a later phase', async () => {
  const node = (id: string, phase: 'investigation' | 'execution', capabilityIds: string[], dependsOn: string[]): RuntimePlanTask => ({
    id, title: id, phase, capabilityIds, dependsOn, owner: 'parent', status: 'pending',
    completionConditions: ['核对该阶段的来源'], requiredActions: [], evidenceRefs: [],
  })
  let calls = 0
  const f = fixture(request => {
    switch (++calls) {
      case 1:
        return reply(request, { decision: 'propose_plan', planProposal: { basePlanRevision: 0, goal: '分阶段核对资源', tasks: [
          node('read', 'investigation', ['stage:stage_read'], []), node('delegate', 'execution', ['runtime:delegate_task'], ['read']),
        ] } })
      case 2:
        assert.equal(phase(request), 'investigation')
        assert.ok(!request.tools?.some(tool => tool.name === 'delegate_task'))
        return call('search_resources', 'discover-later-tools', { query: 'runtime:delegate_task read_child_result stage:stage_read', kinds: ['tool'] })
      case 3: {
        const search = JSON.parse(request.messages.find(message => message.toolCallId === 'discover-later-tools')!.content)
        assert.equal(search.ok, true)
        const status = Object.fromEntries(search.result.results.map((item: { id: string; status: string }) => [item.id, item.status]))
        assert.equal(status['runtime:delegate_task'], 'outside_current_projection')
        assert.equal(status['runtime:read_child_result'], 'child_state_required')
        assert.equal(status['stage:stage_read'], 'projected')
        assert.ok(!request.tools?.some(tool => tool.name === 'delegate_task'))
        return call('stage_read', 'checked-source')
      }
      case 4:
        return reply(request, { decision: 'complete_plan_nodes', planProgress: { basePlanRevision: 1,
          nodes: [{ id: 'read', actionRefs: ['call:checked-source'], evidenceRefs: [] }] } })
      default:
        assert.equal(phase(request), 'execution')
        assert.ok(request.tools?.some(tool => tool.name === 'delegate_task'))
        assert.ok(!request.tools?.some(tool => tool.name === 'read_child_result'))
        return ask(request)
    }
  }, { childAgentEnabled: true })
  try {
    const done = f.wait('paused'); f.start(true); await done
    assert.equal(calls, 5)
    assert.ok(!f.events.some(event => event.type === 'tool.call.started' && event.payload.toolName === 'delegate_task'))
  } finally { f.close() }
})

for (const response of ['native-write', 'legacy-finish'] as const) test(`a required planning round rejects ${response} before execution`, async () => {
  const f = fixture(() => response === 'native-write' ? call('stage_write', 'forbidden', { value: '不得写入' }) : { provider: 'custom', model: 'stage-test', text: '{"status":"completed","content":"done"}', raw: {} }, { planningRequired: true })
  try {
    const done = f.wait('failed'); f.start(); await done
    assert.equal(fs.existsSync(path.join(f.root, 'output.txt')), false)
    assert.equal(f.loop.exportState().snapshot.run.failure!.code, response === 'native-write' ? 'RUNTIME_ENVELOPE_TOOL_UNAUTHORIZED' : 'RUNTIME_PHASE_DECISION_FORBIDDEN')
  } finally { f.close() }
})

test('a plan cannot invent an unregistered capability', async () => {
  let calls = 0
  const f = fixture(request => {
    if (++calls > 1) {
      assert.deepEqual(request.tools, [])
      assert.match(request.messages.at(-1)!.content, /RUNTIME_PLAN_CAPABILITY_UNKNOWN.*runtime:propose_diff.*capabilityIds: \[\]/)
    }
    return reply(request, { decision: 'propose_plan', planProposal: { basePlanRevision: 0, goal: '不可伪造能力', tasks: [{ id: 'unknown', title: '文档局部更新', phase: 'execution', owner: 'parent', dependsOn: [], capabilityIds: ['runtime:propose_diff'], completionConditions: ['会话文档提交局部更新'], requiredActions: [], evidenceRefs: [], status: 'pending' }] } })
  })
  try {
    const done = f.wait('failed'); f.start(true); await done
    assert.equal(f.loop.exportState().snapshot.run.failure!.code, 'RUNTIME_PLAN_CAPABILITY_UNKNOWN')
    assert.equal(f.loop.exportState().taskControl!.planRevision, 0)
    assert.equal(calls, 4)
    assert.ok(!f.events.some(event => event.type === 'tool.call.started'))
  } finally { f.close() }
})

test('a plan can repair an unknown capability by keeping the edit as a control decision', async () => {
  let calls = 0
  const f = fixture(request => {
    calls++
    if (calls === 3) {
      assert.equal(phase(request), 'execution')
      assert.ok(!request.tools?.some(tool => tool.name === 'propose_diff'))
      return ask(request, '请选择会话文档的目标章节。')
    }
    assert.equal(phase(request), 'planning')
    if (calls === 2) {
      assert.equal(request.responseFormat, 'text')
      assert.deepEqual(request.tools, [])
      assert.match(request.messages.at(-1)!.content, /RUNTIME_PLAN_CAPABILITY_UNKNOWN.*runtime:propose_diff/)
    }
    return reply(request, { decision: 'propose_plan', planProposal: { basePlanRevision: 0, goal: '补齐会话文档', tasks: [{
      id: 'edit', title: '补齐会话文档', phase: 'execution', owner: 'parent', dependsOn: [],
      capabilityIds: calls === 1 ? ['runtime:propose_diff'] : [], completionConditions: ['会话文档完成局部更新'],
      requiredActions: [], evidenceRefs: [], status: 'pending',
    }] } })
  })
  try {
    const paused = f.wait('paused'); f.start(true); await paused
    const state = f.loop.exportState().taskControl!
    assert.equal(calls, 3)
    assert.equal(state.planRevision, 1)
    assert.deepEqual(state.tasks.map(node => [node.id, node.capabilityIds]), [['edit', []]])
  } finally { f.close() }
})

test('a planning response with a wait payload is repaired in the original run', async () => {
  let calls = 0
  let firstBinding: RuntimeRequestBinding | undefined
  const f = fixture(request => {
    calls++
    if (calls === 3) {
      assert.equal(phase(request), 'execution')
      return ask(request, '请选择会话文档的目标章节。')
    }
    assert.equal(phase(request), 'planning')
    const current = binding(request)
    const planProposal: NonNullable<ControlEnvelopeV2['planProposal']> = { basePlanRevision: 0, goal: '补齐会话文档', tasks: [{
      id: 'edit', title: '补齐会话文档', phase: 'execution', owner: 'parent', dependsOn: [], capabilityIds: [],
      completionConditions: ['会话文档完成局部更新'], requiredActions: [], evidenceRefs: [], status: 'pending',
    }] }
    if (calls === 2) {
      assert.equal(request.responseFormat, 'text')
      assert.deepEqual(request.tools, [])
      assert.equal(current.runId, firstBinding?.runId)
      assert.notEqual(current.requestId, firstBinding?.requestId)
      assert.match(request.messages.at(-1)!.content, /RUNTIME_CONTROL_PAYLOAD_CONFLICT.*For propose_plan, set waitSpec to null/)
      assert.ok(request.messages.every(message => !message.content.includes('foreign-event')))
      return reply(request, { decision: 'propose_plan', planProposal })
    }
    firstBinding = current
    const mixed = reply(request, { decision: 'propose_plan', planProposal, waitSpec: {
      reason: '错误地混入等待', signalType: 'external', correlationIds: ['foreign-event'], condition: { eventType: 'ready' }, deadlineRef: null,
    } })
    assert.deepEqual(request.validateResponse?.(mixed), { recovery: 'runtime' })
    return mixed
  })
  try {
    const paused = f.wait('paused'); f.start(true); await paused
    const state = f.loop.exportState().taskControl!
    assert.equal(calls, 3)
    assert.equal(state.planRevision, 1)
    assert.equal(state.tasks[0]?.id, 'edit')
    assert.ok(!f.events.some(event => event.type === 'tool.call.started'))
  } finally { f.close() }
})

test('malformed transport for a sole control decision is repairable while native tool arguments fail closed', async () => {
  for (const attempt of [{ name: 'propose_plan', count: 1, recover: true },
    { name: 'propose_plan', count: 2, recover: false }, { name: 'stage_read', count: 1, recover: false }]) {
    let calls = 0
    const f = fixture(request => {
      if (++calls === 1) throw new LlmToolArgumentsError(attempt.name, '{bad', attempt.count)
      assert.equal(request.responseFormat, 'text')
      assert.deepEqual(request.tools, [])
      assert.match(request.messages.at(-1)!.content, /RUNTIME_CONTROL_TRANSPORT.*malformed arguments.*propose_plan/)
      assert.ok(request.messages.every(message => !message.content.includes('{bad')))
      return ask(request, '请选择目标章节。')
    })
    try {
      const done = f.wait(attempt.recover ? 'paused' : 'failed'); f.start(attempt.name === 'propose_plan'); await done
      assert.equal(calls, attempt.recover ? 2 : 1)
      if (!attempt.recover) assert.equal(f.loop.exportState().snapshot.run.failure?.code, 'MODEL_PROTOCOL_ERROR')
      assert.ok(!f.events.some(event => event.type === 'tool.call.started'))
    } finally { f.close() }
  }
})

test('a native response cannot use a task-state snapshot that advanced while the model was running', async () => {
  let f: ReturnType<typeof fixture>
  let calls = 0
  f = fixture(request => {
    if (++calls > 1) return ask(request)
    const state = (f.loop as unknown as { taskControl: { stateRevision: number } }).taskControl
    state.stateRevision++ // Simulate a trusted task-state event arriving during inference.
    return call('stage_write', 'stale-response', { value: '不能使用旧快照执行' })
  })
  try {
    const done = f.wait('paused'); f.start(); await done
    assert.equal(calls, 2)
    assert.ok(f.loop.exportState().artifacts.some(a => a.meta.kind === 'runtime-error' && (a.value as { code?: string }).code === 'RUNTIME_ENVELOPE_STATE_MISMATCH'))
    assert.equal(fs.existsSync(path.join(f.root, 'output.txt')), false)
  } finally { f.close() }
})

for (const change of ['runner', 'permission'] as const) test(`queued actions are rejected when their ${change} changes before dispatch`, async () => {
  let calls = 0
  const f = fixture(request => ++calls === 1 ? call('stage_write', 'queued-write', { value: '不得执行过期能力' }) : ask(request))
  let changed = false
  f.loop.onEvent(event => {
    if (changed || event.type !== 'timeline.step.upserted' || event.payload.step.type !== 'tool' || event.payload.step.status !== 'pending') return
    changed = true
    if (change === 'runner') fs.appendFileSync(f.runner, '\n// new implementation version\n')
    else { const config = JSON.parse(fs.readFileSync(f.configFile, 'utf8')); config.tool_permissions = ['filesystem:read']; fs.writeFileSync(f.configFile, JSON.stringify(config)) }
  })
  try {
    const done = f.wait('paused'); f.start(); await done
    assert.equal(changed, true); assert.equal(fs.existsSync(path.join(f.root, 'output.txt')), false)
    assert.equal(calls, 2)
    assert.ok(f.events.some(e => e.type === 'tool.call.failed' && e.payload.code === (change === 'runner' ? 'RUNTIME_CAPABILITY_VERSION_STALE' : 'RUNTIME_CAPABILITY_REVOKED')))
    assert.equal(f.loop.exportState().pendingToolCalls.length, 0)
  } finally { f.close() }
})

test('planning and its human request survive reopening and resume the same task with an empty-tool planning round', async () => {
  let calls = 0
  const node: RuntimePlanTask = { id: 'read', title: '读取指定来源', phase: 'investigation', dependsOn: [], owner: 'parent', capabilityIds: ['stage_read'], completionConditions: ['读取输入'], requiredActions: ['call:read-after-reopen'], evidenceRefs: [], status: 'pending' }
  const f = fixture(request => {
    calls++
    if (calls <= 2) { assert.equal(phase(request), 'planning'); assert.deepEqual(request.tools, []) }
    if (calls === 1) return reply(request, { decision: 'ask_user', userMessage: '本次使用哪份来源？', actions: [{ kind: 'ask_user', question: '本次使用哪份来源？', blockingTaskIds: [binding(request).taskId] }] })
    if (calls === 2 || calls === 4) return reply(request, { decision: 'propose_plan', planProposal: { basePlanRevision: calls === 2 ? 0 : 1, goal: '读取用户指定来源', tasks: [{ ...node, requiredActions: calls === 2 ? [] : node.requiredActions, status: calls === 2 ? 'pending' : 'completed' }] } })
    if (calls === 3) return call('stage_read', 'read-after-reopen')
    assert.equal(calls, 5)
    return reply(request, { decision: 'finish', userMessage: '来源已读取。', completionCheck: { taskId: binding(request).taskId, requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '已按输入执行并验证' } })
  })
  let restored: RuntimeLoop | undefined
  try {
    const paused = f.wait('paused'); f.start(true); await paused
    const state = f.loop.exportState(); f.loop.close()
    restored = new RuntimeLoop({ projectDir: f.root, sessionId: 'stage-session', llm: f.llm, initialState: state, contextOrganization: { minGroups: 100 }, stepDelayMs: 0, streamDelayMs: 0 })
    assert.equal(restored.exportState().taskControl!.planning!.required, true)
    const done = f.wait('completed', restored)
    f.send('chat.message.send', { clientMessageId: 'source-reply', content: [{ type: 'text', text: 'input.txt' }], autoStart: true, humanRequestId: state.contextControl!.humanRequestId }, restored)
    await done
    assert.equal(restored.exportState().taskControl!.taskId, state.taskControl!.taskId)
    assert.equal(restored.exportState().snapshot.run.runId, state.snapshot.run.runId)
    assert.equal(calls, 5)
  } finally { restored?.close(); f.close() }
})

for (const revoke of [false, true]) test(`a paused queued action restores its original capability binding (revoke=${revoke})`, async () => {
  let calls = 0, pause = false
  const f = fixture(request => ++calls === 1 ? call('stage_write', 'persisted-write', { value: '恢复后受控执行' }) : revoke ? ask(request) : { provider: 'custom', model: 'stage-test', text: '{"status":"completed","content":"ok"}', raw: {} })
  f.loop.onEvent(event => {
    if (pause || event.type !== 'timeline.step.upserted' || event.payload.step.type !== 'tool' || event.payload.step.status !== 'pending') return
    pause = true; f.send('run.pause', {})
  })
  let restored: RuntimeLoop | undefined
  try {
    const paused = f.wait('paused'); f.start(); await paused
    const state = f.loop.exportState()
    assert.ok(state.pendingToolCalls[0]![1].authorization)
    assert.equal(fs.existsSync(path.join(f.root, 'output.txt')), false)
    f.loop.close()
    if (revoke) { const config = JSON.parse(fs.readFileSync(f.configFile, 'utf8')); config.tool_permissions = ['filesystem:read']; fs.writeFileSync(f.configFile, JSON.stringify(config)) }
    restored = new RuntimeLoop({ projectDir: f.root, sessionId: 'stage-session', llm: f.llm, initialState: state, contextOrganization: { minGroups: 100 }, stepDelayMs: 0, streamDelayMs: 0 })
    const done = f.wait(revoke ? 'paused' : 'completed', restored)
    f.send('run.resume', {}, restored); await done
    if (revoke) {
      assert.equal(restored.exportState().taskControl!.capabilityRecovery!.attempts, 1)
      assert.ok(restored.exportState().llmMessages.some(message => message.role === 'tool' && message.content.includes('RUNTIME_CAPABILITY_REVOKED')))
      assert.equal(fs.existsSync(path.join(f.root, 'output.txt')), false)
    } else assert.equal(fs.readFileSync(path.join(f.root, 'output.txt'), 'utf8'), '恢复后受控执行')
  } finally { restored?.close(); f.close() }
})

test('revoking a later member of a queued batch prevents the earlier member from dispatching', async () => {
  let calls = 0
  const f = fixture(request => ++calls > 1 ? ask(request) : ({ provider: 'custom', model: 'stage-test', text: '', raw: {}, toolCalls: [
    { id: 'batch-read', name: 'stage_read', arguments: {} }, { id: 'batch-write', name: 'stage_write', arguments: { value: '禁止部分执行' } },
  ] }))
  let revoked = false
  f.loop.onEvent(event => {
    if (revoked || event.type !== 'timeline.step.upserted' || event.payload.step.type !== 'tool' || event.payload.step.status !== 'pending') return
    revoked = true; const config = JSON.parse(fs.readFileSync(f.configFile, 'utf8')); config.tool_permissions = ['filesystem:read']; fs.writeFileSync(f.configFile, JSON.stringify(config))
  })
  try {
    const done = f.wait('paused'); f.start(); await done
    assert.equal(calls, 2)
    assert.equal(f.loop.exportState().taskControl!.capabilityRecovery!.attempts, 1)
    assert.equal(f.events.some(event => event.type === 'tool.call.started'), false)
    assert.equal(fs.existsSync(path.join(f.root, 'output.txt')), false)
  } finally { f.close() }
})

test('a Workflow wrapper cannot invoke a tool outside the original planned projection', async () => {
  let calls = 0
  const f = fixture(request => {
    calls++
    if (calls === 1) return reply(request, { decision: 'propose_plan', planProposal: { basePlanRevision: 0, goal: '受限工作流', tasks: [{ id: 'workflow', title: '只读取来源', phase: 'execution', dependsOn: [], owner: 'parent', capabilityIds: ['execute_workflow', 'stage_read'], completionConditions: ['读取来源'], requiredActions: [], evidenceRefs: [], status: 'pending' }] } })
    if (calls === 2) {
      assert.ok(request.tools!.some(tool => tool.name === 'execute_workflow'))
      assert.ok(!request.tools!.some(tool => tool.name === 'stage_write'))
      return call('execute_workflow', 'bounded-workflow', { version: 1, goal: '非法扩大内部能力', steps: [{ id: 'write', type: 'tool', tool: 'stage_write', arguments: { value: '不能绕过投影' } }] })
    }
    assert.ok(request.messages.some(message => message.role === 'tool' && message.content.includes('WORKFLOW_DEFINITION_INVALID')))
    return reply(request, { decision: 'ask_user', userMessage: '需要调整计划的能力范围。', actions: [{ kind: 'ask_user', question: '是否调整本次工作计划？', blockingTaskIds: [binding(request).taskId] }] })
  })
  try {
    const done = f.wait('paused'); f.start(true); await done
    assert.equal(calls, 3); assert.equal(fs.existsSync(path.join(f.root, 'output.txt')), false)
    assert.equal(f.loop.exportState().snapshot.workflows.items[0]!.status, 'failed')
  } finally { f.close() }
})

test('a changed manifest is reloaded and the model must issue a fresh call with the new schema', async () => {
  let calls = 0, f: ReturnType<typeof fixture>
  f = fixture(request => {
    calls++
    if (calls === 1) {
      const manifestPath = path.join(f.root, 'tools/stage/manifest.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      manifest.tools[1].inputSchema = { type: 'object', properties: { replacement: { type: 'string' } }, required: ['replacement'], additionalProperties: false }
      fs.writeFileSync(manifestPath, JSON.stringify(manifest))
      fs.writeFileSync(f.runner, fs.readFileSync(f.runner, 'utf8').replace('request.arguments.value', 'request.arguments.replacement'))
      return call('stage_write', 'old-schema', { value: '不得执行' })
    }
    if (calls === 2) {
      assert.deepEqual(request.tools!.find(tool => tool.name === 'stage_write')!.parameters.required, ['replacement'])
      assert.ok(request.messages.some(message => message.content.includes('capability_projection_changed')))
      return call('stage_write', 'fresh-schema', { replacement: '使用新定义' })
    }
    if (calls === 3) return call('stage_read', 'verify-fresh')
    assert.equal(calls, 4)
    return reply(request, { decision: 'finish', userMessage: '新版本已执行并验证。', completionCheck: { taskId: binding(request).taskId, requiredActions: ['call:fresh-schema', 'call:verify-fresh'], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '真实文件读回一致' } })
  })
  try {
    const done = f.wait('completed'); f.start(); await done
    const state = f.loop.exportState()
    assert.equal(calls, 4); assert.equal(fs.readFileSync(path.join(f.root, 'output.txt'), 'utf8'), '使用新定义')
    assert.equal(state.taskControl!.capabilityRecovery!.attempts, 1)
    assert.equal(f.events.some(event => event.type === 'tool.call.started' && event.payload.callId === 'old-schema'), false)
    const projections = state.artifacts.filter(a => a.meta.kind === 'model-request').map(a => (a.value as { capabilityProjection: { id: string; bindings: Array<{ name: string; schemaHash: string }> } }).capabilityProjection)
    assert.notEqual(projections[0]!.id, projections[1]!.id)
    assert.notEqual(projections[0]!.bindings.find(b => b.name === 'stage_write')!.schemaHash, projections[1]!.bindings.find(b => b.name === 'stage_write')!.schemaHash)
  } finally { f.close() }
})

function countWrites(f: ReturnType<typeof fixture>): void {
  fs.writeFileSync(f.runner, fs.readFileSync(f.runner, 'utf8').replace("fs.writeFileSync(path.join(root,'output.txt'),request.arguments.value);", "fs.appendFileSync(path.join(root,'writes.log'),'w');fs.writeFileSync(path.join(root,'output.txt'),request.arguments.value);"))
}

test('revocation after the first batch action preserves its real receipt and never replays its write', async () => {
  let calls = 0
  const f = fixture(request => ++calls > 1 ? ask(request) : { provider: 'custom', model: 'stage-test', text: '', raw: {}, toolCalls: [
    { id: 'already-written', name: 'stage_write', arguments: { value: '只写一次' } }, { id: 'revoked-read', name: 'stage_read', arguments: {} },
  ] })
  countWrites(f)
  f.loop.onEvent(event => {
    if (event.type !== 'tool.call.completed' || event.payload.callId !== 'already-written') return
    const config = JSON.parse(fs.readFileSync(f.configFile, 'utf8')); config.tool_permissions = ['filesystem:write']; fs.writeFileSync(f.configFile, JSON.stringify(config))
  })
  try {
    const done = f.wait('paused'); f.start(); await done
    assert.equal(calls, 2); assert.equal(fs.readFileSync(path.join(f.root, 'writes.log'), 'utf8'), 'w')
    assert.equal(f.events.filter(event => event.type === 'tool.call.completed' && event.payload.callId === 'already-written').length, 1)
    assert.equal(f.events.some(event => event.type === 'tool.call.started' && event.payload.callId === 'revoked-read'), false)
    const state = f.loop.exportState()
    assert.equal(state.pendingToolCalls.length, 0)
    assert.ok(state.snapshot.observations.items.some(item => item.callId === 'already-written' && item.status === 'completed'))
    const read = state.llmMessages.find(message => message.role === 'tool' && message.toolCallId === 'revoked-read')!
    assert.equal(JSON.parse(read.content).error.dispatched, false)
    assert.equal(JSON.parse(read.content).runtime_receipt, undefined)
    assert.equal(state.contextHistory!.messages.filter(item => item.origin === 'user').length, 1)
    assert.ok(state.contextHistory!.messages.some(item => item.origin === 'runtime' && item.message.content.includes('capability_projection_changed')))
  } finally { f.close() }
})

test('a partially executed Workflow returns its real partial output and rejects the remaining capability', async () => {
  let calls = 0
  const f = fixture(request => {
    if (++calls === 1) return call('execute_workflow', 'partial-workflow', { version: 1, goal: '写入并读取', steps: [
      { id: 'write', type: 'tool', tool: 'stage_write', arguments: { value: '工作流只写一次' } },
      { id: 'read', type: 'tool', tool: 'stage_read', arguments: {} },
    ] })
    const result = JSON.parse(request.messages.find(message => message.role === 'tool' && message.toolCallId === 'partial-workflow')!.content)
    assert.equal(result.ok, false); assert.equal(result.steps.write.status, 'completed'); assert.equal(result.steps.read.status, 'failed')
    return ask(request, '读取能力已撤销，如何继续？')
  })
  countWrites(f)
  f.loop.onEvent(event => {
    if (event.type !== 'tool.call.completed' || event.payload.toolName !== 'stage_write') return
    const config = JSON.parse(fs.readFileSync(f.configFile, 'utf8')); config.tool_permissions = ['filesystem:write']; fs.writeFileSync(f.configFile, JSON.stringify(config))
  })
  try {
    const done = f.wait('paused'); f.start(); await done
    assert.equal(calls, 2); assert.equal(fs.readFileSync(path.join(f.root, 'writes.log'), 'utf8'), 'w')
    const state = f.loop.exportState(), workflow = state.snapshot.workflows.items[0]!
    assert.equal(workflow.status, 'failed'); assert.equal(workflow.nodes.find(node => node.id === 'write')!.status, 'completed')
    assert.equal(state.pendingToolCalls.length, 0); assert.equal(state.pendingWorkflowCalls!.length, 0)
    assert.equal(f.events.some(event => event.type === 'tool.call.started' && event.payload.toolName === 'stage_read'), false)
  } finally { f.close() }
})

test('capability recovery remains bounded across a checkpoint and reopening', async () => {
  let calls = 0, active: RuntimeLoop
  const f = fixture(() => {
    calls++; (active as unknown as { taskControl: { stateRevision: number } }).taskControl.stateRevision++
    return call('stage_write', `stale-${calls}`, { value: '不能执行旧状态' })
  })
  active = f.loop
  let pausedOnce = false, restored: RuntimeLoop | undefined
  f.loop.onEvent(event => {
    if (pausedOnce || event.type !== 'runtime.checkpoint.created' || f.loop.exportState().taskControl?.capabilityRecovery?.attempts !== 1) return
    pausedOnce = true; f.send('run.pause', {})
  })
  try {
    const paused = f.wait('paused'); f.start(); await paused
    const before = f.loop.exportState(); f.loop.close()
    assert.equal(calls, 1); assert.equal(before.taskControl!.capabilityRecovery!.attempts, 1)
    restored = new RuntimeLoop({ projectDir: f.root, sessionId: 'stage-session', llm: f.llm, initialState: before, contextOrganization: { minGroups: 100 }, stepDelayMs: 0, streamDelayMs: 0 })
    active = restored
    const failed = f.wait('failed', restored); f.send('run.resume', {}, restored); await failed
    const state = restored.exportState()
    assert.equal(calls, 4); assert.equal(state.taskControl!.capabilityRecovery!.attempts, 3)
    assert.equal(state.taskControl!.taskId, before.taskControl!.taskId); assert.equal(state.snapshot.run.runId, before.snapshot.run.runId)
    assert.equal(state.snapshot.run.failure!.code, 'RUNTIME_CAPABILITY_RECOVERY_LIMIT')
    assert.equal(fs.existsSync(path.join(f.root, 'output.txt')), false)
    assert.equal(state.artifacts.filter(a => a.meta.label.startsWith('Capability dispatch rejected')).length, 4)
  } finally { restored?.close(); f.close() }
})

test('a tampered queued projection is terminal and cannot request automatic reauthorization', async () => {
  let calls = 0, pausedOnce = false, restored: RuntimeLoop | undefined
  const f = fixture(() => { calls++; return call('stage_write', 'forged-queued', { value: '不得授权' }) })
  f.loop.onEvent(event => {
    if (pausedOnce || event.type !== 'timeline.step.upserted' || event.payload.step.type !== 'tool' || event.payload.step.status !== 'pending') return
    pausedOnce = true; f.send('run.pause', {})
  })
  try {
    const paused = f.wait('paused'); f.start(); await paused
    const state = f.loop.exportState(); f.loop.close()
    state.pendingToolCalls[0]![1].authorization!.projection.bindings[0]!.sourceVersion = 'forged'
    restored = new RuntimeLoop({ projectDir: f.root, sessionId: 'stage-session', llm: f.llm, initialState: state, contextOrganization: { minGroups: 100 }, stepDelayMs: 0, streamDelayMs: 0 })
    const done = f.wait('failed', restored); f.send('run.resume', {}, restored); await done
    assert.equal(calls, 1); assert.equal(restored.exportState().snapshot.run.failure!.code, 'RUNTIME_CAPABILITY_PROJECTION_INVALID')
    assert.equal(restored.exportState().taskControl!.capabilityRecovery, undefined)
    assert.equal(fs.existsSync(path.join(f.root, 'output.txt')), false)
  } finally { restored?.close(); f.close() }
})

test('capability recovery cannot erase accepted plan actions or turn a refusal into completion evidence', async () => {
  let calls = 0, changed = false
  const f = fixture(request => {
    if (++calls === 1) return reply(request, { decision: 'propose_plan', planProposal: { basePlanRevision: 0, goal: '必须真实写入', tasks: [{
      id: 'required-write', title: '写入并核对', phase: 'execution', owner: 'parent', dependsOn: [], capabilityIds: ['stage_write'], completionConditions: ['实际写入'], requiredActions: ['tool:stage_write'], evidenceRefs: [], status: 'pending',
    }] } })
    if (calls === 2) return call('stage_write', 'required-write', { value: '本轮过期' })
    return reply(request, { decision: 'finish', userMessage: '试图跳过', completionCheck: { taskId: binding(request).taskId, requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '不得通过' } })
  })
  f.loop.onEvent(event => {
    if (changed || event.type !== 'timeline.step.upserted' || event.payload.step.type !== 'tool' || event.payload.step.status !== 'pending') return
    changed = true; fs.appendFileSync(f.runner, '\n// changed before admission\n')
  })
  try {
    const done = f.wait('failed'); f.start(true); await done
    const state = f.loop.exportState()
    assert.equal(calls, 3); assert.equal(state.taskControl!.capabilityRecovery!.attempts, 1)
    assert.ok(state.taskControl!.requiredActions.includes('tool:stage_write'))
    assert.equal(state.snapshot.run.failure!.code, 'RUNTIME_ENVELOPE_ACTIONS_INCOMPLETE')
    assert.equal(state.taskControl!.tasks[0]!.status, 'pending')
    assert.equal(fs.existsSync(path.join(f.root, 'output.txt')), false)
  } finally { f.close() }
})

test('authority is rechecked at the runner boundary after tool preparation callbacks', async () => {
  let calls = 0, revoked = false
  const f = fixture(request => ++calls === 1 ? call('stage_write', 'prepared-write', { value: '不得分发' }) : ask(request))
  f.loop.onEvent(event => {
    if (revoked || event.type !== 'tool.call.started' || event.payload.callId !== 'prepared-write') return
    revoked = true; const config = JSON.parse(fs.readFileSync(f.configFile, 'utf8')); config.tool_permissions = ['filesystem:read']; fs.writeFileSync(f.configFile, JSON.stringify(config))
  })
  try {
    const done = f.wait('paused'); f.start(); await done
    assert.equal(calls, 2); assert.equal(fs.existsSync(path.join(f.root, 'output.txt')), false)
    const state = f.loop.exportState()
    assert.equal(state.snapshot.processes!.items.find(item => item.id === 'process:prepared-write')!.status, 'failed')
    assert.equal(state.snapshot.observations.items.find(item => item.callId === 'prepared-write')!.status, 'failed')
    assert.ok(f.events.some(event => event.type === 'tool.call.failed' && event.payload.callId === 'prepared-write' && (event.payload.details as { dispatched: boolean }).dispatched === false))
  } finally { f.close() }
})

test('cancellation during a capability refusal cannot schedule another model request', async () => {
  let calls = 0, changed = false, cancelled = false
  const f = fixture(() => { calls++; return call('stage_write', 'cancelled-refusal', { value: '不得执行' }) })
  f.loop.onEvent(event => {
    if (!changed && event.type === 'timeline.step.upserted' && event.payload.step.type === 'tool' && event.payload.step.status === 'pending') {
      changed = true; fs.appendFileSync(f.runner, '\n// force fresh projection\n')
    }
    if (!cancelled && event.type === 'runtime.artifact.created' && event.payload.artifact.label.startsWith('Capability dispatch rejected')) {
      cancelled = true; f.send('run.cancel', {})
    }
  })
  try {
    const done = f.wait('cancelled'); f.start(); await done
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 1); assert.equal(f.loop.exportState().snapshot.run.status, 'cancelled')
    assert.equal(fs.existsSync(path.join(f.root, 'output.txt')), false)
    assert.equal(f.loop.exportState().artifacts.filter(a => a.meta.kind === 'model-request').length, 1)
  } finally { f.close() }
})
