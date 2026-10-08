import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditSubmissionPackage } from '../src/phase2_audit.mjs'
import { validateExportPlan } from '../src/phase2_export.mjs'
import { fileDigest, readJson, within, writeJson } from '../src/phase0_run.mjs'

// Recheck completed Phase 2 evidence without treating ongoing Phase 3 source
// changes as a newly frozen or execution-ready environment. No model or upload.
const root = dirname(dirname(fileURLToPath(import.meta.url))), args = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1]
  assert.ok(['--controlled', '--test-report', '--expected-tests', '--report'].includes(key) && value && !args[key], 'invalid historical recheck arguments')
  args[key] = key === '--expected-tests' ? value : resolve(root, value)
}
for (const key of ['--controlled', '--test-report', '--expected-tests', '--report']) assert.ok(args[key], `missing ${key}`)
assert.match(args['--expected-tests'], /^[1-9]\d*$/)
assert.equal(existsSync(args['--report']), false, 'do not overwrite previous reports')
const ref = path => ({ path: relative(root, path).replaceAll('\\', '/'), sha256: fileDigest(path) })
const historicalPath = join(root, 'reports/phase2-acceptance.json'), historical = readJson(historicalPath)
assert.equal(historical.phase2Passed, true)
for (const name of ['controlledEvidence', 'testReport', 'internalPlan', 'officialPlan', 'reusedUnchangedDataDeepAudit']) {
  const original = historical[name]
  assert.equal(fileDigest(resolve(root, original.path)), original.sha256, `historical ${name} changed`)
}
const plans = {}
for (const name of ['internalPlan', 'officialPlan']) {
  const plan = readJson(resolve(root, historical[name].path))
  const { frozenSources } = validateExportPlan(root, plan)
  // Report immutable historical paths even while direct current locks still
  // happen to match. A later freeze must not invalidate this evidence binding.
  const frozenSnapshots = Object.fromEntries(Object.entries(frozenSources).map(([key, path]) => {
    const archivePath = join(root, 'locks/archive/phase2-20261008', plan.lockRefs[key].path.split(/[\\/]/).at(-1))
    assert.equal(fileDigest(archivePath), plan.lockRefs[key].sha256, `archived ${key} changed`)
    assert.equal(fileDigest(path), fileDigest(archivePath), `resolved ${key} differs from archive`)
    return [key, ref(archivePath)]
  }))
  plans[name] = { ...historical[name], taskCount: plan.tasks.length, frozenSnapshots }
}
assert.equal(plans.internalPlan.taskCount, 25)
assert.equal(plans.officialPlan.taskCount, 3360)
const controlled = readJson(args['--controlled'])
assert.equal(controlled.status, 'passed')
for (const flag of ['syntheticFixtureOnly', 'noModelExecution', 'noBenchmarkExecution', 'noUpload']) assert.equal(controlled[flag], true)
assert.equal(controlled.sourceSessions, 3)
assert.equal(controlled.relocation.originalEvidenceUnchanged, true)
const packages = {}
for (const name of ['exported', 'relocation']) {
  const section = controlled[name]
  assert.ok(within(join(root, 'runs'), section.packageRoot))
  assert.equal(section.officialCheck.processHealthy, true)
  const audit = auditSubmissionPackage({ packageRoot: section.packageRoot, officialCheck: section.officialCheck })
  for (const gate of ['format_valid', 'coverage_complete', 'evaluation_complete', 'officialCheckPassed']) assert.equal(audit[gate], true)
  assert.equal(audit.metrics.rowCount, 3)
  assert.equal(audit.metrics.successCount, 2)
  assert.equal(audit.metrics.businessFailureCount, 1)
  assert.equal(audit.officialSubmissionReady, false)
  packages[name] = { manifest: ref(join(section.packageRoot, 'export-manifest.json')), gates: Object.fromEntries(['format_valid', 'coverage_complete', 'evaluation_complete', 'officialCheckPassed'].map(key => [key, audit[key]])) }
}
const expectedNegatives = {
  'missing-field': [false, false, false], 'duplicate-record': [true, false, false],
  'missing-run': [true, false, false], 'missing-trace': [false, true, false],
  'wrong-layout': [false, false, false], 'technical-fake-zero': [false, true, false],
}
assert.equal(controlled.negativeCases.length, 6)
assert.equal(new Set(controlled.negativeCases.map(item => item.case)).size, 6)
for (const item of controlled.negativeCases) assert.deepEqual([item.format_valid, item.coverage_complete, item.evaluation_complete], expectedNegatives[item.case])
assert.equal(controlled.historicalUnexecutedPlan.rows, 0)
assert.equal(controlled.historicalUnexecutedPlan.missing, 25)
const xml = readFileSync(args['--test-report'], 'utf8')
assert.match(xml, /<testsuites(?:\s[^>]*)?>/)
assert.match(xml, /<\/testsuites>\s*$/)
const tests = { tests: [...xml.matchAll(/<testcase\b/g)].length, failures: [...xml.matchAll(/<failure\b/g)].length, errors: [...xml.matchAll(/<error\b/g)].length, skipped: [...xml.matchAll(/<skipped\b/g)].length }
const summary = Object.fromEntries([...xml.matchAll(/<!--\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s+-->/g)].map(match => [match[1], Number(match[2])]))
assert.equal(tests.tests, Number(args['--expected-tests']))
assert.equal(summary.tests, tests.tests)
assert.equal(summary.pass, tests.tests)
for (const key of ['failures', 'errors', 'skipped']) assert.equal(tests[key], 0)
for (const key of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(summary[key], 0)
const report = {
  schemaVersion: 'gaia2-phase2-historical-recheck-v1', status: 'passed', phase2RecheckPassed: true,
  scope: 'historical_phase2_evidence_and_current_export_regression_only',
  historicalAcceptance: ref(historicalPath), recheckCode: ref(fileURLToPath(import.meta.url)), controlledEvidence: ref(args['--controlled']), testReport: ref(args['--test-report']), tests,
  plans, packages, negativeCasesPassed: 6, historicalMissingExecutions: 25,
  currentEnvironmentRevalidated: false, realHooksReady: false, officialSubmissionReady: false,
  noModelExecution: true, noBenchmarkExecution: true, noUpload: true, generatedAt: new Date().toISOString(),
}
writeJson(args['--report'], report, { immutable: true })
console.log(JSON.stringify({ status: report.status, phase2RecheckPassed: true, tests, negativeCasesPassed: 6, currentEnvironmentRevalidated: false, officialSubmissionReady: false, reportPath: args['--report'] }, null, 2))
