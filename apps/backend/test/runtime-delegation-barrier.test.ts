import assert from 'node:assert/strict'
import test from 'node:test'
import { runtimeExecutionState } from '#core/runtime-capability-projection'
import type { RuntimeTaskControl } from '#protocol/runtime-protocol'

function task(): RuntimeTaskControl {
  return {
    taskId: 'root', stateRevision: 1, planRevision: 1, goal: 'batch delegation', requiredActions: [], requiredEvidenceRefs: [], uncertainties: [],
    tasks: [{ id: 'child-a', title: 'A', dependsOn: [], completionConditions: ['A done'], owner: 'parent', capabilityIds: ['delegate_task'], requiredActions: [], evidenceRefs: [], status: 'pending' },
      { id: 'child-b', title: 'B', dependsOn: [], completionConditions: ['B done'], owner: 'parent', capabilityIds: ['delegate_task'], requiredActions: [], evidenceRefs: [], status: 'pending' }],
  }
}

test('active delegated children put the parent into a wait barrier', () => {
  const current = task()
  current.childAssignments = [{ planTaskId: 'child-a', childId: 'a', state: 'delegated', status: 'running' }]
  const execution = runtimeExecutionState(current)
  assert.equal(execution.phase, 'delegation_wait')
  assert.deepEqual(execution.activeTaskIds, [])
  assert.ok(execution.allowedDecisions.includes('wait'))
  assert.ok(!execution.allowedDecisions.includes('finish'))
})

test('terminal delegated children expose review phase until consumed', () => {
  const current = task()
  current.childAssignments = [{ planTaskId: 'child-a', childId: 'a', state: 'delegated', status: 'succeeded' }]
  const execution = runtimeExecutionState(current)
  assert.equal(execution.phase, 'delegation_review')
  assert.ok(execution.allowedDecisions.includes('tool_call'))
  assert.ok(!execution.allowedDecisions.includes('finish'))
})
