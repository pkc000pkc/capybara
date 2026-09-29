import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Minimal durable-shaped checkpoint store; replace with backend storage later. */
export class CheckpointStore {
  #filePath
  #latest = null

  constructor(filePath = null) {
    this.#filePath = filePath
  }

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
    if (this.#filePath) {
      mkdirSync(dirname(this.#filePath), { recursive: true })
      const temporary = `${this.#filePath}.tmp`
      writeFileSync(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`)
      renameSync(temporary, this.#filePath)
    }
    return structuredClone(checkpoint)
  }

  load() {
    if (this.#filePath && existsSync(this.#filePath)) {
      this.#latest = JSON.parse(readFileSync(this.#filePath, 'utf8'))
    }
    return this.#latest ? structuredClone(this.#latest) : null
  }
}
