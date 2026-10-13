import { digest } from './phase0_run.mjs'

const HASH = /^[a-f0-9]{64}$/
const DEFECTS = new Set(['multi_tool_response_rejected', 'read_failed', 'write_unverified', 'unknown_write_requires_readback'])
function check(condition, code) { if (!condition) throw new Error(`Phase 4 correction attribution: ${code}`) }

/**
 * Convert independently verified correction evidence into a safe, answer-blind
 * attribution report. The report contains no question, tool arguments, result
 * contents, identifiers, or model-generated text. It is an input to a later
 * human/policy decision and is not itself a correction ledger.
 */
export function buildCorrectionAttribution({ manifest, parents }) {
  check(manifest?.schemaVersion === 'gaia2-run-manifest-v1' && manifest.mode === 'internal_pass5', 'invalid_initial_manifest')
  check(HASH.test(manifest.manifestHash ?? ''), 'manifest_hash_missing')
  check(Array.isArray(parents) && parents.length === manifest.tasks.length, 'parent_count_mismatch')
  const planned = new Map(manifest.tasks.map(task => [task.executionId, task]))
  const seen = new Set(), entries = []
  for (const parent of parents) {
    const task = parent?.task, session = parent?.session, evidence = parent?.evidence
    check(task && planned.get(task.executionId) && !seen.has(task.executionId), 'unknown_or_duplicate_parent')
    check(task.correctionOrdinal === 0 && task.attemptIndex === task.runNumber, 'non_initial_parent')
    check(session?.sessionId && typeof parent.resultHash === 'string' && HASH.test(parent.resultHash), 'parent_identity_missing')
    check(evidence?.eligible === true && evidence.valid?.runtimeProof === true && evidence.valid?.evaluationComplete === true, 'parent_not_verified')
    check(typeof evidence.reason === 'string' && ['observable_defects', 'no_observable_defect'].includes(evidence.reason), 'unsupported_attribution_reason')
    const summary = evidence.sealed?.observableSummary
    check(summary && ['environment_stop', 'conversation_turn_limit'].includes(summary.terminationReason), 'unsupported_termination')
    const defects = (summary.defects ?? []).map(defect => {
      check(DEFECTS.has(defect.defectCode) && Number.isSafeInteger(defect.count) && defect.count > 0, 'invalid_defect')
      check(HASH.test(defect.evidenceHash ?? '') && Array.isArray(defect.procedureIds) && Array.isArray(defect.verificationIds), 'invalid_defect_evidence')
      return { defectCode: defect.defectCode, count: defect.count, evidenceHash: defect.evidenceHash,
        procedureIds: [...defect.procedureIds], verificationIds: [...defect.verificationIds] }
    }).sort((a, b) => a.defectCode.localeCompare(b.defectCode))
    check((evidence.trainingAllowed === true) === (defects.length > 0), 'training_eligibility_mismatch')
    entries.push({ executionId: task.executionId, phase: task.phase, config: task.config,
      scenarioId: task.scenarioId, runNumber: task.runNumber, parentSessionId: session.sessionId,
      parentResultHash: parent.resultHash, eligible: evidence.eligible, trainingAllowed: evidence.trainingAllowed,
      attribution: evidence.reason, decisionState: evidence.trainingAllowed ? 'decision_required' : 'skip_no_observable_defect',
      terminationReason: summary.terminationReason, counts: { ...summary.counts }, effects: [...summary.effects], defects })
    seen.add(task.executionId)
  }
  check(seen.size === planned.size, 'planned_parent_set_incomplete')
  entries.sort((a, b) => a.executionId.localeCompare(b.executionId))
  const byConfig = Object.fromEntries([...new Set(entries.map(entry => entry.config))].sort().map(config => {
    const subset = entries.filter(entry => entry.config === config)
    return [config, { total: subset.length, decisionRequired: subset.filter(item => item.trainingAllowed).length,
      noObservableDefect: subset.filter(item => !item.trainingAllowed).length,
      defectCounts: Object.fromEntries([...new Set(subset.flatMap(item => item.defects.map(defect => defect.defectCode)))].sort().map(code => [code, subset.reduce((sum, item) => sum + (item.defects.find(defect => defect.defectCode === code)?.count ?? 0), 0)])) }]
  }))
  const defectCounts = Object.fromEntries([...new Set(entries.flatMap(item => item.defects.map(defect => defect.defectCode)))].sort().map(code => [code, entries.reduce((sum, item) => sum + (item.defects.find(defect => defect.defectCode === code)?.count ?? 0), 0)]))
  return { schemaVersion: 'gaia2-phase9-correction-attribution-v1', manifestHash: manifest.manifestHash,
    runId: manifest.runId, evidenceKind: 'verified_initial_native_runtime', answerBlind: true,
    totalInitialAttempts: entries.length, eligibleAttempts: entries.filter(item => item.eligible).length,
    decisionRequiredAttempts: entries.filter(item => item.trainingAllowed).length,
    noObservableDefectAttempts: entries.filter(item => !item.trainingAllowed).length,
    defectCounts, byConfig, entries, ledgerReady: false,
    nextAction: 'Create one explicit correction decision per decision_required entry; keep no_observable_defect entries as explicit skips.',
    noModelExecution: true, officialSubmissionReady: false }
}
