import { defineHook } from "@capybara-agent/sdk";
export default defineHook({
  name: "gaia2-write-outcome", description: "Records observed write outcomes; authoritative read-back is evidence, not automatic permission to replay.",
  enabled: true, checkpoint: "after_tool", activation: { excludeCanonicalNames: ["CapybaraEvidence__read", "CapybaraTaskContract__commit", "CapybaraTaskContract__review"] }, trigger({ action }) { return Boolean(action) && !["CapybaraEvidence__read", "CapybaraTaskContract__commit", "CapybaraTaskContract__review"].includes(action.canonicalName); },
  schedule: { priority: 215, timeoutMs: 3000, onError: "block" },
  permissions: { variables: "patch", artifacts: "write" },
  run({ variables, action, outcome, loop, clock, messages }) {
    const values = variables.builtin.variables, state = values.gaia2_write_state;
    let actions = [...(state.actions || [])], unknown = [...(state.unknown || [])];
    const receipt = outcome.mutationEvidence;
    if (receipt !== undefined) {
      const observed = (values.gaia2_observation_state.observations || []).find(item => item.actionId === action.id);
      if (!observed || observed.status !== "confirmed_mutation" || observed.evidenceKind !== "mutation_receipt"
        || JSON.stringify(observed.mutationReceipt) !== JSON.stringify(receipt)) throw new Error("MUTATION_CLASSIFICATION_MISSING");
      const prior = actions.find(item => item.actionId === action.id);
      if (prior && JSON.stringify(prior.mutationReceipt) !== JSON.stringify(receipt)) throw new Error("MUTATION_RECEIPT_REPLAY_CONFLICT");
    }
    if (["write", "finish"].includes(action.effect)) {
      const semantic = (variables.builtin.variables.gaia2_entity_state?.records || []).find(item => item.callRef.actionId === action.id && item.kind === "delete_succeeded");
      const observed = (values.gaia2_observation_state.observations || []).find(item => item.actionId === action.id);
      const observedAt = receipt?.callRef?.observedAt ?? observed?.observedAt ?? clock?.now;
      const user = [...(messages || [])].reverse().find(item => item.role === "user" && item.notificationType === "USER_MESSAGE"
        && typeof item.id === "string" && item.id.length > 0 && item.id.length <= 256);
      const entry = { actionId: action.id, mutationKey: action.mutationKey || null, resourceKey: action.resourceKey || null,
        ...(typeof action.canonicalName === "string" ? { canonicalName: action.canonicalName } : {}), effect: action.effect,
        ...(Number.isFinite(observedAt) && observedAt >= 0 ? { observedAt } : {}),
        ...(typeof outcome.executed === "boolean" ? { executed: outcome.executed } : {}),
        ...(typeof outcome.complete === "boolean" ? { complete: outcome.complete } : {}),
        ...(user ? { currentUserRef: user.id } : {}),
        idempotent: action.idempotent === true, status: outcome.status, recordedAt: loop.iteration, resultHash: outcome.resultHash || null,
        ...(semantic ? { operation: "delete", entityRef: semantic.entityRef, deleteReceiptRef: semantic.deleteReceiptRef } : {}) };
      if (receipt !== undefined) entry.mutationReceipt = receipt;
      const prior = actions.find(item => item.actionId === action.id);
      if (prior) {
        // A repeated Host frame is the same historical call, not another
        // execution. Keep the first timestamp/turn/user anchor. Old ledgers
        // may omit the optional descriptive fields introduced here.
        const identity = ["mutationKey", "resourceKey", "idempotent", "status", "resultHash"];
        const optional = ["canonicalName", "effect", "executed", "complete"];
        if (identity.some(key => prior[key] !== entry[key])
          || optional.some(key => prior[key] !== undefined && prior[key] !== entry[key])
          || JSON.stringify(prior.mutationReceipt) !== JSON.stringify(entry.mutationReceipt)) throw new Error("WRITE_ACTION_REPLAY_CONFLICT");
      } else actions.push(entry);
      if (outcome.status === "unknown" && !unknown.some(item => item.mutationKey === entry.mutationKey)) unknown.push({ ...entry, readBackObserved: false });
    }
    if (action.effect === "read" && action.authoritativeRead && outcome.status === "succeeded" && outcome.complete === true) {
      unknown = unknown.map(item => item.resourceKey === action.resourceKey ? { ...item, readBackObserved: true, readBackActionId: action.id, readBackHash: outcome.resultHash || null } : item);
    }
    return { patches: [{ op: "replace", path: "/builtin/variables/gaia2_write_state", value: { ...state, actions, unknown } },
      { op: "replace", path: "/builtin/variables/gaia2_mutation_context", value: "The always-visible execution-facts projection is generated from the complete execution ledger. Historical successful calls remain successful after provider compaction, elapsed query TTL, or later resource changes. A confirmed applied mutation and a merely returned call are distinct facts; neither alone proves current resource state or whole-task completion. Unknown outcomes are not resolved by a read-back alone and are never automatically replayed." }],
      artifacts: [{ title: "GAIA2 observed mutation ledger", value: { actionId: action.id, recordedCalls: actions.length,
        unknownCount: unknown.length, readBackObserved: unknown.filter(item => item.readBackObserved).length } }] };
  },
});
