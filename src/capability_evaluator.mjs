/**
 * Deterministic, answer-blind capability evaluation helpers.
 *
 * This module deliberately does not call an LLM or interpret the official
 * ARE raw score.  A caller supplies sealed task-contract evidence and the
 * observed trace; infrastructure and judge-protocol failures are kept out of
 * model capability results.  The contract may be produced by a trusted
 * scenario adapter, but never by model-authored text.
 */

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function check(condition, message) {
  if (!condition) throw new Error(`Capability evaluator: ${message}`)
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && value.length > 0))]
}

/** Evaluate a set-selection contract without looking at answer text. */
export function evaluateSelection({ expectedIds, actualIds, requiredPredicates = null } = {}) {
  const expected = uniqueStrings(expectedIds)
  const actual = uniqueStrings(actualIds)
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  const truePositives = actual.filter(id => expectedSet.has(id)).length
  const falsePositives = actual.length - truePositives
  const falseNegatives = expected.filter(id => !actualSet.has(id)).length
  const predicateChecks = Array.isArray(requiredPredicates)
    ? requiredPredicates.map(item => ({
      name: typeof item?.name === 'string' ? item.name : null,
      passed: item?.passed === true,
    }))
    : []
  const predicatesPassed = predicateChecks.every(item => item.passed)
  const available = expected.length > 0 || actual.length > 0 || predicateChecks.length > 0
  return {
    available,
    expectedCount: expected.length,
    actualCount: actual.length,
    truePositives,
    falsePositives,
    falseNegatives,
    precision: ratio(truePositives, actual.length),
    recall: ratio(truePositives, expected.length),
    predicateChecks,
    predicatesPassed,
    passed: available && falsePositives === 0 && falseNegatives === 0 && predicatesPassed,
  }
}

function valuesEqual(expected, actual, tolerance = 0) {
  if (finiteNumber(expected) && finiteNumber(actual)) return Math.abs(expected - actual) <= tolerance
  return Object.is(expected, actual)
}

/** Evaluate numeric/date/value checks supplied by a trusted task contract. */
export function evaluateComputation({ checks = [] } = {}) {
  const rows = Array.isArray(checks) ? checks.map((item, index) => {
    const tolerance = item?.tolerance === undefined ? 0 : item.tolerance
    const validTolerance = finiteNumber(tolerance) && tolerance >= 0
    const passed = validTolerance && valuesEqual(item?.expected, item?.actual, tolerance)
    return { index, name: typeof item?.name === 'string' ? item.name : null, passed,
      tolerance: validTolerance ? tolerance : null }
  }) : []
  const available = rows.length > 0
  const passedCount = rows.filter(item => item.passed).length
  return { available, checks: rows, passedCount, failedCount: rows.length - passedCount,
    passed: available && passedCount === rows.length, checkPassRate: ratio(passedCount, rows.length) }
}

/**
 * Evaluate required planning steps and their partial-order dependencies.
 * `requiredSteps` entries are {id, after:[id...]}; `observedSteps` is the
 * trace-derived ordered list.  This tests order and coverage, not wording.
 */
export function evaluatePlanning({ requiredSteps = [], observedSteps = [] } = {}) {
  const required = Array.isArray(requiredSteps)
    ? requiredSteps.filter(item => typeof item?.id === 'string' && item.id.length > 0).map(item => ({
      id: item.id, after: uniqueStrings(item.after),
    })) : []
  const observed = uniqueStrings(observedSteps)
  const observedSet = new Set(observed)
  const missingSteps = required.map(item => item.id).filter(id => !observedSet.has(id))
  const orderViolations = []
  const positions = new Map(observed.map((id, index) => [id, index]))
  for (const step of required) {
    if (!positions.has(step.id)) continue
    for (const dependency of step.after) {
      if (positions.has(dependency) && positions.get(dependency) > positions.get(step.id)) {
        orderViolations.push({ step: step.id, dependency })
      }
    }
  }
  const duplicateSteps = (Array.isArray(observedSteps) ? observedSteps : []).filter((id, index, values) => values.indexOf(id) !== index)
  const available = required.length > 0 || observed.length > 0
  const covered = required.length - missingSteps.length
  return { available, requiredCount: required.length, observedCount: observed.length,
    coveredCount: covered, coverage: ratio(covered, required.length), missingSteps,
    orderViolations, duplicateSteps, passed: available && missingSteps.length === 0 && orderViolations.length === 0 }
}

/**
 * Evaluate one attempt.  Reliability is intentionally independent from the
 * official score: protocol-affected and technical attempts are not model
 * failures, and attempts without a trusted contract remain indeterminate.
 */
export function evaluateAttempt({ capability, contract = {}, evidence = {}, trace = [], result = {} } = {}) {
  check(typeof capability === 'string' && capability.length > 0, 'capability is required')
  check(contract && typeof contract === 'object' && !Array.isArray(contract), 'contract must be an object')
  const technical = result.infrastructureError === true || result.technicalError != null || evidence.technicalError != null
  const judgeAffected = result.judgeProtocolAffected === true || evidence.judgeProtocolAffected === true
    || ['protocol_affected', 'unknown'].includes(result.scoreReliability)
    || ['protocol_affected', 'unknown'].includes(evidence.scoreReliability)
  const reliability = technical ? 'technical' : judgeAffected ? 'judge_protocol' : 'reliable'
  const source = evidence && typeof evidence === 'object' ? evidence : {}
  const dimensions = {
    selection: evaluateSelection({ ...(contract.selection ?? {}), ...(source.selection ?? {}) }),
    computation: evaluateComputation({ ...(contract.computation ?? {}), ...(source.computation ?? {}) }),
    planning: evaluatePlanning({ ...(contract.planning ?? {}), ...(source.planning ?? {}) }),
  }
  const availableDimensions = Object.values(dimensions).filter(item => item.available)
  const modelEvaluable = reliability === 'reliable' && availableDimensions.length > 0
  const passed = modelEvaluable && availableDimensions.every(item => item.passed)
  const failureClass = technical ? 'technical' : judgeAffected ? 'judge_protocol' : modelEvaluable ? (passed ? null : 'model') : 'indeterminate'
  return {
    schemaVersion: 'gaia2-capability-attempt-v1', capability, reliability, modelEvaluable,
    passed, failureClass, dimensions, traceEventCount: Array.isArray(trace) ? trace.length : 0,
    officialRawScore: result.rawScore ?? null,
    scoreReliability: result.scoreReliability ?? evidence.scoreReliability ?? (reliability === 'reliable' ? 'unclassified' : reliability),
  }
}

/**
 * Strict pass@5 aggregation.  Exactly five attempt records are required;
 * technical/judge-protocol attempts are invalid rather than failed.  If fewer
 * than five reliable attempts remain, passAt5 is null and the bounds expose
 * the observed lower/upper range without inventing failures.
 */
export function aggregateCapabilityPassAt5({ scenarioId, capability, attempts } = {}) {
  check(typeof scenarioId === 'string' && scenarioId.length > 0, 'scenarioId is required')
  check(typeof capability === 'string' && capability.length > 0, 'capability is required')
  check(Array.isArray(attempts) && attempts.length === 5, 'exactly five attempts are required')
  const normalized = attempts.map((attempt, index) => ({ attemptIndex: index + 1, ...clone(attempt) }))
  const valid = normalized.filter(attempt => attempt?.reliability === 'reliable' && attempt?.modelEvaluable === true)
  const passed = valid.filter(attempt => attempt.passed === true).length
  const technical = normalized.filter(attempt => attempt?.failureClass === 'technical').length
  const judgeProtocol = normalized.filter(attempt => attempt?.failureClass === 'judge_protocol').length
  const indeterminate = normalized.length - valid.length - technical - judgeProtocol
  const complete = valid.length === 5
  return {
    schemaVersion: 'gaia2-capability-pass5-v1', scenarioId, capability,
    attempts: normalized, validAttemptCount: valid.length, technicalAttemptCount: technical,
    judgeProtocolAttemptCount: judgeProtocol, indeterminateAttemptCount: indeterminate,
    modelFailureCount: valid.length - passed, passedAttemptCount: passed,
    complete, passAt5: complete ? (passed > 0 ? 1 : 0) : null,
    observedPassAt5: passed > 0 ? 1 : 0,
    passAt5Bounds: { lower: complete && passed > 0 ? 1 : 0, upper: passed > 0 ? 1 : (complete ? 0 : 1) },
    attemptPassRate: valid.length > 0 ? passed / valid.length : null,
    status: complete ? (passed > 0 ? 'passed' : 'failed') : 'incomplete',
    exclusionPolicy: 'technical_and_judge_protocol_attempts_are_invalid_not_model_failures',
  }
}

