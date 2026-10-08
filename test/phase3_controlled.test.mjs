import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileDigest } from '../src/phase0_run.mjs'
import { runPhase3ControlledValidation } from '../scripts/phase3_controlled_validation.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

test('real TS plugin host and tracked frozen hooks control real ARE callbacks through authenticated loopback IPC', { timeout: 240000 }, async () => {
  const report = await runPhase3ControlledValidation({ root })
  assert.equal(report.status, 'passed')
  assert.equal(report.realModelCalls, 0)
  assert.equal(report.benchmarkExecuted, false)
  assert.equal(report.syntheticFixtureOnly, true)
  assert.equal(report.officialSubmissionReady, false)
  assert.deepEqual(report.cases.map(item => item.case), ['dynamic', 'unknown', 'unverified_evidence', 'wait', 'hook_failure'])
  assert.equal(new Set(report.cases.map(item => item.executionId)).size, 5)
  assert.equal(new Set(report.cases.map(item => item.sessionId)).size, 5)
  for (const item of report.cases) {
    assert.equal(item.status, 'passed')
    assert.equal(item.realHost, true)
    assert.equal(item.actorContextBindingsChecked, true)
    assert.equal(item.hookSourceBindingsChecked, true)
    assert.equal(item.resultHashBindingsChecked, true)
    assert.equal(item.trainingHooksExecuted, false)
    assert.equal(item.hiddenAndFutureInputsAbsent, true)
    for (const artifact of [...item.artifacts, item.capabilities]) assert.equal(fileDigest(resolve(root, artifact.path)), artifact.sha256)
    if (item.trackedPluginProfile) {
      assert.equal(item.productionAttestationVerified, true)
      assert.equal(item.readyPidMatchesSupervisedPid, true)
      assert.equal(item.productionEvidenceSummary.realHooksReady, false)
      assert.equal(item.productionEvidenceSummary.actorInputHashReconstructed, false)
      assert.equal(fileDigest(resolve(root, item.productionRuntimeEvidence.path)), item.productionRuntimeEvidence.sha256)
    } else {
      assert.equal(item.productionAttestationVerified, false)
      assert.equal(item.productionAttestationExcludedReason, 'intentionally_faulted_after_tool_hook')
    }
  }
  assert.equal(report.cases.filter(item => item.trackedPluginProfile).length, 4)
  assert.equal(report.cases.filter(item => item.intentionallyFaultedHook).length, 1)
  assert.equal(JSON.parse(readFileSync(report.reportPath, 'utf8')).runId, report.runId)
})
