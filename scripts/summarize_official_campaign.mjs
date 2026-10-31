import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { digest, within } from '../src/phase0_run.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCHEMA = 'gaia2-official-campaign-summary-v1'
const HASH = /^[a-f0-9]{64}$/
const STATUSES = new Set(['pending', 'running', 'completed', 'retry_pending', 'terminal_failure'])
const portable = value => String(value).replaceAll('\\', '/')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function check(condition, code) { if (!condition) throw new Error(code) }
function pathInside(root, boundary, value) {
  check(typeof value === 'string' && value && !isAbsolute(value) && !win32.isAbsolute(value), 'unsafe_source_path')
  const target = resolve(root, portable(value))
  check(within(boundary, target) && target !== resolve(boundary), 'source_path_escape')
  for (let at = target; ; at = dirname(at)) {
    check(!lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink(), 'symbolic_source_path')
    if (at === dirname(at)) break
  }
  return target
}
function readSource(root, boundary, path, expectedHash = null, parse = true) {
  const target = pathInside(root, boundary, path)
  check(lstatSync(target).isFile(), 'source_not_regular_file')
  const bytes = readFileSync(target), sha256 = hash(bytes)
  check(expectedHash === null || HASH.test(expectedHash) && sha256 === expectedHash, 'source_hash_mismatch')
  return { value: parse ? JSON.parse(bytes) : null, ref: { path: portable(relative(root, target)), sha256 } }
}
const fresh = () => ({ planned: 0, business_success: 0, business_failure: 0, technical_failure: 0,
  pending: 0, running: 0, retry_pending: 0, unverified: 0 })
function increment(map, key, outcome) {
  map[key] ??= fresh(); map[key].planned++; map[key][outcome]++
}

function analysisIndex(root, runRoot, task, session, result) {
  const references = result.runtimeEvidence ?? []
  check(Array.isArray(references), 'invalid_runtime_evidence_list')
  const hooks = [], actions = [], childHooks = []
  let last = null
  for (const reference of references) {
    if (!/\/plugin-runtime\/[^/]+\.json$/.test(portable(reference.path))) continue
    const source = readSource(root, runRoot, reference.path, reference.sha256), receipt = source.value
    const childPrefix = `${portable(session.workspaceDir)}/plugin-runtime-children/`
    if (source.ref.path.startsWith(childPrefix)) {
      const childSessionId = source.ref.path.slice(childPrefix.length).split('/')[0]
      check(/^child-[a-f0-9-]+$/.test(childSessionId) && receipt.sessionId === childSessionId
        && /^child-[a-f0-9-]+$/.test(receipt.executionId ?? '')
        && (!receipt.input || receipt.scenarioId === task.scenarioId), 'foreign_child_hook_receipt')
      childHooks.push({ ...source.ref, executionId: receipt.executionId, sessionId: receipt.sessionId,
        checkpoint: receipt.input?.checkpoint ?? 'initialized' })
      continue
    }
    check(source.ref.path.startsWith(`${portable(session.workspaceDir)}/plugin-runtime/`), 'foreign_hook_path')
    check(receipt.executionId === task.executionId && receipt.sessionId === session.sessionId, 'foreign_hook_receipt')
    if (!receipt.input) continue // Initialization is not an actor transcript.
    check(receipt.scenarioId === task.scenarioId && Number.isSafeInteger(receipt.sequence), 'foreign_hook_receipt')
    check(Array.isArray(receipt.input.messages), 'invalid_hook_messages')
    const row = { ...source.ref, sequence: receipt.sequence, checkpoint: receipt.input.checkpoint }
    hooks.push(row)
    if (!last || receipt.sequence > last.sequence) last = { ...row, messageCount: receipt.input.messages.length,
      assistantMessageCount: receipt.input.messages.filter(message => message.role === 'assistant').length,
      assistantVisibleTextCount: receipt.input.messages.filter(message => message.role === 'assistant'
        && typeof message.content === 'string' && message.content.trim()).length }
    if (['before_tool', 'after_tool'].includes(receipt.input.checkpoint) && receipt.input.action) {
      const { id, name, canonicalName, effect } = receipt.input.action
      actions.push({ source: row, action: { id, name, canonicalName, effect },
        argumentsSource: row, outcome: receipt.input.outcome ? Object.fromEntries(
          ['status', 'complete', 'executed', 'resultHash'].filter(key => Object.hasOwn(receipt.input.outcome, key))
            .map(key => [key, receipt.input.outcome[key]])) : null, decision: receipt.decision ?? null })
    }
  }
  hooks.sort((a, b) => a.sequence - b.sequence)
  actions.sort((a, b) => a.source.sequence - b.source.sequence)
  const diagnostics = { verified: false, reason: 'missing_attestation', hookFiles: [], issues: [] }
  if (!last) {
    // Preserve forensic locations even when the runtime could not seal its
    // receipts. These observed hashes never upgrade a grade or official row.
    try {
      const directory = pathInside(root, runRoot, `${session.workspaceDir}/plugin-runtime`)
      if (existsSync(directory)) for (const name of readdirSync(directory).sort()) {
        if (!name.endsWith('.json')) continue
        const path = `${portable(session.workspaceDir)}/plugin-runtime/${name}`
        const target = pathInside(root, runRoot, path)
        check(lstatSync(target).isFile(), 'diagnostic_not_regular_file')
        diagnostics.hookFiles.push({ path, sha256: hash(readFileSync(target)) })
      }
    } catch (error) { diagnostics.issues.push(String(error.message)) }
  }
  return { availability: last ? 'recorded_hook_inputs' : diagnostics.hookFiles.length
    ? 'unsealed_diagnostic_files_only' : 'missing_runtime_evidence_receipts',
    evidenceScope: 'state_bound_result_and_matching_file_hashes_not_an_independent_runtime_audit',
    hiddenReasoningCaptured: false, hookEvidence: hooks, toolActions: actions,
    childHookEvidence: childHooks,
    unsealedDiagnostics: last ? null : diagnostics,
    transcriptSource: last ? Object.fromEntries(['path', 'sha256', 'sequence', 'checkpoint'].map(key => [key, last[key]])) : null,
    // Full visible text and tool results stay in the original hash-addressed
    // files instead of being multiplied into a 3360-execution summary.
    messageCount: last?.messageCount ?? null, assistantMessageCount: last?.assistantMessageCount ?? null,
    assistantVisibleTextCount: last?.assistantVisibleTextCount ?? null }
}

/** Offline, derived progress/index only. It never repairs state or grades a task. */
export function buildOfficialCampaignSummary({ root = ROOT, manifestPath } = {}) {
  root = resolve(root)
  if (isAbsolute(manifestPath ?? '')) manifestPath = portable(relative(root, manifestPath))
  const manifestSource = readSource(root, root, manifestPath), manifest = manifestSource.value
  const { manifestHash, ...contents } = manifest
  check(manifest.schemaVersion === 'gaia2-run-manifest-v1' && manifestHash === digest(contents)
    && typeof manifest.runId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(manifest.runId)
    && portable(manifest.runRoot) === `runs/${manifest.runId}` && portable(manifest.stateFile) === `${portable(manifest.runRoot)}/run-state.json`
    && manifestSource.ref.path === `${portable(manifest.runRoot)}/run-manifest.json` && Array.isArray(manifest.tasks), 'manifest_binding_invalid')
  const runRoot = resolve(root, portable(manifest.runRoot)), statePath = pathInside(root, runRoot, manifest.stateFile)
  const stateSource = existsSync(statePath) ? readSource(root, runRoot, manifest.stateFile) : null
  const state = stateSource?.value ?? null
  const ids = manifest.tasks.map(task => task.executionId)
  check(new Set(ids).size === ids.length, 'duplicate_planned_execution')
  if (state) {
    check(state.schemaVersion === 'gaia2-run-state-v1' && state.runId === manifest.runId
      && state.manifestHash === manifestHash && Array.isArray(state.tasks)
      && digest(state.tasks.map(task => task.executionId)) === digest(ids), 'state_binding_invalid')
    const runtime = readSource(root, runRoot, `${manifest.runRoot}/runtime-settings.json`)
    check(digest(runtime.value) === state.runtimeHash, 'runtime_binding_invalid')
  }
  const capabilityCandidates = new Map()
  for (const task of manifest.tasks) if (task.phase === 'standard' && HASH.test(task.scenarioHash ?? '')) {
    const key = `${task.scenarioId}:${task.scenarioHash}`
    if (!capabilityCandidates.has(key)) capabilityCandidates.set(key, new Set())
    capabilityCandidates.get(key).add(task.config)
  }
  const byPhase = {}, byCapability = {}, byError = {}, issues = [], rows = []
  for (let index = 0; index < manifest.tasks.length; index++) {
    const task = manifest.tasks[index], record = state?.tasks[index] ?? { status: 'pending', sessions: [] }
    const candidates = capabilityCandidates.get(`${task.scenarioId}:${task.scenarioHash}`)
    const row = { executionId: task.executionId, scenarioId: task.scenarioId, runNumber: task.runNumber,
      phase: task.phase, config: task.config, capability: task.phase === 'standard' ? task.config
        : candidates?.size === 1 ? [...candidates][0] : null,
      status: record.status, outcome: record.status, sessionCount: record.sessions?.length ?? 0,
      currentSessionEndedAt: record.sessions?.at(-1)?.endedAt ?? null,
      evaluationComplete: false, businessPassed: null, score: null, failure: record.failure ?? null,
      sources: { result: null, artifacts: [] }, analysis: null, issues: [] }
    try {
      check(STATUSES.has(record.status) && Array.isArray(record.sessions), 'invalid_task_state')
      if (['completed', 'terminal_failure', 'retry_pending'].includes(record.status)) {
        const session = record.sessions.at(-1)
        check(session && portable(record.resultPath) === `${portable(session.workspaceDir)}/task-result.json`
          && HASH.test(record.resultSha256 ?? ''), 'result_reference_missing_or_wrong_session')
        for (const key of ['outputDir', 'workspaceDir', 'fixtureDir']) {
          check(portable(session[key]) === `${portable(task[key])}/sessions/${session.sessionId}`, 'session_path_mismatch')
          pathInside(root, runRoot, session[key])
        }
        const source = readSource(root, runRoot, record.resultPath, record.resultSha256), result = source.value
        check(result.schemaVersion === 'gaia2-task-result-v1' && result.runId === manifest.runId
          && result.manifestHash === manifestHash && result.runtimeHash === state.runtimeHash
          && result.sessionId === session.sessionId
          && ['executionId', 'scenarioId', 'runNumber', 'phase', 'config'].every(key => result[key] === task[key]), 'result_identity_invalid')
        check(record.status === 'completed'
          ? result.evaluationComplete === true && typeof result.businessPassed === 'boolean'
            && result.score === (result.businessPassed ? 1 : 0)
          : result.evaluationComplete === false && result.businessPassed === null && result.score === null,
        'result_judgment_invalid')
        row.sources.result = source.ref
        row.evaluationComplete = result.evaluationComplete
        row.businessPassed = result.businessPassed
        row.score = result.score
        row.failure = result.failure ?? record.failure ?? null
        row.outcome = record.status === 'completed' ? result.businessPassed ? 'business_success' : 'business_failure'
          : record.status === 'terminal_failure' ? 'technical_failure' : 'retry_pending'
        for (const ref of result.artifacts ?? []) row.sources.artifacts.push(readSource(root, runRoot, ref.path, ref.sha256, false).ref)
        row.analysis = analysisIndex(root, runRoot, task, session, result)
      }
    } catch (error) {
      // Corruption is an evidence gap, not a fabricated technical task score.
      row.outcome = 'unverified'; row.evaluationComplete = false; row.businessPassed = null; row.score = null
      row.issues.push(String(error.message)); issues.push({ executionId: task.executionId, code: String(error.message) })
    }
    increment(byPhase, task.phase, row.outcome)
    increment(byCapability, `${task.phase}:${row.capability ?? 'unrecorded'}`, row.outcome)
    if (row.failure) {
      const codes = new Set([row.failure.errorCode, row.failure.code,
        ...(row.failure.diagnostic?.causes ?? []).map(cause => cause.code)].filter(code => typeof code === 'string'))
      if (!codes.size) codes.add('unrecorded')
      for (const code of codes) {
        const key = `${row.failure.category ?? 'unrecorded'}:${code}`
        byError[key] = (byError[key] ?? 0) + 1
      }
    }
    rows.push(row)
  }
  const totals = fresh()
  for (const row of rows) { totals.planned++; totals[row.outcome]++ }
  const judged = totals.business_success + totals.business_failure
  const snapshotStable = stateSource ? hash(readFileSync(statePath)) === stateSource.ref.sha256 : !existsSync(statePath)
  return { schemaVersion: SCHEMA, runId: manifest.runId, manifestHash,
    status: issues.length ? 'evidence_gaps' : snapshotStable ? 'summarized' : 'snapshot_changed', snapshotStable,
    sources: { manifest: manifestSource.ref, state: stateSource?.ref ?? null }, totals, byPhase, byCapability, byError,
    judgedSuccessRate: judged ? totals.business_success / judged : null,
    allPlannedExecutionsAttempted: rows.every(row => row.sessionCount > 0 && !['pending', 'running'].includes(row.status)
      && Number.isFinite(Date.parse(row.currentSessionEndedAt))),
    allPlannedExecutionsJudged: judged === totals.planned,
    rows, issues, tokenAccounting: 'use_phase6_budget_report_unknown_usage_must_remain_unknown',
    sourceStateChanged: false, noModelExecution: true, officialSubmissionReady: false, generatedAt: new Date().toISOString() }
}

export function writeOfficialCampaignSummary({ root = ROOT, outputPath, report }) {
  root = resolve(root)
  const target = pathInside(root, root, isAbsolute(outputPath) ? portable(relative(root, outputPath)) : outputPath)
  if (existsSync(target)) check(JSON.parse(readFileSync(target, 'utf8')).schemaVersion === SCHEMA, 'refuse_to_overwrite_source')
  mkdirSync(dirname(target), { recursive: true })
  const temporary = join(dirname(target), `.campaign-summary-${randomUUID()}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  renameSync(temporary, target)
  return target
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {}
    for (let i = 2; i < process.argv.length; i += 2) {
      const flag = process.argv[i], value = process.argv[i + 1]
      check(['--manifest', '--output'].includes(flag) && value && !value.startsWith('--') && !options[flag], 'invalid_arguments')
      options[flag] = value
    }
    check(options['--manifest'], 'manifest_required')
    const report = buildOfficialCampaignSummary({ manifestPath: options['--manifest'] })
    const output = writeOfficialCampaignSummary({ outputPath: options['--output'] ?? `runs/${report.runId}/campaign-summary.json`, report })
    console.log(JSON.stringify({ schemaVersion: SCHEMA, status: report.status, totals: report.totals,
      output: portable(relative(ROOT, output)), noModelExecution: true }, null, 2))
    if (report.issues.length) process.exitCode = 2
  } catch (error) {
    console.error(JSON.stringify({ schemaVersion: SCHEMA, status: 'rejected',
      code: /^[a-z_]+$/.test(error.message) ? error.message : 'source_read_failed', noModelExecution: true }))
    process.exitCode = 2
  }
}
