import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { assertPublicConfig, digest, fileDigest, readJson, within } from './phase0_run.mjs'
import { classifyExecutionFailure } from './phase1_errors.mjs'
import { safeEvidenceGateCode } from './phase1_diagnostics.mjs'
import { isProcessIdentityAlive, readProcessIdentity } from './phase1_process.mjs'
import { runtimeEvidenceRequired, validateRuntimeEvidence } from './phase3_runtime_evidence.mjs'

const TRANSIENT_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM'])

function sleepSync(milliseconds) {
  if (!(milliseconds > 0)) return
  const signal = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(signal, 0, 0, milliseconds)
}

export function renameWithRetry(source, target, { atomicRename = renameSync, attempts = 5, delayMs = 25, platform = process.platform } = {}) {
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      atomicRename(source, target)
      return { attempts: attempt }
    } catch (error) {
      lastError = error
      const transient = platform === 'win32' && TRANSIENT_RENAME_CODES.has(error?.code)
      if (!transient || attempt === attempts) throw error
      sleepSync(delayMs * attempt)
    }
  }
  throw lastError ?? new Error('atomic rename failed')
}

export function atomicJson(path, value, { atomicRename = renameSync, renameAttempts = 5, renameDelayMs = 25, platform = process.platform } = {}) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd) }
  finally { closeSync(fd) }
  let renamed = false
  try {
    renameWithRetry(temporary, path, { atomicRename, attempts: renameAttempts, delayMs: renameDelayMs, platform })
    renamed = true
  } finally {
    if (!renamed && existsSync(temporary)) {
      try { unlinkSync(temporary) } catch { /* preserve the original rename error */ }
    }
  }
}

function assert(condition, message) { if (!condition) throw new Error(`Phase 1: ${message}`) }
function portable(path) { return path.replaceAll('\\', '/') }
function safePath(root, path, parent = root) {
  assert(typeof path === 'string' && !isAbsolute(path), 'execution paths must be relative')
  const target = resolve(root, path)
  assert(within(parent, target) && target !== resolve(parent), 'execution path escapes its run directory')
  let current = target
  while (within(root, current)) {
    if (existsSync(current)) assert(!lstatSync(current).isSymbolicLink(), 'execution path contains a symbolic link')
    if (current === resolve(root)) break
    current = dirname(current)
  }
  return target
}

export function assertSupportedPlan(manifest) {
  const { manifestHash, ...contents } = manifest
  assert(manifestHash === digest(contents), 'manifest content hash differs')
  const phasesSupported = manifest.mode === 'official_submission'
    ? manifest.tasks?.length && manifest.tasks.every(task => ['standard', 'agent2agent', 'noise'].includes(task.phase))
    : manifest.tasks?.length && manifest.tasks.every(task => task.phase === 'standard')
  assert(phasesSupported, manifest.mode === 'official_submission' ? 'unsupported official task phase' : 'A2A/Noise execution requires the official submission profile; internal batches remain standard-only')
  assert(manifest.policy.maxCorrections === 0, 'initial batches cannot run corrections; use a separate phase 4 fresh replay plan')
  assert(new Set(manifest.tasks.map(task => task.executionId)).size === manifest.tasks.length, 'duplicate execution identity')
}

export function selectFrozenTaskIds(manifest, { onlyRunNumber = null, onlyPhase = null, onlyExecutionId = null } = {}) {
  assert(onlyRunNumber === null || Number.isInteger(onlyRunNumber) && onlyRunNumber >= 1 && onlyRunNumber <= 5 && manifest.tasks.some(task => task.runNumber === onlyRunNumber), 'onlyRunNumber must be a planned integer run number in 1..5')
  assert(onlyPhase === null || ['standard', 'agent2agent', 'noise'].includes(onlyPhase), 'onlyPhase must be standard, agent2agent, or noise')
  if (onlyExecutionId !== null) {
    assert(typeof onlyExecutionId === 'string' && onlyExecutionId.length > 0 && onlyExecutionId.trim() === onlyExecutionId, 'onlyExecutionId must be a non-empty exact planned execution identity')
    const matches = manifest.tasks.filter(task => task.executionId === onlyExecutionId)
    assert(matches.length === 1, 'onlyExecutionId must identify exactly one planned task')
    assert((onlyRunNumber === null || matches[0].runNumber === onlyRunNumber) && (onlyPhase === null || matches[0].phase === onlyPhase), 'onlyExecutionId conflicts with onlyPhase or onlyRunNumber')
  }
  const selectedTaskIds = new Set(manifest.tasks.filter(task => (onlyRunNumber === null || task.runNumber === onlyRunNumber) && (onlyPhase === null || task.phase === onlyPhase) && (onlyExecutionId === null || task.executionId === onlyExecutionId)).map(task => task.executionId))
  assert(selectedTaskIds.size > 0, 'selection does not match any planned task')
  return selectedTaskIds
}

async function acquireOwner(runRoot) {
  const path = join(runRoot, 'run-owner.json')
  const owner = { ownerId: randomUUID(), processIdentity: await readProcessIdentity(process.pid), startedAt: new Date().toISOString() }
  const claim = () => { const fd = openSync(path, 'wx', 0o600); try { writeFileSync(fd, JSON.stringify(owner)); fsyncSync(fd) } finally { closeSync(fd) } }
  try { claim() } catch (error) {
    if (error.code !== 'EEXIST') throw error
    assert(!await isProcessIdentityAlive(readJson(path).processIdentity), 'another live process owns this run')
    const takeover = join(runRoot, '.owner-takeover')
    // A takeover election prevents two recovery processes from renaming a new owner's lease.
    mkdirSync(takeover)
    try {
      assert(!await isProcessIdentityAlive(readJson(path).processIdentity), 'run ownership changed during recovery')
      renameSync(path, join(runRoot, `abandoned-owner-${randomUUID()}.json`))
      claim()
    } finally { rmdirSync(takeover) }
  }
  return () => { if (existsSync(path) && readJson(path).ownerId === owner.ownerId) unlinkSync(path) }
}

function initialState(manifest, runtimeHash) {
  return { schemaVersion: 'gaia2-run-state-v1', runId: manifest.runId, manifestHash: manifest.manifestHash, runtimeHash, updatedAt: new Date().toISOString(), tasks: manifest.tasks.map(task => ({ executionId: task.executionId, status: 'pending', sessions: [], resultPath: null, resultSha256: null, failure: null })) }
}

function validateStatePaths(root, manifest, state) {
  const runRoot = resolve(root, manifest.runRoot)
  state.tasks.forEach((record, index) => {
    const task = manifest.tasks[index]
    assert(Array.isArray(record.sessions), 'invalid session list')
    assert(record.status !== 'pending' || record.sessions.length === 0, 'pending task has used sessions')
    assert(record.status === 'pending' || record.sessions.length > 0, 'used task has no session')
    const seen = new Set()
    record.sessions.forEach((session, ordinal) => {
      assert(typeof session.sessionId === 'string' && /^\d{4}-[0-9a-f-]{12}$/.test(session.sessionId) && !seen.has(session.sessionId), 'invalid or duplicate session identity')
      seen.add(session.sessionId)
      assert(session.sessionOrdinal === ordinal + 1 && session.parentSessionId === (record.sessions[ordinal - 1]?.sessionId ?? null), 'session lineage changed')
      for (const key of ['outputDir', 'fixtureDir', 'workspaceDir']) {
        assert(portable(session[key]) === portable(join(task[key], 'sessions', session.sessionId)), 'session paths differ from frozen task')
        safePath(root, session[key], runRoot)
      }
    })
    if (record.resultPath) assert(portable(record.resultPath) === portable(join(record.sessions.at(-1).workspaceDir, 'task-result.json')), 'result path differs from current session')
  })
}

function validateResult(root, manifest, task, session, record, runtimeHash) {
  const path = safePath(root, record.resultPath, resolve(root, manifest.runRoot))
  assert(fileDigest(path) === record.resultSha256, 'completed result content changed')
  const result = readJson(path)
  assert(result.manifestHash === manifest.manifestHash && result.runtimeHash === runtimeHash && result.runId === manifest.runId && result.executionId === task.executionId && result.sessionId === session.sessionId, 'result belongs to another execution')
  assert(result.scenarioId === task.scenarioId && result.runNumber === task.runNumber && result.phase === task.phase && result.config === task.config, 'result task metadata differs')
  assert(result.evaluationComplete === true && typeof result.businessPassed === 'boolean', 'completed task has no valid judgment')
  assert(result.businessPassed ? result.failure === null : result.failure?.category === 'business_failure' && result.failure.retryable === false, 'technical failure cannot count as completed')
  assert(Array.isArray(result.artifacts), 'result artifact list is invalid')
  for (const file of result.artifacts ?? []) {
    assert(typeof file?.path === 'string' && /^[0-9a-f]{64}$/.test(file.sha256 ?? ''), 'invalid result artifact reference')
    const artifact = safePath(root, file.path, resolve(root, session.outputDir))
    assert(fileDigest(artifact) === file.sha256, 'completed native artifact changed or disappeared')
  }
  if (runtimeEvidenceRequired(manifest, result) || result.runtimeAttestation || result.runtimeEvidence?.length) {
    const eventsPath = safePath(root, portable(join(session.outputDir, 'runtime-events.jsonl')), resolve(root, session.outputDir))
    const events = readFileSync(eventsPath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
    const hooks = validateRuntimeEvidence({ manifest, task, session, events, runtimeAttestation: result.runtimeAttestation, runtimeEvidence: result.runtimeEvidence, ...(result.runtimeAttestation?.modelHttpDispatchRequired === true ? { nativeProcessSourceBytes: readFileSync(safePath(root, portable(join(session.outputDir, 'process-result.json')), resolve(root, session.outputDir))) } : {}), readEvidence: path => readFileSync(safePath(root, path, resolve(root, manifest.runRoot))) })
    assert(result.realHooksReady === hooks.realHooksReady, 'runtime readiness differs from evidence')
  } else assert(result.realHooksReady !== true, 'unattested runtime hooks claimed ready')
  return result
}

async function resolveOrphan(root, session) {
  const output = resolve(root, session.outputDir)
  const hostOutput = join(output, 'hook-host')
  if (existsSync(hostOutput)) {
    safePath(root, portable(relative(root, hostOutput)), output)
    assert(lstatSync(hostOutput).isDirectory(), 'hook host output is not a directory')
    const hostFinal = join(hostOutput, 'process-result.json'), hostHeartbeat = join(hostOutput, 'heartbeat.json')
    if (existsSync(hostFinal)) {
      safePath(root, portable(relative(root, hostFinal)), hostOutput)
      const final = readJson(hostFinal)
      assert(final.schemaVersion === 'gaia2-process-result-v1' && Number.isFinite(Date.parse(final.finishedAt)) && (Number.isInteger(final.exitCode) || final.spawnError || final.signal), 'invalid hook host final result')
      assert(final.processIdentity?.verified, 'hook host ownership is unknown; manual inspection required before restart')
      assert(!await isProcessIdentityAlive(final.processIdentity), 'hook host still has a live process; duplicate restart refused')
      assert(!final.terminationErrors?.length && final.manualInspectionRequired !== true, 'hook host termination is unresolved; manual inspection required before restart')
    } else if (existsSync(hostHeartbeat)) {
      safePath(root, portable(relative(root, hostHeartbeat)), hostOutput)
      const snapshot = readJson(hostHeartbeat)
      assert(snapshot.processIdentity?.verified, 'hook host ownership is unknown; manual inspection required before restart')
      assert(!await isProcessIdentityAlive(snapshot.processIdentity), 'hook host still has a live process; duplicate restart refused')
    } else assert(readdirSync(hostOutput).length === 0, 'used hook host lacks ownership metadata; manual inspection required before restart')
  }
  const processResult = join(output, 'process-result.json')
  if (existsSync(processResult)) {
    const final = readJson(processResult)
    assert(final.schemaVersion === 'gaia2-process-result-v1' && Number.isFinite(Date.parse(final.finishedAt)) && (Number.isInteger(final.exitCode) || final.spawnError || final.signal), 'invalid final child result')
    assert(!final.terminationErrors?.length && final.manualInspectionRequired !== true, 'child termination is unresolved; manual inspection required before restart')
    if (final.processIdentity?.verified) assert(!await isProcessIdentityAlive(final.processIdentity), 'final child result still belongs to a live process')
    else if (final.processIdentity) assert(final.childExited === true && final.childClosed === true, 'unverified final child has no observed exit/close proof; manual inspection required')
    return
  }
  const heartbeat = join(output, 'heartbeat.json')
  if (existsSync(heartbeat)) {
    const snapshot = readJson(heartbeat)
    assert(snapshot.processIdentity, 'interrupted session has unknown child ownership; manual inspection required')
    assert(!await isProcessIdentityAlive(snapshot.processIdentity), 'interrupted session still has a live child; duplicate restart refused')
    return
  }
  assert(!existsSync(output) || readdirSync(output).length === 0, 'used session lacks child ownership metadata; manual inspection required')
}

function createSession(root, manifest, task, record) {
  const sessionOrdinal = record.sessions.length + 1
  const sessionId = `${String(sessionOrdinal).padStart(4, '0')}-${randomUUID().slice(0, 12)}`
  const paths = Object.fromEntries(['outputDir', 'fixtureDir', 'workspaceDir'].map(key => [key, portable(join(task[key], 'sessions', sessionId))]))
  for (const path of Object.values(paths)) { const absolute = safePath(root, path, resolve(root, manifest.runRoot)); mkdirSync(dirname(absolute), { recursive: true }); mkdirSync(absolute) }
  return { sessionId, sessionOrdinal, parentSessionId: record.sessions.at(-1)?.sessionId ?? null, recoveryKind: sessionOrdinal > 1 ? 'clean_environment_restart_not_ARE_checkpoint' : 'initial_execution', ...paths, startedAt: new Date().toISOString(), endedAt: null }
}

async function delayUntil(deadline, signal) {
  const delay = Math.max(0, Date.parse(deadline) - Date.now())
  if (!delay || signal?.aborted) return Promise.resolve()
  await new Promise(resolveDelay => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolveDelay() }
    const timer = setTimeout(finish, Math.min(delay, 2147483647))
    signal?.addEventListener('abort', finish, { once: true })
  })
  if (!signal?.aborted && Date.parse(deadline) > Date.now()) await delayUntil(deadline, signal)
}

/** Manifest-driven sequential execution. A restart is a new disposable ARE environment, never a tool replay. */
export async function runFrozenBatch({ root, manifest, settings, executeTask, signal, resume = false, retryInfrastructure = false, maxTasks = Infinity, onlyRunNumber = null, onlyPhase = null, onlyExecutionId = null } = {}) {
  root = resolve(root)
  assertPublicConfig(settings)
  assertSupportedPlan(manifest)
  assert(settings.concurrency === 1 && settings.minimal === false, 'frozen original tasks require concurrency 1 and minimal=false')
  assert(maxTasks === Infinity || Number.isInteger(maxTasks) && maxTasks > 0, 'maxTasks must be a positive integer')
  const selectedTaskIds = selectFrozenTaskIds(manifest, { onlyRunNumber, onlyPhase, onlyExecutionId })
  const runRoot = safePath(root, manifest.runRoot, join(root, 'runs'))
  mkdirSync(runRoot, { recursive: true })
  const statePath = safePath(root, manifest.stateFile, runRoot)
  const runtimePath = join(runRoot, 'runtime-settings.json')
  const runtimeHash = digest(settings)
  const release = await acquireOwner(runRoot)
  const saveState = state => { state.updatedAt = new Date().toISOString(); atomicJson(statePath, state) }
  let state, waitingForRetryAt = null, batchHeartbeatError = false, terminalStatus = null, terminalReason = null, terminalReportPath = null, finishedAt = null
  const heartbeatPath = join(runRoot, 'batch-heartbeat.json')
  const heartbeat = () => {
    try { atomicJson(heartbeatPath, { schemaVersion: 'gaia2-batch-heartbeat-v1', runId: manifest.runId, manifestHash: manifest.manifestHash, supervisorPid: process.pid, status: terminalStatus ?? (signal?.aborted ? 'interrupted' : waitingForRetryAt ? 'waiting_for_retry' : state?.tasks.some(task => task.status === 'running') ? 'running' : 'supervising'), progress: 'unknown', nextRetryAt: terminalStatus ? null : waitingForRetryAt, terminal: terminalStatus !== null, terminationReason: terminalReason, reportPath: terminalReportPath, finishedAt, updatedAt: new Date().toISOString() }) }
    catch { batchHeartbeatError = true }
  }
  heartbeat()
  const timer = setInterval(heartbeat, settings.heartbeatIntervalMs)
  try {
    if (existsSync(runtimePath)) assert(digest(readJson(runtimePath)) === runtimeHash, 'effective runtime/retry settings changed; use a new run_id')
    else {
      const fd = openSync(runtimePath, 'wx', 0o600)
      try { writeFileSync(fd, `${JSON.stringify(settings, null, 2)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
    }
    if (existsSync(statePath)) {
      assert(resume, 'run-state already exists; specify resume to continue')
      state = readJson(statePath)
      assert(state.schemaVersion === 'gaia2-run-state-v1' && state.runId === manifest.runId && state.manifestHash === manifest.manifestHash && state.runtimeHash === runtimeHash, 'state is bound to another manifest/runtime')
      assert(digest(state.tasks.map(task => task.executionId)) === digest(manifest.tasks.map(task => task.executionId)), 'state task set changed')
    } else { state = initialState(manifest, runtimeHash); saveState(state) }
    validateStatePaths(root, manifest, state)
    // Reconcile the report-before-state commit window. A valid completed report is never rerun.
    for (let index = 0; index < state.tasks.length; index++) {
      const record = state.tasks[index], task = manifest.tasks[index], session = record.sessions.at(-1)
      assert(['pending', 'running', 'completed', 'retry_pending', 'terminal_failure'].includes(record.status), 'invalid task state')
      if (record.status === 'terminal_failure') assert(record.failure?.retryable === false && record.failure?.category !== 'business_failure', 'terminal task is not a non-retryable technical failure')
      if (record.status === 'completed') { validateResult(root, manifest, task, session, record, runtimeHash); continue }
      if (record.status !== 'running') continue
      assert(session, 'running task has no session')
      await resolveOrphan(root, session)
      const resultPath = portable(join(session.workspaceDir, 'task-result.json'))
      if (existsSync(resolve(root, resultPath))) {
        const result = readJson(resolve(root, resultPath))
        if (result.evaluationComplete === true) {
          record.resultPath = resultPath; record.resultSha256 = fileDigest(resolve(root, resultPath))
          validateResult(root, manifest, task, session, record, runtimeHash)
          record.status = 'completed'; session.endedAt = result.finishedAt
          continue
        }
      }
      record.status = 'retry_pending'; record.failure = { category: 'interrupted', retryable: true, nextRetryAt: null }
      session.endedAt = new Date().toISOString(); session.terminationReason = 'orphaned_parent'
    }
    saveState(state)
    let executed = 0
    for (let index = 0; index < state.tasks.length; index++) {
      const record = state.tasks[index], task = manifest.tasks[index]
      if (!selectedTaskIds.has(task.executionId)) continue
      if (signal?.aborted || executed >= maxTasks) break
      if (record.status === 'completed') continue
      if (record.status === 'terminal_failure') continue
      if (record.status === 'retry_pending') {
        if (!record.failure?.retryable || record.failure.category !== 'interrupted' && !retryInfrastructure) break
        await resolveOrphan(root, record.sessions.at(-1))
        if (record.failure.nextRetryAt) { waitingForRetryAt = record.failure.nextRetryAt; await delayUntil(record.failure.nextRetryAt, signal); waitingForRetryAt = null }
        if (signal?.aborted) break
      }
      const session = createSession(root, manifest, task, record)
      record.sessions.push(session); record.status = 'running'; record.failure = null; record.resultPath = null; record.resultSha256 = null; saveState(state)
      let execution
      try { execution = await executeTask({ root, manifest, task, session, settings, signal }) }
      catch (error) {
        // Keep adapter-boundary failures distinct from child-process failures.
        // Only a fixed enum and a class name leave the process; raw messages
        // may contain paths, credentials, or provider payloads.
        const errorType = /^[A-Za-z0-9_]+$/.test(error?.name ?? '') ? error.name : 'Error'
        execution = { processResult: { exitCode: null, spawnError: { code: 'ADAPTER_FAILURE' }, adapterFailure: { code: 'adapter_exception', errorType } }, report: { hasException: true, exceptionType: errorType }, events: [] }
      }
      const processResult = execution?.processResult ?? { exitCode: null }
      let report = execution?.report ?? {}
      const evidenceRequired = runtimeEvidenceRequired(manifest, execution)
      let realHooksReady = false
      if (evidenceRequired || execution?.runtimeAttestation || execution?.runtimeEvidence?.length) {
        try {
          const hooks = validateRuntimeEvidence({ manifest, task, session, events: execution?.events, runtimeAttestation: execution?.runtimeAttestation, runtimeEvidence: execution?.runtimeEvidence, ...(execution?.runtimeAttestation?.modelHttpDispatchRequired === true ? { nativeProcessSourceBytes: readFileSync(safePath(root, portable(join(session.outputDir, 'process-result.json')), resolve(root, session.outputDir))) } : {}), readEvidence: path => readFileSync(safePath(root, path, runRoot)) })
          realHooksReady = hooks.realHooksReady
        } catch (error) { report = { ...report, evaluationComplete: false, hasException: true, exceptionType: 'RuntimeEvidenceError', evidenceGateCode: safeEvidenceGateCode(error) } }
      }
      const healthy = processResult.exitCode === 0 && !processResult.signal && !processResult.timedOut && !processResult.interrupted && !processResult.spawnError && !processResult.loggingError && !processResult.heartbeatError && !(processResult.terminationErrors?.length)
      const evaluated = healthy && report.evaluationComplete === true && report.hasException !== true && !report.exceptionType && report.scenarioId === task.scenarioId && report.runNumber === task.runNumber && typeof report.businessPassed === 'boolean'
      const failure = evaluated ? (report.businessPassed ? null : { category: 'business_failure', retryable: false }) : classifyExecutionFailure({ processResult, report: { ...report, evaluationComplete: false }, events: execution?.events ?? [] })
      const resultPath = portable(join(session.workspaceDir, 'task-result.json'))
      const result = { schemaVersion: 'gaia2-task-result-v1', runId: manifest.runId, manifestHash: manifest.manifestHash, runtimeHash, executionId: task.executionId, sessionId: session.sessionId, scenarioId: task.scenarioId, runNumber: task.runNumber, phase: task.phase, config: task.config, evaluationComplete: evaluated, businessPassed: evaluated ? report.businessPassed : null, score: evaluated ? (report.businessPassed ? 1 : 0) : null, failure, process: { exitCode: processResult.exitCode ?? null, signal: processResult.signal ?? null, timedOut: processResult.timedOut === true, interrupted: processResult.interrupted === true, elapsedMs: processResult.elapsedMs ?? null }, artifacts: execution?.artifacts ?? [], runtimeEvidenceRequired: evidenceRequired, runtimeAttestation: execution?.runtimeAttestation ?? null, runtimeEvidence: execution?.runtimeEvidence ?? [], realHooksReady, finishedAt: new Date().toISOString() }
      atomicJson(resolve(root, resultPath), result)
      record.resultPath = resultPath; record.resultSha256 = fileDigest(resolve(root, resultPath))
      if (evaluated) validateResult(root, manifest, task, session, record, runtimeHash)
      // A retryable interruption/transport failure must preserve the queue stop
      // point, but a non-retryable technical failure is terminal for this
      // execution and must not prevent later independent tasks from running.
      // Terminal failures are never business results and therefore remain
      // ineligible for pass@5 or official export.
      const terminalFailure = !evaluated && failure?.retryable !== true && failure?.category !== 'interrupted' && failure?.category !== 'business_failure'
      record.status = evaluated ? 'completed' : terminalFailure ? 'terminal_failure' : 'retry_pending'; record.failure = failure
      session.endedAt = result.finishedAt; session.terminationReason = evaluated ? 'judged' : failure.category
      saveState(state)
      executed++
      if (!evaluated && !terminalFailure) break // Never loop whole scenarios as an unbounded hidden retry.
    }
    const counts = Object.fromEntries(['pending', 'running', 'completed', 'retry_pending', 'terminal_failure'].map(status => [status, state.tasks.filter(task => task.status === status).length]))
    const results = state.tasks.filter(task => task.status === 'completed').map((record, index) => readJson(resolve(root, record.resultPath)))
    const selectedCompleted = state.tasks.filter(record => selectedTaskIds.has(record.executionId) && record.status === 'completed').length
    const selectedResults = results.filter(result => selectedTaskIds.has(result.executionId))
    const terminalFailures = counts.terminal_failure
    const technicalFailures = terminalFailures + counts.retry_pending
    const selectedTechnicalComplete = !batchHeartbeatError && state.tasks.filter(record => selectedTaskIds.has(record.executionId)).every(record => ['completed', 'terminal_failure'].includes(record.status))
    const submissionBlockedReasons = []
    if (terminalFailures > 0) submissionBlockedReasons.push('non_retryable_technical_failures')
    if (counts.retry_pending > 0) submissionBlockedReasons.push('retry_pending_executions')
    if (counts.pending > 0 || counts.running > 0) submissionBlockedReasons.push('unexecuted_planned_executions')
    if (batchHeartbeatError) submissionBlockedReasons.push('batch_heartbeat_error')
    if (!selectedTechnicalComplete) submissionBlockedReasons.push('selected_execution_set_incomplete')
    if (!results.length || results.some(result => result.realHooksReady !== true)) submissionBlockedReasons.push('real_runtime_hooks_not_attested')
    submissionBlockedReasons.push('full_real_official_run_and_phase_3_to_5_gates_not_attested')
    const report = { schemaVersion: 'gaia2-batch-progress-v1', runId: manifest.runId, manifestHash: manifest.manifestHash, runtimeHash, status: batchHeartbeatError ? 'infrastructure_error' : counts.completed === manifest.tasks.length ? 'evaluation_complete' : signal?.aborted ? 'interrupted' : 'incomplete', counts, plannedInitialExecutions: manifest.tasks.length, evaluatedInitialExecutions: results.length, onlyRunNumber, onlyPhase, onlyExecutionId, selectedExecutions: selectedTaskIds.size, selectedCompleted, selectedEvaluationComplete: !batchHeartbeatError && selectedCompleted === selectedTaskIds.size, selectedTechnicalComplete, selectedRealHooksReady: !batchHeartbeatError && selectedCompleted === selectedTaskIds.size && selectedResults.every(result => result.realHooksReady === true), businessSuccesses: results.filter(result => result.businessPassed).length, businessFailures: results.filter(result => !result.businessPassed).length, technicalFailures, terminalFailures, retryPending: counts.retry_pending, totalSessions: state.tasks.reduce((sum, task) => sum + task.sessions.length, 0), executedThisInvocation: executed, batchHeartbeatError, submissionBlockedReason: submissionBlockedReasons[0] ?? null, submissionBlockedReasons, officialSubmissionReady: false, realHooksReady: !batchHeartbeatError && results.length === manifest.tasks.length && results.every(result => result.realHooksReady === true), runtimeAttestedExecutions: results.filter(result => result.runtimeAttestation).length, generatedAt: new Date().toISOString() }
    terminalStatus = report.status; finishedAt = report.generatedAt; terminalReportPath = portable(relative(root, join(runRoot, 'batch-report.json')))
    heartbeat()
    if (batchHeartbeatError) { report.status = 'infrastructure_error'; report.batchHeartbeatError = true; terminalStatus = report.status }
    atomicJson(join(runRoot, 'batch-report.json'), report)
    return report
  } catch (error) {
    terminalStatus = 'infrastructure_error'; terminalReason = 'validation_or_persistence_error'; terminalReportPath = null; finishedAt = new Date().toISOString(); heartbeat()
    throw error
  } finally { clearInterval(timer); release() }
}
