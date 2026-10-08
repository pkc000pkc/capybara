import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { auditPhase0 } from '../src/phase0_audit.mjs'
import { fileDigest, readJson, within, writeJson } from '../src/phase0_run.mjs'
import { auditSubmissionPackage } from '../src/phase2_audit.mjs'
import { validateExportPlan } from '../src/phase2_export.mjs'

// Uses existing controlled evidence and local CLI conversion only. No model, task or upload.
const root = dirname(dirname(fileURLToPath(import.meta.url))), args = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1]
  assert.ok(['--manifest', '--official-manifest', '--controlled', '--test-report', '--expected-tests', '--report'].includes(key) && value && !args[key], 'invalid acceptance arguments')
  args[key] = key === '--expected-tests' ? value : resolve(root, value)
}
for (const key of ['--manifest', '--official-manifest', '--controlled', '--test-report', '--expected-tests', '--report']) assert.ok(args[key], `missing ${key}`)
assert.match(args['--expected-tests'], /^[1-9]\d*$/)
assert.equal(existsSync(args['--report']), false, 'acceptance report must not overwrite prior evidence')
const ref = path => ({ path: relative(root, path).replaceAll('\\', '/'), sha256: fileDigest(path) })
const controlled = readJson(args['--controlled'])
assert.equal(controlled.status, 'passed'); assert.equal(controlled.syntheticFixtureOnly, true)
for (const flag of ['noModelExecution', 'noBenchmarkExecution', 'noUpload']) assert.equal(controlled[flag], true)
assert.equal(controlled.sourceSessions, 3); assert.equal(controlled.exported.rows, 3)
assert.equal(controlled.negativeCases.length, 6); assert.equal(controlled.historicalUnexecutedPlan.missing, 25)
assert.equal(controlled.historicalUnexecutedPlan.rows, 0)
for (const section of [controlled.exported, controlled.relocation]) {
  assert.ok(within(join(root, 'runs'), section.packageRoot), 'controlled package outside runs')
  const audit = auditSubmissionPackage({ packageRoot: section.packageRoot, officialCheck: section.officialCheck })
  for (const gate of ['format_valid', 'coverage_complete', 'evaluation_complete']) assert.equal(audit[gate], true, `${gate} controlled evidence changed`)
  assert.equal(audit.officialSubmissionReady, false); assert.equal(audit.metrics.evaluatedRows, 3)
  assert.equal(audit.metrics.businessFailureCount, 1); assert.equal(audit.metrics.successCount, 2)
  assert.equal(section.officialCheck.processHealthy, true)
  assert.equal(section.officialCheck.reconstructedCount, 3); assert.equal(section.officialCheck.hfSchemaValid, true)
}
assert.equal(controlled.relocation.originalEvidenceUnchanged, true)
const xml = readFileSync(args['--test-report'], 'utf8')
assert.match(xml, /<testsuites(?:\s[^>]*)?>/); assert.match(xml, /<\/testsuites>\s*$/)
const tests = { tests: [...xml.matchAll(/<testcase\b/g)].length, failures: [...xml.matchAll(/<failure\b/g)].length, errors: [...xml.matchAll(/<error\b/g)].length, skipped: [...xml.matchAll(/<skipped\b/g)].length }
const summary = Object.fromEntries([...xml.matchAll(/<!--\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s+-->/g)].map(match => [match[1], Number(match[2])]))
assert.equal(tests.tests, Number(args['--expected-tests'])); assert.equal(summary.tests, tests.tests); assert.equal(summary.pass, tests.tests)
for (const key of ['failures', 'errors', 'skipped']) assert.equal(tests[key], 0)
for (const key of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(summary[key], 0)

const current = await auditPhase0(root, { deep: false })
assert.equal(current.phase0Passed, true, 'current frozen inputs invalid')
const internal = readJson(args['--manifest']), official = readJson(args['--official-manifest'])
validateExportPlan(root, internal); validateExportPlan(root, official)
assert.equal(internal.tasks.length, 25); assert.equal(official.tasks.length, 3360)
assert.equal(official.selection.fullOfficialCoverage, true)
const deep = readJson(join(root, 'reports/phase0-dataset-deep-audit.json'))
assert.equal(deep.status, 'passed'); assert.equal(deep.scenarioCount, 1760); assert.equal(deep.verifiedFileCount, 11)
for (const name of ['datasetLock', 'scenarioIndex', 'mappingReport']) assert.equal(fileDigest(resolve(root, deep[name].path)), deep[name].sha256, 'reused data evidence changed')

const cliRoot = join(dirname(args['--controlled']), `cli-acceptance-${randomUUID()}`)
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GAIA2_') && !/(?:API_KEY|ACCESS_TOKEN|AUTHORIZATION|HF_TOKEN|HUGGINGFACE_TOKEN)/i.test(key)))
const cli = (script, argv, expectedExit) => {
  const result = spawnSync(process.execPath, [join(root, 'scripts', script), ...argv], { cwd: root, env, windowsHide: true, timeout: 60000, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
  assert.equal(result.status, expectedExit, `${script} unexpected exit`)
  return JSON.parse(result.stdout)
}
const auditCliPath = join(cliRoot, 'relocated-audit.json')
const auditCli = cli('validate_official_submission.mjs', ['--input', controlled.relocation.packageRoot, '--report', auditCliPath], 0)
for (const gate of ['format_valid', 'coverage_complete', 'evaluation_complete']) assert.equal(auditCli[gate], true)
assert.equal(auditCli.officialCheckPassed, true); assert.equal(auditCli.officialSubmissionReady, false)
const publicSyntheticOutput = join(cliRoot, 'forbidden-synthetic')
const syntheticResult = spawnSync(process.execPath, [join(root, 'scripts/export_official_submission.mjs'), '--manifest', join(dirname(args['--controlled']), 'run-manifest.json'), '--output', publicSyntheticOutput], { cwd: root, env, windowsHide: true, timeout: 30000, encoding: 'utf8' })
assert.equal(syntheticResult.status, 2); assert.equal(existsSync(publicSyntheticOutput), false)
const missingCli = cli('export_official_submission.mjs', ['--manifest', 'runs/phase1-internal-20261008/run-manifest.json', '--output', join(cliRoot, 'historical/submission')], 2)
assert.equal(missingCli.exportedRows, 0); assert.equal(missingCli.missingExecutions, 25)
assert.equal(missingCli.coverage_complete, false); assert.equal(missingCli.evaluation_complete, false)
const report = { schemaVersion: 'gaia2-phase2-acceptance-v1', status: 'passed', phase2Passed: true, tests, pythonCasesInsideOfficialTest: 12, controlledEvidence: ref(args['--controlled']), testReport: ref(args['--test-report']), syntheticFixtureOnly: true, noModelExecution: true, noBenchmarkExecution: true, noUpload: true, exportedRows: 3, sourceSessions: 3, syntheticSuccesses: 2, syntheticBusinessFailures: 1, packageRelocationPassed: true, negativeCases: controlled.negativeCases, historicalPlanMissingExecutions: 25, publicSyntheticExportRejected: true, cliChecks: { relocatedAudit: ref(auditCliPath), historicalExportExit: 2 }, currentInputAudit: current, frozenInputs: { environment: ref(join(root, 'locks/environment-lock.json')), capabilities: ref(join(root, 'locks/capability-inventory.json')), dataset: ref(join(root, 'locks/dataset-lock.json')) }, internalPlan: ref(args['--manifest']), officialPlan: ref(args['--official-manifest']), reusedUnchangedDataDeepAudit: ref(join(root, 'reports/phase0-dataset-deep-audit.json')), officialSubmissionReady: false, realHooksReady: false, generatedAt: new Date().toISOString() }
writeJson(args['--report'], report, { immutable: true })
console.log(JSON.stringify({ status: 'passed', phase2Passed: true, tests, exportedRows: 3, packageRelocationPassed: true, negativeCasesPassed: 6, cliChecksPassed: 3, noModelExecution: true, noBenchmarkExecution: true, officialSubmissionReady: false, reportPath: args['--report'] }, null, 2))
