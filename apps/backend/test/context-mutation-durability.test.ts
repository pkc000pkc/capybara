import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { RuntimeLoop, type RuntimeLlm } from '#core/runtime-loop'
import { initializeProjectDirectory } from '#core/project-initializer'
import { ContextCommitStore } from '#core/context-commit-store'
import type { ClientCommand, ServerEvent } from '#protocol/runtime-protocol'

const llm: RuntimeLlm = {
  chat: async () => { throw new Error('no model call expected') },
  getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }),
}

test('observations and reviews persist before publication and a rejected durable write restores memory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-context-mutation-'))
  initializeProjectDirectory(root)
  const loop = new RuntimeLoop({ projectDir: root, llm })
  const store = new ContextCommitStore(root)
  const injector = new DatabaseSync(store.databaseFile)
  const events: ServerEvent[] = []
  loop.onEvent((event) => events.push(event as ServerEvent))
  let sequence = 0
  const send = (runtime: RuntimeLoop, type: ClientCommand['type'], payload: unknown) => {
    const command = { version: 1, kind: 'command', id: `mutation-${++sequence}`, sessionId: 'mutation-session', timestamp: new Date().toISOString(), type, payload } as ClientCommand
    runtime.validate(command); runtime.execute(command, sequence)
  }
  try {
    send(loop, 'runtime.context.v2.observe', { observation: {
      candidate: { source: { actor: 'user', sourceId: 'message-original', capturedAt: new Date().toISOString() }, rawArtifactId: 'message-original', normalizedContent: '本轮订单信息。' },
      evidence: { kind: 'message', referenceId: 'message-original' },
    } })
    const before = loop.exportState().contextDocument!
    const candidateId = before.candidates[0]!.id
    assert.deepEqual(store.loadDocument('mutation-session')!.document.candidates, before.candidates)
    injector.exec("CREATE TRIGGER fail_mutation BEFORE INSERT ON context_documents WHEN NEW.scope_id='session:mutation-session' BEGIN SELECT RAISE(ABORT, 'TEST_REVIEW_PERSIST_FAILED'); END")
    const storedBefore = store.loadDocument('mutation-session')
    events.length = 0
    assert.throws(() => send(loop, 'runtime.context.v2.review', { review: { documentId: before.id, candidateId, baseRevision: before.revision, status: 'irrelevant', reason: '当前任务无关' } }), /TEST_REVIEW_PERSIST_FAILED/)
    assert.deepEqual(loop.exportState().contextDocument, before)
    assert.deepEqual(store.loadDocument('mutation-session'), storedBefore)
    assert.equal(events.some((event) => event.type === 'runtime.context.v2.candidate.reviewed'), false)
    injector.exec('DROP TRIGGER fail_mutation')
    send(loop, 'runtime.context.v2.review', { review: { documentId: before.id, candidateId, baseRevision: before.revision, status: 'irrelevant', reason: '当前任务无关' } })
    const reviewed = store.loadDocument('mutation-session')!
    assert.equal(reviewed.document.candidates[0]!.status, 'irrelevant')
    assert.equal(reviewed.reviewReceipts.at(-1)!.status, 'irrelevant')
    const restarted = new RuntimeLoop({ projectDir: root, llm })
    try {
      send(restarted, 'runtime.snapshot.get', {})
      assert.equal(restarted.exportState().contextDocument!.id, reviewed.document.id)
      assert.equal(restarted.exportState().contextDocument!.candidates[0]!.status, 'irrelevant')
    } finally { restarted.close() }
    const projectBefore = loop.exportState().projectContextDocument!
    injector.exec("CREATE TRIGGER fail_project_observe BEFORE INSERT ON context_documents WHEN NEW.scope_id='project' BEGIN SELECT RAISE(ABORT, 'TEST_PROJECT_OBSERVE_PERSIST_FAILED'); END")
    assert.throws(() => send(loop, 'runtime.context.v2.observe', { observation: { scope: 'project', documentId: projectBefore.id,
      candidate: { source: { actor: 'user', sourceId: 'project-rule', capturedAt: new Date().toISOString() }, rawArtifactId: 'project-rule', normalizedContent: '项目规则',
        classification: { durability: 'project', target: 'project', confidence: 'high', reason: '明确项目规则', projectAnchors: ['project:explicit:rule'] } },
      evidence: { kind: 'message', referenceId: 'project-rule' },
    } }), /TEST_PROJECT_OBSERVE_PERSIST_FAILED/)
    assert.deepEqual(loop.exportState().projectContextDocument, projectBefore)
    assert.equal(store.loadDocument()!.document.candidates.length, 0)
  } finally { injector.close(); store.close(); loop.close(); fs.rmSync(root, { recursive: true, force: true }) }
})
