import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { SessionStore } from '#core/session-store'

test('SessionStore compresses repeated checkpoint state and restores it losslessly', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-session-compression-'))
  const store = new SessionStore(projectDir)
  try {
    const session = store.create('compressed state')
    const repeated = 'research-checkpoint-state\n'.repeat(200_000)
    const state = {
      version: 1,
      checkpoints: Array.from({ length: 4 }, (_, index) => ({ index, repeated })),
      cursor: { cycle: 12, ledgerHead: 'a'.repeat(64) },
    }

    store.save(session.id, state, 3)

    const summary = store.list().find((item) => item.id === session.id)
    assert.ok(summary)
    assert.equal(summary.restorable, true)
    assert.ok(summary.stateBytes < Buffer.byteLength(JSON.stringify(state)) / 10)
    assert.deepEqual(store.get(session.id)?.state, state)
  } finally {
    store.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('SessionStore preserves the last valid snapshot when a later save exceeds limits', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-session-limit-'))
  const store = new SessionStore(projectDir, { maxExpandedStateBytes: 256 })
  try {
    const session = store.create('bounded state')
    const valid = { version: 1, cursor: { cycle: 3 } }
    store.save(session.id, valid, 1)

    assert.throws(
      () => store.save(session.id, { version: 1, value: 'x'.repeat(1_000) }, 2),
      /writable expanded limit/,
    )
    assert.deepEqual(store.get(session.id)?.state, valid)
    assert.equal(store.get(session.id)?.session.requestCount, 1)
  } finally {
    store.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})
