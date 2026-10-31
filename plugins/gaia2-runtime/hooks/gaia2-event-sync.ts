import { defineHook } from "@capybara-agent/sdk";
export default defineHook({
  name: "gaia2-event-sync", description: "Synchronizes only already-visible observations using ARE-authoritative time.",
  enabled: true, checkpoint: "before_model", trigger() { return true; },
  schedule: { priority: 195, timeoutMs: 3000, onError: "block" },
  permissions: { variables: "patch", artifacts: "write" },
  run({ variables, messages, clock, loop }) {
    const previous = variables.builtin.variables.gaia2_event_state;
    const consumed = new Set(previous.consumed || []);
    const pending = [];
    const progress = variables.builtin.variables.gaia2_progress_state;
    const previousClock = variables.builtin.variables.gaia2_clock_state;
    const seenUsers = new Set(progress.seen_user_ids || []);
    let userProgress = false;
    for (const message of messages) {
      if (!["user", "tool"].includes(message.role)) continue;
      const id = String(message.id || message.toolCallId || "");
      if (!id || consumed.has(id)) continue;
      consumed.add(id);
      if (message.role === "user" && message.notificationType === "USER_MESSAGE" && !seenUsers.has(id)) { seenUsers.add(id); userProgress = true; }
      pending.push({ id, role: message.role, name: String(message.name || ""), source: message.role === "tool" ? "tool" : "notification", observedAt: clock.now, loop: loop.iteration });
    }
    const state = { ...previous, pending, consumed: [...consumed], revision: Number(previous.revision || 0) + (pending.length ? 1 : 0) };
    const contract = variables.builtin.variables.gaia2_task_contract_state;
    const pendingWaits = (variables.builtin.variables.gaia2_temporal_state?.enabled === true ? (previousClock.pending_waits || []) : []).filter(item => item.kind !== "task_contract");
    if (contract?.enabled === true) for (const item of contract.obligations) if (!["satisfied", "revoked"].includes(item.status)) pendingWaits.push({ kind: "task_contract", obligationId: item.id, userRef: item.userRef, deadline: item.deadline, status: item.status });
    return { patches: [{ op: "replace", path: "/builtin/variables/gaia2_event_state", value: state }, { op: "replace", path: "/builtin/variables/gaia2_clock_state", value: { now: clock.now, revision: clock.revision || 0, pending_waits: pendingWaits, authority: "ARE" } }, ...(userProgress ? [{ op: "replace", path: "/builtin/variables/gaia2_progress_state", value: { ...progress, consecutive_no_progress: 0, blocked_repetitions: 0, blocked_signature: null, last_reason: "new_official_user_notification", recommendation: "continue", seen_user_ids: [...seenUsers] } }] : [])], artifacts: [{ title: "GAIA2 visible event synchronization", value: { count: pending.length, revision: state.revision, now: clock.now, authority: "ARE", userProgress } }] };
  },
});
