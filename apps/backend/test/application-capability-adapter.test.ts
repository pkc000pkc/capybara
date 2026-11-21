import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ApplicationRuntimeCapabilityAdapter,
  applicationRuntimeCapabilityDescriptor,
  validateApplicationRuntimeCapabilityInput,
  type ApplicationRuntimeCapabilityInput,
  type ApplicationRuntimeCapabilityOutput,
} from '#core/application-capability-adapter'
import { ApplicationVersionLifecycle, type ApplicationManifest, type ApplicationVersion } from '#core/application-manifest'
import { ApplicationRuntimeService } from '#core/application-runtime-service'
import { ProductCapabilityRegistry } from '#core/product-capability-registry'
import { ProductWorkLedger } from '#core/product-work-ledger'

const source = (id: string, type: 'instruction' | 'project' = 'instruction') => ({ projectId: 'adapter-project', type, id, relation: 'references' as const })

function manifest(): ApplicationManifest {
  return {
    schemaVersion: 1, appId: 'adapter-app', projectId: 'adapter-project', name: 'Adapter app', description: 'Capability adapter fixture',
    stack: { runtime: 'electron', ui: 'react', language: 'typescript', node: '22' },
    source: { conversationId: 'conversation-1', instructionId: 'instruction-1', runId: 'run-1', instructionVersion: 1 },
    pages: [{ pageId: 'home', route: '/', title: 'Home', entry: 'src/home.tsx', layout: 'dashboard', components: [], bindings: ['project'], actions: ['refresh'], accessibility: { landmark: 'main', title: 'Home', keyboardOrder: ['refresh'] }, sourceRefs: [source('instruction-1')] }],
    dataBindings: [{ bindingId: 'project', sourceKind: 'project', sourceRef: source('adapter-project', 'project'), query: 'project', shape: 'Project', refresh: 'on_open', freshness: 'latest_allowed', fallback: 'unknown', evidenceRefs: [] }],
    actions: [{ actionId: 'refresh', label: 'Refresh', trigger: 'button', capabilityId: 'project.read', inputSchema: 'Refresh', outputKind: 'result', risk: 'read', permissionRef: 'read-project', idempotencyKey: 'refresh', confirmation: 'none', sourceRefs: [source('instruction-1')] }],
    permissions: [{ permissionId: 'read-project', capabilityId: 'project.read', scope: { projectId: 'adapter-project' }, level: 'read', grantedBy: 'project_policy', grantedAt: '2026-11-07T12:00:00.000Z', evidenceRefs: [] }],
    assets: [], checks: [], versions: { currentDraft: 'v1', latestGenerated: null, latestVerified: null, latestPublished: null, previewVersionId: null, deployedVersionId: null, runningVersionId: null }, preview: null, deployment: null,
    runtime: { status: 'stopped', previewVersionId: null, deployedVersionId: null, runningVersionId: null },
  }
}

function version(): ApplicationVersion {
  return { versionId: 'v1', appId: 'adapter-app', number: 1, parentVersionId: null, stage: 'draft', manifestHash: 'manifest-v1', sourceTreeHash: 'source-v1', artifactHash: null, sourceRefs: [source('instruction-1')], diffRefs: [], checkRefs: [], previewRef: null, approvalRef: null, createdAt: '2026-11-07T12:00:00.000Z' }
}

test('descriptor registers and executes typed runtime operations through ProductCapabilityRegistry', async () => {
  const app = manifest()
  const ledger = new ProductWorkLedger({ projectId: app.projectId, actor: { type: 'system', id: 'adapter-test' } })
  const lifecycle = new ApplicationVersionLifecycle(app, [version()])
  const service = new ApplicationRuntimeService({ manifest: app, lifecycle, ledger, defaultRunId: 'adapter-run', now: () => '2026-11-07T12:30:00.000Z' })
  const adapter = new ApplicationRuntimeCapabilityAdapter(service)
  const registry = new ProductCapabilityRegistry({ ledger, actor: { type: 'system', id: 'registry-test' } })
  const registered = registry.register(adapter.descriptor, adapter)

  assert.equal(registered.descriptor.id, 'application-runtime')
  assert.equal(registered.descriptor.kind, 'application-runtime')
  assert.deepEqual(registered.descriptor.scope.projectIds, ['adapter-project'])
  assert.equal(registry.getDescriptor('application-runtime')?.outputSchema, 'ApplicationRuntimeActionResult')

  const action = registry.createAction<ApplicationRuntimeCapabilityInput>('application-runtime', {
    capabilityId: 'application-runtime', runId: 'adapter-run', operation: 'preview', input: { operation: 'preview', versionId: 'v1' },
    target: { projectId: 'adapter-project', objectId: 'adapter-app' }, idempotencyKey: 'adapter-preview-1', projectId: 'adapter-project',
    sourceRefs: [{ type: 'instruction', id: 'instruction-1', relation: 'references' }],
  })
  const execution = await registry.executeAction<ApplicationRuntimeCapabilityInput, ApplicationRuntimeCapabilityOutput>(action, { preAuthorized: true, projectId: 'adapter-project', scopeAllowed: true })
  assert.equal(execution.receipt?.status, 'succeeded')
  assert.ok(execution.output)
  assert.equal(execution.output?.operation, 'preview')
  assert.equal(execution.output?.receipt.status, 'succeeded')
  assert.equal(execution.output?.action.status, 'succeeded')
  assert.equal(execution.output?.manifest.preview?.versionId, 'v1')
  assert.ok(execution.receipt?.evidenceRefs.includes(execution.output!.evidence.evidenceId))
})

test('descriptor validation rejects unknown operations and missing operation-specific fields', () => {
  assert.doesNotThrow(() => validateApplicationRuntimeCapabilityInput({ operation: 'preview', versionId: 'v1' }))
  assert.throws(() => validateApplicationRuntimeCapabilityInput({ operation: 'unknown', versionId: 'v1' }), /operation is invalid/)
  assert.throws(() => validateApplicationRuntimeCapabilityInput({ operation: 'rollback', versionId: 'v1', reason: 'failed' }), /targetVersionId/)
  const descriptor = applicationRuntimeCapabilityDescriptor('adapter-project', 'adapter-app')
  const validate = descriptor.validateInput as (value: unknown) => void
  assert.throws(() => validate({ operation: 'update', currentVersionId: 'v1', newVersionId: 2, versionId: 'v2' }), /newVersionId/)
})
