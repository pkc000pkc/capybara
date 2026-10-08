import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportSubmissionPackage } from '../src/phase2_export.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const values = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i], value = process.argv[i + 1]
  if (!['--manifest', '--output'].includes(flag) || !value || value.startsWith('--') || values[flag]) throw new Error('usage: export-official --manifest runs/<id>/run-manifest.json --output <new-submission-directory>')
  values[flag] = value
}
if (!values['--manifest'] || !values['--output']) throw new Error('manifest and new output directory required; this command never executes tasks')
const controller = new AbortController(), abort = () => controller.abort()
process.on('SIGINT', abort); process.on('SIGTERM', abort)
try {
  const report = await exportSubmissionPackage({ root, manifestPath: resolve(root, values['--manifest']), outputDir: resolve(root, values['--output']), signal: controller.signal })
  console.log(JSON.stringify({ packageRoot: report.packageRoot, exportedRows: report.exportedRows, missingExecutions: report.missingExecutions, format_valid: report.audit.format_valid, coverage_complete: report.audit.coverage_complete, evaluation_complete: report.audit.evaluation_complete, officialSubmissionReady: false, noModelExecution: true }, null, 2))
  if (!report.audit.format_valid || !report.audit.coverage_complete || !report.audit.evaluation_complete) process.exitCode = 2
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', errorType: error.name, noModelExecution: true, officialSubmissionReady: false }))
  process.exitCode = controller.signal.aborted ? 130 : 2
} finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort) }
