import assert from 'node:assert/strict'
import test from 'node:test'

import { RuntimeActivityState } from '#core/runtime-activity-state'

test('child session and process states are separately observable and replayable', () => {
  const state = new RuntimeActivityState()
  state.upsertChild({ id: 'child-1', parentSessionId: 'session-1', parentRunId: 'run-1', goal: 'collect evidence', status: 'delegated' })
  state.updateChild('child-1', 'running', { startedAt: '2026-11-07T00:00:00.000Z' })
  state.upsertProcess({ id: 'process-1', kind: 'tool', name: 'browser.read', projectId: 'project-1', sessionId: 'session-1', runId: 'run-1', status: 'running' })
  state.updateProcess('process-1', 'succeeded', { stoppedAt: '2026-11-07T00:00:01.000Z' })
  const snapshot = state.snapshot()
  assert.equal(snapshot.children.items[0]?.status, 'running')
  assert.equal(snapshot.processes.items[0]?.status, 'succeeded')
  const restored = new RuntimeActivityState()
  restored.restore(snapshot)
  assert.deepEqual(restored.snapshot(), snapshot)
})

test('unknown child and process statuses remain explicit', () => {
  const state = new RuntimeActivityState()
  state.upsertChild({ id: 'child-unknown', parentSessionId: 'session-1', goal: 'external action', status: 'unknown' })
  state.upsertProcess({ id: 'process-unknown', kind: 'application', name: 'project-app', projectId: 'project-1', status: 'unknown' })
  const snapshot = state.snapshot()
  assert.equal(snapshot.children.items[0]?.status, 'unknown')
  assert.equal(snapshot.processes.items[0]?.status, 'unknown')
})
