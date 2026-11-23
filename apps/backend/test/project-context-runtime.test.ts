import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { initializeProjectDirectory } from '#core/project-initializer'
import { ContextCommitStore } from '#core/context-commit-store'
import { ContextDocumentEngine } from '#core/context-document-engine'
import { RuntimeLoop, type RuntimeLlm } from '#core/runtime-loop'
import type { ClientCommand, RuntimeContextDiffProposal, ServerEvent } from '#protocol/runtime-protocol'

function command<TType extends ClientCommand['type']>(
  type: TType,
  payload: Extract<ClientCommand, { type: TType }>['payload'],
  id: string,
  sessionId: string,
): ClientCommand {
  return {
    version: 1,
    kind: 'command',
    id,
    type,
    sessionId,
    timestamp: '2026-11-11T00:00:00.000Z',
    payload,
  } as ClientCommand
}

test('project promotion retains published structure addresses when its internal projection is narrower', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-project-tree-promotion-'))
  const sessionId = 'structural-promotion'
  initializeProjectDirectory(projectDir)
  const store = new ContextCommitStore(projectDir)
  const seed = ContextDocumentEngine.create({ sessionId: 'project-context', projectId: projectDir, constitutionRevision: 'test' })
  const document = seed.snapshot()
  const date = new Date().toISOString()
  document.information = Array.from({ length: 96 }, (_, index) => ({ id: `material-${index}`, sectionId: 'information', headingPath: ['项目发货资料'],
    body: `材料 ${index}。${'双人复核后才能提交。'.repeat(12)}`, status: 'active', evidenceRefs: [], sourceCandidateIds: [], supersedesEntryIds: [], revision: document.revision }))
  delete document.tree
  const wide = new ContextDocumentEngine(document).snapshot()
  const source = wide.tree!.headings[0]!
  const empty = Array.from({ length: 16 }, (_, index) => ({ id: `empty-${index}`, title: `复核章节 ${index} · ${'收集项目交接记录。'.repeat(12)}`, children: [] as string[] }))
  const destination = empty.at(-1)!
  wide.tree!.headings.push(...empty)
  wide.tree!.rootChildren.push(...empty.map(heading => heading.id))
  const projectEngine = new ContextDocumentEngine(wide)
  assert.ok(!projectEngine.project({ id: 'unbound-rebase', maxCharacters: 12_000, includeStructure: true, includeSections: ['information'] })
    .treeNodes!.some(node => node.id === destination.id))
  store.seedProject(new ContextDocumentEngine(wide).exportState())

  const loop = new RuntimeLoop({ projectDir, sessionId, stepDelayMs: 0, streamDelayMs: 0 })
  let sequence = 0
  const send = <T extends ClientCommand['type']>(type: T, payload: Extract<ClientCommand, { type: T }>['payload']) => {
    const request = { version: 1, kind: 'command', id: `structure-${++sequence}`, sessionId, timestamp: date, type, payload } as ClientCommand
    loop.validate(request); loop.execute(request, sequence)
  }
  try {
    send('runtime.context.v2.observe', { observation: { scope: 'session', candidate: {
      source: { actor: 'user', sourceId: 'project-layout', capturedAt: date }, rawArtifactId: 'project-layout', normalizedContent: '移动长期项目发货资料。',
      classification: { durability: 'project', target: 'project', confidence: 'high', reason: '项目长期目录', projectAnchors: ['project:file:main.j2'] },
    }, evidence: { kind: 'message', referenceId: 'project-layout' } } })
    const session = loop.exportState().contextDocument!
    const candidate = session.candidates.find(item => item.source.sourceId === 'project-layout')!
    const propose = (key: string) => {
      send('runtime.context.v2.project', { scope: 'project', profileId: key, includeStructure: true, includeTools: false, maxCharacters: 200_000 })
      const [projectionId, projection] = loop.exportState().projectContextDocumentProjections!.at(-1)!
      assert.ok(projection.treeNodes!.some(node => node.id === destination.id))
      const proposal: RuntimeContextDiffProposal = { id: key, idempotencyKey: key, scope: 'project', sourceScope: 'session',
        documentId: wide.id, baseRevision: projection.documentRevision, projectionId, projectionHash: projection.contentHash, diffVersion: 2,
        target: { section: 'information', nodeId: source.id }, targetNodeHash: projection.treeNodes!.find(node => node.id === source.id)!.hash,
        operation: 'move_node', payload: { parentNodeId: destination.id, evidenceRefs: candidate.evidenceRefs },
        candidateId: candidate.id, classification: candidate.classification, actor: 'model', createdAt: date }
      send('runtime.context.v2.apply', { proposal })
    }
    propose('move-project-layout')
    const committed = store.loadDocument()!
    assert.equal(committed.receipts.at(-1)![1].result, 'applied')
    assert.deepEqual(committed.document.tree!.headings.find(heading => heading.id === destination.id)!.children, [source.id])
    assert.ok(committed.document.candidates.some(item => item.id === candidate.id))
    assert.equal(committed.document.information.length, document.information.length)
    propose('repeat-project-layout')
    const repeated = store.loadDocument()!
    assert.deepEqual(repeated.document, committed.document)
    assert.equal(repeated.receipts.at(-1)![1].unchanged, true)
    assert.deepEqual(store.readOutcomes(sessionId).at(-1)?.receipt, repeated.receipts.at(-1)![1])
  } finally { loop.close(); store.close(); fs.rmSync(projectDir, { recursive: true, force: true }) }
})

test('project context survives a new RuntimeLoop and has a project projection', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-project-context-'))
  initializeProjectDirectory(projectDir)
  const first = new RuntimeLoop({ projectDir, stepDelayMs: 0, streamDelayMs: 0 })
  const firstEvents: ServerEvent[] = []
  const unsubscribe = first.onEvent((event) => firstEvents.push(event as ServerEvent))
  try {
    const observe = command('runtime.context.v2.observe', { observation: {
      scope: 'project',
      candidate: {
          source: { actor: 'user', sourceId: 'project-rule-1', capturedAt: '2026-11-11T00:00:01.000Z' },
          rawArtifactId: 'message:project-rule-1',
          normalizedContent: '项目采用事件驱动架构。',
          classification: { durability: 'project', target: 'project', confidence: 'high', reason: '用户明确声明项目架构规则', projectAnchors: ['project:explicit:project-rule-1'] },
        },
        evidence: {
          kind: 'message',
          referenceId: 'message:project-rule-1',
          observedAt: '2026-11-11T00:00:01.000Z',
          confidence: 'high',
        },
      },
    }, 'project-observe', 'session-1')
    first.validate(observe)
    first.execute(observe, 1)

    const beforeProjection = first.exportState()
    assert.equal(beforeProjection.projectContextDocument?.candidates.length, 1)
    const projectDocumentId = beforeProjection.projectContextDocument?.id ?? ''
    assert.ok(projectDocumentId)
    assert.equal(beforeProjection.snapshot.contextScopes?.project.documentId, projectDocumentId)

    const projection = command('runtime.context.v2.project', {
      scope: 'project',
      profileId: 'project-test',
      maxCharacters: 4096,
      includeTools: false,
    }, 'project-projection', 'session-1')
    first.validate(projection)
    first.execute(projection, 2)
    const projectionEvent = [...firstEvents].reverse().find((event) => event.type === 'runtime.context.v2.projection.created') as Extract<ServerEvent, { type: 'runtime.context.v2.projection.created' }> | undefined
    assert.ok(projectionEvent)
    assert.equal(projectionEvent.payload.projection.scope, 'project')
    const snapshot = first.getSnapshot(0)
    assert.ok(snapshot.projectContextDocumentView)
    assert.deepEqual(snapshot.projectContextDocumentView.list[0], '# project_context')
    assert.equal(Array.isArray(snapshot.projectContextDocumentView.list), true)
    assert.deepEqual(snapshot.contextOrganization?.variables.map((item) => item.name), [
      'project_context', 'session_context', 'cache', 'messages', 'system_prompt', 'runtime_state',
    ])
    assert.equal(snapshot.contextOrganization?.projectRevision, snapshot.projectContextDocument?.revision)
    assert.equal(snapshot.contextOrganization?.sessionRevision, snapshot.contextDocument?.revision)

    const restarted = new RuntimeLoop({ projectDir, stepDelayMs: 0, streamDelayMs: 0 })
    try {
      const restored = restarted.exportState()
      assert.equal(restored.projectContextDocument?.id, projectDocumentId)
      assert.equal(restored.projectContextDocument?.candidates.length, 1)
      assert.equal(restored.snapshot.contextScopes?.project.documentId, projectDocumentId)
      assert.equal(restored.snapshot.contextScopes?.project.revision, restored.projectContextDocument?.revision)
    } finally {
      restarted.close()
    }
  } finally {
    unsubscribe()
    first.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('frozen project context is restored for evaluation and rejects project writes', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-project-context-frozen-'))
  initializeProjectDirectory(projectDir)
  const frozen = ContextDocumentEngine.create({ sessionId: 'frozen-project-context', projectId: projectDir, constitutionRevision: 'test' })
  frozen.observe({
    candidate: {
      source: { actor: 'memory', sourceId: 'frozen-rule', capturedAt: '2026-11-20T00:00:00.000Z' },
      rawArtifactId: 'frozen-rule',
      normalizedContent: '评估期间项目上下文只读。',
      classification: { durability: 'project', target: 'project', confidence: 'high', reason: '冻结快照规则', projectAnchors: ['project:file:main.j2'] },
    },
    evidence: { kind: 'artifact', referenceId: 'frozen-rule', confidence: 'high' },
  })
  const sessionId = 'frozen-project-session'
  const loop = new RuntimeLoop({
    projectDir,
    sessionId,
    initialProjectContext: frozen.exportState(),
    projectContextReadOnly: true,
    stepDelayMs: 0,
    streamDelayMs: 0,
  })
  try {
    const restored = loop.exportState()
    assert.equal(restored.projectContextDocument?.id, frozen.snapshot().id)
    assert.equal(restored.projectContextDocument?.revision, frozen.snapshot().revision)
    assert.ok(restored.projectContextDocument?.candidates.some((candidate) => candidate.source.sourceId === 'frozen-rule'))

    const projectObservation = command('runtime.context.v2.observe', { observation: {
      scope: 'project',
      candidate: {
        source: { actor: 'user', sourceId: 'forbidden-project-write', capturedAt: '2026-11-20T00:00:01.000Z' },
        rawArtifactId: 'forbidden-project-write',
        normalizedContent: '不应写入冻结项目上下文。',
        classification: { durability: 'project', target: 'project', confidence: 'high', reason: '只读门禁测试', projectAnchors: ['project:file:main.j2'] },
      },
      evidence: { kind: 'message', referenceId: 'forbidden-project-write', confidence: 'high' },
    } }, 'frozen-project-observe', sessionId)
    loop.validate(projectObservation)
    assert.throws(() => loop.execute(projectObservation, 1), /PROJECT_CONTEXT_READONLY/u)
    assert.equal(loop.exportState().projectContextDocument?.candidates.some((candidate) => candidate.source.sourceId === 'forbidden-project-write'), false)

    const sessionObservation = command('runtime.context.v2.observe', { observation: {
      scope: 'session',
      candidate: {
        source: { actor: 'user', sourceId: 'allowed-session-write', capturedAt: '2026-11-20T00:00:02.000Z' },
        rawArtifactId: 'allowed-session-write',
        normalizedContent: '会话级信息仍可写入。',
        classification: { durability: 'session', target: 'session', confidence: 'high', reason: '当前任务信息', projectAnchors: [] },
      },
      evidence: { kind: 'message', referenceId: 'allowed-session-write', confidence: 'high' },
    } }, 'frozen-session-observe', sessionId)
    loop.validate(sessionObservation)
    loop.execute(sessionObservation, 2)
    assert.ok(loop.exportState().contextDocument?.candidates.some((candidate) => candidate.source.sourceId === 'allowed-session-write'))
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('project context rejects observations without durable project classification', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-project-classification-gate-'))
  initializeProjectDirectory(projectDir)
  const loop = new RuntimeLoop({ projectDir, stepDelayMs: 0, streamDelayMs: 0 })
  try {
    const missingClassification = command('runtime.context.v2.observe', { observation: {
      scope: 'project',
      candidate: {
        source: { actor: 'tool', sourceId: 'session-order-1024', capturedAt: '2026-11-16T00:00:00.000Z' },
        rawArtifactId: 'order-1024',
        normalizedContent: '订单 1024 的退款状态为 pending。',
      },
      evidence: { kind: 'artifact', referenceId: 'order-1024', confidence: 'high' },
    } }, 'project-missing-classification', 'classification-session')
    loop.validate(missingClassification)
    assert.throws(() => loop.execute(missingClassification, 1), /PROJECT_CLASSIFICATION_REQUIRED/u)
    assert.equal(loop.exportState().projectContextDocument?.candidates.length, 0)

    const sessionClassification = command('runtime.context.v2.observe', { observation: {
      scope: 'project',
      candidate: {
        source: { actor: 'tool', sourceId: 'session-only-result', capturedAt: '2026-11-16T00:00:01.000Z' },
        rawArtifactId: 'session-only-result',
        normalizedContent: '当前任务的临时工具结果。',
        classification: { durability: 'session', target: 'session', confidence: 'high', reason: '只对当前任务有效', projectAnchors: [] },
      },
      evidence: { kind: 'artifact', referenceId: 'session-only-result', confidence: 'high' },
    } }, 'project-session-classification', 'classification-session')
    loop.validate(sessionClassification)
    assert.throws(() => loop.execute(sessionClassification, 2), /PROJECT_RELEVANCE_REQUIRED/u)
    assert.equal(loop.exportState().projectContextDocument?.candidates.length, 0)

    const missingAnchor = command('runtime.context.v2.observe', { observation: {
      scope: 'project',
      candidate: {
        source: { actor: 'tool', sourceId: 'missing-project-file', capturedAt: '2026-11-16T00:00:02.000Z' },
        rawArtifactId: 'missing-project-file',
        normalizedContent: '不存在的项目文件规则。',
        classification: { durability: 'project', target: 'project', confidence: 'high', reason: '项目文件规则', projectAnchors: ['project:file:missing-project-file.md'] },
      },
      evidence: { kind: 'artifact', referenceId: 'missing-project-file', confidence: 'high' },
    } }, 'project-missing-anchor', 'classification-session')
    loop.validate(missingAnchor)
    assert.throws(() => loop.execute(missingAnchor, 3), /PROJECT_ANCHOR_NOT_FOUND/u)
    assert.equal(loop.exportState().projectContextDocument?.candidates.length, 0)
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('session candidate with a valid project classification is promoted before project diff application', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-session-project-promotion-'))
  initializeProjectDirectory(projectDir)
  const loop = new RuntimeLoop({ projectDir, stepDelayMs: 0, streamDelayMs: 0 })
  try {
    const observe = command('runtime.context.v2.observe', { observation: {
      scope: 'session',
      candidate: {
        source: { actor: 'user', sourceId: 'session-project-rule', capturedAt: '2026-11-16T00:00:00.000Z' },
        rawArtifactId: 'session-project-rule',
        normalizedContent: '项目规则来自当前 Session 的明确声明。',
        classification: { durability: 'project', target: 'project', confidence: 'high', reason: '用户明确声明跨 Session 有效', projectAnchors: ['project:file:main.j2'] },
      },
      evidence: { kind: 'message', referenceId: 'session-project-rule', confidence: 'high' },
    } }, 'session-promotion-observe', 'promotion-session')
    loop.validate(observe)
    loop.execute(observe, 1)
    let state = loop.exportState()
    const sessionCandidate = state.contextDocument?.candidates.find((candidate) => candidate.source.sourceId === 'session-project-rule')
    assert.ok(sessionCandidate)
    const project = command('runtime.context.v2.project', { scope: 'project', profileId: 'promotion-source', maxCharacters: 4096, includeTools: false }, 'promotion-project', 'promotion-session')
    loop.validate(project)
    loop.execute(project, 2)
    state = loop.exportState()
    const projectionTuple = state.projectContextDocumentProjections?.at(-1)
    assert.ok(projectionTuple)
    const apply = command('runtime.context.v2.apply', { proposal: {
      id: 'session-project-promotion', scope: 'project', sourceScope: 'session', documentId: state.projectContextDocument?.id ?? '',
      baseRevision: state.projectContextDocument?.revision ?? 0, projectionId: projectionTuple?.[0] ?? '', projectionHash: projectionTuple?.[1].contentHash,
      target: { section: 'information', headingPath: ['Session 晋升规则'] }, operation: 'add_entry',
      payload: { body: '项目规则来自当前 Session 的明确声明。', evidenceRefs: [sessionCandidate.evidenceRefs[0] as string] }, candidateId: sessionCandidate.id,
      classification: sessionCandidate.classification, actor: 'model', idempotencyKey: 'session-project-promotion', createdAt: '2026-11-16T00:00:01.000Z',
    } }, 'session-project-promotion-apply', 'promotion-session')
    loop.validate(apply)
    loop.execute(apply, 3)
    state = loop.exportState()
    assert.ok(state.projectContextDocument?.candidates.some((candidate) => candidate.id === sessionCandidate.id))
    assert.ok(state.projectContextDocument?.information.some((entry) => entry.body.includes('项目规则来自当前 Session')))
    assert.equal(state.contextDocument?.candidates.some((candidate) => candidate.id === sessionCandidate.id), true)
    assert.equal(state.projectContextDocumentReceipts?.at(-1)?.[1].result, 'applied')
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('project proposal gate rejects a session classification before semantic diff application', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-project-proposal-gate-'))
  initializeProjectDirectory(projectDir)
  const loop = new RuntimeLoop({ projectDir, stepDelayMs: 0, streamDelayMs: 0 })
  try {
    const observe = command('runtime.context.v2.observe', { observation: {
      scope: 'project',
      candidate: {
        source: { actor: 'user', sourceId: 'durable-rule', capturedAt: '2026-11-16T00:00:00.000Z' },
        rawArtifactId: 'durable-rule',
        normalizedContent: '项目所有写入必须经过 RuntimeLoop。',
        classification: { durability: 'project', target: 'project', confidence: 'high', reason: '项目级规则', projectAnchors: ['project:explicit:durable-rule'] },
      },
      evidence: { kind: 'message', referenceId: 'durable-rule', confidence: 'high' },
    } }, 'project-gate-observe', 'project-gate-session')
    loop.validate(observe)
    loop.execute(observe, 1)
    const stateBeforeProjection = loop.exportState()
    const candidate = stateBeforeProjection.projectContextDocument?.candidates[0]
    assert.ok(candidate)
    const project = command('runtime.context.v2.project', { scope: 'project', profileId: 'proposal-gate', maxCharacters: 4096, includeTools: false }, 'project-gate-projection', 'project-gate-session')
    loop.validate(project)
    loop.execute(project, 2)
    const state = loop.exportState()
    const projectionTuple = state.projectContextDocumentProjections?.at(-1)
    assert.ok(projectionTuple)
    const proposal = command('runtime.context.v2.apply', { proposal: {
      id: 'project-gate-proposal', scope: 'project', documentId: state.projectContextDocument?.id ?? '', baseRevision: state.projectContextDocument?.revision ?? 0,
      projectionId: projectionTuple?.[0] ?? '', projectionHash: projectionTuple?.[1].contentHash,
      target: { section: 'information', headingPath: ['无效晋升'] }, operation: 'add_entry', payload: { body: '不应写入项目上下文。', evidenceRefs: [candidate.evidenceRefs[0] as string] }, candidateId: candidate.id,
      classification: { durability: 'session', target: 'session', confidence: 'high', reason: '当前任务信息', projectAnchors: [] }, actor: 'model', idempotencyKey: 'project-gate-proposal', createdAt: '2026-11-16T00:00:01.000Z',
    } }, 'project-gate-apply', 'project-gate-session')
    loop.validate(proposal)
    loop.execute(proposal, 3)
    const rejected = loop.exportState().projectContextDocumentReceipts?.at(-1)?.[1]
    assert.equal(rejected?.result, 'rejected')
    assert.equal(rejected?.errorCode, 'PROJECT_CLASSIFICATION_MISMATCH')
    assert.equal(loop.exportState().projectContextDocument?.information.length, 0)
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('legacy compatibility: the model projection includes persisted project context', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-project-context-model-'))
  initializeProjectDirectory(projectDir)
  const requests: Parameters<RuntimeLlm['chat']>[0][] = []
  const llm: RuntimeLlm = {
    chat: async (request) => {
      requests.push(request)
      const system = request.messages.find((message) => message.role === 'system')?.content ?? ''
      if (system.includes('system context organization stage')) {
        const user = request.messages.find((message) => message.role === 'user')?.content ?? '{}'
        const input = JSON.parse(user) as { project?: { documentId: string; revision: number; projectionId: string; projectionHash: string; markdown: string } }
        const candidateId = input.project?.markdown.match(/^## (candidate-[^\s]+)/mu)?.[1]
        const proposal = input.project
          ? {
              scope: 'project',
              documentId: input.project.documentId,
              baseRevision: input.project.revision,
              projectionId: input.project.projectionId,
              projectionHash: input.project.projectionHash,
              sourceObservationId: 'hook-cache-observation-1',
              operation: 'add_entry',
              headingPath: ['自动整理规则'],
              body: '项目规则已通过系统上下文整理 Hook 提出。',
              classification: { durability: 'project', target: 'project', confidence: 'high', reason: '缓存中包含项目级写入规则', projectAnchors: ['project:explicit:cache-hook-1'] },
              idempotencyKey: 'project-hook-proposal-1',
            }
          : undefined
        return {
          provider: 'custom',
          model: 'test',
          text: JSON.stringify({
            contextObservations: [{
              id: 'hook-cache-observation-1',
              scope: 'project',
              source: { actor: 'tool', sourceId: 'cache-hook-1', capturedAt: '2026-11-11T00:00:03.000Z' },
              rawArtifactId: 'artifact:cache-hook-1',
              normalizedContent: '缓存提取出的项目级外部写入规则。',
              classification: { durability: 'project', target: 'project', confidence: 'high', reason: '缓存结果明确描述项目长期规则', projectAnchors: ['project:explicit:cache-hook-1'] },
              evidence: { kind: 'artifact', referenceId: 'artifact:cache-hook-1', observedAt: '2026-11-11T00:00:03.000Z', confidence: 'high' },
            }],
            contextProposals: proposal ? [proposal] : [],
          }),
          finishReason: 'stop',
          raw: {},
        }
      }
      return { provider: 'custom', model: 'test', text: '{"status":"completed","content":"ok"}', finishReason: 'stop', raw: {} }
    },
    getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }),
  }
  const loop = new RuntimeLoop({ projectDir, llm, contextOrganization: { enabled: false }, stepDelayMs: 0, streamDelayMs: 0 })
  try {
    const observe = command('runtime.context.v2.observe', { observation: {
      scope: 'project',
      candidate: {
          source: { actor: 'user', sourceId: 'project-model-rule', capturedAt: '2026-11-11T00:00:02.000Z' },
          rawArtifactId: 'message:project-model-rule',
          normalizedContent: '项目规范：所有外部写入必须经过 RuntimeLoop。',
          classification: { durability: 'project', target: 'project', confidence: 'high', reason: '用户明确声明项目写入规范', projectAnchors: ['project:explicit:project-model-rule'] },
        },
        evidence: {
          kind: 'message',
          referenceId: 'message:project-model-rule',
          observedAt: '2026-11-11T00:00:02.000Z',
          confidence: 'high',
        },
      },
    }, 'project-model-observe', 'session-2')
    loop.validate(observe)
    loop.execute(observe, 1)

    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('project context model run timed out')), 5000)
      const unsubscribe = loop.onEvent((event) => {
        if (event.type !== 'run.state.changed') return
        if (event.payload.status === 'failed') {
          clearTimeout(timer)
          unsubscribe()
          reject(new Error(event.payload.failure?.message ?? 'project context model run failed'))
        } else if (event.payload.status === 'completed') {
          clearTimeout(timer)
          unsubscribe()
          resolve()
        }
      })
    })
    const send = command('chat.message.send', {
      clientMessageId: 'project-context-model-message',
      content: [{ type: 'text', text: '请说明项目写入规范。' }],
      autoStart: true,
    }, 'project-model-message', 'session-2')
    loop.validate(send)
    loop.execute(send, 2)
    await completed

    const system = requests
      .map((request) => request.messages.find((message) => message.role === 'system')?.content ?? '')
      .find((content) => content.includes('capybara:project-projection')) ?? ''
    assert.match(system, /项目规范：所有外部写入必须经过 RuntimeLoop/u)
    assert.match(system, /capybara:project-projection/u)
    assert.ok(loop.exportState().projectContextDocument?.candidates.some((candidate) => candidate.source.sourceId === 'cache-hook-1'))
    const organizedEntry = loop.exportState().projectContextDocument?.information.find((entry) => entry.body.includes('系统上下文整理 Hook'))
    assert.ok(organizedEntry)
    assert.equal(organizedEntry?.classification?.target, 'project')
    assert.deepEqual(organizedEntry?.classification?.projectAnchors, ['project:explicit:cache-hook-1'])
    assert.ok(loop.getContextTrainingSamples().some((sample) => sample.proposal && sample.output))
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})
