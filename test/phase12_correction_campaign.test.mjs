import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCorrectionCampaign, verifyCorrectionCampaign } from '../src/phase12_correction_campaign.mjs'

const manifestHash = 'a'.repeat(64), attributionSha256 = 'b'.repeat(64), decisionSha256 = 'c'.repeat(64)
const manifest = { schemaVersion: 'gaia2-run-manifest-v1', mode: 'internal_pass5', manifestHash }
const attribution = { schemaVersion: 'gaia2-phase9-correction-attribution-v1', answerBlind: true, manifestHash, totalInitialAttempts: 2, entries: [
  { executionId: 'e1', parentSessionId: 's1', parentResultHash: 'd'.repeat(64), trainingAllowed: true, decisionState: 'decision_required' },
  { executionId: 'e2', parentSessionId: 's2', parentResultHash: 'e'.repeat(64), trainingAllowed: false, decisionState: 'skip_no_observable_defect' },
] }
const decisions = { schemaVersion: 'gaia2-phase9-correction-decision-template-v1', answerBlind: true, manifestHash, attributionSha256, correctionOrdinal: 1, decisions: [
  { parentExecutionId: 'e1', parentSessionId: 's1', parentResultHash: 'd'.repeat(64), correctionOrdinal: 1, status: 'pending', reason: null, requiredDefectCodes: ['read_failed'], decisionComplete: false },
  { parentExecutionId: 'e2', parentSessionId: 's2', parentResultHash: 'e'.repeat(64), correctionOrdinal: 1, status: 'skipped', reason: 'no_observable_defect', requiredDefectCodes: [], decisionComplete: true },
] }

test('campaign keeps pending and explicit skip entries separate', () => {
  const campaign = buildCorrectionCampaign({ decisions, attribution, manifest, attributionSha256, decisionSha256, baselineAudit: { phase0Passed: false, status: 'failed', errors: ['drift'], knownGaps: [] } })
  assert.equal(campaign.pendingCount, 1)
  assert.equal(campaign.explicitSkipCount, 1)
  assert.equal(campaign.executionReady, false)
  assert.equal(campaign.ledgerCompatible, false)
  assert.equal(verifyCorrectionCampaign(campaign).queueCount, 2)
})

test('campaign requires same-manifest parent evidence before execution', () => {
  const campaign = buildCorrectionCampaign({ decisions, attribution, manifest, attributionSha256, decisionSha256, parentResults: [{ executionId: 'e1', sessionId: 's1', resultHash: 'd'.repeat(64) }], baselineAudit: { phase0Passed: true, status: 'passed', errors: [], knownGaps: [] } })
  assert.equal(campaign.parentEvidence.complete, false)
  assert.equal(campaign.parentEvidence.missing.length, 1)
  assert.equal(campaign.executionReady, false)
})

test('manifest and attribution binding cannot be mixed', () => {
  assert.throws(() => buildCorrectionCampaign({ decisions, attribution: { ...attribution, manifestHash: 'f'.repeat(64) }, manifest, attributionSha256, decisionSha256 }), /manifest_binding_mismatch/)
})

test('explicit skips cannot carry defect procedures', () => {
  const altered = structuredClone(decisions)
  altered.decisions[1].requiredDefectCodes = ['read_failed']
  assert.throws(() => buildCorrectionCampaign({ decisions: altered, attribution, manifest, attributionSha256, decisionSha256 }), /invalid_explicit_skip/)
})
