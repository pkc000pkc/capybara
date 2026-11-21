import { createHash } from 'node:crypto'
import { ContextDocumentEngine, type CandidateBlock, type ContextDocumentEngineState, type EvidenceRef } from '#core/context-document-engine'
import type { ContextCommitStore } from '#core/context-commit-store'
import { CONTEXT_RECALL_MAX_QUERY_CHARACTERS, CONTEXT_RECALL_MAX_RESULTS, CONTEXT_RECALL_SOURCE_KINDS,
  type RuntimeContextMemoryRecall, type RuntimeContextMemoryRecallResult, type RuntimeContextRecallHit } from '#protocol/runtime-protocol'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const blocked = new Set(['rejected', 'stale', 'irrelevant', 'superseded'])

export function validateRecallQuery(value: RuntimeContextMemoryRecall): void {
  if (typeof value.query !== 'string' || !value.query.trim() || value.query.length > CONTEXT_RECALL_MAX_QUERY_CHARACTERS) throw new Error('CONTEXT_RECALL_QUERY_INVALID')
  if (value.scope !== undefined && !['project', 'session', 'both'].includes(value.scope)) throw new Error('CONTEXT_RECALL_SCOPE_INVALID')
  if (value.sourceKind !== undefined && !CONTEXT_RECALL_SOURCE_KINDS.includes(value.sourceKind)) throw new Error('CONTEXT_RECALL_SOURCE_KIND_INVALID')
  if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > CONTEXT_RECALL_MAX_RESULTS)) throw new Error('CONTEXT_RECALL_LIMIT_INVALID')
}

export function contextCandidateMeta(candidate: CandidateBlock) {
  return { id: candidate.id, actor: candidate.source.actor, sourceId: candidate.source.sourceId, capturedAt: candidate.source.capturedAt,
    ...(candidate.source.toolName ? { toolName: candidate.source.toolName } : {}), ...(candidate.source.runId ? { runId: candidate.source.runId } : {}),
    ...(candidate.source.stepId ? { stepId: candidate.source.stepId } : {}), rawArtifactId: candidate.rawArtifactId, status: candidate.status,
    evidenceRefs: [...candidate.evidenceRefs], proposedDiffIds: [...candidate.proposedDiffIds], createdAt: candidate.createdAt,
    ...(candidate.reviewedAt ? { reviewedAt: candidate.reviewedAt } : {}), ...(candidate.classification ? { classification: candidate.classification } : {}) }
}

function excerpt(text: string, terms: readonly string[], maximum = 1600) {
  const positions = terms.map((term) => text.toLowerCase().indexOf(term)).filter((index) => index >= 0)
  let start = text.length <= maximum ? 0 : Math.max(0, Math.min(...positions, text.length) - 120)
  if (/[\uDC00-\uDFFF]/u.test(text[start] ?? '')) start -= 1
  let end = Math.min(text.length, start + maximum)
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? '')) end -= 1
  const complete = start === 0 && end === text.length
  return { body: text.slice(start, end), excerpt: { start, totalCharacters: text.length, truncated: !complete, complete } }
}

interface Match {
  hit: RuntimeContextRecallHit
  evidence: EvidenceRef[]
  archive?: NonNullable<RuntimeContextMemoryRecallResult['archives']>[number]
  sourceKey: string
  derivedPage?: boolean
}

interface RecallInput {
  recallId: string; query: RuntimeContextMemoryRecall; project: ContextDocumentEngineState; session: ContextDocumentEngineState;
  store: ContextCommitStore; sessionId: string
}

/** Retrieve a bounded source pool before creating any candidates. */
export function findRecallSources(input: RecallInput, poolLimit = input.query.limit ?? 5): Match[] {
  validateRecallQuery(input.query)
  const scope = input.query.scope ?? 'both'
  const { sourceKind } = input.query
  const terms = [...new Set(input.query.query.trim().toLowerCase().split(/\s+/u))].slice(0, 8)
  const matches: Match[] = []
  for (const currentScope of ['project', 'session'] as const) {
    if (scope !== 'both' && scope !== currentScope) continue
    if (sourceKind === 'source_archive') continue
    const document = input[currentScope].document
    const evidenceMap = new Map(document.evidence.map((item) => [item.id, item]))
    for (const entry of sourceKind === 'candidate' ? [] : document.information) {
      const matched = terms.filter((term) => `${entry.headingPath.join(' ')} ${entry.body}`.toLowerCase().includes(term))
      if (!matched.length) continue
      const evidence = entry.evidenceRefs.flatMap((id) => evidenceMap.has(id) ? [evidenceMap.get(id)!] : [])
      const capturedAt = evidence.find((item) => item.observedAt)?.observedAt ?? document.updatedAt
      const sourceKey = `recall:${digest({ scope: currentScope, documentId: document.id, entryId: entry.id, body: entry.body, evidence, status: entry.status, revision: entry.revision })}`
      matches.push({ sourceKey, evidence, hit: { id: sourceKey, scope: currentScope, documentId: document.id,
        sourceId: entry.id, sourceKind: 'information', originalStatus: entry.status,
        ...excerpt(entry.body, terms), capturedAt, evidenceRefs: [...entry.evidenceRefs], rawArtifactIds: [...new Set(evidence.map((item) => item.referenceId))],
        score: matched.length, reason: `matched:${matched.join(',')}` },
        ...(entry.status === 'archived' ? { archive: { id: `archive-${entry.id}`, entryId: entry.id, headingPath: [...entry.headingPath], body: excerpt(entry.body, terms).body,
          evidenceRefs: [...entry.evidenceRefs], sourceCandidateIds: [...entry.sourceCandidateIds], reason: `matched:${matched.join(',')}`, score: matched.length } } : {}) })
    }
    for (const candidate of sourceKind === 'information' ? [] : document.candidates) {
      if (candidate.source.actor !== 'memory' || candidate.source.sourceId.startsWith('recall:') || blocked.has(candidate.status)) continue
      const matched = terms.filter((term) => candidate.normalizedContent.toLowerCase().includes(term))
      if (!matched.length) continue
      const evidence = candidate.evidenceRefs.flatMap((id) => evidenceMap.has(id) ? [evidenceMap.get(id)!] : [])
      const sourceKey = `recall:${digest({ scope: currentScope, documentId: document.id, candidateId: candidate.id, body: candidate.normalizedContent, evidence, status: candidate.status })}`
      matches.push({ sourceKey, evidence, hit: { id: sourceKey, scope: currentScope, documentId: document.id, sourceId: candidate.id, sourceKind: 'candidate',
        originalStatus: candidate.status, originalActor: candidate.source.actor, ...excerpt(candidate.normalizedContent, terms), capturedAt: candidate.source.capturedAt,
        evidenceRefs: [...candidate.evidenceRefs], rawArtifactIds: [candidate.rawArtifactId], score: matched.length, reason: `matched:${matched.join(',')}` } })
    }
  }
  if (scope !== 'project' && (sourceKind === undefined || sourceKind === 'source_archive')) {
    for (const source of input.store.searchArchivedSources(input.sessionId, terms, Math.min(100, poolLimit * 4))) {
      const sourceKey = `recall:${digest({ scope: 'session', sessionId: input.sessionId, sourceRef: source.sourceRef, sourceHash: source.sourceHash })}`
      const evidence: EvidenceRef = { id: `source-evidence-${digest({ sessionId: input.sessionId, sourceRef: source.sourceRef, hash: source.sourceHash })}`,
        kind: source.referenceId === source.messageId ? 'message' : 'artifact', referenceId: source.referenceId, sessionId: input.sessionId, sourceHash: source.sourceHash,
        locator: `characters:${source.start}:${source.end}`, observedAt: source.capturedAt, confidence: 'medium' }
      const view = excerpt(source.text, terms)
      matches.push({ sourceKey, evidence: [evidence], derivedPage: source.toolName === 'read_runtime_artifact',
        hit: { id: sourceKey, scope: 'session', sourceId: source.archiveId, sourceRef: source.sourceRef, sourceKind: 'source_archive', originalStatus: 'archived',
        originalActor: source.origin, ...view, excerpt: { start: source.start + view.excerpt.start, totalCharacters: source.totalCharacters,
          truncated: view.excerpt.truncated || source.start > 0 || source.end < source.totalCharacters, complete: view.excerpt.complete }, capturedAt: source.capturedAt,
        evidenceRefs: [evidence.id], rawArtifactIds: [source.referenceId], score: terms.filter((term) => source.text.toLowerCase().includes(term)).length,
        reason: `matched-source:${source.sourceRef}` } })
    }
  }
  const unique = new Map<string, Match>()
  for (const match of matches.sort((a, b) => b.hit.score - a.hit.score || Number(!!a.derivedPage) - Number(!!b.derivedPage)
    || (a.hit.id < b.hit.id ? -1 : a.hit.id > b.hit.id ? 1 : 0))) {
    if (!unique.has(match.sourceKey)) unique.set(match.sourceKey, match)
    if (unique.size === poolLimit) break
  }
  return [...unique.values()]
}

export function recallContext(input: RecallInput, selection?: readonly Match[]): { session: ContextDocumentEngineState; result: RuntimeContextMemoryRecallResult } {
  validateRecallQuery(input.query)
  const scope = input.query.scope ?? 'both'
  const { sourceKind } = input.query
  const selected = structuredClone(selection ?? findRecallSources(input)).filter(match =>
    (scope === 'both' || match.hit.scope === scope) && (sourceKind === undefined || match.hit.sourceKind === sourceKind))
  const session = new ContextDocumentEngine(input.session.document, input.session.receipts, input.session.projections, input.session.reviewReceipts, input.session.evidenceReviewReceipts)
  const candidates: CandidateBlock[] = [], uncertainties: string[] = []
  for (const match of selected) {
    const previous = session.snapshot().candidates.find((item) => item.source.actor === 'memory' && item.source.sourceId === match.sourceKey)
    let candidate = previous
    if (!candidate) {
      const evidenceRefs = match.evidence.map((source) => {
        const evidence = { ...source, id: `recall-evidence-${digest({ scope: match.hit.scope, documentId: match.hit.documentId, source })}` }
        const known = session.snapshot().evidence.find((item) => item.id === evidence.id)
        if (known && JSON.stringify(known) !== JSON.stringify(evidence)) throw new Error('CONTEXT_RECALL_EVIDENCE_CONFLICT')
        return known?.id ?? session.addEvidence(evidence).id
      })
      candidate = session.addCandidate({ source: { actor: 'memory', sourceId: match.sourceKey, capturedAt: match.hit.capturedAt },
        rawArtifactId: match.hit.rawArtifactIds[0] ?? match.hit.sourceId,
        normalizedContent: `[召回 ${match.hit.scope}/${match.hit.sourceKind}；原状态 ${match.hit.originalStatus}${match.hit.originalActor ? `；原来源 ${match.hit.originalActor}` : ''}]\n${match.hit.body}`,
        evidenceRefs, classification: { durability: 'session', target: 'session', confidence: 'medium', reason: '召回供当前会话复核；不改变原项目或归档状态', projectAnchors: [] } })
    }
    match.hit.candidateId = candidate.id
    match.hit.evidenceRefs = [...candidate.evidenceRefs]
    if (!candidate.evidenceRefs.length) uncertainties.push(`needs_source_evidence:${candidate.id}`)
    if (blocked.has(candidate.status)) uncertainties.push(`candidate_remains_${candidate.status}:${candidate.id}`)
    if (!(match.hit.excerpt.complete ?? !match.hit.excerpt.truncated)) uncertainties.push(`excerpt_requires_source_read:${candidate.id}`)
    candidates.push(candidate)
  }
  return { session: session.exportState(), result: { recallId: input.recallId, query: input.query.query, scope,
    ...(sourceKind ? { sourceKind } : {}),
    candidates: candidates.map(contextCandidateMeta), hits: selected.map((item) => item.hit),
    ...(selected.some((item) => item.archive) ? { archives: selected.flatMap((item) => item.archive ? [item.archive] : []) } : {}), uncertainties } }
}
