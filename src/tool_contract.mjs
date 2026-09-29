const EFFECTS = new Set(['read', 'write', 'delete', 'message', 'external'])
const SCOPES = new Set(['call', 'scenario', 'session', 'project'])

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Validate the small effect/idempotency contract used by the action ledger. */
export function defineToolContract(name, input = {}) {
  assert(typeof name === 'string' && name.length > 0, 'tool name is required')
  const effects = [...new Set(input.effects ?? ['read'])]
  assert(effects.length > 0 && effects.every((effect) => EFFECTS.has(effect)), `${name}: invalid effects`)
  const processScope = input.processScope ?? 'call'
  assert(SCOPES.has(processScope), `${name}: invalid processScope`)
  const idempotent = input.idempotent === true
  const maxRetries = input.maxRetries ?? 0
  assert(Number.isInteger(maxRetries) && maxRetries >= 0, `${name}: maxRetries must be a non-negative integer`)
  const hasMutation = effects.some((effect) => effect !== 'read')
  if (hasMutation && !idempotent && maxRetries > 0) {
    throw new Error(`${name}: non-idempotent mutation cannot enable automatic retries`)
  }
  return Object.freeze({
    name,
    effects: Object.freeze(effects),
    idempotent,
    retryableErrors: Object.freeze([...(input.retryableErrors ?? [])]),
    maxRetries,
    timeoutMs: input.timeoutMs ?? 30_000,
    requiresApproval: input.requiresApproval === true,
    compensationTool: input.compensationTool ?? null,
    triggersEvents: input.triggersEvents === true,
    processScope,
  })
}

export function canRetry(contract, { resultKnown }) {
  if (resultKnown) return contract.maxRetries > 0
  if (contract.effects.every((effect) => effect === 'read')) return contract.maxRetries > 0
  return contract.idempotent && contract.maxRetries > 0
}
