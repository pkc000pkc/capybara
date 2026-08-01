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
};
