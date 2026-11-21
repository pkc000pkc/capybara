import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BrowserCapability, type BrowserAction, type BrowserProfile } from '#core/browser-capability'
import { ProductWorkLedger } from '#core/product-work-ledger'
import { BrowserGatewayService, type BrowserExecutionResult } from '#core/browser-gateway-service'

const profile: Omit<BrowserProfile, 'revision' | 'status' | 'updatedAt'> = {
  id: 'profile-gateway', projectId: 'project-gateway', label: 'Gateway test', engine: 'chromium', persistence: 'ephemeral', credentialRefs: [],
  originPolicy: { allow: ['https://allowed.gateway.test'] }, downloadPolicy: 'quarantine', uploadRoots: ['project-file:'],
  permissions: { read: true, navigate: true, input: true, upload: true, download: true, screenshot: true, wait: true, assert: true, localReversible: true, externalReversible: true, externalIrreversible: true },
  createdBy: 'test',
}

function fixture(executor: (action: BrowserAction) => Promise<BrowserExecutionResult>): { service: BrowserGatewayService; action: BrowserAction } {
  const capability = new BrowserCapability({ now: () => '2026-11-07T12:00:00.000Z', idFactory: (prefix) => `${prefix}-fixed` })
  capability.createProfile(profile)
  capability.createSession({ id: 'gateway-session', profileId: profile.id, profileRevision: 1, projectId: profile.projectId, workSessionId: 'work-gateway', runId: 'run-gateway', browserInstanceId: 'browser-1', authState: 'anonymous' })
  capability.createTab({ id: 'gateway-tab', sessionId: 'gateway-session', index: 0, url: 'https://allowed.gateway.test/start', origin: 'https://allowed.gateway.test', status: 'interactive' })
  capability.capturePageState({ id: 'gateway-page', tabId: 'gateway-tab', capturedAt: '2026-11-07T12:00:00.000Z', url: 'https://allowed.gateway.test/start', title: 'Start', navigationId: 'navigation-1', domHash: 'dom-1', accessibilityHash: 'ax-1', textExcerpt: 'Gateway page', landmarks: [], frames: [], security: { https: true, certificateValid: true }, stale: false })
  const service = new BrowserGatewayService({ capability, ledger: new ProductWorkLedger({ now: () => '2026-11-07T12:00:00.000Z', projectId: profile.projectId }), executor: (request) => executor(request.action) })
  const action: BrowserAction = {
    id: 'gateway-action', runId: 'run-gateway', sessionId: 'gateway-session', tabId: 'gateway-tab', sequence: 1, kind: 'read',
    target: { pageStateId: 'gateway-page', role: 'main', name: 'content' }, arguments: { field: 'body' }, preconditions: [], risk: 'read', idempotencyKey: 'gateway-read-1', status: 'proposed',
  }
  return { service, action }
}

test('gateway executor success persists ProductWorkLedger Action/Receipt and Evidence/Artifact events', async () => {
  const { service, action } = fixture(async () => ({
    status: 'succeeded', result: { text: 'Gateway page' },
    evidence: [{ type: 'page-snapshot', status: 'verified', content: { text: 'Gateway page' } }],
    artifacts: [{ kind: 'page-extract', version: 1, sourceRefs: [], contentRef: 'object:page', summary: 'Extracted page', status: 'available' }],
  }))
  const result = await service.execute(action)
  assert.equal(result.admission.browser.disposition, 'accepted')
  assert.equal(result.browserReceipt.status, 'succeeded')
  assert.equal(result.ledgerReceipt?.status, 'succeeded')
  assert.equal(service.ledger.getAction(action.id)?.status, 'succeeded')
  assert.equal(result.evidence.length, 1)
  assert.equal(result.artifacts.length, 1)
  const eventTypes = service.ledger.getRunLedger(action.runId).map((event) => event.eventType)
  assert.ok(eventTypes.includes('evidence.captured'))
  assert.ok(eventTypes.includes('artifact.created'))
})

test('gateway snapshot restores browser session, page state, receipts, evidence, and artifacts', async () => {
  const { service, action } = fixture(async () => ({
    status: 'succeeded',
    result: { text: 'persisted page' },
    evidence: [{ type: 'page-snapshot', status: 'verified', content: { text: 'persisted page' } }],
    artifacts: [{ kind: 'page-extract', version: 1, sourceRefs: [], contentRef: 'object:persisted-page', summary: 'Persisted page', status: 'available' }],
  }))
  const first = await service.execute(action)
  const snapshot = service.exportState()
  const restored = new BrowserGatewayService({ executor: async () => ({ status: 'failed', error: { code: 'SHOULD_NOT_RUN', message: 'duplicate action must not execute' } }) })
  restored.restoreState(snapshot)
  assert.equal(restored.capability.getProfile(profile.id)?.id, profile.id)
  assert.equal(restored.capability.getSession(action.sessionId)?.id, action.sessionId)
  assert.equal(restored.capability.getTab(action.tabId)?.pageStateId, 'gateway-page')
  assert.equal(restored.capability.getReceipt(`receipt-${action.id}`)?.status, 'succeeded')
  assert.equal(restored.getEvidence(first.evidence[0]!.id)?.content.text, 'persisted page')
  assert.equal(restored.getArtifact(first.artifacts[0]!.id)?.summary, 'Persisted page')
  const duplicate = await restored.execute(action)
  assert.equal(duplicate.admission.browser.disposition, 'duplicate')
  assert.equal(duplicate.browserReceipt.status, 'succeeded')
  assert.equal(restored.ledger.getAction(action.id)?.status, 'succeeded')
})

test('gateway failure records failed receipt and does not report success', async () => {
  const { service, action } = fixture(async () => ({ status: 'failed', error: { code: 'SELECTOR_MISSING', message: 'content locator missing' } }))
  const result = await service.execute(action)
  assert.equal(result.browserReceipt.status, 'failed')
  assert.equal(result.ledgerReceipt?.status, 'failed')
  assert.equal(service.ledger.getAction(action.id)?.status, 'failed')
})

test('gateway disconnect produces unknown and reconcile requires evidence before terminal result', async () => {
  const { service, action } = fixture(async () => ({ status: 'unknown', externalEffect: 'possible', error: { code: 'DISCONNECTED', message: 'browser disconnected' } }))
  const result = await service.execute(action)
  assert.equal(result.browserReceipt.status, 'unknown')
  assert.equal(result.ledgerReceipt?.status, 'unknown')
  assert.throws(() => service.reconcile(action.id, { outcome: 'succeeded', evidenceRefs: [] }), /reconcile requires evidenceRefs/)
  const reconciled = service.reconcile(action.id, { outcome: 'succeeded', evidenceRefs: ['recovery-evidence'], resultHash: 'result-hash' })
  assert.equal(reconciled.ledgerReceipt.status, 'succeeded')
  assert.ok(reconciled.reconciliationActionId)
  assert.equal(reconciled.browserReceipt?.status, 'succeeded')
})

test('same idempotency key returns original receipt without executing twice', async () => {
  let executions = 0
  const { service, action } = fixture(async () => { executions += 1; return { status: 'succeeded', result: { ok: true } } })
  const first = await service.execute(action)
  const second = await service.execute({ ...action, id: 'gateway-action-retry', sequence: 1 })
  assert.equal(executions, 1)
  assert.equal(second.admission.browser.disposition, 'duplicate')
  assert.equal(second.browserReceipt.id, first.browserReceipt.id)
})

test('checkpoint is persisted to ProductWorkLedger and recovery flags unknown facts', async () => {
  const { service, action } = fixture(async () => ({ status: 'unknown', externalEffect: 'possible' }))
  await service.execute(action)
  const checkpoint = service.createCheckpoint(action.runId, { openQuestions: ['Was the browser request accepted?'] })
  assert.equal(checkpoint.ledger.state, 'needs-reconciliation')
  assert.deepEqual(checkpoint.ledger.receiptSummary.unknown, [action.id])
  const recovery = service.recoverCheckpoint(checkpoint.ledger.id)
  assert.equal(recovery.valid, true)
  assert.equal(recovery.requiresVerification, true)
  assert.equal(recovery.sessionStatus, 'reconnecting')
})

test('missing executor is an explicit unknown result', async () => {
  const { service, action } = fixture(async () => ({ status: 'succeeded' }))
  const noExecutor = new BrowserGatewayService({ capability: service.capability, ledger: new ProductWorkLedger({ projectId: profile.projectId }) })
  const result = await noExecutor.execute(action)
  assert.equal(result.browserReceipt.status, 'unknown')
  assert.equal(result.ledgerReceipt?.status, 'unknown')
})
