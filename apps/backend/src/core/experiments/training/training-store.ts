import { createHash } from 'node:crypto'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { ExperimentCaseDetail, ExperimentFailure, ExperimentToolCall, ExperimentUsage } from '#core/experiments/types'
import type {
  ExperienceCandidate,
  ExperienceLifecycle,
  ExperienceStatus,
  TestSnapshot,
  TrainingCase,
  TrainingCaseStatus,
  TrainingConfig,
  TrainingCorrectionAttempt,
  TrainingEvent,
  TrainingRun,
  TrainingRunStatus,
  VariableDiff,
  VariableWriteAudit,
} from '#core/experiments/training/training-types'

const EMPTY_USAGE: ExperimentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
}

const TRAINING_CONFIG_DEFAULTS = {
  maxCorrectionAttempts: 5,
  maxCorrectionTokens: 2_000_000,
  maxCorrectionWallTimeMs: 20 * 60_000,
  maxReplayRevisions: 2,
} as const

type RunRow = {
  id: string
  name: string
  status: TrainingRunStatus
  config_json: string
  current_case_id: string | null
  pause_reason: string | null
  snapshot_id: string | null
  failure_json: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  updated_at: string
}

type CaseRow = {
  id: string
  run_id: string
  phase: TrainingCase['phase']
  dataset_id: string
  sample_id: string
  ordinal: number
  status: TrainingCaseStatus
  question: string
  thinking: string
  expected_answer: string
  actual_answer: string
  expected_tools_json: string
  actual_tools_json: string
  tool_calls_json: string
  usage_json: string
  score: number | null
  passed: number | null
  rationale: string | null
  evaluation_json: string | null
  experiment_run_id: string | null
  experiment_case_id: string | null
  failure_pause_handled: number
  attempt: number
  failure_json: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  updated_at: string
}

type ExperienceRow = {
  id: string
  run_id: string
  source_case_id: string
  source_outcome: ExperienceCandidate['sourceOutcome']
  hook_id: string
  summary: string
  rationale: string
  status: ExperienceStatus
  replay_case_id: string | null
  replay_passed: number | null
  replay_score: number | null
  replay_rationale: string | null
  stage: ExperienceCandidate['stage']
  level: number
  context_budget_tokens: number
  replay_generation: number
  replay_count: number
  required_clean_replays: number
  revision: number
  content_hash: string
  source_candidate_id: string
  entry_ids_json: string
  parent_revision: number | null
  promotion_id: string | null
  created_at: string
  updated_at: string
}

type CorrectionAttemptRow = {
  id: string
  run_id: string
  source_case_id: string
  ordinal: number
  hook_id: string
  summary: string
  strategy: string
  variable_overrides_json: string
  experiment_run_id: string | null
  experiment_case_id: string | null
  actual_answer: string
  actual_tools_json: string
  tool_calls_json: string
  usage_json: string
  hook_usage_json: string
  score: number
  passed: number
  rationale: string
  evaluation_json: string | null
  failure_json: string | null
  terminal_reason: TrainingCorrectionAttempt['terminalReason'] | null
  started_at: string
  completed_at: string
}

function parseJson<T>(value: string | null, fallback: T): T {
  return value ? JSON.parse(value) as T : fallback
}

export class TrainingStore {
  private readonly database: DatabaseSync

  constructor(readonly projectDir: string) {
    this.database = new DatabaseSync(path.join(path.resolve(projectDir), '.capybara', 'experiments.sqlite'))
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS training_runs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        config_json TEXT NOT NULL,
        current_case_id TEXT,
        pause_reason TEXT,
        snapshot_id TEXT,
        failure_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS training_cases (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES training_runs(id) ON DELETE CASCADE,
        phase TEXT NOT NULL,
        dataset_id TEXT NOT NULL,
        sample_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        status TEXT NOT NULL,
        question TEXT NOT NULL,
        thinking TEXT NOT NULL,
        expected_answer TEXT NOT NULL,
        actual_answer TEXT NOT NULL DEFAULT '',
        expected_tools_json TEXT NOT NULL DEFAULT '[]',
        actual_tools_json TEXT NOT NULL DEFAULT '[]',
        tool_calls_json TEXT NOT NULL DEFAULT '[]',
        usage_json TEXT NOT NULL DEFAULT '{}',
        score REAL,
        passed INTEGER,
        rationale TEXT,
        evaluation_json TEXT,
        experiment_run_id TEXT,
        experiment_case_id TEXT,
        failure_pause_handled INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 0,
        failure_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, phase, sample_id)
      );
      CREATE TABLE IF NOT EXISTS experience_candidates (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES training_runs(id) ON DELETE CASCADE,
        source_case_id TEXT NOT NULL REFERENCES training_cases(id) ON DELETE CASCADE,
        source_outcome TEXT NOT NULL,
        hook_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        rationale TEXT NOT NULL,
        status TEXT NOT NULL,
        replay_case_id TEXT,
        replay_passed INTEGER,
        replay_score REAL,
        replay_rationale TEXT,
        stage TEXT NOT NULL DEFAULT 'candidate',
        level INTEGER NOT NULL DEFAULT 1,
        context_budget_tokens INTEGER NOT NULL DEFAULT 32768,
        replay_generation INTEGER NOT NULL DEFAULT 0,
        replay_count INTEGER NOT NULL DEFAULT 0,
        required_clean_replays INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL DEFAULT 1,
        content_hash TEXT NOT NULL DEFAULT '',
        source_candidate_id TEXT NOT NULL DEFAULT '',
        entry_ids_json TEXT NOT NULL DEFAULT '[]',
        parent_revision INTEGER,
        promotion_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS training_correction_attempts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES training_runs(id) ON DELETE CASCADE,
        source_case_id TEXT NOT NULL REFERENCES training_cases(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        hook_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        strategy TEXT NOT NULL,
        variable_overrides_json TEXT NOT NULL,
        experiment_run_id TEXT,
        experiment_case_id TEXT,
        actual_answer TEXT NOT NULL,
        actual_tools_json TEXT NOT NULL,
        tool_calls_json TEXT NOT NULL,
        usage_json TEXT NOT NULL,
        hook_usage_json TEXT NOT NULL,
        score REAL NOT NULL,
        passed INTEGER NOT NULL,
        rationale TEXT NOT NULL,
        evaluation_json TEXT,
        failure_json TEXT,
        terminal_reason TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        UNIQUE(source_case_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS experience_patches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id TEXT NOT NULL REFERENCES experience_candidates(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        variable_name TEXT NOT NULL,
        base_hash TEXT NOT NULL,
        unified_diff TEXT NOT NULL,
        before_value TEXT,
        after_value TEXT,
        UNIQUE(candidate_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS variable_write_audits (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES training_runs(id) ON DELETE CASCADE,
        candidate_id TEXT NOT NULL REFERENCES experience_candidates(id) ON DELETE CASCADE,
        source_case_id TEXT NOT NULL,
        variable_name TEXT NOT NULL,
        before_value TEXT NOT NULL,
        after_value TEXT NOT NULL,
        unified_diff TEXT NOT NULL,
        before_hash TEXT NOT NULL,
        after_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS training_snapshots (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES training_runs(id) ON DELETE CASCADE,
        variables_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS training_variable_baselines (
        run_id TEXT NOT NULL REFERENCES training_runs(id) ON DELETE CASCADE,
        variable_name TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY(run_id, variable_name)
      );
      CREATE TABLE IF NOT EXISTS training_variable_states (
        run_id TEXT NOT NULL REFERENCES training_runs(id) ON DELETE CASCADE,
        variable_name TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY(run_id, variable_name)
      );
      CREATE TABLE IF NOT EXISTS training_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES training_runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS training_runs_status_time ON training_runs(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS training_cases_run_phase_ordinal ON training_cases(run_id, phase, ordinal);
      CREATE INDEX IF NOT EXISTS experiences_run_status ON experience_candidates(run_id, status, created_at);
      CREATE INDEX IF NOT EXISTS correction_attempts_case_ordinal ON training_correction_attempts(source_case_id, ordinal);
    `)
    const caseColumns = new Set((this.database.prepare('PRAGMA table_info(training_cases)').all() as Array<{ name: string }>).map((column) => column.name))
    if (!caseColumns.has('evaluation_json')) {
      this.database.exec('ALTER TABLE training_cases ADD COLUMN evaluation_json TEXT')
    }
    const experienceColumns = new Set((this.database.prepare('PRAGMA table_info(experience_candidates)').all() as Array<{ name: string }>).map((column) => column.name))
    const experienceMigrations = [
      ['stage', "ALTER TABLE experience_candidates ADD COLUMN stage TEXT NOT NULL DEFAULT 'candidate'"],
      ['level', 'ALTER TABLE experience_candidates ADD COLUMN level INTEGER NOT NULL DEFAULT 1'],
      ['context_budget_tokens', 'ALTER TABLE experience_candidates ADD COLUMN context_budget_tokens INTEGER NOT NULL DEFAULT 32768'],
      ['replay_generation', 'ALTER TABLE experience_candidates ADD COLUMN replay_generation INTEGER NOT NULL DEFAULT 0'],
      ['replay_count', 'ALTER TABLE experience_candidates ADD COLUMN replay_count INTEGER NOT NULL DEFAULT 0'],
      ['required_clean_replays', 'ALTER TABLE experience_candidates ADD COLUMN required_clean_replays INTEGER NOT NULL DEFAULT 1'],
      ['revision', 'ALTER TABLE experience_candidates ADD COLUMN revision INTEGER NOT NULL DEFAULT 1'],
      ['content_hash', "ALTER TABLE experience_candidates ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''"],
      ['source_candidate_id', "ALTER TABLE experience_candidates ADD COLUMN source_candidate_id TEXT NOT NULL DEFAULT ''"],
      ['entry_ids_json', "ALTER TABLE experience_candidates ADD COLUMN entry_ids_json TEXT NOT NULL DEFAULT '[]'"],
      ['parent_revision', 'ALTER TABLE experience_candidates ADD COLUMN parent_revision INTEGER'],
      ['promotion_id', 'ALTER TABLE experience_candidates ADD COLUMN promotion_id TEXT'],
    ] as const
    for (const [column, statement] of experienceMigrations) {
      if (!experienceColumns.has(column)) this.database.exec(statement)
    }
    const legacyCandidates = this.database.prepare(`
      SELECT id FROM experience_candidates WHERE content_hash = ''
    `).all() as Array<{ id: string }>
    for (const candidate of legacyCandidates) {
      const patches = this.database.prepare(`
        SELECT variable_name, COALESCE(after_value, '') AS after_value
        FROM experience_patches WHERE candidate_id = ? ORDER BY variable_name
      `).all(candidate.id)
      const contentHash = createHash('sha256').update(JSON.stringify(patches)).digest('hex')
      this.database.prepare(`
        UPDATE experience_candidates SET content_hash = ?, source_candidate_id = id
        WHERE id = ?
      `).run(contentHash, candidate.id)
    }
    this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS experiences_promotion_id
      ON experience_candidates(promotion_id) WHERE promotion_id IS NOT NULL
    `)
    this.recoverInterrupted()
  }

  createRun(
    run: Omit<TrainingRun, 'progress'>,
    cases: TrainingCase[],
    baselineVariables: Record<string, string> = {},
  ): TrainingRun {
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO training_runs (
          id, name, status, config_json, current_case_id, pause_reason, snapshot_id,
          failure_json, created_at, started_at, completed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.id,
        run.name,
        run.status,
        JSON.stringify(run.config),
        run.currentCaseId ?? null,
        run.pauseReason ?? null,
        run.snapshotId ?? null,
        run.failure ? JSON.stringify(run.failure) : null,
        run.createdAt,
        run.startedAt ?? null,
        run.completedAt ?? null,
        run.updatedAt,
      )
      const insertCase = this.database.prepare(`
        INSERT INTO training_cases (
          id, run_id, phase, dataset_id, sample_id, ordinal, status, question, thinking,
          expected_answer, actual_answer, expected_tools_json, actual_tools_json,
          tool_calls_json, usage_json, score, passed, rationale, evaluation_json, experiment_run_id,
          experiment_case_id, failure_pause_handled, attempt, failure_json, created_at,
          started_at, completed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const item of cases) {
        insertCase.run(
          item.id, item.runId, item.phase, item.datasetId, item.sampleId, item.ordinal,
          item.status, item.question, item.thinking, item.expectedAnswer, item.actualAnswer,
          JSON.stringify(item.expectedTools), JSON.stringify(item.actualTools),
          JSON.stringify(item.toolCalls), JSON.stringify(item.usage), item.score ?? null,
          item.passed === undefined ? null : Number(item.passed), item.rationale ?? null,
          item.evaluation ? JSON.stringify(item.evaluation) : null,
          item.experimentRunId ?? null, item.experimentCaseId ?? null,
          Number(item.failurePauseHandled), item.attempt,
          item.failure ? JSON.stringify(item.failure) : null, item.createdAt,
          item.startedAt ?? null, item.completedAt ?? null, item.updatedAt,
        )
      }
      const insertBaseline = this.database.prepare(`
        INSERT INTO training_variable_baselines (run_id, variable_name, value)
        VALUES (?, ?, ?)
      `)
      const insertState = this.database.prepare(`
        INSERT INTO training_variable_states (run_id, variable_name, value)
        VALUES (?, ?, ?)
      `)
      for (const [name, value] of Object.entries(baselineVariables)) {
        insertBaseline.run(run.id, name, value)
        insertState.run(run.id, name, value)
      }
    })
    this.event(run.id, 'run.created', { status: run.status })
    return this.getRun(run.id)
  }

  listRuns(limit = 50): TrainingRun[] {
    const rows = this.database.prepare(`
      SELECT * FROM training_runs ORDER BY created_at DESC LIMIT ?
    `).all(Math.max(1, Math.min(500, limit))) as RunRow[]
    return rows.map((row) => this.run(row))
  }

  getRun(id: string): TrainingRun {
    const row = this.database.prepare('SELECT * FROM training_runs WHERE id = ?').get(id) as RunRow | undefined
    if (!row) throw new Error(`training run was not found: ${id}`)
    return this.run(row)
  }

  listCases(runId: string, phase?: TrainingCase['phase']): TrainingCase[] {
    this.getRun(runId)
    const rows = phase
      ? this.database.prepare('SELECT * FROM training_cases WHERE run_id = ? AND phase = ? ORDER BY ordinal').all(runId, phase)
      : this.database.prepare('SELECT * FROM training_cases WHERE run_id = ? ORDER BY phase DESC, ordinal').all(runId)
    return (rows as CaseRow[]).map((row) => this.case(row))
  }

  getCase(id: string): TrainingCase {
    const row = this.database.prepare('SELECT * FROM training_cases WHERE id = ?').get(id) as CaseRow | undefined
    if (!row) throw new Error(`training case was not found: ${id}`)
    return this.case(row)
  }

  setRunStatus(
    id: string,
    status: TrainingRunStatus,
    fields: { currentCaseId?: string | null; pauseReason?: string | null; failure?: ExperimentFailure | null } = {},
  ): void {
    const now = new Date().toISOString()
    const current = this.getRun(id)
    const startedAt = current.startedAt ?? (['running', 'testing'].includes(status) ? now : null)
    const completedAt = ['blocked', 'completed', 'failed', 'cancelled'].includes(status) ? now : null
    this.database.prepare(`
      UPDATE training_runs
      SET status = ?, current_case_id = ?, pause_reason = ?, failure_json = ?,
          started_at = COALESCE(started_at, ?), completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      status,
      fields.currentCaseId === undefined ? current.currentCaseId ?? null : fields.currentCaseId,
      fields.pauseReason === undefined ? current.pauseReason ?? null : fields.pauseReason,
      fields.failure === undefined ? current.failure ? JSON.stringify(current.failure) : null : fields.failure ? JSON.stringify(fields.failure) : null,
      startedAt,
      completedAt,
      now,
      id,
    )
    this.event(id, 'run.status', { from: current.status, to: status, pauseReason: fields.pauseReason ?? null })
  }

  startCase(id: string, experimentRunId: string): void {
    const now = new Date().toISOString()
    this.database.prepare(`
      UPDATE training_cases SET status = 'running', experiment_run_id = ?, experiment_case_id = NULL,
        attempt = attempt + 1, failure_json = NULL, started_at = ?, completed_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(experimentRunId, now, now, id)
  }

  retryCase(id: string): void {
    const current = this.getCase(id)
    if (current.status === 'completed') throw new Error('completed training cases cannot be retried')
    const status: TrainingCaseStatus = current.passed === undefined ? 'queued' : 'evaluated'
    const now = new Date().toISOString()
    this.database.prepare(`
      UPDATE training_cases SET status = ?, failure_json = NULL,
        completed_at = NULL, updated_at = ? WHERE id = ?
    `).run(status, now, id)
  }

  failCase(id: string, value: ExperimentFailure): void {
    const now = new Date().toISOString()
    this.database.prepare(`
      UPDATE training_cases SET status = 'error', failure_json = ?,
        completed_at = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(value), now, now, id)
  }

  recordEvaluation(id: string, value: {
    experimentCaseId: string
    actualAnswer: string
    actualTools: string[]
    toolCalls: ExperimentToolCall[]
    usage: ExperimentUsage
    score?: number
    passed?: boolean
    rationale?: string
    evaluation?: ExperimentCaseDetail['evaluation']
    failure?: ExperimentFailure
  }): void {
    const now = new Date().toISOString()
    this.database.prepare(`
      UPDATE training_cases SET status = ?, experiment_case_id = ?, actual_answer = ?,
        actual_tools_json = ?, tool_calls_json = ?, usage_json = ?, score = ?, passed = ?,
        rationale = ?, evaluation_json = ?, failure_json = ?, completed_at = ?, updated_at = ? WHERE id = ?
    `).run(
      value.failure ? 'error' : 'evaluated', value.experimentCaseId, value.actualAnswer,
      JSON.stringify(value.actualTools), JSON.stringify(value.toolCalls), JSON.stringify(value.usage),
      value.score ?? null, value.passed === undefined ? null : Number(value.passed),
      value.rationale ?? null, value.evaluation ? JSON.stringify(value.evaluation) : null,
      value.failure ? JSON.stringify(value.failure) : null,
      now, now, id,
    )
  }

  updateCaseEvaluation(id: string, evaluation: NonNullable<ExperimentCaseDetail['evaluation']>): void {
    const changes = this.database.prepare(`
      UPDATE training_cases SET evaluation_json = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(evaluation), new Date().toISOString(), id)
    if (changes.changes === 0) throw new Error(`training case was not found: ${id}`)
  }

  setCaseStatus(id: string, status: TrainingCaseStatus): void {
    const now = new Date().toISOString()
    this.database.prepare(`
      UPDATE training_cases SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?
    `).run(status, ['completed', 'unresolved', 'error'].includes(status) ? now : null, now, id)
  }

  createCorrectionAttempt(item: TrainingCorrectionAttempt): void {
    this.database.prepare(`
      INSERT INTO training_correction_attempts (
        id, run_id, source_case_id, ordinal, hook_id, summary, strategy,
        variable_overrides_json, experiment_run_id, experiment_case_id, actual_answer,
        actual_tools_json, tool_calls_json, usage_json, hook_usage_json, score, passed,
        rationale, evaluation_json, failure_json, terminal_reason, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.id, item.runId, item.sourceCaseId, item.ordinal, item.hookId, item.summary,
      item.strategy, JSON.stringify(item.variableOverrides), item.experimentRunId ?? null,
      item.experimentCaseId ?? null, item.actualAnswer, JSON.stringify(item.actualTools),
      JSON.stringify(item.toolCalls), JSON.stringify(item.usage), JSON.stringify(item.hookUsage),
      item.score, Number(item.passed), item.rationale,
      item.evaluation ? JSON.stringify(item.evaluation) : null,
      item.failure ? JSON.stringify(item.failure) : null, item.terminalReason ?? null,
      item.startedAt, item.completedAt,
    )
    this.event(item.runId, 'correction.attempted', {
      sourceCaseId: item.sourceCaseId,
      ordinal: item.ordinal,
      passed: item.passed,
      score: item.score,
      terminalReason: item.terminalReason ?? null,
      totalTokens: item.usage.totalTokens ?? 0,
      hookTokens: item.hookUsage.totalTokens ?? 0,
    })
  }

  listCorrectionAttempts(runId: string, sourceCaseId?: string): TrainingCorrectionAttempt[] {
    this.getRun(runId)
    const rows = sourceCaseId
      ? this.database.prepare(`
          SELECT * FROM training_correction_attempts
          WHERE run_id = ? AND source_case_id = ? ORDER BY ordinal
        `).all(runId, sourceCaseId)
      : this.database.prepare(`
          SELECT * FROM training_correction_attempts WHERE run_id = ? ORDER BY source_case_id, ordinal
        `).all(runId)
    return (rows as CorrectionAttemptRow[]).map((row) => ({
      id: row.id,
      runId: row.run_id,
      sourceCaseId: row.source_case_id,
      ordinal: row.ordinal,
      hookId: row.hook_id,
      summary: row.summary,
      strategy: row.strategy,
      variableOverrides: parseJson(row.variable_overrides_json, {}),
      ...(row.experiment_run_id ? { experimentRunId: row.experiment_run_id } : {}),
      ...(row.experiment_case_id ? { experimentCaseId: row.experiment_case_id } : {}),
      actualAnswer: row.actual_answer,
      actualTools: parseJson(row.actual_tools_json, []),
      toolCalls: parseJson(row.tool_calls_json, []),
      usage: { ...EMPTY_USAGE, ...parseJson(row.usage_json, EMPTY_USAGE) },
      hookUsage: { ...EMPTY_USAGE, ...parseJson(row.hook_usage_json, EMPTY_USAGE) },
      score: row.score,
      passed: Boolean(row.passed),
      rationale: row.rationale,
      ...(row.evaluation_json ? { evaluation: parseJson(row.evaluation_json, undefined) } : {}),
      ...(row.failure_json ? { failure: parseJson(row.failure_json, undefined) } : {}),
      ...(row.terminal_reason ? { terminalReason: row.terminal_reason } : {}),
      startedAt: row.started_at,
      completedAt: row.completed_at,
    }))
  }

  acknowledgeFailurePause(id: string): void {
    this.database.prepare('UPDATE training_cases SET failure_pause_handled = 1, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id)
  }

  createExperiences(items: ExperienceCandidate[]): void {
    this.transaction(() => {
      const insert = this.database.prepare(`
        INSERT INTO experience_candidates (
          id, run_id, source_case_id, source_outcome, hook_id, summary, rationale,
          status, replay_case_id, replay_passed, replay_score, replay_rationale,
          stage, level, context_budget_tokens, replay_generation, replay_count,
          required_clean_replays, revision, content_hash, source_candidate_id,
          entry_ids_json, parent_revision, promotion_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const insertPatch = this.database.prepare(`
        INSERT INTO experience_patches (
          candidate_id, ordinal, variable_name, base_hash, unified_diff, before_value, after_value
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      for (const item of items) {
        insert.run(
          item.id, item.runId, item.sourceCaseId, item.sourceOutcome, item.hookId,
          item.summary, item.rationale, item.status, item.replayCaseId ?? null,
          item.replayPassed === undefined ? null : Number(item.replayPassed),
          item.replayScore ?? null, item.replayRationale ?? null,
          item.stage, item.level, item.contextBudgetTokens, item.replayGeneration,
          item.replayCount, item.requiredCleanReplays, item.revision, item.contentHash,
          item.sourceCandidateId || item.id, JSON.stringify(item.entryIds),
          item.parentRevision ?? null, item.promotionId ?? null, item.createdAt, item.updatedAt,
        )
        item.patches.forEach((patch, ordinal) => insertPatch.run(
          item.id, ordinal, patch.variableName, patch.baseHash, patch.unifiedDiff,
          patch.beforeValue ?? null, patch.afterValue ?? null,
        ))
      }
    })
  }

  listExperiences(runId: string): ExperienceCandidate[] {
    this.getRun(runId)
    const rows = this.database.prepare(`
      SELECT * FROM experience_candidates WHERE run_id = ? ORDER BY created_at, id
    `).all(runId) as ExperienceRow[]
    return rows.map((row) => this.experience(row))
  }

  getExperience(id: string): ExperienceCandidate {
    const row = this.database.prepare('SELECT * FROM experience_candidates WHERE id = ?').get(id) as ExperienceRow | undefined
    if (!row) throw new Error(`experience candidate was not found: ${id}`)
    return this.experience(row)
  }

  updateExperiencePatches(id: string, patches: VariableDiff[]): ExperienceCandidate {
    const current = this.getExperience(id)
    if (['applied', 'rejected'].includes(current.status)) throw new Error('decided experience cannot be edited')
    this.transaction(() => {
      this.database.prepare('DELETE FROM experience_patches WHERE candidate_id = ?').run(id)
      const insert = this.database.prepare(`
        INSERT INTO experience_patches (
          candidate_id, ordinal, variable_name, base_hash, unified_diff, before_value, after_value
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      patches.forEach((patch, ordinal) => insert.run(
        id, ordinal, patch.variableName, patch.baseHash, patch.unifiedDiff,
        patch.beforeValue ?? null, patch.afterValue ?? null,
      ))
      this.database.prepare(`
        UPDATE experience_candidates SET status = 'draft', replay_case_id = NULL,
          replay_passed = NULL, replay_score = NULL, replay_rationale = NULL, updated_at = ?
        WHERE id = ?
      `).run(new Date().toISOString(), id)
    })
    return this.getExperience(id)
  }

  recordExperienceReplay(id: string, replay: {
    caseId: string
    passed: boolean
    score: number
    rationale: string
  }): ExperienceCandidate {
    const current = this.getExperience(id)
    if (['applied', 'rejected'].includes(current.status)) throw new Error('decided experience cannot be replayed')
    this.database.prepare(`
      UPDATE experience_candidates SET status = ?, replay_case_id = ?, replay_passed = ?,
        replay_score = ?, replay_rationale = ?, replay_count = replay_count + 1, updated_at = ?
      WHERE id = ?
    `).run(
      replay.passed ? 'accepted' : 'replay_failed', replay.caseId, Number(replay.passed),
      replay.score, replay.rationale, new Date().toISOString(), id,
    )
    return this.getExperience(id)
  }

  transitionExperience(
    id: string,
    patches: VariableDiff[],
    lifecycle: ExperienceLifecycle,
    expected: { stage: ExperienceLifecycle['stage']; revision: number; contentHash: string },
    finalized: boolean,
  ): ExperienceCandidate {
    const current = this.getExperience(id)
    if (current.promotionId === lifecycle.promotionId
      && current.stage === lifecycle.stage
      && current.level === lifecycle.level
      && current.contentHash === lifecycle.contentHash) {
      return current
    }
    if (current.stage !== expected.stage || current.revision !== expected.revision || current.contentHash !== expected.contentHash) {
      throw new Error('experience changed since promotion was proposed')
    }
    if (current.replayPassed !== true) throw new Error('experience promotion requires a passing replay')
    if (finalized && current.replayCount < current.requiredCleanReplays) {
      throw new Error('experience promotion requires all clean replays to pass')
    }
    const allowed = current.stage === 'candidate'
      ? lifecycle.stage === 'project_experience' && lifecycle.level === 2
      : current.stage === 'project_experience'
        ? lifecycle.stage === 'plugin_stable' && lifecycle.level === 3
        : false
    if (!allowed || lifecycle.level !== current.level + 1) throw new Error('invalid experience promotion transition')
    if (lifecycle.contextBudgetTokens > current.contextBudgetTokens) {
      throw new Error('experience promotion cannot increase its context budget')
    }
    if (lifecycle.revision !== current.revision + 1 || lifecycle.parentRevision !== current.revision) {
      throw new Error('experience promotion revision is not contiguous')
    }
    if (!lifecycle.promotionId) throw new Error('experience promotion requires an idempotency key')
    const duplicate = this.database.prepare(`
      SELECT id FROM experience_candidates WHERE promotion_id = ? AND id <> ?
    `).get(lifecycle.promotionId, id) as { id: string } | undefined
    if (duplicate) throw new Error('experience promotion id was already used')
    this.transaction(() => {
      this.database.prepare('DELETE FROM experience_patches WHERE candidate_id = ?').run(id)
      const insert = this.database.prepare(`
        INSERT INTO experience_patches (
          candidate_id, ordinal, variable_name, base_hash, unified_diff, before_value, after_value
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      patches.forEach((patch, ordinal) => insert.run(
        id, ordinal, patch.variableName, patch.baseHash, patch.unifiedDiff,
        patch.beforeValue ?? null, patch.afterValue ?? null,
      ))
      this.database.prepare(`
        UPDATE experience_candidates SET status = ?, stage = ?, level = ?,
          context_budget_tokens = ?, replay_generation = ?, required_clean_replays = ?,
          revision = ?, content_hash = ?, source_candidate_id = ?, entry_ids_json = ?,
          parent_revision = ?, promotion_id = ?, replay_case_id = ?, replay_passed = ?,
          replay_score = ?, replay_rationale = ?, updated_at = ? WHERE id = ?
      `).run(
        finalized ? 'accepted' : 'draft', lifecycle.stage, lifecycle.level,
        lifecycle.contextBudgetTokens, lifecycle.replayGeneration, lifecycle.requiredCleanReplays,
        lifecycle.revision, lifecycle.contentHash, lifecycle.sourceCandidateId,
        JSON.stringify(lifecycle.entryIds), lifecycle.parentRevision ?? null, lifecycle.promotionId ?? null,
        finalized ? current.replayCaseId ?? null : null,
        finalized ? Number(current.replayPassed === true) : null,
        finalized ? current.replayScore ?? null : null,
        finalized ? current.replayRationale ?? null : null,
        new Date().toISOString(), id,
      )
      this.event(current.runId, 'experience.transitioned', {
        candidateId: id,
        promotionId: lifecycle.promotionId,
        from: { stage: current.stage, level: current.level, revision: current.revision },
        to: { stage: lifecycle.stage, level: lifecycle.level, revision: lifecycle.revision },
        replayCount: current.replayCount,
        contentHash: lifecycle.contentHash,
        finalized,
      })
      this.event(current.runId, 'experience.promoted', {
        candidateId: id,
        promotionId: lifecycle.promotionId,
        stage: lifecycle.stage,
        level: lifecycle.level,
        revision: lifecycle.revision,
        contentHash: lifecycle.contentHash,
      })
    })
    return this.getExperience(id)
  }

  setExperienceStatus(id: string, status: ExperienceStatus, replay?: {
    caseId: string
    passed: boolean
    score: number
    rationale: string
  }): void {
    this.database.prepare(`
      UPDATE experience_candidates SET status = ?, replay_case_id = ?, replay_passed = ?,
        replay_score = ?, replay_rationale = ?, updated_at = ? WHERE id = ?
    `).run(
      status,
      replay?.caseId ?? null,
      replay === undefined ? null : Number(replay.passed),
      replay?.score ?? null,
      replay?.rationale ?? null,
      new Date().toISOString(),
      id,
    )
  }

  addAudits(audits: VariableWriteAudit[]): void {
    const insert = this.database.prepare(`
      INSERT INTO variable_write_audits (
        id, run_id, candidate_id, source_case_id, variable_name, before_value,
        after_value, unified_diff, before_hash, after_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.transaction(() => {
      for (const item of audits) insert.run(
        item.id, item.runId, item.candidateId, item.sourceCaseId, item.variableName,
        item.beforeValue, item.afterValue, item.unifiedDiff, item.beforeHash,
        item.afterHash, item.createdAt,
      )
    })
  }

  createSnapshot(snapshot: TestSnapshot): TestSnapshot {
    this.database.prepare(`
      INSERT INTO training_snapshots (id, run_id, variables_json, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(snapshot.id, snapshot.runId, JSON.stringify(snapshot.variables), snapshot.contentHash, snapshot.createdAt)
    this.database.prepare(`
      UPDATE training_runs SET snapshot_id = ?, status = 'ready_for_test', updated_at = ? WHERE id = ?
    `).run(snapshot.id, snapshot.createdAt, snapshot.runId)
    this.event(snapshot.runId, 'snapshot.created', { snapshotId: snapshot.id, contentHash: snapshot.contentHash })
    return snapshot
  }

  getSnapshot(runId: string): TestSnapshot | undefined {
    const run = this.getRun(runId)
    if (!run.snapshotId) return undefined
    const row = this.database.prepare('SELECT * FROM training_snapshots WHERE id = ?').get(run.snapshotId) as {
      id: string
      run_id: string
      variables_json: string
      content_hash: string
      created_at: string
    } | undefined
    return row ? {
      id: row.id,
      runId: row.run_id,
      variables: parseJson(row.variables_json, {}),
      contentHash: row.content_hash,
      createdAt: row.created_at,
    } : undefined
  }

  baselineVariables(runId: string): Record<string, string> {
    this.getRun(runId)
    const rows = this.database.prepare(`
      SELECT variable_name, value
      FROM training_variable_baselines
      WHERE run_id = ?
      ORDER BY variable_name
    `).all(runId) as Array<{ variable_name: string; value: string }>
    return Object.fromEntries(rows.map((row) => [row.variable_name, row.value]))
  }

  runVariables(runId: string): Record<string, string> {
    this.getRun(runId)
    const rows = this.database.prepare(`
      SELECT variable_name, value
      FROM training_variable_states
      WHERE run_id = ?
      ORDER BY variable_name
    `).all(runId) as Array<{ variable_name: string; value: string }>
    if (rows.length > 0) return Object.fromEntries(rows.map((row) => [row.variable_name, row.value]))
    return this.baselineVariables(runId)
  }

  replaceRunVariables(runId: string, variables: Record<string, string>): void {
    this.getRun(runId)
    this.transaction(() => {
      this.database.prepare('DELETE FROM training_variable_states WHERE run_id = ?').run(runId)
      const insert = this.database.prepare(`
        INSERT INTO training_variable_states (run_id, variable_name, value)
        VALUES (?, ?, ?)
      `)
      for (const [name, value] of Object.entries(variables)) insert.run(runId, name, value)
    })
    this.event(runId, 'variables.updated', { variables: Object.keys(variables).sort() })
  }

  publishExperience(id: string, variables: Record<string, string>, payload: Record<string, unknown>): void {
    const candidate = this.getExperience(id)
    if ((candidate.requiredCleanReplays > 1 && candidate.stage === 'candidate')
      || candidate.replayCount < candidate.requiredCleanReplays) {
      throw new Error('experience has not completed its replay admission policy')
    }
    this.transaction(() => {
      this.database.prepare('DELETE FROM training_variable_states WHERE run_id = ?').run(candidate.runId)
      const insert = this.database.prepare(`
        INSERT INTO training_variable_states (run_id, variable_name, value) VALUES (?, ?, ?)
      `)
      for (const [name, value] of Object.entries(variables)) insert.run(candidate.runId, name, value)
      this.database.prepare(`
        UPDATE experience_candidates SET status = 'applied', updated_at = ? WHERE id = ?
      `).run(new Date().toISOString(), id)
      this.event(candidate.runId, 'variables.updated', { variables: Object.keys(variables).sort() })
      this.event(candidate.runId, 'experience.published', payload)
    })
  }

  recordEvent(runId: string, type: string, payload: unknown): void {
    this.getRun(runId)
    this.event(runId, type, payload)
  }

  listVariableAudits(runId: string): VariableWriteAudit[] {
    this.getRun(runId)
    const rows = this.database.prepare(`
      SELECT id, run_id, candidate_id, source_case_id, variable_name, before_value,
        after_value, unified_diff, before_hash, after_hash, created_at
      FROM variable_write_audits
      WHERE run_id = ?
      ORDER BY created_at, id
    `).all(runId) as Array<{
      id: string
      run_id: string
      candidate_id: string
      source_case_id: string
      variable_name: string
      before_value: string
      after_value: string
      unified_diff: string
      before_hash: string
      after_hash: string
      created_at: string
    }>
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      candidateId: row.candidate_id,
      sourceCaseId: row.source_case_id,
      variableName: row.variable_name,
      beforeValue: row.before_value,
      afterValue: row.after_value,
      unifiedDiff: row.unified_diff,
      beforeHash: row.before_hash,
      afterHash: row.after_hash,
      createdAt: row.created_at,
    }))
  }

  listEvents(runId: string): TrainingEvent[] {
    this.getRun(runId)
    const rows = this.database.prepare(`
      SELECT id, run_id, type, payload_json, created_at
      FROM training_events
      WHERE run_id = ?
      ORDER BY id
    `).all(runId) as Array<{
      id: number
      run_id: string
      type: string
      payload_json: string
      created_at: string
    }>
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      type: row.type,
      payload: parseJson<unknown>(row.payload_json, null),
      createdAt: row.created_at,
    }))
  }

  close(): void {
    this.database.close()
  }

  private run(row: RunRow): TrainingRun {
    const counts = this.database.prepare(`
      SELECT
        SUM(CASE WHEN phase = 'training' THEN 1 ELSE 0 END) AS train_total,
        SUM(CASE WHEN phase = 'training' AND status = 'completed' THEN 1 ELSE 0 END) AS train_completed,
        SUM(CASE WHEN phase = 'testing' THEN 1 ELSE 0 END) AS test_total,
        SUM(CASE WHEN phase = 'testing' AND status = 'completed' THEN 1 ELSE 0 END) AS test_completed
      FROM training_cases WHERE run_id = ?
    `).get(row.id) as { train_total: number; train_completed: number; test_total: number; test_completed: number }
    const experiences = this.database.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending_review' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status IN ('accepted', 'applied') THEN 1 ELSE 0 END) AS accepted,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
      FROM experience_candidates WHERE run_id = ?
    `).get(row.id) as { pending: number; accepted: number; rejected: number }
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      config: {
        ...TRAINING_CONFIG_DEFAULTS,
        ...parseJson<TrainingConfig>(row.config_json, {} as TrainingConfig),
      },
      progress: {
        training: { total: Number(counts.train_total ?? 0), completed: Number(counts.train_completed ?? 0) },
        testing: { total: Number(counts.test_total ?? 0), completed: Number(counts.test_completed ?? 0) },
        pendingReview: Number(experiences.pending ?? 0),
        acceptedExperiences: Number(experiences.accepted ?? 0),
        rejectedExperiences: Number(experiences.rejected ?? 0),
      },
      ...(row.current_case_id ? { currentCaseId: row.current_case_id } : {}),
      ...(row.pause_reason ? { pauseReason: row.pause_reason } : {}),
      ...(row.snapshot_id ? { snapshotId: row.snapshot_id } : {}),
      ...(row.failure_json ? { failure: parseJson<ExperimentFailure>(row.failure_json, { code: 'UNKNOWN', message: 'Unknown failure' }) } : {}),
      createdAt: row.created_at,
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      updatedAt: row.updated_at,
    }
  }

  private case(row: CaseRow): TrainingCase {
    return {
      id: row.id,
      runId: row.run_id,
      phase: row.phase,
      datasetId: row.dataset_id,
      sampleId: row.sample_id,
      ordinal: row.ordinal,
      status: row.status,
      question: row.question,
      thinking: row.thinking,
      expectedAnswer: row.expected_answer,
      actualAnswer: row.actual_answer,
      expectedTools: parseJson(row.expected_tools_json, []),
      actualTools: parseJson(row.actual_tools_json, []),
      toolCalls: parseJson<ExperimentToolCall[]>(row.tool_calls_json, []),
      usage: { ...EMPTY_USAGE, ...parseJson(row.usage_json, EMPTY_USAGE) },
      ...(row.score === null ? {} : { score: row.score }),
      ...(row.passed === null ? {} : { passed: Boolean(row.passed) }),
      ...(row.rationale ? { rationale: row.rationale } : {}),
      ...(row.evaluation_json
        ? { evaluation: parseJson<NonNullable<ExperimentCaseDetail['evaluation']>>(row.evaluation_json, { source: 'project', metrics: {} }) }
        : {}),
      ...(row.experiment_run_id ? { experimentRunId: row.experiment_run_id } : {}),
      ...(row.experiment_case_id ? { experimentCaseId: row.experiment_case_id } : {}),
      failurePauseHandled: Boolean(row.failure_pause_handled),
      attempt: row.attempt,
      ...(row.failure_json ? { failure: parseJson<ExperimentFailure>(row.failure_json, { code: 'UNKNOWN', message: 'Unknown failure' }) } : {}),
      createdAt: row.created_at,
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      updatedAt: row.updated_at,
    }
  }

  private experience(row: ExperienceRow): ExperienceCandidate {
    const patches = this.database.prepare(`
      SELECT variable_name, base_hash, unified_diff, before_value, after_value
      FROM experience_patches WHERE candidate_id = ? ORDER BY ordinal
    `).all(row.id) as Array<{
      variable_name: string
      base_hash: string
      unified_diff: string
      before_value: string | null
      after_value: string | null
    }>
    return {
      id: row.id,
      runId: row.run_id,
      sourceCaseId: row.source_case_id,
      sourceOutcome: row.source_outcome,
      hookId: row.hook_id,
      summary: row.summary,
      rationale: row.rationale,
      patches: patches.map((patch) => ({
        variableName: patch.variable_name,
        baseHash: patch.base_hash,
        unifiedDiff: patch.unified_diff,
        ...(patch.before_value === null ? {} : { beforeValue: patch.before_value }),
        ...(patch.after_value === null ? {} : { afterValue: patch.after_value }),
      })),
      status: row.status,
      stage: row.stage,
      level: row.level as 1 | 2 | 3,
      contextBudgetTokens: row.context_budget_tokens,
      replayGeneration: row.replay_generation,
      replayCount: row.replay_count,
      requiredCleanReplays: row.required_clean_replays,
      revision: row.revision,
      contentHash: row.content_hash,
      sourceCandidateId: row.source_candidate_id || row.id,
      entryIds: parseJson<string[]>(row.entry_ids_json, []),
      ...(row.parent_revision === null ? {} : { parentRevision: row.parent_revision }),
      ...(row.promotion_id ? { promotionId: row.promotion_id } : {}),
      ...(row.replay_case_id ? { replayCaseId: row.replay_case_id } : {}),
      ...(row.replay_passed === null ? {} : { replayPassed: Boolean(row.replay_passed) }),
      ...(row.replay_score === null ? {} : { replayScore: row.replay_score }),
      ...(row.replay_rationale ? { replayRationale: row.replay_rationale } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private event(runId: string, type: string, payload: unknown): void {
    this.database.prepare(`
      INSERT INTO training_events (run_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)
    `).run(runId, type, JSON.stringify(payload), new Date().toISOString())
  }

  private transaction<T>(task: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const value = task()
      this.database.exec('COMMIT')
      return value
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private recoverInterrupted(): void {
    const now = new Date().toISOString()
    this.database.prepare(`
      UPDATE training_runs SET status = 'paused', pause_reason = 'Backend restarted; resume to continue.', updated_at = ?
      WHERE status IN ('queued', 'running', 'testing')
    `).run(now)
    this.database.prepare(`
      UPDATE training_cases SET status = 'queued', updated_at = ? WHERE status = 'running'
    `).run(now)
    this.database.prepare(`
      UPDATE training_cases SET status = 'evaluated', updated_at = ? WHERE status IN ('learning', 'replaying')
    `).run(now)
    this.database.prepare(`
      UPDATE experience_candidates SET status = 'draft', updated_at = ? WHERE status = 'replaying'
    `).run(now)
  }
}
