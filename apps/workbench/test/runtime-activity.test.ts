import assert from 'node:assert/strict'
import test from 'node:test'
import { activityRows, type TraceEvent } from '../src/app/runtime-activity'
import { chatTextFromEvent, shouldHandleRuntimeClosed, transcriptMessageFromEvent } from '../src/app/workbench-runtime'

const event = (type: string, payload: unknown, stepId = 'model:1'): TraceEvent => ({ id: crypto.randomUUID(), type, payload, turnId: 'turn:1', stepId })

test('the same trace projects model progress, tool arguments, failure and evidence without duplicate tool rows', () => {
  const trace = [
    event('chat.assistant.delta', { channel: 'thinkingSummary', source: 'runtime', delta: '等待模型' }),
    event('chat.assistant.delta', { channel: 'thinkingSummary', source: 'model', delta: '公开摘要' }),
    event('chat.assistant.delta', { channel: 'commentary', delta: '先读取' }),
    event('chat.assistant.delta', { channel: 'commentary', delta: '文件' }),
    event('tool.call.started', { callId: 'call:1', toolName: 'read_file', arguments: { file_name: 'a.txt' }, startedAt: '2026-11-10T01:00:00Z' }, 'tool:1'),
    event('runtime.observation.upserted', { observation: { callId: 'call:1', runId: 'turn:1', resultArtifactId: 'artifact:1', consumedByStepId: 'model:2' } }, 'tool:1'),
    event('runtime.artifact.created', { artifact: { id: 'artifact:1', stepId: 'tool:1', hash: 'a'.repeat(64) } }, 'tool:1'),
    event('tool.call.failed', { callId: 'call:1', toolName: 'read_file', code: 'TIMEOUT', message: '超时', durationMs: 200, completedAt: '2026-11-10T01:00:01Z' }, 'tool:1'),
  ]
  const rows = activityRows(trace)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].text, '先读取文件')
  assert.equal(rows[0].summary, '等待模型')
  assert.equal(rows[0].reasoningSummary, '公开摘要')
  assert.deepEqual(rows[1].arguments, { file_name: 'a.txt' })
  assert.equal(rows[1].status, 'error')
  assert.equal(rows[1].artifactId, 'artifact:1')
  assert.equal(rows[1].hash, 'a'.repeat(64))
  assert.equal(rows[1].consumedByStepId, 'model:2')
  assert.deepEqual(activityRows(JSON.parse(JSON.stringify(trace))), rows)
})

test('public progress channels never leak into final transcript and completion changes the running status', () => {
  for (const channel of ['thinkingSummary', 'commentary']) assert.equal(chatTextFromEvent(event('chat.assistant.delta', { channel, delta: '工作说明' })), undefined)
  const completed = transcriptMessageFromEvent(event('chat.assistant.completed', { messageId: 'answer:1', completedAt: '2026-11-10T01:00:00Z' }))
  assert.equal(completed?.id, 'answer:1')
  assert.equal(completed?.status, 'completed')
  assert.equal(completed?.turnId, 'turn:1')
})

test('failed model stages and child ownership remain visible after replay', () => {
  const failure = { phase: 'model_transport', code: 'MODEL_FAILED', message: 'HTTP 503' }
  const trace = [{ ...event('timeline.step.upserted', { step: { id: 'child:model', type: 'model', status: 'error', summary: '模型第 1 轮', detail: { error: failure } } }, 'child:model'), turnId: 'turn:child', parentTurnId: 'turn:parent' }]
  const row = activityRows(JSON.parse(JSON.stringify(trace)))[0]
  assert.equal(row.parentTurnId, 'turn:parent')
  assert.equal(row.status, 'error')
  assert.deepEqual(row.error, failure)
})

test('intentional detach and stale close events never disconnect the current session', () => {
  assert.equal(shouldHandleRuntimeClosed('runtime:new', {runtimeId:'runtime:old',code:1006,reason:'failed'}), false)
  assert.equal(shouldHandleRuntimeClosed('runtime:running', {runtimeId:'runtime:running',code:1000,reason:'closed'}), false)
  assert.equal(shouldHandleRuntimeClosed('runtime:new', {runtimeId:'runtime:new',code:1006,reason:'failed'}), true)
})
