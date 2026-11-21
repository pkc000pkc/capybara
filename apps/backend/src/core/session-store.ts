import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gunzipSync, gzipSync } from 'node:zlib'
import { clearSessionContexts } from '#core/context-storage-lifecycle'

export interface SessionSummary {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  requestCount: number
  restorable: boolean
  stateBytes: number
}

export interface SessionStorageStats {
  bytes: number
  sessionCount: number
  databaseFile: string
}

export interface StoredRuntimeTraceEvent {
  version?: number
  kind?: 'event'
  id: string
  sessionId?: string
  sequence?: number
  timestamp?: string
  runId?: string
  turnId?: string
  stepId?: string
  parentTurnId?: string
  type: string
  correlationId?: string
  payload: unknown
}

export interface SessionStoreOptions {
  directory?: string
  readOnly?: boolean
  maxExpandedStateBytes?: number
  maxCompressedStateBytes?: number
}

type SessionRow = {
  id: string
  name: string
  state_json: string | Uint8Array | null
  created_at: string
  updated_at: string
  request_count: number
  state_bytes: number
  messages_json?: string | null
}

// SQLite and JSON parsing are synchronous here. Persist compressed snapshots so
// repeated checkpoints remain recoverable, while bounding both stored and
// expanded state before it can block every runtime connection.
// The larger read ceiling provides a one-time migration path for snapshots
// created before RuntimeLoop bounded its retained checkpoint window.
const MAX_RESTORABLE_STATE_BYTES = 128 * 1024 * 1024
const MAX_EXPANDED_STATE_BYTES = 768 * 1024 * 1024
export const MAX_WRITABLE_SESSION_STATE_BYTES = 256 * 1024 * 1024
export const MAX_WRITABLE_SESSION_COMPRESSED_BYTES = MAX_RESTORABLE_STATE_BYTES
export const MAX_SESSION_NAME_LENGTH = 80

function parseState(value: string | Uint8Array): unknown {
  if (typeof value === 'string') return JSON.parse(value) as unknown
  const json = gunzipSync(Buffer.from(value), { maxOutputLength: MAX_EXPANDED_STATE_BYTES })
    .toString('utf8')
  return JSON.parse(json) as unknown
}

function normalizedSessionName(name: string): string {
  const normalized = name.trim()
  if (!normalized) throw new Error('session name is required')
  if (normalized.length > MAX_SESSION_NAME_LENGTH) {
    throw new Error(`session name must not exceed ${MAX_SESSION_NAME_LENGTH} characters`)
  }
  return normalized
}

function titleFromState(value: string | Uint8Array | null | undefined): string | undefined {
  if (!value) return undefined
  try {
    const state = parseState(value) as {
      snapshot?: {
        conversation?: {
          messages?: Array<{
            role?: string
            content?: Array<{ type?: string; text?: unknown }>
          }>
        }
      }
    }
    const message = state.snapshot?.conversation?.messages?.find((item) => item.role === 'user')
    const joined = message?.content
      ?.filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text as string)
      .join('')
    const text = joined?.trim().split(/\r?\n/u)[0]?.trim()
    return text ? text.slice(0, MAX_SESSION_NAME_LENGTH) : undefined
  } catch {
    return undefined
  }
}

function summary(row: SessionRow): SessionSummary {
  const displayName = row.name === '新会话'
    ? titleFromState(row.state_json) ?? row.name
    : row.name
  return {
    id: row.id,
    name: displayName,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    requestCount: row.request_count,
    restorable: row.state_bytes <= MAX_RESTORABLE_STATE_BYTES,
    stateBytes: row.state_bytes,
  }
}

export class SessionStore {
  readonly databaseFile: string
  private readonly database: DatabaseSync
  private readonly maxExpandedStateBytes: number
  private readonly maxCompressedStateBytes: number
  private readonly sessionColumns: Set<string>
  private readonly traceColumns: Set<string>

  constructor(readonly projectDir: string, options: SessionStoreOptions = {}) {
    this.maxExpandedStateBytes = options.maxExpandedStateBytes ?? MAX_WRITABLE_SESSION_STATE_BYTES
    this.maxCompressedStateBytes = options.maxCompressedStateBytes ?? MAX_WRITABLE_SESSION_COMPRESSED_BYTES
    const directory = path.resolve(options.directory ?? path.join(projectDir, '.capybara'))
    if (!options.readOnly) fs.mkdirSync(directory, { recursive: true })
    this.databaseFile = path.join(directory, 'sessions.sqlite')
    this.database = new DatabaseSync(this.databaseFile, { readOnly: options.readOnly ?? false })
    if (!options.readOnly) this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        state_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS sessions_updated_at ON sessions(updated_at DESC);
      CREATE TABLE IF NOT EXISTS runtime_trace (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS runtime_trace_session_sequence ON runtime_trace(session_id, sequence);
    `)
    this.sessionColumns = new Set(
      (this.database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((column) => column.name),
    )
    if (!options.readOnly && !this.sessionColumns.has('state_json')) {
      this.database.exec('ALTER TABLE sessions ADD COLUMN state_json BLOB')
      this.sessionColumns.add('state_json')
    }
    this.traceColumns = new Set(
      (this.database.prepare('PRAGMA table_info(runtime_trace)').all() as Array<{ name: string }>).map((column) => column.name),
    )
    if (!options.readOnly && !this.traceColumns.has('type')) {
      // Older Electron traces did not have a separate type column; keeping a
      // nullable compatibility column lets the new writer use the same DB.
      this.database.exec("ALTER TABLE runtime_trace ADD COLUMN type TEXT NOT NULL DEFAULT ''")
      this.traceColumns.add('type')
    }
  }

  create(name?: string): SessionSummary {
    const createdAt = new Date().toISOString()
    const id = randomUUID()
    const sessionName = name?.trim()
      ? normalizedSessionName(name)
      : `Session ${this.count() + 1}`
    const columns = ['id', 'name', 'created_at', 'updated_at']
    const values: unknown[] = [id, sessionName, createdAt, createdAt]
    if (this.sessionColumns.has('workspace_id')) {
      columns.push('workspace_id')
      values.push(path.resolve(this.projectDir))
    }
    if (this.sessionColumns.has('workspace_name')) {
      columns.push('workspace_name')
      values.push(path.basename(path.resolve(this.projectDir)))
    }
    this.database.prepare(`
      INSERT INTO sessions (${columns.join(', ')})
      VALUES (${columns.map(() => '?').join(', ')})
    `).run(...(values as any[]))
    return {
      id,
      name: sessionName,
      createdAt,
      updatedAt: createdAt,
      requestCount: 0,
      restorable: true,
      stateBytes: 0,
    }
  }

  list(): SessionSummary[] {
    const rows = this.database.prepare(`
      SELECT id, name, state_json, created_at, updated_at, request_count,
             COALESCE(LENGTH(state_json), 0) AS state_bytes
      FROM sessions
      ORDER BY updated_at DESC
    `).all() as SessionRow[]
    return rows.map(summary)
  }

  get(id: string): { session: SessionSummary; state?: unknown; legacyMessages?: unknown[] } | undefined {
    const stateColumn = this.sessionColumns.has('state_json') ? 'state_json' : 'NULL'
    const messagesColumn = this.sessionColumns.has('messages_json') ? 'messages_json' : 'NULL AS messages_json'
    const row = this.database.prepare(`
      SELECT id, name, ${stateColumn} AS state_json, created_at, updated_at, request_count,
             COALESCE(LENGTH(${stateColumn}), 0) AS state_bytes, ${messagesColumn}
      FROM sessions WHERE id = ?
    `).get(id) as SessionRow | undefined
    if (!row) return
    if (row.state_bytes > MAX_RESTORABLE_STATE_BYTES) {
      throw new Error(
        `session state is too large to restore safely (${row.state_bytes} bytes); create a new session or clear session storage`,
      )
    }
    let legacyMessages: unknown[] | undefined
    if (!row.state_json && typeof row.messages_json === 'string' && row.messages_json.trim()) {
      try {
        const parsed = JSON.parse(row.messages_json) as unknown
        if (Array.isArray(parsed) && parsed.length > 0) legacyMessages = parsed
      } catch {
        legacyMessages = undefined
      }
    }
    return {
      session: summary(row),
      ...(row.state_json ? { state: parseState(row.state_json) } : {}),
      ...(legacyMessages ? { legacyMessages } : {}),
    }
  }

  save(id: string, state: unknown, requestCount: number): void {
    const json = JSON.stringify(state)
    const expandedBytes = Buffer.byteLength(json)
    if (expandedBytes > this.maxExpandedStateBytes) {
      throw new Error(
        `session state exceeds the writable expanded limit (${expandedBytes} > ${this.maxExpandedStateBytes} bytes)`,
      )
    }
    const encoded = gzipSync(Buffer.from(json), { level: 1 })
    if (encoded.byteLength > this.maxCompressedStateBytes) {
      throw new Error(
        `session state exceeds the writable compressed limit (${encoded.byteLength} > ${this.maxCompressedStateBytes} bytes)`,
      )
    }
    const result = this.database.prepare(`
      UPDATE sessions
      SET state_json = ?, request_count = ?, updated_at = ?
      WHERE id = ?
    `).run(encoded, requestCount, new Date().toISOString(), id)
    if (result.changes === 0) throw new Error(`session was not found: ${id}`)
  }

  rename(id: string, name: string): SessionSummary {
    const updatedAt = new Date().toISOString()
    const result = this.database.prepare(`
      UPDATE sessions
      SET name = ?, updated_at = ?
      WHERE id = ?
    `).run(normalizedSessionName(name), updatedAt, id)
    if (result.changes === 0) throw new Error(`session was not found: ${id}`)

    const row = this.database.prepare(`
      SELECT id, name, state_json, created_at, updated_at, request_count,
             COALESCE(LENGTH(state_json), 0) AS state_bytes
      FROM sessions WHERE id = ?
    `).get(id) as SessionRow
    return summary(row)
  }

  clear(): void {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      clearSessionContexts(this.database)
      this.database.exec('DELETE FROM sessions; DELETE FROM runtime_trace; COMMIT;')
    } catch (error) { this.database.exec('ROLLBACK'); throw error }
    // Maintenance is derived work; busy readers cannot undo an already committed clear.
    try { this.database.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;') } catch { /* retryable on a later maintenance pass */ }
  }

  appendTrace(sessionId: string, event: StoredRuntimeTraceEvent): void {
    if (!sessionId.trim()) throw new Error('session id is required')
    if (!event || typeof event.id !== 'string' || !event.id.trim()) throw new Error('trace event id is required')
    const sequence = Number.isInteger(event.sequence) ? Number(event.sequence) : 0
    const createdAt = typeof event.timestamp === 'string' && event.timestamp.trim()
      ? event.timestamp
      : new Date().toISOString()
    if (this.traceColumns.has('type')) {
      this.database.prepare(`
        INSERT OR REPLACE INTO runtime_trace (id, session_id, sequence, type, event_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(event.id, sessionId, sequence, event.type, JSON.stringify(event), createdAt)
      return
    }
    this.database.prepare(`
      INSERT OR REPLACE INTO runtime_trace (id, session_id, sequence, event_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(event.id, sessionId, sequence, JSON.stringify(event), createdAt)
  }

  listTrace(sessionId: string): StoredRuntimeTraceEvent[] {
    const rows = this.database.prepare(`
      SELECT event_json FROM runtime_trace WHERE session_id = ? ORDER BY sequence ASC, created_at ASC
    `).all(sessionId) as Array<{ event_json: string }>
    return rows.flatMap((row) => {
      try {
        const value = JSON.parse(row.event_json) as unknown
        return value && typeof value === 'object' && !Array.isArray(value)
          ? [value as StoredRuntimeTraceEvent]
          : []
      } catch {
        return []
      }
    })
  }

  clearTrace(sessionId: string): void {
    this.database.prepare('DELETE FROM runtime_trace WHERE session_id = ?').run(sessionId)
  }

  stats(): SessionStorageStats {
    const bytes = [this.databaseFile, `${this.databaseFile}-wal`, `${this.databaseFile}-shm`]
      .reduce((total, file) => total + (fs.existsSync(file) ? fs.statSync(file).size : 0), 0)
    return { bytes, sessionCount: this.count(), databaseFile: this.databaseFile }
  }

  close(): void {
    this.database.close()
  }

  private count(): number {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM sessions').get() as {
      count: number
    }
    return row.count
  }
}
