import { CommandError, CONTEXT_DIFF_OPERATIONS, CONTEXT_TREE_OPERATIONS } from '#protocol/runtime-protocol'
import type {
  ControlEnvelopeV2,
  JsonObject,
  JsonPatchOperation,
  JsonValue,
  RuntimeCache,
  RuntimeCacheV2,
  RuntimeEnvelope,
  RuntimeVariables,
} from '#protocol/runtime-protocol'
import type { LlmMessage, LlmToolCall } from '#util/llm'
import { validateContextClassification } from '#core/context-classification'
import { adaptControlEnvelopeV2, parseControlEnvelopeV2 } from '#core/runtime-control'

/** Clone runtime values at the state boundary so callers cannot mutate snapshots. */
export function clone<T>(value: T): T {
  return structuredClone(value)
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue
}

/** Return leaf paths changed between two runtime variable snapshots. */
export function changedVariablePaths(
  before: JsonValue,
  after: JsonValue,
  prefix = '',
  changed = new Set<string>(),
): Set<string> {
  if (JSON.stringify(before) === JSON.stringify(after)) return changed
  if (isObject(before) && isObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      changedVariablePaths(
        before[key] ?? null,
        after[key] ?? null,
        prefix ? `${prefix}.${key}` : key,
        changed,
      )
    }
    return changed
  }
  if (prefix) changed.add(prefix)
  return changed
}

export function textDiff(before: string, after: string): JsonObject {
  const left = before.split('\n')
  const right = after.split('\n')
  let prefix = 0
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < left.length - prefix
    && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1
  }
  return {
    startLine: prefix + 1,
    removed: left.slice(prefix, suffix ? -suffix : undefined),
    added: right.slice(prefix, suffix ? -suffix : undefined),
  }
}

export function emptyRuntimeCache(): RuntimeCacheV2 {
  return {
    version: 2,
    summary: '',
    messages: [],
    loop: { run_id: '', iteration: 0, tool_round: 0, continuation_round: 0 },
    compression_count: 0,
    compressed_at: '',
    task_profile: { objective: '', answer_type: 'unknown', constraints: [] },
    plan: [],
    claims: [],
    evidence: [],
    hypotheses: [],
    contradictions: [],
    reviews: [],
    candidate_answer: '',
    tool_history: [],
    failure_history: [],
    budget: { review_rounds_used: 0, max_review_rounds: 3 },
  }
}

export function runtimeCacheMessages(value: unknown): LlmMessage[] {
  if (!Array.isArray(value)) throw new Error('builtin.cache.messages must be an array')
  return value.map((item, index) => {
    if (!isObject(item) || !['user', 'assistant', 'tool'].includes(String(item.role))) {
      throw new Error(`builtin.cache.messages[${index}] has an invalid role`)
    }
    if (typeof item.content !== 'string') {
      throw new Error(`builtin.cache.messages[${index}].content must be a string`)
    }
    let toolCalls: LlmToolCall[] | undefined
    if (item.toolCalls !== undefined) {
      if (!Array.isArray(item.toolCalls)) {
        throw new Error(`builtin.cache.messages[${index}].toolCalls must be an array`)
      }
      toolCalls = item.toolCalls.map((call, callIndex) => {
        if (!isObject(call) || typeof call.id !== 'string' || typeof call.name !== 'string') {
          throw new Error(`builtin.cache.messages[${index}].toolCalls[${callIndex}] is invalid`)
        }
        return { id: call.id, name: call.name, arguments: clone(call.arguments ?? null) }
      })
    }
    return {
      role: item.role as LlmMessage['role'],
      content: item.content,
      ...(typeof item.name === 'string' ? { name: item.name } : {}),
      ...(typeof item.toolCallId === 'string' ? { toolCallId: item.toolCallId } : {}),
      ...(toolCalls ? { toolCalls } : {}),
    }
  })
}

export function assertRuntimeCache(value: unknown): asserts value is RuntimeCache {
  if (
    !isObject(value)
    || (value.version !== 1 && value.version !== 2)
    || typeof value.summary !== 'string'
    || !isObject(value.loop)
    || typeof value.loop.run_id !== 'string'
    || !Number.isInteger(value.loop.iteration)
    || Number(value.loop.iteration) < 0
    || !Number.isInteger(value.loop.tool_round)
    || Number(value.loop.tool_round) < 0
    || !Number.isInteger(value.loop.continuation_round)
    || Number(value.loop.continuation_round) < 0
    || !Number.isInteger(value.compression_count)
    || Number(value.compression_count) < 0
    || typeof value.compressed_at !== 'string'
  ) {
    throw new Error('builtin.cache has an invalid runtime cache shape')
  }
  runtimeCacheMessages(value.messages)
  if (value.version === 2) {
    if (
      !isObject(value.task_profile)
      || !Array.isArray(value.plan)
      || !Array.isArray(value.claims)
      || !Array.isArray(value.evidence)
      || !Array.isArray(value.hypotheses)
      || !Array.isArray(value.contradictions)
      || !Array.isArray(value.reviews)
      || typeof value.candidate_answer !== 'string'
      || !Array.isArray(value.tool_history)
      || !Array.isArray(value.failure_history)
      || !isObject(value.budget)
    ) {
      throw new Error('builtin.cache has an invalid structured runtime cache shape')
    }
  }
}

export interface ModelOutput {
  status: 'running' | 'completed'
  content: string
  envelope?: RuntimeEnvelope
  fileQuotes?: ControlEnvelopeV2['fileQuotes']
}

function parseRuntimeEnvelope(value: unknown): RuntimeEnvelope {
  if (!isObject(value)
    || value.envelopeVersion !== 1
    || typeof value.sessionId !== 'string'
    || typeof value.runId !== 'string'
    || typeof value.requestId !== 'string'
    || !['tool_call', 'wait', 'ask_user', 'propose_diff', 'reflect', 'finish'].includes(String(value.decision))
    || !Array.isArray(value.actions)
    || !Array.isArray(value.candidateDiffs)
    || !Array.isArray(value.evidenceRequests)
    || !Array.isArray(value.uncertainties)) {
    throw new Error('runtime envelope requires version, bindings, decision, actions and governance arrays')
  }
  for (const key of ['sessionId', 'runId', 'requestId']) {
    if (!(value[key] as string).trim()) throw new Error(`runtime envelope ${key} must be non-empty`)
  }
  const evidenceRequestIds = new Set<string>()
  for (const request of value.evidenceRequests) {
    if (isObject(request) && typeof request.id === 'string') {
      if (evidenceRequestIds.has(request.id)) throw new Error('runtime envelope evidence request ids must be unique')
      evidenceRequestIds.add(request.id)
    }
  }
  for (const action of value.actions) {
    if (!isObject(action) || typeof action.kind !== 'string') throw new Error('runtime envelope action is invalid')
    if (action.kind === 'tool_call') {
      if (typeof action.toolName !== 'string' || !action.toolName.trim() || !('arguments' in action)) throw new Error('runtime envelope tool_call is invalid')
    } else if (action.kind === 'ask_user') {
      if (typeof action.question !== 'string' || !action.question.trim()) throw new Error('runtime envelope ask_user is invalid')
    } else if (action.kind === 'request_evidence') {
      if (typeof action.requestId !== 'string' || !action.requestId.trim()) throw new Error('runtime envelope request_evidence is invalid')
      if (!evidenceRequestIds.has(action.requestId)) throw new Error('runtime envelope request_evidence must reference an evidence request')
    } else {
      throw new Error(`runtime envelope action kind is unknown: ${action.kind}`)
    }
  }
  if (value.decision === 'ask_user' && !value.actions.some((action) => isObject(action) && action.kind === 'ask_user')) {
    throw new Error('runtime envelope ask_user requires an ask_user action')
  }
  for (const proposal of value.candidateDiffs) {
    if (!isObject(proposal)
      || !Number.isInteger(proposal.baseRevision)
      || Number(proposal.baseRevision) < 0
      || typeof proposal.projectionId !== 'string' || !proposal.projectionId.trim()
      || !/^[a-f0-9]{64}$/.test(String(proposal.projectionHash))
      || typeof proposal.candidateId !== 'string' || !proposal.candidateId.trim()
      || !(CONTEXT_DIFF_OPERATIONS as readonly string[]).includes(String(proposal.operation))
      || (proposal.status !== undefined && !['active', 'superseded', 'archived'].includes(String(proposal.status)))
      || !Array.isArray(proposal.evidenceRefs)
      || proposal.evidenceRefs.length === 0
      || proposal.evidenceRefs.some((id) => typeof id !== 'string' || !id.trim())
      || typeof proposal.idempotencyKey !== 'string' || !proposal.idempotencyKey.trim()
      || (proposal.body !== undefined && typeof proposal.body !== 'string')
      || (proposal.targetEntryId !== undefined && typeof proposal.targetEntryId !== 'string')
      || (proposal.targetEntryHash !== undefined && (typeof proposal.targetEntryHash !== 'string' || !/^[a-f0-9]{64}$/.test(proposal.targetEntryHash)))
      || (proposal.operation === 'add_entry' && (proposal.targetEntryId !== undefined || typeof proposal.body !== 'string'))
      || (proposal.operation === 'replace_body' && typeof proposal.body !== 'string')
      || (proposal.operation === 'mark_status' && proposal.status === undefined)) {
      throw new Error('runtime envelope candidate diff is invalid')
    }
    if (proposal.sourceScope !== undefined && !['project', 'session'].includes(String(proposal.sourceScope))) throw new Error('runtime envelope candidate diff sourceScope is invalid')
    if ((CONTEXT_TREE_OPERATIONS as readonly string[]).includes(String(proposal.operation))
      && (proposal.diffVersion !== 2 || typeof proposal.targetNodeId !== 'string' || !proposal.targetNodeId.trim()
        || !/^[a-f0-9]{64}$/.test(String(proposal.targetNodeHash)))) throw new Error('runtime envelope structural diff requires version 2 and bound node/hash')
    if (proposal.classification !== undefined) {
      try { validateContextClassification(proposal.classification) } catch { throw new Error('runtime envelope candidate diff classification is invalid') }
    }
  }
  const idempotencyKeys = value.candidateDiffs.map((proposal) => proposal.idempotencyKey)
  if (new Set(idempotencyKeys).size !== idempotencyKeys.length) throw new Error('runtime envelope candidate diff idempotency keys must be unique')
  for (const request of value.evidenceRequests) {
    if (!isObject(request) || typeof request.id !== 'string' || !request.id.trim() || typeof request.question !== 'string' || !request.question.trim() || !Array.isArray(request.sourceKinds) || request.sourceKinds.some((kind) => !['tool', 'user', 'external', 'memory', 'child-agent'].includes(String(kind)))) {
      throw new Error('runtime envelope evidence request is invalid')
    }
    if (request.targetCandidateId !== undefined && (typeof request.targetCandidateId !== 'string' || !request.targetCandidateId.trim())) {
      throw new Error('runtime envelope evidence request targetCandidateId is invalid')
    }
  }
  const uncertaintyIds = new Set<string>()
  for (const uncertainty of value.uncertainties) {
    if (!isObject(uncertainty) || typeof uncertainty.id !== 'string' || !uncertainty.id.trim() || typeof uncertainty.statement !== 'string' || !uncertainty.statement.trim() || !Array.isArray(uncertainty.relatedCandidateIds) || uncertainty.relatedCandidateIds.some((id) => typeof id !== 'string') || typeof uncertainty.blocking !== 'boolean') {
      throw new Error('runtime envelope uncertainty is invalid')
    }
    if (uncertaintyIds.has(uncertainty.id)) throw new Error('runtime envelope uncertainty ids must be unique')
    uncertaintyIds.add(uncertainty.id)
  }
  if (value.candidateDiffs.length > 0 && value.decision !== 'propose_diff') {
    throw new Error('runtime envelope candidateDiffs require decision propose_diff')
  }
  const toolActions = value.actions.filter((action) => isObject(action) && action.kind === 'tool_call')
  if (value.decision === 'tool_call' && toolActions.length === 0) {
    throw new Error('runtime envelope tool_call requires a tool_call action')
  }
  if (value.decision !== 'tool_call' && toolActions.length > 0) {
    throw new Error('runtime envelope tool_call actions require decision tool_call')
  }
  if (value.waitSpec !== undefined) {
    const wait = value.waitSpec
    if (!isObject(wait) || typeof wait.reason !== 'string' || typeof wait.resumeCondition !== 'string' || !['runtime', 'tool', 'external', 'user'].includes(String(wait.signalType))) {
      throw new Error('runtime envelope waitSpec is invalid')
    }
    if (wait.timeoutMs !== undefined && (!Number.isInteger(wait.timeoutMs) || Number(wait.timeoutMs) < 0)) {
      throw new Error('runtime envelope waitSpec timeout is invalid')
    }
    if (!wait.reason.trim() || !wait.resumeCondition.trim()) throw new Error('runtime envelope waitSpec text is invalid')
  }
  if (value.decision === 'wait' && value.waitSpec === undefined) throw new Error('runtime envelope wait requires waitSpec')
  if (value.decision === 'propose_diff' && value.candidateDiffs.length === 0) throw new Error('runtime envelope propose_diff requires candidateDiffs')
  if (value.decision === 'finish' && value.candidateDiffs.length > 0) throw new Error('runtime envelope finish cannot carry candidateDiffs')
  if ((value.decision === 'ask_user' || value.decision === 'finish') && value.evidenceRequests.length > 0) throw new Error('runtime envelope decision cannot carry evidenceRequests')
  if (value.completionCheck !== undefined) {
    const check = value.completionCheck
    if (!isObject(check) || !Array.isArray(check.requiredEvidenceRefs) || check.requiredEvidenceRefs.some((id) => typeof id !== 'string') || !Array.isArray(check.unresolvedUncertainties) || check.unresolvedUncertainties.some((id) => typeof id !== 'string') || typeof check.verified !== 'boolean') {
      throw new Error('runtime envelope completionCheck is invalid')
    }
    if (check.unresolvedUncertainties.some((id) => !uncertaintyIds.has(id))) {
      throw new Error('runtime envelope completionCheck references an unknown uncertainty')
    }
    if (check.requiredActions !== undefined && (!Array.isArray(check.requiredActions)
      || check.requiredActions.some((action) => typeof action !== 'string' || !action.trim()))) {
      throw new Error('runtime envelope requiredActions is invalid')
    }
    if (value.decision === 'finish' && Array.isArray(check.unresolvedUncertainties) && check.unresolvedUncertainties.length > 0) {
      throw new Error('runtime envelope finish cannot carry unresolved uncertainties')
    }
    if (value.decision === 'finish' && check.verified !== true) throw new Error('runtime envelope finish requires verified completionCheck')
  }
  if (value.decision === 'finish' && value.completionCheck === undefined) throw new Error('runtime envelope finish requires completionCheck')
  return value as unknown as RuntimeEnvelope
}

export function parseModelOutput(text: string): ModelOutput {
  let value: unknown
  try {
    value = JSON.parse(text.trim())
  } catch {
    throw new Error('LLM response must be a JSON object containing status and content')
  }
  if (isObject(value) && value.envelopeVersion === 2) {
    const source = parseControlEnvelopeV2(value)
    const envelope = adaptControlEnvelopeV2(source)
    // Reuse the document/evidence validation after adapting the full diff shape.
    if (!['continue', 'propose_plan', 'resume_plan', 'complete_plan_nodes'].includes(source.decision)) parseRuntimeEnvelope(envelope)
    return { status: source.decision === 'finish' ? 'completed' : 'running', content: source.userMessage, envelope,
      ...(source.fileQuotes?.length ? { fileQuotes: source.fileQuotes } : {}) }
  }
  if (
    !isObject(value)
    || (value.status !== 'running' && value.status !== 'completed')
    || typeof value.content !== 'string'
  ) {
    throw new Error('LLM response requires status "running" or "completed" and string content')
  }
  if (!value.content.trim()) throw new Error('LLM response content cannot be empty')
  const envelopeValue = isObject(value.envelope) ? value.envelope : value.envelopeVersion !== undefined ? value : undefined
  const envelope = envelopeValue === undefined ? undefined : parseRuntimeEnvelope(envelopeValue)
  return envelope ? { status: value.status, content: value.content, envelope } : { status: value.status, content: value.content }
}

/** An unwrapped answer may be retained for repair. It has no control authority. */
export function isStructuredReplyDraft(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text)
    return Array.isArray(value) || (isObject(value) && ![
      'envelope', 'envelopeVersion', 'decision', 'binding', 'actions', 'completionCheck',
      'candidateDiffs', 'planProposal', 'planProgress', 'waitSpec', 'evidenceRequests', 'fileQuotes',
    ].some(key => Object.hasOwn(value, key))
      && !((value.status === 'running' || value.status === 'completed') && Object.hasOwn(value, 'content')))
  } catch {
    return false
  }
}

function partialJsonStringField(source: string, field: string): string | undefined {
  const match = new RegExp(`"${field}"\\s*:\\s*"`).exec(source)
  if (!match) return undefined
  let value = ''
  let index = match.index + match[0].length
  while (index < source.length) {
    const character = source[index]
    if (character === '"') return value
    if (character !== '\\') {
      value += character
      index += 1
      continue
    }
    if (index + 1 >= source.length) break
    const escape = source[index + 1] as string
    if (escape === 'u') {
      const code = source.slice(index + 2, index + 6)
      if (code.length < 4) break
      if (!/^[0-9a-f]{4}$/i.test(code)) throw new Error('LLM streamed invalid JSON escape')
      value += String.fromCharCode(Number.parseInt(code, 16))
      index += 6
      continue
    }
    const escaped: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    }
    if (!(escape in escaped)) throw new Error('LLM streamed invalid JSON escape')
    value += escaped[escape]
    index += 2
  }
  return value
}

/** Incrementally exposes only completed model content from a JSON stream. */
export class ModelOutputStream {
  private raw = ''
  private status?: ModelOutput['status']
  private content = ''
  private emitted = ''

  constructor(private readonly emit: (delta: string) => void) {}

  push(delta: string): void {
    this.raw += delta
    const status = /"status"\s*:\s*"(running|completed)"/.exec(this.raw)?.[1]
    if (status) this.status = status as ModelOutput['status']
    this.content = partialJsonStringField(this.raw, 'content') ?? this.content
    this.flush()
  }

  finish(output: ModelOutput): void {
    this.status = output.status
    this.content = output.content
    this.flush()
    if (output.status === 'completed' && this.emitted !== output.content) {
      throw new Error('streamed LLM content does not match the completed response')
    }
  }

  private flush(): void {
    if (this.status !== 'completed' || this.content === this.emitted) return
    if (!this.content.startsWith(this.emitted)) {
      throw new Error('streamed LLM content changed after it was emitted')
    }
    const delta = this.content.slice(this.emitted.length)
    this.emitted = this.content
    if (delta) this.emit(delta)
  }
}

export function escapePointerToken(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1')
}

export function decodePointer(path: string): string[] {
  if (path === '') return []
  if (!path.startsWith('/')) {
    throw new CommandError('INVALID_PAYLOAD', `invalid JSON pointer: ${path}`)
  }
  return path
    .slice(1)
    .split('/')
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'))
}

export function assertSafeToken(token: string): void {
  if (token === '__proto__' || token === 'prototype' || token === 'constructor') {
    throw new CommandError('INVALID_PAYLOAD', 'unsafe variable path')
  }
}

export function renderFileQuotes(content: string, quotes: NonNullable<ModelOutput['fileQuotes']>,
  resolve: (quote: NonNullable<ModelOutput['fileQuotes']>[number], target: Readonly<Record<string, unknown>>) => { text: string; file: string; line: number }): string {
  let result: unknown
  try { result = JSON.parse(content) } catch { throw new Error('FILE_QUOTE_REPLY_NOT_JSON') }
  if (!isObject(result) && !Array.isArray(result)) throw new Error('FILE_QUOTE_REPLY_NOT_JSON')
  for (const quote of quotes) {
    const keys = decodePointer(quote.target)
    const field = keys.pop()
    if (field === undefined) throw new Error('FILE_QUOTE_TARGET_INVALID')
    for (const key of [...keys, field]) assertSafeToken(key)
    let parent: unknown = result
    for (const key of keys) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new Error('FILE_QUOTE_TARGET_INVALID')
      parent = (parent as Record<string, unknown>)[key]
    }
    if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, field)) throw new Error('FILE_QUOTE_TARGET_INVALID')
    const target = parent as Record<string, unknown>
    const proposedText = target[field]
    if (proposedText !== null && (field !== 'quote' || typeof proposedText !== 'string')) throw new Error('FILE_QUOTE_TARGET_MUST_BE_NULL')
    const excerpt = resolve(quote, target)
    if (field === 'quote' && Object.hasOwn(target, 'file') && Object.hasOwn(target, 'line')
      && (target.file !== excerpt.file || target.line !== excerpt.line)) throw new Error('FILE_QUOTE_REPLY_SOURCE_MISMATCH')
    if (proposedText !== null && proposedText !== excerpt.text) throw new Error('FILE_QUOTE_TARGET_MUST_BE_NULL')
    target[field] = excerpt.text
  }
  return JSON.stringify(result)
}

/** Apply guarded RFC 6902 add/remove/replace operations to a variable snapshot. */
export function applyPatch(
  source: RuntimeVariables,
  operations: JsonPatchOperation[],
): RuntimeVariables {
  const root = clone(source) as unknown as JsonValue

  for (const operation of operations) {
    const tokens = decodePointer(operation.path)
    if (tokens.length === 0) {
      throw new CommandError('INVALID_PAYLOAD', 'the variables root cannot be replaced')
    }
    tokens.forEach(assertSafeToken)
    let parent: JsonValue = root
    for (const token of tokens.slice(0, -1)) {
      if (Array.isArray(parent)) {
        const index = Number.parseInt(token, 10)
        if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
          throw new CommandError('INVALID_PAYLOAD', `variable path not found: ${operation.path}`)
        }
        parent = parent[index] as JsonValue
      } else if (typeof parent === 'object' && parent !== null && token in parent) {
        parent = parent[token] as JsonValue
      } else {
        throw new CommandError('INVALID_PAYLOAD', `variable path not found: ${operation.path}`)
      }
    }

    const finalToken = tokens.at(-1) as string
    if (Array.isArray(parent)) {
      const index = finalToken === '-' ? parent.length : Number.parseInt(finalToken, 10)
      if (!Number.isInteger(index) || index < 0 || index > parent.length) {
        throw new CommandError('INVALID_PAYLOAD', `invalid array index: ${operation.path}`)
      }
      if (operation.op === 'add') {
        parent.splice(index, 0, clone(operation.value))
      } else if (operation.op === 'replace') {
        if (index >= parent.length) {
          throw new CommandError('INVALID_PAYLOAD', `variable path not found: ${operation.path}`)
        }
        parent[index] = clone(operation.value)
      } else {
        if (index >= parent.length) {
          throw new CommandError('INVALID_PAYLOAD', `variable path not found: ${operation.path}`)
        }
        parent.splice(index, 1)
      }
      continue
    }

    if (typeof parent !== 'object' || parent === null) {
      throw new CommandError('INVALID_PAYLOAD', `variable path not found: ${operation.path}`)
    }
    if (operation.op === 'remove') {
      if (!(finalToken in parent)) {
        throw new CommandError('INVALID_PAYLOAD', `variable path not found: ${operation.path}`)
      }
      delete parent[finalToken]
    } else if (operation.op === 'replace') {
      if (!(finalToken in parent)) {
        throw new CommandError('INVALID_PAYLOAD', `variable path not found: ${operation.path}`)
      }
      parent[finalToken] = clone(operation.value)
    } else {
      parent[finalToken] = clone(operation.value)
    }
  }

  return root as RuntimeVariables
}
