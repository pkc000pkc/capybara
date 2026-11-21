import type { JsonObject, RuntimeRequestBinding } from '#protocol/runtime-protocol'
import type { ToolCallResult } from '#core/tools/types'

export type McpOperationSource = NonNullable<ToolCallResult['source']>

export interface McpOperationBinding {
  taskId: string
  runId: string
  stepId?: string
  callId: string
  toolName: string
  argumentHash: string
  verification?: { toolName: string; authorityVersion: string; originalOutputSchema?: JsonObject; poll?: { intervalMs: number; connectionAuthority: string } }
}

export interface McpVerificationReceipt {
  id: string
  operationId: string
  outcome: 'applied' | 'not_applied'
  verifiedAt: string
  verificationRequest: RuntimeRequestBinding
  verificationCallId: string
  source: McpOperationSource
  artifactId: string
  artifactHash: string
  originalResult?: { artifactId: string; artifactHash: string }
}

export interface McpOperation {
  source: McpOperationSource
  binding?: McpOperationBinding
  verification?: McpVerificationReceipt
  continuation?: { formId: string; callId: string; artifactId: string; artifactHash: string; source: McpOperationSource }
  output?: unknown
}

/** The host contract accepts only a definitive disposition for the exact operation. */
export function mcpVerificationOutcome(value: unknown, operationId: string): McpVerificationReceipt['outcome'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const response = value as Record<string, unknown>
  if ((response.resultType !== undefined && response.resultType !== 'complete') || response.isError === true || !response.structuredContent
    || typeof response.structuredContent !== 'object' || Array.isArray(response.structuredContent)) return undefined
  const report = response.structuredContent as Record<string, unknown>
  if (Object.keys(report).some(key => !['operation_id', 'outcome', 'original_result'].includes(key)) || report.operation_id !== operationId
    || ('original_result' in report && report.outcome !== 'applied')) return undefined
  return report.outcome === 'applied' || report.outcome === 'not_applied' ? report.outcome : undefined
}
