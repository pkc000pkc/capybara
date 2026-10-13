import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRunManifest, digest, parseIndex, readJson } from '../src/phase0_run.mjs'
import { validateRunManifest, validateSchema } from '../src/phase0_audit.mjs'
import { validateExportPlan } from '../src/phase2_export.mjs'
import { buildStandardMiniMapping, OFFICIAL_MINI_PROFILE, selectPhase6ExecutionIds, selectionIdentityHash, STANDARD_CAPABILITIES } from '../src/phase6_selection.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const protocol = readJson(join(root, 'config/phase0-protocol.json'))
const refs = Object.fromEntries(['protocol', 'environment', 'capabilities', 'dataset', 'scenarioIndex'].map(key => [key, { path: key, sha256: 'a'.repeat(64) }]))
function fixture() {
  const index = []
  for (const config of STANDARD_CAPABILITIES) for (let rowIndex = 0; rowIndex < 160; rowIndex++) index.push({ datasetKind: 'submission', config, id: `${config}-${rowIndex}`, path: `data/submission/${config}.parquet`, rowIndex, scenarioHash: digest([config, rowIndex]), scenarioVersion: 'are_simulation_v1' })
  const mini = index.filter(row => row.rowIndex >= 64 && row.rowIndex < 96).map((row, rowIndex) => ({ ...row, datasetKind: 'mini', config: 'mini', category: row.config, path: 'data/submission/mini.parquet', rowIndex }))
  return [...index, ...mini]
}
const seal = value => ({ ...value, manifestHash: digest(value) })
function build(options = {}) { return buildRunManifest({ root, protocol, index: fixture(), lockRefs: refs, entrypoints: { entries: [], environmentOverrides: {} }, mode: 'official_submission', runId: 'mini-selection-test', ...options }) }

test('fixed official mini uses actual membership, not the first 32 full rows', () => {
  const manifest = seal(build({ selectionProfile: OFFICIAL_MINI_PROFILE }))
  assert.equal(manifest.tasks.length, 1440)
  assert.equal(manifest.tasks.filter(t => t.phase === 'standard').length, 480)
  assert.equal(manifest.tasks.filter(t => t.phase === 'agent2agent').length, 480)
  assert.equal(manifest.tasks.filter(t => t.phase === 'noise').length, 480)
  assert.equal(manifest.selection.fullOfficialCoverage, false)
  assert.equal(manifest.selection.standardMini.entries.length, 160)
  assert.equal(new Set(manifest.selection.standardMini.entries.map(e => e.scenarioId)).size, 160)
  for (const capability of STANDARD_CAPABILITIES) {
    const rows = manifest.tasks.filter(t => t.phase === 'standard' && t.config === capability)
    assert.equal(rows.length, 96)
    assert.ok(rows.every(t => t.rowIndex >= 64 && t.rowIndex < 96 && t.sourcePath === `data/submission/${capability}.parquet`))
  }
  assert.deepEqual(validateSchema(manifest, readJson(join(root, 'schemas/run-manifest.schema.json'))), [])
})

test('mini profile rejects limits, unknown profiles, and internal pass5', () => {
  for (const options of [{ perCapability: 2 }, { miniLimit: 10 }, { mode: 'internal_pass5' }]) assert.throws(() => build({ selectionProfile: OFFICIAL_MINI_PROFILE, ...options }), /does not permit selection limits/)
  assert.throws(() => build({ selectionProfile: 'first-32' }), /unsupported selection profile/)
  const legacy = build()
  assert.equal(legacy.tasks.length, 3360)
  assert.equal(legacy.selection.fullOfficialCoverage, true)
  assert.equal(Object.hasOwn(legacy.selection, 'profile'), false)
  assert.equal(Object.hasOwn(legacy.selection, 'standardMini'), false)
})

for (const [name, change, expected] of [
  ['duplicate mini id', index => { index[801].id = index[800].id }, /duplicate_or_invalid_mini_id/],
  ['duplicate mini hash', index => { index[801].scenarioHash = index[800].scenarioHash }, /duplicate_or_invalid_mini_hash/],
  ['missing mini row', index => index.pop(), /mini_count_must_be_160/],
  ['absent original id', index => { index[800].id = 'not-in-full' }, /mini_id_missing_from_full/],
  ['wrong capability', index => { index[800].category = 'time' }, /mini_capability_mismatch/],
  ['wrong scenario SHA', index => { index[800].scenarioHash = 'b'.repeat(64) }, /mini_scenario_hash_mismatch/],
  ['unknown capability', index => { index[800].category = 'invented' }, /mini_capability_invalid/],
  ['duplicate original id', index => { index[1].id = index[0].id }, /duplicate_or_invalid_full_id/],
]) test(`fixed mini rejects ${name}`, () => { const index = fixture(); change(index); assert.throws(() => buildStandardMiniMapping(index, refs.scenarioIndex.sha256), expected) })

test('mapping mutation is rejected even after both mapping and manifest are rehashed', () => {
  const index = fixture(), contents = build({ selectionProfile: OFFICIAL_MINI_PROFILE })
  contents.selection.standardMini.entries[0].scenarioHash = 'c'.repeat(64)
  const { mappingHash, ...mapping } = contents.selection.standardMini
  contents.selection.standardMini.mappingHash = digest(mapping)
  const errors = validateRunManifest(root, seal(contents), { protocol, index, lockRefs: refs }, {})
  assert.ok(errors.some(error => error.includes('selection differs from frozen plan')))
})

test('pinned local mini proves 32 distinct original scenarios per capability', () => {
  const index = parseIndex(join(root, 'data/scenario-index.jsonl'))
  const mapping = buildStandardMiniMapping(index, refs.scenarioIndex.sha256)
  assert.equal(mapping.count, 160)
  for (const capability of STANDARD_CAPABILITIES) assert.equal(mapping.entries.filter(e => e.capability === capability).length, 32)
})

test('historical default manifests reconstruct with unchanged fingerprint and fields', () => {
  for (const run of ['phase5-readback-recovery-20261013-r16', 'phase5-a2a-service-revalidation-20261013-r17']) {
    const manifest = readJson(join(root, 'runs', run, 'run-manifest.json'))
    const frozen = validateExportPlan(root, manifest).frozenSources
    const expected = buildRunManifest({ root, protocol: readJson(frozen.protocol), index: parseIndex(frozen.scenarioIndex), lockRefs: manifest.lockRefs, entrypoints: manifest.entrypoints, mode: manifest.mode, runId: manifest.runId, perCapability: manifest.selection.perCapability, miniLimit: manifest.selection.miniLimit, rootSeed: manifest.rootSeed })
    for (const key of ['planFingerprint', 'dataset', 'models', 'policy', 'requestedRuntime', 'tasks', 'selection', 'runRoot', 'stateFile']) assert.deepEqual(expected[key], manifest[key])
  }
})

test('ten Standard run1 identities and explicit IDs are deterministic and hash-bound', () => {
  const manifest = seal(build())
  const ids = selectPhase6ExecutionIds(manifest, { rule: 'standard-two-per-capability-run1-v1' })
  assert.equal(ids.length, 10)
  assert.equal(new Set(manifest.tasks.filter(t => ids.includes(t.executionId)).map(t => t.scenarioId)).size, 10)
  assert.deepEqual(selectPhase6ExecutionIds(manifest, { executionIds: [...ids].reverse() }), ids)
  assert.equal(selectionIdentityHash(manifest, ids), digest({ manifestHash: manifest.manifestHash, executionIds: ids }))
  assert.notEqual(selectionIdentityHash({ ...manifest, manifestHash: 'f'.repeat(64) }, ids), selectionIdentityHash(manifest, ids))
  assert.throws(() => selectPhase6ExecutionIds(manifest, { executionIds: [ids[0], ids[0]] }), /duplicate_execution_id/)
  assert.throws(() => selectPhase6ExecutionIds(manifest, { executionIds: ['unknown'] }), /unknown_execution_id/)
  assert.throws(() => selectPhase6ExecutionIds(manifest, { executionIds: ids, onlyPhase: 'noise' }), /filter_conflict/)
  assert.throws(() => selectPhase6ExecutionIds(manifest, { rule: 'standard-two-per-capability-run1-v1', onlyRunNumber: 1 }), /conflicts/)
})

test('whole mini and whole full gates require the real plan profile, not just a row count', () => {
  const fixed = seal(build({ selectionProfile: OFFICIAL_MINI_PROFILE }))
  const full = seal(build())
  const misleadingPartial = seal(build({ perCapability: 32, miniLimit: 160 }))
  assert.equal(misleadingPartial.tasks.length, 1440)
  assert.equal(selectPhase6ExecutionIds(fixed, { rule: 'official-mini-whole-v1' }).length, 1440)
  assert.equal(selectPhase6ExecutionIds(full, { rule: 'full-official-whole-v1' }).length, 3360)
  assert.throws(() => selectPhase6ExecutionIds(misleadingPartial, { rule: 'official-mini-whole-v1' }), /not_fixed_official_mini_plan/)
  assert.throws(() => selectPhase6ExecutionIds(fixed, { rule: 'full-official-whole-v1' }), /not_full_official_plan/)
})
