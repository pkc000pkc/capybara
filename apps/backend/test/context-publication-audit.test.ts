import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { ContextCommitStore } from '#core/context-commit-store'
import { ContextDocumentEngine, proposalHash, type DiffProposal } from '#core/context-document-engine'
import { withAssetWritePolicy } from '#core/asset-write-policy'
import { initializeProjectDirectory } from '#core/project-initializer'
import { RuntimeLoop, type RuntimeLlm } from '#core/runtime-loop'
import { SessionStore } from '#core/session-store'
import type { ClientCommand, RuntimeContextDiffProposal, RuntimeEnvelope, ServerEvent } from '#protocol/runtime-protocol'

const llm: RuntimeLlm = { chat: async () => { throw new Error('no model call expected') }, getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }) }
const classification = { durability: 'project', target: 'project', confidence: 'high', reason: '用户明确指定项目长期规则', projectAnchors: ['project:explicit:auditing'] } as const
type EventPayloads = { [T in ServerEvent['type']]: Extract<ServerEvent, { type: T }>['payload'] }
const makeEngine = (root: string, sessionId: string) => ContextDocumentEngine.create({ sessionId, projectId: root, constitutionRevision: 'test' })
function fixture(actor: RuntimeLlm = llm) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-publication-audit-'))
  initializeProjectDirectory(root)
  let loop = new RuntimeLoop({ projectDir: root, llm: actor, sessionId: 'journal-session', stepDelayMs: 0, streamDelayMs: 0 })
  const store = new ContextCommitStore(root), injector = new DatabaseSync(store.databaseFile)
  const events: ServerEvent[] = []
  let sequence = 0
  const listen = () => loop.onEvent(event => events.push(event as ServerEvent))
  listen()
  const send = (type: ClientCommand['type'], payload: unknown) => {
    const command = { version: 1, kind: 'command', id: `journal-${++sequence}`, sessionId: 'journal-session', timestamp: new Date().toISOString(), type, payload } as ClientCommand
    loop.validate(command); loop.execute(command, sequence)
  }
  const latest = <T extends ServerEvent['type']>(type: T): EventPayloads[T] => {
    const event = [...events].reverse().find(event => event.type === type)
    assert.ok(event, `missing ${type}`); return event.payload as unknown as EventPayloads[T]
  }
  const proposal = (scope: 'project' | 'session', key: string): RuntimeContextDiffProposal => {
    const document = scope === 'project' ? loop.exportState().projectContextDocument! : loop.exportState().contextDocument!
    send('runtime.context.v2.observe', { observation: { scope, documentId: document.id,
      candidate: { source: { actor: 'user', sourceId: key, capturedAt: new Date().toISOString() }, rawArtifactId: key, normalizedContent: `${key} 的原始材料`, ...(scope === 'project' ? { classification } : {}) },
      evidence: { kind: 'message', referenceId: key } } })
    const observed = latest('runtime.context.v2.observed')
    send('runtime.context.v2.project', { scope, profileId: key, maxCharacters: 16000 })
    const { projection } = latest('runtime.context.v2.projection.created')
    return { id: key, scope, documentId: document.id, baseRevision: projection.documentRevision, projectionId: projection.id, projectionHash: projection.contentHash,
      target: { section: 'information' }, operation: 'add_entry', payload: { body: `${key} 的整理内容`, evidenceRefs: [observed.evidence!.id] }, candidateId: observed.candidate.id,
      idempotencyKey: key, actor: 'model', createdAt: new Date().toISOString() }
  }
  const envelope = (proposals: RuntimeContextDiffProposal[], requestId: string): RuntimeEnvelope => ({
    envelopeVersion: 1, sessionId: 'journal-session', runId: 'journal-run', requestId, decision: 'propose_diff', actions: [], evidenceRequests: [], uncertainties: [],
    candidateDiffs: proposals.map(p => ({ ...p, ...p.payload, evidenceRefs: p.payload.evidenceRefs ?? [], targetEntryId: p.target.entryId, headingPath: p.target.headingPath })),
  })
  return { root, store, injector, events, send, latest, proposal, envelope, get loop() { return loop },
    reopen() { loop.close(); loop = new RuntimeLoop({ projectDir: root, llm: actor, sessionId: 'journal-session', stepDelayMs: 0, streamDelayMs: 0 }); listen() },
    applyEnvelope(value: RuntimeEnvelope, requestId?: string) { (loop as unknown as { applyV2EnvelopeDiffs(value: RuntimeEnvelope, id: string, requestId?: string): void }).applyV2EnvelopeDiffs(value, `envelope-${++sequence}`, requestId) },
    close() { injector.close(); store.close(); loop.close(); fs.rmSync(root, { recursive: true, force: true }) },
  }
}

test('a published projection survives closing before any knowledge diff, for both scopes', () => {
  const f = fixture()
  try {
    const proposals = [f.proposal('project', 'project-policy'), f.proposal('session', 'session-observation')]
    const published = f.store.readPublications('journal-session')
    assert.equal(published.length, 2)
    const documents = f.loop.exportState()
    f.reopen()
    assert.equal(f.loop.exportState().projectContextDocument!.revision, documents.projectContextDocument!.revision)
    assert.equal(f.loop.exportState().contextDocument!.revision, documents.contextDocument!.revision)
    for (const p of proposals) {
      f.send('runtime.context.v2.apply', { proposal: p })
      assert.equal(f.latest('runtime.context.v2.receipt.created').receipt.result, 'applied')
    }
    const outcomes = f.store.readOutcomes('journal-session')
    assert.equal(outcomes.length, 2)
    assert.deepEqual(new Set(outcomes.map(o => o.scope)), new Set(['project', 'session']))
    f.reopen()
    assert.equal(f.loop.exportState().projectContextDocument!.information[0]!.body, proposals[0]!.payload.body)
    assert.equal(f.loop.exportState().contextDocument!.information[0]!.body, proposals[1]!.payload.body)
  } finally { f.close() }
})

test('a failed negative audit rolls back memory; restart preserves the original rejection and conflicting attempts', () => {
  const f = fixture()
  try {
    const p = f.proposal('project', 'negative-policy')
    p.classification = { durability: 'session', target: 'session', confidence: 'high', reason: '临时会话信息', projectAnchors: [] }
    const before = f.loop.exportState()
    f.injector.exec("CREATE TRIGGER fail_negative_attempt BEFORE INSERT ON context_outcome_attempts BEGIN SELECT RAISE(ABORT, 'TEST_NEGATIVE_AUDIT_FAILED'); END")
    assert.throws(() => f.send('runtime.context.v2.apply', { proposal: p }), /TEST_NEGATIVE_AUDIT_FAILED/)
    assert.deepEqual(f.loop.exportState().projectContextDocumentReceipts, before.projectContextDocumentReceipts)
    assert.equal(f.store.readOutcomes('journal-session').length, 0)
    assert.equal(f.events.some(e => e.type === 'runtime.context.v2.receipt.created'), false)
    f.injector.exec('DROP TRIGGER fail_negative_attempt')
    f.send('runtime.context.v2.apply', { proposal: p })
    const original = f.latest('runtime.context.v2.receipt.created').receipt
    assert.equal(original.errorCode, 'PROJECT_CLASSIFICATION_MISMATCH')
    f.reopen()
    f.send('runtime.context.v2.apply', { proposal: { ...p, id: 'negative-retry' } })
    assert.deepEqual(f.latest('runtime.context.v2.receipt.created').receipt, original)
    f.send('runtime.context.v2.apply', { proposal: { ...p, id: 'changed-body', payload: { ...p.payload, body: '不得当作同一个提案' } } })
    assert.equal(f.latest('runtime.context.v2.receipt.created').receipt.errorCode, 'IDEMPOTENCY_KEY_CONFLICT')
    assert.equal(f.store.readOutcomes('journal-session').length, 3)
    assert.deepEqual(f.store.loadDocument()!.document, before.projectContextDocument)
    f.reopen()
    f.send('runtime.context.v2.apply', { proposal: { ...p, id: 'original-again' } })
    assert.deepEqual(f.latest('runtime.context.v2.receipt.created').receipt, original)
  } finally { f.close() }
})

test('unrelated project knowledge changes do not erase durable idempotency for a prior rejection', () => {
  const f = fixture()
  try {
    const p = f.proposal('project', 'rejected-before-change')
    p.classification = { durability: 'session', target: 'session', confidence: 'high', reason: '当前会话', projectAnchors: [] }
    f.send('runtime.context.v2.apply', { proposal: p })
    const original = f.latest('runtime.context.v2.receipt.created').receipt
    const independent = new ContextCommitStore(f.root)
    try {
      const base = independent.loadDocument()!, e = new ContextDocumentEngine(base.document, base.receipts, base.projections)
      const evidence = e.addEvidence({ kind: 'message', referenceId: 'other-session-source' })
      const candidate = e.addCandidate({ source: { actor: 'user', sourceId: 'other-session-source', capturedAt: new Date().toISOString() }, normalizedContent: '独立连接的项目材料', rawArtifactId: 'other-session-source', evidenceRefs: [evidence.id] })
      const receipt = e.apply(e.propose({ projection: e.project({ id: 'independent', maxCharacters: 12000 }), candidateId: candidate.id, target: { section: 'information' }, operation: 'add_entry', payload: { body: '独立连接的项目材料' }, actor: 'system', idempotencyKey: 'independent' }))
      assert.equal(receipt.result, 'applied')
      independent.saveProject(e.exportState(), base.document.revision)
    } finally { independent.close() }
    f.reopen()
    f.send('runtime.context.v2.apply', { proposal: { ...p, id: 'retry-after-change' } })
    assert.deepEqual(f.latest('runtime.context.v2.receipt.created').receipt, original)
  } finally { f.close() }
})

test('an interleaved two-scope envelope replays with new transport IDs and audits receipts against the right proposals', () => {
  const f = fixture()
  try {
    const p = f.proposal('project', 'interleaved-project'), s = f.proposal('session', 'interleaved-session')
    const extra = { ...p, id: 'project-extra', idempotencyKey: 'project-extra', payload: { ...p.payload, body: '同一投影的第二条项目内容' } }
    const values = [p, s, extra]
    f.applyEnvelope(f.envelope(values, 'first-request'))
    const originals = f.store.readOutcomes('journal-session')
    assert.equal(originals.length, 3)
    const state = f.loop.exportState()
    f.reopen()
    f.events.length = 0
    f.applyEnvelope(f.envelope(values, 'new-request-id'))
    assert.equal(f.store.readOutcomes('journal-session').length, 6)
    for (const o of f.store.readOutcomes('journal-session')) assert.equal(o.receipt.proposalHash, proposalHash(o.proposal))
    assert.equal(f.events.some(e => e.type === 'runtime.context.v2.receipt.created' && e.payload.receipt.result !== 'applied'), false)
    assert.deepEqual(f.loop.exportState().projectContextDocument, state.projectContextDocument)
    assert.deepEqual(f.loop.exportState().contextDocument, state.contextDocument)
    const replaySample = f.loop.getContextTrainingSamples().at(-1)!
    assert.deepEqual(new Set(replaySample.decision!.acceptedOperations), new Set(values.map(p => `envelope-new-request-id-${p.idempotencyKey}`)))
    const next = f.proposal('session', 'new-session-material')
    f.applyEnvelope(f.envelope([p, next, extra], 'mixed-replay-and-new'))
    assert.ok(f.loop.exportState().contextDocument!.information.some(e => e.body === next.payload.body))
    assert.deepEqual(f.loop.exportState().projectContextDocument, state.projectContextDocument)
  } finally { f.close() }
})

test('a successful document write and its audit roll back together if audit storage fails', () => {
  const f = fixture()
  try {
    const p = f.proposal('session', 'audit-atomic-fact'), before = f.loop.exportState()
    f.injector.exec("CREATE TRIGGER fail_success_audit BEFORE INSERT ON context_outcomes BEGIN SELECT RAISE(ABORT, 'TEST_SUCCESS_AUDIT_FAILED'); END")
    assert.throws(() => f.send('runtime.context.v2.apply', { proposal: p }), /TEST_SUCCESS_AUDIT_FAILED/)
    assert.deepEqual(f.loop.exportState().contextDocument, before.contextDocument)
    assert.deepEqual(f.loop.exportState().contextDocumentReceipts, before.contextDocumentReceipts)
    assert.deepEqual(f.store.loadDocument('journal-session')!.document, before.contextDocument)
    assert.equal(f.store.readOutcomes('journal-session').length, 0)
    assert.equal(f.events.some(e => e.type === 'runtime.context.v2.receipt.created'), false)
    f.injector.exec('DROP TRIGGER fail_success_audit')
    f.send('runtime.context.v2.apply', { proposal: p })
    assert.equal(f.latest('runtime.context.v2.receipt.created').receipt.result, 'applied')
  } finally { f.close() }
})

test('an aborted mixed replay batch preserves prior success while auditing only new work as rejected', () => {
  const f = fixture()
  try {
    const original = f.proposal('project', 'previously-committed')
    f.applyEnvelope(f.envelope([original], 'original-request'))
    const successful = f.store.readOutcomes('journal-session')[0]!.receipt
    const next = f.proposal('session', 'will-be-rejected')
    next.candidateId = 'missing-candidate'
    f.events.length = 0
    assert.throws(() => f.applyEnvelope(f.envelope([original, next], 'aborted-batch')), /CANDIDATE_NOT_FOUND/)
    const attempts = f.store.readOutcomes('journal-session').slice(-2)
    assert.deepEqual(attempts[0]!.receipt, successful)
    assert.equal(attempts[0]!.replayed, true)
    assert.equal(attempts[1]!.receipt.result, 'rejected')
    assert.equal(attempts[1]!.batchFailure, 'CANDIDATE_NOT_FOUND')
    assert.equal(f.loop.exportState().contextDocument!.information.length, 0)
    assert.equal(f.loop.exportState().projectContextDocument!.information.length, 1)
  } finally { f.close() }
})

test('an invalid envelope document binding is durably rejected without rewriting the original proposal', () => {
  const f = fixture()
  try {
    const p = f.proposal('session', 'wrong-document')
    p.documentId = 'another-document'
    assert.throws(() => f.applyEnvelope(f.envelope([p], 'wrong-document-request')), /diff document binding/)
    const [outcome] = f.store.readOutcomes('journal-session')
    assert.equal(outcome!.proposal.documentId, 'another-document')
    assert.equal(outcome!.receipt.result, 'rejected')
    assert.equal(f.loop.exportState().contextDocument!.information.length, 0)
  } finally { f.close() }
})

for (const restart of [false, true]) test(`a rolled-back batch can retry without relabeling its failed attempt (restart=${restart})`, () => {
  const f = fixture()
  try {
    const proposals = [f.proposal('project', 'retry-project'), f.proposal('session', 'retry-session')]
    f.injector.exec("CREATE TRIGGER fail_retry_document BEFORE INSERT ON context_documents WHEN NEW.scope_id='session:journal-session' BEGIN SELECT RAISE(ABORT, 'TEST_RETRY_DOCUMENT_FAILED'); END")
    assert.throws(() => f.applyEnvelope(f.envelope(proposals, 'failed-transaction')), /TEST_RETRY_DOCUMENT_FAILED/)
    const failed = f.store.readOutcomes('journal-session')
    assert.equal(failed.length, 2)
    assert.ok(failed.every(o => o.receipt.result === 'rejected' && o.batchFailure === 'TEST_RETRY_DOCUMENT_FAILED'))
    f.injector.exec('DROP TRIGGER fail_retry_document')
    if (restart) f.reopen()
    f.applyEnvelope(f.envelope(proposals, 'retry-transaction'))
    const attempts = f.store.readOutcomes('journal-session')
    assert.deepEqual(attempts.slice(0, 2), failed)
    assert.ok(attempts.slice(2).every(o => o.receipt.result === 'applied'))
    assert.equal(f.loop.exportState().contextDocument!.information.length, 1)
    assert.equal(f.loop.exportState().projectContextDocument!.information.length, 1)
    assert.equal(f.store.loadCoverage('journal-session')?.coveredThrough, 0)
  } finally { f.close() }
})

function waitForRun(f: ReturnType<typeof fixture>, expected: 'failed' | 'completed'): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`run did not reach ${expected}`)) }, 15000)
    const unsubscribe = f.loop.onEvent(event => {
      if (event.type !== 'run.state.changed' || !['failed', 'completed'].includes(event.payload.status)) return
      clearTimeout(timer); unsubscribe()
      if (event.payload.status === expected) resolve()
      else reject(new Error(`unexpected ${event.payload.status}: ${event.payload.failure?.message ?? ''}`))
    })
  })
}

test('the actual outbound model request is journaled with complete run/request identity before the model is called', async () => {
  let f: ReturnType<typeof fixture>, calls = 0
  const actor: RuntimeLlm = { ...llm, chat: async request => {
    calls++
    const system = request.messages.find(message => message.role === 'system')!.content
    const match = system.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)
    assert.ok(match)
    const binding = JSON.parse(match[0]), publicationId = JSON.stringify([binding.runId, binding.requestId])
    const publications = f.store.readPublications('journal-session').filter(p => p.channel === 'model' && p.publicationId === publicationId)
    assert.deepEqual(new Set(publications.map(p => p.scope)), new Set(['project', 'session']))
    for (const p of publications) assert.ok(system.includes(p.projection.markdown), 'journal contains only the actual outbound document')
    return { provider: 'custom', model: 'test', finishReason: 'stop', raw: {}, text: '{"status":"completed","content":"ok"}' }
  } }
  f = fixture(actor)
  try {
    for (let turn = 0; turn < 2; turn++) {
      const done = waitForRun(f, 'completed')
      f.send('chat.message.send', { content: [{ type: 'text', text: `只回复 OK：${turn}` }], clientMessageId: `model-publication-${turn}`, autoStart: true })
      await done
    }
    assert.equal(calls, 2)
    const publications = f.store.readPublications('journal-session').filter(p => p.channel === 'model')
    assert.equal(new Set(publications.map(p => p.publicationId)).size, 2, 'repeated timeline step IDs from different runs remain distinct')
  } finally { f.close() }
})

test('a model publication transaction failure prevents the outbound model call', async () => {
  let calls = 0
  const f = fixture({ ...llm, chat: async () => { calls++; throw new Error('model must not be called') } })
  try {
    f.injector.exec("CREATE TRIGGER fail_model_publication BEFORE INSERT ON context_publications WHEN NEW.channel='model' BEGIN SELECT RAISE(ABORT, 'TEST_MODEL_PUBLICATION_FAILED'); END")
    const done = waitForRun(f, 'failed')
    f.send('chat.message.send', { content: [{ type: 'text', text: '只回复 OK' }], clientMessageId: 'publication-failure', autoStart: true })
    await done
    assert.equal(calls, 0)
    assert.equal(f.store.readPublications('journal-session').filter(p => p.channel === 'model').length, 0)
    const failure = f.loop.exportState().snapshot.run.failure
    assert.match(failure!.message, /TEST_MODEL_PUBLICATION_FAILED/)
  } finally { f.close() }
})

test('closing an in-flight run invalidates continuations before the journal connection closes', { timeout: 15000 }, async () => {
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const f = fixture({ ...llm, chat: async () => {
    entered(); await gate // The provider deliberately ignores cancellation and returns late.
    return { provider: 'custom', model: 'test', finishReason: 'stop', raw: {}, text: '{"status":"completed","content":"late response"}' }
  } })
  try {
    f.send('chat.message.send', { content: [{ type: 'text', text: '只读测试' }], clientMessageId: 'close-in-flight', autoStart: true })
    await started
    const task = (f.loop as unknown as { activeTask: Promise<void> }).activeTask
    assert.ok(task)
    const before = f.store.loadDocument('journal-session'), publications = f.store.readPublications('journal-session')
    f.loop.close(); release()
    await assert.doesNotReject(task)
    assert.deepEqual(f.store.loadDocument('journal-session'), before)
    assert.deepEqual(f.store.readPublications('journal-session'), publications)
    assert.equal(f.events.some(e => e.type === 'chat.assistant.completed'), false)
  } finally { release(); f.close() }
})

test('a post-step Hook publication failure ends the run truthfully without an unhandled task rejection', async () => {
  const f = fixture({ ...llm, chat: async () => ({ provider: 'custom', model: 'test', finishReason: 'stop', raw: {}, text: '{"status":"completed","content":"ok"}' }) })
  try {
    f.injector.exec("CREATE TRIGGER fail_hook_publication BEFORE INSERT ON context_publications WHEN NEW.channel='hook' BEGIN SELECT RAISE(ABORT, 'TEST_HOOK_PUBLICATION_FAILED'); END")
    f.send('chat.message.send', { content: [{ type: 'text', text: '只回复 OK' }], clientMessageId: 'hook-publication-failure', autoStart: true })
    const task = (f.loop as unknown as { activeTask: Promise<void> }).activeTask
    assert.ok(task)
    await assert.doesNotReject(task)
    const run = f.loop.exportState().snapshot.run
    assert.equal(run.status, 'failed')
    assert.equal(run.failure!.code, 'RUNTIME_FINALIZATION_FAILED')
    assert.match(run.failure!.message, /TEST_HOOK_PUBLICATION_FAILED/)
    assert.equal(f.store.readPublications('journal-session').filter(p => p.channel === 'hook').length, 0)
  } finally { f.close() }
})

test('publication of two projections is atomic and cannot authorize another request, channel, or session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-publication-transaction-')), store = new ContextCommitStore(root)
  const injector = new DatabaseSync(store.databaseFile)
  try {
    const project = makeEngine(root, 'project-context'), session = makeEngine(root, 'publication-session')
    store.seedProject(project.exportState()); store.saveSession('publication-session', session.exportState())
    const before = { project: store.loadDocument(), session: store.loadDocument('publication-session') }
    project.setSectionContent('messages', '宿主记录'); session.setSectionContent('messages', '当前消息')
    const p = project.project({ id: 'project-read', maxCharacters: 8000 }), s = session.project({ id: 'session-read', maxCharacters: 8000 })
    const values = [{ scope: 'project' as const, state: project.exportState(), projection: p }, { scope: 'session' as const, state: session.exportState(), projection: s }]
    injector.exec("CREATE TRIGGER fail_publication BEFORE INSERT ON context_publications WHEN NEW.scope='session' BEGIN SELECT RAISE(ABORT, 'TEST_PUBLICATION_FAILED'); END")
    assert.throws(() => store.publishProjections('publication-session', 'model', 'request-A', values), /TEST_PUBLICATION_FAILED/)
    assert.deepEqual(store.loadDocument(undefined, { observe: false }), before.project)
    assert.deepEqual(store.loadDocument('publication-session', { observe: false }), before.session)
    assert.deepEqual(store.readPublications('publication-session'), [])
    injector.exec('DROP TRIGGER fail_publication')
    store.publishProjections('publication-session', 'model', 'request-A', values)
    const binding = { documentId: session.snapshot().id, projectionId: s.id, baseRevision: s.documentRevision, projectionHash: s.contentHash }
    store.assertPublishedProjection('publication-session', 'session', binding, 'model', 'request-A')
    assert.throws(() => store.assertPublishedProjection('publication-session', 'session', binding, 'model', 'request-B'), /PROJECTION_NOT_PUBLISHED/)
    assert.throws(() => store.assertPublishedProjection('publication-session', 'session', binding, 'hook'), /PROJECTION_NOT_PUBLISHED/)
    assert.throws(() => store.assertPublishedProjection('other-session', 'session', binding), /PROJECTION_NOT_PUBLISHED/)
    assert.throws(() => store.publishProjections('publication-session', 'model', 'request-A', [{ ...values[1]!, projection: { ...s, markdown: s.markdown + '未发布内容' } }]), /BINDING_INVALID/)
  } finally { injector.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('a frozen-project read publication cannot change facts, knowledge section payloads, reviews, or receipts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-publication-readonly-')), store = new ContextCommitStore(root)
  try {
    const project = makeEngine(root, 'project-context')
    store.seedProject(project.exportState())
    const p = project.project({ id: 'frozen-read', maxCharacters: 8000 }), state = project.exportState()
    withAssetWritePolicy({ projectDir: root, readonly: true, onAudit() {} }, () => store.publishProjections('frozen-session', 'inspection', 'read', [{ scope: 'project', state, projection: p }]))
    const injected = structuredClone(state)
    injected.receipts.push(['invented', { id: 'fake', proposalId: 'fake', result: 'applied', previousRevision: 0, changedEntryIds: [], createdAt: 'fake' }])
    injected.reviewReceipts.push({} as never)
    store.publishProjections('frozen-session', 'inspection', 'read-again', [{ scope: 'project', state: injected, projection: p }])
    assert.deepEqual(store.loadDocument()!.receipts, [])
    assert.deepEqual(store.loadDocument()!.reviewReceipts, [])
    for (const mutate of [
      (s: typeof state) => { s.document.sections.find(section => section.kind === 'information')!.content = '绕过知识更新' },
      (s: typeof state) => { s.document.sections.find(section => section.kind === 'candidates')!.entries = ['invented'] },
      (s: typeof state) => { s.document.evidence.push({ id: 'fake', kind: 'message', referenceId: 'fake' }) },
    ]) {
      const bad = structuredClone(state); mutate(bad)
      assert.throws(() => store.publishProjections('frozen-session', 'inspection', 'tampered', [{ scope: 'project', state: bad, projection: p }]), /KNOWLEDGE_CONFLICT/)
    }
    assert.equal(store.readPublications('frozen-session').length, 2)
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('outcome audits reject invented or altered success receipts and session clearing removes all control journals', () => {
  const f = fixture()
  try {
    const p = f.proposal('session', 'verified-receipt')
    const fake = { id: 'forged', proposalId: p.id, proposalHash: proposalHash(p as DiffProposal), result: 'applied' as const, previousRevision: p.baseRevision, changedEntryIds: ['imaginary'], createdAt: new Date().toISOString() }
    assert.throws(() => f.store.recordOutcomes('journal-session', [{ scope: 'session', proposal: p as DiffProposal, receipt: fake, correlationId: 'forged' }]), /SUCCESS_UNPROVEN/)
    f.send('runtime.context.v2.apply', { proposal: p })
    const valid = f.store.readOutcomes('journal-session')[0]!
    assert.throws(() => f.store.recordOutcomes('journal-session', [{ ...valid, receipt: { ...valid.receipt, changedEntryIds: ['wrong'] } }]), /SUCCESS_UNPROVEN|ID_CONFLICT/)
    assert.throws(() => f.store.recordOutcomes('journal-session', [{ ...valid, proposal: { ...valid.proposal, idempotencyKey: 'stolen-receipt' } }]), /SUCCESS_UNPROVEN|ID_CONFLICT/)
    const sessions = new SessionStore(f.root)
    try { sessions.clear() } finally { sessions.close() }
    assert.deepEqual(f.store.readPublications('journal-session'), [])
    assert.deepEqual(f.store.readOutcomes('journal-session'), [])
    assert.equal(f.injector.prepare('SELECT COUNT(*) AS n FROM context_outcomes').get()!.n, 0)
    assert.throws(() => f.store.recordOutcomes('journal-session', [valid]), /SESSION_CLEARED/)
  } finally { f.close() }
})
