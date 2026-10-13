import assert from 'node:assert/strict'
import test from 'node:test'
import { hiddenTrainingContext } from '#core/experiments/training/learning-hook-runner'
import type { HookTrainingContext } from '#core/hooks/types'

test('hidden training boundary strips evaluator evidence and preserves observable execution', () => {
  const context: Omit<HookTrainingContext, 'parameters'> = {
    runId: 'run', phase: 'training',
    case: { id: 'case', sampleId: 'sample', question: 'observable question', thinking: 'HIDDEN_REASONING', expectedAnswer: 'HIDDEN_ANSWER', actualAnswer: 'observed answer', expectedTools: ['HIDDEN_TOOL'], actualTools: ['read'], toolCalls: [], transcript: [{ role: 'user', content: 'observable question' }] },
    evaluation: { passed: false, score: 0.73, rationale: 'HIDDEN_RATIONALE', metrics: { secret: 'HIDDEN_METRIC' }, details: 'HIDDEN_DETAILS', reference: { kind: 'text', status: 'available', source: { type: 'dataset' }, displayValue: 'HIDDEN_REFERENCE', requirements: [], actualStateChanges: [], failureTraces: ['HIDDEN_TRACE'], resolvedAt: 'date' } },
    priorResults: { secret: 'HIDDEN_PRIOR' },
    correctionAttempts: [{ ordinal: 1, summary: 'observable correction', strategy: 'read again', passed: false, score: 0.5, rationale: 'HIDDEN_CORRECTION', variableOverrides: {}, actualAnswer: 'observed retry', actualTools: [], toolCalls: [] }],
  }
  const original = structuredClone(context)
  const hidden = hiddenTrainingContext(context)
  assert.doesNotMatch(JSON.stringify(hidden), /HIDDEN_/)
  assert.equal(hidden.evaluation.score, 0)
  assert.equal(hidden.case.actualAnswer, 'observed answer')
  assert.equal(hidden.correctionAttempts?.[0]?.strategy, 'read again')
  assert.deepEqual(context, original)
  assert.equal(hiddenTrainingContext({ ...context, evaluation: { ...context.evaluation, passed: true } }).evaluation.score, 1)
})
