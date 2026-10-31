// Independent semantic verification of parsed, source-bound Hook receipts.
// No filesystem/network access and no execution of the captured Hook source.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const list = value => Array.isArray(value) ? value : []
const text = value => typeof value === 'string' && value.length > 0
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const terminal = item => ['verified_by_fresh_read', 'superseded_by_fresh_read'].includes(item.status)
const uncertain = item => ['failed', 'incomplete', 'stale', 'conflicting'].includes(item.status)
const statuses = new Set(['observed', 'duplicate', 'failed', 'incomplete', 'stale', 'conflicting', 'verified_by_fresh_read', 'superseded_by_fresh_read'])
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
const values = value => value?.builtin?.variables ?? value
const copy = value => structuredClone(value)
const thresholds = policy => ({ replan: Number(policy?.no_progress_replan_after || 3), stop: Number(policy?.no_progress_stop_after || 6) })
const recommendation = (count, policy, fallback = 'continue') => {
  const { replan, stop } = thresholds(policy)
  return count >= stop ? 'clarify_or_safe_finish' : count >= replan ? 'replan_with_fresh_evidence' : fallback
}
const indexes = observations => ({
  observations,
  provenance: observations.map(item => item.provenance),
  stale_ids: observations.filter(item => item.status === 'stale').map(item => item.observationId),
  unverified_ids: observations.filter(item => ['incomplete', 'failed'].includes(item.status)).map(item => item.observationId),
  conflict_ids: observations.filter(item => item.status === 'conflicting').map(item => item.observationId),
})
const summaries = state => ({ conflicts: state.conflict_ids, quarantined: [...state.unverified_ids, ...state.stale_ids, ...state.conflict_ids] })
const sameQuery = (item, action) => text(action.mutationKey) && item.queryHash === action.mutationKey
  && item.canonicalName === action.canonicalName && item.resourceKey === action.resourceKey
// Local runtime controls have their own lifecycle receipts and intentionally
// do not create native-observation classifications. Keep the noise ledger
// unchanged for these controls instead of requiring a classifier artifact.
const CONTROL_ACTIONS = new Set(['CapybaraEvidence__read', 'CapybaraRetrieval__step', 'CapybaraTemporal__watch', 'CapybaraTaskContract__commit', 'CapybaraTaskContract__review'])

// The production noise hook is state-v2.  Its before_model/before_tool
// checkpoints are observation/safety checkpoints owned by other hooks; the
// noise hook itself records a classification only after a native result.  The
// verifier must therefore authenticate the v2 state transition and the
// artifacts that actually belong to the checkpoint, rather than requiring
// every checkpoint to emit the legacy v1 noise titles.
const v2Statuses = new Set([...statuses, 'verified_absent_after_delete', 'confirmed_mutation'])
const v2Terminal = item => ['verified_by_fresh_read', 'superseded_by_fresh_read', 'verified_absent_after_delete', 'confirmed_mutation'].includes(item?.status)
const v2Index = observations => ({
  provenance: observations.map(item => item.provenance),
  stale_ids: observations.filter(item => item.status === 'stale').map(item => item.observationId),
  unverified_ids: observations.filter(item => ['incomplete', 'failed'].includes(item.status)).map(item => item.observationId),
  conflict_ids: observations.filter(item => item.status === 'conflicting').map(item => item.observationId),
  visibility_ids: observations.filter(item => !v2Terminal(item) && item.viewComplete === false && item.presentation !== 'retrieval_filtered').map(item => item.observationId),
})
const v2Summary = observation => ({ conflicts: observation.conflict_ids, quarantined: [...observation.unverified_ids, ...observation.stale_ids, ...observation.conflict_ids] })

function v2TransitionErrors({ previousValues, input, variables, artifacts, decision } = {}) {
  const previous = values(previousValues), current = values(variables), errors = [], fail = code => { if (!errors.includes(code)) errors.push(code) }
  const previousObservation = previous?.gaia2_observation_state, observation = current?.gaia2_observation_state
  const noise = current?.gaia2_noise_state, previousNoise = previous?.gaia2_noise_state
  const progress = current?.gaia2_progress_state, previousProgress = previous?.gaia2_progress_state
  if (!object(previous) || !object(current) || !object(input) || !object(observation) || observation.schemaVersion !== 'gaia2-observation-state-v2'
      || !object(previousObservation) || previousObservation.schemaVersion !== 'gaia2-observation-state-v2'
      || !Array.isArray(observation.observations) || !Array.isArray(previousObservation.observations)
      || !object(noise) || noise.semanticVersion !== 2 || !Array.isArray(noise.decisions)
      || !object(progress) || !object(previousProgress) || !Array.isArray(artifacts)) return ['noise_state_invalid']
  const rows = observation.observations, priorRows = previousObservation.observations, byId = new Map()
  for (const item of rows) {
    if (!object(item) || !text(item.observationId) || !text(item.actionId) || item.observationId !== `obs-${item.actionId}`
      || !v2Statuses.has(item.status) || !text(item.canonicalName) || !text(item.resourceKey)
      || (item.queryHash !== null && !text(item.queryHash)) || (item.resultHash !== null && !text(item.resultHash))
      || !text(item.outcomeStatus) || typeof item.complete !== 'boolean' || typeof item.viewComplete !== 'boolean'
      || typeof item.authoritativeRead !== 'boolean' || !finite(item.observedAt) || !object(item.provenance)
      || item.provenance.actionId !== item.actionId || item.provenance.source !== item.canonicalName
      || item.provenance.observedAt !== item.observedAt || byId.has(item.observationId)) { fail('noise_observation_identity_invalid'); continue }
    if (item.observedAt > Number(input.clock?.now)) fail('noise_clock_invalid')
    if (item.presentation !== undefined && !text(item.presentation)) fail('noise_presentation_invalid')
    if (item.freshness !== undefined && !text(item.freshness)) fail('noise_freshness_invalid')
    byId.set(item.observationId, item)
  }
  const derived = v2Index(rows)
  for (const key of ['provenance', 'stale_ids', 'unverified_ids', 'conflict_ids', 'visibility_ids']) if (!same(observation[key], derived[key])) fail('noise_observation_index_mismatch')
  for (const key of ['conflicts', 'quarantined']) if (!same(noise[key], v2Summary(derived)[key])) fail('noise_observation_index_mismatch')
  for (const prior of priorRows) {
    const next = byId.get(prior.observationId)
    if (!next || !['actionId', 'resourceKey', 'canonicalName', 'queryHash', 'resultHash', 'outcomeStatus', 'complete', 'authoritativeRead'].every(key => same(next[key], prior[key]))) fail('noise_observation_identity_invalid')
  }
  const unknown = list(previous.gaia2_write_state?.unknown)
  for (const prior of unknown) {
    const next = list(current.gaia2_write_state?.unknown).find(item => item.actionId === prior.actionId)
    const keys = Object.keys(prior).filter(key => !['readBackObserved', 'readBackActionId', 'readBackHash'].includes(key))
    if (!next || keys.some(key => !same(next[key], prior[key]))) fail('noise_unknown_write_erased')
  }
  for (const item of noise.decisions) {
    if (!object(item) || !text(item.actionId) || !text(item.observationId) || item.observationId !== `obs-${item.actionId}`) fail('noise_decision_identity_invalid')
  }
  const checkpoint = input.checkpoint
  if (!['after_tool', 'before_model', 'before_tool', 'attempt_end'].includes(checkpoint)) return [...errors, 'noise_checkpoint_invalid']
  if (checkpoint === 'attempt_end') {
    if (!same(observation, previousObservation) || !same(noise, previousNoise) || !same(progress, previousProgress)) fail('noise_transition_mismatch')
    return errors
  }
  if (!finite(input.clock?.now)) return [...errors, 'noise_clock_invalid']
  if (checkpoint === 'after_tool') {
    const action = input.action, outcome = input.outcome
    if (!object(action) || !text(action.id) || !text(action.canonicalName) || !object(outcome) || !text(outcome.status)) return [...errors, 'noise_outcome_binding_mismatch']
    if (CONTROL_ACTIONS.has(action.canonicalName)) {
      if (!same(current.gaia2_observation_state, previous.gaia2_observation_state)
        || !same(current.gaia2_noise_state, previous.gaia2_noise_state)
        || !same(current.gaia2_progress_state, previous.gaia2_progress_state)) fail('noise_control_transition_mismatch')
      return errors
    }
    const source = list(input.messages).filter(message => message?.role === 'tool' && object(message.observation) && message.observation.actionId === action.id).map(message => message.observation)
    if (source.length > 1 && source.some(view => !same(view, source[0]))) fail('noise_view_conflict')
    const view = source[0], observedAt = view ? view.observedAt : input.clock.now
    if (!finite(observedAt) || observedAt > input.clock.now) fail('noise_clock_invalid')
    if (view && (view.resourceKey !== action.resourceKey || view.canonicalName !== action.canonicalName || view.queryHash !== (text(action.mutationKey) ? action.mutationKey : null)
      || view.resultHash !== (outcome.resultHash ?? null) || view.complete !== (outcome.complete === true) || typeof view.viewComplete !== 'boolean')) fail('noise_outcome_binding_mismatch')
    const row = [...rows].reverse().find(item => item.actionId === action.id)
    if (!row || row.resourceKey !== action.resourceKey || row.canonicalName !== action.canonicalName || row.queryHash !== (text(action.mutationKey) ? action.mutationKey : null)
      || row.resultHash !== (outcome.resultHash ?? null) || row.outcomeStatus !== outcome.status || row.complete !== (outcome.complete === true)
      || row.viewComplete !== (view ? view.viewComplete : outcome.viewComplete !== false) || row.observedAt !== observedAt) fail('noise_outcome_binding_mismatch')
    const classification = artifacts.filter(item => item?.title === 'GAIA2 observable evidence classification')
    if (classification.length !== 1 || !same(classification[0].value, row)) fail('noise_artifact_mismatch')
    const progressArtifact = artifacts.filter(item => item?.title === 'GAIA2 finite progress decision')
    if (progressArtifact.length !== 1 || progressArtifact[0].value?.actionId !== action.id
      || progressArtifact[0].value?.consecutiveNoProgress !== progress.consecutive_no_progress
      || progressArtifact[0].value?.recommendation !== progress.recommendation) fail('noise_artifact_mismatch')
  } else {
    // Other runtime hooks may refresh visibility/freshness or reconcile an
    // event at these checkpoints.  The v2 verifier has already checked that
    // prior observation identities/outcomes cannot be erased and that all
    // derived indexes are exact; do not require the noise hook to own those
    // cross-hook state updates.
    if (checkpoint === 'before_tool') {
      const action = input.action
      if (!object(action) || !text(action.id) || !text(action.canonicalName)) return [...errors, 'noise_action_invalid']
      // v2 noise state is advisory.  Write safety, unknown-write recovery and
      // A2A/finish barriers are independently owned by their dedicated hooks
      // and receipts; this verifier must not re-impose the retired v1 policy
      // and reject a valid cross-hook decision merely because an observation
      // is stale or incomplete.
    }
  }
  return errors
}

function afterTool(previous, input, fail) {
  const { action, outcome, clock } = input, existing = previous.gaia2_observation_state.observations
  const queryHash = text(action.mutationKey) ? action.mutationKey : null
  const group = existing.filter(item => sameQuery(item, action))
  // A native complete result remains a content reference when its provider
  // view was shortened. Failed/partial results are not confirmation hashes.
  const prior = [...group].reverse().find(item => item.authoritativeRead === true && item.outcomeStatus === 'succeeded' && item.complete === true)
  const sourceViews = list(input.messages).filter(message => message?.role === 'tool' && object(message.observation) && message.observation.actionId === action.id).map(message => message.observation)
  const sourceView = sourceViews[0]
  if (sourceViews.some(view => !same(view, sourceView))) fail('noise_view_conflict')
  if (sourceView && (sourceView.resourceKey !== action.resourceKey || sourceView.canonicalName !== action.canonicalName
    || sourceView.queryHash !== queryHash || sourceView.resultHash !== outcome.resultHash || sourceView.complete !== (outcome.complete === true)
    || typeof sourceView.viewComplete !== 'boolean' || !finite(sourceView.observedAt) || sourceView.observedAt > clock.now)) fail('noise_outcome_binding_mismatch')
  const observedAt = sourceView ? sourceView.observedAt : clock.now
  const viewComplete = sourceView ? sourceView.viewComplete : outcome.viewComplete !== false
  const full = outcome.status === 'succeeded' && outcome.complete === true && viewComplete
  const fresh = action.effect === 'read' && action.authoritativeRead === true && full && queryHash !== null
  const duplicateOf = full && group.find(item => item.outcomeStatus === 'succeeded' && item.complete === true && item.resultHash === outcome.resultHash)
  const duplicateAction = existing.some(item => item.actionId === action.id)
  let observations = copy(existing), resolved = false
  let status = outcome.status !== 'succeeded' ? 'failed' : !full ? 'incomplete' : duplicateOf ? 'duplicate' : 'observed'
  if (fresh && !duplicateAction) {
    if (prior && prior.resultHash !== outcome.resultHash) {
      status = 'conflicting'
      observations = observations.map(item => sameQuery(item, action) && !terminal(item) && item.outcomeStatus === 'succeeded' && item.complete === true
        ? { ...item, status: 'conflicting', conflictsWith: [...new Set([...list(item.conflictsWith), `obs-${action.id}`])] } : item)
    } else {
      resolved = group.some(item => !terminal(item) && uncertain(item))
      observations = observations.map(item => sameQuery(item, action) && !terminal(item)
        ? { ...item, status: uncertain(item) ? 'verified_by_fresh_read' : 'superseded_by_fresh_read', verifiedBy: action.id, verifiedAt: clock.now } : item)
    }
  }
  const record = { observationId: `obs-${action.id}`, actionId: action.id, resourceKey: action.resourceKey,
    canonicalName: action.canonicalName, queryHash, resultHash: outcome.resultHash || null,
    fingerprint: outcome.resultHash || action.id, status, outcomeStatus: outcome.status,
    complete: outcome.complete === true, viewComplete,
    observedAt, authoritativeRead: action.authoritativeRead === true && action.effect === 'read',
    provenance: { actionId: action.id, source: action.canonicalName, observedAt },
    ...(sourceView && !viewComplete ? { viewIncompleteReason: sourceView.viewIncompleteReason } : {}),
    ...(duplicateOf ? { duplicateOf: duplicateOf.observationId } : {}),
    ...(status === 'conflicting' ? { conflictsWith: group.filter(item => !terminal(item) && item.resultHash !== outcome.resultHash).map(item => item.observationId) } : {}) }
  if (!duplicateAction) observations.push(record)
  const observation = indexes(observations), progress = previous.gaia2_progress_state
  const identity = JSON.stringify([action.canonicalName, action.resourceKey, queryHash])
  const seen = list(progress.seen_queries).find(item => item.identity === identity)
  const advanced = full && (resolved || ['write', 'wait', 'finish'].includes(action.effect) || !seen || seen.resultHash !== outcome.resultHash)
  const count = advanced ? 0 : Number(progress.consecutive_no_progress || 0) + 1
  const nextProgress = { ...progress, steps: Number(progress.steps || 0) + 1, consecutive_no_progress: count,
    blocked_repetitions: advanced ? 0 : progress.blocked_repetitions,
    blocked_signature: advanced ? null : progress.blocked_signature,
    last_reason: advanced ? resolved ? 'evidence_verified' : 'new_observable_progress' : 'repeated_or_uncertain_result',
    recommendation: recommendation(count, previous.gaia2_runtime_policy),
    seen_queries: full ? [...list(progress.seen_queries).filter(item => item.identity !== identity), { identity, resultHash: outcome.resultHash || null }].slice(-64) : progress.seen_queries || [] }
  return { observation, noise: { ...previous.gaia2_noise_state, decisions: [...list(previous.gaia2_noise_state.decisions), record],
    deduplicated: [...list(previous.gaia2_noise_state.deduplicated), ...(duplicateOf ? [record.observationId] : [])], ...summaries(observation) },
    progress: nextProgress, artifacts: [
      ['GAIA2 observable evidence classification', record],
      ['GAIA2 finite progress decision', { actionId: action.id, advanced, resolved, consecutiveNoProgress: count, recommendation: nextProgress.recommendation }],
    ] }
}

function refresh(previous, input, fail) {
  const views = new Map(), ttl = Number(previous.gaia2_runtime_policy.stale_after_ms) / 1000
  for (const message of list(input.messages)) {
    if (message?.role !== 'tool' || !object(message.observation) || !text(message.observation.actionId)) continue
    const view = message.observation, prior = views.get(view.actionId)
    if (prior && !same(prior, view)) fail('noise_view_conflict')
    views.set(view.actionId, view)
  }
  const changed = [], observations = previous.gaia2_observation_state.observations.map(item => {
    if (terminal(item)) return copy(item)
    const view = views.get(item.actionId)
    if (view && !['resourceKey', 'canonicalName', 'queryHash', 'resultHash', 'observedAt', 'complete'].every(key => view[key] === item[key])) fail('noise_view_binding_invalid')
    let next = copy(item), annotated = false
    if (view?.viewComplete === false && !['failed', 'conflicting'].includes(item.status)) { next = { ...next, status: 'incomplete', viewComplete: false, viewIncompleteReason: view.viewIncompleteReason || 'hidden' }; annotated = true }
    if (Number.isFinite(ttl) && ttl >= 0 && finite(item.observedAt) && input.clock.now - item.observedAt > ttl && ['observed', 'duplicate'].includes(next.status)) { next = { ...next, status: 'stale', staleAt: input.clock.now }; annotated = true }
    if (annotated) changed.push({ observationId: item.observationId, previousStatus: item.status, status: next.status })
    return next
  })
  const observation = { ...previous.gaia2_observation_state, ...indexes(observations) }
  return { observation, noise: { ...previous.gaia2_noise_state, ...summaries(observation) }, ttl, changed }
}

function beforeTool(previous, input, refreshed) {
  const { action } = input, observations = refreshed.observation.observations
  const dependencies = list(action.resourceDependencies).filter(text)
  const related = item => !text(item?.resourceKey) || !text(action.resourceKey)
    || item.resourceKey === action.resourceKey || dependencies.includes(item.resourceKey)
  const byId = new Map(observations.map(item => [item.observationId, item]))
  const blockers = [...new Set([...refreshed.observation.unverified_ids, ...refreshed.observation.stale_ids, ...refreshed.observation.conflict_ids])].filter(id => related(byId.get(id)))
  const risky = ['write', 'unknown'].includes(action.effect)
  const safeExit = ['wait', 'finish'].includes(action.effect) || action.effect === 'read' && action.authoritativeRead === true
  let hookDecision = risky && blockers.length ? 'read_back' : 'allow'
  const progress = previous.gaia2_progress_state, signature = JSON.stringify([action.canonicalName, action.resourceKey, action.mutationKey || null])
  const unknownWrite = list(previous.gaia2_write_state?.unknown).some(item => item.mutationKey === action.mutationKey || item.resourceKey === action.resourceKey)
  const stalled = !safeExit && (hookDecision !== 'allow' || unknownWrite || action.effect === 'unknown')
  const repetitions = stalled ? progress.blocked_signature === signature ? Number(progress.blocked_repetitions || 0) + 1 : 1 : Number(progress.blocked_repetitions || 0)
  const count = stalled ? Number(progress.consecutive_no_progress || 0) + 1 : Number(progress.consecutive_no_progress || 0)
  const repeated = progress.blocked_signature === signature || list(progress.seen_queries).some(item => item.identity === signature)
  const blockedByProgress = !safeExit && (repetitions >= thresholds(previous.gaia2_runtime_policy).replan || count >= thresholds(previous.gaia2_runtime_policy).replan && repeated)
  if (blockedByProgress) hookDecision = 'block'
  const nextProgress = { ...progress, consecutive_no_progress: count, blocked_repetitions: repetitions,
    blocked_signature: stalled ? signature : progress.blocked_signature,
    last_reason: stalled ? 'repeated_blocked_action' : progress.last_reason,
    recommendation: recommendation(count, previous.gaia2_runtime_policy, progress.recommendation) }
  return { ...refreshed, progress: nextProgress, blockers, risky, unknownWrite, blockedByProgress, hookDecision,
    artifacts: [['GAIA2 repeated-action gate', { actionId: action.id, safeExit, consecutiveNoProgress: count, blockedRepetitions: repetitions,
      recommendation: nextProgress.recommendation, decision: hookDecision }]] }
}

function userProgress(previous, input) {
  const progress = previous.gaia2_progress_state, seen = new Set(list(progress.seen_user_ids)), consumed = new Set(list(previous.gaia2_event_state?.consumed))
  let changed = false
  for (const message of list(input.messages)) {
    if (message?.role !== 'user' || message.notificationType !== 'USER_MESSAGE') continue
    const id = String(message.id || message.toolCallId || '')
    if (id && !consumed.has(id) && !seen.has(id)) { seen.add(id); changed = true }
  }
  return changed ? { ...progress, consecutive_no_progress: 0, blocked_repetitions: 0, blocked_signature: null,
    last_reason: 'new_official_user_notification', recommendation: 'continue', seen_user_ids: [...seen] } : progress
}

/** Fixed semantic error codes; absent/v1 contracts explicitly preserve legacy
 * evidence. The caller supplies already parsed, hash-bound objects. `decision`
 * is the aggregate Hook decision, not an inference from an artifact title. */
export function informationNoiseTransitionErrors({ previousValues, input, variables, artifacts, decision } = {}) {
  const previous = values(previousValues), current = values(variables)
  const version = current?.gaia2_noise_state?.semanticVersion
  if (version === undefined || version === 1) return previous?.gaia2_noise_state?.semanticVersion === 2 ? ['noise_contract_version_invalid'] : []
  const errors = [], fail = code => { if (!errors.includes(code)) errors.push(code) }
  if (version !== 2) return ['noise_contract_version_invalid']
  if (current?.gaia2_observation_state?.schemaVersion === 'gaia2-observation-state-v2') return v2TransitionErrors({ previousValues, input, variables, artifacts, decision })
  try {
    if (!object(previous) || !object(current) || !object(input) || !object(previous.gaia2_observation_state)
      || !Array.isArray(previous.gaia2_observation_state.observations) || !object(current.gaia2_observation_state)
      || !Array.isArray(current.gaia2_observation_state.observations) || !object(previous.gaia2_progress_state)
      || !object(current.gaia2_progress_state) || !object(previous.gaia2_runtime_policy) || !Array.isArray(artifacts)) return ['noise_state_invalid']
    const observations = current.gaia2_observation_state.observations, byId = new Map()
    for (const item of observations) {
      if (!object(item) || !text(item.observationId) || !text(item.actionId) || !statuses.has(item.status)
        || !finite(item.observedAt) || !object(item.provenance) || byId.has(item.observationId)) { fail('noise_observation_identity_invalid'); continue }
      byId.set(item.observationId, item)
      if (item.provenance.actionId !== item.actionId || item.provenance.source !== item.canonicalName || item.provenance.observedAt !== item.observedAt) fail('noise_provenance_mismatch')
    }
    const derived = indexes(observations)
    for (const key of ['stale_ids', 'unverified_ids', 'conflict_ids']) if (!same(current.gaia2_observation_state[key], derived[key])) fail('noise_observation_index_mismatch')
    if (!same(current.gaia2_observation_state.provenance, derived.provenance)) fail('noise_provenance_mismatch')
    for (const key of ['conflicts', 'quarantined']) if (!same(current.gaia2_noise_state[key], summaries(derived)[key])) fail('noise_observation_index_mismatch')
    for (const item of observations.filter(item => item?.duplicateOf !== undefined)) {
      const prior = byId.get(item.duplicateOf)
      if (!prior || prior === item || observations.indexOf(prior) >= observations.indexOf(item) || !text(item.queryHash)
        || !['resourceKey', 'canonicalName', 'queryHash', 'resultHash'].every(key => prior[key] === item[key])
        || prior.outcomeStatus !== 'succeeded' || prior.complete !== true) fail('noise_duplicate_reference_invalid')
    }
    // A noise reclassification can annotate read-back, but cannot erase or
    // alter the identity/outcome of an unresolved mutation.
    for (const unknown of list(previous.gaia2_write_state?.unknown)) {
      const currentUnknown = list(current.gaia2_write_state?.unknown).find(item => item.actionId === unknown.actionId)
      const keys = Object.keys(unknown).filter(key => !['readBackObserved', 'readBackActionId', 'readBackHash'].includes(key))
      if (!currentUnknown || keys.some(key => !same(currentUnknown[key], unknown[key]))) fail('noise_unknown_write_erased')
    }
    const checkpoint = input.checkpoint
    if (!['after_tool', 'before_model', 'before_tool', 'attempt_end'].includes(checkpoint)) return [...errors, 'noise_checkpoint_invalid']
    if (checkpoint === 'attempt_end') {
      if (!same(current.gaia2_observation_state, previous.gaia2_observation_state) || !same(current.gaia2_noise_state, previous.gaia2_noise_state)
        || !same(current.gaia2_progress_state, previous.gaia2_progress_state)) fail('noise_transition_mismatch')
      return errors
    }
    if (!finite(input.clock?.now)) return [...errors, 'noise_clock_invalid']
    if (observations.some(item => finite(item?.observedAt) && item.observedAt > input.clock.now)) fail('noise_clock_invalid')
    if (checkpoint !== 'before_model' && (!object(input.action) || !text(input.action.id) || !text(input.action.canonicalName))) return [...errors, 'noise_action_invalid']
    if (checkpoint === 'after_tool' && (!object(input.outcome) || !text(input.outcome.status))) return [...errors, 'noise_outcome_binding_mismatch']
    let expected
    if (checkpoint === 'after_tool' && CONTROL_ACTIONS.has(input.action?.canonicalName)) {
      if (!same(current.gaia2_observation_state, previous.gaia2_observation_state)
        || !same(current.gaia2_noise_state, previous.gaia2_noise_state)
        || !same(current.gaia2_progress_state, previous.gaia2_progress_state)) fail('noise_control_transition_mismatch')
      return errors
    }
    if (checkpoint === 'after_tool') expected = afterTool(previous, input, fail)
    else {
      const refreshed = refresh(previous, input, fail)
      expected = checkpoint === 'before_tool' ? beforeTool(previous, input, refreshed)
        : { ...refreshed, progress: userProgress(previous, input), artifacts: [['GAIA2 evidence freshness refresh', {
          clockNow: input.clock.now, ttlSeconds: refreshed.ttl, changed: refreshed.changed, recommendation: previous.gaia2_progress_state.recommendation }]] }
    }
    if (!same(current.gaia2_observation_state, expected.observation)) fail(checkpoint === 'after_tool' ? 'noise_transition_mismatch' : 'noise_freshness_transition_invalid')
    if (!same(current.gaia2_noise_state, expected.noise)) fail('noise_summary_transition_invalid')
    if (!same(current.gaia2_progress_state, expected.progress)) fail('noise_progress_transition_invalid')
    for (const [title, value] of expected.artifacts) {
      const matches = artifacts.filter(item => item?.title === title)
      if (matches.length !== 1 || !same(matches[0].value, value)) fail('noise_artifact_mismatch')
    }
    if (checkpoint === 'before_tool') {
      const rank = { allow: 0, read_back: 1, block: 2 }, action = input.action
      if (expected.risky && expected.blockers.length && !(rank[decision?.action] >= rank.read_back)) fail('noise_risky_decision_weakened')
      if (expected.blockedByProgress && decision?.action !== 'block') fail('noise_no_progress_gate_weakened')
      if (['write', 'finish'].includes(action.effect) && expected.unknownWrite && !(rank[decision?.action] >= rank.read_back)) fail('noise_unknown_write_replayed')
      if (action.effect === 'unknown' && !(action.canonicalName === 'AppAgent__expert_agent' && action.a2aPermission === true && text(action.requestId)) && decision?.action !== 'block') fail('noise_unknown_effect_allowed')
      const gates = artifacts.filter(item => item?.title === 'GAIA2 conflict decision')
      if (gates.length !== 1 || gates[0].value?.actionId !== action.id || gates[0].value?.action !== expected.hookDecision
        || !same(gates[0].value?.blockers, expected.blockers.slice(-12))) fail('noise_artifact_mismatch')
    }
  } catch {
    fail('noise_input_invalid')
  }
  return errors
}
