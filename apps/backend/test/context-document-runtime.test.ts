import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { initializeProjectDirectory } from '#core/project-initializer'
import { RuntimeLoop, type RuntimeLlm } from '#core/runtime-loop'
import type { ClientCommand, RuntimeRequestBinding, ServerEvent } from '#protocol/runtime-protocol'

const llm: RuntimeLlm = {
  chat: async () => ({ provider: 'custom', model: 'test', text: '{"status":"completed","content":"ok"}', finishReason: 'stop', raw: {} }),
  getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }),
}

function command<TType extends ClientCommand['type']>(type: TType, payload: Extract<ClientCommand, { type: TType }>['payload']): ClientCommand {
  return { version: 1, kind: 'command', id: `v2-${type}`, type, sessionId: 'v2-session', timestamp: '2026-11-04T00:00:00.000Z', payload } as ClientCommand
}

function requestBinding(system: string): RuntimeRequestBinding {
  const line = system.split('\n').find(value => value.startsWith('{"sessionId":'))
  assert.ok(line, 'missing structured request binding')
  return JSON.parse(line) as RuntimeRequestBinding
}

test('RuntimeLoop publishes a bound V2 projection and restores its document state', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-v2-runtime-'))
  initializeProjectDirectory(projectDir)
  const loop = new RuntimeLoop({ projectDir, llm, stepDelayMs: 0, streamDelayMs: 0 })
  const events: ServerEvent[] = []
  const unsubscribe = loop.onEvent((event) => events.push(event as ServerEvent))
  try {
    const project = command('runtime.context.v2.project', { profileId: 'runtime-test', maxCharacters: 4096, includeTools: true })
    loop.validate(project)
    loop.execute(project, 1)
    const event = events.find((item) => item.type === 'runtime.context.v2.projection.created') as Extract<ServerEvent, { type: 'runtime.context.v2.projection.created' }> | undefined
    assert.ok(event)
    assert.equal(event.payload.projection.profileId, 'runtime-test')
    assert.equal(event.payload.projection.contentHash.length, 64)
    const documentId = loop.exportState().contextDocument?.id ?? ''
    const observed = command('runtime.context.v2.observe', {
      observation: {
        documentId,
        candidate: {
          source: { actor: 'user', sourceId: 'user-evidence-1', capturedAt: '2026-11-04T00:00:01.000Z' },
          rawArtifactId: 'message:user-evidence-1',
          normalizedContent: '用户提供的可核验事实',
        },
        evidence: { kind: 'message', referenceId: 'message:user-evidence-1', observedAt: '2026-11-04T00:00:01.000Z', confidence: 'high' },
      },
    })
    loop.validate(observed)
    loop.execute(observed, 2)
    const observedEvent = events.find((item) => item.type === 'runtime.context.v2.observed') as Extract<ServerEvent, { type: 'runtime.context.v2.observed' }> | undefined
    assert.equal(observedEvent?.payload.candidate.actor, 'user')
    assert.equal(observedEvent?.payload.candidate.sourceId, 'user-evidence-1')
    assert.equal(observedEvent?.payload.candidate.capturedAt, '2026-11-04T00:00:01.000Z')
    assert.equal(observedEvent?.payload.evidence?.kind, 'message')
    assert.equal(loop.exportState().snapshot.contextCandidates?.some((candidate) => candidate.id === observedEvent?.payload.candidate.id), true)
    const recall = command('runtime.context.v2.memory.recall', { query: 'memory', limit: 5 })
    loop.validate(recall)
    loop.execute(recall, 3)
    const recallEvent = events.find((item) => item.type === 'runtime.context.v2.memory.recalled') as Extract<ServerEvent, { type: 'runtime.context.v2.memory.recalled' }> | undefined
    assert.ok(recallEvent)
    assert.deepEqual(recallEvent.payload.candidates, [])
    const childMerge = command('runtime.context.v2.child.merge', {
      documentId: loop.exportState().contextDocument?.id ?? '',
      sourceId: 'child-source',
      runId: 'child-run',
      stepId: 'child-step',
      rawArtifactId: 'child-artifact',
      normalizedContent: '子代理结果',
      evidenceRefs: [],
    })
    loop.validate(childMerge)
    loop.execute(childMerge, 4)
    const childEvent = events.find((item) => item.type === 'runtime.context.v2.child.merged') as Extract<ServerEvent, { type: 'runtime.context.v2.child.merged' }> | undefined
    assert.equal(childEvent?.payload.candidate.actor, 'child-agent')
    const evidenceReview = command('runtime.context.v2.evidence.review', {
      review: {
        documentId: loop.exportState().contextDocument?.id ?? '',
        candidateId: childEvent?.payload.candidate.id ?? '',
        baseRevision: loop.exportState().contextDocument?.revision ?? 0,
        decision: 'needs_more_evidence',
        rationale: '等待父代理补充证据',
      },
    })
    loop.validate(evidenceReview)
    loop.execute(evidenceReview, 5)
    const evidenceEvent = events.find((item) => item.type === 'runtime.context.v2.evidence.reviewed') as Extract<ServerEvent, { type: 'runtime.context.v2.evidence.reviewed' }> | undefined
    assert.equal(evidenceEvent?.payload.result.decision, 'needs_more_evidence')
    const dream = command('runtime.context.v2.dream', {})
    loop.validate(dream)
    loop.execute(dream, 6)
    const dreamEvent = events.find((item) => item.type === 'runtime.context.v2.dream.created') as Extract<ServerEvent, { type: 'runtime.context.v2.dream.created' }> | undefined
    assert.ok(dreamEvent)
    assert.equal(dreamEvent.payload.plan.documentRevision, loop.exportState().contextDocument?.revision)
    const state = loop.exportState()
    const restored = new RuntimeLoop({ projectDir, llm, stepDelayMs: 0, streamDelayMs: 0, initialState: state })
    try {
      assert.equal(restored.exportState().contextDocument?.id, state.contextDocument?.id)
      assert.equal(restored.exportState().contextDocumentProjections?.length, state.contextDocumentProjections?.length)
      assert.equal(restored.getSnapshot(0).contextEvidenceReviews?.length, state.snapshot.contextEvidenceReviews?.length)
    } finally {
      restored.close()
    }
  } finally {
    unsubscribe()
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('RuntimeLoop dispatches a structured envelope tool action through the normal tool round', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-v2-envelope-tool-'))
  initializeProjectDirectory(projectDir)
  let modelCalls = 0
  const envelopeLlm: RuntimeLlm = {
    chat: async (request) => {
      modelCalls += 1
      const system = request.messages.find((message) => message.role === 'system')?.content ?? ''
      const { requestId, sessionId, runId } = requestBinding(system)
      assert.ok(requestId)
      assert.ok(sessionId)
      assert.ok(runId)
      if (modelCalls === 1) {
        return {
          provider: 'custom', model: 'test', finishReason: 'stop', raw: {},
          text: JSON.stringify({
            status: 'running', content: '正在搜索工具', envelope: {
              envelopeVersion: 1, sessionId, runId, requestId, decision: 'tool_call',
              actions: [{ kind: 'tool_call', toolName: 'search_resources', arguments: { query: 'files', kinds: ['tool'], limit: 1 } }],
              candidateDiffs: [], evidenceRequests: [], uncertainties: [],
            },
          }),
        }
      }
      return {
        provider: 'custom', model: 'test', finishReason: 'stop', raw: {},
        text: JSON.stringify({
          status: 'completed', content: '完成', envelope: {
            envelopeVersion: 1, sessionId, runId, requestId, decision: 'finish', actions: [],
            candidateDiffs: [], evidenceRequests: [], uncertainties: [],
            completionCheck: { requiredEvidenceRefs: [], requiredActions: [], unresolvedUncertainties: [], verified: true },
          },
        }),
      }
    },
    getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }),
  }
  const loop = new RuntimeLoop({ projectDir, llm: envelopeLlm, stepDelayMs: 0, streamDelayMs: 0 })
  try {
    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('structured envelope run timed out')), 5000)
      const unsubscribe = loop.onEvent((event) => {
        if (event.type !== 'run.state.changed') return
        if (event.payload.status === 'failed') {
          clearTimeout(timer)
          unsubscribe()
          reject(new Error(event.payload.failure?.message ?? 'structured envelope run failed'))
        } else if (event.payload.status === 'completed') {
          clearTimeout(timer)
          unsubscribe()
          resolve()
        }
      })
    })
    const send = command('chat.message.send', { clientMessageId: 'envelope-tool-message', content: [{ type: 'text', text: '查找文件工具' }], autoStart: true })
    loop.validate(send)
    loop.execute(send, 1)
    await completed
    assert.equal(modelCalls, 2)
    assert.ok(loop.getSnapshot(0).observations.items.some((observation) => observation.toolName === 'search_resources' && observation.status === 'completed'))
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('RuntimeLoop applies a propose_diff envelope through the governed V2 path', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-v2-envelope-diff-'))
  initializeProjectDirectory(projectDir)
  const loop = new RuntimeLoop({ projectDir, llm, stepDelayMs: 0, streamDelayMs: 0 })
  const events: ServerEvent[] = []
  const unsubscribe = loop.onEvent((event) => events.push(event as ServerEvent))
  try {
    const documentId = loop.exportState().contextDocument?.id ?? ''
    const observed = command('runtime.context.v2.observe', {
      observation: {
        documentId,
        candidate: {
          source: { actor: 'user', sourceId: 'envelope-user-1', capturedAt: '2026-11-04T00:00:02.000Z' },
          rawArtifactId: 'message:envelope-user-1', normalizedContent: '请核验这个事实',
        },
        evidence: { kind: 'message', referenceId: 'message:envelope-user-1', observedAt: '2026-11-04T00:00:02.000Z', confidence: 'high' },
      },
    })
    loop.validate(observed)
    loop.execute(observed, 1)
    const project = command('runtime.context.v2.project', { profileId: 'envelope-diff', maxCharacters: 4096 })
    loop.validate(project)
    loop.execute(project, 2)
    const projectionEvent = [...events].reverse().find((event) => event.type === 'runtime.context.v2.projection.created') as Extract<ServerEvent, { type: 'runtime.context.v2.projection.created' }>
    const observedEvent = events.find((event) => event.type === 'runtime.context.v2.observed') as Extract<ServerEvent, { type: 'runtime.context.v2.observed' }>
    const envelope = {
      envelopeVersion: 1 as const,
      sessionId: 'v2-session',
      runId: 'run-envelope-diff',
      requestId: 'request-envelope-diff',
      decision: 'propose_diff' as const,
      actions: [],
      candidateDiffs: [{
        baseRevision: projectionEvent.payload.projection.documentRevision,
        projectionId: projectionEvent.payload.projection.id,
        projectionHash: projectionEvent.payload.projection.contentHash,
        candidateId: observedEvent.payload.candidate.id,
        operation: 'add_entry' as const,
        body: '模型提出的已核验事实',
        evidenceRefs: [observedEvent.payload.evidence?.id ?? ''],
        idempotencyKey: 'envelope-diff-1',
      }],
      evidenceRequests: [], uncertainties: [],
    }
    ;(loop as unknown as { applyV2EnvelopeDiffs: (value: typeof envelope, correlationId: string) => void }).applyV2EnvelopeDiffs(envelope, 'test-envelope-diff')
    assert.ok(loop.exportState().contextDocument?.information.some((entry) => entry.body === '模型提出的已核验事实'))
    assert.ok(events.some((event) => event.type === 'runtime.context.v2.receipt.created' && event.payload.receipt.result === 'applied'))
  } finally {
    unsubscribe()
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('RuntimeLoop finish gate rejects uncompleted required actions', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-v2-finish-gate-'))
  initializeProjectDirectory(projectDir)
  const gateLlm: RuntimeLlm = {
    chat: async (request) => {
      const system = request.messages.find((message) => message.role === 'system')?.content ?? ''
      const { requestId, sessionId, runId } = requestBinding(system)
      return {
        provider: 'custom', model: 'test', finishReason: 'stop', raw: {},
        text: JSON.stringify({
          status: 'completed', content: '完成', envelope: {
            envelopeVersion: 1, sessionId, runId, requestId, decision: 'finish', actions: [],
            candidateDiffs: [], evidenceRequests: [], uncertainties: [],
            completionCheck: { requiredEvidenceRefs: [], requiredActions: ['tool:search_resources'], unresolvedUncertainties: [], verified: true },
          },
        }),
      }
    },
    getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }),
  }
  const loop = new RuntimeLoop({ projectDir, llm: gateLlm, stepDelayMs: 0, streamDelayMs: 0 })
  try {
    const failed = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('finish gate run timed out')), 5000)
      const unsubscribe = loop.onEvent((event) => {
        if (event.type !== 'run.state.changed') return
        if (event.payload.status === 'failed') {
          clearTimeout(timer)
          unsubscribe()
          resolve(event.payload.failure?.code ?? '')
        }
      })
    })
    const send = command('chat.message.send', { clientMessageId: 'finish-gate-message', content: [{ type: 'text', text: '执行搜索并完成' }], autoStart: true })
    loop.validate(send)
    loop.execute(send, 1)
    assert.equal(await failed, 'RUNTIME_ENVELOPE_ACTIONS_INCOMPLETE')
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})
