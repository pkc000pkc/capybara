import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readNativeResult } from '../src/phase1_official.mjs'
import { classifyExecutionFailure } from '../src/phase1_errors.mjs'
import { freezePluginSnapshot, inspectPluginResources } from '../src/phase0_inventory.mjs'
import { fileDigest } from '../src/phase0_run.mjs'
import { runChildProcess } from '../src/phase1_process.mjs'
import { startRuntimeHookService } from '../src/phase3_hook_service.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const python = process.env.GAIA2_PYTHON || 'C:/Users/pkc00/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'

test('live Python bridge consumes real ARE dynamics and fails closed around synchronous hook receipts offline', () => {
  const result = spawnSync(python, [join(root, 'test', 'phase3_live_bridge_test.py')], {
    cwd: root,
    env: { ...process.env, PYTHONPATH: join(root, '.official-python'), PYTHONUTF8: '1', HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', LITELLM_LOCAL_MODEL_COST_MAP: 'True', LITELLM_TELEMETRY: 'False' },
    encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /Ran 41 tests/)
  assert.match(result.stderr, /OK/)
  const auditLine = result.stdout.split(/\r?\n/).find(line => line.startsWith('MODEL_PROTOCOL_FAILURE_AUDITS:'))
  const failures = JSON.parse(auditLine.slice('MODEL_PROTOCOL_FAILURE_AUDITS:'.length))
  assert.deepEqual(failures.map(item => item.case), ['server_unsupported_parameter', 'local_unsupported_parameter'])
  // Feed the actual controlled failure events to the production reader and
  // classifier. ARE's outer runner may label an exception as success=false;
  // that numerical zero must not become a judged business failure here.
  for (const failure of failures) {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'gaia2-phase4-model-protocol-'))
    const tracePath = join(fixtureRoot, 'trace.json'), resultPath = join(fixtureRoot, 'output.jsonl')
    const task = { scenarioId: 'controlled-protocol', executionId: failure.case, runNumber: 1 }
    const session = { sessionId: `${failure.case}-session` }
    const definition = { scenario_id: task.scenarioId, run_number: task.runNumber, has_exception: true, exception_type: failure.exceptionType }
    try {
      writeFileSync(tracePath, JSON.stringify({ metadata: { definition } }))
      writeFileSync(resultPath, JSON.stringify({ task_id: task.scenarioId, trace_id: tracePath, score: 0, metadata: { ...definition, status: 'failed' } }) + '\n')
      const events = failure.events.map(event => ({ ...event, executionId: task.executionId, sessionId: session.sessionId }))
      const { report } = readNativeResult({ root: fixtureRoot, outputDir: '.', task, session, events })
      assert.equal(report.score, null)
      assert.equal(report.businessPassed, null)
      assert.equal(report.evaluationComplete, false)
      const classified = classifyExecutionFailure({ processResult: { exitCode: 0 }, report, events })
      assert.equal(classified.category, 'configuration_error')
      assert.equal(classified.retryable, false)
    } finally {
      unlinkSync(resultPath); unlinkSync(tracePath); rmdirSync(fixtureRoot)
    }
  }
})

test('official argument preflight rejects without ARE effects through the actual RuntimeHost and FakeActor', { timeout: 180000 }, async () => {
  const portable = path => path.replaceAll('\\', '/')
  const runDirectory = mkdtempSync(join(root, 'runs', 'phase4g-argument-preflight-'))
  const runRoot = portable(relative(root, runDirectory))
  const plugins = ['gaia2-runtime', 'gaia2-evaluation'].map(id => inspectPluginResources(
    freezePluginSnapshot({ root, id, sourceRoot: join(root, 'plugins', id) })))
  const capabilityPath = join(runDirectory, 'capabilities.json')
  writeFileSync(capabilityPath, JSON.stringify({ schemaVersion: 'gaia2-argument-preflight-fixture-v1', syntheticFixtureOnly: true, plugins }), { flag: 'wx' })
  const manifest = { runRoot, lockRefs: { capabilities: { path: portable(relative(root, capabilityPath)), sha256: fileDigest(capabilityPath) } } }
  const settings = { processTimeoutMs: 120000, heartbeatIntervalMs: 1000 }
  for (const caseName of ['finish', 'defaults', 'unsafe_json', 'binding']) {
    const caseDirectory = join(runDirectory, caseName), output = join(caseDirectory, 'output'), workspace = join(caseDirectory, 'workspace')
    mkdirSync(output, { recursive: true }); mkdirSync(workspace)
    const task = { executionId: `${basename(runDirectory)}-${caseName}`, scenarioId: `controlled-preflight-${caseName}`, runNumber: 1, attemptIndex: 0 }
    const session = { sessionId: `controlled-preflight-${caseName}`, outputDir: portable(relative(root, output)), workspaceDir: portable(relative(root, workspace)) }
    const service = await startRuntimeHookService({ root, manifest, task, session, settings })
    let actorResult, hostResult
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|ACCESS_TOKEN|AUTHORIZATION|HF_TOKEN|HUGGINGFACE_TOKEN|GAIA2_HOOK_|GAIA2_CORRECTION_)/i.test(key)))
      actorResult = await runChildProcess({ command: python,
        args: [join(root, 'test', 'phase3_live_bridge_test.py'), '--argument-preflight-fixture', caseName],
        cwd: root, outputDir: join(output, 'fake-actor'), ...settings, secrets: [service.token],
        env: { ...env, PYTHONPATH: join(root, '.official-python'), PYTHONUTF8: '1',
          HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
          LITELLM_LOCAL_MODEL_COST_MAP: 'True', LITELLM_TELEMETRY: 'False',
          GAIA2_E2E_CORRECTION_ORDINAL: '0', GAIA2_E2E_MAX_ACTIONS: '20',
          GAIA2_HOOK_URL: service.endpoint, GAIA2_HOOK_TOKEN: service.token,
          GAIA2_EXECUTION_ID: task.executionId, GAIA2_SESSION_ID: session.sessionId,
          GAIA2_RUNTIME_EVENT_FILE: join(output, 'runtime-events.jsonl') },
      })
    } finally { hostResult = await service.close() }
    for (const result of [actorResult, hostResult]) {
      assert.equal(result.exitCode, 0, `${caseName}: ${JSON.stringify(result)}`)
      assert.equal(result.childExited, true); assert.equal(result.childClosed, true)
      assert.equal(result.timedOut, false); assert.equal(result.interrupted, false)
      assert.equal(result.manualInspectionRequired, false)
    }
    assert.equal(service.ready.processId, hostResult.pid)
    assert.equal(service.ready.initialization.plugins.length, 2)
    const actorLog = readFileSync(join(output, 'fake-actor', 'stdout.log'), 'utf8')
    const auditLine = actorLog.split(/\r?\n/).find(line => line.startsWith('ARGUMENT_PREFLIGHT_AUDIT:'))
    assert.ok(auditLine, `${caseName}: FakeActor audit missing`)
    const audit = JSON.parse(auditLine.slice('ARGUMENT_PREFLIGHT_AUDIT:'.length))
    assert.equal(audit.case, caseName); assert.equal(audit.status, 'passed')
    assert.equal(audit.syntheticFixtureOnly, true); assert.equal(audit.benchmarkExecuted, false)
    assert.equal(audit.officialSubmissionReady, false)
    assert.equal(audit.realModelCalls, 0); assert.equal(audit.externalNetworkAttempts, 0)
    assert.equal(audit.validationCalls, 1); assert.equal(audit.usage.completedTurns, 1)
    assert.equal(audit.nativeCompletedEvents.length, audit.usage.toolsExecuted)
    const runtimeEvents = readFileSync(join(output, 'runtime-events.jsonl'), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
    assert.equal(runtimeEvents.length, audit.events.length)
    for (const [index, event] of runtimeEvents.entries()) {
      assert.equal(event.executionId, task.executionId); assert.equal(event.sessionId, session.sessionId)
      for (const [key, value] of Object.entries(audit.events[index])) assert.deepEqual(event[key], value)
    }
    const evidenceRoot = join(workspace, 'plugin-runtime')
    const invocations = readdirSync(evidenceRoot).sort().map(name => JSON.parse(readFileSync(join(evidenceRoot, name), 'utf8')))
      .filter(value => value.schemaVersion === 'capybara-runtime-plugin-invocation-v1')
    const gates = invocations.filter(value => value.input.checkpoint === 'before_tool')
    const after = invocations.filter(value => value.input.checkpoint === 'after_tool')
    assert.equal(gates.length, audit.usage.toolCalls); assert.equal(after.length, audit.usage.toolsExecuted)
    for (const invocation of invocations) {
      assert.equal(invocation.executionId, task.executionId); assert.equal(invocation.sessionId, session.sessionId)
      assert.ok(!['after_evaluation', 'after_replay'].includes(invocation.input.checkpoint))
      assert.ok(invocation.hookReceipts.every(receipt => receipt.status === 'passed'))
    }
    for (const rejected of audit.rejected) {
      const gate = gates.find(value => value.input.action.id === rejected.id)
      assert.ok(gate, `${caseName}: rejected action still uses live authorization`)
      assert.equal(gate.decision.action, 'allow')
      assert.equal(after.some(value => value.input.action.id === rejected.id), false)
      assert.equal(rejected.observation.executed, false)
      assert.equal(runtimeEvents.some(event => ['tool_call_started', 'tool_call_completed'].includes(event.type) && event.callId === rejected.id), false)
      if (rejected.reason === 'unsafe_json_argument') assert.deepEqual(gate.input.action.arguments, {})
    }
    const final = invocations.at(-1)
    assert.equal(final.input.checkpoint, 'attempt_end')
    assert.equal(final.input.outcome.usage.completedTurns, 1)
    assert.equal(final.input.outcome.usage.unknownMutationOutcomes, 0)
    assert.equal(resolve(root, session.workspaceDir), workspace)
  }
})
