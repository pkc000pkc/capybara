import { createHash } from 'node:crypto'

function unit(seed, key) {
  const digest = createHash('sha256').update(`${seed}:${key}`).digest()
  return digest.readUInt32BE(0) / 0x1_0000_0000
}

/** Seeded, inspectable failure injector; it never changes config implicitly. */
export class NoiseAdapter {
  constructor({ seed, toolFailureProbability = 0, environmentEventRate = 0 } = {}) {
    if (!Number.isInteger(seed)) throw new Error('noise seed must be an integer')
    for (const [name, value] of Object.entries({ toolFailureProbability, environmentEventRate })) {
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`)
    }
    this.config = Object.freeze({ seed, toolFailureProbability, environmentEventRate })
    this.decisions = []
  }

  injectToolFailure(toolCallKey) {
    const injected = unit(this.config.seed, `tool:${toolCallKey}`) < this.config.toolFailureProbability
    this.decisions.push({ kind: 'tool_failure', key: toolCallKey, injected })
    return injected
  }

  injectEnvironmentEvent(eventKey) {
    const injected = unit(this.config.seed, `event:${eventKey}`) < this.config.environmentEventRate
    this.decisions.push({ kind: 'environment_event', key: eventKey, injected })
    return injected
  }

  snapshot() {
    return { config: this.config, decisions: structuredClone(this.decisions) }
  }
}
