import {
  type BrowserGatewayExecution,
  BrowserGatewayService,
} from './browser-gateway-service.ts'
import { validateBrowserAction, type BrowserAction } from './browser-capability.ts'
import {
  type ProductCapabilityAdapter,
  type ProductCapabilityDescriptor,
  type ProductCapabilityExecutionContext,
  type ProductCapabilityExecutionResult,
  type ProductCapabilityRegistry,
  type RegisteredProductCapability,
} from './product-capability-registry.ts'
import type { SideEffect } from './product-work-ledger.ts'

export type BrowserCapabilityAdapterOutput = BrowserGatewayExecution
export type BrowserCapabilityAdapterInput = BrowserAction

export interface BrowserCapabilityAdapterOptions {
  service: BrowserGatewayService
  id?: string
  apiVersion?: string
  state?: ProductCapabilityDescriptor['state']
  scope?: ProductCapabilityDescriptor['scope']
  requiredPermission?: ProductCapabilityDescriptor['requiredPermission']
}

function clone<T>(value: T): T { return structuredClone(value) }

function asBrowserAction(input: BrowserAction, contextAction: ProductCapabilityExecutionContext<BrowserAction>['action']): BrowserAction {
  const value = clone(input)
  // The registry action is the durable idempotency boundary. Overlay its
  // identity when a caller supplied a payload copied from another run.
  return {
    ...value,
    id: contextAction.id,
    runId: contextAction.runId,
    idempotencyKey: contextAction.idempotencyKey.includes(':') ? contextAction.idempotencyKey.split(':').slice(1).join(':') : contextAction.idempotencyKey,
  }
}

function sideEffectFor(result: BrowserGatewayExecution): SideEffect {
  if (result.browserReceipt.sideEffect) return result.browserReceipt.sideEffect
  if (result.browserReceipt.externalEffect === 'possible' || result.browserReceipt.externalEffect === 'unknown') return 'unknown'
  if (result.browserReceipt.externalEffect === 'confirmed') return 'external-reversible'
  return 'none'
}

function errorFor(result: BrowserGatewayExecution): { code: string; message: string; retryable: boolean } | undefined {
  const error = result.browserReceipt.error
  if (!error && result.browserReceipt.status === 'succeeded') return undefined
  return {
    code: error?.code ?? (result.browserReceipt.status === 'unknown' ? 'BROWSER_UNKNOWN' : 'BROWSER_FAILED'),
    message: error?.message ?? 'browser capability did not succeed',
    retryable: result.browserReceipt.status === 'unknown',
  }
}

/** Descriptor and typed ProductCapabilityAdapter for browser actions. */
export class BrowserCapabilityAdapter implements ProductCapabilityAdapter<BrowserCapabilityAdapterInput, BrowserCapabilityAdapterOutput> {
  readonly descriptor: ProductCapabilityDescriptor<BrowserCapabilityAdapterInput, BrowserCapabilityAdapterOutput>
  readonly service: BrowserGatewayService

  constructor(options: BrowserCapabilityAdapterOptions) {
    this.service = options.service
    const id = options.id ?? 'browser.gateway'
    this.descriptor = {
      id,
      capabilityId: id,
      kind: 'browser',
      apiVersion: options.apiVersion ?? 'v2',
      inputSchema: 'capybara.browser-action.v1',
      outputSchema: 'capybara.browser-observation.v1',
      scope: clone(options.scope ?? {}),
      // Browser actions carry their precise risk; the registry descriptor is
      // the broad adapter boundary and therefore uses the external side effect
      // permission ceiling.
      risk: 'external-side-effect',
      requiredPermission: options.requiredPermission ?? 'L3',
      evidenceKinds: ['browser-dom', 'screenshot', 'download', 'upload-manifest', 'external-receipt', 'reconciliation'],
      state: options.state ?? 'available',
      description: 'Typed Browser Gateway capability adapter',
      validateInput: (input) => {
        const reasons = validateBrowserAction(input)
        if (reasons.length > 0) throw new Error(`invalid browser action: ${reasons.join('; ')}`)
      },
      metadata: { actionKinds: ['navigate', 'read', 'click', 'input', 'select', 'upload', 'download', 'screenshot', 'wait', 'assert'] },
    }
  }

  async execute(context: ProductCapabilityExecutionContext<BrowserCapabilityAdapterInput>): Promise<ProductCapabilityExecutionResult<BrowserCapabilityAdapterOutput>> {
    const action = asBrowserAction(context.input, context.action)
    const result = await this.service.execute(action)
    const output = clone(result)
    const base = {
      output,
      evidenceRefs: result.evidence.map((item) => item.id),
      sideEffect: sideEffectFor(result),
    }
    if (result.browserReceipt.status === 'succeeded') return { status: 'succeeded', ...base }
    const error = errorFor(result)
    if (result.browserReceipt.status === 'unknown') return { status: 'unknown', ...(error ? { error } : {}), ...base }
    return { status: 'failed', error: error ?? { code: 'BROWSER_FAILED', message: 'browser capability failed', retryable: false }, ...base }
  }

  /** Convenience registration without coupling callers to adapter internals. */
  register(registry: ProductCapabilityRegistry): RegisteredProductCapability<BrowserCapabilityAdapterInput, BrowserCapabilityAdapterOutput> {
    return registry.register<BrowserCapabilityAdapterInput, BrowserCapabilityAdapterOutput>(this.descriptor, this)
  }
}

export function createBrowserCapabilityAdapter(options: BrowserCapabilityAdapterOptions): BrowserCapabilityAdapter {
  return new BrowserCapabilityAdapter(options)
}

export function browserCapabilityDescriptor(options: Omit<BrowserCapabilityAdapterOptions, 'service'> & { service?: BrowserGatewayService } = {}): ProductCapabilityDescriptor<BrowserCapabilityAdapterInput, BrowserCapabilityAdapterOutput> {
  const service = options.service ?? new BrowserGatewayService()
  return new BrowserCapabilityAdapter({ ...options, service }).descriptor
}
