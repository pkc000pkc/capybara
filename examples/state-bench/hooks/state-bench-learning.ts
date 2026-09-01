import { defineHook } from "@capybara-agent/sdk";

const DOMAIN_VARIABLES = {
  travel: "memory_travel",
  customer_support: "memory_customer_support",
  shopping_assistant: "memory_shopping_assistant",
};
const MODES = new Set(["guard", "advice"]);
const PHASES = new Set(["any", "preflight", "decision", "mutation", "verification"]);

function normalize(value) {
  return typeof value === "string" ? value.replaceAll("\r\n", "\n").trim() : "";
}

function slug(value) {
  return normalize(value).replace(/[^a-z0-9_]+/giu, "_").replace(/^_+|_+$/gu, "").toLowerCase();
}

function promptVariable(variables, key) {
  return normalize(variables?.builtin?.prompts?.[key]);
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(normalize(value));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function parseObjectResponse(value) {
  const text = normalize(value).replace(/^```(?:json)?\s*|\s*```$/giu, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("memory extractor returned no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

async function parseOrRepairObjectResponse(llm, value) {
  try {
    return parseObjectResponse(value);
  } catch (parseError) {
    const repair = await llm.responses.create({
      input: [
        "Repair the JSON syntax in the supplied memory-extractor output.",
        "Preserve the existing content only. Do not infer, add, remove, summarize, or rewrite any memory entry.",
        "Return exactly one JSON object and no markdown or commentary.",
        "The object must have arrays domainEntries and generalEntries.",
        "Every existing array item must retain exactly these fields: intent, mode, phase, trigger, rule, tools, tags, requiredEvidence, blockWhen.",
        `Parser error: ${normalize(parseError instanceof Error ? parseError.message : String(parseError)).slice(0, 1000)}`,
        `Malformed output:\n${normalize(value).slice(0, 20000)}`,
      ].join("\n\n"),
      max_output_tokens: 4000,
    });
    return parseObjectResponse(repair.output_text);
  }
}

function domainFromQuestion(question) {
  const match = normalize(question).match(/Domain:\s*(travel|customer_support|shopping_assistant)/u);
  if (!match) throw new Error("training case does not declare a supported domain");
  return match[1];
}

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringArray(value, limit) {
  return Array.isArray(value) ? [...new Set(value.map(normalize).filter(Boolean))].slice(0, limit) : [];
}

function empiricalConfidence(successCount, failureCount) {
  return Number(((successCount + 1) / (successCount + failureCount + 2)).toFixed(4));
}

function sanitizeEntry(entry, domain, correctionCount, failureCount) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("memory entry must be an object");
  const intent = slug(entry.intent);
  const mode = normalize(entry.mode).toLowerCase();
  const phase = normalize(entry.phase).toLowerCase();
  const rule = normalize(entry.rule);
  const trigger = normalize(entry.trigger);
  if (!intent || !rule || !trigger) throw new Error("memory entry requires intent, trigger, and rule");
  if (!MODES.has(mode)) throw new Error("memory entry mode must be guard or advice");
  if (!PHASES.has(phase)) throw new Error("memory entry phase is invalid");
  if (domain === "*" && mode !== "guard") throw new Error("general memory entries must be cross-domain guards");
  const memoryKey = `${domain}:${mode}:${phase}:${intent}`;
  const observedFailures = Math.max(0, Math.floor(finiteNumber(failureCount, 0)));
  return {
    id: memoryKey.replaceAll(":", "-"),
    memoryKey,
    domain,
    mode,
    phase,
    intent,
    trigger,
    rule,
    tools: stringArray(entry.tools, 8),
    tags: stringArray(entry.tags, 10),
    requiredEvidence: stringArray(entry.requiredEvidence, 6),
    blockWhen: stringArray(entry.blockWhen, 6),
    confidence: empiricalConfidence(1, observedFailures),
    evidenceCount: 1 + observedFailures,
    successCount: 1,
    failureCount: observedFailures,
    correctionCount,
  };
}

function normalizeStoredEntry(entry, domain) {
  const mode = MODES.has(normalize(entry?.mode).toLowerCase()) ? normalize(entry.mode).toLowerCase() : "advice";
  const phase = PHASES.has(normalize(entry?.phase).toLowerCase()) ? normalize(entry.phase).toLowerCase() : "any";
  const intent = slug(entry?.intent || entry?.memoryKey || entry?.id);
  const memoryKey = normalize(entry?.memoryKey) || `${domain}:${mode}:${phase}:${intent}`;
  const successCount = Math.max(1, Math.floor(finiteNumber(entry?.successCount, finiteNumber(entry?.evidenceCount, 1))));
  const failureCount = Math.max(0, Math.floor(finiteNumber(entry?.failureCount, 0)));
  return {
    ...entry,
    id: normalize(entry?.id) || memoryKey.replaceAll(":", "-"),
    memoryKey,
    domain,
    mode,
    phase,
    intent,
    tools: stringArray(entry?.tools, 8),
    tags: stringArray(entry?.tags, 10),
    requiredEvidence: stringArray(entry?.requiredEvidence, 6),
    blockWhen: stringArray(entry?.blockWhen, 6),
    evidenceCount: Math.max(1, Math.floor(finiteNumber(entry?.evidenceCount, 1))),
    successCount,
    failureCount,
    correctionCount: Math.max(0, Math.floor(finiteNumber(entry?.correctionCount, 0))),
    confidence: empiricalConfidence(successCount, failureCount),
  };
}

function mergeEntry(current, addition) {
  const successCount = current.successCount + addition.successCount;
  const failureCount = current.failureCount + addition.failureCount;
  const preferAddition = addition.correctionCount > current.correctionCount;
  const preferred = preferAddition ? addition : current;
  return {
    ...preferred,
    id: current.id,
    memoryKey: current.memoryKey,
    tools: stringArray([...current.tools, ...addition.tools], 8),
    tags: stringArray([...current.tags, ...addition.tags], 10),
    requiredEvidence: stringArray([...current.requiredEvidence, ...addition.requiredEvidence], 6),
    blockWhen: stringArray([...current.blockWhen, ...addition.blockWhen], 6),
    evidenceCount: current.evidenceCount + addition.evidenceCount,
    successCount,
    failureCount,
    correctionCount: current.correctionCount + addition.correctionCount,
    confidence: empiricalConfidence(successCount, failureCount),
  };
}

function mergeEntries(current, additions, domain, capacity) {
  const byKey = new Map();
  for (const raw of current) {
    const entry = normalizeStoredEntry(raw, domain);
    byKey.set(entry.memoryKey, entry);
  }
  for (const entry of additions) {
    const previous = byKey.get(entry.memoryKey);
    byKey.set(entry.memoryKey, previous ? mergeEntry(previous, entry) : entry);
  }
  const ranked = [...byKey.values()].sort((left, right) =>
    Number(right.mode === "guard") - Number(left.mode === "guard")
    || right.confidence - left.confidence
    || right.evidenceCount - left.evidenceCount
    || left.memoryKey.localeCompare(right.memoryKey));
  return ranked.slice(0, capacity);
}

function lines(value) {
  const text = normalize(value);
  return text ? text.split("\n") : [];
}

function replaceDiff(variableName, before, after) {
  const oldLines = lines(before);
  const newLines = lines(after);
  return [
    `diff --git a/variables/${variableName}.txt b/variables/${variableName}.txt`,
    `--- a/variables/${variableName}.txt`,
    `+++ b/variables/${variableName}.txt`,
    `@@ -${oldLines.length === 0 ? 0 : 1},${oldLines.length} +${newLines.length === 0 ? 0 : 1},${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}

function correctionEvidence(attempts) {
  return attempts.map((attempt) => ({
    ordinal: attempt.ordinal,
    summary: normalize(attempt.summary),
    strategy: normalize(attempt.strategy),
    passed: attempt.passed === true,
    score: finiteNumber(attempt.score, 0),
    actualTools: Array.isArray(attempt.actualTools) ? attempt.actualTools : [],
    toolCalls: Array.isArray(attempt.toolCalls) ? attempt.toolCalls : [],
  }));
}

export default defineHook({
  name: "state-bench-learning",
  description: "Extracts successful STATE-Bench trajectories and correction chains into bounded atomic memory.",
  enabled: true,
  checkpoint: "after_evaluation",
  trigger({ training }) {
    return training?.phase === "training" && training.evaluation.passed === true;
  },
  schedule: { priority: 100, timeoutMs: 300_000, onError: "retry" },
  permissions: { llm: "project", variables: "patch" },
  parameters: [
    { key: "generalEntries", label: "General entry capacity", defaultValue: "24", input: "number", min: 4, max: 128 },
    { key: "domainEntries", label: "Domain entry capacity", defaultValue: "48", input: "number", min: 8, max: 256 },
  ],
  async run({ llm, training, variables }) {
    if (!training) return {};
    const domain = domainFromQuestion(training.case.question);
    const domainVariable = DOMAIN_VARIABLES[domain];
    const generalCapacity = Math.floor(Number(training.parameters.generalEntries || 24));
    const domainCapacity = Math.floor(Number(training.parameters.domainEntries || 48));
    const currentGeneral = parseJson(promptVariable(variables, "memory_general"), []);
    const currentDomain = parseJson(promptVariable(variables, domainVariable), []);
    const correctionChain = training.correctionAttempts ?? [];
    const failedCorrectionCount = correctionChain.filter((attempt) => attempt.passed !== true).length;
    const response = await llm.responses.create({
      input: [
        "Extract bounded procedural memory from one successful official STATE-Bench train-only execution.",
        `Domain: ${domain}`,
        "Use only the visible successful trajectory, tool evidence, and sanitized correction chain.",
        "Capture the smallest rule that separated failed strategies from the successful execution.",
        "Do not retain IDs, names, dates, prices, exact answers, credentials, evaluator language, or held-out facts.",
        "Each entry must contain exactly: intent, mode, phase, trigger, rule, tools, tags, requiredEvidence, blockWhen.",
        "intent is a stable snake_case behavior category. mode is guard only for authorization, authoritative-evidence, mutation-consent, or postcondition invariants; otherwise use advice.",
        "phase is one of any, preflight, decision, mutation, verification.",
        "Put domain procedures in domainEntries. Put only genuine cross-domain guards in generalEntries.",
        "Return exactly one JSON object with arrays domainEntries and generalEntries; at most 3 entries total.",
        `Question and train-only trajectory:\n${normalize(training.case.question).slice(0, 10000)}`,
        `Successful answer:\n${normalize(training.case.actualAnswer).slice(0, 6000)}`,
        `Successful tool calls:\n${JSON.stringify(training.case.toolCalls).slice(0, 16000)}`,
        `Sanitized correction chain:\n${JSON.stringify(correctionEvidence(correctionChain)).slice(0, 20000)}`,
      ].join("\n\n"),
      max_output_tokens: 4000,
    });
    const extracted = await parseOrRepairObjectResponse(llm, response.output_text);
    const domainEntries = (Array.isArray(extracted.domainEntries) ? extracted.domainEntries : [])
      .map((entry) => sanitizeEntry(entry, domain, correctionChain.length, failedCorrectionCount));
    const generalEntries = (Array.isArray(extracted.generalEntries) ? extracted.generalEntries : [])
      .map((entry) => sanitizeEntry(entry, "*", correctionChain.length, failedCorrectionCount));
    if (domainEntries.length + generalEntries.length === 0) throw new Error("memory extractor returned no entries");
    if (domainEntries.length + generalEntries.length > 3) throw new Error("memory extractor returned more than 3 entries");
    const nextDomain = JSON.stringify(mergeEntries(currentDomain, domainEntries, domain, domainCapacity), null, 2);
    const nextGeneral = JSON.stringify(mergeEntries(currentGeneral, generalEntries, "*", generalCapacity), null, 2);
    const currentManifest = promptVariable(variables, "memory_manifest");
    const nextManifest = JSON.stringify({
      schemaVersion: 2,
      releaseId: training.runId,
      domains: ["travel", "customer_support", "shopping_assistant"],
      source: "replay-admitted-training",
      selectorPolicy: "guard-advice-phase-v1",
    }, null, 2);
    return {
      experiences: [{
        summary: `Admit ${domain} atomic memory from a successful execution`,
        rationale: `Source passed after ${correctionChain.length} correction attempts and still requires closed-book replay admission.`,
        patches: [
          { variableName: domainVariable, unifiedDiff: replaceDiff(domainVariable, promptVariable(variables, domainVariable), nextDomain) },
          { variableName: "memory_general", unifiedDiff: replaceDiff("memory_general", promptVariable(variables, "memory_general"), nextGeneral) },
          { variableName: "memory_manifest", unifiedDiff: replaceDiff("memory_manifest", currentManifest, nextManifest) },
        ],
      }],
      metadata: {
        stage: "atomic-memory-v2",
        domain,
        correctionAttempts: correctionChain.length,
        extractedMemoryKeys: [...domainEntries, ...generalEntries].map((entry) => entry.memoryKey),
      },
    };
  },
});
