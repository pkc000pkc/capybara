import assert from 'node:assert/strict'
import test from 'node:test'
import { chooseRestoredSessionId, knownSessionId } from '../src/app/session-selection'

const sessions = [{ id: 'session:old' }, { id: 'session:new' }]

test('invalid remembered session falls back to an existing project session instead of creating one', () => {
  assert.equal(chooseRestoredSessionId(sessions, undefined, 'session:missing'), 'session:old')
  assert.equal(chooseRestoredSessionId(sessions, 'session:new', 'session:missing'), 'session:new')
  assert.equal(knownSessionId(sessions, 'session:missing'), 'session:old')
  assert.equal(knownSessionId([{ id: 'local-session:project' }], 'local-session:project'), undefined)
})
