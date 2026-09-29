import { createHash } from 'node:crypto'

function unit(seed, key) {
  const digest = createHash('sha256').update(`${seed}:${key}`).digest()
  return digest.readUInt32BE(0) / 0x1_0000_0000
}

/** Seeded, inspectable failure injector; it never changes config implicitly. */
export class NoiseAdapter {
  constructor({ seed, profile = 'off', toolFailureProbability = 0, environmentEventRate = 0,
    duplicateRate = 0, truncationRate = 0, staleRate = 0, conflictRate = 0 } = {}) {
    if (!Number.isInteger(seed)) throw new Error('noise seed must be an integer')
    for (const [name, value] of Object.entries({ toolFailureProbability, environmentEventRate, duplicateRate, truncationRate, staleRate, conflictRate })) {
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`)
    }
    const defaults = profile === 'information-noise'
      ? { duplicateRate: 0.15, truncationRate: 0.1, staleRate: 0.1, conflictRate: 0.1 }
      : {}
    this.config = Object.freeze({ seed, profile, toolFailureProbability, environmentEventRate,
      duplicateRate: duplicateRate !== 0 ? duplicateRate : (defaults.duplicateRate || 0),
      truncationRate: truncationRate !== 0 ? truncationRate : (defaults.truncationRate || 0),
      staleRate: staleRate !== 0 ? staleRate : (defaults.staleRate || 0),
      conflictRate: conflictRate !== 0 ? conflictRate : (defaults.conflictRate || 0) })
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

  transformObservation(observation = {}) {
    const key = observation.fingerprint || observation.eventId || observation.subject || JSON.stringify(observation.content ?? null)
    const duplicate = unit(this.config.seed, `duplicate:${key}`) < this.config.duplicateRate
    const truncate = unit(this.config.seed, `truncate:${key}`) < this.config.truncationRate
    const stale = unit(this.config.seed, `stale:${key}`) < this.config.staleRate
    const conflict = unit(this.config.seed, `conflict:${key}`) < this.config.conflictRate
    const decision = { kind: 'observation_noise', key, duplicate, truncate, stale, conflict }
    this.decisions.push(decision)
    const transformed = { ...observation }
    if (duplicate) transformed.duplicateObservation = true
    if (truncate) { transformed.truncated = true; transformed.complete = false }
    if (stale && Number.isFinite(observation.observedAt)) transformed.sourceTimestamp = observation.observedAt - 1_000_000
    if (conflict) {
      transformed.conflictKey = observation.conflictKey || observation.subject || key
      transformed.content = { injectedConflict: true, original: observation.content ?? null }
    }
    return transformed
  }

  summary() {
    const decisions = this.decisions.filter((item) => item.kind === 'observation_noise')
    return {
      profile: this.config.profile,
      seed: this.config.seed,
      decisions: this.decisions.length,
      injected: decisions.filter((item) => Object.values(item).some((value) => value === true)).length,
      duplicate: decisions.filter((item) => item.duplicate).length,
      truncated: decisions.filter((item) => item.truncate).length,
      stale: decisions.filter((item) => item.stale).length,
      conflicting: decisions.filter((item) => item.conflict).length,
    }
  }

  snapshot() {
    const config = this.config.profile === 'off' && this.config.duplicateRate === 0
      && this.config.truncationRate === 0 && this.config.staleRate === 0 && this.config.conflictRate === 0
      ? { seed: this.config.seed, toolFailureProbability: this.config.toolFailureProbability, environmentEventRate: this.config.environmentEventRate }
      : this.config
    return { config, decisions: structuredClone(this.decisions) }
  }
}
