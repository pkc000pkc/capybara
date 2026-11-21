import { randomUUID, createHash } from 'node:crypto'
import { Ajv } from 'ajv'
import { ContextDocumentEngine, type ContextDocumentEngineState, type ApplyReceipt } from '#core/context-document-engine'
import { CONTROL_RECEIPT_TOOLS, ContextHistory, isSuccessfulResourceLoad, type ContextHistoryMessage, type ContextCoverageProposal, type ContextHistoryState,
  type ContextPartialFileGroup, type ContextEntryWitness, type ContextMessageGroup } from '#core/context-history'
import { renderReferencedOrganizerPrompt, renderV2Prompt, V2_CONSTITUTION_PROMPT, v2PromptManifest } from '#core/v2-prompts'
import { expandFileDispositions, expandOrganizationReferences, fileDispositionSchema, organizeReferenceView, parseFileDispositions,
  EXTRACTIVE_ORGANIZATION_SCHEMA, REFERENCED_ORGANIZATION_SCHEMA,
  type FileDispositionProposal, type OrganizationDocumentView, type OrganizationReferenceBinding, type OrganizationModelProposal } from '#core/context-organizer-reference-protocol'
import { readFileExcerpts } from '#core/context-source-excerpts'
import { CONTEXT_CLASSIFICATION_SCHEMA, validateContextClassification, type ContextClassification } from '#core/context-classification'
import type { LlmChatRequest, LlmChatResponse, LlmUsage } from '#util/llm'
import type { HookContextProposal } from '#core/hooks/types'
import { CONTEXT_DIFF_OPERATIONS, CONTEXT_TREE_OPERATIONS } from '#protocol/runtime-protocol'
import { contextTreeProposalError } from '#core/context-document-tree'
import type { ProjectLlmProfile } from '#core/project-resources'

const string = { type: 'string', minLength: 1 }
const strings = { type: 'array', uniqueItems: true, items: string }
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required })

interface OrganizedObservation {
  id: string
  sourceRefs: string[]
  normalizedContent: string
  classification?: ContextClassification
}

type DiffBindingKeys = 'documentId' | 'baseRevision' | 'projectionId' | 'projectionHash'
type OrganizationDiff = HookContextProposal | (Omit<HookContextProposal, DiffBindingKeys | 'operation' | 'sourceObservationId'>
  & { operation: 'add_entry'; sourceObservationId: string } & Partial<Record<DiffBindingKeys, never>>)
const diffBindingKeys: DiffBindingKeys[] = ['documentId', 'baseRevision', 'projectionId', 'projectionHash']

export interface ContextArchiveProposal {
  id: string
  sourceRefs: string[]
  reason: string
}

export interface ContextArchiveRecord extends ContextArchiveProposal {
  scope: 'session'
  sourceMessageIds: string[]
  receiptId: string
  sourceSpans?: Array<{ sourceRef: string; messageId: string; start: number; end: number; sourceHash: string }>
}

export interface OrganizationOutput {
  organizationVersion: 1
  snapshotId: string
  mode: 'organize'
  observations: OrganizedObservation[]
  diffProposals: OrganizationDiff[]
  archiveProposals: ContextArchiveProposal[]
  recallProposals: Array<{ id: string; reason: string }>
  coverageProposal: ContextCoverageProposal | 'auto' | null
  uncertainties: Array<{ statement: string; sourceRefs: string[] }>
}

export const ORGANIZATION_SCHEMA = object({
  organizationVersion: { const: 1 }, snapshotId: string, mode: { const: 'organize' },
  observations: { type: 'array', items: object({ id: string, sourceRefs: { ...strings, minItems: 1 }, normalizedContent: string, classification: CONTEXT_CLASSIFICATION_SCHEMA }, ['id', 'sourceRefs', 'normalizedContent']) },
  diffProposals: { type: 'array', items: { ...object({
    diffVersion: { enum: [1, 2] }, targetNodeId: string, targetNodeHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    title: { ...string, maxLength: 200 }, parentNodeId: string, beforeNodeId: { anyOf: [string, { type: 'null' }] }, childIds: { ...strings, minItems: 2 },
    scope: { enum: ['project', 'session'] }, documentId: string, baseRevision: { type: 'integer', minimum: 0 },
    projectionId: string, projectionHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    sourceObservationId: string, candidateId: string, targetEntryId: string, targetEntryHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, headingPath: strings,
    operation: { enum: [...CONTEXT_DIFF_OPERATIONS] },
    body: { type: 'string' }, status: { enum: ['active', 'superseded', 'archived'] }, evidenceRefs: strings,
    idempotencyKey: string, classification: CONTEXT_CLASSIFICATION_SCHEMA,
  }, ['scope', 'operation', 'idempotencyKey']), anyOf: [
    { required: diffBindingKeys },
    { properties: { operation: { const: 'add_entry' } }, required: ['sourceObservationId'],
      not: { anyOf: diffBindingKeys.map(key => ({ required: [key] })) } },
  ], allOf: [{
    if: { properties: { operation: { enum: [...CONTEXT_TREE_OPERATIONS] } } },
    else: { not: { anyOf: ['targetNodeId', 'targetNodeHash', 'title', 'parentNodeId', 'beforeNodeId', 'childIds'].map(key => ({ required: [key] })) } },
  }] } },
  archiveProposals: { type: 'array', items: object({ id: string, sourceRefs: { ...strings, minItems: 1 }, reason: string }) },
  recallProposals: { type: 'array', items: object({ id: string, reason: string }) },
  coverageProposal: { anyOf: [object({ groupIds: { ...strings, minItems: 1 }, proposalKeys: { ...strings, minItems: 1 }, retainedMessageIds: strings }),
    { const: 'auto' }, { type: 'null' }] },
  uncertainties: { type: 'array', items: object({ statement: string, sourceRefs: strings }) },
})
const validate = new Ajv({ allErrors: true }).compile(ORGANIZATION_SCHEMA)

interface SourceUnit {
  id: string
  messageId: string
  groupId: string
  origin: ContextHistoryMessage['origin']
  sourceArtifactId?: string
  text: string
  start: number
  end: number
  totalCharacters: number
  sourceHash: string
  runtimeReceipt?: unknown
  hostMetadata?: true
  file?: string
  line?: number
}

export interface OrganizationResult {
  id: string
  project: ContextDocumentEngineState
  session: ContextDocumentEngineState
  history: ContextHistoryState
  receipts: ApplyReceipt[]
  archives: ContextArchiveRecord[]
  requests: Array<{ input: LlmChatRequest; output: OrganizationOutput; modelProposal?: OrganizationModelProposal; usage?: LlmUsage;
    supervisionEligible?: false; operationEvidence: Map<string, { sourceId: string; evidenceRefs: string[]; classification?: ContextClassification }> }>
  promptBindings: ReturnType<typeof v2PromptManifest>
  coverageAdvanced: boolean
  partialFileGroupsUpdated?: boolean
}

export interface OrganizerOptions {
  chat: (request: LlmChatRequest, referenceBinding: OrganizationReferenceBinding | undefined, documentView: OrganizationDocumentView) => Promise<LlmChatResponse>
  version?: 1 | 2 | 3 | 4
  project: ContextDocumentEngineState
  session: ContextDocumentEngineState
  history: ContextHistoryState
  runtimeState: unknown
  originalSystemPrompt: string
  fileTaskInstructions?: string
  separateFileDispositions?: boolean
  fileDispositionBatch?: ProjectLlmProfile['file_disposition_batch']
  fileAssessment?: { profileHash: string; verifyGroups: (groups: readonly ContextPartialFileGroup[]) => ReadonlySet<string> }
  archivedSpanReceipt?: (span: Pick<SourceUnit, 'messageId' | 'start' | 'end' | 'sourceHash'>) => string | undefined
  frozenScopes?: readonly string[]
  protectedMessageIds?: string[]
  retainedObservationIds?: ReadonlySet<string>
  maxGroups?: number
  chunkCharacters?: number
  projectionCharacters?: number
  signal?: AbortSignal
  normalize?: (snapshotId: string, sources: readonly SourceUnit[]) => Promise<unknown>
  projectGate: (input: { classification?: ContextClassification; sourceMessage: ContextHistoryMessage; engine: ContextDocumentEngine }) => string | undefined
  projectCandidateGate?: (input: { classification?: ContextClassification; evidenceRefs: string[]; engine: ContextDocumentEngine }) => string | undefined
}

function restore(state: ContextDocumentEngineState): ContextDocumentEngine {
  return new ContextDocumentEngine(state.document, state.receipts, state.projections, state.reviewReceipts, state.evidenceReviewReceipts)
}

function isHostMetadata(message: ContextHistoryMessage, raw: string): boolean {
  if (message.origin === 'runtime') return true
  if (message.message.role === 'assistant' && message.message.toolCalls?.length && !raw.trim()) return true
  return message.origin === 'tool' && (CONTROL_RECEIPT_TOOLS.has(message.message.name ?? '') || isSuccessfulResourceLoad(message.message))
}

export async function organizeContext(options: OrganizerOptions): Promise<OrganizationResult | undefined> {
  const version = options.version ?? 1
  const history = new ContextHistory(options.history)
  const allPending = history.pendingGroups()
  const maxCharacters = Math.max(256, options.chunkCharacters ?? 6000)
  const separateFiles = version === 4 && options.separateFileDispositions && !options.frozenScopes?.includes('session')
  const fileBatch = separateFiles ? options.fileDispositionBatch : undefined
  const fileUnitCost = (unit: { file: string; text: string }) => JSON.stringify(unit.text).length + JSON.stringify(unit.file).length + 64
  const protectedIds = new Set([...(options.protectedMessageIds ?? []), ...options.history.coverage.retainedMessageIds])
  const latestUser = [...options.history.messages].reverse().find(item => item.origin === 'user')?.message.content ?? ''
  const assessmentFingerprint = separateFiles && options.fileAssessment ? createHash('sha256').update(JSON.stringify({
    version, profile: options.fileAssessment.profileHash, user: history.latestUserId(), latestUser,
    instructions: options.fileTaskInstructions ?? options.originalSystemPrompt, frozenScopes: options.frozenScopes ?? [],
    maxCharacters, fileBatch, prompt: v2PromptManifest(['context-organizer']),
  })).digest('hex') : undefined
  const matchingGroups = assessmentFingerprint
    ? (options.history.coverage.partialFileGroups ?? []).filter(group => group.assessmentFingerprint === assessmentFingerprint) : []
  const verifiedGroups = matchingGroups.length ? options.fileAssessment!.verifyGroups(matchingGroups) : undefined
  const reusableGroups = new Map(matchingGroups.filter(group => verifiedGroups?.has(group.groupId)).map(group => [group.groupId, group] as const))
  let selected: ContextMessageGroup[] = []
  let isolatedFileHeaderId: string | undefined
  let isolatedMixedFileGroup = false
  const maxGroups = options.maxGroups ?? 8
  const canReuse = (group: ContextMessageGroup) => {
    const reusable = reusableGroups.get(group.id)
    return reusable?.files.length === group.toolCallIds.length && reusable.files.every(file => group.messageIds.includes(file.messageId))
      && !group.messageIds.some(id => protectedIds.has(id))
  }
  let firstExcluded: number | undefined
  for (const [index, group] of allPending.entries()) {
    if (!group.complete) break
    if (canReuse(group)) continue
    if (selected.length >= maxGroups) { firstExcluded = index; break }
    selected.push(group)
  }
  // File witnesses can commit independently of older history and other tool
  // results in the same group. Coverage still uses the original complete group.
  if (assessmentFingerprint && selected.length) {
    const byId = new Map(options.history.messages.map(message => [message.id, message]))
    const fileGroup = (group: ContextMessageGroup) => {
      if (group.messageIds.some(id => protectedIds.has(id))) return
      const [header, ...results] = group.messageIds.map(id => byId.get(id)!)
      if (header?.message.role !== 'assistant') return
      const callIds = new Set(header.message.toolCalls?.filter(call => call.name === 'read_file').map(call => call.id))
      if (!callIds.size) return
      const reads = results.filter(message => callIds.has(message.message.toolCallId ?? ''))
      if (reads.length !== callIds.size || !reads.every(message => {
        if (message.origin !== 'tool' || message.message.name !== 'read_file' || !message.sourceArtifactId) return false
        const excerpts = readFileExcerpts(message.rawContent ?? message.message.content, fileBatch?.max_characters ?? maxCharacters)
        return excerpts && (!fileBatch || excerpts.every(excerpt => fileUnitCost(excerpt) <= fileBatch.max_characters))
      })) return
      const mixed = results.some(message => !callIds.has(message.message.toolCallId ?? '')
        && !options.retainedObservationIds?.has(message.id)
        && !isHostMetadata(message, message.rawContent ?? message.message.content))
      return { group: mixed ? { ...group, messageIds: [header.id, ...reads.map(message => message.id)],
        toolCallIds: [...callIds] } : group, header, mixed }
    }
    const independentFiles = (group: ContextMessageGroup) => reusableGroups.has(group.id) ? undefined : fileGroup(group)
    let isolated = selected.map(independentFiles).find(item => item !== undefined)
    if (isolated) {
      const fileGroupId = isolated.group.id
      const protectedMessages = new Set([history.latestUserId(), ...options.protectedMessageIds ?? [], ...options.retainedObservationIds ?? []])
      const hasGeneralSources = selected.some(group => {
        if (group.id === fileGroupId || fileGroup(group)?.mixed === false) return false
        return group.messageIds.some(id => {
          const message = byId.get(id)!
          return !protectedMessages.has(id) && !isHostMetadata(message, message.rawContent ?? message.message.content)
        })
      })
      if (!hasGeneralSources && !isolated.mixed && !isolated.header.message.content.trim()) isolated = undefined
    } else if (firstExcluded !== undefined) {
      for (let index = firstExcluded; index < allPending.length; index++) {
        const group = allPending[index]!
        if (!group.complete) break
        isolated = independentFiles(group)
        if (isolated) break
      }
    }
    if (isolated) {
      selected = [isolated.group]
      isolatedFileHeaderId = isolated.header.id
      isolatedMixedFileGroup = isolated.mixed
    }
  }
  if (!selected.length) return undefined
  const sourceMessages = history.messagesFor(selected)
  const sources = new Map(sourceMessages.map((item) => [item.id, item]))
  const units: SourceUnit[] = []
  for (const message of sourceMessages) {
    const raw = message.rawContent ?? message.message.content
    const hostMetadata = isHostMetadata(message, raw)
    const sourceHash = createHash('sha256').update(raw).digest('hex')
    const group = selected.find((item) => item.messageIds.includes(message.id))!
    let runtimeReceipt: unknown
    if (message.message.role === 'tool') {
      try { runtimeReceipt = JSON.parse(message.message.content).runtime_receipt } catch { /* Plain text tool output has no structured receipt. */ }
    }
    const excerpts = version >= 3 && message.origin === 'tool' && message.message.name === 'read_file'
      ? readFileExcerpts(raw, fileBatch?.max_characters ?? maxCharacters) : undefined
    if (excerpts && (!fileBatch || excerpts.every(excerpt => fileUnitCost(excerpt) <= fileBatch.max_characters))) {
      for (const excerpt of excerpts) units.push({
        ...excerpt, id: `${message.id}:span:${excerpt.start}:${excerpt.end}`, messageId: message.id, groupId: group.id,
        origin: message.origin, ...(message.sourceArtifactId ? { sourceArtifactId: message.sourceArtifactId } : {}),
        totalCharacters: raw.length, sourceHash,
      })
      continue
    }
    for (let start = 0; start < Math.max(1, raw.length);) {
      let end = Math.min(raw.length, start + maxCharacters)
      if (end < raw.length && /[\uD800-\uDBFF]/u.test(raw[end - 1] ?? '')) end -= 1
      units.push({ id: `${message.id}:span:${start}:${end}`, messageId: message.id, groupId: group.id, origin: message.origin,
        ...(message.sourceArtifactId ? { sourceArtifactId: message.sourceArtifactId } : {}),
        text: raw.slice(start, end), start, end, totalCharacters: raw.length, sourceHash,
        ...(runtimeReceipt ? { runtimeReceipt } : {}), ...(hostMetadata ? { hostMetadata: true as const } : {}) })
      start = end || 1
    }
  }
  const retainedMessageIds = [...new Set([...(options.protectedMessageIds ?? []), ...(options.retainedObservationIds ?? []),
    ...(history.latestUserId() ? [history.latestUserId()!] : [])])]
  const protectedMessages = new Set(retainedMessageIds)
  const priorArchiveReceipts = new Map<string, string>()
  const unsafeGroups = new Set(selected.filter(group => group.messageIds.some(id => protectedIds.has(id))).map(group => group.id))
  const reusedFileMessages = new Map([...reusableGroups.values()].filter(group => !unsafeGroups.has(group.groupId))
    .flatMap(group => group.files.map(file => [file.messageId, file] as const)))
  const reusedFileEntries = new Map<string, ContextEntryWitness>()
  const modelUnits = units.filter(unit => {
    if (version !== 4) return true
    // Keep assistant commentary in the visible tool group. Its file results can be assessed independently.
    if (unit.hostMetadata || unit.messageId === isolatedFileHeaderId || protectedMessages.has(unit.messageId)) return false
    if (unit.file === undefined || protectedIds.has(unit.messageId)) return true
    const reviewedFile = reusedFileMessages.get(unit.messageId)
    if (reviewedFile && reviewedFile.artifactId === unit.sourceArtifactId && reviewedFile.sourceHash === unit.sourceHash) {
      const proof = reviewedFile.spans.find(span => span.start === unit.start && span.end === unit.end)
      if (proof && 'entry' in proof) reusedFileEntries.set(unit.id, proof.entry)
      else if (proof) priorArchiveReceipts.set(unit.id, proof.archiveReceiptId)
      return false
    }
    const receipt = options.archivedSpanReceipt?.(unit)
    if (!receipt) return true
    // An exact, durable archive remains available through explicit recall when the task changes.
    priorArchiveReceipts.set(unit.id, receipt)
    return false
  })
  const cohorts: SourceUnit[][] = []
  for (const unit of modelUnits) {
    const previous = cohorts.at(-1)
    if (version === 4 && unit.file !== undefined && previous?.[0]?.messageId === unit.messageId) previous.push(unit)
    else cohorts.push([unit])
  }
  const modelPacks: SourceUnit[][] = []
  let packCharacters = 0
  const defaultBatch = { max_spans: version === 4 ? 32 : Number.POSITIVE_INFINITY, max_characters: maxCharacters }
  const limitsFor = (unit: SourceUnit) => unit.file !== undefined && fileBatch ? fileBatch : defaultBatch
  const unitCost = (unit: SourceUnit) => version === 4 && unit.file !== undefined
    ? fileUnitCost({ file: unit.file, text: unit.text }) : unit.text.length + 384
  const addToPacks = (batch: SourceUnit[], cost: number) => {
    const last = modelPacks.at(-1)
    const limits = limitsFor(batch[0]!)
    if (last && (!separateFiles || (last[0]?.file === undefined) === (batch[0]?.file === undefined))
      && packCharacters + cost <= limits.max_characters && last.length + batch.length <= limits.max_spans) {
      last.push(...batch)
      packCharacters += cost
    } else {
      modelPacks.push([...batch])
      packCharacters = cost
    }
  }
  for (const cohort of cohorts) {
    const cost = cohort.reduce((sum, unit) => sum + unitCost(unit), 0)
    const limits = limitsFor(cohort[0]!)
    if (cohort.length === 1 || (cohort.length <= limits.max_spans && cost <= limits.max_characters)) addToPacks(cohort, cost)
    else for (const unit of cohort) addToPacks([unit], unitCost(unit))
  }
  const project = restore(options.project), session = restore(options.session)
  const engines = { project, session }
  const receipts: ApplyReceipt[] = [], archives: ContextArchiveRecord[] = [], requests: OrganizationResult['requests'] = []
  const promptBindings = v2PromptManifest(version === 1 ? ['constitution', 'context-organizer'] : ['context-organizer'])
  const coveredUnits = new Set([...priorArchiveReceipts.keys(), ...reusedFileEntries.keys()]), appliedKeys = new Map<string, string[]>()
  const id = `context-commit-${randomUUID()}`
  let coverage: OrganizationOutput['coverageProposal'] = null
  const contentClaims: Array<{ scope: 'project' | 'session'; entryIds: string[]; sourceRefs: string[] }> = []
  const excerptWitnesses = new Map(reusedFileEntries)
  const deferredUnits = new Set<string>()
  const seenFileGroups = new Set<string>(), splitFileGroups = new Set<string>()
  const lastReadSpan = new Map<string, SourceUnit>(), splitOriginals = new Set<string>()
  const boundaryLines = new Map<string, Set<number>>()
  if (version === 4) for (const pack of modelPacks) {
    const fileUnits = pack.filter(unit => unit.file !== undefined)
    for (const groupId of new Set(fileUnits.map(unit => unit.groupId))) {
      if (seenFileGroups.has(groupId)) splitFileGroups.add(groupId)
      seenFileGroups.add(groupId)
    }
    for (const messageId of new Set(fileUnits.map(unit => unit.messageId))) {
      const portion = fileUnits.filter(unit => unit.messageId === messageId)
      const previous = lastReadSpan.get(messageId)
      if (previous) {
        splitOriginals.add(messageId)
        const lines = boundaryLines.get(messageId) ?? new Set<number>()
        lines.add(previous.line!)
        lines.add(portion[0]!.line!)
        boundaryLines.set(messageId, lines)
      }
      lastReadSpan.set(messageId, portion.at(-1)!)
    }
  }
  type ArchiveReview = OrganizationResult['requests'][number] & { modelProposal: FileDispositionProposal }
  type ArchiveCandidates = { sources: readonly string[]; candidates: ReadonlySet<string> }
  type PendingWindow = ArchiveCandidates & { messageId: string; review: () => Promise<ArchiveReview> }
  type PartialWholeRead = ArchiveCandidates & { groupId: string; review: ArchiveReview }
  const splitReviews: Array<PendingWindow & { initialOutput: OrganizationOutput }> = []
  const partialWholeReads: Array<PartialWholeRead & { initialOutput: OrganizationOutput }> = []
  const unitIndex = new Map(units.map(unit => [unit.id, unit]))
  const stageArchive = (archive: ContextArchiveProposal) => {
    const spans = archive.sourceRefs.map(sourceRef => unitIndex.get(sourceRef)!)
    const receiptId = `archive-receipt-${randomUUID()}`
    archives.push({ ...archive, id: `archive-${randomUUID()}`, scope: 'session',
      sourceMessageIds: [...new Set(spans.map(unit => unit.messageId))], receiptId,
      sourceSpans: spans.map(unit => ({ sourceRef: unit.id, messageId: unit.messageId, start: unit.start, end: unit.end, sourceHash: unit.sourceHash })) })
    appliedKeys.set(archive.id, [receiptId])
    spans.forEach(unit => coveredUnits.add(unit.id))
  }
  for (const [packIndex, pack] of modelPacks.entries()) {
    if (options.signal?.aborted) throw new Error('CONTEXT_ORGANIZATION_ABORTED')
    const snapshotId = `${id}:snapshot:${packIndex}`
    const maxCharacters = options.projectionCharacters ?? 6000
    const projectProjection = project.project({ id: snapshotId, maxCharacters, includeSections: ['information', 'candidates'], includeTools: false, includeStructure: true })
    const documents = { project: project.snapshot(), session: session.snapshot() }
    const offeredFiles = new Set(pack.filter(unit => unit.file !== undefined).map(unit => unit.sourceArtifactId))
    const excludeCandidateIds = documents.session.candidates.filter(candidate => candidate.source.actor === 'tool'
      && candidate.status === 'pending' && offeredFiles.has(candidate.rawArtifactId)).map(candidate => candidate.id)
    const sessionProjection = session.project({ id: snapshotId, maxCharacters,
      includeSections: ['information', 'candidates'], includeTools: false, includeStructure: true, excludeCandidateIds })
    const bindings = { project: { documentId: documents.project.id, baseRevision: projectProjection.documentRevision, projectionId: projectProjection.id, projectionHash: projectProjection.contentHash },
      session: { documentId: documents.session.id, baseRevision: sessionProjection.documentRevision, projectionId: sessionProjection.id, projectionHash: sessionProjection.contentHash } }
    const unprotected = pack.filter(unit => !unit.hostMetadata && !protectedMessages.has(unit.messageId))
    const packVersion = version !== 4 ? version
      : unprotected.length && unprotected.every(unit => unit.file !== undefined) && !options.frozenScopes?.includes('session') ? 4 : 3
    const canFold = packIndex === modelPacks.length - 1
    const normalization = options.normalize && packVersion !== 4 ? await options.normalize(snapshotId, pack) : undefined
    const documentViews = { project: { document: documents.project, projection: projectProjection, binding: bindings.project },
      session: { document: documents.session, projection: sessionProjection, binding: bindings.session } }
    const offeredUnits = packVersion === 4 ? unprotected : pack
    const sourceView = packVersion !== 1 ? offeredUnits.map(unit => ({ id: unit.id, origin: unit.origin,
      text: unit.hostMetadata ? '' : unit.text, ...(unit.hostMetadata ? { hostMetadata: true } : {}),
      ...(unit.file !== undefined ? { file: unit.file, line: unit.line! } : {}),
      ...(protectedMessages.has(unit.messageId) ? { protected: true } : {}),
    })) : []
    const referenced = packVersion !== 1 ? organizeReferenceView({ snapshotId, version: packVersion, sources: sourceView, documents: documentViews,
      canFold, task: { instructions: packVersion === 4 ? options.fileTaskInstructions ?? options.originalSystemPrompt : options.originalSystemPrompt,
        latestUser, frozenScopes: options.frozenScopes ?? [], ...(packVersion === 4 && separateFiles ? { prefixCacheScope: id } : {}) }, normalization,
    }) : undefined
    const input = referenced?.input ?? {
      organizationVersion: 1, snapshotId, mode: 'organize', bindings, sources: pack,
      ...(options.normalize ? { normalizationSuggestions: normalization } : {}),
      coverageGroups: selected, canProposeCoverage: canFold,
      previousProposalKeys: [...appliedKeys.keys()], retainedMessageIds,
      instructions: 'Use sources[].id as sourceRefs. New entries with sourceObservationId inherit the scope binding and normalizedContent. Copy the scope binding for other diffs. Prefix proposal keys with snapshotId plus a colon. On the final pack use coverageProposal="auto" to let the host calculate coverage. No disposition is needed for hostMetadata or retainedMessageIds.',
    }
    const prompt = referenced ? renderReferencedOrganizerPrompt(
      packVersion === 4 ? fileDispositionSchema(sourceView.length)
        : packVersion === 3 ? EXTRACTIVE_ORGANIZATION_SCHEMA : REFERENCED_ORGANIZATION_SCHEMA,
      packVersion === 1 ? 2 : packVersion,
    ) : `${V2_CONSTITUTION_PROMPT}\n\n${renderV2Prompt('context-organizer', {
      organization_binding_and_mode: { organizationVersion: 1, snapshotId, mode: 'organize' },
      organization_output_schema: ORGANIZATION_SCHEMA,
      supported_operations: { operations: [...CONTEXT_DIFF_OPERATIONS], diffVersions: { content: 1, structure: 2 } },
      project_context_projection: { ...bindings.project, markdown: projectProjection.markdown },
      session_context_projection: { ...bindings.session, markdown: sessionProjection.markdown },
      raw_observations_and_recall_candidates: 'The separate input JSON contains exact bounded source spans; no recall candidates are offered in this mode.',
      task_system_prompt_and_messages_as_data: { system_prompt: options.originalSystemPrompt, latestUserMessage: latestUser },
      readonly_runtime_state_and_coverage_groups: { runtime_state: options.runtimeState, coverageGroups: selected },
    })}`
    const request: LlmChatRequest = { messages: [{ role: 'system', content: prompt }, { role: 'user', content: JSON.stringify(input) }], responseFormat: 'json', signal: options.signal, maxTokens: 4096 }
    const documentView: OrganizationDocumentView = packVersion === 4 ? { format: 'none' }
      : { format: referenced ? 'references' : 'markdown', maxCharacters, bindings }
    const response = await options.chat(request, referenced?.binding, documentView)
    if (response.toolCalls?.length) throw new Error('CONTEXT_ORGANIZATION_TOOL_INTENT_FORBIDDEN')
    if (response.finishReason === 'length' || response.finishReason === 'incomplete') throw new Error('CONTEXT_ORGANIZATION_OUTPUT_TRUNCATED')
    const value: unknown = JSON.parse(response.text)
    const archiveChecks: OrganizationResult['requests'] = []
    const pendingWindows: PendingWindow[] = []
    const pendingWholeReads: PartialWholeRead[] = []
    let overwrittenDisposition = false
    let expanded: { output: OrganizationOutput; proposal: OrganizationModelProposal } | undefined
    if (referenced && packVersion === 4) {
      const initial = parseFileDispositions(value, referenced.binding, sourceView.length)
      // Split reads stay visible until a same-read witness and a separate window review are available.
      const choices = initial.choices.map((choice, index) =>
        choice === 'A' && splitOriginals.has(offeredUnits[index]!.messageId) ? 'R' : choice)
      const byOriginal = new Map<string, number[]>()
      for (const [index, unit] of offeredUnits.entries()) {
        const previous = byOriginal.get(unit.messageId) ?? []
        previous.push(index)
        byOriginal.set(unit.messageId, previous)
      }
      const reviewArchive = async (messageId: string, positions: number[], window = false): Promise<ArchiveReview> => {
        const view = organizeReferenceView({ snapshotId: `${snapshotId}:archive:${messageId}`, version: 4,
          sources: positions.map(index => sourceView[index]!), documents: documentViews, canFold: false,
          task: { ...referenced.input.task, archiveReview: true, ...(window ? { archiveReviewScope: 'window' as const } : {}) },
        })
        const reviewInput: LlmChatRequest = { ...request, messages: [
          { role: 'system', content: renderReferencedOrganizerPrompt(fileDispositionSchema(positions.length), 4, true) },
          { role: 'user', content: JSON.stringify(view.input) },
        ] }
        const review = await options.chat(reviewInput, view.binding, { format: 'none' })
        if (review.toolCalls?.length || review.finishReason === 'length' || review.finishReason === 'incomplete') {
          throw new Error('CONTEXT_ORGANIZATION_FILE_ARCHIVE_REVIEW_INCOMPLETE')
        }
        const checked = parseFileDispositions(JSON.parse(review.text), view.binding, positions.length)
        return { input: reviewInput, modelProposal: checked, operationEvidence: new Map(),
          output: { organizationVersion: 1, mode: 'organize', snapshotId: view.binding.snapshotId, observations: [], diffProposals: [],
            archiveProposals: [], recallProposals: [], uncertainties: [], coverageProposal: null },
          ...(review.usage ? { usage: review.usage } : {}),
        }
      }
      for (const [messageId, positions] of byOriginal) {
        if (splitOriginals.has(messageId)) {
          if (fileBatch) {
            const boundaries = boundaryLines.get(messageId)!
            const candidates = new Set(positions.filter(index => initial.choices[index] === 'A'
              && !boundaries.has(offeredUnits[index]!.line!)).map(index => offeredUnits[index]!.id))
            if (candidates.size) pendingWindows.push({ messageId, candidates, sources: positions.map(index => sourceView[index]!.id),
              review: () => reviewArchive(messageId, positions, true) })
          }
          continue
        }
        if (!positions.every(index => choices[index] === 'A')) continue
        const checked = await reviewArchive(messageId, positions)
        if (checked.modelProposal.choices.some(choice => choice !== 'A')) {
          positions.forEach(position => { choices[position] = 'R' })
          if (fileBatch && checked.modelProposal.choices.includes('A')) {
            const sources = positions.map(index => offeredUnits[index]!.id)
            pendingWholeReads.push({ groupId: offeredUnits[positions[0]!]!.groupId, sources, candidates: new Set(sources), review: checked })
          }
        }
        archiveChecks.push(checked)
      }
      overwrittenDisposition = choices.some((choice, index) => choice !== initial.choices[index])
      const evidence = new Map(documents.session.evidence.map(item => [item.id, item]))
      const duplicates = new Map<string, string>()
      for (const unit of offeredUnits) {
        const entry = documents.session.information.find(item => item.status === 'active' && item.body === unit.text
          && item.evidenceRefs.some(id => {
            const ref = evidence.get(id)
            return ref?.referenceId === (unit.sourceArtifactId ?? unit.messageId)
              && ref.sourceHash === unit.sourceHash && ref.locator === `characters:${unit.start}:${unit.end}`
          }))
        if (entry) duplicates.set(unit.id, entry.id)
      }
      expanded = { ...expandFileDispositions({ ...initial, choices }, referenced.binding, sourceView, documentViews, canFold, duplicates), proposal: initial }
    } else if (referenced) expanded = expandOrganizationReferences(value, referenced.binding, sourceView, documentViews)
    const output: unknown = expanded?.output ?? value
    if (!validate(output)) throw new Error(`CONTEXT_ORGANIZATION_SCHEMA: ${validate.errors?.map((item) => `${item.instancePath} ${item.message}`).join('; ')}`)
    const result = output as unknown as OrganizationOutput
    if (result.snapshotId !== snapshotId || result.mode !== 'organize') throw new Error('CONTEXT_ORGANIZATION_BINDING_MISMATCH')
    if (!canFold && result.coverageProposal) throw new Error('CONTEXT_ORGANIZATION_PREMATURE_COVERAGE')
    if (result.recallProposals.length) throw new Error('CONTEXT_ORGANIZATION_UNKNOWN_RECALL')
    const knownUnits = new Map(pack.map((unit) => [unit.id, unit]))
    const operationEvidence: OrganizationResult['requests'][number]['operationEvidence'] = new Map()
    const observed = new Map<string, { candidateId: string; sourceRefs: string[]; scope: 'project' | 'session' }>()
    const touchedEntries = new Set<string>()
    const observationIds = new Set<string>()
    for (const observation of result.observations) {
      if (observationIds.has(observation.id)) throw new Error('CONTEXT_ORGANIZATION_DUPLICATE_OBSERVATION')
      observationIds.add(observation.id)
      if (observation.sourceRefs.some((ref) => !knownUnits.has(ref))) throw new Error('CONTEXT_ORGANIZATION_UNKNOWN_SOURCE')
      if (observation.classification) validateContextClassification(observation.classification)
    }
    // Each source observation is bound to its actual raw span by the host. The
    // model cannot invent origin, timestamps, source IDs, evidence or receipts.
    for (const proposal of result.diffProposals) {
      const binding = bindings[proposal.scope]
      const snapshotBoundAdd = proposal.operation === 'add_entry' && proposal.sourceObservationId
        && diffBindingKeys.every(key => proposal[key] === undefined)
      if (!binding || (!snapshotBoundAdd && diffBindingKeys.some(key => proposal[key] !== binding[key]))) {
        throw new Error('CONTEXT_ORGANIZATION_DIFF_BINDING_MISMATCH')
      }
      if (!proposal.idempotencyKey.startsWith(`${snapshotId}:`)) throw new Error('CONTEXT_ORGANIZATION_PROPOSAL_NAMESPACE_INVALID')
      if (appliedKeys.has(proposal.idempotencyKey)) throw new Error('CONTEXT_ORGANIZATION_DUPLICATE_PROPOSAL')
      const originalProjection = proposal.scope === 'project' ? projectProjection : sessionProjection
      const structural = (CONTEXT_TREE_OPERATIONS as readonly string[]).includes(proposal.operation)
      const structurePayload = { ...(proposal.title !== undefined ? { title: proposal.title } : {}), ...(proposal.parentNodeId !== undefined ? { parentNodeId: proposal.parentNodeId } : {}),
        ...(proposal.beforeNodeId !== undefined ? { beforeNodeId: proposal.beforeNodeId } : {}), ...(proposal.childIds !== undefined ? { childIds: proposal.childIds } : {}),
        ...(proposal.body !== undefined ? { body: proposal.body } : {}), ...(proposal.status !== undefined ? { status: proposal.status } : {}) }
      if (structural) {
        const error = contextTreeProposalError({ ...proposal, target: { nodeId: proposal.targetNodeId, entryId: proposal.targetEntryId, headingPath: proposal.headingPath }, payload: structurePayload }, originalProjection.treeNodes)
        if (error) throw new Error(error)
      }
      if (proposal.candidateId && !originalProjection.sourceCandidateIds.includes(proposal.candidateId)) throw new Error('CONTEXT_ORGANIZATION_CANDIDATE_NOT_PROJECTED')
      if (proposal.targetEntryId) {
        if (!originalProjection.sourceEntryIds.includes(proposal.targetEntryId)) throw new Error('CONTEXT_ORGANIZATION_ENTRY_NOT_PROJECTED')
        if (touchedEntries.has(proposal.targetEntryId)) throw new Error('CONTEXT_ORGANIZATION_DUPLICATE_TARGET')
        touchedEntries.add(proposal.targetEntryId)
      }
      const engine = engines[proposal.scope]
      let candidateId = proposal.candidateId
      let sourceRefs: string[] = []
      if (proposal.sourceObservationId) {
        const observation = result.observations.find((item) => item.id === proposal.sourceObservationId)
        if (!observation || candidateId) throw new Error('CONTEXT_ORGANIZATION_OBSERVATION_REFERENCE_INVALID')
        const key = `${proposal.scope}:${observation.id}`
        const existing = observed.get(key)
        if (existing) candidateId = existing.candidateId
        else {
          const firstUnit = knownUnits.get(observation.sourceRefs[0]!)!
          const message = sources.get(firstUnit.messageId)!
          const classification = proposal.classification ?? observation.classification
          if (proposal.scope === 'project') {
            if (!['tool', 'user'].includes(message.origin)) throw new Error('PROJECT_SOURCE_NOT_AUTHORITATIVE')
            const error = options.projectGate({ classification, sourceMessage: message, engine })
            if (error) throw new Error(error)
          }
          const evidenceRefs = observation.sourceRefs.map((ref) => {
            const unit = knownUnits.get(ref)!
            return engine.addEvidence({ kind: unit.origin === 'user' ? 'message' : unit.sourceArtifactId ? 'artifact' : 'observation', referenceId: unit.sourceArtifactId ?? unit.messageId, sessionId: options.session.document.sessionId, sourceHash: unit.sourceHash,
              locator: `characters:${unit.start}:${unit.end}`, observedAt: sources.get(unit.messageId)!.capturedAt, confidence: 'medium' }).id
          })
          const candidate = engine.addCandidate({ source: { actor: message.origin === 'tool' ? 'tool' : message.origin === 'user' ? 'user' : message.origin === 'model' ? 'model' : 'system', sourceId: message.id, capturedAt: message.capturedAt, ...(message.runId ? { runId: message.runId } : {}) },
            rawArtifactId: message.sourceArtifactId ?? message.id, normalizedContent: observation.normalizedContent, evidenceRefs,
            ...(classification ? { classification } : {}) })
          candidateId = candidate.id
          observed.set(key, { candidateId, sourceRefs: observation.sourceRefs, scope: proposal.scope })
        }
        sourceRefs = observation.sourceRefs
      }
      if (!candidateId) throw new Error('CONTEXT_ORGANIZATION_CANDIDATE_REQUIRED')
      const candidate = engine.snapshot().candidates.find((item) => item.id === candidateId)
      if (!candidate) throw new Error('CONTEXT_ORGANIZATION_CANDIDATE_UNKNOWN')
      if (proposal.scope === 'project') {
        const error = options.projectCandidateGate?.({ classification: proposal.classification ?? candidate.classification, evidenceRefs: candidate.evidenceRefs, engine })
        if (error) throw new Error(error)
      }
      const current = engine.project({ id: `${snapshotId}:apply`, maxCharacters: 10_000_000, includeStructure: true, includeStatuses: ['pending', 'accepted', 'conflict'], includeSections: ['information', 'candidates'] })
      const observationBody = proposal.operation === 'add_entry' && proposal.sourceObservationId && proposal.body === undefined
        ? candidate.normalizedContent : undefined
      const receipt = engine.apply(engine.propose({ projection: current, candidateId, target: { section: 'information',
        ...(proposal.targetNodeId ? { nodeId: proposal.targetNodeId } : {}),
        ...(proposal.targetEntryId ? { entryId: proposal.targetEntryId } : {}), ...(proposal.headingPath ? { headingPath: proposal.headingPath } : {}) },
        ...(proposal.diffVersion !== undefined ? { diffVersion: proposal.diffVersion } : {}), ...(proposal.targetNodeHash ? { targetNodeHash: proposal.targetNodeHash } : {}),
        operation: proposal.operation, payload: { ...structurePayload, ...(observationBody === undefined ? {} : { body: observationBody }),
          evidenceRefs: proposal.evidenceRefs ?? candidate.evidenceRefs, ...(proposal.classification ? { classification: proposal.classification } : {}) },
        ...(proposal.targetEntryHash ? { targetEntryHash: proposal.targetEntryHash } : {}), actor: 'model', idempotencyKey: proposal.idempotencyKey }))
      if (receipt.result !== 'applied') throw new Error(receipt.errorCode ?? 'CONTEXT_ORGANIZATION_DIFF_REJECTED')
      operationEvidence.set(proposal.idempotencyKey, { sourceId: candidate.source.sourceId,
        evidenceRefs: proposal.evidenceRefs ?? candidate.evidenceRefs, classification: proposal.classification ?? candidate.classification })
      receipts.push(receipt)
      appliedKeys.set(proposal.idempotencyKey, [receipt.id])
      const writesBody = proposal.operation === 'add_entry'
        || (proposal.operation === 'replace_body' && typeof proposal.body === 'string')
      const linksExactDuplicate = proposal.operation === 'append_evidence'
        && documents[proposal.scope].information.find(entry => entry.id === proposal.targetEntryId)?.body === candidate.normalizedContent
      if (sourceRefs.length && (writesBody || linksExactDuplicate)) {
        contentClaims.push({ scope: proposal.scope, entryIds: receipt.changedEntryIds, sourceRefs })
      }
    }
    for (const archive of result.archiveProposals) {
      if (!archive.id.startsWith(`${snapshotId}:`) || archive.sourceRefs.some((ref) => !knownUnits.has(ref)) || appliedKeys.has(archive.id)) throw new Error('CONTEXT_ORGANIZATION_ARCHIVE_INVALID')
      const sourceRefs = archive.sourceRefs.filter(ref => packVersion === 4
        ? !splitOriginals.has(knownUnits.get(ref)!.messageId) : !splitFileGroups.has(knownUnits.get(ref)!.groupId))
      if (sourceRefs.length !== archive.sourceRefs.length) {
        archive.sourceRefs.filter(ref => !sourceRefs.includes(ref)).forEach(ref => deferredUnits.add(ref))
        overwrittenDisposition = true
      }
      if (sourceRefs.length) stageArchive({ ...archive, sourceRefs })
    }
    if (packVersion >= 3) result.uncertainties.forEach(item => item.sourceRefs.forEach(ref => deferredUnits.add(ref)))
    requests.push({ input: request, output: result, operationEvidence, ...(expanded ? { modelProposal: expanded.proposal } : {}),
      ...(overwrittenDisposition ? { supervisionEligible: false as const } : {}), ...(response.usage ? { usage: response.usage } : {}) }, ...archiveChecks)
    pendingWindows.forEach(window => splitReviews.push({ ...window, initialOutput: result }))
    pendingWholeReads.forEach(read => partialWholeReads.push({ ...read, initialOutput: result }))
    coverage = result.coverageProposal
  }
  if (coverage || version === 4) {
    const witnesses = (['project', 'session'] as const).map(scope => {
      const document = engines[scope].snapshot()
      return [scope, {
        entries: new Map(document.information.filter(entry => entry.status === 'active' && entry.body.trim()).map(entry => [entry.id, entry])),
        evidence: new Map(document.evidence.map(evidence => [evidence.id, evidence])),
      }] as const
    })
    const byScope = new Map(witnesses)
    for (const claim of contentClaims) {
      const { entries, evidence } = byScope.get(claim.scope)!
      for (const sourceRef of claim.sourceRefs) {
        const span = unitIndex.get(sourceRef)!
        const entry = claim.entryIds.map(id => entries.get(id)).find(entry => entry?.evidenceRefs.some(id => {
          const ref = evidence.get(id)
          return ref?.referenceId === (span.sourceArtifactId ?? span.messageId)
            && ref.sourceHash === span.sourceHash && ref.locator === `characters:${span.start}:${span.end}`
        }))
        if (entry) {
          coveredUnits.add(sourceRef)
          if (span.file !== undefined) excerptWitnesses.set(sourceRef,
            { scope: claim.scope, id: entry.id, bodyHash: createHash('sha256').update(entry.body).digest('hex') })
        }
      }
    }
  }
  const confirmReviewedArchive = (review: ArchiveReview, plan: ArchiveCandidates & { initialOutput: OrganizationOutput },
    reason: string, permitted: boolean) => {
    const agreed = review.modelProposal.choices.flatMap((choice, index) => choice === 'A' ? [plan.sources[index]!] : [])
    const sourceRefs = permitted ? agreed.filter(ref => plan.candidates.has(ref)) : []
    if (sourceRefs.length) {
      const archive = { id: `${review.output.snapshotId}:confirmed`, sourceRefs, reason }
      stageArchive(archive)
      review.output.archiveProposals.push(archive)
      const accepted = new Set(sourceRefs)
      sourceRefs.forEach(ref => deferredUnits.delete(ref))
      plan.initialOutput.uncertainties = plan.initialOutput.uncertainties.flatMap(item => {
        const remaining = item.sourceRefs.filter(ref => !accepted.has(ref))
        return remaining.length ? [{ ...item, sourceRefs: remaining }] : []
      })
    }
    if (agreed.length !== sourceRefs.length) review.supervisionEligible = false
  }
  const witnessedUnits = [...excerptWitnesses.keys()].map(ref => unitIndex.get(ref)!)
  const witnessedOriginals = new Set(witnessedUnits.map(unit => unit.messageId))
  for (const window of splitReviews) {
    if (options.signal?.aborted) throw new Error('CONTEXT_ORGANIZATION_ABORTED')
    if (!witnessedOriginals.has(window.messageId)) continue
    const review = await window.review()
    confirmReviewedArchive(review, window, '原件有活跃正文承接，窗口初筛与复核均判定该片段无关', true)
    requests.push(review)
  }
  for (const read of partialWholeReads) {
    const siblingFiles = new Set(witnessedUnits.filter(unit => unit.groupId === read.groupId).map(unit => unit.file))
    confirmReviewedArchive(read.review, read, '两份同组原件有活跃正文承接，初筛与整份复核均判定该片段无关', siblingFiles.size >= 2)
  }
  deferredUnits.forEach(ref => coveredUnits.delete(ref))
  if (isolatedMixedFileGroup) coverage = null
  if (coverage === 'auto') {
    const retained = new Set([...history.coverageSnapshot().retainedMessageIds, ...retainedMessageIds])
    const groupIds: string[] = [], metadataRefs: string[] = []
    let foldableGroup = false
    const selectedIds = new Set(selected.map(group => group.id))
    for (const group of allPending) {
      if (!selectedIds.has(group.id)) break
      const groupUnits = units.filter(unit => unit.groupId === group.id)
      const retainGroup = group.messageIds.some(messageId => retained.has(messageId))
      if (!retainGroup && groupUnits.some(unit => !coveredUnits.has(unit.id) && !unit.hostMetadata)) break
      if (version === 4) {
        const files = groupUnits.filter(unit => unit.file !== undefined)
        const witnessed = files.filter(unit => excerptWitnesses.has(unit.id))
        if (files.length && !witnessed.length) break
        const witnessedReads = new Set(witnessed.map(unit => unit.messageId))
        const wholeReadArchived = files.some(unit => !witnessedReads.has(unit.messageId))
        if (!retainGroup && wholeReadArchived && new Set(witnessed.map(unit => unit.file)).size < 2) break
      }
      groupIds.push(group.id)
      if (retainGroup) {
        group.messageIds.forEach(messageId => retained.add(messageId))
        continue
      }
      foldableGroup = true
      metadataRefs.push(...groupUnits.filter(unit => unit.hostMetadata && !coveredUnits.has(unit.id)).map(unit => unit.id))
    }
    if (foldableGroup && appliedKeys.size > 0) {
      // These original spans remain durably recallable like other source archives.
      if (metadataRefs.length) stageArchive({ id: `${id}:host:metadata`, sourceRefs: metadataRefs, reason: '宿主保留控制轨迹、空工具调用和能力记录' })
      coverage = { groupIds, retainedMessageIds: [...retained], proposalKeys: [...appliedKeys.keys()] }
    } else coverage = null
  }
  const previousCoverage = history.coverageSnapshot()
  const partialGroups = new Map((previousCoverage.partialFileGroups ?? []).map(group => [group.groupId, group]))
  if (version === 4) {
    const folded = new Set(coverage?.groupIds ?? [])
    const archivesBySpan = new Map([...priorArchiveReceipts, ...archives.flatMap(archive => archive.sourceRefs.map(ref => [ref, archive.receiptId] as const))])
    const protectedIds = new Set([...previousCoverage.retainedMessageIds, ...retainedMessageIds])
    for (const group of selected) {
      partialGroups.delete(group.id)
      if (!group.toolCallIds.length || folded.has(group.id) || group.messageIds.some(id => protectedIds.has(id))) continue
      const header = sources.get(group.messageIds[0]!)
      const callIds = new Set(header?.message.toolCalls?.filter(call => call.name === 'read_file').map(call => call.id))
      const groupUnits = units.filter(unit => unit.groupId === group.id && unit.file !== undefined && unit.sourceArtifactId
        && callIds.has(sources.get(unit.messageId)?.message.toolCallId ?? ''))
      const byRead = new Map<string, SourceUnit[]>()
      for (const unit of groupUnits) {
        const read = byRead.get(unit.messageId) ?? []
        read.push(unit)
        byRead.set(unit.messageId, read)
      }
      if (!byRead.size || byRead.size !== callIds.size) continue
      const witnessedFiles = new Set(groupUnits.filter(unit => coveredUnits.has(unit.id) && excerptWitnesses.has(unit.id)).map(unit => unit.file))
      const fullyAssessed = assessmentFingerprint && groupUnits.every(unit => coveredUnits.has(unit.id)
        && (excerptWitnesses.has(unit.id) || archivesBySpan.has(unit.id)))
      if (witnessedFiles.size < 2 && !fullyAssessed) continue
      const files: ContextPartialFileGroup['files'] = [...byRead.values()].map(read => ({
        artifactId: read[0]!.sourceArtifactId!, messageId: read[0]!.messageId, sourceHash: read[0]!.sourceHash,
        spans: read.filter(unit => coveredUnits.has(unit.id)).flatMap<ContextPartialFileGroup['files'][number]['spans'][number]>(unit => {
          const entry = excerptWitnesses.get(unit.id), archiveReceiptId = archivesBySpan.get(unit.id)
          return entry ? [{ start: unit.start, end: unit.end, entry }] : archiveReceiptId ? [{ start: unit.start, end: unit.end, archiveReceiptId }] : []
        }),
      }))
      partialGroups.set(group.id, { groupId: group.id, files, ...(assessmentFingerprint ? { assessmentFingerprint } : {}) })
    }
  }
  const partialFileGroups = [...partialGroups.values()]
  const partialFileGroupsUpdated = JSON.stringify(partialFileGroups) !== JSON.stringify(previousCoverage.partialFileGroups ?? [])
  if (!coverage) {
    const snapshot = history.snapshot()
    if (partialFileGroupsUpdated) snapshot.coverage.partialFileGroups = partialFileGroups
    return { id, project: project.exportState(), session: session.exportState(), history: snapshot, receipts, archives, requests,
      promptBindings, coverageAdvanced: false, ...(partialFileGroupsUpdated ? { partialFileGroupsUpdated } : {}) }
  }
  const retained = new Set(coverage.retainedMessageIds)
  const coveredGroups = new Set(coverage.groupIds)
  for (const unit of units.filter((unit) => coveredGroups.has(unit.groupId))) {
    if (!coveredUnits.has(unit.id) && !retained.has(unit.messageId)) throw new Error('CONTEXT_ORGANIZATION_SOURCE_UNCOVERED')
  }
  if (coverage.proposalKeys.some((key) => !appliedKeys.has(key))) throw new Error('CONTEXT_ORGANIZATION_RECEIPT_UNKNOWN')
  const acceptedReceiptIds = [...appliedKeys.values()].flat()
  const nextCoverage = history.proposeCoverage(coverage, id, acceptedReceiptIds, options.protectedMessageIds)
  const required = new Set([...receipts.flatMap(receipt => receipt.changedEntryIds), ...units.flatMap(unit => {
    const witness = coveredGroups.has(unit.groupId) ? excerptWitnesses.get(unit.id) : undefined
    return witness ? [witness.id] : []
  })])
  const previousRequired = previousCoverage.requiredEntries ?? []
  nextCoverage.requiredEntries = (['project', 'session'] as const).flatMap((scope) => engines[scope].snapshot().information
    .filter((entry) => entry.status === 'active' && (required.has(entry.id) || previousRequired.some((item) => item.scope === scope && item.id === entry.id)))
    .map((entry) => ({ scope, id: entry.id })))
  const excerptSources = new Map((previousCoverage.excerptSources ?? []).map(source => [source.artifactId, source]))
  const foldedFiles = new Map<string, Map<string, ContextEntryWitness>>()
  for (const unit of units) {
    if (unit.file === undefined || !unit.sourceArtifactId || !coveredGroups.has(unit.groupId) || retained.has(unit.messageId)) continue
    const entries = foldedFiles.get(unit.sourceArtifactId) ?? new Map<string, ContextEntryWitness>()
    const witness = excerptWitnesses.get(unit.id)
    if (witness) entries.set(witness.id, witness)
    foldedFiles.set(unit.sourceArtifactId, entries)
  }
  for (const [artifactId, entries] of foldedFiles) excerptSources.set(artifactId, { artifactId, entries: [...entries.values()] })
  if (excerptSources.size) nextCoverage.excerptSources = [...excerptSources.values()]
  if (partialFileGroups.length) nextCoverage.partialFileGroups = partialFileGroups
  history.confirmCoverage(nextCoverage)
  return { id, project: project.exportState(), session: session.exportState(), history: history.snapshot(), receipts, archives, requests,
    promptBindings, coverageAdvanced: true }
}
