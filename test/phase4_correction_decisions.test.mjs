import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCorrectionDecisionTemplate } from '../src/phase4_correction_decisions.mjs'

const base = { schemaVersion: 'gaia2-phase9-correction-attribution-v1', manifestHash: 'a'.repeat(64), answerBlind: true, totalInitialAttempts: 2, entries: [
  { executionId: 'a', parentSessionId: '0001-aaaaaaaaaaa', parentResultHash: 'b'.repeat(64), eligible: true, trainingAllowed: true, attribution: 'observable_defects', decisionState: 'decision_required', defects: [{ defectCode: 'read_failed' }] },
  { executionId: 'b', parentSessionId: '0001-bbbbbbbbbbb', parentResultHash: 'c'.repeat(64), eligible: true, trainingAllowed: false, attribution: 'no_observable_defect', decisionState: 'skip_no_observable_defect', defects: [] },
] }

test('decision template separates explicit skip from pending decisions', () => {
  const report = buildCorrectionDecisionTemplate({ attribution: base, attributionSha256: 'd'.repeat(64) })
  assert.equal(report.explicitSkips, 1)
  assert.equal(report.pendingDecisions, 1)
  assert.equal(report.ledgerCompatible, false)
  assert.equal(report.decisions[0].status, 'pending')
  assert.equal(report.decisions[1].status, 'skipped')
  assert.equal(report.decisions[1].reason, 'no_observable_defect')
})

test('pending decision cannot be mislabeled as an explicit skip', () => {
  const altered = structuredClone(base); altered.entries[0].decisionState = 'skip_no_observable_defect'
  assert.throws(() => buildCorrectionDecisionTemplate({ attribution: altered }), /invalid_explicit_skip/)
})
