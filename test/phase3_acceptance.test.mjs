import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertPartialAudit, assertStage3Plan, readPassingJUnit, runPhase3Acceptance, verifyControlledEvidence } from '../scripts/phase3_acceptance.mjs'

const temporary = () => mkdtempSync(join(tmpdir(), 'gaia2-phase3-acceptance-'))
function plan() {
  const configs = ['execution', 'search', 'adaptability', 'time', 'ambiguity']
  return {
    schemaVersion: 'gaia2-run-manifest-v1', mode: 'internal_pass5', dataset: { kind: 'source' },
    executionBinding: 'phase3_live_plugin_host_required',
    policy: { initialRunsPerScenario: 5, maxCorrections: 0 },
    selection: { expectedInitialExecutions: 25, perCapability: 1, fullOfficialCoverage: false },
    tasks: configs.flatMap(config => Array.from({ length: 5 }, (_, index) => ({
      phase: 'standard', config, scenarioId: `original-${config}`, runNumber: index + 1,
      attemptIndex: index + 1, correctionOrdinal: 0, executionId: `${config}-${index + 1}`,
    }))),
  }
}
function partial() {
  return {
    format_valid: true, coverage_complete: false, evaluation_complete: false,
    officialSubmissionReady: false, realHooksReady: false, officialCheckPassed: true,
    metrics: {
      targetCount: 25, rowCount: 5, uniqueRowCount: 5, missingRows: 20, duplicateRows: 0,
      unknownRows: 0, evaluatedRows: 5, provenanceValidRows: 5, runtimeAttestedRows: 5,
      realHookRows: 5, technicalCount: 0, officialReconstructedCount: 5,
      successCount: 2, businessFailureCount: 3,
    },
    issues: [{ gate: 'coverage', code: 'missing_execution_key' }, { gate: 'coverage', code: 'target_coverage_count_mismatch' }],
  }
}
function junit(tests, changes = {}) {
  const summary = { tests, pass: tests, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...changes }
  return `<testsuites>\n${Array.from({ length: tests }, (_, i) => `<testcase name="test-${i}"/>`).join('\n')}\n${Object.entries(summary).map(([key, value]) => `<!-- ${key} ${value} -->`).join('\n')}\n</testsuites>\n`
}

test('Phase 3 selects five originals without shrinking the 25-task pass@5 plan', () => {
  const manifest = plan(), selected = assertStage3Plan(manifest)
  assert.equal(selected.length, 5)
  assert.ok(selected.every(task => task.runNumber === 1))
  assert.equal(manifest.tasks.length - selected.length, 20)
  assert.deepEqual(manifest.policy, { initialRunsPerScenario: 5, maxCorrections: 0 })
})

test('Phase 3 rejects changed correction policy, missing samples and synthetic production claims', () => {
  for (const change of [
    manifest => { manifest.policy.maxCorrections = 1 },
    manifest => { manifest.tasks.pop() },
    manifest => { manifest.syntheticFixtureOnly = true },
    manifest => { manifest.executionBinding = 'fresh_capability_snapshot_with_typed_runtime_hooks' },
    manifest => { manifest.tasks[4].scenarioId = 'different-original' },
    manifest => { manifest.tasks[1].executionId = manifest.tasks[0].executionId },
  ]) {
    const manifest = plan(); change(manifest)
    assert.throws(() => assertStage3Plan(manifest), /Phase 3 acceptance/)
  }
})

test('Phase 3 JUnit reads actual testcase counts and enforces project minimum/backend exact count', () => {
  const root = temporary(), path = join(root, 'tests.xml')
  writeFileSync(path, junit(135))
  assert.deepEqual(readPassingJUnit(path, { minimum: 135 }), { tests: 135, failures: 0, errors: 0, skipped: 0 })
  writeFileSync(path, junit(92))
  assert.equal(readPassingJUnit(path, { exact: 92 }).tests, 92)
  assert.throws(() => readPassingJUnit(path, { minimum: 135 }), /test count differs/)
  writeFileSync(path, junit(93))
  assert.throws(() => readPassingJUnit(path, { exact: 92 }), /test count differs/)
})

test('Phase 3 JUnit fails closed on failures/errors, skipped/cancelled and malformed summaries', () => {
  const root = temporary(), path = join(root, 'tests.xml')
  for (const xml of [
    junit(1).replace('<testcase name="test-0"/>', '<testcase name="test-0"><failure/></testcase>'),
    junit(1).replace('<testcase name="test-0"/>', '<testcase name="test-0"><error/></testcase>'),
    junit(1, { cancelled: 1 }), junit(1, { skipped: 1 }), junit(1, { todo: 1 }),
    junit(1, { pass: 0 }), junit(1).replace('</testsuites>', ''),
  ]) {
    writeFileSync(path, xml)
    assert.throws(() => readPassingJUnit(path), /Phase 3 acceptance/)
  }
})

test('Phase 3 accepts partial judged rows including business failure without claiming complete pass@5', () => {
  const audit = partial()
  assert.equal(assertPartialAudit(audit), audit)
  assert.deepEqual([audit.format_valid, audit.coverage_complete, audit.evaluation_complete], [true, false, false])
  assert.equal(audit.metrics.businessFailureCount, 3)
  assert.equal(audit.officialSubmissionReady, false)
})

test('Phase 3 partial package rejects missing hooks, technical rows, wrong scope and readiness inflation', () => {
  for (const change of [
    audit => { audit.coverage_complete = true }, audit => { audit.evaluation_complete = true },
    audit => { audit.officialSubmissionReady = true }, audit => { audit.realHooksReady = true },
    audit => { audit.metrics.targetCount = 5 }, audit => { audit.metrics.rowCount = 4 },
    audit => { audit.metrics.realHookRows = 4 }, audit => { audit.metrics.provenanceValidRows = 4 },
    audit => { audit.metrics.technicalCount = 1 }, audit => { audit.metrics.officialReconstructedCount = 4 },
    audit => { audit.issues.push({ gate: 'evaluation', code: 'runtime_evidence_invalid' }) },
  ]) {
    const audit = partial(); change(audit)
    assert.throws(() => assertPartialAudit(audit), /Phase 3 acceptance/)
  }
})

test('Phase 3 control cannot pass without its source bindings or by claiming real models', () => {
  const controlled = {
    schemaVersion: 'gaia2-phase3-controlled-validation-v1', status: 'passed', syntheticFixtureOnly: true,
    realModelCalls: 0, benchmarkExecuted: false, externalNetworkUsed: false, uploaded: false,
    officialSubmissionReady: false, sourceBindings: [], cases: [],
  }
  const root = temporary()
  assert.throws(() => verifyControlledEvidence({ root, controlled, backendRoot: root, capabilities: { plugins: [] } }), /source coverage changed/)
  controlled.realModelCalls = 1
  assert.throws(() => verifyControlledEvidence({ root, controlled, backendRoot: root, capabilities: { plugins: [] } }), /scope overclaimed/)
})

test('Phase 3 acceptance rejects existing report and ambiguous input without overwriting evidence', async () => {
  const root = temporary(), report = join(root, 'acceptance.json'), original = '{"immutable":true}\n'
  writeFileSync(report, original)
  const common = ['--manifest', 'manifest.json', '--controlled', 'control.json', '--test-report', 'tests.xml', '--backend-test-report', 'backend.xml', '--report', 'acceptance.json']
  await assert.rejects(runPhase3Acceptance({ root, argv: [...common, '--package', 'package'] }), /new workspace path/)
  assert.equal(readFileSync(report, 'utf8'), original)
  await assert.rejects(runPhase3Acceptance({ root, argv: [...common, '--package', 'package', '--export-report', 'export.json'] }), /choose one/)
  await assert.rejects(runPhase3Acceptance({ root, argv: [...common, '--package', 'package', '--manifest', 'other.json'] }), /duplicate CLI/)
})
