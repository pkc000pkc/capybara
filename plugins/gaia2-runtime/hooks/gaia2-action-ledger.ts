import { defineHook } from "@capybara-agent/sdk";

const MAX_GROUPS = 32, MAX_RECENT = 48, MAX_SCOPES = 16;
const EMPTY = { schemaVersion: "gaia2-action-ledger-v1", totalCalls: 0, groups: [], recent: [], omittedGroups: 0, omittedScopes: 0, scopes: [] };
const excluded = new Set(["CapybaraEvidence__read", "CapybaraRetrieval__step", "CapybaraTemporal__watch", "CapybaraTaskContract__commit", "CapybaraTaskContract__review"]);
const effects = new Set(["read", "write", "finish", "wait", "unknown"]);
const statuses = new Set(["succeeded", "failed", "unknown", "not_executed"]);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);

function count(value, code = "ACTION_LEDGER_STATE_INVALID") {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
  return value;
}

function assertGroup(group) {
  if (!record(group) || typeof group.key !== "string" || group.key.length > 512
    || typeof group.canonicalName !== "string" || !group.canonicalName
    || typeof group.resourceKey !== "string" || !group.resourceKey
    || !effects.has(group.effect)) throw new Error("ACTION_LEDGER_STATE_INVALID");
  const total = count(group.totalCalls);
  if (!record(group.counts)) throw new Error("ACTION_LEDGER_STATE_INVALID");
  let counted = 0;
  for (const status of statuses) counted += count(group.counts[status]);
  if (counted !== total) throw new Error("ACTION_LEDGER_STATE_INVALID");
}

function assertUniqueGroups(groups) {
  const keys = new Set();
  for (const group of groups) {
    if (keys.has(group.key)) throw new Error("ACTION_LEDGER_STATE_INVALID");
    keys.add(group.key);
  }
}

function assertLedger(value) {
  if (!record(value) || value.schemaVersion !== "gaia2-action-ledger-v1"
    || !Array.isArray(value.groups) || value.groups.length > MAX_GROUPS
    || !Array.isArray(value.recent) || value.recent.length > MAX_RECENT
    || (value.scopes !== undefined && (!Array.isArray(value.scopes) || value.scopes.length > MAX_SCOPES))) {
    throw new Error("ACTION_LEDGER_STATE_INVALID");
  }
  const total = count(value.totalCalls), omittedGroups = count(value.omittedGroups ?? 0), omittedScopes = count(value.omittedScopes ?? 0);
  value.groups.forEach(assertGroup);
  assertUniqueGroups(value.groups);
  if (value.groups.reduce((sum, group) => sum + group.totalCalls, 0) + omittedGroups !== total) {
    throw new Error("ACTION_LEDGER_STATE_INVALID");
  }
  for (const entry of value.recent) {
    if (!record(entry) || typeof entry.actionId !== "string" || typeof entry.canonicalName !== "string"
      || typeof entry.resourceKey !== "string" || !effects.has(entry.effect) || !statuses.has(entry.status)) {
      throw new Error("ACTION_LEDGER_STATE_INVALID");
    }
  }
  if (Array.isArray(value.scopes)) {
    // An empty scopes array is the normal global-only ledger shape. Scoped
    // totals are authoritative only once at least one USER scope exists.
    if (value.scopes.length === 0) {
      if (omittedScopes !== 0) throw new Error("ACTION_LEDGER_STATE_INVALID");
      return;
    }
    for (const scope of value.scopes) {
      if (!record(scope) || (scope.userRef !== null && typeof scope.userRef !== "string")
        || !Array.isArray(scope.groups) || scope.groups.length > MAX_GROUPS
        || !Array.isArray(scope.recent) || scope.recent.length > MAX_RECENT) throw new Error("ACTION_LEDGER_STATE_INVALID");
      count(scope.totalCalls); count(scope.omittedGroups ?? 0);
      scope.groups.forEach(assertGroup);
      assertUniqueGroups(scope.groups);
      if (scope.groups.reduce((sum, group) => sum + group.totalCalls, 0) + (scope.omittedGroups ?? 0) !== scope.totalCalls) {
        throw new Error("ACTION_LEDGER_STATE_INVALID");
      }
      for (const entry of scope.recent) {
        if (!record(entry) || typeof entry.actionId !== "string" || typeof entry.canonicalName !== "string"
          || typeof entry.resourceKey !== "string" || !effects.has(entry.effect) || !statuses.has(entry.status)) {
          throw new Error("ACTION_LEDGER_STATE_INVALID");
        }
      }
    }
    if (value.scopes.reduce((sum, scope) => sum + scope.totalCalls, 0) + omittedScopes !== total) {
      throw new Error("ACTION_LEDGER_STATE_INVALID");
    }
  }
}

function category(outcome) {
  // A successful status is not enough evidence for reconciliation: the native
  // adapter must explicitly prove both execution and completion.  A missing
  // or false completion flag is retained as unknown rather than counted as an
  // actual call, preventing partial/ambiguous receipts from satisfying a plan.
  if (outcome?.status === "succeeded" && outcome.executed === true && outcome.complete === true) return "succeeded";
  if (outcome?.status === "unknown" || outcome?.executed === null
    || (outcome?.status === "succeeded" && outcome?.executed === true && outcome?.complete !== true)) return "unknown";
  if (outcome?.status === "failed" || outcome?.status === "failed_before_execution") return "failed";
  return "not_executed";
}

function addGroup(groups, action, status) {
  const key = JSON.stringify([action.canonicalName, action.resourceKey || "unknown_resource", action.effect]);
  let group = groups.find(item => item.key === key);
  if (!group && groups.length >= MAX_GROUPS) return false;
  if (!group) {
    group = { key, canonicalName: action.canonicalName, resourceKey: action.resourceKey || "unknown_resource", effect: action.effect,
      totalCalls: 0, counts: { succeeded: 0, failed: 0, unknown: 0, not_executed: 0 } };
    groups.push(group);
  }
  group.totalCalls += 1;
  group.counts[status] = Number(group.counts[status] || 0) + 1;
  return true;
}

function latestUserRef(messages) {
  return [...(messages || [])].reverse().find(item => item?.role === "user" && item?.notificationType === "USER_MESSAGE")?.id || null;
}

function publicRecent(entries) {
  return entries.slice(-12).map(entry => {
    const { argumentFieldHashes, argumentFieldNumbers, argumentsComplete, ...publicEntry } = entry;
    return { ...publicEntry, argHashesComplete: entry.argumentsComplete === true };
  });
}

function contextFor(next, activeScope) {
  return "Actual action ledger (expected actions are not inferred): " + JSON.stringify({
    totalCalls: next.totalCalls, groups: next.groups, omittedGroups: next.omittedGroups,
    omittedScopes: next.omittedScopes,
    activeScope: activeScope ? { userRef: activeScope.userRef, totalCalls: activeScope.totalCalls,
      groups: activeScope.groups, omittedGroups: activeScope.omittedGroups } : null,
    recent: publicRecent(next.recent),
  });
}

export default defineHook({
  name: "gaia2-action-ledger",
  description: "Records bounded actual action counts for generic Actor reconciliation; it never infers expected actions or completion.",
  enabled: true, checkpoint: "after_tool",
  activation: { excludeCanonicalNames: [...excluded] },
  trigger({ action }) { return Boolean(action) && !excluded.has(action.canonicalName); },
  schedule: { priority: 185, timeoutMs: 3000, onError: "block" },
  permissions: { variables: "patch", artifacts: "write" },
  run({ variables, action, outcome, clock, messages }) {
    const values = variables.builtin.variables;
    const prior = values.gaia2_action_ledger === undefined ? EMPTY : values.gaia2_action_ledger;
    assertLedger(prior);
    const status = category(outcome), resourceKey = action.resourceKey || "unknown_resource";
    const userRef = latestUserRef(messages);
    const recentEntry = { actionId: action.id, userRef, canonicalName: action.canonicalName, resourceKey, effect: action.effect,
      status, complete: outcome?.complete === true, executed: outcome?.executed ?? null,
      resultHash: typeof outcome?.resultHash === "string" ? outcome.resultHash : null, observedAt: clock?.now ?? null,
      argumentHash: typeof action.argumentHash === "string" ? action.argumentHash : null,
      argumentFieldHashes: action.argumentFieldHashes && typeof action.argumentFieldHashes === "object" ? { ...action.argumentFieldHashes } : null,
      argumentFieldNumbers: action.argumentFieldNumbers && typeof action.argumentFieldNumbers === "object" ? { ...action.argumentFieldNumbers } : null,
      argumentsComplete: Boolean(typeof action.argumentHash === "string" && action.argumentFieldHashes && typeof action.argumentFieldHashes === "object"
        && action.argumentMetadataComplete === true) };
    const groups = Array.isArray(prior.groups) ? prior.groups.map(item => ({ ...item, counts: { ...(item.counts || {}) } })) : [];
    const globalRecorded = addGroup(groups, { ...action, resourceKey }, status);
    const scopes = Array.isArray(prior.scopes) ? prior.scopes.map(item => ({ ...item,
      groups: Array.isArray(item.groups) ? item.groups.map(group => ({ ...group, counts: { ...(group.counts || {}) } })) : [] })) : [];
    let activeScope = scopes.find(item => item.userRef === userRef);
    if (!activeScope && scopes.length < MAX_SCOPES) {
      activeScope = { userRef, totalCalls: 0, groups: [], recent: [], omittedGroups: 0 };
      scopes.push(activeScope);
    }
    const priorOmittedScopes = prior.omittedScopes ?? 0;
    let omittedScopes = priorOmittedScopes;
    if (activeScope) {
      activeScope.totalCalls = count(activeScope.totalCalls) + 1;
      activeScope.recent = [...(Array.isArray(activeScope.recent) ? activeScope.recent : []), recentEntry].slice(-MAX_RECENT);
      if (!addGroup(activeScope.groups, { ...action, resourceKey }, status)) activeScope.omittedGroups = count(activeScope.omittedGroups ?? 0) + 1;
    } else {
      omittedScopes += 1;
    }
    const next = { schemaVersion: "gaia2-action-ledger-v1", totalCalls: count(prior.totalCalls) + 1,
      groups, recent: [...(Array.isArray(prior.recent) ? prior.recent : []), recentEntry].slice(-MAX_RECENT),
      omittedGroups: count(prior.omittedGroups ?? 0) + (globalRecorded ? 0 : 1), omittedScopes, scopes };
    return { patches: [
      { op: "replace", path: "/builtin/variables/gaia2_action_ledger", value: next },
      { op: "replace", path: "/builtin/variables/gaia2_action_ledger_context", value: contextFor(next, activeScope) },
    ], artifacts: [{ title: "GAIA2 actual action ledger", value: { actionId: action.id, userRef, status,
      canonicalName: action.canonicalName, resourceKey, effect: action.effect, totalCalls: next.totalCalls,
      scopeRecorded: Boolean(activeScope), ledgerGroupRecorded: globalRecorded } }] };
  },
});
