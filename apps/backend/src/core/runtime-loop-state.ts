import type {
  ChatMessage,
  HarnessDefinition,
  JsonValue,
  RenderResultState,
  RuntimeArtifactMeta,
  RuntimeEffectiveContextRevision,
  RuntimeObservation,
  RuntimeSnapshot,
  RuntimeVariables,
  RuntimeWorkflowsState,
  SkillDefinition,
  TimelineStep,
  ToolDefinition,
} from '#protocol/runtime-protocol'
import type { ToolCallRequest } from '#core/tools/types'
import type {
  GeneratedWorkflowDefinition,
  WorkflowExecutionData,
} from '#core/workflows/generated-workflow'
import type { LlmMessage, LlmUsage } from '#util/llm'

export const MAX_RETAINED_CHECKPOINTS = 8

export function retainRecentCheckpoints<T>(checkpoints: T[]): T[] {
  return checkpoints.length <= MAX_RETAINED_CHECKPOINTS
    ? checkpoints
    : checkpoints.slice(-MAX_RETAINED_CHECKPOINTS)
}

/** Remove tool messages whose complete assistant call group cannot be recovered. */
export function discardOrphanToolMessages(messages: readonly LlmMessage[]): LlmMessage[] {
  const sanitized: LlmMessage[] = []
  for (let index = 0; index < messages.length;) {
    const message = messages[index] as LlmMessage
    const calls = message.role === 'assistant' ? message.toolCalls ?? [] : []
    if (calls.length === 0) {
      if (message.role !== 'tool') sanitized.push(message)
      index += 1
      continue
    }

    let nextIndex = index + 1
    const outputs: LlmMessage[] = []
    while (messages[nextIndex]?.role === 'tool') {
      outputs.push(messages[nextIndex] as LlmMessage)
      nextIndex += 1
    }
    const expectedIds = new Set(calls.map((call) => call.id))
    const seenOutputIds = new Set<string>()
    const matchingOutputs = outputs.filter((output) => {
      const id = output.toolCallId
      if (typeof id !== 'string' || !expectedIds.has(id) || seenOutputIds.has(id)) return false
      seenOutputIds.add(id)
      return true
    })
    const complete = expectedIds.size === calls.length
      && seenOutputIds.size === expectedIds.size
    if (complete) sanitized.push(message, ...matchingOutputs)
    index = nextIndex
  }
  return sanitized
}

export function hasUnknownToolOutcome(step: TimelineStep | undefined): boolean {
  return step?.type === 'tool' && step.detail?.unknownOutcome === true
}

export function interruptTimelineStep(
  step: TimelineStep,
  completedAt = new Date().toISOString(),
): TimelineStep {
  const replay = step.detail?.replay
  const unknownOutcome = step.type === 'tool' && replay !== 'safe'
  return {
    ...step,
    status: 'interrupted',
    completedAt,
    detail: {
      ...(step.detail ?? {}),
      ...(unknownOutcome ? {
        unknownOutcome: true,
        outcome: 'unknown',
        recoveryAction: 'restart_with_side_effect_confirmation',
      } : {}),
    },
  }
}

export interface RuntimeCheckpoint {
  id: string
  createdAt: string
  currentStep: number
  currentStepId?: string
  contextRevisionId?: string
  variables: RuntimeVariables
  renderResult: RenderResultState
  messages: ChatMessage[]
  llmMessages: LlmMessage[]
  tools: ToolDefinition[]
  harnesses: HarnessDefinition[]
  skills: SkillDefinition[]
  timeline: TimelineStep[]
  effectiveContexts: RuntimeEffectiveContextRevision[]
  observations: RuntimeObservation[]
  pendingToolCalls: Array<[string, ToolCallRequest]>
  pendingWorkflowCalls?: Array<[string, ToolCallRequest]>
  workflowDefinitions?: Array<[string, GeneratedWorkflowDefinition]>
  workflowData?: Array<[string, WorkflowExecutionData]>
  workflows?: RuntimeWorkflowsState
  toolRound: number
  continuationRound: number
  loopIteration?: number
  loopVariableBaseline?: RuntimeVariables
  usage: LlmUsage
}

export interface StoredRuntimeArtifact {
  meta: RuntimeArtifactMeta
  value: JsonValue
}

export interface RuntimeLoopState {
  version: 1
  snapshot: RuntimeSnapshot
  artifacts: StoredRuntimeArtifact[]
  llmMessages: LlmMessage[]
  checkpoints: RuntimeCheckpoint[]
  pendingToolCalls: Array<[string, ToolCallRequest]>
  pendingWorkflowCalls?: Array<[string, ToolCallRequest]>
  workflowDefinitions?: Array<[string, GeneratedWorkflowDefinition]>
  workflowData?: Array<[string, WorkflowExecutionData]>
  clientMessageIds: string[]
  runCounter: number
  assistantCounter: number
  toolRound: number
  continuationRound: number
  loopIteration?: number
  loopVariableBaseline?: RuntimeVariables
  runUsage: LlmUsage
}
