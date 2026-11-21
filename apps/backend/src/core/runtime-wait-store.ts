import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { JsonObject, RuntimeEvidenceRequest, RuntimeRequestBinding, RuntimeWaitDeadline, RuntimeWaitSignal, RuntimeWaitSpec, RuntimeWaitSubscription, RuntimeWaitsState } from '#protocol/runtime-protocol'
import type { RuntimeLoopState } from '#core/runtime-loop-state'
import type { McpVerificationReceipt } from '#core/mcp/operations'
import { MCP_INPUT_RESPONDED } from '#core/mcp/input'

type Binding = Pick<RuntimeRequestBinding, 'sessionId' | 'taskId' | 'runId'>
type Row = { state_json: string }
type SignalInput = Omit<RuntimeWaitSignal, 'receivedAt'>
const key = (value: unknown): unknown => Array.isArray(value) ? value.map(key) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, key(v)])) : value
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(key(value))).digest('hex')
const same = (a: Binding, b: Binding) => a.sessionId === b.sessionId && a.taskId === b.taskId && a.runId === b.runId
export const BRANCH_HUMAN_REPLY = 'capybara.human.reply'
export const BRANCH_EVIDENCE = 'capybara.evidence.observed'
export const MCP_OPERATION_SETTLED = 'mcp.operation.settled'
export interface PreparedWait { id: string; binding: RuntimeRequestBinding; spec: RuntimeWaitSpec }
export interface BranchHumanReplyReceipt {
  requestId: string
  taskIds: string[]
  replyMessageId: string
  receivedAt: string
  completionActionRef: string
}

/** Durable control records. Signals and deadlines do not grant permissions or confirm business facts. */
export class RuntimeWaitStore {
  private readonly db: DatabaseSync
  private closed = false
  constructor(projectDir: string) {
    const directory = path.join(projectDir, '.capybara')
    fs.mkdirSync(directory, { recursive: true })
    this.db = new DatabaseSync(path.join(directory, 'sessions.sqlite'))
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS context_session_tombstones(session_id TEXT PRIMARY KEY, cleared_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_wait_deadlines(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL, operation_id TEXT NOT NULL, state_json TEXT NOT NULL, UNIQUE(session_id,run_id,operation_id));
      CREATE TABLE IF NOT EXISTS runtime_waits(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL, request_id TEXT NOT NULL, state_json TEXT NOT NULL, checkpoint_json TEXT NOT NULL, UNIQUE(session_id,run_id,request_id));
      CREATE TABLE IF NOT EXISTS runtime_wait_signals(session_id TEXT NOT NULL, id TEXT NOT NULL, semantic_hash TEXT NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(session_id,id));
      CREATE INDEX IF NOT EXISTS runtime_waits_session ON runtime_waits(session_id,run_id);
      CREATE INDEX IF NOT EXISTS runtime_wait_signals_binding ON runtime_wait_signals(session_id,json_extract(state_json,'$.runId'));
    `)
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close() } }
  private live(sessionId: string): void {
    if (this.closed) throw new Error('WAIT_STORE_CLOSED')
    if (this.db.prepare('SELECT 1 FROM context_session_tombstones WHERE session_id=?').get(sessionId)) throw new Error('CONTEXT_SESSION_CLEARED')
  }
  private transaction<T>(sessionId: string, operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { this.live(sessionId); const result = operation(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  createDeadline(binding: Binding, operationId: string, timeoutMs: number): RuntimeWaitDeadline {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30 * 86400000 || !operationId || operationId.length > 512) throw new Error('WAIT_DEADLINE_INVALID')
    return this.transaction(binding.sessionId, () => {
      const prior = this.db.prepare('SELECT state_json FROM runtime_wait_deadlines WHERE session_id=? AND run_id=? AND operation_id=?').get(binding.sessionId, binding.runId, operationId) as Row | undefined
      if (prior) {
        const deadline: RuntimeWaitDeadline = JSON.parse(prior.state_json)
        if (!same(deadline, binding) || deadline.timeoutMs !== timeoutMs) throw new Error('WAIT_DEADLINE_ID_CONFLICT')
        return deadline
      }
      const timestamp = Date.now()
      const deadline: RuntimeWaitDeadline = { ...binding, id: `deadline-${randomUUID()}`, operationId, timeoutMs, createdAt: new Date(timestamp).toISOString(), expiresAt: new Date(timestamp + timeoutMs).toISOString() }
      this.db.prepare('INSERT INTO runtime_wait_deadlines(id,session_id,run_id,operation_id,state_json) VALUES(?,?,?,?,?)').run(deadline.id, binding.sessionId, binding.runId, operationId, JSON.stringify(deadline))
      return deadline
    })
  }
  validateSpec(binding: Binding, spec: RuntimeWaitSpec): asserts spec is RuntimeWaitSubscription['spec'] {
    if (spec.timeoutMs !== undefined || !spec.reason?.trim() || spec.reason.length > 1000 || !['runtime', 'tool', 'external', 'user'].includes(spec.signalType)
      || !spec.correlationIds?.length || spec.correlationIds.length > 32 || new Set(spec.correlationIds).size !== spec.correlationIds.length
      || spec.correlationIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 512)
      || (spec.blockingTaskIds !== undefined && (!spec.blockingTaskIds.length || spec.blockingTaskIds.length > 32
        || new Set(spec.blockingTaskIds).size !== spec.blockingTaskIds.length
        || spec.blockingTaskIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 512)))
      || !spec.condition?.eventType?.trim() || spec.condition.eventType.length > 512
      || (spec.condition.status !== undefined && (!spec.condition.status.trim() || spec.condition.status.length > 128))) throw new Error('WAIT_SPEC_UNBOUND')
    if (spec.deadlineRef) {
      const row = this.db.prepare('SELECT state_json FROM runtime_wait_deadlines WHERE id=?').get(spec.deadlineRef) as Row | undefined
      if (!row || !same(JSON.parse(row.state_json), binding)) throw new Error('WAIT_DEADLINE_BINDING_MISMATCH')
    }
    if (spec.signalType === 'runtime' && spec.condition.eventType === 'deadline' && (!spec.deadlineRef || spec.correlationIds.some(id => id !== spec.deadlineRef))) throw new Error('WAIT_DEADLINE_BINDING_MISMATCH')
    if (spec.condition.eventType === MCP_OPERATION_SETTLED && (spec.signalType !== 'runtime' || !spec.deadlineRef
      || spec.correlationIds.length !== 1 || spec.condition.status !== undefined
      || spec.blockingTaskIds?.some(id => id !== binding.taskId))) throw new Error('MCP_WAIT_SPEC_INVALID')
    if (spec.condition.eventType === MCP_INPUT_RESPONDED && (spec.signalType !== 'runtime' || spec.correlationIds.length !== 1
      || spec.condition.status !== undefined)) throw new Error('MCP_INPUT_WAIT_SPEC_INVALID')
  }
  register(id: string, binding: RuntimeRequestBinding, spec: RuntimeWaitSpec, checkpoint: RuntimeLoopState): RuntimeWaitSubscription {
    return this.registerBatch([{ id, binding, spec }], checkpoint)[0]!
  }
  registerBatch(batch: PreparedWait[], checkpoint: RuntimeLoopState): RuntimeWaitSubscription[] {
    const first = batch[0]?.binding
    if (!first || batch.some(wait => !same(first, wait.binding) || first.requestId !== wait.binding.requestId)) throw new Error('WAIT_BATCH_BINDING_MISMATCH')
    return this.transaction(first.sessionId, () => batch.map((wait, index) => this.registerWait(wait, checkpoint, index === 0)))
  }
  private registerWait({ id, binding, spec }: PreparedWait, checkpoint: RuntimeLoopState, saveCursor: boolean): RuntimeWaitSubscription {
    this.validateSpec(binding, spec)
    const block = checkpoint.taskControl?.branchBlocks?.find(item => item.id === id)
    const local = spec.blockingTaskIds !== undefined
    const human = spec.condition.eventType === BRANCH_HUMAN_REPLY
    const evidence = spec.condition.eventType === BRANCH_EVIDENCE
    const validCursor = local
      ? block && hash(block.taskIds) === hash(spec.blockingTaskIds) && block.kind === (human ? 'human' : evidence ? 'evidence' : 'wait')
        && ['running', 'paused'].includes(checkpoint.snapshot.run.status)
      : checkpoint.contextControl?.waitId === id && checkpoint.snapshot.run.status === 'paused' && !human && !evidence
    if (checkpoint.snapshot.run.runId !== binding.runId || checkpoint.taskControl?.taskId !== binding.taskId
      || !validCursor || checkpoint.pendingToolCalls.length) throw new Error('WAIT_CHECKPOINT_INVALID')
    if (human && (spec.signalType !== 'user' || spec.correlationIds.length !== 1 || spec.correlationIds[0] !== id || spec.deadlineRef || spec.condition.status)) throw new Error('HUMAN_REQUEST_MISMATCH')
    if (evidence && (!block?.evidenceRequest || spec.signalType !== 'runtime' || spec.correlationIds.length !== 1 || spec.correlationIds[0] !== id || spec.deadlineRef || spec.condition.status)) throw new Error('BRANCH_EVIDENCE_BINDING_MISMATCH')
    const key = evidence ? `${binding.requestId}:evidence:${block!.evidenceRequest!.id}` : binding.requestId
    const previous = this.db.prepare('SELECT state_json FROM runtime_waits WHERE session_id=? AND run_id=? AND request_id=?').get(binding.sessionId, binding.runId, key) as Row | undefined
    if (previous) {
      const result: RuntimeWaitSubscription = JSON.parse(previous.state_json)
      if (result.id !== id || hash(result.spec) !== hash(spec) || !same(result.binding, binding)
        || (evidence && hash(result.evidenceRequest) !== hash(block!.evidenceRequest))) throw new Error('WAIT_REQUEST_ID_CONFLICT')
      return result
    }
    if (this.read(binding).subscriptions.some(wait => wait.status === 'pending'
      && !(evidence && wait.spec.condition.eventType === BRANCH_EVIDENCE && wait.binding.requestId === binding.requestId)
      && (local ? wait.spec.blockingTaskIds?.some(task => spec.blockingTaskIds!.includes(task)) : !wait.spec.blockingTaskIds))) throw new Error('WAIT_ALREADY_PENDING')
    const deadline = spec.deadlineRef ? this.db.prepare('SELECT state_json FROM runtime_wait_deadlines WHERE id=?').get(spec.deadlineRef) as Row : undefined
    const wait: RuntimeWaitSubscription = { id, binding, spec: structuredClone(spec), createdAt: new Date().toISOString(), status: 'pending', matchedSignalIds: [],
      ...(evidence ? { evidenceRequest: structuredClone(block!.evidenceRequest!) } : {}),
      ...(deadline ? { deadlineAt: (JSON.parse(deadline.state_json) as RuntimeWaitDeadline).expiresAt } : {}) }
    this.db.prepare('INSERT INTO runtime_waits(id,session_id,run_id,request_id,state_json,checkpoint_json) VALUES(?,?,?,?,?,?)').run(id, binding.sessionId, binding.runId, key, JSON.stringify(wait), saveCursor ? JSON.stringify(checkpoint) : '')
    return this.evaluate(wait, Date.now())
  }
  read(binding: Binding): RuntimeWaitsState {
    this.live(binding.sessionId)
    const deadlines = (this.db.prepare('SELECT state_json FROM runtime_wait_deadlines WHERE session_id=? AND run_id=? ORDER BY rowid DESC LIMIT 32').all(binding.sessionId, binding.runId) as Row[]).map(row => JSON.parse(row.state_json) as RuntimeWaitDeadline).filter(item => same(item, binding))
    const subscriptions = (this.db.prepare('SELECT state_json FROM runtime_waits WHERE session_id=? AND run_id=? ORDER BY rowid DESC').all(binding.sessionId, binding.runId) as Row[]).map(row => JSON.parse(row.state_json) as RuntimeWaitSubscription).filter(item => same(item.binding, binding))
    return { deadlines, subscriptions: [...subscriptions.filter(item => item.status === 'pending'), ...subscriptions.filter(item => item.status !== 'pending').slice(0, 8)] }
  }

  readBranchHumanReplies(binding: Binding): BranchHumanReplyReceipt[] {
    this.live(binding.sessionId)
    const rows = this.db.prepare(`SELECT w.state_json AS wait_json, s.state_json AS signal_json
      FROM runtime_waits w JOIN runtime_wait_signals s ON s.session_id=w.session_id AND s.id='human:' || w.id
      WHERE w.session_id=? AND w.run_id=? AND json_extract(w.state_json,'$.status')='satisfied'
      AND json_extract(w.state_json,'$.spec.condition.eventType')=? ORDER BY w.rowid`).all(binding.sessionId, binding.runId, BRANCH_HUMAN_REPLY) as
      Array<{ wait_json: string; signal_json: string }>
    return rows.flatMap(row => {
      const wait: RuntimeWaitSubscription = JSON.parse(row.wait_json)
      const signal: RuntimeWaitSignal = JSON.parse(row.signal_json)
      const taskIds = wait.spec.blockingTaskIds
      const reply = signal.data
      if (!same(wait.binding, binding) || !same(signal, binding) || !taskIds?.length || !wait.matchedSignalIds.includes(signal.id)
        || signal.eventType !== BRANCH_HUMAN_REPLY || signal.signalType !== 'user' || signal.correlationId !== wait.id
        || !reply || typeof reply !== 'object' || Array.isArray(reply) || typeof reply.messageId !== 'string' || typeof reply.text !== 'string') return []
      return [{ requestId: wait.id, taskIds, replyMessageId: reply.messageId, receivedAt: signal.receivedAt, completionActionRef: signal.id }]
    })
  }
  load(binding: Binding, id: string): RuntimeWaitSubscription {
    this.live(binding.sessionId)
    const row = this.db.prepare('SELECT state_json FROM runtime_waits WHERE id=?').get(id) as Row | undefined
    if (!row) throw new Error('WAIT_NOT_FOUND')
    const wait: RuntimeWaitSubscription = JSON.parse(row.state_json)
    if (!same(wait.binding, binding)) throw new Error('WAIT_BINDING_MISMATCH')
    return wait
  }
  recoverCheckpoint(sessionId: string, runId?: string): RuntimeLoopState | undefined {
    this.live(sessionId)
    const row = (runId
      ? this.db.prepare("SELECT state_json,checkpoint_json FROM runtime_waits WHERE session_id=? AND run_id=? AND checkpoint_json<>'' ORDER BY rowid DESC LIMIT 1").get(sessionId, runId)
      : this.db.prepare("SELECT state_json,checkpoint_json FROM runtime_waits WHERE session_id=? AND checkpoint_json<>'' ORDER BY rowid DESC LIMIT 1").get(sessionId)) as (Row & { checkpoint_json: string }) | undefined
    if (!row) return
    const wait: RuntimeWaitSubscription = JSON.parse(row.state_json)
    if (!runId && !this.read(wait.binding).subscriptions.some(item => item.status === 'pending')) return
    return JSON.parse(row.checkpoint_json)
  }
  recordSignal(input: SignalInput): { signal: RuntimeWaitSignal; duplicate: boolean } {
    if ([BRANCH_HUMAN_REPLY, BRANCH_EVIDENCE, MCP_OPERATION_SETTLED, MCP_INPUT_RESPONDED].includes(input.eventType)) throw new Error('WAIT_SIGNAL_RESERVED_EVENT')
    if (input.id?.startsWith('human:') || input.id?.startsWith('evidence:')) throw new Error('WAIT_SIGNAL_RESERVED_ID')
    if ((input.id?.startsWith('tool:') && input.signalType !== 'tool') || (input.id?.startsWith('runtime:') && input.signalType !== 'runtime')) throw new Error('WAIT_SIGNAL_RESERVED_ID')
    if ([input.id, input.sessionId, input.taskId, input.runId, input.eventType, input.correlationId].some(value => typeof value !== 'string' || !value.trim() || value.length > 512)
      || (input.status !== undefined && (typeof input.status !== 'string' || !input.status.trim() || input.status.length > 128))
      || !['runtime', 'tool', 'external', 'user'].includes(input.signalType) || JSON.stringify(input).length > 16384) throw new Error('WAIT_SIGNAL_INVALID')
    return this.transaction(input.sessionId, () => this.recordSignalInTransaction(input))
  }

  replyToBranchHuman(binding: Binding, id: string, reply: { messageId: string; text: string; replan?: boolean }): void {
    this.transaction(binding.sessionId, () => {
      const wait = this.load(binding, id)
      if (wait.status !== 'pending' || wait.spec.condition.eventType !== BRANCH_HUMAN_REPLY) throw new Error('HUMAN_REQUEST_MISMATCH')
      if (this.db.prepare("SELECT 1 FROM runtime_wait_signals WHERE session_id=? AND json_extract(state_json,'$.data.messageId')=? AND json_extract(state_json,'$.eventType') IN (?,?)")
        .get(binding.sessionId, reply.messageId, BRANCH_HUMAN_REPLY, BRANCH_EVIDENCE)) throw new Error('HUMAN_REPLY_ALREADY_CONSUMED')
      this.recordSignalInTransaction({ sessionId: binding.sessionId, taskId: binding.taskId, runId: binding.runId,
        id: `human:${id}`, signalType: 'user', eventType: BRANCH_HUMAN_REPLY,
        correlationId: id, data: { messageId: reply.messageId, text: reply.text, ...(reply.replan ? { replan: true } : {}) } })
    })
  }

  supplyEvidence(binding: Binding, id: string, sourceKind: RuntimeEvidenceRequest['sourceKinds'][number], data: JsonObject) {
    return this.transaction(binding.sessionId, () => {
      const wait = this.load(binding, id)
      if (wait.spec.condition.eventType !== BRANCH_EVIDENCE || !wait.evidenceRequest?.sourceKinds.includes(sourceKind)) throw new Error('BRANCH_EVIDENCE_SOURCE_MISMATCH')
      const signal: SignalInput = { sessionId: binding.sessionId, runId: binding.runId, taskId: binding.taskId,
        id: `evidence:${id}`, signalType: 'runtime', eventType: BRANCH_EVIDENCE, correlationId: id, data: { ...data, sourceKind } }
      if (wait.status !== 'pending') {
        if (wait.status === 'satisfied' && wait.matchedSignalIds.includes(signal.id)) {
          const previous = this.readSignal(binding, signal.id)
          if (hash(previous.data) === hash(signal.data)) return { signal: previous, duplicate: true }
        }
        throw new Error('BRANCH_EVIDENCE_NOT_PENDING')
      }
      if (JSON.stringify(signal.data).length > 16384) throw new Error('BRANCH_EVIDENCE_TOO_LARGE')
      if (sourceKind === 'user' && this.db.prepare("SELECT 1 FROM runtime_wait_signals WHERE session_id=? AND json_extract(state_json,'$.data.messageId')=? AND json_extract(state_json,'$.eventType') IN (?,?)")
        .get(binding.sessionId, data.messageId as string, BRANCH_EVIDENCE, BRANCH_HUMAN_REPLY)) throw new Error('HUMAN_REPLY_ALREADY_CONSUMED')
      if (sourceKind === 'external' && this.db.prepare("SELECT 1 FROM runtime_wait_signals WHERE session_id=? AND json_extract(state_json,'$.data.externalSignalId')=? AND json_extract(state_json,'$.eventType')=?")
        .get(binding.sessionId, data.externalSignalId as string, BRANCH_EVIDENCE)) throw new Error('BRANCH_EXTERNAL_SIGNAL_ALREADY_CONSUMED')
      return this.recordSignalInTransaction(signal)
    })
  }

  private recordSignalInTransaction(input: SignalInput): { signal: RuntimeWaitSignal; duplicate: boolean } {
    const semanticHash = hash(input)
    const prior = this.db.prepare('SELECT semantic_hash,state_json FROM runtime_wait_signals WHERE session_id=? AND id=?').get(input.sessionId, input.id) as (Row & { semantic_hash: string }) | undefined
    if (prior) {
      if (prior.semantic_hash !== semanticHash) throw new Error('WAIT_SIGNAL_ID_CONFLICT')
      return { signal: JSON.parse(prior.state_json), duplicate: true }
    }
    const signal: RuntimeWaitSignal = { ...structuredClone(input), receivedAt: new Date().toISOString() }
    // Expiry wins over a signal first observed after the host deadline.
    this.expireInTransaction(input, Date.now())
    this.insertSignal(signal, semanticHash)
    for (const wait of this.read(input).subscriptions.filter(item => item.status === 'pending')) this.evaluate(wait, Date.now())
    return { signal, duplicate: false }
  }
  private insertSignal(signal: RuntimeWaitSignal, semanticHash: string): void {
    this.db.prepare('INSERT INTO runtime_wait_signals(session_id,id,semantic_hash,state_json) VALUES(?,?,?,?)')
      .run(signal.sessionId, signal.id, semanticHash, JSON.stringify(signal))
  }
  readSignal(binding: Binding, id: string): RuntimeWaitSignal {
    this.live(binding.sessionId)
    const row = this.db.prepare('SELECT state_json FROM runtime_wait_signals WHERE session_id=? AND id=?').get(binding.sessionId, id) as Row | undefined
    if (!row) throw new Error('WAIT_SIGNAL_NOT_FOUND')
    const signal: RuntimeWaitSignal = JSON.parse(row.state_json)
    if (!same(signal, binding)) throw new Error('WAIT_SIGNAL_BINDING_MISMATCH')
    return signal
  }
  expire(binding: Binding): RuntimeWaitsState { return this.transaction(binding.sessionId, () => { this.expireInTransaction(binding, Date.now()); return this.read(binding) }) }
  private expireInTransaction(binding: Binding, timestamp: number): void {
    for (const wait of this.read(binding).subscriptions.filter(item => item.status === 'pending')) this.evaluate(wait, timestamp)
  }
  cancel(binding: Binding, id: string, reason: string, cancelledBy: 'run' | 'subscription' = 'subscription'): RuntimeWaitSubscription {
    return this.transaction(binding.sessionId, () => {
      const wait = this.evaluate(this.load(binding, id), Date.now())
      if (wait.status === 'pending') { wait.status = 'cancelled'; wait.reason = reason; wait.cancelledBy = cancelledBy; wait.settledAt = new Date().toISOString(); this.write(wait) }
      if (cancelledBy === 'run') { wait.runCancelledAt ??= new Date().toISOString(); this.write(wait) }
      return wait
    })
  }
  private evaluate(wait: RuntimeWaitSubscription, timestamp: number): RuntimeWaitSubscription {
    if (wait.status !== 'pending') return wait
    if (wait.spec.condition.eventType === MCP_INPUT_RESPONDED) {
      const requestId = wait.spec.correlationIds[0]!
      const row = this.db.prepare('SELECT answered_at, status, operation_id FROM runtime_mcp_inputs WHERE id=? AND session_id=? AND task_id=? AND run_id=?')
        .get(requestId, wait.binding.sessionId, wait.binding.taskId, wait.binding.runId) as { answered_at: string | null; status: string; operation_id: string | null } | undefined
      if (row?.answered_at) {
        const input: SignalInput = { sessionId: wait.binding.sessionId, runId: wait.binding.runId, taskId: wait.binding.taskId,
          id: `runtime:${wait.binding.runId}:mcp-input:${requestId}`, eventType: MCP_INPUT_RESPONDED, signalType: 'runtime',
          correlationId: requestId, status: ['declined', 'cancelled'].includes(row.status) ? row.status : 'answered',
          data: { requestId, ...(row.operation_id ? { operationId: row.operation_id } : {}) } }
        this.ensureObservedSignal(input, row.answered_at)
      }
    } else if (wait.spec.condition.eventType === MCP_OPERATION_SETTLED) {
      const operationId = wait.spec.correlationIds[0]!
      // Read the original run's durable proof even if the host closed between settlement and wakeup.
      const row = this.db.prepare(`SELECT op.verification_json FROM runtime_mcp_operations op JOIN context_artifact_sources artifact
        ON artifact.session_id=op.session_id AND artifact.artifact_id=json_extract(op.verification_json,'$.artifactId')
        AND json_extract(artifact.meta_json,'$.hash')=json_extract(op.verification_json,'$.artifactHash')
        WHERE op.id=? AND op.session_id=? AND json_extract(op.binding_json,'$.taskId')=? AND json_extract(op.binding_json,'$.runId')=?
        AND op.outcome IN ('verified_applied','verified_not_applied')`).get(operationId, wait.binding.sessionId, wait.binding.taskId, wait.binding.runId) as { verification_json: string } | undefined
      const receipt: McpVerificationReceipt | undefined = row && JSON.parse(row.verification_json)
      if (receipt && Date.parse(receipt.verifiedAt) < Date.parse(wait.deadlineAt!)) {
        const input: SignalInput = { sessionId: wait.binding.sessionId, taskId: wait.binding.taskId, runId: wait.binding.runId,
          id: `runtime:${wait.binding.runId}:mcp:${operationId}`, signalType: 'runtime', eventType: MCP_OPERATION_SETTLED,
          correlationId: operationId, status: receipt.outcome, data: { receiptId: receipt.id, artifactId: receipt.artifactId, artifactHash: receipt.artifactHash } }
        this.ensureObservedSignal(input, receipt.verifiedAt)
      }
    }
    const signals = (this.db.prepare('SELECT state_json FROM runtime_wait_signals WHERE session_id=? AND json_extract(state_json,\'$.runId\')=? ORDER BY rowid').all(wait.binding.sessionId, wait.binding.runId) as Row[])
      .map(row => JSON.parse(row.state_json) as RuntimeWaitSignal).filter(signal => same(signal, wait.binding) && signal.signalType === wait.spec.signalType
        && signal.eventType === wait.spec.condition.eventType && (wait.spec.condition.status === undefined || signal.status === wait.spec.condition.status)
        && wait.spec.correlationIds.includes(signal.correlationId) && (!wait.deadlineAt || Date.parse(signal.receivedAt) < Date.parse(wait.deadlineAt)))
    wait.matchedSignalIds = [...new Set(signals.map(signal => signal.id))]
    const matched = new Set(signals.map(signal => signal.correlationId))
    if (wait.spec.correlationIds.every(id => matched.has(id))) wait.status = 'satisfied'
    else if (wait.deadlineAt && timestamp >= Date.parse(wait.deadlineAt)) wait.status = 'timed_out'
    if (wait.status !== 'pending') wait.settledAt = new Date(timestamp).toISOString()
    this.write(wait)
    return wait
  }
  private ensureObservedSignal(input: SignalInput, receivedAt: string): void {
    if (!this.db.prepare('SELECT 1 FROM runtime_wait_signals WHERE session_id=? AND id=?').get(input.sessionId, input.id)) {
      this.insertSignal({ ...input, receivedAt }, hash(input))
    }
  }
  private write(wait: RuntimeWaitSubscription): void { this.db.prepare('UPDATE runtime_waits SET state_json=? WHERE id=?').run(JSON.stringify(wait), wait.id) }
}
