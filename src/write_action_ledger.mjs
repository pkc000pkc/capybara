import { createHash } from 'node:crypto'

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * In-memory write trace and mutation-key ledger. It is deliberately agnostic
 * about app state and can later be backed by the experiment store.
 */
export class WriteActionLedger {
  #actions = new Map()
  #byMutationKey = new Map()

  findByMutationKey(mutationKey) {
    const actionId = this.#byMutationKey.get(mutationKey)
    return actionId ? structuredClone(this.#actions.get(actionId)) : null
  }

  start({ actionId, toolName, operation, args, parentActionIds = [], mutationKey = null }) {
    if (!actionId || !toolName || !operation) throw new Error('actionId, toolName and operation are required')
    if (this.#actions.has(actionId)) throw new Error(`duplicate actionId ${actionId}`)
    if (mutationKey && this.#byMutationKey.has(mutationKey)) {
      const existing = this.findByMutationKey(mutationKey)
      if (existing.result === 'success') return { duplicate: true, action: existing }
      throw new Error(`mutation ${mutationKey} already has result ${existing.result}`)
    }
    const action = {
      actionId,
      toolName,
      operation,
      argsHash: hash(args ?? null),
      startedAt: new Date().toISOString(),
      parentActionIds: [...parentActionIds],
      mutationKey,
      result: 'unknown',
    }
    this.#actions.set(actionId, action)
    if (mutationKey) this.#byMutationKey.set(mutationKey, actionId)
    return { duplicate: false, action: structuredClone(action) }
  }

  complete(actionId, { beforeState, afterState } = {}) {
    const action = this.#require(actionId)
    action.completedAt = new Date().toISOString()
    action.beforeStateHash = beforeState === undefined ? undefined : hash(beforeState)
    action.afterStateHash = afterState === undefined ? undefined : hash(afterState)
    action.result = 'success'
    return structuredClone(action)
  }

  fail(actionId, error, result = 'failed') {
    const action = this.#require(actionId)
    if (!['failed', 'unknown'].includes(result)) throw new Error('invalid failure result')
    action.completedAt = new Date().toISOString()
    action.error = String(error?.message ?? error)
    action.result = result
    return structuredClone(action)
  }

  snapshot() {
    return [...this.#actions.values()].map((action) => structuredClone(action))
  }

  #require(actionId) {
    const action = this.#actions.get(actionId)
    if (!action) throw new Error(`unknown actionId ${actionId}`)
    return action
  }
}
