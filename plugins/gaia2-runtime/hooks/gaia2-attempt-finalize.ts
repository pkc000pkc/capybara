import { defineHook } from "@capybara-agent/sdk";
export default defineHook({
  name: "gaia2-attempt-finalize", description: "Records the agent execution end without exposing judge results.",
  enabled: true, checkpoint: "attempt_end", trigger() { return true; },
  schedule: { priority: 90, timeoutMs: 3000, onError: "block" },
  permissions: { variables: "patch", artifacts: "write" },
  run({ variables, loop }) {
    const attempt = variables.builtin.variables.gaia2_attempt_state;
    const next = { ...attempt, status: "agent_finished", termination_reason: loop.terminationReason || "environment_stop", evaluator: "sealed" };
    return { patches: [{ op: "replace", path: "/builtin/variables/gaia2_attempt_state", value: next }], artifacts: [{ title: "GAIA2 actor termination", value: next }] };
  },
});
