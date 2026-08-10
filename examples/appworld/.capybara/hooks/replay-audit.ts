import { defineHook } from "@capybara/sdk";

export default defineHook({
  name: "replay-audit",
  description: "Records whether a candidate experience survived closed-book replay.",
  enabled: true,
  checkpoint: "after_replay",
  trigger({ training }) {
    return Boolean(training?.candidate);
  },
  schedule: { priority: 10, timeoutMs: 5000, onError: "continue" },
  permissions: {},
  run({ training, logger }) {
    logger.info("closed-book replay evaluated", {
      candidateId: training.candidate.id,
      passed: training.evaluation.passed,
      score: training.evaluation.score,
    });
    return {
      metadata: {
        candidateId: training.candidate.id,
        replayPassed: training.evaluation.passed,
      },
    };
  },
});
