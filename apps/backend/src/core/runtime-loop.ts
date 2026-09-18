import { createHash, randomUUID } from 'node:crypto'
import { diagnosticContext, diagnosticLog } from '#util/llm/diagnostic-log'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import nunjucks from 'nunjucks'

import { ContextBuilder, type RenderEvent } from '#core/context-builder'
import { matchesModelHarnessActivation } from '#core/harnesses/harness-registry'
import { HookRegistry } from '#core/hooks/hook-registry'
import { HookRunner, type HookLlmActivity } from '#core/hooks/hook-runner'
import type { HookFixture, HookResult, HookStatusSnapshot } from '#core/hooks/types'
import { Loop } from '#core/loop'
import { PluginRegistry } from '#core/plugins/plugin-registry'
import { installSystemProjectResources } from '#core/project-initializer'
import { createProjectLlmService } from '#core/project-llm'
import { enqueueProjectWrite } from '#core/project-write-queue'
import { appendResearchEvents, readResearchLedgerEvents } from '#core/research-ledger'
import { ProjectResourceRegistry } from '#core/resources/resource-registry'
import {
  ProjectResources,
  type ProjectResourceChange,
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
import type { ToolCallRequest, ToolCallResult } from '#core/tools/types'
import { INTERNAL_RESOURCE_TOOLS } from '#core/runtime-resource-tools'
import {
  discardOrphanToolMessages,
  hasUnknownToolOutcome,
  interruptTimelineStep,
  retainRecentCheckpoints,
  type RuntimeCheckpoint,
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
  parseModelOutput,
  runtimeCacheMessages,
  textDiff,
  toJsonValue,
} from '#core/runtime-loop-utils'
import {
  filterWorkflowItems,
  parseGeneratedWorkflow,
  resolveWorkflowValue,
  workflowCondition,
  type GeneratedWorkflowDefinition,
  type GeneratedWorkflowStep,
  type WorkflowExecutionData,
} from '#core/workflows/generated-workflow'
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
  LlmRequestError,
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

export interface RuntimeLlm {
  chat(request: LlmChatRequest): Promise<LlmChatResponse>
  stream?(
    request: LlmChatRequest,
    onTextDelta: (delta: string) => void,
  ): Promise<LlmChatResponse>
  getConfig(): Readonly<LlmConfig>
}

export interface RuntimeLoopOptions {
  projectDir?: string
  workspaceDir?: string
  streamDelayMs?: number
  stepDelayMs?: number
  llm?: RuntimeLlm
  initialState?: RuntimeLoopState
  /** Isolated experiment inputs, resolved against the effective plugin registry. */
  initialVariableOverrides?: Record<string, string>
  skillMarketplace?: RuntimeSkillMarketplace
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

const INITIAL_TEMPLATE = ''
const CACHE_SUMMARY_MESSAGE_NAME = 'capybara_cache_summary'
const CACHE_SUMMARY_PREFIX = 'Earlier runtime cache summary:\n'
const SYSTEM_CONTEXT_COMPRESSION_HOOK_ID = 'context-compression'

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
  private readonly contextBuilder: ContextBuilder
  private readonly environment: nunjucks.Environment
  private readonly projectResources: ProjectResources
  private readonly toolRegistry: ToolRegistry
  private readonly skillRegistry: SkillRegistry
  private readonly skillMarketplace: RuntimeSkillMarketplace
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
  private harnessPolicy: ReturnType<ProjectResources['readSettings']>['harness_policy']
  private systemVariables: SystemVariablesResource
  private systemPromptDependencies: Record<string, string[]> = {}
  private runCounter = 0
  private assistantCounter = 0
  private assistantChunkIndex = 0
  private generation = 0
  private responseGeneration = 0
  private activeTask?: Promise<void>
  private resumeWaiters: Array<() => void> = []
  private activeAssistantId?: string
  private activeAbortController?: AbortController
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
  private harnessCatalog: HarnessCatalogEntry[] = []
  private skillCatalog: SkillCatalogDefinition[] = []
  private tools: { revision: number; items: ToolDefinition[]; catalog: ToolDefinition[] } = {
    revision: 1,
    items: [],
    catalog: [],
  }
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
    this.streamDelayMs = options.streamDelayMs ?? 45
    this.stepDelayMs = options.stepDelayMs ?? 80
    this.projectDir = path.resolve(
      options.projectDir ?? process.env.CAPYBARA_PROJECT_DIR ?? 'test-project',
    )
    this.workspaceDir = path.resolve(options.workspaceDir ?? this.projectDir)
    if (!fs.statSync(this.projectDir).isDirectory()) {
      throw new Error(`project is not a directory: ${this.projectDir}`)
    }
    if (!fs.statSync(this.workspaceDir).isDirectory()) {
      throw new Error(`workspace is not a directory: ${this.workspaceDir}`)
    }
    installSystemProjectResources(this.projectDir)
    this.projectResources = new ProjectResources(this.projectDir, true)
    const config = this.projectResources.readSettings()
    const pluginRegistry = new PluginRegistry(this.projectDir)
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
    this.maxToolRounds = config.max_tool_rounds
    this.contextWindowTokens = config.context.context_window_tokens
    this.maxInputTokens = config.context.max_input_tokens
    this.reservedOutputTokens = config.context.reserved_output_tokens
    this.runtimeStatus.context = {
      usedTokens: 0,
      maxTokens: this.availableInputTokens(),
      utilization: 0,
      cacheTokens: 0,
      contextWindowTokens: this.contextWindowTokens,
      cacheUtilization: 0,
    }
    this.harnessPolicy = clone(config.harness_policy)
    this.toolRegistry = new ToolRegistry(this.projectDir)
    this.toolRegistry.load(config.tools)
    this.skillRegistry = new SkillRegistry(this.projectDir)
    this.skillRegistry.load(config.skills)
    this.skillMarketplace = options.skillMarketplace ?? new SkillMarketplaceService(this.projectDir)
    this.hookRegistry = new HookRegistry(this.projectDir)
    this.toolDispatcher = new ToolDispatcher(this.toolRegistry, this.workspaceDir, {
      timeoutMs: config.tool_timeout_ms,
      networkRetry: config.tool_network_retry,
      permissions: config.tool_permissions,
    })
    this.skillScriptRunner = new SkillScriptRunner(this.workspaceDir, config.tool_timeout_ms)
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
    this.environment = new nunjucks.Environment(
      new nunjucks.FileSystemLoader(this.projectDir, { noCache: true }),
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
    this.captureContextRevision(
      'initial',
      this.contextBuilder.getIncludedFiles(),
      this.contextBuilder.getMissingVariables(),
    )
    if (options.initialState) this.restoreState(options.initialState)
    this.contextBuilder.onRender((event) => this.handleContextRender(event))
    this.projectResources.onChange((change) => this.handleProjectResourceChange(change))
  }

  override close(): void {
    this.abortActiveWork()
    this.contextBuilder.close()
    this.projectResources.close()
  }

  getSnapshot(lastSequence: number): RuntimeSnapshot {
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
    const catalog = new ProjectResourceRegistry(this.projectDir).list()
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
    return clone({
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
    })
  }

  getRequestCount(): number {
    return new Set(this.messages.flatMap((message) => message.requestId ? [message.requestId] : [])).size
  }

  private restoreState(state: RuntimeLoopState): void {
    if (state.version !== 1) throw new Error(`unsupported runtime state version: ${state.version}`)
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
    this.runCounter = state.runCounter
    this.assistantCounter = state.assistantCounter
    this.toolRound = state.toolRound
    this.continuationRound = state.continuationRound
    this.loopIteration = state.loopIteration ?? 0
    this.runUsage = clone(state.runUsage)

    this.messages.splice(0, this.messages.length, ...snapshot.conversation.messages.map((message) => (
      message.status === 'streaming'
        ? { ...message, status: 'cancelled' as const, completedAt: now() }
        : message
    )))
    this.clientMessageIds.clear()
    state.clientMessageIds.forEach((id) => this.clientMessageIds.add(id))
    this.llmMessages = discardOrphanToolMessages(clone(state.llmMessages))
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
      items: this.toolCatalog.filter((tool) =>
        snapshot.tools.items.some((item) => item.id === tool.id),
      ),
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
    const restoredSkills = clone(snapshot.skills?.items ?? [])
    const restoredToolCount = this.tools.items.length
    const restoredSkillItems = restoredSkills.flatMap((previous) => {
      const skill = this.skillRegistry.get(previous.id)
      if (!skill) return []
      try {
        for (const tool of this.requiredToolDefinitions(skill)) {
          if (!this.tools.items.some((item) => item.id === tool.id)) this.tools.items.push(clone(tool))
        }
        return [this.skillDefinition(skill, previous.source, previous)]
      } catch (error) {
        return [{
          ...previous,
          status: 'failed' as const,
          revision: previous.revision + 1,
          diagnostics: [{
            severity: 'error' as const,
            code: 'SKILL_RESTORE_FAILED',
            message: error instanceof Error ? error.message : String(error),
          }],
        }]
      }
    })
    this.skills = {
      revision: (snapshot.skills?.revision ?? 0) + 1,
      catalog: clone(this.skillCatalog),
      items: restoredSkillItems,
    }
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
  }

  validate(command: ClientCommand): void {
    switch (command.type) {
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
      case 'chat.message.send':
        if (this.clientMessageIds.has(command.payload.clientMessageId)) {
          throw new CommandError('ALREADY_EXISTS', 'clientMessageId already exists')
        }
        if (
          command.payload.autoStart &&
          ['running', 'waiting', 'pause_requested', 'paused', 'interrupting'].includes(this.run.status)
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
        if (this.run.status === 'running' || this.run.status === 'waiting') {
          throw new CommandError('RUN_BUSY', 'a run is already active')
        }
        return
      case 'run.step':
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
        if (!['paused', 'interrupted'].includes(this.run.status)) {
          throw new CommandError('INVALID_STATE', 'only a paused or interrupted run can resume')
        }
        if (hasUnknownToolOutcome(this.timeline[this.run.currentStep])) {
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
        if (this.tools.items.some((tool) => tool.id === command.payload.toolId)) {
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
        return
      case 'runtime.skills.script.run':
        this.assertRevision(command.payload.baseRevision, this.skills.revision)
        this.assertSkillResource(command.payload.skillId, command.payload.path, 'script')
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
    this.sessionId = command.sessionId
    switch (command.type) {
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
    this.publish({
      type,
      payload,
      correlationId,
      runId: this.run.runId ?? undefined,
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

  private beginRun(correlationId: string, requestId = `request-${randomUUID()}`): void {
    this.abortActiveWork()
    this.generation += 1
    this.runCounter += 1
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
    if (this.activeTask) {
      void this.activeTask.finally(() => {
        if (this.run.status === 'running' && this.run.mode === 'continuous') {
          this.startContinuous(correlationId)
        }
      })
      return
    }
    const generation = this.generation
    const task = this.runContinuously(correlationId, generation).finally(() => {
      if (this.activeTask === task) this.activeTask = undefined
    })
    this.activeTask = task
  }

  private startOneStep(correlationId: string): void {
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
      .finally(() => {
        if (this.activeTask === task) this.activeTask = undefined
      })
    this.activeTask = task
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
    if (isComplete) this.run = this.withRun({ status: 'completed' })
    this.pushCheckpoint(nextStep, completedStep.id, correlationId, afterCheckpointId)
    this.emitRun(pauseRequested ? this.pauseCorrelationId ?? correlationId : correlationId)
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
      activity: { phase: 'idle', startedAt: now() },
    }, correlationId)
    this.emitRun(correlationId)
    this.releasePauseWaiters()
    if (this.activeAssistantId) this.cancelResponse(correlationId)
  }

  private cancelRun(correlationId: string): void {
    this.generation += 1
    this.abortActiveWork()
    const current = this.timeline[this.run.currentStep]
    if (current?.status === 'running') this.updateTimeline(interruptTimelineStep(current), correlationId)
    this.run = this.withRun({ status: 'cancelled' })
    this.updateRuntimeStatus({
      model: 'ready',
      queueDepth: 0,
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
    this.skills = {
      revision: this.skillRevision,
      items: clone(checkpoint.skills ?? []).filter((item) => Boolean(this.skillRegistry.get(item.id))),
      catalog: clone(this.skillCatalog),
    }
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
    this.loopIteration = checkpoint.loopIteration ?? 0
    this.loopVariableBaseline = clone(checkpoint.loopVariableBaseline ?? checkpoint.variables)
    this.runUsage = clone(checkpoint.usage)
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
    this.emit('render.result.updated', clone(this.renderResult), correlationId)
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
    const requestId = command.payload.autoStart
      ? `request-${randomUUID()}`
      : this.run.runId ?? undefined
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
    if (!command.payload.autoStart && this.run.runId) {
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
    if (command.payload.autoStart) {
      const system = this.renderResult.messages.find((item) => item.role === 'system')?.content ?? ''
      this.llmMessages = this.limitRuntimeMessages([
        { role: 'system', content: system },
        ...this.llmMessages.filter((item) => item.role !== 'system'),
        { role: 'user', content: text },
      ])
    }
    if (command.payload.autoStart) this.beginRun(command.id, requestId)
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
      && this.workflowPlan(planId).status === 'failed'
    ) {
      step.detail = {
        ...(step.detail ?? {}),
        workflowSkipped: true,
        reason: 'workflow stopped after an earlier Tool failure',
      }
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
    const definitionArtifact = this.createArtifact(
      'workflow-definition',
      'Generated workflow definition',
      request.arguments,
      correlationId,
    )
    const planId = `workflow-${this.run.runId}-${this.workflows.items.length + 1}`
    let definition: GeneratedWorkflowDefinition
    try {
      definition = parseGeneratedWorkflow(
        request.arguments,
        new Map(this.tools.items.flatMap((tool) => [
          [tool.name, tool.name],
          [tool.id, tool.name],
        ])),
      )
    } catch (error) {
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
      this.llmMessages.push({ role: 'tool', name: request.name, toolCallId: request.id, content: JSON.stringify(result) })
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
  ): void {
    const failure = toJsonValue({
      message: error instanceof Error ? error.message : String(error),
    })
    const plan = this.workflowPlan(planId)
    const completedAt = now()
    const nodes = plan.nodes.map((node) => {
      if (node.id === nodeId) return {
        ...node,
        status: 'failed' as const,
        error: failure,
        completedAt,
      }
      if (node.status === 'pending' || node.status === 'running') return {
        ...node,
        status: 'cancelled' as const,
        completedAt,
      }
      return node
    })
    this.updateWorkflowPlan(planId, {
      status: 'failed',
      nodes,
      completedAt,
      error: failure,
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
    const workflowFailed = plan.status === 'failed'
    const unfinished = Object.entries(data.steps).filter(([, value]) =>
      value.status !== 'completed' && value.status !== 'skipped' && value.status !== 'failed')
    if (!workflowFailed && unfinished.length > 0) {
      throw new RuntimeStageError(
        'workflow_execution',
        'WORKFLOW_INCOMPLETE',
        `workflow has unfinished steps: ${unfinished.map(([id]) => id).join(', ')}`,
      )
    }
    const result = workflowFailed
      ? { ok: false, goal: plan.goal, steps: data.steps, error: plan.error ?? { message: 'workflow Tool failed' } }
      : { ok: true, goal: plan.goal, steps: data.steps }
    const artifact = this.createArtifact(
      'workflow-result',
      `Generated workflow result · ${plan.revision}`,
      result,
      correlationId,
    )
    this.updateWorkflowPlan(planId, {
      status: workflowFailed ? 'failed' : 'completed',
      resultArtifactId: artifact.id,
      completedAt: now(),
    }, correlationId)
    step.detail = {
      ...(step.detail ?? {}),
      resultArtifactId: artifact.id,
      resultPreview: artifact.preview,
      nodeCount: this.workflowPlan(planId).nodes.length,
    }
    this.llmMessages.push({
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
        code: 'WORKFLOW_TOOL_FAILED',
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
        error: toJsonValue({ code: 'WORKFLOW_TOOL_FAILED', message: workflowFailureMessage }),
      } : {}),
      startedAt,
      completedAt,
      durationMs,
    }, correlationId)
    this.pendingWorkflowCalls.delete(planId)
  }

  private async executeModelStep(
    step: TimelineStep,
    correlationId: string,
    generation: number,
  ): Promise<void> {
    this.updateRuntimeStatus({
      activity: { phase: 'model_preparing', label: step.summary, startedAt: now() },
    }, correlationId)
    const sanitizedMessages = discardOrphanToolMessages(this.llmMessages)
    if (JSON.stringify(sanitizedMessages) !== JSON.stringify(this.llmMessages)) {
      this.llmMessages = sanitizedMessages
      this.syncSystemMessages(correlationId)
    }
    this.refreshProjectLlm()
    await this.compressRuntimeCacheBeforeModel(correlationId, generation)
    if (this.generation !== generation) return
    const llm = this.llm
    this.ensureAssistantStarted(correlationId)
    const controller = new AbortController()
    this.activeAbortController = controller
    this.updateRuntimeStatus({
      model: 'busy',
      activity: { phase: 'model_waiting', label: step.summary, startedAt: now() },
    }, correlationId)
    const request: LlmChatRequest = {
      messages: clone(this.llmMessages),
      tools: this.modelToolDefinitions(),
      responseFormat: 'json',
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
        })}\n`)
        if (this.generation === generation) {
          this.updateModelRetry(step.id, retry, correlationId)
          this.createArtifact('hook-log', `Model request retry · ${step.summary}`, { stepId: step.id, ...retry }, correlationId)
        }
        } catch { /* Observers cannot interrupt a retry. */ }
      },
    })
    const nativeStream = llm.stream !== undefined
    const llmConfig = llm.getConfig()
    const requestArtifact = this.createArtifact(
      'model-request',
      `Model request · step ${step.index + 1}`,
      {
        provider: llmConfig.provider,
        protocol: llmConfig.protocol,
        model: request.model ?? llmConfig.model,
        stream: nativeStream,
        responseFormat: request.responseFormat ?? 'text',
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
    if (calls.length > 0) {
      if (this.maxToolRounds !== -1 && this.toolRound >= this.maxToolRounds) {
        throw new RuntimeStageError(
          'model_protocol',
          'MODEL_TOOL_ROUND_LIMIT',
          `model exceeded the maximum of ${this.maxToolRounds} tool rounds`,
          true,
        )
      }
      this.toolRound += 1
      this.llmMessages.push({ role: 'assistant', content: response.text, toolCalls: calls })
      this.publishRenderedMessages(correlationId)
      this.insertToolRound(step.index, calls, correlationId)
      this.updateRuntimeStatus({ model: 'ready', queueDepth: calls.length }, correlationId)
      return
    }
    let output: ModelOutput
    try {
      if (!response.text) throw new Error('LLM returned neither text nor tool calls')
      output = parseModelOutput(response.text)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Keep completed tool work and repair in the same conversation. Count from
      // the timeline so checkpoint restoration also retains the repair budget.
      const repairs = this.timeline.filter(item => item.detail?.outputRepair === true).length
      const repairLimit = llmConfig.maxRetries === -1 ? -1 : Math.max(3, llmConfig.maxRetries)
      if ((repairLimit === -1 || repairs < repairLimit)
        && (this.maxToolRounds === -1 || this.continuationRound < this.maxToolRounds)) {
        step.detail = { ...step.detail, outputRepair: true, outputRepairAttempt: repairs + 1 }
        diagnosticLog('model.output_repair', { attempt: repairs + 1, maxAttempts: repairLimit, responseArtifactId: responseArtifact.id })
        const repairPrompt = 'Your last response failed the runtime output format validation. Preserve all previous tool results; do not restart the task or repeat completed tool actions. Return a JSON object only, without Markdown fences: {"status":"running" or "completed","content":"non-empty text"}. Reformat your response using the existing evidence.'
        if (!this.llmMessages.some(message => message.role === 'user' && message.content === repairPrompt)) {
          if (response.text) this.llmMessages.push({ role: 'assistant', content: response.text })
          this.llmMessages.push({ role: 'user', content: repairPrompt })
        }
        this.continuationRound += 1
        this.publishRenderedMessages(correlationId)
        this.insertContinuation(step.index, correlationId)
        this.updateRuntimeStatus({ model: 'ready' }, correlationId)
        return
      }
      throw new RuntimeStageError(
        'model_output_validation',
        response.text ? 'MODEL_OUTPUT_INVALID' : 'MODEL_OUTPUT_EMPTY',
        `${message}; local output repair budget exhausted`,
        true,
      )
    }
    step.detail = { ...step.detail, loopStatus: output.status }
    this.updateRuntimeStatus({ loopStatus: output.status }, correlationId)
    if (output.status === 'running') {
      if (nativeStream) outputStream.finish(output)
      if (this.maxToolRounds !== -1 && this.continuationRound >= this.maxToolRounds) {
        throw new RuntimeStageError(
          'model_protocol',
          'MODEL_CONTINUATION_LIMIT',
          `model exceeded the maximum of ${this.maxToolRounds} continuation rounds`,
          true,
        )
      }
      this.continuationRound += 1
      this.llmMessages.push({ role: 'assistant', content: response.text })
      this.publishRenderedMessages(correlationId)
      this.insertContinuation(step.index, correlationId)
      this.updateRuntimeStatus({ model: 'ready' }, correlationId)
      return
    }
    if (nativeStream) outputStream.finish(output)
    this.llmMessages.push({ role: 'assistant', content: output.content })
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
    if (workflowPlanId && this.workflowPlan(workflowPlanId).status === 'failed') {
      this.pendingToolCalls.delete(step.id)
      step.detail = {
        ...(step.detail ?? {}),
        workflowSkipped: true,
        reason: 'workflow stopped after an earlier Tool failure',
      }
      this.updateRuntimeStatus({ queueDepth: this.pendingToolCalls.size }, correlationId)
      return
    }
    let request = pendingRequest
    if (workflowPlanId && workflowNodeId && workflowSourceStepId) {
      const definition = this.workflowDefinitions.get(workflowPlanId)?.steps.find(
        (item) => item.id === workflowSourceStepId,
      )
      const data = this.workflowData.get(workflowPlanId)
      if (!definition || !data || (definition.type !== 'tool' && definition.type !== 'foreach')) {
        throw new RuntimeStageError('workflow_execution', 'WORKFLOW_STATE_MISSING', 'workflow tool state is missing')
      }
      if (
        workflowIteration === undefined &&
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
      if (workflowIteration === undefined) data.steps[workflowSourceStepId] = { status: 'running' }
      this.updateWorkflowNode(workflowPlanId, workflowNodeId, {
        status: 'running',
        timelineStepId: step.id,
        startedAt: now(),
      }, correlationId)
    }
    const argumentsValue = toJsonValue(request.arguments)
    const startedAt = now()
    const projectTool = this.tools.items.find((tool) => tool.name === request.name)
    const internalTool = INTERNAL_RESOURCE_TOOLS.find((tool) => tool.name === request.name)
    step.detail = {
      ...(step.detail ?? {}),
      callId: request.id,
      toolName: request.name,
      arguments: argumentsValue,
      ...(projectTool ? {
        toolId: projectTool.id,
        permissions: projectTool.permissions ?? [],
        sideEffects: projectTool.sideEffects ?? 'none',
        replay: projectTool.replay ?? 'safe',
        inputSchema: projectTool.inputSchema,
      } : {
        toolId: `runtime:${request.name}`,
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
    this.emit('tool.call.started', {
      callId: request.id,
      toolName: request.name,
      arguments: argumentsValue,
      startedAt,
    }, correlationId)
    this.updateRuntimeStatus({
      activity: { phase: 'tool_running', label: request.name, startedAt },
    }, correlationId)

    let result: ToolCallResult
    if (INTERNAL_RESOURCE_TOOLS.some((tool) => tool.name === request.name)) {
      if (request.name === 'run_skill_script') {
        const controller = new AbortController()
        this.activeAbortController = controller
        try {
          result = await this.executeResourceTool(request, correlationId)
        } finally {
          if (this.activeAbortController === controller) this.activeAbortController = undefined
        }
      } else {
        result = await this.executeResourceTool(request, correlationId)
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
    const resultArtifact = this.createArtifact(
      request.name === 'read_skill_resource'
        ? 'skill-reference'
        : request.name === 'run_skill_script' ? 'skill-script-result' : 'tool-result',
      `Tool result · ${request.name}`,
      result.ok
        ? { ok: true, result: result.output ?? null }
        : { ok: false, error: result.error ?? null },
      correlationId,
    )
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
        for (const [id, state] of Object.entries(data.steps)) {
          if (id !== workflowSourceStepId && (state.status === 'pending' || state.status === 'running')) {
            data.steps[id] = { status: 'skipped' }
          }
        }
        data.steps[workflowSourceStepId] = {
          status: 'failed',
          output: { ok: false, error: result.error ?? { message: 'workflow Tool failed' } },
        }
        this.failGeneratedWorkflow(
          workflowPlanId,
          workflowNodeId,
          result.error?.message ?? 'workflow tool failed',
          correlationId,
        )
        step.detail = { ...step.detail, workflowNodeFailed: true }
        return
      }
      const completedAt = now()
      this.updateWorkflowNode(workflowPlanId, workflowNodeId, {
        status: 'completed',
        outputArtifactId: resultArtifact.id,
        completedAt,
        durationMs: result.durationMs,
      }, correlationId)
      if (workflowIteration === undefined) {
        data.steps[workflowSourceStepId] = { status: 'completed', output: result.output }
      } else {
        const outputs = Array.isArray(data.steps[workflowSourceStepId]?.output)
          ? [...data.steps[workflowSourceStepId].output as unknown[]]
          : []
        outputs[workflowIteration] = {
          item: workflowLocals.item ?? null,
          output: result.output ?? null,
        }
        data.steps[workflowSourceStepId] = { status: 'running', output: outputs }
        const children = this.workflowPlan(workflowPlanId).nodes.filter(
          (item) => item.parentId === workflowSourceStepId,
        )
        if (children.length > 0 && children.every((item) => item.status === 'completed')) {
          data.steps[workflowSourceStepId] = { status: 'completed', output: outputs }
          const aggregateArtifact = this.createArtifact(
            'workflow-result',
            `Workflow foreach result · ${workflowSourceStepId}`,
            outputs,
            correlationId,
          )
          const parent = this.workflowPlan(workflowPlanId).nodes.find(
            (item) => item.id === workflowSourceStepId,
          )
          this.updateWorkflowNode(workflowPlanId, workflowSourceStepId, {
            status: 'completed',
            outputArtifactId: aggregateArtifact.id,
            completedAt,
            durationMs: parent?.startedAt
              ? Math.max(0, Date.parse(completedAt) - Date.parse(parent.startedAt))
              : undefined,
          }, correlationId)
        }
      }
      return
    }
    this.llmMessages.push({
      role: 'tool',
      name: request.name,
      toolCallId: request.id,
      content: request.name === 'read_runtime_artifact'
        ? JSON.stringify(result.ok ? { ok: true, result: result.output ?? null } : { ok: false, error: result.error })
        : this.boundedToolContent(resultArtifact.id, result.ok
        ? { ok: true, result: result.output ?? null }
        : { ok: false, error: result.error }),
    })
    this.publishRenderedMessages(correlationId)
    this.pendingToolCalls.delete(step.id)
    this.updateRuntimeStatus({ queueDepth: this.pendingToolCalls.size }, correlationId)
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
      throw new Error('assistant stream does not match the completed response')
    }
    const remaining = response.text.slice(content.text.length)
    const chunks = nativeStream
      ? (remaining ? [remaining] : [])
      : (remaining.match(/[\s\S]{1,256}/g) ?? (remaining ? [remaining] : []))
    for (const delta of chunks) {
      if (!nativeStream && this.streamDelayMs > 0) await sleep(this.streamDelayMs)
      if (this.generation !== generation) return
      this.appendAssistantDelta(delta, correlationId)
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
  ): void {
    const workflowCalls = calls.filter((call) => call.name === 'execute_workflow')
    if (workflowCalls.length > 0 && calls.length !== 1) {
      throw new RuntimeStageError(
        'model_protocol',
        'WORKFLOW_CALL_MUST_BE_EXCLUSIVE',
        'execute_workflow must be the only tool call in a model response',
      )
    }
    const ids = new Set<string>()
    const toolSteps = calls.map((call, index): TimelineStep => {
      if (ids.has(call.id)) throw new Error(`model returned duplicate tool call id: ${call.id}`)
      ids.add(call.id)
      const workflow = call.name === 'execute_workflow'
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
          ...(workflow ? { workflowNodeType: 'plan' } : {}),
        },
      }
      const request = {
        id: call.id,
        name: call.name,
        arguments: call.arguments,
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
    if (message.includes('TOKEN_BUDGET_EXHAUSTED')) {
      return new RuntimeStageError('runtime', 'TOKEN_BUDGET_EXHAUSTED', message, false)
    }
    const protocolFailure = /invalid JSON|SSE events|tool messages require|stream.*event/i.test(message)
    const diagnostics = error instanceof LlmRequestError
      ? toJsonValue(error.diagnostics)
      : undefined
    // Provider outages are transparent retry conditions. Context/payload
    // failures are deterministic and must consume the run budget instead.
    const contextLimit = /context.{0,20}(length|limit|window)|maximum context|prompt is too long|too many tokens/i.test(message)
      || (error instanceof LlmRequestError && [400, 413, 422].includes(error.diagnostics.statusCode ?? 0)
        && /token|context|prompt|input/i.test(message))
    return new RuntimeStageError(
      contextLimit ? 'model_protocol' : protocolFailure ? 'model_protocol' : 'model_transport',
      contextLimit ? 'MODEL_CONTEXT_LIMIT' : protocolFailure ? 'MODEL_PROTOCOL_ERROR' : 'MODEL_TRANSPORT_ERROR',
      message,
      !protocolFailure && !contextLimit,
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
    const index = this.observations.findIndex((item) => item.id === observation.id)
    if (index >= 0) this.observations[index] = observation
    else this.observations.push(observation)
    this.observationRevision += 1
    this.snapshotRevision += 1
    this.emit('runtime.observation.upserted', {
      revision: this.observationRevision,
      observation: clone(observation),
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
    }
  }

  private pushCheckpoint(
    currentStep: number,
    currentStepId: string | undefined,
    correlationId: string,
    id?: string,
  ): RuntimeCheckpoint {
    const checkpoint = this.createCheckpoint(currentStep, currentStepId, id)
    this.checkpoints.push(checkpoint)
    this.checkpoints = retainRecentCheckpoints(this.checkpoints)
    this.checkpointRevision += 1
    this.snapshotRevision += 1
    this.emit('runtime.checkpoint.created', {
      revision: this.checkpointRevision,
      checkpoint: this.checkpointMeta(checkpoint),
    }, correlationId)
    return checkpoint
  }

  private abortActiveWork(): void {
    this.activeAbortController?.abort()
    this.activeAbortController = undefined
    this.toolDispatcher.abort()
    this.skillScriptRunner.abort()
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
    const summary = current.summary || (
      summaryMessage?.content.startsWith(CACHE_SUMMARY_PREFIX)
        ? summaryMessage.content.slice(CACHE_SUMMARY_PREFIX.length)
        : summaryMessage?.content ?? ''
    )
    return {
      version: 2,
      summary,
      messages: this.llmMessages
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
    }
    const hooks = this.hookRegistry.list()
      .filter((hook) => hook.loadable && hook.enabled && hook.checkpoint === 'after_loop')
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
          const execution = await new HookRunner(this.llm).run(hook, fixture, controller.signal, {
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
      const before = this.estimatedModelInputTokens()
      if (before <= maxTokens * 0.8 || this.generation !== generation) return
      await this.compressRuntimeCachePass(correlationId, generation)
      if (this.generation !== generation) return
      const after = this.estimatedModelInputTokens()
      if (after <= maxTokens * 0.8) return
      if (after >= before) break
    }
    const usedTokens = this.estimatedModelInputTokens()
    if (usedTokens > maxTokens) {
      const systemTokens = this.estimatedModelInputTokens(this.llmMessages.filter((m) => m.role === 'system'), [])
      const toolTokens = Math.ceil(JSON.stringify(this.modelToolDefinitions()).length / 4)
      this.createArtifact('runtime-error', 'Context budget exhausted after Cache compression', {
        usedTokens, maxTokens, systemTokens, toolTokens,
        cacheTokens: Math.max(0, usedTokens - systemTokens - toolTokens),
        estimator: 'serialized-json-characters-divided-by-four',
      }, correlationId)
      throw new RuntimeStageError('runtime', 'CACHE_COMPRESSION_INSUFFICIENT',
        `Cache compression could not fit ${usedTokens} estimated tokens into ${maxTokens}; fixed system=${systemTokens}, tools=${toolTokens}`)
    }
  }

  private async compressRuntimeCachePass(
    correlationId: string,
    generation: number,
  ): Promise<void> {
    const maxTokens = this.runtimeStatus.context.maxTokens
    const usedTokens = this.estimatedModelInputTokens()
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
    const fixedTokens = this.estimatedModelInputTokens(
      this.llmMessages.filter((message) => message.role === 'system'),
      tools,
    )
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
      const execution = await new HookRunner(this.llm).run(hook, fixture, controller.signal, {
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
          afterTokens: this.estimatedModelInputTokens(),
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
    return INTERNAL_RESOURCE_TOOLS.map(({
      descriptionVariable,
      defaultDescription,
      sideEffects: _sideEffects,
      replay: _replay,
      ...tool
    }) => ({
      ...tool,
      description: prompts[descriptionVariable] || defaultDescription || tool.name,
    }))
  }

  private refreshSystemVariablesResource(
    resource: SystemVariablesResource,
    correlationId: string,
    revision = new PluginRegistry(this.projectDir).effectiveSystemVariablesState().revision,
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
        this.maxToolRounds = settings.max_tool_rounds
        if (change === 'settings') {
          this.contextWindowTokens = settings.context.context_window_tokens
          this.maxInputTokens = settings.context.max_input_tokens
          this.reservedOutputTokens = settings.context.reserved_output_tokens
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
          const state = new PluginRegistry(this.projectDir).effectiveSystemVariablesState()
          this.refreshSystemVariablesResource(state.resource, `resource:${change}`, state.revision)
        }
        if (change !== 'skills') this.refreshRuntimePlugins(`resource:${change}`)
        if (change === 'settings') this.renderAndPublish(`resource:${change}`)
        return
      }
      const state = new PluginRegistry(this.projectDir).effectiveSystemVariablesState()
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

  private modelToolDefinitions(): LlmToolDefinition[] {
    return [
      ...this.internalResourceTools(),
      ...this.tools.items.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      })),
    ]
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
      items: [...this.tools.items, clone(tool)],
    }
    this.snapshotRevision += 1
    this.emit('runtime.tools.updated', clone(this.tools), correlationId)
    if (!this.reconcileHarnessBindings(correlationId)) this.syncResourceVariables(correlationId)
  }

  private detachTool(toolId: string, correlationId: string): void {
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
    const enabled = new Set(this.tools.items.map((tool) => tool.id))
    this.toolRegistry.load(settings.tools)
    const nextCatalog = this.toolRegistry.list().map((tool) => ({
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
    assertNoReservedToolNames(nextCatalog)
    this.toolCatalog = nextCatalog
    this.toolDispatcher = new ToolDispatcher(this.toolRegistry, this.workspaceDir, {
      timeoutMs: settings.tool_timeout_ms,
      networkRetry: settings.tool_network_retry,
      permissions: settings.tool_permissions,
    })
    const nextItems = this.toolCatalog.filter((tool) => enabled.has(tool.id))
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
      new PluginRegistry(this.projectDir).effectiveHarnesses(settings),
    )
    this.reconcileHarnessBindings(correlationId)
  }

  private harnessCatalogDefinitions(): HarnessCatalogDefinition[] {
    return this.harnessCatalog.map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      type: entry.type,
      source: path.relative(this.projectDir, entry.source).replaceAll('\\', '/'),
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
    const source = path.relative(this.projectDir, entry.source).replaceAll('\\', '/')
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
      source: path.relative(this.projectDir, entry.source).replaceAll('\\', '/'),
      manifest: path.relative(this.projectDir, entry.manifest).replaceAll('\\', '/'),
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
      entry: path.relative(this.projectDir, skill.entryFile).replaceAll('\\', '/'),
      scripts: skill.scriptFiles.map((file) => this.skillResourcePath(skill, file)),
      references: skill.referenceFiles.map((file) => this.skillResourcePath(skill, file)),
      assets: skill.assetFiles.map((file) => this.skillResourcePath(skill, file)),
    }))
  }

  private skillResourcePath(skill: RegisteredSkill, file: string): string {
    return path.relative(skill.rootDir, file).replaceAll('\\', '/')
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
      if (resource.kind !== 'reference' || prior?.status !== 'loaded') {
        return { ...resource, status: 'unloaded' as const }
      }
      const file = this.registeredSkillResource(skill, resource.path, 'reference')
      const content = fs.readFileSync(file, 'utf8')
      return {
        ...resource,
        status: 'loaded' as const,
        content,
        hash: createHash('sha256').update(content).digest('hex'),
      }
    })
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      instructions: skill.body.trim(),
      status: 'active',
      source,
      requiredTools: this.requiredToolNames(skill),
      resources,
      revision: (previous?.revision ?? 0) + 1,
      diagnostics: [],
    }
  }

  private skillVariableValue(): RuntimeVariables['skills'] {
    return {
      catalog: this.skillCatalog.map(({ id, name, description }) => ({ id, name, description })),
      active: this.skills.items
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
    this.updateSkillConfirmation(confirmationId, { status: 'executing' }, correlationId)
    void this.resolveSkillConfirmation(confirmation, correlationId)
  }

  private async resolveSkillConfirmation(
    confirmation: RuntimeSkillConfirmation,
    correlationId: string,
  ): Promise<void> {
    try {
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
  ): void {
    const skill = this.skillRegistry.get(skillId)
    if (!skill) throw new CommandError('NOT_FOUND', 'skill was not found in the project catalog')
    if (this.skills.items.some((item) => item.id === skillId)) return
    const requiredTools = this.requiredToolDefinitions(skill)
    const nextTools = [...this.tools.items]
    for (const tool of requiredTools) {
      if (!nextTools.some((item) => item.id === tool.id)) nextTools.push(clone(tool))
    }
    const toolsChanged = nextTools.length !== this.tools.items.length
    if (toolsChanged) {
      this.tools = { ...this.tools, revision: this.tools.revision + 1, items: nextTools }
      this.snapshotRevision += 1
      this.emit('runtime.tools.updated', clone(this.tools), correlationId)
    }
    const harnessesChanged = toolsChanged
      ? this.reconcileHarnessBindings(correlationId, { publish: false })
      : false
    this.skillRevision += 1
    this.skills = {
      ...this.skills,
      revision: this.skillRevision,
      items: [...this.skills.items, this.skillDefinition(skill, source)],
    }
    if (harnessesChanged) this.emit('runtime.harnesses.updated', clone(this.harnesses), correlationId)
    this.publishSkills(correlationId)
  }

  private detachSkill(skillId: string, correlationId: string): void {
    this.skillRevision += 1
    this.skills = {
      ...this.skills,
      revision: this.skillRevision,
      items: this.skills.items.filter((item) => item.id !== skillId),
    }
    this.publishSkills(correlationId)
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
    return file
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
    const skill = this.skillRegistry.get(skillId)
    this.assertSkillResource(skillId, resourcePath, 'reference')
    if (!skill) throw new Error(`unknown skill: ${skillId}`)
    try {
      const file = this.registeredSkillResource(skill, resourcePath, 'reference')
      const stat = fs.statSync(file)
      if (stat.size > 1024 * 1024) throw new Error('skill reference exceeds 1 MiB')
      const content = fs.readFileSync(file, 'utf8')
      const hash = createHash('sha256').update(content).digest('hex')
      this.setSkillResource(skillId, resourcePath, {
        status: 'loaded', content, hash, error: undefined,
      }, correlationId, true)
      return { skillId, path: resourcePath, content, hash }
    } catch (error) {
      this.setSkillResource(skillId, resourcePath, {
        status: 'failed', error: error instanceof Error ? error.message : String(error),
      }, correlationId)
      throw error
    }
  }

  private readSkillResourceArguments(argumentsValue: unknown, correlationId: string): JsonObject {
    if (
      !isObject(argumentsValue) ||
      typeof argumentsValue.skill_id !== 'string' ||
      !argumentsValue.skill_id.trim() ||
      typeof argumentsValue.path !== 'string' ||
      !argumentsValue.path.trim()
    ) {
      throw new Error('read_skill_resource requires skill_id and path')
    }
    return this.loadSkillReference(argumentsValue.skill_id, argumentsValue.path, correlationId)
  }

  private async runSkillScript(
    skillId: string,
    resourcePath: string,
    argv: readonly string[],
    request: { id: string; name: string },
    correlationId: string,
    signal?: AbortSignal,
  ): Promise<ToolCallResult> {
    const skill = this.skillRegistry.get(skillId)
    this.assertSkillResource(skillId, resourcePath, 'script')
    if (!skill) throw new Error(`unknown skill: ${skillId}`)
    const file = this.registeredSkillResource(skill, resourcePath, 'script')
    this.setSkillResource(skillId, resourcePath, {
      status: 'loading', content: undefined, error: undefined,
    }, correlationId)
    const result = await this.skillScriptRunner.run(request, file, argv, signal)
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
    const result = await this.runSkillScript(
      skillId,
      resourcePath,
      argv,
      { id: correlationId, name: 'run_skill_script' },
      correlationId,
    )
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
    const active = new Map(this.skills.items.map((item) => [item.id, item]))
    this.skillRegistry.load(settings.skills)
    this.skillCatalog = this.skillCatalogDefinitions()
    const activationErrors = new Map<string, unknown>()
    const nextTools = [...this.tools.items]
    for (const skill of this.skillRegistry.list().filter((item) => active.has(item.id))) {
      try {
        for (const tool of this.requiredToolDefinitions(skill)) {
          if (!nextTools.some((item) => item.id === tool.id)) nextTools.push(clone(tool))
        }
      } catch (error) {
        activationErrors.set(skill.id, error)
      }
    }
    const toolsChanged = nextTools.length !== this.tools.items.length
    if (toolsChanged) {
      this.tools = { ...this.tools, revision: this.tools.revision + 1, items: nextTools }
      this.snapshotRevision += 1
      this.emit('runtime.tools.updated', clone(this.tools), correlationId)
    }
    const harnessesChanged = toolsChanged
      ? this.reconcileHarnessBindings(correlationId, { publish: false })
      : false
    const items = this.skillRegistry.list()
      .filter((skill) => active.has(skill.id))
      .map((skill) => {
        const previous = active.get(skill.id) as SkillDefinition
        try {
          const activationError = activationErrors.get(skill.id)
          if (activationError) throw activationError
          return this.skillDefinition(skill, previous.source, previous)
        } catch (error) {
          return {
            ...previous,
            status: 'failed' as const,
            revision: previous.revision + 1,
            diagnostics: [{
              severity: 'error' as const,
              code: 'SKILL_ACTIVATION_FAILED',
              message: error instanceof Error ? error.message : String(error),
            }],
          }
        }
      })
    this.skillRevision += 1
    this.skills = {
      revision: this.skillRevision,
      catalog: clone(this.skillCatalog),
      items,
    }
    if (harnessesChanged) this.emit('runtime.harnesses.updated', clone(this.harnesses), correlationId)
    this.publishSkills(correlationId)
  }

  private async executeResourceTool(
    request: ToolCallRequest,
    correlationId: string,
  ): Promise<ToolCallResult> {
    const started = Date.now()
    const startedAt = now()
    try {
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
      const output = request.name === 'read_runtime_artifact'
        ? this.readRuntimeArtifactTool(request.arguments)
        : request.name === 'search_resources'
        ? this.searchResources(request.arguments)
        : request.name === 'load_resources'
          ? this.loadResources(request.arguments, correlationId)
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
                        : this.readSkillResourceArguments(request.arguments, correlationId)
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
          code: 'INVALID_ARGUMENTS',
          message: error instanceof Error ? error.message : String(error),
        },
        startedAt,
        completedAt: now(),
        durationMs: Date.now() - started,
      }
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

  private readRuntimeArtifactTool(args: unknown): JsonObject {
    if (!isObject(args) || typeof args.artifact_id !== 'string') throw new Error('artifact_id is required')
    const offset = args.offset ?? 0
    const limit = args.limit ?? 4000
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0
      || typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 8000) {
      throw new Error('offset must be nonnegative and limit must be between 1 and 8000')
    }
    const artifact = this.artifacts.get(args.artifact_id)
    if (!artifact || !['tool-result', 'workflow-result', 'skill-reference', 'skill-script-result'].includes(artifact.meta.kind)) {
      throw new Error('Tool result artifact not found in this session')
    }
    const text = JSON.stringify(artifact.value)
    return { artifact_id: args.artifact_id, offset, total_characters: text.length,
      content: text.slice(offset, offset + limit),
      next_offset: offset + limit < text.length ? offset + limit : null }
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
    const state = new PluginRegistry(this.projectDir).effectiveSystemVariablesState()
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
      for (const tool of this.toolCatalog) {
        const text = `${tool.name} ${tool.description}`.toLowerCase()
        if (!terms.some((term) => text.includes(term))) continue
        results.push({
          id: tool.id,
          kind: 'tool',
          name: tool.name,
          description: tool.description,
          loaded: this.tools.items.some((item) => item.id === tool.id),
        })
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
          loaded: this.skills.items.some((item) => item.id === skill.id),
        })
      }
    }
    return {
      query: argumentsValue.query,
      results: results.slice(0, Number(limit)),
      total: results.length,
    }
  }

  private loadResources(argumentsValue: unknown, correlationId: string): JsonObject {
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
      if (nextTools.some((item) => item.id === tool.id)) {
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
      if (this.skills.items.some((item) => item.id === id)) {
        alreadyLoaded.push(id)
      } else {
        skillIds.push(id)
        loaded.push(id)
      }
    }

    const toolsChanged = nextTools.length !== this.tools.items.length
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
    for (const skillId of skillIds) this.attachSkill(skillId, 'retrieval', correlationId)
    return {
      loaded,
      alreadyLoaded,
      notFound,
      activeTools: this.tools.items.map((tool) => tool.id),
      activeHarnesses: this.harnesses.items.map((harness) => harness.id),
      activeSkills: this.skills.items.map((skill) => skill.id),
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
        return { deliveredOver: 'websocket' }
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
    const resource = this.assertSkill(skillId).resources.find(
      (item) => item.path === resourcePath && item.kind === kind,
    )
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
