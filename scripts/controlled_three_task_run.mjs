/**
 * Controlled three-task validation for the generic runtime refactor.
 *
 * Selects one Standard execution task, one A2A mini task and one Noise mini
 * task from the frozen library manifest. It deliberately uses the normal
 * executeFullLibraryTask path and writes a new isolated run directory; it is
 * not a benchmark campaign and never changes the frozen full-library run.
 */
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { digest, readJson } from '../src/phase0_run.mjs'
import { readModelConnection } from '../src/phase1_official.mjs'
import { executeFullLibraryTask } from './full_library_task.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE_MANIFEST = process.env.GAIA2_BASE_MANIFEST
  ?? 'D:/gitlocals/kanli8-human/capybara-test-workspaces/gaia2-project/runs/full-library-once-20261101T033443802Z-61498882/manifest.json'

function selectTasks(base) {
  const selected = [
    base.tasks.find(task => task.phase === 'standard' && task.config === 'execution'),
    base.tasks.find(task => task.phase === 'agent2agent' && task.config === 'mini'),
    base.tasks.find(task => task.phase === 'noise' && task.config === 'mini'),
  ].filter(task => !process.env.GAIA2_CONTROLLED_ONLY_PHASE || task.phase === process.env.GAIA2_CONTROLLED_ONLY_PHASE)
  assert.ok(selected.every(Boolean), 'frozen manifest lacks one of the three required profiles')
  const runId = `controlled-three-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`
  // Keep the complete frozen task index in the controlled manifest. The
  // executor validates task identity against that index, and A2A's trusted
  // app-agent binding also expects the original execution/source identity.
  return { runId, selected, tasks: base.tasks }
}

async function main() {
  const base = readJson(BASE_MANIFEST)
  const { runId, selected, tasks } = selectTasks(base)
  const runRoot = `runs/${runId}`
  const sourceCapabilities = resolve(dirname(BASE_MANIFEST), 'capabilities.json')
  const capabilityPath = resolve(ROOT, runRoot, 'capabilities.json')
  mkdirSync(resolve(ROOT, runRoot), { recursive: true })
  copyFileSync(sourceCapabilities, capabilityPath)
  const manifestBase = { ...base, runId, runRoot, tasks, plannedExecutions: tasks.length,
    enhancedRunCount: 0, originalCampaignModified: false,
    lockRefs: { ...base.lockRefs, capabilities: { path: `${runRoot}/capabilities.json`,
      sha256: readJson(sourceCapabilities) ? base.lockRefs.capabilities.sha256 : base.lockRefs.capabilities.sha256 } },
    scopePolicy: { ...(base.scopePolicy ?? {}), maxExecutions: tasks.length, checkpointEvery: tasks.length },
    selectionRule: 'controlled three-task validation: one standard execution, one A2A mini, one Noise mini',
    officialSubmissionReady: false }
  const manifest = { ...manifestBase, manifestHash: digest(manifestBase) }
  writeFileSync(resolve(ROOT, runRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  const connection = readModelConnection(ROOT, manifest.models)
  const controller = new AbortController()
  const reports = []
  for (const [index, task] of selected.entries()) {
    process.stdout.write(JSON.stringify({ event: 'task_started', index: index + 1, phase: task.phase, config: task.config, scenarioId: task.scenarioId }) + '\n')
    const report = await executeFullLibraryTask({ root: ROOT, manifest, task, index, connection, signal: controller.signal })
    reports.push(report)
    process.stdout.write(JSON.stringify({ event: 'task_finished', index: index + 1, phase: task.phase, config: task.config,
      scenarioId: task.scenarioId, status: report.status, rawScore: report.rawScore ?? null,
      technicalError: report.technicalError ?? null, scoreReliability: report.scoreReliability,
      controllerUsage: report.controllerUsage }) + '\n')
  }
  const summary = { schemaVersion: 'gaia2-controlled-three-summary-v1', runId, manifestHash: manifest.manifestHash,
    reports: reports.map(report => ({ executionId: report.executionId, phase: report.phase, config: report.config,
      scenarioId: report.scenarioId, status: report.status, rawScore: report.rawScore ?? null,
      technicalError: report.technicalError ?? null, scoreReliability: report.scoreReliability,
      judgeProtocolAffected: report.judgeProtocolAffected, controllerUsage: report.controllerUsage })) }
  writeFileSync(resolve(ROOT, runRoot, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8')
  console.log(JSON.stringify({ status: 'completed', runId, runRoot, summaryPath: `${runRoot}/summary.json`, reports: summary.reports }))
}

main().catch(error => { console.error(JSON.stringify({ status: 'failed', errorType: error?.name ?? 'Error', message: String(error?.message ?? error) })); process.exitCode = 1 })
