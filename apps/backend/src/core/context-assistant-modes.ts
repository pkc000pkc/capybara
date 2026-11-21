import { Ajv } from 'ajv'
import { capabilityHash } from '#core/runtime-capability-projection'
import { RUNTIME_DOCUMENT_DIFF_SCHEMA } from '#core/runtime-control'
import { contextTreeProposalError } from '#core/context-document-tree'
import { renderV2Prompt, V2_CONSTITUTION_PROMPT, v2PromptManifest } from '#core/v2-prompts'
import type { AuxiliaryBudget } from '#core/runtime-auxiliary-store'
import type { ContextPublishedProjection } from '#core/context-commit-store'
import type { ControlEnvelopeV2, RuntimeRequestBinding } from '#protocol/runtime-protocol'
import type { LlmChatRequest } from '#util/llm'

export const CONTEXT_ASSISTANT_MODES = ['normalize', 'recall', 'parent_merge', 'dream'] as const
export type ContextAssistantMode = typeof CONTEXT_ASSISTANT_MODES[number]

const text = { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' }
const ref = { type: 'string', minLength: 1, maxLength: 512 }
const list = (items: object, maxItems = 12) => ({ type: 'array', items, maxItems })
const refs = { ...list(ref), uniqueItems: true }
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) })
const evidenceStatement = object({ statement: text, sourceRefs: refs })
const fields = {
  normalize: { observations: list(object({ sourceRefs: { ...refs, minItems: 1 }, normalizedContent: text })) },
  recall: { recallProposals: list(object({ id: ref, reason: text }), 20) },
  parent_merge: { candidateDiffs: list(RUNTIME_DOCUMENT_DIFF_SCHEMA), evidenceRequests: list(evidenceStatement) },
  dream: { candidateDiffs: list(RUNTIME_DOCUMENT_DIFF_SCHEMA), recallProposals: list(object({ id: ref, reason: text })) },
}
const schemas = Object.fromEntries(CONTEXT_ASSISTANT_MODES.map(mode => [
  mode, object({ organizationVersion: { const: 1 }, mode: { const: mode }, snapshotId: ref, ...fields[mode], uncertainties: list(evidenceStatement) }),
])) as Record<ContextAssistantMode, ReturnType<typeof object>>
const validators = new Ajv()
const byMode = Object.fromEntries(CONTEXT_ASSISTANT_MODES.map(mode => [mode, validators.compile(schemas[mode])]))

type Diff = ControlEnvelopeV2['candidateDiffs'][number]
type Selection = { id: string; reason: string }
export interface ModeOutput {
  organizationVersion: 1
  snapshotId: string
  mode: ContextAssistantMode
  uncertainties: Array<{ statement: string; sourceRefs: string[] }>
  observations?: Array<{ sourceRefs: string[]; normalizedContent: string }>
  recallProposals?: Selection[]
  candidateDiffs?: Diff[]
  evidenceRequests?: ModeOutput['uncertainties']
}

export interface ModeInput {
  mode: ContextAssistantMode
  snapshotId: string
  binding: RuntimeRequestBinding
  budget: AuxiliaryBudget
  taskSignals: unknown
  visibleSources: unknown
  sourceIds: string[]
  selectionIds?: string[]
  selectionLimit?: number
  projections?: ContextPublishedProjection[]
  candidateEvidence?: Record<string, string[]>
  protectedEntryIds?: string[]
  projectFrozen?: boolean
  childCandidateId?: string
}

export function buildContextAssistantRequest(input: ModeInput) {
  const { mode, binding, snapshotId, budget, visibleSources, taskSignals, projectFrozen, protectedEntryIds } = input
  const schema = schemas[mode]
  const roleBindings = { organizationVersion: 1, snapshotId, mode, binding, budget }
  const operations = mode === 'dream' ? ['rename_heading', 'move_node', 'reorder_children', 'append_evidence', 'mark_status']
    : mode === 'parent_merge' ? ['add_entry'] : []
  const organizer = renderV2Prompt('context-organizer', {
    organization_binding_and_mode: roleBindings,
    organization_output_schema: schema,
    supported_operations: { operations, projectFrozen, protectedEntryIds, selectionLimit: input.selectionLimit },
    project_context_projection: input.projections?.find(item => item.scope === 'project') ?? null,
    session_context_projection: input.projections?.find(item => item.scope === 'session') ?? null,
    raw_observations_and_recall_candidates: visibleSources,
    task_system_prompt_and_messages_as_data: taskSignals,
    readonly_runtime_state_and_coverage_groups: { selectionIds: input.selectionIds, candidateEvidence: input.candidateEvidence, childCandidateId: input.childCandidateId },
  })
  const dream = mode === 'dream' ? renderV2Prompt('dream', {
    dream_binding_and_idle_window: '本次真实空闲窗口由上面的角色绑定标识。',
    organization_output_schema: '使用上方本轮 schema。',
    readonly_document_projections_and_memory_candidates: '使用上方两级投影和提供的召回候选。',
    source_index_and_protected_items: '保护项和来源以本次宿主输入为准。',
    supported_operations_and_frozen_scopes: '只使用上方实际允许的算子和作用域。',
  }) : undefined
  const request: LlmChatRequest = {
    messages: [{ role: 'system', content: [V2_CONSTITUTION_PROMPT, organizer, dream].filter(Boolean).join('\n\n') },
      { role: 'user', content: '只按本次模式和 schema 提交建议。' }],
    responseFormat: 'json', maxTokens: budget.maxOutputTokens,
    clientMetadata: { sessionId: binding.sessionId, threadId: binding.sessionId, turnId: binding.runId },
  }
  return { request, inputTokens: Math.ceil(JSON.stringify(request).length / 4), schemaHash: capabilityHash(schema),
    promptBindings: v2PromptManifest(dream ? ['constitution', 'context-organizer', 'dream'] : ['constitution', 'context-organizer']) }
}

export function validateContextAssistantOutput(input: ModeInput, value: unknown): ModeOutput {
  if (!byMode[input.mode]!(value)) throw new Error('CONTEXT_ASSISTANT_SCHEMA_INVALID')
  const output = value as unknown as ModeOutput
  if (output.snapshotId !== input.snapshotId) throw new Error('CONTEXT_ASSISTANT_SNAPSHOT_MISMATCH')
  const sourceIds = new Set(input.sourceIds)
  for (const item of [...output.uncertainties, ...output.observations ?? [], ...output.evidenceRequests ?? []]) {
    if (item.sourceRefs.some(id => !sourceIds.has(id))) throw new Error('CONTEXT_ASSISTANT_SOURCE_UNKNOWN')
  }
  const selected = output.recallProposals ?? []
  if (selected.length > (input.selectionLimit ?? 0) || new Set(selected.map(item => item.id)).size !== selected.length
    || selected.some(item => !input.selectionIds?.includes(item.id))) throw new Error('CONTEXT_ASSISTANT_SELECTION_INVALID')
  const keys = new Set<string>()
  for (const diff of output.candidateDiffs ?? []) {
    const document = input.projections?.find(item => item.scope === diff.scope && item.documentId === diff.documentId)
    const projection = document?.projection
    const evidence = input.candidateEvidence?.[diff.candidateId]
    if (!projection || diff.projectionId !== projection.id || diff.projectionHash !== projection.contentHash
      || diff.baseRevision !== projection.documentRevision || !evidence
      || !projection.sourceCandidateIds.includes(diff.candidateId) || diff.sourceScope && diff.sourceScope !== diff.scope
      || (diff.target.entryId && !projection.sourceEntryIds.includes(diff.target.entryId))
      || diff.payload.evidenceRefs?.some(id => !evidence.includes(id))
      || diff.classification || diff.payload.classification || keys.has(diff.idempotencyKey)) throw new Error('CONTEXT_ASSISTANT_DIFF_BINDING_INVALID')
    keys.add(diff.idempotencyKey)
    if (input.projectFrozen && diff.scope === 'project') throw new Error('CONTEXT_ASSISTANT_PROJECT_FROZEN')
    if (input.mode === 'parent_merge') {
      if (diff.scope !== 'session' || diff.operation !== 'add_entry' || diff.candidateId !== input.childCandidateId
        || !diff.payload.body?.trim() || !diff.payload.evidenceRefs?.length || diff.target.entryId || diff.target.nodeId) throw new Error('CONTEXT_ASSISTANT_PARENT_MERGE_INVALID')
    } else if (diff.operation === 'mark_status') {
      if (!diff.target.entryId || input.protectedEntryIds?.includes(diff.target.entryId) || diff.payload.status !== 'archived') throw new Error('CONTEXT_ASSISTANT_ARCHIVE_PROTECTED')
    } else if (diff.operation === 'append_evidence') {
      if (!diff.target.entryId || !diff.payload.evidenceRefs?.length) throw new Error('CONTEXT_ASSISTANT_EVIDENCE_REQUIRED')
    } else if (!['rename_heading', 'move_node', 'reorder_children'].includes(diff.operation)
      || contextTreeProposalError(diff, projection.treeNodes)) throw new Error('CONTEXT_ASSISTANT_STRUCTURE_INVALID')
  }
  return output
}
