/** Fresh real-model Standard/time slice with the trusted window pipeline enabled. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareFullLibrary } from './full_library_plan.mjs'
import { executeFullLibraryTask } from './full_library_task.mjs'
import { readModelConnection } from '../src/phase1_official.mjs'
import { fileDigest } from '../src/phase0_run.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const manifestResult = await prepareFullLibrary({ root })
const manifest = manifestResult.manifest
const selected = manifest.tasks
  .map((task, index) => ({ task, index }))
  .filter(item => item.task.phase === 'standard' && item.task.config === 'time')
  .slice(0, 3)
assert.equal(selected.length, 3)
const connection = readModelConnection(root, manifest.models)
const reports = []
for (const item of selected) {
  const report = await executeFullLibraryTask({
    root, manifest, task: item.task, index: item.index, connection,
    signal: new AbortController().signal, windowPipelineEnabled: true,
  })
  const eventPath = report.runtimeEvents?.path ? join(root, report.runtimeEvents.path) : null
  const events = eventPath && existsSync(eventPath)
    ? readFileSync(eventPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : []
  reports.push({
    index: item.index + 1, scenarioId: item.task.scenarioId, config: item.task.config,
    phase: item.task.phase, executionId: item.task.executionId,
    status: report.status, technicalError: report.technicalError,
    evaluationComplete: report.evaluationComplete, rawScore: report.rawScore,
    scoreReliability: report.scoreReliability, judgeProtocolAffected: report.judgeProtocolAffected,
    modelInputCount: report.modelInputCount, modelSdkAttempts: report.modelSdkAttempts,
    temporal: report.controllerUsage,
    windowPipelineResolved: events.filter(event => event.type === 'window_pipeline_resolved'),
    windowPipelineUnresolved: events.filter(event => event.type === 'window_pipeline_unresolved'),
    windowRegistered: events.filter(event => event.type === 'window_obligation_registered'),
    temporalWatchEvents: events.filter(event => event.type === 'temporal_watch_started' || event.type === 'temporal_watch_completed'),
    windowFinishBlocks: events.filter(event => event.type === 'tool_call_blocked' && event.reason === 'window_obligation_pending'),
    dispatchSafety: report.dispatchSafety,
    reportPath: join(root, manifest.runRoot, `task-${String(item.index + 1).padStart(4, '0')}`, 'report.json'),
  })
}
const output = join(root, manifest.runRoot, 'time-window-three-report.json')
writeFileSync(output, JSON.stringify({
  schemaVersion: 'gaia2-time-window-three-controlled-report-v1',
  status: 'completed', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  model: manifest.models.actor.model, endpoint: connection.baseUrl,
  sourceManifest: { path: manifestResult.manifestPath, sha256: fileDigest(manifestResult.manifestPath) },
  selection: 'first three frozen Standard/time tasks; fresh run1 attempt0 correction0',
  windowPipelineEnabled: true, realModelCalls: true, batchResumed: false, regraded: false, reports,
}, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ status: 'completed', reportPath: output, reports }, null, 2))
