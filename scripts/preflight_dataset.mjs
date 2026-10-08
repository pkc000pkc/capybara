import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { importScenarioRow } from '../src/scenario_importer.mjs'
import { scenarioIdSetSha256, verifyDatasetLock } from '../src/phase0_dataset.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
if (process.argv.includes('--phase0')) {
  const protocol = JSON.parse(readFileSync(join(root, 'config', 'phase0-protocol.json'), 'utf8'))
  process.stdout.write(`${JSON.stringify(await verifyDatasetLock({ root, protocol, deep: !process.argv.includes('--shallow') }), null, 2)}\n`)
  process.exit(0)
}
const dataDir = join(root, 'data')
const manifestPath = join(dataDir, 'manifest.json')
const runnerManifestPath = join(root, 'gaia2-runner-manifest.json')
if (!existsSync(manifestPath)) throw new Error('data/manifest.json is missing; run npm run download first')

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const runner = JSON.parse(readFileSync(runnerManifestPath, 'utf8'))
const lockPath = join(root, 'locks', 'dataset-lock.json')
const lockedSource = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')).datasets?.source : null
if (lockedSource && (lockedSource.id !== manifest.dataset || lockedSource.revision !== manifest.revision || lockedSource.split !== manifest.split)) {
  throw new Error('source download manifest disagrees with immutable dataset lock')
}
if (runner.dataset !== manifest.dataset || runner.split !== manifest.split) {
  throw new Error('runner and download manifests disagree')
}
if (runner.resolvedDatasetRevision && runner.resolvedDatasetRevision !== manifest.revision) {
  throw new Error('runner manifest is pinned to a different dataset revision')
}
if (manifest.files.length !== runner.capabilities.length) {
  throw new Error('download manifest has an unexpected number of capability files')
}
if (new Set(manifest.files.map((entry) => entry.name)).size !== runner.capabilities.length) {
  throw new Error('download manifest has duplicate or missing capability files')
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

const scenarioIds = new Set()
const capabilities = []
const batchSize = 20

for (const entry of manifest.files) {
  if (!runner.capabilities.includes(entry.name)) throw new Error(`unexpected capability ${entry.name}`)
  const fileName = basename(entry.path)
  if (fileName !== `${entry.name}-test-00000-of-00001.parquet`) {
    throw new Error(`${entry.name}: unexpected parquet file name`)
  }
  const path = join(dataDir, fileName)
  if (!existsSync(path)) throw new Error(`${entry.name}: parquet file is missing`)
  const bytes = statSync(path).size
  if (bytes !== entry.bytes) throw new Error(`${entry.name}: file size disagrees with manifest`)
  const digest = await sha256(path)
  if (digest !== entry.sha256) throw new Error(`${entry.name}: SHA-256 disagrees with manifest`)
  const pinned = lockedSource?.files.find((file) => file.config === entry.name)
  if (lockedSource && (!pinned || pinned.sha256 !== digest || pinned.bytes !== bytes)) {
    throw new Error(`${entry.name}: source file differs from pinned remote LFS lock`)
  }

  const file = await asyncBufferFromFile(path)
  const parquetMetadata = await parquetMetadataAsync(file)
  const rowCount = Number(parquetMetadata.num_rows)
  if (rowCount !== 160) throw new Error(`${entry.name}: expected 160 rows, found ${rowCount}`)
  const eventTypes = {}
  let eventCount = 0
  let minDurationSeconds = Infinity
  let maxDurationSeconds = -Infinity

  for (let rowStart = 0; rowStart < rowCount; rowStart += batchSize) {
    const rows = await parquetReadObjects({
      file,
      columns: ['scenario_id', 'scenario'],
      rowStart,
      rowEnd: Math.min(rowStart + batchSize, rowCount),
      compressors,
    })
    for (const row of rows) {
      const imported = importScenarioRow(row, entry.name)
      if (scenarioIds.has(imported.scenarioId)) {
        throw new Error(`duplicate scenario ID across files: ${imported.scenarioId}`)
      }
      scenarioIds.add(imported.scenarioId)
      eventCount += imported.eventCount
      minDurationSeconds = Math.min(minDurationSeconds, imported.durationSeconds)
      maxDurationSeconds = Math.max(maxDurationSeconds, imported.durationSeconds)
      for (const [type, count] of Object.entries(imported.eventTypes)) {
        eventTypes[type] = (eventTypes[type] ?? 0) + count
      }
    }
    process.stdout.write(`${entry.name}: ${Math.min(rowStart + batchSize, rowCount)}/${rowCount}\n`)
  }

  capabilities.push({
    name: entry.name,
    rowCount,
    bytes,
    sha256: digest,
    eventCount,
    eventTypes,
    minDurationSeconds,
    maxDurationSeconds,
  })
}

const report = {
  status: 'passed',
  mode: 'dataset-preflight',
  dataset: manifest.dataset,
  datasetRevision: manifest.revision,
  split: manifest.split,
  scenarioCount: scenarioIds.size,
  scenarioIdSetSha256: scenarioIdSetSha256(scenarioIds),
  capabilities,
  checks: [
    'all five capability files match their downloaded size and SHA-256',
    'all 800 scenario IDs are unique and agree with their JSON definitions',
    'all scenario versions, apps, metadata, durations and event DAGs are valid',
    'the importer does not return raw scenario, app state, future events or oracle actions',
  ],
  notChecked: [
    'ARE runner and app/tool protocol',
    'model/provider endpoint',
    'official verifier/judge and score',
    'runtime event handling and external side effects',
  ],
  generatedAt: new Date().toISOString(),
}
const reportDir = join(root, 'reports')
if (lockedSource && report.scenarioIdSetSha256 !== lockedSource.scenarioIdSetSha256) {
  throw new Error('source scenario ID set differs from immutable dataset lock')
}
mkdirSync(reportDir, { recursive: true })
writeFileSync(join(reportDir, 'gaia2-preflight.json'), `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
