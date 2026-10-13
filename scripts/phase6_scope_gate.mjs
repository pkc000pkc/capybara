import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson } from '../src/phase0_run.mjs'
import { auditPhase6Scope } from '../src/phase6_scope_gate.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const allowed = new Set(['--manifest', '--export-dir', '--export-report', '--export-report-sha256', '--budget', '--budget-sha256', '--production-http-evidence', '--production-http-evidence-sha256', '--only-phase', '--only-run-number', '--selection-rule', '--execution-id'])
const values = {}, ids = []
try {
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1]
    if (!allowed.has(key) || !value || value.startsWith('--') || key !== '--execution-id' && Object.hasOwn(values, key)) throw new Error('invalid scope-gate arguments')
    if (key === '--execution-id') ids.push(value); else values[key] = value
  }
  for (const key of ['--manifest', '--export-dir', '--export-report', '--export-report-sha256', '--budget', '--budget-sha256', '--production-http-evidence', '--production-http-evidence-sha256']) if (!values[key]) throw new Error(`missing ${key}`)
  if (values['--only-run-number'] && !/^[1-5]$/.test(values['--only-run-number'])) throw new Error('invalid run-number selector')
  const selection = { ...(ids.length ? { executionIds: ids } : {}), ...(values['--only-phase'] ? { onlyPhase: values['--only-phase'] } : {}), ...(values['--only-run-number'] ? { onlyRunNumber: Number(values['--only-run-number']) } : {}), ...(values['--selection-rule'] ? { rule: values['--selection-rule'] } : {}) }
  const report = await auditPhase6Scope({ root, manifest: readJson(resolve(root, values['--manifest'])), selection, exportDir: values['--export-dir'], exportReportRef: { path: values['--export-report'], sha256: values['--export-report-sha256'] }, budgetRef: { path: values['--budget'], sha256: values['--budget-sha256'] }, productionHttpRef: { path: values['--production-http-evidence'], sha256: values['--production-http-evidence-sha256'] } })
  console.log(JSON.stringify(report, null, 2))
  if (!report.scopeAcceptancePassed) process.exitCode = 2
} catch (error) {
  const message = /^(?:invalid scope-gate arguments|missing --[a-z-]+|invalid run-number selector)$/.test(error?.message ?? '') ? error.message : 'scope_gate_configuration_or_read_failed'
  console.error(JSON.stringify({ schemaVersion: 'gaia2-phase6-scope-gate-v1', status: 'rejected', error: message, noModelExecution: true, officialSubmissionReady: false })); process.exitCode = 2
}
