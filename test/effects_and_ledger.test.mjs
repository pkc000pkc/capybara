import test from 'node:test'
import assert from 'node:assert/strict'
import { canRetry, defineToolContract } from '../src/tool_contract.mjs'
import { WriteActionLedger } from '../src/write_action_ledger.mjs'

test('tool contracts reject unsafe automatic retries and classify retry policy', () => {
  assert.throws(
    () => defineToolContract('send_mail', { effects: ['message'], maxRetries: 1 }),
    /non-idempotent mutation/,
  )
  const read = defineToolContract('search', { effects: ['read'], maxRetries: 2 })
  const write = defineToolContract('update', { effects: ['write'], idempotent: true, maxRetries: 1 })
  assert.equal(canRetry(read, { resultKnown: false }), true)
  assert.equal(canRetry(write, { resultKnown: false }), true)
})

test('write ledger deduplicates successful mutation keys and blocks unknown replay', () => {
  const ledger = new WriteActionLedger()
  const started = ledger.start({
    actionId: 'a-1',
    toolName: 'calendar.create',
    operation: 'create',
    args: { title: 'demo' },
    parentActionIds: ['parent-1'],
    mutationKey: 'scenario-1:calendar:create:1',
  })
  assert.equal(started.duplicate, false)
  ledger.complete('a-1', { beforeState: {}, afterState: { id: 'event-1' } })
  const duplicate = ledger.start({
    actionId: 'a-2',
    toolName: 'calendar.create',
    operation: 'create',
    args: { title: 'demo' },
    mutationKey: 'scenario-1:calendar:create:1',
  })
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.action.actionId, 'a-1')
  assert.deepEqual(duplicate.action.parentActionIds, ['parent-1'])

  const unknown = ledger.start({
    actionId: 'a-3',
    toolName: 'calendar.create',
    operation: 'create',
    args: { title: 'other' },
    mutationKey: 'scenario-1:calendar:create:2',
  })
  assert.equal(unknown.action.result, 'unknown')
  ledger.fail('a-3', new Error('transport timeout'), 'unknown')
  assert.throws(() => ledger.start({
    actionId: 'a-4',
    toolName: 'calendar.create',
    operation: 'create',
    args: { title: 'other' },
    mutationKey: 'scenario-1:calendar:create:2',
  }), /already has result unknown/)
})
