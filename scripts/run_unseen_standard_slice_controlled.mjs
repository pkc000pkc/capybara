/** Run a fresh sequential Standard slice containing only previously unseen scenarios. */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareFullLibrary } from './full_library_plan.mjs'
import { executeFullLibraryTask } from './full_library_task.mjs'
import { readModelConnection } from '../src/phase1_official.mjs'
import { fileDigest } from '../src/phase0_run.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const at = name => args.indexOf(name)
const limit = Number(at('--limit') >= 0 ? args[at('--limit') + 1] : 2)
assert.ok(Number.isInteger(limit) && limit > 0 && limit <= 10)

function collectReports(directory, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) collectReports(path, output)
    else if (entry.name === 'report.json') {
      try { const value = JSON.parse(readFileSync(path, 'utf8')); if (value.scenarioId) output.push(value) } catch { /* ignore malformed historical evidence */ }
    }
  }
  return output
}

const manifestResult = await prepareFullLibrary({ root })
const manifest = manifestResult.manifest
const seen = new Set(collectReports(join(root, 'runs')).map(item => item.scenarioId))
const selected = manifest.tasks.map((task, index) => ({ task, index }))
  .filter(item => item.task.phase === 'standard' && !seen.has(item.task.scenarioId)).slice(0, limit)
assert.equal(selected.length, limit, `only ${selected.length} unseen Standard scenarios available; requested ${limit}`)
const connection = readModelConnection(root, manifest.models)
const reports = []
for (const item of selected) {
  const report = await executeFullLibraryTask({ root, manifest, task: item.task, index: item.index,
    connection, signal: new AbortController().signal, windowPipelineEnabled: true })
  const eventPath = report.runtimeEvents?.path ? join(root, report.runtimeEvents.path) : null
  const events = eventPath && existsSync(eventPath)
    ? readFileSync(eventPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : []
  reports.push({ index: item.index + 1, scenarioId: item.task.scenarioId, config: item.task.config,
    phase: item.task.phase, executionId: item.task.executionId, status: report.status,
    technicalError: report.technicalError ?? null, evaluationComplete: report.evaluationComplete === true,
    rawScore: report.rawScore ?? null, scoreReliability: report.scoreReliability ?? 'unknown',
    judgeProtocolAffected: report.judgeProtocolAffected ?? null, modelInputCount: report.modelInputCount ?? 0,
    modelSdkAttempts: report.modelSdkAttempts ?? 0, temporal: report.controllerUsage,
    windowPipelineResolved: events.filter(event => event.type === 'window_pipeline_resolved'),
    windowRegistered: events.filter(event => event.type === 'window_obligation_registered'),
    temporalWatchEvents: events.filter(event => event.type === 'temporal_watch_started' || event.type === 'temporal_watch_completed'),
    windowFinishBlocks: events.filter(event => event.type === 'tool_call_blocked' && event.reason === 'window_obligation_pending'),
    dispatchSafety: report.dispatchSafety,
    reportPath: join(root, manifest.runRoot, `task-${String(item.index + 1).padStart(4, '0')}`, 'report.json') })
}
const output = join(root, manifest.runRoot, `unseen-standard-${limit}-report.json`)
writeFileSync(output, JSON.stringify({ schemaVersion: 'gaia2-unseen-standard-slice-controlled-report-v1',
  status: 'completed', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  model: manifest.models.actor.model, endpoint: connection.baseUrl,
  sourceManifest: { path: manifestResult.manifestPath, sha256: fileDigest(manifestResult.manifestPath) },
  selection: { phase: 'standard', limit, previouslySeenExcluded: true }, windowPipelineEnabled: true,
  realModelCalls: true, batchResumed: false, regraded: false, reports }, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ status: 'completed', reportPath: output, reports }, null, 2))
