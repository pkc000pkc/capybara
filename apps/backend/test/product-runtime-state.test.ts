import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ProductRuntimeStateAdapter,
  deserializeProductRuntimeState,
  normalizeProductRuntimeState,
  restoreProductRuntimeState,
  serializeProductRuntimeState,
  snapshotProductRuntimeState,
} from '#core/product-runtime-state'
import { ProductWorkLedger, type PermissionRequest } from '#core/product-work-ledger'

const projectId = 'project-runtime-state'
const actor = { type: 'agent' as const, id: 'runtime-agent' }
const permission: PermissionRequest = {
  level: 'L0',
  actorId: actor.id,
  projectId,
  capabilityId: 'cap-read',
  operation: 'read',
  targetSummary: 'read runtime state fixture',
  scope: {},
  reason: 'test state restore',
  expectedSideEffect: 'none',
}

function unknownLedger(): { ledger: ProductWorkLedger; actionId: string } {
  const ledger = new ProductWorkLedger({ projectId, actor, now: () => '2026-11-07T00:00:00.000Z' })
  const action = ledger.createAction({
    runId: 'run-runtime-state',
    capabilityId: permission.capabilityId,
    operation: permission.operation,
    arguments: { path: 'state.json' },
    target: { projectId, path: 'state.json' },
    risk: 'read',
    permissionRequest: permission,
    idempotencyKey: 'runtime-state-unknown',
    cancelMode: 'before-start',
    actor,
  })
  ledger.admitAction(action, { projectId })
  ledger.recordReceipt({ actionId: action.id, status: 'unknown', evidenceRefs: ['disconnect'], sideEffect: 'unknown' })
  return { ledger, actionId: action.id }
}

test('runtime adapter serializes and restores ProductWorkLedger unknown state', () => {
  const { ledger, actionId } = unknownLedger()
  const state = snapshotProductRuntimeState(undefined, ledger)
  assert.equal(state.version, 1)
  assert.equal(state.productWorkLedger?.receipts[0]?.status, 'unknown')
  assert.deepEqual(state.productCheckpoints, [])

  const restored = restoreProductRuntimeState(serializeProductRuntimeState(state))
  assert.equal(restored.ledger.getReceipt(actionId)?.status, 'unknown')
  const reconciled = restored.ledger.reconcile({ actionId, outcome: 'succeeded', evidenceRefs: ['external-receipt'] })
  assert.equal(reconciled.status, 'succeeded')
  assert.equal(restored.ledger.getReceipts(actionId)[0]?.status, 'unknown')
})

test('adapter checkpoint keeps product checkpoint beside legacy runtime checkpoint fields', () => {
  const ledger = new ProductWorkLedger({ projectId, actor })
  const adapter = new ProductRuntimeStateAdapter(ledger)
  const checkpoint = adapter.checkpoint(undefined, {
    runId: 'run-runtime-checkpoint',
    state: 'resumable',
    planCursor: 'step-1',
    completedActionIds: [],
    pendingActionIds: [],
    receiptSummary: { succeeded: [], failed: [], unknown: [] },
    openQuestions: [],
    externalFactsToVerify: [],
  })
  assert.equal(checkpoint.checkpoint.type, 'Checkpoint')
  assert.equal(checkpoint.state.productWorkLedger?.checkpoints[0]?.id, checkpoint.checkpoint.id)
  assert.equal(checkpoint.state.productCheckpoints?.[0]?.snapshotHash, checkpoint.checkpoint.snapshotHash)
})

test('old runtime state defaults missing optional fields and accepts legacy ledger key', () => {
  const { ledger } = unknownLedger()
  const oldState = {
    version: 1 as const,
    workLedger: ledger.snapshot(),
  }
  const normalized = normalizeProductRuntimeState(oldState)
  assert.deepEqual(normalized.pendingToolCalls, [])
  assert.deepEqual(normalized.pendingWorkflowCalls, [])
  assert.deepEqual(normalized.workflowDefinitions, [])
  assert.deepEqual(normalized.workflowData, [])
  assert.deepEqual(normalized.contextControl, {
    status: 'idle', evidenceRequests: [], uncertainties: [], reflectionAttempts: 0,
  })
  const restored = restoreProductRuntimeState(oldState)
  assert.equal(restored.ledger.snapshot().receipts[0]?.status, 'unknown')
  assert.equal((restored.runtimeState as { workLedger?: unknown }).workLedger, undefined)
  assert.equal(deserializeProductRuntimeState(serializeProductRuntimeState(normalized)).version, 1)
})
