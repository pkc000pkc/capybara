import { digest } from './phase0_run.mjs'

export const STANDARD_CAPABILITIES = Object.freeze(['execution', 'search', 'adaptability', 'time', 'ambiguity'])
export const OFFICIAL_MINI_PROFILE = 'official-mini-v1'
const HASH = /^[a-f0-9]{64}$/
const check = (condition, code) => { if (!condition) throw new Error(`Phase 6 selection: ${code}`) }

/** Bind the actual pinned mini membership to its original Standard rows. */
export function buildStandardMiniMapping(index, scenarioIndexSha256) {
  check(Array.isArray(index) && HASH.test(scenarioIndexSha256 ?? ''), 'index_binding_invalid')
  const mini = index.filter(row => row.datasetKind === 'mini' && row.config === 'mini')
  const full = index.filter(row => row.datasetKind === 'submission' && STANDARD_CAPABILITIES.includes(row.config))
  check(mini.length === 160, 'mini_count_must_be_160')
  const fullById = new Map()
  for (const row of full) {
    check(typeof row.id === 'string' && row.id && !fullById.has(row.id), 'duplicate_or_invalid_full_id')
    fullById.set(row.id, row)
  }
  const ids = new Set(), hashes = new Set(), positions = new Set(), entries = []
  for (const row of mini) {
    check(typeof row.id === 'string' && row.id && !ids.has(row.id), 'duplicate_or_invalid_mini_id')
    check(HASH.test(row.scenarioHash ?? '') && !hashes.has(row.scenarioHash), 'duplicate_or_invalid_mini_hash')
    check(STANDARD_CAPABILITIES.includes(row.category), 'mini_capability_invalid')
    check(Number.isInteger(row.rowIndex) && row.rowIndex >= 0 && !positions.has(row.rowIndex), 'mini_position_invalid')
    const original = fullById.get(row.id)
    check(original, 'mini_id_missing_from_full')
    check(original.config === row.category, 'mini_capability_mismatch')
    check(original.scenarioHash === row.scenarioHash, 'mini_scenario_hash_mismatch')
    check(typeof row.scenarioVersion === 'string' && row.scenarioVersion && row.scenarioVersion === original.scenarioVersion, 'mini_scenario_version_mismatch')
    check(Number.isInteger(original.rowIndex) && original.rowIndex >= 0, 'standard_position_invalid')
    check(typeof row.path === 'string' && row.path && typeof original.path === 'string' && original.path, 'source_path_missing')
    ids.add(row.id); hashes.add(row.scenarioHash); positions.add(row.rowIndex)
    entries.push({ capability: row.category, scenarioId: row.id, scenarioHash: row.scenarioHash, scenarioVersion: row.scenarioVersion,
      mini: { rowIndex: row.rowIndex, sourcePath: row.path }, standard: { rowIndex: original.rowIndex, sourcePath: original.path } })
  }
  for (const capability of STANDARD_CAPABILITIES) check(entries.filter(row => row.capability === capability).length === 32, 'mini_capability_count_must_be_32')
  check([...positions].sort((a, b) => a - b).every((position, i) => position === i), 'mini_positions_not_contiguous')
  entries.sort((a, b) => STANDARD_CAPABILITIES.indexOf(a.capability) - STANDARD_CAPABILITIES.indexOf(b.capability) || a.standard.rowIndex - b.standard.rowIndex)
  const contents = { schemaVersion: 'gaia2-standard-mini-selection-v1', scenarioIndexSha256, perCapability: 32, count: 160, entries }
  return { ...contents, mappingHash: digest(contents) }
}

/** Explicit selectors always normalize to frozen manifest order; no state is edited. */
export function selectPhase6ExecutionIds(manifest, { executionIds = null, onlyPhase = null, onlyRunNumber = null, rule = null } = {}) {
  check(Array.isArray(manifest?.tasks) && manifest.tasks.length > 0, 'manifest_tasks_invalid')
  const allIds = manifest.tasks.map(task => task.executionId)
  check(allIds.every(id => typeof id === 'string' && id) && new Set(allIds).size === allIds.length, 'manifest_execution_ids_invalid')
  check(onlyPhase === null || ['standard', 'agent2agent', 'noise'].includes(onlyPhase), 'phase_invalid')
  check(onlyRunNumber === null || Number.isInteger(onlyRunNumber) && onlyRunNumber >= 1 && onlyRunNumber <= 5, 'run_number_invalid')
  let wanted = null
  if (rule !== null) {
    check(['standard-two-per-capability-run1-v1', 'official-mini-whole-v1', 'full-official-whole-v1'].includes(rule), 'selection_rule_invalid')
    check(executionIds === null && onlyPhase === null && onlyRunNumber === null, 'selection_rule_conflicts_with_filters')
    if (rule === 'standard-two-per-capability-run1-v1') {
      wanted = new Set()
      for (const capability of STANDARD_CAPABILITIES) {
        const rows = manifest.tasks.filter(task => task.phase === 'standard' && task.config === capability && task.runNumber === 1)
        check(rows.length >= 2 && new Set(rows.map(task => task.scenarioId)).size === rows.length, 'standard_probe_capability_insufficient')
        rows.slice(0, 2).forEach(task => wanted.add(task.executionId))
      }
      check(wanted.size === 10, 'standard_probe_must_have_ten_distinct_tasks')
    } else {
      const counts = Object.fromEntries(['standard', 'agent2agent', 'noise'].map(phase => [phase, manifest.tasks.filter(task => task.phase === phase).length]))
      if (rule === 'official-mini-whole-v1') check(manifest.mode === 'official_submission' && manifest.selection?.profile === OFFICIAL_MINI_PROFILE && manifest.selection?.standardMini?.count === 160
        && manifest.selection.standardMini.entries?.length === 160 && manifest.selection.fullOfficialCoverage === false && counts.standard === 480 && counts.agent2agent === 480 && counts.noise === 480, 'not_fixed_official_mini_plan')
      else check(manifest.mode === 'official_submission' && manifest.selection?.profile === undefined && manifest.selection?.fullOfficialCoverage === true
        && counts.standard === 2400 && counts.agent2agent === 480 && counts.noise === 480, 'not_full_official_plan')
    }
  } else if (executionIds !== null) {
    check(Array.isArray(executionIds) && executionIds.length > 0 && executionIds.every(id => typeof id === 'string' && id.trim() === id && id), 'execution_ids_invalid')
    check(new Set(executionIds).size === executionIds.length, 'duplicate_execution_id')
    wanted = new Set(executionIds)
    check(executionIds.every(id => allIds.includes(id)), 'unknown_execution_id')
    check(manifest.tasks.filter(task => wanted.has(task.executionId)).every(task => (onlyPhase === null || task.phase === onlyPhase) && (onlyRunNumber === null || task.runNumber === onlyRunNumber)), 'execution_id_filter_conflict')
  }
  const selected = manifest.tasks.filter(task => (!wanted || wanted.has(task.executionId)) && (onlyPhase === null || task.phase === onlyPhase) && (onlyRunNumber === null || task.runNumber === onlyRunNumber)).map(task => task.executionId)
  check(selected.length > 0, 'empty_selection')
  return selected
}

export function selectionIdentityHash(manifest, executionIds) {
  const ids = selectPhase6ExecutionIds(manifest, { executionIds })
  check(HASH.test(manifest.manifestHash ?? ''), 'manifest_hash_invalid')
  return digest({ manifestHash: manifest.manifestHash, executionIds: ids })
}
