import test from 'node:test'
import assert from 'node:assert/strict'
import { informationNoiseTransitionErrors as errors } from '../src/phase5_information_noise_evidence.mjs'

const hash = 'a'.repeat(64)
const base = () => ({
  gaia2_observation_state: { schemaVersion: 'gaia2-observation-state-v2', observations: [], provenance: [], stale_ids: [], unverified_ids: [], conflict_ids: [], visibility_ids: [] },
  gaia2_noise_state: { semanticVersion: 2, profile: 'off', seed: null, decisions: [], deduplicated: [], conflicts: [], quarantined: [], schedule_hash: '' },
  gaia2_progress_state: { steps: 0, consecutive_no_progress: 0, blocked_repetitions: 0, blocked_signature: null, last_reason: 'continue', recommendation: 'continue', seen_queries: [], seen_user_ids: [] },
  gaia2_runtime_policy: { stale_after_ms: 60000, no_progress_replan_after: 3, no_progress_stop_after: 6 },
  gaia2_write_state: { actions: [], unknown: [], blocked: [] },
})

function afterReceipt() {
  const previous = base(), action = { id: 'call-1', canonicalName: 'Files__cat', resourceKey: 'Files', mutationKey: hash, effect: 'read', authoritativeRead: true }
  const input = { checkpoint: 'after_tool', clock: { now: 10 }, action, outcome: { status: 'succeeded', complete: true, viewComplete: true, resultHash: hash }, messages: [] }
  const row = { observationId: 'obs-call-1', actionId: 'call-1', resourceKey: 'Files', canonicalName: 'Files__cat', queryHash: hash, resultHash: hash, fingerprint: hash, status: 'observed', outcomeStatus: 'succeeded', complete: true, viewComplete: true, observedAt: 10, authoritativeRead: true, provenance: { actionId: 'call-1', source: 'Files__cat', observedAt: 10 }, presentation: 'visible', freshness: 'fresh' }
  const variables = structuredClone(previous)
  variables.gaia2_observation_state = { ...variables.gaia2_observation_state, observations: [row], provenance: [row.provenance] }
  variables.gaia2_noise_state.decisions = [row]
  variables.gaia2_progress_state = { ...variables.gaia2_progress_state, steps: 1, seen_queries: [{ identity: JSON.stringify(['Files__cat', 'Files', hash]), resultHash: hash }], last_reason: 'new_observable_progress' }
  return { previousValues: previous, input, variables, artifacts: [{ title: 'GAIA2 observable evidence classification', value: row }, { title: 'GAIA2 finite progress decision', value: { actionId: 'call-1', advanced: true, resolved: false, consecutiveNoProgress: 0, recommendation: 'continue' } }], decision: { action: 'allow' } }
}

test('v2 after_tool binds the production observation shape and owned artifacts', () => {
  assert.deepEqual(errors(afterReceipt()), [])
})

test('v2 local control receipts do not require a native noise classification', () => {
  const previous = base()
  const input = { checkpoint: 'after_tool', clock: { now: 10 },
    action: { id: 'local-1', canonicalName: 'CapybaraRetrieval__step', resourceKey: 'CapybaraRetrieval', effect: 'read' },
    outcome: { status: 'succeeded', complete: true, executed: true, resultHash: hash }, messages: [] }
  assert.deepEqual(errors({ previousValues: previous, input, variables: structuredClone(previous), artifacts: [], decision: { action: 'allow' } }), [])
})

test('v2 before_tool accepts cross-hook artifacts without requiring retired noise titles', () => {
  const item = afterReceipt()
  item.previousValues = item.variables
  item.input = { checkpoint: 'before_tool', clock: { now: 11 }, action: { id: 'call-2', canonicalName: 'Files__mv', resourceKey: 'Files', effect: 'write' }, messages: [] }
  item.variables = structuredClone(item.previousValues)
  item.artifacts = [{ title: 'GAIA2 A2A pre-action decision', value: { actionId: 'call-2', action: 'allow' } }, { title: 'GAIA2 pre-action write decision', value: { actionId: 'call-2', action: 'allow' } }]
  assert.deepEqual(errors(item), [])
})

test('v2 still rejects an erased prior observation identity', () => {
  const item = afterReceipt()
  item.previousValues = structuredClone(item.variables)
  item.variables.gaia2_observation_state.observations = []
  item.variables.gaia2_observation_state.provenance = []
  item.variables.gaia2_noise_state.decisions = []
  assert.ok(errors(item).includes('noise_observation_identity_invalid'))
})
