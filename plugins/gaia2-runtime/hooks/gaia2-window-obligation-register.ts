import { defineHook } from "@capybara-agent/sdk";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, max = 2048) => typeof value === "string" && value.length > 0 && value.length <= max;
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0;

export default defineHook({
  name: "gaia2-window-obligation-register",
  description: "Registers a Host-bound exact-source business window into the mutable runtime ledger.",
  enabled: true, checkpoint: "before_model",
  trigger({ variables, action }) { return variables.builtin.variables.gaia2_window_obligation_source?.enabled === true || action?.canonicalName === "CapybaraWindow__register"; },
  schedule: { priority: 185, timeoutMs: 3000, onError: "block" },
  permissions: { variables: "patch", artifacts: "write" },
  run({ variables, messages, clock, loop, action }) {
    const source = variables.builtin.variables.gaia2_window_obligation_source?.enabled === true
      ? variables.builtin.variables.gaia2_window_obligation_source : action?.arguments?.windowSource;
    const current = variables.builtin.variables.gaia2_window_obligation_state;
    if (!object(source) || source.enabled !== true) return { patches: [] };
    if (source.schemaVersion !== "gaia2-window-obligation-source-v1"
      || source.executionId !== loop.runId || !text(source.sessionId, 512)
      || !text(source.userRef, 512) || !hash(source.sourceHash)
      || source.span !== null && (!object(source.span) || !Number.isSafeInteger(source.span.start)
      || !Number.isSafeInteger(source.span.end) || source.span.start < 0
      || source.span.end <= source.span.start || !text(source.span.text, 262144))
      || !finite(source.sceneStart) || !Array.isArray(source.obligations)
      || source.obligations.length < 1 || source.obligations.length > 64
      || !hash(source.parserReceiptHash)) throw new Error("WINDOW_SOURCE_SCHEMA");
    const user = (messages || []).find(item => item?.role === "user"
      && item?.notificationType === "USER_MESSAGE" && item?.id === source.userRef);
    if (!user || typeof user.content !== "string" || user.content.length > 262144
      || !hash(user.sourceHash) || user.sourceHash !== source.sourceHash) throw new Error("WINDOW_SOURCE_SPAN");
    const obligations = source.obligations.map((item, index) => {
      const span = item.span || source.span;
      if (!object(span) || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)
        || span.start < 0 || span.end <= span.start || !text(span.text, 262144)
        || user.content.slice(span.start, span.end) !== span.text) throw new Error("WINDOW_SOURCE_SPAN");
      if (!object(item) || !hash(item.sourceSpanHash) || !text(item.id, 200) || !/^[A-Za-z0-9_.:-]+$/.test(item.id)
        || !["monitor_until", "condition_once"].includes(item.mode)
        || !text(item.goal, 2000) || !finite(item.deadline) || item.deadline < source.sceneStart
        || !["allow", "forbid_until_deadline", "forbid"].includes(item.notificationPolicy)) throw new Error("WINDOW_OBLIGATION_SCHEMA");
      return { schemaVersion: "gaia2-window-obligation-v1", id: item.id, userRef: source.userRef,
        sourceHash: source.sourceHash, sourceSpanHash: item.sourceSpanHash, span: { ...span },
        mode: item.mode, goal: item.goal, notificationPolicy: item.notificationPolicy,
        sceneStart: source.sceneStart, deadline: item.deadline, status: "pending",
        candidateEvidence: null, lastReviewedActionId: null, completionReason: null,
        terminationSignal: null, waitCount: 0, scanCount: 0, lastSignal: "registered",
        registrationIndex: index };
    });
    if (current?.enabled === true) {
      if (current.executionId !== loop.runId || current.sessionId !== source.sessionId
        || JSON.stringify(current.obligations || []) !== JSON.stringify(obligations)) throw new Error("WINDOW_SOURCE_STATE_MISMATCH");
      return { patches: [] };
    }
    const state = { schemaVersion: "gaia2-window-obligation-v1", enabled: true,
      executionId: loop.runId, sessionId: source.sessionId, revision: 1,
      areNow: clock.now,
      budgets: { sdk: { limit: null, consumed: 0 }, wait: { limit: null, consumed: 0 }, outer: { limit: null, consumed: 0 } },
      obligations };
    const context = "Trusted time-window obligations registered from the exact visible USER source. Candidates require Actor review; timeout and scan budget are not completion. "
      + JSON.stringify(obligations.map(item => ({ id: item.id, mode: item.mode, goal: item.goal.slice(0, 500), deadline: item.deadline, notificationPolicy: item.notificationPolicy })));
    return { patches: [
      { op: "replace", path: "/builtin/variables/gaia2_window_obligation_state", value: state },
      { op: "replace", path: "/builtin/variables/gaia2_window_obligation_context", value: context },
    ], artifacts: [{ title: "GAIA2 trusted window registration", value: {
      schemaVersion: "gaia2-window-registration-receipt-v1", executionId: loop.runId,
      sessionId: source.sessionId, userRef: source.userRef, sourceHash: source.sourceHash,
      obligationIds: obligations.map(item => item.id), registered: true,
    } }] };
  },
});
