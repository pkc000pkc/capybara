import test from 'node:test'
import assert from 'node:assert/strict'
import { admitGaia2Candidate, extractGaia2Candidate, sanitizeGaia2Trace, selectGaia2Experiences } from '../src/experience_pipeline.mjs'

test('GAIA2 trace projection excludes evaluator fields and keeps process evidence', () => {
  const trace = sanitizeGaia2Trace({ capability: 'execution', oracleWithheld: 2, actions: [{ type: 'write_start', result: 'unknown' }], observationSummary: [{ status: 'incomplete' }], noise: { profile: 'information-noise', injected: 1, truncated: 1 } })
  assert.deepEqual(trace.actionKinds, ['write_start'])
  assert.deepEqual(trace.observationStatuses, ['incomplete'])
  assert.equal('oracle' in trace, false)
  assert.throws(() => sanitizeGaia2Trace({ referenceAnswer: 'hidden' }), /sealed evaluator violation/)
})

test('GAIA2 candidate promotes only after two clean replays', async () => {
  const candidate = extractGaia2Candidate({ capability: 'search', oracleWithheld: 1, actions: [], observationSummary: [{ status: 'conflicting' }] })
  const stages = []
  const admitted = await admitGaia2Candidate(candidate, async ({ stage, clean }) => { stages.push({ stage, clean }); return { passed: true } })
  assert.equal(admitted.stage, 'plugin_stable')
  assert.equal(admitted.replayCount, 2)
  assert.deepEqual(stages, [{ stage: 'candidate', clean: true }, { stage: 'project_experience', clean: true }])
  assert.deepEqual(selectGaia2Experiences([admitted], 'search').map((item) => item.id), [candidate.id])
})

test('GAIA2 candidate is not admitted when clean replay fails', async () => {
  const candidate = extractGaia2Candidate({ capability: 'time', actions: [], observationSummary: [] })
  const rejected = await admitGaia2Candidate(candidate, async () => ({ passed: false }))
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.stage, 'candidate')
})
