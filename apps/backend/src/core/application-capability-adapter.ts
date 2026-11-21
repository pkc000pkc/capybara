import {
  type ApplicationRuntimeActionResult,
  type ApplicationRuntimeHealthInput,
  type ApplicationRuntimeOperation,
  type ApplicationRuntimeRollbackInput,
  type ApplicationRuntimeStopInput,
  type ApplicationRuntimeUpdateInput,
  ApplicationRuntimeService,
} from '#core/application-runtime-service'
import type {
  ProductCapabilityAdapter,
  ProductCapabilityDescriptor,
  ProductCapabilityExecutionContext,
  ProductCapabilityExecutionResult,
} from '#core/product-capability-registry'

export type ApplicationRuntimeCapabilityInput =
  | { operation: 'preview'; versionId: string; runId?: string }
  | { operation: 'deploy'; versionId: string; runId?: string; deploymentRef?: string }
  | { operation: 'start'; versionId: string; runId?: string; instanceId?: string; healthCheckRef?: string; smokeCheckPassed?: boolean }
  | ({ operation: 'stop' } & ApplicationRuntimeStopInput)
  | ({ operation: 'health_check' } & ApplicationRuntimeHealthInput)
  | ({ operation: 'update' } & ApplicationRuntimeUpdateInput)
  | ({ operation: 'rollback' } & ApplicationRuntimeRollbackInput)

export type ApplicationRuntimeCapabilityOutput = ApplicationRuntimeActionResult

const OPERATIONS: readonly ApplicationRuntimeOperation[] = ['preview', 'deploy', 'start', 'stop', 'health_check', 'update', 'rollback']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`)
  return value
}

/** Validate registry input before an application runtime Action is admitted. */
export function validateApplicationRuntimeCapabilityInput(value: unknown): asserts value is ApplicationRuntimeCapabilityInput {
  if (!isRecord(value) || !OPERATIONS.includes(value.operation as ApplicationRuntimeOperation)) throw new Error('application runtime operation is invalid')
  requireString(value.versionId, 'application runtime versionId')
  if (value.runId !== undefined) requireString(value.runId, 'application runtime runId')
  switch (value.operation) {
    case 'update':
      requireString(value.currentVersionId, 'application runtime currentVersionId')
      requireString(value.newVersionId, 'application runtime newVersionId')
      if (value.healthPassed !== undefined && typeof value.healthPassed !== 'boolean') throw new Error('application runtime healthPassed must be boolean')
      if (value.smokeCheckPassed !== undefined && typeof value.smokeCheckPassed !== 'boolean') throw new Error('application runtime smokeCheckPassed must be boolean')
      break
    case 'rollback':
      requireString(value.targetVersionId, 'application runtime targetVersionId')
      requireString(value.reason, 'application runtime rollback reason')
      break
    case 'health_check':
      if (typeof value.passed !== 'boolean') throw new Error('application runtime passed must be boolean')
      if (value.smokeCheckPassed !== undefined && typeof value.smokeCheckPassed !== 'boolean') throw new Error('application runtime smokeCheckPassed must be boolean')
      break
    case 'start':
      if (value.smokeCheckPassed !== undefined && typeof value.smokeCheckPassed !== 'boolean') throw new Error('application runtime smokeCheckPassed must be boolean')
      break
    case 'stop':
      break
    default:
      break
  }
}

export function applicationRuntimeCapabilityDescriptor(
  projectId: string,
  appId: string,
): ProductCapabilityDescriptor<ApplicationRuntimeCapabilityInput, ApplicationRuntimeCapabilityOutput> {
  return {
    id: 'application-runtime',
    capabilityId: 'application-runtime',
    kind: 'application-runtime',
    apiVersion: '1',
    inputSchema: 'ApplicationRuntimeCapabilityInput',
    outputSchema: 'ApplicationRuntimeActionResult',
    scope: { projectIds: [projectId], objects: [appId] },
    risk: 'execution',
    requiredPermission: 'L2',
    evidenceKinds: ['application-preview', 'application-deploy', 'application-start', 'application-stop', 'health-check', 'application-update', 'application-rollback', 'permission'],
    state: 'available',
    description: 'Preview, deploy, run, update, health-check and rollback a project application.',
    validateInput: validateApplicationRuntimeCapabilityInput,
    metadata: { appId },
  }
}

export class ApplicationRuntimeCapabilityAdapter implements ProductCapabilityAdapter<ApplicationRuntimeCapabilityInput, ApplicationRuntimeCapabilityOutput> {
  readonly descriptor: ProductCapabilityDescriptor<ApplicationRuntimeCapabilityInput, ApplicationRuntimeCapabilityOutput>
  private readonly service: ApplicationRuntimeService

  constructor(service: ApplicationRuntimeService) {
    this.service = service
    this.descriptor = applicationRuntimeCapabilityDescriptor(service.manifest.projectId, service.manifest.appId)
  }

  execute(
    context: ProductCapabilityExecutionContext<ApplicationRuntimeCapabilityInput>,
  ): ProductCapabilityExecutionResult<ApplicationRuntimeCapabilityOutput> {
    validateApplicationRuntimeCapabilityInput(context.input)
    const input = context.input
    let result: ApplicationRuntimeActionResult
    switch (input.operation) {
      case 'preview':
        result = this.service.preview(input.versionId, input.runId ?? context.action.runId)
        break
      case 'deploy':
        result = this.service.deploy(input.versionId, { runId: input.runId ?? context.action.runId, deploymentRef: input.deploymentRef })
        break
      case 'start':
        result = this.service.start(input.versionId, { runId: input.runId ?? context.action.runId, instanceId: input.instanceId, healthCheckRef: input.healthCheckRef, smokeCheckPassed: input.smokeCheckPassed })
        break
      case 'stop':
        result = this.service.stop(input.versionId, { runId: input.runId ?? context.action.runId, instanceId: input.instanceId, hostResult: input.hostResult })
        break
      case 'health_check':
        result = this.service.healthCheck(input)
        break
      case 'update':
        result = this.service.update(input)
        break
      case 'rollback':
        result = this.service.rollback(input)
        break
    }
    const common = {
      evidenceRefs: [result.evidence.evidenceId],
      resultHash: result.receipt.resultHash,
      adapterRunId: context.action.runId,
      sideEffect: result.receipt.sideEffect,
    }
    if (result.receipt.status === 'unknown') {
      return { status: 'unknown', ...common, error: result.receipt.error }
    }
    if (!result.ok || result.receipt.status === 'failed') {
      return {
        status: 'failed',
        ...common,
        error: result.receipt.error ?? { code: 'APPLICATION_RUNTIME_FAILED', message: result.error ?? 'application runtime operation failed', retryable: false },
      }
    }
    return { status: 'succeeded', output: result, ...common }
  }
}

export function createApplicationRuntimeCapabilityAdapter(service: ApplicationRuntimeService): ApplicationRuntimeCapabilityAdapter {
  return new ApplicationRuntimeCapabilityAdapter(service)
}
