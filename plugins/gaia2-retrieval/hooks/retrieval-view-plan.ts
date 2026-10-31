import { defineHook } from "@capybara-agent/sdk";
export default defineHook({
  name: "retrieval-view-plan", description: "Publishes bounded working-set status; the trusted bridge, not this Hook, applies the bound projection.",
  enabled: true, checkpoint: "before_model", trigger() { return true; }, schedule: { priority: 30, timeoutMs: 5000, onError: "block" }, permissions: { variables: "patch", artifacts: "write" },
  run({ variables }) {
    const values = variables.builtin.variables, scope = values.gaia2_retrieval_scope, candidates = values.gaia2_retrieval_candidates.items;
    const context = JSON.stringify({ scopeId: scope.scopeId, criteriaVersion: scope.criteriaVersion, revision: scope.revision,
      status: scope.status, criteriaReviewRequired: values.gaia2_retrieval_watch.invalidated,
      keepCount: candidates.filter(item => item.decision === "keep").length, deferCount: candidates.filter(item => item.decision === "defer").length,
      coverage: values.gaia2_retrieval_coverage, note: "Exact retained records are in the bound tool-result working set; this status is not authoritative read-back." });
    if (context.length > 16384) throw new Error("RETRIEVAL_CONTEXT_BOUND");
    return { patches: [{ op: "replace", path: "/builtin/variables/gaia2_retrieval_context", value: context }],
      artifacts: [{ title: "Retrieval presentation plan", value: { scopeId: scope.scopeId, criteriaVersion: scope.criteriaVersion, certificateCount: values.gaia2_retrieval_projection.certificates.length } }] };
  },
});
