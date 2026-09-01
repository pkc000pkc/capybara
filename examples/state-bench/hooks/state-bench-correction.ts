import { defineHook } from "@capybara-agent/sdk";

function normalize(value) {
  return typeof value === "string" ? value.replaceAll("\r\n", "\n").trim() : "";
}

function parseObject(value) {
  const text = normalize(value).replace(/^```(?:json)?\s*|\s*```$/giu, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("correction model returned no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

export default defineHook({
  name: "state-bench-correction",
  description: "Diagnoses a failed training execution and proposes a temporary strategy for a clean replay.",
  enabled: true,
  checkpoint: "after_evaluation",
  trigger({ training }) {
    return training?.phase === "training" && training.evaluation.passed === false;
  },
  schedule: { priority: 120, timeoutMs: 300_000, onError: "retry" },
  permissions: { llm: "project", variables: "patch" },
  async run({ llm, training }) {
    if (!training) return {};
    if (training.case.expectedAnswer || training.case.thinking || training.case.expectedTools?.length) {
      throw new Error("correction Hook received hidden expected-case fields");
    }
    if (training.evaluation.reference || training.evaluation.details || Object.keys(training.evaluation.metrics ?? {}).length) {
      throw new Error("correction Hook received hidden evaluator evidence");
    }
    if (training.failureEvidence?.outcome !== "incorrect") {
      throw new Error("correction Hook requires sanitized failure evidence");
    }
    const previous = training.correctionAttempts ?? [];
    const response = await llm.responses.create({
      input: [
        "Diagnose this failed STATE-Bench training execution and propose the next independent clean-run strategy.",
        "The expected answer and official reference are intentionally unavailable. The new strategy must cause the agent to discover and execute the result through tools or valid reasoning.",
        "Account for previous ineffective corrections. Find the first divergence, then specify reads, ordering, consent, mutation, and verification needed to correct it.",
        "Never include task IDs, record IDs, exact expected answer text, credentials, or hidden evaluator language in the strategy.",
        "Return exactly one JSON object with non-empty string fields summary and strategy.",
        `Question:\n${normalize(training.case.question).slice(0, 10000)}`,
        `Failed answer:\n${normalize(training.case.actualAnswer).slice(0, 6000)}`,
        `Failed tool calls:\n${JSON.stringify(training.case.toolCalls).slice(0, 18000)}`,
        `Sanitized outcome:\n${normalize(training.failureEvidence.message).slice(0, 2000)}`,
        `Previous corrections:\n${JSON.stringify(previous).slice(0, 18000)}`,
      ].join("\n\n"),
      max_output_tokens: 3500,
    });
    const parsed = parseObject(response.output_text);
    const summary = normalize(parsed.summary);
    const strategy = normalize(parsed.strategy);
    if (!summary || !strategy) throw new Error("correction model omitted summary or strategy");
    return {
      correction: {
        summary,
        strategy,
        variableOverrides: { memory_runtime_context: strategy.slice(0, 12000) },
      },
      metadata: { correctionOrdinal: previous.length + 1 },
    };
  },
});
