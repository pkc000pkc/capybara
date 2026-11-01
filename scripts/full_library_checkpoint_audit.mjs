/**
 * Checkpoint-level audit for the once-only GAIA2 campaign.
 *
 * This deliberately audits observable execution evidence, not hidden model
 * chain-of-thought or official answers.  It summarizes tool-choice structure,
 * controller transitions, evidence delivery and termination safety so a
 * 40-task checkpoint can be reviewed without copying task contents into a
 * new artifact.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { digest } from '../src/phase0_run.mjs'
import { FULL_LIBRARY_SCOPE_POLICY, fullLibraryScope, taskSlotIdentity } from './full_library_plan.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const lines = path => existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : []
const taskNumber = name => Number(name.match(/^task-(\d{4})$/)?.[1] ?? NaN)
const modelOutputFiles = dir => readdirSync(dir, { withFileTypes: true })
  .filter(item => item.isFile() && /^model-\d{6}-output\.json$/.test(item.name))
  .map(item => join(dir, item.name)).sort()

function stableToolName(name) {
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,120}(?:__[A-Za-z][A-Za-z0-9_.:-]{0,120})?$/.test(name) ? name : null
}

const sameArray = (left, right) => Array.isArray(left) && Array.isArray(right)
  && left.length === right.length && left.every((value, index) => value === right[index])

function toolPairing(events) {
  const started = new Set(events.filter(event => event.type === 'tool_call_started' && typeof event.callId === 'string').map(event => event.callId))
  const terminal = new Set(events.filter(event => ['tool_call_completed', 'tool_call_blocked', 'tool_call_cancelled'].includes(event.type)
    && typeof event.callId === 'string').map(event => event.callId))
  return { started: started.size, terminal: terminal.size, unpaired: [...started].filter(id => !terminal.has(id)).length }
}

function temporalLifecycle(events) {
  const starts = events.filter(event => event.type === 'temporal_watch_started')
  const completed = events.filter(event => event.type === 'temporal_watch_completed')
  const signals = completed.map(event => event.signal?.kind).filter(Boolean)
  const lastRunning = events.findLast(event => event.type === 'temporal_state_committed' && event.status === 'running')
  const lastCompleted = events.findLast(event => event.type === 'temporal_watch_completed')
  return { watchStarted: starts.length, watchCompleted: completed.length,
    // The controller assigns its watchId on completion, while the start
    // receipt is keyed by the model callId.  Pair by lifecycle counts rather
    // than incorrectly treating those two identifiers as the same key.
    uncompletedWatches: Math.max(0, starts.length - completed.length),
    signals, scanBudgetSignals: signals.filter(value => value === 'scan_budget').length,
    deadlineSignals: signals.filter(value => ['deadline_reached', 'window_closed'].includes(value)).length,
    activeAtAttemptEnd: Boolean(lastRunning && (!lastCompleted || (lastRunning.time ?? 0) > (lastCompleted.time ?? 0))),
    // A completed watch naturally has earlier ``running`` commits.  Only a
    // running commit after the final completion means the attempt ended with
    // an open watch; historical running states are not an audit failure.
    lifecycleObservable: starts.length === 0 || (starts.length === completed.length
      && !((lastRunning && (!lastCompleted || (lastRunning.time ?? 0) > (lastCompleted.time ?? 0))))), }
}

function a2aLifecycle(events) {
  const started = events.filter(event => event.type === 'delegation_started')
  const completed = events.filter(event => event.type === 'delegation_completed')
  const failed = events.filter(event => event.type === 'delegation_failed')
  const snapshots = events.filter(event => event.type === 'a2a_child_runtime_snapshot')
  const consumed = events.filter(event => ['parent_result_consumed', 'a2a_parent_result_consumed', 'child_result_consumed'].includes(event.type))
  const convergenceChecks = events.filter(event => event.type === 'a2a_parent_convergence_checked')
  const terminalDrainRequested = events.filter(event => event.type === 'a2a_terminal_drain_requested')
  const terminalDrainCompleted = events.filter(event => event.type === 'a2a_terminal_drain_completed')
  const terminalDrainBlocked = events.filter(event => event.type === 'a2a_terminal_drain_blocked')
  const converged = events.filter(event => ['parent_converged', 'a2a_parent_converged'].includes(event.type)
    || (event.type === 'a2a_parent_convergence_checked' && event.converged === true))
  const lifecycleBound = started.length === 0 || (started.length === completed.length + failed.length
    && (completed.length === 0 || convergenceChecks.length > 0))
  return { started: started.length, completed: completed.length, failed: failed.length, snapshots: snapshots.length,
    parentResultConsumed: consumed.length, parentConvergenceChecks: convergenceChecks.length, parentConverged: converged.length,
    terminalDrainRequested: terminalDrainRequested.length,
    terminalDrainCompleted: terminalDrainCompleted.length,
    terminalDrainBlocked: terminalDrainBlocked.length,
    lifecycleObservable: lifecycleBound,
    // Convergence is a separate business/runtime state.  A STOP boundary can
    // legitimately leave a published child result pending; that state must be
    // visible and preserved, not mislabeled as missing A2A telemetry.
    convergenceSatisfied: started.length === 0 || converged.length > 0, }
}

function noiseLifecycle(events) {
  const relevant = events.filter(event => ['noise_progress_updated', 'noise_repeated_query', 'noise_event_classified', 'noise_filtered', 'noise_fact_committed'].includes(event.type))
  return { events: relevant.length,
    classified: relevant.filter(event => ['noise_event_classified', 'noise_filtered'].includes(event.type)).length,
    progress: relevant.filter(event => ['noise_progress_updated', 'noise_fact_committed'].includes(event.type)).length,
    repeatedQueries: relevant.filter(event => event.type === 'noise_repeated_query').length,
    controllerObservable: relevant.length > 0, }
}

function compactionLifecycle(events) {
  const compacted = events.filter(event => event.type === 'model_context_compacted')
  const facts = events.filter(event => event.type === 'execution_facts_injected')
  const restoredAfterCompaction = compacted.every(item => facts.some(fact => (fact.time ?? 0) >= (item.time ?? 0)
    || (fact.turn ?? -1) >= (item.turn ?? -1)))
  return { compactions: compacted.length, factsInjected: facts.length, restoredAfterCompaction }
}

export function auditTask({ taskDir, report = null } = {}) {
  assert.ok(typeof taskDir === 'string' && taskDir.length > 0)
  const output = join(taskDir, 'output')
  const evidence = join(output, 'model-evidence')
  const taskReport = report ?? (existsSync(join(taskDir, 'report.json')) ? json(join(taskDir, 'report.json')) : null)
  const events = lines(join(output, 'runtime-events.jsonl'))
  const outputs = existsSync(evidence) ? modelOutputFiles(evidence).map(json) : []
  const toolCalls = outputs.flatMap(item => (Array.isArray(item.toolCalls) ? item.toolCalls : [])
    .map(call => stableToolName(call.name)).filter(Boolean))
  const typeCounts = events.reduce((acc, event) => {
    const type = typeof event.type === 'string' ? event.type : 'unknown'
    acc[type] = (acc[type] || 0) + 1
    return acc
  }, {})
  const blockedReasons = [...new Set(events.filter(event => event.type === 'tool_call_blocked')
    .map(event => event.reason).filter(value => typeof value === 'string'))].sort()
  const finishReasons = [...new Set(events.filter(event => event.type === 'finish_gate_loop_stopped')
    .map(event => event.reason).filter(value => typeof value === 'string'))].sort()
  const latestInput = outputs.length ? outputs.at(-1) : null
  const inputPaths = existsSync(evidence) ? readdirSync(evidence).filter(name => /^model-\d{6}-input\.json$/.test(name)) : []
  const pairing = toolPairing(events)
  const temporal = temporalLifecycle(events)
  const a2a = a2aLifecycle(events)
  const noise = noiseLifecycle(events)
  const compaction = compactionLifecycle(events)
  const visibleDesignSignals = {
    modelRequests: outputs.length,
    toolCallOutputs: toolCalls.length,
    distinctTools: [...new Set(toolCalls)].sort(),
    hasReconciliation: toolCalls.includes('capybara_task_reconcile'),
    hasAuthoritativeReads: toolCalls.some(name => !name.startsWith('capybara_') && /(?:get|list|search|read|current|details|contacts|emails|apartments|calendar)/i.test(name)),
    hasWaitController: toolCalls.includes('capybara_wait_watch') || typeCounts.temporal_watch_started > 0,
    hasA2A: typeCounts.delegation_started > 0 || typeCounts.a2a_child_started > 0,
    hasNoiseController: typeCounts.noise_progress_updated > 0 || typeCounts.noise_repeated_query > 0,
    hasExecutionFacts: typeCounts.execution_facts_injected > 0,
    hasContextCompaction: typeCounts.model_context_compacted > 0,
    toolCallPairing: pairing,
    temporalLifecycle: temporal,
    a2aLifecycle: a2a,
    noiseLifecycle: noise,
    compactionLifecycle: compaction,
    latestModelHasContent: typeof latestInput?.content === 'string' && latestInput.content.trim().length > 0,
  }
  const unknownWrites = events.filter(event => event.type === 'tool_call_completed'
    && ['unknown', 'not_executed'].includes(event.status)
    && ['write', 'finish', 'unknown'].includes(event.effect)).length
  const terminal = events.findLast(event => event.type === 'attempt_execution_ended') ?? null
  const safeFinishBoundary = terminal?.terminationReason === 'finish_gate_loop'
    && finishReasons.length > 0
  const reasoningConformance = {
    noFinishLoop: finishReasons.length === 0,
    unknownWritesRemainObservable: unknownWrites === 0 || typeCounts.tool_call_blocked > 0 || typeCounts.execution_facts_injected > 0,
    // A bounded repeated finish refusal is an incomplete business boundary,
    // not infrastructure failure. Keep noFinishLoop false as a quality
    // signal, while classifying the termination itself as non-technical.
    noTechnicalError: taskReport?.status !== 'technical_error' && !['technical_failure', 'live_hook_failure'].includes(terminal?.terminationReason),
    boundedEvidence: inputPaths.length >= outputs.length,
    modelRequestsRecorded: outputs.length === Number(taskReport?.modelInputCount ?? outputs.length),
    toolCallsPaired: pairing.unpaired === 0,
    temporalLifecycleObservable: temporal.lifecycleObservable,
    a2aLifecycleObservable: a2a.lifecycleObservable,
    a2aConvergenceSatisfied: a2a.convergenceSatisfied,
    noiseControllerObservable: !taskReport?.phase || taskReport.phase !== 'noise' || noise.controllerObservable,
    compactionFactsRestored: compaction.restoredAfterCompaction,
  }
  return {
    schemaVersion: 'gaia2-checkpoint-task-audit-v1',
    taskId: taskDir.split(/[\\/]/).at(-1),
    executionId: taskReport?.executionId ?? null,
    scenarioId: taskReport?.scenarioId ?? null,
    phase: taskReport?.phase ?? null,
    config: taskReport?.config ?? null,
    status: taskReport?.status ?? null,
    rawScore: taskReport?.rawScore ?? null,
    taskSlotId: taskReport?.taskSlotId ?? null,
    technicalError: taskReport?.technicalError ?? null,
    terminationReason: terminal?.terminationReason ?? null,
    safeFinishBoundary,
    usage: terminal?.usage ?? null,
    eventCounts: typeCounts,
    blockedReasons,
    finishGateReasons: finishReasons,
    unknownWrites,
    designSignals: visibleDesignSignals,
    reasoningConformance,
  }
}

export function auditCheckpoint({ runDir, start = 1, end = 40, write = null } = {}) {
  assert.ok(typeof runDir === 'string' && runDir.length > 0)
  assert.ok(Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start)
  const progressPath = join(runDir, 'progress.json')
  const progress = existsSync(progressPath) ? json(progressPath) : null
  const manifestPath = join(runDir, 'manifest.json')
  const manifest = existsSync(manifestPath) ? json(manifestPath) : null
  const tasks = []
  for (let ordinal = start; ordinal <= end; ordinal += 1) {
    const taskDir = join(runDir, `task-${String(ordinal).padStart(4, '0')}`)
    if (existsSync(taskDir)) tasks.push(auditTask({ taskDir }))
  }
  const progressRows = new Map((progress?.results ?? []).map(row => [row.executionId, row]))
  for (const task of tasks) {
    // task/report.json is the official task result; taskSlotId is also
    // persisted in the campaign progress summary.  Bind both views before
    // comparing the manifest prefix.
    task.taskSlotId ??= progressRows.get(task.executionId)?.taskSlotId ?? null
  }
  const conformance = tasks.reduce((acc, task) => {
    for (const key of Object.keys(acc)) acc[key] += task.reasoningConformance[key] === true ? 1 : 0
    return acc
  }, { noFinishLoop: 0, unknownWritesRemainObservable: 0, noTechnicalError: 0, boundedEvidence: 0, modelRequestsRecorded: 0,
    toolCallsPaired: 0, temporalLifecycleObservable: 0, a2aLifecycleObservable: 0, noiseControllerObservable: 0, compactionFactsRestored: 0 })
  let scope = null
  let scopeError = null
  try {
    if (!manifest) throw new Error('manifest_missing')
    scope = fullLibraryScope(manifest.tasks, {
      taskLimit: progress?.requestedTaskLimit ?? manifest.scopePolicy?.maxExecutions ?? FULL_LIBRARY_SCOPE_POLICY.maxExecutions,
    })
  } catch (error) {
    scopeError = error?.message ?? String(error)
  }
  const expectedTasks = manifest?.tasks?.slice(start - 1, end) ?? []
  const expectedExecutionIds = expectedTasks.map(task => task.executionId)
  const expectedSlotIds = expectedTasks.map(taskSlotIdentity)
  const actualExecutionIds = tasks.map(task => task.executionId)
  const actualSlotIds = tasks.map(task => task.taskSlotId)
  const checkpointPath = join(runDir, `checkpoint-${String(end).padStart(4, '0')}.json`)
  const checkpoint = existsSync(checkpointPath) ? json(checkpointPath) : null
  const manifestReconciliation = {
    schemaVersion: 'gaia2-checkpoint-manifest-reconciliation-v1',
    manifestPresent: Boolean(manifest),
    manifestHashMatchesProgress: Boolean(manifest && progress && manifest.manifestHash === progress.manifestHash),
    scopeDerivationValid: scopeError === null,
    scopeError,
    scopePolicyMatches: JSON.stringify(manifest?.scopePolicy ?? null) === JSON.stringify(FULL_LIBRARY_SCOPE_POLICY),
    expectedCount: expectedExecutionIds.length,
    actualCount: actualExecutionIds.length,
    executionIdsMatchManifestPrefix: sameArray(actualExecutionIds, expectedExecutionIds.slice(0, actualExecutionIds.length)),
    slotIdsMatchManifestPrefix: sameArray(actualSlotIds, expectedSlotIds.slice(0, actualSlotIds.length)),
    checkpointPresent: Boolean(checkpoint),
    checkpointScopeHashMatchesProgress: Boolean(checkpoint && progress && checkpoint.scope?.taskListHash === progress.scope?.taskListHash),
    checkpointCompletedIdsMatchAudit: Boolean(checkpoint && sameArray(checkpoint.completedExecutionIds, actualExecutionIds)),
    checkpointCompletedPrefixHashMatches: Boolean(checkpoint && checkpoint.completedPrefixHash === digest(actualExecutionIds)),
    taskListHash: progress?.scope?.taskListHash ?? null,
  }
  manifestReconciliation.valid = manifestReconciliation.manifestPresent
    && manifestReconciliation.manifestHashMatchesProgress
    && manifestReconciliation.scopeDerivationValid
    && manifestReconciliation.scopePolicyMatches
    && manifestReconciliation.executionIdsMatchManifestPrefix
    && manifestReconciliation.slotIdsMatchManifestPrefix
    && (!progress || progress.status !== 'checkpoint_waiting' || (
      manifestReconciliation.checkpointPresent
      && manifestReconciliation.checkpointScopeHashMatchesProgress
      && manifestReconciliation.checkpointCompletedIdsMatchAudit
      && manifestReconciliation.checkpointCompletedPrefixHashMatches
    ))
  const report = {
    schemaVersion: 'gaia2-checkpoint-audit-v1',
    runId: progress?.runId ?? runDir.split(/[\\/]/).at(-1),
    manifestHash: progress?.manifestHash ?? null,
    scopeHash: progress?.scope?.taskListHash ?? null,
    checkpoint: { start, end, collected: tasks.length, complete: tasks.length === end - start + 1 },
    source: { progressPath, manifestPath, status: progress?.status ?? null },
    manifestReconciliation,
    tasks,
    aggregate: {
      technical: tasks.filter(task => task.status === 'technical_error' || task.technicalError).length,
      evaluated: tasks.filter(task => task.status === 'evaluated').length,
      scores: { pass: tasks.filter(task => task.rawScore === 1).length, fail: tasks.filter(task => task.rawScore === 0).length },
      finishGateLoops: tasks.filter(task => task.finishGateReasons.length > 0).length,
      unknownWrites: tasks.reduce((sum, task) => sum + task.unknownWrites, 0),
      reasoningConformance: conformance,
    },
    policy: {
      rawModelReasoningCopied: false,
      oracleOrHiddenAnswerRead: false,
      auditBasis: 'observable tool/event/evidence metadata only',
    },
  }
  if (write) writeFileSync(resolve(write), JSON.stringify(report, null, 2) + '\n', 'utf8')
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const value = flag => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1] }
  const runDir = value('--run')
  if (!runDir) throw new Error('usage: full_library_checkpoint_audit.mjs --run <runDir> [--start N] [--end N] [--write path]')
  const report = auditCheckpoint({ runDir: resolve(runDir), start: Number(value('--start') ?? 1), end: Number(value('--end') ?? 40), write: value('--write') })
  console.log(JSON.stringify({ schemaVersion: report.schemaVersion, runId: report.runId, checkpoint: report.checkpoint, aggregate: report.aggregate, reportPath: value('--write') ? resolve(value('--write')) : null }))
}
