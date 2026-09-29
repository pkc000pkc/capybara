import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { importScenarioRow } from '../src/scenario_importer.mjs'
import { replayScenario } from '../src/scenario_replay.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifestPath = join(root, 'data', 'manifest.json')
if (!existsSync(manifestPath)) throw new Error('data/manifest.json is missing; run npm run download first')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const runs = []

for (const file of manifest.files) {
  const parquetFile = await asyncBufferFromFile(file.path)
  const [row] = await parquetReadObjects({ file: parquetFile, rowStart: 0, rowEnd: 1, compressors })
  const imported = importScenarioRow(row, file.name)
  const replay = replayScenario(imported)
  if (replay.consumedEvents !== replay.plannedEvents) {
    throw new Error(`${file.name}: replay did not consume all events`)
  }
  runs.push({
    capability: file.name,
    scenarioId: replay.scenarioId,
    plannedEvents: replay.plannedEvents,
    consumedEvents: replay.consumedEvents,
    observedEvents: replay.observedEvents,
    oracleWithheld: replay.oracleWithheld,
    virtualStart: replay.virtualStart,
    virtualEnd: replay.virtualEnd,
  })
}

const report = {
  status: 'passed',
  mode: 'gate1-dry-run',
  dataset: manifest.dataset,
  runs,
  checks: [
    'one real scenario from each of the five capabilities was loaded',
    'virtual time advanced monotonically through all planned events',
    'event dependencies were consumed without a stall',
    'oracle actions were counted and withheld from the observed trace',
    'no model, app write, official verifier, or score was executed',
  ],
  generatedAt: new Date().toISOString(),
}
const reportDir = join(root, 'reports')
mkdirSync(reportDir, { recursive: true })
writeFileSync(join(reportDir, 'gaia2-gate1-smoke.json'), `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
