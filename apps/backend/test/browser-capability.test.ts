import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BrowserCapability,
  BROWSER_ACTION_STATUSES,
  BROWSER_ADMISSION_DISPOSITIONS,
  BROWSER_RECEIPT_STATUSES,
  type BrowserAction,
  type BrowserProfile,
  originAdmission,
  validateBrowserAction,
} from '#core/browser-capability'
import { ACTION_STATUSES, ADMISSION_DISPOSITIONS, RECEIPT_STATUSES, validateSourceRef } from '#core/product-work-ledger'

const profile: Omit<BrowserProfile, 'revision' | 'status' | 'updatedAt'> = {
  id: 'profile-travel', projectId: 'project-1', label: 'Travel read-only', engine: 'chromium', persistence: 'ephemeral',
  credentialRefs: [], originPolicy: { allow: ['https://allowed.test'], deny: ['https://blocked.test'], requireConfirmation: ['https://confirm.test'] },
  downloadPolicy: 'quarantine', uploadRoots: ['project-file:'], permissions: {
    read: true, navigate: true, input: true, upload: true, download: true, screenshot: true, wait: true, assert: true,
    localReversible: true, externalReversible: true, externalIrreversible: true,
  }, createdBy: 'user-1',
}

function action(overrides: Partial<BrowserAction> = {}): BrowserAction {
  return {
    id: 'action-1', runId: 'run-1', sessionId: 'browser-session-1', tabId: 'tab-1', sequence: 1,
    kind: 'read', target: { pageStateId: 'page-1', role: 'main', name: 'content' }, arguments: { field: 'body' },
    preconditions: [], risk: 'read', idempotencyKey: 'run-1:read:1', status: 'proposed', ...overrides,
  }
}

function readyCapability(): BrowserCapability {
  const capability = new BrowserCapability({ now: () => '2026-11-06T12:00:00.000Z', idFactory: (prefix) => `${prefix}-fixed` })
  capability.createProfile(profile)
  capability.createSession({ id: 'browser-session-1', profileId: 'profile-travel', profileRevision: 1, projectId: 'project-1', workSessionId: 'work-1', runId: 'run-1', browserInstanceId: 'chromium-1', authState: 'anonymous' })
  capability.createTab({ id: 'tab-1', sessionId: 'browser-session-1', index: 0, url: 'https://allowed.test/start', origin: 'https://allowed.test', status: 'interactive' })
  capability.capturePageState({ id: 'page-1', tabId: 'tab-1', capturedAt: '2026-11-06T12:00:00.000Z', url: 'https://allowed.test/start', title: 'Start', navigationId: 'nav-1', domHash: 'dom-1', accessibilityHash: 'ax-1', textExcerpt: 'content', landmarks: [], frames: [], security: { https: true, certificateValid: true }, stale: false })
  return capability
}

test('browser objects preserve profile/session/tab/page state linkage', () => {
  const capability = readyCapability()
  const session = capability.getSession('browser-session-1')
  const tab = capability.getTab('tab-1')
  const page = capability.getPageState('page-1')
  assert.equal(session?.profileRevision, 1)
  assert.deepEqual(session?.tabIds, ['tab-1'])
  assert.equal(tab?.pageStateId, 'page-1')
  assert.equal(page?.tabId, tab?.id)
})

test('origin admission denies unknown and blocked origins and marks confirmation origins', () => {
  assert.deepEqual(originAdmission(profile.originPolicy, 'https://allowed.test/path').allowed, true)
  assert.equal(originAdmission(profile.originPolicy, 'https://blocked.test').reason, 'origin-denied')
  assert.equal(originAdmission(profile.originPolicy, 'https://other.test').reason, 'origin-not-allowed')
  assert.equal(originAdmission({ allow: ['https://confirm.test'], requireConfirmation: ['https://confirm.test'] }, 'https://confirm.test').requiresConfirmation, true)
})

test('all structured action kinds are validated with kind-specific arguments', () => {
  const valid: BrowserAction[] = [
    action({ id: 'navigate', kind: 'navigate', target: { url: 'https://allowed.test/next' }, arguments: {}, risk: 'read' }),
    action({ id: 'read', kind: 'read', target: { role: 'main' }, arguments: { field: 'body' } }),
    action({ id: 'click', kind: 'click', target: { role: 'button', name: 'Continue' }, arguments: {}, risk: 'local-reversible' }),
    action({ id: 'input', kind: 'input', target: { label: 'Email' }, arguments: { value: 'a@example.test' }, risk: 'local-reversible' }),
    action({ id: 'select', kind: 'select', target: { label: 'Country' }, arguments: { value: 'CL' }, risk: 'local-reversible' }),
    action({ id: 'upload', kind: 'upload', target: { label: 'Attachment' }, arguments: { projectFileId: 'project-file:budget.csv' }, risk: 'local-reversible' }),
    action({ id: 'download', kind: 'download', target: { url: 'https://allowed.test/file.pdf' }, arguments: {}, risk: 'read' }),
    action({ id: 'screenshot', kind: 'screenshot', target: { pageStateId: 'page-1' }, arguments: { mode: 'viewport' }, risk: 'read' }),
    action({ id: 'wait', kind: 'wait', target: {}, arguments: { condition: 'network-idle', timeoutMs: 1000 }, risk: 'read' }),
    action({ id: 'assert', kind: 'assert', target: { role: 'main' }, arguments: { expression: 'text contains "content"' }, risk: 'read' }),
  ]
  for (const item of valid) assert.deepEqual(validateBrowserAction(item), [], item.kind)
  assert.match(validateBrowserAction(action({ kind: 'upload', target: { label: 'Attachment' }, arguments: { path: 'C:\\secret.txt' } }))[0] ?? '', /projectFileId/)
  assert.match(validateBrowserAction(action({ kind: 'input', arguments: {} }))[0] ?? '', /value or credentialRef/)
  assert.match(validateBrowserAction(action({ kind: 'navigate', target: {} }))[0] ?? '', /URL/)
})

test('origin, permission and risk admission rejects before dispatch with not_executed receipt', () => {
  const capability = readyCapability()
  const outside = capability.admitAction(action({ id: 'outside', idempotencyKey: 'outside', kind: 'navigate', target: { url: 'https://other.test' }, arguments: {} }))
  assert.equal(outside.disposition, 'rejected')
  assert.equal(outside.action.status, 'rejected')
  assert.equal(outside.receipt.status, 'not_executed')
  assert.ok(outside.reasons.includes('origin-not-allowed'))

  const deniedCapability = new BrowserCapability()
  deniedCapability.createProfile({ ...profile, id: 'denied-profile', permissions: { ...profile.permissions, read: false } })
  deniedCapability.createSession({ id: 's-denied', profileId: 'denied-profile', profileRevision: 1, projectId: 'project-1', workSessionId: 'work-1', runId: 'run-denied', authState: 'anonymous' })
  deniedCapability.createTab({ id: 't-denied', sessionId: 's-denied', index: 0, url: 'https://allowed.test', origin: 'https://allowed.test', status: 'interactive' })
  const denied = deniedCapability.admitAction(action({ id: 'denied', runId: 'run-denied', sessionId: 's-denied', tabId: 't-denied', idempotencyKey: 'denied', target: { role: 'main' } }))
  assert.equal(denied.disposition, 'rejected')
  assert.ok(denied.reasons.includes('permission-denied'))
  assert.equal(denied.receipt.status, 'not_executed')

  const external = capability.admitAction(action({ id: 'external', idempotencyKey: 'external', sequence: 2, kind: 'click', target: { pageStateId: 'page-1', role: 'button', name: 'Send' }, risk: 'external-irreversible' }))
  assert.equal(external.disposition, 'accepted')
  assert.equal(external.action.status, 'awaiting_authorization')
  assert.equal(external.receipt.status, 'not_executed')
  assert.equal(external.requiresAuthorization, true)
})

test('unknown result is retained and duplicate idempotency returns the original receipt', () => {
  const capability = readyCapability()
  const first = capability.admitAction(action({ id: 'submit', idempotencyKey: 'submit', kind: 'click', target: { pageStateId: 'page-1', role: 'button', name: 'Submit' }, risk: 'external-reversible', authorization: { confirmed: true, authorizationRef: 'auth-1' } }))
  assert.equal(first.disposition, 'accepted')
  assert.equal(capability.startAction('submit').status, 'started')
  const unknown = capability.markUnknown('submit', 'gateway disconnected after dispatch')
  assert.equal(unknown.status, 'unknown')
  assert.equal(unknown.externalEffect, 'possible')

  const duplicate = capability.admitAction(action({ id: 'submit-retry', idempotencyKey: 'submit', kind: 'click', target: { pageStateId: 'page-1', role: 'button', name: 'Submit' }, risk: 'external-reversible', authorization: { confirmed: true, authorizationRef: 'auth-1' } }))
  assert.equal(duplicate.disposition, 'duplicate')
  assert.equal(duplicate.action.id, 'submit')
  assert.equal(duplicate.receipt.id, unknown.id)
  assert.equal(duplicate.receipt.status, 'unknown')
})

test('checkpoint validates profile/page state and requires verification for unknown in-flight action', () => {
  const capability = readyCapability()
  const pending = capability.admitAction(action({ id: 'pending', idempotencyKey: 'pending' }))
  assert.equal(pending.disposition, 'accepted')
  capability.startAction('pending')
  capability.markUnknown('pending')
  const checkpoint = capability.createCheckpoint('run-1', ['confirm whether the request was accepted'])
  assert.equal(checkpoint.inFlightActionId, 'pending')
  const validation = capability.validateCheckpoint(checkpoint)
  assert.equal(validation.valid, true)
  assert.equal(validation.requiresVerification, true)
  assert.equal(capability.restoreCheckpoint(checkpoint).valid, true)
  assert.equal(capability.getSession('browser-session-1')?.status, 'reconnecting')

  const stale = { ...checkpoint, profileRevision: 99 }
  assert.equal(capability.validateCheckpoint(stale).valid, false)
  assert.ok(capability.validateCheckpoint(stale).reasons.includes('profile-revision-mismatch'))
})

test('browser admission and evidence use the shared product ledger vocabularies', () => {
  assert.deepEqual(BROWSER_ACTION_STATUSES, ACTION_STATUSES)
  assert.deepEqual(BROWSER_RECEIPT_STATUSES, RECEIPT_STATUSES)
  assert.deepEqual(BROWSER_ADMISSION_DISPOSITIONS, ADMISSION_DISPOSITIONS)
  const capability = readyCapability()
  const sourceRef = { type: 'page' as const, id: 'page-1', relation: 'references' as const }
  assert.doesNotThrow(() => validateSourceRef(sourceRef))
  const evidence = capability.recordEvidence({ id: 'evidence-1', type: 'page-snapshot', status: 'captured', content: { title: 'Start' }, sourceRefs: [sourceRef] })
  assert.deepEqual(evidence.sourceRefs, [sourceRef])
  const artifact = capability.recordArtifact({ id: 'artifact-1', kind: 'page-extract', version: 1, sourceRefs: [sourceRef], contentRef: 'object:evidence-1', summary: 'Page extract', status: 'available' })
  assert.deepEqual(artifact.sourceRefs, [sourceRef])
})
