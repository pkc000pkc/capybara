import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ApplicationVersionLifecycle,
  type ApplicationManifest,
  type ApplicationVersion,
} from '#core/application-manifest'
import {
  ApplicationRuntimeService,
  InMemoryApplicationRuntimeEvidenceStore,
} from '#core/application-runtime-service'
import { ProductWorkLedger } from '#core/product-work-ledger'

function source(id: string, type: 'instruction' | 'project' = 'instruction') {
  return { projectId: 'project-runtime', type, id, relation: 'references' as const }
}

function manifest(): ApplicationManifest {
  return {
    schemaVersion: 1,
    appId: 'runtime-app',
    projectId: 'project-runtime',
    name: 'Runtime app',
    description: 'Application runtime service fixture',
    stack: { runtime: 'electron', ui: 'react', language: 'typescript', node: '22' },
    source: { conversationId: 'conversation-1', instructionId: 'instruction-1', runId: 'run-1', instructionVersion: 1 },
    pages: [{
      pageId: 'home', route: '/', title: 'Home', entry: 'src/home.tsx', layout: 'dashboard', components: [], bindings: ['project'], actions: ['refresh'],
      accessibility: { landmark: 'main', title: 'Home', keyboardOrder: ['refresh'] }, sourceRefs: [source('instruction-1')],
    }],
    dataBindings: [{
      bindingId: 'project', sourceKind: 'project', sourceRef: source('project-runtime', 'project'), query: 'project', shape: 'Project', refresh: 'on_open', freshness: 'latest_allowed', fallback: 'unknown', evidenceRefs: [],
    }],
    actions: [{
      actionId: 'refresh', label: 'Refresh', trigger: 'button', capabilityId: 'project.read', inputSchema: 'Refresh', outputKind: 'result', risk: 'read', permissionRef: 'project-read', idempotencyKey: 'refresh', confirmation: 'none', sourceRefs: [source('instruction-1')],
    }],
    permissions: [{
      permissionId: 'project-read', capabilityId: 'project.read', scope: { projectId: 'project-runtime' }, level: 'read', grantedBy: 'project_policy', grantedAt: '2026-11-07T12:00:00.000Z', evidenceRefs: [],
    }],
    assets: [], checks: [],
    versions: { currentDraft: 'v1', latestGenerated: null, latestVerified: null, latestPublished: null, previewVersionId: null, deployedVersionId: null, runningVersionId: null },
    preview: null, deployment: null,
    runtime: { status: 'stopped', previewVersionId: null, deployedVersionId: null, runningVersionId: null },
  }
}

function version(versionId: string, number: number): ApplicationVersion {
  return {
    versionId, appId: 'runtime-app', number, parentVersionId: number === 1 ? null : 'v1', stage: 'draft', manifestHash: `manifest-${versionId}`, sourceTreeHash: `source-${versionId}`, artifactHash: null,
    sourceRefs: [source('instruction-1')], diffRefs: [], checkRefs: [], previewRef: null, approvalRef: null, createdAt: '2026-11-07T12:00:00.000Z',
  }
}

function verified(lifecycle: ApplicationVersionLifecycle, id: string): void {
  lifecycle.transition(id, 'generated')
  lifecycle.transition(id, 'verified', { checksPassed: true, artifactHash: `artifact-${id}` })
}

function publish(lifecycle: ApplicationVersionLifecycle, id: string): void {
  lifecycle.transition(id, 'published', { approved: true, approvalRef: `approval-${id}` })
}

function serviceFixture() {
  const app = manifest()
  const lifecycle = new ApplicationVersionLifecycle(app, [version('v1', 1)])
  const evidence = new InMemoryApplicationRuntimeEvidenceStore(() => `evidence-${Math.random()}`)
  const ledger = new ProductWorkLedger({ projectId: app.projectId, actor: { type: 'system', id: 'runtime-test' } })
  const service = new ApplicationRuntimeService({ manifest: app, lifecycle, ledger, evidence, defaultRunId: 'runtime-run-1', now: () => '2026-11-07T12:30:00.000Z' })
  return { lifecycle, service, evidence, ledger }
}

test('runtime operations connect lifecycle pointers to ledger receipts and evidence references', () => {
  const { lifecycle, service, evidence, ledger } = serviceFixture()
  verified(lifecycle, 'v1')
  publish(lifecycle, 'v1')

  const preview = service.preview('v1')
  assert.equal(preview.ok, true)
  assert.equal(preview.receipt.status, 'succeeded')
  assert.equal(preview.action.status, 'succeeded')
  assert.equal(preview.receipt.evidenceRefs.includes(preview.evidence.evidenceId), true)
  assert.equal(preview.evidence.receiptId, preview.receipt.id)
  assert.ok(preview.evidence.sourceRefs.some(ref => ref.type === 'action' && ref.id === preview.action.id))
  assert.ok(preview.evidence.sourceRefs.some(ref => ref.type === 'receipt' && ref.id === preview.receipt.id))

  assert.equal(service.deploy('v1', { deploymentRef: 'deploy-v1' }).ok, true)
  assert.equal(service.start('v1', { instanceId: 'instance-v1', healthCheckRef: 'health-v1' }).ok, true)
  const current = service.manifest
  assert.equal(current.preview?.versionId, 'v1')
  assert.equal(current.deployment?.versionId, 'v1')
  assert.equal(current.runtime.runningVersionId, 'v1')
  assert.equal(current.versions.deployedVersionId, 'v1')
  assert.equal(current.versions.runningVersionId, 'v1')
  assert.equal(ledger.getReceipts(preview.action.id).length, 1)
  assert.equal(evidence.list({ appId: 'runtime-app' }).length, 3)
})

test('update promotes a verified candidate and rollback restores the previous running pointer', () => {
  const { lifecycle, service } = serviceFixture()
  verified(lifecycle, 'v1')
  publish(lifecycle, 'v1')
  assert.equal(service.deploy('v1').ok, true)
  assert.equal(service.start('v1').ok, true)

  lifecycle.addVersion(version('v2', 2))
  verified(lifecycle, 'v2')
  const updated = service.update({ currentVersionId: 'v1', newVersionId: 'v2', approvalRef: 'approve-v2', deploymentRef: 'deploy-v2', instanceId: 'instance-v2', healthCheckRef: 'health-v2' })
  assert.equal(updated.ok, true)
  assert.equal(updated.receipt.status, 'succeeded')
  assert.equal(updated.manifest.versions.previewVersionId, 'v2')
  assert.equal(updated.manifest.versions.runningVersionId, 'v2')
  assert.equal(updated.manifest.runtime.runningVersionId, 'v2')

  lifecycle.addVersion(version('v3', 3))
  verified(lifecycle, 'v3')
  const failed = service.update({ currentVersionId: 'v2', newVersionId: 'v3', healthPassed: false, smokeCheckPassed: false })
  assert.equal(failed.ok, false)
  assert.equal(failed.receipt.status, 'failed')
  assert.equal(failed.evidence.status, 'captured')

  const rolledBack = service.rollback({ failedVersionId: 'v3', targetVersionId: 'v2', reason: 'candidate smoke check failed', healthCheckRef: 'health-v3' })
  assert.equal(rolledBack.ok, true)
  assert.equal(rolledBack.receipt.status, 'succeeded')
  assert.equal(rolledBack.manifest.versions.runningVersionId, 'v2')
  assert.equal(rolledBack.manifest.runtime.runningVersionId, 'v2')
  assert.equal(lifecycle.getVersion('v3').stage, 'rolled_back')
})

test('health failure records a failed receipt and moves the running version to error', () => {
  const { lifecycle, service } = serviceFixture()
  verified(lifecycle, 'v1')
  publish(lifecycle, 'v1')
  assert.equal(service.deploy('v1').ok, true)
  assert.equal(service.start('v1').ok, true)
  const health = service.healthCheck({ versionId: 'v1', passed: false, smokeCheckPassed: false, route: '/', message: 'route unavailable' })
  assert.equal(health.ok, false)
  assert.equal(health.receipt.status, 'failed')
  assert.equal(lifecycle.getVersion('v1').stage, 'error')
  assert.equal(health.manifest.runtime.status, 'error')
})

test('hosted runtime operations reconcile real host results into the shared ledger', async () => {
  const app = manifest()
  const lifecycle = new ApplicationVersionLifecycle(app, [version('v1', 1)])
  verified(lifecycle, 'v1')
  publish(lifecycle, 'v1')
  const evidence = new InMemoryApplicationRuntimeEvidenceStore(() => `evidence-host-${Math.random()}`)
  const ledger = new ProductWorkLedger({ projectId: app.projectId, actor: { type: 'system', id: 'runtime-host-test' } })
  const calls: string[] = []
  const service = new ApplicationRuntimeService({
    manifest: app,
    lifecycle,
    ledger,
    evidence,
    defaultRunId: 'host-run',
    now: () => '2026-11-07T12:30:00.000Z',
    host: {
      async start() { calls.push('start'); return { ok: true, instanceId: 'instance:host', processId: 123, port: 4317, health: { path: '/health' } } },
      async stop() { calls.push('stop'); return { ok: true, instanceId: 'instance:host' } },
      async healthCheck() { calls.push('health'); return { ok: true, health: { path: '/health' } } },
      async update() { calls.push('update'); return { ok: true, instanceId: 'instance:host-v2' } },
      async rollback() { calls.push('rollback'); return { ok: true, instanceId: 'instance:host-v1' } },
    },
  })
  assert.equal(service.deploy('v1').ok, true)
  const started = await service.startHosted('v1')
  assert.equal(started.ok, true)
  assert.equal(started.manifest.runtime.instanceId, 'instance:host')
  assert.equal(calls[0], 'start')
  assert.deepEqual((started.evidence.payload as { result?: { hostResult?: { port?: number } } }).result?.hostResult?.port, 4317)
  const stopped = await service.stopHosted('v1', { instanceId: 'instance:host' })
  assert.equal(stopped.ok, true)
  assert.equal(stopped.manifest.runtime.status, 'stopped')
  assert.deepEqual(calls, ['start', 'stop'])
})
