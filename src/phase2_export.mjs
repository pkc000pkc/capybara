import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { validateSchema } from './phase0_audit.mjs'
import { assertPublicConfig, buildRunManifest, digest, fileDigest, readJson, within } from './phase0_run.mjs'
import { readNativeResult } from './phase1_official.mjs'
import { runChildProcess } from './phase1_process.mjs'
import { auditSubmissionPackage } from './phase2_audit.mjs'

const portable = path => path.replaceAll('\\', '/')
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }) }
function check(condition, message) { assert.ok(condition, `Phase 2 export: ${message}`) }
export function packagePath(root, path) {
  check(typeof path === 'string' && path.length && !isAbsolute(path) && !/^[A-Za-z]:/.test(path) && !/[\\\0:]/.test(path) && !path.split('/').some(part => ['..', '.', ''].includes(part)), 'unsafe relative package path')
  const target = resolve(root, path)
  check(within(root, target) && target !== resolve(root), 'package path escapes root')
  for (let at = target; within(root, at); at = dirname(at)) {
    if (existsSync(at)) check(!lstatSync(at).isSymbolicLink(), 'package path contains symlink')
    if (at === resolve(root)) break
  }
  return target
}
function checkAbsoluteAncestors(path) {
  for (let at = resolve(path); ; at = dirname(at)) {
    if (existsSync(at)) check(!lstatSync(at).isSymbolicLink(), 'absolute path contains symlink/junction')
    if (at === dirname(at)) break
  }
}
function checkedSource(root, path, parent) {
  const target = packagePath(root, portable(path)); check(within(parent, target), 'source artifact escapes session'); return target
}
export function validateExportPlan(root, manifest, { allowSynthetic = false } = {}) {
  const { manifestHash, ...contents } = manifest
  check(manifestHash === digest(contents), 'manifest hash differs')
  assertPublicConfig(manifest)
  const synthetic = manifest.schemaVersion === 'gaia2-phase2-fixture-manifest-v1'
  check(!synthetic || allowSynthetic && manifest.syntheticFixtureOnly === true, 'synthetic export requires explicit fixture option')
  if (!synthetic) check(validateSchema(manifest, readJson(join(root, 'schemas/run-manifest.schema.json'))).length === 0, 'run-manifest schema invalid')
  check(['internal_pass5', 'official_submission'].includes(manifest.mode), 'unsupported mode')
  check(manifest.tasks.length > 0 && manifest.tasks.length === manifest.selection.expectedInitialExecutions, 'task count differs')
  const keys = new Set(), ids = new Set()
  for (const task of manifest.tasks) {
    const key = [task.phase, task.config, task.scenarioId, task.runNumber].join('/')
    check(!keys.has(key) && !ids.has(task.executionId), 'duplicate planned execution')
    keys.add(key); ids.add(task.executionId)
    check(['standard', 'agent2agent', 'noise'].includes(task.phase) && /^[a-z][a-z0-9_-]*$/.test(task.config) && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(task.executionId), 'unsafe execution identity/layout')
    check(Number.isInteger(task.runNumber) && task.runNumber >= 1 && task.runNumber <= (manifest.mode === 'official_submission' ? 3 : 5), 'invalid run numbering')
    check(task.correctionOrdinal === 0 && manifest.policy.maxCorrections === 0, 'correction export is not connected until phase 4')
  }
  const frozenSources = {}
  if (!synthetic) {
    for (const [name, ref] of Object.entries(manifest.lockRefs)) {
      const direct = packagePath(root, portable(ref.path)), candidates = [direct]
      const archives = join(root, 'locks/archive')
      if (existsSync(archives)) for (const entry of readdirSync(archives, { withFileTypes: true })) if (entry.isDirectory() && !lstatSync(join(archives, entry.name)).isSymbolicLink()) candidates.push(join(archives, entry.name, ref.path.split(/[\\/]/).at(-1)))
      const found = candidates.find(path => existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink() && fileDigest(path) === ref.sha256)
      check(found, `frozen ${name} snapshot missing; do not substitute current locks`); frozenSources[name] = found
    }
    const protocol = readJson(frozenSources.protocol)
    const index = readFileSync(frozenSources.scenarioIndex, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    const expected = buildRunManifest({ root, protocol, index, lockRefs: manifest.lockRefs, entrypoints: manifest.entrypoints, mode: manifest.mode, runId: manifest.runId, perCapability: manifest.selection.perCapability ?? undefined, miniLimit: manifest.selection.miniLimit ?? undefined, rootSeed: manifest.rootSeed })
    for (const key of ['planFingerprint', 'dataset', 'models', 'policy', 'requestedRuntime', 'tasks', 'selection', 'runRoot', 'stateFile']) check(digest(manifest[key]) === digest(expected[key]), `${key} differs from captured frozen inputs`)
    const capturedEnvironment = readJson(frozenSources.environment)
    for (const entry of manifest.entrypoints.entries) check(capturedEnvironment.codeInputs.some(file => file.path === entry.path && file.sha256 === entry.sha256), 'entrypoint does not match captured code snapshot')
  }
  return { synthetic, frozenSources }
}

// Official conversion is supervised, offline, credential-free, and never calls a model.
export async function runOfficialConversion({ root, operation, spec, diagnosticsRoot, signal, processOutputDir }) {
  const protocol = readJson(join(root, 'config/phase0-protocol.json'))
  check(['build', 'check', 'fixture'].includes(operation), 'unknown official operation')
  mkdirSync(diagnosticsRoot, { recursive: true })
  const operationRoot = join(diagnosticsRoot, `${operation}-${randomUUID()}`)
  mkdirSync(operationRoot)
  const specPath = join(operationRoot, 'input.json'), reportPath = join(operationRoot, 'official-result.json')
  write(specPath, spec)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|ACCESS_TOKEN|AUTHORIZATION|HF_TOKEN|HUGGINGFACE_TOKEN)/i.test(key)))
  const processResult = await runChildProcess({ command: resolve(root, protocol.runtime.python), args: [join(root, 'scripts/phase2_official_adapter.py'), '--operation', operation, '--spec', specPath, '--output', reportPath], cwd: spec.packageRoot ?? dirname(spec.tracePath), env: { ...env, PYTHONPATH: resolve(root, protocol.runtime.officialPythonPath), PYTHONUTF8: '1', HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' }, outputDir: processOutputDir ?? join(operationRoot, 'process'), processTimeoutMs: 480000000, heartbeatIntervalMs: 1000, signal })
  const report = existsSync(reportPath) ? readJson(reportPath) : { status: 'failed', errorType: 'MissingOfficialResult' }
  const healthy = processResult.exitCode === 0 && !processResult.signal && !processResult.timedOut && !processResult.interrupted && !processResult.spawnError && !processResult.loggingError && !processResult.heartbeatError && !processResult.manualInspectionRequired && !processResult.terminationErrors.length
  return { ...report, status: healthy && report.status === 'passed' ? 'passed' : 'failed', processHealthy: healthy, processResult, diagnosticsRoot: operationRoot, reportPath }
}

function gather(root, manifest) {
  const runRoot = packagePath(root, portable(manifest.runRoot))
  const statePath = checkedSource(root, manifest.stateFile, runRoot)
  const runtimePath = join(runRoot, 'runtime-settings.json')
  if (!existsSync(statePath)) return { state: null, runtime: null, statePath: null, runtimePath: null, records: [], missing: manifest.tasks.map(task => ({ executionId: task.executionId, status: 'pending', category: 'not_executed' })) }
  check(existsSync(runtimePath) && !lstatSync(runtimePath).isSymbolicLink(), 'runtime settings missing/unsafe')
  const state = readJson(statePath), runtime = readJson(runtimePath)
  check(state.schemaVersion === 'gaia2-run-state-v1' && state.runId === manifest.runId && state.manifestHash === manifest.manifestHash && state.runtimeHash === digest(runtime), 'state/runtime does not bind plan')
  check(digest(state.tasks.map(task => task.executionId)) === digest(manifest.tasks.map(task => task.executionId)), 'state task order/set differs')
  const records = [], missing = []
  for (let i = 0; i < manifest.tasks.length; i++) {
    const task = manifest.tasks[i], record = state.tasks[i]
    check(['pending', 'running', 'completed', 'retry_pending'].includes(record.status) && Array.isArray(record.sessions), 'invalid task state')
    for (let ordinal = 0; ordinal < record.sessions.length; ordinal++) {
      const session = record.sessions[ordinal]
      check(/^\d{4}-[0-9a-f-]{12}$/.test(session.sessionId) && session.sessionOrdinal === ordinal + 1 && session.parentSessionId === (record.sessions[ordinal - 1]?.sessionId ?? null), 'session lineage differs')
      for (const key of ['outputDir', 'fixtureDir', 'workspaceDir']) check(portable(session[key]) === portable(join(task[key], 'sessions', session.sessionId)), 'session paths differ from frozen task')
    }
    if (record.status !== 'completed') { missing.push({ executionId: task.executionId, status: record.status, category: record.failure?.category ?? 'not_evaluated' }); continue }
    const session = record.sessions.at(-1)
    check(session && session.sessionOrdinal === record.sessions.length && /^\d{4}-[0-9a-f-]{12}$/.test(session.sessionId), 'completed task session invalid')
    for (const key of ['outputDir', 'fixtureDir', 'workspaceDir']) check(portable(session[key]) === portable(join(task[key], 'sessions', session.sessionId)), 'session path differs from plan')
    const output = checkedSource(root, session.outputDir, runRoot), workspace = checkedSource(root, session.workspaceDir, runRoot)
    check(portable(record.resultPath) === portable(join(session.workspaceDir, 'task-result.json')), 'result path differs from current session')
    const resultPath = checkedSource(root, record.resultPath, workspace)
    check(fileDigest(resultPath) === record.resultSha256, 'task result changed')
    const result = readJson(resultPath)
    check(result.schemaVersion === 'gaia2-task-result-v1' && result.runId === manifest.runId && result.manifestHash === manifest.manifestHash && result.runtimeHash === state.runtimeHash && result.executionId === task.executionId && result.sessionId === session.sessionId, 'result identity differs')
    check(result.phase === task.phase && result.config === task.config && result.scenarioId === task.scenarioId && result.runNumber === task.runNumber && result.evaluationComplete === true && typeof result.businessPassed === 'boolean', 'result metadata/judgment invalid')
    check(result.businessPassed ? result.failure === null && result.score === 1 : result.failure?.category === 'business_failure' && result.failure.retryable === false && result.score === 0, 'technical failure cannot be exported as business result')
    const processPath = join(output, 'process-result.json'), eventsPath = join(output, 'runtime-events.jsonl')
    for (const path of [processPath, eventsPath]) checkedSource(root, relative(root, path), output)
    const process = readJson(processPath)
    check(process.schemaVersion === 'gaia2-process-result-v1' && process.exitCode === 0 && !process.signal && !process.timedOut && !process.interrupted && !process.spawnError && !process.loggingError && !process.heartbeatError && !process.manualInspectionRequired && process.terminationErrors?.length === 0 && Number.isFinite(Date.parse(process.finishedAt)), 'completed process not healthy')
    check(result.process.exitCode === 0 && !result.process.signal && !result.process.interrupted && !result.process.timedOut, 'result process differs')
    const events = readFileSync(eventsPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    check(Array.isArray(result.artifacts) && result.artifacts.length === 2, 'expected native output and full trace artifacts')
    for (const artifact of result.artifacts) check(fileDigest(checkedSource(root, artifact.path, output)) === artifact.sha256, 'native artifact changed')
    const native = readNativeResult({ root, outputDir: session.outputDir, task, session, events })
    check(native.report.evaluationComplete && native.report.businessPassed === result.businessPassed && digest(native.artifacts) === digest(result.artifacts), 'native judgment/artifacts differ')
    records.push({ task, session, result, resultPath, processPath, eventsPath, nativePath: resolve(root, native.artifacts[0].path), tracePath: resolve(root, native.artifacts[1].path), sourceArtifacts: result.artifacts })
  }
  return { state, runtime, statePath, runtimePath, stateSha256: fileDigest(statePath), records, missing }
}

export async function exportSubmissionPackage({ root, manifestPath, outputDir, allowSynthetic = false, signal }) {
  root = resolve(root); manifestPath = resolve(root, manifestPath); outputDir = resolve(outputDir)
  checkAbsoluteAncestors(outputDir)
  const manifest = readJson(manifestPath), { synthetic, frozenSources } = validateExportPlan(root, manifest, { allowSynthetic })
  check(!existsSync(outputDir), 'output directory already exists; use a new export id')
  const source = gather(root, manifest)
  check(!within(resolve(root, manifest.runRoot), outputDir) || !manifest.tasks.some(task => ['outputDir', 'fixtureDir', 'workspaceDir'].some(key => within(resolve(root, task[key]), outputDir))), 'export directory overlaps execution artifacts')
  mkdirSync(dirname(outputDir), { recursive: true }); mkdirSync(outputDir)
  const files = []
  const copy = (sourcePath, targetPath) => { const target = packagePath(outputDir, targetPath); mkdirSync(dirname(target), { recursive: true }); copyFileSync(sourcePath, target, 1); const ref = { path: targetPath, sha256: fileDigest(target) }; files.push(ref); return ref }
  copy(manifestPath, 'run-manifest.json')
  const lockSnapshots = Object.fromEntries(Object.entries(frozenSources).map(([name, path]) => [name, copy(path, `provenance/${name}.${name === 'scenarioIndex' ? 'jsonl' : 'json'}`)]))
  const stateRef = source.state ? copy(source.statePath, 'evidence/run-state.json') : null
  const runtimeRef = source.runtime ? copy(source.runtimePath, 'evidence/runtime-settings.json') : null
  const records = source.records.map(record => {
    const id = record.task.executionId, prefix = `evidence/${id}`
    return { phase: record.task.phase, config: record.task.config, scenarioId: record.task.scenarioId, runNumber: record.task.runNumber, executionId: id, sessionId: record.session.sessionId, result: copy(record.resultPath, `${prefix}/task-result.json`), processResult: copy(record.processPath, `${prefix}/process-result.json`), runtimeEvents: copy(record.eventsPath, `${prefix}/runtime-events.jsonl`), artifacts: [copy(record.nativePath, `${prefix}/native-output.jsonl`)].map(ref => ({ ...ref, sourcePath: record.sourceArtifacts[0].path })), trace: { path: `${record.task.phase}/${record.task.config}/hf/${id}.json`, sha256: fileDigest(record.tracePath) }, outputPath: `${record.task.phase}/${record.task.config}/output.jsonl` }
  })
  const diagnosticsRoot = join(dirname(outputDir), `${outputDir.split(/[\\/]/).at(-1)}-conversion`)
  const spec = { packageRoot: outputDir, model: manifest.models.actor.model, provider: manifest.models.actor.provider, rows: source.records.map(record => ({ executionId: record.task.executionId, phase: record.task.phase, config: record.task.config, scenarioId: record.task.scenarioId, runNumber: record.task.runNumber, success: record.result.businessPassed, traceSourcePath: record.tracePath })) }
  const built = records.length ? await runOfficialConversion({ root, operation: 'build', spec, diagnosticsRoot, signal }) : { status: 'passed', normalizations: [], noRows: true }
  check(built.status === 'passed', `official builder failed (${built.errorType ?? 'conversion_error'}); partial package retained for diagnosis`)
  for (let i = 0; i < records.length; i++) {
    const trace = records[i].trace
    check(fileDigest(packagePath(outputDir, trace.path)) === trace.sha256, 'official builder changed trace bytes')
    files.push(trace)
    records[i].artifacts.push({ ...trace, sourcePath: source.records[i].sourceArtifacts[1].path })
  }
  for (const outputPath of new Set(records.map(record => record.outputPath))) files.push({ path: outputPath, sha256: fileDigest(packagePath(outputDir, outputPath)) })
  if (source.state) check(fileDigest(source.statePath) === source.stateSha256, 'source state changed during export; do not use partial package')
  const provenance = { schemaVersion: 'gaia2-export-manifest-v1', sourceRunId: manifest.runId, manifestHash: manifest.manifestHash, mode: manifest.mode, evidenceKind: synthetic ? 'synthetic_fixture' : 'native_runtime', syntheticFixtureOnly: synthetic, runtimeHash: source.state?.runtimeHash ?? null, strategyHash: digest({ policy: manifest.policy, models: manifest.models, correctionOrdinal: 0 }), strategyConsumed: false, records, missing: source.missing, files, lockSnapshots, state: stateRef, runtimeSettings: runtimeRef, normalizations: built.normalizations ?? [], sourceManifest: { path: 'run-manifest.json', sha256: fileDigest(manifestPath) }, generatedAt: new Date().toISOString() }
  write(join(outputDir, 'export-manifest.json'), provenance)
  write(join(outputDir, 'problems.json'), { schemaVersion: 'gaia2-export-problems-v1', incompleteExecutions: source.missing, noModelExecution: true, syntheticFixtureOnly: synthetic })
  // Strict project gates precede the permissive official reconstruction.
  const initialAudit = auditSubmissionPackage({ packageRoot: outputDir })
  let officialCheck = null
  if (initialAudit.format_valid && initialAudit.metrics.duplicateRows === 0) officialCheck = await runOfficialConversion({ root, operation: 'check', spec: { packageRoot: outputDir, model: manifest.models.actor.model, provider: manifest.models.actor.provider }, diagnosticsRoot, signal })
  const audit = auditSubmissionPackage({ packageRoot: outputDir, officialCheck })
  const report = { schemaVersion: 'gaia2-phase2-export-report-v1', packageRoot: outputDir, sourceRunId: manifest.runId, exportedRows: records.length, missingExecutions: source.missing.length, syntheticFixtureOnly: synthetic, noModelExecution: true, officialCheck, audit, generatedAt: new Date().toISOString() }
  write(join(dirname(outputDir), `${outputDir.split(/[\\/]/).at(-1)}-export-report.json`), report)
  return report
}
