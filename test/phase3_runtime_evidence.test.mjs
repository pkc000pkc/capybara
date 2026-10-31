import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { digest, fileDigest, readJson } from '../src/phase0_run.mjs'
import { collectRuntimeEvidence, pythonEventHash, toolEvidenceIdentity, validateRuntimeEvidence, validateTaskReconciliationBindings, validateTaskReconciliationEvents } from '../src/phase3_runtime_evidence.mjs'
import { auditSubmissionPackage } from '../src/phase2_audit.mjs'
import { exportSubmissionPackage } from '../src/phase2_export.mjs'
import { runtimeFixture } from './support/runtime_evidence_fixture.mjs'
import { writeOfficialEntryManifest } from '../src/phase1_official_entry.mjs'
import { verifyPhase6NativeProcessIdentity } from '../src/phase6_process_identity.mjs'

function verify(value, extra = {}) { return validateRuntimeEvidence({ ...value, ...value.collected, readEvidence: path => readFileSync(join(value.root, path)), nativeProcessSourceBytes: value.nativeProcessSourceBytes ?? null, ...extra }) }
function cleanup(root) { assert.ok(root.startsWith(tmpdir()) && root.includes('capybara-runtime-evidence-')); rmSync(root, { recursive: true, force: true }) }
function mutateReceipt(value, index, mutate) {
  const path = value.collected.runtimeAttestation.invocationPaths[index], data = readJson(join(value.root, path)); mutate(data)
  const ref = value.put(path, data)
  value.collected.runtimeEvidence = value.collected.runtimeEvidence.map(item => item.path === path ? ref : item)
  value.collected.runtimeAttestation.evidenceHash = digest(value.collected.runtimeEvidence)
}

test('runtime collector binds typed/persistent/live tool evidence without claiming training or Actor hash reconstruction', () => {
  const value = runtimeFixture()
  try {
    const verified = verify(value)
    assert.equal(verified.realHooksReady, true); assert.equal(verified.invocationCount, 4); assert.equal(verified.toolGateCount, 1)
    assert.equal(verified.typedVariableCount, 2); assert.equal(verified.persistentHarnessCount, 1)
    assert.equal(verified.trainingHooksExecuted, false); assert.equal(verified.actorInputHashReconstructed, false)
  } finally { cleanup(value.root) }
})

test('runtime synthetic fixtures retain realHooksReady=false even with complete evidence', () => {
  const value = runtimeFixture({ syntheticFixtureOnly: true })
  try { assert.equal(verify(value).realHooksReady, false) } finally { cleanup(value.root) }
})

test('runtime migration reads only supplied byte copies, never original absolute evidence paths', () => {
  const value = runtimeFixture(), relocated = mkdtempSync(join(tmpdir(), 'capybara-runtime-evidence-relocated-')), copies = new Map()
  try {
    value.collected.runtimeEvidence.forEach((ref, index) => { const target = join(relocated, `${index}.bytes`); copyFileSync(join(value.root, ref.path), target); copies.set(ref.path, target) })
    cleanup(value.root)
    const summary = verify(value, { readEvidence: sourcePath => readFileSync(copies.get(sourcePath)) })
    assert.equal(summary.realHooksReady, true)
  } finally { cleanup(relocated) }
})

test('runtime receipt SHA corruption and capability source swaps fail closed', () => {
  for (const kind of ['sha', 'source', 'missing']) {
    const value = runtimeFixture()
    try {
      if (kind === 'sha') value.put(value.collected.runtimeAttestation.invocationPaths[0], {})
      if (kind === 'source') { value.collected.runtimeAttestation.sourceFiles[0].sha256 = '0'.repeat(64) }
      if (kind === 'missing') value.collected.runtimeEvidence.pop()
      assert.throws(() => verify(value))
    } finally { cleanup(value.root) }
  }
})

test('runtime semantic invocation defects cannot be hidden by rebinding byte hashes', () => {
  for (const mutate of [receipt => { receipt.executionId = 'foreign' }, receipt => { receipt.variables.gaia2_state = 'not-an-object' }, receipt => { receipt.beforeVariablesHash = '0'.repeat(64) }, receipt => { receipt.context = 'changed' }, receipt => { receipt.hookReceipts[0].matched = false }, receipt => { receipt.hookReceipts[0].status = 'timed_out' }, receipt => { receipt.input.oracle = {} }, receipt => { receipt.input.checkpoint = 'after_evaluation' }]) {
    const value = runtimeFixture()
    try { mutateReceipt(value, 0, mutate); assert.throws(() => verify(value)) } finally { cleanup(value.root) }
  }
})

test('runtime missing Actor injection, foreign events, bypassed tool gates and wrong tool identities fail closed', () => {
  for (const mutate of [events => events.splice(events.findIndex(event => event.type === 'dynamic_context_injected'), 1), events => { events[0].sessionId = 'foreign' }, events => { events.find(event => event.type === 'tool_call_started').callId = 'foreign-call' }, events => { events.find(event => event.type === 'dynamic_context_injected').injectedContextHash = '0'.repeat(64) }, events => { events.find(event => event.type === 'tool_call_completed').status = 'unknown' }, events => events.splice(events.findIndex(event => event.type === 'attempt_execution_ended'), 1)]) {
    const value = runtimeFixture()
    try { mutate(value.events); value.collected.runtimeAttestation.eventsHash = digest(value.events); assert.throws(() => verify(value)) } finally { cleanup(value.root) }
  }
})

test('formal runtime evidence requires the task-reconciliation enablement receipt', () => {
  for (const mutate of [
    inventory => { inventory.taskReconciliationEnabled = false },
    inventory => { inventory.taskReconciliationTool.canonicalName = 'foreign.tool' },
    inventory => { delete inventory.taskReconciliationTool },
  ]) {
    const value = runtimeFixture()
    try {
      const inventory = value.events.find(event => event.type === 'official_tool_inventory')
      assert.ok(inventory)
      mutate(inventory)
      value.collected.runtimeAttestation.eventsHash = digest(value.events)
      assert.throws(() => verify(value), /task_reconciliation_inventory_missing/)
    } finally { cleanup(value.root) }
  }
})

test('formal runtime evidence binds the final actor tool registry to model requests and calls', () => {
  for (const mutate of [
    events => { const inventory = events.find(event => event.type === 'official_tool_inventory'); inventory.tools = []; inventory.toolCount = 0 },
    events => { events.find(event => event.type === 'official_tool_inventory').actorToolCount = 99 },
    events => { events.find(event => event.type === 'official_tool_inventory').actorSchemaSha256 = '0'.repeat(64) },
    events => { events.find(event => event.type === 'model_request').actorSchemaSha256 = '0'.repeat(64) },
    events => { events.find(event => event.type === 'tool_call_started').canonicalName = 'foreign.tool' },
  ]) {
    const value = runtimeFixture()
    try {
      mutate(value.events)
      value.collected.runtimeAttestation.eventsHash = digest(value.events)
      assert.throws(() => verify(value), /official_tool_inventory/)
    } finally { cleanup(value.root) }
  }
})

test('tool evidence identity distinguishes retry attempts while preserving legacy attempt one', () => {
  assert.equal(toolEvidenceIdentity({ callId: 'same-call' }), toolEvidenceIdentity({ callId: 'same-call', attempt: 1 }))
  assert.notEqual(toolEvidenceIdentity({ callId: 'same-call', attempt: 1 }), toolEvidenceIdentity({ callId: 'same-call', attempt: 2 }))
  assert.throws(() => toolEvidenceIdentity({ callId: 'same-call', attempt: 0 }), /invalid_tool_attempt/)
})

test('task-reconciliation telemetry is identity-bound, oracle-free and status-complete', () => {
  const identity = { executionId: 'execution-1', sessionId: 'session-1' }
  const good = { type: 'task_reconciliation_completed', ...identity, callId: 'call-1', turn: 0, status: 'succeeded', mode: 'enforce', reason: null, oracleConsulted: false }
  assert.equal(validateTaskReconciliationEvents([good], identity), 1)
  assert.equal(validateTaskReconciliationEvents([good, { ...good, attempt: 2, turn: 1 }], identity), 2)
  assert.throws(() => validateTaskReconciliationEvents([good, { ...good, attempt: 2 }, { ...good, attempt: 2 }], identity), /task_reconciliation_event_invalid/)
  for (const mutate of [
    event => { event.oracleConsulted = true },
    event => { event.executionId = 'foreign' },
    event => { event.status = 'succeeded'; event.mode = null },
    event => { event.status = 'failed_before_execution'; event.reason = null },
  ]) {
    const value = structuredClone(good); mutate(value)
    assert.throws(() => validateTaskReconciliationEvents([value], identity), /task_reconciliation_event/)
  }
})

test('successful task-reconciliation telemetry binds to its real before/after Hook receipts', () => {
  const action = { id: 'reconcile-call', name: 'capybara_task_reconcile', canonicalName: 'CapybaraTaskContract__review', effect: 'read', resourceKey: 'CapybaraTaskContract', arguments: { op: 'reconcile' } }
  const reconciliationEvent = { type: 'task_reconciliation_completed', executionId: 'execution-1', sessionId: 'session-1', callId: action.id, turn: 0, status: 'succeeded', mode: 'enforce', reason: null, oracleConsulted: false }
  const events = [{ type: 'model_request' }, { type: 'live_hook_completed' }, { type: 'live_hook_completed' }, { type: 'tool_call_started' }, { type: 'tool_call_completed' }, reconciliationEvent]
  const bound = [
    { index: 2, receipt: { input: { checkpoint: 'before_tool', action }, decision: { action: 'allow' } } },
    { index: 4, receipt: { input: { checkpoint: 'after_tool', action, outcome: { status: 'succeeded', executed: true, complete: true, result: { taskReconciliation: { mode: 'enforce' } } } }, decision: { action: 'allow' } } },
  ]
  assert.equal(validateTaskReconciliationBindings(events, bound), 1)
  for (const mutate of [
    event => { event.callId = 'foreign-call' },
    event => { event.mode = 'advisory' },
    (_event, changedBound) => { changedBound[0].receipt.input.action.arguments = { op: 'other' } },
  ]) {
    const changed = structuredClone(events); const changedBound = structuredClone(bound); mutate(changed.at(-1), changedBound)
    assert.throws(() => validateTaskReconciliationBindings(changed, changedBound), /task_reconciliation_(before_tool|after_tool|event_call_binding)/)
  }
})

test('runtime cannot weaken a passed safety hook decision even after rebinding Python events and SHA', () => {
  const value = runtimeFixture()
  try {
    mutateReceipt(value, 1, receipt => {
      receipt.hookReceipts[0].decision.action = 'block'
      value.events.find(event => event.type === 'live_hook_completed' && event.checkpoint === 'before_tool').hookReceiptsHash = pythonEventHash(receipt.hookReceipts)
    })
    value.collected.runtimeAttestation.eventsHash = digest(value.events)
    assert.throws(() => verify(value), /decision_weakened/)
  } finally { cleanup(value.root) }
})

test('runtime after-tool result hash, completeness, canonical identity and permission cannot disagree with execution', () => {
  for (const mutate of [receipt => { receipt.input.outcome.resultHash = '0'.repeat(64) }, receipt => { delete receipt.input.outcome.complete }, receipt => { receipt.input.action.canonicalName = 'foreign.tool' }, receipt => { receipt.decision.action = 'block' }]) {
    const value = runtimeFixture()
    try {
      mutateReceipt(value, 2, receipt => {
        mutate(receipt)
        const event = value.events.find(event => event.type === 'live_hook_completed' && event.checkpoint === 'after_tool')
        event.decision = receipt.decision.action
      })
      value.collected.runtimeAttestation.eventsHash = digest(value.events)
      assert.throws(() => verify(value), /missing_matching_after_tool/)
    } finally { cleanup(value.root) }
  }
})

test('runtime evidence paths reject escapes, absolute paths, foreign sessions and symlinks', () => {
  for (const path of ['../outside', 'C:/outside', '/absolute', 'runs/foreign/evidence.json']) {
    const value = runtimeFixture()
    try { value.collected.runtimeEvidence[0].path = path; value.collected.runtimeAttestation.evidenceHash = digest(value.collected.runtimeEvidence); assert.throws(() => verify(value)) } finally { cleanup(value.root) }
  }
  const value = runtimeFixture()
  try {
    const target = join(value.root, value.session.outputDir, 'hook-host/process-result.json'), link = join(value.root, 'linked')
    mkdirSync(dirname(link), { recursive: true }); symlinkSync(dirname(target), link, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => collectRuntimeEvidence({ ...value, session: { ...value.session, outputDir: 'linked/..' } }))
  } finally { cleanup(value.root) }
})

function sourceExecution(value) {
  const { task, session, manifest, hostProcess, put, collected } = value, runtime = { concurrency: 1, minimal: false }
  const trace = { version: 'are_simulation_v1', world_logs: [], apps: [], events: [], completed_events: [], context: null, augmentation: null, metadata: { definition: { scenario_id: task.scenarioId, run_number: task.runNumber, config: task.config, has_exception: false } } }
  const traceRef = put(`${session.outputDir}/trace.json`, trace)
  const row = { task_id: task.scenarioId, trace_id: 'trace.json', score: 1, metadata: { scenario_id: task.scenarioId, run_number: task.runNumber, phase: task.phase, config: task.config, execution_id: task.executionId, status: 'success', has_exception: false } }
  const nativeRef = put(`${session.outputDir}/output.jsonl`, JSON.stringify(row) + '\n')
  const result = { schemaVersion: 'gaia2-task-result-v1', runId: manifest.runId, manifestHash: manifest.manifestHash, runtimeHash: digest(runtime), executionId: task.executionId, sessionId: session.sessionId, scenarioId: task.scenarioId, runNumber: task.runNumber, phase: task.phase, config: task.config, evaluationComplete: true, businessPassed: true, score: 1, failure: null, process: { exitCode: 0, signal: null, timedOut: false, interrupted: false }, artifacts: [nativeRef, traceRef], runtimeEvidenceRequired: true, ...collected, realHooksReady: false }
  const resultRef = put(`${session.workspaceDir}/task-result.json`, result)
  const state = { schemaVersion: 'gaia2-run-state-v1', runId: manifest.runId, manifestHash: manifest.manifestHash, runtimeHash: digest(runtime), tasks: [{ executionId: task.executionId, status: 'completed', sessions: [session], resultPath: resultRef.path, resultSha256: resultRef.sha256 }] }
  put(manifest.stateFile, state); put(`${manifest.runRoot}/runtime-settings.json`, runtime)
  if (!value.nativeProcess) put(`${session.outputDir}/process-result.json`, hostProcess)
  put('manifest.json', manifest)
  return { traceRef, nativeRef, result, resultRef, state, row, runtime }
}

function bundleFixture({ http = false } = {}) {
  const value = runtimeFixture({ syntheticFixtureOnly: true })
  if (http) attachControlledHttp(value)
  const source = sourceExecution(value), packageRoot = mkdtempSync(join(tmpdir(), 'capybara-runtime-evidence-bundle-'))
  const files = [], copy = (sourcePath, path) => { const target = join(packageRoot, path); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(value.root, sourcePath), target); const ref = { path, sha256: fileDigest(target) }; files.push(ref); return ref }
  const { manifest, task, session } = value, id = task.executionId, prefix = `evidence/${id}`, outputPath = 'standard/execution/output.jsonl'
  const native = copy(source.nativeRef.path, `${prefix}/native-output.jsonl`), trace = copy(source.traceRef.path, `standard/execution/hf/${id}.json`)
  const record = { phase: task.phase, config: task.config, scenarioId: task.scenarioId, runNumber: task.runNumber, executionId: id, sessionId: session.sessionId, result: copy(source.resultRef.path, `${prefix}/task-result.json`), processResult: copy(`${session.outputDir}/process-result.json`, `${prefix}/process-result.json`), runtimeEvents: copy(`${session.outputDir}/runtime-events.jsonl`, `${prefix}/runtime-events.jsonl`), runtimeEvidence: value.collected.runtimeEvidence.map((ref, index) => ({ ...copy(ref.path, `${prefix}/runtime-evidence/${index}.bytes`), sourcePath: ref.path })), artifacts: [{ ...native, sourcePath: source.nativeRef.path }, { ...trace, sourcePath: source.traceRef.path }], trace, outputPath }
  const put = (path, data) => { const ref = value.put(`package-temp/${path}`, data); return copy(ref.path, path) }
  const sidecar = { schemaVersion: 'gaia2-export-manifest-v1', sourceRunId: manifest.runId, manifestHash: manifest.manifestHash, mode: manifest.mode, evidenceKind: 'synthetic_fixture', syntheticFixtureOnly: true, runtimeHash: digest(source.runtime), strategyHash: digest({ policy: manifest.policy, models: manifest.models, correctionOrdinal: 0 }), strategyConsumed: false, sourceManifest: put('run-manifest.json', manifest), lockSnapshots: {}, state: put('evidence/run-state.json', source.state), runtimeSettings: put('evidence/runtime-settings.json', source.runtime), records: [record], missing: [], files }
  put(outputPath, JSON.stringify({ ...source.row, trace_id: trace.path }) + '\n')
  put('export-manifest.json', sidecar)
  cleanup(value.root)
  return { packageRoot, sidecar }
}

// A synthetic byte-level producer fixture: no SDK, network or benchmark score.
function attachControlledHttp(value) {
  const { root, manifest, task, session, put, events } = value
  task.scenarioVersion = 'are_simulation_v1'; task.scenarioHash = 'b'.repeat(64)
  const { manifestHash: _previous, ...contents } = manifest
  manifest.manifestHash = digest(contents)
  const entry = writeOfficialEntryManifest({ root, manifest, task, session })
  const readyPath = `${session.outputDir}/hook-host/ready.json`, ready = readJson(join(root, readyPath))
  ready.entry = { schemaVersion: entry.schemaVersion, relativePath: entry.relativePath, sha256: entry.sha256 }; put(readyPath, ready)
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const lifecyclePath = `${session.outputDir}/hook-host/lifecycle-ready.json`, lifecycle = readJson(join(root, lifecyclePath))
  lifecycle.readySha256 = hash(JSON.stringify(ready)); put(lifecyclePath, lifecycle)
  const nativeProcess = { schemaVersion: 'gaia2-process-result-v1', pid: process.pid + 1000, parentPid: process.pid,
    exitCode: 0, signal: null, timedOut: false, interrupted: false, spawnError: null, loggingError: null, heartbeatError: null,
    childExited: true, childClosed: true, supervisionDetached: false, manualInspectionRequired: false, terminationErrors: [],
    startedAt: '2026-10-13T00:00:00.000Z', childExitedAt: '2026-10-13T00:00:01.000Z', finishedAt: '2026-10-13T00:00:01.010Z', elapsedMs: 1010,
    processIdentity: { platform: 'win32', pid: process.pid + 1000, parentPid: process.pid, birthTime: '2026-10-13T00:00:00.005Z', verified: true } }
  put(`${session.outputDir}/process-result.json`, nativeProcess)
  value.nativeProcess = nativeProcess; value.nativeProcessSourceBytes = readFileSync(join(root, session.outputDir, 'process-result.json'))
  events.unshift({ type: 'official_entry_verified', executionId: task.executionId, sessionId: session.sessionId, scenarioId: task.scenarioId, entrySha256: entry.sha256 })
  const attempt = { modelRole: 'actor', requestId: 'c'.repeat(32), requestAttempt: 1 }
  const at = events.findIndex(event => event.type === 'model_request') + 1
  events.splice(at, 0, ...['model_request_attempt', 'model_request_succeeded'].map(type => ({ type, executionId: task.executionId, sessionId: session.sessionId, ...attempt })))
  put(`${session.outputDir}/runtime-events.jsonl`, events.map(event => JSON.stringify(event)).join('\n') + '\n')
  const common = { runId: manifest.runId, manifestHash: manifest.manifestHash, executionId: task.executionId, sessionId: session.sessionId, scenarioId: task.scenarioId, entrySha256: entry.sha256, pythonProcessId: nativeProcess.pid }
  const records = [
    { type: 'guard_initialized', guardRequired: true, clientFamily: 'httpx2', maxSdkHttpDispatches: 1, sdkMaxRetries: 0 },
    { type: 'sdk_attempt_started', ...attempt },
    { type: 'dispatch_admitted', ...attempt, requestBodyHash: '3'.repeat(64), admittedDispatches: 1 },
    { type: 'dispatch_response', ...attempt, requestBodyHash: '3'.repeat(64), admittedDispatches: 1, responseStatus: 200 },
    { type: 'sdk_attempt_closed', ...attempt, sdkCallStatus: 'succeeded', transportStatus: 'succeeded', admittedDispatches: 1, deniedDispatches: 0, responseCount: 1, clientClosed: true, leaseClosed: true, failureCode: null },
  ]
  let previous = null
  const journal = records.map((fields, index) => {
    const row = { schemaVersion: 'gaia2-model-http-dispatch-v1', ...fields, sequence: index + 1, previousRecordSha256: previous, ...common }
    row.recordSha256 = hash(JSON.stringify(row)); previous = row.recordSha256; return JSON.stringify(row)
  }).join('\n') + '\n'
  put(`${session.outputDir}/model-http-dispatch.jsonl`, journal)
  const copyDir = join(root, session.workspaceDir, 'plugin-runtime-sources')
  assert.ok(copyDir.startsWith(root) && root.startsWith(tmpdir()) && root.includes('capybara-runtime-evidence-'))
  rmSync(copyDir, { recursive: true })
  value.collected = collectRuntimeEvidence({ ...value, modelHttpDispatchRequired: true, modelHttpDispatchProcess: nativeProcess })
  return value
}

test('submission audit validates migrated runtime byte copies independently of official row structure', () => {
  const { packageRoot } = bundleFixture(), relocated = mkdtempSync(join(tmpdir(), 'capybara-runtime-evidence-bundle-relocated-'))
  try {
    cpSync(packageRoot, relocated, { recursive: true }); cleanup(packageRoot)
    const audit = auditSubmissionPackage({ packageRoot: relocated })
    assert.deepEqual([audit.format_valid, audit.coverage_complete, audit.evaluation_complete], [true, true, true], JSON.stringify(audit.issues))
    assert.equal(audit.metrics.runtimeAttestedRows, 1); assert.equal(audit.realHooksReady, false); assert.equal(audit.officialSubmissionReady, false)
    const sidecar = readJson(join(relocated, 'export-manifest.json'))
    assert.equal(sidecar.records[0].artifacts.length, 2)
    const changed = sidecar.records[0].runtimeEvidence[0]
    // The main format and coverage remain valid when a plugin receipt disappears.
    rmSync(join(relocated, changed.path))
    const broken = auditSubmissionPackage({ packageRoot: relocated })
    assert.equal(broken.format_valid, true); assert.equal(broken.coverage_complete, true); assert.equal(broken.evaluation_complete, false)
  } finally { if (existsSync(packageRoot)) cleanup(packageRoot); cleanup(relocated) }
})

test('submission audit cannot downgrade required live hooks or substitute original runtime identities', () => {
  for (const kind of ['drop', 'source', 'foreign']) {
    const { packageRoot } = bundleFixture()
    try {
      const sidecar = readJson(join(packageRoot, 'export-manifest.json')), record = sidecar.records[0]
      if (kind === 'source') record.runtimeEvidence[0].sourcePath = 'runs/foreign/evidence.json'
      else {
        const result = readJson(join(packageRoot, record.result.path))
        if (kind === 'drop') { delete result.runtimeAttestation; delete result.runtimeEvidence; delete result.runtimeEvidenceRequired }
        if (kind === 'foreign') result.runtimeAttestation.sessionId = 'foreign'
        // Rebinding mutable result/state hashes does not bypass the frozen production binding.
        writeFileSync(join(packageRoot, record.result.path), JSON.stringify(result) + '\n')
        record.result.sha256 = fileDigest(join(packageRoot, record.result.path))
        const state = readJson(join(packageRoot, sidecar.state.path)); state.tasks[0].resultSha256 = record.result.sha256
        writeFileSync(join(packageRoot, sidecar.state.path), JSON.stringify(state) + '\n'); sidecar.state.sha256 = fileDigest(join(packageRoot, sidecar.state.path))
        for (const updated of [record.result, sidecar.state]) sidecar.files.find(ref => ref.path === updated.path).sha256 = updated.sha256
      }
      writeFileSync(join(packageRoot, 'export-manifest.json'), JSON.stringify(sidecar) + '\n')
      const audit = auditSubmissionPackage({ packageRoot })
      assert.equal(audit.format_valid, true); assert.equal(audit.coverage_complete, true); assert.equal(audit.evaluation_complete, false)
      assert.ok(audit.issues.some(issue => issue.code === 'runtime_hook_evidence_invalid'))
    } finally { cleanup(packageRoot) }
  }
})

test('export validates live evidence before conversion and does not export a rebound broken receipt', async () => {
  const value = runtimeFixture({ syntheticFixtureOnly: true }), source = sourceExecution(value), outputDir = join(value.root, 'submission')
  try {
    value.put(value.collected.runtimeAttestation.invocationPaths[0], {})
    await assert.rejects(exportSubmissionPackage({ root: value.root, manifestPath: 'manifest.json', outputDir, allowSynthetic: true }), /evidence_sha_mismatch/)
    assert.equal(existsSync(outputDir), false)
  } finally { cleanup(value.root) }
})

test('synthetic HTTP collector binds one audited dispatch and the actual native process generation', () => {
  const value = attachControlledHttp(runtimeFixture({ syntheticFixtureOnly: true }))
  try {
    const summary = verify(value)
    assert.equal(summary.realHooksReady, false)
    assert.equal(summary.modelHttpDispatchVerified, true)
    assert.equal(summary.guardedSdkAttempts, 1)
    assert.equal(summary.admittedHttpDispatches, 1)
    assert.equal(value.collected.runtimeAttestation.modelHttpDispatchProcessPath, `${value.session.outputDir}/process-result.json`)
  } finally { cleanup(value.root) }
})

test('new HTTP byte migration verifies after deletion of the original root without claiming formal results', () => {
  const value = attachControlledHttp(runtimeFixture({ syntheticFixtureOnly: true })), relocated = mkdtempSync(join(tmpdir(), 'capybara-runtime-evidence-http-relocated-')), copies = new Map()
  try {
    value.collected.runtimeEvidence.forEach((ref, index) => { const target = join(relocated, `${index}.bytes`); copyFileSync(join(value.root, ref.path), target); copies.set(ref.path, target) })
    cleanup(value.root)
    const summary = verify(value, { readEvidence: sourcePath => readFileSync(copies.get(sourcePath)) })
    assert.equal(summary.realHooksReady, false); assert.equal(summary.modelHttpDispatchVerified, true)
  } finally { if (existsSync(value.root)) cleanup(value.root); cleanup(relocated) }
})

test('HTTP generation identity rejects cleanup/PID/parent/birth defects after byte SHA rebinding', () => {
  for (const mutate of [
    process => { process.childExited = false }, process => { process.childClosed = false }, process => { process.supervisionDetached = true },
    process => { process.processIdentity.verified = false }, process => { process.processIdentity.pid++ }, process => { process.processIdentity.parentPid++ },
    process => { process.parentPid++ }, process => { delete process.processIdentity.birthTime }, process => { process.processIdentity.birthTime = '2026-10-12T00:00:00.000Z' },
    process => { process.processIdentity.birthTime = '2026-10-13T00:00:02.000Z' }, process => { process.finishedAt = '2026-10-12T00:00:00.000Z' },
  ]) {
    const value = attachControlledHttp(runtimeFixture({ syntheticFixtureOnly: true }))
    try {
      const path = value.collected.runtimeAttestation.modelHttpDispatchProcessPath, process = readJson(join(value.root, path)); mutate(process)
      const ref = value.put(path, process)
      value.nativeProcessSourceBytes = readFileSync(join(value.root, path))
      value.collected.runtimeEvidence = value.collected.runtimeEvidence.map(item => item.path === path ? ref : item)
      value.collected.runtimeAttestation.evidenceHash = digest(value.collected.runtimeEvidence)
      assert.throws(() => verify(value), /Phase 6 process identity:/)
    } finally { cleanup(value.root) }
  }
})

test('HTTP attestation refuses alternate basenames even within the same sealed session', () => {
  for (const field of ['modelHttpDispatchPath', 'modelHttpDispatchProcessPath', 'officialEntryPath']) {
    const value = attachControlledHttp(runtimeFixture({ syntheticFixtureOnly: true }))
    try {
      const attestation = value.collected.runtimeAttestation, original = attestation[field], moved = `${original}.copy`
      copyFileSync(join(value.root, original), join(value.root, moved)); attestation[field] = moved
      value.collected.runtimeEvidence = value.collected.runtimeEvidence.map(ref => ref.path === original ? { ...ref, path: moved } : ref)
      if (field === 'officialEntryPath') {
        const ready = readJson(join(value.root, attestation.readyPath)); ready.entry.relativePath = moved
        const readyRef = value.put(attestation.readyPath, ready)
        const path = attestation.lifecyclePaths.find(path => path.endsWith('/lifecycle-ready.json')), lifecycle = readJson(join(value.root, path))
        lifecycle.readySha256 = createHash('sha256').update(JSON.stringify(ready)).digest('hex')
        const lifecycleRef = value.put(path, lifecycle)
        const updated = new Map([readyRef, lifecycleRef].map(ref => [ref.path, ref]))
        value.collected.runtimeEvidence = value.collected.runtimeEvidence.map(ref => updated.get(ref.path) ?? ref)
      }
      attestation.evidenceHash = digest(value.collected.runtimeEvidence)
      assert.throws(() => verify(value), /http_session_paths_mismatch/)
    } finally { cleanup(value.root) }
  }
})

test('HTTP process source comparison is byte-exact rather than trusting two independently healthy copies', () => {
  const value = attachControlledHttp(runtimeFixture({ syntheticFixtureOnly: true }))
  try {
    assert.throws(() => verify(value, { nativeProcessSourceBytes: Buffer.from(JSON.stringify(value.nativeProcess) + '\n') }), /http_native_process_source_mismatch/)
    assert.throws(() => verify(value, { nativeProcessSourceBytes: 'not-bytes' }), /http_native_process_source_mismatch/)
  } finally { cleanup(value.root) }
})

test('native HTTP identity preserves real Linux startTicks and refuses unknown platforms', () => {
  const value = attachControlledHttp(runtimeFixture({ syntheticFixtureOnly: true }))
  try {
    const process = structuredClone(value.nativeProcess), entry = readJson(join(value.root, value.collected.runtimeAttestation.officialEntryPath))
    process.processIdentity = { platform: 'linux', pid: process.pid, parentPid: process.parentPid, verified: true, startTicks: '12345' }
    assert.equal(verifyPhase6NativeProcessIdentity({ nativeProcess: process, officialEntry: entry, pythonProcessId: process.pid }).startTicks, '12345')
    process.processIdentity.startTicks = '0'; assert.throws(() => verifyPhase6NativeProcessIdentity({ nativeProcess: process, officialEntry: entry, pythonProcessId: process.pid }), /native_process_birth_missing/)
    process.processIdentity.platform = 'darwin'; assert.throws(() => verifyPhase6NativeProcessIdentity({ nativeProcess: process, officialEntry: entry, pythonProcessId: process.pid }), /native_process_platform_unverified/)
  } finally { cleanup(value.root) }
})

test('synthetic submission HTTP archive survives relocation and remains explicitly nonofficial', () => {
  const { packageRoot } = bundleFixture({ http: true }), relocated = mkdtempSync(join(tmpdir(), 'capybara-runtime-evidence-http-bundle-relocated-'))
  try {
    cpSync(packageRoot, relocated, { recursive: true }); cleanup(packageRoot)
    const audit = auditSubmissionPackage({ packageRoot: relocated })
    assert.equal(audit.format_valid, true); assert.equal(audit.evaluation_complete, true, JSON.stringify(audit.issues))
    assert.equal(audit.metrics.runtimeAttestedRows, 1); assert.equal(audit.realHooksReady, false); assert.equal(audit.officialSubmissionReady, false)
  } finally { if (existsSync(packageRoot)) cleanup(packageRoot); cleanup(relocated) }
})

test('migrated HTTP archive rejects a separately rebound healthy processResult copy', () => {
  const { packageRoot } = bundleFixture({ http: true })
  try {
    const sidecar = readJson(join(packageRoot, 'export-manifest.json')), processRef = sidecar.records[0].processResult, process = readJson(join(packageRoot, processRef.path))
    process.pid++; process.processIdentity.pid = process.pid
    writeFileSync(join(packageRoot, processRef.path), JSON.stringify(process) + '\n')
    processRef.sha256 = fileDigest(join(packageRoot, processRef.path)); sidecar.files.find(ref => ref.path === processRef.path).sha256 = processRef.sha256
    writeFileSync(join(packageRoot, 'export-manifest.json'), JSON.stringify(sidecar) + '\n')
    const audit = auditSubmissionPackage({ packageRoot })
    assert.equal(audit.format_valid, true); assert.equal(audit.evaluation_complete, false)
    assert.ok(audit.issues.some(issue => issue.code === 'runtime_hook_evidence_invalid'))
  } finally { cleanup(packageRoot) }
})
