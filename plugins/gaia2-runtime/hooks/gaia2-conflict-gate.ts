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
  name: "gaia2-conflict-gate", description: "Reports evidence diagnostics without approving or vetoing the Actor's business decisions.",
  enabled: true, checkpoint: "before_tool", activation: { excludeCanonicalNames: ["CapybaraEvidence__read", "CapybaraTemporal__watch", "CapybaraTaskContract__commit", "CapybaraTaskContract__review"] }, trigger({ action }) { return Boolean(action) && !["CapybaraEvidence__read", "CapybaraTemporal__watch", "CapybaraTaskContract__commit", "CapybaraTaskContract__review"].includes(action.canonicalName); },
  schedule: { priority: 220, timeoutMs: 3000, onError: "block" },
  permissions: { variables: "patch", artifacts: "write" },
  run({ variables, action, messages, clock }) {
    const values = variables.builtin.variables, old = values.gaia2_observation_state || {}, noise = values.gaia2_noise_state;
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
    const observations = (old.observations || []).map(item => {
      if (["verified_by_fresh_read", "superseded_by_fresh_read", "verified_absent_after_delete"].includes(item.status)) return item;
      const view = views.get(item.actionId);
      if (view && (view.resourceKey !== item.resourceKey || view.canonicalName !== item.canonicalName || view.queryHash !== item.queryHash || view.resultHash !== item.resultHash || view.observedAt !== item.observedAt || view.complete !== item.complete)) throw new Error("OBSERVATION_VIEW_BINDING");
      if (confirmedMutation(item, values)) return item;
      let next = item;
      if (view && view.viewComplete === false && !["failed", "conflicting"].includes(item.status)) next = filteredViewIsBound(item, view, values, messages)
        ? { ...next, viewComplete: false, presentation: "retrieval_filtered", viewIncompleteReason: "hidden" }
        : { ...next, viewComplete: false, presentation: view.viewIncompleteReason || "hidden", viewIncompleteReason: view.viewIncompleteReason || "hidden" };
      if (view?.viewComplete === true) {
        next = { ...next, viewComplete: true, presentation: "visible" };
        delete next.viewIncompleteReason;
      }
      const expired = Number.isFinite(ttl) && ttl >= 0 && Number.isFinite(item.observedAt) && clock.now - item.observedAt > ttl;
      next = { ...next, freshness: expired ? "stale" : "fresh" };
      if (expired && ["observed", "duplicate"].includes(next.status)) next = { ...next, status: "stale", staleAt: clock.now };
      return next;
    });
    const state = { ...old, schemaVersion: "gaia2-observation-state-v2", observations, provenance: observations.map(item => item.provenance),
      stale_ids: observations.filter(item => item.status === "stale").map(item => item.observationId),
      unverified_ids: observations.filter(item => ["incomplete", "failed"].includes(item.status)).map(item => item.observationId),
      conflict_ids: observations.filter(item => item.status === "conflicting").map(item => item.observationId),
      visibility_ids: observations.filter(item => !["verified_by_fresh_read", "superseded_by_fresh_read", "verified_absent_after_delete", "confirmed_mutation"].includes(item.status) && item.viewComplete === false && item.presentation !== "retrieval_filtered").map(item => item.observationId) };
    const diagnosticIds = [...new Set([...state.unverified_ids, ...state.stale_ids, ...state.conflict_ids, ...state.visibility_ids])];
    const oldLedger = noise.candidateLedger;
    const candidateLedger = oldLedger?.schemaVersion === "gaia2-noise-candidate-ledger-v1" ? (() => {
      const byId = new Map(observations.map(item => [item.observationId, item]));
      const move = item => {
        const row = byId.get(item.observationId);
        return row && ["failed", "incomplete", "stale", "conflicting"].includes(row.status)
          ? { ...item, status: "quarantined", quarantineReason: row.status } : item;
      };
      const retained = (oldLedger.retained || []).map(move).filter(item => item.status === "retained").slice(-256);
      const candidates = (oldLedger.candidates || []).map(move).filter(item => item.status === "candidate" || item.status === "reviewed").slice(-256);
      const quarantined = [...(oldLedger.quarantined || []), ...(oldLedger.retained || []).map(move).filter(item => item.status === "quarantined"), ...(oldLedger.candidates || []).map(move).filter(item => item.status === "quarantined")]
        .reduce((acc, item) => acc.some(existing => existing.candidateId === item.candidateId) ? acc : [...acc, item], []).slice(-256);
      return { ...oldLedger, retained, candidates, quarantined };
    })() : oldLedger;
    // Runtime checks provenance, not business sufficiency. No query or recovery
    // plan is synthesized and no TTL/presentation/progress diagnostic vetoes a call.
    const idle = { schemaVersion: "gaia2-conflict-state-v1", status: "idle", userRef: null, blockedAction: null, blockerIds: [], requests: [], reason: null };
    return { decision: { action: "allow", reason: "Evidence diagnostics are advisory; the Actor owns business judgment." },
      patches: [
        { op: "replace", path: "/builtin/variables/gaia2_observation_state", value: state },
        { op: "replace", path: "/builtin/variables/gaia2_noise_state", value: { ...noise, conflicts: state.conflict_ids, quarantined: [...state.unverified_ids, ...state.stale_ids, ...state.conflict_ids], ...(candidateLedger ? { candidateLedger } : {}) } },
        { op: "replace", path: "/builtin/variables/gaia2_conflict_state", value: idle },
        { op: "replace", path: "/builtin/variables/gaia2_conflict_context", value: "" },
      ],
      artifacts: [{ title: "GAIA2 advisory evidence diagnostics", value: { actionId: action.id, diagnosticIds: diagnosticIds.slice(-64), ttlSeconds: ttl, businessDecision: "actor_owned", automaticQueries: 0, enforced: false } }] };
  },
});
