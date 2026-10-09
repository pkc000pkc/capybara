import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertOfficialSubmissionPlan, assertOfficialSubmissionProtocol, buildOfficialSubmissionPlan } from '../src/official_submission_config.mjs'

const root = join(import.meta.dirname, '..')
const protocol = JSON.parse(readFileSync(join(root, 'config/phase0-protocol.json'), 'utf8'))

test('official submission plan matches ARE 1.2.0 phase contract', () => {
  const plan = buildOfficialSubmissionPlan(protocol)
  assertOfficialSubmissionPlan(plan)
  assert.deepEqual(plan.dataset, protocol.datasets.submission)
  assert.equal(plan.phases[0].configs.length, 5)
  assert.equal(plan.phases[1].a2aAppProp, 1)
  assert.deepEqual(plan.phases[2].envEvents, { numEventsPerMinute: 10, seed: 0 })
})

test('frozen runner manifest advertises the same public profile', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'gaia2-runner-manifest.json'), 'utf8'))
  const plan = buildOfficialSubmissionPlan(protocol)
  assert.deepEqual(manifest.officialSubmissionProfile, {
    dataset: plan.dataset.id,
    split: plan.dataset.split,
    agent: plan.agent,
    traceDumpFormat: plan.traceDumpFormat,
    hfUpload: false,
    numRuns: 3,
    phases: plan.phases.map(({ phase, configs, a2aAppProp, noise, envEvents }) => ({
      phase, configs, a2aAppProp, noise, ...(envEvents ? { envEvents } : {}),
    })),
  })
})

test('official plan guard rejects accidental upload or non-default agent', () => {
  const plan = buildOfficialSubmissionPlan(protocol)
  assert.throws(() => assertOfficialSubmissionPlan({ ...plan, agent: 'custom' }), /default agent/)
  assert.throws(() => assertOfficialSubmissionPlan({ ...plan, hfUpload: 'some/dataset' }), /must not upload/)
})

test('protocol guard rejects non-validation official dataset', () => {
  assert.throws(() => assertOfficialSubmissionProtocol({
    ...protocol,
    datasets: { ...protocol.datasets, submission: { ...protocol.datasets.submission, split: 'test' } },
  }), /validation/)
})
