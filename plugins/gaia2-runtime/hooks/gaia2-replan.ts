import { defineHook } from "@capybara-agent/sdk";
export default defineHook({
  name: "gaia2-replan", description: "Invalidates assumptions after newly visible user or environment observations.",
  enabled: true, checkpoint: "before_model",
  trigger({ variables }) { return Boolean(variables.builtin.variables.gaia2_event_state.pending.length); },
  schedule: { priority: 205, timeoutMs: 3000, onError: "block" },
  permissions: { variables: "patch", artifacts: "write" },
  run({ variables, loop }) {
    const events = variables.builtin.variables.gaia2_event_state.pending;
    const prior = variables.builtin.variables.gaia2_replan_state;
    const invalidated = events.map(event => event.id);
    const next = { ...prior, invalidated_steps: invalidated.slice(-32), reason: "New visible observations require the current plan to be rechecked.", updatedAt: loop.iteration };
    const context = "New visible observation IDs: " + invalidated.slice(-12).join(", ") + ". Reconcile the latest user instructions and tool evidence before choosing your next action.";
    return { patches: [{ op: "replace", path: "/builtin/variables/gaia2_replan_state", value: next }, { op: "replace", path: "/builtin/variables/gaia2_runtime_context", value: context }], artifacts: [{ title: "GAIA2 same-loop replanning", value: { invalidated: invalidated.slice(-32), loop: loop.iteration } }] };
  },
});
