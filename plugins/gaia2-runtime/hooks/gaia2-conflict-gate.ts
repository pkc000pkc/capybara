import { defineHook } from "@capybara-agent/sdk";
export default defineHook({
  name: "gaia2-conflict-gate", description: "Allows evidence gathering but stops mutations based on incomplete or contradictory observations.",
  enabled: true, checkpoint: "before_tool", trigger({ action }) { return Boolean(action); },
  schedule: { priority: 220, timeoutMs: 3000, onError: "block" },
  permissions: { variables: "patch", artifacts: "write" },
  run({ variables, action }) {
    const state = variables.builtin.variables.gaia2_observation_state;
    const blockers = [...new Set([...(state.unverified_ids || []), ...(state.conflict_ids || [])])];
    const risky = ["write", "unknown"].includes(action.effect);
    const decision = risky && blockers.length ? { action: "read_back", reason: "Unverified or conflicting evidence must be checked before a mutation.", resourceKey: action.resourceKey } : { action: "allow", reason: "Evidence-gathering, waiting and clarification remain available." };
    return { decision, patches: blockers.length ? [{ op: "replace", path: "/builtin/variables/gaia2_runtime_context", value: "Unverified observations: " + blockers.slice(-12).join(", ") + ". Obtain fresh authoritative evidence, clarify, replan, or stop safely." }] : [], artifacts: [{ title: "GAIA2 conflict decision", value: { actionId: action.id, blockers: blockers.slice(-12), ...decision } }] };
  },
});
