import { digest } from './phase0_run.mjs'
import { deriveCorrectionEvidence, verifyInitialEvaluation } from './phase4_correction_contract.mjs'
import { verifyCorrectionReplay } from './phase4_replay.mjs'

const HASH = /^[a-f0-9]{64}$/
function check(condition, code) { if (!condition) throw new Error(`Phase 4 metrics: ${code}`) }
const key = task => JSON.stringify([task.phase, task.config, task.scenarioId])
function strictRef(value, code) {
  check(value && typeof value === 'object' && !Array.isArray(value) && digest(Object.keys(value).sort()) === digest(['path', 'sha256']) && HASH.test(value.sha256 ?? '') && typeof value.path === 'string' && value.path && !/[\\\0:]/.test(value.path) && !value.path.startsWith('/') && !value.path.split('/').some(part => !part || part === '.' || part === '..'), code)
  return value
}
function snapshotReader(reader) {
  check(typeof reader === 'function', 'initial_evidence_reader_required')
  const cache = new Map()
  return path => { if (!cache.has(path)) { const bytes = reader(path); check(Buffer.isBuffer(bytes), 'non_byte_initial_evidence'); cache.set(path, Buffer.from(bytes)) } return Buffer.from(cache.get(path)) }
}

/** Initial pass@5 uses only the frozen five original slots. Correction ledger
 * is a separate namespace; no unchecked replay result or verdict can fill one.
 * A known scenario success is not proof that every scheduled execution finished.
 * Correction success rate excludes technical/unjudged replays; their score is null. */
export function aggregatePhase4Metrics({ root, manifest, initialResults = [], correctionLedger = null, readEvidence }) {
  const { manifestHash, ...base } = manifest ?? {}
  check(manifest?.schemaVersion === 'gaia2-run-manifest-v1' && manifest.mode === 'internal_pass5' && manifestHash === digest(base) && manifest.policy?.initialRunsPerScenario === 5 && manifest.policy.maxCorrections === 0 && Array.isArray(manifest.tasks) && manifest.tasks.length === 25, 'not_frozen_25_initial_plan')
  const planned = new Map(), groups = new Map()
  for (const task of manifest.tasks) {
    check(task.correctionOrdinal === 0 && task.attemptIndex === task.runNumber && Number.isInteger(task.runNumber) && task.runNumber >= 1 && task.runNumber <= 5 && !planned.has(task.executionId), 'invalid_initial_identity')
    planned.set(task.executionId, task)
    if (!groups.has(key(task))) groups.set(key(task), [])
    groups.get(key(task)).push(task)
  }
  check(groups.size === 5 && [...groups.values()].every(tasks => tasks.length === 5 && digest(tasks.map(task => task.runNumber).sort()) === digest([1, 2, 3, 4, 5])), 'initial_five_slots_changed')
  check(Array.isArray(initialResults), 'initial_results_not_array')
  const observed = new Map(), verified = new Map(), eligibility = new Map()
  for (const entry of initialResults) {
    check(entry && planned.has(entry.executionId) && !observed.has(entry.executionId) && ['pending', 'technical', 'evaluated'].includes(entry.status), 'duplicate_unknown_or_invalid_initial_result')
    let original = entry
    if (entry.status === 'evaluated') {
      original = { ...entry, readEvidence: snapshotReader(entry.readEvidence ?? readEvidence) }
      const input = { ...original, manifest, task: planned.get(entry.executionId) }, proof = verifyInitialEvaluation(input)
      verified.set(entry.executionId, proof)
      if (!proof.businessPassed) {
        const evidence = deriveCorrectionEvidence(input)
        check(!evidence.eligible || evidence.verification.sourceHash === proof.sourceHash, 'initial_evidence_changed_during_eligibility')
        eligibility.set(entry.executionId, evidence)
      }
    }
    else if (entry.status === 'technical') check(entry.result?.evaluationComplete !== true && entry.result?.score == null && entry.result?.businessPassed == null, 'technical_attempt_cannot_be_score_zero')
    else check(entry.result == null, 'pending_attempt_has_result')
    observed.set(entry.executionId, original)
  }
  check(new Set([...verified.values()].map(proof => proof.source.stateHash)).size <= 1, 'initial_results_from_different_state_snapshots')
  const corrections = { skipped: 0, training_failed: 0, strategy_ready: 0, replay_evaluated: 0, replay_technical: 0 }, correctedParents = new Set(), correctionResults = new Map(), replayExecutions = new Set(), replayReports = new Set()
  let policySkippedCorrections = 0
  if (correctionLedger !== null) {
    check(correctionLedger.schemaVersion === 'gaia2-phase4-correction-ledger-v1' && Array.isArray(correctionLedger.entries), 'invalid_correction_ledger')
    for (const entry of correctionLedger.entries) {
      check(entry && planned.has(entry.parentExecutionId) && !correctedParents.has(entry.parentExecutionId) && entry.correctionOrdinal === 1, 'correction_parent_or_ordinal_changed')
      check(Object.hasOwn(corrections, entry.status), 'unknown_correction_status')
      check(!Object.hasOwn(entry, 'score') && !Object.hasOwn(entry, 'businessPassed') && !Object.hasOwn(entry, 'verdict'), 'unverified_correction_grade_not_allowed')
      const parent = verified.get(entry.parentExecutionId), original = observed.get(entry.parentExecutionId)
      check(parent && !parent.businessPassed && entry.parentSessionId === original.session.sessionId && entry.parentResultHash === parent.source.resultHash, 'correction_requires_verified_initial_business_failure')
      const evidence = eligibility.get(entry.parentExecutionId)
      check(evidence?.eligible === true, 'correction_eligibility_unavailable')
      if (entry.trainingReceipt !== null) strictRef(entry.trainingReceipt, 'invalid_training_receipt_reference')
      check(entry.strategyHash === null || HASH.test(entry.strategyHash ?? ''), 'invalid_strategy_hash')
      let replay = null, resolved = false
      if (entry.status === 'skipped') {
        check(['no_observable_defect', 'policy_skip'].includes(entry.reason), 'invalid_skip_reason')
        check(entry.trainingReceipt === null && entry.strategyHash === null && entry.replayReportRef == null, 'skipped_correction_has_training_or_replay')
        if (entry.reason === 'no_observable_defect') check(evidence.trainingAllowed === false && evidence.reason === 'no_observable_defect', 'observable_defect_cannot_be_hidden_by_skip')
        else policySkippedCorrections++
        resolved = true
      } else {
        check(evidence.trainingAllowed === true, 'training_requires_observable_defect')
        if (['strategy_ready', 'replay_evaluated', 'replay_technical'].includes(entry.status)) check(entry.trainingReceipt && HASH.test(entry.strategyHash ?? ''), 'ready_strategy_requires_receipt_and_hash')
        if (entry.status === 'replay_evaluated') {
          strictRef(entry.replayReportRef, 'independent_fresh_replay_reference_required')
          check(!replayReports.has(entry.replayReportRef.path), 'duplicate_replay_report')
          replay = verifyCorrectionReplay({ root, replayReportRef: entry.replayReportRef, ...(entry.readEvidence ?? readEvidence ? { readEvidence: entry.readEvidence ?? readEvidence } : {}) })
          check(replay.schemaVersion === 'gaia2-phase4-replay-verification-v1' && replay.parentExecutionId === entry.parentExecutionId && replay.parentSessionId === entry.parentSessionId && replay.parentResultHash === entry.parentResultHash && replay.correctionOrdinal === 1 && replay.initialAttemptCountDelta === 0 && replay.strategyHash === entry.strategyHash && replay.trainingReceiptHash === entry.trainingReceipt.sha256 && digest(replay.trainingReceipt) === digest(entry.trainingReceipt), 'independent_replay_lineage_mismatch')
          check(typeof replay.businessPassed === 'boolean' && replay.score === Number(replay.businessPassed) && replay.runtimeProof?.realHooksReady === true && HASH.test(replay.sourceHash ?? '') && !planned.has(replay.executionId) && !replayExecutions.has(replay.executionId), 'independent_replay_grade_or_identity_invalid')
          replayReports.add(entry.replayReportRef.path); replayExecutions.add(replay.executionId); resolved = true
        } else {
          check(entry.status === 'replay_technical' || entry.replayReportRef == null, 'non_replay_status_has_replay_report')
          if (entry.replayReportRef != null) strictRef(entry.replayReportRef, 'invalid_technical_replay_reference')
        }
      }
      correctionResults.set(entry.parentExecutionId, { parentExecutionId: entry.parentExecutionId, status: entry.status, reason: entry.status === 'skipped' ? entry.reason : null, resolved, evaluationComplete: replay !== null, score: replay?.score ?? null, businessPassed: replay?.businessPassed ?? null, ...(replay ? { replayExecutionId: replay.executionId, replaySourceHash: replay.sourceHash, replayReportRef: { ...entry.replayReportRef } } : {}) })
      correctedParents.add(entry.parentExecutionId); corrections[entry.status]++
    }
  }
  let implicitNoObservableDefectSkips = 0, missingCorrectionDecisions = 0
  for (const [executionId, evidence] of eligibility) if (!correctionResults.has(executionId)) {
    const noDefect = evidence.eligible === true && evidence.trainingAllowed === false && evidence.reason === 'no_observable_defect'
    if (noDefect) implicitNoObservableDefectSkips++
    else missingCorrectionDecisions++
    correctionResults.set(executionId, { parentExecutionId: executionId, status: noDefect ? 'implicit_skip' : 'unresolved', reason: noDefect ? 'no_observable_defect' : evidence.eligible ? 'missing_correction_decision' : 'eligibility_unavailable', resolved: noDefect, evaluationComplete: false, score: null, businessPassed: null })
  }
  const scenarios = [...groups.values()].map(tasks => {
    const evaluated = tasks.map(task => verified.get(task.executionId)).filter(Boolean), passed = evaluated.some(result => result.businessPassed), complete = evaluated.length === 5
    const ledger = tasks.map(task => correctionResults.get(task.executionId)).filter(Boolean), unresolved = ledger.filter(item => !item.resolved).length
    const replayPassed = ledger.some(item => item.evaluationComplete && item.businessPassed), correctedPassed = passed || replayPassed
    const correctedComplete = complete && unresolved === 0
    return { phase: tasks[0].phase, config: tasks[0].config, scenarioId: tasks[0].scenarioId, initialPlannedAttempts: 5, evaluatedInitialAttempts: evaluated.length, missingValidInitialAttempts: 5 - evaluated.length, technicalInitialAttempts: tasks.filter(task => observed.get(task.executionId)?.status === 'technical').length, status: passed ? 'passed' : complete ? 'failed' : 'incomplete', initialPassAt5: passed ? 1 : complete ? 0 : null, correctedStatus: correctedPassed ? 'passed' : correctedComplete ? 'failed' : 'incomplete', correctedTaskSuccess: correctedPassed ? 1 : correctedComplete ? 0 : null, correctedEvaluationComplete: correctedComplete, unresolvedCorrections: unresolved, evaluatedCorrectionReplays: ledger.filter(item => item.evaluationComplete).length }
  })
  const passed = scenarios.filter(item => item.status === 'passed').length, incomplete = scenarios.filter(item => item.status === 'incomplete').length
  const replayResults = [...correctionResults.values()].filter(item => item.evaluationComplete), replaySuccesses = replayResults.filter(item => item.businessPassed).length
  const correctedPassed = scenarios.filter(item => item.correctedStatus === 'passed').length, correctedIncomplete = scenarios.filter(item => item.correctedStatus === 'incomplete').length
  const unresolvedCorrections = [...correctionResults.values()].filter(item => !item.resolved).length, correctedEvaluationComplete = verified.size === 25 && unresolvedCorrections === 0
  const initialSuccesses = [...verified.values()].filter(item => item.businessPassed).length
  const initialTechnical = [...observed.values()].filter(item => item.status === 'technical').length
  const initialTerminal = verified.size + initialTechnical
  return {
    schemaVersion: 'gaia2-phase4-metrics-v1', manifestHash, initialAttemptCount: 25,
    evaluatedInitialAttempts: verified.size, missingValidInitialAttempts: 25 - verified.size,
    initialInfrastructureErrorAttempts: initialTechnical,
    initialBusinessSuccessAttempts: initialSuccesses,
    initialBusinessFailureAttempts: [...verified.values()].filter(item => !item.businessPassed).length,
    initialAttemptSuccessRate: verified.size ? initialSuccesses / verified.size : null,
    initialAttemptSuccessRateDenominator: verified.size,
    initialInfrastructureErrorRate: initialTerminal ? initialTechnical / initialTerminal : null,
    initialInfrastructureErrorRateDenominator: initialTerminal,
    initialEvaluationComplete: verified.size === 25,
    initialPassAt5: incomplete ? null : passed / scenarios.length,
    initialPassAt5Bounds: { lower: passed / scenarios.length, upper: (passed + incomplete) / scenarios.length },
    scenarios, correctionLedgerObserved: correctionLedger !== null, correctionStatuses: corrections,
    correctionResults: [...correctionResults.values()], implicitNoObservableDefectSkips, missingCorrectionDecisions, policySkippedCorrections, unresolvedCorrections,
    correctionReplayEvaluated: replayResults.length, correctionReplaySuccesses: replaySuccesses,
    correctionReplayBusinessFailures: replayResults.length - replaySuccesses,
    correctionInfrastructureErrorAttempts: corrections.replay_technical,
    correctionSuccessRate: replayResults.length ? replaySuccesses / replayResults.length : null,
    correctedTaskSuccess: correctedIncomplete ? null : correctedPassed / scenarios.length,
    correctedTaskSuccessBounds: { lower: correctedPassed / scenarios.length, upper: (correctedPassed + correctedIncomplete) / scenarios.length },
    correctedEvaluationComplete, correctionMetricStatus: correctedEvaluationComplete ? 'complete' : 'incomplete',
    realCorrectionEndToEndReady: false,
    correctionAttemptsCountedAsInitial: 0, completePass5: verified.size === 25,
    officialSubmissionReady: false,
  }
}
