import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { digest, fileDigest, readJson } from '../src/phase0_run.mjs'
import { collectRuntimeEvidence, pythonEventHash, validateRuntimeEvidence } from '../src/phase3_runtime_evidence.mjs'
import { auditSubmissionPackage } from '../src/phase2_audit.mjs'
import { exportSubmissionPackage } from '../src/phase2_export.mjs'
import { runtimeFixture } from './support/runtime_evidence_fixture.mjs'

function verify(value, extra = {}) { return validateRuntimeEvidence({ ...value, ...value.collected, readEvidence: path => readFileSync(join(value.root, path)), ...extra }) }
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

test('runtime after-tool result hash, canonical identity and permission cannot disagree with execution', () => {
  for (const mutate of [receipt => { receipt.input.outcome.resultHash = '0'.repeat(64) }, receipt => { receipt.input.action.canonicalName = 'foreign.tool' }, receipt => { receipt.decision.action = 'block' }]) {
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
  put(`${session.outputDir}/process-result.json`, hostProcess)
  put('manifest.json', manifest)
  return { traceRef, nativeRef, result, resultRef, state, row, runtime }
}

function bundleFixture() {
  const value = runtimeFixture({ syntheticFixtureOnly: true }), source = sourceExecution(value), packageRoot = mkdtempSync(join(tmpdir(), 'capybara-runtime-evidence-bundle-'))
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
