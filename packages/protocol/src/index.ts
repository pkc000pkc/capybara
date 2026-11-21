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

export interface RuntimeModelRetry {
  phase: 'waiting' | 'attempting'
  stepId: string
  attempt: number
  /** -1 indicates an unlimited number of attempts. */
  maxAttempts: number
  delayMs: number
  /** Failed request time plus scheduled backoff, excluded from task runtime budgets. */
  excludedMs?: number
  reason: string
  statusCode?: number
  updatedAt: string
}

export interface RunState {
  runId: string | null
  mode: ExecutionMode
  status: RunStatus
  currentStep: number
  currentStepId?: string
  failure?: RuntimeFailure
  modelRetry?: RuntimeModelRetry
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
    system_variables_revision: string
    prompts: { [key: string]: string }
    variables?: { [key: string]: JsonValue }
    shared_prompts?: string[]
    missing_prompts: string[]
    sys_message: JsonValue[]
    cache: RuntimeCache
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

interface RuntimeCacheBase extends JsonObject {
  summary: string
  messages: JsonValue[]
  loop: {
    run_id: string
    iteration: number
    tool_round: number
    continuation_round: number
  }
  compression_count: number
  compressed_at: string
}

export interface RuntimeCacheV1 extends RuntimeCacheBase {
  version: 1
}

export interface RuntimeCacheV2 extends RuntimeCacheBase {
  version: 2
  task_profile: JsonObject
  plan: JsonValue[]
  claims: JsonValue[]
  evidence: JsonValue[]
  hypotheses: JsonValue[]
  contradictions: JsonValue[]
  reviews: JsonValue[]
  candidate_answer: string
  tool_history: JsonValue[]
  failure_history: JsonValue[]
  budget: JsonObject
}

export type RuntimeCache = RuntimeCacheV1 | RuntimeCacheV2

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
  evidenceRefs?: string[]
  failure?: RuntimeFailure
  createdAt: string
  completedAt?: string
}

export type SessionKind = 'user' | 'agent' | 'child' | 'application' | 'system'

export type SessionStatus =
  | 'ready' | 'running' | 'waiting' | 'paused' | 'awaiting_user'
  | 'reconnecting' | 'succeeded' | 'failed' | 'cancelled' | 'closed' | 'unknown'

export type SessionCapability =
  | 'receive_message' | 'send_message' | 'delegate' | 'invoke_tools'
  | 'application_input' | 'application_output'

export interface SessionAddress {
  canonical: string
  aliases: string[]
}

export interface SessionRef {
  projectId: string
  sessionId: string
  kind: SessionKind
  displayName: string
  role: string
  description?: string
  parentSessionId?: string
  ownerSessionId?: string
  status: SessionStatus
  capabilities: SessionCapability[]
  address: SessionAddress
  createdAt: string
  updatedAt: string
  lastActiveAt?: string
}

export interface SessionDirectorySnapshot {
  projectId: string
  revision: number
  generatedAt: string
  currentSessionId?: string
  items: SessionRef[]
}

export type SessionMessageRelation = 'application' | 'direct' | 'a2a' | 'system'

export type SessionMessageType =
  | 'chat.message' | 'task.request' | 'task.result' | 'task.status'
  | 'context.request' | 'context.update' | 'artifact.ready'
  | 'user.confirmation.request' | 'user.confirmation.result' | 'system.notice'

export interface SessionMessageTarget {
  sessionId: string
  projectId: string
  expectedRevision?: number
}

export interface SessionMessageCorrelation {
  conversationId?: string
  runId?: string
  turnId?: string
  stepId?: string
  callId?: string
  parentMessageId?: string
  parentSessionId?: string
  childId?: string
}

export interface SessionMessageDeliveryOptions {
  mode: 'enqueue' | 'interrupt' | 'notify'
  idempotencyKey: string
  priority?: 'normal' | 'high'
  requireReceipt: boolean
  allowOfflineQueue?: boolean
}

export interface SessionMessageAuthorization {
  actorSessionId: string
  capability: SessionCapability
  requestId: string
  permissionRevision: string
}

export interface SessionMessageEnvelope<T = JsonValue> {
  protocol: 'capybara.session-message.v1'
  messageId: string
  projectId: string
  source: SessionRef
  target: SessionMessageTarget
  relation: SessionMessageRelation
  type: SessionMessageType
  payload: T
  correlation: SessionMessageCorrelation
  delivery: SessionMessageDeliveryOptions
  authorization: SessionMessageAuthorization
  createdAt: string
  expiresAt?: string
}

export interface SessionMessageDeliveryReceipt {
  receiptId: string
  messageId: string
  target: SessionRef
  status: 'accepted' | 'queued' | 'delivered' | 'processing' | 'completed' | 'rejected' | 'expired' | 'failed'
  sequence?: number
  reason?: string
  receivedAt: string
  deliveredAt?: string
  completedAt?: string
  traceRefs: { runId?: string; turnId?: string; stepId?: string; callId?: string }
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
  attachedBySkill?: true
  origin?: { type: 'mcp'; serverId: string; toolName: string; connectionId: string; sourceVersion: string }
}

export interface RuntimeToolsState {
  revision: number
  items: ToolDefinition[]
  catalog: ToolDefinition[]
}

export type RuntimeMcpFormValue = string | number | boolean | string[]

export interface RuntimeMcpFormField {
  id: string
  label: string
  description?: string
  kind: 'string' | 'number' | 'integer' | 'boolean' | 'choice' | 'choices'
  required: boolean
  options?: Array<{ value: string; label: string }>
}

export interface RuntimeMcpInputView {
  id: string
  serverId: string
  toolName: string
  callId: string
  operationId?: string
  workflow?: { id: string; nodeId: string }
  round: number
  status: 'pending' | 'answered'
  forms: Array<{ id: string; message: string; fields: RuntimeMcpFormField[] }>
  urls?: Array<{ id: string; opened: boolean }>
}

export type RuntimeMcpFormReply = { action: 'accept'; content: Record<string, RuntimeMcpFormValue> } | { action: 'decline' | 'cancel' }
export type RuntimeMcpInputReply = RuntimeMcpFormReply | { action: 'accept'; content?: never }

export interface RuntimeMcpState {
  revision: number
  unknownCallCount?: number
  inputRequests?: RuntimeMcpInputView[]
  pendingOperations?: Array<{ operationId: string; serverId: string; toolName: string; taskId?: string; runId?: string;
    verificationCapabilityId?: string; verificationPollIntervalMs?: number }>
  servers: Array<{ id: string; transport: 'stdio' | 'streamable-http'; status: 'idle' | 'connecting' | 'ready' | 'disconnected' | 'failed' | 'disabled';
    connectionId?: string; protocolVersion?: string; serverInfo?: { name: string; version: string }; toolCount: number; errorCode?: string }>
}

export interface HarnessDefinition {
  id: string
  name: string
  type: 'model' | 'tool' | 'experience' | 'persistent'
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
  source: 'model' | 'tool' | 'retrieval' | 'user' | 'persistent'
  sourceId: string
  reason: string
  score?: number
}

export interface HarnessCatalogDefinition {
  id: string
  name: string
  description: string
  type: 'model' | 'tool' | 'experience' | 'persistent'
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

export interface RuntimePluginDefinition {
  id: string
  name: string
  version: string
  ownerKind: 'system' | 'project' | 'installed'
  enabled: boolean
  status: 'active' | 'disabled' | 'error'
  variableKeys: string[]
  toolDependencies: Array<{
    package: string
    requestedVersion: string
    installedVersion?: string
    status: 'installed' | 'missing' | 'conflict'
  }>
  harnessIds: string[]
  hookIds: string[]
  trainingHookIds: string[]
  diagnostics: Diagnostic[]
}

export interface RuntimePluginsState {
  revision: number
  items: RuntimePluginDefinition[]
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
  sourceVersion?: string
  activation?: {
    taskId: string
    stages: Partial<Record<RuntimeSkillPhase, string[]>>
  }
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

export interface RuntimeArtifactPage {
  artifact: RuntimeArtifactMeta
  page: number
  pageSize: number
  totalPages: number
  totalItems: number
  unit: 'items' | 'characters'
  value: JsonValue
}

export interface RuntimeVariablePage {
  path: string
  revision: number
  page: number
  pageSize: number
  totalPages: number
  totalCharacters: number
  value: string
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

/** V2 canonical context document metadata. The Markdown serialization is kept
 * in an artifact; these records provide stable identity and revision links for
 * RuntimeLoop, Client, and replay consumers. */
export type ContextSectionKind = 'system' | 'tools' | 'information' | 'candidates' | 'messages'

export type ContextCandidateStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'conflict'
  | 'stale'
  | 'irrelevant'
  | 'superseded'

export type ContextDurability = 'project' | 'session' | 'transient'
export type ContextTarget = 'project' | 'session' | 'cache'
export type ContextClassificationConfidence = 'low' | 'medium' | 'high'

export interface RuntimeContextClassification {
  durability: ContextDurability
  target: ContextTarget
  confidence: ContextClassificationConfidence
  reason: string
  projectAnchors: string[]
}

export interface RuntimeContextDocumentMeta {
  id: string
  sessionId: string
  projectId: string
  revision: number
  constitutionRevision: string
  markdownArtifactId?: string
  createdAt: string
  updatedAt: string
}

/**
 * Unified renderer-facing view of one V2 context document. The project and
 * session documents use the same shape; `scope` is the only ownership
 * distinction. Markdown remains available for exact inspection while the
 * structured arrays prevent consumers from reparsing the document text.
 */
export interface RuntimeContextInformationEntryView {
  id: string
  sectionId: string
  headingPath: string[]
  body: string
  status: 'active' | 'superseded' | 'archived'
  evidenceRefs: string[]
  sourceCandidateIds: string[]
  supersedesEntryIds?: string[]
  revision: number
  classification?: RuntimeContextClassification
}

export interface RuntimeContextDocumentView {
  scope: RuntimeContextScopeKind
  meta: RuntimeContextDocumentMeta
  /** External tree form required by the organizer: List<List|string>. */
  list: RuntimeContextListNode[]
  tree?: RuntimeContextTree
  nodeIdsByPath?: Record<string, string>
  markdown: string
  information: RuntimeContextInformationEntryView[]
  candidates: RuntimeContextCandidateMeta[]
  evidence: RuntimeContextEvidenceRef[]
}

export type RuntimeContextListNode = string | RuntimeContextListNode[]

export interface RuntimeContextTree {
  version: 1
  rootChildren: string[]
  headings: Array<{ id: string; title: string; children: string[] }>
}

export interface RuntimeContextTreeBinding {
  id: string
  kind: 'root' | 'heading' | 'entry'
  parentId?: string
  title?: string
  hash: string
  childIds?: string[]
  totalChildren?: number
}

export const CONTEXT_CONTENT_OPERATIONS = ['add_entry', 'replace_body', 'append_evidence', 'mark_status'] as const
export const CONTEXT_TREE_OPERATIONS = ['add_heading', 'rename_heading', 'move_node', 'reorder_children'] as const
export const CONTEXT_DIFF_OPERATIONS = [...CONTEXT_CONTENT_OPERATIONS, ...CONTEXT_TREE_OPERATIONS] as const
export type RuntimeContextDiffOperation = typeof CONTEXT_DIFF_OPERATIONS[number]

export interface RuntimeContextDiffPayload {
  body?: string
  evidenceRefs?: string[]
  status?: 'active' | 'superseded' | 'archived'
  classification?: RuntimeContextClassification
  title?: string
  parentNodeId?: string
  beforeNodeId?: string | null
  childIds?: string[]
}

export type RuntimeContextVariableName = 'project_context' | 'session_context' | 'context' | 'cache' | 'messages' | 'system_prompt' | 'runtime_state'

export interface RuntimeContextVariableView {
  name: RuntimeContextVariableName
  aliases?: string[]
  role: 'document' | 'observation' | 'signal'
  scope: 'project' | 'session' | 'runtime'
  revision?: number
  value: JsonValue
}

export interface RuntimeContextInformationUnitView {
  id: string
  scope: 'project' | 'session' | 'candidate' | 'archive'
  content: string
  sourceRefs: string[]
  evidenceRefs: string[]
  status?: ContextCandidateStatus | 'active' | 'superseded' | 'archived'
  classification?: RuntimeContextClassification
}

export interface RuntimeContextArchiveRecordView {
  id: string
  scope: 'project' | 'session'
  content: string
  sourceRefs: string[]
  reason: string
  recallable: boolean
}

/** Variable-oriented organizer view. Markdown is only one serialization of the documents. */
export interface RuntimeContextOrganizationView {
  coverage?: { coveredThrough: number; retainedMessageIds: string[]; commitId?: string; receiptIds: string[]; messageCount: number }
  variables: RuntimeContextVariableView[]
  informationUnits: RuntimeContextInformationUnitView[]
  archiveRecords: RuntimeContextArchiveRecordView[]
  projectRevision: number
  sessionRevision: number
}

/** Context scope is explicit so project knowledge is not silently treated as session history. */
export type RuntimeContextScopeKind = 'project' | 'session'

export interface RuntimeContextScopeRef {
  scope: RuntimeContextScopeKind
  projectId: string
  sessionId?: string
  documentId: string
  revision: number
  parentDocumentId?: string
  parentRevision?: number
}

export interface RuntimeContextScopesState {
  revision: number
  activeScope: RuntimeContextScopeKind
  project: RuntimeContextScopeRef
  session: RuntimeContextScopeRef
  updatedAt: string
}

export interface RuntimeContextCandidateMeta {
  id: string
  actor: 'user' | 'tool' | 'model' | 'system' | 'child-agent' | 'memory'
  sourceId: string
  capturedAt: string
  toolName?: string
  runId?: string
  stepId?: string
  rawArtifactId: string
  status: ContextCandidateStatus
  evidenceRefs: string[]
  proposedDiffIds: string[]
  createdAt: string
  reviewedAt?: string
  reason?: string
  classification?: RuntimeContextClassification
}

export interface RuntimeContextArchivedEntryMeta {
  id: string
  entryId: string
  headingPath: string[]
  body: string
  evidenceRefs: string[]
  sourceCandidateIds: string[]
  reason: string
  score?: number
}

export interface RuntimeContextEvidenceRef {
  id: string
  kind: 'observation' | 'artifact' | 'message' | 'external'
  referenceId: string
  sessionId?: string
  sourceHash?: string
  observedAt?: string
  locator?: string
  confidence?: 'low' | 'medium' | 'high'
}

export interface RuntimeContextObservation {
  scope?: RuntimeContextScopeKind
  documentId?: string
  candidate: {
    source: {
      actor: 'user' | 'tool' | 'model' | 'system' | 'child-agent' | 'memory'
      sourceId: string
      toolName?: string
      runId?: string
      stepId?: string
      capturedAt: string
    }
    rawArtifactId: string
    normalizedContent: string
    classification?: RuntimeContextClassification
  }
  evidence?: Omit<RuntimeContextEvidenceRef, 'id'>
}

export interface RuntimeContextApplyReceipt {
  scope?: RuntimeContextScopeKind
  id: string
  proposalId: string
  result: 'applied' | 'rejected' | 'conflict'
  previousRevision: number
  nextRevision?: number
  changedEntryIds: string[]
  changedNodeIds?: string[]
  unchanged?: true
  proposalHash?: string
  errorCode?: string
  createdAt: string
}

export interface RuntimeContextCandidateReview {
  documentId: string
  candidateId: string
  baseRevision: number
  status: Exclude<ContextCandidateStatus, 'pending'>
  reason?: string
}

export interface RuntimeContextCandidateReviewReceipt {
  id: string
  candidateId: string
  result: 'reviewed' | 'conflict' | 'rejected'
  previousRevision: number
  nextRevision?: number
  status?: Exclude<ContextCandidateStatus, 'pending'>
  reason?: string
  errorCode?: string
  createdAt: string
}

export const CONTEXT_RECALL_MAX_RESULTS = 20
export const CONTEXT_RECALL_MAX_QUERY_CHARACTERS = 256
export const CONTEXT_RECALL_SOURCE_KINDS = ['information', 'candidate', 'source_archive'] as const
export type RuntimeContextRecallSourceKind = typeof CONTEXT_RECALL_SOURCE_KINDS[number]

export interface RuntimeContextMemoryRecall {
  query: string
  limit?: number
  scope?: RuntimeContextScopeKind | 'both'
  sourceKind?: RuntimeContextRecallSourceKind
}

export interface RuntimeContextRecallHit {
  id: string
  scope: RuntimeContextScopeKind
  documentId?: string
  sourceId: string
  sourceRef?: string
  sourceKind: RuntimeContextRecallSourceKind
  originalStatus: string
  originalActor?: string
  body: string
  capturedAt: string
  evidenceRefs: string[]
  rawArtifactIds: string[]
  candidateId?: string
  score: number
  reason: string
  /** Complete refers to the cited match; truncated measures the containing original. */
  excerpt: { start: number; totalCharacters: number; truncated: boolean; complete?: boolean }
}

export interface RuntimeContextMemoryRecallResult {
  recallId: string
  query: string
  scope: RuntimeContextScopeKind | 'both'
  sourceKind?: RuntimeContextRecallSourceKind
  candidates: RuntimeContextCandidateMeta[]
  archives?: RuntimeContextArchivedEntryMeta[]
  hits: RuntimeContextRecallHit[]
  uncertainties: string[]
}

export type RuntimeContextEvidenceReviewDecision = 'accept' | 'reject' | 'conflict' | 'needs_more_evidence'

export interface RuntimeContextEvidenceReview {
  documentId: string
  candidateId: string
  baseRevision: number
  decision: RuntimeContextEvidenceReviewDecision
  supportingEvidence?: string[]
  contradictingEvidence?: string[]
  targetEntryIds?: string[]
  rationale?: string
}

export interface RuntimeContextEvidenceReviewResult {
  decision: RuntimeContextEvidenceReviewDecision
  candidateId: string
  supportingEvidence: string[]
  contradictingEvidence: string[]
  targetEntryIds: string[]
  rationale: string
  reviewRevision: number
}

export interface RuntimeContextDreamPlan {
  documentRevision: number
  duplicateCandidateGroups: string[][]
  staleCandidateIds: string[]
  proposalCandidateIds: string[]
  createdAt: string
}

export interface RuntimeContextChildMerge {
  documentId: string
  sourceId: string
  runId: string
  stepId?: string
  rawArtifactId: string
  normalizedContent: string
  evidenceRefs: string[]
}

export interface RuntimeContextProjection {
  scope?: RuntimeContextScopeKind
  id: string
  documentRevision: number
  profileId: string
  sourceEntryIds: string[]
  treeNodes?: RuntimeContextTreeBinding[]
  sourceCandidateIds: string[]
  sourceMessageCursor: number
  truncatedSections: string[]
  selectionReasons: { [key: string]: string[] }
  contentArtifactId?: string
  contentHash: string
  createdAt: string
}

export interface RuntimeContextDiffProposal {
  diffVersion?: 1 | 2
  scope?: RuntimeContextScopeKind
  sourceScope?: RuntimeContextScopeKind
  id: string
  documentId: string
  baseRevision: number
  projectionId: string
  projectionHash: string
  targetEntryHash?: string
  targetNodeHash?: string
  target: { section: 'information'; entryId?: string; headingPath?: string[]; nodeId?: string }
  operation: RuntimeContextDiffOperation
  payload: RuntimeContextDiffPayload
  candidateId: string
  classification?: RuntimeContextClassification
  actor: 'system' | 'model' | 'child-agent' | 'memory'
  idempotencyKey: string
  createdAt: string
}

/** Versioned model control envelope. It is optional on the legacy
 * {status, content} response, but when present it is validated as a single
 * typed decision before the RuntimeLoop can act on it. */
export type RuntimeControlDecision = 'continue' | 'propose_plan' | 'resume_plan' | 'complete_plan_nodes' | 'tool_call' | 'wait' | 'ask_user' | 'propose_diff' | 'reflect' | 'finish'

export interface RuntimeRequestBinding {
  sessionId: string
  taskId: string
  runId: string
  requestId: string
  stateRevision: number
}

export interface RuntimePlanTask {
  id: string
  title: string
  dependsOn: string[]
  completionConditions: string[]
  owner: string
  capabilityIds: string[]
  requiredActions: string[]
  evidenceRefs: string[]
  status: 'pending' | 'completed'
  phase?: 'human_input' | 'investigation' | 'execution' | 'verification'
}

export type RuntimeExecutionPhase = 'direct' | 'planning' | 'human_input' | 'investigation' | 'execution' | 'verification' | 'delegation' | 'evidence' | 'blocked'
export type RuntimeSkillPhase = 'direct' | 'investigation' | 'execution' | 'verification'

export interface RuntimeExecutionState {
  phase: RuntimeExecutionPhase
  planRevision: number
  readyTaskIds: string[]
  activeTaskIds: string[]
  blockedTaskIds: string[]
  allowedDecisions: RuntimeControlDecision[]
  parentTakeover?: { planTaskId: string; childId: string; takeoverId: string }
}

export interface RuntimeCapabilityBinding {
  capabilityId: string
  name: string
  source: 'system' | 'project' | 'mcp'
  sourceVersion: string
  delegationVersion?: string
  schemaHash: string
  permissions: string[]
  sideEffects: 'none' | 'workspace-write' | 'external'
  replay: 'safe' | 'confirm' | 'never'
}

export interface RuntimeCapabilityProjection {
  version: 1
  id: string
  request: RuntimeRequestBinding
  execution: RuntimeExecutionState
  bindings: RuntimeCapabilityBinding[]
}

export interface RuntimeCapabilityAuthorization {
  projection: RuntimeCapabilityProjection
  admittedStateRevision: number
}

export interface RuntimePlanProposal {
  basePlanRevision: number
  goal: string
  tasks: RuntimePlanTask[]
}

export interface RuntimePlanAmendment {
  basePlanRevision: number
  addTasks?: Array<Omit<RuntimePlanTask, 'status' | 'requiredActions' | 'evidenceRefs'>>
  updateTasks?: Array<{ id: string; addCapabilityIds?: string[]; addDependsOn?: string[]; addCompletionConditions?: string[] }>
}

export interface RuntimePlanProgress {
  basePlanRevision: number
  nodes: Array<{ id: string; actionRefs: string[]; evidenceRefs: string[] }>
}

export interface RuntimeBranchBlock {
  id: string
  kind: 'human' | 'wait' | 'evidence'
  taskIds: string[]
  reason: string
  evidenceRequest?: RuntimeEvidenceRequest
}

export interface RuntimeChildAssignment {
  planTaskId: string
  childId: string
  state: 'delegated' | 'accepted' | 'retryable' | 'parent'
  takeoverId?: string
}

export interface RuntimeChildTakeover {
  id: string
  childId: string
  planTaskId: string
  planRevision: number
  reviewReceiptId: string
  callId: string
  requestId: string
  reason: string
  createdAt: string
}

export interface RuntimeTaskControl {
  taskId: string
  stateRevision: number
  planRevision: number
  goal: string
  planGoal?: string
  tasks: RuntimePlanTask[]
  requiredActions: string[]
  requiredEvidenceRefs: string[]
  uncertainties: RuntimeUncertainty[]
  planning?: { required: boolean; reason: string }
  /** Pending node-local control, derived from admitted waits and associated cursors. */
  branchBlocks?: RuntimeBranchBlock[]
  /** Only a host-induced pause may be automatically resumed by a branch signal. */
  branchPaused?: boolean
  /** Derived from durable child jobs and their review receipts. */
  childAssignments?: RuntimeChildAssignment[]
  /** Host-only recovery budget and provenance; never a model-supplied permission. */
  capabilityRecovery?: { attempts: number; errorArtifactId: string; rejectedStepId: string }
}

/** Model proposals only. Completion is decided from the runtime ledger. */
export interface ControlEnvelopeV2 {
  envelopeVersion: 2
  binding: RuntimeRequestBinding
  decision: RuntimeControlDecision
  userMessage: string
  /** Active only when continuing without an evidence request. */
  reasoningNextStep?: string | null
  /** Fill a null field in a final JSON reply from a visible, exact file excerpt. */
  fileQuotes?: Array<
    | { scope: 'project' | 'session'; evidenceId: string; target: string }
    | { scope: 'session'; readArtifactId: string; target: string }
  >
  actions: Array<
    | { kind: 'tool_call'; toolName: string; arguments: JsonObject }
    | { kind: 'ask_user'; question: string; blockingTaskIds: string[] }
  >
  planProposal: RuntimePlanProposal | null
  /** Add work or requirements to the accepted plan without restating its existing nodes. */
  planAmendment?: RuntimePlanAmendment | null
  /** Complete existing active nodes without restating or changing the plan. */
  planProgress?: RuntimePlanProgress | null
  candidateDiffs: Array<Omit<RuntimeContextDiffProposal, 'id' | 'actor' | 'createdAt'> & { planTaskId?: string }>
  evidenceRequests: Array<RuntimeEvidenceRequest & { relatedTaskIds: string[] }>
  uncertainties: Array<Omit<RuntimeUncertainty, 'relatedCandidateIds'> & { relatedTaskIds: string[]; evidenceRefs: string[] }>
  waitSpec: (Omit<RuntimeWaitSpec, 'resumeCondition' | 'timeoutMs'> & { correlationIds: string[]; condition: { eventType: string; status?: string }; deadlineRef: string | null }) | null
  completionCheck: {
    taskId: string
    requiredEvidenceRefs: string[]
    requiredActions: string[]
    unresolvedUncertaintyIds: string[]
    summary: string
  } | null
}

export type RuntimeAction =
  | { kind: 'tool_call'; toolName: string; arguments: JsonValue; capabilityToken?: string }
  | { kind: 'ask_user'; question: string }
  | { kind: 'request_evidence'; requestId: string }

export interface RuntimeWaitSpec {
  reason: string
  signalType: 'runtime' | 'tool' | 'external' | 'user'
  timeoutMs?: number
  resumeCondition: string
  correlationIds?: string[]
  condition?: { eventType: string; status?: string }
  deadlineRef?: string | null
  blockingTaskIds?: string[]
}

export interface RuntimeWaitDeadline {
  id: string
  sessionId: string
  taskId: string
  runId: string
  operationId: string
  timeoutMs: number
  createdAt: string
  expiresAt: string
}

export interface RuntimeWaitSignal {
  id: string
  sessionId: string
  taskId: string
  runId: string
  signalType: RuntimeWaitSpec['signalType']
  eventType: string
  correlationId: string
  status?: string
  data?: JsonValue
  receivedAt: string
}

export interface RuntimeWaitSubscription {
  id: string
  binding: RuntimeRequestBinding
  spec: RuntimeWaitSpec & { correlationIds: string[]; condition: { eventType: string; status?: string } }
  evidenceRequest?: RuntimeEvidenceRequest
  createdAt: string
  deadlineAt?: string
  status: 'pending' | 'satisfied' | 'timed_out' | 'cancelled'
  matchedSignalIds: string[]
  settledAt?: string
  reason?: string
  cancelledBy?: 'run' | 'subscription'
  runCancelledAt?: string
}

export interface RuntimeWaitsState {
  deadlines: RuntimeWaitDeadline[]
  subscriptions: RuntimeWaitSubscription[]
}

export interface RuntimeEnvelopeDiffProposal {
  diffVersion?: 1 | 2
  documentId?: string
  headingPath?: string[]
  scope?: RuntimeContextScopeKind
  sourceScope?: RuntimeContextScopeKind
  baseRevision: number
  projectionId: string
  projectionHash: string
  candidateId: string
  targetEntryId?: string
  targetEntryHash?: string
  targetNodeId?: string
  targetNodeHash?: string
  operation: RuntimeContextDiffOperation
  title?: string
  parentNodeId?: string
  beforeNodeId?: string | null
  childIds?: string[]
  body?: string
  status?: 'active' | 'superseded' | 'archived'
  evidenceRefs: string[]
  classification?: RuntimeContextClassification
  idempotencyKey: string
}

export interface RuntimeEvidenceRequest {
  id: string
  question: string
  targetCandidateId?: string
  sourceKinds: Array<'tool' | 'user' | 'external' | 'memory' | 'child-agent'>
}

export interface RuntimeUncertainty {
  id: string
  statement: string
  relatedCandidateIds: string[]
  blocking: boolean
}

export interface RuntimeCompletionCheck {
  requiredEvidenceRefs: string[]
  requiredActions?: string[]
  unresolvedUncertainties: string[]
  verified: boolean
}

export interface RuntimeEnvelope {
  envelopeVersion: 1
  sessionId: string
  runId: string
  requestId: string
  decision: RuntimeControlDecision
  actions: RuntimeAction[]
  waitSpec?: RuntimeWaitSpec
  candidateDiffs: RuntimeEnvelopeDiffProposal[]
  evidenceRequests: RuntimeEvidenceRequest[]
  uncertainties: RuntimeUncertainty[]
  completionCheck?: RuntimeCompletionCheck
  /** Original V2 control object is retained after adaptation to the execution representation. */
  sourceV2?: ControlEnvelopeV2
}

export interface RuntimeV2ControlState {
  status: 'idle' | 'waiting' | 'awaiting_user' | 'awaiting_evidence' | 'reflecting'
  requestId?: string
  question?: string
  humanRequestId?: string
  taskId?: string
  waitSpec?: RuntimeWaitSpec
  waitId?: string
  evidenceRequests: RuntimeEvidenceRequest[]
  uncertainties: RuntimeUncertainty[]
  reflectionAttempts: number
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
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type RuntimeWorkflowNodeStatus =
  | 'pending'
  | 'running'
  | 'awaiting_input'
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
  recovery?: { stepId: string; nodeId: string } & (
    { operationId: string; inputRequestId?: string } | { operationId?: string; inputRequestId: string }
  )
  continuations?: Array<{
    callId: string
    partialArtifactId: string
  } & ({ verificationReceiptId: string; inputReceiptId?: never } | { verificationReceiptId?: never; inputReceiptId: string })>
}

export interface RuntimeWorkflowsState {
  revision: number
  activePlanId?: string
  items: RuntimeWorkflowPlan[]
}

export type RuntimeChildStatus = 'delegated' | 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'unknown' | 'cancelled' | 'timed_out'

export interface RuntimeChildSession {
  id: string
  parentSessionId: string
  parentRunId?: string
  goal: string
  status: RuntimeChildStatus
  sourceInstructionId?: string
  startedAt?: string
  completedAt?: string
  resultArtifactId?: string
  error?: JsonValue
  parentTaskId?: string
  planTaskId?: string
  takeover?: RuntimeChildTakeover
  childSessionId?: string
  childRunId?: string
  revision?: number
  deadlineAt?: string
  resultHash?: string
  waitRef?: string
  question?: string
  inputRequestId?: string
  consumption?: { decision: 'accept' | 'reject' | 'conflict' | 'needs_more_evidence'; reason: string; consumedAt: string; receiptId?: string }
}

export interface RuntimeChildrenState {
  revision: number
  items: RuntimeChildSession[]
}

export type RuntimeProcessStatus = 'starting' | 'running' | 'waiting' | 'succeeded' | 'stopped' | 'failed' | 'unknown'

export interface RuntimeProcessRecord {
  id: string
  kind: 'application' | 'program' | 'script' | 'tool'
  name: string
  status: RuntimeProcessStatus
  projectId: string
  sessionId?: string
  runId?: string
  pid?: string
  startedAt?: string
  stoppedAt?: string
  error?: JsonValue
  turnId?: string
  stepId?: string
  callId?: string
  detail?: JsonValue
}

export interface RuntimeProcessesState {
  revision: number
  items: RuntimeProcessRecord[]
}

export interface RuntimeStatusState {
  revision: number
  runtime: 'healthy' | 'degraded' | 'unavailable'
  model: 'ready' | 'busy' | 'unavailable'
  modelName?: string
  context: {
    usedTokens: number
    maxTokens: number
    utilization: number
    cacheTokens?: number
    contextWindowTokens?: number
    cacheUtilization?: number
  }
  loopStatus?: 'idle' | 'running' | 'completed'
  activity?: {
    phase:
      | 'idle'
      | 'model_preparing'
      | 'model_waiting'
      | 'model_retry'
      | 'model_streaming'
      | 'model_processing'
      | 'tool_running'
      | 'workflow_running'
      | 'hook_running'
    label?: string
    startedAt: string
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

export type RuntimeSkillConfirmationStatus =
  | 'pending'
  | 'executing'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface RuntimeSkillConfirmation {
  id: string
  kind: 'install' | 'uninstall'
  status: RuntimeSkillConfirmationStatus
  skillName: string
  source?: {
    repo: string
    requestedPath: string
    commit: string
  }
  targetPath: string
  warnings: string[]
  fileCount?: number
  scriptCount?: number
  hasLocalChanges?: boolean
  requestedAt: string
  resolvedAt?: string
  error?: string
}

export interface RuntimeSkillConfirmationsState {
  revision: number
  items: RuntimeSkillConfirmation[]
}

export interface RuntimeBrowserContextView {
  browserInstanceId: string
  projectId: string
  url: string
  title?: string
  allowedOrigins: string[]
  sessionStatus: string
  tabStatus: string
  lastActionId?: string
}

export interface RuntimeSnapshot {
  /** Durable execution events, used by the desktop IPC projection and replay. */
  trace?: ServerEvent[]
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
  mcp?: RuntimeMcpState
  waits?: RuntimeWaitsState
  harnesses: RuntimeHarnessesState
  plugins: RuntimePluginsState
  skills: RuntimeSkillsState
  skillConfirmations: RuntimeSkillConfirmationsState
  artifacts: RuntimeArtifactsState
  contexts: RuntimeContextsState
  /** V2 canonical context metadata; the serialized document remains an artifact. */
  contextDocument?: RuntimeContextDocumentMeta
  /** Project-scoped V2 context metadata; the document is persisted under the project. */
  projectContextDocument?: RuntimeContextDocumentMeta
  /** Human-readable serialized V2 session context document for inspection. */
  contextDocumentMarkdown?: string
  /** Human-readable serialized V2 project context document for inspection. */
  projectContextDocumentMarkdown?: string
  /** Unified structured session context view for desktop and replay consumers. */
  contextDocumentView?: RuntimeContextDocumentView
  /** Unified structured project context view for desktop and replay consumers. */
  projectContextDocumentView?: RuntimeContextDocumentView
  /** Variable-oriented context organization view used by the V2 workbench. */
  contextOrganization?: RuntimeContextOrganizationView
  contextCandidates?: RuntimeContextCandidateMeta[]
  contextEvidence?: RuntimeContextEvidenceRef[]
  contextReceipts?: RuntimeContextApplyReceipt[]
  contextReviewReceipts?: RuntimeContextCandidateReviewReceipt[]
  contextEvidenceReviews?: RuntimeContextEvidenceReviewResult[]
  browserContexts?: RuntimeBrowserContextView[]
  contextControl?: RuntimeV2ControlState
  taskControl?: RuntimeTaskControl
  contextScopes?: RuntimeContextScopesState
  children?: RuntimeChildrenState
  processes?: RuntimeProcessesState
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
  'runtime.mcp.input.reply': { requestId: string; responses: Record<string, RuntimeMcpInputReply> }
  'runtime.wait.signal': { id: string; taskId: string; runId: string; signalType: 'external' | 'user'; eventType: string; correlationId: string; status?: string; data?: JsonValue }
  'runtime.wait.cancel': { waitId: string; reason: string }
  'runtime.snapshot.get': { afterSequence?: number }
  'runtime.artifact.get': { artifactId: string }
  'runtime.artifact.page': { artifactId: string; page: number; pageSize: number }
  'runtime.variable.page': { path: string; page: number; pageSize: number }
  'runtime.context.apply': { contextRevisionId: string }
  'runtime.context.v2.observe': { observation: RuntimeContextObservation }
  'runtime.context.v2.project': { scope?: RuntimeContextScopeKind; profileId: string; maxCharacters: number; includeTools?: boolean; includeStructure?: boolean; candidateSelection?: 'chronological' | 'anchor-latest'; includeStatuses?: ContextCandidateStatus[] }
  'runtime.context.v2.apply': { proposal: RuntimeContextDiffProposal }
  'runtime.context.v2.review': { review: RuntimeContextCandidateReview }
  'runtime.context.v2.memory.recall': RuntimeContextMemoryRecall
  'runtime.context.v2.evidence.review': { review: RuntimeContextEvidenceReview }
  'runtime.context.v2.dream': Record<string, never>
  'runtime.context.v2.child.merge': RuntimeContextChildMerge
  'chat.message.send': {
    clientMessageId: string
    content: ChatContent[]
    autoStart: boolean
    humanRequestId?: string
    planningRequired?: boolean
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
  'runtime.skills.confirm': { confirmationId: string }
  'runtime.skills.cancelConfirmation': { confirmationId: string }
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
  'session.directory.updated': SessionDirectorySnapshot
  'session.message.accepted': SessionMessageDeliveryReceipt
  'session.message.queued': SessionMessageDeliveryReceipt
  'session.message.delivered': SessionMessageDeliveryReceipt & { envelope: SessionMessageEnvelope }
  'session.message.processing': SessionMessageDeliveryReceipt & { envelope: SessionMessageEnvelope }
  'session.message.completed': SessionMessageDeliveryReceipt & { envelope: SessionMessageEnvelope; callbackId?: string; callbackText?: string }
  'session.message.rejected': SessionMessageDeliveryReceipt
  'session.message.failed': SessionMessageDeliveryReceipt
  'session.message.expired': SessionMessageDeliveryReceipt
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
  'runtime.context.documents.updated': Pick<RuntimeSnapshot, 'contextDocumentView' | 'projectContextDocumentView'>
  'runtime.artifact.created': { artifact: RuntimeArtifactMeta }
  'runtime.artifact.content': { artifact: RuntimeArtifactMeta; value: JsonValue }
  'runtime.artifact.page': RuntimeArtifactPage
  'runtime.variable.page': RuntimeVariablePage
  'runtime.context.revision.created': { revision: number; context: RuntimeContextRevision }
  'runtime.context.applied': {
    revision: number
    contextRevisionId: string
    previousContextRevisionId?: string
  }
  'runtime.context.v2.observed': { candidate: RuntimeContextCandidateMeta; evidence?: RuntimeContextEvidenceRef }
  'runtime.context.v2.projection.created': { projection: RuntimeContextProjection; markdownArtifactId: string }
  'runtime.context.v2.receipt.created': { receipt: RuntimeContextApplyReceipt }
  'runtime.context.v2.candidate.reviewed': { receipt: RuntimeContextCandidateReviewReceipt }
  'runtime.context.v2.memory.recalled': RuntimeContextMemoryRecallResult
  'runtime.context.v2.child.merged': { candidate: RuntimeContextCandidateMeta }
  'runtime.context.v2.evidence.reviewed': { result: RuntimeContextEvidenceReviewResult }
  'runtime.context.v2.control.pending': { control: RuntimeV2ControlState }
  'runtime.context.v2.control.cleared': { requestId?: string }
  'runtime.context.v2.dream.created': { plan: RuntimeContextDreamPlan; artifactId: string }
  'runtime.effectiveContext.created': {
    revision: number
    context: RuntimeEffectiveContextRevision
  }
  'runtime.observation.upserted': {
    revision: number
    observation: RuntimeObservation
  }
  'runtime.workflows.updated': RuntimeWorkflowsState
  'runtime.children.updated': RuntimeChildrenState
  'runtime.processes.updated': RuntimeProcessesState
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
    channel: 'thinkingSummary' | 'commentary' | 'final'
    chunkIndex: number
    delta: string
    source?: 'runtime' | 'model'
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
    evidenceRefs?: string[]
  }
  'chat.assistant.failed': {
    messageId: string
    code: string
    message: string
    retryable: boolean
    failure: RuntimeFailure
  }
  'run.state.changed': RunState
  'run.trace.started': {
    run: RunState
    timeline: RuntimeSnapshot['timeline']
    artifacts: RuntimeSnapshot['artifacts']
    contexts: RuntimeContextsState
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
    turnId?: string
    stepId?: string
  }
  'tool.call.completed': {
    callId: string
    toolName: string
    result: JsonValue
    /** Deterministic runtime receipt, including process outcome when present. */
    receipt?: JsonValue
    startedAt: string
    completedAt: string
    durationMs: number
    turnId?: string
    stepId?: string
  }
  'tool.call.failed': {
    callId: string
    toolName: string
    code: string
    message: string
    details?: JsonValue
    /** Deterministic runtime receipt, including termination state when present. */
    receipt?: JsonValue
    startedAt: string
    completedAt: string
    durationMs: number
    turnId?: string
    stepId?: string
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
  'runtime.mcp.updated': RuntimeMcpState
  'runtime.waits.updated': RuntimeWaitsState
  'runtime.wait.deadline.created': { deadline: RuntimeWaitDeadline }
  'runtime.wait.signal.recorded': { signal: RuntimeWaitSignal; duplicate: boolean }
  'runtime.harnesses.updated': RuntimeHarnessesState
  'runtime.plugins.updated': RuntimePluginsState
  'runtime.skills.updated': RuntimeSkillsState
  'runtime.skills.confirmations.updated': RuntimeSkillConfirmationsState
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
        turnId?: string
        stepId?: string
        parentTurnId?: string
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
  turnId?: string
  stepId?: string
  parentTurnId?: string
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
  'runtime.mcp.input.reply',
  'runtime.wait.signal',
  'runtime.wait.cancel',
  'runtime.snapshot.get',
  'runtime.artifact.get',
  'runtime.artifact.page',
  'runtime.variable.page',
  'runtime.context.apply',
  'runtime.context.v2.observe',
  'runtime.context.v2.project',
  'runtime.context.v2.apply',
  'runtime.context.v2.review',
  'runtime.context.v2.memory.recall',
  'runtime.context.v2.child.merge',
  'runtime.context.v2.evidence.review',
  'runtime.context.v2.dream',
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
  'runtime.skills.confirm',
  'runtime.skills.cancelConfirmation',
])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'string' && Boolean((value[key] as string).trim())
}

function validateClassificationPayload(value: unknown, label: string): void {
  if (!isObject(value)
    || !['project', 'session', 'transient'].includes(String(value.durability))
    || !['project', 'session', 'cache'].includes(String(value.target))
    || !['low', 'medium', 'high'].includes(String(value.confidence))
    || !hasString(value, 'reason')
    || !Array.isArray(value.projectAnchors)
    || value.projectAnchors.some((anchor) => typeof anchor !== 'string' || !anchor.trim())) {
    throw new CommandError('INVALID_PAYLOAD', `${label} is invalid`)
  }
}

function hasInteger(value: Record<string, unknown>, key: string): boolean {
  return Number.isInteger(value[key]) && Number(value[key]) >= 0
}

function assertStringArray(value: unknown, name: string, options: { allowEmpty?: boolean } = {}): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim()) || (options.allowEmpty === false && value.length === 0)) {
    throw new CommandError('INVALID_PAYLOAD', `${name} must be a ${options.allowEmpty === false ? 'non-empty ' : ''}string[]`)
  }
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
    case 'runtime.mcp.input.reply': {
      if (typeof payload.requestId !== 'string' || !/^mcp-input-[a-f0-9-]{36}$/.test(payload.requestId)
        || !isObject(payload.responses) || Object.keys(payload).some(key => !['requestId', 'responses'].includes(key))) {
        throw new CommandError('INVALID_PAYLOAD', 'MCP input reply requires a request ID and response map')
      }
      const entries = Object.entries(payload.responses)
      if (!entries.length || entries.length > 8) throw new CommandError('INVALID_PAYLOAD', 'MCP input reply has an invalid response count')
      for (const [id, value] of entries) {
        if (!id.trim() || id.length > 128 || !isObject(value) || !['accept', 'decline', 'cancel'].includes(String(value.action))
          || Object.keys(value).some(key => !['action', 'content'].includes(key))
          || (value.content !== undefined && (value.action !== 'accept' || !isObject(value.content)))) {
          throw new CommandError('INVALID_PAYLOAD', 'Invalid MCP input response')
        }
        if (isObject(value.content)) {
          const fields = Object.values(value.content)
          const scalar = (item: unknown) => typeof item === 'string' && item.length <= 4096 || typeof item === 'number' && Number.isFinite(item) || typeof item === 'boolean'
          if (fields.length > 24 || fields.some(field => !scalar(field) && !(Array.isArray(field) && field.length <= 24
            && field.every(item => typeof item === 'string' && item.length <= 128)))) throw new CommandError('INVALID_PAYLOAD', 'Invalid MCP form values')
        }
      }
      if (JSON.stringify(payload).length > 32768) throw new CommandError('INVALID_PAYLOAD', 'MCP form reply exceeds the size limit')
      return
    }
    case 'runtime.wait.signal': {
      for (const key of ['id', 'taskId', 'runId', 'eventType', 'correlationId']) if (!hasString(payload, key) || String(payload[key]).length > 512) throw new CommandError('INVALID_PAYLOAD', `wait signal requires bounded ${key}`)
      if (!['external', 'user'].includes(String(payload.signalType))) throw new CommandError('INVALID_PAYLOAD', 'client wait signals must be external or user observations')
      if (/^(tool|runtime):/.test(String(payload.id))) throw new CommandError('INVALID_PAYLOAD', 'client wait signal IDs cannot use a host namespace')
      if (payload.status !== undefined && (!hasString(payload, 'status') || String(payload.status).length > 128)) throw new CommandError('INVALID_PAYLOAD', 'wait signal status must be bounded text')
      if (JSON.stringify(payload).length > 8192) throw new CommandError('INVALID_PAYLOAD', 'wait signal exceeds 8192 characters')
      if (Object.keys(payload).some(key => !['id', 'taskId', 'runId', 'signalType', 'eventType', 'correlationId', 'status', 'data'].includes(key))) throw new CommandError('INVALID_PAYLOAD', 'unknown wait signal field')
      return
    }
    case 'runtime.wait.cancel':
      if (!hasString(payload, 'waitId') || !hasString(payload, 'reason') || String(payload.reason).length > 500 || Object.keys(payload).some(key => !['waitId', 'reason'].includes(key))) throw new CommandError('INVALID_PAYLOAD', 'wait cancellation requires waitId and bounded reason')
      return
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
    case 'runtime.artifact.page':
      if (!hasString(payload, 'artifactId') || !hasInteger(payload, 'page') || !hasInteger(payload, 'pageSize')) {
        throw new CommandError('INVALID_PAYLOAD', 'runtime.artifact.page requires artifactId, page, and pageSize')
      }
      if (Number(payload.page) < 1 || Number(payload.pageSize) < 1 || Number(payload.pageSize) > 100) {
        throw new CommandError('INVALID_PAYLOAD', 'artifact page must be between 1 and 100')
      }
      return
    case 'runtime.variable.page':
      if (!hasString(payload, 'path') || !String(payload.path).startsWith('/') || !hasInteger(payload, 'page') || !hasInteger(payload, 'pageSize')) {
        throw new CommandError('INVALID_PAYLOAD', 'runtime.variable.page requires an absolute path, page, and pageSize')
      }
      if (Number(payload.page) < 1 || Number(payload.pageSize) < 1 || Number(payload.pageSize) > 8_000) {
        throw new CommandError('INVALID_PAYLOAD', 'variable page must be between 1 and 8000')
      }
      return
    case 'runtime.context.apply':
      if (!hasString(payload, 'contextRevisionId')) {
        throw new CommandError('INVALID_PAYLOAD', 'runtime.context.apply requires contextRevisionId')
      }
      return
    case 'runtime.context.v2.observe': {
      if (!isObject(payload.observation)) throw new CommandError('INVALID_PAYLOAD', 'runtime.context.v2.observe requires observation')
      const observation = payload.observation
      if (observation.documentId !== undefined && typeof observation.documentId !== 'string') {
        throw new CommandError('INVALID_PAYLOAD', 'observation documentId must be a string')
      }
      if (!isObject(observation.candidate) || !isObject(observation.candidate.source)) {
        throw new CommandError('INVALID_PAYLOAD', 'observation candidate and source are required')
      }
      const source = observation.candidate.source
      for (const key of ['sourceId', 'capturedAt']) {
        if (!hasString(source, key)) throw new CommandError('INVALID_PAYLOAD', `observation source requires ${key}`)
      }
      if (!['user', 'tool', 'model', 'system', 'child-agent', 'memory'].includes(String(source.actor))) {
        throw new CommandError('INVALID_PAYLOAD', 'observation source actor is invalid')
      }
      for (const key of ['toolName', 'runId', 'stepId']) {
        if (source[key] !== undefined && typeof source[key] !== 'string') throw new CommandError('INVALID_PAYLOAD', `observation source ${key} must be a string`)
      }
      for (const key of ['rawArtifactId', 'normalizedContent']) {
        if (!hasString(observation.candidate, key)) throw new CommandError('INVALID_PAYLOAD', `observation candidate requires ${key}`)
      }
      if (observation.candidate.classification !== undefined) validateClassificationPayload(observation.candidate.classification, 'observation classification')
      if (observation.evidence !== undefined) {
        if (!isObject(observation.evidence)) throw new CommandError('INVALID_PAYLOAD', 'observation evidence must be an object')
        for (const key of ['kind', 'referenceId']) {
          if (!hasString(observation.evidence, key)) throw new CommandError('INVALID_PAYLOAD', `observation evidence requires ${key}`)
        }
        if (!['observation', 'artifact', 'message', 'external'].includes(String(observation.evidence.kind))) {
          throw new CommandError('INVALID_PAYLOAD', 'observation evidence kind is invalid')
        }
        for (const key of ['sourceHash', 'observedAt', 'locator']) {
          if (observation.evidence[key] !== undefined && typeof observation.evidence[key] !== 'string') throw new CommandError('INVALID_PAYLOAD', `observation evidence ${key} must be a string`)
        }
        if (observation.evidence.confidence !== undefined && !['low', 'medium', 'high'].includes(String(observation.evidence.confidence))) {
          throw new CommandError('INVALID_PAYLOAD', 'observation evidence confidence is invalid')
        }
      }
      return
    }
    case 'runtime.context.v2.project':
      if (!hasString(payload, 'profileId') || !hasInteger(payload, 'maxCharacters')) {
        throw new CommandError('INVALID_PAYLOAD', 'runtime.context.v2.project requires profileId and maxCharacters')
      }
      if (Number(payload.maxCharacters) < 256 || Number(payload.maxCharacters) > 10_000_000) {
        throw new CommandError('INVALID_PAYLOAD', 'maxCharacters must be between 256 and 10000000')
      }
      if (payload.includeTools !== undefined && typeof payload.includeTools !== 'boolean') {
        throw new CommandError('INVALID_PAYLOAD', 'includeTools must be a boolean')
      }
      if (payload.includeStructure !== undefined && typeof payload.includeStructure !== 'boolean') throw new CommandError('INVALID_PAYLOAD', 'includeStructure must be a boolean')
      if (payload.candidateSelection !== undefined && !['chronological', 'anchor-latest'].includes(String(payload.candidateSelection))) {
        throw new CommandError('INVALID_PAYLOAD', 'candidateSelection is invalid')
      }
      if (payload.includeStatuses !== undefined && (!Array.isArray(payload.includeStatuses) || payload.includeStatuses.some((status) => !['pending', 'accepted', 'rejected', 'conflict', 'stale', 'irrelevant', 'superseded'].includes(String(status))))) {
        throw new CommandError('INVALID_PAYLOAD', 'includeStatuses is invalid')
      }
      return
    case 'runtime.context.v2.apply': {
      if (!isObject(payload.proposal)) throw new CommandError('INVALID_PAYLOAD', 'runtime.context.v2.apply requires proposal')
      const proposal = payload.proposal
      if (proposal.sourceScope !== undefined && !['project', 'session'].includes(String(proposal.sourceScope))) throw new CommandError('INVALID_PAYLOAD', 'proposal sourceScope is invalid')
      if (proposal.classification !== undefined) validateClassificationPayload(proposal.classification, 'proposal classification')
      for (const key of ['id', 'documentId', 'candidateId', 'idempotencyKey', 'createdAt', 'projectionId', 'projectionHash']) {
        if (!hasString(proposal, key)) throw new CommandError('INVALID_PAYLOAD', `proposal requires ${key}`)
      }
      if (!hasInteger(proposal, 'baseRevision') || Number(proposal.baseRevision) < 0 || !/^[a-f0-9]{64}$/.test(String(proposal.projectionHash)) || !isObject(proposal.target) || proposal.target.section !== 'information' || !isObject(proposal.payload)) {
        throw new CommandError('INVALID_PAYLOAD', 'proposal target and baseRevision are invalid')
      }
      if (proposal.target.entryId !== undefined && !hasString(proposal.target, 'entryId')) throw new CommandError('INVALID_PAYLOAD', 'proposal target entryId must be a non-empty string')
      if (proposal.target.headingPath !== undefined) {
        assertStringArray(proposal.target.headingPath, 'proposal target headingPath')
      }
      if (proposal.targetEntryHash !== undefined && (typeof proposal.targetEntryHash !== 'string' || !/^[a-f0-9]{64}$/.test(proposal.targetEntryHash))) {
        throw new CommandError('INVALID_PAYLOAD', 'proposal targetEntryHash must be a sha256 hex string')
      }
      if (!(CONTEXT_DIFF_OPERATIONS as readonly string[]).includes(String(proposal.operation))) {
        throw new CommandError('INVALID_PAYLOAD', 'proposal operation is invalid')
      }
      const proposalPayload = proposal.payload
      if (proposal.diffVersion !== undefined && ![1, 2].includes(Number(proposal.diffVersion))) throw new CommandError('INVALID_PAYLOAD', 'proposal diffVersion is invalid')
      if ((CONTEXT_TREE_OPERATIONS as readonly string[]).includes(String(proposal.operation))
        && (proposal.diffVersion !== 2 || !hasString(proposal.target, 'nodeId') || !/^[a-f0-9]{64}$/.test(String(proposal.targetNodeHash)))) throw new CommandError('INVALID_PAYLOAD', 'structural diff requires version 2 and bound node/hash')
      if (proposalPayload.title !== undefined && (!hasString(proposalPayload, 'title') || String(proposalPayload.title).length > 200)) throw new CommandError('INVALID_PAYLOAD', 'proposal title is invalid')
      if (proposalPayload.parentNodeId !== undefined && !hasString(proposalPayload, 'parentNodeId')) throw new CommandError('INVALID_PAYLOAD', 'proposal parentNodeId is invalid')
      if (proposalPayload.beforeNodeId !== undefined && proposalPayload.beforeNodeId !== null && !hasString(proposalPayload, 'beforeNodeId')) throw new CommandError('INVALID_PAYLOAD', 'proposal beforeNodeId is invalid')
      if (proposalPayload.childIds !== undefined) assertStringArray(proposalPayload.childIds, 'proposal childIds', { allowEmpty: false })
      if (proposalPayload.classification !== undefined) validateClassificationPayload(proposalPayload.classification, 'proposal payload classification')
      if (proposalPayload.body !== undefined && typeof proposalPayload.body !== 'string') throw new CommandError('INVALID_PAYLOAD', 'proposal payload body must be a string')
      if (proposalPayload.evidenceRefs !== undefined) assertStringArray(proposalPayload.evidenceRefs, 'proposal payload evidenceRefs')
      if (proposalPayload.status !== undefined && !['active', 'superseded', 'archived'].includes(String(proposalPayload.status))) throw new CommandError('INVALID_PAYLOAD', 'proposal payload status is invalid')
      if (proposal.operation === 'add_entry' && typeof proposalPayload.body !== 'string') throw new CommandError('INVALID_PAYLOAD', 'add_entry requires a string body')
      if (proposal.operation === 'append_evidence') {
        if (proposalPayload.evidenceRefs === undefined) throw new CommandError('INVALID_PAYLOAD', 'append_evidence requires evidenceRefs')
        assertStringArray(proposalPayload.evidenceRefs, 'append_evidence evidenceRefs', { allowEmpty: false })
      }
      if (proposal.operation === 'mark_status' && proposalPayload.status === undefined) throw new CommandError('INVALID_PAYLOAD', 'mark_status requires status')
      if (!['system', 'model', 'child-agent', 'memory'].includes(String(proposal.actor))) {
        throw new CommandError('INVALID_PAYLOAD', 'proposal actor is invalid')
      }
      return
    }
    case 'runtime.context.v2.review': {
      if (!isObject(payload.review)) throw new CommandError('INVALID_PAYLOAD', 'runtime.context.v2.review requires review')
      const review = payload.review
      for (const key of ['documentId', 'candidateId']) {
        if (!hasString(review, key)) throw new CommandError('INVALID_PAYLOAD', `review requires ${key}`)
      }
      if (!hasInteger(review, 'baseRevision') || Number(review.baseRevision) < 0 || !['accepted', 'rejected', 'conflict', 'stale', 'irrelevant', 'superseded'].includes(String(review.status))) {
        throw new CommandError('INVALID_PAYLOAD', 'review baseRevision or status is invalid')
      }
      if (review.reason !== undefined && typeof review.reason !== 'string') throw new CommandError('INVALID_PAYLOAD', 'review reason must be a string')
      return
    }
    case 'runtime.context.v2.memory.recall':
      if (!hasString(payload, 'query') || String(payload.query).length > CONTEXT_RECALL_MAX_QUERY_CHARACTERS) {
        throw new CommandError('INVALID_PAYLOAD', `memory recall requires a query of at most ${CONTEXT_RECALL_MAX_QUERY_CHARACTERS} characters`)
      }
      if (payload.scope !== undefined && (typeof payload.scope !== 'string' || !['project', 'session', 'both'].includes(payload.scope))) {
        throw new CommandError('INVALID_PAYLOAD', 'memory recall scope must be project, session or both')
      }
      if (payload.sourceKind !== undefined && !CONTEXT_RECALL_SOURCE_KINDS.some(kind => kind === payload.sourceKind)) {
        throw new CommandError('INVALID_PAYLOAD', 'memory recall sourceKind must be information, candidate or source_archive')
      }
      if (payload.limit !== undefined && (!hasInteger(payload, 'limit') || Number(payload.limit) < 1 || Number(payload.limit) > CONTEXT_RECALL_MAX_RESULTS)) {
        throw new CommandError('INVALID_PAYLOAD', `memory recall limit must be between 1 and ${CONTEXT_RECALL_MAX_RESULTS}`)
      }
      return
    case 'runtime.context.v2.child.merge': {
      for (const key of ['documentId', 'sourceId', 'runId', 'rawArtifactId', 'normalizedContent']) {
        if (!hasString(payload, key)) throw new CommandError('INVALID_PAYLOAD', `runtime.context.v2.child.merge requires ${key}`)
      }
      if (!Array.isArray(payload.evidenceRefs) || payload.evidenceRefs.some((id) => typeof id !== 'string')) {
        throw new CommandError('INVALID_PAYLOAD', 'child merge evidenceRefs must be string[]')
      }
      if (payload.stepId !== undefined && typeof payload.stepId !== 'string') throw new CommandError('INVALID_PAYLOAD', 'child merge stepId must be a string')
      return
    }
    case 'runtime.context.v2.evidence.review': {
      if (!isObject(payload.review)) throw new CommandError('INVALID_PAYLOAD', 'runtime.context.v2.evidence.review requires review')
      const review = payload.review
      for (const key of ['documentId', 'candidateId']) {
        if (!hasString(review, key)) throw new CommandError('INVALID_PAYLOAD', `evidence review requires ${key}`)
      }
      if (!hasInteger(review, 'baseRevision') || Number(review.baseRevision) < 0 || !['accept', 'reject', 'conflict', 'needs_more_evidence'].includes(String(review.decision))) {
        throw new CommandError('INVALID_PAYLOAD', 'evidence review baseRevision or decision is invalid')
      }
      for (const key of ['supportingEvidence', 'contradictingEvidence', 'targetEntryIds']) {
        if (review[key] !== undefined && (!Array.isArray(review[key]) || review[key].some((id) => typeof id !== 'string'))) throw new CommandError('INVALID_PAYLOAD', `evidence review ${key} must be string[]`)
      }
      if (review.rationale !== undefined && typeof review.rationale !== 'string') throw new CommandError('INVALID_PAYLOAD', 'evidence review rationale must be a string')
      return
    }
    case 'runtime.context.v2.dream':
      assertEmptyPayload(payload)
      return
    case 'chat.message.send': {
      if (payload.planningRequired !== undefined && typeof payload.planningRequired !== 'boolean') throw new CommandError('INVALID_PAYLOAD', 'planningRequired must be boolean')
      if (payload.humanRequestId !== undefined && !hasString(payload, 'humanRequestId')) {
        throw new CommandError('INVALID_PAYLOAD', 'humanRequestId must be a non-empty string')
      }
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
      return
    case 'runtime.skills.confirm':
    case 'runtime.skills.cancelConfirmation':
      if (!hasString(payload, 'confirmationId')) {
        throw new CommandError('INVALID_PAYLOAD', `${type} requires confirmationId`)
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
