import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson, writeJson } from '../src/phase0_run.mjs'
import { loadTrainingParent } from '../src/phase4_training.mjs'
import { buildCorrectionAttribution } from '../src/phase4_correction_attribution.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url))), values = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1]
  if (!['--manifest', '--output'].includes(key) || !value || value.startsWith('--') || values[key]) throw new Error('usage: phase9-correction-attribution --manifest runs/<id>/run-manifest.json --output reports/<file>.json')
  values[key] = value
}
if (!values['--manifest'] || !values['--output']) throw new Error('manifest and output are required')
const manifestPath = resolve(root, values['--manifest']), manifest = readJson(manifestPath)
const parents = manifest.tasks.map(task => loadTrainingParent({ root, manifestPath, executionId: task.executionId }))
const report = buildCorrectionAttribution({ manifest, parents })
writeJson(resolve(root, values['--output']), { ...report, generatedAt: new Date().toISOString() }, { immutable: true })
console.log(JSON.stringify({ output: resolve(root, values['--output']), totalInitialAttempts: report.totalInitialAttempts,
  decisionRequiredAttempts: report.decisionRequiredAttempts, noObservableDefectAttempts: report.noObservableDefectAttempts,
  defectCounts: report.defectCounts, noModelExecution: true, officialSubmissionReady: false }, null, 2))
