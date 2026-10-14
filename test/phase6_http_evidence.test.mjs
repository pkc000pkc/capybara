import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { verifyModelHttpDispatchEvidence } from '../src/phase6_http_evidence.mjs'
import { parsePhase6HttpArgs } from '../scripts/phase6_http_report.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const identity = { runId: 'phase6-fixture', manifestHash: 'a'.repeat(64), executionId: 'standard-execution-fixture', sessionId: '0001-aaaaaaaa-aaa', scenarioId: 'scenario-fixture', runNumber: 1, phase: 'standard', config: 'execution' }
const entryBytes = Buffer.from(JSON.stringify({ schemaVersion: 'gaia2-official-entry-handshake-v1', ...identity, scenarioVersion: 'are_simulation_v1', scenarioHash: 'b'.repeat(64), attemptIndex: 1, correctionOrdinal: 0, launcherProcessId: 9 }) + '\n')
const common = { runId: identity.runId, manifestHash: identity.manifestHash, executionId: identity.executionId, sessionId: identity.sessionId, scenarioId: identity.scenarioId, entrySha256: hash(entryBytes), pythonProcessId: 10 }
const initialized = { type: 'guard_initialized', guardRequired: true, clientFamily: 'httpx2', maxSdkHttpDispatches: 1, sdkMaxRetries: 0 }
const base = { modelRole: 'actor', requestId: 'c'.repeat(32), requestAttempt: 1 }
const child = { ...base, modelRole: 'child_actor', permitId: 'd'.repeat(32), actualInputHash: 'e'.repeat(64), modelScopeHash: 'f'.repeat(64), configHash: '1'.repeat(64), parentExecutionId: identity.executionId, parentSessionId: identity.sessionId, childExecutionId: 'child-fixture', childSessionId: 'child-session-fixture', delegationScopeHash: '2'.repeat(64) }
function scopedEvent(type, attempt = child, extra = {}) {
  const { requestAttempt, ...logical } = attempt
  return { schemaVersion: 'gaia2-scoped-model-event-v1', type, executionId: identity.executionId, sessionId: identity.sessionId, ...logical, ...extra }
}
const rejection = (attempt = child, extra = {}) => scopedEvent('model_request_rejected', attempt, { failureCode: 'SCOPED_MODEL_SAFE_POINT_DENIED', ...extra })
const lifecycle = (attempt = child, sdkAttempts = 1) => [scopedEvent('model_logical_request_started', attempt), scopedEvent('model_logical_request_finished', attempt, { status: 'rejected', sdkAttempts })]

function attemptRecords(attempt = base, { responseStatus = 200, status = 'succeeded', bodyHash = '3'.repeat(64), denied = false } = {}) {
  return [
    { type: 'sdk_attempt_started', ...attempt },
    { type: 'dispatch_admitted', ...attempt, requestBodyHash: bodyHash, admittedDispatches: 1 },
    { type: 'dispatch_response', ...attempt, admittedDispatches: 1, requestBodyHash: bodyHash, responseStatus },
    ...(denied ? [{ type: 'redispatch_denied', ...attempt, admittedDispatches: 1, deniedDispatches: 1, originalBodyHash: bodyHash, candidateBodyHash: null, candidateHashAvailable: false, localGuardFailure: true }] : []),
    { type: 'sdk_attempt_closed', ...attempt, sdkCallStatus: status, transportStatus: status, admittedDispatches: 1, deniedDispatches: denied ? 1 : 0, responseCount: 1, clientClosed: true, leaseClosed: true, failureCode: denied ? 'HTTP_GUARD_REDISPATCH_DENIED' : status === 'succeeded' ? null : 'SDK_CALL_FAILED' },
  ]
}
function journal(records) {
  let previous = null
  return Buffer.from([initialized, ...records].map((fields, index) => {
    const value = { schemaVersion: 'gaia2-model-http-dispatch-v1', ...fields, sequence: index + 1, previousRecordSha256: previous, ...common }
    value.recordSha256 = hash(JSON.stringify(value)); previous = value.recordSha256
    return JSON.stringify(value)
  }).join('\n') + '\n')
}
function events(attempt = base, outcome = 'model_request_succeeded') {
  return ['model_request_attempt', outcome].map(type => ({ ...(attempt.modelRole === 'child_actor' ? { schemaVersion: 'gaia2-scoped-model-event-v1' } : {}), type, executionId: identity.executionId, sessionId: identity.sessionId, ...attempt }))
}
function verify(records = attemptRecords(), modelEvents = events(), overrides = {}) {
  return verifyModelHttpDispatchEvidence({ journalBytes: journal(records), events: modelEvents, identity, officialEntryBytes: entryBytes, pythonProcessId: 10, ...overrides })
}

function corrected408Fixture(records = attemptRecords(base, { responseStatus: 408, status: 'failed' }), attempt = base) {
  const closed = journal(records).toString('utf8').trim().split('\n').map(JSON.parse)
    .find(row => row.type === 'sdk_attempt_closed' && row.modelRole === attempt.modelRole && row.requestId === attempt.requestId && row.requestAttempt === attempt.requestAttempt)
  const modelEvents = events(attempt, 'model_request_failed')
  Object.assign(modelEvents[1], { category: 'request_timeout', retryable: true, httpStatus: 408,
    classificationSource: 'trusted_http_guard', httpStatusSource: 'trusted_http_guard',
    httpGuardClosedRecordSha256: closed.recordSha256,
    diagnostic: { schemaVersion: 'gaia2-model-diagnostic-v1', sdkReportedStatus: 400,
      exceptionClass: 'BadRequestError', errorCode: null, codeSource: null,
      errorType: 'invalid_request_error', typeSource: 'sdk_body', dispatchObserved: null } })
  if (attempt.modelRole === 'child_actor') delete modelEvents[1].diagnostic
  return { records, modelEvents }
}

test('HTTP 408 correcting SDK 400 requires the exact healthy, closed attempt receipt', () => {
  const fixture = corrected408Fixture()
  const next = { ...base, requestAttempt: 2 }
  assert.equal(verify([...fixture.records, ...attemptRecords(next)], [...fixture.modelEvents, ...events(next)]).attempts, 2)
  assert.equal(fixture.modelEvents[1].diagnostic.sdkReportedStatus, 400)
  for (const status of [200, 400, 401, 403, 422, 503]) {
    const wrong = corrected408Fixture(attemptRecords(base, { responseStatus: status, status: 'failed' }))
    assert.throws(() => verify(wrong.records, wrong.modelEvents), /trusted_status_lease_mismatch/)
  }
})

test('new trusted status fields cannot be missing, forged, or copied from a foreign lease', () => {
  const { records, modelEvents } = corrected408Fixture()
  for (const field of ['classificationSource', 'httpStatusSource', 'httpGuardClosedRecordSha256']) {
    const changed = structuredClone(modelEvents)
    delete changed[1][field]
    assert.throws(() => verify(records, changed), /trusted_status_classification_invalid|trusted_status_lease_mismatch/)
  }
  for (const [field, value] of [['category', 'configuration_error'], ['retryable', false], ['httpStatus', 400],
    ['classificationSource', 'sdk'], ['httpStatusSource', 'sdk'], ['httpGuardClosedRecordSha256', 'f'.repeat(64)]]) {
    const changed = structuredClone(modelEvents)
    changed[1][field] = value
    assert.throws(() => verify(records, changed), /trusted_status_classification_invalid|trusted_status_lease_mismatch/)
  }
  const missingAll = structuredClone(modelEvents)
  for (const field of ['classificationSource', 'httpStatusSource', 'httpGuardClosedRecordSha256']) delete missingAll[1][field]
  assert.throws(() => verify(records, missingAll), /trusted_status_classification_invalid/)
  const judge = { ...base, modelRole: 'judge', requestId: '7'.repeat(32) }
  const interleaved = [...records, ...attemptRecords(judge)]
  const fixture = corrected408Fixture(interleaved)
  assert.equal(verify(interleaved, [...fixture.modelEvents, ...events(judge)]).attempts, 2)
  fixture.modelEvents[1].httpGuardClosedRecordSha256 = journal(interleaved).toString('utf8').trim().split('\n').map(JSON.parse).at(-1).recordSha256
  assert.throws(() => verify(interleaved, [...fixture.modelEvents, ...events(judge)]), /trusted_status_lease_mismatch/)
})

test('trusted HTTP status cannot override guard failure, cancellation, or child rejection', () => {
  const denied = attemptRecords(base, { responseStatus: 408, status: 'failed', denied: true })
  const fixture = corrected408Fixture(denied)
  assert.throws(() => verify(denied, fixture.modelEvents), /trusted_status_lease_mismatch/)
  for (const code of ['HTTP_GUARD_SCOPE_INVALID', 'HTTP_GUARD_CLIENT_CLOSE_FAILED', 'SDK_CALL_CANCELLED']) {
    const changed = attemptRecords(base, { responseStatus: 408, status: 'failed' })
    changed.at(-1).failureCode = code
    assert.throws(() => verify(changed, corrected408Fixture(changed).modelEvents), /trusted_status_lease_mismatch/)
  }
  const childRecords = attemptRecords(child, { responseStatus: 408, status: 'failed' })
  assert.equal(verify(childRecords, corrected408Fixture(childRecords, child).modelEvents).status, 'passed')
})

test('child trusted 408 failure and retry schedule bind every permit and scope field', () => {
  const fixture = corrected408Fixture(attemptRecords(child, { responseStatus: 408, status: 'failed' }), child)
  const next = { ...child, requestAttempt: 2 }
  const schedule = { ...fixture.modelEvents[1], type: 'model_retry_scheduled' }
  const allRecords = [...fixture.records, ...attemptRecords(next)]
  const allEvents = [...fixture.modelEvents, schedule, ...events(next)]
  assert.equal(verify(allRecords, allEvents).attempts, 2)
  for (const field of Object.keys(child).filter(key => !['modelRole', 'requestId', 'requestAttempt'].includes(key))) {
    for (const index of [1, 2]) {
      const changed = structuredClone(allEvents)
      changed[index][field] = field.endsWith('Hash') ? '9'.repeat(64) : field === 'permitId' ? '9'.repeat(32) : 'foreign'
      assert.throws(() => verify(allRecords, changed), /sdk_outcome_binding_mismatch|trusted_retry_binding_mismatch/)
    }
  }
  const changed = structuredClone(allEvents)
  changed[1].schemaVersion = 'untrusted-version'
  assert.throws(() => verify(allRecords, changed), /trusted_child_event_schema/)
  const publicDiagnostic = structuredClone(allEvents)
  publicDiagnostic[1].diagnostic = { sdkReportedStatus: 400 }
  assert.throws(() => verify(allRecords, publicDiagnostic), /trusted_status_classification_invalid/)
  for (const responseStatus of [400, 401, 403, 422, 200]) {
    const records = attemptRecords(child, { responseStatus, status: 'failed' })
    assert.throws(() => verify(records, corrected408Fixture(records, child).modelEvents), /trusted_status_lease_mismatch/)
  }
})

test('historical uncorrected child SDK400 over HTTP408 remains valid evidence', () => {
  const modelEvents = events(child, 'model_request_failed')
  Object.assign(modelEvents[1], { category: 'configuration_error', retryable: false, httpStatus: 400 })
  assert.equal(verify(attemptRecords(child, { responseStatus: 408, status: 'failed' }), modelEvents).status, 'passed')
})

test('child SDK success over HTTP408 or a failed guard closure cannot become a valid recovery', () => {
  assert.throws(() => verify(attemptRecords(child, { responseStatus: 408 }), events(child)), /successful_dispatch_invalid/)
  for (const failureCode of ['HTTP_GUARD_SCOPE_INVALID', 'HTTP_GUARD_CLIENT_CLOSE_FAILED', 'SDK_CALL_CANCELLED']) {
    const records = attemptRecords(child, { responseStatus: 408, status: 'failed' })
    records.at(-1).failureCode = failureCode
    assert.throws(() => verify(records, corrected408Fixture(records, child).modelEvents), /trusted_status_lease_mismatch/)
  }
})

test('permanent SDK diagnostics cannot be disguised as trusted timeout metadata', () => {
  const { records, modelEvents } = corrected408Fixture()
  for (const [field, value] of [['errorCode', 'invalid_api_key'], ['codeSource', 'sdk_body'],
    ['errorType', 'authentication_error'], ['exceptionClass', 'AuthenticationError'], ['sdkReportedStatus', 401]]) {
    const changed = structuredClone(modelEvents)
    changed[1].diagnostic[field] = value
    assert.throws(() => verify(records, changed), /trusted_status_classification_invalid/)
  }
})

test('trusted retry schedule repeats the validated failure provenance without mutation', () => {
  const { records, modelEvents } = corrected408Fixture()
  const schedule = { ...modelEvents[1], type: 'model_retry_scheduled', waitSeconds: 2 }
  assert.equal(verify(records, [...modelEvents, schedule]).attempts, 1)
  for (const field of ['classificationSource', 'httpStatusSource', 'httpGuardClosedRecordSha256']) {
    const changed = { ...schedule }
    delete changed[field]
    assert.throws(() => verify(records, [...modelEvents, changed]), /trusted_retry_classification_mismatch/)
  }
  const changed = structuredClone(schedule)
  changed.diagnostic.sdkReportedStatus = 408
  assert.throws(() => verify(records, [...modelEvents, changed]), /trusted_retry_diagnostic_mismatch/)
  const stripped = { ...schedule, httpStatus: 400 }
  for (const field of ['classificationSource', 'httpStatusSource', 'httpGuardClosedRecordSha256']) delete stripped[field]
  assert.throws(() => verify(records, [...modelEvents, stripped]), /trusted_retry_classification_mismatch/)
  assert.throws(() => verify(records, [...modelEvents, schedule, { ...schedule }]), /duplicate_trusted_retry_schedule/)
})

test('historical SDK 400 configuration failures over actual HTTP 408 remain valid uncorrected evidence', () => {
  const records = attemptRecords(base, { responseStatus: 408, status: 'failed' })
  const modelEvents = events(base, 'model_request_failed')
  Object.assign(modelEvents[1], { category: 'configuration_error', retryable: false, httpStatus: 400,
    diagnostic: { schemaVersion: 'gaia2-model-diagnostic-v1', sdkReportedStatus: 400,
      exceptionClass: 'BadRequestError', errorCode: null, codeSource: null,
      errorType: 'invalid_request_error', typeSource: 'sdk_body', dispatchObserved: null } })
  assert.equal(verify(records, modelEvents).status, 'passed')
})
test('HTTP report CLI accepts explicit selection and rejects missing or ambiguous arguments', () => {
  const parsed = parsePhase6HttpArgs(['--manifest', 'runs/new/run-manifest.json', '--execution-id', 'one', '--execution-id', 'two'])
  assert.deepEqual(parsed.selection.executionIds, ['one', 'two'])
  assert.throws(() => parsePhase6HttpArgs([]), /manifest_required/)
  assert.throws(() => parsePhase6HttpArgs(['--manifest', 'one', '--manifest', 'two']), /invalid_arguments/)
  assert.throws(() => parsePhase6HttpArgs(['--manifest', 'one', '--execution-id']), /invalid_arguments/)
  assert.throws(() => parsePhase6HttpArgs(['--manifest', 'one', '--only-run-number', '0']), /run_number_invalid/)
})

test('HTTP evidence independently binds a successful actor dispatch and closed client', () => {
  const result = verify()
  assert.equal(result.status, 'passed'); assert.equal(result.attempts, 1)
  assert.equal(result.admittedDispatches, 1); assert.equal(result.allClientsClosed, true)
  assert.equal(result.physicalPacketCountClaimed, false)
})
test('child SDK return followed by real STOP rejection is not fabricated SDK success', () => {
  const [started, finished] = lifecycle()
  const result = verify(attemptRecords(child), [started, events(child)[0], rejection(), finished])
  assert.equal(result.attempts, 1); assert.equal(result.responseCount, 1)
  assert.equal(result.inferredRejectedAttempts, 1); assert.equal(result.logicalOnlyRejections, 0)
})
test('STOP during cooldown is logical-only and does not duplicate the already failed SDK outcome', () => {
  const [started, finished] = lifecycle()
  const result = verify(attemptRecords(child, { responseStatus: 503, status: 'failed' }), [started, ...events(child, 'model_request_failed'), rejection(), finished])
  assert.equal(result.attempts, 1); assert.equal(result.inferredRejectedAttempts, 0)
  assert.equal(result.logicalOnlyRejections, 1); assert.equal(result.preSdkRejections, 0)
})
test('reject invented rejection ordinals, unknown codes, mismatched logical lifecycle and permits', () => {
  const [started, finished] = lifecycle()
  const fixture = [started, events(child)[0], rejection(), finished]
  for (const changed of [rejection(child, { requestAttempt: 1 }), rejection(child, { failureCode: 'MADE_UP_UNKNOWN_CODE' }), { ...rejection(), schemaVersion: undefined }]) {
    assert.throws(() => verify(attemptRecords(child), [started, events(child)[0], changed, finished]), /unbound_logical_rejection/)
  }
  assert.throws(() => verify(attemptRecords(child), fixture.slice(1)), /logical_rejection_start_mismatch/)
  assert.throws(() => verify(attemptRecords(child), fixture.slice(0, -1)), /logical_rejection_finish_mismatch/)
  assert.throws(() => verify(attemptRecords(child), [...fixture.slice(0, -1), { ...finished, sdkAttempts: 2 }]), /logical_rejection_finish_mismatch/)
  assert.throws(() => verify(attemptRecords(child), [...fixture.slice(0, -1), { ...finished, status: 'succeeded' }]), /logical_rejection_finish_mismatch/)
  assert.throws(() => verify(attemptRecords(child), [started, events(child)[0], rejection(child, { permitId: '6'.repeat(32) }), finished]), /logical_rejection_binding_mismatch/)
  assert.throws(() => verify(attemptRecords(child), [started, events(child)[0], rejection(), { ...finished, childSessionId: 'other-child' }]), /logical_rejection_finish_binding/)
  assert.throws(() => verify(attemptRecords(child), [...fixture, { ...finished }]), /logical_rejection_finish_mismatch/)
  assert.throws(() => verify(attemptRecords(child), [started, { ...events(child)[0], schemaVersion: undefined }, rejection(), finished]), /logical_rejection_legacy_attempt/)
})
test('outer 503 retry has two SDK identities and one dispatch each, preserving body', () => {
  const next = { ...base, requestAttempt: 2 }
  const result = verify([...attemptRecords(base, { responseStatus: 503, status: 'failed' }), ...attemptRecords(next)], [...events(base, 'model_request_failed'), ...events(next)])
  assert.equal(result.attempts, 2); assert.equal(result.admittedDispatches, 2)
  assert.throws(() => verify([...attemptRecords(base, { responseStatus: 503, status: 'failed' }), ...attemptRecords(next, { bodyHash: '4'.repeat(64) })], [...events(base, 'model_request_failed'), ...events(next)]), /body_changed_across_retry/)
})
test('guard safely records denied redispatch even if raw SDK swallowed denial', () => {
  const records = attemptRecords(base, { denied: true })
  records.at(-1).transportStatus = 'failed'
  const result = verify(records, events(base, 'model_request_failed'))
  assert.equal(result.deniedRedispatches, 1); assert.equal(result.localGuardFailures, 1)
  records.at(-1).transportStatus = 'succeeded'
  assert.throws(() => verify(records, events()), /successful_dispatch_invalid|denial_swallowed/)
})
test('failed transport before response retains an audited attempt rather than inventing HTTP success', () => {
  const records = attemptRecords(base, { status: 'failed' }).filter(value => value.type !== 'dispatch_response')
  records.at(-1).responseCount = 0
  assert.equal(verify(records, events(base, 'model_request_failed')).responseCount, 0)
})
test('pre-SDK rejection is separate, with no invented dispatch', () => {
  const preChild = { ...child, requestId: '5'.repeat(32) }
  const result = verify(attemptRecords(), [...events(), rejection(preChild)])
  assert.equal(result.attempts, 1); assert.equal(result.preSdkRejections, 1)
  const [started, finished] = lifecycle(preChild, 0)
  assert.equal(verify(attemptRecords(), [...events(), started, rejection(preChild), finished]).preSdkRejections, 1)
  assert.throws(() => verify(attemptRecords(), [...events(), started, rejection(preChild)]), /logical_rejection_unfinished/)
})
test('unmatched or ambiguous scoped rejection fails closed without inventing transport evidence', () => {
  const next = { ...child, requestAttempt: 2 }
  const [started, finished] = lifecycle(child, 2)
  assert.throws(() => verify([...attemptRecords(child), ...attemptRecords(next)], [started, events(child)[0], events(next)[0], rejection(), finished]), /ambiguous_rejected_attempt/)
  assert.throws(() => verify([], events(child)), /sdk_transport_count_mismatch/)
  assert.throws(() => verify(attemptRecords(), [...events(), { ...rejection(), modelRole: 'unknown' }]), /sdk_outcome_identity/)
})
test('entry task fields cannot be silently removed or rebound', () => {
  const entry = JSON.parse(entryBytes)
  for (const field of ['scenarioHash', 'scenarioVersion', 'attemptIndex', 'correctionOrdinal', 'launcherProcessId']) {
    const missing = { ...entry }; delete missing[field]
    assert.throws(() => verify(undefined, undefined, { officialEntryBytes: Buffer.from(JSON.stringify(missing)) }), /entry_fields/)
    assert.throws(() => verify(undefined, undefined, { identity: { ...identity, [field]: field === 'launcherProcessId' ? 11 : 'rebound' } }), /entry_task_identity/)
  }
})
test('independent trusted attempts may interleave without changing per-attempt dispatch identity', () => {
  const judge = { ...base, modelRole: 'judge', requestId: '7'.repeat(32) }
  const a = attemptRecords(), b = attemptRecords(judge)
  const interleaved = [a[0], b[0], a[1], b[1], a[2], b[2], a[3], b[3]]
  const result = verify(interleaved, [...events(), ...events(judge)])
  assert.equal(result.attempts, 2); assert.equal(result.admittedDispatches, 2)
})
test('reject foreign identity, PID, entry bytes, hash chain and malformed JSON safely', () => {
  assert.throws(() => verify(undefined, undefined, { pythonProcessId: 11 }), /journal_entry_or_process/)
  assert.throws(() => verify(undefined, undefined, { identity: { ...identity, sessionId: 'wrong' } }), /entry_identity|foreign_runtime_event/)
  assert.throws(() => verify(undefined, undefined, { officialEntryBytes: Buffer.from('{}\n') }), /entry_schema/)
  const bytes = journal(attemptRecords()); bytes[bytes.indexOf('c'.repeat(32))] = 'd'.charCodeAt(0)
  assert.throws(() => verify(undefined, undefined, { journalBytes: bytes }), /journal_record_hash/)
  assert.throws(() => verify(undefined, undefined, { journalBytes: Buffer.from('SECRET_NOT_A_JOURNAL\n') }), error => /journal_json/.test(error.message) && !error.message.includes('SECRET'))
})
test('reject unknown fields/codes, unfinished attempts and silent client cleanup failure', () => {
  const unknown = attemptRecords(); unknown[0].api_key = 'FAKE_SECRET'
  assert.throws(() => verify(unknown), /journal_fields/)
  const badCode = attemptRecords(base, { status: 'failed' }); badCode.at(-1).failureCode = 'FAKE_UNKNOWN_CODE'
  assert.throws(() => verify(badCode, events(base, 'model_request_failed')), /failure_code_invalid/)
  assert.throws(() => verify(attemptRecords().slice(0, -1)), /unfinished_transport_attempt/)
  const notClosed = attemptRecords(); notClosed.at(-1).clientClosed = false
  assert.throws(() => verify(notClosed), /attempt_cleanup_or_counts/)
})
test('reject multiple dispatches, replay, missing/duplicate SDK outcomes and changed child permit', () => {
  const multiple = attemptRecords(); multiple.splice(2, 0, { ...multiple[1] })
  assert.throws(() => verify(multiple), /multiple_or_invalid_dispatch/)
  assert.throws(() => verify([...attemptRecords(), ...attemptRecords()]), /nested_or_replayed_attempt/)
  assert.throws(() => verify(attemptRecords(), events().slice(0, 1)), /missing_transport_or_sdk_outcome/)
  assert.throws(() => verify(attemptRecords(), [...events(), events()[1]]), /missing_transport_or_sdk_outcome/)
  const changed = events(child); changed[1].permitId = '6'.repeat(32)
  assert.throws(() => verify(attemptRecords(child), changed), /sdk_outcome_binding_mismatch/)
})
