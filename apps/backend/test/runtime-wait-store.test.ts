import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { BRANCH_EVIDENCE, BRANCH_HUMAN_REPLY, MCP_OPERATION_SETTLED, RuntimeWaitStore } from '#core/runtime-wait-store'
import { ContextCommitStore } from '#core/context-commit-store'
import { clearSessionContexts } from '#core/context-storage-lifecycle'
import type { RuntimeLoopState } from '#core/runtime-loop-state'
import type { RuntimeRequestBinding, RuntimeWaitSpec } from '#protocol/runtime-protocol'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-wait-store-'))
  const store = new RuntimeWaitStore(root)
  const binding: RuntimeRequestBinding = { sessionId: 's', taskId: 't', runId: 'r', requestId: 'request-1', stateRevision: 1 }
  const spec: RuntimeWaitSpec = { reason: '等待证据', signalType: 'external', correlationIds: ['a'], condition: { eventType: 'ready', status: 'ready' }, resumeCondition: '{"eventType":"ready","status":"ready"}', deadlineRef: null }
  const checkpoint = (id: string) => ({ snapshot: { run: { runId: binding.runId, status: 'paused', currentStep: 4 } }, taskControl: { taskId: binding.taskId }, contextControl: { waitId: id }, pendingToolCalls: [] } as unknown as RuntimeLoopState)
  const signal = { id: 'event-1', sessionId: 's', taskId: 't', runId: 'r', signalType: 'external' as const, eventType: 'ready', correlationId: 'a', status: 'ready' }
  return { root, store, binding, spec, checkpoint, signal, db: () => new DatabaseSync(path.join(root, '.capybara/sessions.sqlite')), close() { store.close(); fs.rmSync(root, { recursive: true, force: true }) } }
}

test('deadline references are host issued, task bound and idempotent without extending the window', () => {
  const f = fixture()
  try {
    const first = f.store.createDeadline(f.binding, 'op', 1000)
    assert.deepEqual(f.store.createDeadline(f.binding, 'op', 1000), first)
    assert.throws(() => f.store.createDeadline(f.binding, 'op', 2000), /ID_CONFLICT/)
    assert.throws(() => f.store.register('wait-1', { ...f.binding, taskId: 'other' }, { ...f.spec, deadlineRef: first.id }, f.checkpoint('wait-1')), /BINDING_MISMATCH/)
    assert.throws(() => f.store.register('wait-1', f.binding, { ...f.spec, deadlineRef: 'invented-time' }, f.checkpoint('wait-1')), /BINDING_MISMATCH/)
    assert.equal(f.store.read(f.binding).subscriptions.length, 0)
  } finally { f.close() }
})

test('a scoped evidence batch commits one checkpoint and rolls back all requests on a failed member', () => {
  const f = fixture(), db = f.db()
  try {
    const checkpoint = f.checkpoint('not-a-global-wait')
    const blocks = ['first', 'second'].map(id => ({ id, kind: 'evidence' as const, taskIds: ['node'], reason: id,
      evidenceRequest: { id, question: id, sourceKinds: ['external' as const] } }))
    checkpoint.taskControl!.branchBlocks = blocks
    const batch = blocks.map(block => ({ id: block.id, binding: f.binding, spec: {
      reason: block.reason, signalType: 'runtime' as const, blockingTaskIds: block.taskIds, correlationIds: [block.id],
      condition: { eventType: BRANCH_EVIDENCE }, resumeCondition: BRANCH_EVIDENCE,
    } }))
    assert.throws(() => f.store.registerBatch([batch[0]!, { ...batch[1]!, id: 'absent' }], checkpoint), /WAIT_CHECKPOINT_INVALID/)
    assert.equal(f.store.read(f.binding).subscriptions.length, 0)
    f.store.registerBatch(batch, checkpoint)
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM runtime_waits WHERE checkpoint_json<>''").get() as { count: number }).count, 1)
    const first = { sourceId: 'publisher', externalSignalId: 'msg-1', text: '原始材料' }
    assert.equal(f.store.supplyEvidence(f.binding, 'first', 'external', first).duplicate, false)
    assert.equal(f.store.supplyEvidence(f.binding, 'first', 'external', first).duplicate, true)
    assert.throws(() => f.store.supplyEvidence(f.binding, 'second', 'external', first), /BRANCH_EXTERNAL_SIGNAL_ALREADY_CONSUMED/)
    assert.equal(f.store.load(f.binding, 'second').status, 'pending')
    assert.deepEqual(f.store.recoverCheckpoint(f.binding.sessionId), checkpoint)
  } finally { db.close(); f.close() }
})

test('a human reply receipt survives reopening and belongs only to the matching session, run and task', () => {
  const f = fixture()
  const id = 'human-request-confirm'
  const checkpoint = f.checkpoint(id)
  checkpoint.taskControl!.branchBlocks = [{ id, kind: 'human', taskIds: ['authorize'], reason: '请确认授权' }]
  try {
    f.store.register(id, f.binding, { reason: '请确认授权', signalType: 'user', correlationIds: [id],
      resumeCondition: BRANCH_HUMAN_REPLY, condition: { eventType: BRANCH_HUMAN_REPLY }, blockingTaskIds: ['authorize'] }, checkpoint)
    assert.deepEqual(f.store.readBranchHumanReplies(f.binding), [])
    assert.throws(() => f.store.recordSignal({ ...f.signal, id: `human:${id}`, eventType: BRANCH_HUMAN_REPLY }), /WAIT_SIGNAL_RESERVED_EVENT/)
    f.store.replyToBranchHuman(f.binding, id, { messageId: 'reply-1', text: '不同意执行。' })
    f.store.close()
    const reopened = new RuntimeWaitStore(f.root)
    try {
      const signal = reopened.readSignal(f.binding, `human:${id}`)
      assert.deepEqual(reopened.readBranchHumanReplies(f.binding), [{ requestId: id, taskIds: ['authorize'], replyMessageId: 'reply-1',
        receivedAt: signal.receivedAt, completionActionRef: signal.id }])
      for (const field of ['sessionId', 'taskId', 'runId'] as const) {
        assert.deepEqual(reopened.readBranchHumanReplies({ ...f.binding, [field]: 'other' }), [])
      }
      assert.throws(() => reopened.replyToBranchHuman(f.binding, id, { messageId: 'reply-2', text: '修改答复' }), /HUMAN_REQUEST_MISMATCH/)
    } finally { reopened.close() }
  } finally { f.close() }
})

test('two store connections deduplicate the same real signal and reject semantic ID reuse', () => {
  const f = fixture(), second = new RuntimeWaitStore(f.root)
  try {
    f.store.register('wait-1', f.binding, f.spec, f.checkpoint('wait-1'))
    const first = f.store.recordSignal(f.signal)
    assert.equal(first.duplicate, false)
    const duplicate = second.recordSignal(f.signal)
    assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.signal, first.signal)
    assert.throws(() => second.recordSignal({ ...f.signal, status: 'changed' }), /ID_CONFLICT/)
    assert.throws(() => second.recordSignal({ ...f.signal, id: 'runtime:reserved-host-id' }), /WAIT_SIGNAL_RESERVED_ID/)
    assert.equal(second.load(f.binding, 'wait-1').status, 'satisfied')
    assert.deepEqual(second.load(f.binding, 'wait-1').matchedSignalIds, ['event-1'])
  } finally { second.close(); f.close() }
})

test('late signals cannot relabel an elapsed deadline as success', async () => {
  const f = fixture()
  try {
    const deadline = f.store.createDeadline(f.binding, 'short-window', 80)
    f.store.register('wait-1', f.binding, { ...f.spec, deadlineRef: deadline.id }, f.checkpoint('wait-1'))
    await delay(Math.max(1, Date.parse(deadline.expiresAt) - Date.now() + 20))
    f.store.recordSignal(f.signal)
    const result = f.store.load(f.binding, 'wait-1')
    assert.equal(result.status, 'timed_out'); assert.deepEqual(result.matchedSignalIds, [])
    assert.equal(f.store.cancel(f.binding, result.id, 'late cancellation').status, 'timed_out')
  } finally { f.close() }
})

test('signal and settlement failures roll back together and the same event can be retried safely', () => {
  const f = fixture(), db = f.db()
  try {
    f.store.register('wait-1', f.binding, f.spec, f.checkpoint('wait-1'))
    db.exec("CREATE TRIGGER wait_settlement_fault BEFORE UPDATE ON runtime_waits BEGIN SELECT RAISE(ABORT,'WAIT_SETTLEMENT_FAULT'); END")
    assert.throws(() => f.store.recordSignal(f.signal), /WAIT_SETTLEMENT_FAULT/)
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM runtime_wait_signals').get() as { count: number }).count, 0)
    assert.equal(f.store.load(f.binding, 'wait-1').status, 'pending')
    db.exec('DROP TRIGGER wait_settlement_fault')
    assert.equal(f.store.recordSignal(f.signal).duplicate, false)
    assert.equal(f.store.load(f.binding, 'wait-1').status, 'satisfied')
  } finally { db.close(); f.close() }
})

test('session clearing removes wait control records and tombstones reject an older connection', () => {
  const f = fixture(), db = f.db()
  try {
    f.store.createDeadline(f.binding, 'op', 1000)
    f.store.register('wait-1', f.binding, f.spec, f.checkpoint('wait-1'))
    f.store.recordSignal({ ...f.signal, correlationId: 'other' })
    db.exec('BEGIN IMMEDIATE'); clearSessionContexts(db); db.exec('COMMIT')
    for (const table of ['runtime_waits', 'runtime_wait_deadlines', 'runtime_wait_signals']) assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count, 0)
    assert.throws(() => f.store.recordSignal(f.signal), /CONTEXT_SESSION_CLEARED/)
    assert.throws(() => f.store.createDeadline(f.binding, 'new-op', 1000), /CONTEXT_SESSION_CLEARED/)
  } finally { db.close(); f.close() }
})

test('foreign task and run signals remain separate from this subscription', () => {
  const f = fixture()
  try {
    f.store.register('wait-1', f.binding, f.spec, f.checkpoint('wait-1'))
    f.store.recordSignal({ ...f.signal, taskId: 'other-task' })
    f.store.recordSignal({ ...f.signal, id: 'event-2', runId: 'other-run' })
    assert.equal(f.store.load(f.binding, 'wait-1').status, 'pending')
    assert.throws(() => f.store.load({ ...f.binding, taskId: 'other-task' }, 'wait-1'), /BINDING_MISMATCH/)
  } finally { f.close() }
})

test('MCP wait recovery uses the persisted proof time and treats both terminal outcomes distinctly', t => {
  let timestamp = Date.now()
  t.mock.method(Date, 'now', () => timestamp)
  for (const offset of [500, 1001]) {
    const f = fixture(), commits = new ContextCommitStore(f.root)
    try {
      const operationId = randomUUID()
      const source = { type: 'mcp' as const, operationId, serverId: 'records', toolName: 'mutate', connectionId: 'connection',
        sourceVersion: 'version', dispatched: false, outcome: 'unknown' as const }
      commits.reserveMcpOperation(f.binding.sessionId, 'a'.repeat(64), source, { taskId: f.binding.taskId, runId: f.binding.runId,
        callId: 'original', toolName: 'mcp_mutate', argumentHash: 'b'.repeat(64), verification: { toolName: 'verify', authorityVersion: 'original-contract' } })
      commits.settleMcpOperation(f.binding.sessionId, { ...source, dispatched: true, rpcRequestId: 1 })
      const deadline = f.store.createDeadline(f.binding, 'original-wait-window', 1000)
      f.store.register('wait-1', f.binding, { reason: '等待原写入结算', signalType: 'runtime', correlationIds: [operationId],
        condition: { eventType: MCP_OPERATION_SETTLED }, resumeCondition: MCP_OPERATION_SETTLED, deadlineRef: deadline.id }, f.checkpoint('wait-1'))
      timestamp += offset
      const body = JSON.stringify({ kind: 'mcp-operation-verification', operationId,
        source: { ...source, toolName: 'verify', dispatched: true, rpcRequestId: 2, outcome: 'succeeded' },
        result: { resultType: 'complete', structuredContent: { operation_id: operationId, outcome: 'not_applied' } } })
      const receipt = commits.verifyMcpOperation(operationId, f.binding, 'probe', { id: 'proof', kind: 'tool-result', label: 'proof',
        contentType: 'application/json', byteLength: Buffer.byteLength(body), hash: createHash('sha256').update(body).digest('hex'),
        preview: '', redacted: false, runId: f.binding.runId, createdAt: new Date(timestamp).toISOString() }, body)
      timestamp += 2000
      f.store.close()
      const reopened = new RuntimeWaitStore(f.root)
      try {
        const wait = reopened.expire(f.binding).subscriptions[0]!
        if (offset < 1000) {
          assert.equal(wait.status, 'satisfied')
          const signal = reopened.readSignal(f.binding, wait.matchedSignalIds[0]!)
          assert.equal(signal.status, 'not_applied')
          assert.equal(signal.receivedAt, receipt.verifiedAt)
          assert.deepEqual(signal.data, { receiptId: receipt.id, artifactId: receipt.artifactId, artifactHash: receipt.artifactHash })
        } else { assert.equal(wait.status, 'timed_out'); assert.deepEqual(wait.matchedSignalIds, []) }
      } finally { reopened.close() }
    } finally { commits.close(); f.close() }
  }
})
