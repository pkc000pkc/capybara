import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  canonicalScenarioHash, compareScenarioRecords, datasetFilesFromMetadata,
  normalizeScenarioRow, scenarioIdSetSha256, validateMiniMapping,
  validateRecordIds, verifyDatasetFile, verifyDatasetLock, verifyIndexedRows, verifyMappingReport, ensureDatasetFile,
} from '../src/phase0_dataset.mjs'

test('canonical hash ignores object key ordering but never array ordering or semantic fields', () => {
  assert.equal(canonicalScenarioHash({ b: 2, a: { y: [1, 2], x: 3 } }), canonicalScenarioHash({ a: { x: 3, y: [1, 2] }, b: 2 }))
  assert.notEqual(canonicalScenarioHash({ events: [1, 2] }), canonicalScenarioHash({ events: [2, 1] }))
  assert.notEqual(canonicalScenarioHash({ x: 1, augmentation: {} }), canonicalScenarioHash({ x: 1, augmentation: { mode: true } }))
})

test('ID set hash is order independent and rejects duplicate IDs', () => {
  assert.equal(scenarioIdSetSha256(['b', 'a']), scenarioIdSetSha256(['a', 'b']))
  assert.throws(() => scenarioIdSetSha256(['a', 'a']), /duplicate/)
  assert.throws(() => validateRecordIds([{ id: 'a' }, { id: 'a' }], 'source'), /duplicate/)
})

test('same IDs with different scenario hashes are reported as different', () => {
  const result = compareScenarioRecords([{ id: 'a', scenarioHash: 'old' }], [{ id: 'a', scenarioHash: 'new' }])
  assert.equal(result.status, 'different')
  assert.equal(result.idSetStatus, 'identical')
  assert.equal(result.differentScenarioCount, 1)
  assert.deepEqual(result.differentIds, ['a'])
})

test('all-ID comparison reports both missing and additional IDs', () => {
  const result = compareScenarioRecords([{ id: 'a', scenarioHash: 'x' }], [{ id: 'b', scenarioHash: 'x' }])
  assert.equal(result.status, 'different')
  assert.deepEqual(result.sourceOnlyIds, ['a'])
  assert.deepEqual(result.submissionOnlyIds, ['b'])
})

test('mini needs exact count and full ID membership; hash differences are retained', () => {
  const full = [{ id: 'a', config: 'execution', scenarioHash: 'x' }]
  const mini = [{ id: 'a', config: 'mini', category: 'execution', scenarioHash: 'x' }]
  assert.equal(validateMiniMapping(mini, full, 1).status, 'identical-subset')
  assert.equal(validateMiniMapping([{ ...mini[0], scenarioHash: 'y' }], full, 1).status, 'different')
  assert.throws(() => validateMiniMapping(mini, full), /expected 160/)
  assert.throws(() => validateMiniMapping([{ id: 'absent' }], full, 1), /absent/)
  assert.throws(() => validateMiniMapping([{ ...mini[0], category: 'search' }], full, 1), /categories disagree/)
})

test('official row normalization checks ID and emits no scenario content', () => {
  const data = JSON.stringify({ metadata: { definition: { scenario_id: 'a' } }, version: 'are_simulation_v1', secret: 'do not expose' })
  const record = normalizeScenarioRow({ scenario_id: 'a', data }, { datasetKind: 'submission', config: 'execution', path: 'data/submission/a.parquet', rowIndex: 0 })
  assert.equal(record.id, 'a')
  assert.equal(record.scenarioVersion, 'are_simulation_v1')
  assert(!JSON.stringify(record).includes('do not expose'))
  assert.throws(() => normalizeScenarioRow({ scenario_id: 'b', data }, { datasetKind: 'submission', config: 'execution', rowIndex: 0 }), /IDs disagree/)
})

test('metadata must match immutable revision and contain a trusted LFS digest', () => {
  const spec = { id: 'owner/gaia2', revision: 'a'.repeat(40), split: 'validation', configs: ['execution'], cacheDir: 'data/submission' }
  const metadata = { sha: spec.revision, siblings: [{ rfilename: 'execution/validation-00000-of-00001.parquet', size: 12, lfs: { size: 12, sha256: 'b'.repeat(64) } }] }
  assert.equal(datasetFilesFromMetadata(spec, metadata)[0].path, 'data/submission/execution/validation-00000-of-00001.parquet')
  assert.throws(() => datasetFilesFromMetadata({ ...spec, revision: 'main' }, metadata), /immutable/)
  assert.throws(() => datasetFilesFromMetadata(spec, { ...metadata, sha: 'c'.repeat(40) }), /revision mismatch/)
  assert.throws(() => datasetFilesFromMetadata(spec, { ...metadata, siblings: [{ ...metadata.siblings[0], lfs: undefined }] }), /LFS/)
})

test('file verification rejects incorrect size and hash before reuse', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phase0-dataset-test-'))
  try {
    const path = join(directory, 'test.parquet')
    const bytes = Buffer.from('verified fixture')
    await writeFile(path, bytes)
    const expected = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    assert.deepEqual(await verifyDatasetFile(path, expected), expected)
    await assert.rejects(verifyDatasetFile(path, { ...expected, bytes: 1 }), /size mismatch/)
    await assert.rejects(verifyDatasetFile(path, { ...expected, sha256: 'f'.repeat(64) }), /SHA-256 mismatch/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('offline cache reuse rejects bad bytes even if a nonempty file exists', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phase0-cache-test-'))
  try {
    await mkdir(join(directory, 'data'))
    await writeFile(join(directory, 'data', 'test.parquet'), 'bad')
    const entry = { path: 'data/test.parquet', bytes: 3, sha256: createHash('sha256').update('yes').digest('hex') }
    await assert.rejects(ensureDatasetFile({ root: directory, spec: {}, entry, offline: true }), /SHA-256 mismatch/)
    await assert.rejects(ensureDatasetFile({ root: directory, spec: {}, entry: { ...entry, path: '../outside.parquet' }, offline: true }), /escapes workspace/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('dataset verification rejects an unbound or altered scenario index before reading data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phase0-index-test-'))
  try {
    await mkdir(join(directory, 'data'))
    await writeFile(join(directory, 'data', 'scenario-index.jsonl'), '{}\n')
    const lock = { schemaVersion: 1, scenarioIndex: { path: 'data/scenario-index.jsonl', sha256: 'a'.repeat(64) } }
    await assert.rejects(verifyDatasetLock({ root: directory, protocol: {}, lock }), /index SHA-256 mismatch/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('deep row comparison catches tampered hashes even after index digest is recomputed', () => {
  const actual = [{ datasetKind: 'source', config: 'execution', id: 'a', path: 'data/source/test.parquet', rowIndex: 0, scenarioHash: 'a'.repeat(64), scenarioVersion: 'are_simulation_v1' }]
  verifyIndexedRows(actual, actual, 'fixture')
  assert.throws(() => verifyIndexedRows([{ ...actual[0], scenarioHash: 'b'.repeat(64) }], actual, 'fixture'), /actual Parquet rows/)
  assert.throws(() => verifyIndexedRows([{ ...actual[0], rowIndex: 1 }], actual, 'fixture'), /actual Parquet rows/)
  assert.throws(() => verifyIndexedRows([{ ...actual[0], id: 'substituted' }], actual, 'fixture'), /actual Parquet rows/)
})

test('mapping report comparison is derived from index, not accepted from a rehashed report', () => {
  const source = Array.from({ length: 160 }, (_, rowIndex) => ({ id: `id-${rowIndex}`, config: 'execution', scenarioHash: 'x' }))
  const submission = source.map((row) => ({ ...row }))
  const mini = source.map((row) => ({ ...row, config: 'mini', category: 'execution' }))
  const specs = { source: { id: 'a/source', revision: 'a'.repeat(40), split: 'test' }, submission: { id: 'a/submission', revision: 'b'.repeat(40), split: 'validation' } }
  const configs = ['execution', 'search', 'adaptability', 'time', 'ambiguity'].map((config) => ({ config, ...compareScenarioRecords(source.filter((row) => row.config === config), submission.filter((row) => row.config === config)) }))
  const report = { status: 'passed', mode: 'phase0-dataset-freeze', source: { ...specs.source, count: 160 }, submission: { ...specs.submission, count: 160 }, comparison: compareScenarioRecords(source, submission), configs, mini: validateMiniMapping(mini, submission), submissionUsableIndependently: true }
  const inputs = { source, submission, mini, specs }
  verifyMappingReport(report, inputs)
  assert.throws(() => verifyMappingReport({ ...report, comparison: { ...report.comparison, identicalScenarioCount: 0 } }, inputs), /comparison differs/)
  assert.throws(() => verifyMappingReport({ ...report, mini: { ...report.mini, count: 1 } }, inputs), /mini mapping differs/)
  assert.throws(() => verifyMappingReport({ ...report, configs: [] }, inputs), /per-config comparisons differ/)
})
