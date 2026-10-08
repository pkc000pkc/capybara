import { defineHook } from "@capybara-agent/sdk";
export default defineHook({
  name: "gaia2-write-guard", description: "Blocks unknown or repeated mutations before the real ARE tool executes.",
  enabled: true, checkpoint: "before_tool",
  trigger({ action }) { return Boolean(action); },
  schedule: { priority: 215, timeoutMs: 3000, onError: "block" },
  permissions: { variables: "patch", artifacts: "write" },
  run({ variables, action, loop }) {
    const state = variables.builtin.variables.gaia2_write_state;
    const actions = state.actions || [], unknown = state.unknown || [];
    let decision = { action: "allow", reason: "No unresolved mutation identity." };
    if (action.effect === "unknown") decision = { action: "block", reason: "Tool effect is not classified; obtain a verified tool contract." };
    else if (["write", "finish"].includes(action.effect)) {
      const prior = actions.find(item => item.mutationKey === action.mutationKey);
      const unresolved = unknown.find(item => item.mutationKey === action.mutationKey || item.resourceKey === action.resourceKey);
      if (!action.mutationKey || !action.resourceKey) decision = { action: "block", reason: "Mutation identity and resource are required." };
      else if (unresolved) decision = { action: "read_back", reason: "An earlier write has unknown outcome. Read authoritative current state or stop safely; never replay it.", mutationKey: unresolved.mutationKey, resourceKey: unresolved.resourceKey };
      else if (prior && !action.idempotent) decision = { action: "block", reason: "This non-idempotent mutation already completed. Use its observed result rather than execute it again.", mutationKey: action.mutationKey };
    }
    const patches = decision.action === "allow" ? [] : [{ op: "replace", path: "/builtin/variables/gaia2_write_state", value: { ...state, blocked: [...(state.blocked || []), { actionId: action.id, mutationKey: action.mutationKey || null, decision: decision.action, loop: loop.iteration }] } }];
    return { decision, patches, artifacts: [{ title: "GAIA2 pre-action write decision", value: { actionId: action.id, effect: action.effect, ...decision } }] };
  },
});
