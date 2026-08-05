import type {
  ExperimentEvaluatorSnapshot,
  ExperimentFailure,
  ExperimentRunSummary,
  ExperimentToolCall,
  ExperimentUsage,
} from '#core/experiments/types'

export const MAX_TRAINING_CASES = 10
export const MAX_TEST_CASES = 5

export type TrainingLearningMode = 'review' | 'author' | 'auto'
export type TrainingReviewScope = 'all' | 'failed'
export type TrainingPhase = 'training' | 'testing'
export type TrainingVariableSource = 'project' | 'run'

export type TrainingRunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'paused_failure'
  | 'waiting_review'
  | 'ready_to_freeze'
  | 'ready_for_test'
  | 'testing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type TrainingCaseStatus =
  | 'queued'
  | 'running'
  | 'evaluated'
  | 'learning'
  | 'replaying'
  | 'waiting_review'
  | 'completed'
  | 'error'

export type ExperienceStatus =
  | 'draft'
  | 'replaying'
  | 'replay_failed'
  | 'pending_review'
  | 'accepted'
  | 'rejected'
  | 'applied'
  | 'conflict'

export interface TrainingHookBinding {
  hookId: string
  parameters: Record<string, string>
}

export interface TrainingConfig {
  trainDatasetId: string
  testDatasetId: string
  trainLimit: number
  testLimit: number
  learningMode: TrainingLearningMode
  reviewScope: TrainingReviewScope
  pauseOnFailure: boolean
  variableSource: TrainingVariableSource
  variableSourceRunId?: string
  correctionHook?: TrainingHookBinding
  experienceExtractorHook: TrainingHookBinding
  timeoutMs: number
  concurrency: 1
}

export interface CreateTrainingInput {
  name?: unknown
  trainDatasetId?: unknown
  testDatasetId?: unknown
  trainLimit?: unknown
  testLimit?: unknown
  learningMode?: unknown
  reviewScope?: unknown
  pauseOnFailure?: unknown
  variableSource?: unknown
  variableSourceRunId?: unknown
  correctionHook?: unknown
  experienceExtractorHook?: unknown
  timeoutMs?: unknown
}

export interface TrainingProgress {
  training: { total: number; completed: number }
  testing: { total: number; completed: number }
  pendingReview: number
  acceptedExperiences: number
  rejectedExperiences: number
}

export interface TrainingRun {
  id: string
  name: string
  status: TrainingRunStatus
  config: TrainingConfig
  progress: TrainingProgress
  currentCaseId?: string
  pauseReason?: string
  snapshotId?: string
  failure?: ExperimentFailure
  createdAt: string
  startedAt?: string
  completedAt?: string
  updatedAt: string
}

export interface TrainingCase {
  id: string
  runId: string
  phase: TrainingPhase
  datasetId: string
  sampleId: string
  ordinal: number
  status: TrainingCaseStatus
  question: string
  thinking: string
  expectedAnswer: string
  actualAnswer: string
  expectedTools: string[]
  actualTools: string[]
  toolCalls: ExperimentToolCall[]
  usage: ExperimentUsage
  score?: number
  passed?: boolean
  rationale?: string
  experimentRunId?: string
  experimentCaseId?: string
  failurePauseHandled: boolean
  attempt: number
  failure?: ExperimentFailure
  createdAt: string
  startedAt?: string
  completedAt?: string
  updatedAt: string
}

export interface TrainingCaseView extends TrainingCase {
  referenceAvailable: boolean
}

export interface VariableDiff {
  variableName: string
  baseHash: string
  unifiedDiff: string
  beforeValue?: string
  afterValue?: string
}

export interface ExperienceCandidate {
  id: string
  runId: string
  sourceCaseId: string
  sourceOutcome: 'success' | 'failure'
  hookId: string
  summary: string
  rationale: string
  patches: VariableDiff[]
  status: ExperienceStatus
  replayCaseId?: string
  replayPassed?: boolean
  replayScore?: number
  replayRationale?: string
  createdAt: string
  updatedAt: string
}

export interface VariableWriteAudit {
  id: string
  runId: string
  candidateId: string
  sourceCaseId: string
  variableName: string
  beforeValue: string
  afterValue: string
  unifiedDiff: string
  beforeHash: string
  afterHash: string
  createdAt: string
}

export type TrainingVariableState = ExperienceStatus | 'unchanged'

export interface TrainingVariableView {
  name: string
  baselineValue: string
  runValue: string
  projectValue: string
  snapshotValue?: string
  sourceCaseIds: string[]
  candidateIds: string[]
  state: TrainingVariableState
  changed: boolean
}

export interface TrainingVariableReport {
  items: TrainingVariableView[]
}

export interface TestSnapshot {
  id: string
  runId: string
  variables: Record<string, string>
  contentHash: string
  createdAt: string
}

export interface TrainingEvent {
  id: number
  runId: string
  type: string
  payload: unknown
  createdAt: string
}

export interface TrainingCaseMetrics {
  total: number
  completed: number
  evaluated: number
  passed: number
  failed: number
  errors: number
  averageScore: number
  passRate: number
  usage: ExperimentUsage
  toolCalls: number
  toolErrors: number
  expectedTools: number
  matchedTools: number
}

export interface TrainingExperienceMetrics {
  generated: number
  replayed: number
  replayPassed: number
  pending: number
  applied: number
  rejected: number
  conflicts: number
  successSources: number
  failureSources: number
}

export interface TrainingRunAnalysisSummary {
  run: TrainingRun
  trainDataset: { id: string; name: string; version: number; samples: number }
  testDataset: { id: string; name: string; version: number; samples: number }
  training: TrainingCaseMetrics
  testing: TrainingCaseMetrics
  experiences: TrainingExperienceMetrics
  variables: { total: number; changed: number }
  provenance?: {
    project: ExperimentRunSummary['project']
    model: ExperimentRunSummary['model']
    evaluator: ExperimentEvaluatorSnapshot
  }
}

export interface TrainingLineageNode {
  run: TrainingRunAnalysisSummary
  sourceRunId?: string
  rootRunId: string
  depth: number
}

export interface TrainingLineageEdge {
  sourceRunId: string
  continuationRunId: string
}

export interface TrainingLineageReport {
  nodes: TrainingLineageNode[]
  edges: TrainingLineageEdge[]
  rootRunIds: string[]
  missingRunIds: string[]
}

export interface TrainingRunAnalysis extends TrainingRunAnalysisSummary {
  cases: TrainingCaseView[]
  experienceCandidates: ExperienceCandidate[]
  variableItems: TrainingVariableView[]
  snapshot?: TestSnapshot
  events: TrainingEvent[]
}

export interface TrainingTrendReport {
  testDatasetId: string
  trainDatasetId?: string
  items: TrainingRunAnalysisSummary[]
  lineage: TrainingLineageReport
}

export interface TrainingCaseComparison {
  sampleId: string
  question: string
  left?: { score?: number; passed?: boolean; actualTools: string[]; expectedTools: string[] }
  right?: { score?: number; passed?: boolean; actualTools: string[]; expectedTools: string[] }
  status: 'improved' | 'regressed' | 'unchanged' | 'added' | 'removed' | 'pending'
}

export interface TrainingVariableComparison {
  name: string
  leftValue: string
  rightValue: string
  changed: boolean
  unifiedDiff: string
}

export interface TrainingComparisonReport {
  comparable: boolean
  reasons: string[]
  left: TrainingRunAnalysisSummary
  right: TrainingRunAnalysisSummary
  cases: TrainingCaseComparison[]
  variables: TrainingVariableComparison[]
}
