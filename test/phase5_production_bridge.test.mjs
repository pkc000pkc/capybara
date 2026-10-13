import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freezePluginSnapshot, inspectPluginResources } from '../src/phase0_inventory.mjs'
import { fileDigest } from '../src/phase0_run.mjs'
import { runChildProcess } from '../src/phase1_process.mjs'
import { startRuntimeHookService } from '../src/phase3_hook_service.mjs'
import { verifyOfficialA2ARuntimeEvidence } from '../src/phase5_a2a_evidence.mjs'
import { collectRuntimeEvidence, validateRuntimeEvidence } from '../src/phase3_runtime_evidence.mjs'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const protocol = JSON.parse(readFileSync(join(project, 'config/phase0-protocol.json'), 'utf8'))
const portable = path => path.replaceAll('\\', '/')

for (const mode of ['normal', 'user-after-sdk', 'user-after-offset', 'stop-after-sdk', 'readback-then-fresh']) {
  test(`production parent bridge and real Node/ARE child handle ${mode}, without models`,
    { timeout: 180000 }, async () => {
    // Real source capture requires a per-execution workspace inside this
    // project. All generated artifacts remain under the unique runs folder.
    const capture = mkdtempSync(join(project, 'runs/phase5-production-bridge-fixture-'))
    const runRoot = portable(relative(project, capture))
    const plugins = ['gaia2-runtime', 'gaia2-evaluation'].map(id => inspectPluginResources(
      freezePluginSnapshot({ root: project, id, sourceRoot: join(project, 'plugins', id) })))
    const capability = join(capture, 'fixture-capabilities.json')
    writeFileSync(capability, JSON.stringify({ syntheticFixtureOnly: true, plugins }))
    const workspace = join(capture, 'workspace'), output = join(capture, 'output')
    mkdirSync(workspace); mkdirSync(output)
    const manifest = { runRoot, runId: 'controlled-production-a2a-' + mode,
      manifestHash: 'f'.repeat(64), syntheticFixtureOnly: true, lockRefs: { capabilities: {
      path: portable(relative(project, capability)), sha256: fileDigest(capability) } } }
    const task = { phase: 'agent2agent', config: 'mini', executionId: 'production-a2a-' + mode,
      scenarioId: 'controlled-production-a2a-' + mode, runNumber: 1, attemptIndex: 0 }
    const session = { sessionId: 'production-a2a-session-' + mode,
      workspaceDir: portable(relative(project, workspace)), outputDir: portable(relative(project, output)) }
    const settings = { processTimeoutMs: 120000, heartbeatIntervalMs: 1000, scenarioTimeoutSeconds: 90 }
    const service = await startRuntimeHookService({ root: project, manifest, task, session, settings })
    const eventPath = join(output, 'runtime-events.jsonl')
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/(?:API_KEY|ACCESS_TOKEN|AUTHORIZATION|HF_TOKEN|HUGGINGFACE_TOKEN|GAIA2_HOOK_|GAIA2_A2A_|GAIA2_CORRECTION_|GAIA2_OFFICIAL_ENTRY_)/i.test(key)))
    let probe, host
    try {
      probe = await runChildProcess({ command: protocol.runtime.python,
        args: ['-B', join(project, 'scripts/phase5_production_bridge_probe.py'), '--workspace', workspace, '--mode', mode],
        cwd: project, outputDir: join(output, 'probe'), processTimeoutMs: 100000,
        heartbeatIntervalMs: 1000, secrets: [service.token, service.ready.a2a.channelId, service.ready.a2a.bindingHash, 'controlled-non-secret'],
        env: { ...cleanEnv, PYTHONPATH: join(project, '.official-python'), PYTHONUTF8: '1',
          HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
          LITELLM_LOCAL_MODEL_COST_MAP: 'True', LITELLM_TELEMETRY: 'False',
          GAIA2_HOOK_URL: service.endpoint, GAIA2_HOOK_TOKEN: service.token,
          GAIA2_EXECUTION_ID: task.executionId, GAIA2_SESSION_ID: session.sessionId,
          GAIA2_RUNTIME_EVENT_FILE: eventPath, GAIA2_E2E_MAX_ACTIONS: '10',
          OPENAI_API_KEY: 'controlled-non-secret',
          GAIA2_A2A_WORKSPACE: workspace, GAIA2_A2A_MODEL: 'controlled-model',
          GAIA2_A2A_PROVIDER: 'openai', GAIA2_A2A_ENDPOINT: 'http://127.0.0.1:1/v1',
          GAIA2_A2A_PIPE_HOST: service.ready.a2a.host, GAIA2_A2A_PIPE_PORT: String(service.ready.a2a.port),
          GAIA2_A2A_PIPE_CHANNEL: service.ready.a2a.channelId, GAIA2_A2A_PIPE_BINDING: service.ready.a2a.bindingHash },
      })
    } finally { host = await service.close() }
    const stdout = readFileSync(join(output, 'probe/stdout.log'), 'utf8')
    const stderr = readFileSync(join(output, 'probe/stderr.log'), 'utf8')
    for (const [name, result] of [['probe', probe], ['host', host]]) {
      assert.equal(result?.exitCode, 0, `${name} ${capture}\n${stdout}\n${stderr}`)
      assert.equal(result.childExited, true); assert.equal(result.childClosed, true)
      assert.equal(result.timedOut, false); assert.equal(result.interrupted, false)
      assert.deepEqual(result.terminationErrors, [])
    }
    const line = stdout.split(/\r?\n/).find(value => value.startsWith('PRODUCTION_BRIDGE_PROBE:'))
    assert.ok(line, capture)
    const report = JSON.parse(line.slice('PRODUCTION_BRIDGE_PROBE:'.length))
    assert.equal(report.status, 'passed'); assert.equal(report.realModelCalls, 0)
    assert.equal(report.benchmarkExecuted, false); assert.equal(report.externalNetworkAttempts, 0)
    assert.equal(report.pauseCleared, true); assert.equal(report.futureHidden, true)
    if (mode === 'readback-then-fresh') {
      assert.equal(report.blockedDispatches, 1)
      assert.equal(report.completedDispatches, 4)
      assert.equal(report.controlledClockAdvanceSeconds, 61)
      assert.deepEqual(report.savedApartments, ['apt-1'])
      assert.equal(report.childCompleted, 1); assert.equal(report.childFailed, 0)
    }
    const events = readFileSync(eventPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse)
    const verified = verifyOfficialA2ARuntimeEvidence({ events,
      identity: { executionId: task.executionId, sessionId: session.sessionId },
      readEvidence: path => readFileSync(join(project, path)) })
    assert.equal(verified.childCount, report.childSnapshots)
    assert.ok(verified.consumedEvidencePaths.length > 0)
    const captured = collectRuntimeEvidence({ root: project, manifest, task, session, events, hostProcess: host })
    const copied = new Map(captured.runtimeEvidence.map(ref => [ref.path, readFileSync(join(project, ref.path))]))
    // A detached byte reader proves validation never depends on reopening
    // native/gen/source absolute paths from the original machine.
    const attested = validateRuntimeEvidence({ manifest, task, session, events, ...captured,
      readEvidence: path => copied.get(path) })
    assert.equal(attested.realHooksReady, false)
    assert.ok(captured.runtimeEvidence.length > verified.consumedEvidencePaths.length)
    if (mode.startsWith('user-')) assert.equal(report.parentToolMessageOrderVerified, true)
    writeFileSync(join(capture, 'verification-report.json'), JSON.stringify({
      status: 'passed', syntheticFixtureOnly: true, benchmarkExecuted: false, realModelCalls: 0,
      report, verified, runtimeCapture: captured, probeProcess: probe, hookHostProcess: host }, null, 2) + '\n')
  })
}
