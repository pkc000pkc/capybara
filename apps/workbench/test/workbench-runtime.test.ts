import assert from 'node:assert/strict'
import test from 'node:test'

import { chatTextFromEvent, createChatFrame, parseRuntimeEvent, pendingBranchQuestions, transcriptFromSnapshot, transcriptMessageFromEvent } from '../src/app/workbench-runtime'

test('chat frame matches backend runtime command protocol without a project path', () => {
  const frame = createChatFrame('session-1', '整理资料', {
    commandId: 'command-1',
    clientMessageId: 'message-1',
    timestamp: '2026-11-07T00:00:00.000Z',
  })
  assert.deepEqual(frame, {
    version: 1,
    kind: 'command',
    id: 'command-1',
    type: 'chat.message.send',
    sessionId: 'session-1',
    timestamp: '2026-11-07T00:00:00.000Z',
    payload: { clientMessageId: 'message-1', content: [{ type: 'text', text: '整理资料' }], autoStart: true },
  })
  assert.equal('projectPath' in frame, false)
})

test('runtime event parser exposes assistant deltas without trusting arbitrary payloads', () => {
  const event = parseRuntimeEvent(JSON.stringify({ type: 'chat.assistant.delta', payload: { channel: 'final', delta: '已收到' } }))
  assert.equal(chatTextFromEvent(event), '已收到')
  assert.throws(() => parseRuntimeEvent('{}'), /event type is required/)
})

test('the composer pairs a selected branch question with its exact runtime reply ID', () => {
  const [question, evidence] = pendingBranchQuestions({
    taskId: 'root', goal: '补证据', stateRevision: 2, planRevision: 1, requiredActions: [], requiredEvidenceRefs: [], uncertainties: [],
    tasks: [{ id: 'inputs', title: '核对输入', owner: 'parent', capabilityIds: [], dependsOn: [], completionConditions: ['读到输入'],
      requiredActions: [], evidenceRefs: [], status: 'pending' }],
    branchBlocks: [
      { id: 'wait-1', kind: 'wait', taskIds: ['other'], reason: '等待子任务' },
      { id: 'human-1', kind: 'human', taskIds: ['inputs'], reason: '请确认来源' },
      { id: 'evidence-1', kind: 'evidence', taskIds: ['inputs'], reason: '请提供依据',
        evidenceRequest: { id: 'proof', question: '请提供依据', sourceKinds: ['user'] } },
      { id: 'evidence-2', kind: 'evidence', taskIds: ['inputs'], reason: '等待来源服务',
        evidenceRequest: { id: 'remote-proof', question: '等待来源服务', sourceKinds: ['external'] } },
    ],
  })
  assert.deepEqual(question, { id: 'human-1', question: '请确认来源', taskLabels: '核对输入' })
  const frame = createChatFrame('session-1', '来源已确认', { commandId: 'reply', clientMessageId: 'm1', humanRequestId: question!.id })
  assert.equal(frame.payload.humanRequestId, 'human-1')
  assert.deepEqual(evidence, { id: 'evidence-1', question: '请提供依据', taskLabels: '核对输入' })
})

test('runtime snapshot becomes a durable user-facing transcript', () => {
  const event = parseRuntimeEvent(JSON.stringify({
    type: 'runtime.snapshot',
    payload: {
      conversation: {
        messages: [
          { id: 'u-1', role: 'user', status: 'completed', createdAt: '2026-11-09T12:00:00.000Z', content: [{ type: 'text', text: '创建说明' }] },
          { id: 'a-1', role: 'assistant', status: 'failed', createdAt: '2026-11-09T12:00:01.000Z', content: [], failure: { message: '工具失败' } },
        ],
      },
    },
  }))
  assert.deepEqual(transcriptFromSnapshot(event).map(({ id, role, body, status }) => ({ id, role, body, status })), [
    { id: 'u-1', role: 'user', body: '创建说明', status: 'completed' },
    { id: 'a-1', role: 'agent', body: '工具失败', status: 'failed' },
  ])
  const failed = parseRuntimeEvent(JSON.stringify({ type: 'chat.assistant.failed', payload: { messageId: 'a-2', message: '再次失败' } }))
  assert.equal(transcriptMessageFromEvent(failed)?.body, '再次失败')
})
