import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BrowserCapability, type BrowserAction, type BrowserProfile } from '#core/browser-capability'
import { BrowserGatewayService } from '#core/browser-gateway-service'
import { BrowserCapabilityAdapter } from '#core/browser-capability-adapter'
import { ProductCapabilityRegistry } from '#core/product-capability-registry'

const profile: Omit<BrowserProfile, 'revision' | 'status' | 'updatedAt'> = {
  id: 'profile-adapter', projectId: 'project-adapter', label: 'Adapter test', engine: 'chromium', persistence: 'ephemeral', credentialRefs: [],
  originPolicy: { allow: ['https://allowed.adapter.test'] }, downloadPolicy: 'quarantine', uploadRoots: ['project-file:'],
  permissions: { read: true, navigate: true, input: true, upload: true, download: true, screenshot: true, wait: true, assert: true, localReversible: true, externalReversible: true, externalIrreversible: true },
  createdBy: 'test',
}

function browserAction(): BrowserAction {
  return {
    id: 'browser-input-action', runId: 'run-adapter', sessionId: 'adapter-session', tabId: 'adapter-tab', sequence: 1,
    kind: 'read', target: { pageStateId: 'adapter-page', role: 'main', name: 'content' }, arguments: { field: 'body' }, preconditions: [], risk: 'read', idempotencyKey: 'adapter-read-1', status: 'proposed',
  }
}

function fixture(result: 'succeeded' | 'unknown' = 'succeeded') {
  const capability = new BrowserCapability({ now: () => '2026-11-07T13:00:00.000Z', idFactory: (prefix) => `${prefix}-adapter` })
  capability.createProfile(profile)
  capability.createSession({ id: 'adapter-session', profileId: profile.id, profileRevision: 1, projectId: profile.projectId, workSessionId: 'work-adapter', runId: 'run-adapter', browserInstanceId: 'browser-adapter', authState: 'anonymous' })
  capability.createTab({ id: 'adapter-tab', sessionId: 'adapter-session', index: 0, url: 'https://allowed.adapter.test/start', origin: 'https://allowed.adapter.test', status: 'interactive' })
  capability.capturePageState({ id: 'adapter-page', tabId: 'adapter-tab', capturedAt: '2026-11-07T13:00:00.000Z', url: 'https://allowed.adapter.test/start', title: 'Adapter page', navigationId: 'navigation-adapter', domHash: 'dom-adapter', accessibilityHash: 'ax-adapter', textExcerpt: 'Adapter content', landmarks: [], frames: [], security: { https: true, certificateValid: true }, stale: false })
  const service = new BrowserGatewayService({
    capability,
    executor: async () => result === 'succeeded'
      ? { status: 'succeeded', result: { text: 'Adapter content' }, evidence: [{ type: 'page-snapshot', status: 'verified', content: { text: 'Adapter content' } }], artifacts: [{ kind: 'page-extract', version: 1, sourceRefs: [], contentRef: 'object:adapter-page', summary: 'Adapter extract', status: 'available' }] }
      : { status: 'unknown', externalEffect: 'possible', error: { code: 'ADAPTER_DISCONNECTED', message: 'gateway disconnected' } },
  })
  const adapter = new BrowserCapabilityAdapter({ service })
  const registry = new ProductCapabilityRegistry({ projectId: profile.projectId })
  adapter.register(registry)
  return { adapter, registry }
}

function registryInput() {
  return {
    capabilityId: 'browser.gateway', runId: 'run-adapter', operation: 'browser.read', input: browserAction(),
    target: { projectId: profile.projectId, host: 'allowed.adapter.test' }, idempotencyKey: 'registry-adapter-1',
  }
}

test('adapter descriptor is discoverable and registers with ProductCapabilityRegistry', () => {
  const { adapter, registry } = fixture()
  assert.equal(adapter.descriptor.kind, 'browser')
  assert.equal(adapter.descriptor.inputSchema, 'capybara.browser-action.v1')
  assert.ok(adapter.descriptor.evidenceKinds.includes('browser-dom'))
  assert.equal(registry.getDescriptor('browser.gateway')?.apiVersion, 'v2')
})

test('registry execution routes typed BrowserAction through BrowserGatewayService', async () => {
  const { registry } = fixture()
  const execution = await registry.execute(registryInput(), { authorized: true })
  assert.equal(execution.receipt?.status, 'succeeded')
  assert.equal(execution.action.status, 'succeeded')
  const output = execution.output as { browserReceipt?: { status: string }; evidence?: unknown[]; artifacts?: unknown[] }
  assert.equal(output.browserReceipt?.status, 'succeeded')
  assert.equal(output.evidence?.length, 1)
  assert.equal(output.artifacts?.length, 1)
})

test('adapter maps BrowserGateway unknown to ProductCapability unknown receipt', async () => {
  const { registry } = fixture('unknown')
  const execution = await registry.execute(registryInput(), { authorized: true })
  assert.equal(execution.receipt?.status, 'unknown')
  assert.equal(execution.action.status, 'unknown')
  assert.equal(execution.error?.code, 'ADAPTER_DISCONNECTED')
})

test('registry idempotency prevents adapter execution on a repeated input', async () => {
  const { registry } = fixture()
  const first = await registry.execute(registryInput(), { authorized: true })
  const duplicate = await registry.execute(registryInput(), { authorized: true })
  assert.equal(first.receipt?.status, 'succeeded')
  assert.equal(duplicate.admission.disposition, 'duplicate')
  assert.equal(duplicate.receipt?.id, first.receipt?.id)
})

test('descriptor rejects malformed browser action input before execution', () => {
  const { adapter } = fixture()
  assert.throws(() => adapter.descriptor.validateInput?.({ kind: 'read' } as never), /invalid browser action/)
})
