import { defineHook } from "@capybara-agent/sdk";

function text(value) { return typeof value === "string" ? value.replaceAll("\r\n", "\n").trim() : ""; }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }

export default defineHook({
  name: "gaia2-correction",
  description: "Forms an answer-blind correction strategy from observable execution defects; a fresh replay must verify it before admission.",
  enabled: true,
  checkpoint: "after_evaluation",
  trigger({ training }) { return training?.phase === "training" && training?.evaluation?.passed === false; },
  schedule: { priority: 210, timeoutMs: 300000, onError: "retry" },
  permissions: { llm: "project", variables: "patch" },
  async run({ llm, training }) {
    const safe = object(training);
    if (safe.case?.expectedAnswer || safe.case?.thinking || safe.case?.expectedTools?.length || safe.evaluation?.reference || safe.evaluation?.details) throw new Error("sealed evaluator violation: GAIA2 correction received evaluator data");
    const response = await llm.responses.create({ input: [
      "Produce one answer-blind GAIA2 correction strategy from observable execution only.",
      "Do not guess the reference answer, oracle action, score, or judge rationale. Diagnose a process defect, change the method, and define verification evidence.",
      `Failure signal: ${text(safe.failureEvidence?.outcome || "incorrect")}`,
      `Question: ${text(safe.case?.question).slice(0, 8000)}`,
      `Actual answer: ${text(safe.case?.actualAnswer).slice(0, 5000)}`,
      `Observable trace: ${JSON.stringify(safe.case?.transcript || []).slice(0, 18000)}`,
    ].join("\n\n"), max_output_tokens: 1200 });
    const strategy = text(response.output_text).slice(0, 3000);
    if (!strategy) throw new Error("GAIA2 correction returned an empty strategy");
    return { correction: { strategy, freshReplayRequired: true, attemptCountDelta: 0 }, metadata: { answerBlind: true, attemptCountDelta: 0 } };
  },
});
