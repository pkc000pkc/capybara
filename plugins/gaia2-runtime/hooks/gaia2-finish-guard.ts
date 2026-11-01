import { defineHook } from "@capybara-agent/sdk";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, maximum = 512) => typeof value === "string" && value.length > 0 && value.length <= maximum;
const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const temporalSignals = ["candidate_changed", "initial_observation", "deadline", "deadline_approaching", "scan_budget", "native_error", "incomplete_observation", "user_update", "environment_stop", "clock_error"];
const validTemporalState = value => object(value) && value.schemaVersion === "gaia2-temporal-state-v1"
  && ["running", "signaled"].includes(value.status) && text(value.watchId) && text(value.executionId)
  && text(value.sessionId) && text(value.userRef) && text(value.goal) && finite(value.sceneStart)
  && finite(value.sceneNow) && value.sceneNow >= value.sceneStart
  && (value.status === "running" ? value.signal === null : object(value.signal) && temporalSignals.includes(value.signal.kind));
const validWindowState = value => object(value) && value.schemaVersion === "gaia2-window-obligation-v1"
  && text(value.executionId) && text(value.sessionId) && Array.isArray(value.obligations)
  && value.obligations.length <= 64 && value.obligations.every(item => object(item) && text(item.id)
    && ["monitor_until", "condition_once"].includes(item.mode) && finite(item.deadline)
    && ["pending", "candidate_pending_review", "window_expired_unreviewed", "window_completed",
      "user_interrupted", "cancelled", "technical_termination"].includes(item.status)
    && (item.status !== "window_completed" || ["condition_satisfied", "deadline_reviewed"].includes(item.completionReason) && text(item.lastReviewedActionId))
    && (!["user_interrupted", "cancelled", "technical_termination"].includes(item.status) || text(item.terminationSignal)));
const validReconciliationState = value => object(value) && value.schemaVersion === "gaia2-task-reconciliation-v1"
  && ["unreviewed", "advisory", "enforce"].includes(value.status)
  && Number.isSafeInteger(value.revision) && value.revision >= 0
  && Array.isArray(value.obligations) && Array.isArray(value.mismatches)
  && (value.status !== "enforce" || (object(value.source) && text(value.source.userRef)
    && hash(value.source.sourceHash) && text(value.source.quote, 4096)));
const ledgerEffects = new Set(["read", "write", "finish", "wait", "unknown"]);
const ledgerStatuses = new Set(["succeeded", "failed", "unknown", "not_executed"]);
const count = value => Number.isSafeInteger(value) && value >= 0;
const validGroup = group => object(group) && text(group.key, 512) && text(group.canonicalName, 512)
  && text(group.resourceKey, 512) && ledgerEffects.has(group.effect) && count(group.totalCalls)
  && object(group.counts) && [...ledgerStatuses].every(status => count(group.counts[status]))
  && [...ledgerStatuses].reduce((sum, status) => sum + group.counts[status], 0) === group.totalCalls;
const validRecent = entry => object(entry) && text(entry.actionId, 512) && text(entry.canonicalName, 512)
  && text(entry.resourceKey, 512) && ledgerEffects.has(entry.effect) && ledgerStatuses.has(entry.status);
const validUniqueGroups = groups => {
  const keys = new Set();
  return groups.every(group => { if (keys.has(group.key)) return false; keys.add(group.key); return true; });
};
const validActionLedger = value => {
  if (!object(value) || value.schemaVersion !== "gaia2-action-ledger-v1"
    || !count(value.totalCalls) || !count(value.omittedGroups ?? 0) || !count(value.omittedScopes ?? 0)
    || !Array.isArray(value.groups) || value.groups.length > 32 || !value.groups.every(validGroup) || !validUniqueGroups(value.groups)
    || !Array.isArray(value.recent) || value.recent.length > 48 || !value.recent.every(validRecent)) return false;
  if (value.scopes === undefined) return true;
  if (!Array.isArray(value.scopes) || value.scopes.length > 16) return false;
  if (value.scopes.length === 0) return (value.omittedScopes ?? 0) === 0;
  const refs = new Set();
  for (const scope of value.scopes) {
    if (!object(scope) || (scope.userRef !== null && typeof scope.userRef !== "string") || refs.has(scope.userRef)
      || !count(scope.totalCalls) || !count(scope.omittedGroups ?? 0)
      || !Array.isArray(scope.groups) || scope.groups.length > 32 || !scope.groups.every(validGroup) || !validUniqueGroups(scope.groups)
      || !Array.isArray(scope.recent) || scope.recent.length > 48 || !scope.recent.every(validRecent)) return false;
    refs.add(scope.userRef);
  }
  return true;
};
const ledgerTotalsValid = value => object(value) && count(value.totalCalls) && count(value.omittedGroups ?? 0)
  && count(value.omittedScopes ?? 0) && Array.isArray(value.groups)
  && value.groups.reduce((sum, group) => sum + group.totalCalls, 0) + (value.omittedGroups ?? 0) === value.totalCalls
  && (value.scopes === undefined || Array.isArray(value.scopes)
    && value.scopes.reduce((sum, scope) => sum + scope.totalCalls, 0) + (value.omittedScopes ?? 0) === value.totalCalls);

export default defineHook({
  name: "gaia2-finish-guard", description: "Prevents closing a live controller operation; business completion and notification interpretation belong to the Actor.",
  enabled: true, checkpoint: "before_tool", activation: { effects: ["finish"] }, trigger({ action }) { return action?.effect === "finish"; },
  schedule: { priority: 230, timeoutMs: 3000, onError: "block" }, permissions: { artifacts: "write" },
  run({ variables, messages, loop }) {
    const watch = variables.builtin.variables.gaia2_temporal_state;
    const window = variables.builtin.variables.gaia2_window_obligation_state;
    const reconciliation = variables.builtin.variables.gaia2_task_reconciliation;
    const stopped = ["environment_stop", "cancelled"].includes(loop?.terminationReason)
      || (messages || []).some(item => item.notificationType === "ENVIRONMENT_STOP");
    // Enabled controller state is Host-owned. A malformed enabled state is a
    // technical boundary, not an empty/disabled feature; fail closed unless
    // the environment is already stopping safely.
    const temporalInvalid = watch?.enabled === true && !validTemporalState(watch);
    const windowInvalid = window?.enabled === true && !validWindowState(window);
    const reconciliationInvalid = reconciliation !== undefined && !validReconciliationState(reconciliation);
    const runtimeStateInvalid = temporalInvalid || windowInvalid || reconciliationInvalid;
    const running = watch?.enabled === true && watch.status === "running";
    const activeWindowStatuses = ["pending", "candidate_pending_review", "window_expired_unreviewed"];
    const pendingWindows = window?.enabled === true
      ? (window.obligations || []).filter(item => activeWindowStatuses.includes(item?.status)) : [];
    const windowBlocked = pendingWindows.length > 0 && !stopped;
    const ledger = variables.builtin.variables.gaia2_action_ledger;
    const ledgerValid = validActionLedger(ledger);
    const unresolvedActions = ledgerValid
      ? ledger.recent.filter(item => ["write", "finish", "unknown"].includes(item?.effect) && ["unknown", "not_executed"].includes(item?.status)) : [];
    const scopeEntries = ledgerValid && Array.isArray(ledger.scopes) ? ledger.scopes : [];
    // Global groups already aggregate every scoped call.  Older versions
    // counted the same group once globally and once per USER scope, which
    // inflated diagnostics (and made a single unknown write look like two).
    // Use scoped groups only when their key is not present globally.
    const globalGroupKeys = new Set(ledgerValid ? ledger.groups.map(group => group?.key) : []);
    const groups = ledgerValid
      ? [...ledger.groups, ...scopeEntries.flatMap(scope => Array.isArray(scope?.groups)
          ? scope.groups.filter(group => !globalGroupKeys.has(group?.key)) : [])] : [];
    const unresolvedGroupCounts = groups.reduce((total, group) => {
      if (!["write", "finish", "unknown"].includes(group?.effect)) return total;
      const counts = group?.counts;
      const unknown = Number.isSafeInteger(counts?.unknown) && counts.unknown >= 0 ? counts.unknown : 0;
      const notExecuted = Number.isSafeInteger(counts?.not_executed) && counts.not_executed >= 0 ? counts.not_executed : 0;
      return total + unknown + notExecuted;
    }, 0);
    const ledgerIncomplete = !ledgerValid || !ledgerTotalsValid(ledger) || (ledgerValid && ((ledger.omittedGroups ?? 0) > 0 || (ledger.omittedScopes ?? 0) > 0));
    const actionBlocked = !stopped && (unresolvedActions.length > 0 || unresolvedGroupCounts > 0 || ledgerIncomplete);
    const reconciliationBlocked = reconciliation?.schemaVersion === "gaia2-task-reconciliation-v1"
      && reconciliation.status === "enforce" && Array.isArray(reconciliation.mismatches)
      && reconciliation.mismatches.length > 0 && !stopped;
    const decision = { action: (runtimeStateInvalid && !stopped || running && !stopped || windowBlocked || actionBlocked || reconciliationBlocked) ? "block" : "allow",
      reason: runtimeStateInvalid && !stopped ? "runtime_state_invalid" : running && !stopped ? "temporal_watch_running" : windowBlocked ? "window_obligation_pending" : ledgerIncomplete && !stopped && unresolvedGroupCounts === 0 ? "action_ledger_incomplete" : actionBlocked ? "action_ledger_unresolved" : reconciliationBlocked ? "task_reconciliation_unresolved" : "business_completion_actor_owned" };
    const unresolvedGroups = groups.filter(group => {
      if (!["write", "finish", "unknown"].includes(group?.effect)) return false;
      const counts = group?.counts || {};
      return (Number.isSafeInteger(counts.unknown) && counts.unknown > 0)
        || (Number.isSafeInteger(counts.not_executed) && counts.not_executed > 0);
    }).slice(0, 64).map(group => ({
      canonicalName: group.canonicalName,
      resourceKey: group.resourceKey,
      effect: group.effect,
      counts: { unknown: group.counts?.unknown || 0, not_executed: group.counts?.not_executed || 0 },
    }));
    return { decision, artifacts: [{ title: "GAIA2 controller lifecycle boundary", value: {
      ...decision, watchId: running ? watch.watchId : null, stopped,
      pendingWindowIds: pendingWindows.map(item => item.id).slice(0, 64),
      unresolvedActionIds: unresolvedActions.map(item => item.actionId).slice(-64),
      unresolvedGroupCount: unresolvedGroupCounts,
      unresolvedGroups,
      ledgerIncomplete,
      reconciliationMismatchIds: reconciliationBlocked ? reconciliation.mismatches.map(item => item.id).slice(0, 64) : [],
      runtimeStateInvalid, temporalInvalid, windowInvalid, reconciliationInvalid,
      businessDecision: "actor_owned", taskContractReviewed: false,
      windowStateVersion: window?.schemaVersion || null,
    } }] };
  },
});
