import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { aggregatePhase4Metrics } from '../src/phase4_metrics.mjs'
import { aggregateOperationalUsage } from '../src/phase4_cost.mjs'
import { aggregateCorrectionUsage, assertSafeMetricsOutput } from '../src/phase4_usage.mjs'
import { fileDigest, writeJson } from '../src/phase0_run.mjs'
import { loadTrainingParent, trainingEvidenceReader } from '../src/phase4_training.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url))), values = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1]
  if (!['--manifest', '--ledger', '--output'].includes(key) || !value || value.startsWith('--') || values[key]) throw new Error('invalid phase 4 metrics argument')
  values[key] = value
}
if (!values['--manifest']) throw new Error('frozen initial manifest required')
const outputPath = values['--output'] ? assertSafeMetricsOutput({ root, path: values['--output'] }) : null
const readEvidence = trainingEvidenceReader(root), portable = path => path.replaceAll('\\', '/')
const manifest = JSON.parse(readEvidence(portable(values['--manifest'])))
const state = JSON.parse(readEvidence(portable(manifest.stateFile)))
const initialResults = [], executions = []
for (const task of manifest.tasks) {
  const record = state.tasks.find(record => record.executionId === task.executionId)
  if (!record?.resultPath) { initialResults.push({ executionId: task.executionId, status: 'pending' }); continue }
  const parent = loadTrainingParent({ root, manifestPath: values['--manifest'], executionId: task.executionId })
  initialResults.push({ executionId: task.executionId, status: record.status === 'completed' ? 'evaluated' : 'technical',
    session: parent.session, result: parent.result, events: parent.events, readEvidence: parent.readEvidence })
  const process = JSON.parse(parent.readEvidence(`${parent.session.outputDir}/process-result.json`))
  executions.push({ executionId: task.executionId, kind: 'initial', events: parent.events, elapsedMs: process.elapsedMs })
}
const correctionLedger = values['--ledger'] ? JSON.parse(readEvidence(portable(values['--ledger']))) : null
const metrics = aggregatePhase4Metrics({ root, manifest, initialResults, correctionLedger, readEvidence })
const correctionUsage = aggregateCorrectionUsage({ root, manifest, initialResults, correctionLedger, readEvidence })
const report = { schemaVersion: 'gaia2-phase4-metrics-report-v1', metrics,
  initialUsage: aggregateOperationalUsage({ executions }), correctionUsage,
  initialUsageComplete: metrics.initialEvaluationComplete,
  correctionUsageIncluded: correctionUsage.verifiedExecutions.length > 0,
  correctionUsageComplete: correctionUsage.correctionUsageComplete,
  manifestFileSha256: fileDigest(resolve(root, values['--manifest'])), noModelExecution: true,
  officialSubmissionReady: false, generatedAt: new Date().toISOString() }
if (outputPath) {
  assertSafeMetricsOutput({ root, path: outputPath })
  writeJson(outputPath, report, { immutable: true })
}
console.log(JSON.stringify(report, null, 2))
