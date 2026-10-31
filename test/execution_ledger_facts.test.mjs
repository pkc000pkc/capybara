import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import { validateWriteState } from '../src/semantic_receipt.mjs'

const copy = value => JSON.parse(JSON.stringify(value))
const hash = value => createHash('sha256').update(value).digest('hex')
function fixture() {
  const values = Object.fromEntries(JSON.parse(readFileSync(new URL('../plugins/gaia2-runtime/variables.json', import.meta.url))).variables.map(v => [v.key, copy(v.value)]))
  const source = readFileSync(new URL('../plugins/gaia2-runtime/hooks/gaia2-write-outcome.ts', import.meta.url), 'utf8')
    .replace(/^import .*\n/, '').replace('export default defineHook(', 'module.exports = (')
  const context = { module: { exports: null } }; vm.runInNewContext(source, context, { timeout: 1000 })
  function record(id, tool, resource, status = 'succeeded', now = 100, user = 'original-user') {
    const result = context.module.exports.run({ variables: { builtin: { variables: values } },
      action: { id, canonicalName: tool, effect: 'write', resourceKey: resource, mutationKey: hash(id), idempotent: false },
      outcome: { status, executed: true, complete: status !== 'unknown', resultHash: hash(id + status) },
      clock: { now }, loop: { iteration: now }, messages: [{ role: 'user', notificationType: 'USER_MESSAGE', id: user }] })
    for (const p of result.patches) values[p.path.split('/').at(-1)] = copy(p.value)
    return result
  }
  return { values, record, hook: context.module.exports }
}

test('the whole existing ledger retains early calls after more than twelve later writes', () => {
  const { values, record } = fixture()
  for (let i = 0; i < 8; i++) record('old-' + i, 'Calendar__delete_calendar_event', 'Calendar')
  for (let i = 0; i < 20; i++) record('new-' + i, 'EmailClientV2__send_email', 'Emails')
  record('created', 'Calendar__add_calendar_event', 'Calendar')
  assert.equal(values.gaia2_write_state.actions.length, 29)
  assert.equal(values.gaia2_write_state.actions.filter(v => v.canonicalName === 'Calendar__delete_calendar_event').length, 8)
  assert.doesNotMatch(values.gaia2_mutation_context, /receiptId|old-0|new-19/)
  assert.ok(values.gaia2_mutation_context.length < 1000)
  validateWriteState(values.gaia2_write_state)
})

test('duplicate unconfirmed native callback is not another execution and keeps first source/time', () => {
  const { values, record } = fixture()
  record('same', 'Contacts__edit_contact', 'Contacts', 'succeeded', 100, 'first-user')
  const first = copy(values.gaia2_write_state.actions[0])
  record('same', 'Contacts__edit_contact', 'Contacts', 'succeeded', 999, 'next-user')
  assert.equal(values.gaia2_write_state.actions.length, 1)
  assert.deepEqual(values.gaia2_write_state.actions[0], first)
})

test('a contradictory duplicate cannot overwrite historical outcome', () => {
  const { values, record } = fixture()
  record('same', 'Calendar__add_calendar_event', 'Calendar')
  assert.throws(() => record('same', 'Calendar__add_calendar_event', 'Calendar', 'unknown'), /WRITE_ACTION_REPLAY_CONFLICT/)
  assert.equal(values.gaia2_write_state.actions[0].status, 'succeeded')
})

test('unknown and failed calls remain distinct across unrelated successful writes and readback', () => {
  const { values, record, hook } = fixture()
  record('unknown', 'Ledger__write', 'Ledger', 'unknown')
  record('failed', 'Calendar__delete_calendar_event', 'Calendar', 'failed_before_execution')
  record('other', 'Ledger__write', 'Ledger')
  const result = hook.run({ variables: { builtin: { variables: values } },
    action: { id: 'read', canonicalName: 'Ledger__read', effect: 'read', resourceKey: 'Ledger', authoritativeRead: true },
    outcome: { status: 'succeeded', complete: true, executed: true, resultHash: hash('read') }, clock: { now: 300 }, loop: { iteration: 4 } })
  for (const p of result.patches) values[p.path.split('/').at(-1)] = copy(p.value)
  assert.equal(values.gaia2_write_state.unknown.length, 1)
  assert.equal(values.gaia2_write_state.unknown[0].readBackObserved, true)
  assert.equal(values.gaia2_write_state.unknown[0].status, 'unknown')
  assert.equal(values.gaia2_write_state.actions.find(v => v.actionId === 'failed').status, 'failed_before_execution')
})

test('new optional execution descriptors are checked while old ledgers remain readable', () => {
  const { values, record } = fixture(); record('x', 'Calendar__delete_calendar_event', 'Calendar')
  const original = copy(values.gaia2_write_state)
  for (const [key, invalid] of [['canonicalName', 'not a tool'], ['effect', 'read'], ['observedAt', -1], ['currentUserRef', ''], ['executed', 'yes'], ['complete', 'yes']]) {
    const changed = copy(original); changed.actions[0][key] = invalid
    assert.throws(() => validateWriteState(changed), /semantic_write_/)
  }
  const legacy = copy(original)
  for (const key of ['canonicalName', 'effect', 'observedAt', 'currentUserRef', 'executed', 'complete']) delete legacy.actions[0][key]
  assert.doesNotThrow(() => validateWriteState(legacy))
})
