export type ExperimentStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ExperimentCaseStatus = "queued" | "running" | "passed" | "failed" | "error" | "cancelled";
export type ExperimentToolStatus = "hit" | "missed" | "unexpected" | "none";

export type ExperimentEvaluator =
  | { type: "llm" }
  | {
      type: "project";
      manifest: string;
      entry: string;
      revision: string;
      timeoutMs: number;
      phases: Array<"prepare" | "evaluate" | "cleanup" | "aggregate">;
    };

export type ExperimentUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
};

export type ExperimentMetrics = ExperimentUsage & {
  agentUsage: ExperimentUsage;
  scoringUsage: ExperimentUsage;
  agentTokensPerCase: number;
  scoringTokensPerCase: number;
  averageScore: number;
  passRate: number;
  errorRate: number;
  toolPrecision: number | null;
  toolRecall: number | null;
  p95LatencyMs: number;
  passed: number;
  failed: number;
  errors: number;
  cancelled: number;
  regressions: number;
  scoreBins: number[];
  custom: Record<string, unknown>;
};

export type ExperimentFailure = {
  code: string;
  message: string;
  phase?: string;
  retryable?: boolean;
};

export type ExperimentRun = {
  id: string;
  name: string;
  status: ExperimentStatus;
  dataset: {
    id: string;
    name: string;
    version: number;
    contentHash: string;
    cohortHash: string;
    scoringPromptHash: string;
    samples: number;
  };
  project: {
    commitSha: string;
    shortSha: string;
    treeSha: string;
    branch: string | null;
  };
  model: {
    provider: string;
    protocol: string;
    model: string;
    baseUrl: string;
  };
  evaluator: ExperimentEvaluator;
  config: {
    concurrency: number;
    repetitions: number;
    timeoutMs: number;
    keepWorkspaces: boolean;
    sampleIds: string[];
  };
  progress: { total: number; completed: number };
  metrics: ExperimentMetrics;
  failure?: ExperimentFailure;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
};

export type ExperimentRunDetail = ExperimentRun & { scoringPrompt: string };

export type ExperimentCase = {
  id: string;
  runId: string;
  sampleId: string;
  repetition: number;
  ordinal: number;
  status: ExperimentCaseStatus;
  score?: number;
  passed?: boolean;
  rationale?: string;
  toolStatus: ExperimentToolStatus;
  expectedTools: string[];
  actualTools: string[];
  usage: ExperimentUsage;
  agentUsage: ExperimentUsage;
  scoringUsage: ExperimentUsage;
  latencyMs: number;
  runtimeRunId?: string;
  failure?: ExperimentFailure;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type ExperimentToolCall = {
  callId: string;
  name: string;
  status: "completed" | "failed";
  arguments: unknown;
  resultPreview?: string;
  error?: unknown;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
};

export type ExperimentCaseDetail = ExperimentCase & {
  question: string;
  thinking: string;
  expectedAnswer: string;
  actualAnswer: string;
  metadata: Record<string, unknown>;
  evaluation?: {
    source: "llm" | "project";
    metrics: Record<string, unknown>;
    details?: unknown;
  };
  toolCalls: ExperimentToolCall[];
  trace: null | {
    runtimeRunId?: string;
    failure?: unknown;
    timeline: unknown[];
    observations: unknown[];
    effectiveContexts: unknown[];
    artifacts: unknown[];
    renderedMessages: Array<{ role: string; content: string }>;
    scoring?: { prompt: string; response: string; usage: ExperimentUsage };
    adapter?: { prepare?: unknown; evaluation?: unknown };
  };
};

export type ExperimentToolAggregate = {
  name: string;
  expected: number;
  hit: number;
  missed: number;
  unexpected: number;
  errors: number;
  calls: number;
  averageLatencyMs: number;
  precision: number;
  recall: number;
};

export type ExperimentComparison = {
  dataset: ExperimentRun["dataset"];
  left: ExperimentRun;
  right: ExperimentRun;
  samples: Array<{
    sampleId: string;
    left?: { caseId: string; score?: number; status: ExperimentCaseStatus };
    right?: { caseId: string; score?: number; status: ExperimentCaseStatus };
    delta?: number;
  }>;
  tools: Array<{ name: string; left?: ExperimentToolAggregate; right?: ExperimentToolAggregate }>;
};

export type ExperimentCompatibilityIssue = "sample_cohort" | "repetitions" | "evaluator";

export type ExperimentTrend = {
  datasetId: string;
  anchorRunId?: string;
  runs: ExperimentRun[];
  excluded: Array<{ run: ExperimentRun; issues: ExperimentCompatibilityIssue[] }>;
};

export type CreateExperimentInput = {
  datasetId: string;
  name?: string;
  concurrency?: number;
  repetitions?: number;
  timeoutMs?: number;
  keepWorkspaces?: boolean;
  sampleIds?: string[];
};

export type TrainingLearningMode = "review" | "author" | "auto";
export type TrainingReviewScope = "all" | "failed";
export type TrainingVariableSource = "project" | "run";
export type TrainingRunStatus =
  | "queued" | "running" | "paused" | "paused_failure" | "waiting_review"
  | "ready_to_freeze" | "ready_for_test" | "testing" | "completed" | "failed" | "cancelled";
export type TrainingCaseStatus =
  | "queued" | "running" | "evaluated" | "learning" | "replaying" | "waiting_review" | "completed" | "error";
export type ExperienceStatus =
  | "draft" | "replaying" | "replay_failed" | "pending_review" | "accepted" | "rejected" | "applied" | "conflict";

export type TrainingHookBinding = { hookId: string; parameters: Record<string, string> };

export type TrainingRun = {
  id: string;
  name: string;
  status: TrainingRunStatus;
  config: {
    trainDatasetId: string;
    testDatasetId: string;
    trainLimit: number;
    testLimit: number;
    learningMode: TrainingLearningMode;
    reviewScope: TrainingReviewScope;
    pauseOnFailure: boolean;
    variableSource: TrainingVariableSource;
    variableSourceRunId?: string;
    correctionHook?: TrainingHookBinding;
    experienceExtractorHook: TrainingHookBinding;
    timeoutMs: number;
    concurrency: 1;
  };
  progress: {
    training: { total: number; completed: number };
    testing: { total: number; completed: number };
    pendingReview: number;
    acceptedExperiences: number;
    rejectedExperiences: number;
  };
  currentCaseId?: string;
  pauseReason?: string;
  snapshotId?: string;
  failure?: ExperimentFailure;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
};

export type TrainingCase = {
  id: string;
  runId: string;
  phase: "training" | "testing";
  datasetId: string;
  sampleId: string;
  ordinal: number;
  status: TrainingCaseStatus;
  question: string;
  thinking: string;
  expectedAnswer: string;
  referenceAvailable: boolean;
  actualAnswer: string;
  expectedTools: string[];
  actualTools: string[];
  toolCalls: ExperimentToolCall[];
  usage: ExperimentUsage;
  score?: number;
  passed?: boolean;
  rationale?: string;
  experimentRunId?: string;
  experimentCaseId?: string;
  failurePauseHandled: boolean;
  attempt: number;
  failure?: ExperimentFailure;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
};

export type TrainingVariableView = {
  name: string;
  baselineValue: string;
  runValue: string;
  projectValue: string;
  snapshotValue?: string;
  sourceCaseIds: string[];
  candidateIds: string[];
  state: ExperienceStatus | "unchanged";
  changed: boolean;
};

export type TrainingVariableReport = { items: TrainingVariableView[] };

export type VariableDiff = {
  variableName: string;
  baseHash: string;
  unifiedDiff: string;
  beforeValue?: string;
  afterValue?: string;
};

export type ExperienceCandidate = {
  id: string;
  runId: string;
  sourceCaseId: string;
  sourceOutcome: "success" | "failure";
  hookId: string;
  summary: string;
  rationale: string;
  patches: VariableDiff[];
  status: ExperienceStatus;
  replayCaseId?: string;
  replayPassed?: boolean;
  replayScore?: number;
  replayRationale?: string;
  createdAt: string;
  updatedAt: string;
};

export type TestSnapshot = {
  id: string;
  runId: string;
  variables: Record<string, string>;
  contentHash: string;
  createdAt: string;
};

export type TrainingEvent = {
  id: number;
  runId: string;
  type: string;
  payload: unknown;
  createdAt: string;
};

export type TrainingCaseMetrics = {
  total: number;
  completed: number;
  evaluated: number;
  passed: number;
  failed: number;
  errors: number;
  averageScore: number;
  passRate: number;
  usage: ExperimentUsage;
  toolCalls: number;
  toolErrors: number;
  expectedTools: number;
  matchedTools: number;
};

export type TrainingExperienceMetrics = {
  generated: number;
  replayed: number;
  replayPassed: number;
  pending: number;
  applied: number;
  rejected: number;
  conflicts: number;
  successSources: number;
  failureSources: number;
};

export type TrainingRunAnalysisSummary = {
  run: TrainingRun;
  trainDataset: { id: string; name: string; version: number; samples: number };
  testDataset: { id: string; name: string; version: number; samples: number };
  training: TrainingCaseMetrics;
  testing: TrainingCaseMetrics;
  experiences: TrainingExperienceMetrics;
  variables: { total: number; changed: number };
  provenance?: {
    project: ExperimentRun["project"];
    model: ExperimentRun["model"];
    evaluator: ExperimentEvaluator;
  };
};

export type TrainingLineageNode = {
  run: TrainingRunAnalysisSummary;
  sourceRunId?: string;
  rootRunId: string;
  depth: number;
};

export type TrainingLineageEdge = {
  sourceRunId: string;
  continuationRunId: string;
};

export type TrainingLineageReport = {
  nodes: TrainingLineageNode[];
  edges: TrainingLineageEdge[];
  rootRunIds: string[];
  missingRunIds: string[];
};

export type TrainingRunAnalysis = TrainingRunAnalysisSummary & {
  cases: TrainingCase[];
  experienceCandidates: ExperienceCandidate[];
  variableItems: TrainingVariableView[];
  snapshot?: TestSnapshot;
  events: TrainingEvent[];
};

export type TrainingTrendReport = {
  testDatasetId: string;
  trainDatasetId?: string;
  items: TrainingRunAnalysisSummary[];
  lineage: TrainingLineageReport;
};

export type TrainingCaseComparison = {
  sampleId: string;
  question: string;
  left?: { score?: number; passed?: boolean; actualTools: string[]; expectedTools: string[] };
  right?: { score?: number; passed?: boolean; actualTools: string[]; expectedTools: string[] };
  status: "improved" | "regressed" | "unchanged" | "added" | "removed" | "pending";
};

export type TrainingVariableComparison = {
  name: string;
  leftValue: string;
  rightValue: string;
  changed: boolean;
  unifiedDiff: string;
};

export type TrainingComparisonReport = {
  comparable: boolean;
  reasons: string[];
  left: TrainingRunAnalysisSummary;
  right: TrainingRunAnalysisSummary;
  cases: TrainingCaseComparison[];
  variables: TrainingVariableComparison[];
};

export type CreateTrainingInput = {
  name?: string;
  trainDatasetId: string;
  testDatasetId: string;
  trainLimit: number;
  testLimit: number;
  learningMode: TrainingLearningMode;
  reviewScope: TrainingReviewScope;
  pauseOnFailure: boolean;
  variableSource: TrainingVariableSource;
  variableSourceRunId?: string;
  correctionHook?: TrainingHookBinding;
  experienceExtractorHook: TrainingHookBinding;
  timeoutMs?: number;
};

function apiUrl(path: string, projectPath: string): string {
  const configured = process.env.NEXT_PUBLIC_RUNTIME_HTTP_URL?.replace(/\/$/, "");
  const base = configured ?? `${window.location.protocol}//${window.location.hostname}:3005`;
  const separator = path.includes("?") ? "&" : "?";
  return `${base}/api/experiments${path}${separator}projectPath=${encodeURIComponent(projectPath)}`;
}

async function request<T>(projectPath: string, path = "", method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(apiUrl(path, projectPath), {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) as T & { error?: string } : undefined;
  if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
  return payload as T;
}

export const experimentApi = {
  list: (projectPath: string, options: { datasetId?: string; status?: ExperimentStatus; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (options.datasetId) query.set("datasetId", options.datasetId);
    if (options.status) query.set("status", options.status);
    if (options.limit) query.set("limit", String(options.limit));
    return request<{ project: { path: string; name: string }; items: ExperimentRun[] }>(
      projectPath,
      query.size ? `?${query}` : "",
    );
  },
  create: (projectPath: string, input: CreateExperimentInput) =>
    request<ExperimentRunDetail>(projectPath, "", "POST", input),
  get: (projectPath: string, id: string) =>
    request<ExperimentRunDetail>(projectPath, `/${encodeURIComponent(id)}`),
  remove: (projectPath: string, id: string) =>
    request<void>(projectPath, `/${encodeURIComponent(id)}`, "DELETE"),
  cancel: (projectPath: string, id: string) =>
    request<ExperimentRunDetail>(projectPath, `/${encodeURIComponent(id)}/cancel`, "POST", {}),
  cases: (projectPath: string, id: string, options: { status?: ExperimentCaseStatus; offset?: number; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (options.status) query.set("status", options.status);
    if (options.offset !== undefined) query.set("offset", String(options.offset));
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    return request<{ items: ExperimentCase[]; total: number; offset: number; limit: number }>(
      projectPath,
      `/${encodeURIComponent(id)}/cases${query.size ? `?${query}` : ""}`,
    );
  },
  case: (projectPath: string, id: string, caseId: string) =>
    request<ExperimentCaseDetail>(projectPath, `/${encodeURIComponent(id)}/cases/${encodeURIComponent(caseId)}`),
  tools: (projectPath: string, id: string) =>
    request<{ items: ExperimentToolAggregate[] }>(projectPath, `/${encodeURIComponent(id)}/tools`),
  trends: (projectPath: string, datasetId: string) =>
    request<ExperimentTrend>(projectPath, `/trends?datasetId=${encodeURIComponent(datasetId)}`),
  compare: (projectPath: string, datasetId: string, leftId: string, rightId: string) =>
    request<ExperimentComparison>(
      projectPath,
      `/compare?datasetId=${encodeURIComponent(datasetId)}&leftId=${encodeURIComponent(leftId)}&rightId=${encodeURIComponent(rightId)}`,
    ),
  storage: (projectPath: string) =>
    request<{
      bytes: number;
      runCount: number;
      databaseFile: string;
      evaluator: ExperimentEvaluator;
      scoringPromptRequired: boolean;
    }>(projectPath, "/storage"),
  training: {
    capabilities: (projectPath: string) => request<{
      maxTrainingCases: number;
      maxTestCases: number;
      hooks: Array<{ id: string; name: string; checkpoint: "after_loop" | "after_evaluation" | "after_replay" }>;
    }>(projectPath, "/training/capabilities"),
    list: (projectPath: string, limit = 20) =>
      request<{ items: TrainingRun[] }>(projectPath, `/training?limit=${limit}`),
    create: (projectPath: string, input: CreateTrainingInput) =>
      request<TrainingRun>(projectPath, "/training", "POST", input),
    get: (projectPath: string, id: string) =>
      request<TrainingRun>(projectPath, `/training/${encodeURIComponent(id)}`),
    cases: (projectPath: string, id: string) =>
      request<{ items: TrainingCase[] }>(projectPath, `/training/${encodeURIComponent(id)}/cases`),
    experiences: (projectPath: string, id: string) =>
      request<{ items: ExperienceCandidate[] }>(projectPath, `/training/${encodeURIComponent(id)}/experiences`),
    variables: (projectPath: string, id: string) =>
      request<TrainingVariableReport>(projectPath, `/training/${encodeURIComponent(id)}/variables`),
    analysis: (projectPath: string, id: string) =>
      request<TrainingRunAnalysis>(projectPath, `/training/${encodeURIComponent(id)}/analysis`),
    trend: (projectPath: string, testDatasetId: string, trainDatasetId?: string, limit = 50) => {
      const query = new URLSearchParams({ testDatasetId, limit: String(limit) });
      if (trainDatasetId) query.set("trainDatasetId", trainDatasetId);
      return request<TrainingTrendReport>(projectPath, `/training/analysis/trend?${query}`);
    },
    compare: (projectPath: string, leftId: string, rightId: string) =>
      request<TrainingComparisonReport>(projectPath, `/training/analysis/compare?leftId=${encodeURIComponent(leftId)}&rightId=${encodeURIComponent(rightId)}`),
    pause: (projectPath: string, id: string) =>
      request<TrainingRun>(projectPath, `/training/${encodeURIComponent(id)}/pause`, "POST", {}),
    resume: (projectPath: string, id: string) =>
      request<TrainingRun>(projectPath, `/training/${encodeURIComponent(id)}/resume`, "POST", {}),
    retry: (projectPath: string, id: string) =>
      request<TrainingRun>(projectPath, `/training/${encodeURIComponent(id)}/retry`, "POST", {}),
    cancel: (projectPath: string, id: string) =>
      request<TrainingRun>(projectPath, `/training/${encodeURIComponent(id)}/cancel`, "POST", {}),
    freeze: (projectPath: string, id: string) =>
      request<TestSnapshot>(projectPath, `/training/${encodeURIComponent(id)}/freeze`, "POST", {}),
    startTest: (projectPath: string, id: string) =>
      request<TrainingRun>(projectPath, `/training/${encodeURIComponent(id)}/test`, "POST", {}),
    promote: (projectPath: string, id: string) =>
      request<{ variables: Record<string, string>; contentHash: string }>(projectPath, `/training/${encodeURIComponent(id)}/promote`, "POST", {}),
    updateExperience: (projectPath: string, id: string, experienceId: string, patches: VariableDiff[]) =>
      request<ExperienceCandidate>(projectPath, `/training/${encodeURIComponent(id)}/experiences/${encodeURIComponent(experienceId)}`, "PUT", { patches }),
    replayExperience: (projectPath: string, id: string, experienceId: string) =>
      request<ExperienceCandidate>(projectPath, `/training/${encodeURIComponent(id)}/experiences/${encodeURIComponent(experienceId)}/replay`, "POST", {}),
    acceptExperience: (projectPath: string, id: string, experienceId: string) =>
      request<ExperienceCandidate>(projectPath, `/training/${encodeURIComponent(id)}/experiences/${encodeURIComponent(experienceId)}/accept`, "POST", {}),
    rejectExperience: (projectPath: string, id: string, experienceId: string) =>
      request<ExperienceCandidate>(projectPath, `/training/${encodeURIComponent(id)}/experiences/${encodeURIComponent(experienceId)}/reject`, "POST", {}),
  },
};
