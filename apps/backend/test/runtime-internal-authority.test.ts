import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { initializeProjectDirectory } from '#core/project-initializer'
import { RuntimeLoop, type RuntimeLlm, type RuntimeLoopOptions } from '#core/runtime-loop'
import { withAssetWritePolicy } from '#core/asset-write-policy'
import type { ClientCommand, ControlEnvelopeV2, RuntimeRequestBinding, ServerEvent } from '#protocol/runtime-protocol'
import type { LlmChatRequest, LlmChatResponse } from '#util/llm'

function ask(request: LlmChatRequest): LlmChatResponse {
  const match = request.messages[0]!.content.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)
  assert.ok(match)
  const binding: RuntimeRequestBinding = JSON.parse(match[0])
  const envelope: ControlEnvelopeV2 = { envelopeVersion: 2, binding, decision: 'ask_user', userMessage: '请提供下一步输入。',
    actions: [{ kind: 'ask_user', question: '请提供下一步输入。', blockingTaskIds: [binding.taskId] }],
    planProposal: null, candidateDiffs: [], evidenceRequests: [], uncertainties: [], waitSpec: null, completionCheck: null }
  return { provider: 'custom', model: 'authority-test', text: JSON.stringify(envelope), raw: {} }
}

function fixture(actor: (request: LlmChatRequest) => LlmChatResponse = ask, options: Partial<RuntimeLoopOptions> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-internal-authority-'))
  initializeProjectDirectory(root)
  const configFile = path.join(root, '.capybara/config.json')
  const skillDir = path.join(root, 'skills/authority-skill')
  fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(skillDir, 'references'))
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: authority-skill\ndescription: Test an actual local script.\nallowed-tools: run_skill_script\n---\nRead sources before execution.\n')
  const script = path.join(skillDir, 'scripts/write.mjs')
  fs.writeFileSync(script, "import fs from 'node:fs'; import path from 'node:path'; fs.appendFileSync(path.join(process.cwd(),'writes.txt'),'w'); console.log('written');")
  fs.writeFileSync(path.join(skillDir, 'references/source.md'), 'Original source, not a permission grant.')
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  config.skills = ['skills/authority-skill']
  fs.writeFileSync(configFile, JSON.stringify(config))
  const llm: RuntimeLlm = { getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'authority-test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }), chat: async request => actor(request) }
  const loop = new RuntimeLoop({ projectDir: root, sessionId: 'authority-session', llm, streamDelayMs: 0, stepDelayMs: 0, contextOrganization: { minGroups: 100 }, ...options })
  const events: ServerEvent[] = []
  loop.onEvent(event => events.push(event as ServerEvent))
  let sequence = 0
  const command = (type: ClientCommand['type'], payload: unknown): ClientCommand => ({ version: 1, kind: 'command', id: `authority-${++sequence}`, sessionId: 'authority-session', timestamp: new Date().toISOString(), type, payload } as ClientCommand)
  const send = (type: ClientCommand['type'], payload: unknown) => { const cmd = command(type, payload); loop.validate(cmd); loop.execute(cmd, sequence) }
  const wait = (predicate: (event: ServerEvent) => boolean) => new Promise<ServerEvent>((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('authority event timed out')) }, 15000)
    const off = loop.onEvent(event => { if (predicate(event as ServerEvent)) { clearTimeout(timer); off(); resolve(event as ServerEvent) } })
  })
  send('runtime.skills.attach', { skillId: 'authority-skill', baseRevision: loop.exportState().snapshot.skills.revision })
  return { root, loop, script, events, command, send, wait,
    grants(permissions: string[]) { const current = JSON.parse(fs.readFileSync(configFile, 'utf8')); current.tool_permissions = permissions; fs.writeFileSync(configFile, JSON.stringify(current)) },
    start() { send('chat.message.send', { clientMessageId: `message-${++sequence}`, content: [{ type: 'text', text: '验证当前能力。' }], autoStart: true }) },
    scriptCommand() { return command('runtime.skills.script.run', { skillId: 'authority-skill', path: 'scripts/write.mjs', argv: [], baseRevision: loop.exportState().snapshot.skills.revision }) },
    close() { loop.close(); fs.rmSync(root, { recursive: true, force: true }) },
  }
}

test('internal schemas require actual grants; Skill allowed-tools does not grant process or write permission', async () => {
  let calls = 0
  const f = fixture(request => {
    calls++
    const names = new Set(request.tools?.map(tool => tool.name))
    for (const name of ['run_skill_script', 'read_skill_resource', 'apply_system_variable_changes', 'request_skill_install', 'request_skill_uninstall', 'market_research']) assert.ok(!names.has(name), name)
    assert.ok(names.has('search_resources'))
    return ask(request)
  })
  try {
    f.grants([])
    assert.throws(() => f.loop.validate(f.scriptCommand()), /permission_denied/)
    const done = f.wait(e => e.type === 'run.state.changed' && e.payload.status === 'paused'); f.start(); await done
    assert.equal(calls, 1); assert.equal(fs.existsSync(path.join(f.root, 'writes.txt')), false)
  } finally { f.close() }
})

test('an admitted Skill script runs once and its model receipt carries the real permission contract', async () => {
  let calls = 0
  const f = fixture(request => {
    if (++calls === 1) {
      assert.ok(request.tools?.some(tool => tool.name === 'run_skill_script'))
      return { provider: 'custom', model: 'authority-test', text: '', raw: {}, toolCalls: [{ id: 'write-once', name: 'run_skill_script', arguments: { skill_id: 'authority-skill', path: 'scripts/write.mjs', argv: [] } }] }
    }
    assert.match(request.messages.find(message => message.role === 'tool' && message.name === 'run_skill_script')!.content, /written/)
    return ask(request)
  })
  try {
    const done = f.wait(e => e.type === 'run.state.changed' && e.payload.status === 'paused'); f.start(); await done
    assert.equal(fs.readFileSync(path.join(f.root, 'writes.txt'), 'utf8'), 'w')
    const step = f.loop.exportState().snapshot.timeline.steps.find(step => step.detail?.toolName === 'run_skill_script')!
    assert.deepEqual(step.detail?.permissions, ['process:execute'])
    assert.equal(step.detail?.sideEffects, 'external'); assert.equal(step.detail?.replay, 'never')
  } finally { f.close() }
})

test('a read-only child cannot use the direct Skill script command with inherited process grants', () => {
  const f = fixture(ask, { childAgentMode: true })
  try {
    assert.throws(() => f.loop.validate(f.scriptCommand()), /child_readonly/)
    assert.equal(fs.existsSync(path.join(f.root, 'writes.txt')), false)
  } finally { f.close() }
})

test('a model cannot invoke an internal write that was omitted for missing permission', async () => {
  const f = fixture(() => ({ provider: 'custom', model: 'authority-test', text: '', raw: {}, toolCalls: [{ id: 'ungranted-write', name: 'apply_system_variable_changes', arguments: {} }] }))
  try {
    f.grants(['filesystem:read'])
    const before = fs.readFileSync(path.join(f.root, '.capybara/system-variables.json'), 'utf8')
    const done = f.wait(e => e.type === 'run.state.changed' && e.payload.status === 'failed'); f.start(); await done
    assert.equal(f.loop.exportState().snapshot.run.failure!.code, 'RUNTIME_ENVELOPE_TOOL_UNAUTHORIZED')
    assert.equal(fs.readFileSync(path.join(f.root, '.capybara/system-variables.json'), 'utf8'), before)
    assert.ok(!f.events.some(e => e.type === 'tool.call.started'))
  } finally { f.close() }
})

test('a queued model script is rejected after a source change and requires a fresh decision', async () => {
  let calls = 0
  const f = fixture(request => ++calls === 1
    ? { provider: 'custom', model: 'authority-test', text: '', raw: {}, toolCalls: [{ id: 'old-script', name: 'run_skill_script', arguments: { skill_id: 'authority-skill', path: 'scripts/write.mjs', argv: [] } }] }
    : ask(request))
  try {
    let changed = false
    f.loop.onEvent(event => {
      if (changed || event.type !== 'timeline.step.upserted' || event.payload.step.type !== 'tool' || event.payload.step.status !== 'pending') return
      changed = true; fs.appendFileSync(f.script, '\n// source v2 before dispatch')
    })
    const done = f.wait(e => e.type === 'run.state.changed' && e.payload.status === 'paused'); f.start(); await done
    assert.equal(changed, true); assert.equal(calls, 2)
    assert.equal(fs.existsSync(path.join(f.root, 'writes.txt')), false)
    assert.ok(f.loop.exportState().artifacts.some(artifact => artifact.meta.kind === 'runtime-error' && JSON.stringify(artifact.value).includes('RUNTIME_CAPABILITY_VERSION_STALE')))
  } finally { f.close() }
})

test('direct Skill execution rechecks permission after command validation and reports refusal without spawning', async () => {
  const f = fixture()
  try {
    const cmd = f.scriptCommand(); f.loop.validate(cmd); f.grants(['filesystem:read'])
    const done = f.wait(e => e.type === 'runtime.artifact.created' && e.payload.artifact.kind === 'skill-script-result')
    f.loop.execute(cmd, 100); await done
    assert.equal(fs.existsSync(path.join(f.root, 'writes.txt')), false)
    const artifact = f.loop.exportState().artifacts.find(a => a.meta.kind === 'skill-script-result')!
    assert.match(JSON.stringify(artifact.value), /PERMISSION_DENIED/)
  } finally { f.close() }
})

for (const change of ['permission', 'source'] as const) test(`Skill dispatch rechecks ${change} after the loading event and before spawning`, async () => {
  const f = fixture()
  try {
    let changed = false
    f.loop.onEvent(event => {
      if (changed || event.type !== 'runtime.skills.updated' || !event.payload.items.some(skill => skill.resources.some(resource => resource.kind === 'script' && resource.status === 'loading'))) return
      changed = true
      if (change === 'permission') f.grants(['filesystem:read'])
      else fs.appendFileSync(f.script, '\n// changed after preparation')
    })
    const done = f.wait(e => e.type === 'runtime.artifact.created' && e.payload.artifact.kind === 'skill-script-result')
    f.send('runtime.skills.script.run', { skillId: 'authority-skill', path: 'scripts/write.mjs', argv: [], baseRevision: f.loop.exportState().snapshot.skills.revision })
    await done
    assert.equal(changed, true); assert.equal(fs.existsSync(path.join(f.root, 'writes.txt')), false)
    const artifact = f.loop.exportState().artifacts.find(a => a.meta.kind === 'skill-script-result')!
    assert.match(JSON.stringify(artifact.value), /PERMISSION_DENIED/)
  } finally { f.close() }
})

test('a frozen asset scope refuses arbitrary Skill code even when process permission exists', () => {
  const f = fixture()
  try {
    const audits: unknown[] = []
    assert.throws(() => withAssetWritePolicy({ projectDir: f.root, readonly: true, onAudit: event => audits.push(event) }, () => f.loop.validate(f.scriptCommand())), /Read-only evaluation blocked/)
    assert.equal(audits.length, 1); assert.equal(fs.existsSync(path.join(f.root, 'writes.txt')), false)
  } finally { f.close() }
})

test('importing child claims keeps candidates pending and preserves lifecycle across durable restore', () => {
  const f = fixture()
  try {
    const previous = f.loop.exportState().snapshot.children
    const count = f.events.filter(event => event.type === 'runtime.children.updated').length
    f.send('runtime.context.v2.child.merge', { documentId: f.loop.exportState().contextDocument!.id, sourceId: 'unverified-child', runId: 'claimed-run', rawArtifactId: 'claimed-artifact', normalizedContent: '声称子任务已完成', evidenceRefs: [] })
    const state = f.loop.exportState()
    assert.deepEqual(state.snapshot.children, previous)
    assert.equal(f.events.filter(event => event.type === 'runtime.children.updated').length, count)
    assert.equal(state.contextDocument!.candidates.at(-1)!.status, 'pending')
    assert.equal(state.contextDocument!.information.length, 0)
    f.loop.close()
    const restored = new RuntimeLoop({ projectDir: f.root, sessionId: 'authority-session', initialState: state })
    try {
      assert.deepEqual(restored.exportState().snapshot.children, previous)
      assert.equal(restored.exportState().contextDocument!.candidates.at(-1)!.status, 'pending')
    } finally { restored.close() }
  } finally { f.close() }
})

test('an imported success claim cannot overwrite a real failed child execution', async () => {
  let calls = 0
  const f = fixture(request => ++calls === 1
    ? { provider: 'custom', model: 'authority-test', text: '', raw: {}, toolCalls: [{ id: 'delegate-fails', name: 'delegate_task', arguments: { goal: '验证来源', prompt: '只检查来源。', mode: 'sync' } }] }
    : ask(request), { childAgentEnabled: true, childAgentHost: async () => ({ ok: false, error: { code: 'CHILD_TEST_FAILURE', message: '真实子任务失败' } }) })
  try {
    const done = f.wait(e => e.type === 'run.state.changed' && e.payload.status === 'paused'); f.start(); await done
    const child = f.loop.exportState().snapshot.children!.items[0]!
    assert.equal(child.status, 'failed')
    f.send('runtime.context.v2.child.merge', { documentId: f.loop.exportState().contextDocument!.id, sourceId: child.id, runId: 'claimed-success-run', rawArtifactId: 'unverified-success', normalizedContent: '声称已经成功', evidenceRefs: [] })
    assert.deepEqual(f.loop.exportState().snapshot.children!.items, [child])
    assert.equal(f.loop.exportState().contextDocument!.candidates.at(-1)!.status, 'pending')
  } finally { f.close() }
})
