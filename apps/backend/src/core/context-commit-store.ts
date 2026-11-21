import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import type { ContextDocumentEngineState } from '#core/context-document-engine'
import { contextKnowledgeHash, contextValueHash, proposalHash, type DiffProposal, type ApplyReceipt, type Projection } from '#core/context-document-engine'
import type { ContextHistoryState, ContextHistoryMessage, ContextCoverage } from '#core/context-history'
import { assertAssetWriteAllowed } from '#core/asset-write-policy'
import type { ContextArchiveRecord } from '#core/context-organizer'
import type { RuntimeContextMemoryRecallResult, RuntimeArtifactMeta, RuntimeRequestBinding } from '#protocol/runtime-protocol'
import type { ToolCallResult } from '#core/tools/types'
import { McpInputStore, type McpInputBinding, type McpInputCompletion } from '#core/mcp/input'
import { mcpVerificationOutcome, type McpOperation, type McpOperationBinding, type McpOperationSource, type McpVerificationReceipt } from '#core/mcp/operations'

export interface ContextCommit {
  outcomes?: ContextOutcome[]
  id: string
  sessionId: string
  expectedProjectRevision: number
  expectedSessionRevision: number
  project: ContextDocumentEngineState
  session: ContextDocumentEngineState
  history: ContextHistoryState
  projectChanged: boolean
  receiptIds: string[]
  archives: ContextArchiveRecord[]
  coverageAdvanced?: boolean
  partialFileGroupsUpdated?: boolean
}

export interface ContextOutcome {
  scope: 'project' | 'session'
  proposal: DiffProposal
  receipt: ApplyReceipt
  correlationId: string
  requestBinding?: RuntimeRequestBinding
  planTaskId?: string
  batchId?: string
  batchFailure?: string
}

export interface ContextOutcomeAttempt extends ContextOutcome { replayed: boolean }

export interface ContextPublication {
  scope: 'project' | 'session'
  state: ContextDocumentEngineState
  projection: Projection
}

export interface ContextPublishedProjection {
  sessionId: string
  scope: 'project' | 'session'
  channel: 'inspection' | 'model' | 'hook'
  publicationId: string
  documentId: string
  knowledgeHash: string
  projection: Projection
}

type StoredDocument = { revision: number; state_json: string; write_version: number }
type StoredMcpOperation = { outcome: string; state_json: string; binding_json: string | null; verification_json: string | null; output_json: string | null; continuation_json: string | null }

export interface ContextArchivedSourceMatch {
  archiveId: string
  sourceRef: string
  messageId: string
  referenceId: string
  origin: ContextHistoryMessage['origin']
  toolName?: string
  capturedAt: string
  start: number
  end: number
  totalCharacters: number
  sourceHash: string
  text: string
  reason: string
}

/** Two documents and the coverage frontier commit in a single SQLite transaction. */
export class ContextCommitStore {
  private readonly database: DatabaseSync
  private closed = false
  private transactionDepth = 0
  /** The actual last read/write base for this connection, independent of model revisions. */
  private observed = new Map<string, string | null>()
  readonly databaseFile: string
  readonly mcpInputs: McpInputStore

  constructor(readonly projectDir: string) {
    const directory = path.join(projectDir, '.capybara')
    fs.mkdirSync(directory, { recursive: true })
    this.databaseFile = path.join(directory, 'sessions.sqlite')
    this.database = new DatabaseSync(this.databaseFile)
    this.mcpInputs = new McpInputStore(this.database, task => this.transaction(task), sessionId => this.assertSessionActive(sessionId))
    this.database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS context_documents (
        scope_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL,
        write_version INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS context_commits (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, commit_hash TEXT NOT NULL, state_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS context_history (
        session_id TEXT NOT NULL, sequence INTEGER NOT NULL, message_id TEXT NOT NULL, state_json TEXT NOT NULL,
        PRIMARY KEY(session_id, sequence), UNIQUE(session_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS context_commits_session ON context_commits(session_id, created_at);
      CREATE TABLE IF NOT EXISTS context_archives (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, state_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS context_frontiers (session_id TEXT PRIMARY KEY, state_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS context_history_message ON context_history(message_id);
      CREATE INDEX IF NOT EXISTS context_history_artifact ON context_history(json_extract(state_json, '$.sourceArtifactId'));
      CREATE TABLE IF NOT EXISTS context_archive_spans (
        archive_id TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL, source_ref TEXT NOT NULL,
        start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, source_hash TEXT NOT NULL,
        body_text TEXT NOT NULL, search_text TEXT NOT NULL,
        PRIMARY KEY(archive_id, source_ref)
      );
      CREATE INDEX IF NOT EXISTS context_archive_spans_session ON context_archive_spans(session_id, message_id);
      CREATE TABLE IF NOT EXISTS context_recalls (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, state_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_artifact_sources(session_id TEXT NOT NULL,artifact_id TEXT NOT NULL,meta_json TEXT NOT NULL,body_text TEXT NOT NULL,PRIMARY KEY(session_id,artifact_id));
      CREATE TABLE IF NOT EXISTS runtime_mcp_operations (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, signature TEXT NOT NULL, outcome TEXT NOT NULL, state_json TEXT NOT NULL,
        binding_json TEXT, verification_json TEXT, output_json TEXT, continuation_json TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS runtime_mcp_unsettled ON runtime_mcp_operations(session_id, signature) WHERE outcome='unknown';
      CREATE TABLE IF NOT EXISTS runtime_mcp_inputs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT NOT NULL, run_id TEXT NOT NULL, status TEXT NOT NULL,
        view_json TEXT NOT NULL, private_json TEXT, answers_json TEXT, answered_at TEXT, result_json TEXT,
        operation_id TEXT, attempt_call_id TEXT, attempt_json TEXT
      );
      CREATE INDEX IF NOT EXISTS runtime_mcp_input_run ON runtime_mcp_inputs(session_id, task_id, run_id, status);
      CREATE TABLE IF NOT EXISTS context_session_tombstones (session_id TEXT PRIMARY KEY, cleared_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_publications (
        session_id TEXT NOT NULL, scope TEXT NOT NULL, document_id TEXT NOT NULL, revision INTEGER NOT NULL,
        projection_id TEXT NOT NULL, channel TEXT NOT NULL, publication_id TEXT NOT NULL, state_json TEXT NOT NULL,
        PRIMARY KEY(session_id, scope, projection_id, channel, publication_id)
      );
      CREATE TABLE IF NOT EXISTS context_outcomes (
        session_id TEXT NOT NULL, scope TEXT NOT NULL, document_id TEXT NOT NULL, receipt_id TEXT NOT NULL,
        knowledge_hash TEXT NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(session_id, scope, receipt_id)
      );
      CREATE TABLE IF NOT EXISTS context_outcome_attempts (
        session_id TEXT NOT NULL, scope TEXT NOT NULL, receipt_id TEXT NOT NULL, attempt_hash TEXT NOT NULL,
        state_json TEXT NOT NULL, PRIMARY KEY(session_id, scope, receipt_id, attempt_hash)
      );
      CREATE INDEX IF NOT EXISTS context_outcome_attempt_run ON context_outcome_attempts(
        session_id, json_extract(state_json, '$.requestBinding.runId'), json_extract(state_json, '$.requestBinding.taskId')
      );
    `)
    const documentColumns = this.database.prepare('PRAGMA table_info(context_documents)').all() as Array<{ name: string }>
    if (!documentColumns.some((column) => column.name === 'write_version')) this.database.exec('ALTER TABLE context_documents ADD COLUMN write_version INTEGER NOT NULL DEFAULT 0')
    const columns = (table: string) => (this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name)
    for (const [table, required] of [
      ['runtime_mcp_operations', ['binding_json', 'verification_json', 'output_json', 'continuation_json']],
      ['runtime_mcp_inputs', ['operation_id', 'attempt_call_id', 'attempt_json']],
    ] as const) {
      if (required.some(column => !columns(table).includes(column))) this.transaction(() => {
        const current = columns(table)
        for (const column of required) if (!current.includes(column)) this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`)
      })
    }
    this.database.exec('CREATE UNIQUE INDEX IF NOT EXISTS runtime_mcp_input_attempt ON runtime_mcp_inputs(session_id, task_id, run_id, attempt_call_id) WHERE attempt_call_id IS NOT NULL')
    const legacyArchives = this.database.prepare('SELECT state_json, session_id FROM context_archives a WHERE NOT EXISTS (SELECT 1 FROM context_archive_spans s WHERE s.archive_id=a.id)').all() as Array<{ state_json: string; session_id: string }>
    if (legacyArchives.length) this.transaction(() => { for (const row of legacyArchives) this.indexArchive(JSON.parse(row.state_json), row.session_id) })
  }

  close(): void { if (!this.closed) { this.database.close(); this.closed = true } }

  private scopeId(sessionId?: string): string { return sessionId ? `session:${sessionId}` : 'project' }

  loadDocument(sessionId?: string, options: { observe?: boolean } = {}): ContextDocumentEngineState | undefined {
    const row = this.database.prepare('SELECT revision, state_json, write_version FROM context_documents WHERE scope_id=?').get(this.scopeId(sessionId)) as StoredDocument | undefined
    if (options.observe !== false) this.observed.set(this.scopeId(sessionId), row ? this.stateHash(row.state_json, row.write_version) : null)
    return row ? JSON.parse(row.state_json) : undefined
  }

  assertSessionActive(sessionId: string): void {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('CONTEXT_SESSION_ID_REQUIRED')
    if (this.database.prepare('SELECT 1 FROM context_session_tombstones WHERE session_id=?').get(sessionId)) throw new Error('CONTEXT_SESSION_CLEARED')
  }

  reserveMcpOperation(sessionId: string, signature: string, source: NonNullable<ToolCallResult['source']>, binding?: McpOperationBinding): void {
    this.transaction(() => {
      this.assertSessionActive(sessionId)
      if (!/^[a-f0-9]{64}$/.test(signature) || !source.operationId || source.outcome !== 'unknown' || source.dispatched) throw new Error('MCP_OPERATION_INVALID')
      if (this.database.prepare("SELECT 1 FROM runtime_mcp_operations WHERE session_id=? AND signature=? AND outcome='unknown'").get(sessionId, signature)) throw new Error('MCP_OUTCOME_UNKNOWN')
      this.database.prepare('INSERT INTO runtime_mcp_operations(id,session_id,signature,outcome,state_json,binding_json) VALUES(?,?,?,?,?,?)')
        .run(source.operationId, sessionId, signature, 'unknown', JSON.stringify(source), binding ? JSON.stringify(binding) : null)
    })
  }

  settleMcpOperation(sessionId: string, source: NonNullable<ToolCallResult['source']>, output?: unknown): void {
    this.transaction(() => {
      this.assertSessionActive(sessionId)
      const row = this.database.prepare('SELECT state_json, outcome, output_json FROM runtime_mcp_operations WHERE session_id=? AND id=?').get(sessionId, source.operationId ?? '') as StoredMcpOperation | undefined
      if (!row) throw new Error('MCP_OPERATION_UNKNOWN')
      const original = JSON.parse(row.state_json) as NonNullable<ToolCallResult['source']>
      const serialized = output === undefined ? null : JSON.stringify(output)
      if (row.outcome.startsWith('verified_') || ['serverId', 'toolName', 'connectionId', 'sourceVersion', 'operationId'].some(key => original[key as keyof typeof original] !== source[key as keyof typeof source])
        || (row.outcome !== 'unknown' && (JSON.stringify(original) !== JSON.stringify(source) || row.output_json !== serialized))) throw new Error('MCP_OPERATION_REBOUND')
      this.database.prepare('UPDATE runtime_mcp_operations SET outcome=?,state_json=?,output_json=? WHERE session_id=? AND id=?')
        .run(source.outcome, JSON.stringify(source), serialized, sessionId, source.operationId!)
    })
  }

  loadUnknownMcpOperations(sessionId: string): Array<[string, NonNullable<ToolCallResult['source']>]> {
    this.assertSessionActive(sessionId)
    const rows = this.database.prepare("SELECT signature,state_json FROM runtime_mcp_operations WHERE session_id=? AND outcome='unknown'").all(sessionId) as Array<{ signature: string; state_json: string }>
    return rows.map(row => [row.signature, JSON.parse(row.state_json)])
  }

  private mcpOperation(row: StoredMcpOperation): McpOperation {
    return { source: JSON.parse(row.state_json), ...(row.binding_json ? { binding: JSON.parse(row.binding_json) } : {}),
      ...(row.verification_json ? { verification: JSON.parse(row.verification_json) } : {}),
      ...(row.continuation_json ? { continuation: JSON.parse(row.continuation_json) } : {}),
      ...(row.output_json !== null ? { output: JSON.parse(row.output_json) } : {}) }
  }

  requireMcpWriteForInput(binding: McpInputBinding, operationId: string, origin: Pick<McpInputCompletion, 'originCallId' | 'originStepId' | 'tool' | 'argumentHash'>): McpOperation {
    const operation = this.readMcpOperation(binding.sessionId, operationId)
    const original = operation?.binding
    if (!operation?.source.dispatched || operation.source.rpcRequestId === undefined || operation.source.outcome !== 'unknown' || operation.verification
      || !original?.verification || original.runId !== binding.runId || original.taskId !== binding.taskId
      || original.callId !== origin.originCallId || original.stepId !== origin.originStepId || original.toolName !== origin.tool || original.argumentHash !== origin.argumentHash) {
      throw new Error('MCP_FORM_ORIGINAL_OPERATION_UNAVAILABLE')
    }
    return operation
  }

  readMcpOperation(sessionId: string, operationId: string): McpOperation | undefined {
    this.assertSessionActive(sessionId)
    const row = this.database.prepare('SELECT * FROM runtime_mcp_operations WHERE session_id=? AND id=?').get(sessionId, operationId) as StoredMcpOperation | undefined
    return row ? this.mcpOperation(row) : undefined
  }

  mcpOperationForStep(sessionId: string, taskId: string, runId: string, stepId: string): McpOperation | undefined {
    this.assertSessionActive(sessionId)
    const row = this.database.prepare(`SELECT * FROM runtime_mcp_operations WHERE session_id=? AND json_extract(binding_json,'$.taskId')=?
      AND json_extract(binding_json,'$.runId')=? AND json_extract(binding_json,'$.stepId')=? ORDER BY rowid DESC LIMIT 1`)
      .get(sessionId, taskId, runId, stepId) as StoredMcpOperation | undefined
    return row ? this.mcpOperation(row) : undefined
  }

  mcpOperationForCall(sessionId: string, taskId: string, runId: string, callId: string): McpOperation | undefined {
    this.assertSessionActive(sessionId)
    const row = this.database.prepare(`SELECT * FROM runtime_mcp_operations WHERE session_id=? AND json_extract(binding_json,'$.taskId')=?
      AND json_extract(binding_json,'$.runId')=? AND json_extract(binding_json,'$.callId')=? ORDER BY rowid DESC LIMIT 1`)
      .get(sessionId, taskId, runId, callId) as StoredMcpOperation | undefined
    return row ? this.mcpOperation(row) : undefined
  }

  verifiedMcpOperations(sessionId: string, taskId: string, runId: string): McpOperation[] {
    this.assertSessionActive(sessionId)
    const rows = this.database.prepare(`SELECT * FROM runtime_mcp_operations WHERE session_id=? AND verification_json IS NOT NULL
      AND json_extract(binding_json,'$.taskId')=? AND json_extract(binding_json,'$.runId')=? ORDER BY rowid`).all(sessionId, taskId, runId) as StoredMcpOperation[]
    return rows.map(row => this.mcpOperation(row))
  }

  verifyMcpOperation(operationId: string, request: RuntimeRequestBinding, callId: string, artifact: RuntimeArtifactMeta, body: string, attachOriginal = false): McpVerificationReceipt {
    return this.transaction(() => {
      const operation = this.readMcpOperation(request.sessionId, operationId)
      if (!operation?.binding?.verification || operation.source.outcome !== 'unknown' || operation.source.rpcRequestId === undefined) throw new Error('MCP_VERIFICATION_OPERATION_UNAVAILABLE')
      const original = JSON.parse(body) as { kind?: string; operationId?: string; source?: ToolCallResult['source']; result?: unknown }
      const outcome = mcpVerificationOutcome(original.result, operationId)
      const source = original.source
      if (!outcome || original.kind !== 'mcp-operation-verification' || original.operationId !== operationId
        || artifact.kind !== 'tool-result' || artifact.runId !== request.runId
        || !source?.dispatched || source.type !== 'mcp' || source.outcome !== 'succeeded' || source.rpcRequestId === undefined
        || source.serverId !== operation.source.serverId || source.toolName !== operation.binding.verification.toolName) throw new Error('MCP_VERIFICATION_SOURCE_INVALID')
      if (operation.verification) {
        if (operation.verification.outcome !== outcome) throw new Error('MCP_VERIFICATION_ALREADY_SETTLED')
        if (!attachOriginal || outcome !== 'applied' || operation.verification.originalResult) return operation.verification
        this.writeArtifactSource(request.sessionId, artifact, body)
        const enriched = { ...operation.verification, originalResult: { artifactId: artifact.id, artifactHash: artifact.hash } }
        this.database.prepare('UPDATE runtime_mcp_operations SET verification_json=? WHERE session_id=? AND id=?')
          .run(JSON.stringify(enriched), request.sessionId, operationId)
        return enriched
      }
      this.writeArtifactSource(request.sessionId, artifact, body)
      const receipt: McpVerificationReceipt = { id: `mcp-verification-${operationId}`, operationId, outcome,
        verifiedAt: artifact.createdAt, verificationRequest: request, verificationCallId: callId, source,
        artifactId: artifact.id, artifactHash: artifact.hash }
      const updated = this.database.prepare("UPDATE runtime_mcp_operations SET outcome=?,verification_json=? WHERE session_id=? AND id=? AND outcome='unknown'")
        .run(`verified_${outcome}`, JSON.stringify(receipt), request.sessionId, operationId)
      if (updated.changes !== 1) throw new Error('MCP_VERIFICATION_ALREADY_SETTLED')
      this.database.prepare("UPDATE runtime_mcp_inputs SET status='operation_settled', private_json=NULL, answers_json=NULL WHERE session_id=? AND operation_id=? AND status IN ('pending','answered')")
        .run(request.sessionId, operationId)
      return receipt
    })
  }

  private stateHash(json: string, writeVersion: number): string { return createHash('sha256').update(String(writeVersion)).update('\0').update(json).digest('hex') }

  private checkObserved(scopeId: string): void {
    const row = this.database.prepare('SELECT state_json, write_version FROM context_documents WHERE scope_id=?').get(scopeId) as { state_json: string; write_version: number } | undefined
    const actual = row ? this.stateHash(row.state_json, row.write_version) : null
    const base = this.observed.get(scopeId)
    if (base === undefined && actual !== null) throw new Error(scopeId === 'project' ? 'PROJECT_CONTEXT_READ_REQUIRED' : 'SESSION_CONTEXT_READ_REQUIRED')
    if (base !== undefined && base !== actual) throw new Error(scopeId === 'project' ? 'PROJECT_CONTEXT_STATE_CONFLICT' : 'SESSION_CONTEXT_STATE_CONFLICT')
  }

  seedProject(state: ContextDocumentEngineState): ContextDocumentEngineState {
    this.database.prepare('INSERT OR IGNORE INTO context_documents(scope_id, document_id, revision, state_json) VALUES (?, ?, ?, ?)')
      .run('project', state.document.id, state.document.revision, JSON.stringify(state))
    return this.loadDocument()!
  }

  saveProject(state: ContextDocumentEngineState, expectedRevision: number, sessionId?: string, outcomes: ContextOutcome[] = []): void {
    assertAssetWriteAllowed(this.projectDir, 'project-context.save')
    this.transaction(() => {
      this.checkRevision('project', expectedRevision, false, state.document.id)
      if (state.document.revision < expectedRevision) throw new Error('PROJECT_CONTEXT_REVISION_CONFLICT')
      this.writeDocument('project', state)
      if (outcomes.length) this.writeOutcomes(sessionId!, outcomes)
    })
  }

  saveSession(sessionId: string, state: ContextDocumentEngineState, outcomes: ContextOutcome[] = []): void {
    this.transaction(() => {
      this.assertSessionActive(sessionId)
      if (state.document.sessionId !== sessionId) throw new Error('CONTEXT_DOCUMENT_SESSION_MISMATCH')
      this.checkObserved(this.scopeId(sessionId))
      const current = this.loadDocument(sessionId, { observe: false })
      if (current && (current.document.id !== state.document.id || current.document.revision > state.document.revision)) throw new Error('SESSION_CONTEXT_REVISION_CONFLICT')
      this.writeDocument(this.scopeId(sessionId), state)
      this.writeOutcomes(sessionId, outcomes)
    })
  }

  /** One-time legacy migration; a snapshot's claimed coverage is never a commit proof. */
  importSession(sessionId: string, state: ContextDocumentEngineState, messages: readonly ContextHistoryMessage[]): void {
    this.transaction(() => {
      this.assertSessionActive(sessionId)
      this.checkObserved(this.scopeId(sessionId))
      if (this.loadDocument(sessionId, { observe: false })) throw new Error('CONTEXT_SESSION_ALREADY_COMMITTED')
      if (state.document.sessionId !== sessionId) throw new Error('CONTEXT_DOCUMENT_SESSION_MISMATCH')
      for (const message of messages) this.appendMessage(sessionId, message)
      this.writeDocument(this.scopeId(sessionId), state)
      this.writeCoverage(sessionId, { coveredThrough: 0, retainedMessageIds: [], receiptIds: [] })
    })
  }

  loadCoverage(sessionId: string): ContextCoverage | undefined {
    const row = this.database.prepare('SELECT state_json FROM context_frontiers WHERE session_id=?').get(sessionId) as { state_json: string } | undefined
    return row ? JSON.parse(row.state_json) : undefined
  }

  /** Explicit checkpoint rollback creates a new document revision; raw history is never rewound. */
  restoreSessionCheckpoint(sessionId: string, checkpoint: ContextDocumentEngineState): ContextDocumentEngineState {
    const state = structuredClone(checkpoint)
    if (state.document.sessionId !== sessionId) throw new Error('CONTEXT_DOCUMENT_SESSION_MISMATCH')
    this.transaction(() => {
      this.assertSessionActive(sessionId)
      this.checkObserved(this.scopeId(sessionId))
      const current = this.loadDocument(sessionId, { observe: false })
      state.document.parentRevision = Math.max(current?.document.revision ?? 0, state.document.revision)
      state.document.revision = state.document.parentRevision + 1
      state.document.updatedAt = new Date().toISOString()
      this.writeDocument(this.scopeId(sessionId), state)
      this.writeCoverage(sessionId, { coveredThrough: 0, retainedMessageIds: [], receiptIds: [] })
    })
    return state
  }

  appendMessage(sessionId: string, entry: ContextHistoryMessage): void {
    if (this.transactionDepth === 0) { this.transaction(() => this.appendMessage(sessionId, entry)); return }
    this.assertSessionActive(sessionId)
    const existing = this.database.prepare('SELECT state_json FROM context_history WHERE session_id=? AND message_id=?').get(sessionId, entry.id) as { state_json: string } | undefined
    if (existing) {
      if (existing.state_json !== JSON.stringify(entry)) throw new Error('CONTEXT_HISTORY_ID_CONFLICT')
      return
    }
    this.database.prepare('INSERT INTO context_history(session_id, sequence, message_id, state_json) VALUES (?, ?, ?, ?)')
      .run(sessionId, entry.sequence, entry.id, JSON.stringify(entry))
  }

  readMessages(sessionId: string): ContextHistoryMessage[] {
    const rows = this.database.prepare('SELECT state_json FROM context_history WHERE session_id=? ORDER BY sequence').all(sessionId) as Array<{ state_json: string }>
    return rows.map((row) => JSON.parse(row.state_json))
  }

  /** Caller authorizes the source scope; ambiguous cross-session IDs never pick a winner. */
  readSource(referenceId: string, sessionId?: string): ContextHistoryMessage | undefined {
    const rows = this.database.prepare(`SELECT state_json FROM context_history WHERE (message_id=? OR json_extract(state_json, '$.sourceArtifactId')=?) ${sessionId ? 'AND session_id=?' : ''} LIMIT 2`)
      .all(...(sessionId ? [referenceId, referenceId, sessionId] : [referenceId, referenceId])) as Array<{ state_json: string }>
    if (rows.length > 1) throw new Error('CONTEXT_SOURCE_ID_AMBIGUOUS')
    return rows[0] ? JSON.parse(rows[0].state_json) : undefined
  }

  saveArtifactSource(sessionId: string, meta: RuntimeArtifactMeta, body: string): void {
    this.transaction(() => this.writeArtifactSource(sessionId, meta, body))
  }

  saveMcpInputCompletion(binding: McpInputBinding, id: string, origin: Omit<McpInputCompletion, 'artifactId' | 'artifactHash'>, meta: RuntimeArtifactMeta, body: string,
    write?: { source: McpOperationSource; output: unknown }): void {
    this.mcpInputs.recordCompletion(binding, id, { ...origin, artifactId: meta.id, artifactHash: meta.hash }, () => {
      this.writeArtifactSource(binding.sessionId, meta, body)
      if (!write) return
      const { source, output } = write
      const operation = this.requireMcpWriteForInput(binding, source.operationId!, origin)
      const attempt = this.mcpInputs.writeAttempt(binding, origin.callId)
      if (attempt?.id !== id || !source.dispatched || source.outcome !== 'succeeded' || source.rpcRequestId === undefined
        || attempt.source.rpcRequestId !== source.rpcRequestId || attempt.source.operationId !== source.operationId
        || attempt.source.connectionId !== source.connectionId || attempt.source.sourceVersion !== source.sourceVersion
        || attempt.source.serverId !== source.serverId || attempt.source.toolName !== source.toolName
        || operation.source.serverId !== source.serverId || operation.source.toolName !== source.toolName) throw new Error('MCP_FORM_WRITE_RECEIPT_INVALID')
      const terminal: NonNullable<McpOperation['continuation']> = { formId: id, callId: origin.callId, artifactId: meta.id, artifactHash: meta.hash, source }
      const updated = this.database.prepare("UPDATE runtime_mcp_operations SET outcome='succeeded',state_json=?,output_json=?,continuation_json=? WHERE id=? AND session_id=? AND outcome='unknown'")
        .run(JSON.stringify({ ...operation.source, outcome: 'succeeded' }), JSON.stringify(output), JSON.stringify(terminal), source.operationId!, binding.sessionId)
      if (updated.changes !== 1) throw new Error('MCP_OPERATION_REBOUND')
    })
  }

  private writeArtifactSource(sessionId: string, meta: RuntimeArtifactMeta, body: string): void {
    this.assertSessionActive(sessionId)
    if (createHash('sha256').update(body).digest('hex') !== meta.hash || Buffer.byteLength(body) !== meta.byteLength) throw new Error('CONTEXT_ARTIFACT_SOURCE_HASH_INVALID')
    const existing = this.database.prepare('SELECT meta_json,body_text FROM context_artifact_sources WHERE session_id=? AND artifact_id=?').get(sessionId, meta.id) as { meta_json: string; body_text: string } | undefined
    const json = JSON.stringify(meta)
    if (existing) { if (existing.meta_json !== json || existing.body_text !== body) throw new Error('CONTEXT_ARTIFACT_SOURCE_IMMUTABLE'); return }
    this.database.prepare('INSERT INTO context_artifact_sources(session_id,artifact_id,meta_json,body_text) VALUES(?,?,?,?)').run(sessionId, meta.id, json, body)
  }

  readArtifactSource(artifactId: string, sessionId?: string): { sessionId: string; meta: RuntimeArtifactMeta; body: string } | undefined {
    const rows = this.database.prepare(`SELECT session_id,meta_json,body_text FROM context_artifact_sources WHERE artifact_id=?${sessionId ? ' AND session_id=?' : ''} LIMIT 2`)
      .all(...(sessionId ? [artifactId, sessionId] : [artifactId])) as Array<{ session_id: string; meta_json: string; body_text: string }>
    if (rows.length > 1) throw new Error('CONTEXT_SOURCE_ID_AMBIGUOUS')
    const row = rows[0]
    if (!row) return
    const meta: RuntimeArtifactMeta = JSON.parse(row.meta_json)
    if (createHash('sha256').update(row.body_text).digest('hex') !== meta.hash) throw new Error('CONTEXT_ARTIFACT_SOURCE_HASH_INVALID')
    return { sessionId: row.session_id, meta, body: row.body_text }
  }

  commitRecall(sessionId: string, expectedRevision: number, state: ContextDocumentEngineState, result: RuntimeContextMemoryRecallResult, expectedProjectHash?: string): void {
    if (state.document.sessionId !== sessionId) throw new Error('CONTEXT_RECALL_SESSION_MISMATCH')
    this.transaction(() => {
      this.assertSessionActive(sessionId)
      const json = JSON.stringify(result)
      const existing = this.database.prepare('SELECT state_json FROM context_recalls WHERE id=? AND session_id=?').get(result.recallId, sessionId) as { state_json: string } | undefined
      if (existing) {
        if (existing.state_json !== json) throw new Error('CONTEXT_RECALL_ID_CONFLICT')
        return
      }
      this.checkRevision(this.scopeId(sessionId), expectedRevision, true, state.document.id)
      if (expectedProjectHash !== undefined) {
        const project = this.loadDocument(undefined, { observe: false })
        if (!project || contextKnowledgeHash(project.document) !== expectedProjectHash) throw new Error('CONTEXT_RECALL_PROJECT_SNAPSHOT_STALE')
      }
      this.writeDocument(this.scopeId(sessionId), state)
      this.database.prepare('INSERT INTO context_recalls(id, session_id, state_json) VALUES (?, ?, ?)').run(result.recallId, sessionId, json)
    })
  }

  loadRecall(sessionId: string, recallId: string): RuntimeContextMemoryRecallResult | undefined {
    const row = this.database.prepare('SELECT state_json FROM context_recalls WHERE id=? AND session_id=?').get(recallId, sessionId) as { state_json: string } | undefined
    return row ? JSON.parse(row.state_json) : undefined
  }

  searchArchivedSources(sessionId: string, terms: readonly string[], limit: number): ContextArchivedSourceMatch[] {
    if (!terms.length || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('CONTEXT_ARCHIVE_QUERY_INVALID')
    const normalizedTerms = terms.map(term => term.toLowerCase())
    // The derived span index uses JS UTF-16 slicing, exactly like the organizer, including astral characters.
    const rows = this.database.prepare(`WITH matching_spans AS (
      SELECT s.*, ROW_NUMBER() OVER (
        PARTITION BY s.message_id, s.start_offset, s.end_offset, s.source_hash ORDER BY s.rowid
      ) AS copy_rank
      FROM context_archive_spans s
      WHERE s.session_id=? AND (${terms.map(() => 'instr(s.search_text, ?)>0').join(' OR ')})
    )
      SELECT s.*, h.state_json AS message_json, a.state_json AS archive_json FROM matching_spans s
      JOIN context_history h ON h.session_id=s.session_id AND h.message_id=s.message_id JOIN context_archives a ON a.id=s.archive_id
      WHERE s.copy_rank=1
      ORDER BY ${terms.map(() => '(instr(s.search_text, ?)>0)').join(' + ')} DESC,
        CASE WHEN json_extract(h.state_json, '$.message.name')='read_runtime_artifact' THEN 1 ELSE 0 END,
        h.sequence DESC, s.archive_id, s.source_ref LIMIT ?`).all(sessionId, ...normalizedTerms, ...normalizedTerms, limit) as Array<{
        archive_id: string; message_id: string; source_ref: string; start_offset: number; end_offset: number; source_hash: string; message_json: string; archive_json: string
      }>
    const matches: ContextArchivedSourceMatch[] = []
    for (const row of rows) {
      const message = JSON.parse(row.message_json) as ContextHistoryMessage
      const rawText = message.rawContent ?? message.message.content
      if (createHash('sha256').update(rawText).digest('hex') !== row.source_hash) throw new Error('CONTEXT_ARCHIVE_HASH_CONFLICT')
      const text = rawText.slice(row.start_offset, row.end_offset)
      if (!terms.some((term) => text.toLowerCase().includes(term.toLowerCase()))) continue
      matches.push({ archiveId: row.archive_id, sourceRef: row.source_ref, messageId: row.message_id,
        referenceId: message.sourceArtifactId ?? message.id, origin: message.origin, capturedAt: message.capturedAt,
        ...(message.message.role === 'tool' && message.message.name ? { toolName: message.message.name } : {}),
        start: row.start_offset, end: row.end_offset, totalCharacters: rawText.length, sourceHash: row.source_hash, text, reason: JSON.parse(row.archive_json).reason })
      if (matches.length >= limit) break
    }
    return matches
  }

  hasArchivedSpan(sessionId: string, messageId: string, start: number, end: number, sourceHash: string, receiptId: string): boolean {
    return this.archivedSpanReceipt(sessionId, messageId, start, end, sourceHash, receiptId) !== undefined
  }

  archivedSpanReceipt(sessionId: string, messageId: string, start: number, end: number, sourceHash: string, receiptId?: string): string | undefined {
    const expected = receiptId ?? null
    const row = this.database.prepare(`SELECT json_extract(a.state_json, '$.receiptId') AS receipt
      FROM context_archive_spans s JOIN context_archives a ON a.id=s.archive_id AND a.session_id=s.session_id
      WHERE s.session_id=? AND s.message_id=? AND s.start_offset=? AND s.end_offset=? AND s.source_hash=?
        AND typeof(json_extract(a.state_json, '$.receiptId'))='text'
        AND (? IS NULL OR json_extract(a.state_json, '$.receiptId')=?) ORDER BY a.rowid LIMIT 1`)
      .get(sessionId, messageId, start, end, sourceHash, expected, expected) as { receipt: string } | undefined
    return row?.receipt
  }

  lastCommit(sessionId: string): ContextCommit | undefined {
    const row = this.database.prepare('SELECT state_json FROM context_commits WHERE session_id=? ORDER BY rowid DESC LIMIT 1').get(sessionId) as { state_json: string } | undefined
    if (!row) return undefined
    const value = JSON.parse(row.state_json) as ContextCommit
    value.history.messages = this.readMessages(sessionId)
    return value
  }

  commit(value: ContextCommit): void {
    if (value.projectChanged) assertAssetWriteAllowed(this.projectDir, 'project-context.save')
    if (value.session.document.sessionId !== value.sessionId || !value.receiptIds.length
      || (value.coverageAdvanced !== false && (value.history.coverage.commitId !== value.id || value.history.coverage.receiptIds.some((id) => !value.receiptIds.includes(id))))) throw new Error('CONTEXT_COMMIT_BINDING_INVALID')
    const commitJson = JSON.stringify({ ...value, history: { ...value.history, messages: [] },
      sourceHash: createHash('sha256').update(JSON.stringify(value.history.messages)).digest('hex') })
    const hash = createHash('sha256').update(commitJson).digest('hex')
    this.transaction(() => {
      this.assertSessionActive(value.sessionId)
      const existing = this.database.prepare('SELECT commit_hash FROM context_commits WHERE id=?').get(value.id) as { commit_hash: string } | undefined
      if (existing) {
        if (existing.commit_hash !== hash) throw new Error('CONTEXT_COMMIT_ID_CONFLICT')
        return
      }
      this.checkRevision('project', value.expectedProjectRevision, false, value.project.document.id)
      this.checkRevision(this.scopeId(value.sessionId), value.expectedSessionRevision, true, value.session.document.id)
      const known = new Set([...value.project.receipts, ...value.session.receipts].filter(([, receipt]) => receipt.result === 'applied').map(([, receipt]) => receipt.id))
      const messageIds = new Set(value.history.messages.map((entry) => entry.id))
      for (const archive of value.archives) {
        if (archive.scope !== 'session' || !archive.sourceMessageIds.length || archive.sourceMessageIds.some((id) => !messageIds.has(id))) throw new Error('CONTEXT_ARCHIVE_SOURCE_INVALID')
        this.database.prepare('INSERT INTO context_archives(id, session_id, state_json) VALUES (?, ?, ?)').run(archive.id, value.sessionId, JSON.stringify(archive))
        known.add(archive.receiptId)
      }
      if (value.receiptIds.some((id) => !known.has(id))) throw new Error('CONTEXT_COMMIT_RECEIPT_MISSING')
      for (const entry of value.history.messages) this.appendMessage(value.sessionId, entry)
      for (const archive of value.archives) this.indexArchive(archive, value.sessionId)
      if (value.projectChanged) this.writeDocument('project', value.project)
      this.writeDocument(this.scopeId(value.sessionId), value.session)
      if (value.coverageAdvanced !== false) this.writeCoverage(value.sessionId, value.history.coverage)
      else if (value.partialFileGroupsUpdated) {
        const { partialFileGroups, ...frontier } = value.history.coverage
        const { partialFileGroups: previous, ...current } = this.loadCoverage(value.sessionId)
          ?? { coveredThrough: 0, retainedMessageIds: [], receiptIds: [] }
        if (JSON.stringify(previous ?? []) !== JSON.stringify(partialFileGroups ?? [])) {
          if (JSON.stringify(frontier) !== JSON.stringify(current)) throw new Error('CONTEXT_PARTIAL_PROJECTION_FRONTIER_STALE')
          this.writeCoverage(value.sessionId, value.history.coverage)
        }
      }
      this.writeOutcomes(value.sessionId, value.outcomes ?? [])
      this.database.prepare('INSERT INTO context_commits(id, session_id, commit_hash, state_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(value.id, value.sessionId, hash, commitJson, new Date().toISOString())
    })
  }

  publishProjections(sessionId: string, channel: 'inspection' | 'model' | 'hook', publicationId: string, publications: ContextPublication[]): void {
    this.transaction(() => {
      this.assertSessionActive(sessionId)
      for (const { scope, state, projection } of publications) {
        const id = scope === 'session' ? sessionId : undefined
        const current = this.loadDocument(id, { observe: false })
        this.checkObserved(this.scopeId(id))
        if (!current || current.document.id !== state.document.id || state.document.revision < current.document.revision
          || contextKnowledgeHash(current.document) !== contextKnowledgeHash(state.document)) throw new Error('PROJECTION_METADATA_KNOWLEDGE_CONFLICT')
        const binding = new Map(state.projections).get(projection.id)
        if (!binding || projection.documentRevision !== state.document.revision || binding.documentRevision !== projection.documentRevision
          || binding.contentHash !== projection.contentHash || createHash('sha256').update(projection.markdown).digest('hex') !== projection.contentHash
          || JSON.stringify(binding.sourceEntryIds) !== JSON.stringify(projection.sourceEntryIds)
          || JSON.stringify(binding.sourceCandidateIds) !== JSON.stringify(projection.sourceCandidateIds)
          || JSON.stringify(binding.treeNodes) !== JSON.stringify(projection.treeNodes)) throw new Error('PROJECTION_PUBLICATION_BINDING_INVALID')
        const key = [sessionId, scope, projection.id, channel, publicationId]
        const record = { documentId: state.document.id, knowledgeHash: contextKnowledgeHash(state.document), projection }
        const existing = this.database.prepare('SELECT state_json FROM context_publications WHERE session_id=? AND scope=? AND projection_id=? AND channel=? AND publication_id=?').get(...key) as { state_json: string } | undefined
        if (existing) {
          const prior = JSON.parse(existing.state_json)
          if (JSON.stringify({ ...prior, projection: { ...prior.projection, createdAt: null } }) !== JSON.stringify({ ...record, projection: { ...projection, createdAt: null } })) throw new Error('PROJECTION_PUBLICATION_ID_CONFLICT')
        } else this.database.prepare('INSERT INTO context_publications VALUES (?,?,?,?,?,?,?,?)')
          .run(sessionId, scope, state.document.id, projection.documentRevision, projection.id, channel, publicationId, JSON.stringify(record))
        // A read publication cannot introduce facts, reviews or execution receipts.
        const metadata: ContextDocumentEngineState = { ...current, document: state.document,
          projections: [...new Map([...current.projections.filter(([, item]) => item.documentRevision === projection.documentRevision), [projection.id, binding] as const]).entries()] }
        if (JSON.stringify(metadata) !== JSON.stringify(current)) this.writeDocument(this.scopeId(id), metadata)
      }
    })
  }

  assertPublishedProjection(sessionId: string, scope: 'project' | 'session', proposal: Pick<DiffProposal, 'documentId' | 'projectionId' | 'baseRevision' | 'projectionHash'>, channel?: 'model' | 'hook', publicationId?: string): void {
    this.assertSessionActive(sessionId)
    const rows = this.database.prepare(`SELECT state_json FROM context_publications WHERE session_id=? AND scope=? AND document_id=? AND projection_id=? AND revision=?${channel ? ' AND channel=?' : ''}${publicationId ? ' AND publication_id=?' : ''}`)
      .all(sessionId, scope, proposal.documentId, proposal.projectionId, proposal.baseRevision, ...(channel ? [channel] : []), ...(publicationId ? [publicationId] : [])) as Array<{ state_json: string }>
    if (!rows.some((row) => JSON.parse(row.state_json).projection.contentHash === proposal.projectionHash)) throw new Error('PROJECTION_NOT_PUBLISHED')
  }

  readPublications(sessionId: string): ContextPublishedProjection[] {
    return this.database.prepare('SELECT scope, channel, publication_id, state_json FROM context_publications WHERE session_id=? ORDER BY rowid').all(sessionId)
      .map(row => ({ ...JSON.parse(row.state_json as string), sessionId, scope: row.scope, channel: row.channel, publicationId: row.publication_id }))
  }

  recordOutcomes(sessionId: string, outcomes: ContextOutcome[]): void {
    this.transaction(() => this.writeOutcomes(sessionId, outcomes))
  }

  readOutcomes(sessionId: string): ContextOutcomeAttempt[] {
    return this.database.prepare('SELECT state_json FROM context_outcome_attempts WHERE session_id=? ORDER BY rowid').all(sessionId).map((row) => JSON.parse(row.state_json as string))
  }

  readRecentModelOutcomes(binding: RuntimeRequestBinding): ContextOutcomeAttempt[] {
    return this.database.prepare(`SELECT state_json FROM context_outcome_attempts WHERE session_id=?
      AND json_extract(state_json, '$.requestBinding.runId')=? AND json_extract(state_json, '$.requestBinding.taskId')=?
      ORDER BY rowid DESC LIMIT 8`).all(binding.sessionId, binding.runId, binding.taskId)
      .reverse().map(row => JSON.parse(row.state_json as string))
  }

  readPlanEditActions(binding: Pick<RuntimeRequestBinding, 'sessionId' | 'runId' | 'taskId'>): Map<string, string> {
    const rows = this.database.prepare(`SELECT receipt_id, json_extract(state_json, '$.planTaskId') AS plan_task_id
      FROM context_outcome_attempts WHERE session_id=?
      AND json_extract(state_json, '$.requestBinding.runId')=? AND json_extract(state_json, '$.requestBinding.taskId')=?
      AND json_type(state_json, '$.planTaskId')='text' AND json_extract(state_json, '$.receipt.result')='applied'
      AND json_extract(state_json, '$.receipt.nextRevision') > json_extract(state_json, '$.receipt.previousRevision')
      AND json_extract(state_json, '$.replayed')=0 AND json_type(state_json, '$.batchFailure') IS NULL
      ORDER BY rowid`).all(binding.sessionId, binding.runId, binding.taskId) as Array<{ receipt_id: string; plan_task_id: string }>
    return new Map(rows.map(row => [`context:${row.receipt_id}`, row.plan_task_id]))
  }

  restoreRejectedOutcomes(sessionId: string, scope: 'project' | 'session', state: ContextDocumentEngineState): ContextDocumentEngineState {
    const result = structuredClone(state), receipts = new Map(result.receipts)
    // Outcomes are immutable execution history. Later knowledge or checkpoint changes do not undo an idempotency result.
    const rows = this.database.prepare('SELECT state_json FROM context_outcomes WHERE session_id=? AND scope=? AND document_id=? ORDER BY rowid')
      .all(sessionId, scope, state.document.id) as Array<{ state_json: string }>
    for (const row of rows) {
      const outcome = JSON.parse(row.state_json) as ContextOutcome
      // A rolled-back batch did not commit any new idempotency result; retain its audit without poisoning a safe retry.
      if (!outcome.batchFailure && outcome.proposal.documentId === state.document.id && outcome.receipt.result !== 'applied' && !receipts.has(outcome.proposal.idempotencyKey)) receipts.set(outcome.proposal.idempotencyKey, outcome.receipt)
    }
    result.receipts = [...receipts]
    return result
  }

  private writeOutcomes(sessionId: string, outcomes: ContextOutcome[]): void {
    if (!outcomes.length) return
    this.assertSessionActive(sessionId)
    for (const outcome of outcomes) {
      if (outcome.requestBinding && outcome.requestBinding.sessionId !== sessionId) throw new Error('CONTEXT_OUTCOME_REQUEST_SESSION_MISMATCH')
      if (outcome.receipt.proposalHash !== proposalHash(outcome.proposal)) throw new Error('CONTEXT_OUTCOME_PROPOSAL_MISMATCH')
      const current = this.loadDocument(outcome.scope === 'session' ? sessionId : undefined, { observe: false })
      if (!current || (outcome.receipt.result === 'applied' && current.document.id !== outcome.proposal.documentId)) throw new Error('CONTEXT_OUTCOME_DOCUMENT_MISMATCH')
      const prior = this.database.prepare('SELECT state_json FROM context_outcomes WHERE session_id=? AND scope=? AND receipt_id=?').get(sessionId, outcome.scope, outcome.receipt.id) as { state_json: string } | undefined
      const original = prior ? JSON.parse(prior.state_json) as ContextOutcome : undefined
      const known = current.receipts.some(([key, receipt]) => key === outcome.proposal.idempotencyKey && contextValueHash(receipt) === contextValueHash(outcome.receipt))
      if (outcome.receipt.result === 'applied' && !known) throw new Error('CONTEXT_OUTCOME_SUCCESS_UNPROVEN')
      if (original && (original.proposal.idempotencyKey !== outcome.proposal.idempotencyKey || contextValueHash(original.receipt) !== contextValueHash(outcome.receipt))) throw new Error('CONTEXT_OUTCOME_ID_CONFLICT')
      if (outcome.receipt.proposalId !== outcome.proposal.id && !original && !known) throw new Error('CONTEXT_OUTCOME_PROPOSAL_MISMATCH')
      const attempt = { ...outcome, replayed: !!original || outcome.receipt.proposalId !== outcome.proposal.id }
      if (outcome.planTaskId !== undefined && (!outcome.planTaskId.trim() || !outcome.requestBinding || outcome.batchFailure || attempt.replayed
        || outcome.receipt.result !== 'applied' || outcome.receipt.unchanged || (outcome.receipt.nextRevision ?? 0) <= outcome.receipt.previousRevision)) {
        throw new Error('CONTEXT_PLAN_EDIT_UNPROVEN')
      }
      if (!prior) this.database.prepare('INSERT INTO context_outcomes VALUES (?,?,?,?,?,?)').run(sessionId, outcome.scope, current.document.id, outcome.receipt.id, contextKnowledgeHash(current.document), JSON.stringify(outcome))
      this.database.prepare('INSERT OR IGNORE INTO context_outcome_attempts VALUES (?,?,?,?,?)').run(sessionId, outcome.scope, outcome.receipt.id, contextValueHash(outcome), JSON.stringify(attempt))
    }
  }

  private checkRevision(scopeId: string, expected: number, allowMissing = false, documentId?: string): void {
    const row = this.database.prepare('SELECT revision, document_id FROM context_documents WHERE scope_id=?').get(scopeId) as { revision: number; document_id: string } | undefined
    if (row ? row.revision !== expected || (documentId !== undefined && row.document_id !== documentId) : !allowMissing || expected !== 0) throw new Error(scopeId === 'project' ? 'PROJECT_CONTEXT_REVISION_CONFLICT' : 'SESSION_CONTEXT_REVISION_CONFLICT')
    this.checkObserved(scopeId)
  }

  private indexArchive(archive: ContextArchiveRecord, sessionId: string): void {
    const spans = archive.sourceSpans ?? archive.sourceRefs.map((sourceRef) => {
      const parsed = /^(.*):span:(\d+):(\d+)$/.exec(sourceRef)
      if (!parsed) throw new Error('CONTEXT_ARCHIVE_SPAN_INVALID')
      return { sourceRef, messageId: parsed[1]!, start: Number(parsed[2]), end: Number(parsed[3]), sourceHash: undefined }
    })
    if (spans.length !== archive.sourceRefs.length || new Set(spans.map((span) => span.sourceRef)).size !== spans.length) throw new Error('CONTEXT_ARCHIVE_SPAN_INVALID')
    for (const span of spans) {
      const message = this.readSource(span.messageId, sessionId)
      if (!message || !archive.sourceMessageIds.includes(span.messageId) || !archive.sourceRefs.includes(span.sourceRef)) throw new Error('CONTEXT_ARCHIVE_SOURCE_INVALID')
      const text = message.rawContent ?? message.message.content
      const hash = createHash('sha256').update(text).digest('hex')
      if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end < span.start || span.end > text.length
        || (span.sourceHash && span.sourceHash !== hash)) throw new Error('CONTEXT_ARCHIVE_SPAN_INVALID')
      const body = text.slice(span.start, span.end)
      this.database.prepare('INSERT OR IGNORE INTO context_archive_spans(archive_id, session_id, message_id, source_ref, start_offset, end_offset, source_hash, body_text, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(archive.id, sessionId, span.messageId, span.sourceRef, span.start, span.end, hash, body, body.toLowerCase())
    }
  }

  private writeDocument(scopeId: string, state: ContextDocumentEngineState): void {
    const json = JSON.stringify(state)
    const written = this.database.prepare('INSERT INTO context_documents(scope_id, document_id, revision, state_json) VALUES (?, ?, ?, ?) ON CONFLICT(scope_id) DO UPDATE SET document_id=excluded.document_id, revision=excluded.revision, state_json=excluded.state_json, write_version=context_documents.write_version+1 RETURNING write_version')
      .get(scopeId, state.document.id, state.document.revision, json) as { write_version: number }
    this.observed.set(scopeId, this.stateHash(json, written.write_version))
  }

  private writeCoverage(sessionId: string, coverage: ContextCoverage): void {
    this.database.prepare('INSERT INTO context_frontiers(session_id, state_json) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET state_json=excluded.state_json')
      .run(sessionId, JSON.stringify(coverage))
  }

  private transaction<T>(task: () => T): T {
    const observedBefore = new Map(this.observed)
    this.database.exec('BEGIN IMMEDIATE')
    this.transactionDepth += 1
    try { const result = task(); this.database.exec('COMMIT'); return result }
    catch (error) { this.observed = observedBefore; this.database.exec('ROLLBACK'); throw error }
    finally { this.transactionDepth -= 1 }
  }
}
