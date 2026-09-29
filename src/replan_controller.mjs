const STATES = new Set([
  'running', 'waiting_event', 'event_received', 'replanning', 'waiting_user',
  'approved', 'executing', 'verifying', 'completed', 'failed', 'paused',
])

function clone(value) {
  return structuredClone(value)
}

/** Minimal parent/child attempt controller for adaptability dry-runs. */
export class ReplanController {
  #nextId = 1
  #attempts = []

  start(plan) {
    if (!plan || !Array.isArray(plan.steps)) throw new Error('plan.steps is required')
    const attempt = {
      attemptId: `attempt-${this.#nextId++}`,
      parentAttemptId: null,
      state: 'running',
      reason: 'initial plan',
      plan: clone(plan),
      events: [],
    }
    this.#attempts.push(attempt)
    return clone(attempt)
  }

  receiveEvent(event) {
    const current = this.#current()
    this.#setState(current, 'event_received')
    current.events.push(clone(event))
    return clone(current)
  }

  replan(plan, reason) {
    const current = this.#current()
    if (!['event_received', 'replanning', 'paused', 'running'].includes(current.state)) {
      throw new Error(`cannot replan from ${current.state}`)
    }
    this.#setState(current, 'replanning')
    const child = {
      attemptId: `attempt-${this.#nextId++}`,
      parentAttemptId: current.attemptId,
      state: 'running',
      reason: reason || 'environment changed',
      plan: clone(plan),
      events: [],
    }
    this.#attempts.push(child)
    return clone(child)
  }

  setState(state) {
    if (!STATES.has(state)) throw new Error(`invalid attempt state ${state}`)
    const current = this.#current()
    this.#setState(current, state)
    return clone(current)
  }

  current() {
    return this.#attempts.length ? clone(this.#current()) : null
  }

  snapshot() {
    return { nextId: this.#nextId, attempts: clone(this.#attempts) }
  }

  restore(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.attempts)) throw new Error('invalid replan checkpoint')
    this.#nextId = snapshot.nextId ?? 1
    this.#attempts = clone(snapshot.attempts)
  }

  #current() {
    if (!this.#attempts.length) throw new Error('no active attempt')
    return this.#attempts[this.#attempts.length - 1]
  }

  #setState(attempt, state) {
    if (!STATES.has(state)) throw new Error(`invalid attempt state ${state}`)
    attempt.state = state
  }
}
