import test from 'node:test'
import assert from 'node:assert/strict'
import { ReplanController } from '../src/replan_controller.mjs'

test('replanning creates a child attempt and preserves parent lineage', () => {
  const controller = new ReplanController()
  const first = controller.start({ steps: ['search', 'book'] })
  controller.receiveEvent({ id: 'env-1', type: 'environment' })
  const child = controller.replan({ steps: ['search', 'ask_user'] }, 'listing changed')
  assert.equal(child.parentAttemptId, first.attemptId)
  assert.equal(child.state, 'running')
  assert.equal(controller.current().attemptId, child.attemptId)
  assert.equal(controller.snapshot().attempts[0].state, 'replanning')
})

test('replanning state survives checkpoint restore', () => {
  const source = new ReplanController()
  source.start({ steps: ['read'] })
  source.setState('waiting_event')
  const restored = new ReplanController()
  restored.restore(source.snapshot())
  assert.equal(restored.current().state, 'waiting_event')
})
