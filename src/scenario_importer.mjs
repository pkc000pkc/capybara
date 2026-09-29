import { createHash } from 'node:crypto'

const REQUIRED_KEYS = ['metadata', 'apps', 'events', 'version', 'augmentation']

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function validateEventGraph(events, capability, scenarioId) {
  const idToIndexes = new Map()
  for (const [index, event] of events.entries()) {
    assert(typeof event?.event_id === 'string' && event.event_id.length > 0,
      `${capability}/${scenarioId}: event has no event_id`)
    const indexes = idToIndexes.get(event.event_id) ?? []
    indexes.push(index)
    idToIndexes.set(event.event_id, indexes)
  }

  const graph = new Map(events.map((_, index) => [index, []]))
  for (const [index, event] of events.entries()) {
    const dependencies = event.dependencies ?? []
    assert(Array.isArray(dependencies), `${capability}/${scenarioId}: dependencies must be an array`)
    for (const dependency of dependencies) {
      const dependencyIndexes = idToIndexes.get(dependency)
      assert(dependencyIndexes, `${capability}/${scenarioId}: missing dependency ${dependency}`)
      graph.get(index).push(...dependencyIndexes)
    }
  }

  const visiting = new Set()
  const visited = new Set()
  function visit(index) {
    if (visited.has(index)) return
    assert(!visiting.has(index), `${capability}/${scenarioId}: event dependency cycle at ${events[index].event_id}`)
    visiting.add(index)
    for (const dependency of graph.get(index)) visit(dependency)
    visiting.delete(index)
    visited.add(index)
  }
  for (const index of graph.keys()) visit(index)

  return [...idToIndexes.values()].filter((indexes) => indexes.length > 1).length
}

/**
 * Validate a trusted dataset row and produce a deliberately small, safe view.
 * The raw JSON, app state, future events and oracle actions are not returned.
 */
export function importScenarioRow(row, capability) {
  assert(row && typeof row.scenario === 'string', `${capability}: row has no scenario JSON string`)
  let scenario
  try {
    scenario = JSON.parse(row.scenario)
  } catch (error) {
    throw new Error(`${capability}: scenario is not valid JSON: ${error.message}`)
  }
  assert(scenario && typeof scenario === 'object' && !Array.isArray(scenario),
    `${capability}: scenario must be an object`)
  for (const key of REQUIRED_KEYS) {
    assert(key in scenario, `${capability}: scenario is missing ${key}`)
  }
  assert(scenario.version === 'are_simulation_v1', `${capability}: unsupported scenario version ${scenario.version}`)
  assert(Array.isArray(scenario.apps) && scenario.apps.length > 0, `${capability}: apps must be nonempty`)
  assert(Array.isArray(scenario.events) && scenario.events.length > 0, `${capability}: events must be nonempty`)
  assert(scenario.augmentation && typeof scenario.augmentation === 'object' && !Array.isArray(scenario.augmentation),
    `${capability}: augmentation must be an object`)

  const definition = scenario.metadata?.definition
  assert(definition && typeof definition === 'object', `${capability}: metadata.definition is missing`)
  const scenarioId = definition.scenario_id
  assert(typeof scenarioId === 'string' && scenarioId.length > 0,
    `${capability}: scenario has no scenario ID`)
  assert(row.scenario_id === scenarioId,
    `${capability}/${scenarioId}: row and JSON scenario IDs disagree`)
  assert(Number.isFinite(definition.start_time) && definition.start_time >= 0,
    `${capability}/${scenarioId}: invalid start_time`)
  assert(Number.isFinite(definition.duration) && definition.duration > 0,
    `${capability}/${scenarioId}: invalid duration`)

  const appNames = new Set()
  const apps = scenario.apps.map((app) => {
    assert(typeof app?.name === 'string' && app.name.length > 0,
      `${capability}/${scenarioId}: app has no name`)
    assert(!appNames.has(app.name), `${capability}/${scenarioId}: duplicate app ${app.name}`)
    appNames.add(app.name)
    return { name: app.name }
  })
  const eventIdCollisionCount = validateEventGraph(scenario.events, capability, scenarioId)

  const eventTypes = {}
  for (const event of scenario.events) {
    const type = event.event_type ?? 'unknown'
    eventTypes[type] = (eventTypes[type] ?? 0) + 1
  }

  return {
    scenarioId,
    capability,
    version: scenario.version,
    sourceHash: createHash('sha256').update(row.scenario).digest('hex'),
    durationSeconds: definition.duration,
    startTime: definition.start_time,
    eventCount: scenario.events.length,
    eventIdCollisionCount,
    eventTypes,
    augmentationKeys: Object.keys(scenario.augmentation).sort(),
    agentView: {
      scenarioId,
      capability,
      startTime: definition.start_time,
      durationSeconds: definition.duration,
      apps,
    },
  }
}

export function summarizeScenario(imported) {
  return {
    capability: imported.capability,
    scenarioId: imported.scenarioId,
    sourceHash: imported.sourceHash,
    version: imported.version,
    appCount: imported.agentView.apps.length,
    eventCount: imported.eventCount,
    eventIdCollisionCount: imported.eventIdCollisionCount,
    eventTypes: imported.eventTypes,
    durationSeconds: imported.durationSeconds,
    startTime: imported.startTime,
    augmentationKeys: imported.augmentationKeys,
  }
}
