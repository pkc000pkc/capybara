/** Fresh real-model A2A slice; no resume, retry, correction or regrade. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
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
  .filter(item => item.task.phase === 'agent2agent')
  .slice(0, 3)
assert.equal(selected.length, 3)
const connection = readModelConnection(root, manifest.models)
const startedAt = new Date().toISOString()
const reports = []
for (const item of selected) {
  const report = await executeFullLibraryTask({
    root, manifest, task: item.task, index: item.index, connection,
    signal: new AbortController().signal,
  })
  reports.push({
    index: item.index + 1, scenarioId: item.task.scenarioId, config: item.task.config,
    phase: item.task.phase, executionId: item.task.executionId,
    status: report.status, technicalError: report.technicalError,
    evaluationComplete: report.evaluationComplete, rawScore: report.rawScore,
    modelInputCount: report.modelInputCount, modelSdkAttempts: report.modelSdkAttempts,
    controllerUsage: report.controllerUsage,
    a2aRuntimeEvidence: report.a2aRuntimeEvidence ?? null,
    dispatchSafety: report.dispatchSafety,
    reportPath: join(root, manifest.runRoot, `task-${String(item.index + 1).padStart(4, '0')}`, 'report.json'),
  })
}
const output = join(root, manifest.runRoot, 'a2a-three-report.json')
writeFileSync(output, JSON.stringify({
  schemaVersion: 'gaia2-a2a-three-controlled-report-v1',
  status: 'completed', startedAt, finishedAt: new Date().toISOString(),
  model: manifest.models.actor.model, endpoint: connection.baseUrl,
  sourceManifest: { path: manifestResult.manifestPath, sha256: fileDigest(manifestResult.manifestPath) },
  selection: 'first three frozen agent2agent tasks; each one fresh run1 attempt0 correction0',
  realModelCalls: true, batchResumed: false, regraded: false, reports,
}, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ status: 'completed', reportPath: output, reports }, null, 2))
