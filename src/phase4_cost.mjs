const ROLES = ['actor', 'judge', 'correction']
const KINDS = ['initial', 'training', 'replay']
const FIELDS = ['inputTokens', 'outputTokens', 'totalTokens']
function check(value, code) { if (!value) throw new Error(`Phase 4 operational usage: ${code}`) }

/** Observed SDK usage, not a provider invoice or inferred model pricing. */
export function aggregateOperationalUsage({ executions = [] } = {}) {
  const identities = new Set(), requests = new Set(), totals = {}, byKind = {}
  const fresh = () => ({ requestAttempts: 0, successfulCompletions: 0, failedRequests: 0, retriesScheduled: 0,
    usageReportedCompletions: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
    unknownInputTokenCompletions: 0, unknownOutputTokenCompletions: 0, unknownTotalTokenCompletions: 0 })
  for (const role of ROLES) totals[role] = fresh()
  for (const kind of KINDS) byKind[kind] = Object.fromEntries(ROLES.map(role => [role, fresh()]))
  let knownElapsedMs = 0, unknownElapsedExecutions = 0
  for (const execution of executions) {
    check(typeof execution.executionId === 'string' && execution.executionId && KINDS.includes(execution.kind)
      && !identities.has(execution.executionId) && Array.isArray(execution.events), 'execution identity')
    identities.add(execution.executionId)
    if (Number.isFinite(execution.elapsedMs) && execution.elapsedMs >= 0) knownElapsedMs += execution.elapsedMs
    else unknownElapsedExecutions++
    for (const event of execution.events) {
      if (!['model_request_attempt', 'model_request_succeeded', 'model_request_failed', 'model_retry_scheduled'].includes(event.type)) continue
      check(ROLES.includes(event.modelRole) && typeof event.requestId === 'string' && event.requestId, 'invalid model event identity')
      const entries = [totals[event.modelRole], byKind[execution.kind][event.modelRole]]
      const increment = (key, value = 1) => entries.forEach(entry => { check(Number.isSafeInteger(entry[key] + value), 'usage aggregate overflow'); entry[key] += value })
      if (event.type === 'model_request_attempt') increment('requestAttempts')
      if (event.type === 'model_request_failed') increment('failedRequests')
      if (event.type === 'model_retry_scheduled') increment('retriesScheduled')
      if (event.type !== 'model_request_succeeded') continue
      const requestIdentity = JSON.stringify([execution.executionId, event.modelRole, event.requestId])
      check(!requests.has(requestIdentity), 'duplicate successful completion'); requests.add(requestIdentity)
      increment('successfulCompletions')
      const usage = event.usage
      if (usage !== undefined) check(event.usageAvailable === true && usage && typeof usage === 'object' && !Array.isArray(usage)
        && Object.keys(usage).length > 0 && Object.keys(usage).every(key => FIELDS.includes(key))
        && Object.values(usage).every(value => Number.isSafeInteger(value) && value >= 0), 'unsafe usage')
      else check(event.usageAvailable !== true, 'missing reported usage')
      if (usage) increment('usageReportedCompletions')
      for (const field of FIELDS) {
        if (usage && Object.hasOwn(usage, field)) increment(field, usage[field])
        else increment(`unknown${field[0].toUpperCase()}${field.slice(1, -1)}Completions`)
      }
    }
  }
  const finalize = entry => {
    const value = { ...entry }
    value.reportedTokenSubtotals = Object.fromEntries(FIELDS.map(field => [field, entry[field]]))
    for (const field of FIELDS) if (entry[`unknown${field[0].toUpperCase()}${field.slice(1, -1)}Completions`]) value[field] = null
    return value
  }
  return { schemaVersion: 'gaia2-phase4-operational-usage-v1', executionCount: identities.size,
    byRole: Object.fromEntries(ROLES.map(role => [role, finalize(totals[role])])),
    byKind: Object.fromEntries(KINDS.map(kind => [kind, Object.fromEntries(ROLES.map(role => [role, finalize(byKind[kind][role])]))])),
    knownElapsedMs, unknownElapsedExecutions, totalElapsedMs: unknownElapsedExecutions ? null : knownElapsedMs,
    monetaryCost: null, monetaryCostStatus: 'provider_unit_prices_not_supplied', requestAttemptsAreSdkInvocationsNotHttpProof: true,
    correctionExecutionsCountedAsInitial: 0 }
}
