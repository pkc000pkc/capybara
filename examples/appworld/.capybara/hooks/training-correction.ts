import { defineHook } from "@capybara/sdk";

const MAX_CORRECTION_INPUT = 18_000;

function trim(value, limit = MAX_CORRECTION_INPUT) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated]`;
}

function serialize(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function redact(value) {
  return String(value ?? "")
    .replace(/("(?:password|access_token|token)"\s*:\s*")[^"]*(")/giu, "$1[REDACTED]$2")
    .replace(/((?:password|access_token|token)\s*[=:]\s*)[^\s,}\]]+/giu, "$1[REDACTED]");
}

function toolTrace(training) {
  const calls = Array.isArray(training?.case?.toolCalls) ? training.case.toolCalls.slice(0, 24) : [];
  if (calls.length === 0) return "(tool-call detail unavailable)";
  return trim(calls.map((call, index) => [
    `${index + 1}. ${call?.name ?? "unknown"} [${call?.status ?? "unknown"}]`,
    `Arguments: ${trim(redact(serialize(call?.arguments)), 700)}`,
    `Result: ${trim(redact(call?.resultPreview ?? serialize(call?.error)), 900)}`,
  ].join("\n")).join("\n\n"));
}

function referenceEvidence(training) {
  const reference = training?.evaluation?.reference;
  if (!reference || reference.status !== "available") {
    return "Official reference: unavailable\nReference error: " + trim(reference?.error ?? "not returned", 2_000);
  }
  if (reference.kind === "text") {
    return [
      "Official reference kind: text",
      `Official answer: ${trim(reference.displayValue, 4_000)}`,
      `Requirements: ${trim(redact(serialize(reference.requirements)), 8_000)}`,
    ].join("\n");
  }
  return [
    "Official reference kind: state",
    `Expected state: ${trim(redact(serialize(reference.expectedState)), 8_000)}`,
    `Requirement results: ${trim(redact(serialize(reference.requirements)), 10_000)}`,
    `Actual state changes: ${trim(redact(serialize(reference.actualStateChanges)), 6_000)}`,
    `State evidence completeness: ${reference.stateChangesStatus ?? "unknown"}`,
    `Failure traces: ${trim(redact(serialize(reference.failureTraces)), 6_000)}`,
  ].join("\n");
}

export default defineHook({
  name: "training-correction",
  description: "Explains failed AppWorld training cases from post-evaluation official references and state evidence.",
  enabled: true,
  checkpoint: "after_evaluation",
  trigger({ training }) {
    return training?.phase === "training" && training.evaluation.passed === false;
  },
  schedule: { priority: 100, timeoutMs: 120_000, onError: "retry" },
  permissions: { llm: "project" },
  async run({ llm, training }) {
    if (!training) return {};
    const response = await llm.responses.create({
      input: [
        "Analyze this failed AppWorld training case and produce a reusable, dependency-aware correction for later cases.",
        "The official reference below was released only after grading. Use it to reconstruct the correct result or required state transition.",
        "Do not invent API names, arguments, identifiers, account values, or task-specific facts.",
        "For a state task, translate every evaluator requirement into a final-state invariant, infer prerequisite and ordering edges, and align those invariants with actual state changes and the ordered tool trace.",
        "Find the first divergent read or mutation. Explicitly consider: missed prerequisite, stale read, wrong entity or unstable ID, duplicate/non-idempotent mutation, incomplete pagination, incorrect mutation order, partial transaction, and missing postcondition verification.",
        "If a collection differs, require exhaustive pagination, stable-ID resolution, explicit desired/current set difference, idempotent mutations, and an exact final set comparison.",
        "The recovery procedure must start from the current partially-mutated state: re-read authoritative state, preserve already-correct changes, repair only the remaining delta, verify after each dependency boundary, then audit all final invariants.",
        "Separate action success from task success. A successful API response is only an intermediate checkpoint; the final observed state must satisfy every requirement.",
        "Keep the correction procedural and domain-general; never preserve case IDs, song titles, playlist IDs, credentials, or other task-specific values.",
        "Return concise Markdown with exactly these headings: Failure class, Corrected procedure, Verification rule, Evidence.",
        `Question:\n${trim(training.case.question)}`,
        `Agent final response:\n${trim(training.case.actualAnswer, 4_000) || "(empty)"}`,
        `Evaluator result:\n${trim(training.evaluation.rationale, 8_000)}`,
        referenceEvidence(training),
        `Expected project tools:\n${training.case.expectedTools.join(", ") || "(none)"}`,
        `Actual project tools:\n${training.case.actualTools.join(", ") || "(none)"}`,
        `Tool trace:\n${toolTrace(training)}`,
      ].join("\n\n"),
      max_output_tokens: 4_500,
    });
    return {
      metadata: {
        correctedReasoning: trim(response.output_text, 12_000),
        source: "appworld-evaluator-feedback",
        postEvaluationReference: true,
      },
    };
  },
});
