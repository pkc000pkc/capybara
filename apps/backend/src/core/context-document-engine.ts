import { createHash, randomUUID } from 'node:crypto'
import { validateContextClassification, type ContextClassification } from '#core/context-classification'
import { CONTEXT_DIFF_OPERATIONS, CONTEXT_TREE_OPERATIONS, type RuntimeContextDiffOperation, type RuntimeContextDiffPayload, type RuntimeContextTree, type RuntimeContextTreeBinding } from '#protocol/runtime-protocol'
import { applyContextTreeOperation, contextTreeBindings, contextTreeHashes, contextTreeOrder, contextTreeProposalError, insertContextEntry, insertContextSuccessor, legacyContextTree, validateContextTree } from '#core/context-document-tree'

export type ContextSectionKind = 'system' | 'tools' | 'information' | 'candidates' | 'messages'
export type CandidateActor = 'user' | 'tool' | 'model' | 'system' | 'child-agent' | 'memory'
export type CandidateStatus = 'pending' | 'accepted' | 'rejected' | 'conflict' | 'stale' | 'irrelevant' | 'superseded'
export type CandidateReviewStatus = Exclude<CandidateStatus, 'pending'>

export interface CandidateSource {
  actor: CandidateActor
  sourceId: string
  toolName?: string
  runId?: string
  stepId?: string
  capturedAt: string
}

export interface EvidenceRef {
  id: string
  kind: 'observation' | 'artifact' | 'message' | 'external'
  referenceId: string
  sessionId?: string
  sourceHash?: string
  observedAt?: string
  locator?: string
  confidence?: 'low' | 'medium' | 'high'
}

export interface InformationEntry {
  id: string
  sectionId: string
  headingPath: string[]
  body: string
  status: 'active' | 'superseded' | 'archived'
  evidenceRefs: string[]
  sourceCandidateIds: string[]
  supersedesEntryIds?: string[]
  revision: number
  classification?: ContextClassification
}

export interface CandidateBlock {
  id: string
  source: CandidateSource
  rawArtifactId: string
  normalizedContent: string
  proposedDiffIds: string[]
  status: CandidateStatus
  evidenceRefs: string[]
  createdAt: string
  reviewedAt?: string
  classification?: ContextClassification
}

export interface ContextSection {
  id: string
  kind: ContextSectionKind
  order: number
  revision: number
  content: string
  entries: string[]
}

export interface ContextDocument {
  id: string
  sessionId: string
  projectId: string
  revision: number
  parentRevision?: number
  constitutionRevision: string
  sections: ContextSection[]
  information: InformationEntry[]
  tree?: RuntimeContextTree
  candidates: CandidateBlock[]
  evidence: EvidenceRef[]
  messageCursor: number
  createdAt: string
  updatedAt: string
}

export type DiffOperation = RuntimeContextDiffOperation

export interface DiffProposal {
  diffVersion?: 1 | 2
  id: string
  documentId: string
  baseRevision: number
  targetEntryHash?: string
  targetNodeHash?: string
  projectionId: string
  projectionHash: string
  target: { section: 'information'; entryId?: string; headingPath?: string[]; nodeId?: string }
  operation: DiffOperation
  payload: RuntimeContextDiffPayload
  candidateId: string
  actor: 'system' | 'model' | 'child-agent' | 'memory'
  idempotencyKey: string
  createdAt: string
}

export interface ApplyReceipt {
  id: string
  proposalId: string
  result: 'applied' | 'rejected' | 'conflict'
  previousRevision: number
  nextRevision?: number
  changedEntryIds: string[]
  changedNodeIds?: string[]
  unchanged?: true
  errorCode?: string
  createdAt: string
  /** Hash of execution semantics; transport IDs and retry projection bindings are excluded. */
  proposalHash?: string
}

export interface CandidateReviewReceipt {
  id: string
  candidateId: string
  result: 'reviewed' | 'conflict' | 'rejected'
  previousRevision: number
  nextRevision?: number
  status?: CandidateReviewStatus
  reason?: string
  errorCode?: string
  createdAt: string
}

export type EvidenceReviewDecision = 'accept' | 'reject' | 'conflict' | 'needs_more_evidence'

export interface EvidenceReviewResult {
  decision: EvidenceReviewDecision
  candidateId: string
  supportingEvidence: string[]
  contradictingEvidence: string[]
  targetEntryIds: string[]
  rationale: string
  reviewRevision: number
}

export interface ContextDocumentEngineState {
  document: ContextDocument
  receipts: Array<[string, ApplyReceipt]>
  reviewReceipts: CandidateReviewReceipt[]
  evidenceReviewReceipts: EvidenceReviewResult[]
  projections: Array<[string, ProjectionBinding]>
}

interface ProjectionBinding { documentRevision: number; contentHash: string; sourceEntryIds?: string[]; sourceCandidateIds?: string[]; treeNodes?: RuntimeContextTreeBinding[] }

export interface ProjectionProfile {
  id: string
  maxCharacters: number
  includeTools?: boolean
  includeStructure?: boolean
  /** Model-facing source references instead of the metadata used by Markdown replay. */
  compactReferences?: boolean
  fileEvidenceLocation?: (evidence: EvidenceRef) => { file: string; line: number } | undefined
  includeStatuses?: CandidateStatus[]
  /**
   * Projection-only priority order. The persisted document keeps its
   * canonical five-section order; this controls which sections get budget
   * first when a model-facing projection is bounded.
   */
  sectionOrder?: ContextSectionKind[]
  includeSections?: ContextSectionKind[]
  pinnedEntryIds?: string[]
  /** Heading identities to expose before optional entries, including empty edit destinations. */
  pinnedHeadingIds?: readonly string[]
  /**
   * Candidate selection policy used only when the projection is bounded.
   * Chronological preserves the canonical capture order. Anchor-latest keeps
   * the earliest user task anchor and then fills the remaining budget from
   * the newest observations, rendering the selected set chronologically.
   * Pinned candidate IDs are considered before the newest window, while the
   * final rendering remains chronological.
   */
  candidateSelection?: 'chronological' | 'anchor-latest'
  /** Priority candidates; explicitly pinned accepted sources remain visible for incremental edits. Rejected/stale sources are never revived. */
  pinnedCandidateIds?: string[]
  /** Pending originals already accounted for by a complete, extractive coverage receipt. */
  excludeCandidateIds?: string[]
  /** Render the candidate identity and a reference to its original in outbound tool history. */
  candidateBodyReferences?: ReadonlyMap<string, string>
  resourceLoadCandidateIds?: ReadonlySet<string>
}

export interface Projection {
  id: string
  documentRevision: number
  profileId: string
  sourceEntryIds: string[]
  treeNodes?: RuntimeContextTreeBinding[]
  sourceCandidateIds: string[]
  sourceMessageCursor: number
  truncatedSections: string[]
  selectionReasons: Record<string, string[]>
  markdown: string
  contentHash: string
  createdAt: string
}

export interface ObserveInput {
  candidate: Omit<CandidateBlock, 'id' | 'createdAt' | 'proposedDiffIds' | 'status' | 'evidenceRefs'> & { id?: string; createdAt?: string }
  evidence?: Omit<EvidenceRef, 'id'> & { id?: string }
}

export interface ObserveResult {
  candidate: CandidateBlock
  evidence?: EvidenceRef
}

export interface ProposalInput {
  diffVersion?: 1 | 2
  targetNodeHash?: string
  targetEntryHash?: string
  projection: Projection
  candidateId: string
  target: DiffProposal['target']
  operation: DiffOperation
  payload: DiffProposal['payload']
  actor: DiffProposal['actor']
  idempotencyKey: string
  id?: string
  createdAt?: string
}

export interface MemoryRecallOptions {
  query: string
  limit?: number
}

export interface MemoryRecallMatch {
  candidate: CandidateBlock
  score: number
  reason: string
}

export interface ArchivedInformationRecallMatch {
  entry: InformationEntry
  score: number
  reason: string
}

export interface DreamPlan {
  documentRevision: number
  duplicateCandidateGroups: string[][]
  staleCandidateIds: string[]
  proposalCandidateIds: string[]
  createdAt: string
}

const SECTION_KINDS: readonly ContextSectionKind[] = ['system', 'tools', 'information', 'candidates', 'messages']
const SECTION_LABELS: Record<ContextSectionKind, string> = {
  system: '系统提示词区',
  tools: '工具定义区',
  information: '信息区',
  candidates: '候选信息区',
  messages: '消息列表',
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
  return value
}

export function proposalHash(proposal: DiffProposal): string {
  return sha256(JSON.stringify(canonical({ version: 1, documentId: proposal.documentId, target: proposal.target,
    diffVersion: proposal.diffVersion, targetNodeHash: proposal.targetNodeHash,
    targetEntryHash: proposal.targetEntryHash, operation: proposal.operation, payload: proposal.payload,
    candidateId: proposal.candidateId, actor: proposal.actor })))
}

export function contextValueHash(value: unknown): string { return sha256(JSON.stringify(canonical(value))) }

/** Metadata publication can never substitute a change to knowledge or its provenance. */
export function contextKnowledgeHash(document: ContextDocument): string {
  const tree = document.tree ?? legacyContextTree(document.id, document.information)
  return sha256(JSON.stringify(canonical({ id: document.id, sessionId: document.sessionId, projectId: document.projectId,
    constitutionRevision: document.constitutionRevision, information: document.information, candidates: document.candidates,
    evidence: document.evidence, tree,
    sections: document.sections.filter((section) => section.kind === 'information' || section.kind === 'candidates'),
  })))
}

function marker(kind: ContextSectionKind, id: string, revision?: number): string {
  return `<!-- capybara:section ${kind} id=${id}${revision === undefined ? '' : ` revision=${revision}`} -->`
}

function documentMetadataMarker(document: ContextDocument): string {
  return `<!-- capybara:document-meta data=${metadataToken({
    id: document.id,
    sessionId: document.sessionId,
    projectId: document.projectId,
    revision: document.revision,
    parentRevision: document.parentRevision ?? null,
    constitutionRevision: document.constitutionRevision,
    messageCursor: document.messageCursor,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    tree: document.tree,
  })} -->`
}

function entryMarker(id: string): string {
  return `<!-- capybara:entry information id=${id} -->`
}

function metadataToken(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function parseMetadataToken(token: string): unknown {
  try {
    return JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
  } catch {
    throw new Error('CONTEXT_INVALID_METADATA')
  }
}

function informationMetaMarker(entry: InformationEntry): string {
  return `<!-- capybara:entry-meta information id=${entry.id} data=${metadataToken({ headingPath: entry.headingPath, evidenceRefs: entry.evidenceRefs, sourceCandidateIds: entry.sourceCandidateIds, supersedesEntryIds: entry.supersedesEntryIds ?? [], revision: entry.revision, status: entry.status, classification: entry.classification ?? null })} -->`
}

function candidateMetaMarker(candidate: CandidateBlock): string {
  return `<!-- capybara:candidate-meta id=${candidate.id} data=${metadataToken({ source: candidate.source, rawArtifactId: candidate.rawArtifactId, proposedDiffIds: candidate.proposedDiffIds, evidenceRefs: candidate.evidenceRefs, createdAt: candidate.createdAt, reviewedAt: candidate.reviewedAt ?? null, classification: candidate.classification ?? null })} -->`
}

function evidenceMetaMarker(evidence: readonly EvidenceRef[]): string {
  return `<!-- capybara:evidence data=${metadataToken(evidence)} -->`
}

function referenceMarker(kind: 'entry' | 'candidate', value: object): string {
  return `<!-- capybara:${kind}-ref data=${JSON.stringify(value).replaceAll('-->', '--\\u003e')} -->`
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isEvidenceKind(value: unknown): value is EvidenceRef['kind'] {
  return value === 'observation' || value === 'artifact' || value === 'message' || value === 'external'
}

function isConfidence(value: unknown): value is NonNullable<EvidenceRef['confidence']> {
  return value === 'low' || value === 'medium' || value === 'high'
}

function validateEvidence(value: unknown): asserts value is EvidenceRef {
  if (!value || typeof value !== 'object') throw new Error('CONTEXT_INVALID_EVIDENCE')
  const evidence = value as Record<string, unknown>
  if (typeof evidence.id !== 'string' || !evidence.id.trim()) throw new Error('CONTEXT_INVALID_EVIDENCE')
  if (!isEvidenceKind(evidence.kind) || typeof evidence.referenceId !== 'string' || !evidence.referenceId.trim()) throw new Error('CONTEXT_INVALID_EVIDENCE')
  if (evidence.sessionId !== undefined && (typeof evidence.sessionId !== 'string' || !evidence.sessionId.trim())) throw new Error('CONTEXT_INVALID_EVIDENCE')
  if (evidence.sourceHash !== undefined && typeof evidence.sourceHash !== 'string') throw new Error('CONTEXT_INVALID_EVIDENCE')
  if (evidence.observedAt !== undefined && typeof evidence.observedAt !== 'string') throw new Error('CONTEXT_INVALID_EVIDENCE')
  if (evidence.locator !== undefined && typeof evidence.locator !== 'string') throw new Error('CONTEXT_INVALID_EVIDENCE')
  if (evidence.confidence !== undefined && !isConfidence(evidence.confidence)) throw new Error('CONTEXT_INVALID_EVIDENCE')
}

function validateStringRefs(value: unknown, code: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(code)
  return [...new Set(value)]
}

function validateCandidateSource(value: unknown): asserts value is CandidateSource {
  if (!value || typeof value !== 'object') throw new Error('CONTEXT_INVALID_CANDIDATE_SOURCE')
  const source = value as Record<string, unknown>
  if (!['user', 'tool', 'model', 'system', 'child-agent', 'memory'].includes(String(source.actor)) || typeof source.sourceId !== 'string' || !source.sourceId.trim() || typeof source.capturedAt !== 'string' || !source.capturedAt.trim()) {
    throw new Error('CONTEXT_INVALID_CANDIDATE_SOURCE')
  }
  for (const key of ['toolName', 'runId', 'stepId']) if (source[key] !== undefined && typeof source[key] !== 'string') throw new Error('CONTEXT_INVALID_CANDIDATE_SOURCE')
}

function validateCandidate(value: unknown): asserts value is CandidateBlock {
  if (!value || typeof value !== 'object') throw new Error('CONTEXT_INVALID_CANDIDATE')
  const candidate = value as Record<string, unknown>
  if (typeof candidate.id !== 'string' || !candidate.id.trim() || typeof candidate.rawArtifactId !== 'string' || !candidate.rawArtifactId.trim() || typeof candidate.normalizedContent !== 'string' || typeof candidate.createdAt !== 'string' || !candidate.createdAt.trim()) {
    throw new Error('CONTEXT_INVALID_CANDIDATE')
  }
  validateCandidateSource(candidate.source)
  if (!['pending', 'accepted', 'rejected', 'conflict', 'stale', 'irrelevant', 'superseded'].includes(String(candidate.status))) throw new Error('CONTEXT_INVALID_CANDIDATE')
  validateStringRefs(candidate.proposedDiffIds, 'CONTEXT_INVALID_DIFF_REF')
  validateStringRefs(candidate.evidenceRefs, 'CONTEXT_INVALID_EVIDENCE_REF')
  if (candidate.reviewedAt !== undefined && (typeof candidate.reviewedAt !== 'string' || !candidate.reviewedAt.trim())) throw new Error('CONTEXT_INVALID_CANDIDATE')
  if (candidate.classification !== undefined) validateContextClassification(candidate.classification)
}

function observationKey(source: CandidateSource): string {
  // Source IDs are scoped to their actor channel. A user message and a tool
  // receipt may legitimately reuse the same provider-local identifier; they
  // must not collapse into one candidate or share evidence by accident.
  return `${source.actor}\u0000${source.sourceId}`
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export class ContextDocumentEngine {
  private readonly receipts = new Map<string, ApplyReceipt>()
  private readonly reviewReceipts: CandidateReviewReceipt[] = []
  private readonly evidenceReviewReceipts: EvidenceReviewResult[] = []
  private readonly projections = new Map<string, ProjectionBinding>()

  constructor(
    private document: ContextDocument,
    receipts: ReadonlyArray<[string, ApplyReceipt]> = [],
    projections: ReadonlyArray<[string, ProjectionBinding]> = [],
    reviewReceipts: ReadonlyArray<CandidateReviewReceipt> = [],
    evidenceReviewReceipts: ReadonlyArray<EvidenceReviewResult> = [],
  ) {
    // Restore from a detached snapshot so callers cannot mutate the live
    // document by retaining the object passed to the constructor.
    this.document = clone(document)
    if (!this.document || typeof this.document !== 'object' || !Array.isArray(this.document.sections) || !Array.isArray(this.document.information) || !Array.isArray(this.document.candidates) || !Array.isArray(this.document.evidence)) {
      throw new Error('CONTEXT_INVALID_DOCUMENT')
    }
    if (typeof this.document.id !== 'string' || !this.document.id.trim()
      || typeof this.document.sessionId !== 'string' || !this.document.sessionId.trim()
      || typeof this.document.projectId !== 'string' || !this.document.projectId.trim()
      || typeof this.document.constitutionRevision !== 'string' || !this.document.constitutionRevision.trim()
      || !Number.isInteger(this.document.revision) || this.document.revision < 0
      || (this.document.parentRevision !== undefined && (!Number.isInteger(this.document.parentRevision) || this.document.parentRevision < 0))
      || !Number.isInteger(this.document.messageCursor) || this.document.messageCursor < 0
      || typeof this.document.createdAt !== 'string' || !this.document.createdAt.trim()
      || typeof this.document.updatedAt !== 'string' || !this.document.updatedAt.trim()) {
      throw new Error('CONTEXT_INVALID_DOCUMENT')
    }
    if (this.document.sections.length !== SECTION_KINDS.length) throw new Error('CONTEXT_INVALID_SECTIONS')
    const sectionIds = new Set<string>()
    for (const [index, section] of this.document.sections.entries()) {
      if (!section || typeof section !== 'object'
        || section.kind !== SECTION_KINDS[index]
        || section.order !== index
        || typeof section.id !== 'string' || !section.id.trim() || sectionIds.has(section.id)
        || !Number.isInteger(section.revision) || section.revision < 0
        || typeof section.content !== 'string' || !Array.isArray(section.entries)) {
        throw new Error('CONTEXT_INVALID_SECTIONS')
      }
      sectionIds.add(section.id)
      if (section.revision > this.document.revision) throw new Error('CONTEXT_INVALID_SECTION_REVISION')
      if (section.entries.some((entryId) => typeof entryId !== 'string' || !entryId.trim())) throw new Error('CONTEXT_INVALID_SECTION_ENTRIES')
    }
    const evidenceIds = new Set<string>()
    for (const evidence of this.document.evidence) {
      validateEvidence(evidence)
      if (evidenceIds.has(evidence.id)) throw new Error('CONTEXT_DUPLICATE_EVIDENCE')
      evidenceIds.add(evidence.id)
    }
    const candidateIds = new Set<string>()
    for (const candidate of this.document.candidates) {
      validateCandidate(candidate)
      if (candidateIds.has(candidate.id)) throw new Error('CONTEXT_DUPLICATE_CANDIDATE')
      candidateIds.add(candidate.id)
      validateStringRefs(candidate.evidenceRefs, 'CONTEXT_INVALID_EVIDENCE_REF').forEach((id) => {
        if (!evidenceIds.has(id)) throw new Error('CONTEXT_INVALID_EVIDENCE_REF')
      })
    }
    const informationIds = new Set<string>()
    for (const entry of this.document.information) {
      if (!entry || typeof entry.id !== 'string' || !entry.id.trim() || typeof entry.sectionId !== 'string' || !entry.sectionId.trim() || !Array.isArray(entry.headingPath) || entry.headingPath.some((part) => typeof part !== 'string') || typeof entry.body !== 'string' || !['active', 'superseded', 'archived'].includes(entry.status) || !Number.isInteger(entry.revision) || entry.revision < 0) {
        throw new Error('CONTEXT_INVALID_ENTRY')
      }
      if (entry.classification !== undefined) validateContextClassification(entry.classification)
      if (informationIds.has(entry.id)) throw new Error('CONTEXT_DUPLICATE_ENTRY')
      informationIds.add(entry.id)
      validateStringRefs(entry.evidenceRefs, 'CONTEXT_INVALID_EVIDENCE_REF').forEach((id) => {
        if (!evidenceIds.has(id)) throw new Error('CONTEXT_INVALID_EVIDENCE_REF')
      })
      validateStringRefs(entry.sourceCandidateIds, 'CONTEXT_INVALID_CANDIDATE_REF').forEach((id) => {
        if (!candidateIds.has(id)) throw new Error('CONTEXT_INVALID_CANDIDATE_REF')
      })
      validateStringRefs(entry.supersedesEntryIds ?? [], 'CONTEXT_INVALID_ENTRY_REF').forEach((id) => {
        if (!informationIds.has(id)) throw new Error('CONTEXT_INVALID_ENTRY_REF')
      })
    }
    const informationSection = this.document.sections.find((section) => section.kind === 'information') as ContextSection
    const candidateSection = this.document.sections.find((section) => section.kind === 'candidates') as ContextSection
    if (informationSection.entries.some((id) => !informationIds.has(id)) || candidateSection.entries.some((id) => !candidateIds.has(id))) {
      throw new Error('CONTEXT_INVALID_SECTION_ENTRIES')
    }
    this.document.tree ??= legacyContextTree(this.document.id, this.document.information)
    validateContextTree(this.document.tree, this.document.information)
    informationSection.entries = contextTreeOrder(this.document.tree).filter((id) => informationIds.has(id))
    for (const [idempotencyKey, receipt] of receipts) this.receipts.set(idempotencyKey, clone(receipt))
    for (const [projectionId, projection] of projections) this.projections.set(projectionId, clone(projection))
    this.reviewReceipts.push(...reviewReceipts.map((receipt) => clone(receipt)))
    this.evidenceReviewReceipts.push(...evidenceReviewReceipts.map((receipt) => clone(receipt)))
  }

  static create(input: { sessionId: string; projectId: string; constitutionRevision: string; now?: string }): ContextDocumentEngine {
    const now = input.now ?? new Date().toISOString()
    const sections = SECTION_KINDS.map((kind, order) => ({
      id: kind,
      kind,
      order,
      revision: 0,
      content: '',
      entries: [],
    }))
    return new ContextDocumentEngine({
      id: `context-document-${randomUUID()}`,
      sessionId: input.sessionId,
      projectId: input.projectId,
      revision: 0,
      constitutionRevision: input.constitutionRevision,
      sections,
      information: [],
      candidates: [],
      evidence: [],
      messageCursor: 0,
      createdAt: now,
      updatedAt: now,
    })
  }

  static parse(markdown: string, input: { sessionId: string; projectId: string; constitutionRevision: string; now?: string }): ContextDocumentEngine {
    const lines = markdown.replaceAll('\r\n', '\n').split('\n')
    const found = new Map<ContextSectionKind, { id: string; revision: number; start: number }>()
    let documentMetadata: Partial<ContextDocument> | undefined
    lines.forEach((line, index) => {
      if (line.startsWith('<!-- capybara:document-meta ') && !/^<!-- capybara:document-meta data=[A-Za-z0-9_-]+ -->$/.test(line)) {
        throw new Error('CONTEXT_INVALID_METADATA')
      }
      if (line.startsWith('<!-- capybara:document-meta data=')) {
        if (documentMetadata) throw new Error('CONTEXT_DUPLICATE_METADATA')
        const match = line.match(/^<!-- capybara:document-meta data=([A-Za-z0-9_-]+) -->$/)
        if (!match) throw new Error('CONTEXT_INVALID_METADATA')
        const value = parseMetadataToken(match[1] as string)
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CONTEXT_INVALID_METADATA')
        documentMetadata = value as Partial<ContextDocument>
      }
      if (line.startsWith('<!-- capybara:section ') && !/^<!-- capybara:section (system|tools|information|candidates|messages) id=[^ ]+(?: revision=\d+)? -->$/.test(line)) {
        throw new Error('CONTEXT_INVALID_SECTION_MARKER')
      }
      if (line.startsWith('<!-- capybara:entry ') && !/^<!-- capybara:entry information id=[^ ]+ -->$/.test(line)) {
        throw new Error('CONTEXT_INVALID_ENTRY_MARKER')
      }
      if (line.startsWith('<!-- capybara:entry-meta ') && !/^<!-- capybara:entry-meta information id=[^ ]+ data=[A-Za-z0-9_-]+ -->$/.test(line)) {
        throw new Error('CONTEXT_INVALID_METADATA')
      }
      if (line.startsWith('<!-- capybara:candidate-meta ') && !/^<!-- capybara:candidate-meta id=[^ ]+ data=[A-Za-z0-9_-]+ -->$/.test(line)) {
        throw new Error('CONTEXT_INVALID_METADATA')
      }
      if (line.startsWith('<!-- capybara:evidence ') && !/^<!-- capybara:evidence data=[A-Za-z0-9_-]+ -->$/.test(line)) {
        throw new Error('CONTEXT_INVALID_METADATA')
      }
      const match = line.match(/^<!-- capybara:section (system|tools|information|candidates|messages) id=([^ ]+)(?: revision=(\d+))? -->$/)
      if (!match) return
      const kind = match[1] as ContextSectionKind
      if (found.has(kind)) throw new Error(`CONTEXT_DUPLICATE_SECTION:${kind}`)
      found.set(kind, { id: match[2] as string, revision: Number(match[3] ?? 0), start: index })
    })
    for (const kind of SECTION_KINDS) if (!found.has(kind)) throw new Error(`CONTEXT_MISSING_SECTION:${kind}`)
    const starts = SECTION_KINDS.map((kind) => (found.get(kind) as { start: number }).start)
    if (starts.some((start, index) => index > 0 && start < (starts[index - 1] ?? start))) throw new Error('CONTEXT_SECTION_ORDER_INVALID')
    const sections = SECTION_KINDS.map((kind, order) => {
      const current = found.get(kind) as { id: string; revision: number; start: number }
      const next = SECTION_KINDS.slice(order + 1).map((item) => found.get(item)?.start).find((value) => value !== undefined) ?? lines.length
      const rawContent = lines.slice(current.start + 1, next).join('\n').replace(/\n---\s*$/, '').trim()
      const content = rawContent.startsWith(`# ${SECTION_LABELS[kind]}`)
        ? rawContent.slice(`# ${SECTION_LABELS[kind]}`.length).trim()
        : rawContent
      return { id: current.id, kind, order, revision: current.revision, content, entries: [] }
    })
    const now = input.now ?? new Date().toISOString()
    const document = ContextDocumentEngine.create({ ...input, now }).snapshot()
    document.sections = sections
    const sectionRevision = Math.max(...sections.map((section) => section.revision), 0)
    if (documentMetadata) {
      for (const key of ['id', 'sessionId', 'projectId', 'constitutionRevision', 'createdAt', 'updatedAt'] as const) {
        if (documentMetadata[key] !== undefined && (typeof documentMetadata[key] !== 'string' || !documentMetadata[key])) throw new Error('CONTEXT_INVALID_METADATA')
      }
      for (const key of ['revision', 'messageCursor'] as const) {
        if (documentMetadata[key] !== undefined && (!Number.isInteger(documentMetadata[key]) || (documentMetadata[key] as number) < 0)) throw new Error('CONTEXT_INVALID_METADATA')
      }
      if (documentMetadata.parentRevision !== undefined && documentMetadata.parentRevision !== null
        && (!Number.isInteger(documentMetadata.parentRevision) || documentMetadata.parentRevision < 0)) throw new Error('CONTEXT_INVALID_METADATA')
      document.id = documentMetadata.id ?? document.id
      document.sessionId = documentMetadata.sessionId ?? document.sessionId
      document.projectId = documentMetadata.projectId ?? document.projectId
      document.constitutionRevision = documentMetadata.constitutionRevision ?? document.constitutionRevision
      document.revision = documentMetadata.revision ?? sectionRevision
      document.parentRevision = documentMetadata.parentRevision === null ? undefined : documentMetadata.parentRevision
      document.messageCursor = documentMetadata.messageCursor ?? document.messageCursor
      document.createdAt = documentMetadata.createdAt ?? document.createdAt
      document.updatedAt = documentMetadata.updatedAt ?? document.updatedAt
    } else {
      document.revision = sectionRevision
    }
    const informationSection = sections.find((section) => section.kind === 'information') as ContextSection
    // The empty tree created above is not a tree for the imported entries.
    document.tree = documentMetadata?.tree
    const informationLines = informationSection.content.split('\n')
    for (let index = 0; index < informationLines.length; index += 1) {
      const markerMatch = informationLines[index]?.match(/^<!-- capybara:entry information id=([^ ]+) -->$/)
      if (!markerMatch) continue
      const id = markerMatch[1] as string
      let cursor = index + 1
      let metadata: { headingPath?: string[]; evidenceRefs?: string[]; sourceCandidateIds?: string[]; supersedesEntryIds?: string[]; revision?: number; status?: InformationEntry['status']; classification?: ContextClassification } = {}
      const metadataMatch = informationLines[cursor]?.match(/^<!-- capybara:entry-meta information id=([^ ]+) data=([A-Za-z0-9_-]+) -->$/)
      if (metadataMatch) {
        if (metadataMatch[1] !== id) throw new Error('CONTEXT_INVALID_METADATA')
        const value = parseMetadataToken(metadataMatch[2] as string)
        if (!value || typeof value !== 'object') throw new Error('CONTEXT_INVALID_METADATA')
        metadata = value as typeof metadata
        cursor += 1
      }
      const heading = informationLines[cursor]?.match(/^## (.+)$/)
      const bodyLines: string[] = []
      let bodyCursor = cursor + (heading ? 1 : 0)
      while (bodyCursor < informationLines.length && !informationLines[bodyCursor]?.startsWith('<!-- capybara:entry information id=')) {
        bodyLines.push(informationLines[bodyCursor] as string)
        bodyCursor += 1
      }
      const entry: InformationEntry = {
        id,
        sectionId: informationSection.id,
        headingPath: metadata.headingPath ?? (heading ? [heading[1] as string] : [id]),
        body: bodyLines.join('\n').trim(),
        status: metadata.status && ['active', 'superseded', 'archived'].includes(metadata.status) ? metadata.status : 'active',
        evidenceRefs: Array.isArray(metadata.evidenceRefs) ? metadata.evidenceRefs : [],
        sourceCandidateIds: Array.isArray(metadata.sourceCandidateIds) ? metadata.sourceCandidateIds : [],
        supersedesEntryIds: Array.isArray(metadata.supersedesEntryIds) ? metadata.supersedesEntryIds : [],
        revision: Number.isInteger(metadata.revision) ? metadata.revision as number : informationSection.revision,
        ...(metadata.classification ? { classification: metadata.classification } : {}),
      }
      document.information.push(entry)
      informationSection.entries.push(id)
      index = Math.max(index, bodyCursor - 1)
    }
    const candidateSection = sections.find((section) => section.kind === 'candidates') as ContextSection
    const evidenceMarkers = [...candidateSection.content.matchAll(/<!-- capybara:evidence data=([A-Za-z0-9_-]+) -->/g)]
    if (evidenceMarkers.length > 1) throw new Error('CONTEXT_DUPLICATE_EVIDENCE')
    const evidenceMarker = evidenceMarkers[0]
    if (evidenceMarker) {
      const value = parseMetadataToken(evidenceMarker[1] as string)
      if (!Array.isArray(value)) throw new Error('CONTEXT_INVALID_EVIDENCE')
      const seenEvidence = new Set<string>()
      for (const item of value) {
        validateEvidence(item)
        if (seenEvidence.has(item.id)) throw new Error('CONTEXT_DUPLICATE_EVIDENCE')
        seenEvidence.add(item.id)
        document.evidence.push(clone(item))
      }
    }
    const candidateMetadataById = new Map<string, Partial<CandidateBlock>>()
    for (const match of candidateSection.content.matchAll(/<!-- capybara:candidate-meta id=([^ ]+) data=([A-Za-z0-9_-]+) -->/g)) {
      const value = parseMetadataToken(match[2] as string)
      if (!value || typeof value !== 'object') throw new Error('CONTEXT_INVALID_METADATA')
      if (candidateMetadataById.has(match[1] as string)) throw new Error('CONTEXT_DUPLICATE_CANDIDATE')
      candidateMetadataById.set(match[1] as string, value as Partial<CandidateBlock>)
    }
    const candidateBlocks = candidateSection.content.split(/(?=^(?:<!-- capybara:candidate-meta |## candidate-))/m).map((value) => value.trim()).filter(Boolean)
    for (const block of candidateBlocks) {
      const linesInBlock = block.split('\n')
      const candidateMetadata = block.match(/<!-- capybara:candidate-meta id=([^ ]+) data=([A-Za-z0-9_-]+) -->/)
      // Candidate IDs are opaque protocol values. The metadata marker is the
      // authoritative boundary, so do not require the implementation-generated
      // `candidate-` prefix when restoring a serialized candidate.
      const idMatch = linesInBlock.find((line) => line.startsWith('## '))?.match(/^## ([^ ]+)$/)
      if (!idMatch) continue
      let metadata: Partial<CandidateBlock> = {}
      if (candidateMetadata) {
        if (candidateMetadata[1] !== idMatch[1]) throw new Error('CONTEXT_INVALID_METADATA')
        const value = parseMetadataToken(candidateMetadata[2] as string)
        if (!value || typeof value !== 'object') throw new Error('CONTEXT_INVALID_METADATA')
        metadata = value as Partial<CandidateBlock>
      }
      metadata = candidateMetadataById.get(idMatch[1] as string) ?? metadata
      const statusMatch = linesInBlock.find((line) => line.startsWith('状态：'))
      const status = (statusMatch?.slice('状态：'.length).trim() ?? 'pending') as CandidateStatus
      const normalizedContent = linesInBlock
        .filter((line) => !line.startsWith('## ') && !line.startsWith('状态：') && !line.startsWith('<!-- capybara:candidate-meta ') && !line.startsWith('<!-- capybara:evidence ') && line.trim() !== '')
        .join('\n').trim()
      const candidateValue: CandidateBlock = {
        id: idMatch[1] as string,
        source: metadata.source ?? { actor: 'system', sourceId: idMatch[1] as string, capturedAt: now },
        rawArtifactId: metadata.rawArtifactId ?? `candidate:${idMatch[1]}`,
        normalizedContent,
        proposedDiffIds: validateStringRefs(metadata.proposedDiffIds ?? [], 'CONTEXT_INVALID_DIFF_REF'),
        status: ['pending', 'accepted', 'rejected', 'conflict', 'stale', 'irrelevant', 'superseded'].includes(status) ? status : 'pending',
        evidenceRefs: validateStringRefs(metadata.evidenceRefs ?? [], 'CONTEXT_INVALID_EVIDENCE_REF'),
        createdAt: metadata.createdAt ?? now,
        ...(metadata.reviewedAt ? { reviewedAt: metadata.reviewedAt } : {}),
        ...(metadata.classification ? { classification: metadata.classification } : {}),
      }
      validateCandidateSource(candidateValue.source)
      if (typeof candidateValue.rawArtifactId !== 'string' || !candidateValue.rawArtifactId.trim() || typeof candidateValue.createdAt !== 'string' || !candidateValue.createdAt.trim() || (candidateValue.reviewedAt !== undefined && typeof candidateValue.reviewedAt !== 'string')) throw new Error('CONTEXT_INVALID_CANDIDATE_METADATA')
      if (document.candidates.some((candidate) => candidate.id === candidateValue.id)) throw new Error('CONTEXT_DUPLICATE_CANDIDATE')
      if (candidateValue.evidenceRefs.some((id) => !document.evidence.some((evidence) => evidence.id === id))) throw new Error('CONTEXT_INVALID_EVIDENCE_REF')
      document.candidates.push(candidateValue)
      candidateSection.entries.push(candidateValue.id)
    }
    for (const entry of document.information) {
      entry.evidenceRefs = validateStringRefs(entry.evidenceRefs, 'CONTEXT_INVALID_EVIDENCE_REF')
      entry.sourceCandidateIds = validateStringRefs(entry.sourceCandidateIds, 'CONTEXT_INVALID_CANDIDATE_REF')
      entry.supersedesEntryIds = validateStringRefs(entry.supersedesEntryIds ?? [], 'CONTEXT_INVALID_ENTRY_REF')
      if (entry.evidenceRefs.some((id) => !document.evidence.some((evidence) => evidence.id === id))) throw new Error('CONTEXT_INVALID_EVIDENCE_REF')
      if (entry.sourceCandidateIds.some((id) => !document.candidates.some((candidate) => candidate.id === id))) throw new Error('CONTEXT_INVALID_CANDIDATE_REF')
      if ((entry.supersedesEntryIds ?? []).some((id) => !document.information.some((previous) => previous.id === id))) throw new Error('CONTEXT_INVALID_ENTRY_REF')
    }
    return new ContextDocumentEngine(document)
  }

  snapshot(): ContextDocument {
    return clone(this.document)
  }

  receiptsSnapshot(): ApplyReceipt[] {
    return [...this.receipts.values()].map((receipt) => clone(receipt))
  }

  reviewReceiptsSnapshot(): CandidateReviewReceipt[] {
    return this.reviewReceipts.map((receipt) => clone(receipt))
  }

  evidenceReviewReceiptsSnapshot(): EvidenceReviewResult[] {
    return this.evidenceReviewReceipts.map((receipt) => clone(receipt))
  }

  exportState(): ContextDocumentEngineState {
    return {
      document: this.snapshot(),
      receipts: [...this.receipts.entries()].map(([key, receipt]) => [key, clone(receipt)]),
      reviewReceipts: this.reviewReceiptsSnapshot(),
      evidenceReviewReceipts: this.evidenceReviewReceiptsSnapshot(),
      projections: [...this.projections.entries()].map(([id, projection]) => [id, clone(projection)]),
    }
  }

  setSectionContent(kind: ContextSectionKind, content: string, options: { bumpRevision?: boolean; governance?: 'runtime' } = {}): void {
    const section = this.document.sections.find((item) => item.kind === kind)
    if (!section) throw new Error(`SECTION_NOT_FOUND:${kind}`)
    if ((kind === 'system' || kind === 'tools') && options.governance !== 'runtime') throw new Error('IMMUTABLE_SYSTEM_SECTION')
    const changed = section.content !== content
    section.content = content
    if (changed && options.bumpRevision !== false) {
      this.bumpRevision([kind])
    }
    this.touch()
  }

  setMessageCursor(cursor: number): void {
    if (!Number.isInteger(cursor) || cursor < 0) throw new Error('MESSAGE_CURSOR_INVALID')
    const changed = this.document.messageCursor !== cursor
    this.document.messageCursor = cursor
    if (changed) this.bumpRevision(['messages'])
    this.touch()
  }

  setSessionId(sessionId: string): void {
    if (!sessionId) throw new Error('SESSION_ID_INVALID')
    if (this.document.sessionId === sessionId) return
    this.document.sessionId = sessionId
    this.bumpRevision()
    this.touch()
  }

  observe(input: ObserveInput): ObserveResult {
    const key = observationKey(input.candidate.source)
    const existing = this.document.candidates.find((candidate) => observationKey(candidate.source) === key)
    if (existing) {
      let evidence: EvidenceRef | undefined
      if (input.candidate.classification && JSON.stringify(existing.classification) !== JSON.stringify(input.candidate.classification)) {
        validateContextClassification(input.candidate.classification)
        existing.classification = clone(input.candidate.classification)
        this.bumpRevision(['candidates'])
        this.touch()
      }
      if (input.evidence) {
        const { id: _requestedId, ...requested } = input.evidence
        evidence = input.evidence.id
          ? this.document.evidence.find((item) => item.id === input.evidence?.id)
          : this.document.evidence.find(({ id: _id, ...value }) => JSON.stringify(canonical(value)) === JSON.stringify(canonical(requested)))
        if (evidence) {
          const { id: _existingId, ...value } = evidence
          if (JSON.stringify(canonical(value)) !== JSON.stringify(canonical(requested))) throw new Error('EVIDENCE_ID_CONFLICT')
        }
        if (!evidence) {
          evidence = this.addEvidence(input.evidence)
          this.attachEvidence(existing.id, evidence.id)
        } else if (!existing.evidenceRefs.includes(evidence.id)) {
          this.attachEvidence(existing.id, evidence.id)
        }
      }
      // `attachEvidence` mutates the canonical candidate and advances the
      // document revision. Return the post-merge candidate so callers cannot
      // observe a stale evidenceRefs list after a deduplicated observation.
      const current = this.document.candidates.find((candidate) => candidate.id === existing.id) as CandidateBlock
      return { candidate: clone(current), ...(evidence ? { evidence: clone(evidence) } : {}) }
    }
    const candidate = this.addCandidate({ ...input.candidate, evidenceRefs: [] })
    if (!input.evidence) return { candidate }
    const evidence = this.addEvidence(input.evidence)
    this.attachEvidence(candidate.id, evidence.id)
    return { candidate: this.document.candidates.find((item) => item.id === candidate.id) as CandidateBlock, evidence }
  }

  propose(input: ProposalInput): DiffProposal {
    const document = this.snapshot()
    if (input.projection.documentRevision !== document.revision) throw new Error('PROJECTION_REVISION_CONFLICT')
    if (!this.projections.has(input.projection.id)) throw new Error('PROJECTION_NOT_FOUND')
    if (!this.document.candidates.some((candidate) => candidate.id === input.candidateId)) throw new Error('CANDIDATE_NOT_FOUND')
    return {
      id: input.id ?? `proposal-${randomUUID()}`,
      documentId: document.id,
      baseRevision: document.revision,
      projectionId: input.projection.id,
      projectionHash: input.projection.contentHash,
      target: clone(input.target),
      operation: input.operation,
      payload: clone(input.payload),
      candidateId: input.candidateId,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.createdAt ?? new Date().toISOString(),
      ...(input.diffVersion !== undefined ? { diffVersion: input.diffVersion } : {}),
      ...(input.targetNodeHash !== undefined ? { targetNodeHash: input.targetNodeHash } : {}),
      ...(input.targetEntryHash !== undefined ? { targetEntryHash: input.targetEntryHash } : {}),
    }
  }

  recallMemory(options: MemoryRecallOptions): CandidateBlock[] {
    return this.recallMemoryDetailed(options).map((match) => match.candidate)
  }

  recallMemoryDetailed(options: MemoryRecallOptions): MemoryRecallMatch[] {
    const terms = options.query.toLocaleLowerCase().split(/\s+/u).filter(Boolean)
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 8)))
    return this.document.candidates
      .filter((candidate) => candidate.source.actor === 'memory' && !['rejected', 'stale', 'irrelevant', 'superseded'].includes(candidate.status))
      .map((candidate) => {
        const text = candidate.normalizedContent.toLocaleLowerCase()
        const matchedTerms = terms.filter((term) => text.includes(term))
        const score = matchedTerms.length
        return { candidate, score, matchedTerms }
      })
      .filter((item) => terms.length === 0 || item.score > 0)
      .sort((a, b) => b.score - a.score || compareText(a.candidate.id, b.candidate.id))
      .slice(0, limit)
      .map((item) => ({
        candidate: clone(item.candidate),
        score: item.score,
        reason: terms.length === 0 ? 'query-empty' : `matched:${item.matchedTerms.join(',')}`,
      }))
  }

  /** Search archived information without promoting it back into the active projection. */
  recallArchivedInformation(options: MemoryRecallOptions): ArchivedInformationRecallMatch[] {
    const terms = options.query.toLocaleLowerCase().split(/\s+/u).filter(Boolean)
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 8)))
    return this.document.information
      .filter((entry) => entry.status === 'archived')
      .map((entry) => {
        const text = `${entry.headingPath.join(' ')} ${entry.body}`.toLocaleLowerCase()
        const matchedTerms = terms.filter((term) => text.includes(term))
        return { entry, score: matchedTerms.length, matchedTerms }
      })
      .filter((item) => terms.length === 0 || item.score > 0)
      .sort((a, b) => b.score - a.score || compareText(a.entry.id, b.entry.id))
      .slice(0, limit)
      .map((item) => ({
        entry: clone(item.entry),
        score: item.score,
        reason: terms.length === 0 ? 'query-empty' : `matched:${item.matchedTerms.join(',')}`,
      }))
  }

  dream(now = new Date().toISOString()): DreamPlan {
    const groups = new Map<string, string[]>()
    for (const candidate of this.document.candidates) {
      if (['rejected', 'irrelevant', 'superseded'].includes(candidate.status)) continue
      const key = `${candidate.source.actor}\u0000${candidate.normalizedContent.trim()}`
      const ids = groups.get(key) ?? []
      ids.push(candidate.id)
      groups.set(key, ids)
    }
    const duplicateCandidateGroups = [...groups.values()]
      .filter((ids) => ids.length > 1)
      .map((ids) => ids.sort())
      .sort((a, b) => compareText(a[0] ?? '', b[0] ?? ''))
    const staleCandidateIds = this.document.candidates
      .filter((candidate) => candidate.status === 'stale')
      .map((candidate) => candidate.id)
      .sort()
    const proposalCandidateIds = this.document.candidates
      .filter((candidate) => candidate.status === 'pending' || candidate.status === 'conflict')
      .map((candidate) => candidate.id)
      .sort()
    return { documentRevision: this.document.revision, duplicateCandidateGroups, staleCandidateIds, proposalCandidateIds, createdAt: now }
  }

  mergeChildCandidate(input: Omit<CandidateBlock, 'id' | 'createdAt' | 'proposedDiffIds' | 'status' | 'source'> & { id?: string; createdAt?: string; sourceId: string; runId?: string; stepId?: string; evidenceRefs: string[] }): CandidateBlock {
    if (input.evidenceRefs.some((id) => !this.document.evidence.some((evidence) => evidence.id === id))) throw new Error('EVIDENCE_NOT_FOUND')
    return this.addCandidate({
      ...input,
      source: {
        actor: 'child-agent',
        sourceId: input.sourceId,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.stepId ? { stepId: input.stepId } : {}),
        capturedAt: input.createdAt ?? new Date().toISOString(),
      },
    })
  }

  addCandidate(input: Omit<CandidateBlock, 'id' | 'createdAt' | 'proposedDiffIds' | 'status'> & { id?: string; createdAt?: string }): CandidateBlock {
    if (input.id && this.document.candidates.some((item) => item.id === input.id)) throw new Error('CANDIDATE_DUPLICATE')
    const evidenceRefs = validateStringRefs(input.evidenceRefs, 'EVIDENCE_REF_INVALID')
    if (evidenceRefs.some((id) => !this.document.evidence.some((evidence) => evidence.id === id))) throw new Error('EVIDENCE_NOT_FOUND')
    const candidate: CandidateBlock = {
      id: input.id ?? `candidate-${randomUUID()}`,
      source: clone(input.source),
      rawArtifactId: input.rawArtifactId,
      normalizedContent: input.normalizedContent,
      proposedDiffIds: [],
      status: 'pending',
      evidenceRefs,
      createdAt: input.createdAt ?? new Date().toISOString(),
      ...(input.classification ? { classification: clone(input.classification) } : {}),
    }
    validateCandidate(candidate)
    this.document.candidates.push(candidate)
    const candidateSection = this.document.sections.find((section) => section.kind === 'candidates')
    if (candidateSection && !candidateSection.entries.includes(candidate.id)) candidateSection.entries.push(candidate.id)
    this.bumpRevision(['candidates'])
    this.touch()
    return clone(candidate)
  }

  addEvidence(evidence: Omit<EvidenceRef, 'id'> & { id?: string }): EvidenceRef {
    const value = { ...evidence, id: evidence.id ?? `evidence-${randomUUID()}` }
    validateEvidence(value)
    if (this.document.evidence.some((item) => item.id === value.id)) throw new Error('EVIDENCE_DUPLICATE')
    this.document.evidence.push(clone(value))
    this.bumpRevision(['candidates'])
    this.touch()
    return clone(value)
  }

  attachEvidence(candidateId: string, evidenceId: string): CandidateBlock {
    const candidate = this.document.candidates.find((item) => item.id === candidateId)
    if (!candidate) throw new Error('CANDIDATE_NOT_FOUND')
    if (!this.document.evidence.some((item) => item.id === evidenceId)) throw new Error('EVIDENCE_NOT_FOUND')
    candidate.evidenceRefs = [...new Set([...candidate.evidenceRefs, evidenceId])]
    this.bumpRevision(['candidates'])
    this.touch()
    return clone(candidate)
  }

  reviewCandidate(candidateId: string, status: CandidateReviewStatus, baseRevision: number, reason?: string, documentId?: string): CandidateReviewReceipt {
    const previousRevision = this.document.revision
    const candidate = this.document.candidates.find((item) => item.id === candidateId)
    const rejected = (result: CandidateReviewReceipt['result'], errorCode: string): CandidateReviewReceipt => ({
      id: `candidate-review-${randomUUID()}`, candidateId, result, previousRevision, errorCode, ...(reason ? { reason } : {}), createdAt: new Date().toISOString(),
    })
    const recordRejected = (result: CandidateReviewReceipt['result'], errorCode: string): CandidateReviewReceipt => {
      const receipt = rejected(result, errorCode)
      this.reviewReceipts.push(clone(receipt))
      return receipt
    }
    if (documentId !== undefined && documentId !== this.document.id) return recordRejected('rejected', 'DOCUMENT_ID_MISMATCH')
    if (!candidate) {
      return recordRejected('rejected', 'CANDIDATE_NOT_FOUND')
    }
    if (!Number.isInteger(baseRevision) || baseRevision !== previousRevision) return recordRejected('conflict', 'CONTEXT_REVISION_CONFLICT')
    if (status === 'accepted' && candidate.evidenceRefs.length === 0) {
      return recordRejected('rejected', 'EVIDENCE_REQUIRED')
    }
    if (!candidate.evidenceRefs.every((id) => this.document.evidence.some((item) => item.id === id))) {
      return recordRejected('rejected', 'EVIDENCE_NOT_FOUND')
    }
    const nextRevision = previousRevision + 1
    const next = clone(this.document)
    const nextCandidate = next.candidates.find((item) => item.id === candidateId) as CandidateBlock
    nextCandidate.status = status
    nextCandidate.reviewedAt = new Date().toISOString()
    next.revision = nextRevision
    next.parentRevision = previousRevision
    next.updatedAt = new Date().toISOString()
    next.sections.find((item) => item.kind === 'candidates')!.revision = nextRevision
    this.document = next
    const receipt = { id: `candidate-review-${randomUUID()}`, candidateId, result: 'reviewed' as const, previousRevision, nextRevision, status, ...(reason ? { reason } : {}), createdAt: new Date().toISOString() }
    this.reviewReceipts.push(clone(receipt))
    return receipt
  }

  reviewEvidence(input: {
    candidateId: string
    decision: EvidenceReviewDecision
    baseRevision: number
    supportingEvidence?: string[]
    contradictingEvidence?: string[]
    targetEntryIds?: string[]
    rationale?: string
    documentId?: string
  }): EvidenceReviewResult {
    const document = this.snapshot()
    const supportingEvidence = [...new Set(input.supportingEvidence ?? [])]
    const contradictingEvidence = [...new Set(input.contradictingEvidence ?? [])]
    const targetEntryIds = [...new Set(input.targetEntryIds ?? [])]
    const validEvidence = (id: string) => document.evidence.some((evidence) => evidence.id === id)
    if (input.documentId !== undefined && input.documentId !== document.id) throw new Error('DOCUMENT_ID_MISMATCH')
    if (!document.candidates.some((candidate) => candidate.id === input.candidateId)) throw new Error('CANDIDATE_NOT_FOUND')
    if (input.baseRevision !== document.revision) throw new Error('CONTEXT_REVISION_CONFLICT')
    if ([...supportingEvidence, ...contradictingEvidence].some((id) => !validEvidence(id))) throw new Error('EVIDENCE_NOT_FOUND')
    if (targetEntryIds.some((id) => !document.information.some((entry) => entry.id === id))) throw new Error('ENTRY_NOT_FOUND')
    const candidate = document.candidates.find((item) => item.id === input.candidateId) as CandidateBlock
    if ([...supportingEvidence, ...contradictingEvidence].some((id) => !candidate.evidenceRefs.includes(id))) throw new Error('EVIDENCE_NOT_BOUND')
    if (input.decision === 'needs_more_evidence') {
      const result: EvidenceReviewResult = {
        decision: input.decision,
        candidateId: input.candidateId,
        supportingEvidence,
        contradictingEvidence,
        targetEntryIds,
        rationale: input.rationale ?? '',
        reviewRevision: document.revision,
      }
      this.evidenceReviewReceipts.push(clone(result))
      return result
    }
    const status: CandidateReviewStatus = input.decision === 'accept'
      ? 'accepted'
      : input.decision === 'reject' ? 'rejected' : 'conflict'
    const receipt = this.reviewCandidate(input.candidateId, status, input.baseRevision, input.rationale, input.documentId)
    if (receipt.result !== 'reviewed') throw new Error(receipt.errorCode ?? 'EVIDENCE_REVIEW_REJECTED')
    const result: EvidenceReviewResult = {
      decision: input.decision,
      candidateId: input.candidateId,
      supportingEvidence,
      contradictingEvidence,
      targetEntryIds,
      rationale: input.rationale ?? '',
      reviewRevision: receipt.nextRevision ?? input.baseRevision,
    }
    this.evidenceReviewReceipts.push(clone(result))
    return result
  }

  apply(proposal: DiffProposal): ApplyReceipt {
    return this.applyInternal(proposal)
  }

  private replay(proposal: DiffProposal): ApplyReceipt | undefined {
    const existing = this.receipts.get(proposal.idempotencyKey)
    if (!existing) return undefined
    if (existing.proposalHash === proposalHash(proposal)) return clone(existing)
    // Never replace the original receipt: a conflicting retry cannot poison a later exact replay.
    return { id: `receipt-${randomUUID()}`, proposalId: proposal.id, result: 'rejected', previousRevision: this.document.revision,
      changedEntryIds: [], errorCode: existing.proposalHash ? 'IDEMPOTENCY_KEY_CONFLICT' : 'IDEMPOTENCY_PAYLOAD_UNVERIFIABLE', createdAt: new Date().toISOString(), proposalHash: proposalHash(proposal) }
  }

  /** Record a deterministic preflight rejection while preserving idempotency and replay evidence. */
  rejectProposal(proposal: DiffProposal, errorCode: string): ApplyReceipt {
    const existing = this.replay(proposal)
    if (existing) return existing
    const receipt: ApplyReceipt = {
      id: `receipt-${randomUUID()}`,
      proposalId: proposal.id,
      result: 'rejected',
      previousRevision: this.document.revision,
      changedEntryIds: [],
      errorCode,
      createdAt: new Date().toISOString(),
      proposalHash: proposalHash(proposal),
    }
    this.receipts.set(proposal.idempotencyKey, receipt)
    return clone(receipt)
  }

  /**
   * Apply several proposals authored against one projection atomically. The
   * proposals share the same base revision and projection binding; the trial
   * engine advances its internal revision between proposals and is committed
   * only when every proposal is applied successfully.
   */
  applyBatch(proposals: readonly DiffProposal[]): ApplyReceipt[] {
    if (proposals.length === 0) return []
    if (new Set(proposals.map((proposal) => proposal.idempotencyKey)).size !== proposals.length) throw new Error('DUPLICATE_IDEMPOTENCY_KEY')
    const replays = proposals.map((proposal) => this.replay(proposal))
    const conflict = replays.find((receipt) => receipt && receipt.result !== 'applied')
    if (conflict) throw new Error(conflict.errorCode ?? 'CONTEXT_BATCH_REJECTED')
    if (replays.every((receipt) => receipt !== undefined)) return replays as ApplyReceipt[]
    if (replays.some((receipt) => receipt !== undefined)) throw new Error('CONTEXT_BATCH_PARTIAL_REPLAY')
    const baseRevision = this.document.revision
    const documentId = this.document.id
    const idempotencyKeys = new Set<string>()
    for (const proposal of proposals) {
      if (proposal.documentId !== documentId) throw new Error('DOCUMENT_ID_MISMATCH')
      if (proposal.baseRevision !== baseRevision) throw new Error('CONTEXT_REVISION_CONFLICT')
      if (idempotencyKeys.has(proposal.idempotencyKey)) throw new Error('DUPLICATE_IDEMPOTENCY_KEY')
      idempotencyKeys.add(proposal.idempotencyKey)
      const projection = this.projections.get(proposal.projectionId)
      if (!projection) throw new Error('PROJECTION_NOT_FOUND')
      if (projection.documentRevision !== baseRevision || projection.contentHash !== proposal.projectionHash) {
        throw new Error('PROJECTION_BINDING_CONFLICT')
      }
    }
    const trial = new ContextDocumentEngine(
      this.snapshot(),
      [...this.receipts.entries()],
      [...this.projections.entries()],
      this.reviewReceipts,
      this.evidenceReviewReceipts,
    )
    const receipts: ApplyReceipt[] = []
    for (const proposal of proposals) {
      const receipt = trial.applyInternal(proposal, { batchBaseRevision: baseRevision })
      if (receipt.result !== 'applied') throw new Error(receipt.errorCode ?? 'CONTEXT_BATCH_REJECTED')
      receipts.push(receipt)
    }
    const state = trial.exportState()
    this.document = clone(state.document)
    this.receipts.clear()
    for (const [key, receipt] of state.receipts) this.receipts.set(key, clone(receipt))
    this.projections.clear()
    for (const [id, projection] of state.projections) this.projections.set(id, clone(projection))
    this.reviewReceipts.length = 0
    this.reviewReceipts.push(...state.reviewReceipts.map((receipt) => clone(receipt)))
    this.evidenceReviewReceipts.length = 0
    this.evidenceReviewReceipts.push(...state.evidenceReviewReceipts.map((receipt) => clone(receipt)))
    return receipts.map((receipt) => clone(receipt))
  }

  private applyInternal(proposal: DiffProposal, options: { batchBaseRevision?: number } = {}): ApplyReceipt {
    const existing = this.replay(proposal)
    if (existing) return existing
    const previousRevision = this.document.revision
    const accept = (nextRevision: number, changedEntryIds: string[], changedNodeIds?: string[]): ApplyReceipt => {
      const receipt: ApplyReceipt = { id: `receipt-${randomUUID()}`, proposalId: proposal.id, result: 'applied', previousRevision, nextRevision,
        changedEntryIds, ...(changedNodeIds ? { changedNodeIds } : {}), ...(nextRevision === previousRevision ? { unchanged: true } : {}),
        createdAt: new Date().toISOString(), proposalHash: proposalHash(proposal) }
      this.receipts.set(proposal.idempotencyKey, receipt)
      return clone(receipt)
    }
    const reject = (result: ApplyReceipt['result'], errorCode: string, changedEntryIds: string[] = []): ApplyReceipt => {
      const receipt: ApplyReceipt = { id: `receipt-${randomUUID()}`, proposalId: proposal.id, result, previousRevision, changedEntryIds, errorCode, createdAt: new Date().toISOString(), proposalHash: proposalHash(proposal) }
      this.receipts.set(proposal.idempotencyKey, receipt)
      return clone(receipt)
    }
    if (proposal.documentId !== this.document.id) return reject('rejected', 'DOCUMENT_ID_MISMATCH')
    const batchBaseRevision = options.batchBaseRevision
    if (batchBaseRevision === undefined && proposal.baseRevision !== previousRevision) return reject('conflict', 'CONTEXT_REVISION_CONFLICT')
    if (batchBaseRevision !== undefined && proposal.baseRevision !== batchBaseRevision) return reject('conflict', 'CONTEXT_REVISION_CONFLICT')
    if (proposal.target.section !== 'information') return reject('rejected', 'TARGET_SECTION_INVALID')
    if (!(CONTEXT_DIFF_OPERATIONS as readonly string[]).includes(proposal.operation)) return reject('rejected', 'OPERATION_INVALID')
    if (proposal.diffVersion !== undefined && ![1, 2].includes(proposal.diffVersion)) return reject('rejected', 'DIFF_VERSION_INVALID')
    const structural = (CONTEXT_TREE_OPERATIONS as readonly string[]).includes(proposal.operation)
    if (!structural && (proposal.target.nodeId !== undefined || ['title', 'parentNodeId', 'beforeNodeId', 'childIds'].some((key) => proposal.payload[key as keyof RuntimeContextDiffPayload] !== undefined))) return reject('rejected', 'CONTENT_DIFF_STRUCTURE_INVALID')
    if (proposal.target.headingPath !== undefined && (!Array.isArray(proposal.target.headingPath) || proposal.target.headingPath.some((part) => typeof part !== 'string' || !part.trim()))) return reject('rejected', 'TARGET_HEADING_INVALID')
    if (proposal.payload.body !== undefined && typeof proposal.payload.body !== 'string') return reject('rejected', 'BODY_INVALID')
    if (proposal.payload.classification !== undefined) {
      try { validateContextClassification(proposal.payload.classification) } catch { return reject('rejected', 'CLASSIFICATION_INVALID') }
    }
    if (proposal.payload.evidenceRefs !== undefined && (!Array.isArray(proposal.payload.evidenceRefs) || proposal.payload.evidenceRefs.some((id) => typeof id !== 'string' || !id.trim()))) return reject('rejected', 'EVIDENCE_REF_INVALID')
    if (proposal.payload.status !== undefined && !['active', 'superseded', 'archived'].includes(proposal.payload.status)) return reject('rejected', 'STATUS_INVALID')
    if (proposal.operation === 'add_entry' && (proposal.target.entryId !== undefined || typeof proposal.payload.body !== 'string')) return reject('rejected', 'ADD_ENTRY_INVALID')
    if (proposal.operation === 'append_evidence' && (!Array.isArray(proposal.payload.evidenceRefs) || proposal.payload.evidenceRefs.length === 0)) return reject('rejected', 'EVIDENCE_REQUIRED')
    if (proposal.operation === 'mark_status' && proposal.payload.status === undefined) return reject('rejected', 'STATUS_REQUIRED')
    const projection = this.projections.get(proposal.projectionId)
    if (!projection) return reject('rejected', 'PROJECTION_NOT_FOUND')
    if (batchBaseRevision === undefined && projection.documentRevision !== proposal.baseRevision) return reject('conflict', 'PROJECTION_REVISION_CONFLICT')
    if (batchBaseRevision !== undefined && projection.documentRevision !== batchBaseRevision) return reject('conflict', 'PROJECTION_REVISION_CONFLICT')
    if (projection.contentHash !== proposal.projectionHash) return reject('conflict', 'PROJECTION_HASH_CONFLICT')
    if (structural) {
      const error = contextTreeProposalError(proposal, projection.treeNodes)
      if (error) return reject(error === 'TREE_NODE_HASH_CONFLICT' ? 'conflict' : 'rejected', error)
      if (contextTreeHashes(this.document.tree!, this.document.information).get(proposal.target.nodeId!) !== proposal.targetNodeHash) return reject('conflict', 'TREE_NODE_HASH_CONFLICT')
    }
    const candidate = this.document.candidates.find((item) => item.id === proposal.candidateId)
    if (!candidate) return reject('rejected', 'CANDIDATE_NOT_FOUND')
    if (projection.sourceCandidateIds !== undefined && !projection.sourceCandidateIds.includes(candidate.id)) return reject('rejected', 'CANDIDATE_NOT_IN_PROJECTION')
    if (['rejected', 'stale', 'irrelevant', 'superseded'].includes(candidate.status)) return reject('rejected', 'CANDIDATE_NOT_APPLICABLE')
    if (candidate.status === 'conflict') return reject('rejected', 'UNRESOLVED_CANDIDATE_CONFLICT')
    if (candidate.evidenceRefs.length === 0) return reject('rejected', 'EVIDENCE_REQUIRED')
    if (!candidate.evidenceRefs.every((id) => this.document.evidence.some((item) => item.id === id))) return reject('rejected', 'EVIDENCE_NOT_FOUND')
    if (proposal.payload.evidenceRefs && !proposal.payload.evidenceRefs.every((id) => this.document.evidence.some((item) => item.id === id))) return reject('rejected', 'EVIDENCE_NOT_FOUND')
    if (proposal.payload.evidenceRefs && !proposal.payload.evidenceRefs.every((id) => candidate.evidenceRefs.includes(id))) return reject('rejected', 'EVIDENCE_NOT_BOUND')
    const entry = proposal.target.entryId ? this.document.information.find((item) => item.id === proposal.target.entryId) : undefined
    if (proposal.target.entryId && !entry) return reject('rejected', 'ENTRY_NOT_FOUND')
    if (entry && projection.sourceEntryIds !== undefined && !projection.sourceEntryIds.includes(entry.id)) return reject('rejected', 'ENTRY_NOT_IN_PROJECTION')
    if (entry && proposal.targetEntryHash && sha256(entry.body) !== proposal.targetEntryHash) return reject('conflict', 'ENTRY_HASH_CONFLICT', [entry.id])
    if (!structural && proposal.operation !== 'add_entry' && !entry) return reject('rejected', 'ENTRY_REQUIRED')
    const nextRevision = previousRevision + 1
    const next = clone(this.document)
    const changedEntryIds: string[] = []
    let changedNodeIds: string[] | undefined
    if (structural) {
      try {
        const change = applyContextTreeOperation(next.tree!, next.information, proposal.operation, proposal.target.nodeId!, proposal.payload)
        if (change.changedNodeIds.length === 0) return accept(previousRevision, [], [])
        changedEntryIds.push(...change.changedEntryIds)
        changedNodeIds = change.changedNodeIds
        const changedEntries = new Set(changedEntryIds)
        for (const value of next.information) if (changedEntries.has(value.id)) value.revision = nextRevision
      } catch (error) { return reject('rejected', error instanceof Error ? error.message : 'CONTEXT_TREE_INVALID') }
    } else if (proposal.operation === 'add_entry') {
      const value: InformationEntry = { id: `info-${randomUUID()}`, sectionId: 'information', headingPath: proposal.target.headingPath ?? [], body: proposal.payload.body ?? '', status: 'active', evidenceRefs: proposal.payload.evidenceRefs ?? candidate.evidenceRefs, sourceCandidateIds: [candidate.id], supersedesEntryIds: [], revision: nextRevision, ...(proposal.payload.classification ?? candidate.classification ? { classification: proposal.payload.classification ?? candidate.classification } : {}) }
      next.information.push(value)
      try { insertContextEntry(next.tree!, next.id, value.id, value.headingPath) }
      catch (error) { return reject('rejected', error instanceof Error ? error.message : 'CONTEXT_TREE_INVALID') }
      changedEntryIds.push(value.id)
    } else {
      const target = next.information.find((item) => item.id === entry?.id) as InformationEntry
      if (proposal.operation === 'replace_body') {
        const replacement: InformationEntry = {
          ...target,
          id: `info-${randomUUID()}`,
          body: proposal.payload.body ?? target.body,
          evidenceRefs: proposal.payload.evidenceRefs ?? target.evidenceRefs,
          status: 'active',
          sourceCandidateIds: [...new Set([...target.sourceCandidateIds, candidate.id])],
          supersedesEntryIds: [...new Set([...(target.supersedesEntryIds ?? []), target.id])],
          revision: nextRevision,
          ...(proposal.payload.classification ?? candidate.classification ? { classification: proposal.payload.classification ?? candidate.classification } : {}),
        }
        target.status = 'superseded'
        target.revision = nextRevision
        const targetIndex = next.information.findIndex((item) => item.id === target.id)
        next.information.splice(targetIndex + 1, 0, replacement)
        insertContextSuccessor(next.tree!, target.id, replacement.id)
        changedEntryIds.push(target.id, replacement.id)
      } else {
        if (proposal.operation === 'append_evidence') target.evidenceRefs = [...new Set([...target.evidenceRefs, ...(proposal.payload.evidenceRefs ?? [])])]
        if (proposal.operation === 'mark_status' && proposal.payload.status) target.status = proposal.payload.status
        target.revision = nextRevision
        changedEntryIds.push(target.id)
      }
    }
    validateContextTree(next.tree!, next.information)
    const entryIds = new Set(next.information.map(entry => entry.id))
    next.sections.find((item) => item.kind === 'information')!.entries = contextTreeOrder(next.tree!).filter(id => entryIds.has(id))
    const nextCandidate = next.candidates.find((item) => item.id === candidate.id) as CandidateBlock
    nextCandidate.status = 'accepted'
    nextCandidate.reviewedAt = new Date().toISOString()
    nextCandidate.proposedDiffIds = [...new Set([...nextCandidate.proposedDiffIds, proposal.id])]
    next.sections.find((item) => item.kind === 'information')!.revision = nextRevision
    next.sections.find((item) => item.kind === 'candidates')!.revision = nextRevision
    next.revision = nextRevision
    next.parentRevision = previousRevision
    next.updatedAt = new Date().toISOString()
    this.document = next
    return accept(nextRevision, changedEntryIds, changedNodeIds)
  }

  project(profile: ProjectionProfile): Projection {
    if (!profile.id || !Number.isInteger(profile.maxCharacters) || profile.maxCharacters < 256) throw new Error('PROJECTION_PROFILE_INVALID')
    const sectionOrder = profile.sectionOrder ?? [...SECTION_KINDS]
    if (profile.includeSections && (new Set(profile.includeSections).size !== profile.includeSections.length
      || profile.includeSections.some((kind) => !SECTION_KINDS.includes(kind)))) throw new Error('PROJECTION_SECTIONS_INVALID')
    if (!Array.isArray(sectionOrder) || sectionOrder.length !== SECTION_KINDS.length
      || new Set(sectionOrder).size !== SECTION_KINDS.length
      || sectionOrder.some((kind) => !SECTION_KINDS.includes(kind))) throw new Error('PROJECTION_SECTION_ORDER_INVALID')
    if (profile.pinnedCandidateIds !== undefined
      && (!Array.isArray(profile.pinnedCandidateIds)
        || profile.pinnedCandidateIds.some((id) => typeof id !== 'string' || !id.trim())
        || new Set(profile.pinnedCandidateIds).size !== profile.pinnedCandidateIds.length)) {
      throw new Error('PROJECTION_PINNED_CANDIDATES_INVALID')
    }
    const includeStatuses = new Set(profile.includeStatuses ?? ['pending', 'conflict'])
    if (profile.pinnedEntryIds && (new Set(profile.pinnedEntryIds).size !== profile.pinnedEntryIds.length || profile.pinnedEntryIds.some((id) => typeof id !== 'string' || !id.trim()))) throw new Error('PROJECTION_PINNED_ENTRIES_INVALID')
    const pinnedEntries = new Set(profile.pinnedEntryIds ?? [])
    const pinnedHeadings = new Set(profile.pinnedHeadingIds ?? [])
    const positions = new Map(contextTreeOrder(this.document.tree!).map((id, index) => [id, index]))
    const information = this.document.information
      .filter((entry) => entry.status === 'active')
      .sort((a, b) => {
        const priority = Number(pinnedEntries.has(b.id)) - Number(pinnedEntries.has(a.id))
        if (priority) return priority
        return positions.get(a.id)! - positions.get(b.id)!
      })
    const excluded = new Set(profile.excludeCandidateIds)
    const candidates = this.document.candidates
      .filter((candidate) => !excluded.has(candidate.id)
        && (includeStatuses.has(candidate.status) || (candidate.status === 'accepted' && profile.pinnedCandidateIds?.includes(candidate.id))))
      .sort((a, b) => {
        const left = `${a.source.capturedAt}\u0000${a.id}`
        const right = `${b.source.capturedAt}\u0000${b.id}`
        return compareText(left, right)
      })
    const sourceEntryIds: string[] = []
    let treeNodes: RuntimeContextTreeBinding[] | undefined
    const sourceCandidateIds: string[] = []
    const truncatedSections: string[] = []
    const selectionReasons: Record<string, string[]> = {}
    const chunks: string[] = []
    const evidenceById = new Map(profile.compactReferences ? this.document.evidence.map(item => [item.id, item] as const) : [])
    const evidenceReferences = (ids: string[]) => ids.map(id => {
      const item = evidenceById.get(id)
      if (!item) return { id }
      const { kind, referenceId, locator, observedAt, confidence } = item
      const fileLocation = profile.fileEvidenceLocation?.(item)
      return { id, kind, referenceId, ...(fileLocation ?? { locator }), observedAt, confidence }
    })
    const informationReference = (entry: InformationEntry,
      encodeEvidence: (evidence: ReturnType<typeof evidenceReferences>[number]) => object = evidence => evidence): string =>
      referenceMarker('entry', { id: entry.id, sourceCandidateIds: entry.sourceCandidateIds,
        evidence: evidenceReferences(entry.evidenceRefs).map(encodeEvidence), classification: entry.classification })
    const separator = '\n\n---\n\n'
    const sectionHeader = (kind: ContextSectionKind): string => `${this.sectionMarker(kind)}\n# ${SECTION_LABELS[kind]}`
    const omitted = (kind: ContextSectionKind): string => `${sectionHeader(kind)}\n[${kind} section omitted by projection budget]`
    const candidateItems = (!profile.includeSections || profile.includeSections.includes('candidates')) ? candidates.map(candidate => {
      const { actor, toolName, sourceId, capturedAt } = candidate.source
      const bodyReference = profile.candidateBodyReferences?.get(candidate.id)
      const resourceLoad = profile.resourceLoadCandidateIds?.has(candidate.id)
      if (profile.compactReferences && !candidate.classification && candidate.evidenceRefs.length === 1 && (bodyReference || resourceLoad)) {
        return { id: candidate.id, actor, rendered: referenceMarker('candidate', {
          id: candidate.id, status: candidate.status, source: { actor, toolName, capturedAt }, rawArtifactId: candidate.rawArtifactId,
          evidence: [{ id: candidate.evidenceRefs[0] }], body: resourceLoad ? 'resource_load_receipt' : 'tool_result',
        }) }
      }
      const reference = profile.compactReferences ? referenceMarker('candidate', {
        id: candidate.id, source: { actor, toolName, sourceId, capturedAt }, rawArtifactId: candidate.rawArtifactId,
        evidence: evidenceReferences(candidate.evidenceRefs), classification: candidate.classification,
      }) : undefined
      return { id: candidate.id, actor, rendered: this.renderCandidate(candidate, bodyReference, reference) }
    }) : []
    const pinnedCandidates = new Set(profile.pinnedCandidateIds ?? [])
    const candidateAnchor = profile.candidateSelection === 'anchor-latest' ? candidateItems.find(item => item.actor === 'user') : undefined
    const reservedCandidates = candidateItems.filter(item => item !== candidateAnchor && pinnedCandidates.has(item.id))
    if (candidateAnchor) reservedCandidates.unshift(candidateAnchor)
    let candidateReserve = 0
    // A later candidate section still needs room for the current instruction or recalled source.
    for (const item of reservedCandidates) {
      const characters = item.rendered.length + (candidateReserve === 0 ? sectionHeader('candidates').length + 1 : 2)
      if (candidateReserve + characters <= profile.maxCharacters) candidateReserve += characters
    }
    let usedCharacters = 0
    const appendedLength = (value: string) => usedCharacters + (chunks.length ? separator.length : 0) + value.length
    const fitsChunk = (value: string) => appendedLength(value) + (candidateReserve ? separator.length + candidateReserve : 0) <= profile.maxCharacters
    const appendChunk = (value: string): boolean => {
      if (!fitsChunk(value)) return false
      usedCharacters = appendedLength(value)
      chunks.push(value)
      return true
    }
    const appendFull = (kind: ContextSectionKind, body: string, ids: { entries?: string[]; candidates?: string[] } = {}): boolean => {
      const value = `${sectionHeader(kind)}${body ? `\n${body}` : ''}`
      if (!appendChunk(value)) return false
      for (const id of ids.entries ?? []) {
        sourceEntryIds.push(id)
        selectionReasons[id] = ['stable-order', 'status-filter', 'budget-fit']
      }
      for (const id of ids.candidates ?? []) {
        sourceCandidateIds.push(id)
        selectionReasons[id] = ['stable-order', 'status-filter', 'budget-fit']
      }
      return true
    }
    const appendBoundedItems = (kind: 'information' | 'candidates', items: Array<{ id: string; rendered: string; actor?: CandidateActor }>): void => {
      const policy = kind === 'candidates' ? (profile.candidateSelection ?? 'chronological') : 'chronological'
      const pinned = kind === 'candidates' ? pinnedCandidates : pinnedEntries
      const ordered = kind === 'candidates' && (policy === 'anchor-latest' || pinned.size > 0) && items.length > 1
        ? (() => {
          const anchorIndex = policy === 'anchor-latest' ? items.findIndex((item) => item.actor === 'user') : -1
          const indices: number[] = []
          if (anchorIndex >= 0) indices.push(anchorIndex)
          for (let index = 0; index < items.length; index += 1) {
            if (index !== anchorIndex && pinned.has(items[index]!.id)) indices.push(index)
          }
          if (policy === 'anchor-latest') {
            for (let index = items.length - 1; index >= 0; index -= 1) {
              if (index !== anchorIndex && !pinned.has(items[index]!.id)) indices.push(index)
            }
          } else {
            for (let index = 0; index < items.length; index += 1) {
              if (index !== anchorIndex && !pinned.has(items[index]!.id)) indices.push(index)
            }
          }
          return indices.map((index) => items[index] as typeof items[number])
        })()
        : items
      const selected: string[] = []
      const selectedIds: string[] = []
      for (const item of ordered) {
        const body = [...selected, item.rendered].join('\n\n')
        const value = `${sectionHeader(kind)}\n${body}`
        if (!fitsChunk(value)) continue
        selected.push(item.rendered)
        selectedIds.push(item.id)
      }
      if (policy === 'anchor-latest') {
        const chronological = items.filter((item) => selectedIds.includes(item.id))
        selected.splice(0, selected.length, ...chronological.map((item) => item.rendered))
        selectedIds.splice(0, selectedIds.length, ...chronological.map((item) => item.id))
      }
      if (selected.length > 0) {
        appendChunk(`${sectionHeader(kind)}\n${selected.join('\n\n')}`)
        const destination = kind === 'information' ? sourceEntryIds : sourceCandidateIds
        for (const id of selectedIds) {
          destination.push(id)
          selectionReasons[id] = [
            'stable-order',
            'status-filter',
            'budget-fit',
            ...(pinned.has(id) ? [kind === 'information' ? 'pinned-entry' : 'pinned-candidate'] : []),
            ...(policy === 'anchor-latest' && !pinned.has(id) ? ['latest-window'] : []),
          ]
        }
      }
      if (selected.length !== items.length) truncatedSections.push(kind)
      if (selected.length === 0) appendChunk(omitted(kind))
    }
    const appendRaw = (kind: ContextSectionKind, body: string): void => {
      if (!appendFull(kind, body)) {
        appendChunk(omitted(kind))
        truncatedSections.push(kind)
      }
    }
    const appendInformationTree = (): void => {
      const tree = this.document.tree!, selected: string[] = [], selectedHeadings: string[] = []
      const allNodes = contextTreeBindings(tree, this.document.information, information.map((entry) => entry.id), tree.headings.map((heading) => heading.id))
      const byId = new Map(allNodes.map((node) => [node.id, node]))
      const nodePositions = new Map(allNodes.map((node, index) => [node.id, index]))
      const entries = new Map(information.map((entry) => [entry.id, entry]))
      const render = (ids: string[], headings: string[]) => {
        const visible = new Set(['information', ...ids, ...headings])
        for (const id of [...visible]) { let parent = byId.get(id)?.parentId; while (parent) { visible.add(parent); parent = byId.get(parent)?.parentId } }
        const ordered = [...visible].map((id) => byId.get(id)!).sort((a, b) => nodePositions.get(a.id)! - nodePositions.get(b.id)!)
        const visibleChildren = new Map<string, string[]>()
        for (const node of ordered) if (node.parentId) {
          const children = visibleChildren.get(node.parentId) ?? []
          children.push(node.id); visibleChildren.set(node.parentId, children)
        }
        const nodes = ordered.map((node) => ({ ...node, ...(node.childIds ? { childIds: visibleChildren.get(node.id) ?? [] } : {}) }))
        const fileSources: object[] = [], sourceReferences = new Map<string, number>()
        const encodeEvidence = (evidence: ReturnType<typeof evidenceReferences>[number]): object => {
          if (!('file' in evidence) || evidence.file === undefined) return evidence
          const { id, line, ...source } = evidence
          const key = JSON.stringify(source)
          const existing = sourceReferences.get(key)
          const index = existing ?? fileSources.length + 1
          if (existing === undefined) {
            fileSources.push(source)
            sourceReferences.set(key, index)
          }
          return { id, source: index, line }
        }
        const renderNode = (id: string, depth: number): string => {
          const node = byId.get(id)!, entry = entries.get(id)
          if (entry) {
            const metadata = profile.compactReferences ? informationReference(entry, encodeEvidence) : `${entryMarker(id)}\n${informationMetaMarker(entry)}`
            return `${metadata}\n${entry.body}`
          }
          const children = (visibleChildren.get(id) ?? []).map((child) => renderNode(child, depth + 1)).join('\n\n')
          return `${id === 'information' ? '' : `${'#'.repeat(Math.min(depth + 1, 6))} ${node.title}\n`}${children}`.trim()
        }
        const body = renderNode('information', 0)
        const references = new Map(nodes.map((node, index) => [node.id, index + 1]))
        const layout = profile.compactReferences ? { version: 2,
          columns: ['id', 'kind', 'hash', 'parent', 'title', 'children', 'totalChildren'],
          nodes: nodes.map(node => {
            const row = [node.id, node.kind, node.hash, node.parentId ? references.get(node.parentId) : undefined,
              node.title, node.childIds?.map(id => references.get(id)), node.totalChildren]
            while (row.at(-1) === undefined) row.pop()
            return row
          }),
          ...(fileSources.length ? { fileSources } : {}),
        } : { version: 1, nodes }
        return { nodes, value: `${sectionHeader('information')}\n<!-- capybara:tree data=${JSON.stringify(layout).replaceAll('-->', '--\\u003e')} -->\n${body}`.trimEnd() }
      }
      const addEntry = (id: string) => { if (fitsChunk(render([...selected, id], selectedHeadings).value)) selected.push(id) }
      const addHeading = (id: string) => { if (fitsChunk(render(selected, [...selectedHeadings, id]).value)) selectedHeadings.push(id) }
      // Keep required facts first, then preserve the addresses used by layout edits.
      for (const entry of information) if (pinnedEntries.has(entry.id)) addEntry(entry.id)
      for (const heading of tree.headings) if (pinnedHeadings.has(heading.id)) addHeading(heading.id)
      for (const entry of information) if (!pinnedEntries.has(entry.id)) addEntry(entry.id)
      for (const heading of tree.headings) if (!pinnedHeadings.has(heading.id) && heading.children.length === 0) addHeading(heading.id)
      const rendered = render(selected, selectedHeadings)
      if (appendChunk(rendered.value)) {
        treeNodes = rendered.nodes
        for (const node of rendered.nodes) if (node.kind === 'entry') {
          sourceEntryIds.push(node.id)
          selectionReasons[node.id] = ['tree-order', 'status-filter', 'budget-fit', ...(pinnedEntries.has(node.id) ? ['pinned-entry'] : [])]
        } else if (node.kind === 'heading' && pinnedHeadings.has(node.id)) selectionReasons[node.id] = ['tree-order', 'budget-fit', 'pinned-heading']
      } else appendChunk(omitted('information'))
      const visibleNodeIds = new Set(treeNodes?.map(node => node.id))
      if (sourceEntryIds.length !== information.length || !treeNodes
        || tree.headings.some(heading => (pinnedHeadings.has(heading.id) || heading.children.length === 0) && !visibleNodeIds.has(heading.id))) truncatedSections.push('information')
    }
    for (const kind of sectionOrder) {
      if (profile.includeSections && !profile.includeSections.includes(kind)) continue
      if (kind === 'tools' && profile.includeTools === false) continue
      if (kind === 'information') {
        if (profile.includeStructure) appendInformationTree()
        else appendBoundedItems(kind, information.map(entry => ({ id: entry.id, rendered: profile.compactReferences
          ? `${informationReference(entry)}\n## ${entry.headingPath.join(' / ') || entry.id}\n${entry.body}`
          : this.renderInformationEntry(entry) })))
      } else if (kind === 'candidates') {
        candidateReserve = 0
        appendBoundedItems(kind, candidateItems)
      } else {
        appendRaw(kind, this.section(kind))
      }
    }
    const markdown = chunks.join(separator)
    const contentHash = sha256(markdown)
    const projection: Projection = { id: `projection-${sha256(`${this.document.id}\u0000${this.document.revision}\u0000${profile.id}\u0000${contentHash}`).slice(0, 32)}`, documentRevision: this.document.revision, profileId: profile.id, sourceEntryIds, ...(treeNodes ? { treeNodes } : {}), sourceCandidateIds, sourceMessageCursor: this.document.messageCursor, truncatedSections: [...new Set(truncatedSections)], selectionReasons, markdown, contentHash, createdAt: this.document.updatedAt }
    this.projections.set(projection.id, {
      documentRevision: projection.documentRevision,
      contentHash: projection.contentHash,
      sourceEntryIds: [...projection.sourceEntryIds],
      sourceCandidateIds: [...projection.sourceCandidateIds],
      ...(projection.treeNodes ? { treeNodes: clone(projection.treeNodes) } : {}),
    })
    return projection
  }

  serialize(): string {
    const sections = SECTION_KINDS.map((kind) => {
      const section = this.document.sections.find((item) => item.kind === kind) as ContextSection
      const body = kind === 'information'
        ? this.document.information.map((entry) => this.renderInformationEntry(entry)).join('\n\n')
        : kind === 'candidates'
          ? `${evidenceMetaMarker(this.document.evidence)}${this.document.candidates.length > 0 ? `\n\n${this.document.candidates.map((candidate) => this.renderCandidate(candidate)).join('\n\n')}` : ''}`
          : section.content
      return `${marker(kind, section.id, section.revision)}\n# ${SECTION_LABELS[kind]}\n${body}`
    }).join('\n\n---\n\n')
    return `${documentMetadataMarker(this.document)}\n\n${sections}`
  }

  private section(kind: ContextSectionKind): string {
    return this.document.sections.find((item) => item.kind === kind)?.content ?? ''
  }

  private sectionMarker(kind: ContextSectionKind): string {
    const section = this.document.sections.find((item) => item.kind === kind) as ContextSection
    return marker(kind, section.id, section.revision)
  }

  private touch(): void {
    this.document.updatedAt = new Date().toISOString()
  }

  private bumpRevision(sectionKinds: ContextSectionKind[] = []): void {
    this.document.parentRevision = this.document.revision
    this.document.revision += 1
    for (const kind of sectionKinds) {
      const section = this.document.sections.find((item) => item.kind === kind)
      if (section) section.revision = this.document.revision
    }
  }

  private renderInformationEntry(entry: InformationEntry): string {
    return `${entryMarker(entry.id)}\n${informationMetaMarker(entry)}\n## ${entry.headingPath.join(' / ') || entry.id}\n${entry.body}`
  }

  private renderCandidate(candidate: CandidateBlock, originalInToolHistory?: string, reference = candidateMetaMarker(candidate)): string {
    const body = originalInToolHistory
      ? `正文见工具读取 ${originalInToolHistory}，对应工具回执中的 resultArtifactId。`
      : candidate.normalizedContent
    return `${reference}\n## ${candidate.id}\n状态：${candidate.status}\n${body}`
  }
}
