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
  hooks?: 'write'
  research?: 'append'
}

export interface HookResearchEvent {
  eventType: string
  idempotencyKey: string
  payload: JsonValue
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
  research?: {
    ledgerHead: string
    totalEvents: number
    events: Array<{
      event_id: string
      event_type: string
      event_hash: string
      payload: JsonValue
      source: { hook_id: string }
    }>
  }
}

export interface HookTriggerContext {
  checkpoint: HookCheckpoint
  status: HookStatusSnapshot
  changed: ReadonlySet<string>
  variables: Readonly<RuntimeVariables>
  loop: {
    runId: string
    iteration: number
    terminal: boolean
  }
  messages: readonly LlmMessage[]
  training?: HookTrainingContext
}

export interface HookRunContext extends HookTriggerContext {
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
  correction?: HookCorrectionProposal
  admission?: HookAdmissionDecision
  hookFiles?: Array<{
    name: string
    source: string
  }>
  researchEvents?: HookResearchEvent[]
}

export interface HookCorrectionProposal {
  summary: string
  strategy: string
  variableOverrides: Record<string, string>
}

export type HookAdmissionVerdict = 'accept' | 'reject' | 'revise' | 'retry_correction'

export interface HookAdmissionDecision {
  verdict: HookAdmissionVerdict
  reasons: string[]
  revisedCandidate?: HookExperienceCandidate
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
  failureEvidence?: {
    outcome: 'incorrect'
    message: string
    actualAnswer: string
    actualTools: string[]
    toolCalls: HookTrainingCase['toolCalls']
  }
  priorResults?: Record<string, JsonValue>
  correctionAttempts?: Array<{
    ordinal: number
    summary: string
    strategy: string
    passed: boolean
    score: number
    rationale: string
    variableOverrides: Record<string, string>
    actualAnswer: string
    actualTools: string[]
    toolCalls: HookTrainingCase['toolCalls']
  }>
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
  ownerId: string
  ownerKind: 'system' | 'project' | 'installed'
  mode: 'runtime' | 'training'
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
  loopTerminal?: boolean
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
