import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ContextDocumentEngine } from '#core/context-document-engine'
import { ContextTrainingRecorder, toTrainableContextExample, validateContextTrainingSample } from '#core/context-training-recorder'
import { initializeProjectDirectory } from '#core/project-initializer'
import { RuntimeLoop, type RuntimeLlm } from '#core/runtime-loop'
import type { ClientCommand } from '#protocol/runtime-protocol'

function input() {
  return {
    projectContext: '# project',
    projectContextRevision: 1,
    context: '# session',
    cache: [{ candidateId: 'candidate-1', normalizedContent: '缓存事实', evidenceRefs: ['evidence-1'] }],
    rawCache: { messages: ['缓存事实'] },
    messages: [{ role: 'user', message: '整理当前任务' }],
    rawMessages: [{ role: 'user', content: '整理当前任务' }],
    systemPrompt: '保留来源、归档可召回、冲突不折叠',
    contextRevision: 2,
  }
}

function command<TType extends ClientCommand['type']>(type: TType, payload: Extract<ClientCommand, { type: TType }>['payload'], id: string): ClientCommand {
  return { version: 1, kind: 'command', id, type, sessionId: 'closure-session', timestamp: '2026-11-11T00:00:00.000Z', payload } as ClientCommand
}

test('archived information remains out of active projection and is recallable', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's-archive', projectId: 'p-archive', constitutionRevision: 'v2' })
  const evidence = engine.addEvidence({ id: 'evidence-archive', kind: 'message', referenceId: 'message-archive' })
  const candidate = engine.addCandidate({ id: 'candidate-archive', source: { actor: 'memory', sourceId: 'memory-archive', capturedAt: '2026-11-11T00:00:00.000Z' }, rawArtifactId: 'artifact-archive', normalizedContent: '长期项目归档规则', evidenceRefs: [evidence.id] })
  const firstProjection = engine.project({ id: 'archive-add', maxCharacters: 4096 })
  const added = engine.apply(engine.propose({ projection: firstProjection, candidateId: candidate.id, target: { section: 'information', headingPath: ['长期规则'] }, operation: 'add_entry', payload: { body: '长期项目归档规则', evidenceRefs: [evidence.id] }, actor: 'model', idempotencyKey: 'archive-add' }))
  const entryId = added.changedEntryIds[0] as string
  const archiveProjection = engine.project({ id: 'archive-mark', maxCharacters: 4096, includeStatuses: ['accepted'] })
  const archived = engine.apply(engine.propose({ projection: archiveProjection, candidateId: candidate.id, target: { section: 'information', entryId }, operation: 'mark_status', payload: { status: 'archived' }, actor: 'memory', idempotencyKey: 'archive-mark' }))
  assert.equal(archived.result, 'applied')
  assert.doesNotMatch(engine.project({ id: 'active-only', maxCharacters: 4096 }).markdown, /长期项目归档规则/u)
  const recalled = engine.recallArchivedInformation({ query: '归档规则' })
  assert.deepEqual(recalled.map((match) => match.entry.id), [entryId])
})

test('archive and recall reduce the active document while preserving the original evidence', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's-archive-metric', projectId: 'p-archive-metric', constitutionRevision: 'v2' })
  const relevantEvidence = engine.addEvidence({ id: 'evidence-relevant', kind: 'message', referenceId: 'message-relevant' })
  const noiseEvidence = engine.addEvidence({ id: 'evidence-noise', kind: 'message', referenceId: 'message-noise' })
  const relevant = engine.addCandidate({ id: 'candidate-relevant', source: { actor: 'memory', sourceId: 'memory-relevant', capturedAt: '2026-11-11T00:00:00.000Z' }, rawArtifactId: 'artifact-relevant', normalizedContent: '当前任务需要保留的关键约束', evidenceRefs: [relevantEvidence.id] })
  const noise = engine.addCandidate({ id: 'candidate-noise', source: { actor: 'memory', sourceId: 'memory-noise', capturedAt: '2026-11-11T00:00:00.000Z' }, rawArtifactId: 'artifact-noise', normalizedContent: '与当前任务无关的旧会议备注', evidenceRefs: [noiseEvidence.id] })
  const initialProjection = engine.project({ id: 'archive-metric-add', maxCharacters: 4096 })
  const addedRelevant = engine.apply(engine.propose({ projection: initialProjection, candidateId: relevant.id, target: { section: 'information', headingPath: ['当前任务'] }, operation: 'add_entry', payload: { body: relevant.normalizedContent, evidenceRefs: [relevantEvidence.id] }, actor: 'model', idempotencyKey: 'archive-metric-add-relevant' }))
  const relevantEntryId = addedRelevant.changedEntryIds[0] as string
  const afterRelevantProjection = engine.project({ id: 'archive-metric-add-noise', maxCharacters: 4096 })
  const addedNoise = engine.apply(engine.propose({ projection: afterRelevantProjection, candidateId: noise.id, target: { section: 'information', headingPath: ['历史备注'] }, operation: 'add_entry', payload: { body: noise.normalizedContent, evidenceRefs: [noiseEvidence.id] }, actor: 'model', idempotencyKey: 'archive-metric-add-noise' }))
  const noiseEntryId = addedNoise.changedEntryIds[0] as string
  const beforeArchive = engine.project({ id: 'archive-metric-before', maxCharacters: 4096 })
  const archiveProjection = engine.project({ id: 'archive-metric-mark', maxCharacters: 4096, includeStatuses: ['accepted'] })
  const archived = engine.apply(engine.propose({ projection: archiveProjection, candidateId: noise.id, target: { section: 'information', entryId: noiseEntryId }, operation: 'mark_status', payload: { status: 'archived' }, actor: 'memory', idempotencyKey: 'archive-metric-mark' }))
  assert.equal(archived.result, 'applied')
  const afterArchive = engine.project({ id: 'archive-metric-after', maxCharacters: 4096 })
  assert.ok(afterArchive.markdown.length < beforeArchive.markdown.length)
  assert.match(afterArchive.markdown, /当前任务需要保留的关键约束/u)
  assert.doesNotMatch(afterArchive.markdown, /与当前任务无关的旧会议备注/u)
  assert.equal(engine.snapshot().information.find(entry => entry.id === relevantEntryId)?.status, 'active')
  const recalled = engine.recallArchivedInformation({ query: '旧会议备注' })
  assert.equal(recalled.length, 1)
  assert.equal(recalled[0]?.entry.id, noiseEntryId)
  assert.deepEqual(recalled[0]?.entry.evidenceRefs, [noiseEvidence.id])
})

test('complete samples cover archive, recall, rejection, and preserved conflict and convert directly to a training example', () => {
  const recorder = new ContextTrainingRecorder()
  recorder.begin({ sampleId: 'closure-1', scope: 'session', projectId: 'p-1', sessionId: 's-1', input: input() })
  recorder.recordProposal('closure-1', {
    baseRevision: 2,
    operations: [{ scope: 'session', action: 'mark_status', position: { section: 'information', nodeId: 'entry-archive' }, content: '长期规则', reason: '归档当前不需要的细节', sourceRefs: ['candidate-1'], evidenceRefs: ['evidence-1'] }],
  })
  recorder.recordDecision('closure-1', {
    acceptedOperations: ['proposal-archive'],
    rejectedOperations: ['proposal-rejected'],
    archivedNodeIds: ['entry-archive'],
    recallLinks: ['entry-archive'],
    receipts: [
      { kind: 'apply', id: 'receipt-archive', result: 'applied', subjectId: 'proposal-archive', previousRevision: 2, nextRevision: 3, changedEntryIds: ['entry-archive'], createdAt: '2026-11-11T00:00:01.000Z' },
      { kind: 'apply', id: 'receipt-rejected', result: 'rejected', subjectId: 'proposal-rejected', previousRevision: 3, errorCode: 'UNRESOLVED_CANDIDATE_CONFLICT', createdAt: '2026-11-11T00:00:02.000Z' },
    ],
    archiveRecords: [{ id: 'archive-entry-archive', scope: 'session', entryId: 'entry-archive', operationId: 'proposal-archive', result: 'applied', body: '长期规则', headingPath: ['规则'], evidenceRefs: ['evidence-1'], sourceCandidateIds: ['candidate-1'], reason: '归档当前不需要的细节', createdAt: '2026-11-11T00:00:01.000Z' }],
    recalls: [{ id: 'recall-1', scope: 'session', query: '长期规则', candidateIds: [], archivedEntryIds: ['entry-archive'], selectedIds: ['entry-archive'], reasons: { 'entry-archive': 'matched:长期规则' }, createdAt: '2026-11-11T00:00:03.000Z' }],
    candidateReviews: [{ id: 'candidate-review-1', candidateId: 'candidate-rejected', result: 'reviewed', status: 'rejected', reason: '来源不足', previousRevision: 3, nextRevision: 4, evidenceRefs: ['evidence-1'], createdAt: '2026-11-11T00:00:04.000Z' }],
    evidenceReviews: [{ candidateId: 'candidate-conflict', decision: 'conflict', supportingEvidence: ['evidence-a'], contradictingEvidence: ['evidence-b'], targetEntryIds: [], rationale: '两个来源对同一结论给出相反判断', reviewRevision: 4, createdAt: '2026-11-11T00:00:05.000Z' }],
    preservedConflicts: [{ id: 'conflict-1', candidateId: 'candidate-conflict', evidenceRefs: ['evidence-a', 'evidence-b'], supportingEvidence: ['evidence-a'], contradictingEvidence: ['evidence-b'], rationale: '保留两组证据，交给大模型判断', preserved: true, createdAt: '2026-11-11T00:00:05.000Z' }],
  })
  recorder.complete('closure-1', { projectContext: '# project after', projectContextRevision: 1, context: '# session after', contextRevision: 4, archivedNodeIds: ['entry-archive'], recallLinks: ['entry-archive'] })
  assert.deepEqual(validateContextTrainingSample(recorder.get('closure-1')!), [])
  const example = toTrainableContextExample(recorder.get('closure-1')!)
  assert.equal(example.schemaVersion, 2)
  assert.deepEqual(JSON.parse(JSON.stringify(example)), example)
  assert.equal(example.target.decision.archiveRecords?.[0]?.result, 'applied')
  assert.equal(example.target.decision.recalls?.[0]?.archivedEntryIds[0], 'entry-archive')
  assert.equal(example.target.decision.receipts?.some((receipt) => receipt.result === 'rejected'), true)
  assert.equal(example.target.decision.preservedConflicts?.[0]?.preserved, true)
})

test('validator rejects a conflict sample that collapses the evidence sides', () => {
  const recorder = new ContextTrainingRecorder()
  recorder.begin({ sampleId: 'closure-invalid', scope: 'session', projectId: 'p-1', sessionId: 's-1', input: input() })
  recorder.recordDecision('closure-invalid', {
    acceptedOperations: [], rejectedOperations: [], archivedNodeIds: [], recallLinks: [],
    preservedConflicts: [{ id: 'bad-conflict', candidateId: 'candidate-1', evidenceRefs: ['evidence-1'], supportingEvidence: ['evidence-1'], contradictingEvidence: [], rationale: '冲突被压成单一证据', preserved: true, createdAt: '2026-11-11T00:00:00.000Z' }],
  })
  recorder.complete('closure-invalid', { context: '# session', contextRevision: 2, archivedNodeIds: [], recallLinks: [] })
  assert.ok(validateContextTrainingSample(recorder.get('closure-invalid')!).some((error) => error.startsWith('CONFLICT_EVIDENCE_NOT_PRESERVED')))
})

test('validator rejects a project operation without placement classification', () => {
  const recorder = new ContextTrainingRecorder()
  recorder.begin({ sampleId: 'closure-project-classification', scope: 'session', projectId: 'p-1', sessionId: 's-1', input: input() })
  recorder.recordProposal('closure-project-classification', {
    baseRevision: 2,
    operations: [{ scope: 'project', action: 'add', position: { section: 'information' }, content: '项目规则', reason: '无分类的项目写入', sourceRefs: ['candidate-1'], evidenceRefs: ['evidence-1'] }],
  })
  recorder.recordDecision('closure-project-classification', { acceptedOperations: [], rejectedOperations: ['proposal-project'], archivedNodeIds: [], recallLinks: [] })
  recorder.complete('closure-project-classification', { projectContext: '# project', projectContextRevision: 1, context: '# session', contextRevision: 2, archivedNodeIds: [], recallLinks: [] })
  assert.ok(validateContextTrainingSample(recorder.get('closure-project-classification')!).includes('PROJECT_CLASSIFICATION_REQUIRED'))
})

test('RuntimeLoop emits directly trainable review and recall samples', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-training-closure-runtime-'))
  initializeProjectDirectory(projectDir)
  const llm: RuntimeLlm = {
    chat: async () => ({ provider: 'custom', model: 'test', text: '{"status":"completed","content":"ok"}', finishReason: 'stop', raw: {} }),
    getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }),
  }
  const loop = new RuntimeLoop({ projectDir, llm, stepDelayMs: 0, streamDelayMs: 0 })
  try {
    const observed = command('runtime.context.v2.observe', { observation: {
      candidate: { source: { actor: 'memory', sourceId: 'memory-closure', capturedAt: '2026-11-11T00:00:00.000Z' }, rawArtifactId: 'memory-closure', normalizedContent: '长期记忆：项目采用事件驱动架构' },
    } }, 'closure-observe')
    loop.validate(observed)
    loop.execute(observed, 1)
    const candidate = loop.exportState().contextDocument?.candidates.find((item) => item.source.sourceId === 'memory-closure')
    assert.ok(candidate)
    const review = command('runtime.context.v2.review', { review: {
      documentId: loop.exportState().contextDocument?.id ?? '', candidateId: candidate.id, baseRevision: loop.exportState().contextDocument?.revision ?? 0, status: 'rejected', reason: '当前任务无关',
    } }, 'closure-review')
    loop.validate(review)
    loop.execute(review, 2)
    const recall = command('runtime.context.v2.memory.recall', { query: '不存在的记忆', limit: 3 }, 'closure-recall')
    loop.validate(recall)
    loop.execute(recall, 3)
    const samples = loop.getContextTrainingSamples()
    const reviewSample = samples.find((sample) => sample.decision?.candidateReviews?.some((item) => item.candidateId === candidate.id))
    assert.ok(reviewSample)
    assert.deepEqual(validateContextTrainingSample(reviewSample!), [])
    assert.equal(toTrainableContextExample(reviewSample!).target.decision.candidateReviews?.[0]?.status, 'rejected')
    const recallSample = samples.find((sample) => sample.decision?.recalls?.some((item) => item.query === '不存在的记忆'))
    assert.ok(recallSample)
    assert.deepEqual(validateContextTrainingSample(recallSample!), [])
    assert.equal(toTrainableContextExample(recallSample!).target.decision.recalls?.[0]?.selectedIds.length, 0)
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('RuntimeLoop records an archive operation with lineage and evidence', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-training-archive-runtime-'))
  initializeProjectDirectory(projectDir)
  const loop = new RuntimeLoop({ projectDir, stepDelayMs: 0, streamDelayMs: 0 })
  try {
    const observed = command('runtime.context.v2.observe', { observation: {
      candidate: { source: { actor: 'tool', sourceId: 'archive-tool', capturedAt: '2026-11-11T00:00:00.000Z' }, rawArtifactId: 'archive-artifact', normalizedContent: '可归档的长期规则' },
      evidence: { kind: 'artifact', referenceId: 'archive-artifact', confidence: 'high' },
    } }, 'archive-observe')
    loop.validate(observed)
    loop.execute(observed, 1)
    let state = loop.exportState()
    const candidate = state.contextDocument?.candidates.find((item) => item.source.sourceId === 'archive-tool')
    const evidenceId = candidate?.evidenceRefs[0]
    assert.ok(candidate && evidenceId)
    const project = command('runtime.context.v2.project', { profileId: 'archive-add-runtime', maxCharacters: 4096 }, 'archive-project-add')
    loop.validate(project)
    loop.execute(project, 2)
    state = loop.exportState()
    const projectionTuple = state.contextDocumentProjections?.at(-1)
    const projection = projectionTuple?.[1]
    assert.ok(projection)
    const add = command('runtime.context.v2.apply', { proposal: {
      id: 'archive-add-runtime-proposal', documentId: state.contextDocument?.id ?? '', baseRevision: state.contextDocument?.revision ?? 0, projectionId: projectionTuple?.[0] ?? '', projectionHash: projection.contentHash,
      target: { section: 'information', headingPath: ['长期规则'] }, operation: 'add_entry', payload: { body: '可归档的长期规则', evidenceRefs: [evidenceId] }, candidateId: candidate.id, actor: 'model', idempotencyKey: 'archive-add-runtime', createdAt: '2026-11-11T00:00:01.000Z',
    } }, 'archive-add-apply')
    loop.validate(add)
    loop.execute(add, 3)
    state = loop.exportState()
    const entryId = state.contextDocument?.information[0]?.id
    assert.ok(entryId)
    const archiveProject = command('runtime.context.v2.project', { profileId: 'archive-mark-runtime', maxCharacters: 4096, includeStatuses: ['accepted'] }, 'archive-project-mark')
    loop.validate(archiveProject)
    loop.execute(archiveProject, 4)
    state = loop.exportState()
    const archiveProjectionTuple = state.contextDocumentProjections?.at(-1)
    const archiveProjection = archiveProjectionTuple?.[1]
    assert.ok(archiveProjection)
    const mark = command('runtime.context.v2.apply', { proposal: {
      id: 'archive-mark-runtime-proposal', documentId: state.contextDocument?.id ?? '', baseRevision: state.contextDocument?.revision ?? 0, projectionId: archiveProjectionTuple?.[0] ?? '', projectionHash: archiveProjection.contentHash,
      target: { section: 'information', entryId }, operation: 'mark_status', payload: { status: 'archived' }, candidateId: candidate.id, actor: 'memory', idempotencyKey: 'archive-mark-runtime', createdAt: '2026-11-11T00:00:02.000Z',
    } }, 'archive-mark-apply')
    loop.validate(mark)
    loop.execute(mark, 5)
    const sample = loop.getContextTrainingSamples().find((item) => item.decision?.archiveRecords?.some((record) => record.entryId === entryId))
    assert.ok(sample)
    assert.deepEqual(validateContextTrainingSample(sample!), [])
    assert.equal(toTrainableContextExample(sample!).target.decision.archiveRecords?.[0]?.evidenceRefs.includes(evidenceId), true)
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})
