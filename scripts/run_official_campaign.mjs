import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditPhase0, validateRunManifest } from '../src/phase0_audit.mjs'
import { digest, fileDigest, loadRunInputs, readJson } from '../src/phase0_run.mjs'
import { resolveRuntimeSettings } from '../src/phase1_config.mjs'
import { readModelConnection, resolveModelRetrySettings } from '../src/phase1_official.mjs'
import { isProcessIdentityAlive, readProcessIdentity, runChildProcess } from '../src/phase1_process.mjs'
import { assertSupportedPlan, atomicJson } from '../src/phase1_runner.mjs'
import { packagePath } from '../src/phase2_export.mjs'
import { auditPhase6Run } from './phase6_result_audit.mjs'
import { checkModelService } from './model_service_health.mjs'

const portable = value => value.replaceAll('\\', '/')
const now = () => new Date().toISOString()
const defaultRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const STATUSES = ['pending', 'running', 'completed', 'terminal_failure', 'retry_pending']
const check = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { campaignCode: code }) }

/** Dispatch order only: all frozen identities/seeds remain unchanged. Official
 * mini tasks inherit a capability only from an exact Standard identity/hash. */
export function coverageFirstOrder(tasks) {
  const result = []
  const capabilities = new Map(tasks.filter(task => task.phase === 'standard' && typeof task.scenarioId === 'string'
    && typeof task.scenarioHash === 'string').map(task => [`${task.scenarioId}\0${task.scenarioHash}`, task.config]))
  const capability = task => task.phase === 'standard' ? task.config
    : capabilities.get(`${task.scenarioId}\0${task.scenarioHash}`) ?? task.config
  for (const runNumber of [...new Set(tasks.map(task => task.runNumber))].sort((a, b) => a - b)) {
    const phases = ['standard', 'agent2agent', 'noise'].map(phase => {
      const matching = tasks.filter(task => task.runNumber === runNumber && task.phase === phase)
      return [...new Set(matching.map(capability))].map(config => matching.filter(task => capability(task) === config))
    })
    const configOrdinals = phases.map(() => 0)
    while (phases.some(groups => groups.some(group => group.length))) {
      phases.forEach((groups, phaseIndex) => {
        for (let count = 0; count < groups.length; count++) {
          const index = configOrdinals[phaseIndex]++ % groups.length
          if (groups[index].length) { result.push(groups[index].shift().executionId); break }
        }
      })
    }
  }
  check(result.length === tasks.length && new Set(result).size === tasks.length, 'dispatch_order_not_a_permutation')
  return result
}

export function campaignCounts(slots) {
  return { ...Object.fromEntries(STATUSES.map(status => [status, slots.filter(slot => slot.status === status).length])),
    businessSuccesses: slots.filter(slot => slot.evaluationComplete === true && slot.score === 1).length,
    businessFailures: slots.filter(slot => slot.evaluationComplete === true && slot.score === 0).length }
}

async function validateInputs(root, manifest, env) {
  const audit = await auditPhase0(root, { deep: false, env })
  check(audit.phase0Passed, 'frozen_input_audit_failed')
  const inputs = loadRunInputs(root)
  check(validateRunManifest(root, manifest, inputs, manifest.entrypoints.environmentOverrides).length === 0, 'frozen_manifest_invalid')
  assertSupportedPlan(manifest)
  check(manifest.mode === 'official_submission' && manifest.selection.fullOfficialCoverage === true && manifest.tasks.length === 3360, 'full_official_manifest_required')
  const sources = [
    ...(inputs.environment.codeInputs ?? []).map(row => ({ ...row, root })),
    ...(inputs.environment.backend?.codeInputs ?? []).map(row => ({ ...row, root: inputs.protocol.runtime.backendRoot })),
  ]
  return () => sources.every(row => fileDigest(packagePath(row.root, portable(row.path))) === row.sha256)
}

async function pause(milliseconds, signal) {
  if (signal?.aborted) return
  await new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, milliseconds)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

function processClosed(value) {
  return value && value.manualInspectionRequired !== true && value.supervisionDetached !== true
    && !value.loggingError && !value.heartbeatError && !(value.terminationErrors?.length)
    && (value.spawnError && !value.pid || value.childExited === true && value.childClosed === true && value.processIdentity?.verified === true)
}

async function assertClosed(value, alive) {
  check(processClosed(value), 'process_ownership_or_persistence_unresolved')
  if (value.processIdentity?.verified) check(!await alive(value.processIdentity), 'owned_process_still_alive')
}

async function verifySessionClosed(root, session, alive) {
  for (const relativeDir of [session.outputDir, `${portable(session.outputDir)}/hook-host`]) {
    const directory = packagePath(root, portable(relativeDir))
    const final = path.join(directory, 'process-result.json')
    if (fs.existsSync(final)) await assertClosed(readJson(final), alive)
    else for (const name of ['heartbeat.json', 'process-reservation.json']) check(!fs.existsSync(path.join(directory, name)), 'session_process_has_no_final_evidence')
  }
}

function slotObservation(root, task, record, runtimeHash, manifest) {
  if (!record) return { executionId: task.executionId, phase: task.phase, config: task.config, scenarioId: task.scenarioId, runNumber: task.runNumber, status: 'pending', score: null, evaluationComplete: false, sessionCount: 0 }
  let result = null
  if (record.resultPath) {
    const target = packagePath(root, portable(record.resultPath))
    check(fileDigest(target) === record.resultSha256, 'result_hash_changed')
    result = readJson(target)
    check(result.runId === manifest.runId && result.manifestHash === manifest.manifestHash && result.runtimeHash === runtimeHash
      && result.executionId === task.executionId && result.sessionId === record.sessions.at(-1)?.sessionId, 'result_binding_changed')
    check(record.status === 'completed' ? result.evaluationComplete === true && typeof result.businessPassed === 'boolean'
      && result.score === (result.businessPassed ? 1 : 0) : result.evaluationComplete === false && result.score === null, 'technical_failure_must_not_have_a_score')
    for (const artifact of result.artifacts ?? []) check(fileDigest(packagePath(root, portable(artifact.path))) === artifact.sha256, 'native_trace_artifact_changed')
  }
  return { executionId: task.executionId, phase: task.phase, config: task.config, scenarioId: task.scenarioId, runNumber: task.runNumber,
    status: record.status, score: result?.score ?? null, evaluationComplete: result?.evaluationComplete === true,
    realHooksReady: result?.realHooksReady === true, failure: record.failure ?? null, sessionCount: record.sessions.length,
    result: record.resultPath ? { path: portable(record.resultPath), sha256: record.resultSha256 } : null,
    artifacts: result?.artifacts ?? [], session: record.sessions.at(-1) ?? null }
}

/** Dependencies can only be supplied by importing code (deterministic tests),
 * never by CLI flags/environment/frozen manifests. Production uses real CLI/OS. */
export async function runOfficialCampaign({ root = defaultRoot, manifestPath, env = process.env, signal,
  serviceCooldownMs = 60000, maxServiceCooldownMs = 900000 } = {}, dependencies = {}) {
  root = path.resolve(root)
  check(Number.isSafeInteger(serviceCooldownMs) && serviceCooldownMs > 0 && Number.isSafeInteger(maxServiceCooldownMs)
    && maxServiceCooldownMs >= serviceCooldownMs, 'invalid_service_cooldown')
  const ops = { validateInputs, runChildProcess, readModelConnection, readProcessIdentity, isProcessIdentityAlive, checkModelService, pause, ...dependencies }
  const fatalController = new AbortController()
  const childSignal = signal ? AbortSignal.any([signal, fatalController.signal]) : fatalController.signal
  const manifestAbsolute = packagePath(root, portable(manifestPath))
  const manifest = readJson(manifestAbsolute), manifestSha256 = fileDigest(manifestAbsolute)
  const sourceStable = await ops.validateInputs(root, manifest, env)
  const runRoot = packagePath(root, portable(manifest.runRoot)), statePath = packagePath(root, portable(manifest.stateFile))
  const runtime = { ...resolveRuntimeSettings({ protocol: { requestedRuntime: manifest.requestedRuntime }, entrypoint: 'batch', env }), modelRetry: resolveModelRetrySettings(env) }
  const runtimeHash = digest(runtime), runtimePath = path.join(runRoot, 'runtime-settings.json')
  check(!runtime.minimal && !env.GAIA2_E2E_TOOL_ALLOWLIST, 'original_tasks_must_be_unmodified')
  const dispatchIds = coverageFirstOrder(manifest.tasks), byId = new Map(manifest.tasks.map(task => [task.executionId, task]))
  const intent = { schemaVersion: 'gaia2-official-campaign-intent-v1', runId: manifest.runId, manifestHash: manifest.manifestHash,
    manifestSha256, runtimeHash, executionIds: dispatchIds, selectionRule: 'run_number_then_phase_and_exact_capability_round_robin_v1',
    plannedExecutions: manifest.tasks.length, serviceCooldownMs, maxServiceCooldownMs,
    retryWholeExecutions: false, stopOnSingleTaskTechnicalFailure: false, oldResultsImported: false, officialSubmissionReady: false }
  const intentPath = path.join(runRoot, 'campaign-intent.json'), campaignPath = path.join(runRoot, 'campaign-state.json')
  const ownerPath = path.join(runRoot, 'campaign-owner.json'), ownerId = randomUUID()
  const identity = await ops.readProcessIdentity(process.pid)
  check(identity?.verified === true, 'campaign_identity_unverified')
  fs.mkdirSync(runRoot, { recursive: true })
  if (fs.existsSync(ownerPath)) {
    const previous = readJson(ownerPath)
    check(previous.processIdentity?.verified && !await ops.isProcessIdentityAlive(previous.processIdentity), 'another_campaign_owner_or_unknown_owner')
    fs.renameSync(ownerPath, path.join(runRoot, `abandoned-campaign-owner-${randomUUID()}.json`))
  }
  const ownerFd = fs.openSync(ownerPath, 'wx', 0o600)
  try { fs.writeFileSync(ownerFd, JSON.stringify({ ownerId, processIdentity: identity, startedAt: now() })); fs.fsyncSync(ownerFd) }
  finally { fs.closeSync(ownerFd) }
  let log = null, slots = [], status = 'starting', activeExecutionId = null, cooldown = null, heartbeatFailed = false
  const observationId = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const observerPath = path.join(runRoot, `campaign-observer-${observationId}.jsonl`)
  const processRoot = path.join(runRoot, 'campaign-processes', observationId)
  const persist = () => atomicJson(campaignPath, { schemaVersion: 'gaia2-official-campaign-state-v1', runId: manifest.runId,
    manifestHash: manifest.manifestHash, runtimeHash, status, supervisorPid: process.pid, processIdentity: identity,
    activeExecutionId, cooldown, counts: campaignCounts(slots), plannedExecutions: manifest.tasks.length, slots,
    observerPath: portable(path.relative(root, observerPath)), intentPath: portable(path.relative(root, intentPath)), updatedAt: now(), officialSubmissionReady: false })
  const record = value => {
    const row = { observedAt: now(), ...value }
    if (log !== null) { fs.writeSync(log, JSON.stringify(row) + '\n'); fs.fsyncSync(log) }
    console.log(JSON.stringify(row))
  }
  const preconditions = () => {
    check(!heartbeatFailed, 'campaign_heartbeat_write_failed')
    check(fileDigest(manifestAbsolute) === manifestSha256 && sourceStable(), 'frozen_source_or_manifest_changed')
    for (const reference of Object.values(manifest.lockRefs ?? {})) check(fileDigest(packagePath(root, portable(reference.path))) === reference.sha256, 'frozen_lock_changed')
    check(!fs.existsSync(path.join(runRoot, 'run-owner.json')), 'run_owner_not_released')
    if (fs.existsSync(runtimePath)) check(digest(readJson(runtimePath)) === runtimeHash, 'runtime_binding_changed')
  }
  const readState = () => {
    const state = fs.existsSync(statePath) ? readJson(statePath) : null
    if (state) {
      check(state.runId === manifest.runId && state.manifestHash === manifest.manifestHash && state.runtimeHash === runtimeHash, 'state_binding_changed')
      check(digest(state.tasks.map(row => row.executionId)) === digest(manifest.tasks.map(row => row.executionId)), 'state_task_set_changed')
      check(state.tasks.every(row => STATUSES.includes(row.status) && row.status !== 'running'), 'unresolved_running_task')
      check(auditPhase6Run({ root, manifest, state }).errors.length === 0, 'ledger_audit_failed')
    }
    return state
  }
  let timer = null
  try {
    if (fs.existsSync(intentPath)) check(digest(readJson(intentPath)) === digest(intent), 'campaign_intent_changed')
    else { const fd = fs.openSync(intentPath, 'wx', 0o600); try { fs.writeFileSync(fd, JSON.stringify(intent, null, 2) + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) } }
    log = fs.openSync(observerPath, 'wx', 0o600)
    preconditions()
    const state = readState(), initialRecords = new Map((state?.tasks ?? []).map(row => [row.executionId, row]))
    slots = dispatchIds.map(id => slotObservation(root, byId.get(id), initialRecords.get(id), runtimeHash, manifest))
    const connection = ops.readModelConnection(root, manifest.models)
    status = 'running'; persist()
    // A live, durable observation exists even during long native calls/cooldown.
    timer = setInterval(() => {
      try { persist() }
      catch { heartbeatFailed = true; fatalController.abort(); console.error(JSON.stringify({ status: 'fatal', code: 'campaign_heartbeat_write_failed' })) }
    }, 30000)
    record({ status: 'campaign_started', runId: manifest.runId, plannedExecutions: dispatchIds.length, dispatchOrderHash: digest(dispatchIds), counts: campaignCounts(slots) })
    let serviceFailures = 0
    for (let ordinal = 0; ordinal < dispatchIds.length; ordinal++) {
      if (signal?.aborted) break
      preconditions()
      const executionId = dispatchIds[ordinal], task = byId.get(executionId), before = readState()
      const previous = before?.tasks.find(row => row.executionId === executionId)
      if (previous && previous.status !== 'pending') {
        if (previous.sessions.at(-1)) await verifySessionClosed(root, previous.sessions.at(-1), ops.isProcessIdentityAlive)
        record({ status: 'slot_skipped', executionId, ledgerStatus: previous.status, reason: 'already_attempted_never_automatically_replayed' }); continue
      }
      activeExecutionId = executionId; slots[ordinal] = { ...slots[ordinal], status: 'running' }; persist()
      record({ status: 'slot_starting', executionId, ordinal: ordinal + 1, phase: task.phase, config: task.config, runNumber: task.runNumber })
      const processResult = await ops.runChildProcess({ command: process.execPath, args: ['scripts/official_batch_smoke.mjs', '--manifest', portable(manifestPath),
        '--execute', '--resume', '--only-phase', task.phase, '--only-run-number', String(task.runNumber), '--only-execution-id', executionId, '--max-tasks', '1'],
      // The inner task supervisor owns the frozen task deadline and cleanup.
      // A competing outer deadline could kill the CLI before it records/reaps it.
      cwd: root, env, outputDir: path.join(processRoot, executionId), processTimeoutMs: 0,
      heartbeatIntervalMs: runtime.heartbeatIntervalMs, signal: childSignal, secrets: [connection.apiKey],
      onSpawn: snapshot => record({ status: 'cli_spawned', executionId, snapshot }) })
      await assertClosed(processResult, ops.isProcessIdentityAlive)
      check(!processResult.signal && !processResult.timedOut && !processResult.interrupted && !processResult.spawnError && [0, 2].includes(processResult.exitCode), 'cli_supervision_failed')
      preconditions()
      const after = readState(), ledger = after?.tasks.find(row => row.executionId === executionId)
      check(ledger && ['completed', 'terminal_failure', 'retry_pending'].includes(ledger.status) && ledger.sessions.length === 1, 'slot_was_not_durably_recorded')
      // Exact selectors must not mutate or execute a second independent slot.
      for (const row of after.tasks) if (row.executionId !== executionId) {
        const old = before?.tasks.find(item => item.executionId === row.executionId)
        check(old ? digest(old) === digest(row) : row.status === 'pending' && row.sessions.length === 0, 'unselected_slot_changed')
      }
      const cli = readJson(processResult.stdoutPath)
      check(cli.schemaVersion === 'gaia2-batch-progress-v1' && cli.runId === manifest.runId && cli.manifestHash === manifest.manifestHash
        && cli.runtimeHash === runtimeHash && cli.onlyExecutionId === executionId && cli.onlyPhase === task.phase && cli.onlyRunNumber === task.runNumber
        && cli.selectedExecutions === 1 && cli.executedThisInvocation === 1 && !cli.batchHeartbeatError, 'cli_evidence_invalid')
      await verifySessionClosed(root, ledger.sessions.at(-1), ops.isProcessIdentityAlive)
      slots[ordinal] = { ...slotObservation(root, task, ledger, runtimeHash, manifest), cliProcess: { path: portable(path.relative(root, processResult.resultPath)), sha256: fileDigest(processResult.resultPath) } }
      activeExecutionId = null; persist()
      record({ ...slots[ordinal], status: 'slot_recorded', ledgerStatus: slots[ordinal].status, ordinal: ordinal + 1, counts: campaignCounts(slots) })
      const failure = ledger.failure
      const modelCause = failure?.diagnostic?.causes?.some(cause => cause.stage === 'model_request')
      if ((ledger.status === 'retry_pending' && ['rate_limit', 'request_timeout', 'transport_error'].includes(failure?.category)) || (modelCause && ledger.status !== 'completed')) {
        serviceFailures++
        for (;;) {
          const providerWait = Math.max(0, Date.parse(failure?.nextRetryAt ?? '') - Date.now()) || 0
          const waitMs = Math.min(maxServiceCooldownMs, Math.max(providerWait, serviceCooldownMs * 2 ** Math.min(serviceFailures - 1, 8)))
          cooldown = { reason: 'model_service_failure', until: new Date(Date.now() + waitMs).toISOString(), waitMs, serviceFailures }
          status = 'cooling_down'; persist(); record({ status, ...cooldown, failedExecutionId: executionId, wholeExecutionWillNotBeRetried: true })
          for (let remaining = waitMs; remaining > 0 && !signal?.aborted; remaining -= Math.min(remaining, 30000)) {
            await ops.pause(Math.min(remaining, 30000), childSignal); preconditions(); persist()
          }
          if (signal?.aborted) break
          preconditions()
          const health = await ops.checkModelService({ root, timeoutMs: runtime.modelRequestTimeoutSeconds * 1000 })
          record({ status: 'service_probe', healthy: health.status === 'healthy', modelsHttpStatus: health.checks?.models?.httpStatus ?? null,
            chatHttpStatus: health.checks?.chatCompletions?.httpStatus ?? null, noBenchmarkExecution: true })
          check(![401, 403].includes(health.checks?.chatCompletions?.httpStatus), 'model_authentication_failed')
          if (health.status === 'healthy') break
          serviceFailures++
        }
        cooldown = null; status = 'running'; persist()
      } else serviceFailures = 0
    }
    status = signal?.aborted ? 'interrupted' : 'all_slots_attempted'
    activeExecutionId = null; persist(); record({ status, counts: campaignCounts(slots), plannedExecutions: dispatchIds.length, officialSubmissionReady: false })
    return readJson(campaignPath)
  } catch (error) {
    status = 'fatal'; cooldown = null
    const code = error.campaignCode ?? 'campaign_validation_or_io_failed'
    try { persist(); record({ status, code, activeExecutionId, counts: campaignCounts(slots) }) } catch { /* An unwritable evidence store is fatal too. Never continue silently. */ }
    throw Object.assign(new Error(code), { campaignCode: code })
  } finally {
    clearInterval(timer)
    if (log !== null) fs.closeSync(log)
    if (fs.existsSync(ownerPath) && readJson(ownerPath).ownerId === ownerId) fs.unlinkSync(ownerPath)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
  try {
    check(process.argv.length === 4 && process.argv[2] === '--manifest' && !process.argv[3].startsWith('--'), 'usage_manifest_required')
    const report = await runOfficialCampaign({ manifestPath: process.argv[3], signal: controller.signal })
    if (report.status !== 'all_slots_attempted') process.exitCode = 130
  } catch (error) { console.error(JSON.stringify({ status: 'fatal', code: error.campaignCode ?? 'campaign_failed', officialSubmissionReady: false })); process.exitCode = 1 }
  finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt) }
}
