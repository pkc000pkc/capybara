/** Small request/response A2A channel with capability and request de-duplication. */
export class A2AChannel {
  #agents = new Map()
  #requests = new Map()

  register({ agentId, capabilities = [] }, handler) {
    if (!agentId || !Array.isArray(capabilities) || typeof handler !== 'function') {
      throw new Error('agentId, capabilities and handler are required')
    }
    if (this.#agents.has(agentId)) throw new Error(`duplicate agent ${agentId}`)
    this.#agents.set(agentId, { agentId, capabilities: new Set(capabilities), handler })
  }

  async request({ requestId, from, to, capability, payload, timeoutMs = 10_000 }) {
    if (!requestId || !from || !to || !capability) throw new Error('requestId, from, to and capability are required')
    const prior = this.#requests.get(requestId)
    if (prior) return structuredClone(prior)
    const target = this.#agents.get(to)
    if (!target) throw new Error(`unknown agent ${to}`)
    if (!target.capabilities.has(capability)) throw new Error(`${to} does not provide ${capability}`)
    const controller = new AbortController()
    const record = { requestId, from, to, capability, state: 'pending' }
    this.#requests.set(requestId, record)
    let timeout
    try {
      const response = await Promise.race([
        Promise.resolve(target.handler({ requestId, from, capability, payload: structuredClone(payload), signal: controller.signal })),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('A2A request timeout')), timeoutMs)
        }),
      ])
      record.state = 'fulfilled'
      record.response = structuredClone(response)
    } catch (error) {
      record.state = 'failed'
      record.error = String(error?.message ?? error)
    } finally {
      clearTimeout(timeout)
    }
    return structuredClone(record)
  }

  cancel(requestId) {
    const record = this.#requests.get(requestId)
    if (!record) throw new Error(`unknown request ${requestId}`)
    if (record.state === 'pending') record.state = 'cancelled'
    return structuredClone(record)
  }

  snapshot() {
    return { requests: [...this.#requests.values()].map((record) => structuredClone(record)) }
  }
}
