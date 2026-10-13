import { digest } from './phase0_run.mjs'

const HASH = /^[a-f0-9]{64}$/
function check(condition, code) { if (!condition) throw new Error(`Phase 4 correction decisions: ${code}`) }

/** Build a decision-only artifact. It is intentionally not a correction ledger:
 * pending entries cannot be consumed by Phase 4 metrics or replay. */
export function buildCorrectionDecisionTemplate({ attribution, attributionSha256 = null }) {
  check(attribution?.schemaVersion === 'gaia2-phase9-correction-attribution-v1' && attribution.answerBlind === true, 'invalid_attribution')
  check(HASH.test(attribution.manifestHash ?? '') && Array.isArray(attribution.entries) && attribution.entries.length === attribution.totalInitialAttempts, 'invalid_attribution_identity')
  if (attributionSha256 !== null) check(HASH.test(attributionSha256), 'invalid_attribution_hash')
  const seen = new Set(), decisions = attribution.entries.map(entry => {
    check(typeof entry.executionId === 'string' && !seen.has(entry.executionId), 'duplicate_parent')
    check(entry.eligible === true && entry.parentSessionId && HASH.test(entry.parentResultHash ?? ''), 'unverified_parent')
    seen.add(entry.executionId)
    const defectCodes = entry.defects.map(defect => defect.defectCode).sort()
    if (entry.decisionState === 'skip_no_observable_defect') {
      check(entry.trainingAllowed === false && entry.attribution === 'no_observable_defect' && defectCodes.length === 0, 'invalid_explicit_skip')
      return { parentExecutionId: entry.executionId, parentSessionId: entry.parentSessionId, parentResultHash: entry.parentResultHash,
        correctionOrdinal: 1, status: 'skipped', reason: 'no_observable_defect', requiredDefectCodes: [], decisionComplete: true }
    }
    check(entry.decisionState === 'decision_required' && entry.trainingAllowed === true && defectCodes.length > 0, 'invalid_pending_decision')
    return { parentExecutionId: entry.executionId, parentSessionId: entry.parentSessionId, parentResultHash: entry.parentResultHash,
      correctionOrdinal: 1, status: 'pending', reason: null, requiredDefectCodes: defectCodes, decisionComplete: false }
  })
  check(seen.size === attribution.totalInitialAttempts, 'incomplete_parent_set')
  return { schemaVersion: 'gaia2-phase9-correction-decision-template-v1', manifestHash: attribution.manifestHash,
    attributionSha256, answerBlind: true, correctionOrdinal: 1, decisions,
    explicitSkips: decisions.filter(item => item.status === 'skipped').length,
    pendingDecisions: decisions.filter(item => item.status === 'pending').length,
    ledgerCompatible: false, noModelExecution: true, officialSubmissionReady: false,
    nextAction: 'Resolve every pending decision with a verified training receipt and fresh replay; do not pass this template to Phase 4 metrics.' }
}
