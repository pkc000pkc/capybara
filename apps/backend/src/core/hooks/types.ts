import type { JsonPatchOperation, JsonValue, RuntimeVariables } from '#protocol/runtime-protocol'
import type { LlmMessage, LlmUsage } from '#util/llm'

export type HookFailurePolicy = 'continue' | 'retry'

export interface HookSchedule {
  priority: number
  timeoutMs: number
  onError: HookFailurePolicy
}

export interface HookPermissions {
  llm?: 'project'
  variables?: 'patch'
  messages?: 'replace'
  artifacts?: 'write'
}

export interface HookStatusSnapshot {
  run: {
    status: 'completed' | 'failed' | 'cancelled'
    failure?: JsonValue
  }
  context: {
    usedTokens: number
    maxTokens: number
    utilization: number
  }
  queueDepth: number
  messageCount: number
  variableTokens: Record<string, number>
}

export interface HookTriggerContext {
  status: HookStatusSnapshot
  changed: ReadonlySet<string>
  variables: Readonly<RuntimeVariables>
  loop: {
    runId: string
    iteration: number
  }
}

export interface HookRunContext extends HookTriggerContext {
  messages: readonly LlmMessage[]
  llm?: unknown
  signal?: AbortSignal
  logger?: unknown
}

export interface HookResult {
  patches?: JsonPatchOperation[]
  messages?: LlmMessage[]
  artifacts?: Array<{
    title: string
    value: JsonValue
  }>
  metadata?: JsonValue
}

export interface ProjectHookDefinition {
  name: string
  description: string
  enabled: boolean
  trigger(context: HookTriggerContext): boolean
  schedule: HookSchedule
  permissions: HookPermissions
  run(context: HookRunContext): Promise<HookResult> | HookResult
}

export interface HookDiagnostic {
  severity: 'warning' | 'error'
  code: string
  message: string
}

export interface RegisteredHook {
  id: string
  name: string
  description: string
  entryFile: string
  source: string
  revision: string
  enabled: boolean
  schedule: HookSchedule
  permissions: HookPermissions
  triggerSummary: string
  triggerInputs: string[]
  diagnostics: HookDiagnostic[]
  loadable: boolean
}

export interface HookFixture {
  checkpoint: 'after_loop'
  runId: string
  loopIteration: number
  status: HookStatusSnapshot
  changedVariables: string[]
  variables: RuntimeVariables
  messages: LlmMessage[]
}

export interface HookRunResult {
  matched: boolean
  result?: HookResult
  durationMs: number
  attempts: number
  usage: LlmUsage
  logs: Array<{
    level: 'debug' | 'info' | 'warn' | 'error'
    message: string
    data?: JsonValue
  }>
}
