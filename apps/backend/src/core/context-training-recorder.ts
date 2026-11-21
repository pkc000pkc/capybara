import { createHash } from 'node:crypto'

import { ContextDocumentEngine, type ContextDocumentEngineState } from '#core/context-document-engine'
import type { ContextClassification } from '#core/context-classification'
import type { RuntimeLoopState } from '#core/runtime-loop-state'
import type { RuntimeContextScopeKind } from '#protocol/runtime-protocol'
import type { LlmChatResponse, LlmConfig, LlmMessage } from '#util/llm'
import type { ContextCoverage } from '#core/context-history'
import type { ContextArchiveRecord, OrganizationOutput } from '#core/context-organizer'
import type { OrganizationDocumentView, OrganizationReferenceBinding, OrganizationModelProposal } from '#core/context-organizer-reference-protocol'
import type { ModelBudgetAttemptEvidence, ModelBudgetScope } from '#core/runtime-model-budget'

type PromptBinding = { role: string; version: string; hash: string }

export interface ContextOrganizationRequestEvidence {
  artifactId: string
  budgetScope: ModelBudgetScope
  actorSessionId: string
  inputHash: string
  promptBindings: PromptBinding[]
  organizationVersion: 1 | 2 | 3 | 4
  documentView: OrganizationDocumentView
  requestedModel: Pick<LlmConfig, 'provider' | 'protocol' | 'model'>
  maxInputTokens: number
  contextWindowTokens: number
  maxOutputTokens: number
  response?: Pick<LlmChatResponse, 'provider' | 'model' | 'finishReason'> & { artifactId: string }
  accounting: 'provider_request' | 'request_view'
  transportAttempts: ModelBudgetAttemptEvidence[]
}

export interface ContextOrganizationTrainingAttempt {
  messages: LlmMessage[]
  rawOutput: string
  proposal?: OrganizationOutput | OrganizationModelProposal
  referenceBinding?: OrganizationReferenceBinding
  requestEvidence?: ContextOrganizationRequestEvidence
}

export interface ContextOrganizationTrainingExecution {
  schemaVersion: 1 | 2
  committed: boolean
  outcome?: 'committed' | 'no_change' | 'rejected'
  errorCode?: string
  commitId?: string
  promptBindings: PromptBinding[]
  attempts: ContextOrganizationTrainingAttempt[]
  runtimeState: unknown
  coverageBefore: ContextCoverage
  coverageAfter: ContextCoverage
  sourceArchives?: ContextArchiveRecord[]
}

export type ContextTrainingMessage = { role: string; message: string; id?: string; createdAt?: string }

export type ContextTrainingOperation = {
  scope?: RuntimeContextScopeKind
  classification?: ContextClassification
  action: 'add' | 'replace' | 'append' | 'delete' | 'mark_status' | 'add_heading' | 'rename_heading' | 'move_node' | 'reorder_children'
  diffVersion?: 1 | 2
  structure?: { title?: string; parentNodeId?: string; beforeNodeId?: string | null; childIds?: string[]; targetNodeHash?: string }
  position: { section: string; path?: number[]; nodeId?: string }
  content?: string
  reason: string
  sourceRefs: string[]
  evidenceRefs: string[]
}

export type ContextTrainingReceipt = {
  kind: 'apply' | 'candidate_review' | 'evidence_review'
  id: string
  result: string
  subjectId: string
  /** A transport retry can reference the original immutable receipt for a different proposal ID. */
  attemptProposalId?: string
  replayed?: boolean
  previousRevision?: number
  nextRevision?: number
  errorCode?: string
  changedEntryIds?: string[]
  changedNodeIds?: string[]
  unchanged?: true
  createdAt: string
}

export type ContextTrainingCandidateReview = {
  id: string
  candidateId: string
  result: 'reviewed' | 'conflict' | 'rejected'
  status?: string
  reason?: string
  previousRevision: number
  nextRevision?: number
  evidenceRefs: string[]
  createdAt: string
}

export type ContextTrainingEvidenceReview = {
  candidateId: string
  decision: 'accept' | 'reject' | 'conflict' | 'needs_more_evidence'
  supportingEvidence: string[]
  contradictingEvidence: string[]
  targetEntryIds: string[]
  rationale: string
  reviewRevision: number
  createdAt: string
}

export type ContextTrainingArchiveRecord = {
  id: string
  scope: RuntimeContextScopeKind
  entryId?: string
  operationId: string
  result: 'applied' | 'rejected' | 'conflict'
  body?: string
  headingPath?: string[]
  evidenceRefs: string[]
  sourceCandidateIds: string[]
  reason: string
  createdAt: string
}

export type ContextTrainingRecallRecord = {
  id: string
  scope: RuntimeContextScopeKind
  query: string
  candidateIds: string[]
  sourceArchiveIds?: string[]
  sources?: Array<{ scope: RuntimeContextScopeKind; documentId?: string; sourceId: string; sourceRef?: string; sourceKind: string; candidateId?: string; evidenceRefs: string[]; originalStatus: string }>
  archivedEntryIds: string[]
  selectedIds: string[]
  reasons: Record<string, string>
  createdAt: string
}

export type ContextTrainingConflictRecord = {
  id: string
  candidateId: string
  evidenceRefs: string[]
  supportingEvidence: string[]
  contradictingEvidence: string[]
  rationale: string
  preserved: true
  createdAt: string
}

export type ContextTrainingSample = {
  /** Set when sampling starts, so failed telemetry cannot fall back to a legacy authority target. */
  task?: 'context_organization'
  organization?: ContextOrganizationTrainingExecution
  schemaVersion: 2
  sampleId: string
  scope: RuntimeContextScopeKind
  projectId: string
  sessionId: string
  runId?: string
  createdAt: string
  input: {
    projectContext: string
    projectContextRevision: number
    context: string
    cache: unknown[]
    rawCache: unknown
    messages: ContextTrainingMessage[]
    rawMessages: unknown[]
    systemPrompt: string
    contextRevision: number
    runtimeState?: unknown
  }
  proposal?: { baseRevision: number; operations: ContextTrainingOperation[]; createdAt: string }
  decision?: {
    acceptedOperations: string[]
    rejectedOperations: string[]
    archivedNodeIds: string[]
    recallLinks: string[]
    receipts?: ContextTrainingReceipt[]
    candidateReviews?: ContextTrainingCandidateReview[]
    evidenceReviews?: ContextTrainingEvidenceReview[]
    archiveRecords?: ContextTrainingArchiveRecord[]
    recalls?: ContextTrainingRecallRecord[]
    preservedConflicts?: ContextTrainingConflictRecord[]
    decidedAt: string
  }
  output?: { projectContext?: string; projectContextRevision?: number; context: string; contextRevision: number; archivedNodeIds: string[]; recallLinks: string[]; completedAt: string }
}

export type ContextTrainingRecorderInput = Omit<ContextTrainingSample, 'schemaVersion' | 'createdAt' | 'proposal' | 'decision' | 'output'> & { schemaVersion?: 2; createdAt?: string }

function clone<T>(value: T): T {
  return structuredClone(value)
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export class ContextTrainingRecorder {
  private readonly samples = new Map<string, ContextTrainingSample>()

  attachOrganization(sampleId: string, execution: ContextOrganizationTrainingExecution): void {
    const sample = this.require(sampleId)
    if (sample.organization) throw new Error('ORGANIZATION_TRAINING_ALREADY_RECORDED')
    sample.organization = clone(execution)
  }

  begin(input: ContextTrainingRecorderInput): ContextTrainingSample {
    if (this.samples.has(input.sampleId)) throw new Error(`context training sample already exists: ${input.sampleId}`)
    const sample: ContextTrainingSample = {
      ...clone(input),
      schemaVersion: 2,
      createdAt: input.createdAt ?? new Date().toISOString(),
      input: clone(input.input),
    }
    this.samples.set(sample.sampleId, sample)
    return clone(sample)
  }

  recordProposal(sampleId: string, proposal: { baseRevision: number; operations: ContextTrainingOperation[]; createdAt?: string }): ContextTrainingSample {
    const sample = this.require(sampleId)
    if (sample.proposal) throw new Error(`context training proposal already exists: ${sampleId}`)
    sample.proposal = { baseRevision: proposal.baseRevision, operations: clone(proposal.operations), createdAt: proposal.createdAt ?? new Date().toISOString() }
    return clone(sample)
  }

  recordDecision(sampleId: string, decision: Omit<NonNullable<ContextTrainingSample['decision']>, 'decidedAt'> & { decidedAt?: string }): ContextTrainingSample {
    const sample = this.require(sampleId)
    const previous = sample.decision
    sample.decision = {
      acceptedOperations: [...new Set([...(previous?.acceptedOperations ?? []), ...decision.acceptedOperations])],
      rejectedOperations: [...new Set([...(previous?.rejectedOperations ?? []), ...decision.rejectedOperations])],
      archivedNodeIds: [...new Set([...(previous?.archivedNodeIds ?? []), ...decision.archivedNodeIds])],
      recallLinks: [...new Set([...(previous?.recallLinks ?? []), ...decision.recallLinks])],
      ...(previous?.receipts || decision.receipts ? { receipts: [...(previous?.receipts ?? []), ...(decision.receipts ?? [])] } : {}),
      ...(previous?.candidateReviews || decision.candidateReviews ? { candidateReviews: [...(previous?.candidateReviews ?? []), ...(decision.candidateReviews ?? [])] } : {}),
      ...(previous?.evidenceReviews || decision.evidenceReviews ? { evidenceReviews: [...(previous?.evidenceReviews ?? []), ...(decision.evidenceReviews ?? [])] } : {}),
      ...(previous?.archiveRecords || decision.archiveRecords ? { archiveRecords: [...(previous?.archiveRecords ?? []), ...(decision.archiveRecords ?? [])] } : {}),
      ...(previous?.recalls || decision.recalls ? { recalls: [...(previous?.recalls ?? []), ...(decision.recalls ?? [])] } : {}),
      ...(previous?.preservedConflicts || decision.preservedConflicts ? { preservedConflicts: [...(previous?.preservedConflicts ?? []), ...(decision.preservedConflicts ?? [])] } : {}),
      decidedAt: decision.decidedAt ?? previous?.decidedAt ?? new Date().toISOString(),
    }
    return clone(sample)
  }

  recordDecisionEvent(sampleId: string, event: Partial<Omit<NonNullable<ContextTrainingSample['decision']>, 'decidedAt'>>): ContextTrainingSample {
    const current = this.require(sampleId).decision
    return this.recordDecision(sampleId, {
      acceptedOperations: [],
      rejectedOperations: [],
      archivedNodeIds: [],
      recallLinks: [],
      ...(current?.receipts ? { receipts: [] } : {}),
      ...(current?.candidateReviews ? { candidateReviews: [] } : {}),
      ...(current?.evidenceReviews ? { evidenceReviews: [] } : {}),
      ...(current?.archiveRecords ? { archiveRecords: [] } : {}),
      ...(current?.recalls ? { recalls: [] } : {}),
      ...(current?.preservedConflicts ? { preservedConflicts: [] } : {}),
      ...clone(event),
    })
  }

  complete(sampleId: string, output: Omit<NonNullable<ContextTrainingSample['output']>, 'completedAt'> & { completedAt?: string }): ContextTrainingSample {
    const sample = this.require(sampleId)
    if (!sample.proposal && !sample.decision) throw new Error(`context training sample has no target: ${sampleId}`)
    sample.output = { ...clone(output), completedAt: output.completedAt ?? new Date().toISOString() }
    return clone(sample)
  }

  get(sampleId: string): ContextTrainingSample | undefined {
    const sample = this.samples.get(sampleId)
    return sample ? clone(sample) : undefined
  }

  snapshot(): ContextTrainingSample[] {
    return [...this.samples.values()].map((sample) => clone(sample))
  }

  restore(samples: readonly ContextTrainingSample[]): void {
    this.samples.clear()
    for (const sample of samples) {
      if (this.samples.has(sample.sampleId)) throw new Error(`duplicate context training sample: ${sample.sampleId}`)
      this.samples.set(sample.sampleId, clone(sample))
    }
  }

  /** Capture the algorithm's required input directly from RuntimeLoop export state. */
  captureRuntimeInput(input: {
    sampleId: string
    scope: RuntimeContextScopeKind
    projectId: string
    sessionId: string
    runId?: string
    systemPrompt: string
    cache?: unknown[]
    rawCache?: unknown
    messages?: ContextTrainingMessage[]
    rawMessages?: unknown[]
    runtimeState: Pick<RuntimeLoopState, 'contextDocument' | 'contextDocumentReceipts' | 'contextDocumentProjections' | 'contextDocumentReviewReceipts' | 'contextDocumentEvidenceReviewReceipts' | 'projectContextDocument' | 'projectContextDocumentReceipts' | 'projectContextDocumentProjections' | 'projectContextDocumentReviewReceipts' | 'projectContextDocumentEvidenceReviewReceipts'>
    createdAt?: string
  }): ContextTrainingSample {
    const contextState: ContextDocumentEngineState | undefined = input.runtimeState.contextDocument
      ? {
          document: clone(input.runtimeState.contextDocument),
          receipts: clone(input.runtimeState.contextDocumentReceipts ?? []),
          projections: clone(input.runtimeState.contextDocumentProjections ?? []),
          reviewReceipts: clone(input.runtimeState.contextDocumentReviewReceipts ?? []),
          evidenceReviewReceipts: clone(input.runtimeState.contextDocumentEvidenceReviewReceipts ?? []),
        }
      : undefined
    const projectContextState: ContextDocumentEngineState | undefined = input.runtimeState.projectContextDocument
      ? {
          document: clone(input.runtimeState.projectContextDocument),
          receipts: clone(input.runtimeState.projectContextDocumentReceipts ?? []),
          projections: clone(input.runtimeState.projectContextDocumentProjections ?? []),
          reviewReceipts: clone(input.runtimeState.projectContextDocumentReviewReceipts ?? []),
          evidenceReviewReceipts: clone(input.runtimeState.projectContextDocumentEvidenceReviewReceipts ?? []),
        }
      : undefined
    const context = contextState ? new ContextDocumentEngine(contextState.document, contextState.receipts, contextState.projections, contextState.reviewReceipts, contextState.evidenceReviewReceipts).serialize() : ''
    const projectContext = projectContextState ? new ContextDocumentEngine(projectContextState.document, projectContextState.receipts, projectContextState.projections, projectContextState.reviewReceipts, projectContextState.evidenceReviewReceipts).serialize() : ''
    const contextRevision = contextState?.document.revision ?? 0
    return this.begin({
      sampleId: input.sampleId,
      scope: input.scope,
      projectId: input.projectId,
      sessionId: input.sessionId,
      ...(input.runId ? { runId: input.runId } : {}),
      input: {
        projectContext,
        projectContextRevision: projectContextState?.document.revision ?? 0,
        context,
        cache: clone(input.cache ?? []),
        rawCache: clone(input.rawCache ?? null),
        messages: clone(input.messages ?? []),
        rawMessages: clone(input.rawMessages ?? []),
        systemPrompt: input.systemPrompt,
        contextRevision,
      },
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
  }

  sampleFingerprint(sampleId: string): string {
    const sample = this.require(sampleId)
    return hash(sample)
  }

  private require(sampleId: string): ContextTrainingSample {
    const sample = this.samples.get(sampleId)
    if (!sample) throw new Error(`context training sample not found: ${sampleId}`)
    return sample
  }
}

export type ContextTrainableExample = {
  schemaVersion: 2
  input: ContextTrainingSample['input']
  target: {
    proposal?: NonNullable<ContextTrainingSample['proposal']>
    decision: NonNullable<ContextTrainingSample['decision']>
    output: NonNullable<ContextTrainingSample['output']>
  }
}

export function validateContextTrainingSample(sample: ContextTrainingSample): string[] {
  const errors: string[] = []
  if (sample.schemaVersion !== 2) errors.push('SCHEMA_VERSION_REQUIRED')
  if (sample.task === 'context_organization' && !sample.organization) errors.push('ORGANIZATION_EVIDENCE_REQUIRED')
  if (sample.organization && (![1, 2].includes(sample.organization.schemaVersion) || !Array.isArray(sample.organization.attempts)
    || sample.organization.promptBindings.some((item) => !/^[a-f0-9]{64}$/.test(item.hash)))) errors.push('ORGANIZATION_EVIDENCE_INVALID')
  if (sample.organization?.schemaVersion === 2 && Array.isArray(sample.organization.attempts) && sample.organization.attempts.some(attempt => {
    const evidence = attempt.requestEvidence
    return !evidence || !evidence.artifactId || evidence.actorSessionId !== sample.sessionId
      || evidence.inputHash !== hash(attempt.messages)
      || evidence.organizationVersion !== (attempt.referenceBinding ? attempt.referenceBinding.version ?? 2 : 1)
      || evidence.documentView?.format !== (evidence.organizationVersion === 4 ? 'none' : evidence.organizationVersion === 1 ? 'markdown' : 'references')
      || !Array.isArray(evidence.promptBindings) || !evidence.promptBindings.length || evidence.promptBindings.some(item => !/^[a-f0-9]{64}$/.test(item.hash))
      || !Array.isArray(evidence.transportAttempts) || evidence.transportAttempts.some(item => !/^[a-f0-9]{64}$/.test(item.payloadHash))
      || (attempt.proposal && !evidence.response?.artifactId)
  })) errors.push('ORGANIZATION_REQUEST_EVIDENCE_INVALID')
  for (const archive of sample.organization?.sourceArchives ?? []) {
    if (!archive.receiptId || !archive.sourceMessageIds.length || !archive.sourceRefs.length
      || archive.sourceSpans?.some(span => !archive.sourceRefs.includes(span.sourceRef)
        || !archive.sourceMessageIds.includes(span.messageId) || !/^[a-f0-9]{64}$/.test(span.sourceHash)
        || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end < span.start)) {
      errors.push('ORGANIZATION_ARCHIVE_EVIDENCE_INVALID')
    }
  }
  if (!sample.input.projectContext && sample.input.projectContextRevision !== 0) errors.push('PROJECT_CONTEXT_REVISION_MISMATCH')
  if (!Array.isArray(sample.input.cache) || !Array.isArray(sample.input.messages) || !Array.isArray(sample.input.rawMessages)) errors.push('INPUT_RESOURCES_INVALID')
  if (!sample.output) errors.push('OUTPUT_REQUIRED')
  if (!sample.decision) errors.push('DECISION_REQUIRED')
  if (sample.decision && !sample.proposal && !sample.decision.candidateReviews?.length && !sample.decision.evidenceReviews?.length && !sample.decision.recalls?.length) errors.push('TARGET_ACTION_REQUIRED')
  for (const operation of sample.proposal?.operations ?? []) {
    if (['add_heading', 'rename_heading', 'move_node', 'reorder_children'].includes(operation.action)
      && (operation.diffVersion !== 2 || !operation.position.nodeId || !/^[a-f0-9]{64}$/.test(operation.structure?.targetNodeHash ?? ''))) errors.push('TREE_OPERATION_BINDING_REQUIRED')
    if (!operation.reason.trim()) errors.push('OPERATION_REASON_REQUIRED')
    if (operation.action !== 'delete' && operation.sourceRefs.length === 0) errors.push('OPERATION_SOURCE_REQUIRED')
    if (operation.action !== 'delete' && operation.evidenceRefs.length === 0) errors.push('OPERATION_EVIDENCE_REQUIRED')
    if (operation.scope === 'project') {
      if (!operation.classification) errors.push('PROJECT_CLASSIFICATION_REQUIRED')
      else if (operation.classification.target !== 'project' || operation.classification.durability !== 'project' || operation.classification.projectAnchors.length === 0) errors.push('PROJECT_RELEVANCE_REQUIRED')
    }
  }
  for (const conflict of sample.decision?.preservedConflicts ?? []) {
    if (!conflict.preserved || conflict.evidenceRefs.length < 2 || conflict.supportingEvidence.length + conflict.contradictingEvidence.length < 2) {
      errors.push(`CONFLICT_EVIDENCE_NOT_PRESERVED:${conflict.id}`)
    }
  }
  for (const recall of sample.decision?.recalls ?? []) {
    if (!recall.query.trim()) errors.push(`RECALL_QUERY_EMPTY:${recall.id}`)
  }
  return errors
}

export function toTrainableContextExample(sample: ContextTrainingSample): ContextTrainableExample {
  if (sample.task === 'context_organization' || sample.organization) throw new Error('ORGANIZATION_TRAINING_EXPORT_REQUIRED')
  const errors = validateContextTrainingSample(sample)
  if (errors.length > 0) throw new Error(`CONTEXT_TRAINING_SAMPLE_INVALID:${errors.join(',')}`)
  return {
    schemaVersion: 2,
    input: clone(sample.input),
    target: {
      ...(sample.proposal ? { proposal: clone(sample.proposal) } : {}),
      decision: clone(sample.decision as NonNullable<ContextTrainingSample['decision']>),
      output: clone(sample.output as NonNullable<ContextTrainingSample['output']>),
    },
  }
}

/** Generator SFT targets contain only the proposal the model actually produced. */
export function toOrganizationTrainableExamples(sample: ContextTrainingSample): Array<{
  schemaVersion: 3
  task: 'context_organization'
  sampleId: string
  messages: LlmMessage[]
  provenance: { promptBindings: PromptBinding[]; commitId?: string; referenceBinding?: OrganizationReferenceBinding; requestEvidence?: ContextOrganizationRequestEvidence }
}> {
  const execution = sample.organization
  if (!execution || (!execution.committed && execution.outcome !== 'no_change')) return []
  const errors = validateContextTrainingSample(sample)
  if (errors.length) throw new Error(`CONTEXT_TRAINING_SAMPLE_INVALID:${errors.join(',')}`)
  return execution.attempts.flatMap((attempt, index) => attempt.proposal ? [{
    schemaVersion: 3 as const, task: 'context_organization' as const, sampleId: `${sample.sampleId}:${index}`,
    messages: [...clone(attempt.messages), { role: 'assistant' as const, content: JSON.stringify(attempt.proposal) }],
    provenance: { promptBindings: clone(attempt.requestEvidence?.promptBindings ?? execution.promptBindings), ...(execution.commitId ? { commitId: execution.commitId } : {}),
      ...(attempt.requestEvidence ? { requestEvidence: clone(attempt.requestEvidence) } : {}),
      ...(attempt.referenceBinding ? { referenceBinding: clone(attempt.referenceBinding) } : {}) },
  }] : [])
}
