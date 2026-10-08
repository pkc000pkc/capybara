import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditPhase0 } from '../src/phase0_audit.mjs'
import { fileDigest, readJson, within } from '../src/phase0_run.mjs'
import { readModelConnection } from '../src/phase1_official.mjs'
import { atomicJson } from '../src/phase1_runner.mjs'

// Read-only evidence collection: this script never executes benchmark/model calls.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]
  assert.ok(['--manifest', '--official-manifest', '--old-manifest', '--model-probe', '--controlled', '--test-report', '--expected-tests'].includes(key) && process.argv[i + 1] && !args[key], 'invalid/duplicate acceptance argument')
  args[key] = key === '--expected-tests' ? process.argv[i + 1] : resolve(root, process.argv[i + 1])
}
for (const key of ['--manifest', '--official-manifest', '--old-manifest', '--model-probe', '--controlled', '--test-report']) assert.ok(args[key], `missing ${key}`)
assert.match(args['--expected-tests'] ?? '', /^[1-9]\d*$/, 'expected test count required')
const ref = path => ({ path: relative(root, path).replaceAll('\\', '/'), sha256: fileDigest(path) })
const manifest = readJson(args['--manifest']), probe = readJson(args['--model-probe']), controlled = readJson(args['--controlled'])
const audit = await auditPhase0(root, { deep: false })
assert.equal(audit.phase0Passed, true, 'current frozen input audit failed')
assert.equal(probe.status, 'passed'); assert.equal(controlled.status, 'passed')
const processResult = readJson(join(dirname(args['--model-probe']), 'process-result.json'))
assert.equal(processResult.exitCode, 0)
assert.ok(!processResult.timedOut && !processResult.interrupted && !processResult.loggingError && !processResult.heartbeatError && !processResult.spawnError && !processResult.terminationErrors.length, 'model probe supervisor unhealthy')
assert.deepEqual(probe.results.map(row => [row.role, row.status]), [['actor', 'passed'], ['judge', 'passed']])
const modelEvents = readFileSync(join(dirname(args['--model-probe']), 'runtime-events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
const requestAttempts = modelEvents.filter(event => event.type === 'model_request_attempt')
const requestSuccesses = modelEvents.filter(event => event.type === 'model_request_succeeded')
assert.equal(requestSuccesses.length, 2)
assert.deepEqual(requestSuccesses.map(event => event.modelRole).sort(), ['actor', 'judge'])
assert.equal(new Set(requestSuccesses.map(event => event.requestId)).size, 2)
for (const event of modelEvents) {
  assert.equal(event.executionId, 'phase1-model-probe'); assert.equal(event.sessionId, dirname(args['--model-probe']))
  assert.ok(['actor', 'judge'].includes(event.modelRole))
}
for (const success of requestSuccesses) assert.ok(requestAttempts.some(attempt => attempt.requestId === success.requestId && attempt.modelRole === success.modelRole && attempt.requestAttempt === success.requestAttempt), 'successful model request has no corresponding attempt')
assert.equal(controlled.resumed.status, 'evaluation_complete'); assert.equal(controlled.resumed.executedThisInvocation, 1)
assert.equal(controlled.resumed.businessFailures, 1); assert.equal(controlled.resumed.totalSessions, 3)
assert.equal(fileDigest(resolve(root, controlled.state.path)), controlled.state.sha256)
assert.equal(readJson(join(dirname(args['--controlled']), 'batch-heartbeat.json')).terminal, true)

const xml = readFileSync(args['--test-report'], 'utf8')
const suites = [...xml.matchAll(/<testsuite\s[^>]*>/g)].map(match => Object.fromEntries([...match[0].matchAll(/(tests|failures|errors|skipped)="(\d+)"/g)].map(item => [item[1], Number(item[2])])) )
assert.ok(suites.length && suites.every(suite => suite.tests !== undefined), 'unrecognized JUnit report')
const tests = suites.reduce((total, suite) => ({ tests: total.tests + suite.tests, failures: total.failures + (suite.failures ?? 0), errors: total.errors + (suite.errors ?? 0), skipped: total.skipped + (suite.skipped ?? 0) }), { tests: 0, failures: 0, errors: 0, skipped: 0 })
assert.ok(tests.tests === Number(args['--expected-tests']) && tests.failures === 0 && tests.errors === 0 && tests.skipped === 0, 'automated test count/result differs from expected final suite')

// Remove inherited runtime overrides, then prove every actual CLI uses the same defaults.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GAIA2_')))
const entrypoints = [['e2e', 'official_e2e_smoke.mjs'], ['batch', 'official_batch_smoke.mjs'], ['all', 'official_all_smoke.mjs'], ['pilot', 'official_integrated_pilot.mjs']]
const validate = (script, path, overrides = {}) => JSON.parse(execFileSync(process.execPath, [join(root, 'scripts', script), '--manifest', path], { cwd: root, env: { ...env, ...overrides }, windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
const cliChecks = entrypoints.map(([entrypoint, script]) => {
  const defaults = validate(script, args['--manifest']), disabled = validate(script, args['--manifest'], { GAIA2_PROCESS_TIMEOUT_MS: '0' })
  assert.equal(defaults.status, 'validated_not_executed'); assert.equal(defaults.noModelExecution, true)
  assert.equal(defaults.effectiveSettings.processTimeoutMs, 480000000)
  assert.equal(disabled.effectiveSettings.processTimeoutMs, 0); assert.equal(disabled.effectiveSettings.scenarioTimeoutSeconds, 480000)
  return { entrypoint, defaultProcessTimeoutMs: defaults.effectiveSettings.processTimeoutMs, zeroDisablesOnlyOuterCeiling: true, noModelExecution: true }
})
const rejects = (path, pattern) => {
  let stderr = ''
  try { validate(entrypoints[0][1], path) } catch (error) { stderr = String(error.stderr ?? '') }
  assert.match(stderr, pattern); return true
}
const oldPlanRejected = rejects(args['--old-manifest'], /lock references have changed/)
const unsupportedEnhancementPlanRejectedBeforeSpawn = rejects(args['--official-manifest'], /A2A\/Noise execution is not connected/)

// Test absence of the exact external credential without displaying credential bytes.
const protocol = readJson(join(root, 'config/phase0-protocol.json'))
assert.equal(probe.actorModel, protocol.models.actor.model); assert.equal(probe.judgeModel, protocol.models.judge.model)
const { apiKey } = readModelConnection(root, protocol.models)
assert.ok(apiKey.length >= 8, 'credential is too short for meaningful artifact scan')
let scannedFiles = 0
function scan(dir) {
  assert.ok(within(join(root, 'runs'), dir), 'evidence directory escapes runs')
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    assert.ok(!lstatSync(path).isSymbolicLink(), 'evidence contains symlink')
    if (entry.isDirectory()) scan(path)
    else { assert.equal(readFileSync(path).includes(Buffer.from(apiKey)), false, 'credential found in evidence artifact'); scannedFiles++ }
  }
}
scan(dirname(args['--model-probe'])); scan(dirname(args['--controlled']))
const deep = readJson(join(root, 'reports/phase0-dataset-deep-audit.json'))
assert.equal(deep.status, 'passed')
assert.equal(deep.deep, true); assert.equal(deep.mode, 'phase0-dataset-deep-audit')
assert.equal(deep.verifiedFileCount, 11); assert.equal(deep.scenarioCount, 1760)
for (const key of ['datasetLock', 'scenarioIndex', 'mappingReport']) assert.equal(fileDigest(resolve(root, deep[key].path)), deep[key].sha256, 'reused deep audit inputs have changed')
const report = { schemaVersion: 'gaia2-phase1-acceptance-v1', status: 'passed', phase1Passed: true, noModelExecutionByAcceptance: true, noBenchmarkExecution: true, tests, cliChecks, oldPlanRejected, unsupportedEnhancementPlanRejectedBeforeSpawn, modelProbe: { evidence: ref(args['--model-probe']), requests: requestAttempts.length, succeeded: requestSuccesses.length, results: probe.results, actorModel: probe.actorModel, judgeModel: probe.judgeModel, toolsExecuted: false }, controlled: { evidence: ref(args['--controlled']), executedSessions: controlled.resumed.totalSessions, resumeStartedSessions: controlled.resumed.executedThisInvocation, businessFailureNotRerun: true, newSessionPaths: controlled.uniqueSessionPaths }, credentialScan: { passed: true, scannedFiles, credentialRecorded: false }, frozenInputs: { dataset: ref(join(root, 'locks/dataset-lock.json')), environment: ref(join(root, 'locks/environment-lock.json')), capabilities: ref(join(root, 'locks/capability-inventory.json')) }, dataDeepAudit: { evidence: ref(join(root, 'reports/phase0-dataset-deep-audit.json')), reusedUnchangedStage0Evidence: true }, internalPlan: ref(args['--manifest']), officialPlan: ref(args['--official-manifest']), testReport: ref(args['--test-report']), currentInputAudit: audit, officialSubmissionReady: false, realHooksReady: false, recoveryKind: 'clean_environment_restart_not_ARE_checkpoint', generatedAt: new Date().toISOString() }
const output = join(root, 'reports/phase1-acceptance.json')
atomicJson(output, report)
console.log(JSON.stringify({ status: report.status, tests, modelRequests: requestAttempts.length, controlledSessions: controlled.resumed.totalSessions, cliEntrypointsValidated: cliChecks.length, credentialScanPassed: true, reportPath: output }, null, 2))
