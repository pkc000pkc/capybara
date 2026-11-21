import { defineHook } from "@capybara-agent/sdk";

const instruction = `You are the system context organization stage.
Use only the project context projection and runtime cache supplied as data.
Return one JSON object: {"contextObservations":[],"contextProposals":[]}.
Use contextObservations to extract durable or session information from the cache. Each observation needs a stable id, scope, source, rawArtifactId and normalizedContent.
Proposals may reference a new observation with sourceObservationId, or an existing candidateId from the same-scope projection.
Preserve separate evidence sources; do not resolve disagreements or invent facts.
Use project scope only. Every proposal must copy the supplied documentId, baseRevision, projectionId, projectionHash and candidateId.
Allowed operations: add_entry, replace_body, append_evidence, mark_status.
If no safe update is supported, return an empty array.`;

function parseJson(text) {
  const trimmed = String(text || "").trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const value = JSON.parse(unfenced);
  if (!value || typeof value !== "object" || !Array.isArray(value.contextProposals)) {
    throw new Error("context organization output must contain contextProposals");
  }
  return value;
}

export default defineHook({
  name: "context-organization",
  description: "Generate governed project-context proposals from retained project candidates.",
  enabled: true,
  checkpoint: "after_loop",
  trigger({ loop, status, context, variables }) {
    const cacheReady = Boolean(variables.builtin.cache.summary)
      || variables.builtin.cache.messages.length >= 8;
    return loop.terminal === true
      && status.run.status === "completed"
      && Boolean(context?.project?.markdown)
      && (cacheReady || /状态：(pending|conflict)/u.test(context.project.markdown));
  },
  schedule: { priority: 7000, timeoutMs: 120000, onError: "continue" },
  permissions: { llm: "project" },
  async run({ llm, context, variables }) {
    if (!llm) return { contextProposals: [] };
    const response = await llm.responses.create({
      model: llm.defaultModel,
      max_output_tokens: 1200,
      input: [
        { role: "system", content: instruction },
        { role: "user", content: JSON.stringify({
          project: context.project,
          cache: variables.builtin.cache,
        }) },
      ],
    });
    const value = parseJson(response.output_text);
    return {
      contextObservations: Array.isArray(value.contextObservations) ? value.contextObservations : [],
      contextProposals: value.contextProposals.map((proposal) => ({
        ...proposal,
        scope: "project",
      })),
      metadata: {
        observationCount: Array.isArray(value.contextObservations) ? value.contextObservations.length : 0,
        proposalCount: value.contextProposals.length,
      },
    };
  },
});
