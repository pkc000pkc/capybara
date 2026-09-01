import { defineHook } from "@capybara-agent/sdk";

const DOMAIN_VARIABLES = {
  travel: "memory_travel",
  customer_support: "memory_customer_support",
  shopping_assistant: "memory_shopping_assistant",
};
const MAX_LOOP_TOKENS = 450;
const MAX_RUN_TOKENS = 1200;
const MAX_SNIPPETS = 2;
const MIN_ADVICE_OVERLAP = 2;
const PHASE_BUDGETS = { preflight: 300, decision: 450, mutation: 250, verification: 350 };
const STOP_TOKENS = new Set(["after", "and", "before", "current", "from", "that", "the", "then", "this", "user", "when", "with", "you"]);
const GUARD_PATTERN = /authori[sz]|ownership|privacy|other account|account owner|unsupported (?:claim|assertion)|explicit (?:consent|confirmation)|before (?:committing|mutation)|do not trust|authoritative (?:record|result|state)|verify .* after/iu;
const MUTATION_INTENT_PATTERN = /\b(?:confirm|go ahead|proceed|do it|apply it|make the change|submit|execute)\b/iu;

function normalize(value) {
  return typeof value === "string" ? value.replaceAll("\r\n", "\n").trim() : "";
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(normalize(value)) ?? fallback;
  } catch {
    return fallback;
  }
}

function stringArray(value) {
  return Array.isArray(value) ? value.map(normalize).filter(Boolean) : [];
}

function tokens(value) {
  return new Set((normalize(value).toLowerCase().replaceAll("_", " ").match(/[a-z0-9]{3,}/gu) ?? [])
    .filter((token) => !STOP_TOKENS.has(token)));
}

function overlap(left, right) {
  let total = 0;
  for (const token of left) if (right.has(token)) total += 1;
  return total;
}

function detectDomain(text) {
  const normalized = normalize(text).toLowerCase();
  if (/\b(flight|booking|hotel|travel|airline|airport|reservation)\b/u.test(normalized)) return "travel";
  if (/\b(order|return|refund|shipment|support|replacement|exchange|warranty)\b/u.test(normalized)) return "customer_support";
  if (/\b(cart|product|shopping|promotion|promo|loyalty|checkout)\b/u.test(normalized)) return "shopping_assistant";
  return "";
}

function detectPhase(messages, query, previous) {
  const last = messages.at(-1);
  if (last?.role === "tool") return "verification";
  if (Number(previous.iteration ?? 0) === 0) return "preflight";
  if (MUTATION_INTENT_PATTERN.test(query)) return "mutation";
  return "decision";
}

function entryText(entry) {
  return [
    entry.intent,
    entry.trigger,
    entry.rule,
    ...stringArray(entry.tools),
    ...stringArray(entry.tags),
    ...stringArray(entry.requiredEvidence),
    ...stringArray(entry.blockWhen),
  ].join(" ");
}

function entryAnchorText(entry) {
  return [
    entry.intent,
    ...stringArray(entry.tools),
    ...stringArray(entry.tags),
    ...stringArray(entry.requiredEvidence),
    ...stringArray(entry.blockWhen),
  ].join(" ");
}

function entryMode(entry) {
  const mode = normalize(entry.mode).toLowerCase();
  if (mode === "guard" || mode === "advice") return mode;
  return GUARD_PATTERN.test(entryText(entry)) ? "guard" : "advice";
}

function entryPhase(entry, mode) {
  const phase = normalize(entry.phase).toLowerCase();
  if (["any", "preflight", "decision", "mutation", "verification"].includes(phase)) return phase;
  const text = entryText(entry).toLowerCase();
  if (/after|post.?mutation|read.?back|resulting state|before claiming/u.test(text)) return "verification";
  if (/confirm|consent|commit|execute|mutation/u.test(text)) return "mutation";
  if (/ownership|authori[sz]|privacy|inspect|retrieve|lookup|before/u.test(text)) return "preflight";
  return mode === "guard" ? "any" : "decision";
}

function estimateTokens(value) {
  return Math.max(1, Math.ceil(normalize(value).length / 4));
}

function patch(path, value) {
  return { op: "replace", path, value };
}

function snippet(item) {
  const label = item.mode === "guard" ? "guard" : "advice";
  const lines = [
    `[${label}:${item.entry.id} domain=${item.entry.domain} phase=${item.phase} score=${item.score}]`,
    `Trigger: ${item.entry.trigger}`,
    `${label === "guard" ? "Mandatory rule" : "Procedure"}: ${item.entry.rule}`,
  ];
  const required = stringArray(item.entry.requiredEvidence);
  const blocked = stringArray(item.entry.blockWhen);
  if (required.length > 0) lines.push(`Required evidence: ${required.join("; ")}`);
  if (blocked.length > 0) lines.push(`Stop when: ${blocked.join("; ")}`);
  return lines.join("\n");
}

export default defineHook({
  name: "memory-runtime-selector",
  description: "Selects one mandatory guard and one phase-relevant advisory memory for the next model loop.",
  enabled: true,
  checkpoint: "after_loop",
  trigger({ variables }) {
    return Boolean(variables?.builtin?.prompts?.memory_runtime_state);
  },
  schedule: { priority: 110, timeoutMs: 5000, onError: "continue" },
  permissions: { variables: "patch", artifacts: "write" },
  run({ variables, messages, loop }) {
    const prompts = variables.builtin.prompts;
    const manifest = parseJson(prompts.memory_manifest, { releaseId: "unknown" });
    const previous = parseJson(prompts.memory_runtime_state, {});
    const usedIds = Array.isArray(previous.usedIds) ? previous.usedIds.filter((id) => typeof id === "string") : [];
    const totalInjectedTokens = Number(previous.totalInjectedTokens ?? 0);
    const phaseInjectedTokens = previous.phaseInjectedTokens && typeof previous.phaseInjectedTokens === "object"
      ? { ...previous.phaseInjectedTokens }
      : {};
    if (loop.terminal) {
      const state = {
        runId: loop.runId,
        iteration: loop.iteration,
        terminal: true,
        releaseId: normalize(manifest.releaseId) || "unknown",
        selectedIds: [],
        selectedGuardIds: [],
        selectedAdviceIds: [],
        usedIds,
        totalInjectedTokens,
        phaseInjectedTokens,
        maxRunTokens: MAX_RUN_TOKENS,
      };
      return {
        patches: [
          patch("/builtin/prompts/memory_runtime_context", ""),
          patch("/builtin/prompts/memory_runtime_state", JSON.stringify(state)),
        ],
        artifacts: [{ title: "Memory prefetch terminal", value: state }],
        metadata: state,
      };
    }

    const query = messages.slice(-8).map((message) => `${message.role ?? "unknown"}: ${normalize(message.content)}`).join("\n");
    const domain = detectDomain(query) || normalize(previous.domain);
    const phase = detectPhase(messages, query, previous);
    const queryTokens = tokens(query);
    const catalog = [
      ...parseJson(prompts.memory_general, []),
      ...(domain ? parseJson(prompts[DOMAIN_VARIABLES[domain]], []) : []),
    ].filter((entry) => entry && typeof entry === "object" && typeof entry.id === "string" && typeof entry.rule === "string");
    const ranked = catalog.map((entry) => {
      const entryDomain = normalize(entry.domain);
      const mode = entryMode(entry);
      const memoryPhase = entryPhase(entry, mode);
      const lexical = overlap(queryTokens, tokens(entryText(entry)));
      const anchorOverlap = overlap(queryTokens, tokens(entryAnchorText(entry)));
      const evidenceCount = Math.max(1, Number(entry.evidenceCount ?? entry.evidence_count ?? 1));
      const confidence = Math.max(0, Math.min(1, Number(entry.confidence ?? 0.5)));
      const score = lexical * 4
        + (memoryPhase === phase ? 8 : 3)
        + (entryDomain === domain ? 6 : 5)
        + (mode === "guard" ? 3 : 0)
        + Math.min(6, Math.round(Math.log2(evidenceCount + 1) * 2))
        + Math.round(confidence * 4);
      return { entry, mode, phase: memoryPhase, score, lexical, anchorOverlap, evidenceCount };
    }).filter((item) => {
      if (usedIds.includes(item.entry.id)) return false;
      if (!["*", domain].includes(normalize(item.entry.domain))) return false;
      if (item.mode !== "guard" && !["any", phase].includes(item.phase)) return false;
      return item.mode === "guard"
        ? item.lexical >= 1
        : item.lexical >= MIN_ADVICE_OVERLAP && item.anchorOverlap >= 1;
    }).sort((left, right) => right.score - left.score || String(left.entry.id).localeCompare(String(right.entry.id)));

    const phaseUsed = Number(phaseInjectedTokens[phase] ?? 0);
    const phaseBudget = PHASE_BUDGETS[phase];
    const remaining = Math.max(0, Math.min(
      MAX_LOOP_TOKENS,
      MAX_RUN_TOKENS - totalInjectedTokens,
      phaseBudget - phaseUsed,
    ));
    const guard = ranked.find((item) => item.mode === "guard");
    const ordered = [
      ...(guard ? [guard] : []),
      ...ranked.filter((item) => item !== guard && item.mode === "advice"),
    ];
    const selected = [];
    let injectedTokens = 0;
    for (const item of ordered) {
      const value = snippet(item);
      const itemTokens = estimateTokens(value);
      if (selected.length >= MAX_SNIPPETS || injectedTokens + itemTokens > remaining) continue;
      selected.push({ ...item, snippet: value, tokens: itemTokens });
      injectedTokens += itemTokens;
    }
    const selectedIds = selected.map((item) => item.entry.id);
    const selectedGuardIds = selected.filter((item) => item.mode === "guard").map((item) => item.entry.id);
    const selectedAdviceIds = selected.filter((item) => item.mode === "advice").map((item) => item.entry.id);
    const nextUsedIds = [...usedIds, ...selectedIds];
    const nextPhaseInjectedTokens = { ...phaseInjectedTokens, [phase]: phaseUsed + injectedTokens };
    const state = {
      runId: loop.runId,
      iteration: loop.iteration,
      terminal: false,
      domain: domain || null,
      phase,
      releaseId: normalize(manifest.releaseId) || "unknown",
      selectedIds,
      selectedGuardIds,
      selectedAdviceIds,
      usedIds: nextUsedIds,
      totalInjectedTokens: totalInjectedTokens + injectedTokens,
      phaseInjectedTokens: nextPhaseInjectedTokens,
      maxRunTokens: MAX_RUN_TOKENS,
      phaseBudget,
      injectedTokens,
      remainingTokens: remaining - injectedTokens,
      eligibleCandidates: ranked.length,
      selections: selected.map((item) => ({
        id: item.entry.id,
        mode: item.mode,
        phase: item.phase,
        score: item.score,
        reason: {
          domain,
          lexicalOverlap: item.lexical,
          anchorOverlap: item.anchorOverlap,
          evidenceCount: item.evidenceCount,
        },
        tokens: item.tokens,
      })),
    };
    return {
      patches: [
        patch("/builtin/prompts/memory_runtime_context", selected.map((item) => item.snippet).join("\n\n")),
        patch("/builtin/prompts/memory_runtime_state", JSON.stringify(state)),
      ],
      artifacts: [{ title: `Memory prefetch loop ${loop.iteration}`, value: state }],
      metadata: state,
    };
  },
});
