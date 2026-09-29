import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CheckpointStore } from '../src/checkpoint_store.mjs'
import { ClarificationGate } from '../src/clarification_gate.mjs'
import { EventBus } from '../src/event_bus.mjs'
import { VirtualClock } from '../src/virtual_clock.mjs'

test('virtual clock advances deterministically and resumes callback waits', () => {
  const clock = new VirtualClock(100)
  const fired = []
  clock.scheduleCallback(110, (event) => fired.push(event.timestamp))
  assert.deepEqual(clock.advanceTo(109), [])
  assert.deepEqual(clock.advanceTo(110), [{ id: 'wait-1', timestamp: 110 }])
  assert.deepEqual(fired, [110])
  assert.throws(() => clock.advanceTo(109), /monotonically/)
})

test('restored promise wait can be reattached after a process restart', async () => {
  const original = new VirtualClock(100)
  const pending = original.waitUntil(120)
  const checkpoint = original.snapshot()
  const restored = new VirtualClock()
  restored.restore(checkpoint)
  const reattached = restored.reattachWait(pending.waitId)
  restored.advanceTo(120)
  assert.equal(await reattached, 120)
})

test('event bus gates dependencies, supports duplicate source IDs, and deduplicates consumption', () => {
  const bus = new EventBus()
  const first = bus.publish({ id: 'user', type: 'user', scheduledAt: 0 })
  const second = bus.publish({ id: 'oracle', type: 'agent', scheduledAt: 1, dependencies: ['user'] })
  assert.deepEqual(bus.ready(1).map((event) => event.occurrence), [first])
  assert.equal(bus.consume(first), true)
  assert.equal(bus.consume(first), false)
  assert.deepEqual(bus.ready(1).map((event) => event.occurrence), [second])
  assert.equal(bus.consume(second), true)
})

test('checkpoint preserves clock and event state without replaying consumed events', () => {
  const clock = new VirtualClock(10)
  clock.scheduleCallback(20, () => {})
  const bus = new EventBus()
  const user = bus.publish({ id: 'user', type: 'user' })
  bus.consume(user)
  const store = new CheckpointStore()
  const checkpoint = store.save({
    virtualClock: clock.snapshot(),
    eventBus: bus.snapshot(),
    executedWriteActionIds: ['write-1'],
    pendingWaits: ['wait-1'],
  })
  assert.match(checkpoint.stateHash, /^[a-f0-9]{64}$/)

  const restoredClock = new VirtualClock()
  const restoredBus = new EventBus()
  const restored = store.load()
  restoredClock.restore(restored.state.virtualClock)
  restoredBus.restore(restored.state.eventBus)
  assert.equal(restoredClock.now(), 10)
  assert.deepEqual(restoredBus.ready(10), [])
  assert.deepEqual(restored.state.executedWriteActionIds, ['write-1'])
})

test('file-backed checkpoint can be loaded by a new store instance', () => {
  const directory = mkdtempSync(join(tmpdir(), 'capybara-gaia2-checkpoint-'))
  try {
    const path = join(directory, 'checkpoint.json')
    const first = new CheckpointStore(path)
    first.save({ virtualClock: { now: 42 }, executedWriteActionIds: ['write-7'] })
    const second = new CheckpointStore(path)
    assert.deepEqual(second.load()?.state, { virtualClock: { now: 42 }, executedWriteActionIds: ['write-7'] })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('clarification gate pauses on ambiguity and resumes only with an answer', () => {
  const gate = new ClarificationGate()
  const pending = gate.request({
    question: 'Which calendar should receive the event?',
    reason: 'two calendars match the request',
    safeActions: ['list_calendars'],
  })
  assert.equal(pending.state, 'waiting_user')
  assert.throws(() => gate.answer(pending.id, '   '), /cannot be empty/)
  const approved = gate.answer(pending.id, 'Work calendar')
  assert.equal(approved.state, 'approved')
  assert.equal(approved.answer, 'Work calendar')
})
