import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { aggregatePhase5ModelUsage } from '../src/phase5_model_usage.mjs'
import { aggregateOperationalUsage } from '../src/phase4_cost.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const python = process.env.GAIA2_PYTHON || 'C:/Users/pkc00/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
const hashes = { actor: 'a'.repeat(64), child_actor: 'b'.repeat(64), judge: 'c'.repeat(64), correction: 'd'.repeat(64) }
function events(role, serial = 1, { retry = false, usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, failure = false, rejected = false } = {}) {
  const base = { schemaVersion: 'gaia2-scoped-model-event-v1', modelRole: role, modelScopeHash: hashes[role],
    configHash: 'e'.repeat(64), permitId: serial.toString(16).padStart(32, '0'),
    requestId: (serial + 1000).toString(16).padStart(32, '0'), actualInputHash: 'f'.repeat(64) }
  const event = (type, fields = {}) => ({ type, ...base, ...fields })
  const operational = attempt => ({ requestAttempt: attempt, maxRequestAttempts: 2, cumulativeWaitSeconds: attempt === 2 ? 2 : 0 })
  const failed = attempt => ({ ...operational(attempt), category: 'rate_limit', retryable: true,
    httpStatus: 429, nextRetryAt: '2026-10-09T00:00:02Z', retryExhausted: failure })
  const result = [event('model_logical_request_started'), event('model_request_attempt', operational(1))]
  if (retry || failure || rejected) result.push(event('model_request_failed', failed(1)))
  if (failure) return [...result, event('model_logical_request_finished', { status: 'failed', sdkAttempts: 1 })]
  if (retry || rejected) result.push(event('model_retry_scheduled', { ...failed(1), waitSeconds: 2,
    delaySource: 'retry_after', cumulativeWaitSecondsAfterRetry: 2 }))
  if (rejected) return [...result, event('model_request_rejected', { failureCode: 'SCOPED_MODEL_ATTEMPT_DENIED' }),
    event('model_logical_request_finished', { status: 'rejected', sdkAttempts: 1 })]
  if (retry) result.push(event('model_request_attempt', operational(2)))
  result.push(event('model_request_succeeded', { ...operational(retry ? 2 : 1), outputHash: '0'.repeat(64),
    usageAvailable: usage !== null, ...(usage === null ? {} : { usage }) }),
  event('model_logical_request_finished', { status: 'succeeded', sdkAttempts: retry ? 2 : 1 }))
  return result
}

test('scoped Python broker uses actual ARE types and offline SDK callbacks only', () => {
  const run = spawnSync(python, ['-B', join(root, 'test/phase5_scoped_model_broker_test.py')],
    { cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', HF_HUB_OFFLINE: '1', LITELLM_LOCAL_MODEL_COST_MAP: 'True' } })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stderr, /^Ran 17 tests in [\d.]+s\r?$/m)
  assert.match(run.stderr, /^OK\r?$/m)
  assert.equal(run.stdout, '')
})

test('one logical request with two SDK attempts never becomes a native action', () => {
  const usage = aggregatePhase5ModelUsage({ executions: [{ executionId: 'controlled', events: events('child_actor', 1, { retry: true }), nativeActions: [] }] })
  assert.equal(usage.schemaVersion, 'gaia2-phase5-model-usage-v1')
  assert.equal(usage.totals.logicalRequests, 1)
  assert.equal(usage.totals.sdkAttempts, 2)
  assert.equal(usage.totals.failedSdkAttempts, 1)
  assert.equal(usage.totals.successfulCompletions, 1)
  assert.equal(usage.totals.retriesScheduled, 1)
  assert.equal(usage.nativeActionCount, 0)
  assert.equal(usage.nativeActionsCountedAsSdkAttempts, 0)
  assert.equal(usage.sdkAttemptsCountedAsNativeActions, 0)
  assert.equal(usage.sdkAttemptsAreInvocationsNotHttpProof, true)
  assert.equal(usage.byRole.actor.sdkAttempts, 0)
  assert.equal(usage.byRole.child_actor.sdkAttempts, 2)
  assert.equal(usage.byModelScopeHash[hashes.child_actor].modelRole, 'child_actor')
  assert.equal(usage.totals.inputTokens, null) // Failed SDK usage is unknown, not free.
  assert.deepEqual(usage.totals.reportedTokenSubtotals, { inputTokens: 2, outputTokens: 3, totalTokens: 5 })
})

test('interleaved actor child judge correction scope identities remain separate', () => {
  const roleEvents = Object.keys(hashes).map((role, index) => events(role, index + 1))
  const interleaved = Array.from({ length: 4 }, (_, index) => roleEvents.map(stream => stream[index])).flat()
  const usage = aggregatePhase5ModelUsage({ executions: [{ executionId: 'roles', events: interleaved,
    nativeActions: [{ dispatchId: 'native-1' }, { dispatchId: 'native-2' }] }] })
  assert.equal(usage.totals.logicalRequests, 4)
  assert.equal(usage.totals.sdkAttempts, 4)
  assert.equal(usage.nativeActionCount, 2)
  assert.deepEqual(usage.totals.reportedTokenSubtotals, { inputTokens: 8, outputTokens: 12, totalTokens: 20 })
  for (const role of Object.keys(hashes)) {
    assert.equal(usage.byRole[role].logicalRequests, 1)
    assert.equal(usage.byRole[role].sdkAttempts, 1)
    assert.equal(usage.byModelScopeHash[hashes[role]].configHash, 'e'.repeat(64))
  }
})

test('unknown or partial tokens and absent native evidence remain null cost/counts', () => {
  const usage = aggregatePhase5ModelUsage({ executions: [{ executionId: 'unknown',
    events: [...events('actor', 1, { usage: null }), ...events('judge', 2, { usage: { inputTokens: 7 } })] }] })
  assert.equal(usage.monetaryCost, null)
  assert.equal(usage.nativeActionCount, null)
  assert.equal(usage.unknownNativeActionExecutions, 1)
  assert.equal(usage.totals.inputTokens, null)
  assert.equal(usage.totals.outputTokens, null)
  assert.equal(usage.totals.totalTokens, null)
  assert.equal(usage.byRole.judge.inputTokens, 7)
  assert.equal(usage.byRole.judge.outputTokens, null)
  assert.deepEqual(usage.totals.reportedTokenSubtotals, { inputTokens: 7, outputTokens: 0, totalTokens: 0 })
})

test('late SDK gate revocation counts a rejected logical request without a second SDK call', () => {
  const usage = aggregatePhase5ModelUsage({ executions: [{ executionId: 'revoked',
    events: events('child_actor', 1, { rejected: true }), nativeActions: [] }] })
  assert.equal(usage.totals.logicalRequests, 1)
  assert.equal(usage.totals.sdkAttempts, 1)
  assert.equal(usage.totals.rejectedLogicalRequests, 1)
  assert.equal(usage.totals.failedLogicalRequests, 0)
  assert.equal(usage.modelUsageComplete, true)
  assert.equal(usage.monetaryCost, null)
})

test('permanent terminal failure is distinct from a logical or native retry', () => {
  const stream = events('judge', 1, { failure: true })
  Object.assign(stream[2], { category: 'configuration_error', retryable: false, httpStatus: 401, nextRetryAt: null, retryExhausted: false })
  const usage = aggregatePhase5ModelUsage({ executions: [{ executionId: 'permanent', events: stream, nativeActions: [] }] })
  assert.equal(usage.totals.sdkAttempts, 1)
  assert.equal(usage.totals.failedSdkAttempts, 1)
  assert.equal(usage.totals.failedLogicalRequests, 1)
  assert.equal(usage.totals.retriesScheduled, 0)
  assert.equal(usage.totals.totalTokens, null)
})

test('duplicate permits, successes, swapped role/configuration and unsafe fields fail closed', () => {
  const reject = stream => assert.throws(() => aggregatePhase5ModelUsage({ executions: [{ executionId: 'bad', events: stream }] }), /Phase 5 model usage:/)
  const first = events('actor')
  reject([...first, ...first])
  reject([...first.slice(0, 3), first[2], first[3]])
  for (const field of ['endpoint', 'api_key', 'messages', 'rawException', 'model']) {
    const stream = structuredClone(first); stream[1][field] = 'must not be accepted'
    reject(stream)
  }
  for (const changed of [{ modelRole: 'judge' }, { configHash: '9'.repeat(64) }, { actualInputHash: '9'.repeat(64) }, { permitId: '9'.repeat(32) }]) {
    const stream = structuredClone(first); Object.assign(stream[2], changed); reject(stream)
  }
  const maliciousUsage = structuredClone(first); maliciousUsage[2].usage.endpoint = 'secret'; reject(maliciousUsage)
  const maliciousCode = events('actor', 1, { rejected: true }); maliciousCode[4].failureCode = 'SCOPED_MODEL_RAW_SECRET'; reject(maliciousCode)
  const skippedAttempt = events('child_actor', 1, { retry: true }); skippedAttempt[4].requestAttempt = 3; reject(skippedAttempt)
})

test('unfinished evidence stays incomplete and duplicate native identities do not inflate totals', () => {
  const report = aggregatePhase5ModelUsage({ executions: [{ executionId: 'pending', events: events('child_actor').slice(0, 2), nativeActions: [] }] })
  assert.equal(report.modelUsageComplete, false)
  assert.equal(report.totals.unfinishedLogicalRequests, 1)
  assert.equal(report.totals.sdkAttemptsWithUnknownUsage, 1)
  assert.equal(report.totals.inputTokens, null)
  assert.throws(() => aggregatePhase5ModelUsage({ executions: [{ executionId: 'native-dup', events: [],
    nativeActions: [{ dispatchId: 'same' }, { dispatchId: 'same' }] }] }), /duplicate_native_action/)
})

test('legacy Stage 4 role enum is not broadened by the versioned Stage 5 aggregator', () => {
  assert.throws(() => aggregateOperationalUsage({ executions: [{ executionId: 'legacy', kind: 'initial',
    events: [{ type: 'model_request_attempt', modelRole: 'child_actor', requestId: 'child' }] }] }), /invalid model event identity/)
  const report = aggregatePhase5ModelUsage()
  assert.equal(report.legacyStage4EnumsChanged, false)
  assert.equal(report.monetaryCost, null)
})
