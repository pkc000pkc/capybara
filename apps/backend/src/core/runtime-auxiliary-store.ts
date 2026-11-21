import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { capabilityHash } from '#core/runtime-capability-projection'
import type { RuntimeRequestBinding } from '#protocol/runtime-protocol'
import type { LlmChatRequest, LlmChatResponse, LlmConfig } from '#util/llm'

export type AuxiliaryMode = 'reflection' | 'normalize' | 'recall' | 'parent_merge' | 'dream'
export type AuxiliaryScope = Pick<RuntimeRequestBinding, 'sessionId' | 'taskId' | 'runId'>
export interface AuxiliaryBudget { maxCalls: number; maxTotalTokens: number; maxInputTokens: number; maxOutputTokens: number; timeoutMs: number }
export interface AuxiliaryRecord {
  id: string; operationId: string; mode: AuxiliaryMode; binding: RuntimeRequestBinding; snapshotId: string; contextHash: string
  schemaHash: string; promptBindings: Array<{ role: string; version: string; hash: string }>; request: LlmChatRequest
  modelBinding?: Pick<LlmConfig,'provider'|'protocol'|'model'>
  status: 'running' | 'succeeded' | 'failed' | 'unknown'; owner: string; inputTokens: number; chargedTokens: number; deadlineAt: string; createdAt: string
  output?: unknown; response?: Pick<LlmChatResponse,'text'|'usage'|'model'|'provider'|'toolCalls'|'finishReason'>; resultHash?: string; error?: string
  consumption?: { decision: 'accepted' | 'stale' | 'failed'; receiptId: string; at: string; artifactId?: string }
}
type Row = { state_json: string }
const same = (a: AuxiliaryScope, b: AuxiliaryScope) => a.sessionId === b.sessionId && a.taskId === b.taskId && a.runId === b.runId

/** Host journal: model suggestions never sign the reservation, result or consumption receipts. */
export class RuntimeAuxiliaryStore {
  private readonly db: DatabaseSync
  private closed = false
  constructor(projectDir: string) {
    fs.mkdirSync(path.join(projectDir, '.capybara'), { recursive: true })
    this.db = new DatabaseSync(path.join(projectDir, '.capybara/sessions.sqlite'))
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS context_session_tombstones(session_id TEXT PRIMARY KEY,cleared_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_auxiliary_calls(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,run_id TEXT NOT NULL,operation_id TEXT NOT NULL,semantic_hash TEXT NOT NULL,state_json TEXT NOT NULL,UNIQUE(session_id,run_id,operation_id));
      CREATE TABLE IF NOT EXISTS runtime_auxiliary_events(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,call_id TEXT NOT NULL,event TEXT NOT NULL,state_json TEXT NOT NULL);
    `)
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close() } }
  private live(sessionId: string): void {
    if (this.closed) throw new Error('AUXILIARY_STORE_CLOSED')
    if (this.db.prepare('SELECT 1 FROM context_session_tombstones WHERE session_id=?').get(sessionId)) throw new Error('CONTEXT_SESSION_CLEARED')
  }
  private tx<T>(sessionId: string, action: () => T): T {
    if (this.closed) throw new Error('AUXILIARY_STORE_CLOSED')
    this.db.exec('BEGIN IMMEDIATE')
    try { this.live(sessionId); const result = action(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  get(scope: AuxiliaryScope, id: string): AuxiliaryRecord {
    this.live(scope.sessionId)
    const row = this.db.prepare('SELECT state_json FROM runtime_auxiliary_calls WHERE id=?').get(id) as Row | undefined
    if (!row) throw new Error('AUXILIARY_NOT_FOUND')
    const record: AuxiliaryRecord = JSON.parse(row.state_json)
    if (!same(scope, record.binding)) throw new Error('AUXILIARY_BINDING_MISMATCH')
    return record
  }
  find(scope: AuxiliaryScope, operationId: string): AuxiliaryRecord | undefined {
    this.live(scope.sessionId)
    const row = this.db.prepare('SELECT state_json FROM runtime_auxiliary_calls WHERE session_id=? AND run_id=? AND operation_id=?').get(scope.sessionId, scope.runId, operationId) as Row | undefined
    if (!row) return
    const record: AuxiliaryRecord = JSON.parse(row.state_json)
    if (!same(scope, record.binding)) throw new Error('AUXILIARY_BINDING_MISMATCH')
    return record
  }
  list(scope: AuxiliaryScope): AuxiliaryRecord[] {
    this.live(scope.sessionId)
    return (this.db.prepare('SELECT state_json FROM runtime_auxiliary_calls WHERE session_id=? AND run_id=? ORDER BY rowid').all(scope.sessionId, scope.runId) as Row[])
      .map(row => JSON.parse(row.state_json) as AuxiliaryRecord).filter(record => same(scope, record.binding))
  }
  reserve(input: Omit<AuxiliaryRecord, 'id' | 'createdAt' | 'status' | 'deadlineAt' | 'chargedTokens'>, budget: AuxiliaryBudget): { record: AuxiliaryRecord; created: boolean } {
    if ([input.operationId, input.snapshotId, input.owner, input.binding.sessionId, input.binding.taskId, input.binding.runId, input.binding.requestId].some(value => !value || value.length > 512)
      || !['reflection','normalize','recall','parent_merge','dream'].includes(input.mode)
      || !/^[a-f0-9]{64}$/.test(input.contextHash) || !/^[a-f0-9]{64}$/.test(input.schemaHash)
      || !Number.isSafeInteger(input.binding.stateRevision) || input.binding.stateRevision < 0
      || !Number.isSafeInteger(input.inputTokens) || input.inputTokens < 1
      || input.inputTokens !== Math.ceil(JSON.stringify(input.request).length / 4)
      || Object.values(budget).some(value => !Number.isSafeInteger(value) || value < 1)
      || budget.maxCalls > 32 || budget.timeoutMs > 300000 || budget.maxOutputTokens > 16384 || budget.maxInputTokens > 128000 || budget.maxTotalTokens > 4000000
      || input.request.tools?.length || input.request.signal || input.request.onRetry || input.request.validateResponse
      || input.request.maxTokens !== budget.maxOutputTokens) throw new Error('AUXILIARY_RESERVATION_INVALID')
    if (input.inputTokens > budget.maxInputTokens) throw new Error('AUXILIARY_INPUT_BUDGET_EXCEEDED')
    return this.tx(input.binding.sessionId, () => {
      const semanticHash = capabilityHash({ ...input, owner: undefined })
      const prior = this.find(input.binding, input.operationId)
      if (prior) {
        const row = this.db.prepare('SELECT semantic_hash FROM runtime_auxiliary_calls WHERE id=?').get(prior.id) as { semantic_hash: string }
        if (row.semantic_hash !== semanticHash) throw new Error('AUXILIARY_OPERATION_CONFLICT')
        return { record: prior, created: false }
      }
      const previous = this.list(input.binding), charge = input.inputTokens + budget.maxOutputTokens
      if (previous.length >= budget.maxCalls || previous.reduce((sum, call) => sum + call.chargedTokens, 0) + charge > budget.maxTotalTokens) throw new Error('AUXILIARY_TOTAL_BUDGET_EXCEEDED')
      const record: AuxiliaryRecord = { ...input, id: `auxiliary-${randomUUID()}`, createdAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + budget.timeoutMs).toISOString(), status: 'running', chargedTokens: charge }
      this.db.prepare('INSERT INTO runtime_auxiliary_calls(id,session_id,run_id,operation_id,semantic_hash,state_json) VALUES(?,?,?,?,?,?)')
        .run(record.id, input.binding.sessionId, input.binding.runId, input.operationId, semanticHash, JSON.stringify(record))
      this.event(record, 'reserved', { budget, inputHash: capabilityHash(record.request) })
      return { record: structuredClone(record), created: true }
    })
  }
  settle(scope: AuxiliaryScope, id: string, owner: string, result: { output?: unknown; response?: AuxiliaryRecord['response']; error?: string }): AuxiliaryRecord {
    return this.tx(scope.sessionId, () => {
      const record = this.get(scope, id)
      if (record.status !== 'running' || record.owner !== owner || Date.now() >= Date.parse(record.deadlineAt)) {
        this.event(record, 'late_response', result)
        if (record.status === 'running' && record.owner === owner) { record.status = 'unknown'; record.error = 'AUXILIARY_DEADLINE_EXCEEDED'; this.write(record) }
        return record
      }
      if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw new Error('AUXILIARY_RESULT_LIMIT')
      record.status = result.error ? 'failed' : 'succeeded'; record.error = result.error; record.response = result.response; record.output = result.output
      record.resultHash = capabilityHash({ snapshotId: record.snapshotId, mode: record.mode, output: record.output ?? null, error: result.error ?? null })
      this.event(record, record.status, { resultHash: record.resultHash }); this.write(record); return record
    })
  }
  suspend(scope: AuxiliaryScope, id: string, owner: string, reason: string): AuxiliaryRecord {
    return this.tx(scope.sessionId, () => {
      const record = this.get(scope, id)
      if (record.status === 'running' && record.owner === owner) { record.status = 'unknown'; record.error = reason; this.event(record, 'interrupted', { reason }); this.write(record) }
      return record
    })
  }
  consume(scope: AuxiliaryScope, id: string, resultHash: string | undefined, contextHash: string, artifactId?: string): AuxiliaryRecord {
    return this.tx(scope.sessionId, () => {
      const record = this.get(scope, id)
      if (record.status === 'running') throw new Error('AUXILIARY_RESULT_PENDING')
      if (record.resultHash !== resultHash) throw new Error('AUXILIARY_RESULT_HASH_MISMATCH')
      if (record.consumption) return record
      record.consumption = { decision: record.status !== 'succeeded' ? 'failed' : record.contextHash === contextHash ? 'accepted' : 'stale',
        receiptId: `auxiliary-consumption-${randomUUID()}`, at: new Date().toISOString(), ...(artifactId ? { artifactId } : {}) }
      this.event(record, 'consumed', record.consumption); this.write(record); return record
    })
  }
  audit(scope: AuxiliaryScope, id: string, event: string, value: unknown): void { this.tx(scope.sessionId, () => this.event(this.get(scope,id),event,value)) }
  private event(record: AuxiliaryRecord, event: string, value: unknown): void {
    this.db.prepare('INSERT INTO runtime_auxiliary_events(id,session_id,call_id,event,state_json) VALUES(?,?,?,?,?)')
      .run(`aux-event-${randomUUID()}`,record.binding.sessionId,record.id,event,JSON.stringify({ at:new Date().toISOString(),value }))
  }
  private write(record: AuxiliaryRecord): void { this.db.prepare('UPDATE runtime_auxiliary_calls SET state_json=? WHERE id=?').run(JSON.stringify(record),record.id) }
}
