import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { auditCheckpoint } from '../scripts/full_library_checkpoint_audit.mjs'

const write = (path, value) => writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), 'utf8')

test('checkpoint audit summarizes observable reasoning design signals without copying model text', () => {
  const root = mkdtempSync(join(process.cwd(), 'runs', 'checkpoint-audit-test-'))
  const task = join(root, 'task-0001'), output = join(task, 'output'), evidence = join(output, 'model-evidence')
  mkdirSync(evidence, { recursive: true })
  write(join(root, 'progress.json'), { runId: 'audit-test', manifestHash: 'm'.repeat(64), scope: { taskListHash: 's'.repeat(64) }, status: 'completed_scope' })
  write(join(task, 'report.json'), { executionId: 'execution-1', scenarioId: 'scenario-1', phase: 'standard', config: 'execution', status: 'evaluated', rawScore: 1, modelInputCount: 1 })
  write(join(evidence, 'model-000000-output.json'), { index: 0, content: 'private model text must not be copied', toolCalls: [{ id: 'call-1', name: 'Contacts__get_contacts', arguments: '{}' }] })
  write(join(output, 'runtime-events.jsonl'), [
    { type: 'execution_facts_injected' },
    { type: 'attempt_execution_ended', terminationReason: 'conversation_turn_limit', usage: { modelRequests: 1 } },
  ].map(item => JSON.stringify(item)).join('\n') + '\n')
  const result = auditCheckpoint({ runDir: root, start: 1, end: 1 })
  assert.equal(result.checkpoint.complete, true)
  assert.equal(result.aggregate.technical, 0)
  assert.equal(result.aggregate.reasoningConformance.noFinishLoop, 1)
  assert.equal(result.policy.rawModelReasoningCopied, false)
  assert.equal(JSON.stringify(result).includes('private model text'), false)
})

test('checkpoint audit separates terminal A2A drain from ordinary consumption and finish boundary', () => {
  const root = mkdtempSync(join(process.cwd(), 'runs', 'checkpoint-audit-drain-test-'))
  const task = join(root, 'task-0001'), output = join(task, 'output'), evidence = join(output, 'model-evidence')
  mkdirSync(evidence, { recursive: true })
  write(join(root, 'progress.json'), { runId: 'audit-drain-test', manifestHash: 'm'.repeat(64), scope: { taskListHash: 's'.repeat(64) }, status: 'completed_scope' })
  write(join(task, 'report.json'), { executionId: 'execution-drain-1', scenarioId: 'scenario-drain-1', phase: 'agent2agent', config: 'mini', status: 'evaluated', rawScore: 0, modelInputCount: 1 })
  write(join(evidence, 'model-000000-input.json'), { index: 0, content: '', toolCalls: [] })
  write(join(evidence, 'model-000000-output.json'), { index: 0, content: '', toolCalls: [] })
  write(join(output, 'runtime-events.jsonl'), [
    { type: 'a2a_child_result_published' },
    { type: 'a2a_parent_result_consumed' },
    { type: 'a2a_terminal_drain_requested' },
    { type: 'a2a_terminal_drain_completed' },
    { type: 'a2a_parent_convergence_checked', converged: true, pendingResults: 0 },
    { type: 'finish_gate_loop_stopped', reason: 'action_ledger_unresolved' },
    { type: 'attempt_execution_ended', terminationReason: 'finish_gate_loop', usage: { modelRequests: 1 } },
  ].map(item => JSON.stringify(item)).join('\n') + '\n')
  const result = auditCheckpoint({ runDir: root, start: 1, end: 1 })
  const taskAudit = result.tasks[0]
  assert.equal(taskAudit.designSignals.a2aLifecycle.terminalDrainRequested, 1)
  assert.equal(taskAudit.designSignals.a2aLifecycle.terminalDrainCompleted, 1)
  assert.equal(taskAudit.safeFinishBoundary, true)
  assert.equal(taskAudit.reasoningConformance.noTechnicalError, true)
  assert.equal(taskAudit.reasoningConformance.noFinishLoop, false)
})
