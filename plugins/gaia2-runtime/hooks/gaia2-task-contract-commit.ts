import { defineHook } from "@capybara-agent/sdk";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, maximum = 2000) => typeof value === "string" && value.length > 0 && value.length <= maximum;
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const finite = value => Number.isFinite(value) && value >= 0;
const statuses = ["pending", "elapsed_pending_review", "satisfied", "revoked", "interrupted", "technical_blocked"];
const reference = value => object(value) && text(value.path, 512) && /^[a-f0-9]{24}\/[a-z-]+-[a-f0-9]{32}\.json$/.test(value.path) && hash(value.sha256);
const sameAttempt = (before, archived) => object(archived) && Object.keys(before).filter(key => key !== "attemptHistory")
  .every(key => JSON.stringify(before[key]) === JSON.stringify(archived[key]))
  && Object.keys(archived).length === Object.keys(before).filter(key => key !== "attemptHistory").length;

export default defineHook({
  name: "gaia2-task-contract-commit", description: "Commits trusted visible-user obligations; controller candidates and elapsed time never complete a task by themselves.",
  // Historical artifacts remain readable; this legacy approval hook stays
  // disabled. Actor reconciliation lives in its separate control hook.
  enabled: false, checkpoint: "after_tool", trigger({ action }) { return action?.canonicalName === "CapybaraTaskContract__commit"; },
  schedule: { priority: 250, timeoutMs: 3000, onError: "block" }, permissions: { variables: "patch", artifacts: "write" },
  run({ variables, action, outcome, messages, clock, loop }) {
    if (action.effect !== "read" || action.resourceKey !== "CapybaraTaskContract" || action.authoritativeRead !== false
      || action.arguments?.op !== "state_update" || Object.keys(action.arguments).length !== 1 || outcome.status !== "succeeded") throw new Error("TASK_CONTRACT_CONTROL");
    const values = variables.builtin.variables, next = outcome.result?.taskContractState, prior = values.gaia2_task_contract_state;
    if (!object(next) || next.schemaVersion !== "gaia2-task-contract-state-v1" || next.enabled !== true
      || next.executionId !== loop.runId || !text(next.sessionId, 200) || !Number.isSafeInteger(next.revision) || next.revision < 0
      || next.clock !== null && (!finite(next.clock) || next.clock > clock.now)
      || next.interruption !== null && !["environment_stop", "cancelled", "budget_exhausted", "clock_error", "user_update"].includes(next.interruption)
      || !Array.isArray(next.sources) || next.sources.length > 64 || !Array.isArray(next.obligations) || next.obligations.length > 64
      || JSON.stringify(next).length > 128000) throw new Error("TASK_CONTRACT_STATE_SCHEMA");
    const users = new Map((messages || []).filter(item => item.role === "user" && item.notificationType === "USER_MESSAGE" && text(item.id, 200)).map(item => [item.id, item]));
    const sourceIds = new Set(), obligationIds = new Set();
    for (const source of next.sources) {
      const original = users.get(source.userRef);
      if (!original || sourceIds.has(source.userRef) || !hash(source.sourceHash) || !finite(source.arrivedAt) || source.arrivedAt > clock.now
        || !["registered", "reviewed_none", "ambiguous"].includes(source.resolution)
        || !["allow", "forbid_until_deadline", "forbid"].includes(source.notificationPolicy)
        || !Array.isArray(source.obligationIds) || source.obligationIds.length > 64
        || !reference(source.evidenceRef) || source.proposalRef !== null && !reference(source.proposalRef)
        || source.reviewRef !== null && !reference(source.reviewRef)
        || source.resolution !== "ambiguous" && (!reference(source.proposalRef) || !reference(source.reviewRef))) throw new Error("TASK_CONTRACT_USER_BINDING");
      sourceIds.add(source.userRef);
      const normalizationRefs = ["rawProposalRef", "normalizedProposalRef", "anchoringRef", "extractionRef"];
      if (normalizationRefs.some(key => source[key] !== undefined) && (normalizationRefs.some(key => source[key] !== null && !reference(source[key]))
        || source.resolution !== "ambiguous" && normalizationRefs.some(key => !reference(source[key]))
        || source.normalizedProposalRef !== null && JSON.stringify(source.normalizedProposalRef) !== JSON.stringify(source.proposalRef))) throw new Error("TASK_CONTRACT_NORMALIZATION_REFS");
      if (source.resolverAttempts !== undefined && (![1, 2].includes(source.resolverAttempts)
        || typeof source.resolverRetryable !== "boolean" || !Array.isArray(source.attemptHistory)
        || source.attemptHistory.length !== source.resolverAttempts - 1
        || source.resolverRetryable && (source.resolution !== "ambiguous" || source.resolverAttempts !== 1)
        || ![null, "semantic_ambiguous", "transport_error", "quote_error", "protocol_error", "integrity_or_validation_error"].includes(source.errorCategory)
        || source.attemptHistory.some(old => !object(old) || old.userRef !== source.userRef || old.sourceHash !== source.sourceHash
          || old.arrivedAt !== source.arrivedAt || old.resolution !== "ambiguous" || old.resolverRetryable !== true
          || old.resolverAttempts !== 1 || JSON.stringify(old.evidenceRef) !== JSON.stringify(source.evidenceRef)
          || normalizationRefs.concat(["proposalRef", "reviewRef"]).some(key => old[key] !== null && !reference(old[key]))))) throw new Error("TASK_CONTRACT_RESOLVER_HISTORY");
    }
    const observations = values.gaia2_observation_state.observations || [];
    for (const item of next.obligations) {
      const source = next.sources.find(source => source.userRef === item.userRef), original = users.get(item.userRef), span = item.span;
      const before = prior?.enabled === true ? prior.obligations.find(row => row.id === item.id) : null;
      if (!text(item.id, 200) || obligationIds.has(item.id) || !source || source.resolution !== "registered" || item.sourceHash !== source.sourceHash
        || !source.obligationIds.includes(item.id) || !object(span) || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)
        || span.start < 0 || span.end <= span.start || typeof original.content !== "string" || span.end > Array.from(original.content).length
        || span.text !== Array.from(original.content).slice(span.start, span.end).join("") || !text(span.text, 262144)
        || !["monitor_until", "condition_once"].includes(item.mode) || !finite(item.deadline) || item.deadline < source.arrivedAt
        || !text(item.goal) || !statuses.includes(item.status) || !object(item.counts)
        || (item.status === "satisfied" ? !["condition_satisfied", "deadline_reviewed"].includes(item.completionReason) : item.completionReason !== null)
        || ["watchCalls", "nativeWaits", "nativeScans"].some(key => !Number.isSafeInteger(item.counts[key]) || item.counts[key] < 0 || item.counts[key] > 4096)
        || item.lastSignal !== null && !text(item.lastSignal, 64) || item.lastReviewedActionId !== null && !text(item.lastReviewedActionId, 200)) throw new Error("TASK_CONTRACT_OBLIGATION_SCHEMA");
      obligationIds.add(item.id);
      if (item.recipe !== null && (!object(item.recipe) || !text(item.recipe.queryTool, 200) || !object(item.recipe.queryArguments) || !hash(item.recipe.queryHash)
        || !Number.isSafeInteger(item.recipe.intervalSeconds) || item.recipe.intervalSeconds < 1 || item.recipe.intervalSeconds > 900
        || !Number.isSafeInteger(item.recipe.maxScans) || item.recipe.maxScans < 1 || item.recipe.maxScans > 1000
        || JSON.stringify(item.recipe.queryArguments).length > 4096)) throw new Error("TASK_CONTRACT_RECIPE_SCHEMA");
      const boundNative = ref => {
        const observed = observations.find(row => row.actionId === ref?.actionId);
        return object(ref) && observed && item.recipe && observed.authoritativeRead === true && observed.outcomeStatus === "succeeded"
          && observed.complete === true && observed.viewComplete === true && ref.complete === true && ref.viewComplete === true
          && observed.canonicalName === item.recipe.queryTool && observed.queryHash === item.recipe.queryHash
          && ["canonicalName", "queryHash", "resultHash", "observedAt"].every(key => observed[key] === ref[key])
          && observed.observedAt >= source.arrivedAt && observed.observedAt <= clock.now;
      };
      if (item.pendingEvidence !== null && (!boundNative(item.pendingEvidence) || !reference(item.pendingEvidence.evidenceRef))) throw new Error("TASK_CONTRACT_NATIVE_EVIDENCE");
      if (item.status === "satisfied" && before?.status !== "satisfied") {
        const observed = observations.find(row => row.actionId === item.lastReviewedActionId);
        if (!observed || !boundNative({ ...observed, complete: observed.complete, viewComplete: observed.viewComplete })
          || item.mode === "monitor_until" && item.completionReason !== "deadline_reviewed"
          || item.completionReason === "deadline_reviewed" && (next.clock === null || next.clock < item.deadline || observed.observedAt < item.deadline)) throw new Error("TASK_CONTRACT_PREMATURE_COMPLETION");
      }
      if (before && (["userRef", "sourceHash", "mode", "deadline", "goal"].some(key => before[key] !== item[key])
        || JSON.stringify(before.span) !== JSON.stringify(item.span)
        || before.recipe !== null && JSON.stringify(before.recipe) !== JSON.stringify(item.recipe)
        || ["watchCalls", "nativeWaits", "nativeScans"].some(key => item.counts[key] < before.counts[key])
        || ["satisfied", "revoked"].includes(before.status) && (item.status !== before.status || item.lastReviewedActionId !== before.lastReviewedActionId || item.completionReason !== before.completionReason))) throw new Error("TASK_CONTRACT_OBLIGATION_ROLLBACK");
    }
    for (const source of next.sources) if (source.obligationIds.some(id => !obligationIds.has(id))) throw new Error("TASK_CONTRACT_SOURCE_COVERAGE");
    if (prior?.enabled === true) {
      if (prior.executionId !== next.executionId || prior.sessionId !== next.sessionId || next.revision < prior.revision
        || next.revision === prior.revision && JSON.stringify(next) !== JSON.stringify(prior)
        || prior.clock !== null && (next.clock === null || next.clock < prior.clock)
        || prior.sources.some(before => !next.sources.some(source => source.userRef === before.userRef && source.sourceHash === before.sourceHash
          && source.arrivedAt === before.arrivedAt && JSON.stringify(source.evidenceRef) === JSON.stringify(before.evidenceRef)
          && (JSON.stringify(source) === JSON.stringify(before)
            || before.resolution === "ambiguous" && before.resolverRetryable === true && before.resolverAttempts === 1
              && source.resolverAttempts === 2 && source.attemptHistory?.length === 1 && sameAttempt(before, source.attemptHistory[0]))))
        || prior.obligations.some(before => !obligationIds.has(before.id))) throw new Error("TASK_CONTRACT_STATE_ROLLBACK");
    }
    const pending = next.obligations.filter(item => !["satisfied", "revoked"].includes(item.status));
    const context = "User-bound waiting obligations: " + JSON.stringify({ sources: next.sources.map(source => ({ userRef: source.userRef, resolution: source.resolution, notificationPolicy: source.notificationPolicy })),
      obligations: next.obligations.map(item => ({ id: item.id, userRef: item.userRef, goal: item.goal.slice(0, 500), goalTruncated: item.goal.length > 500,
        mode: item.mode, deadline: item.deadline, status: item.status, completionReason: item.completionReason, queryTool: item.recipe?.queryTool || null, queryHash: item.recipe?.queryHash || null,
        pendingEvidence: item.pendingEvidence ? { actionId: item.pendingEvidence.actionId, observedAt: item.pendingEvidence.observedAt } : null,
        lastReviewedActionId: item.lastReviewedActionId, counts: item.counts, lastSignal: item.lastSignal })), interruption: next.interruption })
      + ". Candidates, initial observations, elapsed scan intervals and user updates do not complete monitor_until. Reaching a deadline still requires a fresh complete final native read and explicit review. completionReason=deadline_reviewed settles only the waiting window; it never asserts that a condition was met or the business task succeeded. Ordinary user updates do not revoke old obligations. Notification permission is independent; never call AUI while forbidden.";
    if (context.length > 64000) throw new Error("TASK_CONTRACT_CONTEXT_BOUND");
    return { patches: [
      { op: "replace", path: "/builtin/variables/gaia2_task_contract_state", value: next },
      { op: "replace", path: "/builtin/variables/gaia2_task_contract_context", value: context },
    ], artifacts: [{ title: "GAIA2 durable task contract", value: { revision: next.revision, sources: next.sources.length, pendingObligationIds: pending.map(item => item.id), interruption: next.interruption, businessSuccess: "not_inferred" } }] };
  },
});
