import test from 'node:test'
import assert from 'node:assert/strict'
import { informationNoiseTransitionErrors as errors } from '../src/phase5_information_noise_evidence.mjs'

const h = character => character.repeat(64)
const clone = value => structuredClone(value)
const query = h('a'), identity = JSON.stringify(['Calendar__read', 'Calendar', query])
function base() {
  return { gaia2_noise_state: { semanticVersion: 2, profile: 'off', seed: null, decisions: [], deduplicated: [], conflicts: [], quarantined: [], schedule_hash: '' },
    gaia2_observation_state: { observations: [], provenance: [], stale_ids: [], unverified_ids: [], conflict_ids: [] },
    gaia2_progress_state: { steps: 0, consecutive_no_progress: 0, blocked_repetitions: 0, blocked_signature: null, last_reason: null, recommendation: 'continue', seen_queries: [], seen_user_ids: [] },
    gaia2_runtime_policy: { stale_after_ms: 60000, no_progress_replan_after: 3, no_progress_stop_after: 6 },
    gaia2_write_state: { actions: [], unknown: [], blocked: [] }, gaia2_event_state: { consumed: [], pending: [] } }
}
function record(id = 'first', resultHash = h('b'), overrides = {}) {
  const value = { observationId: `obs-${id}`, actionId: id, resourceKey: 'Calendar', canonicalName: 'Calendar__read', queryHash: query,
    resultHash, fingerprint: resultHash || id, status: 'observed', outcomeStatus: 'succeeded', complete: true, viewComplete: true,
    observedAt: 10, authoritativeRead: true, provenance: { actionId: id, source: 'Calendar__read', observedAt: 10 }, ...overrides }
  value.provenance = { actionId: value.actionId, source: value.canonicalName, observedAt: value.observedAt }
  return value
}
function observations(value, rows) {
  value.gaia2_observation_state = { observations: rows, provenance: rows.map(row => row.provenance),
    stale_ids: rows.filter(row => row.status === 'stale').map(row => row.observationId),
    unverified_ids: rows.filter(row => ['incomplete', 'failed'].includes(row.status)).map(row => row.observationId),
    conflict_ids: rows.filter(row => row.status === 'conflicting').map(row => row.observationId) }
  const state = value.gaia2_observation_state
  Object.assign(value.gaia2_noise_state, { conflicts: state.conflict_ids, quarantined: [...state.unverified_ids, ...state.stale_ids, ...state.conflict_ids] })
  return value
}
function after({ previous = base(), id = 'new', hash = h('b'), action = {}, outcome = {}, rows = null, advanced = true, resolved = false, duplicateOf = null, status = null } = {}) {
  const input = { checkpoint: 'after_tool', clock: { now: 20 }, action: { id, canonicalName: 'Calendar__read', resourceKey: 'Calendar', mutationKey: query, effect: 'read', authoritativeRead: true, ...action },
    outcome: { status: 'succeeded', complete: true, resultHash: hash, ...outcome } }
  const nextRecord = record(id, input.outcome.resultHash || null, { observedAt: 20, canonicalName: input.action.canonicalName,
    resourceKey: input.action.resourceKey, queryHash: input.action.mutationKey || null,
    status: status || (input.outcome.status !== 'succeeded' ? 'failed' : input.outcome.complete !== true || input.outcome.viewComplete === false ? 'incomplete' : duplicateOf ? 'duplicate' : 'observed'),
    outcomeStatus: input.outcome.status, complete: input.outcome.complete === true, viewComplete: input.outcome.viewComplete !== false,
    authoritativeRead: input.action.effect === 'read' && input.action.authoritativeRead === true, ...(duplicateOf ? { duplicateOf } : {}) })
  const current = observations(clone(previous), rows || [...clone(previous.gaia2_observation_state.observations), nextRecord])
  current.gaia2_noise_state.decisions.push(nextRecord)
  if (duplicateOf) current.gaia2_noise_state.deduplicated.push(nextRecord.observationId)
  const oldProgress = previous.gaia2_progress_state, count = advanced ? 0 : oldProgress.consecutive_no_progress + 1
  const signature = JSON.stringify([input.action.canonicalName, input.action.resourceKey, input.action.mutationKey || null])
  const full = input.outcome.status === 'succeeded' && input.outcome.complete === true && input.outcome.viewComplete !== false
  current.gaia2_progress_state = { ...oldProgress, steps: oldProgress.steps + 1, consecutive_no_progress: count,
    blocked_repetitions: advanced ? 0 : oldProgress.blocked_repetitions, blocked_signature: advanced ? null : oldProgress.blocked_signature,
    last_reason: advanced ? resolved ? 'evidence_verified' : 'new_observable_progress' : 'repeated_or_uncertain_result',
    recommendation: count >= 6 ? 'clarify_or_safe_finish' : count >= 3 ? 'replan_with_fresh_evidence' : 'continue',
    seen_queries: full ? [...oldProgress.seen_queries.filter(row => row.identity !== signature), { identity: signature, resultHash: input.outcome.resultHash || null }].slice(-64) : oldProgress.seen_queries }
  return { previousValues: previous, input, variables: current, artifacts: [
    { title: 'GAIA2 observable evidence classification', value: nextRecord },
    { title: 'GAIA2 finite progress decision', value: { actionId: id, advanced, resolved, consecutiveNoProgress: count, recommendation: current.gaia2_progress_state.recommendation } },
  ], decision: { action: 'allow' } }
}
function refreshed({ previous = observations(base(), [record()]), now = 70, view = null, rows = null, changed = [] } = {}) {
  const current = observations(clone(previous), rows || clone(previous.gaia2_observation_state.observations))
  return { previousValues: previous, input: { checkpoint: 'before_model', clock: { now }, messages: view ? [{ role: 'tool', observation: view }] : [] },
    variables: current, artifacts: [{ title: 'GAIA2 evidence freshness refresh', value: { clockNow: now, ttlSeconds: 60, changed, recommendation: previous.gaia2_progress_state.recommendation } }], decision: { action: 'allow' } }
}
function gated({ previous = observations(base(), [record('old', h('b'), { status: 'incomplete' })]), action = {}, blockers = ['obs-old'], decision = 'read_back', repetitions = 1, count = 1, safeExit = false, currentRows = null } = {}) {
  const current = observations(clone(previous), currentRows || clone(previous.gaia2_observation_state.observations))
  const input = { checkpoint: 'before_tool', clock: { now: 20 }, messages: [], action: { id: 'write', canonicalName: 'Calendar__write', resourceKey: 'Calendar', mutationKey: h('c'), effect: 'write', ...action } }
  const signature = JSON.stringify([input.action.canonicalName, input.action.resourceKey, input.action.mutationKey || null])
  const stalled = !safeExit && (blockers.length > 0 || input.action.effect === 'unknown' || previous.gaia2_write_state.unknown.some(row => row.mutationKey === input.action.mutationKey || row.resourceKey === input.action.resourceKey))
  const progress = previous.gaia2_progress_state
  current.gaia2_progress_state = { ...progress, consecutive_no_progress: count, blocked_repetitions: repetitions,
    blocked_signature: stalled ? signature : progress.blocked_signature, last_reason: stalled ? 'repeated_blocked_action' : progress.last_reason,
    recommendation: count >= 6 ? 'clarify_or_safe_finish' : count >= 3 ? 'replan_with_fresh_evidence' : progress.recommendation }
  return { previousValues: previous, input, variables: current, decision: { action: decision }, artifacts: [
    { title: 'GAIA2 conflict decision', value: { actionId: 'write', blockers, action: decision } },
    { title: 'GAIA2 repeated-action gate', value: { actionId: 'write', safeExit, consecutiveNoProgress: count, blockedRepetitions: repetitions, recommendation: current.gaia2_progress_state.recommendation, decision } },
  ] }
}
const good = value => assert.deepEqual(errors(value), [])
const bad = (value, code) => assert.ok(errors(value).includes(code), JSON.stringify(errors(value)))

test('absent/v1 contracts preserve historical evidence; unknown versions do not', () => {
  good({ variables: { gaia2_noise_state: {} } })
  good({ variables: { gaia2_noise_state: { semanticVersion: 1 } } })
  bad({ variables: { gaia2_noise_state: { semanticVersion: 3 } } }, 'noise_contract_version_invalid')
  bad({ previousValues: base(), variables: { gaia2_noise_state: { semanticVersion: 1 } } }, 'noise_contract_version_invalid')
  bad({ previousValues: base(), variables: { gaia2_noise_state: {} } }, 'noise_contract_version_invalid')
})
test('complete native after_tool binds source/resource/query/hash/clock and artifacts', () => good(after()))
test('default metadata and failed null hash do not invent noise or reject legacy action IDs', () => {
  const incomplete = after({ id: 'native call: legacy/id', outcome: { complete: undefined }, advanced: false }); delete incomplete.input.outcome.complete; good(incomplete)
  assert.equal(incomplete.variables.gaia2_observation_state.observations.at(-1).complete, false)
  assert.equal(incomplete.variables.gaia2_observation_state.observations.at(-1).status, 'incomplete')
  good(after({ id: 'legacy-failed', hash: null, outcome: { status: 'failed', complete: false }, advanced: false }))
})
test('rebound outcome hash cannot bless a stale record or forged classification artifact', () => {
  const value = after(); value.input.outcome.resultHash = h('c'); bad(value, 'noise_transition_mismatch')
  const artifact = after(); artifact.artifacts[0].value = { ...artifact.artifacts[0].value, observedAt: 19 }; bad(artifact, 'noise_artifact_mismatch')
})
test('source/resource/query/action/clock provenance changes are not interchangeable', () => {
  for (const [key, value] of [['actionId', 'other'], ['canonicalName', 'Messages__read'], ['resourceKey', 'Messages'], ['queryHash', h('d')], ['observedAt', 19]]) {
    const item = after(); item.variables.gaia2_observation_state.observations[0] = { ...item.variables.gaia2_observation_state.observations[0], [key]: value }
    bad(item, 'noise_transition_mismatch')
  }
})
test('status lists and quarantine must exactly follow records, not renamed bool flags', () => {
  const item = after(); item.variables.gaia2_observation_state.unverified_ids = ['obs-new']; bad(item, 'noise_observation_index_mismatch')
  const quarantine = after(); quarantine.variables.gaia2_noise_state.quarantined = ['obs-new']; bad(quarantine, 'noise_observation_index_mismatch')
})
test('same-content duplicate is a new fresh observation with a real prior hash reference', () => {
  const old = record(), previous = observations(base(), [old])
  const item = after({ previous, duplicateOf: old.observationId, rows: [{ ...old, status: 'superseded_by_fresh_read', verifiedBy: 'new', verifiedAt: 20 }, record('new', h('b'), { observedAt: 20, status: 'duplicate', duplicateOf: old.observationId })] })
  good(item)
  const forged = clone(item); forged.variables.gaia2_observation_state.observations[1].duplicateOf = 'missing'; bad(forged, 'noise_duplicate_reference_invalid')
  const cross = clone(item); cross.variables.gaia2_observation_state.observations[0].resourceKey = 'Messages'; bad(cross, 'noise_duplicate_reference_invalid')
})
test('same-query full authoritative read verifies failed evidence without relying on its null hash', () => {
  const old = record('failed', null, { status: 'failed', outcomeStatus: 'failed', complete: false })
  const previous = observations(base(), [old])
  good(after({ previous, resolved: true, rows: [{ ...old, status: 'verified_by_fresh_read', verifiedBy: 'new', verifiedAt: 20 }, record('new', h('b'), { observedAt: 20 })] }))
})
test('unrelated App/query and nonauthoritative/partial/failed reads cannot clear uncertainty', () => {
  const old = record('bad', h('b'), { status: 'stale', staleAt: 15 }), previous = observations(base(), [old])
  for (const edit of [item => { item.input.action.resourceKey = 'Messages' }, item => { item.input.action.mutationKey = h('d') },
    item => { item.input.action.authoritativeRead = false }, item => { item.input.outcome.complete = false }, item => { item.input.outcome.status = 'failed' },
    item => { item.input.outcome.viewComplete = false }]) {
    const item = after({ previous, resolved: true, duplicateOf: old.observationId, rows: [{ ...old, status: 'verified_by_fresh_read', verifiedBy: 'new', verifiedAt: 20 }, record('new', h('b'), { observedAt: 20, status: 'duplicate', duplicateOf: old.observationId })] })
    edit(item); bad(item, 'noise_transition_mismatch')
  }
})
test('changed authoritative content is conflicting until a later exact-query confirming read', () => {
  const old = record(), previous = observations(base(), [old])
  const newConflict = record('new', h('c'), { observedAt: 20, status: 'conflicting', conflictsWith: [old.observationId] })
  const changed = after({ previous, hash: h('c'), status: 'conflicting', rows: [{ ...old, status: 'conflicting', conflictsWith: ['obs-new'] }, newConflict] })
  changed.artifacts[0].value = newConflict; changed.variables.gaia2_noise_state.decisions = [newConflict]; good(changed)
  const reset = clone(changed); observations(reset.variables, [{ ...old, status: 'verified_by_fresh_read', verifiedBy: 'new', verifiedAt: 20 }, record('new', h('c'), { observedAt: 20 })]); bad(reset, 'noise_transition_mismatch')
  const confirmedOld = changed.variables.gaia2_observation_state.observations
  const rows = confirmedOld.map(row => ({ ...row, status: 'verified_by_fresh_read', verifiedBy: 'confirm', verifiedAt: 20 }))
  rows.push(record('confirm', h('c'), { observedAt: 20, status: 'duplicate', duplicateOf: 'obs-new' }))
  good(after({ previous: changed.variables, id: 'confirm', hash: h('c'), duplicateOf: 'obs-new', resolved: true, rows }))
})
test('TTL uses ARE seconds: equality is fresh and a fractional second beyond expires', () => {
  good(refreshed())
  const old = record(), expired = { ...old, status: 'stale', staleAt: 70.001 }
  good(refreshed({ now: 70.001, rows: [expired], changed: [{ observationId: old.observationId, previousStatus: 'observed', status: 'stale' }] }))
  bad(refreshed({ now: 71 }), 'noise_freshness_transition_invalid')
})
test('TTL expiry of duplicates is not suppressed by matching content', () => {
  const rows = [record(), record('duplicate', h('b'), { status: 'duplicate', duplicateOf: 'obs-first', observedAt: 12 })]
  const previous = observations(base(), rows)
  const expired = rows.map(row => ({ ...row, status: 'stale', staleAt: 73 }))
  good(refreshed({ previous, now: 73, rows: expired, changed: rows.map(row => ({ observationId: row.observationId, previousStatus: row.status, status: 'stale' })) }))
})
test('trusted provider hidden/truncated metadata must be consumed and identity-bound', () => {
  const old = record(), view = { actionId: old.actionId, resourceKey: old.resourceKey, canonicalName: old.canonicalName, queryHash: old.queryHash, resultHash: old.resultHash, observedAt: old.observedAt, complete: true, viewComplete: false, viewIncompleteReason: 'truncated' }
  good(refreshed({ view, rows: [{ ...old, status: 'incomplete', viewComplete: false, viewIncompleteReason: 'truncated' }], changed: [{ observationId: old.observationId, previousStatus: 'observed', status: 'incomplete' }] }))
  bad(refreshed({ view }), 'noise_freshness_transition_invalid')
  const wrong = { ...view, resultHash: h('c') }; bad(refreshed({ view: wrong }), 'noise_view_binding_invalid')
})
test('conflicting duplicate provider annotations fail rather than choose a convenient one', () => {
  const item = refreshed(), old = record(), view = { actionId: old.actionId, resourceKey: old.resourceKey, canonicalName: old.canonicalName, queryHash: old.queryHash, resultHash: old.resultHash, observedAt: old.observedAt, viewComplete: true }
  item.input.messages = [{ role: 'tool', observation: view }, { role: 'tool', observation: { ...view, viewComplete: false } }]
  bad(item, 'noise_view_conflict')
})
test('terminal old observations stay verified despite old hidden messages or elapsed TTL', () => {
  const old = record('old', h('b'), { status: 'verified_by_fresh_read', verifiedBy: 'new', verifiedAt: 20 })
  const newer = record('new', h('b'), { observedAt: 100 })
  good(refreshed({ previous: observations(base(), [old, newer]), now: 100, view: { actionId: 'old', viewComplete: false } }))
})
test('dependent risky writes cannot allow stale/incomplete/conflicting evidence', () => {
  good(gated())
  for (const status of ['stale', 'incomplete', 'failed', 'conflicting']) {
    const previous = observations(base(), [record('old', status === 'failed' ? null : h('b'), { status })])
    const item = gated({ previous }); item.decision.action = 'allow'; bad(item, 'noise_risky_decision_weakened')
  }
})
test('dependency resources and missing scopes are conservative; independent resources are allowed', () => {
  good(gated({ action: { resourceKey: 'Messages', resourceDependencies: ['Calendar'] } }))
  good(gated({ action: { resourceKey: '' } }))
  good(gated({ action: { resourceKey: 'Messages' }, blockers: [], decision: 'allow', count: 0, repetitions: 0 }))
})
test('before_tool TTL is consumed before the write decision, not only before_model', () => {
  const old = record('old'), previous = observations(base(), [old])
  const item = gated({ previous, currentRows: [{ ...old, status: 'stale', staleAt: 71 }] }); item.input.clock.now = 71; good(item)
  const skipped = gated({ previous, blockers: [], decision: 'allow', count: 0, repetitions: 0 }); skipped.input.clock.now = 71; bad(skipped, 'noise_freshness_transition_invalid')
})
test('unknown write remains unresolved after successful same-query read-back', () => {
  const previous = base(); previous.gaia2_write_state.unknown = [{ actionId: 'write', mutationKey: h('c'), resourceKey: 'Calendar', status: 'unknown', resultHash: null, readBackObserved: false }]
  const item = after({ previous }); item.variables.gaia2_write_state.unknown[0] = { ...item.variables.gaia2_write_state.unknown[0], readBackObserved: true, readBackActionId: 'new', readBackHash: h('b') }; good(item)
  const erased = clone(item); erased.variables.gaia2_write_state.unknown = []; bad(erased, 'noise_unknown_write_erased')
  const whitewashed = clone(item); whitewashed.variables.gaia2_write_state.unknown[0].status = 'succeeded'; bad(whitewashed, 'noise_unknown_write_erased')
})
test('unknown writes and unclassified effects never gain permission from an empty noise list', () => {
  const previous = base(); previous.gaia2_write_state.unknown = [{ actionId: 'old-write', mutationKey: h('c'), resourceKey: 'Calendar', status: 'unknown' }]
  const write = gated({ previous, blockers: [], decision: 'allow' }); bad(write, 'noise_unknown_write_replayed')
  const unknown = gated({ previous: base(), action: { effect: 'unknown' }, blockers: [], decision: 'allow' }); bad(unknown, 'noise_unknown_effect_allowed')
})
test('no-progress counters cross exactly 3 for replanning and 6 for safe-finish recommendation', () => {
  for (const before of [1, 2, 4, 5]) {
    const previous = base(); previous.gaia2_progress_state.consecutive_no_progress = before
    const item = after({ previous, outcome: { status: 'failed', complete: false }, hash: null, advanced: false }); good(item)
    const wrong = clone(item); wrong.variables.gaia2_progress_state.recommendation = 'continue'; if (before >= 2) bad(wrong, 'noise_progress_transition_invalid')
  }
})
test('third same blocked action requires block and does not assert scenario completion', () => {
  const previous = observations(base(), [record('old', h('b'), { status: 'incomplete' })])
  previous.gaia2_progress_state.consecutive_no_progress = 2; previous.gaia2_progress_state.blocked_repetitions = 2
  previous.gaia2_progress_state.blocked_signature = JSON.stringify(['Calendar__write', 'Calendar', h('c')])
  good(gated({ previous, decision: 'block', repetitions: 3, count: 3 }))
  const weak = gated({ previous, decision: 'block', repetitions: 3, count: 3 }); weak.decision.action = 'read_back'; bad(weak, 'noise_no_progress_gate_weakened')
})
test('fresh authoritative reads, wait and finish stay safe exits when progress is stalled', () => {
  const previous = observations(base(), [record('old', h('b'), { status: 'incomplete' })])
  previous.gaia2_progress_state.consecutive_no_progress = 6; previous.gaia2_progress_state.blocked_repetitions = 6; previous.gaia2_progress_state.recommendation = 'clarify_or_safe_finish'
  for (const action of [{ effect: 'read', authoritativeRead: true }, { effect: 'wait' }, { effect: 'finish' }]) good(gated({ previous, action, safeExit: true, decision: 'allow', count: 6, repetitions: 6 }))
})
test('only a new official USER_MESSAGE resets stalled progress', () => {
  const previous = base(); previous.gaia2_progress_state.consecutive_no_progress = 4; previous.gaia2_progress_state.recommendation = 'replan_with_fresh_evidence'
  const item = refreshed({ previous, now: 10 }); item.input.messages = [{ role: 'user', id: 'user-new', notificationType: 'USER_MESSAGE', content: 'changed request' }]
  item.variables.gaia2_progress_state = { ...previous.gaia2_progress_state, consecutive_no_progress: 0, blocked_repetitions: 0, blocked_signature: null, last_reason: 'new_official_user_notification', recommendation: 'continue', seen_user_ids: ['user-new'] }; good(item)
  const fake = clone(item); fake.input.messages[0].notificationType = 'ENV_MESSAGE'; bad(fake, 'noise_progress_transition_invalid')
})
test('no mutation of parsed inputs and malformed inputs return fixed codes', () => {
  const item = after(), before = clone(item); good(item); assert.deepEqual(item, before)
  bad({ variables: { gaia2_noise_state: { semanticVersion: 2 } } }, 'noise_state_invalid')
})

function bindSourceView(item, metadata) {
  const row = item.variables.gaia2_observation_state.observations.find(row => row.actionId === item.input.action.id)
  const view = { actionId: row.actionId, resourceKey: row.resourceKey, canonicalName: row.canonicalName,
    queryHash: row.queryHash, resultHash: row.resultHash, complete: row.complete, observedAt: row.observedAt, viewComplete: true, ...metadata }
  item.input.messages = [{ role: 'tool', toolCallId: row.actionId, observation: view }]
  row.observedAt = view.observedAt; row.provenance.observedAt = view.observedAt
  row.viewComplete = view.viewComplete
  if (!view.viewComplete) row.viewIncompleteReason = view.viewIncompleteReason
  return item
}
test('native collection time precedes after_tool IPC without corrupting exact provenance', () => {
  const item = bindSourceView(after(), { observedAt: 19.987 }); good(item)
  const rewritten = clone(item); rewritten.variables.gaia2_observation_state.observations[0].observedAt = 20
  rewritten.variables.gaia2_observation_state.observations[0].provenance.observedAt = 20
  bad(rewritten, 'noise_transition_mismatch')
})
test('future or identity-mismatched native return metadata cannot supply trusted time', () => {
  for (const metadata of [{ observedAt: 21 }, { observedAt: -1 }, { complete: false }, { queryHash: h('d') }, { canonicalName: 'Messages__read' }]) {
    const item = bindSourceView(after(), metadata); bad(item, 'noise_outcome_binding_mismatch')
  }
})
test('after_tool provider-view truncation is incomplete and makes no observable progress', () => {
  const item = bindSourceView(after({ outcome: { viewComplete: false }, advanced: false }), { observedAt: 19.9, viewComplete: false, viewIncompleteReason: 'truncated' }); good(item)
  const invented = clone(item); invented.variables.gaia2_observation_state.observations[0].status = 'observed'; bad(invented, 'noise_transition_mismatch')
})
test('after_tool rejects contradictory same-action source metadata rather than choosing one', () => {
  const item = bindSourceView(after(), { observedAt: 19.99 })
  item.input.messages.push({ role: 'tool', observation: { ...item.input.messages[0].observation, observedAt: 19.98 } }); bad(item, 'noise_view_conflict')
})
test('refresh retains identity-bound completeness and repeated incomplete annotations', () => {
  const row = record('partial-view', h('b'), { status: 'incomplete', viewComplete: false, viewIncompleteReason: 'hidden' })
  const view = { actionId: row.actionId, resourceKey: row.resourceKey, canonicalName: row.canonicalName, queryHash: row.queryHash,
    resultHash: row.resultHash, observedAt: row.observedAt, complete: true, viewComplete: false, viewIncompleteReason: 'hidden' }
  good(refreshed({ previous: observations(base(), [row]), view, changed: [{ observationId: row.observationId, previousStatus: 'incomplete', status: 'incomplete' }] }))
  bad(refreshed({ previous: observations(base(), [row]), view: { ...view, complete: false } }), 'noise_view_binding_invalid')
})
test('mixed uncertainty blockers keep contract ordering independently of observation chronology', () => {
  const rows = [record('stale', h('b'), { status: 'stale' }), record('conflict', h('c'), { status: 'conflicting' }), record('incomplete', h('d'), { status: 'incomplete' })]
  good(gated({ previous: observations(base(), rows), blockers: ['obs-incomplete', 'obs-stale', 'obs-conflict'] }))
})
test('no-progress recommendation consumes explicit configured thresholds', () => {
  const previous = base(); previous.gaia2_runtime_policy.no_progress_replan_after = 5; previous.gaia2_runtime_policy.no_progress_stop_after = 8
  previous.gaia2_progress_state.consecutive_no_progress = 3
  const item = after({ previous, hash: null, outcome: { status: 'failed', complete: false }, advanced: false })
  item.variables.gaia2_progress_state.recommendation = 'continue'; item.artifacts[1].value.recommendation = 'continue'; good(item)
  previous.gaia2_progress_state.consecutive_no_progress = 7
  const stop = after({ previous, hash: null, outcome: { status: 'failed', complete: false }, advanced: false }); good(stop)
})
test('complete deterministic error payload stays complete but quarantined by its failed outcome', () => {
  const item = bindSourceView(after({ outcome: { status: 'failed_before_execution', complete: true }, advanced: false }), { observedAt: 19.998, complete: true }); good(item)
  assert.equal(item.variables.gaia2_observation_state.observations[0].complete, true)
  assert.deepEqual(item.variables.gaia2_observation_state.unverified_ids, ['obs-new'])
  const wrong = clone(item); wrong.variables.gaia2_observation_state.observations[0].status = 'observed'; bad(wrong, 'noise_transition_mismatch')
})
test('noise verifier rejects erased progress receipts even if the variable hashes are rebound', () => {
  const item = after(); item.artifacts = [{ title: 'GAIA2 observable evidence classification', value: item.artifacts[0].value }]
  bad(item, 'noise_artifact_mismatch')
})
