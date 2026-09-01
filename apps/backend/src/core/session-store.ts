import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gunzipSync, gzipSync } from 'node:zlib'

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

export interface SessionStoreOptions {
  directory?: string
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

function summary(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    name: row.name,
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

  constructor(readonly projectDir: string, options: SessionStoreOptions = {}) {
    this.maxExpandedStateBytes = options.maxExpandedStateBytes ?? MAX_WRITABLE_SESSION_STATE_BYTES
    this.maxCompressedStateBytes = options.maxCompressedStateBytes ?? MAX_WRITABLE_SESSION_COMPRESSED_BYTES
    const directory = path.resolve(options.directory ?? path.join(projectDir, '.capybara'))
    fs.mkdirSync(directory, { recursive: true })
    this.databaseFile = path.join(directory, 'sessions.sqlite')
    this.database = new DatabaseSync(this.databaseFile)
    this.database.exec(`
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
    `)
  }

  create(name?: string): SessionSummary {
    const createdAt = new Date().toISOString()
    const id = randomUUID()
    const sessionName = name?.trim()
      ? normalizedSessionName(name)
      : `Session ${this.count() + 1}`
    this.database.prepare(`
      INSERT INTO sessions (id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(id, sessionName, createdAt, createdAt)
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

  get(id: string): { session: SessionSummary; state?: unknown } | undefined {
    const row = this.database.prepare(`
      SELECT id, name, state_json, created_at, updated_at, request_count,
             COALESCE(LENGTH(state_json), 0) AS state_bytes
      FROM sessions WHERE id = ?
    `).get(id) as SessionRow | undefined
    if (!row) return
    if (row.state_bytes > MAX_RESTORABLE_STATE_BYTES) {
      throw new Error(
        `session state is too large to restore safely (${row.state_bytes} bytes); create a new session or clear session storage`,
      )
    }
    return {
      session: summary(row),
      ...(row.state_json ? { state: parseState(row.state_json) } : {}),
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
    this.database.exec('DELETE FROM sessions; PRAGMA wal_checkpoint(TRUNCATE); VACUUM;')
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
