import { defineHook } from "@capybara-agent/sdk";
export default defineHook({
  name: "gaia2-noise-classifier", description: "Classifies explicit incomplete/failed observations without inferring truth from keywords.",
  enabled: true, checkpoint: "after_tool", trigger({ action }) { return Boolean(action); },
  schedule: { priority: 190, timeoutMs: 3000, onError: "block" },
  permissions: { variables: "patch", artifacts: "write" },
  run({ variables, action, outcome, clock }) {
    const old = variables.builtin.variables.gaia2_observation_state, noise = variables.builtin.variables.gaia2_noise_state;
    const existing = old.observations || [];
    const duplicate = existing.some(item => item.actionId === action.id);
    let all = [...existing];
    if (action.effect === "read" && action.authoritativeRead && outcome.status === "succeeded" && outcome.complete !== false) all = all.map(item => item.resourceKey === action.resourceKey && ["incomplete", "failed"].includes(item.status) ? { ...item, status: "verified_by_fresh_read", verifiedBy: action.id } : item);
    const record = { observationId: "obs-" + action.id, actionId: action.id, resourceKey: action.resourceKey, fingerprint: outcome.resultHash || action.id, status: duplicate ? "duplicate" : outcome.status !== "succeeded" ? "failed" : outcome.complete === false ? "incomplete" : "observed", observedAt: clock.now, provenance: { actionId: action.id, source: action.canonicalName } };
    if (!duplicate) all.push(record);
    const state = { observations: all, provenance: all.map(item => item.provenance), stale_ids: all.filter(item => item.status === "stale").map(item => item.observationId), unverified_ids: all.filter(item => ["incomplete", "failed"].includes(item.status)).map(item => item.observationId), conflict_ids: all.filter(item => item.status === "conflicting").map(item => item.observationId) };
    return { patches: [{ op: "replace", path: "/builtin/variables/gaia2_observation_state", value: state }, { op: "replace", path: "/builtin/variables/gaia2_noise_state", value: { ...noise, decisions: [...(noise.decisions || []), record], deduplicated: [...(noise.deduplicated || []), ...(duplicate ? [record.observationId] : [])], quarantined: state.unverified_ids } }], artifacts: [{ title: "GAIA2 observable evidence classification", value: record }] };
  },
});
