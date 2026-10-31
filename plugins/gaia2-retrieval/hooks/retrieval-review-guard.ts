import { defineHook } from "@capybara-agent/sdk";
export default defineHook({
  name: "retrieval-review-guard", description: "Checks local retrieval controls against the current scope and exact visible record quotations.",
  enabled: true, checkpoint: "before_tool", activation: { canonicalNames: ["CapybaraRetrieval__step"] }, trigger({ action }) { return action?.canonicalName === "CapybaraRetrieval__step"; },
  schedule: { priority: 40, timeoutMs: 5000, onError: "block" }, permissions: { artifacts: "write" },
  run({ variables, action }) {
    const values = variables.builtin.variables, args = action.arguments, scope = values.gaia2_retrieval_scope;
    let reason = "Validated local retrieval control; native reads remain separately guarded.";
    let allowed = true;
    const fail = code => { allowed = false; reason = code; };
    if (action.effect !== "read" || action.authoritativeRead !== false || action.resourceKey !== "CapybaraRetrieval") fail("RETRIEVAL_LOCAL_ACTION_BINDING");
    if (!args || !["begin", "review_next", "review_finish", "continue_read", "reopen", "revise", "review_commit", "state_update"].includes(args.op)
      || typeof args.requestId !== "string" || !args.requestId || args.requestId.length > 200) fail("RETRIEVAL_CONTROL_SCHEMA");
    const prior = values.gaia2_retrieval_control.requests.find(item => item.requestId === args.requestId);
    // Internal phase names are not in the Actor tool schema. The trusted
    // adapter signs a distinct before/after frame after the outer admission.
    // Its outer expectedRevision can legitimately predate the committed state.
    const internal = ["review_commit", "state_update"].includes(args.op);
    if (allowed && !prior && !internal && args.op !== "begin") {
      if (args.scopeId !== scope.scopeId || args.criteriaVersion !== scope.criteriaVersion || args.expectedRevision !== scope.revision) fail("RETRIEVAL_STALE_SCOPE_OR_REVISION");
      if (values.gaia2_retrieval_watch.invalidated && args.op !== "revise" && args.op !== "reopen") fail("RETRIEVAL_USER_CRITERIA_REVIEW_REQUIRED");
    }
    if (allowed && args.nextRead !== undefined) {
      const read = args.nextRead;
      if (!read || read.tool !== "Contacts__get_contacts" || ![1, 2, 4].includes(read.pages) || !read.arguments
        || Object.keys(read.arguments).some(key => key !== "offset") || !Number.isSafeInteger(read.arguments.offset) || read.arguments.offset < 0) fail("RETRIEVAL_READ_WHITELIST");
    }
    if (allowed && !prior && !internal && args.reviews !== undefined) {
      if (!Array.isArray(args.reviews) || args.reviews.length > 4) fail("RETRIEVAL_REVIEW_BOUND");
      const seenPages = new Set();
      for (const review of allowed ? args.reviews : []) {
        const page = values.gaia2_retrieval_pages.items.find(item => item.pageRef === review.pageRef);
        if (!page || seenPages.has(review.pageRef) || review.resultHash !== page.resultHash || !Array.isArray(review.records)
          || review.records.length > page.records.length) { fail("RETRIEVAL_REVIEW_COVERAGE"); break; }
        seenPages.add(review.pageRef);
        const seen = new Set();
        for (const entry of review.records) {
          const record = page.records.find(item => item.recordRef === entry.recordRef);
          if (!record || seen.has(entry.recordRef) || !["keep", "reject", "defer"].includes(entry.decision) || !Array.isArray(entry.quotes)) { fail("RETRIEVAL_RECORD_PARTITION"); break; }
          seen.add(entry.recordRef);
          if (entry.decision === "reject" && (!page.complete || !page.beforeViewComplete || page.oldBlocker || !entry.quotes.length)) { fail("RETRIEVAL_UNSEEN_REJECT"); break; }
          const original = values.gaia2_retrieval_pages.nativeReceipts.find(item => item.actionId === page.actionId)?.records.find(item => item.path === record.path);
          const body = typeof record.body === "string" ? record.body : original?.body;
          for (const quote of entry.quotes) {
            if (!quote || quote.path !== record.path || typeof quote.quote !== "string" || !quote.quote.length
              || typeof body !== "string"
              || (quote.start !== undefined ? !Number.isSafeInteger(quote.start) || quote.start < 0 || body.slice(quote.start, quote.start + quote.quote.length) !== quote.quote
                : body.indexOf(quote.quote) < 0 || body.indexOf(quote.quote) !== body.lastIndexOf(quote.quote))) { fail("RETRIEVAL_QUOTE_BINDING"); break; }
          }
        }
        if (!allowed) break;
      }
    }
    return { decision: { action: allowed ? "allow" : "block", reason }, artifacts: [{ title: "Retrieval control admission", value: { requestId: args?.requestId || null, allowed, reason } }] };
  },
});
