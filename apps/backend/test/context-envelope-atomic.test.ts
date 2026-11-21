import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { RuntimeLoop, type RuntimeLlm } from '#core/runtime-loop'
import { initializeProjectDirectory } from '#core/project-initializer'
import { ContextCommitStore } from '#core/context-commit-store'
import type { ClientCommand, RuntimeContextScopeKind, RuntimeEnvelope, ServerEvent } from '#protocol/runtime-protocol'

const llm: RuntimeLlm = {
  chat: async () => { throw new Error('this governed-command scenario must not call a model') },
  getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }),
}

for (const scenario of ['success', 'session-rejection', 'project-binding', 'durable-failure'] as const) {
  test(`an envelope commits both document scopes or neither (${scenario})`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-envelope-atomic-'))
    initializeProjectDirectory(root)
    const loop = new RuntimeLoop({ projectDir: root, llm })
    const events: ServerEvent[] = []
    loop.onEvent((event) => events.push(event as ServerEvent))
    let sequence = 0
    const send = (type: ClientCommand['type'], payload: unknown) => {
      const command = { version: 1, kind: 'command', id: `command-${++sequence}`, sessionId: 'atomic-session', timestamp: new Date().toISOString(), type, payload } as ClientCommand
      loop.validate(command); loop.execute(command, sequence)
    }
    const store = new ContextCommitStore(root)
    let injector: DatabaseSync | undefined
    try {
      send('runtime.snapshot.get', {})
      const diffs: RuntimeEnvelope['candidateDiffs'] = []
      for (const scope of ['project', 'session'] as const) {
        const state = loop.exportState()
        const document = scope === 'project' ? state.projectContextDocument! : state.contextDocument!
        send('runtime.context.v2.observe', { observation: { scope, documentId: document.id,
          candidate: { source: { actor: 'user', sourceId: `source-${scope}`, capturedAt: new Date().toISOString() },
            rawArtifactId: `source-${scope}`, normalizedContent: scope === 'project' ? '项目的发布需要审计记录。' : '本会话正在验证订单退款。',
            ...(scope === 'project' ? { classification: { durability: 'project', target: 'project', confidence: 'high', reason: '用户声明项目长期规则', projectAnchors: ['project:explicit:release-policy'] } } : {}) },
          evidence: { kind: 'message', referenceId: `source-${scope}` } } })
        const observed = [...events].reverse().find((event) => event.type === 'runtime.context.v2.observed') as Extract<ServerEvent, { type: 'runtime.context.v2.observed' }>
        send('runtime.context.v2.project', { scope, profileId: `atomic-${scope}`, maxCharacters: 16000 })
        const projected = [...events].reverse().find((event) => event.type === 'runtime.context.v2.projection.created') as Extract<ServerEvent, { type: 'runtime.context.v2.projection.created' }>
        diffs.push({ scope, documentId: document.id, baseRevision: projected.payload.projection.documentRevision,
          projectionId: projected.payload.projection.id, projectionHash: projected.payload.projection.contentHash,
          candidateId: observed.payload.candidate.id, operation: 'add_entry', body: `已整理的${scope}材料`,
          evidenceRefs: [observed.payload.evidence!.id], idempotencyKey: `atomic-${scope}` })
      }
      const before = loop.exportState()
      const projectBefore = store.loadDocument()
      const sessionBefore = store.loadDocument('atomic-session')
      const coverageBefore = store.loadCoverage('atomic-session')
      if (scenario === 'session-rejection') diffs[1]!.candidateId = 'missing-candidate'
      if (scenario === 'project-binding') {
        diffs.reverse() // The valid session proposal stages first; a later project failure must undo it too.
        diffs[1]!.projectionHash = '0'.repeat(64)
      }
      if (scenario === 'durable-failure') {
        injector = new DatabaseSync(store.databaseFile)
        injector.exec("CREATE TRIGGER reject_atomic_session BEFORE INSERT ON context_documents WHEN NEW.scope_id='session:atomic-session' BEGIN SELECT RAISE(ABORT, 'TEST_ATOMIC_SESSION_WRITE_FAILED'); END")
      }
      events.length = 0
      const envelope: RuntimeEnvelope = { envelopeVersion: 1, sessionId: 'atomic-session', runId: 'atomic-run', requestId: 'atomic-request',
        decision: 'propose_diff', actions: [], candidateDiffs: diffs, evidenceRequests: [], uncertainties: [] }
      const apply = () => (loop as unknown as { applyV2EnvelopeDiffs(value: RuntimeEnvelope, id: string): void }).applyV2EnvelopeDiffs(envelope, 'atomic-envelope')
      if (scenario === 'success') {
        apply()
        const after = loop.exportState()
        for (const scope of ['project', 'session'] as RuntimeContextScopeKind[]) {
          const doc = scope === 'project' ? after.projectContextDocument! : after.contextDocument!
          assert.ok(doc.information.some((entry) => entry.body === `已整理的${scope}材料`))
          assert.deepEqual(store.loadDocument(scope === 'session' ? 'atomic-session' : undefined)!.document.information, doc.information)
        }
        assert.equal(events.filter((event) => event.type === 'runtime.context.v2.receipt.created' && event.payload.receipt.result === 'applied').length, 2)
        assert.ok(store.lastCommit('atomic-session'))
        assert.deepEqual(store.loadCoverage('atomic-session'), coverageBefore, 'a document-only update cannot advance history coverage')
        const restarted = new RuntimeLoop({ projectDir: root, llm, initialState: before })
        try {
          restarted.execute({ version: 1, kind: 'command', id: 'reopen', type: 'runtime.snapshot.get', sessionId: 'atomic-session', timestamp: new Date().toISOString(), payload: {} }, 10)
          assert.deepEqual(restarted.exportState().contextDocument!.information, after.contextDocument!.information)
          assert.deepEqual(restarted.exportState().projectContextDocument!.information, after.projectContextDocument!.information)
        } finally { restarted.close() }
      } else {
        assert.throws(apply, /CANDIDATE_NOT_FOUND|PROJECTION_BINDING_CONFLICT|PROJECTION_NOT_PUBLISHED|TEST_ATOMIC_SESSION_WRITE_FAILED/)
        const after = loop.exportState()
        assert.deepEqual(after.contextDocument, before.contextDocument)
        assert.deepEqual(after.projectContextDocument, before.projectContextDocument)
        assert.deepEqual(store.loadDocument(), projectBefore)
        assert.deepEqual(store.loadDocument('atomic-session'), sessionBefore)
        assert.deepEqual(store.loadCoverage('atomic-session'), coverageBefore)
        assert.equal(store.lastCommit('atomic-session'), undefined)
        assert.equal(events.some((event) => event.type === 'runtime.context.v2.receipt.created' && event.payload.receipt.result === 'applied'), false)
        const rejected = loop.getContextTrainingSamples().filter((sample) => sample.decision?.receipts?.some((receipt) => receipt.kind === 'apply'))
        assert.ok(rejected.some((sample) => sample.decision!.rejectedOperations.length === 2 && sample.decision!.acceptedOperations.length === 0))
      }
    } finally { injector?.close(); store.close(); loop.close(); fs.rmSync(root, { recursive: true, force: true }) }
  })
}
