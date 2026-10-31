/** Explicit single-task native runtime rerun; no independent task-contract gate. */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readJson } from '../src/phase0_run.mjs'
import { ROOT } from './temporal_e2e.mjs'
import { TARGET_ID, THIN_RUNTIME_MODE, parseConflictOfficialOneArgs, prepareConflictOfficialOne, runConflictOfficialOne, verifyConflictOfficialOne } from './conflict_recovery_official_one.mjs'

export function assertEntityWaitProfile(manifest, { historical = false } = {}) {
  const legacy = historical && manifest.mode === 'temporal_conflict_entity_wait_diagnostic'
  assert.equal(manifest.mode, legacy ? 'temporal_conflict_entity_wait_diagnostic' : THIN_RUNTIME_MODE)
  assert.deepEqual(manifest.entitySemantics, { enabled: true })
  if (legacy) assert.deepEqual(manifest.taskContract, { enabled: true })
  else assert.equal(Object.hasOwn(manifest, 'taskContract'), false)
  assert.deepEqual(manifest.mutationReceipts, { enabled: true })
  assert.equal(manifest.originalTaskCount, 1)
  assert.equal(manifest.tasks.length, 1)
  assert.equal(manifest.tasks[0].scenarioId, TARGET_ID)
  return true
}

export async function entityWaitOfficialOne({ root = ROOT, mode, path, signal } = {}) {
  if (mode === 'prepare') return prepareConflictOfficialOne({ root, runtimeSemantics: true })
  assert.ok(['run', 'verify'].includes(mode))
  assertEntityWaitProfile(readJson(resolve(root, path)), { historical: mode === 'verify' })
  return mode === 'run' ? runConflictOfficialOne({ root, path, signal }) : verifyConflictOfficialOne({ root, path })
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController()
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => controller.abort())
  try {
    const args = parseConflictOfficialOneArgs(process.argv.slice(2))
    const result = await entityWaitOfficialOne({ ...args, signal: controller.signal })
    console.log(JSON.stringify(args.mode === 'run' ? { status: result.status, scenarioId: TARGET_ID,
      tasksAttempted: result.tasksAttempted, evaluatedCount: result.evaluatedCount,
      technicalErrorCount: result.technicalErrorCount, rawScore: result.taskReport.rawScore,
      reportPath: result.reportPath, officialSubmissionReady: false } : result))
    if (args.mode === 'run' && result.status !== 'completed') process.exitCode = 2
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: error?.code === 'official_one_public_configuration_changed' ? error.code : 'entity_wait_official_one_failed',
      errorType: error?.name ?? 'Error', ...(Array.isArray(error?.configurationDifferences) ? { configurationDifferences: error.configurationDifferences } : {}) }))
    process.exitCode = 2
  }
}
