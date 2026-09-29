import { createHash } from 'node:crypto'

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Minimal durable-shaped checkpoint store; replace with backend storage later. */
export class CheckpointStore {
  #latest = null

  save(state) {
    if (!state || typeof state !== 'object') throw new Error('checkpoint state must be an object')
    const snapshot = structuredClone(state)
    const checkpoint = {
      version: 1,
      savedAt: new Date().toISOString(),
      state: snapshot,
      stateHash: digest(snapshot),
    }
    this.#latest = checkpoint
    return structuredClone(checkpoint)
  }

  load() {
    return this.#latest ? structuredClone(this.#latest) : null
  }
}
