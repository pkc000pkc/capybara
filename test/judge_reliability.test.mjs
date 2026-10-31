import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BOOLEAN_MARKERS,
  JUDGE_RELIABILITY_SCHEMA,
  classifyJudgeReliability,
  detectBooleanMarkerConflict,
  hashJudgeResponse,
  isReliableScore,
  summarizeJudgeReliability,
} from '../src/judge_reliability.mjs'

test('Boolean marker matrix detects only evidenced official case folding', () => {
  const raw = '[[True]]'
  const lower = '[[true]]'
  const conflict = detectBooleanMarkerConflict({ rawResponse: raw, checkerResponse: lower,
    expectedMarkers: BOOLEAN_MARKERS.upper, transform: { caseFoldBooleanMarkers: true } })
  assert.equal(conflict.detected, true)
  assert.equal(conflict.rawHasExpected, true)
  assert.equal(conflict.checkerHasExpected, false)

  const unchanged = detectBooleanMarkerConflict({ rawResponse: raw, checkerResponse: raw,
    expectedMarkers: BOOLEAN_MARKERS.upper, transform: { caseFoldBooleanMarkers: true } })
  assert.equal(unchanged.detected, false)

  const noTransform = detectBooleanMarkerConflict({ rawResponse: raw, checkerResponse: lower,
    expectedMarkers: BOOLEAN_MARKERS.upper, transform: { caseFoldBooleanMarkers: false } })
  assert.equal(noTransform.detected, false)
})

test('completed row without raw judge provenance is unknown, never reliable', () => {
  const result = classifyJudgeReliability({ evaluationComplete: true, rawScore: 0 })
  assert.equal(result.schemaVersion, JUDGE_RELIABILITY_SCHEMA)
  assert.equal(result.scoreReliability, 'unknown')
  assert.equal(result.reason, 'judge_sidecar_missing')
  assert.equal(result.eligibleForModelMetrics, false)
  assert.equal(result.judgeProtocolAffected, null)
})

test('evidenced protocol conflict is isolated from model metrics', () => {
  const sidecar = { checkerPath: 'validation/utils/llm_utils.py:133', parseStatus: 'unparsed',
    rawResponse: '[[True]]', checkerResponse: '[[true]]',
    transform: { caseFoldBooleanMarkers: true }, judgeVersion: 'ARE-1.2.0' }
  const result = classifyJudgeReliability({ evaluationComplete: true, rawScore: 0, judgeEvidence: sidecar })
  assert.equal(result.scoreReliability, 'protocol_affected')
  assert.equal(result.judgeProtocolAffected, true)
  assert.equal(result.reason, 'boolean_marker_case_conflict')
  assert.equal(result.eligibleForModelMetrics, false)
  assert.match(result.rawResponseHash, /^[a-f0-9]{64}$/)
})

test('complete parsed provenance is reliable and hash is stable', () => {
  const raw = JSON.stringify({ checker: 'sanity', marker: '[[False]]' })
  const result = classifyJudgeReliability({ evaluationComplete: true, rawScore: 0,
    judgeEvidence: { checkerPath: 'validation/utils/llm_utils.py:133', parseStatus: 'parsed',
      rawResponse: raw, judgeVersion: 'ARE-1.2.0' } })
  assert.equal(result.scoreReliability, 'reliable')
  assert.equal(result.judgeProtocolAffected, false)
  assert.equal(result.eligibleForModelMetrics, true)
  assert.equal(result.rawResponseHash, hashJudgeResponse(raw))
  assert.equal(isReliableScore({ status: 'evaluated', evaluationComplete: true,
    technicalError: null, rawScore: 0, scoreReliability: 'reliable' }), true)
  assert.equal(isReliableScore({ status: 'evaluated', evaluationComplete: true,
    technicalError: null, rawScore: 0 }), false)
})

test('official lite validation provenance can score without an LLM judge sidecar', () => {
  const result = classifyJudgeReliability({ evaluationComplete: true, rawScore: 1,
    officialEvidence: { validationDecision: 'Valid', rawScore: 1, fileSha256: 'a'.repeat(64), source: 'are_lite_validation_metadata-v1' } })
  assert.equal(result.scoreReliability, 'official_oracle')
  assert.equal(result.judgeProtocolAffected, false)
  assert.equal(result.eligibleForModelMetrics, true)
  assert.equal(result.officialEvidence.validationDecision, 'Valid')
  assert.equal(isReliableScore({ status: 'evaluated', evaluationComplete: true,
    technicalError: null, rawScore: 1, scoreReliability: 'official_oracle' }), true)
})

test('summary keeps protocol, technical, unknown and reliable rows disjoint', () => {
  const summary = summarizeJudgeReliability([
    { scoreReliability: 'reliable' }, { scoreReliability: 'protocol_affected' },
    { scoreReliability: 'unknown' }, { scoreReliability: 'technical' },
  ])
  assert.deepEqual(summary, { total: 4, reliable: 1, protocolAffected: 1,
    unknown: 1, technical: 1, eligible: 1, excluded: 3 })
})

