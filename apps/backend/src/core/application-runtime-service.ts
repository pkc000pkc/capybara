import { createHash, randomUUID } from 'node:crypto'

import {
  ApplicationVersionLifecycle,
  type ApplicationManifest,
  type ApplicationVersion,
} from '#core/application-manifest'
import {
  ProductWorkLedger,
  type Action,
  type ActionAdmissionResult,
  type ActorRef,
  type EvidenceKind,
  type EvidenceStatus,
  type Receipt,
  type SourceRef,
} from '#core/product-work-ledger'

export type ApplicationRuntimeOperation =
  | 'preview'
  | 'deploy'
  | 'start'
  | 'stop'
  | 'health_check'
  | 'update'
  | 'rollback'

export type ApplicationRuntimeEvidenceInput = {
  kind: EvidenceKind
  status?: EvidenceStatus
  projectId: string
  appId: string
  versionId: string
  runId: string
  actionId: string
  sourceRefs: SourceRef[]
  payload: unknown
  createdAt?: string
}

export interface ApplicationRuntimeEvidenceStore {
  record(input: ApplicationRuntimeEvidenceInput): ApplicationRuntimeEvidence
  attachReceipt(evidenceId: string, receiptId: string): ApplicationRuntimeEvidence
  get(evidenceId: string): ApplicationRuntimeEvidence | undefined
  list(filter?: { appId?: string; versionId?: string; runId?: string }): ApplicationRuntimeEvidence[]
}

export interface ApplicationRuntimeEvidence extends ApplicationRuntimeEvidenceInput {
  evidenceId: string
  status: EvidenceStatus
  receiptId?: string
}

export class InMemoryApplicationRuntimeEvidenceStore implements ApplicationRuntimeEvidenceStore {
  private readonly evidence = new Map<string, ApplicationRuntimeEvidence>()
  private readonly idFactory: () => string

  constructor(idFactory: () => string = () => `application-evidence-${randomUUID()}`) {
    this.idFactory = idFactory
  }

  record(input: ApplicationRuntimeEvidenceInput): ApplicationRuntimeEvidence {
    const evidence: ApplicationRuntimeEvidence = {
      ...structuredClone(input),
      evidenceId: this.idFactory(),
      status: input.status ?? 'captured',
      sourceRefs: structuredClone(input.sourceRefs),
    }
    if (this.evidence.has(evidence.evidenceId)) throw new Error(`Duplicate application runtime evidence ${evidence.evidenceId}`)
    this.evidence.set(evidence.evidenceId, evidence)
    return structuredClone(evidence)
  }

  attachReceipt(evidenceId: string, receiptId: string): ApplicationRuntimeEvidence {
    const current = this.evidence.get(evidenceId)
    if (!current) throw new Error(`Unknown application runtime evidence ${evidenceId}`)
    const refs = current.sourceRefs.some(ref => ref.type === 'receipt' && ref.id === receiptId)
      ? current.sourceRefs
      : [...current.sourceRefs, { type: 'receipt' as const, id: receiptId, relation: 'produced-by' as const }]
    const linked = { ...current, receiptId, sourceRefs: refs }
    this.evidence.set(evidenceId, linked)
    return structuredClone(linked)
  }

  get(evidenceId: string): ApplicationRuntimeEvidence | undefined {
    const value = this.evidence.get(evidenceId)
    return value ? structuredClone(value) : undefined
  }

  list(filter: { appId?: string; versionId?: string; runId?: string } = {}): ApplicationRuntimeEvidence[] {
    return [...this.evidence.values()]
      .filter(item => filter.appId === undefined || item.appId === filter.appId)
      .filter(item => filter.versionId === undefined || item.versionId === filter.versionId)
      .filter(item => filter.runId === undefined || item.runId === filter.runId)
      .map(item => structuredClone(item))
  }
}

export interface ApplicationRuntimeServiceOptions {
  manifest: ApplicationManifest
  lifecycle: ApplicationVersionLifecycle
  ledger: ProductWorkLedger
  evidence?: ApplicationRuntimeEvidenceStore
  actor?: ActorRef
  defaultRunId?: string
  now?: () => string
  host?: ApplicationRuntimeHost
}

export interface ApplicationRuntimeHostResult {
  ok: boolean
  versionId?: string
  instanceId?: string
  processId?: string | number
  port?: number
  health?: unknown
  receipt?: unknown
  evidence?: unknown
  error?: unknown
  [key: string]: unknown
}

export interface ApplicationRuntimeHost {
  start(input: { projectId: string; appId: string; versionId: string; runId: string; instanceId?: string }): Promise<ApplicationRuntimeHostResult>
  stop(input: { projectId: string; appId: string; versionId: string; runId: string; instanceId?: string }): Promise<ApplicationRuntimeHostResult>
  healthCheck(input: { projectId: string; appId: string; versionId: string; runId: string; instanceId?: string }): Promise<ApplicationRuntimeHostResult>
  update(input: { projectId: string; appId: string; currentVersionId: string; newVersionId: string; runId: string; instanceId?: string }): Promise<ApplicationRuntimeHostResult>
  rollback(input: { projectId: string; appId: string; failedVersionId: string; targetVersionId: string; runId: string; instanceId?: string }): Promise<ApplicationRuntimeHostResult>
}

export interface ApplicationRuntimeActionResult {
  ok: boolean
  operation: ApplicationRuntimeOperation
  versionId: string
  action: Action
  admission: ActionAdmissionResult
  receipt: Receipt
  evidence: ApplicationRuntimeEvidence
  manifest: ApplicationManifest
  error?: string
}

export interface ApplicationRuntimeHealthInput {
  versionId: string
  runId?: string
  passed: boolean
  smokeCheckPassed?: boolean
  latencyMs?: number
  route?: string
  message?: string
  hostResult?: unknown
}

export interface ApplicationRuntimeStopInput {
  versionId: string
  runId?: string
  instanceId?: string
  hostResult?: unknown
}

export interface ApplicationRuntimeUpdateInput {
  currentVersionId: string
  newVersionId: string
  runId?: string
  approvalRef?: string
  deploymentRef?: string
  instanceId?: string
  healthCheckRef?: string
  smokeCheckPassed?: boolean
  healthPassed?: boolean
  hostResult?: unknown
}

export interface ApplicationRuntimeRollbackInput {
  failedVersionId: string
  targetVersionId: string
  runId?: string
  reason: string
  healthCheckRef?: string
  hostResult?: unknown
}

export class ApplicationRuntimeServiceError extends Error {
  readonly operation: ApplicationRuntimeOperation
  readonly versionId: string
  readonly cause?: unknown

  constructor(operation: ApplicationRuntimeOperation, versionId: string, message: string, cause?: unknown) {
    super(`${operation} failed for ${versionId}: ${message}`)
    this.name = 'ApplicationRuntimeServiceError'
    this.operation = operation
    this.versionId = versionId
    this.cause = cause
  }
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
    }
    return item
  })).digest('hex')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function statusForEvidence(passed: boolean): EvidenceStatus {
  return passed ? 'verified' : 'captured'
}

export class ApplicationRuntimeService {
  readonly evidence: ApplicationRuntimeEvidenceStore
  private readonly manifestSeed: ApplicationManifest
  private readonly lifecycle: ApplicationVersionLifecycle
  private readonly ledger: ProductWorkLedger
  private readonly actor: ActorRef
  private readonly defaultRunId: string
  private readonly now: () => string
  private readonly host?: ApplicationRuntimeHost

  constructor(options: ApplicationRuntimeServiceOptions) {
    this.manifestSeed = structuredClone(options.manifest)
    this.lifecycle = options.lifecycle
    this.ledger = options.ledger
    this.evidence = options.evidence ?? new InMemoryApplicationRuntimeEvidenceStore()
    this.actor = options.actor ?? { type: 'system', id: 'application-runtime' }
    this.defaultRunId = options.defaultRunId ?? `application-runtime:${options.manifest.appId}`
    this.now = options.now ?? (() => new Date().toISOString())
    this.host = options.host
    if (options.manifest.appId !== this.lifecycle.manifest.appId) throw new Error('manifest and lifecycle appId must match')
  }

  get manifest(): ApplicationManifest { return this.lifecycle.manifest }
  get versions(): ApplicationVersion[] { return this.lifecycle.versions }
  getVersion(versionId: string): ApplicationVersion { return this.lifecycle.getVersion(versionId) }

  preview(versionId: string, runId = this.defaultRunId): ApplicationRuntimeActionResult {
    this.lifecycle.getVersion(versionId)
    const before = this.lifecycle.manifest
    return this.execute('preview', versionId, runId, {
      risk: 'read', permissionLevel: 'L0',
      transition: () => {
        this.lifecycle.setPreviewVersion(versionId, this.now())
        return { versionId, state: 'preview', previousPreviewVersionId: before.preview?.versionId ?? null }
      },
    })
  }

  deploy(versionId: string, input: { runId?: string; deploymentRef?: string } = {}): ApplicationRuntimeActionResult {
    return this.execute('deploy', versionId, input.runId ?? this.defaultRunId, {
      risk: 'execution', permissionLevel: 'L2',
      transition: () => {
        const next = this.lifecycle.transition(versionId, 'deployed', { deployed: true, deploymentRef: input.deploymentRef ?? `deployment:${versionId}`, now: this.now() })
        return { stage: next.stage, deploymentRef: input.deploymentRef ?? null }
      },
    })
  }

  start(versionId: string, input: { runId?: string; instanceId?: string; healthCheckRef?: string; smokeCheckPassed?: boolean; hostResult?: unknown } = {}): ApplicationRuntimeActionResult {
    return this.execute('start', versionId, input.runId ?? this.defaultRunId, {
      risk: 'execution', permissionLevel: 'L2',
      transition: () => {
        const next = this.lifecycle.transition(versionId, 'running', {
          healthPassed: true, smokeCheckPassed: input.smokeCheckPassed ?? true, instanceId: input.instanceId, healthCheckRef: input.healthCheckRef, now: this.now(),
        })
        return { stage: next.stage, instanceId: input.instanceId ?? null, hostResult: input.hostResult ?? null }
      },
    })
  }

  stop(versionId: string, input: { runId?: string; instanceId?: string; hostResult?: unknown } = {}): ApplicationRuntimeActionResult {
    return this.execute('stop', versionId, input.runId ?? this.defaultRunId, {
      risk: 'execution', permissionLevel: 'L2',
      transition: () => {
        const next = this.lifecycle.transition(versionId, 'stopped', { instanceId: input.instanceId, now: this.now() })
        return { stage: next.stage, instanceId: input.instanceId ?? null, hostResult: input.hostResult ?? null }
      },
    })
  }

  async startHosted(versionId: string, input: { runId?: string; instanceId?: string; healthCheckRef?: string } = {}): Promise<ApplicationRuntimeActionResult> {
    if (!this.host) throw new ApplicationRuntimeServiceError('start', versionId, 'application runtime host is not configured')
    const runId = input.runId ?? this.defaultRunId
    const hostResult = await this.host.start({ projectId: this.manifestSeed.projectId, appId: this.manifestSeed.appId, versionId, runId, instanceId: input.instanceId })
    return this.start(versionId, { ...input, instanceId: hostResult.instanceId ?? input.instanceId, healthCheckRef: input.healthCheckRef ?? (typeof hostResult.health === 'object' && hostResult.health && 'path' in hostResult.health ? String(hostResult.health.path) : undefined), smokeCheckPassed: hostResult.ok, hostResult })
  }

  async stopHosted(versionId: string, input: { runId?: string; instanceId?: string } = {}): Promise<ApplicationRuntimeActionResult> {
    if (!this.host) throw new ApplicationRuntimeServiceError('stop', versionId, 'application runtime host is not configured')
    const runId = input.runId ?? this.defaultRunId
    const hostResult = await this.host.stop({ projectId: this.manifestSeed.projectId, appId: this.manifestSeed.appId, versionId, runId, instanceId: input.instanceId })
    return this.stop(versionId, { ...input, instanceId: hostResult.instanceId ?? input.instanceId, hostResult })
  }

  async healthCheckHosted(input: ApplicationRuntimeHealthInput & { instanceId?: string }): Promise<ApplicationRuntimeActionResult> {
    if (!this.host) throw new ApplicationRuntimeServiceError('health_check', input.versionId, 'application runtime host is not configured')
    const runId = input.runId ?? this.defaultRunId
    const hostResult = await this.host.healthCheck({ projectId: this.manifestSeed.projectId, appId: this.manifestSeed.appId, versionId: input.versionId, runId, instanceId: input.instanceId })
    return this.healthCheck({ ...input, passed: input.passed && hostResult.ok, message: input.message ?? (hostResult.ok ? undefined : errorMessage(hostResult.error ?? 'host health check failed')), hostResult })
  }

  async updateHosted(input: ApplicationRuntimeUpdateInput): Promise<ApplicationRuntimeActionResult> {
    if (!this.host) throw new ApplicationRuntimeServiceError('update', input.newVersionId, 'application runtime host is not configured')
    const runId = input.runId ?? this.defaultRunId
    const hostResult = await this.host.update({ projectId: this.manifestSeed.projectId, appId: this.manifestSeed.appId, currentVersionId: input.currentVersionId, newVersionId: input.newVersionId, runId, instanceId: input.instanceId })
    return this.update({ ...input, instanceId: hostResult.instanceId ?? input.instanceId, healthPassed: input.healthPassed ?? hostResult.ok, hostResult })
  }

  async rollbackHosted(input: ApplicationRuntimeRollbackInput): Promise<ApplicationRuntimeActionResult> {
    if (!this.host) throw new ApplicationRuntimeServiceError('rollback', input.failedVersionId, 'application runtime host is not configured')
    const runId = input.runId ?? this.defaultRunId
    const hostResult = await this.host.rollback({ projectId: this.manifestSeed.projectId, appId: this.manifestSeed.appId, failedVersionId: input.failedVersionId, targetVersionId: input.targetVersionId, runId })
    return this.rollback({ ...input, healthCheckRef: input.healthCheckRef ?? (hostResult.ok ? undefined : errorMessage(hostResult.error ?? 'host rollback failed')), hostResult })
  }

  healthCheck(input: ApplicationRuntimeHealthInput): ApplicationRuntimeActionResult {
    return this.execute('health_check', input.versionId, input.runId ?? this.defaultRunId, {
      risk: 'read', permissionLevel: 'L0',
      transition: () => {
        const passed = input.passed && input.smokeCheckPassed !== false
        let stage: ApplicationVersion['stage'] = this.lifecycle.getVersion(input.versionId).stage
        if (!passed && !['error', 'rolled_back'].includes(stage)) stage = this.lifecycle.transition(input.versionId, 'error', { error: input.message ?? 'health check failed', healthCheckRef: input.route, now: this.now() }).stage
        return { passed, stage, route: input.route ?? null, latencyMs: input.latencyMs ?? null, message: input.message ?? null, hostResult: input.hostResult ?? null }
      },
      success: payload => Boolean((payload as { passed?: boolean }).passed),
    })
  }

  update(input: ApplicationRuntimeUpdateInput): ApplicationRuntimeActionResult {
    const runId = input.runId ?? this.defaultRunId
    return this.execute('update', input.newVersionId, runId, {
      risk: 'execution', permissionLevel: 'L2',
      transition: () => {
        const current = this.lifecycle.getVersion(input.currentVersionId)
        const candidate = this.lifecycle.getVersion(input.newVersionId)
        if (current.stage !== 'running') throw new Error(`current version must be running, got ${current.stage}`)
        if (candidate.stage !== 'verified') throw new Error(`new version must be verified, got ${candidate.stage}`)
        this.lifecycle.setPreviewVersion(candidate.versionId, this.now())
        this.lifecycle.transition(candidate.versionId, 'published', { approved: true, approvalRef: input.approvalRef ?? `update-approval:${candidate.versionId}`, now: this.now() })
        this.lifecycle.transition(candidate.versionId, 'deployed', { deployed: true, deploymentRef: input.deploymentRef ?? `update-deployment:${candidate.versionId}`, now: this.now() })
        this.lifecycle.transition(candidate.versionId, 'updating', { updateAuthorized: true, now: this.now() })
        const running = this.lifecycle.transition(candidate.versionId, 'running', {
          healthPassed: input.healthPassed ?? true,
          smokeCheckPassed: input.smokeCheckPassed ?? true,
          instanceId: input.instanceId,
          healthCheckRef: input.healthCheckRef,
          now: this.now(),
        })
        return {
          previousVersionId: current.versionId,
          versionId: running.versionId,
          stage: running.stage,
          deployedVersionId: this.lifecycle.manifest.versions.deployedVersionId,
          runningVersionId: this.lifecycle.manifest.versions.runningVersionId,
        }
      },
      success: payload => (payload as { stage?: string }).stage === 'running',
    })
  }

  rollback(input: ApplicationRuntimeRollbackInput): ApplicationRuntimeActionResult {
    return this.execute('rollback', input.failedVersionId, input.runId ?? this.defaultRunId, {
      risk: 'execution', permissionLevel: 'L2',
      transition: () => {
        const target = this.lifecycle.getVersion(input.targetVersionId)
        if (!['running', 'deployed'].includes(target.stage)) throw new Error(`rollback target must be running or deployed, got ${target.stage}`)
        const failed = this.lifecycle.getVersion(input.failedVersionId)
        const rolledBack = this.lifecycle.transition(failed.versionId, 'rolled_back', {
          rollbackTargetVersionId: target.versionId,
          rollbackReason: input.reason,
          healthCheckRef: input.healthCheckRef,
          now: this.now(),
        })
        return { failedVersionId: rolledBack.versionId, targetVersionId: target.versionId, stage: rolledBack.stage, runningVersionId: this.lifecycle.manifest.versions.runningVersionId }
      },
    })
  }

  private baseSourceRefs(runId: string): SourceRef[] {
    return [
      { type: 'project', id: this.manifestSeed.projectId, relation: 'references' },
      { type: 'run', id: runId, relation: 'references' },
      { type: 'instruction', id: this.manifestSeed.source.instructionId, relation: 'planned-from', version: this.manifestSeed.source.instructionVersion },
    ]
  }

  private execute(
    operation: ApplicationRuntimeOperation,
    versionId: string,
    runId: string,
    options: {
      risk: 'read' | 'execution'
      permissionLevel: 'L0' | 'L2'
      transition: () => unknown
      success?: (payload: unknown) => boolean
    },
  ): ApplicationRuntimeActionResult {
    const action = this.ledger.createAction({
      runId,
      projectId: this.manifestSeed.projectId,
      capabilityId: 'application-runtime',
      operation: `application.${operation}`,
      arguments: { appId: this.manifestSeed.appId, versionId },
      target: { projectId: this.manifestSeed.projectId, objectId: this.manifestSeed.appId },
      risk: options.risk,
      permissionRequest: {
        level: options.permissionLevel,
        actorId: this.actor.id,
        projectId: this.manifestSeed.projectId,
        capabilityId: 'application-runtime',
        operation: `application.${operation}`,
        targetSummary: `${operation} ${this.manifestSeed.appId} version ${versionId}`,
        scope: { objects: [this.manifestSeed.appId] },
        reason: 'manage a project application version',
        expectedSideEffect: options.risk === 'read' ? 'none' : 'start or change an application runtime',
        ...(options.permissionLevel === 'L2' ? { authorizationRef: `application-runtime:${operation}:${versionId}` } : {}),
      },
      idempotencyKey: `${this.manifestSeed.appId}:${operation}:${versionId}:${runId}`,
      cancelMode: 'before-start',
      actor: this.actor,
      sourceRefs: this.baseSourceRefs(runId),
    })
    const admission = this.ledger.admitAction(action, {
      projectId: this.manifestSeed.projectId,
      preAuthorized: true,
      scopeAllowed: true,
      policyAllowed: true,
    })
    if (admission.disposition !== 'accepted') {
      const receipt = admission.receipt ?? this.ledger.getReceipt(action.id)
      if (!receipt) throw new ApplicationRuntimeServiceError(operation, versionId, `action admission ${admission.disposition} has no receipt`)
      const evidence = this.evidence.record({
        kind: 'permission',
        projectId: this.manifestSeed.projectId,
        appId: this.manifestSeed.appId,
        versionId,
        runId,
        actionId: action.id,
        sourceRefs: [...this.baseSourceRefs(runId), { type: 'action', id: action.id, relation: 'references' }],
        payload: { operation, admission: admission.disposition, reasons: admission.reasons },
        createdAt: this.now(),
      })
      return { ok: false, operation, versionId, action: admission.action, admission, receipt, evidence, manifest: this.lifecycle.manifest, error: admission.reasons.join('; ') || `action admission ${admission.disposition}` }
    }

    let payload: unknown
    let operationError: string | undefined
    try {
      payload = options.transition()
    } catch (error) {
      operationError = errorMessage(error)
      payload = { error: operationError }
    }
    const success = operationError === undefined && (options.success ? options.success(payload) : true)
    const evidence = this.evidence.record({
      kind: operation === 'health_check' ? 'health-check' : `application-${operation}`,
      status: statusForEvidence(success),
      projectId: this.manifestSeed.projectId,
      appId: this.manifestSeed.appId,
      versionId,
      runId,
      actionId: action.id,
      sourceRefs: [...this.baseSourceRefs(runId), { type: 'action', id: action.id, relation: 'references' }],
      payload: { operation, success, result: payload },
      createdAt: this.now(),
    })
    const receipt = this.ledger.recordReceipt({
      actionId: action.id,
      status: success ? 'succeeded' : 'failed',
      evidenceRefs: [evidence.evidenceId],
      resultHash: stableHash(payload),
      sideEffect: options.risk === 'read' ? 'none' : 'local-reversible',
      ...(success ? {} : { error: { code: 'APPLICATION_RUNTIME_OPERATION_FAILED', message: operationError ?? 'operation failed', retryable: false } }),
    })
    const linkedEvidence = this.evidence.attachReceipt(evidence.evidenceId, receipt.id)
    const latestAction = this.ledger.getAction(action.id) ?? admission.action
    return {
      ok: success,
      operation,
      versionId,
      action: latestAction,
      admission,
      receipt,
      evidence: linkedEvidence,
      manifest: this.lifecycle.manifest,
      ...(success ? {} : { error: operationError ?? 'operation failed' }),
    }
  }
}
