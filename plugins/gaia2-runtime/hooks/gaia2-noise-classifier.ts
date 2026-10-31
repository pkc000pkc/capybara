import { defineHook } from "@capybara-agent/sdk";
function argumentBytes(text) {
  let bytes = 0;
  for (const char of text) { const point = char.codePointAt(0); bytes += point <= 127 ? 1 : point <= 2047 ? 2 : point <= 65535 ? 3 : 4; }
  return bytes;
}
function entityEvidence(values, action, outcome, observedAt, loop) {
  const evidence = outcome.semanticEvidence;
  if (evidence === undefined) return null;
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const text = value => typeof value === "string" && value.length > 0 && value.length <= 256;
  const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const sameEntity = (left, right) => ["resourceKey", "entityType", "entityId"].every(key => left?.[key] === right?.[key]);
  const sameRef = (left, right) => ["receiptId", "actionId", "canonicalName", "queryHash", "resultHash", "observedAt"].every(key => left?.[key] === right?.[key]);
  const ref = evidence.callRef, entity = evidence.entityRef, contract = evidence.contractRef, proof = evidence.nativeProof;
  if (!object(evidence) || evidence.schemaVersion !== "gaia2-entity-evidence-v1"
    || !["delete_succeeded", "entity_absent", "entity_present"].includes(evidence.kind)
    || evidence.executionId !== loop?.runId || !text(evidence.sessionId)
    || !object(entity) || entity.resourceKey !== action.resourceKey || !["CalendarEvent", "Contact"].includes(entity.entityType) || !text(entity.entityId)
    || !object(ref) || ref.actionId !== action.id || ref.canonicalName !== action.canonicalName
    || ref.queryHash !== action.mutationKey || ref.resultHash !== outcome.resultHash || ref.observedAt !== observedAt
    || !hash(ref.queryHash) || !hash(ref.resultHash) || !object(contract) || !text(contract.id)
    || ["sourceSha256", "callableSha256", "toolUtilsSha256", "typesSha256", "typeUtilsSha256"].some(key => !hash(contract[key]))
    || !object(proof) || JSON.stringify(evidence).length > 12000) throw new Error("ENTITY_EVIDENCE_BINDING");
  const calendar = entity.entityType === "CalendarEvent", parts = action.canonicalName.split("__");
  if (contract.id !== (calendar ? "are-1.2.0-calendar-entity-v1" : "are-1.2.0-contacts-entity-v1")
    || contract.sourceSha256 !== (calendar ? "62ffa557068dd1e5983758f8f25423cb6e81a48f4191edace98a2e0173881c7c" : "188862e4ba05bf06895321399c2dd1e54ef9a29fe9dc2573679abb98e5bcf47f")
    || !(calendar ? ["Calendar", "CalendarApp", "CalendarV2"] : ["Contacts", "ContactsApp"]).includes(parts[0])
    || parts[1] !== (evidence.kind === "delete_succeeded" ? calendar ? "delete_calendar_event" : "delete_contact" : calendar ? "get_calendar_event" : "get_contact")
    || !object(action.arguments) || Object.keys(action.arguments).length !== 1
    || action.arguments[calendar ? "event_id" : "contact_id"] !== entity.entityId
    || evidence.kind === "entity_absent" && (proof.branchLine !== (calendar ? 279 : 221) || proof.exceptionType !== (calendar ? "ValueError" : "KeyError"))) throw new Error("ENTITY_NATIVE_CONTRACT");
  const prior = values.gaia2_entity_state || { schemaVersion: "gaia2-entity-state-v1", enabled: false, records: [] };
  if (prior.schemaVersion !== "gaia2-entity-state-v1" || !Array.isArray(prior.records)) throw new Error("ENTITY_STATE_SCHEMA");
  const records = prior.records, duplicate = records.find(item => item.callRef?.actionId === action.id);
  if (duplicate && JSON.stringify(duplicate) !== JSON.stringify(evidence)) throw new Error("ENTITY_EVIDENCE_REPLAY_CONFLICT");
  const last = [...records].reverse().find(item => sameEntity(item.entityRef, entity));
  if (evidence.kind === "delete_succeeded") {
    const deleted = evidence.deleteReceiptRef;
    if (action.effect !== "write" || outcome.status !== "succeeded" || outcome.complete !== true
      || proof.kind !== "returned_delete" || proof.exceptionType !== null || proof.branchLine !== null
      || !object(deleted) || !hash(deleted.receiptId)
      || ["actionId", "canonicalName", "queryHash", "resultHash", "observedAt"].some(key => deleted[key] !== ref[key])) throw new Error("ENTITY_DELETE_RECEIPT");
  } else if (evidence.kind === "entity_absent") {
    const deleted = evidence.deleteReceiptRef;
    const source = [...records].reverse().find(item => item.kind === "delete_succeeded" && sameEntity(item.entityRef, entity)
      && sameRef(item.deleteReceiptRef, deleted));
    if (action.effect !== "read" || action.authoritativeRead !== true || outcome.status !== "failed_before_execution"
      || outcome.complete !== true || proof.kind !== "missing_branch" || !["ValueError", "KeyError"].includes(proof.exceptionType)
      || outcome.errorType !== proof.exceptionType || !Number.isSafeInteger(proof.branchLine) || proof.branchLine < 1
      || !source || source.invalidatedBy || source.executionId !== evidence.executionId || source.sessionId !== evidence.sessionId
      || source.callRef.observedAt > observedAt || !last || last.kind === "entity_present"
      || last.invalidatedBy || !sameRef(last.deleteReceiptRef, deleted)) throw new Error("ENTITY_ABSENCE_DELETE_BINDING");
  } else if (action.effect !== "read" || action.authoritativeRead !== true || outcome.status !== "succeeded" || outcome.complete !== true
    || proof.kind !== "returned_entity" || proof.exceptionType !== null || proof.branchLine !== null || evidence.deleteReceiptRef !== null) throw new Error("ENTITY_PRESENT_BINDING");
  const kept = !duplicate && ["delete_succeeded", "entity_present"].includes(evidence.kind)
    ? records.map(item => sameEntity(item.entityRef, entity) && !item.invalidatedBy ? { ...item, invalidatedBy: { actionId: action.id, observedAt, reason: evidence.kind === "entity_present" ? "entity_present" : "new_delete_generation" } } : item) : records;
  return { evidence, state: { schemaVersion: "gaia2-entity-state-v1", enabled: true, records: duplicate ? records : [...kept, evidence].slice(-64) } };
}
function mutationEvidence(action, outcome, observedAt, loop) {
  const evidence = outcome.mutationEvidence;
  if (evidence === undefined) return null;
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const ref = evidence?.callRef, contract = evidence?.contractRef, proof = evidence?.nativeProof;
  const contracts = {
    "are-1.2.0-calendar-mutation-v1": { source: "62ffa557068dd1e5983758f8f25423cb6e81a48f4191edace98a2e0173881c7c", apps: ["Calendar", "CalendarApp", "CalendarV2"], methods: ["add_calendar_event", "delete_calendar_event"] },
    "are-1.2.0-contacts-mutation-v1": { source: "188862e4ba05bf06895321399c2dd1e54ef9a29fe9dc2573679abb98e5bcf47f", apps: ["Contacts", "ContactsApp"], methods: ["add_new_contact", "edit_contact", "delete_contact"] },
    "are-1.2.0-email-mutation-v1": { source: "0da4b444925cef30e6945bff6c0d135d23fddc1c9c54c208acf889d606f24a57", apps: ["EmailClientV2"], methods: ["send_email", "reply_to_email"] },
  };
  const accepted = contracts[contract?.id], [app, method] = action.canonicalName.split("__");
  if (!object(evidence) || evidence.schemaVersion !== "gaia2-mutation-evidence-v1" || evidence.kind !== "mutation_confirmed"
    || evidence.confirmation !== "confirmed_applied" || !hash(evidence.receiptId) || evidence.executionId !== loop?.runId
    || typeof evidence.sessionId !== "string" || !evidence.sessionId || evidence.sessionId.length > 256
    || evidence.resourceKey !== action.resourceKey || action.effect !== "write" || action.authoritativeRead !== false
    || outcome.status !== "succeeded" || outcome.complete !== true || outcome.executed !== true
    || !object(ref) || ref.actionId !== action.id || ref.canonicalName !== action.canonicalName
    || ref.queryHash !== action.mutationKey || ref.resultHash !== outcome.resultHash || ref.observedAt !== observedAt
    || !hash(ref.queryHash) || !hash(ref.resultHash) || !object(contract) || !accepted
    || contract.sourceSha256 !== accepted.source || !accepted.apps.includes(app) || !accepted.methods.includes(method)
    || ["callableSha256", "toolUtilsSha256", "typesSha256", "typeUtilsSha256"].some(key => !hash(contract[key]))
    || !object(proof) || proof.kind !== "returned_mutation" || proof.exceptionType !== null || proof.executed !== true || proof.complete !== true
    || JSON.stringify(evidence).length > 12000) throw new Error("MUTATION_EVIDENCE_BINDING");
  return evidence;
}
export default defineHook({

  name: "gaia2-noise-classifier", description: "Records exact-query evidence, duplicate freshness, explicit uncertainty and confirmed read-back without keyword truth inference.",
  enabled: true, checkpoint: "after_tool", activation: { excludeCanonicalNames: ["CapybaraEvidence__read", "CapybaraRetrieval__step", "CapybaraTemporal__watch", "CapybaraTaskContract__commit", "CapybaraTaskContract__review"] }, trigger({ action }) { return Boolean(action) && !["CapybaraEvidence__read", "CapybaraRetrieval__step", "CapybaraTemporal__watch", "CapybaraTaskContract__commit", "CapybaraTaskContract__review"].includes(action.canonicalName); },
  schedule: { priority: 190, timeoutMs: 3000, onError: "block" },
  permissions: { variables: "patch", artifacts: "write" },
  run({ variables, action, outcome, clock, messages, loop }) {
    const values = variables.builtin.variables, old = values.gaia2_observation_state, noise = values.gaia2_noise_state;
    const existing = old.observations || [], active = item => !["verified_by_fresh_read", "superseded_by_fresh_read", "verified_absent_after_delete", "confirmed_mutation"].includes(item.status);
    const queryHash = typeof action.mutationKey === "string" && action.mutationKey ? action.mutationKey : null;
    const sourceViews = (messages || []).filter(message => message.role === "tool" && message.observation && message.observation.actionId === action.id).map(message => message.observation);
    const sourceView = sourceViews[0];
    if (sourceViews.some(view => JSON.stringify(view) !== JSON.stringify(sourceView))) throw new Error("OBSERVATION_VIEW_CONFLICT");
    if (sourceView && (sourceView.resourceKey !== action.resourceKey || sourceView.canonicalName !== action.canonicalName || sourceView.queryHash !== queryHash || sourceView.resultHash !== outcome.resultHash || sourceView.complete !== (outcome.complete === true) || !Number.isFinite(sourceView.observedAt) || sourceView.observedAt < 0 || sourceView.observedAt > clock.now)) throw new Error("OBSERVATION_RETURN_BINDING");
    // ARE keeps advancing between native return and Hook IPC. Preserve the
    // trusted native collection time, not the later Hook processing time.
    const observedAt = sourceView ? sourceView.observedAt : clock.now;
    const mutation = mutationEvidence(action, outcome, observedAt, loop);
    let semantic = entityEvidence(values, action, outcome, observedAt, loop);
    if (!semantic && values.gaia2_entity_state?.enabled === true && ["write", "unknown"].includes(action.effect) && outcome.executed !== false) {
      const records = values.gaia2_entity_state.records.map(item => item.entityRef.resourceKey === action.resourceKey && !item.invalidatedBy
        ? { ...item, invalidatedBy: { actionId: action.id, observedAt, reason: outcome.status === "unknown" ? "unknown_write" : "unmapped_native_write" } } : item);
      semantic = { evidence: null, state: { ...values.gaia2_entity_state, records } };
    }
    const sameQuery = item => queryHash !== null && item.queryHash === queryHash && item.canonicalName === action.canonicalName && item.resourceKey === action.resourceKey;
    const group = existing.filter(sameQuery), prior = [...group].reverse().find(item => item.authoritativeRead === true && item.outcomeStatus === "succeeded" && item.complete === true);
    const viewComplete = sourceView ? sourceView.viewComplete : outcome.viewComplete !== false;
    const full = outcome.status === "succeeded" && outcome.complete === true;
    const fresh = action.effect === "read" && action.authoritativeRead === true && full && viewComplete && queryHash !== null;
    const duplicateOf = full && group.find(item => item.outcomeStatus === "succeeded" && item.complete === true && item.resultHash === outcome.resultHash);
    const duplicateAction = existing.some(item => item.actionId === action.id);
    let all = [...existing], status = outcome.status !== "succeeded" ? "failed" : !full ? "incomplete" : duplicateOf ? "duplicate" : "observed";
    let resolved = false;
    const changedFrom = fresh && prior && prior.resultHash !== outcome.resultHash ? prior.actionId : null;
    if (semantic?.evidence?.kind === "entity_absent") { status = "verified_absent_after_delete"; resolved = true; }
    if (mutation) status = "confirmed_mutation";
    if (fresh && !duplicateAction) {
      resolved = group.some(item => active(item) && ["failed", "incomplete", "stale", "conflicting"].includes(item.status));
      // The latest complete native read stands on its own. Changed content is
      // a diagnostic, not a demand for a redundant second confirmation read.
      all = all.map(item => sameQuery(item) && active(item) ? { ...item, status: ["failed", "incomplete", "stale", "conflicting"].includes(item.status) ? "verified_by_fresh_read" : "superseded_by_fresh_read", verifiedBy: action.id, verifiedAt: clock.now } : item);
    }
    const queryArguments = action.effect === "read" && action.authoritativeRead === true && action.arguments
      && typeof action.arguments === "object" && !Array.isArray(action.arguments)
      && argumentBytes(JSON.stringify(action.arguments)) <= 4096 ? JSON.parse(JSON.stringify(action.arguments)) : undefined;
    const record = { observationId: "obs-" + action.id, actionId: action.id, resourceKey: action.resourceKey, canonicalName: action.canonicalName, queryHash, resultHash: outcome.resultHash || null, fingerprint: outcome.resultHash || action.id, status, outcomeStatus: outcome.status, complete: outcome.complete === true, viewComplete, observedAt, authoritativeRead: action.authoritativeRead === true && action.effect === "read", ...(semantic?.evidence ? { semanticEvidence: semantic.evidence } : {}), ...(queryArguments === undefined ? {} : { queryArguments }), provenance: { actionId: action.id, source: action.canonicalName, observedAt }, ...(sourceView && !viewComplete ? { viewIncompleteReason: sourceView.viewIncompleteReason } : {}), ...(duplicateOf ? { duplicateOf: duplicateOf.observationId } : {}), ...(status === "conflicting" ? { conflictsWith: group.filter(item => active(item) && item.resultHash !== outcome.resultHash).map(item => item.observationId) } : {}) };
    record.presentation = viewComplete ? "visible" : sourceView?.viewIncompleteReason || "hidden";
    record.freshness = "fresh";
    if (changedFrom) record.changedFromActionId = changedFrom;
    if (mutation) { record.evidenceKind = "mutation_receipt"; record.mutationReceipt = mutation; }
    if (!duplicateAction) all.push(record);
    const state = { schemaVersion: "gaia2-observation-state-v2", observations: all, provenance: all.map(item => item.provenance), stale_ids: all.filter(item => item.status === "stale").map(item => item.observationId), unverified_ids: all.filter(item => ["incomplete", "failed"].includes(item.status)).map(item => item.observationId), conflict_ids: all.filter(item => item.status === "conflicting").map(item => item.observationId), visibility_ids: all.filter(item => active(item) && item.viewComplete === false && item.presentation !== "retrieval_filtered").map(item => item.observationId) };
    const progress = values.gaia2_progress_state, identity = JSON.stringify([action.canonicalName, action.resourceKey, queryHash]);
    const seen = (progress.seen_queries || []).find(item => item.identity === identity);
    const controllerWait = values.gaia2_temporal_state?.enabled === true && action.effect === "wait";
    const advanced = !controllerWait && ((full || semantic?.evidence?.kind === "entity_absent") && (resolved || ["write", "wait", "finish"].includes(action.effect) || !seen || seen.resultHash !== outcome.resultHash) || Boolean(mutation) && !duplicateAction);
    const count = controllerWait ? Number(progress.consecutive_no_progress || 0) : advanced ? 0 : Number(progress.consecutive_no_progress || 0) + 1;
    const policy = values.gaia2_runtime_policy, replanAfter = Number(policy.no_progress_replan_after || 3), stopAfter = Number(policy.no_progress_stop_after || 6);
    const next = { ...progress, steps: Number(progress.steps || 0) + 1, consecutive_no_progress: count, blocked_repetitions: advanced ? 0 : progress.blocked_repetitions, blocked_signature: advanced ? null : progress.blocked_signature, last_reason: controllerWait ? "controller_wait_not_business_progress" : advanced ? (resolved ? "evidence_verified" : "new_observable_progress") : "repeated_or_uncertain_result", recommendation: controllerWait ? progress.recommendation : count >= stopAfter ? "clarify_or_safe_finish" : count >= replanAfter ? "replan_with_fresh_evidence" : "continue", seen_queries: full ? [...(progress.seen_queries || []).filter(item => item.identity !== identity), { identity, resultHash: outcome.resultHash || null }].slice(-64) : progress.seen_queries || [] };
    const semanticPatches = semantic ? [
      { op: "replace", path: "/builtin/variables/gaia2_entity_state", value: semantic.state },
      { op: "replace", path: "/builtin/variables/gaia2_entity_context", value: "Exact native entity evidence: " + semantic.state.records.slice(-6).map(item => JSON.stringify({ kind: item.kind, entityRef: item.entityRef, actionId: item.callRef.actionId, observedAt: item.callRef.observedAt, deleteReceiptId: item.deleteReceiptRef?.receiptId || null, invalidatedBy: item.invalidatedBy || null })).join("; ") + ". entity_absent explains only the recorded post-delete point-read error for this exact entity; the raw error is preserved. It does not resolve other queries, resource-wide conflicts, UNKNOWN writes, or prove scenario completion. A later entity_present or invalidatedBy marker invalidates the prior tombstone; never use that historical proof as current absence." },
    ] : [];
    return { patches: [{ op: "replace", path: "/builtin/variables/gaia2_observation_state", value: state }, { op: "replace", path: "/builtin/variables/gaia2_noise_state", value: { ...noise, decisions: [...(noise.decisions || []), record], deduplicated: [...(noise.deduplicated || []), ...(duplicateOf ? [record.observationId] : [])], conflicts: state.conflict_ids, quarantined: [...state.unverified_ids, ...state.stale_ids, ...state.conflict_ids] } }, { op: "replace", path: "/builtin/variables/gaia2_progress_state", value: next }, ...semanticPatches], artifacts: [{ title: "GAIA2 observable evidence classification", value: record }, { title: "GAIA2 finite progress decision", value: { actionId: action.id, advanced, resolved, consecutiveNoProgress: count, recommendation: next.recommendation } }] };
  },
});
