import { createHash } from 'node:crypto'

import {
  ACTION_STATUSES,
  ADMISSION_DISPOSITIONS,
  RECEIPT_STATUSES,
  type ActionStatus,
  type AdmissionDisposition,
  type ReceiptStatus,
  type SourceRef as LedgerSourceRef,
  validateSourceRef as validateLedgerSourceRef,
} from '#core/product-work-ledger'

export {
  ACTION_STATUSES,
  ADMISSION_DISPOSITIONS,
  RECEIPT_STATUSES,
} from '#core/product-work-ledger'
export type {
  ActionStatus,
  AdmissionDisposition,
  ReceiptStatus,
} from '#core/product-work-ledger'

/**
 * A reference back into the Work/Run ledger. The canonical fields come from
 * product-work-ledger (`type`, `id`, `relation`, and optional `version`).
 * `projectId` is an application-level scope assertion; the object aliases are
 * accepted while importing older catalog data and are normalised by the
 * validator.
 */
export type CanonicalApplicationSourceRef = LedgerSourceRef
export type SourceRef = Partial<LedgerSourceRef> & {
  /** Required at the application boundary even though the shared ledger scopes records separately. */
  projectId: string
  /** Legacy aliases accepted only at the application boundary. */
  kind?: string
  objectId?: string
  objectType?: string
  conversationId?: string
  instructionId?: string
  runId?: string
  path?: string
  label?: string
}

/** Runtime projection for an application action; statuses are Work Ledger values. */
export interface ApplicationActionRuntime {
  actionId: string
  status: ActionStatus
  admission?: AdmissionDisposition
  receiptStatus?: ReceiptStatus
  receiptId?: string
  sourceRefs: SourceRef[]
}

export function isActionStatus(value: unknown): value is ActionStatus {
  return typeof value === 'string' && (ACTION_STATUSES as readonly string[]).includes(value)
}

export function isReceiptStatus(value: unknown): value is ReceiptStatus {
  return typeof value === 'string' && (RECEIPT_STATUSES as readonly string[]).includes(value)
}

export function isAdmissionDisposition(value: unknown): value is AdmissionDisposition {
  return typeof value === 'string' && (ADMISSION_DISPOSITIONS as readonly string[]).includes(value)
}

export interface ComponentRef {
  componentId?: string
  id?: string
  name?: string
  sourceRefs?: SourceRef[]
  [key: string]: unknown
}

export interface PageSpec {
  pageId: string
  route: string
  title: string
  entry: string
  layout: 'document' | 'dashboard' | 'workspace'
  components: ComponentRef[]
  bindings: string[]
  actions: string[]
  accessibility: {
    landmark: string
    title: string
    keyboardOrder: string[]
  }
  /** Pages generated before sourceRefs became mandatory may omit this field. */
  sourceRefs?: SourceRef[]
}

export type DataBindingSourceKind =
  | 'project'
  | 'result'
  | 'file'
  | 'transaction'
  | 'program'
  | 'run'
  | 'memory'

export interface DataBindingSpec {
  bindingId: string
  sourceKind: DataBindingSourceKind
  sourceRef: SourceRef
  query: string
  shape: string
  refresh: 'on_open' | 'manual' | 'event' | 'schedule'
  freshness: 'latest_allowed' | 'pinned_version'
  fallback: 'empty' | 'last_confirmed' | 'unknown'
  evidenceRefs: string[]
  sourceRefs?: SourceRef[]
}

export interface ActionSpec {
  actionId: string
  label: string
  trigger: 'button' | 'form' | 'event' | 'host_toolbar'
  capabilityId: string
  inputSchema: string
  outputKind: 'result' | 'file' | 'transaction' | 'program' | 'navigation'
  risk: 'read' | 'local_write' | 'process' | 'external_side_effect'
  permissionRef: string
  idempotencyKey: string
  confirmation: 'none' | 'before_execution' | 'before_external_effect'
  sourceRefs: SourceRef[]
}

export interface PermissionSpec {
  permissionId: string
  capabilityId: string
  scope: {
    projectId: string
    paths?: string[]
    domains?: string[]
    processIds?: string[]
  }
  level: 'read' | 'write' | 'execute' | 'external'
  grantedBy: 'project_policy' | 'user_confirmation' | 'system'
  grantedAt: string
  expiresAt?: string
  evidenceRefs: string[]
  sourceRefs?: SourceRef[]
}

export interface AssetSpec {
  assetId: string
  path: string
  contentHash?: string
  sourceRefs?: SourceRef[]
  [key: string]: unknown
}

export interface CheckRef {
  checkId: string
  kind?: string
  status?: 'passed' | 'failed' | 'unknown' | string
  receiptRef?: string
  sourceRefs?: SourceRef[]
  [key: string]: unknown
}

export interface PreviewRef {
  versionId: string
  createdAt: string
  artifactHash?: string
  route?: string
  snapshotRef?: string
  [key: string]: unknown
}

export interface DeploymentRef {
  versionId: string
  deployedAt: string
  target?: string
  receiptRef?: string
  [key: string]: unknown
}

export type RuntimeStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'degraded'
  | 'error'
  | 'unknown'
  | 'updating'
  | 'rolling_back'

export interface RuntimeRef {
  status: RuntimeStatus
  previewVersionId?: string | null
  deployedVersionId?: string | null
  runningVersionId?: string | null
  instanceId?: string | null
  processId?: string | number | null
  healthCheckRef?: string
  lastError?: string
  [key: string]: unknown
}

export interface ApplicationManifest {
  schemaVersion: 1
  appId: string
  projectId: string
  name: string
  description: string
  stack: {
    runtime: 'electron' | 'node' | 'python' | 'static'
    ui: 'react' | 'vue' | 'html' | 'none'
    language: 'typescript' | 'javascript' | 'python'
    node: string
  }
  source: {
    conversationId: string
    instructionId: string
    runId: string
    instructionVersion: number
    parentVersionId?: string
  }
  pages: PageSpec[]
  dataBindings: DataBindingSpec[]
  actions: ActionSpec[]
  permissions: PermissionSpec[]
  assets: AssetSpec[]
  checks: CheckRef[]
  versions: {
    currentDraft: string | null
    latestGenerated: string | null
    latestVerified: string | null
    latestPublished: string | null
    previewVersionId?: string | null
    deployedVersionId?: string | null
    runningVersionId?: string | null
  }
  preview: PreviewRef | null
  deployment: DeploymentRef | null
  runtime: RuntimeRef
  /** Optional aggregate source refs used by catalog import/export. */
  sourceRefs?: SourceRef[]
}

/** Version stages include both build/publish stages and runtime lifecycle states. */
export type ApplicationVersionStatus =
  | 'draft'
  | 'generated'
  | 'verified'
  | 'published'
  | 'deployed'
  | 'running'
  | 'updating'
  | 'error'
  | 'rolled_back'
  | 'stopped'
  | 'starting'
  | 'degraded'
  | 'rolling_back'

/** Naming used by consumers that call the lifecycle field a stage. */
export type ApplicationVersionStage = ApplicationVersionStatus
export type VersionStatus = ApplicationVersionStatus

export interface ApplicationVersion {
  versionId: string
  appId: string
  number: number
  parentVersionId: string | null
  stage: ApplicationVersionStatus
  /** `status` is an optional compatibility alias for consumers that use runtime terminology. */
  status?: ApplicationVersionStatus
  manifestHash: string
  sourceTreeHash: string
  artifactHash: string | null
  sourceRefs: SourceRef[]
  diffRefs: string[]
  checkRefs: string[]
  previewRef: string | null
  approvalRef: string | null
  createdAt: string
  updatedAt?: string
  error?: string
  rollbackTargetVersionId?: string | null
  transitionHistory?: VersionTransitionRecord[]
}

export interface VersionTransitionRecord {
  from: ApplicationVersionStatus
  to: ApplicationVersionStatus
  at: string
  reason?: string
}

export interface VersionTransitionContext {
  /** Values used when a transition creates/attaches evidence. */
  now?: string
  manifestHash?: string
  sourceTreeHash?: string
  artifactHash?: string
  checkRefs?: string[]
  checksPassed?: boolean
  typecheckPassed?: boolean
  buildPassed?: boolean
  testsPassed?: boolean
  permissionsPassed?: boolean
  loadable?: boolean
  approvalRef?: string
  approved?: boolean
  deploymentRef?: string
  deployed?: boolean
  instanceId?: string
  healthCheckRef?: string
  healthPassed?: boolean
  smokeCheckPassed?: boolean
  newVersionId?: string
  updateAuthorized?: boolean
  rollbackTargetVersionId?: string
  rollbackReason?: string
  error?: string
  reason?: string
}

export interface ManifestValidationIssue {
  path: string
  message: string
  code: string
}

export interface ManifestValidationResult {
  valid: boolean
  issues: ManifestValidationIssue[]
  value?: ApplicationManifest
}

export class InvalidApplicationManifestError extends Error {
  readonly issues: ManifestValidationIssue[]

  constructor(issues: ManifestValidationIssue[]) {
    super(`Invalid application manifest: ${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`)
    this.name = 'InvalidApplicationManifestError'
    this.issues = issues
  }
}

export class InvalidApplicationVersionTransitionError extends Error {
  readonly versionId: string
  readonly from: ApplicationVersionStatus
  readonly to: ApplicationVersionStatus

  constructor(versionId: string, from: ApplicationVersionStatus, to: ApplicationVersionStatus, reason: string) {
    super(`Invalid application version transition ${from} -> ${to} for ${versionId}: ${reason}`)
    this.name = 'InvalidApplicationVersionTransitionError'
    this.versionId = versionId
    this.from = from
    this.to = to
  }
}

const VERSION_TRANSITIONS: Readonly<Record<ApplicationVersionStatus, readonly ApplicationVersionStatus[]>> = {
  draft: ['generated', 'error'],
  generated: ['verified', 'draft', 'error'],
  verified: ['published', 'generated', 'error'],
  published: ['deployed', 'error'],
  deployed: ['running', 'error', 'updating'],
  running: ['updating', 'stopped', 'degraded', 'error'],
  updating: ['deployed', 'running', 'error', 'rolled_back'],
  error: ['rolled_back', 'running', 'stopped'],
  rolled_back: ['running', 'stopped'],
  stopped: ['starting', 'error'],
  starting: ['running', 'error'],
  degraded: ['running', 'updating', 'error', 'stopped'],
  rolling_back: ['rolled_back', 'error'],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => isNonEmptyString(item))
}

function addIssue(issues: ManifestValidationIssue[], path: string, message: string, code: string): void {
  issues.push({ path, message, code })
}

function uniqueIds(
  values: unknown,
  path: string,
  idField: string,
  issues: ManifestValidationIssue[],
): Set<string> {
  const ids = new Set<string>()
  if (!Array.isArray(values)) {
    addIssue(issues, path, 'must be an array', 'type')
    return ids
  }
  values.forEach((item, index) => {
    if (!isRecord(item)) {
      addIssue(issues, `${path}[${index}]`, 'must be an object', 'type')
      return
    }
    const id = item[idField]
    if (!isNonEmptyString(id)) {
      addIssue(issues, `${path}[${index}].${idField}`, 'must be a non-empty string', 'required')
      return
    }
    if (ids.has(id)) addIssue(issues, `${path}[${index}].${idField}`, `duplicates ${id}`, 'duplicate')
    ids.add(id)
  })
  return ids
}

function sourceRefIdentity(value: unknown): { projectId: string; id: string; kind: string } | null {
  if (!isRecord(value)) return null
  const projectId = value.projectId
  const id = value.id ?? value.objectId
  const kind = value.type ?? value.kind ?? value.objectType
  if (!isNonEmptyString(projectId) || !isNonEmptyString(id) || !isNonEmptyString(kind)) return null
  return { projectId, id, kind }
}

function validateSourceRef(value: unknown, path: string, expectedProjectId: string, issues: ManifestValidationIssue[]): void {
  const identity = sourceRefIdentity(value)
  if (!identity) {
    addIssue(issues, path, 'must contain projectId, canonical type, id and relation (kind/object aliases are accepted for migration)', 'source_ref')
    return
  }
  // Let the shared Work Ledger enforce the canonical type/relation/version
  // vocabulary whenever the canonical fields are present. Legacy catalog
  // aliases still pass through the scoped checks below during migration.
  if (isRecord(value) && value.type !== undefined) {
    try {
      validateLedgerSourceRef(value, path)
    } catch (error) {
      addIssue(issues, path, error instanceof Error ? error.message : 'invalid canonical source reference', 'source_ref')
    }
  }
  if (identity.projectId !== expectedProjectId) {
    addIssue(issues, `${path}.projectId`, `must match manifest projectId ${expectedProjectId}`, 'source_project')
  }
}

function validateSourceRefs(value: unknown, path: string, expectedProjectId: string, issues: ManifestValidationIssue[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    addIssue(issues, path, 'must contain at least one source reference', 'source_refs')
    return
  }
  value.forEach((ref, index) => validateSourceRef(ref, `${path}[${index}]`, expectedProjectId, issues))
}

function validateIsoDate(value: unknown, path: string, issues: ManifestValidationIssue[]): void {
  if (!isNonEmptyString(value) || Number.isNaN(Date.parse(value))) {
    addIssue(issues, path, 'must be an ISO-8601 date string', 'date')
  }
}

/** Validate an unknown value against the application manifest contract. */
export function validateApplicationManifest(input: unknown): ManifestValidationResult {
  const issues: ManifestValidationIssue[] = []
  if (!isRecord(input)) return { valid: false, issues: [{ path: '$', message: 'must be an object', code: 'type' }] }
  const manifest = input as Partial<ApplicationManifest> & Record<string, unknown>
  if (manifest.schemaVersion !== 1) addIssue(issues, '$.schemaVersion', 'must equal 1', 'schema_version')
  for (const field of ['appId', 'projectId', 'name', 'description'] as const) {
    if (!isNonEmptyString(manifest[field])) addIssue(issues, `$.${field}`, 'must be a non-empty string', 'required')
  }

  const stack = manifest.stack
  if (!isRecord(stack)) {
    addIssue(issues, '$.stack', 'must be an object', 'required')
  } else {
    if (!['electron', 'node', 'python', 'static'].includes(String(stack.runtime))) addIssue(issues, '$.stack.runtime', 'must be electron, node, python or static', 'stack')
    if (!['react', 'vue', 'html', 'none'].includes(String(stack.ui))) addIssue(issues, '$.stack.ui', 'must be react, vue, html or none', 'stack')
    if (!['typescript', 'javascript', 'python'].includes(String(stack.language))) addIssue(issues, '$.stack.language', 'must be typescript, javascript or python', 'stack')
    if (!isNonEmptyString(stack.node)) addIssue(issues, '$.stack.node', 'must be a non-empty version', 'stack')
  }

  const source = manifest.source
  if (!isRecord(source)) {
    addIssue(issues, '$.source', 'must be an object', 'required')
  } else {
    for (const field of ['conversationId', 'instructionId', 'runId'] as const) {
      if (!isNonEmptyString(source[field])) addIssue(issues, `$.source.${field}`, 'must be a non-empty string', 'source')
    }
    if (!Number.isInteger(source.instructionVersion) || Number(source.instructionVersion) < 1) {
      addIssue(issues, '$.source.instructionVersion', 'must be a positive integer', 'source')
    }
    if (source.parentVersionId !== undefined && !isNonEmptyString(source.parentVersionId)) {
      addIssue(issues, '$.source.parentVersionId', 'must be a non-empty string when present', 'source')
    }
  }

  const projectId = isNonEmptyString(manifest.projectId) ? manifest.projectId : ''
  const pageIds = uniqueIds(manifest.pages, '$.pages', 'pageId', issues)
  const bindingIds = uniqueIds(manifest.dataBindings, '$.dataBindings', 'bindingId', issues)
  const actionIds = uniqueIds(manifest.actions, '$.actions', 'actionId', issues)
  const permissionIds = uniqueIds(manifest.permissions, '$.permissions', 'permissionId', issues)
  uniqueIds(manifest.assets, '$.assets', 'assetId', issues)
  uniqueIds(manifest.checks, '$.checks', 'checkId', issues)

  const routes = new Set<string>()
  if (Array.isArray(manifest.pages)) manifest.pages.forEach((page, index) => {
    const path = `$.pages[${index}]`
    if (!isRecord(page)) return
    for (const field of ['route', 'title', 'entry'] as const) {
      if (!isNonEmptyString(page[field])) addIssue(issues, `${path}.${field}`, 'must be a non-empty string', 'required')
    }
    if (!['document', 'dashboard', 'workspace'].includes(String(page.layout))) {
      addIssue(issues, `${path}.layout`, 'must be document, dashboard or workspace', 'enum')
    }
    if (!Array.isArray(page.components)) addIssue(issues, `${path}.components`, 'must be an array', 'type')
    if (!isStringArray(page.bindings)) addIssue(issues, `${path}.bindings`, 'must be a string array', 'type')
    if (!isStringArray(page.actions)) addIssue(issues, `${path}.actions`, 'must be a string array', 'type')
    const accessibility = page.accessibility
    if (!isRecord(accessibility)) {
      addIssue(issues, `${path}.accessibility`, 'must be an object', 'required')
    } else {
      for (const field of ['landmark', 'title'] as const) {
        if (!isNonEmptyString(accessibility[field])) addIssue(issues, `${path}.accessibility.${field}`, 'must be a non-empty string', 'required')
      }
      if (!isStringArray(accessibility.keyboardOrder)) addIssue(issues, `${path}.accessibility.keyboardOrder`, 'must be a string array', 'type')
    }
    const route = page.route
    if (isNonEmptyString(route)) {
      if (!route.startsWith('/')) addIssue(issues, `${path}.route`, 'must start with /', 'route')
      if (routes.has(route)) addIssue(issues, `${path}.route`, `duplicates ${route}`, 'duplicate')
      routes.add(route)
    }
    if (page.sourceRefs !== undefined) validateSourceRefs(page.sourceRefs, `${path}.sourceRefs`, projectId, issues)
    if (Array.isArray(page.bindings)) page.bindings.forEach((id, refIndex) => {
      if (!bindingIds.has(id)) addIssue(issues, `${path}.bindings[${refIndex}]`, `unknown binding ${id}`, 'reference')
    })
    if (Array.isArray(page.actions)) page.actions.forEach((id, refIndex) => {
      if (!actionIds.has(id)) addIssue(issues, `${path}.actions[${refIndex}]`, `unknown action ${id}`, 'reference')
    })
  })

  if (Array.isArray(manifest.dataBindings)) manifest.dataBindings.forEach((binding, index) => {
    const path = `$.dataBindings[${index}]`
    if (!isRecord(binding)) return
    for (const field of ['bindingId', 'query', 'shape'] as const) {
      if (!isNonEmptyString(binding[field])) addIssue(issues, `${path}.${field}`, 'must be a non-empty string', 'required')
    }
    if (!['project', 'result', 'file', 'transaction', 'program', 'run', 'memory'].includes(String(binding.sourceKind))) addIssue(issues, `${path}.sourceKind`, 'is invalid', 'enum')
    validateSourceRef(binding.sourceRef, `${path}.sourceRef`, projectId, issues)
    if (!['on_open', 'manual', 'event', 'schedule'].includes(String(binding.refresh))) addIssue(issues, `${path}.refresh`, 'is invalid', 'enum')
    if (!['latest_allowed', 'pinned_version'].includes(String(binding.freshness))) addIssue(issues, `${path}.freshness`, 'is invalid', 'enum')
    if (!['empty', 'last_confirmed', 'unknown'].includes(String(binding.fallback))) addIssue(issues, `${path}.fallback`, 'is invalid', 'enum')
    if (!isStringArray(binding.evidenceRefs)) addIssue(issues, `${path}.evidenceRefs`, 'must be a string array', 'type')
    if (binding.sourceRefs !== undefined) validateSourceRefs(binding.sourceRefs, `${path}.sourceRefs`, projectId, issues)
  })

  if (Array.isArray(manifest.actions)) manifest.actions.forEach((action, index) => {
    const path = `$.actions[${index}]`
    if (!isRecord(action)) return
    for (const field of ['actionId', 'label', 'capabilityId', 'inputSchema', 'permissionRef', 'idempotencyKey'] as const) {
      if (!isNonEmptyString(action[field])) addIssue(issues, `${path}.${field}`, 'must be a non-empty string', 'required')
    }
    if (!['button', 'form', 'event', 'host_toolbar'].includes(String(action.trigger))) addIssue(issues, `${path}.trigger`, 'is invalid', 'enum')
    if (!['result', 'file', 'transaction', 'program', 'navigation'].includes(String(action.outputKind))) addIssue(issues, `${path}.outputKind`, 'is invalid', 'enum')
    if (!['read', 'local_write', 'process', 'external_side_effect'].includes(String(action.risk))) addIssue(issues, `${path}.risk`, 'is invalid', 'enum')
    if (!['none', 'before_execution', 'before_external_effect'].includes(String(action.confirmation))) addIssue(issues, `${path}.confirmation`, 'is invalid', 'enum')
    if (action.risk === 'process' && action.confirmation === 'none') addIssue(issues, `${path}.confirmation`, 'process actions require confirmation before execution', 'confirmation')
    if (action.risk === 'external_side_effect' && action.confirmation !== 'before_external_effect') addIssue(issues, `${path}.confirmation`, 'external side effects require confirmation before the external effect', 'confirmation')
    if (!permissionIds.has(String(action.permissionRef))) addIssue(issues, `${path}.permissionRef`, `unknown permission ${String(action.permissionRef)}`, 'reference')
    validateSourceRefs(action.sourceRefs, `${path}.sourceRefs`, projectId, issues)
  })

  if (Array.isArray(manifest.permissions)) manifest.permissions.forEach((permission, index) => {
    const path = `$.permissions[${index}]`
    if (!isRecord(permission)) return
    for (const field of ['permissionId', 'capabilityId', 'grantedAt'] as const) {
      if (!isNonEmptyString(permission[field])) addIssue(issues, `${path}.${field}`, 'must be a non-empty string', 'required')
    }
    const scope = permission.scope
    if (!isRecord(scope)) {
      addIssue(issues, `${path}.scope`, 'must be an object', 'required')
    } else {
      if (scope.projectId !== projectId) addIssue(issues, `${path}.scope.projectId`, `must match manifest projectId ${projectId}`, 'scope')
      for (const field of ['paths', 'domains', 'processIds'] as const) {
        if (scope[field] !== undefined && !isStringArray(scope[field])) addIssue(issues, `${path}.scope.${field}`, 'must be a string array', 'type')
      }
    }
    if (!['read', 'write', 'execute', 'external'].includes(String(permission.level))) addIssue(issues, `${path}.level`, 'is invalid', 'enum')
    if (!['project_policy', 'user_confirmation', 'system'].includes(String(permission.grantedBy))) addIssue(issues, `${path}.grantedBy`, 'is invalid', 'enum')
    validateIsoDate(permission.grantedAt, `${path}.grantedAt`, issues)
    if (permission.expiresAt !== undefined) validateIsoDate(permission.expiresAt, `${path}.expiresAt`, issues)
    if (!isStringArray(permission.evidenceRefs)) addIssue(issues, `${path}.evidenceRefs`, 'must be a string array', 'type')
    if (permission.sourceRefs !== undefined) validateSourceRefs(permission.sourceRefs, `${path}.sourceRefs`, projectId, issues)
  })

  const versions = manifest.versions
  if (!isRecord(versions)) {
    addIssue(issues, '$.versions', 'must be an object', 'required')
  } else {
    for (const field of ['currentDraft', 'latestGenerated', 'latestVerified', 'latestPublished'] as const) {
      if (versions[field] !== null && !isNonEmptyString(versions[field])) addIssue(issues, `$.versions.${field}`, 'must be a string or null', 'pointer')
    }
    for (const field of ['previewVersionId', 'deployedVersionId', 'runningVersionId'] as const) {
      if (versions[field] !== undefined && versions[field] !== null && !isNonEmptyString(versions[field])) addIssue(issues, `$.versions.${field}`, 'must be a string or null', 'pointer')
    }
  }

  const preview = manifest.preview
  if (preview !== null && !isRecord(preview)) addIssue(issues, '$.preview', 'must be an object or null', 'type')
  else if (isRecord(preview)) {
    if (!isNonEmptyString(preview.versionId)) addIssue(issues, '$.preview.versionId', 'must be a non-empty string', 'pointer')
    validateIsoDate(preview.createdAt, '$.preview.createdAt', issues)
  }
  const deployment = manifest.deployment
  if (deployment !== null && !isRecord(deployment)) addIssue(issues, '$.deployment', 'must be an object or null', 'type')
  else if (isRecord(deployment)) {
    if (!isNonEmptyString(deployment.versionId)) addIssue(issues, '$.deployment.versionId', 'must be a non-empty string', 'pointer')
    validateIsoDate(deployment.deployedAt, '$.deployment.deployedAt', issues)
  }
  if (!isRecord(manifest.runtime)) {
    addIssue(issues, '$.runtime', 'must be an object', 'required')
  } else {
    const runtime = manifest.runtime
    if (!['stopped', 'starting', 'running', 'degraded', 'error', 'unknown', 'updating', 'rolling_back'].includes(String(runtime.status))) addIssue(issues, '$.runtime.status', 'is invalid', 'enum')
    for (const field of ['previewVersionId', 'deployedVersionId', 'runningVersionId'] as const) {
      if (runtime[field] !== undefined && runtime[field] !== null && !isNonEmptyString(runtime[field])) addIssue(issues, `$.runtime.${field}`, 'must be a string or null', 'pointer')
    }
    if (runtime.status === 'running' && !isNonEmptyString(runtime.runningVersionId)) addIssue(issues, '$.runtime.runningVersionId', 'is required while runtime is running', 'runtime_pointer')
  }

  if (isRecord(versions)) {
    if (isRecord(preview) && versions.previewVersionId !== undefined && preview.versionId !== versions.previewVersionId) addIssue(issues, '$.preview.versionId', 'must match versions.previewVersionId', 'pointer_mismatch')
    if (isRecord(deployment) && versions.deployedVersionId !== undefined && deployment.versionId !== versions.deployedVersionId) addIssue(issues, '$.deployment.versionId', 'must match versions.deployedVersionId', 'pointer_mismatch')
    if (isRecord(manifest.runtime)) {
      for (const field of ['previewVersionId', 'deployedVersionId', 'runningVersionId'] as const) {
        if (manifest.runtime[field] !== undefined && manifest.runtime[field] !== versions[field]) addIssue(issues, `$.runtime.${field}`, `must match versions.${field}`, 'pointer_mismatch')
      }
    }
  }

  if (manifest.sourceRefs !== undefined) validateSourceRefs(manifest.sourceRefs, '$.sourceRefs', projectId, issues)
  return issues.length === 0
    ? { valid: true, issues: [], value: input as unknown as ApplicationManifest }
    : { valid: false, issues }
}

export function assertValidApplicationManifest(input: unknown): asserts input is ApplicationManifest {
  const result = validateApplicationManifest(input)
  if (!result.valid) throw new InvalidApplicationManifestError(result.issues)
}

export function parseApplicationManifest(input: unknown): ApplicationManifest {
  assertValidApplicationManifest(input)
  return input
}

export function isValidApplicationManifest(input: unknown): input is ApplicationManifest {
  return validateApplicationManifest(input).valid
}

/** Stable enough for local manifest/artifact identity; object keys are sorted recursively. */
export function hashApplicationManifest(manifest: ApplicationManifest): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable)
    if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
    return value
  }
  return createHash('sha256').update(JSON.stringify(stable(manifest))).digest('hex')
}

function hasPassedChecks(context: VersionTransitionContext): boolean {
  if (context.checksPassed === true) return true
  return context.typecheckPassed === true
    && context.buildPassed === true
    && context.testsPassed === true
    && context.permissionsPassed === true
    && context.loadable === true
}

function transitionGuard(version: ApplicationVersion, to: ApplicationVersionStatus, context: VersionTransitionContext): string | null {
  const from = version.stage
  if (!(VERSION_TRANSITIONS[from] ?? []).includes(to)) return `transition is not allowed`
  switch (`${from}->${to}`) {
    case 'draft->generated':
      if (!isNonEmptyString(version.manifestHash) && !isNonEmptyString(context.manifestHash)) return 'manifest hash is required'
      if (!isNonEmptyString(version.sourceTreeHash) && !isNonEmptyString(context.sourceTreeHash)) return 'source tree hash is required'
      if (version.sourceRefs.length === 0) return 'at least one source reference is required'
      return null
    case 'generated->verified':
      return hasPassedChecks(context) || version.checkRefs.length > 0 ? null : 'typecheck, build, test, permission and loadable checks must pass'
    case 'verified->published':
      return context.approved === true || isNonEmptyString(context.approvalRef) || isNonEmptyString(version.approvalRef) ? null : 'user approval is required'
    case 'published->deployed':
      return context.deployed === true || isNonEmptyString(context.deploymentRef) ? null : 'deployment receipt is required'
    case 'deployed->running':
    case 'starting->running':
      return (context.healthPassed === true && context.smokeCheckPassed !== false) || isNonEmptyString(context.healthCheckRef) ? null : 'health and smoke checks must pass'
    case 'running->updating':
    case 'deployed->updating':
    case 'degraded->updating':
      return (context.updateAuthorized === true || isNonEmptyString(context.newVersionId)) ? null : 'an authorised verified update is required'
    case 'updating->deployed':
      return context.healthPassed === true && context.smokeCheckPassed !== false ? null : 'updated instance health checks must pass'
    case 'updating->running':
      return context.healthPassed === true && context.smokeCheckPassed !== false ? null : 'updated instance health checks must pass'
    case 'updating->rolled_back':
    case 'error->rolled_back':
    case 'rolling_back->rolled_back':
      return isNonEmptyString(context.rollbackTargetVersionId) && isNonEmptyString(context.rollbackReason) ? null : 'rollback target and reason are required'
    default:
      return null
  }
}

/** Return whether a version can make a guarded lifecycle transition. */
export function canTransitionApplicationVersion(
  version: ApplicationVersion,
  to: ApplicationVersionStatus,
  context: VersionTransitionContext = {},
): boolean {
  return transitionGuard(version, to, context) === null
}

/**
 * Transition a version immutably.  Every transition is guarded and appended to
 * transitionHistory so an application host can persist it in its Run Ledger.
 */
export function transitionApplicationVersion(
  version: ApplicationVersion,
  to: ApplicationVersionStatus,
  context: VersionTransitionContext = {},
): ApplicationVersion {
  const reason = transitionGuard(version, to, context)
  if (reason) throw new InvalidApplicationVersionTransitionError(version.versionId, version.stage, to, reason)
  const now = context.now ?? new Date().toISOString()
  const next: ApplicationVersion = {
    ...version,
    stage: to,
    ...(version.status !== undefined ? { status: to } : {}),
    updatedAt: now,
    transitionHistory: [...(version.transitionHistory ?? []), { from: version.stage, to, at: now, ...(context.reason ? { reason: context.reason } : {}) }],
  }
  if (context.manifestHash) next.manifestHash = context.manifestHash
  if (context.sourceTreeHash) next.sourceTreeHash = context.sourceTreeHash
  if (context.artifactHash) next.artifactHash = context.artifactHash
  if (context.approvalRef) next.approvalRef = context.approvalRef
  if (context.checkRefs) next.checkRefs = [...context.checkRefs]
  if (context.error) next.error = context.error
  if (context.rollbackTargetVersionId) next.rollbackTargetVersionId = context.rollbackTargetVersionId
  return next
}

export interface ApplicationVersionStoreState {
  manifest: ApplicationManifest
  versions: ApplicationVersion[]
}

/**
 * Small in-memory lifecycle adapter. Persistence, Run Ledger receipts and
 * Supervisor integration remain explicit integration points for Stage 1/2/5.
 */
export class ApplicationVersionLifecycle {
  private readonly versionMap: Map<string, ApplicationVersion>
  private currentManifest: ApplicationManifest

  constructor(manifest: ApplicationManifest, versions: readonly ApplicationVersion[] = []) {
    assertValidApplicationManifest(manifest)
    this.currentManifest = structuredClone(manifest)
    this.versionMap = new Map()
    for (const version of versions) {
      if (version.appId !== manifest.appId) throw new Error(`Version ${version.versionId} belongs to ${version.appId}, not ${manifest.appId}`)
      if (this.versionMap.has(version.versionId)) throw new Error(`Duplicate application version ${version.versionId}`)
      this.versionMap.set(version.versionId, structuredClone(version))
    }
  }

  get manifest(): ApplicationManifest {
    return structuredClone(this.currentManifest)
  }

  get versions(): ApplicationVersion[] {
    return [...this.versionMap.values()].map(version => structuredClone(version))
  }

  getVersion(versionId: string): ApplicationVersion {
    const version = this.versionMap.get(versionId)
    if (!version) throw new Error(`Unknown application version ${versionId}`)
    return structuredClone(version)
  }

  addVersion(version: ApplicationVersion): void {
    if (version.appId !== this.currentManifest.appId) throw new Error(`Version ${version.versionId} belongs to another application`)
    if (this.versionMap.has(version.versionId)) throw new Error(`Duplicate application version ${version.versionId}`)
    this.versionMap.set(version.versionId, structuredClone(version))
  }

  transition(versionId: string, to: ApplicationVersionStatus, context: VersionTransitionContext = {}): ApplicationVersion {
    const current = this.versionMap.get(versionId)
    if (!current) throw new Error(`Unknown application version ${versionId}`)
    if (to === 'updating' && context.newVersionId !== undefined) {
      const candidate = this.versionMap.get(context.newVersionId)
      if (!candidate) {
        throw new InvalidApplicationVersionTransitionError(versionId, current.stage, to, `verified update ${context.newVersionId} does not exist`)
      }
      if (candidate.stage !== 'verified') {
        throw new InvalidApplicationVersionTransitionError(versionId, current.stage, to, `update ${context.newVersionId} must be verified before updating`)
      }
    }
    if ((to === 'rolled_back' || to === 'rolling_back') && context.rollbackTargetVersionId !== undefined) {
      if (!this.versionMap.has(context.rollbackTargetVersionId)) {
        throw new InvalidApplicationVersionTransitionError(versionId, current.stage, to, `rollback target ${context.rollbackTargetVersionId} does not exist`)
      }
    }
    const next = transitionApplicationVersion(current, to, context)
    this.versionMap.set(versionId, next)
    this.updatePointers(next, context)
    return structuredClone(next)
  }

  setPreviewVersion(versionId: string | null, createdAt = new Date().toISOString()): void {
    if (versionId !== null && !this.versionMap.has(versionId)) throw new Error(`Unknown application version ${versionId}`)
    this.currentManifest = {
      ...this.currentManifest,
      preview: versionId === null ? null : { versionId, createdAt },
      versions: { ...this.currentManifest.versions, previewVersionId: versionId },
      runtime: { ...this.currentManifest.runtime, previewVersionId: versionId },
    }
  }

  private updatePointers(version: ApplicationVersion, context: VersionTransitionContext): void {
    const versions = { ...this.currentManifest.versions }
    let preview = this.currentManifest.preview
    let deployment = this.currentManifest.deployment
    let runtime = { ...this.currentManifest.runtime }
    if (version.stage === 'draft') versions.currentDraft = version.versionId
    if (version.stage === 'generated') versions.latestGenerated = version.versionId
    if (version.stage === 'verified') versions.latestVerified = version.versionId
    if (version.stage === 'published') versions.latestPublished = version.versionId
    if (version.stage === 'deployed') {
      versions.deployedVersionId = version.versionId
      deployment = { versionId: version.versionId, deployedAt: context.now ?? new Date().toISOString(), ...(context.deploymentRef ? { receiptRef: context.deploymentRef } : {}) }
      runtime = { ...runtime, deployedVersionId: version.versionId }
    }
    if (version.stage === 'running') {
      versions.runningVersionId = version.versionId
      runtime = { ...runtime, status: 'running', runningVersionId: version.versionId, ...(context.instanceId ? { instanceId: context.instanceId } : {}), ...(context.healthCheckRef ? { healthCheckRef: context.healthCheckRef } : {}) }
    }
    if (version.stage === 'starting') runtime = { ...runtime, status: 'starting' }
    if (version.stage === 'stopped') runtime = { ...runtime, status: 'stopped', instanceId: null, processId: null }
    if (version.stage === 'degraded') runtime = { ...runtime, status: 'degraded' }
    if (version.stage === 'updating') runtime = { ...runtime, status: 'updating' }
    if (version.stage === 'error') runtime = { ...runtime, status: 'error', ...(context.error ? { lastError: context.error } : {}) }
    if (version.stage === 'rolled_back') {
      runtime = { ...runtime, status: 'rolling_back' }
      if (context.rollbackTargetVersionId) {
        versions.runningVersionId = context.rollbackTargetVersionId
        runtime = { ...runtime, runningVersionId: context.rollbackTargetVersionId }
      }
    }
    this.currentManifest = { ...this.currentManifest, versions, preview, deployment, runtime }
  }
}
