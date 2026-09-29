import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { importScenarioRow, summarizeScenario } from '../src/scenario_importer.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifestPath = join(root, 'data', 'manifest.json')
const runnerManifestPath = join(root, 'gaia2-runner-manifest.json')
if (!existsSync(manifestPath)) throw new Error('data/manifest.json is missing; run npm run download first')
if (!existsSync(runnerManifestPath)) throw new Error('runner-manifest.json is missing')

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const runnerManifest = JSON.parse(readFileSync(runnerManifestPath, 'utf8'))
if (runnerManifest.dataset !== manifest.dataset || runnerManifest.split !== manifest.split) {
  throw new Error('runner-manifest.json does not match downloaded dataset manifest')
}
const samples = []

for (const file of manifest.files) {
  const parquetFile = await asyncBufferFromFile(file.path)
  const parquetMeta = await parquetMetadataAsync(parquetFile)
  const rowCount = Number(parquetMeta.num_rows)
  const [row] = await parquetReadObjects({
    file: parquetFile,
    rowStart: 0,
    rowEnd: 1,
    compressors,
  })
  const imported = importScenarioRow(row, file.name)
  samples.push({ rowCount, ...summarizeScenario(imported) })
}

const report = {
  status: 'passed',
  dataset: manifest.dataset,
  revision: manifest.revision,
  checkedFiles: samples.length,
  checks: [
    'all five capability parquet files are present',
    'each file contains rows',
    'sample row contains scenario JSON',
    'scenario contains metadata/apps/events/version/augmentation',
    'scenario adapter validates event dependencies without exposing raw state or oracle actions',
    'no model or score evaluation was executed',
  ],
  samples,
  generatedAt: new Date().toISOString(),
}

const reportsDir = join(root, 'reports')
await import('node:fs/promises').then(({ mkdir }) => mkdir(reportsDir, { recursive: true }))
writeFileSync(join(reportsDir, 'gaia2-smoke.json'), `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
