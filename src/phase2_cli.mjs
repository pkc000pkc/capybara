import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readJson, writeJson } from './phase0_run.mjs'
import { auditSubmissionPackage } from './phase2_audit.mjs'
import { runOfficialConversion } from './phase2_export.mjs'

export async function runSubmissionAuditCli({ root, argv = process.argv.slice(2) }) {
  const values = {}, positional = []
  let structuralOnly = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--structural-only' && !structuralOnly) structuralOnly = true
    else if (['--input', '--report'].includes(arg) && argv[i + 1] && !argv[i + 1].startsWith('--') && !values[arg]) values[arg] = argv[++i]
    else if (!arg.startsWith('--') && positional.length < 2) positional.push(arg)
    else throw new Error('usage: audit-official --input <submission-root> [--report <new-report.json>] [--structural-only]')
  }
  if (!values['--input'] && !positional[0]) throw new Error('submission root required; no historical report is overwritten')
  const packageRoot = resolve(root, values['--input'] ?? positional[0])
  const reportPath = resolve(root, values['--report'] ?? positional[1] ?? `reports/phase2-audit-${Date.now()}-${randomUUID().slice(0, 8)}.json`)
  if (existsSync(reportPath)) throw new Error('report already exists; use a new report path')
  let officialCheck = null
  const initial = auditSubmissionPackage({ packageRoot })
  if (!structuralOnly && initial.format_valid && initial.metrics.duplicateRows === 0 && initial.mode !== null) {
    let plan = null
    try { if (existsSync(join(packageRoot, 'run-manifest.json'))) plan = readJson(join(packageRoot, 'run-manifest.json')) } catch { /* Audit records corrupt evidence; still save the diagnostic report. */ }
    if (plan) officialCheck = await runOfficialConversion({ root, operation: 'check', spec: { packageRoot, model: plan.models?.actor?.model ?? 'unknown', provider: plan.models?.actor?.provider ?? 'unknown' }, diagnosticsRoot: join(dirname(reportPath), `phase2-tools-${randomUUID()}`) })
  }
  const report = { ...auditSubmissionPackage({ packageRoot, officialCheck }), packageRoot, officialCheck, noModelExecution: true, generatedAt: new Date().toISOString() }
  writeJson(reportPath, report, { immutable: true })
  console.log(JSON.stringify({ format_valid: report.format_valid, coverage_complete: report.coverage_complete, evaluation_complete: report.evaluation_complete, officialSubmissionReady: false, officialCheckPassed: report.officialCheckPassed, metrics: report.metrics, issueCount: report.issues.length, reportPath, noModelExecution: true }, null, 2))
  if (!report.format_valid || !report.coverage_complete || !report.evaluation_complete) process.exitCode = 2
  return report
}
