import type {
  JsonObject,
  JsonValue,
  RuntimeArtifactMeta,
  RuntimeEffectiveContextRevision,
  RuntimeFailure,
  RuntimeObservation,
  TimelineStep,
} from '#protocol/runtime-protocol'

export type ExperimentStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type ExperimentCaseStatus =
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'error'
  | 'cancelled'

export type ExperimentToolStatus = 'hit' | 'missed' | 'unexpected' | 'none'

export interface ExperimentUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens: number
}

export interface ExperimentMetrics extends ExperimentUsage {
  agentUsage: ExperimentUsage
  scoringUsage: ExperimentUsage
  agentTokensPerCase: number
  scoringTokensPerCase: number
  averageScore: number
  passRate: number
  errorRate: number
  toolPrecision: number | null
  toolRecall: number | null
  p95LatencyMs: number
  passed: number
  failed: number
  errors: number
  cancelled: number
  regressions: number
  scoreBins: number[]
  custom: JsonObject
}

export interface ExperimentAdapterSnapshot {
  type: 'project'
  manifest: string
  entry: string
  revision: string
  timeoutMs: number
  phases: Array<'prepare' | 'evaluate' | 'cleanup' | 'aggregate' | 'reference'>
}

export type ExperimentEvaluatorSnapshot =
  | { type: 'llm' }
  | ExperimentAdapterSnapshot

export interface ExperimentReferenceRequirement {
  ordinal: number
  status: 'passed' | 'failed' | 'unknown'
  description: string
  label?: string
  trace?: string
}

export interface ExperimentStateChange {
  application: string
  model: string
  records: number
  added: number
  updated: number
  removed: number
  recordChanges?: ExperimentStateRecordChange[]
  truncatedRecords?: number
}

export interface ExperimentStateFieldChange {
  field: string
  before?: JsonValue
  after?: JsonValue
}

export interface ExperimentStateRecordChange {
  recordId?: JsonValue
  operation: 'added' | 'updated' | 'removed'
  fields: ExperimentStateFieldChange[]
  truncatedFields?: number
}

export interface ExperimentReference {
  kind: 'text' | 'state' | 'unavailable'
  status: 'available' | 'unavailable' | 'load_failed'
  source: {
    type: 'dataset' | 'official_evaluator'
    benchmark?: string
    taskId?: string
    resolverRevision?: string
    artifacts?: string[]
  }
  displayValue?: string
  value?: JsonValue
  requirements: ExperimentReferenceRequirement[]
  expectedState?: JsonValue
  actualStateChanges: ExperimentStateChange[]
  stateChangesStatus?: 'complete' | 'summary_only' | 'unavailable'
  stateChangesError?: string
  failureTraces: string[]
  error?: string
  resolvedAt: string
}

export interface ExperimentAdapterEvaluation {
  score: number
  passed: boolean
  rationale: string
  metrics: JsonObject
  details?: JsonValue
  reference?: ExperimentReference
}

export interface ExperimentFailure {
  code: string
  message: string
  phase?: string
  retryable?: boolean
}

export interface ExperimentConfig {
  concurrency: number
  repetitions: number
  timeoutMs: number
  keepWorkspaces: boolean
  sampleIds: string[]
}

export interface ExperimentRunSummary {
  id: string
  name: string
  status: ExperimentStatus
  dataset: {
    id: string
    name: string
    version: number
    contentHash: string
    cohortHash: string
    scoringPromptHash: string
    samples: number
  }
  project: {
    commitSha: string
    shortSha: string
    treeSha: string
    branch: string | null
  }
  model: {
    provider: string
    protocol: string
    model: string
    baseUrl: string
  }
  evaluator: ExperimentEvaluatorSnapshot
  config: ExperimentConfig
  progress: {
    total: number
    completed: number
  }
  metrics: ExperimentMetrics
  failure?: ExperimentFailure
  createdAt: string
  startedAt?: string
  completedAt?: string
  updatedAt: string
}

export interface ExperimentRunDetail extends ExperimentRunSummary {
  scoringPrompt: string
}

export interface ExperimentToolCall {
  callId: string
  name: string
  status: 'completed' | 'failed'
  arguments: unknown
  resultPreview?: string
  error?: unknown
  startedAt: string
  completedAt?: string
  durationMs?: number
}

export interface ExperimentTrace {
  runtimeRunId?: string
  failure?: RuntimeFailure
  timeline: TimelineStep[]
  observations: RuntimeObservation[]
  effectiveContexts: RuntimeEffectiveContextRevision[]
  artifacts: Array<{ meta: RuntimeArtifactMeta; value: unknown }>
  renderedMessages: Array<{ role: string; content: string }>
  scoring?: {
    prompt: string
    response: string
    usage: ExperimentUsage
  }
  adapter?: {
    prepare?: JsonValue
    evaluation?: ExperimentAdapterEvaluation
  }
}

export interface ExperimentCaseSummary {
  id: string
  runId: string
  sampleId: string
  repetition: number
  ordinal: number
  status: ExperimentCaseStatus
  score?: number
  passed?: boolean
  rationale?: string
  toolStatus: ExperimentToolStatus
  expectedTools: string[]
  actualTools: string[]
  usage: ExperimentUsage
  agentUsage: ExperimentUsage
  scoringUsage: ExperimentUsage
  latencyMs: number
  runtimeRunId?: string
  failure?: ExperimentFailure
  createdAt: string
  startedAt?: string
  completedAt?: string
}

export interface ExperimentCaseDetail extends ExperimentCaseSummary {
  question: string
  thinking: string
  expectedAnswer: string
  actualAnswer: string
  metadata: JsonObject
  evaluation?: {
    source: 'llm' | 'project'
    metrics: JsonObject
    details?: JsonValue
    reference?: ExperimentReference
  }
  toolCalls: ExperimentToolCall[]
  trace: ExperimentTrace | null
}

export interface ExperimentToolAggregate {
  name: string
  expected: number
  hit: number
  missed: number
  unexpected: number
  errors: number
  calls: number
  averageLatencyMs: number
  precision: number
  recall: number
}

export interface ExperimentComparison {
  dataset: ExperimentRunSummary['dataset']
  left: ExperimentRunSummary
  right: ExperimentRunSummary
  samples: Array<{
    sampleId: string
    left?: { caseId: string; score?: number; status: ExperimentCaseStatus }
    right?: { caseId: string; score?: number; status: ExperimentCaseStatus }
    delta?: number
  }>
  tools: Array<{
    name: string
    left?: ExperimentToolAggregate
    right?: ExperimentToolAggregate
  }>
}

export type ExperimentCompatibilityIssue = 'sample_cohort' | 'repetitions' | 'evaluator'

export interface ExperimentTrend {
  datasetId: string
  anchorRunId?: string
  runs: ExperimentRunSummary[]
  excluded: Array<{
    run: ExperimentRunSummary
    issues: ExperimentCompatibilityIssue[]
  }>
}
