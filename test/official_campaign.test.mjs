import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { coverageFirstOrder, runOfficialCampaign } from '../scripts/run_official_campaign.mjs'
import { digest, fileDigest, readJson } from '../src/phase0_run.mjs'
import { atomicJson, runFrozenBatch } from '../src/phase1_runner.mjs'
import { resolveRuntimeSettings } from '../src/phase1_config.mjs'
import { resolveModelRetrySettings } from '../src/phase1_official.mjs'

function fixture(t, taskCount = 6) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'capybara-official-campaign-'))
  t.after(() => { assert.ok(root.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(root).startsWith('capybara-official-campaign-')); fs.rmSync(root, { recursive: true, force: true }) })
  t.mock.method(console, 'log', () => {})
  const base = { schemaVersion: 'gaia2-run-manifest-v1', runId: 'campaign-test', runRoot: 'runs/campaign-test', stateFile: 'runs/campaign-test/run-state.json',
    mode: 'official_submission', policy: { maxCorrections: 0 }, lockRefs: {}, models: {}, requestedRuntime: {}, selection: { fullOfficialCoverage: true },
    tasks: Array.from({ length: taskCount }, (_, index) => {
      const executionId = `task-${index}`, phase = ['standard', 'agent2agent', 'noise'][Math.floor(index / 2) % 3]
      return { executionId, phase, config: phase === 'standard' ? ['execution', 'search'][index % 2] : 'mini', runNumber: 1,
        scenarioId: `scenario-${index}`, outputDir: `runs/campaign-test/executions/${executionId}`,
        fixtureDir: `runs/campaign-test/fixtures/${executionId}`, workspaceDir: `runs/campaign-test/workspaces/${executionId}` }
    }) }
  const manifest = { ...base, manifestHash: digest(base) }
  const manifestPath = 'runs/campaign-test/run-manifest.json'
  atomicJson(path.join(root, manifestPath), manifest)
  const calls = [], waits = [], probes = [], outcomes = new Map(), options = { root, manifestPath, env: {}, serviceCooldownMs: 10, maxServiceCooldownMs: 40 }
  let sourceStable = true, unsafeProcess = false, probeStatuses = ['healthy']
  const identity = { verified: true, platform: 'win32', pid: 777, birthTime: 'test' }
  const closed = { schemaVersion: 'gaia2-process-result-v1', exitCode: 0, pid: 777, processIdentity: identity, childExited: true, childClosed: true,
    manualInspectionRequired: false, supervisionDetached: false, terminationErrors: [], timedOut: false, interrupted: false, finishedAt: new Date().toISOString() }
  const dependencies = {
    validateInputs: async () => () => sourceStable,
    readProcessIdentity: async () => identity,
    isProcessIdentityAlive: async () => false,
    readModelConnection: () => ({ apiKey: 'secret-must-not-appear' }),
    pause: async value => { waits.push(value) },
    checkModelService: async () => {
      const status = probeStatuses.shift() ?? 'healthy'; probes.push(status)
      return { status: status === 401 ? 'unavailable' : status, checks: { models: { httpStatus: 200 }, chatCompletions: { httpStatus: status === 401 ? 401 : status === 'healthy' ? 200 : 503 } } }
    },
    runChildProcess: async args => {
      assert.ok(args.args.includes('--execute') && args.args.includes('--resume'))
      assert.ok(!args.args.includes('--retry-infrastructure'))
      assert.equal(args.args.at(-1), '1')
      assert.equal(args.processTimeoutMs, 0)
      const inFlight = readJson(path.join(root, 'runs/campaign-test/campaign-state.json'))
      assert.equal(inFlight.counts.running, 1)
      assert.equal(inFlight.activeExecutionId, inFlight.slots.find(slot => slot.status === 'running').executionId)
      const executionId = args.args[args.args.indexOf('--only-execution-id') + 1]
      calls.push(executionId)
      const report = await runFrozenBatch({ root, manifest,
      settings: { ...resolveRuntimeSettings({ protocol: { requestedRuntime: manifest.requestedRuntime }, entrypoint: 'batch', env: {} }), modelRetry: resolveModelRetrySettings({}) },
      resume: true, onlyExecutionId: executionId, onlyPhase: manifest.tasks.find(task => task.executionId === executionId).phase, onlyRunNumber: 1, maxTasks: 1,
      executeTask: async ({ task, session }) => {
        const processPath = path.join(root, session.outputDir, 'process-result.json')
        atomicJson(processPath, { ...closed, manualInspectionRequired: unsafeProcess })
        const artifact = path.join(root, session.outputDir, 'output.jsonl')
        fs.writeFileSync(artifact, JSON.stringify({ role: 'assistant', content: 'visible model response and tool trace fixture' }) + '\n')
        const outcome = outcomes.get(task.executionId) ?? 'success'
        const events = outcome === 'transport' || outcome === 'bad_request' ? [{ type: 'model_request_failed', requestId: 'request-1',
          category: outcome === 'transport' ? 'transport_error' : 'configuration_error', retryable: outcome === 'transport', httpStatus: outcome === 'transport' ? 503 : 400 }] : []
        return { processResult: { exitCode: ['success', 'business_zero'].includes(outcome) ? 0 : 1 },
          report: { scenarioId: task.scenarioId, runNumber: 1, evaluationComplete: ['success', 'business_zero'].includes(outcome), businessPassed: outcome === 'success',
            ...(['success', 'business_zero'].includes(outcome) ? {} : { hasException: true, exceptionType: 'RuntimeError' }) }, events,
          artifacts: [{ path: path.relative(root, artifact).replaceAll('\\', '/'), sha256: fileDigest(artifact) }] }
      } })
      fs.mkdirSync(args.outputDir, { recursive: true })
      const stdoutPath = path.join(args.outputDir, 'stdout.log'), resultPath = path.join(args.outputDir, 'process-result.json')
      fs.writeFileSync(stdoutPath, JSON.stringify(report))
      const result = { ...closed, exitCode: report.status === 'evaluation_complete' ? 0 : 2, stdoutPath, resultPath }
      atomicJson(resultPath, result)
      return result
    },
  }
  return { root, manifest, manifestPath, calls, waits, probes, outcomes, options, dependencies,
    sourceChange: () => { sourceStable = false }, unsafe: () => { unsafeProcess = true }, setProbes: values => { probeStatuses = values } }
}

test('dispatch covers run 1 first, rotates phases and standard configurations without changing frozen tasks', () => {
  const tasks = []
  for (const phase of ['standard', 'agent2agent', 'noise']) for (const config of phase === 'standard' ? ['execution', 'search', 'adaptability', 'time', 'ambiguity'] : ['mini']) {
    for (let scenario = 0; scenario < 2; scenario++) for (const runNumber of [1, 2, 3]) tasks.push({ executionId: `${phase}-${config}-${scenario}-${runNumber}`, phase, config, runNumber })
  }
  const before = JSON.stringify(tasks), ids = coverageFirstOrder(tasks), byId = new Map(tasks.map(task => [task.executionId, task]))
  assert.equal(new Set(ids).size, tasks.length)
  assert.deepEqual(ids.slice(0, 6).map(id => [byId.get(id).phase, byId.get(id).config]), [
    ['standard', 'execution'], ['agent2agent', 'mini'], ['noise', 'mini'], ['standard', 'search'], ['agent2agent', 'mini'], ['noise', 'mini'],
  ])
  assert.deepEqual(ids.map(id => byId.get(id).runNumber), [...tasks.map(task => task.runNumber)].sort())
  assert.equal(JSON.stringify(tasks), before)
})

test('enhanced tasks rotate capabilities matched by exact official Standard identity and hash', () => {
  const tasks = []
  for (const phase of ['standard', 'agent2agent', 'noise']) for (const config of ['time', 'execution']) {
    for (let ordinal = 0; ordinal < 2; ordinal++) tasks.push({ executionId: `${phase}-${config}-${ordinal}`, phase,
      config: phase === 'standard' ? config : 'mini', runNumber: 1,
      scenarioId: `${config}-${ordinal}`, scenarioHash: `${config}-hash-${ordinal}` })
  }
  const byId = new Map(tasks.map(task => [task.executionId, task]))
  const ids = coverageFirstOrder(tasks)
  assert.deepEqual(ids.slice(0, 6).map(id => byId.get(id).scenarioId), [
    'time-0', 'time-0', 'time-0', 'execution-0', 'execution-0', 'execution-0',
  ])
  assert.equal(new Set(ids).size, tasks.length)
  assert.equal(tasks.filter(task => task.config === 'mini').length, 8)
})

test('isolates runtime/transport/HTTP400 failures, cools service, preserves scores/traces and never replays a slot', async t => {
  const f = fixture(t)
  f.outcomes.set('task-0', 'business_zero'); f.outcomes.set('task-2', 'runtime'); f.outcomes.set('task-4', 'transport'); f.outcomes.set('task-3', 'bad_request')
  f.setProbes(['unavailable', 'healthy', 'healthy'])
  const report = await runOfficialCampaign(f.options, f.dependencies)
  assert.equal(report.status, 'all_slots_attempted')
  assert.deepEqual(f.calls, ['task-0', 'task-2', 'task-4', 'task-1', 'task-3', 'task-5'])
  assert.equal(report.counts.completed, 3); assert.equal(report.counts.terminal_failure, 2); assert.equal(report.counts.retry_pending, 1)
  assert.equal(report.counts.businessFailures, 1); assert.equal(report.counts.businessSuccesses, 2)
  assert.deepEqual(f.probes, ['unavailable', 'healthy', 'healthy']); assert.deepEqual(f.waits, [10, 20, 10])
  assert.ok(report.slots.every(slot => slot.sessionCount === 1 && slot.result.sha256 && slot.artifacts[0].sha256))
  assert.ok(report.slots.filter(slot => slot.status !== 'completed').every(slot => slot.score === null))
  const observer = fs.readFileSync(path.join(f.root, report.observerPath), 'utf8')
  assert.ok(observer.includes('slot_recorded') && observer.includes('cooling_down') && observer.includes('output.jsonl'))
  assert.ok(!observer.includes('secret-must-not-appear'))
  assert.equal(fs.existsSync(path.join(f.root, 'runs/campaign-test/campaign-owner.json')), false)
  const repeat = await runOfficialCampaign(f.options, f.dependencies)
  assert.equal(repeat.status, 'all_slots_attempted'); assert.equal(f.calls.length, 6)
})

test('a changed frozen source is fatal before dispatching another task', async t => {
  const f = fixture(t, 2), run = f.dependencies.runChildProcess
  f.dependencies.runChildProcess = async args => { const result = await run(args); f.sourceChange(); return result }
  await assert.rejects(runOfficialCampaign(f.options, f.dependencies), /frozen_source_or_manifest_changed/)
  assert.equal(f.calls.length, 1)
  assert.equal(readJson(path.join(f.root, 'runs/campaign-test/campaign-state.json')).status, 'fatal')
})

test('unresolved native process ownership stops the campaign rather than launching an independent task', async t => {
  const f = fixture(t, 2); f.unsafe()
  await assert.rejects(runOfficialCampaign(f.options, f.dependencies), /process_ownership_or_persistence_unresolved/)
  assert.equal(f.calls.length, 1)
})

test('confirmed global authentication rejection stops after a service probe without consuming the next slot', async t => {
  const f = fixture(t, 2); f.outcomes.set('task-0', 'transport'); f.setProbes([401])
  await assert.rejects(runOfficialCampaign(f.options, f.dependencies), /model_authentication_failed/)
  assert.deepEqual(f.calls, ['task-0'])
  assert.equal(readJson(path.join(f.root, f.manifest.stateFile)).tasks[1].status, 'pending')
})

test('production preflight rejects a synthetic workspace before launching any model or benchmark process', async t => {
  const f = fixture(t, 2)
  await assert.rejects(runOfficialCampaign(f.options, { runChildProcess: () => { throw new Error('must not spawn') } }))
  assert.equal(f.calls.length, 0)
})
