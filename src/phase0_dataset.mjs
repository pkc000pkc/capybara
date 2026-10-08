import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { importScenarioRow } from './scenario_importer.mjs'

const execFileAsync = promisify(execFile)
const CAPABILITIES = ['execution', 'search', 'adaptability', 'time', 'ambiguity']
const SHA256 = /^[0-9a-f]{64}$/
const REVISION = /^[0-9a-f]{40}$/
const BATCH_SIZE = 20
const curl = process.platform === 'win32' ? 'curl.exe' : 'curl'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function exists(path) {
  try { await stat(path); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function workspacePath(root, path) {
  assert(typeof path === 'string' && path.length > 0 && !isAbsolute(path), `expected workspace-relative path: ${path}`)
  const target = resolve(root, path)
  const rel = relative(resolve(root), target)
  assert(rel && !rel.startsWith('..') && !isAbsolute(rel), `path escapes workspace: ${path}`)
  return target
}

function portablePath(path) { return path.replaceAll('\\', '/') }

/** Exact JSON-content comparison: sort object keys, retain array order and all fields. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  assert(encoded !== undefined, 'canonical JSON cannot include undefined or non-JSON values')
  return encoded
}

export function canonicalScenarioHash(scenario) {
  return createHash('sha256').update(canonicalJson(scenario)).digest('hex')
}

/** SHA-256 of sorted IDs encoded as a canonical JSON array (not concatenated strings). */
export function scenarioIdSetSha256(ids) {
  const values = [...ids]
  assert(values.every((id) => typeof id === 'string' && id.length > 0), 'scenario IDs must be nonempty strings')
  assert(new Set(values).size === values.length, 'duplicate scenario ID in ID set')
  return createHash('sha256').update(JSON.stringify(values.sort())).digest('hex')
}

export async function fileSha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function verifyDatasetFile(path, expected) {
  assert(SHA256.test(expected.sha256), `invalid expected SHA-256 for ${path}`)
  const actual = await stat(path)
  assert(actual.isFile(), `dataset is not a regular file: ${path}`)
  assert(actual.size === expected.bytes, `dataset size mismatch: ${path}`)
  const digest = await fileSha256(path)
  assert(digest === expected.sha256, `dataset SHA-256 mismatch: ${path}`)
  return { bytes: actual.size, sha256: digest }
}

export function normalizeScenarioRow(row, { datasetKind, config, path, rowIndex }) {
  const raw = datasetKind === 'source' ? row?.scenario : row?.data
  assert(typeof raw === 'string', `${datasetKind}/${config}/${rowIndex}: scenario JSON is missing`)
  let scenario
  try { scenario = JSON.parse(raw) } catch {
    throw new Error(`${datasetKind}/${config}/${rowIndex}: invalid scenario JSON`)
  }
  assert(scenario && typeof scenario === 'object' && !Array.isArray(scenario), `${datasetKind}/${config}/${rowIndex}: expected scenario object`)
  const id = scenario.metadata?.definition?.scenario_id
  assert(typeof id === 'string' && id.length > 0, `${datasetKind}/${config}/${rowIndex}: scenario ID is missing`)
  assert(row.scenario_id === id, `${datasetKind}/${config}/${rowIndex}: row and JSON scenario IDs disagree`)
  assert(typeof scenario.version === 'string' && scenario.version.length > 0, `${datasetKind}/${config}/${id}: scenario version is missing`)
  // Preserve the existing structural checks for the source; official JSON is
  // hashed without applying source-only assumptions or rewriting any fields.
  if (datasetKind === 'source') importScenarioRow(row, config)
  return {
    datasetKind, config, id, path, rowIndex,
    scenarioHash: canonicalScenarioHash(scenario),
    scenarioVersion: scenario.version,
  }
}

export function validateRecordIds(records, label) {
  const ids = new Set()
  for (const record of records) {
    assert(typeof record.id === 'string' && record.id.length > 0, `${label}: invalid scenario ID`)
    assert(!ids.has(record.id), `${label}: duplicate scenario ID ${record.id}`)
    ids.add(record.id)
  }
  return ids
}

export function compareScenarioRecords(source, submission) {
  validateRecordIds(source, 'source comparison')
  validateRecordIds(submission, 'submission comparison')
  const sourceById = new Map(source.map((row) => [row.id, row]))
  const submissionById = new Map(submission.map((row) => [row.id, row]))
  const sourceOnlyIds = [...sourceById.keys()].filter((id) => !submissionById.has(id)).sort()
  const submissionOnlyIds = [...submissionById.keys()].filter((id) => !sourceById.has(id)).sort()
  const differentIds = []
  let identicalScenarioCount = 0
  for (const [id, sourceRow] of sourceById) {
    const submissionRow = submissionById.get(id)
    if (!submissionRow) continue
    if (sourceRow.scenarioHash === submissionRow.scenarioHash) identicalScenarioCount++
    else differentIds.push(id)
  }
  differentIds.sort()
  return {
    status: sourceOnlyIds.length || submissionOnlyIds.length || differentIds.length ? 'different' : 'identical',
    idSetStatus: sourceOnlyIds.length || submissionOnlyIds.length ? 'different' : 'identical',
    scenarioHashStatus: differentIds.length ? 'different' : 'identical-for-shared-ids',
    sourceCount: source.length,
    submissionCount: submission.length,
    sharedIdCount: source.length - sourceOnlyIds.length,
    identicalScenarioCount,
    differentScenarioCount: differentIds.length,
    sourceOnlyIds, submissionOnlyIds, differentIds,
  }
}

export function validateMiniMapping(mini, full, expectedCount = 160) {
  validateRecordIds(mini, 'mini')
  validateRecordIds(full, 'submission full')
  assert(mini.length === expectedCount, `mini: expected ${expectedCount} rows, found ${mini.length}`)
  const fullById = new Map(full.map((row) => [row.id, row]))
  const missingIds = mini.filter((row) => !fullById.has(row.id)).map((row) => row.id).sort()
  const differentIds = mini.filter((row) => fullById.has(row.id) && fullById.get(row.id).scenarioHash !== row.scenarioHash).map((row) => row.id).sort()
  const wrongCategoryIds = mini.filter((row) => fullById.has(row.id) && row.category && row.category !== fullById.get(row.id).config).map((row) => row.id).sort()
  assert(missingIds.length === 0, `mini: ${missingIds.length} IDs are absent from submission full`)
  assert(wrongCategoryIds.length === 0, `mini: ${wrongCategoryIds.length} categories disagree with submission full`)
  const categoryCounts = {}
  for (const row of mini) {
    const category = fullById.get(row.id).config
    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1
  }
  return {
    status: differentIds.length ? 'different' : 'identical-subset',
    expectedCount, count: mini.length,
    scenarioIdSetSha256: scenarioIdSetSha256(mini.map((row) => row.id)),
    allIdsInFull: true,
    allScenarioHashesMatchFull: differentIds.length === 0,
    differentScenarioCount: differentIds.length,
    differentIds, categoryCounts,
  }
}

export async function pinnedDatasetMetadata(spec) {
  assert(typeof spec.id === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(spec.id), 'invalid dataset id')
  assert(REVISION.test(spec.revision), `dataset revision must be a full immutable commit SHA: ${spec.revision}`)
  const url = `https://huggingface.co/api/datasets/${spec.id}/revision/${spec.revision}?blobs=true`
  const { stdout } = await execFileAsync(curl, ['--fail', '--location', '--silent', '--show-error', '--retry', '3', url], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 90000,
  })
  const metadata = JSON.parse(stdout)
  assert(metadata.sha === spec.revision, `Hugging Face revision mismatch for ${spec.id}`)
  assert(Array.isArray(metadata.siblings), `missing file metadata for ${spec.id}`)
  return metadata
}

export function datasetFilesFromMetadata(spec, metadata) {
  assert(REVISION.test(spec.revision), 'dataset revision must be immutable')
  assert(metadata.sha === spec.revision, 'remote metadata revision mismatch')
  const files = []
  for (const config of spec.configs) {
    assert(/^[a-z][a-z0-9_-]*$/.test(config), `invalid config ${config}`)
    const pattern = spec.id.endsWith('/gaia2-cli')
      ? new RegExp(`^data/${config}-${spec.split}-\\d{5}-of-\\d{5}\\.parquet$`)
      : new RegExp(`^${config}/${spec.split}-\\d{5}-of-\\d{5}\\.parquet$`)
    const matches = metadata.siblings.filter((file) => pattern.test(file.rfilename)).sort((a, b) => a.rfilename.localeCompare(b.rfilename))
    assert(matches.length > 0, `${spec.id}/${config}: no files at pinned revision`)
    for (const file of matches) {
      assert(SHA256.test(file.lfs?.sha256), `${file.rfilename}: missing remote LFS SHA-256`)
      assert(Number.isSafeInteger(file.lfs.size) && file.lfs.size > 0, `${file.rfilename}: invalid remote LFS size`)
      assert(file.size === file.lfs.size, `${file.rfilename}: remote sizes disagree`)
      const cacheSuffix = spec.id.endsWith('/gaia2-cli') ? basename(file.rfilename) : file.rfilename
      files.push({
        config, remotePath: file.rfilename,
        path: portablePath(join(spec.cacheDir, cacheSuffix)),
        bytes: file.lfs.size, sha256: file.lfs.sha256,
      })
    }
  }
  return files
}

export async function ensureDatasetFile({ root, spec, entry, offline = false, legacyPath }) {
  const target = workspacePath(root, entry.path)
  if (await exists(target)) {
    try { await verifyDatasetFile(target, entry); return { ...entry, reused: true } } catch (error) {
      if (offline) throw error
      process.stdout.write(`${entry.path}: existing cache failed verification; downloading verified replacement\n`)
    }
  }
  assert(!offline, `offline dataset file is missing or invalid: ${entry.path}`)
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.part-${process.pid}-${randomUUID()}`
  if (legacyPath && await exists(legacyPath)) {
    await verifyDatasetFile(legacyPath, entry)
    await copyFile(legacyPath, temporary)
  } else if (await exists(`${target}.part`)) {
    // A previous manual download can be adopted only after full LFS verification.
    await verifyDatasetFile(`${target}.part`, entry)
    await rename(`${target}.part`, temporary)
  } else {
    const url = `https://huggingface.co/datasets/${spec.id}/resolve/${spec.revision}/${entry.remotePath}?download=true`
    process.stdout.write(`Downloading pinned ${spec.id}/${entry.remotePath} (${entry.bytes} bytes)\n`)
    await execFileAsync(curl, ['--fail', '--location', '--silent', '--show-error', '--retry', '3', '--retry-delay', '2', '--output', temporary, url], {
      maxBuffer: 1024 * 1024,
    })
  }
  await verifyDatasetFile(temporary, entry)
  await rename(temporary, target)
  process.stdout.write(`Verified ${entry.path} (${entry.sha256})\n`)
  return { ...entry, reused: false }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.part-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

function assertProtocolDataset(spec, kind) {
  assert(spec && Array.isArray(spec.configs), `protocol datasets.${kind} is missing`)
  assert(REVISION.test(spec.revision), `${kind}: revision must be a full commit SHA`)
  assert(/^[a-z]+$/.test(spec.split), `${kind}: invalid split`)
  const expected = kind === 'source' ? CAPABILITIES : [...CAPABILITIES, 'mini']
  assert(new Set(spec.configs).size === expected.length && expected.every((config) => spec.configs.includes(config)), `${kind}: unexpected configs`)
}

export async function readScenarioIndex(path) {
  const lines = (await readFile(path, 'utf8')).split('\n').filter((line) => line.trim())
  return lines.map((line, index) => {
    try { return JSON.parse(line) } catch { throw new Error(`scenario index line ${index + 1}: invalid JSON`) }
  })
}

export function verifyIndexedRows(indexedRows, actualRows, path) {
  const sorted = [...indexedRows].sort((a, b) => a.rowIndex - b.rowIndex)
  assert(canonicalJson(actualRows) === canonicalJson(sorted), `${path}: scenario index differs from actual Parquet rows`)
}

export function verifyMappingReport(report, { source, submission, mini, specs }) {
  assert(report.status === 'passed' && report.mode === 'phase0-dataset-freeze', 'mapping report status or mode differs from verified freeze')
  for (const [kind, rows] of [['source', source], ['submission', submission]]) {
    const spec = specs[kind]
    const expected = { id: spec.id, revision: spec.revision, split: spec.split, count: rows.length }
    assert(canonicalJson(report[kind]) === canonicalJson(expected), `${kind}: mapping report dataset identity differs from lock and index`)
  }
  const expectedComparison = compareScenarioRecords(source, submission)
  const expectedConfigs = CAPABILITIES.map((config) => ({ config, ...compareScenarioRecords(source.filter((row) => row.config === config), submission.filter((row) => row.config === config)) }))
  const expectedMini = validateMiniMapping(mini, submission)
  assert(canonicalJson(report.comparison) === canonicalJson(expectedComparison), 'mapping report comparison differs from scenario index')
  assert(canonicalJson(report.configs) === canonicalJson(expectedConfigs), 'mapping report per-config comparisons differ from scenario index')
  assert(canonicalJson(report.mini) === canonicalJson(expectedMini), 'mapping report mini mapping differs from scenario index')
  assert(report.submissionUsableIndependently === true, 'mapping report must keep official dataset independent')
}

/** Only lightweight metadata records persist; raw JSON is held in one twenty-row batch. */
export async function readDatasetRecords({ root, kind, entry, progress = false }) {
  const file = await asyncBufferFromFile(workspacePath(root, entry.path))
  const metadata = await parquetMetadataAsync(file)
  const rowCount = Number(metadata.num_rows)
  assert(Number.isSafeInteger(rowCount) && rowCount > 0, `${entry.path}: invalid parquet row count`)
  const records = []
  const columns = kind === 'source' ? ['scenario_id', 'scenario'] : entry.config === 'mini' ? ['scenario_id', 'data', 'category'] : ['scenario_id', 'data']
  for (let rowStart = 0; rowStart < rowCount; rowStart += BATCH_SIZE) {
    const rows = await parquetReadObjects({ file, columns, rowStart, rowEnd: Math.min(rowStart + BATCH_SIZE, rowCount), compressors })
    for (const [offset, row] of rows.entries()) {
      const record = normalizeScenarioRow(row, {
        datasetKind: entry.config === 'mini' ? 'mini' : kind,
        config: entry.config, path: entry.path, rowIndex: rowStart + offset,
      })
      if (entry.config === 'mini' && typeof row.category === 'string') record.category = row.category
      records.push(record)
    }
    if (progress) process.stdout.write(`Indexed ${kind}/${entry.config}: ${Math.min(rowStart + BATCH_SIZE, rowCount)}/${rowCount}\n`)
  }
  validateRecordIds(records, `${kind}/${entry.config}`)
  return records
}

/** Revalidate bytes and index binding; deep mode also independently re-derives every row. */
export async function verifyDatasetLock({ root, protocol, lock, index, deep = true }) {
  root = resolve(root)
  lock ??= JSON.parse(await readFile(join(root, 'locks', 'dataset-lock.json'), 'utf8'))
  assert(lock.schemaVersion === 1, 'unsupported dataset lock schema')
  assert(lock.scenarioIndex?.path === 'data/scenario-index.jsonl', 'dataset lock has no bound scenario index')
  assert(SHA256.test(lock.scenarioIndex.sha256), 'invalid scenario index digest')
  const indexPath = workspacePath(root, lock.scenarioIndex.path)
  assert(await fileSha256(indexPath) === lock.scenarioIndex.sha256, 'scenario index SHA-256 mismatch')
  const storedIndex = await readScenarioIndex(indexPath)
  assert(lock.scenarioIndex.count === storedIndex.length, 'scenario index count differs from lock')
  if (index) assert(canonicalJson(index) === canonicalJson(storedIndex), 'supplied index differs from bound index file')
  index = storedIndex
  assert(lock.mappingReport?.path === 'reports/phase0-dataset-mapping.json' && SHA256.test(lock.mappingReport.sha256), 'dataset lock has no bound mapping report')
  assert(await fileSha256(workspacePath(root, lock.mappingReport.path)) === lock.mappingReport.sha256, 'dataset mapping report SHA-256 mismatch')
  let verifiedFileCount = 0
  const coveredRecords = new Set()
  for (const kind of ['source', 'submission']) {
    const spec = protocol?.datasets?.[kind]
    assertProtocolDataset(spec, kind)
    const dataset = lock.datasets?.[kind]
    assert(dataset && dataset.id === spec.id && dataset.revision === spec.revision && dataset.split === spec.split && dataset.cacheDir === spec.cacheDir, `${kind}: lock and protocol disagree`)
    assert(canonicalJson([...dataset.configs].sort()) === canonicalJson([...spec.configs].sort()), `${kind}: locked configs differ from protocol`)
    assert(Array.isArray(dataset.files) && dataset.files.length > 0, `${kind}: no locked files`)
    const expectedFiles = datasetFilesFromMetadata(spec, {
      sha: spec.revision,
      siblings: dataset.files.map((entry) => ({ rfilename: entry.remotePath, size: entry.bytes, lfs: { size: entry.bytes, sha256: entry.sha256 } })),
    })
    assert(expectedFiles.length === dataset.files.length, `${kind}: unexpected or duplicate locked files`)
    assert(new Set(dataset.files.map((entry) => entry.path)).size === dataset.files.length, `${kind}: duplicate locked file path`)
    for (const entry of dataset.files) {
      const expected = expectedFiles.find((file) => file.remotePath === entry.remotePath && file.config === entry.config)
      assert(expected && entry.path === expected.path, `${kind}/${entry.config}: locked local path differs from pinned layout`)
      await verifyDatasetFile(workspacePath(root, entry.path), entry)
      const datasetKind = entry.config === 'mini' ? 'mini' : kind
      const records = index.filter((record) => record.datasetKind === datasetKind && record.config === entry.config && record.path === entry.path)
      assert(records.length === entry.count, `${entry.path}: index row count differs from lock`)
      assert(entry.count === 160, `${entry.path}: expected 160 rows`)
      const sorted = [...records].sort((a, b) => a.rowIndex - b.rowIndex)
      for (const [rowIndex, record] of sorted.entries()) {
        assert(Number.isInteger(record.rowIndex) && record.rowIndex === rowIndex, `${entry.path}: invalid or duplicate index row position`)
        assert(SHA256.test(record.scenarioHash), `${entry.path}/${rowIndex}: invalid canonical scenario hash`)
        assert(typeof record.scenarioVersion === 'string' && record.scenarioVersion.length > 0, `${entry.path}/${rowIndex}: missing scenario version`)
        coveredRecords.add(record)
      }
      assert(scenarioIdSetSha256(records.map((record) => record.id)) === entry.scenarioIdSetSha256, `${entry.path}: ID set differs from lock`)
      assert(canonicalJson([...new Set(records.map((record) => record.scenarioVersion))].sort()) === canonicalJson(entry.scenarioVersions), `${entry.path}: version set differs from lock`)
      if (deep) {
        const actualRecords = await readDatasetRecords({ root, kind, entry })
        verifyIndexedRows(sorted, actualRecords, entry.path)
      }
      verifiedFileCount++
    }
    const full = index.filter((row) => row.datasetKind === kind)
    validateRecordIds(full, `${kind} full index`)
    assert(full.length === 800 && dataset.count === 800, `${kind}: expected 800 full scenarios`)
    assert(scenarioIdSetSha256(full.map((row) => row.id)) === dataset.scenarioIdSetSha256, `${kind}: full ID set differs from lock`)
  }
  assert(coveredRecords.size === index.length, 'scenario index contains records not covered by locked files')
  const report = JSON.parse(await readFile(workspacePath(root, lock.mappingReport.path), 'utf8'))
  verifyMappingReport(report, {
    source: index.filter((row) => row.datasetKind === 'source'),
    submission: index.filter((row) => row.datasetKind === 'submission'),
    mini: index.filter((row) => row.datasetKind === 'mini'),
    specs: protocol.datasets,
  })
  return { status: 'passed', deep, verifiedFileCount, scenarioCount: index.length }
}

/** Freeze both complete datasets and mini. No model, ARE, oracle, or judge calls. */
export async function freezeDatasets({ root, protocol, offline = false }) {
  root = resolve(root)
  const specs = protocol?.datasets
  assertProtocolDataset(specs?.source, 'source')
  assertProtocolDataset(specs?.submission, 'submission')
  assert(resolve(workspacePath(root, specs.source.cacheDir)) !== resolve(workspacePath(root, specs.submission.cacheDir)), 'source and submission caches must be independent')
  const lockPath = join(root, 'locks', 'dataset-lock.json')
  const oldLock = await exists(lockPath) ? JSON.parse(await readFile(lockPath, 'utf8')) : null
  const legacyManifestPath = join(root, 'data', 'manifest.json')
  const legacyManifest = await exists(legacyManifestPath) ? JSON.parse(await readFile(legacyManifestPath, 'utf8')) : null
  const lock = {
    schemaVersion: 1,
    canonicalScenarioHash: 'sha256(canonical JSON; recursively sorted object keys; array order and every field retained)',
    scenarioIdSetHash: 'sha256(JSON.stringify(sorted unique scenario IDs))',
    datasets: {},
  }
  const allRecords = []
  for (const kind of ['source', 'submission']) {
    const spec = specs[kind]
    let files
    if (offline) {
      const previous = oldLock?.datasets?.[kind]
      assert(previous && previous.id === spec.id && previous.revision === spec.revision && previous.split === spec.split, `offline lock disagrees with protocol ${kind}`)
      assert(JSON.stringify([...previous.configs].sort()) === JSON.stringify([...spec.configs].sort()), `offline lock configs disagree with protocol ${kind}`)
      files = previous.files
    } else {
      files = datasetFilesFromMetadata(spec, await pinnedDatasetMetadata(spec))
    }
    // Concurrency is limited to three files; JSON reading remains sequential and batched.
    for (let start = 0; start < files.length; start += 3) {
      await Promise.all(files.slice(start, start + 3).map((entry) => {
        const matchingLegacy = kind === 'source' && legacyManifest?.dataset === spec.id && legacyManifest?.revision === spec.revision && legacyManifest?.split === spec.split
          ? legacyManifest.files.find((file) => file.name === entry.config && basename(file.path) === basename(entry.remotePath)) : null
        const legacyPath = matchingLegacy ? join(root, 'data', basename(matchingLegacy.path)) : undefined
        return ensureDatasetFile({ root, spec, entry, offline, legacyPath })
      }))
    }
    const datasetRecords = []
    const summaries = []
    for (const entry of files) {
      const records = await readDatasetRecords({ root, kind, entry, progress: true })
      datasetRecords.push(...records)
      summaries.push({
        config: entry.config, remotePath: entry.remotePath, path: entry.path,
        bytes: entry.bytes, sha256: entry.sha256, count: records.length,
        scenarioIdSetSha256: scenarioIdSetSha256(records.map((row) => row.id)),
        scenarioVersions: [...new Set(records.map((row) => row.scenarioVersion))].sort(),
      })
    }
    const fullRecords = datasetRecords.filter((row) => row.datasetKind !== 'mini')
    validateRecordIds(fullRecords, `${kind} full`)
    for (const config of CAPABILITIES) assert(fullRecords.filter((row) => row.config === config).length === 160, `${kind}/${config}: expected 160 scenarios`)
    lock.datasets[kind] = {
      id: spec.id, revision: spec.revision, split: spec.split,
      cacheDir: spec.cacheDir, configs: [...spec.configs],
      count: fullRecords.length,
      scenarioIdSetSha256: scenarioIdSetSha256(fullRecords.map((row) => row.id)),
      files: summaries,
    }
    allRecords.push(...datasetRecords)
  }
  const source = allRecords.filter((row) => row.datasetKind === 'source')
  const submission = allRecords.filter((row) => row.datasetKind === 'submission')
  const mini = allRecords.filter((row) => row.datasetKind === 'mini')
  const comparisons = CAPABILITIES.map((config) => ({ config, ...compareScenarioRecords(source.filter((row) => row.config === config), submission.filter((row) => row.config === config)) }))
  const report = {
    schemaVersion: 1, status: 'passed', mode: 'phase0-dataset-freeze',
    source: { id: specs.source.id, revision: specs.source.revision, split: specs.source.split, count: source.length },
    submission: { id: specs.submission.id, revision: specs.submission.revision, split: specs.submission.split, count: submission.length },
    comparison: compareScenarioRecords(source, submission),
    configs: comparisons,
    mini: validateMiniMapping(mini, submission),
    submissionUsableIndependently: true,
    checks: ['all files verified against pinned remote LFS SHA-256 and byte size', 'all rows read in batches of at most twenty', 'all scenario IDs unique within source, submission full, and mini', 'all five configs have 160 scenarios in each full dataset', 'mini has 160 IDs and every ID maps to submission full', 'scenario hashes compare every canonical JSON field without discarding semantic differences'],
    notRun: ['model calls', 'ARE experiments', 'oracle execution', 'verifier/judge evaluation'],
  }
  const indexPath = join(root, 'data', 'scenario-index.jsonl')
  const temporaryIndex = `${indexPath}.part-${process.pid}`
  await writeFile(temporaryIndex, allRecords.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8')
  await rename(temporaryIndex, indexPath)
  lock.scenarioIndex = { path: 'data/scenario-index.jsonl', sha256: await fileSha256(indexPath), count: allRecords.length }
  const reportPath = join(root, 'reports', 'phase0-dataset-mapping.json')
  await writeJsonAtomic(reportPath, report)
  lock.mappingReport = { path: 'reports/phase0-dataset-mapping.json', sha256: await fileSha256(reportPath) }
  await writeJsonAtomic(lockPath, lock)
  return { lock, index: allRecords, report }
}
