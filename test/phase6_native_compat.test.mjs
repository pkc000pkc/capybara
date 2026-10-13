import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freezePluginSnapshot, inspectPluginResources } from '../src/phase0_inventory.mjs'
import { fileDigest } from '../src/phase0_run.mjs'
import { runChildProcess } from '../src/phase1_process.mjs'
import { startRuntimeHookService } from '../src/phase3_hook_service.mjs'
import { pythonEventHash } from '../src/phase3_runtime_evidence.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const protocol = JSON.parse(readFileSync(join(root, 'config/phase0-protocol.json'), 'utf8'))
const python = join(root, protocol.runtime.python)
const portable = path => path.replaceAll('\\', '/')
const offlineEnv = {
  PYTHONPATH: join(root, '.official-python'), PYTHONUTF8: '1',
  HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
  LITELLM_LOCAL_MODEL_COST_MAP: 'True', LITELLM_TELEMETRY: 'False',
}

test('strict Actor-visible native JSON projection preserves keys and fails closed offline', { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(root, 'runs', 'phase6-result-unit-'))
  const result = await runChildProcess({ command: python, args: ['-B', join(root, 'test/phase6_tool_result_test.py')],
    cwd: root, outputDir: directory, processTimeoutMs: 60000, heartbeatIntervalMs: 1000,
    env: { ...process.env, ...offlineEnv } })
  assert.equal(result.exitCode, 0)
  const stderr = readFileSync(join(directory, 'stderr.log'), 'utf8')
  assert.match(stderr, /Ran 7 tests/); assert.match(stderr, /OK/)
})

test('nullable native schemas and actual Shopping checkout Trace roundtrips remain offline', { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(root, 'runs', 'phase6-schema-unit-'))
  const result = await runChildProcess({ command: python, args: ['-B', join(root, 'test/phase6_native_schema_test.py')],
    cwd: root, outputDir: directory, processTimeoutMs: 60000, heartbeatIntervalMs: 1000,
    env: { ...process.env, ...offlineEnv } })
  assert.equal(result.exitCode, 0)
  const stderr = readFileSync(join(directory, 'stderr.log'), 'utf8')
  assert.match(stderr, /Ran 12 tests/); assert.match(stderr, /OK/)
  const audit = JSON.parse(readFileSync(join(directory, 'stdout.log'), 'utf8').trim())
  assert.equal(audit.testsRun, 12); assert.equal(audit.failures, 0); assert.equal(audit.errors, 0)
  assert.equal(audit.modelCalls, 0); assert.equal(audit.externalNetworkAttempts, 0)
})

test('the shared official getter exception rejects clock, source, metadata and container drift', { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(root, 'runs', 'phase6-source-pin-unit-'))
  const result = await runChildProcess({ command: python, args: ['-B', join(root, 'test/phase6_source_pinned_reads_test.py')],
    cwd: root, outputDir: directory, processTimeoutMs: 60000, heartbeatIntervalMs: 1000,
    env: { ...process.env, ...offlineEnv } })
  assert.equal(result.exitCode, 0)
  const stderr = readFileSync(join(directory, 'stderr.log'), 'utf8')
  assert.match(stderr, /Ran 25 tests/); assert.match(stderr, /OK/)
})

test('real ARE Cab AppTool 10/11/20-key results cross the actual RuntimeHost and synchronous Hooks', { timeout: 180000 }, async () => {
  const directory = mkdtempSync(join(root, 'runs', 'phase6-cab-projection-'))
  const plugins = ['gaia2-runtime', 'gaia2-evaluation'].map(id => inspectPluginResources(
    freezePluginSnapshot({ root, id, sourceRoot: join(root, 'plugins', id) })))
  const capabilityPath = join(directory, 'capabilities.json')
  writeFileSync(capabilityPath, JSON.stringify({ schemaVersion: 'gaia2-native-compat-fixture-v1', syntheticFixtureOnly: true, plugins }), { flag: 'wx' })
  const manifest = { runRoot: portable(relative(root, directory)), syntheticFixtureOnly: true,
    lockRefs: { capabilities: { path: portable(relative(root, capabilityPath)), sha256: fileDigest(capabilityPath) } } }
  const settings = { processTimeoutMs: 120000, heartbeatIntervalMs: 1000 }
  for (const count of [10, 11, 20]) {
    const output = join(directory, String(count), 'output'), workspace = join(directory, String(count), 'workspace')
    mkdirSync(output, { recursive: true }); mkdirSync(workspace)
    const task = { executionId: `${basename(directory)}-${count}`, scenarioId: `controlled-cab-${count}`, runNumber: 1, attemptIndex: 0 }
    const session = { sessionId: `controlled-cab-${count}`, outputDir: portable(relative(root, output)), workspaceDir: portable(relative(root, workspace)) }
    const service = await startRuntimeHookService({ root, manifest, task, session, settings })
    let actorResult, hostResult
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|ACCESS_TOKEN|AUTHORIZATION|HF_TOKEN|HUGGINGFACE_TOKEN|GAIA2_HOOK_|GAIA2_CORRECTION_)/i.test(key)))
      actorResult = await runChildProcess({ command: python,
        args: ['-B', join(root, 'test/phase6_tool_result_test.py'), '--cab-fixture', String(count)],
        cwd: root, outputDir: join(output, 'fake-actor'), ...settings, secrets: [service.token],
        env: { ...env, ...offlineEnv, GAIA2_E2E_CORRECTION_ORDINAL: '0', GAIA2_E2E_MAX_ACTIONS: '20',
          GAIA2_HOOK_URL: service.endpoint, GAIA2_HOOK_TOKEN: service.token,
          GAIA2_EXECUTION_ID: task.executionId, GAIA2_SESSION_ID: session.sessionId,
          GAIA2_RUNTIME_EVENT_FILE: join(output, 'runtime-events.jsonl') },
      })
    } finally { hostResult = await service.close() }
    for (const result of [actorResult, hostResult]) {
      assert.equal(result.exitCode, 0, `${count}: ${JSON.stringify(result)}`)
      assert.equal(result.childExited, true); assert.equal(result.childClosed, true)
      assert.equal(result.timedOut, false); assert.equal(result.interrupted, false)
      assert.equal(result.manualInspectionRequired, false)
    }
    assert.equal(service.ready.processId, hostResult.pid)
    const auditLine = readFileSync(join(output, 'fake-actor/stdout.log'), 'utf8').split(/\r?\n/)
      .find(line => line.startsWith('CAB_RESULT_AUDIT:'))
    assert.ok(auditLine)
    const audit = JSON.parse(auditLine.slice('CAB_RESULT_AUDIT:'.length))
    assert.equal(audit.case, count); assert.equal(audit.status, 'passed')
    assert.equal(audit.realModelCalls, 0); assert.equal(audit.externalNetworkAttempts, 0)
    assert.equal(audit.syntheticFixtureOnly, true); assert.equal(audit.benchmarkExecuted, false)
    assert.equal(audit.officialSubmissionReady, false); assert.equal(audit.validationCalls, 1)
    assert.equal(Object.keys(audit.projectedResult.rides).length, count)
    // Only this actual Cab fixture uses the Python/Node common numeric subset.
    // This is not a claim that pythonEventHash handles every JSON number.
    assert.equal(audit.resultHash, pythonEventHash(audit.projectedResult))
    const receipts = readdirSync(join(workspace, 'plugin-runtime')).sort()
      .map(name => JSON.parse(readFileSync(join(workspace, 'plugin-runtime', name), 'utf8')))
      .filter(value => value.schemaVersion === 'capybara-runtime-plugin-invocation-v1')
    const before = receipts.find(value => value.input.checkpoint === 'before_tool' && value.input.action.id === 'cab-history')
    const after = receipts.find(value => value.input.checkpoint === 'after_tool' && value.input.action.id === 'cab-history')
    assert.equal(before.decision.action, 'allow'); assert.equal(before.input.action.effect, 'read')
    assert.equal(after.decision.action, 'allow'); assert.equal(after.input.outcome.executed, true)
    assert.equal(after.input.outcome.status, 'succeeded'); assert.equal(after.input.outcome.resultHash, audit.resultHash)
    assert.deepEqual(after.input.outcome.result, audit.projectedResult)
    assert.equal(receipts.at(-1).input.checkpoint, 'attempt_end')
    for (const receipt of receipts) assert.ok(receipt.hookReceipts.every(hook => hook.status === 'passed'))
  }
})

test('source-pinned Shopping getter and omit/null checkout pass the actual HookHost and official Trace importer', { timeout: 180000 }, async () => {
  const directory = mkdtempSync(join(root, 'runs', 'phase6-shopping-compat-'))
  const plugins = ['gaia2-runtime', 'gaia2-evaluation'].map(id => inspectPluginResources(
    freezePluginSnapshot({ root, id, sourceRoot: join(root, 'plugins', id) })))
  const capabilityPath = join(directory, 'capabilities.json')
  writeFileSync(capabilityPath, JSON.stringify({ schemaVersion: 'gaia2-shopping-compat-fixture-v1', syntheticFixtureOnly: true, plugins }), { flag: 'wx' })
  const manifest = { runRoot: portable(relative(root, directory)), syntheticFixtureOnly: true,
    lockRefs: { capabilities: { path: portable(relative(root, capabilityPath)), sha256: fileDigest(capabilityPath) } } }
  const settings = { processTimeoutMs: 120000, heartbeatIntervalMs: 1000 }
  for (const caseName of ['omit', 'null']) {
    const output = join(directory, caseName, 'output'), workspace = join(directory, caseName, 'workspace')
    mkdirSync(output, { recursive: true }); mkdirSync(workspace)
    const task = { executionId: `${basename(directory)}-${caseName}`, scenarioId: `controlled-shopping-${caseName}`, runNumber: 1, attemptIndex: 0 }
    const session = { sessionId: `controlled-shopping-${caseName}`, outputDir: portable(relative(root, output)), workspaceDir: portable(relative(root, workspace)) }
    const service = await startRuntimeHookService({ root, manifest, task, session, settings })
    let actorResult, hostResult
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|ACCESS_TOKEN|AUTHORIZATION|HF_TOKEN|HUGGINGFACE_TOKEN|GAIA2_HOOK_|GAIA2_CORRECTION_)/i.test(key)))
      actorResult = await runChildProcess({ command: python,
        args: ['-B', join(root, 'test/phase6_shopping_hook_fixture.py'), '--case', caseName],
        cwd: root, outputDir: join(output, 'fake-actor'), ...settings, secrets: [service.token],
        env: { ...env, ...offlineEnv, GAIA2_E2E_CORRECTION_ORDINAL: '0', GAIA2_E2E_MAX_ACTIONS: '20',
          GAIA2_HOOK_URL: service.endpoint, GAIA2_HOOK_TOKEN: service.token,
          GAIA2_EXECUTION_ID: task.executionId, GAIA2_SESSION_ID: session.sessionId,
          GAIA2_RUNTIME_EVENT_FILE: join(output, 'runtime-events.jsonl') },
      })
    } finally { hostResult = await service.close() }
    for (const result of [actorResult, hostResult]) {
      assert.equal(result.exitCode, 0, `${caseName}: ${JSON.stringify(result)}`)
      assert.equal(result.childExited, true); assert.equal(result.childClosed, true)
      assert.equal(result.timedOut, false); assert.equal(result.interrupted, false)
    }
    const line = readFileSync(join(output, 'fake-actor/stdout.log'), 'utf8').split(/\r?\n/)
      .find(value => value.startsWith('SHOPPING_HOOK_AUDIT:'))
    assert.ok(line)
    const audit = JSON.parse(line.slice('SHOPPING_HOOK_AUDIT:'.length))
    assert.equal(audit.case, caseName); assert.equal(audit.status, 'passed')
    assert.equal(audit.realModelCalls, 0); assert.equal(audit.externalNetworkAttempts, 0)
    assert.equal(audit.syntheticFixtureOnly, true); assert.equal(audit.benchmarkExecuted, false)
    const receipts = readdirSync(join(workspace, 'plugin-runtime')).sort()
      .map(name => JSON.parse(readFileSync(join(workspace, 'plugin-runtime', name), 'utf8')))
      .filter(value => value.schemaVersion === 'capybara-runtime-plugin-invocation-v1')
    const gates = receipts.filter(value => value.input.checkpoint === 'before_tool')
    const after = receipts.filter(value => value.input.checkpoint === 'after_tool')
    assert.equal(gates.length, 8); assert.equal(after.length, 8)
    for (const receipt of receipts) assert.ok(receipt.hookReceipts.every(hook => hook.status === 'passed'))
    for (const id of ['shopping-getter', 'checkout']) {
      const gate = gates.find(value => value.input.action.id === id)
      const completed = after.find(value => value.input.action.id === id)
      assert.equal(gate.decision.action, 'allow'); assert.equal(completed.decision.action, 'allow')
      assert.equal(completed.input.outcome.executed, true); assert.equal(completed.input.outcome.status, 'succeeded')
      const event = audit.events.find(value => value.type === 'tool_call_completed' && value.callId === id)
      assert.equal(event.resultHash, completed.input.outcome.resultHash)
    }
    const getter = gates.find(value => value.input.action.id === 'shopping-getter')
    assert.equal(getter.input.action.effect, 'read'); assert.equal(getter.input.action.authoritativeRead, true)
    assert.deepEqual(getter.input.action.arguments, {})
    const checkout = gates.find(value => value.input.action.id === 'checkout')
    assert.equal(checkout.input.action.effect, 'write')
    assert.deepEqual(checkout.input.action.arguments, caseName === 'omit' ? {} : { discount_code: null })
    assert.equal(receipts.at(-1).input.checkpoint, 'attempt_end')
  }
})
