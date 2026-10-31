import { defineHook } from "@capybara-agent/sdk";
export default defineHook({
  name: "retrieval-page-register", description: "Registers actual native Contacts return identities before accepting any review certificate.",
  enabled: true, checkpoint: "after_tool", activation: { canonicalNames: ["Contacts__get_contacts"] }, trigger({ action }) { return action?.canonicalName === "Contacts__get_contacts"; },
  schedule: { priority: 240, timeoutMs: 5000, onError: "block" }, permissions: { variables: "patch", artifacts: "write" },
  run({ variables, action, outcome, messages, clock }) {
    const old = variables.builtin.variables.gaia2_retrieval_pages;
    const view = (messages || []).find(message => message.role === "tool" && message.observation?.actionId === action.id)?.observation;
    const result = outcome.result;
    const records = outcome.status === "succeeded" && result && Array.isArray(result.contacts)
      ? result.contacts.map((body, index) => ({ path: "/contacts/" + index, body: typeof body === "string" ? body : JSON.stringify(body) })) : [];
    if (records.length > 40 || old.nativeReceipts.some(item => item.actionId === action.id)) throw new Error("RETRIEVAL_NATIVE_PAGE_IDENTITY");
    const receipt = { actionId: action.id, resourceKey: action.resourceKey, canonicalName: action.canonicalName,
      queryHash: action.mutationKey, resultHash: outcome.resultHash, observedAt: view ? view.observedAt : clock.now,
      complete: outcome.status === "succeeded" && outcome.complete === true,
      beforeViewComplete: view ? view.viewComplete === true : outcome.viewComplete !== false,
      records, range: result?.metadata?.range || null, total: result?.metadata?.total ?? null };
    if (old.nativeReceipts.length >= 128) throw new Error("RETRIEVAL_NATIVE_PAGE_BOUND");
    return { patches: [{ op: "replace", path: "/builtin/variables/gaia2_retrieval_pages", value: { ...old, nativeReceipts: [...old.nativeReceipts, receipt] } }],
      artifacts: [{ title: "Retrieval native page registration", value: { actionId: action.id, resultHash: receipt.resultHash, records: records.length, complete: receipt.complete } }] };
  },
});
