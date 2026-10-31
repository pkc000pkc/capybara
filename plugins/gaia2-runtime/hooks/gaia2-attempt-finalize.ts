import { defineHook } from "@capybara-agent/sdk";
export default defineHook({
  name: "gaia2-attempt-finalize", description: "Records the agent execution end without exposing judge results.",
  enabled: true, checkpoint: "attempt_end", trigger() { return true; },
  schedule: { priority: 90, timeoutMs: 3000, onError: "block" },
  permissions: { variables: "patch", artifacts: "write" },
  run({ variables, loop }) {
    const attempt = variables.builtin.variables.gaia2_attempt_state;
    const next = { ...attempt, status: "agent_finished", termination_reason: loop.terminationReason || "environment_stop", evaluator: "sealed" };
    const temporal = variables.builtin.variables.gaia2_temporal_state;
    const window = variables.builtin.variables.gaia2_window_obligation_state;
    const contract = variables.builtin.variables.gaia2_task_contract_state;
    const unfinished = contract?.enabled === true ? contract.obligations.filter(item => !["satisfied", "revoked"].includes(item.status)) : [];
    const reason = contract?.interruption || (["cancelled", "budget_exhausted", "clock_error", "user_update"].includes(loop.terminationReason) ? loop.terminationReason : "environment_stop");
    const alreadyStopped = unfinished.every(item => ["interrupted", "technical_blocked"].includes(item.status));
    const contractPatches = unfinished.length ? [
      ...(!alreadyStopped ? [{ op: "replace", path: "/builtin/variables/gaia2_task_contract_state", value: { ...contract, interruption: reason, obligations: contract.obligations.map(item => ["satisfied", "revoked", "interrupted", "technical_blocked"].includes(item.status) ? item : { ...item, status: ["budget_exhausted", "clock_error"].includes(reason) ? "technical_blocked" : "interrupted", pendingEvidence: null, lastSignal: reason }) } }] : []),
      { op: "replace", path: "/builtin/variables/gaia2_task_contract_context", value: "The environment ended with unfinished user-bound obligations: " + JSON.stringify(unfinished.map(item => ({ id: item.id, status: item.status, lastSignal: item.lastSignal }))) + ". Exit reason: " + reason + ". These obligations remain interrupted or technically blocked, not satisfied; existing technical reasons are preserved. No completion or notification permission is inferred." },
      { op: "replace", path: "/builtin/variables/gaia2_clock_state", value: { ...variables.builtin.variables.gaia2_clock_state, pending_waits: (variables.builtin.variables.gaia2_clock_state.pending_waits || []).filter(item => item.kind !== "task_contract" && !(temporal?.enabled === true && temporal.status === "running" && item.kind === "temporal_controller")) } },
    ] : [];
    const temporalPatches = temporal?.enabled === true && temporal.status === "running" ? [
      { op: "replace", path: "/builtin/variables/gaia2_temporal_state", value: { ...temporal, status: "signaled", signal: { kind: "environment_stop", detail: loop.terminationReason || "environment_stop" } } },
      { op: "replace", path: "/builtin/variables/gaia2_temporal_context", value: "The environment ended while watch " + temporal.watchId + " was pending. Waiting is stopped and preserved as unfinished; no business success is inferred." },
      { op: "replace", path: "/builtin/variables/gaia2_clock_state", value: { ...variables.builtin.variables.gaia2_clock_state, pending_waits: (variables.builtin.variables.gaia2_clock_state.pending_waits || []).filter(item => item.kind !== "temporal_controller") } },
    ] : [];
    const activeWindow = window?.enabled === true ? (window.obligations || []).filter(item => ["pending", "candidate_pending_review", "window_expired_unreviewed"].includes(item?.status)) : [];
    const windowPatches = activeWindow.length ? [
      { op: "replace", path: "/builtin/variables/gaia2_window_obligation_state", value: { ...window, revision: Number.isSafeInteger(window.revision) ? window.revision + 1 : 1, obligations: window.obligations.map(item => ["pending", "candidate_pending_review", "window_expired_unreviewed"].includes(item?.status) ? { ...item, status: "technical_termination", terminationSignal: loop.terminationReason || "environment_stop", lastSignal: loop.terminationReason || "environment_stop" } : item) } },
      { op: "replace", path: "/builtin/variables/gaia2_window_obligation_context", value: "The environment ended with unfinished business-window obligations: " + JSON.stringify(activeWindow.map(item => ({ id: item.id, status: item.status, deadline: item.deadline }))) + ". No timeout, scan budget or termination is treated as business completion." },
    ] : [];
    return { patches: [{ op: "replace", path: "/builtin/variables/gaia2_attempt_state", value: next }, ...temporalPatches, ...contractPatches, ...windowPatches], artifacts: [{ title: "GAIA2 actor termination", value: next }, ...(temporalPatches.length ? [{ title: "GAIA2 unfinished wait termination", value: { watchId: temporal.watchId, reason: loop.terminationReason || "environment_stop", businessSuccess: "not_inferred" } }] : []), ...(unfinished.length ? [{ title: "GAIA2 unfinished task obligations", value: { obligationIds: unfinished.map(item => item.id), existingStatuses: unfinished.map(item => ({ id: item.id, status: item.status, lastSignal: item.lastSignal })), statePreserved: alreadyStopped, reason, businessSuccess: "not_inferred" } }] : []), ...(windowPatches.length ? [{ title: "GAIA2 unfinished business-window obligations", value: { obligationIds: activeWindow.map(item => item.id), statePreserved: false, reason: loop.terminationReason || "environment_stop", businessSuccess: "not_inferred" } }] : [])] };
  },
});
