import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { ContextCommitStore } from '#core/context-commit-store'
import { ContextDocumentEngine } from '#core/context-document-engine'
import { ContextHistory } from '#core/context-history'
import { SessionStore } from '#core/session-store'
import { initializeProjectDirectory } from '#core/project-initializer'
import { RuntimeLoop, type RuntimeLlm } from '#core/runtime-loop'
import type { ClientCommand } from '#protocol/runtime-protocol'

const llm: RuntimeLlm = { chat: async () => { throw new Error('no model call expected') }, getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }) }
const engine = (root: string, id: string) => ContextDocumentEngine.create({ sessionId: id, projectId: root, constitutionRevision: 'test' })
function command(type: ClientCommand['type'], payload: unknown, sessionId: string): ClientCommand {
  return { version: 1, kind: 'command', id: `authority-${Math.random()}`, sessionId, type, payload, timestamp: new Date().toISOString() } as ClientCommand
}
function seedEntry(target: ContextDocumentEngine, text: string) {
  const evidence = target.addEvidence({ kind: 'message', referenceId: 'source' })
  const candidate = target.addCandidate({ source: { actor: 'user', sourceId: 'source', capturedAt: '2026-11-17T00:00:00Z' }, normalizedContent: text, rawArtifactId: 'source', evidenceRefs: [evidence.id] })
  return target.apply(target.propose({ projection: target.project({ id: 'add', maxCharacters: 12000 }), candidateId: candidate.id,
    target: { section: 'information' }, operation: 'add_entry', payload: { body: text }, actor: 'system', idempotencyKey: text }))
}

test('independent writers reject same-revision projection updates until their actual read base is refreshed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-context-cas-')), left = new ContextCommitStore(root), right = new ContextCommitStore(root)
  try {
    const original = engine(root, 'cas-session')
    left.saveSession('cas-session', original.exportState())
    const l = left.loadDocument('cas-session')!, r = right.loadDocument('cas-session')!
    const a = new ContextDocumentEngine(l.document), b = new ContextDocumentEngine(r.document)
    a.project({ id: 'left-projection', maxCharacters: 4096 }); b.project({ id: 'right-projection', maxCharacters: 4096 })
    assert.equal(a.snapshot().revision, b.snapshot().revision)
    left.saveSession('cas-session', a.exportState())
    assert.throws(() => right.saveSession('cas-session', b.exportState()), /SESSION_CONTEXT_STATE_CONFLICT/)
    right.loadDocument('cas-session', { observe: false })
    assert.throws(() => right.saveSession('cas-session', b.exportState()), /SESSION_CONTEXT_STATE_CONFLICT/)
    const refreshed = right.loadDocument('cas-session')!
    const merged = new ContextDocumentEngine(refreshed.document, refreshed.receipts, refreshed.projections)
    merged.project({ id: 'right-after-refresh', maxCharacters: 4096 })
    right.saveSession('cas-session', merged.exportState())
    assert.equal(right.loadDocument('cas-session')!.projections.length, 2)
    const staleProject = engine(root, 'project-context')
    left.seedProject(staleProject.exportState()); right.loadDocument()
    left.saveProject(staleProject.exportState(), 0)
    assert.throws(() => right.saveProject(staleProject.exportState(), 0), /PROJECT_CONTEXT_STATE_CONFLICT/)
    right.loadDocument()
    staleProject.project({ id: 'project-projection', maxCharacters: 4096 })
    left.saveProject(staleProject.exportState(), 0)
    assert.throws(() => right.saveProject(staleProject.exportState(), 0), /PROJECT_CONTEXT_STATE_CONFLICT/)
  } finally { left.close(); right.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('a failed two-document transaction restores both persisted data and the writer read bases', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-cas-rollback-')), store = new ContextCommitStore(root)
  const injector = new DatabaseSync(store.databaseFile)
  try {
    const project = engine(root, 'project-context'), session = engine(root, 'rollback-session')
    store.seedProject(project.exportState()); store.saveSession('rollback-session', session.exportState())
    const projectBase = project.snapshot().revision, sessionBase = session.snapshot().revision
    const p = seedEntry(project, '项目材料'), s = seedEntry(session, '会话材料')
    const value = { id: 'retry-same-commit', sessionId: 'rollback-session', expectedProjectRevision: projectBase, expectedSessionRevision: sessionBase,
      project: project.exportState(), session: session.exportState(), history: new ContextHistory().snapshot(), projectChanged: true, receiptIds: [p.id, s.id], archives: [], coverageAdvanced: false }
    injector.exec("CREATE TRIGGER fail_cas_session BEFORE INSERT ON context_documents WHEN NEW.scope_id='session:rollback-session' BEGIN SELECT RAISE(ABORT, 'TEST_CAS_ROLLBACK'); END")
    assert.throws(() => store.commit(value), /TEST_CAS_ROLLBACK/)
    assert.equal(store.loadDocument(undefined, { observe: false })!.document.information.length, 0)
    injector.exec('DROP TRIGGER fail_cas_session')
    store.commit(value)
    assert.equal(store.loadDocument()!.document.information[0]!.body, '项目材料')
    assert.equal(store.loadDocument('rollback-session')!.document.information[0]!.body, '会话材料')
    assert.equal(store.lastCommit('rollback-session')!.id, value.id)
  } finally { injector.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('database documents override inflated recovery snapshots before the first desktop snapshot is exposed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-authority-recovery-'))
  initializeProjectDirectory(root)
  const loop = new RuntimeLoop({ projectDir: root, llm, sessionId: 'recovery-session' })
  let restored: RuntimeLoop | undefined
  try {
    for (const scope of ['session', 'project']) {
      const observe = command('runtime.context.v2.observe', { observation: { scope,
        candidate: { source: { actor: 'user', sourceId: `source-${scope}`, capturedAt: '2026-11-17T00:00:00Z' }, normalizedContent: `真实${scope}材料`, rawArtifactId: `source-${scope}`,
          ...(scope === 'project' ? { classification: { durability: 'project', target: 'project', confidence: 'high', reason: '用户声明长期约定', projectAnchors: ['project:explicit:source-project'] } } : {}) },
        evidence: { kind: 'message', referenceId: `source-${scope}` } } }, 'recovery-session')
      loop.validate(observe); loop.execute(observe, 1)
    }
    const snapshot = loop.exportState()
    snapshot.contextDocument!.candidates[0]!.normalizedContent = 'snapshot poison'
    snapshot.contextDocument!.revision += 100
    snapshot.projectContextDocument!.candidates[0]!.normalizedContent = 'snapshot poison'
    snapshot.projectContextDocument!.revision += 100
    loop.close()
    restored = new RuntimeLoop({ projectDir: root, llm, sessionId: 'recovery-session', initialState: snapshot })
    const actual = restored.getSnapshot(0)
    assert.equal(actual.contextDocumentView!.candidates.length, 1)
    assert.equal(restored.exportState().contextDocument!.candidates[0]!.normalizedContent, '真实session材料')
    assert.equal(restored.exportState().projectContextDocument!.candidates[0]!.normalizedContent, '真实project材料')
    assert.ok(actual.contextDocument!.revision < snapshot.contextDocument!.revision)
    assert.ok(actual.projectContextDocument!.revision < snapshot.projectContextDocument!.revision)
    assert.throws(() => restored!.execute(command('runtime.snapshot.get', {}, 'another-session'), 2), /RUNTIME_SESSION_BINDING_MISMATCH/)
    restored.close()
    snapshot.contextDocument!.candidates[0]!.evidenceRefs = ['missing-snapshot-evidence']
    snapshot.contextDocument!.tree!.rootChildren.push('missing-snapshot-node')
    restored = new RuntimeLoop({ projectDir: root, llm, sessionId: 'recovery-session', initialState: snapshot })
    assert.equal(restored.exportState().contextDocument!.candidates[0]!.normalizedContent, '真实session材料')
  } finally { restored?.close(); loop.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('a recovery snapshot cannot replace an immutable raw message or its coverage proof', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-history-authority-'))
  initializeProjectDirectory(root)
  const loop = new RuntimeLoop({ projectDir: root, llm, sessionId: 'history-session' })
  try {
    loop.execute(command('chat.message.send', { clientMessageId: 'original-message', content: [{ type: 'text', text: '真实用户要求' }], autoStart: false }, 'history-session'), 1)
    const snapshot = loop.exportState()
    snapshot.contextHistory!.messages[0]!.message.content = '伪造原文'
    loop.close()
    assert.throws(() => new RuntimeLoop({ projectDir: root, llm, sessionId: 'history-session', initialState: snapshot }), /CONTEXT_HISTORY_SNAPSHOT_CONFLICT/)
    const store = new ContextCommitStore(root)
    try { assert.equal(store.readMessages('history-session')[0]!.message.content, '真实用户要求') } finally { store.close() }
  } finally { loop.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('session clear removes scoped resources, keeps project-referenced originals and prevents stale resurrection', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-context-clear-'))
  initializeProjectDirectory(root)
  const sessions = new SessionStore(root), contexts = new ContextCommitStore(root)
  const inspector = new DatabaseSync(contexts.databaseFile)
  try {
    const directory = sessions.create('来源会话'), project = engine(root, 'project-context'), session = engine(root, directory.id)
    const history = new ContextHistory()
    history.append({ id: 'project-source', origin: 'user', message: { role: 'user', content: '项目需要保留的原件' } }, (entry) => contexts.appendMessage(directory.id, entry))
    history.append({ id: 'private-source', origin: 'user', message: { role: 'user', content: '会话私有材料' } }, (entry) => contexts.appendMessage(directory.id, entry))
    history.append({ id: 'legacy-same', origin: 'user', message: { role: 'user', content: '旧来源 A' } }, (entry) => contexts.appendMessage(directory.id, entry))
    const oldSource = new ContextHistory()
    oldSource.append({ id: 'legacy-same', origin: 'user', message: { role: 'user', content: '旧来源 B' } }, (entry) => contexts.appendMessage('legacy-producer', entry))
    project.addEvidence({ kind: 'message', referenceId: 'project-source', sessionId: directory.id })
    project.addEvidence({ kind: 'message', referenceId: 'legacy-same' })
    contexts.seedProject(project.exportState()); contexts.saveSession(directory.id, session.exportState())
    sessions.save(directory.id, { note: '待清理' }, 0)
    inspector.prepare('INSERT INTO context_frontiers(session_id, state_json) VALUES (?, ?)').run(directory.id, JSON.stringify({ coveredThrough: 2, retainedMessageIds: [], receiptIds: [] }))
    inspector.prepare('INSERT INTO context_recalls(id,session_id,state_json) VALUES (?,?,?)').run('recall-clear', directory.id, '{}')
    inspector.exec("CREATE TRIGGER reject_context_clear BEFORE DELETE ON context_frontiers BEGIN SELECT RAISE(ABORT, 'TEST_CLEAR_ROLLBACK'); END")
    assert.throws(() => sessions.clear(), /TEST_CLEAR_ROLLBACK/)
    assert.equal(sessions.list().length, 1)
    assert.equal(contexts.readMessages(directory.id).length, 3)
    inspector.exec('DROP TRIGGER reject_context_clear')
    sessions.clear()
    assert.equal(sessions.list().length, 0)
    assert.equal(contexts.loadDocument(directory.id), undefined)
    assert.equal(contexts.loadCoverage(directory.id), undefined)
    assert.equal(contexts.loadRecall(directory.id, 'recall-clear'), undefined)
    assert.equal(contexts.readSource('project-source', directory.id)!.message.content, '项目需要保留的原件')
    assert.equal(contexts.readSource('private-source', directory.id), undefined)
    assert.equal(contexts.readSource('legacy-same', directory.id)!.message.content, '旧来源 A')
    assert.equal(contexts.readSource('legacy-same', 'legacy-producer')!.message.content, '旧来源 B')
    assert.throws(() => contexts.readSource('legacy-same'), /CONTEXT_SOURCE_ID_AMBIGUOUS/)
    assert.deepEqual(contexts.loadDocument()!.document.evidence, project.snapshot().evidence)
    assert.throws(() => contexts.saveSession(directory.id, session.exportState()), /CONTEXT_SESSION_CLEARED/)
    assert.throws(() => contexts.appendMessage(directory.id, history.snapshot().messages[1]!), /CONTEXT_SESSION_CLEARED/)
    assert.throws(() => contexts.restoreSessionCheckpoint(directory.id, session.exportState()), /CONTEXT_SESSION_CLEARED/)
    assert.throws(() => contexts.restoreSessionCheckpoint('', session.exportState()), /CONTEXT_DOCUMENT_SESSION_MISMATCH/)
    const fresh = sessions.create('清理后新会话')
    contexts.saveSession(fresh.id, engine(root, fresh.id).exportState())
    assert.ok(contexts.loadDocument(fresh.id))
    const reader = new RuntimeLoop({ projectDir: root, llm, sessionId: fresh.id })
    try {
      const read = (args: unknown) => (reader as unknown as { readRuntimeArtifactTool(args: unknown): Record<string, unknown> }).readRuntimeArtifactTool(args)
      assert.equal(read({ artifact_id: 'project-source', source_scope: 'project' }).content, '项目需要保留的原件')
      assert.throws(() => read({ artifact_id: 'private-source', source_scope: 'project' }), /not found/)
      assert.throws(() => read({ artifact_id: 'legacy-same', source_scope: 'project' }), /CONTEXT_SOURCE_ID_AMBIGUOUS/)
    } finally { reader.close() }
  } finally { inspector.close(); contexts.close(); sessions.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('a rejected session-to-project promotion does not leak candidate or evidence into project memory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-rejected-promotion-'))
  initializeProjectDirectory(root)
  const loop = new RuntimeLoop({ projectDir: root, llm, sessionId: 'promotion-session' })
  try {
    const classification = { durability: 'project', target: 'project', confidence: 'high', reason: '明确项目规则', projectAnchors: ['project:explicit:rule'] }
    loop.execute(command('runtime.context.v2.observe', { observation: { scope: 'session', candidate: { source: { actor: 'user', sourceId: 'project-rule', capturedAt: '2026-11-17T00:00:00Z' },
      rawArtifactId: 'project-rule', normalizedContent: '跨会话项目规则', classification }, evidence: { kind: 'message', referenceId: 'project-rule' } } }, 'promotion-session'), 1)
    loop.execute(command('runtime.context.v2.project', { scope: 'project', profileId: 'promotion', maxCharacters: 6000 }, 'promotion-session'), 2)
    const before = loop.exportState(), candidate = before.contextDocument!.candidates[0]!, projection = before.projectContextDocumentProjections!.at(-1)!
    loop.execute(command('runtime.context.v2.apply', { proposal: { scope: 'project', sourceScope: 'session', id: 'rejected-promotion', documentId: before.projectContextDocument!.id, baseRevision: before.projectContextDocument!.revision,
      projectionId: projection[0], projectionHash: projection[1].contentHash, candidateId: candidate.id, target: { section: 'information' }, operation: 'add_entry', payload: { body: '不得泄漏' },
      classification: { durability: 'session', target: 'session', confidence: 'high', reason: '与来源位置冲突', projectAnchors: [] }, actor: 'model', idempotencyKey: 'reject-placement', createdAt: new Date().toISOString() } }, 'promotion-session'), 3)
    const after = loop.exportState()
    assert.deepEqual(after.projectContextDocument, before.projectContextDocument)
    assert.equal(after.projectContextDocumentReceipts!.at(-1)![1].errorCode, 'PROJECT_CLASSIFICATION_MISMATCH')
    assert.equal(after.contextDocument!.candidates[0]!.id, candidate.id)
  } finally { loop.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('raw append holds a write transaction across the tombstone check so clear cannot interleave', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-source-clear-race-')), sessions = new SessionStore(root), contexts = new ContextCommitStore(root)
  const database = (contexts as unknown as { database: DatabaseSync }).database
  const prepare = database.prepare.bind(database)
  let attempted = false, blocked = false
  try {
    const directory = sessions.create('并发清理')
    database.prepare = ((sql: string) => {
      const statement = prepare(sql)
      if (sql.includes('SELECT 1 FROM context_session_tombstones') && !attempted) {
        const get = statement.get.bind(statement)
        statement.get = ((id: string) => {
          const result = get(id)
          attempted = true
          try { sessions.clear() } catch (error) { assert.match(String(error), /locked|busy/); blocked = true }
          return result
        }) as typeof statement.get
      }
      return statement
    }) as typeof database.prepare
    const history = new ContextHistory()
    history.append({ id: 'racing-source', origin: 'user', message: { role: 'user', content: '不可在清理后复活的材料' } }, (entry) => contexts.appendMessage(directory.id, entry))
    assert.equal(attempted, true)
    assert.equal(blocked, true)
    database.prepare = prepare
    assert.equal(contexts.readMessages(directory.id).length, 1)
    sessions.clear()
    assert.equal(contexts.readMessages(directory.id).length, 0)
    assert.throws(() => contexts.appendMessage(directory.id, history.snapshot().messages[0]!), /CONTEXT_SESSION_CLEARED/)
  } finally { database.prepare = prepare; contexts.close(); sessions.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('legacy snapshot import is atomic and cannot adopt unverified historical coverage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-legacy-context-import-'))
  initializeProjectDirectory(root)
  const first = new RuntimeLoop({ projectDir: root, llm, sessionId: 'legacy-session' })
  first.execute(command('chat.message.send', { clientMessageId: 'legacy-user', content: [{ type: 'text', text: '旧会话的真实要求' }], autoStart: false }, 'legacy-session'), 1)
  const snapshot = first.exportState()
  first.close()
  const history = new ContextHistory(snapshot.contextHistory)
  history.append({ id: 'legacy-tail', origin: 'model', message: { role: 'assistant', content: '快照中的恢复材料' } })
  snapshot.contextHistory = history.snapshot()
  snapshot.contextHistory.coverage = { coveredThrough: 1, retainedMessageIds: [], commitId: 'unverified-snapshot', receiptIds: ['unverified-receipt'] }
  const inspector = new DatabaseSync(path.join(root, '.capybara', 'sessions.sqlite'))
  let restored: RuntimeLoop | undefined
  try {
    inspector.exec("DELETE FROM context_documents WHERE scope_id='session:legacy-session'; DELETE FROM context_frontiers WHERE session_id='legacy-session';")
    inspector.exec("CREATE TRIGGER fail_legacy_import BEFORE INSERT ON context_documents WHEN NEW.scope_id='session:legacy-session' BEGIN SELECT RAISE(ABORT, 'TEST_LEGACY_IMPORT_FAILED'); END")
    assert.throws(() => new RuntimeLoop({ projectDir: root, llm, sessionId: 'legacy-session', initialState: snapshot }), /TEST_LEGACY_IMPORT_FAILED/)
    assert.equal((inspector.prepare("SELECT COUNT(*) AS count FROM context_history WHERE message_id='legacy-tail'").get() as { count: number }).count, 0)
    inspector.exec('DROP TRIGGER fail_legacy_import')
    restored = new RuntimeLoop({ projectDir: root, llm, sessionId: 'legacy-session', initialState: snapshot })
    assert.equal(restored.exportState().contextHistory!.coverage.coveredThrough, 0)
    assert.equal(restored.exportState().contextHistory!.messages.length, 2)
    assert.ok(restored.exportState().llmMessages.some((message) => message.content === '旧会话的真实要求'))
    assert.equal((inspector.prepare("SELECT COUNT(*) AS count FROM context_history WHERE message_id='legacy-tail'").get() as { count: number }).count, 1)
  } finally { restored?.close(); inspector.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('archive-only commits with identical document bytes cannot regress a concurrently advanced frontier', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-frontier-cas-')), left = new ContextCommitStore(root), right = new ContextCommitStore(root)
  try {
    const project = engine(root, 'project-context'), session = engine(root, 'frontier-session'), history = new ContextHistory()
    left.seedProject(project.exportState()); left.saveSession('frontier-session', session.exportState())
    for (const id of ['source-1', 'source-2']) history.append({ id, origin: 'model', message: { role: 'assistant', content: `${id} 原始轨迹` } }, (entry) => left.appendMessage('frontier-session', entry))
    right.loadDocument(); right.loadDocument('frontier-session')
    const commit = (id: string, count: number) => {
      const archives = history.snapshot().messages.slice(0, count).map((message) => ({ id: `archive-${id}-${message.id}`, scope: 'session' as const, sourceMessageIds: [message.id],
        sourceRefs: [`${message.id}:span:0:${message.message.content.length}`], receiptId: `receipt-${id}-${message.id}`, reason: '原始轨迹归档' }))
      const receiptIds = archives.map((archive) => archive.receiptId)
      return { id, sessionId: 'frontier-session', expectedProjectRevision: 0, expectedSessionRevision: 0, project: project.exportState(), session: session.exportState(),
        history: { ...history.snapshot(), coverage: { coveredThrough: count, retainedMessageIds: [], commitId: id, receiptIds } }, archives, receiptIds, projectChanged: false }
    }
    left.commit(commit('first-complete', 2))
    assert.throws(() => right.commit(commit('stale-partial', 1)), /SESSION_CONTEXT_STATE_CONFLICT/)
    assert.equal(left.loadCoverage('frontier-session')!.coveredThrough, 2)
    assert.equal(left.lastCommit('frontier-session')!.id, 'first-complete')
  } finally { left.close(); right.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('existing SQLite context rows migrate to write versions without changing document identity or evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-write-version-migration-'))
  fs.mkdirSync(path.join(root, '.capybara'), { recursive: true })
  const original = engine(root, 'project-context')
  seedEntry(original, '迁移前的项目材料和证据')
  const state = original.exportState(), oldDatabase = new DatabaseSync(path.join(root, '.capybara', 'sessions.sqlite'))
  oldDatabase.exec('CREATE TABLE context_documents(scope_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL)')
  oldDatabase.prepare('INSERT INTO context_documents VALUES (?,?,?,?)').run('project', state.document.id, state.document.revision, JSON.stringify(state))
  oldDatabase.close()
  const store = new ContextCommitStore(root), inspect = new DatabaseSync(store.databaseFile)
  try {
    const restored = store.loadDocument()!
    assert.deepEqual(restored, state)
    store.saveProject(restored, restored.document.revision)
    assert.deepEqual(store.loadDocument()!.document, state.document)
    assert.equal((inspect.prepare("SELECT write_version FROM context_documents WHERE scope_id='project'").get() as { write_version: number }).write_version, 1)
  } finally { inspect.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }) }
})
