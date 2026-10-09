import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { digest, fileDigest } from '../src/phase0_run.mjs'
import { aggregatePhase4Metrics } from '../src/phase4_metrics.mjs'
import { runtimeFixture } from './support/runtime_evidence_fixture.mjs'
import { controlledReplayFixture, controlledReplayEvidenceFixture } from './support/correction_replay_fixture.mjs'
import { aggregateCorrectionUsage } from '../src/phase4_usage.mjs'

function plan(first = null) {
  const tasks = ['execution', 'search', 'adaptability', 'time', 'ambiguity'].flatMap(config => Array.from({ length: 5 }, (_, index) => ({ executionId: `${config}-${index + 1}`, scenarioId: config === 'execution' && first ? first.scenarioId : `source-${config}`, phase: 'standard', config, runNumber: index + 1, attemptIndex: index + 1, correctionOrdinal: 0 })))
  if (first) tasks[0] = first
  const base = { schemaVersion: 'gaia2-run-manifest-v1', runId: 'initial', mode: 'internal_pass5', tasks, policy: { initialRunsPerScenario: 5, maxCorrections: 0 } }
  return { ...base, manifestHash: digest(base) }
}
function oneVerifiedAttempt(passed = false, defect = false) {
  const f = runtimeFixture(), { root, session, task, put } = f
  const { manifestHash: _, ...base } = f.manifest
  Object.assign(base, { schemaVersion: 'gaia2-run-manifest-v1', tasks: plan(task).tasks })
  const manifest = { ...base, manifestHash: digest(base) }, events = structuredClone(f.events)
  events.find(event => event.type === 'attempt_execution_ended').terminationReason = 'conversation_turn_limit'
  events.at(-1).validationSuccess = passed
  let runtimeEvidence = f.collected.runtimeEvidence
  if (defect) {
    const path = f.collected.runtimeAttestation.invocationPaths.find(path => path.endsWith('-after_tool.json'))
    const receipt = JSON.parse(readFileSync(join(root, path), 'utf8'))
    receipt.input.outcome.status = 'failed_before_execution'; put(path, receipt)
    events.find(event => event.type === 'tool_call_completed').status = 'failed_before_execution'
    runtimeEvidence = runtimeEvidence.map(ref => ref.path === path ? { path, sha256: fileDigest(join(root, path)) } : ref)
  }
  put(`${session.outputDir}/runtime-events.jsonl`, events.map(event => JSON.stringify(event)).join('\n') + '\n')
  const runtime = { processTimeoutMs: 0 }; put(`${manifest.runRoot}/runtime-settings.json`, runtime)
  put(`${session.outputDir}/process-result.json`, { ...f.hostProcess, childExited: true, childClosed: true })
  const artifacts = [
    put(`${session.outputDir}/output.jsonl`, JSON.stringify({ task_id: task.scenarioId, trace_id: 'hf/trace.json', score: passed ? 1 : 0, metadata: { scenario_id: task.scenarioId, run_number: 1, status: passed ? 'success' : 'failed', has_exception: false } }) + '\n'),
    put(`${session.outputDir}/hf/trace.json`, { world_logs: [], apps: [], events: [], completed_events: [], version: 'fixture', context: {}, augmentation: null, metadata: { definition: { scenario_id: task.scenarioId, run_number: 1, has_exception: false } } }),
  ]
  const result = { schemaVersion: 'gaia2-task-result-v1', runId: manifest.runId, manifestHash: manifest.manifestHash, runtimeHash: digest(runtime), sessionId: session.sessionId, ...Object.fromEntries(['executionId', 'scenarioId', 'phase', 'config', 'runNumber'].map(key => [key, task[key]])), score: passed ? 1 : 0, businessPassed: passed, evaluationComplete: true, failure: passed ? null : { category: 'business_failure', retryable: false }, process: { exitCode: 0, signal: null, timedOut: false, interrupted: false }, artifacts, runtimeEvidenceRequired: true, realHooksReady: true, runtimeEvidence, runtimeAttestation: { ...f.collected.runtimeAttestation, manifestHash: manifest.manifestHash, eventsHash: digest(events), evidenceHash: digest(runtimeEvidence) } }
  const resultRef = put(`${session.workspaceDir}/task-result.json`, result)
  put(manifest.stateFile, { schemaVersion: 'gaia2-run-state-v1', runId: manifest.runId, manifestHash: manifest.manifestHash, runtimeHash: result.runtimeHash, tasks: [{ executionId: task.executionId, status: 'completed', sessions: [session], resultPath: resultRef.path, resultSha256: resultRef.sha256, failure: result.failure }] })
  return { root, put, manifest, entry: { executionId: task.executionId, status: 'evaluated', session, result, events, readEvidence: path => readFileSync(join(root, path)) }, resultRef }
}

test('Phase 4 unexecuted/technical original slots remain incomplete, never fabricated business zeros', () => {
  const manifest = plan(), metrics = aggregatePhase4Metrics({ manifest, initialResults: [{ executionId: manifest.tasks[0].executionId, status: 'technical', result: { evaluationComplete: false, score: null, businessPassed: null } }] })
  assert.equal(metrics.initialAttemptCount, 25); assert.equal(metrics.evaluatedInitialAttempts, 0)
  assert.equal(metrics.initialInfrastructureErrorAttempts, 1); assert.equal(metrics.initialBusinessFailureAttempts, 0)
  assert.equal(metrics.initialPassAt5, null); assert.equal(metrics.completePass5, false)
  assert.ok(metrics.scenarios.every(scenario => scenario.status === 'incomplete' && scenario.initialPassAt5 === null))
  assert.deepEqual(metrics.initialPassAt5Bounds, { lower: 0, upper: 1 })
  assert.equal(metrics.initialAttemptSuccessRate, null); assert.equal(metrics.initialAttemptSuccessRateDenominator, 0)
  assert.equal(metrics.initialInfrastructureErrorRate, 1); assert.equal(metrics.initialInfrastructureErrorRateDenominator, 1)
})

test('Phase 4 one valid business failure does not imply five failures or complete pass@5', () => {
  const f = oneVerifiedAttempt(false), metrics = aggregatePhase4Metrics({ manifest: f.manifest, initialResults: [f.entry] })
  assert.equal(metrics.evaluatedInitialAttempts, 1); assert.equal(metrics.initialBusinessFailureAttempts, 1)
  assert.equal(metrics.missingValidInitialAttempts, 24); assert.equal(metrics.initialPassAt5, null)
  assert.equal(metrics.scenarios[0].status, 'incomplete'); assert.equal(metrics.scenarios[0].initialPassAt5, null)
  assert.equal(metrics.implicitNoObservableDefectSkips, 1)
  assert.equal(metrics.correctionSuccessRate, null); assert.equal(metrics.correctedEvaluationComplete, false)
  assert.equal(metrics.initialAttemptSuccessRate, 0); assert.equal(metrics.initialAttemptSuccessRateDenominator, 1)
  assert.equal(metrics.initialInfrastructureErrorRate, 0); assert.equal(metrics.initialInfrastructureErrorRateDenominator, 1)
})

test('Phase 4 an observed initial success is known, but pending slots still prevent full-run completion', () => {
  const f = oneVerifiedAttempt(true), metrics = aggregatePhase4Metrics({ manifest: f.manifest, initialResults: [f.entry] })
  assert.equal(metrics.initialBusinessSuccessAttempts, 1); assert.equal(metrics.scenarios[0].initialPassAt5, 1)
  assert.equal(metrics.scenarios[0].status, 'passed'); assert.equal(metrics.initialPassAt5, null)
  assert.deepEqual(metrics.initialPassAt5Bounds, { lower: 0.2, upper: 1 })
  assert.equal(metrics.initialEvaluationComplete, false); assert.equal(metrics.completePass5, false)
  assert.equal(metrics.scenarios[0].correctedTaskSuccess, 1); assert.equal(metrics.correctedTaskSuccess, null)
  assert.deepEqual(metrics.correctedTaskSuccessBounds, { lower: 0.2, upper: 1 })
  assert.equal(metrics.initialAttemptSuccessRate, 1); assert.equal(metrics.initialInfrastructureErrorRate, 0)
})

test('Phase 4 correction ledger stays separate and unverified replay_evaluated is fail closed', () => {
  const f = oneVerifiedAttempt(false), parent = { parentExecutionId: f.entry.executionId, parentSessionId: f.entry.session.sessionId, parentResultHash: f.resultRef.sha256, correctionOrdinal: 1, trainingReceipt: null, strategyHash: null }
  const correctionLedger = { schemaVersion: 'gaia2-phase4-correction-ledger-v1', entries: [{ ...parent, status: 'skipped', reason: 'no_observable_defect' }] }
  const metrics = aggregatePhase4Metrics({ manifest: f.manifest, initialResults: [f.entry], correctionLedger })
  assert.equal(metrics.correctionStatuses.skipped, 1); assert.equal(metrics.evaluatedInitialAttempts, 1)
  assert.equal(metrics.correctionAttemptsCountedAsInitial, 0); assert.equal(metrics.correctedTaskSuccess, null)
  correctionLedger.entries[0].status = 'replay_evaluated'
  assert.throws(() => aggregatePhase4Metrics({ manifest: f.manifest, initialResults: [f.entry], correctionLedger }), /training_requires_observable_defect/)
})

test('Phase 4 missing defect decisions, training failures, strategy-only and technical replays stay unresolved/null', () => {
  const f = oneVerifiedAttempt(false, true), input = { manifest: f.manifest, initialResults: [f.entry] }
  const empty = aggregatePhase4Metrics(input)
  assert.equal(empty.missingCorrectionDecisions, 1); assert.equal(empty.unresolvedCorrections, 1)
  const parent = { parentExecutionId: f.entry.executionId, parentSessionId: f.entry.session.sessionId, parentResultHash: f.resultRef.sha256, correctionOrdinal: 1, trainingReceipt: { path: 'runs/training/actual-invoked.json', sha256: 'a'.repeat(64) }, strategyHash: 'b'.repeat(64) }
  for (const status of ['training_failed', 'strategy_ready', 'replay_technical']) {
    const metrics = aggregatePhase4Metrics({ ...input, correctionLedger: { schemaVersion: 'gaia2-phase4-correction-ledger-v1', entries: [{ ...parent, status }] } })
    assert.equal(metrics.unresolvedCorrections, 1); assert.equal(metrics.correctionSuccessRate, null)
    assert.equal(metrics.correctedEvaluationComplete, false); assert.equal(metrics.correctionReplayEvaluated, 0)
    assert.equal(metrics.correctionResults[0].score, null); assert.equal(metrics.correctionResults[0].businessPassed, null)
    assert.equal(metrics.correctionInfrastructureErrorAttempts, Number(status === 'replay_technical'))
    assert.equal(metrics.evaluatedInitialAttempts, 1); assert.equal(metrics.initialBusinessFailureAttempts, 1)
  }
  const ledger = { schemaVersion: 'gaia2-phase4-correction-ledger-v1', entries: [{ ...parent, status: 'replay_evaluated' }] }
  assert.throws(() => aggregatePhase4Metrics({ ...input, correctionLedger: ledger }), /fresh_replay_reference_required/)
})

test('Phase 4 skip reasons are enumerated and policy skips cannot masquerade as no observable defect', () => {
  const f = oneVerifiedAttempt(false, true), input = { manifest: f.manifest, initialResults: [f.entry] }, parent = { parentExecutionId: f.entry.executionId, parentSessionId: f.entry.session.sessionId, parentResultHash: f.resultRef.sha256, correctionOrdinal: 1, trainingReceipt: null, strategyHash: null, status: 'skipped' }
  const apply = reason => aggregatePhase4Metrics({ ...input, correctionLedger: { schemaVersion: 'gaia2-phase4-correction-ledger-v1', entries: [{ ...parent, reason }] } })
  assert.throws(() => apply('arbitrary free text'), /invalid_skip_reason/)
  assert.throws(() => apply('no_observable_defect'), /defect_cannot_be_hidden/)
  const metrics = apply('policy_skip')
  assert.equal(metrics.policySkippedCorrections, 1); assert.equal(metrics.unresolvedCorrections, 0)
  assert.equal(metrics.realCorrectionEndToEndReady, false); assert.equal(metrics.correctionSuccessRate, null)
  assert.equal(metrics.correctedEvaluationComplete, false)
})

const replayLedger = fixture => ({ schemaVersion: 'gaia2-phase4-correction-ledger-v1', entries: [{
  parentExecutionId: fixture.entry.executionId, parentSessionId: fixture.entry.session.sessionId,
  parentResultHash: fixture.replayVerified.parentResultHash, correctionOrdinal: 1, status: 'replay_evaluated',
  trainingReceipt: { ...fixture.replayVerified.trainingReceipt }, strategyHash: fixture.replayVerified.strategyHash,
  replayReportRef: { ...fixture.replayReportRef },
}] })

test('Phase 4 controlled replay rejects failed/missing training proof before filesystem or replay execution', async () => {
  for (const training of [
    { status: 'training_failed', hostResult: { failureCode: 'training_host_or_provider_failure', cleanupCompleted: true }, processResult: { childClosed: true } },
    { status: 'strategy_ready' },
    { status: 'strategy_ready', trainingReportRef: { path: 'irrelevant.json', sha256: 'invalid' } },
  ]) {
    // No root/manifest/fixture paths exist in these inputs. The status guard
    // must reject before joining a path, spawning a Host, or using a provider.
    await assert.rejects(() => controlledReplayFixture({ after: () => assert.fail('unexpected cleanup registration') }, { training }),
      /CONTROLLED_REPLAY_TRAINING_NOT_READY/)
  }
})

test('Phase 4 independently judged fresh replay success improves only corrected scenario metric, never initial slots', async t => {
  const f = await controlledReplayEvidenceFixture(t, { passed: true, fullInitialPlan: true })
  const input = { root: f.root, manifest: f.initialManifest, initialResults: [f.entry], correctionLedger: replayLedger(f), readEvidence: f.readEvidence }
  const metrics = aggregatePhase4Metrics(input)
  assert.equal(f.report.benchmarkExecuted, false); assert.equal(f.report.realModelCalls, 0)
  assert.equal(metrics.evaluatedInitialAttempts, 1); assert.equal(metrics.initialBusinessFailureAttempts, 1)
  assert.equal(metrics.missingValidInitialAttempts, 24); assert.equal(metrics.initialPassAt5, null)
  assert.deepEqual(metrics.initialPassAt5Bounds, { lower: 0, upper: 1 })
  assert.equal(metrics.correctionReplayEvaluated, 1); assert.equal(metrics.correctionReplaySuccesses, 1)
  assert.equal(metrics.correctionSuccessRate, 1); assert.equal(metrics.correctionReplayBusinessFailures, 0)
  assert.equal(metrics.scenarios[0].correctedTaskSuccess, 1); assert.equal(metrics.correctedTaskSuccess, null)
  assert.deepEqual(metrics.correctedTaskSuccessBounds, { lower: 0.2, upper: 1 })
  assert.equal(metrics.unresolvedCorrections, 0); assert.equal(metrics.correctedEvaluationComplete, false)
  assert.equal(metrics.correctionAttemptsCountedAsInitial, 0); assert.equal(metrics.completePass5, false)
  assert.equal(metrics.realCorrectionEndToEndReady, false); assert.equal(metrics.officialSubmissionReady, false)
  assert.equal(metrics.correctionResults[0].replaySourceHash, f.replayVerified.sourceHash)
  const usage = aggregateCorrectionUsage(input)
  assert.equal(usage.correctionUsageComplete, true); assert.equal(usage.verifiedExecutions.length, 2)
  assert.deepEqual(usage.verifiedExecutions.map(item => item.kind), ['training', 'replay'])
  assert.equal(usage.usage.byKind.training.correction.successfulCompletions, 1)
  assert.equal(usage.usage.byKind.initial.actor.requestAttempts, 0)
  assert.equal(usage.usage.byKind.replay.actor.successfulCompletions, f.events.filter(event => event.type === 'model_request_succeeded' && event.modelRole === 'actor').length)
  assert.equal(usage.usage.requestAttemptsAreSdkInvocationsNotHttpProof, true, 'instrumented fake Actor events do not prove live model calls')
  assert.equal(usage.realCorrectionEndToEndReady, false); assert.equal(usage.usage.monetaryCost, null)
  const incompleteLedger = replayLedger(f)
  incompleteLedger.entries[0].status = 'replay_technical'
  incompleteLedger.entries[0].trainingReportRef = JSON.parse(f.readEvidence(f.replayReportRef.path)).correctionContext.trainingReportRef
  const incompleteUsage = aggregateCorrectionUsage({ ...input, correctionLedger: incompleteLedger })
  assert.equal(incompleteUsage.correctionUsageComplete, false); assert.equal(incompleteUsage.usage, null)
  assert.equal(incompleteUsage.knownUsage.byKind.training.correction.successfulCompletions, 1)
  assert.equal(incompleteUsage.verifiedExecutions.length, 1)

  // Mutations are on the input ledger or the reader's returned bytes, never files.
  for (const patch of [
    { parentSessionId: 'not-the-parent' }, { parentResultHash: '0'.repeat(64) }, { correctionOrdinal: 2 },
    { strategyHash: '0'.repeat(64) }, { trainingReceipt: { ...f.replayVerified.trainingReceipt, sha256: '0'.repeat(64) } },
    { trainingReceipt: { path: 'runs/forged-receipt.json', sha256: f.replayVerified.trainingReceipt.sha256 } },
    { replayReportRef: { ...f.replayReportRef, sha256: '0'.repeat(64) } }, { verdict: true }, { businessPassed: true }, { score: 1 },
  ]) {
    const ledger = replayLedger(f); Object.assign(ledger.entries[0], patch)
    assert.throws(() => aggregatePhase4Metrics({ ...input, correctionLedger: ledger }))
  }
  const sealedRef = f.replayVerified.evidenceRefs.find(ref => ref.path.endsWith('/task-result.json'))
  assert.ok(sealedRef)
  const corruptedReader = path => path === sealedRef.path ? Buffer.concat([f.readEvidence(path), Buffer.from(' ')]) : f.readEvidence(path)
  assert.throws(() => aggregatePhase4Metrics({ ...input, readEvidence: corruptedReader }), /SHA_changed/)
  assert.throws(() => aggregateCorrectionUsage({ ...input, readEvidence: corruptedReader }), /SHA_changed/)
  const foreignTraining = replayLedger(f)
  foreignTraining.entries[0].trainingReportRef = { path: 'runs/foreign-training-report.json', sha256: '0'.repeat(64) }
  assert.throws(() => aggregateCorrectionUsage({ ...input, correctionLedger: foreignTraining }), /replay_training_report_changed/)
})

test('Phase 4 independently judged fresh replay business failure is denominator score0, not technical or five original failures', async t => {
  const f = await controlledReplayEvidenceFixture(t, { passed: false, fullInitialPlan: true })
  const input = { root: f.root, manifest: f.initialManifest, initialResults: [f.entry], correctionLedger: replayLedger(f), readEvidence: f.readEvidence }
  const metrics = aggregatePhase4Metrics(input)
  assert.equal(metrics.correctionReplayEvaluated, 1); assert.equal(metrics.correctionReplaySuccesses, 0)
  assert.equal(metrics.correctionReplayBusinessFailures, 1); assert.equal(metrics.correctionSuccessRate, 0)
  assert.equal(metrics.correctionInfrastructureErrorAttempts, 0); assert.equal(metrics.correctionResults[0].score, 0)
  assert.equal(metrics.correctionResults[0].businessPassed, false); assert.equal(metrics.correctionResults[0].evaluationComplete, true)
  assert.equal(metrics.scenarios[0].correctedStatus, 'incomplete'); assert.equal(metrics.correctedTaskSuccess, null)
  assert.equal(metrics.initialBusinessFailureAttempts, 1); assert.equal(metrics.initialPassAt5, null)
  assert.equal(metrics.correctedEvaluationComplete, false); assert.equal(metrics.evaluatedInitialAttempts, 1)
})

test('Phase 4 rejects plan shrinkage, duplicate slots, forged evaluation, technical score0 and ledger grade flags', () => {
  const manifest = plan()
  assert.throws(() => aggregatePhase4Metrics({ manifest, initialResults: [{ executionId: manifest.tasks[0].executionId, status: 'technical', result: { score: 0 } }] }), /cannot_be_score_zero/)
  assert.throws(() => aggregatePhase4Metrics({ manifest, initialResults: [{ executionId: manifest.tasks[0].executionId, status: 'pending' }, { executionId: manifest.tasks[0].executionId, status: 'pending' }] }), /duplicate_unknown/)
  assert.throws(() => aggregatePhase4Metrics({ manifest, initialResults: [{ executionId: 'correction-child-not-original', status: 'evaluated' }] }), /duplicate_unknown/)
  assert.throws(() => aggregatePhase4Metrics({ manifest: { ...manifest, tasks: manifest.tasks.slice(0, 5) } }), /25_initial_plan/)
  const f = oneVerifiedAttempt(false), parent = { parentExecutionId: f.entry.executionId, parentSessionId: f.entry.session.sessionId, parentResultHash: f.resultRef.sha256, correctionOrdinal: 1, status: 'skipped', trainingReceipt: null, strategyHash: null, verdict: true }
  assert.throws(() => aggregatePhase4Metrics({ manifest: f.manifest, initialResults: [f.entry], correctionLedger: { schemaVersion: 'gaia2-phase4-correction-ledger-v1', entries: [parent] } }), /unverified_correction_grade/)
  f.entry.result.runtimeEvidence = []
  assert.throws(() => aggregatePhase4Metrics({ manifest: f.manifest, initialResults: [f.entry] }))
})
