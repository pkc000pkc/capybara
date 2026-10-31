import { defineHook } from "@capybara-agent/sdk";
export default defineHook({
  name: "gaia2-conflict-context-refresh", description: "Retires legacy automatic recovery plans; evidence diagnostics never authorize or block business actions.",
  enabled: true, checkpoint: "before_model", trigger({ variables }) { const state = variables.builtin.variables.gaia2_conflict_state; return Boolean(state && state.status !== "idle"); },
  schedule: { priority: 210, timeoutMs: 3000, onError: "block" }, permissions: { variables: "patch", artifacts: "write" },
  run({ variables }) {
    const prior = variables.builtin.variables.gaia2_conflict_state;
    if (!prior || !["gaia2-conflict-state-v1", "gaia2-conflict-state-v2"].includes(prior.schemaVersion)) throw new Error("CONFLICT_STATE_SCHEMA");
    return { patches: [
      { op: "replace", path: "/builtin/variables/gaia2_conflict_state", value: { schemaVersion: "gaia2-conflict-state-v1", status: "idle", userRef: null, blockedAction: null, blockerIds: [], requests: [], reason: null } },
      { op: "replace", path: "/builtin/variables/gaia2_conflict_context", value: "" },
    ], artifacts: [{ title: "GAIA2 legacy recovery retired", value: { previousStatus: prior.status, automaticQueries: 0, businessDecision: "actor_owned" } }] };
  },
});
