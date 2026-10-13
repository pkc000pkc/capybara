import { existsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson, within } from '../src/phase0_run.mjs'
import { selectPhase6ExecutionIds } from '../src/phase6_selection.mjs'
import { verifyPhase6HttpScope } from '../src/phase6_http_evidence.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
export function parsePhase6HttpArgs(argv) {
  const values = {}, executionIds = []
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1]
    if (!['--manifest', '--only-phase', '--only-run-number', '--selection-rule', '--execution-id', '--output'].includes(flag) || !value || value.startsWith('--') || flag !== '--execution-id' && Object.hasOwn(values, flag)) throw new Error('invalid_arguments')
    if (flag === '--execution-id') executionIds.push(value)
    else values[flag] = value
  }
  if (!values['--manifest']) throw new Error('manifest_required')
  const onlyRunNumber = values['--only-run-number'] === undefined ? null : Number(values['--only-run-number'])
  if (onlyRunNumber !== null && !/^[1-5]$/.test(values['--only-run-number'])) throw new Error('run_number_invalid')
  return { values, selection: { executionIds: executionIds.length ? executionIds : null, onlyPhase: values['--only-phase'] ?? null, onlyRunNumber, rule: values['--selection-rule'] ?? null } }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
try {
  const { values, selection } = parsePhase6HttpArgs(process.argv.slice(2))
  const manifest = readJson(resolve(root, values['--manifest'])), state = readJson(resolve(root, manifest.stateFile))
  const executionIds = selectPhase6ExecutionIds(manifest, selection)
  const report = verifyPhase6HttpScope({ root, manifest, state, executionIds })
  if (values['--output']) {
    const output = resolve(root, values['--output'])
    if (!within(resolve(root, manifest.runRoot), output) || existsSync(output)) throw new Error('new_run_output_required')
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  }
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  const message = String(error?.message ?? '')
  const code = message.match(/^(?:Phase 6 (?:HTTP evidence|selection|process identity): )?([a-z0-9_]+)$/)?.[1] ?? 'http_evidence_rejected'
  console.error(JSON.stringify({ schemaVersion: 'gaia2-phase6-http-scope-report-v1', status: 'rejected', errorCode: code, noModelExecution: true, officialSubmissionReady: false }))
  process.exitCode = 2
}
}
