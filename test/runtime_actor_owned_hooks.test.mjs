import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const project = resolve(fileURLToPath(new URL('..', import.meta.url)))
const plugin = join(project, 'plugins/gaia2-runtime')
const backend = JSON.parse(readFileSync(join(project, 'config/phase0-protocol.json'))).runtime.backendRoot
const copy = value => JSON.parse(JSON.stringify(value))
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
const defaults = () => Object.fromEntries(JSON.parse(readFileSync(join(plugin, 'variables.json'))).variables.map(row => [row.key, copy(row.value)]))
const domains = [
  { resource: 'Calendar', read: 'Calendar__get_calendar_events_from_to', write: 'Calendar__add_calendar_event' },
  { resource: 'Contacts', read: 'Contacts__get_contacts', write: 'Contacts__add_new_contact' },
  { resource: 'Emails', read: 'EmailClientV2__list_emails', write: 'EmailClientV2__send_email' },
]
function hook(name) {
  const code = readFileSync(join(plugin, 'hooks', name + '.ts'), 'utf8').replace(/^import .*\n/, '').replace('export default defineHook(', 'module.exports = (')
  const context = { module: { exports: null } }
  vm.runInNewContext(code, context, { timeout: 1000 })
  return context.module.exports
}
function apply(values, result) {
  for (const patch of result.patches || []) values[patch.path.split('/').at(-1)] = copy(patch.value)
  return result
}
function action(domain, id = 'write-1', key = hash('operation-1'), effect = 'write') {
  return { id, name: effect === 'read' ? domain.read : domain.write, canonicalName: effect === 'read' ? domain.read : domain.write,
    effect, resourceKey: domain.resource, mutationKey: key, idempotent: false, authoritativeRead: effect === 'read', arguments: { value: id } }
}
function userMessage(content, id = 'user-1') {
  return { role: 'user', id, notificationType: 'USER_MESSAGE', content, sourceHash: hash(content) }
}
function invoke(values, name, extra = {}) {
  return apply(values, hook(name).run({ variables: { builtin: { variables: values } }, messages: [], clock: { now: 120 }, loop: { runId: 'execution-1', iteration: 1 }, ...extra }))
}
function recordRead(values, domain, id, resultHash, now = 0) {
  return invoke(values, 'gaia2-noise-classifier', { action: action(domain, id, hash('query'), 'read'),
    outcome: { status: 'succeeded', complete: true, executed: true, resultHash, result: [] }, clock: { now } })
}

if (!process.argv.includes('--probe')) {
  for (const domain of domains) {
    test(`${domain.resource}: stale, failed, hidden and conflicting evidence never globally veto writes or synthesize queries`, () => {
      for (const status of ['observed', 'failed', 'incomplete', 'stale', 'conflicting']) {
        const values = defaults()
        values.gaia2_observation_state.observations = [{ observationId: 'obs-old', actionId: 'old', resourceKey: domain.resource,
          canonicalName: domain.read, queryHash: hash('query'), resultHash: hash('old'), observedAt: 0,
          outcomeStatus: status === 'failed' ? 'failed_before_execution' : 'succeeded', authoritativeRead: true,
          complete: status !== 'incomplete', viewComplete: false, status, provenance: { actionId: 'old' } }]
        values.gaia2_progress_state.consecutive_no_progress = 99
        values.gaia2_progress_state.blocked_repetitions = 99
        const result = invoke(values, 'gaia2-conflict-gate', { action: action(domain) })
        assert.equal(result.decision.action, 'allow', status)
        assert.equal(values.gaia2_conflict_state.status, 'idle')
        assert.deepEqual(values.gaia2_conflict_state.requests, [])
        assert.equal(values.gaia2_progress_state.consecutive_no_progress, 99)
        assert.equal(result.artifacts[0].value.automaticQueries, 0)
      }
    })
    test(`${domain.resource}: unknown outcome protects only the exact operation; success still prevents non-idempotent replay`, () => {
      const values = defaults(), original = action(domain)
      values.gaia2_write_state.unknown = [{ actionId: original.id, resourceKey: domain.resource, mutationKey: original.mutationKey, status: 'unknown' }]
      assert.equal(invoke(values, 'gaia2-write-guard', { action: { ...original, id: 'retry' } }).decision.action, 'read_back')
      const unrelated = action(domain, 'write-2', hash('operation-2'))
      assert.equal(invoke(values, 'gaia2-write-guard', { action: unrelated }).decision.action, 'allow')
      invoke(values, 'gaia2-write-outcome', { action: action(domain, 'read-back', hash('query'), 'read'),
        outcome: { status: 'succeeded', complete: true, executed: true, resultHash: hash('read-back'), result: [] } })
      assert.equal(values.gaia2_write_state.unknown.length, 1)
      assert.equal(values.gaia2_write_state.unknown[0].status, 'unknown')
      assert.equal(values.gaia2_write_state.unknown[0].readBackObserved, true)
      assert.equal(invoke(values, 'gaia2-write-guard', { action: original }).decision.action, 'read_back')
      assert.equal(invoke(values, 'gaia2-write-guard', { action: unrelated }).decision.action, 'allow')
      values.gaia2_write_state.actions.push({ ...unrelated, actionId: unrelated.id, status: 'succeeded' })
      assert.equal(invoke(values, 'gaia2-write-guard', { action: { ...unrelated, id: 'duplicate' } }).decision.action, 'block')
    })
    test(`${domain.resource}: latest changed complete native read needs no redundant second confirmation`, () => {
      const values = defaults()
      recordRead(values, domain, 'read-old', hash('old'), 1)
      recordRead(values, domain, 'read-new', hash('new'), 2)
      const observations = values.gaia2_observation_state.observations
      assert.equal(observations[0].status, 'superseded_by_fresh_read')
      assert.equal(observations[1].status, 'observed')
      assert.equal(observations[1].changedFromActionId, 'read-old')
      assert.deepEqual(values.gaia2_observation_state.conflict_ids, [])
      assert.equal(invoke(values, 'gaia2-conflict-gate', { action: action(domain), clock: { now: 2 } }).decision.action, 'allow')
      assert.equal(observations.length, 2)
    })
  }
  test('protocol identity and observation hash binding remain hard protection', () => {
    const values = defaults(), domain = domains[0]
    assert.equal(invoke(values, 'gaia2-write-guard', { action: { ...action(domain), mutationKey: null } }).decision.action, 'block')
    assert.equal(invoke(values, 'gaia2-write-guard', { action: { ...action(domain), effect: 'unknown' } }).decision.action, 'block')
    recordRead(values, domain, 'native-read', hash('actual'), 1)
    const row = values.gaia2_observation_state.observations[0]
    const messages = [{ role: 'tool', content: '[]', observation: { actionId: row.actionId, resourceKey: row.resourceKey,
      canonicalName: row.canonicalName, queryHash: row.queryHash, resultHash: hash('forged'), observedAt: row.observedAt,
      complete: row.complete, viewComplete: true } }]
    assert.throws(() => invoke(values, 'gaia2-conflict-gate', { action: action(domain), messages }), /OBSERVATION_VIEW_BINDING/)
    assert.throws(() => invoke(values, 'gaia2-observation-refresh', { messages }), /OBSERVATION_VIEW_BINDING/)
  })
  test('finish guard does not adjudicate legacy source ambiguity, notification policy or business duties', () => {
    const values = defaults()
    values.gaia2_task_contract_state = { enabled: true, sources: [{ resolution: 'ambiguous', notificationPolicy: 'forbid' }], obligations: [{ status: 'pending' }], interruption: 'cancelled' }
    const finish = { effect: 'finish' }
    assert.equal(invoke(values, 'gaia2-finish-guard', { action: finish }).decision.action, 'allow')
    values.gaia2_temporal_state = { schemaVersion: 'gaia2-temporal-state-v1', enabled: true, status: 'running', watchId: 'watch-1', executionId: 'execution-1', sessionId: 'session-1', userRef: 'user-1', goal: 'wait', sceneStart: 0, sceneNow: 10, signal: null }
    assert.equal(invoke(values, 'gaia2-finish-guard', { action: finish }).decision.reason, 'temporal_watch_running')
    assert.equal(invoke(values, 'gaia2-finish-guard', { action: finish, messages: [{ notificationType: 'ENVIRONMENT_STOP' }] }).decision.action, 'allow')
    assert.equal(invoke(values, 'gaia2-finish-guard', { action: finish, loop: { terminationReason: 'cancelled' } }).decision.action, 'allow')
    values.gaia2_temporal_state.status = 'signaled'
    values.gaia2_temporal_state.signal = { kind: 'candidate_changed' }
    assert.equal(invoke(values, 'gaia2-finish-guard', { action: finish }).decision.action, 'allow')
  })
  test('finish guard fails closed on malformed enabled controller state but allows safe termination', () => {
    const values = defaults(), finish = { effect: 'finish' }
    values.gaia2_task_reconciliation = { schemaVersion: 'wrong-version', status: 'enforce', revision: 1, obligations: [], mismatches: [] }
    assert.equal(invoke(values, 'gaia2-finish-guard', { action: finish }).decision.reason, 'runtime_state_invalid')
    values.gaia2_task_reconciliation = { schemaVersion: 'gaia2-task-reconciliation-v1', status: 'enforce', revision: 1, source: null, obligations: [], mismatches: [] }
    assert.equal(invoke(values, 'gaia2-finish-guard', { action: finish }).decision.reason, 'runtime_state_invalid')
    values.gaia2_task_reconciliation = defaults().gaia2_task_reconciliation
    values.gaia2_temporal_state = { enabled: true, status: 'running', watchId: 'watch-1' }
    assert.equal(invoke(values, 'gaia2-finish-guard', { action: finish }).decision.reason, 'runtime_state_invalid')
    values.gaia2_temporal_state = defaults().gaia2_temporal_state
    values.gaia2_temporal_state = { schemaVersion: 'gaia2-temporal-state-v1', enabled: true, status: 'signaled', watchId: 'watch-1', executionId: 'execution-1', sessionId: 'session-1', userRef: 'user-1', goal: 'wait', sceneStart: 0, sceneNow: 10, signal: { kind: 'forged' } }
    assert.equal(invoke(values, 'gaia2-finish-guard', { action: finish }).decision.reason, 'runtime_state_invalid')
    values.gaia2_temporal_state = defaults().gaia2_temporal_state
    values.gaia2_window_obligation_state = { enabled: true, schemaVersion: 'wrong-version', obligations: [] }
    assert.equal(invoke(values, 'gaia2-finish-guard', { action: finish }).decision.reason, 'runtime_state_invalid')
    values.gaia2_window_obligation_state = { schemaVersion: 'gaia2-window-obligation-v1', enabled: true, executionId: 'execution-1', sessionId: 'session-1', obligations: [{ id: 'w', mode: 'condition_once', deadline: 10, status: 'window_completed', completionReason: null, lastReviewedActionId: null }] }
    assert.equal(invoke(values, 'gaia2-finish-guard', { action: finish }).decision.reason, 'runtime_state_invalid')
    assert.equal(invoke(values, 'gaia2-finish-guard', { action: finish, loop: { terminationReason: 'environment_stop' } }).decision.action, 'allow')
  })
  test('legacy task-contract approval stays disabled while Actor reconciliation is available', () => {
    assert.equal(hook('gaia2-task-contract-commit').enabled, false)
    const values = defaults()
    values.gaia2_conflict_state = { schemaVersion: 'gaia2-conflict-state-v2', status: 'blocked', requests: [{ queryTool: domains[0].read }] }
    invoke(values, 'gaia2-conflict-context-refresh')
    assert.equal(values.gaia2_conflict_state.status, 'idle')
    assert.deepEqual(values.gaia2_conflict_state.requests, [])
    assert.equal(values.gaia2_conflict_context, '')
    const contract = readFileSync(join(plugin, 'harnesses/runtime-contract.j2'), 'utf8')
    assert.doesNotMatch(contract, /capybara_task_obligation_step|Durable waiting obligations contract|exact native read and arguments/)
    assert.match(contract, /Actor interprets the latest user request/)
  })
  test('Actor-owned reconciliation binds a visible quote and compares declared counts without Oracle data', () => {
    const values = defaults(), content = 'Please send exactly one email and do not notify me yet.'
    values.gaia2_action_ledger = { schemaVersion: 'gaia2-action-ledger-v1', totalCalls: 1, groups: [{ key: 'send', canonicalName: 'EmailClientV2__send_email', resourceKey: 'Emails', effect: 'write', totalCalls: 1, counts: { succeeded: 1, failed: 0, unknown: 0, not_executed: 0 } }], recent: [], omittedGroups: 0 }
    const actionValue = { id: 'contract-review', name: 'capybara_task_reconcile', canonicalName: 'CapybaraTaskContract__review', effect: 'read', resourceKey: 'CapybaraTaskContract', authoritativeRead: false, arguments: { op: 'reconcile' } }
    const request = { schemaVersion: 'gaia2-task-reconciliation-request-v1', mode: 'enforce', source: { userRef: 'user-1', sourceHash: hash(content), quote: 'send exactly one email' }, obligations: [{ id: 'send-one', canonicalName: 'EmailClientV2__send_email', effect: 'write', minCalls: 1, maxCalls: 1 }] }
    const reconciliation = invoke(values, 'gaia2-task-reconciliation', { action: actionValue, messages: [userMessage(content)], outcome: { status: 'succeeded', executed: true, complete: true, result: { taskReconciliation: request } } })
    assert.equal(values.gaia2_task_reconciliation.status, 'enforce')
    assert.deepEqual(values.gaia2_task_reconciliation.mismatches, [])
    assert.equal(values.gaia2_task_reconciliation.obligations[0].actualCalls, 1)
    const evidence = reconciliation.artifacts.find(item => item.title === 'GAIA2 Actor-owned task reconciliation').value.evidenceSummary
    assert.deepEqual(JSON.parse(JSON.stringify(evidence[0])), { id: 'send-one', canonicalName: 'EmailClientV2__send_email', resourceKey: null, effect: 'write', minCalls: 1, maxCalls: 1,
      actualCalls: 1, attemptedCalls: 1, failedCalls: 0, unknownCalls: 0, notExecutedCalls: 0,
      argumentMatchedCalls: null, argumentMismatchCalls: null, fieldMismatchIds: [], status: 'satisfied' })
    assert.match(values.gaia2_task_reconciliation_context, /expected actions are model-declared, not inferred/)
    values.gaia2_task_reconciliation.mismatches = [{ id: 'missing-checkout', status: 'missing', actualCalls: 0, minCalls: 1, maxCalls: 1 }]
    const finish = { id: 'finish', name: 'AgentUserInterface__send_message_to_user', canonicalName: 'AgentUserInterface__send_message_to_user', effect: 'finish', resourceKey: 'AgentUserInterface' }
    assert.equal(invoke(values, 'gaia2-finish-guard', { action: finish }).decision.reason, 'task_reconciliation_unresolved')
    values.gaia2_task_reconciliation.status = 'advisory'
    assert.equal(invoke(values, 'gaia2-finish-guard', { action: finish }).decision.action, 'allow')
  })
  test('reconciliation counts only successful complete calls and preserves diagnostic outcomes', () => {
    const values = defaults(), content = 'Send exactly one email.'
    values.gaia2_action_ledger = { schemaVersion: 'gaia2-action-ledger-v1', totalCalls: 1,
      groups: [{ key: 'send', canonicalName: 'EmailClientV2__send_email', resourceKey: 'Emails', effect: 'write', totalCalls: 1,
        counts: { succeeded: 0, failed: 1, unknown: 0, not_executed: 0 } }], recent: [], omittedGroups: 0 }
    const actionValue = { id: 'contract-review-failed', name: 'capybara_task_reconcile', canonicalName: 'CapybaraTaskContract__review', effect: 'read', resourceKey: 'CapybaraTaskContract', authoritativeRead: false, arguments: { op: 'reconcile' } }
    const request = { schemaVersion: 'gaia2-task-reconciliation-request-v1', mode: 'enforce', source: { userRef: 'user-1', sourceHash: hash(content), quote: content }, obligations: [{ id: 'send-one', canonicalName: 'EmailClientV2__send_email', resourceKey: 'Emails', effect: 'write', minCalls: 1, maxCalls: 1 }] }
    invoke(values, 'gaia2-task-reconciliation', { action: actionValue, messages: [userMessage(content)], outcome: { status: 'succeeded', executed: true, complete: true, result: { taskReconciliation: request } } })
    const obligation = values.gaia2_task_reconciliation.obligations[0]
    assert.equal(obligation.actualCalls, 0)
    assert.equal(obligation.attemptedCalls, 1)
    assert.equal(obligation.failedCalls, 1)
    assert.equal(obligation.status, 'missing')
    assert.equal(values.gaia2_task_reconciliation.mismatches[0].status, 'missing')
  })
  test('an incomplete authoritative read cannot resolve an unknown write', () => {
    const values = defaults(), domain = domains[2]
    values.gaia2_write_state.unknown = [{ actionId: 'unknown-write', mutationKey: hash('unknown-write'), resourceKey: domain.resource, status: 'unknown', readBackObserved: false }]
    const read = action(domain, 'incomplete-read', hash('incomplete-read'), 'read')
    invoke(values, 'gaia2-write-outcome', { action: read,
      outcome: { status: 'succeeded', executed: true, resultHash: hash('partial-read') }, clock: { now: 10 }, loop: { iteration: 1 },
      messages: [userMessage('Read back the resource.')] })
    assert.equal(values.gaia2_write_state.unknown[0].readBackObserved, false)
  })
  test('a succeeded but incomplete receipt is unknown, never an actual call', () => {
    const values = defaults(), content = 'Send exactly one email.', domain = domains[2]
    const write = action(domain, 'send-incomplete', hash('send-incomplete'))
    invoke(values, 'gaia2-action-ledger', { action: write,
      outcome: { status: 'succeeded', executed: true, resultHash: hash('partial') },
      messages: [userMessage(content)] })
    const ledger = values.gaia2_action_ledger
    const group = ledger.groups.find(item => item.canonicalName === domain.write)
    assert.equal(group.counts.succeeded, 0)
    assert.equal(group.counts.unknown, 1)
    const recent = ledger.recent.find(item => item.actionId === 'send-incomplete')
    assert.equal(recent.status, 'unknown')
    const actionValue = { id: 'contract-review-incomplete', name: 'capybara_task_reconcile', canonicalName: 'CapybaraTaskContract__review', effect: 'read', resourceKey: 'CapybaraTaskContract', authoritativeRead: false, arguments: { op: 'reconcile' } }
    const request = { schemaVersion: 'gaia2-task-reconciliation-request-v1', mode: 'enforce', source: { userRef: 'user-1', sourceHash: hash(content), quote: content },
      obligations: [{ id: 'send-one', canonicalName: domain.write, resourceKey: domain.resource, effect: 'write', minCalls: 1, maxCalls: 1 }] }
    invoke(values, 'gaia2-task-reconciliation', { action: actionValue, messages: [userMessage(content)],
      outcome: { status: 'succeeded', executed: true, complete: true, result: { taskReconciliation: request } } })
    assert.equal(values.gaia2_task_reconciliation.obligations[0].actualCalls, 0)
    assert.equal(values.gaia2_task_reconciliation.obligations[0].unknownCalls, 1)
    assert.equal(values.gaia2_task_reconciliation.obligations[0].status, 'missing')
  })
  test('Actor-declared field hashes reconcile against Host-derived successful-call metadata', () => {
    const values = defaults(), content = 'Send the approved message.', recipient = 'approved@example.com'
    const domain = domains[2], args = { recipient }, argumentHash = hash(JSON.stringify(args)), recipientHash = hash(JSON.stringify(recipient))
    const native = { ...action(domain, 'send-constrained', hash('send-constrained')), arguments: args, argumentHash,
      argumentFieldHashes: { '': argumentHash, '/recipient': recipientHash }, argumentFieldNumbers: {}, argumentMetadataComplete: true }
    invoke(values, 'gaia2-action-ledger', { action: native,
      outcome: { status: 'succeeded', complete: true, executed: true, resultHash: hash('constrained-result') },
      messages: [userMessage(content)] })
    const actionValue = { id: 'contract-review-arguments', name: 'capybara_task_reconcile', canonicalName: 'CapybaraTaskContract__review', effect: 'read', resourceKey: 'CapybaraTaskContract', authoritativeRead: false, arguments: { op: 'reconcile' } }
    const request = { schemaVersion: 'gaia2-task-reconciliation-request-v1', mode: 'enforce', source: { userRef: 'user-1', sourceHash: hash(content), quote: content }, obligations: [{ id: 'send-one', canonicalName: domain.write, resourceKey: domain.resource, effect: 'write', minCalls: 1, maxCalls: 1, argumentChecks: [{ path: '/recipient', op: 'equals_hash', expectedHash: recipientHash }] }] }
    invoke(values, 'gaia2-task-reconciliation', { action: actionValue, messages: [userMessage(content)], outcome: { status: 'succeeded', executed: true, complete: true, result: { taskReconciliation: request } } })
    const obligation = values.gaia2_task_reconciliation.obligations[0]
    assert.equal(obligation.status, 'satisfied')
    assert.equal(obligation.argumentMatchedCalls, 1)
    assert.equal(obligation.argumentMismatchCalls, 0)
    request.obligations[0].argumentChecks[0].expectedHash = hash(JSON.stringify('other@example.com'))
    invoke(values, 'gaia2-task-reconciliation', { action: actionValue, messages: [userMessage(content)], outcome: { status: 'succeeded', executed: true, complete: true, result: { taskReconciliation: request } } })
    assert.equal(values.gaia2_task_reconciliation.obligations[0].status, 'argument_mismatch')
    assert.deepEqual(values.gaia2_task_reconciliation.obligations[0].fieldMismatchIds, ['/recipient'])
  })
  test('bounded Host argument metadata stays evidence-incomplete instead of becoming a field mismatch', () => {
    const values = defaults(), content = 'Send the approved message.', recipient = 'approved@example.com'
    const domain = domains[2], args = { recipient }, argumentHash = hash(JSON.stringify(args)), recipientHash = hash(JSON.stringify(recipient))
    const native = { ...action(domain, 'send-truncated-arguments', hash('send-truncated-arguments')), arguments: args, argumentHash,
      argumentFieldHashes: { '': argumentHash, '/recipient': recipientHash }, argumentFieldNumbers: {}, argumentMetadataComplete: false }
    invoke(values, 'gaia2-action-ledger', { action: native,
      outcome: { status: 'succeeded', complete: true, executed: true, resultHash: hash('truncated-arguments-result') },
      messages: [userMessage(content)] })
    const actionValue = { id: 'contract-review-truncated-arguments', name: 'capybara_task_reconcile', canonicalName: 'CapybaraTaskContract__review', effect: 'read', resourceKey: 'CapybaraTaskContract', authoritativeRead: false, arguments: { op: 'reconcile' } }
    const request = { schemaVersion: 'gaia2-task-reconciliation-request-v1', mode: 'enforce', source: { userRef: 'user-1', sourceHash: hash(content), quote: content }, obligations: [{ id: 'send-one', canonicalName: domain.write, resourceKey: domain.resource, effect: 'write', minCalls: 1, maxCalls: 1, argumentChecks: [{ path: '/recipient', op: 'equals_hash', expectedHash: recipientHash }] }] }
    invoke(values, 'gaia2-task-reconciliation', { action: actionValue, messages: [userMessage(content)],
      outcome: { status: 'succeeded', executed: true, complete: true, result: { taskReconciliation: request } } })
    assert.equal(values.gaia2_task_reconciliation.obligations[0].status, 'argument_evidence_incomplete')
    assert.equal(values.gaia2_task_reconciliation.obligations[0].argumentMismatchCalls, null)
  })
  test('missing Host argument completeness stays evidence-incomplete', () => {
    const values = defaults(), content = 'Send the approved message.', recipient = 'approved@example.com'
    const domain = domains[2], args = { recipient }, argumentHash = hash(JSON.stringify(args)), recipientHash = hash(JSON.stringify(recipient))
    const native = { ...action(domain, 'send-missing-arguments-complete', hash('send-missing-arguments-complete')), arguments: args, argumentHash,
      argumentFieldHashes: { '': argumentHash, '/recipient': recipientHash }, argumentFieldNumbers: {} }
    invoke(values, 'gaia2-action-ledger', { action: native,
      outcome: { status: 'succeeded', complete: true, executed: true, resultHash: hash('missing-arguments-complete-result') },
      messages: [userMessage(content)] })
    const actionValue = { id: 'contract-review-missing-arguments-complete', name: 'capybara_task_reconcile', canonicalName: 'CapybaraTaskContract__review', effect: 'read', resourceKey: 'CapybaraTaskContract', authoritativeRead: false, arguments: { op: 'reconcile' } }
    const request = { schemaVersion: 'gaia2-task-reconciliation-request-v1', mode: 'enforce', source: { userRef: 'user-1', sourceHash: hash(content), quote: content }, obligations: [{ id: 'send-one', canonicalName: domain.write, resourceKey: domain.resource, effect: 'write', minCalls: 1, maxCalls: 1, argumentChecks: [{ path: '/recipient', op: 'equals_hash', expectedHash: recipientHash }] }] }
    invoke(values, 'gaia2-task-reconciliation', { action: actionValue, messages: [userMessage(content)],
      outcome: { status: 'succeeded', executed: true, complete: true, result: { taskReconciliation: request } } })
    assert.equal(values.gaia2_task_reconciliation.obligations[0].status, 'argument_evidence_incomplete')
    assert.equal(values.gaia2_task_reconciliation.obligations[0].argumentMismatchCalls, null)
  })
  test('an unresolved enforce mismatch cannot be downgraded by advisory reconciliation', () => {
    const values = defaults(), content = 'Do exactly one action.'
    values.gaia2_task_reconciliation = { schemaVersion: 'gaia2-task-reconciliation-v1', status: 'enforce', revision: 1,
      source: { userRef: 'user-1', sourceHash: hash(content), quote: content }, obligations: [{ id: 'missing', canonicalName: 'Calendar__add_calendar_event', effect: 'write', minCalls: 1, maxCalls: 1, actualCalls: 0, status: 'missing' }],
      mismatches: [{ id: 'missing', status: 'missing', actualCalls: 0, minCalls: 1, maxCalls: 1 }] }
    const actionValue = { id: 'contract-review-advisory', name: 'capybara_task_reconcile', canonicalName: 'CapybaraTaskContract__review', effect: 'read', resourceKey: 'CapybaraTaskContract', authoritativeRead: false, arguments: { op: 'reconcile' } }
    const request = { schemaVersion: 'gaia2-task-reconciliation-request-v1', mode: 'advisory', source: { userRef: 'user-1', sourceHash: hash(content), quote: content }, obligations: [] }
    invoke(values, 'gaia2-task-reconciliation', { action: actionValue, messages: [userMessage(content)], outcome: { status: 'succeeded', executed: true, complete: true, result: { taskReconciliation: request } } })
    assert.equal(values.gaia2_task_reconciliation.status, 'enforce')
    assert.equal(values.gaia2_task_reconciliation.mismatches[0].id, 'missing')
    const finish = { id: 'finish', name: 'AgentUserInterface__send_message_to_user', canonicalName: 'AgentUserInterface__send_message_to_user', effect: 'finish', resourceKey: 'AgentUserInterface' }
    assert.equal(invoke(values, 'gaia2-finish-guard', { action: finish }).decision.reason, 'task_reconciliation_unresolved')
  })
  test('a new USER cannot replace an unresolved enforce plan without an explicit visible supersede quote', () => {
    const values = defaults(), oldContent = 'Complete the original task.', newContent = 'Explicitly replace the prior task.'
    values.gaia2_task_reconciliation = { schemaVersion: 'gaia2-task-reconciliation-v1', status: 'enforce', revision: 1,
      source: { userRef: 'user-old', sourceHash: hash(oldContent), quote: oldContent }, obligations: [{ id: 'old', canonicalName: 'Calendar__add_calendar_event', effect: 'write', minCalls: 1, maxCalls: 1, actualCalls: 0, status: 'missing' }],
      mismatches: [{ id: 'old', status: 'missing', actualCalls: 0, minCalls: 1, maxCalls: 1 }] }
    const actionValue = { id: 'contract-review-supersede', name: 'capybara_task_reconcile', canonicalName: 'CapybaraTaskContract__review', effect: 'read', resourceKey: 'CapybaraTaskContract', authoritativeRead: false, arguments: { op: 'reconcile' } }
    const userOld = userMessage(oldContent, 'user-old'), userNew = userMessage(newContent, 'user-new')
    const request = { schemaVersion: 'gaia2-task-reconciliation-request-v1', mode: 'enforce', source: { userRef: 'user-new', sourceHash: hash(newContent), quote: newContent }, obligations: [] }
    invoke(values, 'gaia2-task-reconciliation', { action: actionValue, messages: [userOld, userNew], outcome: { status: 'succeeded', executed: true, complete: true, result: { taskReconciliation: request } } })
    assert.equal(values.gaia2_task_reconciliation.source.userRef, 'user-old')
    assert.equal(values.gaia2_task_reconciliation.mismatches[0].id, 'old')
    request.source.replacement = { mode: 'supersede', quote: 'Explicitly replace the prior task.' }
    invoke(values, 'gaia2-task-reconciliation', { action: actionValue, messages: [userOld, userNew], outcome: { status: 'succeeded', executed: true, complete: true, result: { taskReconciliation: request } } })
    assert.equal(values.gaia2_task_reconciliation.source.userRef, 'user-new')
    assert.deepEqual(values.gaia2_task_reconciliation.mismatches, [])
  })
  test('a changed quote or scope anchor cannot replace an unresolved enforce plan under the same USER hash', () => {
    const values = defaults(), content = 'Do exactly one action. Then revise the wording.'
    values.gaia2_task_reconciliation = { schemaVersion: 'gaia2-task-reconciliation-v1', status: 'enforce', revision: 1,
      source: { userRef: 'user-1', sourceHash: hash(content), quote: 'Do exactly one action.' }, obligations: [{ id: 'old', canonicalName: 'Calendar__add_calendar_event', effect: 'write', minCalls: 1, maxCalls: 1, actualCalls: 0, status: 'missing' }],
      mismatches: [{ id: 'old', status: 'missing', actualCalls: 0, minCalls: 1, maxCalls: 1 }] }
    const actionValue = { id: 'contract-review-same-hash', name: 'capybara_task_reconcile', canonicalName: 'CapybaraTaskContract__review', effect: 'read', resourceKey: 'CapybaraTaskContract', authoritativeRead: false, arguments: { op: 'reconcile' } }
    const request = { schemaVersion: 'gaia2-task-reconciliation-request-v1', mode: 'enforce', source: { userRef: 'user-1', sourceHash: hash(content), quote: 'Then revise the wording.' }, obligations: [] }
    invoke(values, 'gaia2-task-reconciliation', { action: actionValue, messages: [userMessage(content)], outcome: { status: 'succeeded', executed: true, complete: true, result: { taskReconciliation: request } } })
    assert.equal(values.gaia2_task_reconciliation.source.quote, 'Do exactly one action.')
    assert.equal(values.gaia2_task_reconciliation.mismatches[0].id, 'old')
  })
  test('ledger truncation is explicit and conservative rather than a false missing result', () => {
    const values = defaults(), content = 'Perform the requested action.'
    values.gaia2_action_ledger = { schemaVersion: 'gaia2-action-ledger-v1', totalCalls: 40, groups: [], recent: [], omittedGroups: 1 }
    const actionValue = { id: 'contract-review-truncated', name: 'capybara_task_reconcile', canonicalName: 'CapybaraTaskContract__review', effect: 'read', resourceKey: 'CapybaraTaskContract', authoritativeRead: false, arguments: { op: 'reconcile' } }
    const request = { schemaVersion: 'gaia2-task-reconciliation-request-v1', mode: 'enforce', source: { userRef: 'user-1', sourceHash: hash(content), quote: content }, obligations: [{ id: 'send-one', canonicalName: 'EmailClientV2__send_email', effect: 'write', minCalls: 1, maxCalls: 1 }] }
    invoke(values, 'gaia2-task-reconciliation', { action: actionValue, messages: [userMessage(content)], outcome: { status: 'succeeded', executed: true, complete: true, result: { taskReconciliation: request } } })
    assert.equal(values.gaia2_task_reconciliation.obligations[0].status, 'ledger_incomplete')
    assert.equal(values.gaia2_task_reconciliation.mismatches[0].status, 'ledger_incomplete')
  })
  test('an anchored scope with a missing member cannot be satisfied by the retained root scope', () => {
    const values = defaults(), domain = domains[2], first = 'Root request.', second = 'Continue the root request.'
    const write = action(domain, 'send-root-only', hash('send-root-only'))
    invoke(values, 'gaia2-action-ledger', { action: write,
      outcome: { status: 'succeeded', complete: true, executed: true, resultHash: hash('root-result') },
      messages: [userMessage(first)] })
    // The second USER is intentionally absent from the bounded scope ledger.
    values.gaia2_action_ledger.scopes = [values.gaia2_action_ledger.scopes[0]]
    const actionValue = { id: 'contract-review-missing-scope', name: 'capybara_task_reconcile', canonicalName: 'CapybaraTaskContract__review', effect: 'read', resourceKey: 'CapybaraTaskContract', authoritativeRead: false, arguments: { op: 'reconcile' } }
    const request = { schemaVersion: 'gaia2-task-reconciliation-request-v1', mode: 'enforce', source: { userRef: 'user-1', sourceHash: hash(first), quote: first,
      scopeAnchor: { members: [{ userRef: 'user-1', sourceHash: hash(first), quote: first }, { userRef: 'user-2', sourceHash: hash(second), quote: second }] } },
      obligations: [{ id: 'send-two', canonicalName: domain.write, effect: 'write', resourceKey: domain.resource, minCalls: 1, maxCalls: 1 }] }
    invoke(values, 'gaia2-task-reconciliation', { action: actionValue,
      messages: [userMessage(first), userMessage(second, 'user-2')],
      outcome: { status: 'succeeded', executed: true, complete: true, result: { taskReconciliation: request } } })
    assert.equal(values.gaia2_task_reconciliation.obligations[0].status, 'ledger_incomplete')
    assert.equal(values.gaia2_task_reconciliation.mismatches[0].status, 'ledger_incomplete')
  })
  test('a broad declaration stays incomplete when bounded groups were omitted', () => {
    const values = defaults(), content = 'Perform the requested action.'
    values.gaia2_action_ledger = { schemaVersion: 'gaia2-action-ledger-v1', totalCalls: 40,
      groups: [{ key: 'send', canonicalName: 'EmailClientV2__send_email', resourceKey: 'Emails', effect: 'write', totalCalls: 1,
        counts: { succeeded: 1, failed: 0, unknown: 0, not_executed: 0 } }], recent: [], omittedGroups: 1 }
    const actionValue = { id: 'contract-review-broad-truncated', name: 'capybara_task_reconcile', canonicalName: 'CapybaraTaskContract__review', effect: 'read', resourceKey: 'CapybaraTaskContract', authoritativeRead: false, arguments: { op: 'reconcile' } }
    const request = { schemaVersion: 'gaia2-task-reconciliation-request-v1', mode: 'enforce', source: { userRef: 'user-1', sourceHash: hash(content), quote: content },
      obligations: [{ id: 'send-any-resource', canonicalName: 'EmailClientV2__send_email', minCalls: 1, maxCalls: 1 }] }
    invoke(values, 'gaia2-task-reconciliation', { action: actionValue, messages: [userMessage(content)],
      outcome: { status: 'succeeded', executed: true, complete: true, result: { taskReconciliation: request } } })
    assert.equal(values.gaia2_task_reconciliation.obligations[0].status, 'ledger_incomplete')
  })
  test('an empty ledger can satisfy a zero-call contract but not a positive-call contract', () => {
    const content = 'Do not perform any native action.'
    const actionValue = { id: 'contract-review-zero-call', name: 'capybara_task_reconcile', canonicalName: 'CapybaraTaskContract__review', effect: 'read', resourceKey: 'CapybaraTaskContract', authoritativeRead: false, arguments: { op: 'reconcile' } }
    const zeroValues = defaults()
    const zeroRequest = { schemaVersion: 'gaia2-task-reconciliation-request-v1', mode: 'enforce', source: { userRef: 'user-1', sourceHash: hash(content), quote: content }, obligations: [{ id: 'no-native-call', canonicalName: domains[0].write, effect: 'write', resourceKey: domains[0].resource, minCalls: 0, maxCalls: 0 }] }
    invoke(zeroValues, 'gaia2-task-reconciliation', { action: actionValue, messages: [userMessage(content)], outcome: { status: 'succeeded', executed: true, complete: true, result: { taskReconciliation: zeroRequest } } })
    assert.equal(zeroValues.gaia2_task_reconciliation.obligations[0].status, 'satisfied')
    assert.deepEqual(zeroValues.gaia2_task_reconciliation.mismatches, [])
    const positiveValues = defaults()
    const positiveRequest = { ...zeroRequest, obligations: [{ ...zeroRequest.obligations[0], id: 'one-native-call', minCalls: 1, maxCalls: 1 }] }
    invoke(positiveValues, 'gaia2-task-reconciliation', { action: actionValue, messages: [userMessage(content)], outcome: { status: 'succeeded', executed: true, complete: true, result: { taskReconciliation: positiveRequest } } })
    assert.equal(positiveValues.gaia2_task_reconciliation.obligations[0].status, 'missing')
  })
  test('a contradictory zero-call ledger remains incomplete rather than bypassing the gate', () => {
    const content = 'Do not perform any native action.', values = defaults()
    values.gaia2_action_ledger = { schemaVersion: 'gaia2-action-ledger-v1', totalCalls: 0, groups: [], recent: [], omittedGroups: 1, scopes: [] }
    const actionValue = { id: 'contract-review-contradictory-zero', name: 'capybara_task_reconcile', canonicalName: 'CapybaraTaskContract__review', effect: 'read', resourceKey: 'CapybaraTaskContract', authoritativeRead: false, arguments: { op: 'reconcile' } }
    const request = { schemaVersion: 'gaia2-task-reconciliation-request-v1', mode: 'enforce', source: { userRef: 'user-1', sourceHash: hash(content), quote: content }, obligations: [{ id: 'no-native-call', canonicalName: domains[0].write, effect: 'write', resourceKey: domains[0].resource, minCalls: 0, maxCalls: 0 }] }
    invoke(values, 'gaia2-task-reconciliation', { action: actionValue, messages: [userMessage(content)], outcome: { status: 'succeeded', executed: true, complete: true, result: { taskReconciliation: request } } })
    assert.equal(values.gaia2_task_reconciliation.obligations[0].status, 'ledger_incomplete')
  })
  test('invalid ledger counters fail closed for reconciliation', () => {
    const content = 'Do not perform any native action.', values = defaults()
    values.gaia2_action_ledger = { schemaVersion: 'gaia2-action-ledger-v1', totalCalls: -1, groups: [], recent: [], omittedGroups: 0, scopes: [] }
    const actionValue = { id: 'contract-review-invalid-counter', name: 'capybara_task_reconcile', canonicalName: 'CapybaraTaskContract__review', effect: 'read', resourceKey: 'CapybaraTaskContract', authoritativeRead: false, arguments: { op: 'reconcile' } }
    const request = { schemaVersion: 'gaia2-task-reconciliation-request-v1', mode: 'enforce', source: { userRef: 'user-1', sourceHash: hash(content), quote: content }, obligations: [{ id: 'no-native-call', canonicalName: domains[0].write, effect: 'write', resourceKey: domains[0].resource, minCalls: 0, maxCalls: 0 }] }
    invoke(values, 'gaia2-task-reconciliation', { action: actionValue, messages: [userMessage(content)], outcome: { status: 'succeeded', executed: true, complete: true, result: { taskReconciliation: request } } })
    assert.equal(values.gaia2_task_reconciliation.obligations[0].status, 'ledger_incomplete')
  })
  test('actual action counts are isolated to the visible USER source scope', () => {
    const values = defaults(), domain = domains[2]
    const write = action(domain, 'send-1', hash('send-1'))
    invoke(values, 'gaia2-action-ledger', { action: write,
      outcome: { status: 'succeeded', complete: true, executed: true, resultHash: hash('r1') },
      messages: [userMessage('First request.') ] })
    invoke(values, 'gaia2-action-ledger', { action: { ...write, id: 'send-2', mutationKey: hash('send-2') },
      outcome: { status: 'succeeded', complete: true, executed: true, resultHash: hash('r2') },
      messages: [userMessage('First request.'), userMessage('Second request.', 'user-2')] })
    const actionValue = { id: 'contract-review-scope', name: 'capybara_task_reconcile', canonicalName: 'CapybaraTaskContract__review', effect: 'read', resourceKey: 'CapybaraTaskContract', authoritativeRead: false, arguments: { op: 'reconcile' } }
    const request = { schemaVersion: 'gaia2-task-reconciliation-request-v1', mode: 'enforce', source: { userRef: 'user-1', sourceHash: hash('First request.'), quote: 'First request.' }, obligations: [{ id: 'send-one', canonicalName: 'EmailClientV2__send_email', effect: 'write', minCalls: 1, maxCalls: 1 }] }
    invoke(values, 'gaia2-task-reconciliation', { action: actionValue, messages: [userMessage('First request.'), userMessage('Second request.', 'user-2')], outcome: { status: 'succeeded', executed: true, complete: true, result: { taskReconciliation: request } } })
    assert.equal(values.gaia2_task_reconciliation.obligations[0].actualCalls, 1)
    assert.equal(values.gaia2_task_reconciliation.obligations[0].status, 'satisfied')
  })
  test('explicit scopeAnchor merges only quoted USER scopes and excludes an unanchored later USER', () => {
    const values = defaults(), domain = domains[2], first = 'First request.', second = 'Continue the first request.', third = 'Start a separate request.'
    const write = action(domain, 'send-scope-1', hash('send-scope-1'))
    invoke(values, 'gaia2-action-ledger', { action: write,
      outcome: { status: 'succeeded', complete: true, executed: true, resultHash: hash('scope-1') }, messages: [userMessage(first)] })
    invoke(values, 'gaia2-action-ledger', { action: { ...write, id: 'send-scope-2', mutationKey: hash('send-scope-2') },
      outcome: { status: 'succeeded', complete: true, executed: true, resultHash: hash('scope-2') }, messages: [userMessage(first), userMessage(second, 'user-2')] })
    invoke(values, 'gaia2-action-ledger', { action: { ...write, id: 'send-scope-3', mutationKey: hash('send-scope-3') },
      outcome: { status: 'succeeded', complete: true, executed: true, resultHash: hash('scope-3') }, messages: [userMessage(first), userMessage(second, 'user-2'), userMessage(third, 'user-3')] })
    const actionValue = { id: 'contract-review-anchor', name: 'capybara_task_reconcile', canonicalName: 'CapybaraTaskContract__review', effect: 'read', resourceKey: 'CapybaraTaskContract', authoritativeRead: false, arguments: { op: 'reconcile' } }
    const request = { schemaVersion: 'gaia2-task-reconciliation-request-v1', mode: 'enforce', source: { userRef: 'user-1', sourceHash: hash(first), quote: first,
      scopeAnchor: { members: [{ userRef: 'user-1', sourceHash: hash(first), quote: first }, { userRef: 'user-2', sourceHash: hash(second), quote: second }] } }, obligations: [{ id: 'send-two', canonicalName: domain.write, effect: 'write', minCalls: 2, maxCalls: 2 }] }
    invoke(values, 'gaia2-task-reconciliation', { action: actionValue, messages: [userMessage(first), userMessage(second, 'user-2'), userMessage(third, 'user-3')], outcome: { status: 'succeeded', executed: true, complete: true, result: { taskReconciliation: request } } })
    assert.equal(values.gaia2_task_reconciliation.obligations[0].actualCalls, 2)
    assert.equal(values.gaia2_task_reconciliation.obligations[0].status, 'satisfied')
    request.source.scopeAnchor.members[1].sourceHash = 'f'.repeat(64)
    invoke(values, 'gaia2-task-reconciliation', { action: actionValue, messages: [userMessage(first), userMessage(second, 'user-2')], outcome: { status: 'succeeded', executed: true, complete: true, result: { taskReconciliation: request } } })
    assert.equal(values.gaia2_task_reconciliation.mismatches[0].status, 'invalid_declaration')
  })
  test('scopeAnchor continuation members must remain in visible USER order', () => {
    const values = defaults(), first = 'Root task.', second = 'Continue task.', third = 'Finish task.'
    const actionValue = { id: 'contract-review-order', name: 'capybara_task_reconcile', canonicalName: 'CapybaraTaskContract__review', effect: 'read', resourceKey: 'CapybaraTaskContract', authoritativeRead: false, arguments: { op: 'reconcile' } }
    const request = { schemaVersion: 'gaia2-task-reconciliation-request-v1', mode: 'enforce', source: { userRef: 'user-1', sourceHash: hash(first), quote: first,
      scopeAnchor: { members: [{ userRef: 'user-1', sourceHash: hash(first), quote: first }, { userRef: 'user-3', sourceHash: hash(third), quote: third }, { userRef: 'user-2', sourceHash: hash(second), quote: second }] } }, obligations: [] }
    invoke(values, 'gaia2-task-reconciliation', { action: actionValue, messages: [userMessage(first), userMessage(second, 'user-2'), userMessage(third, 'user-3')], outcome: { status: 'succeeded', executed: true, complete: true, result: { taskReconciliation: request } } })
    assert.equal(values.gaia2_task_reconciliation.mismatches[0].status, 'invalid_declaration')
  })
  test('ambiguous visible quotes are rejected as bounded declaration feedback', () => {
    const values = defaults(), content = 'Do it. Do it.'
    const actionValue = { id: 'contract-review-ambiguous', name: 'capybara_task_reconcile', canonicalName: 'CapybaraTaskContract__review', effect: 'read', resourceKey: 'CapybaraTaskContract', authoritativeRead: false, arguments: { op: 'reconcile' } }
    const request = { schemaVersion: 'gaia2-task-reconciliation-request-v1', mode: 'advisory', source: { userRef: 'user-1', sourceHash: hash(content), quote: 'Do it' }, obligations: [] }
    assert.doesNotThrow(() => invoke(values, 'gaia2-task-reconciliation', { action: actionValue, messages: [userMessage(content)], outcome: { status: 'succeeded', executed: true, complete: true, result: { taskReconciliation: request } } }))
    assert.equal(values.gaia2_task_reconciliation.mismatches[0].status, 'invalid_declaration')
  })
  test('a forged source digest is rejected even when the quote text is visible', () => {
    const values = defaults(), content = 'Send the approved message.'
    const actionValue = { id: 'contract-review-hash', name: 'capybara_task_reconcile', canonicalName: 'CapybaraTaskContract__review', effect: 'read', resourceKey: 'CapybaraTaskContract', authoritativeRead: false, arguments: { op: 'reconcile' } }
    const request = { schemaVersion: 'gaia2-task-reconciliation-request-v1', mode: 'advisory', source: { userRef: 'user-1', sourceHash: 'f'.repeat(64), quote: content }, obligations: [] }
    invoke(values, 'gaia2-task-reconciliation', { action: actionValue, messages: [userMessage(content)], outcome: { status: 'succeeded', executed: true, complete: true, result: { taskReconciliation: request } } })
    assert.equal(values.gaia2_task_reconciliation.mismatches[0].status, 'invalid_declaration')
  })
  test('invalid Actor declarations become bounded mismatches instead of technical Hook failure', () => {
    const values = defaults(), content = 'Do the requested action.'
    const actionValue = { id: 'contract-review-invalid', name: 'capybara_task_reconcile', canonicalName: 'CapybaraTaskContract__review', effect: 'read', resourceKey: 'CapybaraTaskContract', authoritativeRead: false, arguments: { op: 'reconcile' } }
    const request = { schemaVersion: 'gaia2-task-reconciliation-request-v1', mode: 'advisory', source: { userRef: 'user-1', sourceHash: hash(content), quote: content }, obligations: [{ id: 'bad', canonicalName: 'Calendar__add_calendar_event', effect: 'write', minCalls: 2, maxCalls: 1 }] }
    assert.doesNotThrow(() => invoke(values, 'gaia2-task-reconciliation', { action: actionValue, messages: [userMessage(content)], outcome: { status: 'succeeded', executed: true, complete: true, result: { taskReconciliation: request } } }))
    assert.equal(values.gaia2_task_reconciliation.mismatches[0].status, 'invalid_declaration')
  })
  test('actual action ledger records bounded counts without inferring expected obligations', () => {
    const values = defaults(), domain = domains[0]
    const read = action(domain, 'read-1', hash('query-1'), 'read')
    invoke(values, 'gaia2-action-ledger', { action: read,
      outcome: { status: 'succeeded', complete: true, executed: true, resultHash: hash('read-1') }, clock: { now: 1 } })
    invoke(values, 'gaia2-action-ledger', { action: { ...read, id: 'read-2' },
      outcome: { status: 'succeeded', complete: true, executed: true, resultHash: hash('read-2') }, clock: { now: 2 } })
    invoke(values, 'gaia2-action-ledger', { action: action(domain, 'write-1'),
      outcome: { status: 'failed_before_execution', complete: true, executed: false, resultHash: hash('failed') }, clock: { now: 3 } })
    const ledger = values.gaia2_action_ledger
    assert.equal(ledger.schemaVersion, 'gaia2-action-ledger-v1')
    assert.equal(ledger.totalCalls, 3)
    assert.equal(ledger.groups.find(item => item.effect === 'read').counts.succeeded, 2)
    assert.equal(ledger.groups.find(item => item.effect === 'write').counts.failed, 1)
    assert.match(values.gaia2_action_ledger_context, /expected actions are not inferred/)
    assert.doesNotMatch(values.gaia2_action_ledger_context, /arguments|content|recipient|subject/)
  })
  test('action ledger rejects forged or coerced persisted counters before appending a new action', () => {
    const values = defaults(), domain = domains[0]
    values.gaia2_action_ledger.totalCalls = '1'
    assert.throws(() => invoke(values, 'gaia2-action-ledger', {
      action: action(domain, 'invalid-ledger'),
      outcome: { status: 'succeeded', executed: true, complete: true, resultHash: hash('x') },
    }), /ACTION_LEDGER_STATE_INVALID/)
    values.gaia2_action_ledger = { schemaVersion: 'gaia2-action-ledger-v1', totalCalls: 1, groups: [{
      key: 'bad', canonicalName: domain.write, resourceKey: domain.resource, effect: 'write', totalCalls: 1,
      counts: { succeeded: 0, failed: 0, unknown: 0, not_executed: 0 },
    }], recent: [], omittedGroups: 0, omittedScopes: 0, scopes: [] }
    assert.throws(() => invoke(values, 'gaia2-action-ledger', {
      action: action(domain, 'invalid-group'),
      outcome: { status: 'succeeded', executed: true, complete: true, resultHash: hash('y') },
    }), /ACTION_LEDGER_STATE_INVALID/)
  })
  test('finish guard blocks unresolved actual writes but permits ordinary failed reads and environment stop', () => {
    const values = defaults()
    values.gaia2_action_ledger = { schemaVersion: 'gaia2-action-ledger-v1', totalCalls: 1, groups: [], omittedGroups: 0,
      recent: [{ actionId: 'unknown-write', canonicalName: 'EmailClientV2__send_email', resourceKey: 'Emails', effect: 'write', status: 'unknown', complete: false, executed: null, observedAt: 1 }] }
    const finish = { id: 'finish', name: 'AgentUserInterface__send_message_to_user', canonicalName: 'AgentUserInterface__send_message_to_user', effect: 'finish', resourceKey: 'AgentUserInterface', mutationKey: hash('finish'), arguments: { content: 'Done' } }
    assert.equal(invoke(values, 'gaia2-finish-guard', { action: finish }).decision.reason, 'action_ledger_unresolved')
    values.gaia2_action_ledger.recent = [{ actionId: 'failed-read', canonicalName: 'Contacts__get_contacts', resourceKey: 'Contacts', effect: 'read', status: 'failed', complete: true, executed: false, observedAt: 2 }]
    assert.equal(invoke(values, 'gaia2-finish-guard', { action: finish }).decision.action, 'allow')
    values.gaia2_action_ledger.recent = [{ actionId: 'cancelled-write', canonicalName: 'EmailClientV2__send_email', resourceKey: 'Emails', effect: 'write', status: 'not_executed', complete: false, executed: false, observedAt: 3 }]
    assert.equal(invoke(values, 'gaia2-finish-guard', { action: finish, messages: [{ notificationType: 'ENVIRONMENT_STOP' }] }).decision.action, 'allow')
  })
  test('finish guard retains unresolved group evidence after recent history rolls out', () => {
    const values = defaults(), finish = { id: 'finish', effect: 'finish' }
    values.gaia2_action_ledger = {
      schemaVersion: 'gaia2-action-ledger-v1', totalCalls: 49,
      groups: [{ key: 'send', canonicalName: 'EmailClientV2__send_email', resourceKey: 'Emails', effect: 'write', totalCalls: 1,
        counts: { succeeded: 0, failed: 0, unknown: 1, not_executed: 0 } }],
      recent: Array.from({ length: 48 }, (_, index) => ({ actionId: `read-${index}`, canonicalName: 'Contacts__get_contacts', resourceKey: 'Contacts', effect: 'read', status: 'succeeded' })),
      omittedGroups: 0, scopes: [], omittedScopes: 0,
    }
    const decision = invoke(values, 'gaia2-finish-guard', { action: finish }).decision
    assert.equal(decision.action, 'block')
    assert.equal(decision.reason, 'action_ledger_unresolved')
  })
  test('finish guard does not double-count the same unresolved group in global and USER scope ledgers', () => {
    const values = defaults(), finish = { id: 'finish', effect: 'finish' }
    const group = { key: 'send', canonicalName: 'EmailClientV2__send_email', resourceKey: 'Emails', effect: 'write', totalCalls: 1,
      counts: { succeeded: 0, failed: 0, unknown: 1, not_executed: 0 } }
    values.gaia2_action_ledger = { schemaVersion: 'gaia2-action-ledger-v1', totalCalls: 1,
      groups: [group], recent: [{ actionId: 'unknown-send', canonicalName: group.canonicalName, resourceKey: group.resourceKey,
        effect: 'write', status: 'unknown' }], omittedGroups: 0, scopes: [{ userRef: 'user-1', totalCalls: 1, groups: [group], recent: [], omittedGroups: 0 }], omittedScopes: 0 }
    const result = invoke(values, 'gaia2-finish-guard', { action: finish })
    assert.equal(result.decision.reason, 'action_ledger_unresolved')
    const boundary = result.artifacts.find(item => item.title === 'GAIA2 controller lifecycle boundary').value
    assert.equal(boundary.unresolvedGroupCount, 1)
    assert.equal(boundary.unresolvedGroups.length, 1)
  })
  test('finish guard blocks incomplete action groups even without a visible unresolved recent entry', () => {
    const values = defaults(), finish = { id: 'finish', effect: 'finish' }
    values.gaia2_action_ledger = {
      schemaVersion: 'gaia2-action-ledger-v1', totalCalls: 3, groups: [], recent: [],
      omittedGroups: 1, omittedScopes: 0, scopes: [],
    }
    const decision = invoke(values, 'gaia2-finish-guard', { action: finish }).decision
    assert.equal(decision.action, 'block')
    assert.equal(decision.reason, 'action_ledger_incomplete')
  })
  test('actual RuntimePluginHost accepts advisory evidence across calendar, contacts and email while retaining exact replay guards', { timeout: 120000 }, async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', pathToFileURL(join(backend, 'node_modules/tsx/dist/loader.mjs')).href,
      '--conditions=development', fileURLToPath(import.meta.url), '--probe'], { cwd: backend, timeout: 110000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })
    const report = JSON.parse(stdout.trim().split(/\r?\n/).at(-1))
    assert.equal(report.status, 'passed')
    assert.deepEqual(report.resources, domains.map(domain => domain.resource))
    assert.equal(report.realModelRequests, 0)
    assert.equal(report.nativeActions, 0)
    assert.equal(report.verifiedReceipts, 27)
    assert.equal(report.reconciledReceipts, 8)
  })
} else {
  const { RuntimePluginHost } = await import(pathToFileURL(join(backend, 'src/core/plugins/runtime-plugin-host.ts')).href)
  const files = readdirSync(plugin, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const path = join(entry.parentPath, entry.name)
    return { relativePath: path.slice(plugin.length + 1).replaceAll('\\', '/'), sha256: hash(readFileSync(path)) }
  })
  const workspaces = []
  let verifiedReceipts = 0
  let reconciledReceipts = 0
  try {
    for (const domain of domains) {
      const workspaceDir = mkdtempSync(join(tmpdir(), 'gaia2-actor-owned-hooks-')); workspaces.push(workspaceDir)
      const host = new RuntimePluginHost({ projectDir: project, workspaceDir, executionId: 'execution-1', sessionId: 'session-1', scenarioId: 'synthetic-' + domain.resource,
        plugins: [{ id: 'gaia2-runtime', snapshotRoot: plugin, files }] })
      await host.initialize()
      let iteration = 0
      const invokeHost = async (checkpoint, nativeAction, outcome, now = 0) => {
        const response = await host.invoke({ checkpoint, ...(nativeAction ? { action: nativeAction } : {}), ...(outcome ? { outcome } : {}),
          messages: [{ role: 'user', id: 'user-1', notificationType: 'USER_MESSAGE', content: 'Perform the requested actions without notifying me yet.' }],
          clock: { now, revision: iteration }, loop: { iteration: iteration++ } })
        const receipt = JSON.parse(readFileSync(response.evidencePath, 'utf8'))
        assert.equal(receipt.variablesHash, response.variablesHash)
        assert.equal(hash(receipt.variables), response.variablesHash)
        assert.ok(response.hookReceipts.every(item => ['passed', 'skipped'].includes(item.status)), JSON.stringify(response.hookReceipts))
        verifiedReceipts++
        return response
      }
      const read = action(domain, 'read-old', hash('query'), 'read')
      await invokeHost('after_tool', read, { status: 'succeeded', complete: true, executed: true, resultHash: hash('old'), result: [] })
      await invokeHost('after_tool', { ...read, id: 'failed-read', mutationKey: hash('failed-query') },
        { status: 'failed_before_execution', complete: false, executed: false, resultHash: hash('error'), result: { error: 'native failed' } }, 1)
      const write = action(domain)
      assert.equal((await invokeHost('before_tool', write, null, 120)).decision.action, 'allow')
      await invokeHost('after_tool', write, { status: 'unknown', complete: false, executed: true, resultHash: hash('unknown'), result: { error: 'lost response' } }, 121)
      const other = action(domain, 'other-write', hash('operation-2'))
      assert.equal((await invokeHost('before_tool', other, null, 122)).decision.action, 'allow')
      assert.equal((await invokeHost('before_tool', { ...write, id: 'replay' }, null, 123)).decision.action, 'read_back')
      await invokeHost('after_tool', other, { status: 'succeeded', complete: true, executed: true, resultHash: hash('applied'), result: { ok: true } }, 124)
      assert.equal((await invokeHost('before_tool', { ...other, id: 'duplicate' }, null, 125)).decision.action, 'block')
      const finish = { id: 'finish', name: 'AgentUserInterface__send_message_to_user', canonicalName: 'AgentUserInterface__send_message_to_user',
        effect: 'finish', resourceKey: 'AgentUserInterface', mutationKey: hash('finish'), idempotent: false, authoritativeRead: false, arguments: { message: 'Done' } }
      assert.equal((await invokeHost('before_tool', finish, null, 126)).decision.action, 'block')
    }
    // Exercise the production Host path: a successful native call is scoped to
    // the visible USER record, the Actor reconciliation is admitted through
    // the dedicated control action, and the finish gate observes its state.
    const reconciliationWorkspace = mkdtempSync(join(tmpdir(), 'gaia2-reconciliation-host-')); workspaces.push(reconciliationWorkspace)
    const reconciliationHost = new RuntimePluginHost({ projectDir: project, workspaceDir: reconciliationWorkspace, executionId: 'execution-reconcile', sessionId: 'session-reconcile', scenarioId: 'synthetic-reconciliation',
      plugins: [{ id: 'gaia2-runtime', snapshotRoot: plugin, files }] })
    await reconciliationHost.initialize()
    const userContent = 'Send exactly one email.'
    const user = userMessage(userContent)
    const send = action(domains[2], 'send-reconcile', hash('send-reconcile'))
    const sendResponse = await reconciliationHost.invoke({ checkpoint: 'after_tool', action: send,
      outcome: { status: 'succeeded', complete: true, executed: true, resultHash: hash('send-reconcile-result') },
      messages: [user], clock: { now: 1, revision: 1 }, loop: { iteration: 0 } })
    assert.ok(sendResponse.hookReceipts.every(item => ['passed', 'skipped'].includes(item.status)), JSON.stringify(sendResponse.hookReceipts))
    const review = { id: 'review-reconcile', name: 'capybara_task_reconcile', canonicalName: 'CapybaraTaskContract__review', effect: 'read', resourceKey: 'CapybaraTaskContract', authoritativeRead: false, arguments: { op: 'reconcile' } }
    const request = { schemaVersion: 'gaia2-task-reconciliation-request-v1', mode: 'enforce', source: { userRef: user.id, sourceHash: hash(userContent), quote: userContent }, obligations: [{ id: 'send-one', canonicalName: domains[2].write, resourceKey: domains[2].resource, effect: 'write', minCalls: 1, maxCalls: 1 }] }
    const reviewResponse = await reconciliationHost.invoke({ checkpoint: 'after_tool', action: review,
      outcome: { status: 'succeeded', complete: true, executed: true, result: { taskReconciliation: request } },
      messages: [user], clock: { now: 2, revision: 2 }, loop: { iteration: 1 } })
    assert.ok(reviewResponse.hookReceipts.every(item => ['passed', 'skipped'].includes(item.status)), JSON.stringify(reviewResponse.hookReceipts))
    const reviewReceipt = JSON.parse(readFileSync(reviewResponse.evidencePath, 'utf8'))
    assert.equal(reviewReceipt.variables.gaia2_task_reconciliation.status, 'enforce')
    assert.deepEqual(reviewReceipt.variables.gaia2_task_reconciliation.mismatches, [])
    const finishResponse = await reconciliationHost.invoke({ checkpoint: 'before_tool', action: { id: 'finish-reconcile', name: 'AgentUserInterface__send_message_to_user', canonicalName: 'AgentUserInterface__send_message_to_user', effect: 'finish', resourceKey: 'AgentUserInterface', mutationKey: hash('finish-reconcile'), idempotent: false, arguments: { message: 'Done' } },
      messages: [user], clock: { now: 3, revision: 3 }, loop: { iteration: 2 } })
    assert.equal(finishResponse.decision.action, 'allow', JSON.stringify(finishResponse.decision))
    assert.ok(finishResponse.hookReceipts.every(item => ['passed', 'skipped'].includes(item.status)), JSON.stringify(finishResponse.hookReceipts))
    // Field-level checks use only Host-derived digests. A wrong declared
    // recipient remains an enforce mismatch until the Actor submits a valid
    // enforce review; no evaluator/oracle data participates.
    const fieldWorkspace = mkdtempSync(join(tmpdir(), 'gaia2-reconciliation-fields-')); workspaces.push(fieldWorkspace)
    const fieldHost = new RuntimePluginHost({ projectDir: project, workspaceDir: fieldWorkspace, executionId: 'execution-fields', sessionId: 'session-fields', scenarioId: 'synthetic-reconciliation-fields',
      plugins: [{ id: 'gaia2-runtime', snapshotRoot: plugin, files }] })
    await fieldHost.initialize()
    const fieldContent = 'Send to the approved recipient.'
    const fieldUser = userMessage(fieldContent)
    const wrongRecipient = 'wrong@example.com', rightRecipient = 'right@example.com'
    const fieldAction = { ...action(domains[2], 'send-fields', hash('send-fields')), arguments: { recipient: wrongRecipient } }
    const fieldNative = await fieldHost.invoke({ checkpoint: 'after_tool', action: fieldAction,
      outcome: { status: 'succeeded', complete: true, executed: true, resultHash: hash('fields-result') },
      messages: [fieldUser], clock: { now: 1, revision: 1 }, loop: { iteration: 0 } })
    assert.ok(fieldNative.hookReceipts.every(item => ['passed', 'skipped'].includes(item.status)), JSON.stringify(fieldNative.hookReceipts))
    const fieldReview = { id: 'review-fields', name: 'capybara_task_reconcile', canonicalName: 'CapybaraTaskContract__review', effect: 'read', resourceKey: 'CapybaraTaskContract', authoritativeRead: false, arguments: { op: 'reconcile' } }
    const fieldRequest = { schemaVersion: 'gaia2-task-reconciliation-request-v1', mode: 'enforce', source: { userRef: fieldUser.id, sourceHash: hash(fieldContent), quote: fieldContent }, obligations: [{ id: 'send-recipient', canonicalName: domains[2].write, resourceKey: domains[2].resource, effect: 'write', minCalls: 1, maxCalls: 1, argumentChecks: [{ path: '/recipient', op: 'equals_hash', expectedHash: hash(JSON.stringify(rightRecipient)) }] }] }
    const fieldReviewResponse = await fieldHost.invoke({ checkpoint: 'after_tool', action: fieldReview,
      outcome: { status: 'succeeded', complete: true, executed: true, result: { taskReconciliation: fieldRequest } },
      messages: [fieldUser], clock: { now: 2, revision: 2 }, loop: { iteration: 1 } })
    const fieldReceipt = JSON.parse(readFileSync(fieldReviewResponse.evidencePath, 'utf8'))
    assert.equal(fieldReceipt.variables.gaia2_task_reconciliation.obligations[0].status, 'argument_mismatch')
    const fieldFinish = { id: 'finish-fields', name: 'AgentUserInterface__send_message_to_user', canonicalName: 'AgentUserInterface__send_message_to_user', effect: 'finish', resourceKey: 'AgentUserInterface', mutationKey: hash('finish-fields'), idempotent: false, arguments: { message: 'Done' } }
    const blockedFieldFinish = await fieldHost.invoke({ checkpoint: 'before_tool', action: fieldFinish, messages: [fieldUser], clock: { now: 3, revision: 3 }, loop: { iteration: 2 } })
    assert.equal(blockedFieldFinish.decision.reason, 'task_reconciliation_unresolved')
    fieldRequest.obligations[0].argumentChecks[0].expectedHash = hash(JSON.stringify(wrongRecipient))
    const fixedReviewResponse = await fieldHost.invoke({ checkpoint: 'after_tool', action: fieldReview,
      outcome: { status: 'succeeded', complete: true, executed: true, result: { taskReconciliation: fieldRequest } },
      messages: [fieldUser], clock: { now: 4, revision: 4 }, loop: { iteration: 3 } })
    const fixedReceipt = JSON.parse(readFileSync(fixedReviewResponse.evidencePath, 'utf8'))
    assert.deepEqual(fixedReceipt.variables.gaia2_task_reconciliation.mismatches, [])
    const fixedFieldFinish = await fieldHost.invoke({ checkpoint: 'before_tool', action: { ...fieldFinish, id: 'finish-fields-fixed' }, messages: [fieldUser], clock: { now: 5, revision: 5 }, loop: { iteration: 4 } })
    assert.equal(fixedFieldFinish.decision.action, 'allow', JSON.stringify(fixedFieldFinish.decision))
    reconciledReceipts = 8
    console.log(JSON.stringify({ status: 'passed', resources: domains.map(domain => domain.resource), verifiedReceipts, reconciledReceipts, realModelRequests: 0, nativeActions: 0 }))
  } finally {
    for (const workspace of workspaces) rmSync(workspace, { recursive: true, force: true })
  }
}
