import type { JsonPatchOperation, JsonValue, RuntimeVariables } from '#protocol/runtime-protocol'
import type { ExperimentReference } from '#core/experiments/types'
import type { LlmMessage, LlmUsage } from '#util/llm'

export type HookFailurePolicy = 'continue' | 'retry'
export type HookCheckpoint = 'after_loop' | 'after_evaluation' | 'after_replay'

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

export interface HookParameterDefinition {
  key: string
  label: string
  description?: string
  defaultValue: string
  input: 'text' | 'number'
  min?: number
  max?: number
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
  checkpoint: HookCheckpoint
  status: HookStatusSnapshot
  changed: ReadonlySet<string>
  variables: Readonly<RuntimeVariables>
  loop: {
    runId: string
    iteration: number
  }
  training?: HookTrainingContext
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
  experiences?: HookExperienceCandidate[]
}

export interface HookVariableDiff {
  variableName: string
  baseHash?: string
  unifiedDiff: string
}

export interface HookExperienceCandidate {
  summary: string
  rationale: string
  patches: HookVariableDiff[]
}

export interface HookTrainingCase {
  id: string
  sampleId: string
  question: string
  thinking: string
  expectedAnswer: string
  actualAnswer: string
  expectedTools: string[]
  actualTools: string[]
  toolCalls: Array<{
    callId: string
    name: string
    status: 'completed' | 'failed'
    arguments: unknown
    resultPreview?: string
    error?: unknown
    startedAt: string
    completedAt?: string
    durationMs?: number
  }>
}

export interface HookTrainingContext {
  runId: string
  phase: 'training' | 'replay'
  parameters: Record<string, string>
  case: HookTrainingCase
  evaluation: {
    passed: boolean
    score: number
    rationale: string
    source?: 'llm' | 'project'
    metrics: Record<string, JsonValue>
    details?: JsonValue
    reference?: ExperimentReference
  }
  priorResults?: Record<string, JsonValue>
  candidate?: HookExperienceCandidate & { id: string }
}

export interface ProjectHookDefinition {
  name: string
  description: string
  enabled: boolean
  checkpoint?: HookCheckpoint
  trigger(context: HookTriggerContext): boolean
  schedule: HookSchedule
  permissions: HookPermissions
  parameters?: HookParameterDefinition[]
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
  checkpoint: HookCheckpoint
  schedule: HookSchedule
  permissions: HookPermissions
  parameters: HookParameterDefinition[]
  triggerSummary: string
  triggerInputs: string[]
  diagnostics: HookDiagnostic[]
  loadable: boolean
}

export interface HookFixture {
  checkpoint: HookCheckpoint
  runId: string
  loopIteration: number
  status: HookStatusSnapshot
  changedVariables: string[]
  variables: RuntimeVariables
  messages: LlmMessage[]
  training?: HookTrainingContext
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
