/**
 * Small, read-only GAIA2 scenario adapter.
 *
 * The original row is never mutated.  This is intentionally limited to the
 * phase-1 contract: identify a scenario, retain its official JSON, and expose
 * a compact summary for preflight/smoke reporting.
 */
export function importScenarioRow(row, capability) {
  if (!row || typeof row.scenario !== 'string') {
    throw new Error(`${capability}: first row has no scenario JSON string`)
  }

  let scenario
  try {
    scenario = JSON.parse(row.scenario)
  } catch (error) {
    throw new Error(`${capability}: scenario is not valid JSON: ${error.message}`)
  }

  for (const key of ['metadata', 'apps', 'events', 'version', 'augmentation']) {
    if (!(key in scenario)) throw new Error(`${capability}: scenario is missing ${key}`)
  }

  const metadata = scenario.metadata ?? {}
  const definition = metadata.definition ?? metadata
  const scenarioId = row.scenario_id ?? definition.scenario_id ?? metadata.scenario_id
  if (!scenarioId) throw new Error(`${capability}: scenario has no scenario ID`)

  return {
    scenarioId,
    capability,
    source: scenario,
    sourceRow: row,
    durationSeconds: definition.duration ?? null,
    startTime: definition.start_time ?? null,
  }
}

export function summarizeScenario(imported) {
  const { source: scenario } = imported
  const events = Array.isArray(scenario.events) ? scenario.events : []
  const eventTypes = {}
  for (const event of events) {
    const type = event.event_type ?? event.eventType ?? event.type ?? 'unknown'
    eventTypes[type] = (eventTypes[type] ?? 0) + 1
  }

  return {
    capability: imported.capability,
    scenarioId: imported.scenarioId,
    topLevelKeys: Object.keys(scenario).sort(),
    appCount: Array.isArray(scenario.apps) ? scenario.apps.length : 0,
    eventCount: events.length,
    eventTypes,
    durationSeconds: imported.durationSeconds,
    startTime: imported.startTime,
    augmentationKeys: Object.keys(scenario.augmentation ?? {}).sort(),
  }
}
