import {
  ACTION_STATUSES,
  ADMISSION_DISPOSITIONS,
  RECEIPT_STATUSES,
  type ActionStatus as ProductActionStatus,
  type AdmissionDisposition as ProductAdmissionDisposition,
  type Artifact as ProductArtifact,
  type Evidence as ProductEvidence,
  type Outcome,
  type ReceiptStatus as ProductReceiptStatus,
  type SideEffect,
  type SourceRef,
  validateSourceRef as validateProductSourceRef,
} from './product-work-ledger.ts'

/**
 * Browser Capability domain objects and admission boundary.
 *
 * This module deliberately has no browser-engine dependency. It owns the
 * structured contract used by a Browser Gateway and provides an in-memory
 * implementation suitable for admission/recovery tests. A real gateway can
 * persist the same objects and use `settleAction` after it captures page
 * observations.
 */

export type BrowserEngine = 'chromium' | 'webview'
export type BrowserPersistence = 'ephemeral' | 'persistent' | 'persistent-relogin'
export type DownloadPolicy = 'deny' | 'quarantine' | 'project-approved'
export type BrowserProfileStatus = 'draft' | 'ready' | 'locked' | 'revoked' | 'error'
export type SessionStatus =
  | 'created' | 'launching' | 'ready' | 'active' | 'idle' | 'closed'
  | 'disconnected' | 'awaiting_user' | 'reconnecting' | 'resumed' | 'expired' | 'error'
export type AuthState = 'anonymous' | 'authenticated' | 'expired' | 'awaiting_user' | 'unknown'
export type TabStatus = 'opening' | 'open' | 'navigating' | 'interactive' | 'blocked' | 'closed' | 'error'
export type ActionKind =
  | 'navigate' | 'read' | 'click' | 'input' | 'select' | 'upload' | 'download'
  | 'screenshot' | 'wait' | 'assert'
export type RiskLevel = 'read' | 'local-reversible' | 'external-reversible' | 'external-irreversible'
/** Shared status vocabularies are sourced from the product Work Ledger. */
export type ActionStatus = ProductActionStatus
export type ReceiptStatus = ProductReceiptStatus
export type ExternalEffect = 'none' | 'possible' | 'confirmed' | 'rejected' | 'unknown'
export type AdmissionDisposition = ProductAdmissionDisposition
export const BROWSER_ACTION_STATUSES = ACTION_STATUSES
export const BROWSER_RECEIPT_STATUSES = RECEIPT_STATUSES
export const BROWSER_ADMISSION_DISPOSITIONS = ADMISSION_DISPOSITIONS
export type EvidenceType =
  | 'page-snapshot' | 'locator-observation' | 'screenshot' | 'network-observation'
  | 'download-manifest' | 'upload-manifest' | 'confirmation' | 'recovery-check'
export type EvidenceStatus = 'captured' | 'redacted' | 'verified' | 'expired'
export type ArtifactStatus = 'produced' | 'quarantined' | 'available' | 'accepted' | 'rejected' | 'expired'

export interface OriginPolicy {
  /** Exact origins or `*`/`https://*.example.test` patterns. */
  allow: string[]
  /** Deny takes precedence over allow. */
  deny?: string[]
  /** Matching origins require an explicit action authorization. */
  requireConfirmation?: string[]
  /** Aliases accepted when deserializing an older policy shape. */
  allowed?: string[]
  blocked?: string[]
  confirmation?: string[]
}

export interface BrowserPermissions {
  read?: boolean
  navigate?: boolean
  input?: boolean
  upload?: boolean
  download?: boolean
  screenshot?: boolean
  wait?: boolean
  assert?: boolean
  localReversible?: boolean
  externalReversible?: boolean
  externalIrreversible?: boolean
  actions?: ActionKind[]
  risks?: RiskLevel[]
}

export interface BrowserProfile {
  id: string
  projectId: string
  label: string
  engine: BrowserEngine | string
  engineVersion?: string
  persistence: BrowserPersistence
  credentialRefs: string[]
  originPolicy: OriginPolicy
  downloadPolicy: DownloadPolicy
  uploadRoots: string[]
  permissions: BrowserPermissions
  revision: number
  status: BrowserProfileStatus
  createdBy: string
  updatedAt: string
}

export interface BrowserSession {
  id: string
  profileId: string
  profileRevision: number
  projectId: string
  workSessionId: string
  runId: string
  browserInstanceId?: string
  status: SessionStatus
  tabIds: string[]
  authState: AuthState
  startedAt: string
  lastHeartbeatAt: string
  checkpointId?: string
  retention?: string
}
export type Session = BrowserSession

export interface Tab {
  id: string
  sessionId: string
  index: number
  url: string
  origin: string
  title?: string
  status: TabStatus
  pageStateId?: string
  openerTabId?: string
  lastActionId?: string
}

export interface PageSecurity {
  https?: boolean
  certificateValid?: boolean
  mixedContent?: boolean
  permissionPrompt?: boolean
  downloadPrompt?: boolean
}
export interface PageLandmark {
  kind: string
  name?: string
  role?: string
  text?: string
  locator?: Record<string, unknown>
}
export interface PageFrame {
  id: string
  origin: string
  crossOrigin?: boolean
  operable?: boolean
}
export interface PageState {
  id: string
  tabId: string
  capturedAt: string
  url: string
  title: string
  navigationId: string
  domHash: string
  accessibilityHash: string
  textExcerpt: string
  landmarks: PageLandmark[]
  frames: PageFrame[]
  security: PageSecurity
  screenshotEvidenceId?: string
  stale: boolean
}

export interface ActionTarget {
  pageStateId?: string
  locator?: Record<string, unknown>
  role?: string
  name?: string
  label?: string
  text?: string
  url?: string
  coordinates?: { x: number; y: number }
}
export interface ActionPrecondition { type: string; value?: unknown }
export interface ActionAuthorization {
  confirmed?: boolean
  authorizationRef?: string
  actor?: string
  scope?: string
  expiresAt?: string
  confirmationText?: string
}
export interface BrowserAction {
  id: string
  runId: string
  sessionId: string
  tabId: string
  sequence: number
  kind: ActionKind
  target: ActionTarget
  arguments: Record<string, unknown>
  preconditions: ActionPrecondition[]
  risk: RiskLevel
  authorization?: ActionAuthorization
  idempotencyKey: string
  timeoutMs?: number
  retryPolicy?: Record<string, unknown>
  status: ActionStatus
  createdAt?: string
}
export type Action = BrowserAction

export interface ReceiptAttempt {
  id: string
  startedAt: string
  endedAt?: string
  status: 'started' | 'succeeded' | 'failed' | 'unknown'
  errorCode?: string
  detail?: string
}
export interface Receipt {
  id: string
  actionId: string
  status: ReceiptStatus
  attempts: ReceiptAttempt[]
  beforePageStateId?: string
  afterPageStateId?: string
  result: Record<string, unknown>
  externalEffect: ExternalEffect
  evidenceRefs: string[]
  artifactRefs: string[]
  error?: { code: string; message: string; recovery?: string }
  settledAt: string
  /** Product Work Ledger compatibility fields populated by an adapter when persisted. */
  type?: 'Receipt'
  sourceRefs?: SourceRef[]
  sideEffect?: SideEffect
}

export interface Evidence {
  id: string
  /** Browser evidence discriminator; `Evidence` is accepted for ledger envelopes. */
  type: EvidenceType | 'Evidence'
  status: EvidenceStatus
  actionId?: string
  receiptId?: string
  pageStateId?: string
  capturedAt: string
  source?: { url?: string; origin?: string; tabId?: string }
  content: Record<string, unknown>
  contentHash?: string
  /** Optional canonical ledger projection fields. */
  runId?: string
  sourceRefs?: SourceRef[]
  kind?: ProductEvidence['kind']
  contentRef?: string
  verificationRefs?: string[]
  redaction?: ProductEvidence['redaction']
  confidence?: ProductEvidence['confidence']
}
export interface Artifact {
  id: string
  kind: 'page-extract' | 'screenshot' | 'download' | 'form-result' | 'external-receipt' | 'error-report'
  version: number
  sourceRefs: SourceRef[]
  contentRef: string
  summary: string
  status: ArtifactStatus
  integrity?: { mime?: string; size?: number; contentHash?: string; producerVersion?: string }
  createdAt: string
  type?: 'Artifact'
  /** Optional canonical ledger projection fields. */
  runId?: string
  contentHash?: string
  verificationRefs?: string[]
}

/** Canonical Work Ledger projections are re-exported for adapter integrations. */
export type ProductLedgerEvidence = ProductEvidence
export type ProductLedgerArtifact = ProductArtifact
export type BrowserOutcome = Outcome

export interface CheckpointTabState { tabId: string; url: string; pageStateId?: string; stale: boolean }
export interface BrowserCheckpoint {
  id: string
  runId: string
  profileId: string
  profileRevision: number
  sessionId: string
  browserInstanceId?: string
  tabStates: CheckpointTabState[]
  nextSequence: number
  inFlightActionId?: string
  inFlightIdempotencyKey?: string
  authorizationRefs: string[]
  receiptRefs: string[]
  artifactRefs: string[]
  openQuestions: string[]
  checkpointAt: string
}
export type Checkpoint = BrowserCheckpoint

export interface AdmissionResult {
  disposition: AdmissionDisposition
  action: BrowserAction
  receipt: Receipt
  reasons: string[]
  requiresAuthorization: boolean
}
export interface CheckpointValidation { valid: boolean; requiresVerification: boolean; reasons: string[] }
export interface BrowserCapabilityOptions { now?: () => string; idFactory?: (prefix: string) => string }

/** Serializable browser capability state persisted inside RuntimeLoopState. */
export type BrowserCapabilitySnapshot = {
  version: 1
  profiles: BrowserProfile[]
  sessions: BrowserSession[]
  tabs: Tab[]
  pageStates: PageState[]
  actions: BrowserAction[]
  receipts: Receipt[]
  idempotency: Array<[string, string]>
  evidences: Evidence[]
  artifacts: Artifact[]
  checkpoints: BrowserCheckpoint[]
  nextSequences: Array<[string, number]>
}

const ACTION_KINDS = new Set<ActionKind>(['navigate', 'read', 'click', 'input', 'select', 'upload', 'download', 'screenshot', 'wait', 'assert'])
const RISKS = new Set<RiskLevel>(['read', 'local-reversible', 'external-reversible', 'external-irreversible'])
const EXTERNAL_RISKS = new Set<RiskLevel>(['external-reversible', 'external-irreversible'])
const TARGET_REQUIRED = new Set<ActionKind>(['read', 'click', 'input', 'select', 'upload', 'download', 'screenshot', 'assert'])
const PAGE_TARGET_REQUIRED = new Set<ActionKind>(['read', 'click', 'input', 'select', 'upload', 'screenshot', 'assert'])

function copy<T>(value: T): T { return structuredClone(value) }
function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function parseOrigin(value: unknown): string | undefined {
  if (!nonEmpty(value)) return undefined
  try { return new URL(value).origin } catch { return undefined }
}
function patternMatches(pattern: string, origin: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith('/*')) return patternMatches(pattern.slice(0, -2), origin)
  if (pattern.includes('*')) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp(`^${escaped}$`, 'i').test(origin)
  }
  return pattern.toLowerCase() === origin.toLowerCase()
}
function policyValues(policy: OriginPolicy, key: 'allow' | 'deny' | 'requireConfirmation'): string[] {
  if (key === 'allow') return policy.allow ?? policy.allowed ?? []
  if (key === 'deny') return policy.deny ?? policy.blocked ?? []
  return policy.requireConfirmation ?? policy.confirmation ?? []
}
/** Returns the origin admission decision for a profile. */
export function originAdmission(policy: OriginPolicy, candidateUrl: string): { allowed: boolean; requiresConfirmation: boolean; origin?: string; reason?: string } {
  const origin = parseOrigin(candidateUrl)
  if (!origin) return { allowed: false, requiresConfirmation: false, reason: 'invalid-origin' }
  if (policyValues(policy, 'deny').some((entry) => patternMatches(entry, origin))) return { allowed: false, requiresConfirmation: false, origin, reason: 'origin-denied' }
  if (!policyValues(policy, 'allow').some((entry) => patternMatches(entry, origin))) return { allowed: false, requiresConfirmation: false, origin, reason: 'origin-not-allowed' }
  return { allowed: true, requiresConfirmation: policyValues(policy, 'requireConfirmation').some((entry) => patternMatches(entry, origin)), origin }
}
function defaultRisk(kind: ActionKind): RiskLevel {
  return kind === 'navigate' || kind === 'read' || kind === 'download' || kind === 'screenshot' || kind === 'wait' || kind === 'assert' ? 'read' : 'local-reversible'
}
function requiredPermission(kind: ActionKind, risk: RiskLevel): keyof BrowserPermissions | undefined {
  if (EXTERNAL_RISKS.has(risk)) return risk === 'external-reversible' ? 'externalReversible' : 'externalIrreversible'
  if (kind === 'navigate') return 'navigate'
  if (kind === 'read') return 'read'
  if (kind === 'input' || kind === 'click' || kind === 'select') return 'input'
  if (kind === 'upload') return 'upload'
  if (kind === 'download') return 'download'
  if (kind === 'screenshot') return 'screenshot'
  if (kind === 'wait') return 'wait'
  if (kind === 'assert') return 'assert'
  return undefined
}
function requiredArgumentMessage(action: BrowserAction): string | undefined {
  const args = action.arguments ?? {}
  const target = action.target ?? {}
  if (action.kind === 'navigate' && !nonEmpty(target.url ?? args.url)) return 'navigate requires a URL'
  if (TARGET_REQUIRED.has(action.kind) && !Object.keys(target).length) return `${action.kind} requires a structured target`
  if (action.kind === 'input' && !nonEmpty(args.value) && !nonEmpty(args.credentialRef)) return 'input requires value or credentialRef'
  if (action.kind === 'upload' && (!nonEmpty(args.projectFileId) || 'path' in args)) return 'upload requires projectFileId and forbids local path'
  if (action.kind === 'download' && !nonEmpty(target.url ?? args.url)) return 'download requires a URL or target'
  if (action.kind === 'screenshot' && args.mode !== undefined && !['viewport', 'region', 'fullPage'].includes(String(args.mode))) return 'screenshot mode must be viewport, region, or fullPage'
  if (action.kind === 'wait' && (!nonEmpty(args.condition) || (args.timeoutMs !== undefined && (!Number.isFinite(Number(args.timeoutMs)) || Number(args.timeoutMs) <= 0)))) return 'wait requires a bounded condition and timeout'
  if (action.kind === 'assert' && !nonEmpty(args.expression)) return 'assert requires an expression'
  return undefined
}
/** Structural checks applied before origin/permission admission. */
export function validateBrowserAction(action: BrowserAction): string[] {
  const reasons: string[] = []
  if (!action || typeof action !== 'object') return ['action must be an object']
  if (!nonEmpty(action.id)) reasons.push('action.id is required')
  if (!nonEmpty(action.runId)) reasons.push('action.runId is required')
  if (!nonEmpty(action.sessionId)) reasons.push('action.sessionId is required')
  if (!nonEmpty(action.tabId)) reasons.push('action.tabId is required')
  if (!Number.isInteger(action.sequence) || action.sequence < 1) reasons.push('action.sequence must be a positive integer')
  if (!ACTION_STATUSES.includes(action.status as ProductActionStatus)) reasons.push('unsupported action status')
  if (!ACTION_KINDS.has(action.kind)) reasons.push('unsupported action kind')
  if (!RISKS.has(action.risk)) reasons.push('unsupported risk')
  if (!nonEmpty(action.idempotencyKey)) reasons.push('action.idempotencyKey is required')
  if (!action.target || typeof action.target !== 'object' || Array.isArray(action.target)) reasons.push('action.target must be structured')
  if (!action.arguments || typeof action.arguments !== 'object' || Array.isArray(action.arguments)) reasons.push('action.arguments must be structured')
  if (!Array.isArray(action.preconditions)) reasons.push('action.preconditions must be an array')
  if (action.timeoutMs !== undefined && (!Number.isInteger(action.timeoutMs) || action.timeoutMs <= 0 || action.timeoutMs > 10 * 60 * 1000)) reasons.push('timeoutMs must be 1-600000')
  if (action.kind && action.arguments && action.target) {
    const message = requiredArgumentMessage(action)
    if (message) reasons.push(message)
  }
  if (action.authorization?.expiresAt && Number.isNaN(Date.parse(action.authorization.expiresAt))) reasons.push('authorization.expiresAt must be an ISO timestamp')
  return reasons
}
function permissionAllowed(profile: BrowserProfile, action: BrowserAction): boolean {
  const permission = requiredPermission(action.kind, action.risk)
  if (!permission) return false
  if (profile.permissions.actions && !profile.permissions.actions.includes(action.kind)) return false
  if (profile.permissions.risks && !profile.permissions.risks.includes(action.risk)) return false
  // A missing permission is deliberately deny-by-default. Profiles may opt in
  // to a capability explicitly, keeping a broad project scope from widening a
  // narrower browser profile.
  return profile.permissions[permission] === true
}
function authorized(action: BrowserAction, now: string): boolean {
  const auth = action.authorization
  if (!auth?.confirmed) return false
  if (auth.expiresAt && Date.parse(auth.expiresAt) <= Date.parse(now)) return false
  return true
}
function actionUrl(action: BrowserAction, tab?: Tab): string | undefined {
  if (action.kind === 'navigate' || action.kind === 'read' || action.kind === 'download') return String(action.target.url ?? action.arguments.url ?? '') || undefined
  return tab?.url
}
function newReceipt(actionId: string, status: ReceiptStatus, now: string, error?: { code: string; message: string; recovery?: string }): Receipt {
  return { id: `receipt-${actionId}`, actionId, status, attempts: [], result: {}, externalEffect: status === 'unknown' ? 'possible' : 'none', evidenceRefs: [], artifactRefs: [], ...(error ? { error } : {}), settledAt: now, type: 'Receipt', sideEffect: status === 'unknown' ? 'unknown' : 'none' }
}

/** An in-memory Browser Capability boundary with deterministic admission checks. */
export class BrowserCapability {
  private readonly now: () => string
  private readonly idFactory: (prefix: string) => string
  private readonly profiles = new Map<string, BrowserProfile>()
  private readonly sessions = new Map<string, BrowserSession>()
  private readonly tabs = new Map<string, Tab>()
  private readonly pageStates = new Map<string, PageState>()
  private readonly actions = new Map<string, BrowserAction>()
  private readonly receipts = new Map<string, Receipt>()
  private readonly idempotency = new Map<string, string>()
  private readonly evidences = new Map<string, Evidence>()
  private readonly artifacts = new Map<string, Artifact>()
  private readonly checkpoints = new Map<string, BrowserCheckpoint>()
  private readonly nextSequences = new Map<string, number>()
  constructor(options: BrowserCapabilityOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString())
    let serial = 0
    this.idFactory = options.idFactory ?? ((prefix) => `${prefix}-${Date.now().toString(36)}-${++serial}`)
  }
  createProfile(input: Omit<BrowserProfile, 'revision' | 'status' | 'updatedAt'> & Partial<Pick<BrowserProfile, 'revision' | 'status' | 'updatedAt'>>): BrowserProfile {
    if (this.profiles.has(input.id)) throw new Error(`profile already exists: ${input.id}`)
    const profile: BrowserProfile = { ...copy(input), revision: input.revision ?? 1, status: input.status ?? 'ready', updatedAt: input.updatedAt ?? this.now(), credentialRefs: [...input.credentialRefs], uploadRoots: [...input.uploadRoots] }
    this.profiles.set(profile.id, profile)
    return copy(profile)
  }
  getProfile(id: string): BrowserProfile | undefined { const value = this.profiles.get(id); return value ? copy(value) : undefined }
  createSession(input: Omit<BrowserSession, 'status' | 'tabIds' | 'startedAt' | 'lastHeartbeatAt'> & Partial<Pick<BrowserSession, 'status' | 'tabIds' | 'startedAt' | 'lastHeartbeatAt'>>): BrowserSession {
    const profile = this.profiles.get(input.profileId)
    if (!profile) throw new Error('profile-not-found')
    if (profile.status !== 'ready') throw new Error(`profile-${profile.status}`)
    if (input.profileRevision !== profile.revision) throw new Error('profile-revision-mismatch')
    if (this.sessions.has(input.id)) throw new Error(`session already exists: ${input.id}`)
    const timestamp = this.now()
    const session: BrowserSession = { ...copy(input), status: input.status ?? 'created', tabIds: [...(input.tabIds ?? [])], startedAt: input.startedAt ?? timestamp, lastHeartbeatAt: input.lastHeartbeatAt ?? timestamp }
    this.sessions.set(session.id, session)
    this.nextSequences.set(session.runId, 1)
    return copy(session)
  }
  getSession(id: string): BrowserSession | undefined { const value = this.sessions.get(id); return value ? copy(value) : undefined }
  createTab(input: Tab): Tab {
    const session = this.sessions.get(input.sessionId)
    if (!session) throw new Error('session-not-found')
    if (this.tabs.has(input.id)) throw new Error(`tab already exists: ${input.id}`)
    const origin = parseOrigin(input.url) ?? input.origin
    if (!origin) throw new Error('tab-url-invalid')
    const tab = { ...copy(input), origin }
    this.tabs.set(tab.id, tab)
    session.tabIds.push(tab.id)
    session.lastHeartbeatAt = this.now()
    return copy(tab)
  }
  getTab(id: string): Tab | undefined { const value = this.tabs.get(id); return value ? copy(value) : undefined }
  capturePageState(input: PageState): PageState {
    const tab = this.tabs.get(input.tabId)
    if (!tab) throw new Error('tab-not-found')
    if (!parseOrigin(input.url)) throw new Error('page-url-invalid')
    const previous = tab.pageStateId ? this.pageStates.get(tab.pageStateId) : undefined
    if (previous) previous.stale = true
    const value = copy(input)
    this.pageStates.set(value.id, value)
    tab.pageStateId = value.id
    tab.url = value.url
    tab.origin = parseOrigin(value.url) ?? tab.origin
    tab.title = value.title
    tab.status = value.stale ? 'open' : 'interactive'
    return copy(value)
  }
  getPageState(id: string): PageState | undefined { const value = this.pageStates.get(id); return value ? copy(value) : undefined }
  getAction(id: string): BrowserAction | undefined { const value = this.actions.get(id); return value ? copy(value) : undefined }
  getReceipt(id: string): Receipt | undefined { const value = this.receipts.get(id); return value ? copy(value) : undefined }
  getEvidence(id: string): Evidence | undefined { const value = this.evidences.get(id); return value ? copy(value) : undefined }
  getArtifact(id: string): Artifact | undefined { const value = this.artifacts.get(id); return value ? copy(value) : undefined }
  getCheckpoint(id: string): BrowserCheckpoint | undefined { const value = this.checkpoints.get(id); return value ? copy(value) : undefined }
  /** Return a detached snapshot suitable for RuntimeLoop/SQLite persistence. */
  exportState(): BrowserCapabilitySnapshot {
    return copy({
      version: 1 as const,
      profiles: [...this.profiles.values()],
      sessions: [...this.sessions.values()],
      tabs: [...this.tabs.values()],
      pageStates: [...this.pageStates.values()],
      actions: [...this.actions.values()],
      receipts: [...this.receipts.values()],
      idempotency: [...this.idempotency.entries()],
      evidences: [...this.evidences.values()],
      artifacts: [...this.artifacts.values()],
      checkpoints: [...this.checkpoints.values()],
      nextSequences: [...this.nextSequences.entries()],
    })
  }
  /** Restore a previously persisted capability snapshot without emitting events. */
  restoreState(input: Partial<BrowserCapabilitySnapshot> | undefined | null): void {
    if (!input) return
    this.profiles.clear()
    this.sessions.clear()
    this.tabs.clear()
    this.pageStates.clear()
    this.actions.clear()
    this.receipts.clear()
    this.idempotency.clear()
    this.evidences.clear()
    this.artifacts.clear()
    this.checkpoints.clear()
    this.nextSequences.clear()
    for (const value of input.profiles ?? []) this.profiles.set(value.id, copy(value))
    for (const value of input.sessions ?? []) this.sessions.set(value.id, copy(value))
    for (const value of input.tabs ?? []) this.tabs.set(value.id, copy(value))
    for (const value of input.pageStates ?? []) this.pageStates.set(value.id, copy(value))
    for (const value of input.actions ?? []) this.actions.set(value.id, copy(value))
    for (const value of input.receipts ?? []) this.receipts.set(value.id, copy(value))
    for (const [key, value] of input.idempotency ?? []) this.idempotency.set(key, value)
    for (const value of input.evidences ?? []) this.evidences.set(value.id, copy(value))
    for (const value of input.artifacts ?? []) this.artifacts.set(value.id, copy(value))
    for (const value of input.checkpoints ?? []) this.checkpoints.set(value.id, copy(value))
    for (const [key, value] of input.nextSequences ?? []) this.nextSequences.set(key, value)
  }
  /** Admit an action and persist its not-executed receipt before dispatch. */
  admitAction(input: BrowserAction): AdmissionResult {
    const action = copy(input)
    const reasons = validateBrowserAction(action)
    const session = this.sessions.get(action.sessionId)
    const tab = this.tabs.get(action.tabId)
    const profile = session ? this.profiles.get(session.profileId) : undefined
    const currentState = tab?.pageStateId ? this.pageStates.get(tab.pageStateId) : undefined
    const key = `${action.runId}:${action.idempotencyKey}`
    const existingId = this.idempotency.get(key)
    if (existingId) {
      const existingAction = this.actions.get(existingId)
      const existingReceipt = this.receipts.get(`receipt-${existingId}`)
      if (existingAction && existingReceipt) {
        const fingerprint = `${existingAction.kind}|${JSON.stringify(existingAction.target)}|${JSON.stringify(existingAction.arguments)}`
        const incomingFingerprint = `${action.kind}|${JSON.stringify(action.target)}|${JSON.stringify(action.arguments)}`
        const duplicateReasons = fingerprint === incomingFingerprint ? [] : ['idempotency-key-collision']
        return { disposition: 'duplicate', action: copy(existingAction), receipt: copy(existingReceipt), reasons: duplicateReasons, requiresAuthorization: existingAction.status === 'awaiting_authorization' }
      }
    }
    if (!session) reasons.push('session-not-found')
    if (!tab) reasons.push('tab-not-found')
    if (session && action.runId !== session.runId) reasons.push('run-mismatch')
    if (session && profile && profile.status !== 'ready') reasons.push(`profile-${profile.status}`)
    if (session && profile && session.profileRevision !== profile.revision) reasons.push('profile-revision-mismatch')
    const previousSequence = this.nextSequences.get(action.runId) ?? 1
    if (Number.isInteger(action.sequence) && action.sequence !== previousSequence) reasons.push(`sequence-must-be-${previousSequence}`)
    if (tab && profile) {
      const url = actionUrl(action, tab)
      if (url) {
        const origin = originAdmission(profile.originPolicy, url)
        if (!origin.allowed) reasons.push(origin.reason ?? 'origin-not-allowed')
        if (origin.requiresConfirmation && !authorized(action, this.now())) reasons.push('origin-requires-confirmation')
      }
    }
    if (profile && action.kind === 'download' && profile.downloadPolicy === 'deny') reasons.push('download-denied')
    if (profile && action.kind === 'upload') {
      const projectFileId = action.arguments.projectFileId
      const roots = profile.uploadRoots
      if (!nonEmpty(projectFileId) || !roots.some((root) => projectFileId === root || projectFileId.startsWith(root.endsWith(':') ? root : `${root}/`))) reasons.push('upload-root-denied')
    }
    if (profile && !permissionAllowed(profile, action)) reasons.push('permission-denied')
    if (PAGE_TARGET_REQUIRED.has(action.kind)) {
      const targetPageStateId = action.target.pageStateId
      if (targetPageStateId && (!currentState || targetPageStateId !== currentState.id)) reasons.push('stale-target')
      if (currentState?.stale) reasons.push('stale-page-state')
    }
    const needsAuth = EXTERNAL_RISKS.has(action.risk) || reasons.includes('origin-requires-confirmation')
    if (needsAuth && !authorized(action, this.now())) reasons.push('authorization-required')
    const uniqueReasons = [...new Set(reasons)]
    const authorizationReasons = new Set(['authorization-required', 'origin-requires-confirmation'])
    const rejected = uniqueReasons.some((reason) => !authorizationReasons.has(reason))
    action.status = rejected ? 'rejected' : needsAuth && !authorized(action, this.now()) ? 'awaiting_authorization' : 'admitted'
    const receipt = newReceipt(action.id, 'not_executed', this.now(), uniqueReasons.length ? { code: rejected ? 'ADMISSION_REJECTED' : 'AWAITING_AUTHORIZATION', message: uniqueReasons.join('; ') } : undefined)
    this.actions.set(action.id, action)
    this.receipts.set(receipt.id, receipt)
    this.idempotency.set(key, action.id)
    this.nextSequences.set(action.runId, previousSequence + 1)
    return { disposition: rejected ? 'rejected' : 'accepted', action: copy(action), receipt: copy(receipt), reasons: uniqueReasons, requiresAuthorization: action.status === 'awaiting_authorization' }
  }
  admit(input: BrowserAction): AdmissionResult { return this.admitAction(input) }
  startAction(actionId: string): Receipt {
    const action = this.actions.get(actionId)
    const receipt = this.receipts.get(`receipt-${actionId}`)
    if (!action || !receipt) throw new Error('action-not-found')
    if (action.status !== 'admitted') return copy(receipt)
    action.status = 'running'
    receipt.status = 'started'
    receipt.attempts.push({ id: this.idFactory('attempt'), startedAt: this.now(), status: 'started' })
    receipt.settledAt = this.now()
    return copy(receipt)
  }
  /** Settle a gateway result. External success requires evidence and confirmation. */
  settleAction(actionId: string, result: { status: Extract<ActionStatus, 'succeeded' | 'failed' | 'unknown' | 'cancelled'>; result?: Record<string, unknown>; afterPageStateId?: string; evidenceRefs?: string[]; artifactRefs?: string[]; externalEffect?: ExternalEffect; error?: { code: string; message: string; recovery?: string } }): Receipt {
    const action = this.actions.get(actionId)
    const receipt = this.receipts.get(`receipt-${actionId}`)
    if (!action || !receipt) throw new Error('action-not-found')
    if (action.status === 'rejected' || action.status === 'awaiting_authorization') return copy(receipt)
    if (result.status === 'succeeded' && EXTERNAL_RISKS.has(action.risk) && (result.externalEffect !== 'confirmed' || !(result.evidenceRefs?.length))) {
      action.status = 'unknown'
      receipt.status = 'unknown'
      receipt.externalEffect = result.externalEffect ?? 'possible'
      receipt.error = { code: 'EXTERNAL_EFFECT_UNCONFIRMED', message: 'external action lacks confirmed result evidence', recovery: 'run a read-only recovery check' }
    } else {
      action.status = result.status
      receipt.status = result.status
      receipt.externalEffect = result.externalEffect ?? (result.status === 'succeeded' ? 'none' : result.status === 'unknown' ? 'possible' : 'none')
      receipt.result = copy(result.result ?? {})
      if (result.afterPageStateId) receipt.afterPageStateId = result.afterPageStateId
      if (result.error) receipt.error = copy(result.error)
    }
    receipt.sideEffect = receipt.externalEffect === 'confirmed'
      ? (action.risk === 'external-irreversible' ? 'external-irreversible' : action.risk === 'external-reversible' ? 'external-reversible' : 'local-reversible')
      : receipt.externalEffect === 'possible' || receipt.externalEffect === 'unknown' ? 'unknown' : 'none'
    receipt.evidenceRefs = [...(result.evidenceRefs ?? [])]
    receipt.artifactRefs = [...(result.artifactRefs ?? [])]
    const attempt = receipt.attempts.at(-1)
    if (attempt) { attempt.endedAt = this.now(); attempt.status = receipt.status === 'succeeded' ? 'succeeded' : receipt.status === 'failed' ? 'failed' : 'unknown' }
    receipt.settledAt = this.now()
    return copy(receipt)
  }
  markUnknown(actionId: string, reason = 'browser-disconnected'): Receipt {
    return this.settleAction(actionId, { status: 'unknown', externalEffect: 'possible', error: { code: 'UNKNOWN', message: reason, recovery: 'verify the external state before retrying' } })
  }
  recordEvidence(input: Omit<Evidence, 'id' | 'capturedAt'> & Partial<Pick<Evidence, 'id' | 'capturedAt'>>): Evidence {
    input.sourceRefs?.forEach((ref, index) => validateProductSourceRef(ref, `evidence.sourceRefs[${index}]`))
    const evidence: Evidence = { ...copy(input), id: input.id ?? this.idFactory('evidence'), capturedAt: input.capturedAt ?? this.now() }
    this.evidences.set(evidence.id, evidence)
    return copy(evidence)
  }
  recordArtifact(input: Omit<Artifact, 'id' | 'createdAt'> & Partial<Pick<Artifact, 'id' | 'createdAt'>>): Artifact {
    input.sourceRefs?.forEach((ref, index) => validateProductSourceRef(ref, `artifact.sourceRefs[${index}]`))
    const artifact: Artifact = { ...copy(input), id: input.id ?? this.idFactory('artifact'), createdAt: input.createdAt ?? this.now() }
    this.artifacts.set(artifact.id, artifact)
    return copy(artifact)
  }
  createCheckpoint(runId: string, openQuestions: string[] = []): BrowserCheckpoint {
    const session = [...this.sessions.values()].find((entry) => entry.runId === runId)
    if (!session) throw new Error('run-session-not-found')
    const profile = this.profiles.get(session.profileId)
    if (!profile) throw new Error('profile-not-found')
    const tabs = session.tabIds.map((id) => this.tabs.get(id)).filter((entry): entry is Tab => Boolean(entry))
    const inFlight = [...this.actions.values()].find((action) => action.runId === runId && (action.status === 'running' || action.status === 'unknown'))
    const checkpoint: BrowserCheckpoint = {
      id: this.idFactory('checkpoint'), runId, profileId: profile.id, profileRevision: profile.revision, sessionId: session.id, browserInstanceId: session.browserInstanceId,
      tabStates: tabs.map((tab) => ({ tabId: tab.id, url: tab.url, pageStateId: tab.pageStateId, stale: tab.pageStateId ? this.pageStates.get(tab.pageStateId)?.stale ?? true : true })), nextSequence: this.nextSequences.get(runId) ?? 1,
      ...(inFlight ? { inFlightActionId: inFlight.id, inFlightIdempotencyKey: inFlight.idempotencyKey } : {}), authorizationRefs: [...this.actions.values()].filter((a) => a.runId === runId && a.authorization?.authorizationRef).map((a) => a.authorization?.authorizationRef as string), receiptRefs: [...this.receipts.values()].filter((r) => this.actions.get(r.actionId)?.runId === runId).map((r) => r.id), artifactRefs: [...this.artifacts.values()].filter((a) => a.sourceRefs.some((ref) => ref.type === 'run' && ref.id === runId)).map((a) => a.id), openQuestions: [...openQuestions], checkpointAt: this.now(),
    }
    this.checkpoints.set(checkpoint.id, checkpoint)
    session.checkpointId = checkpoint.id
    return copy(checkpoint)
  }
  validateCheckpoint(checkpoint: BrowserCheckpoint): CheckpointValidation {
    const reasons: string[] = []
    const session = this.sessions.get(checkpoint.sessionId)
    const profile = this.profiles.get(checkpoint.profileId)
    if (!session) reasons.push('session-not-found')
    if (!profile) reasons.push('profile-not-found')
    if (session && checkpoint.runId !== session.runId) reasons.push('run-mismatch')
    if (session && checkpoint.profileId !== session.profileId) reasons.push('profile-mismatch')
    if (profile && checkpoint.profileRevision !== profile.revision) reasons.push('profile-revision-mismatch')
    if (session && checkpoint.nextSequence < (this.nextSequences.get(checkpoint.runId) ?? 1)) reasons.push('checkpoint-sequence-regressed')
    for (const state of checkpoint.tabStates) {
      const tab = this.tabs.get(state.tabId)
      if (!tab || tab.sessionId !== checkpoint.sessionId) reasons.push(`tab-not-found:${state.tabId}`)
      if (tab && state.pageStateId && tab.pageStateId !== state.pageStateId) reasons.push(`page-state-mismatch:${state.tabId}`)
    }
    let requiresVerification = checkpoint.openQuestions.length > 0
    if (checkpoint.inFlightActionId) {
      const action = this.actions.get(checkpoint.inFlightActionId)
      const receipt = action ? this.receipts.get(`receipt-${action.id}`) : undefined
      if (!action || !receipt) reasons.push('in-flight-action-not-found')
      else if (receipt.status === 'unknown' || action.status === 'unknown' || receipt.externalEffect === 'possible') requiresVerification = true
      else if (receipt.status === 'succeeded') reasons.push('in-flight-action-already-settled')
    }
    return { valid: reasons.length === 0, requiresVerification, reasons }
  }
  restoreCheckpoint(checkpoint: BrowserCheckpoint): CheckpointValidation {
    const validation = this.validateCheckpoint(checkpoint)
    if (!validation.valid) return validation
    const session = this.sessions.get(checkpoint.sessionId)
    if (session) { session.status = validation.requiresVerification ? 'reconnecting' : 'resumed'; session.lastHeartbeatAt = this.now() }
    return validation
  }
}

export function admitBrowserAction(capability: BrowserCapability, action: BrowserAction): AdmissionResult { return capability.admitAction(action) }
export type BrowserCapabilityStore = BrowserCapability
export type BrowserGateway = BrowserCapability
