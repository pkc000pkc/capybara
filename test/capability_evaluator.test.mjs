import assert from 'node:assert/strict'
import test from 'node:test'
import { aggregateCapabilityPassAt5, evaluateAttempt, evaluateComputation, evaluatePlanning, evaluateSelection } from '../src/capability_evaluator.mjs'

test('selection evaluator reports precision, recall, and predicate failures', () => {
  const result = evaluateSelection({ expectedIds: ['a', 'b'], actualIds: ['a', 'c'], requiredPredicates: [{ name: 'date', passed: true }] })
  assert.equal(result.truePositives, 1)
  assert.equal(result.falsePositives, 1)
  assert.equal(result.falseNegatives, 1)
  assert.equal(result.precision, 0.5)
  assert.equal(result.recall, 0.5)
  assert.equal(result.passed, false)
})

test('computation evaluator uses explicit numeric tolerance and keeps failures visible', () => {
  const result = evaluateComputation({ checks: [
    { name: 'sum', expected: 3, actual: 3.001, tolerance: 0.01 },
    { name: 'count', expected: 2, actual: 3 },
  ] })
  assert.equal(result.passedCount, 1)
  assert.equal(result.failedCount, 1)
  assert.equal(result.checkPassRate, 0.5)
  assert.equal(result.passed, false)
})

test('planning evaluator checks partial-order dependencies, coverage, and duplicates', () => {
  const result = evaluatePlanning({
    requiredSteps: [{ id: 'read', after: [] }, { id: 'write', after: ['read'] }],
    observedSteps: ['write', 'read', 'read'],
  })
  assert.deepEqual(result.missingSteps, [])
  assert.deepEqual(result.orderViolations, [{ step: 'write', dependency: 'read' }])
  assert.deepEqual(result.duplicateSteps, ['read'])
  assert.equal(result.passed, false)
})

function goodAttempt(overrides = {}) {
  return evaluateAttempt({ capability: 'search', contract: {
    selection: { expectedIds: ['a'], requiredPredicates: [{ name: 'filter', passed: true }] },
    computation: { checks: [{ expected: 2, actual: 2 }] },
    planning: { requiredSteps: [{ id: 'read', after: [] }], observedSteps: ['read'] },
  }, evidence: { selection: { actualIds: ['a'] } }, result: {}, ...overrides })
}

test('attempt evaluator separates technical and judge-protocol failures from model failures', () => {
  assert.equal(goodAttempt().failureClass, null)
  assert.equal(goodAttempt({ result: { technicalError: 'hook_timeout' } }).failureClass, 'technical')
  assert.equal(goodAttempt({ result: { judgeProtocolAffected: true } }).failureClass, 'judge_protocol')
  const modelFailure = goodAttempt({ evidence: { selection: { actualIds: ['wrong'] } } })
  assert.equal(modelFailure.failureClass, 'model')
  assert.equal(modelFailure.passed, false)
})

test('pass@5 is incomplete when technical or judge-invalid attempts reduce reliable count', () => {
  const valid = Array.from({ length: 3 }, () => goodAttempt())
  const attempts = [...valid, goodAttempt({ result: { technicalError: 'timeout' } }), goodAttempt({ result: { judgeProtocolAffected: true } })]
  const result = aggregateCapabilityPassAt5({ scenarioId: 's1', capability: 'search', attempts })
  assert.equal(result.validAttemptCount, 3)
  assert.equal(result.technicalAttemptCount, 1)
  assert.equal(result.judgeProtocolAttemptCount, 1)
  assert.equal(result.passAt5, null)
  assert.equal(result.status, 'incomplete')
  assert.equal(result.observedPassAt5, 1)
})

test('pass@5 is one only when all five reliable attempts are evaluated and one passes', () => {
  const attempts = [goodAttempt(), goodAttempt(), goodAttempt(), goodAttempt(), goodAttempt()]
  const result = aggregateCapabilityPassAt5({ scenarioId: 's2', capability: 'planning', attempts })
  assert.equal(result.validAttemptCount, 5)
  assert.equal(result.passAt5, 1)
  assert.equal(result.status, 'passed')
})

test('pass@5 rejects non-five attempts instead of silently padding the denominator', () => {
  assert.throws(() => aggregateCapabilityPassAt5({ scenarioId: 's3', capability: 'calculation', attempts: [goodAttempt()] }), /exactly five attempts/)
})

