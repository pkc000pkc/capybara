import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditPhase0, validateRunManifest } from '../src/phase0_audit.mjs'
import { loadRunInputs, readJson } from '../src/phase0_run.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function parseArgs(argv) {
  const values = {}
  const allowed = new Set(['--manifest', '--only-phase', '--only-run-number', '--max-tasks'])
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!allowed.has(flag) || !argv[index + 1] || argv[index + 1].startsWith('--') || Object.hasOwn(values, flag)) throw new Error('usage: phase6-resume-plan --manifest <path> [--only-phase standard|agent2agent|noise] [--only-run-number 1..5] [--max-tasks N]')
    values[flag] = argv[++index]
  }
  if (!values['--manifest']) throw new Error('manifest is required')
  if (values['--only-phase'] && !['standard', 'agent2agent', 'noise'].includes(values['--only-phase'])) throw new Error('only-phase must be standard, agent2agent, or noise')
  if (values['--only-run-number'] && !/^[1-5]$/.test(values['--only-run-number'])) throw new Error('only-run-number must be 1..5')
  if (values['--max-tasks'] && (!/^\d+$/.test(values['--max-tasks']) || Number(values['--max-tasks']) < 1)) throw new Error('max-tasks must be a positive integer')
  return values
}

export function buildResumePlan({ manifest, state = null, onlyPhase = null, onlyRunNumber = null, maxTasks = null } = {}) {
  const selected = manifest.tasks.filter(task => (onlyPhase === null || task.phase === onlyPhase) && (onlyRunNumber === null || task.runNumber === onlyRunNumber))
  const stateById = new Map((state?.tasks ?? []).map(task => [task.executionId, task]))
  const rows = selected.map(task => {
    const record = stateById.get(task.executionId)
    return { executionId: task.executionId, phase: task.phase, config: task.config, scenarioId: task.scenarioId, runNumber: task.runNumber, status: record?.status ?? 'pending', sessions: record?.sessions?.length ?? 0 }
  })
  const counts = Object.fromEntries(['pending', 'running', 'completed', 'retry_pending', 'terminal_failure'].map(status => [status, rows.filter(row => row.status === status).length]))
  const needsResume = counts.retry_pending > 0 || counts.running > 0
  const needsExecution = rows.some(row => !['completed', 'terminal_failure'].includes(row.status))
  const bounded = maxTasks === null ? rows : rows.slice(0, maxTasks)
  return {
    schemaVersion: 'gaia2-phase6-resume-plan-v1',
    runId: manifest.runId,
    manifestHash: manifest.manifestHash,
    mode: manifest.mode,
    selectedExecutions: rows.length,
    selectedRows: rows,
    selectedCounts: counts,
    boundedExecutionIds: bounded.map(row => row.executionId),
    needsResume,
    needsExecution,
    recommendedFlags: needsResume ? ['--execute', '--resume', '--retry-infrastructure'] : needsExecution ? ['--execute'] : [],
    noModelExecution: true,
    officialSubmissionReady: false,
    realHooksReady: false,
  }
}

async function main(argv = process.argv.slice(2)) {
  const values = parseArgs(argv)
  const manifestPath = resolve(root, values['--manifest'])
  const manifest = readJson(manifestPath)
  const audit = await auditPhase0(root, { deep: false })
  const errors = audit.phase0Passed ? validateRunManifest(root, manifest, loadRunInputs(root), manifest.entrypoints.environmentOverrides) : audit.errors
  if (errors.length) {
    return { schemaVersion: 'gaia2-phase6-resume-plan-v1', status: 'rejected', manifestPath, errors, noModelExecution: true, officialSubmissionReady: false, realHooksReady: false }
  }
  const statePath = resolve(root, manifest.stateFile)
  const state = existsSync(statePath) ? readJson(statePath) : null
  const onlyPhase = values['--only-phase'] ?? null
  const onlyRunNumber = values['--only-run-number'] ? Number(values['--only-run-number']) : null
  const maxTasks = values['--max-tasks'] ? Number(values['--max-tasks']) : null
  const plan = buildResumePlan({ manifest, state, onlyPhase, onlyRunNumber, maxTasks })
  const rootPrefix = `${root}${'\\'}`
  const relativeManifest = manifestPath.startsWith(rootPrefix) ? manifestPath.slice(root.length + 1).replaceAll('\\', '/') : manifestPath
  const flags = [...plan.recommendedFlags, '--manifest', relativeManifest]
  if (onlyPhase) flags.push('--only-phase', onlyPhase)
  if (onlyRunNumber !== null) flags.push('--only-run-number', String(onlyRunNumber))
  if (maxTasks !== null) flags.push('--max-tasks', String(maxTasks))
  return { ...plan, status: plan.needsExecution ? 'ready_when_model_stable' : 'nothing_to_execute', recommendedCommand: `node scripts/official_e2e_smoke.mjs ${flags.join(' ')}` }
}

if (process.argv[1] && process.argv[1].endsWith('phase6_resume_plan.mjs')) {
  try { console.log(JSON.stringify(await main(), null, 2)) }
  catch (error) { console.error(JSON.stringify({ schemaVersion: 'gaia2-phase6-resume-plan-v1', status: 'configuration_error', errorType: error?.name ?? 'Error', error: String(error?.message ?? error).slice(0, 240), noModelExecution: true }, null, 2)); process.exitCode = 2 }
}
