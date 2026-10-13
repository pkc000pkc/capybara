import { defineHook } from "@capybara-agent/sdk";
export default defineHook({
  name: "gaia2-conflict-gate", description: "Allows evidence gathering but stops mutations based on incomplete or contradictory observations.",
  enabled: true, checkpoint: "before_tool", trigger({ action }) { return Boolean(action); },
  schedule: { priority: 220, timeoutMs: 3000, onError: "block" },
  permissions: { variables: "patch", artifacts: "write" },
  run({ variables, action, messages, clock }) {
    const values = variables.builtin.variables, old = values.gaia2_observation_state || {}, noise = values.gaia2_noise_state;
    const ttl = Number(values.gaia2_runtime_policy.stale_after_ms) / 1000;
    const views = new Map();
    for (const message of messages || []) {
      if (message.role !== "tool" || !message.observation) continue;
      const view = message.observation;
      if (typeof view.actionId !== "string") continue;
      const previous = views.get(view.actionId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(view)) throw new Error("OBSERVATION_VIEW_CONFLICT");
      views.set(view.actionId, view);
    }
    const observations = (old.observations || []).map(item => {
      if (["verified_by_fresh_read", "superseded_by_fresh_read"].includes(item.status)) return item;
      const view = views.get(item.actionId);
      if (view && (view.resourceKey !== item.resourceKey || view.canonicalName !== item.canonicalName || view.queryHash !== item.queryHash || view.resultHash !== item.resultHash || view.observedAt !== item.observedAt || view.complete !== item.complete)) throw new Error("OBSERVATION_VIEW_BINDING");
      let next = item;
      if (view && view.viewComplete === false && !["failed", "conflicting"].includes(item.status)) next = { ...next, status: "incomplete", viewComplete: false, viewIncompleteReason: view.viewIncompleteReason || "hidden" };
      if (Number.isFinite(ttl) && ttl >= 0 && Number.isFinite(item.observedAt) && clock.now - item.observedAt > ttl && ["observed", "duplicate"].includes(next.status)) next = { ...next, status: "stale", staleAt: clock.now };
      return next;
    });
    const state = { ...old, observations, provenance: observations.map(item => item.provenance), stale_ids: observations.filter(item => item.status === "stale").map(item => item.observationId), unverified_ids: observations.filter(item => ["incomplete", "failed"].includes(item.status)).map(item => item.observationId), conflict_ids: observations.filter(item => item.status === "conflicting").map(item => item.observationId) };
    const blockerIds = [...new Set([...state.unverified_ids, ...state.stale_ids, ...state.conflict_ids])];
    const byId = new Map(observations.map(item => [item.observationId, item]));
    const dependencies = Array.isArray(action.resourceDependencies)
      ? action.resourceDependencies.filter(item => typeof item === "string" && item.length > 0)
      : [];
    const related = (item) => {
      // Missing resource metadata is deliberately conservative: without an
      // explicit scope we cannot prove that an unresolved observation is
      // independent of the requested mutation.
      if (!item || typeof item.resourceKey !== "string" || !item.resourceKey
          || typeof action.resourceKey !== "string" || !action.resourceKey) return true;
      return item.resourceKey === action.resourceKey || dependencies.includes(item.resourceKey);
    };
    const blockers = blockerIds.filter(id => related(byId.get(id)));
    const risky = ["write", "unknown"].includes(action.effect);
    const safeExit = action.effect === "wait" || action.effect === "finish" || action.effect === "read" && action.authoritativeRead === true;
    let decision = risky && blockers.length ? { action: "read_back", reason: "Incomplete, stale or conflicting evidence requires a complete fresh read of the same query before a mutation.", resourceKey: action.resourceKey } : { action: "allow", reason: "Evidence-gathering, waiting and clarification remain available." };
    const progress = values.gaia2_progress_state, signature = JSON.stringify([action.canonicalName, action.resourceKey, action.mutationKey || null]);
    const unknownWrite = (values.gaia2_write_state.unknown || []).some(item => item.mutationKey === action.mutationKey || item.resourceKey === action.resourceKey);
    const stalled = !safeExit && (decision.action !== "allow" || unknownWrite || action.effect === "unknown");
    const repetitions = stalled ? (progress.blocked_signature === signature ? Number(progress.blocked_repetitions || 0) + 1 : 1) : Number(progress.blocked_repetitions || 0);
    const count = stalled ? Number(progress.consecutive_no_progress || 0) + 1 : Number(progress.consecutive_no_progress || 0);
    const policy = values.gaia2_runtime_policy, replanAfter = Number(policy.no_progress_replan_after || 3), stopAfter = Number(policy.no_progress_stop_after || 6);
    const repeated = progress.blocked_signature === signature || (progress.seen_queries || []).some(item => item.identity === signature);
    if (!safeExit && (repetitions >= replanAfter || count >= replanAfter && repeated)) decision = { action: "block", reason: "no_progress_replan_required: use fresh evidence, wait, clarify, or finish safely; do not repeat this action.", resourceKey: action.resourceKey };
    const next = { ...progress, consecutive_no_progress: count, blocked_repetitions: repetitions, blocked_signature: stalled ? signature : progress.blocked_signature, last_reason: stalled ? "repeated_blocked_action" : progress.last_reason, recommendation: count >= stopAfter ? "clarify_or_safe_finish" : count >= replanAfter ? "replan_with_fresh_evidence" : progress.recommendation };
    return { decision, patches: [{ op: "replace", path: "/builtin/variables/gaia2_observation_state", value: state }, { op: "replace", path: "/builtin/variables/gaia2_noise_state", value: { ...noise, conflicts: state.conflict_ids, quarantined: [...state.unverified_ids, ...state.stale_ids, ...state.conflict_ids] } }, { op: "replace", path: "/builtin/variables/gaia2_progress_state", value: next }, ...(blockers.length || next.recommendation !== "continue" ? [{ op: "replace", path: "/builtin/variables/gaia2_runtime_context", value: "Unverified observations: " + blockers.slice(-12).join(", ") + ". Recovery: " + next.recommendation + ". Obtain fresh authoritative evidence of the same query, clarify, replan, or stop safely; never replay unknown writes." }] : [])], artifacts: [{ title: "GAIA2 conflict decision", value: { actionId: action.id, blockers: blockers.slice(-12), ...decision } }, { title: "GAIA2 repeated-action gate", value: { actionId: action.id, safeExit, consecutiveNoProgress: count, blockedRepetitions: repetitions, recommendation: next.recommendation, decision: decision.action } }] };
  },
});
