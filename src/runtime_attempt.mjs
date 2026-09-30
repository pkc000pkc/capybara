import { createHash } from 'node:crypto'
import { EventBus } from './event_bus.mjs'
import { ObservationLedger } from './observation_ledger.mjs'
import { ReplanController } from './replan_controller.mjs'
import { VirtualClock } from './virtual_clock.mjs'
import { WriteActionLedger } from './write_action_ledger.mjs'
import { NoiseAdapter } from './noise_adapter.mjs'

function clone(value) {
  return structuredClone(value)
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** A composable, answer-blind GAIA2 single-attempt runtime. */
export class RuntimeAttempt {
  constructor({ scenarioId, capability, attemptIndex, seed, noiseProfile = 'off', staleAfterMs = 60_000 } = {}) {
    if (!scenarioId || !capability) throw new Error('scenarioId and capability are required')
    if (!Number.isInteger(attemptIndex) || attemptIndex < 1) throw new Error('attemptIndex must be positive')
    if (!Number.isInteger(seed)) throw new Error('seed must be an integer')
    this.scenarioId = scenarioId
    this.capability = capability
    this.attemptIndex = attemptIndex
    this.seed = seed
    this.noiseProfile = noiseProfile
    this.noiseSeed = seed ^ 0x9e3779b9
    this.clock = new VirtualClock(0)
    this.events = new EventBus()
    this.writes = new WriteActionLedger()
    this.replan = new ReplanController()
    this.observations = new ObservationLedger({ staleAfterMs })
    this.noise = new NoiseAdapter({ seed: this.noiseSeed, profile: noiseProfile })
    this.actions = []
    this.trace = []
    this.oracleWithheld = 0
    this.status = 'created'
  }

  async run({ eventPlan = [], plan = { steps: [] }, execute = null } = {}) {
    if (this.status !== 'created') throw new Error(`attempt cannot run from ${this.status}`)
    this.status = 'running'
    this.replan.start(plan)
    this.events.publishMany(eventPlan.map((event) => ({
      id: event.id ?? event.event_id,
      type: event.type ?? event.event_type ?? 'system',
      scheduledAt: event.scheduledAt ?? event.event_time ?? 0,
      dependencies: event.dependencies ?? [],
      source: event.source ?? 'scenario',
      payload: event.payload ?? null,
    })))
    let consumed = 0
    while (consumed < eventPlan.length) {
      let ready = this.events.ready(this.clock.now())
      if (!ready.length) {
        const next = eventPlan.map((event) => event.scheduledAt ?? event.event_time ?? 0)
          .filter((time) => time > this.clock.now()).sort((a, b) => a - b)[0]
        if (next === undefined) {
          this.status = 'failed'
          throw new Error('runtime event queue stalled')
        }
        this.clock.advanceTo(next)
        this.observations.setNow(this.clock.now())
        ready = this.events.ready(this.clock.now())
      }
      for (const event of ready) {
        if (!this.events.consume(event.occurrence)) continue
        consumed += 1
        if (event.type === 'AGENT' || event.type === 'ORACLE' || event.type === 'oracle') {
          this.oracleWithheld += 1
          this.trace.push({ type: 'oracle_withheld', id: event.id, at: this.clock.now() })
          continue
        }
        const observed = this.observe({
          kind: event.type === 'ENV' ? 'environment' : event.type === 'USER' ? 'user' : 'event',
          subject: event.id,
          eventId: event.id,
          source: event.source,
          content: event.payload,
          observedAt: this.clock.now(),
        })
        this.trace.push({ type: 'event', id: event.id, status: observed.status, at: this.clock.now() })
        if (execute) await execute(clone(event), this)
      }
    }
    this.status = 'completed'
    this.replan.setState('completed')
    return this.result()
  }

  observe(input) {
    const prepared = this.noise.transformObservation(input)
    const record = this.observations.observe(prepared)
    if (prepared.duplicateObservation) this.observations.observe({ ...prepared, duplicateObservation: false })
    return record
  }

  startWrite(input) {
    const unresolved = this.observations.unresolved({ subject: input.subject ?? null, affectsMutation: true })
    if (unresolved.length) throw new Error(`write blocked by unresolved observation: ${unresolved[0].status}`)
    const result = this.writes.start(input)
    this.actions.push({ type: 'write_start', actionId: input.actionId, duplicate: result.duplicate })
    return result
  }

  completeWrite(actionId, state = {}) {
    const result = this.writes.complete(actionId, state)
    this.actions.push({ type: 'write_complete', actionId, result: result.result })
    return result
  }

  failWrite(actionId, error, result = 'unknown') {
    const record = this.writes.fail(actionId, error, result)
    this.actions.push({ type: 'write_fail', actionId, result: record.result })
    return record
  }

  receiveEvent(event) {
    this.replan.receiveEvent(event)
    return this.observe({ kind: 'environment', subject: event.id, source: event.source ?? 'runtime', content: event.payload ?? event })
  }

  /** Record an evaluator-blind event emitted by an external execution bridge. */
  recordHookEvent(event = {}) {
    const type = String(event.type ?? 'hook_event')
    const subject = event.subject ?? event.function ?? type
    const observed = this.observe({
      kind: event.kind ?? 'runtime',
      subject,
      source: event.source ?? 'official-are',
      content: event.content ?? null,
      observedAt: this.clock.now(),
    })
    this.trace.push({ type: 'hook_event', eventType: type, subject, status: observed.status, at: this.clock.now() })
    return observed
  }

  requestReplan(plan, reason) {
    const result = this.replan.replan(plan, reason)
    this.trace.push({ type: 'replan', attemptId: result.attemptId, parentAttemptId: result.parentAttemptId, reason })
    return result
  }

  checkpoint() {
    const state = this.snapshot()
    return { state, stateHash: hash(state) }
  }

  snapshot() {
    return {
      scenarioId: this.scenarioId,
      capability: this.capability,
      attemptIndex: this.attemptIndex,
      seed: this.seed,
      noiseProfile: this.noiseProfile,
      noiseSeed: this.noiseSeed,
      status: this.status,
      clock: this.clock.snapshot(),
      events: this.events.snapshot(),
      writes: this.writes.snapshot(),
      replan: this.replan.snapshot(),
      observations: this.observations.snapshot(),
      noise: this.noise.snapshot(),
      actions: clone(this.actions),
      trace: clone(this.trace),
      oracleWithheld: this.oracleWithheld,
    }
  }

  result() {
    const snapshot = this.snapshot()
    return {
      scenarioId: this.scenarioId,
      capability: this.capability,
      attemptIndex: this.attemptIndex,
      seed: this.seed,
      noiseSeed: this.noiseSeed,
      status: this.status,
      traceHash: hash(snapshot.trace),
      stateHash: hash(snapshot),
      consumedEvents: snapshot.events.consumed.length,
      oracleWithheld: this.oracleWithheld,
      observationSummary: this.observations.summary(),
      noise: this.noise.summary(),
      actions: clone(this.actions),
    }
  }
}
