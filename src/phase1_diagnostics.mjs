/** Safe operational diagnostics are additional evidence, never a grade or a
 * reason to waive runtime integrity. All external strings are exact enums. */
export const ERROR_CODES = Object.freeze([
  'invalid_api_key', 'insufficient_quota', 'invalid_request_error',
  'model_not_found', 'unsupported_provider', 'configuration_error',
  'context_length_exceeded', 'invalid_service_tier', 'rate_limit_exceeded',
  'server_is_overloaded', 'credit_balance_exhausted',
  'organization_spend_limit_exceeded', 'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded', '429',
])
export const ERROR_TYPES = Object.freeze([
  'invalid_request_error', 'rate_limit_error', 'insufficient_quota',
  'authentication_error', 'permission_error', 'server_error',
  'service_unavailable_error', 'throttling_error',
])
const CLASSES = [
  'BadRequestError', 'APIStatusError', 'AuthenticationError', 'PermissionDeniedError',
  'NotFoundError', 'UnprocessableEntityError', 'RateLimitError', 'InternalServerError',
  'APIConnectionError', 'APITimeoutError', 'Timeout', 'ReadTimeout', 'ConnectTimeout',
  'ConnectError', 'ReadError', 'RemoteProtocolError', 'UnsupportedParamsError',
  'InvalidRequestError', 'ConfigurationError', 'ValueError', 'TypeError', 'TimeoutError', 'ConnectionError',
]
const ROLES = ['system', 'developer', 'user', 'assistant', 'tool', 'function', 'unknown']
const SOURCES = ['sdk_body', 'sdk_response_json', 'sdk_attribute']
const CATEGORIES = ['rate_limit', 'request_timeout', 'transport_error', 'configuration_error', 'runtime_error']
const GATES = [
  'missing_tool_gate_evidence', 'missing_attestation', 'evidence_sha_mismatch',
  'foreign_runtime_event', 'sealed_actor_input', 'missing_invocations',
  'manifest_identity', 'task_identity', 'session_or_capabilities_identity',
  'evidence_inventory_hash', 'invalid_or_duplicate_reference', 'foreign_evidence_path',
  'unbound_evidence', 'capabilities_sha_mismatch', 'loaded_plugin_files_mismatch',
  'source_inventory_invalid', 'correction_authority_changed',
  'runtime_evidence_rejected',
]
const LOGGING_GATES = [
  'runtime_hook_evidence_invalid', 'plugin_host_termination_failed',
  'foreign_runtime_events', 'malformed_runtime_event_log',
  'fresh_replay_process_generation_unverified', 'frozen_replay_baseline_changed',
  'fresh_replay_native_proof_invalid',
]
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const enumValue = (value, allowed) => typeof value === 'string' && allowed.includes(value) ? value : null
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const status = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null
function get(value, key) { try { return value?.[key] } catch { return undefined } }

export function safeRequestSummary(value) {
  const source = object(value) ? value : {}
  return {
    messagesCount: count(get(source, 'messagesCount')),
    roles: Object.fromEntries(ROLES.map(role => [role, count(get(get(source, 'roles'), role))])),
    contentUtf8Bytes: count(get(source, 'contentUtf8Bytes')), imageParts: count(get(source, 'imageParts')),
    toolsCount: count(get(source, 'toolsCount')), toolDefinitionsUtf8Bytes: count(get(source, 'toolDefinitionsUtf8Bytes')),
  }
}

export function safeModelDiagnostic(value) {
  const source = object(value) ? value : {}
  const errorCode = enumValue(get(source, 'errorCode'), ERROR_CODES), errorType = enumValue(get(source, 'errorType'), ERROR_TYPES)
  return {
    schemaVersion: 'gaia2-model-diagnostic-v1', sdkReportedStatus: status(get(source, 'sdkReportedStatus')),
    // No trusted transport observer is connected. Even a supplied true is not proof.
    dispatchObserved: null, errorCode, errorType,
    codeSource: errorCode ? enumValue(get(source, 'codeSource'), SOURCES) : null,
    typeSource: errorType ? enumValue(get(source, 'typeSource'), SOURCES) : null,
    exceptionClass: enumValue(get(source, 'exceptionClass'), CLASSES),
    requestSummary: safeRequestSummary(get(source, 'requestSummary')),
  }
}

export function safeEvidenceGateCode(error) {
  const message = get(error, 'message')
  if (typeof message !== 'string') return 'runtime_evidence_rejected'
  const match = /^Phase 3 runtime evidence: ([a-z_]+)$/.exec(message)
  return enumValue(match?.[1], GATES) ?? 'runtime_evidence_rejected'
}

export function buildFailureDiagnostics({ processResult = {}, report = null, events = [] } = {}) {
  const causes = []
  const successfulIds = new Set(events.filter(event => event?.type === 'model_request_succeeded').map(event => event.requestId).filter(Boolean))
  const eventIndex = events.findLastIndex(event => event?.type === 'model_request_failed' && !successfulIds.has(event.requestId))
  const failure = events[eventIndex]
  if (failure && enumValue(failure.category, CATEGORIES)) {
    const diagnostic = safeModelDiagnostic(failure.diagnostic)
    // Older logs only have httpStatus. This remains an SDK-reported status.
    diagnostic.sdkReportedStatus ??= status(failure.httpStatus)
    causes.push({ stage: 'model_request', eventIndex, category: failure.category,
      modelRole: enumValue(failure.modelRole, ['actor', 'judge', 'correction']),
      requestAttempts: count(failure.requestAttempt), diagnostic })
  }
  if (processResult.loggingError) causes.push({ stage: 'evidence_gate', code: enumValue(processResult.loggingError, LOGGING_GATES) ?? 'process_logging_failed' })
  const gateCode = processResult.evidenceGateCode ?? report?.evidenceGateCode
  if (gateCode != null) causes.push({ stage: 'evidence_gate', code: enumValue(gateCode, GATES) ?? 'runtime_evidence_rejected' })
  if (processResult.spawnError) causes.push({ stage: 'process_supervision', code: 'process_spawn_failed' })
  if (processResult.heartbeatError) causes.push({ stage: 'process_supervision', code: 'process_heartbeat_failed' })
  if (processResult.terminationErrors?.length) causes.push({ stage: 'process_supervision', code: 'process_termination_failed' })
  return { schemaVersion: 'gaia2-execution-failure-diagnostic-v1', causes }
}
