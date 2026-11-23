import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { RuntimeLoop, type RuntimeLlm, type RuntimeLoopOptions } from '#core/runtime-loop'
import { initializeProjectDirectory } from '#core/project-initializer'
import { ProjectResources } from '#core/project-resources'
import { ProjectContextStore } from '#core/project-context-store'
import { withAssetWritePolicy } from '#core/asset-write-policy'
import type { ClientCommand, ServerEvent } from '#protocol/runtime-protocol'
import type { LlmChatRequest } from '#util/llm'

const config: RuntimeLlm['getConfig'] = () => ({ provider: 'custom', protocol: 'responses', model: 'test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 })
const reply = (value: unknown) => ({ provider: 'custom' as const, model: 'test', raw: {}, text: JSON.stringify(value) })
function promptData(request: LlmChatRequest, prefix: string) {
  assert.equal(request.tools, undefined)
  const line = request.messages[0]!.content.split('\n').find(item => item.startsWith(prefix))
  assert.ok(line, `missing data block ${prefix}`)
  return JSON.parse(line)
}
function answer(request: LlmChatRequest, fields: object) {
  const { mode, snapshotId } = promptData(request, '{"organizationVersion":1,"snapshotId":')
  return reply({ organizationVersion: 1, snapshotId, mode, uncertainties: [], ...fields })
}
function fixture(options: RuntimeLoopOptions, modes: string[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-context-assistant-'))
  initializeProjectDirectory(root)
  const resources = new ProjectResources(root)
  resources.saveSettings({ context_assistant_modes: modes })
  resources.close()
  const loop = new RuntimeLoop({ projectDir: root, sessionId: 'assistant-session', streamDelayMs: 0, stepDelayMs: 0, ...options })
  const events: ServerEvent[] = []
  loop.onEvent(event => events.push(event as ServerEvent))
  let sequence = 0
  const send = (type: ClientCommand['type'], payload: unknown) => {
    const command = { version: 1, kind: 'command', id: `mode-command-${++sequence}`, type, payload,
      sessionId: 'assistant-session', timestamp: new Date().toISOString() } as ClientCommand
    loop.validate(command)
    loop.execute(command, sequence)
    return command
  }
  return {
    root, loop, events, send,
    async until<T extends ServerEvent['type']>(type: T, predicate?: (event: Extract<ServerEvent, { type: T }>) => boolean) {
      for (let index = 0; index < 1500; index++) {
        const event = events.find(item => item.type === type && (!predicate || predicate(item as Extract<ServerEvent, { type: T }>)))
        if (event) return event as Extract<ServerEvent, { type: T }>
        const failed = events.find(item => item.type === 'run.state.changed' && item.payload.status === 'failed')
        if (failed?.type === 'run.state.changed') throw new Error(failed.payload.failure?.message)
        await delay(10)
      }
      throw new Error(`missing event ${type}`)
    },
    observe(text: string, actor = 'memory') {
      const id = `source-${sequence}`
      send('runtime.context.v2.observe', { observation: { documentId: loop.exportState().contextDocument!.id,
        candidate: { source: { actor, sourceId: id, capturedAt: new Date().toISOString() }, rawArtifactId: id, normalizedContent: text },
        evidence: { kind: 'message', referenceId: id } } })
    },
    close() { loop.close(); fs.rmSync(root, { recursive: true, force: true }) },
  }
}

for (const scenario of ['selection', 'forged', 'stale'] as const) {
  test(`configured Recall handles ${scenario} before writing pending candidates`, async () => {
    let calls = 0
    const f = fixture({ contextAssistant: { llm: { getConfig: config, chat: async request => {
      calls++
      const { candidates } = promptData(request, '{"query":')
      assert.equal(candidates.length, 2)
      assert.equal(f.loop.exportState().contextDocument!.candidates.filter(candidate => candidate.source.sourceId.startsWith('recall:')).length, 0)
      if (scenario === 'stale') {
        const writer = new ProjectContextStore(f.root, f.root, 'test')
        try {
          const engine = writer.load()
          const revision = engine.snapshot().revision
          engine.observe({ candidate: { source: { actor: 'user', sourceId: 'changed', capturedAt: new Date().toISOString() },
            rawArtifactId: 'changed', normalizedContent: '并发修改项目背景' }, evidence: { kind: 'message', referenceId: 'changed' } })
          writer.save(engine, revision)
        } finally { writer.close() }
      }
      const selected = candidates.find((item: { body: string }) => item.body.includes('120'))
      return answer(request, { recallProposals: [{ id: scenario === 'forged' ? 'invented' : selected.id, reason: 'select: email provenance' }] })
    } } } }, ['recall'])
    try {
      f.observe('退款 A：125 元。')
      f.observe('退款 B：120 元。')
      const command = f.send('runtime.context.v2.memory.recall', { query: '退款', limit: 1 })
      if (scenario === 'stale') {
        await f.until('runtime.artifact.created', event => event.payload.artifact.preview.includes('CONTEXT_ASSISTANT_SNAPSHOT_STALE'))
        assert.equal(f.events.some(event => event.type === 'runtime.context.v2.memory.recalled'), false)
        assert.equal(f.loop.exportState().contextDocument!.candidates.length, 2)
      } else {
        const event = await f.until('runtime.context.v2.memory.recalled')
        assert.equal(event.payload.hits.length, 1)
        assert.equal(event.payload.candidates[0]!.status, 'pending')
        assert.equal(f.loop.exportState().contextDocument!.information.length, 0)
        if (scenario === 'selection') {
          assert.match(event.payload.hits[0]!.body, /120/)
          assert.equal(event.payload.hits[0]!.reason, 'select: email provenance')
        } else assert.ok(event.payload.uncertainties.includes('assistant_selection:CONTEXT_ASSISTANT_SELECTION_INVALID'))
        f.loop.execute(command, 99)
        await delay(30)
      }
      assert.equal(calls, 1)
    } finally { f.close() }
  })
}

test('configured Dream publishes validated proposals from an idle snapshot without editing the document', async () => {
  let calls = 0
  const f = fixture({ contextAssistant: { llm: { getConfig: config, chat: async request => {
    calls++
    assert.match(request.messages[0]!.content, /Capybara Dream Prompt/)
    const { candidateIds } = promptData(request, '{"plan":')
    return answer(request, { candidateDiffs: [], recallProposals: [{ id: candidateIds[0], reason: '归档前保持可召回' }] })
  } } } }, ['dream'])
  try {
    f.observe('保留一条原始记忆')
    const before = f.loop.exportState().contextDocument!
    f.send('runtime.context.v2.dream', {})
    const event = await f.until('runtime.context.v2.dream.created')
    const artifact = f.loop.exportState().artifacts.find(item => item.meta.id === event.payload.artifactId)!
    const plan = artifact.value as { review: { output: { recallProposals: Array<{ id: string }> } } }
    assert.equal(plan.review.output.recallProposals[0]!.id, before.candidates[0]!.id)
    assert.equal(f.loop.exportState().contextDocument!.revision, before.revision)
    assert.equal(f.loop.exportState().snapshot.run.status, 'idle')
    assert.equal(calls, 1)
  } finally { f.close() }
})

test('Dream rejects a project archive proposal during the training freeze', async () => {
  const f = fixture({ contextAssistant: { llm: { getConfig: config, chat: async request => {
    const projected = promptData(request, '{"sessionId":"assistant-session","scope":"project"')
    const projection = projected.projection
    assert.ok(projection.sourceEntryIds.length)
    assert.ok(projection.sourceCandidateIds.length)
    return answer(request, { recallProposals: [], candidateDiffs: [{
      scope: 'project', documentId: projected.documentId, baseRevision: projection.documentRevision,
      projectionId: projection.id, projectionHash: projection.contentHash, candidateId: projection.sourceCandidateIds[0],
      operation: 'mark_status', target: { section: 'information', entryId: projection.sourceEntryIds[0] },
      payload: { status: 'archived' }, idempotencyKey: 'archive-frozen',
    }] })
  } } } }, ['dream'])
  try {
    const writer = new ProjectContextStore(f.root, f.root, 'test')
    let revision: number
    try {
      const engine = writer.load()
      const base = engine.snapshot().revision
      const { candidate } = engine.observe({ candidate: {
        source: { actor: 'user', sourceId: 'refund-a', capturedAt: new Date().toISOString() },
        rawArtifactId: 'refund-a', normalizedContent: '项目退款规范 125 USD',
      }, evidence: { kind: 'message', referenceId: 'refund-a' } })
      const receipt = engine.apply(engine.propose({ projection: engine.project({ id: 'seed', maxCharacters: 4096 }),
        candidateId: candidate.id, target: { section: 'information', headingPath: ['规则'] }, operation: 'add_entry',
        payload: { body: '项目退款规范 125 USD' }, actor: 'system', idempotencyKey: 'frozen-seed' }))
      assert.equal(receipt.result, 'applied')
      engine.observe({ candidate: {
        source: { actor: 'memory', sourceId: 'same-origin', capturedAt: new Date().toISOString() },
        rawArtifactId: 'refund-a', normalizedContent: '项目退款规范仍待复核',
      }, evidence: { kind: 'message', referenceId: 'refund-a' } })
      writer.save(engine, base)
      revision = engine.snapshot().revision
    } finally { writer.close() }
    await withAssetWritePolicy({ projectDir: f.root, readonly: true, onAudit: () => {} }, async () => {
      f.send('runtime.context.v2.dream', {})
      const event = await f.until('runtime.context.v2.dream.created')
      const plan = f.loop.exportState().artifacts.find(item => item.meta.id === event.payload.artifactId)!
      assert.match(JSON.stringify(plan.value), /CONTEXT_ASSISTANT_PROJECT_FROZEN/)
    })
    const check = new ProjectContextStore(f.root, f.root, 'test')
    try {
      const document = check.load().snapshot()
      assert.equal(document.revision, revision)
      assert.equal(document.information[0]!.status, 'active')
    } finally { check.close() }
  } finally { f.close() }
})

test('foreground work cancels an in-flight idle Dream without applying a late response', async () => {
  let finishOld!: () => void
  let signal: AbortSignal | undefined
  const f = fixture({ llm: { getConfig: config, chat: async () => reply({ status: 'completed', content: '前台任务已完成。' }) },
    contextAssistant: { llm: { getConfig: config, chat: async request => {
      if (signal) return answer(request, { candidateDiffs: [], recallProposals: [] })
      signal = request.signal
      return new Promise(resolve => { finishOld = () => resolve(answer(request, { candidateDiffs: [], recallProposals: [] })) })
    } } } }, ['dream'])
  try {
    f.observe('保留空闲快照的来源。')
    const old = f.send('runtime.context.v2.dream', {})
    for (let index = 0; !signal && index < 100; index++) await delay(10)
    assert.ok(signal)
    f.send('chat.message.send', { clientMessageId: 'foreground', autoStart: true, content: [{ type: 'text', text: '处理新任务。' }] })
    await f.until('run.state.changed', event => event.payload.status === 'completed')
    assert.equal(signal.aborted, true)
    finishOld()
    await delay(40)
    assert.equal(f.events.some(event => event.type === 'runtime.context.v2.dream.created' && event.correlationId === old.id), false)
    assert.equal(f.loop.exportState().contextDocument!.information.length, 0)
  } finally { f.close() }
})

test('Normalize feeds the organizer suggestions alongside intact source spans and both claims', async () => {
  let mainCalls = 0, normalized = 0
  const llm: RuntimeLlm = { getConfig: config, chat: async () => {
    if (++mainCalls === 1) return { provider: 'custom', model: 'test', raw: {}, text: '',
      toolCalls: [{ id: 'normalize-source', name: 'search_resources', arguments: { query: 'files' } }] }
    return reply({ status: 'completed', content: '已保留双方观点。' })
  } }
  const assist: RuntimeLlm = { getConfig: config, chat: async request => {
    normalized++
    const sources = promptData(request, '[{"id":') as Array<{ id: string; text: string }>
    const claim = sources.find(source => source.text.includes('125'))
    return answer(request, { observations: claim ? [{ sourceRefs: [claim.id], normalizedContent: '来源 A 125，来源 B 120。' }] : [] })
  } }
  let sawClaims = false
  const organizer: RuntimeLlm = { getConfig: config, chat: async request => {
    const input = JSON.parse(request.messages[1]!.content)
    const claim = input.sources.find((source: { text: string }) => source.text.includes('125'))
    if (claim) {
      assert.match(claim.text, /120/)
      assert.deepEqual(input.normalizationSuggestions, [{ sourceRefs: [claim.id], normalizedContent: '来源 A 125，来源 B 120。' }])
      sawClaims = true
    }
    return reply({ organizationVersion: 1, mode: 'organize', snapshotId: input.snapshotId, observations: [], diffProposals: [],
      archiveProposals: [], recallProposals: [], coverageProposal: null, uncertainties: [] })
  } }
  const f = fixture({ llm, contextAssistant: { llm: assist }, contextOrganization: { minGroups: 1, llm: organizer } }, ['normalize'])
  try {
    f.send('chat.message.send', { autoStart: true, clientMessageId: 'normalize-user',
      content: [{ type: 'text', text: '退款证据两方并列。来源 A 125，来源 B 120。' }] })
    await f.until('run.state.changed', event => event.payload.status === 'completed')
    assert.equal(mainCalls, 2)
    assert.ok(normalized > 0 && sawClaims)
    const db = new DatabaseSync(path.join(f.root, '.capybara/sessions.sqlite'))
    try {
      const roles = db.prepare('SELECT DISTINCT role, run_id FROM runtime_model_budget_attempts').all()
      assert.ok(['main', 'normalize', 'organize'].every(role => roles.some(row => row.role === role)))
      assert.equal(new Set(roles.map(row => row.run_id)).size, 2)
      assert.ok(roles.some(row => row.role === 'organize' && String(row.run_id).endsWith(':organize')))
    } finally { db.close() }
    const state = f.loop.exportState()
    assert.ok(state.contextHistory!.messages.some(item => item.message.content.includes('125')))
    assert.equal(state.contextHistory!.coverage.coveredThrough, 0)
    assert.equal(state.contextDocument!.information.length, 0)
  } finally { f.close() }
})

test('a configured auxiliary profile receives Recall over HTTP with its own model and without execution tools', async () => {
  const requests: Array<{ model: string; tools?: unknown; messages: Array<{ content: string }> }> = []
  const server = http.createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      requests.push(body)
      const lines = body.messages[0].content.split('\n') as string[]
      const { snapshotId } = JSON.parse(lines.find(line => line.startsWith('{"organizationVersion":1,"snapshotId":'))!)
      const { candidates } = JSON.parse(lines.find(line => line.startsWith('{"query":'))!)
      const content = JSON.stringify({ organizationVersion: 1, mode: 'recall', snapshotId, uncertainties: [],
        recallProposals: [{ id: candidates[0].id, reason: '匹配任务的项目材料' }] })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ id: 'test-profile-call', object: 'chat.completion', model: 'small-context-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }))
    } catch (error) {
      response.writeHead(500)
      response.end(String(error))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const f = fixture({}, ['recall'])
  try {
    const settings = new ProjectResources(f.root)
    try {
      assert.throws(() => settings.resolveSettings({ context_assistant_profile: 'missing' }), /existing LLM profile/)
      const llm = settings.readSettings().llm
      settings.saveSettings({
        context_assistant_profile: 'small-context',
        llm: { ...llm, profiles: [...llm.profiles, { id: 'small-context', name: 'Small context model',
          provider: 'custom', model: 'small-context-model', base_url: `http://127.0.0.1:${address.port}/v1`,
          protocol: 'chat-completions', max_retries: 0 }] },
      })
      assert.equal(settings.readSettings().context_assistant_profile, 'small-context')
    } finally { settings.close() }
    f.observe('当前可召回的退款记录。')
    f.send('runtime.context.v2.memory.recall', { query: '退款', limit: 1 })
    const event = await f.until('runtime.context.v2.memory.recalled')
    assert.equal(event.payload.hits[0]!.reason, '匹配任务的项目材料')
    assert.equal(requests.length, 1)
    assert.equal(requests[0]!.model, 'small-context-model')
    assert.equal(requests[0]!.tools, undefined)
  } finally {
    f.close()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('the active task receives model-selected Recall results through its normal tool round', async () => {
  let rounds = 0
  const main: RuntimeLlm = { getConfig: config, chat: async request => {
    if (++rounds === 1) return { provider: 'custom', model: 'main', raw: {}, text: '',
      toolCalls: [{ id: 'recall-evidence', name: 'recall_context', arguments: { query: '退款', limit: 1 } }] }
    const tool = request.messages.find(item => item.role === 'tool' && item.name === 'recall_context')
    assert.ok(tool)
    const outcome = JSON.parse(tool.content)
    assert.equal(outcome.ok, true)
    assert.equal(outcome.result.hits[0].reason, '需要核对 B 的原件')
    assert.match(outcome.result.hits[0].body, /120/)
    return reply({ status: 'completed', content: '已取得待核对的来源。' })
  } }
  const f = fixture({ llm: main, contextAssistant: { llm: { getConfig: config, chat: async request => {
    const { candidates } = promptData(request, '{"query":')
    const hit = candidates.find((item: { body: string }) => item.body.includes('120'))
    return answer(request, { recallProposals: [{ id: hit.id, reason: '需要核对 B 的原件' }] })
  } } } }, ['recall'])
  try {
    f.observe('退款来源 A 125 元。')
    f.observe('退款来源 B 120 元。')
    f.send('chat.message.send', { clientMessageId: 'recall-active', autoStart: true, content: [{ type: 'text', text: '找出待核对的退款来源。' }] })
    await f.until('run.state.changed', event => event.payload.status === 'completed')
    assert.equal(rounds, 2)
    assert.equal(f.loop.exportState().contextDocument!.information.length, 0)
  } finally { f.close() }
})
