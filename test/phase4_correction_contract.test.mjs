import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { digest, fileDigest } from '../src/phase0_run.mjs'
import { pythonEventHash } from '../src/phase3_runtime_evidence.mjs'
import { CORRECTION_CONTRACT, deriveCorrectionEvidence, parseCorrectionPlan, renderTrustedCorrection, verifyInitialEvaluation } from '../src/phase4_correction_contract.mjs'
import { runtimeFixture } from './support/runtime_evidence_fixture.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')

// This is an evidence fixture, never a benchmark execution or real model call.
export function correctionFixture({ kind = 'none', passed = false, blockReason = 'invalid_action', terminationReason = 'conversation_turn_limit', windowsPaths = false } = {}) {
  const f = runtimeFixture(), { root, task, session, put } = f
  const { manifestHash: _, ...base } = f.manifest
  base.schemaVersion = 'gaia2-run-manifest-v1'
  if (windowsPaths) { base.stateFile = base.stateFile.replaceAll('/', '\\'); base.runRoot = base.runRoot.replaceAll('/', '\\') }
  const manifest = { ...base, manifestHash: digest(base) }
  const directory = join(root, session.workspaceDir, 'plugin-runtime')
  let calls = readdirSync(directory).map(name => ({ path: `${session.workspaceDir}/plugin-runtime/${name}`, value: JSON.parse(readFileSync(join(directory, name), 'utf8')) })).filter(item => item.value.schemaVersion === 'capybara-runtime-plugin-invocation-v1')
  const events = structuredClone(f.events)
  const before = calls.find(item => item.value.input.checkpoint === 'before_tool').value
  const after = calls.find(item => item.value.input.checkpoint === 'after_tool').value
  // Deliberately sensitive, visible runtime values; only their hashes may leave.
  calls[0].value.input.messages = [{ role: 'user', content: 'LATE_USER_ANSWER_SENTINEL_DO_NOT_REPLAY' }]
  calls[0].value.input.clock = { now: 987654.125 }
  before.input.action.arguments = { recordId: 'OLD_RECORD_ID_SENTINEL', text: 'RAW_TOOL_CONTENT_SENTINEL' }
  after.input.action = structuredClone(before.input.action)
  if (kind === 'read_failed') { after.input.outcome.status = 'failed_before_execution'; events.find(event => event.type === 'tool_call_completed').status = 'failed_before_execution' }
  if (['write_unverified', 'unknown_write_requires_readback'].includes(kind)) {
    for (const call of [before, after]) Object.assign(call.input.action, { effect: 'write', authoritativeRead: false, resourceKey: 'SECRET_RESOURCE_RECORD_ID', mutationKey: 'SECRET_MUTATION_RECORD_ID', idempotent: false })
    events.find(event => event.type === 'tool_call_started').effect = 'write'
    if (kind === 'unknown_write_requires_readback') { after.input.outcome.status = 'unknown'; events.find(event => event.type === 'tool_call_completed').status = 'unknown' }
  }
  if (kind === 'multi_tool_response_rejected') {
    const at = events.findIndex(event => event.type === 'model_request')
    events.splice(at + 1, 0, { ...events[at], type: 'model_response', toolCallCount: 2, hasContent: false })
    const start = events.find(event => event.type === 'tool_call_started')
    start.type = 'tool_call_blocked'; start.reason = blockReason
    const complete = events.findIndex(event => event.type === 'tool_call_completed'); events.splice(complete, 1)
    const completion = events.findIndex(event => event.type === 'live_hook_completed' && event.checkpoint === 'after_tool'); events.splice(completion, 1)
    const removed = calls.find(item => item.value.input.checkpoint === 'after_tool'); unlinkSync(join(root, removed.path))
    calls = calls.filter(item => item !== removed)
    const last = calls.at(-1); unlinkSync(join(root, last.path)); last.path = `${session.workspaceDir}/plugin-runtime/000004-attempt_end.json`; last.value.sequence = 4
  }
  for (const item of calls) {
    put(item.path, item.value)
    const event = events.find(event => event.type === 'live_hook_completed' && event.checkpoint === item.value.input.checkpoint)
    event.hookReceiptsHash = pythonEventHash(item.value.hookReceipts)
  }
  events.find(event => event.type === 'attempt_execution_ended').terminationReason = terminationReason
  events.find(event => event.type === 'official_validation_completed').validationSuccess = passed
  put(`${session.outputDir}/runtime-events.jsonl`, events.map(event => JSON.stringify(event)).join('\n') + '\n')
  const runtimeEvidence = [...f.collected.runtimeEvidence.filter(ref => !f.collected.runtimeAttestation.invocationPaths.includes(ref.path)), ...calls.map(item => ({ path: item.path, sha256: fileDigest(join(root, item.path)) }))]
  const runtimeAttestation = { ...f.collected.runtimeAttestation, manifestHash: manifest.manifestHash, eventsHash: digest(events), evidenceHash: digest(runtimeEvidence), invocationPaths: calls.map(item => item.path), summary: { ...f.collected.runtimeAttestation.summary, invocationCount: calls.length } }
  const collected = { runtimeEvidence, runtimeAttestation }
  const process = { ...f.hostProcess, childExited: true, childClosed: true }
  put(`${session.outputDir}/process-result.json`, process)
  const runtime = { processTimeoutMs: 0 }
  put(`${manifest.runRoot.replaceAll('\\', '/')}/runtime-settings.json`, runtime)
  const tracePath = `${session.outputDir}/hf/trace.json`, nativePath = `${session.outputDir}/output.jsonl`
  const traceRef = put(tracePath, { world_logs: [], apps: [], events: [], completed_events: [], version: 'fixture', context: {}, augmentation: null, metadata: { definition: { scenario_id: task.scenarioId, run_number: task.runNumber, has_exception: false } } })
  const nativeRef = put(nativePath, JSON.stringify({ task_id: task.scenarioId, trace_id: 'hf/trace.json', score: passed ? 1 : 0, metadata: { scenario_id: task.scenarioId, run_number: task.runNumber, status: passed ? 'success' : 'failed', has_exception: false } }) + '\n')
  const result = { schemaVersion: 'gaia2-task-result-v1', runId: manifest.runId, manifestHash: manifest.manifestHash, runtimeHash: digest(runtime), sessionId: session.sessionId, ...Object.fromEntries(['executionId', 'scenarioId', 'phase', 'config', 'runNumber'].map(key => [key, task[key]])), evaluationComplete: true, businessPassed: passed, score: passed ? 1 : 0, failure: passed ? null : { category: 'business_failure', retryable: false }, process: { exitCode: 0, signal: null, timedOut: false, interrupted: false }, artifacts: [nativeRef, traceRef], runtimeEvidenceRequired: true, realHooksReady: true, ...collected }
  const resultRef = put(`${session.workspaceDir}/task-result.json`, result)
  const storedSession = windowsPaths ? { ...session, ...Object.fromEntries(['outputDir', 'fixtureDir', 'workspaceDir'].map(key => [key, session[key].replaceAll('/', '\\')])) } : session
  put(manifest.stateFile.replaceAll('\\', '/'), { schemaVersion: 'gaia2-run-state-v1', runId: manifest.runId, manifestHash: manifest.manifestHash, runtimeHash: result.runtimeHash, tasks: [{ executionId: task.executionId, status: 'completed', sessions: [storedSession], resultPath: windowsPaths ? resultRef.path.replaceAll('/', '\\') : resultRef.path, resultSha256: resultRef.sha256, failure: result.failure }] })
  return { root, manifest, task, session: storedSession, result, events, put, readEvidence: path => readFileSync(join(root, path)) }
}

const candidate = evidence => ({ schemaVersion: 'gaia2-correction-plan-v1', ...Object.fromEntries(['defectCode', 'procedureIds', 'verificationIds', 'evidenceHash'].map(key => [key, evidence.sealed.observableSummary.defects[0][key]])) })

test('Phase 4 eligibility requires independent native/runtime proof; business failure alone has no defect', () => {
  const input = correctionFixture(), verified = verifyInitialEvaluation(input), evidence = deriveCorrectionEvidence(input)
  assert.deepEqual(verified.valid, { runtimeProof: true, evaluationComplete: true })
  assert.equal(evidence.eligible, true); assert.equal(evidence.trainingAllowed, false)
  assert.equal(evidence.reason, 'no_observable_defect')
  assert.throws(() => parseCorrectionPlan({ candidate: {}, evidence }), /ineligible_training_input/)
})

test('Phase 4 derives only four source-provable enum defects and never leaks runtime text/IDs/time', () => {
  for (const kind of CORRECTION_CONTRACT.defectCodes) {
    const input = correctionFixture({ kind }), evidence = deriveCorrectionEvidence(input)
    assert.equal(evidence.trainingAllowed, true, kind)
    assert.equal(evidence.sealed.observableSummary.defects[0].defectCode, kind)
    assert.equal(evidence.sealed.observableSummary.defects[0].count, 1)
    const serialized = JSON.stringify(evidence.sealed.observableSummary)
    for (const secret of ['LATE_USER_ANSWER_SENTINEL', 'OLD_RECORD_ID_SENTINEL', 'RAW_TOOL_CONTENT_SENTINEL', 'SECRET_RESOURCE_RECORD_ID', 'SECRET_MUTATION_RECORD_ID', '987654.125']) assert.ok(!serialized.includes(secret), kind)
    const plan = parseCorrectionPlan({ candidate: candidate(evidence), evidence }), rendered = renderTrustedCorrection(plan)
    assert.equal(rendered.strategyHash, sha(rendered.strategyText))
    assert.equal(rendered.freshReplayRequired, true); assert.equal(rendered.attemptCountDelta, 0)
    assert.equal(Object.isFrozen(plan), true); assert.equal(Object.isFrozen(evidence.sealed.observableSummary), true)
  }
})

test('Phase 4 rejects technical, missing evaluation, absent proof and tampered native/source evidence', () => {
  const technical = correctionFixture({ kind: 'read_failed' })
  Object.assign(technical.result, { evaluationComplete: false, score: null, businessPassed: null })
  technical.readEvidence = () => { throw new Error('must not start training or read technical evidence') }
  assert.equal(deriveCorrectionEvidence(technical).trainingAllowed, false)
  for (const alter of [
    input => { input.result.runtimeEvidence = [] },
    input => { input.result.artifacts[0].sha256 = '0'.repeat(64) },
    input => { input.put(input.result.runtimeEvidence[0].path, 'tampered') },
    input => { input.events.at(-1).validationSuccess = true },
  ]) {
    const input = correctionFixture({ kind: 'read_failed' }); alter(input)
    assert.equal(deriveCorrectionEvidence(input).trainingAllowed, false)
    assert.throws(() => verifyInitialEvaluation(input))
  }
  assert.equal(deriveCorrectionEvidence(correctionFixture({ passed: true })).reason, 'business_success')
})

test('Phase 4 candidate has no unknown fields, free text, answers, variable patch, missing method or fabricated defects', () => {
  const evidence = deriveCorrectionEvidence(correctionFixture({ kind: 'read_failed' }))
  const good = candidate(evidence)
  for (const bad of [
    { ...good, answer: 'MODEL_GUESSED_ANSWER' }, { ...good, strategy: 'free-form reasoning' },
    { ...good, variables: { gaia2_experiment_context: 'overwrite readonly' } },
    { ...good, defectCode: 'business_failure_means_wrong_answer' },
    { ...good, procedureIds: ['replay_old_record_id'] }, { ...good, procedureIds: [] },
    { ...good, evidenceHash: '0'.repeat(64) }, { ...good, verificationIds: [...good.verificationIds, ...good.verificationIds] },
  ]) assert.throws(() => parseCorrectionPlan({ candidate: bad, evidence }))
  assert.deepEqual(parseCorrectionPlan({ candidate: JSON.stringify(good, null, 2), evidence }), good)
  const duplicate = JSON.stringify(good).replace('{', '{"defectCode":"SECRET_DUPLICATE_PAYLOAD",')
  assert.throws(() => parseCorrectionPlan({ candidate: duplicate, evidence }), /duplicate_or_nested/)
})

test('Phase 4 trusted method rendering is byte-stable across all old-session evidence hashes', () => {
  const evidence = deriveCorrectionEvidence(correctionFixture({ kind: 'unknown_write_requires_readback' })), plan = parseCorrectionPlan({ candidate: candidate(evidence), evidence })
  const first = renderTrustedCorrection(plan), second = renderTrustedCorrection({ ...plan, evidenceHash: 'f'.repeat(64) })
  assert.equal(first.strategyText, second.strategyText); assert.equal(first.strategyHash, second.strategyHash)
  assert.notEqual(first.planHash, second.planHash)
  assert.match(first.strategyText, /Never blindly repeat/)
  assert.ok(!Object.hasOwn(first, 'variablePatches'))
})

test('Phase 4 recognizes old/new single-action feedback but never trains budget exhaustion', () => {
  for (const blockReason of ['invalid_action', 'multiple_tool_calls_not_supported']) {
    const evidence = deriveCorrectionEvidence(correctionFixture({ kind: 'multi_tool_response_rejected', blockReason }))
    assert.equal(evidence.trainingAllowed, true)
    assert.equal(evidence.sealed.observableSummary.defects[0].defectCode, 'multi_tool_response_rejected')
  }
  const exhausted = deriveCorrectionEvidence(correctionFixture({ kind: 'read_failed', terminationReason: 'action_budget_exhausted' }))
  assert.equal(exhausted.eligible, false); assert.equal(exhausted.trainingAllowed, false)
  assert.equal(exhausted.reason, 'unrecognized_terminal_process')
})

test('Phase 4 reads frozen Windows relative manifest/session paths without mutating their hashes', () => {
  const input = correctionFixture({ kind: 'read_failed', windowsPaths: true }), originalManifest = JSON.stringify(input.manifest), originalSession = JSON.stringify(input.session)
  const verified = verifyInitialEvaluation(input), evidence = deriveCorrectionEvidence(input)
  assert.equal(verified.source.stateHash, fileDigest(join(input.root, input.manifest.stateFile.replaceAll('\\', '/'))))
  assert.equal(evidence.trainingAllowed, true)
  assert.ok(input.manifest.stateFile.includes('\\'))
  assert.equal(JSON.stringify(input.manifest), originalManifest); assert.equal(JSON.stringify(input.session), originalSession)
})

test('Phase 4 Windows normalization still rejects absolute, drive-relative, traversal and empty path segments', () => {
  for (const stateFile of ['C:\\outside\\run-state.json', 'C:relative.json', '\\\\server\\share\\state.json', '/absolute/state.json', 'runs\\..\\outside.json', 'runs\\\\fixture\\state.json', '']) {
    const input = correctionFixture({ kind: 'read_failed', windowsPaths: true })
    const { manifestHash: _, ...base } = input.manifest; base.stateFile = stateFile
    input.manifest = { ...base, manifestHash: digest(base) }
    assert.throws(() => verifyInitialEvaluation(input), /unsafe_evidence_path/)
    assert.equal(deriveCorrectionEvidence(input).trainingAllowed, false)
  }
})
