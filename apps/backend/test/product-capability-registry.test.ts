import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ProductCapabilityRegistry,
  ProductCapabilityUnknownError,
  type ProductCapabilityDescriptor,
} from '#core/product-capability-registry'
import { ProductWorkLedger } from '#core/product-work-ledger'

const projectId = 'project-capability'
const actor = { type: 'agent' as const, id: 'capability-agent' }

function descriptor(overrides: Partial<ProductCapabilityDescriptor<{ path: string }, { value: string }>> = {}): ProductCapabilityDescriptor<{ path: string }, { value: string }> {
  return {
    id: 'file.read', kind: 'file', apiVersion: '1', inputSchema: 'file.read.input.v1', outputSchema: 'file.read.output.v1',
    scope: { projectIds: [projectId], paths: ['docs'] }, risk: 'read', requiredPermission: 'L0', evidenceKinds: ['file-hash'], state: 'available', ...overrides,
  }
}

function input(idempotencyKey: string, path = 'docs/readme.md') {
  return { capabilityId: 'file.read', runId: 'run-capability', operation: 'read', input: { path }, target: { projectId, path }, idempotencyKey, actor }
}

test('registry registers, resolves, filters by scope and unregisters typed adapters', () => {
  const registry = new ProductCapabilityRegistry({ projectId, actor })
  const adapter = { execute: async ({ input }: { input: { path: string } }) => ({ value: input.path }) }
  registry.register<{ path: string }, { value: string }>(descriptor(), adapter)
  assert.equal(registry.resolveAdapter<{ path: string }, { value: string }>('file.read'), adapter)
  assert.equal(registry.getDescriptor('file.read')?.requiredPermission, 'L0')
  assert.equal(registry.list({ projectId, path: 'docs/readme.md' }).length, 1)
  assert.equal(registry.list({ projectId, path: 'private/secret.txt' }).length, 0)
  assert.equal(registry.unregister('file.read'), true)
  assert.equal(registry.get('file.read'), undefined)
})

test('registry admits and executes once; duplicate idempotency never calls adapter twice', async () => {
  const ledger = new ProductWorkLedger({ projectId, actor })
  const registry = new ProductCapabilityRegistry({ ledger, projectId, actor })
  let calls = 0
  registry.register<{ path: string }, { value: string }>(descriptor(), { execute: ({ input }) => { calls += 1; return { status: 'succeeded', output: { value: input.path }, evidenceRefs: ['file-hash'] } } })
  const first = await registry.execute<{ path: string }, { value: string }>(input('read-once'))
  assert.equal(first.admission.disposition, 'accepted')
  assert.equal(first.receipt?.status, 'succeeded')
  assert.equal(first.output?.value, 'docs/readme.md')
  assert.equal(calls, 1)
  const duplicate = await registry.execute<{ path: string }, { value: string }>(input('read-once'))
  assert.equal(duplicate.admission.disposition, 'duplicate')
  assert.equal(duplicate.receipt?.status, 'succeeded')
  assert.equal(calls, 1)
  const checkpoint = registry.checkpoint({
    runId: 'run-capability', state: 'resumable', planCursor: 'done',
    completedActionIds: [first.action.id], pendingActionIds: [],
    receiptSummary: { succeeded: [first.action.id], failed: [], unknown: [] },
    openQuestions: [], externalFactsToVerify: [],
  })
  assert.equal(checkpoint.type, 'Checkpoint')
})

test('registry records explicit adapter failures without retrying the action', async () => {
  const ledger = new ProductWorkLedger({ projectId, actor })
  const registry = new ProductCapabilityRegistry({ ledger, projectId, actor })
  registry.register(descriptor({ id: 'file.validate' }), {
    execute: () => ({ status: 'failed', error: { code: 'INVALID_FILE', message: 'invalid file', retryable: true }, evidenceRefs: ['validation-log'] }),
  })
  const result = await registry.execute({ ...input('failure-once'), capabilityId: 'file.validate' })
  assert.equal(result.receipt?.status, 'failed')
  assert.equal(result.error?.code, 'INVALID_FILE')
  const duplicate = await registry.execute({ ...input('failure-once'), capabilityId: 'file.validate' })
  assert.equal(duplicate.admission.disposition, 'duplicate')
})

test('registry rejects out-of-scope and unauthorized actions before adapter invocation', async () => {
  const ledger = new ProductWorkLedger({ projectId, actor })
  const registry = new ProductCapabilityRegistry({ ledger, projectId, actor })
  let calls = 0
  registry.register<{ path: string }, { value: string }>(descriptor({ requiredPermission: 'L3' }), { execute: () => { calls += 1; return { value: 'blocked' } } })
  const result = await registry.execute<{ path: string }, { value: string }>(input('blocked', 'private/secret.txt'))
  assert.equal(result.admission.disposition, 'rejected')
  assert.equal(result.receipt?.status, 'not_executed')
  assert.equal(calls, 0)
})

test('unknown adapter result stays unknown until explicit reconciliation', async () => {
  const ledger = new ProductWorkLedger({ projectId, actor })
  const registry = new ProductCapabilityRegistry({ ledger, projectId, actor })
  registry.register(descriptor({ id: 'file.write', scope: { projectIds: [projectId], paths: ['docs'] }, risk: 'reversible-write', requiredPermission: 'L1' }), {
    execute: () => { throw new ProductCapabilityUnknownError('connection lost', { evidenceRefs: ['disconnect'], sideEffect: 'unknown' }) },
  })
  const result = await registry.execute({ ...input('write-once'), capabilityId: 'file.write' })
  assert.equal(result.receipt?.status, 'unknown')
  assert.equal(result.action.status, 'unknown')
  const reconciled = registry.reconcile({ actionId: result.action.id, outcome: 'not_executed', evidenceRefs: ['external-query'] })
  assert.equal(reconciled.status, 'not_executed')
  assert.equal(ledger.getReceipts(result.action.id).some((receipt) => receipt.status === 'unknown'), true)
})
