import { createHash } from 'node:crypto'
import type { ContextDocument, EvidenceRef, ProjectionProfile } from '#core/context-document-engine'
import { isSuccessfulResourceLoad, type ContextCoverage, type ContextEntryWitness, type ContextHistoryMessage, type ContextPartialFileGroup } from '#core/context-history'
import { FILE_LINE_PAGE_RANGE_DIAGNOSTIC, fileArtifactLinePage, MAX_ARTIFACT_PAGE_CHARACTERS, readFileContentView, readFileExcerpts, type FileExcerpt } from '#core/context-source-excerpts'
import { discardOrphanToolMessages } from '#core/runtime-loop-state'
import type { LlmMessage } from '#util/llm'

interface PartialFileProjection {
  groups: readonly ContextPartialFileGroup[]
  project: ContextDocument
  hasArchivedSpan: (messageId: string, start: number, end: number, sourceHash: string, receiptId: string) => boolean
  coveredReads?: NonNullable<ContextCoverage['excerptSources']>
  compactPages?: boolean
  currentRunId?: string
}

function verifyStoredToolResult(message: LlmMessage, readSource: (artifactId: string) => ContextHistoryMessage | undefined) {
  if (message.role !== 'tool' || !message.name || !message.toolCallId) return
  let envelope: {
    ok?: boolean; result?: unknown
    runtime_receipt?: { kind?: string; toolName?: string; callId?: string; resultArtifactId?: string; status?: string; ok?: boolean }
  }
  try { envelope = JSON.parse(message.content) } catch { return }
  const receipt = envelope?.runtime_receipt
  if (envelope?.ok !== true || receipt?.kind !== 'tool-execution' || receipt.status !== 'succeeded'
    || receipt.ok !== true || receipt.toolName !== message.name || receipt.callId !== message.toolCallId
    || typeof receipt.resultArtifactId !== 'string') return
  const artifactId = receipt.resultArtifactId
  const original = readSource(artifactId)
  const meta = original?.sourceArtifactMeta
  if (original?.origin !== 'tool' || original.sourceArtifactId !== artifactId || original.message.name !== message.name
    || original.message.toolCallId !== message.toolCallId || original.message.content !== message.content
    || !original.rawContent || meta?.id !== artifactId || meta.kind !== 'tool-result' || meta.redacted !== false) return
  let raw: unknown
  try { raw = JSON.parse(original.rawContent) } catch { return }
  if (JSON.stringify(raw) !== JSON.stringify({ ok: true, result: envelope.result })) return
  const body = JSON.stringify(raw, null, 2)
  const isPreview = body === meta.preview || (meta.preview.endsWith('\n...') && body.startsWith(meta.preview.slice(0, -4)))
  if (createHash('sha256').update(body).digest('hex') !== meta.hash || !isPreview) return
  return { artifactId, message, meta, envelope, original, rawContent: original.rawContent }
}

function verifyRead(message: LlmMessage, readSource: (artifactId: string) => ContextHistoryMessage | undefined) {
  if (message.name !== 'read_file') return
  const stored = verifyStoredToolResult(message, readSource)
  if (!stored) return
  const view = readFileContentView(stored.envelope.result)
  if (view) return { ...stored, view }
}

export function readVerifiedFileArtifact(artifactId: string, readSource: (artifactId: string) => ContextHistoryMessage | undefined) {
  const original = readSource(artifactId)
  const read = original && verifyRead(original.message, () => original)
  return read?.artifactId === artifactId ? read : undefined
}

export function publishedFileArtifactId(messages: readonly LlmMessage[], file: string,
  readSource: (artifactId: string) => ContextHistoryMessage | undefined): string | undefined {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'tool' || message.name !== 'read_file' || !message.toolCallId) continue
    let wire
    try { wire = JSON.parse(message.content) } catch { continue }
    const artifactId = wire?.runtime_receipt?.resultArtifactId
    if (wire?.ok !== true || wire.result?.path !== file || typeof artifactId !== 'string') continue
    const read = readVerifiedFileArtifact(artifactId, readSource)
    if (read?.view.result.path === file && read.message.toolCallId === message.toolCallId
      && JSON.stringify(read.envelope.runtime_receipt) === JSON.stringify(wire.runtime_receipt)) ids.add(artifactId)
  }
  return ids.size === 1 ? [...ids][0] : undefined
}

/** A complete native file batch can be reviewed before the model requests more work. */
export function visibleFileBatch(messages: readonly LlmMessage[], readSource: (artifactId: string) => ContextHistoryMessage | undefined,
  runId: string | undefined, minimumCharacters: number): string | undefined {
  const fileBatch = (calls: LlmMessage['toolCalls']) => !!calls && calls.length >= 2 && calls.every(call => call.name === 'read_file')
  let start = messages.length - 1
  for (; start >= 0; start -= 1) {
    const message = messages[start]!
    if (message.role === 'assistant' && (runId || fileBatch(message.toolCalls))) break
  }
  const calls = messages[start]?.toolCalls
  if (!calls || !fileBatch(calls) || new Set(calls.map(call => call.id)).size !== calls.length) return
  let end = start + 1
  while (messages[end]?.role === 'tool') end += 1
  const results = new Map(messages.slice(start + 1, end).filter(message => message.toolCallId)
    .map(message => [message.toolCallId!, message]))
  const batch = calls.map(call => results.get(call.id)).filter((message): message is LlmMessage => !!message)
  if (batch.length !== calls.length || batch.reduce((total, message) => total + message.content.length, 0) < minimumCharacters) return
  const reads = batch.map(message => verifyRead(message, readSource))
  const originalRunId = runId ?? reads[0]?.original.runId
  if (!originalRunId || reads.some(read => !read || read.original.runId !== originalRunId) || new Set(reads.map(read => read?.view.result.path)).size < 2) return
  return reads[0]?.artifactId
}

/** A raw citation must match the stored read and an exact line visible in the request. */
export function publishedFileReadLine(messages: readonly LlmMessage[], artifactId: string, file: string, line: number,
  readSource: (artifactId: string) => ContextHistoryMessage | undefined) {
  const read = readVerifiedFileArtifact(artifactId, readSource)
  if (!read || read.view.result.path !== file) return
  const original = read.view.result.lines.find(row => row.line === line)
  if (!original) return
  const matching = messages.some(message => {
    if (message.name === 'read_runtime_artifact') {
      const page = verifiedFilePage(message, id => id === artifactId ? read : undefined)
      return page?.result.mode === 'file_lines' && line >= page.result.start_line && line <= page.result.end_line
        && !!verifyStoredToolResult(message, readSource)
    }
    if (message.role !== 'tool' || message.name !== 'read_file' || message.toolCallId !== read.message.toolCallId) return false
    try {
      const wire = JSON.parse(message.content)
      return wire.ok === true && JSON.stringify(wire.runtime_receipt) === JSON.stringify(read.envelope.runtime_receipt)
        && wire.result?.path === file && Array.isArray(wire.result.lines)
        && wire.result.lines.some((row: unknown) => JSON.stringify(row) === JSON.stringify(original))
    } catch { return false }
  })
  if (matching) return { file, line, text: original.text, sourceHash: read.meta.hash }
}

type VerifiedRead = NonNullable<ReturnType<typeof verifyRead>>

function hasActiveFileWitnesses(source: NonNullable<ContextCoverage['excerptSources']>[number],
  documents: { project: ContextDocument; session: ContextDocument }): boolean {
  return source.entries.every(witness => {
    const entry = documents[witness.scope].information.find(item => item.id === witness.id && item.status === 'active')
    return entry && createHash('sha256').update(entry.body).digest('hex') === witness.bodyHash
  })
}

export function coveredFileArtifacts(coverage: ContextCoverage, documents: { project: ContextDocument; session: ContextDocument }): Set<string> {
  return new Set((coverage.excerptSources ?? []).filter(source => hasActiveFileWitnesses(source, documents)).map(source => source.artifactId))
}

function verifiedFilePage(message: LlmMessage, readArtifact: (id: string) => VerifiedRead | undefined,
  assessedArtifacts?: ReadonlySet<string>) {
  if (message.role !== 'tool' || message.name !== 'read_runtime_artifact' || !message.toolCallId) return
  try {
    const envelope = JSON.parse(message.content)
    const { result, runtime_receipt: receipt } = envelope
    if (envelope.ok !== true || receipt?.kind !== 'tool-execution' || receipt.status !== 'succeeded' || receipt.ok !== true
      || receipt.toolName !== message.name || receipt.callId !== message.toolCallId
      || typeof result?.artifact_id !== 'string' || (assessedArtifacts && !assessedArtifacts.has(result.artifact_id))
      || (result.source_scope !== undefined && result.source_scope !== 'session')) return
    const read = readArtifact(result.artifact_id)
    if (!read) return
    const hash = createHash('sha256').update(read.rawContent).digest('hex')
    if (result.source_hash !== undefined && result.source_hash !== hash) return
    if (result.mode === 'file_lines') {
      const page = fileArtifactLinePage(read.view.result, result.start_line, result.end_line)
      if (result.source_hash === hash && page && page.file === result.file && JSON.stringify(page.lines) === JSON.stringify(result.lines)) {
        return { envelope, result, read }
      }
      return
    }
    if (result.total_characters !== read.rawContent.length || typeof result.content !== 'string'
      || !Number.isSafeInteger(result.offset) || result.offset < 0
      || !Number.isSafeInteger(result.page_limit) || result.page_limit < 1 || result.page_limit > MAX_ARTIFACT_PAGE_CHARACTERS) return
    const end = result.offset + result.page_limit
    if (result.content === read.rawContent.slice(result.offset, end) && result.next_offset === (end < read.rawContent.length ? end : null)) {
      return { envelope, result, read, range: { start: result.offset as number, content: result.content as string } }
    }
  } catch { return }
}

/** A successful page can be a view of a file read already under disposition. */
export function isVerifiedFileArtifactPage(message: LlmMessage, assessedArtifacts: ReadonlySet<string>,
  readSource: (artifactId: string) => ContextHistoryMessage | undefined): boolean {
  return assessedArtifacts.size > 0 && !!verifiedFilePage(message, id => readVerifiedFileArtifact(id, readSource), assessedArtifacts)
    && !!verifyStoredToolResult(message, readSource)
}

export function verifiedFilePageOrigin(artifactId: string, readSource: (id: string) => ContextHistoryMessage | undefined) {
  const stored = readSource(artifactId)
  if (!stored || stored.sourceArtifactId !== artifactId || !verifyStoredToolResult(stored.message, () => stored)) return
  const page = verifiedFilePage(stored.message, id => readVerifiedFileArtifact(id, readSource))
  if (page) return { artifactId: page.read.artifactId, file: page.read.view.result.path }
}

/** A recall of every exact active entry is a navigation result, with no new source for Organizer. */
export function isVerifiedActiveRecallCopy(message: LlmMessage, documents: { project: ContextDocument; session: ContextDocument },
  readSource: (id: string) => ContextHistoryMessage | undefined): boolean {
  if (message.name !== 'recall_context') return false
  const stored = verifyStoredToolResult(message, readSource)
  if (!stored) return false
  const result = stored.envelope.result as { hits?: unknown[]; uncertainties?: unknown[]; archives?: unknown[] }
  if (!Array.isArray(result?.hits) || !result.hits.length || !Array.isArray(result.uncertainties)
    || result.uncertainties.length || result.archives?.length) return false
  return result.hits.every(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const hit = value as Record<string, unknown>
    if ((hit.scope !== 'session' && hit.scope !== 'project') || hit.sourceKind !== 'information' || hit.originalStatus !== 'active'
      || !Array.isArray(hit.rawArtifactIds)) return false
    const document = documents[hit.scope]
    const entry = document.information.find(item => item.id === hit.sourceId && item.status === 'active')
    if (hit.documentId !== document.id || !entry || entry.body !== hit.body) return false
    const originalIds = new Set(document.evidence.filter(item => entry.evidenceRefs.includes(item.id)).map(item => item.referenceId))
    const recalledIds = new Set(hit.rawArtifactIds)
    return originalIds.size > 0 && recalledIds.size === originalIds.size && [...recalledIds].every(id => originalIds.has(id))
  })
}

export const ARTIFACT_SOURCE_REFERENCE_DIAGNOSTIC = 'ARTIFACT_SOURCE_REFERENCE_REQUIRED'

export function isPagingInputDiagnostic(message: LlmMessage): boolean {
  if (message.role !== 'tool' || message.name !== 'read_runtime_artifact' || !message.toolCallId) return false
  try {
    const wire = JSON.parse(message.content)
    const receipt = wire.runtime_receipt
    const detail = wire.error?.message
    return wire.ok === false && wire.error?.code === 'INVALID_ARGUMENTS' && receipt?.kind === 'tool-execution'
      && receipt.status === 'failed' && receipt.ok === false && receipt.toolName === message.name && receipt.callId === message.toolCallId
      && (detail === 'use both start_line and end_line without offset or limit'
        || detail === FILE_LINE_PAGE_RANGE_DIAGNOSTIC
        || (typeof detail === 'string' && detail.startsWith(`${FILE_LINE_PAGE_RANGE_DIAGNOSTIC}.`))
        || (typeof detail === 'string' && detail.startsWith(`${ARTIFACT_SOURCE_REFERENCE_DIAGNOSTIC}: `))
        || (typeof detail === 'string' && detail.startsWith('FILE_PAGE_REQUIRES_ORIGINAL: ')))
  } catch { return false }
}

interface PublishedArtifactPage { callId: string; start: number; end: number }

/** Reference only text carried verbatim by earlier pages in this request. */
function pageSegments(range: { start: number; content: string }, published: readonly PublishedArtifactPage[]) {
  const end = range.start + range.content.length
  let cursor = range.start, hasReference = false
  const segments: Array<{ offset: number; content: string } | { offset: number; length: number; fromCallId: string }> = []
  const insertText = (to: number) => {
    if (cursor < to) segments.push({ offset: cursor, content: range.content.slice(cursor - range.start, to - range.start) })
  }
  for (const page of [...published].sort((a, b) => a.start - b.start || b.end - a.end)) {
    const from = Math.max(cursor, page.start), to = Math.min(end, page.end)
    if (from >= to) continue
    insertText(from)
    segments.push({ offset: from, length: to - from, fromCallId: page.callId })
    hasReference = true
    cursor = to
    if (cursor === end) break
  }
  insertText(end)
  return hasReference ? segments : undefined
}

function resourceLoadProof(readSource: (artifactId: string) => ContextHistoryMessage | undefined, artifactId: string) {
  let source: ContextHistoryMessage | undefined
  try { source = readSource(artifactId) } catch (error) {
    if (error instanceof Error && error.message === 'CONTEXT_SOURCE_ID_AMBIGUOUS') return
    throw error
  }
  if (source?.origin !== 'tool' || source.sourceArtifactId !== artifactId || !source.rawContent || !isSuccessfulResourceLoad(source.message)) return
  const meta = source.sourceArtifactMeta
  if (meta?.id !== artifactId || meta.kind !== 'tool-result' || meta.redacted !== false) return
  try {
    const wire = JSON.parse(source.message.content), raw = JSON.parse(source.rawContent)
    const body = JSON.stringify(raw, null, 2)
    const isPreview = body === meta.preview || (meta.preview.endsWith('\n...') && body.startsWith(meta.preview.slice(0, -4)))
    if (wire.runtime_receipt.toolName !== 'load_resources' || wire.runtime_receipt.ok !== true
      || wire.runtime_receipt.resultArtifactId !== artifactId || wire.runtime_receipt.callId !== source.message.toolCallId
      || JSON.stringify(raw) !== JSON.stringify({ ok: true, result: wire.result })
      || !isPreview || Buffer.byteLength(body) !== meta.byteLength || createHash('sha256').update(body).digest('hex') !== meta.hash) return
    return meta
  } catch { return }
}

/** Resolve the exact excerpt and location held in a verified read. */
export function createFileEvidenceResolver(readSource: (artifactId: string, sessionId: string) => ContextHistoryMessage | undefined) {
  const cache = new Map<string, { hash: string; excerpts: Map<string, FileExcerpt> } | undefined>()
  return (evidence: EvidenceRef, documentSessionId: string, scope: 'project' | 'session') => {
    const { referenceId, sessionId, sourceHash, locator } = evidence
    if (evidence.kind !== 'artifact' || !sessionId || !sourceHash || !locator?.startsWith('characters:')
      || (scope === 'session' && sessionId !== documentSessionId)) return
    const key = JSON.stringify([sessionId, referenceId])
    if (!cache.has(key)) {
      let source: ContextHistoryMessage | undefined
      try { source = readSource(referenceId, sessionId) } catch (error) {
        if (!(error instanceof Error) || error.message !== 'CONTEXT_SOURCE_ID_AMBIGUOUS') throw error
      }
      const read = source?.sourceArtifactId === referenceId ? verifyRead(source.message, () => source) : undefined
      const excerpts = read && readFileExcerpts(read.rawContent, Infinity)
      cache.set(key, read && excerpts ? {
        hash: createHash('sha256').update(read.rawContent).digest('hex'),
        excerpts: new Map(excerpts.map(excerpt => [`characters:${excerpt.start}:${excerpt.end}`, excerpt])),
      } : undefined)
    }
    const stored = cache.get(key)
    const excerpt = stored?.hash === sourceHash ? stored.excerpts.get(locator) : undefined
    if (excerpt && excerpt.line > 0) return excerpt
  }
}

function projectUnresolvedLines(read: VerifiedRead, proof: ContextPartialFileGroup['files'][number], document: ContextDocument,
  options: PartialFileProjection) {
  if (read.artifactId !== proof.artifactId || read.original.id !== proof.messageId
    || createHash('sha256').update(read.rawContent).digest('hex') !== proof.sourceHash) return
  const excerpts = readFileExcerpts(read.rawContent, Infinity)
  if (!excerpts) return
  const key = (range: { start: number; end: number }) => `${range.start}:${range.end}`
  const byRange = new Map(excerpts.map(excerpt => [key(excerpt), excerpt]))
  const certified = new Set<string>()
  const usedEntries = new Map<string, ContextEntryWitness>()
  for (const span of proof.spans) {
    const ref = key(span), excerpt = byRange.get(ref)
    if (!excerpt || certified.has(ref)) return
    if ('entry' in span) {
      const doc = span.entry.scope === 'project' ? options.project : document
      const witness = doc.information.find(entry => entry.id === span.entry.id)
      if (!witness || witness.status !== 'active' || witness.body !== excerpt.text
        || createHash('sha256').update(witness.body).digest('hex') !== span.entry.bodyHash
        || !doc.evidence.some(evidence => witness.evidenceRefs.includes(evidence.id) && evidence.kind === 'artifact'
          && evidence.referenceId === read.artifactId && evidence.sessionId === document.sessionId
          && evidence.sourceHash === proof.sourceHash && evidence.locator === `characters:${ref}`)) return
      usedEntries.set(ref, span.entry)
    } else if (!options.hasArchivedSpan(proof.messageId, span.start, span.end, proof.sourceHash, span.archiveReceiptId)) return
    certified.add(ref)
  }
  const byLine = new Map<number, FileExcerpt[]>()
  for (const excerpt of excerpts) {
    const spans = byLine.get(excerpt.line) ?? []
    spans.push(excerpt)
    byLine.set(excerpt.line, spans)
  }
  const omitted = new Set([...byLine].filter(([, spans]) => spans.every(span => certified.has(key(span)))).map(([line]) => line))
  const entries = new Map<string, ContextEntryWitness>()
  const contextLines = new Set<number>()
  for (const [ref, entry] of usedEntries) {
    const line = byRange.get(ref)!.line
    if (omitted.has(line)) {
      entries.set(`${entry.scope}:${entry.id}`, entry)
      contextLines.add(line)
    }
  }
  const { content: _content, ...result } = read.view.result
  const mixedLines = [...contextLines].filter(line => byLine.get(line)!.some(span => !usedEntries.has(key(span)))).length
  const lineDisposition = {
    published: contextLines.size - mixedLines,
    archived: omitted.size - contextLines.size,
    mixed: mixedLines,
    visible: result.lines.length - omitted.size,
  }
  return {
    hasWitness: usedEntries.size > 0,
    complete: certified.size === excerpts.length,
    entries: [...entries.values()],
    omitted,
    ...(omitted.size ? {
      content: JSON.stringify({ ...read.envelope, result: { ...result, lines: result.lines.filter(line => !omitted.has(line.line)),
        projection: 'unresolved_lines', omittedLineCount: omitted.size, contextEntryIds: [...entries.values()].map(entry => entry.id),
        contextLines: [...contextLines].sort((a, b) => a - b), lineDisposition } }),
    } : {}),
  }
}

export function projectFileHistory(messages: LlmMessage[], document: ContextDocument,
  readSource: (artifactId: string) => ContextHistoryMessage | undefined, partial?: PartialFileProjection): {
    messages: LlmMessage[]
    bodyReferences: NonNullable<ProjectionProfile['candidateBodyReferences']>
    resourceLoadCandidateIds: ReadonlySet<string>
    hasReferences: boolean
    hasPartialViews: boolean
    requiredEntries: ContextEntryWitness[]
    verifiedPartialGroupIds: ReadonlySet<string>
    verifiedFileAssessmentGroupIds: ReadonlySet<string>
  repeatedReadCallIds: ReadonlySet<string>
  } {
  const history = discardOrphanToolMessages(messages)
  const reads = new Map<LlmMessage, VerifiedRead>()
  const visibleFiles = new Map<string, VerifiedRead>()
  for (const message of history) {
    const read = verifyRead(message, readSource)
    if (!read) continue
    reads.set(message, read)
    visibleFiles.set(read.artifactId, read)
  }
  const coveredReads = partial?.coveredReads
  const broadReadCallIds = new Set(coveredReads ? history.flatMap(message => message.toolCalls?.flatMap(call => {
    const args = call.arguments
    return call.name === 'read_file' && args && typeof args === 'object' && !Array.isArray(args)
      && Object.keys(args).every(key => key === 'file_name' || key === 'include_line_numbers')
      && typeof (args as Record<string, unknown>).file_name === 'string' ? [call.id] : []
  }) ?? []) : [])
  const coveredByContent = new Map<string, { read: VerifiedRead; entries: ContextEntryWitness[] }>()
  const readKey = (read: VerifiedRead) => JSON.stringify([read.original.runId, read.meta.hash])
  const repeatedKeys = new Set([...reads.values()].filter(read => read.original.runId
    && broadReadCallIds.has(read.message.toolCallId!)).map(readKey))
  if (coveredReads && repeatedKeys.size) {
    for (const source of coveredReads) {
      const stored = readSource(source.artifactId)
      if (!stored?.runId || !hasActiveFileWitnesses(source, { session: document, project: partial!.project })) continue
      const read = verifyRead(stored.message, () => stored)
      if (read?.artifactId !== source.artifactId) continue
      const key = readKey(read)
      if (repeatedKeys.has(key) && !coveredByContent.has(key)) coveredByContent.set(key, { read, entries: source.entries })
    }
  }
  const partialViews = new Map<LlmMessage, { content: string; entries: ContextEntryWitness[] }>()
  const partialLineProofs = new Map<string, { omitted: ReadonlySet<number>; entries: ContextEntryWitness[] }>()
  const verifiedPartialGroupIds = new Set<string>()
  const verifiedFileAssessmentGroupIds = new Set<string>()
  if (partial?.groups.length) {
    const plans = new Map(partial.groups.flatMap(group => group.files.map(file => [file.artifactId, group] as const)))
    for (const [index, message] of history.entries()) {
      const calls = message.role === 'assistant' ? message.toolCalls : undefined
      if (!calls?.length) continue
      const fileCallIds = new Set(calls.filter(call => call.name === 'read_file').map(call => call.id))
      if (!fileCallIds.size) continue
      const siblings = history.slice(index + 1, index + 1 + calls.length)
        .filter(output => fileCallIds.has(output.toolCallId!)).map(output => reads.get(output))
      if (siblings.length !== fileCallIds.size || siblings.some(read => !read)) continue
      const group = plans.get(siblings[0]!.artifactId)
      if (!group || group.files.length !== siblings.length) continue
      const proposals = siblings.map(read => {
        const proof = group.files.find(file => file.artifactId === read!.artifactId)
        return proof ? projectUnresolvedLines(read!, proof, document, partial) : undefined
      })
      if (proposals.some(proposal => !proposal)) continue
      const canPublish = new Set(siblings.filter((_read, i) => proposals[i]!.hasWitness).map(read => read!.view.result.path)).size >= 2
      if (canPublish || proposals.every(proposal => proposal!.complete)) verifiedFileAssessmentGroupIds.add(group.groupId)
      if (!canPublish) continue
      verifiedPartialGroupIds.add(group.groupId)
      for (const [i, proposal] of proposals.entries()) {
        if (!proposal?.content) continue
        const read = siblings[i]!
        partialViews.set(read.message, { content: proposal.content, entries: proposal.entries })
        partialLineProofs.set(read.artifactId, { omitted: proposal.omitted, entries: proposal.entries })
      }
    }
  }
  const required = new Map<string, ContextEntryWitness>()
  const repeatedReadCallIds = new Set<string>()
  const pageSources = new Map<string, VerifiedRead | undefined>()
  const visiblePages = new Map<string, ReturnType<typeof verifyStoredToolResult>>()
  const publishedPages = new Map<string, PublishedArtifactPage[]>()
  let shortened = false, hasPartialViews = false
  const projected = history.map(message => {
    if (partial?.compactPages && message.name === 'read_runtime_artifact') {
      const page = verifiedFilePage(message, id => {
        if (!pageSources.has(id)) pageSources.set(id, readVerifiedFileArtifact(id, readSource))
        return pageSources.get(id)
      })
      if (!page) return message
      const stored = verifyStoredToolResult(message, readSource)
      if (stored) visiblePages.set(stored.artifactId, stored)
      const historicalLines = partialLineProofs.get(page.read.artifactId)
      if (page.result.mode === 'file_lines' && historicalLines && partial.currentRunId && stored?.original.runId
        && stored.original.runId !== partial.currentRunId) {
        const originalLines: Array<{ line: number; text: string }> = page.result.lines
        const lines = originalLines.filter(line => !historicalLines.omitted.has(line.line))
        const content = JSON.stringify({ ...page.envelope, result: { ...page.result, lines,
          projection: 'historical_file_lines', omittedLineCount: originalLines.length - lines.length,
          contextEntryIds: historicalLines.entries.map(entry => entry.id) } })
        if (Buffer.byteLength(content) < Buffer.byteLength(message.content)) {
          hasPartialViews = true
          for (const entry of historicalLines.entries) required.set(`${entry.scope}:${entry.id}`, entry)
          return { ...message, content }
        }
      }
      if (!page.range) return message
      const prior = publishedPages.get(page.read.artifactId) ?? []
      const segments = pageSegments(page.range, prior)
      if (segments) {
        const { content: _body, ...metadata } = page.result
        const content = JSON.stringify({ ...page.envelope, result: { ...metadata, projection: 'verified_file_page', segments } })
        if (Buffer.byteLength(content) < Buffer.byteLength(message.content)) {
          shortened = true
          return { ...message, content }
        }
      }
      prior.push({ callId: message.toolCallId!, start: page.range.start, end: page.range.start + page.range.content.length })
      publishedPages.set(page.read.artifactId, prior)
      return message
    }
    const read = reads.get(message)
    if (!read) return message
    const { view, envelope } = read
    const { content: _duplicate, ...result } = view.result
    const content = JSON.stringify({ ...envelope, result: {
      ...result, contentRef: { field: 'lines', numbered: view.numbered },
    } })
    const compact = Buffer.byteLength(content) < Buffer.byteLength(message.content) ? content : message.content
    const prior = read.original.runId && broadReadCallIds.has(message.toolCallId!) ? coveredByContent.get(readKey(read)) : undefined
    if (prior && prior.read.original.sequence < read.original.sequence && prior.read.rawContent === read.rawContent) {
      const reference = JSON.stringify({ ...envelope, result: {
        path: result.path, start_line: result.start_line, end_line: result.end_line,
        projection: 'verified_repeat', priorArtifactId: prior.read.artifactId,
        contextEntryIds: prior.entries.map(entry => entry.id),
      } })
      if (Buffer.byteLength(reference) < Buffer.byteLength(compact)) {
        shortened = true
        repeatedReadCallIds.add(message.toolCallId!)
        for (const entry of prior.entries) required.set(`${entry.scope}:${entry.id}`, entry)
        return { ...message, content: reference }
      }
    }
    const unresolved = partialViews.get(message)
    if (unresolved && Buffer.byteLength(unresolved.content) < Buffer.byteLength(compact)) {
      hasPartialViews = true
      for (const entry of unresolved.entries) required.set(`${entry.scope}:${entry.id}`, entry)
      return { ...message, content: unresolved.content }
    }
    if (compact === message.content) return message
    shortened = true
    return { ...message, content }
  })
  const evidence = new Map(document.evidence.map(item => [item.id, item]))
  const visibleCalls = partial?.compactPages ? new Map(history.flatMap(message =>
    message.role === 'tool' && message.toolCallId ? [[message.toolCallId, message] as const] : [])) : undefined
  const bodyReferences = new Map<string, string>()
  const resourceLoadCandidateIds = new Set<string>()
  for (const candidate of document.candidates) {
    if (candidate.status !== 'pending' || candidate.source.actor !== 'tool') continue
    const artifactId = candidate.rawArtifactId
    const file = candidate.source.toolName === 'read_file' ? visibleFiles.get(artifactId) : undefined
    const page = candidate.source.toolName === 'read_runtime_artifact' ? visiblePages.get(artifactId) : undefined
    const resource = candidate.source.toolName === 'load_resources' && candidate.evidenceRefs.length === 1 && !candidate.classification
      ? resourceLoadProof(readSource, artifactId) : undefined
    const otherToolName = candidate.source.toolName
    const stored = visibleCalls && otherToolName && !['read_file', 'read_runtime_artifact', 'load_resources'].includes(otherToolName)
      ? readSource(artifactId) : undefined
    const visible = stored?.message.toolCallId ? visibleCalls?.get(stored.message.toolCallId) : undefined
    const other = visible && visible.name === otherToolName
      ? verifyStoredToolResult(visible, id => id === artifactId ? stored : undefined) : undefined
    const meta = file?.meta ?? page?.meta ?? resource ?? other?.meta
    if (!meta || candidate.normalizedContent !== meta.preview || !candidate.evidenceRefs.some(id => {
      const item = evidence.get(id)
      return item?.kind === 'artifact' && item.referenceId === artifactId && item.sourceHash === meta.hash
        && item.sessionId === document.sessionId
    })) continue
    if (file || page || other) bodyReferences.set(candidate.id, artifactId)
    if (resource) resourceLoadCandidateIds.add(candidate.id)
  }
  return { messages: projected, bodyReferences, resourceLoadCandidateIds,
    hasReferences: shortened || hasPartialViews || bodyReferences.size > 0 || resourceLoadCandidateIds.size > 0,
    hasPartialViews, requiredEntries: [...required.values()], verifiedPartialGroupIds, verifiedFileAssessmentGroupIds, repeatedReadCallIds }
}
