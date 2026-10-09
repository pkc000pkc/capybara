import { defineHook } from "@capybara-agent/sdk";
export default defineHook({
  name: "gaia2-conflict-gate", description: "Allows evidence gathering but stops mutations based on incomplete or contradictory observations.",
  enabled: true, checkpoint: "before_tool", trigger({ action }) { return Boolean(action); },
  schedule: { priority: 220, timeoutMs: 3000, onError: "block" },
  permissions: { variables: "patch", artifacts: "write" },
  run({ variables, action }) {
    const state = variables.builtin.variables.gaia2_observation_state || {};
    const blockerIds = [...new Set([...(state.unverified_ids || []), ...(state.conflict_ids || [])])];
    const observations = Array.isArray(state.observations) ? state.observations : [];
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
    const decision = risky && blockers.length ? { action: "read_back", reason: "Unverified or conflicting evidence must be checked before a mutation.", resourceKey: action.resourceKey } : { action: "allow", reason: "Evidence-gathering, waiting and clarification remain available." };
    return { decision, patches: blockers.length ? [{ op: "replace", path: "/builtin/variables/gaia2_runtime_context", value: "Unverified observations: " + blockers.slice(-12).join(", ") + ". Obtain fresh authoritative evidence, clarify, replan, or stop safely." }] : [], artifacts: [{ title: "GAIA2 conflict decision", value: { actionId: action.id, blockers: blockers.slice(-12), ...decision } }] };
  },
});
