import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { digest } from './phase0_run.mjs'
import { validateRuntimeEvidence } from './phase3_runtime_evidence.mjs'

const HASH = /^[a-f0-9]{64}$/
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const portable = value => value.replaceAll('\\', '/')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function check(condition, code) { if (!condition) throw new Error(`Phase 4 correction contract: ${code}`) }
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
function exact(value, keys, code) { check(object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && digest(Object.keys(value).sort()) === digest([...keys].sort()), code) }
function path(value) {
  check(typeof value === 'string', 'unsafe_evidence_path')
  const normalized = portable(value)
  check(normalized && !/[\0:]/.test(normalized) && !normalized.startsWith('/') && !normalized.split('/').some(part => ['', '.', '..'].includes(part)), 'unsafe_evidence_path')
  return normalized
}
function json(bytes) { return JSON.parse(bytes.toString('utf8')) }
function healthy(p) { return object(p) && p.schemaVersion === 'gaia2-process-result-v1' && p.exitCode === 0 && p.childExited === true && p.childClosed === true && !p.signal && !p.timedOut && !p.interrupted && !p.spawnError && !p.loggingError && !p.heartbeatError && !p.manualInspectionRequired && Array.isArray(p.terminationErrors) && p.terminationErrors.length === 0 && Number.isFinite(Date.parse(p.finishedAt)) }

const methods = freeze({
  multi_tool_response_rejected: {
    procedureIds: ['one_action_per_response', 'await_result_before_next_action'],
    verificationIds: ['response_tool_count_at_most_one', 'matching_tool_gate_and_completion'],
    text: 'Issue exactly one native tool action per model response. Wait for its observed result and the next live context before choosing another action. Verify that each executed action has matching permission and completion evidence; do not batch or replay rejected actions.',
  },
  read_failed: {
    procedureIds: ['reacquire_visible_resource', 'retry_read_with_current_arguments'],
    verificationIds: ['successful_read_before_use'],
    text: 'Treat a failed read as unavailable evidence. Reacquire the resource and arguments from observations in this fresh session, then perform a new read. Do not invent content, reuse an old-session record identifier, or use a failed read as evidence. Verify a successful current read before relying on it.',
  },
  write_unverified: {
    procedureIds: ['verify_mutation_readback'],
    verificationIds: ['observed_readback_same_resource'],
    text: 'After a successful mutation, perform an authoritative read-back of the affected resource using identifiers obtained in this fresh session. Verify the observed state before continuing or reporting completion. Do not infer completion merely from an acknowledgement.',
  },
  unknown_write_requires_readback: {
    procedureIds: ['never_replay_unknown_mutation', 'readback_before_reconcile'],
    verificationIds: ['unknown_mutation_not_blindly_replayed', 'authoritative_readback_before_retry'],
    text: 'Never blindly repeat a mutation with unknown outcome. Obtain authoritative current state for the affected resource and reconcile the observed outcome before any further mutation. If the outcome cannot be established safely, stop or request clarification. Never copy an old-session mutation, identifier, answer, tool result, or time into this replay.',
  },
})
export const CORRECTION_CONTRACT = freeze({
  defectCodes: Object.keys(methods),
  procedureIds: [...new Set(Object.values(methods).flatMap(method => method.procedureIds))],
  verificationIds: [...new Set(Object.values(methods).flatMap(method => method.verificationIds))],
})

// Original bytes are read once. A caller can map these identities to a sealed
// bundle; this module never follows an absolute native Trace path or old root.
function verifyInputs({ manifest, task, session, result, events, readEvidence }) {
  check(typeof readEvidence === 'function' && object(manifest) && object(task) && object(session) && object(result), 'missing_verification_inputs')
  check(manifest.schemaVersion === 'gaia2-run-manifest-v1' && manifest.syntheticFixtureOnly !== true && manifest.executionBinding === 'phase3_live_plugin_host_required', 'not_initial_production_plan')
  const { manifestHash, ...base } = manifest
  check(HASH.test(manifestHash ?? '') && manifestHash === digest(base), 'manifest_hash_mismatch')
  check(task.correctionOrdinal === 0 && task.attemptIndex === task.runNumber && Number.isInteger(task.runNumber) && task.runNumber >= 1 && task.runNumber <= 5 && digest(manifest.tasks?.find(item => item.executionId === task.executionId)) === digest(task), 'not_frozen_initial_attempt')
  check(!result.correctionContext && !result.runtimeAttestation?.correctionContext, 'correction_cannot_be_initial')
  const cache = new Map()
  const bytes = value => { value = path(value); if (!cache.has(value)) { const buffer = readEvidence(value); check(Buffer.isBuffer(buffer), 'non_byte_evidence'); cache.set(value, Buffer.from(buffer)) } return cache.get(value) }
  const statePath = path(manifest.stateFile)
  const state = json(bytes(statePath)), settings = json(bytes(`${path(manifest.runRoot)}/runtime-settings.json`))
  const record = state.tasks?.find(item => item.executionId === task.executionId)
  const resultPath = `${path(portable(session.workspaceDir))}/task-result.json`, resultBytes = bytes(resultPath)
  check(state.schemaVersion === 'gaia2-run-state-v1' && state.runId === manifest.runId && state.manifestHash === manifestHash && state.runtimeHash === digest(settings) && record?.status === 'completed' && path(record.resultPath) === resultPath && sha(resultBytes) === record.resultSha256 && digest(json(resultBytes)) === digest(result) && digest(record.sessions?.at(-1)) === digest(session), 'initial_state_result_binding')
  check(result.schemaVersion === 'gaia2-task-result-v1' && result.runId === manifest.runId && result.manifestHash === manifestHash && result.runtimeHash === state.runtimeHash && result.sessionId === session.sessionId, 'result_provenance_identity')
  for (const field of ['executionId', 'scenarioId', 'phase', 'config', 'runNumber']) check(result[field] === task[field], 'result_task_identity')
  check(result.evaluationComplete === true && typeof result.businessPassed === 'boolean' && result.score === (result.businessPassed ? 1 : 0) && (result.businessPassed ? result.failure === null : result.failure?.category === 'business_failure' && result.failure.retryable === false), 'initial_not_validly_evaluated')
  check(digest(record.failure) === digest(result.failure), 'state_failure_mismatch')
  const outputDir = path(portable(session.outputDir)), processPath = `${outputDir}/process-result.json`, process = json(bytes(processPath))
  check(healthy(process) && result.process?.exitCode === 0 && result.process.signal === null && result.process.timedOut === false && result.process.interrupted === false, 'unhealthy_initial_process')
  const eventsPath = `${outputDir}/runtime-events.jsonl`, originalEvents = bytes(eventsPath).toString('utf8').split(/\r?\n/).filter(line => line.trim()).map(JSON.parse)
  check(Array.isArray(events) && digest(originalEvents) === digest(events), 'runtime_events_mismatch')
  check(Array.isArray(result.artifacts) && result.artifacts.length === 2, 'native_artifact_count')
  const references = new Map()
  for (const ref of result.artifacts) { const identity = path(ref?.path); check(object(ref) && HASH.test(ref.sha256 ?? '') && identity.startsWith(`${outputDir}/`) && !references.has(identity) && sha(bytes(identity)) === ref.sha256, 'native_artifact_binding'); references.set(identity, ref) }
  const envelopes = [...references.keys()].filter(item => item.endsWith('/output.jsonl'))
  check(envelopes.length === 1, 'native_envelope_identity')
  const rows = bytes(envelopes[0]).toString('utf8').split(/\r?\n/).filter(line => line.trim()).map(JSON.parse)
  check(rows.length === 1, 'native_row_count')
  const row = rows[0], tracePath = [...references.keys()].find(item => item !== envelopes[0]), trace = json(bytes(tracePath)), definition = trace.metadata?.definition
  check(typeof row.trace_id === 'string', 'native_trace_reference')
  const nativeRef = portable(row.trace_id)
  check(!nativeRef.split('/').includes('..') && (nativeRef === tracePath || posix.normalize(posix.join(posix.dirname(envelopes[0]), nativeRef)) === tracePath || (/^(?:[a-zA-Z]:\/|\/)/.test(nativeRef) && nativeRef.endsWith(`/${tracePath}`))), 'native_trace_binding')
  check(row.task_id === task.scenarioId && row.metadata?.scenario_id === task.scenarioId && definition?.scenario_id === task.scenarioId && definition.run_number === task.runNumber && (row.metadata.run_number === undefined || row.metadata.run_number === task.runNumber), 'native_task_identity')
  check(row.score === result.score && row.metadata.status === (result.businessPassed ? 'success' : 'failed') && row.metadata.has_exception !== true && definition.has_exception !== true && !row.metadata.exception_type && !definition.exception_type, 'native_score_or_exception')
  for (const key of ['world_logs', 'apps', 'events', 'completed_events']) check(Array.isArray(trace[key]), 'incomplete_trace')
  check(typeof trace.version === 'string' && Object.hasOwn(trace, 'context') && Object.hasOwn(trace, 'augmentation'), 'incomplete_trace_envelope')
  const validation = events.findLast(event => event.type === 'official_validation_completed')
  check(validation?.hasException === false && validation.validationSuccess === result.businessPassed && result.runtimeEvidenceRequired === true && result.realHooksReady === true, 'initial_validation_or_runtime_missing')
  const runtimeProof = validateRuntimeEvidence({ manifest, task, session, events, runtimeAttestation: result.runtimeAttestation, runtimeEvidence: result.runtimeEvidence, readEvidence: bytes })
  check(runtimeProof.realHooksReady === true && runtimeProof.trainingHooksExecuted === false, 'initial_runtime_proof_invalid')
  const calls = result.runtimeAttestation.invocationPaths.map(value => json(bytes(value)))
  const source = { manifestHash, resultHash: sha(resultBytes), runtimeAttestationHash: digest(result.runtimeAttestation), runtimeEvidenceHash: digest(result.runtimeEvidence), eventsHash: digest(events), stateHash: sha(bytes(statePath)), processHash: sha(bytes(processPath)), nativeArtifactsHash: digest(result.artifacts) }
  const verification = freeze({ schemaVersion: 'gaia2-phase4-initial-verification-v1', executionId: task.executionId, runNumber: task.runNumber, correctionOrdinal: 0, valid: { runtimeProof: true, evaluationComplete: true }, businessPassed: result.businessPassed, score: result.score, source, sourceHash: digest(source) })
  return { verification, calls, events }
}

export function verifyInitialEvaluation(input) { return verifyInputs(input).verification }

export function deriveCorrectionEvidence(input) {
  const rejected = reason => freeze({ schemaVersion: 'gaia2-phase4-correction-evidence-v1', eligible: false, trainingAllowed: false, reason, valid: { runtimeProof: false, evaluationComplete: false }, sealed: null })
  if (input.result?.evaluationComplete !== true || input.result?.score === null || input.result?.businessPassed === null) return rejected('not_evaluated')
  if (input.result?.businessPassed === true) return rejected('business_success')
  if (input.result?.businessPassed !== false || input.result?.score !== 0 || input.result?.failure?.category !== 'business_failure') return rejected('not_business_failure')
  let verified
  try { verified = verifyInputs(input) } catch { return rejected('invalid_initial_evidence') }
  const { verification, calls, events } = verified, after = calls.filter(call => call.input.checkpoint === 'after_tool')
  const observations = new Map(CORRECTION_CONTRACT.defectCodes.map(code => [code, []]))
  for (const event of events.filter(event => event.type === 'tool_call_blocked' && ['invalid_action', 'multiple_tool_calls_not_supported'].includes(event.reason))) {
    const response = events.find(item => item.type === 'model_response' && item.turn === event.turn)
    const gate = calls.find(call => call.input.checkpoint === 'before_tool' && call.input.action?.id === event.callId)
    if (Number.isSafeInteger(response?.toolCallCount) && response.toolCallCount > 1 && gate?.input.action.effect !== 'unknown' && gate?.decision.action === 'allow' && !after.some(call => call.input.action?.id === event.callId)) observations.get('multi_tool_response_rejected').push({ event, gate })
  }
  for (const [index, call] of after.entries()) {
    const { action, outcome } = call.input
    if (action.effect === 'read' && ['failed', 'failed_before_execution'].includes(outcome.status)) observations.get('read_failed').push(call)
    if (action.effect !== 'write' || !['succeeded', 'unknown'].includes(outcome.status) || typeof action.resourceKey !== 'string' || !action.resourceKey) continue
    // Compare resources privately, never forward their identifiers or contents.
    const readback = after.slice(index + 1).some(next => next.input.action.effect === 'read' && next.input.action.authoritativeRead === true && next.input.action.resourceKey === action.resourceKey
      && next.input.outcome.status === 'succeeded' && next.input.outcome.executed === true && next.input.outcome.complete === true)
    if (!readback) observations.get(outcome.status === 'unknown' ? 'unknown_write_requires_readback' : 'write_unverified').push(call)
  }
  const defects = [...observations].filter(([, records]) => records.length).map(([defectCode, records]) => ({ defectCode, procedureIds: [...methods[defectCode].procedureIds], verificationIds: [...methods[defectCode].verificationIds], count: records.length, evidenceHash: digest({ sourceHash: verification.sourceHash, defectCode, records }) }))
  const termination = events.findLast(event => event.type === 'attempt_execution_ended')
  const terminationReason = termination?.terminationReason
  if (!['environment_stop', 'conversation_turn_limit'].includes(terminationReason)) return rejected('unrecognized_terminal_process')
  const counts = {
    modelRequests: events.filter(event => event.type === 'model_request').length,
    toolCalls: events.filter(event => ['tool_call_started', 'tool_call_blocked'].includes(event.type)).length,
    toolsExecuted: events.filter(event => event.type === 'tool_call_started').length,
    blockedTools: events.filter(event => event.type === 'tool_call_blocked').length,
    unknownMutationOutcomes: after.filter(call => call.input.action.effect === 'write' && call.input.outcome.status === 'unknown').length,
    completedTurns: events.filter(event => event.type === 'conversation_turn_completed').length,
  }
  const effects = [...new Set(calls.filter(call => call.input.checkpoint === 'before_tool').map(call => call.input.action.effect))].sort()
  check(effects.every(effect => ['read', 'write', 'wait', 'finish', 'unknown'].includes(effect)), 'unknown_effect_enum')
  return freeze({ schemaVersion: 'gaia2-phase4-correction-evidence-v1', eligible: true, trainingAllowed: defects.length > 0, reason: defects.length ? 'observable_defects' : 'no_observable_defect', valid: verification.valid, verification, sealed: { source: verification.source, evidenceHash: verification.sourceHash, observableSummary: { terminationReason, counts, effects, defects } } })
}

export function parseCorrectionPlan({ candidate, evidence }) {
  check(evidence?.eligible === true && evidence.trainingAllowed === true && evidence.valid?.runtimeProof === true && evidence.valid.evaluationComplete === true, 'ineligible_training_input')
  if (typeof candidate === 'string') {
    const text = candidate.trim(); candidate = JSON.parse(text)
    // This deliberately flat schema has five keys. Reject duplicate root keys
    // as well as overwritten payloads that JSON.parse would silently discard.
    check((text.match(/"(?:[^"\\]|\\.)*"\s*:/g) ?? []).length === 5, 'duplicate_or_nested_candidate_keys')
  }
  exact(candidate, ['schemaVersion', 'defectCode', 'procedureIds', 'verificationIds', 'evidenceHash'], 'candidate_unknown_or_missing_keys')
  check(candidate.schemaVersion === 'gaia2-correction-plan-v1' && CORRECTION_CONTRACT.defectCodes.includes(candidate.defectCode) && HASH.test(candidate.evidenceHash ?? ''), 'candidate_schema_or_defect')
  const finding = evidence.sealed?.observableSummary?.defects.find(item => item.defectCode === candidate.defectCode && item.evidenceHash === candidate.evidenceHash)
  check(finding && Number.isSafeInteger(finding.count) && finding.count > 0, 'defect_not_observed')
  for (const field of ['procedureIds', 'verificationIds']) check(Array.isArray(candidate[field]) && candidate[field].every(item => typeof item === 'string') && new Set(candidate[field]).size === candidate[field].length && digest([...candidate[field]].sort()) === digest([...methods[candidate.defectCode][field]].sort()) && digest([...finding[field]].sort()) === digest([...methods[candidate.defectCode][field]].sort()), 'method_not_fixed_or_complete')
  return freeze({ schemaVersion: candidate.schemaVersion, defectCode: candidate.defectCode, procedureIds: [...methods[candidate.defectCode].procedureIds], verificationIds: [...methods[candidate.defectCode].verificationIds], evidenceHash: candidate.evidenceHash })
}

export function renderTrustedCorrection(plan) {
  exact(plan, ['schemaVersion', 'defectCode', 'procedureIds', 'verificationIds', 'evidenceHash'], 'untrusted_render_shape')
  const method = methods[plan.defectCode]
  check(plan.schemaVersion === 'gaia2-correction-plan-v1' && method && HASH.test(plan.evidenceHash ?? '') && digest(plan.procedureIds) === digest(method.procedureIds) && digest(plan.verificationIds) === digest(method.verificationIds), 'untrusted_render_plan')
  // No raw question, late USER message, answer, tool data, identifier, timestamp,
  // or model-generated text is interpolated. Readonly context is initialized by
  // the trusted host; neither this contract nor its plan carries variable patches.
  const strategyText = `Fresh-session procedure only. Do not reuse information from the earlier attempt.\n${method.text}`
  return freeze({ strategyText, strategyHash: sha(strategyText), planHash: digest(plan), freshReplayRequired: true, attemptCountDelta: 0 })
}
