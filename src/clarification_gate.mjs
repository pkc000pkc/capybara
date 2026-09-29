/** Minimal ambiguity/approval gate with explicit waiting_user state. */
export class ClarificationGate {
  #pending = new Map()
  #nextId = 1

  request({ question, reason, safeActions = [] }) {
    if (!question || !reason) throw new Error('clarification question and reason are required')
    const id = `clarification-${this.#nextId++}`
    const item = {
      id,
      state: 'waiting_user',
      question,
      reason,
      safeActions: [...safeActions],
      requestedAt: new Date().toISOString(),
    }
    this.#pending.set(id, item)
    return structuredClone(item)
  }

  answer(id, answer) {
    const item = this.#pending.get(id)
    if (!item) throw new Error(`unknown clarification ${id}`)
    if (typeof answer !== 'string' || answer.trim().length === 0) {
      throw new Error('clarification answer cannot be empty')
    }
    item.state = 'approved'
    item.answer = answer.trim()
    item.answeredAt = new Date().toISOString()
    this.#pending.delete(id)
    return structuredClone(item)
  }

  snapshot() {
    return { nextId: this.#nextId, pending: [...this.#pending.values()] }
  }

  restore(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.pending)) throw new Error('invalid clarification checkpoint')
    this.#nextId = snapshot.nextId ?? 1
    this.#pending = new Map(snapshot.pending.map((item) => [item.id, structuredClone(item)]))
  }
}
