import { defineHook } from "@capybara-agent/sdk";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.length > 0 && value.length <= 512;
const uncertain = new Set(["failed", "incomplete", "stale", "conflicting"]);

/**
 * Bridges an explicit temporal candidate signal to the Noise candidate
 * ledger.  The signal is deliberately a review boundary: it never marks a
 * task or an obligation satisfied, and it refuses evidence quarantined by the
 * native observation ledger.
 */
export default defineHook({
  name: "gaia2-noise-candidate-bridge",
  description: "Promotes only an explicit current candidate signal into a review-pending obligation.",
  enabled: true, checkpoint: "after_tool",
  activation: { canonicalNames: ["CapybaraTemporal__watch"] },
  trigger({ action, outcome }) {
    return action?.canonicalName === "CapybaraTemporal__watch"
      && outcome?.status === "succeeded"
      && outcome?.result?.signal?.kind === "candidate_changed";
  },
  schedule: { priority: 247, timeoutMs: 3000, onError: "block" },
  permissions: { variables: "patch", artifacts: "write" },
  run({ variables, outcome, clock, loop }) {
    const values = variables.builtin.variables;
    const result = outcome.result;
    const ref = result.lastEvidenceRef || result.state?.lastEvidenceRef || result.observation || result.signal?.observation;
    const observations = values.gaia2_observation_state?.observations || [];
    const row = observations.find(item => item.actionId === ref?.actionId);
    if (!object(row) || !text(row.observationId) || row.actionId !== ref.actionId
      || row.canonicalName !== ref.canonicalName || row.queryHash !== ref.queryHash
      || row.resultHash !== ref.resultHash || row.observedAt !== ref.observedAt
      || row.complete !== true || row.viewComplete !== true || uncertain.has(row.status)) {
      const noise = values.gaia2_noise_state || {};
      const old = noise.candidateLedger;
      const reason = !row ? "native_reference_missing" : uncertain.has(row.status) ? row.status : "candidate_reference_incomplete";
      const entries = old ? [...(old.retained || []), ...(old.candidates || []), ...(old.quarantined || [])] : [];
      const updated = row ? entries.map(item => item.observationId === row.observationId
        ? { ...item, status: "quarantined", quarantineReason: reason, candidateAt: item.candidateAt || null } : item) : entries;
      const ledger = old && row ? { ...old, revision: Number(old.revision || 0) + 1,
        retained: updated.filter(item => item.status === "retained").slice(-256),
        candidates: updated.filter(item => item.status === "candidate" || item.status === "reviewed").slice(-256),
        quarantined: updated.filter(item => item.status === "quarantined").slice(-256) } : null;
      return { patches: ledger ? [{ op: "replace", path: "/builtin/variables/gaia2_noise_state", value: { ...noise, candidateLedger: ledger } }] : [], artifacts: [{ title: "GAIA2 candidate quarantined", value: {
        signal: "candidate_changed", actionId: ref?.actionId || null,
        reason,
        businessSuccess: "not_inferred",
      } }] };
    }
    const noise = values.gaia2_noise_state || {};
    const old = noise.candidateLedger || { schemaVersion: "gaia2-noise-candidate-ledger-v1", revision: 0, retained: [], candidates: [], quarantined: [] };
    const all = [...(old.retained || []), ...(old.candidates || []), ...(old.quarantined || [])].filter(item => item.observationId !== row.observationId);
    const prior = [...(old.retained || []), ...(old.candidates || []), ...(old.quarantined || [])].find(item => item.observationId === row.observationId);
    const temporalUserRef = result.state?.userRef || null;
    const window = values.gaia2_window_obligation_state;
    const matching = (window?.obligations || []).filter(item => (item.status === "pending" || item.status === "window_expired_unreviewed" || item.status === "candidate_pending_review")
      && (!temporalUserRef || item.userRef === temporalUserRef));
    const obligationIds = matching.map(item => item.id).slice(-64);
    const candidate = { candidateId: prior?.candidateId || "candidate-" + row.observationId,
      observationId: row.observationId, actionId: row.actionId, resourceKey: row.resourceKey,
      canonicalName: row.canonicalName, queryHash: row.queryHash, resultHash: row.resultHash,
      observedAt: row.observedAt, status: "candidate", source: "temporal_candidate_signal",
      retainedAt: prior?.retainedAt ?? row.observedAt, candidateAt: clock.now,
      quarantineReason: null, obligationIds: [...new Set([...(prior?.obligationIds || []), ...obligationIds])].slice(-64), review: null };
    all.push(candidate);
    const ledger = { schemaVersion: "gaia2-noise-candidate-ledger-v1", revision: Number(old.revision || 0) + 1,
      retained: all.filter(item => item.status === "retained").slice(-256),
      candidates: all.filter(item => item.status === "candidate" || item.status === "reviewed").slice(-256),
      quarantined: all.filter(item => item.status === "quarantined").slice(-256) };
    const evidence = { candidateId: candidate.candidateId, observationId: row.observationId,
      actionId: row.actionId, canonicalName: row.canonicalName, queryHash: row.queryHash,
      resultHash: row.resultHash, observedAt: row.observedAt, complete: true, viewComplete: true };
    const patches = [{ op: "replace", path: "/builtin/variables/gaia2_noise_state", value: { ...noise, candidateLedger: ledger } }];
    if (window?.enabled === true && candidate.obligationIds.length) {
      const next = { ...window, revision: Number.isSafeInteger(window.revision) ? window.revision + 1 : 1,
        areNow: clock.now, obligations: (window.obligations || []).map(item => candidate.obligationIds.includes(item.id)
          && !["window_completed", "user_interrupted", "cancelled", "technical_termination"].includes(item.status)
          ? { ...item, status: "candidate_pending_review", candidateEvidence: evidence, lastSignal: "candidate_changed" } : item) };
      patches.push({ op: "replace", path: "/builtin/variables/gaia2_window_obligation_state", value: next },
        { op: "replace", path: "/builtin/variables/gaia2_window_obligation_context", value: "A complete current native observation is a candidate pending explicit Actor review. It is not business completion. " + JSON.stringify({ candidateId: candidate.candidateId, obligationIds: candidate.obligationIds }) });
    }
    return { patches, artifacts: [{ title: "GAIA2 retained candidate ledger", value: { candidateId: candidate.candidateId,
      observationId: candidate.observationId, status: candidate.status, obligationIds: candidate.obligationIds,
      executionId: loop?.runId || null, businessSuccess: "not_inferred" } }] };
  },
});
