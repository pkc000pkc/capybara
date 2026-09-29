/** In-memory, deterministic event queue with dependency and deduplication semantics. */
export class EventBus {
  #events = new Map()
  #consumed = new Set()
  #sequence = 0

  publish(event) {
    if (!event || typeof event.id !== 'string' || !event.id) throw new Error('event id is required')
    const occurrence = `${event.id}#${this.#sequence++}`
    this.#events.set(occurrence, {
      occurrence,
      id: event.id,
      type: event.type ?? 'system',
      scheduledAt: event.scheduledAt ?? 0,
      dependencies: [...(event.dependencies ?? [])],
      source: event.source ?? 'unknown',
      payload: event.payload ?? null,
    })
    return occurrence
  }

  publishMany(events) {
    return events.map((event) => this.publish(event))
  }

  ready(now) {
    return [...this.#events.values()]
      .filter((event) => !this.#consumed.has(event.occurrence))
      .filter((event) => event.scheduledAt <= now)
      .filter((event) => event.dependencies.every((dependency) =>
        [...this.#events.values()].some((candidate) => candidate.id === dependency && this.#consumed.has(candidate.occurrence))))
      .sort((a, b) => a.scheduledAt - b.scheduledAt || a.occurrence.localeCompare(b.occurrence))
      .map((event) => structuredClone(event))
  }

  consume(occurrence) {
    if (!this.#events.has(occurrence)) throw new Error(`unknown event occurrence ${occurrence}`)
    if (this.#consumed.has(occurrence)) return false
    this.#consumed.add(occurrence)
    return true
  }

  snapshot() {
    return {
      sequence: this.#sequence,
      events: [...this.#events.values()],
      consumed: [...this.#consumed],
    }
  }

  restore(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.events) || !Array.isArray(snapshot.consumed)) {
      throw new Error('invalid event bus checkpoint')
    }
    this.#sequence = snapshot.sequence ?? snapshot.events.length
    this.#events = new Map(snapshot.events.map((event) => [event.occurrence, structuredClone(event)]))
    this.#consumed = new Set(snapshot.consumed)
  }
}
