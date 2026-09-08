import { defineHook } from "@capybara-agent/sdk";

const DEFAULTS = {
  caseExtractTokens: 6_000,
  caseBufferTokens: 24_000,
  runPromoteTokens: 1_600,
  runExperienceTokens: 24_000,
  projectExperienceTokens: 48_000,
  evidenceCharsPerCase: 18_000,
};

function normalize(value) {
  return typeof value === "string" ? value.replaceAll("\r\n", "\n").replace(/\n+$/u, "") : "";
}

function estimateTokens(value) {
  const text = normalize(value);
  return text ? Math.ceil(text.length / 4) : 0;
}

function boundedParameter(training, key, fallback, minimum, maximum) {
  const raw = training?.parameters?.[key];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value))) : fallback;
}

function trimToTokens(value, limit) {
  const text = normalize(value);
  const maxChars = Math.max(0, limit * 4);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[truncated to configured token limit]`;
}

function redact(value) {
  return normalize(value)
    .replace(/("(?:password|access_token|token)"\s*:\s*")[^"]*(")/giu, "$1[REDACTED]$2")
    .replace(/((?:password|access_token|token)\s*[=:]\s*)[^\s,}\]]+/giu, "$1[REDACTED]");
}

function compact(value, limit) {
  const text = redact(value).replace(/\n{3,}/gu, "\n\n");
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated]`;
}

function serialize(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function lines(value) {
  const normalized = normalize(value);
  return normalized ? normalized.split("\n") : [];
}

function diffHeader(variableName) {
  return [
    `diff --git a/variables/${variableName}.txt b/variables/${variableName}.txt`,
    `--- a/variables/${variableName}.txt`,
    `+++ b/variables/${variableName}.txt`,
  ];
}

function appendDiff(variableName, before, addition) {
  const oldLines = lines(before);
  const addedLines = lines(addition);
  return [
    ...diffHeader(variableName),
    `@@ -${oldLines.length === 0 ? 0 : 1},${oldLines.length} +1,${oldLines.length + addedLines.length} @@`,
    ...oldLines.map((line) => ` ${line}`),
    ...addedLines.map((line) => `+${line}`),
  ].join("\n");
}

function replaceDiff(variableName, before, after) {
  const oldLines = lines(before);
  const newLines = lines(after);
  return [
    ...diffHeader(variableName),
    `@@ -${oldLines.length === 0 ? 0 : 1},${oldLines.length} +${newLines.length === 0 ? 0 : 1},${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}

function promptVariable(variables, key) {
  return normalize(variables?.builtin?.prompts?.[key]);
}

function toolTrace(training) {
  const calls = Array.isArray(training?.case?.toolCalls) ? training.case.toolCalls.slice(0, 24) : [];
  if (calls.length === 0) return "(tool-call detail unavailable)";
  return calls.map((call, index) => {
    const result = call?.resultPreview
      ? compact(call.resultPreview, 900)
      : call?.error
        ? compact(serialize(call.error), 900)
        : "(no result preview)";
    return [
      `${index + 1}. ${call?.name ?? "unknown"} [${call?.status ?? "unknown"}]`,
      `Arguments: ${compact(serialize(call?.arguments), 700)}`,
      `Result: ${result}`,
    ].join("\n");
  }).join("\n\n");
}

function referenceEvidence(training) {
  const reference = training?.evaluation?.reference;
  if (!reference) return "Official reference: not returned";
  const common = [
    `Official reference kind/status: ${reference.kind ?? "unknown"}/${reference.status ?? "unknown"}`,
    `Requirement results: ${compact(serialize(reference.requirements), 8_000)}`,
    `Failure traces: ${compact(serialize(reference.failureTraces), 5_000)}`,
  ];
  if (reference.status !== "available") {
    return [...common, `Reference error: ${compact(reference.error ?? "unavailable", 2_000)}`].join("\n");
  }
  if (reference.kind === "text") {
    return [...common, `Official answer: ${compact(reference.displayValue ?? serialize(reference.value), 4_000)}`].join("\n");
  }
  return [
    ...common,
    `Expected final state: ${compact(serialize(reference.expectedState), 8_000)}`,
    `Observed state changes: ${compact(serialize(reference.actualStateChanges), 8_000)}`,
    `State evidence completeness: ${reference.stateChangesStatus ?? "unknown"}`,
    `State evidence error: ${compact(reference.stateChangesError ?? "(none)", 2_000)}`,
  ].join("\n");
}

function caseEvidence(training, limit) {
  return compact([
    `### Training evidence (${training.evaluation.passed ? "passed" : "failed"})`,
    `Question: ${normalize(training.case.question)}`,
    `Agent completion: ${normalize(training.case.actualAnswer) || "(empty)"}`,
    `Evaluator: ${normalize(training.evaluation.rationale)}`,
    compact(referenceEvidence(training), Math.max(6_000, Math.floor(limit * 0.5))),
    `Expected project tools: ${training.case.expectedTools.join(", ") || "(none)"}`,
    `Actual project tools: ${training.case.actualTools.join(", ") || "(none)"}`,
    "Tool trace:",
    compact(toolTrace(training), Math.max(4_000, Math.floor(limit * 0.35))),
  ].join("\n"), limit);
}

function correctionText(training) {
  const correction = training.priorResults?.correction;
  if (!correction || typeof correction !== "object" || Array.isArray(correction)) return "";
  return typeof correction.correctedReasoning === "string" ? normalize(correction.correctedReasoning) : "";
}

export default defineHook({
  name: "experience-extractor",
  description: "Promotes AppWorld evidence through case, run, and replay-approved project experience levels.",
  enabled: true,
  checkpoint: "after_evaluation",
  trigger({ training }) {
    return training?.phase === "training";
  },
  schedule: { priority: 90, timeoutMs: 240_000, onError: "retry" },
  permissions: { llm: "project", variables: "patch" },
  parameters: [
    { key: "caseExtractTokens", label: "Case extraction tokens", description: "Extract the case buffer after it reaches this estimated token count.", defaultValue: "6000", input: "number", min: 500, max: 40000 },
    { key: "caseBufferTokens", label: "Case buffer capacity", description: "Maximum estimated tokens retained as raw training evidence.", defaultValue: "24000", input: "number", min: 6000, max: 60000 },
    { key: "runPromoteTokens", label: "Run promotion tokens", description: "Promote consolidated run guidance after it reaches this estimated token count.", defaultValue: "1600", input: "number", min: 400, max: 20000 },
    { key: "runExperienceTokens", label: "Run experience capacity", description: "Maximum estimated tokens retained in run-level guidance.", defaultValue: "24000", input: "number", min: 1600, max: 60000 },
    { key: "projectExperienceTokens", label: "Project experience capacity", description: "Maximum estimated tokens retained in the durable project playbook.", defaultValue: "48000", input: "number", min: 1000, max: 80000 },
    { key: "evidenceCharsPerCase", label: "Evidence chars per case", description: "Maximum characters retained from one evaluated case and its tool trace.", defaultValue: "18000", input: "number", min: 2000, max: 40000 },
  ],
  async run({ llm, training, variables }) {
    if (!training) return {};
    const caseExtractTokens = boundedParameter(training, "caseExtractTokens", DEFAULTS.caseExtractTokens, 500, 40_000);
    const caseBufferTokens = boundedParameter(training, "caseBufferTokens", DEFAULTS.caseBufferTokens, caseExtractTokens, 60_000);
    const runPromoteTokens = boundedParameter(training, "runPromoteTokens", DEFAULTS.runPromoteTokens, 400, 20_000);
    const runExperienceTokens = boundedParameter(training, "runExperienceTokens", DEFAULTS.runExperienceTokens, runPromoteTokens, 60_000);
    const projectExperienceTokens = boundedParameter(training, "projectExperienceTokens", DEFAULTS.projectExperienceTokens, 1_000, 80_000);
    const evidenceCharsPerCase = boundedParameter(training, "evidenceCharsPerCase", DEFAULTS.evidenceCharsPerCase, 2_000, 40_000);

    const caseBuffer = promptVariable(variables, "appworld_case_experience");
    const runExperience = promptVariable(variables, "appworld_run_experience");
    const projectExperience = promptVariable(variables, "appworld_project_experience");
    const evidence = caseEvidence(training, evidenceCharsPerCase);
    const buffered = trimToTokens(caseBuffer ? `${caseBuffer}\n\n${evidence}` : evidence, caseBufferTokens);
    const correction = correctionText(training);
    const forceCorrection = training.evaluation.passed === false && Boolean(correction);
    const shouldPromoteExistingRun = !forceCorrection && estimateTokens(runExperience) >= runPromoteTokens;

    if (shouldPromoteExistingRun) {
      const projectResponse = await llm.responses.create({
        input: [
          "Promote replay-verified AppWorld run guidance into the durable project playbook.",
          "Merge useful guidance, remove duplication, resolve contradictions in favor of evaluator-supported evidence, and retain failure recovery rules.",
          "Preserve domain-general multi-step state methodology: dependency ordering, baseline reads, stable entity resolution, idempotent mutation, intermediate checkpoints, exact-set reconciliation, partial-success recovery, and final invariant audits.",
          "Never retain case IDs, exact task facts, record identifiers, account values, credentials, tokens, or evaluator internals.",
          "Return a concise 1,000-1,600 token operational Markdown playbook. Do not claim undocumented APIs or signatures.",
          `Current project playbook:\n${trimToTokens(projectExperience, 16_000) || "(empty)"}`,
          `Replay-verified run guidance:\n${trimToTokens(runExperience, 8_000)}`,
        ].join("\n\n"),
        max_output_tokens: Math.min(2_500, projectExperienceTokens),
      });
      const nextProjectExperience = trimToTokens(normalize(projectResponse.output_text), projectExperienceTokens);
      if (!nextProjectExperience) throw new Error("experience extractor returned no project guidance");
      return {
        experiences: [{
          summary: "Promote replay-verified AppWorld guidance into the project playbook",
          rationale: "Run guidance reached the configured promotion threshold; the current case evidence remains buffered for the next extraction cycle.",
          patches: [
            {
              variableName: "appworld_case_experience",
              unifiedDiff: replaceDiff("appworld_case_experience", caseBuffer, buffered),
            },
            {
              variableName: "appworld_run_experience",
              unifiedDiff: replaceDiff("appworld_run_experience", runExperience, ""),
            },
            {
              variableName: "appworld_project_experience",
              unifiedDiff: replaceDiff("appworld_project_experience", projectExperience, nextProjectExperience),
            },
          ],
        }],
        metadata: {
          stage: "project",
          caseBufferTokens: estimateTokens(buffered),
          runExperienceTokens: estimateTokens(runExperience),
          projectExperienceTokens: estimateTokens(nextProjectExperience),
          forcedByFailure: false,
        },
      };
    }

    if (!forceCorrection && estimateTokens(buffered) < caseExtractTokens) {
      return {
        experiences: [{
          summary: "Accumulate replay-audited AppWorld case evidence",
          rationale: `The case buffer is below the ${caseExtractTokens}-token extraction threshold.`,
          patches: [{
            variableName: "appworld_case_experience",
            unifiedDiff: appendDiff("appworld_case_experience", caseBuffer, evidence),
          }],
        }],
        metadata: { stage: "case", caseBufferTokens: estimateTokens(buffered) },
      };
    }

    const runResponse = await llm.responses.create({
      input: [
        "Build a consolidated run-level AppWorld playbook from replay-audited training evidence.",
        "Use evaluator outcomes and tool traces, including successful procedures and failed attempts.",
        "Preserve useful current run guidance, remove duplication, and correct contradicted guidance.",
        "For multi-step state tasks, reconstruct a dependency graph from evaluator requirements and the observed trace: read authoritative baselines before writes, resolve stable entities, order mutations by prerequisites, verify after each dependency boundary, and audit every final-state invariant.",
        "Preserve a general exact-set reconciliation rule: exhaustively paginate source evidence, resolve stable IDs, compute desired/current set differences, use idempotent mutations, and compare the full final set after mutation.",
        "Preserve recovery rules for partial success: re-read current state, keep satisfied invariants, repair only the remaining delta, prevent duplicates, and never assume an API success response proves task completion.",
        "Never retain case IDs, exact task facts, record identifiers, account values, credentials, tokens, or evaluator internals.",
        "Document exact API-discovery habits only when supported by the trace; do not invent API names or signatures.",
        "Target 900-1,500 tokens. Return Markdown with headings: API discovery, State plan and dependencies, Authentication, Read and resolve, Mutate and checkpoint, Failure recovery, Final invariant audit.",
        `Current run experience:\n${trimToTokens(runExperience, 8_000) || "(empty)"}`,
        `Correction analysis:\n${correction || "(none)"}`,
        `Buffered evidence:\n${trimToTokens(buffered, 16_000)}`,
      ].join("\n\n"),
      max_output_tokens: Math.min(2_200, runExperienceTokens),
    });
    const nextRunExperience = trimToTokens(normalize(runResponse.output_text), runExperienceTokens);
    if (!nextRunExperience) throw new Error("experience extractor returned no run guidance");

    const patches = [
      {
        variableName: "appworld_case_experience",
        unifiedDiff: replaceDiff("appworld_case_experience", caseBuffer, ""),
      },
      {
        variableName: "appworld_run_experience",
        unifiedDiff: replaceDiff("appworld_run_experience", runExperience, nextRunExperience),
      },
    ];

    return {
      experiences: [{
        summary: "Extract AppWorld case evidence into run-level guidance",
        rationale: "Case evidence reached its extraction threshold and must pass closed-book replay before entering run experience.",
        patches,
      }],
      metadata: {
        stage: "run",
        caseBufferTokens: estimateTokens(buffered),
        runExperienceTokens: estimateTokens(nextRunExperience),
        projectExperienceTokens: estimateTokens(projectExperience),
        forcedByFailure: forceCorrection,
      },
    };
  },
});
