import {
  BrowserCapability,
  type BrowserCapabilitySnapshot,
  type AdmissionResult,
  type Artifact,
  type BrowserAction,
  type BrowserProfile,
  type BrowserSession,
  type Evidence,
  type ExternalEffect,
  type PageState,
  type Receipt as BrowserReceipt,
  type Tab,
} from './browser-capability.ts'
import {
  ProductWorkLedger,
  type Action as ProductAction,
  type ActorRef,
  type Checkpoint as ProductCheckpoint,
  type CheckpointState,
  type CreateActionInput,
  type Receipt as ProductReceipt,
  type ReconcileInput,
  type SideEffect,
  type SourceRef,
  type ProductWorkLedgerSnapshot,
} from './product-work-ledger.ts'

export type BrowserExecutionStatus = 'succeeded' | 'failed' | 'unknown'

export interface BrowserExecutionResult {
  status: BrowserExecutionStatus
  result?: Record<string, unknown>
  afterPageStateId?: string
  externalEffect?: ExternalEffect
  error?: { code: string; message: string; recovery?: string }
  evidence?: Array<Omit<Evidence, 'id' | 'capturedAt'> & Partial<Pick<Evidence, 'id' | 'capturedAt'>>>
  artifacts?: Array<Omit<Artifact, 'id' | 'createdAt'> & Partial<Pick<Artifact, 'id' | 'createdAt'>>>
}

export interface BrowserExecutionRequest {
  action: BrowserAction
  profile: BrowserProfile
  session: BrowserSession
  tab: Tab
  pageState?: PageState
  attempt: number
}

/** Typed seam for a real Browser Gateway adapter. */
export type BrowserExecutor = (request: BrowserExecutionRequest) => Promise<BrowserExecutionResult>

export interface BrowserGatewayServiceOptions {
  capability?: BrowserCapability
  ledger?: ProductWorkLedger
  executor?: BrowserExecutor
  actor?: ActorRef
  now?: () => string
}

export interface BrowserGatewayAdmission {
  browser: AdmissionResult
  ledgerAction?: ProductAction
  ledgerReceipt?: ProductReceipt
}

export interface BrowserGatewayExecution {
  admission: BrowserGatewayAdmission
  browserReceipt: BrowserReceipt
  ledgerReceipt?: ProductReceipt
  evidence: Evidence[]
  artifacts: Artifact[]
}

export interface BrowserGatewayReconciliation {
  browserReceipt?: BrowserReceipt
  ledgerReceipt: ProductReceipt
  reconciliationActionId: string
}

export interface BrowserGatewayCheckpoint {
  browser: ReturnType<BrowserCapability['createCheckpoint']>
  ledger: ProductCheckpoint
}

export interface BrowserGatewayRecovery {
  valid: boolean
  requiresVerification: boolean
  browserReasons: string[]
  ledgerReasons: string[]
  sessionStatus?: BrowserSession['status']
}

/** Serializable Browser Gateway state stored alongside RuntimeLoopState. */
export type BrowserGatewayState = {
  version: 1
  capability: BrowserCapabilitySnapshot
  ledger: ProductWorkLedgerSnapshot
  browserCheckpoints: Array<[string, ReturnType<BrowserCapability['createCheckpoint']>]>
  evidence: Evidence[]
  artifacts: Artifact[]
}

const productRisk: Record<BrowserAction['risk'], ProductAction['risk']> = {
  read: 'read',
  'local-reversible': 'reversible-write',
  'external-reversible': 'external-side-effect',
  'external-irreversible': 'destructive',
}
const permissionLevel: Record<BrowserAction['risk'], CreateActionInput['permissionRequest']['level']> = {
  read: 'L0',
  'local-reversible': 'L2',
  'external-reversible': 'L3',
  'external-irreversible': 'L4',
}

function clone<T>(value: T): T { return structuredClone(value) }

function hostFor(action: BrowserAction, tab: Tab): string | undefined {
  const value = action.kind === 'navigate' || action.kind === 'read' || action.kind === 'download'
    ? action.target.url ?? action.arguments.url
    : tab.url
  if (typeof value !== 'string') return undefined
  try { return new URL(value).host } catch { return undefined }
}

function sideEffectFor(action: BrowserAction, externalEffect?: ExternalEffect): SideEffect {
  if (externalEffect === 'possible' || externalEffect === 'unknown') return 'unknown'
  if (externalEffect === 'confirmed') return action.risk === 'external-irreversible' ? 'external-irreversible' : action.risk === 'external-reversible' ? 'external-reversible' : 'local-reversible'
  if (externalEffect === undefined) return action.risk === 'external-irreversible' ? 'external-irreversible' : action.risk === 'external-reversible' ? 'external-reversible' : action.risk === 'local-reversible' ? 'local-reversible' : 'none'
  return 'none'
}

function errorFor(error: BrowserExecutionResult['error'], status: BrowserExecutionStatus): ProductReceipt['error'] | undefined {
  if (!error && status === 'succeeded') return undefined
  const value = error ?? { code: status === 'unknown' ? 'BROWSER_UNKNOWN' : 'BROWSER_FAILED', message: status === 'unknown' ? 'browser result is unknown' : 'browser action failed' }
  return { code: value.code, message: value.message, retryable: status === 'unknown' }
}

export class BrowserGatewayService {
  readonly capability: BrowserCapability
  readonly ledger: ProductWorkLedger
  private readonly executor?: BrowserExecutor
  private readonly actor: ActorRef
  private readonly browserCheckpoints = new Map<string, ReturnType<BrowserCapability['createCheckpoint']>>()
  private readonly evidence = new Map<string, Evidence>()
  private readonly artifacts = new Map<string, Artifact>()

  constructor(options: BrowserGatewayServiceOptions = {}) {
    this.capability = options.capability ?? new BrowserCapability({ now: options.now })
    this.ledger = options.ledger ?? new ProductWorkLedger({ now: options.now, actor: options.actor })
    this.executor = options.executor
    this.actor = options.actor ?? { type: 'capability-adapter', id: 'browser-gateway' }
  }

  getEvidence(id: string): Evidence | undefined { const value = this.evidence.get(id); return value ? clone(value) : undefined }
  getArtifact(id: string): Artifact | undefined { const value = this.artifacts.get(id); return value ? clone(value) : undefined }
  exportState(): BrowserGatewayState {
    return clone({
      version: 1 as const,
      capability: this.capability.exportState(),
      ledger: this.ledger.exportState(),
      browserCheckpoints: [...this.browserCheckpoints.entries()],
      evidence: [...this.evidence.values()],
      artifacts: [...this.artifacts.values()],
    })
  }
  restoreState(input: Partial<BrowserGatewayState> | undefined | null): void {
    if (!input) return
    this.capability.restoreState(input.capability)
    this.ledger.restoreState(input.ledger)
    this.browserCheckpoints.clear()
    this.evidence.clear()
    this.artifacts.clear()
    for (const [id, checkpoint] of input.browserCheckpoints ?? []) this.browserCheckpoints.set(id, clone(checkpoint))
    for (const value of input.evidence ?? []) this.evidence.set(value.id, clone(value))
    for (const value of input.artifacts ?? []) this.artifacts.set(value.id, clone(value))
  }

  private productAction(action: BrowserAction): CreateActionInput {
    const session = this.capability.getSession(action.sessionId)
    if (!session) throw new Error('session-not-found')
    const profile = this.capability.getProfile(session.profileId)
    const tab = this.capability.getTab(action.tabId)
    if (!profile || !tab) throw new Error('browser-context-not-found')
    const projectId = profile.projectId
    const host = hostFor(action, tab)
    const sourceRefs: SourceRef[] = [
      { type: 'session', id: session.id, relation: 'references' },
      { type: 'run', id: action.runId, relation: 'references' },
    ]
    const permissionRequest: CreateActionInput['permissionRequest'] = {
      level: permissionLevel[action.risk], actorId: action.authorization?.actor ?? this.actor.id, projectId,
      capabilityId: `browser:${profile.id}`, operation: `browser.${action.kind}`,
      targetSummary: action.target.name ?? action.target.label ?? action.target.url ?? action.kind,
      scope: host ? { hosts: [host] } : {}, reason: `Browser ${action.kind} requested by run ${action.runId}`,
      expectedSideEffect: action.risk,
      ...(action.authorization?.authorizationRef ? { authorizationRef: action.authorization.authorizationRef } : {}),
    }
    return {
      id: action.id, runId: action.runId, capabilityId: `browser:${profile.id}`, operation: `browser.${action.kind}`,
      arguments: clone(action.arguments), target: { projectId, ...(host ? { host } : {}), ...(action.target.name ? { objectId: action.target.name } : {}) },
      risk: productRisk[action.risk], permissionRequest,
      idempotencyKey: `${action.runId}:${action.idempotencyKey}`, cancelMode: 'cooperative', timeoutMs: action.timeoutMs,
      status: action.status, actor: this.actor, projectId, sourceRefs,
    }
  }

  admitAction(action: BrowserAction): BrowserGatewayAdmission {
    const browser = this.capability.admitAction(action)
    if (browser.disposition === 'duplicate') {
      return { browser, ledgerAction: this.ledger.getAction(browser.action.id), ledgerReceipt: this.ledger.getReceipt(browser.action.id) }
    }
    let ledgerAction: ProductAction
    try {
      ledgerAction = this.ledger.createAction(this.productAction(browser.action))
    } catch (error) {
      // A malformed browser action cannot be represented by the product
      // envelope. The browser admission remains the authoritative rejection.
      if (browser.disposition === 'rejected') return { browser }
      throw error
    }
    if (browser.action.status === 'awaiting_authorization') return { browser, ledgerAction }
    const ledgerAdmission = this.ledger.admitAction(ledgerAction, {
      capability: {
        state: 'available', requiredPermission: permissionLevel[browser.action.risk],
        scope: { projectIds: [ledgerAction.projectId], ...(ledgerAction.target.host ? { hosts: [ledgerAction.target.host] } : {}) }, risk: ledgerAction.risk,
      },
      schemaValid: browser.disposition === 'accepted', scopeAllowed: browser.disposition === 'accepted',
      policyAllowed: browser.disposition === 'accepted', authorized: browser.action.status === 'admitted', projectId: ledgerAction.projectId,
    })
    let ledgerReceipt = ledgerAdmission.receipt
    if (ledgerAdmission.disposition === 'accepted' && !ledgerReceipt) {
      ledgerReceipt = this.ledger.recordReceipt({ actionId: ledgerAdmission.action.id, status: 'accepted', evidenceRefs: [], sideEffect: 'none', idempotencyKey: `browser-accepted:${action.id}` })
    }
    return { browser, ledgerAction: ledgerAdmission.action, ...(ledgerReceipt ? { ledgerReceipt } : {}) }
  }

  admit(action: BrowserAction): BrowserGatewayAdmission { return this.admitAction(action) }

  private persistEvidence(action: BrowserAction, receiptId: string, inputs: BrowserExecutionResult['evidence']): Evidence[] {
    const values: Evidence[] = []
    for (const input of inputs ?? []) {
      const sourceRefs = input.sourceRefs ?? [
        { type: 'action' as const, id: action.id, relation: 'references' as const },
        { type: 'run' as const, id: action.runId, relation: 'references' as const },
      ]
      const evidence = this.capability.recordEvidence({ ...clone(input), id: input.id, capturedAt: input.capturedAt, sourceRefs, receiptId, actionId: action.id })
      this.evidence.set(evidence.id, evidence)
      values.push(evidence)
      this.ledger.appendRunEvent(action.runId, {
        eventType: 'evidence.captured', idempotencyKey: `browser-evidence:${evidence.id}`, projectId: this.capability.getProfile(this.capability.getSession(action.sessionId)?.profileId ?? '')?.projectId,
        actor: this.actor, sourceRefs: [{ type: 'evidence', id: evidence.id, relation: 'produced-by' }, { type: 'action', id: action.id, relation: 'references' }], payload: { evidenceId: evidence.id, receiptId },
      })
    }
    return values
  }

  private persistArtifacts(action: BrowserAction, receiptId: string, inputs: BrowserExecutionResult['artifacts']): Artifact[] {
    const values: Artifact[] = []
    for (const input of inputs ?? []) {
      const sourceRefs = input.sourceRefs ?? [
        { type: 'action' as const, id: action.id, relation: 'produced-by' as const },
        { type: 'receipt' as const, id: receiptId, relation: 'references' as const },
      ]
      const artifact = this.capability.recordArtifact({ ...clone(input), id: input.id, createdAt: input.createdAt, sourceRefs })
      this.artifacts.set(artifact.id, artifact)
      values.push(artifact)
      this.ledger.appendRunEvent(action.runId, {
        eventType: 'artifact.created', idempotencyKey: `browser-artifact:${artifact.id}`, projectId: this.capability.getProfile(this.capability.getSession(action.sessionId)?.profileId ?? '')?.projectId,
        actor: this.actor, sourceRefs: [{ type: 'artifact', id: artifact.id, relation: 'produced-by' }, { type: 'receipt', id: receiptId, relation: 'references' }], payload: { artifactId: artifact.id, receiptId },
      })
    }
    return values
  }

  async execute(action: BrowserAction): Promise<BrowserGatewayExecution> {
    const admission = this.admitAction(action)
    if (admission.browser.disposition !== 'accepted' || admission.browser.action.status !== 'admitted') {
      return { admission, browserReceipt: admission.browser.receipt, ...(admission.ledgerReceipt ? { ledgerReceipt: admission.ledgerReceipt } : {}), evidence: [], artifacts: [] }
    }
    const accepted = admission.ledgerAction
    const session = this.capability.getSession(action.sessionId)
    const profile = session ? this.capability.getProfile(session.profileId) : undefined
    const tab = this.capability.getTab(action.tabId)
    if (!session || !profile || !tab) throw new Error('browser-context-not-found')
    const pageState = tab.pageStateId ? this.capability.getPageState(tab.pageStateId) : undefined
    const started = this.capability.startAction(action.id)
    if (accepted) this.ledger.recordReceipt({ actionId: accepted.id, status: 'started', sideEffect: sideEffectFor(action), idempotencyKey: `browser-start:${action.id}` })
    let result: BrowserExecutionResult
    try {
      result = this.executor ? await this.executor({ action: admission.browser.action, profile, session, tab, pageState, attempt: started.attempts.length }) : { status: 'unknown', error: { code: 'NO_EXECUTOR', message: 'no browser executor was configured', recovery: 'attach a Browser Gateway executor' } }
    } catch (error) {
      result = { status: 'unknown', error: { code: 'EXECUTOR_DISCONNECTED', message: error instanceof Error ? error.message : 'browser executor failed', recovery: 'verify the external state before retrying' }, externalEffect: 'possible' }
    }
    const evidence = this.persistEvidence(action, started.id, result.evidence)
    const artifacts = this.persistArtifacts(action, started.id, result.artifacts)
    const browserReceipt = this.capability.settleAction(action.id, { ...result, evidenceRefs: evidence.map((item) => item.id), artifactRefs: artifacts.map((item) => item.id) })
    let ledgerReceipt: ProductReceipt | undefined
    if (accepted && browserReceipt.status !== 'not_executed') {
      ledgerReceipt = this.ledger.recordReceipt({
        actionId: accepted.id,
        status: browserReceipt.status as Extract<ProductReceipt['status'], 'succeeded' | 'failed' | 'unknown' | 'cancelled'>,
        evidenceRefs: evidence.map((item) => item.id), sideEffect: sideEffectFor(action, browserReceipt.externalEffect),
        error: errorFor(result.error, result.status), idempotencyKey: `browser-result:${action.id}:${browserReceipt.status}`,
      })
    }
    return { admission, browserReceipt, ...(ledgerReceipt ? { ledgerReceipt } : {}), evidence, artifacts }
  }

  async executeAction(action: BrowserAction): Promise<BrowserGatewayExecution> { return this.execute(action) }

  reconcile(actionId: string, input: Omit<ReconcileInput, 'actionId'>): BrowserGatewayReconciliation {
    const action = this.capability.getAction(actionId)
    const reconciliationSideEffect = action
      ? sideEffectFor(action, input.outcome === 'succeeded' && action.risk !== 'read' ? 'confirmed' : input.outcome === 'failed' ? 'rejected' : 'none')
      : input.sideEffect
    const ledgerReceipt = this.ledger.reconcileUnknown({ ...input, actionId, ...(reconciliationSideEffect ? { sideEffect: reconciliationSideEffect } : {}) })
    let browserReceipt: BrowserReceipt | undefined
    if (action && (input.outcome === 'succeeded' || input.outcome === 'failed')) {
      browserReceipt = this.capability.settleAction(actionId, {
        status: input.outcome,
        evidenceRefs: input.evidenceRefs,
        externalEffect: input.outcome === 'succeeded' ? (action.risk === 'read' ? 'none' : 'confirmed') : 'rejected',
        error: input.outcome === 'failed' ? { code: 'RECONCILED_FAILURE', message: input.reason ?? 'reconciled as failed', recovery: 'start a new action if needed' } : undefined,
      })
    }
    return { ...(browserReceipt ? { browserReceipt } : {}), ledgerReceipt, reconciliationActionId: ledgerReceipt.reconciliationActionId }
  }

  reconcileUnknown(actionId: string, input: Omit<ReconcileInput, 'actionId'>): BrowserGatewayReconciliation { return this.reconcile(actionId, input) }

  createCheckpoint(runId: string, options: { openQuestions?: string[]; id?: string } = {}): BrowserGatewayCheckpoint {
    const browser = this.capability.createCheckpoint(runId, options.openQuestions ?? [])
    this.browserCheckpoints.set(browser.id, browser)
    const actions = this.ledger.getActionsForRun(runId)
    const latest = actions.map((item) => ({ action: item, receipt: this.ledger.getReceipt(item.id) }))
    const completedActionIds = latest.filter(({ action, receipt }) => action.status === 'succeeded' || receipt?.status === 'succeeded').map(({ action }) => action.id)
    const pendingActionIds = latest.filter(({ action }) => ['proposed', 'awaiting_authorization', 'admitted', 'running', 'unknown'].includes(action.status)).map(({ action }) => action.id)
    const failed = latest.filter(({ action, receipt }) => action.status === 'failed' || receipt?.status === 'failed').map(({ action }) => action.id)
    const unknown = latest.filter(({ action, receipt }) => action.status === 'unknown' || receipt?.status === 'unknown').map(({ action }) => action.id)
    const state: CheckpointState = unknown.length || (options.openQuestions?.length ?? 0) > 0 ? 'needs-reconciliation' : 'resumable'
    const checkpoint = this.ledger.createCheckpoint({
      id: options.id ?? browser.id, runId, projectId: actions[0]?.projectId ?? 'unknown-project',
      state, planCursor: `browser:${browser.id}`, completedActionIds, pendingActionIds,
      receiptSummary: { succeeded: completedActionIds, failed, unknown },
      openQuestions: (options.openQuestions ?? []).map((prompt, index) => ({ id: `browser-question:${browser.id}:${index + 1}`, prompt, blocking: true })),
      externalFactsToVerify: unknown,
      actor: this.actor,
      sourceRefs: [{ type: 'run', id: runId, relation: 'references' }, { type: 'checkpoint', id: browser.id, relation: 'continued-from' }],
    })
    this.browserCheckpoints.set(checkpoint.id, browser)
    return { browser, ledger: checkpoint }
  }

  recoverCheckpoint(id: string): BrowserGatewayRecovery {
    const ledger = this.ledger.getCheckpoint(id)
    const browser = this.browserCheckpoints.get(id)
    if (!ledger || !browser) return { valid: false, requiresVerification: true, browserReasons: browser ? [] : ['browser-checkpoint-not-found'], ledgerReasons: ledger ? [] : ['ledger-checkpoint-not-found'] }
    const browserValidation = this.capability.validateCheckpoint(browser)
    const ledgerValidation = (() => { try { return this.ledger.validateCheckpoint(ledger) ? [] : ['ledger-checkpoint-invalid'] } catch (error) { return [error instanceof Error ? error.message : 'ledger-checkpoint-invalid'] } })()
    const valid = browserValidation.valid && ledgerValidation.length === 0
    if (valid) this.capability.restoreCheckpoint(browser)
    return { valid, requiresVerification: browserValidation.requiresVerification || ledger.state === 'needs-reconciliation', browserReasons: browserValidation.reasons, ledgerReasons: ledgerValidation, sessionStatus: this.capability.getSession(browser.sessionId)?.status }
  }

  recover(id: string): BrowserGatewayRecovery { return this.recoverCheckpoint(id) }
}

export const BrowserGateway = BrowserGatewayService
