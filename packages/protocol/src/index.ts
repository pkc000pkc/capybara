export type JsonPrimitive = null | boolean | number | string

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue }

export type JsonObject = { [key: string]: JsonValue }

export type ExecutionMode = 'step' | 'continuous'

export type RunStatus =
  | 'idle'
  | 'ready'
  | 'running'
  | 'pause_requested'
  | 'paused'
  | 'waiting'
  | 'interrupting'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type RuntimeFailurePhase =
  | 'model_transport'
  | 'model_protocol'
  | 'model_output_validation'
  | 'tool_dispatch'
  | 'skill_validation'
  | 'skill_activation'
  | 'skill_script'
  | 'workflow_validation'
  | 'workflow_execution'
  | 'template'
  | 'runtime'

export interface RuntimeFailure {
  phase: RuntimeFailurePhase
  code: string
  message: string
  retryable: boolean
  stepId: string
  requestArtifactId?: string
  responseArtifactId?: string
  errorArtifactId: string
  timestamp: string
}

export interface RunState {
  runId: string | null
  mode: ExecutionMode
  status: RunStatus
  currentStep: number
  currentStepId?: string
  failure?: RuntimeFailure
  variablesEditable: boolean
  updatedAt: string
}

export interface RuntimeVariables extends JsonObject {
  builtin: {
    project_path: string
    workspace_path: string
    config_file: string
    main_template: string
    initialized_at: string
    prompts: { [key: string]: string }
    shared_prompts?: string[]
    missing_prompts: string[]
    sys_message: JsonValue[]
  }
  task: { title: string }
  agent: { name: string }
  context: {
    files: Array<{ path: string; summary: string }>
    history_summary: string
    evidence_refs: JsonValue[]
    evidence_digest: string
    [key: string]: JsonValue
  }
  user_message: string
  tools: Array<{ id: string; name: string; description: string }>
  harnesses: Array<{ id: string; name: string; content: string }>
  skills: {
    catalog: Array<{ id: string; name: string; description: string }>
    active: Array<{
      id: string
      name: string
      instructions: string
      requiredTools: string[]
      references: Array<{ path: string; content: string }>
      scripts: string[]
    }>
  }
}

export interface VariablesState {
  revision: number
  value: RuntimeVariables
}

export type JsonPatchOperation =
  | { op: 'add' | 'replace'; path: string; value: JsonValue }
  | { op: 'remove'; path: string }

export interface ChatContentText {
  type: 'text'
  text: string
}

export interface ChatContentFileRef {
  type: 'fileRef'
  fileId: string
  name: string
}

export type ChatContent = ChatContentText | ChatContentFileRef

export interface ChatMessage {
  id: string
  requestId?: string
  role: 'user' | 'assistant'
  status: 'queued' | 'streaming' | 'completed' | 'failed' | 'cancelled'
  content: ChatContentText[]
  thinkingSummary?: string
  createdAt: string
  completedAt?: string
}

export interface Diagnostic {
  severity: 'info' | 'warning' | 'error'
  code: string
  message: string
  line?: number
  column?: number
}

export interface TemplateState {
  id: string
  language: 'jinja2+markdown'
  source: string
  revision: number
  updatedAt: string
}

export interface RenderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  toolCallId?: string
  toolCalls?: Array<{
    id: string
    name: string
    arguments: JsonValue
  }>
}

export interface RenderResultState {
  messages: RenderMessage[]
  format: 'llm-messages'
  templateRevision: number
  variablesRevision: number
  renderedAt: string
  diagnostics: Diagnostic[]
}

export interface ToolDefinition {
  id: string
  name: string
  description: string
  inputSchema: JsonObject
  outputSchema?: JsonObject
  definitionRevision: number
  enabled: boolean
  permissions?: string[]
  sideEffects?: 'none' | 'workspace-write' | 'external'
  replay?: 'safe' | 'confirm' | 'never'
}

export interface RuntimeToolsState {
  revision: number
  items: ToolDefinition[]
  catalog: ToolDefinition[]
}

export interface HarnessDefinition {
  id: string
  name: string
  type: 'model' | 'tool' | 'experience'
  content: string
  metadata: JsonObject
  revision: number
  status: 'active' | 'error'
  bindings: HarnessBinding[]
  renderArtifactId?: string
  lastGoodArtifactId?: string
  diagnostics: Diagnostic[]
}

export interface HarnessBinding {
  id: string
  source: 'model' | 'tool' | 'retrieval' | 'user'
  sourceId: string
  reason: string
  score?: number
}

export interface HarnessCatalogDefinition {
  id: string
  name: string
  description: string
  type: 'model' | 'tool' | 'experience'
  source: string
  priority: number
  activation: JsonObject
  requiredTools: string[]
}

export interface RuntimeHarnessesState {
  revision: number
  items: HarnessDefinition[]
  catalog: HarnessCatalogDefinition[]
}

export interface SkillCatalogDefinition {
  id: string
  name: string
  description: string
  compatibility?: string
  metadata: JsonObject
  entry: string
  scripts: string[]
  references: string[]
  assets: string[]
}

export interface SkillResourceState {
  path: string
  kind: 'reference' | 'script' | 'asset'
  status: 'unloaded' | 'loading' | 'loaded' | 'failed'
  content?: string
  hash?: string
  error?: string
}

export interface SkillDefinition {
  id: string
  name: string
  description: string
  instructions: string
  status: 'activating' | 'active' | 'failed'
  source: 'user' | 'retrieval'
  requiredTools: string[]
  resources: SkillResourceState[]
  revision: number
  diagnostics: Diagnostic[]
}

export interface RuntimeSkillsState {
  revision: number
  catalog: SkillCatalogDefinition[]
  items: SkillDefinition[]
}

export type RuntimeArtifactKind =
  | 'model-request'
  | 'model-response'
  | 'tool-result'
  | 'context-render'
  | 'context-messages'
  | 'context-tools'
  | 'harness-render'
  | 'skill-reference'
  | 'skill-script-result'
  | 'context-diff'
  | 'effective-messages'
  | 'effective-tools'
  | 'runtime-error'
  | 'hook-result'
  | 'hook-log'
  | 'workflow-definition'
  | 'workflow-result'

export interface RuntimeArtifactMeta {
  id: string
  kind: RuntimeArtifactKind
  label: string
  contentType: 'application/json' | 'text/plain'
  byteLength: number
  hash: string
  preview: string
  redacted: boolean
  runId?: string
  stepId?: string
  createdAt: string
}

export interface RuntimeArtifactsState {
  revision: number
  items: RuntimeArtifactMeta[]
}

export interface RuntimeContextRevision {
  id: string
  parentId?: string
  reason: string
  templateRevision: number
  variablesRevision: number
  renderArtifactId: string
  messagesArtifactId: string
  toolsArtifactId: string
  diffArtifactId?: string
  includedFiles: string[]
  missingVariables: string[]
  createdAt: string
  appliedAt?: string
}

export interface RuntimeContextsState {
  revision: number
  activeId?: string
  pendingId?: string
  items: RuntimeContextRevision[]
}

export interface RuntimeEffectiveContextRevision {
  id: string
  runId: string
  stepId: string
  contextRevisionId?: string
  requestArtifactId: string
  messagesArtifactId: string
  toolsArtifactId: string
  diffArtifactId?: string
  createdAt: string
}

export interface RuntimeEffectiveContextsState {
  revision: number
  activeId?: string
  items: RuntimeEffectiveContextRevision[]
}

export interface RuntimeObservation {
  id: string
  runId: string
  stepId: string
  callId: string
  toolName: string
  status: 'running' | 'completed' | 'failed'
  arguments: JsonValue
  resultArtifactId?: string
  resultPreview?: string
  error?: JsonValue
  consumedByRequestArtifactId?: string
  consumedByStepId?: string
  startedAt: string
  completedAt?: string
  durationMs?: number
}

export interface RuntimeObservationsState {
  revision: number
  items: RuntimeObservation[]
}

export interface RuntimeCheckpointMeta {
  id: string
  currentStep: number
  currentStepId?: string
  contextRevisionId?: string
  createdAt: string
}

export interface RuntimeCheckpointsState {
  revision: number
  items: RuntimeCheckpointMeta[]
}

export interface RuntimeBreakpoint {
  id: string
  enabled: boolean
  position: 'before' | 'after'
  stepId?: string
  stepType?: TimelineStepType
  toolName?: string
}

export interface RuntimeBreakpointsState {
  revision: number
  items: RuntimeBreakpoint[]
}

export type TimelineStepType =
  | 'context'
  | 'render'
  | 'model'
  | 'tool'
  | 'workflow'
  | 'harness'
  | 'output'

export interface TimelineStep {
  id: string
  index: number
  type: TimelineStepType
  status: 'pending' | 'running' | 'success' | 'skipped' | 'error' | 'interrupted'
  startedAt?: string
  completedAt?: string
  durationMs?: number
  summary: string
  detail?: JsonObject
}

export type RuntimeWorkflowPlanStatus =
  | 'pending'
  | 'validating'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type RuntimeWorkflowNodeStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'cancelled'

export interface RuntimeWorkflowNode {
  id: string
  sourceStepId: string
  parentId?: string
  timelineStepId?: string
  type: 'tool' | 'filter' | 'foreach'
  toolName?: string
  iteration?: number
  status: RuntimeWorkflowNodeStatus
  inputArtifactId?: string
  outputArtifactId?: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  error?: JsonValue
}

export interface RuntimeWorkflowPlan {
  id: string
  runId: string
  callId: string
  revision: number
  goal: string
  status: RuntimeWorkflowPlanStatus
  definitionArtifactId: string
  resultArtifactId?: string
  nodes: RuntimeWorkflowNode[]
  createdAt: string
  completedAt?: string
  error?: JsonValue
}

export interface RuntimeWorkflowsState {
  revision: number
  activePlanId?: string
  items: RuntimeWorkflowPlan[]
}

export interface RuntimeStatusState {
  revision: number
  runtime: 'healthy' | 'degraded' | 'unavailable'
  model: 'ready' | 'busy' | 'unavailable'
  context: {
    usedTokens: number
    maxTokens: number
    utilization: number
  }
  queueDepth: number
  messageCount: number
  variableTokens: Array<{
    key: string
    label: string
    tokens: number
  }>
  updatedAt: string
}

export interface RuntimeSnapshot {
  snapshotRevision: number
  lastSequence: number
  run: RunState
  conversation: {
    revision: number
    messages: ChatMessage[]
  }
  template: TemplateState
  renderResult: RenderResultState | null
  variables: VariablesState
  tools: RuntimeToolsState
  harnesses: RuntimeHarnessesState
  skills: RuntimeSkillsState
  artifacts: RuntimeArtifactsState
  contexts: RuntimeContextsState
  effectiveContexts: RuntimeEffectiveContextsState
  observations: RuntimeObservationsState
  checkpoints: RuntimeCheckpointsState
  breakpoints: RuntimeBreakpointsState
  workflows: RuntimeWorkflowsState
  timeline: {
    revision: number
    steps: TimelineStep[]
  }
  status: RuntimeStatusState
}

export interface CommandPayloadMap {
  'runtime.snapshot.get': { afterSequence?: number }
  'runtime.artifact.get': { artifactId: string }
  'runtime.context.apply': { contextRevisionId: string }
  'chat.message.send': {
    clientMessageId: string
    content: ChatContent[]
    autoStart: boolean
  }
  'chat.response.cancel': { assistantMessageId?: string }
  'run.mode.set': { mode: ExecutionMode }
  'run.start': { inputMessageId?: string }
  'run.step': Record<string, never>
  'run.resume': Record<string, never>
  'run.pause': Record<string, never>
  'run.interrupt': { reason?: string }
  'run.restartStep': { stepId?: string; confirmSideEffects?: boolean }
  'run.restorePrevious': { targetStepId?: string }
  'run.restoreCheckpoint': { checkpointId: string }
  'run.cancel': { reason?: string }
  'runtime.breakpoints.upsert': { breakpoint: RuntimeBreakpoint }
  'runtime.breakpoints.remove': { breakpointId: string }
  'variables.apply': {
    baseRevision: number
    patch: JsonPatchOperation[]
  }
  'template.update': {
    templateId: string
    baseRevision: number
    source: string
  }
  'template.render': { templateId: string }
  'runtime.tools.attach': { toolId: string; baseRevision: number }
  'runtime.tools.detach': { toolId: string; baseRevision: number }
  'runtime.harnesses.attach': {
    baseRevision: number
    harnessId: string
  }
  'runtime.harnesses.detach': {
    baseRevision: number
    harnessId: string
  }
  'runtime.skills.attach': { skillId: string; baseRevision: number }
  'runtime.skills.detach': { skillId: string; baseRevision: number }
  'runtime.skills.reference.load': {
    skillId: string
    path: string
    baseRevision: number
  }
  'runtime.skills.script.run': {
    skillId: string
    path: string
    argv: string[]
    baseRevision: number
  }
}

export type CommandType = keyof CommandPayloadMap

interface ClientCommandBase<TType extends CommandType> {
  version: 1
  kind: 'command'
  id: string
  type: TType
  sessionId: string
  runId?: string
  timestamp: string
}

export type ClientCommand = {
  [TType in CommandType]: ClientCommandBase<TType> & {
    payload: CommandPayloadMap[TType]
  }
}[CommandType]

export type ErrorCode =
  | 'INVALID_MESSAGE'
  | 'UNSUPPORTED_VERSION'
  | 'UNKNOWN_COMMAND'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'INVALID_PAYLOAD'
  | 'INVALID_STATE'
  | 'REVISION_CONFLICT'
  | 'VARIABLES_LOCKED'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'RUN_BUSY'
  | 'CONFIRMATION_REQUIRED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'

export interface EventPayloadMap {
  'session.attached': {
    protocolVersion: 1
    resumeMode: 'new' | 'replay' | 'snapshot'
    project: { path: string; name: string }
    session: { id: string; name: string }
    serverTime: string
  }
  'command.accepted': { commandId: string; acceptedAt: string }
  'command.rejected': {
    commandId?: string
    code: ErrorCode
    message: string
    retryable: boolean
    details?: JsonObject
    currentRevision?: number
  }
  'runtime.snapshot': RuntimeSnapshot
  'runtime.artifact.created': { artifact: RuntimeArtifactMeta }
  'runtime.artifact.content': { artifact: RuntimeArtifactMeta; value: JsonValue }
  'runtime.context.revision.created': { revision: number; context: RuntimeContextRevision }
  'runtime.context.applied': {
    revision: number
    contextRevisionId: string
    previousContextRevisionId?: string
  }
  'runtime.effectiveContext.created': {
    revision: number
    context: RuntimeEffectiveContextRevision
  }
  'runtime.observation.upserted': {
    revision: number
    observation: RuntimeObservation
  }
  'runtime.workflows.updated': RuntimeWorkflowsState
  'runtime.checkpoint.created': { revision: number; checkpoint: RuntimeCheckpointMeta }
  'runtime.checkpoint.restored': { checkpointId: string; contextRevisionId?: string }
  'runtime.breakpoints.updated': RuntimeBreakpointsState
  'run.breakpoint.hit': {
    breakpointId: string
    stepId: string
    position: 'before' | 'after'
  }
  'runtime.status.updated': RuntimeStatusState
  'chat.user.created': ChatMessage
  'chat.assistant.started': { message: ChatMessage }
  'chat.assistant.delta': {
    messageId: string
    channel: 'thinkingSummary' | 'final'
    chunkIndex: number
    delta: string
  }
  'chat.assistant.completed': {
    messageId: string
    finishReason: 'stop' | 'length' | 'cancelled' | 'error'
    usage?: {
      inputTokens?: number
      outputTokens?: number
      totalTokens?: number
      cacheReadTokens?: number
    }
    completedAt: string
  }
  'chat.assistant.failed': {
    messageId: string
    code: string
    message: string
    retryable: boolean
  }
  'run.state.changed': RunState
  'run.trace.started': {
    run: RunState
    timeline: RuntimeSnapshot['timeline']
    checkpoints: RuntimeCheckpointsState
    effectiveContexts: RuntimeEffectiveContextsState
    observations: RuntimeObservationsState
    workflows: RuntimeWorkflowsState
  }
  'timeline.step.upserted': { revision: number; step: TimelineStep }
  'tool.call.started': {
    callId: string
    toolName: string
    arguments: JsonValue
    startedAt: string
  }
  'tool.call.completed': {
    callId: string
    toolName: string
    result: JsonValue
    startedAt: string
    completedAt: string
    durationMs: number
  }
  'tool.call.failed': {
    callId: string
    toolName: string
    code: string
    message: string
    details?: JsonValue
    startedAt: string
    completedAt: string
    durationMs: number
  }
  'variables.updated': {
    baseRevision: number
    revision: number
    patch: JsonPatchOperation[]
    source: 'user' | 'runtime' | 'tool' | 'hook' | 'restore'
  }
  'template.updated': TemplateState
  'template.validation.failed': {
    templateId: string
    attemptedRevision: number
    diagnostics: Diagnostic[]
  }
  'render.result.updated': RenderResultState
  'render.result.failed': {
    templateRevision: number
    variablesRevision: number
    diagnostics: Diagnostic[]
  }
  'runtime.tools.updated': RuntimeToolsState
  'runtime.harnesses.updated': RuntimeHarnessesState
  'runtime.skills.updated': RuntimeSkillsState
  'session.resync.required': {
    reason: 'sequenceGap' | 'historyExpired' | 'backpressure'
    lastAvailableSequence?: number
  }
  'protocol.error': { code: string; message: string }
}

export type EventType = keyof EventPayloadMap

export type ChannelEvent<TType extends EventType = EventType> =
  TType extends EventType
    ? {
        type: TType
        payload: EventPayloadMap[TType]
        correlationId?: string
        runId?: string
      }
    : never

interface ServerEventBase<TType extends EventType> {
  version: 1
  kind: 'event'
  id: string
  type: TType
  sessionId: string
  runId?: string
  sequence: number
  timestamp: string
  correlationId?: string
}

export type ServerEvent<TType extends EventType = EventType> =
  TType extends EventType
    ? ServerEventBase<TType> & { payload: EventPayloadMap[TType] }
    : never

export class CommandError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly options: {
      commandId?: string
      retryable?: boolean
      details?: JsonObject
      currentRevision?: number
    } = {},
  ) {
    super(message)
    this.name = 'CommandError'
  }
}

const COMMAND_TYPES = new Set<CommandType>([
  'runtime.snapshot.get',
  'runtime.artifact.get',
  'runtime.context.apply',
  'chat.message.send',
  'chat.response.cancel',
  'run.mode.set',
  'run.start',
  'run.step',
  'run.resume',
  'run.pause',
  'run.interrupt',
  'run.restartStep',
  'run.restorePrevious',
  'run.restoreCheckpoint',
  'run.cancel',
  'runtime.breakpoints.upsert',
  'runtime.breakpoints.remove',
  'variables.apply',
  'template.update',
  'template.render',
  'runtime.tools.attach',
  'runtime.tools.detach',
  'runtime.harnesses.attach',
  'runtime.harnesses.detach',
  'runtime.skills.attach',
  'runtime.skills.detach',
  'runtime.skills.reference.load',
  'runtime.skills.script.run',
])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'string' && Boolean((value[key] as string).trim())
}

function hasInteger(value: Record<string, unknown>, key: string): boolean {
  return Number.isInteger(value[key]) && Number(value[key]) >= 0
}

function assertOptionalString(value: Record<string, unknown>, key: string): void {
  if (value[key] !== undefined && typeof value[key] !== 'string') {
    throw new CommandError('INVALID_PAYLOAD', `${key} must be a string`)
  }
}

function assertEmptyPayload(payload: Record<string, unknown>): void {
  if (Object.keys(payload).length > 0) {
    throw new CommandError('INVALID_PAYLOAD', 'payload must be an empty object')
  }
}

function assertJsonValue(value: unknown, path = 'value'): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`))
    return
  }
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      assertJsonValue(item, `${path}.${key}`)
    }
    return
  }
  throw new CommandError('INVALID_PAYLOAD', `${path} must be valid JSON data`)
}

function validatePayload(type: CommandType, payload: Record<string, unknown>): void {
  switch (type) {
    case 'runtime.snapshot.get':
      if (payload.afterSequence !== undefined && !hasInteger(payload, 'afterSequence')) {
        throw new CommandError('INVALID_PAYLOAD', 'afterSequence must be a non-negative integer')
      }
      return
    case 'runtime.artifact.get':
      if (!hasString(payload, 'artifactId')) {
        throw new CommandError('INVALID_PAYLOAD', 'runtime.artifact.get requires artifactId')
      }
      return
    case 'runtime.context.apply':
      if (!hasString(payload, 'contextRevisionId')) {
        throw new CommandError('INVALID_PAYLOAD', 'runtime.context.apply requires contextRevisionId')
      }
      return
    case 'chat.message.send': {
      if (!hasString(payload, 'clientMessageId') || typeof payload.autoStart !== 'boolean') {
        throw new CommandError('INVALID_PAYLOAD', 'chat message requires clientMessageId and autoStart')
      }
      if (!Array.isArray(payload.content) || payload.content.length === 0) {
        throw new CommandError('INVALID_PAYLOAD', 'chat message content cannot be empty')
      }
      let hasNonEmptyText = false
      for (const item of payload.content) {
        if (!isObject(item) || (item.type !== 'text' && item.type !== 'fileRef')) {
          throw new CommandError('INVALID_PAYLOAD', 'chat content item is invalid')
        }
        if (item.type === 'text') {
          if (typeof item.text !== 'string') {
            throw new CommandError('INVALID_PAYLOAD', 'text content requires text')
          }
          hasNonEmptyText ||= Boolean(item.text.trim())
        } else if (!hasString(item, 'fileId') || !hasString(item, 'name')) {
          throw new CommandError('INVALID_PAYLOAD', 'fileRef content requires fileId and name')
        }
      }
      if (!hasNonEmptyText) {
        throw new CommandError('INVALID_PAYLOAD', 'chat message text cannot be blank')
      }
      return
    }
    case 'chat.response.cancel':
      assertOptionalString(payload, 'assistantMessageId')
      return
    case 'run.mode.set':
      if (payload.mode !== 'step' && payload.mode !== 'continuous') {
        throw new CommandError('INVALID_PAYLOAD', 'mode must be step or continuous')
      }
      return
    case 'run.start':
      assertOptionalString(payload, 'inputMessageId')
      return
    case 'run.step':
    case 'run.resume':
    case 'run.pause':
      assertEmptyPayload(payload)
      return
    case 'run.interrupt':
    case 'run.cancel':
      assertOptionalString(payload, 'reason')
      return
    case 'run.restartStep':
      assertOptionalString(payload, 'stepId')
      if (
        payload.confirmSideEffects !== undefined &&
        typeof payload.confirmSideEffects !== 'boolean'
      ) {
        throw new CommandError('INVALID_PAYLOAD', 'confirmSideEffects must be a boolean')
      }
      return
    case 'run.restorePrevious':
      assertOptionalString(payload, 'targetStepId')
      return
    case 'run.restoreCheckpoint':
      if (!hasString(payload, 'checkpointId')) {
        throw new CommandError('INVALID_PAYLOAD', 'run.restoreCheckpoint requires checkpointId')
      }
      return
    case 'runtime.breakpoints.upsert': {
      if (!isObject(payload.breakpoint)) {
        throw new CommandError('INVALID_PAYLOAD', 'runtime.breakpoints.upsert requires breakpoint')
      }
      const breakpoint = payload.breakpoint
      if (
        !hasString(breakpoint, 'id') ||
        typeof breakpoint.enabled !== 'boolean' ||
        (breakpoint.position !== 'before' && breakpoint.position !== 'after')
      ) {
        throw new CommandError('INVALID_PAYLOAD', 'breakpoint requires id, enabled, and position')
      }
      if (
        breakpoint.stepType !== undefined &&
        !['context', 'render', 'model', 'tool', 'workflow', 'harness', 'output'].includes(String(breakpoint.stepType))
      ) {
        throw new CommandError('INVALID_PAYLOAD', 'breakpoint stepType is invalid')
      }
      assertOptionalString(breakpoint, 'toolName')
      assertOptionalString(breakpoint, 'stepId')
      return
    }
    case 'runtime.breakpoints.remove':
      if (!hasString(payload, 'breakpointId')) {
        throw new CommandError('INVALID_PAYLOAD', 'runtime.breakpoints.remove requires breakpointId')
      }
      return
    case 'variables.apply':
      if (!hasInteger(payload, 'baseRevision') || !Array.isArray(payload.patch) || payload.patch.length === 0) {
        throw new CommandError('INVALID_PAYLOAD', 'variables.apply requires baseRevision and a non-empty patch')
      }
      if (payload.patch.length > 100) {
        throw new CommandError('INVALID_PAYLOAD', 'a variable patch may contain at most 100 operations')
      }
      for (const operation of payload.patch) {
        if (!isObject(operation) || !['add', 'replace', 'remove'].includes(String(operation.op)) || typeof operation.path !== 'string' || !operation.path.startsWith('/')) {
          throw new CommandError('INVALID_PAYLOAD', 'variable patch operation is invalid')
        }
        if (operation.op !== 'remove') {
          if (!Object.hasOwn(operation, 'value')) {
            throw new CommandError('INVALID_PAYLOAD', 'add and replace operations require value')
          }
          assertJsonValue(operation.value)
        }
      }
      return
    case 'template.update':
      if (!hasString(payload, 'templateId') || !hasInteger(payload, 'baseRevision') || typeof payload.source !== 'string') {
        throw new CommandError('INVALID_PAYLOAD', 'template.update requires templateId, baseRevision, and source')
      }
      if (payload.source.length > 250_000) {
        throw new CommandError('INVALID_PAYLOAD', 'template source is too large')
      }
      return
    case 'template.render':
      if (!hasString(payload, 'templateId')) {
        throw new CommandError('INVALID_PAYLOAD', 'template.render requires templateId')
      }
      return
    case 'runtime.tools.attach':
    case 'runtime.tools.detach':
      if (!hasString(payload, 'toolId') || !hasInteger(payload, 'baseRevision')) {
        throw new CommandError('INVALID_PAYLOAD', `${type} requires toolId and baseRevision`)
      }
      return
    case 'runtime.harnesses.attach':
    case 'runtime.harnesses.detach':
      if (!hasInteger(payload, 'baseRevision') || !hasString(payload, 'harnessId')) {
        throw new CommandError('INVALID_PAYLOAD', `${type} requires harnessId and baseRevision`)
      }
      return
    case 'runtime.skills.attach':
    case 'runtime.skills.detach':
      if (!hasInteger(payload, 'baseRevision') || !hasString(payload, 'skillId')) {
        throw new CommandError('INVALID_PAYLOAD', `${type} requires skillId and baseRevision`)
      }
      return
    case 'runtime.skills.reference.load':
      if (!hasInteger(payload, 'baseRevision') || !hasString(payload, 'skillId') || !hasString(payload, 'path')) {
        throw new CommandError('INVALID_PAYLOAD', `${type} requires skillId, path, and baseRevision`)
      }
      return
    case 'runtime.skills.script.run':
      if (
        !hasInteger(payload, 'baseRevision') ||
        !hasString(payload, 'skillId') ||
        !hasString(payload, 'path') ||
        !Array.isArray(payload.argv) ||
        payload.argv.length > 100 ||
        !payload.argv.every((item) => typeof item === 'string' && item.length <= 4_096)
      ) {
        throw new CommandError('INVALID_PAYLOAD', `${type} requires skillId, path, baseRevision, and string argv`)
      }
  }
}

export function parseClientCommand(value: unknown, sessionId: string): ClientCommand {
  if (!isObject(value)) {
    throw new CommandError('INVALID_MESSAGE', 'command must be a JSON object')
  }

  const commandId = typeof value.id === 'string' ? value.id : undefined
  const errorOptions = { commandId }

  if (value.version !== 1) {
    throw new CommandError('UNSUPPORTED_VERSION', 'only protocol version 1 is supported', errorOptions)
  }
  if (value.kind !== 'command') {
    throw new CommandError('INVALID_MESSAGE', 'kind must be command', errorOptions)
  }
  if (!commandId?.trim()) {
    throw new CommandError('INVALID_MESSAGE', 'command id is required')
  }
  if (typeof value.type !== 'string' || !COMMAND_TYPES.has(value.type as CommandType)) {
    throw new CommandError('UNKNOWN_COMMAND', `unknown command: ${String(value.type)}`, errorOptions)
  }
  if (value.sessionId !== sessionId) {
    throw new CommandError('FORBIDDEN', 'command sessionId does not match this connection', errorOptions)
  }
  if (typeof value.timestamp !== 'string' || Number.isNaN(Date.parse(value.timestamp))) {
    throw new CommandError('INVALID_MESSAGE', 'timestamp must be an RFC 3339 date', errorOptions)
  }
  if (value.runId !== undefined && typeof value.runId !== 'string') {
    throw new CommandError('INVALID_MESSAGE', 'runId must be a string', errorOptions)
  }
  if (!isObject(value.payload)) {
    throw new CommandError('INVALID_PAYLOAD', 'payload must be an object', errorOptions)
  }

  try {
    validatePayload(value.type as CommandType, value.payload)
  } catch (error) {
    if (error instanceof CommandError) {
      throw new CommandError(error.code, error.message, {
        ...error.options,
        commandId,
      })
    }
    throw error
  }

  return value as unknown as ClientCommand
}
