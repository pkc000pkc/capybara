import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type {
  ExperimentCaseDetail,
  ExperimentCaseSummary,
  ExperimentCaseStatus,
  ExperimentConfig,
  ExperimentEvaluatorSnapshot,
  ExperimentFailure,
  ExperimentMetrics,
  ExperimentRunDetail,
  ExperimentRunSummary,
  ExperimentStatus,
  ExperimentToolAggregate,
  ExperimentToolCall,
  ExperimentToolStatus,
  ExperimentTrace,
  ExperimentUsage,
} from '#core/experiments/types'

type RunRow = {
  id: string
  name: string
  status: ExperimentStatus
  dataset_id: string
  dataset_name: string
  dataset_version: number
  dataset_content_hash: string
  dataset_cohort_hash: string
  scoring_prompt: string
  scoring_prompt_hash: string
  dataset_samples: number
  project_commit_sha: string
  project_short_sha: string
  project_tree_sha: string
  project_branch: string | null
  model_provider: string
  model_protocol: string
  model_name: string
  model_base_url: string
  evaluator_json: string
  config_json: string
  total_cases: number
  completed_cases: number
  metrics_json: string
  failure_json: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  updated_at: string
}

type CaseRow = {
  id: string
  run_id: string
  sample_id: string
  repetition: number
  ordinal: number
  status: ExperimentCaseStatus
  question: string
  thinking: string
  expected_answer: string
  metadata_json: string
  actual_answer: string
  score: number | null
  passed: number | null
  rationale: string | null
  tool_status: ExperimentToolStatus
  expected_tools_json: string
  actual_tools_json: string
  tool_calls_json: string
  usage_json: string
  agent_usage_json: string
  scoring_usage_json: string
  latency_ms: number
  runtime_run_id: string | null
  failure_json: string | null
  trace_json: string | null
  evaluation_json: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export interface CreateExperimentRun {
  id: string
  name: string
  dataset: ExperimentRunSummary['dataset']
  scoringPrompt: string
  project: ExperimentRunSummary['project']
  model: ExperimentRunSummary['model']
  evaluator: ExperimentEvaluatorSnapshot
  config: ExperimentConfig
  totalCases: number
  createdAt: string
}

export interface CreateExperimentCase {
  id: string
  runId: string
  sampleId: string
  repetition: number
  ordinal: number
  question: string
  thinking: string
  expectedAnswer: string
  expectedTools: string[]
  metadata: ExperimentCaseDetail['metadata']
  createdAt: string
}

export interface CompleteExperimentCase {
  status: Extract<ExperimentCaseStatus, 'passed' | 'failed' | 'error' | 'cancelled'>
  actualAnswer: string
  score?: number
  passed?: boolean
  rationale?: string
  toolStatus: ExperimentToolStatus
  actualTools: string[]
  toolCalls: ExperimentToolCall[]
  usage: ExperimentUsage
  agentUsage: ExperimentUsage
  scoringUsage: ExperimentUsage
  latencyMs: number
  runtimeRunId?: string
  failure?: ExperimentFailure
  trace?: ExperimentTrace
  evaluation?: ExperimentCaseDetail['evaluation']
  completedAt: string
}

const EMPTY_USAGE: ExperimentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
}

export const EMPTY_EXPERIMENT_METRICS: ExperimentMetrics = {
  ...EMPTY_USAGE,
  agentUsage: EMPTY_USAGE,
  scoringUsage: EMPTY_USAGE,
  agentTokensPerCase: 0,
  scoringTokensPerCase: 0,
  averageScore: 0,
  passRate: 0,
  errorRate: 0,
  toolPrecision: null,
  toolRecall: null,
  p95LatencyMs: 0,
  passed: 0,
  failed: 0,
  errors: 0,
  cancelled: 0,
  regressions: 0,
  scoreBins: [0, 0, 0, 0, 0],
  custom: {},
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  return JSON.parse(value) as T
}

function runSummary(row: RunRow): ExperimentRunSummary {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    dataset: {
      id: row.dataset_id,
      name: row.dataset_name,
      version: row.dataset_version,
      contentHash: row.dataset_content_hash,
      cohortHash: row.dataset_cohort_hash || row.dataset_content_hash,
      scoringPromptHash: row.scoring_prompt_hash,
      samples: row.dataset_samples,
    },
    project: {
      commitSha: row.project_commit_sha,
      shortSha: row.project_short_sha,
      treeSha: row.project_tree_sha,
      branch: row.project_branch,
    },
    model: {
      provider: row.model_provider,
      protocol: row.model_protocol,
      model: row.model_name,
      baseUrl: row.model_base_url,
    },
    evaluator: parseJson<ExperimentEvaluatorSnapshot>(row.evaluator_json, { type: 'llm' }),
    config: parseJson<ExperimentConfig>(row.config_json, {
      concurrency: 1,
      repetitions: 1,
      timeoutMs: 600_000,
      keepWorkspaces: false,
      sampleIds: [],
    }),
    progress: { total: row.total_cases, completed: row.completed_cases },
    metrics: { ...EMPTY_EXPERIMENT_METRICS, ...parseJson(row.metrics_json, EMPTY_EXPERIMENT_METRICS) },
    ...(row.failure_json ? { failure: parseJson<ExperimentFailure>(row.failure_json, { code: 'UNKNOWN', message: 'Unknown experiment failure' }) } : {}),
    createdAt: row.created_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    updatedAt: row.updated_at,
  }
}

function caseSummary(row: CaseRow): ExperimentCaseSummary {
  return {
    id: row.id,
    runId: row.run_id,
    sampleId: row.sample_id,
    repetition: row.repetition,
    ordinal: row.ordinal,
    status: row.status,
    ...(row.score === null ? {} : { score: row.score }),
    ...(row.passed === null ? {} : { passed: Boolean(row.passed) }),
    ...(row.rationale === null ? {} : { rationale: row.rationale }),
    toolStatus: row.tool_status,
    expectedTools: parseJson<string[]>(row.expected_tools_json, []),
    actualTools: parseJson<string[]>(row.actual_tools_json, []),
    usage: parseJson<ExperimentUsage>(row.usage_json, EMPTY_USAGE),
    agentUsage: parseJson<ExperimentUsage>(row.agent_usage_json, EMPTY_USAGE),
    scoringUsage: parseJson<ExperimentUsage>(row.scoring_usage_json, EMPTY_USAGE),
    latencyMs: row.latency_ms,
    ...(row.runtime_run_id ? { runtimeRunId: row.runtime_run_id } : {}),
    ...(row.failure_json ? { failure: parseJson<ExperimentFailure>(row.failure_json, { code: 'UNKNOWN', message: 'Unknown case failure' }) } : {}),
    createdAt: row.created_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  }
}

function caseDetail(row: CaseRow): ExperimentCaseDetail {
  return {
    ...caseSummary(row),
    question: row.question,
    thinking: row.thinking,
    expectedAnswer: row.expected_answer,
    actualAnswer: row.actual_answer,
    metadata: parseJson(row.metadata_json, {}),
    ...(row.evaluation_json
      ? { evaluation: parseJson<NonNullable<ExperimentCaseDetail['evaluation']>>(row.evaluation_json, { source: 'llm', metrics: {} }) }
      : {}),
    toolCalls: parseJson<ExperimentToolCall[]>(row.tool_calls_json, []),
    trace: parseJson<ExperimentTrace | null>(row.trace_json, null),
  }
}

export class ExperimentStore {
  readonly databaseFile: string
  private readonly database: DatabaseSync

  constructor(readonly projectDir: string) {
    const directory = path.join(projectDir, '.capybara')
    fs.mkdirSync(directory, { recursive: true })
    this.databaseFile = path.join(directory, 'experiments.sqlite')
    this.database = new DatabaseSync(this.databaseFile)
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS experiment_runs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        dataset_id TEXT NOT NULL,
        dataset_name TEXT NOT NULL,
        dataset_version INTEGER NOT NULL,
        dataset_content_hash TEXT NOT NULL,
        dataset_cohort_hash TEXT NOT NULL,
        scoring_prompt TEXT NOT NULL,
        scoring_prompt_hash TEXT NOT NULL,
        dataset_samples INTEGER NOT NULL,
        project_commit_sha TEXT NOT NULL,
        project_short_sha TEXT NOT NULL,
        project_tree_sha TEXT NOT NULL,
        project_branch TEXT,
        model_provider TEXT NOT NULL,
        model_protocol TEXT NOT NULL,
        model_name TEXT NOT NULL,
        model_base_url TEXT NOT NULL,
        evaluator_json TEXT NOT NULL DEFAULT '{"type":"llm"}',
        config_json TEXT NOT NULL,
        total_cases INTEGER NOT NULL,
        completed_cases INTEGER NOT NULL DEFAULT 0,
        metrics_json TEXT NOT NULL,
        failure_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS experiment_cases (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES experiment_runs(id) ON DELETE CASCADE,
        sample_id TEXT NOT NULL,
        repetition INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        status TEXT NOT NULL,
        question TEXT NOT NULL,
        thinking TEXT NOT NULL,
        expected_answer TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        actual_answer TEXT NOT NULL DEFAULT '',
        score REAL,
        passed INTEGER,
        rationale TEXT,
        tool_status TEXT NOT NULL DEFAULT 'none',
        expected_tools_json TEXT NOT NULL,
        actual_tools_json TEXT NOT NULL DEFAULT '[]',
        tool_calls_json TEXT NOT NULL DEFAULT '[]',
        usage_json TEXT NOT NULL,
        agent_usage_json TEXT NOT NULL,
        scoring_usage_json TEXT NOT NULL,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        runtime_run_id TEXT,
        failure_json TEXT,
        trace_json TEXT,
        evaluation_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        UNIQUE(run_id, sample_id, repetition)
      );
      CREATE INDEX IF NOT EXISTS experiment_runs_dataset_time
        ON experiment_runs(dataset_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS experiment_runs_status
        ON experiment_runs(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS experiment_cases_run_ordinal
        ON experiment_cases(run_id, ordinal);
      CREATE INDEX IF NOT EXISTS experiment_cases_run_status
        ON experiment_cases(run_id, status);
    `)
    const caseColumns = new Set((this.database.prepare('PRAGMA table_info(experiment_cases)').all() as Array<{ name: string }>).map((column) => column.name))
    const runColumns = new Set((this.database.prepare('PRAGMA table_info(experiment_runs)').all() as Array<{ name: string }>).map((column) => column.name))
    if (!runColumns.has('evaluator_json')) {
      this.database.exec("ALTER TABLE experiment_runs ADD COLUMN evaluator_json TEXT NOT NULL DEFAULT '{\"type\":\"llm\"}'")
    }
    if (!runColumns.has('dataset_cohort_hash')) {
      this.database.exec("ALTER TABLE experiment_runs ADD COLUMN dataset_cohort_hash TEXT NOT NULL DEFAULT ''")
      this.database.exec('UPDATE experiment_runs SET dataset_cohort_hash = dataset_content_hash WHERE dataset_cohort_hash = \'\'')
    }
    if (!caseColumns.has('agent_usage_json')) {
      this.database.exec('ALTER TABLE experiment_cases ADD COLUMN agent_usage_json TEXT')
      this.database.exec('UPDATE experiment_cases SET agent_usage_json = usage_json WHERE agent_usage_json IS NULL')
    }
    if (!caseColumns.has('scoring_usage_json')) {
      this.database.exec("ALTER TABLE experiment_cases ADD COLUMN scoring_usage_json TEXT DEFAULT '{\"inputTokens\":0,\"outputTokens\":0,\"totalTokens\":0,\"cacheReadTokens\":0}'")
    }
    if (!caseColumns.has('metadata_json')) {
      this.database.exec("ALTER TABLE experiment_cases ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'")
    }
    if (!caseColumns.has('evaluation_json')) {
      this.database.exec('ALTER TABLE experiment_cases ADD COLUMN evaluation_json TEXT')
    }
    const recoveredAt = new Date().toISOString()
    const failure = JSON.stringify({
      code: 'PROCESS_RESTARTED',
      message: 'The experiment process stopped before the run reached a terminal state.',
      phase: 'runtime',
      retryable: true,
    })
    this.database.prepare(`
      UPDATE experiment_runs
      SET status = 'failed', failure_json = ?, completed_at = ?, updated_at = ?
      WHERE status IN ('queued', 'running')
    `).run(failure, recoveredAt, recoveredAt)
    this.database.prepare(`
      UPDATE experiment_cases
      SET status = 'error', failure_json = ?, completed_at = ?
      WHERE status IN ('queued', 'running')
    `).run(failure, recoveredAt)
  }

  createRun(run: CreateExperimentRun, cases: CreateExperimentCase[]): ExperimentRunDetail {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare(`
        INSERT INTO experiment_runs (
          id, name, status, dataset_id, dataset_name, dataset_version,
          dataset_content_hash, dataset_cohort_hash, scoring_prompt, scoring_prompt_hash, dataset_samples,
          project_commit_sha, project_short_sha, project_tree_sha, project_branch,
          model_provider, model_protocol, model_name, model_base_url, evaluator_json, config_json,
          total_cases, metrics_json, created_at, updated_at
        ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.id,
        run.name,
        run.dataset.id,
        run.dataset.name,
        run.dataset.version,
        run.dataset.contentHash,
        run.dataset.cohortHash,
        run.scoringPrompt,
        run.dataset.scoringPromptHash,
        run.dataset.samples,
        run.project.commitSha,
        run.project.shortSha,
        run.project.treeSha,
        run.project.branch,
        run.model.provider,
        run.model.protocol,
        run.model.model,
        run.model.baseUrl,
        JSON.stringify(run.evaluator),
        JSON.stringify(run.config),
        run.totalCases,
        JSON.stringify(EMPTY_EXPERIMENT_METRICS),
        run.createdAt,
        run.createdAt,
      )
      const statement = this.database.prepare(`
        INSERT INTO experiment_cases (
          id, run_id, sample_id, repetition, ordinal, status, question, thinking,
          expected_answer, metadata_json, expected_tools_json, usage_json, agent_usage_json,
          scoring_usage_json, created_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const item of cases) {
        statement.run(
          item.id,
          item.runId,
          item.sampleId,
          item.repetition,
          item.ordinal,
          item.question,
          item.thinking,
          item.expectedAnswer,
          JSON.stringify(item.metadata),
          JSON.stringify(item.expectedTools),
          JSON.stringify(EMPTY_USAGE),
          JSON.stringify(EMPTY_USAGE),
          JSON.stringify(EMPTY_USAGE),
          item.createdAt,
        )
      }
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return this.getRun(run.id)
  }

  listRuns(options: { datasetId?: string; status?: ExperimentStatus; limit?: number } = {}): ExperimentRunSummary[] {
    const where: string[] = []
    const values: Array<string | number> = []
    if (options.datasetId) {
      where.push('dataset_id = ?')
      values.push(options.datasetId)
    }
    if (options.status) {
      where.push('status = ?')
      values.push(options.status)
    }
    const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 100)))
    values.push(limit)
    const rows = this.database.prepare(`
      SELECT * FROM experiment_runs
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC LIMIT ?
    `).all(...values) as RunRow[]
    return rows.map(runSummary)
  }

  getRun(id: string): ExperimentRunDetail {
    const row = this.database.prepare('SELECT * FROM experiment_runs WHERE id = ?').get(id) as RunRow | undefined
    if (!row) throw new Error(`experiment was not found: ${id}`)
    return { ...runSummary(row), scoringPrompt: row.scoring_prompt }
  }

  listCases(runId: string, options: { status?: ExperimentCaseStatus; offset?: number; limit?: number } = {}): { items: ExperimentCaseSummary[]; total: number; offset: number; limit: number } {
    this.getRun(runId)
    const where = ['run_id = ?']
    const values: Array<string | number> = [runId]
    if (options.status) {
      where.push('status = ?')
      values.push(options.status)
    }
    const offset = Math.max(0, Math.floor(options.offset ?? 0))
    const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 100)))
    const count = this.database.prepare(`SELECT COUNT(*) AS count FROM experiment_cases WHERE ${where.join(' AND ')}`).get(...values) as { count: number }
    const rows = this.database.prepare(`
      SELECT * FROM experiment_cases WHERE ${where.join(' AND ')}
      ORDER BY ordinal LIMIT ? OFFSET ?
    `).all(...values, limit, offset) as CaseRow[]
    return { items: rows.map(caseSummary), total: count.count, offset, limit }
  }

  getCase(runId: string, caseId: string): ExperimentCaseDetail {
    const row = this.database.prepare(`
      SELECT * FROM experiment_cases WHERE run_id = ? AND id = ?
    `).get(runId, caseId) as CaseRow | undefined
    if (!row) throw new Error(`experiment case was not found: ${caseId}`)
    return caseDetail(row)
  }

  updateCaseEvaluation(
    runId: string,
    caseId: string,
    evaluation: NonNullable<ExperimentCaseDetail['evaluation']>,
  ): void {
    const changes = this.database.prepare(`
      UPDATE experiment_cases SET evaluation_json = ? WHERE run_id = ? AND id = ?
    `).run(JSON.stringify(evaluation), runId, caseId)
    if (changes.changes === 0) throw new Error(`experiment case was not found: ${caseId}`)
  }

  startRun(id: string, startedAt: string): void {
    const result = this.database.prepare(`
      UPDATE experiment_runs SET status = 'running', started_at = ?, updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(startedAt, startedAt, id)
    if (result.changes === 0) throw new Error(`queued experiment was not found: ${id}`)
  }

  startCase(id: string, startedAt: string): void {
    this.database.prepare(`
      UPDATE experiment_cases SET status = 'running', started_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(startedAt, id)
  }

  completeCase(id: string, result: CompleteExperimentCase): void {
    const changes = this.database.prepare(`
      UPDATE experiment_cases SET
        status = ?, actual_answer = ?, score = ?, passed = ?, rationale = ?,
        tool_status = ?, actual_tools_json = ?, tool_calls_json = ?, usage_json = ?,
        agent_usage_json = ?, scoring_usage_json = ?,
        latency_ms = ?, runtime_run_id = ?, failure_json = ?, trace_json = ?, evaluation_json = ?, completed_at = ?
      WHERE id = ? AND status = 'running'
    `).run(
      result.status,
      result.actualAnswer,
      result.score ?? null,
      result.passed === undefined ? null : Number(result.passed),
      result.rationale ?? null,
      result.toolStatus,
      JSON.stringify(result.actualTools),
      JSON.stringify(result.toolCalls),
      JSON.stringify(result.usage),
      JSON.stringify(result.agentUsage),
      JSON.stringify(result.scoringUsage),
      result.latencyMs,
      result.runtimeRunId ?? null,
      result.failure ? JSON.stringify(result.failure) : null,
      result.trace ? JSON.stringify(result.trace) : null,
      result.evaluation ? JSON.stringify(result.evaluation) : null,
      result.completedAt,
      id,
    )
    if (changes.changes === 0) throw new Error(`running experiment case was not found: ${id}`)
    this.database.prepare(`
      UPDATE experiment_runs SET completed_cases = completed_cases + 1, updated_at = ?
      WHERE id = (SELECT run_id FROM experiment_cases WHERE id = ?)
    `).run(result.completedAt, id)
  }

  finishRun(id: string, status: Extract<ExperimentStatus, 'completed' | 'failed' | 'cancelled'>, metrics: ExperimentMetrics, completedAt: string, failure?: ExperimentFailure): void {
    this.database.prepare(`
      UPDATE experiment_runs SET status = ?, metrics_json = ?, failure_json = ?,
        completed_at = ?, updated_at = ? WHERE id = ?
    `).run(
      status,
      JSON.stringify(metrics),
      failure ? JSON.stringify(failure) : null,
      completedAt,
      completedAt,
      id,
    )
  }

  cancelQueuedCases(runId: string, completedAt: string, failure: ExperimentFailure): void {
    this.database.prepare(`
      UPDATE experiment_cases SET status = 'cancelled', failure_json = ?, completed_at = ?
      WHERE run_id = ? AND status IN ('queued', 'running')
    `).run(JSON.stringify(failure), completedAt, runId)
    this.refreshCompletedCount(runId, completedAt)
  }

  refreshCompletedCount(runId: string, updatedAt = new Date().toISOString()): void {
    this.database.prepare(`
      UPDATE experiment_runs SET completed_cases = (
        SELECT COUNT(*) FROM experiment_cases
        WHERE run_id = ? AND status IN ('passed', 'failed', 'error', 'cancelled')
      ), updated_at = ? WHERE id = ?
    `).run(runId, updatedAt, runId)
  }

  previousCompletedRun(datasetId: string, excludeId: string): ExperimentRunSummary | undefined {
    const row = this.database.prepare(`
      SELECT * FROM experiment_runs
      WHERE dataset_id = ? AND status = 'completed' AND id <> ?
      ORDER BY completed_at DESC LIMIT 1
    `).get(datasetId, excludeId) as RunRow | undefined
    return row ? runSummary(row) : undefined
  }

  scoreMap(runId: string): Map<string, number> {
    const rows = this.database.prepare(`
      SELECT sample_id, AVG(score) AS score FROM experiment_cases
      WHERE run_id = ? AND score IS NOT NULL GROUP BY sample_id
    `).all(runId) as Array<{ sample_id: string; score: number }>
    return new Map(rows.map((row) => [row.sample_id, row.score]))
  }

  toolAggregates(runId: string): ExperimentToolAggregate[] {
    this.getRun(runId)
    const cases = this.database.prepare(`
      SELECT expected_tools_json, actual_tools_json, tool_calls_json
      FROM experiment_cases WHERE run_id = ?
    `).all(runId) as Array<Pick<CaseRow, 'expected_tools_json' | 'actual_tools_json' | 'tool_calls_json'>>
    const values = new Map<string, { expected: number; hit: number; missed: number; unexpected: number; errors: number; calls: number; latency: number }>()
    const entry = (name: string) => {
      let value = values.get(name)
      if (!value) {
        value = { expected: 0, hit: 0, missed: 0, unexpected: 0, errors: 0, calls: 0, latency: 0 }
        values.set(name, value)
      }
      return value
    }
    for (const item of cases) {
      const expected = new Set(parseJson<string[]>(item.expected_tools_json, []))
      const actual = new Set(parseJson<string[]>(item.actual_tools_json, []))
      for (const name of expected) {
        const value = entry(name)
        value.expected += 1
        if (actual.has(name)) value.hit += 1
        else value.missed += 1
      }
      for (const name of actual) {
        if (!expected.has(name)) entry(name).unexpected += 1
      }
      for (const call of parseJson<ExperimentToolCall[]>(item.tool_calls_json, [])) {
        const value = entry(call.name)
        value.calls += 1
        value.latency += call.durationMs ?? 0
        if (call.status === 'failed') value.errors += 1
      }
    }
    return [...values.entries()].map(([name, value]) => ({
      name,
      ...value,
      averageLatencyMs: value.calls ? Math.round(value.latency / value.calls) : 0,
      precision: value.hit + value.unexpected ? value.hit / (value.hit + value.unexpected) * 100 : 0,
      recall: value.expected ? value.hit / value.expected * 100 : 0,
    })).sort((left, right) => left.name.localeCompare(right.name))
  }

  deleteRun(id: string): void {
    const result = this.database.prepare(`DELETE FROM experiment_runs WHERE id = ? AND status NOT IN ('queued', 'running')`).run(id)
    if (result.changes === 0) throw new Error('only a terminal experiment can be deleted')
  }

  stats(): { bytes: number; runCount: number; databaseFile: string } {
    const bytes = [this.databaseFile, `${this.databaseFile}-wal`, `${this.databaseFile}-shm`]
      .reduce((total, file) => total + (fs.existsSync(file) ? fs.statSync(file).size : 0), 0)
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM experiment_runs').get() as { count: number }
    return { bytes, runCount: row.count, databaseFile: this.databaseFile }
  }

  close(): void {
    this.database.close()
  }
}
