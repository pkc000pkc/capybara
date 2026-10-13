import { defineHook } from "@capybara-agent/sdk";

export default defineHook({
  name: "gaia2-observation-refresh", description: "Refreshes ARE-second TTL and trusted provider-view incompleteness before model selection.",
  enabled: true, checkpoint: "before_model", trigger() { return true; },
  schedule: { priority: 190, timeoutMs: 3000, onError: "block" },
  permissions: { variables: "patch", artifacts: "write" },
  run({ variables, messages, clock }) {
    const values = variables.builtin.variables, old = values.gaia2_observation_state, noise = values.gaia2_noise_state;
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
    const changed = [];
    const all = (old.observations || []).map(item => {
      // All old tool messages remain in Hook history. A later exact-query
      // verification is terminal for that old observation; never reopen it.
      if (["verified_by_fresh_read", "superseded_by_fresh_read"].includes(item.status)) return item;
      const view = views.get(item.actionId);
      if (view && (view.resourceKey !== item.resourceKey || view.canonicalName !== item.canonicalName || view.queryHash !== item.queryHash || view.resultHash !== item.resultHash || view.observedAt !== item.observedAt || view.complete !== item.complete)) throw new Error("OBSERVATION_VIEW_BINDING");
      let next = item;
      if (view && view.viewComplete === false && !["failed", "conflicting"].includes(item.status)) next = { ...next, status: "incomplete", viewComplete: false, viewIncompleteReason: view.viewIncompleteReason || "hidden" };
      if (Number.isFinite(ttl) && ttl >= 0 && Number.isFinite(item.observedAt) && clock.now - item.observedAt > ttl && ["observed", "duplicate"].includes(next.status)) next = { ...next, status: "stale", staleAt: clock.now };
      if (next !== item) changed.push({ observationId: item.observationId, previousStatus: item.status, status: next.status });
      return next;
    });
    const state = { ...old, observations: all, provenance: all.map(item => item.provenance), stale_ids: all.filter(item => item.status === "stale").map(item => item.observationId), unverified_ids: all.filter(item => ["incomplete", "failed"].includes(item.status)).map(item => item.observationId), conflict_ids: all.filter(item => item.status === "conflicting").map(item => item.observationId) };
    const progress = values.gaia2_progress_state;
    const context = "Active uncertain observations: " + [...state.unverified_ids, ...state.stale_ids, ...state.conflict_ids].slice(-12).join(", ") + ". Obtain a complete fresh authoritative read of the same query before relying on it.";
    const recovery = progress.recommendation !== "continue" ? " No observable progress: " + progress.recommendation + ". Use fresh authoritative evidence, wait for a real event, clarify, or finish safely without claiming unperformed work." : "";
    return { patches: [{ op: "replace", path: "/builtin/variables/gaia2_observation_state", value: state }, { op: "replace", path: "/builtin/variables/gaia2_noise_state", value: { ...noise, conflicts: state.conflict_ids, quarantined: [...state.unverified_ids, ...state.stale_ids, ...state.conflict_ids] } }, ...(changed.length || recovery ? [{ op: "replace", path: "/builtin/variables/gaia2_runtime_context", value: context + recovery }] : [])], artifacts: [{ title: "GAIA2 evidence freshness refresh", value: { clockNow: clock.now, ttlSeconds: ttl, changed, recommendation: progress.recommendation } }] };
  },
});
