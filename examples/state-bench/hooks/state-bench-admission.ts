import { defineHook } from "@capybara-agent/sdk";

export default defineHook({
  name: "state-bench-admission",
  description: "Admits memory only after a passing closed-book replay.",
  enabled: true,
  checkpoint: "after_replay",
  trigger({ training }) {
    return Boolean(training?.candidate);
  },
  schedule: { priority: 100, timeoutMs: 10_000, onError: "continue" },
  permissions: {},
  run({ training }) {
    if (!training?.candidate) return {};
    if (training.case.expectedAnswer || training.case.thinking || training.case.expectedTools?.length) {
      throw new Error("admission Hook received hidden expected-case fields");
    }
    if (training.evaluation.reference || training.evaluation.details || Object.keys(training.evaluation.metrics ?? {}).length) {
      throw new Error("admission Hook received hidden evaluator evidence");
    }
    const analysisOnly = training.case.question.includes(
      "Analyze one official STATE-Bench training-only trajectory for reusable procedural learning.",
    );
    if (analysisOnly) {
      return {
        admission: {
          verdict: "reject",
          reasons: [
            "This replay validates an analysis response, not execution of the underlying STATE-Bench task.",
          ],
        },
      };
    }
    if (!training.evaluation.passed) {
      return {
        admission: {
          verdict: training.correctionAttempts?.length ? "retry_correction" : "reject",
          reasons: ["The closed-book replay did not reproduce a successful outcome."],
        },
      };
    }
    if (Number(training.evaluation.score ?? 0) < 0.8) {
      return {
        admission: {
          verdict: "reject",
          reasons: ["The closed-book replay score is below the 0.8 admission threshold."],
        },
      };
    }
    const attempts = training.correctionAttempts ?? [];
    if (attempts.length > 0 && attempts.at(-1)?.passed !== true) {
      return {
        admission: {
          verdict: "retry_correction",
          reasons: ["The latest clean correction replay did not pass."],
        },
      };
    }
    const memoryPatches = training.candidate.patches.filter((patch) =>
      patch.variableName.startsWith("memory_") && patch.variableName !== "memory_manifest");
    if (memoryPatches.length === 0 || memoryPatches.some((patch) =>
      !patch.unifiedDiff.includes('"memoryKey"')
      || !patch.unifiedDiff.includes('"mode"')
      || !patch.unifiedDiff.includes('"phase"'))) {
      return {
        admission: {
          verdict: "reject",
          reasons: ["The candidate does not use the atomic memory v2 schema."],
        },
      };
    }
    return {
      admission: {
        verdict: "accept",
        reasons: ["The v2 candidate preserved a passing closed-book task execution."],
      },
    };
  },
});
