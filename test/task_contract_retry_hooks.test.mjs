/** Historical state-validator units only. The commit hook is disabled in production. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import vm from 'node:vm'

const plugin = fileURLToPath(new URL('../plugins/gaia2-runtime/', import.meta.url))
const clone = value => JSON.parse(JSON.stringify(value))
const hash = value => createHash('sha256').update(value).digest('hex')
const user = { role: 'user', id: 'user-original', notificationType: 'USER_MESSAGE', content: 'Monitor Warehouse updates for 37 seconds. Do not notify before the deadline.' }
const ref = kind => ({ path: 'a'.repeat(24) + '/' + kind + '-' + 'b'.repeat(32) + '.json', sha256: 'c'.repeat(64) })
const variables = () => Object.fromEntries(JSON.parse(readFileSync(join(plugin, 'variables.json'), 'utf8')).variables.map(row => [row.key, clone(row.value)]))
const archive = source => Object.fromEntries(Object.entries(clone(source)).filter(([key]) => key !== 'attemptHistory'))
function hook(name) {
  const code = readFileSync(join(plugin, 'hooks', name + '.ts'), 'utf8').replace(/^import .*\n/, '').replace('export default defineHook(', 'module.exports = (')
  const context = { module: { exports: null } }
  vm.runInNewContext(code, context, { timeout: 1000 })
  return context.module.exports
}
function failed() {
  return { userRef: user.id, sourceHash: hash(user.content), arrivedAt: 100, resolution: 'ambiguous', notificationPolicy: 'forbid',
    obligationIds: [], reason: 'model_transport_error', evidenceRef: ref('user'), proposalRef: null, reviewRef: null,
    rawProposalRef: null, normalizedProposalRef: null, anchoringRef: null, extractionRef: null,
    resolverProtocol: 'quote_v2', resolverAttempts: 1, resolverRetryable: true, errorCategory: 'transport_error', attemptHistory: [] }
}
function state(source = failed(), revision = 1) {
  return { schemaVersion: 'gaia2-task-contract-state-v1', enabled: true, executionId: 'controlled-execution', sessionId: 'controlled-session',
    revision, clock: 108, interruption: null, sources: [source], obligations: [] }
}
function recovered(before) {
  const source = { ...clone(before), resolution: 'registered', notificationPolicy: 'forbid_until_deadline', obligationIds: ['obligation-original'],
    reason: 'Independent whole-source review approved.', proposalRef: ref('normalized-proposal'), reviewRef: ref('review'),
    rawProposalRef: ref('raw-proposal'), normalizedProposalRef: ref('normalized-proposal'), anchoringRef: ref('anchoring'), extractionRef: ref('extraction'),
    resolverAttempts: 2, resolverRetryable: false, errorCategory: null, attemptHistory: [archive(before)] }
  const next = state(source, 2)
  next.obligations = [{ id: 'obligation-original', userRef: user.id, sourceHash: hash(user.content),
    span: { start: 0, end: user.content.length, text: user.content }, mode: 'monitor_until', deadline: 137,
    goal: 'Monitor Warehouse updates through the source-bound deadline', recipe: null, status: 'pending', pendingEvidence: null,
    counts: { watchCalls: 0, nativeWaits: 0, nativeScans: 0 }, lastSignal: null, lastReviewedActionId: null, completionReason: null }]
  return next
}
function commit(values, next) {
  // Explicit historical validation, not production Hook dispatch.
  assert.equal(hook('gaia2-task-contract-commit').enabled, false);
  const result = hook('gaia2-task-contract-commit').run({ variables: { builtin: { variables: values } },
    action: { id: 'commit-original', name: 'CapybaraTaskContract__commit', canonicalName: 'CapybaraTaskContract__commit', effect: 'read',
      resourceKey: 'CapybaraTaskContract', authoritativeRead: false, arguments: { op: 'state_update' } },
    outcome: { status: 'succeeded', result: { taskContractState: clone(next) } }, messages: [user],
    clock: { now: 108 }, loop: { runId: 'controlled-execution', iteration: 1 } })
  for (const patch of result.patches || []) values[patch.path.split('/').at(-1)] = clone(patch.value)
  return result
}
function setup() {
  const values = variables(), initial = state()
  commit(values, initial)
  return { values, initial, next: recovered(initial.sources[0]) }
}

test('historical validator only: accepts one audited retry without changing original source or deadline', () => {
  const { values, initial, next } = setup()
  commit(values, next)
  const actual = values.gaia2_task_contract_state
  assert.equal(actual.sources[0].resolution, 'registered')
  assert.equal(actual.sources[0].resolverAttempts, 2)
  assert.deepEqual(actual.sources[0].attemptHistory[0], archive(initial.sources[0]))
  assert.equal(actual.sources[0].arrivedAt, 100)
  assert.equal(actual.obligations[0].deadline, 137)
  const decision = hook('gaia2-finish-guard').run({ variables: { builtin: { variables: values } },
    action: { effect: 'finish' }, messages: [user], clock: { now: 108 } }).decision
  assert.equal(decision.action, 'allow', 'historical parsing no longer acts as business-completion admission')
})

test('historical validator only: rejects retry that loses complete prior-attempt history', () => {
  const { values, next } = setup()
  next.sources[0].attemptHistory = []
  assert.throws(() => commit(values, next), /TASK_CONTRACT_/)
})

test('historical validator only: rejects forged prior-attempt content even when history shape is valid', () => {
  for (const mutate of [old => { old.reason = 'fabricated' }, old => { old.errorCategory = 'protocol_error' }, old => { old.extractionRef = ref('extraction') }]) {
    const { values, next } = setup()
    mutate(next.sources[0].attemptHistory[0])
    assert.throws(() => commit(values, next), /TASK_CONTRACT_/)
  }
})

test('historical validator only: rejects changed arrival time even when archived history is changed to agree', () => {
  const { values, next } = setup()
  next.sources[0].arrivedAt = 101
  next.sources[0].attemptHistory[0].arrivedAt = 101
  next.obligations[0].deadline = 138
  assert.throws(() => commit(values, next), /TASK_CONTRACT_/)
})

test('historical validator only: rejects source-hash or immutable source-reference replacement on retry', () => {
  for (const mutate of [source => { source.sourceHash = 'd'.repeat(64) }, source => { source.evidenceRef = { ...ref('user'), sha256: 'e'.repeat(64) } }]) {
    const { values, next } = setup()
    mutate(next.sources[0])
    assert.throws(() => commit(values, next), /TASK_CONTRACT_/)
  }
})

test('historical validator only: rejects a retry from semantic ambiguity that was not technical-retryable', () => {
  const values = variables(), initial = state()
  initial.sources[0].resolverRetryable = false
  initial.sources[0].errorCategory = 'semantic_ambiguous'
  initial.sources[0].reason = 'review_rejected'
  commit(values, initial)
  const next = recovered(initial.sources[0])
  assert.throws(() => commit(values, next), /TASK_CONTRACT_/)
})

test('historical validator only: rejects registered-source rollback to an unresolved source', () => {
  const { values, initial, next } = setup()
  commit(values, next)
  const rollback = clone(initial)
  rollback.revision = 3
  assert.throws(() => commit(values, rollback), /TASK_CONTRACT_/)
})

test('historical validator only: rejects attempt two to three and cannot reset the resolver budget', () => {
  const { values, next } = setup()
  commit(values, next)
  for (const count of [3, 1]) {
    const extra = clone(next)
    extra.revision = 3
    extra.sources[0].resolverAttempts = count
    if (count === 3) extra.sources[0].attemptHistory.push(archive(next.sources[0]))
    else extra.sources[0].attemptHistory = []
    assert.throws(() => commit(values, extra), /TASK_CONTRACT_/)
  }
})

test('historical validator only: exhausted retries remain auditable but do not block Actor-owned finish', () => {
  const { values, initial } = setup()
  const exhausted = state({ ...clone(initial.sources[0]), resolverAttempts: 2, resolverRetryable: false,
    attemptHistory: [archive(initial.sources[0])] }, 2)
  commit(values, exhausted)
  const decision = hook('gaia2-finish-guard').run({ variables: { builtin: { variables: values } },
    action: { effect: 'finish' }, messages: [user], clock: { now: 108 } }).decision
  assert.equal(decision.reason, 'business_completion_actor_owned')
})

test('local evidence delivery read never enters native evidence, noise, write or conflict hooks', () => {
  const action = { canonicalName: 'CapybaraEvidence__read', effect: 'read', resourceKey: 'CapybaraEvidence', authoritativeRead: false }
  for (const name of ['gaia2-noise-classifier', 'gaia2-write-outcome', 'gaia2-write-guard', 'gaia2-conflict-gate']) {
    assert.equal(hook(name).trigger({ action }), false, name + ' must ignore local evidence presentation controls')
  }
})
