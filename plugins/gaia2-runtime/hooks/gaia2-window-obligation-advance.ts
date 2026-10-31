import { defineHook } from "@capybara-agent/sdk";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, max = 512) => typeof value === "string" && value.length > 0 && value.length <= max;
const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const sameSceneTime = (left, right) => finite(left) && finite(right) && Math.abs(left - right) <= 1e-6;

export default defineHook({
  name: "gaia2-window-obligation-advance",
  description: "Closes only an explicitly bound monitor-until window after a final complete read at its ARE deadline.",
  enabled: true, checkpoint: "after_tool",
  activation: { canonicalNames: ["CapybaraTemporal__watch", "SystemApp__wait_for_notification"] },
  trigger({ action, outcome }) {
    return ["CapybaraTemporal__watch", "SystemApp__wait_for_notification"].includes(action?.canonicalName)
      && outcome?.status === "succeeded";
  },
  schedule: { priority: 238, timeoutMs: 3000, onError: "block" },
  permissions: { variables: "patch", artifacts: "write" },
  run({ variables, action, outcome, clock, loop }) {
    const current = variables.builtin.variables.gaia2_window_obligation_state;
    const result = outcome.result;
    // A bounded condition_once whose deadline is reached by an explicit
    // native wait has completed its waiting lifecycle even when no temporal
    // controller query was needed. This never asserts the condition itself.
    if (action?.canonicalName === "SystemApp__wait_for_notification") {
      const obligations = Array.isArray(current?.obligations) ? current.obligations : [];
      const nextObligations = obligations.map(item => {
        if (!object(item) || item.status !== "pending" || item.mode !== "condition_once"
          || item.candidateEvidence !== null || !finite(item.deadline) || !finite(clock.now)
          || clock.now < item.deadline) return item;
        return { ...item, status: "window_completed", completionReason: "deadline_reviewed",
          lastReviewedActionId: action.id, lastSignal: "deadline_reviewed" };
      });
      if (JSON.stringify(nextObligations) === JSON.stringify(obligations)) return { patches: [] };
      const next = { ...current, revision: Number.isSafeInteger(current.revision) ? current.revision + 1 : 1,
        areNow: clock.now, obligations: nextObligations };
      const completedIds = nextObligations.filter((item, index) => item.status === "window_completed"
        && obligations[index]?.status !== "window_completed").map(item => item.id);
      const audit = { schemaVersion: "gaia2-window-native-wait-deadline-review-v1", completedIds,
        observedAt: clock.now, businessSuccess: "not_inferred",
        ...(text(loop?.runId) ? { executionId: loop.runId } : {}),
        ...(text(loop?.sessionId) ? { sessionId: loop.sessionId } : {}) };
      return { patches: [
        { op: "replace", path: "/builtin/variables/gaia2_window_obligation_state", value: next },
        { op: "replace", path: "/builtin/variables/gaia2_window_obligation_context",
          value: "Bound condition_once waiting lifecycle reached its declared ARE deadline through an explicit native wait. "
            + "This closes waiting only; it does not infer the requested business condition. " + JSON.stringify({ completedIds }) },
      ], artifacts: [{ title: "GAIA2 condition window native-wait deadline reviewed", value: audit }] };
    }
    if (!object(current) || current.enabled !== true || !object(result)
      || !object(result.signal) || result.signal.kind !== "deadline"
      || !object(result.state) || !text(result.state.executionId) || result.state.executionId !== current.executionId
      || !text(result.state.sessionId) || result.state.sessionId !== current.sessionId
      || !text(result.state.userRef)
      || !finite(result.state.deadline) || !object(result.observation)
      || !text(result.observation.actionId) || result.observation.complete !== true
      || result.observation.viewComplete !== true || !finite(result.observation.observedAt)
      || !finite(clock.now) || clock.now < result.state.deadline
      || result.observation.observedAt < result.state.deadline) return { patches: [] };

    const obligations = Array.isArray(current.obligations) ? current.obligations : [];
    let changed = false;
    const nextObligations = obligations.map(item => {
      // A condition_once window also has a terminal deadline review path when
      // the controller returned a complete final observation and no candidate
      // is waiting for Actor review. This closes only the waiting lifecycle;
      // it never asserts that the business condition was satisfied.
      if (!object(item) || item.status !== "pending"
        || !["monitor_until", "condition_once"].includes(item.mode)
        || item.userRef !== result.state.userRef || !finite(item.deadline)
        || !sameSceneTime(item.deadline, result.state.deadline) || item.candidateEvidence !== null) return item;
      changed = true;
      return { ...item, status: "window_completed", completionReason: "deadline_reviewed",
        lastReviewedActionId: result.observation.actionId, lastSignal: "deadline_reviewed",
        candidateEvidence: null };
    });
    if (!changed) return { patches: [] };
    const next = { ...current, revision: Number.isSafeInteger(current.revision) ? current.revision + 1 : 1,
      areNow: clock.now, obligations: nextObligations };
    const completedIds = nextObligations.filter((item, index) => item.status === "window_completed" && obligations[index]?.status !== "window_completed").map(item => item.id);
    const context = "Bound monitor-until windows reviewed at their declared ARE deadline using a complete final native read. "
      + "This closes only the waiting lifecycle; it does not infer business success or waive unresolved writes. "
      + JSON.stringify({ completedIds, observedAt: result.observation.observedAt, deadline: result.state.deadline });
    return { patches: [
      { op: "replace", path: "/builtin/variables/gaia2_window_obligation_state", value: next },
      { op: "replace", path: "/builtin/variables/gaia2_window_obligation_context", value: context },
    ], artifacts: [{ title: "GAIA2 monitor window deadline reviewed", value: {
      schemaVersion: "gaia2-window-deadline-review-v1", executionId: loop.runId,
      sessionId: result.state.sessionId, userRef: result.state.userRef, completedIds,
      actionId: result.observation.actionId, observedAt: result.observation.observedAt,
      deadline: result.state.deadline, businessSuccess: "not_inferred",
    } }] };
  },
});
