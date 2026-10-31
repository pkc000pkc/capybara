import { defineHook } from "@capybara-agent/sdk";
export default defineHook({
  name: "retrieval-scope-refresh", description: "Revokes presentation eligibility on a later official user instruction without changing historical native evidence.",
  enabled: true, checkpoint: "before_model", trigger() { return true; }, schedule: { priority: 10, timeoutMs: 5000, onError: "block" }, permissions: { variables: "patch", artifacts: "write" },
  run({ variables, messages }) {
    const values = variables.builtin.variables, watch = values.gaia2_retrieval_watch;
    const ids = (messages || []).filter(item => item.role === "user" && item.notificationType === "USER_MESSAGE" && typeof item.id === "string").map(item => item.id);
    const changed = watch.seenUserIds.length > 0 && ids.some(id => !watch.seenUserIds.includes(id));
    if (!changed && JSON.stringify(ids) === JSON.stringify(watch.seenUserIds)) return {};
    const invalidated = watch.invalidated || Boolean(changed && values.gaia2_retrieval_scope.scopeId);
    const patches = [{ op: "replace", path: "/builtin/variables/gaia2_retrieval_watch", value: { seenUserIds: ids.slice(-128), invalidated } }];
    if (invalidated) patches.push({ op: "replace", path: "/builtin/variables/gaia2_retrieval_projection", value: { ...values.gaia2_retrieval_projection, certificates: [] } });
    return { patches, artifacts: [{ title: "Retrieval instruction scope check", value: { invalidated, newOfficialUserInstruction: changed } }] };
  },
});
