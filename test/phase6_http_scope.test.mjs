import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { digest } from '../src/phase0_run.mjs'
import { verifyPhase6HttpScope } from '../src/phase6_http_evidence.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const jsonBytes = value => Buffer.from(JSON.stringify(value) + '\n')

// HTTP-only synthetic bytes. No ARE trace, native judgment, SDK or model exists.
// evaluationComplete is solely the input contract needed to exercise this
// narrow HTTP reader; score=null/realHooksReady=false prohibit formal acceptance.
function fixture({ phase = 'standard' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'capybara-http-scope-'))
  const runRoot = 'runs/http-only-synthetic', runId = 'http-only-synthetic'
  const task = { executionId: 'http-only-execution', scenarioId: 'http-only-scenario', scenarioVersion: 'are_simulation_v1', scenarioHash: 'b'.repeat(64),
    phase, config: phase === 'standard' ? 'execution' : 'mini', runNumber: 1, attemptIndex: 1, correctionOrdinal: 0,
    outputDir: `${runRoot}/executions/http-only-execution`, workspaceDir: `${runRoot}/workspaces/http-only-execution`, fixtureDir: `${runRoot}/fixtures/http-only-execution` }
  const manifest = { schemaVersion: 'gaia2-phase6-http-only-fixture-v1', syntheticFixtureOnly: true, runId, runRoot, stateFile: `${runRoot}/run-state.json`,
    manifestHash: 'a'.repeat(64), planFingerprint: 'f'.repeat(64), tasks: [task] }
  const session = { sessionId: '0001-aaaaaaaaaaaa', sessionOrdinal: 1, parentSessionId: null,
    ...Object.fromEntries(['outputDir', 'workspaceDir', 'fixtureDir'].map(field => [field, `${task[field]}/sessions/0001-aaaaaaaaaaaa`])) }
  const identity = { runId, manifestHash: manifest.manifestHash, executionId: task.executionId, sessionId: session.sessionId, scenarioId: task.scenarioId }
  const runtime = { syntheticFixtureOnly: true, httpOnly: true, noModelExecution: true }
  const entry = { schemaVersion: 'gaia2-official-entry-handshake-v1', ...identity, scenarioVersion: task.scenarioVersion, scenarioHash: task.scenarioHash,
    config: task.config, runNumber: task.runNumber, attemptIndex: task.attemptIndex, correctionOrdinal: task.correctionOrdinal, phase: task.phase, launcherProcessId: 100 }
  const process = { schemaVersion: 'gaia2-process-result-v1', pid: 101, parentPid: 100, exitCode: 0, signal: null, timedOut: false, interrupted: false,
    spawnError: null, loggingError: null, heartbeatError: null, manualInspectionRequired: false, childExited: true, childClosed: true, supervisionDetached: false, terminationErrors: [],
    startedAt: '2026-10-13T01:00:00.000Z', childExitedAt: '2026-10-13T01:00:01.000Z', finishedAt: '2026-10-13T01:00:01.010Z', elapsedMs: 1010,
    processIdentity: { platform: 'win32', pid: 101, parentPid: 100, birthTime: '2026-10-13T01:00:00.005Z', verified: true } }
  const attempt = { modelRole: 'actor', requestId: 'c'.repeat(32), requestAttempt: 1 }
  const events = ['model_request_attempt', 'model_request_succeeded'].map(type => ({ type, executionId: task.executionId, sessionId: session.sessionId, ...attempt }))
  const attestation = { schemaVersion: 'gaia2-runtime-attestation-v1', ...identity, runNumber: task.runNumber, phase, config: task.config,
    modelHttpDispatchRequired: true, modelHttpDispatchPath: `${session.outputDir}/model-http-dispatch.jsonl`,
    modelHttpDispatchProcessPath: `${session.outputDir}/process-result.json`, officialEntryPath: `${session.outputDir}/official-entry/run-manifest.json` }
  const result = { schemaVersion: 'gaia2-task-result-v1', ...identity, runtimeHash: digest(runtime), syntheticFixtureOnly: true,
    evidenceKind: 'http_only_synthetic_not_native_result', evaluationComplete: true, score: null, businessPassed: null, realHooksReady: false,
    runtimeAttestation: attestation, runtimeEvidence: [] }
  const record = { executionId: task.executionId, status: 'completed', sessions: [session], resultPath: `${session.workspaceDir}/task-result.json`, resultSha256: null }
  const state = { schemaVersion: 'gaia2-run-state-v1', runId, manifestHash: manifest.manifestHash, runtimeHash: digest(runtime), tasks: [record] }
  const value = { root, manifest, task, session, runtime, entry, process, events, attestation, result, record, state, attempt }
  const put = (path, bytes) => {
    const absolute = resolve(root, path)
    assert.ok(absolute.startsWith(resolve(root) + '\\') || absolute.startsWith(resolve(root) + '/'), 'fixture write escapes its temporary root')
    mkdirSync(dirname(absolute), { recursive: true }); writeFileSync(absolute, bytes)
    return { path, sha256: sha(bytes) }
  }
  value.saveResult = () => {
    record.resultSha256 = put(record.resultPath, jsonBytes(result)).sha256
    put(manifest.stateFile, jsonBytes(state))
  }
  value.seal = () => {
    const entryRef = put(attestation.officialEntryPath, jsonBytes(entry)), processRef = put(attestation.modelHttpDispatchProcessPath, jsonBytes(process))
    const records = [
      { type: 'guard_initialized', guardRequired: true, clientFamily: 'httpx2', maxSdkHttpDispatches: 1, sdkMaxRetries: 0 },
      { type: 'sdk_attempt_started', ...attempt },
      { type: 'dispatch_admitted', ...attempt, requestBodyHash: 'd'.repeat(64), admittedDispatches: 1 },
      { type: 'dispatch_response', ...attempt, requestBodyHash: 'd'.repeat(64), admittedDispatches: 1, responseStatus: 200 },
      { type: 'sdk_attempt_closed', ...attempt, sdkCallStatus: 'succeeded', transportStatus: 'succeeded', admittedDispatches: 1, deniedDispatches: 0,
        responseCount: 1, clientClosed: true, leaseClosed: true, failureCode: null },
    ]
    let previous = null
    const journal = records.map((fields, index) => {
      const row = { schemaVersion: 'gaia2-model-http-dispatch-v1', ...fields, sequence: index + 1, previousRecordSha256: previous,
        ...identity, entrySha256: entryRef.sha256, pythonProcessId: process.pid }
      row.recordSha256 = sha(JSON.stringify(row)); previous = row.recordSha256; return JSON.stringify(row)
    }).join('\n') + '\n'
    const journalRef = put(attestation.modelHttpDispatchPath, Buffer.from(journal))
    put(`${session.outputDir}/runtime-events.jsonl`, Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n'))
    put(`${manifest.runRoot}/runtime-settings.json`, jsonBytes(runtime)); put(`${manifest.runRoot}/run-manifest.json`, jsonBytes(manifest))
    result.runtimeEvidence = [entryRef, processRef, journalRef]
    Object.assign(attestation, { officialEntrySha256: entryRef.sha256, modelHttpDispatchSha256: journalRef.sha256, modelHttpDispatchProcessId: process.pid,
      evidenceHash: digest(result.runtimeEvidence), eventsHash: digest(events) })
    value.saveResult()
  }
  value.verify = () => verifyPhase6HttpScope({ root, manifest, state: JSON.parse(readFileSync(join(root, manifest.stateFile), 'utf8')), executionIds: [task.executionId] })
  value.seal()
  return value
}

function cleanup(root) {
  const absolute = resolve(root), base = resolve(tmpdir()), local = relative(base, absolute)
  assert.ok(local && !local.startsWith('..') && !local.includes('/') && !local.includes('\\') && local.startsWith('capybara-http-scope-'))
  rmSync(absolute, { recursive: true, force: true })
}
function checked(change, pattern = /Phase 6 (?:HTTP evidence|process identity):/) {
  const value = fixture()
  try { change(value); value.seal(); assert.throws(value.verify, pattern) } finally { cleanup(value.root) }
}

test('file-backed HTTP-only synthetic scope binds current evidence without claiming native judgment or scope-gate success', () => {
  const value = fixture()
  try {
    const report = value.verify()
    assert.equal(report.status, 'passed'); assert.equal(report.officialSubmissionReady, false); assert.equal(report.noModelExecution, true)
    assert.equal(value.manifest.syntheticFixtureOnly, true); assert.equal(value.result.score, null); assert.equal(value.result.realHooksReady, false)
    assert.equal(report.counts.attempts, 1); assert.equal(report.counts.admittedDispatches, 1); assert.equal(report.counts.responseCount, 1)
    assert.deepEqual(report.scope.executionIds, [value.task.executionId])
    assert.equal(report.binding.selectionIdentityHash, digest({ manifestHash: value.manifest.manifestHash, executionIds: [value.task.executionId] }))
    assert.equal(report.rows[0].pythonProcessId, value.process.pid); assert.equal(report.rows[0].physicalPacketCountClaimed, false)
  } finally { cleanup(value.root) }
})

test('normal noise phase remains supported by the strict official entry task contract', () => {
  const value = fixture({ phase: 'noise' })
  try { const report = value.verify(); assert.equal(report.status, 'passed'); assert.equal(report.officialSubmissionReady, false) } finally { cleanup(value.root) }
})

test('Windows native frozen manifest directories bind portable session and evidence identities', () => {
  const value = fixture()
  try {
    // Seal first, then emulate Windows path.join in the trusted manifest only.
    // The opaque fixture hash is not a claim of a full frozen-manifest audit.
    value.manifest.runRoot = value.manifest.runRoot.replaceAll('/', '\\')
    for (const field of ['outputDir', 'workspaceDir', 'fixtureDir']) value.task[field] = value.task[field].replaceAll('/', '\\')
    assert.ok(value.session.outputDir.includes('/') && !value.session.outputDir.includes('\\'))
    assert.ok(value.result.runtimeEvidence.every(ref => !ref.path.includes('\\')))
    const report = value.verify()
    assert.equal(report.status, 'passed'); assert.equal(report.officialSubmissionReady, false)
  } finally { cleanup(value.root) }
})

test('HTTP scope rejects a rebound task-result alternate basename rather than accepting any run-local result', () => {
  checked(value => { value.record.resultPath += '.copy' })
})

test('HTTP scope rejects rebound current-session directories that differ from frozen task layout', () => {
  for (const field of ['outputDir', 'workspaceDir', 'fixtureDir']) checked(value => {
    value.session[field] = value.session[field].replace('/sessions/', '/foreign-sessions/')
    if (field === 'outputDir') {
      value.attestation.modelHttpDispatchPath = `${value.session.outputDir}/model-http-dispatch.jsonl`
      value.attestation.modelHttpDispatchProcessPath = `${value.session.outputDir}/process-result.json`
      value.attestation.officialEntryPath = `${value.session.outputDir}/official-entry/run-manifest.json`
    } else if (field === 'workspaceDir') value.record.resultPath = `${value.session.workspaceDir}/task-result.json`
  })
})

for (const field of ['modelHttpDispatchPath', 'modelHttpDispatchProcessPath', 'officialEntryPath']) {
  test(`HTTP scope rejects same-session alternate basename: ${field}`, () => checked(value => { value.attestation[field] += '.copy' }, /http_session_paths_mismatch/))
  test(`HTTP scope rejects foreign-session evidence even with all SHA bindings rebuilt: ${field}`, () => checked(value => {
    value.attestation[field] = value.attestation[field].replace(value.session.sessionId, '0001-bbbbbbbbbbbb')
  }, /http_session_paths_mismatch/))
}

for (const [name, change, pattern] of [
  ['native PID differs from observed generation', value => { value.process.pid++ }, /native_process_generation_binding/],
  ['native parent differs from launcher', value => { value.process.parentPid++ }, /native_process_pid_binding/],
  ['observed parent differs from native parent', value => { value.process.processIdentity.parentPid++ }, /native_process_generation_binding/],
  ['observed PID differs from native PID', value => { value.process.processIdentity.pid++ }, /native_process_generation_binding/],
  ['unverified process generation', value => { value.process.processIdentity.verified = false }, /native_process_generation_binding/],
  ['missing birth timestamp', value => { delete value.process.processIdentity.birthTime }, /native_process_birth_missing/],
  ['old recycled-PID birth', value => { value.process.processIdentity.birthTime = '2026-10-12T01:00:00.000Z' }, /native_process_birth_missing/],
  ['birth after exit', value => { value.process.processIdentity.birthTime = '2026-10-13T01:00:02.000Z' }, /native_process_birth_missing/],
  ['child not exited', value => { value.process.childExited = false }, /native_process_cleanup/],
  ['child pipes not closed', value => { value.process.childClosed = false }, /native_process_cleanup/],
  ['supervision detached', value => { value.process.supervisionDetached = true }, /native_process_cleanup/],
  ['termination error retained', value => { value.process.terminationErrors = ['synthetic_cleanup_failure'] }, /native_process_cleanup/],
  ['manual inspection still required', value => { value.process.manualInspectionRequired = true }, /native_process_cleanup/],
  ['SDK child timeout not cleared', value => { value.process.timedOut = true }, /native_process_cleanup/],
  ['native child nonzero exit', value => { value.process.exitCode = 1 }, /native_process_cleanup/],
]) test(`HTTP scope rejects rebound ${name}`, () => checked(change, pattern))

for (const field of ['scenarioHash', 'scenarioVersion', 'attemptIndex', 'correctionOrdinal']) {
  test(`HTTP scope rejects missing entry ${field} after journal/refs/result rebinding`, () => checked(value => { delete value.entry[field] }, /entry_fields/))
  test(`HTTP scope rejects changed entry ${field} after journal/refs/result rebinding`, () => checked(value => {
    value.entry[field] = field === 'scenarioHash' ? 'e'.repeat(64) : field === 'scenarioVersion' ? 'foreign_version' : value.entry[field] + 1
  }, /entry_task_identity/))
}

for (const [name, change, pattern] of [
  ['foreign result session', value => { value.result.sessionId = '0001-bbbbbbbbbbbb' }, /result_or_http_binding/],
  ['foreign attestation session', value => { value.attestation.sessionId = '0001-bbbbbbbbbbbb' }, /http_attestation_identity/],
  ['foreign entry session', value => { value.entry.sessionId = '0001-bbbbbbbbbbbb' }, /entry_identity/],
  ['foreign entry run', value => { value.entry.runId = 'foreign-run' }, /entry_identity/],
  ['foreign entry execution', value => { value.entry.executionId = 'foreign-execution' }, /entry_identity/],
  ['foreign entry scenario', value => { value.entry.scenarioId = 'foreign-scenario' }, /entry_identity/],
  ['foreign entry manifest', value => { value.entry.manifestHash = 'e'.repeat(64) }, /entry_identity/],
  ['wrong entry runNumber', value => { value.entry.runNumber++ }, /entry_task_identity/],
  ['wrong entry config', value => { value.entry.config = 'search' }, /entry_task_identity/],
  ['wrong entry phase', value => { value.entry.phase = 'noise' }, /entry_task_identity/],
  ['wrong entry launcher', value => { value.entry.launcherProcessId++ }, /native_process_pid_binding/],
  ['foreign state run', value => { value.state.runId = 'foreign-run' }, /state_binding/],
  ['foreign state manifest', value => { value.state.manifestHash = 'e'.repeat(64) }, /state_binding/],
  ['wrong runtime file', value => { value.runtime.extraChangedSetting = true }, /runtime_binding/],
  ['wrong state runtime hash', value => { value.state.runtimeHash = 'e'.repeat(64) }, /runtime_binding/],
  ['wrong result runtime hash', value => { value.result.runtimeHash = 'e'.repeat(64) }, /result_or_http_binding/],
  ['uncompleted record', value => { value.record.status = 'running' }, /selected_not_completed/],
  ['foreign event session', value => { value.events[0].sessionId = '0001-bbbbbbbbbbbb' }, /foreign_runtime_event/],
  ['HTTP guard not required', value => { value.attestation.modelHttpDispatchRequired = false }, /result_or_http_binding/],
]) test(`HTTP scope rejects rebound ${name}`, () => checked(change, pattern))

for (const [name, change, pattern] of [
  ['wrong result bytes SHA', value => { value.record.resultSha256 = 'e'.repeat(64) }, /result_hash/],
  ['wrong evidence inventory hash', value => { value.attestation.evidenceHash = 'e'.repeat(64) }, /runtime_inventory_binding/],
  ['wrong events hash', value => { value.attestation.eventsHash = 'e'.repeat(64) }, /http_events_binding/],
  ['wrong entry SHA', value => { value.attestation.officialEntrySha256 = 'e'.repeat(64) }, /official_entry_hash_binding/],
  ['wrong journal SHA', value => { value.attestation.modelHttpDispatchSha256 = 'e'.repeat(64) }, /http_journal_hash_binding/],
  ['wrong required evidence ref SHA', value => { value.result.runtimeEvidence[0].sha256 = 'e'.repeat(64); value.attestation.evidenceHash = digest(value.result.runtimeEvidence) }, /unbound_http_reference/],
  ['duplicate ref', value => { value.result.runtimeEvidence.push({ ...value.result.runtimeEvidence[0] }); value.attestation.evidenceHash = digest(value.result.runtimeEvidence) }, /duplicate_runtime_reference/],
  ['missing process ref', value => { value.result.runtimeEvidence = value.result.runtimeEvidence.filter(ref => ref.path !== value.attestation.modelHttpDispatchProcessPath); value.attestation.evidenceHash = digest(value.result.runtimeEvidence) }, /unbound_http_reference/],
  ['malformed ref hash', value => { value.result.runtimeEvidence[0].sha256 = 'not-a-hash' }, /runtime_refs_invalid/],
]) test(`HTTP scope rejects ${name} independently of saved passed flags`, () => {
  const value = fixture()
  try {
    change(value)
    if (name !== 'wrong result bytes SHA') value.saveResult()
    else writeFileSync(join(value.root, value.manifest.stateFile), jsonBytes(value.state))
    assert.throws(value.verify, pattern)
  } finally { cleanup(value.root) }
})

test('HTTP-only scope reading uses a moved root and its byte copies, not original absolute paths', () => {
  const value = fixture(), relocated = mkdtempSync(join(tmpdir(), 'capybara-http-scope-relocated-'))
  try {
    // Copy only the files this narrow reader consumes; no trace or native score.
    for (const path of [value.manifest.stateFile, `${value.manifest.runRoot}/runtime-settings.json`, value.record.resultPath,
      `${value.session.outputDir}/runtime-events.jsonl`, ...value.result.runtimeEvidence.map(ref => ref.path)]) {
      const target = join(relocated, path); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(value.root, path), target)
    }
    cleanup(value.root)
    const report = verifyPhase6HttpScope({ root: relocated, manifest: value.manifest, state: JSON.parse(readFileSync(join(relocated, value.manifest.stateFile), 'utf8')), executionIds: [value.task.executionId] })
    assert.equal(report.status, 'passed'); assert.equal(report.officialSubmissionReady, false)
  } finally { cleanup(relocated); cleanup(value.root) }
})
