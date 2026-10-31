import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyJudgeReliability } from '../src/judge_reliability.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runsRoot = join(root, 'runs')
const outputPath = join(root, 'reports', 'gaia2-official-provenance-backfill-latest.json')

function digest(value) { return createHash('sha256').update(value, 'utf8').digest('hex') }
function walk(dir) {
  const files = [], pending = existsSync(dir) ? [dir] : []
  while (pending.length) {
    const current = pending.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (lstatSync(path).isSymbolicLink()) continue
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  return files
}

function findOfficialFile(taskRoot, scenarioId) {
  const candidates = walk(join(taskRoot, 'output')).filter(path =>
    /(?:^|[\\/])lite[\\/][^\\/]+\.json$/i.test(path))
  for (const path of candidates) {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'))
      if (value.scenario_id === scenarioId && ['Valid', 'Invalid'].includes(value.validation_decision)) return { path, value }
    } catch { /* malformed diagnostic files are not provenance */ }
  }
  return null
}

const rows = []
for (const path of walk(runsRoot)) {
  if (!path.endsWith('report.json') || !path.includes(`${requireSeparator()}task-`)) continue
  let report
  try { report = JSON.parse(readFileSync(path, 'utf8')) } catch { continue }
  if (report.evaluationComplete !== true || ![0, 1].includes(report.rawScore)) continue
  const found = findOfficialFile(dirname(path), report.scenarioId)
  if (!found) {
    rows.push({ reportPath: relative(root, path).replaceAll('\\', '/'), scenarioId: report.scenarioId,
      rawScore: report.rawScore, previousReliability: report.scoreReliability, status: 'missing' })
    continue
  }
  const officialEvidence = { schemaVersion: 'gaia2-official-validation-evidence-v1',
    validationDecision: found.value.validation_decision, rawScore: report.rawScore,
    fileSha256: digest(readFileSync(found.path, 'utf8')), source: 'are_lite_validation_metadata-v1' }
  const reliability = classifyJudgeReliability({ evaluationComplete: true, rawScore: report.rawScore,
    technicalError: report.technicalError ?? null,
    judgeEvidence: report.judgeEvidence ?? report.judgeReliability?.sidecar ?? null,
    officialEvidence })
  rows.push({ reportPath: relative(root, path).replaceAll('\\', '/'), scenarioId: report.scenarioId,
    rawScore: report.rawScore, previousReliability: report.scoreReliability,
    officialEvidence, derivedReliability: reliability.scoreReliability,
    eligibleForModelMetrics: reliability.eligibleForModelMetrics,
    reason: reliability.reason })
}

const summary = { totalCompleted: rows.length, officialOracle: rows.filter(row => row.derivedReliability === 'official_oracle').length,
  reliableJudge: rows.filter(row => row.derivedReliability === 'reliable').length,
  protocolAffected: rows.filter(row => row.derivedReliability === 'protocol_affected').length,
  unknown: rows.filter(row => !row.derivedReliability || row.derivedReliability === 'unknown' || row.status === 'missing').length,
  rawPassOfficialOracle: rows.filter(row => row.derivedReliability === 'official_oracle' && row.rawScore === 1).length,
  rawFailOfficialOracle: rows.filter(row => row.derivedReliability === 'official_oracle' && row.rawScore === 0).length }
const payload = { schemaVersion: 'gaia2-official-provenance-backfill-v1', generatedAt: new Date().toISOString(),
  sourceRoot: 'runs', summary, rows, rowsSha256: digest(JSON.stringify(rows)) }
mkdirSync(dirname(outputPath), { recursive: true })
const temp = `${outputPath}.tmp-${process.pid}`
writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' })
renameSync(temp, outputPath)
console.log(JSON.stringify({ outputPath: relative(root, outputPath).replaceAll('\\', '/'), summary }, null, 2))

function requireSeparator() { return process.platform === 'win32' ? '\\' : '/' }
