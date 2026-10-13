import test from 'node:test'
import assert from 'node:assert/strict'
import { buildResumePlan } from '../scripts/phase6_resume_plan.mjs'

const manifest = {
  runId: 'test-run', manifestHash: 'hash', mode: 'official_submission',
  tasks: [
    { executionId: 'a', phase: 'standard', config: 'execution', scenarioId: 's1', runNumber: 1 },
    { executionId: 'b', phase: 'noise', config: 'noise', scenarioId: 's2', runNumber: 1 },
  ],
}

test('resume planner reports retry and pending queues without changing state', () => {
  const state = { tasks: [
    { executionId: 'a', status: 'completed', sessions: [{}] },
    { executionId: 'b', status: 'retry_pending', sessions: [{}, {}] },
  ] }
  const plan = buildResumePlan({ manifest, state, onlyPhase: 'noise', onlyRunNumber: 1 })
  assert.equal(plan.status, undefined)
  assert.equal(plan.selectedExecutions, 1)
  assert.deepEqual(plan.selectedCounts, { pending: 0, running: 0, completed: 0, retry_pending: 1, terminal_failure: 0 })
  assert.equal(plan.needsResume, true)
  assert.deepEqual(plan.recommendedFlags, ['--execute', '--resume', '--retry-infrastructure'])
  assert.equal(plan.noModelExecution, true)
})

test('resume planner identifies a fresh execution plan', () => {
  const plan = buildResumePlan({ manifest, onlyPhase: 'standard', onlyRunNumber: 1, maxTasks: 1 })
  assert.equal(plan.needsResume, false)
  assert.equal(plan.needsExecution, true)
  assert.deepEqual(plan.recommendedFlags, ['--execute'])
  assert.deepEqual(plan.boundedExecutionIds, ['a'])
})
