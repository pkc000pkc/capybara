import { createHash, randomUUID } from 'node:crypto'
import { contextDocumentList, contextTreeProposalError } from '#core/context-document-tree'
import { proposalHash } from '#core/context-document-engine'
import type { ContextOutcome, ContextOutcomeAttempt, ContextPublication } from '#core/context-commit-store'
import { CONTEXT_DIFF_OPERATIONS, CONTEXT_TREE_OPERATIONS } from '#protocol/runtime-protocol'
import { diagnosticContext, diagnosticLog } from '#util/llm/diagnostic-log'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import nunjucks from 'nunjucks'

import { ContextBuilder, type RenderEvent } from '#core/context-builder'
import { matchesModelHarnessActivation } from '#core/harnesses/harness-registry'
import { HookRegistry } from '#core/hooks/hook-registry'
import { HookRunner, type HookLlmActivity } from '#core/hooks/hook-runner'
import type { HookContextObservation, HookContextProposal, HookFixture, HookResult, HookStatusSnapshot } from '#core/hooks/types'
import { Loop } from '#core/loop'
import { PluginRegistry } from '#core/plugins/plugin-registry'
import { bundledAuthoringHarnessTemplate, installSystemProjectResources, isDefaultProjectMainTemplate } from '#core/project-initializer'
import { createProjectLlmService } from '#core/project-llm'
import { enqueueProjectWrite } from '#core/project-write-queue'
import { appendResearchEvents, readResearchLedgerEvents } from '#core/research-ledger'
import { ProjectResourceRegistry } from '#core/resources/resource-registry'
import {
  ProjectResources,
  type ProjectResourceChange,
  type ProjectSettings,
  type SystemVariableChange,
  type SystemVariableDefinition,
  type SystemVariablesResource,
  systemVariableValueHash,
} from '#core/project-resources'
import {
  resolveSystemPromptVariables,
  templateVariablePaths,
  SYSTEM_PROMPT_VARIABLE_TYPES,
  canonicalSystemPromptVariableValue,
  validateSystemPromptVariableValue,
  type SystemPromptVariableType,
  type SystemPromptVariableValue,
} from '#core/system-prompt-templates'
import {
  loadRuntimeHarnessCatalog,
  type HarnessCatalogEntry,
} from '#core/resources/harness-catalog'
import { SkillRegistry } from '#core/skills/skill-registry'
import {
  SkillMarketplaceService,
  type InstalledSkillSummary,
  type SkillPreview,
  type SkillSearchResult,
} from '#core/skills/skill-marketplace'
import { SkillScriptRunner } from '#core/skills/skill-script-runner'
import type { RegisteredSkill } from '#core/skills/types'
import { ToolDispatcher } from '#core/tools/tool-dispatcher'
import { ToolRegistry } from '#core/tools/tool-registry'
import { McpClientManager } from '#core/mcp/client-manager'
import { MCP_INPUT_RESPONDED, type McpInputContinuation, type McpInputData } from '#core/mcp/input'
import { mcpVerificationOutcome, type McpOperation } from '#core/mcp/operations'
import { BRANCH_EVIDENCE, BRANCH_HUMAN_REPLY, MCP_OPERATION_SETTLED, RuntimeWaitStore, type PreparedWait } from '#core/runtime-wait-store'
import { RuntimeChildService, type ChildWorker } from '#core/runtime-child-service'
import { childAssignment, terminalChild, type ChildActionRequest, type ChildActionResult, type ChildBinding, type ChildRecord, type ChildSpec, type ParentTakeoverAction } from '#core/runtime-child-store'
import { parseClientCommand } from '#protocol/runtime-protocol'
import type { RuntimeBranchBlock, RuntimeControlDecision, RuntimeEvidenceRequest, RuntimeWaitSpec, RuntimeWaitSubscription, RuntimeWaitsState, RuntimeWaitSignal, RuntimeRequestBinding } from '#protocol/runtime-protocol'
import type { ToolCallRequest, ToolCallResult } from '#core/tools/types'
import {
  BrowserCapability,
  type BrowserAction,
  type BrowserProfile,
  type BrowserSession,
  type PageState,
  type Tab,
} from '#core/browser-capability'
import {
  BrowserGatewayService,
  type BrowserExecutionRequest,
  type BrowserExecutionResult,
} from '#core/browser-gateway-service'

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

import { INTERNAL_RESOURCE_TOOLS } from '#core/runtime-resource-tools'
import { bindRuntimeSkillActivation, selectRuntimeSkills } from '#core/runtime-skill-projection'
import { assertRuntimeCapabilityCall, assertRuntimeDecision, capabilityAccessDenial, capabilityHash, hasRunnableBranch, projectRuntimeCapabilities, runtimeCapabilityBinding, runtimeExecutionState, runtimeHumanQuestionTargets, RuntimeCapabilityError, selectRuntimeCapabilities, type RuntimeCapability } from '#core/runtime-capability-projection'
import type { RuntimeCapabilityAuthorization, RuntimeCapabilityBinding, RuntimeCapabilityProjection, RuntimeChildAssignment, RuntimeExecutionState, RuntimePlanTask, RuntimeTaskControl } from '#protocol/runtime-protocol'
import { createHttpBrowserExecutor } from '#core/http-browser-executor'
import { createDefaultMarketResearchService } from '#core/stock-market-research-factory'
import { ProjectArtifactIndex } from '#core/project-artifact-index'
import {
  discardOrphanToolMessages,
  hasUnknownToolOutcome,
  interruptTimelineStep,
  retainRecentCheckpoints,
  type RuntimeCheckpoint,
  type RuntimeBrowserContextState,
  type RuntimeLoopState,
  type StoredRuntimeArtifact,
} from '#core/runtime-loop-state'
export {
  discardOrphanToolMessages,
  hasUnknownToolOutcome,
  interruptTimelineStep,
  MAX_RETAINED_CHECKPOINTS,
  retainRecentCheckpoints,
  type RuntimeLoopState,
} from '#core/runtime-loop-state'
import {
  applyPatch,
  assertRuntimeCache,
  assertSafeToken,
  changedVariablePaths,
  clone,
  decodePointer,
  emptyRuntimeCache,
  escapePointerToken,
  isObject,
  type ModelOutput,
  ModelOutputStream,
  parseModelOutput, isStructuredReplyDraft,
  renderFileQuotes,
  runtimeCacheMessages,
  textDiff,
  toJsonValue,
} from '#core/runtime-loop-utils'
import {
  filterWorkflowItems,
  transformWorkflowItems,
  assertWorkflowValue,
  compileGeneratedWorkflow,
  needsWorkflowOutput,
  resolveWorkflowValue,
  workflowCondition,
  type GeneratedWorkflowDefinition,
  type GeneratedWorkflowStep,
  type WorkflowExecutionData,
  type WorkflowAlignStep,
  type WorkflowJoinStep,
  type WorkflowParseStep,
  type WorkflowValidateSchemaStep,
} from '#core/workflows/generated-workflow'
import {
  alignWorkflowRecords,
  joinWorkflowRecords,
  parseWorkflowValue,
  validateWorkflowSchema,
} from '#core/workflows/schema-alignment'
import {
  CommandError,
  type ChannelEvent,
  type ChatMessage,
  type ClientCommand,
  type HarnessDefinition,
  type HarnessBinding,
  type HarnessCatalogDefinition,
  type JsonObject,
  type JsonPatchOperation,
  type JsonValue,
  type RenderResultState,
  type RunState,
  type RuntimeArtifactKind,
  type RuntimeArtifactMeta,
  type RuntimeBreakpoint,
  type RuntimeCache,
  type RuntimeCheckpointMeta,
  type RuntimeContextRevision,
  type RuntimeContextProjection,
  type ContextCandidateStatus,
  type RuntimeContextScopeKind,
  type RuntimeContextDiffProposal,
  type RuntimeContextObservation,
  type RuntimeContextClassification,
  type RuntimeContextCandidateReview,
  type RuntimeContextMemoryRecall,
  type RuntimeContextChildMerge,
  type RuntimeContextEvidenceReview,
  type RuntimeContextDreamPlan,
  type RuntimeEnvelope,
  type RuntimeV2ControlState,
  type RuntimeEffectiveContextRevision,
  type RuntimeFailure,
  type RuntimeFailurePhase,
  type RuntimeModelRetry,
  type RuntimeObservation,
  type RuntimePluginsState,
  type RuntimeSnapshot,
  type RuntimeSkillsState,
  type RuntimeSkillConfirmation,
  type RuntimeSkillConfirmationsState,
  type RuntimeStatusState,
  type RuntimeVariables,
  type RuntimeWorkflowNode,
  type RuntimeWorkflowPlan,
  type RuntimeWorkflowsState,
  type TemplateState,
  type TimelineStep,
  type TimelineStepType,
  type ToolDefinition,
  type SkillCatalogDefinition,
  type SkillDefinition,
  type SkillResourceState,
} from '#protocol/runtime-protocol'
import {
  isLlmContextLimitError,
  isLlmRequestRejection,
  LlmRequestError,
  LlmResponseValidationError,
  LlmToolArgumentsError,
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmConfig,
  type LlmMessage,
  type LlmRetryNotification,
  type LlmToolCall,
  type LlmToolDefinition,
  type LlmUsage,
} from '#util/llm'
import { estimateTokens } from '#util/token-estimate'
import { blockedToolRequest } from '#core/tools/recovery-policy'
import { ContextDocumentEngine, contextKnowledgeHash, type ContextDocument, type ContextDocumentEngineState } from '#core/context-document-engine'
import { canPromoteToProject, projectAnchorParts, sameContextPlacement, validateContextClassification, type ContextClassification } from '#core/context-classification'
import { ProjectContextStore } from '#core/project-context-store'
import { createContextScopesState, type RuntimeContextScopesState } from '#core/context-scope'
import { ContextTrainingRecorder, type ContextOrganizationRequestEvidence, type ContextOrganizationTrainingAttempt, type ContextTrainingArchiveRecord, type ContextTrainingCandidateReview, type ContextTrainingConflictRecord, type ContextTrainingEvidenceReview, type ContextTrainingRecallRecord, type ContextTrainingReceipt } from '#core/context-training-recorder'
import { RuntimeActivityState } from '#core/runtime-activity-state'
import { assetWriteAudit, assertAssetWriteAllowed } from '#core/asset-write-policy'
import { ContextHistory, isSuccessfulControlReceipt, type ContextHistoryMessage, type ContextHistoryState } from '#core/context-history'
import { extractRuntimeEntitySnapshots } from '#core/runtime-entity-snapshot'
import { ARTIFACT_SOURCE_REFERENCE_DIAGNOSTIC, coveredFileArtifacts, createFileEvidenceResolver, isPagingInputDiagnostic,
  isVerifiedActiveRecallCopy, isVerifiedFileArtifactPage, projectFileHistory, publishedFileArtifactId, publishedFileReadLine,
  readVerifiedFileArtifact, verifiedFilePageOrigin, visibleFileBatch } from '#core/context-file-projection'
import { describeFileLinePageFailure, fileArtifactLinePage, firstFileArtifactLinePage, MAX_ARTIFACT_PAGE_CHARACTERS } from '#core/context-source-excerpts'
import { organizeContext, type OrganizationResult } from '#core/context-organizer'
import { findRecallSources, recallContext, validateRecallQuery } from '#core/context-recall'
import { buildContextAssistantRequest, validateContextAssistantOutput, type ContextAssistantMode, type ModeInput, type ModeOutput } from '#core/context-assistant-modes'
import { RuntimeAuxiliaryRunner, DEFAULT_AUXILIARY_BUDGET } from '#core/runtime-auxiliary'
import { DEFAULT_MODEL_BUDGET, RuntimeModelBudgetError, RuntimeModelMeter, type ModelBudgetLimits, type ModelBudgetRole, type ModelBudgetScope, type ModelTokenCounter } from '#core/runtime-model-budget'
import type { AuxiliaryBudget, AuxiliaryRecord } from '#core/runtime-auxiliary-store'
import { reflectionRequest, validateReflection, type ReflectionInput, type ReflectionOutput, type ReflectionSource } from '#core/runtime-reflection'
import { acceptRuntimePlan, CompletionProposalError, ContextDiffProposalError, ControlEnvelopeFieldError, ControlPayloadError, emptyTaskControl, planProposalForAmendment, planProposalForProgress, requiresChildResult, resumeRuntimePlan } from '#core/runtime-control'
import {
  buildV2RuntimePrompt,
  V2_CONSTITUTION_PROMPT,
  V2_CONSTITUTION_REVISION,
  renderV2Prompt,
  v2PromptManifest,
} from '#core/v2-prompts'

export interface RuntimeLlm {
  readonly admitsTransportAttempts?: boolean
  chat(request: LlmChatRequest): Promise<LlmChatResponse>
  stream?(
    request: LlmChatRequest,
    onTextDelta: (delta: string) => void,
  ): Promise<LlmChatResponse>
  getConfig(): Readonly<LlmConfig>
}

export interface RuntimeApplicationHostRequest {
  action: 'start' | 'stop' | 'restart' | 'update' | 'rollback' | 'health_check'
  appId?: string
  instanceId?: string
  targetVersionId?: string
  reason?: string
  projectPath: string
  runId?: string
  stepId?: string
  callId: string
}

export interface RuntimeApplicationHostResult {
  ok: boolean
  output?: JsonValue
  error?: { code: string; message: string; details?: JsonValue }
  startedAt?: string
  completedAt?: string
  durationMs?: number
}

export interface RuntimeBrowserHostRequest {
  action: 'navigate' | 'read' | 'click' | 'input' | 'select' | 'screenshot' | 'wait' | 'assert' | 'download'
  browserInstanceId?: string
  url?: string
  target?: JsonObject
  value?: string
  script?: string
  allowExternal?: boolean
  allowedOrigins?: string[]
  timeoutMs?: number
  projectPath: string
  sessionId?: string
  runId: string
  stepId: string
  callId: string
}

export interface RuntimeBrowserHostResult {
  ok: boolean
  output?: JsonValue
  error?: { code: string; message: string; details?: JsonValue }
  startedAt?: string
  completedAt?: string
  durationMs?: number
}

export interface RuntimeChildAgentResult {
  ok: boolean
  output?: JsonValue
  /** Parent-visible evidence package for independently checking the child run. */
  evidence?: JsonValue
  actionReceipts?: JsonValue
  error?: { code: string; message: string; details?: JsonValue }
  startedAt?: string
  completedAt?: string
  durationMs?: number
}

export interface RuntimeLoopOptions {
  modelBudget?: Partial<ModelBudgetLimits> & { countTokens?: ModelTokenCounter }
  planningRequired?: boolean
  contextAssistant?: { llm?: RuntimeLlm; budget?: Partial<AuxiliaryBudget>; modes?: readonly ContextAssistantMode[] }
  sessionId?: string
  contextOrganization?: { enabled?: boolean; minGroups?: number; chunkCharacters?: number; maxOutputTokens?: number; llm?: RuntimeLlm }
  /** Prevents project-context writes while retaining session-local organization. */
  projectContextReadOnly?: boolean
  projectDir?: string
  workspaceDir?: string
  /** User-level system resource root. Defaults to ~/.capybara. */
  systemDir?: string
  streamDelayMs?: number
  stepDelayMs?: number
  llm?: RuntimeLlm
  initialState?: RuntimeLoopState
  /** Optional frozen project context supplied by a benchmark or replay snapshot. */
  initialProjectContext?: ContextDocumentEngineState
  /** Isolated experiment inputs, resolved against the effective plugin registry. */
  initialVariableOverrides?: Record<string, string>
  skillMarketplace?: RuntimeSkillMarketplace
  applicationHost?: (input: RuntimeApplicationHostRequest) => Promise<RuntimeApplicationHostResult>
  browserHost?: (input: RuntimeBrowserHostRequest) => Promise<RuntimeBrowserHostResult>
  openExternalMcpUrl?: (url: string) => Promise<void>
  childAgentHost?: (input: {
    goal: string
    prompt: string
    projectPath: string
    parentSessionId?: string
    parentTaskId: string
    parentRunId?: string
    parentStepId?: string
    planTaskId?: string
    callId: string
    childId: string
    childSessionId: string
    parentContext: string
    signal: AbortSignal
    allowedCapabilityIds: string[]
    allowedCapabilities?: RuntimeCapabilityBinding[]
    executionMode?: 'readonly' | 'action'
    attemptId?: string
    maxModelRounds: number
    maxToolRounds: number
    maxTotalTokens: number
    authorizeAction?: (request: ChildActionRequest) => import('#protocol/runtime-protocol').RuntimeChildActionReceipt
    recordActionResult?: (result: ChildActionResult) => import('#protocol/runtime-protocol').RuntimeChildActionReceipt
    llm: RuntimeLlm
  }) => Promise<RuntimeChildAgentResult>
  childAgentEnabled?: boolean
  childAgentMode?: boolean
  childExecution?: { childId: string; parent: ChildBinding; capabilityIds: string[]; assignment?: ChildSpec['assignment']; parentContext: string; maxToolRounds: number; executionMode?: 'readonly' | 'action'; attemptId?: string; assertAuthority: () => void; authorizeAction?: (request: ChildActionRequest) => import('#protocol/runtime-protocol').RuntimeChildActionReceipt; recordActionResult?: (result: ChildActionResult) => import('#protocol/runtime-protocol').RuntimeChildActionReceipt }
}

export interface RuntimeSkillMarketplace {
  search(input: { query?: unknown; owner?: unknown; page?: unknown; limit?: unknown }): Promise<{ items: SkillSearchResult[]; page: number }>
  preview(input: { repo?: unknown; path?: unknown }): Promise<SkillPreview>
  installed(): InstalledSkillSummary[]
  install(input: { repo?: unknown; path?: unknown; commit?: unknown }): Promise<unknown>
  uninstall(skillId: unknown): Promise<unknown>
}

const MAX_GENERATED_HOOK_FILES = 8
const MAX_GENERATED_HOOK_TOTAL_BYTES = 1024 * 1024
const MAX_SKILL_CONFIRMATIONS = 50

class RuntimeStageError extends Error {
  constructor(
    readonly phase: RuntimeFailurePhase,
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly diagnostics?: JsonValue,
  ) {
    super(message)
    this.name = 'RuntimeStageError'
  }
}

/** Only trusted pre-dispatch checks can request a fresh model projection. */
class RuntimeCapabilityDriftError extends RuntimeStageError {
  constructor(code: string, message: string, readonly projection: RuntimeCapabilityProjection) {
    super('model_protocol', code, message, true)
  }
}

class RuntimePlanReceiptScopeError extends Error {
  constructor(readonly nodeId: string, readonly rejected: readonly { ref: string; owners: readonly string[] }[]) {
    super('RUNTIME_PLAN_ACTION_UNBOUND')
  }
}

function receiptCompletionTaskIds(receipt: Record<string, unknown>): string[] {
  const ids = receipt.completionPlanTaskIds ?? receipt.activePlanTaskIds
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
}

const MAX_CAPABILITY_RECOVERIES = 3

const INITIAL_TEMPLATE = ''
type RecordedOrganizationAttempt = ContextOrganizationTrainingAttempt & { requestEvidence: ContextOrganizationRequestEvidence }
const CACHE_SUMMARY_MESSAGE_NAME = 'capybara_cache_summary'
const OUTPUT_REPAIR_MESSAGE_NAME = 'capybara_output_repair'
const CONTROL_CARRIER: LlmToolDefinition = {
  name: 'submit_capybara_control',
  description: 'Submit one ControlEnvelopeV2 using the current output_schema and binding. This is only the transport for a control decision.',
  parameters: { type: 'object', required: ['envelope'], additionalProperties: false, properties: { envelope: { type: 'object' } } },
}
const CACHE_SUMMARY_PREFIX = 'Earlier runtime cache summary:\n'
const PRINTED_TOOL_CALLS = /^<[|｜]{2}DSML[|｜]{2}\s+calls>/u
const SYSTEM_CONTEXT_COMPRESSION_HOOK_ID = 'context-compression'
const DEFAULT_CONTEXT_ORGANIZATION_CHUNK_CHARACTERS = 4000
// Organizer output is a compact, schema-bound proposal. Reserving the main
// actor's full output budget here needlessly blocks later model calls.
const DEFAULT_CONTEXT_ORGANIZATION_OUTPUT_TOKENS = 2048
// A project may expose a large provider output ceiling (AppWorld uses 64K),
// while most runtime phases only need a bounded control or tool decision. The
// reservation is charged before the provider call, so keeping the ceiling for
// every phase can exhaust the run budget before the final verification turn.
const STAGE_OUTPUT_BUDGETS: Readonly<Record<RuntimeExecutionState['phase'], number>> = {
  direct: 12_288,
  planning: 8_192,
  human_input: 4_096,
  investigation: 12_288,
  execution: 12_288,
  verification: 6_144,
  delegation: 8_192,
  delegation_wait: 4_096,
  delegation_review: 4_096,
  evidence: 4_096,
  blocked: 4_096,
}

function compactToolSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactToolSchema)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'description')
    .map(([key, item]) => [key, compactToolSchema(item)]))
}

const PARENT_CHILD_LIFECYCLE_TOOLS = new Set(['get_child_task', 'read_child_result', 'consume_child_result', 'cancel_child_task', 'respond_child_task', 'take_over_child_task'])
const CHILD_READABLE_RESOURCE_TOOLS = new Set([
  'create_wait_deadline', 'read_wait_signal', 'request_planning', 'browser_read',
  'submit_branch_evidence',
  'read_runtime_artifact', 'recall_context', 'search_resources', 'read_system_variables',
  'search_skill_marketplace', 'preview_skill_marketplace', 'read_skill_resource',
])
const TAKEOVER_CONTROL_TOOLS = new Set([
  'take_over_child_task', 'delegate_task', 'get_child_task', 'read_child_result', 'consume_child_result', 'cancel_child_task', 'respond_child_task', 'verify_mcp_side_effect',
  'create_wait_deadline', 'read_wait_signal', 'request_planning', 'submit_branch_evidence', 'load_resources',
])

function completionActionKeys(value: { toolName?: string; callId?: string; stepId: string; argumentHash?: string }): string[] {
  return [`step:${value.stepId}`, ...(value.callId ? [`call:${value.callId}`] : []),
    ...(value.toolName ? [value.toolName, `tool:${value.toolName}`, ...(value.argumentHash ? [`tool:${value.toolName}#${value.argumentHash}`] : [])] : [])]
}

const INITIAL_VARIABLES: RuntimeVariables = {
  builtin: {
    project_path: '',
    workspace_path: '',
    config_file: '.capybara/config.json',
    main_template: 'main.j2',
    initialized_at: '',
    system_variables_revision: '',
    prompts: {},
    variables: {},
    shared_prompts: [],
    missing_prompts: [],
    sys_message: [],
    cache: emptyRuntimeCache(),
  },
  task: { title: '' },
  agent: { name: 'capybara' },
  context: { files: [], history_summary: '', evidence_refs: [], evidence_digest: '' },
  user_message: '',
  tools: [],
  harnesses: [],
  skills: { catalog: [], active: [] },
}

const STEP_BLUEPRINT: Array<{
  id: string
  type: TimelineStepType
  summary: string
}> = [
  { id: 'context', type: 'context', summary: '装载变量与上下文文件' },
  { id: 'render', type: 'render', summary: '在服务端渲染提示模板' },
  { id: 'model', type: 'model', summary: '调用模型并解析原生工具请求' },
  { id: 'output', type: 'output', summary: '提交最终输出' },
]

function now(): string {
  return new Date().toISOString()
}

function assertNoReservedToolNames(tools: readonly ToolDefinition[]): void {
  const reserved = new Set(INTERNAL_RESOURCE_TOOLS.map((tool) => tool.name))
  const conflict = tools.find((tool) => reserved.has(tool.name))
  if (conflict) throw new Error(`project tool name is reserved by the runtime: ${conflict.name}`)
}

function variablesEditable(run: RunState): boolean {
  return [
    'idle',
    'ready',
    'paused',
    'interrupted',
    'completed',
    'failed',
    'cancelled',
  ].includes(run.status)
}

export class RuntimeLoop extends Loop {
  private readonly streamDelayMs: number
  private readonly stepDelayMs: number
  private readonly projectDir: string
  private readonly workspaceDir: string
  private readonly systemDir: string
  private readonly projectArtifactIndex: ProjectArtifactIndex
  private readonly contextBuilder: ContextBuilder
  private contextDocumentEngine: ContextDocumentEngine
  private projectContextDocumentEngine: ContextDocumentEngine
  private readonly projectContextStore: ProjectContextStore
  private contextScopesState: RuntimeContextScopesState
  private readonly contextTrainingRecorder = new ContextTrainingRecorder()
  private readonly runtimeActivityState = new RuntimeActivityState()
  private contextHistory = new ContextHistory()
  private historySessionId?: string
  private readonly contextOrganization: NonNullable<RuntimeLoopOptions['contextOrganization']>
  private readonly contextAssistant: NonNullable<RuntimeLoopOptions['contextAssistant']>
  private auxiliaryRunner?: RuntimeAuxiliaryRunner
  private idleDreamController?: AbortController
  private reflectionRecordId?: string
  private reflectionFailure?: RuntimeLoopState['reflectionFailure']
  private lastOrganizationAttemptSequence = -1
  private taskControl = emptyTaskControl('', '')
  private readonly requireInitialPlanning: boolean
  private v2ControlState: RuntimeV2ControlState = {
    status: 'idle',
    evidenceRequests: [],
    uncertainties: [],
    reflectionAttempts: 0,
  }
  private readonly environment: nunjucks.Environment
  private readonly projectResources: ProjectResources
  private readonly toolRegistry: ToolRegistry
  private readonly skillRegistry: SkillRegistry
  private readonly skillMarketplace: RuntimeSkillMarketplace
  private readonly applicationHost?: RuntimeLoopOptions['applicationHost']
  private readonly browserHost?: RuntimeLoopOptions['browserHost']
  private readonly openExternalMcpUrl?: RuntimeLoopOptions['openExternalMcpUrl']
  private readonly openingMcpUrls = new Set<string>()
  private readonly browserGateway?: BrowserGatewayService
  private readonly browserContexts = new Map<string, {
    profile: BrowserProfile
    session: BrowserSession
    tab: Tab
    browserInstanceId: string
    allowedOrigins: string[]
    nextSequence: number
  }>()
  private readonly childAgentHost?: RuntimeLoopOptions['childAgentHost']
  private readonly childAgentEnabled: boolean
  private readonly childExecution?: RuntimeLoopOptions['childExecution']
  private childService?: RuntimeChildService
  private readonly childRecords = new Map<string, ChildRecord>()
  private readonly childAgentMode: boolean
  private readonly childReadOnly: boolean
  private readonly projectContextReadOnly: boolean
  private readonly hookRegistry: HookRegistry
  private llm: RuntimeLlm
  private readonly projectLlmEnabled: boolean
  private projectLlmConfigFingerprint?: string
  private toolDispatcher: ToolDispatcher
  private skillScriptRunner: SkillScriptRunner
  private maxMessages: number
  private maxToolRounds: number
  private contextWindowTokens: number
  private maxInputTokens: number
  private reservedOutputTokens: number
  private readonly modelBudgetOptions?: RuntimeLoopOptions['modelBudget']
  private modelBudgetLimits: ModelBudgetLimits
  private modelMeter?: RuntimeModelMeter
  private harnessPolicy: ReturnType<ProjectResources['readSettings']>['harness_policy']
  private systemVariables: SystemVariablesResource
  private systemPromptDependencies: Record<string, string[]> = {}
  private runCounter = 0
  private assistantCounter = 0
  private assistantChunkIndex = 0
  private generation = 0
  private closed = false
  private responseGeneration = 0
  private activeTask?: Promise<void>
  private resumeWaiters: Array<() => void> = []
  private waitStore?: RuntimeWaitStore
  private waitTimer?: ReturnType<typeof setTimeout>
  private mcpWaitProbe?: AbortController
  private mcpWaitPoll?: { waitId: string; nextAt: number }
  private waits: RuntimeWaitsState = { deadlines: [], subscriptions: [] }
  private preparedWaits: PreparedWait[] = []
  private activeAssistantId?: string
  private activeAbortController?: AbortController
  private readonly activeChildLoops = new Set<RuntimeLoop>()
  private saveCorrelationId?: string
  private snapshotRevision = 1
  private conversationRevision = 1
  private timelineRevision = 1
  private harnessRevision = 1
  private skillRevision = 1
  private skillConfirmationRevision = 0
  private pluginRevision = 1
  private artifactRevision = 0
  private contextRevision = 0
  private effectiveContextRevision = 0
  private observationRevision = 0
  private checkpointRevision = 0
  private breakpointRevision = 0
  private workflowRevision = 0
  private readonly clientMessageIds = new Set<string>()
  private sessionId?: string
  private readonly artifacts = new Map<string, StoredRuntimeArtifact>()
  private readonly artifactItems: RuntimeArtifactMeta[] = []
  private readonly contextItems: RuntimeContextRevision[] = []
  private effectiveContextItems: RuntimeEffectiveContextRevision[] = []
  private observations: RuntimeObservation[] = []
  private readonly breakpointItems: RuntimeBreakpoint[] = []
  private checkpoints: RuntimeCheckpoint[] = []
  private activeContextRevisionId?: string
  private pendingContextRevisionId?: string
  private bypassBreakpointStepId?: string
  private pauseCorrelationId?: string
  private readonly messages: ChatMessage[] = []
  private llmMessages: LlmMessage[] = []
  private pendingToolCalls = new Map<string, ToolCallRequest>()
  private pendingWorkflowCalls = new Map<string, ToolCallRequest>()
  /**
   * Deterministic guard for model loops that repeat an identical failed action.
   * A changed action or a successful retry clears its own entry; the guard is
   * reset for every run so a new user request gets a fresh budget.
   */
  private readonly repeatedToolFailures = new Map<string, {
    count: number
    code: string
  }>()
  private workflowDefinitions = new Map<string, GeneratedWorkflowDefinition>()
  private workflowData = new Map<string, WorkflowExecutionData>()
  private toolRound = 0
  private continuationRound = 0
  private runUsage: LlmUsage = {}
  private variables = { revision: 1, value: clone(INITIAL_VARIABLES) }
  private loopIteration = 0
  private loopVariableBaseline = clone(INITIAL_VARIABLES)
  private template: TemplateState = {
    id: 'context-prompt',
    language: 'jinja2+markdown',
    source: INITIAL_TEMPLATE,
    revision: 1,
    updatedAt: now(),
  }
  private renderResult: RenderResultState
  private toolCatalog: ToolDefinition[] = []
  private readonly mcp: McpClientManager
  private readonly mcpActiveToolIds = new Set<string>()
  private harnessCatalog: HarnessCatalogEntry[] = []
  private skillCatalog: SkillCatalogDefinition[] = []
  private readonly browserReadHistory = new Map<string, {
    status: 'succeeded' | 'failed' | 'unknown'
    output?: JsonObject
    message?: string
  }>()
  private tools: { revision: number; items: ToolDefinition[]; catalog: ToolDefinition[] } = {
    revision: 1,
    items: [],
    catalog: [],
  }
  /**
   * The first real desktop request gets the system workspace capability set.
   * Resource catalogs remain searchable and additional resources stay
   * on-demand, but a work session must be able to inspect and produce files
   * without relying on a model-specific discovery call succeeding first.
   */
  private baselineWorkspaceResourcesActivated = false
  private harnesses = {
    revision: this.harnessRevision,
    items: [] as HarnessDefinition[],
    catalog: [] as HarnessCatalogDefinition[],
  }
  private skills: RuntimeSkillsState = { revision: 1, items: [], catalog: [] }
  private plugins: RuntimePluginsState = { revision: this.pluginRevision, items: [] }
  private skillConfirmations: RuntimeSkillConfirmationsState = { revision: 0, items: [] }
  private workflows: RuntimeWorkflowsState = { revision: 0, items: [] }
  private timeline: TimelineStep[] = this.createTimeline()
  private run: RunState = {
    runId: null,
    mode: 'continuous',
    status: 'idle',
    currentStep: 0,
    variablesEditable: false,
    updatedAt: now(),
  }
  private runtimeStatus: RuntimeStatusState = {
    revision: 1,
    runtime: 'healthy',
    model: 'ready',
    context: {
      usedTokens: 3260,
      maxTokens: 16_000,
      utilization: 0.204,
      cacheTokens: 0,
      contextWindowTokens: 16_000,
      cacheUtilization: 0,
    },
    loopStatus: 'idle',
    queueDepth: 0,
    messageCount: 0,
    variableTokens: [],
    updatedAt: now(),
  }
  constructor(options: RuntimeLoopOptions = {}) {
    super()
    this.contextAssistant = options.contextAssistant ?? {}
    this.streamDelayMs = options.streamDelayMs ?? 45
    this.stepDelayMs = options.stepDelayMs ?? 80
    this.projectDir = path.resolve(
      options.projectDir ?? process.env.CAPYBARA_PROJECT_DIR ?? 'test-project',
    )
    this.workspaceDir = path.resolve(options.workspaceDir ?? this.projectDir)
    this.systemDir = path.resolve(options.systemDir ?? path.join(os.homedir(), '.capybara'))
    this.projectArtifactIndex = new ProjectArtifactIndex(this.projectDir)
    if (!fs.statSync(this.projectDir).isDirectory()) {
      throw new Error(`project is not a directory: ${this.projectDir}`)
    }
    if (!fs.statSync(this.workspaceDir).isDirectory()) {
      throw new Error(`workspace is not a directory: ${this.workspaceDir}`)
    }
    installSystemProjectResources(this.projectDir, this.systemDir)
    this.projectResources = new ProjectResources(this.projectDir, true)
    const config = this.projectResources.readSettings()
    this.mcp = new McpClientManager(this.projectDir, () => {
      if (this.closed) return
      this.snapshotRevision++
      this.emit('runtime.mcp.updated', this.mcpSnapshot())
    }, {
      loadUnknown: () => this.projectContextStore.commits.loadUnknownMcpOperations(this.sessionId ?? this.contextDocumentEngine.snapshot().sessionId),
      reserve: (signature, source, binding) => this.projectContextStore.commits.reserveMcpOperation(this.sessionId ?? this.contextDocumentEngine.snapshot().sessionId, signature, source, binding),
      settle: (source, output) => this.projectContextStore.commits.settleMcpOperation(this.sessionId ?? this.contextDocumentEngine.snapshot().sessionId, source, output),
      read: operationId => this.projectContextStore.commits.readMcpOperation(this.sessionId ?? this.contextDocumentEngine.snapshot().sessionId, operationId),
      priorCall: (taskId, runId, callId) => this.projectContextStore.commits.mcpOperationForCall(this.sessionId ?? this.contextDocumentEngine.snapshot().sessionId, taskId, runId, callId),
    }, config.mcp_servers, !!options.openExternalMcpUrl && !options.childAgentMode)
    const pluginRegistry = new PluginRegistry(this.projectDir, this.systemDir)
    const systemVariablesState = pluginRegistry.effectiveSystemVariablesState()
    for (const [key, value] of Object.entries(options.initialVariableOverrides ?? {})) {
      const variable = systemVariablesState.resource.variables.find(item => item.key === key)
      if (!variable) throw new Error(`system variable was not found: ${key}`)
      if (variable.readonly) throw new Error(`system variable is read-only: ${key}`)
      if (typeof variable.value !== 'string') throw new Error(`experiment override requires a string variable: ${key}`)
      variable.value = value
    }
    this.systemVariables = systemVariablesState.resource
    this.maxMessages = config.max_messages
    this.childExecution = options.childExecution
    this.maxToolRounds = options.childExecution ? Math.min(config.max_tool_rounds === -1 ? Infinity : config.max_tool_rounds, options.childExecution.maxToolRounds) : config.max_tool_rounds
    this.contextWindowTokens = config.context.context_window_tokens
    this.maxInputTokens = config.context.max_input_tokens
    this.reservedOutputTokens = config.context.reserved_output_tokens
    this.modelBudgetOptions = options.modelBudget
    this.modelBudgetLimits = this.resolveModelBudgetLimits(config.context)
    this.runtimeStatus.context = {
      usedTokens: 0,
      maxTokens: this.availableInputTokens(),
      utilization: 0,
      cacheTokens: 0,
      contextWindowTokens: this.contextWindowTokens,
      cacheUtilization: 0,
    }
    this.harnessPolicy = clone(config.harness_policy)
    const systemResourceDir = this.systemDir
    this.toolRegistry = new ToolRegistry(this.projectDir, systemResourceDir)
    this.toolRegistry.load(config.tools)
    this.skillRegistry = new SkillRegistry(this.projectDir, systemResourceDir)
    this.skillRegistry.load(config.skills)
    this.skillMarketplace = options.skillMarketplace ?? new SkillMarketplaceService(this.projectDir)
    this.applicationHost = options.applicationHost
    this.browserHost = options.browserHost
    this.openExternalMcpUrl = options.openExternalMcpUrl
    if (this.browserHost) {
      this.browserGateway = new BrowserGatewayService({
        capability: new BrowserCapability(),
        executor: (input) => this.executeBrowserGatewayHost(input),
      })
    }
    this.childAgentHost = options.childAgentHost
    this.childAgentEnabled = options.childAgentEnabled === true
    this.childAgentMode = options.childAgentMode === true
    this.childReadOnly = this.childAgentMode && (options.childExecution?.executionMode ?? 'readonly') === 'readonly'
    this.projectContextReadOnly = options.projectContextReadOnly === true
    this.requireInitialPlanning = options.planningRequired === true
    this.hookRegistry = new HookRegistry(this.projectDir, this.systemDir)
    this.toolDispatcher = new ToolDispatcher(this.toolRegistry, this.workspaceDir, {
      timeoutMs: config.tool_timeout_ms,
      networkRetry: config.tool_network_retry,
      permissions: config.tool_permissions,
    })
    this.skillScriptRunner = new SkillScriptRunner(this.workspaceDir, config.tool_timeout_ms)
    this.contextOrganization = { enabled: true, minGroups: 8, chunkCharacters: DEFAULT_CONTEXT_ORGANIZATION_CHUNK_CHARACTERS,
      maxOutputTokens: DEFAULT_CONTEXT_ORGANIZATION_OUTPUT_TOKENS, ...options.contextOrganization }
    this.projectLlmEnabled = options.llm === undefined
    this.llm = options.llm ?? createProjectLlmService(config.llm)
    if (this.projectLlmEnabled) {
      this.projectLlmConfigFingerprint = this.llmConfigFingerprint(config)
    }
    this.toolCatalog = this.toolRegistry.list().map((tool) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as JsonObject,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema as JsonObject } : {}),
      permissions: [...tool.permissions],
      sideEffects: tool.sideEffects ?? 'none',
      replay: tool.replay ?? 'safe',
      definitionRevision: 1,
      enabled: true,
    }))
    assertNoReservedToolNames(this.toolCatalog)
    this.tools = {
      revision: 1,
      items: [],
      catalog: clone(this.toolCatalog),
    }
    this.harnessCatalog = loadRuntimeHarnessCatalog(
      this.projectDir,
      pluginRegistry.effectiveHarnesses(config),
    )
    this.plugins = this.runtimePluginsState(this.pluginRevision)
    this.harnesses.catalog = this.harnessCatalogDefinitions()
    this.skillCatalog = this.skillCatalogDefinitions()
    this.skills.catalog = clone(this.skillCatalog)
    this.variables.value.skills = this.skillVariableValue()
    this.variables.value.builtin = {
      project_path: this.projectDir,
      workspace_path: this.workspaceDir,
      config_file: this.projectResources.configFile,
      main_template: config.main_template,
      initialized_at: now(),
      system_variables_revision: systemVariablesState.revision,
      ...this.systemPromptState(this.systemVariables),
      sys_message: [],
      cache: emptyRuntimeCache(),
    }
    this.runtimeStatus = {
      ...this.runtimeStatus,
      ...this.runtimeStatusMetrics(),
      context: this.runtimeStatusContext(this.runtimeStatus.context),
    }
    this.contextBuilder = new ContextBuilder({
      projectDir: this.projectDir,
      mainFile: this.variables.value.builtin.main_template,
      properties: this.variables.value,
    })
    this.sessionId = options.sessionId
    this.contextDocumentEngine = ContextDocumentEngine.create({
      sessionId: this.sessionId ?? 'runtime',
      projectId: this.projectDir,
      constitutionRevision: V2_CONSTITUTION_REVISION,
    })
    this.projectContextStore = new ProjectContextStore(
      this.projectDir,
      this.projectDir,
      V2_CONSTITUTION_REVISION,
    )
    this.projectContextDocumentEngine = options.initialProjectContext
      ? new ContextDocumentEngine(
        options.initialProjectContext.document,
        options.initialProjectContext.receipts,
        options.initialProjectContext.projections,
        options.initialProjectContext.reviewReceipts,
        options.initialProjectContext.evidenceReviewReceipts,
      )
      : this.projectContextStore.load(options.initialState?.projectContextDocument ? {
        document: options.initialState.projectContextDocument, receipts: options.initialState.projectContextDocumentReceipts ?? [],
        projections: options.initialState.projectContextDocumentProjections ?? [], reviewReceipts: options.initialState.projectContextDocumentReviewReceipts ?? [],
        evidenceReviewReceipts: options.initialState.projectContextDocumentEvidenceReviewReceipts ?? [],
      } : undefined)
    this.contextScopesState = createContextScopesState({
      document: this.contextDocumentEngine.snapshot(),
      projectDocumentId: this.projectContextDocumentEngine.snapshot().id,
      projectRevision: this.projectContextDocumentEngine.snapshot().revision,
    })
    this.environment = new nunjucks.Environment(
      new nunjucks.FileSystemLoader([
        this.projectDir,
        path.join(os.homedir(), '.capybara'),
      ], { noCache: true }),
      { autoescape: false, throwOnUndefined: false },
    )
    this.reconcileHarnessBindings('initial', { publish: false })
    this.variables.value.harnesses = this.harnessVariableValue()
    this.contextBuilder.setProperties(this.variables.value, false)
    this.template = {
      ...this.template,
      source: fs.readFileSync(path.join(this.projectDir, this.contextBuilder.mainFile), 'utf8'),
    }
    const content = this.contextBuilder.build().trim()
    this.renderResult = this.contextRenderResult(
      content,
      this.contextBuilder.getMissingVariables(),
    )
    this.syncV2StaticSections(content)
    this.captureContextRevision(
      'initial',
      this.contextBuilder.getIncludedFiles(),
      this.contextBuilder.getMissingVariables(),
    )
    try {
      let initialState = options.initialState
      const waitSession = options.sessionId ?? initialState?.contextDocument?.sessionId
      if (waitSession && waitSession !== 'runtime') {
        this.waitStore = new RuntimeWaitStore(this.projectDir)
        const checkpoint = this.waitStore.recoverCheckpoint(waitSession, initialState?.snapshot.run.runId ?? undefined)
        if (checkpoint && (!initialState || (checkpoint.taskControl?.taskId === initialState.taskControl?.taskId
          && !['completed', 'cancelled', 'failed'].includes(initialState.snapshot.run.status)
          && initialState.snapshot.run.currentStep < checkpoint.snapshot.run.currentStep))) initialState = checkpoint
      }
      if (initialState) this.restoreState(initialState)
      const restoredSession = options.initialState?.contextDocument?.sessionId
      const targetSession = options.sessionId ?? (restoredSession && restoredSession !== 'runtime' ? restoredSession : undefined)
      if (targetSession) {
        this.ensureContextHistorySession(targetSession)
        this.sessionId = targetSession
        this.contextDocumentEngine.setSessionId(targetSession)
        this.restoreAuditedRejections()
        if (!this.childAgentMode && this.run.runId) {
          this.getChildService().recover(this.childBinding())
          this.reconcileChildAssignments()
        }
        if (this.run.runId && this.waitStore) {
          this.waits = this.waitStore.read(this.waitBinding())
          this.recoverBranchBlocks()
          if (this.taskControl.branchBlocks?.length) this.scheduleWaitCheck()
          if (this.v2ControlState.status === 'waiting') {
            try {
              if (!this.v2ControlState.waitId) throw new Error('WAIT_NOT_FOUND')
              this.waitStore.load(this.waitBinding(), this.v2ControlState.waitId)
              this.scheduleWaitCheck()
            } catch (error) {
              if (!(error instanceof Error) || error.message !== 'WAIT_NOT_FOUND') throw error
              // A directory snapshot may contain an intent published before the registration transaction.
              // It cannot manufacture a subscription. A fresh model decision is safe; old actions are not replayed.
              this.v2ControlState = { status: 'idle', evidenceRequests: [], uncertainties: clone(this.v2ControlState.uncertainties), reflectionAttempts: this.v2ControlState.reflectionAttempts }
              this.taskControl.stateRevision += 1
              const step = this.timeline[this.run.currentStep]
              if (!step || step.type !== 'model') throw new Error('WAIT_RECOVERY_CURSOR_INVALID')
              const next = this.timeline[this.run.currentStep + 1]
              if (next?.type === 'model' && next.status === 'pending' && isObject(step.detail?.runtimeEnvelope) && step.detail.runtimeEnvelope.decision === 'wait') {
                this.run = this.withRun({ currentStep: this.run.currentStep + 1 })
              }
              const failure = this.recordFailure(new RuntimeStageError('runtime', 'WAIT_REGISTRATION_NOT_COMMITTED', 'The saved wait intent has no committed subscription; resume to re-evaluate using current state.', true), step, 'restore-wait')
              this.run = this.withRun({ status: 'interrupted', failure })
            }
          }
        }
      }
    } catch (error) { this.close(); throw error }
    this.contextBuilder.onRender((event) => this.handleContextRender(event))
    this.projectResources.onChange((change) => this.handleProjectResourceChange(change))
  }

  override close(): void {
    if (this.closed) return
    this.closed = true
    // Invalidate continuations before aborting or closing the stores they might otherwise use.
    this.generation += 1
    this.responseGeneration += 1
    if (this.waitTimer) clearTimeout(this.waitTimer)
    this.mcpWaitProbe?.abort()
    this.releasePauseWaiters()
    this.abortActiveWork()
    this.childService?.close()
    this.auxiliaryRunner?.close()
    this.modelMeter?.close()
    void this.mcp.close()
    this.contextBuilder.close()
    this.projectResources.close()
    this.projectContextStore.close()
    this.waitStore?.close()
  }

  /** Desktop/service shutdown can await transport and child-process teardown. */
  async shutdown(): Promise<void> { this.close(); await this.mcp.close() }

  getSnapshot(lastSequence: number): RuntimeSnapshot {
    const contextDocument = this.contextDocumentEngine.snapshot()
    const projectContextDocument = this.projectContextDocumentEngine.snapshot()
    this.contextScopesState = createContextScopesState({
      document: contextDocument,
      projectDocumentId: projectContextDocument.id,
      projectRevision: projectContextDocument.revision,
      activeScope: this.contextScopesState.activeScope,
    })
    return clone({
      snapshotRevision: this.snapshotRevision,
      lastSequence,
      run: this.run,
      conversation: {
        revision: this.conversationRevision,
        messages: this.messages,
      },
      template: this.template,
      renderResult: this.renderResult,
      variables: this.variables,
      tools: this.tools,
      mcp: this.mcpSnapshot(),
      ...((this.waits.deadlines.length || this.waits.subscriptions.length) ? { waits: this.waits } : {}),
      harnesses: this.harnesses,
      plugins: this.plugins,
      skills: this.skills,
      skillConfirmations: this.skillConfirmations,
      artifacts: { revision: this.artifactRevision, items: this.artifactItems },
      contexts: {
        revision: this.contextRevision,
        activeId: this.activeContextRevisionId,
        pendingId: this.pendingContextRevisionId,
        items: this.contextItems,
      },
      contextDocument: {
        id: contextDocument.id,
        sessionId: contextDocument.sessionId,
        projectId: contextDocument.projectId,
        revision: contextDocument.revision,
        constitutionRevision: contextDocument.constitutionRevision,
        createdAt: contextDocument.createdAt,
        updatedAt: contextDocument.updatedAt,
      },
      projectContextDocument: {
        id: projectContextDocument.id,
        sessionId: projectContextDocument.sessionId,
        projectId: projectContextDocument.projectId,
        revision: projectContextDocument.revision,
        constitutionRevision: projectContextDocument.constitutionRevision,
        createdAt: projectContextDocument.createdAt,
        updatedAt: projectContextDocument.updatedAt,
      },
      contextDocumentMarkdown: this.contextDocumentEngine.serialize(),
      projectContextDocumentMarkdown: this.projectContextDocumentEngine.serialize(),
      contextDocumentView: {
        scope: 'session',
        meta: {
          id: contextDocument.id,
          sessionId: contextDocument.sessionId,
          projectId: contextDocument.projectId,
          revision: contextDocument.revision,
          constitutionRevision: contextDocument.constitutionRevision,
          createdAt: contextDocument.createdAt,
          updatedAt: contextDocument.updatedAt,
        },
        ...contextDocumentList(contextDocument, '# session_context'),
        tree: contextDocument.tree,
        markdown: this.contextDocumentEngine.serialize(),
        information: contextDocument.information,
        candidates: contextDocument.candidates.map((candidate) => ({
          id: candidate.id,
          actor: candidate.source.actor,
          sourceId: candidate.source.sourceId,
          capturedAt: candidate.source.capturedAt,
          ...(candidate.source.toolName ? { toolName: candidate.source.toolName } : {}),
          ...(candidate.source.runId ? { runId: candidate.source.runId } : {}),
          ...(candidate.source.stepId ? { stepId: candidate.source.stepId } : {}),
          rawArtifactId: candidate.rawArtifactId,
          status: candidate.status,
          evidenceRefs: candidate.evidenceRefs,
          proposedDiffIds: candidate.proposedDiffIds,
          createdAt: candidate.createdAt,
          ...(candidate.reviewedAt ? { reviewedAt: candidate.reviewedAt } : {}),
          ...(candidate.classification ? { classification: candidate.classification } : {}),
        })),
        evidence: contextDocument.evidence,
      },
      projectContextDocumentView: {
        scope: 'project',
        meta: {
          id: projectContextDocument.id,
          sessionId: projectContextDocument.sessionId,
          projectId: projectContextDocument.projectId,
          revision: projectContextDocument.revision,
          constitutionRevision: projectContextDocument.constitutionRevision,
          createdAt: projectContextDocument.createdAt,
          updatedAt: projectContextDocument.updatedAt,
        },
        ...contextDocumentList(projectContextDocument, '# project_context'),
        tree: projectContextDocument.tree,
        markdown: this.projectContextDocumentEngine.serialize(),
        information: projectContextDocument.information,
        candidates: projectContextDocument.candidates.map((candidate) => ({
          id: candidate.id,
          actor: candidate.source.actor,
          sourceId: candidate.source.sourceId,
          capturedAt: candidate.source.capturedAt,
          ...(candidate.source.toolName ? { toolName: candidate.source.toolName } : {}),
          ...(candidate.source.runId ? { runId: candidate.source.runId } : {}),
          ...(candidate.source.stepId ? { stepId: candidate.source.stepId } : {}),
          rawArtifactId: candidate.rawArtifactId,
          status: candidate.status,
          evidenceRefs: candidate.evidenceRefs,
          proposedDiffIds: candidate.proposedDiffIds,
          createdAt: candidate.createdAt,
          ...(candidate.reviewedAt ? { reviewedAt: candidate.reviewedAt } : {}),
          ...(candidate.classification ? { classification: candidate.classification } : {}),
        })),
        evidence: projectContextDocument.evidence,
      },
      contextOrganization: {
        coverage: { ...this.contextHistory.coverageSnapshot(), messageCount: this.contextHistory.size },
        variables: [
          {
            name: 'project_context',
            role: 'document',
            scope: 'project',
            revision: projectContextDocument.revision,
            value: {
              scope: 'project',
              meta: {
                id: projectContextDocument.id,
                sessionId: projectContextDocument.sessionId,
                projectId: projectContextDocument.projectId,
                revision: projectContextDocument.revision,
                constitutionRevision: projectContextDocument.constitutionRevision,
                createdAt: projectContextDocument.createdAt,
                updatedAt: projectContextDocument.updatedAt,
              },
              ...contextDocumentList(projectContextDocument, '# project_context'),
              tree: projectContextDocument.tree,
              information: projectContextDocument.information,
              candidates: projectContextDocument.candidates,
              evidence: projectContextDocument.evidence,
            } as unknown as JsonValue,
          },
          {
            name: 'session_context',
            aliases: ['context'],
            role: 'document',
            scope: 'session',
            revision: contextDocument.revision,
            value: {
              scope: 'session',
              meta: {
                id: contextDocument.id,
                sessionId: contextDocument.sessionId,
                projectId: contextDocument.projectId,
                revision: contextDocument.revision,
                constitutionRevision: contextDocument.constitutionRevision,
                createdAt: contextDocument.createdAt,
                updatedAt: contextDocument.updatedAt,
              },
              ...contextDocumentList(contextDocument, '# session_context'),
              tree: contextDocument.tree,
              information: contextDocument.information,
              candidates: contextDocument.candidates,
              evidence: contextDocument.evidence,
            } as unknown as JsonValue,
          },
          {
            name: 'cache',
            role: 'observation',
            scope: 'runtime',
            value: (this.variables.value.cache ?? null) as JsonValue,
          },
          {
            name: 'messages',
            role: 'signal',
            scope: 'runtime',
            value: this.messages as unknown as JsonValue,
          },
          {
            name: 'system_prompt',
            role: 'signal',
            scope: 'runtime',
            value: (this.renderResult.messages.find((message) => message.role === 'system')?.content ?? '') as JsonValue,
          },
          {
            name: 'runtime_state', role: 'signal', scope: 'runtime', revision: this.taskControl.stateRevision,
            value: toJsonValue({ task: this.taskControl, execution: runtimeExecutionState(this.taskControl), control: this.v2ControlState, waits: this.waits, coverage: this.contextHistory.coverageSnapshot(), mcp: this.mcp.snapshot(), modelBudget: this.getModelBudgetSummary() }),
          },
        ],
        informationUnits: [
          ...projectContextDocument.information.map((entry) => ({
            id: entry.id,
            scope: 'project' as const,
            content: entry.body,
            sourceRefs: entry.sourceCandidateIds,
            evidenceRefs: entry.evidenceRefs,
            status: entry.status,
            ...(entry.classification ? { classification: entry.classification } : {}),
          })),
          ...contextDocument.information.map((entry) => ({
            id: entry.id,
            scope: 'session' as const,
            content: entry.body,
            sourceRefs: entry.sourceCandidateIds,
            evidenceRefs: entry.evidenceRefs,
            status: entry.status,
            ...(entry.classification ? { classification: entry.classification } : {}),
          })),
          ...[...projectContextDocument.candidates, ...contextDocument.candidates].map((candidate) => ({
            id: candidate.id,
            scope: candidate.status === 'stale' || candidate.status === 'irrelevant' ? 'archive' as const : 'candidate' as const,
            content: candidate.normalizedContent,
            sourceRefs: [candidate.rawArtifactId],
            evidenceRefs: candidate.evidenceRefs,
            status: candidate.status,
            ...(candidate.classification ? { classification: candidate.classification } : {}),
          })),
        ],
        archiveRecords: [
          ...projectContextDocument.information.filter((entry) => entry.status === 'archived').map((entry) => ({
            id: entry.id,
            scope: 'project' as const,
            content: entry.body,
            sourceRefs: entry.sourceCandidateIds,
            reason: 'archived information entry',
            recallable: true,
          })),
          ...contextDocument.information.filter((entry) => entry.status === 'archived').map((entry) => ({
            id: entry.id,
            scope: 'session' as const,
            content: entry.body,
            sourceRefs: entry.sourceCandidateIds,
            reason: 'archived information entry',
            recallable: true,
          })),
        ],
        projectRevision: projectContextDocument.revision,
        sessionRevision: contextDocument.revision,
      },
      contextCandidates: contextDocument.candidates.map((candidate) => ({
        id: candidate.id,
        actor: candidate.source.actor,
        sourceId: candidate.source.sourceId,
        capturedAt: candidate.source.capturedAt,
        ...(candidate.source.toolName ? { toolName: candidate.source.toolName } : {}),
        ...(candidate.source.runId ? { runId: candidate.source.runId } : {}),
        ...(candidate.source.stepId ? { stepId: candidate.source.stepId } : {}),
        rawArtifactId: candidate.rawArtifactId,
        status: candidate.status,
        evidenceRefs: candidate.evidenceRefs,
        proposedDiffIds: candidate.proposedDiffIds,
        createdAt: candidate.createdAt,
        ...(candidate.reviewedAt ? { reviewedAt: candidate.reviewedAt } : {}),
        ...(candidate.classification ? { classification: candidate.classification } : {}),
      })),
      contextEvidence: contextDocument.evidence,
      contextReceipts: [
        ...this.contextDocumentEngine.receiptsSnapshot().map((receipt) => ({ ...receipt, scope: 'session' as const })),
        ...this.projectContextDocumentEngine.receiptsSnapshot().map((receipt) => ({ ...receipt, scope: 'project' as const })),
      ],
      contextReviewReceipts: this.contextDocumentEngine.reviewReceiptsSnapshot(),
      contextEvidenceReviews: this.contextDocumentEngine.evidenceReviewReceiptsSnapshot(),
      contextControl: this.v2ControlState,
      taskControl: this.taskControl,
      contextScopes: this.contextScopesState,
      ...(this.browserGateway ? { browserContexts: this.browserContextViews() } : {}),
      ...this.runtimeActivityState.snapshot(),
      effectiveContexts: {
        revision: this.effectiveContextRevision,
        activeId: this.effectiveContextItems.at(-1)?.id,
        items: this.effectiveContextItems,
      },
      observations: {
        revision: this.observationRevision,
        items: this.observations,
      },
      checkpoints: {
        revision: this.checkpointRevision,
        items: this.checkpoints.map((checkpoint) => this.checkpointMeta(checkpoint)),
      },
      breakpoints: { revision: this.breakpointRevision, items: this.breakpointItems },
      workflows: this.workflows,
      timeline: { revision: this.timelineRevision, steps: this.timeline },
      status: this.runtimeStatus,
    })
  }

  private runtimePluginsState(revision: number): RuntimePluginsState {
    const catalog = new ProjectResourceRegistry(this.projectDir, this.systemDir).list()
    return {
      revision,
      items: catalog.plugins.map((plugin) => {
        const moduleIds = new Set(plugin.resourceModuleIds)
        const modules = catalog.items.filter((item) => moduleIds.has(item.id))
        const hooks = modules
          .filter((item) => item.kind === 'hook')
          .flatMap((item) => item.hooks)
        return {
          id: plugin.id,
          name: plugin.name,
          version: plugin.version,
          ownerKind: plugin.ownerKind,
          enabled: plugin.enabled,
          status: !plugin.enabled
            ? 'disabled' as const
            : plugin.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
              ? 'error' as const
              : 'active' as const,
          variableKeys: plugin.variables.map((variable) => variable.key),
          toolDependencies: plugin.toolDependencies.map((dependency) => ({
            package: dependency.package,
            requestedVersion: dependency.version,
            ...(dependency.installedVersion
              ? { installedVersion: dependency.installedVersion }
              : {}),
            status: dependency.status,
          })),
          harnessIds: modules
            .filter((item) => item.kind === 'harness')
            .flatMap((item) => item.harnesses.map((harness) => harness.id)),
          hookIds: hooks.filter((hook) => hook.mode === 'runtime').map((hook) => hook.id),
          trainingHookIds: hooks.filter((hook) => hook.mode === 'training').map((hook) => hook.id),
          diagnostics: plugin.diagnostics.map((diagnostic) => ({ ...diagnostic })),
        }
      }),
    }
  }

  private refreshRuntimePlugins(correlationId: string): boolean {
    const next = this.runtimePluginsState(this.pluginRevision)
    if (JSON.stringify(next.items) === JSON.stringify(this.plugins.items)) return false
    this.pluginRevision += 1
    this.plugins = { revision: this.pluginRevision, items: next.items }
    this.snapshotRevision += 1
    this.emit('runtime.plugins.updated', clone(this.plugins), correlationId)
    return true
  }

  exportState(): RuntimeLoopState {
    const contextDocumentState = this.contextDocumentEngine.exportState()
    const projectContextDocumentState = this.projectContextDocumentEngine.exportState()
    this.recordContextTrainingSample(contextDocumentState)
    return clone({
      contextHistory: this.contextHistory.snapshot(),
      version: 1,
      snapshot: this.getSnapshot(0),
      artifacts: [...this.artifacts.values()],
      llmMessages: this.llmMessages,
      checkpoints: this.checkpoints,
      pendingToolCalls: [...this.pendingToolCalls.entries()],
      pendingWorkflowCalls: [...this.pendingWorkflowCalls.entries()],
      workflowDefinitions: [...this.workflowDefinitions.entries()],
      workflowData: [...this.workflowData.entries()],
      clientMessageIds: [...this.clientMessageIds],
      runCounter: this.runCounter,
      assistantCounter: this.assistantCounter,
      toolRound: this.toolRound,
      continuationRound: this.continuationRound,
      loopIteration: this.loopIteration,
      loopVariableBaseline: this.loopVariableBaseline,
      runUsage: this.runUsage,
      ...(this.reflectionRecordId ? { reflectionRecordId: this.reflectionRecordId } : {}),
      ...(this.reflectionFailure ? { reflectionFailure: this.reflectionFailure } : {}),
      contextDocument: contextDocumentState.document,
      projectContextDocument: projectContextDocumentState.document,
      projectContextDocumentReceipts: projectContextDocumentState.receipts,
      projectContextDocumentReviewReceipts: projectContextDocumentState.reviewReceipts,
      projectContextDocumentEvidenceReviewReceipts: projectContextDocumentState.evidenceReviewReceipts,
      projectContextDocumentProjections: projectContextDocumentState.projections,
      contextDocumentReceipts: contextDocumentState.receipts,
      contextDocumentReviewReceipts: contextDocumentState.reviewReceipts,
      contextDocumentEvidenceReviewReceipts: contextDocumentState.evidenceReviewReceipts,
      contextDocumentProjections: contextDocumentState.projections,
      contextControl: this.v2ControlState,
      taskControl: this.taskControl,
      mcp: { ...this.mcp.exportState(), activeToolIds: [...new Set([...this.mcpActiveToolIds, ...this.tools.items.filter(tool => tool.origin?.type === 'mcp').map(tool => tool.id)])] },
      contextScopes: this.contextScopesState,
      contextTrainingSamples: this.contextTrainingRecorder.snapshot(),
      ...(this.browserGateway ? { browserGateway: this.browserGateway.exportState() } : {}),
      ...(this.browserGateway ? { browserContexts: this.browserContextStates() } : {}),
      ...this.runtimeActivityState.snapshot(),
    })
  }

  getContextTrainingSamples() {
    return this.contextTrainingRecorder.snapshot()
  }

  private contextEngineForScope(scope: RuntimeContextScopeKind = 'session'): ContextDocumentEngine {
    return scope === 'project' ? this.projectContextDocumentEngine : this.contextDocumentEngine
  }

  private browserContextStates(): RuntimeBrowserContextState[] {
    return [...this.browserContexts.entries()].map(([key, context]) => ({
      key,
      profileId: context.profile.id,
      sessionId: context.session.id,
      tabId: context.tab.id,
      browserInstanceId: context.browserInstanceId,
      allowedOrigins: [...context.allowedOrigins],
      nextSequence: context.nextSequence,
    }))
  }

  private browserContextViews() {
    return [...this.browserContexts.values()].map((context) => ({
      browserInstanceId: context.browserInstanceId,
      projectId: context.profile.projectId,
      url: context.tab.url,
      ...(context.tab.title ? { title: context.tab.title } : {}),
      allowedOrigins: [...context.allowedOrigins],
      sessionStatus: context.session.status,
      tabStatus: context.tab.status,
      ...(context.tab.lastActionId ? { lastActionId: context.tab.lastActionId } : {}),
    }))
  }

  private contextDocumentForScope(scope: RuntimeContextScopeKind = 'session') {
    return this.contextEngineForScope(scope).snapshot()
  }

  private projectAnchorAuthenticity(
    classification: ContextClassification | undefined,
    evidenceRefs: readonly string[],
    evidence: ReadonlyArray<{ id?: string; kind: string; referenceId: string }>,
  ): string | undefined {
    const decision = canPromoteToProject(classification, evidenceRefs)
    if (!decision.ok) return decision.errorCode
    for (const anchor of classification?.projectAnchors ?? []) {
      const parts = projectAnchorParts(anchor)
      if (!parts) return 'PROJECT_ANCHOR_INVALID'
      if (['file', 'config', 'prompt', 'tool', 'manifest'].includes(parts.kind)) {
        const root = path.resolve(this.projectDir)
        const target = path.resolve(root, parts.value)
        if (target !== root && !target.startsWith(`${root}${path.sep}`)) return 'PROJECT_ANCHOR_PATH_INVALID'
        if (!fs.existsSync(target)) return 'PROJECT_ANCHOR_NOT_FOUND'
      } else if (parts.kind === 'artifact') {
        if (!evidence.some((item) => item.kind === 'artifact' && (item.id === parts.value || item.referenceId === parts.value))) return 'PROJECT_ANCHOR_ARTIFACT_NOT_FOUND'
      } else if (parts.kind === 'explicit') {
        if (!evidence.some((item) => ['message', 'artifact', 'external'].includes(item.kind))) return 'PROJECT_EXPLICIT_EVIDENCE_REQUIRED'
      }
    }
    return undefined
  }

  private projectObservationGate(observation: RuntimeContextObservation, engine: ContextDocumentEngine): string | undefined {
    if (this.childAgentMode) return 'CHILD_AGENT_PROJECT_CONTEXT_READONLY'
    if (this.projectContextReadOnly) return 'PROJECT_CONTEXT_READONLY'
    const snapshot = engine.snapshot()
    const existing = snapshot.candidates.find((candidate) => (
      candidate.source.actor === observation.candidate.source.actor
      && candidate.source.sourceId === observation.candidate.source.sourceId
    ))
    const evidenceRefs = existing?.evidenceRefs ?? (observation.evidence ? ['observation-evidence'] : [])
    const evidence = snapshot.evidence.filter((item) => evidenceRefs.includes(item.id))
    if (observation.evidence) evidence.push({ id: 'observation-evidence', kind: observation.evidence.kind, referenceId: observation.evidence.referenceId })
    return this.projectAnchorAuthenticity(observation.candidate.classification as ContextClassification | undefined, evidenceRefs, evidence)
  }

  private projectProposalGate(proposal: RuntimeContextDiffProposal, engine: ContextDocumentEngine): string | undefined {
    if (this.childAgentMode) return 'CHILD_AGENT_PROJECT_CONTEXT_READONLY'
    if (this.projectContextReadOnly) return 'PROJECT_CONTEXT_READONLY'
    const snapshot = engine.snapshot()
    const candidate = snapshot.candidates.find((item) => item.id === proposal.candidateId)
    if (!candidate) return 'CANDIDATE_NOT_IN_PROJECT_SCOPE'
    if (candidate.classification && proposal.classification && !sameContextPlacement(candidate.classification, proposal.classification as ContextClassification)) {
      return 'PROJECT_CLASSIFICATION_MISMATCH'
    }
    const classification = candidate.classification ?? proposal.classification as ContextClassification | undefined
    return this.projectAnchorAuthenticity(classification, candidate.evidenceRefs, snapshot.evidence)
  }

  private projectPromotionRejection(proposal: RuntimeContextDiffProposal, engine: ContextDocumentEngine, errorCode: string) {
    return engine.rejectProposal(this.engineProposal(proposal), errorCode)
  }

  private engineProposal(proposal: RuntimeContextDiffProposal): RuntimeContextDiffProposal {
    return proposal.classification
      ? { ...proposal, payload: { ...proposal.payload, classification: proposal.classification } }
      : proposal
  }

  private promoteSessionCandidateToProject(candidateId: string): void {
    if (this.childAgentMode) throw new CommandError('FORBIDDEN', 'CHILD_AGENT_PROJECT_CONTEXT_READONLY')
    if (this.projectContextReadOnly) throw new CommandError('FORBIDDEN', 'PROJECT_CONTEXT_READONLY')
    const sessionSnapshot = this.contextDocumentEngine.snapshot()
    const candidate = sessionSnapshot.candidates.find((item) => item.id === candidateId)
    if (!candidate) throw new CommandError('INVALID_PAYLOAD', 'CANDIDATE_NOT_FOUND_IN_SESSION_SCOPE')
    const authenticity = this.projectAnchorAuthenticity(candidate.classification, candidate.evidenceRefs, sessionSnapshot.evidence)
    if (authenticity) throw new CommandError('INVALID_PAYLOAD', authenticity)
    const projectSnapshot = this.projectContextDocumentEngine.snapshot()
    const existing = projectSnapshot.candidates.find((item) => item.id === candidate.id)
    if (existing) {
      const sameClassification = existing.classification && candidate.classification
        ? sameContextPlacement(existing.classification, candidate.classification)
        : existing.classification === candidate.classification
      if (existing.normalizedContent !== candidate.normalizedContent || !sameClassification) {
        throw new CommandError('INVALID_PAYLOAD', 'PROJECT_CANDIDATE_CONFLICT')
      }
      return
    }
    for (const evidenceRef of candidate.evidenceRefs) {
      const sourceEvidence = sessionSnapshot.evidence.find((item) => item.id === evidenceRef)
      if (!sourceEvidence) throw new CommandError('INVALID_PAYLOAD', 'PROJECT_EVIDENCE_NOT_FOUND')
      const projectEvidence = projectSnapshot.evidence.find((item) => item.id === evidenceRef)
      if (projectEvidence && JSON.stringify(projectEvidence) !== JSON.stringify(sourceEvidence)) {
        throw new CommandError('INVALID_PAYLOAD', 'PROJECT_EVIDENCE_CONFLICT')
      }
      if (!projectEvidence) this.projectContextDocumentEngine.addEvidence(sourceEvidence)
    }
    this.projectContextDocumentEngine.addCandidate({
      id: candidate.id,
      source: candidate.source,
      rawArtifactId: candidate.rawArtifactId,
      normalizedContent: candidate.normalizedContent,
      evidenceRefs: [...candidate.evidenceRefs],
      classification: candidate.classification,
    })
  }

  private rebaseProjectProposal(proposal: RuntimeContextDiffProposal): RuntimeContextDiffProposal {
    return this.rebaseProjectProposals([proposal])[0]!
  }

  private rebaseProjectProposals(proposals: readonly RuntimeContextDiffProposal[]): RuntimeContextDiffProposal[] {
    const document = this.projectContextDocumentEngine.snapshot()
    const references = new Set(proposals.flatMap(({ target, payload }) => [target.nodeId, target.entryId,
      payload.parentNodeId, payload.beforeNodeId, ...payload.childIds ?? []]))
    const projection = this.projectContextDocumentEngine.project({
      id: `promotion-${proposals[0]?.id ?? randomUUID()}`,
      includeStructure: true,
      maxCharacters: 12_000,
      includeTools: false,
      pinnedEntryIds: document.information.filter(entry => references.has(entry.id)).map(entry => entry.id),
      pinnedHeadingIds: document.tree?.headings.filter(heading => references.has(heading.id)).map(heading => heading.id),
      pinnedCandidateIds: [...new Set(proposals.map(proposal => proposal.candidateId))],
      sectionOrder: ['information', 'candidates', 'messages', 'system', 'tools'],
    })
    return proposals.map((proposal) => ({
      ...proposal,
      scope: 'project',
      documentId: document.id,
      baseRevision: projection.documentRevision,
      projectionId: projection.id,
      projectionHash: projection.contentHash,
    }))
  }

  private persistProjectContext(previousRevision: number, outcomes: ContextOutcome[] = []): void {
    if (this.childAgentMode) throw new CommandError('FORBIDDEN', 'CHILD_AGENT_PROJECT_CONTEXT_READONLY')
    if (this.projectContextReadOnly) throw new CommandError('FORBIDDEN', 'PROJECT_CONTEXT_READONLY')
    this.projectContextStore.save(this.projectContextDocumentEngine, previousRevision, this.sessionId, outcomes)
    if (this.projectContextStore.mirrorError) this.createArtifact('runtime-error', 'Context mirror export delayed', { canonicalStore: 'committed', error: this.projectContextStore.mirrorError })
  }

  private refreshCanonicalProjectContext(): void {
    const previous = this.projectContextDocumentEngine.exportState()
    const canonical = this.projectContextStore.load().exportState()
    // Retain actual issued projections only while the complete document is identical.
    if (JSON.stringify(previous.document) === JSON.stringify(canonical.document)) {
      canonical.projections = [...new Map([...canonical.projections, ...previous.projections]).entries()]
    }
    this.projectContextDocumentEngine = new ContextDocumentEngine(canonical.document, canonical.receipts, canonical.projections, canonical.reviewReceipts, canonical.evidenceReviewReceipts)
    this.restoreAuditedRejections()
  }

  private persistSessionContext(previousState: ReturnType<ContextDocumentEngine['exportState']>, outcomes: ContextOutcome[] = []): void {
    if (!this.sessionId) return
    try { this.projectContextStore.commits.saveSession(this.sessionId, this.contextDocumentEngine.exportState(), outcomes) } catch (error) {
      this.contextDocumentEngine = new ContextDocumentEngine(previousState.document, previousState.receipts, previousState.projections, previousState.reviewReceipts, previousState.evidenceReviewReceipts)
      throw error
    }
  }

  private persistPublishedProjections(channel: 'inspection' | 'model' | 'hook', publicationId: string, publications: ContextPublication[]): void {
    if (!this.sessionId) return // Unbound previews never authorize a later session's diff.
    const store = this.projectContextStore.commits
    if (!store.loadDocument(this.sessionId, { observe: false })) this.persistSessionContext(this.contextDocumentEngine.exportState())
    store.publishProjections(this.sessionId, channel, publicationId, publications)
  }

  private restoreAuditedRejections(): void {
    if (!this.sessionId) return
    for (const scope of ['project', 'session'] as const) {
      const current = this.contextEngineForScope(scope).exportState()
      const state = this.projectContextStore.commits.restoreRejectedOutcomes(this.sessionId, scope, current)
      const restored = new ContextDocumentEngine(state.document, state.receipts, state.projections, state.reviewReceipts, state.evidenceReviewReceipts)
      if (scope === 'project') this.projectContextDocumentEngine = restored
      else this.contextDocumentEngine = restored
    }
  }

  private persistContextMutation(scope: RuntimeContextScopeKind, previousState: ReturnType<ContextDocumentEngine['exportState']>): void {
    if (scope === 'session') { this.persistSessionContext(previousState); return }
    try { this.persistProjectContext(previousState.document.revision) } catch (error) {
      this.projectContextDocumentEngine = new ContextDocumentEngine(previousState.document, previousState.receipts, previousState.projections, previousState.reviewReceipts, previousState.evidenceReviewReceipts)
      throw error
    }
  }

  private hookContextSnapshot(): NonNullable<HookFixture['context']> {
    this.syncV2StaticSections(this.renderResult.messages.find((message) => message.role === 'system')?.content ?? '')
    this.syncV2DynamicSections()
    const project = this.projectContextDocumentEngine.project({
      id: 'hook-project-context',
      includeStructure: true,
      maxCharacters: 12_000,
      includeTools: false,
      sectionOrder: ['information', 'candidates', 'messages', 'system', 'tools'],
    })
    const session = this.contextDocumentEngine.project({
      id: 'hook-session-context',
      includeStructure: true,
      maxCharacters: 12_000,
      includeTools: false,
      sectionOrder: ['system', 'messages', 'information', 'candidates', 'tools'],
    })
    this.persistPublishedProjections('hook', `hook-${randomUUID()}`, [
      { scope: 'project', state: this.projectContextDocumentEngine.exportState(), projection: project },
      { scope: 'session', state: this.contextDocumentEngine.exportState(), projection: session },
    ])
    return {
      project: {
        scope: 'project',
        documentId: this.projectContextDocumentEngine.snapshot().id,
        revision: project.documentRevision,
        markdown: project.markdown,
        projectionId: project.id,
        projectionHash: project.contentHash,
      },
      session: {
        scope: 'session',
        documentId: this.contextDocumentEngine.snapshot().id,
        revision: session.documentRevision,
        markdown: session.markdown,
        projectionId: session.id,
        projectionHash: session.contentHash,
      },
    }
  }

  private recordContextTrainingSample(contextDocumentState: ReturnType<ContextDocumentEngine['exportState']>): string {
    const document = contextDocumentState.document
    const projectContextState = this.projectContextDocumentEngine.exportState()
    const sampleId = `context-training:${document.sessionId}:${this.run.runId ?? 'idle'}:${document.revision}`
    if (this.contextTrainingRecorder.get(sampleId)) return sampleId
    const systemPrompt = document.sections.find((section) => section.kind === 'system')?.content ?? ''
    const cache = document.candidates.map((candidate) => ({
      candidateId: candidate.id,
      rawArtifactId: candidate.rawArtifactId,
      normalizedContent: candidate.normalizedContent,
      evidenceRefs: candidate.evidenceRefs,
      capturedAt: candidate.source.capturedAt,
    }))
    const messages = this.llmMessages.map((message) => ({
      role: message.role,
      message: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
    }))
    this.contextTrainingRecorder.captureRuntimeInput({
      sampleId,
      scope: 'session',
      projectId: document.projectId,
      sessionId: document.sessionId,
      ...(this.run.runId ? { runId: this.run.runId } : {}),
      systemPrompt: this.renderResult.messages.find((message) => message.role === 'system')?.content ?? systemPrompt,
      cache,
      rawCache: clone(this.variables.value.builtin.cache),
      messages,
      rawMessages: clone(this.llmMessages),
      runtimeState: {
        contextDocument: contextDocumentState.document,
        contextDocumentReceipts: contextDocumentState.receipts,
        contextDocumentProjections: contextDocumentState.projections,
        contextDocumentReviewReceipts: contextDocumentState.reviewReceipts,
        contextDocumentEvidenceReviewReceipts: contextDocumentState.evidenceReviewReceipts,
        projectContextDocument: projectContextState.document,
        projectContextDocumentReceipts: projectContextState.receipts,
        projectContextDocumentProjections: projectContextState.projections,
        projectContextDocumentReviewReceipts: projectContextState.reviewReceipts,
        projectContextDocumentEvidenceReviewReceipts: projectContextState.evidenceReviewReceipts,
      },
    })
    return sampleId
  }

  private trainingOperationFromProposal(proposal: RuntimeContextDiffProposal): import('#core/context-training-recorder').ContextTrainingOperation {
    const action = proposal.operation === 'add_entry'
      ? 'add'
      : proposal.operation === 'replace_body'
        ? 'replace'
        : proposal.operation === 'append_evidence'
          ? 'append'
          : proposal.operation
    const scope = proposal.scope ?? 'session'
    const candidate = this.contextEngineForScope(scope).snapshot().candidates.find((item) => item.id === proposal.candidateId)
    return {
      scope,
      ...(proposal.classification || candidate?.classification ? { classification: proposal.classification ?? candidate?.classification } : {}),
      action,
      ...(proposal.diffVersion ? { diffVersion: proposal.diffVersion } : {}),
      ...((CONTEXT_TREE_OPERATIONS as readonly string[]).includes(proposal.operation) ? { structure: {
        title: proposal.payload.title, parentNodeId: proposal.payload.parentNodeId, beforeNodeId: proposal.payload.beforeNodeId,
        childIds: proposal.payload.childIds, targetNodeHash: proposal.targetNodeHash,
      } } : {}),
      position: {
        section: proposal.target.section,
        ...(proposal.target.nodeId ?? proposal.target.entryId ? { nodeId: proposal.target.nodeId ?? proposal.target.entryId } : {}),
      },
      ...(proposal.payload.body !== undefined ? { content: proposal.payload.body } : {}),
      reason: `${proposal.scope ?? 'session'}:${proposal.operation}`,
      sourceRefs: [proposal.candidateId],
      evidenceRefs: proposal.payload.evidenceRefs ?? candidate?.evidenceRefs ?? [],
    }
  }

  private recordTrainingProposal(proposals: RuntimeContextDiffProposal[]): string {
    const first = proposals[0]
    if (!first) throw new Error('TRAINING_PROPOSAL_EMPTY')
    const sampleId = this.recordContextTrainingSample(this.contextDocumentEngine.exportState())
    const existing = this.contextTrainingRecorder.get(sampleId)
    if (!existing?.proposal) {
      this.contextTrainingRecorder.recordProposal(sampleId, {
        baseRevision: first.baseRevision,
        operations: proposals.map((proposal) => this.trainingOperationFromProposal(proposal)),
      })
    }
    return sampleId
  }

  private completeTrainingProposal(
    sampleId: string,
    proposals: RuntimeContextDiffProposal[],
    receipts: Array<{ id?: string; result: 'applied' | 'rejected' | 'conflict'; proposalId: string; previousRevision?: number; nextRevision?: number; changedEntryIds?: string[]; changedNodeIds?: string[]; unchanged?: true; errorCode?: string; createdAt?: string }>,
    previousStates: Partial<Record<RuntimeContextScopeKind, ReturnType<ContextDocumentEngine['exportState']>>> = {},
  ): void {
    if (proposals.length !== receipts.length) throw new Error('CONTEXT_TRAINING_RECEIPT_PAIRING_INVALID')
    const acceptedOperations = proposals.filter((_, index) => receipts[index]!.result === 'applied' && !receipts[index]!.unchanged).map(proposal => proposal.id)
    const rejectedOperations = proposals.filter((_, index) => receipts[index]!.result !== 'applied').map(proposal => proposal.id)
    const archiveRecords: ContextTrainingArchiveRecord[] = []
    for (const [index, proposal] of proposals.entries()) {
      if (proposal.operation !== 'mark_status' || proposal.payload.status !== 'archived') continue
      const scope = proposal.scope ?? 'session'
      const previousEntry = previousStates[scope]?.document.information.find((entry) => entry.id === proposal.target.entryId)
      const receipt = receipts[index]
      archiveRecords.push({
        id: `archive-${receipt?.id ?? proposal.id}`,
        scope,
        ...(proposal.target.entryId ? { entryId: proposal.target.entryId } : {}),
        operationId: proposal.id,
        result: receipt?.result ?? 'rejected',
        ...(previousEntry ? { body: previousEntry.body, headingPath: previousEntry.headingPath } : {}),
        evidenceRefs: previousEntry?.evidenceRefs ?? proposal.payload.evidenceRefs ?? [],
        sourceCandidateIds: previousEntry?.sourceCandidateIds ?? [proposal.candidateId],
        reason: `${scope}:archive:${proposal.payload.status}`,
        createdAt: receipt?.createdAt ?? new Date().toISOString(),
      })
    }
    const trainingReceipts: ContextTrainingReceipt[] = receipts.map((receipt, index) => ({
      kind: 'apply',
      id: receipt.id ?? `receipt-${receipt.proposalId}`,
      result: receipt.result,
      subjectId: receipt.proposalId,
      ...(receipt.proposalId !== proposals[index]!.id ? { attemptProposalId: proposals[index]!.id, replayed: true } : {}),
      ...(receipt.previousRevision !== undefined ? { previousRevision: receipt.previousRevision } : {}),
      ...(receipt.nextRevision !== undefined ? { nextRevision: receipt.nextRevision } : {}),
      ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
      ...(receipt.changedEntryIds ? { changedEntryIds: receipt.changedEntryIds } : {}),
      ...(receipt.changedNodeIds ? { changedNodeIds: receipt.changedNodeIds } : {}),
      ...(receipt.unchanged ? { unchanged: true } : {}),
      createdAt: receipt.createdAt ?? new Date().toISOString(),
    }))
    this.contextTrainingRecorder.recordDecision(sampleId, {
      acceptedOperations,
      rejectedOperations,
      archivedNodeIds: proposals
        .filter((proposal, index) => receipts[index]!.result === 'applied' && proposal.operation === 'mark_status' && proposal.payload.status === 'archived')
        .map((proposal) => proposal.target.entryId)
        .filter((id): id is string => Boolean(id)),
      recallLinks: [],
      receipts: trainingReceipts,
      ...(archiveRecords.length > 0 ? { archiveRecords } : {}),
    })
    this.contextTrainingRecorder.complete(sampleId, {
      projectContext: this.projectContextDocumentEngine.serialize(),
      projectContextRevision: this.projectContextDocumentEngine.snapshot().revision,
      context: this.contextDocumentEngine.serialize(),
      contextRevision: this.contextDocumentEngine.snapshot().revision,
      archivedNodeIds: [],
      recallLinks: [],
    })
  }

  getRequestCount(): number {
    return new Set(this.messages.flatMap((message) => message.requestId ? [message.requestId] : [])).size
  }

  appendExternalMessage(input: { role: 'user' | 'assistant'; text: string; id?: string; requestId?: string }): ChatMessage {
    const timestamp = now()
    const message: ChatMessage = {
      id: input.id ?? `external-${randomUUID()}`,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      role: input.role,
      status: 'completed',
      content: [{ type: 'text', text: input.text }],
      createdAt: timestamp,
      completedAt: timestamp,
    }
    this.messages.push(message)
    this.conversationRevision += 1
    this.snapshotRevision += 1
    if (input.role === 'user') this.emit('chat.user.created', clone(message), message.id)
    else this.emit('chat.assistant.completed', { messageId: message.id, finishReason: 'stop', completedAt: timestamp }, message.id)
    this.emit('runtime.snapshot', this.getSnapshot(0), message.id)
    return clone(message)
  }

  private restoreState(state: RuntimeLoopState): void {
    if (state.version !== 1) throw new Error(`unsupported runtime state version: ${state.version}`)
    if (this.sessionId && state.contextDocument?.sessionId && state.contextDocument.sessionId !== 'runtime' && state.contextDocument.sessionId !== this.sessionId) throw new Error('RUNTIME_SESSION_BINDING_MISMATCH')
    const snapshot = clone(state.snapshot)
    const currentBuiltin = clone(this.variables.value.builtin)
    const currentTemplate = clone(this.template)
    const wasActive = [
      'running',
      'waiting',
      'pause_requested',
      'interrupting',
    ].includes(snapshot.run.status)

    this.snapshotRevision = snapshot.snapshotRevision
    this.conversationRevision = snapshot.conversation.revision
    this.timelineRevision = snapshot.timeline.revision
    this.harnessRevision = snapshot.harnesses.revision
    this.skillRevision = snapshot.skills?.revision ?? 1
    this.skillConfirmationRevision = snapshot.skillConfirmations?.revision ?? 0
    this.artifactRevision = snapshot.artifacts.revision
    this.contextRevision = snapshot.contexts.revision
    this.effectiveContextRevision = snapshot.effectiveContexts.revision
    this.observationRevision = snapshot.observations.revision
    this.checkpointRevision = snapshot.checkpoints.revision
    this.breakpointRevision = snapshot.breakpoints.revision
    this.workflowRevision = snapshot.workflows?.revision ?? 0
    this.taskControl = clone(state.taskControl ?? snapshot.taskControl ?? emptyTaskControl(`task-${randomUUID()}`, '恢复的任务'))
    this.mcp.restoreState(state.mcp)
    for (const id of state.mcp?.activeToolIds ?? snapshot.tools.items.filter(tool => tool.origin?.type === 'mcp').map(tool => tool.id)) this.mcpActiveToolIds.add(id)
    this.v2ControlState = clone(state.contextControl ?? snapshot.contextControl ?? {
      status: 'idle', evidenceRequests: [], uncertainties: [], reflectionAttempts: 0,
    })
    this.browserContexts.clear()
    if (this.browserGateway && state.browserGateway) {
      this.browserGateway.restoreState(state.browserGateway)
      for (const saved of state.browserContexts ?? []) {
        const profile = this.browserGateway.capability.getProfile(saved.profileId)
        const session = this.browserGateway.capability.getSession(saved.sessionId)
        const tab = this.browserGateway.capability.getTab(saved.tabId)
        if (!profile || !session || !tab) continue
        this.browserContexts.set(saved.key, {
          profile,
          session,
          tab,
          browserInstanceId: saved.browserInstanceId,
          allowedOrigins: [...saved.allowedOrigins],
          nextSequence: saved.nextSequence,
        })
      }
    }
    this.projectContextDocumentEngine = this.projectContextStore.load()
    this.contextScopesState = state.contextScopes ?? snapshot.contextScopes ?? createContextScopesState({
      document: state.contextDocument ?? this.contextDocumentEngine.snapshot(),
      projectDocumentId: this.projectContextDocumentEngine.snapshot().id,
      projectRevision: this.projectContextDocumentEngine.snapshot().revision,
    })
    this.contextTrainingRecorder.restore(state.contextTrainingSamples ?? [])
    if (state.children && state.processes) this.runtimeActivityState.restore({ children: state.children, processes: state.processes })
    const restoredId = this.sessionId ?? (state.contextDocument?.sessionId !== 'runtime' ? state.contextDocument?.sessionId : undefined)
    const canonical = this.contextOrganization.enabled && restoredId ? this.projectContextStore.commits.loadDocument(restoredId) : undefined
    const restoredV2Document = Boolean(canonical ?? state.contextDocument)
    if (canonical) this.contextDocumentEngine = new ContextDocumentEngine(canonical.document, canonical.receipts, canonical.projections, canonical.reviewReceipts, canonical.evidenceReviewReceipts)
    else if (state.contextDocument) this.contextDocumentEngine = new ContextDocumentEngine(
      state.contextDocument,
      state.contextDocumentReceipts,
      state.contextDocumentProjections,
      state.contextDocumentReviewReceipts,
      state.contextDocumentEvidenceReviewReceipts,
    )
    this.runCounter = state.runCounter
    this.assistantCounter = state.assistantCounter
    this.toolRound = state.toolRound
    this.continuationRound = state.continuationRound
    this.loopIteration = state.loopIteration ?? 0
    this.runUsage = clone(state.runUsage)
    this.reflectionRecordId = state.reflectionRecordId
    this.reflectionFailure = state.reflectionFailure

    this.messages.splice(0, this.messages.length, ...snapshot.conversation.messages.map((message) => (
      message.status === 'streaming'
        ? { ...message, status: 'cancelled' as const, completedAt: now() }
        : message
    )))
    this.clientMessageIds.clear()
    state.clientMessageIds.forEach((id) => this.clientMessageIds.add(id))
    this.llmMessages = discardOrphanToolMessages(clone(state.llmMessages))
    if (state.contextHistory) this.contextHistory = new ContextHistory(state.contextHistory)
    this.pendingToolCalls = new Map(clone(state.pendingToolCalls))
    this.pendingWorkflowCalls = new Map(clone(state.pendingWorkflowCalls ?? []))
    this.workflowDefinitions = new Map(clone(state.workflowDefinitions ?? []))
    this.workflowData = new Map(clone(state.workflowData ?? []))
    this.checkpoints = clone(retainRecentCheckpoints(state.checkpoints))

    this.artifacts.clear()
    for (const artifact of state.artifacts) {
      this.artifacts.set(artifact.meta.id, clone(artifact))
    }
    this.artifactItems.splice(0, this.artifactItems.length, ...clone(snapshot.artifacts.items))
    this.contextItems.splice(0, this.contextItems.length, ...clone(snapshot.contexts.items))
    this.effectiveContextItems = clone(snapshot.effectiveContexts.items)
    this.observations = clone(snapshot.observations.items)
    this.breakpointItems.splice(0, this.breakpointItems.length, ...clone(snapshot.breakpoints.items))

    this.activeContextRevisionId = snapshot.contexts.activeId
    this.pendingContextRevisionId = snapshot.contexts.pendingId
    this.variables = {
      revision: snapshot.variables.revision + 1,
      value: clone(snapshot.variables.value),
    }
    const restoredRuntimeCache = this.variables.value.builtin?.cache
    this.loopVariableBaseline = clone(state.loopVariableBaseline ?? this.variables.value)
    const allowedContextKeys = new Set([
      'files',
      'history_summary',
      'evidence_refs',
      'evidence_digest',
    ])
    const restoredContext = Object.fromEntries(
      Object.entries(this.variables.value.context).filter(([key]) => allowedContextKeys.has(key)),
    ) as Record<string, JsonValue>
    this.variables.value.context = {
      ...restoredContext,
      files: Array.isArray(restoredContext.files)
        ? clone(restoredContext.files) as RuntimeVariables['context']['files']
        : [],
      history_summary: String(this.variables.value.context.history_summary ?? ''),
      evidence_refs: Array.isArray(this.variables.value.context.evidence_refs)
        ? clone(this.variables.value.context.evidence_refs)
        : [],
      evidence_digest: String(this.variables.value.context.evidence_digest ?? ''),
    }
    this.workflows = clone(snapshot.workflows ?? { revision: 0, items: [] })
    this.variables.value.builtin = currentBuiltin
    try {
      assertRuntimeCache(restoredRuntimeCache)
      this.variables.value.builtin.cache = clone(restoredRuntimeCache)
    } catch {
      this.variables.value.builtin.cache = emptyRuntimeCache()
    }
    const restoredCache = this.runtimeCacheValue()
    this.applyRuntimeCache(restoredCache)
    this.variables.value.builtin.cache = restoredCache
    this.variables.value.builtin.sys_message = this.systemMessageValue()
    this.template = {
      ...currentTemplate,
      revision: snapshot.template.revision + (
        currentTemplate.source === snapshot.template.source ? 0 : 1
      ),
    }
    if (snapshot.renderResult) this.renderResult = clone(snapshot.renderResult)
    this.tools = {
      revision: snapshot.tools.revision,
      catalog: clone(this.toolCatalog),
      items: this.toolCatalog.flatMap(tool => {
        const saved = snapshot.tools.items.find(item => item.id === tool.id)
        return saved ? [{ ...tool, ...(saved.attachedBySkill ? { attachedBySkill: true as const } : {}) }] : []
      }),
    }
    this.harnesses = {
      revision: snapshot.harnesses.revision,
      catalog: this.harnessCatalogDefinitions(),
      items: snapshot.harnesses.items
        .filter((item) => this.harnessCatalog.some((entry) => entry.id === item.id))
        .map((item) => ({
          ...clone(item),
          type: item.type ?? 'experience',
          status: item.status ?? 'active',
          bindings: item.bindings?.length ? clone(item.bindings) : [{
            id: `user:restored:${item.id}`,
            source: 'user' as const,
            sourceId: 'restored-session',
            reason: 'Restored session attachment',
          }],
          diagnostics: clone(item.diagnostics ?? []),
        })),
    }
    const restoredToolCount = this.tools.items.length
    const restoredSkillItems = this.revalidateSkillAttachments(snapshot.skills?.items ?? [], 'SKILL_RESTORE_FAILED')
    this.skills = {
      revision: (snapshot.skills?.revision ?? 0) + 1,
      catalog: clone(this.skillCatalog),
      items: restoredSkillItems,
    }
    this.tools.items = this.withRequiredSkillTools(restoredSkillItems, this.tools.items)
    this.skillConfirmations = clone(snapshot.skillConfirmations ?? { revision: 0, items: [] })
    this.skillConfirmations.items = this.skillConfirmations.items.map((item) =>
      item.status === 'executing'
        ? {
            ...item,
            status: 'failed' as const,
            resolvedAt: now(),
            error: 'Skill operation was interrupted while restoring the session.',
          }
        : item)
    this.skillConfirmationRevision = this.skillConfirmations.revision
    if (this.tools.items.length !== restoredToolCount) this.tools.revision += 1
    this.skillRevision = this.skills.revision
    this.reconcileHarnessBindings('restore', { publish: false })
    this.timeline = snapshot.timeline.steps.map((step) => (
      step.status === 'running' ? interruptTimelineStep(step) : step
    ))
    this.run = this.withRun({
      ...snapshot.run,
      ...(wasActive ? { status: 'interrupted' as const } : {}),
      modelRetry: undefined,
    })
    this.runtimeStatus = {
      ...clone(snapshot.status),
      model: 'ready',
      activity: { phase: 'idle', startedAt: now() },
      loopStatus: snapshot.status.loopStatus ?? (
        snapshot.run.status === 'completed'
          ? 'completed'
          : snapshot.run.runId ? 'running' : 'idle'
      ),
      queueDepth: this.pendingToolCalls.size,
      ...this.runtimeStatusMetrics(),
      context: this.runtimeStatusContext(snapshot.status.context),
      updatedAt: now(),
    }
    this.activeAssistantId = undefined

    this.variables.value.tools = this.tools.items.map((tool) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
    }))
    this.variables.value.harnesses = this.harnessVariableValue()
    this.variables.value.skills = this.skillVariableValue()
    this.contextBuilder.setProperties(this.variables.value, false)
    const restoredSystem = this.contextBuilder.build().trim()
    this.renderResult = this.contextRenderResult(
      restoredSystem,
      this.contextBuilder.getMissingVariables(),
    )
    this.captureContextRevision(
      'restore-refresh',
      this.contextBuilder.getIncludedFiles(),
      this.contextBuilder.getMissingVariables(),
    )
    if (!restoredV2Document) this.migrateLegacyContextToV2()
  }

  validate(command: ClientCommand): void {
    switch (command.type) {
      case 'runtime.mcp.input.reply':
        this.validateMcpInputReply(command)
        return
      case 'runtime.wait.signal':
        parseClientCommand(command, command.sessionId)
        if (command.payload.taskId !== this.taskControl.taskId || command.payload.runId !== this.run.runId) throw new CommandError('INVALID_STATE', 'WAIT_SIGNAL_BINDING_MISMATCH')
        return
      case 'runtime.wait.cancel':
        parseClientCommand(command, command.sessionId)
        if ([BRANCH_HUMAN_REPLY, BRANCH_EVIDENCE].includes(this.getWaitStore().load(this.waitBinding(), command.payload.waitId).spec.condition.eventType)) {
          throw new CommandError('INVALID_STATE', 'HUMAN_REQUEST_REQUIRES_BOUND_REPLY')
        }
        return
      case 'runtime.snapshot.get':
      case 'run.mode.set':
        return
      case 'runtime.artifact.get':
        if (!this.artifacts.has(command.payload.artifactId)) {
          throw new CommandError('NOT_FOUND', 'runtime artifact was not found')
        }
        return
      case 'runtime.artifact.page':
        if (!this.artifacts.has(command.payload.artifactId)) {
          throw new CommandError('NOT_FOUND', 'runtime artifact was not found')
        }
        return
      case 'runtime.variable.page':
        this.readVariablePath(command.payload.path)
        return
      case 'runtime.context.apply':
        if (['running', 'waiting', 'pause_requested', 'interrupting'].includes(this.run.status)) {
          throw new CommandError('INVALID_STATE', 'pause before applying a context revision')
        }
        if (!this.contextItems.some((item) => item.id === command.payload.contextRevisionId)) {
          throw new CommandError('NOT_FOUND', 'context revision was not found')
        }
        if (
          command.payload.contextRevisionId !== this.pendingContextRevisionId &&
          command.payload.contextRevisionId !== this.activeContextRevisionId
        ) {
          throw new CommandError(
            'INVALID_STATE',
            'historical contexts are inspectable; restore their checkpoint before execution',
          )
        }
        return
      case 'runtime.context.v2.project':
        if (!command.payload.profileId.trim()) throw new CommandError('INVALID_PAYLOAD', 'projection profileId is required')
        if (!Number.isInteger(command.payload.maxCharacters) || command.payload.maxCharacters < 256 || command.payload.maxCharacters > 10_000_000) {
          throw new CommandError('INVALID_PAYLOAD', 'projection maxCharacters must be between 256 and 10000000')
        }
        return
      case 'runtime.context.v2.apply':
        {
          const scope = command.payload.proposal.scope ?? 'session'
          if (command.payload.proposal.documentId !== this.contextDocumentForScope(scope).id) {
            throw new CommandError('INVALID_PAYLOAD', `proposal document does not belong to ${scope} context`)
          }
        }
        return
      case 'runtime.context.v2.review':
        if (command.payload.review.documentId !== this.contextDocumentEngine.snapshot().id) {
          throw new CommandError('INVALID_PAYLOAD', 'review document does not belong to this session')
        }
        return
      case 'runtime.context.v2.memory.recall':
        try { validateRecallQuery(command.payload) } catch (error) { throw new CommandError('INVALID_PAYLOAD', error instanceof Error ? error.message : String(error)) }
        return
      case 'runtime.context.v2.child.merge':
        if (command.payload.documentId !== this.contextDocumentEngine.snapshot().id) {
          throw new CommandError('INVALID_PAYLOAD', 'child merge document does not belong to this session')
        }
        return
      case 'runtime.context.v2.evidence.review':
        if (command.payload.review.documentId !== this.contextDocumentEngine.snapshot().id) {
          throw new CommandError('INVALID_PAYLOAD', 'evidence review document does not belong to this session')
        }
        return
      case 'runtime.context.v2.dream':
        return
      case 'chat.message.send':
        if (this.clientMessageIds.has(command.payload.clientMessageId)) {
          throw new CommandError('ALREADY_EXISTS', 'clientMessageId already exists')
        }
        if (this.pendingBranchHuman(command.payload.humanRequestId)) return
        if (command.payload.humanRequestId !== undefined && (this.v2ControlState.status !== 'awaiting_user'
          || command.payload.humanRequestId !== this.v2ControlState.humanRequestId)) {
          throw new CommandError('INVALID_STATE', 'HUMAN_REQUEST_MISMATCH: reply does not match the pending human request')
        }
        if (
          command.payload.autoStart &&
          ['running', 'waiting', 'pause_requested', 'paused', 'interrupting'].includes(this.run.status)
          && !(this.run.status === 'paused' && ['awaiting_user', 'awaiting_evidence'].includes(this.v2ControlState.status))
        ) {
          throw new CommandError(
            'RUN_BUSY',
            'send with autoStart=false to append input to the active run',
          )
        }
        return
      case 'chat.response.cancel':
        if (!this.activeAssistantId) {
          throw new CommandError('INVALID_STATE', 'no assistant response is active')
        }
        if (
          command.payload.assistantMessageId &&
          command.payload.assistantMessageId !== this.activeAssistantId
        ) {
          throw new CommandError('NOT_FOUND', 'assistant message was not found')
        }
        return
      case 'run.start':
        this.assertNoPendingWait()
        if (this.run.status === 'running' || this.run.status === 'waiting') {
          throw new CommandError('RUN_BUSY', 'a run is already active')
        }
        return
      case 'run.step':
        this.assertNoPendingWait(true)
        if (this.run.mode !== 'step') {
          throw new CommandError('INVALID_STATE', 'run.step requires step mode')
        }
        if (!this.run.runId || !['paused', 'ready', 'interrupted'].includes(this.run.status)) {
          throw new CommandError('INVALID_STATE', 'the run is not ready for a step')
        }
        if (this.run.currentStep >= this.timeline.length) {
          throw new CommandError('INVALID_STATE', 'the run has no remaining steps')
        }
        return
      case 'run.resume':
        this.assertNoPendingWait(true)
        if (!['paused', 'interrupted'].includes(this.run.status)) {
          throw new CommandError('INVALID_STATE', 'only a paused or interrupted run can resume')
        }
        if (hasUnknownToolOutcome(this.timeline[this.run.currentStep]) && !this.recoverableMcpStep(this.timeline[this.run.currentStep])) {
          throw new CommandError(
            'CONFIRMATION_REQUIRED',
            'the interrupted tool result is unknown; restart the step with side-effect confirmation',
          )
        }
        return
      case 'run.pause':
        if (!['running', 'waiting'].includes(this.run.status)) {
          throw new CommandError('INVALID_STATE', 'only a running run can pause')
        }
        return
      case 'run.interrupt':
        if (!['running', 'waiting', 'pause_requested', 'paused'].includes(this.run.status)) {
          throw new CommandError('INVALID_STATE', 'there is no active run to interrupt')
        }
        return
      case 'run.restartStep':
        this.assertNoPendingWait()
        if (
          !this.run.runId ||
          !['paused', 'interrupted', 'failed', 'completed', 'cancelled'].includes(this.run.status)
        ) {
          throw new CommandError('INVALID_STATE', 'pause or interrupt before restarting a step')
        }
        if (command.payload.stepId && !this.timeline.some((step) => step.id === command.payload.stepId)) {
          throw new CommandError('NOT_FOUND', 'timeline step was not found')
        }
        {
          const step = command.payload.stepId
            ? this.timeline.find((item) => item.id === command.payload.stepId)
            : this.timeline[this.run.currentStep]
          if (this.recoverableMcpStep(step)) throw new CommandError('INVALID_STATE', 'resume the recorded MCP operation without replaying its write')
          if (
            step?.type === 'tool' &&
            step.detail?.replay !== 'safe' &&
            command.payload.confirmSideEffects !== true
          ) {
            throw new CommandError(
              'CONFIRMATION_REQUIRED',
              'restarting this tool may repeat workspace or external side effects',
            )
          }
        }
        return
      case 'run.restorePrevious':
        this.assertNoPendingWait()
        if (['running', 'waiting', 'pause_requested', 'interrupting'].includes(this.run.status)) {
          throw new CommandError('INVALID_STATE', 'pause or interrupt before restoring state')
        }
        if (this.checkpoints.length < 2) {
          throw new CommandError('INVALID_STATE', 'there is no previous checkpoint')
        }
        return
      case 'run.cancel':
        if (!this.run.runId || ['completed', 'cancelled', 'idle'].includes(this.run.status)) {
          throw new CommandError('INVALID_STATE', 'there is no active run to cancel')
        }
        return
      case 'run.restoreCheckpoint':
        this.assertNoPendingWait()
        if (['running', 'waiting', 'pause_requested', 'interrupting'].includes(this.run.status)) {
          throw new CommandError('INVALID_STATE', 'pause or interrupt before restoring state')
        }
        if (!this.checkpoints.some((checkpoint) => checkpoint.id === command.payload.checkpointId)) {
          throw new CommandError('NOT_FOUND', 'checkpoint was not found')
        }
        return
      case 'runtime.breakpoints.upsert':
        return
      case 'runtime.breakpoints.remove':
        if (!this.breakpointItems.some((item) => item.id === command.payload.breakpointId)) {
          throw new CommandError('NOT_FOUND', 'breakpoint was not found')
        }
        return
      case 'variables.apply': {
        const sharedPatch = command.payload.patch.filter((operation) =>
          operation.path.startsWith('/builtin/prompts/'),
        )
        if (sharedPatch.length === 0 && !variablesEditable(this.run)) {
          throw new CommandError('VARIABLES_LOCKED', 'variables are editable only while paused or in step mode')
        }
        this.assertRevision(command.payload.baseRevision, this.variables.revision)
        if (sharedPatch.length > 0) {
          if (sharedPatch.length !== command.payload.patch.length) {
            throw new CommandError('INVALID_PAYLOAD', 'shared variable updates cannot be mixed with session variables')
          }
          this.sharedVariableUpdates(command.payload.patch)
          return
        }
        if (command.payload.patch.some((operation) =>
          ['/tools', '/harnesses', '/skills', '/builtin'].some(
            (root) => operation.path === root || operation.path.startsWith(`${root}/`),
          ),
        )) {
          throw new CommandError(
            'INVALID_PAYLOAD',
            'tools, harnesses, skills, and builtin variables are managed by the runtime',
          )
        }
        const candidate = applyPatch(this.variables.value, command.payload.patch)
        this.assertRuntimeVariables(candidate)
        this.render(this.template.source, candidate)
        return
      }
      case 'template.update':
        this.assertTemplateId(command.payload.templateId)
        this.assertRevision(command.payload.baseRevision, this.template.revision)
        this.render(command.payload.source, this.variables.value)
        return
      case 'template.render':
        this.assertTemplateId(command.payload.templateId)
        return
      case 'runtime.tools.attach':
        this.assertRevision(command.payload.baseRevision, this.tools.revision)
        if (!this.toolCatalog.some((tool) => tool.id === command.payload.toolId)) {
          throw new CommandError('NOT_FOUND', 'tool was not found in the project catalog')
        }
        if (this.tools.items.some((tool) => tool.id === command.payload.toolId && !tool.attachedBySkill)) {
          throw new CommandError('ALREADY_EXISTS', 'tool is already attached')
        }
        return
      case 'runtime.tools.detach':
        this.assertRevision(command.payload.baseRevision, this.tools.revision)
        {
          const tool = this.tools.items.find((item) => item.id === command.payload.toolId)
          if (!tool) {
            throw new CommandError('NOT_FOUND', 'tool is not attached')
          }
          const owner = this.skills.items.find((skill) => skill.status === 'active' &&
            skill.requiredTools.some((name) => name === tool.id || name === tool.name))
          if (owner) {
            throw new CommandError(
              'INVALID_STATE',
              `detach Skill ${owner.name} before removing its required tool ${tool.name}`,
            )
          }
        }
        return
      case 'runtime.harnesses.attach':
        this.assertRevision(command.payload.baseRevision, this.harnesses.revision)
        if (!this.harnessCatalog.some((item) => item.id === command.payload.harnessId)) {
          throw new CommandError('NOT_FOUND', 'harness resource was not found')
        }
        return
      case 'runtime.harnesses.detach':
        this.assertRevision(command.payload.baseRevision, this.harnesses.revision)
        this.assertHarness(command.payload.harnessId)
        return
      case 'runtime.skills.attach':
        this.assertRevision(command.payload.baseRevision, this.skills.revision)
        if (!this.skillRegistry.get(command.payload.skillId)) {
          throw new CommandError('NOT_FOUND', 'skill was not found in the project catalog')
        }
        if (this.skills.items.some((item) => item.id === command.payload.skillId)) {
          throw new CommandError('ALREADY_EXISTS', 'skill is already active')
        }
        return
      case 'runtime.skills.detach':
        this.assertRevision(command.payload.baseRevision, this.skills.revision)
        this.assertSkill(command.payload.skillId)
        return
      case 'runtime.skills.reference.load':
        this.assertRevision(command.payload.baseRevision, this.skills.revision)
        this.assertSkillResource(command.payload.skillId, command.payload.path, 'reference')
        this.assertInternalCapabilityAuthority('read_skill_resource')
        return
      case 'runtime.skills.script.run':
        this.assertRevision(command.payload.baseRevision, this.skills.revision)
        this.assertSkillResource(command.payload.skillId, command.payload.path, 'script')
        this.assertInternalCapabilityAuthority('run_skill_script')
        return
      case 'runtime.skills.confirm':
      case 'runtime.skills.cancelConfirmation':
        {
          const confirmation = this.skillConfirmations.items.find(
            (item) => item.id === command.payload.confirmationId,
          )
          if (!confirmation) {
            throw new CommandError('NOT_FOUND', 'Skill confirmation was not found')
          }
          if (confirmation.status !== 'pending') {
            throw new CommandError('INVALID_STATE', 'Skill confirmation has already been resolved')
          }
        }
        return
    }
  }

  execute(command: ClientCommand, nextSequence: number): void {
    if (command.type === 'runtime.mcp.input.reply') this.validateMcpInputReply(command)
    if (this.sessionId && this.sessionId !== command.sessionId) throw new Error('RUNTIME_SESSION_BINDING_MISMATCH')
    this.ensureContextHistorySession(command.sessionId)
    this.sessionId = command.sessionId
    this.contextDocumentEngine.setSessionId(command.sessionId)
    switch (command.type) {
      case 'runtime.mcp.input.reply':
        this.projectContextStore.commits.mcpInputs.reply(this.waitBinding(), command.payload.requestId, command.payload.responses)
        this.reconcileWorkflowForms(command.id)
        this.emitMcpInputState(command.id)
        this.scheduleWaitCheck()
        return
      case 'runtime.wait.signal':
        parseClientCommand(command, command.sessionId)
        this.publishWaitSignal(command.payload, command.id)
        return
      case 'runtime.wait.cancel':
        parseClientCommand(command, command.sessionId)
        this.getWaitStore().cancel(this.waitBinding(), command.payload.waitId, command.payload.reason)
        this.waits = this.getWaitStore().read(this.waitBinding())
        this.emit('runtime.waits.updated', clone(this.waits), command.id)
        this.scheduleWaitCheck()
        return
      case 'runtime.snapshot.get':
        this.emit('runtime.snapshot', this.getSnapshot(nextSequence), command.id)
        return
      case 'runtime.artifact.get':
        this.publishArtifact(command.payload.artifactId, command.id)
        return
      case 'runtime.artifact.page':
        this.publishArtifactPage(
          command.payload.artifactId,
          command.payload.page,
          command.payload.pageSize,
          command.id,
        )
        return
      case 'runtime.variable.page':
        this.publishVariablePage(
          command.payload.path,
          command.payload.page,
          command.payload.pageSize,
          command.id,
        )
        return
      case 'runtime.context.apply':
        this.applyContextRevision(command.payload.contextRevisionId, command.id)
        return
      case 'runtime.context.v2.observe':
        this.observeV2Candidate(command.payload.observation, command.id)
        return
      case 'runtime.context.v2.project':
        this.publishV2Projection(command.payload.profileId, command.payload.maxCharacters, command.payload.includeTools !== false, command.id, command.payload.candidateSelection, command.payload.scope ?? 'session', command.payload.includeStatuses, command.payload.includeStructure)
        return
      case 'runtime.context.v2.apply':
        this.applyV2Proposal(command.payload.proposal, command.id)
        return
      case 'runtime.context.v2.review':
        this.reviewV2Candidate(command.payload.review, command.id)
        return
      case 'runtime.context.v2.memory.recall':
        if (this.contextAssistantEnabled('recall') && this.sessionId) {
          void this.selectV2Memory(command.payload, command.id).catch(error => this.reportAuxiliaryFailure('recall', command.id, error))
        } else this.recallV2Memory(command.payload, command.id)
        return
      case 'runtime.context.v2.child.merge':
        this.mergeV2Child(command.payload, command.id)
        return
      case 'runtime.context.v2.evidence.review':
        this.reviewV2Evidence(command.payload.review, command.id)
        return
      case 'runtime.context.v2.dream':
        this.publishV2DreamPass(command.id, true)
        return
      case 'chat.message.send':
        this.sendMessage(command)
        return
      case 'chat.response.cancel':
        this.cancelRun(command.id)
        return
      case 'run.mode.set':
        this.run = this.withRun({ mode: command.payload.mode })
        this.emitRun(command.id)
        return
      case 'run.start':
        this.beginRun(command.id)
        return
      case 'run.step':
        this.bypassBreakpointStepId = this.timeline[this.run.currentStep]?.id
        this.assertNoPendingWait()
        this.run = this.withRun({ status: 'running' })
        this.emitRun(command.id)
        this.startOneStep(command.id)
        return
      case 'run.resume':
        this.resume(command.id)
        return
      case 'run.pause':
        this.requestPause(command.id)
        return
      case 'run.interrupt':
        this.interrupt(command.id)
        return
      case 'run.restartStep':
        this.restartStep(command.id, command.payload.stepId)
        return
      case 'run.restorePrevious':
        this.restorePrevious(command.id, command.payload.targetStepId)
        return
      case 'run.restoreCheckpoint':
        this.restoreCheckpointById(command.id, command.payload.checkpointId)
        return
      case 'run.cancel':
        this.cancelRun(command.id)
        return
      case 'runtime.breakpoints.upsert':
        this.upsertBreakpoint(command.payload.breakpoint, command.id)
        return
      case 'runtime.breakpoints.remove':
        this.removeBreakpoint(command.payload.breakpointId, command.id)
        return
      case 'variables.apply':
        if (command.payload.patch.some((operation) => operation.path.startsWith('/builtin/prompts/'))) {
          this.updateSharedVariables(command.payload.patch, command.id)
        } else {
          this.updateVariables(command.payload.patch, 'user', command.id)
        }
        return
      case 'template.update':
        this.saveContextFile(
          this.contextBuilder.mainFile,
          command.payload.source,
          command.id,
        )
        return
      case 'template.render':
        this.renderAndPublish(command.id)
        return
      case 'runtime.tools.attach':
        this.attachTool(command.payload.toolId, command.id)
        return
      case 'runtime.tools.detach':
        this.detachTool(command.payload.toolId, command.id)
        return
      case 'runtime.harnesses.attach':
        this.attachHarness(command.payload.harnessId, command.id)
        return
      case 'runtime.harnesses.detach':
        this.detachHarness(command.payload.harnessId, command.id)
        return
      case 'runtime.skills.attach':
        this.attachSkill(command.payload.skillId, 'user', command.id)
        return
      case 'runtime.skills.detach':
        this.detachSkill(command.payload.skillId, command.id)
        return
      case 'runtime.skills.reference.load':
        this.loadSkillReference(command.payload.skillId, command.payload.path, command.id)
        return
      case 'runtime.skills.script.run':
        void this.runSkillScriptCommand(
          command.payload.skillId,
          command.payload.path,
          command.payload.argv,
          command.id,
        )
        return
      case 'runtime.skills.confirm':
        this.confirmSkillOperation(command.payload.confirmationId, command.id)
        return
      case 'runtime.skills.cancelConfirmation':
        this.cancelSkillConfirmation(command.payload.confirmationId, command.id)
    }
  }

  private emit<TType extends ChannelEvent['type']>(
    type: TType,
    payload: Extract<ChannelEvent, { type: TType }>['payload'],
    correlationId?: string,
  ): void {
    if (!this.closed && this.run.runId && this.sessionId && (type === 'runtime.children.updated' || type === 'runtime.processes.updated')) {
      try { this.recordActivityWaitSignals(type === 'runtime.children.updated' ? 'child' : 'process', payload) }
      catch { /* The ordinary state event remains true; subscription admission reconciles canonical activity again. */ }
    }
    this.publish({
      type,
      payload,
      correlationId,
      runId: this.run.runId ?? undefined,
      turnId: this.run.runId ?? undefined,
      stepId: this.timeline[this.run.currentStep]?.id,
    } as ChannelEvent)
  }

  private withRun(changes: Partial<RunState>): RunState {
    const run = { ...this.run, ...changes, updatedAt: now() }
    return { ...run, variablesEditable: variablesEditable(run) }
  }

  private emitRun(correlationId?: string): void {
    this.snapshotRevision += 1
    this.emit('run.state.changed', clone(this.run), correlationId)
  }

  private waitBinding(): RuntimeRequestBinding {
    if (!this.sessionId || !this.run.runId) throw new CommandError('INVALID_STATE', 'WAIT_REQUIRES_ACTIVE_TASK')
    return { sessionId: this.sessionId, taskId: this.taskControl.taskId, runId: this.run.runId,
      requestId: this.v2ControlState.requestId ?? this.run.runId, stateRevision: this.taskControl.stateRevision }
  }

  private getWaitStore(): RuntimeWaitStore { return this.waitStore ??= new RuntimeWaitStore(this.projectDir) }

  private pendingBranchHuman(id: string | undefined) {
    if (!id || this.preparedWaits.some(wait => wait.id === id) || !this.run.runId || !this.sessionId || !['running', 'pause_requested', 'paused', 'interrupted'].includes(this.run.status)) return undefined
    const block = this.taskControl.branchBlocks?.find(item => item.id === id && (item.kind === 'human' || item.evidenceRequest?.sourceKinds.includes('user')))
    return block && this.getWaitStore().load(this.waitBinding(), block.id).status === 'pending' ? block : undefined
  }

  private recoverBranchBlocks(): void {
    const blocks = this.taskControl.branchBlocks
    if (!blocks?.length) return
    const binding = this.waitBinding()
    const retained = blocks.filter(block => {
      try { this.getWaitStore().load(binding, block.id); return true }
      catch (error) {
        if (!(error instanceof Error) || error.message !== 'WAIT_NOT_FOUND') throw error
        return false
      }
    })
    if (retained.length === blocks.length) return
    this.taskControl.branchBlocks = retained
    if (!retained.length) delete this.taskControl.branchBlocks
    if (hasRunnableBranch(this.taskControl)) delete this.taskControl.branchPaused
    this.taskControl.stateRevision++
  }

  private settleBranchBlocks(correlationId: string): void {
    const blocks = this.taskControl.branchBlocks
    if (!blocks?.length || this.preparedWaits.length) return
    const store = this.getWaitStore()
    const binding = this.waitBinding()
    const remaining = []
    for (const block of blocks) {
      const wait = store.load(binding, block.id)
      if (wait.status === 'pending') { remaining.push(block); continue }
      const signal = wait.status === 'satisfied' && block.kind !== 'wait'
        ? store.readSignal(binding, wait.matchedSignalIds[0]!) : undefined
      if (signal && (block.kind === 'human' || isObject(signal.data) && signal.data.sourceKind === 'user')) {
        const reply = signal.data
        if (!isObject(reply) || typeof reply.messageId !== 'string' || typeof reply.text !== 'string') throw new Error('HUMAN_REPLY_INVALID')
        // If persistence stopped after settling the SQL subscription, recover the exact bound answer.
        if (!this.clientMessageIds.has(reply.messageId)) {
          if (!this.contextHistory.snapshot().messages.some(message => message.id === reply.messageId)) {
            this.appendContextHistory({ role: 'user', content: reply.text }, 'user', undefined, reply.messageId, binding.runId)
          }
          this.clientMessageIds.add(reply.messageId)
          this.llmMessages = this.limitRuntimeMessages([...this.llmMessages, { role: 'user', content: reply.text }])
          this.messages.push({ id: reply.messageId, requestId: binding.runId, role: 'user', status: 'completed',
            content: [{ type: 'text', text: reply.text }], createdAt: signal.receivedAt, completedAt: signal.receivedAt })
          this.conversationRevision++
        }
        if (reply.replan === true) this.taskControl.planning = { required: true, reason: 'human reply requested replanning' }
      }
      if (block.kind === 'evidence' && signal) this.captureBranchEvidence(block, signal, correlationId)
      this.createArtifact('context-diff', `Branch ${wait.status}`, { kind: 'branch-wait-receipt', taskIds: block.taskIds, wait }, correlationId)
      this.taskControl.stateRevision++
    }
    if (remaining.length === blocks.length) return
    if (remaining.length) this.taskControl.branchBlocks = remaining
    else delete this.taskControl.branchBlocks
    const ready = hasRunnableBranch(this.taskControl)
    const resume = this.taskControl.branchPaused && ready && this.run.status === 'paused' && this.v2ControlState.status === 'idle'
    if (ready && (resume || this.run.status !== 'paused')) delete this.taskControl.branchPaused
    this.snapshotRevision++
    this.emit('runtime.waits.updated', clone(this.waits), correlationId)
    this.emit('runtime.snapshot', this.getSnapshot(0), correlationId)
    if (resume) this.resume(correlationId)
  }

  /** Trusted host integrations supply their original task/run; clients can only publish external/user observations. */
  publishWaitSignal(input: Omit<RuntimeWaitSignal, 'sessionId' | 'receivedAt'>, correlationId = input.id): void {
    if (this.closed) throw new Error('RUNTIME_CLOSED')
    const binding = this.waitBinding()
    if (input.taskId !== binding.taskId || input.runId !== binding.runId) throw new CommandError('INVALID_STATE', 'WAIT_SIGNAL_BINDING_MISMATCH')
    const store = this.getWaitStore()
    let result
    if (input.eventType === 'evidence.available' && input.correlationId.startsWith('branch-evidence-')) {
      const data = input.data
      if (input.signalType !== 'external' || !isObject(data) || typeof data.sourceId !== 'string' || !data.sourceId.trim()
        || data.sourceId.length > 512 || typeof data.text !== 'string' || !data.text.trim()
        || !input.id.trim() || input.id.length > 512) throw new Error('BRANCH_EXTERNAL_EVIDENCE_INVALID')
      result = store.supplyEvidence(binding, input.correlationId, 'external', { sourceId: data.sourceId, text: data.text, externalSignalId: input.id })
    } else {
      result = store.recordSignal({ ...input, sessionId: binding.sessionId })
    }
    this.waits = this.getWaitStore().read(binding)
    this.snapshotRevision += 1
    this.emit('runtime.wait.signal.recorded', result, correlationId)
    this.emit('runtime.waits.updated', clone(this.waits), correlationId)
    this.scheduleWaitCheck()
  }

  private captureBranchEvidence(block: RuntimeBranchBlock, signal: RuntimeWaitSignal, correlationId: string): void {
    const data = signal.data
    if (!isObject(data)) throw new Error('BRANCH_EVIDENCE_SIGNAL_INVALID')
    let candidateId = typeof data.candidateId === 'string' ? data.candidateId : undefined
    if (data.sourceKind === 'user' || data.sourceKind === 'external') {
      if (typeof data.text !== 'string' || (data.sourceKind === 'user' && typeof data.messageId !== 'string')) throw new Error('BRANCH_EVIDENCE_SIGNAL_INVALID')
      const user = data.sourceKind === 'user'
      const sourceId = user ? data.messageId as string : signal.id
      const actor = user ? 'user' : 'system'
      const existing = this.contextDocumentEngine.snapshot().candidates.find(item => item.source.actor === actor && item.source.sourceId === sourceId)
      candidateId = existing?.id
      if (!candidateId) {
        const before = this.contextDocumentEngine.exportState()
        const artifact = user ? undefined : this.createArtifact('tool-result', 'External evidence observation', data, correlationId)
        if (artifact) this.projectContextStore.commits.saveArtifactSource(signal.sessionId, artifact, JSON.stringify(data, null, 2))
        const referenceId = artifact?.id ?? sourceId
        const result = this.contextDocumentEngine.observe({
          candidate: { source: { actor, sourceId, capturedAt: signal.receivedAt, runId: signal.runId }, rawArtifactId: referenceId,
            normalizedContent: user ? data.text : `外部来源声明 ${data.sourceId}: ${data.text}` },
          evidence: { kind: artifact ? 'artifact' : 'message', referenceId, sessionId: signal.sessionId,
            sourceHash: artifact?.hash ?? createHash('sha256').update(data.text).digest('hex'), observedAt: signal.receivedAt, confidence: 'low' },
        })
        this.persistSessionContext(before)
        candidateId = result.candidate.id
      }
    }
    this.createArtifact('context-diff', 'Branch evidence received', { kind: 'branch-evidence-receipt', requestId: block.id, taskIds: block.taskIds,
      request: block.evidenceRequest, candidateId, sourceKind: data.sourceKind, signalId: signal.id }, correlationId)
  }

  private assertNoPendingWait(allowReadyBranch = false): void {
    const waits = this.waitStore && this.run.runId && this.sessionId ? this.waitStore.read(this.waitBinding()).subscriptions : []
    const branchCanRun = allowReadyBranch && hasRunnableBranch(this.taskControl)
    if (this.preparedWaits.length || this.v2ControlState.status === 'waiting'
      || waits.some(wait => wait.status === 'pending' && (!wait.spec.blockingTaskIds || !branchCanRun))
      || (allowReadyBranch && this.taskControl.branchPaused && !branchCanRun)) {
      throw new CommandError('INVALID_STATE', 'WAIT_PENDING: wait for a matching signal/deadline or explicitly cancel the subscription')
    }
  }

  private scheduleWaitCheck(delay = 0): void {
    if (this.waitTimer) clearTimeout(this.waitTimer)
    if (this.closed || !this.waitStore || (this.v2ControlState.status !== 'waiting' && !this.taskControl.branchBlocks?.length)) return
    this.waitTimer = setTimeout(() => {
      this.waitTimer = undefined
      if (this.closed) return
      try { this.checkPendingWait() }
      catch (error) {
        if (this.closed) return
        this.createArtifact('runtime-error', 'Wait state could not be processed', { code: 'WAIT_STATE_FAILURE', message: error instanceof Error ? error.message : String(error) }, 'wait-controller')
      }
    }, Math.max(0, Math.min(delay, 2147483647)))
    this.waitTimer.unref()
  }

  private checkPendingWait(): void {
    const id = this.v2ControlState.waitId
    if (this.closed || this.preparedWaits.length || !this.run.runId) return
    this.waits = this.getWaitStore().expire(this.waitBinding())
    if (!['running', 'pause_requested', 'interrupting'].includes(this.run.status)) this.settleBranchBlocks('wait-controller')
    const nextDeadline = this.waits.subscriptions.filter(wait => wait.status === 'pending' && wait.deadlineAt)
      .map(wait => Date.parse(wait.deadlineAt!)).sort((a, b) => a - b)[0]
    if (nextDeadline !== undefined) this.scheduleWaitCheck(Math.max(1, nextDeadline - Date.now()))
    if (!id || this.v2ControlState.status !== 'waiting') return
    const wait = this.getWaitStore().load(this.waitBinding(), id)
    if (wait.status === 'pending') {
      if (wait.spec.condition.eventType === MCP_OPERATION_SETTLED && this.run.status === 'paused') this.scheduleMcpWaitProbe(wait)
      return
    }
    this.mcpWaitProbe?.abort()
    this.mcpWaitPoll = undefined
    // The model cursor must already be committed before a signal may resume it.
    if (this.preparedWaits.length || this.run.status === 'pause_requested' || this.run.status === 'running') { this.scheduleWaitCheck(1); return }
    const requestId = this.v2ControlState.requestId
    this.v2ControlState = { status: 'idle', evidenceRequests: [], uncertainties: clone(this.v2ControlState.uncertainties), reflectionAttempts: this.v2ControlState.reflectionAttempts }
    this.taskControl.stateRevision += 1
    this.snapshotRevision += 1
    this.createArtifact('context-diff', `Wait ${wait.status}`, { kind: 'wait-receipt', wait }, id)
    this.emit('runtime.waits.updated', clone(this.waits), id)
    this.emit('runtime.context.v2.control.cleared', { ...(requestId ? { requestId } : {}) }, id)
    if (wait.runCancelledAt || wait.cancelledBy === 'run') { this.run = this.withRun({ status: 'cancelled' }); this.emitRun(id); return }
    this.resumeAfterControl(id)
  }

  private scheduleMcpWaitProbe(wait: RuntimeWaitSubscription): void {
    if (this.mcpWaitProbe) return
    const operationId = wait.spec.correlationIds[0]!
    const operation = this.projectContextStore.commits.readMcpOperation(wait.binding.sessionId, operationId)
    const interval = operation?.binding?.verification?.poll?.intervalMs
    if (!operation || !interval || operation.verification || operation.source.outcome !== 'unknown') return
    const due = this.mcpWaitPoll?.waitId === wait.id ? this.mcpWaitPoll.nextAt : Date.now()
    const deadline = Date.parse(wait.deadlineAt!)
    if (due >= deadline) return
    if (due > Date.now()) { this.scheduleWaitCheck(due - Date.now()); return }
    const controller = new AbortController()
    this.mcpWaitProbe = controller
    void this.probeMcpWait(wait, operation, controller.signal).catch(error => {
      if (!this.closed && !controller.signal.aborted) diagnosticLog('mcp.wait_probe_unavailable', {
        waitId: wait.id, code: error instanceof RuntimeCapabilityError ? error.code : 'MCP_VERIFICATION_PROBE_FAILED',
      })
    }).finally(() => {
      if (this.mcpWaitProbe === controller) this.mcpWaitProbe = undefined
      if (!this.closed) {
        if (this.v2ControlState.waitId === wait.id) this.mcpWaitPoll = { waitId: wait.id, nextAt: Date.now() + interval }
        this.scheduleWaitCheck()
      }
    })
  }

  private async probeMcpWait(wait: RuntimeWaitSubscription, operation: McpOperation, cancellation: AbortSignal): Promise<void> {
    const settings = this.projectResources.readSettings()
    const server = this.mcp.verificationPollServer(operation, settings.mcp_servers, new Set(settings.tool_permissions))
    const verifier = operation.binding!.verification!
    const capabilityId = `mcp:${operation.source.serverId}:${verifier.toolName}`
    if (!server || (!this.mcpActiveToolIds.has(capabilityId) && !this.tools.items.some(tool => tool.id === capabilityId))) return
    const remaining = Date.parse(wait.deadlineAt!) - Date.now()
    if (remaining <= 0) return
    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(Math.min(remaining, server.timeout_ms))])
    const pending = () => !this.closed && !signal.aborted && this.run.status === 'paused' && this.v2ControlState.waitId === wait.id
      && this.getWaitStore().load(this.waitBinding(), wait.id).status === 'pending' && Date.now() < Date.parse(wait.deadlineAt!)
    if (!this.mcp.verificationTool(operation) || !this.availableToolCapabilities().some(tool => tool.capabilityId === capabilityId && tool.available)) {
      await this.mcp.prepare(settings.mcp_servers, signal, server.id)
      if (!pending()) return
      this.reloadProjectTools(this.projectResources.readSettings(), wait.id)
    }
    if (!pending()) return
    const name = this.mcp.verificationTool(operation)
    if (!name) return
    const binding = { ...this.waitBinding(), requestId: wait.binding.requestId, stateRevision: this.taskControl.stateRevision }
    const projection = projectRuntimeCapabilities(this.taskControl, binding, this.availableToolCapabilities())
    if (!projection.bindings.some(tool => tool.name === name)) return
    await this.verifyMcpSideEffect({ id: `mcp-probe-${randomUUID()}`, name: 'verify_mcp_side_effect', arguments: { operation_id: operation.source.operationId },
      authorization: { projection, admittedStateRevision: binding.stateRevision } }, wait.id, signal, pending)
  }

  private resumeAfterControl(correlationId: string): void {
    if (this.run.status !== 'paused' || this.timeline[this.run.currentStep]?.type !== 'model') return
    if (this.taskControl.branchBlocks?.length && !hasRunnableBranch(this.taskControl)) {
      this.taskControl.branchPaused = true
      return
    }
    this.resume(correlationId)
  }

  private cancelPendingWait(reason: string, correlationId: string): void {
    if (this.waitTimer) clearTimeout(this.waitTimer)
    this.waitTimer = undefined
    this.mcpWaitProbe?.abort()
    this.mcpWaitPoll = undefined
    const uncommitted = new Set(this.preparedWaits.map(wait => wait.id))
    this.preparedWaits = []
    if (this.waitStore && this.run.runId && this.sessionId) {
      const binding = this.waitBinding()
      const rootWaitId = this.v2ControlState.waitId
      const ids = new Set(this.waitStore.read(binding).subscriptions.filter(wait => wait.status === 'pending').map(wait => wait.id))
      if (rootWaitId && !uncommitted.has(rootWaitId)) ids.add(rootWaitId)
      for (const id of ids) this.waitStore.cancel(binding, id, reason, 'run')
      this.waits = this.waitStore.read(this.waitBinding())
      if (ids.size) this.emit('runtime.waits.updated', clone(this.waits), correlationId)
    }
    if (this.taskControl.branchBlocks?.length) {
      delete this.taskControl.branchBlocks
      delete this.taskControl.branchPaused
      this.taskControl.stateRevision += 1
    }
    if (this.v2ControlState.status === 'waiting') {
      this.v2ControlState = { status: 'idle', evidenceRequests: [], uncertainties: clone(this.v2ControlState.uncertainties), reflectionAttempts: this.v2ControlState.reflectionAttempts }
      this.taskControl.stateRevision += 1
    }
  }

  private recordToolWaitSignal(step: TimelineStep): void {
    const receipt = step.detail?.executionReceipt
    if (!isObject(receipt) || typeof receipt.callId !== 'string' || typeof receipt.status !== 'string' || !this.run.runId || !this.sessionId) return
    const binding = this.waitBinding()
    this.getWaitStore().recordSignal({ id: `tool:${binding.runId}:${receipt.callId}:${receipt.status}`, sessionId: binding.sessionId,
      taskId: binding.taskId, runId: binding.runId, signalType: 'tool', eventType: receipt.status === 'succeeded' ? 'tool.completed' : 'tool.failed',
      correlationId: receipt.callId, status: receipt.status,
      data: { resultArtifactId: typeof receipt.resultArtifactId === 'string' ? receipt.resultArtifactId : '', receiptStatus: receipt.status } })
  }

  private recordActivityWaitSignals(kind: 'child' | 'process', value: unknown): void {
    if (!isObject(value) || !Array.isArray(value.items) || !this.run.runId || !this.sessionId) return
    const binding = this.waitBinding()
    for (const item of value.items) {
      if (!isObject(item) || typeof item.id !== 'string' || typeof item.status !== 'string'
        || (kind === 'child' ? item.parentRunId !== binding.runId : item.runId !== binding.runId)) continue
      this.getWaitStore().recordSignal({ id: `runtime:${binding.runId}:${kind}:${item.id}:${item.status}`, sessionId: binding.sessionId, taskId: binding.taskId, runId: binding.runId,
        signalType: 'runtime', eventType: `${kind}.status`, correlationId: item.id, status: item.status })
      if (kind === 'child' && terminalChild(item.status as import('#protocol/runtime-protocol').RuntimeChildStatus)) {
        this.getWaitStore().recordSignal({ id: `runtime:${binding.runId}:child:${item.id}:completed:${item.status}`, sessionId: binding.sessionId, taskId: binding.taskId, runId: binding.runId,
          signalType: 'runtime', eventType: 'child.completed', correlationId: item.id, status: item.status })
      }
      if (kind === 'child' && typeof item.waitRef === 'string' && (terminalChild(item.status as import('#protocol/runtime-protocol').RuntimeChildStatus) || (item.status === 'waiting' && typeof item.inputRequestId === 'string'))) {
        this.getWaitStore().recordSignal({ id: `runtime:${binding.runId}:child:${item.id}:ready:${item.waitRef}:${item.status}`, sessionId: binding.sessionId, taskId: binding.taskId, runId: binding.runId,
          signalType: 'runtime', eventType: 'child.ready', correlationId: item.waitRef, status: item.status })
      }
    }
    this.scheduleWaitCheck()
  }

  private updateModelRetry(
    stepId: string,
    retry: LlmRetryNotification | undefined,
    correlationId: string,
  ): void {
    if (!retry && !this.run.modelRetry) return
    if (retry) {
      this.updateRuntimeStatus({
        activity: { phase: 'model_retry', label: retry.reason, startedAt: now() },
      }, correlationId)
    }
    this.run = this.withRun({
      modelRetry: retry
        ? {
            ...retry,
            stepId,
            updatedAt: now(),
          } satisfies RuntimeModelRetry
        : undefined,
    })
    this.emitRun(correlationId)
  }

  private hookLlmObserver(hookName: string, generation: number, correlationId: string) {
    return (activity: HookLlmActivity) => {
      if (this.generation !== generation) return
      this.updateModelRetry(`${activity.hookId}:${activity.requestId}`, activity.retry, correlationId)
      this.updateRuntimeStatus({ activity: {
        phase: activity.phase === 'retrying' ? 'model_retry'
          : activity.phase === 'waiting' ? 'model_waiting' : 'hook_running',
        label: `Hook ${hookName}`,
        startedAt: now(),
      } }, correlationId)
      this.createArtifact('hook-log', `Hook model ${activity.phase} · ${hookName}`, toJsonValue(activity), correlationId)
    }
  }

  private createTimeline(): TimelineStep[] {
    return STEP_BLUEPRINT.map((step, index) => ({
      ...step,
      id: `step-${step.id}`,
      index,
      status: 'pending' as const,
    }))
  }

  private updateTimeline(step: TimelineStep, correlationId: string): void {
    this.timeline[step.index] = step
    this.timelineRevision += 1
    this.snapshotRevision += 1
    this.emit(
      'timeline.step.upserted',
      { revision: this.timelineRevision, step: clone(step) },
      correlationId,
    )
  }

  private beginRun(correlationId: string, requestId = `request-${randomUUID()}`, planningRequired = false): void {
    this.assertNoPendingWait()
    if (this.childService && this.run.runId && this.sessionId) this.childService.cancelAll(this.childBinding(), 'parent started a new task')
    if (this.mcpInputViews().length) {
      this.projectContextStore.commits.mcpInputs.cancel(this.waitBinding())
      this.emitMcpInputState(correlationId)
    }
    this.waits = { deadlines: [], subscriptions: [] }
    this.reflectionRecordId = undefined
    this.reflectionFailure = undefined
    this.abortActiveWork()
    this.generation += 1
    this.runCounter += 1
    this.taskControl = emptyTaskControl(`task-${randomUUID()}`, String(this.variables.value.user_message ?? ''))
    if (planningRequired || this.requireInitialPlanning) this.taskControl.planning = { required: true, reason: 'host or caller requested an independent planning round' }
    this.v2ControlState = { status: 'idle', evidenceRequests: [], uncertainties: [], reflectionAttempts: 0 }
    this.run = this.withRun({
      runId: requestId,
      status: this.run.mode === 'step' ? 'paused' : 'running',
      currentStep: 0,
      currentStepId: undefined,
      failure: undefined,
      modelRetry: undefined,
    })
    this.timeline = this.createTimeline()
    this.timelineRevision += 1
    this.pendingToolCalls.clear()
    this.pendingWorkflowCalls.clear()
    this.repeatedToolFailures.clear()
    this.workflowDefinitions.clear()
    this.workflowData.clear()
    this.workflowRevision += 1
    this.workflows = { revision: this.workflowRevision, items: [] }
    this.toolRound = 0
    this.continuationRound = 0
    this.runUsage = {}
    this.loopIteration = 0
    const latestContext = this.pendingContextRevisionId ?? this.contextItems.at(-1)?.id
    if (latestContext) this.applyContextRevision(latestContext, correlationId)
    this.resetRunTraceState()
    this.publishRenderedMessages(correlationId)
    this.loopVariableBaseline = clone(this.variables.value)
    this.checkpoints = []
    this.snapshotRevision += 1
    this.emit('run.trace.started', {
      run: clone(this.run),
      timeline: { revision: this.timelineRevision, steps: clone(this.timeline) },
      artifacts: { revision: this.artifactRevision, items: clone(this.artifactItems) },
      contexts: {
        revision: this.contextRevision,
        activeId: this.activeContextRevisionId,
        pendingId: this.pendingContextRevisionId,
        items: clone(this.contextItems),
      },
      checkpoints: { revision: this.checkpointRevision, items: [] },
      effectiveContexts: {
        revision: this.effectiveContextRevision,
        items: clone(this.effectiveContextItems),
      },
      observations: {
        revision: this.observationRevision,
        items: [],
      },
      workflows: clone(this.workflows),
    }, correlationId)
    this.pushCheckpoint(0, undefined, correlationId)
    this.emitRun(correlationId)
    this.updateRuntimeStatus({
      loopStatus: 'running',
      model: 'ready',
      queueDepth: 0,
      activity: { phase: 'idle', startedAt: now() },
    }, correlationId)
    if (this.run.mode === 'continuous') this.startContinuous(correlationId)
  }

  private resetRunTraceState(): void {
    const retainedContextId = this.activeContextRevisionId ?? this.contextItems.at(-1)?.id
    const retainedContext = retainedContextId
      ? this.contextItems.find((item) => item.id === retainedContextId)
      : undefined
    const retainedArtifactIds = new Set<string>()
    if (retainedContext) {
      retainedArtifactIds.add(retainedContext.renderArtifactId)
      retainedArtifactIds.add(retainedContext.messagesArtifactId)
      retainedArtifactIds.add(retainedContext.toolsArtifactId)
      if (retainedContext.diffArtifactId) retainedArtifactIds.add(retainedContext.diffArtifactId)
    }
    for (const context of this.effectiveContextItems) {
      retainedArtifactIds.add(context.requestArtifactId)
      retainedArtifactIds.add(context.messagesArtifactId)
      retainedArtifactIds.add(context.toolsArtifactId)
      if (context.diffArtifactId) retainedArtifactIds.add(context.diffArtifactId)
    }
    for (const artifactId of [...this.artifacts.keys()]) {
      if (!retainedArtifactIds.has(artifactId)) this.artifacts.delete(artifactId)
    }
    this.artifactItems.splice(
      0,
      this.artifactItems.length,
      ...this.artifactItems.filter((item) => retainedArtifactIds.has(item.id)),
    )
    this.contextItems.splice(
      0,
      this.contextItems.length,
      ...(retainedContext ? [{ ...retainedContext, parentId: undefined }] : []),
    )
    this.activeContextRevisionId = retainedContext?.id
    this.pendingContextRevisionId = undefined
    this.observations = []
    this.artifactRevision += 1
    this.contextRevision += 1
    this.effectiveContextRevision += 1
    this.observationRevision += 1
  }

  private startContinuous(correlationId: string): void {
    if (this.closed) return
    if (this.activeTask) {
      void this.activeTask.finally(() => {
        if (this.run.status === 'running' && this.run.mode === 'continuous') {
          this.startContinuous(correlationId)
        }
      })
      return
    }
    const generation = this.generation
    const task = this.runContinuously(correlationId, generation).catch(error => this.failBackgroundRun(error, correlationId, generation)).finally(() => {
      if (this.activeTask === task) this.activeTask = undefined
    })
    this.activeTask = task
  }

  private startOneStep(correlationId: string): void {
    if (this.closed) return
    if (this.activeTask) {
      void this.activeTask.finally(() => this.startOneStep(correlationId))
      return
    }
    const generation = this.generation
    const task = this.executeStep(this.run.currentStep, correlationId, generation)
      .then((completed) => {
        if (
          completed &&
          this.run.status !== 'completed' &&
          this.generation === generation
        ) {
          this.run = this.withRun({ status: 'paused' })
          this.emitRun(correlationId)
        }
      })
      .catch(error => this.failBackgroundRun(error, correlationId, generation))
      .finally(() => {
        if (this.activeTask === task) this.activeTask = undefined
      })
    this.activeTask = task
  }

  /** Post-step hooks and checkpoint finalization are outside the step's execution catch. */
  private failBackgroundRun(error: unknown, correlationId: string, generation: number): void {
    if (this.closed || generation !== this.generation) return
    const step = this.timeline[this.run.currentStep] ?? this.timeline.at(-1)!
    const failure = this.recordFailure(new RuntimeStageError('runtime', 'RUNTIME_FINALIZATION_FAILED', error instanceof Error ? error.message : String(error)),
      { ...step, type: 'context' }, correlationId)
    // Keep real tool results and document commits intact; finalization failed independently.
    this.failAssistant(failure, correlationId)
    this.run = this.withRun({ status: 'failed', failure })
    this.updateRuntimeStatus({ model: 'ready', loopStatus: 'idle', activity: { phase: 'idle', startedAt: now() } }, correlationId)
    this.emitRun(correlationId)
  }

  private async runContinuously(
    correlationId: string,
    generation: number,
  ): Promise<void> {
    while (this.run.currentStep < this.timeline.length) {
      const completed = await this.executeStep(
        this.run.currentStep,
        correlationId,
        generation,
      )
      if (!completed) return
    }
  }

  private async executeStep(
    index: number,
    correlationId: string,
    generation: number,
  ): Promise<boolean> {
    if (!(await this.awaitRunnable(generation, correlationId))) return false
    const previous = this.timeline[index]
    if (!previous) return false
    if (
      this.run.mode === 'continuous' &&
      this.bypassBreakpointStepId !== previous.id &&
      this.hitBreakpoint(previous, 'before', correlationId)
    ) {
      return false
    }
    if (this.bypassBreakpointStepId === previous.id) this.bypassBreakpointStepId = undefined
    if (previous.type === 'model' && this.pendingContextRevisionId) {
      this.applyContextRevision(this.pendingContextRevisionId, correlationId)
    }
    const started = Date.now()
    const beforeCheckpointId = this.checkpoints.at(-1)?.id
    const runningStep: TimelineStep = {
      ...previous,
      status: 'running',
      startedAt: now(),
      completedAt: undefined,
      durationMs: undefined,
      detail: {
        ...(previous.detail ?? {}),
        ...(beforeCheckpointId ? { beforeCheckpointId } : {}),
        contextRevisionId: this.activeContextRevisionId ?? null,
      },
    }
    this.run = this.withRun({
      status: 'running',
      currentStepId: runningStep.id,
    })
    this.updateTimeline(runningStep, correlationId)
    this.emitRun(correlationId)

    await sleep(this.stepDelayMs)
    if (!(await this.awaitRunnable(generation, correlationId))) return false

    try {
      switch (runningStep.type) {
        case 'context':
          {
            const usedTokens = this.estimatedModelInputTokens()
            const maxTokens = this.runtimeStatus.context.maxTokens
          this.updateRuntimeStatus({
              context: {
                usedTokens,
                maxTokens,
                utilization: Math.min(usedTokens / maxTokens, 1),
              },
          }, correlationId)
          }
          break
        case 'render':
          this.renderAndPublish(correlationId)
          break
        case 'model':
          await this.executeModelStep(runningStep, correlationId, generation)
          break
        case 'tool':
          await this.executeToolStep(runningStep, correlationId, generation)
          break
        case 'workflow':
          await this.executeWorkflowStep(runningStep, correlationId)
          break
        case 'harness':
          break
        case 'output':
          this.updateRuntimeStatus({ model: 'ready', queueDepth: 0 }, correlationId)
          break
      }
    } catch (error) {
      if (this.generation !== generation || ['interrupted', 'cancelled'].includes(this.run.status)) {
        return false
      }
      if (error instanceof RuntimeCapabilityDriftError) {
        try {
          const recovered = this.recoverCapabilityDrift(error, runningStep, correlationId, generation)
          if (recovered === true) return this.generation === generation && !this.closed
          if (recovered === false) error = new RuntimeStageError('model_protocol', 'RUNTIME_CAPABILITY_RECOVERY_LIMIT', 'capability recovery budget exhausted; rejected actions were not executed', false)
        } catch (refreshError) {
          error = new RuntimeStageError('runtime', 'RUNTIME_CAPABILITY_REFRESH_FAILED', refreshError instanceof Error ? refreshError.message : String(refreshError), false)
        }
      }
      const failure = this.recordFailure(error, runningStep, correlationId)
      this.updateTimeline({
        ...runningStep,
        status: 'error',
        completedAt: now(),
        durationMs: Date.now() - started,
        detail: {
          ...(runningStep.detail ?? {}),
          error: toJsonValue(failure),
        },
      }, correlationId)
      this.failAssistant(failure, correlationId)
      this.run = this.withRun({ status: 'waiting', failure })
      this.updateRuntimeStatus({
        model: 'ready',
        loopStatus: 'idle',
        activity: { phase: 'idle', startedAt: now() },
      }, correlationId)
      this.emitRun(correlationId)
      if (this.isLoopStep(runningStep)) {
        await this.runAfterLoopHooks('failed', correlationId, generation, true, runningStep.index)
      }
      if (this.generation === generation && this.run.status === 'waiting') {
        this.run = this.withRun({ status: 'failed', failure })
        this.emitRun(correlationId)
      }
      return false
    }

    if (this.generation !== generation || ['interrupted', 'cancelled'].includes(this.run.status)) {
      return false
    }

    const afterCheckpointId = `checkpoint-${this.checkpointRevision + 1}-${randomUUID()}`
    const completedStep: TimelineStep = {
      ...runningStep,
      status: runningStep.detail?.workflowSkipped === true
        ? 'skipped'
        : runningStep.detail?.workflowNodeFailed === true ? 'error' : 'success',
      completedAt: now(),
      durationMs: Date.now() - started,
      detail: {
        ...(runningStep.detail ?? this.stepDetail(runningStep.type)),
        afterCheckpointId,
      },
    }
    this.updateTimeline(completedStep, correlationId)
    const nextStep = index + 1
    const isComplete = nextStep >= this.timeline.length
    if (this.endsLoopIteration(completedStep, this.timeline[nextStep])) {
      const terminalLoop = !this.timeline.slice(nextStep).some(
        (step) => step.type === 'model' && step.status === 'pending',
      )
      await this.runAfterLoopHooks(
        'completed', correlationId, generation, terminalLoop, completedStep.index,
      )
      if (this.generation !== generation || ['interrupted', 'cancelled'].includes(this.run.status)) {
        return false
      }
    }
    const pauseRequested = this.run.status === 'pause_requested'
    const pauseAfterBreakpoint = !isComplete &&
      this.run.mode === 'continuous' &&
      this.matchingBreakpoint(completedStep, 'after') !== undefined
    this.run = this.withRun({
      currentStep: nextStep,
      currentStepId: completedStep.id,
      status: isComplete
        ? 'waiting'
        : pauseAfterBreakpoint || pauseRequested
          ? 'paused'
          : this.run.status,
    })
    if (isComplete) {
      this.run = this.withRun({ status: 'completed' })
    }
    this.pushCheckpoint(nextStep, completedStep.id, correlationId, afterCheckpointId, this.preparedWaits.length ? () => {
      const prepared = this.preparedWaits
      const scoped = prepared.some(wait => wait.spec.blockingTaskIds)
      try { this.getWaitStore().registerBatch(prepared, this.exportState()) }
      catch (error) {
        this.preparedWaits = []
        if (scoped) {
          const retained = this.taskControl.branchBlocks?.filter(block => !prepared.some(wait => block.id === wait.id))
          if (retained?.length) this.taskControl.branchBlocks = retained
          else delete this.taskControl.branchBlocks
          delete this.taskControl.branchPaused
        }
        this.v2ControlState = { status: 'idle', evidenceRequests: [], uncertainties: clone(this.v2ControlState.uncertainties), reflectionAttempts: this.v2ControlState.reflectionAttempts }
        throw error
      }
      this.preparedWaits = []
      this.waits = this.getWaitStore().read(this.waitBinding())
      this.snapshotRevision += 1
      this.emit('runtime.waits.updated', clone(this.waits), correlationId)
      if (scoped) this.emit('runtime.snapshot', this.getSnapshot(0), correlationId)
      else this.emit('runtime.context.v2.control.pending', { control: clone(this.v2ControlState) }, correlationId)
      this.scheduleWaitCheck()
    } : undefined)
    this.emitRun(pauseRequested ? this.pauseCorrelationId ?? correlationId : correlationId)
    if (isComplete && this.generation === generation && this.run.status === 'completed') this.publishV2DreamPass(correlationId)
    if (pauseAfterBreakpoint) {
      const breakpoint = this.matchingBreakpoint(completedStep, 'after') as RuntimeBreakpoint
      this.emit('run.breakpoint.hit', {
        breakpointId: breakpoint.id,
        stepId: completedStep.id,
        position: 'after',
      }, correlationId)
      return false
    }
    if (pauseRequested) {
      this.pauseCorrelationId = undefined
      return false
    }
    return true
  }

  private async awaitRunnable(generation: number, correlationId: string): Promise<boolean> {
    if (this.run.status === 'pause_requested') {
      this.run = this.withRun({ status: 'paused' })
      this.emitRun(this.pauseCorrelationId ?? correlationId)
      this.pauseCorrelationId = undefined
    }
    while (this.run.status === 'paused' && this.generation === generation) {
      await new Promise<void>((resolve) => this.resumeWaiters.push(resolve))
    }
    return (
      this.generation === generation &&
      !['interrupted', 'cancelled', 'failed'].includes(this.run.status)
    )
  }

  private releasePauseWaiters(): void {
    const waiters = this.resumeWaiters.splice(0)
    waiters.forEach((resolve) => resolve())
  }

  private resume(correlationId: string): void {
    this.assertNoPendingWait(true)
    if (this.childService && !this.childAgentMode) this.childService.recover(this.childBinding())
    if (this.run.status === 'interrupted') this.generation += 1
    this.bypassBreakpointStepId = this.timeline[this.run.currentStep]?.id
    this.run = this.withRun({ status: 'running' })
    this.emitRun(correlationId)
    this.releasePauseWaiters()
    if (this.run.mode === 'continuous') this.startContinuous(correlationId)
    else this.startOneStep(correlationId)
  }

  private requestPause(correlationId: string): void {
    this.pauseCorrelationId = correlationId
    this.run = this.withRun({ status: 'pause_requested' })
    this.emitRun(correlationId)
  }

  private interrupt(correlationId: string): void {
    if (this.childService && this.run.runId && this.sessionId) this.childService.suspend(this.childBinding())
    this.run = this.withRun({ status: 'interrupting' })
    this.emitRun(correlationId)
    this.generation += 1
    this.abortActiveWork()
    const current = this.timeline[this.run.currentStep]
    if (current?.status === 'running') {
      this.updateTimeline(
        interruptTimelineStep(current),
        correlationId,
      )
    }
    this.run = this.withRun({ status: 'interrupted' })
    this.updateRuntimeStatus({
      model: 'ready',
      loopStatus: 'idle',
      activity: { phase: 'idle', startedAt: now() },
    }, correlationId)
    this.emitRun(correlationId)
    this.releasePauseWaiters()
    if (this.activeAssistantId) this.cancelResponse(correlationId)
  }

  private cancelRun(correlationId: string): void {
    if (this.childService && this.run.runId && this.sessionId) this.childService.cancelAll(this.childBinding(), 'parent run cancelled')
    this.cancelPendingWait('run cancelled by user', correlationId)
    if (this.run.runId && this.sessionId && this.mcpInputViews().length) {
      this.projectContextStore.commits.mcpInputs.cancel(this.waitBinding())
      this.reconcileWorkflowForms(correlationId)
      this.emitMcpInputState(correlationId)
    }
    this.generation += 1
    this.abortActiveWork()
    const current = this.timeline[this.run.currentStep]
    if (current?.status === 'running') this.updateTimeline(interruptTimelineStep(current), correlationId)
    this.run = this.withRun({ status: 'cancelled' })
    this.updateRuntimeStatus({
      model: 'ready',
      queueDepth: 0,
      loopStatus: 'idle',
      activity: { phase: 'idle', startedAt: now() },
    }, correlationId)
    this.emitRun(correlationId)
    this.releasePauseWaiters()
    if (this.activeAssistantId) this.cancelResponse(correlationId)
  }

  private restorePrevious(correlationId: string, targetStepId?: string): void {
    let targetIndex = this.checkpoints.length - 2
    if (targetStepId) {
      const found = this.checkpoints.findIndex(
        (checkpoint) => checkpoint.currentStepId === targetStepId,
      )
      if (found >= 0) targetIndex = found
    }
    const checkpoint = this.checkpoints[targetIndex] as RuntimeCheckpoint
    this.restoreCheckpoint(checkpoint, correlationId)
  }

  private restoreCheckpointById(correlationId: string, checkpointId: string): void {
    const checkpoint = this.checkpoints.find((item) => item.id === checkpointId)
    if (!checkpoint) throw new CommandError('NOT_FOUND', 'checkpoint was not found')
    this.restoreCheckpoint(checkpoint, correlationId)
  }

  private restartStep(correlationId: string, stepId?: string): void {
    const step = stepId
      ? this.timeline.find((item) => item.id === stepId)
      : this.timeline[this.run.currentStep]
    if (!step) throw new CommandError('NOT_FOUND', 'timeline step was not found')
    const beforeCheckpointId = typeof step.detail?.beforeCheckpointId === 'string'
      ? step.detail.beforeCheckpointId
      : this.checkpoints.find((checkpoint) => checkpoint.currentStep === step.index)?.id
    const checkpoint = this.checkpoints.find((item) => item.id === beforeCheckpointId)
    if (!checkpoint) throw new CommandError('INVALID_STATE', 'step has no restorable input checkpoint')
    this.restoreCheckpoint(checkpoint, correlationId)
    this.run = this.withRun({ status: 'running' })
    this.emitRun(correlationId)
    this.startOneStep(correlationId)
  }

  private upsertBreakpoint(breakpoint: RuntimeBreakpoint, correlationId: string): void {
    const index = this.breakpointItems.findIndex((item) => item.id === breakpoint.id)
    if (index >= 0) this.breakpointItems[index] = clone(breakpoint)
    else this.breakpointItems.push(clone(breakpoint))
    this.breakpointRevision += 1
    this.snapshotRevision += 1
    this.emit('runtime.breakpoints.updated', {
      revision: this.breakpointRevision,
      items: clone(this.breakpointItems),
    }, correlationId)
  }

  private removeBreakpoint(breakpointId: string, correlationId: string): void {
    const index = this.breakpointItems.findIndex((item) => item.id === breakpointId)
    if (index >= 0) this.breakpointItems.splice(index, 1)
    this.breakpointRevision += 1
    this.snapshotRevision += 1
    this.emit('runtime.breakpoints.updated', {
      revision: this.breakpointRevision,
      items: clone(this.breakpointItems),
    }, correlationId)
  }

  private matchingBreakpoint(
    step: TimelineStep,
    position: RuntimeBreakpoint['position'],
  ): RuntimeBreakpoint | undefined {
    const toolName = typeof step.detail?.toolName === 'string' ? step.detail.toolName : undefined
    return this.breakpointItems.find((breakpoint) =>
      breakpoint.enabled &&
      breakpoint.position === position &&
      (breakpoint.stepId === undefined || breakpoint.stepId === step.id) &&
      (breakpoint.stepType === undefined || breakpoint.stepType === step.type) &&
      (breakpoint.toolName === undefined || breakpoint.toolName === toolName),
    )
  }

  private hitBreakpoint(
    step: TimelineStep,
    position: RuntimeBreakpoint['position'],
    correlationId: string,
  ): boolean {
    const breakpoint = this.matchingBreakpoint(step, position)
    if (!breakpoint) return false
    this.run = this.withRun({ status: 'paused', currentStepId: step.id })
    this.emitRun(correlationId)
    this.emit('run.breakpoint.hit', {
      breakpointId: breakpoint.id,
      stepId: step.id,
      position,
    }, correlationId)
    return true
  }

  private restoreCheckpoint(checkpoint: RuntimeCheckpoint, correlationId: string): void {
    this.assertNoPendingWait()
    if (this.childService && this.run.runId && this.sessionId) {
      const saved = checkpoint.taskControl
      for (const job of this.childService.store.list(this.childBinding())) {
        const assigned = job.spec.assignment
        if (assigned && (!saved?.tasks.some(task => task.id === assigned.planTaskId) || saved.planRevision < (job.takeover?.planRevision ?? assigned.planRevision))) {
          throw new CommandError('INVALID_STATE', 'CHILD_PLAN_CHECKPOINT_PRECEDES_ASSIGNMENT')
        }
      }
    }
    if (this.childService && this.run.runId && this.sessionId) this.childService.suspend(this.childBinding())
    this.generation += 1
    this.abortActiveWork()
    const targetIndex = this.checkpoints.findIndex((item) => item.id === checkpoint.id)
    this.checkpoints = this.checkpoints.slice(0, targetIndex + 1)
    const baseRevision = this.variables.revision
    this.variables = {
      revision: baseRevision + 1,
      value: clone(checkpoint.variables),
    }
    this.messages.splice(0, this.messages.length, ...clone(checkpoint.messages))
    this.llmMessages = discardOrphanToolMessages(clone(checkpoint.llmMessages))
    const restoredCache = this.runtimeCacheValue()
    this.applyRuntimeCache(restoredCache)
    this.variables.value.builtin.cache = restoredCache
    this.variables.value.builtin.sys_message = this.systemMessageValue()
    this.tools = {
      ...this.tools,
      revision: this.tools.revision + 1,
      items: clone(checkpoint.tools),
    }
    this.harnessRevision += 1
    this.harnesses = {
      revision: this.harnessRevision,
      items: clone(checkpoint.harnesses).map((item) => ({
        ...item,
        revision: this.harnessRevision,
      })),
      catalog: this.harnessCatalogDefinitions(),
    }
    this.skillRevision += 1
    const checkpointSkills = this.revalidateSkillAttachments(checkpoint.skills ?? [], 'SKILL_RESTORE_FAILED')
    this.skills = {
      revision: this.skillRevision,
      items: checkpointSkills,
      catalog: clone(this.skillCatalog),
    }
    this.tools.items = this.withRequiredSkillTools(checkpointSkills, this.tools.items)
    this.variables.value.skills = this.skillVariableValue()
    this.variables.value.tools = this.tools.items.map(({ id, name, description }) => ({ id, name, description }))
    this.timeline = clone(checkpoint.timeline)
    this.effectiveContextItems = clone(checkpoint.effectiveContexts)
    this.effectiveContextRevision += 1
    this.observations = clone(checkpoint.observations)
    this.observationRevision += 1
    this.pendingToolCalls = new Map(clone(checkpoint.pendingToolCalls))
    this.pendingWorkflowCalls = new Map(clone(checkpoint.pendingWorkflowCalls ?? []))
    this.workflowDefinitions = new Map(clone(checkpoint.workflowDefinitions ?? []))
    this.workflowData = new Map(clone(checkpoint.workflowData ?? []))
    this.workflows = clone(checkpoint.workflows ?? { revision: this.workflowRevision, items: [] })
    this.workflowRevision = this.workflows.revision
    this.toolRound = checkpoint.toolRound
    this.continuationRound = checkpoint.continuationRound
    this.mcp.restoreState(checkpoint.mcp)
    this.mcpActiveToolIds.clear()
    for (const id of checkpoint.mcp?.activeToolIds ?? checkpoint.tools.filter(tool => tool.origin?.type === 'mcp').map(tool => tool.id)) this.mcpActiveToolIds.add(id)
    this.loopIteration = checkpoint.loopIteration ?? 0
    this.loopVariableBaseline = clone(checkpoint.loopVariableBaseline ?? checkpoint.variables)
    this.runUsage = clone(checkpoint.usage)
    if (checkpoint.contextDocumentState) {
      const restoredContext = this.contextOrganization.enabled && this.sessionId
        ? this.projectContextStore.commits.restoreSessionCheckpoint(this.sessionId, checkpoint.contextDocumentState)
        : checkpoint.contextDocumentState
      this.contextDocumentEngine = new ContextDocumentEngine(
        restoredContext.document,
        restoredContext.receipts,
        restoredContext.projections,
        restoredContext.reviewReceipts,
        restoredContext.evidenceReviewReceipts,
      )
      if (this.contextOrganization.enabled) {
        this.contextHistory = new ContextHistory({ ...this.contextHistory.snapshot(), coverage: { coveredThrough: 0, retainedMessageIds: [], receiptIds: [] } })
        this.projectContextDocumentEngine = this.projectContextStore.load()
        this.lastOrganizationAttemptSequence = -1
      }
    }
    this.browserContexts.clear()
    if (this.browserGateway && checkpoint.browserGateway) {
      this.browserGateway.restoreState(checkpoint.browserGateway)
      for (const saved of checkpoint.browserContexts ?? []) {
        const profile = this.browserGateway.capability.getProfile(saved.profileId)
        const session = this.browserGateway.capability.getSession(saved.sessionId)
        const tab = this.browserGateway.capability.getTab(saved.tabId)
        if (!profile || !session || !tab) continue
        this.browserContexts.set(saved.key, {
          profile,
          session,
          tab,
          browserInstanceId: saved.browserInstanceId,
          allowedOrigins: [...saved.allowedOrigins],
          nextSequence: saved.nextSequence,
        })
      }
    }
    // Older checkpoints may predate V2 control persistence. Restore an explicit
    // idle state in that case so a pending wait/evidence request from the
    // current run cannot leak across rollback.
    this.v2ControlState = clone(checkpoint.contextControl ?? {
      status: 'idle',
      evidenceRequests: [],
      uncertainties: [],
      reflectionAttempts: 0,
    })
    // A work checkpoint cannot resurrect a settled or cancelled subscription.
    this.reflectionRecordId = checkpoint.reflectionRecordId
    this.reflectionFailure = checkpoint.reflectionFailure
    if (this.v2ControlState.status === 'waiting') {
      this.v2ControlState = { status: 'idle', evidenceRequests: [], uncertainties: clone(this.v2ControlState.uncertainties), reflectionAttempts: this.v2ControlState.reflectionAttempts }
    }
    this.taskControl = clone(checkpoint.taskControl ?? emptyTaskControl(`task-${randomUUID()}`, '恢复的任务'))
    this.reconcileChildAssignments()
    this.renderResult = clone(checkpoint.renderResult)
    this.activeContextRevisionId = checkpoint.contextRevisionId
    this.pendingContextRevisionId = undefined
    this.activeAssistantId = this.messages.find((message) => message.status === 'streaming')?.id
    this.responseGeneration += 1
    const patch: JsonPatchOperation[] = Object.entries(this.variables.value).map(
      ([key, value]) => ({
        op: 'add',
        path: `/${escapePointerToken(key)}`,
        value,
      }),
    )
    this.timelineRevision += 1
    this.run = this.withRun({
      currentStep: checkpoint.currentStep,
      currentStepId: checkpoint.currentStepId,
      status: 'paused',
      failure: undefined,
      modelRetry: undefined,
    })
    this.snapshotRevision += 1
    this.checkpointRevision += 1
    this.emit(
      'variables.updated',
      {
        baseRevision,
        revision: this.variables.revision,
        patch,
        source: 'restore',
      },
      correlationId,
    )
    this.contextBuilder.setProperties(this.variables.value, false)
    if (JSON.stringify(checkpoint.variables.skills) === JSON.stringify(this.variables.value.skills)) this.emit('render.result.updated', clone(this.renderResult), correlationId)
    else this.renderAndPublish(correlationId)
    this.emit('runtime.tools.updated', clone(this.tools), correlationId)
    this.emit('runtime.harnesses.updated', clone(this.harnesses), correlationId)
    this.emit('runtime.plugins.updated', clone(this.plugins), correlationId)
    this.emit('runtime.skills.updated', clone(this.skills), correlationId)
    this.emit('runtime.checkpoint.restored', {
      checkpointId: checkpoint.id,
      ...(checkpoint.contextRevisionId
        ? { contextRevisionId: checkpoint.contextRevisionId }
        : {}),
    }, correlationId)
    this.emitRun(correlationId)
    this.emit('runtime.snapshot', this.getSnapshot(0), correlationId)
    this.releasePauseWaiters()
  }

  private sendMessage(
    command: Extract<ClientCommand, { type: 'chat.message.send' }>,
  ): void {
    const timestamp = now()
    const text = command.payload.content
      .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim()
    const branch = this.pendingBranchHuman(command.payload.humanRequestId)
    if (branch) {
      if (!text.trim()) throw new CommandError('INVALID_PAYLOAD', 'BRANCH_REPLY_EMPTY')
      const reply = { messageId: command.payload.clientMessageId, text, ...(command.payload.planningRequired ? { replan: true } : {}) }
      if (branch.kind === 'evidence') this.getWaitStore().supplyEvidence(this.waitBinding(), branch.id, 'user', reply)
      else this.getWaitStore().replyToBranchHuman(this.waitBinding(), branch.id, reply)
    }
    const resumesV2Control = this.run.status === 'paused'
      && ['awaiting_user', 'awaiting_evidence'].includes(this.v2ControlState.status)
    const autoStart = command.payload.autoStart && !resumesV2Control && !branch
    const requestId = autoStart
      ? `request-${randomUUID()}`
      : this.run.runId ?? undefined
    this.appendContextHistory({ role: 'user', content: text }, 'user', undefined, command.payload.clientMessageId, requestId)
    const message: ChatMessage = {
      id: command.payload.clientMessageId,
      ...(requestId ? { requestId } : {}),
      role: 'user',
      status: 'completed',
      content: [{ type: 'text', text }],
      createdAt: timestamp,
      completedAt: timestamp,
    }
    this.clientMessageIds.add(command.payload.clientMessageId)
    this.messages.push(message)
    this.conversationRevision += 1
    this.snapshotRevision += 1
    this.emit('chat.user.created', clone(message), command.id)
    if (!autoStart && this.run.runId) {
      this.llmMessages = this.limitRuntimeMessages([
        ...this.llmMessages,
        { role: 'user', content: text },
      ])
    }

    const patch: JsonPatchOperation[] = [
      { op: 'replace', path: '/user_message', value: text },
    ]
    const harnessesChanged = this.reconcileHarnessBindings(command.id, {
      publish: false,
      experienceQuery: text,
      sourceId: requestId ?? command.payload.clientMessageId,
    })
    this.updateVariables(patch, 'runtime', command.id)
    if (harnessesChanged) {
      this.emit('runtime.harnesses.updated', clone(this.harnesses), command.id)
    }
    if (autoStart) {
      this.activateBaselineWorkspaceResources(command.id)
      const system = this.renderResult.messages.find((item) => item.role === 'system')?.content ?? ''
      this.llmMessages = this.limitRuntimeMessages([
        { role: 'system', content: system },
        ...this.llmMessages.filter((item) => item.role !== 'system'),
        { role: 'user', content: text },
      ])
    }
    if (resumesV2Control && !branch) {
      const requestId = this.v2ControlState.requestId
      this.v2ControlState = { status: 'idle', evidenceRequests: [], uncertainties: clone(this.v2ControlState.uncertainties), reflectionAttempts: this.v2ControlState.reflectionAttempts }
      this.taskControl.stateRevision += 1
      if (command.payload.planningRequired) this.taskControl.planning = { required: true, reason: 'human reply requested replanning' }
      this.snapshotRevision += 1
      this.emit('runtime.context.v2.control.cleared', { ...(requestId ? { requestId } : {}) }, command.id)
    }
    if (autoStart) this.beginRun(command.id, requestId, command.payload.planningRequired)
    else if (branch) this.scheduleWaitCheck()
    else if (resumesV2Control) this.resumeAfterControl(command.id)
  }

  private publishWorkflows(correlationId: string): void {
    this.workflowRevision += 1
    this.workflows = { ...this.workflows, revision: this.workflowRevision }
    this.snapshotRevision += 1
    this.emit('runtime.workflows.updated', clone(this.workflows), correlationId)
  }

  private workflowPlan(planId: string): RuntimeWorkflowPlan {
    const plan = this.workflows.items.find((item) => item.id === planId)
    if (!plan) throw new Error(`runtime workflow plan was not found: ${planId}`)
    return plan
  }

  private updateWorkflowPlan(
    planId: string,
    patch: Partial<RuntimeWorkflowPlan>,
    correlationId: string,
  ): RuntimeWorkflowPlan {
    let updated: RuntimeWorkflowPlan | undefined
    this.workflows = {
      ...this.workflows,
      items: this.workflows.items.map((plan) => {
        if (plan.id !== planId) return plan
        updated = { ...plan, ...clone(patch) }
        return updated
      }),
    }
    if (!updated) throw new Error(`runtime workflow plan was not found: ${planId}`)
    this.publishWorkflows(correlationId)
    return updated
  }

  private updateWorkflowNode(
    planId: string,
    nodeId: string,
    patch: Partial<RuntimeWorkflowNode>,
    correlationId: string,
  ): RuntimeWorkflowNode {
    const plan = this.workflowPlan(planId)
    let updated: RuntimeWorkflowNode | undefined
    const nodes = plan.nodes.map((node) => {
      if (node.id !== nodeId) return node
      updated = { ...node, ...clone(patch) }
      return updated
    })
    if (!updated) throw new Error(`runtime workflow node was not found: ${nodeId}`)
    this.updateWorkflowPlan(planId, { nodes }, correlationId)
    return updated
  }

  private insertTimelineSteps(
    afterIndex: number,
    steps: TimelineStep[],
    correlationId: string,
  ): void {
    this.timeline.splice(afterIndex + 1, 0, ...steps)
    this.timeline = this.timeline.map((item, index) => ({ ...item, index }))
    for (let index = afterIndex + 1; index < this.timeline.length; index += 1) {
      this.updateTimeline(this.timeline[index] as TimelineStep, correlationId)
    }
  }

  private workflowTimelineStep(
    planId: string,
    definition: GeneratedWorkflowStep,
  ): TimelineStep {
    const timelineStepId = `step-${planId}-${definition.id}`
    const detail: JsonObject = {
      workflowPlanId: planId,
      workflowNodeId: definition.id,
      workflowSourceStepId: definition.id,
      workflowNodeType: definition.type,
      definition: toJsonValue(definition),
    }
    if (definition.type === 'tool') {
      const callId = `call-${planId}-${definition.id}`
      this.pendingToolCalls.set(timelineStepId, {
        id: callId,
        name: definition.tool,
        arguments: definition.arguments,
        authorization: this.workflowData.get(planId)?.authorization,
      })
      return {
        id: timelineStepId,
        index: 0,
        type: 'tool',
        status: 'pending',
        summary: `${definition.id} · ${definition.tool}`,
        detail: { ...detail, callId, toolName: definition.tool },
      }
    }
    return {
      id: timelineStepId,
      index: 0,
      type: 'workflow',
      status: 'pending',
      summary: `${definition.id} · ${definition.type}`,
      detail: definition.type === 'foreach'
        ? { ...detail, toolName: definition.tool }
        : detail,
    }
  }

  private async executeWorkflowStep(
    step: TimelineStep,
    correlationId: string,
  ): Promise<void> {
    const nodeType = step.detail?.workflowNodeType
    this.updateRuntimeStatus({
      activity: {
        phase: 'workflow_running',
        label: nodeType ? String(nodeType) : step.summary,
        startedAt: now(),
      },
    }, correlationId)
    const planId = typeof step.detail?.workflowPlanId === 'string'
      ? step.detail.workflowPlanId
      : undefined
    if (
      planId
      && nodeType !== 'finalize'
      && ['failed', 'suspended'].includes(this.workflowPlan(planId).status)
    ) {
      step.detail = {
        ...(step.detail ?? {}),
        workflowSkipped: true,
        reason: 'workflow stopped at a partial result',
      }
      return
    }
    if (nodeType === 'resume') {
      this.startWorkflowResume(step, correlationId)
      return
    }
    if (nodeType === 'plan') {
      await this.startGeneratedWorkflow(step, correlationId)
      return
    }
    if (nodeType === 'filter') {
      await this.executeWorkflowFilter(step, correlationId)
      return
    }
    if (nodeType === 'transform') {
      await this.executeWorkflowTransform(step, correlationId)
      return
    }
    if (nodeType === 'assert') {
      await this.executeWorkflowAssert(step, correlationId)
      return
    }
    if (nodeType === 'parse' || nodeType === 'align' || nodeType === 'validate_schema' || nodeType === 'join') {
      await this.executeWorkflowSchemaNode(step, correlationId)
      return
    }
    if (nodeType === 'foreach') {
      await this.executeWorkflowForeach(step, correlationId)
      return
    }
    if (nodeType === 'finalize') {
      this.finalizeGeneratedWorkflow(step, correlationId)
      return
    }
    throw new RuntimeStageError(
      'workflow_validation',
      'WORKFLOW_NODE_UNSUPPORTED',
      `unsupported generated workflow node: ${String(nodeType)}`,
    )
  }

  private async startGeneratedWorkflow(
    step: TimelineStep,
    correlationId: string,
  ): Promise<void> {
    const request = this.pendingWorkflowCalls.get(step.id)
    if (!request) throw new Error(`generated workflow request is missing for ${step.id}`)
    this.validatePendingCapabilities(request)
    const planId = `workflow-${this.run.runId}-${this.workflows.items.length + 1}`
    let definition: GeneratedWorkflowDefinition
    let compile: ReturnType<typeof compileGeneratedWorkflow>['summary']
    let definitionArtifact: RuntimeArtifactMeta
    try {
      const compiled = compileGeneratedWorkflow(
        request.arguments,
        new Map(this.tools.items.filter(tool => request.authorization!.projection.bindings.some(binding => binding.name === tool.name)).flatMap((tool) => [
          [tool.name, tool.name],
          [tool.id, tool.name],
        ])),
      )
      definition = compiled.definition
      compile = compiled.summary
      definitionArtifact = this.createArtifact(
        'workflow-definition',
        'Generated workflow definition',
        definition,
        correlationId,
      )
    } catch (error) {
      definitionArtifact = this.createArtifact(
        'workflow-definition',
        'Generated workflow intent rejected',
        request.arguments,
        correlationId,
      )
      const failed: RuntimeWorkflowPlan = {
        id: planId,
        runId: this.run.runId as string,
        callId: request.id,
        revision: this.workflows.items.length + 1,
        goal: isObject(request.arguments) && typeof request.arguments.goal === 'string'
          ? request.arguments.goal
          : 'Invalid generated workflow',
        status: 'failed',
        definitionArtifactId: definitionArtifact.id,
        nodes: [],
        createdAt: now(),
        completedAt: now(),
        error: toJsonValue({
          code: 'WORKFLOW_DEFINITION_INVALID',
          message: error instanceof Error ? error.message : String(error),
        }),
      }
      this.workflows = { ...this.workflows, activePlanId: planId, items: [...this.workflows.items, failed] }
      this.publishWorkflows(correlationId)
      const result = { ok: false, error: {
        code: 'WORKFLOW_DEFINITION_INVALID', category: 'validation', recoverable: true,
        message: error instanceof Error ? error.message : String(error),
        nextAction: 'Correct execute_workflow arguments and call again. Required top-level fields: version (1), goal, steps. No workflow steps were executed. Do not repeat unchanged arguments.',
      } }
      const artifact = this.createArtifact('workflow-result', 'Workflow argument validation failed', result, correlationId)
      this.updateWorkflowPlan(planId, { resultArtifactId: artifact.id }, correlationId)
      step.detail = { ...step.detail, ok: false, validationFailed: true, resultArtifactId: artifact.id, resultPreview: artifact.preview }
      this.appendRuntimeMessage({ role: 'tool', name: request.name, toolCallId: request.id, content: JSON.stringify(result) })
      this.pendingWorkflowCalls.delete(step.id)
      this.publishRenderedMessages(correlationId)
      this.emit('tool.call.failed', { callId: request.id, toolName: request.name, code: result.error.code,
        message: result.error.message, startedAt: failed.createdAt, completedAt: failed.completedAt ?? now(), durationMs: 0 }, correlationId)
      this.upsertObservation({ id: `observation-${this.run.runId}-${request.id}`, runId: this.run.runId as string,
        stepId: step.id, callId: request.id, toolName: request.name, status: 'failed',
        arguments: toJsonValue(request.arguments), resultArtifactId: artifact.id, resultPreview: artifact.preview,
        error: toJsonValue(result.error), startedAt: failed.createdAt, completedAt: failed.completedAt ?? now(), durationMs: 0 }, correlationId)
      diagnosticLog('workflow.validation_failed', { runId: this.run.runId, callId: request.id, code: result.error.code, recovery: 'model_argument_repair' })
      return
    }
    const data: WorkflowExecutionData = {
      authorization: request.authorization,
      steps: Object.fromEntries(definition.steps.map((item) => [item.id, { status: 'pending' }])),
    }
    const nodes: RuntimeWorkflowNode[] = definition.steps.map((item) => ({
      id: item.id,
      sourceStepId: item.id,
      timelineStepId: `step-${planId}-${item.id}`,
      type: item.type,
      ...('tool' in item ? { toolName: item.tool } : {}),
      status: 'pending',
    }))
    const plan: RuntimeWorkflowPlan = {
      id: planId,
      runId: this.run.runId as string,
      callId: request.id,
      revision: this.workflows.items.length + 1,
      goal: definition.goal,
      status: 'running',
      definitionArtifactId: definitionArtifact.id,
      nodes,
      compile,
      createdAt: now(),
    }
    this.workflowDefinitions.set(planId, definition)
    this.workflowData.set(planId, data)
    this.pendingWorkflowCalls.delete(step.id)
    this.pendingWorkflowCalls.set(planId, request)
    this.workflows = { ...this.workflows, activePlanId: planId, items: [...this.workflows.items, plan] }
    this.publishWorkflows(correlationId)
    step.detail = {
      ...(step.detail ?? {}),
      workflowPlanId: planId,
      callId: request.id,
      toolName: request.name,
      goal: definition.goal,
      definitionArtifactId: definitionArtifact.id,
    }
    this.updateTimeline({ ...step }, correlationId)
    const startedAt = now()
    this.emit('tool.call.started', {
      callId: request.id,
      toolName: request.name,
      arguments: toJsonValue(request.arguments),
      startedAt,
    }, correlationId)
    this.upsertObservation({
      id: `observation-${this.run.runId}-${request.id}`,
      runId: this.run.runId as string,
      stepId: step.id,
      callId: request.id,
      toolName: request.name,
      status: 'running',
      arguments: toJsonValue(request.arguments),
      startedAt,
    }, correlationId)
    const workflowSteps = definition.steps.map((item) => this.workflowTimelineStep(planId, item))
    const finalizeStep: TimelineStep = {
      id: `step-${planId}-finalize`,
      index: 0,
      type: 'workflow',
      status: 'pending',
      summary: '完成临时 Workflow 并回传模型',
      detail: {
        workflowPlanId: planId,
        workflowNodeType: 'finalize',
        callId: request.id,
        toolName: request.name,
      },
    }
    this.insertTimelineSteps(step.index, [...workflowSteps, finalizeStep], correlationId)
    this.updateRuntimeStatus({ queueDepth: this.pendingToolCalls.size }, correlationId)
  }

  private startWorkflowResume(step: TimelineStep, correlationId: string): void {
    const request = this.pendingWorkflowCalls.get(step.id)
    if (!request?.authorization) throw new Error('Workflow recovery request is missing')
    this.validatePendingCapabilities(request)
    let continuation: ReturnType<RuntimeLoop['prepareWorkflowResume']>
    try {
      continuation = this.prepareWorkflowResume(request)
    } catch (error) {
      const failure = { code: 'WORKFLOW_RESUME_REJECTED', message: error instanceof Error ? error.message : String(error) }
      const artifact = this.createArtifact('workflow-result', 'Workflow recovery rejected', { ok: false, error: failure }, correlationId)
      this.appendRuntimeMessage({ role: 'tool', name: request.name, toolCallId: request.id,
        content: this.boundedToolContent(artifact.id, { ok: false, error: failure }) })
      this.pendingWorkflowCalls.delete(step.id)
      step.detail = { ...step.detail, workflowNodeFailed: true, resultArtifactId: artifact.id, error: toJsonValue(failure) }
      this.emit('tool.call.failed', { callId: request.id, toolName: request.name, ...failure,
        startedAt: step.startedAt ?? now(), completedAt: now(), durationMs: 0 }, correlationId)
      this.publishRenderedMessages(correlationId)
      return
    }

    const { plan, data, originalStep, tail, proof, originalOutput } = continuation
    const receipt = proof.kind === 'input' ? { inputReceiptId: proof.id } : { verificationReceiptId: proof.id }
    const resumedSteps = tail.map((previous): TimelineStep => {
      const old = previous.detail!
      const nodeId = String(old.workflowNodeId)
      const sourceId = String(old.workflowSourceStepId)
      const id = `${step.id}-${nodeId}`
      const detail: JsonObject = { workflowPlanId: plan.id, workflowNodeId: nodeId, workflowSourceStepId: sourceId,
        workflowNodeType: old.workflowNodeType!, definition: old.definition!,
        ...(typeof old.toolName === 'string' ? { toolName: old.toolName } : {}),
        ...(typeof old.workflowIteration === 'number' ? { workflowIteration: old.workflowIteration, workflowLocals: old.workflowLocals!, workflowParentId: sourceId } : {}) }
      if (previous.type === 'tool') {
        const definition = old.definition as unknown as GeneratedWorkflowStep
        if (!('tool' in definition)) throw new Error('Workflow recovery tool definition missing')
        const callId = `call-${id}`
        detail.callId = callId
        if (previous.id === originalStep.id && proof.retryArgumentHash) detail.retryMcpArgumentHash = proof.retryArgumentHash
        this.pendingToolCalls.set(id, { id: callId, name: definition.tool, arguments: definition.arguments, authorization: request.authorization })
      }
      if (typeof old.workflowIteration === 'number') {
        data.steps[sourceId] = { status: 'running', output: data.steps[sourceId]?.output }
      } else data.steps[sourceId] = { status: 'pending' }
      return { id, type: previous.type, index: 0, status: 'pending', summary: previous.summary, detail }
    })
    data.authorization = request.authorization
    const scheduled = new Map(resumedSteps.map(item => [item.detail!.workflowNodeId, item.id]))
    this.pendingWorkflowCalls.delete(step.id)
    this.pendingWorkflowCalls.set(plan.id, request)
    this.workflows = { ...this.workflows, activePlanId: plan.id }
    this.updateWorkflowPlan(plan.id, { status: 'running', completedAt: undefined, error: undefined, recovery: undefined,
      continuations: [...plan.continuations ?? [], { callId: request.id, ...receipt, partialArtifactId: plan.resultArtifactId! }],
      nodes: plan.nodes.map(node => scheduled.has(node.id) ? { ...node, status: 'pending', timelineStepId: scheduled.get(node.id),
        error: undefined, startedAt: undefined, completedAt: undefined, durationMs: undefined, outputArtifactId: undefined } : node),
    }, correlationId)
    if (!proof.retryArgumentHash) {
      this.completeWorkflowToolNode(originalStep, { output: originalOutput, artifactId: proof.artifactId,
        outputUnavailable: originalOutput === undefined, completedAt: proof.completedAt }, correlationId)
    }
    step.detail = { ...step.detail, workflowPlanId: plan.id, ...(proof.kind === 'input' ? { inputReceiptId: proof.id } : { verificationReceiptId: proof.id }) }
    const finalize: TimelineStep = { id: `${step.id}-finalize`, type: 'workflow', index: 0, status: 'pending', summary: '完成恢复的 Workflow 并回传模型',
      detail: { workflowPlanId: plan.id, workflowNodeType: 'finalize', callId: request.id, toolName: request.name } }
    this.insertTimelineSteps(step.index, [...resumedSteps, finalize], correlationId)
    this.updateRuntimeStatus({ queueDepth: this.pendingToolCalls.size }, correlationId)
  }

  private prepareWorkflowResume(request: ToolCallRequest) {
    const args = request.arguments
    if (!isObject(args) || Object.keys(args).length !== 2 || typeof args.workflow_id !== 'string'
      || (typeof args.verification_receipt_id !== 'string' && typeof args.input_receipt_id !== 'string')) {
      throw new Error('Workflow recovery needs workflow_id and exactly one verification_receipt_id or input_receipt_id')
    }
    const plan = this.workflowPlan(args.workflow_id)
    const recovery = plan.recovery
    const data = this.workflowData.get(plan.id)
    const originalStep = this.workflowRecoveryStep(plan)
    if (!recovery || !originalStep || !['failed', 'suspended'].includes(plan.status) || plan.runId !== this.run.runId || !plan.resultArtifactId || !data) {
      throw new Error('Workflow is not awaiting recovery in this run')
    }
    let proof: { kind: 'input' | 'verification'; id: string; artifactId: string; completedAt: string; retryArgumentHash?: string }
    let originalOutput: unknown
    if (typeof args.input_receipt_id === 'string') {
      const completion = this.workflowFormCompletion(plan)
      const artifact = completion && this.projectContextStore.commits.readArtifactSource(completion.artifactId, this.sessionId)
      if (!completion || completion.artifactId !== args.input_receipt_id || artifact?.meta.hash !== completion.artifactHash
        || artifact.meta.kind !== 'tool-result' || artifact.meta.runId !== plan.runId) throw new Error('Workflow input receipt does not match the original node')
      const original = JSON.parse(artifact.body) as { ok?: unknown; result?: unknown }
      if (original.ok !== true || original.result === undefined) throw new Error('Workflow input receipt has no successful tool result')
      originalOutput = original.result
      proof = { kind: 'input', id: artifact.meta.id, artifactId: artifact.meta.id, completedAt: artifact.meta.createdAt }
    } else {
      const operation = this.verifiedMcpOperations().find(item => item.source.operationId === recovery.operationId
        && item.binding?.stepId === originalStep.id && item.verification?.id === args.verification_receipt_id)
      if (!operation?.verification || !operation.binding) throw new Error('Workflow recovery proof does not match the original operation')
      const verification = operation.verification
      if (verification.outcome === 'applied') originalOutput = this.verifiedWorkflowOutput(operation)
      proof = { kind: 'verification', id: verification.id, artifactId: verification.originalResult?.artifactId ?? verification.artifactId,
        completedAt: verification.verifiedAt, ...(verification.outcome === 'not_applied' ? { retryArgumentHash: operation.binding.argumentHash } : {}) }
    }
    const end = this.timeline.find(item => item.index > originalStep.index && item.detail?.workflowPlanId === plan.id && item.detail.workflowNodeType === 'finalize')
    if (!end) throw new Error('Workflow recovery is missing its original tail')
    const tail = this.timeline.slice(originalStep.index + Number(!proof.retryArgumentHash), end.index)
      .filter(item => item.detail?.workflowPlanId === plan.id && typeof item.detail.workflowNodeId === 'string')
    const names = new Set(request.authorization?.projection.bindings.map(binding => binding.name))
    if (tail.some(item => typeof item.detail?.toolName === 'string' && !names.has(item.detail.toolName))) {
      throw new Error('Remaining Workflow tools must be in the current capability projection')
    }
    if (!proof.retryArgumentHash) {
      const sourceId = String(originalStep.detail?.workflowSourceStepId)
      if (originalOutput === undefined && tail.some(item => needsWorkflowOutput(item.detail!.definition as unknown as GeneratedWorkflowStep,
        sourceId, typeof item.detail!.workflowIteration === 'number'))) throw new Error('A remaining Workflow step needs the original MCP result')
    }
    return { plan, data, originalStep, tail, proof, originalOutput }
  }

  private workflowRecoveryStep(plan: RuntimeWorkflowPlan): TimelineStep | undefined {
    const recovery = plan.recovery
    return recovery && this.timeline.find(item => item.id === recovery.stepId && item.detail?.workflowPlanId === plan.id && item.detail?.workflowNodeId === recovery.nodeId)
  }

  private workflowFormCompletion(plan: RuntimeWorkflowPlan) {
    if (!this.sessionId || !this.run.runId || !plan.recovery?.inputRequestId) return undefined
    const step = this.workflowRecoveryStep(plan)
    return step && this.projectContextStore.commits.mcpInputs.completed(this.waitBinding()).find(result =>
      result.workflow?.id === plan.id && result.workflow.nodeId === plan.recovery!.nodeId && result.originStepId === step.id
      && result.originCallId === step.detail?.callId && result.operationId === plan.recovery!.operationId)
  }

  private reconcileWorkflowForms(correlationId: string): void {
    if (!this.sessionId || !this.run.runId) return
    const store = this.projectContextStore.commits.mcpInputs, binding = this.waitBinding()
    for (const plan of this.workflows.items) {
      if (plan.status !== 'suspended' || !plan.recovery?.inputRequestId || plan.runId !== binding.runId) continue
      const step = this.workflowRecoveryStep(plan), callId = step?.detail?.callId
      if (typeof callId !== 'string') continue
      const form = store.workflowFormState(binding, plan.id, plan.recovery.nodeId, callId)
      const cancelled = form?.status === 'declined' || form?.status === 'cancelled'
      const readInterrupted = !plan.recovery.operationId && form?.status === 'interrupted'
      if (cancelled || readInterrupted) this.updateWorkflowPlan(plan.id, { status: cancelled ? 'cancelled' : 'failed', recovery: undefined,
        completedAt: now(), error: { code: cancelled ? 'WORKFLOW_INPUT_CANCELLED' : 'WORKFLOW_INPUT_FAILED', formId: form!.id },
        nodes: plan.nodes.map(node => node.status === 'awaiting_input' ? { ...node, status: cancelled ? 'cancelled' : 'failed', completedAt: now() } : node),
      }, correlationId)
    }
  }

  private verifiedWorkflowOutput(operation: McpOperation): unknown {
    if (!this.sessionId || operation.verification?.outcome !== 'applied') return undefined
    const reference = operation.verification.originalResult ?? operation.verification
    const artifact = this.projectContextStore.commits.readArtifactSource(reference.artifactId, this.sessionId)
    return artifact?.meta.hash === reference.artifactHash ? this.mcp.verifiedOriginalResult(operation, JSON.parse(artifact.body).result) : undefined
  }

  private workflowNeedsMcpOutput(operation: McpOperation): boolean {
    return operation.verification?.outcome === 'applied'
      && this.workflows.items.some(plan => plan.runId === this.run.runId && ['failed', 'suspended'].includes(plan.status) && plan.recovery?.operationId === operation.source.operationId)
      && this.verifiedWorkflowOutput(operation) === undefined
  }

  private async executeWorkflowFilter(
    step: TimelineStep,
    correlationId: string,
  ): Promise<void> {
    const planId = String(step.detail?.workflowPlanId ?? '')
    const sourceStepId = String(step.detail?.workflowSourceStepId ?? '')
    const definition = this.workflowDefinitions.get(planId)?.steps.find(
      (item) => item.id === sourceStepId && item.type === 'filter',
    )
    const data = this.workflowData.get(planId)
    if (!definition || definition.type !== 'filter' || !data) {
      throw new RuntimeStageError('workflow_execution', 'WORKFLOW_STATE_MISSING', 'workflow filter state is missing')
    }
    const started = Date.now()
    const startedAt = now()
    data.steps[sourceStepId] = { status: 'running' }
    this.updateWorkflowNode(planId, sourceStepId, {
      status: 'running',
      timelineStepId: step.id,
      startedAt,
    }, correlationId)
    try {
      if (!(await workflowCondition(definition.when, data))) {
        data.steps[sourceStepId] = { status: 'skipped', output: [] }
        step.detail = { ...(step.detail ?? {}), workflowSkipped: true, reason: 'when evaluated to false' }
        this.updateWorkflowNode(planId, sourceStepId, {
          status: 'skipped',
          completedAt: now(),
          durationMs: Date.now() - started,
        }, correlationId)
        return
      }
      const input = await resolveWorkflowValue(definition.input, data)
      if (!Array.isArray(input)) throw new Error('workflow filter input must resolve to an array')
      const output = await filterWorkflowItems(input, definition.expression, data)
      const artifact = this.createArtifact(
        'workflow-result',
        `Workflow filter result · ${sourceStepId}`,
        output,
        correlationId,
      )
      data.steps[sourceStepId] = { status: 'completed', output }
      step.detail = {
        ...(step.detail ?? {}),
        expression: definition.expression,
        input: toJsonValue(input),
        inputCount: input.length,
        outputCount: output.length,
        resultArtifactId: artifact.id,
        resultPreview: artifact.preview,
      }
      this.updateWorkflowNode(planId, sourceStepId, {
        status: 'completed',
        outputArtifactId: artifact.id,
        completedAt: now(),
        durationMs: Date.now() - started,
      }, correlationId)
    } catch (error) {
      this.failGeneratedWorkflow(planId, sourceStepId, error, correlationId)
      throw new RuntimeStageError(
        'workflow_execution',
        'WORKFLOW_FILTER_FAILED',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  private async executeWorkflowTransform(step: TimelineStep, correlationId: string): Promise<void> {
    const planId = String(step.detail?.workflowPlanId ?? '')
    const sourceStepId = String(step.detail?.workflowSourceStepId ?? '')
    const definition = this.workflowDefinitions.get(planId)?.steps.find(item => item.id === sourceStepId && item.type === 'transform')
    const data = this.workflowData.get(planId)
    if (!definition || definition.type !== 'transform' || !data) throw new RuntimeStageError('workflow_execution', 'WORKFLOW_STATE_MISSING', 'workflow transform state is missing')
    const started = Date.now(), startedAt = now()
    data.steps[sourceStepId] = { status: 'running' }
    this.updateWorkflowNode(planId, sourceStepId, { status: 'running', timelineStepId: step.id, startedAt }, correlationId)
    try {
      if (!(await workflowCondition(definition.when, data))) {
        data.steps[sourceStepId] = { status: 'skipped', output: [] }
        step.detail = { ...(step.detail ?? {}), workflowSkipped: true, reason: 'when evaluated to false' }
        this.updateWorkflowNode(planId, sourceStepId, { status: 'skipped', completedAt: now(), durationMs: Date.now() - started }, correlationId)
        return
      }
      const input = await resolveWorkflowValue(definition.input, data)
      if (!Array.isArray(input)) throw new Error('workflow transform input must resolve to an array')
      const output = await transformWorkflowItems(input, definition.operator, definition.expression, definition.fields, data, definition)
      const artifact = this.createArtifact('workflow-result', `Workflow ${definition.operator} result · ${sourceStepId}`, output, correlationId)
      data.steps[sourceStepId] = { status: 'completed', output }
      step.detail = { ...(step.detail ?? {}), operator: definition.operator, inputCount: input.length, resultArtifactId: artifact.id, resultPreview: artifact.preview }
      this.updateWorkflowNode(planId, sourceStepId, { status: 'completed', outputArtifactId: artifact.id, completedAt: now(), durationMs: Date.now() - started }, correlationId)
    } catch (error) {
      this.failGeneratedWorkflow(planId, sourceStepId, error, correlationId)
      throw new RuntimeStageError('workflow_execution', 'WORKFLOW_TRANSFORM_FAILED', error instanceof Error ? error.message : String(error))
    }
  }

  private async executeWorkflowAssert(step: TimelineStep, correlationId: string): Promise<void> {
    const planId = String(step.detail?.workflowPlanId ?? '')
    const sourceStepId = String(step.detail?.workflowSourceStepId ?? '')
    const definition = this.workflowDefinitions.get(planId)?.steps.find(item => item.id === sourceStepId && item.type === 'assert')
    const data = this.workflowData.get(planId)
    if (!definition || definition.type !== 'assert' || !data) throw new RuntimeStageError('workflow_execution', 'WORKFLOW_STATE_MISSING', 'workflow assert state is missing')
    const started = Date.now(), startedAt = now()
    data.steps[sourceStepId] = { status: 'running' }
    this.updateWorkflowNode(planId, sourceStepId, { status: 'running', timelineStepId: step.id, startedAt }, correlationId)
    try {
      if (!(await workflowCondition(definition.when, data))) {
        data.steps[sourceStepId] = { status: 'skipped', output: false }
        step.detail = { ...(step.detail ?? {}), workflowSkipped: true, reason: 'when evaluated to false' }
        this.updateWorkflowNode(planId, sourceStepId, { status: 'skipped', completedAt: now(), durationMs: Date.now() - started }, correlationId)
        return
      }
      const input = await resolveWorkflowValue(definition.input, data)
      const passed = await assertWorkflowValue(input, definition.expression, data)
      if (!passed) throw new Error(`workflow assertion failed: ${definition.expression}`)
      const artifact = this.createArtifact('workflow-result', `Workflow assertion result · ${sourceStepId}`, { passed: true, expression: definition.expression }, correlationId)
      data.steps[sourceStepId] = { status: 'completed', output: { passed: true } }
      step.detail = { ...(step.detail ?? {}), expression: definition.expression, resultArtifactId: artifact.id, resultPreview: artifact.preview }
      this.updateWorkflowNode(planId, sourceStepId, { status: 'completed', outputArtifactId: artifact.id, completedAt: now(), durationMs: Date.now() - started }, correlationId)
    } catch (error) {
      this.failGeneratedWorkflow(planId, sourceStepId, error, correlationId)
      throw new RuntimeStageError('workflow_execution', 'WORKFLOW_ASSERT_FAILED', error instanceof Error ? error.message : String(error))
    }
  }

  private async executeWorkflowSchemaNode(step: TimelineStep, correlationId: string): Promise<void> {
    const planId = String(step.detail?.workflowPlanId ?? '')
    const sourceStepId = String(step.detail?.workflowSourceStepId ?? '')
    const definition = this.workflowDefinitions.get(planId)?.steps.find(item => item.id === sourceStepId)
    const data = this.workflowData.get(planId)
    if (!definition || !['parse', 'align', 'validate_schema', 'join'].includes(definition.type) || !data) {
      throw new RuntimeStageError('workflow_execution', 'WORKFLOW_STATE_MISSING', 'workflow schema node state is missing')
    }
    const started = Date.now()
    const startedAt = now()
    data.steps[sourceStepId] = { status: 'running' }
    this.updateWorkflowNode(planId, sourceStepId, { status: 'running', timelineStepId: step.id, startedAt }, correlationId)
    try {
      if (!(await workflowCondition(definition.when, data))) {
        data.steps[sourceStepId] = { status: 'skipped', output: null }
        step.detail = { ...(step.detail ?? {}), workflowSkipped: true, reason: 'when evaluated to false' }
        this.updateWorkflowNode(planId, sourceStepId, { status: 'skipped', completedAt: now(), durationMs: Date.now() - started }, correlationId)
        return
      }
      let output: unknown
      let detail: JsonObject = {}
      if (definition.type === 'parse') {
        const parseDefinition = definition as WorkflowParseStep
        const input = await resolveWorkflowValue(parseDefinition.input, data)
        const parsed = parseWorkflowValue(input, parseDefinition.operator)
        output = parsed
        detail = { operator: parsed.operator, status: parsed.status, ...(parsed.lineCount !== undefined ? { lineCount: parsed.lineCount } : {}), raw: toJsonValue(parsed.raw) }
      } else if (definition.type === 'align') {
        const alignDefinition = definition as WorkflowAlignStep
        const input = await resolveWorkflowValue(alignDefinition.input, data)
        const aligned = alignWorkflowRecords(input, alignDefinition.mappings, {
          sourceSchema: alignDefinition.sourceSchema,
          targetSchema: alignDefinition.targetSchema,
          auto: alignDefinition.auto,
        })
        output = aligned
        detail = { recordCount: aligned.records.length, unmappedRecordCount: aligned.unmappedFields.length, alignmentMode: aligned.alignment.mode, mappingHash: aligned.alignment.mappingHash }
      } else if (definition.type === 'validate_schema') {
        const validateDefinition = definition as WorkflowValidateSchemaStep
        const input = await resolveWorkflowValue(validateDefinition.input, data)
        const validated = validateWorkflowSchema(input, validateDefinition.schema, validateDefinition.schemaId)
        output = validated
        detail = { valid: true, ...(validated.schemaId ? { schemaId: validated.schemaId } : {}) }
      } else {
        const joinDefinition = definition as WorkflowJoinStep
        const left = await resolveWorkflowValue(joinDefinition.left, data)
        const right = await resolveWorkflowValue(joinDefinition.right, data)
        const joined = joinWorkflowRecords(left, right, joinDefinition)
        output = joined
        detail = { recordCount: joined.records.length, conflictCount: joined.conflicts.length, join: toJsonValue(joined.join) }
      }
      const artifact = this.createArtifact('workflow-result', `Workflow ${definition.type} result · ${sourceStepId}`, output, correlationId)
      data.steps[sourceStepId] = { status: 'completed', output }
      step.detail = { ...(step.detail ?? {}), ...detail, resultArtifactId: artifact.id, resultPreview: artifact.preview }
      this.updateWorkflowNode(planId, sourceStepId, { status: 'completed', outputArtifactId: artifact.id, completedAt: now(), durationMs: Date.now() - started }, correlationId)
    } catch (error) {
      this.failGeneratedWorkflow(planId, sourceStepId, error, correlationId)
      throw new RuntimeStageError('workflow_execution', 'WORKFLOW_SCHEMA_NODE_FAILED', error instanceof Error ? error.message : String(error))
    }
  }

  private async executeWorkflowForeach(
    step: TimelineStep,
    correlationId: string,
  ): Promise<void> {
    const planId = String(step.detail?.workflowPlanId ?? '')
    const sourceStepId = String(step.detail?.workflowSourceStepId ?? '')
    const definition = this.workflowDefinitions.get(planId)?.steps.find(
      (item) => item.id === sourceStepId && item.type === 'foreach',
    )
    const data = this.workflowData.get(planId)
    if (!definition || definition.type !== 'foreach' || !data) {
      throw new RuntimeStageError('workflow_execution', 'WORKFLOW_STATE_MISSING', 'workflow foreach state is missing')
    }
    const startedAt = now()
    const started = Date.now()
    data.steps[sourceStepId] = { status: 'running', output: [] }
    this.updateWorkflowNode(planId, sourceStepId, {
      status: 'running',
      timelineStepId: step.id,
      startedAt,
    }, correlationId)
    try {
      if (!(await workflowCondition(definition.when, data))) {
        data.steps[sourceStepId] = { status: 'skipped', output: [] }
        step.detail = { ...(step.detail ?? {}), workflowSkipped: true, reason: 'when evaluated to false' }
        this.updateWorkflowNode(planId, sourceStepId, {
          status: 'skipped',
          completedAt: now(),
          durationMs: Date.now() - started,
        }, correlationId)
        return
      }
      const input = await resolveWorkflowValue(definition.input, data)
      if (!Array.isArray(input)) throw new Error('workflow foreach input must resolve to an array')
      const maxItems = definition.maxItems ?? 20
      const selected = input.slice(0, maxItems)
      const output = selected.map(() => null)
      data.steps[sourceStepId] = { status: selected.length === 0 ? 'completed' : 'running', output }
      step.detail = {
        ...(step.detail ?? {}),
        inputCount: input.length,
        iterationCount: selected.length,
        truncated: input.length > selected.length,
      }
      if (selected.length === 0) {
        this.updateWorkflowNode(planId, sourceStepId, {
          status: 'completed',
          completedAt: now(),
          durationMs: Date.now() - started,
        }, correlationId)
        return
      }
      const itemName = definition.as ?? 'item'
      const nodes: RuntimeWorkflowNode[] = selected.map((_, index) => ({
        id: `${sourceStepId}[${index}]`,
        sourceStepId,
        parentId: sourceStepId,
        type: 'tool',
        toolName: definition.tool,
        iteration: index,
        status: 'pending',
      }))
      this.updateWorkflowPlan(planId, {
        nodes: [...this.workflowPlan(planId).nodes, ...nodes],
      }, correlationId)
      const childSteps = selected.map((item, index): TimelineStep => {
        const timelineStepId = `step-${planId}-${sourceStepId}-${index}`
        const callId = `call-${planId}-${sourceStepId}-${index}`
        this.pendingToolCalls.set(timelineStepId, {
          id: callId,
          name: definition.tool,
          arguments: definition.arguments,
          authorization: data.authorization,
        })
        return {
          id: timelineStepId,
          index: 0,
          type: 'tool',
          status: 'pending',
          summary: `${sourceStepId}[${index}] · ${definition.tool}`,
          detail: {
            workflowPlanId: planId,
            workflowNodeId: `${sourceStepId}[${index}]`,
            workflowSourceStepId: sourceStepId,
            workflowParentId: sourceStepId,
            workflowIteration: index,
            workflowNodeType: 'tool',
            workflowLocals: toJsonValue({ item, [itemName]: item, index }),
            callId,
            toolName: definition.tool,
            definition: toJsonValue(definition),
          },
        }
      })
      this.insertTimelineSteps(step.index, childSteps, correlationId)
      this.updateRuntimeStatus({ queueDepth: this.pendingToolCalls.size }, correlationId)
    } catch (error) {
      this.failGeneratedWorkflow(planId, sourceStepId, error, correlationId)
      throw new RuntimeStageError(
        'workflow_execution',
        'WORKFLOW_FOREACH_FAILED',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  private failGeneratedWorkflow(
    planId: string,
    nodeId: string,
    error: unknown,
    correlationId: string,
    recovery?: RuntimeWorkflowPlan['recovery'],
  ): void {
    const failure = toJsonValue({
      message: error instanceof Error ? error.message : String(error),
    })
    const plan = this.workflowPlan(planId)
    const completedAt = now()
    const suspended = !!recovery?.inputRequestId
    const nodes = plan.nodes.map((node) => {
      if (node.id === nodeId) return {
        ...node,
        status: suspended ? 'awaiting_input' as const : 'failed' as const,
        error: failure,
        completedAt: suspended ? undefined : completedAt,
      }
      if (node.status === 'pending' || node.status === 'running') return {
        ...node,
        status: 'cancelled' as const,
        completedAt,
      }
      return node
    })
    this.updateWorkflowPlan(planId, {
      status: suspended ? 'suspended' : 'failed',
      nodes,
      completedAt: suspended ? undefined : completedAt,
      error: failure,
      ...(recovery ? { recovery } : {}),
    }, correlationId)
  }

  private finalizeGeneratedWorkflow(step: TimelineStep, correlationId: string): void {
    const planId = String(step.detail?.workflowPlanId ?? '')
    const plan = this.workflowPlan(planId)
    const request = this.pendingWorkflowCalls.get(planId)
    const data = this.workflowData.get(planId)
    if (!request || !data) {
      throw new RuntimeStageError('workflow_execution', 'WORKFLOW_STATE_MISSING', 'workflow finalization state is missing')
    }
    const inputPending = plan.status === 'suspended'
    const workflowFailed = inputPending || plan.status === 'failed'
    const unfinished = Object.entries(data.steps).filter(([, value]) =>
      value.status !== 'completed' && value.status !== 'skipped' && value.status !== 'failed')
    if (!workflowFailed && unfinished.length > 0) {
      throw new RuntimeStageError(
        'workflow_execution',
        'WORKFLOW_INCOMPLETE',
        `workflow has unfinished steps: ${unfinished.map(([id]) => id).join(', ')}`,
      )
    }
    const identity = plan.recovery || plan.continuations?.length ? { workflowId: planId, ...(plan.recovery ? { recovery: plan.recovery } : {}) } : {}
    const result = workflowFailed
      ? { ok: false, goal: plan.goal, steps: data.steps, ...identity, ...(inputPending ? { status: 'awaiting_input' } : {}), error: plan.error ?? { message: 'workflow Tool failed' } }
      : { ok: true, goal: plan.goal, steps: data.steps, ...identity }
    const artifact = this.createArtifact(
      'workflow-result',
      `Generated workflow result · ${plan.revision}`,
      result,
      correlationId,
    )
    this.updateWorkflowPlan(planId, {
      status: workflowFailed ? plan.status : 'completed',
      resultArtifactId: artifact.id,
      completedAt: inputPending ? undefined : now(),
    }, correlationId)
    step.detail = {
      ...(step.detail ?? {}),
      resultArtifactId: artifact.id,
      resultPreview: artifact.preview,
      nodeCount: this.workflowPlan(planId).nodes.length,
      ...(this.workflowPlan(planId).compile ? { compile: toJsonValue(this.workflowPlan(planId).compile) } : {}),
    }
    this.appendRuntimeMessage({
      role: 'tool',
      name: request.name,
      toolCallId: request.id,
      content: this.boundedToolContent(artifact.id, result),
    })
    this.publishRenderedMessages(correlationId)
    const startedAt = plan.createdAt
    const completedAt = now()
    const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))
    const workflowFailureMessage = typeof plan.error === 'object' && plan.error && 'message' in plan.error
      ? String(plan.error.message)
      : 'workflow Tool failed'
    if (workflowFailed) {
      this.emit('tool.call.failed', {
        callId: request.id,
        toolName: request.name,
        code: inputPending ? 'WORKFLOW_INPUT_REQUIRED' : 'WORKFLOW_TOOL_FAILED',
        message: workflowFailureMessage,
        startedAt,
        completedAt,
        durationMs,
      }, correlationId)
    } else {
      this.emit('tool.call.completed', {
        callId: request.id,
        toolName: request.name,
        result: toJsonValue(result),
        startedAt,
        completedAt,
        durationMs,
      }, correlationId)
    }
    this.upsertObservation({
      id: `observation-${this.run.runId}-${request.id}`,
      runId: this.run.runId as string,
      stepId: step.id,
      callId: request.id,
      toolName: request.name,
      status: workflowFailed ? 'failed' : 'completed',
      arguments: toJsonValue(request.arguments),
      resultArtifactId: artifact.id,
      resultPreview: artifact.preview,
      ...(workflowFailed ? {
        error: toJsonValue({ code: inputPending ? 'WORKFLOW_INPUT_REQUIRED' : 'WORKFLOW_TOOL_FAILED', message: workflowFailureMessage }),
      } : {}),
      startedAt,
      completedAt,
      durationMs,
    }, correlationId)
    this.pendingWorkflowCalls.delete(planId)
  }

  private ensureContextHistorySession(sessionId: string): void {
    if (this.historySessionId === sessionId) return
    if (this.historySessionId && this.historySessionId !== sessionId) throw new Error('RUNTIME_SESSION_BINDING_MISMATCH')
    const store = this.projectContextStore.commits
    store.assertSessionActive(sessionId)
    const snapshot = this.contextHistory.snapshot()
    const persisted = store.readMessages(sessionId)
    const committed = store.lastCommit(sessionId)
    const session = store.loadDocument(sessionId)
    const current = this.contextDocumentEngine.snapshot()
    if (current.sessionId !== 'runtime' && current.sessionId !== sessionId) throw new Error('RUNTIME_SESSION_BINDING_MISMATCH')
    if (session) {
      this.contextDocumentEngine = new ContextDocumentEngine(session.document, session.receipts, session.projections, session.reviewReceipts, session.evidenceReviewReceipts)
    }
    if (!this.contextOrganization.enabled) { this.historySessionId = sessionId; return }
    // Merge only an exact append-only prefix. A longer snapshot does not gain authority.
    for (let index = 0; index < Math.min(persisted.length, snapshot.messages.length); index += 1) {
      if (JSON.stringify(persisted[index]) !== JSON.stringify(snapshot.messages[index])) throw new Error('CONTEXT_HISTORY_SNAPSHOT_CONFLICT')
    }
    const messages = [...persisted, ...snapshot.messages.slice(persisted.length)]
    if (!session && current.sessionId === sessionId) store.importSession(sessionId, this.contextDocumentEngine.exportState(), messages)
    this.contextHistory = new ContextHistory({ version: 1, messages,
      coverage: store.loadCoverage(sessionId) ?? committed?.history.coverage ?? { coveredThrough: 0, retainedMessageIds: [], receiptIds: [] } })
    for (const entry of snapshot.messages.slice(persisted.length)) store.appendMessage(sessionId, entry)
    this.historySessionId = sessionId
    if (!messages.length) {
      for (const [index, message] of this.llmMessages.filter((item) => item.role !== 'system').entries()) {
        this.contextHistory.append({ id: `legacy-history-${index}-${createHash('sha256').update(JSON.stringify(message)).digest('hex')}`,
          message, origin: message.role === 'tool' ? 'tool' : message.role === 'user' ? 'user' : message.name === CACHE_SUMMARY_MESSAGE_NAME ? 'runtime' : 'model' },
        (entry) => store.appendMessage(sessionId, entry))
      }
    }
    for (const entry of this.contextHistory.snapshot().messages) {
      if (entry.sourceArtifactMeta && entry.rawContent && !this.artifacts.has(entry.sourceArtifactMeta.id)) {
        const artifact = { meta: clone(entry.sourceArtifactMeta), value: JSON.parse(entry.rawContent) as JsonValue }
        this.artifacts.set(artifact.meta.id, artifact)
        this.artifactItems.push(artifact.meta)
      }
    }
    if (this.contextHistory.size) {
      const system = this.llmMessages.find((item) => item.role === 'system')
      this.llmMessages = [...(system ? [system] : []), ...this.contextHistory.project()]
    }
  }

  private appendContextHistory(message: LlmMessage, origin: ContextHistoryMessage['origin'], sourceArtifactId?: string, id?: string, runId = this.run.runId ?? undefined): void {
    if (!this.contextOrganization.enabled) return
    const sessionId = this.sessionId ?? this.contextDocumentEngine.snapshot().sessionId
    this.ensureContextHistorySession(sessionId)
    const observation = message.role === 'tool' ? [...this.observations].reverse().find((item) => item.callId === message.toolCallId && item.runId === runId) : undefined
    const artifact = this.artifacts.get(sourceArtifactId ?? observation?.resultArtifactId ?? '')
    this.contextHistory.append({ ...(id ? { id } : {}), ...(runId ? { runId } : {}), origin, message,
      ...(artifact ? { sourceArtifactId: artifact.meta.id, sourceArtifactMeta: artifact.meta, rawContent: JSON.stringify(artifact.value) } : {}) },
    (entry) => this.projectContextStore.commits.appendMessage(sessionId, entry))
  }

  private appendRuntimeMessage(message: LlmMessage, origin: ContextHistoryMessage['origin'] = message.role === 'tool' ? 'tool' : message.role === 'user' ? 'runtime' : 'model', sourceArtifactId?: string): void {
    this.appendContextHistory(message, origin, sourceArtifactId)
    this.llmMessages.push(message)
  }

  private finishOrganizationTraining(sampleId: string, history: ContextHistoryState,
    attempts: ReadonlyMap<LlmChatRequest, RecordedOrganizationAttempt>, result?: OrganizationResult, errorCode?: string): void {
    const outcome = result ? (result.receipts.length || result.archives.length ? 'committed' : 'no_change') : 'rejected'
    const operations: import('#core/context-training-recorder').ContextTrainingOperation[] = []
    for (const request of result?.requests ?? []) {
      for (const proposal of request.output.diffProposals) {
        const scope = proposal.scope
        const evidence = request.operationEvidence.get(proposal.idempotencyKey)!
        const observation = request.output.observations.find((item) => item.id === proposal.sourceObservationId)
        const content = proposal.body ?? (proposal.operation === 'add_entry' ? observation?.normalizedContent : undefined)
        const classification = proposal.classification ?? observation?.classification ?? evidence.classification
        operations.push({ scope, action: proposal.operation === 'add_entry' ? 'add' : proposal.operation === 'replace_body' ? 'replace' : proposal.operation === 'append_evidence' ? 'append' : proposal.operation,
          ...(proposal.diffVersion ? { diffVersion: proposal.diffVersion } : {}),
          ...((CONTEXT_TREE_OPERATIONS as readonly string[]).includes(proposal.operation) ? { structure: { title: proposal.title, parentNodeId: proposal.parentNodeId, beforeNodeId: proposal.beforeNodeId, childIds: proposal.childIds, targetNodeHash: proposal.targetNodeHash } } : {}),
          position: { section: 'information', ...(proposal.targetNodeId ?? proposal.targetEntryId ? { nodeId: proposal.targetNodeId ?? proposal.targetEntryId } : {}) },
          ...(content !== undefined ? { content } : {}), reason: '运行时已校验并持久化的文档整理提案',
          sourceRefs: observation?.sourceRefs ?? [evidence.sourceId], evidenceRefs: [...new Set(evidence.evidenceRefs)],
          ...(classification ? { classification } : {}),
        })
      }
    }
    this.contextTrainingRecorder.recordProposal(sampleId, { baseRevision: this.contextTrainingRecorder.get(sampleId)!.input.contextRevision, operations })
    this.contextTrainingRecorder.recordDecision(sampleId, {
      acceptedOperations: result?.receipts.filter(receipt => !receipt.unchanged).map(receipt => receipt.proposalId) ?? [], rejectedOperations: errorCode ? [sampleId] : [], archivedNodeIds: [], recallLinks: [],
      receipts: result?.receipts.map((receipt) => ({ kind: 'apply' as const, id: receipt.id, result: receipt.result, subjectId: receipt.proposalId,
        previousRevision: receipt.previousRevision, nextRevision: receipt.nextRevision, changedEntryIds: receipt.changedEntryIds, changedNodeIds: receipt.changedNodeIds,
        ...(receipt.unchanged ? { unchanged: true } : {}), createdAt: receipt.createdAt })) ?? [],
    })
    const validated = new Map(result?.requests.map(request => [request.input, request]))
    this.contextTrainingRecorder.attachOrganization(sampleId, {
      schemaVersion: 2, committed: outcome === 'committed', outcome, ...(outcome === 'committed' && result ? { commitId: result.id } : {}), ...(errorCode ? { errorCode } : {}),
      promptBindings: result?.promptBindings ?? v2PromptManifest([...attempts.values()].some(attempt => !attempt.referenceBinding)
        ? ['constitution', 'context-organizer'] : ['context-organizer']),
      attempts: [...attempts].map(([input, attempt]) => {
        const request = validated.get(input)
        const { artifactId, budgetScope, actorSessionId } = attempt.requestEvidence
        const transportAttempts = this.modelMeter?.store.requestAttempts(budgetScope, 'organize', artifactId, actorSessionId) ?? []
        return { ...attempt, requestEvidence: { ...attempt.requestEvidence, transportAttempts },
          ...(request && request.supervisionEligible !== false ? { proposal: request.modelProposal ?? request.output } : {}) }
      }),
      runtimeState: this.contextTrainingRecorder.get(sampleId)!.input.runtimeState, coverageBefore: history.coverage, coverageAfter: this.contextHistory.coverageSnapshot(),
      ...(result?.archives.length ? { sourceArchives: result.archives } : {}),
    })
    this.contextTrainingRecorder.complete(sampleId, { context: this.contextDocumentEngine.serialize(), contextRevision: this.contextDocumentEngine.snapshot().revision,
      projectContext: this.projectContextDocumentEngine.serialize(), projectContextRevision: this.projectContextDocumentEngine.snapshot().revision, archivedNodeIds: [], recallLinks: [] })
  }

  private recordOrganizationTrainingSafely(...args: Parameters<RuntimeLoop['finishOrganizationTraining']>): void {
    try { this.finishOrganizationTraining(...args) } catch (error) {
      this.createArtifact('runtime-error', 'Context training recording failed', { sampleId: args[0],
        canonicalOutcome: args[3] ? (args[3].receipts.length || args[3].archives.length ? 'committed' : 'no_change') : 'rejected',
        code: error instanceof Error ? error.message : String(error) })
    }
  }

  private organizerFileTaskInstructions(original: string): string {
    const { source } = this.template
    if (!isDefaultProjectMainTemplate(source)) return original
    const variables = this.variables.value
    try {
      if (this.environment.renderString(source, variables).trim() !== original) return original
      const { builtin, harnesses, skills } = variables
      const harnessVariables = { ...variables, request: variables.user_message, harnesses: [],
        builtin: { ...builtin, prompts: { ...builtin.prompts, dynamic_context: '' } } }
      const customHarnesses = harnesses.filter(harness => {
        const item = this.harnesses.items.find(item => item.id === harness.id)
        const bundled = bundledAuthoringHarnessTemplate(item?.metadata.source)
        return !bundled || this.environment.renderString(bundled, harnessVariables).trim() !== harness.content
      })
      return this.environment.renderString(source, { ...variables, tools: [], harnesses: customHarnesses,
        skills: { ...skills, catalog: [] } }).trim()
    } catch { return original }
  }

  private async organizeRuntimeContext(correlationId: string, generation: number): Promise<void> {
    const latestSequence = this.contextHistory.size
    if (!latestSequence || this.lastOrganizationAttemptSequence === latestSequence || this.pendingToolCalls.size || this.pendingWorkflowCalls.size) return
    const pending = this.contextHistory.pendingGroups()
    const minGroups = this.contextOrganization.minGroups ?? 8
    const rawHistory = this.contextHistory.project()
    const pressureLimit = this.availableInputTokens() * 0.25
    const settings = this.projectResources.readSettings()
    const version = settings.context_organization_version
    const fileProfile = version === 4 && settings.context_file_disposition_profile !== undefined
    const coverage = this.contextHistory.coverageSnapshot()
    const fileGroups = coverage.partialFileGroups ?? []
    const sessionId = this.sessionId ?? this.contextDocumentEngine.snapshot().sessionId
    const commits = this.projectContextStore.commits
    const original = (artifactId: string) => commits.readSource(artifactId, sessionId)
    let pressure = this.estimatedModelInputTokens(rawHistory, []) > pressureLimit
    const hasPages = fileProfile && rawHistory.some(message => message.name === 'read_runtime_artifact')
    const checkPartial = version === 4 && fileGroups.length > 0 && (pressure || hasPages)
    const checkCovered = hasPages && Boolean(coverage.excerptSources?.length)
    const coveredReads = fileProfile && coverage.excerptSources?.length && rawHistory.some(message => message.name === 'read_file')
      ? coverage.excerptSources : undefined
    const hasRecalls = fileProfile && rawHistory.some(message => message.name === 'recall_context')
    const documents = checkPartial || checkCovered || coveredReads || hasRecalls ? {
      session: this.contextDocumentEngine.snapshot(), project: this.projectContextStore.load().snapshot(),
    } : undefined
    const compact = version === 4 && ((pressure && (fileProfile || pending.length < minGroups)) || (hasPages && checkPartial) || coveredReads)
      ? projectFileHistory(rawHistory, documents?.session ?? this.contextDocumentEngine.snapshot(), original, documents ? { groups: fileGroups,
        project: documents.project,
        coveredReads,
        compactPages: fileProfile, currentRunId: this.run.runId ?? undefined,
        hasArchivedSpan: (id, start, end, hash, receipt) => commits.hasArchivedSpan(sessionId, id, start, end, hash, receipt) } : undefined) : undefined
    if (pressure && compact) pressure = this.estimatedModelInputTokens(compact.messages, []) > pressureLimit
    if (pending.length < minGroups && !pressure) return
    const history = this.contextHistory.snapshot()
    const firstPending = pending[0]?.firstSequence
    const assessedArtifacts = checkCovered && documents ? coveredFileArtifacts(coverage, documents) : new Set<string>()
    for (const group of fileGroups) if (compact?.verifiedPartialGroupIds.has(group.groupId)) {
      for (const file of group.files) assessedArtifacts.add(file.artifactId)
    }
    const retainedObservationIds = new Set(fileProfile ? history.messages.filter(item => item.origin === 'tool' && (
      (hasPages && (isVerifiedFileArtifactPage(item.message, assessedArtifacts, original) || isPagingInputDiagnostic(item.message)))
      || (hasRecalls && documents && isVerifiedActiveRecallCopy(item.message, documents, original))
    )).map(item => item.id) : [])
    const hasNewUser = history.messages.some(item => item.origin === 'user' && item.sequence > this.lastOrganizationAttemptSequence)
    // A failed organizer request must not be retried after every individual
    // tool result. Let a full batch of new groups accumulate, while still
    // allowing an explicit user turn to trigger immediate organization.
    const pendingSinceLastAttempt = this.lastOrganizationAttemptSequence < 0
      ? pending.length
      : pending.filter(group => group.firstSequence > this.lastOrganizationAttemptSequence).length
    if (this.lastOrganizationAttemptSequence >= 0 && !hasNewUser && pendingSinceLastAttempt < minGroups) return
    // Copies and paging feedback stay in the tool history. They do not restart Organizer.
    const requireNewEvidence = fileProfile && (!pressure || (retainedObservationIds.size > 0 && !hasNewUser))
    if (firstPending === undefined || !history.messages.some(item => item.sequence >= firstPending
      && (!requireNewEvidence || item.sequence > this.lastOrganizationAttemptSequence)
      && ((item.origin === 'tool' && !retainedObservationIds.has(item.id)
        && (!requireNewEvidence || (!isSuccessfulControlReceipt(item.message)
          && !compact?.repeatedReadCallIds.has(item.message.toolCallId ?? ''))))
        || (pressure && item.origin === 'model' && (!requireNewEvidence || item.message.content.trim().length > 0))))) return
    this.lastOrganizationAttemptSequence = latestSequence
    this.projectContextDocumentEngine = this.projectContextStore.load()
    const before = { project: this.projectContextDocumentEngine.exportState(), session: this.contextDocumentEngine.exportState() }
    const expectedSessionRevision = this.projectContextStore.commits.loadDocument(sessionId, { observe: false })?.document.revision ?? 0
    const sampleId = `context-organization-training-${randomUUID()}`
    const organizationRuntimeState = { task: clone(this.taskControl), control: clone(this.v2ControlState), role: this.childAgentMode ? 'child' : 'parent',
      frozenScopes: this.childAgentMode || assetWriteAudit(this.projectDir, 'context.policy.read').readonly ? ['project'] : [] }
    const originalSystemPrompt = this.renderResult.messages.find(message => message.role === 'system')?.content ?? ''
    this.contextTrainingRecorder.begin({ sampleId, task: 'context_organization', scope: 'session', projectId: before.session.document.projectId, sessionId,
      ...(this.run.runId ? { runId: this.run.runId } : {}), input: {
        projectContext: this.projectContextDocumentEngine.serialize(), projectContextRevision: before.project.document.revision,
        context: this.contextDocumentEngine.serialize(), contextRevision: before.session.document.revision,
        cache: history.messages.map((item) => ({ id: item.id, sourceArtifactId: item.sourceArtifactId, origin: item.origin })), rawCache: history,
        messages: history.messages.map((item) => ({ id: item.id, role: item.message.role, message: item.message.content, createdAt: item.capturedAt })),
        rawMessages: history.messages.map((item) => item.message), systemPrompt: originalSystemPrompt, runtimeState: organizationRuntimeState,
      } })
    const attempts = new Map<LlmChatRequest, RecordedOrganizationAttempt>()
    let committed = false
    const controller = new AbortController()
    this.activeAbortController = controller
    try {
      const fileDispositionProfile = !this.childAgentMode && settings.llm.profiles.find(profile => profile.id === settings.context_file_disposition_profile)
      const dedicatedFileProfile = version === 4 && !this.contextOrganization.llm && !this.contextAssistant.llm && fileDispositionProfile
      let fileAssessment: Parameters<typeof organizeContext>[0]['fileAssessment']
      if (dedicatedFileProfile) {
        const { id, provider, protocol, model, base_url, chat_template_tokenizer } = dedicatedFileProfile
        fileAssessment = { profileHash: capabilityHash({ id, provider, protocol, model, base_url, chat_template_tokenizer }),
          verifyGroups: groups => projectFileHistory(rawHistory, before.session.document,
            artifactId => commits.readSource(artifactId, sessionId), { groups, project: before.project.document,
              hasArchivedSpan: (messageId, start, end, hash, receiptId) => commits.hasArchivedSpan(sessionId, messageId, start, end, hash, receiptId),
            }).verifiedFileAssessmentGroupIds }
      }
      const result = await organizeContext({
        ...before, history, runtimeState: organizationRuntimeState,
        version,
        separateFileDispositions: !!fileDispositionProfile,
        fileDispositionBatch: dedicatedFileProfile ? dedicatedFileProfile.file_disposition_batch : undefined,
        ...(fileAssessment ? { fileAssessment } : {}),
        frozenScopes: organizationRuntimeState.frozenScopes,
        originalSystemPrompt,
        ...(version === 4 ? { fileTaskInstructions: this.organizerFileTaskInstructions(originalSystemPrompt),
          archivedSpanReceipt: span => commits.archivedSpanReceipt(sessionId, span.messageId, span.start, span.end, span.sourceHash) } : {}),
        ...(retainedObservationIds.size ? { retainedObservationIds } : {}),
        protectedMessageIds: history.messages.filter((item) => item.message.role === 'tool' && this.timeline.some((step) => hasUnknownToolOutcome(step) && step.detail?.callId === item.message.toolCallId)).map((item) => item.id),
        chunkCharacters: this.contextOrganization.chunkCharacters,
        maxOutputTokens: this.contextOrganization.maxOutputTokens ?? this.reservedOutputTokens,
        signal: controller.signal,
        ...(this.contextAssistantEnabled('normalize') && this.sessionId && this.run.runId ? {
          normalize: async (_snapshotId, sources) => {
            const input = { visibleSources: sources, sourceIds: sources.map(source => source.id),
              taskSignals: this.contextAssistantTaskSignals() }
            const review = await this.invokeContextAssistant('normalize', `normalize:${capabilityHash({ input, context: this.contextAssistantHash() })}`, correlationId, input, controller.signal)
            return review.output?.observations ?? []
          },
        } : {}),
        chat: async (request, referenceBinding, documentView) => {
          const bounded = { ...request, maxTokens: Math.min(request.maxTokens ?? this.reservedOutputTokens, this.reservedOutputTokens) }
          const llm = this.contextOrganization.llm ?? this.contextProcessingLlm(referenceBinding?.version === 4, settings)
          const { provider, protocol, model } = llm.getConfig()
          const promptBindings = v2PromptManifest(referenceBinding ? ['context-organizer'] : ['constitution', 'context-organizer'])
          const artifact = this.createArtifact('model-request', 'Context organizer input', toJsonValue({ ...bounded,
            provider, protocol, model, ...(referenceBinding ? { referenceBinding } : {}), promptBindings, documentView }), correlationId)
          const budgetScope = this.modelBudgetScope('organize')
          const actorSessionId = this.sessionId ?? budgetScope.sessionId
          const attempt: RecordedOrganizationAttempt = { messages: clone(bounded.messages), rawOutput: '',
            ...(referenceBinding ? { referenceBinding } : {}), requestEvidence: {
              artifactId: artifact.id, budgetScope, actorSessionId,
              inputHash: createHash('sha256').update(JSON.stringify(bounded.messages)).digest('hex'),
              promptBindings, organizationVersion: referenceBinding ? referenceBinding.version ?? 2 : 1, documentView,
              requestedModel: { provider, protocol, model }, maxOutputTokens: bounded.maxTokens,
              maxInputTokens: this.maxInputTokens, contextWindowTokens: this.contextWindowTokens,
              accounting: llm.admitsTransportAttempts ? 'provider_request' : 'request_view', transportAttempts: [],
            } }
          attempts.set(request, attempt)
          const response = await this.meteredLlm('organize', llm, { requestId: artifact.id, scope: budgetScope, actorSessionId }).chat(bounded)
          attempt.rawOutput = response.text
          this.addUsage(response.usage ?? {})
          const proposal = this.createArtifact('model-response', 'Context organizer proposal', toJsonValue({ text: response.text, usage: response.usage ?? {}, model: response.model }), correlationId)
          attempt.requestEvidence.response = { artifactId: proposal.id, provider: response.provider, model: response.model,
            ...(response.finishReason ? { finishReason: response.finishReason } : {}) }
          return response
        },
        projectGate: ({ classification, sourceMessage, engine }) => this.projectObservationGate({ scope: 'project', candidate: {
          source: { actor: sourceMessage.origin === 'user' ? 'user' : sourceMessage.origin === 'tool' ? 'tool' : 'model', sourceId: sourceMessage.id, capturedAt: sourceMessage.capturedAt },
          rawArtifactId: sourceMessage.sourceArtifactId ?? sourceMessage.id, normalizedContent: sourceMessage.message.content,
          ...(classification ? { classification } : {}),
        }, evidence: { kind: sourceMessage.origin === 'user' ? 'message' : 'artifact', referenceId: sourceMessage.sourceArtifactId ?? sourceMessage.id } }, engine),
        projectCandidateGate: ({ classification, evidenceRefs, engine }) => (this.childAgentMode || this.projectContextReadOnly)
          ? (this.childAgentMode ? 'CHILD_AGENT_PROJECT_CONTEXT_READONLY' : 'PROJECT_CONTEXT_READONLY')
          : this.projectAnchorAuthenticity(classification, evidenceRefs, engine.snapshot().evidence),
      })
      if (!result) {
        this.recordOrganizationTrainingSafely(sampleId, history, attempts, undefined, 'NO_CONTEXT_UPDATE_PROPOSED')
        return
      }
      if (!result.receipts.length && !result.archives.length) {
        this.recordOrganizationTrainingSafely(sampleId, history, attempts, result)
        return
      }
      if (this.generation !== generation || controller.signal.aborted || this.contextHistory.size !== latestSequence
        || this.contextDocumentEngine.snapshot().revision !== before.session.document.revision
        || this.projectContextDocumentEngine.snapshot().revision !== before.project.document.revision) throw new Error('CONTEXT_ORGANIZATION_SNAPSHOT_STALE')
      const projectChanged = result.project.document.revision !== before.project.document.revision
      if (this.projectContextReadOnly && projectChanged) throw new Error('PROJECT_CONTEXT_READONLY')
      this.projectContextStore.commits.commit({ ...result, sessionId, expectedProjectRevision: before.project.document.revision,
        expectedSessionRevision, projectChanged, receiptIds: [...result.receipts.map((item) => item.id), ...result.archives.map((item) => item.receiptId)] })
      committed = true
      this.projectContextDocumentEngine = new ContextDocumentEngine(result.project.document, result.project.receipts, result.project.projections, result.project.reviewReceipts, result.project.evidenceReviewReceipts)
      this.contextDocumentEngine = new ContextDocumentEngine(result.session.document, result.session.receipts, result.session.projections, result.session.reviewReceipts, result.session.evidenceReviewReceipts)
      this.contextHistory = new ContextHistory(result.history)
      this.recordOrganizationTrainingSafely(sampleId, history, attempts, result)
      const system = this.llmMessages.find((item) => item.role === 'system')
      this.llmMessages = [...(system ? [system] : []), ...this.contextHistory.project()]
      if (projectChanged) {
        this.projectContextStore.exportMirrors(this.projectContextDocumentEngine)
        if (this.projectContextStore.mirrorError) this.createArtifact('runtime-error', 'Context mirror export delayed', { canonicalStore: 'committed', error: this.projectContextStore.mirrorError }, correlationId)
      }
      this.createArtifact('context-diff', result.coverageAdvanced ? 'Context documents and coverage committed' : 'Context documents committed; history retained', toJsonValue({ commitId: result.id, coveredThrough: result.history.coverage,
        receiptIds: result.receipts.map((item) => item.id), archives: result.archives, promptBindings: result.promptBindings,
        before: { project: before.project.document.revision, session: before.session.document.revision }, after: { project: result.project.document.revision, session: result.session.document.revision } }), correlationId)
      for (const receipt of result.receipts) this.emit('runtime.context.v2.receipt.created', { receipt }, correlationId)
      this.syncSystemMessages(correlationId)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const code = error instanceof RuntimeModelBudgetError ? error.code : detail
      if (!committed && !this.contextTrainingRecorder.get(sampleId)?.organization) this.recordOrganizationTrainingSafely(sampleId, history, attempts, undefined, code)
      if (!controller.signal.aborted) this.createArtifact('runtime-error', committed ? 'Context committed; follow-up recording failed' : 'Context organization kept original history', toJsonValue({
        code, ...(detail !== code ? { detail } : {}), coveredThrough: history.coverage.coveredThrough,
      }), correlationId)
    } finally { if (this.activeAbortController === controller) this.activeAbortController = undefined }
  }

  private boundedModelMessages(
    system: LlmMessage,
    history: readonly LlmMessage[],
    tools: readonly LlmToolDefinition[],
  ): LlmMessage[] {
    const groups: LlmMessage[][] = []
    for (let index = 0; index < history.length;) {
      const message = history[index]
      if (!message || message.role === 'tool') {
        index += 1
        continue
      }
      if (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0) {
        const group: LlmMessage[] = [message]
        index += 1
        while (history[index]?.role === 'tool') {
          group.push(history[index] as LlmMessage)
          index += 1
        }
        const complete = discardOrphanToolMessages(group)
        if (complete.length > 0) groups.push(complete)
        continue
      }
      groups.push([message])
      index += 1
    }

    // Keep a small safety margin between history selection and the hard
    // request guard after the complete request envelope is serialized.
    const maxTokens = Math.max(
      0,
      Math.min(this.availableInputTokens(), this.runtimeStatus.context.maxTokens) - 128,
    )
    if (this.contextOrganization.enabled) {
      const complete = [system, ...groups.flat()]
      if (this.estimatedModelInputTokens(complete, tools) > maxTokens) throw new RuntimeStageError('runtime', 'CONTEXT_UNCOVERED_HISTORY_BUDGET', 'uncovered history and protected instructions do not fit; original observations are retained', false,
        { estimatedInputTokens: this.estimatedModelInputTokens(complete, tools), maxTokens, systemTokens: this.estimatedModelInputTokens([system], []), historyTokens: this.estimatedModelInputTokens(groups.flat(), []), schemaTokens: this.estimatedModelInputTokens([], tools) })
      return complete
    }
    let boundedSystem = system
    if (this.estimatedModelInputTokens([boundedSystem], tools) > maxTokens) {
      const fixedTokens = this.estimatedModelInputTokens([
        { role: 'system', content: '' },
      ], tools)
      const maxCharacters = Math.max(0, (maxTokens - fixedTokens) * 4)
      if (maxCharacters < boundedSystem.content.length) {
        const headCharacters = Math.floor(maxCharacters * 0.65)
        const tailCharacters = Math.max(0, maxCharacters - headCharacters)
        boundedSystem = {
          ...boundedSystem,
          content: `${boundedSystem.content.slice(0, headCharacters)}\n\n[context projection truncated]\n\n${tailCharacters > 0 ? boundedSystem.content.slice(-tailCharacters) : ''}`,
        }
      }
    }
    const selected: LlmMessage[] = []
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index] ?? []
      const candidate = [...group, ...selected]
      if (this.estimatedModelInputTokens([boundedSystem, ...candidate], tools) > maxTokens) break
      selected.unshift(...group)
    }
    return [boundedSystem, ...selected]
  }

  /** A reference already present verbatim in the active Skill needs one body.
   * Only the outbound view changes: immutable messages/artifacts retain it. */
  private projectSkillReferenceMessages(messages: readonly LlmMessage[], system: string, active: RuntimeVariables['skills']['active']): LlmMessage[] {
    const included = new Map(active.map(skill => [skill.id, skill.references]))
    const normalizedSystem = system.replace(/\r\n/g, '\n')
    return messages.map(message => {
      if (message.role !== 'tool' || message.name !== 'read_skill_resource') return message
      try {
        const value = JSON.parse(message.content)
        const result = value?.ok === true ? value.result : undefined
        if (!isObject(result) || typeof result.content !== 'string' || typeof result.hash !== 'string'
          || createHash('sha256').update(result.content).digest('hex') !== result.hash) return message
        const skill = this.skills.items.find(item => item.id === result.skillId && item.status === 'active')
        const reference = skill?.resources.find(item => item.path === result.path && item.kind === 'reference' && item.status === 'loaded')
        // The renderer normalizes line endings and trims the final template
        // newline. Hash/identity comparisons still use the untouched original.
        const renderedBody = result.content.replace(/\r\n/g, '\n').replace(/\n+$/, '')
        if (!skill?.sourceVersion || skill.sourceVersion !== result.skillVersion || !reference || reference.hash !== result.hash
          || reference.content !== result.content || typeof result.skillId !== 'string'
          || !included.get(result.skillId)?.some(item => item.path === result.path) || !normalizedSystem.includes(renderedBody)) return message
        const { content: _body, ...metadata } = result
        return { ...message, content: JSON.stringify({ ...value, result: { ...metadata, contentRef: 'active_skill_context' } }) }
      } catch { return message }
    })
  }

  private renderProjectPromptForSkills(skills: RuntimeVariables['skills'], projectedTools = this.modelToolDefinitions()): string {
    const allowed = new Set(projectedTools.map(tool => tool.name))
    const tools = this.variables.value.tools.filter(tool => allowed.has(tool.name))
    const attachments = new Map(this.harnesses.items.map(harness => [harness.id, harness]))
    const harnesses = this.variables.value.harnesses.filter(harness => {
      const attachment = attachments.get(harness.id)
      const required = attachment?.metadata.requiredTools
      if (Array.isArray(required) && required.some(name => typeof name !== 'string' || !allowed.has(name))) return false
      if (attachment?.metadata.source === '@system/harnesses/variable-authoring/variable-authoring.j2'
        && (!allowed.has('read_system_variables') || !allowed.has('apply_system_variable_changes'))) return false
      return !attachment?.bindings.length || attachment.bindings.some(binding => binding.source !== 'tool' || allowed.has(binding.sourceId))
    })
    return this.contextBuilder.preview({ skills, tools, harnesses }).trim()
  }

  private modelSkillVariables(items: SkillDefinition[]): RuntimeVariables['skills'] {
    const { catalog, active } = this.skillVariableValue(items)
    return { catalog: catalog.slice(0, 32).map(item => ({ ...item, description: item.description.slice(0, 160) })), active }
  }

  private projectModelSkillPrompt(prefix: string, items: SkillDefinition[], history: LlmMessage[], tools: LlmToolDefinition[], includeCatalog: boolean) {
    const { catalog, active } = this.modelSkillVariables(items)
    let directory = includeCatalog ? catalog : []
    const render = (selected: typeof active) => {
      const system = prefix + this.renderProjectPromptForSkills({ catalog: directory, active: selected }, tools)
      const messages = this.projectSkillReferenceMessages(history, system, selected)
      return { system, messages, selected, directoryCount: directory.length, tokens: this.estimatedModelInputTokens([{ role: 'system', content: system }, ...messages], tools) }
    }
    const minimumDocumentsAndBindings = 1024
    const limit = Math.min(this.availableInputTokens(), this.runtimeStatus.context.maxTokens) - minimumDocumentsAndBindings
    const all = render(active)
    if (all.tokens <= limit) return all
    let current = render([])
    if (current.tokens > limit && directory.length) {
      directory = []
      current = render([])
    }
    // Try each body with its references first. A reference can replace its
    // duplicate in history, so a body alone can be more expensive than both.
    for (const skill of active) {
      const complete = render([...current.selected, skill])
      if (complete.tokens <= limit) {
        current = complete
        continue
      }
      let included = { ...skill, references: [] as typeof skill.references }
      const body = render([...current.selected, included])
      if (body.tokens > limit) continue
      const previous = current.selected
      current = body
      for (const reference of skill.references) {
        const extended = { ...included, references: [...included.references, reference] }
        const attempt = render([...previous, extended])
        if (attempt.tokens <= limit) {
          current = attempt
          included = extended
        }
      }
    }
    return current
  }

  private retryControlTransport(step: TimelineStep, correlationId: string, maxRetries: number, responseArtifactId: string,
    intent: RuntimeControlDecision, malformedArguments = false): boolean {
    const code = intent === 'finish' ? 'RUNTIME_COMPLETION_TRANSPORT'
      : intent === 'ask_user' ? 'RUNTIME_HUMAN_REQUEST_TRANSPORT' : 'RUNTIME_CONTROL_TRANSPORT'
    step.detail = { ...step.detail, controlRejection: code }
    const instructions = {
      finish: 'Submit finish as a ControlEnvelopeV2 JSON response with the current request_binding, userMessage and completionCheck. Use existing tool results and action receipts. If obligations remain, choose the allowed decision that addresses them.',
      ask_user: 'Submit ask_user as a ControlEnvelopeV2 JSON response with the current request_binding. Use one ask_user action and bind the question to its active task in blockingTaskIds. If a question is already pending, continue independent work.',
      complete_plan_nodes: 'Submit complete_plan_nodes as a ControlEnvelopeV2 JSON response. Set planProposal to null and use planProgress with the current basePlanRevision and only active pending nodes. Cite their actual receipts.',
      propose_diff: 'Check recentContextEdits and the current document first. If the target already contains the requested change, use the existing receipt and finish any remaining obligation. For an edit outside the active node’s conditions, use propose_plan to add the edit node first. If the active node owns the change, submit propose_diff in one ControlEnvelopeV2 JSON object with current request and document bindings. Put all needed edits in one candidateDiffs array and bind each to its active planTaskId in planned work.',
    } as Partial<Record<RuntimeControlDecision, string>>
    const advice = instructions[intent]
      ?? `Submit ${intent} as a ControlEnvelopeV2 JSON response with the current request_binding. Use the fields required by the current output_schema. Preserve real tool results, the accepted plan and its obligations.`
    const retry = this.retryInvalidModelOutput(step, correlationId, maxRetries, responseArtifactId, '',
      `Control rejected (${code}). ${malformedArguments ? 'The native call had malformed arguments and did not run. ' : ''}${advice}`,
      true, malformedArguments || intent === 'propose_diff')
    if (retry && !malformedArguments && step.detail?.controlCarrierOffered !== true) {
      step.detail = { ...step.detail, offerControlCarrier: true }
    }
    return retry
  }

  private retryInactivePlanProgress(step: TimelineStep, correlationId: string, responseArtifactId: string,
    execution: RuntimeExecutionState): boolean {
    if (!execution.activeTaskIds.length) return false
    const code = 'RUNTIME_PLAN_PROGRESS_NODE_INACTIVE'
    const active = this.taskControl.tasks.filter(node => execution.activeTaskIds.includes(node.id))
      .map(({ id, title, capabilityIds }) => ({ id, title, capabilityIds }))
    step.detail = { ...step.detail, controlRejection: code }
    return this.retryInvalidModelOutput(step, correlationId, 3, responseArtifactId, '',
      `Node completion rejected (${code}). No node was changed. The active ${execution.phase} nodes are ${JSON.stringify(active)}. Use the next request's actual tools to do unfinished work on these nodes, loading an authorized capability if needed. Submit complete_plan_nodes for an active node only after its own conditions are supported. Any child result already consumed remains available for its later review node. Leave all other nodes pending until their phase is active. Use the new binding and plan revision.`)
  }

  private settledFileReadRefs(calls: readonly ToolCallRequest[], messages: readonly LlmMessage[]): Array<{ reference: string; artifactId?: string }> {
    if (calls.some(call => call.name !== 'read_file')) return []
    const completed = this.taskControl.tasks.filter(task => task.status === 'completed')
    if (!completed.length) return []
    const earlierCalls = new Map(messages.flatMap(message => message.toolCalls?.filter(call => call.name === 'read_file')
      .map(call => [call.id, call] as const) ?? []))
    const verified: Array<{ arguments: unknown; reference: string; artifactId?: string }> = []
    for (const step of this.timeline) {
      const receipt = step.detail?.executionReceipt
      if (step.type !== 'tool' || step.status !== 'success' || !isObject(receipt) || receipt.runId !== this.run.runId
        || receipt.toolName !== 'read_file' || receipt.status !== 'succeeded' || receipt.ok !== true || typeof receipt.callId !== 'string'
        || typeof receipt.completionActionRef !== 'string'
        || !isObject(receipt.capabilityBinding) || receipt.capabilityBinding.capabilityId !== 'project-files:read_file'
        || receipt.capabilityBinding.sideEffects !== 'none' || receipt.capabilityBinding.replay !== 'safe') continue
      const { activePlanTaskIds, completionActionRef } = receipt
      if (!Array.isArray(activePlanTaskIds) || !completed.some(task => activePlanTaskIds.includes(task.id)
        && task.requiredActions.includes(completionActionRef))) continue
      const call = earlierCalls.get(receipt.callId)
      if (call && messages.some(message => message.role === 'tool' && message.toolCallId === receipt.callId
        && message.name === 'read_file')) verified.push({ arguments: call.arguments, reference: completionActionRef,
        ...(typeof receipt.resultArtifactId === 'string' ? { artifactId: receipt.resultArtifactId } : {}) })
    }
    const refs = []
    for (const call of calls) {
      const hash = capabilityHash(call.arguments)
      const match = verified.find(item => capabilityHash(item.arguments) === hash
        || this.settledFileReadCovers(item, call.arguments))
      if (!match) return []
      refs.push({ reference: match.reference, artifactId: match.artifactId })
    }
    return refs
  }

  private settledFileReadCovers(prior: { arguments: unknown; artifactId?: string }, requested: unknown): boolean {
    const original = prior.arguments
    if (!this.sessionId || !prior.artifactId || !isObject(original) || !isObject(requested)
      || typeof requested.file_name !== 'string' || original.file_name !== requested.file_name
      || Object.keys(requested).some(key => !['file_name', 'start_line', 'end_line', 'include_line_numbers'].includes(key))
      || typeof requested.start_line !== 'number' || !Number.isSafeInteger(requested.start_line) || requested.start_line < 1
      || typeof requested.end_line !== 'number' || !Number.isSafeInteger(requested.end_line) || requested.end_line < requested.start_line
      || (requested.include_line_numbers !== undefined && typeof requested.include_line_numbers !== 'boolean')
      || (requested.include_line_numbers !== false) !== (original.include_line_numbers !== false)) return false
    const read = readVerifiedFileArtifact(prior.artifactId, id => this.projectContextStore.commits.readSource(id, this.sessionId!))
    if (!read || read.original.runId !== this.run.runId) return false
    const { start_line: start, end_line: end } = read.view.result
    return start <= requested.start_line && requested.start_line <= end
      && (requested.end_line <= end || original.end_line === undefined)
  }

  /** Match a repeated addition to an active entry and its original plan receipt. */
  private retryCommittedPlanAddition(step: TimelineStep, correlationId: string, maxRetries: number, responseArtifactId: string,
    diffs: unknown, activeTaskIds: readonly string[], outcomes: readonly ContextOutcomeAttempt[],
    visibleEntries: Readonly<Record<RuntimeContextScopeKind, readonly string[]>>): boolean {
    if (!Array.isArray(diffs) || diffs.length !== 1) return false
    const diff: unknown = diffs[0]
    if (!isObject(diff) || diff.operation !== 'add_entry' || (diff.scope !== 'session' && diff.scope !== 'project')
      || typeof diff.planTaskId !== 'string' || !activeTaskIds.includes(diff.planTaskId)
      || typeof diff.candidateId !== 'string'
      || !isObject(diff.target) || diff.target.section !== 'information' || diff.target.entryId || diff.target.nodeId
      || !isObject(diff.payload) || typeof diff.payload.body !== 'string' || !Array.isArray(diff.payload.evidenceRefs)
      || diff.payload.evidenceRefs.length === 0 || diff.payload.evidenceRefs.some(ref => typeof ref !== 'string')) return false
    const { scope, planTaskId, candidateId, target, payload } = diff
    const document = this.contextDocumentForScope(scope)
    if (diff.documentId !== document.id) return false
    const headingHash = capabilityHash(target.headingPath ?? [])
    const body = payload.body
    const evidenceHash = capabilityHash(payload.evidenceRefs)
    const classification = diff.classification ?? payload.classification
    if (classification !== undefined) {
      try { validateContextClassification(classification) } catch { return false }
    }
    const applied = outcomes.find(outcome => outcome.scope === scope && outcome.planTaskId === planTaskId
      && !outcome.replayed && !outcome.batchFailure && outcome.receipt.result === 'applied'
      && (outcome.receipt.nextRevision ?? 0) > outcome.receipt.previousRevision
      && outcome.proposal.documentId === document.id && outcome.proposal.operation === 'add_entry'
      && outcome.proposal.candidateId === candidateId && outcome.proposal.payload.body === body
      && capabilityHash(outcome.proposal.target.headingPath ?? []) === headingHash
      && document.information.some(entry => outcome.receipt.changedEntryIds.includes(entry.id) && visibleEntries[scope].includes(entry.id)
        && entry.status === 'active' && entry.body === body && entry.sourceCandidateIds.includes(candidateId)
        && capabilityHash(entry.evidenceRefs) === evidenceHash && capabilityHash(entry.headingPath) === headingHash
        && (classification === undefined || (entry.classification !== undefined
          && entry.classification.confidence === classification.confidence && sameContextPlacement(entry.classification, classification)))))
    if (!applied) return false
    const completionActionRef = `context:${applied.receipt.id}`
    if (this.contextPlanActionRefs().get(completionActionRef) !== planTaskId) return false
    const code = 'RUNTIME_CONTEXT_EDIT_ALREADY_APPLIED'
    step.detail = { ...step.detail, controlRejection: code, committedContextEdit: { planTaskId, completionActionRef } }
    if (this.retryInvalidModelOutput(step, correlationId, maxRetries, responseArtifactId, '',
      `Document edit already applied (${code}). The visible entry still matches the repeated addition. To accept the original node ${JSON.stringify(planTaskId)}, if its conditions are satisfied, submit complete_plan_nodes with actionRefs containing ${JSON.stringify(completionActionRef)} and the current plan revision. For remaining work choose the appropriate allowed decision. Use the current request binding. The repeated proposal made no new change.`, true)) return true
    throw new RuntimeStageError('model_protocol', code, 'the repeated addition is already committed; node verification remains pending', true)
  }

  private retryInvalidModelOutput(step: TimelineStep, correlationId: string, maxRetries: number, responseArtifactId: string,
    responseText: string, repairPrompt: string, controlOnly = false, controlPlainResponse = false): boolean {
    // Earlier repaired decisions do not spend the budget for this decision.
    let repairs = 0
    for (let index = step.index - 1; index >= 0; index -= 1) {
      const previous = this.timeline[index]
      if (previous?.type !== 'model') continue
      if (previous.detail?.outputRepair !== true) break
      repairs += 1
    }
    const limit = maxRetries === -1 ? -1 : Math.max(3, maxRetries)
    if ((limit !== -1 && repairs >= limit) || (this.maxToolRounds !== -1 && this.continuationRound >= this.maxToolRounds)) return false
    step.detail = { ...step.detail, outputRepair: true, outputRepairAttempt: repairs + 1,
      ...(controlOnly || controlPlainResponse ? { controlOnlyRepair: true } : {}),
      ...(controlPlainResponse ? { controlPlainResponse: true } : {}) }
    diagnosticLog('model.output_repair', { attempt: repairs + 1, maxAttempts: limit, responseArtifactId })
    if (responseText) this.appendRuntimeMessage({ role: 'assistant', name: OUTPUT_REPAIR_MESSAGE_NAME, content: responseText }, 'runtime')
    this.appendRuntimeMessage({ role: 'user', name: OUTPUT_REPAIR_MESSAGE_NAME, content: repairPrompt }, 'runtime')
    this.continuationRound += 1
    this.publishRenderedMessages(correlationId)
    this.insertContinuation(step.index, correlationId)
    this.updateRuntimeStatus({ model: 'ready' }, correlationId)
    return true
  }

  private planningReviewKey(execution: RuntimeExecutionState, userMessageId?: string): string {
    return capabilityHash({ runId: this.run.runId, taskId: this.taskControl.taskId, userMessageId,
      revision: execution.planRevision, phase: execution.phase, activeTaskIds: execution.activeTaskIds })
  }

  private outputBudgetForPhase(phase: RuntimeExecutionState['phase'], controlOnly: boolean): number {
    const configured = this.reservedOutputTokens
    if (configured <= 8_192) return configured
    const phaseBudget = STAGE_OUTPUT_BUDGETS[phase]
    return Math.min(configured, controlOnly ? STAGE_OUTPUT_BUDGETS.human_input : phaseBudget)
  }

  private reasoningContinuationRejection(index: number, authority: string, next: string): string | undefined {
    let consecutive = 0
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const prior = this.timeline[cursor]
      if (prior?.type !== 'model' || prior.status !== 'success') break
      if (prior.detail?.outputRepair === true) continue
      const reasoning = prior.detail?.reasoningContinuation
      if (!isObject(reasoning) || reasoning.authority !== authority) break
      if (reasoning.next === next) return 'RUNTIME_REASONING_STEP_REPEATED'
      consecutive += 1
    }
    if (consecutive >= 3) return 'RUNTIME_REASONING_CONTINUATION_LIMIT'
  }

  private async executeModelStep(
    step: TimelineStep,
    correlationId: string,
    generation: number,
  ): Promise<void> {
    this.reconcileChildAssignments()
    if (this.taskControl.branchBlocks?.length) {
      this.waits = this.getWaitStore().expire(this.waitBinding())
      this.settleBranchBlocks(correlationId)
    }
    this.refreshProjectLlm()
    if (this.v2ControlState.status === 'reflecting') await this.executePendingReflection(correlationId, generation)
    if (this.closed || this.generation !== generation) return
    this.updateRuntimeStatus({
      activity: { phase: 'model_preparing', label: step.summary, startedAt: now() },
    }, correlationId)
    const sanitizedMessages = discardOrphanToolMessages(this.llmMessages)
    if (JSON.stringify(sanitizedMessages) !== JSON.stringify(this.llmMessages)) {
      this.llmMessages = sanitizedMessages
      this.syncSystemMessages(correlationId)
    }
    if (this.contextOrganization.enabled) await this.organizeRuntimeContext(correlationId, generation)
    else await this.compressRuntimeCacheBeforeModel(correlationId, generation)
    if (this.generation !== generation) return
    const currentSettings = this.projectResources.readSettings()
    await this.mcp.prepare(currentSettings.mcp_servers)
    if (this.generation !== generation || this.closed) return
    this.reconcileWorkflowForms(correlationId)
    this.reloadProjectTools(currentSettings, correlationId)
    this.refreshCanonicalProjectContext()
    // The latest real user message is also a source for incremental document requests.
    // It remains a pending/accepted candidate, never an automatic factual conclusion.
    const latestUserId = this.contextHistory.latestUserId()
    const currentDocument = this.contextDocumentEngine.snapshot()
    if (latestUserId && !currentDocument.candidates.some((candidate) => candidate.source.actor === 'user' && candidate.source.sourceId === latestUserId)) {
      const source = this.contextHistory.snapshot().messages.find((message) => message.id === latestUserId)!
      const before = this.contextDocumentEngine.exportState()
      this.contextDocumentEngine.observe({ candidate: { source: { actor: 'user', sourceId: source.id, capturedAt: source.capturedAt }, rawArtifactId: source.id, normalizedContent: source.message.content },
        evidence: { kind: 'message', referenceId: source.id, sessionId: this.sessionId, sourceHash: createHash('sha256').update(source.message.content).digest('hex'), observedAt: source.capturedAt } })
      this.persistSessionContext(before)
    }
    const currentExecution = runtimeExecutionState(this.taskControl)
    const llm = this.meteredLlm(currentExecution.phase === 'planning' ? 'planning' : 'main')
    const llmConfig = llm.getConfig()
    this.ensureAssistantStarted(correlationId)
    const controller = new AbortController()
    this.activeAbortController = controller
    this.updateRuntimeStatus({
      model: 'busy',
      activity: { phase: 'model_waiting', label: step.summary, startedAt: now() },
    }, correlationId)
    const requestBinding = {
      sessionId: this.sessionId ?? '', taskId: this.taskControl.taskId,
      runId: this.run.runId ?? '', requestId: step.id, stateRevision: this.taskControl.stateRevision,
    }
    const previousModel = this.timeline.slice(0, step.index).reverse().find(item => item.type === 'model')
    const controlOnlyRepair = previousModel?.detail?.controlOnlyRepair === true
    const controlPlainResponse = controlOnlyRepair && previousModel?.detail?.controlPlainResponse === true
    const toolRoundsExhausted = this.maxToolRounds !== -1 && this.toolRound >= this.maxToolRounds
    const catalogCheckpoint = !controlOnlyRepair && !toolRoundsExhausted ? this.childCatalogCheckpoint(step.index) : undefined
    if (catalogCheckpoint) step.detail = { ...step.detail, catalogCheckpoint }
    this.syncV2DynamicSections()
    const projectDocument = this.projectContextDocumentEngine.snapshot()
    const sessionDocument = this.contextDocumentEngine.snapshot()
    const coverage = this.contextHistory.coverageSnapshot()
    const requiredEntries = coverage.requiredEntries ?? []
    const coveredExcerptArtifacts = coveredFileArtifacts(coverage, { project: projectDocument, session: sessionDocument })
    const missingExcerptArtifacts = new Set((coverage.excerptSources ?? []).map(source => source.artifactId).filter(id => !coveredExcerptArtifacts.has(id)))
    // The durable coverage boundary is authoritative whenever context
    // organization is enabled. `llmMessages` is an append-only working view
    // and may still contain groups that were covered by a previous commit if
    // an organizer attempt failed or a run was resumed from a stale view.
    // Project from ContextHistory so a failed follow-up organization cannot
    // re-expand the request with already-covered native tool transcripts.
    const retainedHistory: LlmMessage[] = this.contextOrganization.enabled
      ? this.contextHistory.project(missingExcerptArtifacts.size ? missingExcerptArtifacts : undefined)
      : missingExcerptArtifacts.size ? this.contextHistory.project(missingExcerptArtifacts)
        : this.llmMessages[0]?.role === 'system' ? this.llmMessages.slice(1) : this.llmMessages
    const rawHistory = retainedHistory.filter(message => message.name !== OUTPUT_REPAIR_MESSAGE_NAME)
    if (previousModel?.detail?.outputRepair === true) {
      for (let index = retainedHistory.length - 1; index >= 0; index -= 1) {
        const question = retainedHistory[index]!
        if (question.name !== OUTPUT_REPAIR_MESSAGE_NAME || question.role !== 'user') continue
        const prior = retainedHistory[index - 1]
        if (prior?.role === 'assistant' && prior.name === OUTPUT_REPAIR_MESSAGE_NAME) rawHistory.push({ role: prior.role, content: prior.content })
        rawHistory.push({ role: question.role, content: question.content })
        break
      }
    }
    if (catalogCheckpoint) rawHistory.push({ role: 'user',
      content: `Catalog checkpoint. The exact match and its successful receipt are visible (${JSON.stringify(catalogCheckpoint)}). If the local task is satisfied, use finish with the result and this receipt. Keep a short userMessage for a simple lookup. If another item is needed, use continue and name it in reasoningNextStep.`,
    })
    const commits = this.projectContextStore.commits
    const readOriginal = (artifactId: string) => commits.readSource(artifactId, sessionDocument.sessionId)
    let fileHistory = this.contextOrganization.enabled && currentSettings.context_organization_version === 4
      ? projectFileHistory(rawHistory, sessionDocument, readOriginal, { groups: coverage.partialFileGroups ?? [], project: projectDocument,
        ...(currentSettings.context_file_disposition_profile ? { coveredReads: coverage.excerptSources, compactPages: true, currentRunId: requestBinding.runId } : {}),
        hasArchivedSpan: (messageId, start, end, sourceHash, receiptId) =>
          commits.hasArchivedSpan(sessionDocument.sessionId, messageId, start, end, sourceHash, receiptId) }) : undefined
    const previousReply = !previousModel && this.messages.slice().reverse().find(message => message.role === 'assistant'
      && message.requestId !== requestBinding.runId)
    const canReviewPreviousFiles = !!previousReply && previousReply.status === 'completed'
    const fileEvidenceCheckpoint = !controlOnlyRepair && !catalogCheckpoint && !toolRoundsExhausted && !this.taskControl.tasks.length
      && currentExecution.phase === 'direct'
      && !this.timeline.some(item => item.index < step.index && typeof item.detail?.fileEvidenceCheckpointId === 'string')
      ? fileHistory?.hasPartialViews && currentSettings.context_file_disposition_profile
        ? [...coverage.partialFileGroups ?? []].reverse().find(group => fileHistory?.verifiedPartialGroupIds.has(group.groupId)
          && (canReviewPreviousFiles || group.files.every(file => readOriginal(file.artifactId)?.runId === requestBinding.runId)))?.groupId
        : visibleFileBatch(rawHistory, readOriginal, canReviewPreviousFiles ? undefined : requestBinding.runId,
          this.contextOrganization.chunkCharacters ?? DEFAULT_CONTEXT_ORGANIZATION_CHUNK_CHARACTERS)
      : undefined
    if (fileEvidenceCheckpoint) step.detail = { ...step.detail, fileEvidenceCheckpointId: fileEvidenceCheckpoint }
    const editOutcomes = commits.readRecentModelOutcomes(requestBinding)
    const activeIds = currentExecution.activeTaskIds
    const documentExecution = currentExecution.phase === 'execution' && activeIds.length > 0
      && this.taskControl.tasks.every(node => !activeIds.includes(node.id) || !node.capabilityIds.length)
    const editReceiptReview = !controlOnlyRepair && previousModel?.status === 'success' && documentExecution
      ? (() => {
          const actions = this.contextPlanActionRefs()
          return editOutcomes.flatMap(({ requestBinding: origin, planTaskId, receipt, replayed, batchFailure }) => {
            const reference = `context:${receipt.id}`
            return origin?.requestId === previousModel.id && planTaskId && activeIds.includes(planTaskId) && !replayed && !batchFailure
              && actions.get(reference) === planTaskId ? [{ planTaskId, completionActionRef: reference }] : []
          })
        })() : []
    if (editReceiptReview.length) step.detail = { ...step.detail, editReceiptReview }
    const planReview = !controlOnlyRepair && currentExecution.allowedDecisions.includes('resume_plan')
    const controlOnlyRequest = controlOnlyRepair || !!catalogCheckpoint || !!fileEvidenceCheckpoint || editReceiptReview.length > 0 || planReview
    const outputBudget = this.outputBudgetForPhase(currentExecution.phase, controlOnlyRequest)
    const documentControl = !controlOnlyRequest && documentExecution && currentExecution.allowedDecisions.includes('propose_diff')
    const controlCarrier = llmConfig.provider === 'deepseek' && llmConfig.protocol === 'chat-completions'
      && Boolean(documentControl || catalogCheckpoint || fileEvidenceCheckpoint || editReceiptReview.length || planReview
        || (controlOnlyRepair && previousModel?.detail?.offerControlCarrier === true))
    if (controlCarrier) step.detail = { ...step.detail, controlCarrierOffered: true }
    // Control-only requests retain the same phase and evidence, with no tool authorization.
    const capabilityPool = controlOnlyRequest || toolRoundsExhausted ? [] : this.availableToolCapabilities()
    const capabilityProjection = projectRuntimeCapabilities(this.taskControl, requestBinding, capabilityPool)
    const projectedNames = new Set(capabilityProjection.bindings.map(binding => binding.name))
    const modelTools = capabilityPool.filter(capability => projectedNames.has(capability.name)).map(capability => capability.definition)
    let requestTools = controlCarrier ? [...modelTools, CONTROL_CARRIER] : modelTools
    const stageSkills = controlOnlyRequest || toolRoundsExhausted ? [] : this.phaseSkills(capabilityProjection.execution)
    const controlNotices: LlmMessage[] = []
    if (fileEvidenceCheckpoint) controlNotices.push({ role: 'user',
      content: 'File evidence checkpoint. Read result.lines and the published rows in Session Context named by contextLines. Separate each source’s claim, conditions and what it actually observed. If a source does not establish whether a condition was met, report that as unknown when the user asks for known facts. If the visible sources support delivery, use finish with only current-run actions ([] when none ran). Use continue only for a missing source range or action required for delivery, and name it exactly.',
    })
    if (editReceiptReview.length) controlNotices.push({ role: 'user',
      content: `Document edit checkpoint. These receipts were just committed: ${JSON.stringify(editReceiptReview)}. If the edit satisfies its node, use complete_plan_nodes and set actionRefs to the listed completionActionRef values for that node. Proof gathered on other nodes can support the content; omit their action receipts. If an additional action is required, use continue and name it.`,
    })
    if (planReview) controlNotices.push({ role: 'user',
      content: 'An accepted plan is already available. Use resume_plan to return to its current work, with empty userMessage and no plan proposal. For a specific new node or additional capability or dependency use propose_plan with planAmendment in this round. After resuming, settle ready nodes with their own receipts.',
    })
    if (controlCarrier) controlNotices.push({ role: 'user',
      content: documentControl
        ? `Project Context and Session Context are the managed documents. Use their projected headings, entries and candidate evidence for edits. Adding content can create a missing heading path. To submit a control decision, use one ${CONTROL_CARRIER.name} call with the current envelope. Run native observation tools in a separate response.`
        : `Send the control decision through one ${CONTROL_CARRIER.name} call. Its envelope must follow output_schema with the current binding. Use an allowed decision; the call itself executes no tool and confers no authority.`,
    })
    const locateFileEvidence = fileHistory ? createFileEvidenceResolver((id, sessionId) => commits.readSource(id, sessionId)) : undefined
    const fileLocation = (evidence: ContextDocument['evidence'][number], document: ContextDocument, scope: RuntimeContextScopeKind) => {
      const excerpt = locateFileEvidence?.(evidence, document.sessionId, scope)
      return excerpt && { file: excerpt.file, line: excerpt.line }
    }
    const showNativeFileQuotes = rawHistory.some(message => message.role === 'tool'
      && (message.name === 'read_file' || (message.name === 'read_runtime_artifact' && message.content.includes('"mode":"file_lines"'))))
    let prefix = this.v2SystemPrompt('', requestBinding, capabilityProjection, fileHistory, editOutcomes, showNativeFileQuotes)
    const excludedCandidateIds = sessionDocument.candidates.filter(candidate => candidate.status === 'pending'
      && candidate.source.actor === 'tool' && candidate.source.toolName === 'read_file'
      && coveredExcerptArtifacts.has(candidate.rawArtifactId)).map(candidate => candidate.id)
    const recalledCandidates = sessionDocument.candidates.filter((candidate) => candidate.source.actor === 'memory'
      && candidate.source.sourceId.startsWith('recall:') && candidate.status === 'pending').map((candidate) => candidate.id)
    const currentUserCandidate = sessionDocument.candidates.filter((candidate) => candidate.source.actor === 'user' && candidate.source.sourceId === latestUserId).at(-1)
    const instruction = currentUserCandidate?.normalizedContent.normalize('NFKC').toLowerCase()
    const pinnedHeadings = (document: ContextDocument, scope: RuntimeContextScopeKind) => {
      const created = new Set(editOutcomes.filter(({ scope: editScope, proposal, receipt }) => editScope === scope
        && proposal.documentId === document.id && proposal.operation === 'add_heading' && receipt.result === 'applied')
        .flatMap(({ proposal, receipt }) => (receipt.changedNodeIds ?? []).filter(id => id !== proposal.target.nodeId)))
      return document.tree?.headings.filter(heading => created.has(heading.id)
        || instruction?.includes(heading.title.normalize('NFKC').toLowerCase())).map(heading => heading.id) ?? []
    }
    const pinnedProjectHeadings = pinnedHeadings(projectDocument, 'project')
    const pinnedSessionHeadings = pinnedHeadings(sessionDocument, 'session')
    const hasProjectContext = pinnedProjectHeadings.length > 0 || projectDocument.information.some((entry) => entry.status === 'active')
      || projectDocument.candidates.some((candidate) => candidate.status === 'pending' || candidate.status === 'conflict')
    const assemble = (items: SkillDefinition[], includeCatalog: boolean, serializationReserve: number) => {
      const activeRequired = [...requiredEntries, ...(fileHistory?.requiredEntries ?? [])]
      const pinnedProject = projectDocument.information.filter((entry) => entry.status === 'active' && activeRequired.some((item) => item.scope === 'project' && item.id === entry.id)).map((entry) => entry.id)
      const pinnedSession = sessionDocument.information.filter((entry) => entry.status === 'active' && activeRequired.some((item) => item.scope === 'session' && item.id === entry.id)).map((entry) => entry.id)
      const skills = this.projectModelSkillPrompt(prefix, items, [...(fileHistory?.messages ?? rawHistory), ...controlNotices], requestTools, includeCatalog)
      this.setV2StaticSections(skills.system)
      // Reserve full uncovered history, actual tool schemas and the selected
      // system prompt before allocating the two document views.
      const projectionBudgetTokens = Math.max(128, this.availableInputTokens() - skills.tokens - 512 - serializationReserve)
      const projectBudgetTokens = hasProjectContext ? Math.max(64, Math.floor(projectionBudgetTokens * 0.25)) : 64
      const sessionBudgetTokens = Math.max(128, projectionBudgetTokens - projectBudgetTokens)
      const project = this.projectContextDocumentEngine.project({
        id: 'runtime-project-context',
        includeStructure: true,
        compactReferences: fileHistory !== undefined,
        fileEvidenceLocation: evidence => fileLocation(evidence, projectDocument, 'project'),
        maxCharacters: Math.max(512, projectBudgetTokens * 4),
        includeTools: false,
        includeSections: ['information', 'candidates'],
        pinnedEntryIds: pinnedProject,
        pinnedHeadingIds: pinnedProjectHeadings,
        sectionOrder: ['information', 'candidates', 'messages', 'system', 'tools'],
      })
      const session = this.contextDocumentEngine.project({
        id: 'runtime-model',
        includeStructure: true,
        compactReferences: fileHistory !== undefined,
        fileEvidenceLocation: evidence => fileLocation(evidence, sessionDocument, 'session'),
        maxCharacters: Math.max(512, Math.min(10_000_000, sessionBudgetTokens * 4)),
        includeTools: false,
        includeSections: ['information', 'candidates'],
        pinnedEntryIds: pinnedSession,
        pinnedHeadingIds: pinnedSessionHeadings,
        excludeCandidateIds: excludedCandidateIds,
        ...(fileHistory ? { candidateBodyReferences: fileHistory.bodyReferences, resourceLoadCandidateIds: fileHistory.resourceLoadCandidateIds } : {}),
        pinnedCandidateIds: [...recalledCandidates, ...(currentUserCandidate && ['pending', 'accepted'].includes(currentUserCandidate.status) ? [currentUserCandidate.id] : [])],
        sectionOrder: ['system', 'messages', 'information', 'candidates', 'tools'],
      })
      const documentBinding = (scope: RuntimeContextScopeKind, documentId: string, projection: typeof session) =>
        `<!-- capybara:context-binding data=${JSON.stringify({ scope, documentId, baseRevision: projection.documentRevision, projectionId: projection.id, projectionHash: projection.contentHash })} -->`
      const compatibilityMarker = (name: string, projection: typeof session) => fileHistory ? ''
        : `\n\n<!-- capybara:${name} id=${projection.id} revision=${projection.documentRevision} hash=${projection.contentHash} -->`
      const content = `${skills.system}\n\n# Project Context\n${documentBinding('project', projectDocument.id, project)}\n${project.markdown}${compatibilityMarker('project-projection', project)}\n\n# Session Context\n${documentBinding('session', sessionDocument.id, session)}\n${session.markdown}${compatibilityMarker('projection', session)}`
      const missingRequired = pinnedProject.some(id => !project.sourceEntryIds.includes(id)) || pinnedSession.some(id => !session.sourceEntryIds.includes(id))
      return { skills, project, session, content, missingRequired }
    }
    const maxRequestInput = Math.min(this.availableInputTokens(), this.runtimeStatus.context.maxTokens) - 256
    const fitDocuments = (items: SkillDefinition[], includeCatalog: boolean) => {
      let reserve = 0
      let view = assemble(items, includeCatalog, reserve)
      let overrun = this.estimatedModelInputTokens([{ role: 'system', content: view.content }, ...view.skills.messages], requestTools) - maxRequestInput
      // Markdown character limits do not account for string escapes in the
      // actual JSON request. Redistribute that documented excess once more.
      for (let attempt = 0; attempt < 2 && overrun > 0 && !view.missingRequired; attempt++) {
        reserve += overrun + 64
        view = assemble(items, includeCatalog, reserve)
        overrun = this.estimatedModelInputTokens([{ role: 'system', content: view.content }, ...view.skills.messages], requestTools) - maxRequestInput
      }
      return { ...view, overrun }
    }
    const fit = () => {
      const assembled = fitDocuments(stageSkills, true)
      return (assembled.skills.selected.length || assembled.skills.directoryCount) && (assembled.missingRequired || assembled.overrun > 0)
        ? fitDocuments([], false) : assembled
    }
    let assembled = fit()
    // Keep the capability names, argument schemas and authorization bindings
    // exact. Only long prose descriptions are shortened when the complete
    // request is over the input budget. This lets a parent review a long
    // child result without dropping the actual tool contract.
    if (assembled.overrun > 0 && requestTools.length > 0) {
      const compacted = requestTools.map(tool => ({
        ...tool,
        description: tool.description.length <= 160 ? tool.description : `${tool.description.slice(0, 144)}…`,
        parameters: compactToolSchema(tool.parameters) as typeof tool.parameters,
      }))
      if (compacted.some((tool, index) => tool.description !== requestTools[index]!.description
        || JSON.stringify(tool.parameters) !== JSON.stringify(requestTools[index]!.parameters))) {
        requestTools = compacted
        assembled = fit()
      }
    }
    if (fileHistory?.hasPartialViews && (assembled.missingRequired || assembled.overrun > 0)) {
      fileHistory = projectFileHistory(rawHistory, sessionDocument, readOriginal)
      prefix = this.v2SystemPrompt('', requestBinding, capabilityProjection, fileHistory, editOutcomes, showNativeFileQuotes)
      assembled = fit()
    }
    if (assembled.missingRequired) throw new RuntimeStageError('runtime', 'CONTEXT_REQUIRED_INFORMATION_NOT_PROJECTED', 'active information that replaced history cannot fit the projection; source data remains stored')
    const { project: projectProjection, session: v2Projection, skills: skillView } = assembled
    const modelMessages = this.boundedModelMessages({ role: 'system', content: assembled.content }, skillView.messages, requestTools)
    const request: LlmChatRequest = {
      messages: modelMessages,
      tools: requestTools,
      responseFormat: requestTools.length || controlPlainResponse ? 'text' : 'json',
      maxTokens: outputBudget,
      ...(this.sessionId
        ? {
            clientMetadata: {
              sessionId: this.sessionId,
              threadId: this.sessionId,
              ...(this.run.runId ? { turnId: this.run.runId } : {}),
            },
          }
        : {}),
      signal: controller.signal,
    }
    let lastRetry: LlmRetryNotification | undefined
    Object.defineProperty(request, 'onRetry', {
      enumerable: false,
      value: (retry: LlmRetryNotification) => {
        try {
        lastRetry = retry
        process.stderr.write(`CAPYBARA_MODEL_RETRY ${JSON.stringify({
          timestamp: now(), runId: this.run.runId, stepId: step.id,
          kind: retry.kind ?? 'request_retry',
          phase: retry.phase, attempt: retry.attempt, maxAttempts: retry.maxAttempts,
          delayMs: retry.delayMs, excludedMs: retry.excludedMs ?? null,
          statusCode: retry.statusCode ?? null,
          profileId: retry.profileId ?? null,
          provider: retry.provider ?? null,
          model: retry.model ?? null,
          nextProfileId: retry.nextProfileId ?? null,
          nextProvider: retry.nextProvider ?? null,
          nextModel: retry.nextModel ?? null,
          reason: retry.reason,
        })}\n`)
        if (this.generation === generation) {
          this.updateModelRetry(step.id, retry, correlationId)
          this.createArtifact('hook-log', `Model request retry · ${step.summary}`, { stepId: step.id, ...retry }, correlationId)
        }
        } catch { /* Observers cannot interrupt a retry. */ }
      },
    })
    Object.defineProperty(request, 'validateResponse', {
      enumerable: false,
      value: (candidate: LlmChatResponse): ReturnType<NonNullable<LlmChatRequest['validateResponse']>> => {
        if ((candidate.toolCalls?.length ?? 0) > 0) return undefined
        if (!candidate.text.trim()) return 'response contains no text or tool calls'
        try {
          parseModelOutput(candidate.text)
          return undefined
        } catch (error) {
          if (error instanceof CompletionProposalError || error instanceof ContextDiffProposalError || error instanceof ControlEnvelopeFieldError
            || error instanceof ControlPayloadError) return { recovery: 'runtime' }
          if (controlOnlyRequest && PRINTED_TOOL_CALLS.test(candidate.text.trim())) return { recovery: 'runtime' }
          if (capabilityProjection.execution.allowedDecisions.includes('finish') && isStructuredReplyDraft(candidate.text)) return { recovery: 'runtime' }
          return error instanceof Error ? error.message : String(error)
        }
      },
    })
    const nativeStream = llm.stream !== undefined
    const requestArtifact = this.createArtifact(
      'model-request',
      `Model request · step ${step.index + 1}`,
      {
        provider: llmConfig.provider,
        protocol: llmConfig.protocol,
        model: request.model ?? llmConfig.model,
        stream: nativeStream,
        responseFormat: request.responseFormat ?? 'text',
        maxOutputTokens: request.maxTokens,
        promptBindings: v2PromptManifest(this.childAgentMode ? ['constitution', 'runtime', 'child-agent'] : ['constitution', 'runtime']),
        capabilityProjection: toJsonValue(capabilityProjection),
        ...(this.skillCatalog.length ? { skillProjection: toJsonValue({
          phase: capabilityProjection.execution.phase,
          activeTaskIds: capabilityProjection.execution.activeTaskIds,
          catalogCount: this.skillCatalog.length,
          projectedCatalogCount: skillView.directoryCount,
          eligibleIds: stageSkills.map(skill => skill.id),
          selected: skillView.selected.map(skill => ({ id: skill.id, version: stageSkills.find(item => item.id === skill.id)?.sourceVersion,
            references: skill.references.map(ref => ({ path: ref.path, hash: createHash('sha256').update(ref.content).digest('hex') })) })),
        }) } : {}),
        contextRevisionId: this.activeContextRevisionId ?? null,
        messages: request.messages,
        tools: request.tools ?? [],
      },
      correlationId,
    )
    const effectiveContext = this.captureEffectiveContext(
      step,
      request,
      requestArtifact.id,
      correlationId,
    )
    const estimatedInputTokens = Math.ceil(JSON.stringify({
      messages: request.messages,
      tools: request.tools ?? [],
    }).length / 4)
    const maxTokens = this.runtimeStatus.context.maxTokens
    this.updateRuntimeStatus({
      context: {
        usedTokens: estimatedInputTokens,
        maxTokens,
        utilization: Math.min(estimatedInputTokens / maxTokens, 1),
      },
    }, correlationId)
    if (estimatedInputTokens > maxTokens) {
      throw new RuntimeStageError(
        'runtime',
        'CONTEXT_WINDOW_EXCEEDED',
        `model input requires ${estimatedInputTokens} tokens but the configured limit is ${maxTokens}; only builtin.cache is compressible`,
      )
    }
    const actualSystem = request.messages.find((message) => message.role === 'system')?.content ?? ''
    const publications: ContextPublication[] = []
    if (projectProjection && actualSystem.includes(projectProjection.markdown)) publications.push({ scope: 'project', state: this.projectContextDocumentEngine.exportState(), projection: projectProjection })
    if (actualSystem.includes(v2Projection.markdown)) publications.push({ scope: 'session', state: this.contextDocumentEngine.exportState(), projection: v2Projection })
    const modelPublicationId = JSON.stringify([requestBinding.runId, requestBinding.requestId])
    this.persistPublishedProjections('model', modelPublicationId, publications)
    this.updateRuntimeStatus({ model: 'busy', activity: { phase: 'model_waiting', label: step.summary, startedAt: now() } }, correlationId)
    const requestStarted = Date.now()
    let firstDeltaAt: number | undefined
    let streamChunks = 0
    step.detail = {
      ...(step.detail ?? {}),
      requestArtifactId: requestArtifact.id,
      effectiveContextRevisionId: effectiveContext.id,
      contextRevisionId: this.activeContextRevisionId ?? null,
      protocol: llmConfig.protocol,
      outputBudget,
    }
    this.updateTimeline({ ...step }, correlationId)
    const outputStream = new ModelOutputStream((delta) => {
      if (this.generation === generation) {
        if (firstDeltaAt === undefined) {
          this.updateRuntimeStatus({
            activity: { phase: 'model_streaming', label: step.summary, startedAt: now() },
          }, correlationId)
        }
        firstDeltaAt ??= Date.now()
        streamChunks += 1
        this.appendAssistantDelta(delta, correlationId)
      }
    })
    let response: LlmChatResponse
    const logLifecycle = (event: string) => {
      try {
      const diagnostic = {
        event, timestamp: now(), runId: this.run.runId, stepId: step.id,
        requestArtifactId: requestArtifact.id, model: request.model ?? llmConfig.model,
        protocol: llmConfig.protocol, elapsedMs: Date.now() - requestStarted,
        firstTextDeltaMs: firstDeltaAt === undefined ? null : firstDeltaAt - requestStarted,
        textChunks: streamChunks, messageCount: request.messages.length,
        toolCount: request.tools?.length ?? 0, estimatedInputTokens,
        contextHash: createHash('sha256').update(JSON.stringify({ messages: request.messages, tools: request.tools })).digest('hex'),
        maxRetries: llmConfig.maxRetries, socketTimeoutMs: llmConfig.timeoutMs,
        retryPhase: lastRetry?.phase ?? null, retryAttempt: lastRetry?.attempt ?? null,
        retryStatusCode: lastRetry?.statusCode ?? null, retryDelayMs: lastRetry?.delayMs ?? null,
        retryKind: lastRetry?.kind ?? null, retryReason: lastRetry?.reason ?? null,
        retryProfileId: lastRetry?.profileId ?? null,
        retryNextProfileId: lastRetry?.nextProfileId ?? null,
        aborted: controller.signal.aborted,
      }
      this.createArtifact('hook-log', `Model lifecycle · ${event}`, diagnostic, correlationId)
      // Also retain diagnostics when the process exits before its trace is saved.
      process.stderr.write(`CAPYBARA_MODEL_LIFECYCLE ${JSON.stringify(diagnostic)}\n`)
      } catch { /* Diagnostics must not interrupt execution. */ }
    }
    logLifecycle('started')
    const diagnosticTimer = setInterval(() => logLifecycle('waiting'), 60_000)
    diagnosticTimer.unref()
    const recordAbort = () => logLifecycle('cancel_requested')
    controller.signal.addEventListener('abort', recordAbort, { once: true })
    try {
      try {
        response = await diagnosticContext.run({ runId: this.run.runId, stepId: step.id, requestArtifactId: requestArtifact.id }, async () => nativeStream
          ? await llm.stream!(request, (delta) => outputStream.push(delta))
          : await llm.chat(request))
        logLifecycle('completed')
      } catch (error) {
        logLifecycle(controller.signal.aborted ? 'cancelled' : 'failed')
        if (error instanceof LlmToolArgumentsError && error.callCount === 1 && !controller.signal.aborted
          && this.generation === generation && this.taskControl.taskId === requestBinding.taskId
          && this.taskControl.stateRevision === requestBinding.stateRevision && !modelTools.some(tool => tool.name === error.toolName)) {
          if (controlCarrier && error.toolName === CONTROL_CARRIER.name) {
            const rejected = this.createArtifact('model-response', 'Malformed control carrier response', {
              argumentsText: error.argumentsText, usage: error.usage ?? {}, error: error.message,
            }, correlationId)
            this.addUsage(error.usage ?? {})
            step.detail = { ...step.detail, responseArtifactId: rejected.id, controlRejection: 'RUNTIME_CONTROL_CARRIER_INVALID' }
            if (this.retryInvalidModelOutput(step, correlationId, llmConfig.maxRetries, rejected.id, '',
              'The control carrier arguments were malformed. Return one ControlEnvelopeV2 JSON object with the current binding.', true)) return
          }
          const intent = capabilityProjection.execution.allowedDecisions.find(decision => decision !== 'tool_call' && decision === error.toolName)
          if (intent) {
            const rejected = this.createArtifact('model-response', 'Malformed native control response', {
              toolName: error.toolName, argumentsText: error.argumentsText, usage: error.usage ?? {}, error: error.message,
            }, correlationId)
            this.addUsage(error.usage ?? {})
            step.detail = { ...step.detail, responseArtifactId: rejected.id }
            if (this.retryControlTransport(step, correlationId, llmConfig.maxRetries, rejected.id, intent, true)) return
          }
        }
        throw this.modelInvocationError(error)
      }
    } finally {
      clearInterval(diagnosticTimer)
      controller.signal.removeEventListener('abort', recordAbort)
      if (this.activeAbortController === controller) this.activeAbortController = undefined
      if (this.generation === generation) {
        this.updateModelRetry(step.id, undefined, correlationId)
      }
    }
    if (this.generation !== generation) return

    this.updateRuntimeStatus({
      activity: { phase: 'model_processing', label: step.summary, startedAt: now() },
    }, correlationId)
    this.addUsage(response.usage)
    if (response.usage?.inputTokens !== undefined) {
      const maxTokens = this.runtimeStatus.context.maxTokens
      this.updateRuntimeStatus({
        context: {
          usedTokens: response.usage.inputTokens,
          maxTokens,
          utilization: Math.min(response.usage.inputTokens / maxTokens, 1),
        },
      }, correlationId)
    }
    const responseArtifact = this.createArtifact(
      'model-response',
      `Model response · step ${step.index + 1}`,
      {
        provider: response.provider,
        model: response.model,
        text: response.text,
        toolCalls: response.toolCalls ?? [],
        finishReason: response.finishReason ?? null,
        usage: response.usage ?? {},
        raw: response.raw,
      },
      correlationId,
    )
    const calls = (response.toolCalls ?? []).map((call) => ({
      ...call,
      id: call.id || randomUUID(),
    }))
    step.detail = {
      ...(step.detail ?? {}),
      provider: response.provider,
      model: response.model,
      finishReason: response.finishReason ?? null,
      toolCalls: calls.length,
      usage: toJsonValue(response.usage ?? {}),
      requestArtifactId: requestArtifact.id,
      responseArtifactId: responseArtifact.id,
      effectiveContextRevisionId: effectiveContext.id,
      contextRevisionId: this.activeContextRevisionId ?? null,
      stream: {
        chunks: streamChunks,
        firstDeltaMs: firstDeltaAt === undefined ? null : firstDeltaAt - requestStarted,
        totalMs: Date.now() - requestStarted,
      },
    }
    if (this.taskControl.taskId !== requestBinding.taskId) throw new RuntimeStageError('model_protocol', 'RUNTIME_ENVELOPE_STATE_MISMATCH', 'task identity changed while the model request was in flight', true)
    if (this.taskControl.stateRevision !== requestBinding.stateRevision) throw new RuntimeCapabilityDriftError('RUNTIME_ENVELOPE_STATE_MISMATCH', 'task state changed while the model request was in flight', capabilityProjection)
    const recoverCommittedAddition = (diffs: unknown) => this.retryCommittedPlanAddition(step, correlationId, llmConfig.maxRetries,
      responseArtifact.id, diffs, capabilityProjection.execution.activeTaskIds, editOutcomes,
      { project: projectProjection.sourceEntryIds, session: v2Projection.sourceEntryIds })
    let controlText = response.text
    const carrierCall = controlCarrier && calls.find(call => call.name === CONTROL_CARRIER.name)
    if (carrierCall) {
      if (calls.length !== 1) {
        const code = 'RUNTIME_ACTION_TRANSPORT_CONFLICT'
        step.detail = { ...step.detail, controlRejection: code }
        if (documentControl && this.retryInvalidModelOutput(step, correlationId, llmConfig.maxRetries, responseArtifact.id, '',
          `Batch rejected (${code}). No call ran. Submit one ${CONTROL_CARRIER.name} by itself, or use a projected tool in a separate response if more observation is needed.`)) return
        throw new RuntimeStageError('model_protocol', code, 'a control carrier must be the only native call in its response', true)
      }
      const payload = carrierCall.arguments
      if (!isObject(payload) || Object.keys(payload).length !== 1 || !isObject(payload.envelope) || payload.envelope.envelopeVersion !== 2) {
        step.detail = { ...step.detail, controlRejection: 'RUNTIME_CONTROL_CARRIER_INVALID' }
        if (this.retryInvalidModelOutput(step, correlationId, llmConfig.maxRetries, responseArtifact.id, '',
          'The control carrier must contain one envelope matching ControlEnvelopeV2. Return the JSON envelope with the current binding.', true)) return
        throw new RuntimeStageError('model_protocol', 'RUNTIME_CONTROL_CARRIER_INVALID', 'the native control carrier did not contain a version 2 envelope', true)
      }
      step.detail = { ...step.detail, controlCarrierCallId: carrierCall.id }
      controlText = JSON.stringify(payload.envelope)
      calls.length = 0
    }
    if (calls.length > 0) {
      const projectedNames = new Set(modelTools.map((tool) => tool.name))
      const outside = calls.filter(call => !projectedNames.has(call.name))
      if (outside.length) {
        const intent = outside.every(call => call.name === outside[0]!.name)
          ? capabilityProjection.execution.allowedDecisions.find(decision => decision !== 'tool_call' && decision === outside[0]!.name) : undefined
        if (intent && calls.length > outside.length) {
          const code = 'RUNTIME_ACTION_TRANSPORT_CONFLICT'
          const toolNames = [...new Set(calls.filter(call => projectedNames.has(call.name)).map(call => call.name))]
          step.detail = { ...step.detail, controlRejection: code }
          if (this.retryInvalidModelOutput(step, correlationId, llmConfig.maxRetries, responseArtifact.id, '',
            `Batch rejected (${code}). No action ran. Submit ${JSON.stringify(toolNames)} through the native channel only if still needed, or submit one ${intent} control envelope with the new binding. Separate tool review from document edits. Use existing receipts and results.`)) return
          throw new RuntimeStageError('model_protocol', code, 'one batch cannot mix a control decision with native tools', true)
        }
        if (intent === 'propose_diff' && calls.length === 1 && isObject(calls[0]!.arguments)) {
          const args = calls[0]!.arguments
          if (recoverCommittedAddition(args.candidateDiffs ?? args.candidate_diffs ?? [args])) return
        }
        if (intent === 'complete_plan_nodes' && calls.length === 1 && isObject(calls[0]!.arguments)) {
          const args = calls[0]!.arguments
          const progress = isObject(args.planProgress) ? args.planProgress : args
          const ids = Array.isArray(progress.nodes) ? progress.nodes.flatMap(node => isObject(node) && typeof node.id === 'string' ? [node.id] : [])
            : typeof progress.planTaskId === 'string' ? [progress.planTaskId] : []
          if (ids.some(id => !currentExecution.activeTaskIds.includes(id))
            && this.retryInactivePlanProgress(step, correlationId, responseArtifact.id, currentExecution)) return
        }
        if (intent && this.retryControlTransport(step, correlationId, llmConfig.maxRetries, responseArtifact.id, intent)) return
        if (catalogCheckpoint && calls.every(call => call.name === 'search_resources')) {
          const code = 'CHILD_CATALOG_CHECKPOINT_REQUIRES_CONTROL'
          step.detail = { ...step.detail, controlRejection: code }
          if (this.retryInvalidModelOutput(step, correlationId, llmConfig.maxRetries, responseArtifact.id, '',
            `Catalog checkpoint (${code}). No call ran. Use finish if the existing result with receipt ${catalogCheckpoint} satisfies the local goal. If you need another lookup, submit continue with the concrete missing item in reasoningNextStep.`, true)) {
            if (controlCarrier) step.detail = { ...step.detail, offerControlCarrier: true }
            return
          }
        }
        if (fileEvidenceCheckpoint && calls.every(call => ['read_runtime_artifact', 'read_file', 'recall_context', 'request_planning'].includes(call.name))) {
          if (this.retryInvalidModelOutput(step, correlationId, llmConfig.maxRetries, responseArtifact.id, '',
            'File evidence checkpoint. Return a control envelope. Use finish if the visible sources suffice, or continue with the needed range in reasoningNextStep to restore the permitted read tools.', true)) return
        }
        if (editReceiptReview.length && calls.every(call => this.internalResourceTools().some(tool => tool.name === call.name))) {
          if (this.retryInvalidModelOutput(step, correlationId, llmConfig.maxRetries, responseArtifact.id, '',
            `No tool ran. Check the committed edits ${JSON.stringify(editReceiptReview)}. If the affected nodes are ready, submit complete_plan_nodes with their receipt references. If another action is required, use continue and specify it.`, true)) {
            step.detail = { ...step.detail, offerControlCarrier: true }
            return
          }
        }
        if (toolRoundsExhausted && !intent) {
          throw new RuntimeStageError('model_protocol', 'MODEL_TOOL_ROUND_LIMIT', `model exceeded the maximum of ${this.maxToolRounds} tool rounds`, true)
        }
        if (calls.every(call => !projectedNames.has(call.name))) {
          const settledReads = this.settledFileReadRefs(calls, modelMessages)
          if (settledReads.length) {
            const code = 'RUNTIME_FILE_READ_ALREADY_SETTLED'
            step.detail = { ...step.detail, controlRejection: code }
            const active = capabilityProjection.execution.activeTaskIds
            const applied = [...this.contextPlanActionRefs()].filter(([, id]) => active.includes(id))
            const editAdvice = applied.length
              ? ` These edits are already committed: ${JSON.stringify(applied)}. If their active nodes are satisfied, use complete_plan_nodes with those receipts.` : ''
            if (this.retryInvalidModelOutput(step, correlationId, llmConfig.maxRetries, responseArtifact.id, '',
              `Native batch rejected (${code}). No read ran. The requested source is covered by these completed investigation receipts and their saved originals: ${JSON.stringify(settledReads)}. Use the visible evidence and advance active nodes ${JSON.stringify(active)}.${editAdvice} For a genuinely new read, seek the appropriate plan and permission.`, applied.length > 0)) {
              if (applied.length) step.detail = { ...step.detail, offerControlCarrier: true }
              return
            }
          }
        }
        throw new RuntimeStageError('model_protocol', 'RUNTIME_ENVELOPE_TOOL_UNAUTHORIZED', 'native call requested a tool outside the current request projection', true)
      }
      if (calls.length === 1 && calls[0]!.name === 'request_planning' && currentExecution.activeTaskIds.length) {
        const reviewed = this.planningReviewKey(currentExecution, latestUserId)
        if (this.timeline.some(item => item.index < step.index && item.status === 'success' && item.detail?.resumedPlanKey === reviewed)) {
          const code = 'RUNTIME_PLAN_ALREADY_REVIEWED'
          step.detail = { ...step.detail, controlRejection: code }
          if (this.retryInvalidModelOutput(step, correlationId, llmConfig.maxRetries, responseArtifact.id, '',
            `No planning call ran (${code}). The same plan and active nodes ${JSON.stringify(currentExecution.activeTaskIds)} have already been reviewed. Submit complete_plan_nodes if recentPlanActions prove their conditions, propose_plan directly to change the plan, or continue with the specific evidence still needed. Use the current binding.`, true)) {
            step.detail = { ...step.detail, offerControlCarrier: true }
            return
          }
          throw new RuntimeStageError('model_protocol', code, 'the same accepted plan and active work have already been reviewed', true)
        }
      }
      try {
        this.validateCapabilityCalls(calls, capabilityProjection)
      } catch (error) {
        if (error instanceof RuntimeStageError && ['CHILD_PLAN_DELEGATION_MUST_BE_EXCLUSIVE', 'RUNTIME_PLANNING_CALL_MUST_BE_EXCLUSIVE'].includes(error.code)) {
          const advice = error.code === 'RUNTIME_PLANNING_CALL_MUST_BE_EXCLUSIVE'
            ? 'For an independent planning round submit request_planning alone. If just verifying an active node, use complete_plan_nodes with its actual action receipts and the current binding.'
            : 'Submit delegate_task alone with an active plan_task_id and its own read-only grants. Use the next projection for independent tools.'
          if (this.retryInvalidModelOutput(step, correlationId, 3, responseArtifact.id, '',
            `Native batch rejected (${error.code}). No call from that batch ran. ${advice}`)) return
        }
        throw error
      }
      if (response.text.trim().startsWith('{')) {
        let mixed: ModelOutput | undefined
        try { mixed = parseModelOutput(response.text) } catch { /* A provider may include ordinary text with native calls. */ }
        if (mixed?.envelope) throw new RuntimeStageError('model_protocol', 'RUNTIME_ACTION_TRANSPORT_CONFLICT', 'one response cannot combine a control envelope and native tool calls', true)
      }
      if (this.childAgentMode && calls.every(call => call.name === 'search_resources')) {
        const refs = this.repeatedChildCatalogSearches(calls, modelMessages)
        if (refs.length) {
          const code = 'CHILD_CATALOG_SEARCH_REPEATED'
          step.detail = { ...step.detail, controlRejection: code }
          if (this.retryInvalidModelOutput(step, correlationId, llmConfig.maxRetries, responseArtifact.id, '',
            `Native batch rejected (${code}). The current catalog still returns the same results as these visible successful receipts: ${refs.join(', ')}. No new search ran. If they satisfy the child goal, use finish and cite them. Otherwise use an allowed control decision to identify the specific missing information.`, true)) {
            step.detail = { ...step.detail, offerControlCarrier: true }
            return
          }
          throw new RuntimeStageError('model_protocol', code, 'child catalog search repeats a visible current result', true)
        }
      }
      this.toolRound += 1
      this.appendRuntimeMessage({ role: 'assistant', content: response.text, toolCalls: calls })
      this.publishRenderedMessages(correlationId)
      this.insertToolRound(step.index, calls, correlationId, capabilityProjection)
      this.updateRuntimeStatus({ model: 'ready', queueDepth: calls.length }, correlationId)
      return
    }
    const execution = capabilityProjection.execution
    const finishAllowed = execution.allowedDecisions.includes('finish')
    const activePlanWork = execution.activeTaskIds.length > 0 && !finishAllowed
    const pendingPlanCompletion = activePlanWork && execution.phase !== 'human_input'
    const activePlanAdvice = activePlanWork
      ? `The accepted plan still has work on active nodes ${JSON.stringify(execution.activeTaskIds)}. Use their projected tools or allowed control decisions to do the work. Use complete_plan_nodes for nodes supported by actual receipts. Recheck the next projection after node acceptance.`
      : ''
    let output: ModelOutput
    const trimmedResponse = controlText.trim()
    try {
      if (!trimmedResponse) throw new Error('LLM returned neither text nor tool calls')
      output = parseModelOutput(controlText)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const payloadRepair = error instanceof ControlPayloadError
      const extraFieldRepair = error instanceof ControlEnvelopeFieldError
      const typedRepair = error instanceof CompletionProposalError || error instanceof ContextDiffProposalError || payloadRepair || extraFieldRepair
      const printedToolCalls = controlOnlyRequest && PRINTED_TOOL_CALLS.test(trimmedResponse)
      const structuredDraft = finishAllowed && !typedRepair && isStructuredReplyDraft(trimmedResponse)
      const answerRepair = finishAllowed && !typedRepair
        && Boolean(trimmedResponse) && (structuredDraft || !trimmedResponse.startsWith('{'))
      const prematureDraft = activePlanWork && !typedRepair && Boolean(trimmedResponse) && !trimmedResponse.startsWith('{')
      const repairDetail = printedToolCalls ? '' : error instanceof CompletionProposalError && !finishAllowed
        ? ` ${error.code}. Set completionCheck to null and choose one of this round's allowedDecisions. ${activePlanAdvice}`
        : typedRepair ? ` ${error.code}. ${error.repairAdvice}`
          : structuredDraft ? ' The previous JSON is an unverified user reply. If it satisfies the task, include the JSON as a string in finish.userMessage and submit the current completionCheck. Use [] for action and evidence references that are absent this run.'
        : answerRepair ? ' Treat the previous assistant text as a draft answer. Check it against the visible evidence and the current task obligations. When ready, use decision "finish", put the verified answer inside userMessage, and fill completionCheck using existing receipts. If a source or obligation is missing, use an allowed control decision to identify it.'
          : prematureDraft ? ` ${activePlanAdvice}` : ''
      if (typedRepair) step.detail = { ...step.detail, controlRejection: error.code }
      const plainRepair = !printedToolCalls && ((!structuredDraft && (answerRepair || payloadRepair) && !this.childAgentMode)
        || controlPlainResponse || (!trimmedResponse && request.responseFormat === 'json'))
      const reason = printedToolCalls ? 'The control-only response contained tool-call text. No call ran. Submit a JSON control envelope.'
        : trimmedResponse ? 'Your last response failed runtime schema validation.' : 'Your last response was empty. Use the current control schema and produce a JSON object now.'
      const activeHuman = !trimmedResponse && capabilityProjection.execution.phase === 'human_input'
        ? ` Active human input nodes: ${JSON.stringify(capabilityProjection.execution.activeTaskIds)}. If the reply is present, use complete_plan_nodes only for its original node.` : ''
      const pendingHuman = this.taskControl.branchBlocks?.some(block => block.kind === 'human') && capabilityProjection.execution.activeTaskIds.length
        ? ` The existing human requests are already registered. Advance the independent active nodes ${JSON.stringify(capabilityProjection.execution.activeTaskIds)} with a projected tool or actual completion receipts.` : ''
      const repairControlOnly = answerRepair || payloadRepair || extraFieldRepair || controlOnlyRequest || plainRepair
      const transport = repairControlOnly ? 'Return' : 'Use a native call for a projected tool, or return'
      if (this.retryInvalidModelOutput(step, correlationId, llmConfig.maxRetries, responseArtifact.id, trimmedResponse && !payloadRepair && !prematureDraft && !printedToolCalls ? response.text : '',
        `${reason}${repairDetail}${activeHuman}${pendingHuman} Preserve previous tool results; do not restart the task or repeat completed tool actions. ${transport} one ControlEnvelopeV2 JSON object matching the current schema and binding, without Markdown fences. Do not invent receipts or clear obligations.`, repairControlOnly, plainRepair)) {
        if (catalogCheckpoint && controlCarrier && !plainRepair) step.detail = { ...step.detail, offerControlCarrier: true }
        return
      }
      throw new RuntimeStageError(
        'model_output_validation',
        trimmedResponse ? 'MODEL_OUTPUT_INVALID' : 'MODEL_OUTPUT_EMPTY',
        `${message}; local output repair budget exhausted`,
        true,
      )
    }
    let resolvedFileQuotes: ReturnType<RuntimeLoop['resolveFileReply']>['receipts'] | undefined
    if (output.envelope) {
      const source = output.envelope.sourceV2
      if (source && source.decision !== 'tool_call'
        && source.binding.sessionId === requestBinding.sessionId
        && source.binding.runId === requestBinding.runId && source.binding.taskId === requestBinding.taskId
        && source.binding.requestId !== requestBinding.requestId) {
        const previousRequest = this.timeline.some(item => item.type === 'model' && item.status === 'success' && item.index < step.index && item.id === source.binding.requestId)
          || editOutcomes.some(outcome => outcome.receipt.result === 'applied' && outcome.requestBinding?.requestId === source.binding.requestId)
        if (previousRequest || source.binding.stateRevision === requestBinding.stateRevision) {
          step.detail = { ...step.detail, controlRejection: 'RUNTIME_ENVELOPE_REQUEST_MISMATCH' }
          const next = source.decision === 'continue' ? ' Advance a runnable node with its current tools or verified receipts when possible.' : ''
          if (this.retryInvalidModelOutput(step, correlationId, 3, responseArtifact.id, '',
            `Your decision used ${previousRequest ? 'a previous' : 'a different'} request ID. Copy the entire binding from the new output_schema or current request_binding. Re-evaluate the current phase. Use prior receipts only as evidence.${next}`)) return
        }
      }
      if (source && (source.binding.taskId !== requestBinding.taskId || source.binding.stateRevision !== requestBinding.stateRevision
        || this.taskControl.stateRevision !== requestBinding.stateRevision)) {
        throw new RuntimeStageError('model_protocol', 'RUNTIME_ENVELOPE_STATE_MISMATCH', 'control task/state binding is stale or invalid', true)
      }
      if (source) {
        if (source.decision === 'tool_call') throw new RuntimeStageError('model_protocol', 'RUNTIME_ACTION_TRANSPORT_CONFLICT', 'this request uses provider-native actions; JSON control cannot execute an additional action channel', true)
        const knownTasks = new Set([this.taskControl.taskId, ...this.taskControl.tasks.map((task) => task.id)])
        const related = [
          ...source.actions.flatMap((action) => action.kind === 'ask_user' ? action.blockingTaskIds : []),
          ...(source.waitSpec?.blockingTaskIds ?? []),
          ...source.evidenceRequests.flatMap((item) => item.relatedTaskIds),
        ]
        const proposedTasks = new Set(source.decision === 'propose_plan'
          ? (source.planProposal?.tasks ?? source.planAmendment?.addTasks ?? []).map(task => task.id) : [])
        if (related.some(id => !knownTasks.has(id)) || source.uncertainties.some(item => item.relatedTaskIds.some(id => !knownTasks.has(id) && !proposedTasks.has(id)))) {
          throw new RuntimeStageError('model_protocol', 'RUNTIME_ENVELOPE_TASK_UNKNOWN', 'control references an unknown task', true)
        }
      }
      if (this.sessionId && output.envelope.sessionId !== this.sessionId) {
        throw new RuntimeStageError('model_protocol', 'RUNTIME_ENVELOPE_SESSION_MISMATCH', 'runtime envelope sessionId does not match the active session', true)
      }
      if (this.run.runId && output.envelope.runId !== this.run.runId) {
        throw new RuntimeStageError('model_protocol', 'RUNTIME_ENVELOPE_RUN_MISMATCH', 'runtime envelope runId does not match the active run', true)
      }
      if (output.envelope.requestId !== step.id) {
        throw new RuntimeStageError('model_protocol', 'RUNTIME_ENVELOPE_REQUEST_MISMATCH', 'runtime envelope requestId does not match the active model step', true)
      }
      const scopedControl = source?.waitSpec?.blockingTaskIds ?? source?.actions.find(action => action.kind === 'ask_user')?.blockingTaskIds
      if (scopedControl && scopedControl.length > 1 && scopedControl.includes(this.taskControl.taskId)) {
        const code = 'RUNTIME_BRANCH_SCOPE_MIXED'
        step.detail = { ...step.detail, controlRejection: code }
        if (this.retryInvalidModelOutput(step, correlationId, llmConfig.maxRetries, responseArtifact.id, '',
          `Control rejected (${code}). Choose only the affected plan node IDs. Use the root task ID alone only if this blocks the whole run. Keep existing questions or waits from runtime_state.branchBlocks. Advance independent active nodes ${JSON.stringify(execution.activeTaskIds)} with their current tools or receipts.`)) return
        throw new RuntimeStageError('model_protocol', code, 'choose either the root task or active plan nodes', true)
      }
      if (output.envelope.decision === 'finish' && pendingPlanCompletion) {
        try { this.validateTaskCompletion(output.envelope, correlationId) } catch (error) {
          const blockers = error instanceof RuntimeStageError && isObject(error.diagnostics) ? error.diagnostics.blockers : undefined
          if (source && Array.isArray(blockers) && blockers.length === 1 && blockers[0] === 'unfinished_tasks') {
            step.detail = { ...step.detail, controlRejection: 'RUNTIME_TASK_COMPLETION_BLOCKED' }
            if (this.retryInvalidModelOutput(step, correlationId, llmConfig.maxRetries, responseArtifact.id, '',
              `Completion rejected (unfinished_tasks). The accepted plan has unfinished nodes. ${activePlanAdvice}`)) return
          }
          throw error
        }
      }
      try { assertRuntimeDecision(capabilityProjection, output.envelope.decision) } catch (error) { throw this.capabilityStageError(error) }
      if (source?.decision === 'resume_plan') {
        this.taskControl = resumeRuntimePlan(this.taskControl)
        step.detail = { ...step.detail, resumedPlanKey: this.planningReviewKey(runtimeExecutionState(this.taskControl), latestUserId) }
        this.createArtifact('context-diff', 'Accepted plan resumed', { planRevision: this.taskControl.planRevision,
          stateRevision: this.taskControl.stateRevision, requestId: requestBinding.requestId }, correlationId)
      }
      if (output.envelope.decision === 'ask_user') {
        const execution = capabilityProjection.execution
        const targets = source?.actions.find(action => action.kind === 'ask_user')?.blockingTaskIds ?? [this.taskControl.taskId]
        const allowedTargets = runtimeHumanQuestionTargets(this.taskControl, execution)
        if (!targets.length || targets.some(id => !allowedTargets.includes(id))) {
          const code = execution.phase === 'human_input' ? 'RUNTIME_HUMAN_INPUT_SCOPE' : 'RUNTIME_BRANCH_NOT_ACTIVE'
          const existing = this.taskControl.branchBlocks?.filter(block => block.kind === 'human' && block.taskIds.some(id => targets.includes(id)))
          const advice = existing?.length
            ? `The host is still waiting on ${JSON.stringify(existing.map(({ id, taskIds }) => ({ id, taskIds })))}. Advance independent active nodes ${JSON.stringify(execution.activeTaskIds)} with the projected tools or verified receipts.`
            : `For a new question, choose blockingTaskIds from ${JSON.stringify(allowedTargets)}.`
          step.detail = { ...step.detail, controlRejection: code }
          if (this.retryInvalidModelOutput(step, correlationId, 3, responseArtifact.id, '',
            `Question rejected (${code}). ${advice}`)) return
          throw new RuntimeStageError('model_protocol', code, 'a human question needs a currently eligible task', true)
        }
      }
      if (source?.decision === 'continue' && !source.evidenceRequests.length) {
        const next = (source.reasoningNextStep ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ').replace(/[。.!！?？]+$/u, '').trim()
        // Request assembly changes the system section. Compare knowledge revisions only.
        const documents = [projectDocument, sessionDocument].map(document => ({ id: document.id,
          revisions: document.sections.filter(section => section.kind === 'information' || section.kind === 'candidates').map(section => section.revision) }))
        const authority = capabilityHash({ taskId: requestBinding.taskId, runId: requestBinding.runId, execution: capabilityProjection.execution,
          capabilities: capabilityProjection.bindings, userMessageId: latestUserId, documents })
        const code = !next || source.userMessage.trim() ? 'RUNTIME_REASONING_STEP_REQUIRED'
          : this.reasoningContinuationRejection(step.index, authority, next)
        if (code) {
          step.detail = { ...step.detail, controlRejection: code }
          const nextAction = code === 'RUNTIME_REASONING_CONTINUATION_LIMIT'
            ? 'Run a projected native tool, request necessary input or evidence, or update the plan when permitted. The same authority has no further pure reasoning rounds.'
            : 'For pure reasoning, use a new concrete reasoningNextStep and userMessage "".'
          const repair = `Control rejected (${code}). Choose an allowed decision. If finish is allowed and the deliverable and obligations are complete, return finish with the answer and current binding. Report nonblocking unknowns in that answer. ${nextAction}`
          if (this.retryInvalidModelOutput(step, correlationId, 3, responseArtifact.id, code === 'RUNTIME_REASONING_STEP_REQUIRED' ? response.text : '', repair)) return
          throw new RuntimeStageError('model_protocol', code, 'pure reasoning cannot proceed without a new step and remaining continuation capacity', true)
        }
        step.detail = { ...step.detail, reasoningContinuation: { authority, next } }
      }
      if (source?.decision === 'propose_diff') {
        const execution = capabilityProjection.execution
        if (execution.phase === 'execution' && execution.activeTaskIds.length && source.candidateDiffs.some(diff => diff.planTaskId === undefined)) {
          const code = 'RUNTIME_CONTEXT_PLAN_NODE_REQUIRED'
          step.detail = { ...step.detail, controlRejection: code }
          if (this.retryInvalidModelOutput(step, correlationId, llmConfig.maxRetries, responseArtifact.id, '',
            `Document edit rejected (${code}). No diff was committed. Set each candidateDiffs[].planTaskId to the active node whose conditions the edit fulfills: ${JSON.stringify(execution.activeTaskIds)}. If no active node covers the edit, use propose_plan to add one and preserve accepted work. Use the current request binding.`, true)) {
            step.detail = { ...step.detail, offerControlCarrier: true }
            return
          }
          throw new RuntimeStageError('model_protocol', code, 'each document diff needs its active execution node before commit', true)
        }
        const inactiveEdits = source.candidateDiffs.flatMap(diff => diff.planTaskId !== undefined
          && (execution.phase !== 'execution' || !execution.activeTaskIds.includes(diff.planTaskId)) ? [diff.planTaskId] : [])
        if (inactiveEdits.length) {
          const pending = new Set(this.taskControl.tasks.filter(node => node.status === 'pending').map(node => node.id))
          if (execution.phase === 'execution' && inactiveEdits.every(id => pending.has(id))
            && this.retryInvalidModelOutput(step, correlationId, 3, responseArtifact.id, '',
              'Document edit rejected (RUNTIME_CONTEXT_PLAN_NODE_INACTIVE). Only runtime_state.execution.activeTaskIds may execute. If a predecessor has a real completionActionRef, first use complete_plan_nodes with the exact reference. Wait for the next execution projection before editing the dependent node.')) return
          throw new RuntimeStageError('model_protocol', 'RUNTIME_CONTEXT_PLAN_NODE_INACTIVE', 'document diff planTaskId must identify an active execution node', true)
        }
        if (recoverCommittedAddition(source.candidateDiffs)) return
      }
      if (source?.planProposal || source?.planAmendment || source?.planProgress) {
        try {
          const proposal = source.planProgress ? planProposalForProgress(this.taskControl, source.planProgress, capabilityProjection.execution.activeTaskIds)
            : source.planAmendment ? planProposalForAmendment(this.taskControl, source.planAmendment) : source.planProposal!
          const currentCapabilities = this.availableToolCapabilities()
          const known = new Set(currentCapabilities.flatMap(capability => [capability.capabilityId, capability.name]))
          const capabilityIds = source.planProgress ? [] : source.planAmendment ? [
            ...(source.planAmendment.addTasks ?? []).flatMap(node => node.capabilityIds),
            ...(source.planAmendment.updateTasks ?? []).flatMap(node => node.addCapabilityIds ?? []),
          ] : proposal.tasks.flatMap(task => task.capabilityIds)
          const unknown = [...new Set(capabilityIds.filter(id => !known.has(id)))]
          if (unknown.length) {
            const code = 'RUNTIME_PLAN_CAPABILITY_UNKNOWN'
            step.detail = { ...step.detail, controlRejection: code }
            if (this.retryInvalidModelOutput(step, correlationId, 3, responseArtifact.id, '',
              `Plan rejected (${code}). Unregistered capability IDs: ${JSON.stringify(unknown.slice(0, 8))}. Keep the accepted plan and use only IDs from the current capability catalog. Control decisions such as propose_diff and finish are not native tools. For a node that only uses a control decision, use capabilityIds: [] and describe the outcome in completionConditions. Copy the current request binding and plan revision.`, true, true)) return
            throw new Error(code)
          }
          this.assertNewPlanReferences(proposal.tasks, currentCapabilities)
          this.taskControl = acceptRuntimePlan(this.taskControl, proposal, (actions, evidence) =>
            this.missingRuntimeCompletionActions(actions).length === 0 && this.missingCompletionEvidence(evidence).length === 0,
          node => this.verifyParentTakeover(node))
        } catch (error) {
          const code = error instanceof Error ? error.message : 'RUNTIME_PLAN_INVALID'
          const wrongNode = error instanceof RuntimePlanReceiptScopeError
            ? ` ${error.rejected.slice(0, 8).map(({ ref, owners }) => {
              const node = JSON.stringify(error.nodeId.slice(0, 160))
              if (owners.length) return `Remove ${JSON.stringify(ref)} from the actions of ${node}. That receipt belongs to ${JSON.stringify(owners)}.`
              const label = /^(?:call|step|context|human):[\w.:-]{1,160}$/.test(ref) ? ` ${JSON.stringify(ref)}` : ''
              return `Remove the rejected action reference${label} from ${node}. No eligible successful receipt proves it.`
            }).join(' ')} Use accepted dependencies for prerequisite work. A verification-only node may use actionRefs: [] with registered evidence that proves its conditions.` : ''
          if (code === 'RUNTIME_PLAN_DELEGATION_UNVERIFIED') {
            const proposed = source.planProgress
              ? this.taskControl.tasks.filter(node => source.planProgress!.nodes.some(update => update.id === node.id))
              : source.planProposal?.tasks.filter(node => node.status === 'completed') ?? []
            const delegated = proposed.filter(node => requiresChildResult(node)
              && !this.taskControl.childAssignments?.some(item => item.planTaskId === node.id))
            step.detail = { ...step.detail, controlRejection: code }
            if (this.retryInvalidModelOutput(step, correlationId, 3, responseArtifact.id, '',
              `Node completion rejected (${code}). Keep delegated nodes ${JSON.stringify(delegated.map(node => node.id))} pending until a real child result is accepted. If the child grant was missing, revise that node's capabilityIds using the catalog, then run delegate_task alone. A parent search cannot replace the delegated result.`)) return
          }
          if (source.planProgress && code === 'RUNTIME_PLAN_PROGRESS_NODE_INACTIVE'
            && this.retryInactivePlanProgress(step, correlationId, responseArtifact.id, capabilityProjection.execution)) return
          if (source.planProgress && ['RUNTIME_PLAN_COMPLETION_UNVERIFIED', 'RUNTIME_PLAN_ACTION_UNBOUND',
            'RUNTIME_PLAN_EVIDENCE_UNBOUND', 'RUNTIME_PLAN_REVISION_MISMATCH'].includes(code)) {
            step.detail = { ...step.detail, controlRejection: code }
            const unregisteredEvidence = code === 'RUNTIME_PLAN_EVIDENCE_UNBOUND'
              ? ' Put tool completionActionRef values in actionRefs. evidenceRefs accepts only IDs registered as evidence in the documents. Remove artifact IDs. Use [] when the successful actions suffice.' : ''
            const humanInput = capabilityProjection.execution.phase === 'human_input'
            const acceptedChildren = this.taskControl.childAssignments?.filter(item => item.state === 'accepted'
              && capabilityProjection.execution.activeTaskIds.includes(item.planTaskId)).map(item => item.planTaskId) ?? []
            const childProof = acceptedChildren.length
              ? ` Accepted child results already verify the delegated work on ${JSON.stringify(acceptedChildren)}. When the node has no additional unchecked condition, use actionRefs: [] and evidenceRefs: [] for that node.` : ''
            const reviewEditCompletion = code === 'RUNTIME_PLAN_ACTION_UNBOUND' && editReceiptReview.length > 0
            const editProof = reviewEditCompletion
              ? ` These edits remain committed: ${JSON.stringify(editReceiptReview)}. For each satisfied edit node, retry complete_plan_nodes with its listed completionActionRef in actionRefs and omit the rejected refs. If an additional action is required, use continue and name it.` : ''
            if (this.retryInvalidModelOutput(step, correlationId, 3, responseArtifact.id, '',
              `Node completion rejected (${code}).${wrongNode}${editProof} Use planProgress.basePlanRevision ${this.taskControl.planRevision}. The active pending IDs are ${JSON.stringify(capabilityProjection.execution.activeTaskIds)}. Omit all others, including previously completed nodes. Cite real successful receipts.${unregisteredEvidence}${childProof} A reply or document edit receipt must belong to the same node; a delegated node needs an accepted child result or a verified action under its current takeover. The rejected proposal did not change the plan.`, controlOnlyRepair || reviewEditCompletion, humanInput)) {
              if (reviewEditCompletion && controlCarrier) step.detail = { ...step.detail, offerControlCarrier: true }
              return
            }
          }
          if (code === 'RUNTIME_PLAN_ROOT_ID_RESERVED' || code === 'RUNTIME_PLAN_DUPLICATE_TASK') {
            step.detail = { ...step.detail, controlRejection: code }
            if (this.retryInvalidModelOutput(step, correlationId, 3, responseArtifact.id, '',
              `Plan rejected (${code}). The root request_binding.taskId identifies the enclosing task. Give each new plan node a distinct local ID and reference those IDs in dependsOn. Keep any already accepted node IDs. Use the current runtime_state.planRevision and request_binding.`)) return
          }
          if (code === 'RUNTIME_PLAN_UNCHANGED') {
            step.detail = { ...step.detail, controlRejection: code }
            if (this.retryInvalidModelOutput(step, correlationId, 3, responseArtifact.id, '',
              `The accepted plan already contains those nodes (revision ${this.taskControl.planRevision}). Advance active nodes ${JSON.stringify(capabilityProjection.execution.activeTaskIds)}. For an outstanding context edit, use propose_diff with the active planTaskId and current candidate evidence. To settle completed work, use complete_plan_nodes. Propose a plan only if dependencies, obligations or nodes need to change.`)) return
          }
          if (code === 'RUNTIME_PLAN_REVISION_MISMATCH') {
            step.detail = { ...step.detail, controlRejection: code }
            if (this.retryInvalidModelOutput(step, correlationId, 3, responseArtifact.id, '',
              `Plan rejected (${code}). Rebuild from runtime_state.tasks and use basePlanRevision ${this.taskControl.planRevision}, the current runtime_state.planRevision. Copy request_binding separately. Keep the actual human reply references and previously accepted work; a stateRevision or an earlier plan revision is not the current base.`)) return
          }
          if (code === 'RUNTIME_PLAN_HUMAN_INPUT_CAPABILITIES' && this.retryInvalidModelOutput(step, correlationId, 3, responseArtifact.id, '',
            `Plan rejected (${code}). Use capabilityIds: [] for human_input nodes. Put searches and other tools in separate nodes and preserve accepted obligations.`)) return
          if (code === 'RUNTIME_PLAN_BLOCKED_BRANCH_CHANGED' && this.retryInvalidModelOutput(step, correlationId, 3, responseArtifact.id, '',
            `Plan rejected (${code}). Keep every waiting or assigned node from runtime_state.tasks unchanged, including owner, phase, dependsOn and capabilityIds. Verify or revise only independent work. Copy the current request_binding and planRevision.`)) return
          if (code === 'RUNTIME_PLAN_OBLIGATION_REMOVED' && this.retryInvalidModelOutput(step, correlationId, 3, responseArtifact.id, '',
            `Plan rejected (${code}). To add a node, dependency or capability use planAmendment with planProposal: null. For a full plan, preserve the accepted IDs, completed statuses, completionConditions, requiredActions and evidenceRefs verbatim. A user reply verifies its original human_input node. Copy the current request_binding and planRevision.`)) return
          if (['RUNTIME_PLAN_AMENDMENT_NO_PLAN', 'RUNTIME_PLAN_AMENDMENT_NODE_NOT_PENDING'].includes(code)
            && this.retryInvalidModelOutput(step, correlationId, 3, responseArtifact.id, '',
              `Plan rejected (${code}). Use planAmendment only with an accepted plan, and update only pending node IDs. Use the current binding and plan revision.`)) return
          if (code === 'RUNTIME_PLAN_COMPLETION_UNVERIFIED') {
            const takeoverNodes = new Set(this.taskControl.childAssignments?.filter(item => item.state === 'parent' && item.takeoverId).map(item => item.planTaskId))
            const pending = source.planProposal?.tasks.filter(node => node.status === 'completed' && takeoverNodes.has(node.id) && !this.verifyParentTakeover(node)) ?? []
            if (pending.length && this.retryInvalidModelOutput(step, correlationId, 3, responseArtifact.id, '',
              `Plan rejected (${code}). Parent takeover nodes ${pending.map(node => node.id).join(', ')} need a successful action under their current takeoverId. Keep them pending in a plan revision if tools are not available in this phase. When execution.parentTakeover selects the node, use a projected tool and then cite the new completionActionRef. Earlier calls, child result review and the takeover request itself do not prove that action succeeded.`)) return
            const unproven = source.planProposal?.tasks.filter(node => node.status === 'completed'
              && !node.requiredActions.length && !node.evidenceRefs.length
              && !this.taskControl.childAssignments?.some(assignment => assignment.planTaskId === node.id)) ?? []
            if (unproven.length && this.retryInvalidModelOutput(step, correlationId, 3, responseArtifact.id, '',
              `Plan rejected (${code}). Completed nodes need real proof. For ${JSON.stringify(unproven.map(node => node.id))}, cite visible successful completionActionRefs or registered evidence that actually proves the conditions. Otherwise keep those nodes pending. Use the current basePlanRevision and preserve accepted obligations.`)) return
          }
          if (['RUNTIME_PLAN_ACTION_UNBOUND', 'RUNTIME_PLAN_EVIDENCE_UNBOUND'].includes(code)) {
            this.createArtifact('context-diff', 'Rejected runtime plan references', { code, responseArtifactId: responseArtifact.id, planRevision: this.taskControl.planRevision }, correlationId)
            const planReview = capabilityProjection.execution.phase === 'planning' && this.taskControl.tasks.length
              ? ' If the graph needs no change, use resume_plan.' : ''
            if (this.retryInvalidModelOutput(step, correlationId, 3, responseArtifact.id, '',
              `Plan rejected (${code}).${wrongNode} Start from runtime_state.tasks with their accepted IDs, statuses and references. Keep unfinished nodes pending and preserve existing requiredActions. Express future work using completionConditions and capabilities. Use registered evidence IDs or []. Use complete_plan_nodes in execution for new successful receipts that satisfy an active node.${planReview} Use current request_binding and runtime_state.planRevision.`)) return
          }
          throw new RuntimeStageError('model_protocol', code, 'runtime rejected plan proposal', true)
        }
        this.createArtifact('context-diff', source.planProgress ? 'Accepted plan node completion' : 'Accepted runtime plan', toJsonValue(this.taskControl), correlationId)
      }
      const allowedToolNames = new Set(modelTools.map((tool) => tool.name))
      const envelopeToolCalls = output.envelope.actions.filter((action) => action.kind === 'tool_call')
      if (envelopeToolCalls.length && toolRoundsExhausted) {
        throw new RuntimeStageError('model_protocol', 'MODEL_TOOL_ROUND_LIMIT', `model exceeded the maximum of ${this.maxToolRounds} tool rounds`, true)
      }
      for (const action of envelopeToolCalls) {
        if (!allowedToolNames.has(action.toolName)) {
          throw new RuntimeStageError('model_protocol', 'RUNTIME_ENVELOPE_TOOL_UNAUTHORIZED', `runtime envelope requested unauthorized tool: ${action.toolName}`, true)
        }
      }
      if (output.envelope.decision === 'tool_call' && output.status !== 'running') {
        throw new RuntimeStageError('model_protocol', 'RUNTIME_ENVELOPE_TOOL_COMPLETED', 'tool_call decisions must keep the loop running', true)
      }
      if (output.envelope.decision === 'finish' && output.envelope.completionCheck?.verified !== true) {
        throw new RuntimeStageError('model_protocol', 'RUNTIME_ENVELOPE_COMPLETION_UNVERIFIED', 'finish requires a verified completionCheck', true)
      }
      if (output.envelope.decision === 'finish') {
        const completionCheck = output.envelope.completionCheck as NonNullable<RuntimeEnvelope['completionCheck']>
        const repairFinish = (notice: string) => {
          const repaired = this.retryInvalidModelOutput(step, correlationId, llmConfig.maxRetries, responseArtifact.id,
            source?.userMessage ?? response.text, notice, controlOnlyRequest || this.childAgentMode)
          if (repaired && controlCarrier) step.detail = { ...step.detail, offerControlCarrier: true }
          return repaired
        }
        const missingEvidence = this.missingCompletionEvidence(completionCheck.requiredEvidenceRefs)
        if (missingEvidence.length > 0) {
          if (source && missingEvidence.every(id => !this.taskControl.requiredEvidenceRefs.includes(id))
            && repairFinish('The last finish referenced evidence IDs absent from the current documents. If the visible sources support the draft answer, keep it and repair the finish with the current request_binding. Use only registered evidence IDs in requiredEvidenceRefs, or [] when the visible receipts suffice. Preserve accepted obligations.')) return
          throw new RuntimeStageError(
            'model_protocol',
            'RUNTIME_ENVELOPE_EVIDENCE_MISSING',
            `finish references evidence that is not present in the context document: ${missingEvidence.join(', ')}`,
            true,
          )
        }
        if (output.envelope.uncertainties.some((uncertainty) => uncertainty.blocking)) {
          throw new RuntimeStageError(
            'model_protocol',
            'RUNTIME_ENVELOPE_BLOCKING_UNCERTAINTY',
            'finish cannot contain blocking uncertainties',
            true,
          )
        }
        const missingActions = this.missingRuntimeCompletionActions(completionCheck.requiredActions ?? [])
        if (missingActions.length > 0) {
          if (source && missingActions.every(id => !this.taskControl.requiredActions.includes(id))
            && repairFinish('The last finish was rejected because it referred to an action outside the current completed action ledger. Preserve the verified answer. Copy actual IDs from this run. If no new action was required or executed, completionCheck.requiredActions must be []. Preserve accepted obligations.')) return
          throw new RuntimeStageError(
            'model_protocol',
            'RUNTIME_ENVELOPE_ACTIONS_INCOMPLETE',
            `finish references runtime actions that have not completed successfully: ${missingActions.join(', ')}`,
            true,
          )
        }
        if (output.fileQuotes) {
          try {
            if (!fileHistory && output.fileQuotes.some(quote => 'evidenceId' in quote)) throw new Error('FILE_QUOTE_NOT_AVAILABLE')
            const reply = this.resolveFileReply(output.content, output.fileQuotes, publications, modelPublicationId, modelMessages)
            output.content = reply.content
            resolvedFileQuotes = reply.receipts
          } catch (error) {
            const reason = error instanceof Error ? error.message : 'invalid quote'
            const proseRepair = reason === 'FILE_QUOTE_REPLY_NOT_JSON'
              ? 'For a normal prose reply, preserve the requested text format and omit fileQuotes. For a requested structured reply: ' : ''
            if (repairFinish(`The file quote was rejected (${reason}). ${proseRepair}In userMessage, submit only the final JSON object or array, with null for each fileQuotes target. Use a published evidenceId, the visible read_file runtime_receipt.resultArtifactId, or the visible line page result.artifact_id as readArtifactId. Copy file and line from that source. Keep the verified task obligations.`)) return
            throw new RuntimeStageError('model_output_validation', 'FILE_QUOTE_INVALID', reason, true)
          }
        }
      }
      if (output.envelope.decision === 'wait' && output.status === 'completed') {
        throw new RuntimeStageError('model_protocol', 'RUNTIME_ENVELOPE_WAIT_COMPLETED', 'wait decisions must keep the loop running', true)
      }
      if ((output.envelope.decision === 'ask_user' || output.envelope.evidenceRequests.length > 0) && output.status === 'completed') {
        throw new RuntimeStageError('model_protocol', 'RUNTIME_ENVELOPE_CONTROL_COMPLETED', 'interactive control decisions must keep the loop running', true)
      }
      if (output.envelope.decision === 'reflect') {
        this.createArtifact('context-diff', 'V2 reflection envelope', output.envelope, correlationId)
      }
      const taskBeforeObligations = { ...this.taskControl }
      if (output.envelope.decision !== 'resume_plan') this.recordEnvelopeObligations(output.envelope)
      if (output.status === 'completed') this.validateTaskCompletion(output.envelope, correlationId)
      try {
        this.handleV2EnvelopeControl(output.envelope, correlationId, capabilityProjection)
      } catch (error) {
        if (source && error instanceof RuntimeStageError && ['RUNTIME_BRANCH_NOT_ACTIVE', 'WAIT_SIGNAL_RESERVED_EVENT', 'WAIT_RUNTIME_BINDING_UNKNOWN', 'CHILD_PLAN_WAIT_BINDING_MISMATCH'].includes(error.code)) {
          this.taskControl = taskBeforeObligations
          const advice = error.code === 'WAIT_SIGNAL_RESERVED_EVENT'
            ? 'The host already owns the human or evidence subscription. Keep the existing block. Continue independent work, or propose_plan with actual receipts for completed nodes. The host pauses when no independent work remains.'
            : error.code === 'WAIT_RUNTIME_BINDING_UNKNOWN' || error.code === 'CHILD_PLAN_WAIT_BINDING_MISMATCH'
              ? 'Use correlationIds for one event type from the current run. For child.ready copy only the child waitRef and bind its own planTaskId. Keep already registered human or evidence blocks separate. A child showing waiting with inputRequestId needs a separate decision from the parent.'
              : 'A node in runtime_state.branchBlocks already has its pending request. Keep it and advance a node from execution.activeTaskIds using the current tools or verify it with existing receipts. Bind a new control action only to the unblocked node that actually needs it.'
          if (this.retryInvalidModelOutput(step, correlationId, 3, responseArtifact.id, '',
            `Branch control rejected (${error.code}). ${advice}`)) return
        }
        throw error
      }
      try {
        this.applyV2EnvelopeDiffs(output.envelope, correlationId, modelPublicationId, requestBinding)
      } catch (error) {
        const code = error instanceof RuntimeStageError ? error.code : error instanceof Error ? error.message : ''
        if (source?.decision === 'propose_diff' && (code === 'EVIDENCE_NOT_BOUND' || code === 'EVIDENCE_NOT_FOUND')) {
          step.detail = { ...step.detail, controlRejection: code }
          if (this.retryInvalidModelOutput(step, correlationId, llmConfig.maxRetries, responseArtifact.id, '',
            `Document edit rejected (${code}). No change was applied. For each proposed edit, use only evidence IDs on its own candidate-ref. Split independent source claims into separate edits and bind each to its actual candidate. Copy the current request and document bindings. Preserve previously applied work.`, true, true)) return
          throw new RuntimeStageError('model_protocol', code, 'document diff evidence does not belong to its candidate', true)
        }
        const staleBinding = ['RUNTIME_ENVELOPE_DOCUMENT_MISMATCH', 'PROJECTION_NOT_PUBLISHED', 'PROJECTION_BINDING_CONFLICT',
          'PROJECTION_REVISION_CONFLICT', 'CONTEXT_REVISION_CONFLICT', 'PROJECTION_HASH_CONFLICT', 'CANDIDATE_NOT_IN_PROJECTION',
          'TREE_NODE_HASH_CONFLICT', 'TREE_NODE_NOT_IN_PROJECTION', 'TREE_REFERENCE_NOT_IN_PROJECTION'].includes(code)
        if (staleBinding && this.retryInvalidModelOutput(step, correlationId, llmConfig.maxRetries, responseArtifact.id, response.text,
          `Document edit rejected (${code}). Recheck recentContextEdits and the new document projection. If the edit is still needed, copy scope, documentId, baseRevision, projectionId and projectionHash from that scope's current context-binding, then select visible node IDs, their hashes and bound candidate evidence. Preserve already applied edits.`)) return
        if (staleBinding) throw new RuntimeStageError('model_protocol', 'RUNTIME_CONTEXT_DIFF_BINDING_REJECTED', code, true)
        throw error
      }
      if (envelopeToolCalls.length > 0) {
        const envelopeCalls = envelopeToolCalls.map((action, index) => ({
          id: `envelope-tool-${output.envelope?.requestId ?? step.id}-${index}-${randomUUID()}`,
          name: action.toolName,
          arguments: action.arguments,
        }))
        this.toolRound += 1
        this.appendRuntimeMessage({ role: 'assistant', content: response.text, toolCalls: envelopeCalls })
        this.publishRenderedMessages(correlationId)
        this.insertToolRound(step.index, envelopeCalls, correlationId, capabilityProjection)
        this.updateRuntimeStatus({ model: 'ready', queueDepth: envelopeCalls.length }, correlationId)
        return
      }
    }
    if (output.status === 'running' && !output.envelope && (this.taskControl.planning?.required || this.taskControl.tasks.length > 0)) {
      const code = 'RUNTIME_PLANNED_CONTROL_ENVELOPE_REQUIRED'
      if (this.retryInvalidModelOutput(step, correlationId, 3, responseArtifact.id, '',
        'Planned control requires ControlEnvelopeV2. The accepted plan is in runtime_state. Use ask_user for an active node awaiting your question, a native tool call for available work, or another allowed decision with the current binding.')) return
      throw new RuntimeStageError('model_protocol', code, 'planned control requires a bound ControlEnvelopeV2', true)
    }
    if (output.status === 'completed' && !output.envelope) {
      if (!pendingPlanCompletion) {
        try { assertRuntimeDecision(capabilityProjection, 'finish') } catch (error) { throw this.capabilityStageError(error) }
      }
      this.validateTaskCompletion(undefined, correlationId)
    }
    step.detail = {
      ...step.detail,
      loopStatus: output.status,
      ...(output.envelope ? { runtimeEnvelope: toJsonValue(output.envelope) } : {}),
      ...(resolvedFileQuotes ? { resolvedFileQuotes: toJsonValue(resolvedFileQuotes) } : {}),
    }
    this.updateRuntimeStatus({ loopStatus: output.status }, correlationId)
    if (output.status === 'running') {
      if (nativeStream) outputStream.finish(output)
      if (output.envelope?.decision === 'ask_user') {
        const question = this.v2ControlState.question ?? output.content
        await this.completeAssistant({ ...response, text: question }, correlationId, generation, nativeStream)
      }
      if (this.maxToolRounds !== -1 && this.continuationRound >= this.maxToolRounds) {
        throw new RuntimeStageError(
          'model_protocol',
          'MODEL_CONTINUATION_LIMIT',
          `model exceeded the maximum of ${this.maxToolRounds} continuation rounds`,
          true,
        )
      }
      this.continuationRound += 1
      const control = output.envelope?.sourceV2
      // The ledger and response artifact already retain accepted control data.
      // Repeat only conversational text or a reasoning checkpoint in model history.
      const historyText = !control ? response.text : control.decision === 'ask_user' ? output.content
        : control.decision === 'continue' ? control.reasoningNextStep : undefined
      if (historyText?.trim()) this.appendRuntimeMessage({ role: 'assistant', content: historyText }, control ? 'runtime' : 'model')
      this.publishRenderedMessages(correlationId)
      this.insertContinuation(step.index, correlationId)
      const branchPaused = this.taskControl.branchBlocks?.length && !hasRunnableBranch(this.taskControl)
      if (branchPaused && this.run.status === 'running' && this.v2ControlState.status === 'idle') this.taskControl.branchPaused = true
      if (branchPaused || this.v2ControlState.status === 'waiting' || this.v2ControlState.status === 'awaiting_user' || this.v2ControlState.status === 'awaiting_evidence') {
        // Publish paused only after executeStep commits the next cursor and
        // checkpoint. A reconnect must not replay the question model step.
        this.run = this.withRun({ status: 'pause_requested' })
      }
      this.updateRuntimeStatus({ model: 'ready' }, correlationId)
      return
    }
    if (nativeStream) outputStream.finish(output)
    this.appendRuntimeMessage({ role: 'assistant', content: output.content })
    this.publishRenderedMessages(correlationId)
    try {
      await this.completeAssistant(
        { ...response, text: output.content },
        correlationId,
        generation,
        nativeStream,
      )
    } catch (error) {
      throw new RuntimeStageError(
        'model_protocol',
        'MODEL_STREAM_MISMATCH',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  private async executeToolStep(
    step: TimelineStep,
    correlationId: string,
    generation: number,
  ): Promise<void> {
    const pendingRequest = this.pendingToolCalls.get(step.id)
    if (!pendingRequest) throw new Error(`tool request is missing for timeline step ${step.id}`)
    const workflowPlanId = typeof step.detail?.workflowPlanId === 'string'
      ? step.detail.workflowPlanId
      : undefined
    const workflowNodeId = typeof step.detail?.workflowNodeId === 'string'
      ? step.detail.workflowNodeId
      : undefined
    const workflowSourceStepId = typeof step.detail?.workflowSourceStepId === 'string'
      ? step.detail.workflowSourceStepId
      : undefined
    const workflowIteration = typeof step.detail?.workflowIteration === 'number'
      ? step.detail.workflowIteration
      : undefined
    const workflowLocals = isObject(step.detail?.workflowLocals)
      ? step.detail.workflowLocals
      : {}
    if (workflowPlanId && ['failed', 'suspended'].includes(this.workflowPlan(workflowPlanId).status)) {
      this.pendingToolCalls.delete(step.id)
      step.detail = {
        ...(step.detail ?? {}),
        workflowSkipped: true,
        reason: 'workflow stopped at a partial result',
      }
      this.updateRuntimeStatus({ queueDepth: this.pendingToolCalls.size }, correlationId)
      return
    }
    const recordedMcp = this.recoverableMcpStep(step, pendingRequest)
    const recordedWorkflowForm = workflowPlanId && workflowNodeId && this.sessionId && this.run.runId
      ? this.projectContextStore.commits.mcpInputs.workflowFormState(this.waitBinding(), workflowPlanId, workflowNodeId, pendingRequest.id) : undefined
    if (!recordedMcp && !recordedWorkflowForm) this.validatePendingCapabilities(pendingRequest)
    if (workflowPlanId && ['resume_mcp_input', 'resume_mcp_write_input'].includes(pendingRequest.name)) throw new Error('MCP_FORM_CONTINUATION_REQUIRES_DIRECT_TOOL_CALL')
    this.childExecution?.assertAuthority()
    let request = pendingRequest
    if (workflowPlanId && workflowNodeId && workflowSourceStepId && !recordedMcp && !recordedWorkflowForm) {
      const definition = this.workflowDefinitions.get(workflowPlanId)?.steps.find(
        (item) => item.id === workflowSourceStepId,
      )
      const data = this.workflowData.get(workflowPlanId)
      if (!definition || !data || (definition.type !== 'tool' && definition.type !== 'foreach')) {
        throw new RuntimeStageError('workflow_execution', 'WORKFLOW_STATE_MISSING', 'workflow tool state is missing')
      }
      if (
        workflowIteration === undefined && !step.detail?.retryMcpArgumentHash &&
        !(await workflowCondition(definition.when, data, workflowLocals))
      ) {
        data.steps[workflowSourceStepId] = { status: 'skipped' }
        step.detail = { ...(step.detail ?? {}), workflowSkipped: true, reason: 'when evaluated to false' }
        this.updateWorkflowNode(workflowPlanId, workflowNodeId, {
          status: 'skipped',
          timelineStepId: step.id,
          startedAt: now(),
          completedAt: now(),
          durationMs: 0,
        }, correlationId)
        this.pendingToolCalls.delete(step.id)
        this.updateRuntimeStatus({ queueDepth: this.pendingToolCalls.size }, correlationId)
        return
      }
      const argumentsValue = await resolveWorkflowValue(definition.arguments, data, workflowLocals)
      if (!isObject(argumentsValue)) {
        throw new RuntimeStageError(
          'workflow_execution',
          'WORKFLOW_ARGUMENT_MAPPING_FAILED',
          `workflow arguments for ${workflowNodeId} did not resolve to an object`,
        )
      }
      request = { ...pendingRequest, arguments: argumentsValue }
      if (step.detail?.retryMcpArgumentHash && step.detail.retryMcpArgumentHash !== createHash('sha256').update(JSON.stringify(argumentsValue)).digest('hex')) {
        throw new RuntimeStageError('workflow_execution', 'WORKFLOW_MCP_RETRY_ARGUMENTS_CHANGED', 'The original Workflow write arguments have changed')
      }
      if (workflowIteration === undefined) data.steps[workflowSourceStepId] = { status: 'running' }
      this.updateWorkflowNode(workflowPlanId, workflowNodeId, {
        status: 'running',
        timelineStepId: step.id,
        startedAt: now(),
      }, correlationId)
    }
    if (recordedMcp && isObject(step.detail?.arguments)) request = { ...pendingRequest, arguments: step.detail.arguments }
    const argumentsValue = toJsonValue(request.arguments)
    const replayed = this.replayParentTakeoverAction(request)
    const startedAt = replayed?.result.startedAt ?? now()
    const processId = `process:${request.id}`
    this.runtimeActivityState.upsertProcess({
      id: processId,
      kind: 'tool',
      name: request.name,
      status: 'running',
      projectId: this.projectDir,
      sessionId: this.sessionId,
      ...(this.run.runId ? { runId: this.run.runId } : {}),
      startedAt,
      detail: {
        executionScope: 'project',
        cwd: isObject(request.arguments) && typeof request.arguments.cwd === 'string'
          ? request.arguments.cwd
          : '.',
      },
    })
    this.snapshotRevision += 1
    this.emit('runtime.processes.updated', this.runtimeActivityState.snapshot().processes, correlationId)
    const projectTool = this.tools.items.find((tool) => tool.name === request.name)
    const internalTool = INTERNAL_RESOURCE_TOOLS.find((tool) => tool.name === request.name)
    const actionArgumentHash = createHash('sha256').update(JSON.stringify(request.arguments)).digest('hex')
    const actionCapabilityId = projectTool?.id ?? internalTool?.name ?? request.name
    const requiresChildActionLease = !!this.childExecution && !this.childReadOnly
      && (projectTool?.sideEffects ?? internalTool?.sideEffects ?? 'none') !== 'none'
    if (requiresChildActionLease) {
      if (!this.childExecution?.authorizeAction) throw new RuntimeStageError('runtime', 'CHILD_ACTION_LEASE_UNAVAILABLE', 'action child has no runtime action lease authority', false)
      this.childExecution.authorizeAction({ callId: request.id, toolName: request.name, capabilityId: actionCapabilityId, argumentHash: actionArgumentHash })
    }
    step.detail = {
      ...(step.detail ?? {}),
      callId: request.id,
      toolName: request.name,
      arguments: argumentsValue,
      ...(recordedMcp?.binding ? { ledgerArgumentHash: recordedMcp.binding.argumentHash } : {}),
      ...(projectTool ? {
        toolId: projectTool.id,
        permissions: projectTool.permissions ?? [],
        sideEffects: projectTool.sideEffects ?? 'none',
        replay: projectTool.replay ?? 'safe',
        inputSchema: projectTool.inputSchema,
      } : {
        toolId: `runtime:${request.name}`,
        permissions: [...internalTool?.permissions ?? []],
        sideEffects: internalTool?.sideEffects ?? 'none',
        replay: internalTool?.replay ?? 'safe',
      }),
    }
    this.updateTimeline({ ...step }, correlationId)
    const observationId = `observation-${this.run.runId}-${request.id}`
    this.upsertObservation({
      id: observationId,
      runId: this.run.runId as string,
      stepId: step.id,
      callId: request.id,
      toolName: request.name,
      status: 'running',
      arguments: argumentsValue,
      startedAt,
    }, correlationId)
    if (!replayed && !recordedMcp && !recordedWorkflowForm) this.emit('tool.call.started', {
      callId: request.id,
      toolName: request.name,
      arguments: argumentsValue,
      startedAt,
    }, correlationId)
    this.updateRuntimeStatus({
      activity: { phase: 'tool_running', label: request.name, startedAt },
    }, correlationId)

    // Callbacks and Workflow mappings may change authority after preparation.
    // Recheck at the runner boundary, before either internal or project dispatch.
    if (!recordedMcp && !recordedWorkflowForm) this.validatePendingCapabilities(pendingRequest)
    this.childExecution?.assertAuthority()
    let result: ToolCallResult
    if (recordedWorkflowForm && recordedMcp?.source.outcome !== 'succeeded') {
      result = { id: request.id, name: request.name, ok: false, source: recordedMcp?.source, startedAt, completedAt: now(), durationMs: 0,
        error: { code: 'MCP_INPUT_REQUIRED', message: 'The original Workflow input record was recovered', details: { requestId: recordedWorkflowForm.id } } }
    } else if (recordedMcp) {
      const source = recordedMcp.continuation?.source ?? this.mcpWriteAttempt(request.id)?.source ?? recordedMcp.source
      const base = { id: request.id, name: request.name, source, startedAt, completedAt: now(), durationMs: 0 }
      result = recordedMcp.source.outcome === 'succeeded' ? { ...base, ok: true, output: recordedMcp.output }
        : { ...base, ok: false, error: { code: 'RECOVERY_BLOCKED', message: 'The original MCP write was recorded and was not dispatched again.',
          details: { operationId: recordedMcp.source.operationId, ...(recordedMcp.verification ? { verification: recordedMcp.verification } : {}) } } }
    } else if (replayed) {
      result = replayed.result
    } else if (projectTool?.origin?.type === 'mcp') {
      const controller = new AbortController()
      this.activeAbortController = controller
      try {
        const settings = this.projectResources.readSettings()
        result = await this.mcp.call(request, settings.mcp_servers, new Set(settings.tool_permissions), controller.signal, step.id,
          !this.childAgentMode && this.sessionId && this.run.runId && isObject(argumentsValue) ? {
            register: (authority, source, data) => this.registerMcpInput({ authority, tool: request.name, args: argumentsValue as JsonObject,
              originCallId: request.id, originStepId: step.id, round: 1,
              ...(workflowPlanId && workflowNodeId ? { workflow: { id: workflowPlanId, nodeId: workflowNodeId } } : {}) }, source, data, correlationId),
          } : undefined)
      } finally { if (this.activeAbortController === controller) this.activeAbortController = undefined }
    } else if (INTERNAL_RESOURCE_TOOLS.some((tool) => tool.name === request.name)) {
      if (request.name === 'run_skill_script' || request.name === 'verify_mcp_side_effect' || request.name === 'resume_mcp_input'
        || request.name === 'resume_mcp_write_input' || (request.name === 'recall_context' && this.contextAssistantEnabled('recall'))
        || (request.name === 'read_child_result' && this.contextAssistantEnabled('parent_merge'))) {
        const controller = new AbortController()
        this.activeAbortController = controller
        try {
          result = await this.executeResourceTool(request, correlationId, step.id)
        } finally {
          if (this.activeAbortController === controller) this.activeAbortController = undefined
        }
      } else {
        result = await this.executeResourceTool(request, correlationId, step.id)
      }
    } else {
      if (!this.tools.items.some((tool) => tool.name === request.name)) {
        throw new Error(`project tool is not loaded: ${request.name}`)
      }
      const controller = new AbortController()
      this.activeAbortController = controller
      try {
        const blocked = blockedToolRequest(this.variables.value.builtin.variables?.runtime_recovery,
          this.run.runId ?? '', request.name, request.arguments)
        result = blocked ? {
          id: request.id, name: request.name, ok: false,
          error: { code: 'INVALID_ARGUMENTS', message: `Runtime recovery: ${blocked}`, details: { code: 'RECOVERY_BLOCKED' } },
          startedAt, completedAt: now(), durationMs: 0,
        } : await this.toolDispatcher.dispatch(request, {
          signal: controller.signal,
          resolveArtifact: (id) => {
            const artifact = this.artifacts.get(id)
            if (!artifact || !['tool-result', 'workflow-result', 'skill-reference', 'skill-script-result'].includes(artifact.meta.kind)) {
              throw new Error('Tool result artifact not found in this session')
            }
            return clone(artifact.value)
          },
          onProgress: (progress) => {
            if (controller.signal.aborted) return
            step.detail = { ...step.detail, networkRetry: toJsonValue(progress) }
            this.updateTimeline(step, correlationId)
            this.updateRuntimeStatus({ activity: {
              phase: 'tool_running', startedAt: now(),
              label: `${request.name} · ${progress.phase} · attempt ${progress.attempt}/${progress.maxAttempts === -1 ? '∞' : progress.maxAttempts} · ${progress.reason} · ${progress.delayMs} ms`,
            } }, correlationId)
            this.createArtifact('hook-log', `Tool network ${progress.phase} · ${request.name}`, {
              callId: request.id, toolName: request.name, ...progress,
            }, correlationId)
          },
        })
      } finally {
        if (this.activeAbortController === controller) this.activeAbortController = undefined
      }
    }
    if (this.closed) return
    const runnerTimedOut = isObject(result.output) && result.output.timed_out === true
    this.runtimeActivityState.updateProcess(
      processId,
      result.ok && !runnerTimedOut ? 'succeeded' : 'failed',
      {
        stoppedAt: now(),
        ...(!result.ok || runnerTimedOut ? {
          error: toJsonValue(result.error ?? (runnerTimedOut
            ? { code: 'TIMEOUT', message: 'process exceeded the tool execution timeout' }
            : { code: 'RUNNER_FAILED', message: 'tool call failed' })),
        } : {}),
      },
    )
    this.snapshotRevision += 1
    this.emit('runtime.processes.updated', this.runtimeActivityState.snapshot().processes, correlationId)
    const resultArtifact = replayed?.artifact ?? this.createArtifact(
      request.name === 'read_skill_resource'
        ? 'skill-reference'
        : request.name === 'run_skill_script' ? 'skill-script-result' : 'tool-result',
      `Tool result · ${request.name}`,
      result.ok
        ? { ok: true, ...(result.source ? { source: result.source } : {}), result: result.output ?? null }
        : { ok: false, ...(result.source ? { source: result.source } : {}), error: result.error ?? null },
      correlationId,
    )
    if (requiresChildActionLease) {
      try {
        this.childExecution?.recordActionResult?.({ callId: request.id, toolName: request.name, capabilityId: actionCapabilityId,
          argumentHash: actionArgumentHash, outcome: result.source?.outcome === 'unknown' ? 'unknown' : result.ok ? 'succeeded' : 'failed',
          resultArtifactId: resultArtifact.id, resultHash: resultArtifact.hash })
      } catch (error) {
        throw new RuntimeStageError('runtime', 'CHILD_ACTION_RESULT_UNRECORDED', error instanceof Error ? error.message : String(error), false)
      }
    }
    if (result.mcpInput && result.ok) {
      const binding = this.waitBinding()
      const raw = this.artifacts.get(resultArtifact.id)!
      const { id, ...origin } = result.mcpInput
      const write = result.source?.operationId ? { source: result.source, output: result.output } : undefined
      this.projectContextStore.commits.saveMcpInputCompletion(binding, id, { ...origin, callId: request.id }, resultArtifact, JSON.stringify(raw.value, null, 2), write)
      if (write) { this.mcp.restoreState(); this.emitMcpInputState(correlationId) }
    }
    const actionSignature = this.toolActionSignature(request)
    let repeatedFailureCount = 0
    let repeatedFailureCode: string | undefined
    if (result.ok) {
      this.repeatedToolFailures.delete(actionSignature)
    } else {
      const errorCode = result.error?.code ?? 'RUNNER_FAILED'
      const previous = this.repeatedToolFailures.get(actionSignature)
      repeatedFailureCount = previous && previous.code === errorCode
        ? previous.count + 1
        : 1
      repeatedFailureCode = errorCode
      this.repeatedToolFailures.set(actionSignature, {
        count: repeatedFailureCount,
        code: errorCode,
      })
    }
    const executionReceipt = this.toolExecutionReceipt(step, request, result, resultArtifact.id)
    if (replayed || recordedMcp || recordedWorkflowForm) executionReceipt.redelivered = true
    if (recordedMcp?.source.outcome === 'succeeded' && hasUnknownToolOutcome(step)) {
      const { unknownOutcome: _unknown, recoveryAction: _recovery, ...detail } = step.detail!
      step.detail = { ...detail, outcome: 'succeeded' }
    }
    step.detail = { ...(step.detail ?? {}), executionReceipt,
      ...(result.source?.outcome === 'unknown' ? { unknownOutcome: true, outcome: 'unknown', recoveryAction: 'verify_mcp_side_effect' } : {}) }
    try { if (!replayed) this.recordParentTakeoverAction(step, request, result, executionReceipt, resultArtifact) }
    catch (error) {
      this.createArtifact('runtime-error', 'Tool result retained; parent takeover proof could not be stored', {
        callId: request.id, resultArtifactId: resultArtifact.id, message: error instanceof Error ? error.message : String(error),
      }, correlationId)
    }
    try { this.recordToolWaitSignal(step) }
    catch (error) { this.createArtifact('runtime-error', 'Tool result retained; wait signal recording failed', { callId: request.id, message: error instanceof Error ? error.message : String(error) }, correlationId) }
    if (result.ok) {
      const output = toJsonValue(result.output)
      step.detail = {
        ...step.detail,
        ok: true,
        resultArtifactId: resultArtifact.id,
        resultPreview: resultArtifact.preview,
        ...(resultArtifact.byteLength <= 4_096 ? { result: output } : {}),
        durationMs: result.durationMs,
      }
      this.emit('tool.call.completed', {
        callId: request.id,
        toolName: request.name,
        result: output,
        receipt: executionReceipt,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        durationMs: result.durationMs,
      }, correlationId)
      this.upsertObservation({
        id: observationId,
        runId: this.run.runId as string,
        stepId: step.id,
        callId: request.id,
        toolName: request.name,
        status: 'completed',
        arguments: argumentsValue,
        resultArtifactId: resultArtifact.id,
        resultPreview: resultArtifact.preview,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        durationMs: result.durationMs,
      }, correlationId)
    } else {
      const error = result.error ?? { code: 'RUNNER_FAILED', message: 'tool call failed' }
      step.detail = {
        ...step.detail,
        ok: false,
        resultArtifactId: resultArtifact.id,
        resultPreview: resultArtifact.preview,
        error: toJsonValue(error),
        durationMs: result.durationMs,
      }
      this.emit('tool.call.failed', {
        callId: request.id,
        toolName: request.name,
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: toJsonValue(error.details) }),
        receipt: executionReceipt,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        durationMs: result.durationMs,
      }, correlationId)
      this.upsertObservation({
        id: observationId,
        runId: this.run.runId as string,
        stepId: step.id,
        callId: request.id,
        toolName: request.name,
        status: 'failed',
        arguments: argumentsValue,
        resultArtifactId: resultArtifact.id,
        resultPreview: resultArtifact.preview,
        error: toJsonValue(error),
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        durationMs: result.durationMs,
      }, correlationId)
    }
    if (this.generation !== generation) return
    if (workflowPlanId && workflowNodeId && workflowSourceStepId) {
      const data = this.workflowData.get(workflowPlanId)
      if (!data) throw new Error(`workflow execution data was not found: ${workflowPlanId}`)
      this.pendingToolCalls.delete(step.id)
      this.updateRuntimeStatus({ queueDepth: this.pendingToolCalls.size }, correlationId)
      if (!result.ok) {
        const operationId = result.source?.outcome === 'unknown' && result.source.rpcRequestId !== undefined ? result.source.operationId : undefined
        const details = result.error?.details
        const inputRequestId = result.error?.code === 'MCP_INPUT_REQUIRED' && isObject(details) && typeof details.requestId === 'string' ? details.requestId : undefined
        const position = { stepId: step.id, nodeId: workflowNodeId }
        const recovery = inputRequestId ? { ...position, inputRequestId, ...(operationId ? { operationId } : {}) }
          : operationId ? { ...position, operationId } : undefined
        for (const [id, state] of Object.entries(data.steps)) {
          if (id !== workflowSourceStepId && (state.status === 'pending' || state.status === 'running')) {
            data.steps[id] = { status: 'skipped' }
          }
        }
        data.steps[workflowSourceStepId] = {
          status: 'failed',
          output: recovery && workflowIteration !== undefined ? data.steps[workflowSourceStepId]?.output
            : { ok: false, error: result.error ?? { message: 'workflow Tool failed' } },
        }
        this.failGeneratedWorkflow(
          workflowPlanId,
          workflowNodeId,
          result.error?.message ?? 'workflow tool failed',
          correlationId,
          recovery,
        )
        step.detail = { ...step.detail, workflowNodeFailed: true }
        return
      }
      this.completeWorkflowToolNode(step, { output: result.output, artifactId: resultArtifact.id, completedAt: now(), durationMs: result.durationMs }, correlationId)
      return
    }
    this.appendRuntimeMessage({
      role: 'tool',
      name: request.name,
      toolCallId: request.id,
      content: this.boundedToolContent(resultArtifact.id, result.ok
        ? { ok: true, runtime_receipt: executionReceipt, result: result.output ?? null }
        : { ok: false, runtime_receipt: executionReceipt, error: result.error }),
    })
    this.publishRenderedMessages(correlationId)
    this.pendingToolCalls.delete(step.id)
    this.updateRuntimeStatus({ queueDepth: this.pendingToolCalls.size }, correlationId)
    if (!result.ok && repeatedFailureCount >= 2) {
      step.detail = {
        ...(step.detail ?? {}),
        repeatGuard: {
          actionSignature,
          count: repeatedFailureCount,
          code: repeatedFailureCode ?? 'RUNNER_FAILED',
          policy: 'stop_after_identical_failure_twice',
        },
      }
      throw new RuntimeStageError(
        'tool_dispatch',
        'REPEATED_TOOL_FAILURE',
        `the same ${request.name} action failed ${repeatedFailureCount} times; automatic retry stopped`,
        false,
        {
          actionSignature,
          toolName: request.name,
          count: repeatedFailureCount,
          errorCode: repeatedFailureCode ?? 'RUNNER_FAILED',
          resultArtifactId: resultArtifact.id,
          policy: 'stop_after_identical_failure_twice',
        },
      )
    }
  }

  private completeWorkflowToolNode(step: TimelineStep, result: { output: unknown; artifactId: string; completedAt: string; durationMs?: number; outputUnavailable?: boolean }, correlationId: string): void {
    const { workflowPlanId, workflowNodeId, workflowSourceStepId, workflowIteration, workflowLocals } = step.detail ?? {}
    const planId = String(workflowPlanId)
    const sourceId = String(workflowSourceStepId)
    const data = this.workflowData.get(planId)
    if (!data) throw new Error(`workflow execution data was not found: ${planId}`)
    const { completedAt } = result
    this.updateWorkflowNode(planId, String(workflowNodeId), { status: 'completed', outputArtifactId: result.artifactId,
      completedAt, durationMs: result.durationMs, error: undefined }, correlationId)
    if (typeof workflowIteration !== 'number') {
      data.steps[sourceId] = { status: 'completed', ...(result.outputUnavailable ? { outputUnavailable: true } : { output: result.output }) }
      return
    }
    const prior = data.steps[sourceId]?.output
    const outputs = Array.isArray(prior) ? [...prior] : []
    outputs[workflowIteration] = { item: isObject(workflowLocals) ? workflowLocals.item ?? null : null,
      ...(result.outputUnavailable ? { outputUnavailable: true } : { output: result.output ?? null }) }
    data.steps[sourceId] = { status: 'running', output: outputs }
    const plan = this.workflowPlan(planId)
    const children = plan.nodes.filter(item => item.parentId === sourceId)
    if (!children.length || !children.every(item => item.status === 'completed')) return
    data.steps[sourceId] = { status: 'completed', output: outputs }
    const aggregate = this.createArtifact('workflow-result', `Workflow foreach result · ${sourceId}`, outputs, correlationId)
    const parent = plan.nodes.find(item => item.id === sourceId)
    this.updateWorkflowNode(planId, sourceId, { status: 'completed', outputArtifactId: aggregate.id, completedAt,
      durationMs: parent?.startedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(parent.startedAt)) : undefined }, correlationId)
  }

  private toolActionSignature(request: ToolCallRequest): string {
    const serialized = JSON.stringify(request.arguments, (_key, value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value
      return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
    }) ?? ''
    return createHash('sha256').update(`${request.name}\0${serialized}`).digest('hex')
  }

  private ensureAssistantStarted(correlationId: string): void {
    if (this.activeAssistantId) return
    this.assistantCounter += 1
    const message: ChatMessage = {
      id: `assistant-${this.assistantCounter}`,
      ...(this.run.runId ? { requestId: this.run.runId } : {}),
      role: 'assistant',
      status: 'streaming',
      content: [{ type: 'text', text: '' }],
      createdAt: now(),
    }
    this.activeAssistantId = message.id
    this.assistantChunkIndex = 0
    this.responseGeneration += 1
    this.messages.push(message)
    this.conversationRevision += 1
    this.snapshotRevision += 1
    this.emit('chat.assistant.started', { message: clone(message) }, correlationId)
  }

  private async completeAssistant(
    response: LlmChatResponse,
    correlationId: string,
    generation: number,
    nativeStream: boolean,
  ): Promise<void> {
    const messageId = this.activeAssistantId
    const message = this.messages.find((item) => item.id === messageId)
    if (!messageId || !message) throw new Error('active assistant message is missing')
    const content = message.content[0] as { type: 'text'; text: string }
    if (!response.text.startsWith(content.text)) {
      // Structured model output is normalized after the provider stream has
      // already been emitted. Providers may stream the JSON envelope while
      // the completed response contains only its user-facing `content`, so a
      // prefix comparison is not meaningful in that case. Replace the
      // in-memory message with the validated completed text and let the final
      // render snapshot reconcile clients. Unstructured streams still require
      // the original prefix invariant.
      if (!nativeStream || response.finishReason === 'length' || response.finishReason === 'cancelled') {
        throw new Error('assistant stream does not match the completed response')
      }
      content.text = response.text
      this.conversationRevision += 1
      this.snapshotRevision += 1
    } else {
      const remaining = response.text.slice(content.text.length)
      const chunks = nativeStream
        ? (remaining ? [remaining] : [])
        : (remaining.match(/[\s\S]{1,256}/g) ?? (remaining ? [remaining] : []))
      for (const delta of chunks) {
        if (!nativeStream && this.streamDelayMs > 0) await sleep(this.streamDelayMs)
        if (this.generation !== generation) return
        this.appendAssistantDelta(delta, correlationId)
      }
    }
    message.status = 'completed'
    message.completedAt = now()
    this.activeAssistantId = undefined
    this.conversationRevision += 1
    this.snapshotRevision += 1
    this.emit('chat.assistant.completed', {
      messageId,
      finishReason: response.finishReason?.includes('length') ? 'length' : 'stop',
      usage: clone(this.runUsage),
      completedAt: message.completedAt,
    }, correlationId)
    this.renderAndPublish(correlationId)
    this.updateRuntimeStatus({ model: 'ready', queueDepth: 0 }, correlationId)
  }

  private appendAssistantDelta(delta: string, correlationId: string): void {
    const messageId = this.activeAssistantId
    const message = this.messages.find((item) => item.id === messageId)
    if (!messageId || !message || !delta) return
    const content = message.content[0] as { type: 'text'; text: string }
    content.text += delta
    this.emit('chat.assistant.delta', {
      messageId,
      channel: 'final',
      chunkIndex: this.assistantChunkIndex,
      delta,
    }, correlationId)
    this.assistantChunkIndex += 1
  }

  private failAssistant(failure: RuntimeFailure, correlationId: string): void {
    const messageId = this.activeAssistantId
    if (!messageId) return
    const message = this.messages.find((item) => item.id === messageId)
    if (message) {
      message.status = 'failed'
      message.failure = clone(failure)
      message.completedAt = now()
    }
    this.activeAssistantId = undefined
    this.conversationRevision += 1
    this.snapshotRevision += 1
    this.emit('chat.assistant.failed', {
      messageId,
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
      failure: clone(failure),
    }, correlationId)
  }

  private insertToolRound(
    afterIndex: number,
    calls: LlmToolCall[],
    correlationId: string,
    projection: RuntimeCapabilityProjection,
  ): void {
    this.validateCapabilityCalls(calls, projection)
    const isWorkflowCall = (call: LlmToolCall) => call.name === 'execute_workflow' || call.name === 'resume_workflow'
    const workflowCalls = calls.filter(isWorkflowCall)
    if (workflowCalls.length > 0 && calls.length !== 1) {
      throw new RuntimeStageError(
        'model_protocol',
        'WORKFLOW_CALL_MUST_BE_EXCLUSIVE',
        'A Workflow operation must be the only tool call in a model response',
      )
    }
    const ids = new Set<string>()
    const toolSteps = calls.map((call, index): TimelineStep => {
      if (ids.has(call.id)) throw new Error(`model returned duplicate tool call id: ${call.id}`)
      ids.add(call.id)
      const workflow = isWorkflowCall(call)
      const step: TimelineStep = {
        id: `step-tool-${this.toolRound}-${index}-${call.id}`,
        index: 0,
        type: workflow ? 'workflow' : 'tool',
        status: 'pending',
        summary: `${call.name} (${call.id})`,
        detail: {
          callId: call.id,
          toolName: call.name,
          arguments: toJsonValue(call.arguments),
          capabilityProjectionId: projection.id,
          capabilityRequestId: projection.request.requestId,
          capabilityPhase: projection.execution.phase,
          ...(workflow ? { workflowNodeType: call.name === 'resume_workflow' ? 'resume' : 'plan' } : {}),
        },
      }
      const request = {
        id: call.id,
        name: call.name,
        arguments: call.arguments,
        authorization: { projection, admittedStateRevision: this.taskControl.stateRevision },
      }
      if (workflow) this.pendingWorkflowCalls.set(step.id, request)
      else this.pendingToolCalls.set(step.id, request)
      return step
    })
    const nextModel: TimelineStep = {
      id: `step-model-${this.toolRound}`,
      index: 0,
      type: 'model',
      status: 'pending',
      summary: `工具结果回传模型（第 ${this.toolRound} 轮）`,
    }
    this.timeline.splice(afterIndex + 1, 0, ...toolSteps, nextModel)
    this.timeline = this.timeline.map((step, index) => ({ ...step, index }))
    for (let index = afterIndex + 1; index < this.timeline.length; index += 1) {
      this.updateTimeline(this.timeline[index] as TimelineStep, correlationId)
    }
  }

  private insertContinuation(afterIndex: number, correlationId: string): void {
    const nextModel: TimelineStep = {
      id: `step-model-continuation-${this.continuationRound}`,
      index: 0,
      type: 'model',
      status: 'pending',
      summary: `继续模型循环（第 ${this.continuationRound} 轮）`,
    }
    this.timeline.splice(afterIndex + 1, 0, nextModel)
    this.timeline = this.timeline.map((step, index) => ({ ...step, index }))
    for (let index = afterIndex + 1; index < this.timeline.length; index += 1) {
      this.updateTimeline(this.timeline[index] as TimelineStep, correlationId)
    }
  }

  private addUsage(usage?: LlmUsage): void {
    if (!usage) return
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens'] as const) {
      if (usage[key] !== undefined) this.runUsage[key] = (this.runUsage[key] ?? 0) + usage[key]
    }
  }

  private modelInvocationError(error: unknown): RuntimeStageError {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof RuntimeModelBudgetError) return new RuntimeStageError('runtime', error.code, message, false)
    if (message.includes('TOKEN_BUDGET_EXHAUSTED')) {
      return new RuntimeStageError('runtime', 'TOKEN_BUDGET_EXHAUSTED', message, false)
    }
    const responseValidation = error instanceof LlmResponseValidationError
    const protocolFailure = responseValidation || /invalid JSON|SSE events|tool messages require|stream.*event/i.test(message)
    const diagnostics = error instanceof LlmRequestError
      ? toJsonValue(error.diagnostics)
      : undefined
    // Provider outages are transparent retry conditions. Context/payload
    // failures are deterministic and must consume the run budget instead.
    const contextLimit = isLlmContextLimitError(error)
    const requestRejected = isLlmRequestRejection(error)
    return new RuntimeStageError(
      contextLimit || protocolFailure ? 'model_protocol' : 'model_transport',
      contextLimit
        ? 'MODEL_CONTEXT_LIMIT'
        : requestRejected
          ? 'MODEL_REQUEST_REJECTED'
          : responseValidation
            ? 'MODEL_OUTPUT_INVALID'
            : protocolFailure
              ? 'MODEL_PROTOCOL_ERROR'
              : 'MODEL_TRANSPORT_ERROR',
      message,
      !contextLimit,
      diagnostics,
    )
  }

  private recordFailure(
    error: unknown,
    step: TimelineStep,
    correlationId: string,
  ): RuntimeFailure {
    const message = error instanceof Error ? error.message : String(error)
    const staged = error instanceof RuntimeStageError ? error : undefined
    const phase: RuntimeFailurePhase = staged?.phase ?? (
      step.type === 'model'
        ? 'model_transport'
        : step.type === 'tool'
          ? 'tool_dispatch'
          : step.type === 'workflow'
            ? 'workflow_execution'
          : step.type === 'render'
            ? 'template'
            : 'runtime'
    )
    const code = staged?.code ?? (
      phase === 'tool_dispatch'
        ? 'TOOL_DISPATCH_ERROR'
        : phase === 'template'
          ? 'TEMPLATE_RUNTIME_ERROR'
          : phase === 'model_transport'
            ? 'MODEL_TRANSPORT_ERROR'
            : 'RUNTIME_STEP_ERROR'
    )
    const requestArtifactId = typeof step.detail?.requestArtifactId === 'string'
      ? step.detail.requestArtifactId
      : undefined
    const responseArtifactId = typeof step.detail?.responseArtifactId === 'string'
      ? step.detail.responseArtifactId
      : undefined
    const timestamp = now()
    const errorArtifact = this.createArtifact(
      'runtime-error',
      `Runtime failure · ${code}`,
      {
        phase,
        code,
        message,
        retryable: staged?.retryable ?? false,
        stepId: step.id,
        requestArtifactId: requestArtifactId ?? null,
        responseArtifactId: responseArtifactId ?? null,
        ...(staged?.diagnostics === undefined ? {} : { diagnostics: staged.diagnostics }),
        timestamp,
      },
      correlationId,
    )
    if (step.type === 'tool') {
      const observation = this.observations.find(
        (item) => item.stepId === step.id && item.status === 'running',
      )
      if (observation) {
        this.upsertObservation({
          ...observation,
          status: 'failed',
          resultArtifactId: errorArtifact.id,
          resultPreview: errorArtifact.preview,
          error: { code, message },
          completedAt: timestamp,
        }, correlationId)
      }
    }
    return {
      phase,
      code,
      message,
      retryable: staged?.retryable ?? false,
      stepId: step.id,
      ...(requestArtifactId ? { requestArtifactId } : {}),
      ...(responseArtifactId ? { responseArtifactId } : {}),
      errorArtifactId: errorArtifact.id,
      timestamp,
    }
  }

  private createArtifact(
    kind: RuntimeArtifactKind,
    label: string,
    value: unknown,
    correlationId?: string,
    redacted = false,
  ): RuntimeArtifactMeta {
    const normalized = toJsonValue(value)
    const text = typeof normalized === 'string'
      ? normalized
      : JSON.stringify(normalized, null, 2)
    const meta: RuntimeArtifactMeta = {
      id: `artifact-${kind}-${randomUUID()}`,
      kind,
      label,
      contentType: typeof normalized === 'string' ? 'text/plain' : 'application/json',
      byteLength: Buffer.byteLength(text),
      hash: createHash('sha256').update(text).digest('hex'),
      preview: text.length > 640 ? `${text.slice(0, 640)}\n...` : text,
      redacted,
      ...(this.run.runId ? { runId: this.run.runId } : {}),
      ...(this.run.currentStepId ? { stepId: this.run.currentStepId } : {}),
      createdAt: now(),
    }
    this.artifacts.set(meta.id, { meta, value: normalized })
    this.artifactItems.push(meta)
    this.artifactRevision += 1
    this.snapshotRevision += 1
    this.emit('runtime.artifact.created', { artifact: clone(meta) }, correlationId)
    return meta
  }

  private publishArtifact(artifactId: string, correlationId: string): void {
    const artifact = this.artifacts.get(artifactId)
    if (!artifact) throw new CommandError('NOT_FOUND', 'runtime artifact was not found')
    this.emit('runtime.artifact.content', clone({
      artifact: artifact.meta,
      value: artifact.value,
    }), correlationId)
  }

  private publishArtifactPage(
    artifactId: string,
    page: number,
    pageSize: number,
    correlationId: string,
  ): void {
    const artifact = this.artifacts.get(artifactId)
    if (!artifact) throw new CommandError('NOT_FOUND', 'runtime artifact was not found')
    const artifactValue = artifact.value
    const normalizedPage = Math.max(1, Math.trunc(page))
    const normalizedPageSize = Math.max(1, Math.trunc(pageSize))
    const arrayValue = Array.isArray(artifactValue) ? artifactValue : undefined
    const isArray = arrayValue !== undefined
    const serialized = isArray
      ? undefined
      : typeof artifactValue === 'string'
        ? artifactValue
        : JSON.stringify(artifactValue, null, 2)
    const totalItems = isArray
      ? arrayValue.length
      : (serialized ?? '').length
    const totalPages = Math.max(1, Math.ceil(totalItems / normalizedPageSize))
    if (normalizedPage > totalPages) {
      throw new CommandError('NOT_FOUND', `runtime artifact page ${normalizedPage} was not found`)
    }
    const start = (normalizedPage - 1) * normalizedPageSize
    const value = isArray
      ? arrayValue.slice(start, start + normalizedPageSize)
      : (serialized ?? '').slice(start, start + normalizedPageSize)
    this.emit('runtime.artifact.page', {
      artifact: clone(artifact.meta),
      page: normalizedPage,
      pageSize: normalizedPageSize,
      totalPages,
      totalItems,
      unit: isArray ? 'items' : 'characters',
      value: clone(value),
    }, correlationId)
  }

  private readVariablePath(pointer: string): JsonValue {
    const tokens = decodePointer(pointer)
    if (tokens.length === 0) return clone(this.variables.value) as unknown as JsonValue
    let current: JsonValue = this.variables.value as unknown as JsonValue
    for (const token of tokens) {
      assertSafeToken(token)
      if (Array.isArray(current)) {
        const index = Number.parseInt(token, 10)
        if (!Number.isInteger(index) || index < 0 || index >= current.length) {
          throw new CommandError('NOT_FOUND', `variable path was not found: ${pointer}`)
        }
        current = current[index] as JsonValue
      } else if (typeof current === 'object' && current !== null && token in current) {
        current = current[token] as JsonValue
      } else {
        throw new CommandError('NOT_FOUND', `variable path was not found: ${pointer}`)
      }
    }
    return clone(current)
  }

  private publishVariablePage(
    pointer: string,
    page: number,
    pageSize: number,
    correlationId: string,
  ): void {
    const value = this.readVariablePath(pointer)
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    const normalizedPage = Math.max(1, Math.trunc(page))
    const normalizedPageSize = Math.max(1, Math.trunc(pageSize))
    const totalCharacters = text.length
    const totalPages = Math.max(1, Math.ceil(totalCharacters / normalizedPageSize))
    if (normalizedPage > totalPages) {
      throw new CommandError('NOT_FOUND', `variable page ${normalizedPage} was not found`)
    }
    const start = (normalizedPage - 1) * normalizedPageSize
    this.emit('runtime.variable.page', {
      path: pointer,
      revision: this.variables.revision,
      page: normalizedPage,
      pageSize: normalizedPageSize,
      totalPages,
      totalCharacters,
      value: text.slice(start, start + normalizedPageSize),
    }, correlationId)
  }

  private upsertObservation(
    observation: RuntimeObservation,
    correlationId: string,
  ): void {
    const artifact = observation.resultArtifactId ? this.artifacts.get(observation.resultArtifactId) : undefined
    const enrichedObservation = observation.status === 'completed'
      && artifact
      && observation.entitySnapshots === undefined
      ? {
          ...observation,
          entitySnapshots: extractRuntimeEntitySnapshots(
            artifact.value,
            artifact.meta.id,
            observation.completedAt ?? observation.startedAt,
            observation.toolName,
          ),
        }
      : observation
    const index = this.observations.findIndex((item) => item.id === enrichedObservation.id)
    if (index >= 0) this.observations[index] = enrichedObservation
    else this.observations.push(enrichedObservation)
    if (enrichedObservation.status !== 'running') {
      const before = this.contextDocumentEngine.exportState()
      this.contextDocumentEngine.observe({
        candidate: {
          source: {
            actor: 'tool',
            sourceId: enrichedObservation.id,
            toolName: enrichedObservation.toolName,
            runId: enrichedObservation.runId,
            stepId: enrichedObservation.stepId,
            capturedAt: enrichedObservation.completedAt ?? enrichedObservation.startedAt,
          },
          rawArtifactId: enrichedObservation.resultArtifactId ?? `observation:${enrichedObservation.id}`,
          normalizedContent: enrichedObservation.resultPreview ?? (enrichedObservation.error ? JSON.stringify(enrichedObservation.error) : ''),
        },
        evidence: {
          kind: artifact ? 'artifact' : 'observation',
          referenceId: artifact?.meta.id ?? enrichedObservation.id,
          ...(this.sessionId ? { sessionId: this.sessionId } : {}),
          ...(artifact ? { sourceHash: artifact.meta.hash } : {}),
          observedAt: enrichedObservation.completedAt ?? enrichedObservation.startedAt,
          confidence: enrichedObservation.status === 'completed' ? 'medium' : 'low',
        },
      })
      if (this.contextDocumentEngine.snapshot().revision !== before.document.revision) this.persistSessionContext(before)
    }
    this.observationRevision += 1
    this.snapshotRevision += 1
    this.emit('runtime.observation.upserted', {
      revision: this.observationRevision,
      observation: clone(enrichedObservation),
    }, correlationId)
  }

  private captureEffectiveContext(
    step: TimelineStep,
    request: LlmChatRequest,
    requestArtifactId: string,
    correlationId: string,
  ): RuntimeEffectiveContextRevision {
    const messagesArtifact = this.createArtifact(
      'effective-messages',
      `Effective messages · step ${step.index + 1}`,
      request.messages,
      correlationId,
    )
    const toolsArtifact = this.createArtifact(
      'effective-tools',
      `Effective tools · step ${step.index + 1}`,
      request.tools ?? [],
      correlationId,
    )
    const previous = this.effectiveContextItems.at(-1)
    const previousEffective = previous
      ? JSON.stringify({
          messages: this.artifacts.get(previous.messagesArtifactId)?.value ?? [],
          tools: this.artifacts.get(previous.toolsArtifactId)?.value ?? [],
        }, null, 2)
      : undefined
    const currentEffective = JSON.stringify({
      messages: request.messages,
      tools: request.tools ?? [],
    }, null, 2)
    const diffArtifact = previousEffective === undefined
      ? undefined
      : this.createArtifact(
          'context-diff',
          `Effective context diff · step ${step.index + 1}`,
          textDiff(previousEffective, currentEffective),
          correlationId,
        )
    const context: RuntimeEffectiveContextRevision = {
      id: `effective-context-${this.effectiveContextRevision + 1}-${randomUUID()}`,
      runId: this.run.runId as string,
      stepId: step.id,
      ...(this.activeContextRevisionId
        ? { contextRevisionId: this.activeContextRevisionId }
        : {}),
      requestArtifactId,
      messagesArtifactId: messagesArtifact.id,
      toolsArtifactId: toolsArtifact.id,
      ...(diffArtifact ? { diffArtifactId: diffArtifact.id } : {}),
      createdAt: now(),
    }
    this.effectiveContextItems.push(context)
    this.effectiveContextRevision += 1
    this.snapshotRevision += 1
    this.emit('runtime.effectiveContext.created', {
      revision: this.effectiveContextRevision,
      context: clone(context),
    }, correlationId)

    for (const observation of this.observations.filter(
      (item) => item.status !== 'running' && !item.consumedByRequestArtifactId,
    )) {
      this.upsertObservation({
        ...observation,
        consumedByRequestArtifactId: requestArtifactId,
        consumedByStepId: step.id,
      }, correlationId)
    }
    return context
  }

  private observeV2Candidate(observation: RuntimeContextObservation, correlationId: string): void {
    const scope = observation.scope ?? 'session'
    const engine = this.contextEngineForScope(scope)
    const document = engine.snapshot()
    if (observation.documentId !== undefined && observation.documentId !== document.id) {
      throw new CommandError('INVALID_PAYLOAD', `runtime.context.v2.observe documentId does not match the active ${scope} document`)
    }
    if (scope === 'project') {
      const errorCode = this.projectObservationGate(observation, engine)
      if (errorCode) throw new CommandError('INVALID_PAYLOAD', errorCode)
    }
    const previousState = engine.exportState()
    const result = engine.observe({
      candidate: {
        source: observation.candidate.source,
        rawArtifactId: observation.candidate.rawArtifactId,
        normalizedContent: observation.candidate.normalizedContent,
        ...(observation.candidate.classification ? { classification: observation.candidate.classification } : {}),
      },
      ...(observation.evidence ? { evidence: { ...observation.evidence, ...(this.sessionId ? { sessionId: this.sessionId } : {}) } } : {}),
    })
    if (engine.snapshot().revision !== document.revision) this.persistContextMutation(scope, previousState)
    this.snapshotRevision += 1
    const candidate = result.candidate
    this.emit('runtime.context.v2.observed', {
      candidate: {
        id: candidate.id,
        actor: candidate.source.actor,
        sourceId: candidate.source.sourceId,
        capturedAt: candidate.source.capturedAt,
        ...(candidate.source.toolName ? { toolName: candidate.source.toolName } : {}),
        ...(candidate.source.runId ? { runId: candidate.source.runId } : {}),
        ...(candidate.source.stepId ? { stepId: candidate.source.stepId } : {}),
        rawArtifactId: candidate.rawArtifactId,
        status: candidate.status,
        evidenceRefs: candidate.evidenceRefs,
        proposedDiffIds: candidate.proposedDiffIds,
        createdAt: candidate.createdAt,
        ...(candidate.reviewedAt ? { reviewedAt: candidate.reviewedAt } : {}),
        ...(candidate.classification ? { classification: candidate.classification } : {}),
      },
      ...(result.evidence ? { evidence: result.evidence } : {}),
    }, correlationId)
  }

  private publishV2Projection(
    profileId: string,
    maxCharacters: number,
    includeTools: boolean,
    correlationId: string,
    candidateSelection: 'chronological' | 'anchor-latest' = 'chronological',
    scope: RuntimeContextScopeKind = 'session',
    includeStatuses?: ContextCandidateStatus[],
    includeStructure = false,
  ): void {
    const engine = this.contextEngineForScope(scope)
    if (scope === 'session') {
      this.syncV2StaticSections(this.renderResult.messages[0]?.content ?? '')
      this.syncV2DynamicSections()
    }
    const projection = engine.project({ id: profileId, maxCharacters, includeTools, includeStructure, candidateSelection, ...(includeStatuses ? { includeStatuses } : {}) })
    this.persistPublishedProjections('inspection', correlationId, [{ scope, state: engine.exportState(), projection }])
    const artifact = this.createArtifact(
      'context-render',
      `V2 context projection · ${profileId}`,
      projection.markdown,
      correlationId,
    )
    const value: RuntimeContextProjection = {
      scope,
      id: projection.id,
      documentRevision: projection.documentRevision,
      profileId: projection.profileId,
      sourceEntryIds: projection.sourceEntryIds,
      ...(projection.treeNodes ? { treeNodes: projection.treeNodes } : {}),
      sourceCandidateIds: projection.sourceCandidateIds,
      sourceMessageCursor: projection.sourceMessageCursor,
      truncatedSections: projection.truncatedSections,
      selectionReasons: projection.selectionReasons,
      contentArtifactId: artifact.id,
      contentHash: projection.contentHash,
      createdAt: projection.createdAt,
    }
    this.emit('runtime.context.v2.projection.created', {
      projection: value,
      markdownArtifactId: artifact.id,
    }, correlationId)
  }

  private applyV2Proposal(proposal: RuntimeContextDiffProposal, correlationId: string, publishedSourceChecked = false): void {
    const scope = proposal.scope ?? 'session'
    let engine = this.contextEngineForScope(scope)
    const trainingSampleId = this.recordTrainingProposal([proposal])
    const previousState = engine.exportState()
    const previousRevision = engine.snapshot().revision
    let effectiveProposal = proposal
    let promotionError: string | undefined
    try { if (!publishedSourceChecked) this.projectContextStore.commits.assertPublishedProjection(this.sessionId!, scope, proposal) }
    catch (error) { promotionError = error instanceof Error ? error.message : String(error) }
    if (!promotionError && scope === 'project' && proposal.sourceScope === 'session') {
      try {
        const binding = new Map(previousState.projections).get(proposal.projectionId)
        if (!binding || binding.documentRevision !== proposal.baseRevision || proposal.baseRevision !== previousRevision || binding.contentHash !== proposal.projectionHash) throw new Error('PROJECTION_BINDING_CONFLICT')
        if (proposal.target.entryId && !binding.sourceEntryIds?.includes(proposal.target.entryId)) throw new Error('ENTRY_NOT_IN_PROJECTION')
        if ((CONTEXT_TREE_OPERATIONS as readonly string[]).includes(proposal.operation)) {
          const error = contextTreeProposalError(proposal, binding.treeNodes)
          if (error) throw new Error(error)
        }
        this.promoteSessionCandidateToProject(proposal.candidateId)
        effectiveProposal = this.rebaseProjectProposal(proposal)
      } catch (error) {
        this.projectContextDocumentEngine = new ContextDocumentEngine(
          previousState.document,
          previousState.receipts,
          previousState.projections,
          previousState.reviewReceipts,
          previousState.evidenceReviewReceipts,
        )
        engine = this.contextEngineForScope(scope)
        promotionError = error instanceof Error ? error.message : 'PROJECT_PROMOTION_FAILED'
      }
    }
    if (!promotionError && scope === 'project') promotionError = this.projectProposalGate(effectiveProposal, engine)
    let receipt = promotionError
      ? this.projectPromotionRejection(proposal, engine, promotionError)
      : engine.apply(this.engineProposal(effectiveProposal))
    if (scope === 'project' && receipt.result !== 'applied' && proposal.sourceScope === 'session') {
      this.projectContextDocumentEngine = new ContextDocumentEngine(previousState.document, previousState.receipts, previousState.projections, previousState.reviewReceipts, previousState.evidenceReviewReceipts)
      receipt = this.projectContextDocumentEngine.rejectProposal(this.engineProposal(proposal), receipt.errorCode ?? 'PROJECT_PROPOSAL_REJECTED')
    }
    const outcome = (): ContextOutcome => ({ scope, proposal: this.engineProposal(effectiveProposal), receipt, correlationId })
    if (scope === 'session') this.persistSessionContext(previousState, [outcome()])
    if (scope === 'project') {
      try {
        if (receipt.result === 'applied') this.persistProjectContext(previousRevision, [outcome()])
        else this.projectContextStore.commits.recordOutcomes(this.sessionId!, [outcome()])
      } catch (error) {
        this.projectContextDocumentEngine = new ContextDocumentEngine(
          previousState.document,
          previousState.receipts,
          previousState.projections,
          previousState.reviewReceipts,
          previousState.evidenceReviewReceipts,
        )
        throw error
      }
    }
    try { this.completeTrainingProposal(trainingSampleId, [proposal], [receipt], { [scope]: previousState }) }
    catch (error) { this.createArtifact('runtime-error', 'Context outcome saved; training recording failed', { code: error instanceof Error ? error.message : String(error), receiptId: receipt.id }, correlationId) }
    this.snapshotRevision += 1
    this.emit('runtime.context.v2.receipt.created', { receipt }, correlationId)
  }

  /**
   * RuntimeCompletionCheck.requiredActions uses stable action IDs rather than
   * natural-language claims. A successful tool can be addressed by its
   * canonical name, `tool:<name>`, its call ID, or its timeline step ID. The
   * argument-hash form is useful when a task needs to distinguish two calls
   * to the same tool: `tool:<name>#<sha256(JSON arguments)>`.
   */
  private missingCompletionEvidence(refs: readonly string[]): string[] {
    const known = new Set([
      ...this.contextDocumentEngine.snapshot().evidence,
      ...this.projectContextDocumentEngine.snapshot().evidence,
    ].map((item) => item.id))
    return refs.filter((id) => !known.has(id))
  }

  private resolveFileReply(content: string, quotes: NonNullable<ModelOutput['fileQuotes']>, publications: ContextPublication[],
    publicationId: string, modelMessages: readonly LlmMessage[]) {
    const sessionId = this.sessionId
    if (!sessionId) throw new Error('FILE_QUOTE_SESSION_REQUIRED')
    const store = this.projectContextStore.commits
    const resolveExcerpt = createFileEvidenceResolver((id, sourceSessionId) => store.readSource(id, sourceSessionId))
    const sources = new Map<RuntimeContextScopeKind, { document: ContextDocument; evidenceIds: Set<string>; projectionId: string }>()
    const receipts: Array<NonNullable<ModelOutput['fileQuotes']>[number] & { referenceId: string; sourceHash: string | undefined;
      file: string; line: number; projectionId?: string; publicationId?: string; excerptHash: string }> = []
    const rendered = renderFileQuotes(content, quotes, (quote, target) => {
      if ('readArtifactId' in quote) {
        if (typeof target.file !== 'string' || typeof target.line !== 'number' || !Number.isSafeInteger(target.line) || target.line < 1) {
          throw new Error('FILE_QUOTE_TARGET_LOCATION_REQUIRED')
        }
        const excerpt = publishedFileReadLine(modelMessages, quote.readArtifactId, target.file, target.line, id => store.readSource(id, sessionId))
        if (!excerpt) throw new Error('FILE_QUOTE_EVIDENCE_NOT_AVAILABLE')
        receipts.push({ ...quote, referenceId: quote.readArtifactId, sourceHash: excerpt.sourceHash, publicationId,
          file: excerpt.file, line: excerpt.line, excerptHash: createHash('sha256').update(excerpt.text).digest('hex') })
        return excerpt
      }
      let source = sources.get(quote.scope)
      if (!source) {
        const published = publications.find(view => view.scope === quote.scope)
        if (!published) throw new Error('FILE_QUOTE_SCOPE_NOT_PUBLISHED')
        const { projection, state: { document } } = published
        store.assertPublishedProjection(sessionId, quote.scope, { documentId: document.id, projectionId: projection.id,
          baseRevision: projection.documentRevision, projectionHash: projection.contentHash }, 'model', publicationId)
        const current = store.loadDocument(quote.scope === 'session' ? sessionId : undefined, { observe: false })?.document
        if (!current || contextKnowledgeHash(current) !== contextKnowledgeHash(document)) throw new Error('FILE_QUOTE_DOCUMENT_CHANGED')
        const entries = new Set(projection.sourceEntryIds), candidates = new Set(projection.sourceCandidateIds)
        const evidenceIds = new Set([
          ...document.information.filter(entry => entries.has(entry.id)).flatMap(entry => entry.evidenceRefs),
          ...document.candidates.filter(candidate => candidates.has(candidate.id)).flatMap(candidate => candidate.evidenceRefs),
        ])
        source = { document, evidenceIds, projectionId: projection.id }
        sources.set(quote.scope, source)
      }
      const evidence = source.evidenceIds.has(quote.evidenceId) && source.document.evidence.find(item => item.id === quote.evidenceId)
      const excerpt = evidence && resolveExcerpt(evidence, source.document.sessionId, quote.scope)
      if (!evidence || !excerpt) throw new Error('FILE_QUOTE_EVIDENCE_NOT_AVAILABLE')
      receipts.push({ ...quote, referenceId: evidence.referenceId, sourceHash: evidence.sourceHash, file: excerpt.file, line: excerpt.line,
        projectionId: source.projectionId, excerptHash: createHash('sha256').update(excerpt.text).digest('hex') })
      return excerpt
    })
    return { content: rendered, receipts }
  }

  private recordEnvelopeObligations(envelope: RuntimeEnvelope): void {
    this.taskControl.requiredActions = [...new Set([...this.taskControl.requiredActions, ...envelope.completionCheck?.requiredActions ?? []])]
    this.taskControl.requiredEvidenceRefs = [...new Set([...this.taskControl.requiredEvidenceRefs, ...envelope.completionCheck?.requiredEvidenceRefs ?? []])]
    const uncertainties = new Map(this.taskControl.uncertainties.map((item) => [item.id, item]))
    for (const item of envelope.uncertainties) {
      const previous = uncertainties.get(item.id)
      const resolution = envelope.sourceV2?.uncertainties.find((entry) => entry.id === item.id)
      if (previous?.blocking && !item.blocking
        && (!resolution?.evidenceRefs.length || this.missingCompletionEvidence(resolution.evidenceRefs).length)) continue
      uncertainties.set(item.id, clone(item))
    }
    this.taskControl.uncertainties = [...uncertainties.values()]
    this.taskControl.stateRevision += 1
  }

  private validateTaskCompletion(envelope: RuntimeEnvelope | undefined, correlationId: string): void {
    if (envelope && envelope.decision !== 'finish') throw new RuntimeStageError('model_protocol', 'RUNTIME_ENVELOPE_COMPLETION_DECISION', 'only finish may request completion', true)
    const blockers: string[] = []
    if (['waiting', 'awaiting_user', 'awaiting_evidence'].includes(this.v2ControlState.status)) blockers.push(this.v2ControlState.status)
    if (this.pendingToolCalls.size || this.pendingWorkflowCalls.size) blockers.push('pending_tools')
    if (this.workflows.items.some(plan => plan.runId === this.run.runId && ['failed', 'suspended'].includes(plan.status) && plan.recovery)) blockers.push('unresolved_workflow_recovery')
    const verifiedMcpOperations = this.verifiedMcpOperations()
    if (this.timeline.some(step => hasUnknownToolOutcome(step) && !this.isMcpStepSettled(step, verifiedMcpOperations))) blockers.push('unknown_side_effect')
    if (this.projectContextStore.commits.loadUnknownMcpOperations(this.sessionId ?? this.contextDocumentEngine.snapshot().sessionId).length) blockers.push('unknown_mcp_side_effect')
    if (this.mcpInputViews().length) blockers.push('pending_mcp_input')
    if (this.auxiliaryRunner && this.auxiliaryRunner.store.list(this.childBinding()).some(record => record.status === 'running')) blockers.push('pending_auxiliary')
    if (this.childService && this.childService.store.list(this.childBinding()).some(record => !terminalChild(record.status)
      || !record.consumption || record.consumption.decision === 'needs_more_evidence')) blockers.push('unconsumed_children')
    if (this.waitStore && this.waitStore.read(this.waitBinding()).subscriptions.some(wait => wait.status === 'pending')) blockers.push('pending_waits')
    if (this.taskControl.tasks.some((task) => task.status !== 'completed')) blockers.push('unfinished_tasks')
    if (this.taskControl.tasks.some(task => task.status === 'completed'
      && this.taskControl.childAssignments?.some(item => item.planTaskId === task.id && item.state === 'parent')
      && !this.verifyParentTakeover(task))) blockers.push('unverified_parent_takeover')
    if (this.taskControl.uncertainties.some((item) => item.blocking)) blockers.push('blocking_uncertainty')
    if (this.runtimeActivityState.snapshot().children.items.some((child) => child.parentRunId === this.run.runId
      && ['delegated', 'queued', 'running', 'waiting', 'unknown'].includes(child.status))) blockers.push('pending_children')
    const missingActions = this.missingRuntimeCompletionActions(this.taskControl.requiredActions)
    const missingEvidence = this.missingCompletionEvidence(this.taskControl.requiredEvidenceRefs)
    if (missingActions.length) throw new RuntimeStageError('model_protocol', 'RUNTIME_ENVELOPE_ACTIONS_INCOMPLETE', `unfinished task obligations: ${missingActions.join(', ')}`, true)
    if (missingEvidence.length) throw new RuntimeStageError('model_protocol', 'RUNTIME_ENVELOPE_EVIDENCE_MISSING', `missing task evidence: ${missingEvidence.join(', ')}`, true)
    if (blockers.length) throw new RuntimeStageError('model_protocol', 'RUNTIME_TASK_COMPLETION_BLOCKED', `task has unresolved runtime state: ${blockers.join(', ')}`, true, { blockers })
    this.createArtifact('context-diff', 'Runtime completion verification', {
      taskId: this.taskControl.taskId, stateRevision: this.taskControl.stateRevision,
      verified: true, requiredActions: clone(this.taskControl.requiredActions), requiredEvidenceRefs: clone(this.taskControl.requiredEvidenceRefs),
    }, correlationId)
  }

  private missingRuntimeCompletionActions(requiredActions: readonly string[]): string[] {
    if (requiredActions.length === 0) return []
    const completed = this.completedRuntimeActionKeys()
    return requiredActions.filter((action) => !completed.has(action))
  }

  private assertNewPlanReferences(tasks: readonly RuntimePlanTask[], capabilities: readonly RuntimeCapability[]): void {
    const previous = new Map(this.taskControl.tasks.map(task => [task.id, task]))
    const contextActions = this.contextPlanActionRefs()
    const branchReplies = this.branchHumanReplyReceipts()
    const owners = this.planActionOwners(contextActions, branchReplies)
    const successful = this.completedRuntimeActionKeys(contextActions, branchReplies)
    const evidence: string[] = []
    // The explicit tool alias is a legacy requirement, with an actual success still required at completion.
    const toolRequirements = new Set(capabilities.map(capability => `tool:${capability.name}`))
    for (const task of tasks) {
      const prior = previous.get(task.id)
      const foreign = task.requiredActions.flatMap(ref => {
        const taskIds = owners.get(ref)
        const explicitlyScoped = ref.startsWith('context:') || ref.startsWith('human:')
        return !taskIds?.includes(task.id) && (explicitlyScoped || (taskIds && !prior?.requiredActions.includes(ref)))
          ? [{ ref, owners: taskIds ?? [] }] : []
      })
      if (foreign.length) throw new RuntimePlanReceiptScopeError(task.id, foreign)
      const unverified = task.requiredActions.filter(ref => !prior?.requiredActions.includes(ref) && !successful.has(ref) && !toolRequirements.has(ref))
      if (unverified.length) throw new RuntimePlanReceiptScopeError(task.id, unverified.map(ref => ({ ref, owners: [] })))
      evidence.push(...task.evidenceRefs.filter(ref => !prior?.evidenceRefs.includes(ref)))
    }
    if (evidence.length && this.missingCompletionEvidence(evidence).length) throw new Error('RUNTIME_PLAN_EVIDENCE_UNBOUND')
  }

  private planActionOwners(contextActions: ReadonlyMap<string, string>, branchReplies: ReturnType<RuntimeLoop['branchHumanReplyReceipts']>) {
    const owners = new Map<string, readonly string[]>([...contextActions].map(([ref, taskId]) => [ref, [taskId]]))
    for (const reply of branchReplies) owners.set(reply.completionActionRef, reply.taskIds)
    for (const step of this.timeline) {
      const receipt = step.detail?.executionReceipt
      if (step.type !== 'tool' || step.status !== 'success' || !isObject(receipt) || receipt.status !== 'succeeded'
        || receipt.runId !== this.run.runId || typeof receipt.completionActionRef !== 'string') continue
      const taskIds = receiptCompletionTaskIds(receipt)
      if (!taskIds.length) continue
      for (const ref of [receipt.completionActionRef, `step:${step.id}`]) {
        owners.set(ref, [...new Set([...(owners.get(ref) ?? []), ...taskIds])])
      }
    }
    return owners
  }

  private contextPlanActionRefs(): Map<string, string> {
    return this.sessionId && this.run.runId && this.taskControl.taskId
      ? this.projectContextStore.commits.readPlanEditActions(this.waitBinding()) : new Map()
  }

  private branchHumanReplyReceipts() {
    return this.waitStore && this.sessionId && this.run.runId && this.taskControl.taskId
      ? this.waitStore.readBranchHumanReplies(this.waitBinding()) : []
  }

  private completedRuntimeActionKeys(contextActions = this.contextPlanActionRefs(), branchReplies = this.branchHumanReplyReceipts()): Set<string> {
    const completed = new Set([...contextActions.keys(), ...branchReplies.map(reply => reply.completionActionRef)])
    for (const step of this.timeline) {
      if (step.type !== 'tool' || step.status !== 'success' || step.detail?.ok !== true) continue
      const toolName = typeof step.detail.toolName === 'string' ? step.detail.toolName : undefined
      const callId = typeof step.detail.callId === 'string' ? step.detail.callId : undefined
      const argumentHash = typeof step.detail.ledgerArgumentHash === 'string' ? step.detail.ledgerArgumentHash
        : step.detail.arguments === undefined ? undefined : createHash('sha256').update(JSON.stringify(step.detail.arguments)).digest('hex')
      for (const key of completionActionKeys({ toolName, callId, argumentHash, stepId: step.id })) completed.add(key)
    }
    for (const assignment of this.taskControl.childAssignments ?? []) {
      for (const action of this.verifiedTakeoverActions(assignment)) {
        for (const key of completionActionKeys(action)) completed.add(key)
      }
    }
    for (const operation of this.verifiedMcpOperations()) {
      if (operation.verification?.outcome !== 'applied' || !operation.binding?.stepId) continue
      for (const key of completionActionKeys({ ...operation.binding, stepId: operation.binding.stepId })) completed.add(key)
    }
    if (this.sessionId && this.run.runId) {
      const commits = this.projectContextStore.commits
      for (const done of commits.mcpInputs.completed(this.waitBinding())) {
        const artifact = commits.readArtifactSource(done.artifactId, this.sessionId)
        if (artifact?.meta.hash === done.artifactHash && artifact.meta.runId === this.run.runId) {
          for (const key of completionActionKeys({ toolName: done.tool, callId: done.originCallId, stepId: done.originStepId, argumentHash: done.argumentHash })) completed.add(key)
        }
      }
    }
    for (const plan of this.workflows.items) {
      const resumed = plan.continuations?.at(-1)
      const artifact = plan.resultArtifactId ? this.artifacts.get(plan.resultArtifactId) : undefined
      if (plan.runId !== this.run.runId || plan.status !== 'completed' || !resumed || artifact?.meta.kind !== 'workflow-result'
        || !isObject(artifact.value) || artifact.value.ok !== true || artifact.value.workflowId !== plan.id) continue
      completed.add(`call:${plan.callId}`)
      completed.add(`call:${resumed.callId}`)
    }
    return completed
  }

  private verifiedMcpOperations(): McpOperation[] {
    if (!this.sessionId || !this.taskControl.taskId || !this.run.runId) return []
    const store = this.projectContextStore.commits
    return store.verifiedMcpOperations(this.sessionId, this.taskControl.taskId, this.run.runId).filter(operation => {
      const verification = operation.verification!
      const artifact = store.readArtifactSource(verification.artifactId, this.sessionId)
      return artifact?.meta.hash === verification.artifactHash && artifact.meta.runId === verification.verificationRequest.runId
    })
  }

  private mcpWriteAttempt(callId: string) {
    return this.sessionId && this.run.runId ? this.projectContextStore.commits.mcpInputs.writeAttempt(this.waitBinding(), callId) : undefined
  }

  private isMcpStepSettled(step: TimelineStep, verified: readonly McpOperation[]): boolean {
    const operation = this.recoverableMcpStep(step)
    if (!operation?.source.operationId || !this.sessionId) return false
    if (verified.some(item => item.source.operationId === operation.source.operationId)) return true
    const proof = operation.continuation
    const artifact = proof && this.projectContextStore.commits.readArtifactSource(proof.artifactId, this.sessionId)
    return !!artifact && artifact.meta.hash === proof?.artifactHash && artifact.meta.runId === this.run.runId
  }

  private recoverableMcpStep(step: TimelineStep | undefined, request = step && this.pendingToolCalls.get(step.id)): McpOperation | undefined {
    if (step?.type !== 'tool' || !this.sessionId || !this.run.runId) return undefined
    const name = request?.name ?? step.detail?.toolName
    const callId = request?.id ?? step.detail?.callId
    if (typeof callId !== 'string') return undefined
    if (name === 'resume_mcp_write_input') {
      const attempt = this.mcpWriteAttempt(callId)
      return attempt?.source.operationId ? this.projectContextStore.commits.readMcpOperation(this.sessionId, attempt.source.operationId) : undefined
    }
    if (typeof name !== 'string' || !name.startsWith('mcp_')) return undefined
    const operation = this.projectContextStore.commits.mcpOperationForStep(this.sessionId, this.taskControl.taskId, this.run.runId, step.id)
    if (!operation || operation.source.rpcRequestId === undefined || operation.binding?.callId !== callId || operation.binding.toolName !== name) return undefined
    if (operation.source.outcome !== 'unknown' && (operation.source.outcome !== 'succeeded' || operation.output === undefined)) return undefined
    return operation
  }

  private takeoverActionSource(action: ParentTakeoverAction) {
    if (!this.sessionId) return undefined
    const original = this.projectContextStore.commits.readArtifactSource(action.resultArtifactId, this.sessionId)
    return original?.meta.hash === action.resultHash && original.meta.runId === this.run.runId ? original : undefined
  }

  private verifiedTakeoverActions(assignment: RuntimeChildAssignment): ParentTakeoverAction[] {
    if (assignment.state !== 'parent' || !assignment.takeoverId || !this.childService) return []
    return this.childService.store.takeoverActions(this.childBinding(), assignment.childId)
      .filter(action => action.takeoverId === assignment.takeoverId && action.planTaskId === assignment.planTaskId && this.takeoverActionSource(action))
  }

  private verifyParentTakeover(node: RuntimePlanTask): boolean {
    const assignment = this.taskControl.childAssignments?.find(item => item.planTaskId === node.id)
    return !!assignment && this.verifiedTakeoverActions(assignment).some(action => completionActionKeys(action).some(key => node.requiredActions.includes(key)))
  }

  private recordParentTakeoverAction(step: TimelineStep, request: ToolCallRequest, result: ToolCallResult, receipt: JsonObject, artifact: RuntimeArtifactMeta): void {
    const projection = request.authorization?.projection
    const scope = projection?.execution.parentTakeover
    if (!scope || receipt.status !== 'succeeded' || (typeof receipt.exitCode === 'number' && receipt.exitCode !== 0)
      || typeof receipt.signal === 'string' || TAKEOVER_CONTROL_TOOLS.has(request.name)) return
    const grant = projection.bindings.find(binding => binding.name === request.name)
    const node = this.taskControl.tasks.find(item => item.id === scope.planTaskId)
    if (!grant || !node?.capabilityIds.some(id => id === grant.capabilityId || id === grant.name)) return
    const binding = this.childBinding()
    const original = this.artifacts.get(artifact.id)!
    this.projectContextStore.commits.saveArtifactSource(binding.sessionId, artifact,
      typeof original.value === 'string' ? original.value : JSON.stringify(original.value, null, 2))
    this.getChildService().store.recordTakeoverAction(binding, {
      ...scope, projectionId: projection.id, toolName: request.name, capabilityId: grant.capabilityId, sourceVersion: grant.sourceVersion, schemaHash: grant.schemaHash,
      callId: request.id, stepId: step.id, argumentHash: createHash('sha256').update(JSON.stringify(toJsonValue(request.arguments))).digest('hex'),
      resultArtifactId: artifact.id, resultHash: artifact.hash, startedAt: result.startedAt, completedAt: result.completedAt, durationMs: result.durationMs,
    })
  }

  private replayParentTakeoverAction(request: ToolCallRequest): { result: ToolCallResult; artifact: RuntimeArtifactMeta } | undefined {
    const projection = request.authorization?.projection
    const scope = projection?.execution.parentTakeover
    if (!this.childService) return undefined
    const childIds = this.taskControl.childAssignments?.filter(item => item.state === 'parent').map(item => item.childId) ?? []
    const actions = childIds.flatMap(id => this.childService!.store.takeoverActions(this.childBinding(), id))
    const action = actions.find(item => item.callId === request.id)
    if (!action) return undefined
    const grant = projection?.bindings.find(binding => binding.name === request.name)
    const argsHash = createHash('sha256').update(JSON.stringify(toJsonValue(request.arguments))).digest('hex')
    if (action.takeoverId !== scope?.takeoverId || action.planTaskId !== scope.planTaskId || action.toolName !== request.name || action.argumentHash !== argsHash
      || action.capabilityId !== grant?.capabilityId || action.sourceVersion !== grant.sourceVersion || action.schemaHash !== grant.schemaHash) {
      throw new RuntimeStageError('runtime', 'CHILD_TAKEOVER_ACTION_CONFLICT', 'the takeover call ID already has a different stored result', false)
    }
    const original = this.takeoverActionSource(action)
    if (!original) throw new RuntimeStageError('runtime', 'CHILD_TAKEOVER_RESULT_MISSING', 'the recorded takeover tool original is unavailable', false)
    const raw = JSON.parse(original.body) as { ok: true; result: JsonValue; source?: ToolCallResult['source'] }
    if (!this.artifacts.has(original.meta.id)) {
      this.artifacts.set(original.meta.id, { meta: original.meta, value: toJsonValue(raw) })
      this.artifactItems.push(original.meta)
      this.artifactRevision++
    }
    return { artifact: original.meta, result: { id: request.id, name: request.name, ok: true, output: raw.result,
      ...(raw.source ? { source: raw.source } : {}), startedAt: action.startedAt, completedAt: action.completedAt, durationMs: action.durationMs } }
  }

  private applyV2EnvelopeDiffs(envelope: RuntimeEnvelope, correlationId: string, modelRequestId?: string, requestBinding?: RuntimeRequestBinding): void {
    if (envelope.decision !== 'propose_diff' || envelope.candidateDiffs.length === 0) return
    const proposals = envelope.candidateDiffs.map((diff) => {
      const scope = diff.scope ?? 'session'
      const proposal: RuntimeContextDiffProposal = {
        ...(diff.diffVersion !== undefined ? { diffVersion: diff.diffVersion } : {}),
        ...(diff.targetNodeHash ? { targetNodeHash: diff.targetNodeHash } : {}),
        id: `envelope-${envelope.requestId}-${diff.idempotencyKey}`,
        scope,
        ...(diff.sourceScope ? { sourceScope: diff.sourceScope } : {}),
        documentId: diff.documentId ?? this.contextDocumentForScope(scope).id,
        baseRevision: diff.baseRevision,
        projectionId: diff.projectionId,
        projectionHash: diff.projectionHash,
        ...(diff.targetEntryHash ? { targetEntryHash: diff.targetEntryHash } : {}),
        target: {
          section: 'information',
          ...(diff.targetEntryId ? { entryId: diff.targetEntryId } : {}),
          ...(diff.targetNodeId ? { nodeId: diff.targetNodeId } : {}),
          ...(diff.headingPath ? { headingPath: diff.headingPath } : {}),
        },
        operation: diff.operation,
        payload: {
          ...(diff.title !== undefined ? { title: diff.title } : {}),
          ...(diff.parentNodeId !== undefined ? { parentNodeId: diff.parentNodeId } : {}),
          ...(diff.beforeNodeId !== undefined ? { beforeNodeId: diff.beforeNodeId } : {}),
          ...(diff.childIds !== undefined ? { childIds: diff.childIds } : {}),
          ...(diff.body !== undefined ? { body: diff.body } : {}),
          ...(diff.status ? { status: diff.status } : {}),
          ...(diff.evidenceRefs.length > 0 ? { evidenceRefs: diff.evidenceRefs } : {}),
        },
        candidateId: diff.candidateId,
        ...(diff.classification ? { classification: diff.classification } : {}),
        actor: 'model',
        idempotencyKey: diff.idempotencyKey,
        createdAt: new Date().toISOString(),
      }
      return proposal
    })
    const grouped = new Map<RuntimeContextScopeKind, RuntimeContextDiffProposal[]>()
    for (const proposal of proposals) {
      const scope = proposal.scope ?? 'session'
      const group = grouped.get(scope) ?? []
      group.push(proposal)
      grouped.set(scope, group)
    }
    const before = { project: this.projectContextDocumentEngine.exportState(), session: this.contextDocumentEngine.exportState() }
    const previousEngines = { project: this.projectContextDocumentEngine, session: this.contextDocumentEngine }
    const store = this.projectContextStore.commits
    const sessionId = this.sessionId ?? before.session.document.sessionId
    const expectedSessionRevision = store.loadDocument(sessionId, { observe: false })?.document.revision ?? 0
    const trainingSampleId = this.recordTrainingProposal(proposals)
    const receipts: import('#core/context-document-engine').ApplyReceipt[] = []
    const receiptByProposal = new Map<RuntimeContextDiffProposal, import('#core/context-document-engine').ApplyReceipt>()
    const planNodeByDiff = new Map(envelope.sourceV2?.candidateDiffs.map(diff => [diff.idempotencyKey, diff.planTaskId]))
    const outcomes = (results: readonly import('#core/context-document-engine').ApplyReceipt[], batchFailure?: string) => proposals.map((proposal, index) => {
      const scope = proposal.scope ?? 'session', receipt = results[index]!
      const planTaskId = planNodeByDiff.get(proposal.idempotencyKey)
      const plannedEdit = requestBinding && planTaskId && !batchFailure && receipt.result === 'applied' && !receipt.unchanged
        && !before[scope].receipts.some(([, prior]) => prior.id === receipt.id)
      return { scope, proposal: this.engineProposal(proposal), receipt, correlationId, requestBinding,
        batchId: envelope.requestId, ...(batchFailure ? { batchFailure } : {}), ...(plannedEdit ? { planTaskId } : {}) }
    })
    const restore = (state: typeof before.session) => new ContextDocumentEngine(state.document, state.receipts, state.projections, state.reviewReceipts, state.evidenceReviewReceipts)
    // Staging is synchronous and private. No success event or snapshot is published before durable commit.
    this.projectContextDocumentEngine = restore(before.project)
    this.contextDocumentEngine = restore(before.session)
    let projectChanged = false
    try {
      for (const [scope, group] of grouped) {
        const engine = this.contextEngineForScope(scope)
        let effectiveGroup = group
        for (const proposal of group) {
          if (proposal.documentId !== engine.snapshot().id) throw new RuntimeStageError('model_protocol', 'RUNTIME_ENVELOPE_DOCUMENT_MISMATCH', 'diff document binding does not match its scope', true)
          store.assertPublishedProjection(sessionId, scope, proposal, modelRequestId ? 'model' : undefined, modelRequestId)
        }
        if (scope === 'project' && group.some((proposal) => proposal.sourceScope === 'session')) {
          // Validate what the model actually saw before the host imports a new candidate and rebases its own additions.
          const bindings = new Map(before.project.projections)
          for (const proposal of group) {
            const binding = bindings.get(proposal.projectionId)
            if (proposal.baseRevision !== before.project.document.revision || !binding || binding.documentRevision !== proposal.baseRevision || binding.contentHash !== proposal.projectionHash) throw new Error('PROJECTION_BINDING_CONFLICT')
            if (proposal.target.entryId && !binding.sourceEntryIds?.includes(proposal.target.entryId)) throw new Error('ENTRY_NOT_IN_PROJECTION')
            if ((CONTEXT_TREE_OPERATIONS as readonly string[]).includes(proposal.operation)) {
              const error = contextTreeProposalError(proposal, binding.treeNodes)
              if (error) throw new Error(error)
            }
            if (proposal.sourceScope !== 'session' && !binding.sourceCandidateIds?.includes(proposal.candidateId)) throw new Error('CANDIDATE_NOT_IN_PROJECTION')
          }
          for (const proposal of group.filter((item) => item.sourceScope === 'session')) this.promoteSessionCandidateToProject(proposal.candidateId)
          effectiveGroup = this.rebaseProjectProposals(group)
        }
        if (scope === 'project') {
          const errorCode = effectiveGroup.map((proposal) => this.projectProposalGate(proposal, engine)).find((code) => code !== undefined)
          if (errorCode) throw new Error(errorCode)
        }
        const applied = engine.applyBatch(effectiveGroup.map((proposal) => this.engineProposal(proposal)))
        group.forEach((proposal, index) => receiptByProposal.set(proposal, applied[index]!))
      }
      receipts.push(...proposals.map(proposal => receiptByProposal.get(proposal)!))
      const project = this.projectContextDocumentEngine.exportState(), session = this.contextDocumentEngine.exportState()
      projectChanged = project.document.revision !== before.project.document.revision
      const projectStateChanged = projectChanged || project.receipts.length !== before.project.receipts.length
      const sessionStateChanged = session.document.revision !== before.session.document.revision || session.receipts.length !== before.session.receipts.length
      if (projectStateChanged || sessionStateChanged) {
        store.commit({ id: `context-envelope-${randomUUID()}`, sessionId, expectedProjectRevision: before.project.document.revision, expectedSessionRevision,
          project, session, projectChanged: projectStateChanged,
          history: this.contextHistory.snapshot(), receiptIds: receipts.map((receipt) => receipt.id), archives: [], coverageAdvanced: false,
          outcomes: outcomes(receipts) })
      } else store.recordOutcomes(sessionId, outcomes(receipts))
    } catch (error) {
      this.projectContextDocumentEngine = previousEngines.project
      this.contextDocumentEngine = previousEngines.session
      const batchFailure = error instanceof Error ? error.message : String(error)
      const rejected = proposals.map((proposal) => {
        const prior = before[proposal.scope ?? 'session'].receipts.find(([key]) => key === proposal.idempotencyKey)?.[1]
        const hash = proposalHash(this.engineProposal(proposal))
        // An aborted batch cannot relabel a prior committed action as rejected.
        if (prior?.proposalHash === hash) return prior
        return { id: `receipt-${randomUUID()}`, proposalId: proposal.id, result: 'rejected' as const,
          previousRevision: before[proposal.scope ?? 'session'].document.revision, changedEntryIds: [],
          errorCode: batchFailure, createdAt: now(), proposalHash: hash }
      })
      store.recordOutcomes(sessionId, outcomes(rejected, batchFailure))
      this.completeTrainingProposal(trainingSampleId, proposals, rejected, before)
      for (const receipt of rejected) this.emit('runtime.context.v2.receipt.created', { receipt }, correlationId)
      throw error
    }
    // Mirror/telemetry errors cannot undo an already committed pair or turn it into a negative training label.
    if (projectChanged) {
      this.projectContextStore.exportMirrors(this.projectContextDocumentEngine)
      if (this.projectContextStore.mirrorError) this.createArtifact('runtime-error', 'Context mirror export delayed', { canonicalStore: 'committed', error: this.projectContextStore.mirrorError }, correlationId)
    }
    try { this.completeTrainingProposal(trainingSampleId, proposals, receipts, before) } catch (error) {
      this.createArtifact('runtime-error', 'Context committed; training recording failed', { code: error instanceof Error ? error.message : String(error) }, correlationId)
    }
    this.snapshotRevision += 1
    for (const receipt of receipts) this.emit('runtime.context.v2.receipt.created', { receipt }, correlationId)
  }

  private handleV2EnvelopeControl(envelope: RuntimeEnvelope, correlationId: string, projection: RuntimeCapabilityProjection): void {
    if (envelope.decision === 'finish') {
      if (this.v2ControlState.status !== 'idle') {
        const requestId = this.v2ControlState.requestId
        this.v2ControlState = { status: 'idle', evidenceRequests: [], uncertainties: [], reflectionAttempts: 0 }
        this.snapshotRevision += 1
        this.emit('runtime.context.v2.control.cleared', { ...(requestId ? { requestId } : {}) }, correlationId)
      }
      return
    }
    if (envelope.decision === 'reflect') {
      const reflectionAttempts = this.v2ControlState.reflectionAttempts + 1
      if (reflectionAttempts > 3) throw new RuntimeStageError('model_protocol', 'RUNTIME_REFLECTION_LIMIT', 'reflection retry limit exceeded', true)
      this.v2ControlState = {
        status: 'reflecting',
        requestId: envelope.requestId,
        evidenceRequests: clone(envelope.evidenceRequests),
        uncertainties: clone(envelope.uncertainties),
        reflectionAttempts,
      }
    } else if (envelope.decision === 'wait') {
      if (!envelope.waitSpec) throw new Error('WAIT_SPEC_UNBOUND')
      const binding = envelope.sourceV2?.binding ?? { ...this.waitBinding(), requestId: envelope.requestId }
      const store: RuntimeWaitStore = this.getWaitStore()
      const spec = envelope.waitSpec
      if ([BRANCH_HUMAN_REPLY, BRANCH_EVIDENCE].includes(spec.condition?.eventType ?? '')) {
        throw new RuntimeStageError('model_protocol', 'WAIT_SIGNAL_RESERVED_EVENT', 'human and evidence subscriptions are registered by the host', true)
      }
      store.validateSpec(binding, spec)
      if (spec.signalType === 'tool') {
        const known = new Set(this.timeline.filter(step => step.type === 'tool').map(step => step.detail?.callId).filter((id): id is string => typeof id === 'string'))
        if (spec.correlationIds.some(id => !known.has(id))) throw new Error('WAIT_TOOL_BINDING_UNKNOWN')
        for (const step of this.timeline.filter(step => step.type === 'tool' && spec.correlationIds.includes(String(step.detail?.callId)))) this.recordToolWaitSignal(step)
      }
      if (spec.condition.eventType === MCP_INPUT_RESPONDED) {
        if (!envelope.sourceV2 || !this.projectContextStore.commits.mcpInputs.hasWaitSource(binding, spec.correlationIds![0]!)) throw new Error('MCP_INPUT_WAIT_BINDING_UNKNOWN')
      } else if (spec.condition.eventType === MCP_OPERATION_SETTLED) {
        const operation = this.projectContextStore.commits.readMcpOperation(binding.sessionId, spec.correlationIds![0]!)
        const name = operation && this.mcp.verificationTool(operation)
        if (!envelope.sourceV2 || this.childAgentMode || !operation?.binding?.verification?.poll
          || operation.binding.taskId !== binding.taskId || operation.binding.runId !== binding.runId
          || !name || !projection.bindings.some(tool => tool.name === name)) throw new Error('MCP_WAIT_OPERATION_UNAVAILABLE')
      } else if (spec.signalType === 'runtime' && spec.condition.eventType !== 'deadline') {
        const { eventType } = spec.condition
        if (!['child.status', 'child.completed', 'child.ready', 'process.status'].includes(eventType)) throw new Error('WAIT_RUNTIME_EVENT_UNSUPPORTED')
        const activity = this.runtimeActivityState.snapshot()
        const refs = eventType === 'process.status' ? activity.processes.items.filter(item => item.runId === this.run.runId).map(item => item.id)
          : activity.children.items.filter(item => item.parentRunId === this.run.runId).map(item => eventType === 'child.ready' ? item.waitRef : item.id)
        if (spec.correlationIds.some(id => !refs.includes(id))) {
          throw new RuntimeStageError('model_protocol', 'WAIT_RUNTIME_BINDING_UNKNOWN', 'wait correlation IDs must match the requested event type in the current run', true)
        }
        if (eventType === 'process.status') this.recordActivityWaitSignals('process', activity.processes)
        else this.recordActivityWaitSignals('child', activity.children)
      }
      const waitId = `wait-${randomUUID()}`
      if (spec.blockingTaskIds?.length && !spec.blockingTaskIds.includes(binding.taskId)) {
        this.prepareBranchBlock(waitId, binding, spec, 'wait')
        return
      }
      const { blockingTaskIds: _scope, ...runSpec } = spec
      this.preparedWaits = [{ id: waitId, binding: clone(binding), spec: clone(runSpec) }]
      this.v2ControlState = {
        status: 'waiting',
        waitId,
        taskId: binding.taskId,
        requestId: envelope.requestId,
        waitSpec: clone(runSpec),
        evidenceRequests: clone(envelope.evidenceRequests),
        uncertainties: clone(envelope.uncertainties),
        reflectionAttempts: this.v2ControlState.reflectionAttempts,
      }
    } else if (envelope.decision === 'ask_user') {
      const action = envelope.sourceV2?.actions.find(action => action.kind === 'ask_user')
      const question = envelope.actions.find((action) => action.kind === 'ask_user')?.question
      if (action && !action.blockingTaskIds.includes(this.taskControl.taskId)) {
        const id = `human-request-${randomUUID()}`
        const binding = envelope.sourceV2!.binding
        this.prepareBranchBlock(id, binding, { reason: action.question, signalType: 'user', resumeCondition: BRANCH_HUMAN_REPLY,
          condition: { eventType: BRANCH_HUMAN_REPLY }, correlationIds: [id], blockingTaskIds: action.blockingTaskIds }, 'human')
        return
      }
      this.v2ControlState = {
        status: 'awaiting_user',
        humanRequestId: `human-request-${randomUUID()}`,
        taskId: this.taskControl.taskId,
        requestId: envelope.requestId,
        ...(question ? { question } : {}),
        evidenceRequests: clone(envelope.evidenceRequests),
        uncertainties: clone(envelope.uncertainties),
        reflectionAttempts: this.v2ControlState.reflectionAttempts,
      }
    } else if (envelope.evidenceRequests.length > 0) {
      if (envelope.sourceV2 && this.prepareBranchEvidence(envelope.sourceV2)) return
      this.v2ControlState = {
        status: 'awaiting_evidence',
        requestId: envelope.requestId,
        evidenceRequests: clone(envelope.evidenceRequests),
        uncertainties: clone(envelope.uncertainties),
        reflectionAttempts: this.v2ControlState.reflectionAttempts,
      }
    } else {
      this.v2ControlState = {
        ...this.v2ControlState,
        status: 'idle',
        requestId: envelope.requestId,
        uncertainties: clone(envelope.uncertainties),
      }
    }
    this.snapshotRevision += 1
    if (envelope.decision !== 'wait') this.emit('runtime.context.v2.control.pending', { control: clone(this.v2ControlState) }, correlationId)
  }

  private prepareBranchBlock(id: string, binding: RuntimeRequestBinding, spec: RuntimeWaitSpec, kind: 'human' | 'wait'): void {
    const taskIds = spec.blockingTaskIds!
    const active = runtimeExecutionState(this.taskControl).activeTaskIds
    const assigned = this.taskControl.childAssignments?.filter(assignment => assignment.state === 'delegated' && taskIds.includes(assignment.planTaskId)) ?? []
    if (taskIds.some(id => !active.includes(id) && !assigned.some(assignment => assignment.planTaskId === id))
      || this.taskControl.branchBlocks?.some(block => block.taskIds.some(task => taskIds.includes(task)))) {
      throw new RuntimeStageError('model_protocol', 'RUNTIME_BRANCH_NOT_ACTIVE', 'branch control requires active, dependency-ready nodes', true)
    }
    if (kind === 'wait' && assigned.length) {
      const eventType = spec.condition?.eventType
      const refs = assigned.map(assignment => eventType === 'child.ready'
        ? this.childRecords.get(assignment.childId)?.waitRef : assignment.childId)
      if (spec.signalType !== 'runtime' || !['child.ready', 'child.completed', 'child.status'].includes(eventType ?? '')
        || refs.length !== taskIds.length || refs.some(ref => !ref || !spec.correlationIds?.includes(ref)) || spec.correlationIds?.length !== refs.length) {
        throw new RuntimeStageError('model_protocol', 'CHILD_PLAN_WAIT_BINDING_MISMATCH', 'wait must use the assigned nodes and their own child handles', true)
      }
    }
    const block = { id, kind, taskIds: clone(taskIds), reason: spec.reason }
    this.taskControl.branchBlocks = [...this.taskControl.branchBlocks ?? [], block]
    this.v2ControlState = { status: 'idle', evidenceRequests: [], uncertainties: clone(this.taskControl.uncertainties), reflectionAttempts: this.v2ControlState.reflectionAttempts }
    this.preparedWaits = [{ id, binding: clone(binding), spec: clone(spec) }]
  }

  private prepareBranchEvidence(envelope: NonNullable<RuntimeEnvelope['sourceV2']>): boolean {
    if (!envelope.evidenceRequests.some(request => request.relatedTaskIds.some(id => id !== envelope.binding.taskId))) return false
    const active = runtimeExecutionState(this.taskControl).activeTaskIds
    const assigned = this.taskControl.childAssignments?.filter(item => item.state === 'delegated').map(item => item.planTaskId) ?? []
    const pending = new Set(this.taskControl.branchBlocks?.flatMap(block => block.taskIds))
    const documents = [this.contextDocumentEngine.snapshot(), this.projectContextDocumentEngine.snapshot()]
    const blocks: RuntimeBranchBlock[] = envelope.evidenceRequests.map(({ relatedTaskIds, ...request }) => {
      if (relatedTaskIds.some(id => pending.has(id) || (!active.includes(id) && !assigned.includes(id)))) {
        throw new RuntimeStageError('model_protocol', 'RUNTIME_BRANCH_NOT_ACTIVE', 'evidence requires current unblocked plan nodes', true)
      }
      if (request.targetCandidateId && !documents.some(document => document.candidates.some(candidate => candidate.id === request.targetCandidateId))) {
        throw new RuntimeStageError('model_protocol', 'BRANCH_EVIDENCE_TARGET_UNKNOWN', 'evidence target candidate is unknown', true)
      }
      return { id: `branch-evidence-${randomUUID()}`, kind: 'evidence', taskIds: clone(relatedTaskIds), reason: request.question, evidenceRequest: clone(request) }
    })
    this.taskControl.branchBlocks = [...this.taskControl.branchBlocks ?? [], ...blocks]
    this.v2ControlState = { status: 'idle', evidenceRequests: [], uncertainties: clone(this.taskControl.uncertainties), reflectionAttempts: this.v2ControlState.reflectionAttempts }
    this.preparedWaits = blocks.map(block => ({ id: block.id, binding: clone(envelope.binding),
      spec: { reason: block.reason, signalType: 'runtime', resumeCondition: BRANCH_EVIDENCE, condition: { eventType: BRANCH_EVIDENCE },
        correlationIds: [block.id], blockingTaskIds: clone(block.taskIds) } }))
    return true
  }

  private completeTrainingEventSample(sampleId: string, event: Partial<NonNullable<import('#core/context-training-recorder').ContextTrainingSample['decision']>>): void {
    this.contextTrainingRecorder.recordDecisionEvent(sampleId, event)
    this.contextTrainingRecorder.complete(sampleId, {
      projectContext: this.projectContextDocumentEngine.serialize(),
      projectContextRevision: this.projectContextDocumentEngine.snapshot().revision,
      context: this.contextDocumentEngine.serialize(),
      contextRevision: this.contextDocumentEngine.snapshot().revision,
      archivedNodeIds: event.archivedNodeIds ?? [],
      recallLinks: event.recallLinks ?? [],
    })
  }

  private reviewV2Candidate(review: RuntimeContextCandidateReview, correlationId: string): void {
    const previousState = this.contextDocumentEngine.exportState()
    const sampleId = this.recordContextTrainingSample(previousState)
    const receipt = this.contextDocumentEngine.reviewCandidate(review.candidateId, review.status, review.baseRevision, review.reason, review.documentId)
    this.persistSessionContext(previousState)
    const candidate = previousState.document.candidates.find((item) => item.id === review.candidateId)
    const trainingReview: ContextTrainingCandidateReview = {
      id: receipt.id,
      candidateId: receipt.candidateId,
      result: receipt.result,
      ...(receipt.status ? { status: receipt.status } : {}),
      ...(receipt.reason ? { reason: receipt.reason } : {}),
      previousRevision: receipt.previousRevision,
      ...(receipt.nextRevision !== undefined ? { nextRevision: receipt.nextRevision } : {}),
      evidenceRefs: [...(candidate?.evidenceRefs ?? [])],
      createdAt: receipt.createdAt,
    }
    const trainingReceipt: ContextTrainingReceipt = {
      kind: 'candidate_review',
      id: receipt.id,
      result: receipt.result,
      subjectId: receipt.candidateId,
      previousRevision: receipt.previousRevision,
      ...(receipt.nextRevision !== undefined ? { nextRevision: receipt.nextRevision } : {}),
      ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
      createdAt: receipt.createdAt,
    }
    this.completeTrainingEventSample(sampleId, {
      acceptedOperations: [],
      rejectedOperations: receipt.result === 'reviewed' ? [] : [receipt.id],
      archivedNodeIds: [],
      recallLinks: [],
      candidateReviews: [trainingReview],
      receipts: [trainingReceipt],
    })
    this.snapshotRevision += 1
    this.emit('runtime.context.v2.candidate.reviewed', { receipt }, correlationId)
  }

  private recallV2Memory(recall: RuntimeContextMemoryRecall, correlationId: string, prepared?: {
    input: Parameters<typeof recallContext>[0]; selected: ReturnType<typeof findRecallSources>; projectHash: string; failure?: string
  }) {
    validateRecallQuery(recall)
    this.projectContextDocumentEngine = this.projectContextStore.load()
    const previousState = this.contextDocumentEngine.exportState()
    const sampleId = this.recordContextTrainingSample(previousState)
    const sessionId = this.sessionId ?? previousState.document.sessionId
    const store = this.projectContextStore.commits
    const expectedRevision = store.loadDocument(sessionId, { observe: false })?.document.revision ?? 0
    const input = prepared?.input ?? { recallId: `recall-${randomUUID()}`, query: recall,
      project: this.projectContextDocumentEngine.exportState(), session: previousState, store, sessionId }
    const existing = store.loadRecall(sessionId, input.recallId)
    if (existing) return existing
    const { session, result } = recallContext(input, prepared?.selected)
    if (prepared?.failure) result.uncertainties.push(`assistant_selection:${prepared.failure}`)
    store.commitRecall(sessionId, prepared ? input.session.document.revision : expectedRevision, session, result, prepared?.projectHash)
    this.contextDocumentEngine = new ContextDocumentEngine(session.document, session.receipts, session.projections, session.reviewReceipts, session.evidenceReviewReceipts)
    const reasons: Record<string, string> = {}
    for (const hit of result.hits) reasons[hit.sourceId] = hit.reason
    const selectedIds = [...new Set(result.hits.map((hit) => hit.sourceId))]
    const recallRecord: ContextTrainingRecallRecord = {
      id: result.recallId,
      scope: 'session',
      query: recall.query,
      candidateIds: result.candidates.map((candidate) => candidate.id),
      archivedEntryIds: result.archives?.map((archive) => archive.entryId) ?? [],
      sourceArchiveIds: [...new Set(result.hits.filter((hit) => hit.sourceKind === 'source_archive').map((hit) => hit.sourceId))],
      sources: result.hits.map((hit) => ({ scope: hit.scope, ...(hit.documentId ? { documentId: hit.documentId } : {}), sourceId: hit.sourceId,
        ...(hit.sourceRef ? { sourceRef: hit.sourceRef } : {}),
        sourceKind: hit.sourceKind, ...(hit.candidateId ? { candidateId: hit.candidateId } : {}), evidenceRefs: hit.evidenceRefs, originalStatus: hit.originalStatus })),
      selectedIds,
      reasons,
      createdAt: new Date().toISOString(),
    }
    try { this.completeTrainingEventSample(sampleId, {
      acceptedOperations: [],
      rejectedOperations: [],
      archivedNodeIds: [],
      recallLinks: selectedIds,
      recalls: [recallRecord],
    }) } catch (error) {
      this.createArtifact('runtime-error', 'Recall committed; training recording failed', { recallId: result.recallId, code: error instanceof Error ? error.message : String(error) }, correlationId)
    }
    this.snapshotRevision += 1
    this.emit('runtime.context.v2.memory.recalled', result, correlationId)
    return result
  }

  private async selectV2Memory(recall: RuntimeContextMemoryRecall, correlationId: string, operationId = correlationId) {
    const sessionId = this.sessionId!
    const store = this.projectContextStore.commits
    const session = this.contextDocumentEngine.exportState()
    const project = this.projectContextStore.load().exportState()
    const recallId = `recall-${capabilityHash({ sessionId, runId: this.run.runId, operationId, recall })}`
    const existing = store.loadRecall(sessionId, recallId)
    if (existing) return existing
    const input = { recallId, query: recall, project, session, store, sessionId }
    const limit = recall.limit ?? 5
    const pool = findRecallSources(input, Math.min(24, limit * 3))
    const candidates = pool.map(({ hit }) => ({ ...hit, body: hit.body.slice(0, 500), selectionExcerpt: hit.body.length > 500 }))
    let selected = pool.slice(0, limit)
    let failure: string | undefined
    if (candidates.length) {
      const review = await this.invokeContextAssistant('recall', recallId, correlationId, {
        visibleSources: { query: recall.query, scope: recall.scope ?? 'both', ...(recall.sourceKind ? { sourceKind: recall.sourceKind } : {}), candidates },
        sourceIds: candidates.map(hit => hit.id), selectionIds: candidates.map(hit => hit.id), selectionLimit: limit,
        taskSignals: this.contextAssistantTaskSignals(),
      }, this.activeAbortController?.signal)
      failure = review.failure
      if (review.output) {
        const byId = new Map(pool.map(match => [match.hit.id, match]))
        selected = review.output.recallProposals!.map(({ id, reason }) => {
          const match = byId.get(id)!
          return { ...match, hit: { ...match.hit, reason } }
        })
      }
    }
    return this.recallV2Memory(recall, correlationId, { input, selected, projectHash: contextKnowledgeHash(project.document), failure })
  }

  private mergeV2Child(merge: RuntimeContextChildMerge, correlationId: string): void {
    const previousState = this.contextDocumentEngine.exportState()
    const candidate = this.contextDocumentEngine.mergeChildCandidate({
      sourceId: merge.sourceId,
      runId: merge.runId,
      ...(merge.stepId ? { stepId: merge.stepId } : {}),
      rawArtifactId: merge.rawArtifactId,
      normalizedContent: merge.normalizedContent,
      evidenceRefs: merge.evidenceRefs,
    })
    this.persistSessionContext(previousState)
    // An imported claim is a pending candidate, not a child lifecycle event.
    // Only delegation/host events may establish execution and completion.
    this.snapshotRevision += 1
    this.emit('runtime.context.v2.child.merged', {
      candidate: {
        id: candidate.id,
        actor: candidate.source.actor,
        sourceId: candidate.source.sourceId,
        capturedAt: candidate.source.capturedAt,
        ...(candidate.source.toolName ? { toolName: candidate.source.toolName } : {}),
        ...(candidate.source.runId ? { runId: candidate.source.runId } : {}),
        ...(candidate.source.stepId ? { stepId: candidate.source.stepId } : {}),
        rawArtifactId: candidate.rawArtifactId,
        status: candidate.status,
        evidenceRefs: candidate.evidenceRefs,
        proposedDiffIds: candidate.proposedDiffIds,
        createdAt: candidate.createdAt,
      },
    }, correlationId)
  }

  private reviewV2Evidence(review: RuntimeContextEvidenceReview, correlationId: string): void {
    const previousState = this.contextDocumentEngine.exportState()
    const sampleId = this.recordContextTrainingSample(previousState)
    const result = this.contextDocumentEngine.reviewEvidence({
      candidateId: review.candidateId,
      decision: review.decision,
      baseRevision: review.baseRevision,
      ...(review.supportingEvidence ? { supportingEvidence: review.supportingEvidence } : {}),
      ...(review.contradictingEvidence ? { contradictingEvidence: review.contradictingEvidence } : {}),
      ...(review.targetEntryIds ? { targetEntryIds: review.targetEntryIds } : {}),
      ...(review.rationale ? { rationale: review.rationale } : {}),
      documentId: review.documentId,
    })
    this.persistSessionContext(previousState)
    const evidenceReview: ContextTrainingEvidenceReview = { ...result, createdAt: new Date().toISOString() }
    const receipt: ContextTrainingReceipt = {
      kind: 'evidence_review',
      id: `evidence-review-${review.candidateId}-${result.reviewRevision}`,
      result: result.decision,
      subjectId: result.candidateId,
      previousRevision: previousState.document.revision,
      nextRevision: result.reviewRevision,
      createdAt: evidenceReview.createdAt,
    }
    const preservedConflicts: ContextTrainingConflictRecord[] = result.decision === 'conflict'
      ? [{
          id: `conflict-${receipt.id}`,
          candidateId: result.candidateId,
          evidenceRefs: [...new Set([...result.supportingEvidence, ...result.contradictingEvidence])],
          supportingEvidence: [...result.supportingEvidence],
          contradictingEvidence: [...result.contradictingEvidence],
          rationale: result.rationale,
          preserved: true,
          createdAt: evidenceReview.createdAt,
        }]
      : []
    this.completeTrainingEventSample(sampleId, {
      acceptedOperations: [],
      rejectedOperations: result.decision === 'reject' ? [receipt.id] : [],
      archivedNodeIds: [],
      recallLinks: [],
      evidenceReviews: [evidenceReview],
      receipts: [receipt],
      ...(preservedConflicts.length > 0 ? { preservedConflicts } : {}),
    })
    this.snapshotRevision += 1
    this.emit('runtime.context.v2.evidence.reviewed', { result }, correlationId)
  }

  private getAuxiliaryRunner(): RuntimeAuxiliaryRunner {
    return this.auxiliaryRunner ??= new RuntimeAuxiliaryRunner(this.projectDir)
  }

  private contextAssistantEnabled(mode: ContextAssistantMode): boolean {
    const configured = this.contextAssistant.modes ?? this.projectResources.readSettings().context_assistant_modes ?? []
    return configured.includes(mode) && (!this.childAgentMode || mode === 'normalize' || mode === 'recall')
  }

  private modelBudgetScope(role?: ModelBudgetRole): ModelBudgetScope {
    const base = this.childExecution?.parent ?? {
      sessionId: this.sessionId ?? this.contextDocumentEngine.snapshot().sessionId,
      taskId: this.taskControl.taskId || 'idle-context',
      runId: this.run.runId ?? 'idle-context',
    }
    return role === 'organize' ? { ...base, runId: `${base.runId}:organize` } : base
  }

  getModelBudgetSummary() {
    if (this.closed || (!this.modelMeter && !this.run.runId)) return undefined
    const meter = this.modelMeter ??= new RuntimeModelMeter(this.projectDir)
    const primary = meter.store.totals(this.modelBudgetScope())
    if (!primary) return undefined
    const organizer = meter.store.totals(this.modelBudgetScope('organize'))
    return organizer ? { ...primary, organizer } : primary
  }

  private resolveModelBudgetLimits(context: ReturnType<ProjectResources['readSettings']>['context']): ModelBudgetLimits {
    return {
      maxTokens: this.modelBudgetOptions?.maxTokens ?? context.max_model_tokens ?? DEFAULT_MODEL_BUDGET.maxTokens,
      maxAttempts: this.modelBudgetOptions?.maxAttempts ?? context.max_model_attempts ?? DEFAULT_MODEL_BUDGET.maxAttempts,
    }
  }

  private meteredLlm(role: ModelBudgetRole, base = this.llm, binding?: { requestId?: string; actorSessionId?: string; scope?: ModelBudgetScope; assertAuthority?: () => void }): RuntimeLlm {
    const generation = this.generation
    const scope = binding?.scope ?? this.modelBudgetScope()
    const meter = this.modelMeter ??= new RuntimeModelMeter(this.projectDir)
    return meter.wrap(base, {
      scope, actorSessionId: binding?.actorSessionId ?? this.sessionId ?? scope.sessionId, requestId: binding?.requestId, role, limits: this.modelBudgetLimits,
      maxInputTokens: this.maxInputTokens, maxOutputTokens: this.reservedOutputTokens, contextWindowTokens: this.contextWindowTokens,
      countTokens: this.modelBudgetOptions?.countTokens,
      assertActive: () => {
        if (this.closed || this.generation !== generation) throw new RuntimeModelBudgetError('RUNTIME_MODEL_SCOPE_STALE', 'model request no longer belongs to the active execution')
        this.childExecution?.assertAuthority()
        binding?.assertAuthority?.()
      },
    })
  }

  private contextProcessingLlm(fileDisposition = false, settings?: ProjectSettings): RuntimeLlm {
    if (this.contextAssistant.llm) return this.contextAssistant.llm
    if (this.contextOrganization.llm) return this.contextOrganization.llm
    if (this.childAgentMode) return this.llm
    settings ??= this.projectResources.readSettings()
    const profileId = (fileDisposition ? settings.context_file_disposition_profile : undefined) ?? settings.context_assistant_profile
    if (!profileId) return this.llm
    const profile = settings.llm.profiles.find(item => item.id === profileId)!
    return createProjectLlmService({ ...settings.llm, active_profile: profile.id, profiles: [profile] })
  }

  private contextAssistantTaskSignals() {
    const history = this.contextHistory.snapshot().messages
    return {
      goal: this.taskControl.goal,
      latestUserMessage: history.filter(item => item.origin === 'user').at(-1)?.message.content.slice(0, 1200),
      projectInstructionsExcerpt: this.renderResult.messages.find(message => message.role === 'system')?.content.slice(0, 1600),
      partial: true,
    }
  }

  private contextAssistantHash() {
    return capabilityHash({ context: this.reflectionContextHash(), historySize: this.contextHistory.size, user: this.contextHistory.latestUserId(),
      projectFrozen: this.childAgentMode || assetWriteAudit(this.projectDir, 'context.policy.read').readonly })
  }

  private contextAssistantDocuments(snapshot: string, pinnedCandidateIds: string[] = []) {
    const project = this.projectContextStore.load().exportState()
    const session = this.contextDocumentEngine.exportState()
    const documents = { project, session }
    const projections = (['project', 'session'] as const).map(scope => {
      const { document, receipts, projections, reviewReceipts, evidenceReviewReceipts } = documents[scope]
      const engine = new ContextDocumentEngine(document, receipts, projections, reviewReceipts, evidenceReviewReceipts)
      const projection = engine.project({ id: `${snapshot}:${scope}`, includeStructure: true, includeSections: ['information', 'candidates'],
        maxCharacters: 2600, pinnedCandidateIds: scope === 'session' ? pinnedCandidateIds : [] })
      return { sessionId: this.sessionId!, scope, channel: 'model' as const, publicationId: snapshot,
        documentId: document.id, knowledgeHash: contextKnowledgeHash(document), projection }
    })
    const candidateEvidence = Object.fromEntries(projections.flatMap(({ scope, projection }) => documents[scope].document.candidates
      .filter(candidate => projection.sourceCandidateIds.includes(candidate.id)).map(candidate => [candidate.id, candidate.evidenceRefs])))
    return { projections, candidateEvidence }
  }

  private reportAuxiliaryFailure(mode: ContextAssistantMode, correlationId: string, error: unknown) {
    if (!this.closed) this.createArtifact('runtime-error', `Context assistant · ${mode}`, {
      mode, code: error instanceof Error ? error.message : String(error),
    }, correlationId)
  }

  private async invokeContextAssistant(mode: ContextAssistantMode, operationId: string, correlationId: string,
    fields: Omit<ModeInput, 'mode' | 'snapshotId' | 'binding' | 'budget'>, signal?: AbortSignal,
  ): Promise<{ output?: ModeOutput; artifactId?: string; failure?: string }> {
    if (!this.sessionId || this.closed || signal?.aborted) throw new Error('CONTEXT_ASSISTANT_CANCELLED')
    const generation = this.generation
    const scope = { sessionId: this.sessionId, taskId: this.taskControl.taskId || 'idle-context', runId: this.run.runId ?? 'idle-context' }
    const binding = { ...scope, requestId: correlationId, stateRevision: this.taskControl.stateRevision }
    const budget = { ...DEFAULT_AUXILIARY_BUDGET, ...this.contextAssistant.budget }
    const contextHash = this.contextAssistantHash()
    const runner = this.getAuxiliaryRunner()
    const snapshotId = `context-assistant-${capabilityHash({ mode, binding, operationId, contextHash })}`
    const input: ModeInput = { ...fields, mode, snapshotId, binding, budget }
    try {
      let record = runner.store.find(scope, operationId)
      if (record && (record.mode !== mode || record.binding.requestId !== binding.requestId || record.contextHash !== contextHash)) {
        throw new Error('CONTEXT_ASSISTANT_SNAPSHOT_STALE')
      }
      if (record) record = runner.recover(record)
      else record = await runner.invoke({ ...buildContextAssistantRequest(input), mode, operationId, binding, snapshotId, contextHash }, budget,
        this.meteredLlm(mode, this.contextProcessingLlm(), { requestId: operationId }), value => validateContextAssistantOutput(input, value), signal,
        response => { if (!this.closed && this.generation === generation && this.run.runId === scope.runId) this.addUsage(response.usage) })
      if (this.closed || this.generation !== generation || signal?.aborted) throw new Error('CONTEXT_ASSISTANT_CANCELLED')
      if (record.status === 'running') throw new Error('CONTEXT_ASSISTANT_PENDING')
      const currentHash = this.contextAssistantHash()
      let artifactId = record.consumption?.artifactId
      if (!artifactId) {
        const packet = toJsonValue({ kind: 'context-assistant-source', mode, callId: record.id, binding: record.binding,
          snapshotId: record.snapshotId, contextHash: record.contextHash, schemaHash: record.schemaHash, promptBindings: record.promptBindings,
          modelBinding: record.modelBinding, request: record.request, response: record.response, status: record.status,
          resultHash: record.resultHash, output: record.output, error: record.error })
        const artifact = this.createArtifact('model-response', `Context assistant result · ${mode}`, packet, correlationId)
        this.projectContextStore.commits.saveArtifactSource(scope.sessionId, artifact, JSON.stringify(packet, null, 2))
        artifactId = artifact.id
      }
      const consumed = runner.store.consume(scope, record.id, record.resultHash, currentHash, artifactId)
      if (this.closed || this.generation !== generation || signal?.aborted) throw new Error('CONTEXT_ASSISTANT_CANCELLED')
      if (contextHash !== currentHash || contextHash !== this.contextAssistantHash()) throw new Error('CONTEXT_ASSISTANT_SNAPSHOT_STALE')
      if (consumed.consumption?.decision === 'accepted') return { output: consumed.output as ModeOutput, artifactId }
      const failure = consumed.error ?? consumed.consumption?.decision ?? 'CONTEXT_ASSISTANT_RESULT_UNAVAILABLE'
      this.reportAuxiliaryFailure(mode, correlationId, failure)
      return { artifactId, failure }
    } catch (error) {
      if (this.closed || this.generation !== generation || signal?.aborted) throw new Error('CONTEXT_ASSISTANT_CANCELLED')
      if (contextHash !== this.contextAssistantHash()) throw new Error('CONTEXT_ASSISTANT_SNAPSHOT_STALE')
      if (error instanceof Error && ['CONTEXT_ASSISTANT_SNAPSHOT_STALE', 'CONTEXT_ASSISTANT_PENDING'].includes(error.message)) throw error
      this.reportAuxiliaryFailure(mode, correlationId, error)
      return { failure: error instanceof Error ? error.message : String(error) }
    }
  }

  private reflectionContextHash(): string {
    const store = this.projectContextStore.commits
    const session = this.sessionId ? store.loadDocument(this.sessionId, { observe: false })?.document : undefined
    const project = store.loadDocument(undefined, { observe: false })?.document
    return capabilityHash({ taskId: this.taskControl.taskId, stateRevision: this.taskControl.stateRevision, planRevision: this.taskControl.planRevision,
      project: contextKnowledgeHash(project ?? this.projectContextDocumentEngine.snapshot()), session: contextKnowledgeHash(session ?? this.contextDocumentEngine.snapshot()) })
  }

  private reflectionModelView(): JsonObject {
    if (!this.reflectionRecordId) return {}
    try {
      const record = this.getAuxiliaryRunner().store.get(this.childBinding(), this.reflectionRecordId)
      const accepted = record.consumption?.decision === 'accepted'
      const output = record.output as ReflectionOutput | undefined
      return toJsonValue({ id: record.id, mode: record.mode, status: record.status, consumption: record.consumption,
        guidanceOnly: true, ...(record.consumption?.artifactId ? { rawArtifactId: record.consumption.artifactId } : {}), ...(record.error ? { error: record.error } : {}),
        ...(accepted && output ? { output } : {}) }) as JsonObject
    } catch (error) { return { id: this.reflectionRecordId, status: 'unavailable', error: error instanceof Error ? error.message : String(error) } }
  }

  private async executePendingReflection(correlationId: string, generation: number): Promise<void> {
    const triggerId = this.v2ControlState.requestId
    if (!triggerId) throw new Error('REFLECTION_TRIGGER_MISSING')
    this.reflectionRecordId = undefined
    this.reflectionFailure = undefined
    const runner = this.getAuxiliaryRunner(), scope = this.childBinding(), operationId = `reflection:${triggerId}`
    const controller = new AbortController()
    this.activeAbortController = controller
    let record: AuxiliaryRecord | undefined
    try {
      record = runner.store.find(scope, operationId)
      if (record) record = runner.recover(record)
      if (!record) {
        if (runner.store.list(scope).filter(call => call.mode === 'reflection').length >= 3) throw new Error('RUNTIME_REFLECTION_LIMIT')
        const failed = this.timeline.filter(step => step.status === 'error' || step.status === 'interrupted' || (step.type === 'tool' && step.detail?.ok === false))
        if (!failed.length && !this.run.failure) throw new Error('REFLECTION_FAILURE_EVIDENCE_REQUIRED')
        const budget = { ...DEFAULT_AUXILIARY_BUDGET, ...this.contextAssistant.budget }
        const sources: ReflectionSource[] = []
        const addSource = (id: string, kind: string, value: unknown) => {
          if (sources.some(source => source.id === id)) return
          const text = typeof value === 'string' ? value : JSON.stringify(value)
          sources.push({ id, kind, content: text.slice(0, 1600), sourceHash: createHash('sha256').update(text).digest('hex'), partial: text.length > 1600, totalCharacters: text.length })
        }
        for (const step of failed.slice(-8)) addSource(step.id, 'failed-step', step)
        const relevant = this.contextHistory.snapshot().messages.filter(message => message.origin === 'user' || message.origin === 'tool').slice(-6)
        for (const message of relevant) addSource(message.id, message.origin, message.rawContent ?? message.message.content)
        const latestContext = this.contextItems.at(-1)
        if (latestContext) { const original = this.artifacts.get(latestContext.renderArtifactId); if (original) addSource(original.meta.id, 'task-instructions-readonly', original.value) }
        const allPublications = this.projectContextStore.commits.readPublications(scope.sessionId).filter(publication => publication.channel === 'model' && publication.publicationId === JSON.stringify([scope.runId, triggerId]))
        let projectionSize = 0
        const publications = allPublications.filter(publication => { const size = JSON.stringify(publication).length; if (projectionSize + size > 8000) return false; projectionSize += size; return true })
        const evidenceIndex = publications.flatMap(publication => {
          const document = publication.scope === 'project' ? this.projectContextDocumentEngine.snapshot() : this.contextDocumentEngine.snapshot()
          const ids = new Set([...document.candidates.filter(candidate => publication.projection.sourceCandidateIds.includes(candidate.id)).flatMap(candidate => candidate.evidenceRefs),
            ...document.information.filter(entry => publication.projection.sourceEntryIds.includes(entry.id)).flatMap(entry => entry.evidenceRefs)])
          return document.evidence.filter(evidence => ids.has(evidence.id)).map(evidence => ({ id: evidence.id, referenceId: evidence.referenceId, sourceHash: evidence.sourceHash, sessionId: evidence.sessionId }))
        })
        const input: ReflectionInput = { snapshotId: `reflection-snapshot-${randomUUID()}`, binding: { ...scope, requestId: triggerId, stateRevision: this.taskControl.stateRevision }, contextHash: this.reflectionContextHash(), budget,
          goal: this.taskControl.goal, sources, omittedSources: Math.max(0, failed.length - 8) + Math.max(0, this.contextHistory.size - relevant.length) + allPublications.length - publications.length,
          publications, evidenceIndex, runtimeState: { task: clone(this.taskControl), control: clone(this.v2ControlState), readonly: true } }
        const request = reflectionRequest(input)
        record = await runner.invoke({ ...request, operationId, mode: 'reflection', binding: input.binding, snapshotId: input.snapshotId, contextHash: input.contextHash }, budget,
          this.meteredLlm('reflection', this.contextProcessingLlm(), { requestId: operationId }), value => validateReflection(value, input), controller.signal,
          response => { if (!this.closed && this.generation === generation) this.addUsage(response.usage) },
          reserved => { this.reflectionRecordId = reserved.id; this.createArtifact('model-request', 'Reflection request (read-only)', { callId: reserved.id, mode: reserved.mode, binding: reserved.binding, snapshotId: reserved.snapshotId,
            promptBindings: reserved.promptBindings, schemaHash: reserved.schemaHash, modelBinding: reserved.modelBinding, request: reserved.request, budget }, correlationId) })
      }
      if (this.closed || this.generation !== generation) return
      this.reflectionRecordId = record.id
      if (record.status === 'running') throw new Error('REFLECTION_REQUEST_STILL_RUNNING')
      let artifactId = record.consumption?.artifactId
      if (!artifactId) {
        const packet = toJsonValue({ kind: 'reflection-source', callId: record.id, mode: record.mode, snapshotId: record.snapshotId, status: record.status,
          binding: record.binding, createdAt: record.createdAt, contextHash: record.contextHash, schemaHash: record.schemaHash, promptBindings: record.promptBindings, modelBinding: record.modelBinding,
          inputHash: capabilityHash(record.request), input: record.request, resultHash: record.resultHash ?? null, output: record.output ?? null, response: record.response ?? null, error: record.error ?? null })
        const source = this.createArtifact('model-response', 'Reflection result (guidance only)', packet, correlationId)
        this.projectContextStore.commits.saveArtifactSource(scope.sessionId, source, JSON.stringify(packet, null, 2))
        artifactId = source.id
      }
      record = runner.store.consume(scope, record.id, record.resultHash, this.reflectionContextHash(), artifactId)
      this.createArtifact('context-diff', 'Reflection consumption receipt', { callId: record.id, consumption: record.consumption, appliedDiffs: [], historyChanged: false }, correlationId)
    } catch (error) {
      if (this.closed || this.generation !== generation) return
      const code = error instanceof Error ? error.message : String(error)
      const failure = this.createArtifact('runtime-error', 'Reflection kept the original task and evidence', { code, ...(record ? { callId: record.id } : {}), appliedDiffs: [] }, correlationId)
      this.reflectionFailure = { requestId: triggerId, code, artifactId: failure.id }
    } finally {
      if (this.activeAbortController === controller) this.activeAbortController = undefined
      if (!this.closed && this.generation === generation) {
        this.v2ControlState = { status: 'idle', evidenceRequests: clone(this.v2ControlState.evidenceRequests), uncertainties: clone(this.v2ControlState.uncertainties), reflectionAttempts: this.v2ControlState.reflectionAttempts }
        this.taskControl.stateRevision++; this.snapshotRevision++
        this.emit('runtime.context.v2.control.cleared', { requestId: triggerId }, correlationId)
      }
    }
  }

  private publishV2DreamPass(correlationId: string, explicit = false): void {
    const enabled = this.contextAssistantEnabled('dream') && this.sessionId
    if (enabled) {
      if (!['idle', 'completed', 'failed', 'cancelled', 'interrupted'].includes(this.run.status)) {
        if (explicit) this.reportAuxiliaryFailure('dream', correlationId, 'DREAM_REQUIRES_IDLE_WINDOW')
        return
      }
      void this.publishAssistedDream(correlationId).catch(error => this.reportAuxiliaryFailure('dream', correlationId, error))
      return
    }
    this.publishDreamPlan(correlationId)
  }

  private async publishAssistedDream(correlationId: string) {
    if (this.idleDreamController) throw new Error('DREAM_ALREADY_RUNNING')
    this.refreshProjectLlm()
    const plan = this.contextDocumentEngine.dream()
    const window = capabilityHash({ context: this.contextAssistantHash(), runId: this.run.runId, correlationId })
    const documents = this.contextAssistantDocuments(window)
    const candidates = documents.projections.flatMap(item => item.projection.sourceCandidateIds)
    if (!candidates.length) { this.publishDreamPlan(correlationId); return }
    const visibleIds = new Set(candidates)
    const visiblePlan = {
      documentRevision: plan.documentRevision,
      duplicateCandidateGroups: plan.duplicateCandidateGroups.map(group => group.filter(id => visibleIds.has(id))).filter(group => group.length > 1),
      staleCandidateIds: plan.staleCandidateIds.filter(id => visibleIds.has(id)),
      proposalCandidateIds: plan.proposalCandidateIds.filter(id => visibleIds.has(id)),
      boundedProjection: true,
    }
    const protectedEntryIds = (this.contextHistory.coverageSnapshot().requiredEntries ?? []).map(item => item.id)
    const controller = new AbortController()
    this.idleDreamController = controller
    try {
      const review = await this.invokeContextAssistant('dream', `dream:${window}`, correlationId, {
        ...documents, protectedEntryIds, projectFrozen: assetWriteAudit(this.projectDir, 'context.policy.read').readonly,
        visibleSources: { plan: visiblePlan, candidateIds: candidates }, sourceIds: candidates, selectionIds: candidates, selectionLimit: 10,
        taskSignals: this.contextAssistantTaskSignals(),
      }, controller.signal)
      if (!controller.signal.aborted && !this.closed) this.publishDreamPlan(correlationId, toJsonValue(review))
    } finally {
      if (this.idleDreamController === controller) this.idleDreamController = undefined
    }
  }

  private publishDreamPlan(correlationId: string, review?: JsonValue): void {
    const plan = this.contextDocumentEngine.dream() as RuntimeContextDreamPlan
    const artifact = this.createArtifact('context-diff', 'V2 dream plan', {
      promptRevision: V2_CONSTITUTION_REVISION,
      plan, ...(review ? { review } : {}),
      instruction: 'Dream output is a candidate plan only; apply every change through evidence review and semantic diff gates.',
    }, correlationId)
    this.emit('runtime.context.v2.dream.created', { plan, artifactId: artifact.id }, correlationId)
  }

  private migrateLegacyContextToV2(): void {
    for (const observation of this.observations) {
      if (observation.status === 'running') continue
      const capturedAt = observation.completedAt ?? observation.startedAt
      const normalizedContent = observation.resultPreview
        ?? (observation.error === undefined ? '' : JSON.stringify(observation.error))
      try {
        this.contextDocumentEngine.observe({
          candidate: {
            source: {
              actor: 'tool',
              sourceId: observation.id,
              toolName: observation.toolName,
              runId: observation.runId,
              stepId: observation.stepId,
              capturedAt,
            },
            rawArtifactId: observation.resultArtifactId ?? `observation:${observation.id}`,
            normalizedContent,
          },
          evidence: {
            kind: observation.resultArtifactId ? 'artifact' : 'observation',
            referenceId: observation.resultArtifactId ?? observation.id,
            observedAt: capturedAt,
            confidence: observation.status === 'completed' ? 'medium' : 'low',
          },
        })
      } catch {
        // A malformed legacy observation stays in the original runtime trace;
        // migration must not rewrite or drop that source history.
      }
    }
    this.syncV2StaticSections(this.renderResult.messages.find((message) => message.role === 'system')?.content ?? '')
    this.syncV2DynamicSections()
  }

  private syncV2StaticSections(renderedSystemPrompt: string, binding: { sessionId?: string; runId?: string; requestId?: string } = {}, capabilityProjection?: RuntimeCapabilityProjection): void {
    this.setV2StaticSections(this.v2SystemPrompt(renderedSystemPrompt, binding, capabilityProjection))
  }

  private setV2StaticSections(system: string): void {
    this.contextDocumentEngine.setSectionContent('system', system, { governance: 'runtime' })
    this.contextDocumentEngine.setSectionContent('tools', JSON.stringify(this.tools.catalog), { governance: 'runtime' })
  }

  /**
   * AppWorld discovery is stateful. Once two incomplete direct executions have
   * returned, keep the next model turn on the workflow path so a predictable
   * chain is represented as one auditable graph instead of another ad hoc call.
   */
  private workflowRequiresAppworldBatch(projection?: RuntimeCapabilityProjection): boolean {
    if (!projection?.bindings.some(binding => binding.name === 'execute_workflow')
      || !projection.bindings.some(binding => binding.name === 'appworld_execute')) return false
    if (this.observations.some(observation => observation.toolName === 'execute_workflow')) return false
    const directCalls = this.observations.filter(observation => observation.toolName === 'appworld_execute' && observation.status === 'completed')
    if (directCalls.length < 2) return false
    const latest = directCalls.at(-1)
    if (!latest?.resultArtifactId) return true
    const artifact = this.artifacts.get(latest.resultArtifactId)
    const value = artifact?.value
    const output = isObject(value) && isObject(value.result) ? value.result : value
    return isObject(output) && output.completed !== true
  }

  private v2SystemPrompt(renderedSystemPrompt: string, binding: { sessionId?: string; runId?: string; requestId?: string },
    capabilityProjection?: RuntimeCapabilityProjection, fileProjection?: Pick<ReturnType<typeof projectFileHistory>, 'hasReferences' | 'hasPartialViews'>,
    editOutcomes?: readonly ContextOutcomeAttempt[], showNativeFileQuotes = false): string {
    const document = this.contextDocumentEngine.snapshot()
    const requestBinding = binding.sessionId && binding.runId && binding.requestId && this.taskControl.taskId
      ? { sessionId: binding.sessionId, runId: binding.runId, requestId: binding.requestId, taskId: this.taskControl.taskId, stateRevision: this.taskControl.stateRevision }
      : undefined
    const reportModelBudget = requestBinding && (this.modelBudgetLimits.maxTokens !== DEFAULT_MODEL_BUDGET.maxTokens
      || this.modelBudgetLimits.maxAttempts !== DEFAULT_MODEL_BUDGET.maxAttempts)
    const modelBudget = reportModelBudget ? this.getModelBudgetSummary() : undefined
    const mcpState = this.mcp.snapshot()
    const mcpInputs = this.mcpInputViews().map(({ forms: _forms, urls, ...summary }) => ({
      ...summary, ...(urls?.length ? { hasUrlInput: true } : {}),
      ...(summary.status === 'pending' ? { waitSpec: { reason: '等待工作台回复人工输入', signalType: 'runtime',
        correlationIds: [summary.id], condition: { eventType: MCP_INPUT_RESPONDED }, deadlineRef: null } } : {}),
    }))
    const mcpVerifications = mcpState.servers.length && requestBinding ? this.verifiedMcpOperations().map(({ binding, verification }) => ({
      operationId: verification!.operationId, receiptId: verification!.id, outcome: verification!.outcome,
      callId: binding!.callId, artifactId: verification!.artifactId,
    })) : []
    const workflowRecoveries = this.workflows.items.flatMap(plan => {
      const recovery = plan.recovery
      if (!recovery || !['failed', 'suspended'].includes(plan.status) || plan.runId !== this.run.runId) return []
      const completion = this.workflowFormCompletion(plan)
      const activeForm = mcpInputs.find(input => input.workflow?.id === plan.id && input.workflow.nodeId === recovery.nodeId)
      return [{ workflowId: plan.id, ...recovery, ...(activeForm ? { inputRequestId: activeForm.id, inputStatus: activeForm.status } : {}),
        ...(completion ? { inputReceiptId: completion.artifactId } : {}), verificationReceiptId: mcpVerifications.find(item => item.operationId === recovery.operationId)?.receiptId }]
    })
    const execution = capabilityProjection?.execution ?? runtimeExecutionState(this.taskControl)
    const allowedDecisions = execution.allowedDecisions.filter(decision => decision !== 'tool_call')
    const workflowRequired = this.workflowRequiresAppworldBatch(capabilityProjection)
    const contextActions = requestBinding ? this.contextPlanActionRefs() : new Map<string, string>()
    const branchReplies = requestBinding ? this.branchHumanReplyReceipts() : []
    const completedActions = requestBinding ? this.completedRuntimeActionKeys(contextActions, branchReplies) : new Set<string>()
    const completionActionRefs = [...completedActions].filter(key => /^(call|step|context|human):/.test(key)).slice(-32)
    const activePlanTasks = new Set(execution.activeTaskIds)
    const foreignActionRefs = new Map<string, readonly string[]>()
    if (requestBinding && activePlanTasks.size) {
      const owners = this.planActionOwners(contextActions, branchReplies)
      for (const id of activePlanTasks) {
        const refs = completionActionRefs.filter(ref => owners.has(ref) && !owners.get(ref)!.includes(id)
          && !this.taskControl.tasks.find(node => node.id === id)?.requiredActions.includes(ref))
        if (refs.length) foreignActionRefs.set(id, refs)
      }
    }
    const recentPlanActions = requestBinding && activePlanTasks.size ? this.timeline.flatMap(step => {
      const receipt = step.detail?.executionReceipt
      if (step.type !== 'tool' || step.status !== 'success' || !isObject(receipt) || receipt.runId !== requestBinding.runId
        || receipt.status !== 'succeeded' || typeof receipt.completionActionRef !== 'string') return []
      const taskIds = receiptCompletionTaskIds(receipt).filter(id => activePlanTasks.has(id))
      return taskIds.length ? [{ taskIds, toolName: receipt.toolName, completionActionRef: receipt.completionActionRef, resultArtifactId: receipt.resultArtifactId }] : []
    }).slice(-16) : []
    const recentContextEdits = (editOutcomes ?? (requestBinding ? this.projectContextStore.commits.readRecentModelOutcomes(requestBinding) : []))
      .map(({ scope, proposal, receipt, replayed, requestBinding: origin, planTaskId }) => ({
        receiptId: receipt.id, sourceRequestId: origin!.requestId, scope, operation: proposal.operation, nodeId: proposal.target.nodeId,
        title: proposal.payload.title, parentNodeId: proposal.payload.parentNodeId,
        ...(proposal.target.headingPath?.length ? { headingPath: proposal.target.headingPath } : {}),
        ...(!proposal.target.nodeId && receipt.changedEntryIds.length ? { changedEntryIds: receipt.changedEntryIds } : {}),
        result: receipt.result, nextRevision: receipt.nextRevision, errorCode: receipt.errorCode,
        ...(planTaskId && contextActions.get(`context:${receipt.id}`) === planTaskId ? { planTaskId, completionActionRef: `context:${receipt.id}` } : {}),
        ...(receipt.unchanged ? { unchanged: true } : {}), ...(replayed ? { replayed } : {}),
      }))
    const runtimeState = {
      ...this.taskControl,
      completionActionRefs,
      ...(recentPlanActions.length ? { recentPlanActions } : {}),
      taskStatus: this.run.status,
      ...(this.run.failure?.code === 'WAIT_REGISTRATION_NOT_COMMITTED' ? { waitRecovery: this.run.failure } : {}),
      contextControl: this.v2ControlState,
      ...(branchReplies.length ? { branchHumanReplies: branchReplies.slice(-8) } : {}),
      ...(recentContextEdits.length ? { recentContextEdits } : {}),
      ...(this.reflectionRecordId || this.reflectionFailure ? { reflection: { ...this.reflectionModelView(), ...(this.reflectionFailure ? { failure: this.reflectionFailure } : {}) } } : {}),
      ...this.projectRuntimeActivity(),
      ...(mcpState.servers.length || mcpState.unknownCallCount || mcpInputs.length ? { mcp: { ...mcpState, ...(mcpVerifications.length ? { verifications: mcpVerifications } : {}),
        ...(mcpInputs.length ? { inputRequests: mcpInputs } : {}) } } : {}),
      ...(workflowRecoveries.length ? { workflowRecoveries } : {}),
      execution: { ...execution, allowedDecisions },
      allowedDecisions,
      ...(capabilityProjection ? { capabilityProjection: { id: capabilityProjection.id, planRevision: capabilityProjection.execution.planRevision } } : {}),
      supportedOperations: [...CONTEXT_DIFF_OPERATIONS],
      diffVersions: { content: 1, structure: 2 },
      budget: { maxToolRounds: this.maxToolRounds, usedToolRounds: this.toolRound, ...(this.maxToolRounds >= 0 && this.toolRound >= this.maxToolRounds ? { toolRoundsExhausted: true } : {}),
        ...(reportModelBudget ? { model: {
        remainingTokens: modelBudget?.remainingTokens ?? this.modelBudgetLimits.maxTokens,
        remainingAttempts: modelBudget?.remainingAttempts ?? this.modelBudgetLimits.maxAttempts,
      } } : {}) },
    }
    const parts = [V2_CONSTITUTION_PROMPT, buildV2RuntimePrompt({
      documentRevision: document.revision, projectionProfile: 'runtime-default',
      pendingCandidateCount: document.candidates.filter((candidate) => candidate.status === 'pending' || candidate.status === 'conflict').length,
      ...binding, binding: requestBinding, taskControl: this.taskControl, runtimeState, allowedDecisions, hasCompletedActions: completedActions.size > 0,
      ...(this.taskControl.tasks.length ? { askUserTaskIds: runtimeHumanQuestionTargets(this.taskControl, execution) } : {}),
      planProgressBinding: { ...execution, foreignActionRefs },
      showMcpForm: mcpInputs.length > 0 || workflowRecoveries.some(recovery => !!recovery.inputReceiptId),
      showMcpRecovery: Boolean(mcpState.pendingOperations?.length),
      showWorkflowRecovery: workflowRecoveries.length > 0,
      showDelegation: this.childAgentEnabled && !this.childAgentMode,
      showChildReview: [...this.childRecords.values()].some(record => record.parentRunId === this.run.runId && record.parentTaskId === this.taskControl.taskId),
      showFileReferences: fileProjection?.hasReferences,
      showUnresolvedFileLines: fileProjection?.hasPartialViews,
      showContextReferences: fileProjection !== undefined,
      showNativeFileQuotes,
      showContextEditReceipts: recentContextEdits.length > 0,
      showPlannedDiffs: execution.phase === 'execution' && execution.activeTaskIds.length > 0,
      workflowGuidance: (() => {
        const projectedTools = capabilityProjection?.bindings.map(tool => tool.name) ?? []
        const available = projectedTools.includes('execute_workflow')
        return available ? {
          available: true,
          required: workflowRequired,
          projectedTools: projectedTools.slice(0, 32),
          trigger: '当两个或更多动作已经可预测，或需要解析、对齐、校验、筛选、转换、批量执行、连接或断言工具输出时，优先提交一次 execute_workflow。',
          ...(workflowRequired ? { requirement: '已有两次未完成的 appworld_execute 结果。下一次业务调用必须先提交 execute_workflow，把可预测的 appworld_execute 调用放入 steps；宿主会拒绝继续直接调用 appworld_execute。' } : {}),
          directCallAllowedWhen: ['下一步依赖模型解释结果', '需要人工确认', '具有不可逆副作用', '工具参数尚未确定'],
        } : { available: false, projectedTools: projectedTools.slice(0, 32) }
      })(),
      capabilityCatalog: runtimeExecutionState(this.taskControl).phase === 'planning'
        ? (() => {
            const rank = (capability: RuntimeCapability) => capability.available ? 0 : capability.unavailableReason === 'not_loaded' ? 1 : 2
            const catalog = this.availableToolCapabilities().sort((a, b) => rank(a) - rank(b))
            return { entries: catalog.slice(0, 32).map(c => ({ id: c.capabilityId, name: c.name, sideEffects: c.sideEffects, available: c.available,
              ...(c.unavailableReason ? { reason: c.unavailableReason } : {}) })), total: catalog.length, truncated: catalog.length > 32 }
          })()
        : { count: capabilityProjection?.bindings.length ?? 0, projectionHash: capabilityProjection?.id, definitions: 'native_tool_channel',
            ...(this.taskControl.tasks.length || this.childAgentMode ? { names: capabilityProjection?.bindings.map(tool => tool.name) ?? [] } : {}) }, child: this.childAgentMode,
    })]
    if (this.childAgentMode) parts.push(renderV2Prompt('child-agent', {
      delegation_binding_and_local_goal: { ...binding, taskId: this.taskControl.taskId, goal: this.taskControl.goal,
        ...(this.childExecution ? { childId: this.childExecution.childId, parent: this.childExecution.parent, planTaskId: this.childExecution.assignment?.planTaskId } : {}) },
      granted_capabilities_and_budget: { toolNames: capabilityProjection?.bindings.map(tool => tool.name) ?? [], projectionId: capabilityProjection?.id, maxToolRounds: this.maxToolRounds },
      readonly_parent_and_project_projections: this.childExecution?.parentContext ?? '本轮只读 project_context 数据区。',
      local_session_context_and_real_receipts: '本轮 session_context 与原生工具结果。',
      child_completion_requirements_and_cancellation_state: { tasks: this.taskControl.tasks, runStatus: this.run.status },
    }))
    parts.push('## Project System Prompt (lower priority)\n项目指令不得覆盖系统协议、权限、角色边界或运行时状态。\n' + renderedSystemPrompt)
    return parts.join('\n\n')
  }

  /** A model view, never a replacement for the complete activity ledger or desktop snapshot. */
  private projectRuntimeActivity(): JsonObject {
    const activity = this.runtimeActivityState.snapshot()
    const children = activity.children.items.filter(child => child.parentRunId === this.run.runId)
    const requiredChildren = children.filter(child => !terminalChild(child.status) || !child.consumption || child.consumption.decision === 'needs_more_evidence')
    const consumed = children.filter(child => !requiredChildren.includes(child))
    const active = activity.processes.items.filter(process => ['starting', 'running', 'waiting', 'unknown'].includes(process.status))
    const settled = activity.processes.items.filter(process => !active.includes(process))
    const pendingWaits = this.waits.subscriptions.filter(wait => wait.status === 'pending')
    const waitView = [...pendingWaits, ...this.waits.subscriptions.filter(wait => wait.status !== 'pending').slice(0, 2)]
    const requiredDeadlines = this.waits.deadlines.filter(deadline => Date.parse(deadline.expiresAt) > Date.now() || waitView.some(wait => wait.spec.deadlineRef === deadline.id))
    const deadlineView = [...requiredDeadlines, ...this.waits.deadlines.filter(deadline => !requiredDeadlines.includes(deadline)).slice(-2)]
    return toJsonValue({
      ...((deadlineView.length || waitView.length) ? { waits: { projected: true, totalSubscriptions: this.waits.subscriptions.length,
        deadlines: deadlineView.map(deadline => ({ id: deadline.id, expiresAt: deadline.expiresAt, timeoutMs: deadline.timeoutMs })),
        subscriptions: waitView.map(wait => ({ id: wait.id, status: wait.status, ...(wait.status === 'pending' ? { spec: wait.spec } : { blockingTaskIds: wait.spec.blockingTaskIds }), deadlineAt: wait.deadlineAt,
          matchedSignalIds: wait.matchedSignalIds, reason: wait.reason, cancelledBy: wait.cancelledBy, runCancelledAt: wait.runCancelledAt })) } } : {}),
      children: { revision: activity.children.revision, projected: true, total: children.length, items: [...requiredChildren, ...consumed.slice(-2)].map(child => ({
        id: child.id, goal: child.goal, status: child.status, ...(child.planTaskId ? { planTaskId: child.planTaskId } : {}),
        ...(!terminalChild(child.status) ? { waitRef: child.waitRef, deadlineAt: child.deadlineAt,
          ...(child.status === 'waiting' ? { question: child.question, inputRequestId: child.inputRequestId } : {}) } : {}),
        ...(requiredChildren.includes(child) && child.resultHash ? { resultHash: child.resultHash } : {}),
        ...(child.consumption ? { consumption: { decision: child.consumption.decision, receiptId: child.consumption.receiptId } } : {}),
      })) },
      processes: { revision: activity.processes.revision, projected: true, total: activity.processes.items.length, settledCount: settled.length,
        items: [...active, ...settled.slice(-2)].map(process => ({ id: process.id, name: process.name, kind: process.kind, status: process.status,
          ...(process.runId !== this.run.runId ? { runId: process.runId } : {}), pid: process.pid, error: process.error })) },
    }) as JsonObject
  }

  private syncV2DynamicSections(): void {
    const messages = this.messages.map((message) => {
      const content = message.content.map((item) => item.text).join('')
      return `## [${message.id}] ${message.role}\n${content}`
    }).join('\n\n')
    this.contextDocumentEngine.setSectionContent('messages', this.contextOrganization.enabled ? '' : messages)
    this.contextDocumentEngine.setMessageCursor(this.messages.length)
  }

  private captureContextRevision(
    reason: string,
    includedFiles: readonly string[],
    missingVariables: readonly string[],
    correlationId?: string,
  ): RuntimeContextRevision {
    const renderArtifact = this.createArtifact(
      'context-render',
      `Rendered context · ${reason}`,
      this.renderResult.messages[0]?.content ?? '',
      correlationId,
    )
    const messagesArtifact = this.createArtifact(
      'context-messages',
      `Rendered messages · ${reason}`,
      this.renderResult.messages,
      correlationId,
    )
    const toolsArtifact = this.createArtifact(
      'context-tools',
      `Active tool schemas · ${reason}`,
      [
        ...this.internalResourceTools(),
        ...this.tools.items.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        })),
      ],
      correlationId,
    )
    const previous = this.contextItems.at(-1)
    const previousRender = previous
      ? this.artifacts.get(previous.renderArtifactId)?.value
      : undefined
    const diffArtifact = typeof previousRender === 'string'
      ? this.createArtifact(
          'context-diff',
          `Context diff · ${reason}`,
          textDiff(previousRender, this.renderResult.messages[0]?.content ?? ''),
          correlationId,
        )
      : undefined
    const context: RuntimeContextRevision = {
      id: `context-${this.contextRevision + 1}-${randomUUID()}`,
      ...(previous ? { parentId: previous.id } : {}),
      reason,
      templateRevision: this.template.revision,
      variablesRevision: this.variables.revision,
      renderArtifactId: renderArtifact.id,
      messagesArtifactId: messagesArtifact.id,
      toolsArtifactId: toolsArtifact.id,
      ...(diffArtifact ? { diffArtifactId: diffArtifact.id } : {}),
      includedFiles: [...includedFiles],
      missingVariables: [...missingVariables],
      createdAt: now(),
    }
    const defer = Boolean(
      this.run.runId &&
      ['running', 'pause_requested', 'interrupting'].includes(this.run.status),
    )
    if (defer) {
      this.pendingContextRevisionId = context.id
    } else {
      context.appliedAt = now()
      this.activeContextRevisionId = context.id
      this.pendingContextRevisionId = undefined
      const system = this.renderResult.messages[0]
      if (system?.role === 'system' && this.llmMessages[0]?.role === 'system') {
        this.llmMessages[0] = { role: 'system', content: system.content }
      }
      this.syncSystemMessages(correlationId)
    }
    this.contextItems.push(context)
    this.contextRevision += 1
    this.snapshotRevision += 1
    this.emit('runtime.context.revision.created', {
      revision: this.contextRevision,
      context: clone(context),
    }, correlationId)
    if (!defer) {
      this.emit('runtime.context.applied', {
        revision: this.contextRevision,
        contextRevisionId: context.id,
        ...(previous ? { previousContextRevisionId: previous.id } : {}),
      }, correlationId)
    }
    return context
  }

  private applyContextRevision(contextRevisionId: string, correlationId: string): void {
    const context = this.contextItems.find((item) => item.id === contextRevisionId)
    if (!context) throw new CommandError('NOT_FOUND', 'context revision was not found')
    const messages = this.artifacts.get(context.messagesArtifactId)?.value
    if (!Array.isArray(messages)) throw new Error('context messages artifact is invalid')
    const previousContextRevisionId = this.activeContextRevisionId
    this.activeContextRevisionId = context.id
    if (this.pendingContextRevisionId === context.id) this.pendingContextRevisionId = undefined
    context.appliedAt = now()
    this.contextRevision += 1
    this.snapshotRevision += 1
    if (this.llmMessages[0]?.role === 'system') {
      const system = messages[0]
      if (isObject(system) && system.role === 'system' && typeof system.content === 'string') {
        this.llmMessages[0] = { role: 'system', content: system.content }
      }
    }
    this.syncSystemMessages(correlationId)
    this.emit('runtime.context.applied', {
      revision: this.contextRevision,
      contextRevisionId: context.id,
      ...(previousContextRevisionId ? { previousContextRevisionId } : {}),
    }, correlationId)
  }

  private checkpointMeta(checkpoint: RuntimeCheckpoint): RuntimeCheckpointMeta {
    return {
      id: checkpoint.id,
      currentStep: checkpoint.currentStep,
      ...(checkpoint.currentStepId ? { currentStepId: checkpoint.currentStepId } : {}),
      ...(checkpoint.contextRevisionId
        ? { contextRevisionId: checkpoint.contextRevisionId }
        : {}),
      createdAt: checkpoint.createdAt,
    }
  }

  private createCheckpoint(
    currentStep: number,
    currentStepId?: string,
    id = `checkpoint-${this.checkpointRevision + 1}-${randomUUID()}`,
  ): RuntimeCheckpoint {
    return {
      id,
      createdAt: now(),
      currentStep,
      currentStepId,
      contextRevisionId: this.activeContextRevisionId,
      variables: clone(this.variables.value),
      renderResult: clone(this.renderResult),
      messages: clone(this.messages),
      llmMessages: clone(this.llmMessages),
      tools: clone(this.tools.items),
      harnesses: clone(this.harnesses.items),
      skills: clone(this.skills.items),
      timeline: clone(this.timeline),
      effectiveContexts: clone(this.effectiveContextItems),
      observations: clone(this.observations),
      pendingToolCalls: clone([...this.pendingToolCalls.entries()]),
      pendingWorkflowCalls: clone([...this.pendingWorkflowCalls.entries()]),
      workflowDefinitions: clone([...this.workflowDefinitions.entries()]),
      workflowData: clone([...this.workflowData.entries()]),
      workflows: clone(this.workflows),
      toolRound: this.toolRound,
      continuationRound: this.continuationRound,
      loopIteration: this.loopIteration,
      loopVariableBaseline: clone(this.loopVariableBaseline),
      usage: clone(this.runUsage),
      contextDocumentState: this.contextDocumentEngine.exportState(),
      contextControl: clone(this.v2ControlState),
      ...(this.reflectionRecordId ? { reflectionRecordId: this.reflectionRecordId } : {}),
      ...(this.reflectionFailure ? { reflectionFailure: clone(this.reflectionFailure) } : {}),
      taskControl: clone(this.taskControl),
      mcp: { ...this.mcp.exportState(), activeToolIds: [...new Set([...this.mcpActiveToolIds, ...this.tools.items.filter(tool => tool.origin?.type === 'mcp').map(tool => tool.id)])] },
      ...(this.browserGateway ? { browserGateway: this.browserGateway.exportState() } : {}),
      ...(this.browserGateway ? { browserContexts: this.browserContextStates() } : {}),
    }
  }

  private pushCheckpoint(
    currentStep: number,
    currentStepId: string | undefined,
    correlationId: string,
    id?: string,
    beforePublish?: () => void,
  ): RuntimeCheckpoint {
    const checkpoint = this.createCheckpoint(currentStep, currentStepId, id)
    this.checkpoints.push(checkpoint)
    this.checkpoints = retainRecentCheckpoints(this.checkpoints)
    this.checkpointRevision += 1
    this.snapshotRevision += 1
    beforePublish?.()
    this.emit('runtime.checkpoint.created', {
      revision: this.checkpointRevision,
      checkpoint: this.checkpointMeta(checkpoint),
    }, correlationId)
    return checkpoint
  }

  private abortActiveWork(): void {
    this.idleDreamController?.abort()
    this.idleDreamController = undefined
    this.activeAbortController?.abort()
    this.activeAbortController = undefined
    this.toolDispatcher.abort()
    this.mcp.abort()
    this.skillScriptRunner.abort()
    for (const child of this.activeChildLoops) child.close()
    this.activeChildLoops.clear()
  }

  private cancelResponse(correlationId: string): void {
    const messageId = this.activeAssistantId
    if (!messageId) return
    this.responseGeneration += 1
    const message = this.messages.find((item) => item.id === messageId)
    if (message) {
      message.status = 'cancelled'
      message.completedAt = now()
    }
    this.activeAssistantId = undefined
    this.conversationRevision += 1
    this.snapshotRevision += 1
    this.emit(
      'chat.assistant.completed',
      {
        messageId,
        finishReason: 'cancelled',
        completedAt: message?.completedAt ?? now(),
      },
      correlationId,
    )
    this.updateRuntimeStatus({ model: 'ready' }, correlationId)
  }

  private updateVariables(
    patch: JsonPatchOperation[],
    source: 'user' | 'runtime' | 'tool' | 'hook' | 'restore',
    correlationId: string,
  ): void {
    const projectKeys = new Set(this.systemVariables.variables
      .filter((variable) => variable.scope === 'project')
      .map((variable) => variable.key))
    const sharedPatch = patch.filter((operation) => {
      if (!operation.path.startsWith('/builtin/prompts/') && !operation.path.startsWith('/builtin/variables/')) return false
      const tokens = decodePointer(operation.path)
      return tokens.length === 3 && projectKeys.has(tokens[2] ?? '')
    })
    if (sharedPatch.length > 0) {
      try {
        const updates = this.sharedVariableUpdates(sharedPatch)
        void this.projectResources.updateSharedSystemVariables(updates).catch((error: unknown) => {
          this.emit('protocol.error', {
            code: 'SHARED_VARIABLE_UPDATE_FAILED',
            message: error instanceof Error ? error.message : String(error),
          }, correlationId)
        })
      } catch (error) {
        this.emit('protocol.error', {
          code: 'SHARED_VARIABLE_UPDATE_FAILED',
          message: error instanceof Error ? error.message : String(error),
        }, correlationId)
      }
    }
    const baseRevision = this.variables.revision
    const effectivePatch = [...patch]
    let value = applyPatch(this.variables.value, effectivePatch)
    if (!effectivePatch.some((operation) =>
      operation.path === '/harnesses' || operation.path.startsWith('/harnesses/'),
    )) {
      this.refreshHarnessRenders(value, correlationId)
      const harnesses = this.harnessVariableValue()
      if (JSON.stringify(value.harnesses) !== JSON.stringify(harnesses)) {
        effectivePatch.push({ op: 'replace', path: '/harnesses', value: harnesses })
        value = applyPatch(value, [effectivePatch.at(-1) as JsonPatchOperation])
      }
    }
    this.variables = {
      revision: baseRevision + 1,
      value,
    }
    this.snapshotRevision += 1
    this.emit(
      'variables.updated',
      { baseRevision, revision: this.variables.revision, patch: effectivePatch, source },
      correlationId,
    )
    this.contextBuilder.setProperties(this.variables.value, false)
    this.renderAndPublish(correlationId)
  }

  private sharedVariableUpdates(
    patch: readonly JsonPatchOperation[],
  ): Array<{ key: string; value: SystemPromptVariableValue }> {
    return patch.map((operation) => {
      if (operation.op === 'remove' || operation.value === undefined || operation.value === null) {
        throw new CommandError('INVALID_PAYLOAD', 'shared variables accept add or replace operations with a JSON value')
      }
      const tokens = decodePointer(operation.path)
      if (tokens.length !== 3 || tokens[0] !== 'builtin' || (tokens[1] !== 'prompts' && tokens[1] !== 'variables')) {
        throw new CommandError('INVALID_PAYLOAD', 'shared variables must target /builtin/prompts/<key> or /builtin/variables/<key>')
      }
      const key = tokens[2]
      if (!key) throw new CommandError('INVALID_PAYLOAD', 'shared variable key is required')
      const variable = this.systemVariables.variables.find((item) => item.key === key)
      if (!variable || variable.scope !== 'project') {
        throw new CommandError('INVALID_PAYLOAD', `variable is not project-scoped: ${key}`)
      }
      try {
        validateSystemPromptVariableValue(variable.type, operation.value, `shared variable ${key}`)
      } catch (error) {
        throw new CommandError('INVALID_PAYLOAD', error instanceof Error ? error.message : String(error))
      }
      return { key, value: operation.value as SystemPromptVariableValue }
    })
  }

  private updateSharedVariables(
    patch: readonly JsonPatchOperation[],
    correlationId: string,
  ): void {
    let updates: Array<{ key: string; value: SystemPromptVariableValue }>
    try {
      updates = this.sharedVariableUpdates(patch)
    } catch (error) {
      this.emit('protocol.error', {
        code: 'SHARED_VARIABLE_UPDATE_FAILED',
        message: error instanceof Error ? error.message : String(error),
      }, correlationId)
      return
    }
    void this.projectResources.updateSharedSystemVariables(updates).catch((error: unknown) => {
      this.emit('protocol.error', {
        code: 'SHARED_VARIABLE_UPDATE_FAILED',
        message: error instanceof Error ? error.message : String(error),
      }, correlationId)
    })
  }

  private contextRenderResult(
    content: string,
    missingVariables: readonly string[] = [],
  ): RenderResultState {
    const referencedVariables = new Set(
      [...templateVariablePaths(this.template.source)]
        .filter((name) => name.startsWith('builtin.prompts.') || name.startsWith('builtin.variables.'))
        .map((name) => name.split('.')[2])
        .filter((name): name is string => Boolean(name)),
    )
    const pendingReferences = [...referencedVariables]
    while (pendingReferences.length > 0) {
      const key = pendingReferences.pop() as string
      for (const dependency of this.systemPromptDependencies[key] ?? []) {
        if (referencedVariables.has(dependency)) continue
        referencedVariables.add(dependency)
        pendingReferences.push(dependency)
      }
    }
    const missingReferences = this.systemVariables.variables
      .filter((variable) => variable.required)
      .map((variable) => `builtin.variables.${variable.key}`)
      .filter((name) => !referencedVariables.has(name.split('.')[2] ?? '') && !referencedVariables.has(`builtin.prompts.${name.split('.')[2] ?? ''}`))
    const missingValues = [
      ...missingVariables,
      ...this.variables.value.builtin.missing_prompts.map(
        (name) => `builtin.variables.${name}`,
      ),
    ]
    return {
      messages: this.renderMessages(content),
      format: 'llm-messages',
      templateRevision: this.template.revision,
      variablesRevision: this.variables.revision,
      renderedAt: now(),
      diagnostics: [
        ...[...new Set(missingValues)].map((name) => ({
          severity: 'warning' as const,
          code: name.startsWith('builtin.prompts.') || name.startsWith('builtin.variables.')
            ? 'MISSING_SYSTEM_VARIABLE'
            : 'MISSING_VARIABLE',
          message: `Variable "${name}" is not set`,
        })),
        ...missingReferences.map((name) => ({
          severity: 'warning' as const,
          code: 'MISSING_SYSTEM_VARIABLE_REFERENCE',
          message: `Required system variable "${name}" is not referenced by the template`,
        })),
      ],
    }
  }

  private systemPromptState(resource: SystemVariablesResource) {
    const resolved = resolveSystemPromptVariables(resource.variables)
    this.systemPromptDependencies = resolved.dependencies
    return {
      prompts: resolved.prompts,
      variables: resolved.values,
      shared_prompts: resource.variables
        .filter((variable) => variable.key !== 'sys_message' && variable.scope === 'project')
        .map((variable) => variable.key),
      missing_prompts: resource.variables
        .filter((variable) => (
          variable.key !== 'sys_message' &&
          variable.required &&
          !(resolved.prompts[variable.key] ?? '').trim()
        ))
        .map((variable) => variable.key),
    }
  }

  private systemMessageValue(): JsonValue[] {
    return this.llmMessages.map((message) => toJsonValue(message))
  }

  private runtimeCacheValue(): RuntimeCache {
    const current = this.variables.value.builtin.cache ?? emptyRuntimeCache()
    const structured = current.version === 2 ? current : emptyRuntimeCache()
    const summaryMessage = this.llmMessages.find((message) => (
      message.role === 'assistant' && message.name === CACHE_SUMMARY_MESSAGE_NAME
    ))
    const summary = this.contextOrganization.enabled ? '' : current.summary || (
      summaryMessage?.content.startsWith(CACHE_SUMMARY_PREFIX)
        ? summaryMessage.content.slice(CACHE_SUMMARY_PREFIX.length)
        : summaryMessage?.content ?? ''
    )
    return {
      version: 2,
      summary,
      messages: (this.contextOrganization.enabled ? this.contextHistory.project() : this.llmMessages)
        .filter((message) => (
          message.role !== 'system' && message.name !== CACHE_SUMMARY_MESSAGE_NAME
        ))
        .map((message) => toJsonValue(message)),
      loop: {
        run_id: this.run.runId ?? '',
        iteration: this.loopIteration,
        tool_round: this.toolRound,
        continuation_round: this.continuationRound,
      },
      compression_count: current.compression_count,
      compressed_at: current.compressed_at,
      task_profile: clone(structured.task_profile ?? {}),
      plan: clone(structured.plan ?? []),
      claims: clone(structured.claims ?? []),
      evidence: clone(structured.evidence ?? []),
      hypotheses: clone(structured.hypotheses ?? []),
      contradictions: clone(structured.contradictions ?? []),
      reviews: clone(structured.reviews ?? []),
      candidate_answer: structured.candidate_answer ?? '',
      tool_history: clone(structured.tool_history ?? []),
      failure_history: clone(structured.failure_history ?? []),
      budget: clone(structured.budget ?? {}),
    }
  }

  private limitRuntimeMessages(messages: readonly LlmMessage[]): LlmMessage[] {
    if (this.contextOrganization.enabled) return discardOrphanToolMessages([...messages])
    const system = messages.find((message) => message.role === 'system')
    const summary = messages.find((message) => (
      message.role === 'assistant' && message.name === CACHE_SUMMARY_MESSAGE_NAME
    ))
    const conversation = messages.filter((message) => (
      message.role !== 'system' && message.name !== CACHE_SUMMARY_MESSAGE_NAME
    ))
    const conversationLimit = Math.max(
      this.maxMessages - (system ? 1 : 0),
      0,
    )
    return discardOrphanToolMessages([
      ...(system ? [system] : []),
      ...(summary ? [summary] : []),
      ...(conversationLimit > 0 ? conversation.slice(-conversationLimit) : []),
    ])
  }

  private applyRuntimeCache(cache: RuntimeCache): void {
    assertRuntimeCache(cache)
    if (this.contextOrganization.enabled) return
    const system = this.llmMessages.find((message) => message.role === 'system')
      ?? this.renderResult.messages.find((message) => message.role === 'system')
    this.llmMessages = discardOrphanToolMessages([
      ...(system ? [{ role: 'system' as const, content: system.content }] : []),
      ...(cache.summary ? [{
        role: 'assistant' as const,
        name: CACHE_SUMMARY_MESSAGE_NAME,
        content: `${CACHE_SUMMARY_PREFIX}${cache.summary}`,
      }] : []),
      ...runtimeCacheMessages(cache.messages),
    ])
  }

  private statusVariableTokens(): RuntimeStatusState['variableTokens'] {
    return this.systemVariables.variables
      .filter((variable) => variable.show_in_status)
      .map((variable) => ({
        key: variable.key,
        label: variable.label,
        tokens: estimateTokens(
          variable.key === 'sys_message'
            ? this.llmMessages
            : variable.key === 'cache'
              ? this.runtimeCacheValue()
              : this.variables.value.builtin.prompts[variable.key] ?? variable.value,
        ),
      }))
  }

  private runtimeStatusMetrics(): Pick<RuntimeStatusState, 'messageCount' | 'variableTokens'> {
    return {
      messageCount: this.llmMessages.length,
      variableTokens: this.statusVariableTokens(),
    }
  }

  private runtimeStatusContext(
    context: RuntimeStatusState['context'],
  ): RuntimeStatusState['context'] {
    const cacheTokens = estimateTokens(this.runtimeCacheValue())
    const contextWindowTokens = this.contextWindowTokens
    return {
      ...context,
      cacheTokens,
      contextWindowTokens,
      cacheUtilization: contextWindowTokens > 0 ? cacheTokens / contextWindowTokens : 0,
    }
  }

  private hookStatus(outcome: 'completed' | 'failed' | 'cancelled'): HookStatusSnapshot {
    const metrics = this.runtimeStatusMetrics()
    const researchEvents = readResearchLedgerEvents(this.projectDir)
    return {
      run: {
        status: outcome,
        ...(this.run.failure ? { failure: toJsonValue(this.run.failure) } : {}),
      },
      context: clone(this.runtimeStatus.context),
      queueDepth: this.runtimeStatus.queueDepth,
      messageCount: metrics.messageCount,
      variableTokens: Object.fromEntries(metrics.variableTokens.map((variable) => [
        variable.key === 'sys_message'
          ? 'builtin.sys_message'
          : variable.key === 'cache' ? 'builtin.cache' : `builtin.prompts.${variable.key}`,
        variable.tokens,
      ])),
      research: {
        ledgerHead: researchEvents.at(-1)?.event_hash ?? '0'.repeat(64),
        totalEvents: researchEvents.length,
        events: researchEvents.map((event) => ({
          event_id: event.event_id,
          event_type: event.event_type,
          event_hash: event.event_hash,
          payload: clone(event.payload),
          source: { hook_id: event.source.hook_id },
        })),
      },
    }
  }

  private async runAfterLoopHooks(
    outcome: 'completed' | 'failed' | 'cancelled',
    correlationId: string,
    generation: number,
    terminal = false,
    afterStepIndex?: number,
  ): Promise<void> {
    // Delegated read-only sessions have their own document organizer, but no
    // authority to run project Hooks that may install resources or persist assets.
    if (this.childAgentMode || this.closed || this.generation !== generation) return
    const runId = this.run.runId
    if (!runId) return
    this.loopIteration += 1
    this.syncSystemMessages(correlationId)
    const usedTokensBeforeHooks = this.estimatedModelInputTokens()
    const maxTokensBeforeHooks = this.runtimeStatus.context.maxTokens
    this.updateRuntimeStatus({
      context: {
        usedTokens: usedTokensBeforeHooks,
        maxTokens: maxTokensBeforeHooks,
        utilization: Math.min(usedTokensBeforeHooks / maxTokensBeforeHooks, 1),
      },
    }, correlationId)
    const changedVariables = [...changedVariablePaths(
      this.loopVariableBaseline,
      this.variables.value,
    )].sort()
    const fixture: HookFixture = {
      checkpoint: 'after_loop',
      runId,
      loopIteration: this.loopIteration,
      loopTerminal: terminal,
      status: this.hookStatus(outcome),
      changedVariables,
      variables: clone(this.variables.value),
      messages: clone(this.llmMessages),
      context: this.hookContextSnapshot(),
    }
    const hooks = this.hookRegistry.list()
      .filter((hook) => hook.loadable && hook.enabled && hook.checkpoint === 'after_loop')
      .filter((hook) => !this.contextOrganization.enabled || hook.ownerKind !== 'system' || !['context-compression', 'context-organization'].includes(hook.name))
      .sort((left, right) => right.schedule.priority - left.schedule.priority || left.name.localeCompare(right.name))
    const claimedPaths = new Set<string>()
    let continuationReason: string | undefined
    const controller = new AbortController()
    this.activeAbortController = controller
    try {
      for (const hook of hooks) {
        if (this.generation !== generation || controller.signal.aborted) return
        try {
          this.updateRuntimeStatus({
            activity: { phase: 'hook_running', label: hook.name, startedAt: now() },
          }, correlationId)
          const execution = await new HookRunner(this.meteredLlm('hook')).run(hook, fixture, controller.signal, {
            onLlmActivity: this.hookLlmObserver(hook.name, generation, correlationId),
          })
          this.addUsage(execution.usage)
          if (this.generation !== generation || controller.signal.aborted) return
          if (execution.matched && execution.result) {
            const requested = await this.applyHookResult(
              hook, execution.result, claimedPaths, correlationId,
            )
            continuationReason ??= requested
          }
          this.createArtifact(
            'hook-result',
            `Hook ${execution.matched ? 'result' : 'check'} · ${hook.name}`,
            {
              hookId: hook.id,
              hookRevision: hook.revision,
              checkpoint: 'after_loop',
              loopIteration: this.loopIteration,
              changedVariables,
              matched: execution.matched,
              attempts: execution.attempts,
              durationMs: execution.durationMs,
              usage: toJsonValue(execution.usage),
              result: toJsonValue(execution.result ?? {}),
            },
            correlationId,
          )
          if (execution.logs.length > 0) {
            this.createArtifact(
              'hook-log',
              `Hook log · ${hook.name}`,
              toJsonValue(execution.logs),
              correlationId,
            )
          }
        } catch (error) {
          this.createArtifact(
            'runtime-error',
            `Hook failed · ${hook.name}`,
            {
              hookId: hook.id,
              hookRevision: hook.revision,
              checkpoint: 'after_loop',
              message: error instanceof Error ? error.message : String(error),
            },
            correlationId,
          )
        }
      }
    } finally {
      if (this.activeAbortController === controller) this.activeAbortController = undefined
      if (this.generation === generation) {
        this.updateRuntimeStatus({
          activity: { phase: 'idle', startedAt: now() },
        }, correlationId)
      }
    }
    if (
      continuationReason
      && terminal
      && outcome === 'completed'
      && afterStepIndex !== undefined
    ) {
      if (this.maxToolRounds !== -1 && this.continuationRound >= this.maxToolRounds) {
        this.createArtifact('runtime-error', 'Hook continuation rejected', {
          code: 'HOOK_CONTINUATION_LIMIT',
          reason: continuationReason,
          maxToolRounds: this.maxToolRounds,
        }, correlationId)
      } else {
        this.continuationRound += 1
        this.insertContinuation(afterStepIndex, correlationId)
        this.createArtifact('hook-result', 'Hook requested another model Loop', {
          reason: continuationReason,
          continuationRound: this.continuationRound,
        }, correlationId)
      }
    }
    const usedTokens = this.estimatedModelInputTokens()
    const maxTokens = this.runtimeStatus.context.maxTokens
    this.updateRuntimeStatus({
      context: {
        usedTokens,
        maxTokens,
        utilization: Math.min(usedTokens / maxTokens, 1),
      },
    }, correlationId)
    this.loopVariableBaseline = clone(this.variables.value)
  }

  private async compressRuntimeCacheBeforeModel(
    correlationId: string,
    generation: number,
  ): Promise<void> {
    const maxTokens = this.runtimeStatus.context.maxTokens
    for (let pass = 0; pass < 3; pass += 1) {
      const before = this.legacyCacheInputTokens()
      if (before <= maxTokens * 0.8 || this.generation !== generation) return
      await this.compressRuntimeCachePass(correlationId, generation)
      if (this.generation !== generation) return
      const after = this.legacyCacheInputTokens()
      if (after <= maxTokens * 0.8) return
      if (after >= before) break
    }
    const usedTokens = this.legacyCacheInputTokens()
    if (usedTokens > maxTokens) {
      const fixedSystem = this.renderProjectPromptForSkills(this.modelSkillVariables([]))
      const base = [{ role: 'system' as const, content: fixedSystem }]
      const systemTokens = this.estimatedModelInputTokens(base, [])
      const toolTokens = Math.ceil(JSON.stringify(this.modelToolDefinitions()).length / 4)
      const fixedTokens = this.estimatedModelInputTokens(
        base,
        this.modelToolDefinitions(),
      )
      // Historical conversation is deterministically projected again before
      // each model request. Only fail here when the fixed system/tool envelope
      // itself cannot fit; an oversized history tail will be trimmed there.
      if (fixedTokens <= maxTokens) return
      this.createArtifact('runtime-error', 'Context budget exhausted after Cache compression', {
        usedTokens, maxTokens, systemTokens, toolTokens,
        cacheTokens: Math.max(0, usedTokens - systemTokens - toolTokens),
        estimator: 'serialized-json-characters-divided-by-four',
      }, correlationId)
      throw new RuntimeStageError('runtime', 'CACHE_COMPRESSION_INSUFFICIENT',
        `Cache compression could not fit ${usedTokens} estimated tokens into ${maxTokens}; fixed system=${systemTokens}, tools=${toolTokens}`)
    }
  }

  private legacyCacheInputTokens(): number {
    const tools = this.modelToolDefinitions()
    const system = this.renderProjectPromptForSkills(this.modelSkillVariables([]), tools)
    return this.estimatedModelInputTokens([{ role: 'system', content: system }, ...this.llmMessages.filter(message => message.role !== 'system')], tools)
  }

  private async compressRuntimeCachePass(
    correlationId: string,
    generation: number,
  ): Promise<void> {
    const maxTokens = this.runtimeStatus.context.maxTokens
    const usedTokens = this.legacyCacheInputTokens()
    this.updateRuntimeStatus({
      context: {
        usedTokens,
        maxTokens,
        utilization: Math.min(usedTokens / maxTokens, 1),
      },
    }, correlationId)
    if (usedTokens <= maxTokens * 0.8) return

    this.syncSystemMessages(correlationId)
    const tools = this.modelToolDefinitions()
    const fixedSystem = this.renderProjectPromptForSkills(this.modelSkillVariables([]), tools)
    const fixedTokens = this.estimatedModelInputTokens([{ role: 'system', content: fixedSystem }], tools)
    if (fixedTokens > maxTokens) {
      throw new RuntimeStageError('runtime', 'FIXED_CONTEXT_WINDOW_EXCEEDED',
        `Fixed system prompt and Tool schemas require ${fixedTokens} estimated tokens; input budget is ${maxTokens}`)
    }

    const hook = this.hookRegistry.list().find((candidate) => (
      candidate.ownerKind === 'system'
      && candidate.id === SYSTEM_CONTEXT_COMPRESSION_HOOK_ID
      && candidate.loadable
      && candidate.enabled
      && candidate.checkpoint === 'after_loop'
    ))
    if (!hook) return

    const changedVariables = ['builtin.cache']
    const fixture: HookFixture = {
      checkpoint: 'after_loop',
      runId: this.run.runId ?? '',
      loopIteration: this.loopIteration,
      loopTerminal: false,
      status: this.hookStatus('completed'),
      changedVariables,
      variables: clone(this.variables.value),
      messages: clone(this.llmMessages),
    }
    const controller = new AbortController()
    this.activeAbortController = controller
    try {
      this.updateRuntimeStatus({
        activity: { phase: 'hook_running', label: hook.name, startedAt: now() },
      }, correlationId)
      const execution = await new HookRunner(this.meteredLlm('hook')).run(hook, fixture, controller.signal, {
        onLlmActivity: this.hookLlmObserver(hook.name, this.generation, correlationId),
      })
      this.addUsage(execution.usage)
      if (this.generation !== generation || controller.signal.aborted) return
      if (execution.matched && execution.result) {
        await this.applyHookResult(hook, execution.result, new Set<string>(), correlationId)
      }
      this.createArtifact(
        'hook-result',
        `Hook ${execution.matched ? 'result' : 'check'} · ${hook.name}`,
        {
          hookId: hook.id,
          hookRevision: hook.revision,
          checkpoint: 'before_model_overflow',
          loopIteration: this.loopIteration,
          changedVariables,
          matched: execution.matched,
          attempts: execution.attempts,
          durationMs: execution.durationMs,
          beforeTokens: usedTokens,
          afterTokens: this.legacyCacheInputTokens(),
          fixedTokens,
          maxTokens,
          usage: toJsonValue(execution.usage),
          result: toJsonValue(execution.result ?? {}),
        },
        correlationId,
      )
    } catch (error) {
      this.createArtifact(
        'runtime-error',
        `Hook failed · ${hook.name}`,
        {
          hookId: hook.id,
          hookRevision: hook.revision,
          checkpoint: 'before_model_overflow',
          message: error instanceof Error ? error.message : String(error),
        },
        correlationId,
      )
    } finally {
      if (this.activeAbortController === controller) this.activeAbortController = undefined
    }

    const compressedTokens = this.estimatedModelInputTokens()
    this.updateRuntimeStatus({
      context: {
        usedTokens: compressedTokens,
        maxTokens,
        utilization: Math.min(compressedTokens / maxTokens, 1),
      },
    }, correlationId)
  }

  private isLoopStep(step: TimelineStep): boolean {
    return step.type === 'model' || step.type === 'tool' || step.type === 'workflow'
  }

  private endsLoopIteration(step: TimelineStep, next?: TimelineStep): boolean {
    if (step.type === 'model') {
      return step.detail?.loopStatus === 'running' || step.detail?.loopStatus === 'completed'
    }
    return (step.type === 'tool' || step.type === 'workflow') && next?.type === 'model'
  }

  private applyHookContextOrganize(
    hookId: string,
    observations: HookContextObservation[] = [],
    proposals: HookContextProposal[] = [],
    correlationId: string,
  ): void {
    if (this.childAgentMode && [...observations, ...proposals].some((item) => item.scope === 'project')) throw new Error('CHILD_AGENT_PROJECT_CONTEXT_READONLY')
    if (observations.length === 0 && proposals.length === 0) return
    const observed = new Map<string, { scope: RuntimeContextScopeKind; candidateId: string }>()
    const projectPreviousState = observations.some((item) => item.scope === 'project')
      || proposals.some((item) => item.scope === 'project')
      ? this.projectContextDocumentEngine.exportState()
      : undefined
    const projectPreviousRevision = projectPreviousState?.document.revision

    for (const observation of observations) {
      if (!observation || !observation.id.trim()) throw new Error(`Hook ${hookId} returned an observation without id`)
      if (observed.has(observation.id)) throw new Error(`Hook ${hookId} returned duplicate observation id: ${observation.id}`)
      if (observation.scope !== 'project' && observation.scope !== 'session') throw new Error(`Hook ${hookId} returned an invalid observation scope`)
      const engine = this.contextEngineForScope(observation.scope)
      const result = engine.observe({
        candidate: {
          source: observation.source,
          rawArtifactId: observation.rawArtifactId,
          normalizedContent: observation.normalizedContent,
          ...(observation.classification ? { classification: observation.classification } : {}),
        },
        ...(observation.evidence ? { evidence: observation.evidence } : {}),
      })
      const candidate = result.candidate
      observed.set(observation.id, { scope: observation.scope, candidateId: candidate.id })
      this.snapshotRevision += 1
      this.emit('runtime.context.v2.observed', {
        candidate: {
          id: candidate.id,
          actor: candidate.source.actor,
          sourceId: candidate.source.sourceId,
          capturedAt: candidate.source.capturedAt,
          ...(candidate.source.toolName ? { toolName: candidate.source.toolName } : {}),
          ...(candidate.source.runId ? { runId: candidate.source.runId } : {}),
          ...(candidate.source.stepId ? { stepId: candidate.source.stepId } : {}),
          rawArtifactId: candidate.rawArtifactId,
          status: candidate.status,
          evidenceRefs: candidate.evidenceRefs,
          proposedDiffIds: candidate.proposedDiffIds,
          createdAt: candidate.createdAt,
          ...(candidate.reviewedAt ? { reviewedAt: candidate.reviewedAt } : {}),
          ...(candidate.classification ? { classification: candidate.classification } : {}),
        },
        ...(result.evidence ? { evidence: result.evidence } : {}),
      }, correlationId)
    }

    if (projectPreviousState && projectPreviousRevision !== undefined) {
      try {
        this.persistProjectContext(projectPreviousRevision)
      } catch (error) {
        this.projectContextDocumentEngine = new ContextDocumentEngine(
          projectPreviousState.document,
          projectPreviousState.receipts,
          projectPreviousState.projections,
          projectPreviousState.reviewReceipts,
          projectPreviousState.evidenceReviewReceipts,
        )
        throw error
      }
    }

    const refreshedProjections = new Map<RuntimeContextScopeKind, ReturnType<ContextDocumentEngine['project']>>()
    const refreshProjection = (scope: RuntimeContextScopeKind) => {
      const existing = refreshedProjections.get(scope)
      if (existing) return existing
      const projection = this.contextEngineForScope(scope).project({
        id: scope === 'project' ? 'hook-project-context' : 'hook-session-context',
        includeStructure: true,
        maxCharacters: 12_000,
        includeTools: false,
        sectionOrder: scope === 'project'
          ? ['information', 'candidates', 'messages', 'system', 'tools']
          : ['system', 'messages', 'information', 'candidates', 'tools'],
      })
      refreshedProjections.set(scope, projection)
      return projection
    }

    for (const proposal of proposals) {
      if (!proposal || (proposal.scope !== 'project' && proposal.scope !== 'session')) {
        throw new Error(`Hook ${hookId} returned an invalid context proposal scope`)
      }
      this.projectContextStore.commits.assertPublishedProjection(this.sessionId!, proposal.scope, proposal, 'hook')
      if ((CONTEXT_TREE_OPERATIONS as readonly string[]).includes(proposal.operation)) {
        const binding = new Map(this.contextEngineForScope(proposal.scope).exportState().projections).get(proposal.projectionId)
        if (!binding || binding.documentRevision !== proposal.baseRevision || binding.contentHash !== proposal.projectionHash) throw new Error('PROJECTION_BINDING_CONFLICT')
        const error = contextTreeProposalError({ ...proposal, target: { nodeId: proposal.targetNodeId, entryId: proposal.targetEntryId, headingPath: proposal.headingPath },
          payload: { title: proposal.title, parentNodeId: proposal.parentNodeId, beforeNodeId: proposal.beforeNodeId, childIds: proposal.childIds, body: proposal.body, status: proposal.status } }, binding.treeNodes)
        if (error) throw new Error(error)
      }
      const source = proposal.sourceObservationId ? observed.get(proposal.sourceObservationId) : undefined
      if (proposal.sourceObservationId && !source) throw new Error(`Hook ${hookId} referenced an unknown observation: ${proposal.sourceObservationId}`)
      if (source && source.scope !== proposal.scope && !(source.scope === 'session' && proposal.scope === 'project')) {
        throw new Error(`Hook ${hookId} observation and proposal scopes differ`)
      }
      const candidateId = proposal.candidateId ?? source?.candidateId
      if (!candidateId) throw new Error(`Hook ${hookId} context proposals require candidateId or sourceObservationId`)
      if (source?.scope === 'session' && proposal.scope === 'project') this.promoteSessionCandidateToProject(candidateId)
      const projection = source ? refreshProjection(proposal.scope) : undefined
      const contextProposal: RuntimeContextDiffProposal = {
        ...(proposal.diffVersion !== undefined ? { diffVersion: proposal.diffVersion } : {}),
        ...(proposal.targetNodeHash ? { targetNodeHash: proposal.targetNodeHash } : {}),
        scope: proposal.scope,
        id: `hook-${hookId}-${proposal.idempotencyKey}`,
        documentId: projection?.id ? this.contextEngineForScope(proposal.scope).snapshot().id : proposal.documentId,
        baseRevision: projection?.documentRevision ?? proposal.baseRevision,
        projectionId: projection?.id ?? proposal.projectionId,
        projectionHash: projection?.contentHash ?? proposal.projectionHash,
        ...(proposal.targetEntryHash ? { targetEntryHash: proposal.targetEntryHash } : {}),
        target: {
          section: 'information',
          ...(proposal.targetEntryId ? { entryId: proposal.targetEntryId } : {}),
          ...(proposal.targetNodeId ? { nodeId: proposal.targetNodeId } : {}),
          ...(proposal.headingPath ? { headingPath: proposal.headingPath } : {}),
        },
        operation: proposal.operation,
        payload: {
          ...(proposal.title !== undefined ? { title: proposal.title } : {}),
          ...(proposal.parentNodeId !== undefined ? { parentNodeId: proposal.parentNodeId } : {}),
          ...(proposal.beforeNodeId !== undefined ? { beforeNodeId: proposal.beforeNodeId } : {}),
          ...(proposal.childIds !== undefined ? { childIds: proposal.childIds } : {}),
          ...(proposal.body !== undefined ? { body: proposal.body } : {}),
          ...(proposal.status ? { status: proposal.status } : {}),
          ...(proposal.evidenceRefs && proposal.evidenceRefs.length > 0 ? { evidenceRefs: proposal.evidenceRefs } : {}),
        },
        ...(proposal.classification ? { classification: proposal.classification } : {}),
        candidateId,
        actor: 'system',
        idempotencyKey: proposal.idempotencyKey,
        createdAt: new Date().toISOString(),
      }
      this.applyV2Proposal(contextProposal, correlationId, true)
    }
  }

  private async applyHookResult(
    hook: ReturnType<HookRegistry['list']>[number],
    result: HookResult,
    claimedPaths: Set<string>,
    correlationId: string,
  ): Promise<string | undefined> {
    let continuationReason: string | undefined
    if (result.loop !== undefined) {
      if (hook.permissions.loop !== 'continue') {
        throw new Error(`Hook ${hook.id} returned loop control without loop:continue permission`)
      }
      if (
        !result.loop
        || result.loop.action !== 'continue'
        || typeof result.loop.reason !== 'string'
        || !result.loop.reason.trim()
      ) {
        throw new Error(`Hook ${hook.id} returned invalid loop control`)
      }
      continuationReason = result.loop.reason.trim()
    }
    if (result.hookFiles !== undefined) {
      if (hook.permissions.hooks !== 'write') {
        throw new Error(`Hook ${hook.id} returned hookFiles without hooks:write permission`)
      }
      if (!Array.isArray(result.hookFiles) || result.hookFiles.length === 0) {
        throw new Error(`Hook ${hook.id} hookFiles must be a non-empty array`)
      }
      if (result.hookFiles.length > MAX_GENERATED_HOOK_FILES) {
        throw new Error(`Hook ${hook.id} returned more than ${MAX_GENERATED_HOOK_FILES} Hook files`)
      }
      let totalBytes = 0
      const candidates = result.hookFiles.map((candidate, index) => {
        if (!candidate || typeof candidate.name !== 'string' || typeof candidate.source !== 'string') {
          throw new Error(`Hook ${hook.id} returned an invalid Hook file at index ${index}`)
        }
        totalBytes += Buffer.byteLength(candidate.source)
        return { name: candidate.name, source: candidate.source }
      })
      if (totalBytes > MAX_GENERATED_HOOK_TOTAL_BYTES) {
        throw new Error(
          `Hook ${hook.id} generated Hook files exceed ${MAX_GENERATED_HOOK_TOTAL_BYTES} bytes`,
        )
      }
      const installed = await enqueueProjectWrite(this.projectDir, () => (
        this.hookRegistry.createMany(candidates)
      ))
      for (const generated of installed) {
        this.createArtifact(
          'hook-result',
          `Hook installed · ${generated.name}`,
          {
            name: generated.name,
            path: path.relative(this.projectDir, generated.entryFile).replaceAll('\\', '/'),
            revision: generated.revision,
          },
          correlationId,
        )
      }
    }

    const systemCacheCompression = hook.ownerKind === 'system'
      && hook.id === SYSTEM_CONTEXT_COMPRESSION_HOOK_ID
    if (systemCacheCompression && result.messages !== undefined) {
      throw new Error('System context compression may only modify builtin.cache')
    }
    if (systemCacheCompression && result.patches?.some((operation) => (
      operation.path !== '/builtin/cache' && !operation.path.startsWith('/builtin/cache/')
    ))) {
      throw new Error('System context compression may only patch builtin.cache')
    }

    if (result.messages !== undefined) {
      if (hook.permissions.messages !== 'replace') {
        throw new Error(`Hook ${hook.id} returned messages without messages:replace permission`)
      }
      if (!Array.isArray(result.messages) || result.messages[0]?.role !== 'system') {
        throw new Error(`Hook ${hook.id} messages must retain a leading system message`)
      }
      for (const [index, message] of result.messages.entries()) {
        if (!message || !['system', 'user', 'assistant', 'tool'].includes(message.role) || typeof message.content !== 'string') {
          throw new Error(`Hook ${hook.id} returned an invalid message at index ${index}`)
        }
      }
      this.llmMessages = discardOrphanToolMessages(clone(result.messages))
    }

    if (hook.ownerKind !== 'system' && (result.contextObservations !== undefined || result.contextProposals !== undefined)) {
      throw new Error(`Hook ${hook.id} returned context organization data without system ownership`)
    }
    if (result.contextObservations !== undefined || result.contextProposals !== undefined) {
      if (result.contextObservations !== undefined && !Array.isArray(result.contextObservations)) {
        throw new Error(`Hook ${hook.id} contextObservations must be an array`)
      }
      if (result.contextProposals !== undefined && !Array.isArray(result.contextProposals)) {
        throw new Error(`Hook ${hook.id} contextProposals must be an array`)
      }
      this.applyHookContextOrganize(
        hook.id,
        result.contextObservations ?? [],
        result.contextProposals ?? [],
        correlationId,
      )
    }

    let hookPatches = result.patches === undefined ? undefined : [...result.patches]
    if (result.researchEvents !== undefined) {
      if (hook.permissions.research !== 'append') {
        throw new Error(`Hook ${hook.id} returned researchEvents without research:append permission`)
      }
      if (result.patches !== undefined) {
        if (hook.permissions.variables !== 'patch') {
          throw new Error(`Hook ${hook.id} returned patches without variables:patch permission`)
        }
        if (!Array.isArray(result.patches)) throw new Error(`Hook ${hook.id} patches must be an array`)
        this.assertRuntimeVariables(applyPatch(this.variables.value, result.patches))
      }
      const ledger = await appendResearchEvents(this.projectDir, result.researchEvents, {
        hookId: hook.id,
        runId: this.run.runId ?? '',
        loopIteration: this.loopIteration,
      })
      const patchedVariables = applyPatch(this.variables.value, hookPatches ?? [])
      const cursor = patchedVariables.builtin.variables?.research_cursor
      if (isObject(cursor) && typeof cursor.ledger_head === 'string') {
        const cursorPath = '/builtin/variables/research_cursor'
        hookPatches = [
          ...(hookPatches ?? []).filter((operation) => operation.path !== cursorPath),
          { op: 'replace', path: cursorPath, value: { ...cursor, ledger_head: ledger.head } },
        ]
      }
      this.createArtifact(
        'hook-result',
        'Research ledger append',
        {
          hookId: hook.id,
          path: ledger.path,
          head: ledger.head,
          appendedEventIds: ledger.appended.map((event) => event.event_id),
          duplicateEventIds: ledger.duplicates.map((event) => event.event_id),
          totalEvents: ledger.totalEvents,
        },
        correlationId,
      )
    }

    if (hookPatches !== undefined) {
      if (hook.permissions.variables !== 'patch') {
        const onlyLedgerHead = result.patches === undefined
          && hookPatches.length === 1
          && hookPatches[0]?.path === '/builtin/variables/research_cursor'
        if (!onlyLedgerHead) throw new Error(`Hook ${hook.id} returned patches without variables:patch permission`)
      }
      if (!Array.isArray(hookPatches)) throw new Error(`Hook ${hook.id} patches must be an array`)
      const conflict = hookPatches.find((operation) => claimedPaths.has(operation.path))
      if (conflict) throw new Error(`Hook patch conflict at ${conflict.path}`)
      const candidate = applyPatch(this.variables.value, hookPatches)
      this.assertRuntimeVariables(candidate)
      const cacheChanged = hookPatches.some((operation) => (
        operation.path === '/builtin/cache' || operation.path.startsWith('/builtin/cache/')
      ))
      if (cacheChanged && result.messages !== undefined) {
        throw new Error(`Hook ${hook.id} cannot replace messages and builtin.cache together`)
      }
      if (cacheChanged && systemCacheCompression) {
        this.createArtifact('hook-result', 'Cache before compression', {
          hookId: hook.id, cache: clone(this.variables.value.builtin.cache),
        }, correlationId)
      }
      if (cacheChanged) this.applyRuntimeCache(candidate.builtin.cache)
      hookPatches.forEach((operation) => claimedPaths.add(operation.path))
      this.updateVariables(hookPatches, 'hook', correlationId)
    } else if (result.messages !== undefined) {
      this.publishRenderedMessages(correlationId)
    }

    if (result.artifacts !== undefined) {
      if (hook.permissions.artifacts !== 'write') {
        throw new Error(`Hook ${hook.id} returned artifacts without artifacts:write permission`)
      }
      if (!Array.isArray(result.artifacts)) throw new Error(`Hook ${hook.id} artifacts must be an array`)
      for (const artifact of result.artifacts) {
        if (!artifact || typeof artifact.title !== 'string') {
          throw new Error(`Hook ${hook.id} returned an invalid artifact`)
        }
        this.createArtifact('hook-result', artifact.title, toJsonValue(artifact.value), correlationId)
      }
    }
    return continuationReason
  }

  private syncSystemMessages(correlationId?: string): void {
    const sysMessage = this.systemMessageValue()
    const cache = this.runtimeCacheValue()
    const patch: JsonPatchOperation[] = []
    if (JSON.stringify(sysMessage) !== JSON.stringify(this.variables.value.builtin.sys_message)) {
      patch.push({ op: 'add', path: '/builtin/sys_message', value: sysMessage })
    }
    if (JSON.stringify(cache) !== JSON.stringify(this.variables.value.builtin.cache)) {
      patch.push({ op: 'add', path: '/builtin/cache', value: cache })
    }
    if (patch.length === 0) return
    const baseRevision = this.variables.revision
    this.variables = {
      revision: baseRevision + 1,
      value: {
        ...this.variables.value,
        builtin: {
          ...this.variables.value.builtin,
          sys_message: sysMessage,
          cache,
        },
      },
    }
    this.snapshotRevision += 1
    this.emit('variables.updated', {
      baseRevision,
      revision: this.variables.revision,
      patch,
      source: 'runtime',
    }, correlationId)
  }

  private internalResourceTools(): LlmToolDefinition[] {
    const prompts = this.variables.value.builtin.prompts
    const currentChildren = [...this.childRecords.values()].filter(record => record.parentRunId === this.run.runId && record.parentTaskId === this.taskControl.taskId)
    const unconsumed = currentChildren.filter(record => !record.consumption || record.consumption.decision === 'needs_more_evidence')
    const active = new Set(runtimeExecutionState(this.taskControl).activeTaskIds)
    return INTERNAL_RESOURCE_TOOLS.filter((tool) => (
      (!PARENT_CHILD_LIFECYCLE_TOOLS.has(tool.name) || (tool.name === 'get_child_task' ? currentChildren.length > 0
        : tool.name === 'cancel_child_task' ? currentChildren.some(record => !terminalChild(record.status))
        : tool.name === 'respond_child_task' ? currentChildren.some(record => record.status === 'waiting' && record.inputRequestId)
        : tool.name === 'take_over_child_task' ? this.taskControl.childAssignments?.some(item => item.state === 'retryable' && active.has(item.planTaskId))
        : tool.name === 'read_child_result' ? unconsumed.some(record => terminalChild(record.status))
        : unconsumed.some(record => terminalChild(record.status) && (record.readCount ?? 0) > 0))) &&
      (tool.name !== 'read_wait_signal' || this.waits.subscriptions.some(wait => wait.matchedSignalIds.length > 0)) &&
      (tool.name !== 'resume_mcp_input' || this.mcpInputViews().some(input => input.status === 'answered' && !input.operationId)) &&
      (tool.name !== 'resume_mcp_write_input' || this.mcpInputViews().some(input => input.status === 'answered' && !!input.operationId)) &&
      (tool.name !== 'verify_mcp_side_effect' || this.mcp.snapshot().pendingOperations?.some(operation => operation.verificationCapabilityId)
        || (this.workflows.items.some(plan => ['failed', 'suspended'].includes(plan.status) && plan.recovery && plan.runId === this.run.runId)
          && this.verifiedMcpOperations().some(operation => this.workflowNeedsMcpOutput(operation)))) &&
      (tool.name !== 'resume_workflow' || this.workflows.items.some(plan => plan.status === 'running' && this.pendingWorkflowCalls.get(plan.id)?.name === 'resume_workflow')
        || this.workflows.items.some(plan => ['failed', 'suspended'].includes(plan.status) && plan.recovery && plan.runId === this.run.runId
          && (this.workflowFormCompletion(plan) || (plan.recovery.operationId && this.verifiedMcpOperations().some(operation => operation.source.operationId === plan.recovery!.operationId))))) &&
      (tool.name !== 'submit_branch_evidence' || this.taskControl.branchBlocks?.some(block =>
        block.evidenceRequest?.sourceKinds.some(kind => ['tool', 'memory', 'child-agent'].includes(kind)))) &&
      (tool.name !== 'delegate_task' ? (!this.childReadOnly || CHILD_READABLE_RESOURCE_TOOLS.has(tool.name)) : this.childAgentEnabled && !this.childAgentMode) &&
      (tool.name !== 'manage_application' || this.applicationHost !== undefined) &&
      (tool.name !== 'browser_action' || this.browserHost !== undefined)
    )).map(({
      descriptionVariable,
      defaultDescription,
      sideEffects: _sideEffects,
      replay: _replay,
      permissions: _permissions,
      ...tool
    }) => ({
      ...tool,
      description: prompts[descriptionVariable] || defaultDescription || tool.name,
    }))
  }

  private refreshSystemVariablesResource(
    resource: SystemVariablesResource,
    correlationId: string,
    revision = new PluginRegistry(this.projectDir, this.systemDir).effectiveSystemVariablesState().revision,
  ): void {
    this.systemVariables = resource
    const state = this.systemPromptState(resource)
    const candidates: JsonPatchOperation[] = [
      { op: 'replace', path: '/builtin/system_variables_revision', value: revision },
      { op: 'replace', path: '/builtin/prompts', value: state.prompts },
      { op: 'replace', path: '/builtin/variables', value: state.variables },
      { op: 'replace', path: '/builtin/shared_prompts', value: state.shared_prompts },
      { op: 'replace', path: '/builtin/missing_prompts', value: state.missing_prompts },
    ]
    const patch = candidates.filter((operation) => {
      if (!('value' in operation)) return false
      const key = operation.path.split('/').at(-1) as keyof RuntimeVariables['builtin']
      return JSON.stringify(this.variables.value.builtin[key]) !== JSON.stringify(operation.value)
    })
    if (patch.length > 0) this.updateVariables(patch, 'runtime', correlationId)
    this.updateRuntimeStatus({}, correlationId)
  }

  private handleProjectResourceChange(change: ProjectResourceChange): void {
    try {
      if (change !== 'system-variables') {
        const settings = this.projectResources.readSettings()
        this.maxMessages = settings.max_messages
        this.maxToolRounds = this.childExecution ? Math.min(settings.max_tool_rounds === -1 ? Infinity : settings.max_tool_rounds, this.childExecution.maxToolRounds) : settings.max_tool_rounds
        if (change === 'settings') {
          this.contextWindowTokens = settings.context.context_window_tokens
          this.maxInputTokens = settings.context.max_input_tokens
          this.reservedOutputTokens = settings.context.reserved_output_tokens
          this.modelBudgetLimits = this.resolveModelBudgetLimits(settings.context)
          const availableTokens = this.availableInputTokens()
          const usedTokens = this.estimatedModelInputTokens()
          this.updateRuntimeStatus({
            context: {
              usedTokens,
              maxTokens: availableTokens,
              utilization: Math.min(usedTokens / availableTokens, 1),
            },
          }, `resource:${change}`)
        }
        if (change === 'settings') this.refreshProjectLlm(settings)
        if (change === 'settings') {
          this.skillScriptRunner.abort()
          this.skillScriptRunner = new SkillScriptRunner(this.workspaceDir, settings.tool_timeout_ms)
        }
        if (change === 'settings' || change === 'tools') {
          this.reloadProjectTools(settings, `resource:${change}`)
        }
        if (change === 'settings' || change === 'skills') {
          this.reloadProjectSkills(settings, `resource:${change}`)
        }
        if (change === 'settings' || change === 'harnesses' || change === 'plugins') {
          this.reloadProjectHarnesses(settings, `resource:${change}`)
        }
        if (change === 'settings' || change === 'hooks' || change === 'plugins') {
          this.hookRegistry.reload()
          this.updateRuntimeStatus({}, `resource:${change}`)
        }
        if (change === 'settings' || change === 'plugins') {
          const state = new PluginRegistry(this.projectDir, this.systemDir).effectiveSystemVariablesState()
          this.refreshSystemVariablesResource(state.resource, `resource:${change}`, state.revision)
        }
        if (change !== 'skills') this.refreshRuntimePlugins(`resource:${change}`)
        if (change === 'settings') this.renderAndPublish(`resource:${change}`)
        return
      }
      const state = new PluginRegistry(this.projectDir, this.systemDir).effectiveSystemVariablesState()
      this.refreshSystemVariablesResource(state.resource, 'resource:system-variables', state.revision)
      this.refreshRuntimePlugins('resource:system-variables')
    } catch (error) {
      this.emit('render.result.failed', {
        templateRevision: this.template.revision,
        variablesRevision: this.variables.revision,
        diagnostics: [{
          severity: 'error',
          code: 'PROJECT_RESOURCE_INVALID',
          message: error instanceof Error ? error.message : String(error),
        }],
      }, `resource:${change}`)
    }
  }

  private availableInputTokens(): number {
    return Math.min(
      this.maxInputTokens,
      this.contextWindowTokens - this.reservedOutputTokens,
    )
  }

  private assertInternalCapabilityAuthority(name: string): void {
    if (this.closed) throw new CommandError('INVALID_STATE', 'runtime is closed')
    const meta = INTERNAL_RESOURCE_TOOLS.find(tool => tool.name === name)
    if (!meta) throw new CommandError('NOT_FOUND', `unknown internal capability: ${name}`)
    const denial = capabilityAccessDenial({ permissions: meta.permissions ?? [], sideEffects: meta.sideEffects },
      new Set(this.projectResources.readSettings().tool_permissions), this.childReadOnly)
    if (denial || (this.childAgentMode && !this.internalResourceTools().some(tool => tool.name === name))) {
      throw new CommandError('FORBIDDEN', `${name}: ${denial ?? 'child_capability_unavailable'}`)
    }
    // Arbitrary Node scripts have process authority; they are not a filesystem sandbox.
    if (name === 'run_skill_script') assertAssetWriteAllowed(this.projectDir, 'skill.script.run')
  }

  private phaseSkills(execution = runtimeExecutionState(this.taskControl)): SkillDefinition[] {
    return selectRuntimeSkills(this.skills.items, this.taskControl, execution, this.toolCatalog)
  }

  private skillScriptSources(skills: readonly SkillDefinition[]): Array<{ skillId: string; path: string; file: string; hash: string; entryHash: string }> {
    return skills.flatMap(active => {
      const skill = this.skillRegistry.get(active.id)
      if (!skill) throw new Error('active Skill source is unavailable')
      const entryHash = this.currentSkillEntryHash(skill)
      if (active.sourceVersion !== skill.sourceVersion || entryHash !== skill.entryHash) throw new Error('active Skill entry changed')
      return active.resources.filter(resource => resource.kind === 'script').map(resource => {
        const file = this.registeredSkillResource(skill, resource.path, 'script')
        return { skillId: skill.id, path: resource.path, file,
          hash: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), entryHash }
      })
    })
  }

  private availableToolCapabilities(): RuntimeCapability[] {
    const settings = this.projectResources.readSettings()
    const granted = new Set(settings.tool_permissions)
    const enabledInternal = new Set(this.internalResourceTools().map(tool => tool.name))
    const phaseSkills = this.phaseSkills()
    const prompts = this.variables.value.builtin.prompts
    const internal: RuntimeCapability[] = INTERNAL_RESOURCE_TOOLS.map(meta => {
      const definition = { name: meta.name, description: prompts[meta.descriptionVariable] || meta.defaultDescription || meta.name, parameters: meta.parameters }
      const permissions = [...meta.permissions ?? []]
      let unavailableReason = !enabledInternal.has(definition.name) ? this.childAgentMode ? 'child_readonly'
        : this.childAgentEnabled && PARENT_CHILD_LIFECYCLE_TOOLS.has(definition.name) ? 'child_state_required' : 'not_configured'
        : capabilityAccessDenial({ permissions, sideEffects: meta.sideEffects }, granted, this.childReadOnly)
      let implementation: unknown
      if (meta.name === 'run_skill_script' && !unavailableReason) {
        try { implementation = this.skillScriptSources(phaseSkills); if (!(implementation as unknown[]).length) unavailableReason = 'not_loaded' }
        catch { unavailableReason = 'source_unavailable' }
      }
      if (meta.name === 'read_skill_resource' && !unavailableReason) {
        implementation = phaseSkills.map(skill => ({ id: skill.id, version: skill.sourceVersion }))
        if (!(implementation as unknown[]).length) unavailableReason = 'not_loaded'
      }
      return { capabilityId: `runtime:${definition.name}`, name: definition.name, source: 'system', sourceVersion: capabilityHash({ definition, permissions, sideEffects: meta.sideEffects, replay: meta.replay, implementation }),
        schemaHash: capabilityHash(definition.parameters), permissions, sideEffects: meta.sideEffects ?? 'none', replay: meta.replay ?? 'safe', definition, available: !unavailableReason,
        ...(unavailableReason ? { unavailableReason } : {}) }
    })
    const phaseRequired = new Set(phaseSkills.flatMap(skill => skill.requiredTools))
    const loaded = new Set(this.tools.items.filter(tool => !tool.attachedBySkill || phaseRequired.has(tool.id) || phaseRequired.has(tool.name)).map(tool => tool.name))
    const catalog = [...new Map([...this.toolCatalog, ...this.tools.items].filter(tool => tool.origin?.type !== 'mcp').map(tool => [tool.name, tool])).values()]
    const capabilities = [...internal, ...catalog.map((tool): RuntimeCapability => {
      const definition = { name: tool.name, description: tool.description, parameters: tool.inputSchema }
      const registered = this.toolRegistry.get(tool.name)
      const permissions = [...tool.permissions ?? []]
      let unavailableReason = capabilityAccessDenial({ permissions, sideEffects: tool.sideEffects }, granted, this.childReadOnly)
        ?? (!loaded.has(tool.name) ? 'not_loaded' : undefined)
      let implementation: unknown
      try {
        if (!registered) throw new Error('unregistered tool')
        implementation = { package: registered.packageName, version: registered.packageVersion,
          manifestPath: fs.realpathSync(registered.manifestFile), runnerPath: fs.realpathSync(registered.runnerEntry),
          manifest: createHash('sha256').update(fs.readFileSync(registered.manifestFile)).digest('hex'),
          runner: createHash('sha256').update(fs.readFileSync(registered.runnerEntry)).digest('hex') }
      } catch { unavailableReason = 'source_unavailable' }
      return { capabilityId: tool.id, name: tool.name, source: 'project', sourceVersion: capabilityHash({ implementation, definition, permissions, sideEffects: tool.sideEffects, replay: tool.replay }),
        schemaHash: capabilityHash(definition.parameters), permissions, sideEffects: tool.sideEffects ?? 'none', replay: tool.replay ?? 'safe', definition,
        available: unavailableReason === undefined, ...(unavailableReason ? { unavailableReason } : {}) }
    }), ...this.mcp.capabilities(settings.mcp_servers, granted, loaded, this.childAgentMode)]
    if (!this.childExecution) return capabilities
    const allowed = new Set(this.childExecution.capabilityIds)
    const assignment = this.childExecution.assignment
    return capabilities.map(capability => {
      if (!allowed.has(capability.capabilityId) && !allowed.has(capability.name)) return { ...capability, available: false, unavailableReason: 'outside_child_grant' }
      if (!assignment) return capability
      const grant = assignment.capabilities.find(item => item.capabilityId === capability.capabilityId)
      const current = runtimeCapabilityBinding(capability)
      // MCP connections are independently negotiated. The underlying grant still binds the same tool contract.
      if (grant && (grant.source === 'mcp' && grant.delegationVersion
        ? capabilityHash({ ...current, sourceVersion: current.delegationVersion }) === capabilityHash({ ...grant, sourceVersion: grant.delegationVersion })
        : capabilityHash(current) === capabilityHash(grant))) return capability
      return { ...capability, available: false, unavailableReason: 'child_grant_version_changed' }
    })
  }

  private modelToolDefinitions(): LlmToolDefinition[] {
    return selectRuntimeCapabilities(this.taskControl, this.availableToolCapabilities()).map(capability => capability.definition)
  }

  private capabilityStageError(error: unknown, projection?: RuntimeCapabilityProjection): RuntimeStageError {
    if (projection && error instanceof RuntimeCapabilityError && ['RUNTIME_CAPABILITY_STATE_STALE', 'RUNTIME_CAPABILITY_REVOKED', 'RUNTIME_CAPABILITY_VERSION_STALE'].includes(error.code)) {
      return new RuntimeCapabilityDriftError(error.code, error.message, projection)
    }
    return new RuntimeStageError('model_protocol', error instanceof RuntimeCapabilityError ? error.code : 'RUNTIME_CAPABILITY_PROJECTION_INVALID', error instanceof Error ? error.message : String(error), true)
  }

  /** Re-decide from fresh authority; never rebind or replay an old action. */
  private recoverCapabilityDrift(error: RuntimeCapabilityDriftError, step: TimelineStep, correlationId: string, generation: number): boolean | undefined {
    const stopped = () => this.closed || this.generation !== generation || ['cancelled', 'interrupted'].includes(this.run.status)
    if (stopped()) return true
    const { projection } = error
    if (projection.request.taskId !== this.taskControl.taskId || projection.request.runId !== this.run.runId
      || projection.request.sessionId !== (this.sessionId ?? '')) return undefined
    const unknownSteps = this.timeline.filter(hasUnknownToolOutcome)
    if (unknownSteps.length) {
      const verified = this.verifiedMcpOperations()
      if (unknownSteps.some(step => !this.isMcpStepSettled(step, verified))) return undefined
    }
    const { id, ...body } = projection
    if (id !== capabilityHash(body)) return undefined
    const pending = [...this.pendingToolCalls, ...this.pendingWorkflowCalls]
    if (pending.some(([, request]) => !request.authorization || request.authorization.projection.id !== id
      || capabilityHash(request.authorization.projection) !== capabilityHash(projection))) return undefined
    const attempts = this.taskControl.capabilityRecovery?.attempts ?? 0
    const exhausted = attempts >= MAX_CAPABILITY_RECOVERIES
      || (this.maxToolRounds !== -1 && this.continuationRound >= this.maxToolRounds)
    const rejectedAt = now()
    const rejection = this.createArtifact('runtime-error', `Capability dispatch rejected · ${error.code}`, {
      code: error.code, message: error.message, requestBinding: projection.request, projectionId: id,
      rejectedStepId: step.id, dispatched: false, attempts, exhausted,
      queuedCallIds: pending.map(([, request]) => request.id),
      recovery: exhausted ? 'budget_exhausted' : 'fresh_model_projection',
    }, correlationId)
    if (stopped()) return true
    const activePlans = pending.filter(([key]) => this.workflows.items.some(plan => plan.id === key)).map(([key]) => key)
    const rootCalls = new Set(activePlans.map(key => this.pendingWorkflowCalls.get(key)!.id))
    let callGroupStart = this.llmMessages.length - 1
    while (callGroupStart >= 0 && !(this.llmMessages[callGroupStart]!.role === 'assistant' && this.llmMessages[callGroupStart]!.toolCalls?.length)) callGroupStart--
    const settledCalls = new Set(this.llmMessages.slice(callGroupStart + 1).filter(message => message.role === 'tool').map(message => message.toolCallId))
    const failCall = (key: string, request: ToolCallRequest, workflowInner: boolean): void => {
      const target = this.timeline.find(item => item.id === key)
      const failure = { code: error.code, message: error.message, dispatched: false, projectionId: id, errorArtifactId: rejection.id }
      const artifact = this.createArtifact('tool-result', `Tool not dispatched · ${request.name}`, { ok: false, error: failure }, correlationId)
      if (stopped()) return
      if (target) this.updateTimeline({ ...target, status: target.id === step.id ? 'error' : 'skipped', completedAt: rejectedAt,
        detail: { ...target.detail, ok: false, dispatchRejected: true, resultArtifactId: artifact.id, resultPreview: artifact.preview, error: toJsonValue(failure) } }, correlationId)
      if (stopped()) return
      const process = this.runtimeActivityState.snapshot().processes.items.find(item => item.id === `process:${request.id}` && item.status === 'running')
      if (process) {
        this.runtimeActivityState.updateProcess(process.id, 'failed', { stoppedAt: rejectedAt, error: toJsonValue(failure) })
        this.emit('runtime.processes.updated', this.runtimeActivityState.snapshot().processes, correlationId)
        if (stopped()) return
      }
      this.upsertObservation({ id: `observation-${this.run.runId}-${request.id}`, runId: this.run.runId as string,
        stepId: key, callId: request.id, toolName: request.name, status: 'failed', arguments: toJsonValue(request.arguments),
        resultArtifactId: artifact.id, resultPreview: artifact.preview, error: toJsonValue(failure), startedAt: rejectedAt, completedAt: rejectedAt, durationMs: 0 }, correlationId)
      if (stopped()) return
      this.emit('tool.call.failed', { callId: request.id, toolName: request.name, code: error.code, message: error.message,
        details: toJsonValue(failure), startedAt: rejectedAt, completedAt: rejectedAt, durationMs: 0 }, correlationId)
      if (stopped()) return
      if (!workflowInner && !settledCalls.has(request.id)) {
        this.appendRuntimeMessage({ role: 'tool', name: request.name, toolCallId: request.id,
          content: this.boundedToolContent(artifact.id, { ok: false, error: failure }) }, 'runtime', artifact.id)
        settledCalls.add(request.id)
      }
    }
    for (const [key, request] of pending) {
      if (rootCalls.has(request.id)) continue // Active Workflow returns one real partial result below.
      const workflowInner = typeof this.timeline.find(item => item.id === key)?.detail?.workflowPlanId === 'string'
      failCall(key, request, workflowInner)
      if (stopped()) return true
      this.pendingToolCalls.delete(key)
      this.pendingWorkflowCalls.delete(key)
    }
    for (const planId of activePlans) {
      const data = this.workflowData.get(planId)
      if (!data) throw new Error('workflow recovery data is missing')
      for (const [sourceId, state] of Object.entries(data.steps)) if (state.status === 'pending' || state.status === 'running') {
        state.status = sourceId === step.detail?.workflowSourceStepId ? 'failed' : 'skipped'
      }
      this.failGeneratedWorkflow(planId, String(step.detail?.workflowNodeId ?? ''), error.message, correlationId)
      if (stopped()) return true
      for (const target of this.timeline.filter(item => item.detail?.workflowPlanId === planId && item.index >= step.index)) {
        if (target.detail?.workflowNodeType === 'finalize') {
          this.finalizeGeneratedWorkflow(target, correlationId)
          if (stopped()) return true
        }
        this.updateTimeline({ ...target, status: target.id === step.id ? 'error' : 'skipped', completedAt: rejectedAt,
          detail: { ...target.detail, dispatchRejected: true, recoveryArtifactId: rejection.id } }, correlationId)
        if (stopped()) return true
      }
    }
    // Admission can fail between appending the native assistant call and queueing
    // it. Complete that transport group with refusals, never fabricated execution.
    if (step.type === 'model') {
      const last = this.llmMessages.at(-1)
      if (last?.role === 'assistant') for (const call of last.toolCalls ?? []) {
        if (!settledCalls.has(call.id)) failCall(step.id, { ...call }, false)
        if (stopped()) return true
      }
    }
    this.taskControl.capabilityRecovery = { attempts: exhausted ? attempts : attempts + 1, errorArtifactId: rejection.id, rejectedStepId: step.id }
    this.taskControl.stateRevision += 1
    this.updateTimeline({ ...step, status: 'error', completedAt: rejectedAt,
      detail: { ...this.timeline.find(item => item.id === step.id)?.detail, dispatchRejected: true,
        recoveryArtifactId: rejection.id, capabilityRecovery: exhausted ? 'exhausted' : 'scheduled', error: { code: error.code, message: error.message } } }, correlationId)
    if (stopped()) return true
    this.appendRuntimeMessage({ role: 'user', content: JSON.stringify({ runtimeNotice: 'capability_projection_changed', code: error.code,
      artifactId: rejection.id, rejectedProjectionId: id, exhausted,
      instruction: 'Reassess from the new runtime state and projected tools. Rejected calls were not dispatched. Preserve completed results and obligations; do not replay completed actions or unknown side effects. Use only the new request binding; ask for necessary input when blocked.' }) }, 'runtime', rejection.id)
    this.publishRenderedMessages(correlationId)
    if (stopped()) return true
    this.updateRuntimeStatus({ model: 'ready', queueDepth: this.pendingToolCalls.size, activity: { phase: 'model_preparing', startedAt: rejectedAt } }, correlationId)
    if (exhausted) return false
    // Refresh definitions, validators, runner and permissions together. A malformed
    // registry fails closed; an old schema is never relabelled as the new version.
    this.reloadProjectTools(this.projectResources.readSettings(), correlationId)
    if (stopped()) return true
    this.continuationRound += 1
    let next = this.timeline.find(item => item.index > step.index && item.type === 'model' && item.status === 'pending')
    if (!next) {
      this.insertContinuation(step.index, correlationId)
      next = this.timeline[step.index + 1]!
    }
    if (stopped()) return true
    this.run = this.withRun({ currentStep: next.index, currentStepId: step.id, status: this.run.status === 'pause_requested' ? 'paused' : this.run.status, failure: undefined })
    this.pushCheckpoint(next.index, step.id, correlationId)
    this.emitRun(correlationId)
    return true
  }

  private validateCapabilityCalls(calls: readonly { name: string; arguments?: unknown }[], projection: RuntimeCapabilityProjection): void {
    if (calls.some(call => call.name === 'request_planning') && calls.length !== 1) throw new RuntimeStageError('model_protocol', 'RUNTIME_PLANNING_CALL_MUST_BE_EXCLUSIVE', 'request_planning must be the only action in a response', true)
    if (calls.some(call => call.name === 'resume_mcp_write_input') && calls.length !== 1) {
      throw new RuntimeStageError('model_protocol', 'MCP_FORM_WRITE_MUST_BE_EXCLUSIVE', 'resume_mcp_write_input must be the only action in a response', true)
    }
    if (this.workflowRequiresAppworldBatch(projection) && calls.some(call => call.name === 'appworld_execute')) {
      throw new RuntimeStageError('model_protocol', 'APPWORLD_WORKFLOW_REQUIRED',
        'Two incomplete appworld_execute results are already available. Call execute_workflow first and place the predictable appworld_execute chain in workflow steps.', true)
    }
    if (calls.some(call => call.name === 'delegate_task') && calls.some(call => call.name !== 'delegate_task')) {
      throw new RuntimeStageError('model_protocol', 'CHILD_PLAN_DELEGATION_MUST_BE_EXCLUSIVE', 'delegation calls may be batched together, but cannot be mixed with business or control actions', true)
    }
    const delegated = calls.filter(call => call.name === 'delegate_task')
    if (delegated.length > 1) this.validateDelegateBatch(delegated, projection)
    if (calls.length > 1 && calls.some(call => call.name === 'take_over_child_task')) {
      throw new RuntimeStageError('model_protocol', 'CHILD_TAKEOVER_MUST_BE_EXCLUSIVE', 'takeover changes task ownership and must be called alone', true)
    }
    const capabilities = this.availableToolCapabilities()
    try {
      for (const call of calls) assertRuntimeCapabilityCall({ name: call.name, authorization: { projection, admittedStateRevision: this.taskControl.stateRevision },
        request: { sessionId: this.sessionId ?? '', taskId: this.taskControl.taskId, runId: this.run.runId ?? '' }, task: this.taskControl, capabilities })
    } catch (error) { throw this.capabilityStageError(error, projection) }
  }

  /**
   * Validate every member of a delegation batch before the first child is
   * reserved. This keeps a malformed batch from creating a partial set of
   * children and makes one model response the atomic submission boundary.
   */
  private validateDelegateBatch(
    calls: readonly { name: string; arguments?: unknown }[],
    projection: RuntimeCapabilityProjection,
  ): void {
    const delegation = projection.bindings.find(binding => binding.name === 'delegate_task')
    const eligible = this.taskControl.tasks.filter(task => projection.execution.activeTaskIds.includes(task.id)
      && !!delegation && (task.capabilityIds.includes('delegate_task') || task.capabilityIds.includes(delegation.capabilityId)))
    const planIds: string[] = []
    for (const call of calls) {
      const args = isObject(call.arguments) ? call.arguments : undefined
      if (!args || typeof args.goal !== 'string' || !args.goal.trim() || typeof args.prompt !== 'string' || !args.prompt.trim()) {
        throw new RuntimeStageError('model_protocol', 'CHILD_PLAN_BATCH_INVALID', 'every delegation in a batch must contain a bounded goal and prompt', true)
      }
      if (args.execution_mode !== undefined && !['readonly', 'action'].includes(String(args.execution_mode))) {
        throw new RuntimeStageError('model_protocol', 'CHILD_PLAN_BATCH_INVALID', 'every delegation execution_mode must be readonly or action', true)
      }
      if (args.execution_mode === 'action' && !Array.isArray(args.capability_ids)) {
        throw new RuntimeStageError('model_protocol', 'CHILD_PLAN_BATCH_INVALID', 'action delegations must list capability_ids explicitly', true)
      }
      const planTaskId = typeof args.plan_task_id === 'string' ? args.plan_task_id : undefined
      if (this.taskControl.tasks.length || planTaskId) {
        if (!planTaskId && eligible.length !== calls.length) {
          throw new RuntimeStageError('model_protocol', 'CHILD_PLAN_BATCH_TARGET_REQUIRED', 'each delegation in a multi-child batch must identify its own active plan_task_id', true)
        }
        if (planTaskId && !eligible.some(task => task.id === planTaskId)) {
          throw new RuntimeStageError('model_protocol', 'CHILD_PLAN_BATCH_TARGET_INVALID', `delegation target is not an active delegable plan node: ${planTaskId}`, true)
        }
        if (planTaskId) planIds.push(planTaskId)
      }
    }
    if (new Set(planIds).size !== planIds.length) {
      throw new RuntimeStageError('model_protocol', 'CHILD_PLAN_BATCH_TARGET_DUPLICATE', 'a delegation batch cannot assign the same plan node twice', true)
    }
    if (planIds.length) {
      const binding = this.sessionId && this.run.runId ? this.childBinding() : undefined
      const existing = binding ? this.getChildService().store.list(binding) : []
      const occupied = new Set(existing.filter(record => !terminalChild(record.status)).flatMap(record => record.spec.assignment?.planTaskId ? [record.spec.assignment.planTaskId] : []))
      const conflict = planIds.find(id => occupied.has(id))
      if (conflict) throw new RuntimeStageError('model_protocol', 'CHILD_PLAN_BATCH_TARGET_BUSY', `delegation target already has an active child: ${conflict}`, true)
    }
  }

  private validatePendingCapabilities(request: ToolCallRequest): void {
    const capabilities = this.availableToolCapabilities()
    const requests = [...this.pendingToolCalls.values(), ...this.pendingWorkflowCalls.values()]
      .filter(pending => pending === request || (request.authorization && pending.authorization?.projection.id === request.authorization.projection.id))
    if (!requests.includes(request)) requests.push(request)
    try {
      for (const pending of requests) assertRuntimeCapabilityCall({ name: pending.name, authorization: pending.authorization,
        request: { sessionId: this.sessionId ?? '', taskId: this.taskControl.taskId, runId: this.run.runId ?? '' }, task: this.taskControl, capabilities })
    } catch (error) { throw this.capabilityStageError(error, request.authorization?.projection) }
  }

  private activateBaselineWorkspaceResources(correlationId: string): void {
    if (this.baselineWorkspaceResourcesActivated || !this.projectLlmEnabled) return
    this.baselineWorkspaceResourcesActivated = true

    const baselineTools = this.toolCatalog.filter((tool) => tool.id.startsWith('project-files:'))
    const missingTools = baselineTools.filter((tool) => !this.tools.items.some((item) => item.id === tool.id))
    if (missingTools.length > 0) {
      this.tools = {
        ...this.tools,
        revision: this.tools.revision + 1,
        items: [...this.tools.items, ...missingTools.map((tool) => clone(tool))],
      }
      this.snapshotRevision += 1
      this.emit('runtime.tools.updated', clone(this.tools), correlationId)
    }

    // The system project-files Skill carries the safe file/code workflow and
    // is resolved project-first, system-second by SkillRegistry.
    if (this.skillRegistry.get('project-files') && !this.skills.items.some((skill) => skill.id === 'project-files')) {
      this.attachSkill('project-files', 'retrieval', correlationId)
      return
    }
    if (missingTools.length > 0 && !this.reconcileHarnessBindings(correlationId)) {
      this.syncResourceVariables(correlationId)
    }
  }

  private estimatedModelInputTokens(
    messages: readonly LlmMessage[] = this.llmMessages,
    tools: readonly LlmToolDefinition[] = this.modelToolDefinitions(),
  ): number {
    return Math.ceil(JSON.stringify({ messages, tools }).length / 4)
  }

  private llmConfigFingerprint(
    settings: ReturnType<ProjectResources['readSettings']>,
  ): string {
    return JSON.stringify(settings.llm)
  }

  private refreshProjectLlm(
    settings = this.projectResources.readSettings(),
  ): void {
    if (!this.projectLlmEnabled) return
    const fingerprint = this.llmConfigFingerprint(settings)
    if (fingerprint === this.projectLlmConfigFingerprint) return
    this.llm = createProjectLlmService(settings.llm)
    this.projectLlmConfigFingerprint = fingerprint
  }

  private conversationMessages(system: string): LlmMessage[] {
    const conversationLimit = this.maxMessages - 1
    const conversation = this.messages
      .filter((message) => message.status !== 'failed' && message.status !== 'cancelled')
      .map((message) => ({
        role: message.role,
        content: message.content.map((part) => part.text).join('\n'),
      }))
    const recent = conversationLimit > 0 ? conversation.slice(-conversationLimit) : []
    return [{ role: 'system', content: system }, ...recent]
  }

  private renderMessages(
    system: string,
    messages: readonly LlmMessage[] = this.llmMessages,
  ): RenderResultState['messages'] {
    const source = messages.length > 0
      ? messages.map((message, index) => (
          index === 0 && message.role === 'system'
            ? { ...message, content: system }
            : message
        ))
      : this.conversationMessages(system)
    if (source[0]?.role !== 'system') source.unshift({ role: 'system', content: system })
    return source.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.name ? { name: message.name } : {}),
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.toolCalls ? {
        toolCalls: message.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: toJsonValue(call.arguments),
        })),
      } : {}),
    }))
  }

  private publishRenderedMessages(correlationId: string): void {
    this.syncSystemMessages(correlationId)
    const system = this.renderResult.messages.find((message) => message.role === 'system')
      ?.content ?? ''
    this.renderResult = {
      ...this.renderResult,
      messages: this.renderMessages(system),
      variablesRevision: this.variables.revision,
      renderedAt: now(),
    }
    this.snapshotRevision += 1
    this.emit('render.result.updated', clone(this.renderResult), correlationId)
  }

  private handleContextRender(event: RenderEvent): void {
    const source = fs.readFileSync(
      path.join(this.contextBuilder.projectDir, this.contextBuilder.mainFile),
      'utf8',
    )
    if (source !== this.template.source) {
      this.template = {
        ...this.template,
        source,
        revision: this.template.revision + 1,
        updatedAt: now(),
      }
      this.emit('template.updated', clone(this.template), this.saveCorrelationId)
    }

    const system = event.output.trim()
    if (this.llmMessages[0]?.role === 'system') {
      this.llmMessages[0] = { role: 'system', content: system }
    } else if (this.llmMessages.length > 0) {
      this.llmMessages.unshift({ role: 'system', content: system })
    }
    this.syncSystemMessages(this.saveCorrelationId)
    this.renderResult = this.contextRenderResult(
      system,
      event.missingVariables,
    )
    this.snapshotRevision += 1
    this.emit('render.result.updated', clone(this.renderResult), this.saveCorrelationId)
    this.captureContextRevision(
      event.reason,
      event.includedFiles,
      event.missingVariables,
      this.saveCorrelationId,
    )
  }

  private saveContextFile(file: string, content: string, correlationId: string): void {
    this.saveCorrelationId = correlationId
    try {
      this.contextBuilder.saveTemplate(file, content)
    } finally {
      this.saveCorrelationId = undefined
    }
  }

  private render(source: string, variables: RuntimeVariables): RenderResultState {
    try {
      return {
        messages: this.renderMessages(this.environment.renderString(source, variables).trim()),
        format: 'llm-messages',
        templateRevision: this.template.revision,
        variablesRevision: this.variables.revision,
        renderedAt: now(),
        diagnostics: [],
      }
    } catch (error) {
      throw new CommandError(
        'INVALID_PAYLOAD',
        `template render failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private renderAndPublish(correlationId: string): void {
    try {
      this.saveCorrelationId = correlationId
      this.contextBuilder.setProperties(this.variables.value, false)
      this.contextBuilder.build()
    } catch (error) {
      this.emit(
        'render.result.failed',
        {
          templateRevision: this.template.revision,
          variablesRevision: this.variables.revision,
          diagnostics: [
            {
              severity: 'error',
              code: 'TEMPLATE_RENDER_FAILED',
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        },
        correlationId,
      )
    } finally {
      this.saveCorrelationId = undefined
    }
  }

  private attachTool(toolId: string, correlationId: string): void {
    const tool = this.toolCatalog.find((item) => item.id === toolId) as ToolDefinition
    this.tools = {
      ...this.tools,
      revision: this.tools.revision + 1,
      items: this.tools.items.some(item => item.id === toolId)
        ? this.tools.items.map(item => item.id === toolId ? clone(tool) : item)
        : [...this.tools.items, clone(tool)],
    }
    this.snapshotRevision += 1
    this.emit('runtime.tools.updated', clone(this.tools), correlationId)
    if (!this.reconcileHarnessBindings(correlationId)) this.syncResourceVariables(correlationId)
  }

  private detachTool(toolId: string, correlationId: string): void {
    this.mcpActiveToolIds.delete(toolId)
    this.tools = {
      ...this.tools,
      revision: this.tools.revision + 1,
      items: this.tools.items.filter((item) => item.id !== toolId),
    }
    this.snapshotRevision += 1
    this.emit('runtime.tools.updated', clone(this.tools), correlationId)
    if (!this.reconcileHarnessBindings(correlationId)) this.syncResourceVariables(correlationId)
  }

  private syncResourceVariables(correlationId: string): void {
    this.updateVariables(
      [
        {
          op: 'replace',
          path: '/tools',
          value: this.tools.items.map((tool) => ({
            id: tool.id,
            name: tool.name,
            description: tool.description,
          })),
        },
        {
          op: 'replace',
          path: '/harnesses',
          value: this.harnessVariableValue(),
        },
        {
          op: 'replace',
          path: '/skills',
          value: this.skillVariableValue(),
        },
      ],
      'runtime',
      correlationId,
    )
  }

  private reloadProjectTools(
    settings: ReturnType<ProjectResources['readSettings']>,
    correlationId: string,
  ): void {
    for (const tool of this.tools.items.filter(tool => tool.origin?.type === 'mcp')) this.mcpActiveToolIds.add(tool.id)
    const enabled = new Set([...this.tools.items.map(tool => tool.id), ...this.mcpActiveToolIds])
    this.toolRegistry.load(settings.tools)
    const nextCatalog: ToolDefinition[] = [...this.toolRegistry.list().map((tool) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as JsonObject,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema as JsonObject } : {}),
      permissions: [...tool.permissions],
      sideEffects: tool.sideEffects ?? 'none',
      replay: tool.replay ?? 'safe',
      definitionRevision: 1,
      enabled: true,
    })), ...this.mcp.definitions()]
    assertNoReservedToolNames(nextCatalog)
    if (new Set(nextCatalog.map(tool => tool.name)).size !== nextCatalog.length) throw new Error('MCP_TOOL_NAMESPACE_COLLISION')
    this.toolCatalog = nextCatalog
    this.toolDispatcher = new ToolDispatcher(this.toolRegistry, this.workspaceDir, {
      timeoutMs: settings.tool_timeout_ms,
      networkRetry: settings.tool_network_retry,
      permissions: settings.tool_permissions,
    })
    const attachedBySkills = new Set(this.tools.items.filter(tool => tool.attachedBySkill).map(tool => tool.id))
    const nextItems = this.toolCatalog.filter((tool) => enabled.has(tool.id))
      .map(tool => attachedBySkills.has(tool.id) ? { ...tool, attachedBySkill: true as const } : tool)
    const changed = JSON.stringify({ items: nextItems, catalog: this.toolCatalog })
      !== JSON.stringify({ items: this.tools.items, catalog: this.tools.catalog })
    if (!changed) return
    this.tools = {
      revision: this.tools.revision + 1,
      items: nextItems,
      catalog: clone(this.toolCatalog),
    }
    this.snapshotRevision += 1
    this.emit('runtime.tools.updated', clone(this.tools), correlationId)
    if (!this.reconcileHarnessBindings(correlationId)) this.syncResourceVariables(correlationId)
  }

  private reloadProjectHarnesses(
    settings: ReturnType<ProjectResources['readSettings']>,
    correlationId: string,
  ): void {
    this.harnessPolicy = clone(settings.harness_policy)
    this.harnessCatalog = loadRuntimeHarnessCatalog(
      this.projectDir,
      new PluginRegistry(this.projectDir, this.systemDir).effectiveHarnesses(settings),
    )
    this.reconcileHarnessBindings(correlationId)
  }

  private harnessCatalogDefinitions(): HarnessCatalogDefinition[] {
    return this.harnessCatalog.map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      type: entry.type,
      source: this.resourcePath(entry.source),
      priority: entry.priority,
      activation: toJsonValue(entry.activation) as JsonObject,
      requiredTools: [...entry.requiredTools],
    }))
  }

  private harnessVariableValue(): RuntimeVariables['harnesses'] {
    return this.harnesses.items
      .filter((harness) => harness.status === 'active' || Boolean(harness.lastGoodArtifactId))
      .map(({ id, name, content }) => ({ id, name, content }))
  }

  private renderHarnessEntry(
    entry: HarnessCatalogEntry,
    variables: RuntimeVariables,
  ): string {
    const properties = {
      ...variables,
      request: variables.user_message,
      harnesses: [],
    }
    const source = this.resourceTemplatePath(entry.source)
    return this.environment.render(source, properties).trim()
  }

  private harnessAttachment(
    entry: HarnessCatalogEntry,
    bindings: HarnessBinding[],
    variables: RuntimeVariables,
    correlationId: string,
  ): HarnessDefinition {
    const previous = this.harnesses.items.find((item) => item.id === entry.id)
    const missingTools = entry.requiredTools.filter(
      (name) => !this.tools.items.some((tool) => tool.name === name),
    )
    const metadata: JsonObject = {
      source: this.resourcePath(entry.source),
      manifest: this.resourcePath(entry.manifest),
      description: entry.description,
      priority: entry.priority,
      activation: toJsonValue(entry.activation),
      requiredTools: [...entry.requiredTools],
      inputs: [...entry.inputs],
    }
    let candidate: Omit<HarnessDefinition, 'revision'>
    if (missingTools.length > 0) {
      candidate = {
        id: entry.id,
        name: entry.name,
        type: entry.type,
        content: previous?.content ?? '',
        metadata,
        status: 'error',
        bindings,
        ...(previous?.renderArtifactId ? { renderArtifactId: previous.renderArtifactId } : {}),
        ...(previous?.lastGoodArtifactId
          ? { lastGoodArtifactId: previous.lastGoodArtifactId }
          : previous?.renderArtifactId ? { lastGoodArtifactId: previous.renderArtifactId } : {}),
        diagnostics: [{
          severity: 'error',
          code: 'HARNESS_REQUIRED_TOOL_MISSING',
          message: `Required tools are not attached: ${missingTools.join(', ')}`,
        }],
      }
    } else {
      try {
        const content = this.renderHarnessEntry(entry, variables)
        const artifact = previous?.content === content && previous.renderArtifactId
          ? { id: previous.renderArtifactId }
          : this.createArtifact(
              'harness-render',
              `Harness render · ${entry.name}`,
              content,
              correlationId,
            )
        candidate = {
          id: entry.id,
          name: entry.name,
          type: entry.type,
          content,
          metadata,
          status: 'active',
          bindings,
          renderArtifactId: artifact.id,
          lastGoodArtifactId: artifact.id,
          diagnostics: [],
        }
      } catch (error) {
        candidate = {
          id: entry.id,
          name: entry.name,
          type: entry.type,
          content: previous?.content ?? '',
          metadata,
          status: 'error',
          bindings,
          ...(previous?.renderArtifactId ? { renderArtifactId: previous.renderArtifactId } : {}),
          ...(previous?.lastGoodArtifactId
            ? { lastGoodArtifactId: previous.lastGoodArtifactId }
            : previous?.renderArtifactId ? { lastGoodArtifactId: previous.renderArtifactId } : {}),
          diagnostics: [{
            severity: 'error',
            code: 'HARNESS_RENDER_FAILED',
            message: error instanceof Error ? error.message : String(error),
          }],
        }
      }
    }
    const previousValue = previous
      ? JSON.stringify((({ revision: _revision, ...value }) => value)(previous))
      : undefined
    return {
      ...candidate,
      revision: previousValue === JSON.stringify(candidate)
        ? previous?.revision ?? 1
        : (previous?.revision ?? 0) + 1,
    }
  }

  private reconcileHarnessBindings(
    correlationId: string,
    options: {
      publish?: boolean
      experienceQuery?: string
      sourceId?: string
      attachIds?: string[]
      attachSource?: 'retrieval' | 'user'
      detachId?: string
    } = {},
  ): boolean {
    const byHarness = new Map<string, HarnessBinding[]>()
    const add = (harnessId: string, binding: HarnessBinding) => {
      const bindings = byHarness.get(harnessId) ?? []
      if (!bindings.some((item) => item.id === binding.id)) bindings.push(binding)
      byHarness.set(harnessId, bindings)
    }
    for (const attachment of this.harnesses.items) {
      for (const binding of attachment.bindings) {
        if (binding.source === 'user' || (
          binding.source === 'retrieval' && options.experienceQuery === undefined
        )) add(attachment.id, clone(binding))
      }
    }
    if (options.detachId) byHarness.delete(options.detachId)
    for (const harnessId of options.attachIds ?? []) {
      const source = options.attachSource ?? 'user'
      add(harnessId, {
        id: `${source}:${options.sourceId ?? 'manual'}:${harnessId}`,
        source,
        sourceId: options.sourceId ?? 'manual',
        reason: source === 'user' ? 'Attached by developer' : 'Loaded by resource retrieval',
      })
    }

    const llm = this.llm.getConfig()
    const activeToolNames = new Set(this.tools.items.map((tool) => tool.name))
    for (const entry of this.harnessCatalog) {
      if (entry.type === 'persistent') {
        add(entry.id, {
          id: `persistent:${entry.id}`,
          source: 'persistent',
          sourceId: entry.id,
          reason: 'Persistent harness from enabled plugin',
        })
      }
      if (entry.type === 'model') {
        const activation = entry.activation as {
          providers?: string[]
          models?: string[]
          modelFamilies?: string[]
        }
        const matched = matchesModelHarnessActivation(
          activation,
          llm.provider,
          llm.model,
        )
        if (matched) add(entry.id, {
          id: `model:${llm.provider}:${llm.model}`,
          source: 'model',
          sourceId: `${llm.provider}:${llm.model}`,
          reason: `Matched model ${llm.model}`,
        })
      }
      if (entry.type === 'tool') {
        const names = (entry.activation as { tools: string[] }).tools
          .filter((name) => activeToolNames.has(name))
        for (const name of names) add(entry.id, {
          id: `tool:${name}`,
          source: 'tool',
          sourceId: name,
          reason: `Attached tool ${name}`,
        })
      }
    }

    if (options.experienceQuery !== undefined && this.harnessPolicy.experience_auto_attach) {
      const query = options.experienceQuery.toLowerCase()
      const matches = this.harnessCatalog
        .filter((entry) => entry.type === 'experience')
        .map((entry) => {
          const keywords = (entry.activation as { keywords: string[] }).keywords
          const score = keywords.filter((keyword) => query.includes(keyword.toLowerCase())).length
            / keywords.length
          return { entry, score }
        })
        .filter(({ score }) => score >= this.harnessPolicy.experience_threshold)
        .sort((left, right) => right.score - left.score || right.entry.priority - left.entry.priority)
        .slice(0, this.harnessPolicy.experience_top_k)
      for (const { entry, score } of matches) add(entry.id, {
        id: `retrieval:${options.sourceId ?? 'request'}:${entry.id}`,
        source: 'retrieval',
        sourceId: options.sourceId ?? 'request',
        reason: `Experience retrieval score ${score.toFixed(2)}`,
        score,
      })
    }

    const typeOrder = { persistent: 0, model: 1, tool: 2, experience: 3 }
    const nextItems = this.harnessCatalog
      .filter((entry) => (byHarness.get(entry.id)?.length ?? 0) > 0)
      .sort((left, right) => typeOrder[left.type] - typeOrder[right.type]
        || right.priority - left.priority || left.id.localeCompare(right.id))
      .map((entry) => this.harnessAttachment(
        entry,
        (byHarness.get(entry.id) ?? []).sort((left, right) => left.id.localeCompare(right.id)),
        this.variables.value,
        correlationId,
      ))
    const nextCatalog = this.harnessCatalogDefinitions()
    const changed = JSON.stringify({ items: nextItems, catalog: nextCatalog })
      !== JSON.stringify({ items: this.harnesses.items, catalog: this.harnesses.catalog })
    if (!changed) return false
    this.harnessRevision += 1
    this.harnesses = { revision: this.harnessRevision, items: nextItems, catalog: nextCatalog }
    this.snapshotRevision += 1
    if (options.publish !== false) {
      this.emit('runtime.harnesses.updated', clone(this.harnesses), correlationId)
      this.syncResourceVariables(correlationId)
    }
    return true
  }

  private refreshHarnessRenders(
    variables: RuntimeVariables,
    correlationId: string,
  ): boolean {
    const nextItems = this.harnesses.items.map((attachment) => {
      const entry = this.harnessCatalog.find((item) => item.id === attachment.id)
      return entry
        ? this.harnessAttachment(entry, clone(attachment.bindings), variables, correlationId)
        : attachment
    })
    if (JSON.stringify(nextItems) === JSON.stringify(this.harnesses.items)) return false
    this.harnessRevision += 1
    this.harnesses = { ...this.harnesses, revision: this.harnessRevision, items: nextItems }
    this.snapshotRevision += 1
    this.emit('runtime.harnesses.updated', clone(this.harnesses), correlationId)
    return true
  }

  private skillCatalogDefinitions(): SkillCatalogDefinition[] {
    return this.skillRegistry.list().map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      ...(skill.compatibility ? { compatibility: skill.compatibility } : {}),
      metadata: toJsonValue(skill.metadata) as JsonObject,
      entry: this.resourcePath(skill.entryFile),
      scripts: skill.scriptFiles.map((file) => this.skillResourcePath(skill, file)),
      references: skill.referenceFiles.map((file) => this.skillResourcePath(skill, file)),
      assets: skill.assetFiles.map((file) => this.skillResourcePath(skill, file)),
    }))
  }

  private skillResourcePath(skill: RegisteredSkill, file: string): string {
    return path.relative(skill.rootDir, file).replaceAll('\\', '/')
  }

  private currentSkillEntryHash(skill: RegisteredSkill): string {
    if (fs.realpathSync(skill.entryFile) !== skill.entryFile) throw new Error('registered Skill entry changed path')
    return createHash('sha256').update(fs.readFileSync(skill.entryFile)).digest('hex')
  }

  private resourcePath(absoluteFile: string): string {
    const resolved = path.resolve(absoluteFile)
    const systemRoot = path.join(os.homedir(), '.capybara')
    if (isInside(this.projectDir, resolved)) {
      return path.relative(this.projectDir, resolved).replaceAll('\\', '/')
    }
    if (isInside(systemRoot, resolved)) {
      return `@system/${path.relative(systemRoot, resolved).replaceAll('\\', '/')}`
    }
    throw new Error(`runtime resource path leaves project and system roots: ${absoluteFile}`)
  }

  private resourceTemplatePath(absoluteFile: string): string {
    const resolved = path.resolve(absoluteFile)
    const systemRoot = path.join(os.homedir(), '.capybara')
    if (isInside(this.projectDir, resolved)) {
      return path.relative(this.projectDir, resolved).replaceAll('\\', '/')
    }
    if (isInside(systemRoot, resolved)) {
      return path.relative(systemRoot, resolved).replaceAll('\\', '/')
    }
    throw new Error(`runtime template path leaves project and system roots: ${absoluteFile}`)
  }

  private requiredToolNames(skill: RegisteredSkill): string[] {
    return [...new Set((skill.metadata['capybara-required-tools'] ?? '')
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean))]
  }

  private requiredToolDefinitions(skill: RegisteredSkill): ToolDefinition[] {
    const names = this.requiredToolNames(skill)
    const tools = names.map((name) => this.toolCatalog.find(
      (tool) => tool.id === name || tool.name === name,
    ))
    const missing = names.filter((_name, index) => !tools[index])
    if (missing.length > 0) {
      throw new RuntimeStageError(
        'skill_activation',
        'SKILL_REQUIRED_TOOL_MISSING',
        `Skill ${skill.id} requires unavailable tools: ${missing.join(', ')}`,
      )
    }
    return tools as ToolDefinition[]
  }

  private skillDefinition(
    skill: RegisteredSkill,
    source: SkillDefinition['source'],
    previous?: SkillDefinition,
  ): SkillDefinition {
    this.requiredToolDefinitions(skill)
    const resources: SkillResourceState[] = [
      ...skill.referenceFiles.map((file) => ({
        path: this.skillResourcePath(skill, file),
        kind: 'reference' as const,
      })),
      ...skill.scriptFiles.map((file) => ({
        path: this.skillResourcePath(skill, file),
        kind: 'script' as const,
      })),
      ...skill.assetFiles.map((file) => ({
        path: this.skillResourcePath(skill, file),
        kind: 'asset' as const,
      })),
    ].map((resource) => {
      const prior = previous?.resources.find(
        (item) => item.path === resource.path && item.kind === resource.kind,
      )
      if (resource.kind === 'reference' && previous?.sourceVersion === skill.sourceVersion && prior?.status === 'loaded') {
        try {
          const observed = this.readRegisteredSkillReference(skill, resource.path)
          if (observed.hash === prior.hash) return { ...resource, status: 'loaded' as const, ...observed }
        } catch {
          // The original stays in its observation. Reload requires an explicit new read.
        }
      }
      return { ...resource, status: 'unloaded' as const }
    })
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      instructions: skill.body.trim(),
      sourceVersion: skill.sourceVersion,
      ...(previous?.activation ? { activation: previous.activation } : {}),
      status: 'active',
      source,
      requiredTools: this.requiredToolNames(skill),
      resources,
      revision: (previous?.revision ?? 0) + 1,
      diagnostics: [],
    }
  }

  private revalidateSkillAttachments(previousItems: readonly SkillDefinition[], errorCode: string): SkillDefinition[] {
    return previousItems.flatMap(previous => {
      const skill = this.skillRegistry.get(previous.id)
      if (!skill) return []
      try {
        return [this.skillDefinition(skill, previous.source, previous)]
      } catch (error) {
        return [{ ...previous, status: 'failed' as const, revision: previous.revision + 1,
          diagnostics: [{ severity: 'error' as const, code: errorCode, message: error instanceof Error ? error.message : String(error) }] }]
      }
    })
  }

  private withRequiredSkillTools(skills: readonly SkillDefinition[], tools: readonly ToolDefinition[]): ToolDefinition[] {
    const names = new Set(skills.filter(skill => skill.status === 'active').flatMap(skill => skill.requiredTools))
    const required = (tool: ToolDefinition) => names.has(tool.id) || names.has(tool.name)
    const retained = tools.filter(tool => !tool.attachedBySkill || required(tool))
    const installed = new Set(retained.map(tool => tool.id))
    return [...retained, ...this.toolCatalog.filter(tool => required(tool) && !installed.has(tool.id)).map(tool => ({ ...clone(tool), attachedBySkill: true as const }))]
  }

  private applySkillAttachments(items: SkillDefinition[], correlationId: string): void {
    this.skills = { revision: ++this.skillRevision, items, catalog: clone(this.skillCatalog) }
    const tools = this.withRequiredSkillTools(items, this.tools.items)
    if (JSON.stringify(tools) !== JSON.stringify(this.tools.items)) {
      this.tools = { ...this.tools, revision: this.tools.revision + 1, items: tools }
      this.snapshotRevision++
      this.emit('runtime.tools.updated', clone(this.tools), correlationId)
      if (this.reconcileHarnessBindings(correlationId, { publish: false })) this.emit('runtime.harnesses.updated', clone(this.harnesses), correlationId)
    }
    this.publishSkills(correlationId)
  }

  private skillVariableValue(items = this.skills.items): RuntimeVariables['skills'] {
    return {
      catalog: this.skillCatalog.map(({ id, name, description }) => ({ id, name, description })),
      active: items
        .filter((skill) => skill.status === 'active')
        .map((skill) => ({
          id: skill.id,
          name: skill.name,
          instructions: skill.instructions,
          requiredTools: [...skill.requiredTools],
          references: skill.resources
            .filter((resource) => resource.kind === 'reference' && resource.status === 'loaded')
            .map((resource) => ({ path: resource.path, content: resource.content ?? '' })),
          scripts: skill.resources
            .filter((resource) => resource.kind === 'script')
            .map((resource) => resource.path),
        })),
    }
  }

  private publishSkills(correlationId: string, render = true): void {
    this.snapshotRevision += 1
    this.emit('runtime.skills.updated', clone(this.skills), correlationId)
    if (render) this.syncResourceVariables(correlationId)
  }

  private publishSkillConfirmations(correlationId: string): void {
    this.skillConfirmationRevision += 1
    const pending = this.skillConfirmations.items.filter((item) => item.status === 'pending')
    const resolvedLimit = Math.max(0, MAX_SKILL_CONFIRMATIONS - pending.length)
    const resolvedItems = this.skillConfirmations.items.filter((item) => item.status !== 'pending')
    const resolved = resolvedLimit === 0 ? [] : resolvedItems.slice(-resolvedLimit)
    this.skillConfirmations = {
      revision: this.skillConfirmationRevision,
      items: [...resolved, ...pending],
    }
    this.snapshotRevision += 1
    this.emit(
      'runtime.skills.confirmations.updated',
      clone(this.skillConfirmations),
      correlationId,
    )
  }

  private addSkillConfirmation(
    confirmation: RuntimeSkillConfirmation,
    correlationId: string,
  ): RuntimeSkillConfirmation {
    const duplicate = this.skillConfirmations.items.find((item) =>
      item.status === 'pending' &&
      item.kind === confirmation.kind &&
      item.skillName === confirmation.skillName &&
      JSON.stringify(item.source) === JSON.stringify(confirmation.source))
    if (duplicate) return duplicate
    if (this.skillConfirmations.items.filter((item) => item.status === 'pending').length >= MAX_SKILL_CONFIRMATIONS) {
      throw new Error('too many pending Skill confirmations; resolve an existing request first')
    }
    this.skillConfirmations = {
      ...this.skillConfirmations,
      items: [...this.skillConfirmations.items, confirmation],
    }
    this.publishSkillConfirmations(correlationId)
    return confirmation
  }

  private updateSkillConfirmation(
    confirmationId: string,
    changes: Partial<RuntimeSkillConfirmation>,
    correlationId: string,
  ): void {
    this.skillConfirmations = {
      ...this.skillConfirmations,
      items: this.skillConfirmations.items.map((item) => item.id === confirmationId
        ? { ...item, ...changes }
        : item),
    }
    this.publishSkillConfirmations(correlationId)
  }

  private cancelSkillConfirmation(confirmationId: string, correlationId: string): void {
    this.updateSkillConfirmation(confirmationId, {
      status: 'cancelled',
      resolvedAt: now(),
    }, correlationId)
  }

  private confirmSkillOperation(confirmationId: string, correlationId: string): void {
    const confirmation = this.skillConfirmations.items.find((item) => item.id === confirmationId)
    if (!confirmation || confirmation.status !== 'pending') return
    this.assertInternalCapabilityAuthority(confirmation.kind === 'install' ? 'request_skill_install' : 'request_skill_uninstall')
    this.updateSkillConfirmation(confirmationId, { status: 'executing' }, correlationId)
    void this.resolveSkillConfirmation(confirmation, correlationId)
  }

  private async resolveSkillConfirmation(
    confirmation: RuntimeSkillConfirmation,
    correlationId: string,
  ): Promise<void> {
    try {
      this.assertInternalCapabilityAuthority(confirmation.kind === 'install' ? 'request_skill_install' : 'request_skill_uninstall')
      if (confirmation.kind === 'install') {
        if (!confirmation.source) throw new Error('Skill installation source is missing')
        await this.skillMarketplace.install({
          repo: confirmation.source.repo,
          path: confirmation.source.requestedPath,
          commit: confirmation.source.commit,
        })
      } else {
        await this.skillMarketplace.uninstall(confirmation.skillName)
      }
      this.reloadProjectSkills(this.projectResources.readSettings(), correlationId)
      this.updateSkillConfirmation(confirmation.id, {
        status: 'completed',
        resolvedAt: now(),
        error: undefined,
      }, correlationId)
    } catch (error) {
      this.updateSkillConfirmation(confirmation.id, {
        status: 'failed',
        resolvedAt: now(),
        error: error instanceof Error ? error.message : String(error),
      }, correlationId)
    }
  }

  private attachSkill(
    skillId: string,
    source: SkillDefinition['source'],
    correlationId: string,
    execution?: RuntimeExecutionState,
  ): void {
    const skill = this.skillRegistry.get(skillId)
    if (!skill) throw new CommandError('NOT_FOUND', 'skill was not found in the project catalog')
    const existing = this.skills.items.find(item => item.id === skillId)
    if (existing?.status === 'active') {
      if (!execution) return
      const rebound = bindRuntimeSkillActivation(existing, this.taskControl.taskId, execution)
      if (rebound === existing) return
      this.skills = { ...this.skills, revision: ++this.skillRevision,
        items: this.skills.items.map(item => item.id === skillId ? { ...rebound, revision: item.revision + 1 } : item) }
      this.publishSkills(correlationId)
      return
    }
    const definition = this.skillDefinition(skill, source, existing)
    this.applySkillAttachments([...this.skills.items.filter(item => item.id !== skillId), execution ? bindRuntimeSkillActivation(definition, this.taskControl.taskId, execution) : definition], correlationId)
  }

  private detachSkill(skillId: string, correlationId: string): void {
    this.applySkillAttachments(this.skills.items.filter(item => item.id !== skillId), correlationId)
  }

  private registeredSkillResource(
    skill: RegisteredSkill,
    resourcePath: string,
    kind: SkillResourceState['kind'],
  ): string {
    const files = kind === 'reference'
      ? skill.referenceFiles
      : kind === 'script' ? skill.scriptFiles : skill.assetFiles
    const file = files.find((candidate) => this.skillResourcePath(skill, candidate) === resourcePath)
    if (!file) throw new Error(`unregistered ${kind} resource: ${resourcePath}`)
    if (kind === 'script' && path.extname(file).toLowerCase() !== '.mjs') {
      throw new Error('only registered .mjs skill scripts can run')
    }
    if (fs.realpathSync(file) !== file) throw new Error('registered Skill resource changed path')
    return file
  }

  private readRegisteredSkillReference(skill: RegisteredSkill, resourcePath: string): { content: string; hash: string } {
    const file = this.registeredSkillResource(skill, resourcePath, 'reference')
    if (fs.statSync(file).size > 1024 * 1024) throw new Error('skill reference exceeds 1 MiB')
    const content = fs.readFileSync(file, 'utf8')
    return { content, hash: createHash('sha256').update(content).digest('hex') }
  }

  private setSkillResource(
    skillId: string,
    resourcePath: string,
    changes: Partial<SkillResourceState>,
    correlationId: string,
    render = false,
  ): void {
    this.skillRevision += 1
    this.skills = {
      ...this.skills,
      revision: this.skillRevision,
      items: this.skills.items.map((skill) => skill.id !== skillId ? skill : {
        ...skill,
        revision: skill.revision + 1,
        resources: skill.resources.map((resource) => resource.path === resourcePath
          ? { ...resource, ...changes }
          : resource),
      }),
    }
    this.publishSkills(correlationId, render)
  }

  private loadSkillReference(skillId: string, resourcePath: string, correlationId: string): JsonObject {
    this.assertInternalCapabilityAuthority('read_skill_resource')
    this.assertSkillResource(skillId, resourcePath, 'reference')
    try {
      const skill = this.assertCurrentSkillSource(this.assertSkill(skillId))
      const observed = this.readRegisteredSkillReference(skill, resourcePath)
      this.setSkillResource(skillId, resourcePath, {
        status: 'loaded', ...observed, error: undefined,
      }, correlationId, true)
      return { skillId, skillVersion: skill.sourceVersion, path: resourcePath, ...observed }
    } catch (error) {
      this.setSkillResource(skillId, resourcePath, {
        status: 'failed', content: undefined, hash: undefined,
        error: error instanceof Error ? error.message : String(error),
      }, correlationId, true)
      throw error
    }
  }

  private assertCurrentSkillSource(active: SkillDefinition): RegisteredSkill {
    const skill = this.skillRegistry.get(active.id)
    if (!skill || active.sourceVersion !== skill.sourceVersion || this.currentSkillEntryHash(skill) !== skill.entryHash) {
      throw new Error('active Skill entry changed; refresh the Skill before reading its resource')
    }
    return skill
  }

  private readSkillResourceArguments(argumentsValue: unknown, correlationId: string, execution?: RuntimeExecutionState): JsonObject {
    if (
      !isObject(argumentsValue) ||
      typeof argumentsValue.skill_id !== 'string' ||
      !argumentsValue.skill_id.trim() ||
      typeof argumentsValue.path !== 'string' ||
      !argumentsValue.path.trim()
    ) {
      throw new Error('read_skill_resource requires skill_id and path')
    }
    const active = execution && this.phaseSkills(execution).find(skill => skill.id === argumentsValue.skill_id)
    if (!active) throw new Error('Skill is not active in this model stage')
    if (argumentsValue.path === 'SKILL.md') {
      const source = this.assertCurrentSkillSource(active)
      return { skillId: active.id, path: 'SKILL.md', skillVersion: source.sourceVersion, content: active.instructions,
        hash: createHash('sha256').update(active.instructions).digest('hex') }
    }
    return this.loadSkillReference(argumentsValue.skill_id, argumentsValue.path, correlationId)
  }

  private async runSkillScript(
    skillId: string,
    resourcePath: string,
    argv: readonly string[],
    request: { id: string; name: string; authorization?: RuntimeCapabilityAuthorization },
    correlationId: string,
    signal?: AbortSignal,
  ): Promise<ToolCallResult> {
    this.assertInternalCapabilityAuthority('run_skill_script')
    const skill = this.skillRegistry.get(skillId)
    this.assertSkillResource(skillId, resourcePath, 'script')
    if (!skill) throw new Error(`unknown skill: ${skillId}`)
    const file = this.registeredSkillResource(skill, resourcePath, 'script')
    const source = () => {
      const execution = runtimeExecutionState(this.taskControl)
      if (request.authorization && capabilityHash(execution) !== capabilityHash(request.authorization.projection.execution)) return undefined
      const eligible = request.authorization ? this.phaseSkills(execution) : [this.assertSkill(skillId)]
      return this.skillScriptSources(eligible.filter(item => item.id === skillId)).find(item => item.path === resourcePath)
    }
    const registered = source()
    if (!registered) throw new Error('Skill script is not active in this model stage')
    const sourceHash = capabilityHash(registered)
    this.setSkillResource(skillId, resourcePath, {
      status: 'loading', content: undefined, error: undefined,
    }, correlationId)
    const result = await this.skillScriptRunner.run(request, file, argv, signal, () => {
      this.assertInternalCapabilityAuthority('run_skill_script')
      this.assertSkillResource(skillId, resourcePath, 'script')
      const current = source()
      if (!current || sourceHash !== capabilityHash(current)) throw new Error('Skill script source changed before dispatch; read the new capability projection')
    })
    this.setSkillResource(skillId, resourcePath, result.ok ? {
      status: 'loaded',
      content: JSON.stringify(result.output ?? null, null, 2),
      error: undefined,
    } : {
      status: 'failed',
      error: result.error?.message ?? 'skill script failed',
    }, correlationId)
    return result
  }

  private async runSkillScriptCommand(
    skillId: string,
    resourcePath: string,
    argv: string[],
    correlationId: string,
  ): Promise<void> {
    const startedAt = now()
    let result: ToolCallResult
    try {
      result = await this.runSkillScript(skillId, resourcePath, argv, { id: correlationId, name: 'run_skill_script' }, correlationId)
    } catch (error) {
      result = { id: correlationId, name: 'run_skill_script', ok: false, error: { code: 'PERMISSION_DENIED', message: error instanceof Error ? error.message : String(error) }, startedAt, completedAt: now(), durationMs: 0 }
    }
    this.createArtifact(
      'skill-script-result',
      `Skill script · ${skillId}/${resourcePath}`,
      result.ok ? { ok: true, result: result.output ?? null } : { ok: false, error: result.error ?? null },
      correlationId,
    )
  }

  private async requestSkillInstall(
    argumentsValue: unknown,
    correlationId: string,
  ): Promise<JsonObject> {
    const allowedKeys = new Set(['repo', 'path', 'commit'])
    if (
      !isObject(argumentsValue) ||
      Object.keys(argumentsValue).some((key) => !allowedKeys.has(key)) ||
      typeof argumentsValue.repo !== 'string' ||
      typeof argumentsValue.path !== 'string' ||
      typeof argumentsValue.commit !== 'string' ||
      !/^[a-f0-9]{40}$/.test(argumentsValue.commit)
    ) {
      throw new Error('request_skill_install requires repo, path, and a full 40-character commit SHA')
    }
    const preview = await this.skillMarketplace.preview({
      repo: argumentsValue.repo,
      path: argumentsValue.path,
    })
    if (preview.commit !== argumentsValue.commit) {
      throw new Error('the requested commit no longer matches the current preview; preview the Skill again')
    }
    const confirmation = this.addSkillConfirmation({
      id: `skill-confirmation-${randomUUID()}`,
      kind: 'install',
      status: 'pending',
      skillName: preview.skillName,
      source: {
        repo: preview.repo,
        requestedPath: preview.requestedPath,
        commit: preview.commit,
      },
      targetPath: `skills/${preview.skillName}`,
      warnings: preview.warnings,
      fileCount: preview.files.length,
      scriptCount: preview.files.filter((file) => file.kind === 'script').length,
      requestedAt: now(),
    }, correlationId)
    return toJsonValue({
      confirmation,
      requiresUserConfirmation: true,
      projectChanged: false,
    }) as JsonObject
  }

  private requestSkillUninstall(
    argumentsValue: unknown,
    correlationId: string,
  ): JsonObject {
    if (
      !isObject(argumentsValue) ||
      Object.keys(argumentsValue).some((key) => key !== 'skill_id') ||
      typeof argumentsValue.skill_id !== 'string' ||
      !argumentsValue.skill_id.trim()
    ) {
      throw new Error('request_skill_uninstall requires skill_id')
    }
    const installed = this.skillMarketplace.installed().find(
      (skill) => skill.id === argumentsValue.skill_id,
    )
    if (!installed) throw new Error('project Skill was not found')
    if (installed.path === '.capybara' || installed.path.startsWith('.capybara/')) {
      throw new Error('system Skills cannot be removed from the runtime')
    }
    const warnings = [
      'The Skill will be removed from the project and moved to the recoverable trash area.',
    ]
    if (installed.hasLocalChanges) {
      warnings.push('This Skill contains local changes that differ from its installed source.')
    }
    const confirmation = this.addSkillConfirmation({
      id: `skill-confirmation-${randomUUID()}`,
      kind: 'uninstall',
      status: 'pending',
      skillName: installed.id,
      ...(installed.repo && installed.requestedPath && installed.commit ? {
        source: {
          repo: installed.repo,
          requestedPath: installed.requestedPath,
          commit: installed.commit,
        },
      } : {}),
      targetPath: installed.path,
      warnings,
      hasLocalChanges: installed.hasLocalChanges,
      requestedAt: now(),
    }, correlationId)
    return toJsonValue({
      confirmation,
      requiresUserConfirmation: true,
      projectChanged: false,
    }) as JsonObject
  }

  private reloadProjectSkills(
    settings: ReturnType<ProjectResources['readSettings']>,
    correlationId: string,
  ): void {
    this.skillRegistry.load(settings.skills)
    this.skillCatalog = this.skillCatalogDefinitions()
    this.applySkillAttachments(this.revalidateSkillAttachments(this.skills.items, 'SKILL_ACTIVATION_FAILED'), correlationId)
  }

  private async verifyMcpSideEffect(request: ToolCallRequest, correlationId: string, signal?: AbortSignal, pendingWait?: () => boolean): Promise<JsonObject> {
    const args = request.arguments
    const authorization = request.authorization
    if (!isObject(args) || Object.keys(args).length !== 1 || typeof args.operation_id !== 'string'
      || !/^[a-f0-9-]{36}$/.test(args.operation_id) || !authorization || !this.sessionId || this.childAgentMode) throw new Error('MCP_VERIFICATION_ARGUMENTS_INVALID')
    const operationId = args.operation_id
    const store = this.projectContextStore.commits
    const operation = store.readMcpOperation(this.sessionId, operationId)
    const readOriginal = operation ? this.workflowNeedsMcpOutput(operation) : false
    const name = operation && this.mcp.verificationTool(operation, readOriginal)
    if (!name) throw new Error('MCP_VERIFICATION_OPERATION_UNAVAILABLE')
    const checkAuthority = () => {
      const binding = assertRuntimeCapabilityCall({ name, authorization, request: this.waitBinding(), task: this.taskControl, capabilities: this.availableToolCapabilities() })
      if (binding.source !== 'mcp' || binding.sideEffects !== 'none' || binding.replay !== 'safe'
        || !this.projectResources.readSettings().mcp_servers.some(config => config.enabled && config.id === operation.source.serverId)) throw new Error('MCP_VERIFICATION_READ_NOT_AUTHORIZED')
    }
    checkAuthority()
    const settings = this.projectResources.readSettings()
    if (pendingWait && !pendingWait()) throw new Error('MCP_VERIFICATION_INTERRUPTED')
    const read = await this.mcp.call({ id: request.id, name, arguments: { operation_id: operationId }, authorization }, settings.mcp_servers,
      new Set(settings.tool_permissions), signal)
    if (this.closed || signal?.aborted || (pendingWait && !pendingWait())) throw new Error('MCP_VERIFICATION_INTERRUPTED')
    const outcome = read.ok && mcpVerificationOutcome(read.output, operationId)
    if (!outcome && pendingWait) return { operationId, outcome: 'unknown' }
    const raw = toJsonValue({ kind: 'mcp-operation-verification', operationId, source: read.source, ...(read.ok ? { result: read.output } : { error: read.error }) })
    const artifact = this.createArtifact('tool-result', `MCP verification · ${operationId}`, raw, correlationId)
    if (!outcome) return { operationId, outcome: 'unknown', verificationArtifactId: artifact.id }
    if (this.closed || signal?.aborted || (pendingWait && !pendingWait())) throw new Error('MCP_VERIFICATION_INTERRUPTED')
    checkAuthority()
    const attachOriginal = readOriginal && this.mcp.verifiedOriginalResult(operation, read.output) !== undefined
    const receipt = store.verifyMcpOperation(operationId, authorization.projection.request, request.id, artifact, JSON.stringify(raw, null, 2), attachOriginal)
    this.mcp.restoreState()
    this.snapshotRevision++
    this.emit('runtime.mcp.updated', this.mcpSnapshot(), correlationId)
    return toJsonValue({ ...receipt, ...(readOriginal ? { originalResultAvailable: !!receipt.originalResult } : {}) }) as JsonObject
  }

  private mcpInputViews() {
    return this.sessionId && this.run.runId && this.projectContextStore
      ? this.projectContextStore.commits.mcpInputs.views(this.waitBinding()) : []
  }

  private mcpSnapshot() {
    const inputRequests = this.mcpInputViews()
    return { ...this.mcp.snapshot(), ...(inputRequests.length ? { inputRequests } : {}) }
  }

  private emitMcpInputState(correlationId: string): void {
    this.snapshotRevision++
    this.emit('runtime.mcp.updated', this.mcpSnapshot(), correlationId)
  }

  private authorizedMcpInputUrl(requestId: string, urlId: string) {
    if (!this.openExternalMcpUrl || this.closed || !this.sessionId || !this.run.runId || this.childAgentMode
      || ['completed', 'cancelled'].includes(this.run.status)) throw new Error('MCP_URL_REQUEST_UNAVAILABLE')
    const binding = this.waitBinding()
    const entry = this.projectContextStore.commits.mcpInputs.readUrl(binding, requestId, urlId)
    const settings = this.projectResources.readSettings()
    if (!this.mcp.authorizesUrlInput(entry, settings.mcp_servers, new Set(settings.tool_permissions))) throw new Error('MCP_URL_REQUEST_NOT_AUTHORIZED')
    return { binding, entry }
  }

  readMcpInputUrl(requestId: string, urlId: string) {
    const { entry: { url, host, message } } = this.authorizedMcpInputUrl(requestId, urlId)
    return { url, host, message }
  }

  async openMcpInputUrl(requestId: string, urlId: string): Promise<{ opened: true }> {
    const { binding, entry } = this.authorizedMcpInputUrl(requestId, urlId)
    if (entry.opened) return { opened: true }
    const key = `${requestId}/${urlId}`
    if (this.openingMcpUrls.has(key)) throw new Error('MCP_URL_OPEN_IN_PROGRESS')
    this.openingMcpUrls.add(key)
    try {
      try { await this.openExternalMcpUrl!(entry.url) }
      catch { throw new Error('MCP_URL_OPEN_FAILED') }
      if (this.closed || !this.projectContextStore.commits.mcpInputs.markUrlOpened(binding, requestId, urlId)) {
        throw new Error('MCP_URL_REQUEST_UNAVAILABLE')
      }
      this.emitMcpInputState(requestId)
      return { opened: true }
    } finally { this.openingMcpUrls.delete(key) }
  }

  private validateMcpInputReply(command: Extract<ClientCommand, { type: 'runtime.mcp.input.reply' }>): void {
    parseClientCommand(command, command.sessionId)
    if (command.sessionId !== this.sessionId || !this.run.runId || this.childAgentMode || ['cancelled', 'completed'].includes(this.run.status)) {
      throw new CommandError('INVALID_STATE', 'MCP_FORM_REPLY_BINDING_MISMATCH')
    }
    try { this.projectContextStore.commits.mcpInputs.validateReply(this.waitBinding(), command.payload.requestId, command.payload.responses,
      urlId => { this.authorizedMcpInputUrl(command.payload.requestId, urlId) }) }
    catch (error) { throw new CommandError('INVALID_PAYLOAD', error instanceof Error ? error.message : 'MCP_FORM_REPLY_INVALID') }
  }

  private registerMcpInput(input: Omit<McpInputContinuation, 'id' | 'answers' | 'binding' | 'requestState'>,
    source: NonNullable<ToolCallResult['source']>, data: McpInputData, correlationId: string): string {
    const binding = this.waitBinding(), commits = this.projectContextStore.commits
    const operationId = source.operationId
    const id = commits.mcpInputs.register(binding, { ...input, ...(operationId ? { operationId } : {}) }, source.serverId, source.toolName, data,
      operationId ? () => commits.requireMcpWriteForInput(binding, operationId, { ...input,
        argumentHash: createHash('sha256').update(JSON.stringify(input.args)).digest('hex') }) : undefined)
    this.emitMcpInputState(correlationId)
    return id
  }

  private async resumeMcpInput(request: ToolCallRequest, correlationId: string, signal?: AbortSignal): Promise<ToolCallResult> {
    const args = request.arguments
    if (this.childAgentMode || !request.authorization || !isObject(args) || Object.keys(args).length !== 1
      || typeof args.request_id !== 'string' || !/^mcp-input-[a-f0-9-]{36}$/.test(args.request_id)) throw new Error('MCP_FORM_CONTINUATION_INVALID')
    signal?.throwIfAborted()
    const binding = this.waitBinding()
    const commits = this.projectContextStore.commits, store = commits.mcpInputs
    const write = request.name === 'resume_mcp_write_input'
    const authorize = (entry: Omit<McpInputContinuation, 'answers'>) => {
      if (write !== !!entry.operationId) throw new Error('MCP_FORM_CONTINUATION_TOOL_MISMATCH')
      assertRuntimeCapabilityCall({ name: entry.tool, authorization: request.authorization, request: binding, task: this.taskControl,
        capabilities: this.availableToolCapabilities() })
      if (!this.mcp.canContinueInput(entry)) throw new Error('MCP_FORM_CONTINUATION_AUTHORITY_CHANGED')
      if (entry.workflow) {
        const workflow = this.workflowPlan(entry.workflow.id), original = this.workflowRecoveryStep(workflow)
        if (workflow.status !== 'suspended' || workflow.runId !== binding.runId || workflow.recovery?.nodeId !== entry.workflow.nodeId
          || workflow.recovery?.operationId !== entry.operationId || original?.id !== entry.originStepId || original.detail?.callId !== entry.originCallId) {
          throw new Error('MCP_FORM_WORKFLOW_BINDING_MISMATCH')
        }
      }
      if (entry.operationId) commits.requireMcpWriteForInput(binding, entry.operationId, { ...entry,
        argumentHash: createHash('sha256').update(JSON.stringify(entry.args)).digest('hex') })
    }
    const continuation = store.claim(binding, args.request_id, authorize)
    this.emitMcpInputState(correlationId)
    const { id, originCallId, originStepId, tool, authority, args: originalArgs, round, workflow, operationId } = continuation
    const settings = this.projectResources.readSettings()
    let followUp = false
    const result = await this.mcp.call({ ...request, name: tool, arguments: originalArgs }, settings.mcp_servers, new Set(settings.tool_permissions), signal, undefined, {
      continuation,
      ...(write ? { registerWriteDispatch: (source) => store.recordWriteDispatch(binding, id, request.id, source, () => {
        signal?.throwIfAborted()
        authorize(continuation)
      }) } : {}),
      register: (_authority, source, data) => {
        const nextId = this.registerMcpInput({ originCallId, originStepId, tool, authority, args: originalArgs, round: round + 1,
          ...(workflow ? { workflow } : {}) }, source, data, correlationId)
        followUp = true
        return nextId
      },
    })
    if (!this.closed && !result.ok) {
      store.settle(binding, id, followUp ? 'follow_up' : 'interrupted')
      this.reconcileWorkflowForms(correlationId)
    }
    const argumentHash = createHash('sha256').update(JSON.stringify(originalArgs)).digest('hex')
    return { ...result, name: request.name, ...(result.ok ? { mcpInput: { id, originCallId, originStepId, tool, argumentHash,
      ...(workflow ? { workflow } : {}), ...(operationId ? { operationId } : {}) } } : {}) }
  }

  private async executeResourceTool(
    request: ToolCallRequest,
    correlationId: string,
    stepId: string,
  ): Promise<ToolCallResult> {
    const started = Date.now()
    const startedAt = now()
    try {
      this.assertInternalCapabilityAuthority(request.name)
      if (request.name === 'resume_mcp_input' || request.name === 'resume_mcp_write_input') {
        return await this.resumeMcpInput(request, correlationId, this.activeAbortController?.signal)
      }
      if (request.name === 'verify_mcp_side_effect') {
        const output = await this.verifyMcpSideEffect(request, correlationId, this.activeAbortController?.signal)
        return { id: request.id, name: request.name, ok: true, output, startedAt, completedAt: now(), durationMs: Date.now() - started }
      }
      if (request.name === 'submit_branch_evidence') {
        const output = this.submitBranchEvidence(request.arguments, correlationId)
        return { id: request.id, name: request.name, ok: true, output, startedAt, completedAt: now(), durationMs: Date.now() - started }
      }
      if (['get_child_task', 'read_child_result', 'consume_child_result', 'cancel_child_task', 'respond_child_task', 'take_over_child_task'].includes(request.name)) {
        const output = await this.childControlTool(request, correlationId)
        return { id: request.id, name: request.name, ok: true, output, startedAt, completedAt: now(), durationMs: Date.now() - started }
      }
      if (request.name === 'read_wait_signal') {
        if (!isObject(request.arguments) || Object.keys(request.arguments).some(key => key !== 'signal_id') || typeof request.arguments.signal_id !== 'string') throw new Error('read_wait_signal requires only signal_id')
        const signal = this.getWaitStore().readSignal(this.waitBinding(), request.arguments.signal_id)
        return { id: request.id, name: request.name, ok: true, output: signal, startedAt, completedAt: now(), durationMs: Date.now() - started }
      }
      if (request.name === 'create_wait_deadline') {
        if (!isObject(request.arguments) || Object.keys(request.arguments).some(key => key !== 'timeout_ms') || typeof request.arguments.timeout_ms !== 'number') throw new Error('create_wait_deadline requires only timeout_ms')
        const deadline = this.getWaitStore().createDeadline(this.waitBinding(), request.id, request.arguments.timeout_ms)
        this.waits = this.getWaitStore().read(this.waitBinding())
        this.snapshotRevision += 1
        this.emit('runtime.wait.deadline.created', { deadline }, correlationId)
        this.emit('runtime.waits.updated', clone(this.waits), correlationId)
        return { id: request.id, name: request.name, ok: true, output: { deadlineRef: deadline.id, expiresAt: deadline.expiresAt }, startedAt, completedAt: now(), durationMs: Date.now() - started }
      }
      if (request.name === 'request_planning') {
        if (!isObject(request.arguments) || typeof request.arguments.reason !== 'string' || !request.arguments.reason.trim()
          || request.arguments.reason.length > 500 || Object.keys(request.arguments).some(key => key !== 'reason')) throw new Error('request_planning requires only a bounded reason')
        this.taskControl.planning = { required: true, reason: request.arguments.reason }
        this.taskControl.stateRevision += 1
        return { id: request.id, name: request.name, ok: true, output: toJsonValue({ planningRequired: true, execution: runtimeExecutionState(this.taskControl) }), startedAt, completedAt: now(), durationMs: Date.now() - started }
      }
      if (request.name === 'run_skill_script') {
        if (
          !isObject(request.arguments) ||
          typeof request.arguments.skill_id !== 'string' ||
          typeof request.arguments.path !== 'string' ||
          !Array.isArray(request.arguments.argv) ||
          !request.arguments.argv.every((item) => typeof item === 'string')
        ) throw new Error('run_skill_script requires skill_id, path, and string argv')
        return await this.runSkillScript(
          request.arguments.skill_id,
          request.arguments.path,
          request.arguments.argv,
          request,
          correlationId,
          this.activeAbortController?.signal,
        )
      }
      const output = request.name === 'manage_application'
        ? await this.manageApplicationTool(request)
        : request.name === 'delegate_task'
          ? await this.delegateTaskTool(request, stepId)
        : request.name === 'browser_read'
        ? await this.browserReadTool(request.arguments)
        : request.name === 'browser_action'
          ? await this.browserActionTool(request.arguments, request)
        : request.name === 'market_research'
          ? await this.marketResearchTool(request.arguments)
          : request.name === 'read_runtime_artifact'
        ? this.readRuntimeArtifactTool(request.arguments, request.authorization)
        : request.name === 'recall_context'
        ? await this.recallContextTool(request.arguments, correlationId, request.id)
        : request.name === 'search_resources'
        ? this.searchResources(request.arguments)
        : request.name === 'load_resources'
          ? this.loadResources(request.arguments, correlationId, request.authorization?.projection.execution)
          : request.name === 'read_system_variables'
            ? this.readSystemVariablesTool(request.arguments)
            : request.name === 'apply_system_variable_changes'
              ? await this.applySystemVariableChangesTool(request.arguments, correlationId)
              : request.name === 'search_skill_marketplace'
                ? await this.skillMarketplace.search(isObject(request.arguments) ? request.arguments : {})
                : request.name === 'preview_skill_marketplace'
                  ? await this.skillMarketplace.preview(isObject(request.arguments) ? request.arguments : {})
                  : request.name === 'list_installed_skills'
                    ? { items: this.skillMarketplace.installed() }
                    : request.name === 'request_skill_install'
                      ? await this.requestSkillInstall(request.arguments, correlationId)
                      : request.name === 'request_skill_uninstall'
                        ? this.requestSkillUninstall(request.arguments, correlationId)
                        : this.readSkillResourceArguments(request.arguments, correlationId, request.authorization?.projection.execution)
      return {
        id: request.id,
        name: request.name,
        ok: true,
        output,
        startedAt,
        completedAt: now(),
        durationMs: Date.now() - started,
      }
    } catch (error) {
      return {
        id: request.id,
        name: request.name,
        ok: false,
        error: {
          code: error instanceof CommandError && error.code === 'FORBIDDEN' ? 'PERMISSION_DENIED' : 'INVALID_ARGUMENTS',
          message: error instanceof Error ? error.message : String(error),
        },
        startedAt,
        completedAt: now(),
        durationMs: Date.now() - started,
      }
    }
  }

  private async manageApplicationTool(request: ToolCallRequest): Promise<JsonObject> {
    if (!this.applicationHost) throw new Error('application runtime host is not configured')
    if (!isObject(request.arguments) || typeof request.arguments.action !== 'string') {
      throw new Error('manage_application requires an action')
    }
    const action = request.arguments.action
    if (!['start', 'stop', 'restart', 'update', 'rollback', 'health_check'].includes(action)) {
      throw new Error(`unsupported application action: ${action}`)
    }
    const result = await this.applicationHost({
      action: action as RuntimeApplicationHostRequest['action'],
      ...(typeof request.arguments.app_id === 'string' ? { appId: request.arguments.app_id } : {}),
      ...(typeof request.arguments.instance_id === 'string' ? { instanceId: request.arguments.instance_id } : {}),
      ...(typeof request.arguments.target_version_id === 'string' ? { targetVersionId: request.arguments.target_version_id } : {}),
      ...(typeof request.arguments.reason === 'string' ? { reason: request.arguments.reason } : {}),
      projectPath: this.projectDir,
      ...(this.run.runId ? { runId: this.run.runId } : {}),
      stepId: request.id,
      callId: request.id,
    })
    if (!result.ok) throw new Error(result.error?.message ?? 'application runtime action failed')
    return toJsonValue(result.output ?? result) as JsonObject
  }

  private childBinding(): ChildBinding {
    if (!this.sessionId || !this.run.runId) throw new Error('CHILD_REQUIRES_ACTIVE_PARENT')
    return { sessionId: this.sessionId, taskId: this.taskControl.taskId, runId: this.run.runId }
  }

  private submitBranchEvidence(args: unknown, correlationId: string): JsonObject {
    if (!isObject(args) || Object.keys(args).some(key => !['request_id', 'candidate_id', 'recall_id'].includes(key))
      || typeof args.request_id !== 'string' || typeof args.candidate_id !== 'string'
      || (args.recall_id !== undefined && typeof args.recall_id !== 'string')) throw new Error('BRANCH_EVIDENCE_ARGUMENTS_INVALID')
    const binding = this.waitBinding()
    const document = this.contextDocumentEngine.snapshot()
    const candidate = document.candidates.find(item => item.id === args.candidate_id && ['pending', 'accepted', 'conflict'].includes(item.status))
    if (!candidate) throw new Error('BRANCH_EVIDENCE_CANDIDATE_UNKNOWN')
    const kind = candidate.source.actor
    if (kind !== 'tool' && kind !== 'memory' && kind !== 'child-agent') throw new Error('BRANCH_EVIDENCE_SOURCE_MISMATCH')
    if (kind !== 'memory' && args.recall_id !== undefined) throw new Error('BRANCH_EVIDENCE_ARGUMENTS_INVALID')
    const rawId = candidate.rawArtifactId
    const commits = this.projectContextStore.commits
    const data: JsonObject = { candidateId: candidate.id, rawArtifactId: rawId, evidenceRefs: candidate.evidenceRefs }
    if (kind === 'tool') {
      const observation = this.observations.find(item => item.id === candidate.source.sourceId && item.runId === binding.runId
        && item.status === 'completed' && item.resultArtifactId === rawId)
      const original = this.artifacts.get(rawId)
      if (!observation || !original || !document.evidence.some(item => candidate.evidenceRefs.includes(item.id)
        && item.referenceId === rawId && item.sourceHash === original.meta.hash)) throw new Error('BRANCH_TOOL_EVIDENCE_UNVERIFIED')
      commits.saveArtifactSource(binding.sessionId, original.meta, typeof original.value === 'string' ? original.value : JSON.stringify(original.value, null, 2))
      data.sourceHash = original.meta.hash
    } else if (kind === 'memory') {
      const recall = typeof args.recall_id === 'string' ? commits.loadRecall(binding.sessionId, args.recall_id) : undefined
      const match = recall?.candidates.find(item => item.id === candidate.id && item.rawArtifactId === rawId
        && capabilityHash(item.evidenceRefs) === capabilityHash(candidate.evidenceRefs))
      if (!match) throw new Error('BRANCH_RECALL_EVIDENCE_UNVERIFIED')
      data.recallId = args.recall_id as string
    } else {
      const child = this.getChildService().store.load(this.childBinding(), candidate.source.sourceId)
      const original = commits.readArtifactSource(rawId, binding.sessionId)
      if (child.resultArtifactId !== rawId || !child.packet || !original || capabilityHash(child.packet) !== child.resultHash
        || !document.evidence.some(item => candidate.evidenceRefs.includes(item.id)
          && item.referenceId === rawId && item.sourceHash === original.meta.hash)) throw new Error('BRANCH_CHILD_EVIDENCE_UNVERIFIED')
      data.sourceHash = original.meta.hash
      data.resultHash = child.resultHash
    }
    const result = this.getWaitStore().supplyEvidence(binding, args.request_id, kind, data)
    this.waits = this.getWaitStore().read(binding)
    this.snapshotRevision++
    this.emit('runtime.wait.signal.recorded', result, correlationId)
    this.emit('runtime.waits.updated', clone(this.waits), correlationId)
    this.scheduleWaitCheck()
    return { requestId: args.request_id, sourceKind: kind, candidateId: candidate.id, signalId: result.signal.id, duplicate: result.duplicate }
  }

  private childView(record: ChildRecord): import('#protocol/runtime-protocol').RuntimeChildSession {
    return { id: record.id, parentSessionId: record.parentSessionId, parentTaskId: record.parentTaskId, parentRunId: record.parentRunId,
      ...(record.spec.assignment ? { planTaskId: record.spec.assignment.planTaskId } : {}),
      ...(record.takeover ? { takeover: record.takeover } : {}),
      childSessionId: record.childSessionId, ...(record.childRunId ? { childRunId: record.childRunId } : {}), goal: record.goal,
      status: record.status, revision: record.revision, deadlineAt: record.deadlineAt, sourceInstructionId: record.callId,
      ...(record.startedAt ? { startedAt: record.startedAt } : {}), ...(record.completedAt ? { completedAt: record.completedAt } : {}),
      ...(record.resultHash ? { resultHash: record.resultHash } : {}), ...(record.waitRef ? { waitRef: record.waitRef } : {}),
      ...(record.actionReceipts?.length ? { actionReceipts: record.actionReceipts } : {}),
      ...(record.error ? { error: record.error } : {}), ...(record.consumption ? { consumption: record.consumption } : {}),
      ...(record.resultArtifactId ? { resultArtifactId: record.resultArtifactId } : {}),
      ...(record.question ? { question: record.question } : {}), ...(record.inputRequestId ? { inputRequestId: record.inputRequestId } : {}) }
  }

  private getChildService(): RuntimeChildService {
    if (this.childAgentMode) throw new Error('CHILD_CANNOT_CONTROL_PARENT_JOBS')
    return this.childService ??= new RuntimeChildService(this.projectDir, worker => this.runChildAgent(worker), record => {
      if (this.closed) return
      this.childRecords.set(record.id, record)
      this.runtimeActivityState.upsertChild(this.childView(record))
      if (this.run.runId && this.sessionId) this.reconcileChildAssignments()
      this.snapshotRevision++
      this.emit('runtime.children.updated', this.runtimeActivityState.snapshot().children, record.callId)
    }, error => { if (!this.closed) this.createArtifact('runtime-error', 'Child control failure', { message: error instanceof Error ? error.message : String(error) }, 'child-controller') })
  }

  private childStatus(record: ChildRecord): JsonObject {
    return toJsonValue({ ...this.childView(record), requiresConsumption: !record.consumption || record.consumption.decision === 'needs_more_evidence',
      budget: { modelRounds: record.modelRounds, maxModelRounds: record.spec.maxModelRounds, reservedTokens: record.chargedTokens, maxTotalTokens: record.spec.maxTotalTokens },
      input_request_id: record.inputRequestId ?? null }) as JsonObject
  }

  /** Refresh scheduler ownership at a round boundary, after the preceding tool group has settled. */
  private reconcileChildAssignments(): void {
    const assignments = new Map<string, RuntimeChildAssignment>()
    let savedPlan: RuntimeTaskControl | undefined
    if (!this.childAgentMode && this.childService && this.run.runId && this.sessionId) {
      for (const job of this.childService.store.list(this.childBinding())) {
        const assignment = childAssignment(job)
        if (assignment) assignments.set(assignment.planTaskId, assignment)
        const plan = job.takeoverPlan ?? job.spec.assignment?.plan
        if (plan && plan.planRevision > (savedPlan?.planRevision ?? 0)) savedPlan = plan
      }
    }
    if (savedPlan && savedPlan.planRevision > this.taskControl.planRevision) {
      const stateRevision = Math.max(this.taskControl.stateRevision, savedPlan.stateRevision)
      this.taskControl = { ...clone(savedPlan), stateRevision: stateRevision + 1 }
      this.snapshotRevision++
    }
    if ([...assignments.keys()].some(id => !this.taskControl.tasks.some(node => node.id === id))) throw new Error('CHILD_PLAN_BINDING_LOST')
    const latest = [...assignments.values()]
    if (capabilityHash(this.taskControl.childAssignments ?? []) === capabilityHash(latest)) return
    if (latest.length) this.taskControl.childAssignments = latest
    else delete this.taskControl.childAssignments
    this.taskControl.stateRevision++
    this.snapshotRevision++
  }

  private async delegateTaskTool(request: ToolCallRequest, stepId: string): Promise<JsonObject> {
    if (this.childAgentMode || !this.childAgentEnabled) throw new Error('child delegation is not enabled for this role')
    const args = request.arguments
    const allowed = new Set(['goal', 'prompt', 'mode', 'execution_mode', 'plan_task_id', 'timeout_ms', 'capability_ids', 'max_model_rounds', 'max_tool_rounds', 'max_total_tokens'])
    if (!isObject(args) || Object.keys(args).some(key => !allowed.has(key)) || typeof args.goal !== 'string' || !args.goal.trim() || args.goal.length > 200
      || typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 10000 || (args.mode !== undefined && !['async', 'sync'].includes(String(args.mode)))
      || (args.execution_mode !== undefined && !['readonly', 'action'].includes(String(args.execution_mode)))) throw new Error('delegate_task requires a bounded goal, prompt and valid mode')
    const bounded = (key: string, fallback: number, min: number, max: number): number => {
      const value = args[key] ?? fallback
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`invalid child ${key}`)
      return value
    }
    if (!request.authorization) throw new Error('CHILD_DELEGATION_AUTHORIZATION_REQUIRED')
    const projection = request.authorization.projection
    const delegation = projection.bindings.find(capability => capability.name === 'delegate_task')
    if (!delegation) throw new Error('CHILD_DELEGATION_AUTHORIZATION_REQUIRED')
    const active = new Set(projection.execution.activeTaskIds)
    const eligible = this.taskControl.tasks.filter(node => active.has(node.id)
      && (node.capabilityIds.includes(delegation.capabilityId) || node.capabilityIds.includes(delegation.name)))
    const node = args.plan_task_id !== undefined ? eligible.find(node => node.id === args.plan_task_id) : eligible.length === 1 ? eligible[0] : undefined
    if ((this.taskControl.tasks.length || args.plan_task_id !== undefined) && !node) throw new Error('CHILD_PLAN_TASK_NOT_ACTIVE_OR_AMBIGUOUS')
    const executionMode = args.execution_mode === 'action' ? 'action' : 'readonly'
    const childOptions = projection.bindings.filter(capability => capability.name !== 'delegate_task'
      && (executionMode === 'action' || (capability.sideEffects === 'none'
        && !capability.permissions.some(permission => ['filesystem:write', 'filesystem:delete', 'process:execute'].includes(permission))))
      && (!node || capability.source !== 'system' || executionMode === 'action' || CHILD_READABLE_RESOURCE_TOOLS.has(capability.name)))
    const readable = childOptions.filter(capability => !node
      || node.capabilityIds.includes(capability.capabilityId) || node.capabilityIds.includes(capability.name))
    const requested = args.capability_ids ?? readable.map(capability => capability.capabilityId)
    if (executionMode === 'action' && args.capability_ids === undefined) throw new Error('CHILD_ACTION_CAPABILITIES_REQUIRED')
    if (!Array.isArray(requested) || requested.length > 64 || requested.some(id => typeof id !== 'string') || new Set(requested).size !== requested.length) throw new Error('CHILD_CAPABILITIES_INVALID')
    const capabilities = requested.map(id => {
      const capability = readable.find(capability => capability.name === id || capability.capabilityId === id)
      if (!capability) {
        const registered = node && childOptions.find(candidate => candidate.name === id || candidate.capabilityId === id)
        const amendment = registered && node
          ? ` Submit propose_plan with planProposal:null and planAmendment ${JSON.stringify({ basePlanRevision: projection.execution.planRevision,
            updateTasks: [{ id: node.id, addCapabilityIds: [registered.capabilityId] }] })}. After acceptance, retry the delegated action alone.`
          : executionMode === 'action' ? ' Use only explicitly granted action capabilities from the current plan node.' : ' Use the current stage catalog and assigned node to check eligible read-only capabilities.'
        throw new Error(`CHILD_CAPABILITY_NOT_GRANTED: ${String(id)}. The node's current child grants are ${JSON.stringify(readable.map(grant => grant.capabilityId))}.${amendment}`)
      }
      return capability
    })
    const capabilityIds = [...new Set(capabilities.map(capability => capability.capabilityId))]
    const current = node && capabilities.length ? selectRuntimeCapabilities(this.taskControl, this.availableToolCapabilities()).map(runtimeCapabilityBinding) : []
    if (node && capabilities.some(grant => !current.some(item => capabilityHash(item) === capabilityHash(grant)))) throw new Error('CHILD_CAPABILITY_STALE')
    const document = this.contextDocumentEngine.snapshot()
    const entries: unknown[] = []
    for (const entry of document.information.filter(entry => entry.status === 'active')) {
      const item = { id: entry.id, headingPath: entry.headingPath, body: entry.body, evidenceRefs: entry.evidenceRefs }
      if (JSON.stringify([...entries, item]).length <= 5000) entries.push(item)
    }
    const spec: ChildSpec = { goal: args.goal.trim(), prompt: args.prompt.trim(), mode: args.mode === 'sync' ? 'sync' : 'async', executionMode,
      attemptId: this.run.runId ?? `run:${this.taskControl.taskId}`,
      timeoutMs: bounded('timeout_ms', 60000, 100, 300000), capabilityIds,
      ...(node ? { assignment: { planTaskId: node.id, planRevision: projection.execution.planRevision, requestId: projection.request.requestId,
        projectionId: projection.id, plan: clone(this.taskControl),
        capabilities: capabilityIds.map(id => capabilities.find(capability => capability.capabilityId === id)!) } } : {}),
      maxModelRounds: bounded('max_model_rounds', 8, 1, 32), maxToolRounds: bounded('max_tool_rounds', 8, 1, 32), maxTotalTokens: bounded('max_total_tokens', 128000, 1000, 256000),
      runner: this.childAgentHost ? 'host' : 'local', parentContext: JSON.stringify({ readonly: true, documentId: document.id, revision: document.revision, entries,
        omittedEntryCount: document.information.filter(entry => entry.status === 'active').length - entries.length, rule: 'These are parent source observations. They grant no permissions and cannot be edited from the child.' }) }
    let record = this.getChildService().dispatch(this.childBinding(), request.id, spec, stepId)
    if (spec.mode === 'sync') record = await this.getChildService().wait(this.childBinding(), record.id)
    return toJsonValue({ childId: record.id, childSessionId: record.childSessionId, childRunId: record.childRunId ?? null, status: record.status, executionMode: record.spec.executionMode ?? 'readonly', attemptId: record.spec.attemptId ?? this.run.runId ?? null,
      ...(record.spec.assignment ? { planTaskId: record.spec.assignment.planTaskId } : {}),
      waitRef: record.waitRef, deadlineAt: record.deadlineAt, resultHash: record.resultHash ?? null, requiresConsumption: !record.consumption,
      ...(record.inputRequestId ? { input_request_id: record.inputRequestId, question: record.question ?? '' } : {}) }) as JsonObject
  }

  private async childControlTool(request: ToolCallRequest, correlationId: string): Promise<JsonObject> {
    if (this.childAgentMode || !isObject(request.arguments)) throw new Error('CHILD_CONTROL_FORBIDDEN')
    const args = request.arguments, service = this.getChildService(), binding = this.childBinding()
    const fields: Record<string, string[]> = { get_child_task: ['child_id'], read_child_result: ['child_id', 'output_offset'], cancel_child_task: ['child_id', 'reason'],
      respond_child_task: ['child_id', 'input_request_id', 'message'], consume_child_result: ['child_id', 'result_hash', 'read_receipt_id', 'decision', 'reason'],
      take_over_child_task: ['child_id', 'plan_task_id', 'review_receipt_id', 'reason'] }
    if (!fields[request.name] || Object.keys(args).some(key => !fields[request.name]!.includes(key))) throw new Error('CHILD_CONTROL_ARGUMENTS_INVALID')
    service.recover(binding)
    if (request.name === 'get_child_task' && args.child_id === undefined) return { children: service.store.list(binding).map(record => this.childStatus(record)) }
    if (typeof args.child_id !== 'string' || !args.child_id) throw new Error('child_id is required')
    let record = service.store.load(binding, args.child_id)
    if (request.name === 'get_child_task') return this.childStatus(record)
    if (request.name === 'cancel_child_task') {
      if (typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 1000) throw new Error('child cancellation requires a bounded reason')
      const cancelled = service.cancel(binding, record.id, args.reason)
      return toJsonValue({ childId: cancelled.id, status: cancelled.status, resultHash: cancelled.resultHash, waitRef: cancelled.waitRef, abortRequestedAt: cancelled.abortRequestedAt }) as JsonObject
    }
    if (request.name === 'respond_child_task') {
      if (typeof args.input_request_id !== 'string' || typeof args.message !== 'string' || !args.message.trim() || args.message.length > 10000) throw new Error('child input requires input_request_id and a bounded message')
      service.respond(binding, record.id, args.input_request_id, args.message)
      const resumed = service.store.load(binding, record.id)
      return toJsonValue({ childId: resumed.id, status: resumed.status, waitRef: resumed.waitRef, inputDelivered: true }) as JsonObject
    }
    const modelRequestId = request.authorization?.projection.request.requestId
    if (!modelRequestId) throw new Error('CHILD_REVIEW_AUTHORIZATION_REQUIRED')
    if (request.name === 'take_over_child_task') {
      if (typeof args.plan_task_id !== 'string' || typeof args.review_receipt_id !== 'string' || typeof args.reason !== 'string') throw new Error('CHILD_TAKEOVER_ARGUMENTS_INVALID')
      record = service.store.takeover(binding, { childId: record.id, planTaskId: args.plan_task_id, reviewReceiptId: args.review_receipt_id,
        callId: request.id, requestId: modelRequestId, reason: args.reason }, this.taskControl)
      this.childRecords.set(record.id, record); this.runtimeActivityState.upsertChild(this.childView(record)); this.snapshotRevision++
      this.emit('runtime.children.updated', this.runtimeActivityState.snapshot().children, correlationId)
      return { takeover: toJsonValue(record.takeover) }
    }
    if (request.name === 'consume_child_result') {
      if (typeof args.result_hash !== 'string' || typeof args.read_receipt_id !== 'string' || typeof args.reason !== 'string'
        || !['accept', 'reject', 'conflict', 'needs_more_evidence'].includes(String(args.decision))) throw new Error('invalid child review')
      record = service.store.consume(binding, { childId: record.id, resultHash: args.result_hash, readReceiptId: args.read_receipt_id, requestId: modelRequestId,
        decision: args.decision as 'accept' | 'reject' | 'conflict' | 'needs_more_evidence', reason: args.reason })
      this.childRecords.set(record.id, record); this.runtimeActivityState.upsertChild(this.childView(record)); this.snapshotRevision++
      this.emit('runtime.children.updated', this.runtimeActivityState.snapshot().children, correlationId)
      return { childId: record.id, status: record.status, result_hash: record.resultHash!, reviewReceipt: toJsonValue(record.consumption),
        ...(record.spec.assignment ? { planTaskId: record.spec.assignment.planTaskId } : {}) }
    }
    if (!terminalChild(record.status) || !record.resultHash || !record.packet) throw new Error('CHILD_RESULT_PENDING')
    if (capabilityHash(record.packet) !== record.resultHash) throw new Error('CHILD_RESULT_SOURCE_MISSING_OR_CHANGED')
    const rawOutput = typeof record.output === 'string' ? record.output : JSON.stringify(record.output ?? record.error ?? null)
    const outputOffset = args.output_offset ?? 0
    if (typeof outputOffset !== 'number' || !Number.isSafeInteger(outputOffset) || outputOffset < 0 || outputOffset > rawOutput.length) {
      throw new Error('output_offset must be within the child result text')
    }
    if (record.resultArtifactId && !this.artifacts.has(record.resultArtifactId)) {
      const original = this.projectContextStore.commits.readArtifactSource(record.resultArtifactId, binding.sessionId)
      if (!original) throw new Error('CHILD_RESULT_SOURCE_MISSING')
      this.artifacts.set(original.meta.id, { meta: original.meta, value: JSON.parse(original.body) })
      this.artifactItems.push(original.meta); this.artifactRevision++; this.snapshotRevision++
    }
    let source = [...this.artifacts.values()].find(artifact => isObject(artifact.value) && artifact.value.kind === 'child-result-package' && artifact.value.childId === record.id && artifact.value.resultHash === record.resultHash)?.meta
    if (!source) source = this.createArtifact('tool-result', `Child result package · ${record.id}`, { kind: 'child-result-package', childId: record.id, resultHash: record.resultHash, packet: record.packet }, correlationId)
    this.projectContextStore.commits.saveArtifactSource(binding.sessionId, source, JSON.stringify(this.artifacts.get(source.id)!.value, null, 2))
    record = service.store.linkArtifact(binding, record.id, record.resultHash, source.id)
    this.childRecords.set(record.id, record); this.runtimeActivityState.upsertChild(this.childView(record)); this.snapshotRevision++
    this.emit('runtime.children.updated', this.runtimeActivityState.snapshot().children, correlationId)
    const before = this.contextDocumentEngine.exportState()
    let candidate = before.document.candidates.find(item => item.source.actor === 'child-agent' && item.source.sourceId === record.id && item.rawArtifactId === source!.id
      && item.evidenceRefs.some(id => before.document.evidence.some(evidence => evidence.id === id && evidence.referenceId === source!.id && evidence.sourceHash === source!.hash)))
    if (!candidate) {
      const evidence = this.contextDocumentEngine.addEvidence({ kind: 'artifact', referenceId: source.id, sessionId: binding.sessionId, sourceHash: source.hash, observedAt: record.completedAt })
      candidate = this.contextDocumentEngine.mergeChildCandidate({ sourceId: record.id, ...(record.childRunId ? { runId: record.childRunId } : {}), rawArtifactId: source.id,
        normalizedContent: `子代理来源材料（候选，${record.status}${rawOutput.length > 1000 ? '，以下为节选，全文见原件' : ''}）：\n${rawOutput.slice(0, 1000)}`, evidenceRefs: [evidence.id] })
      this.persistSessionContext(before)
    }
    const localEvidence = this.localChildActionReceipts(record)
    const outputEnd = Math.min(rawOutput.length, outputOffset + 1000)
    const view = { childId: record.id, status: record.status, result_hash: record.resultHash!,
      ...(record.spec.assignment ? { planTaskId: record.spec.assignment.planTaskId } : {}),
      ...(localEvidence ? { local_evidence: localEvidence } : {}),
      output_excerpt: rawOutput.slice(outputOffset, outputEnd), partial_view: outputOffset > 0 || outputEnd < rawOutput.length,
      output_offset: outputOffset, output_next_offset: outputEnd < rawOutput.length ? outputEnd : null, output_total_characters: rawOutput.length,
      rawArtifactId: source.id, candidateId: candidate.id,
      sourceRule: 'local_evidence 可核对实际动作。继续看子交付正文用 read_child_result 和 output_next_offset，工作包用于追溯。' }
    const issueRead = (modelView: object) => {
      const receiptId = service.store.issueRead(binding, record.id, modelRequestId, capabilityHash(modelView))
      this.childRecords.set(record.id, service.store.load(binding, record.id))
      return toJsonValue({ ...modelView, read_receipt_id: receiptId }) as JsonObject
    }
    if (!this.contextAssistantEnabled('parent_merge')) return issueRead(view)
    const original = this.projectContextStore.commits.readArtifactSource(source.id, binding.sessionId)
    if (!original || original.meta.hash !== source.hash) throw new Error('CHILD_RESULT_SOURCE_MISSING_OR_CHANGED')
    const mergeId = capabilityHash({ candidateId: candidate.id, result: record.resultHash, requestId: modelRequestId })
    const documents = this.contextAssistantDocuments(mergeId, [candidate.id])
    const sourceData = { childId: record.id, childSessionId: record.childSessionId, childRunId: record.childRunId, status: record.status,
      resultHash: record.resultHash, artifactId: source.id, sourceHash: source.hash, candidateId: candidate.id,
      output: rawOutput.slice(0, 3000), partial: rawOutput.length > 3000, evidenceRefs: candidate.evidenceRefs }
    const review = await this.invokeContextAssistant('parent_merge', `parent-merge:${mergeId}`, correlationId, {
      ...documents, childCandidateId: candidate.id, projectFrozen: true,
      sourceIds: [record.id, source.id, ...candidate.evidenceRefs], visibleSources: sourceData, taskSignals: this.contextAssistantTaskSignals(),
    }, this.activeAbortController?.signal)
    return issueRead({ ...view, mergeAdvice: { rawArtifactId: review.artifactId,
      candidateDiffCount: review.output?.candidateDiffs?.length ?? 0, evidenceRequestCount: review.output?.evidenceRequests?.length ?? 0, failure: review.failure } })
  }

  private localChildActionReceipts(record: ChildRecord): JsonObject | undefined {
    const evidence = isObject(record.packet) ? record.packet.evidence : undefined
    if (record.spec.runner !== 'local' || record.status !== 'succeeded' || !record.childRunId || !isObject(evidence)
      || evidence.childId !== record.id || evidence.sessionId !== record.childSessionId || evidence.runId !== record.childRunId
      || evidence.runStatus !== 'completed'
      || !Array.isArray(evidence.timeline) || !Array.isArray(evidence.observations) || !Array.isArray(evidence.artifacts)) return
    const artifacts = new Map<string, Record<string, unknown>>()
    for (const artifact of evidence.artifacts) {
      if (isObject(artifact) && typeof artifact.id === 'string') artifacts.set(artifact.id, artifact)
    }
    const successfulSteps = new Map<string, Record<string, unknown>>()
    for (const step of evidence.timeline) {
      if (isObject(step) && typeof step.id === 'string' && step.type === 'tool' && step.status === 'success'
        && isObject(step.detail) && step.detail.ok === true) successfulSteps.set(step.id, step.detail)
    }
    const actions = evidence.observations.flatMap(observation => {
      if (!isObject(observation) || observation.status !== 'completed') return []
      const { callId, stepId, toolName, resultArtifactId } = observation
      if (typeof callId !== 'string' || typeof stepId !== 'string' || typeof toolName !== 'string' || typeof resultArtifactId !== 'string') return []
      const detail = successfulSteps.get(stepId)
      if (detail?.callId !== callId || detail.toolName !== toolName || detail.resultArtifactId !== resultArtifactId) return []
      const artifact = artifacts.get(resultArtifactId)
      if (!artifact || artifact.runId !== record.childRunId || artifact.stepId !== stepId
        || typeof artifact.hash !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.hash)) return []
      const fullPreview = artifact.redacted === false && typeof artifact.preview === 'string' && artifact.preview.length <= 640
        && Buffer.byteLength(artifact.preview) === artifact.byteLength
        && createHash('sha256').update(artifact.preview).digest('hex') === artifact.hash ? artifact.preview : undefined
      return [{ callId, stepId, toolName, completionActionRef: `call:${callId}`, resultArtifactId, resultHash: artifact.hash,
        ...(fullPreview !== undefined ? { resultPreview: fullPreview } : {}) }]
    })
    if (actions.length) return { runId: record.childRunId, actionCount: actions.length, actions: actions.slice(-8) }
  }

  private async runChildAgent(worker: ChildWorker): Promise<RuntimeChildAgentResult> {
    const job = worker.record
    worker.assertAuthority()
    if (job.spec.runner === 'host') {
      if (!this.childAgentHost) return { ok: false, error: { code: 'CHILD_HOST_UNAVAILABLE', message: 'The registered child host is unavailable for dispatch' } }
      return this.childAgentHost({ goal: job.spec.goal, prompt: job.spec.prompt, projectPath: this.projectDir,
        parentSessionId: job.parentSessionId, parentTaskId: job.parentTaskId, parentRunId: job.parentRunId,
        ...(job.parentStepId ? { parentStepId: job.parentStepId } : {}), callId: job.callId, childId: job.id, childSessionId: job.childSessionId,
        parentContext: job.spec.parentContext,
        ...(job.spec.assignment ? { planTaskId: job.spec.assignment.planTaskId, allowedCapabilities: job.spec.assignment.capabilities } : {}),
        executionMode: job.spec.executionMode ?? 'readonly', attemptId: job.spec.attemptId,
        maxModelRounds: job.spec.maxModelRounds, maxToolRounds: job.spec.maxToolRounds, maxTotalTokens: job.spec.maxTotalTokens,
        authorizeAction: worker.authorizeAction,
        recordActionResult: worker.recordActionResult,
        signal: worker.signal, allowedCapabilityIds: job.spec.capabilityIds, llm: this.meteredLlm('child_host', worker.llm(this.llm), {
          actorSessionId: job.childSessionId, scope: { sessionId: job.parentSessionId, taskId: job.parentTaskId, runId: job.parentRunId },
          assertAuthority: worker.assertAuthority,
        }) })
    }
    const childLoop = new RuntimeLoop({ projectDir: this.projectDir, workspaceDir: this.workspaceDir, systemDir: this.systemDir,
      sessionId: job.childSessionId, ...(worker.checkpoint ? { initialState: worker.checkpoint } : {}), streamDelayMs: this.streamDelayMs, stepDelayMs: this.stepDelayMs,
      llm: worker.llm(this.llm), childAgentMode: true, skillMarketplace: this.skillMarketplace, modelBudget: { ...this.modelBudgetLimits, countTokens: this.modelBudgetOptions?.countTokens },
      contextOrganization: { enabled: this.contextOrganization.enabled, minGroups: this.contextOrganization.minGroups, chunkCharacters: this.contextOrganization.chunkCharacters },
      contextAssistant: { ...this.contextAssistant, llm: worker.llm(this.contextProcessingLlm()) },
      childExecution: { childId: job.id, parent: { sessionId: job.parentSessionId, taskId: job.parentTaskId, runId: job.parentRunId }, capabilityIds: job.spec.capabilityIds,
        assignment: job.spec.assignment, parentContext: job.spec.parentContext, maxToolRounds: job.spec.maxToolRounds,
        executionMode: job.spec.executionMode ?? 'readonly', attemptId: job.spec.attemptId, assertAuthority: worker.assertAuthority,
        authorizeAction: worker.authorizeAction, recordActionResult: worker.recordActionResult } })
    this.activeChildLoops.add(childLoop)
    try {
      for (const id of job.spec.capabilityIds) if (id.startsWith('mcp:')) childLoop.mcpActiveToolIds.add(id)
      for (const tool of childLoop.toolCatalog) if (job.spec.capabilityIds.includes(tool.id)
        && ((job.spec.executionMode ?? 'readonly') === 'action' || ((tool.sideEffects ?? 'none') === 'none'
          && !(tool.permissions ?? []).some(permission => ['filesystem:write', 'filesystem:delete', 'process:execute'].includes(permission))))
        && !childLoop.tools.items.some(active => active.id === tool.id)) childLoop.attachTool(tool.id, job.id)
      return await new Promise<RuntimeChildAgentResult>(resolve => {
        let settled = false, unsubscribe = () => {}
        const finish = (result: RuntimeChildAgentResult) => { if (settled) return; settled = true; unsubscribe(); worker.signal.removeEventListener('abort', abort); resolve(result) }
        const abort = () => { finish({ ok: false, error: { code: 'CHILD_ABORTED', message: 'Child dispatch stopped by the parent controller' } }); childLoop.close() }
        worker.signal.addEventListener('abort', abort, { once: true })
        const observe = () => {
          if (settled || worker.signal.aborted) return
          const state = childLoop.exportState(), control = state.contextControl
          const rootWaiting = ['awaiting_user', 'awaiting_evidence', 'waiting'].includes(control?.status ?? '')
          const scopedWaiting = state.taskControl?.branchPaused && state.taskControl.branchBlocks?.length
          const waiting = state.snapshot.run.status === 'paused' && (rootWaiting || scopedWaiting)
          const branchInput = waiting && !rootWaiting
            ? state.taskControl?.branchBlocks?.find(block => childLoop.pendingBranchHuman(block.id))
            : undefined
          worker.progress(state, waiting ? { question: branchInput ? branchInput.reason : control?.question ?? control?.evidenceRequests.map(item => item.question).join('\n'),
            ...(branchInput ? { inputRequestId: branchInput.id }
              : ['awaiting_user', 'awaiting_evidence'].includes(control?.status ?? '') ? { inputRequestId: control?.humanRequestId ?? control?.requestId } : {}) } : undefined)
          if (state.snapshot.run.status === 'completed') {
            const assistant = [...state.snapshot.conversation.messages].reverse().find(message => message.role === 'assistant' && message.status === 'completed')
            finish({ ok: true, output: assistant?.content.map(part => part.text).join('') ?? '', evidence: this.childEvidencePackage(childLoop, job.id) })
          } else if (['failed', 'cancelled'].includes(state.snapshot.run.status)) finish({ ok: false, error: { code: 'CHILD_RUN_FAILED', message: state.snapshot.run.failure?.message ?? state.snapshot.run.status }, evidence: this.childEvidencePackage(childLoop, job.id) })
        }
        worker.respond((inputRequestId, message) => {
          const state = childLoop.exportState(), control = state.contextControl
          const branchInput = childLoop.pendingBranchHuman(inputRequestId)
          if ((!branchInput && (control?.humanRequestId ?? control?.requestId) !== inputRequestId) || state.snapshot.run.status !== 'paused') throw new Error('CHILD_INPUT_BINDING_MISMATCH')
          const command: ClientCommand = { version: 1, kind: 'command', id: `child-input-${randomUUID()}`, type: 'chat.message.send', sessionId: job.childSessionId, timestamp: now(),
            payload: { clientMessageId: `child-input-${randomUUID()}`, content: [{ type: 'text', text: message }], autoStart: true,
              ...(branchInput ? { humanRequestId: branchInput.id } : control?.status === 'awaiting_user' && control.humanRequestId ? { humanRequestId: control.humanRequestId } : {}) } }
          childLoop.validate(command); childLoop.execute(command, 1)
        })
        unsubscribe = childLoop.onEvent(event => {
          if (settled) return
          if (!this.closed && !worker.signal.aborted && ['timeline.step.upserted', 'tool.call.started', 'tool.call.completed', 'tool.call.failed', 'runtime.observation.upserted', 'runtime.processes.updated', 'runtime.artifact.created', 'runtime.status.updated', 'chat.assistant.delta'].includes(event.type)) {
            this.publish({ ...event, parentTurnId: job.parentRunId, correlationId: job.callId } as ChannelEvent)
          }
          if (['run.state.changed', 'runtime.checkpoint.created', 'tool.call.completed', 'tool.call.failed', 'runtime.snapshot'].includes(event.type)) observe()
        })
        try {
          if (worker.checkpoint) {
            observe()
            const state = childLoop.exportState()
            if (!settled && !state.taskControl?.branchPaused && !['awaiting_user', 'awaiting_evidence', 'waiting'].includes(state.contextControl?.status ?? '')
              && ['paused', 'interrupted'].includes(state.snapshot.run.status)) {
              const command: ClientCommand = { version: 1, kind: 'command', id: `child-resume-${randomUUID()}`, type: 'run.resume', sessionId: job.childSessionId, timestamp: now(), payload: {} }
              childLoop.validate(command); childLoop.execute(command, 1)
            }
          } else {
            const command: ClientCommand = { version: 1, kind: 'command', id: `child-start-${job.id}`, type: 'chat.message.send', sessionId: job.childSessionId, timestamp: now(),
              payload: { clientMessageId: `child-task-${job.id}`, content: [{ type: 'text', text: job.spec.prompt }], autoStart: true } }
            childLoop.validate(command); childLoop.execute(command, 1)
          }
          if (worker.signal.aborted) abort()
        } catch (error) { finish({ ok: false, error: { code: 'CHILD_RUN_FAILED', message: error instanceof Error ? error.message : String(error) } }) }
      })
    } finally { this.activeChildLoops.delete(childLoop); await childLoop.shutdown() }
  }

  /**
   * Keep a compact, parent-owned evidence package for nested child runs. The
   * child text is useful to a reader, but it is not independently verifiable
   * unless the parent can also reference the child's tool steps, observations
   * and artifact hashes.
   */
  private childEvidencePackage(childLoop: RuntimeLoop, childId: string): JsonObject {
    const snapshot = childLoop.getSnapshot(0)
    const toolEvents = (snapshot.trace ?? [])
      .filter((event) => ['tool.call.started', 'tool.call.completed', 'tool.call.failed', 'runtime.observation.upserted', 'runtime.artifact.created'].includes(event.type))
      .slice(-200)
      .map((event) => ({
        id: event.id,
        type: event.type,
        timestamp: event.timestamp,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.stepId ? { stepId: event.stepId } : {}),
        payload: toJsonValue(event.payload),
      }))
    const toolSteps = snapshot.timeline.steps
      .filter((step) => step.type === 'tool')
      .map((step) => ({
        id: step.id,
        type: step.type,
        status: step.status,
        summary: step.summary,
        ...(step.startedAt ? { startedAt: step.startedAt } : {}),
        ...(step.completedAt ? { completedAt: step.completedAt } : {}),
        ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
        ...(step.detail ? { detail: toJsonValue(step.detail) } : {}),
      }))
    const observations = snapshot.observations.items.map((observation) => ({
      id: observation.id,
      status: observation.status,
      callId: observation.callId,
      toolName: observation.toolName,
      stepId: observation.stepId,
      ...(observation.resultArtifactId ? { resultArtifactId: observation.resultArtifactId } : {}),
      ...(observation.error ? { error: toJsonValue(observation.error) } : {}),
      ...(observation.startedAt ? { startedAt: observation.startedAt } : {}),
      ...(observation.completedAt ? { completedAt: observation.completedAt } : {}),
      ...(observation.durationMs !== undefined ? { durationMs: observation.durationMs } : {}),
    }))
    const artifacts = snapshot.artifacts.items
      .filter((artifact) => ['tool-result', 'skill-reference', 'skill-script-result', 'workflow-result'].includes(artifact.kind))
      .map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        hash: artifact.hash,
        byteLength: artifact.byteLength,
        preview: artifact.preview,
        redacted: artifact.redacted,
        ...(artifact.runId ? { runId: artifact.runId } : {}),
        ...(artifact.stepId ? { stepId: artifact.stepId } : {}),
      }))
    return {
      evidenceVersion: 1,
      childId,
      sessionId: childLoop.sessionId ?? 'child-session',
      taskId: snapshot.taskControl?.taskId ?? null,
      runId: snapshot.run.runId ?? null,
      runStatus: snapshot.run.status,
      timeline: toolSteps,
      observations,
      artifacts,
      trace: toolEvents,
      verification: {
        instruction: 'Parent must verify child tool results against callId, stepId, observation status and artifact hash before treating them as facts.',
        toolCallCount: toolSteps.length,
        observationCount: observations.length,
        artifactCount: artifacts.length,
      },
    }
  }

  private toolExecutionReceipt(
    step: TimelineStep,
    request: ToolCallRequest,
    result: ToolCallResult,
    resultArtifactId: string,
  ): JsonObject {
    const output = isObject(result.output) ? result.output : undefined
    const capabilityBinding = request.authorization?.projection.bindings.find(binding => binding.name === request.name)
    const activeTaskIds = request.authorization?.projection.execution.activeTaskIds ?? []
    const childReview = request.name === 'read_child_result' || request.name === 'consume_child_result'
    const childAssignment = result.ok && childReview && capabilityBinding?.capabilityId === `runtime:${request.name}` && output
      ? this.taskControl.childAssignments?.find(item => item.childId === output.childId && item.planTaskId === output.planTaskId) : undefined
    const completionPlanTaskIds = childAssignment
      ? [...new Set([childAssignment.planTaskId, ...this.taskControl.tasks.filter(task => activeTaskIds.includes(task.id)
        && task.capabilityIds.some(id => id === request.name || id === capabilityBinding!.capabilityId)).map(task => task.id)])] : undefined
    const readOutput = (key: string): unknown => (
      output && Object.prototype.hasOwnProperty.call(output, key) ? output[key] : undefined
    )
    const timedOut = readOutput('timed_out')
    const exitCode = readOutput('exit_code')
    const signal = readOutput('signal')
    const duration = readOutput('duration_ms')
    const errorDetails = result.error?.details
    const processSettled = readOutput('timed_out') === true
      ? true
      : isObject(errorDetails) && errorDetails.processSettled === true
        ? true
        : undefined
    return {
      receiptVersion: 1,
      kind: 'tool-execution',
      ...(this.run.runId ? { runId: this.run.runId } : {}),
      callId: request.id,
      ...(result.ok && timedOut !== true ? { completionActionRef: `call:${request.id}` } : {}),
      stepId: step.id,
      toolName: request.name,
      status: result.source?.outcome === 'unknown' ? 'unknown' : !result.ok ? 'failed' : timedOut === true ? 'timed_out' : 'succeeded',
      ok: result.ok,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      durationMs: result.durationMs,
      resultArtifactId,
      ...(result.source ? { source: toJsonValue(result.source) } : {}),
      ...(capabilityBinding && request.authorization ? { capabilityBinding: {
        projectionId: request.authorization.projection.id, capabilityId: capabilityBinding.capabilityId,
        sourceVersion: capabilityBinding.sourceVersion, schemaHash: capabilityBinding.schemaHash,
        permissions: [...capabilityBinding.permissions], sideEffects: capabilityBinding.sideEffects, replay: capabilityBinding.replay,
        planRevision: request.authorization.projection.execution.planRevision, phase: request.authorization.projection.execution.phase,
        admittedStateRevision: request.authorization.admittedStateRevision,
      } } : {}),
      ...(activeTaskIds.length ? { activePlanTaskIds: [...activeTaskIds] } : {}),
      ...(completionPlanTaskIds ? { completionPlanTaskIds } : {}),
      ...(request.authorization?.projection.execution.parentTakeover ? { parentTakeover: request.authorization.projection.execution.parentTakeover } : {}),
      ...(timedOut !== undefined ? { timedOut: Boolean(timedOut) } : {}),
      ...(exitCode !== undefined ? { exitCode: toJsonValue(exitCode) } : {}),
      ...(signal !== undefined ? { signal: toJsonValue(signal) } : {}),
      ...(duration !== undefined ? { processDurationMs: toJsonValue(duration) } : {}),
      ...(processSettled !== undefined ? { processSettled } : {}),
      ...(result.error ? { error: toJsonValue(result.error) } : {}),
    }
  }

  private boundedToolContent(artifactId: string, value: unknown): string {
    const text = JSON.stringify(value)
    const budget = Math.max(1024, Math.min(12000, Math.floor(this.availableInputTokens() * 0.05)))
    if (Math.ceil(text.length / 4) <= budget) return text
    return JSON.stringify({
      abbreviated: true, artifact_id: artifactId, total_characters: text.length,
      preview: text.slice(0, Math.floor(budget * 1.5)),
      instruction: 'Full result is preserved. Use read_runtime_artifact with artifact_id, offset and limit to inspect further evidence before concluding.',
    })
  }

  private async recallContextTool(args: unknown, correlationId: string, operationId: string): Promise<JsonObject> {
    if (!isObject(args) || Object.keys(args).some((key) => !['query', 'scope', 'limit', 'source_kind'].includes(key))) {
      throw new Error('recall_context accepts query, scope, limit and source_kind')
    }
    const { source_kind: sourceKind, ...rest } = args
    const query = { ...rest, ...(sourceKind !== undefined ? { sourceKind } : {}) } as unknown as RuntimeContextMemoryRecall
    validateRecallQuery(query)
    const result = this.contextAssistantEnabled('recall') && this.sessionId
      ? await this.selectV2Memory(query, correlationId, operationId)
      : this.recallV2Memory(query, correlationId)
    // The full journal/event keeps inspector metadata; the model needs each body and its bindings once.
    return toJsonValue({ recallId: result.recallId, query: result.query, scope: result.scope, ...(result.sourceKind ? { sourceKind: result.sourceKind } : {}),
      hits: result.hits.map(({ id: _id, excerpt: { truncated, ...range }, ...hit }) => ({
        ...hit, excerpt: { ...range, complete: range.complete ?? (hit.sourceKind === 'source_archive' && hit.candidateId
          ? !result.uncertainties.includes(`excerpt_requires_source_read:${hit.candidateId}`) : !truncated), sourceHasMore: truncated },
      })), uncertainties: result.uncertainties }) as JsonObject
  }

  private readRuntimeArtifactTool(args: unknown, authorization?: ToolCallRequest['authorization']): JsonObject {
    if (!isObject(args) || typeof args.artifact_id !== 'string') throw new Error('artifact_id is required')
    if (Object.keys(args).some((key) => !['artifact_id', 'offset', 'limit', 'source_scope', 'start_line', 'end_line', 'allow_partial'].includes(key))
      || (args.source_scope !== undefined && args.source_scope !== 'session' && args.source_scope !== 'project')) throw new Error('invalid source page arguments')
    const linePage = args.start_line !== undefined || args.end_line !== undefined
    if (args.allow_partial !== undefined && (!linePage || typeof args.allow_partial !== 'boolean')) throw new Error('allow_partial applies to file line pages')
    const { start_line: start, end_line: end } = args
    if (linePage && (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 1
      || typeof end !== 'number' || !Number.isSafeInteger(end) || end < start
      || args.offset !== undefined || args.limit !== undefined)) throw new Error('use both start_line and end_line without offset or limit')
    const offset = args.offset ?? 0
    const limit = args.limit ?? 4000
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0
      || typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 8000) {
      throw new Error('offset must be nonnegative and limit must be between 1 and 8000')
    }
    const artifact = this.artifacts.get(args.artifact_id)
    let sourceSessionId = this.sessionId
    let sourceScope: 'session' | 'project' = 'session'
    let text: string
    let sourceMetadata: JsonObject = {}
    const immutableSource = args.source_scope !== 'project' && this.sessionId ? this.projectContextStore.commits.readArtifactSource(args.artifact_id, this.sessionId) : undefined
    if (immutableSource) {
      text = immutableSource.body
      sourceMetadata = { source_scope: 'session', source_hash: immutableSource.meta.hash, captured_at: immutableSource.meta.createdAt, origin: 'runtime-artifact' }
    } else if (args.source_scope !== 'project' && artifact && ['tool-result', 'workflow-result', 'skill-reference', 'skill-script-result'].includes(artifact.meta.kind)) text = JSON.stringify(artifact.value)
    else {
      const store = this.projectContextStore.commits
      let source = args.source_scope !== 'project' && this.sessionId ? store.readSource(args.artifact_id, this.sessionId) : undefined
      let artifactSource = !source && args.source_scope !== 'project' && this.sessionId ? store.readArtifactSource(args.artifact_id, this.sessionId) : undefined
      const approved = this.projectContextDocumentEngine.snapshot().evidence.filter((item) => item.referenceId === args.artifact_id)
      if (!source && !artifactSource && approved.length && args.source_scope !== 'session') {
        const sourceSessions = [...new Set(approved.flatMap((item) => item.sessionId ? [item.sessionId] : []))]
        if (sourceSessions.length > 1) throw new Error('CONTEXT_PROJECT_SOURCE_ID_AMBIGUOUS')
        source = store.readSource(args.artifact_id, sourceSessions[0]);
        if (!source) artifactSource = store.readArtifactSource(args.artifact_id, sourceSessions[0])
        sourceSessionId = artifactSource?.sessionId ?? sourceSessions[0]
        sourceScope = 'project'
      }
      if (!source && !artifactSource) {
        const modelRequestId = authorization?.projection.request.requestId
        const requestArtifactId = modelRequestId && this.timeline.find(step => step.id === modelRequestId)?.detail?.requestArtifactId
        const modelRequest = typeof requestArtifactId === 'string' ? this.artifacts.get(requestArtifactId) : undefined
        const messages = modelRequest?.meta.kind === 'model-request' && isObject(modelRequest.value) && modelRequest.value.messages
        const sessionId = this.sessionId
        const publishedId = sessionId && Array.isArray(messages) && publishedFileArtifactId(messages as unknown as LlmMessage[],
          args.artifact_id, id => store.readSource(id, sessionId))
        const hint = publishedId ? ` The published read for this path has artifact_id ${JSON.stringify(publishedId)} and source_scope "session".` : ''
        throw new Error(`${ARTIFACT_SOURCE_REFERENCE_DIAGNOSTIC}: authorized original not found. Supply a published original artifact ID, not a file path.${hint} Use visible evidence first, or read a new project file with read_file(file_name) if authorized.`)
      }
      text = artifactSource ? artifactSource.body : source!.rawContent ?? source!.message.content
      const hash = createHash('sha256').update(text).digest('hex')
      if (sourceScope === 'project' && approved.some((item) => item.sourceHash)
        && !approved.some((item) => !item.sourceHash || item.sourceHash === hash || item.sourceHash === (artifactSource ? artifactSource.meta.hash : source!.sourceArtifactMeta?.hash))) throw new Error('CONTEXT_PROJECT_SOURCE_HASH_CONFLICT')
      sourceMetadata = { source_scope: sourceScope, source_hash: hash, captured_at: artifactSource ? artifactSource.meta.createdAt : source!.capturedAt, origin: artifactSource ? 'runtime-artifact' : source!.origin }
    }
    if (linePage && typeof start === 'number' && typeof end === 'number') {
      const read = sourceSessionId && readVerifiedFileArtifact(args.artifact_id, id => this.projectContextStore.commits.readSource(id, sourceSessionId))
      if (!read || (read.rawContent !== text && createHash('sha256').update(text).digest('hex') !== read.meta.hash)) {
        const page = sourceScope === 'session' && sourceSessionId && verifiedFilePageOrigin(args.artifact_id,
          id => this.projectContextStore.commits.readSource(id, sourceSessionId))
        if (page) throw new Error(`FILE_PAGE_REQUIRES_ORIGINAL: use result.artifact_id ${JSON.stringify(page.artifactId)} for ${JSON.stringify(page.file)}; the requested ID is a page receipt. Reuse already returned lines.`)
        throw new Error('line paging requires an authorized, verified read_file result')
      }
      const result = args.allow_partial === true
        ? firstFileArtifactLinePage(read.view.result, start, end) : fileArtifactLinePage(read.view.result, start, end)
      if (!result) throw new Error(describeFileLinePageFailure(read.view.result, start, end))
      return { artifact_id: read.artifactId, source_scope: sourceScope, source_hash: createHash('sha256').update(read.rawContent).digest('hex'),
        captured_at: read.original.capturedAt, origin: 'tool', mode: 'file_lines', ...result,
        ...(args.allow_partial === true ? { requested_end_line: end, next_start_line: result.end_line < end ? result.end_line + 1 : null } : {}) }
    }
    // Keep evidence paging useful without allowing a model to pull an entire
    // report bundle into the next prompt in one round. The full value remains
    // in the runtime artifact and can be read through multiple pages or the
    // desktop artifact viewer.
    const pageLimit = Math.min(limit, MAX_ARTIFACT_PAGE_CHARACTERS)
    return { ...sourceMetadata, artifact_id: args.artifact_id, offset, requested_limit: limit,
      page_limit: pageLimit, total_characters: text.length,
      content: text.slice(offset, offset + pageLimit),
      next_offset: offset + pageLimit < text.length ? offset + pageLimit : null }
  }

  private browserContextKey(runId: string, browserInstanceId: string): string {
    return `${runId}:${browserInstanceId}`
  }

  private ensureBrowserContext(
    runId: string,
    browserInstanceId: string,
    allowedOrigins: string[],
    initialUrl?: string,
  ) {
    if (!this.browserGateway) throw new Error('browser gateway is not configured')
    const key = this.browserContextKey(runId, browserInstanceId)
    const existing = this.browserContexts.get(key)
    if (existing) {
      const widened = allowedOrigins.filter((origin) => !existing.allowedOrigins.includes(origin))
      if (widened.length > 0) throw new Error(`browser origin policy cannot be widened during an active session: ${widened.join(', ')}`)
      return existing
    }

    const capability = this.browserGateway.capability
    const identity = createHash('sha256').update(`${this.projectDir}:${runId}:${browserInstanceId}`).digest('hex').slice(0, 24)
    const profileId = `runtime-browser-profile:${identity}`
    const sessionId = `runtime-browser-session:${identity}`
    const tabId = `runtime-browser-tab:${identity}`
    const profile = capability.createProfile({
      id: profileId,
      projectId: this.projectDir,
      label: 'Capybara Runtime Browser',
      engine: 'chromium',
      persistence: 'ephemeral',
      credentialRefs: [],
      originPolicy: { allow: [...allowedOrigins] },
      downloadPolicy: 'quarantine',
      uploadRoots: [],
      permissions: {
        read: true,
        navigate: true,
        input: true,
        download: true,
        screenshot: true,
        wait: true,
        assert: true,
        localReversible: true,
        actions: ['navigate', 'read', 'click', 'input', 'select', 'download', 'screenshot', 'wait', 'assert'],
        risks: ['read', 'local-reversible'],
      },
      revision: 1,
      status: 'ready',
      createdBy: 'runtime',
    })
    const session = capability.createSession({
      id: sessionId,
      profileId: profile.id,
      profileRevision: profile.revision,
      projectId: this.projectDir,
      workSessionId: this.sessionId ?? 'runtime-session',
      runId,
      browserInstanceId,
      status: 'ready',
      authState: 'anonymous',
    })
    const fallbackUrl = (() => {
      try { return new URL(initialUrl ?? allowedOrigins[0] ?? 'https://example.com/').origin + '/' } catch { return 'https://example.com/' }
    })()
    const tab = capability.createTab({
      id: tabId,
      sessionId: session.id,
      index: 0,
      url: fallbackUrl,
      origin: new URL(fallbackUrl).origin,
      status: 'open',
    })
    const context = { profile, session, tab, browserInstanceId, allowedOrigins: [...allowedOrigins], nextSequence: 1 }
    this.browserContexts.set(key, context)
    return context
  }

  private gatewayPageState(
    input: BrowserExecutionRequest,
    output: Record<string, unknown>,
  ): PageState | undefined {
    if (!this.browserGateway) return undefined
    const rawState = isObject(output.state) ? output.state : {}
    const page = isObject(output.page) ? output.page : {}
    const url = typeof rawState.url === 'string' && rawState.url.trim() ? rawState.url : input.tab.url
    let parsed: URL
    try { parsed = new URL(url) } catch { return undefined }
    const title = String(rawState.title ?? page.title ?? input.tab.title ?? '')
    const textExcerpt = String(page.text ?? page.textExcerpt ?? '').slice(0, 8_000)
    const fingerprint = JSON.stringify({ url: parsed.toString(), title, textExcerpt })
    const hash = createHash('sha256').update(fingerprint).digest('hex')
    return this.browserGateway.capability.capturePageState({
      id: `page-state:${input.action.id}`,
      tabId: input.tab.id,
      capturedAt: now(),
      url: parsed.toString(),
      title,
      navigationId: `navigation:${input.action.id}`,
      domHash: hash,
      accessibilityHash: createHash('sha256').update(`${hash}:accessibility`).digest('hex'),
      textExcerpt,
      landmarks: [],
      frames: [],
      security: { https: parsed.protocol === 'https:' },
      stale: false,
    })
  }

  private async executeBrowserGatewayHost(input: BrowserExecutionRequest): Promise<BrowserExecutionResult> {
    if (!this.browserHost) {
      return { status: 'failed', error: { code: 'BROWSER_HOST_NOT_CONFIGURED', message: 'browser host is not configured' } }
    }
    const action = input.action
    const args = action.arguments
    const target = action.target as JsonObject
    const rawUrl = typeof target.url === 'string' ? target.url : typeof args.url === 'string' ? args.url : input.tab.url
    const rawScript = typeof args.script === 'string' ? args.script : typeof args.expression === 'string' ? args.expression : undefined
    const startedAt = now()
    try {
      const result = await this.browserHost({
        action: action.kind as RuntimeBrowserHostRequest['action'],
        browserInstanceId: input.session.browserInstanceId,
        ...(rawUrl ? { url: rawUrl } : {}),
        ...(Object.keys(target).length > 0 ? { target } : {}),
        ...(args.value === undefined ? {} : { value: String(args.value) }),
        ...(rawScript ? { script: rawScript } : {}),
        allowExternal: true,
        allowedOrigins: input.profile.originPolicy.allow,
        ...(action.timeoutMs ? { timeoutMs: action.timeoutMs } : {}),
        projectPath: this.projectDir,
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        runId: action.runId,
        stepId: this.timeline[this.run.currentStep]?.id ?? `step-browser-action:${action.id}`,
        callId: action.id,
      })
      if (!result.ok) {
        return {
          status: 'failed',
          error: result.error ?? { code: 'BROWSER_HOST_FAILED', message: 'browser host rejected the action' },
        }
      }
      const output = isObject(result.output) ? result.output : { result: result.output ?? null }
      const pageState = this.gatewayPageState(input, output)
      const runtimeArtifact = this.createArtifact(
        'tool-result',
        `Browser ${action.kind} result`,
        output,
        action.id,
      )
      const evidence: NonNullable<BrowserExecutionResult['evidence']> = []
      if (pageState) {
        evidence.push({
          type: 'page-snapshot',
          status: 'captured',
          pageStateId: pageState.id,
          source: { url: pageState.url, origin: new URL(pageState.url).origin, tabId: input.tab.id },
          content: { url: pageState.url, title: pageState.title, textExcerpt: pageState.textExcerpt },
          contentHash: pageState.domHash,
          runId: action.runId,
          kind: 'browser-dom',
          contentRef: runtimeArtifact.id,
          verificationRefs: [],
          redaction: 'none',
          confidence: 'observed',
        })
      }
      const screenshotDataUrl = typeof output.screenshotDataUrl === 'string' ? output.screenshotDataUrl : undefined
      if (screenshotDataUrl) {
        const screenshotArtifact = this.createArtifact('tool-result', 'Browser screenshot', { dataUrl: screenshotDataUrl }, action.id)
        const screenshotHash = createHash('sha256').update(screenshotDataUrl).digest('hex')
        evidence.push({
          type: 'screenshot',
          status: 'captured',
          ...(pageState ? { pageStateId: pageState.id } : {}),
          source: { url: pageState?.url ?? input.tab.url, origin: input.tab.origin, tabId: input.tab.id },
          content: { artifactId: screenshotArtifact.id, contentHash: screenshotHash },
          contentHash: screenshotHash,
          runId: action.runId,
          kind: 'screenshot',
          contentRef: screenshotArtifact.id,
          verificationRefs: [],
          redaction: 'none',
          confidence: 'observed',
        })
      }
      const artifactCandidates: NonNullable<BrowserExecutionResult['artifacts']> = []
      if (isObject(output.download)) {
        const downloadArtifact = this.createArtifact('tool-result', 'Browser download', output.download, action.id)
        const downloadText = JSON.stringify(output.download)
        const downloadHash = createHash('sha256').update(downloadText).digest('hex')
        artifactCandidates.push({
          kind: 'download',
          version: 1,
          sourceRefs: [{ type: 'action', id: action.id, relation: 'produced-by' }],
          contentRef: downloadArtifact.id,
          summary: 'Browser download artifact',
          status: 'quarantined',
          integrity: { size: Buffer.byteLength(downloadText), contentHash: downloadHash },
          runId: action.runId,
          contentHash: downloadHash,
          verificationRefs: [],
        })
        this.projectArtifactIndex.upsert({
          artifactId: downloadArtifact.id,
          kind: 'download',
          contentRef: downloadArtifact.id,
          contentHash: downloadHash,
          status: 'quarantined',
          summary: 'Browser download artifact',
          ...(typeof output.download.path === 'string' ? { relativePath: output.download.path } : {}),
          sourceRefs: [
            { type: 'run', id: action.runId, relation: 'references' },
            { type: 'action', id: action.id, relation: 'produced-by' },
          ],
          runId: action.runId,
          metadata: {
            url: output.download.url,
            filename: output.download.filename,
            size: output.download.size,
            status: output.download.status,
          },
        })
      }
      return {
        status: 'succeeded',
        result: { ...output, ...(pageState ? { pageStateId: pageState.id } : {}) },
        ...(pageState ? { afterPageStateId: pageState.id } : {}),
        evidence,
        artifacts: artifactCandidates,
        externalEffect: 'none',
      }
    } catch (error) {
      return {
        status: 'unknown',
        externalEffect: 'possible',
        error: {
          code: 'BROWSER_GATEWAY_EXECUTION_FAILED',
          message: error instanceof Error ? error.message : String(error),
          recovery: 'verify the browser session and page state before retrying',
        },
      }
    }
  }

  private async browserActionTool(args: unknown, request: ToolCallRequest): Promise<JsonObject> {
    if (!this.browserGateway) throw new Error('browser gateway is not configured')
    if (!isObject(args) || typeof args.action !== 'string') throw new Error('browser_action requires an action')
    const allowed = new Set<RuntimeBrowserHostRequest['action']>(['navigate', 'read', 'click', 'input', 'select', 'screenshot', 'wait', 'assert', 'download'])
    if (!allowed.has(args.action as RuntimeBrowserHostRequest['action'])) throw new Error(`browser_action does not support ${String(args.action)}`)
    const actionKind = args.action as RuntimeBrowserHostRequest['action']
    const requestedTarget = isObject(args.target) ? args.target as JsonObject : undefined
    const url = typeof args.url === 'string' && args.url.trim() ? args.url.trim() : undefined
    const value = args.value === undefined ? undefined : String(args.value)
    const script = args.script === undefined ? undefined : String(args.script)
    const allowedOrigins = Array.isArray(args.allowed_origins)
      ? args.allowed_origins.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : ['https://example.com', 'https://www.investor.gov', 'https://www.cninfo.com.cn']
    const browserInstanceId = typeof args.browser_instance_id === 'string' && args.browser_instance_id.trim()
      ? args.browser_instance_id.trim()
      : `runtime:${this.sessionId ?? this.projectDir}`
    const runId = this.run.runId ?? `runtime-browser-action:${randomUUID()}`
    const context = this.ensureBrowserContext(runId, browserInstanceId, allowedOrigins, url)
    const currentPageState = context.tab.pageStateId ? this.browserGateway.capability.getPageState(context.tab.pageStateId) : undefined
    const target: JsonObject = {
      ...(requestedTarget ?? {}),
      ...(['navigate', 'read', 'download'].includes(actionKind) && url ? { url } : {}),
      ...(['screenshot'].includes(actionKind) && !requestedTarget ? { selector: 'viewport' } : {}),
      ...(['assert'].includes(actionKind) && !requestedTarget ? { selector: 'body' } : {}),
      ...(['click', 'input', 'select', 'screenshot', 'assert'].includes(actionKind) && currentPageState && !requestedTarget?.pageStateId
        ? { pageStateId: currentPageState.id }
        : {}),
    }
    const condition = typeof args.condition === 'string' && args.condition.trim() ? args.condition.trim() : 'delay'
    const timeoutMs = Number.isInteger(args.timeout_ms) ? Number(args.timeout_ms) : undefined
    const browserAction: BrowserAction = {
      id: request.id,
      runId,
      sessionId: context.session.id,
      tabId: context.tab.id,
      sequence: context.nextSequence++,
      kind: actionKind,
      target,
      arguments: {
        ...(url ? { url } : {}),
        ...(value === undefined ? {} : { value }),
        ...(script === undefined ? {} : { script, ...(actionKind === 'assert' ? { expression: script } : {}) }),
        ...(actionKind === 'wait' ? { condition } : {}),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      },
      preconditions: currentPageState && ['click', 'input', 'select', 'screenshot', 'assert'].includes(actionKind)
        ? [{ type: 'page-state', value: currentPageState.id }]
        : [],
      risk: ['click', 'input', 'select'].includes(actionKind) ? 'local-reversible' : 'read',
      idempotencyKey: `runtime:${request.id}`,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      status: 'proposed',
    }
    const startedAt = now()
    const started = Date.now()
    const execution = await this.browserGateway.execute(browserAction)
    const reasons = execution.admission.browser.reasons
    if (execution.browserReceipt.status !== 'succeeded') {
      const message = (execution.browserReceipt.error?.message ?? reasons.join('; ')) || 'browser action was not completed'
      throw new Error(message)
    }
    return toJsonValue({
      action: actionKind,
      browserInstanceId,
      browserActionId: browserAction.id,
      browserSessionId: context.session.id,
      browserTabId: context.tab.id,
      admission: execution.admission.browser.disposition,
      browserReceipt: execution.browserReceipt,
      ...(execution.ledgerReceipt ? { ledgerReceipt: execution.ledgerReceipt } : {}),
      evidence: execution.evidence,
      artifacts: execution.artifacts,
      result: execution.browserReceipt.result,
      startedAt,
      completedAt: now(),
      durationMs: Date.now() - started,
    }) as JsonObject
  }

  private async browserReadTool(args: unknown): Promise<JsonObject> {
    if (!isObject(args) || typeof args.url !== 'string' || !args.url.trim()) throw new Error('browser_read requires a URL')
    let url: URL
    try { url = new URL(args.url) } catch { throw new Error('browser_read URL is invalid') }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('browser_read only accepts HTTP or HTTPS URLs')
    const normalizedUrl = url.toString()
    const previous = this.browserReadHistory.get(normalizedUrl)
    if (previous?.status === 'succeeded' && previous.output) {
      return toJsonValue({
        ...previous.output,
        reused: true,
        reuseNote: 'This URL was already read in the current session; reuse the preserved evidence instead of fetching it again.',
      }) as JsonObject
    }
    if (previous && previous.status !== 'succeeded') {
      throw new Error(`browser_read already attempted this URL and received ${previous.status}: ${previous.message ?? 'no verified page'}; do not retry the unchanged URL, choose another source`)
    }
    const executor = createHttpBrowserExecutor()
    const result = await executor({
      action: {
        id: `runtime-browser-read:${randomUUID()}`,
        runId: this.run.runId ?? `runtime-browser-read:${randomUUID()}`,
        sessionId: this.sessionId ?? 'runtime-session',
        tabId: 'runtime-http-tab',
        sequence: 1,
        kind: 'read',
        target: { url: normalizedUrl },
        arguments: {},
        preconditions: [],
        risk: 'read',
        idempotencyKey: `runtime-browser-read:${normalizedUrl}`,
        status: 'admitted',
      },
      profile: {} as never,
      session: {} as never,
      tab: { id: 'runtime-http-tab', sessionId: this.sessionId ?? 'runtime-session', index: 0, url: url.toString(), origin: url.origin, status: 'open' } as never,
      attempt: 1,
    })
    if (result.status !== 'succeeded') {
      this.browserReadHistory.set(normalizedUrl, {
        status: result.status,
        message: result.error?.message ?? 'browser_read did not produce verified evidence',
      })
      throw new Error(`browser_read ${result.error?.code ?? 'failed'}: ${result.error?.message ?? 'browser_read did not produce verified evidence'}; do not retry the unchanged URL`)
    }
    const output = toJsonValue({
      ...(result.result ?? {}),
      evidence: result.evidence ?? [],
    }) as JsonObject
    this.browserReadHistory.set(normalizedUrl, { status: 'succeeded', output })
    return output
  }

  private async marketResearchTool(args: unknown): Promise<JsonObject> {
    if (!isObject(args) || typeof args.ticker !== 'string' || !/^\d{6}$/.test(args.ticker)) throw new Error('market_research requires a six-digit ticker')
    const ticker = args.ticker
    const reportUrls = Array.isArray(args.report_urls)
      ? args.report_urls.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : ticker === '000682'
        ? [
            'https://static.cninfo.com.cn/finalpage/2026-04-24/1225161855.PDF',
            'https://static.cninfo.com.cn/finalpage/2025-04-23/1223215550.PDF',
            'https://static.cninfo.com.cn/finalpage/2024-04-19/1219670688.PDF',
          ]
        : []
    if (reportUrls.length === 0) throw new Error('market_research requires explicit report_urls for this ticker')
    const runId = `runtime-market-research:${this.run.runId ?? randomUUID()}`
    const service = createDefaultMarketResearchService({ projectPath: this.projectDir, projectId: path.basename(this.projectDir), runId })
    const result = await service.run({
      projectId: path.basename(this.projectDir),
      projectPath: this.projectDir,
      runId,
      ticker,
      reportUrls,
      ...(typeof args.exchange === 'string' ? { exchange: args.exchange } : {}),
      ...(typeof args.today === 'string' ? { today: args.today } : {}),
    })
    // Preserve the complete, receipt-rich result in the runtime artifact while
    // returning a compact projection to the model. This keeps evidence
    // auditable and prevents a successful workflow from exhausting the next
    // model context merely by carrying every bar, receipt, and source record.
    const fullResultArtifact = this.createArtifact(
      'tool-result',
      'Market research full result',
      result,
    )
    const stepSummaries = result.steps.map((step) => {
      const value = step.value as Record<string, unknown> | undefined
      let valueSummary: Record<string, unknown> | undefined
      if (step.step === 'market_data' && value) {
        const bars = Array.isArray(value.bars) ? value.bars : []
        valueSummary = {
          ticker: value.ticker,
          exchange: value.exchange,
          currency: value.currency,
          asOf: value.asOf,
          barCount: bars.length,
          firstBar: bars[0] ?? null,
          lastBar: bars.at(-1) ?? null,
        }
      } else if (step.step === 'report_download' && value) {
        const reports = Array.isArray(value.reports) ? value.reports : []
        valueSummary = { ticker: value.ticker, reportCount: reports.length, reports }
      } else if (step.step === 'python_analysis' && value) {
        valueSummary = {
          ticker: value.ticker,
          summary: value.summary,
          metrics: value.metrics,
          recommendation: value.recommendation,
        }
      } else if (step.value !== undefined) {
        valueSummary = value
      }
      return {
        step: step.step,
        status: step.status,
        evidenceIds: step.evidenceIds,
        artifactIds: step.artifactIds,
        ...(step.error ? { error: step.error } : {}),
        ...(valueSummary ? { value: valueSummary } : {}),
      }
    })
    return toJsonValue({
      status: result.status,
      ticker: result.ticker,
      period: result.period,
      steps: stepSummaries,
      ...(result.recommendation ? { recommendation: result.recommendation } : {}),
      ...(result.application ? { application: result.application } : {}),
      evidence: result.evidence.map((item) => ({
        evidenceId: item.evidenceId,
        kind: item.kind,
        source: item.source,
        locator: item.locator,
        summary: item.summary,
        contentHash: item.contentHash,
      })),
      artifacts: result.artifacts.map((item) => ({
        artifactId: item.artifactId,
        kind: item.kind,
        contentRef: item.contentRef,
        contentHash: item.contentHash,
        status: item.status,
        summary: item.summary,
      })),
      full_result_artifact_id: fullResultArtifact.id,
      instruction: 'This is a compact projection. The full receipt-rich result is preserved under full_result_artifact_id for evidence review.',
    }) as JsonObject
  }

  private readSystemVariablesTool(argumentsValue: unknown): JsonObject {
    if (!isObject(argumentsValue)) {
      throw new Error('read_system_variables requires an object')
    }
    const unknown = Object.keys(argumentsValue).find((key) => key !== 'keys')
    if (unknown) throw new Error(`read_system_variables does not accept ${unknown}`)
    const requestedKeys = argumentsValue.keys
    if (
      requestedKeys !== undefined
      && (
        !Array.isArray(requestedKeys)
        || requestedKeys.length === 0
        || requestedKeys.length > 50
        || !requestedKeys.every((key) => typeof key === 'string' && /^[a-z][a-z0-9_]*$/.test(key))
        || new Set(requestedKeys).size !== requestedKeys.length
      )
    ) {
      throw new Error('read_system_variables keys must contain 1-50 unique lowercase snake_case names')
    }
    // The runtime prompt includes enabled plugin variables as well as the
    // project file, so the authoring tool must inspect the same effective
    // registry rather than silently hiding plugin-owned values.
    const state = new PluginRegistry(this.projectDir, this.systemDir).effectiveSystemVariablesState()
    const editableRevision = this.projectResources.readSystemVariablesState().revision
    const allVariables = state.resource.variables.filter((variable) => variable.key !== 'sys_message')
    const resolved = resolveSystemPromptVariables(allVariables)
    const selectedKeys = requestedKeys as string[] | undefined
    const selected = selectedKeys ? new Set(selectedKeys) : undefined
    const variables = (selected
      ? allVariables.filter((variable) => selected.has(variable.key))
      : allVariables).map((variable) => ({
        ...variable,
        value_sha256: systemVariableValueHash(variable.value),
      }))
    const dependencies = Object.fromEntries(
      variables.map((variable) => [variable.key, resolved.dependencies[variable.key] ?? []]),
    )
    return toJsonValue({
      revision: editableRevision,
      variables,
      dependencies,
      ...(selectedKeys
        ? {
            selected_keys: selectedKeys,
            missing_keys: selectedKeys.filter((key) => !allVariables.some((variable) => variable.key === key)),
          }
        : {}),
      ...(!selectedKeys || selected?.has('dynamic_context')
        ? { dynamic_context: resolved.prompts.dynamic_context ?? '' }
        : {}),
    }) as JsonObject
  }

  private systemVariableChangeArguments(argumentsValue: unknown): {
    baseRevision: string
    changes: SystemVariableChange[]
  } {
    if (
      !isObject(argumentsValue) ||
      typeof argumentsValue.base_revision !== 'string' ||
      !argumentsValue.base_revision.trim() ||
      !Array.isArray(argumentsValue.changes) ||
      argumentsValue.changes.length === 0 ||
      argumentsValue.changes.length > 50
    ) {
      throw new Error('apply_system_variable_changes requires base_revision and 1-50 changes')
    }
    const changes = argumentsValue.changes.map((value, index): SystemVariableChange => {
      if (
        !isObject(value)
        || (value.op !== 'upsert' && value.op !== 'patch' && value.op !== 'json_patch' && value.op !== 'remove')
      ) {
        throw new Error(`changes[${index}] requires op upsert, patch, or remove`)
      }
      if (typeof value.key !== 'string' || !/^[a-z][a-z0-9_]*$/.test(value.key)) {
        throw new Error(`changes[${index}].key must use lowercase snake_case`)
      }
      if (value.op === 'remove') {
        const unknown = Object.keys(value).find((key) => (
          key !== 'op' && key !== 'key' && key !== 'expected_value_sha256'
        ))
        if (unknown) throw new Error(`changes[${index}] remove does not accept ${unknown}`)
        if (typeof value.expected_value_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.expected_value_sha256)) {
          throw new Error(`changes[${index}].expected_value_sha256 must be the hash returned by read_system_variables`)
        }
        return {
          op: 'remove',
          key: value.key,
          expected_value_sha256: value.expected_value_sha256,
        }
      }
      if (value.op === 'patch') {
        const unknown = Object.keys(value).find((key) => (
          key !== 'op' && key !== 'key' && key !== 'expected_value_sha256' && key !== 'edits'
        ))
        if (unknown) throw new Error(`changes[${index}] patch does not accept ${unknown}`)
        if (typeof value.expected_value_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.expected_value_sha256)) {
          throw new Error(`changes[${index}].expected_value_sha256 must be the hash returned by read_system_variables`)
        }
        if (!Array.isArray(value.edits) || value.edits.length === 0 || value.edits.length > 50) {
          throw new Error(`changes[${index}].edits must contain 1-50 text replacements`)
        }
        const edits = value.edits.map((edit, editIndex) => {
          if (
            !isObject(edit)
            || Object.keys(edit).some((key) => key !== 'old_text' && key !== 'new_text')
            || typeof edit.old_text !== 'string'
            || !edit.old_text
            || typeof edit.new_text !== 'string'
          ) {
            throw new Error(
              `changes[${index}].edits[${editIndex}] requires only non-empty old_text and string new_text`,
            )
          }
          return { old_text: edit.old_text, new_text: edit.new_text }
        })
        return {
          op: 'patch',
          key: value.key,
          expected_value_sha256: value.expected_value_sha256,
          edits,
        }
      }
      if (value.op === 'json_patch') {
        const unknown = Object.keys(value).find((key) => (
          key !== 'op' && key !== 'key' && key !== 'expected_value_sha256' && key !== 'patch'
        ))
        if (unknown) throw new Error(`changes[${index}] json_patch does not accept ${unknown}`)
        if (typeof value.expected_value_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.expected_value_sha256)) {
          throw new Error(`changes[${index}].expected_value_sha256 must be the hash returned by read_system_variables`)
        }
        if (!Array.isArray(value.patch) || value.patch.length === 0 || value.patch.length > 100) {
          throw new Error(`changes[${index}].patch must contain 1-100 JSON Patch operations`)
        }
        const patch = value.patch.map((operation, operationIndex) => {
          if (!isObject(operation) || (operation.op !== 'add' && operation.op !== 'remove' && operation.op !== 'replace') || typeof operation.path !== 'string' || (operation.path !== '' && !operation.path.startsWith('/'))) {
            throw new Error(`changes[${index}].patch[${operationIndex}] requires op, path, and optional JSON value`)
          }
          if ((operation.op === 'add' || operation.op === 'replace') && operation.value === undefined) {
            throw new Error(`changes[${index}].patch[${operationIndex}] requires value for ${operation.op}`)
          }
          return {
            op: operation.op as 'add' | 'remove' | 'replace',
            path: operation.path,
            ...(operation.value === undefined ? {} : { value: operation.value as SystemPromptVariableValue }),
          }
        })
        return {
          op: 'json_patch',
          key: value.key,
          expected_value_sha256: value.expected_value_sha256,
          patch,
        }
      }
      const allowed = new Set([
        'op', 'key', 'type', 'label', 'description', 'value',
        'expected_value_sha256', 'required', 'show_in_status', 'scope',
      ])
      const unknown = Object.keys(value).find((key) => !allowed.has(key))
      if (unknown) throw new Error(`changes[${index}] does not accept ${unknown}`)
      if (value.value === undefined) {
        throw new Error(`changes[${index}].value is required for upsert`)
      }
      if (
        value.expected_value_sha256 !== null
        && (typeof value.expected_value_sha256 !== 'string'
          || !/^[a-f0-9]{64}$/.test(value.expected_value_sha256))
      ) {
        throw new Error(`changes[${index}].expected_value_sha256 must be null or the hash returned by read_system_variables`)
      }
      if (value.type !== undefined && !SYSTEM_PROMPT_VARIABLE_TYPES.includes(value.type as (typeof SYSTEM_PROMPT_VARIABLE_TYPES)[number])) {
        throw new Error(`changes[${index}].type is unsupported`)
      }
      for (const key of ['label', 'description'] as const) {
        if (value[key] !== undefined && typeof value[key] !== 'string') {
          throw new Error(`changes[${index}].${key} must be a string`)
        }
      }
      for (const key of ['required', 'show_in_status'] as const) {
        if (value[key] !== undefined && typeof value[key] !== 'boolean') {
          throw new Error(`changes[${index}].${key} must be a boolean`)
        }
      }
      if (value.scope !== undefined && value.scope !== 'session' && value.scope !== 'project') {
        throw new Error(`changes[${index}].scope must be session or project`)
      }
      return {
        op: 'upsert',
        key: value.key,
        value: value.value as SystemPromptVariableValue,
        expected_value_sha256: value.expected_value_sha256,
        ...(value.type ? { type: value.type as SystemPromptVariableType } : {}),
        ...(typeof value.label === 'string' ? { label: value.label } : {}),
        ...(typeof value.description === 'string' ? { description: value.description } : {}),
        ...(typeof value.required === 'boolean' ? { required: value.required } : {}),
        ...(typeof value.show_in_status === 'boolean'
          ? { show_in_status: value.show_in_status }
          : {}),
        ...(value.scope ? { scope: value.scope } : {}),
      }
    })
    return { baseRevision: argumentsValue.base_revision, changes }
  }

  private async applySystemVariableChangesTool(
    argumentsValue: unknown,
    correlationId: string,
  ): Promise<JsonObject> {
    const input = this.systemVariableChangeArguments(argumentsValue)
    const result = await this.projectResources.applySystemVariableChanges(
      input.baseRevision,
      input.changes,
    )
    this.refreshSystemVariablesResource(result.resource, correlationId, result.revision)
    const resolved = resolveSystemPromptVariables(result.resource.variables)
    const changesByKey = new Map(input.changes.map((change) => [change.key, change]))
    const summarize = (variable: SystemVariableDefinition) => ({
      key: variable.key,
      type: variable.type,
      scope: variable.scope ?? 'session',
      required: variable.required,
      show_in_status: variable.show_in_status,
          value_length: canonicalSystemPromptVariableValue(variable.value).length,
          value_sha256: systemVariableValueHash(variable.value),
    })
    const diff = result.diff.map((item) => ({
      op: item.op,
      key: item.key,
      change: (() => {
        const change = changesByKey.get(item.key)
        if (!change) return undefined
        return change.op === 'patch'
          ? { mode: 'patch', edits: change.edits }
          : { mode: change.op }
      })(),
      ...(item.before ? { before: summarize(item.before) } : {}),
      ...(item.after ? { after: summarize(item.after) } : {}),
    }))
    const dynamicContextChanged = result.diff.some((item) => item.key === 'dynamic_context')
    return toJsonValue({
      revision: result.revision,
      diff,
      dependencies: resolved.dependencies,
      ...(dynamicContextChanged
        ? { dynamic_context: resolved.prompts.dynamic_context ?? '' }
        : { dynamic_context_unchanged: true }),
      context_updated: result.diff.length > 0,
    }) as JsonObject
  }

  private searchResources(argumentsValue: unknown): JsonObject {
    if (!isObject(argumentsValue) || typeof argumentsValue.query !== 'string' || !argumentsValue.query.trim()) {
      throw new Error('search_resources requires a non-empty query')
    }
    const kinds = argumentsValue.kinds ?? ['tool', 'harness', 'skill']
    if (
      !Array.isArray(kinds) ||
      kinds.length === 0 ||
      !kinds.every((kind) => kind === 'tool' || kind === 'harness' || kind === 'skill')
    ) {
      throw new Error('kinds must contain tool, harness, or skill')
    }
    const limit = argumentsValue.limit ?? 20
    if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 50) {
      throw new Error('limit must be an integer between 1 and 50')
    }
    const terms = argumentsValue.query.toLowerCase().trim().split(/\s+/)
    const results: JsonObject[] = []
    if (kinds.includes('tool')) {
      const installed = new Set(this.tools.items.map(tool => tool.id))
      const resources = this.toolCatalog.filter(tool => terms.includes(tool.id.toLowerCase())
        || terms.some(term => `${tool.name} ${tool.description}`.toLowerCase().includes(term)))
      if (this.childAgentMode) {
        for (const tool of resources) results.push({ id: tool.id, kind: 'tool', name: tool.name, description: tool.description, loaded: installed.has(tool.id) })
      } else {
        const resourceIds = new Set(resources.map(tool => tool.id))
        const capabilities = this.availableToolCapabilities()
        const projected = new Set(selectRuntimeCapabilities(this.taskControl, capabilities).map(capability => capability.capabilityId))
        for (const capability of capabilities) {
          const { capabilityId: id, name, source } = capability
          const matchesSystem = source === 'system' && (terms.includes(name.toLowerCase()) || terms.includes(id.toLowerCase()))
          if (!resourceIds.has(id) && !matchesSystem) continue
          results.push({ id, kind: 'tool', name, description: capability.definition.description, source,
            loaded: source === 'system' || installed.has(id),
            status: capability.unavailableReason ?? (projected.has(id) ? 'projected' : 'outside_current_projection') })
        }
        const exact = (item: JsonObject) => terms.includes(String(item.id).toLowerCase()) || terms.includes(String(item.name).toLowerCase())
        results.sort((a, b) => Number(exact(b)) - Number(exact(a)))
      }
    }
    if (kinds.includes('harness')) {
      for (const harness of this.harnessCatalog) {
        if (!terms.some((term) => harness.searchText.includes(term))) continue
        results.push({
          id: harness.id,
          kind: 'harness',
          name: harness.name,
          description: harness.description,
          requiredTools: harness.requiredTools,
          loaded: this.harnesses.items.some((item) => item.id === harness.id),
        })
      }
    }
    if (kinds.includes('skill')) {
      const active = new Set(this.phaseSkills().map(skill => skill.id))
      for (const skill of this.skillCatalog) {
        const text = `${skill.name} ${skill.description}`.toLowerCase()
        if (!terms.some((term) => text.includes(term))) continue
        results.push({
          id: skill.id,
          kind: 'skill',
          name: skill.name,
          description: skill.description,
          requiredTools: this.skillRegistry.get(skill.id)
            ? this.requiredToolNames(this.skillRegistry.get(skill.id) as RegisteredSkill)
            : [],
          loaded: active.has(skill.id),
        })
      }
    }
    return {
      query: argumentsValue.query,
      results: results.slice(0, Number(limit)),
      total: results.length,
    }
  }

  private repeatedChildCatalogSearches(calls: readonly ToolCallRequest[], messages: readonly LlmMessage[]): string[] {
    const signature = (query: string, results: unknown, total: unknown) => capabilityHash({
      query: query.toLowerCase().trim().replace(/\s+/gu, ' '), results, total,
    })
    const receipts = new Map<string, string>()
    for (const message of messages) {
      if (message.role !== 'tool' || message.name !== 'search_resources') continue
      let value: unknown
      try { value = JSON.parse(message.content) } catch { continue }
      if (!isObject(value) || value.ok !== true || !isObject(value.runtime_receipt) || !isObject(value.result)) continue
      const { runtime_receipt: receipt, result } = value
      if (receipt.runId !== this.run.runId || receipt.status !== 'succeeded' || receipt.toolName !== 'search_resources'
        || typeof receipt.completionActionRef !== 'string' || typeof result.query !== 'string' || !Array.isArray(result.results)
        || typeof result.total !== 'number') continue
      receipts.set(signature(result.query, result.results, result.total), receipt.completionActionRef)
    }
    const refs = []
    for (const call of calls) {
      let current: JsonObject
      try { current = this.searchResources(call.arguments) } catch { return [] }
      const ref = receipts.get(signature(String(current.query), current.results, current.total))
      if (!ref) return []
      refs.push(ref)
    }
    return [...new Set(refs)]
  }

  private childCatalogCheckpoint(stepIndex: number): string | undefined {
    const grants = this.childExecution?.capabilityIds
    if (grants?.length !== 1 || grants[0] !== 'runtime:search_resources'
      || this.timeline.some(step => step.index < stepIndex && typeof step.detail?.catalogCheckpoint === 'string')) return
    for (const message of this.llmMessages) {
      if (message.role !== 'tool' || message.name !== 'search_resources' || !message.toolCallId) continue
      let value: unknown
      try { value = JSON.parse(message.content) } catch { continue }
      if (!isObject(value) || value.ok !== true || !isObject(value.runtime_receipt) || !isObject(value.result)) continue
      const { runtime_receipt: receipt, result } = value
      if (receipt.runId !== this.run.runId || receipt.callId !== message.toolCallId || receipt.toolName !== message.name
        || receipt.status !== 'succeeded' || typeof receipt.completionActionRef !== 'string'
        || typeof result.query !== 'string' || !Array.isArray(result.results)) continue
      const query = result.query.trim().toLowerCase()
      if (result.results.some(entry => isObject(entry) && [entry.id, entry.name]
        .some(key => typeof key === 'string' && key.toLowerCase() === query))) return receipt.completionActionRef
    }
  }

  private loadResources(argumentsValue: unknown, correlationId: string, execution?: RuntimeExecutionState): JsonObject {
    if (
      !isObject(argumentsValue) ||
      !Array.isArray(argumentsValue.ids) ||
      argumentsValue.ids.length === 0 ||
      !argumentsValue.ids.every((id) => typeof id === 'string' && id.trim())
    ) {
      throw new Error('load_resources requires a non-empty string ids array')
    }

    const loaded: string[] = []
    const alreadyLoaded: string[] = []
    const notFound: string[] = []
    const nextTools = [...this.tools.items]
    const harnessIds: string[] = []
    const skillIds: string[] = []
    const activateTool = (tool: ToolDefinition) => {
      const index = nextTools.findIndex(item => item.id === tool.id)
      if (index >= 0) {
        if (nextTools[index]?.attachedBySkill) nextTools[index] = clone(tool)
        if (!alreadyLoaded.includes(tool.id)) alreadyLoaded.push(tool.id)
        return
      }
      nextTools.push(clone(tool))
      loaded.push(tool.id)
    }

    for (const id of [...new Set(argumentsValue.ids as string[])]) {
      const tool = this.toolCatalog.find((item) => item.id === id)
      if (tool) {
        activateTool(tool)
        continue
      }
      const harness = this.harnessCatalog.find((item) => item.id === id)
      if (harness) {
        if (this.harnesses.items.some((item) => item.id === id)) {
          alreadyLoaded.push(id)
        } else {
          harnessIds.push(id)
          loaded.push(id)
        }
        continue
      }
      const skill = this.skillRegistry.get(id)
      if (!skill) {
        notFound.push(id)
        continue
      }
      const existing = this.skills.items.find(item => item.id === id)
      if (existing?.status === 'active' && (!execution || bindRuntimeSkillActivation(existing, this.taskControl.taskId, execution) === existing)) {
        alreadyLoaded.push(id)
      } else {
        skillIds.push(id)
        loaded.push(id)
      }
    }

    const toolsChanged = JSON.stringify(nextTools) !== JSON.stringify(this.tools.items)
    if (toolsChanged) {
      this.tools = {
        ...this.tools,
        revision: this.tools.revision + 1,
        items: nextTools,
      }
      this.snapshotRevision += 1
      this.emit('runtime.tools.updated', clone(this.tools), correlationId)
    }
    const harnessesChanged = this.reconcileHarnessBindings(correlationId, {
      attachIds: harnessIds,
      attachSource: 'retrieval',
      sourceId: this.run.runId ?? correlationId,
    })
    if ((toolsChanged || harnessIds.length > 0) && !harnessesChanged) {
      this.syncResourceVariables(correlationId)
    }
    for (const skillId of skillIds) this.attachSkill(skillId, 'retrieval', correlationId, execution)
    return {
      loaded,
      alreadyLoaded,
      notFound,
      activeTools: this.tools.items.map((tool) => tool.id),
      activeHarnesses: this.harnesses.items.map((harness) => harness.id),
      activeSkills: this.phaseSkills(execution).map(skill => skill.id),
      blockedHarnesses: this.harnesses.items
        .filter((harness) => harness.status === 'error')
        .map((harness) => harness.id),
    }
  }

  private attachHarness(harnessId: string, correlationId: string): void {
    this.reconcileHarnessBindings(correlationId, {
      attachIds: [harnessId],
      attachSource: 'user',
      sourceId: 'developer',
    })
  }

  private detachHarness(harnessId: string, correlationId: string): void {
    this.reconcileHarnessBindings(correlationId, { detachId: harnessId })
  }

  private updateRuntimeStatus(
    changes: Partial<Pick<RuntimeStatusState, 'model' | 'loopStatus' | 'activity' | 'queueDepth' | 'context'>>,
    correlationId: string,
  ): void {
    const previousPhase = this.runtimeStatus.activity?.phase
    const context = this.runtimeStatusContext(changes.context ?? this.runtimeStatus.context)
    this.runtimeStatus = {
      ...this.runtimeStatus,
      ...changes,
      context,
      ...this.runtimeStatusMetrics(),
      revision: this.runtimeStatus.revision + 1,
      updatedAt: now(),
    }
    this.snapshotRevision += 1
    this.emit('runtime.status.updated', clone(this.runtimeStatus), correlationId)
    if (changes.activity && changes.activity.phase !== previousPhase && this.activeAssistantId) {
      const labels: Partial<Record<NonNullable<RuntimeStatusState['activity']>['phase'], string>> = {
        model_preparing: '正在准备模型输入并检查约束',
        model_waiting: '正在等待模型输出',
        model_processing: '正在处理模型结果',
        tool_running: '正在执行工具并收集结果',
      }
      const summary = labels[changes.activity.phase]
      if (summary) {
        const message = this.messages.find((item) => item.id === this.activeAssistantId)
        if (message) message.thinkingSummary = summary
        this.emit('chat.assistant.delta', { messageId: this.activeAssistantId, channel: 'thinkingSummary', source: 'runtime', chunkIndex: 0, delta: summary }, correlationId)
      }
    }
  }

  private stepDetail(type: TimelineStepType): JsonObject {
    switch (type) {
      case 'context':
        return { variableRevision: this.variables.revision, files: 2 }
      case 'render':
        return { templateRevision: this.template.revision, format: 'markdown' }
      case 'model':
        return {
          provider: this.llm.getConfig().provider,
          protocol: this.llm.getConfig().protocol,
          model: this.llm.getConfig().model,
          realLlmCalled: true,
        }
      case 'tool':
        return { dispatchedBy: 'project-tool-runner' }
      case 'workflow':
        return { generatedBy: 'model', persistence: 'runtime-only' }
      case 'harness':
        return { applied: this.harnesses.items.map((item) => item.name) }
      case 'output':
        return { deliveredOver: 'electron-ipc-or-local-runtime' }
    }
  }

  private assertRevision(provided: number, current: number): void {
    if (provided !== current) {
      throw new CommandError('REVISION_CONFLICT', 'revision does not match server state', {
        currentRevision: current,
      })
    }
  }

  private assertTemplateId(templateId: string): void {
    if (templateId !== this.template.id) {
      throw new CommandError('NOT_FOUND', 'template was not found')
    }
  }

  private assertHarness(harnessId: string): HarnessDefinition {
    const harness = this.harnesses.items.find((item) => item.id === harnessId)
    if (!harness) {
      throw new CommandError('NOT_FOUND', 'harness was not found')
    }
    return harness
  }

  private assertSkill(skillId: string): SkillDefinition {
    const skill = this.skills.items.find((item) => item.id === skillId)
    if (!skill) throw new CommandError('NOT_FOUND', 'skill is not active')
    return skill
  }

  private assertSkillResource(
    skillId: string,
    resourcePath: string,
    kind: SkillResourceState['kind'],
  ): SkillResourceState {
    const skill = this.assertSkill(skillId)
    const resource = skill.status === 'active' ? skill.resources.find(
      (item) => item.path === resourcePath && item.kind === kind,
    ) : undefined
    if (!resource) throw new CommandError('NOT_FOUND', `${kind} is not registered by the active skill`)
    return resource
  }

  private assertRuntimeVariables(value: RuntimeVariables): void {
    try {
      assertRuntimeCache(value.builtin?.cache)
    } catch {
      throw new CommandError('INVALID_PAYLOAD', 'patch would violate the runtime cache schema')
    }
    if (
      typeof value.task?.title !== 'string' ||
      typeof value.builtin?.project_path !== 'string' ||
      typeof value.builtin?.workspace_path !== 'string' ||
      typeof value.agent?.name !== 'string' ||
      !Array.isArray(value.context?.files) ||
      typeof value.context?.history_summary !== 'string' ||
      !Array.isArray(value.context?.evidence_refs) ||
      typeof value.context?.evidence_digest !== 'string' ||
      typeof value.user_message !== 'string' ||
      !Array.isArray(value.tools)
      || !Array.isArray(value.harnesses)
      || !isObject(value.skills)
      || !Array.isArray(value.skills.catalog)
      || !Array.isArray(value.skills.active)
    ) {
      throw new CommandError('INVALID_PAYLOAD', 'patch would violate the runtime variable schema')
    }
  }
}
