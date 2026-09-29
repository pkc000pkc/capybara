/** Deterministic virtual clock for scenario tests; it never sleeps wall time. */
export class VirtualClock {
  #now
  #nextId = 1
  #waits = new Map()

  constructor(startTime = 0) {
    if (!Number.isFinite(startTime)) throw new Error('startTime must be finite')
    this.#now = startTime
  }

  now() {
    return this.#now
  }

  scheduleCallback(timestamp, callback) {
    if (!Number.isFinite(timestamp) || timestamp < this.#now) {
      throw new Error('callback timestamp must be finite and not before current time')
    }
    const id = `wait-${this.#nextId++}`
    this.#waits.set(id, { id, timestamp, callback, kind: 'callback' })
    return id
  }

  waitUntil(timestamp) {
    let waitId
    const promise = new Promise((resolve, reject) => {
      if (!Number.isFinite(timestamp) || timestamp < this.#now) {
        reject(new Error('wait timestamp must be finite and not before current time'))
        return
      }
      waitId = `wait-${this.#nextId++}`
      this.#waits.set(waitId, { id: waitId, timestamp, resolve, kind: 'promise' })
    })
    promise.waitId = waitId
    return promise
  }

  reattachWait(id) {
    const wait = this.#waits.get(id)
    if (!wait || wait.kind !== 'promise') throw new Error(`unknown promise wait ${id}`)
    return new Promise((resolve) => {
      wait.resolve = resolve
      if (wait.timestamp <= this.#now) {
        this.#waits.delete(id)
        resolve(this.#now)
      }
    })
  }

  cancelWait(id) {
    return this.#waits.delete(id)
  }

  advanceTo(timestamp) {
    if (!Number.isFinite(timestamp) || timestamp < this.#now) {
      throw new Error('virtual clock can only advance monotonically')
    }
    this.#now = timestamp
    const due = [...this.#waits.values()]
      .filter((wait) => wait.timestamp <= this.#now)
      .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
    for (const wait of due) {
      if (wait.kind === 'promise' && !wait.resolve) continue
      this.#waits.delete(wait.id)
      if (wait.kind === 'promise') wait.resolve(this.#now)
      else wait.callback({ id: wait.id, timestamp: wait.timestamp, now: this.#now })
    }
    return due.map(({ id, timestamp }) => ({ id, timestamp }))
  }

  snapshot() {
    return {
      now: this.#now,
      nextId: this.#nextId,
      pendingWaits: [...this.#waits.values()].map(({ id, timestamp, kind }) => ({ id, timestamp, kind })),
    }
  }

  restore(snapshot) {
    if (!snapshot || !Number.isFinite(snapshot.now)) throw new Error('invalid clock checkpoint')
    this.#now = snapshot.now
    this.#nextId = snapshot.nextId ?? 1
    this.#waits.clear()
    for (const wait of snapshot.pendingWaits ?? []) {
      this.#waits.set(wait.id, wait.kind === 'callback'
        ? { ...wait, callback: () => {} }
        : { ...wait, resolve: null })
    }
  }
}
