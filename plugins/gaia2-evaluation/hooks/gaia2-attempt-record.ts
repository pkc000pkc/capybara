import { defineHook } from "@capybara-agent/sdk";

export default defineHook({
  name: "gaia2-attempt-record",
  description: "Records sanitized attempt metadata for the Experiment Store boundary without exposing verifier details.",
  enabled: true,
  checkpoint: "after_evaluation",
  trigger({ training }) { return training?.evaluation?.evaluated === true; },
  schedule: { priority: 80, timeoutMs: 5000, onError: "continue" },
  permissions: { artifacts: "write" },
  run({ training }) {
    // Identity and timestamps are attached by the trusted ledger, not copied
    // into Worker input or patched into readonly experiment context.
    const record = { status: training.evaluation.passed === true ? "pass" : "fail", attemptCountDelta: 0 };
    return { artifacts: [{ title: "GAIA2 attempt status", value: record }],
      metadata: { answerBlind: true, artifactOnly: true, attemptCountDelta: 0 } };
  },
});
