import { defineHook } from "@capybara-agent/sdk";

const signals = ["candidate_changed", "initial_observation", "deadline", "deadline_approaching", "scan_budget", "native_error", "incomplete_observation", "user_update", "environment_stop", "clock_error"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.length > 0 && value.length <= 2000;
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export default defineHook({
  name: "gaia2-temporal-commit", description: "Commits trusted repeated-wait state bound to actual native observations; signals never claim business success.",
  enabled: true, checkpoint: "after_tool", activation: { canonicalNames: ["CapybaraTemporal__watch"] }, trigger({ action, outcome }) { return action?.canonicalName === "CapybaraTemporal__watch" && action.arguments?.op === "state_update" && outcome?.status === "succeeded"; },
  schedule: { priority: 245, timeoutMs: 3000, onError: "block" }, permissions: { variables: "patch", artifacts: "write" },
  run({ variables, action, outcome, clock, loop }) {
    if (action.effect !== "read" || action.resourceKey !== "CapybaraTemporal" || action.authoritativeRead !== false
      || action.arguments?.op !== "state_update") throw new Error("TEMPORAL_CONTROL_CONTRACT");
    const values = variables.builtin.variables, next = outcome.result?.temporalState, prior = values.gaia2_temporal_state;
    if (!object(next) || next.schemaVersion !== "gaia2-temporal-state-v1" || next.enabled !== true
      || !text(next.watchId) || !text(next.executionId) || next.executionId !== loop.runId || !text(next.sessionId)
      || !text(next.userRef) || !text(next.goal) || !["running", "signaled"].includes(next.status)
      || !Number.isFinite(next.sceneStart) || next.sceneStart < 0 || !Number.isFinite(next.sceneNow)
      || next.sceneNow < next.sceneStart || next.sceneNow > clock.now
      || next.deadline !== null && (!Number.isFinite(next.deadline) || next.deadline < 0)
      || !Number.isFinite(next.intervalSeconds) || next.intervalSeconds <= 0
      || !Number.isSafeInteger(next.maxScans) || next.maxScans < 1 || next.maxScans > 1000
      || !Number.isSafeInteger(next.scanCount) || next.scanCount < 0 || next.scanCount > next.maxScans
      || !Number.isSafeInteger(next.waitCount) || next.waitCount < 0
      || !text(next.queryTool) || !object(next.queryArguments)
      || next.baselineHash !== null && !hash(next.baselineHash)
      || !Array.isArray(next.waitRefs) || next.waitRefs.length > 64 || next.waitRefs.length > next.waitCount
      || JSON.stringify(next).length > 64000) throw new Error("TEMPORAL_SNAPSHOT_SCHEMA");
    if (next.status === "running" ? next.signal !== null : !object(next.signal) || !signals.includes(next.signal.kind)) throw new Error("TEMPORAL_SIGNAL_CONTRACT");
    if (prior?.enabled === true) {
      if (next.executionId !== prior.executionId || next.sessionId !== prior.sessionId) throw new Error("TEMPORAL_IDENTITY_CHANGED");
      if (next.watchId === prior.watchId) {
        if (["sceneStart", "deadline", "intervalSeconds", "maxScans", "userRef", "goal", "queryTool"].some(key => next[key] !== prior[key])
          || JSON.stringify(next.queryArguments) !== JSON.stringify(prior.queryArguments)
          || next.sceneNow < prior.sceneNow || next.scanCount < prior.scanCount || next.waitCount < prior.waitCount
          || prior.status === "signaled" && next.status !== "signaled") throw new Error("TEMPORAL_STATE_ROLLBACK");
      } else if (prior.status === "running") throw new Error("TEMPORAL_RUNNING_WATCH_REPLACEMENT");
    }
    const observations = values.gaia2_observation_state.observations || [], seen = new Set();
    const boundRef = (ref, waiting) => {
      if (!object(ref) || !text(ref.actionId) || !text(ref.canonicalName) || !hash(ref.queryHash) || !hash(ref.resultHash)
        || !Number.isFinite(ref.observedAt) || ref.observedAt < 0 || ref.observedAt > next.sceneNow
        || waiting && ref.canonicalName !== "SystemApp__wait_for_notification") throw new Error("TEMPORAL_NATIVE_REFERENCE_SCHEMA");
      const source = observations.find(item => item.actionId === ref.actionId);
      if (!source || ["canonicalName", "queryHash", "resultHash", "observedAt"].some(key => source[key] !== ref[key])) throw new Error("TEMPORAL_NATIVE_REFERENCE_BINDING");
      if (!waiting && (source.authoritativeRead !== true || source.resourceKey === "CapybaraTemporal")) throw new Error("TEMPORAL_QUERY_REFERENCE_BINDING");
    };
    for (const ref of next.waitRefs) {
      boundRef(ref, true);
      if (seen.has(ref.actionId)) throw new Error("TEMPORAL_NATIVE_REFERENCE_DUPLICATE");
      seen.add(ref.actionId);
    }
    if (next.lastEvidenceRef !== null) boundRef(next.lastEvidenceRef, false);
    const pending = (values.gaia2_clock_state.pending_waits || []).filter(item => item.kind !== "temporal_controller");
    if (next.status === "running") pending.push({ kind: "temporal_controller", watchId: next.watchId, userRef: next.userRef,
      sceneStart: next.sceneStart, sceneNow: next.sceneNow, deadline: next.deadline, scanCount: next.scanCount, waitCount: next.waitCount });
    const context = "Built-in waiting controller: Watch " + next.watchId + " is " + next.status + "; ARE time " + next.sceneNow
      + "; deadline " + (next.deadline === null ? "none" : next.deadline) + "; native waits " + next.waitCount
      + "; scans " + next.scanCount + "/" + next.maxScans + "; signal " + (next.signal?.kind || "none")
      + ". Goal: " + next.goal.slice(0, 500) + ". A signal requires judgment; it is not a success assertion. Native evidence and unresolved write gates remain authoritative.";
    return { patches: [
      { op: "replace", path: "/builtin/variables/gaia2_temporal_state", value: next },
      { op: "replace", path: "/builtin/variables/gaia2_temporal_context", value: context },
      { op: "replace", path: "/builtin/variables/gaia2_clock_state", value: { ...values.gaia2_clock_state, now: clock.now, revision: clock.revision || 0, pending_waits: pending, authority: "ARE" } },
    ], artifacts: [{ title: "GAIA2 built-in waiting controller", value: { watchId: next.watchId, status: next.status, signal: next.signal,
      sceneNow: next.sceneNow, deadline: next.deadline, scanCount: next.scanCount, waitCount: next.waitCount,
      lastEvidenceRef: next.lastEvidenceRef, businessSuccess: "not_inferred" } }] };
  },
});
