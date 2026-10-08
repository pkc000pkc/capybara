import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { digest, within, writeJson } from '../src/phase0_run.mjs'
import { aggregatePhase4Metrics } from '../src/phase4_metrics.mjs'
import { aggregateCorrectionUsage, assertSafeMetricsOutput } from '../src/phase4_usage.mjs'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
function plan(runRoot = 'runs/usage-pending') {
  const tasks = ['execution', 'search', 'adaptability', 'time', 'ambiguity'].flatMap(config => Array.from({ length: 5 }, (_, index) => ({ executionId: `${config}-${index + 1}`, scenarioId: `source-${config}`, phase: 'standard', config, runNumber: index + 1, attemptIndex: index + 1, correctionOrdinal: 0 })))
  const base = { schemaVersion: 'gaia2-run-manifest-v1', runId: 'usage-pending', runRoot, stateFile: `${runRoot}/run-state.json`, mode: 'internal_pass5', dataset: { kind: 'source' }, tasks, policy: { initialRunsPerScenario: 5, maxCorrections: 0 } }
  return { ...base, manifestHash: digest(base) }
}
function directory(t) {
  const runs = join(projectRoot, 'runs'); mkdirSync(runs, { recursive: true })
  const path = mkdtempSync(join(runs, 'phase4-metrics-cli-test-'))
  t.after(() => { assert(within(runs, path) && path !== runs); rmSync(path, { recursive: true, force: true }) })
  return path
}
function fixture(t) {
  const path = directory(t), runRoot = relative(projectRoot, path).replaceAll('\\', '/'), manifest = plan(runRoot)
  const manifestPath = join(path, 'run-manifest.json')
  writeJson(manifestPath, manifest, { immutable: true })
  writeJson(join(path, 'run-state.json'), { schemaVersion: 'gaia2-run-state-v1', runId: manifest.runId, manifestHash: manifest.manifestHash, tasks: manifest.tasks.map(task => ({ executionId: task.executionId, status: 'pending', sessions: [], resultPath: null })) }, { immutable: true })
  return { path, manifestPath, manifest }
}
function cli(f, args) { return spawnSync(process.execPath, [join(projectRoot, 'scripts/phase4_metrics.mjs'), '--manifest', relative(projectRoot, f.manifestPath), ...args], { cwd: projectRoot, encoding: 'utf8' }) }

test('missing correction ledger is unknown cost, never a fabricated complete zero', () => {
  const manifest = plan(), input = { root: projectRoot, manifest, readEvidence: () => { throw Error('pending plan must not read evidence') } }
  const report = aggregateCorrectionUsage(input)
  assert.equal(report.correctionUsageComplete, false); assert.equal(report.usage, null)
  assert.equal(report.knownUsage.executionCount, 0); assert.equal(report.verifiedExecutions.length, 0)
  assert.equal(report.unknownExecutions[0].reason, 'missing_correction_ledger')
  assert.equal(report.initialExecutionsIncluded, false); assert.equal(report.realCorrectionEndToEndReady, false)
  const metrics = aggregatePhase4Metrics(input)
  assert.equal(metrics.initialAttemptSuccessRate, null); assert.equal(metrics.initialAttemptSuccessRateDenominator, 0)
  assert.equal(metrics.initialInfrastructureErrorRate, null); assert.equal(metrics.initialInfrastructureErrorRateDenominator, 0)
})

test('a ledger cannot meter unverified initial parents or supplied grade flags', () => {
  const manifest = plan(), input = { root: projectRoot, manifest, readEvidence: () => { throw Error('must not read a fake report') } }
  const entry = { parentExecutionId: manifest.tasks[0].executionId, parentSessionId: 'invented', parentResultHash: 'a'.repeat(64), correctionOrdinal: 1, status: 'strategy_ready', strategyHash: 'b'.repeat(64), trainingReceipt: { path: 'runs/receipt.json', sha256: 'c'.repeat(64) }, trainingReportRef: { path: '../escape', sha256: 'd'.repeat(64) } }
  assert.throws(() => aggregateCorrectionUsage({ ...input, correctionLedger: { schemaVersion: 'gaia2-phase4-correction-ledger-v1', entries: [entry] } }), /verified_initial_business_failure/)
  assert.throws(() => aggregateCorrectionUsage({ ...input, correctionLedger: { schemaVersion: 'gaia2-phase4-correction-ledger-v1', entries: [{ ...entry, verdict: true }] } }), /unverified_correction_grade/)
})

test('metrics CLI preserves pending25 and immutable output while exposing correction cost unknown', t => {
  const f = fixture(t), output = join(f.path, 'new', 'metrics.json'), run = cli(f, ['--output', output])
  assert.equal(run.status, 0, run.stderr)
  const report = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(report.metrics.initialAttemptCount, 25); assert.equal(report.metrics.evaluatedInitialAttempts, 0)
  assert.equal(report.metrics.completePass5, false); assert.equal(report.metrics.initialPassAt5, null)
  assert.equal(report.initialUsage.executionCount, 0); assert.equal(report.initialUsageComplete, false)
  assert.equal(report.correctionUsageIncluded, false); assert.equal(report.correctionUsageComplete, false)
  assert.equal(report.correctionUsage.usage, null); assert.equal(report.officialSubmissionReady, false)
  const original = readFileSync(output), duplicate = cli(f, ['--output', output])
  assert.notEqual(duplicate.status, 0); assert.match(duplicate.stderr, /immutable_output_already_exists/)
  assert.deepEqual(readFileSync(output), original)
})

test('metrics output rejects project root/outside and both live and dangling junction ancestors', t => {
  const f = fixture(t), outside = mkdtempSync(join(tmpdir(), 'capybara-metrics-outside-'))
  t.after(() => { const temp = resolve(tmpdir()); assert(within(temp, outside) && outside !== temp); rmSync(outside, { recursive: true, force: true }) })
  for (const path of [projectRoot, join(outside, 'no-report.json')]) assert.throws(() => assertSafeMetricsOutput({ root: projectRoot, path }), /output_outside_project/)
  const link = join(f.path, 'linked')
  symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  const rejected = cli(f, ['--output', join(link, 'no-report.json')])
  assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /symbolic_output_ancestor/)
  assert.equal(existsSync(join(outside, 'no-report.json')), false)
  unlinkSync(link)
  const dangling = join(f.path, 'dangling')
  symlinkSync(join(outside, 'missing'), dangling, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => assertSafeMetricsOutput({ root: projectRoot, path: join(dangling, 'no-report.json') }), /symbolic_output_ancestor/)
  unlinkSync(dangling)
})
