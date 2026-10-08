import { defineHook } from "@capybara-agent/sdk";
export default defineHook({
  name: "gaia2-write-outcome", description: "Records observed write outcomes; authoritative read-back is evidence, not automatic permission to replay.",
  enabled: true, checkpoint: "after_tool", trigger({ action }) { return Boolean(action); },
  schedule: { priority: 215, timeoutMs: 3000, onError: "block" },
  permissions: { variables: "patch", artifacts: "write" },
  run({ variables, action, outcome, loop }) {
    const state = variables.builtin.variables.gaia2_write_state;
    let actions = [...(state.actions || [])], unknown = [...(state.unknown || [])];
    if (["write", "finish"].includes(action.effect)) {
      const entry = { actionId: action.id, mutationKey: action.mutationKey || null, resourceKey: action.resourceKey || null, idempotent: action.idempotent === true, status: outcome.status, recordedAt: loop.iteration, resultHash: outcome.resultHash || null };
      actions.push(entry);
      if (outcome.status === "unknown" && !unknown.some(item => item.mutationKey === entry.mutationKey)) unknown.push({ ...entry, readBackObserved: false });
    }
    if (action.effect === "read" && action.authoritativeRead && outcome.status === "succeeded" && outcome.complete !== false) {
      unknown = unknown.map(item => item.resourceKey === action.resourceKey ? { ...item, readBackObserved: true, readBackActionId: action.id, readBackHash: outcome.resultHash || null } : item);
    }
    return { patches: [{ op: "replace", path: "/builtin/variables/gaia2_write_state", value: { ...state, actions, unknown } }], artifacts: [{ title: "GAIA2 observed mutation ledger", value: { actionId: action.id, unknownCount: unknown.length, readBackObserved: unknown.filter(item => item.readBackObserved).length } }] };
  },
});
