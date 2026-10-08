import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateSchema } from './phase0_audit.mjs'
import { buildRunManifest, digest, fileDigest, readJson, within } from './phase0_run.mjs'

const phases = ['standard', 'agent2agent', 'noise']
const configs = ['execution', 'search', 'adaptability', 'time', 'ambiguity', 'mini']
const hashPattern = /^[0-9a-f]{64}$/
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const portable = path => path.replaceAll('\\', '/')
const keyOf = item => JSON.stringify([item.phase, item.config, item.scenarioId, item.runNumber])
const identityOf = row => ({ phase: row.metadata?.phase, config: row.metadata?.config, scenarioId: row.metadata?.scenario_id, runNumber: row.metadata?.run_number })
const officialText = text => text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
const hfFieldTypes = { scenario_id: 'string', run_number: 'integer', task_id: 'string', score: 'number', status: 'string', data: 'string', run_type: 'string', config: 'string', phase_name: 'string', a2a_app_prop: 'number', has_app_noise: 'boolean', has_env_noise: 'boolean', run_config: 'string', has_exception: 'boolean', exception_type: 'string', exception_message: 'string', rationale: 'string' }
function hfSchemaValid(row) {
  return object(row) && digest(Object.keys(row).sort()) === digest(Object.keys(hfFieldTypes).sort()) && Object.entries(hfFieldTypes).every(([field, type]) => row[field] === null || (type === 'integer' ? Number.isInteger(row[field]) : typeof row[field] === type && (type !== 'number' || Number.isFinite(row[field]))))
}

/** Resolve only regular package files. Windows absolute paths are rejected on every host. */
function packagePath(root, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.startsWith('\\') || path.includes('\0')) throw new Error('unsafe_package_path')
  const normalized = portable(path)
  if (normalized.split('/').some(part => part === '..' || part === '.' || part === '')) throw new Error('unsafe_package_path')
  const absolute = resolve(root, normalized)
  if (!within(root, absolute) || absolute === root) throw new Error('unsafe_package_path')
  let current = absolute
  while (within(root, current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('symbolic_link')
    if (current === root) break
    current = dirname(current)
  }
  if (!existsSync(absolute) || !lstatSync(absolute).isFile()) throw new Error('missing_package_file')
  return absolute
}

function pathSyntax(path) {
  return typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !/^[A-Za-z]:/.test(path) && !path.startsWith('\\') && !portable(path).split('/').some(part => part === '..' || part === '.' || part === '')
}

function manifestErrors(manifest) {
  if (!object(manifest)) return ['invalid_manifest']
  const errors = []
  const { manifestHash, ...contents } = manifest
  if (!hashPattern.test(manifestHash ?? '') || manifestHash !== digest(contents)) errors.push('manifest_hash_mismatch')
  if (manifest.schemaVersion === 'gaia2-run-manifest-v1') {
    const schemaPath = fileURLToPath(new URL('../schemas/run-manifest.schema.json', import.meta.url))
    if (validateSchema(manifest, readJson(schemaPath)).length) errors.push('manifest_schema_invalid')
  } else if (manifest.schemaVersion !== 'gaia2-phase2-fixture-manifest-v1' || manifest.syntheticFixtureOnly !== true) errors.push('manifest_schema_invalid')
  if (!['internal_pass5', 'official_submission'].includes(manifest.mode) || !Array.isArray(manifest.tasks) || !manifest.tasks.length || typeof manifest.runId !== 'string') return [...errors, 'manifest_task_plan_invalid']
  if (manifest.policy?.initialRunsPerScenario !== (manifest.mode === 'internal_pass5' ? 5 : 3)) errors.push('manifest_attempt_policy_invalid')
  if (!pathSyntax(manifest.runRoot) || !pathSyntax(manifest.stateFile)) errors.push('manifest_source_path_invalid')
  const ids = new Set(), keys = new Set()
  for (const task of manifest.tasks) {
    const max = manifest.mode === 'internal_pass5' ? 5 : 3
    if (!object(task) || !phases.includes(task.phase) || !configs.includes(task.config) || typeof task.scenarioId !== 'string' || !task.scenarioId || !Number.isInteger(task.runNumber) || task.runNumber < 1 || task.runNumber > max || typeof task.executionId !== 'string' || !task.executionId) { errors.push('manifest_task_identity_invalid'); continue }
    if (manifest.mode === 'internal_pass5' && task.phase !== 'standard') errors.push('manifest_internal_phase_invalid')
    if (task.attemptIndex !== (manifest.mode === 'internal_pass5' ? task.runNumber : null) || task.correctionOrdinal !== 0) errors.push('manifest_attempt_identity_invalid')
    if (ids.has(task.executionId) || keys.has(keyOf(task))) errors.push('manifest_duplicate_task')
    ids.add(task.executionId); keys.add(keyOf(task))
    for (const field of ['outputDir', 'fixtureDir', 'workspaceDir']) if (!pathSyntax(task[field]) || !portable(task[field]).startsWith(`${portable(manifest.runRoot)}/`)) errors.push('manifest_source_path_invalid')
  }
  if (manifest.selection?.expectedInitialExecutions !== manifest.tasks.length) errors.push('manifest_target_count_mismatch')
  return [...new Set(errors)]
}

function traceErrors(trace, identity, executionId) {
  const errors = []
  if (!object(trace)) return ['trace_not_object']
  for (const field of ['world_logs', 'apps', 'events', 'completed_events']) if (!Array.isArray(trace[field])) errors.push(`trace_${field}_invalid`)
  if (!Array.isArray(trace.world_logs) || !trace.world_logs.every(line => typeof line === 'string')) errors.push('trace_world_logs_invalid')
  if (typeof trace.version !== 'string' || !trace.version) errors.push('trace_version_invalid')
  if (!Object.hasOwn(trace, 'context') || trace.context !== null && typeof trace.context !== 'string') errors.push('trace_context_invalid')
  if (!Object.hasOwn(trace, 'augmentation') || trace.augmentation !== null && !object(trace.augmentation)) errors.push('trace_augmentation_invalid')
  const definition = trace.metadata?.definition
  if (!object(trace.metadata) || !object(definition)) return [...errors, 'trace_metadata_invalid']
  if (definition.scenario_id !== identity.scenarioId || definition.run_number !== identity.runNumber) errors.push('trace_identity_mismatch')
  for (const [field, expected] of [['config', identity.config], ['phase', identity.phase], ['execution_id', executionId]]) if (definition[field] !== undefined && definition[field] !== null && definition[field] !== expected) errors.push('trace_identity_mismatch')
  return errors
}

function processHealthy(process) {
  return object(process) && process.schemaVersion === 'gaia2-process-result-v1' && process.exitCode === 0 && !process.signal && process.timedOut !== true && process.interrupted !== true && !process.spawnError && !process.loggingError && !process.heartbeatError && Array.isArray(process.terminationErrors) && process.terminationErrors.length === 0 && Number.isFinite(Date.parse(process.finishedAt)) && process.manualInspectionRequired !== true
}

/** Independent structural, target-coverage and provenance-backed evaluation audit. No network or model calls. */
export function auditSubmissionPackage({ packageRoot, officialCheck = null } = {}) {
  const root = resolve(packageRoot ?? '.')
  const issues = []
  let format = true, coverage = true, evaluation = true
  const issue = (gate, code, detail = {}) => {
    if (gate === 'format') format = false
    if (gate === 'coverage') coverage = false
    if (gate === 'evaluation') evaluation = false
    issues.push({ gate, code, ...detail })
  }
  const metrics = { targetCount: 0, rowCount: 0, uniqueRowCount: 0, duplicateRows: 0, unknownRows: 0, missingRows: 0, structurallyValidRows: 0, evaluatedRows: 0, successCount: 0, businessFailureCount: 0, technicalCount: 0, provenanceValidRows: 0, officialReconstructedCount: null }
  let manifest = null, sidecar = null
  const json = (path, gate, code) => { try { return readJson(packagePath(root, path)) } catch { issue(gate, code, { path }); return null } }
  try {
    if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('invalid_root')
  } catch { issue('format', 'invalid_package_root'); coverage = false; evaluation = false; return finish() }
  // Match the official recursive scan, even in structural-only mode. Never follow links.
  function inspectLayout(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (lstatSync(path).isSymbolicLink()) { issue('format', 'symbolic_package_entry', { path: portable(relative(root, path)) }); continue }
      if (entry.isDirectory()) inspectLayout(path)
      else if (entry.name === 'output.jsonl') {
        const parts = portable(relative(root, path)).split('/')
        if (parts.length !== 3 || !phases.includes(parts[0]) || !configs.includes(parts[1])) { issue('format', 'noncanonical_output_layout', { path: parts.join('/') }); issue('coverage', 'unknown_execution_layout') }
      }
    }
  }
  inspectLayout(root)
  manifest = json('run-manifest.json', 'coverage', 'missing_or_invalid_manifest')
  if (manifest) for (const code of manifestErrors(manifest)) issue('coverage', code)
  if (!coverage) { evaluation = false; manifest = null }
  sidecar = json('export-manifest.json', 'evaluation', 'missing_or_invalid_provenance')
  if (sidecar && (!object(sidecar) || sidecar.schemaVersion !== 'gaia2-export-manifest-v1' || !Array.isArray(sidecar.records) || !Array.isArray(sidecar.files) || !Array.isArray(sidecar.missing))) { issue('evaluation', 'invalid_export_manifest'); sidecar = null }
  if (manifest) metrics.targetCount = manifest.tasks.length
  const expected = new Map((manifest?.tasks ?? []).map(task => [keyOf(task), task]))
  const expectedById = new Map((manifest?.tasks ?? []).map(task => [task.executionId, task]))
  const records = new Map(), files = new Map()
  let state = null, runtime = null, provenanceBaseValid = Boolean(manifest && sidecar)
  const evidence = (ref, label) => {
    if (!object(ref) || !hashPattern.test(ref.sha256 ?? '')) { issue('evaluation', 'invalid_evidence_reference', { evidence: label }); return null }
    try {
      const path = packagePath(root, ref.path)
      if (fileDigest(path) !== ref.sha256) throw new Error('hash')
      return path
    } catch { issue('evaluation', 'evidence_missing_or_changed', { evidence: label, path: typeof ref.path === 'string' ? ref.path : null }); return null }
  }
  if (sidecar) {
    if (!manifest || sidecar.sourceRunId !== manifest.runId || sidecar.manifestHash !== manifest.manifestHash || sidecar.mode !== manifest.mode || !hashPattern.test(sidecar.runtimeHash ?? '') || !hashPattern.test(sidecar.strategyHash ?? '') || !['synthetic_fixture', 'native_runtime'].includes(sidecar.evidenceKind) || typeof sidecar.syntheticFixtureOnly !== 'boolean' || sidecar.syntheticFixtureOnly !== (sidecar.evidenceKind === 'synthetic_fixture') || (manifest?.schemaVersion === 'gaia2-phase2-fixture-manifest-v1') !== sidecar.syntheticFixtureOnly) { issue('evaluation', 'export_provenance_binding_mismatch'); provenanceBaseValid = false }
    for (const ref of sidecar.files) {
      if (files.has(ref?.path)) { issue('evaluation', 'duplicate_file_evidence'); provenanceBaseValid = false }
      const path = evidence(ref, 'package_file')
      if (!path) provenanceBaseValid = false
      else files.set(ref.path, ref.sha256)
    }
    const sourceManifestPath = evidence(sidecar.sourceManifest, 'source_manifest')
    if (!sourceManifestPath || sidecar.sourceManifest.path !== 'run-manifest.json' || files.get(sidecar.sourceManifest.path) !== sidecar.sourceManifest.sha256 || sidecar.strategyHash !== digest({ policy: manifest?.policy, models: manifest?.models, correctionOrdinal: 0 }) || sidecar.strategyConsumed !== false) { issue('evaluation', 'source_manifest_or_strategy_binding_mismatch'); provenanceBaseValid = false }
    if (manifest && !sidecar.syntheticFixtureOnly) {
      const snapshots = sidecar.lockSnapshots, captured = {}
      for (const name of ['protocol', 'environment', 'capabilities', 'dataset', 'scenarioIndex']) {
        const ref = snapshots?.[name], path = evidence(ref, `captured_${name}`)
        if (!path || ref.sha256 !== manifest.lockRefs?.[name]?.sha256 || files.get(ref.path) !== ref.sha256) { issue('evaluation', 'captured_lock_binding_mismatch', { evidence: name }); provenanceBaseValid = false }
        else captured[name] = path
      }
      if (Object.keys(captured).length === 5) {
        try {
          const protocol = readJson(captured.protocol), index = readFileSync(captured.scenarioIndex, 'utf8').split(/\r?\n/).filter(line => line.trim()).map(JSON.parse)
          const restored = buildRunManifest({ root, protocol, index, lockRefs: manifest.lockRefs, entrypoints: manifest.entrypoints, mode: manifest.mode, runId: manifest.runId, perCapability: manifest.selection.perCapability ?? undefined, miniLimit: manifest.selection.miniLimit ?? undefined, rootSeed: manifest.rootSeed })
          for (const key of ['planFingerprint', 'dataset', 'models', 'policy', 'requestedRuntime', 'tasks', 'selection', 'runRoot', 'stateFile']) if (digest(manifest[key]) !== digest(restored[key])) throw new Error('captured_plan')
          const environment = readJson(captured.environment)
          if (!manifest.entrypoints.entries.every(entry => environment.codeInputs.some(file => file.path === entry.path && file.sha256 === entry.sha256))) throw new Error('captured_entrypoint')
        } catch { issue('evaluation', 'captured_plan_reconstruction_mismatch'); provenanceBaseValid = false }
      }
    }
    for (const record of sidecar.records) {
      if (!object(record) || typeof record.executionId !== 'string' || records.has(record.executionId)) { issue('evaluation', 'duplicate_or_invalid_export_record'); provenanceBaseValid = false; continue }
      records.set(record.executionId, record)
      const target = expectedById.get(record.executionId)
      if (!target || keyOf(record) !== keyOf(target)) { issue('evaluation', 'foreign_export_record', { executionId: record.executionId }); provenanceBaseValid = false }
    }
    const statePath = evidence(sidecar.state, 'run_state'), runtimePath = evidence(sidecar.runtimeSettings, 'runtime_settings')
    if (!statePath || !runtimePath || files.get(sidecar.state?.path) !== sidecar.state?.sha256 || files.get(sidecar.runtimeSettings?.path) !== sidecar.runtimeSettings?.sha256) { issue('evaluation', 'untracked_runtime_evidence'); provenanceBaseValid = false }
    try { if (statePath) state = readJson(statePath); if (runtimePath) runtime = readJson(runtimePath) } catch { issue('evaluation', 'invalid_runtime_evidence') }
    if (!object(state) || state.schemaVersion !== 'gaia2-run-state-v1' || state.runId !== manifest?.runId || state.manifestHash !== manifest?.manifestHash || state.runtimeHash !== sidecar.runtimeHash || !Array.isArray(state.tasks) || !state.tasks.every(task => object(task) && Array.isArray(task.sessions)) || digest(state.tasks.map(task => task.executionId)) !== digest((manifest?.tasks ?? []).map(task => task.executionId)) || !object(runtime) || digest(runtime) !== sidecar.runtimeHash) { issue('evaluation', 'state_or_runtime_binding_mismatch'); provenanceBaseValid = false }
  }

  const rows = [], seen = new Map()
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || phases.includes(entry.name) || ['evidence', 'hf', 'provenance', '_official'].includes(entry.name)) continue
    const unknownPhase = join(root, entry.name)
    if (lstatSync(unknownPhase).isSymbolicLink()) { issue('format', 'symbolic_phase_directory'); continue }
    if (readdirSync(unknownPhase, { withFileTypes: true }).some(config => config.isDirectory() && existsSync(join(unknownPhase, config.name, 'output.jsonl')))) { issue('format', 'unknown_phase_layout'); issue('coverage', 'unknown_execution_layout') }
  }
  for (const phase of phases) {
    const phaseDir = join(root, phase)
    if (!existsSync(phaseDir)) continue
    if (lstatSync(phaseDir).isSymbolicLink() || !lstatSync(phaseDir).isDirectory()) { issue('format', 'invalid_phase_directory', { phase }); continue }
    for (const entry of readdirSync(phaseDir, { withFileTypes: true })) {
      const config = entry.name
      if (!configs.includes(config) || !entry.isDirectory() || entry.isSymbolicLink()) { issue('format', 'invalid_config_directory', { phase, config }); issue('coverage', 'unknown_execution_layout', { phase, config }); continue }
      const outputPath = `${phase}/${config}/output.jsonl`
      let lines
      try { lines = readFileSync(packagePath(root, outputPath), 'utf8').split(/\r?\n/).filter(line => line.trim()) }
      catch { issue('format', 'missing_or_unsafe_output', { path: outputPath }); continue }
      if (!lines.length) issue('format', 'empty_output', { path: outputPath })
      for (const [lineIndex, line] of lines.entries()) {
        metrics.rowCount++
        let row
        try { row = JSON.parse(line) } catch { issue('format', 'malformed_jsonl', { path: outputPath, line: lineIndex + 1 }); continue }
        const location = { path: outputPath, line: lineIndex + 1 }
        if (!object(row) || typeof row.task_id !== 'string' || !row.task_id || typeof row.trace_id !== 'string' || !Object.hasOwn(row, 'score') || !(row.score === null || typeof row.score === 'number' && Number.isFinite(row.score)) || !object(row.metadata)) { issue('format', 'invalid_output_row', location); continue }
        const identity = identityOf(row), metadata = row.metadata
        if (identity.phase !== phase || identity.config !== config || typeof identity.scenarioId !== 'string' || row.task_id !== identity.scenarioId || !Number.isInteger(identity.runNumber) || identity.runNumber < 1 || identity.runNumber > (manifest?.mode === 'internal_pass5' ? 5 : 3) || typeof metadata.execution_id !== 'string' || !metadata.execution_id || !['success', 'failed', 'exception', 'no_validation'].includes(metadata.status) || typeof metadata.has_exception !== 'boolean') { issue('format', 'invalid_row_identity_or_status', location); continue }
        const key = keyOf(identity), task = expected.get(key)
        if (seen.has(key)) { metrics.duplicateRows++; issue('coverage', 'duplicate_execution_key', { ...location, executionId: metadata.execution_id }) }
        else seen.set(key, row)
        if (manifest && (!task || metadata.execution_id !== task.executionId)) { metrics.unknownRows++; issue('coverage', 'unknown_execution_key', { ...location, executionId: metadata.execution_id }) }
        let trace, tracePath, traceBytes
        try { tracePath = packagePath(root, row.trace_id); traceBytes = readFileSync(tracePath, 'utf8'); trace = JSON.parse(traceBytes) }
        catch { issue('format', 'missing_unsafe_or_invalid_trace', location); continue }
        const errors = traceErrors(trace, identity, metadata.execution_id)
        for (const code of errors) issue('format', code, location)
        const hasException = metadata.has_exception || Boolean(metadata.exception_type) || trace.metadata?.definition?.has_exception === true || Boolean(trace.metadata?.definition?.exception_type)
        const judged = ['success', 'failed'].includes(metadata.status)
        if (judged ? hasException || row.score !== (metadata.status === 'success' ? 1 : 0) : row.score !== null) issue('format', 'status_score_exception_mismatch', location)
        if (metadata.status === 'exception' && !hasException || metadata.status === 'no_validation' && hasException) issue('format', 'technical_status_exception_mismatch', location)
        if (!judged || hasException) { metrics.technicalCount++; issue('evaluation', 'technical_or_unvalidated_result', { executionId: metadata.execution_id }) }
        else if (metadata.status === 'success') metrics.successCount++
        else metrics.businessFailureCount++
        let hfValid = true
        const hfPath = row.trace_id
        try {
          // The package's hf files are complete original traces; HF dataset rows are produced by ARE separately.
          const hf = packagePath(root, hfPath)
          if (!readFileSync(hf).equals(readFileSync(tracePath))) throw new Error('trace_changed')
        } catch { issue('format', 'missing_or_changed_hf_trace', { ...location, executionId: metadata.execution_id }); hfValid = false }
        const rowFormat = errors.length === 0 && hfValid && (judged ? !hasException && row.score === (metadata.status === 'success' ? 1 : 0) : row.score === null) && (metadata.status !== 'exception' || hasException) && (metadata.status !== 'no_validation' || !hasException)
        if (rowFormat) metrics.structurallyValidRows++
        const item = { row, identity, task, trace, tracePath, outputPath, key, rowFormat, judged: judged && !hasException }
        rows.push(item)
        if (!provenanceBaseValid || !task) continue
        const record = records.get(task.executionId)
        if (!record || record.outputPath !== outputPath || record.trace?.path !== portable(relative(root, tracePath)) || keyOf(record) !== key || !Array.isArray(record.artifacts)) { issue('evaluation', 'missing_or_mismatched_export_record', { executionId: task.executionId }); continue }
        const resultPath = evidence(record.result, 'task_result'), processPath = evidence(record.processResult, 'process_result'), eventsPath = evidence(record.runtimeEvents, 'runtime_events'), boundTrace = evidence(record.trace, 'native_trace')
        if (!resultPath || !processPath || !eventsPath || !boundTrace) continue
        if (![record.result, record.processResult, record.runtimeEvents, record.trace].every(ref => files.get(ref.path) === ref.sha256)) { issue('evaluation', 'untracked_execution_evidence', { executionId: task.executionId }); continue }
        let result, process, events
        try { result = readJson(resultPath); process = readJson(processPath); events = readFileSync(eventsPath, 'utf8').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)) }
        catch { issue('evaluation', 'malformed_execution_evidence', { executionId: task.executionId }); continue }
        const stateTask = state.tasks.find(item => item.executionId === task.executionId), session = stateTask?.sessions?.at(-1)
        const sourceResultPath = session && pathSyntax(session.workspaceDir) ? `${portable(session.workspaceDir)}/task-result.json` : null
        if (!object(result) || result.schemaVersion !== 'gaia2-task-result-v1' || result.runId !== manifest.runId || result.manifestHash !== manifest.manifestHash || result.runtimeHash !== sidecar.runtimeHash || result.executionId !== task.executionId || result.sessionId !== record.sessionId || keyOf(result) !== key || !session || session.sessionId !== record.sessionId || !pathSyntax(session.workspaceDir) || !pathSyntax(session.outputDir) || portable(stateTask.resultPath ?? '') !== sourceResultPath || stateTask.resultSha256 !== record.result.sha256 || !Array.isArray(result.artifacts)) { issue('evaluation', 'execution_provenance_identity_mismatch', { executionId: task.executionId }); continue }
        let artifactsValid = true
        if (!stateTask.sessions.every((item, ordinal) => object(item) && /^\d{4}-[0-9a-f-]{12}$/.test(item.sessionId ?? '') && item.sessionOrdinal === ordinal + 1 && item.parentSessionId === (stateTask.sessions[ordinal - 1]?.sessionId ?? null) && ['outputDir', 'fixtureDir', 'workspaceDir'].every(field => pathSyntax(item[field]) && portable(item[field]) === `${portable(task[field])}/sessions/${item.sessionId}`))) { issue('evaluation', 'session_lineage_or_path_mismatch', { executionId: task.executionId }); continue }
        const artifactSources = new Map()
        for (const artifact of record.artifacts) {
          const checked = evidence(artifact, 'native_artifact')
          if (!checked || files.get(artifact.path) !== artifact.sha256 || !pathSyntax(artifact.sourcePath) || !portable(artifact.sourcePath).startsWith(`${portable(session.outputDir)}/`) || artifactSources.has(artifact.sourcePath)) artifactsValid = false
          else artifactSources.set(artifact.sourcePath, artifact)
        }
        for (const artifact of result.artifacts) if (!pathSyntax(artifact?.path) || !hashPattern.test(artifact?.sha256 ?? '') || artifactSources.get(artifact.path)?.sha256 !== artifact.sha256) artifactsValid = false
        if (record.artifacts.length !== 2 || result.artifacts.length !== 2 || artifactSources.size !== result.artifacts.length || !record.artifacts.some(artifact => artifact?.path === record.trace.path && artifact.sha256 === record.trace.sha256)) artifactsValid = false
        if (!artifactsValid) { issue('evaluation', 'native_artifact_binding_mismatch', { executionId: task.executionId }); continue }
        try {
          const natives = record.artifacts.filter(artifact => portable(artifact.sourcePath).endsWith('/output.jsonl'))
          if (natives.length !== 1) throw new Error('native_count')
          const nativeRef = natives[0], nativeRows = readFileSync(packagePath(root, nativeRef.path), 'utf8').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line))
          if (nativeRows.length !== 1 || !object(nativeRows[0]) || !object(nativeRows[0].metadata)) throw new Error('native_shape')
          const native = nativeRows[0], meta = native.metadata
          if (native.task_id !== task.scenarioId || meta.scenario_id !== task.scenarioId || meta.status !== metadata.status || native.score !== row.score || meta.has_exception === true || meta.has_exception !== undefined && meta.has_exception !== null && typeof meta.has_exception !== 'boolean' || Boolean(meta.exception_type) || typeof native.trace_id !== 'string' || !native.trace_id) throw new Error('native_judgment')
          if (meta.run_number !== undefined && meta.run_number !== task.runNumber) throw new Error('native_run')
          for (const [field, expected] of [['phase', task.phase], ['config', task.config], ['execution_id', task.executionId]]) if (meta[field] !== undefined && meta[field] !== null && meta[field] !== expected) throw new Error('native_identity')
          const traceSource = record.artifacts.find(artifact => artifact.path === record.trace.path).sourcePath
          const nativeTrace = portable(native.trace_id)
          const absoluteTrace = isAbsolute(native.trace_id) || /^[A-Za-z]:/.test(native.trace_id)
          // Absolute source references are compared as identities only, never opened.
          // Relative references follow the original native envelope's directory.
          const refersToTrace = absoluteTrace ? nativeTrace.endsWith(`/${portable(traceSource)}`) : portable(relative(resolve('/'), resolve('/', dirname(nativeRef.sourcePath), native.trace_id))) === portable(traceSource)
          if (!refersToTrace) throw new Error('native_trace_identity')
        } catch { issue('evaluation', 'native_judgment_or_trace_binding_mismatch', { executionId: task.executionId }); continue }
        if (!events.every(event => object(event) && event.executionId === task.executionId && event.sessionId === record.sessionId)) { issue('evaluation', 'foreign_runtime_event', { executionId: task.executionId }); continue }
        const validation = events.findLast(event => event.type === 'official_validation_completed')
        const passed = metadata.status === 'success'
        if (!item.judged || !rowFormat || stateTask.status !== 'completed' || result.evaluationComplete !== true || result.businessPassed !== passed || result.score !== row.score || (passed ? result.failure !== null : result.failure?.category !== 'business_failure' || result.failure.retryable !== false) || !processHealthy(process) || result.process?.exitCode !== process.exitCode || result.process?.signal !== (process.signal ?? null) || result.process?.timedOut !== (process.timedOut === true) || result.process?.interrupted !== (process.interrupted === true) || !validation || validation.hasException !== false || validation.validationSuccess !== passed) { issue('evaluation', 'execution_not_validly_evaluated', { executionId: task.executionId }); continue }
        metrics.provenanceValidRows++
        metrics.evaluatedRows++
      }
    }
  }
  metrics.uniqueRowCount = seen.size
  if (!metrics.rowCount) issue('format', 'zero_result_rows')
  if (manifest) {
    for (const [key, task] of expected) if (!seen.has(key)) { metrics.missingRows++; issue('coverage', 'missing_execution_key', { executionId: task.executionId }) }
    if (metrics.rowCount !== metrics.targetCount || metrics.uniqueRowCount !== metrics.targetCount) issue('coverage', 'target_coverage_count_mismatch')
  } else coverage = false
  if (!provenanceBaseValid || metrics.evaluatedRows !== metrics.targetCount || !coverage) evaluation = false
  if (sidecar) {
    const expectedMissing = new Set((manifest?.tasks ?? []).filter(task => !records.has(task.executionId)).map(task => task.executionId))
    const suppliedMissing = new Set(sidecar.missing.map(item => item?.executionId))
    if (suppliedMissing.size !== sidecar.missing.length || digest([...expectedMissing].sort()) !== digest([...suppliedMissing].sort())) issue('evaluation', 'missing_inventory_mismatch')
    for (const item of rows) if (!files.has(item.outputPath) || !files.has(item.row.trace_id)) issue('evaluation', 'untracked_submission_file', { executionId: item.row.metadata.execution_id })
  }
  if (officialCheck !== null) {
    metrics.officialReconstructedCount = officialCheck?.reconstructedCount ?? null
    if (!object(officialCheck) || officialCheck.status !== 'passed' || officialCheck.traceValidationPassed !== true || officialCheck.hfSchemaValid !== true) issue('format', 'official_format_check_failed')
    const officialRows = officialCheck?.identityRows
    const actualIdentities = rows.map(item => ({ ...item.identity, status: item.row.metadata.status, score: item.row.score })).sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
    const comparable = item => Object.fromEntries(['phase', 'config', 'scenarioId', 'runNumber', 'status', 'score'].map(field => [field, item[field]]))
    if (!Array.isArray(officialRows) || !officialRows.every(object) || !officialRows.every(item => item.executionId === undefined || item.executionId === null || rows.some(row => row.key === keyOf(item) && row.row.metadata.execution_id === item.executionId)) || digest(officialRows.map(comparable).sort((a, b) => keyOf(a).localeCompare(keyOf(b)))) !== digest(actualIdentities) || officialCheck.reconstructedCount !== metrics.rowCount || officialCheck.successCount !== metrics.successCount || officialCheck.businessFailureCount !== metrics.businessFailureCount || officialCheck.technicalCount !== metrics.technicalCount) { issue('evaluation', 'official_reconstruction_disagrees'); issue('coverage', 'official_reconstruction_count_or_identity_mismatch') }
    if (officialCheck?.hfRowsPath) {
      try {
        const path = packagePath(root, officialCheck.hfRowsPath)
        const hfRows = readFileSync(path, 'utf8').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line))
        if (hfRows.length !== rows.length) throw new Error('count')
        const hfSeen = new Set()
        for (const hf of hfRows) {
          const identity = { phase: hf.phase_name, config: hf.config, scenarioId: hf.scenario_id, runNumber: hf.run_number }
          const key = keyOf(identity), item = rows.find(row => row.key === key)
          if (!hfSchemaValid(hf) || !item || hfSeen.has(key) || hf.task_id !== identity.scenarioId || hf.status !== item.row.metadata.status || hf.score !== item.row.score || hf.has_exception !== item.row.metadata.has_exception || typeof hf.data !== 'string' || hf.data !== officialText(readFileSync(item.tracePath, 'utf8')) || hf.has_app_noise !== (identity.phase === 'noise') || hf.has_env_noise !== (identity.phase === 'noise') || hf.a2a_app_prop !== (identity.phase === 'agent2agent' ? 1 : 0)) throw new Error('identity')
          hfSeen.add(key)
        }
      } catch { issue('format', 'official_hf_rows_invalid') }
    }
  }
  return finish()

  function finish() {
    return { schemaVersion: 'gaia2-submission-audit-v1', format_valid: format, coverage_complete: coverage, evaluation_complete: evaluation, officialSubmissionReady: false, issues, metrics, mode: manifest?.mode ?? null, evidenceKind: sidecar?.evidenceKind ?? 'unverified_external', syntheticFixtureOnly: sidecar?.syntheticFixtureOnly === true, officialCheckPassed: officialCheck?.status === 'passed' && officialCheck?.traceValidationPassed === true && officialCheck?.hfSchemaValid === true, readinessBlockers: ['full_real_official_run_and_phase_3_to_5_gates_not_attested', ...(manifest?.mode !== 'official_submission' ? ['not_official_submission_mode'] : []), ...(manifest?.selection?.fullOfficialCoverage !== true ? ['not_full_official_coverage_plan'] : []), ...(sidecar?.evidenceKind !== 'native_runtime' ? ['not_native_runtime_evidence'] : []), ...(officialCheck === null ? ['official_reconstruction_not_checked'] : [])] }
  }
}
