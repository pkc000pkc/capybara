/** Once-only diagnostic campaign. Never retries a question or changes its score. */
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicJson } from '../src/phase1_runner.mjs'
import { digest, fileDigest } from '../src/phase0_run.mjs'
import { readModelConnection } from '../src/phase1_official.mjs'
import { readProcessIdentity } from '../src/phase1_process.mjs'
import { ROOT, portable, save } from './temporal_e2e.mjs'
import { supervisionSafety } from './temporal_official_ten.mjs'
import { prepareFullLibrary, loadFullLibraryPlan, assertFullLibraryFrozen, fullLibraryScope, taskSlotIdentity, FULL_LIBRARY_SCOPE_POLICY } from './full_library_plan.mjs'
import { executeFullLibraryTask } from './full_library_task.mjs'
import { isReliableScore, summarizeJudgeReliability } from '../src/judge_reliability.mjs'

const now = () => new Date().toISOString()

export function scoredWindow(reports, limit = 40) {
  assert.ok(Number.isInteger(limit) && limit > 0)
  const scored = reports.filter(isReliableScore)
  const first = scored.slice(0, limit)
  const reliability = summarizeJudgeReliability(reports)
  return { target: limit, collected: first.length, evaluatedTotal: scored.length,
    zeroCount: first.filter(item => item.rawScore === 0).length,
    nonzeroCount: first.filter(item => item.rawScore > 0).length,
    complete: first.length === limit,
    shouldStop: first.length === limit && first.every(item => item.rawScore === 0),
    executionIds: first.map(item => item.executionId), reliability }
}

export function campaignTotals(reports) {
  const byPhase = Object.fromEntries(['standard', 'agent2agent', 'noise'].map(phase => {
    const own = reports.filter(item => item.phase === phase), window = scoredWindow(own), reliability = window.reliability
    return [phase, { attempted: own.length, evaluated: window.evaluatedTotal,
      officialEvaluated: own.filter(item => item.evaluationComplete === true).length,
      zero: own.filter(item => isReliableScore(item) && item.rawScore === 0).length,
      nonzero: own.filter(item => isReliableScore(item) && item.rawScore > 0).length,
      technical: own.filter(item => item.status === 'technical_error').length,
      judgeProtocolAffected: reliability.protocolAffected, judgeUnknown: reliability.unknown }]
  }))
  const window = scoredWindow(reports)
  return { attempted: reports.length, evaluated: window.evaluatedTotal,
    officialEvaluated: reports.filter(item => item.evaluationComplete === true).length,
    technical: reports.filter(item => item.status === 'technical_error').length,
    judgeReliability: window.reliability,
    uniqueOriginalQuestionsAttempted: new Set(reports.map(item => item.scenarioId)).size, byPhase }
}

/** Dependency injection is for controlled orchestration tests, never model simulation in a real run. */
function checkpointScope(manifest, taskLimit) {
  const scope = fullLibraryScope(manifest.tasks, { taskLimit })
  const tasks = manifest.tasks.slice(0, taskLimit)
  const slots = tasks.map(task => ({ executionId: task.executionId, phase: task.phase, config: task.config,
    scenarioId: task.scenarioId, sourcePath: task.sourcePath, rowIndex: task.rowIndex,
    runNumber: task.runNumber, attemptIndex: task.attemptIndex, correctionOrdinal: task.correctionOrdinal }))
  return { ...scope, uniqueScenarioCount: new Set(scope.scenarioIds).size, slots }
}

function scopeReconciliation(manifest, reports, taskLimit) {
  const expected = manifest.tasks.slice(0, taskLimit).map(task => task.executionId)
  const actual = reports.map(item => item.executionId)
  const expectedSet = new Set(expected), seen = new Set(), duplicate = [], unexpected = []
  for (const executionId of actual) {
    if (seen.has(executionId)) duplicate.push(executionId)
    seen.add(executionId)
    if (!expectedSet.has(executionId)) unexpected.push(executionId)
  }
  const actualSet = new Set(actual)
  const missing = expected.filter(executionId => !actualSet.has(executionId))
  const orderMismatch = actual.some((executionId, index) => executionId !== expected[index])
  const expectedSlots = manifest.tasks.slice(0, taskLimit).map(taskSlotIdentity)
  const actualSlots = reports.map(item => item.taskSlotId ?? null)
  const expectedSlotSet = new Set(expectedSlots), actualSlotSet = new Set(actualSlots.filter(Boolean))
  const missingSlots = expectedSlots.filter(id => !actualSlotSet.has(id))
  const unexpectedSlots = actualSlots.filter(id => id !== null && !expectedSlotSet.has(id))
  const duplicateSlots = actualSlots.filter((id, index) => id !== null && actualSlots.indexOf(id) !== index)
  return { expectedCount: expected.length, actualCount: actual.length, missing, duplicate, unexpected,
    missingSlots, duplicateSlots, unexpectedSlots,
    orderMismatch, complete: missing.length === 0 && duplicate.length === 0 && unexpected.length === 0
      && missingSlots.length === 0 && duplicateSlots.length === 0 && unexpectedSlots.length === 0 && !orderMismatch,
    completedPrefixHash: digest(expected.slice(0, actual.length)) }
}

function checkpointPrefix(manifest, reports, taskLimit) {
  const reconciliation = scopeReconciliation(manifest, reports, taskLimit)
  assert.equal(reconciliation.unexpected.length, 0, 'checkpoint contains an unexpected task')
  assert.equal(reconciliation.duplicate.length, 0, 'checkpoint contains a duplicate task')
  const prefix = manifest.tasks.slice(0, reports.length).map(task => task.executionId)
  assert.deepEqual(reports.map(item => item.executionId), prefix, 'checkpoint reports are not the manifest prefix')
  return { completedExecutionIds: prefix, completedPrefixHash: reconciliation.completedPrefixHash,
    reportRefs: reports.map(item => item.report), reconciliation }
}

async function waitForCheckpointAdvance({ directory, ordinal, manifestHash, scopeHash, signal }) {
  const continuePath = join(directory, `CHECKPOINT_CONTINUE_${String(ordinal).padStart(4, '0')}.json`)
  const stopPath = join(directory, 'STOP')
  while (true) {
    if (signal?.aborted) return 'aborted'
    if (existsSync(stopPath)) return 'stop'
    if (existsSync(continuePath)) {
      try {
        const gate = JSON.parse(readFileSync(continuePath, 'utf8'))
        assert.equal(gate.schemaVersion, 'gaia2-checkpoint-gate-v1')
        assert.equal(gate.manifestHash, manifestHash)
        assert.equal(gate.scopeHash, scopeHash)
        assert.equal(gate.ordinal, ordinal)
        assert.equal(gate.decision, 'continue')
        assert.ok(typeof gate.principal === 'string' && gate.principal.length > 0)
        assert.ok(typeof gate.createdAt === 'string' && !Number.isNaN(Date.parse(gate.createdAt)))
        try { renameSync(continuePath, continuePath.replace(/\.json$/, '.accepted.json')) }
        catch { return 'gate_io_error' }
        return { decision: gate.decision, principal: gate.principal, createdAt: gate.createdAt, acceptedAt: now() }
      } catch { /* Keep polling until a valid, bound gate or STOP appears. */ }
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

export async function runFullLibrary({ root = ROOT, path, signal, onProgress = () => {},
  maxTasks = null, checkpointEvery = 0, pauseAtCheckpoint = false } = {}, dependencies = {}) {
  root = resolve(root)
  const load = dependencies.loadPlan ?? loadFullLibraryPlan
  const frozen = dependencies.assertFrozen ?? assertFullLibraryFrozen
  const execute = dependencies.executeTask ?? executeFullLibraryTask
  const connect = dependencies.readConnection ?? readModelConnection
  const manifest = load({ root, path })
  assert.equal(manifest.mode, 'full_library_once')
  assert.deepEqual(manifest.stopPolicy, { firstScoredOutcomes: 40, stopIfAllScoresZero: true, technicalAndUnscoredExcluded: true })
  frozen(root, manifest)
  assert.ok(maxTasks === null || (Number.isInteger(maxTasks) && maxTasks > 0), 'maxTasks must be a positive integer')
  assert.ok(Number.isInteger(checkpointEvery) && checkpointEvery >= 0, 'checkpointEvery must be a non-negative integer')
  const taskLimit = Math.min(maxTasks ?? manifest.scopePolicy?.maxExecutions ?? FULL_LIBRARY_SCOPE_POLICY.maxExecutions, manifest.tasks.length)
  const scope = checkpointScope(manifest, taskLimit)
  if (manifest.scopePolicy) {
    if (checkpointEvery === 0) checkpointEvery = manifest.scopePolicy.checkpointEvery
    assert.ok(taskLimit <= manifest.scopePolicy.maxExecutions, 'requested scope exceeds frozen maximum')
    assert.ok(checkpointEvery === 0 || checkpointEvery === manifest.scopePolicy.checkpointEvery, 'checkpoint interval differs from frozen policy')
  }
  assert.ok(!pauseAtCheckpoint || checkpointEvery > 0, 'pauseAtCheckpoint requires checkpointEvery')
  const directory = join(root, manifest.runRoot), startPath = join(directory, 'execution-start.json')
  assert.ok(!existsSync(startPath), 'campaign already started; no resume, silent rerun, or imported results')
  assert.ok(!signal?.aborted, 'campaign aborted before start')
  const connection = connect(root, manifest.models)
  const ownerIdentity = await (dependencies.readOwnerIdentity ?? readProcessIdentity)(process.pid)
  assert.ok(ownerIdentity?.verified === true, 'campaign owner process identity unavailable')
  save(startPath, { schemaVersion: 'gaia2-full-library-start-v1', startedAt: now(), ownerPid: process.pid, ownerIdentity,
    manifestHash: manifest.manifestHash, plannedExecutions: manifest.tasks.length, requestedTaskLimit: taskLimit, scope, policy: manifest.stopPolicy })
  const reports = []
  let status = 'running', activeTask = null, fatalCode = null, frozenSourcesVerified = true
  let progressStoreFailures = 0, progressStoreLastError = null
  const progressPath = join(directory, 'progress.json'), eventPath = join(directory, 'campaign-events.jsonl')
  let checkpointState = null
  const state = () => ({ schemaVersion: 'gaia2-full-library-progress-v1', runId: manifest.runId,
    manifestHash: manifest.manifestHash, ownerPid: process.pid, ownerIdentity, updatedAt: now(), status, fatalCode,
    plannedExecutions: manifest.tasks.length, requestedTaskLimit: taskLimit, scope, activeTask, checkpoint: checkpointState,
    reconciliation: scopeReconciliation(manifest, reports, taskLimit),
    progressStore: { consecutiveFailures: progressStoreFailures, lastError: progressStoreLastError },
    totals: campaignTotals(reports),
    first40: scoredWindow(reports, manifest.stopPolicy.firstScoredOutcomes),
    frozenSourcesVerified, officialSubmissionReady: false, knownJudgeDefect: manifest.knownJudgeDefect,
    noQuestionRetries: true, noCorrection: true, results: reports })
  const persist = () => {
    const value = state()
    atomicJson(progressPath, value)
    progressStoreFailures = 0
    onProgress(value)
  }
  const record = value => appendFileSync(eventPath, `${JSON.stringify({ at: now(), ...value })}\n`, { encoding: 'utf8' })
  // This heartbeat reports liveness only. Dispatch remains strictly sequential.
  const timer = setInterval(() => {
    try { persist() } catch (error) {
      progressStoreFailures += 1
      progressStoreLastError = { code: error?.code ?? 'unknown', message: String(error?.message ?? error).slice(0, 240), path: portable(progressPath), at: now() }
      // A single Windows rename collision is transient; stop only after the
      // bounded atomic-rename retries and three consecutive timer failures.
      if (progressStoreFailures >= 3) fatalCode = 'progress_store_unwritable'
    }
  }, 15000)
  timer.unref()
  try {
    persist(); record({ event: 'campaign_started', plannedExecutions: manifest.tasks.length })
    for (const [index, task] of manifest.tasks.slice(0, taskLimit).entries()) {
      if (signal?.aborted) { status = 'interrupted'; break }
      if (existsSync(join(directory, 'STOP'))) { status = 'stopped_by_request'; break }
      if (fatalCode) { status = 'stopped_for_safety'; break }
      if (scoredWindow(reports).shouldStop) { status = 'stopped_first40_all_zero'; break }
      try { frozen(root, manifest) } catch { frozenSourcesVerified = false; fatalCode = 'frozen_sources_changed'; status = 'stopped_for_safety'; break }
      activeTask = { index: index + 1, executionId: task.executionId, scenarioId: task.scenarioId,
        config: task.config, phase: task.phase, startedAt: now() }
      persist(); record({ event: 'question_started', ...activeTask })
      const started = Date.now(), taskDirectory = join(directory, `task-${String(index + 1).padStart(4, '0')}`)
      let result
      try { result = await execute({ root, manifest, task, index, connection, signal }) }
      catch (error) {
        const output = join(taskDirectory, 'output')
        const dispatchSafety = { actor: supervisionSafety(output), host: supervisionSafety(join(output, 'hook-host')) }
        result = { status: 'technical_error', technicalError: 'task_setup_or_verification_failed',
          errorType: error?.name ?? 'Error', evaluationComplete: false, rawScore: null, dispatchSafety,
          fatalSupervision: !dispatchSafety.actor.safeToDispatchNext || !dispatchSafety.host.safeToDispatchNext }
        save(join(taskDirectory, 'runner-failure.json'), result)
      }
      const reportPath = join(taskDirectory, existsSync(join(taskDirectory, 'report.json')) ? 'report.json' : 'runner-failure.json')
      // A technical error can retain a native score diagnostically, but cannot enter the forty-score window.
      const summary = { executionId: task.executionId, taskSlotId: taskSlotIdentity(task), scenarioId: task.scenarioId, config: task.config, phase: task.phase,
        status: result.status, technicalError: result.technicalError ?? null, evaluationComplete: result.evaluationComplete === true,
        rawScore: result.rawScore ?? null, scoreReliability: result.scoreReliability ?? 'unknown',
        judgeProtocolAffected: result.judgeProtocolAffected ?? null,
        judgeReliability: result.judgeReliability ?? null,
        elapsedMs: Date.now() - started, finishedAt: now(),
        modelInputCount: result.modelInputCount ?? 0, modelSdkAttempts: result.modelSdkAttempts ?? 0,
        fatalSupervision: result.fatalSupervision === true,
        report: { path: portable(reportPath), sha256: existsSync(reportPath) ? fileDigest(reportPath) : null } }
      reports.push(summary); activeTask = null
      record({ event: 'question_finished', ...summary })
      if (result.fatalSupervision) { fatalCode = 'child_not_proven_closed'; status = 'stopped_for_safety' }
      else if (scoredWindow(reports).shouldStop) status = 'stopped_first40_all_zero'
      if (checkpointEvery > 0 && (reports.length % checkpointEvery === 0 || reports.length === taskLimit)) {
        const ordinal = reports.length
        const prefix = checkpointPrefix(manifest, reports, taskLimit)
        checkpointState = { schemaVersion: 'gaia2-full-library-checkpoint-v1', ordinal, completed: reports.length,
          requestedTaskLimit: taskLimit, scope, totals: campaignTotals(reports), first40: scoredWindow(reports, manifest.stopPolicy.firstScoredOutcomes),
          ...prefix, lastExecutionId: reports.at(-1)?.executionId ?? null, lastScenarioId: reports.at(-1)?.scenarioId ?? null, createdAt: now() }
        save(join(directory, `checkpoint-${String(ordinal).padStart(4, '0')}.json`), checkpointState)
        record({ event: 'checkpoint_reached', ordinal, completed: reports.length, taskListHash: scope.taskListHash })
        if (status === 'running' && pauseAtCheckpoint && reports.length < taskLimit) {
          status = 'checkpoint_waiting'; persist()
          const gate = await waitForCheckpointAdvance({ directory, ordinal, manifestHash: manifest.manifestHash, scopeHash: scope.taskListHash, signal })
          if (gate !== 'continue' && gate?.decision !== 'continue') { status = gate === 'stop' ? 'stopped_by_request' : 'stopped_for_safety' }
          checkpointState = { ...checkpointState, gate, resumedAt: now() }
          if (status === 'checkpoint_waiting') status = 'running'
        }
      }
      persist()
      if (status !== 'running') break
    }
    if (status === 'running') status = signal?.aborted ? 'interrupted' : (taskLimit < manifest.tasks.length ? 'completed_scope' : 'completed')
    try { frozen(root, manifest) } catch { frozenSourcesVerified = false; fatalCode ??= 'frozen_sources_changed'; status = 'stopped_for_safety' }
    persist()
    const final = { ...state(), finishedAt: now() }
    save(join(directory, 'report.json'), final)
    record({ event: 'campaign_finished', status, totals: final.totals, first40: final.first40 })
    return { ...final, reportPath: portable(join(directory, 'report.json')) }
  } catch (error) {
    status = 'fatal'; fatalCode ??= 'campaign_io_or_validation_failed'
    try { persist(); record({ event: 'campaign_fatal', code: fatalCode }) } catch { /* Never dispatch with a broken evidence store. */ }
    throw Object.assign(new Error(fatalCode), { code: fatalCode })
  } finally { clearInterval(timer) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), controller = new AbortController()
  const interrupt = () => controller.abort()
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
  try {
    if (args.length === 1 && args[0] === '--prepare') {
      const { manifest, ...prepared } = await prepareFullLibrary({ root: ROOT })
      console.log(JSON.stringify(prepared))
    }
    else if (args.length >= 2 && args[0] === '--run' && !args[1].startsWith('--')) {
      const value = flag => { const index = args.indexOf(flag); return index === -1 ? null : args[index + 1] }
      const maxTasksValue = value('--max-tasks'), checkpointValue = value('--checkpoint-every')
      const maxTasks = maxTasksValue === null ? null : Number(maxTasksValue)
      const checkpointEvery = checkpointValue === null ? 0 : Number(checkpointValue)
      if (maxTasksValue !== null && (!Number.isInteger(maxTasks) || maxTasks < 1)) throw new Error('--max-tasks must be a positive integer')
      if (checkpointValue !== null && (!Number.isInteger(checkpointEvery) || checkpointEvery < 1)) throw new Error('--checkpoint-every must be a positive integer')
      const pauseAtCheckpoint = args.includes('--pause-at-checkpoint')
      const report = await runFullLibrary({ root: ROOT, path: args[1], signal: controller.signal,
        maxTasks, checkpointEvery, pauseAtCheckpoint,
        onProgress: value => { if (!value.activeTask || value.status === 'checkpoint_waiting') {
          const scope = value.scope ? { taskLimit: value.scope.taskLimit, taskListHash: value.scope.taskListHash,
            uniqueScenarioCount: value.scope.uniqueScenarioCount, firstExecutionId: value.scope.executionIds?.[0],
            lastExecutionId: value.scope.executionIds?.at(-1) } : null
          console.log(JSON.stringify({ status: value.status, totals: value.totals, first40: value.first40,
            checkpoint: value.checkpoint, scope, reconciliation: value.reconciliation }))
        } } })
      console.log(JSON.stringify({ status: report.status, reportPath: report.reportPath }))
      if (!['completed', 'completed_scope', 'stopped_first40_all_zero'].includes(report.status)) process.exitCode = 2
    } else throw new Error('usage: full_library_run.mjs --prepare | --run <manifest.json> [--max-tasks N] [--checkpoint-every N] [--pause-at-checkpoint]; no resume')
  } catch (error) { console.error(JSON.stringify({ status: 'failed', errorType: error?.name ?? 'Error', code: error?.code ?? 'campaign_failed' })); process.exitCode = 1 }
  finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt) }
}
