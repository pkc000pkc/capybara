import { defineHook } from "@capybara-agent/sdk";
export default defineHook({
  name: "retrieval-finalize", description: "Archives task-local retrieval totals without grading or changing official results.",
  enabled: true, checkpoint: "attempt_end", trigger() { return true; }, schedule: { priority: 260, timeoutMs: 5000, onError: "block" }, permissions: { artifacts: "write" },
  run({ variables }) {
    const values = variables.builtin.variables;
    return { artifacts: [{ title: "Retrieval final evidence index", value: { scope: values.gaia2_retrieval_scope,
      coverage: values.gaia2_retrieval_coverage, candidateCount: values.gaia2_retrieval_candidates.items.length,
      registeredNativePages: values.gaia2_retrieval_pages.nativeReceipts.length,
      reviewedCertificates: values.gaia2_retrieval_projection.certificates.length, officialResultModified: false } }] };
  },
});
