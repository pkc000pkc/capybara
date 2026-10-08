import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRunManifest, digest, inspectEntrypoints, readJson, saveRunManifest, validateProtocol, within } from '../src/phase0_run.mjs'
import { sensitiveFields, validateRunManifest, validateSchema } from '../src/phase0_audit.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const protocol = readJson(join(root, 'config/phase0-protocol.json'))
const configs = protocol.datasets.source.configs
const refs = Object.fromEntries(['protocol', 'environment', 'capabilities', 'dataset', 'scenarioIndex'].map((key) => [key, { path: key, sha256: 'a'.repeat(64) }]))
function makeIndex(count = 2, miniCount = 1) {
  const result = []
  for (const kind of ['source', 'submission']) for (const config of configs) for (let rowIndex = 0; rowIndex < count; rowIndex++) result.push({ datasetKind: kind, config, id: `${config}-${rowIndex}`, path: `data/${kind}/${config}.parquet`, rowIndex, scenarioHash: digest([kind, config, rowIndex]), scenarioVersion: 'are_simulation_v1' })
  for (let rowIndex = 0; rowIndex < miniCount; rowIndex++) result.push({ datasetKind: 'mini', config: 'mini', id: `mini-${rowIndex}`, path: 'data/submission/mini.parquet', rowIndex, scenarioHash: digest(['mini', rowIndex]), scenarioVersion: 'are_simulation_v1' })
  return result
}
function inputs(index = makeIndex()) { return { protocol, index, lockRefs: refs, entrypoints: inspectEntrypoints(root, {}) } }
function planned(options = {}) {
  const manifest = buildRunManifest({ root, ...inputs(), runId: 'test-run', ...options })
  return { ...manifest, manifestHash: digest(manifest) }
}
function rehash(manifest) { const { manifestHash, ...contents } = manifest; return { ...contents, manifestHash: digest(contents) } }

test('phase0 plans 25 initial attempts with stable fingerprint and isolated paths', () => {
  const first = planned()
  const second = planned({ runId: 'another-run' })
  assert.equal(first.tasks.length, 25)
  assert.equal(first.planFingerprint, second.planFingerprint)
  assert.equal(new Set(first.tasks.flatMap((task) => [task.outputDir, task.fixtureDir, task.workspaceDir])).size, 75)
  assert.equal(first.policy.maxCorrections, 0)
  assert.deepEqual(validateRunManifest(root, first, inputs(), {}), [])
})

test('phase0 official plan uses three runs and distinct phase/config identity', () => {
  const manifest = planned({ mode: 'official_submission', perCapability: 1, miniLimit: 1 })
  assert.equal(manifest.tasks.length, 21)
  assert.equal(manifest.tasks.filter((task) => task.phase === 'agent2agent').length, 3)
  assert.equal(manifest.tasks.filter((task) => task.phase === 'noise').length, 3)
  assert.ok(manifest.tasks.every((task) => task.runNumber <= 3 && task.attemptIndex === null))
  assert.deepEqual(validateRunManifest(root, manifest, inputs(), {}), [])
  const full = buildRunManifest({ root, ...inputs(makeIndex(160, 160)), mode: 'official_submission', runId: 'full-plan' })
  assert.equal(full.tasks.length, 3360)
  assert.equal(full.selection.fullOfficialCoverage, true)
})

test('phase0 rejects duplicate IDs, unsafe run IDs, invalid budgets and protocol counts', () => {
  const index = makeIndex()
  index.push({ ...index[0], rowIndex: 10 })
  assert.throws(() => buildRunManifest({ root, ...inputs(index) }), /duplicate scenario ID/)
  assert.throws(() => planned({ runId: '../escape' }), /invalid run ID/)
  assert.throws(() => planned({ perCapability: NaN }), /positive integer/)
  assert.throws(() => planned({ rootSeed: -1 }), /unsigned/)
  assert.throws(() => validateProtocol({ ...protocol, modes: { ...protocol.modes, internal_pass5: { initialRunsPerScenario: 4 } } }), /attempt counts/)
})

test('phase0 detects changed scenario bindings even after manifest is rehashed', () => {
  const manifest = planned()
  manifest.tasks[0].rowIndex = 1
  manifest.tasks[0].scenarioHash = 'b'.repeat(64)
  const errors = validateRunManifest(root, rehash(manifest), inputs(), {})
  assert.ok(errors.some((error) => error.includes('tasks differs')))
  const changedInputs = inputs()
  changedInputs.lockRefs = { ...refs, dataset: { path: 'dataset', sha256: 'c'.repeat(64) } }
  assert.ok(validateRunManifest(root, planned(), changedInputs, {}).some((error) => error.includes('lock references')))
})

test('phase0 detects duplicate tasks, numbering errors and output path escape', () => {
  const manifest = planned()
  manifest.tasks[1] = { ...manifest.tasks[0], runNumber: 6, attemptIndex: 1, outputDir: '../escape' }
  assert.ok(validateRunManifest(root, rehash(manifest), inputs(), {}).length > 0)
  const duplicate = planned()
  duplicate.tasks[1] = { ...duplicate.tasks[0] }
  assert.ok(validateRunManifest(root, rehash(duplicate), inputs(), {}).some((error) => error.includes('duplicate task')))
})

test('phase0 manifest cannot claim submission readiness or carry credentials', () => {
  assert.ok(validateRunManifest(root, rehash({ ...planned(), submissionReady: true }), inputs(), {}).some((error) => error.includes('unknown field')))
  const manifest = planned()
  manifest.models = { ...manifest.models, nested: { api_key: 'SECRET' } }
  assert.ok(validateRunManifest(root, rehash(manifest), inputs(), {}).some((error) => error.includes('secret value')))
  assert.ok(sensitiveFields({ url: 'https://user:pass@example.com' }).length)
  assert.ok(sensitiveFields({ url: 'https://example.com?token=value' }).length)
  const secretProtocol = structuredClone(protocol)
  secretProtocol.models.actor.api_key = 'TEST_ONLY'
  assert.throws(() => validateProtocol(secretProtocol), /secret field/)
  const incompleteProtocol = structuredClone(protocol)
  incompleteProtocol.modes.official_submission.phases = ['standard']
  assert.throws(() => validateProtocol(incompleteProtocol), /invalid phases/)
})

test('phase0 captures actual short pilot/all timeouts separately from long e2e/batch', () => {
  const snapshots = inspectEntrypoints(root, {}).entries
  assert.equal(snapshots.find((entry) => entry.id === 'pilot').settings.processTimeoutMs, 480000)
  assert.equal(snapshots.find((entry) => entry.id === 'all').settings.processTimeoutMs, 900000)
  assert.equal(snapshots.find((entry) => entry.id === 'batch').settings.processTimeoutMs, 480000000)
  assert.equal(snapshots.find((entry) => entry.id === 'e2e').settings.maxActions, 1)
  assert.equal(inspectEntrypoints(root, { GAIA2_E2E_MINIMAL: '0' }).entries.find((entry) => entry.id === 'e2e').settings.maxActions, 24)
  assert.equal(inspectEntrypoints(root, { GAIA2_BATCH_TIMEOUT_MINUTES: '0' }).entries.find((entry) => entry.id === 'batch').settings.processTimeoutMs, 0)
  assert.throws(() => inspectEntrypoints(root, { GAIA2_BATCH_TIMEOUT_MINUTES: 'NaN' }), /non-negative/)
})

test('phase0 saves immutable plans and validates the schema contract', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'capybara-phase0-plan-'))
  try {
    const manifest = planned()
    saveRunManifest(temporary, manifest)
    assert.throws(() => saveRunManifest(temporary, manifest), /EEXIST/)
    assert.equal(within(join(temporary, 'runs'), resolve(temporary, 'runs', 'test-run')), true)
    assert.equal(within(join(temporary, 'runs'), resolve(temporary, '..')), false)
    const schema = readJson(join(root, 'schemas/run-manifest.schema.json'))
    assert.deepEqual(validateSchema(manifest, schema), [])
    assert.ok(validateSchema({ ...manifest, tasks: [] }, schema).length)
  } finally {
    if (within(tmpdir(), temporary) && temporary.includes('capybara-phase0-plan-')) rmSync(temporary, { recursive: true, force: true })
  }
})
