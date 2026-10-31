/** Once-only diagnostic campaign. Never retries a question or changes its score. */
import assert from 'node:assert/strict'
import { appendFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicJson } from '../src/phase1_runner.mjs'
import { fileDigest } from '../src/phase0_run.mjs'
import { readModelConnection } from '../src/phase1_official.mjs'
import { readProcessIdentity } from '../src/phase1_process.mjs'
import { ROOT, portable, save } from './temporal_e2e.mjs'
import { supervisionSafety } from './temporal_official_ten.mjs'
import { prepareFullLibrary, loadFullLibraryPlan, assertFullLibraryFrozen } from './full_library_plan.mjs'
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
export async function runFullLibrary({ root = ROOT, path, signal, onProgress = () => {} } = {}, dependencies = {}) {
  root = resolve(root)
  const load = dependencies.loadPlan ?? loadFullLibraryPlan
  const frozen = dependencies.assertFrozen ?? assertFullLibraryFrozen
  const execute = dependencies.executeTask ?? executeFullLibraryTask
  const connect = dependencies.readConnection ?? readModelConnection
  const manifest = load({ root, path })
  assert.equal(manifest.mode, 'full_library_once')
  assert.deepEqual(manifest.stopPolicy, { firstScoredOutcomes: 40, stopIfAllScoresZero: true, technicalAndUnscoredExcluded: true })
  frozen(root, manifest)
  const directory = join(root, manifest.runRoot), startPath = join(directory, 'execution-start.json')
  assert.ok(!existsSync(startPath), 'campaign already started; no resume, silent rerun, or imported results')
  assert.ok(!signal?.aborted, 'campaign aborted before start')
  const connection = connect(root, manifest.models)
  const ownerIdentity = await (dependencies.readOwnerIdentity ?? readProcessIdentity)(process.pid)
  assert.ok(ownerIdentity?.verified === true, 'campaign owner process identity unavailable')
  save(startPath, { schemaVersion: 'gaia2-full-library-start-v1', startedAt: now(), ownerPid: process.pid, ownerIdentity,
    manifestHash: manifest.manifestHash, plannedExecutions: manifest.tasks.length, policy: manifest.stopPolicy })
  const reports = []
  let status = 'running', activeTask = null, fatalCode = null, frozenSourcesVerified = true
  const progressPath = join(directory, 'progress.json'), eventPath = join(directory, 'campaign-events.jsonl')
  const state = () => ({ schemaVersion: 'gaia2-full-library-progress-v1', runId: manifest.runId,
    manifestHash: manifest.manifestHash, ownerPid: process.pid, ownerIdentity, updatedAt: now(), status, fatalCode,
    plannedExecutions: manifest.tasks.length, activeTask, totals: campaignTotals(reports),
    first40: scoredWindow(reports, manifest.stopPolicy.firstScoredOutcomes),
    frozenSourcesVerified, officialSubmissionReady: false, knownJudgeDefect: manifest.knownJudgeDefect,
    noQuestionRetries: true, noCorrection: true, results: reports })
  const persist = () => { const value = state(); atomicJson(progressPath, value); onProgress(value) }
  const record = value => appendFileSync(eventPath, `${JSON.stringify({ at: now(), ...value })}\n`, { encoding: 'utf8' })
  // This heartbeat reports liveness only. Dispatch remains strictly sequential.
  const timer = setInterval(() => { try { persist() } catch { fatalCode = 'progress_store_unwritable' } }, 15000)
  timer.unref()
  try {
    persist(); record({ event: 'campaign_started', plannedExecutions: manifest.tasks.length })
    for (const [index, task] of manifest.tasks.entries()) {
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
      const summary = { executionId: task.executionId, scenarioId: task.scenarioId, config: task.config, phase: task.phase,
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
      persist()
      if (status !== 'running') break
    }
    if (status === 'running') status = signal?.aborted ? 'interrupted' : 'completed'
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
    else if (args.length === 2 && args[0] === '--run' && !args[1].startsWith('--')) {
      const report = await runFullLibrary({ root: ROOT, path: args[1], signal: controller.signal,
        onProgress: value => { if (!value.activeTask) console.log(JSON.stringify({ status: value.status, totals: value.totals, first40: value.first40 })) } })
      console.log(JSON.stringify({ status: report.status, reportPath: report.reportPath }))
      if (!['completed', 'stopped_first40_all_zero'].includes(report.status)) process.exitCode = 2
    } else throw new Error('usage: full_library_run.mjs --prepare | --run <manifest.json>; no resume')
  } catch (error) { console.error(JSON.stringify({ status: 'failed', errorType: error?.name ?? 'Error', code: error?.code ?? 'campaign_failed' })); process.exitCode = 1 }
  finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt) }
}
