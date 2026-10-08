import { defineHook } from "@capybara-agent/sdk";

export default defineHook({
  name: "gaia2-correction",
  description: "Forms an answer-blind correction strategy from observable execution defects; a fresh replay must verify it before admission.",
  enabled: true,
  checkpoint: "after_evaluation",
  trigger({ training }) { return training?.phase === "training" && training?.evaluation?.passed === false && training?.summary?.defects?.length > 0; },
  schedule: { priority: 210, timeoutMs: 300000, onError: "retry" },
  permissions: { llm: "project" },
  async run({ llm, training }) {
    // The trusted boundary supplies only validated method enums, counts and
    // SHA commitments, never task text or a later USER message. Free-form
    // model advice cannot be injected into a fresh scenario.
    const defects = training.summary.defects;
    if (!Array.isArray(defects) || defects.length === 0) throw new Error("no authorized observable defect");
    const response = await llm.responses.create({ input: [
      "Select exactly one process defect from the authorized list. You are not given the task, answer, hidden evaluator or environment state.",
      "Return exactly one JSON object and no extra text. Its only keys must be schemaVersion, defectCode, procedureIds, verificationIds, evidenceHash.",
      "schemaVersion must be gaia2-correction-plan-v1. Copy the defectCode, complete procedureIds, complete verificationIds and evidenceHash of one authorized item exactly. Do not invent fields or methods.",
      "The trusted caller, not this model, will render fixed method instructions. No task-specific values may enter replay.",
      `Authorized observable defects: ${JSON.stringify(defects)}`,
    ].join("\n\n"), max_output_tokens: 700 });
    if (typeof response.output_text !== "string" || response.output_text.length > 8192) throw new Error("invalid bounded correction response");
    const text = response.output_text.trim();
    // This flat five-key schema must not silently accept duplicate keys that
    // JSON.parse would otherwise overwrite, or nested objects carrying text.
    if ((text.match(/"(?:[^"\\]|\\.)*"\s*:/g) ?? []).length !== 5) throw new Error("duplicate or nested correction keys");
    const candidate = JSON.parse(text);
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || Object.keys(candidate).sort().join(",") !== "defectCode,evidenceHash,procedureIds,schemaVersion,verificationIds") throw new Error("correction schema rejected");
    const authorized = defects.find(item => item.defectCode === candidate.defectCode && item.evidenceHash === candidate.evidenceHash);
    if (!authorized || candidate.schemaVersion !== "gaia2-correction-plan-v1"
      || JSON.stringify(candidate.procedureIds) !== JSON.stringify(authorized.procedureIds)
      || JSON.stringify(candidate.verificationIds) !== JSON.stringify(authorized.verificationIds)) throw new Error("unproven correction methods rejected");
    return { correction: { ...candidate, freshReplayRequired: true, attemptCountDelta: 0 },
      metadata: { answerBlind: true, artifactOnly: true, attemptCountDelta: 0 } };
  },
});
