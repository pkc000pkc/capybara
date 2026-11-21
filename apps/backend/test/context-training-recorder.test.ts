import assert from 'node:assert/strict'
import test from 'node:test'

import { ContextDocumentEngine } from '#core/context-document-engine'
import { ContextTrainingRecorder } from '#core/context-training-recorder'

test('recorder preserves project/session scope and algorithm input from runtime state', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 'session-1', projectId: 'project-1', constitutionRevision: 'v2' })
  const recorder = new ContextTrainingRecorder()
  const sample = recorder.captureRuntimeInput({
    sampleId: 'sample-1', scope: 'session', projectId: 'project-1', sessionId: 'session-1', runId: 'run-1',
    systemPrompt: '保持来源和不确定性', cache: ['raw html', { tool: 'read', result: 'value' }],
    messages: [{ role: 'user', message: '整理当前任务' }],
    runtimeState: { contextDocument: engine.snapshot(), contextDocumentReceipts: [], contextDocumentProjections: [], contextDocumentReviewReceipts: [], contextDocumentEvidenceReviewReceipts: [] },
    createdAt: '2026-11-07T00:00:00.000Z',
  })
  assert.equal(sample.scope, 'session')
  assert.equal(sample.input.projectContext, '')
  assert.equal(sample.input.projectContextRevision, 0)
  assert.equal(sample.input.contextRevision, 0)
  assert.equal(sample.input.rawCache, null)
  assert.deepEqual(sample.input.rawMessages, [])
  assert.match(sample.input.context, /# 信息区/)
  assert.equal(sample.input.cache.length, 2)
  assert.equal(sample.input.messages[0]!.role, 'user')
  assert.equal(recorder.sampleFingerprint('sample-1').length, 64)
})

test('proposal, decision, and post-context are retained and snapshots are detached', () => {
  const recorder = new ContextTrainingRecorder()
  recorder.begin({ sampleId: 'sample-2', scope: 'project', projectId: 'project-2', sessionId: 'session-2', input: { projectContext: 'project-before', projectContextRevision: 2, context: 'before', cache: [], rawCache: null, messages: [], rawMessages: [], systemPrompt: 'rules', contextRevision: 3 } })
  recorder.recordProposal('sample-2', { baseRevision: 3, operations: [{ action: 'replace', position: { section: 'information', nodeId: 'entry-1' }, content: 'after', reason: 'new evidence', sourceRefs: ['cache-1'], evidenceRefs: ['evidence-1'] }] })
  recorder.recordDecision('sample-2', { acceptedOperations: ['replace-1'], rejectedOperations: [], archivedNodeIds: [], recallLinks: [] })
  const completed = recorder.complete('sample-2', { projectContext: 'project-after', projectContextRevision: 3, context: 'after', contextRevision: 4, archivedNodeIds: [], recallLinks: [] })
  assert.equal(completed.output?.contextRevision, 4)
  assert.equal(completed.decision!.acceptedOperations[0], 'replace-1')
  const snapshot = recorder.snapshot()
  snapshot[0]!.input.context = 'mutated outside recorder'
  assert.equal(recorder.get('sample-2')!.input.context, 'before')
})
