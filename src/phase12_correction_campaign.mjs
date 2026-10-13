import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { digest, fileDigest } from './phase0_run.mjs'

const HASH = /^[a-f0-9]{64}$/
const DECISION_SCHEMA = 'gaia2-phase9-correction-decision-template-v1'
const ATTRIBUTION_SCHEMA = 'gaia2-phase9-correction-attribution-v1'

function check(condition, code) {
  if (!condition) throw new Error(`Phase 12 correction campaign: ${code}`)
}

function parentKey(item) {
  return `${item.parentExecutionId}/${item.parentSessionId}`
}

function verifyParentRefs({ decisions, parentResults = [] }) {
  const refs = new Map()
  for (const ref of parentResults) {
    check(ref && typeof ref.executionId === 'string' && typeof ref.sessionId === 'string', 'invalid_parent_reference')
    check(HASH.test(ref.resultHash ?? ''), 'invalid_parent_result_hash')
    const key = `${ref.executionId}/${ref.sessionId}`
    check(!refs.has(key), 'duplicate_parent_reference')
    if (ref.path !== undefined) {
      check(typeof ref.path === 'string' && ref.path.length > 0, 'invalid_parent_result_path')
      check(HASH.test(ref.fileSha256 ?? ''), 'parent_result_file_hash_missing')
    }
    refs.set(key, ref)
  }
  const missing = [], mismatched = []
  for (const decision of decisions) {
    const ref = refs.get(parentKey(decision))
    if (!ref) { missing.push(parentKey(decision)); continue }
    if (ref.resultHash !== decision.parentResultHash) mismatched.push(parentKey(decision))
  }
  return { refs, missing, mismatched, complete: missing.length === 0 && mismatched.length === 0 && refs.size === decisions.length }
}

/**
 * Build an answer-blind correction queue. This is deliberately not a ledger and
 * cannot be consumed by metrics/replay until every parent result is re-verified
 * against the same manifest and the Phase 0 audit is green.
 */
export function buildCorrectionCampaign({ decisions, attribution, manifest, attributionSha256 = null, decisionSha256 = null, parentResults = [], baselineAudit = null }) {
  check(decisions?.schemaVersion === DECISION_SCHEMA && decisions.answerBlind === true, 'invalid_decision_template')
  check(attribution?.schemaVersion === ATTRIBUTION_SCHEMA && attribution.answerBlind === true, 'invalid_attribution')
  check(manifest?.schemaVersion === 'gaia2-run-manifest-v1' && manifest.mode === 'internal_pass5', 'invalid_initial_manifest')
  check(HASH.test(manifest.manifestHash ?? '') && manifest.manifestHash === decisions.manifestHash && manifest.manifestHash === attribution.manifestHash, 'manifest_binding_mismatch')
  check(decisions.correctionOrdinal === 1 && attributionSha256 !== null && HASH.test(attributionSha256), 'attribution_hash_required')
  check(decisions.attributionSha256 === attributionSha256, 'attribution_hash_mismatch')
  if (decisionSha256 !== null) check(HASH.test(decisionSha256), 'decision_hash_invalid')
  check(Array.isArray(decisions.decisions) && Array.isArray(attribution.entries), 'decision_entries_missing')
  check(decisions.decisions.length === attribution.entries.length && decisions.decisions.length === attribution.totalInitialAttempts, 'decision_count_mismatch')
  const attributionById = new Map(attribution.entries.map((entry) => [entry.executionId, entry]))
  const seen = new Set()
  for (const decision of decisions.decisions) {
    check(typeof decision.parentExecutionId === 'string' && !seen.has(decision.parentExecutionId), 'duplicate_decision')
    seen.add(decision.parentExecutionId)
    const entry = attributionById.get(decision.parentExecutionId)
    check(entry && entry.parentSessionId === decision.parentSessionId && entry.parentResultHash === decision.parentResultHash, 'parent_identity_mismatch')
    check(decision.correctionOrdinal === 1, 'invalid_correction_ordinal')
    if (decision.status === 'pending') {
      check(decision.decisionComplete === false && decision.reason === null && decision.requiredDefectCodes?.length > 0, 'invalid_pending_decision')
      check(entry.decisionState === 'decision_required' && entry.trainingAllowed === true, 'pending_attribution_mismatch')
    } else if (decision.status === 'skipped') {
      check(decision.decisionComplete === true && decision.reason === 'no_observable_defect' && decision.requiredDefectCodes?.length === 0, 'invalid_explicit_skip')
      check(entry.decisionState === 'skip_no_observable_defect' && entry.trainingAllowed === false, 'skip_attribution_mismatch')
    } else check(false, 'unsupported_decision_status')
  }
  check(seen.size === attributionById.size, 'attribution_entries_unbound')
  const parentEvidence = verifyParentRefs({ decisions: decisions.decisions, parentResults })
  const baseline = baselineAudit ? {
    checked: true,
    phase0Passed: baselineAudit.phase0Passed === true,
    status: baselineAudit.status ?? (baselineAudit.phase0Passed ? 'passed' : 'failed'),
    errorCount: Array.isArray(baselineAudit.errors) ? baselineAudit.errors.length : null,
    knownGapCount: Array.isArray(baselineAudit.knownGaps) ? baselineAudit.knownGaps.length : null,
  } : { checked: false, phase0Passed: false, status: 'not_checked', errorCount: null, knownGapCount: null }
  const queue = decisions.decisions.map((decision, index) => {
    const pending = decision.status === 'pending'
    return {
      queueIndex: index + 1,
      parentExecutionId: decision.parentExecutionId,
      parentSessionId: decision.parentSessionId,
      parentResultHash: decision.parentResultHash,
      correctionOrdinal: 1,
      state: pending ? 'pending' : 'explicit_skip',
      requiredDefectCodes: [...decision.requiredDefectCodes],
      answerBlind: true,
      nextAction: pending ? 'resolve_training_then_fresh_replay' : 'close_without_correction',
    }
  })
  const pendingCount = queue.filter((item) => item.state === 'pending').length
  const explicitSkipCount = queue.length - pendingCount
  const executionReady = parentEvidence.complete && baseline.phase0Passed
  const content = {
    schemaVersion: 'gaia2-phase12-correction-campaign-v1',
    manifestHash: manifest.manifestHash,
    attributionSha256,
    decisionSha256,
    correctionOrdinal: 1,
    answerBlind: true,
    queue,
    pendingCount,
    explicitSkipCount,
    parentEvidence: { complete: parentEvidence.complete, expected: decisions.decisions.length, provided: parentEvidence.refs.size, missing: parentEvidence.missing, mismatched: parentEvidence.mismatched },
    baselineAudit: baseline,
    ledgerCompatible: false,
    noModelExecution: true,
    executionReady,
    officialSubmissionReady: false,
    nextAction: executionReady
      ? 'Run pending queue with one verified training receipt and fresh replay per item; explicit skips remain closed.'
      : 'Do not execute correction queue; refresh same-manifest parent evidence and pass Phase 0 audit first.',
  }
  return { ...content, campaignHash: digest(content) }
}

export function verifyCorrectionCampaign(campaign) {
  check(campaign?.schemaVersion === 'gaia2-phase12-correction-campaign-v1', 'invalid_campaign_schema')
  const { campaignHash, generatedAt: _generatedAt, ...content } = campaign
  check(HASH.test(campaignHash ?? '') && digest(content) === campaignHash, 'campaign_hash_mismatch')
  check(content.answerBlind === true && content.correctionOrdinal === 1 && content.ledgerCompatible === false, 'campaign_not_answer_blind')
  check(content.queue?.length === content.pendingCount + content.explicitSkipCount, 'campaign_counts_mismatch')
  check(new Set(content.queue.map((item) => item.parentExecutionId)).size === content.queue.length, 'campaign_duplicate_queue')
  for (const item of content.queue) {
    check(item.answerBlind === true && item.correctionOrdinal === 1, 'campaign_item_not_immutable')
    check(item.state === 'pending' || item.state === 'explicit_skip', 'campaign_item_state_invalid')
    if (item.state === 'explicit_skip') check(item.requiredDefectCodes.length === 0 && item.nextAction === 'close_without_correction', 'campaign_skip_mutated')
  }
  return { schemaVersion: 'gaia2-phase12-correction-campaign-verification-v1', campaignHash, queueCount: content.queue.length, pendingCount: content.pendingCount, explicitSkipCount: content.explicitSkipCount, executionReady: content.executionReady === true }
}

export function discoverParentResult(root, { runId, executionId, sessionId }) {
  const path = resolve(root, 'runs', runId, 'workspaces', executionId, 'sessions', sessionId, 'task-result.json')
  if (!existsSync(path)) return null
  return { executionId, sessionId, resultHash: fileDigest(path), path: path.replaceAll('\\', '/'), fileSha256: fileDigest(path) }
}
