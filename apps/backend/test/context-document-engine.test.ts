import assert from 'node:assert/strict'
import test from 'node:test'
import { ContextDocumentEngine, type DiffProposal } from '../src/core/context-document-engine.ts'

function proposal(engine: ContextDocumentEngine, candidateId: string, overrides: Partial<DiffProposal> = {}): DiffProposal {
  const document = engine.snapshot()
  const projection = engine.project({ id: 'test-projection', maxCharacters: 10_000 })
  return {
    id: 'proposal-1',
    documentId: document.id,
    baseRevision: document.revision,
    projectionId: projection.id,
    projectionHash: projection.contentHash,
    target: { section: 'information', headingPath: ['事实'] },
    operation: 'add_entry',
    payload: { body: '已核验事实' },
    candidateId,
    actor: 'system',
    idempotencyKey: 'idem-1',
    createdAt: '2026-11-03T00:00:00.000Z',
    ...overrides,
  }
}

test('creates, serializes, and projects a five-section document', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' })
  const candidate = engine.addCandidate({
    source: { actor: 'tool', sourceId: 'call-1', capturedAt: '2026-11-03T00:00:00.000Z' },
    rawArtifactId: 'artifact-1', normalizedContent: '工具观察结果', evidenceRefs: [],
  })
  const evidence = engine.addEvidence({ kind: 'observation', referenceId: 'call-1', confidence: 'high' })
  engine.attachEvidence(candidate.id, evidence.id)
  const receipt = engine.apply(proposal(engine, candidate.id))
  assert.equal(receipt.result, 'applied')
  assert.equal(engine.snapshot().revision, 4)
  assert.equal(engine.snapshot().sections.find((section) => section.kind === 'candidates')?.revision, 4)
  assert.equal(engine.snapshot().sections.find((section) => section.kind === 'information')?.revision, 4)
  assert.match(engine.serialize(), /capybara:section information/)
  const projection = engine.project({ id: 'default', maxCharacters: 10_000 })
  assert.match(projection.markdown, /已核验事实/)
  assert.equal(projection.contentHash.length, 64)
  const repeat = engine.project({ id: 'default', maxCharacters: 10_000 })
  assert.equal(repeat.contentHash, projection.contentHash)
})

test('projects candidates in captured observation order with deterministic ID tie-breaking', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's-order', projectId: 'p-order', constitutionRevision: 'constitution-1' })
  const later = engine.addCandidate({
    id: 'candidate-z',
    source: { actor: 'tool', sourceId: 'call-z', capturedAt: '2026-11-03T00:00:02.000Z' },
    rawArtifactId: 'artifact-z', normalizedContent: 'later page', evidenceRefs: [],
  })
  const earlier = engine.addCandidate({
    id: 'candidate-a',
    source: { actor: 'tool', sourceId: 'call-a', capturedAt: '2026-11-03T00:00:01.000Z' },
    rawArtifactId: 'artifact-a', normalizedContent: 'earlier page', evidenceRefs: [],
  })
  const projection = engine.project({ id: 'order', maxCharacters: 10_000 })
  assert.ok(projection.markdown.indexOf(earlier.id) < projection.markdown.indexOf(later.id))
})

test('anchor-latest candidate selection keeps the task anchor and newest observations', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's-window', projectId: 'p-window', constitutionRevision: 'constitution-1' })
  engine.addCandidate({
    id: 'candidate-task',
    source: { actor: 'user', sourceId: 'task', capturedAt: '2026-11-03T00:00:00.000Z' },
    rawArtifactId: 'message:task', normalizedContent: '当前任务锚点', evidenceRefs: [],
  })
  for (let index = 1; index <= 5; index += 1) {
    engine.addCandidate({
      id: `candidate-${index}`,
      source: { actor: 'tool', sourceId: `call-${index}`, capturedAt: `2026-11-03T00:00:0${index}.000Z` },
      rawArtifactId: `artifact-${index}`, normalizedContent: `观察-${index}`.repeat(20), evidenceRefs: [],
    })
  }
  const projection = engine.project({ id: 'window', maxCharacters: 2_200, candidateSelection: 'anchor-latest' })
  assert.ok(projection.sourceCandidateIds.includes('candidate-task'))
  assert.ok(projection.sourceCandidateIds.includes('candidate-5'))
  assert.ok(projection.selectionReasons['candidate-5']?.includes('latest-window'))
  assert.ok(projection.markdown.indexOf('candidate-task') < projection.markdown.indexOf('candidate-5'))
})

test('pinned candidates survive the bounded latest window when budget permits', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's-pinned', projectId: 'p-pinned', constitutionRevision: 'constitution-1' })
  engine.addCandidate({
    id: 'candidate-task',
    source: { actor: 'user', sourceId: 'task', capturedAt: '2026-11-03T00:00:00.000Z' },
    rawArtifactId: 'message:task', normalizedContent: '当前任务锚点', evidenceRefs: [],
  })
  for (let index = 1; index <= 8; index += 1) {
    engine.addCandidate({
      id: `candidate-${index}`,
      source: { actor: 'tool', sourceId: `call-${index}`, capturedAt: `2026-11-03T00:00:0${index}.000Z` },
      rawArtifactId: `artifact-${index}`,
      normalizedContent: index === 2 ? '已确认写入回执'.repeat(70) : `噪音-${index}`.repeat(100),
      evidenceRefs: [],
    })
  }
  const projection = engine.project({ id: 'pinned-window', maxCharacters: 1_900, candidateSelection: 'anchor-latest', pinnedCandidateIds: ['candidate-2'] })
  assert.ok(projection.sourceCandidateIds.includes('candidate-task'))
  assert.ok(projection.sourceCandidateIds.includes('candidate-2'))
  assert.ok(projection.selectionReasons['candidate-2']?.includes('pinned-candidate'))
  const unpinned = engine.project({ id: 'unpinned-window', maxCharacters: 1_900, candidateSelection: 'anchor-latest' })
  assert.ok(!unpinned.sourceCandidateIds.includes('candidate-2'))
})

test('batch semantic diffs share one projection and commit atomically', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's-batch', projectId: 'p-batch', constitutionRevision: 'constitution-1' })
  const first = engine.addCandidate({ id: 'candidate-first', source: { actor: 'tool', sourceId: 'call-first', capturedAt: '2026-11-03T00:00:00.000Z' }, rawArtifactId: 'artifact-first', normalizedContent: '第一事实', evidenceRefs: [] })
  const second = engine.addCandidate({ id: 'candidate-second', source: { actor: 'tool', sourceId: 'call-second', capturedAt: '2026-11-03T00:00:01.000Z' }, rawArtifactId: 'artifact-second', normalizedContent: '第二事实', evidenceRefs: [] })
  const firstEvidence = engine.addEvidence({ kind: 'observation', referenceId: 'call-first' })
  const secondEvidence = engine.addEvidence({ kind: 'observation', referenceId: 'call-second' })
  engine.attachEvidence(first.id, firstEvidence.id)
  engine.attachEvidence(second.id, secondEvidence.id)
  const document = engine.snapshot()
  const projection = engine.project({ id: 'batch', maxCharacters: 10_000 })
  const make = (candidateId: string, evidenceId: string, id: string): DiffProposal => ({
    id, documentId: document.id, baseRevision: document.revision, projectionId: projection.id, projectionHash: projection.contentHash,
    target: { section: 'information', headingPath: [id] }, operation: 'add_entry', payload: { body: id, evidenceRefs: [evidenceId] },
    candidateId, actor: 'system', idempotencyKey: id, createdAt: '2026-11-03T00:00:00.000Z',
  })
  const receipts = engine.applyBatch([
    make(first.id, firstEvidence.id, 'batch-first'),
    make(second.id, secondEvidence.id, 'batch-second'),
  ])
  assert.deepEqual(receipts.map((receipt) => receipt.result), ['applied', 'applied'])
  assert.equal(engine.snapshot().information.length, 2)
  assert.equal(engine.snapshot().revision, document.revision + 2)
})

test('failed batch semantic diff leaves the document unchanged', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's-batch-fail', projectId: 'p-batch-fail', constitutionRevision: 'constitution-1' })
  const candidate = engine.addCandidate({ id: 'candidate-only', source: { actor: 'tool', sourceId: 'call-only', capturedAt: '2026-11-03T00:00:00.000Z' }, rawArtifactId: 'artifact-only', normalizedContent: '事实', evidenceRefs: [] })
  const evidence = engine.addEvidence({ kind: 'observation', referenceId: 'call-only' })
  engine.attachEvidence(candidate.id, evidence.id)
  const before = engine.exportState()
  const projection = engine.project({ id: 'batch-fail', maxCharacters: 10_000 })
  const proposalBase = { documentId: before.document.id, baseRevision: before.document.revision, projectionId: projection.id, projectionHash: projection.contentHash, target: { section: 'information' as const, headingPath: ['事实'] }, operation: 'add_entry' as const, payload: { body: '事实', evidenceRefs: [evidence.id] }, actor: 'system' as const, createdAt: '2026-11-03T00:00:00.000Z' }
  assert.throws(() => engine.applyBatch([
    { ...proposalBase, id: 'batch-ok', candidateId: candidate.id, idempotencyKey: 'batch-ok' },
    { ...proposalBase, id: 'batch-missing', candidateId: 'missing', idempotencyKey: 'batch-missing' },
  ]), /CANDIDATE_NOT_FOUND/)
  assert.deepEqual(engine.snapshot(), before.document)
  assert.deepEqual(engine.receiptsSnapshot(), [])
})

test('rejects stale revisions and preserves the document', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' })
  const candidate = engine.addCandidate({
    source: { actor: 'tool', sourceId: 'call-1', capturedAt: '2026-11-03T00:00:00.000Z' },
    rawArtifactId: 'artifact-1', normalizedContent: '结果', evidenceRefs: [],
  })
  const evidence = engine.addEvidence({ kind: 'observation', referenceId: 'call-1', confidence: 'high' })
  engine.attachEvidence(candidate.id, evidence.id)
  const first = engine.apply(proposal(engine, candidate.id))
  assert.equal(first.result, 'applied')
  const before = engine.snapshot()
  const stale = engine.apply(proposal(engine, candidate.id, { id: 'proposal-2', idempotencyKey: 'idem-2', baseRevision: 0 }))
  assert.equal(stale.result, 'conflict')
  assert.equal(stale.errorCode, 'CONTEXT_REVISION_CONFLICT')
  assert.deepEqual(engine.snapshot().information, before.information)
})

test('idempotency returns the original receipt without a second revision', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' })
  const candidate = engine.addCandidate({
    source: { actor: 'tool', sourceId: 'call-1', capturedAt: '2026-11-03T00:00:00.000Z' },
    rawArtifactId: 'artifact-1', normalizedContent: '结果', evidenceRefs: [],
  })
  const evidence = engine.addEvidence({ kind: 'observation', referenceId: 'call-1', confidence: 'high' })
  engine.attachEvidence(candidate.id, evidence.id)
  const first = engine.apply(proposal(engine, candidate.id))
  const second = engine.apply(proposal(engine, candidate.id))
  assert.deepEqual(second, first)
  assert.equal(engine.snapshot().revision, 4)
})

test('idempotency binds execution semantics and rejects conflicting or unverifiable replays', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'c' })
  const evidence = engine.addEvidence({ kind: 'message', referenceId: 'message-1' })
  const candidate = engine.addCandidate({ source: { actor: 'user', sourceId: 'message-1', capturedAt: '2026-11-17T00:00:00Z' }, rawArtifactId: 'message-1', normalizedContent: '金额 125 美元。', evidenceRefs: [evidence.id] })
  const original = proposal(engine, candidate.id, { payload: { body: '金额 125 美元。', evidenceRefs: [evidence.id] } })
  const receipt = engine.apply(original)
  const before = engine.snapshot()
  const rejected = engine.apply({ ...original, payload: { body: '金额 120 美元。', evidenceRefs: [evidence.id] } })
  assert.equal(rejected.result, 'rejected')
  assert.equal(rejected.errorCode, 'IDEMPOTENCY_KEY_CONFLICT')
  assert.deepEqual(engine.snapshot(), before)
  const state = engine.exportState()
  const restored = new ContextDocumentEngine(state.document, state.receipts, state.projections)
  assert.deepEqual(restored.apply({ ...original, id: 'retry-transport-id', createdAt: '2026-11-17T01:00:00Z' }), receipt)
  const legacy = structuredClone(state)
  delete legacy.receipts[0]![1].proposalHash
  const old = new ContextDocumentEngine(legacy.document, legacy.receipts, legacy.projections)
  assert.equal(old.apply(original).errorCode, 'IDEMPOTENCY_PAYLOAD_UNVERIFIABLE')
})

test('batch replay is exact and cannot mix already applied actions with new ones', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'c' })
  const evidence = engine.addEvidence({ kind: 'message', referenceId: 'message-1' })
  const candidate = engine.addCandidate({ source: { actor: 'user', sourceId: 'message-1', capturedAt: '2026-11-17T00:00:00Z' }, rawArtifactId: 'message-1', normalizedContent: '保留事实', evidenceRefs: [evidence.id] })
  const values = [proposal(engine, candidate.id, { idempotencyKey: 'batch-a' }), proposal(engine, candidate.id, { idempotencyKey: 'batch-b', payload: { body: '另一条事实' } })]
  const first = engine.applyBatch(values)
  const before = engine.snapshot()
  assert.deepEqual(engine.applyBatch(values), first)
  assert.throws(() => engine.applyBatch([values[0]!, { ...values[1]!, idempotencyKey: 'batch-c' }]), /PARTIAL_REPLAY/)
  assert.throws(() => engine.applyBatch([{ ...values[0]!, payload: { body: '被改写的事实' } }]), /IDEMPOTENCY_KEY_CONFLICT/)
  assert.deepEqual(engine.snapshot(), before)
})

test('parses serialized information entries and candidates', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' })
  const candidate = engine.addCandidate({
    id: 'candidate-1',
    source: { actor: 'tool', sourceId: 'call-1', capturedAt: '2026-11-03T00:00:00.000Z' },
    rawArtifactId: 'artifact-1', normalizedContent: '候选结果', evidenceRefs: [],
  })
  const evidence = engine.addEvidence({ kind: 'observation', referenceId: 'call-1', confidence: 'high' })
  engine.attachEvidence(candidate.id, evidence.id)
  engine.apply(proposal(engine, candidate.id))
  const restored = ContextDocumentEngine.parse(engine.serialize(), {
    sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1',
  })
  assert.equal(restored.snapshot().information.length, 1)
  assert.equal(restored.snapshot().candidates[0]?.id, 'candidate-1')
  assert.deepEqual(restored.snapshot().evidence, [evidence])
  assert.deepEqual(restored.snapshot().candidates[0]?.evidenceRefs, [evidence.id])
})

test('round-trips document identity and cursor metadata through Markdown', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 'session-identity', projectId: 'project-identity', constitutionRevision: 'constitution-identity', now: '2026-11-03T00:00:00.000Z' })
  engine.setMessageCursor(7)
  const before = engine.snapshot()
  const restored = ContextDocumentEngine.parse(engine.serialize(), {
    sessionId: 'fallback-session', projectId: 'fallback-project', constitutionRevision: 'fallback-constitution', now: '2027-01-01T00:00:00.000Z',
  })
  const after = restored.snapshot()
  assert.equal(after.id, before.id)
  assert.equal(after.sessionId, before.sessionId)
  assert.equal(after.projectId, before.projectId)
  assert.equal(after.constitutionRevision, before.constitutionRevision)
  assert.equal(after.revision, before.revision)
  assert.equal(after.messageCursor, before.messageCursor)
  assert.equal(after.createdAt, before.createdAt)
  assert.equal(after.updatedAt, before.updatedAt)
})

test('deduplicated observations return the candidate with merged evidence', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' })
  const first = engine.observe({
    candidate: {
      source: { actor: 'tool', sourceId: 'call-1', capturedAt: '2026-11-03T00:00:00.000Z' },
      rawArtifactId: 'artifact-1', normalizedContent: '第一次观察',
    },
    evidence: { id: 'evidence-1', kind: 'observation', referenceId: 'call-1' },
  })
  const second = engine.observe({
    candidate: {
      source: { actor: 'tool', sourceId: 'call-1', capturedAt: '2026-11-03T00:00:01.000Z' },
      rawArtifactId: 'artifact-1', normalizedContent: '重复观察',
    },
    evidence: { id: 'evidence-2', kind: 'artifact', referenceId: 'artifact-1' },
  })
  assert.equal(second.candidate.id, first.candidate.id)
  assert.deepEqual(second.candidate.evidenceRefs, ['evidence-1', 'evidence-2'])
  assert.equal(engine.snapshot().candidates[0]?.evidenceRefs.length, 2)
})

test('observation deduplication keeps actor channels separate', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' })
  const user = engine.observe({
    candidate: {
      source: { actor: 'user', sourceId: 'shared-id', capturedAt: '2026-11-03T00:00:00.000Z' },
      rawArtifactId: 'message:shared-id', normalizedContent: '用户消息',
    },
  })
  const tool = engine.observe({
    candidate: {
      source: { actor: 'tool', sourceId: 'shared-id', capturedAt: '2026-11-03T00:00:01.000Z', toolName: 'search' },
      rawArtifactId: 'observation:shared-id', normalizedContent: '工具结果',
    },
  })
  assert.notEqual(tool.candidate.id, user.candidate.id)
  assert.equal(engine.snapshot().candidates.length, 2)
})

test('re-observing identical evidence does not invalidate an issued projection', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's', projectId: 'p', constitutionRevision: 'c' })
  const observation = { candidate: { source: { actor: 'tool' as const, sourceId: 'call', capturedAt: '2026-11-17T00:00:00Z' }, rawArtifactId: 'artifact', normalizedContent: '金额 125 美元' },
    evidence: { kind: 'artifact' as const, referenceId: 'artifact', sessionId: 's', sourceHash: 'immutable-hash', observedAt: '2026-11-17T00:00:00Z' } }
  const first = engine.observe(observation)
  const projected = engine.project({ id: 'before-consumption', maxCharacters: 4096 })
  const before = engine.snapshot()
  const consumed = engine.observe(observation)
  assert.equal(consumed.evidence!.id, first.evidence!.id)
  assert.deepEqual(engine.snapshot(), before)
  const applied = engine.apply(engine.propose({ projection: projected, candidateId: first.candidate.id, target: { section: 'information' }, operation: 'add_entry', payload: { body: '金额 125 美元' }, actor: 'model', idempotencyKey: 'after-consumption' }))
  assert.equal(applied.result, 'applied')
  assert.throws(() => engine.observe({ ...observation, evidence: { ...observation.evidence, id: first.evidence!.id, sourceHash: 'different' } }), /EVIDENCE_ID_CONFLICT/)
})

test('round-trips caller-supplied candidate identifiers', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' })
  engine.addCandidate({
    id: 'source-call-42',
    source: { actor: 'tool', sourceId: 'call-42', capturedAt: '2026-11-03T00:00:00.000Z' },
    rawArtifactId: 'artifact-42', normalizedContent: '保留自定义 ID', evidenceRefs: [],
  })
  const restored = ContextDocumentEngine.parse(engine.serialize(), { sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' })
  assert.equal(restored.snapshot().candidates[0]?.id, 'source-call-42')
})

test('rejects candidates that reference evidence not present in the document', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' })
  assert.throws(() => engine.addCandidate({
    source: { actor: 'tool', sourceId: 'call-1', capturedAt: '2026-11-03T00:00:00.000Z' },
    rawArtifactId: 'artifact-1', normalizedContent: '结果', evidenceRefs: ['missing-evidence'],
  }), /EVIDENCE_NOT_FOUND/)
})

test('rejects malformed candidate source metadata at the engine boundary', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' })
  assert.throws(() => engine.addCandidate({
    source: { actor: 'tool', sourceId: '', capturedAt: '2026-11-03T00:00:00.000Z' },
    rawArtifactId: 'artifact-1', normalizedContent: '结果', evidenceRefs: [],
  }), /CONTEXT_INVALID_CANDIDATE_SOURCE/)
})

test('rejects proposal bindings that do not match the authored projection', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' })
  const candidate = engine.addCandidate({
    source: { actor: 'tool', sourceId: 'call-1', capturedAt: '2026-11-03T00:00:00.000Z' },
    rawArtifactId: 'artifact-1', normalizedContent: '结果', evidenceRefs: [],
  })
  const evidence = engine.addEvidence({ kind: 'observation', referenceId: 'call-1', confidence: 'high' })
  engine.attachEvidence(candidate.id, evidence.id)
  const projection = engine.project({ id: 'test', maxCharacters: 10_000 })
  const receipt = engine.apply({
    id: 'proposal-binding', documentId: engine.snapshot().id, baseRevision: engine.snapshot().revision,
    projectionId: projection.id, projectionHash: '0'.repeat(64),
    target: { section: 'information', headingPath: ['事实'] }, operation: 'add_entry', payload: { body: '事实' },
    candidateId: candidate.id, actor: 'system', idempotencyKey: 'binding-1', createdAt: '2026-11-03T00:00:00.000Z',
  })
  assert.equal(receipt.result, 'conflict')
  assert.equal(receipt.errorCode, 'PROJECTION_HASH_CONFLICT')
  assert.equal(engine.snapshot().revision, 3)
})

test('rejects a semantic diff for a candidate omitted from its projection', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's-binding', projectId: 'p-binding', constitutionRevision: 'constitution-1' })
  const visible = engine.addCandidate({ id: 'candidate-visible', source: { actor: 'tool', sourceId: 'visible', capturedAt: '2026-11-03T00:00:00.000Z' }, rawArtifactId: 'visible', normalizedContent: '可见'.repeat(300), evidenceRefs: [] })
  const hidden = engine.addCandidate({ id: 'candidate-hidden', source: { actor: 'tool', sourceId: 'hidden', capturedAt: '2026-11-03T00:00:01.000Z' }, rawArtifactId: 'hidden', normalizedContent: '隐藏', evidenceRefs: [] })
  const evidence = engine.addEvidence({ kind: 'observation', referenceId: 'hidden' })
  engine.attachEvidence(hidden.id, evidence.id)
  const projection = engine.project({ id: 'binding', maxCharacters: 1_400, includeStatuses: ['pending'], candidateSelection: 'chronological' })
  const result = engine.apply({
    id: 'hidden-proposal', documentId: engine.snapshot().id, baseRevision: engine.snapshot().revision,
    projectionId: projection.id, projectionHash: projection.contentHash, target: { section: 'information', headingPath: ['隐藏'] },
    operation: 'add_entry', payload: { body: '隐藏', evidenceRefs: [evidence.id] }, candidateId: hidden.id, actor: 'system',
    idempotencyKey: 'hidden-proposal', createdAt: '2026-11-03T00:00:00.000Z',
  })
  assert.equal(projection.sourceCandidateIds.includes(visible.id), true)
  assert.equal(projection.sourceCandidateIds.includes(hidden.id), false)
  assert.equal(result.result, 'rejected')
  assert.equal(result.errorCode, 'CANDIDATE_NOT_IN_PROJECTION')
})

test('context section changes advance revision and invalidate old projections', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 'session', projectId: 'project', constitutionRevision: 'constitution-v2.1' })
  const before = engine.snapshot()
  const projection = engine.project({ id: 'runtime', maxCharacters: 4096 })
  engine.setSectionContent('messages', 'a new user message')
  assert.equal(engine.snapshot().revision, before.revision + 1)

  const receipt = engine.apply({
    id: 'stale-context',
    documentId: before.id,
    baseRevision: projection.documentRevision,
    projectionId: projection.id,
    projectionHash: projection.contentHash,
    target: { section: 'information' },
    operation: 'add_entry',
    payload: { body: 'stale' },
    candidateId: 'missing',
    actor: 'model',
    idempotencyKey: 'stale-context',
    createdAt: new Date().toISOString(),
  })
  assert.equal(receipt.result, 'conflict')
  assert.equal(receipt.errorCode, 'CONTEXT_REVISION_CONFLICT')
})

test('system and tools sections require runtime governance', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 'session', projectId: 'project', constitutionRevision: 'constitution-v2.1' })
  assert.throws(() => engine.setSectionContent('system', 'override'), /IMMUTABLE_SYSTEM_SECTION/)
  assert.doesNotThrow(() => engine.setSectionContent('system', 'runtime constitution', { governance: 'runtime' }))
})

test('rejects malformed or reordered section markers', () => {
  const base = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' }).serialize()
  assert.throws(() => ContextDocumentEngine.parse(base.replace('capybara:section system', 'capybara:section unknown'), { sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' }), /CONTEXT_INVALID_SECTION_MARKER/)
  const parts = base.split('\n\n---\n\n')
  assert.throws(() => ContextDocumentEngine.parse([parts[1], parts[0], ...parts.slice(2)].join('\n\n---\n\n'), { sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' }), /CONTEXT_SECTION_ORDER_INVALID/)
})

test('restores projection bindings and idempotency receipts from engine state', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' })
  const candidate = engine.addCandidate({ source: { actor: 'tool', sourceId: 'call-1', capturedAt: '2026-11-03T00:00:00.000Z' }, rawArtifactId: 'artifact-1', normalizedContent: '结果', evidenceRefs: [] })
  const evidence = engine.addEvidence({ kind: 'observation', referenceId: 'call-1', confidence: 'high' })
  engine.attachEvidence(candidate.id, evidence.id)
  const projection = engine.project({ id: 'restore', maxCharacters: 10_000 })
  const first = engine.apply({ id: 'restore-proposal', documentId: engine.snapshot().id, baseRevision: 3, projectionId: projection.id, projectionHash: projection.contentHash, target: { section: 'information', headingPath: ['事实'] }, operation: 'add_entry', payload: { body: '事实' }, candidateId: candidate.id, actor: 'system', idempotencyKey: 'restore-idem', createdAt: '2026-11-03T00:00:00.000Z' })
  const state = engine.exportState()
  const restored = new ContextDocumentEngine(state.document, state.receipts, state.projections, state.reviewReceipts)
  assert.deepEqual(restored.apply({ id: 'different-id', documentId: state.document.id, baseRevision: 3, projectionId: projection.id, projectionHash: projection.contentHash, target: { section: 'information', headingPath: ['事实'] }, operation: 'add_entry', payload: { body: '事实' }, candidateId: candidate.id, actor: 'system', idempotencyKey: 'restore-idem', createdAt: '2026-11-03T00:00:00.000Z' }), first)
  assert.equal(restored.snapshot().revision, 4)
})

test('detaches restored document state from the caller snapshot', () => {
  const source = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' }).snapshot()
  const restored = new ContextDocumentEngine(source)
  source.sections[0]!.content = 'caller mutation'
  source.information.push({
    id: 'caller-entry', sectionId: 'information', headingPath: ['外部变更'], body: '不应进入引擎',
    status: 'active', evidenceRefs: [], sourceCandidateIds: [], supersedesEntryIds: [], revision: source.revision,
  })
  assert.equal(restored.snapshot().sections[0]?.content, '')
  assert.equal(restored.snapshot().information.length, 0)
})

test('rejects restored information entries with unknown lineage references', () => {
  const source = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' }).snapshot()
  source.information.push({
    id: 'info-invalid', sectionId: 'information', headingPath: ['事实'], body: '不完整', status: 'active',
    evidenceRefs: [], sourceCandidateIds: ['missing-candidate'], supersedesEntryIds: [], revision: 0,
  })
  assert.throws(() => new ContextDocumentEngine(source), /CONTEXT_INVALID_CANDIDATE_REF/)
})

test('rejects restored documents with missing structural collections', () => {
  const source = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' }).snapshot() as unknown as Record<string, unknown>
  delete source.candidates
  assert.throws(() => new ContextDocumentEngine(source as never), /CONTEXT_INVALID_DOCUMENT/)
})

test('rejects restored documents with malformed fixed section structure', () => {
  const source = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' }).snapshot()
  source.sections[0] = { ...source.sections[0]!, kind: 'messages' }
  assert.throws(() => new ContextDocumentEngine(source), /CONTEXT_INVALID_SECTIONS/)
})

test('candidate review keeps evidence governance and advances the document revision', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' })
  const candidate = engine.addCandidate({ source: { actor: 'tool', sourceId: 'call-1', capturedAt: '2026-11-03T00:00:00.000Z' }, rawArtifactId: 'artifact-1', normalizedContent: '冲突结果', evidenceRefs: [] })
  const rejected = engine.reviewCandidate(candidate.id, 'rejected', engine.snapshot().revision, '来源冲突')
  assert.equal(rejected.result, 'reviewed')
  assert.equal(engine.snapshot().candidates[0]?.status, 'rejected')
  const evidence = engine.addEvidence({ kind: 'observation', referenceId: 'call-1', confidence: 'medium' })
  engine.attachEvidence(candidate.id, evidence.id)
  const reviewed = engine.reviewCandidate(candidate.id, 'conflict', engine.snapshot().revision, '两个来源不一致')
  assert.equal(reviewed.result, 'reviewed')
  assert.equal(engine.snapshot().candidates[0]?.status, 'conflict')
  assert.equal(engine.snapshot().revision, 5)
  assert.equal(engine.reviewReceiptsSnapshot().length, 2)
})

test('candidate review rejects a document binding mismatch without mutation', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' })
  const candidate = engine.addCandidate({ source: { actor: 'tool', sourceId: 'call-1', capturedAt: '2026-11-03T00:00:00.000Z' }, rawArtifactId: 'artifact-1', normalizedContent: '结果', evidenceRefs: [] })
  const before = engine.snapshot()
  const receipt = engine.reviewCandidate(candidate.id, 'rejected', before.revision, '绑定错误', 'other-document')
  assert.equal(receipt.result, 'rejected')
  assert.equal(receipt.errorCode, 'DOCUMENT_ID_MISMATCH')
  assert.equal(engine.snapshot().revision, before.revision)
})

test('round-trips candidate and information governance metadata', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' })
  const candidate = engine.addCandidate({
    id: 'candidate-rich',
    source: { actor: 'tool', sourceId: 'call-rich', toolName: 'search', runId: 'run-1', stepId: 'step-1', capturedAt: '2026-11-03T00:00:00.000Z' },
    rawArtifactId: 'artifact-rich', normalizedContent: '规范化结果', evidenceRefs: [],
  })
  const evidence = engine.addEvidence({ id: 'evidence-rich', kind: 'observation', referenceId: 'call-rich', sourceHash: 'abc', observedAt: '2026-11-03T00:00:01.000Z', locator: '$.items[0]', confidence: 'high' })
  engine.attachEvidence(candidate.id, evidence.id)
  const receipt = engine.apply(proposal(engine, candidate.id, {
    id: 'proposal-rich', idempotencyKey: 'idem-rich', payload: { body: '已核验事实', evidenceRefs: [evidence.id] },
  }))
  assert.equal(receipt.result, 'applied')
  const before = engine.snapshot()
  const restored = ContextDocumentEngine.parse(engine.serialize(), { sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' })
  const restoredCandidate = restored.snapshot().candidates[0]
  const restoredEntry = restored.snapshot().information[0]
  assert.deepEqual(restoredCandidate?.source, before.candidates[0]?.source)
  assert.equal(restoredCandidate?.rawArtifactId, 'artifact-rich')
  assert.deepEqual(restoredCandidate?.evidenceRefs, [evidence.id])
  assert.deepEqual(restoredCandidate?.proposedDiffIds, ['proposal-rich'])
  assert.equal(restoredCandidate?.reviewedAt, before.candidates[0]?.reviewedAt)
  assert.deepEqual(restoredEntry?.evidenceRefs, [evidence.id])
  assert.deepEqual(restoredEntry?.sourceCandidateIds, [candidate.id])
})

test('projection truncates only at section or entity boundaries and reports selected sources', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' })
  const candidate = engine.addCandidate({ id: 'candidate-long', source: { actor: 'tool', sourceId: 'call-long', capturedAt: '2026-11-03T00:00:00.000Z' }, rawArtifactId: 'artifact-long', normalizedContent: '候选内容'.repeat(200), evidenceRefs: [] })
  const projection = engine.project({ id: 'tiny', maxCharacters: 512 })
  assert.ok(projection.truncatedSections.length > 0)
  assert.equal(projection.sourceCandidateIds.includes(candidate.id), projection.markdown.includes(candidate.id))
  assert.doesNotMatch(projection.markdown, /projection truncated/)
  assert.equal(projection.contentHash.length, 64)
})

test('projection never exceeds the requested character budget when sections are omitted', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' })
  for (const maxCharacters of [256, 300, 512]) {
    const projection = engine.project({ id: `bounded-${maxCharacters}`, maxCharacters })
    assert.ok(projection.markdown.length <= maxCharacters, `${projection.markdown.length} > ${maxCharacters}`)
  }
})

test('projection section priority preserves current messages before lower-priority candidates', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' })
  engine.setSectionContent('messages', '当前任务：先完成已确认动作，再报告结果')
  engine.setMessageCursor(4)
  engine.addCandidate({ id: 'candidate-priority', source: { actor: 'tool', sourceId: 'priority-tool', capturedAt: '2026-11-03T00:00:00.000Z' }, rawArtifactId: 'priority-artifact', normalizedContent: '候选观察'.repeat(120), evidenceRefs: [] })
  const projection = engine.project({
    id: 'priority',
    maxCharacters: 1400,
    sectionOrder: ['system', 'messages', 'information', 'candidates', 'tools'],
    includeTools: false,
  })
  assert.equal(projection.sourceMessageCursor, 4)
  assert.ok(projection.markdown.indexOf('当前任务') >= 0)
  assert.ok(projection.markdown.indexOf('当前任务') < projection.markdown.indexOf('候选观察'))
  assert.deepEqual(projection, engine.project({
    id: 'priority',
    maxCharacters: 1400,
    sectionOrder: ['system', 'messages', 'information', 'candidates', 'tools'],
    includeTools: false,
  }))
})

test('projection rejects incomplete or duplicate section priority orders', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' })
  assert.throws(() => engine.project({ id: 'invalid-order', maxCharacters: 512, sectionOrder: ['system'] as any }), /PROJECTION_SECTION_ORDER_INVALID/)
  assert.throws(() => engine.project({ id: 'duplicate-order', maxCharacters: 512, sectionOrder: ['system', 'tools', 'information', 'candidates', 'candidates'] as any }), /PROJECTION_SECTION_ORDER_INVALID/)
})

test('memory recall is candidate-only and child merge preserves authority metadata', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' })
  const memory = engine.addCandidate({ id: 'candidate-memory', source: { actor: 'memory', sourceId: 'memory-1', capturedAt: '2026-11-03T00:00:00.000Z' }, rawArtifactId: 'memory-1', normalizedContent: '关于纽约公寓的旧记忆', evidenceRefs: [] })
  engine.addCandidate({ id: 'candidate-tool', source: { actor: 'tool', sourceId: 'tool-1', capturedAt: '2026-11-03T00:00:00.000Z' }, rawArtifactId: 'tool-1', normalizedContent: '纽约公寓观察', evidenceRefs: [] })
  assert.deepEqual(engine.recallMemory({ query: '纽约 公寓' }).map((candidate) => candidate.id), [memory.id])
  assert.deepEqual(engine.recallMemoryDetailed({ query: '纽约 公寓' }).map((match) => match.reason), ['matched:纽约,公寓'])
  const child = engine.mergeChildCandidate({ id: 'candidate-child', sourceId: 'child-1', runId: 'child-run', stepId: 'child-step', rawArtifactId: 'child-artifact', normalizedContent: '子代理结果', evidenceRefs: [] })
  assert.equal(child.source.actor, 'child-agent')
  assert.equal(child.source.runId, 'child-run')
})

test('evidence review records needs-more-evidence without promoting a candidate', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' })
  const candidate = engine.addCandidate({ id: 'candidate-review', source: { actor: 'tool', sourceId: 'review-source', capturedAt: '2026-11-03T00:00:00.000Z' }, rawArtifactId: 'artifact-review', normalizedContent: '待补证据', evidenceRefs: [] })
  const result = engine.reviewEvidence({ candidateId: candidate.id, decision: 'needs_more_evidence', baseRevision: engine.snapshot().revision, rationale: '需要第二个来源' })
  assert.equal(result.reviewRevision, engine.snapshot().revision)
  assert.equal(engine.snapshot().candidates[0]?.status, 'pending')
  assert.equal(engine.evidenceReviewReceiptsSnapshot().length, 1)
})

test('evidence review and semantic diffs reject evidence that is not bound to the candidate', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's-bound', projectId: 'p-bound', constitutionRevision: 'constitution-1' })
  const candidate = engine.addCandidate({ id: 'candidate-bound', source: { actor: 'tool', sourceId: 'bound-source', capturedAt: '2026-11-03T00:00:00.000Z' }, rawArtifactId: 'bound-artifact', normalizedContent: '候选事实', evidenceRefs: [] })
  const attached = engine.addEvidence({ kind: 'observation', referenceId: 'bound-source' })
  const unrelated = engine.addEvidence({ kind: 'external', referenceId: 'unrelated-source' })
  engine.attachEvidence(candidate.id, attached.id)
  assert.throws(() => engine.reviewEvidence({ candidateId: candidate.id, decision: 'conflict', baseRevision: engine.snapshot().revision, contradictingEvidence: [unrelated.id] }), /EVIDENCE_NOT_BOUND/)
  const before = engine.snapshot()
  const diff = proposal(engine, candidate.id, { payload: { body: '错误提升', evidenceRefs: [unrelated.id] } })
  const receipt = engine.apply(diff)
  assert.equal(receipt.result, 'rejected')
  assert.equal(receipt.errorCode, 'EVIDENCE_NOT_BOUND')
  assert.deepEqual(engine.snapshot(), before)
})

test('replace_body creates a superseding information entry instead of erasing lineage', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's1', projectId: 'p1', constitutionRevision: 'constitution-1' })
  const candidate = engine.addCandidate({ source: { actor: 'tool', sourceId: 'replace-source', capturedAt: '2026-11-03T00:00:00.000Z' }, rawArtifactId: 'replace-artifact', normalizedContent: '事实', evidenceRefs: [] })
  const evidence = engine.addEvidence({ kind: 'observation', referenceId: 'replace-source' })
  engine.attachEvidence(candidate.id, evidence.id)
  const first = engine.apply(proposal(engine, candidate.id, { id: 'first', idempotencyKey: 'first', payload: { body: '旧事实' } }))
  const oldEntry = engine.snapshot().information[0]
  assert.ok(oldEntry)
  const replacementCandidate = engine.addCandidate({ source: { actor: 'tool', sourceId: 'replace-source-2', capturedAt: '2026-11-03T00:00:00.000Z' }, rawArtifactId: 'replace-artifact-2', normalizedContent: '新事实', evidenceRefs: [evidence.id] })
  const replacementProjection = engine.project({ id: 'replace', maxCharacters: 10_000 })
  const replaced = engine.apply({ ...proposal(engine, replacementCandidate.id), id: 'replace', idempotencyKey: 'replace', baseRevision: engine.snapshot().revision, projectionId: replacementProjection.id, projectionHash: replacementProjection.contentHash, target: { section: 'information', entryId: oldEntry.id }, operation: 'replace_body', payload: { body: '新事实', evidenceRefs: [evidence.id] } })
  assert.equal(first.result, 'applied')
  assert.equal(replaced.result, 'applied')
  assert.equal(engine.snapshot().information.find((entry) => entry.id === oldEntry.id)?.status, 'superseded')
  assert.deepEqual(engine.snapshot().information.at(-1)?.supersedesEntryIds, [oldEntry.id])
})
