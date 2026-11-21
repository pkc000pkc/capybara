import type { RuntimeLoopState } from '#core/runtime-loop-state'
import {
  ProductWorkLedger,
  type Checkpoint,
  type ProductWorkLedgerOptions,
  type ProductWorkLedgerSnapshot,
  type ReconcileInput,
  type ReconciliationResult,
} from '#core/product-work-ledger'

/**
 * Optional fields are deliberately additive. RuntimeLoop can continue to
 * consume the returned value as its existing RuntimeLoopState because it
 * ignores unknown properties, while ProductWorkLedger survives restart beside
 * the old runtime state.
 */
export type ProductRuntimeState = RuntimeLoopState & {
  productWorkLedger?: ProductWorkLedgerSnapshot
  productCheckpoints?: Checkpoint[]
}

export type ProductRuntimeStateSnapshot = ProductRuntimeState

export type RestoredProductRuntimeState = {
  runtimeState: RuntimeLoopState
  ledger: ProductWorkLedger
}

export type ProductRuntimeStateRestoreInput =
  | ProductRuntimeState
  | Partial<ProductRuntimeState>
  | string
  | undefined
  | null

type LegacyProductRuntimeState = ProductRuntimeState & {
  /** Names used by early V2 prototypes; accepted for a lossless migration. */
  workLedger?: ProductWorkLedgerSnapshot
  productRuntime?: { productWorkLedger?: ProductWorkLedgerSnapshot; ledger?: ProductWorkLedgerSnapshot }
}

const DEFAULT_CONTEXT_CONTROL = {
  status: 'idle' as const,
  evidenceRequests: [],
  uncertainties: [],
  reflectionAttempts: 0,
}

function clone<T>(value: T): T {
  if (value === undefined) return value
  return structuredClone(value)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseState(value: ProductRuntimeStateRestoreInput): LegacyProductRuntimeState {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as ProductRuntimeStateRestoreInput
    } catch {
      throw new Error('product runtime state is not valid JSON')
    }
  }
  if (!isObject(value)) return {} as LegacyProductRuntimeState
  const source = clone(value) as LegacyProductRuntimeState
  if (source.version !== undefined && source.version !== 1) {
    throw new Error(`unsupported runtime state version: ${String(source.version)}`)
  }
  return source
}

/**
 * Fill defaults that were absent from old RuntimeLoopState snapshots. This
 * does not reinterpret timeline or run statuses; RuntimeLoop keeps ownership
 * of those semantics when it is later restored.
 */
export function normalizeProductRuntimeState(value: ProductRuntimeStateRestoreInput): ProductRuntimeState {
  const source = parseState(value)
  const normalized = {
    ...source,
    version: 1 as const,
    pendingToolCalls: Array.isArray(source.pendingToolCalls) ? source.pendingToolCalls : [],
    pendingWorkflowCalls: Array.isArray(source.pendingWorkflowCalls) ? source.pendingWorkflowCalls : [],
    workflowDefinitions: Array.isArray(source.workflowDefinitions) ? source.workflowDefinitions : [],
    workflowData: Array.isArray(source.workflowData) ? source.workflowData : [],
    ...(source.contextControl ? {} : { contextControl: clone(DEFAULT_CONTEXT_CONTROL) }),
  }
  return clone(normalized) as ProductRuntimeState
}

function ledgerFromState(state: LegacyProductRuntimeState, options: ProductWorkLedgerOptions = {}): ProductWorkLedger {
  const snapshot = state.productWorkLedger
    ?? state.workLedger
    ?? state.productRuntime?.productWorkLedger
    ?? state.productRuntime?.ledger
  return ProductWorkLedger.fromSnapshot(snapshot, options)
}

/** Return a RuntimeLoop-compatible state carrying a detached ProductWorkLedger snapshot. */
export function snapshotProductRuntimeState(
  runtimeState: RuntimeLoopState | ProductRuntimeState | undefined,
  ledger: ProductWorkLedger,
): ProductRuntimeStateSnapshot {
  const normalized = normalizeProductRuntimeState(runtimeState)
  const productWorkLedger = ledger.snapshot()
  return clone({
    ...normalized,
    productWorkLedger,
    productCheckpoints: clone(productWorkLedger.checkpoints),
  })
}

/** Alias used by persistence callers that use the shorter snapshot terminology. */
export const snapshotRuntimeState = snapshotProductRuntimeState

/** Restore only the legacy RuntimeLoopState plus a detached ProductWorkLedger. */
export function restoreProductRuntimeState(
  value: ProductRuntimeStateRestoreInput,
  options: ProductWorkLedgerOptions = {},
): RestoredProductRuntimeState {
  const source = parseState(value)
  const normalized = normalizeProductRuntimeState(source)
  const ledger = ledgerFromState(source, options)
  const runtimeState = { ...normalized }
  delete (runtimeState as Partial<ProductRuntimeState>).productWorkLedger
  delete (runtimeState as Partial<ProductRuntimeState>).productCheckpoints
  delete (runtimeState as LegacyProductRuntimeState).workLedger
  delete (runtimeState as LegacyProductRuntimeState).productRuntime
  return { runtimeState: clone(runtimeState) as RuntimeLoopState, ledger }
}

export const restoreRuntimeState = restoreProductRuntimeState

/** Serialize an additive RuntimeLoop/ProductWorkLedger state as JSON. */
export function serializeProductRuntimeState(
  runtimeState: RuntimeLoopState | ProductRuntimeState | undefined,
  ledger?: ProductWorkLedger,
): string {
  const source = parseState(runtimeState)
  const normalized = normalizeProductRuntimeState(source)
  const productWorkLedger = ledger?.snapshot()
    ?? source.productWorkLedger
    ?? source.workLedger
    ?? source.productRuntime?.productWorkLedger
    ?? source.productRuntime?.ledger
    ?? ProductWorkLedger.fromSnapshot(undefined).snapshot()
  return JSON.stringify({
    ...normalized,
    productWorkLedger: clone(productWorkLedger),
    productCheckpoints: clone(productWorkLedger.checkpoints),
  })
}

export const serializeRuntimeState = serializeProductRuntimeState

export function deserializeProductRuntimeState(serialized: string): ProductRuntimeStateSnapshot {
  return normalizeProductRuntimeState(serialized)
}

export const deserializeRuntimeState = deserializeProductRuntimeState

/** Create and persist a ProductWorkLedger checkpoint alongside runtime state. */
export function checkpointProductRuntimeState(
  runtimeState: RuntimeLoopState | ProductRuntimeState | undefined,
  ledger: ProductWorkLedger,
  input: Parameters<ProductWorkLedger['createCheckpoint']>[0],
): { state: ProductRuntimeStateSnapshot; checkpoint: Checkpoint } {
  const checkpoint = ledger.createCheckpoint(input)
  return {
    state: snapshotProductRuntimeState(runtimeState, ledger),
    checkpoint,
  }
}

export const createProductCheckpoint = checkpointProductRuntimeState

/** Reconcile an unknown ProductWorkLedger receipt and return updated runtime state. */
export function reconcileProductRuntimeState(
  runtimeState: RuntimeLoopState | ProductRuntimeState | undefined,
  ledger: ProductWorkLedger,
  input: ReconcileInput,
): { state: ProductRuntimeStateSnapshot; result: ReconciliationResult } {
  const result = ledger.reconcileUnknown(input)
  return {
    state: snapshotProductRuntimeState(runtimeState, ledger),
    result,
  }
}

export class ProductRuntimeStateAdapter {
  constructor(
    private readonly ledger: ProductWorkLedger = new ProductWorkLedger(),
    private readonly options: ProductWorkLedgerOptions = {},
  ) {}

  snapshot(runtimeState?: RuntimeLoopState | ProductRuntimeState): ProductRuntimeStateSnapshot {
    return snapshotProductRuntimeState(runtimeState, this.ledger)
  }

  restore(value: ProductRuntimeStateRestoreInput): RestoredProductRuntimeState {
    return restoreProductRuntimeState(value, this.options)
  }

  serialize(runtimeState?: RuntimeLoopState | ProductRuntimeState): string {
    return serializeProductRuntimeState(runtimeState, this.ledger)
  }

  deserialize(serialized: string): ProductRuntimeStateSnapshot {
    return deserializeProductRuntimeState(serialized)
  }

  checkpoint(
    runtimeState: RuntimeLoopState | ProductRuntimeState | undefined,
    input: Parameters<ProductWorkLedger['createCheckpoint']>[0],
  ): { state: ProductRuntimeStateSnapshot; checkpoint: Checkpoint } {
    return checkpointProductRuntimeState(runtimeState, this.ledger, input)
  }

  reconcile(
    runtimeState: RuntimeLoopState | ProductRuntimeState | undefined,
    input: ReconcileInput,
  ): { state: ProductRuntimeStateSnapshot; result: ReconciliationResult } {
    return reconcileProductRuntimeState(runtimeState, this.ledger, input)
  }

  getLedger(): ProductWorkLedger {
    return this.ledger
  }
}

export const ProductRuntimeStateBridge = ProductRuntimeStateAdapter
