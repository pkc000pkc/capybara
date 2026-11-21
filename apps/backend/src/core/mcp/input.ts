import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { Ajv } from 'ajv'
import type { JsonObject, RuntimeMcpFormField, RuntimeMcpInputReply, RuntimeMcpInputView, RuntimeRequestBinding } from '#protocol/runtime-protocol'
import type { McpInputMode } from '#core/mcp/config'
import type { McpOperationSource } from '#core/mcp/operations'

export const MCP_INPUT_RESPONDED = 'mcp.input.responded'
export type McpInputBinding = Pick<RuntimeRequestBinding, 'sessionId' | 'taskId' | 'runId'>
type Answers = Record<string, RuntimeMcpInputReply>
type Form = RuntimeMcpInputView['forms'][number]
interface UrlInput { url: string; host: string; message: string; remoteId: string }

export interface McpInputData {
  requestState?: string
  forms: Form[]
  schemas: Record<string, JsonObject>
  urls: Record<string, UrlInput>
  urlAuthority?: string
}

export interface McpInputContinuation {
  id: string
  binding: McpInputBinding
  authority: string
  tool: string
  args: JsonObject
  round: number
  originCallId: string
  originStepId: string
  operationId?: string
  workflow?: NonNullable<RuntimeMcpInputView['workflow']>
  requestState?: string
  answers: Answers
}

export interface McpInputCompletion {
  artifactId: string
  artifactHash: string
  callId: string
  originCallId: string
  originStepId: string
  tool: string
  argumentHash: string
  operationId?: string
  workflow?: NonNullable<RuntimeMcpInputView['workflow']>
}

interface Row { status: string; operation_id: string | null; view_json: string; private_json: string | null; answers_json: string | null; answered_at: string | null }

const ajv = new Ajv({ strict: true, allErrors: false, addUsedSchema: false })
ajv.addFormat('email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/)
ajv.addFormat('uri', text => { try { return !!new URL(text).protocol } catch { return false } })
ajv.addFormat('date', text => /^\d{4}-\d\d-\d\d$/.test(text) && Number.isFinite(Date.parse(text)) && new Date(text).toISOString().startsWith(text))
ajv.addFormat('date-time', text => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i.test(text) && Number.isFinite(Date.parse(text)))

function object(value: unknown): value is JsonObject { return !!value && typeof value === 'object' && !Array.isArray(value) }
function safeKey(value: string): boolean { return !!value.trim() && value.length <= 128 && !['constructor', 'prototype', '__proto__'].includes(value) }

function options(schema: JsonObject): RuntimeMcpFormField['options'] {
  const items = schema.enum ?? schema.oneOf ?? schema.anyOf
  if (items === undefined) return undefined
  if (!Array.isArray(items) || !items.length || items.length > 24) throw new Error('MCP_FORM_SCHEMA_UNSUPPORTED')
  const result = items.map(item => {
    const value = typeof item === 'string' ? item : object(item) ? item.const : undefined
    if (typeof value !== 'string' || value.length > 128) throw new Error('MCP_FORM_SCHEMA_UNSUPPORTED')
    return { value, label: object(item) && typeof item.title === 'string' ? item.title.slice(0, 200) : value }
  })
  if (new Set(result.map(item => item.value)).size !== result.length) throw new Error('MCP_FORM_SCHEMA_UNSUPPORTED')
  return result
}

function formField(id: string, schema: JsonObject, required: boolean): RuntimeMcpFormField {
  if (!safeKey(id) || /(?:password|passphrase|api[_ -]?key|access[_ -]?token|private[_ -]?key|credit[_ -]?card)/i.test(id)) throw new Error('MCP_FORM_FIELD_UNSUPPORTED')
  const kind = schema.type
  if (typeof kind !== 'string') throw new Error('MCP_FORM_SCHEMA_UNSUPPORTED')
  const listed = options(kind === 'array' && object(schema.items) ? schema.items : schema)
  if ((kind === 'array' && !listed) || !['array', 'string', 'boolean', 'number', 'integer'].includes(kind) || (listed && kind !== 'string' && kind !== 'array')) {
    throw new Error('MCP_FORM_SCHEMA_UNSUPPORTED')
  }
  const allowed = ['type', 'description', 'title', 'default', ...({
    array: ['items', 'minItems', 'maxItems', 'uniqueItems'], string: ['enum', 'oneOf', 'minLength', 'maxLength', 'format'],
    number: ['minimum', 'maximum'], integer: ['minimum', 'maximum'], boolean: [],
  }[kind] ?? [])]
  if (Object.keys(schema).some(key => !allowed.includes(key))) throw new Error('MCP_FORM_SCHEMA_UNSUPPORTED')
  if (kind === 'array' && (!object(schema.items) || schema.items.type !== 'string' || Object.keys(schema.items).some(key => !['type', 'enum', 'anyOf'].includes(key)))) {
    throw new Error('MCP_FORM_SCHEMA_UNSUPPORTED')
  }
  return { id, label: typeof schema.title === 'string' ? schema.title.slice(0, 200) : id, required,
    ...(typeof schema.description === 'string' ? { description: schema.description.slice(0, 500) } : {}),
    kind: listed ? kind === 'array' ? 'choices' : 'choice' : kind as 'string' | 'boolean' | 'number' | 'integer', ...(listed ? { options: listed } : {}) }
}

function readUrl(value: unknown): Pick<UrlInput, 'url' | 'host'> {
  if (typeof value !== 'string' || value.length > 8192 || /[\s\\\x00-\x1f\x7f]/u.test(value) || !/^https?:\/\//i.test(value)) {
    throw new Error('MCP_URL_INVALID')
  }
  let url: URL
  try { url = new URL(value) } catch { throw new Error('MCP_URL_INVALID') }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) throw new Error('MCP_URL_INVALID')
  return { url: url.href, host: url.host }
}

export function readMcpInputs(result: { inputRequests?: unknown; requestState?: string }, allows: (mode: McpInputMode) => boolean): McpInputData {
  if (!object(result.inputRequests) || JSON.stringify(result.inputRequests).length > 32768 || (result.requestState?.length ?? 0) > 16384) throw new Error('MCP_FORM_REQUEST_UNSUPPORTED')
  const entries = Object.entries(result.inputRequests)
  if (!entries.length || entries.length > 8) throw new Error('MCP_FORM_REQUEST_UNSUPPORTED')
  const schemas: Record<string, JsonObject> = Object.create(null)
  const urls: Record<string, UrlInput> = Object.create(null)
  const forms: Form[] = []
  for (const [id, value] of entries) {
    if (!safeKey(id) || !object(value) || value.method !== 'elicitation/create' || !object(value.params)) throw new Error('MCP_FORM_REQUEST_UNSUPPORTED')
    const { mode, message, requestedSchema } = value.params
    if (typeof message !== 'string' || !message.trim() || message.length > 1000) throw new Error('MCP_FORM_REQUEST_UNSUPPORTED')
    if (mode === 'url') {
      if (!allows('url')) throw new Error('MCP_URL_MODE_UNAVAILABLE')
      urls[`mcp-url-${randomUUID()}`] = { ...readUrl(value.params.url), message, remoteId: id }
      continue
    }
    if ((mode !== undefined && mode !== 'form') || !allows('form') || !object(requestedSchema) || requestedSchema.type !== 'object' || !object(requestedSchema.properties)
      || Object.keys(requestedSchema).some(key => !['type', 'properties', 'required', 'additionalProperties', '$schema'].includes(key))) throw new Error('MCP_FORM_SCHEMA_UNSUPPORTED')
    const properties = Object.entries(requestedSchema.properties)
    const required = requestedSchema.required ?? []
    if (properties.length > 24 || !Array.isArray(required) || required.some(key => typeof key !== 'string' || !Object.hasOwn(requestedSchema.properties as object, key))) throw new Error('MCP_FORM_SCHEMA_UNSUPPORTED')
    const fields = properties.map(([key, field]) => {
      if (!object(field)) throw new Error('MCP_FORM_SCHEMA_UNSUPPORTED')
      return formField(key, field, required.includes(key))
    })
    const { $schema: _dialect, ...schema } = requestedSchema
    schemas[id] = { ...schema, additionalProperties: false }
    ajv.compile(schemas[id])
    forms.push({ id, message, fields })
  }
  return { forms, schemas, urls, ...(result.requestState !== undefined ? { requestState: result.requestState } : {}) }
}

/** Form values and the MCP transport state are stored separately from the public runtime view. */
export class McpInputStore {
  constructor(private readonly db: DatabaseSync, private readonly transaction: <T>(operation: () => T) => T, private readonly assertActive: (sessionId: string) => void) {}

  private row(binding: McpInputBinding, id: string): Row | undefined {
    this.assertActive(binding.sessionId)
    return this.db.prepare('SELECT status, operation_id, view_json, private_json, answers_json, answered_at FROM runtime_mcp_inputs WHERE id=? AND session_id=? AND run_id=? AND task_id=?')
      .get(id, binding.sessionId, binding.runId, binding.taskId) as Row | undefined
  }

  register(binding: McpInputBinding, source: Omit<McpInputContinuation, 'id' | 'answers' | 'binding' | 'requestState'>,
    serverId: string, toolName: string, data: McpInputData, authorize?: () => void): string {
    return this.transaction(() => {
      this.assertActive(binding.sessionId)
      authorize?.()
      const id = `mcp-input-${randomUUID()}`
      const urls = Object.keys(data.urls).map(id => ({ id, opened: false }))
      const view: RuntimeMcpInputView = { id, serverId, toolName, callId: source.originCallId, round: source.round, status: 'pending', forms: data.forms,
        ...(urls.length ? { urls } : {}),
        ...(source.operationId ? { operationId: source.operationId } : {}), ...(source.workflow ? { workflow: source.workflow } : {}) }
      this.db.prepare('INSERT INTO runtime_mcp_inputs(id,session_id,task_id,run_id,view_json,private_json,status,operation_id) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, binding.sessionId, binding.taskId, binding.runId, JSON.stringify(view),
          JSON.stringify({ ...source, requestState: data.requestState, schemas: data.schemas, urls: data.urls, urlAuthority: data.urlAuthority }), 'pending', source.operationId ?? null)
      return id
    })
  }

  views(binding: McpInputBinding): RuntimeMcpInputView[] {
    return (this.db.prepare("SELECT status,view_json FROM runtime_mcp_inputs WHERE session_id=? AND task_id=? AND run_id=? AND status IN ('pending','answered') ORDER BY rowid").all(binding.sessionId, binding.taskId, binding.runId) as Array<{ status: RuntimeMcpInputView['status']; view_json: string }>)
      .map(row => ({ ...JSON.parse(row.view_json), status: row.status }))
  }

  hasWaitSource(binding: McpInputBinding, id: string): boolean {
    const row = this.row(binding, id)
    return !!row && (row.status === 'pending' || !!row.answered_at)
  }

  workflowFormState(binding: McpInputBinding, workflowId: string, nodeId: string, callId: string): { id: string; status: string } | undefined {
    this.assertActive(binding.sessionId)
    return this.db.prepare(`SELECT id,status FROM runtime_mcp_inputs WHERE session_id=? AND task_id=? AND run_id=?
      AND json_extract(view_json,'$.workflow.id')=? AND json_extract(view_json,'$.workflow.nodeId')=?
      AND json_extract(view_json,'$.callId')=? ORDER BY rowid DESC LIMIT 1`)
      .get(binding.sessionId, binding.taskId, binding.runId, workflowId, nodeId, callId) as { id: string; status: string } | undefined
  }

  validateReply(binding: McpInputBinding, id: string, answers: Answers, authorizeUrl?: (urlId: string) => void): Row {
    const row = this.row(binding, id)
    if (row?.status !== 'pending' || !row.private_json) throw new Error('MCP_FORM_REPLY_NOT_PENDING')
    const { schemas } = JSON.parse(row.private_json) as { schemas: Record<string, JsonObject> }
    const { urls = [] } = JSON.parse(row.view_json) as RuntimeMcpInputView
    if (Object.keys(answers).length !== Object.keys(schemas).length + urls.length) throw new Error('MCP_FORM_REPLY_INCOMPLETE')
    for (const [formId, answer] of Object.entries(answers)) {
      const url = urls.find(item => item.id === formId)
      if (url) {
        if (answer.action === 'accept') {
          if (answer.content !== undefined || !url.opened) throw new Error('MCP_URL_REPLY_INVALID')
          authorizeUrl?.(formId)
        }
        continue
      }
      if (!Object.hasOwn(schemas, formId) || (answer.action === 'accept' && !ajv.compile(schemas[formId]!)(answer.content))) throw new Error('MCP_FORM_REPLY_INVALID')
    }
    return row
  }

  readUrl(binding: McpInputBinding, id: string, urlId: string) {
    const row = this.row(binding, id)
    if (row?.status !== 'pending' || !row.private_json) throw new Error('MCP_URL_REQUEST_UNAVAILABLE')
    const view = JSON.parse(row.view_json) as RuntimeMcpInputView
    const { urls, urlAuthority } = JSON.parse(row.private_json) as { urls?: Record<string, UrlInput>; urlAuthority?: string }
    const item = view.urls?.find(item => item.id === urlId)
    if (!item || !urls || !Object.hasOwn(urls, urlId) || !urlAuthority) throw new Error('MCP_URL_REQUEST_UNAVAILABLE')
    const { url, host, message } = urls[urlId]!
    return { url, host, message, opened: item.opened, urlAuthority, serverId: view.serverId, toolName: view.toolName }
  }

  markUrlOpened(binding: McpInputBinding, id: string, urlId: string): boolean {
    return this.transaction(() => {
      const row = this.row(binding, id)
      if (row?.status !== 'pending') return false
      const view = JSON.parse(row.view_json) as RuntimeMcpInputView
      const item = view.urls?.find(item => item.id === urlId)
      if (!item || item.opened) return false
      item.opened = true
      return this.db.prepare("UPDATE runtime_mcp_inputs SET view_json=? WHERE id=? AND status='pending'")
        .run(JSON.stringify(view), id).changes === 1
    })
  }

  reply(binding: McpInputBinding, id: string, answers: Answers): void {
    this.transaction(() => {
      const row = this.validateReply(binding, id, answers)
      const actions = Object.values(answers).map(answer => answer.action)
      const status = row.operation_id && actions.includes('decline') ? 'declined' : row.operation_id && actions.includes('cancel') ? 'cancelled' : 'answered'
      const { urls } = JSON.parse(row.private_json!) as { urls?: Record<string, UrlInput> }
      const wireAnswers = Object.fromEntries(Object.entries(answers).map(([key, value]) => [urls && Object.hasOwn(urls, key) ? urls[key]!.remoteId : key, value]))
      this.db.prepare("UPDATE runtime_mcp_inputs SET status=?, answers_json=?, private_json=?, answered_at=? WHERE id=? AND status='pending'")
        .run(status, status === 'answered' ? JSON.stringify(wireAnswers) : null, status === 'answered' ? row.private_json : null, new Date().toISOString(), id)
    })
  }

  recordWriteDispatch(binding: McpInputBinding, id: string, callId: string, source: McpOperationSource, authorize: () => void): void {
    this.transaction(() => {
      this.assertActive(binding.sessionId)
      authorize()
      const updated = this.db.prepare(`UPDATE runtime_mcp_inputs SET attempt_call_id=?, attempt_json=?
        WHERE id=? AND session_id=? AND task_id=? AND run_id=? AND operation_id=? AND status='claimed' AND attempt_call_id IS NULL`)
        .run(callId, JSON.stringify(source), id, binding.sessionId, binding.taskId, binding.runId, source.operationId!)
      if (updated.changes !== 1) throw new Error('MCP_FORM_CONTINUATION_UNAVAILABLE')
    })
  }

  writeAttempt(binding: McpInputBinding, callId: string): { id: string; source: McpOperationSource } | undefined {
    const row = this.db.prepare('SELECT id, attempt_json FROM runtime_mcp_inputs WHERE session_id=? AND task_id=? AND run_id=? AND attempt_call_id=?')
      .get(binding.sessionId, binding.taskId, binding.runId, callId) as { id: string; attempt_json: string } | undefined
    return row && { id: row.id, source: JSON.parse(row.attempt_json) }
  }

  claim(binding: McpInputBinding, id: string, authorize: (entry: Omit<McpInputContinuation, 'answers'>) => void): McpInputContinuation {
    return this.transaction(() => {
      const row = this.row(binding, id)
      if (!row?.private_json || !row.answers_json) throw new Error('MCP_FORM_CONTINUATION_UNAVAILABLE')
      const { schemas: _schemas, urls: _urls, urlAuthority: _urlAuthority, ...bound } = JSON.parse(row.private_json)
      const entry: Omit<McpInputContinuation, 'answers'> = { ...bound, binding, id }
      authorize(entry)
      const updated = this.db.prepare("UPDATE runtime_mcp_inputs SET status='claimed', private_json=NULL, answers_json=NULL WHERE id=? AND status='answered'").run(id)
      if (updated.changes !== 1) throw new Error('MCP_FORM_CONTINUATION_UNAVAILABLE')
      return { ...entry, answers: JSON.parse(row.answers_json) }
    })
  }

  settle(binding: McpInputBinding, id: string, status: 'follow_up' | 'interrupted'): void {
    this.transaction(() => {
      this.assertActive(binding.sessionId)
      this.db.prepare("UPDATE runtime_mcp_inputs SET status=? WHERE id=? AND session_id=? AND task_id=? AND run_id=? AND status='claimed'")
        .run(status, id, binding.sessionId, binding.taskId, binding.runId)
    })
  }

  recordCompletion(binding: McpInputBinding, id: string, result: McpInputCompletion, persistArtifact: () => void): void {
    this.transaction(() => {
      this.assertActive(binding.sessionId)
      const updated = this.db.prepare("UPDATE runtime_mcp_inputs SET status='completed', result_json=? WHERE id=? AND session_id=? AND task_id=? AND run_id=? AND status='claimed'")
        .run(JSON.stringify(result), id, binding.sessionId, binding.taskId, binding.runId)
      if (updated.changes !== 1) throw new Error('MCP_FORM_CONTINUATION_UNAVAILABLE')
      persistArtifact()
    })
  }

  cancel(binding: McpInputBinding): void {
    this.transaction(() => {
      this.assertActive(binding.sessionId)
      this.db.prepare("UPDATE runtime_mcp_inputs SET status='cancelled', private_json=NULL, answers_json=NULL WHERE session_id=? AND task_id=? AND run_id=? AND status IN ('pending','answered')")
        .run(binding.sessionId, binding.taskId, binding.runId)
    })
  }

  completed(binding: McpInputBinding): McpInputCompletion[] {
    return (this.db.prepare("SELECT result_json FROM runtime_mcp_inputs WHERE session_id=? AND task_id=? AND run_id=? AND status='completed' AND result_json IS NOT NULL")
      .all(binding.sessionId, binding.taskId, binding.runId) as Array<{ result_json: string }>).map(row => JSON.parse(row.result_json))
  }
}
