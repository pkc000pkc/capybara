import assert from 'node:assert/strict'
import test from 'node:test'

import { auditContextQualityReport } from '../demo/context-quality-report-audit.mjs'

function arm({ facts = true, input = 10, coverage = 0 } = {}) {
  return {
    answers: [{ validShape: true, correct: 2, expected: 2 }],
    rawSources: [{ path: 'a.txt', hash: 'a' }],
    coveredThrough: coverage,
    originalReadCount: 2,
    mainCalls: [{ rawReadGroups: facts ? 0 : 2 }],
    mainInput: input,
    documentFacts: { first: facts },
  }
}

test('quality report audit accepts an independent held-out comparison', () => {
  const report = {
    mainModel: 'fixture-main',
    organizerModel: 'fixture-organizer',
    promptBindings: [{ hash: 'prompt' }],
    results: [{
      id: 'heldout-1',
      comparable: true,
      deliveryPassed: true,
      comparison: { correctFieldsDelta: 0 },
      raw: arm({ input: 20, facts: false }),
      organized: arm({ input: 10, coverage: 3 }),
    }],
  }
  const audit = auditContextQualityReport(report)
  assert.equal(audit.passed, true)
  assert.deepEqual(audit.failures, [])
})

test('quality report audit accepts legacy reports that omit derived answer flags', () => {
  const report = {
    results: [{
      id: 'legacy-heldout',
      comparable: true,
      comparison: { correctFieldsDelta: 0 },
      raw: arm({ input: 20, facts: false }),
      organized: arm({ input: 10, coverage: 3 }),
    }],
  }
  assert.equal(auditContextQualityReport(report).passed, true)
})

test('quality report audit rejects a silent fact loss or unchanged input', () => {
  const report = {
    results: [{
      id: 'heldout-bad',
      comparable: true,
      deliveryPassed: true,
      comparison: { correctFieldsDelta: 0 },
      raw: arm({ input: 20, facts: false }),
      organized: arm({ input: 20, facts: false, coverage: 3 }),
    }],
  }
  const audit = auditContextQualityReport(report)
  assert.equal(audit.passed, false)
  assert.ok(audit.failures.includes('heldout-bad:noFactLoss'))
  assert.ok(audit.failures.includes('heldout-bad:lowerMainInput'))
})
