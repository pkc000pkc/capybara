import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson } from '../src/phase0_run.mjs'
import { loadTrainingParent, runTrainingProbe } from '../src/phase4_training.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url))), values = {}
let execute = false
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i]
  if (key === '--execute' && !execute) execute = true
  else if (['--manifest', '--execution-id', '--training-manifest', '--output'].includes(key) && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') && !values[key]) values[key] = process.argv[++i]
  else throw new Error('invalid training probe argument')
}
for (const key of ['--manifest', '--execution-id']) if (!values[key]) throw new Error(`missing ${key}`)
const parent = loadTrainingParent({ root, manifestPath: values['--manifest'], executionId: values['--execution-id'] })
if (!execute) {
  console.log(JSON.stringify({ eligible: parent.evidence.eligible, trainingAllowed: parent.evidence.trainingAllowed,
    reason: parent.evidence.reason, sealedInput: parent.evidence.sealed, noModelExecution: true, noReplayExecution: true }, null, 2))
} else {
  if (!values['--training-manifest'] || !values['--output']) throw new Error('frozen training manifest and new output required for execution')
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort())
  const path = resolve(root, values['--training-manifest'])
  const report = await runTrainingProbe({ root, parent, trainingManifest: readJson(path), trainingManifestPath: path,
    outputDir: values['--output'], signal: controller.signal })
  console.log(JSON.stringify({ status: report.status, realModelCalls: report.realModelCalls,
    taskLocalOnly: true, replayExecuted: false, projectExperiencePromoted: false, officialSubmissionReady: false }, null, 2))
  if (report.status === 'training_failed') process.exitCode = 2
}
