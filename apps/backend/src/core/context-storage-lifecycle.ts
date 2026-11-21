import type { DatabaseSync } from 'node:sqlite'
import type { ContextDocumentEngineState } from '#core/context-document-engine'

/** Called inside the session-directory transaction; project source originals survive session clearing. */
export function clearSessionContexts(database: DatabaseSync): void {
  const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name))
  if (!tables.has('context_documents') && !tables.has('context_history') && !tables.has('runtime_waits') && !tables.has('runtime_mcp_operations') && !tables.has('runtime_mcp_inputs') && !tables.has('runtime_child_tasks') && !tables.has('context_artifact_sources') && !tables.has('runtime_auxiliary_calls') && !tables.has('runtime_model_budget_runs')) return
  database.exec('CREATE TABLE IF NOT EXISTS context_session_tombstones (session_id TEXT PRIMARY KEY, cleared_at TEXT NOT NULL)')
  const clearedAt = new Date().toISOString()
  for (const table of ['sessions', 'runtime_trace', 'context_history', 'context_commits', 'context_archives', 'context_frontiers', 'context_recalls', 'context_publications', 'context_outcomes', 'context_outcome_attempts', 'runtime_mcp_operations', 'runtime_mcp_inputs', 'runtime_waits', 'runtime_wait_deadlines', 'runtime_wait_signals', 'runtime_child_tasks', 'runtime_child_reads', 'runtime_child_reviews', 'runtime_child_late_results', 'runtime_child_takeover_actions', 'context_artifact_sources', 'runtime_auxiliary_calls', 'runtime_auxiliary_events', 'runtime_model_budget_runs']) {
    if (!tables.has(table)) continue
    const column = table === 'sessions' ? 'id' : 'session_id'
    const ids = database.prepare(`SELECT DISTINCT ${column} AS id FROM ${table}`).all() as Array<{ id: string }>
    for (const row of ids) database.prepare('INSERT OR IGNORE INTO context_session_tombstones(session_id, cleared_at) VALUES (?, ?)').run(row.id, clearedAt)
  }
  if (tables.has('runtime_model_budget_attempts')) {
    database.prepare('INSERT OR IGNORE INTO context_session_tombstones SELECT DISTINCT actor_session_id, ? FROM runtime_model_budget_attempts').run(clearedAt)
  }
  if (tables.has('context_documents')) {
    for (const row of database.prepare("SELECT scope_id FROM context_documents WHERE scope_id LIKE 'session:%'").all() as Array<{ scope_id: string }>) {
      database.prepare('INSERT OR IGNORE INTO context_session_tombstones(session_id, cleared_at) VALUES (?, ?)').run(row.scope_id.slice(8), clearedAt)
    }
  }
  const retained = new Set<string>()
  if (tables.has('context_documents') && tables.has('context_history')) {
    const row = database.prepare("SELECT state_json FROM context_documents WHERE scope_id='project'").get() as { state_json: string } | undefined
    const project = row ? JSON.parse(row.state_json) as ContextDocumentEngineState : undefined
    const references = [
      ...(project?.document.evidence ?? []).map((evidence) => ({ id: evidence.referenceId, sessionId: evidence.sessionId })),
      ...(project?.document.candidates ?? []).flatMap((candidate) => {
        const scopes = project?.document.evidence.filter((evidence) => candidate.evidenceRefs.includes(evidence.id)).map((evidence) => evidence.sessionId) ?? []
        return (scopes.length ? scopes : [undefined]).flatMap((sessionId) => [{ id: candidate.rawArtifactId, sessionId }, { id: candidate.source.sourceId, sessionId }])
      }),
    ]
    for (const reference of references) {
      const rows = database.prepare(`SELECT session_id, message_id FROM context_history WHERE (message_id=? OR json_extract(state_json, '$.sourceArtifactId')=?)${reference.sessionId ? ' AND session_id=?' : ''}`)
        .all(...(reference.sessionId ? [reference.id, reference.id, reference.sessionId] : [reference.id, reference.id])) as Array<{ session_id: string; message_id: string }>
      for (const source of rows) retained.add(JSON.stringify([source.session_id, source.message_id]))
    }
    for (const source of database.prepare('SELECT session_id, message_id FROM context_history').all() as Array<{ session_id: string; message_id: string }>) {
      if (!retained.has(JSON.stringify([source.session_id, source.message_id]))) database.prepare('DELETE FROM context_history WHERE session_id=? AND message_id=?').run(source.session_id, source.message_id)
    }
  } else if (tables.has('context_history')) database.exec('DELETE FROM context_history')
  if (tables.has('context_artifact_sources')) {
    const projectRow = tables.has('context_documents') ? database.prepare("SELECT state_json FROM context_documents WHERE scope_id='project'").get() as { state_json: string } | undefined : undefined
    const project = projectRow ? JSON.parse(projectRow.state_json) as ContextDocumentEngineState : undefined
    const references = [...(project?.document.evidence ?? []).map(evidence => ({ id: evidence.referenceId, sessionId: evidence.sessionId })),
      ...(project?.document.candidates ?? []).map(candidate => ({ id: candidate.rawArtifactId, sessionId: undefined }))]
    for (const source of database.prepare('SELECT session_id,artifact_id FROM context_artifact_sources').all() as Array<{ session_id: string; artifact_id: string }>) {
      if (!references.some(reference => reference.id === source.artifact_id && (!reference.sessionId || reference.sessionId === source.session_id))) {
        database.prepare('DELETE FROM context_artifact_sources WHERE session_id=? AND artifact_id=?').run(source.session_id, source.artifact_id)
      }
    }
  }
  for (const table of ['context_commits', 'context_archives', 'context_archive_spans', 'context_frontiers', 'context_recalls', 'context_publications', 'context_outcomes', 'context_outcome_attempts', 'runtime_mcp_operations', 'runtime_mcp_inputs', 'runtime_waits', 'runtime_wait_deadlines', 'runtime_wait_signals', 'runtime_child_tasks', 'runtime_child_reads', 'runtime_child_reviews', 'runtime_child_late_results', 'runtime_child_takeover_actions', 'runtime_auxiliary_calls', 'runtime_auxiliary_events', 'runtime_model_budget_attempts', 'runtime_model_budget_runs']) {
    if (tables.has(table)) database.exec(`DELETE FROM ${table}`)
  }
  if (tables.has('context_documents')) database.exec("DELETE FROM context_documents WHERE scope_id<>'project'")
}
