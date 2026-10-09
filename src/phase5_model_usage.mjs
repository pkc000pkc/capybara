/** Stage 5 model-only observed usage. This is not an authority verifier or
 * provider invoice; callers must independently bind/verify their evidence.
 * Node permits, logical requests, SDK calls and native effects are distinct. */
const ROLES = ['actor', 'child_actor', 'judge', 'correction']
const TOKENS = ['inputTokens', 'outputTokens', 'totalTokens']
const EVENT_SCHEMA = 'gaia2-scoped-model-event-v1'
const HASH = /^[a-f0-9]{64}$/
const ID = /^[a-f0-9]{32}$/
const BASE = ['type', 'schemaVersion', 'modelRole', 'modelScopeHash', 'configHash', 'permitId', 'requestId', 'actualInputHash']
const OPERATIONAL = ['requestAttempt', 'maxRequestAttempts', 'cumulativeWaitSeconds']
const FAILED = [...OPERATIONAL, 'category', 'retryable', 'httpStatus', 'nextRetryAt', 'retryExhausted']
const FIELDS = {
  model_logical_request_started: [],
  model_request_attempt: OPERATIONAL,
  model_request_succeeded: [...OPERATIONAL, 'outputHash', 'usageAvailable', 'usage'],
  model_request_failed: FAILED,
  model_retry_scheduled: [...FAILED, 'waitSeconds', 'delaySource', 'cumulativeWaitSecondsAfterRetry'],
  model_retry_waiting: [...OPERATIONAL, 'nextRetryAt', 'remainingWaitSeconds'],
  model_request_rejected: ['failureCode'],
  model_logical_request_finished: ['status', 'sdkAttempts'],
}
const FAILURE_CODES = new Set([
  'SCOPED_MODEL_CONFIGURATION_ERROR', 'SCOPED_MODEL_RATE_LIMIT', 'SCOPED_MODEL_REQUEST_TIMEOUT',
  'SCOPED_MODEL_TRANSPORT_ERROR', 'SCOPED_MODEL_RUNTIME_ERROR', 'SCOPED_MODEL_UNSAFE_VALUE',
  'SCOPED_MODEL_SDK_INVALID', 'SCOPED_MODEL_WRAPPED_SDK_FORBIDDEN', 'SCOPED_MODEL_SDK_AUTORETRY_FORBIDDEN',
  'SCOPED_MODEL_SOURCE_UNAVAILABLE', 'SCOPED_MODEL_SOURCE_INVALID', 'SCOPED_MODEL_SOURCE_CHANGED',
  'SCOPED_MODEL_GUARD_CHANGED', 'SCOPED_MODEL_CONFIG_CHANGED', 'SCOPED_MODEL_CONFIG_INVALID',
  'SCOPED_MODEL_SDK_CONFIG_INVALID', 'SCOPED_MODEL_GUARD_INVALID', 'SCOPED_MODEL_GUARD_REQUIRED',
  'SCOPED_MODEL_INPUT_INVALID', 'SCOPED_MODEL_ATTACHMENT_UNSUPPORTED', 'SCOPED_MODEL_ACTOR_KWARGS_FORBIDDEN',
  'SCOPED_MODEL_INPUT_HASH_CHANGED', 'SCOPED_MODEL_RESPONSE_INVALID', 'SCOPED_MODEL_SDK_BUDGET_EXHAUSTED',
  'SCOPED_MODEL_ATTEMPT_DENIED', 'SCOPED_MODEL_LEDGER_FAILED', 'SCOPED_MODEL_WAIT_CANCELLED',
])
function check(condition, code) { if (!condition) throw new Error(`Phase 5 model usage: ${code}`) }
const record = value => value && typeof value === 'object' && !Array.isArray(value)
const count = value => Number.isSafeInteger(value) && value >= 0
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const fresh = () => ({ logicalRequests: 0, sdkAttempts: 0, successfulCompletions: 0, failedSdkAttempts: 0,
  failedLogicalRequests: 0, rejectedLogicalRequests: 0, unfinishedLogicalRequests: 0, retriesScheduled: 0,
  usageReportedCompletions: 0, sdkAttemptsWithUnknownUsage: 0,
  inputTokens: 0, outputTokens: 0, totalTokens: 0,
  unknownInputTokenAttempts: 0, unknownOutputTokenAttempts: 0, unknownTotalTokenAttempts: 0 })

function safeUsage(event) {
  const usage = event.usage
  if (usage === undefined) { check(event.usageAvailable === false, 'missing_reported_usage'); return null }
  check(event.usageAvailable === true && record(usage) && Object.keys(usage).length > 0
    && Object.keys(usage).every(key => TOKENS.includes(key)) && Object.values(usage).every(count), 'unsafe_usage')
  return usage
}

function validate(event) {
  check(record(event) && Object.hasOwn(FIELDS, event.type), 'invalid_event_type')
  const required = [...BASE, ...FIELDS[event.type].filter(key => key !== 'usage')]
  check(required.every(key => Object.hasOwn(event, key))
    && Object.keys(event).every(key => BASE.includes(key) || FIELDS[event.type].includes(key)), 'unsafe_event_fields')
  check(event.schemaVersion === EVENT_SCHEMA && ROLES.includes(event.modelRole)
    && HASH.test(event.modelScopeHash ?? '') && HASH.test(event.configHash ?? '') && HASH.test(event.actualInputHash ?? '')
    && ID.test(event.permitId ?? '') && ID.test(event.requestId ?? ''), 'invalid_model_identity')
  if (Object.hasOwn(event, 'requestAttempt')) check(count(event.requestAttempt) && event.requestAttempt > 0
    && count(event.maxRequestAttempts) && event.maxRequestAttempts >= event.requestAttempt
    && finite(event.cumulativeWaitSeconds), 'invalid_attempt_counters')
  if (Object.hasOwn(event, 'category')) check(['configuration_error', 'rate_limit', 'request_timeout', 'transport_error', 'runtime_error'].includes(event.category)
    && typeof event.retryable === 'boolean' && typeof event.retryExhausted === 'boolean'
    && (event.httpStatus === null || Number.isInteger(event.httpStatus) && event.httpStatus >= 100 && event.httpStatus <= 599), 'unsafe_failure_metadata')
  if (Object.hasOwn(event, 'nextRetryAt')) check(event.nextRetryAt === null
    || typeof event.nextRetryAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(event.nextRetryAt), 'unsafe_retry_deadline')
  if (Object.hasOwn(event, 'waitSeconds')) check(finite(event.waitSeconds) && finite(event.cumulativeWaitSecondsAfterRetry)
    && ['retry_after', 'retry_after_ms', 'structured_cooldown', 'exponential_backoff'].includes(event.delaySource), 'unsafe_retry_wait')
  if (Object.hasOwn(event, 'remainingWaitSeconds')) check(finite(event.remainingWaitSeconds), 'unsafe_retry_wait')
  if (event.type === 'model_request_succeeded') { check(HASH.test(event.outputHash ?? ''), 'invalid_output_hash'); safeUsage(event) }
  if (event.type === 'model_request_rejected') check(FAILURE_CODES.has(event.failureCode), 'unsafe_failure_code')
  if (event.type === 'model_logical_request_finished') check(['succeeded', 'failed', 'rejected'].includes(event.status) && count(event.sdkAttempts), 'invalid_logical_finish')
}

/** Accept only the new versioned model events. Legacy Stage 4 remains unchanged.
 * Optional nativeActions are separately verified, observed dispatch identities;
 * absent native evidence stays unknown and cannot be inferred from model calls. */
export function aggregatePhase5ModelUsage({ executions = [] } = {}) {
  check(Array.isArray(executions), 'invalid_executions')
  const executionIds = new Set(), requests = new Map(), permits = new Set(), scopes = new Map(), nativeIds = new Set()
  const byRole = Object.fromEntries(ROLES.map(role => [role, fresh()])), total = fresh()
  let reportedNativeActionSubtotal = 0, unknownNativeActionExecutions = 0
  const increment = (entries, key, amount = 1) => {
    for (const entry of entries) { check(count(entry[key] + amount), 'aggregate_overflow'); entry[key] += amount }
  }
  for (const execution of executions) {
    check(record(execution) && typeof execution.executionId === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(execution.executionId)
      && !executionIds.has(execution.executionId) && Array.isArray(execution.events)
      && Object.keys(execution).every(key => ['executionId', 'events', 'nativeActions'].includes(key)), 'invalid_execution_identity')
    executionIds.add(execution.executionId)
    if (execution.nativeActions === undefined) unknownNativeActionExecutions++
    else {
      check(Array.isArray(execution.nativeActions), 'invalid_native_actions')
      for (const native of execution.nativeActions) {
        check(record(native) && Object.keys(native).length === 1 && typeof native.dispatchId === 'string'
          && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(native.dispatchId), 'unsafe_native_identity')
        const identity = JSON.stringify([execution.executionId, native.dispatchId])
        check(!nativeIds.has(identity), 'duplicate_native_action'); nativeIds.add(identity)
        reportedNativeActionSubtotal++
        check(count(reportedNativeActionSubtotal), 'aggregate_overflow')
      }
    }
    for (const event of execution.events) {
      check(record(event) && typeof event.type === 'string', 'invalid_event')
      if (!event.type.startsWith('model_')) continue
      validate(event)
      if (!scopes.has(event.modelScopeHash)) scopes.set(event.modelScopeHash, { modelRole: event.modelRole, configHash: event.configHash, ...fresh() })
      const scope = scopes.get(event.modelScopeHash)
      check(scope.modelRole === event.modelRole && scope.configHash === event.configHash, 'model_scope_identity_changed')
      const entries = [total, byRole[event.modelRole], scope]
      const key = JSON.stringify([execution.executionId, event.modelRole, event.modelScopeHash, event.requestId])
      let request = requests.get(key)
      if (event.type === 'model_logical_request_started') {
        const permitIdentity = JSON.stringify([execution.executionId, event.permitId])
        check(!request && !permits.has(permitIdentity), 'duplicate_logical_request'); permits.add(permitIdentity)
        request = { entries, permitId: event.permitId, actualInputHash: event.actualInputHash,
          attempts: 0, pending: false, lastOutcome: null, scheduled: false, finished: false, succeeded: false, rejected: false }
        requests.set(key, request); increment(entries, 'logicalRequests'); continue
      }
      // Invalid Actor inputs can be rejected before the first logical dispatch.
      if (!request && event.type === 'model_request_rejected') continue
      check(request && !request.finished && request.permitId === event.permitId
        && request.actualInputHash === event.actualInputHash, 'unbound_request_event')
      if (event.type === 'model_request_attempt') {
        check(!request.pending && !request.succeeded && event.requestAttempt === request.attempts + 1
          && (request.attempts === 0 || request.scheduled), 'invalid_sdk_sequence')
        request.attempts++; request.pending = true; request.scheduled = false
        increment(entries, 'sdkAttempts'); continue
      }
      if (event.type === 'model_request_succeeded' || event.type === 'model_request_failed') {
        check(request.pending && event.requestAttempt === request.attempts, 'unbound_sdk_outcome')
        request.pending = false; request.lastOutcome = event.type
        if (event.type === 'model_request_failed') { increment(entries, 'failedSdkAttempts'); increment(entries, 'sdkAttemptsWithUnknownUsage'); continue }
        request.succeeded = true
        increment(entries, 'successfulCompletions')
        const usage = safeUsage(event)
        if (usage) increment(entries, 'usageReportedCompletions')
        else increment(entries, 'sdkAttemptsWithUnknownUsage')
        for (const token of TOKENS) {
          if (usage && Object.hasOwn(usage, token)) increment(entries, token, usage[token])
          else increment(entries, `unknown${token[0].toUpperCase()}${token.slice(1, -1)}Attempts`)
        }
        continue
      }
      if (event.type === 'model_retry_scheduled') {
        check(!request.pending && !request.scheduled && request.lastOutcome === 'model_request_failed'
          && event.requestAttempt === request.attempts && event.retryable && !event.retryExhausted, 'invalid_retry_sequence')
        request.scheduled = true; increment(entries, 'retriesScheduled'); continue
      }
      if (event.type === 'model_retry_waiting') {
        check(request.scheduled && event.requestAttempt === request.attempts, 'invalid_retry_sequence'); continue
      }
      if (event.type === 'model_request_rejected') {
        check(!request.rejected && !request.succeeded, 'duplicate_rejection'); request.rejected = true; continue
      }
      check(event.type === 'model_logical_request_finished' && event.sdkAttempts === request.attempts
        && (event.status !== 'succeeded' || request.succeeded && !request.pending)
        && (event.status !== 'failed' || request.lastOutcome === 'model_request_failed' && !request.pending)
        && (event.status !== 'rejected' || request.rejected), 'invalid_logical_finish')
      request.finished = true
      if (event.status === 'failed') increment(entries, 'failedLogicalRequests')
      if (event.status === 'rejected') increment(entries, 'rejectedLogicalRequests')
    }
  }
  for (const request of requests.values()) {
    if (!request.finished) increment(request.entries, 'unfinishedLogicalRequests')
    if (request.pending) increment(request.entries, 'sdkAttemptsWithUnknownUsage')
    // Failed or unfinished SDK calls have unknown usage; never infer zero cost.
    const successfulAttempts = request.succeeded ? 1 : 0
    for (const token of TOKENS) increment(request.entries,
      `unknown${token[0].toUpperCase()}${token.slice(1, -1)}Attempts`, request.attempts - successfulAttempts)
  }
  const finalize = entry => {
    const result = { ...entry, reportedTokenSubtotals: Object.fromEntries(TOKENS.map(token => [token, entry[token]])) }
    for (const token of TOKENS) if (entry[`unknown${token[0].toUpperCase()}${token.slice(1, -1)}Attempts`]) result[token] = null
    return result
  }
  return { schemaVersion: 'gaia2-phase5-model-usage-v1', executionCount: executionIds.size,
    modelUsageComplete: total.unfinishedLogicalRequests === 0, totals: finalize(total),
    byRole: Object.fromEntries(ROLES.map(role => [role, finalize(byRole[role])])),
    byModelScopeHash: Object.fromEntries([...scopes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([hash, value]) => [hash, finalize(value)])),
    nativeActionCount: unknownNativeActionExecutions ? null : reportedNativeActionSubtotal,
    reportedNativeActionSubtotal, unknownNativeActionExecutions,
    nativeActionsCountedAsSdkAttempts: 0, sdkAttemptsCountedAsNativeActions: 0,
    sdkAttemptsAreInvocationsNotHttpProof: true, monetaryCost: null,
    monetaryCostStatus: 'provider_unit_prices_not_supplied', legacyStage4EnumsChanged: false }
}
