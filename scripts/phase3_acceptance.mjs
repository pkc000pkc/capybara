import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { auditPhase0, validateRunManifest } from '../src/phase0_audit.mjs'
import { digest, fileDigest, loadRunInputs, readJson, within, writeJson } from '../src/phase0_run.mjs'
import { readNativeResult } from '../src/phase1_official.mjs'
import { auditSubmissionPackage } from '../src/phase2_audit.mjs'
import { runOfficialConversion } from '../src/phase2_export.mjs'
import { pythonEventHash, validateRuntimeEvidence } from '../src/phase3_runtime_evidence.mjs'

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const configs = ['execution', 'search', 'adaptability', 'time', 'ambiguity']
const portable = path => path.replaceAll('\\', '/')
const hash = text => createHash('sha256').update(text).digest('hex')
function check(condition, code) { assert.ok(condition, `Phase 3 acceptance: ${code}`) }
function safeFile(root, value, parent = root) {
  check(typeof value === 'string' && value && !value.includes('\0'), 'invalid file path')
  const path = resolve(root, value)
  check(within(parent, path) && path !== resolve(parent), 'file escapes evidence root')
  for (let at = path; ; at = dirname(at)) { check(!lstatSync(at).isSymbolicLink(), 'symbolic evidence path'); if (at === dirname(at)) break }
  check(lstatSync(path).isFile(), 'evidence is not a regular file'); return path
}
function sourceFile(root, value, parent = root) {
  check(typeof value === 'string' && !isAbsolute(value) && !win32.isAbsolute(value) && !portable(value).split('/').some(part => ['..', '.', ''].includes(part)), 'unsafe source identity')
  return safeFile(root, value, parent)
}
function safeNewPath(root, path) {
  check(within(root, path) && !existsSync(path), 'report must be a new workspace path')
  for (let at = dirname(path); ; at = dirname(at)) {
    if (existsSync(at)) check(lstatSync(at).isDirectory() && !lstatSync(at).isSymbolicLink(), 'unsafe report ancestor')
    if (at === dirname(at)) break
  }
}
const lines = path => readFileSync(path, 'utf8').split(/\r?\n/).filter(line => line.trim()).map(JSON.parse)
const healthy = value => value?.schemaVersion === 'gaia2-process-result-v1' && value.exitCode === 0 && value.childExited === true && value.childClosed === true && !value.signal && !value.timedOut && !value.interrupted && !value.spawnError && !value.loggingError && !value.heartbeatError && !value.manualInspectionRequired && Array.isArray(value.terminationErrors) && value.terminationErrors.length === 0 && Number.isFinite(Date.parse(value.finishedAt))
const ref = (root, path) => ({ path: portable(relative(root, path)), sha256: fileDigest(path) })
function checkedRef(root, value, parent = root) { check(value && /^[0-9a-f]{64}$/.test(value.sha256 ?? ''), 'invalid evidence reference'); const path = safeFile(root, value.path, parent); check(fileDigest(path) === value.sha256, 'evidence SHA differs'); return path }

export function readPassingJUnit(path, { minimum = 1, exact = null } = {}) {
  const xml = readFileSync(path, 'utf8')
  check(/<testsuites(?:\s[^>]*)?>/.test(xml) && /<\/testsuites>\s*$/.test(xml), 'incomplete JUnit document')
  const count = tag => [...xml.matchAll(new RegExp(`<${tag}\\b`, 'g'))].length
  const tests = { tests: count('testcase'), failures: count('failure'), errors: count('error'), skipped: count('skipped') }
  const summary = Object.fromEntries([...xml.matchAll(/<!--\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s+-->/g)].map(match => [match[1], Number(match[2])]))
  check(tests.tests >= minimum && (exact === null || tests.tests === exact), 'JUnit test count differs')
  check(summary.tests === tests.tests && summary.pass === tests.tests, 'JUnit success summary differs')
  for (const key of ['failures', 'errors', 'skipped']) check(tests[key] === 0, `JUnit ${key}`)
  for (const key of ['fail', 'cancelled', 'skipped', 'todo']) check(summary[key] === 0, `JUnit ${key}`)
  return tests
}

export function assertStage3Plan(manifest) {
  check(manifest?.schemaVersion === 'gaia2-run-manifest-v1' && manifest.syntheticFixtureOnly !== true && manifest.mode === 'internal_pass5' && manifest.dataset?.kind === 'source' && manifest.executionBinding === 'phase3_live_plugin_host_required', 'not a production source Stage 3 plan')
  check(manifest.policy?.initialRunsPerScenario === 5 && manifest.policy.maxCorrections === 0 && manifest.selection?.expectedInitialExecutions === 25 && manifest.selection.perCapability === 1 && manifest.selection.fullOfficialCoverage === false && manifest.tasks?.length === 25, 'complete 25-task plan changed')
  const selected = manifest.tasks.filter(task => task.runNumber === 1), ids = new Set()
  for (const config of configs) {
    const tasks = manifest.tasks.filter(task => task.config === config)
    check(tasks.length === 5 && new Set(tasks.map(task => task.scenarioId)).size === 1 && digest(tasks.map(task => task.runNumber).sort()) === digest([1, 2, 3, 4, 5]), 'capability attempt plan changed')
  }
  for (const task of manifest.tasks) { check(task.phase === 'standard' && configs.includes(task.config) && task.attemptIndex === task.runNumber && task.correctionOrdinal === 0 && !ids.has(task.executionId), 'task identity/correction changed'); ids.add(task.executionId) }
  check(selected.length === 5, 'five original samples required'); return selected
}

export function verifySelectedRun({ root, manifest }) {
  const selected = assertStage3Plan(manifest), runRoot = resolve(root, manifest.runRoot)
  const statePath = sourceFile(root, manifest.stateFile, runRoot), state = readJson(statePath)
  const runtimePath = safeFile(root, join(manifest.runRoot, 'runtime-settings.json'), runRoot), runtime = readJson(runtimePath)
  check(state.schemaVersion === 'gaia2-run-state-v1' && state.runId === manifest.runId && state.manifestHash === manifest.manifestHash && state.runtimeHash === digest(runtime), 'state/runtime binding changed')
  check(digest(state.tasks?.map(task => task.executionId)) === digest(manifest.tasks.map(task => task.executionId)), 'state task set/order changed')
  const outcomes = []
  for (const task of manifest.tasks) {
    const record = state.tasks.find(item => item.executionId === task.executionId)
    if (task.runNumber !== 1) { check(record.status === 'pending' && record.sessions?.length === 0 && record.resultPath === null && record.resultSha256 === null && record.failure === null, 'unselected attempt was used'); continue }
    check(record.status === 'completed' && Array.isArray(record.sessions) && record.sessions.length > 0, 'selected original sample not evaluated')
    for (const [index, session] of record.sessions.entries()) {
      check(/^\d{4}-[0-9a-f-]{12}$/.test(session.sessionId) && session.sessionOrdinal === index + 1 && session.parentSessionId === (record.sessions[index - 1]?.sessionId ?? null), 'session lineage changed')
      for (const key of ['outputDir', 'fixtureDir', 'workspaceDir']) check(portable(session[key]) === `${portable(task[key])}/sessions/${session.sessionId}`, 'session path changed')
    }
    const session = record.sessions.at(-1)
    check(portable(record.resultPath) === `${portable(session.workspaceDir)}/task-result.json`, 'result path changed')
    const resultPath = sourceFile(root, record.resultPath, resolve(root, session.workspaceDir)), result = readJson(resultPath)
    check(fileDigest(resultPath) === record.resultSha256 && result.schemaVersion === 'gaia2-task-result-v1' && result.runId === manifest.runId && result.manifestHash === manifest.manifestHash && result.runtimeHash === state.runtimeHash && result.sessionId === session.sessionId, 'task result provenance changed')
    for (const field of ['executionId', 'phase', 'config', 'scenarioId', 'runNumber']) check(result[field] === task[field], 'task result identity changed')
    check(result.evaluationComplete === true && typeof result.businessPassed === 'boolean' && result.score === (result.businessPassed ? 1 : 0) && (result.businessPassed ? result.failure === null : result.failure?.category === 'business_failure' && result.failure.retryable === false), 'technical failure cannot count as judged')
    const process = readJson(safeFile(root, join(session.outputDir, 'process-result.json'), resolve(root, session.outputDir)))
    check(healthy(process) && result.process?.exitCode === 0 && !result.process.signal && !result.process.timedOut && !result.process.interrupted, 'official child did not close healthy')
    check(Array.isArray(result.artifacts) && result.artifacts.length === 2, 'native artifacts must remain exactly two')
    for (const artifact of result.artifacts) checkedRef(root, artifact, resolve(root, session.outputDir))
    const events = lines(safeFile(root, join(session.outputDir, 'runtime-events.jsonl'), resolve(root, session.outputDir)))
    const native = readNativeResult({ root, outputDir: session.outputDir, task, session, events })
    check(native.report.evaluationComplete && native.report.businessPassed === result.businessPassed && digest(native.artifacts) === digest(result.artifacts), 'native judgment/artifact differs')
    const trace = readJson(sourceFile(root, result.artifacts[1].path, resolve(root, session.outputDir)))
    for (const key of ['world_logs', 'apps', 'events', 'completed_events']) check(Array.isArray(trace[key]), 'incomplete native Trace')
    check(typeof trace.version === 'string' && Object.hasOwn(trace, 'context') && Object.hasOwn(trace, 'augmentation'), 'incomplete Trace envelope')
    check(result.runtimeEvidenceRequired === true && result.realHooksReady === true, 'production hooks were not required/ready')
    const hooks = validateRuntimeEvidence({ manifest, task, session, events, runtimeAttestation: result.runtimeAttestation, runtimeEvidence: result.runtimeEvidence, readEvidence: path => readFileSync(sourceFile(root, path, runRoot)) })
    check(hooks.realHooksReady === true && hooks.trainingHooksExecuted === false, 'real runtime proof failed')
    outcomes.push({ executionId: task.executionId, config: task.config, scenarioId: task.scenarioId, runNumber: 1, sessionId: session.sessionId, score: result.score, businessPassed: result.businessPassed, result: ref(root, resultPath), nativeArtifacts: result.artifacts, runtimeAttestation: result.runtimeAttestation, runtimeEvidence: result.runtimeEvidence, hooks })
  }
  const batch = readJson(safeFile(root, join(manifest.runRoot, 'batch-report.json'), runRoot)), heartbeat = readJson(safeFile(root, join(manifest.runRoot, 'batch-heartbeat.json'), runRoot))
  check(batch.runId === manifest.runId && batch.manifestHash === manifest.manifestHash && batch.runtimeHash === state.runtimeHash && batch.status === 'incomplete' && batch.onlyRunNumber === 1 && batch.plannedInitialExecutions === 25 && batch.evaluatedInitialExecutions === 5 && batch.selectedExecutions === 5 && batch.selectedCompleted === 5 && batch.selectedEvaluationComplete === true && batch.selectedRealHooksReady === true && batch.realHooksReady === false && batch.officialSubmissionReady === false && batch.counts?.pending === 20 && batch.counts.completed === 5 && batch.counts.running === 0 && batch.counts.retry_pending === 0 && !batch.batchHeartbeatError, 'batch scope/completion overclaimed')
  check(heartbeat.runId === manifest.runId && heartbeat.manifestHash === manifest.manifestHash && heartbeat.terminal === true && heartbeat.status === 'incomplete', 'batch is not in an observed terminal state')
  return { outcomes, state: ref(root, statePath), runtime: ref(root, runtimePath), batch: ref(root, join(runRoot, 'batch-report.json')), selectedInitialExecutions: selected.length, untouchedPendingExecutions: 20, businessSuccesses: outcomes.filter(item => item.businessPassed).length, businessFailures: outcomes.filter(item => !item.businessPassed).length }
}

function inspectActorInputs({ actors, events, calls }) {
  const injections = events.filter(event => event.type === 'dynamic_context_injected')
  check(actors.length > 0 && actors.length === injections.length, 'controlled Actor evidence missing')
  for (const [index, actor] of actors.entries()) {
    const before = calls.findLast(item => item.input.checkpoint === 'before_model' && item.input.loop?.iteration === index && item.revision === actor.hookRevision && item.contextHash === actor.contextHash)
    check(before && actor.context === before.context && actor.messages?.[1]?.role === 'system' && actor.messages[1].content === `Live Capybara dynamic context:\n${before.context}` && hash(actor.context) === actor.contextHash && injections[index].contextHash === actor.contextHash && pythonEventHash(actor.messages) === injections[index].actorInputHash, 'observed Actor context/hash mismatch')
    check(before.variables.gaia2_clock_state?.authority === 'ARE' && before.variables.gaia2_clock_state.now === before.input.clock?.now, 'Actor clock is not ARE authoritative')
    check(!/HIDDEN_ORACLE_SENTINEL_8DD72D|FUTURE_NOT_YET_VISIBLE_70FA12/.test(JSON.stringify(actor.messages)), 'sealed/future input reached Actor')
  }
}

export function verifyControlledEvidence({ root, controlled, backendRoot, capabilities }) {
  check(controlled?.schemaVersion === 'gaia2-phase3-controlled-validation-v1' && controlled.status === 'passed' && controlled.syntheticFixtureOnly === true && controlled.realModelCalls === 0 && controlled.benchmarkExecuted === false && controlled.externalNetworkUsed === false && controlled.uploaded === false && controlled.officialSubmissionReady === false, 'controlled scope overclaimed')
  const expectedSources = ['scripts/capybara_official_bridge.py', 'scripts/gaia2_runtime_hooks.py', 'scripts/phase3_controlled_fixture.py', 'scripts/phase3_controlled_validation.mjs', 'scripts/phase3_hook_server.ts', 'src/phase3_hook_service.mjs', 'src/phase3_runtime_evidence.mjs', portable(join(backendRoot, 'src/core/plugins/runtime-plugin-host.ts'))]
  check(Array.isArray(controlled.sourceBindings) && digest(controlled.sourceBindings.map(item => item.path).sort()) === digest(expectedSources.sort()), 'controlled source coverage changed')
  for (const item of controlled.sourceBindings) checkedRef(root, item, isAbsolute(item.path) ? backendRoot : root)
  check(controlled.cases?.length === 5 && digest(controlled.cases.map(item => item.case).sort()) === digest(['dynamic', 'unknown', 'unverified_evidence', 'wait', 'hook_failure'].sort()), 'controlled cases missing/duplicated')
  const summaries = []
  for (const item of controlled.cases) {
    check(item.status === 'passed' && item.realHost === true && item.trainingHooksExecuted === false && Array.isArray(item.artifacts), 'controlled Host evidence missing')
    const artifactMap = new Map()
    for (const artifact of item.artifacts) { checkedRef(root, artifact); check(!artifactMap.has(artifact.path) || artifactMap.get(artifact.path) === artifact.sha256, 'controlled duplicate binding differs'); artifactMap.set(artifact.path, artifact.sha256) }
    const find = suffix => { const paths = [...artifactMap.keys()].filter(path => portable(path).endsWith(suffix)); check(paths.length === 1, `controlled ${suffix} missing/duplicated`); return sourceFile(root, paths[0]) }
    const fixture = readJson(find('/fixture-report.json')), actors = readJson(find('/actor-inputs.json')), events = lines(find('/runtime-events.jsonl'))
    check(fixture.executionId === item.executionId && fixture.sessionId === item.sessionId && fixture.case === item.case && fixture.status === 'passed' && fixture.syntheticFixtureOnly === true && fixture.realModelCalls === 0 && fixture.benchmarkExecuted === false && fixture.externalNetworkAttempts === 0 && fixture.fakeActorRequests === actors.length, 'controlled fixture identity/scope differs')
    check(events.every(event => event.executionId === item.executionId && event.sessionId === item.sessionId), 'controlled foreign event')
    check(healthy(readJson(find('/actor-process/process-result.json'))) && healthy(readJson(find('/hook-host/process-result.json'))), 'controlled processes unhealthy')
    const calls = [...artifactMap.keys()].filter(path => path.includes('/plugin-runtime/')).map(path => readJson(sourceFile(root, path))).filter(value => value.schemaVersion === 'capybara-runtime-plugin-invocation-v1').sort((a, b) => a.sequence - b.sequence)
    check(calls.length > 0 && calls.every(call => call.executionId === item.executionId && call.sessionId === item.sessionId && !['after_evaluation', 'after_replay'].includes(call.input?.checkpoint)), 'controlled invocation identity/training differs')
    inspectActorInputs({ actors, events, calls })
    if (item.case === 'hook_failure') {
      check(item.intentionallyFaultedHook === true && item.trackedPluginProfile === false && item.productionAttestationVerified === false && item.productionRuntimeEvidence === undefined && item.productionAttestationExcludedReason === 'intentionally_faulted_after_tool_hook', 'fault profile included as production evidence')
      check(fixture.expectedTechnicalFailure === 'after_tool_rejected' && fixture.validationCalls === 0 && actors.length === 1 && !events.some(event => event.type === 'official_validation_completed') && calls.some(call => call.input.checkpoint === 'after_tool' && call.decision.action === 'block' && call.hookReceipts.some(hook => hook.status === 'failed')), 'fault did not block evaluation/continuation')
      summaries.push({ case: item.case, excludedFromProduction: true, controlledActorInputHashReconstructed: true }); continue
    }
    check(item.trackedPluginProfile === true && item.intentionallyFaultedHook === false && item.productionAttestationVerified === true && fixture.validationCalls === 1 && fixture.expectedTechnicalFailure === null, 'normal controlled case not valid')
    const proof = readJson(checkedRef(root, item.productionRuntimeEvidence)), capturedCapabilities = readJson(checkedRef(root, item.capabilities))
    check(proof.manifest.syntheticFixtureOnly === true && proof.task.executionId === item.executionId && proof.session.sessionId === item.sessionId && proof.manifest.manifestHash === digest(Object.fromEntries(Object.entries(proof.manifest).filter(([key]) => key !== 'manifestHash'))), 'controlled proof manifest differs')
    check(digest(capturedCapabilities.plugins.map(plugin => ({ id: plugin.id, files: plugin.files }))) === digest(capabilities.plugins.map(plugin => ({ id: plugin.id, files: plugin.files }))), 'controlled plugins differ from production frozen sources')
    const verified = validateRuntimeEvidence({ ...proof, events, readEvidence: path => readFileSync(sourceFile(root, path)) })
    check(verified.realHooksReady === false && verified.trainingHooksExecuted === false, 'synthetic controlled readiness overclaimed')
    const blocked = id => events.some(event => event.type === 'tool_call_blocked' && event.callId === id)
    const after = id => calls.find(call => call.input.checkpoint === 'after_tool' && call.input.action?.id === id)
    if (item.case === 'dynamic') check(blocked('dynamic-old') && !after('dynamic-old') && fixture.callbackCounts.write === 1 && actors[0].contextHash !== actors[1].contextHash, 'dynamic stale action was executed')
    if (item.case === 'unknown') check(blocked('unknown-retry') && blocked('unknown-after-read') && !after('unknown-retry') && !after('unknown-after-read') && fixture.callbackCounts.write === 1 && fixture.callbackCounts.read === 1 && after('unknown-readback')?.variables.gaia2_write_state.unknown.some(entry => entry.readBackObserved === true), 'unknown write was replayed/lost')
    if (item.case === 'unverified_evidence') check(blocked('unverified-write') && !after('unverified-write') && fixture.callbackCounts.write === 0 && after('unverified-fresh-read')?.variables.gaia2_observation_state.unverified_ids.length === 0, 'unverified evidence authorized a mutation')
    if (item.case === 'wait') check(after('official-wait')?.input.action.canonicalName === 'SystemApp__wait_for_notification' && fixture.officialClockAtEnd >= 1010 && actors[1].messages.some(message => message.role === 'user' && message.content.includes('UPDATED request')), 'official wait did not advance/consume notification')
    summaries.push({ case: item.case, ...verified, productionAttestationVerified: true, controlledActorInputHashReconstructed: true })
  }
  return { normalCases: 4, excludedFaultCases: 1, sourceBindings: controlled.sourceBindings, cases: summaries }
}

export function assertPartialAudit(audit) {
  check(audit?.format_valid === true && audit.coverage_complete === false && audit.evaluation_complete === false && audit.officialSubmissionReady === false && audit.realHooksReady === false && audit.officialCheckPassed === true, 'partial package scope/format overclaimed or invalid')
  for (const [field, expected] of Object.entries({ targetCount: 25, rowCount: 5, uniqueRowCount: 5, missingRows: 20, duplicateRows: 0, unknownRows: 0, evaluatedRows: 5, provenanceValidRows: 5, runtimeAttestedRows: 5, realHookRows: 5, technicalCount: 0, officialReconstructedCount: 5 })) check(audit.metrics?.[field] === expected, `partial ${field} differs`)
  check(audit.metrics.successCount + audit.metrics.businessFailureCount === 5, 'partial judged count differs')
  check(audit.issues.every(issue => issue.gate === 'coverage' && ['missing_execution_key', 'target_coverage_count_mismatch'].includes(issue.code)), 'partial has unrelated evidence defects')
  return audit
}

export async function verifyPartialSubmission({ root, packageRoot, manifestPath, manifest, selectedRun, diagnosticsRoot }) {
  const sidecar = readJson(safeFile(packageRoot, 'export-manifest.json'))
  check(fileDigest(safeFile(packageRoot, 'run-manifest.json')) === fileDigest(manifestPath) && sidecar.syntheticFixtureOnly === false && sidecar.evidenceKind === 'native_runtime' && sidecar.records?.length === 5 && sidecar.missing?.length === 20, 'partial export manifest scope differs')
  check(digest(sidecar.records.map(item => item.executionId).sort()) === digest(selectedRun.outcomes.map(item => item.executionId).sort()), 'exported task set differs')
  for (const outcome of selectedRun.outcomes) check(sidecar.records.find(item => item.executionId === outcome.executionId)?.result.sha256 === outcome.result.sha256, 'export result differs from original judged task')
  const officialCheck = await runOfficialConversion({ root, operation: 'check', spec: { packageRoot, model: manifest.models.actor.model, provider: manifest.models.actor.provider }, diagnosticsRoot })
  check(officialCheck.status === 'passed' && officialCheck.processHealthy === true && officialCheck.reconstructedCount === 5 && officialCheck.technicalCount === 0 && officialCheck.hfSchemaValid === true && typeof officialCheck.hfRowsPath === 'string', 'official local reconstruction failed')
  const schemaPaths = officialCheck.artifactPaths?.filter(path => path.endsWith('/hf-schema.json')) ?? []
  check(schemaPaths.length === 1, 'official HF schema artifact missing/duplicated')
  const schema = readJson(sourceFile(packageRoot, schemaPaths[0]))
  const columns = ['scenario_id', 'run_number', 'task_id', 'score', 'status', 'data', 'run_type', 'config', 'phase_name', 'a2a_app_prop', 'has_app_noise', 'has_env_noise', 'run_config', 'has_exception', 'exception_type', 'exception_message', 'rationale']
  check(schema.fields?.length === 17 && digest(schema.fields.map(field => field.name).sort()) === digest(columns.sort()), 'official HF 17-column schema differs')
  const audit = assertPartialAudit(auditSubmissionPackage({ packageRoot, officialCheck }))
  return { packageRoot: portable(relative(root, packageRoot)), exportManifest: ref(root, join(packageRoot, 'export-manifest.json')), officialCheck, audit }
}

function diagnosticPilot(root, path, currentRunId) {
  const document = readJson(safeFile(root, path)), resultRefs = []
  if (document.schemaVersion === 'gaia2-task-result-v1') resultRefs.push(ref(root, path))
  else {
    check(document.schemaVersion === 'gaia2-run-manifest-v1' && document.runId !== currentRunId, 'first pilot must be a separate failed run')
    const state = readJson(sourceFile(root, document.stateFile))
    for (const record of state.tasks) if (record.resultPath) resultRefs.push({ path: record.resultPath, sha256: record.resultSha256 })
  }
  check(resultRefs.length === 1, 'first pilot must contain one technical failure')
  const result = readJson(checkedRef(root, resultRefs[0]))
  check(result.runId !== currentRunId && result.evaluationComplete === false && result.score === null && result.businessPassed === null && result.failure?.category && result.failure.category !== 'business_failure' && result.realHooksReady !== true, 'pilot technical failure was counted as a grade')
  return { evidence: ref(root, path), taskResult: resultRefs[0], runId: result.runId, category: result.failure.category, countedInStage3Results: false, score: null }
}

export async function runPhase3Acceptance({ root = defaultRoot, argv = process.argv.slice(2) } = {}) {
  root = resolve(root)
  const values = {}, options = ['--manifest', '--controlled', '--test-report', '--backend-test-report', '--export-report', '--package', '--report', '--first-pilot']
  for (let i = 0; i < argv.length; i += 2) { check(options.includes(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--') && !values[argv[i]], 'invalid/duplicate CLI arguments'); values[argv[i]] = resolve(root, argv[i + 1]) }
  for (const key of ['--manifest', '--controlled', '--test-report', '--backend-test-report', '--report']) check(values[key], `missing ${key}`)
  check(Boolean(values['--export-report']) !== Boolean(values['--package']), 'choose one export report or package')
  const reportPath = values['--report']; safeNewPath(root, reportPath)
  const manifestPath = safeFile(root, values['--manifest']), manifest = readJson(manifestPath), inputs = loadRunInputs(root)
  check(validateRunManifest(root, manifest, inputs, {}).length === 0, 'frozen production plan validation failed')
  const environmentAudit = await auditPhase0(root, { manifest, deep: false, env: {} })
  check(environmentAudit.phase0Passed === true, 'current code/dependencies/data differ from frozen execution environment')
  const selectedRun = verifySelectedRun({ root, manifest })
  const controlledPath = safeFile(root, values['--controlled']), controlled = verifyControlledEvidence({ root, controlled: readJson(controlledPath), backendRoot: inputs.protocol.runtime.backendRoot, capabilities: inputs.capabilities })
  const projectTests = readPassingJUnit(safeFile(root, values['--test-report']), { minimum: 135 }), backendTests = readPassingJUnit(safeFile(root, values['--backend-test-report']), { exact: 92 })
  const exported = values['--export-report'] ? readJson(safeFile(root, values['--export-report'])) : null
  if (exported) check(exported.schemaVersion === 'gaia2-phase2-export-report-v1' && exported.sourceRunId === manifest.runId && exported.exportedRows === 5 && exported.missingExecutions === 20 && exported.syntheticFixtureOnly === false && exported.noModelExecution === true, 'export report scope changed')
  const packageRoot = resolve(root, values['--package'] ?? exported.packageRoot)
  check(within(root, packageRoot), 'package escapes workspace')
  const partial = await verifyPartialSubmission({ root, packageRoot, manifestPath, manifest, selectedRun, diagnosticsRoot: join(dirname(reportPath), `phase3-acceptance-official-${randomUUID()}`) })
  const report = { schemaVersion: 'gaia2-phase3-acceptance-v1', status: 'passed', phase3Passed: true, scope: 'five_capabilities_one_original_task_run_number_1_with_live_runtime_hooks', completePass5: false, fullBenchmarkComplete: false, plannedInitialExecutions: 25, selectedInitialExecutions: 5, untouchedPendingExecutions: 20, selectedEvaluationComplete: true, selectedRealHooksReady: true, realHooksReady: false, officialSubmissionReady: false, trainingHooksExecuted: false, noModelExecutionByAcceptance: true, noBenchmarkExecutionByAcceptance: true, noUpload: true, manifest: ref(root, manifestPath), controlledEvidence: ref(root, controlledPath), testReport: ref(root, values['--test-report']), backendTestReport: ref(root, values['--backend-test-report']), acceptanceCode: ref(root, fileURLToPath(import.meta.url)), tests: { project: projectTests, backend: backendTests }, selectedRun, controlled, partial, firstPilotDiagnostic: values['--first-pilot'] ? diagnosticPilot(root, values['--first-pilot'], manifest.runId) : null, generatedAt: new Date().toISOString() }
  if (values['--export-report']) report.exportReport = ref(root, values['--export-report'])
  report.environmentAudit = environmentAudit
  writeJson(reportPath, report, { immutable: true })
  return report
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { const report = await runPhase3Acceptance(); console.log(JSON.stringify({ status: report.status, phase3Passed: report.phase3Passed, selectedInitialExecutions: 5, untouchedPendingExecutions: 20, realHooksReady: false, officialSubmissionReady: false }, null, 2)) }
  catch (error) { console.error(JSON.stringify({ status: 'failed', phase3Passed: false, errorType: error?.name ?? 'Error', reason: error?.message, realHooksReady: false, officialSubmissionReady: false })); process.exitCode = 2 }
}
