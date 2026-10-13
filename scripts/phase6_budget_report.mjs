import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { within } from '../src/phase0_run.mjs'
import { buildPhase6BudgetReport } from '../src/phase6_budget.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

export function parsePhase6BudgetArgs(argv) {
  const options = { manifestPath: null, executionIds: [], healthReportPaths: [], outputPath: null }
  const singles = new Map([['--manifest', 'manifestPath'], ['--output', 'outputPath'], ['--only-phase', 'onlyPhase'],
    ['--only-run-number', 'onlyRunNumber'], ['--rule', 'rule'], ['--export-dir', 'exportDir']])
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], value = argv[++i]
    if (typeof value !== 'string' || !value || value.startsWith('--')) throw new Error('Phase 6 budget CLI: missing_flag_value')
    if (flag === '--execution-id') options.executionIds.push(value)
    else if (flag === '--health-report') options.healthReportPaths.push(value)
    else {
      if (!singles.has(flag) || seen.has(flag)) throw new Error('Phase 6 budget CLI: unknown_or_duplicate_flag')
      seen.add(flag); options[singles.get(flag)] = value
    }
  }
  if (!options.manifestPath) throw new Error('Phase 6 budget CLI: manifest_required')
  if (options.onlyRunNumber !== undefined) {
    if (!/^[1-5]$/.test(options.onlyRunNumber)) throw new Error('Phase 6 budget CLI: invalid_run_number')
    options.onlyRunNumber = Number(options.onlyRunNumber)
  }
  if (!options.executionIds.length) options.executionIds = null
  return options
}

/** Optional derived report only: fail closed on existing files/junctions and
 * never place new budget reports inside any historical frozen runs directory. */
export function writePhase6BudgetReport({ root: projectRoot, outputPath, report }) {
  const base = resolve(projectRoot), target = resolve(base, outputPath)
  if (!within(base, target) || target === base || within(resolve(base, 'runs'), target)) throw new Error('Phase 6 budget CLI: unsafe_output_path')
  for (let at = target; ; at = dirname(at)) {
    const stat = lstatSync(at, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink()) throw new Error('Phase 6 budget CLI: symbolic_output_path')
    if (at === dirname(at)) break
  }
  if (existsSync(target)) throw new Error('Phase 6 budget CLI: immutable_output_exists')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  return target
}

export function runPhase6BudgetReport({ root: projectRoot = root, outputPath = null, ...options }) {
  const report = buildPhase6BudgetReport({ root: projectRoot, ...options })
  if (outputPath !== null) writePhase6BudgetReport({ root: projectRoot, outputPath, report })
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = runPhase6BudgetReport(parsePhase6BudgetArgs(process.argv.slice(2)))
    console.log(JSON.stringify(report, null, 2))
  } catch (error) {
    // Emit finite diagnostic codes, not raw credential-bearing source/errors.
    const message = String(error?.message ?? '')
    const code = /^(?:Phase 6 budget(?: CLI)?|Phase 6 selection|Phase 3 runtime evidence): [a-z0-9_]+$/.test(message)
      ? message : 'Phase 6 budget CLI: source_validation_failed'
    console.error(JSON.stringify({ schemaVersion: 'gaia2-phase6-budget-report-v1', status: 'rejected', error: code,
      noModelExecution: true, officialSubmissionReady: false }, null, 2))
    process.exitCode = 2
  }
}
