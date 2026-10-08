import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { digest, fileDigest, readJson, within, writeJson } from '../src/phase0_run.mjs'
import { runChildProcess, readProcessIdentity, isProcessIdentityAlive } from '../src/phase1_process.mjs'

// Model-free contract regression, NOT a benchmark run or a production A2A permit.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--output-dir'), 'invalid verification arguments')
const output = resolve(root, args[1] ?? `reports/phase5-1a-contract-${Date.now()}`)
assert.ok(within(join(root, 'reports'), output) && output !== join(root, 'reports'), 'output must be a new reports child')
assert.ok(!existsSync(output), 'verification output already exists')
const protocol = readJson(join(root, 'config/phase0-protocol.json'))
const backend = resolve(protocol.runtime.backendRoot)
const python = protocol.runtime.python

function regular(target, directory = false) {
  const absolute = resolve(target)
  for (let cursor = absolute; ; cursor = dirname(cursor)) {
    assert.ok(!lstatSync(cursor).isSymbolicLink(), 'source/evidence link forbidden')
    if (cursor === dirname(cursor)) break
  }
  assert.equal(realpathSync(absolute).toLowerCase(), absolute.toLowerCase())
  assert.ok(directory ? statSync(absolute).isDirectory() : statSync(absolute).isFile())
  return absolute
}
function files(directory, accept = () => true) {
  regular(directory, true)
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = join(directory, entry.name)
    assert.ok(!entry.isSymbolicLink(), 'source link forbidden')
    if (entry.isDirectory()) return entry.name === '__pycache__' ? [] : files(target, accept)
    assert.ok(entry.isFile(), 'non-regular source forbidden')
    return accept(target) ? [target] : []
  }).sort()
}
const sourceFilePaths = () => [...new Set([
  ...['src', 'test', 'demo'].flatMap(part => files(join(backend, part))),
  ...['src', 'scripts', 'test', 'plugins', 'config'].flatMap(part => files(join(root, part))),
  ...files(join(root, protocol.runtime.officialPythonPath, 'are')),
  ...['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json'].map(part => join(backend, part)).filter(existsSync),
  ...['package.json', 'package-lock.json'].map(part => join(root, part)),
])].sort()
const ref = path => ({ path: regular(path), sha256: fileDigest(path), bytes: statSync(path).size })
const inventory = sourceFilePaths().map(ref)
const sourceHash = digest(inventory)
const gitHead = directory => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, windowsHide: true, encoding: 'utf8' }).trim()
mkdirSync(output)
writeJson(join(output, 'source-inventory.json'), { schemaVersion: 'gaia2-phase5-1a-controlled-source-v1', sourceHash,
  backendCommit: gitHead(backend), projectCommit: gitHead(root), files: inventory,
  historicalStage4Acceptance: ref(join(root, 'reports/phase4-v3-mechanism-acceptance-20261009-v1.json')),
  scope: 'controlled_contract_only_not_phase4_lock_replacement' }, { immutable: true })

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|ACCESS_TOKEN|AUTHORIZATION|HF_TOKEN|HUGGINGFACE_TOKEN|PASSWORD|SECRET|GAIA2_HOOK_|BASE_URL|ENDPOINT)/i.test(key)))
Object.assign(env, { PYTHONPATH: join(root, protocol.runtime.officialPythonPath), PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1',
  HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
  LITELLM_LOCAL_MODEL_COST_MAP: 'True', LITELLM_TELEMETRY: 'False' })
const checks = [
  { name: 'backend-typecheck', cwd: backend, command: process.execPath, args: [join(backend, 'node_modules/typescript/bin/tsc'), '--noEmit'] },
  { name: 'backend-build', cwd: backend, command: process.execPath, args: [join(backend, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'] },
  { name: 'backend-full-tests', cwd: backend, command: process.execPath, args: [join(backend, 'node_modules/tsx/dist/cli.mjs'), '--conditions=development', '--test',
    ...files(join(backend, 'test'), file => file.endsWith('.test.ts')).map(file => relative(backend, file))], testKind: 'tap' },
  { name: 'project-full-node-tests', cwd: root, command: process.execPath, args: ['--test'], testKind: 'tap' },
  { name: 'project-python-tests', cwd: root, command: python, args: ['-B', '-m', 'unittest', 'discover', '-s', 'test', '-p', '*_test.py', '-v'], testKind: 'unittest' },
]
const results = []
for (const check of checks) {
  console.log(JSON.stringify({ check: check.name, status: 'started', modelCalls: 0 }))
  const checkDirectory = join(output, check.name)
  mkdirSync(checkDirectory)
  const jobPath = join(checkDirectory, 'job.json'), admissionPath = join(checkDirectory, 'admission.json'), childResultPath = join(checkDirectory, 'child-result.json')
  writeJson(jobPath, { schemaVersion: 'gaia2-phase5-verification-job-v1', command: check.command, args: check.args, cwd: check.cwd }, { immutable: true })
  const jobSha256 = fileDigest(jobPath)
  let admissionIdentity = null
  const result = await runChildProcess({ command: process.execPath,
    args: [join(root, 'scripts/phase5_verification_worker.mjs'), '--job', jobPath, '--admission', admissionPath, '--result', childResultPath],
    cwd: root, env, outputDir: checkDirectory, processTimeoutMs: 480000000,
    onSpawn: async info => {
      const identity = await readProcessIdentity(info.pid)
      assert.ok(identity?.verified && identity.pid === info.pid && identity.parentPid === process.pid, 'verification worker identity unavailable')
      assert.ok(await isProcessIdentityAlive(identity), 'verification worker identity changed before admission')
      admissionIdentity = identity
      writeJson(admissionPath, { schemaVersion: 'gaia2-phase5-verification-admission-v1', pid: identity.pid,
        birthTime: identity.birthTime, jobSha256 }, { immutable: true })
    } })
  const childResult = existsSync(childResultPath) ? readJson(childResultPath) : null
  const stdout = readFileSync(result.stdoutPath, 'utf8'), stderr = readFileSync(result.stderrPath, 'utf8')
  const count = check.testKind === 'tap' ? Number([...stdout.matchAll(/^# tests (\d+)$/gm)].at(-1)?.[1] ?? 0)
    : check.testKind === 'unittest' ? Number([...stderr.matchAll(/Ran (\d+) tests? in /g)].at(-1)?.[1] ?? 0) : null
  const failed = check.testKind === 'tap' ? Number([...stdout.matchAll(/^# fail (\d+)$/gm)].at(-1)?.[1] ?? -1) : null
  const skipped = check.testKind === 'tap' ? Number([...stdout.matchAll(/^# skipped (\d+)$/gm)].at(-1)?.[1] ?? -1) : null
  const passed = result.exitCode === 0 && result.childExited && result.childClosed && admissionIdentity?.verified === true
    && admissionIdentity.pid === result.pid && !await isProcessIdentityAlive(admissionIdentity)
    && (!result.processIdentity?.verified || result.processIdentity.birthTime === admissionIdentity.birthTime)
    && childResult?.schemaVersion === 'gaia2-phase5-verification-child-result-v1' && childResult.jobSha256 === jobSha256
    && childResult.wrapperPid === result.pid && childResult.exitCode === 0 && childResult.childExited && childResult.childClosed && !childResult.spawnError
    && !result.timedOut && !result.interrupted && !result.spawnError && !result.loggingError && !result.heartbeatError
    && !result.manualInspectionRequired && !result.supervisionDetached && result.terminationErrors.length === 0
    && (!check.testKind || count > 0) && (check.testKind !== 'tap' || (failed === 0 && skipped === 0))
    && (check.testKind !== 'unittest' || /\nOK\s*$/.test(stderr))
  results.push({ name: check.name, passed, tests: count, failed, skipped, admissionIdentity, childResult, process: result,
    evidence: ['job.json', 'admission.json', 'child-result.json', 'process-reservation.json', 'process-result.json', 'heartbeat.json', 'stdout.log', 'stderr.log']
      .map(file => join(checkDirectory, file)).filter(existsSync).map(ref) })
  console.log(JSON.stringify({ check: check.name, status: passed ? 'passed' : 'failed', tests: count, exitCode: result.exitCode }))
}
const sourceSetClosed = JSON.stringify(sourceFilePaths()) === JSON.stringify(inventory.map(item => item.path))
const unchanged = sourceSetClosed && inventory.every(item => fileDigest(regular(item.path)) === item.sha256 && statSync(item.path).size === item.bytes)
const evidence = [ref(join(output, 'source-inventory.json')), ...results.flatMap(check => check.evidence)]
for (const item of evidence) assert.equal(fileDigest(regular(item.path)), item.sha256)
const accepted = unchanged && results.every(check => check.passed)
const report = { schemaVersion: 'gaia2-phase5-1a-controlled-verification-v1', status: accepted ? 'passed' : 'failed',
  sourceHash, sourceFiles: inventory.length, sourceSetClosed, sourceUnchanged: unchanged, checks: results, evidence,
  phase51aControlledContractAccepted: accepted, stage5Complete: false, productionA2aEnabled: false, tsPythonIpcConnected: false,
  officialScenarioExecuted: false, modelCalls: 0, officialSubmissionUploaded: false,
  limits: ['TS native driver constructor is trusted; Python local gates are controlled doubles, not owned TS receipts.',
    'OS birth identity is independently verified at the test wrapper admission, not for each short inner compiler/test process.',
    'No real cross-process Host/native binding or official AppAgent benchmark integration is claimed.',
    'Existing production expert_agent guard remains blocked; stage 5.1b admission is still required.'],
  finishedAt: new Date().toISOString() }
for (const item of evidence) assert.equal(fileDigest(regular(item.path)), item.sha256)
writeJson(join(output, 'verification-report.json'), report, { immutable: true })
console.log(JSON.stringify({ report: join(output, 'verification-report.json'), status: report.status, sourceFiles: inventory.length, checks: results.length }))
if (!accepted) process.exitCode = 1
