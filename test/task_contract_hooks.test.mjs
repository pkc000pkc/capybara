import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import vm from 'node:vm'
import { validateTaskContractInvocation, validateTaskContractState } from '../src/semantic_receipt.mjs'

const copy = value => JSON.parse(JSON.stringify(value))
const hash = value => createHash('sha256').update(value).digest('hex')
const plugin = resolve('plugins/gaia2-runtime')
const variables = () => Object.fromEntries(JSON.parse(readFileSync(join(plugin, 'variables.json'), 'utf8')).variables.map(row => [row.key, copy(row.value)]))
const user = { role: 'user', id: 'user-1', notificationType: 'USER_MESSAGE', content: 'Monitor for one minute, then report.' }
const fileRef = kind => ({ path: 'a'.repeat(24) + '/' + kind + '-' + 'b'.repeat(32) + '.json', sha256: 'c'.repeat(64) })
const source = () => ({ userRef: user.id, sourceHash: hash(user.content), arrivedAt: 0, resolution: 'registered', notificationPolicy: 'allow',
  obligationIds: ['obligation-1'], reason: 'independently reviewed', evidenceRef: fileRef('user'), proposalRef: fileRef('proposal'), reviewRef: fileRef('review') })
const obligation = () => ({ id: 'obligation-1', userRef: user.id, sourceHash: hash(user.content), span: { start: 0, end: user.content.length, text: user.content },
  mode: 'monitor_until', deadline: 60, goal: 'Monitor updates', recipe: { queryTool: 'Calendar__get_calendar_events_from_to', queryArguments: { limit: 100 }, queryHash: '1'.repeat(64), intervalSeconds: 10, maxScans: 10 },
  status: 'pending', completionReason: null, pendingEvidence: null, counts: { watchCalls: 0, nativeWaits: 0, nativeScans: 0 }, lastSignal: null, lastReviewedActionId: null })
const state = () => ({ schemaVersion: 'gaia2-task-contract-state-v1', enabled: true, executionId: 'execution-1', sessionId: 'session-1', revision: 1,
  clock: 0, interruption: null, sources: [source()], obligations: [obligation()] })
const commitAction = { id: 'commit-1', canonicalName: 'CapybaraTaskContract__commit', name: 'CapybaraTaskContract__commit', effect: 'read', resourceKey: 'CapybaraTaskContract', authoritativeRead: false, arguments: { op: 'state_update' } }
function hook(name) {
  const code = readFileSync(join(plugin, 'hooks', `${name}.ts`), 'utf8').replace(/^import .*\n/, '').replace('export default defineHook(', 'module.exports = (')
  const context = { module: { exports: null } }; vm.runInNewContext(code, context, { timeout: 1000 }); return context.module.exports
}
function apply(values, result) { for (const patch of result.patches || []) values[patch.path.split('/').at(-1)] = copy(patch.value); return result }
// Pure historical validator helper; production never dispatches this disabled hook.
function commit(values, next, now = 0, messages = [user]) {
  assert.equal(hook('gaia2-task-contract-commit').enabled, false);
  return apply(values, hook('gaia2-task-contract-commit').run({ variables: { builtin: { variables: values } }, action: commitAction,
    outcome: { status: 'succeeded', result: { taskContractState: next } }, messages, clock: { now }, loop: { runId: 'execution-1', iteration: 1 } }))
}
function finish(values, now = 0, messages = [user]) {
  return hook('gaia2-finish-guard').run({ variables: { builtin: { variables: values } }, action: { effect: 'finish' }, messages, clock: { now } }).decision
}
function native(values, when = 60) {
  values.gaia2_observation_state.observations.push({ observationId: 'obs-read-1', actionId: 'read-1', canonicalName: 'Calendar__get_calendar_events_from_to', resourceKey: 'Calendar', queryHash: '1'.repeat(64), resultHash: '2'.repeat(64),
    observedAt: when, complete: true, viewComplete: true, authoritativeRead: true, outcomeStatus: 'succeeded', status: 'observed' })
}

test('production approval commit is disabled and ordinary finish belongs to the Actor', () => {
  const values = variables(), guard = hook('gaia2-finish-guard')
  assert.equal(hook('gaia2-task-contract-commit').enabled, false)
  assert.equal(guard.trigger({ action: { effect: 'finish' } }), true)
  assert.equal(finish(values).action, 'allow')
  assert.equal(validateTaskContractState(values.gaia2_task_contract_state).enabled, false)
})

test('legacy monitor signals and elapsed intervals are data, not production finish admission', () => {
  for (const signal of [null, 'initial_observation', 'candidate_changed', 'timeout', 'unchanged']) {
    const values = variables(), legacy = state(); legacy.obligations[0].lastSignal = signal
    values.gaia2_task_contract_state = legacy
    assert.equal(finish(values, 10).action, 'allow')
    assert.equal(finish(values, 61).action, 'allow')
  }
})

test('legacy source ambiguity, notification policy and missing user entries never become business gates', () => {
  for (const [resolution, policy] of [['reviewed_none', 'allow'], ['ambiguous', 'forbid'], ['reviewed_none', 'forbid']]) {
    const values = variables(), legacy = state(); legacy.sources[0].resolution = resolution; legacy.sources[0].notificationPolicy = policy
    values.gaia2_task_contract_state = legacy
    assert.equal(finish(values, 100).reason, 'business_completion_actor_owned')
    assert.equal(finish(values, 100, [user, { ...user, id: 'new-user' }]).action, 'allow')
  }
})

test('only a running temporal operation blocks finish; signaled watches and STOP/cancel do not', () => {
  const values = variables()
  values.gaia2_temporal_state = { schemaVersion: 'gaia2-temporal-state-v1', enabled: true, status: 'running', watchId: 'watch-1', executionId: 'execution-1', sessionId: 'session-1', userRef: 'user-1', goal: 'wait', sceneStart: 0, sceneNow: 10 }
  assert.equal(finish(values).reason, 'temporal_watch_running')
  assert.equal(finish(values, 0, [{ notificationType: 'ENVIRONMENT_STOP' }]).action, 'allow')
  const decision = hook('gaia2-finish-guard').run({ variables: { builtin: { variables: values } },
    action: { effect: 'finish' }, messages: [], loop: { terminationReason: 'cancelled' } }).decision
  assert.equal(decision.action, 'allow')
  values.gaia2_temporal_state.status = 'signaled'
  assert.equal(finish(values).action, 'allow')
})

test('window obligations block completion until reviewed and preserve technical termination', () => {
  const values = variables()
  values.gaia2_window_obligation_state = {
    schemaVersion: 'gaia2-window-obligation-v1', enabled: true, revision: 1, areNow: 120,
    budgets: { sdk: { limit: 6, consumed: 1 }, wait: { limit: 12, consumed: 2 }, outer: { limit: 480000, consumed: 120 } },
    executionId: 'execution-1', sessionId: 'session-1',
    obligations: [{ id: 'window-1', mode: 'condition_once', status: 'pending', deadline: 220 }],
  }
  const blocked = finish(values, 120)
  assert.equal(blocked.action, 'block')
  assert.equal(blocked.reason, 'window_obligation_pending')
  values.gaia2_window_obligation_state.obligations[0].status = 'window_completed'
  assert.equal(finish(values, 220).action, 'allow')
  values.gaia2_window_obligation_state.obligations[0].status = 'window_expired_unreviewed'
  const interrupted = apply(values, hook('gaia2-attempt-finalize').run({ variables: { builtin: { variables: values } }, loop: { terminationReason: 'environment_stop' } }))
  assert.equal(values.gaia2_window_obligation_state.obligations[0].status, 'technical_termination')
  assert.match(values.gaia2_window_obligation_context, /No timeout, scan budget or termination is treated as business completion/)
  assert.ok(interrupted.patches.some(patch => patch.path.endsWith('/gaia2_window_obligation_state')))
})

test('historical validator only: new ordinary USER does not revoke a pending old obligation or its clock anchor', () => {
  const values = variables(); commit(values, state())
  apply(values, hook('gaia2-event-sync').run({ variables: { builtin: { variables: values } }, messages: [user, { ...user, id: 'user-2', content: 'Also check tomorrow.' }], clock: { now: 20 }, loop: { iteration: 2 } }))
  assert.equal(values.gaia2_task_contract_state.obligations[0].deadline, 60)
  assert.equal(values.gaia2_task_contract_state.obligations[0].status, 'pending')
  assert.equal(values.gaia2_clock_state.pending_waits[0].obligationId, 'obligation-1')
})

test('historical validator only: monitor completion needs a real complete native read at or beyond its original deadline', () => {
  for (const [observedAt, allowed] of [[59, false], [60, true]]) {
    const values = variables(); commit(values, state()); native(values, observedAt)
    const next = state(); next.revision++; next.clock = 60; next.obligations[0].status = 'satisfied'; next.obligations[0].completionReason = 'deadline_reviewed'; next.obligations[0].lastReviewedActionId = 'read-1'
    if (!allowed) assert.throws(() => commit(values, next, 60), /TASK_CONTRACT_PREMATURE_COMPLETION/)
    else { commit(values, next, 60); assert.equal(finish(values, 60).action, 'allow') }
  }
})

test('historical validator only: condition-once can complete after explicit evidence review without waiting until deadline', () => {
  const values = variables(), initial = state(); initial.obligations[0].mode = 'condition_once'; commit(values, initial); native(values, 5)
  const next = copy(initial); next.revision++; next.clock = 5; next.obligations[0].status = 'satisfied'; next.obligations[0].completionReason = 'condition_satisfied'; next.obligations[0].lastReviewedActionId = 'read-1'
  commit(values, next, 5); assert.equal(finish(values, 5).action, 'allow')
})

test('historical validator only: condition-once deadline review closes only its waiting window and requires a final on-deadline read', () => {
  for (const [observedAt, allowed] of [[59, false], [60, true]]) {
    const values = variables(), initial = state(); initial.obligations[0].mode = 'condition_once'; commit(values, initial); native(values, observedAt)
    const next = copy(initial); next.revision++; next.clock = 60; next.obligations[0].status = 'satisfied'; next.obligations[0].completionReason = 'deadline_reviewed'; next.obligations[0].lastReviewedActionId = 'read-1'
    if (!allowed) assert.throws(() => commit(values, next, 60), /TASK_CONTRACT_PREMATURE_COMPLETION/)
    else {
      commit(values, next, 60); assert.equal(finish(values, 60).action, 'allow')
      assert.equal(values.gaia2_task_contract_state.obligations[0].completionReason, 'deadline_reviewed')
      assert.match(values.gaia2_task_contract_context, /never asserts that a condition was met/)
    }
  }
})

test('historical validator only: unfinished obligations have no completion reason and monitor cannot close by condition-satisfied', () => {
  const values = variables(), unfinished = state(); unfinished.obligations[0].completionReason = 'deadline_reviewed'
  assert.throws(() => commit(values, unfinished), /TASK_CONTRACT_OBLIGATION_SCHEMA/)
  commit(values, state()); native(values, 60)
  const next = state(); next.revision++; next.clock = 60; next.obligations[0].status = 'satisfied'; next.obligations[0].completionReason = 'condition_satisfied'; next.obligations[0].lastReviewedActionId = 'read-1'
  assert.throws(() => commit(values, next, 60), /TASK_CONTRACT_PREMATURE_COMPLETION/)
})

test('historical validator only: hidden or wrong-query native observations cannot satisfy an obligation', () => {
  for (const mutate of [row => { row.viewComplete = false }, row => { row.queryHash = 'f'.repeat(64) }, row => { row.outcomeStatus = 'failed_before_execution' }]) {
    const values = variables(); commit(values, state()); native(values, 60); mutate(values.gaia2_observation_state.observations[0])
    const next = state(); next.revision++; next.clock = 60; next.obligations[0].status = 'satisfied'; next.obligations[0].completionReason = 'deadline_reviewed'; next.obligations[0].lastReviewedActionId = 'read-1'
    assert.throws(() => commit(values, next, 60), /TASK_CONTRACT_PREMATURE_COMPLETION/)
  }
})

test('historical validator only: terminal satisfied obligations remain terminal despite later history compaction', () => {
  const values = variables(); commit(values, state()); native(values, 60)
  const next = state(); next.revision++; next.clock = 60; next.obligations[0].status = 'satisfied'; next.obligations[0].completionReason = 'deadline_reviewed'; next.obligations[0].lastReviewedActionId = 'read-1'; commit(values, next, 60)
  values.gaia2_observation_state.observations[0].viewComplete = false
  const later = copy(next); later.revision++; later.clock = 70; commit(values, later, 70)
  assert.equal(values.gaia2_task_contract_state.obligations[0].status, 'satisfied')
})

test('historical validator only: state rollback, deadline rebasing, absent users, invalid spans and budget counter rollback are rejected', () => {
  for (const mutate of [s => { s.revision = 0 }, s => { s.obligations[0].deadline = 90 }, s => { s.sources[0].userRef = 'missing' },
    s => { s.obligations[0].span.text = 'invented' }, s => { s.obligations[0].span.end = 9999 }]) {
    const values = variables(); commit(values, state()); const next = state(); next.revision++; mutate(next)
    assert.throws(() => commit(values, next), /TASK_CONTRACT_/)
  }
})

test('historical validator only: technical exit preserves unfinished obligations and never labels them satisfied', () => {
  const values = variables(); commit(values, state())
  apply(values, hook('gaia2-attempt-finalize').run({ variables: { builtin: { variables: values } }, loop: { terminationReason: 'budget_exhausted' } }))
  assert.equal(values.gaia2_task_contract_state.obligations[0].status, 'technical_blocked')
  assert.equal(finish(values, 100).reason, 'business_completion_actor_owned')
  assert.match(values.gaia2_task_contract_context, /not satisfied/)
})

test('historical validator only: finalize never overwrites already interrupted or technically blocked authoritative state', () => {
  for (const [status, interruption, signal] of [['technical_blocked', null, 'native_error'], ['interrupted', 'user_update', 'user_update'], ['technical_blocked', 'clock_error', 'clock_error']]) {
    const values = variables(), initial = state(); initial.interruption = interruption; initial.obligations[0].status = status; initial.obligations[0].lastSignal = signal; commit(values, initial)
    const original = copy(values.gaia2_task_contract_state)
    const result = apply(values, hook('gaia2-attempt-finalize').run({ variables: { builtin: { variables: values } }, loop: { terminationReason: 'cancelled' } }))
    assert.deepEqual(values.gaia2_task_contract_state, original)
    assert.equal(result.patches.some(patch => patch.path.endsWith('/gaia2_task_contract_state')), false)
    assert.match(values.gaia2_task_contract_context, new RegExp(signal))
  }
})

test('historical validator only: mixed finalization stops pending obligations but preserves an existing technical failure row', () => {
  const values = variables(), initial = state(), blocked = copy(initial.obligations[0]); blocked.id = 'obligation-2'; blocked.status = 'technical_blocked'; blocked.lastSignal = 'native_error'
  initial.obligations.push(blocked); initial.sources[0].obligationIds.push(blocked.id); commit(values, initial)
  apply(values, hook('gaia2-attempt-finalize').run({ variables: { builtin: { variables: values } }, loop: { terminationReason: 'environment_stop' } }))
  assert.equal(values.gaia2_task_contract_state.obligations[0].status, 'interrupted')
  assert.deepEqual(values.gaia2_task_contract_state.obligations[1], blocked)
})

test('local commit/review controls never enter native evidence, write or conflict progress hooks', () => {
  for (const canonicalName of ['CapybaraTaskContract__commit', 'CapybaraTaskContract__review']) for (const name of ['gaia2-noise-classifier', 'gaia2-write-outcome', 'gaia2-write-guard', 'gaia2-conflict-gate']) {
    assert.equal(hook(name).trigger({ action: { canonicalName } }), false)
  }
})

test('Node task invocation binds exact original USER hash and codepoint span, not Actor claims', () => {
  const invocation = { checkpoint: 'after_tool', action: commitAction, messages: [user], outcome: { result: { taskContractState: state() } } }
  const identity = { executionId: 'execution-1', sessionId: 'session-1' }
  validateTaskContractInvocation(invocation, identity)
  for (const mutate of [v => { v.outcome.result.taskContractState.sources[0].sourceHash = 'f'.repeat(64); v.outcome.result.taskContractState.obligations[0].sourceHash = 'f'.repeat(64) },
    v => { v.outcome.result.taskContractState.obligations[0].span.text = 'model invented this' }, v => { v.action.canonicalName = 'CapybaraTaskContract__review' }]) {
    const bad = copy(invocation); mutate(bad); assert.throws(() => validateTaskContractInvocation(bad, identity), /semantic_task_/)
  }
})

test('actual HTTP Host retires contract approval and exposes Actor-owned finish without semantic-task receipts', async () => {
  const files = readdirSync(plugin, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const path = join(entry.parentPath, entry.name)
    return { relativePath: path.slice(plugin.length + 1).replaceAll('\\', '/'), sha256: hash(readFileSync(path)) }
  })
  const workspaceDir = mkdtempSync(join(tmpdir(), 'gaia2-task-http-')), backend = resolve('../..', 'capybara-backend')
  const options = { projectDir: process.cwd(), workspaceDir, executionId: 'execution-1', sessionId: 'session-1', scenarioId: 'scenario-1', plugins: [{ id: 'gaia2-runtime', snapshotRoot: plugin, files }] }
  const specPath = join(workspaceDir, 'spec.json'), readyPath = join(workspaceDir, 'ready.json'), token = 'offline-task-capability'.repeat(3)
  writeFileSync(specPath, JSON.stringify({ backendRoot: backend, readyPath, options, entitySemantics: { enabled: true } }))
  const child = spawn(process.execPath, [`--import=${pathToFileURL(join(backend, 'node_modules/tsx/dist/loader.mjs')).href}`, '--conditions=development', resolve('scripts/phase3_hook_server.ts'), '--spec', specPath], { cwd: workspaceDir, env: { ...process.env, GAIA2_HOOK_TOKEN: token }, windowsHide: true })
  let closed = false, stderr = ''; child.stdout.resume(); child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const closePromise = new Promise(resolveClose => child.once('close', () => { closed = true; resolveClose() }))
  try {
    let ready
    for (let i = 0; i < 600 && !closed; i++) { try { ready = JSON.parse(readFileSync(readyPath, 'utf8')); break } catch {}; await sleep(50) }
    assert.ok(ready, stderr || 'Host not ready')
    const post = async (input, expectedStatus = 200) => {
      const response = await fetch(ready.endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ executionId: options.executionId, sessionId: options.sessionId, loop: { iteration: 1 }, messages: [user], ...input }), signal: AbortSignal.timeout(10000) })
      assert.equal(response.status, expectedStatus, stderr + ' ' + await response.clone().text()); return response.json()
    }
    const model = await post({ checkpoint: 'before_model', clock: { now: 0 } })
    assert.doesNotMatch(model.context, /Durable waiting obligations contract|capybara_task_obligation_step/)
    const obsolete = await post({ checkpoint: 'after_tool', action: { ...commitAction, mutationKey: '3'.repeat(64), idempotent: true },
      outcome: { status: 'succeeded', complete: true, executed: true, resultHash: '4'.repeat(64), result: { taskContractState: state() } }, clock: { now: 0 } }, 422)
    assert.equal(obsolete.error, 'hook_host_rejected', 'retired approval-control frames cannot reactivate the chain')
    const finishInput = { checkpoint: 'before_tool', action: { id: 'finish-1', name: 'send', canonicalName: 'AgentUserInterface__send_message_to_user', effect: 'finish', resourceKey: 'AgentUserInterface', authoritativeRead: false, mutationKey: '5'.repeat(64), idempotent: false, arguments: { message: 'Finished' } }, clock: { now: 0 } }
    const final = await post(finishInput)
    assert.equal(final.decision.action, 'allow')
    assert.equal((await post({ ...finishInput, messages: [user, { ...user, id: 'new-user' }] })).decision.action, 'allow')
    const report = JSON.parse(readFileSync(resolve(workspaceDir, final.semanticReceipt.sourceReceiptRef.path), 'utf8'))
    assert.equal(report.variables.gaia2_task_contract_state.enabled, false)
    assert.equal(report.variables.gaia2_task_contract_state.sources.length, 0)
    assert.equal(Object.hasOwn(final.semanticReceipt, 'taskContractState'), false)
    assert.equal(Object.hasOwn(report, 'semanticReceipt'), false)
    const response = await fetch(ready.endpoint.replace('/invoke', '/shutdown'), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ executionId: options.executionId, sessionId: options.sessionId }) })
    assert.equal(response.status, 200); await Promise.race([closePromise, sleep(10000, null, { ref: false })]); assert.equal(closed, true)
  } finally {
    if (!closed) { child.kill(); await Promise.race([closePromise, sleep(5000, null, { ref: false })]) }
    if (closed) rmSync(workspaceDir, { recursive: true, force: true })
  }
})
