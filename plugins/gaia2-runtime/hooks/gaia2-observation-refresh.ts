import { defineHook } from "@capybara-agent/sdk";
function confirmedMutation(item, values) {
  if (item.status !== "confirmed_mutation") return false;
  const evidence = item.mutationReceipt, ref = evidence?.callRef;
  const stored = (values.gaia2_write_state.actions || []).find(entry => entry.actionId === item.actionId);
  if (item.evidenceKind !== "mutation_receipt" || evidence?.schemaVersion !== "gaia2-mutation-evidence-v1"
    || evidence.kind !== "mutation_confirmed" || evidence.confirmation !== "confirmed_applied"
    || evidence.resourceKey !== item.resourceKey || !stored || stored.status !== "succeeded"
    || stored.mutationKey !== item.queryHash || stored.resourceKey !== item.resourceKey || stored.resultHash !== item.resultHash
    || JSON.stringify(stored.mutationReceipt) !== JSON.stringify(evidence)
    || !ref || ref.actionId !== item.actionId || ["canonicalName", "queryHash", "resultHash", "observedAt"].some(key => ref[key] !== item[key])
    || item.outcomeStatus !== "succeeded" || item.complete !== true || item.authoritativeRead !== false) throw new Error("MUTATION_RECEIPT_LEDGER_BINDING");
  return true;
}

function filteredViewIsBound(item, view, values, messages) {
  const scope = values.gaia2_retrieval_scope, projection = values.gaia2_retrieval_projection;
  if (!scope || !projection || values.gaia2_retrieval_watch?.invalidated || scope.status === "needs_reconcile" || projection.scopeId !== scope.scopeId || projection.criteriaVersion !== scope.criteriaVersion) return false;
  if (!["observed", "duplicate"].includes(item.status) || item.viewComplete === false && item.presentation !== "retrieval_filtered") return false;
  const cert = (projection.certificates || []).find(cert => cert.actionId === item.actionId);
  if (!cert || cert.reviewCommitted !== true || cert.complete !== true || cert.beforeViewComplete !== true || cert.oldBlocker === true || !Array.isArray(cert.rejectRefs) || !cert.rejectRefs.length) return false;
  if (cert.scopeId !== scope.scopeId || cert.criteriaVersion !== scope.criteriaVersion || ["resourceKey", "canonicalName", "queryHash", "resultHash", "observedAt"].some(key => cert[key] !== item[key] || cert[key] !== view[key])) return false;
  const message = (messages || []).find(message => message.observation?.actionId === item.actionId);
  try {
    const body = JSON.parse(message.content), retained = cert.retainedRecords;
    return Array.isArray(retained) && Array.isArray(body.contacts) && body.retrievalProjectionHash === cert.projectionHash
      && retained.every(row => ["keep", "defer"].includes(row.decision) && typeof row.body === "string" && body.contacts.includes(row.body));
  } catch { return false; }
}

export default defineHook({
  name: "gaia2-observation-refresh", description: "Refreshes ARE-second TTL and trusted provider-view incompleteness before model selection.",
  enabled: true, checkpoint: "before_model", trigger() { return true; },
  schedule: { priority: 190, timeoutMs: 3000, onError: "block" },
  permissions: { variables: "patch", artifacts: "write" },
  run({ variables, messages, clock }) {
    const values = variables.builtin.variables, old = values.gaia2_observation_state, noise = values.gaia2_noise_state;
    const ttl = Number(values.gaia2_runtime_policy.stale_after_ms) / 1000;
    const views = new Map();
    for (const message of messages || []) {
      if (message.role !== "tool" || !message.observation) continue;
      const view = message.observation;
      if (typeof view.actionId !== "string") continue;
      const previous = views.get(view.actionId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(view)) throw new Error("OBSERVATION_VIEW_CONFLICT");
      views.set(view.actionId, view);
    }
    const changed = [];
    const all = (old.observations || []).map(item => {
      // All old tool messages remain in Hook history. A later exact-query
      // verification is terminal for that old observation; never reopen it.
      if (["verified_by_fresh_read", "superseded_by_fresh_read", "verified_absent_after_delete"].includes(item.status)) return item;
      const view = views.get(item.actionId);
      if (view && (view.resourceKey !== item.resourceKey || view.canonicalName !== item.canonicalName || view.queryHash !== item.queryHash || view.resultHash !== item.resultHash || view.observedAt !== item.observedAt || view.complete !== item.complete)) throw new Error("OBSERVATION_VIEW_BINDING");
      // Validate identity before honoring the historical receipt terminal.
      // Provider visibility is not native execution or current-state truth.
      if (confirmedMutation(item, values)) return item;
      let next = item;
      if (view && view.viewComplete === false && !["failed", "conflicting"].includes(item.status)) next = filteredViewIsBound(item, view, values, messages)
        ? { ...next, viewComplete: false, presentation: "retrieval_filtered", viewIncompleteReason: "hidden" }
        : { ...next, viewComplete: false, presentation: view.viewIncompleteReason || "hidden", viewIncompleteReason: view.viewIncompleteReason || "hidden" };
      if (view?.viewComplete === true) {
        next = { ...next, viewComplete: true, presentation: "visible" };
        delete next.viewIncompleteReason;
      }
      // Presentation restoration never changes native collection time or truth.
      const expired = Number.isFinite(ttl) && ttl >= 0 && Number.isFinite(item.observedAt) && clock.now - item.observedAt > ttl;
      next = { ...next, freshness: expired ? "stale" : "fresh" };
      if (expired && ["observed", "duplicate"].includes(next.status)) next = { ...next, status: "stale", staleAt: clock.now };
      if (next !== item) changed.push({ observationId: item.observationId, previousStatus: item.status, status: next.status });
      return next;
    });
    const state = { ...old, observations: all, provenance: all.map(item => item.provenance), stale_ids: all.filter(item => item.status === "stale").map(item => item.observationId), unverified_ids: all.filter(item => ["incomplete", "failed"].includes(item.status)).map(item => item.observationId), conflict_ids: all.filter(item => item.status === "conflicting").map(item => item.observationId) };
    state.schemaVersion = "gaia2-observation-state-v2";
    state.visibility_ids = all.filter(item => !["verified_by_fresh_read", "superseded_by_fresh_read", "verified_absent_after_delete", "confirmed_mutation"].includes(item.status) && item.viewComplete === false && item.presentation !== "retrieval_filtered").map(item => item.observationId);
    const progress = values.gaia2_progress_state;
    const context = "Advisory evidence diagnostics: " + [...state.unverified_ids, ...state.stale_ids, ...state.conflict_ids].slice(-12).join(", ") + ". Hidden/truncated views: " + state.visibility_ids.slice(-12).join(", ") + ". These flags do not veto actions or prescribe queries; decide whether more evidence is needed from the current request and actual native results. Presentation changes never refresh native time or query coverage.";
    const recovery = progress.recommendation !== "continue" ? " Observable no-progress count: " + progress.consecutive_no_progress + ". This is diagnostic, not a stop or replan instruction." : "";
    return { patches: [{ op: "replace", path: "/builtin/variables/gaia2_observation_state", value: state }, { op: "replace", path: "/builtin/variables/gaia2_noise_state", value: { ...noise, conflicts: state.conflict_ids, quarantined: [...state.unverified_ids, ...state.stale_ids, ...state.conflict_ids] } }, ...(changed.length || recovery ? [{ op: "replace", path: "/builtin/variables/gaia2_runtime_context", value: context + recovery }] : [])], artifacts: [{ title: "GAIA2 evidence freshness refresh", value: { clockNow: clock.now, ttlSeconds: ttl, changed, recommendation: progress.recommendation } }] };
  },
});
