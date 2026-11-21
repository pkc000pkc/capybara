import { randomUUID } from 'node:crypto'
import type { LlmMessage } from '#util/llm'
import type { RuntimeArtifactMeta } from '#protocol/runtime-protocol'

export const CONTROL_RECEIPT_TOOLS: ReadonlySet<string> = new Set(['request_planning', 'search_resources', 'delegate_task', 'get_child_task',
  'consume_child_result', 'cancel_child_task', 'respond_child_task', 'take_over_child_task', 'create_wait_deadline'])

export function isSuccessfulResourceLoad(message: LlmMessage): boolean {
  if (message.role !== 'tool' || message.name !== 'load_resources') return false
  try {
    const value = JSON.parse(message.content)
    return value.runtime_receipt?.kind === 'tool-execution' && value.runtime_receipt?.status === 'succeeded' && value.ok === true
      && Array.isArray(value.result?.notFound) && value.result.notFound.length === 0
      && Array.isArray(value.result?.blockedHarnesses) && value.result.blockedHarnesses.length === 0
  } catch { return false }
}

export function isSuccessfulControlReceipt(message: LlmMessage): boolean {
  const toolName = message.name
  if (message.role !== 'tool' || !message.toolCallId || !toolName
    || (!CONTROL_RECEIPT_TOOLS.has(toolName) && !isSuccessfulResourceLoad(message))) return false
  try {
    const { ok, runtime_receipt: receipt } = JSON.parse(message.content)
    return ok === true && receipt?.kind === 'tool-execution' && receipt.status === 'succeeded' && receipt.ok === true
      && receipt.toolName === toolName && receipt.callId === message.toolCallId
  } catch { return false }
}

export interface ContextHistoryMessage {
  id: string
  sequence: number
  runId?: string
  origin: 'user' | 'model' | 'tool' | 'runtime'
  capturedAt: string
  message: LlmMessage
  sourceArtifactId?: string
  sourceArtifactMeta?: RuntimeArtifactMeta
  rawContent?: string
}

export interface ContextMessageGroup {
  id: string
  messageIds: string[]
  firstSequence: number
  lastSequence: number
  complete: boolean
  toolCallIds: string[]
}

export interface ContextEntryWitness { scope: 'project' | 'session'; id: string; bodyHash: string }

export interface ContextPartialFileGroup {
  groupId: string
  assessmentFingerprint?: string
  files: Array<{
    artifactId: string
    messageId: string
    sourceHash: string
    spans: Array<{ start: number; end: number } & ({ entry: ContextEntryWitness } | { archiveReceiptId: string })>
  }>
}

export interface ContextCoverage {
  coveredThrough: number
  retainedMessageIds: string[]
  commitId?: string
  receiptIds: string[]
  requiredEntries?: Array<{ scope: 'project' | 'session'; id: string }>
  excerptSources?: Array<{ artifactId: string; entries: ContextEntryWitness[] }>
  partialFileGroups?: ContextPartialFileGroup[]
}

export interface ContextHistoryState {
  version: 1
  messages: ContextHistoryMessage[]
  coverage: ContextCoverage
}

export interface ContextCoverageProposal {
  groupIds: string[]
  proposalKeys: string[]
  retainedMessageIds: string[]
}

/** Original observations are append-only. Coverage controls only model projection. */
export class ContextHistory {
  private readonly messages: ContextHistoryMessage[]
  private coverage: ContextCoverage

  constructor(state?: ContextHistoryState) {
    this.messages = structuredClone(state?.messages ?? [])
    this.coverage = structuredClone(state?.coverage ?? { coveredThrough: 0, retainedMessageIds: [], receiptIds: [] })
    if (state && state.version !== 1) throw new Error('CONTEXT_HISTORY_VERSION_INVALID')
    const ids = new Set<string>()
    this.messages.forEach((entry, index) => {
      if (entry.sequence !== index + 1 || !entry.id || ids.has(entry.id) || entry.message.role === 'system') throw new Error('CONTEXT_HISTORY_INVALID')
      ids.add(entry.id)
    })
    if (!Number.isSafeInteger(this.coverage.coveredThrough) || this.coverage.coveredThrough < 0
      || this.coverage.coveredThrough > this.messages.length
      || this.coverage.retainedMessageIds.some((id) => !ids.has(id))) throw new Error('CONTEXT_COVERAGE_INVALID')
  }

  append(input: Omit<ContextHistoryMessage, 'id' | 'sequence' | 'capturedAt'> & { id?: string; capturedAt?: string }, persist?: (entry: ContextHistoryMessage) => void): ContextHistoryMessage {
    if (input.message.role === 'system') throw new Error('CONTEXT_HISTORY_SYSTEM_MESSAGE_FORBIDDEN')
    const id = input.id ?? `history-${randomUUID()}`
    const existing = this.messages.find((item) => item.id === id)
    if (existing) {
      if (JSON.stringify(existing.message) !== JSON.stringify(input.message)
        || existing.rawContent !== input.rawContent || existing.origin !== input.origin) throw new Error('CONTEXT_HISTORY_ID_CONFLICT')
      return structuredClone(existing)
    }
    const entry = { ...structuredClone(input), id, sequence: this.messages.length + 1, capturedAt: input.capturedAt ?? new Date().toISOString() }
    persist?.(entry)
    this.messages.push(entry)
    return structuredClone(entry)
  }

  groups(): ContextMessageGroup[] {
    const groups: ContextMessageGroup[] = []
    for (let index = 0; index < this.messages.length;) {
      const entry = this.messages[index]!
      const calls = entry.message.role === 'assistant' ? entry.message.toolCalls ?? [] : []
      const entries = [entry]
      index += 1
      if (calls.length) while (this.messages[index]?.message.role === 'tool') entries.push(this.messages[index++]!)
      const callIds = calls.map((call) => call.id)
      const outputs = entries.slice(1).map((item) => item.message.toolCallId)
      const complete = entry.message.role !== 'tool' && (!calls.length
        || (new Set(callIds).size === callIds.length && outputs.length === callIds.length
          && new Set(outputs).size === outputs.length && callIds.every((id) => outputs.includes(id))))
      groups.push({ id: `group:${entry.id}`, messageIds: entries.map((item) => item.id), firstSequence: entry.sequence,
        lastSequence: entries.at(-1)!.sequence, complete, toolCallIds: callIds })
    }
    return groups
  }

  latestUserId(): string | undefined {
    return [...this.messages].reverse().find((item) => item.origin === 'user')?.id
  }

  pendingGroups(): ContextMessageGroup[] {
    return this.groups().filter((group) => group.lastSequence > this.coverage.coveredThrough)
  }

  messagesFor(groups: readonly ContextMessageGroup[]): ContextHistoryMessage[] {
    const ids = new Set(groups.flatMap((group) => group.messageIds))
    return structuredClone(this.messages.filter((entry) => ids.has(entry.id)))
  }

  project(restoreArtifactIds?: ReadonlySet<string>): LlmMessage[] {
    const retained = new Set(this.coverage.retainedMessageIds)
    if (restoreArtifactIds?.size) {
      for (const message of this.messages) {
        if (message.sourceArtifactId && restoreArtifactIds.has(message.sourceArtifactId)) retained.add(message.id)
      }
    }
    const groups = this.groups().filter((group) => group.lastSequence > this.coverage.coveredThrough
      || group.messageIds.some((id) => retained.has(id)))
    const ids = new Set(groups.flatMap((group) => group.messageIds))
    return this.messages.filter((entry) => ids.has(entry.id)).map((entry) => structuredClone(entry.message))
  }

  get size(): number { return this.messages.length }

  coverageSnapshot(): ContextCoverage { return structuredClone(this.coverage) }

  proposeCoverage(proposal: ContextCoverageProposal, commitId: string, receiptIds: string[], protectedIds: readonly string[] = []): ContextCoverage {
    const pending = this.pendingGroups()
    const requested = new Set(proposal.groupIds)
    if (!requested.size || requested.size !== proposal.groupIds.length) throw new Error('CONTEXT_COVERAGE_GROUPS_INVALID')
    const prefix = pending.slice(0, requested.size)
    if (prefix.length !== requested.size || prefix.some((group) => !requested.has(group.id) || !group.complete)) throw new Error('CONTEXT_COVERAGE_NOT_COMPLETE_PREFIX')
    const coveredThrough = prefix.at(-1)!.lastSequence
    const retained = new Set(proposal.retainedMessageIds)
    const known = new Set(this.messages.map((entry) => entry.id))
    if ([...retained].some((id) => !known.has(id))) throw new Error('CONTEXT_COVERAGE_RETAINED_UNKNOWN')
    const latest = this.latestUserId()
    for (const id of [...protectedIds, ...(latest ? [latest] : [])]) {
      const entry = this.messages.find((item) => item.id === id)
      if (entry && entry.sequence <= coveredThrough && !retained.has(id)) throw new Error('CONTEXT_COVERAGE_PROTECTED_MESSAGE')
    }
    if (!receiptIds.length || !proposal.proposalKeys.length) throw new Error('CONTEXT_COVERAGE_RECEIPTS_REQUIRED')
    return { coveredThrough, retainedMessageIds: [...retained], commitId, receiptIds: [...new Set(receiptIds)] }
  }

  confirmCoverage(value: ContextCoverage): void {
    if (value.coveredThrough < this.coverage.coveredThrough || value.coveredThrough > this.messages.length || !value.commitId) throw new Error('CONTEXT_COVERAGE_INVALID')
    this.coverage = structuredClone(value)
  }

  snapshot(): ContextHistoryState {
    return { version: 1, messages: structuredClone(this.messages), coverage: structuredClone(this.coverage) }
  }
}
