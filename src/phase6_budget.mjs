import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path'
import { digest, within } from './phase0_run.mjs'
import { validateRuntimeEvidence } from './phase3_runtime_evidence.mjs'
import { selectPhase6ExecutionIds, selectionIdentityHash } from './phase6_selection.mjs'

const ROLES = ['actor', 'child_actor', 'judge', 'correction']
const TOKENS = ['inputTokens', 'outputTokens', 'totalTokens']
const HASH = /^[a-f0-9]{64}$/
const REQUEST_ID = /^[a-f0-9]{32}$/
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/
const SCOPED_SCHEMA = 'gaia2-scoped-model-event-v1'
const ENVELOPE = ['executionId', 'sessionId', 'time', 'attemptIndex', 'appId',
  'childExecutionId', 'childSessionId', 'delegationScopeHash', 'parentExecutionId', 'parentSessionId']
const COMMON = ['type', 'modelRole', 'requestId']
const SCOPED = ['schemaVersion', 'modelScopeHash', 'configHash', 'permitId', 'actualInputHash']
const OPERATIONAL = ['requestAttempt', 'maxRequestAttempts', 'cumulativeWaitSeconds']
const FAILURE = [...OPERATIONAL, 'category', 'retryable', 'httpStatus', 'nextRetryAt', 'retryExhausted']
const FIELDS = {
  model_logical_request_started: [],
  model_request_attempt: [...OPERATIONAL, 'requestSummary'],
  model_request_succeeded: [...OPERATIONAL, 'outputHash', 'usageAvailable', 'usage'],
  model_request_failed: [...FAILURE, 'diagnostic'],
  model_retry_scheduled: [...FAILURE, 'waitSeconds', 'delaySource', 'cumulativeWaitSecondsAfterRetry', 'diagnostic'],
  model_retry_waiting: [...OPERATIONAL, 'nextRetryAt', 'remainingWaitSeconds'],
  model_request_rejected: ['failureCode'],
  model_logical_request_finished: ['status', 'sdkAttempts'],
}

// Explicit finite vocabulary from the pinned broker. Never accept arbitrary
// SCOPED_MODEL_* strings, and never change the legacy Stage 4 role enum.
export const PHASE6_SCOPED_REJECTION_CODES = Object.freeze([
  'SCOPED_MODEL_ACTOR_KWARGS_FORBIDDEN', 'SCOPED_MODEL_ATTACHMENT_UNSUPPORTED',
  'SCOPED_MODEL_ATTEMPT_DENIED', 'SCOPED_MODEL_BUDGET_INVALID', 'SCOPED_MODEL_CALLBACK_INVALID',
  'SCOPED_MODEL_CONFIGURATION_ERROR', 'SCOPED_MODEL_CONFIG_CHANGED', 'SCOPED_MODEL_CONFIG_INVALID',
  'SCOPED_MODEL_DEADLINE_EXPIRED', 'SCOPED_MODEL_DEADLINE_INVALID', 'SCOPED_MODEL_DEADLINE_POLICY_INVALID',
  'SCOPED_MODEL_DEADLINE_REQUIRED', 'SCOPED_MODEL_DEADLINE_REUSED', 'SCOPED_MODEL_DEADLINE_SCOPE_MISMATCH',
  'SCOPED_MODEL_GUARD_CHANGED', 'SCOPED_MODEL_GUARD_INVALID', 'SCOPED_MODEL_GUARD_REQUIRED',
  'SCOPED_MODEL_IDENTITY_INVALID', 'SCOPED_MODEL_INPUT_HASH_CHANGED', 'SCOPED_MODEL_INPUT_INVALID',
  'SCOPED_MODEL_LEDGER_FAILED', 'SCOPED_MODEL_LOGICAL_BUDGET_EXHAUSTED', 'SCOPED_MODEL_PERMIT_INVALID',
  'SCOPED_MODEL_PERMIT_REQUIRED', 'SCOPED_MODEL_PERMIT_REUSED', 'SCOPED_MODEL_POLICY_INVALID',
  'SCOPED_MODEL_RATE_LIMIT', 'SCOPED_MODEL_REQUEST_ACTIVE', 'SCOPED_MODEL_REQUEST_TIMEOUT',
  'SCOPED_MODEL_RESPONSE_INVALID', 'SCOPED_MODEL_RUNTIME_ERROR', 'SCOPED_MODEL_SAFE_POINT_CHANGED',
  'SCOPED_MODEL_SAFE_POINT_DENIED', 'SCOPED_MODEL_SAFE_POINT_INVALID', 'SCOPED_MODEL_SDK_AUTORETRY_FORBIDDEN',
  'SCOPED_MODEL_SDK_BUDGET_EXHAUSTED', 'SCOPED_MODEL_SDK_CONFIG_INVALID', 'SCOPED_MODEL_SDK_INVALID',
  'SCOPED_MODEL_SOURCE_CHANGED', 'SCOPED_MODEL_SOURCE_INVALID', 'SCOPED_MODEL_SOURCE_UNAVAILABLE',
  'SCOPED_MODEL_TIMING_INVALID', 'SCOPED_MODEL_TRANSPORT_ERROR', 'SCOPED_MODEL_UNSAFE_VALUE',
  'SCOPED_MODEL_WAIT_CANCELLED', 'SCOPED_MODEL_WRAPPED_SDK_FORBIDDEN',
])
const REJECTION_CODES = new Set(PHASE6_SCOPED_REJECTION_CODES)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const count = value => Number.isSafeInteger(value) && value >= 0
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const portable = value => String(value).replaceAll('\\', '/')
const sha = value => createHash('sha256').update(value).digest('hex')
function check(value, code) { if (!value) throw new Error(`Phase 6 budget: ${code}`) }

function fresh() {
  return { logicalRequests: 0, sdkAttempts: 0, successfulCompletions: 0, failedSdkAttempts: 0,
    rejectedLogicalRequests: 0, preLogicalRejections: 0, rejectedSdkAttempts: 0,
    unfinishedSdkAttempts: 0, unfinishedLogicalRequests: 0, explicitLogicalFinishes: 0,
    inferredLegacyLogicalFinishes: 0, retriesScheduled: 0, scheduledCooldownSeconds: 0,
    reportedCumulativeWaitSeconds: 0, usageReportedCompletions: 0,
    sdkAttemptsWithUnknownUsage: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
    unknownInputTokenAttempts: 0, unknownOutputTokenAttempts: 0, unknownTotalTokenAttempts: 0 }
}
function add(entry, key, amount = 1) {
  const result = entry[key] + amount
  check(finite(result) && (key.endsWith('Seconds') || count(result)), 'aggregate_overflow')
  entry[key] = result
}
function finish(entry) {
  const result = { ...entry, reportedTokenSubtotals: Object.fromEntries(TOKENS.map(key => [key, entry[key]])) }
  for (const key of TOKENS) if (entry[`unknown${key[0].toUpperCase()}${key.slice(1, -1)}Attempts`] > 0) result[key] = null
  result.tokenUsageComplete = entry.sdkAttemptsWithUnknownUsage === 0
  result.logicalOutcomeComplete = entry.unfinishedLogicalRequests === 0
  result.observedAttemptAccountingComplete = entry.unfinishedSdkAttempts === 0
  return result
}
function safeUsage(event, scoped) {
  if (event.usage === undefined) {
    check(scoped ? event.usageAvailable === false : event.usageAvailable !== true, 'missing_reported_usage')
    return null
  }
  check(event.usageAvailable === true && object(event.usage) && Object.keys(event.usage).length > 0
    && Object.keys(event.usage).every(key => TOKENS.includes(key)) && Object.values(event.usage).every(count), 'unsafe_usage')
  return event.usage
}
function validateEvent(event, execution) {
  check(object(event) && Object.hasOwn(FIELDS, event.type) && ROLES.includes(event.modelRole)
    && REQUEST_ID.test(event.requestId ?? '') && event.executionId === execution.executionId
    && event.sessionId === execution.sessionId, 'foreign_model_event')
  const scoped = event.schemaVersion === SCOPED_SCHEMA
  const required = FIELDS[event.type].filter(key => !['requestSummary', 'diagnostic', 'usage', 'outputHash', 'usageAvailable'].includes(key))
  check(required.every(key => Object.hasOwn(event, key)), 'missing_model_event_fields')
  check(event.schemaVersion === undefined || scoped, 'unknown_model_event_schema')
  check(event.modelRole !== 'child_actor' || scoped, 'unversioned_child_model_event')
  const allowed = new Set([...ENVELOPE, ...COMMON, ...(scoped ? SCOPED : []), ...FIELDS[event.type]])
  check(Object.keys(event).every(key => allowed.has(key)), 'unsafe_model_event_fields')
  if (scoped) {
    check(SCOPED.every(key => Object.hasOwn(event, key)) && HASH.test(event.modelScopeHash ?? '')
      && HASH.test(event.configHash ?? '') && HASH.test(event.actualInputHash ?? '')
      && REQUEST_ID.test(event.permitId ?? ''), 'invalid_scoped_identity')
    if (event.modelRole === 'child_actor') check(event.parentExecutionId === execution.executionId
      && event.parentSessionId === execution.sessionId && IDENTIFIER.test(event.childExecutionId ?? '')
      && IDENTIFIER.test(event.childSessionId ?? '') && HASH.test(event.delegationScopeHash ?? ''), 'invalid_child_envelope')
  } else check(!['model_logical_request_started', 'model_logical_request_finished', 'model_request_rejected'].includes(event.type), 'legacy_has_scoped_lifecycle')
  if (Object.hasOwn(event, 'time')) check(finite(event.time), 'invalid_event_time')
  if (OPERATIONAL.some(key => Object.hasOwn(event, key))) check(count(event.requestAttempt) && event.requestAttempt > 0
    && count(event.maxRequestAttempts) && event.maxRequestAttempts >= event.requestAttempt
    && finite(event.cumulativeWaitSeconds), 'invalid_attempt_counters')
  if (Object.hasOwn(event, 'category')) check(['configuration_error', 'rate_limit', 'request_timeout', 'transport_error', 'runtime_error'].includes(event.category)
    && typeof event.retryable === 'boolean' && typeof event.retryExhausted === 'boolean'
    && (event.httpStatus === null || count(event.httpStatus) && event.httpStatus >= 100 && event.httpStatus <= 599), 'unsafe_failure_metadata')
  if (Object.hasOwn(event, 'nextRetryAt')) check(event.nextRetryAt === null
    || typeof event.nextRetryAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(event.nextRetryAt), 'invalid_retry_deadline')
  if (event.type === 'model_retry_scheduled') check(finite(event.waitSeconds) && finite(event.cumulativeWaitSecondsAfterRetry)
    && ['retry_after', 'retry_after_ms', 'structured_cooldown', 'exponential_backoff'].includes(event.delaySource), 'invalid_cooldown')
  if (event.type === 'model_retry_waiting') check(finite(event.remainingWaitSeconds), 'invalid_cooldown')
  if (event.type === 'model_request_rejected') check(REJECTION_CODES.has(event.failureCode), 'unsafe_rejection_code')
  if (event.type === 'model_request_succeeded') { if (scoped) check(HASH.test(event.outputHash ?? ''), 'invalid_output_hash'); safeUsage(event, scoped) }
  if (event.type === 'model_logical_request_finished') check(['succeeded', 'failed', 'rejected'].includes(event.status) && count(event.sdkAttempts), 'invalid_logical_finish')
  return scoped
}

/** Pure accounting over already bound streams; not an authority verifier.
 * Legacy and versioned events stay distinct. No synthetic permits/lifecycle
 * events are created, and native actions/model_response are never metered. */
export function aggregatePhase6Budget({ executions = [] } = {}) {
  check(Array.isArray(executions), 'invalid_executions')
  const total = fresh(), byRole = Object.fromEntries(ROLES.map(role => [role, fresh()])), byCapability = {}
  const identities = new Set(), requests = new Map(), permits = new Set(), scopes = new Map()
  const bySession = []
  for (const execution of executions) {
    check(object(execution) && ['runId', 'executionId', 'sessionId'].every(key => IDENTIFIER.test(execution[key] ?? ''))
      && ['standard', 'agent2agent', 'noise'].includes(execution.phase)
      && (execution.phase === 'standard' ? ['execution', 'search', 'adaptability', 'time', 'ambiguity'].includes(execution.config) : execution.config === 'mini')
      && Array.isArray(execution.events), 'invalid_execution')
    const identity = JSON.stringify([execution.runId, execution.executionId, execution.sessionId])
    check(!identities.has(identity), 'duplicate_session'); identities.add(identity)
    const capability = `${execution.phase}:${execution.config}`
    byCapability[capability] ??= fresh()
    const sessionTotal = fresh()
    bySession.push({ runId: execution.runId, executionId: execution.executionId, sessionId: execution.sessionId,
      phase: execution.phase, config: execution.config, metrics: sessionTotal })
    for (const event of execution.events) {
      // Actor invocation/response copies and Node completion ACKs are not SDK
      // events. A modelRole-bearing unknown type is rejected, not ignored.
      if (!object(event) || typeof event.type !== 'string') check(false, 'invalid_event')
      if (!Object.hasOwn(FIELDS, event.type)) {
        check(!event.type.startsWith('model_') || event.modelRole === undefined, 'unknown_model_event_type')
        continue
      }
      const scoped = validateEvent(event, execution)
      const entries = [total, byRole[event.modelRole], byCapability[capability], sessionTotal]
      const increment = (key, amount = 1) => entries.forEach(entry => add(entry, key, amount))
      if (scoped) {
        const scopeKey = JSON.stringify([identity, event.modelScopeHash]), value = scopes.get(scopeKey)
        check(!value || value.role === event.modelRole && value.configHash === event.configHash, 'model_scope_changed')
        scopes.set(scopeKey, { role: event.modelRole, configHash: event.configHash })
      }
      const key = JSON.stringify([identity, event.modelRole, scoped ? event.modelScopeHash : null, event.requestId])
      let request = requests.get(key)
      if (!request && scoped && event.type === 'model_request_rejected') {
        check(!permits.has(JSON.stringify([identity, event.permitId])), 'reused_prelogical_permit')
        permits.add(JSON.stringify([identity, event.permitId])); increment('preLogicalRejections')
        requests.set(key, { preLogical: true, scoped, finished: true, entries })
        continue
      }
      if (event.type === 'model_logical_request_started' || !scoped && !request && event.type === 'model_request_attempt') {
        check(!request, 'duplicate_logical_request')
        if (scoped) {
          const permitKey = JSON.stringify([identity, event.permitId])
          check(!permits.has(permitKey), 'duplicate_permit'); permits.add(permitKey)
        }
        request = { entries, scoped, identity: scoped ? Object.fromEntries(SCOPED.map(key => [key, event[key]])) : null,
          attempts: [], pending: null, scheduled: false, succeeded: false, rejected: false, finished: false,
          lastFailure: null, reportedWait: 0, maximumAttempts: null }
        requests.set(key, request); increment('logicalRequests')
        if (scoped) continue
      }
      check(request && !request.preLogical && !request.finished && request.scoped === scoped, 'unbound_request_event')
      if (scoped) check(SCOPED.every(key => request.identity[key] === event[key]), 'request_identity_changed')
      if (Object.hasOwn(event, 'cumulativeWaitSeconds')) {
        if (request.maximumAttempts === null) request.maximumAttempts = event.maxRequestAttempts
        check(event.maxRequestAttempts === request.maximumAttempts, 'attempt_budget_changed')
        check(event.cumulativeWaitSeconds >= request.reportedWait, 'wait_counter_decreased')
        request.reportedWait = event.cumulativeWaitSeconds
      }
      if (event.type === 'model_request_attempt') {
        check(!request.pending && !request.succeeded && !request.rejected
          && event.requestAttempt === request.attempts.length + 1
          && (request.attempts.length === 0 || request.scheduled), 'invalid_sdk_sequence')
        request.pending = { ordinal: event.requestAttempt, outcome: null, usage: null }
        request.attempts.push(request.pending); request.scheduled = false; increment('sdkAttempts'); continue
      }
      if (event.type === 'model_request_succeeded' || event.type === 'model_request_failed') {
        check(request.pending && event.requestAttempt === request.pending.ordinal, 'unbound_sdk_outcome')
        const attempt = request.pending; request.pending = null
        if (event.type === 'model_request_failed') {
          attempt.outcome = 'failed'; request.lastFailure = event; increment('failedSdkAttempts'); continue
        }
        attempt.outcome = 'succeeded'; attempt.usage = safeUsage(event, scoped)
        request.succeeded = true; increment('successfulCompletions')
        if (attempt.usage) increment('usageReportedCompletions')
        for (const token of TOKENS) if (attempt.usage && Object.hasOwn(attempt.usage, token)) increment(token, attempt.usage[token])
        continue
      }
      if (event.type === 'model_retry_scheduled') {
        check(!request.pending && !request.scheduled && !request.succeeded && request.lastFailure
          && event.requestAttempt === request.attempts.length && event.retryable && !event.retryExhausted
          && ['category', 'retryable', 'httpStatus', 'nextRetryAt', 'retryExhausted'].every(key => event[key] === request.lastFailure[key])
          && event.cumulativeWaitSecondsAfterRetry === event.cumulativeWaitSeconds + event.waitSeconds, 'invalid_retry_sequence')
        request.scheduled = true; increment('retriesScheduled'); increment('scheduledCooldownSeconds', event.waitSeconds); continue
      }
      if (event.type === 'model_retry_waiting') {
        check(request.scheduled && event.requestAttempt === request.attempts.length, 'unbound_retry_wait'); continue
      }
      if (event.type === 'model_request_rejected') {
        check(!request.rejected && !request.succeeded, 'duplicate_rejection')
        request.rejected = true
        if (request.pending) { request.pending.outcome = 'rejected'; request.pending = null; increment('rejectedSdkAttempts') }
        increment('rejectedLogicalRequests'); continue
      }
      check(event.type === 'model_logical_request_finished' && event.sdkAttempts === request.attempts.length
        && (event.status !== 'succeeded' || request.succeeded && !request.pending && !request.rejected)
        && (event.status !== 'failed' || request.lastFailure && !request.pending && !request.succeeded && !request.rejected
          && !request.scheduled && (!request.lastFailure.retryable || request.lastFailure.retryExhausted))
        && (event.status !== 'rejected' || request.rejected && !request.pending), 'invalid_logical_finish')
      request.finished = true; increment('explicitLogicalFinishes')
    }
  }
  for (const request of requests.values()) {
    if (request.preLogical) continue
    const increment = (key, amount = 1) => request.entries.forEach(entry => add(entry, key, amount))
    if (!request.scoped && (request.succeeded || request.lastFailure && !request.pending && !request.scheduled)) {
      request.finished = true; increment('inferredLegacyLogicalFinishes')
    }
    if (!request.finished) increment('unfinishedLogicalRequests')
    increment('reportedCumulativeWaitSeconds', request.reportedWait)
    for (const attempt of request.attempts) {
      if (attempt.outcome === null) increment('unfinishedSdkAttempts')
      const usage = attempt.outcome === 'succeeded' ? attempt.usage : null
      if (!usage || TOKENS.some(key => !Object.hasOwn(usage, key))) increment('sdkAttemptsWithUnknownUsage')
      for (const token of TOKENS) if (!usage || !Object.hasOwn(usage, token)) increment(`unknown${token[0].toUpperCase()}${token.slice(1, -1)}Attempts`)
    }
  }
  return { schemaVersion: 'gaia2-phase6-budget-usage-v1', executedSessions: identities.size, totals: finish(total),
    byRole: Object.fromEntries(ROLES.map(role => [role, finish(byRole[role])])),
    byCapability: Object.fromEntries(Object.entries(byCapability).map(([key, entry]) => [key, finish(entry)])),
    bySession: bySession.map(row => ({ ...row, metrics: finish(row.metrics) })),
    legacyLogicalOutcomeEvidence: 'request_id_group_outcomes_inferred_no_synthetic_lifecycle_events',
    scopedLogicalOutcomeEvidence: 'versioned_started_finished_events',
    actualHttpDispatches: null, sdkAttemptsAreInvocationsNotHttpProof: true,
    actualCooldownWallMs: null, cooldownCountersAreNotAdditionalProcessTime: true,
    monetaryCost: null, monetaryCostStatus: 'provider_unit_prices_not_supplied',
    forecast: null, forecastStatus: 'insufficient_stratified_samples', authorityVerified: false }
}

function safeFile(root, value) {
  check(typeof value === 'string' && value && !isAbsolute(value) && !win32.isAbsolute(value), 'unsafe_source_path')
  const path = portable(value)
  check(!/[\0:]/.test(path) && !path.split('/').some(part => !part || part === '.' || part === '..'), 'unsafe_source_path')
  const file = resolve(root, path)
  check(within(root, file) && file !== resolve(root), 'source_path_escape')
  for (let at = file; ; at = dirname(at)) { check(!lstatSync(at).isSymbolicLink(), 'symbolic_source_path'); if (at === dirname(at)) break }
  check(lstatSync(file).isFile(), 'source_not_regular_file')
  return file
}
function sourceReader(root) {
  const cache = new Map()
  return path => {
    path = portable(path)
    if (!cache.has(path)) cache.set(path, Buffer.from(readFileSync(safeFile(root, path))))
    return Buffer.from(cache.get(path))
  }
}
function diskInventory(root, value) {
  const base = resolve(root, value)
  check(within(root, base) && base !== resolve(root) && existsSync(base), 'unsafe_disk_directory')
  for (let at = base; ; at = dirname(at)) { check(!lstatSync(at).isSymbolicLink(), 'symbolic_disk_ancestor'); if (at === dirname(at)) break }
  const stack = [base], inventory = []
  while (stack.length) {
    const entry = stack.pop(), stat = lstatSync(entry)
    check(!stat.isSymbolicLink(), 'symbolic_disk_entry')
    if (stat.isFile()) inventory.push({ path: portable(relative(root, entry)), bytes: stat.size })
    else if (stat.isDirectory()) for (const name of readdirSync(entry)) stack.push(join(entry, name))
    else check(false, 'non_regular_disk_entry')
  }
  inventory.sort((a, b) => a.path.localeCompare(b.path))
  return { directory: portable(relative(root, base)), files: inventory.length,
    logicalBytes: inventory.reduce((total, entry) => { check(count(total + entry.bytes), 'disk_overflow'); return total + entry.bytes }, 0),
    inventoryHash: digest(inventory), allocatedBytes: null, contentDeduplicated: false }
}

function healthBudget(root, paths, reader, manifest) {
  check(Array.isArray(paths) && new Set(paths).size === paths.length, 'duplicate_health_report')
  const records = []
  for (const path of paths) {
    const bytes = reader(path), value = JSON.parse(bytes)
    check(['gaia2-model-service-health-v1', 'gaia2-model-service-stability-v1', 'gaia2-model-service-recheck-record-v1'].includes(value.schemaVersion), 'unsupported_health_report')
    if (value.runId !== undefined) check(value.runId === manifest.runId && value.manifestHash === manifest.manifestHash, 'foreign_health_report')
    const samples = Array.isArray(value.samples) ? value.samples : [value]
    const chatTimes = samples.map(sample => sample.chatElapsedMs ?? sample.elapsedMs ?? sample.checks?.chatCompletions?.elapsedMs)
    check(chatTimes.every(time => time === undefined || finite(time)), 'invalid_health_time')
    records.push({ source: { path: portable(path), sha256: sha(bytes) }, recordedCompletionChecks: samples.length,
      checkSpanMs: finite(value.elapsedMs) ? value.elapsedMs : null,
      reportedChatElapsedMs: chatTimes.every(finite) ? chatTimes.reduce((a, b) => a + b, 0) : null,
      unknownTokenCompletionChecks: samples.length, tokens: null, monetaryCost: null })
  }
  return { status: paths.length ? 'observed_reports_only' : 'not_provided', records,
    recordedCompletionChecks: paths.length ? records.reduce((a, b) => a + b.recordedCompletionChecks, 0) : null,
    sdkAttempts: null, actualHttpDispatches: null, tokens: null, monetaryCost: null,
    benchmarkSdkAttemptsIncluded: false, healthReportsDoNotProveAllHealthChecksCovered: true }
}

/** Read immutable/current snapshots only; never executes a model, changes a
 * frozen batch, consults current locks, or imports results into another run. */
export function buildPhase6BudgetReport({ root, manifestPath, executionIds = null, onlyPhase = null,
  onlyRunNumber = null, rule = null, exportDir = null, healthReportPaths = [] } = {}) {
  check(typeof root === 'string' && typeof manifestPath === 'string', 'missing_report_input')
  root = resolve(root)
  if (isAbsolute(manifestPath)) manifestPath = portable(relative(root, manifestPath))
  const reader = sourceReader(root), read = path => JSON.parse(reader(path)), ref = path => ({ path: portable(path), sha256: sha(reader(path)) })
  const manifest = read(manifestPath), { manifestHash, ...contents } = manifest
  check(manifest.schemaVersion === 'gaia2-run-manifest-v1' && manifestHash === digest(contents)
    && IDENTIFIER.test(manifest.runId ?? '') && HASH.test(manifest.planFingerprint ?? ''), 'manifest_binding_invalid')
  check(portable(manifest.runRoot) === `runs/${manifest.runId}`
    && portable(manifest.stateFile) === `${portable(manifest.runRoot)}/run-state.json`
    && portable(manifestPath) === `${portable(manifest.runRoot)}/run-manifest.json`, 'manifest_location_invalid')
  const state = read(manifest.stateFile), runtimePath = portable(join(manifest.runRoot, 'runtime-settings.json')), runtime = read(runtimePath)
  check(state.schemaVersion === 'gaia2-run-state-v1' && state.runId === manifest.runId
    && state.manifestHash === manifestHash && state.runtimeHash === digest(runtime)
    && Array.isArray(state.tasks) && digest(state.tasks.map(task => task.executionId)) === digest(manifest.tasks.map(task => task.executionId)), 'state_or_runtime_binding_invalid')
  const selectedIds = selectPhase6ExecutionIds(manifest, { executionIds, onlyPhase, onlyRunNumber, rule }), selectedTasks = manifest.tasks.filter(task => selectedIds.includes(task.executionId))
  const executions = [], rows = [], excludedSessions = [], unknownExecutions = [], allSessionKeys = new Set()
  const duration = { areMs: 0, hostMs: 0, sessionMs: 0, unknownAreSessions: 0, unknownHostSessions: 0, unknownSessionSessions: 0 }
  const disk = { outputLogicalBytes: 0, workspaceLogicalBytes: 0, fixtureLogicalBytes: 0, allocatedBytes: null }
  for (const task of selectedTasks) {
    for (const [key, bucket] of [['outputDir', 'executions'], ['workspaceDir', 'workspaces'], ['fixtureDir', 'fixtures']])
      check(portable(task[key]) === `${portable(manifest.runRoot)}/${bucket}/${task.executionId}`, 'task_directory_binding_invalid')
    const record = state.tasks.find(record => record.executionId === task.executionId)
    check(['pending', 'running', 'completed', 'retry_pending', 'terminal_failure'].includes(record.status)
      && Array.isArray(record.sessions), 'invalid_task_state')
    if (!record.sessions.length) { unknownExecutions.push({ executionId: task.executionId, reason: 'not_executed' }); continue }
    for (let index = 0; index < record.sessions.length; index++) {
      const session = record.sessions[index], sessionKey = JSON.stringify([manifest.runId, task.executionId, session.sessionId])
      check(IDENTIFIER.test(session.sessionId ?? '') && !allSessionKeys.has(sessionKey)
        && session.sessionOrdinal === index + 1 && session.parentSessionId === (index ? record.sessions[index - 1].sessionId : null), 'invalid_session_lineage')
      allSessionKeys.add(sessionKey)
      for (const key of ['outputDir', 'workspaceDir', 'fixtureDir']) check(portable(session[key]) === portable(join(task[key], 'sessions', session.sessionId)), 'foreign_session_path')
      if (!session.endedAt) { excludedSessions.push({ executionId: task.executionId, sessionId: session.sessionId, reason: 'running_not_terminal' }); continue }
      const resultPath = portable(join(session.workspaceDir, 'task-result.json')), eventsPath = portable(join(session.outputDir, 'runtime-events.jsonl'))
      const processPath = portable(join(session.outputDir, 'process-result.json')), hostPath = portable(join(session.outputDir, 'hook-host/process-result.json'))
      const resultBytes = reader(resultPath), result = JSON.parse(resultBytes)
      check(result.schemaVersion === 'gaia2-task-result-v1' && result.runId === manifest.runId && result.manifestHash === manifestHash
        && result.runtimeHash === state.runtimeHash && result.executionId === task.executionId && result.sessionId === session.sessionId
        && ['scenarioId', 'runNumber', 'phase', 'config'].every(key => result[key] === task[key]), 'result_identity_invalid')
      check(typeof result.evaluationComplete === 'boolean'
        && (result.evaluationComplete ? typeof result.businessPassed === 'boolean'
          && result.score === (result.businessPassed ? 1 : 0) : result.businessPassed === null && result.score === null), 'invalid_result_outcome')
      const latest = index === record.sessions.length - 1
      if (latest) check(portable(record.resultPath) === resultPath && record.resultSha256 === sha(resultBytes), 'result_sha_binding_invalid')
      const process = read(processPath), host = read(hostPath), events = reader(eventsPath).toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
      check(process.schemaVersion === 'gaia2-process-result-v1' && host.schemaVersion === 'gaia2-process-result-v1'
        && process.childExited === true && process.childClosed === true && host.childExited === true && host.childClosed === true, 'session_process_not_terminal')
      check(events.every(event => object(event) && event.executionId === task.executionId && event.sessionId === session.sessionId), 'foreign_runtime_stream')
      const attestation = result.runtimeAttestation
      const sealPresent = object(attestation) && attestation.eventsHash === digest(events)
        && attestation.evidenceHash === digest(result.runtimeEvidence)
      if (object(attestation)) check(sealPresent, 'runtime_seal_changed')
      if (!sealPresent) {
        unknownExecutions.push({ executionId: task.executionId, sessionId: session.sessionId, reason: 'runtime_stream_not_independently_sealed' })
        continue
      }
      // Full verification is deliberately independent of the accounting parser.
      // Its failure cannot be downgraded by a well-formed usage event stream.
      validateRuntimeEvidence({ manifest, task, session, events, runtimeAttestation: attestation,
        runtimeEvidence: result.runtimeEvidence, readEvidence: reader })
      const sources = { result: ref(resultPath), events: ref(eventsPath), areProcess: ref(processPath), hostProcess: ref(hostPath),
        runtimeEvidenceHash: digest(result.runtimeEvidence), independentlyStateBoundResult: latest }
      const times = { areMs: finite(process.elapsedMs) ? process.elapsedMs : null,
        hostMs: finite(host.elapsedMs) ? host.elapsedMs : null,
        sessionMs: Number.isFinite(Date.parse(session.startedAt)) && Number.isFinite(Date.parse(session.endedAt))
          && Date.parse(session.endedAt) >= Date.parse(session.startedAt) ? Date.parse(session.endedAt) - Date.parse(session.startedAt) : null }
      for (const [key, value] of Object.entries(times)) if (value === null) duration[`unknown${key[0].toUpperCase()}${key.slice(1, -2)}Sessions`]++
      else { check(finite(duration[key] + value), 'time_aggregate_overflow'); duration[key] += value }
      const storage = { output: diskInventory(root, session.outputDir), workspace: diskInventory(root, session.workspaceDir), fixture: diskInventory(root, session.fixtureDir) }
      for (const key of ['output', 'workspace', 'fixture']) disk[`${key}LogicalBytes`] += storage[key].logicalBytes
      executions.push({ runId: manifest.runId, executionId: task.executionId, sessionId: session.sessionId, phase: task.phase, config: task.config, events })
      rows.push({ executionId: task.executionId, sessionId: session.sessionId, phase: task.phase, config: task.config,
        evaluationComplete: result.evaluationComplete === true, score: result.score, historicalSession: !latest,
        sources, timing: times, disk: storage })
      if (!latest) unknownExecutions.push({ executionId: task.executionId, sessionId: session.sessionId, reason: 'historical_result_has_no_state_sha_anchor_accounting_is_sealed_observed_subtotal' })
    }
  }
  const usage = aggregatePhase6Budget({ executions })
  let exported = { status: 'not_provided', package: null, conversion: null, reportedConversionElapsedMs: null, overallExportElapsedMs: null }
  if (exportDir !== null) {
    if (isAbsolute(exportDir)) exportDir = portable(relative(root, exportDir))
    const exportManifestPath = portable(join(exportDir, 'export-manifest.json')), exportedManifest = read(exportManifestPath)
    check(exportedManifest.schemaVersion === 'gaia2-export-manifest-v1' && exportedManifest.sourceRunId === manifest.runId
      && exportedManifest.manifestHash === manifestHash && exportedManifest.runtimeHash === state.runtimeHash
      && Array.isArray(exportedManifest.records), 'export_manifest_binding_invalid')
    const exportIds = exportedManifest.records.map(record => record.executionId)
    check(new Set(exportIds).size === exportIds.length && exportIds.every(id => manifest.tasks.some(task => task.executionId === id)), 'export_record_inventory_invalid')
    for (const record of exportedManifest.records) for (const key of ['result', 'processResult', 'runtimeEvents']) {
      const source = record[key]
      check(object(source) && HASH.test(source.sha256 ?? '')
        && typeof source.path === 'string' && source.path && !isAbsolute(source.path) && !win32.isAbsolute(source.path)
        && !/[\\\0:]/.test(source.path) && !source.path.split('/').some(part => !part || part === '.' || part === '..')
        && sha(reader(portable(join(exportDir, source.path)))) === source.sha256, 'export_evidence_sha_invalid')
    }
    exported = { status: 'observed_package', source: ref(exportManifestPath), package: diskInventory(root, exportDir),
      recordedExecutions: exportIds, selectedCoverageComplete: selectedIds.every(id => exportIds.includes(id)),
      conversion: null, conversionProcesses: [], reportedConversionElapsedMs: null, overallExportElapsedMs: null }
    const conversionDir = `${exportDir}-conversion`
    if (existsSync(resolve(root, conversionDir))) {
      exported.conversion = diskInventory(root, conversionDir)
      for (const entry of readdirSync(resolve(root, conversionDir))) {
        const processPath = portable(join(conversionDir, entry, 'process/process-result.json'))
        if (!existsSync(resolve(root, processPath))) continue
        const process = read(processPath)
        check(process.schemaVersion === 'gaia2-process-result-v1' && finite(process.elapsedMs), 'invalid_conversion_process')
        exported.conversionProcesses.push({ source: ref(processPath), elapsedMs: process.elapsedMs, exitCode: process.exitCode })
      }
      exported.reportedConversionElapsedMs = exported.conversionProcesses.reduce((sum, process) => sum + process.elapsedMs, 0)
    }
  }
  const healthChecks = healthBudget(root, healthReportPaths, reader, manifest)
  const scopeExecutionComplete = selectedTasks.every(task => {
    const record = state.tasks.find(record => record.executionId === task.executionId)
    return ['completed', 'terminal_failure'].includes(record.status) && record.sessions.length > 0 && record.sessions.every(session => session.endedAt)
  })
  const measuredTiming = { ...duration, reportedProcessTimeSubtotals: { areMs: duration.areMs, hostMs: duration.hostMs, sessionMs: duration.sessionMs } }
  for (const key of ['Are', 'Host', 'Session']) if (duration[`unknown${key}Sessions`] > 0)
    measuredTiming[`${key[0].toLowerCase()}${key.slice(1)}Ms`] = null
  return { schemaVersion: 'gaia2-phase6-budget-report-v1', status: 'audited',
    binding: { runId: manifest.runId, manifestHash, planFingerprint: manifest.planFingerprint, runtimeHash: state.runtimeHash,
      selectionIdentityHash: selectionIdentityHash(manifest, selectedIds), manifest: ref(manifestPath), state: ref(manifest.stateFile), runtime: ref(runtimePath) },
    scope: { executionIds: selectedIds, selectedExecutions: selectedIds.length, executedSessions: rows.length,
      observedUniqueExecutions: new Set(rows.map(row => row.executionId)).size, excludedSessions,
      scopeExecutionComplete, independentEvidenceComplete: unknownExecutions.length === 0 },
    usage, rows, unknownExecutions, timing: { ...measuredTiming, processTimesOverlapDoNotAdd: true,
      sessionTimeIncludesCooldownAndSetup: true, officialStatsZeroIsNotObservedWallTime: true },
    disk: { ...disk, sourceLogicalBytes: disk.outputLogicalBytes + disk.workspaceLogicalBytes + disk.fixtureLogicalBytes,
      scope: 'metered_terminal_session_directories_only', bytesAreLogicalNotAllocated: true }, export: exported, healthChecks,
    observedAttemptAccountingComplete: usage.totals.observedAttemptAccountingComplete && unknownExecutions.length === 0 && excludedSessions.length === 0,
    logicalOutcomeComplete: usage.totals.logicalOutcomeComplete && unknownExecutions.length === 0 && excludedSessions.length === 0,
    tokenUsageComplete: usage.totals.tokenUsageComplete && unknownExecutions.length === 0 && excludedSessions.length === 0,
    monetaryCost: null, monetaryCostStatus: 'provider_unit_prices_not_supplied', forecast: null,
    forecastStatus: 'insufficient_stratified_samples', noModelExecution: true, officialSubmissionReady: false,
    sourceStateChanged: false, generatedAt: new Date().toISOString() }
}
