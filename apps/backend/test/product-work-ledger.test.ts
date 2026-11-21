import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ProductWorkLedger,
  createRecordEnvelope,
  type Action,
  type PermissionRequest,
  type SourceRef,
  validateCheckpoint,
  type Checkpoint,
} from '#core/product-work-ledger'

const projectId = 'project-travel'
const actor = { type: 'agent' as const, id: 'agent-planner' }
const sourceRefs: SourceRef[] = [{ type: 'instruction', id: 'instruction-1', relation: 'planned-from', version: 1 }]

function permission(level: PermissionRequest['level'] = 'L0'): PermissionRequest {
  return {
    level,
    actorId: actor.id,
    projectId,
    capabilityId: 'cap-file-read',
    operation: 'read',
    targetSummary: 'read project file',
    scope: { paths: ['docs'] },
    reason: 'collect project facts',
    expectedSideEffect: 'none',
  }
}

function action(ledger: ProductWorkLedger, runId: string, options: Partial<Parameters<ProductWorkLedger['createAction']>[0]> = {}): Action {
  return ledger.createAction({
    runId,
    capabilityId: 'cap-file-read',
    operation: 'read',
    arguments: { path: 'docs/plan.md' },
    target: { projectId, path: 'docs/plan.md' },
    risk: 'read',
    permissionRequest: permission(options.permissionRequest?.level ?? 'L0'),
    idempotencyKey: options.idempotencyKey ?? `idem:${runId}:${Math.random()}`,
    cancelMode: 'before-start',
    actor,
    sourceRefs,
    ...options,
  })
}

test('RecordEnvelope validates sourceRefs and preserves exact source versions', () => {
  const envelope = createRecordEnvelope({
    id: 'run-1',
    type: 'Run',
    projectId,
    status: 'planned',
    actor,
    sourceRefs,
  })
  assert.equal(envelope.sourceRefs[0]?.version, 1)
  assert.throws(() => createRecordEnvelope({
    id: 'bad', type: 'Run', projectId, status: 'planned', actor,
    sourceRefs: [{ type: 'run', id: 'run-1', relation: 'references', version: 0 }],
  }), /version must be a positive integer/)
})

test('Run Ledger appends immutable events and deduplicates idempotency keys', () => {
  const ledger = new ProductWorkLedger({ projectId, actor })
  const first = ledger.appendRunEvent({
    runId: 'run-1', eventType: 'run.created', idempotencyKey: 'event-1', actor,
    sourceRefs: [{ type: 'run', id: 'run-1', relation: 'created-by' }],
    payload: { workItemId: 'work-1' },
  })
  const duplicate = ledger.appendRunEvent('run-1', {
    eventType: 'run.created', idempotencyKey: 'event-1', payload: { workItemId: 'work-1' },
  })
  assert.equal(first.duplicate, false)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.event.id, first.event.id)
  const second = ledger.appendEvent({ runId: 'run-1', eventType: 'action.proposed', idempotencyKey: 'event-2' })
  assert.equal(second.sequence, 2)
  assert.throws(() => ledger.appendEvent({ runId: 'run-1', eventType: 'run.created', idempotencyKey: 'event-1', payload: { changed: true } }), /idempotency collision/)
  const snapshot = ledger.getRunLedger('run-1')
  snapshot[0]!.payload = { changed: true }
  assert.deepEqual(ledger.getRunLedger('run-1')[0]!.payload, { workItemId: 'work-1' })
})

test('Action Admission rejects unauthorized work with a not_executed receipt and deduplicates retries', () => {
  const ledger = new ProductWorkLedger({ projectId, actor })
  const highRisk = action(ledger, 'run-admission', {
    risk: 'external-side-effect',
    operation: 'submit',
    permissionRequest: permission('L3'),
    idempotencyKey: 'submit-once',
  })
  const rejected = ledger.admitAction(highRisk, { projectId })
  assert.equal(rejected.disposition, 'rejected')
  assert.equal(rejected.action.status, 'rejected')
  assert.equal(rejected.receipt?.status, 'not_executed')

  const retry = ledger.admitAction({ ...highRisk, id: 'different-action-id' }, { projectId })
  assert.equal(retry.disposition, 'duplicate')
  assert.equal(retry.receipt?.status, 'not_executed')

  const allowed = action(ledger, 'run-admission', { idempotencyKey: 'read-once' })
  const admitted = ledger.admitAction(allowed, { projectId, capability: { state: 'available', requiredPermission: 'L0', risk: 'read', scope: {} } })
  assert.equal(admitted.disposition, 'accepted')
  assert.equal(admitted.action.status, 'admitted')
  assert.equal(ledger.getRunLedger('run-admission').some((event) => event.eventType === 'action.admitted'), true)
})

test('unknown receipt cannot be retried directly; reconcile creates a new action and preserves unknown evidence', () => {
  const ledger = new ProductWorkLedger({ projectId, actor })
  const original = action(ledger, 'run-unknown', { idempotencyKey: 'external-write' })
  assert.equal(ledger.admitAction(original, { projectId, authorized: true }).disposition, 'accepted')
  const unknown = ledger.recordReceipt({ actionId: original.id, status: 'unknown', evidenceRefs: ['runtime-disconnect'], sideEffect: 'unknown' })
  assert.equal(unknown.status, 'unknown')
  assert.throws(() => ledger.recordReceipt({ actionId: original.id, status: 'succeeded', evidenceRefs: ['guess'], sideEffect: 'external-reversible' }), /requires reconcile/)
  const reconciled = ledger.reconcileUnknown({ actionId: original.id, outcome: 'succeeded', evidenceRefs: ['external-receipt-1'] })
  assert.equal(reconciled.status, 'succeeded')
  assert.equal(reconciled.reconciledFromReceiptId, unknown.id)
  assert.equal(ledger.getAction(original.id)?.status, 'succeeded')
  assert.equal(ledger.getAction(reconciled.reconciliationActionId)?.operation, 'reconcile')
  assert.equal(ledger.getReceipts(original.id).length, 2)
  assert.equal(ledger.getRunLedger('run-unknown').some((event) => event.eventType === 'run.reconciled'), true)
})

test('Checkpoint validates action membership, unknown reconciliation boundary and snapshot hash', () => {
  const ledger = new ProductWorkLedger({ projectId, actor })
  const runId = 'run-checkpoint'
  const done = action(ledger, runId, { idempotencyKey: 'done' })
  const pending = action(ledger, runId, { idempotencyKey: 'pending' })
  ledger.admitAction(done, { projectId })
  ledger.recordReceipt({ actionId: done.id, status: 'succeeded', evidenceRefs: ['hash-1'], sideEffect: 'none' })
  ledger.admitAction(pending, { projectId })
  ledger.recordReceipt({ actionId: pending.id, status: 'unknown', evidenceRefs: ['disconnect'], sideEffect: 'unknown' })
  const checkpoint = ledger.createCheckpoint({
    runId,
    state: 'needs-reconciliation',
    planCursor: 'step-2',
    completedActionIds: [done.id],
    pendingActionIds: [pending.id],
    receiptSummary: { succeeded: [done.id], failed: [], unknown: [pending.id] },
    openQuestions: [],
    externalFactsToVerify: ['external-write-status'],
  })
  assert.equal(validateCheckpoint(checkpoint), undefined)
  const tampered = { ...checkpoint, planCursor: 'step-tampered' } as Checkpoint
  assert.throws(() => ledger.validateCheckpoint(tampered), /snapshotHash does not match/)
  assert.throws(() => ledger.createCheckpoint({
    ...checkpoint,
    id: 'bad-checkpoint',
    state: 'resumable',
    externalFactsToVerify: [],
  }), /unknown receipts must require reconciliation/)
})
