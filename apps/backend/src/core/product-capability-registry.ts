import { createHash } from 'node:crypto'

import {
  ProductWorkLedger,
  type Action,
  type ActionAdmissionResult,
  type ActionStatus,
  type ActorRef,
  type CapabilityKind,
  type Checkpoint,
  type PermissionLevel,
  type PermissionRequest,
  type ProductWorkLedgerOptions,
  type Receipt,
  type ReconcileInput,
  type ReconciliationResult,
  type Risk,
  type SideEffect,
  type SourceRef,
} from '#core/product-work-ledger'

export type { SideEffect } from '#core/product-work-ledger'

export type ProductCapabilityScope = {
  projectIds?: string[]
  paths?: string[]
  hosts?: string[]
  objects?: string[]
}

/** Typed, discoverable capability metadata shared by all adapters. */
export type ProductCapabilityDescriptor<TInput = unknown, TOutput = unknown> = {
  id: string
  /** Alias accepted in descriptors imported from Capability records. */
  capabilityId?: string
  kind: CapabilityKind
  apiVersion: string
  inputSchema: string
  outputSchema: string
  scope: ProductCapabilityScope
  risk: Risk
  requiredPermission: PermissionLevel
  evidenceKinds: string[]
  state: 'registered' | 'available' | 'restricted' | 'disabled' | 'deprecated'
  description?: string
  validateInput?: (input: TInput) => void
  metadata?: Record<string, unknown>
}

export type ProductCapabilityExecutionContext<TInput = unknown> = {
  action: Action
  input: TInput
  capability: ProductCapabilityDescriptor<TInput, unknown>
  ledger: ProductWorkLedger
}

export type ProductCapabilityExecutionResult<TOutput = unknown> =
  | {
      status: 'succeeded'
      output?: TOutput
      outputRef?: string
      resultHash?: string
      evidenceRefs?: string[]
      sideEffect?: 'none' | 'local-reversible' | 'external-reversible' | 'external-irreversible' | 'unknown'
      adapterRunId?: string
    }
  | {
      status: 'failed'
      error: { code: string; message: string; retryable: boolean }
      outputRef?: string
      resultHash?: string
      evidenceRefs?: string[]
      sideEffect?: 'none' | 'local-reversible' | 'external-reversible' | 'external-irreversible' | 'unknown'
      adapterRunId?: string
    }
  | {
      status: 'unknown'
      error?: { code: string; message: string; retryable: boolean }
      outputRef?: string
      resultHash?: string
      evidenceRefs?: string[]
      sideEffect?: 'none' | 'local-reversible' | 'external-reversible' | 'external-irreversible' | 'unknown'
      adapterRunId?: string
    }

/**
 * Generic seam for application, browser, file and terminal adapters. Adapter
 * code does not receive the ledger and therefore cannot bypass admission.
 */
export interface ProductCapabilityAdapter<TInput = unknown, TOutput = unknown> {
  execute(
    context: ProductCapabilityExecutionContext<TInput>,
  ): ProductCapabilityExecutionResult<TOutput> | TOutput | Promise<ProductCapabilityExecutionResult<TOutput> | TOutput>
}

export type ProductCapabilityAdapterLike<TInput = unknown, TOutput = unknown> =
  | ProductCapabilityAdapter<TInput, TOutput>
  | ((context: ProductCapabilityExecutionContext<TInput>) => ProductCapabilityExecutionResult<TOutput> | TOutput | Promise<ProductCapabilityExecutionResult<TOutput> | TOutput>)

export type RegisteredProductCapability<TInput = unknown, TOutput = unknown> = {
  descriptor: ProductCapabilityDescriptor<TInput, TOutput>
  adapter: ProductCapabilityAdapter<TInput, TOutput>
}

export type ProductCapabilityActionInput<TInput = unknown> = {
  capabilityId: string
  runId: string
  operation: string
  input: TInput
  target: { projectId: string; path?: string; host?: string; objectId?: string }
  idempotencyKey: string
  actor?: ActorRef
  projectId?: string
  sourceRefs?: SourceRef[]
  parentId?: string
  timeoutMs?: number
  cancelMode?: 'before-start' | 'cooperative' | 'not-supported'
  permissionRequest?: Partial<PermissionRequest>
  /** Alias for callers that call the decision `permission`. */
  permission?: Partial<PermissionRequest>
}

export type ProductCapabilityAdmission = {
  action: Action
  admission: ActionAdmissionResult
}

export type ProductCapabilityExecution<TOutput = unknown> = {
  action: Action
  admission: ActionAdmissionResult
  receipt?: Receipt
  output?: TOutput
  error?: { code: string; message: string; retryable: boolean }
}

export class ProductCapabilityUnknownError extends Error {
  readonly evidenceRefs: string[]
  readonly sideEffect: 'none' | 'local-reversible' | 'external-reversible' | 'external-irreversible' | 'unknown'
  readonly adapterRunId?: string

  constructor(
    message: string,
    options: {
      evidenceRefs?: string[]
      sideEffect?: ProductCapabilityUnknownError['sideEffect']
      adapterRunId?: string
    } = {},
  ) {
    super(message)
    this.name = 'ProductCapabilityUnknownError'
    this.evidenceRefs = [...(options.evidenceRefs ?? [])]
    this.sideEffect = options.sideEffect ?? 'unknown'
    this.adapterRunId = options.adapterRunId
  }
}

type RegisterOptions = {
  replace?: boolean
}

type ListFilter = {
  projectId?: string
  kind?: CapabilityKind
  state?: ProductCapabilityDescriptor['state']
  requiredPermission?: PermissionLevel
  path?: string
  host?: string
}

export type ProductCapabilityRegistryOptions = ProductWorkLedgerOptions & {
  ledger?: ProductWorkLedger
  actor?: ActorRef
}

function clone<T>(value: T): T {
  if (value === undefined) return value
  return structuredClone(value)
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`)
  return value
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExecutionResult(value: unknown): value is ProductCapabilityExecutionResult {
  return isObject(value) && (value.status === 'succeeded' || value.status === 'failed' || value.status === 'unknown')
}

function normalizeExecutionResult<TOutput>(value: unknown): ProductCapabilityExecutionResult<TOutput> {
  if (isExecutionResult(value)) return value as ProductCapabilityExecutionResult<TOutput>
  // Adapters may use the concise `{ output, evidenceRefs }` success shape.
  if (isObject(value) && Object.prototype.hasOwnProperty.call(value, 'output')) {
    return {
      status: 'succeeded',
      output: value.output as TOutput,
      ...(typeof value.outputRef === 'string' ? { outputRef: value.outputRef } : {}),
      ...(typeof value.resultHash === 'string' ? { resultHash: value.resultHash } : {}),
      ...(Array.isArray(value.evidenceRefs) ? { evidenceRefs: value.evidenceRefs.filter((item): item is string => typeof item === 'string') } : {}),
      ...(typeof value.sideEffect === 'string' ? { sideEffect: value.sideEffect as ProductCapabilityExecutionResult['sideEffect'] } : {}),
      ...(typeof value.adapterRunId === 'string' ? { adapterRunId: value.adapterRunId } : {}),
    }
  }
  return { status: 'succeeded', output: value as TOutput }
}

function hashOutput(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function pathWithin(value: string, roots: readonly string[] | undefined): boolean {
  if (!roots || roots.length === 0) return true
  const normalized = value.replaceAll('\\', '/').replace(/\/$/, '')
  return roots.some((root) => {
    const normalizedRoot = root.replaceAll('\\', '/').replace(/\/$/, '')
    return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`)
  })
}

function hostWithin(value: string, hosts: readonly string[] | undefined): boolean {
  if (!hosts || hosts.length === 0) return true
  return hosts.some((host) => value === host || value.endsWith(`.${host}`))
}

function descriptorId<TInput, TOutput>(descriptor: ProductCapabilityDescriptor<TInput, TOutput>): string {
  return requireString(descriptor.id || descriptor.capabilityId, 'capability.id')
}

function cloneDescriptor<TInput, TOutput>(descriptor: ProductCapabilityDescriptor<TInput, TOutput>): ProductCapabilityDescriptor<TInput, TOutput> {
  return {
    ...descriptor,
    scope: clone(descriptor.scope),
    evidenceKinds: [...descriptor.evidenceKinds],
    ...(descriptor.metadata ? { metadata: clone(descriptor.metadata) } : {}),
  }
}

function normalizeDescriptor<TInput, TOutput>(descriptor: ProductCapabilityDescriptor<TInput, TOutput>): ProductCapabilityDescriptor<TInput, TOutput> {
  const id = descriptorId(descriptor)
  if (descriptor.capabilityId !== undefined && descriptor.capabilityId !== id) throw new Error('capability.capabilityId must match capability.id')
  requireString(descriptor.kind, 'capability.kind')
  requireString(descriptor.apiVersion, 'capability.apiVersion')
  requireString(descriptor.inputSchema, 'capability.inputSchema')
  requireString(descriptor.outputSchema, 'capability.outputSchema')
  if (!isObject(descriptor.scope)) throw new Error('capability.scope must be an object')
  for (const key of ['projectIds', 'paths', 'hosts', 'objects'] as const) {
    if (descriptor.scope[key] !== undefined && (!Array.isArray(descriptor.scope[key]) || !descriptor.scope[key]!.every((item) => typeof item === 'string'))) throw new Error(`capability.scope.${key} must be a string array`)
  }
  if (!['read', 'reversible-write', 'execution', 'external-side-effect', 'destructive'].includes(descriptor.risk)) throw new Error('capability.risk is invalid')
  if (!['L0', 'L1', 'L2', 'L3', 'L4'].includes(descriptor.requiredPermission)) throw new Error('capability.requiredPermission is invalid')
  if (!Array.isArray(descriptor.evidenceKinds) || !descriptor.evidenceKinds.every((item) => typeof item === 'string')) throw new Error('capability.evidenceKinds must be a string array')
  if (!['registered', 'available', 'restricted', 'disabled', 'deprecated'].includes(descriptor.state)) throw new Error('capability.state is invalid')
  return cloneDescriptor({ ...descriptor, id, capabilityId: id })
}

function normalizeAdapter<TInput, TOutput>(adapter: ProductCapabilityAdapterLike<TInput, TOutput>): ProductCapabilityAdapter<TInput, TOutput> {
  if (typeof adapter === 'function') return { execute: adapter }
  if (!adapter || typeof adapter.execute !== 'function') throw new Error('capability adapter must implement execute')
  return adapter
}

export class ProductCapabilityRegistry {
  private readonly capabilities = new Map<string, RegisteredProductCapability>()
  private readonly ledger: ProductWorkLedger
  private readonly actor: ActorRef

  constructor(options: ProductCapabilityRegistryOptions = {}) {
    this.ledger = options.ledger ?? new ProductWorkLedger(options)
    this.actor = options.actor ?? { type: 'system', id: 'product-capability-registry' }
  }

  register<TInput = unknown, TOutput = unknown>(
    descriptor: ProductCapabilityDescriptor<TInput, TOutput>,
    adapter: ProductCapabilityAdapterLike<TInput, TOutput>,
    options: RegisterOptions = {},
  ): RegisteredProductCapability<TInput, TOutput> {
    const normalized = normalizeDescriptor(descriptor)
    if (this.capabilities.has(normalized.id) && !options.replace) throw new Error(`capability already registered: ${normalized.id}`)
    const registered = { descriptor: normalized, adapter: normalizeAdapter(adapter) }
    this.capabilities.set(normalized.id, registered as RegisteredProductCapability)
    return { descriptor: cloneDescriptor(registered.descriptor), adapter: registered.adapter }
  }

  registerCapability<TInput = unknown, TOutput = unknown>(
    descriptor: ProductCapabilityDescriptor<TInput, TOutput>,
    adapter: ProductCapabilityAdapterLike<TInput, TOutput>,
    options: RegisterOptions = {},
  ): RegisteredProductCapability<TInput, TOutput> {
    return this.register(descriptor, adapter, options)
  }

  unregister(capabilityId: string): boolean {
    return this.capabilities.delete(requireString(capabilityId, 'capabilityId'))
  }

  unregisterCapability(capabilityId: string): boolean {
    return this.unregister(capabilityId)
  }

  resolve<TInput = unknown, TOutput = unknown>(capabilityId: string): RegisteredProductCapability<TInput, TOutput> | undefined {
    const registered = this.capabilities.get(requireString(capabilityId, 'capabilityId'))
    return registered
      ? { descriptor: cloneDescriptor(registered.descriptor) as ProductCapabilityDescriptor<TInput, TOutput>, adapter: registered.adapter as ProductCapabilityAdapter<TInput, TOutput> }
      : undefined
  }

  get<TInput = unknown, TOutput = unknown>(capabilityId: string): RegisteredProductCapability<TInput, TOutput> | undefined {
    return this.resolve<TInput, TOutput>(capabilityId)
  }

  resolveAdapter<TInput = unknown, TOutput = unknown>(capabilityId: string): ProductCapabilityAdapter<TInput, TOutput> | undefined {
    return this.resolve<TInput, TOutput>(capabilityId)?.adapter
  }

  getDescriptor<TInput = unknown, TOutput = unknown>(capabilityId: string): ProductCapabilityDescriptor<TInput, TOutput> | undefined {
    return this.resolve<TInput, TOutput>(capabilityId)?.descriptor
  }

  list(filter: ListFilter = {}): ProductCapabilityDescriptor[] {
    return [...this.capabilities.values()]
      .map((item) => item.descriptor)
      .filter((descriptor) => filter.kind === undefined || descriptor.kind === filter.kind)
      .filter((descriptor) => filter.state === undefined || descriptor.state === filter.state)
      .filter((descriptor) => filter.requiredPermission === undefined || descriptor.requiredPermission === filter.requiredPermission)
      .filter((descriptor) => filter.projectId === undefined || descriptor.scope.projectIds === undefined || descriptor.scope.projectIds.includes(filter.projectId))
      .filter((descriptor) => filter.path === undefined || pathWithin(filter.path, descriptor.scope.paths))
      .filter((descriptor) => filter.host === undefined || hostWithin(filter.host, descriptor.scope.hosts))
      .map((descriptor) => cloneDescriptor(descriptor))
  }

  listCapabilities(filter: ListFilter = {}): ProductCapabilityDescriptor[] {
    return this.list(filter)
  }

  createAction<TInput>(capabilityId: string, input: ProductCapabilityActionInput<TInput>): Action {
    const registered = this.resolve<TInput, unknown>(capabilityId)
    if (!registered) throw new Error(`capability not found: ${capabilityId}`)
    const { descriptor } = registered
    if (descriptor.validateInput) descriptor.validateInput(input.input)
    const projectId = input.projectId ?? input.target.projectId
    const permission = input.permissionRequest ?? input.permission ?? {}
    const permissionRequest: PermissionRequest = {
      level: permission.level ?? descriptor.requiredPermission,
      actorId: permission.actorId ?? input.actor?.id ?? this.actor.id,
      projectId: permission.projectId ?? projectId,
      capabilityId: descriptor.id,
      operation: permission.operation ?? input.operation,
      targetSummary: permission.targetSummary ?? `${descriptor.id}:${input.operation}`,
      scope: {
        ...(permission.scope?.paths ? { paths: [...permission.scope.paths] } : {}),
        ...(permission.scope?.hosts ? { hosts: [...permission.scope.hosts] } : {}),
        ...(permission.scope?.objects ? { objects: [...permission.scope.objects] } : {}),
      },
      reason: permission.reason ?? `invoke capability ${descriptor.id}`,
      expectedSideEffect: permission.expectedSideEffect ?? descriptor.risk,
      ...(permission.expiresAt ? { expiresAt: permission.expiresAt } : {}),
      ...(permission.authorizationRef ? { authorizationRef: permission.authorizationRef } : {}),
    }
    return this.ledger.createAction({
      runId: input.runId,
      capabilityId: descriptor.id,
      operation: input.operation,
      arguments: clone(input.input),
      target: clone(input.target),
      risk: descriptor.risk,
      permissionRequest,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor ?? this.actor,
      projectId,
      sourceRefs: input.sourceRefs,
      parentId: input.parentId,
      timeoutMs: input.timeoutMs,
      cancelMode: input.cancelMode ?? 'cooperative',
    })
  }

  admitAction(action: Action, context: Parameters<ProductWorkLedger['admitAction']>[1] = {}): ProductCapabilityAdmission {
    const registered = this.resolve(action.capabilityId)
    if (!registered) throw new Error(`capability not found: ${action.capabilityId}`)
    const admission = this.ledger.admitAction(action, {
      ...context,
      capability: {
        state: registered.descriptor.state,
        requiredPermission: registered.descriptor.requiredPermission,
        scope: registered.descriptor.scope,
        risk: registered.descriptor.risk,
      },
      projectId: context.projectId ?? action.target.projectId,
    })
    return { action: admission.action, admission }
  }

  admit(action: Action, context: Parameters<ProductWorkLedger['admitAction']>[1] = {}): ProductCapabilityAdmission {
    return this.admitAction(action, context)
  }

  async executeAction<TInput = unknown, TOutput = unknown>(
    actionOrInput: Action | ProductCapabilityActionInput<TInput>,
    context: Parameters<ProductWorkLedger['admitAction']>[1] = {},
  ): Promise<ProductCapabilityExecution<TOutput>> {
    const action = 'type' in actionOrInput && actionOrInput.type === 'Action'
      ? actionOrInput
      : this.createAction((actionOrInput as ProductCapabilityActionInput<TInput>).capabilityId ?? '', actionOrInput as ProductCapabilityActionInput<TInput>)
    const registered = this.resolve<TInput, TOutput>(action.capabilityId)
    if (!registered) throw new Error(`capability not found: ${action.capabilityId}`)

    // A previously admitted/running/terminal Action is a duplicate even when
    // the caller reconstructs it with the same idempotency key.
    const previousReceipt = this.ledger.getReceipt(action.id)
    const previousStatus = action.status as ActionStatus
    if (previousReceipt || !['proposed', 'awaiting_authorization'].includes(previousStatus)) {
      const duplicateAdmission: ActionAdmissionResult = {
        disposition: 'duplicate',
        action: clone(action),
        ...(previousReceipt ? { receipt: previousReceipt } : {}),
        checks: [{ name: 'idempotency', passed: false, reason: 'action was already admitted or executed' }],
        reasons: ['duplicate idempotency key'],
      }
      return { action: clone(action), admission: duplicateAdmission, ...(previousReceipt?.status === 'succeeded' ? { receipt: previousReceipt } : {}) }
    }

    const admitted = this.admitAction(action, context)
    if (admitted.admission.disposition !== 'accepted') {
      return {
        action: admitted.action,
        admission: admitted.admission,
        ...(admitted.admission.receipt ? { receipt: admitted.admission.receipt } : {}),
      }
    }
    const admittedAction = admitted.action
    try {
      this.ledger.recordReceipt({
        actionId: admittedAction.id,
        status: 'started',
        sideEffect: 'unknown',
        evidenceRefs: [],
        idempotencyKey: `started:${admittedAction.id}`,
      })
    } catch (error) {
      const failure = { code: 'RECEIPT_START_FAILED', message: error instanceof Error ? error.message : String(error), retryable: false }
      return { action: admittedAction, admission: admitted.admission, error: failure }
    }

    try {
      const raw = await registered.adapter.execute({
        action: admittedAction,
        input: clone(admittedAction.arguments) as TInput,
        capability: registered.descriptor,
        ledger: this.ledger,
      })
      const result = normalizeExecutionResult<TOutput>(raw)
      if (result.status === 'unknown') {
        const receipt = this.ledger.recordReceipt({
          actionId: admittedAction.id,
          status: 'unknown',
          adapterRunId: result.adapterRunId,
          evidenceRefs: result.evidenceRefs ?? [],
          resultHash: result.resultHash,
          outputRef: result.outputRef,
          sideEffect: result.sideEffect ?? 'unknown',
          error: result.error,
        })
        return { action: this.ledger.getAction(admittedAction.id) ?? admittedAction, admission: admitted.admission, receipt, error: result.error }
      }
      if (result.status === 'failed') {
        const receipt = this.ledger.recordReceipt({
          actionId: admittedAction.id,
          status: 'failed',
          adapterRunId: result.adapterRunId,
          evidenceRefs: result.evidenceRefs ?? [],
          resultHash: result.resultHash,
          outputRef: result.outputRef,
          sideEffect: result.sideEffect ?? 'unknown',
          error: result.error,
        })
        return { action: this.ledger.getAction(admittedAction.id) ?? admittedAction, admission: admitted.admission, receipt, error: result.error }
      }
      const output = result.output as TOutput | undefined
      const receipt = this.ledger.recordReceipt({
        actionId: admittedAction.id,
        status: 'succeeded',
        adapterRunId: result.adapterRunId,
        evidenceRefs: result.evidenceRefs ?? [],
        resultHash: result.resultHash ?? hashOutput(output),
        outputRef: result.outputRef,
        sideEffect: result.sideEffect ?? 'none',
      })
      return { action: this.ledger.getAction(admittedAction.id) ?? admittedAction, admission: admitted.admission, receipt, ...(output === undefined ? {} : { output }) }
    } catch (error) {
      if (error instanceof ProductCapabilityUnknownError) {
        const receipt = this.ledger.recordReceipt({
          actionId: admittedAction.id,
          status: 'unknown',
          adapterRunId: error.adapterRunId,
          evidenceRefs: error.evidenceRefs,
          sideEffect: error.sideEffect,
          error: { code: 'ADAPTER_UNKNOWN', message: error.message, retryable: false },
        })
        return { action: this.ledger.getAction(admittedAction.id) ?? admittedAction, admission: admitted.admission, receipt, error: { code: 'ADAPTER_UNKNOWN', message: error.message, retryable: false } }
      }
      const failure = { code: 'ADAPTER_FAILED', message: error instanceof Error ? error.message : String(error), retryable: false }
      const receipt = this.ledger.recordReceipt({ actionId: admittedAction.id, status: 'failed', evidenceRefs: [], sideEffect: 'unknown', error: failure })
      return { action: this.ledger.getAction(admittedAction.id) ?? admittedAction, admission: admitted.admission, receipt, error: failure }
    }
  }

  execute<TInput = unknown, TOutput = unknown>(
    actionOrInput: Action | ProductCapabilityActionInput<TInput>,
    context: Parameters<ProductWorkLedger['admitAction']>[1] = {},
  ): Promise<ProductCapabilityExecution<TOutput>> {
    return this.executeAction<TInput, TOutput>(actionOrInput, context)
  }

  reconcile(input: ReconcileInput): ReconciliationResult {
    return this.ledger.reconcileUnknown(input)
  }

  reconcileUnknown(input: ReconcileInput): ReconciliationResult {
    return this.reconcile(input)
  }

  getLedger(): ProductWorkLedger {
    return this.ledger
  }

  checkpoint(input: Parameters<ProductWorkLedger['createCheckpoint']>[0]): Checkpoint {
    return this.ledger.createCheckpoint(input)
  }
}

export const ProductCapabilityRegistryService = ProductCapabilityRegistry
