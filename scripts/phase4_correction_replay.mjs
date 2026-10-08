import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileDigest, readJson } from '../src/phase0_run.mjs'
import { resolveRuntimeSettings } from '../src/phase1_config.mjs'
import { resolveModelRetrySettings } from '../src/phase1_official.mjs'
import { createCorrectionReplayPlan, runCorrectionReplay, verifyCorrectionReplay } from '../src/phase4_replay.mjs'
import { trainingEvidenceReader } from '../src/phase4_training.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url))), values = {}
let execute = false
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i]
  if (key === '--execute' && !execute) execute = true
  else if (['--manifest', '--training-report', '--output'].includes(key) && process.argv[i + 1]
    && !process.argv[i + 1].startsWith('--') && !values[key]) values[key] = process.argv[++i]
  else throw new Error('invalid correction replay argument')
}
for (const key of ['--manifest', '--training-report', '--output']) if (!values[key]) throw new Error(`missing ${key}`)
const manifestPath = resolve(root, values['--manifest']), reportPath = resolve(root, values['--training-report'])
// Validate paths before readJson/fileDigest; neither may follow external links.
const reader = trainingEvidenceReader(root), local = path => relative(root, path).replaceAll('\\', '/')
const manifest = JSON.parse(reader(local(manifestPath)))
reader(local(reportPath))
const trainingReportRef = { path: local(reportPath), sha256: fileDigest(reportPath) }
if (!execute) {
  const plan = createCorrectionReplayPlan({ root, manifest, trainingReportRef, outputDir: values['--output'] })
  console.log(JSON.stringify({ status: 'validated_not_executed', parentExecutionId: plan.task.correctionContext.parentExecutionId,
    correctionOrdinal: 1, initialAttemptCountDelta: 0, noModelExecution: true, officialSubmissionReady: false }, null, 2))
} else {
  const settings = { ...resolveRuntimeSettings({ protocol: { requestedRuntime: manifest.requestedRuntime }, entrypoint: 'pilot', env: {} }), modelRetry: resolveModelRetrySettings({}) }
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort())
  const result = await runCorrectionReplay({ root, manifest, trainingReportRef, outputDir: values['--output'], settings, signal: controller.signal })
  const proof = result.report.status === 'replay_evaluated' ? verifyCorrectionReplay({ root, replayReportRef: result.reportRef }) : null
  console.log(JSON.stringify({ status: result.report.status, reportRef: result.reportRef,
    businessPassed: proof?.businessPassed ?? null, score: proof?.score ?? null,
    consumedStrategyHash: proof?.strategyHash ?? null, initialAttemptCountDelta: 0, officialSubmissionReady: false }, null, 2))
  if (!proof) process.exitCode = 2
}
