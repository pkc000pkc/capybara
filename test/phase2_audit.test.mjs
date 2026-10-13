import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRunManifest, digest, fileDigest, readJson } from '../src/phase0_run.mjs'
import { auditSubmissionPackage, officialA2ATraceErrors, officialNoiseTraceErrors } from '../src/phase2_audit.mjs'

const sha = value => digest(value)
function put(root, path, value) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`)
  return { path, sha256: fileDigest(join(root, path)) }
}
function fixture({ mode = 'internal_pass5', phases = ['standard', 'standard'], statuses = ['success', 'failed'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'capybara-phase2-audit-'))
  const runtime = { concurrency: 1, minimal: false, processTimeoutMs: 0 }
  const tasks = phases.map((phase, index) => ({ phase, config: phase === 'standard' ? 'execution' : 'mini', scenarioId: 'same-scenario', runNumber: phases.every(item => item === 'standard') ? index + 1 : 1, executionId: `execution-${index}`, attemptIndex: mode === 'internal_pass5' ? index + 1 : null, correctionOrdinal: 0, outputDir: `runs/fixture/executions/execution-${index}`, fixtureDir: `runs/fixture/fixtures/execution-${index}`, workspaceDir: `runs/fixture/workspaces/execution-${index}` }))
  const base = { schemaVersion: 'gaia2-phase2-fixture-manifest-v1', syntheticFixtureOnly: true, runId: 'fixture', runRoot: 'runs/fixture', stateFile: 'runs/fixture/run-state.json', mode, policy: { initialRunsPerScenario: mode === 'internal_pass5' ? 5 : 3 }, selection: { expectedInitialExecutions: tasks.length, fullOfficialCoverage: false }, tasks }
  const manifest = { ...base, manifestHash: sha(base) }
  const state = { schemaVersion: 'gaia2-run-state-v1', runId: manifest.runId, manifestHash: manifest.manifestHash, runtimeHash: sha(runtime), tasks: [] }
  const sidecar = { schemaVersion: 'gaia2-export-manifest-v1', sourceRunId: manifest.runId, manifestHash: manifest.manifestHash, mode, evidenceKind: 'synthetic_fixture', syntheticFixtureOnly: true, runtimeHash: sha(runtime), strategyHash: sha({ policy: manifest.policy, models: manifest.models, correctionOrdinal: 0 }), strategyConsumed: false, lockSnapshots: {}, records: [], missing: [], files: [] }
  const outputRows = new Map()
  for (const [index, task] of tasks.entries()) {
    const status = statuses[index], technical = !['success', 'failed'].includes(status), passed = status === 'success'
    const sessionId = '0001-aaaaaaaaaaaa', session = { sessionId, sessionOrdinal: 1, parentSessionId: null, outputDir: `${task.outputDir}/sessions/${sessionId}`, fixtureDir: `${task.fixtureDir}/sessions/${sessionId}`, workspaceDir: `${task.workspaceDir}/sessions/${sessionId}` }
    const tracePath = `hf/${task.executionId}.json`
    const definition = { scenario_id: task.scenarioId, run_number: task.runNumber, config: task.config, has_exception: status === 'exception', exception_type: status === 'exception' ? 'RuntimeError' : null }
    const metadata = { definition }
    if (task.phase === 'noise') {
      Object.assign(definition, { has_a2a_augmentation: false, has_tool_augmentation: true, has_env_events_augmentation: true })
      metadata.runner_config = {
        a2a_app_prop: 0,
        tool_augmentation_config: { tool_failure_probability: 0.1, apply_tool_name_augmentation: true, apply_tool_description_augmentation: true },
        env_events_config: { num_env_events_per_minute: 10, env_events_seed: 0 },
      }
    }
    const trace = { world_logs: [], apps: [], events: [], completed_events: [], version: 'are_simulation_v1', context: null, augmentation: null, metadata }
    const traceRef = put(root, tracePath, trace)
    const nativeOutputPath = `evidence/${task.executionId}/native-output.jsonl`, outputPath = `${task.phase}/${task.config}/output.jsonl`
    const row = { task_id: task.scenarioId, trace_id: tracePath, score: technical ? null : passed ? 1 : 0, metadata: { scenario_id: task.scenarioId, run_number: task.runNumber, phase: task.phase, config: task.config, execution_id: task.executionId, status, has_exception: status === 'exception' } }
    const nativeRef = put(root, nativeOutputPath, `${JSON.stringify({ ...row, trace_id: 'trace.json' })}\n`)
    const sourceTrace = `${session.outputDir}/trace.json`, sourceNative = `${session.outputDir}/output.jsonl`
    const artifacts = [{ sourcePath: sourceTrace, ...traceRef }, { sourcePath: sourceNative, ...nativeRef }]
    const result = { schemaVersion: 'gaia2-task-result-v1', runId: manifest.runId, manifestHash: manifest.manifestHash, runtimeHash: sha(runtime), executionId: task.executionId, sessionId, scenarioId: task.scenarioId, runNumber: task.runNumber, phase: task.phase, config: task.config, evaluationComplete: !technical, businessPassed: technical ? null : passed, score: row.score, failure: technical ? { category: 'runtime_error', retryable: false } : passed ? null : { category: 'business_failure', retryable: false }, process: { exitCode: 0, signal: null, timedOut: false, interrupted: false }, artifacts: artifacts.map(item => ({ path: item.sourcePath, sha256: item.sha256 })) }
    const resultRef = put(root, `evidence/${task.executionId}/task-result.json`, result)
    const processRef = put(root, `evidence/${task.executionId}/process-result.json`, { schemaVersion: 'gaia2-process-result-v1', exitCode: 0, signal: null, timedOut: false, interrupted: false, terminationErrors: [], finishedAt: new Date().toISOString() })
    const eventsRef = put(root, `evidence/${task.executionId}/runtime-events.jsonl`, `${JSON.stringify({ type: 'official_validation_completed', executionId: task.executionId, sessionId, hasException: status === 'exception', validationSuccess: technical ? null : passed })}\n`)
    state.tasks.push({ executionId: task.executionId, status: technical ? 'retry_pending' : 'completed', sessions: [session], resultPath: `${session.workspaceDir}/task-result.json`, resultSha256: resultRef.sha256 })
    sidecar.records.push({ phase: task.phase, config: task.config, scenarioId: task.scenarioId, runNumber: task.runNumber, executionId: task.executionId, sessionId, result: resultRef, processResult: processRef, runtimeEvents: eventsRef, artifacts, trace: traceRef, outputPath })
    const group = outputRows.get(outputPath) ?? []; group.push(row); outputRows.set(outputPath, group)
    sidecar.files.push(traceRef, nativeRef, resultRef, processRef, eventsRef)
  }
  sidecar.sourceManifest = put(root, 'run-manifest.json', manifest)
  sidecar.files.push(sidecar.sourceManifest)
  sidecar.state = put(root, 'evidence/run-state.json', state)
  sidecar.runtimeSettings = put(root, 'evidence/runtime-settings.json', runtime)
  sidecar.files.push(sidecar.state, sidecar.runtimeSettings)
  for (const [path, rows] of outputRows) sidecar.files.push(put(root, path, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`))
  put(root, 'export-manifest.json', sidecar)
  const audit = extra => auditSubmissionPackage({ packageRoot: root, ...extra })
  const updateSidecar = mutate => { const value = readJson(join(root, 'export-manifest.json')); mutate(value); put(root, 'export-manifest.json', value) }
  const updateOutput = mutate => { const path = 'standard/execution/output.jsonl', rows = readFileSync(join(root, path), 'utf8').trim().split('\n').map(JSON.parse); mutate(rows); put(root, path, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`) }
  return { root, tasks, audit, updateSidecar, updateOutput }
}
function cleanup(root) { assert.ok(root.startsWith(tmpdir()) && root.includes('capybara-phase2-audit-')); rmSync(root, { recursive: true, force: true }) }

test('phase2 structural audit rejects root and deep output files instead of silently ignoring them', () => {
  for (const path of ['output.jsonl', 'evidence/nested/output.jsonl', 'standard/execution/deeper/output.jsonl']) {
    const value = fixture()
    try {
      put(value.root, path, '{}\n')
      const audit = value.audit()
      assert.equal(audit.format_valid, false); assert.equal(audit.coverage_complete, false)
      assert.ok(audit.issues.some(issue => issue.code === 'noncanonical_output_layout'))
    } finally { cleanup(value.root) }
  }
})

test('phase2 native judgments and trace identities are checked even when all affected hashes are rebound', () => {
  for (const mutate of [row => { row.score = 0; row.metadata.status = 'failed' }, row => { row.metadata.has_exception = true }, row => { row.trace_id = 'foreign.json' }, row => { row.metadata.run_number = 99 }]) {
    const value = fixture()
    try {
      const sidecar = readJson(join(value.root, 'export-manifest.json')), record = sidecar.records[0]
      const native = record.artifacts.find(artifact => artifact.sourcePath.endsWith('/output.jsonl'))
      const row = JSON.parse(readFileSync(join(value.root, native.path), 'utf8')); mutate(row)
      const updated = put(value.root, native.path, `${JSON.stringify(row)}\n`)
      native.sha256 = updated.sha256
      const result = readJson(join(value.root, record.result.path))
      result.artifacts.find(artifact => artifact.path === native.sourcePath).sha256 = updated.sha256
      record.result = put(value.root, record.result.path, result)
      const state = readJson(join(value.root, sidecar.state.path)); state.tasks[0].resultSha256 = record.result.sha256
      sidecar.state = put(value.root, sidecar.state.path, state)
      for (const ref of [updated, record.result, sidecar.state]) sidecar.files = sidecar.files.map(file => file.path === ref.path ? ref : file)
      put(value.root, 'export-manifest.json', sidecar)
      const audit = value.audit()
      assert.equal(audit.format_valid, true); assert.equal(audit.coverage_complete, true); assert.equal(audit.evaluation_complete, false)
      assert.ok(audit.issues.some(issue => issue.code === 'native_judgment_or_trace_binding_mismatch'))
    } finally { cleanup(value.root) }
  }
})

test('phase2 null first artifact returns diagnostic issues without crashing', () => {
  const value = fixture()
  try {
    value.updateSidecar(sidecar => { sidecar.records[0].artifacts.unshift(null) })
    assert.equal(value.audit().evaluation_complete, false)
  } finally { cleanup(value.root) }
})

test('phase2 independent audit accepts a complete synthetic plan and judged business failure', () => {
  const value = fixture()
  try {
    const audit = value.audit()
    assert.equal(audit.format_valid, true); assert.equal(audit.coverage_complete, true); assert.equal(audit.evaluation_complete, true)
    assert.equal(audit.metrics.successCount, 1); assert.equal(audit.metrics.businessFailureCount, 1); assert.equal(audit.metrics.evaluatedRows, 2)
    assert.equal(audit.officialSubmissionReady, false); assert.equal(audit.officialCheckPassed, false)
    assert.ok(audit.readinessBlockers.includes('official_reconstruction_not_checked'))
  } finally { cleanup(value.root) }
})

test('phase2 coverage is independent of syntactically valid duplicate, missing and unknown rows', () => {
  for (const mutate of [(rows) => rows.pop(), (rows) => rows.push(structuredClone(rows[0])), (rows, value) => { rows[0].metadata.execution_id = 'unknown'; copyFileSync(join(value.root, 'hf/execution-0.json'), join(value.root, 'hf/unknown.json')) }]) {
    const value = fixture()
    try { value.updateOutput(rows => mutate(rows, value)); const audit = value.audit(); assert.equal(audit.format_valid, true); assert.equal(audit.coverage_complete, false); assert.equal(audit.evaluation_complete, false) }
    finally { cleanup(value.root) }
  }
})

test('phase2 repeated scenario/run in different phases is not a duplicate key', () => {
  const value = fixture({ mode: 'official_submission', phases: ['standard', 'agent2agent', 'noise'], statuses: ['success', 'failed', 'success'] })
  try { const audit = value.audit(); assert.equal(audit.format_valid, true); assert.equal(audit.coverage_complete, true); assert.equal(audit.evaluation_complete, true); assert.equal(audit.metrics.duplicateRows, 0) }
  finally { cleanup(value.root) }
})

test('phase2 Noise audit requires the native ARE augmentation values and seed', () => {
  const valid = {
    metadata: {
      definition: { has_a2a_augmentation: false, has_tool_augmentation: true, has_env_events_augmentation: true },
      runner_config: {
        tool_augmentation_config: { tool_failure_probability: 0.1, apply_tool_name_augmentation: true, apply_tool_description_augmentation: true },
        env_events_config: { num_env_events_per_minute: 10, env_events_seed: 0 },
      },
    },
  }
  assert.deepEqual(officialNoiseTraceErrors(valid, { phase: 'noise' }), [])
  for (const mutate of [
    trace => { trace.metadata.runner_config.tool_augmentation_config.tool_failure_probability = 0 },
    trace => { trace.metadata.runner_config.env_events_config.env_events_seed = 7 },
    trace => { trace.metadata.definition.has_env_events_augmentation = false },
  ]) {
    const trace = structuredClone(valid); mutate(trace)
    assert.ok(officialNoiseTraceErrors(trace, { phase: 'noise' }).length > 0)
  }
  assert.deepEqual(officialNoiseTraceErrors(valid, { phase: 'standard' }), [])
})

test('phase2 official A2A audit requires an admitted dynamic guard receipt', () => {
  const valid = [{
    type: 'a2a_client_snapshot',
    notificationReaderFactoryBound: true,
    deadlineFactoryBound: true,
    guard: {
      schemaVersion: 'gaia2-official-a2a-guard-binding-v1',
      status: 'bound',
      admissible: true,
      notificationBound: true,
      deadlineBound: true,
    },
  }]
  assert.deepEqual(officialA2ATraceErrors(valid, { phase: 'agent2agent' }), [])
  for (const mutate of [
    events => { events[0].notificationReaderFactoryBound = false },
    events => { events[0].guard.admissible = false },
    events => { events.push(structuredClone(events[0])) },
  ]) {
    const events = structuredClone(valid); mutate(events)
    assert.ok(officialA2ATraceErrors(events, { phase: 'agent2agent' }).length > 0)
  }
  assert.deepEqual(officialA2ATraceErrors([], { phase: 'standard' }), [])
})

function pooledA2AEvents(usedAppIds = ['Calendar', 'Emails']) {
  const identity = { executionId: 'pool-exec', sessionId: 'pool-session', scenarioId: 'pool-scenario' }
  const clients = ['Calendar', 'Emails'].map(appId => ({
    schemaVersion: 'gaia2-official-a2a-client-v1', ...identity, appId,
    scopeHash: null, childActive: false, closed: false,
    modelRequests: usedAppIds.includes(appId) ? 2 : 0, sdkAttempts: usedAppIds.includes(appId) ? 3 : 0,
    notificationReaderFactoryBound: true, deadlineFactoryBound: true,
    guard: usedAppIds.includes(appId) ? {
      schemaVersion: 'gaia2-official-a2a-guard-binding-v1', scopeHash: 'a'.repeat(64),
      status: 'bound', admissible: true, notificationBound: true, deadlineBound: true,
    } : null,
  }))
  return [
    { type: 'official_tool_inventory', tools: clients.map(client => ({ canonicalName: 'AppAgent__expert_agent', appName: client.appId })) },
    { type: 'a2a_client_pool_snapshot', schemaVersion: 'gaia2-official-a2a-client-pool-v1', ...identity,
      status: 'committed', expectedAppIds: ['Calendar', 'Emails'], usedAppIds, clients },
    ...clients.filter(client => usedAppIds.includes(client.appId)).map(client => ({ type: 'a2a_client_snapshot', ...structuredClone(client) })),
  ]
}

test('phase2 multi-App A2A requires one committed pool matching every official wrapper and used guard', () => {
  const identity = { phase: 'agent2agent', executionId: 'pool-exec', scenarioId: 'pool-scenario' }
  assert.deepEqual(officialA2ATraceErrors(pooledA2AEvents(), identity), [])
  assert.deepEqual(officialA2ATraceErrors(pooledA2AEvents(['Calendar']), identity), [])
  for (const mutate of [
    events => { events[1].status = 'preparing' },
    events => { events[1].status = 'failed' },
    events => { events.push(structuredClone(events[1])) },
    events => { events[1].expectedAppIds.reverse() },
    events => { events[1].usedAppIds.push('Calendar') },
    events => { events[0].tools.pop() },
    events => { events[0].tools.push(structuredClone(events[0].tools[0])) },
    events => { events[1].clients[1].appId = 'Calendar' },
    events => { events[1].clients[0].sessionId = 'foreign' },
    events => { events[1].clients[0].childActive = true },
    events => { events[1].clients[0].guard.admissible = false },
    events => { events[1].clients[0].guard.scopeHash = 'bad' },
    events => { events[1].clients[0].deadlineFactoryBound = false },
    events => { events.pop() },
    events => { events.push(structuredClone(events[2])) },
    events => { events[2].sdkAttempts += 1 },
  ]) {
    const events = pooledA2AEvents(); mutate(events)
    assert.ok(officialA2ATraceErrors(events, identity).length > 0)
  }
})

test('phase2 prepared A2A pool can record an evaluated no-delegation failure without inventing a guard', () => {
  const identity = { phase: 'agent2agent', executionId: 'pool-exec', scenarioId: 'pool-scenario' }
  assert.deepEqual(officialA2ATraceErrors(pooledA2AEvents([]), identity), [])
  for (const mutate of [
    events => { events[1].clients[0].modelRequests = 1 },
    events => { events[1].clients[0].sdkAttempts = 1 },
    events => { events[1].clients[0].guard = pooledA2AEvents()[1].clients[0].guard },
    events => { events[1].clients[0].notificationReaderFactoryBound = false },
    events => { events[0].tools = [] },
  ]) {
    const events = pooledA2AEvents([]); mutate(events)
    assert.ok(officialA2ATraceErrors(events, identity).length > 0)
  }
  assert.ok(officialA2ATraceErrors([], identity).length > 0)
})

test('phase2 excluded unknown tools remain explicit and cannot disagree with the full pool inventory', () => {
  const identity = { phase: 'agent2agent', executionId: 'pool-exec', scenarioId: 'pool-scenario' }
  const valid = pooledA2AEvents()
  for (const client of valid[1].clients) {
    client.excludedTools = { schemaVersion: 'gaia2-private-native-excluded-tools-v1', appId: client.appId,
      sourceManifestHash: 'b'.repeat(64), toolCount: client.appId === 'Calendar' ? 1 : 0,
      tools: client.appId === 'Calendar' ? [{ publicName: 'Calendar__unsupported', canonicalName: 'Calendar__unsupported', reasonCode: 'NATIVE_TOOL_EFFECT_UNDECLARED' }] : [] }
    valid.find(event => event.type === 'a2a_client_snapshot' && event.appId === client.appId).excludedTools = structuredClone(client.excludedTools)
  }
  valid[1].excludedTools = [structuredClone(valid[1].clients[0].excludedTools)]
  assert.deepEqual(officialA2ATraceErrors(valid, identity), [])
  for (const mutate of [
    events => { events[1].excludedTools = [] },
    events => { events[1].excludedTools[0].toolCount = 0 },
    events => { delete events[1].excludedTools },
    events => { events[1].clients[0].excludedTools.sourceManifestHash = 'bad' },
    events => { events[1].clients[0].excludedTools.appId = 'foreign' },
    events => { events[1].clients[0].excludedTools.tools[0].reasonCode = 'read' },
    events => { delete events[2].excludedTools },
  ]) {
    const events = structuredClone(valid); mutate(events)
    assert.ok(officialA2ATraceErrors(events, identity).length > 0)
  }
})

test('phase2 missing run_number, malformed JSON, empty output and zero results fail structure', () => {
  for (const mutate of [value => value.updateOutput(rows => { delete rows[0].metadata.run_number }), value => put(value.root, 'standard/execution/output.jsonl', '{\n'), value => put(value.root, 'standard/execution/output.jsonl', '\n')]) {
    const value = fixture()
    try { mutate(value); const audit = value.audit(); assert.equal(audit.format_valid, false); assert.equal(audit.coverage_complete, false); assert.equal(audit.evaluation_complete, false) }
    finally { cleanup(value.root) }
  }
})

test('phase2 technical exception and no-validation retain null score and are not business failures', () => {
  const value = fixture({ statuses: ['exception', 'no_validation'] })
  try {
    const audit = value.audit(); assert.equal(audit.format_valid, true); assert.equal(audit.coverage_complete, true); assert.equal(audit.evaluation_complete, false)
    assert.equal(audit.metrics.technicalCount, 2); assert.equal(audit.metrics.businessFailureCount, 0)
    value.updateOutput(rows => { rows[0].score = 0 }); assert.equal(value.audit().format_valid, false)
  } finally { cleanup(value.root) }
})

test('phase2 absolute, escaping and symbolic trace paths fail closed', () => {
  for (const tracePath of ['C:/foreign/trace.json', '../trace.json', '/tmp/trace.json', 'hf/linked.json']) {
    const value = fixture()
    try {
      if (tracePath.endsWith('linked.json')) { try { symlinkSync(join(value.root, 'hf/execution-0.json'), join(value.root, tracePath)) } catch (error) { if (error.code === 'EPERM') continue; throw error } }
      value.updateOutput(rows => { rows[0].trace_id = tracePath }); assert.equal(value.audit().format_valid, false)
    } finally { cleanup(value.root) }
  }
})

test('phase2 requires complete trace envelope and rejects trace identity changes', () => {
  for (const mutate of [trace => { delete trace.world_logs }, trace => { delete trace.context }, trace => { trace.metadata.definition.run_number = 5 }, trace => { trace.metadata.definition.config = 'search' }]) {
    const value = fixture()
    try { const trace = readJson(join(value.root, 'hf/execution-0.json')); mutate(trace); put(value.root, 'hf/execution-0.json', trace); assert.equal(value.audit().format_valid, false) }
    finally { cleanup(value.root) }
  }
})

test('phase2 changed result bytes, runtime settings, native artifact or session lineage break provenance', () => {
  for (const mutate of [
    value => put(value.root, 'evidence/execution-0/task-result.json', {}),
    value => put(value.root, 'evidence/runtime-settings.json', { concurrency: 9 }),
    value => put(value.root, 'evidence/execution-0/native-output.jsonl', '{}\n'),
    value => value.updateSidecar(sidecar => { sidecar.records[0].sessionId = 'foreign' }),
    value => value.updateSidecar(sidecar => { sidecar.records[0].artifacts[0].sourcePath = '../outside.json' }),
  ]) {
    const value = fixture()
    try { mutate(value); const audit = value.audit(); assert.equal(audit.format_valid, true); assert.equal(audit.coverage_complete, true); assert.equal(audit.evaluation_complete, false) }
    finally { cleanup(value.root) }
  }
})

test('phase2 semantic process and validation mismatches are rejected even after rebinding hashes', () => {
  for (const kind of ['process', 'event', 'artifact', 'state']) {
    const value = fixture()
    try {
      value.updateSidecar(sidecar => {
        const record = sidecar.records[0]
        let ref, contents
        if (kind === 'process') { ref = record.processResult; contents = readJson(join(value.root, ref.path)); contents.loggingError = { code: 'LOG_FAILED' } }
        if (kind === 'event') { ref = record.runtimeEvents; contents = `${JSON.stringify({ type: 'official_validation_completed', executionId: record.executionId, sessionId: record.sessionId, hasException: false, validationSuccess: false })}\n` }
        if (kind === 'artifact') { ref = record.result; contents = readJson(join(value.root, ref.path)); contents.artifacts[0].sha256 = sha('foreign') }
        if (kind === 'state') { ref = sidecar.state; contents = readJson(join(value.root, ref.path)); contents.tasks[0].sessions[0].sessionId = 'foreign' }
        const replacement = put(value.root, ref.path, contents); ref.sha256 = replacement.sha256
        sidecar.files.find(file => file.path === ref.path).sha256 = replacement.sha256
        if (kind === 'artifact') {
          const state = readJson(join(value.root, sidecar.state.path)); state.tasks[0].resultSha256 = replacement.sha256
          const stateRef = put(value.root, sidecar.state.path, state); sidecar.state.sha256 = stateRef.sha256; sidecar.files.find(file => file.path === sidecar.state.path).sha256 = stateRef.sha256
        }
      })
      assert.equal(value.audit().evaluation_complete, false)
    } finally { cleanup(value.root) }
  }
})

test('phase2 can inspect external raw trees but never infers coverage or provenance from them', () => {
  const value = fixture()
  try {
    renameSync(join(value.root, 'run-manifest.json'), join(value.root, 'run-manifest.hidden'))
    renameSync(join(value.root, 'export-manifest.json'), join(value.root, 'export-manifest.hidden'))
    const audit = value.audit(); assert.equal(audit.format_valid, true); assert.equal(audit.coverage_complete, false); assert.equal(audit.evaluation_complete, false)
  } finally { cleanup(value.root) }
})

test('phase2 official reconstruction counts and identities must agree and HF rows bind full trace bytes', () => {
  const value = fixture()
  try {
    const rows = readFileSync(join(value.root, 'standard/execution/output.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    const identities = rows.map(row => ({ phase: row.metadata.phase, config: row.metadata.config, scenarioId: row.task_id, runNumber: row.metadata.run_number, status: row.metadata.status, score: row.score, executionId: row.metadata.execution_id }))
    const hf = rows.map(row => ({ scenario_id: row.task_id, task_id: row.task_id, run_number: row.metadata.run_number, phase_name: row.metadata.phase, config: row.metadata.config, score: row.score, status: row.metadata.status, has_exception: row.metadata.has_exception, data: readFileSync(join(value.root, row.trace_id), 'utf8'), run_type: null, a2a_app_prop: 0, has_app_noise: false, has_env_noise: false, run_config: null, exception_type: null, exception_message: null, rationale: null }))
    const hfRowsPath = '_official/check/hf-rows.jsonl'; put(value.root, hfRowsPath, `${hf.map(row => JSON.stringify(row)).join('\n')}\n`)
    const officialCheck = { status: 'passed', traceValidationPassed: true, hfSchemaValid: true, reconstructedCount: 2, successCount: 1, businessFailureCount: 1, technicalCount: 0, identityRows: identities, hfRowsPath }
    const audit = value.audit({ officialCheck }); assert.equal(audit.format_valid, true); assert.equal(audit.coverage_complete, true); assert.equal(audit.evaluation_complete, true); assert.equal(audit.officialCheckPassed, true)
    assert.equal(value.audit({ officialCheck: { ...officialCheck, reconstructedCount: 1 } }).coverage_complete, false)
    const tracePath = 'hf/execution-0.json', traceText = readFileSync(join(value.root, tracePath), 'utf8')
    put(value.root, tracePath, traceText.replaceAll('\n', '\r\n'))
    assert.equal(value.audit({ officialCheck }).format_valid, true) // ARE's HF text reader normalizes CRLF; original byte SHA remains a separate provenance gate.
    hf[0].has_app_noise = 'false'; put(value.root, hfRowsPath, `${hf.map(row => JSON.stringify(row)).join('\n')}\n`)
    assert.equal(value.audit({ officialCheck }).format_valid, false)
    hf[0].has_app_noise = false
    hf[0].data = '{}'; put(value.root, hfRowsPath, `${hf.map(row => JSON.stringify(row)).join('\n')}\n`)
    assert.equal(value.audit({ officialCheck }).format_valid, false)
  } finally { cleanup(value.root) }
})

test('phase2 malformed provenance remains a diagnostic result rather than an exception', () => {
  for (const mutate of [sidecar => { sidecar.files.push(null) }, sidecar => { sidecar.records.push(null) }, sidecar => { sidecar.state = null }, sidecar => { sidecar.sourceManifest = null }, sidecar => { sidecar.records[0].artifacts.push(null) }]) {
    const value = fixture()
    try { value.updateSidecar(mutate); assert.equal(value.audit().evaluation_complete, false) }
    finally { cleanup(value.root) }
  }
})

test('phase2 source strategy, tracked evidence and unknown output layouts cannot be silently substituted', () => {
  for (const mutate of [
    value => value.updateSidecar(sidecar => { sidecar.strategyHash = sha('foreign') }),
    value => value.updateSidecar(sidecar => { sidecar.files = sidecar.files.filter(file => file.path !== sidecar.records[0].processResult.path) }),
    value => put(value.root, 'other-phase/execution/output.jsonl', '{}\n'),
  ]) {
    const value = fixture()
    try { mutate(value); const audit = value.audit(); assert.equal(audit.evaluation_complete, false) }
    finally { cleanup(value.root) }
  }
})

test('phase2 real historical plans bind captured locks rather than current locks or current executionBinding label', () => {
  const root = mkdtempSync(join(tmpdir(), 'capybara-phase2-audit-'))
  try {
    const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
    const protocol = readJson(join(projectRoot, 'config/phase0-protocol.json'))
    const index = protocol.datasets.source.configs.map(config => ({ datasetKind: 'source', config, id: `${config}-scenario`, path: `data/source/${config}.parquet`, rowIndex: 0, scenarioHash: sha(config), scenarioVersion: 'are_simulation_v1' }))
    const entrypoints = { entries: [{ id: 'old-entry', path: 'scripts/old.mjs', sha256: sha('old-entry') }], environmentOverrides: {} }
    const capturedValues = { protocol, environment: { codeInputs: entrypoints.entries.map(({ path, sha256 }) => ({ path, sha256 })) }, capabilities: {}, dataset: {}, scenarioIndex: `${index.map(row => JSON.stringify(row)).join('\n')}\n` }
    const lockSnapshots = Object.fromEntries(Object.entries(capturedValues).map(([name, value]) => [name, put(root, `provenance/${name}.${name === 'scenarioIndex' ? 'jsonl' : 'json'}`, value)]))
    const lockRefs = Object.fromEntries(Object.entries(lockSnapshots).map(([name, ref]) => [name, { path: `old/${name}`, sha256: ref.sha256 }]))
    const plan = buildRunManifest({ root, protocol, index, lockRefs, entrypoints, runId: 'historical' })
    plan.executionBinding = 'planning_only_pending_phase1_and_phase3'
    const manifest = { ...plan, manifestHash: sha(plan) }
    const runtime = { concurrency: 1, minimal: false }
    const state = { schemaVersion: 'gaia2-run-state-v1', runId: manifest.runId, manifestHash: manifest.manifestHash, runtimeHash: sha(runtime), tasks: manifest.tasks.map(task => ({ executionId: task.executionId, status: 'pending', sessions: [], resultPath: null, resultSha256: null })) }
    const sourceManifest = put(root, 'run-manifest.json', manifest), stateRef = put(root, 'evidence/run-state.json', state), runtimeRef = put(root, 'evidence/runtime-settings.json', runtime)
    const sidecar = { schemaVersion: 'gaia2-export-manifest-v1', sourceRunId: manifest.runId, manifestHash: manifest.manifestHash, mode: manifest.mode, evidenceKind: 'native_runtime', syntheticFixtureOnly: false, runtimeHash: sha(runtime), strategyHash: sha({ policy: manifest.policy, models: manifest.models, correctionOrdinal: 0 }), strategyConsumed: false, sourceManifest, lockSnapshots, state: stateRef, runtimeSettings: runtimeRef, files: [sourceManifest, stateRef, runtimeRef, ...Object.values(lockSnapshots)], records: [], missing: manifest.tasks.map(task => ({ executionId: task.executionId, status: 'pending', category: 'not_executed' })) }
    put(root, 'export-manifest.json', sidecar)
    const audit = auditSubmissionPackage({ packageRoot: root })
    assert.equal(audit.metrics.targetCount, 25); assert.equal(audit.coverage_complete, false)
    assert.ok(!audit.issues.some(issue => ['manifest_schema_invalid', 'captured_plan_reconstruction_mismatch', 'captured_lock_binding_mismatch'].includes(issue.code)))
    sidecar.lockSnapshots.environment = put(root, sidecar.lockSnapshots.environment.path, { codeInputs: [] })
    sidecar.files = sidecar.files.map(ref => ref.path === sidecar.lockSnapshots.environment.path ? sidecar.lockSnapshots.environment : ref)
    put(root, 'export-manifest.json', sidecar)
    assert.ok(auditSubmissionPackage({ packageRoot: root }).issues.some(issue => issue.code === 'captured_lock_binding_mismatch'))
  } finally { cleanup(root) }
})
