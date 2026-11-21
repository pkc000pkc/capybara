import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { ContextCommitStore } from '#core/context-commit-store'
import { ContextDocumentEngine } from '#core/context-document-engine'
import { ContextHistory } from '#core/context-history'
import { recallContext, validateRecallQuery } from '#core/context-recall'
import { initializeProjectDirectory } from '#core/project-initializer'
import { RuntimeLoop, type RuntimeLlm } from '#core/runtime-loop'
import { validateContextTrainingSample } from '#core/context-training-recorder'
import { withAssetWritePolicy } from '#core/asset-write-policy'
import { CONTEXT_RECALL_MAX_QUERY_CHARACTERS, CONTEXT_RECALL_MAX_RESULTS, parseClientCommand,
  type ClientCommand, type ControlEnvelopeV2, type RuntimeContextMemoryRecallResult } from '#protocol/runtime-protocol'
import type { LlmChatRequest, LlmChatResponse } from '#util/llm'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const config: RuntimeLlm['getConfig'] = () => ({ provider: 'custom', protocol: 'responses', model: 'test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 })

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-recall-'))
  initializeProjectDirectory(root)
  const store = new ContextCommitStore(root)
  const project = ContextDocumentEngine.create({ sessionId: 'project-context', projectId: root, constitutionRevision: 'v2' })
  const projectText = '项目退款规范：证据 A 记录 125 美元；保留来源，跨会话使用前复核。'
  const classification = { durability: 'project' as const, target: 'project' as const, confidence: 'high' as const, reason: '用户明确声明项目规则', projectAnchors: ['project:explicit:policy'] }
  const evidence = project.addEvidence({ kind: 'message', referenceId: 'project-source', sessionId: 'producer-session', sourceHash: hash(projectText), observedAt: '2026-11-01T00:00:00Z' })
  const candidate = project.addCandidate({ source: { actor: 'user', sourceId: 'project-source', capturedAt: '2026-11-01T00:00:00Z' }, rawArtifactId: 'project-source', normalizedContent: projectText, evidenceRefs: [evidence.id], classification })
  const added = project.apply(project.propose({ projection: project.project({ id: 'seed-add', maxCharacters: 12000 }), candidateId: candidate.id,
    target: { section: 'information', headingPath: ['退款规范'] }, operation: 'add_entry', payload: { body: projectText }, actor: 'system', idempotencyKey: 'project-seed' }))
  project.apply(project.propose({ projection: project.project({ id: 'seed-archive', maxCharacters: 12000, includeStatuses: ['accepted'] }), candidateId: candidate.id,
    target: { section: 'information', entryId: added.changedEntryIds[0] }, operation: 'mark_status', payload: { status: 'archived' }, actor: 'system', idempotencyKey: 'project-archive' }))
  store.seedProject(project.exportState())
  const producer = new ContextHistory()
  producer.append({ id: 'project-source', origin: 'user', message: { role: 'user', content: projectText } }, (entry) => store.appendMessage('producer-session', entry))
  producer.append({ id: 'unrelated-source', origin: 'user', message: { role: 'user', content: '另一会话私有备注，不属于项目知识。' } }, (entry) => store.appendMessage('producer-session', entry))
  const session = ContextDocumentEngine.create({ sessionId: 'recall-session', projectId: root, constitutionRevision: 'v2' })
  const history = new ContextHistory()
  history.append({ id: 'old-call', origin: 'model', message: { role: 'assistant', content: '读取历史退款依据', toolCalls: [{ id: 'old-read', name: 'read_file', arguments: {} }] } })
  const rawText = '未归档秘密😺前缀。归档退款依据：证据 B 记录 120 美元。未归档尾部'
  history.append({ id: 'raw-refund', origin: 'tool', sourceArtifactId: 'raw-refund-artifact', rawContent: rawText,
    message: { role: 'tool', name: 'read_file', toolCallId: 'old-read', content: '归档退款依据' } })
  const start = rawText.indexOf('归档退款依据'), end = rawText.indexOf('未归档尾部')
  const spans = [
    { sourceRef: `old-call:span:0:${history.snapshot().messages[0]!.message.content.length}`, messageId: 'old-call', start: 0, end: history.snapshot().messages[0]!.message.content.length, sourceHash: hash(history.snapshot().messages[0]!.message.content) },
    { sourceRef: `raw-refund:span:${start}:${end}`, messageId: 'raw-refund', start, end, sourceHash: hash(rawText) },
  ]
  const archive = { id: 'source-archive', scope: 'session' as const, sourceMessageIds: ['old-call', 'raw-refund'], sourceRefs: spans.map((span) => span.sourceRef), sourceSpans: spans, receiptId: 'archive-receipt', reason: '历史证据暂存' }
  const state = history.snapshot()
  state.coverage = { coveredThrough: 2, retainedMessageIds: [], commitId: 'seed-commit', receiptIds: ['archive-receipt'] }
  store.commit({ id: 'seed-commit', sessionId: 'recall-session', expectedProjectRevision: project.snapshot().revision, expectedSessionRevision: 0,
    project: project.exportState(), session: session.exportState(), projectChanged: false, history: state, archives: [archive], receiptIds: ['archive-receipt'] })
  return { root, store, project, session, rawText, cleanup: () => { store.close(); fs.rmSync(root, { recursive: true, force: true }) } }
}

test('two scopes recall opposing sources as pending candidates and never rewrite project knowledge', () => {
  const f = fixture()
  try {
    const beforeProject = f.project.exportState(), beforeSession = f.session.exportState()
    const { session, result } = recallContext({ recallId: 'recall-test', query: { query: '退款', scope: 'both', limit: 10 }, project: beforeProject, session: beforeSession, store: f.store, sessionId: 'recall-session' })
    assert.ok(result.hits.some((hit) => hit.scope === 'project' && hit.body.includes('125')))
    assert.ok(result.hits.some((hit) => hit.sourceKind === 'source_archive' && hit.body.includes('120')))
    assert.ok(result.hits.filter((hit) => hit.sourceKind === 'source_archive').every((hit) => hit.sourceRef?.includes(':span:')))
    for (const hit of result.hits.filter((item) => item.sourceKind === 'source_archive')) {
      assert.ok(hit.excerpt.start + hit.body.length <= hit.excerpt.totalCharacters)
      if (hit.body.includes('120')) { assert.equal(hit.excerpt.totalCharacters, f.rawText.length); assert.equal(hit.excerpt.truncated, true) }
    }
    assert.ok(result.candidates.every((candidate) => candidate.status === 'pending' && candidate.actor === 'memory'))
    assert.equal(session.document.information.length, 0)
    assert.deepEqual(f.project.exportState(), beforeProject)
    assert.deepEqual(f.session.exportState(), beforeSession)
    assert.ok(result.hits.every((hit) => hit.body.length <= 1600 && hit.evidenceRefs.length > 0))
    const second = recallContext({ recallId: 'recall-again', query: { query: '退款', limit: 10 }, project: beforeProject, session, store: f.store, sessionId: 'recall-session' })
    assert.equal(second.session.document.candidates.length, session.document.candidates.length, 'repeated retrieval reuses the same source candidates')
    const sessionOnly = recallContext({ recallId: 'recall-session', query: { query: '退款', scope: 'session' }, project: beforeProject, session: beforeSession, store: f.store, sessionId: 'recall-session' })
    assert.ok(sessionOnly.result.hits.every((hit) => hit.scope === 'session'))
    const archivedOnly = recallContext({ recallId: 'archive-only', query: { query: '退款', scope: 'both', sourceKind: 'source_archive' },
      project: beforeProject, session: beforeSession, store: f.store, sessionId: 'recall-session' }).result
    assert.equal(archivedOnly.sourceKind, 'source_archive')
    assert.ok(archivedOnly.hits.some(hit => hit.body.includes('120')))
    assert.ok(archivedOnly.hits.every(hit => hit.sourceKind === 'source_archive' && hit.scope === 'session'))
    const wrongScope = recallContext({ recallId: 'archive-project', query: { query: '退款', scope: 'project', sourceKind: 'source_archive' },
      project: beforeProject, session: beforeSession, store: f.store, sessionId: 'recall-session' }).result
    assert.deepEqual(wrongScope.hits, [])
    assert.deepEqual(wrongScope.candidates, [])
    const recallCommand = { version: 1, kind: 'command', id: 'recall-boundary', timestamp: new Date().toISOString(),
      type: 'runtime.context.v2.memory.recall', sessionId: 'recall-session' }
    const valid = { query: 'x'.repeat(CONTEXT_RECALL_MAX_QUERY_CHARACTERS), scope: 'session' as const, sourceKind: 'source_archive' as const, limit: CONTEXT_RECALL_MAX_RESULTS }
    assert.deepEqual(parseClientCommand({ ...recallCommand, payload: valid }, 'recall-session').payload, valid)
    assert.doesNotThrow(() => validateRecallQuery(valid))
    for (const invalid of [{ query: '' }, { query: 'x'.repeat(CONTEXT_RECALL_MAX_QUERY_CHARACTERS + 1) },
      { query: 'x', scope: 'other' }, { query: 'x', sourceKind: 'any' }, { query: 'x', limit: CONTEXT_RECALL_MAX_RESULTS + 1 }]) {
      assert.throws(() => validateRecallQuery(invalid as any), /CONTEXT_RECALL_/)
      assert.throws(() => parseClientCommand({ ...recallCommand, payload: invalid }, 'recall-session'), { code: 'INVALID_PAYLOAD' })
    }
  } finally { f.cleanup() }
})

test('source archive search respects exact UTF-16 spans and session isolation after reopening', () => {
  const f = fixture()
  let reopened: ContextCommitStore | undefined
  try {
    f.store.close()
    const legacy = new DatabaseSync(path.join(f.root, '.capybara', 'sessions.sqlite'))
    legacy.exec("UPDATE context_archives SET state_json=json_remove(state_json, '$.sourceSpans'); DELETE FROM context_archive_spans;")
    legacy.close()
    reopened = new ContextCommitStore(f.root)
    const matches = reopened.searchArchivedSources('recall-session', ['退款'], 10)
    assert.ok(matches.some((match) => match.text.includes('120')))
    assert.equal(matches.find((match) => match.messageId === 'raw-refund')!.text, '归档退款依据：证据 B 记录 120 美元。')
    assert.deepEqual(reopened.searchArchivedSources('recall-session', ['未归档秘密'], 10), [])
    assert.deepEqual(reopened.searchArchivedSources('other-session', ['退款'], 10), [])
    assert.deepEqual(reopened.searchArchivedSources('recall-session', ['另一会话私有备注'], 10), [])
  } finally { reopened?.close(); f.cleanup() }
})

test('repeated archive receipts cannot consume the recall limit for distinct originals', () => {
  const f = fixture()
  try {
    const last = f.store.lastCommit('recall-session')!
    const original = last.archives[0]!.sourceSpans!.find(span => span.messageId === 'raw-refund')!
    const other = { ...original, sourceRef: `raw-refund:span:0:${original.start}`, start: 0, end: original.start }
    const archives = [original, original, other].map((span, index) => ({
      id: `repeated-archive-${index}`, scope: 'session' as const, sourceMessageIds: [span.messageId], sourceRefs: [span.sourceRef],
      sourceSpans: [span], receiptId: `repeat-receipt-${index}`, reason: '原件片段归档复验',
    }))
    f.store.commit({ ...last, id: 'repeated-archive-proposals', coverageAdvanced: false, archives,
      expectedSessionRevision: last.session.document.revision, receiptIds: archives.map(archive => archive.receiptId) })
    const matches = f.store.searchArchivedSources('recall-session', ['归档'], 2)
    assert.deepEqual(new Set(matches.map(match => match.sourceRef)), new Set([original.sourceRef, other.sourceRef]))
    assert.equal(matches.find(match => match.sourceRef === original.sourceRef)?.archiveId, 'source-archive')
  } finally { f.cleanup() }
})

test('recall prefers a complete archived original span over an equally relevant artifact page', () => {
  const f = fixture()
  try {
    const last = f.store.lastCommit('recall-session')!
    const history = new ContextHistory(last.history)
    const original = '归档退款依据：证据 B 记录 120 美元。'
    const page = JSON.stringify({ ok: true, result: { artifact_id: 'raw-refund-artifact', offset: 0, content: original + '附带文字'.repeat(500) } })
    history.append({ id: 'page-call', origin: 'model', message: { role: 'assistant', content: '', toolCalls: [{ id: 'page-read', name: 'read_runtime_artifact', arguments: {} }] } })
    history.append({ id: 'derived-page', origin: 'tool', sourceArtifactId: 'derived-page-artifact', rawContent: page,
      message: { role: 'tool', name: 'read_runtime_artifact', toolCallId: 'page-read', content: page } })
    const span = { sourceRef: `derived-page:span:0:${page.length}`, messageId: 'derived-page', start: 0, end: page.length, sourceHash: hash(page) }
    const archive = { id: 'derived-page-archive', scope: 'session' as const, sourceMessageIds: [span.messageId], sourceRefs: [span.sourceRef],
      sourceSpans: [span], receiptId: 'page-archive-receipt', reason: '归档分页回执' }
    f.store.commit({ ...last, id: 'derived-page-commit', history: history.snapshot(), expectedSessionRevision: last.session.document.revision,
      coverageAdvanced: false, archives: [archive], receiptIds: [archive.receiptId] })
    assert.equal(f.store.searchArchivedSources('recall-session', ['120', '美元'], 1)[0]!.referenceId, 'raw-refund-artifact')
    const { result } = recallContext({ recallId: 'original-first', query: { query: '120 美元', scope: 'session', limit: 2 },
      project: f.project.exportState(), session: f.session.exportState(), store: f.store, sessionId: 'recall-session' })
    assert.equal(result.hits[0]!.body, original)
    assert.equal(result.hits[0]!.excerpt.truncated, true)
    assert.equal(result.hits[0]!.excerpt.complete, true)
    assert.ok(!result.uncertainties.includes(`excerpt_requires_source_read:${result.hits[0]!.candidateId}`))
    assert.ok(result.hits[1]!.body.includes(original) && result.hits[1]!.body.length < page.length)
    assert.equal(result.hits[1]!.excerpt.complete, false)
    assert.ok(result.uncertainties.includes(`excerpt_requires_source_read:${result.hits[1]!.candidateId}`))
  } finally { f.cleanup() }
})

function command(type: ClientCommand['type'], payload: unknown, sessionId = 'recall-session'): ClientCommand {
  return { version: 1, kind: 'command', id: `command-${Math.random()}`, type, payload, sessionId, timestamp: new Date().toISOString() } as ClientCommand
}

function waitForCompletion(loop: RuntimeLoop) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('recall run timed out')) }, 12000)
    const off = loop.onEvent((event) => {
      if (event.type !== 'run.state.changed' || !['completed', 'failed'].includes(event.payload.status)) return
      clearTimeout(timer); off()
      event.payload.status === 'completed' ? resolve() : reject(new Error(event.payload.failure?.message))
    })
  })
}

test('a real model tool round recalls frozen project memory then applies an evidence-bound session diff', async () => {
  const f = fixture()
  let loop: RuntimeLoop | undefined
  const requests: LlmChatRequest[] = []
  let recalled: Pick<RuntimeContextMemoryRecallResult, 'recallId' | 'hits'> | undefined
  const llm: RuntimeLlm = { getConfig: config, chat: async (request) => {
    requests.push(request)
    if (requests.length === 1) {
      assert.ok(request.tools?.some((tool) => tool.name === 'recall_context'))
      assert.equal(request.messages[0]!.content.includes(request.tools!.find((tool) => tool.name === 'recall_context')!.description!), false,
        'native tool descriptions are not duplicated in the system capability catalog')
      const projectBinding = JSON.parse(request.messages[0]!.content.match(/<!-- capybara:context-binding data=(\{"scope":"project",[^\n]+?\}) -->/)![1]!)
      assert.equal(projectBinding.documentId, f.project.snapshot().id, 'even an empty active project projection carries its real document binding')
      return { provider: 'custom', model: 'test', raw: {}, text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'recall-call', name: 'recall_context', arguments: { query: '退款', scope: 'both', limit: 5 } }] }
    }
    const system = request.messages[0]!.content
    const binding = JSON.parse(system.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)![0])
    const base: ControlEnvelopeV2 = { envelopeVersion: 2, binding, decision: 'continue', userMessage: '', actions: [], planProposal: null, candidateDiffs: [], evidenceRequests: [], uncertainties: [], waitSpec: null, completionCheck: null }
    if (requests.length === 2) {
      const result = JSON.parse(request.messages.find((message) => message.role === 'tool' && message.name === 'recall_context')!.content)
      assert.equal(result.ok, true, JSON.stringify(result))
      recalled = result.result
      assert.ok(recalled!.hits.some((hit) => hit.body.includes('120')))
      assert.ok(recalled!.hits.some((hit) => hit.body.includes('125')))
      assert.equal(loop!.exportState().contextDocument!.information.length, 0, 'retrieval alone never promotes facts')
      const contextBinding = JSON.parse(system.match(/<!-- capybara:context-binding data=(\{"scope":"session",[^\n]+?\}) -->/)![1]!)
      base.decision = 'propose_diff'
      base.candidateDiffs = recalled!.hits.filter((hit) => hit.body.includes('120') || hit.body.includes('125')).map((hit, index) => ({ ...contextBinding,
        candidateId: hit.candidateId!, target: { section: 'information', headingPath: ['召回依据'] },
        operation: 'add_entry', payload: { body: hit.body, evidenceRefs: hit.evidenceRefs }, idempotencyKey: `recalled-refund-diff-${index}` }))
    } else {
      assert.equal(requests.length, 3)
      assert.match(system, /证据 B 记录 120 美元/)
      assert.match(system, /证据 A 记录 125 美元/)
      base.decision = 'finish'; base.userMessage = '已找回并分别保留两方记录。'
      base.completionCheck = { taskId: binding.taskId, requiredActions: ['tool:recall_context'], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '已验证召回及文档提交' }
    }
    return { provider: 'custom', model: 'test', raw: {}, text: JSON.stringify(base) }
  } }
  loop = new RuntimeLoop({ projectDir: f.root, llm, stepDelayMs: 0, streamDelayMs: 0 })
  try {
    await withAssetWritePolicy({ projectDir: f.root, readonly: true, onAudit: () => {} }, async () => {
      const finished = waitForCompletion(loop!)
      const send = command('chat.message.send', { clientMessageId: 'question', content: [{ type: 'text', text: '找回之前的退款依据，分别保留两种来源。' }], autoStart: true })
      loop!.validate(send); loop!.execute(send, 1)
      await finished
    })
    const state = loop.exportState()
    assert.ok(f.store.loadRecall('recall-session', recalled!.recallId))
    assert.ok(state.contextDocument!.information.some((entry) => entry.body.includes('120')))
    assert.equal(f.store.loadDocument()!.document.information[0]!.status, 'archived')
    const samples = loop.getContextTrainingSamples().filter((sample) => sample.decision?.recalls?.length)
    assert.ok(samples.length)
    for (const sample of samples) assert.deepEqual(validateContextTrainingSample(sample), [])
    assert.ok(samples.some((sample) => sample.decision!.recalls![0]!.sources?.some((source) => source.scope === 'project')))
    assert.ok(samples.some((sample) => sample.decision!.recalls![0]!.sources?.some((source) => source.sourceRef?.startsWith('raw-refund:span:'))))
  } finally { loop.close(); f.cleanup() }
})

test('a scoped evidence request accepts recalled material only with its stored recall receipt', async () => {
  const f = fixture()
  let loop: RuntimeLoop | undefined
  let rounds = 0, source: { candidateId: string; recallId: string } | undefined
  const llm: RuntimeLlm = { getConfig: config, chat: async request => {
    const system = request.messages[0]!.content
    const binding = JSON.parse(system.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)![0])
    const base: ControlEnvelopeV2 = { envelopeVersion: 2, binding, decision: 'continue', userMessage: '', actions: [],
      planProposal: null, candidateDiffs: [], evidenceRequests: [], uncertainties: [], waitSpec: null, completionCheck: null }
    const tool = (id: string, name: string, args: Record<string, unknown>): LlmChatResponse =>
      ({ provider: 'custom', model: 'test', raw: {}, text: '', toolCalls: [{ id, name, arguments: args }] })
    rounds++
    if (rounds === 1 || rounds === 6) {
      base.decision = 'propose_plan'
      base.planProposal = { basePlanRevision: rounds === 1 ? 0 : 1, goal: '核对归档来源', tasks: [{ id: 'recall-proof', title: '查找记忆',
        owner: 'parent', phase: 'investigation', dependsOn: [], capabilityIds: ['recall_context'], completionConditions: ['获得可核验的召回材料'],
        requiredActions: rounds === 1 ? [] : ['call:valid-recall-source'], evidenceRefs: [], status: rounds === 1 ? 'pending' : 'completed' }] }
    } else if (rounds === 2) {
      base.evidenceRequests = [{ id: 'archived-proof', question: '请取回已归档退款依据', sourceKinds: ['memory'], relatedTaskIds: ['recall-proof'] }]
    } else if (rounds === 3) {
      assert.match(system, /"phase":"evidence"/)
      return tool('scoped-recall', 'recall_context', { query: '退款', scope: 'both', source_kind: 'source_archive', limit: 5 })
    } else if (rounds === 4 || rounds === 5) {
      const block = loop!.getSnapshot(0).taskControl!.branchBlocks![0]!
      if (rounds === 4) {
        const result = JSON.parse(request.messages.find(message => message.role === 'tool' && message.name === 'recall_context')!.content).result
        assert.equal(result.sourceKind, 'source_archive')
        assert.ok(result.hits.every((hit: { sourceKind: string }) => hit.sourceKind === 'source_archive'))
        const hit = result.hits.find((hit: { body: string }) => hit.body.includes('120'))
        assert.deepEqual(hit.excerpt, { start: f.rawText.indexOf('归档退款依据'), totalCharacters: f.rawText.length, complete: true, sourceHasMore: true })
        source = { recallId: result.recallId, candidateId: hit.candidateId }
        return tool('wrong-recall-source', 'submit_branch_evidence', { request_id: block.id, candidate_id: source.candidateId, recall_id: 'invented' })
      }
      assert.match(request.messages.at(-1)!.content, /BRANCH_RECALL_EVIDENCE_UNVERIFIED/)
      return tool('valid-recall-source', 'submit_branch_evidence', { request_id: block.id, candidate_id: source!.candidateId, recall_id: source!.recallId })
    } else {
      assert.equal(rounds, 7)
      base.decision = 'finish'; base.userMessage = '已找到并保留原始来源。'
      base.completionCheck = { taskId: binding.taskId, summary: '实际召回已登记', requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [] }
    }
    return { provider: 'custom', model: 'test', raw: {}, text: JSON.stringify(base) }
  } }
  loop = new RuntimeLoop({ projectDir: f.root, llm, stepDelayMs: 0, streamDelayMs: 0, contextOrganization: { minGroups: 100 } })
  try {
    const completed = waitForCompletion(loop)
    const send = command('chat.message.send', { clientMessageId: 'scoped-recall-question', content: [{ type: 'text', text: '查找之前的退款依据' }], autoStart: true, planningRequired: true })
    loop.validate(send); loop.execute(send, 1)
    await completed
    assert.ok(f.store.loadRecall('recall-session', source!.recallId))
    const state = loop.exportState()
    assert.equal(state.contextDocument!.information.length, 0)
    assert.equal(state.contextDocument!.candidates.find(candidate => candidate.id === source!.candidateId)?.status, 'pending')
    assert.equal(state.snapshot.observations.items.find(item => item.callId === 'wrong-recall-source')?.status, 'failed')
  } finally { loop.close(); f.cleanup() }
})

test('source paging admits approved project origins and refuses unrelated sessions', () => {
  const f = fixture()
  const loop = new RuntimeLoop({ projectDir: f.root, llm: { getConfig: config, chat: async () => { throw new Error('unused') } } })
  try {
    const duplicate = new ContextHistory()
    duplicate.append({ id: 'project-source', origin: 'user', message: { role: 'user', content: '同名但未获项目批准的另一会话信息' } }, (entry) => f.store.appendMessage('unrelated-duplicate-session', entry))
    assert.throws(() => f.store.readSource('project-source'), /AMBIGUOUS/)
    loop.execute(command('runtime.snapshot.get', {}, 'fresh-session'), 1)
    const read = (args: unknown) => (loop as any).readRuntimeArtifactTool(args)
    const result = read({ artifact_id: 'project-source', source_scope: 'project', limit: 8000 })
    assert.equal(result.source_scope, 'project')
    assert.match(result.content, /125 美元/)
    assert.ok(result.content.length <= 2000)
    assert.throws(() => read({ artifact_id: 'unrelated-source' }), /not found/)
    assert.throws(() => read({ artifact_id: 'project-source', source_scope: 'session' }), /not found/)
    assert.throws(() => read({ artifact_id: 'raw-refund-artifact' }), /not found/)
  } finally { loop.close(); f.cleanup() }
})

test('a recall journal failure rolls back its new candidates and emits no success', () => {
  const f = fixture()
  const loop = new RuntimeLoop({ projectDir: f.root, llm: { getConfig: config, chat: async () => { throw new Error('unused') } } })
  const injector = new DatabaseSync(f.store.databaseFile)
  try {
    loop.execute(command('runtime.snapshot.get', {}), 1)
    const before = loop.exportState().contextDocument!
    const stored = f.store.loadDocument('recall-session')
    const emitted: string[] = []
    loop.onEvent((event) => emitted.push(event.type))
    injector.exec("CREATE TRIGGER reject_recall BEFORE INSERT ON context_recalls BEGIN SELECT RAISE(ABORT, 'TEST_RECALL_JOURNAL_FAILED'); END")
    const recall = command('runtime.context.v2.memory.recall', { query: '退款', scope: 'both' })
    assert.throws(() => loop.execute(recall, 2), /TEST_RECALL_JOURNAL_FAILED/)
    assert.deepEqual(loop.exportState().contextDocument, before)
    assert.deepEqual(f.store.loadDocument('recall-session'), stored)
    assert.equal(emitted.includes('runtime.context.v2.memory.recalled'), false)
  } finally { injector.close(); loop.close(); f.cleanup() }
})
