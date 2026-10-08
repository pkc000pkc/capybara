import { defineHook } from "@capybara-agent/sdk";
export default defineHook({
  name: "gaia2-a2a-guard", description: "Requires a permitted unique child-agent request before entering an A2A boundary.",
  enabled: true, checkpoint: "before_tool", trigger({ action }) { return Boolean(action); },
  schedule: { priority: 200, timeoutMs: 3000, onError: "block" },
  permissions: { variables: "patch", artifacts: "write" },
  run({ variables, action }) {
    const a2a = /a2a|app.?agent|agent.?to.?agent/i.test(action.canonicalName || "");
    const state = variables.builtin.variables.gaia2_event_state;
    const requests = state.a2a_requests || [];
    let decision = { action: "allow", reason: "Not an A2A boundary." };
    if (a2a) {
      if (!action.a2aPermission || !action.requestId) decision = { action: "block", reason: "An A2A request needs explicit permission and request identity." };
      else if (requests.some(item => item.requestId === action.requestId)) decision = { action: "block", reason: "An A2A request identity cannot be reused." };
      else decision = { action: "allow", reason: "A2A permission and unique identity verified." };
    }
    return { decision, patches: a2a && decision.action === "allow" ? [{ op: "replace", path: "/builtin/variables/gaia2_event_state", value: { ...state, a2a_requests: [...requests, { requestId: action.requestId, actionId: action.id, state: "started" }] } }] : [], artifacts: [{ title: "GAIA2 A2A pre-action decision", value: { actionId: action.id, a2a, ...decision } }] };
  },
});
