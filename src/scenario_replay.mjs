import { EventBus } from './event_bus.mjs'
import { VirtualClock } from './virtual_clock.mjs'

/**
 * Trusted, no-model scenario replay used only for Gate 1 protocol smoke.
 * It replays event timing and dependency order while withholding all actions.
 */
export function replayScenario(imported) {
  const plan = imported.eventPlan
  const clock = new VirtualClock(Math.min(...plan.map((event) => event.scheduledAt)))
  const bus = new EventBus()
  bus.publishMany(plan.map((event) => ({
    id: event.id,
    type: event.type === 'USER' ? 'user' : event.type === 'ENV' ? 'environment' : 'oracle',
    scheduledAt: event.scheduledAt,
    dependencies: event.dependencies,
    source: 'gaia2-scenario',
  })))

  const observed = []
  let oracleWithheld = 0
  let consumed = 0
  while (consumed < plan.length) {
    let ready = bus.ready(clock.now())
    if (ready.length === 0) {
      const nextTime = plan
        .map((event) => event.scheduledAt)
        .filter((time) => time > clock.now())
        .sort((a, b) => a - b)[0]
      if (nextTime === undefined) throw new Error(`${imported.scenarioId}: event replay stalled`)
      clock.advanceTo(nextTime)
      ready = bus.ready(clock.now())
      if (ready.length === 0) throw new Error(`${imported.scenarioId}: no ready event at ${nextTime}`)
    }
    for (const event of ready) {
      bus.consume(event.occurrence)
      consumed += 1
      if (event.type === 'oracle') {
        oracleWithheld += 1
        continue
      }
      observed.push({ occurrence: event.occurrence, type: event.type, scheduledAt: event.scheduledAt })
    }
  }

  return {
    scenarioId: imported.scenarioId,
    capability: imported.capability,
    virtualStart: Math.min(...plan.map((event) => event.scheduledAt)),
    virtualEnd: clock.now(),
    plannedEvents: plan.length,
    consumedEvents: consumed,
    observedEvents: observed.length,
    oracleWithheld,
    trace: observed,
  }
}
