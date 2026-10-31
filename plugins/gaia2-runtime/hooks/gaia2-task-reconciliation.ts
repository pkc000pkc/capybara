import { defineHook } from "@capybara-agent/sdk";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, maximum = 512) => typeof value === "string" && value.length > 0 && value.length <= maximum;
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const declarationError = code => { const error = new Error(code); error.actorDeclaration = true; return error; };
const reject = (condition, code) => { if (!condition) throw declarationError(code); };
const sourceIdentity = source => JSON.stringify({
  userRef: source?.userRef ?? null,
  sourceHash: source?.sourceHash ?? null,
  quote: source?.quote ?? null,
  scopeAnchor: source?.scopeAnchor ?? null,
});

function validateArgumentChecks(checks) {
  if (checks === undefined) return true;
  if (!Array.isArray(checks) || checks.length > 16) return false;
  return checks.every(check => {
    if (!object(check) || !text(check.path, 128) || (check.path !== "" && !check.path.startsWith("/"))) return false;
    if (!["equals_hash", "present", "array_contains_hash", "number_range"].includes(check.op)) return false;
    if (["equals_hash", "array_contains_hash"].includes(check.op) && !hash(check.expectedHash)) return false;
    if (check.op === "present" && check.expectedHash !== undefined) return false;
    if (check.op === "number_range" && (check.expectedHash !== undefined
      || (check.min === undefined && check.max === undefined)
      || check.min !== undefined && (typeof check.min !== "number" || !Number.isFinite(check.min))
      || check.max !== undefined && (typeof check.max !== "number" || !Number.isFinite(check.max))
      || check.min !== undefined && check.max !== undefined && check.max < check.min)) return false;
    return Object.keys(check).every(key => ["path", "op", "expectedHash", "min", "max"].includes(key));
  });
}

function fallbackState(prior, request) {
  const mode = request?.mode === "enforce" ? "enforce" : "advisory";
  return {
    schemaVersion: "gaia2-task-reconciliation-v1", status: mode,
    revision: Number(prior?.revision || 0) + 1,
    source: object(request?.source) ? {
      userRef: request.source.userRef || null,
      sourceHash: hash(request.source.sourceHash) ? request.source.sourceHash : null,
      quote: text(request.source.quote, 4096) ? request.source.quote : null,
    } : null,
    obligations: [],
    mismatches: [{ id: "invalid_declaration", status: "invalid_declaration", actualCalls: 0, minCalls: 0, maxCalls: 0 }],
  };
}

export default defineHook({
  name: "gaia2-task-reconciliation",
  description: "Reconciles an Actor-declared, visible-user-bound action/count plan with actual successful calls; never infers Oracle actions.",
  enabled: true, checkpoint: "after_tool",
  activation: { canonicalNames: ["CapybaraTaskContract__review"] },
  trigger({ action }) { return action?.canonicalName === "CapybaraTaskContract__review" && action.arguments?.op === "reconcile"; },
  schedule: { priority: 248, timeoutMs: 3000, onError: "block" },
  permissions: { variables: "patch", artifacts: "write" },
  run({ variables, action, outcome, messages }) {
    const values = variables?.builtin?.variables;
    // Runtime state corruption and Hook bugs must remain native technical
    // failures. Only errors explicitly marked as Actor declaration errors are
    // converted into bounded feedback.
    if (!values || !object(values)) throw new Error("TASK_RECONCILIATION_STATE");
    const prior = values.gaia2_task_reconciliation || { schemaVersion: "gaia2-task-reconciliation-v1", revision: 0 };
    const request = outcome?.result?.taskReconciliation;
    try {
      reject(action?.effect === "read" && action?.resourceKey === "CapybaraTaskContract"
        && action?.authoritativeRead === false && outcome?.status === "succeeded"
        && outcome?.executed === true && outcome?.complete === true, "TASK_RECONCILIATION_CONTROL");
      reject(object(request) && request.schemaVersion === "gaia2-task-reconciliation-request-v1"
        && ["advisory", "enforce"].includes(request.mode) && object(request.source)
        && text(request.source.userRef) && hash(request.source.sourceHash)
        && text(request.source.quote, 4096) && Array.isArray(request.obligations)
        && request.obligations.length <= 64 && JSON.stringify(request).length <= 64000, "TASK_RECONCILIATION_SCHEMA");
      const source = (messages || []).find(item => item.role === "user" && item.notificationType === "USER_MESSAGE" && item.id === request.source.userRef);
      reject(source && typeof source.content === "string" && source.content.includes(request.source.quote), "TASK_RECONCILIATION_SOURCE_BINDING");
      // The official bridge supplies this trusted digest on the internal
      // USER record and strips it from the provider view. It must agree with
      // the Actor request before any plan is admitted.
      reject(source.sourceHash === request.source.sourceHash, "TASK_RECONCILIATION_SOURCE_HASH");
      const first = source.content.indexOf(request.source.quote);
      reject(first === source.content.lastIndexOf(request.source.quote), "TASK_RECONCILIATION_SOURCE_AMBIGUOUS");
      const anchor = request.source.scopeAnchor;
      let scopeMembers = [{ userRef: request.source.userRef, sourceHash: request.source.sourceHash, quote: request.source.quote }];
      if (anchor !== undefined) {
        reject(object(anchor) && Object.keys(anchor).every(key => key === "members") && Array.isArray(anchor.members) && anchor.members.length >= 2 && anchor.members.length <= 9, "TASK_RECONCILIATION_SCOPE_SCHEMA");
        const seen = new Set();
        const rootVisibleIndex = (messages || []).findIndex(item => item.role === "user" && item.notificationType === "USER_MESSAGE" && item.id === request.source.userRef);
        reject(rootVisibleIndex >= 0, "TASK_RECONCILIATION_SCOPE_ROOT");
        let previousVisibleIndex = rootVisibleIndex;
        scopeMembers = anchor.members.map(member => {
          reject(object(member) && Object.keys(member).every(key => ["userRef", "sourceHash", "quote"].includes(key))
            && text(member.userRef, 512) && hash(member.sourceHash) && text(member.quote, 4096), "TASK_RECONCILIATION_SCOPE_MEMBER");
          reject(!seen.has(member.userRef), "TASK_RECONCILIATION_SCOPE_DUPLICATE");
          seen.add(member.userRef);
          const visibleIndex = (messages || []).findIndex(item => item.role === "user" && item.notificationType === "USER_MESSAGE" && item.id === member.userRef);
          const visible = visibleIndex >= 0 ? messages[visibleIndex] : null;
          const isRoot = member.userRef === request.source.userRef;
          reject(visible && typeof visible.content === "string" && visible.sourceHash === member.sourceHash
            && visible.content.includes(member.quote) && visible.content.indexOf(member.quote) === visible.content.lastIndexOf(member.quote)
            && (isRoot ? visibleIndex === rootVisibleIndex : visibleIndex > previousVisibleIndex), "TASK_RECONCILIATION_SCOPE_BINDING");
          if (!isRoot) previousVisibleIndex = visibleIndex;
          return { userRef: member.userRef, sourceHash: member.sourceHash, quote: member.quote };
        });
        reject(scopeMembers[0].userRef === request.source.userRef && scopeMembers[0].sourceHash === request.source.sourceHash
          && scopeMembers.some(member => member.userRef !== request.source.userRef), "TASK_RECONCILIATION_SCOPE_ROOT");
      }
      const replacement = request.source.replacement;
      let replacementValid = false;
      if (replacement !== undefined) {
        reject(object(replacement) && Object.keys(replacement).every(key => ["mode", "quote"].includes(key))
          && replacement.mode === "supersede" && text(replacement.quote, 4096)
          && source.content.indexOf(replacement.quote) === source.content.lastIndexOf(replacement.quote), "TASK_RECONCILIATION_SUPERSEDE_QUOTE");
        replacementValid = true;
      }

      const ledger = values.gaia2_action_ledger || { groups: [], omittedGroups: 0 };
      const memberRefs = scopeMembers.map(member => member.userRef);
      const scopedLedgers = Array.isArray(ledger.scopes) ? memberRefs.map(userRef => ledger.scopes.find(item => item.userRef === userRef)) : [];
      const scopedLedger = scopedLedgers[0] || null;
      const scopedLedgerMode = Array.isArray(ledger.scopes);
      const totalCalls = ledger.totalCalls === undefined ? 0 : ledger.totalCalls;
      const omittedGroupCount = ledger.omittedGroups === undefined ? 0 : ledger.omittedGroups;
      const ledgerShapeInvalid = !Number.isSafeInteger(totalCalls) || totalCalls < 0
        || !Number.isSafeInteger(omittedGroupCount) || omittedGroupCount < 0;
      const noCallsYet = scopedLedgerMode && !ledgerShapeInvalid && totalCalls === 0 && ledger.scopes.length === 0
        && omittedGroupCount === 0 && (!Array.isArray(ledger.groups) || ledger.groups.length === 0)
        && (!Array.isArray(ledger.recent) || ledger.recent.length === 0);
      const scopeIncomplete = ledgerShapeInvalid || (scopedLedgerMode && !noCallsYet && scopedLedgers.some(item => !item));
      const groups = scopedLedgerMode
        ? scopedLedgers.filter(Boolean).reduce((merged, scope) => {
            for (const group of Array.isArray(scope.groups) ? scope.groups : []) {
              const current = merged.find(item => item.key === group.key);
              if (!current) merged.push({ ...group, counts: { ...(group.counts || {}) } });
              else { current.totalCalls += Number(group.totalCalls || 0); for (const key of ["succeeded", "failed", "unknown", "not_executed"]) current.counts[key] = Number(current.counts[key] || 0) + Number(group.counts?.[key] || 0); }
            }
            return merged;
          }, [])
        : (scopeMembers.length === 1 && Array.isArray(ledger.groups) ? ledger.groups : []);
      const omittedGroups = scopedLedgerMode
        ? (scopeIncomplete ? 1 : noCallsYet ? 0 : scopedLedgers.reduce((total, scope) => total + Number(scope.omittedGroups || 0), 0))
        : Number(omittedGroupCount) + (scopeMembers.length > 1 ? 1 : 0);
      const recent = scopedLedgerMode
        ? scopedLedgers.filter(Boolean).flatMap(scope => Array.isArray(scope.recent) ? scope.recent : [])
        : (scopeMembers.length === 1 && Array.isArray(ledger.recent) ? ledger.recent : []);
      const ids = new Set(), obligations = [], declarationMismatches = [];
      for (const item of request.obligations) {
        const valid = object(item) && text(item.id, 200) && !ids.has(item.id) && text(item.canonicalName, 200)
          && (item.effect === undefined || ["read", "write", "finish", "wait", "unknown"].includes(item.effect))
          && (item.resourceKey === undefined || text(item.resourceKey, 200))
          && validateArgumentChecks(item.argumentChecks)
          && Number.isSafeInteger(item.minCalls) && item.minCalls >= 0 && item.minCalls <= 64
          && Number.isSafeInteger(item.maxCalls) && item.maxCalls >= item.minCalls && item.maxCalls <= 64;
        if (!valid) {
          const id = object(item) && text(item.id, 200) ? item.id : `invalid-${declarationMismatches.length + 1}`;
          declarationMismatches.push({ id, status: "invalid_declaration", actualCalls: 0, minCalls: 0, maxCalls: 0 });
          continue;
        }
        ids.add(item.id);
        const matching = groups.filter(group => group.canonicalName === item.canonicalName
          && (item.resourceKey === undefined || group.resourceKey === item.resourceKey)
          && (item.effect === undefined || group.effect === item.effect));
        const attemptedCalls = matching.reduce((total, group) => total + (Number.isSafeInteger(group.totalCalls) ? group.totalCalls : 0), 0);
        const succeededCalls = matching.reduce((total, group) => total + (Number.isSafeInteger(group.counts?.succeeded) ? group.counts.succeeded : 0), 0);
        const failedCalls = matching.reduce((total, group) => total + (Number.isSafeInteger(group.counts?.failed) ? group.counts.failed : 0), 0);
        const unknownCalls = matching.reduce((total, group) => total + (Number.isSafeInteger(group.counts?.unknown) ? group.counts.unknown : 0), 0);
        const notExecutedCalls = matching.reduce((total, group) => total + (Number.isSafeInteger(group.counts?.not_executed) ? group.counts.not_executed : 0), 0);
        // A missing member scope is always incomplete: a retained root scope
        // must not make an anchored multi-USER plan look satisfied.  When
        // bounded group storage has dropped data, broad declarations (without
        // both resource and effect) are also conservatively incomplete because
        // an omitted group could still contribute to their canonical match.
        const ledgerIncomplete = ledgerShapeInvalid || scopeIncomplete
          || (omittedGroups > 0 && (matching.length === 0 || item.resourceKey === undefined || item.effect === undefined));
        const argumentChecks = Array.isArray(item.argumentChecks) ? item.argumentChecks : [];
        const successfulEntries = recent.filter(entry => entry.canonicalName === item.canonicalName
          && (item.resourceKey === undefined || entry.resourceKey === item.resourceKey)
          && (item.effect === undefined || entry.effect === item.effect) && entry.status === "succeeded");
        let argumentMatchedCalls = null, argumentMismatchCalls = null, fieldMismatchIds = [];
        let argumentEvidenceIncomplete = false;
        if (argumentChecks.length > 0 && succeededCalls > 0) {
          argumentEvidenceIncomplete = successfulEntries.length < succeededCalls
            || successfulEntries.some(entry => entry.argumentsComplete !== true || !entry.argumentFieldHashes);
          if (!argumentEvidenceIncomplete) {
            argumentMatchedCalls = 0; argumentMismatchCalls = 0;
            for (const entry of successfulEntries) {
              const failures = argumentChecks.flatMap(check => {
                if (check.op === "present") return Object.hasOwn(entry.argumentFieldHashes, check.path) ? [] : [check.path];
                if (check.op === "equals_hash") return entry.argumentFieldHashes[check.path] === check.expectedHash ? [] : [check.path];
                if (check.op === "array_contains_hash") return Object.entries(entry.argumentFieldHashes)
                  .some(([path, digest]) => path.startsWith(check.path + "/") && digest === check.expectedHash) ? [] : [check.path];
                const number = entry.argumentFieldNumbers?.[check.path];
                return typeof number === "number" && (check.min === undefined || number >= check.min) && (check.max === undefined || number <= check.max) ? [] : [check.path];
              });
              if (failures.length === 0) argumentMatchedCalls += 1;
              else { argumentMismatchCalls += 1; fieldMismatchIds.push(...failures); }
            }
            fieldMismatchIds = [...new Set(fieldMismatchIds)].slice(0, 16);
          }
        }
        const baseStatus = ledgerIncomplete ? "ledger_incomplete"
          : succeededCalls < item.minCalls ? "missing" : succeededCalls > item.maxCalls ? "overrun" : "satisfied";
        const status = baseStatus === "satisfied" && argumentEvidenceIncomplete ? "argument_evidence_incomplete"
          : baseStatus === "satisfied" && argumentMismatchCalls > 0 ? "argument_mismatch" : baseStatus;
        obligations.push({ id: item.id, canonicalName: item.canonicalName, resourceKey: item.resourceKey ?? null,
          effect: item.effect ?? null, minCalls: item.minCalls, maxCalls: item.maxCalls,
          actualCalls: succeededCalls, attemptedCalls, failedCalls, unknownCalls, notExecutedCalls,
          argumentChecks, argumentMatchedCalls, argumentMismatchCalls, fieldMismatchIds, status });
      }
      const mismatches = [...declarationMismatches, ...obligations.filter(item => item.status !== "satisfied")
        .map(item => ({ id: item.id, status: item.status, actualCalls: item.actualCalls, attemptedCalls: item.attemptedCalls,
          minCalls: item.minCalls, maxCalls: item.maxCalls, argumentMatchedCalls: item.argumentMatchedCalls,
          argumentMismatchCalls: item.argumentMismatchCalls, fieldMismatchIds: item.fieldMismatchIds }))];
      // An unresolved enforce plan cannot be downgraded by advisory feedback.
      // A later enforce review is the only way to replace it and clear the
      // finish gate; this prevents a model from hiding a mismatch in prose.
      const priorEnforce = prior.status === "enforce" && Array.isArray(prior.mismatches) && prior.mismatches.length > 0;
      const normalizedSource = { userRef: request.source.userRef, sourceHash: request.source.sourceHash, quote: request.source.quote,
        ...(anchor !== undefined ? { scopeAnchor: { members: scopeMembers } } : {}) };
      const sourceChanged = object(prior.source) && sourceIdentity(prior.source) !== sourceIdentity(normalizedSource);
      const supersedeRequired = priorEnforce && sourceChanged && request.mode === "enforce" && !replacementValid;
      const retained = priorEnforce && (request.mode !== "enforce" || supersedeRequired);
      const next = { schemaVersion: "gaia2-task-reconciliation-v1", status: retained ? "enforce" : request.mode,
        revision: Number(prior.revision || 0) + 1,
        source: normalizedSource,
        obligations: retained ? (Array.isArray(prior.obligations) ? prior.obligations : obligations) : obligations,
        mismatches: retained ? prior.mismatches : mismatches };
      if (supersedeRequired) {
        next.source = prior.source;
        next.obligations = Array.isArray(prior.obligations) ? prior.obligations : [];
        next.mismatches = prior.mismatches;
      }
      const context = "Actor-owned reconciliation (expected actions are model-declared, not inferred): " + JSON.stringify({
        status: next.status, revision: next.revision, source: { userRef: next.source.userRef, sourceHash: next.source.sourceHash,
          scopeMembers: scopeMembers.map(member => ({ userRef: member.userRef, sourceHash: member.sourceHash })) },
        obligations: next.obligations, mismatches: next.mismatches,
      }) + ". ActualCalls counts successful complete calls only; attempted/failed/unknown counts remain diagnostic. Field checks compare only Host-derived argument hashes/numeric leaves from successful calls. Advisory mismatches are feedback only; enforce mismatches block finish until the Actor submits a successful enforce review. No Oracle or hidden answer is consulted.";
      if (context.length > 64000) throw declarationError("TASK_RECONCILIATION_CONTEXT_BOUND");
      return { patches: [
        { op: "replace", path: "/builtin/variables/gaia2_task_reconciliation", value: next },
        { op: "replace", path: "/builtin/variables/gaia2_task_reconciliation_context", value: context },
      ], artifacts: [{ title: "GAIA2 Actor-owned task reconciliation", value: { revision: next.revision, status: next.status,
        obligationCount: next.obligations.length, mismatchIds: next.mismatches.map(item => item.id), oracleConsulted: false,
        retainedEnforce: retained, supersedeRequired } }] };
    } catch (error) {
      if (!error?.actorDeclaration) throw error;
      const next = fallbackState(prior, request);
      const retained = prior.status === "enforce" && Array.isArray(prior.mismatches) && prior.mismatches.length > 0;
      const sourceChanged = retained && object(prior.source) && object(request?.source)
        && sourceIdentity(prior.source) !== sourceIdentity(request.source);
      const supersedeRequired = retained && request?.mode === "enforce" && sourceChanged;
      if (retained && (request?.mode !== "enforce" || supersedeRequired)) {
        next.status = "enforce";
        next.source = prior.source;
        next.obligations = Array.isArray(prior.obligations) ? prior.obligations : [];
        next.mismatches = prior.mismatches;
      }
      const context = supersedeRequired
        ? "A new USER source cannot replace an unresolved enforce plan without a unique visible supersedeQuote. The prior enforce mismatch remains blocking."
        : retained && request?.mode !== "enforce"
        ? "An advisory reconciliation could not replace an unresolved enforce plan; the prior enforce mismatch remains blocking until a valid enforce review succeeds."
        : "Actor-owned reconciliation could not validate the declaration; no action expectation was inferred. Revise the visible-user-bound plan or continue with advisory runtime feedback. Enforce mode remains conservative.";
      return { patches: [
        { op: "replace", path: "/builtin/variables/gaia2_task_reconciliation", value: next },
        { op: "replace", path: "/builtin/variables/gaia2_task_reconciliation_context", value: context },
      ], artifacts: [{ title: "GAIA2 Actor-owned task reconciliation", value: { revision: next.revision, status: next.status,
        obligationCount: next.obligations.length, mismatchIds: next.mismatches.map(item => item.id), oracleConsulted: false,
        retainedEnforce: retained } }] };
    }
  },
});
