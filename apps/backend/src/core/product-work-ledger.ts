import { createHash, randomUUID } from 'node:crypto'

/**
 * Stage 0–2 product-work protocol primitives.
 *
 * This module intentionally keeps storage in memory.  It is a small, strict
 * implementation of the protocol boundary that can later be backed by the
 * project database without changing Action/Receipt semantics.
 */

export const SOURCE_REF_TYPES = [
  'project', 'agent', 'goal', 'workItem', 'run', 'instruction', 'capability',
  'action', 'receipt', 'artifact', 'checkpoint', 'session', 'file', 'page',
  'program', 'transaction', 'evidence',
] as const
export type SourceRefType = typeof SOURCE_REF_TYPES[number]

export const SOURCE_REF_RELATIONS = [
  'created-by', 'constrained-by', 'planned-from', 'executed-by',
  'produced-by', 'verified-by', 'continued-from', 'supersedes', 'references',
] as const
export type SourceRefRelation = typeof SOURCE_REF_RELATIONS[number]

export type SourceRef = {
  type: SourceRefType
  id: string
  version?: number
  relation: SourceRefRelation
}

export type ActorType = 'human' | 'agent' | 'system' | 'capability-adapter'
export type ActorRef = { type: ActorType; id: string }
export type Truth = 'live' | 'demo' | 'imported'
export type PermissionLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4'
export type Risk =
  | 'read'
  | 'reversible-write'
  | 'execution'
  | 'external-side-effect'
  | 'destructive'

export type OpenQuestion = {
  id: string
  prompt: string
  blocking: boolean
  answerRef?: string
}

export type RecordEnvelope = {
  id: string
  type: string
  projectId: string
  createdAt: string
  updatedAt: string
  status: string
  version: number
  parentId?: string
  sourceRefs: SourceRef[]
  actor: ActorRef
  truth: Truth
}

export type PermissionRequest = {
  level: PermissionLevel
  actorId: string
  projectId: string
  capabilityId: string
  operation: string
  targetSummary: string
  scope: { paths?: string[]; hosts?: string[]; objects?: string[] }
  reason: string
  expectedSideEffect: string
  expiresAt?: string
  authorizationRef?: string
}

/** Shared runtime values. Keep these arrays as the source for cross-module checks. */
export const ACTION_STATUSES = [
  'proposed',
  'awaiting_authorization',
  'admitted',
  'running',
  'succeeded',
  'failed',
  'unknown',
  'cancelled',
  'skipped',
  'rejected',
] as const
export type ActionStatus = typeof ACTION_STATUSES[number]

export type CapabilityState = 'registered' | 'available' | 'restricted' | 'disabled' | 'deprecated'
export type CapabilityKind =
  | 'project-data'
  | 'file'
  | 'terminal'
  | 'browser'
  | 'program'
  | 'transaction'
  | 'application-runtime'

export type Capability = RecordEnvelope & {
  type: 'Capability'
  kind: CapabilityKind
  apiVersion: string
  inputSchema: string
  outputSchema: string
  scope: { projectIds?: string[]; paths?: string[]; hosts?: string[] }
  risk: Risk
  requiredPermission: PermissionLevel
  evidenceKinds: string[]
  state: CapabilityState
}

export type Action = RecordEnvelope & {
  type: 'Action'
  status: ActionStatus
  runId: string
  capabilityId: string
  operation: string
  arguments: unknown
  target: { projectId: string; path?: string; host?: string; objectId?: string }
  risk: Risk
  permissionRequest: PermissionRequest
  idempotencyKey: string
  timeoutMs?: number
  cancelMode: 'before-start' | 'cooperative' | 'not-supported'
}

export type CreateActionInput = Omit<Action, keyof RecordEnvelope | 'type'> & {
  actor?: ActorRef
  id?: string
  createdAt?: string
  updatedAt?: string
  version?: number
  status?: ActionStatus
  sourceRefs?: SourceRef[]
  parentId?: string
  truth?: Truth
  projectId?: string
}

export const RECEIPT_STATUSES = [
  'accepted',
  'started',
  'succeeded',
  'failed',
  'unknown',
  'cancelled',
  'not_executed',
] as const
export type ReceiptStatus = typeof RECEIPT_STATUSES[number]

export type SideEffect =
  | 'none'
  | 'local-reversible'
  | 'external-reversible'
  | 'external-irreversible'
  | 'unknown'

export type Receipt = RecordEnvelope & {
  type: 'Receipt'
  actionId: string
  status: ReceiptStatus
  adapterRunId?: string
  resultHash?: string
  outputRef?: string
  error?: { code: string; message: string; retryable: boolean }
  evidenceRefs: string[]
  sideEffect: SideEffect
  observedAt: string
  reconciledFromReceiptId?: string
}

/** Evidence is an immutable observation or verification attached to a Run/Action. */
export const EVIDENCE_STATUSES = ['captured', 'redacted', 'verified', 'expired'] as const
export type EvidenceStatus = typeof EVIDENCE_STATUSES[number]
export type EvidenceKind =
  | 'input-snapshot'
  | 'plan-snapshot'
  | 'permission'
  | 'runtime-log'
  | 'adapter-response'
  | 'file-hash'
  | 'diff'
  | 'browser-dom'
  | 'screenshot'
  | 'download'
  | 'build-log'
  | 'test-report'
  | 'external-receipt'
  | 'user-confirmation'
  | 'reconciliation'
  | (string & {})
export type Evidence = RecordEnvelope & {
  type: 'Evidence'
  runId: string
  sourceRefs: SourceRef[]
  kind: EvidenceKind
  contentRef: string
  contentHash: string
  status: EvidenceStatus
  verificationRefs: string[]
  capturedAt: string
  sourceActionId?: string
  locator?: string
  redaction: 'none' | 'partial' | 'full'
  confidence: 'asserted' | 'observed' | 'verified' | 'user-confirmed'
}

/** Artifact is a versioned, user-visible result derived from a Run/Action. */
export const ARTIFACT_STATUSES = ['produced', 'quarantined', 'available', 'accepted', 'rejected', 'expired'] as const
export type ArtifactStatus = typeof ARTIFACT_STATUSES[number]
export type Artifact = RecordEnvelope & {
  type: 'Artifact'
  runId: string
  sourceRefs: SourceRef[]
  kind: string
  contentRef: string
  contentHash: string
  status: ArtifactStatus
  verificationRefs: string[]
  version: number
  baseVersion?: number
  visibility?: 'project' | 'private' | 'shared' | 'public'
}

/** Outcome is a user-facing projection over one or more Artifacts/Receipts. */
export const OUTCOME_STATUSES = ['pending', 'verified', 'accepted', 'published', 'running', 'unknown', 'failed'] as const
export type OutcomeStatus = typeof OUTCOME_STATUSES[number]
export type Outcome = RecordEnvelope & {
  type: 'Outcome'
  runId: string
  sourceRefs: SourceRef[]
  kind: string
  contentRef?: string
  contentHash?: string
  status: OutcomeStatus
  verificationRefs: string[]
  artifactIds?: string[]
  receiptIds?: string[]
  version?: number
}

export const ADMISSION_DISPOSITIONS = ['accepted', 'rejected', 'duplicate'] as const
export type AdmissionDisposition = typeof ADMISSION_DISPOSITIONS[number]
export type AdmissionCheckName = 'schema' | 'scope' | 'policy' | 'authorization' | 'idempotency' | 'budget' | 'adapter-health'
export type AdmissionCheck = {
  name: AdmissionCheckName
  passed: boolean
  reason?: string
}

export type ActionAdmissionResult = {
  disposition: AdmissionDisposition
  action: Action
  receipt?: Receipt
  checks: AdmissionCheck[]
  reasons: string[]
}

export type RunLedgerEventType =
  | 'run.created'
  | 'instruction.received'
  | 'instruction.effective'
  | 'instruction.superseded'
  | 'plan.proposed'
  | 'plan.admitted'
  | 'permission.requested'
  | 'permission.granted'
  | 'permission.denied'
  | 'action.proposed'
  | 'action.admitted'
  | 'action.started'
  | 'receipt.recorded'
  | 'artifact.created'
  | 'artifact.verified'
  | 'artifact.accepted'
  | 'checkpoint.saved'
  | 'run.paused'
  | 'run.resumed'
  | 'run.reconciled'
  | 'run.completed'
  | 'run.failed'
  | 'run.unknown'
  | 'run.cancelled'

export type RunLedgerEvent = RecordEnvelope & {
  type: 'RunLedgerEvent'
  runId: string
  eventType: RunLedgerEventType | (string & {})
  sequence: number
  idempotencyKey: string
  payload?: unknown
}

export type RunLedgerEventInput = {
  runId?: string
  eventType?: RunLedgerEventType | string
  /** `type` is accepted as a convenience for callers that use the event name directly. */
  type?: RunLedgerEventType | string
  idempotencyKey?: string
  payload?: unknown
  projectId?: string
  actor?: ActorRef
  sourceRefs?: SourceRef[]
  truth?: Truth
}

export type CheckpointState = 'open' | 'resumable' | 'resuming' | 'needs-reconciliation' | 'closed' | 'expired'
export type ReceiptSummary = { succeeded: string[]; failed: string[]; unknown: string[] }

export type Checkpoint = RecordEnvelope & {
  type: 'Checkpoint'
  runId: string
  state: CheckpointState
  planCursor: string
  completedActionIds: string[]
  pendingActionIds: string[]
  receiptSummary: ReceiptSummary
  openQuestions: OpenQuestion[]
  externalFactsToVerify: string[]
  snapshotHash: string
}

export type CheckpointInput = Omit<Checkpoint, keyof RecordEnvelope | 'type' | 'snapshotHash'> & {
  projectId?: string
  actor?: ActorRef
  sourceRefs?: SourceRef[]
  truth?: Truth
  id?: string
  createdAt?: string
  updatedAt?: string
  version?: number
  parentId?: string
  status?: string
  snapshotHash?: string
}

export type AdmissionContext = {
  /** A capability object is optional when the caller already normalized Action. */
  capability?: Pick<Capability, 'state' | 'requiredPermission' | 'scope' | 'risk'>
  schemaValid?: boolean
  scopeAllowed?: boolean
  policyAllowed?: boolean
  authorized?: boolean
  /** Alias accepted by integrations that model the permission decision directly. */
  authorization?: boolean
  authorizationValid?: boolean
  preAuthorized?: boolean
  budgetAllowed?: boolean
  adapterHealthy?: boolean
  projectId?: string
  allowedProjectIds?: string[]
  allowedPaths?: string[]
  allowedHosts?: string[]
  now?: string
}

export type ReceiptInput = {
  actionId: string
  status: ReceiptStatus
  adapterRunId?: string
  resultHash?: string
  outputRef?: string
  error?: { code: string; message: string; retryable: boolean }
  evidenceRefs?: string[]
  sideEffect?: SideEffect
  observedAt?: string
  idempotencyKey?: string
}

export type ReconcileInput = {
  actionId: string
  outcome: 'succeeded' | 'failed' | 'not_executed'
  evidenceRefs: string[]
  reason?: string
  resultHash?: string
  outputRef?: string
  sideEffect?: SideEffect
}

export type ReconciliationResult = Receipt & { reconciliationActionId: string }

export type ProductWorkLedgerOptions = {
  now?: () => string | Date
  idFactory?: (prefix: string) => string
  projectId?: string
  actor?: ActorRef
  truth?: Truth
}

/** Serializable state for persistence beside a RuntimeLoopState snapshot. */
export type ProductWorkLedgerSnapshot = {
  version: 1
  records: RecordEnvelope[]
  runLedger: RunLedgerEvent[]
  actions: Action[]
  receipts: Receipt[]
  checkpoints: Checkpoint[]
  defaults: { projectId?: string; actor: ActorRef; truth: Truth }
}

const VALID_PERMISSION_LEVELS = new Set<PermissionLevel>(['L0', 'L1', 'L2', 'L3', 'L4'])
const VALID_RECEIPT_STATUSES = new Set<ReceiptStatus>([
  'accepted', 'started', 'succeeded', 'failed', 'unknown', 'cancelled', 'not_executed',
])
const VALID_CHECKPOINT_STATES = new Set<CheckpointState>([
  'open', 'resumable', 'resuming', 'needs-reconciliation', 'closed', 'expired',
])

function clone<T>(value: T): T {
  if (value === undefined) return value
  return structuredClone(value)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`)
  return value
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function assertIsoDate(value: unknown, name: string): asserts value is string {
  if (!isIsoDate(value)) throw new Error(`${name} must be an ISO date string`)
}

function assertActor(value: unknown, name = 'actor'): asserts value is ActorRef {
  if (!isObject(value) || !['human', 'agent', 'system', 'capability-adapter'].includes(value.type as string)) {
    throw new Error(`${name}.type is invalid`)
  }
  requireString(value.id, `${name}.id`)
}

export function validateSourceRef(value: unknown, name = 'sourceRef'): asserts value is SourceRef {
  if (!isObject(value) || !SOURCE_REF_TYPES.includes(value.type as SourceRefType)) {
    throw new Error(`${name}.type is invalid`)
  }
  requireString(value.id, `${name}.id`)
  if (!SOURCE_REF_RELATIONS.includes(value.relation as SourceRefRelation)) {
    throw new Error(`${name}.relation is invalid`)
  }
  if (value.version !== undefined && (!Number.isInteger(value.version) || (value.version as number) < 1)) {
    throw new Error(`${name}.version must be a positive integer`)
  }
}

export function validateRecordEnvelope(value: unknown, name = 'record'): asserts value is RecordEnvelope {
  if (!isObject(value)) throw new Error(`${name} must be an object`)
  requireString(value.id, `${name}.id`)
  requireString(value.type, `${name}.type`)
  requireString(value.projectId, `${name}.projectId`)
  assertIsoDate(value.createdAt, `${name}.createdAt`)
  assertIsoDate(value.updatedAt, `${name}.updatedAt`)
  requireString(value.status, `${name}.status`)
  if (!Number.isInteger(value.version) || (value.version as number) < 1) throw new Error(`${name}.version must be a positive integer`)
  if (!Array.isArray(value.sourceRefs)) throw new Error(`${name}.sourceRefs must be an array`)
  value.sourceRefs.forEach((ref, index) => validateSourceRef(ref, `${name}.sourceRefs[${index}]`))
  assertActor(value.actor, `${name}.actor`)
  if (!['live', 'demo', 'imported'].includes(value.truth as string)) throw new Error(`${name}.truth is invalid`)
}

export function validatePermissionRequest(value: unknown, name = 'permissionRequest'): asserts value is PermissionRequest {
  if (!isObject(value)) throw new Error(`${name} must be an object`)
  if (!VALID_PERMISSION_LEVELS.has(value.level as PermissionLevel)) throw new Error(`${name}.level is invalid`)
  requireString(value.actorId, `${name}.actorId`)
  requireString(value.projectId, `${name}.projectId`)
  requireString(value.capabilityId, `${name}.capabilityId`)
  requireString(value.operation, `${name}.operation`)
  requireString(value.targetSummary, `${name}.targetSummary`)
  requireString(value.reason, `${name}.reason`)
  requireString(value.expectedSideEffect, `${name}.expectedSideEffect`)
  if (!isObject(value.scope)) throw new Error(`${name}.scope must be an object`)
  for (const key of ['paths', 'hosts', 'objects'] as const) {
    if (value.scope[key] !== undefined && (!Array.isArray(value.scope[key]) || !(value.scope[key] as unknown[]).every((item) => typeof item === 'string'))) {
      throw new Error(`${name}.scope.${key} must be a string array`)
    }
  }
  if (value.expiresAt !== undefined) assertIsoDate(value.expiresAt, `${name}.expiresAt`)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b)
}

function normalizeLedgerSnapshot(
  input: Partial<ProductWorkLedgerSnapshot> | undefined | null,
  fallbackDefaults: { projectId?: string; actor: ActorRef; truth: Truth },
): ProductWorkLedgerSnapshot {
  const value = isObject(input) ? input : {}
  if (value.version !== undefined && value.version !== 1) throw new Error(`unsupported product work ledger state version: ${String(value.version)}`)
  const list = (key: 'records' | 'runLedger' | 'actions' | 'receipts' | 'checkpoints'): unknown[] => {
    const item = value[key]
    if (item === undefined) return []
    if (!Array.isArray(item)) throw new Error(`product work ledger ${key} must be an array`)
    return item
  }
  const candidateDefaults: Record<string, unknown> = isObject(value.defaults) ? value.defaults : {}
  const rawActor = candidateDefaults['actor']
  const actor = isObject(rawActor)
    && ['human', 'agent', 'system', 'capability-adapter'].includes(rawActor['type'] as string)
    && typeof rawActor['id'] === 'string'
    ? rawActor as unknown as ActorRef
    : fallbackDefaults.actor
  const rawTruth = candidateDefaults['truth']
  const truth = ['live', 'demo', 'imported'].includes(rawTruth as string)
    ? rawTruth as Truth
    : fallbackDefaults.truth
  const rawProjectId = candidateDefaults['projectId']
  const projectId = typeof rawProjectId === 'string'
    ? rawProjectId
    : fallbackDefaults.projectId
  return {
    version: 1,
    records: clone(list('records')) as RecordEnvelope[],
    runLedger: clone(list('runLedger')) as RunLedgerEvent[],
    actions: clone(list('actions')) as Action[],
    receipts: clone(list('receipts')) as Receipt[],
    checkpoints: clone(list('checkpoints')) as Checkpoint[],
    defaults: { ...(projectId ? { projectId } : {}), actor: clone(actor), truth },
  }
}

function pathWithin(pathValue: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true
  const normalized = pathValue.replaceAll('\\', '/').replace(/\/$/, '')
  return allowed.some((candidate) => {
    const root = candidate.replaceAll('\\', '/').replace(/\/$/, '')
    return normalized === root || normalized.startsWith(`${root}/`)
  })
}

function hostWithin(host: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true
  return allowed.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))
}

export function checkpointSnapshot(value: Pick<Checkpoint, 'runId' | 'state' | 'planCursor' | 'completedActionIds' | 'pendingActionIds' | 'receiptSummary' | 'openQuestions' | 'externalFactsToVerify'>): string {
  return hash({
    runId: value.runId,
    state: value.state,
    planCursor: value.planCursor,
    completedActionIds: [...value.completedActionIds],
    pendingActionIds: [...value.pendingActionIds],
    receiptSummary: {
      succeeded: [...value.receiptSummary.succeeded],
      failed: [...value.receiptSummary.failed],
      unknown: [...value.receiptSummary.unknown],
    },
    openQuestions: clone(value.openQuestions),
    externalFactsToVerify: [...value.externalFactsToVerify],
  })
}

export function validateCheckpoint(value: unknown): asserts value is Checkpoint {
  validateRecordEnvelope(value, 'checkpoint')
  const checkpoint = value as Checkpoint
  if (checkpoint.type !== 'Checkpoint') throw new Error('checkpoint.type must be Checkpoint')
  requireString(checkpoint.runId, 'checkpoint.runId')
  if (!VALID_CHECKPOINT_STATES.has(checkpoint.state)) throw new Error('checkpoint.state is invalid')
  requireString(checkpoint.planCursor, 'checkpoint.planCursor')
  for (const key of ['completedActionIds', 'pendingActionIds', 'externalFactsToVerify'] as const) {
    if (!Array.isArray(checkpoint[key]) || !(checkpoint[key] as unknown[]).every((item) => typeof item === 'string' && item.length > 0)) {
      throw new Error(`checkpoint.${key} must be a string array`)
    }
  }
  const completed = new Set(checkpoint.completedActionIds)
  if (completed.size !== checkpoint.completedActionIds.length) throw new Error('checkpoint.completedActionIds contains duplicates')
  if (checkpoint.pendingActionIds.some((id) => completed.has(id))) throw new Error('checkpoint completed and pending actions overlap')
  if (!isObject(checkpoint.receiptSummary)) throw new Error('checkpoint.receiptSummary must be an object')
  for (const key of ['succeeded', 'failed', 'unknown'] as const) {
    const items = checkpoint.receiptSummary[key]
    if (!Array.isArray(items) || !items.every((item) => typeof item === 'string' && item.length > 0)) throw new Error(`checkpoint.receiptSummary.${key} must be a string array`)
  }
  const receiptIds = [
    ...checkpoint.receiptSummary.succeeded,
    ...checkpoint.receiptSummary.failed,
    ...checkpoint.receiptSummary.unknown,
  ]
  if (new Set(receiptIds).size !== receiptIds.length) throw new Error('checkpoint receipt summary contains duplicate action IDs')
  if (!Array.isArray(checkpoint.openQuestions)) throw new Error('checkpoint.openQuestions must be an array')
  checkpoint.openQuestions.forEach((question, index) => {
    if (!isObject(question) || typeof question.id !== 'string' || typeof question.prompt !== 'string' || typeof question.blocking !== 'boolean') {
      throw new Error(`checkpoint.openQuestions[${index}] is invalid`)
    }
    if (question.answerRef !== undefined && typeof question.answerRef !== 'string') throw new Error(`checkpoint.openQuestions[${index}].answerRef is invalid`)
  })
  requireString(checkpoint.snapshotHash, 'checkpoint.snapshotHash')
  const expected = checkpointSnapshot(checkpoint)
  if (checkpoint.snapshotHash !== expected) throw new Error('checkpoint.snapshotHash does not match snapshot')
}

export function createRecordEnvelope(input: {
  id: string
  type: string
  projectId: string
  status: string
  actor: ActorRef
  truth?: Truth
  sourceRefs?: SourceRef[]
  parentId?: string
  version?: number
  createdAt?: string
  updatedAt?: string
}): RecordEnvelope {
  const now = input.createdAt ?? new Date().toISOString()
  const record: RecordEnvelope = {
    id: input.id,
    type: input.type,
    projectId: input.projectId,
    createdAt: now,
    updatedAt: input.updatedAt ?? now,
    status: input.status,
    version: input.version ?? 1,
    sourceRefs: clone(input.sourceRefs ?? []),
    actor: clone(input.actor),
    truth: input.truth ?? 'live',
    ...(input.parentId ? { parentId: input.parentId } : {}),
  }
  validateRecordEnvelope(record)
  return record
}

function normalizeIdempotencyKey(value: unknown, name = 'idempotencyKey'): string {
  return requireString(value, name)
}

function actionFingerprint(action: Action): unknown {
  return {
    runId: action.runId,
    capabilityId: action.capabilityId,
    operation: action.operation,
    arguments: action.arguments,
    target: action.target,
    risk: action.risk,
    permissionRequest: action.permissionRequest,
    idempotencyKey: action.idempotencyKey,
  }
}

function validateAction(action: Action): void {
  validateRecordEnvelope(action, 'action')
  if (action.type !== 'Action') throw new Error('action.type must be Action')
  if (!['proposed', 'awaiting_authorization', 'admitted', 'running', 'succeeded', 'failed', 'unknown', 'cancelled', 'skipped', 'rejected'].includes(action.status)) throw new Error('action.status is invalid')
  requireString(action.runId, 'action.runId')
  requireString(action.capabilityId, 'action.capabilityId')
  requireString(action.operation, 'action.operation')
  requireString(action.idempotencyKey, 'action.idempotencyKey')
  if (!isObject(action.target) || action.target.projectId !== action.projectId) throw new Error('action.target.projectId must match action.projectId')
  if (!['read', 'reversible-write', 'execution', 'external-side-effect', 'destructive'].includes(action.risk)) throw new Error('action.risk is invalid')
  validatePermissionRequest(action.permissionRequest)
  if (action.permissionRequest.projectId !== action.projectId) throw new Error('action.permissionRequest.projectId must match action.projectId')
  if (action.permissionRequest.capabilityId !== action.capabilityId) throw new Error('action.permissionRequest.capabilityId must match action.capabilityId')
  if (!['before-start', 'cooperative', 'not-supported'].includes(action.cancelMode)) throw new Error('action.cancelMode is invalid')
  if (action.timeoutMs !== undefined && (!Number.isInteger(action.timeoutMs) || action.timeoutMs < 1)) throw new Error('action.timeoutMs must be a positive integer')
}

function validateReceiptInput(input: ReceiptInput): void {
  requireString(input.actionId, 'receipt.actionId')
  if (!VALID_RECEIPT_STATUSES.has(input.status)) throw new Error(`receipt.status must use one of ${[...VALID_RECEIPT_STATUSES].join(', ')}`)
  if (input.evidenceRefs !== undefined && (!Array.isArray(input.evidenceRefs) || !input.evidenceRefs.every((item) => typeof item === 'string'))) throw new Error('receipt.evidenceRefs must be a string array')
  if (input.sideEffect !== undefined && !['none', 'local-reversible', 'external-reversible', 'external-irreversible', 'unknown'].includes(input.sideEffect)) throw new Error('receipt.sideEffect is invalid')
  if (input.observedAt !== undefined) assertIsoDate(input.observedAt, 'receipt.observedAt')
  if (input.error !== undefined && (!isObject(input.error) || typeof input.error.code !== 'string' || typeof input.error.message !== 'string' || typeof input.error.retryable !== 'boolean')) throw new Error('receipt.error is invalid')
}

export class ProductWorkLedger {
  private readonly records = new Map<string, RecordEnvelope>()
  private readonly eventsByRun = new Map<string, RunLedgerEvent[]>()
  private readonly eventByIdempotency = new Map<string, RunLedgerEvent>()
  private readonly actions = new Map<string, Action>()
  private readonly actionsByRun = new Map<string, string[]>()
  private readonly actionByIdempotency = new Map<string, Action>()
  private readonly receiptsByAction = new Map<string, Receipt[]>()
  private readonly receiptByIdempotency = new Map<string, Receipt>()
  private readonly checkpoints = new Map<string, Checkpoint>()
  private readonly now: () => string
  private readonly idFactory: (prefix: string) => string
  private readonly defaults: { projectId?: string; actor: ActorRef; truth: Truth }

  constructor(options: ProductWorkLedgerOptions = {}) {
    this.now = () => {
      const value = options.now?.() ?? new Date()
      return value instanceof Date ? value.toISOString() : value
    }
    this.idFactory = options.idFactory ?? ((prefix) => `${prefix}-${randomUUID()}`)
    this.defaults = {
      projectId: options.projectId,
      actor: options.actor ?? { type: 'system', id: 'product-work-ledger' },
      truth: options.truth ?? 'live',
    }
  }

  private envelope(input: {
    id?: string
    type: string
    projectId?: string
    status: string
    actor?: ActorRef
    truth?: Truth
    sourceRefs?: SourceRef[]
    parentId?: string
    version?: number
  }): RecordEnvelope {
    return createRecordEnvelope({
      id: input.id ?? this.idFactory(input.type.toLowerCase()),
      type: input.type,
      projectId: input.projectId ?? this.defaults.projectId ?? 'unknown-project',
      status: input.status,
      actor: input.actor ?? this.defaults.actor,
      truth: input.truth ?? this.defaults.truth,
      sourceRefs: input.sourceRefs,
      parentId: input.parentId,
      version: input.version,
      createdAt: this.now(),
      updatedAt: this.now(),
    })
  }

  private remember<T extends RecordEnvelope>(record: T): T {
    this.records.set(record.id, clone(record))
    return clone(record)
  }

  getRecord<T extends RecordEnvelope = RecordEnvelope>(id: string): T | undefined {
    return clone(this.records.get(id) as T | undefined)
  }

  /** Append an immutable Run Ledger event. Repeating an idempotency key returns the original event. */
  appendRunEvent(runId: string, input: Omit<RunLedgerEventInput, 'runId'>): { event: RunLedgerEvent; duplicate: boolean };
  appendRunEvent(input: RunLedgerEventInput & { runId: string }): { event: RunLedgerEvent; duplicate: boolean };
  appendRunEvent(runOrInput: string | (RunLedgerEventInput & { runId: string }), maybeInput?: Omit<RunLedgerEventInput, 'runId'>): { event: RunLedgerEvent; duplicate: boolean } {
    const input = typeof runOrInput === 'string' ? { ...maybeInput, runId: runOrInput } : runOrInput
    const runId = requireString(input.runId, 'runId')
    const eventType = requireString(input.eventType ?? input.type, 'eventType')
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey ?? `${runId}:${eventType}:${this.eventsByRun.get(runId)?.length ?? 0}`)
    const existing = this.eventByIdempotency.get(idempotencyKey)
    if (existing) {
      if (existing.eventType !== eventType || !sameJson(existing.payload, input.payload)) throw new Error(`run ledger idempotency collision: ${idempotencyKey}`)
      return { event: clone(existing), duplicate: true }
    }
    const sequence = (this.eventsByRun.get(runId)?.length ?? 0) + 1
    const envelope = this.envelope({
      id: this.idFactory('ledger-event'),
      type: 'RunLedgerEvent',
      projectId: input.projectId ?? this.defaults.projectId,
      status: 'recorded',
      actor: input.actor,
      truth: input.truth,
      sourceRefs: input.sourceRefs,
    })
    const event: RunLedgerEvent = {
      ...envelope,
      type: 'RunLedgerEvent',
      runId,
      eventType,
      sequence,
      idempotencyKey,
      ...(input.payload === undefined ? {} : { payload: clone(input.payload) }),
    }
    const events = this.eventsByRun.get(runId) ?? []
    events.push(event)
    this.eventsByRun.set(runId, events)
    this.eventByIdempotency.set(idempotencyKey, event)
    this.remember(event)
    return { event: clone(event), duplicate: false }
  }

  appendEvent(input: RunLedgerEventInput & { runId: string }): RunLedgerEvent {
    return this.appendRunEvent(input).event
  }

  getRunLedger(runId: string): RunLedgerEvent[] {
    return clone(this.eventsByRun.get(runId) ?? [])
  }

  getLedger(runId: string): RunLedgerEvent[] {
    return this.getRunLedger(runId)
  }

  registerAction(action: Action): Action {
    validateAction(action)
    const existing = this.actionByIdempotency.get(action.idempotencyKey)
    if (existing) {
      if (!sameJson(actionFingerprint(existing), actionFingerprint(action))) throw new Error(`action idempotency collision: ${action.idempotencyKey}`)
      return clone(existing)
    }
    const saved = clone(action)
    this.actions.set(saved.id, saved)
    this.actionByIdempotency.set(saved.idempotencyKey, saved)
    const ids = this.actionsByRun.get(saved.runId) ?? []
    ids.push(saved.id)
    this.actionsByRun.set(saved.runId, ids)
    this.remember(saved)
    return clone(saved)
  }

  private buildAction(input: CreateActionInput): Action {
    const envelope = this.envelope({
      id: input.id,
      type: 'Action',
      projectId: input.projectId ?? input.target.projectId,
      status: input.status ?? 'proposed',
      actor: input.actor,
      truth: input.truth,
      sourceRefs: input.sourceRefs,
      parentId: input.parentId,
      version: input.version,
    })
    const action: Action = {
      ...envelope,
      type: 'Action',
      status: input.status ?? 'proposed',
      runId: input.runId,
      capabilityId: input.capabilityId,
      operation: input.operation,
      arguments: clone(input.arguments),
      target: clone(input.target),
      risk: input.risk,
      permissionRequest: clone(input.permissionRequest),
      idempotencyKey: input.idempotencyKey,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      cancelMode: input.cancelMode,
    }
    validateAction(action)
    return action
  }

  createAction(input: CreateActionInput): Action {
    return this.registerAction(this.buildAction(input))
  }

  getAction(id: string): Action | undefined {
    return clone(this.actions.get(id))
  }

  getActionsForRun(runId: string): Action[] {
    return clone((this.actionsByRun.get(runId) ?? []).map((id) => this.actions.get(id)).filter((action): action is Action => Boolean(action)))
  }

  private checkAdmission(action: Action, context: AdmissionContext): AdmissionCheck[] {
    const checks: AdmissionCheck[] = []
    const fail = (name: AdmissionCheckName, reason: string) => checks.push({ name, passed: false, reason })
    checks.push({ name: 'schema', passed: context.schemaValid !== false })
    if (context.schemaValid === false) fail('schema', 'action arguments failed capability schema validation')
    const capability = context.capability
    const projectOk = context.projectId === undefined || context.projectId === action.target.projectId
    const allowedProject = context.allowedProjectIds === undefined || context.allowedProjectIds.includes(action.target.projectId)
    const capabilityProject = !capability?.scope.projectIds || capability.scope.projectIds.includes(action.target.projectId)
    const pathOk = !action.target.path || (pathWithin(action.target.path, context.allowedPaths ?? []) && pathWithin(action.target.path, capability?.scope.paths ?? []))
    const hostOk = !action.target.host || (hostWithin(action.target.host, context.allowedHosts ?? []) && hostWithin(action.target.host, capability?.scope.hosts ?? []))
    if (!(projectOk && allowedProject && capabilityProject && pathOk && hostOk && context.scopeAllowed !== false)) {
      fail('scope', 'action target is outside the project or capability scope')
    } else checks.push({ name: 'scope', passed: true })
    if (context.policyAllowed === false || (capability?.state !== undefined && capability.state !== 'available')) {
      fail('policy', capability?.state === 'disabled' ? 'capability adapter is disabled' : 'project policy does not allow this action')
    } else checks.push({ name: 'policy', passed: true })
    const level = action.permissionRequest.level
    const hasAuthorization = context.authorization === true || context.authorized === true || context.authorizationValid === true || context.preAuthorized === true || Boolean(action.permissionRequest.authorizationRef)
    const authorizationOk = hasAuthorization || level === 'L0' || level === 'L1'
    if (!authorizationOk) fail('authorization', `${level} action requires an explicit, valid authorization`)
    else checks.push({ name: 'authorization', passed: true })
    checks.push({ name: 'idempotency', passed: true })
    if (context.budgetAllowed === false) fail('budget', 'action budget is exhausted')
    else checks.push({ name: 'budget', passed: true })
    if (context.adapterHealthy === false) fail('adapter-health', 'capability adapter is unavailable')
    else checks.push({ name: 'adapter-health', passed: true })
    return checks
  }

  /** Admit an Action only after schema/scope/policy/authorization/idempotency/budget/health checks. */
  admitAction(actionOrInput: Action | Parameters<ProductWorkLedger['createAction']>[0], context: AdmissionContext = {}): ActionAdmissionResult {
    const action = 'type' in actionOrInput && actionOrInput.type === 'Action'
      ? (validateAction(actionOrInput), clone(actionOrInput))
      : this.buildAction(actionOrInput)
    const prior = this.actionByIdempotency.get(action.idempotencyKey)
    if (prior && prior.id !== action.id) {
      if (!sameJson(actionFingerprint(prior), actionFingerprint(action))) throw new Error(`action idempotency collision: ${action.idempotencyKey}`)
      const receipt = this.latestReceipt(prior.id)
      return { disposition: 'duplicate', action: clone(prior), ...(receipt ? { receipt } : {}), checks: [{ name: 'idempotency', passed: false, reason: 'same idempotency key already admitted' }], reasons: ['duplicate idempotency key'] }
    }
    if (!prior) this.registerAction(action)
    const checks = this.checkAdmission(action, context)
    const failed = checks.filter((check) => !check.passed)
    if (failed.length > 0) {
      const rejected: Action = { ...action, status: 'rejected', updatedAt: this.now() }
      this.actions.set(action.id, rejected)
      this.actionByIdempotency.set(action.idempotencyKey, rejected)
      this.remember(rejected)
      const receipt = this.recordReceipt({
        actionId: rejected.id,
        status: 'not_executed',
        evidenceRefs: [],
        sideEffect: 'none',
        error: { code: 'ACTION_NOT_ADMITTED', message: failed.map((check) => check.reason ?? check.name).join('; '), retryable: false },
      })
      return { disposition: 'rejected', action: clone(rejected), receipt, checks, reasons: failed.map((check) => check.reason ?? check.name) }
    }
    const admitted: Action = { ...action, status: 'admitted', updatedAt: this.now() }
    this.actions.set(action.id, admitted)
    this.actionByIdempotency.set(action.idempotencyKey, admitted)
    this.remember(admitted)
    this.appendRunEvent(admitted.runId, {
      eventType: 'action.admitted',
      idempotencyKey: `action-admitted:${admitted.id}`,
      projectId: admitted.projectId,
      actor: admitted.actor,
      sourceRefs: [{ type: 'action', id: admitted.id, relation: 'created-by' }],
      payload: { actionId: admitted.id, capabilityId: admitted.capabilityId, permissionLevel: admitted.permissionRequest.level },
    })
    return { disposition: 'accepted', action: clone(admitted), checks, reasons: [] }
  }

  admit(actionOrInput: Action | Parameters<ProductWorkLedger['createAction']>[0], context: AdmissionContext = {}): ActionAdmissionResult {
    return this.admitAction(actionOrInput, context)
  }

  private latestReceipt(actionId: string): Receipt | undefined {
    const receipts = this.receiptsByAction.get(actionId)
    return receipts?.at(-1) ? clone(receipts.at(-1)) : undefined
  }

  getReceipts(actionId: string): Receipt[] {
    return clone(this.receiptsByAction.get(actionId) ?? [])
  }

  getReceipt(actionId: string): Receipt | undefined {
    return this.latestReceipt(actionId)
  }

  recordReceipt(input: ReceiptInput): Receipt {
    validateReceiptInput(input)
    const action = this.actions.get(input.actionId)
    if (!action) throw new Error(`cannot record receipt for unknown action: ${input.actionId}`)
    if (input.status !== 'not_executed' && !['admitted', 'running', 'succeeded', 'failed', 'unknown', 'cancelled', 'skipped'].includes(action.status)) {
      throw new Error('an Action must be admitted before recording execution receipts')
    }
    if (input.idempotencyKey) {
      const duplicate = this.receiptByIdempotency.get(input.idempotencyKey)
      if (duplicate) {
        if (duplicate.actionId !== input.actionId || duplicate.status !== input.status) throw new Error(`receipt idempotency collision: ${input.idempotencyKey}`)
        return clone(duplicate)
      }
    }
    const existing = this.latestReceipt(action.id)
    if (existing && input.idempotencyKey && existing.id === input.idempotencyKey) return clone(existing)
    if (existing?.status === 'unknown' && input.status !== 'unknown' && !input.idempotencyKey?.startsWith('reconcile:')) {
      throw new Error('unknown action requires reconcile before a terminal receipt')
    }
    const observedAt = input.observedAt ?? this.now()
    const receiptEnvelope = this.envelope({
      id: this.idFactory('receipt'),
      type: 'Receipt',
      projectId: action.projectId,
      status: input.status,
      actor: action.actor,
      truth: action.truth,
      sourceRefs: [{ type: 'action', id: action.id, relation: 'executed-by' }, { type: 'run', id: action.runId, relation: 'references' }],
      parentId: existing?.id,
    })
    const receipt: Receipt = {
      ...receiptEnvelope,
      type: 'Receipt',
      actionId: action.id,
      status: input.status,
      ...(input.adapterRunId ? { adapterRunId: input.adapterRunId } : {}),
      ...(input.resultHash ? { resultHash: input.resultHash } : {}),
      ...(input.outputRef ? { outputRef: input.outputRef } : {}),
      ...(input.error ? { error: clone(input.error) } : {}),
      evidenceRefs: [...(input.evidenceRefs ?? [])],
      sideEffect: input.sideEffect ?? (input.status === 'not_executed' ? 'none' : 'unknown'),
      observedAt,
    }
    const receipts = this.receiptsByAction.get(action.id) ?? []
    receipts.push(receipt)
    this.receiptsByAction.set(action.id, receipts)
    if (input.idempotencyKey) this.receiptByIdempotency.set(input.idempotencyKey, receipt)
    const nextStatus: ActionStatus = input.status === 'accepted' ? 'admitted'
      : input.status === 'started' ? 'running'
        : input.status === 'succeeded' ? 'succeeded'
          : input.status === 'failed' ? 'failed'
            : input.status === 'unknown' ? 'unknown'
              : input.status === 'cancelled' ? 'cancelled' : 'skipped'
    const nextAction: Action = { ...action, status: nextStatus, updatedAt: this.now() }
    this.actions.set(action.id, nextAction)
    this.actionByIdempotency.set(action.idempotencyKey, nextAction)
    this.remember(receipt)
    this.remember(nextAction)
    this.appendRunEvent(action.runId, {
      eventType: 'receipt.recorded',
      idempotencyKey: `receipt:${receipt.id}`,
      projectId: action.projectId,
      actor: action.actor,
      sourceRefs: [{ type: 'receipt', id: receipt.id, relation: 'produced-by' }, { type: 'action', id: action.id, relation: 'executed-by' }],
      payload: { actionId: action.id, receiptId: receipt.id, status: receipt.status },
    })
    if (input.status === 'unknown') {
      this.appendRunEvent(action.runId, {
        eventType: 'run.unknown',
        idempotencyKey: `run-unknown:${action.id}:${receipt.id}`,
        projectId: action.projectId,
        actor: action.actor,
        sourceRefs: [{ type: 'action', id: action.id, relation: 'references' }, { type: 'receipt', id: receipt.id, relation: 'references' }],
        payload: { actionId: action.id, receiptId: receipt.id },
      })
    }
    return clone(receipt)
  }

  /** Resolve an unknown action only with a separate reconciliation action and evidence. */
  reconcileUnknown(input: ReconcileInput): ReconciliationResult {
    requireString(input.actionId, 'actionId')
    if (!['succeeded', 'failed', 'not_executed'].includes(input.outcome)) throw new Error('reconcile outcome must be succeeded, failed, or not_executed')
    if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length === 0 || !input.evidenceRefs.every((item) => typeof item === 'string' && item.length > 0)) throw new Error('reconcile requires evidenceRefs')
    const action = this.actions.get(input.actionId)
    if (!action) throw new Error(`cannot reconcile unknown action: ${input.actionId}`)
    const unknownReceipt = this.latestReceipt(action.id)
    if (!unknownReceipt || unknownReceipt.status !== 'unknown') throw new Error('action has no unknown receipt to reconcile')
    const reconcileAction = this.createAction({
      runId: action.runId,
      capabilityId: `reconcile:${action.capabilityId}`,
      operation: 'reconcile',
      arguments: { actionId: action.id, outcome: input.outcome, evidenceRefs: [...input.evidenceRefs] },
      target: clone(action.target),
      risk: 'read',
      permissionRequest: {
        level: 'L0',
        actorId: action.actor.id,
        projectId: action.projectId,
        capabilityId: `reconcile:${action.capabilityId}`,
        operation: 'reconcile',
        targetSummary: `reconcile ${action.id}`,
        scope: clone(action.permissionRequest.scope),
        reason: input.reason ?? 'verify an unknown external fact',
        expectedSideEffect: 'none',
      },
      idempotencyKey: `reconcile:${action.id}:${unknownReceipt.id}`,
      cancelMode: 'before-start',
      actor: action.actor,
      projectId: action.projectId,
      sourceRefs: [{ type: 'action', id: action.id, relation: 'references' }, { type: 'receipt', id: unknownReceipt.id, relation: 'references' }],
    })
    const admission = this.admitAction(reconcileAction, { authorized: true, projectId: action.projectId })
    if (admission.disposition !== 'accepted') throw new Error('reconciliation action could not be admitted')
    this.recordReceipt({ actionId: reconcileAction.id, status: 'succeeded', evidenceRefs: input.evidenceRefs, sideEffect: 'none', idempotencyKey: `reconcile-receipt:${reconcileAction.id}` })
    const reconciled = this.recordReceipt({
      actionId: action.id,
      status: input.outcome,
      evidenceRefs: input.evidenceRefs,
      resultHash: input.resultHash,
      outputRef: input.outputRef,
      sideEffect: input.sideEffect ?? (input.outcome === 'not_executed' ? 'none' : unknownReceipt.sideEffect),
      error: input.outcome === 'failed' ? { code: 'RECONCILED_FAILURE', message: input.reason ?? 'reconciled as failed', retryable: false } : undefined,
      idempotencyKey: `reconcile:${action.id}:${unknownReceipt.id}`,
    })
    const final = { ...reconciled, reconciledFromReceiptId: unknownReceipt.id }
    const receipts = this.receiptsByAction.get(action.id) ?? []
    receipts[receipts.length - 1] = final
    this.receiptsByAction.set(action.id, receipts)
    this.records.set(final.id, clone(final))
    this.appendRunEvent(action.runId, {
      eventType: 'run.reconciled',
      idempotencyKey: `run-reconciled:${action.id}:${unknownReceipt.id}`,
      projectId: action.projectId,
      actor: action.actor,
      sourceRefs: [{ type: 'action', id: action.id, relation: 'references' }, { type: 'action', id: reconcileAction.id, relation: 'executed-by' }, { type: 'receipt', id: unknownReceipt.id, relation: 'supersedes' }],
      payload: { actionId: action.id, unknownReceiptId: unknownReceipt.id, reconciliationActionId: reconcileAction.id, outcome: input.outcome },
    })
    return clone({ ...final, reconciliationActionId: reconcileAction.id })
  }

  reconcile(input: ReconcileInput): ReconciliationResult {
    return this.reconcileUnknown(input)
  }

  createCheckpoint(input: CheckpointInput): Checkpoint {
    requireString(input.runId, 'runId')
    const checkpointEnvelope = this.envelope({
      id: input.id,
      type: 'Checkpoint',
      projectId: input.projectId ?? this.defaults.projectId,
      status: input.status ?? input.state,
      actor: input.actor,
      truth: input.truth,
      sourceRefs: input.sourceRefs ?? [{ type: 'run', id: input.runId, relation: 'created-by' }],
      parentId: input.parentId,
      version: input.version,
    })
    const checkpoint: Checkpoint = {
      ...checkpointEnvelope,
      type: 'Checkpoint',
      runId: input.runId,
      state: input.state,
      planCursor: input.planCursor,
      completedActionIds: [...input.completedActionIds],
      pendingActionIds: [...input.pendingActionIds],
      receiptSummary: {
        succeeded: [...input.receiptSummary.succeeded],
        failed: [...input.receiptSummary.failed],
        unknown: [...input.receiptSummary.unknown],
      },
      openQuestions: clone(input.openQuestions),
      externalFactsToVerify: [...input.externalFactsToVerify],
      snapshotHash: '',
    }
    this.validateCheckpointAgainstRun(checkpoint)
    checkpoint.snapshotHash = checkpointSnapshot(checkpoint)
    if (input.snapshotHash !== undefined && input.snapshotHash !== checkpoint.snapshotHash) throw new Error('checkpoint.snapshotHash does not match snapshot')
    validateCheckpoint(checkpoint)
    this.checkpoints.set(checkpoint.id, clone(checkpoint))
    this.remember(checkpoint)
    this.appendRunEvent(checkpoint.runId, {
      eventType: 'checkpoint.saved',
      idempotencyKey: `checkpoint:${checkpoint.id}`,
      projectId: checkpoint.projectId,
      actor: checkpoint.actor,
      sourceRefs: [{ type: 'checkpoint', id: checkpoint.id, relation: 'created-by' }, { type: 'run', id: checkpoint.runId, relation: 'references' }],
      payload: { checkpointId: checkpoint.id, state: checkpoint.state, snapshotHash: checkpoint.snapshotHash },
    })
    return clone(checkpoint)
  }

  private validateCheckpointAgainstRun(checkpoint: Checkpoint): void {
    const actionIds = new Set((this.actionsByRun.get(checkpoint.runId) ?? []))
    for (const id of [...checkpoint.completedActionIds, ...checkpoint.pendingActionIds]) {
      if (actionIds.size > 0 && !actionIds.has(id)) throw new Error(`checkpoint references action from another run: ${id}`)
    }
    for (const id of [
      ...checkpoint.receiptSummary.succeeded,
      ...checkpoint.receiptSummary.failed,
      ...checkpoint.receiptSummary.unknown,
    ]) {
      if (actionIds.size > 0 && !actionIds.has(id)) throw new Error(`checkpoint receipt summary references action from another run: ${id}`)
    }
    const unknown = new Set(checkpoint.receiptSummary.unknown)
    if (unknown.size > 0 && checkpoint.state !== 'needs-reconciliation' && checkpoint.externalFactsToVerify.length === 0) {
      throw new Error('checkpoint with unknown receipts must require reconciliation or list external facts to verify')
    }
  }

  validateCheckpoint(checkpoint: Checkpoint): boolean {
    validateCheckpoint(checkpoint)
    this.validateCheckpointAgainstRun(checkpoint)
    return true
  }

  /** Return a detached, JSON-serializable copy of all ledger state. */
  snapshot(): ProductWorkLedgerSnapshot {
    const runLedger = [...this.eventsByRun.values()].flat().sort((a, b) => (
      a.runId.localeCompare(b.runId) || a.sequence - b.sequence
    ))
    const receipts = [...this.receiptsByAction.values()].flat()
    return clone({
      version: 1,
      records: [...this.records.values()],
      runLedger,
      actions: [...this.actions.values()],
      receipts,
      checkpoints: [...this.checkpoints.values()],
      defaults: clone(this.defaults),
    })
  }

  exportState(): ProductWorkLedgerSnapshot {
    return this.snapshot()
  }

  serialize(): string {
    return JSON.stringify(this.snapshot())
  }

  /** Restore this instance without appending events or otherwise producing side effects. */
  restoreSnapshot(input: Partial<ProductWorkLedgerSnapshot> | undefined | null): void {
    const snapshot = normalizeLedgerSnapshot(input, this.defaults)
    this.defaults.projectId = snapshot.defaults.projectId
    this.defaults.actor = clone(snapshot.defaults.actor)
    this.defaults.truth = snapshot.defaults.truth
    this.records.clear()
    this.eventsByRun.clear()
    this.eventByIdempotency.clear()
    this.actions.clear()
    this.actionsByRun.clear()
    this.actionByIdempotency.clear()
    this.receiptsByAction.clear()
    this.receiptByIdempotency.clear()
    this.checkpoints.clear()

    for (const record of snapshot.records) this.records.set(record.id, clone(record))
    for (const event of snapshot.runLedger) {
      const events = this.eventsByRun.get(event.runId) ?? []
      events.push(clone(event))
      this.eventsByRun.set(event.runId, events)
      this.eventByIdempotency.set(event.idempotencyKey, clone(event))
      this.records.set(event.id, clone(event))
    }
    for (const action of snapshot.actions) {
      const restored = clone(action)
      this.actions.set(restored.id, restored)
      this.actionByIdempotency.set(restored.idempotencyKey, restored)
      const ids = this.actionsByRun.get(restored.runId) ?? []
      if (!ids.includes(restored.id)) ids.push(restored.id)
      this.actionsByRun.set(restored.runId, ids)
      this.records.set(restored.id, clone(restored))
    }
    for (const receipt of snapshot.receipts) {
      const receipts = this.receiptsByAction.get(receipt.actionId) ?? []
      receipts.push(clone(receipt))
      this.receiptsByAction.set(receipt.actionId, receipts)
      this.records.set(receipt.id, clone(receipt))
    }
    for (const checkpoint of snapshot.checkpoints) {
      this.checkpoints.set(checkpoint.id, clone(checkpoint))
      this.records.set(checkpoint.id, clone(checkpoint))
    }
    for (const receipts of this.receiptsByAction.values()) {
      for (const receipt of receipts) {
        // Older snapshots did not persist receipt idempotency keys. The
        // receipt id is a safe fallback because it is immutable and unique.
        this.receiptByIdempotency.set(receipt.id, clone(receipt))
      }
    }
  }

  restoreState(input: Partial<ProductWorkLedgerSnapshot> | undefined | null): void {
    this.restoreSnapshot(input)
  }

  static fromSnapshot(snapshot: Partial<ProductWorkLedgerSnapshot> | undefined | null, options: ProductWorkLedgerOptions = {}): ProductWorkLedger {
    const ledger = new ProductWorkLedger(options)
    ledger.restoreSnapshot(snapshot)
    return ledger
  }

  static restore(snapshot: Partial<ProductWorkLedgerSnapshot> | undefined | null, options: ProductWorkLedgerOptions = {}): ProductWorkLedger {
    return ProductWorkLedger.fromSnapshot(snapshot, options)
  }

  static deserialize(serialized: string, options: ProductWorkLedgerOptions = {}): ProductWorkLedger {
    let value: unknown
    try {
      value = JSON.parse(serialized)
    } catch {
      throw new Error('product work ledger state is not valid JSON')
    }
    if (!isObject(value)) throw new Error('product work ledger state must be an object')
    return ProductWorkLedger.fromSnapshot(value as Partial<ProductWorkLedgerSnapshot>, options)
  }

  getCheckpoint(id: string): Checkpoint | undefined {
    return clone(this.checkpoints.get(id))
  }
}

/** Short alias used by adapters that only need the in-memory ledger. */
export const WorkLedger = ProductWorkLedger
export const RunLedger = ProductWorkLedger
export const ActionAdmission = ProductWorkLedger
