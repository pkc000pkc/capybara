import test from 'node:test'
import assert from 'node:assert/strict'
import { importScenarioRow } from '../src/scenario_importer.mjs'

function scenario(overrides = {}) {
  return {
    metadata: { definition: { scenario_id: 's-1', duration: 10, start_time: 100 } },
    apps: [{ name: 'mail', class_name: 'Mail', app_state: { secret: 'hidden' } }],
    events: [
      { event_id: 'user-1', event_type: 'USER', dependencies: [], action: { args: { prompt: 'hello' } } },
      { event_id: 'agent-1', event_type: 'AGENT', dependencies: ['user-1'], action: { args: { secret: 'oracle' } } },
    ],
    version: 'are_simulation_v1',
    augmentation: {},
    ...overrides,
  }
}

test('imports a safe agent view without raw state or oracle actions', () => {
  const imported = importScenarioRow({ scenario_id: 's-1', scenario: JSON.stringify(scenario()) }, 'test')
  assert.equal(imported.scenarioId, 's-1')
  assert.equal(imported.agentView.apps[0].name, 'mail')
  assert.equal('source' in imported, false)
  assert.equal('sourceRow' in imported, false)
  assert.equal('app_state' in imported.agentView.apps[0], false)
  assert.deepEqual(Object.keys(imported.agentView), ['scenarioId', 'capability', 'startTime', 'durationSeconds', 'apps'])
})

test('rejects a missing event dependency', () => {
  const invalid = scenario({
    events: [{ event_id: 'agent-1', event_type: 'AGENT', dependencies: ['missing'] }],
  })
  assert.throws(
    () => importScenarioRow({ scenario_id: 's-1', scenario: JSON.stringify(invalid) }, 'test'),
    /missing dependency/,
  )
})

test('rejects an event dependency cycle', () => {
  const invalid = scenario({
    events: [
      { event_id: 'a', event_type: 'AGENT', dependencies: ['b'] },
      { event_id: 'b', event_type: 'ENV', dependencies: ['a'] },
    ],
  })
  assert.throws(
    () => importScenarioRow({ scenario_id: 's-1', scenario: JSON.stringify(invalid) }, 'test'),
    /dependency cycle/,
  )
})
