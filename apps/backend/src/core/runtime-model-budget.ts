import path from 'node:path'
import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { LlmAttemptAdmission, LlmAttemptInput, LlmChatRequest, LlmChatResponse, LlmUsage } from '#util/llm'
import { diagnosticContext, diagnosticLog } from '#util/llm/diagnostic-log'
import type { RuntimeLlm } from '#core/runtime-loop'

export interface ModelBudgetScope {
  sessionId: string
  taskId: string
  runId: string
}
export interface ModelBudgetLimits {
  maxTokens: number
  maxAttempts: number
}
export type ModelTokenCounter = (input: LlmAttemptInput) => number | undefined
export type ModelBudgetRole = 'main' | 'planning' | 'organize' | 'normalize' | 'reflection' | 'recall' | 'parent_merge' | 'dream' | 'hook' | 'child_host'
const DEFAULT_LIMITS: ModelBudgetLimits = { maxTokens: 1_000_000, maxAttempts: 128 }
export { DEFAULT_LIMITS as DEFAULT_MODEL_BUDGET }

export class RuntimeModelBudgetError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'RuntimeModelBudgetError'
  }
}

interface Attempt {
  scope: ModelBudgetScope
  actorSessionId: string
  role: ModelBudgetRole
  requestId: string
  input: LlmAttemptInput
  inputTokens: number
  estimation: 'configured_tokenizer' | 'character_estimate' | `chat_template:${string}`
}
type Outcome = Parameters<ReturnType<LlmAttemptAdmission>>[0]
export interface ModelBudgetAttemptEvidence {
  id: string
  provider: LlmAttemptInput['provider']
  protocol: LlmAttemptInput['protocol']
  model: string
  payloadHash: string
  estimation: Attempt['estimation']
  inputTokens: number
  outputReserve: number
  chargedTokens: number
  status: Outcome['status'] | 'reserved'
  httpStatus: number | null
  reportedTotalTokens: number | null
}

const params = (scope: ModelBudgetScope) => [scope.sessionId, scope.taskId, scope.runId] as const
function measuredTokens(usage: LlmUsage | undefined) {
  const tokens = (value: number | undefined) => Number.isSafeInteger(value) && value! >= 0 ? value : undefined
  const input = tokens(usage?.inputTokens)
  const output = tokens(usage?.outputTokens)
  const total = tokens(usage?.totalTokens)
  const subtotal = (input ?? 0) + (output ?? 0)
  return { input, output, total: total === undefined && input === undefined && output === undefined ? undefined : Math.max(total ?? 0, subtotal) }
}

/** Durable per-root-task reservations shared by all model roles and connections. */
export class RuntimeModelBudgetStore {
  private readonly db: DatabaseSync
  private closed = false
  constructor(readonly file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS context_session_tombstones(session_id TEXT PRIMARY KEY, cleared_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_model_budget_runs(
        session_id TEXT NOT NULL, task_id TEXT NOT NULL, run_id TEXT NOT NULL,
        max_tokens INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
        PRIMARY KEY(session_id,task_id,run_id)
      );
      CREATE TABLE IF NOT EXISTS runtime_model_budget_attempts(
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT NOT NULL, run_id TEXT NOT NULL,
        actor_session_id TEXT NOT NULL, request_id TEXT NOT NULL, role TEXT NOT NULL,
        provider TEXT NOT NULL, protocol TEXT NOT NULL, model TEXT NOT NULL,
        payload_hash TEXT NOT NULL, estimation TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, output_reserve INTEGER NOT NULL, charged_tokens INTEGER NOT NULL,
        status TEXT NOT NULL, http_status INTEGER, reported_input INTEGER, reported_output INTEGER,
        reported_total INTEGER, created_at TEXT NOT NULL, settled_at TEXT
      );
      CREATE INDEX IF NOT EXISTS runtime_model_budget_by_run ON runtime_model_budget_attempts(session_id,task_id,run_id);`)
  }

  close() {
    if (!this.closed) { this.closed = true; this.db.close() }
  }

  totals(scope: ModelBudgetScope) {
    const limit = this.db.prepare('SELECT max_tokens AS maxTokens, max_attempts AS maxAttempts FROM runtime_model_budget_runs WHERE session_id=? AND task_id=? AND run_id=?').get(...params(scope)) as unknown as ModelBudgetLimits | undefined
    if (!limit) return undefined
    const totals = this.db.prepare(`SELECT COUNT(*) AS attempts, COUNT(reported_total) AS attemptsWithUsage,
      COALESCE(SUM(charged_tokens),0) AS chargedTokens, COALESCE(SUM(reported_total),0) AS reportedTokens
      FROM runtime_model_budget_attempts WHERE session_id=? AND task_id=? AND run_id=?`).get(...params(scope)) as {
        attempts: number; chargedTokens: number; reportedTokens: number; attemptsWithUsage: number
      }
    return { ...limit, ...totals, remainingTokens: Math.max(0, limit.maxTokens - totals.chargedTokens),
      remainingAttempts: Math.max(0, limit.maxAttempts - totals.attempts) }
  }

  requestAttempts(scope: ModelBudgetScope, role: ModelBudgetRole, requestId: string, actorSessionId: string): ModelBudgetAttemptEvidence[] {
    return this.db.prepare(`SELECT id, provider, protocol, model, payload_hash AS payloadHash, estimation, input_tokens AS inputTokens,
      output_reserve AS outputReserve, charged_tokens AS chargedTokens, status, http_status AS httpStatus, reported_total AS reportedTotalTokens
      FROM runtime_model_budget_attempts WHERE session_id=? AND task_id=? AND run_id=? AND actor_session_id=? AND role=? AND request_id=? ORDER BY rowid`)
      .all(...params(scope), actorSessionId, role, requestId) as unknown as ModelBudgetAttemptEvidence[]
  }

  reserve(attempt: Attempt, limits: ModelBudgetLimits): string {
    const { scope, input } = attempt
    const charge = attempt.inputTokens + input.maxOutputTokens
    if (!Object.values(limits).every(limit => Number.isSafeInteger(limit) && limit > 0)) {
      throw new RuntimeModelBudgetError('RUNTIME_MODEL_BUDGET_CONFIG', 'run limits must be positive safe integers')
    }
    let began = false
    try {
      this.db.exec('BEGIN IMMEDIATE')
      began = true
      if (this.db.prepare('SELECT 1 FROM context_session_tombstones WHERE session_id IN (?,?)').get(scope.sessionId, attempt.actorSessionId)) {
        throw new RuntimeModelBudgetError('CONTEXT_SESSION_CLEARED', 'model budget scope was cleared')
      }
      this.db.prepare('INSERT OR IGNORE INTO runtime_model_budget_runs VALUES (?,?,?,?,?)').run(...params(scope), limits.maxTokens, limits.maxAttempts)
      const totals = this.totals(scope)!
      if (totals.attempts >= totals.maxAttempts || totals.chargedTokens + charge > totals.maxTokens) {
        throw new RuntimeModelBudgetError('RUNTIME_MODEL_BUDGET_EXHAUSTED',
          `${attempt.role} requires ${charge} tokens, ${totals.remainingTokens} tokens and ${totals.maxAttempts - totals.attempts} attempts remain`)
      }
      const id = `model-attempt-${randomUUID()}`
      this.db.prepare(`INSERT INTO runtime_model_budget_attempts (
        id,session_id,task_id,run_id,actor_session_id,request_id,role,provider,protocol,model,
        payload_hash,estimation,input_tokens,output_reserve,charged_tokens,status,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, ...params(scope), attempt.actorSessionId, attempt.requestId, attempt.role, input.provider, input.protocol, input.model,
        createHash('sha256').update(input.serializedBody).digest('hex'), attempt.estimation, attempt.inputTokens,
        input.maxOutputTokens, charge, 'reserved', new Date().toISOString(),
      )
      this.db.exec('COMMIT')
      return id
    } catch (error) {
      if (began) this.db.exec('ROLLBACK')
      if (error instanceof RuntimeModelBudgetError) throw error
      throw new RuntimeModelBudgetError('RUNTIME_MODEL_BUDGET_STORAGE', error instanceof Error ? error.message : String(error))
    }
  }

  settle(id: string, outcome: Outcome) {
    const usage = measuredTokens(outcome.usage)
    this.db.prepare(`UPDATE runtime_model_budget_attempts SET status=?, http_status=?,
      reported_input=?, reported_output=?, reported_total=?, charged_tokens=MAX(charged_tokens,?),settled_at=?
      WHERE id=? AND status='reserved'`).run(outcome.status, outcome.statusCode ?? null,
      usage.input ?? null, usage.output ?? null, usage.total ?? null, usage.total ?? 0, new Date().toISOString(), id)
  }
}

export interface ModelMeterOptions {
  scope: ModelBudgetScope
  actorSessionId: string
  role: ModelBudgetRole
  requestId?: string
  limits: ModelBudgetLimits
  maxInputTokens: number
  maxOutputTokens: number
  contextWindowTokens: number
  countTokens?: ModelTokenCounter
  assertActive: () => void
}

export class RuntimeModelMeter {
  readonly store: RuntimeModelBudgetStore
  private closed = false

  constructor(projectDir: string) {
    this.store = new RuntimeModelBudgetStore(path.join(projectDir, '.capybara/sessions.sqlite'))
  }

  close() { this.closed = true; this.store.close() }

  wrap(base: RuntimeLlm, options: ModelMeterOptions): RuntimeLlm {
    const invoke = async (request: LlmChatRequest, send: (request: LlmChatRequest) => Promise<LlmChatResponse>) => {
      const prepared: LlmChatRequest = {
        ...request,
        maxTokens: Math.min(request.maxTokens ?? options.maxOutputTokens, options.maxOutputTokens),
      }
      Object.defineProperties(prepared, {
        onRetry: { value: request.onRetry, enumerable: false },
        validateResponse: { value: request.validateResponse, enumerable: false },
      })
      const diagnostics = diagnosticContext.getStore()
      const sourceRequest = options.requestId ?? diagnostics?.requestArtifactId ?? diagnostics?.requestId
      const requestId = typeof sourceRequest === 'string' ? sourceRequest : `model-call-${randomUUID()}`
      const admit: LlmAttemptAdmission = input => {
        try { options.assertActive() }
        catch (error) {
          if (error instanceof RuntimeModelBudgetError) throw error
          throw new RuntimeModelBudgetError('RUNTIME_MODEL_SCOPE_STALE', error instanceof Error ? error.message : String(error))
        }
        prepared.signal?.throwIfAborted()
        if (this.closed) throw new RuntimeModelBudgetError('RUNTIME_MODEL_BUDGET_CLOSED', 'model budget owner closed')
        let measured
        let templateIdentity: string | undefined
        try {
          const template = input.chatTemplateTokenizer?.measure()
          measured = template ? template.inputTokens : options.countTokens?.(input)
          templateIdentity = template?.identity
        }
        catch (error) {
          throw new RuntimeModelBudgetError('RUNTIME_MODEL_BUDGET_TOKEN_COUNT', error instanceof Error ? error.message : String(error))
        }
        const inputTokens = measured ?? Math.ceil(input.serializedBody.length / 4)
        const contextWindow = Math.min(options.contextWindowTokens,
          input.chatTemplateTokenizer?.contextWindowTokens ?? options.contextWindowTokens)
        if (!Number.isSafeInteger(inputTokens) || inputTokens < 1 || !Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1) {
          throw new RuntimeModelBudgetError('RUNTIME_MODEL_BUDGET_TOKEN_COUNT', 'request has an invalid token count or output reserve')
        }
        if (!Number.isSafeInteger(contextWindow) || contextWindow < 1) {
          throw new RuntimeModelBudgetError('RUNTIME_MODEL_BUDGET_CONFIG', 'model context window must be a positive safe integer')
        }
        if (inputTokens > options.maxInputTokens || inputTokens + input.maxOutputTokens > contextWindow) {
          throw new RuntimeModelBudgetError('RUNTIME_MODEL_CONTEXT_WINDOW',
            `${options.role} request requires ${inputTokens} input and ${input.maxOutputTokens} output tokens, window ${contextWindow}, input limit ${options.maxInputTokens}`)
        }
        const id = this.store.reserve({ ...options, requestId, input, inputTokens,
          estimation: templateIdentity ? `chat_template:${templateIdentity}` : measured === undefined ? 'character_estimate' : 'configured_tokenizer' }, options.limits)
        return outcome => this.settle(id, outcome)
      }
      if (base.admitsTransportAttempts) {
        prepared.admitAttempt = admit
        return send(prepared)
      }
      const config = base.getConfig()
      const settle = admit({ provider: config.provider, protocol: config.protocol, model: prepared.model ?? config.model,
        serializedBody: JSON.stringify({ messages: prepared.messages, tools: prepared.tools, responseFormat: prepared.responseFormat,
          clientMetadata: prepared.clientMetadata, temperature: prepared.temperature, reasoningEffort: prepared.reasoningEffort,
          thinking: prepared.thinking, maxTokens: prepared.maxTokens }),
        maxOutputTokens: prepared.maxTokens! })
      try {
        const response = await send(prepared)
        settle({ status: 'returned', usage: response.usage })
        return response
      } catch (error) {
        settle({ status: 'unknown' })
        throw error
      }
    }
    return {
      getConfig: () => base.getConfig(),
      chat: request => invoke(request, bounded => base.chat(bounded)),
      ...(base.stream ? { stream: (request, onDelta) => invoke(request, bounded => base.stream!(bounded, onDelta)) } : {}),
    }
  }

  private settle(id: string, outcome: Outcome) {
    if (this.closed && !fs.existsSync(this.store.file)) return
    let lateStore: RuntimeModelBudgetStore | undefined
    try {
      const store = this.closed ? lateStore = new RuntimeModelBudgetStore(this.store.file) : this.store
      store.settle(id, outcome)
    } catch (error) {
      diagnosticLog('model_budget.settlement_failed', { modelAttemptId: id, errorType: error instanceof Error ? error.name : typeof error })
    } finally {
      lateStore?.close()
    }
  }
}
