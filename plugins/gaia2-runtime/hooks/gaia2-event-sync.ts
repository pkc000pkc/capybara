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
    for (const message of messages) {
      if (!["user", "tool"].includes(message.role)) continue;
      const id = String(message.id || message.toolCallId || "");
      if (!id || consumed.has(id)) continue;
      consumed.add(id);
      pending.push({ id, role: message.role, name: String(message.name || ""), source: message.role === "tool" ? "tool" : "notification", observedAt: clock.now, loop: loop.iteration });
    }
    const state = { ...previous, pending, consumed: [...consumed], revision: Number(previous.revision || 0) + (pending.length ? 1 : 0) };
    return { patches: [{ op: "replace", path: "/builtin/variables/gaia2_event_state", value: state }, { op: "replace", path: "/builtin/variables/gaia2_clock_state", value: { now: clock.now, revision: clock.revision || 0, pending_waits: [], authority: "ARE" } }], artifacts: [{ title: "GAIA2 visible event synchronization", value: { count: pending.length, revision: state.revision, now: clock.now, authority: "ARE" } }] };
  },
});
