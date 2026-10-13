import { defineHook } from "@capybara-agent/sdk";
export default defineHook({
  name: "gaia2-noise-classifier", description: "Records exact-query evidence, duplicate freshness, explicit uncertainty and confirmed read-back without keyword truth inference.",
  enabled: true, checkpoint: "after_tool", trigger({ action }) { return Boolean(action); },
  schedule: { priority: 190, timeoutMs: 3000, onError: "block" },
  permissions: { variables: "patch", artifacts: "write" },
  run({ variables, action, outcome, clock, messages }) {
    const values = variables.builtin.variables, old = values.gaia2_observation_state, noise = values.gaia2_noise_state;
    const existing = old.observations || [], active = item => !["verified_by_fresh_read", "superseded_by_fresh_read"].includes(item.status);
    const queryHash = typeof action.mutationKey === "string" && action.mutationKey ? action.mutationKey : null;
    const sourceViews = (messages || []).filter(message => message.role === "tool" && message.observation && message.observation.actionId === action.id).map(message => message.observation);
    const sourceView = sourceViews[0];
    if (sourceViews.some(view => JSON.stringify(view) !== JSON.stringify(sourceView))) throw new Error("OBSERVATION_VIEW_CONFLICT");
    if (sourceView && (sourceView.resourceKey !== action.resourceKey || sourceView.canonicalName !== action.canonicalName || sourceView.queryHash !== queryHash || sourceView.resultHash !== outcome.resultHash || sourceView.complete !== (outcome.complete !== false) || !Number.isFinite(sourceView.observedAt) || sourceView.observedAt < 0 || sourceView.observedAt > clock.now)) throw new Error("OBSERVATION_RETURN_BINDING");
    // ARE keeps advancing between native return and Hook IPC. Preserve the
    // trusted native collection time, not the later Hook processing time.
    const observedAt = sourceView ? sourceView.observedAt : clock.now;
    const sameQuery = item => queryHash !== null && item.queryHash === queryHash && item.canonicalName === action.canonicalName && item.resourceKey === action.resourceKey;
    const group = existing.filter(sameQuery), prior = [...group].reverse().find(item => item.authoritativeRead === true && item.outcomeStatus === "succeeded" && item.complete === true);
    const viewComplete = sourceView ? sourceView.viewComplete : outcome.viewComplete !== false;
    const full = outcome.status === "succeeded" && outcome.complete !== false && viewComplete;
    const fresh = action.effect === "read" && action.authoritativeRead === true && full && queryHash !== null;
    const duplicateOf = full && group.find(item => item.outcomeStatus === "succeeded" && item.complete === true && item.resultHash === outcome.resultHash);
    const duplicateAction = existing.some(item => item.actionId === action.id);
    let all = [...existing], status = outcome.status !== "succeeded" ? "failed" : !full ? "incomplete" : duplicateOf ? "duplicate" : "observed";
    let resolved = false;
    if (fresh && !duplicateAction) {
      const conflict = group.some(item => active(item) && item.status === "conflicting");
      if (prior && prior.resultHash !== outcome.resultHash) {
        status = "conflicting";
        all = all.map(item => sameQuery(item) && active(item) && item.outcomeStatus === "succeeded" && item.complete === true ? { ...item, status: "conflicting", conflictsWith: [...new Set([...(item.conflictsWith || []), "obs-" + action.id])] } : item);
      } else {
        resolved = group.some(item => active(item) && ["failed", "incomplete", "stale", "conflicting"].includes(item.status));
        all = all.map(item => sameQuery(item) && active(item) ? { ...item, status: ["failed", "incomplete", "stale", "conflicting"].includes(item.status) ? "verified_by_fresh_read" : "superseded_by_fresh_read", verifiedBy: action.id, verifiedAt: clock.now } : item);
        // A changed observation remains conflicting until a later full read
        // confirms its latest value. A same-content duplicate is still fresh.
        if (conflict && !prior) throw new Error("CONFLICT_CONFIRMATION_MISSING");
      }
    }
    const record = { observationId: "obs-" + action.id, actionId: action.id, resourceKey: action.resourceKey, canonicalName: action.canonicalName, queryHash, resultHash: outcome.resultHash || null, fingerprint: outcome.resultHash || action.id, status, outcomeStatus: outcome.status, complete: outcome.complete !== false, viewComplete, observedAt, authoritativeRead: action.authoritativeRead === true && action.effect === "read", provenance: { actionId: action.id, source: action.canonicalName, observedAt }, ...(sourceView && !viewComplete ? { viewIncompleteReason: sourceView.viewIncompleteReason } : {}), ...(duplicateOf ? { duplicateOf: duplicateOf.observationId } : {}), ...(status === "conflicting" ? { conflictsWith: group.filter(item => active(item) && item.resultHash !== outcome.resultHash).map(item => item.observationId) } : {}) };
    if (!duplicateAction) all.push(record);
    const state = { observations: all, provenance: all.map(item => item.provenance), stale_ids: all.filter(item => item.status === "stale").map(item => item.observationId), unverified_ids: all.filter(item => ["incomplete", "failed"].includes(item.status)).map(item => item.observationId), conflict_ids: all.filter(item => item.status === "conflicting").map(item => item.observationId) };
    const progress = values.gaia2_progress_state, identity = JSON.stringify([action.canonicalName, action.resourceKey, queryHash]);
    const seen = (progress.seen_queries || []).find(item => item.identity === identity);
    const advanced = full && (resolved || ["write", "wait", "finish"].includes(action.effect) || !seen || seen.resultHash !== outcome.resultHash);
    const count = advanced ? 0 : Number(progress.consecutive_no_progress || 0) + 1;
    const policy = values.gaia2_runtime_policy, replanAfter = Number(policy.no_progress_replan_after || 3), stopAfter = Number(policy.no_progress_stop_after || 6);
    const next = { ...progress, steps: Number(progress.steps || 0) + 1, consecutive_no_progress: count, blocked_repetitions: advanced ? 0 : progress.blocked_repetitions, blocked_signature: advanced ? null : progress.blocked_signature, last_reason: advanced ? (resolved ? "evidence_verified" : "new_observable_progress") : "repeated_or_uncertain_result", recommendation: count >= stopAfter ? "clarify_or_safe_finish" : count >= replanAfter ? "replan_with_fresh_evidence" : "continue", seen_queries: full ? [...(progress.seen_queries || []).filter(item => item.identity !== identity), { identity, resultHash: outcome.resultHash || null }].slice(-64) : progress.seen_queries || [] };
    return { patches: [{ op: "replace", path: "/builtin/variables/gaia2_observation_state", value: state }, { op: "replace", path: "/builtin/variables/gaia2_noise_state", value: { ...noise, decisions: [...(noise.decisions || []), record], deduplicated: [...(noise.deduplicated || []), ...(duplicateOf ? [record.observationId] : [])], conflicts: state.conflict_ids, quarantined: [...state.unverified_ids, ...state.stale_ids, ...state.conflict_ids] } }, { op: "replace", path: "/builtin/variables/gaia2_progress_state", value: next }], artifacts: [{ title: "GAIA2 observable evidence classification", value: record }, { title: "GAIA2 finite progress decision", value: { actionId: action.id, advanced, resolved, consecutiveNoProgress: count, recommendation: next.recommendation } }] };
  },
});
