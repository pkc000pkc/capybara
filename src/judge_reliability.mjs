import { createHash } from 'node:crypto'

/**
 * External, answer-blind reliability classification for the frozen ARE judge.
 *
 * This module deliberately does not import or patch the official ARE judge.
 * It only consumes an explicitly captured diagnostic sidecar.  A completed
 * native run without that sidecar is therefore `unknown`, never silently
 * upgraded to a reliable score.
 */
export const JUDGE_RELIABILITY_SCHEMA = 'gaia2-judge-reliability-v1'
export const SCORE_RELIABILITIES = Object.freeze(['reliable', 'official_oracle', 'protocol_affected', 'unknown', 'technical'])
export const BOOLEAN_MARKERS = Object.freeze({
  upper: Object.freeze(['[[True]]', '[[False]]']),
  lower: Object.freeze(['[[true]]', '[[false]]']),
})

const HASH = /^[a-f0-9]{64}$/
const CHECKER_PATH = /^[A-Za-z0-9_./:-]{1,240}$/
const PARSE_STATUSES = new Set(['parsed', 'unparsed', 'missing'])

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stableJson(value) {
  if (typeof value === 'string') return value
  return JSON.stringify(value, (_key, nested) => nested && typeof nested === 'object' && !Array.isArray(nested)
    ? Object.fromEntries(Object.keys(nested).sort().map(key => [key, nested[key]])) : nested)
}

export function hashJudgeResponse(value) {
  if (value === undefined || value === null) return null
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex')
}

function hasMarker(value, marker) {
  return typeof value === 'string' && value.includes(marker)
}

/**
 * Detect only an evidenced Boolean marker case conflict.  The caller must
 * provide both the captured response before the official engine transform
 * and the checker-visible response after it.  A missing response is not a
 * conflict; it is classified as unknown by `classifyJudgeReliability`.
 */
export function detectBooleanMarkerConflict({ rawResponse = null, checkerResponse = null,
  expectedMarkers = BOOLEAN_MARKERS.upper, transform = null } = {}) {
  const raw = typeof rawResponse === 'string' ? rawResponse : null
  const checked = typeof checkerResponse === 'string' ? checkerResponse : null
  const expected = Array.isArray(expectedMarkers) && expectedMarkers.every(item => typeof item === 'string')
    ? expectedMarkers : [...BOOLEAN_MARKERS.upper]
  const rawHasExpected = expected.some(marker => hasMarker(raw, marker))
  const checkerHasExpected = expected.some(marker => hasMarker(checked, marker))
  const checkerHasLower = BOOLEAN_MARKERS.lower.some(marker => hasMarker(checked, marker))
  const transformed = object(transform) && transform.caseFoldBooleanMarkers === true
  return {
    detected: rawHasExpected && !checkerHasExpected && checkerHasLower && transformed,
    rawHasExpected,
    checkerHasExpected,
    checkerHasLower,
    transformEvidence: transformed,
  }
}

function normalizeSidecar(sidecar) {
  if (!object(sidecar)) return null
  const checkerPath = sidecar.checkerPath == null ? null : String(sidecar.checkerPath)
  const parseStatus = sidecar.parseStatus == null ? 'missing' : sidecar.parseStatus
  const rawResponseHash = sidecar.rawResponseHash ?? hashJudgeResponse(sidecar.rawResponse)
  const explicitEvidence = object(sidecar.markerConflictEvidence) &&
    ['rawHasExpected', 'checkerHasExpected', 'checkerHasLower', 'transformEvidence'].every(key => typeof sidecar.markerConflictEvidence[key] === 'boolean')
    ? sidecar.markerConflictEvidence : null
  const conflict = explicitEvidence
    ? { detected: sidecar.markerConflict === true, ...explicitEvidence }
    : sidecar.markerConflict === true ? { detected: false } : detectBooleanMarkerConflict(sidecar)
  return {
    schemaVersion: JUDGE_RELIABILITY_SCHEMA,
    judgeVersion: sidecar.judgeVersion == null ? null : String(sidecar.judgeVersion),
    checkerPath: checkerPath && CHECKER_PATH.test(checkerPath) ? checkerPath : null,
    parseStatus: PARSE_STATUSES.has(parseStatus) ? parseStatus : 'missing',
    rawResponseHash: HASH.test(rawResponseHash ?? '') ? rawResponseHash : null,
    markerConflict: object(conflict) && conflict.detected === true,
    rawMarkerConflict: sidecar.rawMarkerConflict === true,
    protocolNormalization: object(sidecar.protocolNormalization)
      && sidecar.protocolNormalization.applied === true
      ? {
          schemaVersion: typeof sidecar.protocolNormalization.schemaVersion === 'string'
            ? sidecar.protocolNormalization.schemaVersion : 'gaia2-judge-normalization-v1',
          applied: true,
          count: Number.isInteger(sidecar.protocolNormalization.count)
            ? sidecar.protocolNormalization.count : 1,
        }
      : null,
    markerConflictEvidence: object(conflict) ? {
      rawHasExpected: conflict.rawHasExpected === true,
      checkerHasExpected: conflict.checkerHasExpected === true,
      checkerHasLower: conflict.checkerHasLower === true,
      transformEvidence: conflict.transformEvidence === true,
    } : null,
    source: sidecar.source == null ? null : String(sidecar.source),
  }
}

function normalizeOfficialEvidence(evidence) {
  if (!object(evidence)) return null
  const decision = evidence.validationDecision
  const rawScore = evidence.rawScore
  const fileHash = evidence.fileSha256
  if (!['Valid', 'Invalid'].includes(decision) || ![0, 1].includes(rawScore)
      || (decision === 'Valid' ? rawScore !== 1 : rawScore !== 0)
      || typeof fileHash !== 'string' || !HASH.test(fileHash)) return null
  return {
    schemaVersion: 'gaia2-official-validation-evidence-v1',
    validationDecision: decision,
    rawScore,
    fileSha256: fileHash,
    source: evidence.source == null ? null : String(evidence.source),
  }
}

/**
 * Classify a native score without changing the official score itself.
 * `technicalError` always wins.  A completed score is reliable only when an
 * explicit parser/checker sidecar and response hash exist and no protocol
 * conflict was evidenced.
 */
export function classifyJudgeReliability({ evaluationComplete = false, rawScore = null,
  technicalError = null, judgeEvidence = null, officialEvidence = null } = {}) {
  const sidecar = normalizeSidecar(judgeEvidence)
  const official = normalizeOfficialEvidence(officialEvidence)
  const base = {
    schemaVersion: JUDGE_RELIABILITY_SCHEMA,
    judgeProtocolAffected: null,
    scoreReliability: 'unknown',
    eligibleForModelMetrics: false,
    reason: null,
    checkerPath: sidecar?.checkerPath ?? null,
    rawResponseHash: sidecar?.rawResponseHash ?? null,
    parseStatus: sidecar?.parseStatus ?? 'missing',
    sidecar: sidecar ?? null,
    officialEvidence: official,
  }
  if (technicalError) return { ...base, scoreReliability: 'technical', reason: 'runtime_technical_error' }
  if (evaluationComplete !== true || ![0, 1].includes(rawScore)) {
    return { ...base, reason: 'evaluation_incomplete_or_score_invalid' }
  }
  if (sidecar?.markerConflict) return { ...base, judgeProtocolAffected: true, scoreReliability: 'protocol_affected', reason: 'boolean_marker_case_conflict' }
  if (official) return { ...base, judgeProtocolAffected: false, scoreReliability: 'official_oracle', eligibleForModelMetrics: true, reason: 'official_validation_provenance' }
  if (!sidecar) return { ...base, reason: 'judge_sidecar_missing' }
  if (sidecar.parseStatus !== 'parsed') return { ...base, reason: 'judge_response_not_parsed' }
  if (!sidecar.checkerPath || !sidecar.rawResponseHash) return { ...base, reason: 'judge_provenance_incomplete' }
  return { ...base, judgeProtocolAffected: false, scoreReliability: 'reliable', eligibleForModelMetrics: true, reason: 'verified_judge_provenance' }
}

/**
 * A scored-window predicate for callers aggregating model metrics.  Legacy
 * rows without a reliability sidecar are intentionally excluded; callers may
 * opt into a diagnostic-only legacy view separately.
 */
export function isReliableScore(row) {
  return object(row) && row.status === 'evaluated' && row.evaluationComplete === true
    && row.technicalError == null && Number.isFinite(row.rawScore)
    && row.rawScore >= 0 && row.rawScore <= 1 && ['reliable', 'official_oracle'].includes(row.scoreReliability)
}

export function summarizeJudgeReliability(rows = []) {
  const summary = { total: 0, reliable: 0, protocolAffected: 0, unknown: 0, technical: 0,
    eligible: 0, excluded: 0 }
  for (const row of rows) {
    summary.total++
    const value = row?.scoreReliability
    if (value === 'reliable' || value === 'official_oracle') { summary.reliable++; summary.eligible++ }
    else if (value === 'protocol_affected') { summary.protocolAffected++; summary.excluded++ }
    else if (value === 'technical') { summary.technical++; summary.excluded++ }
    else { summary.unknown++; summary.excluded++ }
  }
  return summary
}

