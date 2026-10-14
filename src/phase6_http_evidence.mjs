import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve, win32 } from 'node:path'
import { digest, within } from './phase0_run.mjs'
import { verifyPhase6HttpSessionPaths, verifyPhase6NativeProcessIdentity } from './phase6_process_identity.mjs'

const HASH = /^[a-f0-9]{64}$/
const REQUEST = /^[a-f0-9]{32}$/
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,240}$/
const ROLES = new Set(['actor', 'judge', 'correction', 'child_actor'])
const COMMON = ['schemaVersion', 'type', 'sequence', 'previousRecordSha256', 'recordSha256', 'runId', 'manifestHash', 'executionId', 'sessionId', 'scenarioId', 'entrySha256', 'pythonProcessId']
const ATTEMPT = ['modelRole', 'requestId', 'requestAttempt']
const CHILD = ['permitId', 'actualInputHash', 'modelScopeHash', 'configHash', 'parentExecutionId', 'parentSessionId', 'childExecutionId', 'childSessionId', 'delegationScopeHash']
const SCOPED_REJECTION_CODES = new Set(['ACTOR_KWARGS_FORBIDDEN', 'ATTACHMENT_UNSUPPORTED', 'ATTEMPT_DENIED', 'BUDGET_INVALID', 'CALLBACK_INVALID', 'CONFIG_CHANGED', 'CONFIG_INVALID', 'CONFIGURATION_ERROR', 'DEADLINE_EXPIRED', 'DEADLINE_INVALID', 'DEADLINE_POLICY_INVALID', 'DEADLINE_REQUIRED', 'DEADLINE_REUSED', 'DEADLINE_SCOPE_MISMATCH', 'GUARD_CHANGED', 'GUARD_INVALID', 'GUARD_REQUIRED', 'IDENTITY_INVALID', 'INPUT_HASH_CHANGED', 'INPUT_INVALID', 'LEDGER_FAILED', 'LOGICAL_BUDGET_EXHAUSTED', 'PERMIT_INVALID', 'PERMIT_REQUIRED', 'PERMIT_REUSED', 'POLICY_INVALID', 'RATE_LIMIT', 'REQUEST_ACTIVE', 'REQUEST_TIMEOUT', 'RESPONSE_INVALID', 'RUNTIME_ERROR', 'SAFE_POINT_CHANGED', 'SAFE_POINT_DENIED', 'SAFE_POINT_INVALID', 'SDK_AUTORETRY_FORBIDDEN', 'SDK_BUDGET_EXHAUSTED', 'SDK_CONFIG_INVALID', 'SDK_INVALID', 'SOURCE_CHANGED', 'SOURCE_INVALID', 'SOURCE_UNAVAILABLE', 'TIMING_INVALID', 'TRANSPORT_ERROR', 'UNSAFE_VALUE', 'WAIT_CANCELLED', 'WRAPPED_SDK_FORBIDDEN'].map(code => `SCOPED_MODEL_${code}`))
const EXTRA = {
  guard_initialized: ['guardRequired', 'clientFamily', 'maxSdkHttpDispatches', 'sdkMaxRetries'],
  sdk_attempt_started: [],
  dispatch_admitted: ['requestBodyHash', 'admittedDispatches'],
  dispatch_response: ['admittedDispatches', 'requestBodyHash', 'responseStatus'],
  redispatch_denied: ['admittedDispatches', 'deniedDispatches', 'originalBodyHash', 'candidateBodyHash', 'candidateHashAvailable', 'localGuardFailure'],
  sdk_attempt_closed: ['sdkCallStatus', 'transportStatus', 'admittedDispatches', 'deniedDispatches', 'responseCount', 'clientClosed', 'leaseClosed', 'failureCode'],
}
export const MODEL_HTTP_FAILURE_CODES = new Set(['HTTP_GUARD_ENTRY_INVALID', 'HTTP_GUARD_ENTRY_CHANGED', 'HTTP_GUARD_REQUIRED_CHANGED', 'HTTP_GUARD_JOURNAL_FAILED', 'HTTP_GUARD_IDENTITY_INVALID', 'HTTP_GUARD_ATTEMPT_REPLAY', 'HTTP_GUARD_NESTED_ATTEMPT', 'HTTP_GUARD_SCOPE_INVALID', 'HTTP_GUARD_MODE_UNSUPPORTED', 'HTTP_GUARD_CLIENT_INJECTION', 'HTTP_GUARD_UNSAFE_GLOBAL_CONFIG', 'HTTP_GUARD_KWARGS_INVALID', 'HTTP_GUARD_ROUTE_INVALID', 'HTTP_GUARD_BODY_UNBUFFERED', 'HTTP_GUARD_REDISPATCH_DENIED', 'HTTP_GUARD_RESPONSE_INVALID', 'HTTP_GUARD_CLIENT_CLOSE_FAILED', 'HTTP_GUARD_NO_DISPATCH', 'SDK_CALL_FAILED', 'SDK_CALL_CANCELLED'])
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = value => Number.isSafeInteger(value) && value >= 0
const requireProof = (ok, code) => { if (!ok) throw new Error(`Phase 6 HTTP evidence: ${code}`) }
const keyFor = value => `${value.modelRole}/${value.requestId}/${value.requestAttempt}`
function parseJson(text, code) {
  try { return JSON.parse(text) } catch { throw new Error(`Phase 6 HTTP evidence: ${code}`) }
}

/** No network or filesystem reads. A bundle reader can supply sealed copies. */
export function verifyModelHttpDispatchEvidence({ journalBytes, events, identity, officialEntryBytes, pythonProcessId }) {
  requireProof(Buffer.isBuffer(journalBytes) && Buffer.isBuffer(officialEntryBytes) && Array.isArray(events) && object(identity), 'inputs_invalid')
  requireProof(Number.isSafeInteger(pythonProcessId) && pythonProcessId > 0, 'process_identity_missing')
  requireProof(events.every(event => object(event) && event.executionId === identity.executionId && event.sessionId === identity.sessionId), 'foreign_runtime_event')
  const entry = parseJson(officialEntryBytes.toString('utf8'), 'entry_json'), entrySha256 = sha(officialEntryBytes)
  requireProof(entry.schemaVersion === 'gaia2-official-entry-handshake-v1', 'entry_schema')
  requireProof(digest(Object.keys(entry).sort()) === digest(['schemaVersion', 'runId', 'manifestHash', 'executionId', 'sessionId', 'scenarioId', 'scenarioVersion', 'scenarioHash', 'config', 'runNumber', 'attemptIndex', 'correctionOrdinal', 'phase', 'launcherProcessId'].sort()), 'entry_fields')
  requireProof(SAFE_ID.test(entry.scenarioVersion ?? '') && HASH.test(entry.scenarioHash ?? '') && SAFE_ID.test(entry.config ?? '') && ['standard', 'agent2agent', 'noise'].includes(entry.phase)
    && integer(entry.runNumber) && entry.runNumber > 0 && integer(entry.attemptIndex) && entry.attemptIndex > 0 && integer(entry.correctionOrdinal)
    && Number.isSafeInteger(entry.launcherProcessId) && entry.launcherProcessId > 0, 'entry_task_fields')
  for (const field of ['runId', 'manifestHash', 'executionId', 'sessionId', 'scenarioId']) requireProof(entry[field] === identity[field], 'entry_identity')
  for (const field of ['runNumber', 'phase', 'config', 'scenarioVersion', 'scenarioHash', 'attemptIndex', 'correctionOrdinal', 'launcherProcessId']) if (identity[field] !== undefined) requireProof(entry[field] === identity[field], 'entry_task_identity')
  const text = journalBytes.toString('utf8')
  requireProof(text.endsWith('\n') && !text.includes('\r'), 'journal_not_closed_line')
  const lines = text.slice(0, -1).split('\n')
  requireProof(lines.length > 0 && lines.every(line => line.length > 0), 'journal_empty_or_blank')
  const records = [], leases = new Map(), sdk = new Map(), bodies = new Map()
  let previous = null, responses = 0, denials = 0, guardedFailures = 0
  for (const [index, line] of lines.entries()) {
    const record = parseJson(line, 'journal_json')
    requireProof(object(record) && Object.hasOwn(EXTRA, record.type), 'journal_event_type')
    const fields = [...COMMON, ...EXTRA[record.type], ...(record.type === 'guard_initialized' ? [] : ATTEMPT), ...(record.modelRole === 'child_actor' ? CHILD : [])]
    requireProof(digest(Object.keys(record).sort()) === digest(fields.sort()), 'journal_fields')
    requireProof(JSON.stringify(record) === line && /^[\x20-\x7e]+$/.test(line), 'journal_json_or_ascii')
    requireProof(Object.values(record).every(value => value === null || typeof value === 'string' || typeof value === 'boolean' || integer(value)), 'journal_scalar_type')
    requireProof(record.schemaVersion === 'gaia2-model-http-dispatch-v1' && record.sequence === index + 1 && record.previousRecordSha256 === previous && HASH.test(record.recordSha256), 'journal_chain')
    const { recordSha256, ...contents } = record
    requireProof(sha(JSON.stringify(contents)) === recordSha256, 'journal_record_hash')
    previous = recordSha256
    for (const field of ['runId', 'manifestHash', 'executionId', 'sessionId', 'scenarioId']) requireProof(record[field] === identity[field], 'journal_identity')
    requireProof(record.entrySha256 === entrySha256 && record.pythonProcessId === pythonProcessId, 'journal_entry_or_process')
    requireProof(SAFE_ID.test(record.runId) && SAFE_ID.test(record.executionId) && SAFE_ID.test(record.sessionId) && SAFE_ID.test(record.scenarioId) && HASH.test(record.manifestHash), 'unsafe_identity')
    if (record.type === 'guard_initialized') {
      requireProof(index === 0 && record.guardRequired === true && record.clientFamily === 'httpx2' && record.maxSdkHttpDispatches === 1 && record.sdkMaxRetries === 0, 'initialization_invalid')
      records.push(record); continue
    }
    requireProof(index > 0 && ROLES.has(record.modelRole) && REQUEST.test(record.requestId) && integer(record.requestAttempt) && record.requestAttempt > 0, 'attempt_identity')
    if (record.modelRole === 'child_actor') {
      requireProof(REQUEST.test(record.permitId), 'child_permit')
      for (const field of ['actualInputHash', 'modelScopeHash', 'configHash', 'delegationScopeHash']) requireProof(HASH.test(record[field]), 'child_hash')
      for (const field of ['parentExecutionId', 'parentSessionId', 'childExecutionId', 'childSessionId']) requireProof(SAFE_ID.test(record[field]), 'child_identity')
      requireProof(record.parentExecutionId === identity.executionId && record.parentSessionId === identity.sessionId, 'child_parent_identity')
    }
    const key = keyFor(record)
    if (record.type === 'sdk_attempt_started') {
      requireProof(!leases.has(key), 'nested_or_replayed_attempt')
      leases.set(key, { key, started: record, admitted: 0, response: 0, denied: 0, body: null, responseStatus: null, closed: null })
    } else {
      const current = leases.get(key)
      requireProof(current?.key === key && current.closed === null, 'event_outside_attempt')
      for (const field of [...ATTEMPT, ...(record.modelRole === 'child_actor' ? CHILD : [])]) requireProof(record[field] === current.started[field], 'attempt_binding_changed')
      if (record.type === 'dispatch_admitted') {
        requireProof(current.admitted === 0 && current.response === 0 && current.denied === 0 && record.admittedDispatches === 1 && HASH.test(record.requestBodyHash), 'multiple_or_invalid_dispatch')
        current.admitted = 1; current.body = record.requestBodyHash
        const logicalKey = `${record.modelRole}/${record.requestId}`
        requireProof(!bodies.has(logicalKey) || bodies.get(logicalKey) === current.body, 'body_changed_across_retry')
        bodies.set(logicalKey, current.body)
      } else if (record.type === 'dispatch_response') {
        requireProof(current.admitted === 1 && current.response === 0 && record.admittedDispatches === 1 && record.requestBodyHash === current.body && integer(record.responseStatus) && record.responseStatus >= 100 && record.responseStatus <= 599, 'response_invalid')
        current.response = 1; current.responseStatus = record.responseStatus; responses++
      } else if (record.type === 'redispatch_denied') {
        requireProof(current.admitted === 1 && record.admittedDispatches === 1 && record.deniedDispatches === current.denied + 1 && record.originalBodyHash === current.body && record.localGuardFailure === true && typeof record.candidateHashAvailable === 'boolean' && (record.candidateHashAvailable ? HASH.test(record.candidateBodyHash) : record.candidateBodyHash === null), 'redispatch_denial_invalid')
        current.denied++; denials++
      } else {
        requireProof(record.type === 'sdk_attempt_closed' && ['succeeded', 'failed', 'cancelled'].includes(record.sdkCallStatus) && ['succeeded', 'failed', 'cancelled'].includes(record.transportStatus), 'attempt_close_status')
        requireProof(record.admittedDispatches === current.admitted && record.responseCount === current.response && record.deniedDispatches === current.denied && record.clientClosed === true && record.leaseClosed === true, 'attempt_cleanup_or_counts')
        requireProof(record.failureCode === null || MODEL_HTTP_FAILURE_CODES.has(record.failureCode), 'failure_code_invalid')
        if (record.transportStatus === 'succeeded') requireProof(record.sdkCallStatus === 'succeeded' && current.admitted === 1 && current.response === 1 && current.responseStatus >= 200 && current.responseStatus < 300 && current.denied === 0 && record.failureCode === null, 'successful_dispatch_invalid')
        else requireProof(record.failureCode !== null, 'failed_dispatch_without_code')
        if (current.denied > 0) requireProof(record.transportStatus === 'failed' && record.failureCode === 'HTTP_GUARD_REDISPATCH_DENIED', 'denial_swallowed')
        if (record.failureCode?.startsWith('HTTP_GUARD_')) guardedFailures++
        current.closed = record
      }
    }
    records.push(record)
  }
  requireProof([...leases.values()].every(value => value.closed !== null), 'unfinished_transport_attempt')
  for (const [index, event] of events.entries()) {
    if (event.type !== 'model_request_attempt') continue
    requireProof(ROLES.has(event.modelRole) && REQUEST.test(event.requestId) && integer(event.requestAttempt) && event.requestAttempt > 0 && event.executionId === identity.executionId && event.sessionId === identity.sessionId, 'sdk_event_identity')
    const key = keyFor(event)
    requireProof(!sdk.has(key), 'duplicate_sdk_attempt')
    sdk.set(key, { attempt: event, index, outcomes: [] })
  }
  let preSdkRejections = 0, logicalOnlyRejections = 0, inferredRejectedAttempts = 0
  for (const [index, event] of events.entries()) {
    if (!['model_request_succeeded', 'model_request_failed', 'model_request_rejected'].includes(event.type)) continue
    requireProof(ROLES.has(event.modelRole) && REQUEST.test(event.requestId), 'sdk_outcome_identity')
    let value = sdk.get(keyFor(event)), inferred = false
    if (event.type === 'model_request_rejected') {
      // The production scoped v1 producer has no ordinal on this logical
      // rejection. Do not permit an invented ordinal to bypass its lifecycle.
      requireProof(event.requestAttempt === undefined && event.schemaVersion === 'gaia2-scoped-model-event-v1' && SCOPED_REJECTION_CODES.has(event.failureCode), 'unbound_logical_rejection')
      const attempts = [...sdk.values()].filter(item => item.index < index && item.attempt.modelRole === event.modelRole && item.attempt.requestId === event.requestId)
      const bindingFields = ['modelRole', 'requestId', ...(event.modelRole === 'child_actor' ? CHILD : ['permitId', 'actualInputHash', 'modelScopeHash', 'configHash'])]
      requireProof(REQUEST.test(event.permitId), 'logical_rejection_permit')
      for (const field of ['actualInputHash', 'modelScopeHash', 'configHash']) requireProof(HASH.test(event[field]), 'logical_rejection_scope_hash')
      if (event.modelRole === 'child_actor') {
        requireProof(REQUEST.test(event.permitId) && event.parentExecutionId === identity.executionId && event.parentSessionId === identity.sessionId, 'logical_rejection_child_identity')
        for (const field of ['actualInputHash', 'modelScopeHash', 'configHash', 'delegationScopeHash']) requireProof(HASH.test(event[field]), 'logical_rejection_child_hash')
        for (const field of ['childExecutionId', 'childSessionId']) requireProof(SAFE_ID.test(event[field]), 'logical_rejection_child_identity')
      }
      for (const item of attempts) {
        requireProof(item.attempt.schemaVersion === 'gaia2-scoped-model-event-v1', 'logical_rejection_legacy_attempt')
        for (const field of bindingFields) requireProof(event[field] === item.attempt[field], 'logical_rejection_binding_mismatch')
      }
      const pending = attempts.filter(item => item.outcomes.length === 0)
      requireProof(pending.length <= 1, 'ambiguous_rejected_attempt')
      const finished = events.slice(index + 1).filter(item => item.type === 'model_logical_request_finished' && item.modelRole === event.modelRole && item.requestId === event.requestId)
      const started = events.slice(0, index).filter(item => item.type === 'model_logical_request_started' && item.modelRole === event.modelRole && item.requestId === event.requestId)
      if (attempts.length > 0 || finished.length > 0) {
        requireProof(started.length === 1 && started[0].schemaVersion === 'gaia2-scoped-model-event-v1', 'logical_rejection_start_mismatch')
        for (const field of bindingFields) requireProof(started[0][field] === event[field], 'logical_rejection_start_binding')
        requireProof(finished.length === 1 && finished[0].schemaVersion === 'gaia2-scoped-model-event-v1' && finished[0].status === 'rejected' && finished[0].sdkAttempts === attempts.length, 'logical_rejection_finish_mismatch')
        for (const field of bindingFields) requireProof(finished[0][field] === event[field], 'logical_rejection_finish_binding')
      }
      if (pending.length === 1) {
        value = pending[0]; inferred = true
        requireProof(value === attempts.at(-1) && value.attempt.requestAttempt === attempts.length, 'rejected_attempt_not_latest')
        inferredRejectedAttempts++
      } else {
        if (attempts.length === 0) {
          requireProof(started.length === 0 || finished.length === 1, 'logical_rejection_unfinished')
          preSdkRejections++
        }
        else logicalOnlyRejections++
        continue
      }
    }
    requireProof(value && event.executionId === identity.executionId && event.sessionId === identity.sessionId, 'orphan_sdk_outcome')
    requireProof(value.index < index, 'sdk_outcome_before_attempt')
    value.outcomes.push({ event, inferred })
  }
  requireProof(sdk.size === leases.size, 'sdk_transport_count_mismatch')
  for (const [key, value] of sdk) {
    const lease = leases.get(key)
    requireProof(lease?.closed && value.outcomes.length === 1, 'missing_transport_or_sdk_outcome')
    for (const field of [...ATTEMPT, ...(value.attempt.modelRole === 'child_actor' ? CHILD : [])]) requireProof(lease.started[field] === value.attempt[field], 'sdk_transport_binding_mismatch')
    const { event: outcome, inferred } = value.outcomes[0]
    for (const field of [...ATTEMPT.filter(field => !inferred || field !== 'requestAttempt'), ...(value.attempt.modelRole === 'child_actor' ? CHILD : [])]) requireProof(outcome[field] === value.attempt[field], 'sdk_outcome_binding_mismatch')
    if (outcome.type === 'model_request_succeeded') requireProof(lease.closed.transportStatus === 'succeeded', 'sdk_success_after_guard_failure')
    // A real response can be discarded by the child STOP/notification/deadline
    // safe point after SDK return. That is not fabricated SDK success or usage.
    if (outcome.type === 'model_request_failed') requireProof(lease.closed.transportStatus !== 'succeeded', 'sdk_failure_after_successful_return')
    const claimsTrustedClassification = ['classificationSource', 'httpStatusSource', 'httpGuardClosedRecordSha256'].some(field => Object.hasOwn(outcome, field))
    const correctsSdk400To408 = outcome.httpStatus === 408 && outcome.diagnostic?.sdkReportedStatus === 400
    if (claimsTrustedClassification || correctsSdk400To408) {
      requireProof(outcome.type === 'model_request_failed' && outcome.modelRole !== 'child_actor'
        && outcome.classificationSource === 'trusted_http_guard' && outcome.httpStatusSource === 'trusted_http_guard'
        && outcome.category === 'request_timeout' && outcome.retryable === true && outcome.httpStatus === 408
        && outcome.diagnostic?.schemaVersion === 'gaia2-model-diagnostic-v1'
        && outcome.diagnostic.sdkReportedStatus === 400 && outcome.diagnostic.exceptionClass === 'BadRequestError'
        && outcome.diagnostic.errorCode === null && outcome.diagnostic.codeSource === null
        && [null, 'invalid_request_error', 'server_error'].includes(outcome.diagnostic.errorType), 'trusted_status_classification_invalid')
      requireProof(lease.responseStatus === 408 && lease.admitted === 1 && lease.response === 1 && lease.denied === 0
        && lease.closed.sdkCallStatus === 'failed' && lease.closed.transportStatus === 'failed'
        && lease.closed.failureCode === 'SDK_CALL_FAILED' && lease.closed.clientClosed === true && lease.closed.leaseClosed === true
        && outcome.httpGuardClosedRecordSha256 === lease.closed.recordSha256, 'trusted_status_lease_mismatch')
    }
  }
  const trustedSchedules = new Set()
  for (const outcome of events.filter(event => event.type === 'model_retry_scheduled')) {
    const claimsTrustedClassification = ['classificationSource', 'httpStatusSource', 'httpGuardClosedRecordSha256'].some(field => Object.hasOwn(outcome, field))
    const correctsSdk400To408 = outcome.httpStatus === 408 && outcome.diagnostic?.sdkReportedStatus === 400
    const value = sdk.get(keyFor(outcome)), failure = value?.outcomes[0]?.event
    if (!claimsTrustedClassification && !correctsSdk400To408 && failure?.classificationSource !== 'trusted_http_guard') continue
    requireProof(failure?.type === 'model_request_failed' && failure.classificationSource === 'trusted_http_guard', 'trusted_retry_without_failure')
    requireProof(!trustedSchedules.has(keyFor(outcome)), 'duplicate_trusted_retry_schedule')
    trustedSchedules.add(keyFor(outcome))
    for (const field of ['category', 'retryable', 'httpStatus', 'classificationSource', 'httpStatusSource', 'httpGuardClosedRecordSha256']) {
      requireProof(outcome[field] === failure[field], 'trusted_retry_classification_mismatch')
    }
    requireProof(digest(outcome.diagnostic) === digest(failure.diagnostic), 'trusted_retry_diagnostic_mismatch')
  }
  return { status: 'passed', schemaVersion: 'gaia2-phase6-http-evidence-v1', attempts: sdk.size, admittedDispatches: [...leases.values()].reduce((sum, value) => sum + value.admitted, 0), responseCount: responses, deniedRedispatches: denials, localGuardFailures: guardedFailures, preSdkRejections, logicalOnlyRejections, inferredRejectedAttempts, allAttemptsClosed: true, allClientsClosed: true, singleDispatchPerSdkAttempt: true, physicalPacketCountClaimed: false, entrySha256, pythonProcessId, journalSha256: sha(journalBytes), recordCount: records.length, finalRecordSha256: previous }
}

function fileInside(root, path, parent) {
  const safe = value => typeof value === 'string' && value.length > 0 && !isAbsolute(value) && !win32.isAbsolute(value) && !/[\\\0:]/.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..')
  // phase0 uses native path.join for trusted manifest roots. Evidence refs
  // remain portable and strict; normalizing that frozen parent is not an
  // allowance for Actor-selected backslashes or traversal.
  const parentPath = typeof parent === 'string' ? parent.replaceAll('\\', '/') : parent
  requireProof(safe(path) && safe(parentPath), 'reference_path_invalid')
  const file = resolve(root, path)
  requireProof(within(resolve(root), resolve(root, parentPath)) && within(resolve(root, parentPath), file) && file !== resolve(root, parentPath), 'reference_path_escape')
  for (let at = file; ; at = dirname(at)) { requireProof(!lstatSync(at).isSymbolicLink(), 'reference_symlink'); if (at === dirname(at)) break }
  requireProof(lstatSync(file).isFile(), 'reference_not_file')
  return readFileSync(file)
}

/** Read-only scope audit. Never trusts a saved report's passed boolean. */
export function verifyPhase6HttpScope({ root, manifest, state, executionIds }) {
  const selected = new Set(executionIds)
  requireProof(Array.isArray(executionIds) && selected.size > 0 && selected.size === executionIds.length, 'selected_ids_invalid')
  const tasks = manifest.tasks.filter(task => selected.has(task.executionId))
  requireProof(tasks.length === selected.size && digest(tasks.map(task => task.executionId)) === digest(executionIds), 'selected_order_or_identity')
  requireProof(state.schemaVersion === 'gaia2-run-state-v1' && state.runId === manifest.runId && state.manifestHash === manifest.manifestHash && HASH.test(state.runtimeHash ?? ''), 'state_binding')
  requireProof(Array.isArray(state.tasks) && digest(state.tasks.map(record => record.executionId)) === digest(manifest.tasks.map(task => task.executionId))
    && new Set(state.tasks.map(record => record.executionId)).size === state.tasks.length, 'state_task_inventory')
  const runtime = parseJson(fileInside(root, `${manifest.runRoot.replaceAll('\\', '/')}/runtime-settings.json`, manifest.runRoot).toString('utf8'), 'runtime_json')
  requireProof(digest(runtime) === state.runtimeHash, 'runtime_binding')
  const rows = tasks.map(task => {
    const record = state.tasks.find(value => value.executionId === task.executionId), session = record?.sessions?.at(-1)
    requireProof(record?.status === 'completed' && session, 'selected_not_completed')
    requireProof(record.sessions.every((item, ordinal) => object(item) && /^\d{4}-[0-9a-f-]{12}$/.test(item.sessionId ?? '')
      && item.sessionOrdinal === ordinal + 1 && item.parentSessionId === (record.sessions[ordinal - 1]?.sessionId ?? null)
      && ['outputDir', 'workspaceDir', 'fixtureDir'].every(field => typeof task[field] === 'string' && item[field] === `${task[field].replaceAll('\\', '/')}/sessions/${item.sessionId}`)), 'session_lineage_or_layout')
    requireProof(record.resultPath === `${session.workspaceDir}/task-result.json`, 'result_path_noncanonical')
    const resultBytes = fileInside(root, record.resultPath, manifest.runRoot)
    requireProof(sha(resultBytes) === record.resultSha256, 'result_hash')
    const result = parseJson(resultBytes.toString('utf8'), 'result_json'), attestation = result.runtimeAttestation
    requireProof(result.runId === manifest.runId && result.manifestHash === manifest.manifestHash && result.runtimeHash === state.runtimeHash && result.executionId === task.executionId && result.sessionId === session.sessionId && result.evaluationComplete === true && attestation?.modelHttpDispatchRequired === true, 'result_or_http_binding')
    for (const field of ['runId', 'manifestHash']) requireProof(attestation[field] === manifest[field], 'http_attestation_identity')
    for (const field of ['executionId', 'scenarioId', 'runNumber', 'phase', 'config']) requireProof(attestation[field] === task[field], 'http_attestation_identity')
    requireProof(attestation.sessionId === session.sessionId, 'http_attestation_identity')
    verifyPhase6HttpSessionPaths({ session, attestation })
    requireProof(Array.isArray(result.runtimeEvidence) && result.runtimeEvidence.every(ref => object(ref) && typeof ref.path === 'string' && HASH.test(ref.sha256 ?? '')), 'runtime_refs_invalid')
    const refs = new Map(result.runtimeEvidence.map(ref => [ref.path, ref.sha256]))
    requireProof(refs.size === result.runtimeEvidence.length, 'duplicate_runtime_reference')
    requireProof(attestation.evidenceHash === digest(result.runtimeEvidence), 'runtime_inventory_binding')
    const read = path => {
      const bytes = fileInside(root, path, manifest.runRoot)
      requireProof(refs.has(path) && sha(bytes) === refs.get(path), 'unbound_http_reference')
      return bytes
    }
    requireProof(refs.get(attestation.modelHttpDispatchPath) === attestation.modelHttpDispatchSha256, 'http_journal_hash_binding')
    const nativeProcess = parseJson(read(attestation.modelHttpDispatchProcessPath).toString('utf8'), 'native_process_json')
    const officialEntryBytes = read(attestation.officialEntryPath)
    requireProof(sha(officialEntryBytes) === attestation.officialEntrySha256, 'official_entry_hash_binding')
    verifyPhase6NativeProcessIdentity({ nativeProcess, officialEntry: parseJson(officialEntryBytes.toString('utf8'), 'entry_json'), pythonProcessId: attestation.modelHttpDispatchProcessId })
    const eventsBytes = fileInside(root, `${session.outputDir.replaceAll('\\', '/')}/runtime-events.jsonl`, manifest.runRoot)
    const events = eventsBytes.toString('utf8').trim().split(/\r?\n/).filter(Boolean).map(line => parseJson(line, 'runtime_event_json'))
    requireProof(digest(events) === attestation.eventsHash, 'http_events_binding')
    const proof = verifyModelHttpDispatchEvidence({ journalBytes: read(attestation.modelHttpDispatchPath), events, identity: { runId: manifest.runId, manifestHash: manifest.manifestHash, ...Object.fromEntries(['executionId', 'scenarioId', 'scenarioVersion', 'scenarioHash', 'runNumber', 'phase', 'config', 'correctionOrdinal'].map(key => [key, task[key]])), attemptIndex: task.attemptIndex ?? task.runNumber, sessionId: session.sessionId }, officialEntryBytes, pythonProcessId: attestation.modelHttpDispatchProcessId })
    return { executionId: task.executionId, sessionId: session.sessionId, resultSha256: record.resultSha256, ...proof }
  })
  const counts = Object.fromEntries(['attempts', 'admittedDispatches', 'responseCount', 'deniedRedispatches', 'localGuardFailures', 'preSdkRejections', 'logicalOnlyRejections', 'inferredRejectedAttempts'].map(key => [key, rows.reduce((sum, row) => sum + row[key], 0)]))
  return { schemaVersion: 'gaia2-phase6-http-scope-report-v1', status: 'passed', binding: { runId: manifest.runId, manifestHash: manifest.manifestHash, planFingerprint: manifest.planFingerprint, runtimeHash: state.runtimeHash, selectionIdentityHash: digest({ manifestHash: manifest.manifestHash, executionIds }) }, scope: { executionIds, selectedExecutions: rows.length }, counts, rows, noModelExecution: true, officialSubmissionReady: false }
}
