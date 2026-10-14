import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { digest } from '../src/phase0_run.mjs'
import { aggregateOperationalUsage } from '../src/phase4_cost.mjs'
import { aggregatePhase6Budget, buildPhase6BudgetReport, PHASE6_SCOPED_REJECTION_CODES } from '../src/phase6_budget.mjs'
import { parsePhase6BudgetArgs, runPhase6BudgetReport, writePhase6BudgetReport } from '../scripts/phase6_budget_report.mjs'
import { runtimeFixture } from './support/runtime_evidence_fixture.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sha = value => createHash('sha256').update(value).digest('hex')
const hexId = value => value.toString(16).padStart(32, '0')
const usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5 }
function execution(events = [], changes = {}) {
  return { runId: 'run-one', executionId: 'execution-one', sessionId: 'session-one', phase: 'agent2agent', config: 'mini', events, ...changes }
}
function stream(role, id = 1, { scoped = role === 'child_actor', tokenUsage = usage, retry = false,
  failure = false, rejected = false, preLogical = false } = {}) {
  const base = { executionId: 'execution-one', sessionId: 'session-one', modelRole: role, requestId: hexId(id + 1000) }
  if (scoped) Object.assign(base, { schemaVersion: 'gaia2-scoped-model-event-v1', modelScopeHash: 'a'.repeat(64),
    configHash: 'b'.repeat(64), actualInputHash: 'c'.repeat(64), permitId: hexId(id),
    ...(role === 'child_actor' ? { parentExecutionId: 'execution-one', parentSessionId: 'session-one',
      childExecutionId: 'child-one', childSessionId: 'child-session-one', delegationScopeHash: 'd'.repeat(64) } : {}) })
  const event = (type, fields = {}) => ({ type, ...base, ...fields })
  const operational = attempt => ({ requestAttempt: attempt, maxRequestAttempts: 2, cumulativeWaitSeconds: attempt === 2 ? 2 : 0 })
  const failed = attempt => ({ ...operational(attempt), category: 'rate_limit', retryable: !failure,
    httpStatus: failure ? 400 : 429, nextRetryAt: failure ? null : '2026-10-13T00:00:02Z', retryExhausted: false })
  if (preLogical) return [event('model_request_rejected', { failureCode: 'SCOPED_MODEL_INPUT_INVALID' })]
  const events = scoped ? [event('model_logical_request_started')] : []
  events.push(event('model_request_attempt', operational(1)))
  if (rejected) {
    events.push(event('model_request_rejected', { failureCode: 'SCOPED_MODEL_SAFE_POINT_DENIED' }))
    if (scoped) events.push(event('model_logical_request_finished', { status: 'rejected', sdkAttempts: 1 }))
    return events
  }
  if (retry || failure) events.push(event('model_request_failed', failed(1)))
  if (failure) {
    if (scoped) events.push(event('model_logical_request_finished', { status: 'failed', sdkAttempts: 1 }))
    return events
  }
  if (retry) events.push(event('model_retry_scheduled', { ...failed(1), waitSeconds: 2,
    delaySource: 'exponential_backoff', cumulativeWaitSecondsAfterRetry: 2 }), event('model_request_attempt', operational(2)))
  events.push(event('model_request_succeeded', { ...operational(retry ? 2 : 1), ...(scoped ? { outputHash: 'e'.repeat(64) } : {}),
    usageAvailable: tokenUsage !== null, ...(tokenUsage === null ? {} : { usage: structuredClone(tokenUsage) }) }))
  if (scoped) events.push(event('model_logical_request_finished', { status: 'succeeded', sdkAttempts: retry ? 2 : 1 }))
  return events
}
function aggregate(events, changes = {}) { return aggregatePhase6Budget({ executions: [execution(events, changes)] }) }

function trusted408Stream(role, id = 1) {
  const value = stream(role, id, { retry: true })
  for (const event of value.filter(event => ['model_request_failed', 'model_retry_scheduled'].includes(event.type))) {
    Object.assign(event, { category: 'request_timeout', httpStatus: 408,
      classificationSource: 'trusted_http_guard', httpStatusSource: 'trusted_http_guard',
      httpGuardClosedRecordSha256: '9'.repeat(64), diagnostic: { schemaVersion: 'gaia2-model-diagnostic-v1',
        sdkReportedStatus: 400, exceptionClass: 'BadRequestError', errorCode: null, codeSource: null,
        errorType: 'invalid_request_error', typeSource: 'sdk_body', dispatchObserved: null } })
    if (role === 'child_actor') delete event.diagnostic
  }
  return value
}

test('actor judge correction and child trusted408 markers are metered without losing failed usage', () => {
  const report = aggregate(['actor', 'judge', 'correction', 'child_actor'].flatMap((role, index) => trusted408Stream(role, index + 1)))
  assert.equal(report.totals.logicalRequests, 4)
  assert.equal(report.totals.sdkAttempts, 8)
  assert.equal(report.totals.failedSdkAttempts, 4)
  assert.equal(report.totals.retriesScheduled, 4)
  assert.equal(report.totals.sdkAttemptsWithUnknownUsage, 4)
  assert.equal(report.totals.totalTokens, null)
  assert.deepEqual(report.totals.reportedTokenSubtotals, { inputTokens: 8, outputTokens: 12, totalTokens: 20 })
  for (const role of ['actor', 'judge', 'correction', 'child_actor']) assert.equal(report.byRole[role].sdkAttempts, 2)
  assert.equal(report.authorityVerified, false)
})

test('trusted408 provenance is complete exact metadata rather than a budget authority claim', () => {
  for (const role of ['actor', 'judge', 'correction', 'child_actor']) {
    const original = trusted408Stream(role)
    const failedIndex = original.findIndex(event => event.type === 'model_request_failed')
    const scheduledIndex = original.findIndex(event => event.type === 'model_retry_scheduled')
    for (const field of ['classificationSource', 'httpStatusSource', 'httpGuardClosedRecordSha256']) {
      const changed = structuredClone(original)
      delete changed[failedIndex][field]
      assert.throws(() => aggregate(changed), /invalid_trusted_status_metadata/)
      const scheduleChanged = structuredClone(original)
      scheduleChanged[scheduledIndex][field] = field.endsWith('Sha256') ? '8'.repeat(64) : 'untrusted'
      assert.throws(() => aggregate(scheduleChanged), /invalid_trusted_status_metadata|invalid_retry_sequence/)
    }
    const removed = structuredClone(original)
    for (const field of ['classificationSource', 'httpStatusSource', 'httpGuardClosedRecordSha256']) delete removed[failedIndex][field]
    assert.throws(() => aggregate(removed), /invalid_trusted_status_metadata|invalid_retry_sequence/)
    const wrongStatus = structuredClone(original)
    wrongStatus[failedIndex].httpStatus = 400
    assert.throws(() => aggregate(wrongStatus), /invalid_trusted_status_metadata/)
  }
})

test('all child permit scope and session identity fields remain bound through retries and logical finish', () => {
  const original = trusted408Stream('child_actor')
  for (const field of ['permitId', 'actualInputHash', 'modelScopeHash', 'configHash', 'parentExecutionId',
    'parentSessionId', 'childExecutionId', 'childSessionId', 'delegationScopeHash']) {
    for (const index of [original.findIndex(event => event.type === 'model_retry_scheduled'), original.length - 1]) {
      const changed = structuredClone(original)
      changed[index][field] = field.endsWith('Hash') ? '8'.repeat(64) : field === 'permitId' ? hexId(8) : 'foreign'
      assert.throws(() => aggregate(changed), /request_identity_changed|invalid_child_envelope|unbound_request_event|model_scope_changed/)
    }
  }
})

test('legacy actor and versioned child stay separate; response/ACK copies never double count', () => {
  const events = [...stream('actor'), ...stream('child_actor', 2),
    { type: 'model_response', executionId: 'execution-one', sessionId: 'session-one', usage },
    { type: 'a2a_child_runtime_snapshot', executionId: 'execution-one', sessionId: 'session-one', usage },
    { type: 'node_completion_ack', executionId: 'execution-one', sessionId: 'session-one', usage }]
  const report = aggregate(events)
  assert.equal(report.totals.sdkAttempts, 2)
  assert.equal(report.totals.logicalRequests, 2)
  assert.equal(report.totals.explicitLogicalFinishes, 1)
  assert.equal(report.totals.inferredLegacyLogicalFinishes, 1)
  assert.deepEqual(report.totals.reportedTokenSubtotals, { inputTokens: 4, outputTokens: 6, totalTokens: 10 })
  assert.equal(report.byRole.actor.sdkAttempts, 1)
  assert.equal(report.byRole.child_actor.sdkAttempts, 1)
  assert.equal(report.actualHttpDispatches, null)
  assert.equal(report.monetaryCost, null)
  assert.equal(report.forecast, null)
})

test('Judge and correction are metered separately without widening Stage 4 enums', () => {
  const report = aggregate([...stream('judge'), ...stream('correction', 2)])
  assert.equal(report.byRole.judge.successfulCompletions, 1)
  assert.equal(report.byRole.correction.successfulCompletions, 1)
  assert.equal(report.byRole.actor.sdkAttempts, 0)
  assert.throws(() => aggregateOperationalUsage({ executions: [{ executionId: 'legacy', kind: 'initial', events: stream('child_actor') }] }), /invalid model event identity/)
})

test('retry is an SDK attempt, failed tokens remain unknown, cooldown is not added to process time', () => {
  const report = aggregate([...stream('actor', 1, { retry: true }), ...stream('child_actor', 2, { retry: true })])
  assert.equal(report.totals.logicalRequests, 2)
  assert.equal(report.totals.sdkAttempts, 4)
  assert.equal(report.totals.failedSdkAttempts, 2)
  assert.equal(report.totals.successfulCompletions, 2)
  assert.equal(report.totals.retriesScheduled, 2)
  assert.equal(report.totals.scheduledCooldownSeconds, 4)
  assert.equal(report.totals.reportedCumulativeWaitSeconds, 4)
  assert.equal(report.totals.sdkAttemptsWithUnknownUsage, 2)
  assert.equal(report.totals.totalTokens, null)
  assert.deepEqual(report.totals.reportedTokenSubtotals, { inputTokens: 4, outputTokens: 6, totalTokens: 10 })
  assert.equal(report.actualCooldownWallMs, null)
  assert.equal(report.totals.logicalOutcomeComplete, true)
})

test('STOP after SDK is rejected, not failed, successful, or a missing unfinished attempt', () => {
  const report = aggregate(stream('child_actor', 1, { rejected: true }))
  assert.equal(report.totals.sdkAttempts, 1)
  assert.equal(report.totals.rejectedSdkAttempts, 1)
  assert.equal(report.totals.rejectedLogicalRequests, 1)
  assert.equal(report.totals.failedSdkAttempts, 0)
  assert.equal(report.totals.successfulCompletions, 0)
  assert.equal(report.totals.unfinishedSdkAttempts, 0)
  assert.equal(report.totals.observedAttemptAccountingComplete, true)
  assert.equal(report.totals.logicalOutcomeComplete, true)
  assert.equal(report.totals.tokenUsageComplete, false)
  assert.equal(report.totals.totalTokens, null)
})

test('prelogical rejection is separate from a logical request and SDK attempt', () => {
  const report = aggregate(stream('child_actor', 1, { preLogical: true }))
  assert.equal(report.totals.preLogicalRejections, 1)
  assert.equal(report.totals.logicalRequests, 0)
  assert.equal(report.totals.sdkAttempts, 0)
  assert.equal(report.totals.rejectedLogicalRequests, 0)
  assert.equal(report.monetaryCost, null)
})

test('pending attempt and absent logical finish remain incomplete', () => {
  const report = aggregate(stream('child_actor').slice(0, 2))
  assert.equal(report.totals.unfinishedLogicalRequests, 1)
  assert.equal(report.totals.unfinishedSdkAttempts, 1)
  assert.equal(report.totals.sdkAttemptsWithUnknownUsage, 1)
  assert.equal(report.totals.tokenUsageComplete, false)
  assert.equal(report.totals.logicalOutcomeComplete, false)
  assert.equal(report.totals.observedAttemptAccountingComplete, false)
})

test('partial or absent successful usage stays unknown by token field', () => {
  const report = aggregate([...stream('actor', 1, { tokenUsage: null }), ...stream('child_actor', 2, { tokenUsage: { inputTokens: 7 } })])
  assert.equal(report.totals.successfulCompletions, 2)
  assert.equal(report.totals.usageReportedCompletions, 1)
  assert.equal(report.totals.sdkAttemptsWithUnknownUsage, 2)
  assert.equal(report.byRole.child_actor.inputTokens, 7)
  assert.equal(report.byRole.child_actor.outputTokens, null)
  assert.deepEqual(report.totals.reportedTokenSubtotals, { inputTokens: 7, outputTokens: 0, totalTokens: 0 })
  assert.equal(report.totals.totalTokens, null)
})

test('terminal failure and recovered session both cost attempts without duplicate slot inflation', () => {
  const first = execution(stream('actor', 1, { failure: true }))
  const second = execution(stream('actor').map(event => ({ ...event, sessionId: 'session-two' })), { sessionId: 'session-two' })
  const report = aggregatePhase6Budget({ executions: [first, second] })
  assert.equal(report.executedSessions, 2)
  assert.equal(report.totals.sdkAttempts, 2)
  assert.equal(report.totals.failedSdkAttempts, 1)
  assert.equal(report.totals.successfulCompletions, 1)
  assert.equal(report.totals.totalTokens, null)
  assert.equal(report.totals.logicalOutcomeComplete, true)
})

test('same request identity in different runs is independent; same session duplication rejects', () => {
  const first = execution(stream('actor'))
  assert.equal(aggregatePhase6Budget({ executions: [first, { ...first, runId: 'run-two' }] }).totals.sdkAttempts, 2)
  assert.throws(() => aggregatePhase6Budget({ executions: [first, first] }), /duplicate_session/)
})

test('finite rejection vocabulary matches current broker source; unknown codes reject', () => {
  const broker = readFileSync(join(root, 'scripts/gaia2_scoped_model_broker.py'), 'utf8')
  const actual = [...new Set(broker.match(/SCOPED_MODEL_[A-Z_]+/g))].sort()
  assert.deepEqual([...PHASE6_SCOPED_REJECTION_CODES].sort(), actual)
  const events = stream('child_actor', 1, { rejected: true }); events[2].failureCode = 'SCOPED_MODEL_UNREVIEWED_SECRET'
  assert.throws(() => aggregate(events), /unsafe_rejection_code/)
})

test('duplicate successes, reused permits, wrong scopes and foreign events fail closed', () => {
  const first = stream('child_actor')
  assert.throws(() => aggregate([...first.slice(0, 3), first[2], first[3]]), /unbound_sdk_outcome/)
  const reused = stream('child_actor', 2); reused.forEach(event => { event.permitId = first[0].permitId })
  assert.throws(() => aggregate([...first, ...reused]), /duplicate_permit/)
  for (const change of [{ modelRole: 'judge' }, { configHash: 'f'.repeat(64) }, { actualInputHash: 'f'.repeat(64) },
    { permitId: hexId(9) }, { executionId: 'foreign' }, { sessionId: 'foreign' }]) {
    const events = structuredClone(first); Object.assign(events[2], change)
    assert.throws(() => aggregate(events), /Phase 6 budget:/)
  }
})

test('secret fields, unsafe tokens, invalid budgets and unversioned child events reject', () => {
  for (const key of ['endpoint', 'api_key', 'messages', 'rawException', 'model']) {
    const events = stream('actor'); events[0][key] = 'must not be emitted'
    assert.throws(() => aggregate(events), /unsafe_model_event_fields/)
  }
  const unsafe = stream('child_actor'); unsafe[2].usage.totalTokens = Number.MAX_SAFE_INTEGER + 1
  assert.throws(() => aggregate(unsafe), /unsafe_usage/)
  const changed = stream('actor', 1, { retry: true }); changed[3].maxRequestAttempts = 3
  assert.throws(() => aggregate(changed), /attempt_budget_changed/)
  assert.throws(() => aggregate(stream('child_actor', 1, { scoped: false })), /unversioned_child_model_event/)
})

function filesystemFixture() {
  const fixture = runtimeFixture(), runtime = { processTimeoutMs: 5000, maxRequestAttempts: 2 }
  const { manifestHash: ignored, ...original } = fixture.manifest
  const contents = { ...original, schemaVersion: 'gaia2-run-manifest-v1', planFingerprint: 'f'.repeat(64) }
  const manifest = { ...contents, manifestHash: digest(contents) }
  const session = { ...fixture.session, startedAt: '2026-10-13T00:00:00Z', endedAt: '2026-10-13T00:00:00.150Z' }
  const runtimeHash = digest(runtime)
  const events = [...fixture.events]
  const modelIndex = events.findIndex(event => event.type === 'model_request')
  const modelEvents = stream('actor').map(event => ({ ...event, executionId: fixture.task.executionId, sessionId: session.sessionId }))
  events.splice(modelIndex + 1, 0, ...modelEvents)
  fixture.put(`${session.outputDir}/runtime-events.jsonl`, events.map(event => JSON.stringify(event)).join('\n') + '\n')
  const host = { ...fixture.hostProcess, elapsedMs: 120 }
  const hostRef = fixture.put(`${session.outputDir}/hook-host/process-result.json`, host)
  const refs = fixture.collected.runtimeEvidence.map(ref => ref.path === hostRef.path ? hostRef : ref)
  const attestation = { ...fixture.collected.runtimeAttestation, manifestHash: manifest.manifestHash,
    eventsHash: digest(events), evidenceHash: digest(refs) }
  const process = { ...host, elapsedMs: 100 }
  fixture.put(`${session.outputDir}/process-result.json`, process)
  fixture.put(`${session.fixtureDir}/scenario.json`, '{}')
  const result = { schemaVersion: 'gaia2-task-result-v1', runId: manifest.runId, manifestHash: manifest.manifestHash,
    runtimeHash, executionId: fixture.task.executionId, sessionId: session.sessionId,
    scenarioId: fixture.task.scenarioId, runNumber: fixture.task.runNumber, phase: fixture.task.phase, config: fixture.task.config,
    evaluationComplete: true, businessPassed: false, score: 0, runtimeAttestation: attestation, runtimeEvidence: refs }
  const resultRef = fixture.put(`${session.workspaceDir}/task-result.json`, result)
  const state = { schemaVersion: 'gaia2-run-state-v1', runId: manifest.runId, manifestHash: manifest.manifestHash, runtimeHash,
    tasks: [{ executionId: fixture.task.executionId, status: 'completed', sessions: [session], resultPath: resultRef.path, resultSha256: resultRef.sha256 }] }
  fixture.put(`${manifest.runRoot}/run-manifest.json`, manifest)
  fixture.put(manifest.stateFile, state)
  fixture.put(`${manifest.runRoot}/runtime-settings.json`, runtime)
  return { ...fixture, manifest, state, result, resultRef, events, session, options: { root: fixture.root, manifestPath: `${manifest.runRoot}/run-manifest.json` } }
}

test('source loader binds manifest/state/runtime/result/full runtime evidence and separates timing/disk', () => {
  const fixture = filesystemFixture(), report = buildPhase6BudgetReport(fixture.options)
  assert.equal(report.status, 'audited')
  assert.equal(report.scope.scopeExecutionComplete, true)
  assert.equal(report.scope.independentEvidenceComplete, true)
  assert.equal(report.usage.totals.sdkAttempts, 1)
  assert.equal(report.binding.selectionIdentityHash, digest({ manifestHash: fixture.manifest.manifestHash, executionIds: [fixture.task.executionId] }))
  assert.equal(report.timing.areMs, 100)
  assert.equal(report.timing.hostMs, 120)
  assert.equal(report.timing.sessionMs, 150)
  assert.equal(report.timing.processTimesOverlapDoNotAdd, true)
  assert.ok(report.disk.sourceLogicalBytes > 0)
  assert.equal(report.disk.allocatedBytes, null)
  assert.equal(report.export.status, 'not_provided')
  assert.equal(report.healthChecks.recordedCompletionChecks, null)
})

test('source loader rejects wrong hashes and event stream edits instead of silently dropping them', () => {
  const resultChanged = filesystemFixture(); resultChanged.put(resultChanged.resultRef.path, { ...resultChanged.result, score: 1, businessPassed: true })
  assert.throws(() => buildPhase6BudgetReport(resultChanged.options), /result_sha_binding_invalid/)
  const changedEvents = filesystemFixture(); changedEvents.events[3].extra = 'changed'
  changedEvents.put(`${changedEvents.session.outputDir}/runtime-events.jsonl`, changedEvents.events.map(event => JSON.stringify(event)).join('\n'))
  assert.throws(() => buildPhase6BudgetReport(changedEvents.options), /runtime_seal_changed/)
  const changedRuntime = filesystemFixture(); changedRuntime.put(`${changedRuntime.manifest.runRoot}/runtime-settings.json`, {})
  assert.throws(() => buildPhase6BudgetReport(changedRuntime.options), /state_or_runtime_binding_invalid/)
})

test('running session is excluded, not counted as finished or free', () => {
  const fixture = filesystemFixture()
  fixture.state.tasks[0].status = 'running'; fixture.state.tasks[0].sessions[0].endedAt = null
  fixture.put(fixture.manifest.stateFile, fixture.state)
  const report = buildPhase6BudgetReport(fixture.options)
  assert.equal(report.scope.executedSessions, 0)
  assert.equal(report.scope.excludedSessions.length, 1)
  assert.equal(report.scope.scopeExecutionComplete, false)
  assert.equal(report.tokenUsageComplete, false)
  assert.equal(report.observedAttemptAccountingComplete, false)
  assert.equal(report.monetaryCost, null)
})

test('CLI parser and immutable output reject ambiguous flags, escapes and writes into frozen runs', () => {
  assert.throws(() => parsePhase6BudgetArgs(['--manifest', 'x', '--manifest', 'y']), /unknown_or_duplicate_flag/)
  assert.throws(() => parsePhase6BudgetArgs(['--manifest', 'x', '--only-run-number', '6']), /invalid_run_number/)
  const fixture = filesystemFixture(), report = buildPhase6BudgetReport(fixture.options)
  assert.throws(() => buildPhase6BudgetReport({ ...fixture.options, manifestPath: '../foreign.json' }), /unsafe_source_path/)
  assert.throws(() => buildPhase6BudgetReport({ ...fixture.options, executionIds: ['foreign'] }), /unknown_execution_id/)
  assert.throws(() => writePhase6BudgetReport({ root: fixture.root, outputPath: 'runs/fixture/new-budget.json', report }), /unsafe_output_path/)
  assert.throws(() => writePhase6BudgetReport({ root: fixture.root, outputPath: '../foreign-budget.json', report }), /unsafe_output_path/)
  const output = writePhase6BudgetReport({ root: fixture.root, outputPath: 'reports/budget.json', report })
  assert.ok(existsSync(output))
  assert.throws(() => writePhase6BudgetReport({ root: fixture.root, outputPath: 'reports/budget.json', report }), /immutable_output_exists/)
})

const actualRun = 'runs/phase5-a2a-service-revalidation-20261013-r17'
test('real r17 sealed evidence: exactly 81 attempts = 80 successes + one STOP rejection',
  { skip: !existsSync(join(root, actualRun, 'run-state.json')) }, () => {
    const beforeState = readFileSync(join(root, actualRun, 'run-state.json'))
    const state = JSON.parse(beforeState), ids = state.tasks.filter(task => task.status === 'completed').map(task => task.executionId)
    assert.equal(ids.length, 3)
    const report = runPhase6BudgetReport({ root, manifestPath: `${actualRun}/run-manifest.json`, executionIds: ids,
      exportDir: `${actualRun}/export-three-revalidated-a2a`, healthReportPaths: [`${actualRun}/model-service-recheck-before-revalidation.json`] })
    assert.equal(report.status, 'audited')
    assert.equal(report.scope.executedSessions, 3)
    assert.equal(report.scope.independentEvidenceComplete, true)
    assert.equal(report.scope.scopeExecutionComplete, true)
    assert.equal(report.usage.totals.sdkAttempts, 81)
    assert.equal(report.usage.totals.successfulCompletions, 80)
    assert.equal(report.usage.totals.rejectedSdkAttempts, 1)
    assert.equal(report.usage.totals.failedSdkAttempts, 0)
    assert.equal(report.usage.totals.unfinishedSdkAttempts, 0)
    assert.equal(report.logicalOutcomeComplete, true)
    assert.equal(report.observedAttemptAccountingComplete, true)
    assert.equal(report.tokenUsageComplete, false)
    assert.equal(report.usage.totals.sdkAttemptsWithUnknownUsage, 1)
    assert.equal(report.usage.totals.totalTokens, null)
    assert.deepEqual(report.usage.totals.reportedTokenSubtotals, { inputTokens: 402480, outputTokens: 15496, totalTokens: 417976 })
    assert.equal(report.byRole, undefined)
    assert.equal(report.usage.byRole.actor.sdkAttempts, 29)
    assert.equal(report.usage.byRole.child_actor.sdkAttempts, 52)
    assert.equal(report.export.selectedCoverageComplete, true)
    assert.equal(report.healthChecks.recordedCompletionChecks, 3)
    assert.equal(report.healthChecks.records[0].unknownTokenCompletionChecks, 3)
    assert.equal(report.healthChecks.tokens, null)
    assert.equal(report.monetaryCost, null)
    assert.equal(report.forecast, null)
    assert.equal(report.noModelExecution, true)
    assert.equal(report.binding.state.sha256, sha(beforeState))
    assert.equal(sha(readFileSync(join(root, actualRun, 'run-state.json'))), sha(beforeState))
  })
