import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { capabilityHash, runtimeExecutionState } from '#core/runtime-capability-projection'
import type { RuntimeLoopState } from '#core/runtime-loop-state'
import type { JsonValue, RuntimeCapabilityBinding, RuntimeChildActionOutcome, RuntimeChildActionReceipt, RuntimeChildAssignment, RuntimeChildSession, RuntimeChildStatus, RuntimeChildTakeover, RuntimeRequestBinding, RuntimeTaskControl } from '#protocol/runtime-protocol'

export type ChildBinding = Pick<RuntimeRequestBinding, 'sessionId' | 'taskId' | 'runId'>
export interface ChildSpec {
  goal: string; prompt: string; mode: 'async' | 'sync'; timeoutMs: number
  executionMode?: 'readonly' | 'action'; attemptId?: string
  capabilityIds: string[]; maxModelRounds: number; maxToolRounds: number; maxTotalTokens: number
  parentContext: string; runner: 'local' | 'host'
  assignment?: {
    planTaskId: string
    planRevision: number
    requestId: string
    projectionId: string
    capabilities: RuntimeCapabilityBinding[]
    plan: RuntimeTaskControl
  }
}
export interface ChildRecord extends RuntimeChildSession {
  parentTaskId: string; parentRunId: string; childSessionId: string; revision: number; deadlineAt: string
  parentStepId?: string
  callId: string; spec: ChildSpec; owner?: { id: string; pid: number }; checkpoint?: never
  modelRounds: number; chargedTokens: number; output?: JsonValue; evidence?: JsonValue
  resultHash?: string; packet?: JsonValue; abortRequestedAt?: string
  readCount?: number
  actionReceipts?: RuntimeChildActionReceipt[]
  question?: string; inputRequestId?: string
  takeoverPlan?: RuntimeTaskControl
}
export interface ParentTakeoverAction {
  childId: string
  takeoverId: string
  planTaskId: string
  projectionId: string
  capabilityId: string
  sourceVersion: string
  schemaHash: string
  toolName: string
  callId: string
  stepId: string
  argumentHash: string
  resultArtifactId: string
  resultHash: string
  startedAt: string
  completedAt: string
  durationMs: number
}

type TakeoverInput = Pick<RuntimeChildTakeover, 'childId' | 'planTaskId' | 'reviewReceiptId' | 'callId' | 'requestId' | 'reason'>
export interface ChildActionRequest {
  callId: string
  toolName: string
  capabilityId: string
  argumentHash: string
}
export interface ChildActionResult extends ChildActionRequest {
  outcome: RuntimeChildActionOutcome
  resultArtifactId?: string
  resultHash?: string
}
type Row = { state_json: string }
export const terminalChild = (status: RuntimeChildStatus) => ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(status)
export function childAssignment(record: ChildRecord): RuntimeChildAssignment | undefined {
  if (!record.spec.assignment) return undefined
  if (record.takeover) return { planTaskId: record.takeover.planTaskId, childId: record.id, state: 'parent', takeoverId: record.takeover.id, status: record.status }
  const decision = record.consumption?.decision
  const state = decision === 'accept' && record.status === 'succeeded' ? 'accepted'
    : terminalChild(record.status) && (decision === 'reject' || decision === 'conflict') ? 'retryable' : 'delegated'
  return { planTaskId: record.spec.assignment.planTaskId, childId: record.id, state, status: record.status }
}
const matches = (record: ChildRecord, binding: ChildBinding) => record.parentSessionId === binding.sessionId && record.parentTaskId === binding.taskId && record.parentRunId === binding.runId
const sameOwner = (record: ChildRecord, owner: string) => record.owner?.id === owner

/** Parent-owned job journal. Model content never signs lifecycle, identities, receipts or leases. */
export class RuntimeChildStore {
  private readonly db: DatabaseSync
  private closed = false
  constructor(projectDir: string) {
    fs.mkdirSync(path.join(projectDir, '.capybara'), { recursive: true })
    this.db = new DatabaseSync(path.join(projectDir, '.capybara/sessions.sqlite'))
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS context_session_tombstones(session_id TEXT PRIMARY KEY, cleared_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_child_tasks(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,run_id TEXT NOT NULL,call_id TEXT NOT NULL,semantic_hash TEXT NOT NULL,state_json TEXT NOT NULL,checkpoint_json TEXT,UNIQUE(session_id,run_id,call_id));
      CREATE TABLE IF NOT EXISTS runtime_child_reads(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,child_id TEXT NOT NULL,state_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_child_reviews(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,child_id TEXT NOT NULL,request_id TEXT NOT NULL,state_json TEXT NOT NULL,UNIQUE(child_id,request_id));
      CREATE TABLE IF NOT EXISTS runtime_child_late_results(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,child_id TEXT NOT NULL,state_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_child_takeover_actions(session_id TEXT NOT NULL, run_id TEXT NOT NULL, child_id TEXT NOT NULL, step_id TEXT NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(session_id,child_id,step_id));
      CREATE TABLE IF NOT EXISTS runtime_child_action_leases(attempt_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,child_id TEXT NOT NULL,lease_id TEXT NOT NULL,state_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runtime_children_parent ON runtime_child_tasks(session_id,run_id);
    `)
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close() } }
  private live(sessionId: string): void {
    if (this.closed) throw new Error('CHILD_STORE_CLOSED')
    if (this.db.prepare('SELECT 1 FROM context_session_tombstones WHERE session_id=?').get(sessionId)) throw new Error('CONTEXT_SESSION_CLEARED')
  }
  private tx<T>(sessionId: string, fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { this.live(sessionId); const result = fn(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  load(binding: ChildBinding, id: string): ChildRecord {
    this.live(binding.sessionId)
    const row = this.db.prepare('SELECT state_json FROM runtime_child_tasks WHERE id=?').get(id) as Row | undefined
    if (!row) throw new Error('CHILD_NOT_FOUND')
    const record: ChildRecord = JSON.parse(row.state_json)
    if (!matches(record, binding)) throw new Error('CHILD_BINDING_MISMATCH')
    return record
  }
  list(binding: ChildBinding): ChildRecord[] {
    this.live(binding.sessionId)
    return (this.db.prepare('SELECT state_json FROM runtime_child_tasks WHERE session_id=? AND run_id=? ORDER BY rowid').all(binding.sessionId, binding.runId) as Row[]).map(row => JSON.parse(row.state_json) as ChildRecord).filter(record => matches(record, binding))
  }
  reserve(binding: ChildBinding, callId: string, spec: ChildSpec, parentStepId?: string): { record: ChildRecord; created: boolean } {
    const executionMode = spec.executionMode ?? 'readonly'
    const attemptId = spec.attemptId ?? binding.runId
    if ([binding.sessionId, binding.taskId, binding.runId, callId, attemptId].some(value => !value || value.length > 512)
      || !spec.goal.trim() || spec.goal.length > 200 || !spec.prompt.trim() || spec.prompt.length > 10000 || spec.parentContext.length > 8000
      || !['async', 'sync'].includes(spec.mode) || !['readonly', 'action'].includes(executionMode) || !['local', 'host'].includes(spec.runner)
      || spec.capabilityIds.length > 64 || new Set(spec.capabilityIds).size !== spec.capabilityIds.length || spec.capabilityIds.some(id => !id || id.length > 512)
      || [[spec.timeoutMs, 100, 300000], [spec.maxModelRounds, 1, 32], [spec.maxToolRounds, 1, 32], [spec.maxTotalTokens, 1000, 256000]].some(([value, min, max]) => !Number.isSafeInteger(value) || value! < min! || value! > max!)) throw new Error('CHILD_SPEC_INVALID')
    const assigned = spec.assignment
    if (assigned && (!assigned.planTaskId.trim() || assigned.planTaskId === binding.taskId || assigned.planTaskId.length > 512
      || !assigned.requestId.trim() || assigned.requestId.length > 512 || !/^[a-f0-9]{64}$/.test(assigned.projectionId)
      || !Number.isSafeInteger(assigned.planRevision) || assigned.planRevision < 1 || assigned.plan.taskId !== binding.taskId
      || assigned.plan.planRevision !== assigned.planRevision || !runtimeExecutionState(assigned.plan).activeTaskIds.includes(assigned.planTaskId)
      || capabilityHash(assigned.capabilities.map(item => item.capabilityId)) !== capabilityHash(spec.capabilityIds))) throw new Error('CHILD_PLAN_BINDING_INVALID')
    return this.tx(binding.sessionId, () => {
      const digest = capabilityHash({ binding, callId, spec })
      const prior = this.db.prepare('SELECT semantic_hash,state_json FROM runtime_child_tasks WHERE session_id=? AND run_id=? AND call_id=?').get(binding.sessionId, binding.runId, callId) as (Row & { semantic_hash: string }) | undefined
      if (prior) { if (prior.semantic_hash !== digest) throw new Error('CHILD_CALL_ID_CONFLICT'); return { record: JSON.parse(prior.state_json), created: false } }
      const jobs = this.list(binding)
      const previous = assigned ? jobs.filter(record => record.spec.assignment?.planTaskId === assigned.planTaskId).at(-1) : undefined
      if (previous && childAssignment(previous)?.state !== 'retryable') throw new Error('CHILD_PLAN_TASK_ALREADY_ASSIGNED')
      if (jobs.filter(record => !terminalChild(record.status)).length >= 8) throw new Error('CHILD_CONCURRENCY_LIMIT')
      const id = `child:${randomUUID()}`, timestamp = Date.now()
      const normalizedSpec = { ...spec, executionMode, attemptId }
      const record: ChildRecord = { id, parentSessionId: binding.sessionId, parentTaskId: binding.taskId, parentRunId: binding.runId,
        ...(parentStepId ? { parentStepId } : {}),
        childSessionId: `${binding.sessionId}:${id}`, waitRef: `child-signal:${randomUUID()}`, callId, sourceInstructionId: callId, goal: spec.goal, spec: structuredClone(normalizedSpec), status: 'queued',
        delegationMode: executionMode, attemptId,
        startedAt: new Date(timestamp).toISOString(), deadlineAt: new Date(timestamp + spec.timeoutMs).toISOString(), revision: 1, modelRounds: 0, chargedTokens: 0 }
      this.db.prepare('INSERT INTO runtime_child_tasks(id,session_id,run_id,call_id,semantic_hash,state_json) VALUES(?,?,?,?,?,?)').run(id, binding.sessionId, binding.runId, callId, digest, JSON.stringify(record))
      return { record, created: true }
    })
  }
  claim(binding: ChildBinding, id: string, owner: string): ChildRecord {
    return this.tx(binding.sessionId, () => {
      const record = this.load(binding, id)
      if (!['queued', 'unknown'].includes(record.status)) throw new Error('CHILD_ALREADY_OWNED_OR_SETTLED')
      if (Date.now() >= Date.parse(record.deadlineAt)) return this.finish(record, 'timed_out', undefined, 'Child deadline elapsed before resumption')
      record.owner = { id: owner, pid: process.pid }; record.status = 'running'; record.error = undefined; return this.write(record)
    })
  }
  assertOwner(binding: ChildBinding, id: string, owner: string): ChildRecord {
    const record = this.load(binding, id)
    if (!sameOwner(record, owner) || !['running', 'waiting'].includes(record.status)) throw new Error('CHILD_LEASE_REVOKED')
    if (Date.now() >= Date.parse(record.deadlineAt)) throw new Error('CHILD_DEADLINE_EXCEEDED')
    return record
  }
  progress(binding: ChildBinding, id: string, owner: string, checkpoint: RuntimeLoopState, waiting?: { question?: string; inputRequestId?: string }): ChildRecord {
    return this.tx(binding.sessionId, () => {
      const record = this.assertOwner(binding, id, owner)
      if (checkpoint.contextDocument?.sessionId !== record.childSessionId) throw new Error('CHILD_CHECKPOINT_BINDING_MISMATCH')
      if (record.childRunId && checkpoint.snapshot.run.runId && record.childRunId !== checkpoint.snapshot.run.runId) throw new Error('CHILD_RUN_ID_CHANGED')
      if (checkpoint.snapshot.run.runId) record.childRunId = checkpoint.snapshot.run.runId
      record.status = waiting ? 'waiting' : 'running'
      record.question = waiting?.question; record.inputRequestId = waiting?.inputRequestId
      this.db.prepare('UPDATE runtime_child_tasks SET checkpoint_json=? WHERE id=?').run(JSON.stringify(checkpoint), id)
      return this.write(record)
    })
  }
  checkpoint(binding: ChildBinding, id: string): RuntimeLoopState | undefined {
    this.load(binding, id)
    const row = this.db.prepare('SELECT checkpoint_json FROM runtime_child_tasks WHERE id=?').get(id) as { checkpoint_json?: string }
    return row.checkpoint_json ? JSON.parse(row.checkpoint_json) : undefined
  }
  beginInput(binding: ChildBinding, id: string, inputRequestId: string): ChildRecord {
    return this.tx(binding.sessionId, () => {
      const record = this.load(binding, id)
      if (record.status !== 'waiting' || record.inputRequestId !== inputRequestId || Date.now() >= Date.parse(record.deadlineAt)) throw new Error('CHILD_INPUT_BINDING_MISMATCH')
      record.waitRef = `child-signal:${randomUUID()}`; record.status = 'running'; record.question = undefined; record.inputRequestId = undefined
      return this.write(record)
    })
  }
  reserveModel(binding: ChildBinding, id: string, owner: string, tokens: number): void {
    if (!Number.isSafeInteger(tokens) || tokens < 1) throw new Error('CHILD_MODEL_BUDGET_INVALID')
    this.tx(binding.sessionId, () => {
      const record = this.assertOwner(binding, id, owner)
      if (record.modelRounds >= record.spec.maxModelRounds || record.chargedTokens + tokens > record.spec.maxTotalTokens) throw new Error('CHILD_MODEL_BUDGET_EXHAUSTED')
      record.modelRounds++; record.chargedTokens += tokens; this.write(record)
    })
  }
  acquireActionLease(binding: ChildBinding, id: string, owner: string, request: ChildActionRequest): RuntimeChildActionReceipt {
    return this.tx(binding.sessionId, () => {
      const record = this.assertOwner(binding, id, owner)
      if ((record.spec.executionMode ?? 'readonly') !== 'action') throw new Error('CHILD_ACTION_MODE_REQUIRED')
      if (!request.callId || !request.toolName || !request.capabilityId || !/^[a-f0-9]{64}$/.test(request.argumentHash)) throw new Error('CHILD_ACTION_LEASE_INVALID')
      const attemptId = record.spec.attemptId ?? binding.runId
      const row = this.db.prepare('SELECT state_json FROM runtime_child_action_leases WHERE attempt_id=?').get(attemptId) as Row | undefined
      if (row) {
        const prior = JSON.parse(row.state_json) as RuntimeChildActionReceipt
        if (prior.childId !== id || prior.callId !== request.callId || prior.argumentHash !== request.argumentHash || prior.toolName !== request.toolName) throw new Error('CHILD_ACTION_LEASE_CONFLICT')
        if (prior.outcome === 'unknown') throw new Error('CHILD_ACTION_RESULT_UNKNOWN')
        return prior
      }
      const lease: RuntimeChildActionReceipt = { leaseId: `action-lease-${randomUUID()}`, attemptId, childId: id, ...request, outcome: 'unknown', acquiredAt: new Date().toISOString() }
      this.db.prepare('INSERT INTO runtime_child_action_leases(attempt_id,session_id,child_id,lease_id,state_json) VALUES(?,?,?,?,?)').run(attemptId, binding.sessionId, id, lease.leaseId, JSON.stringify(lease))
      return lease
    })
  }
  recordActionResult(binding: ChildBinding, id: string, owner: string, result: ChildActionResult): RuntimeChildActionReceipt {
    return this.tx(binding.sessionId, () => {
      const record = this.assertOwner(binding, id, owner)
      const attemptId = record.spec.attemptId ?? binding.runId
      const row = this.db.prepare('SELECT state_json FROM runtime_child_action_leases WHERE attempt_id=? AND child_id=?').get(attemptId, id) as Row | undefined
      if (!row) throw new Error('CHILD_ACTION_LEASE_REQUIRED')
      const prior = JSON.parse(row.state_json) as RuntimeChildActionReceipt
      if (prior.callId !== result.callId || prior.argumentHash !== result.argumentHash || prior.toolName !== result.toolName) throw new Error('CHILD_ACTION_RESULT_CONFLICT')
      if (prior.outcome !== 'unknown' && (prior.outcome !== result.outcome || prior.resultHash !== result.resultHash)) throw new Error('CHILD_ACTION_RESULT_IMMUTABLE')
      const completed: RuntimeChildActionReceipt = { ...prior, outcome: result.outcome, ...(result.resultArtifactId ? { resultArtifactId: result.resultArtifactId } : {}), ...(result.resultHash ? { resultHash: result.resultHash } : {}), completedAt: prior.completedAt ?? new Date().toISOString() }
      this.db.prepare('UPDATE runtime_child_action_leases SET state_json=? WHERE attempt_id=?').run(JSON.stringify(completed), attemptId)
      record.actionReceipts = [...(record.actionReceipts ?? []).filter(item => item.leaseId !== completed.leaseId), completed]
      this.write(record)
      return completed
    })
  }
  settle(binding: ChildBinding, id: string, owner: string, result: { ok: boolean; output?: JsonValue; evidence?: JsonValue; error?: string }): { record: ChildRecord; late: boolean } {
    return this.tx(binding.sessionId, () => {
      const record = this.load(binding, id)
      if (!sameOwner(record, owner) || terminalChild(record.status) || record.status === 'unknown') {
        this.db.prepare('INSERT INTO runtime_child_late_results(id,session_id,child_id,state_json) VALUES(?,?,?,?)').run(randomUUID(), binding.sessionId, id,
          JSON.stringify({ owner, result, receivedAt: new Date().toISOString(), retainedPrimaryStatus: record.status }))
        return { record, late: true }
      }
      if (Date.now() >= Date.parse(record.deadlineAt)) {
        this.db.prepare('INSERT INTO runtime_child_late_results(id,session_id,child_id,state_json) VALUES(?,?,?,?)').run(randomUUID(), binding.sessionId, id,
          JSON.stringify({ owner, result, receivedAt: new Date().toISOString(), retainedPrimaryStatus: 'timed_out' }))
        return { record: this.finish(record, 'timed_out', undefined, 'Child completed after its deadline; result retained as late'), late: true }
      }
      return { record: this.finish(record, result.ok ? 'succeeded' : 'failed', result, result.error), late: false }
    })
  }
  suspend(binding: ChildBinding, id: string, owner: string): ChildRecord {
    return this.tx(binding.sessionId, () => {
      const record = this.load(binding, id)
      if (sameOwner(record, owner) && !terminalChild(record.status)) { record.status = 'unknown'; record.error = { code: 'CHILD_WORKER_SUSPENDED', message: 'Worker dispatch stopped; result remains unconfirmed' }; return this.write(record) }
      return record
    })
  }
  cancel(binding: ChildBinding, id: string, reason: string): ChildRecord {
    return this.tx(binding.sessionId, () => {
      const record = this.load(binding, id)
      if (terminalChild(record.status)) return record
      record.abortRequestedAt = new Date().toISOString()
      return this.finish(record, Date.now() >= Date.parse(record.deadlineAt) ? 'timed_out' : 'cancelled', undefined, reason)
    })
  }
  expire(binding: ChildBinding, id: string): ChildRecord {
    return this.tx(binding.sessionId, () => {
      const record = this.load(binding, id)
      return !terminalChild(record.status) && Date.now() >= Date.parse(record.deadlineAt) ? this.finish(record, 'timed_out', undefined, 'Child deadline elapsed') : record
    })
  }
  issueRead(binding: ChildBinding, id: string, requestId: string, viewHash: string): string {
    return this.tx(binding.sessionId, () => {
      const record = this.load(binding, id)
      if (!terminalChild(record.status) || !record.resultHash) throw new Error('CHILD_RESULT_PENDING')
      const receiptId = `child-read-${randomUUID()}`
      this.db.prepare('INSERT INTO runtime_child_reads(id,session_id,child_id,state_json) VALUES(?,?,?,?)').run(receiptId, binding.sessionId, id,
        JSON.stringify({ binding, childId: id, requestId, resultHash: record.resultHash, viewHash, issuedAt: new Date().toISOString() }))
      record.readCount = (record.readCount ?? 0) + 1; this.write(record)
      return receiptId
    })
  }
  linkArtifact(binding: ChildBinding, id: string, resultHash: string, artifactId: string): ChildRecord {
    return this.tx(binding.sessionId, () => {
      const record = this.load(binding, id)
      if (record.resultHash !== resultHash || !terminalChild(record.status)) throw new Error('CHILD_RESULT_STALE_OR_PENDING')
      if (record.resultArtifactId && record.resultArtifactId !== artifactId) throw new Error('CHILD_RESULT_ARTIFACT_IMMUTABLE')
      if (!record.resultArtifactId) { record.resultArtifactId = artifactId; return this.write(record) }
      return record
    })
  }
  consume(binding: ChildBinding, input: { childId: string; resultHash: string; readReceiptId: string; requestId: string; decision: 'accept' | 'reject' | 'conflict' | 'needs_more_evidence'; reason: string }): ChildRecord {
    return this.tx(binding.sessionId, () => {
      const record = this.load(binding, input.childId)
      if (!terminalChild(record.status) || !record.resultHash || record.resultHash !== input.resultHash) throw new Error('CHILD_RESULT_STALE_OR_PENDING')
      const row = this.db.prepare('SELECT state_json FROM runtime_child_reads WHERE id=? AND child_id=? AND session_id=?').get(input.readReceiptId, input.childId, binding.sessionId) as Row | undefined
      const read = row ? JSON.parse(row.state_json) : undefined
      if (!read || read.resultHash !== input.resultHash || read.requestId === input.requestId
        || read.binding.sessionId !== binding.sessionId || read.binding.taskId !== binding.taskId || read.binding.runId !== binding.runId) throw new Error('CHILD_READ_RECEIPT_REQUIRED')
      if (input.decision === 'accept' && record.status !== 'succeeded') throw new Error('CHILD_FAILED_RESULT_CANNOT_BE_ACCEPTED')
      if (!input.reason.trim() || input.reason.length > 1000) throw new Error('CHILD_REVIEW_REASON_INVALID')
      const prior = this.db.prepare('SELECT state_json FROM runtime_child_reviews WHERE child_id=? AND request_id=?').get(input.childId, input.requestId) as Row | undefined
      if (prior) { if (capabilityHash(JSON.parse(prior.state_json).input) !== capabilityHash(input)) throw new Error('CHILD_REVIEW_ID_CONFLICT'); return record }
      if (record.consumption && record.consumption.decision !== 'needs_more_evidence') throw new Error('CHILD_RESULT_ALREADY_CONSUMED')
      const receiptId = `child-review-${randomUUID()}`
      record.consumption = { decision: input.decision, reason: input.reason, consumedAt: new Date().toISOString(), receiptId }
      this.db.prepare('INSERT INTO runtime_child_reviews(id,session_id,child_id,request_id,state_json) VALUES(?,?,?,?,?)').run(receiptId, binding.sessionId, input.childId, input.requestId, JSON.stringify({ binding, input, consumption: record.consumption }))
      return this.write(record)
    })
  }
  takeover(binding: ChildBinding, input: TakeoverInput, plan: RuntimeTaskControl): ChildRecord {
    return this.tx(binding.sessionId, () => {
      const record = this.load(binding, input.childId)
      if (record.takeover) {
        const { id: _id, createdAt: _time, planRevision, ...original } = record.takeover
        if (plan.planRevision === planRevision && capabilityHash(original) === capabilityHash(input)) return record
        throw new Error('CHILD_TAKEOVER_ALREADY_REGISTERED')
      }
      const assignment = record.spec.assignment
      const latest = this.list(binding).filter(job => job.spec.assignment?.planTaskId === input.planTaskId).at(-1)
      if (!assignment || assignment.planTaskId !== input.planTaskId || latest?.id !== record.id
        || childAssignment(record)?.state !== 'retryable' || !record.consumption?.receiptId
        || input.reviewReceiptId !== record.consumption.receiptId) throw new Error('CHILD_TAKEOVER_REVIEW_REQUIRED')
      if (!input.callId.trim() || !input.requestId.trim() || !input.reason.trim() || input.reason.length > 1000
        || plan.taskId !== binding.taskId || !runtimeExecutionState(plan).activeTaskIds.includes(input.planTaskId)) throw new Error('CHILD_TAKEOVER_NODE_NOT_ACTIVE')
      record.takeover = { ...input, id: `parent-takeover-${randomUUID()}`, createdAt: new Date().toISOString(), planRevision: plan.planRevision }
      record.takeoverPlan = structuredClone(plan)
      return this.write(record)
    })
  }
  recordTakeoverAction(binding: ChildBinding, action: ParentTakeoverAction): void {
    this.tx(binding.sessionId, () => {
      const record = this.load(binding, action.childId)
      const node = record.takeoverPlan?.tasks.find(task => task.id === action.planTaskId)
      if (record.takeover?.id !== action.takeoverId || record.takeover.planTaskId !== action.planTaskId
        || !node?.capabilityIds.some(id => id === action.capabilityId || id === action.toolName)) throw new Error('CHILD_TAKEOVER_ACTION_UNBOUND')
      const prior = this.db.prepare("SELECT state_json FROM runtime_child_takeover_actions WHERE session_id=? AND child_id=? AND (step_id=? OR json_extract(state_json,'$.callId')=?)")
        .get(binding.sessionId, action.childId, action.stepId, action.callId) as Row | undefined
      if (prior) {
        if (capabilityHash(JSON.parse(prior.state_json)) !== capabilityHash(action)) throw new Error('CHILD_TAKEOVER_ACTION_CONFLICT')
        return
      }
      this.db.prepare('INSERT INTO runtime_child_takeover_actions VALUES(?,?,?,?,?)')
        .run(binding.sessionId, binding.runId, action.childId, action.stepId, JSON.stringify(action))
    })
  }
  takeoverActions(binding: ChildBinding, childId: string): ParentTakeoverAction[] {
    this.load(binding, childId)
    const rows = this.db.prepare('SELECT state_json FROM runtime_child_takeover_actions WHERE session_id=? AND run_id=? AND child_id=? ORDER BY rowid')
      .all(binding.sessionId, binding.runId, childId) as Row[]
    return rows.map(row => JSON.parse(row.state_json) as ParentTakeoverAction)
  }
  private finish(record: ChildRecord, status: RuntimeChildStatus, result?: { output?: JsonValue; evidence?: JsonValue }, reason?: string): ChildRecord {
    record.status = status; record.completedAt = new Date().toISOString()
    record.question = undefined; record.inputRequestId = undefined
    record.output = result?.output; record.evidence = result?.evidence
    if (reason) record.error = { code: status === 'timed_out' ? 'CHILD_TIMEOUT' : status === 'cancelled' ? 'CHILD_CANCELLED' : 'CHILD_FAILED', message: reason }
    const packet = { version: 1, childId: record.id, parent: { sessionId: record.parentSessionId, taskId: record.parentTaskId, runId: record.parentRunId, callId: record.callId,
      ...(record.spec.assignment ? { planTaskId: record.spec.assignment.planTaskId, dispatchRequestId: record.spec.assignment.requestId,
        projectionId: record.spec.assignment.projectionId, planRevision: record.spec.assignment.planRevision } : {}) },
      childSessionId: record.childSessionId, ...(record.childRunId ? { childRunId: record.childRunId } : {}), status, startedAt: record.startedAt!, completedAt: record.completedAt,
      ...(record.actionReceipts?.length ? { actionReceipts: record.actionReceipts } : {}),
      output: result?.output ?? null, evidence: result?.evidence ?? null, error: record.error ?? null }
    if (Buffer.byteLength(JSON.stringify(packet)) > 5 * 1024 * 1024) {
      record.status = 'failed'; record.output = undefined; record.evidence = undefined
      record.error = { code: 'CHILD_RESULT_LIMIT', message: 'Child result exceeded 5 MiB' }
      record.packet = { ...packet, status: 'failed', output: null, evidence: null, error: record.error } as unknown as JsonValue
    } else record.packet = packet as unknown as JsonValue
    record.resultHash = capabilityHash(record.packet)
    return this.write(record)
  }
  private write(record: ChildRecord): ChildRecord {
    record.revision++
    this.db.prepare('UPDATE runtime_child_tasks SET state_json=? WHERE id=?').run(JSON.stringify(record), record.id)
    return structuredClone(record)
  }
}
