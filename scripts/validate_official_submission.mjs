import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Audits an ARE output tree without contacting the model service or HuggingFace.
// The official standalone uploader expects:
//   <input>/standard/<config>/output.jsonl
//   <input>/agent2agent/<config>/output.jsonl
//   <input>/noise/<config>/output.jsonl
// and each JSONL metadata object must include scenario_id and run_number.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const inputRoot = resolve(process.argv[2] || join(root, 'official-results', 'batch-10'))
const outputPath = resolve(process.argv[3] || join(root, 'reports', 'official-submission-format-audit.json'))
const expectedPhases = ['standard', 'agent2agent', 'noise']

function walk(dir) {
  if (!existsSync(dir)) return []
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(path))
    else files.push(path)
  }
  return files
}

const jsonlFiles = walk(inputRoot).filter((path) => path.endsWith('output.jsonl'))
const entries = []
const errors = []
for (const path of jsonlFiles) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let index = 0; index < lines.length; index += 1) {
    let entry
    try { entry = JSON.parse(lines[index]) } catch (error) {
      errors.push({ path, line: index + 1, code: 'invalid_jsonl', message: error.message })
      continue
    }
    const required = ['task_id', 'trace_id', 'score', 'metadata']
    for (const key of required) if (!(key in entry)) errors.push({ path, line: index + 1, code: 'missing_field', field: key })
    const metadata = entry.metadata || {}
    for (const key of ['scenario_id', 'run_number']) {
      if (!(key in metadata)) errors.push({ path, line: index + 1, code: 'missing_metadata_field', field: key })
    }
    const tracePath = typeof entry.trace_id === 'string' ? entry.trace_id : null
    if (!tracePath || !existsSync(tracePath)) errors.push({ path, line: index + 1, code: 'missing_trace', trace_id: tracePath })
    else {
      try {
        const trace = JSON.parse(readFileSync(tracePath, 'utf8'))
        for (const key of ['world_logs', 'apps', 'events', 'completed_events', 'version', 'context', 'augmentation', 'metadata']) {
          if (!(key in trace)) errors.push({ path, line: index + 1, code: 'trace_missing_field', field: key })
        }
      } catch (error) { errors.push({ path, line: index + 1, code: 'invalid_trace_json', message: error.message }) }
    }
    entries.push({ path, line: index + 1, scenarioId: metadata.scenario_id ?? null, runNumber: metadata.run_number ?? null, status: metadata.status ?? null, score: entry.score ?? null })
  }
}

const phaseLayout = expectedPhases.every((phase) => existsSync(join(inputRoot, phase)))
const duplicateKeys = []
const seen = new Map()
for (const entry of entries) {
  const key = `${entry.scenarioId}::${entry.runNumber}`
  if (seen.has(key)) duplicateKeys.push({ key, first: seen.get(key), duplicate: entry.path })
  else seen.set(key, entry.path)
}
const report = {
  schemaVersion: 'gaia2-official-submission-format-audit-v1',
  inputRoot,
  checkedOutputFiles: jsonlFiles.length,
  checkedEntries: entries.length,
  phaseLayout,
  expectedPhaseLayout: '<root>/<standard|agent2agent|noise>/<config>/output.jsonl',
  duplicateScenarioRuns: duplicateKeys,
  errors,
  rawAreEnvelopeValid: jsonlFiles.length > 0 && entries.length > 0 && errors.length === 0,
  submissionReady: phaseLayout && jsonlFiles.length > 0 && entries.length > 0 && errors.length === 0 && duplicateKeys.length === 0,
  statusCounts: Object.fromEntries([...new Set(entries.map((entry) => entry.status))].map((status) => [status, entries.filter((entry) => entry.status === status).length])),
  generatedAt: new Date().toISOString(),
}
mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (!report.submissionReady) process.exitCode = 2
