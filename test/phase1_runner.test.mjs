import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { digest, fileDigest, readJson } from '../src/phase0_run.mjs'
import { atomicJson, runFrozenBatch } from '../src/phase1_runner.mjs'
import { readProcessIdentity } from '../src/phase1_process.mjs'
import { fixtureFromScenario, readNativeResult, resolveModelRetrySettings, resolveTransportProvider } from '../src/phase1_official.mjs'
import { canonicalScenarioHash } from '../src/phase0_dataset.mjs'
import { spawn } from 'node:child_process'

const settings = { processTimeoutMs: 480000000, scenarioTimeoutSeconds: 480000, modelRequestTimeoutSeconds: 60, concurrency: 1, minimal: false, maxActions: 24, heartbeatIntervalMs: 1000, modelRetry: resolveModelRetrySettings({}) }
function project() { return mkdtempSync(join(tmpdir(), 'capybara-phase1-runner-')) }
function clean(root) { assert.ok(root.startsWith(tmpdir()) && root.includes('capybara-phase1-runner-')); rmSync(root, { recursive: true, force: true }) }
function plan(phases = ['standard', 'standard']) {
  const manifest = { runId: 'controlled', runRoot: 'runs/controlled', stateFile: 'runs/controlled/run-state.json', policy: { maxCorrections: 0 }, tasks: phases.map((phase, index) => ({ phase, config: 'execution', scenarioId: `scenario-${index}`, scenarioVersion: 'are_simulation_v1', runNumber: index + 1, attemptIndex: index + 1, executionId: `task-${index}`, outputDir: `runs/controlled/outputs/task-${index}`, fixtureDir: `runs/controlled/fixtures/task-${index}`, workspaceDir: `runs/controlled/workspaces/task-${index}` })) }
  return { ...manifest, manifestHash: digest(manifest) }
}
function good({ task }, passed = true) { return { processResult: { exitCode: 0 }, report: { scenarioId: task.scenarioId, runNumber: task.runNumber, evaluationComplete: true, businessPassed: passed, hasException: false }, events: [], artifacts: [] } }
function options(root, extra = {}) { return { root, manifest: plan(), settings, executeTask: good, ...extra } }

test('official transport maps ARE local provider labels to explicit OpenAI LiteLLM transport', () => {
  assert.equal(resolveTransportProvider('local'), 'openai')
  assert.equal(resolveTransportProvider(null), 'openai')
  assert.equal(resolveTransportProvider(undefined), 'openai')
  assert.equal(resolveTransportProvider('azure'), 'azure')
})

test('phase1 completed tasks including judged business failures are never rerun', async () => {
  const root = project(); let calls = 0
  try {
    const executeTask = async args => { calls++; return good(args, false) }
    const first = await runFrozenBatch(options(root, { executeTask }))
    assert.equal(first.status, 'evaluation_complete'); assert.equal(first.businessFailures, 2)
    const resumed = await runFrozenBatch(options(root, { executeTask, resume: true }))
    assert.equal(calls, 2); assert.equal(resumed.executedThisInvocation, 0)
    assert.equal(resumed.officialSubmissionReady, false)
    const heartbeat = readJson(join(root, 'runs/controlled/batch-heartbeat.json'))
    assert.equal(heartbeat.terminal, true); assert.equal(heartbeat.status, 'evaluation_complete')
    assert.ok(heartbeat.finishedAt); assert.equal(heartbeat.reportPath, 'runs/controlled/batch-report.json')
  } finally { clean(root) }
})

test('phase1 run-number selection preserves all 25 planned tasks and resumes selected tasks only', async () => {
  const root = project(), contents = plan(), configs = ['execution', 'search', 'adaptability', 'time', 'ambiguity']
  contents.tasks = configs.flatMap(config => [1, 2, 3, 4, 5].map(runNumber => ({ ...contents.tasks[0], config, scenarioId: `${config}-scenario`, runNumber, attemptIndex: runNumber, executionId: `${config}-${runNumber}`, outputDir: `runs/controlled/outputs/${config}-${runNumber}`, fixtureDir: `runs/controlled/fixtures/${config}-${runNumber}`, workspaceDir: `runs/controlled/workspaces/${config}-${runNumber}` })))
  const { manifestHash, ...base } = contents, manifest = { ...base, manifestHash: digest(base) }
  const calls = []
  const executeTask = args => { calls.push(args.task.executionId); return good(args) }
  try {
    for (const onlyRunNumber of [0, 6, 1.2, true, '1']) await assert.rejects(runFrozenBatch(options(root, { manifest, onlyRunNumber, executeTask })), /planned integer/)
    const first = await runFrozenBatch(options(root, { manifest, onlyRunNumber: 1, maxTasks: 1, executeTask }))
    assert.equal(first.status, 'incomplete'); assert.equal(first.selectedExecutions, 5); assert.equal(first.selectedCompleted, 1); assert.equal(first.selectedEvaluationComplete, false)
    const second = await runFrozenBatch(options(root, { manifest, onlyRunNumber: 1, resume: true, executeTask }))
    assert.equal(second.status, 'incomplete'); assert.equal(second.selectedCompleted, 5); assert.equal(second.selectedEvaluationComplete, true)
    assert.equal(second.plannedInitialExecutions, 25); assert.equal(second.evaluatedInitialExecutions, 5); assert.equal(second.counts.pending, 20)
    assert.equal(second.realHooksReady, false); assert.equal(second.officialSubmissionReady, false)
    const third = await runFrozenBatch(options(root, { manifest, onlyRunNumber: 1, resume: true, executeTask }))
    assert.equal(third.executedThisInvocation, 0); assert.equal(calls.length, 5); assert.equal(new Set(calls).size, 5)
    const state = readJson(join(root, manifest.stateFile))
    assert.equal(state.tasks.length, 25); assert.equal(state.tasks.filter(record => record.status === 'pending' && record.sessions.length === 0).length, 20)
  } finally { clean(root) }
})

test('phase1 production hook binding cannot accept a judged result without live evidence', async () => {
  const root = project(), { manifestHash, ...base } = plan()
  base.executionBinding = 'phase3_live_plugin_host_required'
  const manifest = { ...base, manifestHash: digest(base) }
  try {
    const report = await runFrozenBatch(options(root, { manifest }))
    assert.equal(report.evaluatedInitialExecutions, 0); assert.equal(report.businessSuccesses, 0); assert.equal(report.counts.retry_pending, 1)
    const state = readJson(join(root, manifest.stateFile)), result = readJson(join(root, state.tasks[0].resultPath))
    assert.equal(result.runtimeEvidenceRequired, true); assert.equal(result.evaluationComplete, false); assert.equal(result.score, null); assert.equal(result.realHooksReady, false)
  } finally { clean(root) }
})

test('phase1 interruption restarts in a new clean session preserving initial attempt count', async () => {
  const root = project()
  try {
    const first = await runFrozenBatch(options(root, { executeTask: async () => ({ processResult: { exitCode: null, interrupted: true }, report: null }) }))
    assert.equal(first.counts.retry_pending, 1); assert.equal(first.evaluatedInitialExecutions, 0)
    const before = readJson(join(root, plan().stateFile)).tasks[0].sessions[0]
    const second = await runFrozenBatch(options(root, { resume: true }))
    const after = readJson(join(root, plan().stateFile)).tasks[0].sessions[1]
    assert.equal(second.status, 'evaluation_complete'); assert.equal(second.totalSessions, 3); assert.equal(second.plannedInitialExecutions, 2)
    assert.equal(after.parentSessionId, before.sessionId)
    for (const key of ['outputDir', 'fixtureDir', 'workspaceDir']) assert.notEqual(before[key], after[key])
    assert.equal(after.recoveryKind, 'clean_environment_restart_not_ARE_checkpoint')
  } finally { clean(root) }
})

test('phase1 commits result before state and reconciles the interrupted commit window', async () => {
  const root = project()
  try {
    await runFrozenBatch(options(root, { maxTasks: 1 }))
    const statePath = join(root, plan().stateFile), state = readJson(statePath)
    state.tasks[0].status = 'running'; state.tasks[0].resultPath = null; state.tasks[0].resultSha256 = null
    atomicJson(join(root, state.tasks[0].sessions.at(-1).outputDir, 'process-result.json'), { schemaVersion: 'gaia2-process-result-v1', finishedAt: new Date().toISOString(), exitCode: 0, childExited: true, childClosed: true, processIdentity: { pid: 123, verified: false }, terminationErrors: [], manualInspectionRequired: false })
    atomicJson(statePath, state)
    let calls = 0
    const report = await runFrozenBatch(options(root, { resume: true, executeTask: args => { calls++; return good(args) } }))
    assert.equal(calls, 1); assert.equal(report.totalSessions, 2)
  } finally { clean(root) }
})

test('phase1 refuses runtime drift, result corruption and forged completed metadata', async () => {
  const root = project()
  try {
    await runFrozenBatch(options(root))
    await assert.rejects(runFrozenBatch(options(root, { resume: true, settings: { ...settings, modelRetry: { ...settings.modelRetry, maxAttempts: 1 } } })), /settings changed/)
    const heartbeat = readJson(join(root, 'runs/controlled/batch-heartbeat.json'))
    assert.equal(heartbeat.terminal, true); assert.equal(heartbeat.status, 'infrastructure_error')
    assert.equal(heartbeat.terminationReason, 'validation_or_persistence_error')
    const state = readJson(join(root, plan().stateFile)), path = join(root, state.tasks[0].resultPath)
    const result = readJson(path); result.scenarioId = 'foreign'; atomicJson(path, result)
    state.tasks[0].resultSha256 = fileDigest(path); atomicJson(join(root, plan().stateFile), state)
    await assert.rejects(runFrozenBatch(options(root, { resume: true })), /task metadata differs/)
    writeFileSync(path, '{}')
    await assert.rejects(runFrozenBatch(options(root, { resume: true })), /content changed/)
  } finally { clean(root) }
})

test('phase1 rejects live owners, live orphan children and altered recovery paths', async () => {
  const root = project()
  try {
    let finish
    const started = new Promise(resolveStarted => { finish = resolveStarted })
    let release
    const held = new Promise(resolveHeld => { release = resolveHeld })
    const running = runFrozenBatch(options(root, { maxTasks: 1, executeTask: async args => { finish(); await held; return good(args) } }))
    await started
    await assert.rejects(runFrozenBatch(options(root, { resume: true })), /live process owns/)
    release(); await running
    const path = join(root, plan().stateFile), state = readJson(path), record = state.tasks[0]
    record.status = 'running'; record.resultPath = null; record.resultSha256 = null
    const output = resolve(root, record.sessions[0].outputDir)
    atomicJson(join(output, 'heartbeat.json'), { processIdentity: await readProcessIdentity(process.pid) })
    atomicJson(path, state)
    await assert.rejects(runFrozenBatch(options(root, { resume: true })), /live child/)
    record.sessions[0].outputDir = '../outside'; atomicJson(path, state)
    await assert.rejects(runFrozenBatch(options(root, { resume: true })), /paths differ/)
  } finally { clean(root) }
})

test('phase1 rejects corrupt child final results instead of trusting existence', async () => {
  const root = project()
  try {
    await runFrozenBatch(options(root, { maxTasks: 1 }))
    const state = readJson(join(root, plan().stateFile)), record = state.tasks[0]
    record.status = 'running'; record.resultPath = null; record.resultSha256 = null
    atomicJson(join(root, record.sessions[0].outputDir, 'process-result.json'), {})
    atomicJson(join(root, plan().stateFile), state)
    await assert.rejects(runFrozenBatch(options(root, { resume: true })), /invalid final child result/)
  } finally { clean(root) }
})

test('phase1 refuses retry_pending restart when descendant termination is unresolved', async () => {
  const root = project()
  try {
    await runFrozenBatch(options(root, { executeTask: async () => ({ processResult: { exitCode: null, interrupted: true }, report: null }) }))
    const state = readJson(join(root, plan().stateFile)), session = state.tasks[0].sessions.at(-1)
    atomicJson(join(root, session.outputDir, 'process-result.json'), { schemaVersion: 'gaia2-process-result-v1', exitCode: 0, finishedAt: new Date().toISOString(), terminationErrors: [{ code: 'ORPHAN_PIPE_OWNERSHIP_UNKNOWN' }], manualInspectionRequired: true })
    let calls = 0
    await assert.rejects(runFrozenBatch(options(root, { resume: true, executeTask: args => { calls++; return good(args) } })), /termination is unresolved/)
    assert.equal(calls, 0); assert.equal(readJson(join(root, plan().stateFile)).tasks[0].sessions.length, 1)
  } finally { clean(root) }
})

test('phase1 refuses a live or unknown hook host before restarting an interrupted official session', async () => {
  for (const kind of ['heartbeat-live', 'final-live', 'final-unknown', 'reservation-only']) {
    const root = project()
    try {
      await runFrozenBatch(options(root, { executeTask: async () => ({ processResult: { exitCode: null, interrupted: true }, report: null }) }))
      const state = readJson(join(root, plan().stateFile)), session = state.tasks[0].sessions[0], hostDir = join(root, session.outputDir, 'hook-host')
      if (kind === 'heartbeat-live') atomicJson(join(hostDir, 'heartbeat.json'), { processIdentity: await readProcessIdentity(process.pid) })
      if (kind === 'final-live' || kind === 'final-unknown') atomicJson(join(hostDir, 'process-result.json'), { schemaVersion: 'gaia2-process-result-v1', finishedAt: new Date().toISOString(), exitCode: 0, processIdentity: kind === 'final-live' ? await readProcessIdentity(process.pid) : { pid: 123, verified: false }, childExited: true, childClosed: true, terminationErrors: [] })
      if (kind === 'reservation-only') atomicJson(join(hostDir, 'process-reservation.json'), { spawnState: 'spawned', pid: 123 })
      let calls = 0
      await assert.rejects(runFrozenBatch(options(root, { resume: true, executeTask: args => { calls++; return good(args) } })), /hook host.*(?:live process|ownership|metadata)/)
      assert.equal(calls, 0); assert.equal(readJson(join(root, plan().stateFile)).tasks[0].sessions.length, 1)
    } finally { clean(root) }
  }
})

test('phase1 recovers verified dead owner and dead orphan into a new session', async () => {
  const root = project()
  try {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true })
    const exited = new Promise(resolveExit => child.once('exit', resolveExit))
    let identity
    try { identity = await readProcessIdentity(child.pid) } finally { child.kill() }
    assert.ok(identity?.verified)
    await exited
    await runFrozenBatch(options(root, { maxTasks: 1 }))
    const statePath = join(root, plan().stateFile), state = readJson(statePath), record = state.tasks[0]
    record.status = 'running'; record.resultPath = null; record.resultSha256 = null
    // Discard only the synthetic finished result to simulate interrupted-before-result state.
    const synthetic = join(root, record.sessions[0].workspaceDir, 'task-result.json')
    writeFileSync(synthetic, JSON.stringify({ evaluationComplete: false }))
    atomicJson(join(root, record.sessions[0].outputDir, 'heartbeat.json'), { processIdentity: identity })
    atomicJson(join(root, record.sessions[0].outputDir, 'hook-host/process-result.json'), { schemaVersion: 'gaia2-process-result-v1', finishedAt: new Date().toISOString(), exitCode: 0, processIdentity: identity, terminationErrors: [], manualInspectionRequired: false })
    atomicJson(join(root, plan().runRoot, 'run-owner.json'), { ownerId: 'dead-owner', processIdentity: identity })
    atomicJson(statePath, state)
    const result = await runFrozenBatch(options(root, { resume: true }))
    assert.equal(result.status, 'evaluation_complete'); assert.equal(result.totalSessions, 3)
    assert.equal(readJson(statePath).tasks[0].sessions[1].parentSessionId, record.sessions[0].sessionId)
  } finally { clean(root) }
})

test('phase1 preserves exhausted infrastructure failures and rejects enhancements before spawning', async () => {
  const root = project(); let calls = 0
  try {
    await assert.rejects(runFrozenBatch(options(root, { manifest: plan(['standard', 'noise']), executeTask: () => { calls++; return {} } })), /entire run rejected/)
    assert.equal(calls, 0)
    const executeTask = async () => { calls++; return { processResult: { exitCode: 0 }, report: { hasException: true, score: 0, status: 'failed' }, events: [{ type: 'model_request_failed', requestId: 'a', category: 'rate_limit', retryable: true, retryExhausted: true, httpStatus: 429 }] } }
    const first = await runFrozenBatch(options(root, { executeTask }))
    assert.equal(first.businessFailures, 0); assert.equal(first.counts.retry_pending, 1)
    await runFrozenBatch(options(root, { executeTask, resume: true }))
    assert.equal(calls, 1)
    const next = await runFrozenBatch(options(root, { resume: true, retryInfrastructure: true, executeTask: good }))
    assert.equal(next.totalSessions, 3); assert.equal(next.status, 'evaluation_complete')
  } finally { clean(root) }
})

test('phase1 credential-bearing settings and false foreign judgments cannot count as completed', async () => {
  const root = project()
  try {
    await assert.rejects(runFrozenBatch(options(root, { settings: { ...settings, api_key: 'test-only' } })), /secret field/)
    const report = await runFrozenBatch(options(root, { executeTask: args => ({ ...good(args), report: { ...good(args).report, scenarioId: 'foreign' } }) }))
    assert.equal(report.evaluatedInitialExecutions, 0); assert.equal(report.counts.retry_pending, 1)
  } finally { clean(root) }
})

test('phase1 fixture preserves complete original semantics except explicit run metadata', () => {
  const scenario = { version: 'are_simulation_v1', metadata: { definition: { scenario_id: 's', duration: 1800, seed: 9 } }, events: [{ event_type: 'USER', content: 'original' }], apps: [1, 2], augmentation: {} }
  const task = { scenarioId: 's', scenarioVersion: scenario.version, scenarioHash: canonicalScenarioHash(scenario), runNumber: 5 }
  const fixture = fixtureFromScenario(scenario, task)
  assert.equal(fixture.metadata.definition.run_number, 5)
  delete fixture.metadata.definition.run_number
  assert.deepEqual(fixture, scenario)
  assert.throws(() => fixtureFromScenario({ ...scenario, apps: [] }, task), /content differs/)
})

test('phase1 native reader requires same-session judgment and distinguishes technical exceptions', () => {
  const root = project()
  try {
    const output = join(root, 'output'); mkdirSync(output)
    const task = { executionId: 'exec', scenarioId: 's', runNumber: 3 }, session = { sessionId: 'session' }
    const trace = { metadata: { definition: { scenario_id: 's', run_number: 3, has_exception: false } } }
    const tracePath = join(output, 'trace.json'); atomicJson(tracePath, trace)
    const row = { task_id: 's', trace_id: tracePath, score: 0, metadata: { scenario_id: 's', run_number: 3, status: 'failed', has_exception: false } }
    writeFileSync(join(output, 'output.jsonl'), JSON.stringify(row)+'\n')
    const events = [{ type: 'official_validation_completed', executionId: 'exec', sessionId: 'session', validationSuccess: false, hasException: false }]
    const read = extra => readNativeResult({ root, outputDir: 'output', task, session, events, ...extra })
    assert.equal(read().report.evaluationComplete, true); assert.equal(read().report.businessPassed, false)
    assert.equal(read({ events: [] }).report.evaluationComplete, false)
    assert.throws(() => read({ events: [{ ...events[0], sessionId: 'foreign' }] }), /another session/)
    row.metadata.has_exception = true; row.metadata.exception_type = 'ModelRequestFailure'; writeFileSync(join(output, 'output.jsonl'), JSON.stringify(row)+'\n')
    assert.equal(read().report.evaluationComplete, false)
    row.trace_id = join(root, 'outside.json'); writeFileSync(join(output, 'output.jsonl'), JSON.stringify(row)+'\n')
    assert.throws(() => read(), /trace escapes/)
  } finally { clean(root) }
})
