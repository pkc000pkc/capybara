import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { nativeControlEnvelopeSchema, type PlanProgressBinding } from '#core/runtime-control'
import type { RuntimeControlDecision, RuntimeRequestBinding, RuntimeTaskControl } from '#protocol/runtime-protocol'

export type V2PromptRole = 'constitution' | 'runtime' | 'context-organizer' | 'reflection' | 'dream' | 'child-agent'
const roles: V2PromptRole[] = ['constitution', 'runtime', 'context-organizer', 'reflection', 'dream', 'child-agent']
const promptAssets = Object.fromEntries(roles.map((role) => {
  const content = fs.readFileSync(new URL(`../../templates/system-prompts/v2/${role}.md`, import.meta.url), 'utf8')
  const version = content.match(/提示词版本：([^\s·]+)/)?.[1]
  if (!version) throw new Error(`V2_PROMPT_VERSION_MISSING: ${role}`)
  return [role, { content, version, hash: createHash('sha256').update(content).digest('hex') }]
})) as Record<V2PromptRole, { content: string; version: string; hash: string }>

export function v2PromptManifest(selected: readonly V2PromptRole[] = roles) {
  return selected.map((role) => ({ role, version: promptAssets[role].version, hash: promptAssets[role].hash }))
}

const referencedOrganizer = /^<!-- capybara:referenced-organization -->\r?\n([\s\S]*?)^<!-- \/capybara:referenced-organization -->\r?\n?/m
const extractiveOrganizer = /^<!-- capybara:extractive-organization -->\r?\n([\s\S]*?)^<!-- \/capybara:extractive-organization -->\r?\n?/m
const fileDispositionOrganizer = /^<!-- capybara:file-disposition -->\r?\n([\s\S]*?)^<!-- \/capybara:file-disposition -->\r?\n?/m
const archiveReviewBlock = /^<!-- capybara:archive-review -->\r?\n([\s\S]*?)^<!-- \/capybara:archive-review -->\r?\n(?:\r?\n)?/m
const organizerPrompt = promptAssets['context-organizer'].content
const standardOrganizer = organizerPrompt.replace(referencedOrganizer, '').replace(extractiveOrganizer, '').replace(fileDispositionOrganizer, '').trimEnd()

export function renderReferencedOrganizerPrompt(schema: object, version: 2 | 3 | 4 = 2, archiveReview = false): string {
  const body = organizerPrompt.match(version === 4 ? fileDispositionOrganizer : version === 3 ? extractiveOrganizer : referencedOrganizer)?.[1]
  if (!body) throw new Error('V2_REFERENCED_ORGANIZER_PROMPT_MISSING')
  return body.replace(archiveReviewBlock, (_match, instruction: string) => archiveReview ? `${instruction}\n` : '')
    .replace('{{ referenced_output_schema }}', () => JSON.stringify(schema)).trim()
}

/** One pass substitution: inserted data is never parsed as a template. */
export function renderV2Prompt(role: V2PromptRole, data: Record<string, unknown>,
  options: { showMcpForm?: boolean; showMcpRecovery?: boolean; showWorkflowRecovery?: boolean; showDelegation?: boolean; showChildReview?: boolean;
    showFileReferences?: boolean; showUnresolvedFileLines?: boolean; showContextReferences?: boolean; showFileQuotes?: boolean;
    showContextEditReceipts?: boolean; showPlannedDiffs?: boolean; showPlanExecution?: boolean; showPlanAmendment?: boolean; showSettledPlan?: boolean } = {}): string {
  const content = role === 'runtime' ? promptAssets[role].content.replace(
    /^<!-- capybara:mcp-form -->\r?\n([\s\S]*?)^<!-- \/capybara:mcp-form -->\r?\n(?:\r?\n)?/m,
    (_match, text: string) => options.showMcpForm ? `${text}\n` : '',
  ).replace(
    /^<!-- capybara:mcp-recovery -->\r?\n([\s\S]*?)^<!-- \/capybara:mcp-recovery -->\r?\n(?:\r?\n)?/m,
    (_match, text: string) => options.showMcpRecovery ? `${text}\n` : '',
  ).replace(
    /^<!-- capybara:workflow-recovery -->\r?\n([\s\S]*?)^<!-- \/capybara:workflow-recovery -->\r?\n(?:\r?\n)?/m,
    (_match, text: string) => options.showWorkflowRecovery ? `${text}\n` : '',
  ).replace(
    /^<!-- capybara:delegation -->\r?\n([\s\S]*?)^<!-- \/capybara:delegation -->\r?\n(?:\r?\n)?/m,
    (_match, text: string) => options.showDelegation ? `${text}\n` : '',
  ).replace(
    /^<!-- capybara:child-review -->\r?\n([\s\S]*?)^<!-- \/capybara:child-review -->\r?\n(?:\r?\n)?/m,
    (_match, text: string) => options.showChildReview ? `${text}\n` : '',
  ).replace(
    /^<!-- capybara:file-reference -->\r?\n([\s\S]*?)^<!-- \/capybara:file-reference -->\r?\n(?:\r?\n)?/m,
    (_match, text: string) => options.showFileReferences ? `${text}\n` : '',
  ).replace(
    /^<!-- capybara:unresolved-file-lines -->\r?\n([\s\S]*?)^<!-- \/capybara:unresolved-file-lines -->\r?\n(?:\r?\n)?/m,
    (_match, text: string) => options.showUnresolvedFileLines ? `${text}\n` : '',
  ).replace(
    /^<!-- capybara:context-references -->\r?\n([\s\S]*?)^<!-- \/capybara:context-references -->\r?\n(?:\r?\n)?/m,
    (_match, text: string) => options.showContextReferences ? `${text}\n` : '',
  ).replace(
    /^<!-- capybara:file-quotes -->\r?\n([\s\S]*?)^<!-- \/capybara:file-quotes -->\r?\n(?:\r?\n)?/m,
    (_match, text: string) => options.showFileQuotes ? `${text}\n` : '',
  ).replace(
    /^<!-- capybara:context-edit-receipts -->\r?\n([\s\S]*?)^<!-- \/capybara:context-edit-receipts -->\r?\n(?:\r?\n)?/m,
    (_match, text: string) => options.showContextEditReceipts ? `${text}\n` : '',
  ).replace(
    /^<!-- capybara:planned-diff -->\r?\n([\s\S]*?)^<!-- \/capybara:planned-diff -->\r?\n(?:\r?\n)?/m,
    (_match, text: string) => options.showPlannedDiffs ? `${text}\n` : '',
  ).replace(
    /^<!-- capybara:plan-execution -->\r?\n([\s\S]*?)^<!-- \/capybara:plan-execution -->\r?\n(?:\r?\n)?/m,
    (_match, text: string) => options.showPlanExecution ? `${text}\n` : '',
  ).replace(
    /^<!-- capybara:plan-amendment -->\r?\n([\s\S]*?)^<!-- \/capybara:plan-amendment -->\r?\n(?:\r?\n)?/m,
    (_match, text: string) => options.showPlanAmendment ? `${text}\n` : '',
  ).replace(
    /^<!-- capybara:plan-settled -->\r?\n([\s\S]*?)^<!-- \/capybara:plan-settled -->\r?\n(?:\r?\n)?/m,
    (_match, text: string) => options.showSettledPlan ? `${text}\n` : '',
  ) : role === 'context-organizer' ? standardOrganizer : promptAssets[role].content
  return content.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
    if (!Object.hasOwn(data, key)) throw new Error(`V2_PROMPT_INPUT_MISSING: ${role}.${key}`)
    return JSON.stringify(data[key])
  })
}

export const V2_CONSTITUTION_REVISION = promptAssets.constitution.version
export const V2_CONSTITUTION_PROMPT = promptAssets.constitution.content
export const V2_CANDIDATE_NORMALIZE_PROMPT = standardOrganizer
export const V2_EVIDENCE_REVIEW_PROMPT = '候选与证据经运行时门禁审核；整理器保留各来源主张，不替主任务模型裁决。'
export const V2_REFLECTION_PROMPT = promptAssets.reflection.content
export const V2_DREAM_PROMPT = promptAssets.dream.content
export const V2_MEMORY_RECALL_PROMPT = standardOrganizer
export const V2_A2A_CHILD_PROMPT = promptAssets['child-agent'].content
export const V2_PARENT_MERGE_PROMPT = standardOrganizer
export const V2_FINAL_RESPONSE_PROMPT = '用户回复依据真实观察、执行收据和已确认信息；分别说明失败、未知、推断与未完成事项。'

export interface RuntimePromptState {
  task?: string
  documentRevision: number
  projectionProfile: string
  pendingCandidateCount: number
  uncertaintyCount?: number
  sessionId?: string
  runId?: string
  requestId?: string
  binding?: RuntimeRequestBinding
  taskControl?: RuntimeTaskControl
  runtimeState?: unknown
  capabilityCatalog?: unknown
  child?: boolean
  showMcpForm?: boolean
  showMcpRecovery?: boolean
  showWorkflowRecovery?: boolean
  showDelegation?: boolean
  showChildReview?: boolean
  showFileReferences?: boolean
  showUnresolvedFileLines?: boolean
  showContextReferences?: boolean
  showNativeFileQuotes?: boolean
  showContextEditReceipts?: boolean
  showPlannedDiffs?: boolean
  allowedDecisions?: readonly RuntimeControlDecision[]
  hasCompletedActions?: boolean
  askUserTaskIds?: readonly string[]
  planProgressBinding?: PlanProgressBinding
}

export function buildV2RuntimePrompt(state: RuntimePromptState): string {
  if (!state.binding) return '当前尚无模型请求绑定；此处为只读上下文预览。'
  const showFileQuotes = (state.showContextReferences === true || state.showNativeFileQuotes === true)
    && (state.allowedDecisions?.includes('finish') ?? true)
  const tasks = state.taskControl?.tasks ?? []
  const runtime = renderV2Prompt('runtime', {
    request_binding: state.binding,
    output_schema: nativeControlEnvelopeSchema(state.allowedDecisions, state.hasCompletedActions, showFileQuotes, state.showPlannedDiffs,
      state.askUserTaskIds, state.planProgressBinding, tasks.length ? state.binding.taskId : undefined, state.binding),
    action_transport: 'provider-native',
    runtime_state: state.runtimeState ?? state.taskControl,
    capability_catalog: state.capabilityCatalog ?? [],
    project_context_projection: '本请求的 project_context 数据区，包含投影绑定。',
    session_context_projection: '本请求的 session_context 数据区，包含投影绑定。',
    recent_messages_and_observations: '本请求独立消息通道中的近期消息与真实工具结果。',
  }, {
    showMcpForm: state.showMcpForm, showFileReferences: state.showFileReferences,
    showMcpRecovery: state.showMcpRecovery, showWorkflowRecovery: state.showWorkflowRecovery,
    showDelegation: state.showDelegation, showChildReview: state.showChildReview,
    showUnresolvedFileLines: state.showUnresolvedFileLines, showContextReferences: state.showContextReferences,
    showFileQuotes, showContextEditReceipts: state.showContextEditReceipts, showPlannedDiffs: state.showPlannedDiffs,
    showPlanExecution: Boolean(state.taskControl?.planning?.required || tasks.length),
    showPlanAmendment: tasks.length > 0 && (state.allowedDecisions?.includes('propose_plan') ?? true),
    showSettledPlan: state.allowedDecisions?.includes('finish') === true && tasks.length > 0
      && tasks.every(task => task.status === 'completed'),
  })
  return runtime
}
