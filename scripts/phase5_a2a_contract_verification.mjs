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
const cli = Object.create(null)
assert.equal(args.length % 2, 0, 'invalid verification arguments')
for (let index = 0; index < args.length; index += 2) {
  assert.ok(['--output-dir', '--scope'].includes(args[index]) && !Object.hasOwn(cli, args[index]) && args[index + 1], 'invalid verification arguments')
  cli[args[index]] = args[index + 1]
}
const pipeScope = cli['--scope'] === 'private-pipe'
const appAgentScope = cli['--scope'] === 'official-app-agent'
const nativeScope = cli['--scope'] === 'native-binding' || appAgentScope
assert.ok(cli['--scope'] === undefined || pipeScope || nativeScope, 'invalid verification scope')
const label = appAgentScope ? 'phase5-2a-official-app-agent' : nativeScope ? 'phase5-1b-native-binding' : pipeScope ? 'phase5-1b-pipe' : 'phase5-1a-contract'
const output = resolve(root, cli['--output-dir'] ?? `reports/${label}-${Date.now()}`)
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
  ...(nativeScope ? ['typing.py', 'enum.py'].map(part => join(dirname(python), 'Lib', part)).filter(existsSync) : []),
])].sort()
const ref = path => ({ path: regular(path), sha256: fileDigest(path), bytes: statSync(path).size })
const inventory = sourceFilePaths().map(ref)
if (nativeScope) {
  for (const path of [join(backend, 'src/core/plugins/runtime-delegation-native-pipe.ts'),
    join(backend, 'test/runtime-delegation-native-pipe.test.ts'),
    join(root, 'scripts/gaia2_private_native_binding.py'), join(root, 'test/phase5_private_native_binding_test.py'),
    join(root, 'test/fixtures/phase5_native_pipe_worker.py')]) assert.ok(inventory.some(ref => ref.path === path), 'native verification source missing')
}
if (appAgentScope) {
  for (const path of [join(backend, 'src/core/plugins/runtime-delegation-app-agent.ts'),
    join(backend, 'test/runtime-delegation-app-agent.test.ts'), join(root, 'scripts/gaia2_scoped_app_agent.py'),
    join(root, 'test/phase5_scoped_app_agent_test.py'), join(root, 'test/fixtures/phase5_app_agent_pipe_worker.py')]) {
    assert.ok(inventory.some(ref => ref.path === path), 'official AppAgent verification source missing')
  }
}
const sourceHash = digest(inventory)
const gitHead = directory => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, windowsHide: true, encoding: 'utf8' }).trim()
mkdirSync(output)
writeJson(join(output, 'source-inventory.json'), { schemaVersion: appAgentScope ? 'gaia2-phase5-2a-app-agent-controlled-source-v1' : nativeScope ? 'gaia2-phase5-1b-native-controlled-source-v1' : pipeScope ? 'gaia2-phase5-1b-pipe-controlled-source-v1' : 'gaia2-phase5-1a-controlled-source-v1', sourceHash,
  backendCommit: gitHead(backend), projectCommit: gitHead(root), files: inventory,
  historicalStage4Acceptance: ref(join(root, 'reports/phase4-v3-mechanism-acceptance-20261009-v1.json')),
  scope: appAgentScope ? 'controlled_official_appagent_loop_single_apps_no_scenario_or_model' : nativeScope ? 'controlled_single_app_native_binding_not_official_appagent_or_scenario' : pipeScope ? 'controlled_private_pipe_only_not_official_app_binding' : 'controlled_contract_only_not_phase4_lock_replacement' }, { immutable: true })

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|ACCESS_TOKEN|AUTHORIZATION|HF_TOKEN|HUGGINGFACE_TOKEN|PASSWORD|SECRET|GAIA2_HOOK_|BASE_URL|ENDPOINT)/i.test(key)))
Object.assign(env, { PYTHONPATH: join(root, protocol.runtime.officialPythonPath), PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1',
  HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
  LITELLM_LOCAL_MODEL_COST_MAP: 'True', LITELLM_TELEMETRY: 'False' })
if (nativeScope) {
  const integrationRoot = join(output, 'native-integration-evidence')
  mkdirSync(integrationRoot)
  env.GAIA2_NATIVE_INTEGRATION_EVIDENCE_ROOT = integrationRoot
}
if (appAgentScope) {
  const integrationRoot = join(output, 'app-agent-integration-evidence')
  mkdirSync(integrationRoot)
  env.GAIA2_APP_AGENT_INTEGRATION_EVIDENCE_ROOT = integrationRoot
}
const checks = [
  { name: 'backend-typecheck', cwd: backend, command: process.execPath, args: [join(backend, 'node_modules/typescript/bin/tsc'), '--noEmit'] },
  { name: 'backend-build', cwd: backend, command: process.execPath, args: [join(backend, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'] },
  { name: 'backend-full-tests', cwd: backend, command: process.execPath, args: [join(backend, 'node_modules/tsx/dist/cli.mjs'), '--conditions=development', '--test',
    // Native integration starts genuine Python workers; serialize test files to
    // avoid competing with the existing 100ms controlled Hook fixture budget.
    ...(nativeScope ? ['--test-concurrency=1'] : []),
    ...files(join(backend, 'test'), file => file.endsWith('.test.ts')).map(file => relative(backend, file))], testKind: 'tap' },
  { name: 'project-full-node-tests', cwd: root, command: process.execPath, args: ['--test', ...(nativeScope ? ['--test-concurrency=1'] : [])], testKind: 'tap' },
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
const integrationEvidence = nativeScope ? files(join(output, 'native-integration-evidence')).map(ref) : []
if (nativeScope) assert.ok(integrationEvidence.some(item => item.path.endsWith('summary.json')), 'retained native integration evidence missing')
const appAgentIntegrationEvidence = appAgentScope ? files(join(output, 'app-agent-integration-evidence')).map(ref) : []
if (appAgentScope) assert.ok(appAgentIntegrationEvidence.some(item => item.path.endsWith('summary.json')), 'retained AppAgent integration evidence missing')
const evidence = [ref(join(output, 'source-inventory.json')), ...results.flatMap(check => check.evidence), ...integrationEvidence, ...appAgentIntegrationEvidence]
for (const item of evidence) assert.equal(fileDigest(regular(item.path)), item.sha256)
const accepted = unchanged && results.every(check => check.passed)
const report = { schemaVersion: appAgentScope ? 'gaia2-phase5-2a-app-agent-controlled-verification-v1' : nativeScope ? 'gaia2-phase5-1b-native-controlled-verification-v1' : pipeScope ? 'gaia2-phase5-1b-pipe-controlled-verification-v1' : 'gaia2-phase5-1a-controlled-verification-v1', status: accepted ? 'passed' : 'failed',
  sourceHash, sourceFiles: inventory.length, sourceSetClosed, sourceUnchanged: unchanged, checks: results, evidence,
  ...(nativeScope ? { privatePipeControlledAccepted: accepted, nativeAppBindingControlledAccepted: accepted,
    realHostNativePipeIntegrationPassed: accepted, tsPythonControlledAreAppBound: accepted,
    nativeIntegrationEvidenceFiles: integrationEvidence.length,
    controlledApps: ['Contacts', 'RentAFlat'], phase51b1Complete: false, nativeAppBindingComplete: false,
    officialAppAgentIntegrated: false, tsPythonPrivatePipeRoundTripPassed: accepted, tsPythonOfficialAppBound: false }
    : pipeScope ? { privatePipeControlledAccepted: accepted, phase51b1Complete: false, nativeAppBindingComplete: false,
    officialAppAgentIntegrated: false, tsPythonPrivatePipeRoundTripPassed: accepted, tsPythonOfficialAppBound: false }
    : { phase51aControlledContractAccepted: accepted, tsPythonIpcConnected: false }),
  ...(appAgentScope ? { officialAppAgentControlledLoopIntegrated: accepted, officialAppAgentProductionIntegrated: false,
    appAgentIntegrationEvidenceFiles: appAgentIntegrationEvidence.length, beforeModelHooksIntegrated: false,
    childModelRoleBudgetIntegrated: false, parentChildNotificationRoutingIntegrated: false } : {}),
  stage5Complete: false, productionA2aEnabled: false,
  officialScenarioExecuted: false, modelCalls: 0, officialSubmissionUploaded: false,
  limits: [...(appAgentScope ? ['Actual AppAgentBuilder/AppAgent/BaseAgent parser, logs and loop use a finite local engine through trusted TS Host native dispatch; no real model or official Scenario is run.',
    'Original Python adapter observations are released after actual Host dispatch acknowledgements; wire values never replace those original objects.',
    'Final termination depends on actual native return, allowed after Hook and registry.completeChild, not ToolCallLog or AppAgent string output.',
    'Known single-App native collection only; cross-App internal observer, before-model Hook integration, real child model roles/budgets, cross-clock deadlines and trusted notification routing remain future gates.']
    : nativeScope ? ['Real Contacts/RentAFlat objects in a SETUP Environment are exercised through actual TS Host and private Python pipe; no Scenario or AppAgent is run.',
    'Collector authority is the trusted source-frozen Python factory, actual App/adapter/callable identities and private dispatch context, not caller CE JSON or source hashes alone.',
    'Only known single-App internal events are covered. Cross-App internal calls require a future trusted environment-wide observer and edge policy.',
    'Raw native result and formatter observation are independently frozen; wire projections are evidence, not substitutes for original Python observations.',
    'ARE clock is bound and checked independently; cross-clock deadlines, child roles and parent/child notification routing remain unimplemented.']
    : pipeScope ? ['Real TS/Python inherited pipes are tested; no official App/native collector binding or AppAgent integration is claimed.',
    'Host timeout/EOF revocation is tested with a controlled pending native callback, not an official business operation.',
    'wireHash is separate from historical Host/Python hashes; actual raw/effective argument and App manifest mapping is not yet implemented.'] : ['TS native driver constructor is trusted; Python local gates are controlled doubles, not owned TS receipts.']),
    'OS birth identity is independently verified at the test wrapper admission, not for each short inner compiler/test process.',
    ...(nativeScope ? ['No official AppAgent production benchmark integration or universal official tool compatibility is claimed.']
      : ['No real cross-process Host/native binding or official AppAgent benchmark integration is claimed.']),
    'Existing production expert_agent guard remains blocked; stage 5.1b admission is still required.'],
  finishedAt: new Date().toISOString() }
for (const item of evidence) assert.equal(fileDigest(regular(item.path)), item.sha256)
writeJson(join(output, 'verification-report.json'), report, { immutable: true })
console.log(JSON.stringify({ report: join(output, 'verification-report.json'), status: report.status, sourceFiles: inventory.length, checks: results.length }))
if (!accepted) process.exitCode = 1
