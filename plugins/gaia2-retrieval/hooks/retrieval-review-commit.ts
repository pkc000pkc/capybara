import { defineHook } from "@capybara-agent/sdk";
export default defineHook({
  name: "retrieval-review-commit", description: "Mirrors a trusted local retrieval snapshot after validating its native page and record bindings.",
  enabled: true, checkpoint: "after_tool", activation: { canonicalNames: ["CapybaraRetrieval__step"] }, trigger({ action, outcome }) { return action?.canonicalName === "CapybaraRetrieval__step" && outcome?.status === "succeeded"; },
  schedule: { priority: 250, timeoutMs: 5000, onError: "block" }, permissions: { variables: "patch", artifacts: "write" },
  run({ variables, outcome, action }) {
    const values = variables.builtin.variables, snap = outcome.result?.retrieval || outcome.retrieval;
    if (!snap || !snap.scope || !Number.isSafeInteger(snap.scope.revision) || snap.scope.revision < 0 || !snap.projection
      || snap.projection.schemaVersion !== "gaia2-retrieval-projection-v1" || !Array.isArray(snap.projection.certificates) || !snap.control) throw new Error("RETRIEVAL_SNAPSHOT_SCHEMA");
    const pages = Array.isArray(snap.pages) ? snap.pages : snap.pages?.items;
    const candidates = Array.isArray(snap.candidates) ? snap.candidates : snap.candidates?.items;
    if (!Array.isArray(pages) || pages.length > 128 || !Array.isArray(candidates) || candidates.length > 512
      || snap.projection.scopeId !== snap.scope.scopeId || snap.projection.criteriaVersion !== snap.scope.criteriaVersion) throw new Error("RETRIEVAL_SNAPSHOT_SCOPE");
    const priorScope = values.gaia2_retrieval_scope;
    if (priorScope.scopeId === snap.scope.scopeId && (snap.scope.revision < priorScope.revision || snap.scope.criteriaVersion < priorScope.criteriaVersion)) throw new Error("RETRIEVAL_SNAPSHOT_ROLLBACK");
    if (priorScope.scopeId && priorScope.scopeId !== snap.scope.scopeId && !["begin", "revise"].includes(snap.control.op)) throw new Error("RETRIEVAL_SNAPSHOT_SCOPE_REPLACEMENT");
    const native = values.gaia2_retrieval_pages.nativeReceipts, seen = new Set();
    const nativeNext = JSON.parse(JSON.stringify(native));
    const projectedPages = JSON.parse(JSON.stringify(pages));
    for (const page of pages) {
      const source = native.find(item => item.actionId === page.actionId);
      if (!source || typeof page.pageRef !== "string" || seen.has(page.pageRef) || !Array.isArray(page.records)
        || page.records.length !== source.records.length || ["resourceKey", "canonicalName", "queryHash", "resultHash", "observedAt", "complete", "beforeViewComplete"].some(key => page[key] !== source[key])) throw new Error("RETRIEVAL_PAGE_SOURCE_BINDING");
      seen.add(page.pageRef);
      const recordIds = new Set();
      const cert = snap.projection.certificates.find(item => item.pageRef === page.pageRef);
      const committed = page.reviewCommitted === true || cert?.reviewCommitted === true;
      const review = (action?.arguments?.reviews || []).find(item => item.pageRef === page.pageRef && item.resultHash === page.resultHash);
      for (let i = 0; i < page.records.length; i++) {
        const row = page.records[i], original = source.records[i];
        const rejected = committed && (row.decision === "reject" || (cert?.rejectRefs || []).includes(row.recordRef));
        if (typeof row.recordRef !== "string" || recordIds.has(row.recordRef) || row.path !== original.path) throw new Error("RETRIEVAL_RECORD_SOURCE_BINDING");
        if (row.body === undefined && rejected) {
          if (original.rejectedVerified !== true || original.recordRef !== row.recordRef || original.rejectedCriteriaVersion !== snap.scope.criteriaVersion) {
            const classified = review?.records?.find(item => item.recordRef === row.recordRef && item.decision === "reject");
            const quotes = classified?.quotes || row.quotes;
            if (typeof original.body !== "string" || !Array.isArray(quotes) || !quotes.length
              || quotes.some(quote => !quote || quote.path !== row.path || typeof quote.quote !== "string" || !quote.quote.length
                || (quote.start !== undefined ? !Number.isSafeInteger(quote.start) || quote.start < 0 || original.body.slice(quote.start, quote.start + quote.quote.length) !== quote.quote
                  : original.body.indexOf(quote.quote) < 0 || original.body.indexOf(quote.quote) !== original.body.lastIndexOf(quote.quote)))) throw new Error("RETRIEVAL_REJECT_PROOF_MISSING");
          }
        } else if (typeof original.body !== "string" || row.body !== original.body) throw new Error("RETRIEVAL_RECORD_SOURCE_BINDING");
        recordIds.add(row.recordRef);
        if (rejected) {
          const saved = nativeNext.find(item => item.actionId === page.actionId).records[i];
          // Preserve the trusted original independently of the active model
          // view, so a changed criterion can restore it without a native replay.
          delete saved.quotes;
          saved.recordRef = row.recordRef; saved.rejectedVerified = true; saved.rejectedCriteriaVersion = snap.scope.criteriaVersion;
          const displayed = projectedPages.find(item => item.pageRef === page.pageRef).records[i];
          delete displayed.body; delete displayed.quotes;
        }
      }
    }
    for (const cert of snap.projection.certificates) {
      const page = pages.find(item => item.pageRef === cert.pageRef && item.actionId === cert.actionId);
      if (!page || cert.scopeId !== snap.scope.scopeId || cert.criteriaVersion !== snap.scope.criteriaVersion || cert.reviewCommitted !== true
        || !Array.isArray(cert.retainedRecords) || !Array.isArray(cert.rejectRefs)
        || ["resourceKey", "canonicalName", "queryHash", "resultHash", "observedAt", "complete", "beforeViewComplete"].some(key => cert[key] !== page[key])) throw new Error("RETRIEVAL_CERTIFICATE_SOURCE_BINDING");
      const retained = new Set(), rejected = new Set(cert.rejectRefs);
      if (rejected.size !== cert.rejectRefs.length) throw new Error("RETRIEVAL_CERTIFICATE_DUPLICATE");
      for (const row of cert.retainedRecords) {
        const original = page.records.find(item => item.recordRef === row.recordRef);
        if (!original || retained.has(row.recordRef) || rejected.has(row.recordRef) || row.path !== original.path || row.body !== original.body || !["keep", "defer"].includes(row.decision)) throw new Error("RETRIEVAL_CERTIFICATE_RETAINED");
        retained.add(row.recordRef);
      }
      if (retained.size + rejected.size !== page.records.length || [...rejected].some(id => !page.records.some(row => row.recordRef === id))) throw new Error("RETRIEVAL_CERTIFICATE_COVERAGE");
      if (rejected.size && (!page.complete || !page.beforeViewComplete)) throw new Error("RETRIEVAL_CERTIFICATE_INCOMPLETE_REJECT");
    }
    const request = { requestId: snap.control.requestId, op: snap.control.op };
    if (typeof request.requestId !== "string" || !request.requestId) throw new Error("RETRIEVAL_CONTROL_IDENTITY");
    const requests = values.gaia2_retrieval_control.requests;
    if (!requests.some(item => item.requestId === request.requestId) && requests.length >= 128) throw new Error("RETRIEVAL_CONTROL_BOUND");
    const nextRequests = requests.some(item => item.requestId === request.requestId) ? requests : [...requests, request];
    const patches = [
      ["gaia2_retrieval_scope", snap.scope], ["gaia2_retrieval_pages", { items: projectedPages, nativeReceipts: nativeNext }],
      ["gaia2_retrieval_candidates", { items: candidates }], ["gaia2_retrieval_coverage", snap.coverage || {}],
      ["gaia2_retrieval_projection", snap.projection], ["gaia2_retrieval_control", { latest: snap.control, requests: nextRequests }],
    ].map(([key, value]) => ({ op: "replace", path: "/builtin/variables/" + key, value }));
    if (snap.scope.criteriaVersion !== values.gaia2_retrieval_scope.criteriaVersion) patches.push({ op: "replace", path: "/builtin/variables/gaia2_retrieval_watch", value: { ...values.gaia2_retrieval_watch, invalidated: false } });
    return { patches, artifacts: [{ title: "Retrieval committed working set", value: { scopeId: snap.scope.scopeId, revision: snap.scope.revision, control: snap.control, pageCount: pages.length, candidateCount: candidates.length } }] };
  },
});
