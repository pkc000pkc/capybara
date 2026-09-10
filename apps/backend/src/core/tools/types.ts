import type { ValidateFunction } from 'ajv'
import type { ToolNetworkRetrySettings } from '#core/tools/network-retry'

export type ToolPermission =
  | 'filesystem:read'
  | 'filesystem:write'
  | 'filesystem:delete'
  | (string & {})

export interface ToolRunnerDefinition {
  type: 'stdio'
  entry: string
}

export interface ProjectToolDefinition {
  name: string
  description: string
  permissions: ToolPermission[]
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  examples?: Record<string, unknown>[]
  sideEffects?: 'none' | 'workspace-write' | 'external'
  replay?: 'safe' | 'confirm' | 'never'
  /** Opt in to request-level retries implemented by the runner; overrides project defaults. */
  networkRetry?: Partial<ToolNetworkRetrySettings>
}

export interface ToolManifest {
  version: 1
  package: string
  packageVersion?: string
  runner: ToolRunnerDefinition
  tools: ProjectToolDefinition[]
}

export interface RegisteredTool extends ProjectToolDefinition {
  id: string
  packageName: string
  packageVersion: string
  manifestVersion: number
  manifestFile: string
  runnerEntry: string
  validateInput: ValidateFunction
  validateOutput?: ValidateFunction
}

export interface ToolCallRequest {
  id: string
  name: string
  arguments: unknown
}

export type ToolCallErrorCode =
  | 'TOOL_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'INVALID_ARGUMENTS'
  | 'RUNNER_FAILED'
  | 'INVALID_RESPONSE'
  | 'INVALID_OUTPUT'
  | 'OUTPUT_LIMIT'
  | 'TIMEOUT'
  | 'ABORTED'

export interface ToolCallResult {
  id: string
  name: string
  ok: boolean
  output?: unknown
  error?: {
    code: ToolCallErrorCode
    message: string
    details?: unknown
  }
  startedAt: string
  completedAt: string
  durationMs: number
}
