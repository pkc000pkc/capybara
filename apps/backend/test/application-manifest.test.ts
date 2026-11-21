import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ApplicationVersionLifecycle,
  InvalidApplicationManifestError,
  InvalidApplicationVersionTransitionError,
  isActionStatus,
  isAdmissionDisposition,
  isReceiptStatus,
  type ApplicationManifest,
  type ApplicationVersion,
  type SourceRef,
  assertValidApplicationManifest,
  isValidApplicationManifest,
  transitionApplicationVersion,
  validateApplicationManifest,
} from '#core/application-manifest'
import {
  type SourceRef as LedgerSourceRef,
} from '#core/product-work-ledger'

const source = (id: string, kind: SourceRef['type'] = 'instruction'): SourceRef => ({
  projectId: 'project-1',
  type: kind,
  id,
  relation: 'references',
})

function manifest(): ApplicationManifest {
  return {
    schemaVersion: 1,
    appId: 'app-travel',
    projectId: 'project-1',
    name: 'Travel workspace',
    description: 'A typed project application',
    stack: { runtime: 'electron', ui: 'react', language: 'typescript', node: '22' },
    source: { conversationId: 'conversation-1', instructionId: 'instruction-1', runId: 'run-1', instructionVersion: 1 },
    pages: [{
      pageId: 'home',
      route: '/',
      title: 'Home',
      entry: 'src/pages/home.tsx',
      layout: 'dashboard',
      components: [],
      bindings: ['project-data'],
      actions: ['refresh'],
      accessibility: { landmark: 'main', title: 'Travel workspace', keyboardOrder: ['refresh'] },
      sourceRefs: [source('instruction-1')],
    }],
    dataBindings: [{
      bindingId: 'project-data',
      sourceKind: 'project',
      sourceRef: source('project-1', 'project'),
      query: 'project.travel',
      shape: 'TravelProject',
      refresh: 'on_open',
      freshness: 'latest_allowed',
      fallback: 'unknown',
      evidenceRefs: ['evidence-1'],
    }],
    actions: [{
      actionId: 'refresh',
      label: 'Refresh',
      trigger: 'button',
      capabilityId: 'project.read',
      inputSchema: 'RefreshInput',
      outputKind: 'result',
      risk: 'read',
      permissionRef: 'read-project',
      idempotencyKey: 'refresh-project',
      confirmation: 'none',
      sourceRefs: [source('instruction-1')],
    }],
    permissions: [{
      permissionId: 'read-project',
      capabilityId: 'project.read',
      scope: { projectId: 'project-1' },
      level: 'read',
      grantedBy: 'project_policy',
      grantedAt: '2026-11-06T12:00:00.000Z',
      evidenceRefs: ['evidence-1'],
    }],
    assets: [],
    checks: [],
    versions: {
      currentDraft: 'v1',
      latestGenerated: null,
      latestVerified: null,
      latestPublished: null,
      previewVersionId: null,
      deployedVersionId: null,
      runningVersionId: null,
    },
    preview: null,
    deployment: null,
    runtime: {
      status: 'stopped',
      previewVersionId: null,
      deployedVersionId: null,
      runningVersionId: null,
    },
  }
}

function version(stage: ApplicationVersion['stage'] = 'draft'): ApplicationVersion {
  return {
    versionId: 'v1',
    appId: 'app-travel',
    number: 1,
    parentVersionId: null,
    stage,
    manifestHash: 'manifest-hash',
    sourceTreeHash: 'source-hash',
    artifactHash: null,
    sourceRefs: [source('instruction-1')],
    diffRefs: [],
    checkRefs: [],
    previewRef: null,
    approvalRef: null,
    createdAt: '2026-11-06T12:00:00.000Z',
  }
}

test('validates manifest stack, source refs, cross-object references, and runtime pointers', () => {
  const result = validateApplicationManifest(manifest())
  assert.equal(result.valid, true)
  assert.deepEqual(result.issues, [])
  assert.equal(isValidApplicationManifest(manifest()), true)
  assert.doesNotThrow(() => assertValidApplicationManifest(manifest()))
})

test('rejects missing source refs, duplicate routes, unknown page refs, and scope mismatch', () => {
  const invalid = structuredClone(manifest())
  invalid.pages.push({ ...invalid.pages[0]!, pageId: 'second', sourceRefs: undefined })
  invalid.pages[1]!.route = '/'
  invalid.pages[1]!.bindings = ['missing-binding']
  invalid.actions[0]!.sourceRefs = [{ projectId: 'another-project', id: 'x', type: 'instruction', relation: 'references' }]
  invalid.permissions[0]!.scope.projectId = 'another-project'
  const result = validateApplicationManifest(invalid)
  assert.equal(result.valid, false)
  assert.ok(result.issues.some(issue => issue.code === 'duplicate'))
  assert.ok(result.issues.some(issue => issue.code === 'reference'))
  assert.ok(result.issues.some(issue => issue.code === 'source_project'))
  assert.ok(result.issues.some(issue => issue.code === 'scope'))
  assert.throws(() => assertValidApplicationManifest(invalid), InvalidApplicationManifestError)
})

test('version lifecycle enforces guarded draft through running transitions', () => {
  const draft = version()
  const generated = transitionApplicationVersion(draft, 'generated')
  const verified = transitionApplicationVersion(generated, 'verified', { checksPassed: true, artifactHash: 'artifact-v1' })
  const published = transitionApplicationVersion(verified, 'published', { approved: true, approvalRef: 'approval-1' })
  const deployed = transitionApplicationVersion(published, 'deployed', { deployed: true, deploymentRef: 'publish-receipt-1' })
  const running = transitionApplicationVersion(deployed, 'running', { healthPassed: true, smokeCheckPassed: true, healthCheckRef: 'health-1' })
  assert.deepEqual([generated.stage, verified.stage, published.stage, deployed.stage, running.stage], ['generated', 'verified', 'published', 'deployed', 'running'])
  assert.equal(running.artifactHash, 'artifact-v1')
  assert.equal(running.transitionHistory?.length, 5)
})

test('rejects illegal transitions and records update failure as rollback evidence', () => {
  assert.throws(
    () => transitionApplicationVersion(version(), 'published'),
    InvalidApplicationVersionTransitionError,
  )
  const running = transitionApplicationVersion(
    transitionApplicationVersion(
      transitionApplicationVersion(
        transitionApplicationVersion(version(), 'generated'),
        'verified',
        { checksPassed: true },
      ),
      'published',
      { approved: true },
    ),
    'deployed',
    { deployed: true },
  )
  const live = transitionApplicationVersion(running, 'running', { healthPassed: true })
  const updating = transitionApplicationVersion(live, 'updating', { newVersionId: 'v2' })
  const rolledBack = transitionApplicationVersion(updating, 'rolled_back', {
    rollbackTargetVersionId: 'v1',
    rollbackReason: 'new instance failed smoke check',
  })
  assert.equal(rolledBack.stage, 'rolled_back')
  assert.equal(rolledBack.rollbackTargetVersionId, 'v1')
})

test('keeps preview, deployed, and running pointers separate', () => {
  const app = manifest()
  const lifecycle = new ApplicationVersionLifecycle(app, [version()])
  lifecycle.setPreviewVersion('v1', '2026-11-06T13:00:00.000Z')
  const previewed = lifecycle.manifest
  assert.equal(previewed.preview?.versionId, 'v1')
  assert.equal(previewed.versions.previewVersionId, 'v1')
  assert.equal(previewed.versions.deployedVersionId, null)
  assert.equal(previewed.versions.runningVersionId, null)
  assert.equal(previewed.runtime.previewVersionId, 'v1')
  assert.equal(previewed.runtime.runningVersionId, null)
})

test('uses canonical Work Ledger SourceRef and shared action, receipt, and admission vocabularies', () => {
  const ledgerRef: LedgerSourceRef = { type: 'run', id: 'run-1', relation: 'references', version: 1 }
  const applicationRef: SourceRef = { ...ledgerRef, projectId: 'project-1' }
  const candidate = structuredClone(manifest())
  candidate.dataBindings[0]!.sourceRef = applicationRef
  assert.equal(validateApplicationManifest(candidate).valid, true)
  assert.equal(isActionStatus('admitted'), true)
  assert.equal(isReceiptStatus('unknown'), true)
  assert.equal(isAdmissionDisposition('duplicate'), true)
  assert.equal(isActionStatus('pending'), false)
})
