import { defineHook } from "@capybara-agent/sdk";

function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }

export default defineHook({
  name: "gaia2-attempt-record",
  description: "Records sanitized attempt metadata for the Experiment Store boundary without exposing verifier details.",
  enabled: true,
  checkpoint: "after_evaluation",
  trigger({ training, loop }) { return Boolean(training || loop.terminal); },
  schedule: { priority: 80, timeoutMs: 5000, onError: "continue" },
  permissions: { variables: "patch", artifacts: "write" },
  run({ variables, loop, training }) {
    const evaluation = object(training?.evaluation);
    const record = { run_id: loop.runId, attempt_index: Number(training?.attemptIndex || 0), status: evaluation.passed === true ? "pass" : evaluation.passed === false ? "fail" : "pending", verifier_status: evaluation.status || "sealed", recordedAt: new Date().toISOString() };
    return { patches: [{ op: "replace", path: "/builtin/variables/gaia2_experiment_context", value: JSON.stringify(record) }], artifacts: [{ title: `GAIA2 attempt record ${loop.runId}`, value: record }], metadata: { sealed: true, record } };
  },
});
