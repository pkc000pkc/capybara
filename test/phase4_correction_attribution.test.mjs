import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCorrectionAttribution } from '../src/phase4_correction_attribution.mjs'

const manifest = { schemaVersion: 'gaia2-run-manifest-v1', mode: 'internal_pass5', manifestHash: 'a'.repeat(64), runId: 'run', tasks: [
  { executionId: 'execution-1', correctionOrdinal: 0, attemptIndex: 1, runNumber: 1, phase: 'standard', config: 'execution', scenarioId: 'scenario' },
  { executionId: 'execution-2', correctionOrdinal: 0, attemptIndex: 2, runNumber: 2, phase: 'standard', config: 'execution', scenarioId: 'scenario' },
] }
const evidence = ({ defect = true } = {}) => ({ eligible: true, trainingAllowed: defect, reason: defect ? 'observable_defects' : 'no_observable_defect', valid: { runtimeProof: true, evaluationComplete: true }, sealed: { observableSummary: { terminationReason: 'conversation_turn_limit', counts: { modelRequests: 1, toolCalls: 1, toolsExecuted: 1, blockedTools: 0 }, effects: ['read'], defects: defect ? [{ defectCode: 'read_failed', count: 1, evidenceHash: 'b'.repeat(64), procedureIds: ['reacquire_visible_resource'], verificationIds: ['successful_read_before_use'] }] : [] } } })

test('attribution report is answer-blind and aggregates verified defects', () => {
  const report = buildCorrectionAttribution({ manifest, parents: manifest.tasks.map((task, index) => ({ task, session: { sessionId: `000${index + 1}-aaaaaaaaaaa` }, resultHash: 'c'.repeat(64), evidence: evidence({ defect: index === 0 }) })) })
  assert.equal(report.totalInitialAttempts, 2)
  assert.equal(report.decisionRequiredAttempts, 1)
  assert.equal(report.noObservableDefectAttempts, 1)
  assert.deepEqual(report.defectCounts, { read_failed: 1 })
  assert.equal(report.entries[0].decisionState, 'decision_required')
  assert.equal(report.entries[1].decisionState, 'skip_no_observable_defect')
  assert.equal(report.answerBlind, true)
  assert.equal(report.ledgerReady, false)
})

test('attribution rejects unverified or malformed defects', () => {
  assert.throws(() => buildCorrectionAttribution({ manifest, parents: manifest.tasks.map(task => ({ task, session: { sessionId: '0001-aaaaaaaaaaa' }, resultHash: 'c'.repeat(64), evidence: { ...evidence(), valid: { runtimeProof: false, evaluationComplete: true } } })) }), /parent_not_verified/)
})
