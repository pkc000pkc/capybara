import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, relative, resolve, win32 } from 'node:path'
import { digest, fileDigest, readJson, within } from './phase0_run.mjs'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hash = value => createHash('sha256').update(value).digest('hex')
const jsonHash = value => hash(JSON.stringify(value)) // Host hash preserves insertion order.
const HASH = /^[a-f0-9]{64}$/
const portable = value => value.replaceAll('\\', '/')
const sealed = new Set(['oracle', 'oracleEvents', 'oracle_events', 'judge', 'judgeRationale', 'expectedAnswer', 'expected_answer', 'referenceAnswer', 'reference_answer', 'futureEvents', 'future_events', 'validationResult', 'training'])
function check(condition, code) { if (!condition) throw new Error(`Phase 3 runtime evidence: ${code}`) }
function pathSyntax(value) { return typeof value === 'string' && value.length > 0 && !isAbsolute(value) && !win32.isAbsolute(value) && !/[\\\0:]/.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..') }
function localFile(root, path) {
  check(pathSyntax(path), 'unsafe_path')
  const file = resolve(root, path)
  check(within(root, file), 'path_escape')
  for (let at = file; ; at = dirname(at)) { check(!lstatSync(at).isSymbolicLink(), 'symbolic_path'); if (at === dirname(at)) break }
  check(lstatSync(file).isFile(), 'not_regular_file')
  return file
}
function actorBlind(value) {
  if (Array.isArray(value)) value.forEach(actorBlind)
  else if (object(value)) for (const [key, child] of Object.entries(value)) { check(!sealed.has(key) && !['__proto__', 'prototype', 'constructor'].includes(key), 'sealed_actor_input'); actorBlind(child) }
  else check(value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value), 'non_json_value')
}
function processHealthy(value) { return object(value) && value.schemaVersion === 'gaia2-process-result-v1' && value.exitCode === 0 && !value.signal && !value.timedOut && !value.interrupted && !value.spawnError && !value.loggingError && !value.heartbeatError && !value.manualInspectionRequired && Array.isArray(value.terminationErrors) && value.terminationErrors.length === 0 && Number.isFinite(Date.parse(value.finishedAt)) }
// Python json.dumps(sort_keys=True) uses ASCII strings and spaced separators.
function pythonJson(value) {
  if (typeof value === 'string') return JSON.stringify(value).replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${pythonJson(key)}: ${pythonJson(value[key])}`).join(', ')}}`
  return JSON.stringify(value)
}
export const pythonEventHash = value => hash(pythonJson(value))
export const runtimeEvidenceRequired = (manifest, result) => manifest?.executionBinding === 'phase3_live_plugin_host_required' || result?.runtimeEvidenceRequired === true

/** Verify source-bound live receipts using only a caller-supplied evidence reader.
 * Bundle callers map original relative identities to package copies; no old root is opened.
 */
export function validateRuntimeEvidence({ manifest, task, session, events, runtimeAttestation: attestation, runtimeEvidence: refs, readEvidence }) {
  check(object(attestation) && attestation.schemaVersion === 'gaia2-runtime-attestation-v1' && Array.isArray(refs) && refs.length > 0 && typeof readEvidence === 'function', 'missing_attestation')
  for (const key of ['runId', 'manifestHash']) check(attestation[key] === manifest[key], 'manifest_identity')
  for (const key of ['executionId', 'scenarioId', 'runNumber', 'phase', 'config']) check(attestation[key] === task[key], 'task_identity')
  check(attestation.sessionId === session.sessionId && attestation.capabilitiesSha256 === manifest.lockRefs?.capabilities?.sha256, 'session_or_capabilities_identity')
  check(Array.isArray(events) && events.length && events.every(event => object(event) && event.executionId === task.executionId && event.sessionId === session.sessionId), 'foreign_runtime_event')
  check(attestation.eventsHash === digest(events) && attestation.evidenceHash === digest(refs), 'evidence_inventory_hash')
  const files = new Map(), used = new Set()
  for (const ref of refs) {
    check(object(ref) && pathSyntax(ref.path) && HASH.test(ref.sha256 ?? '') && !files.has(ref.path), 'invalid_or_duplicate_reference')
    check([session.workspaceDir, session.outputDir].some(parent => ref.path.startsWith(`${portable(parent)}/`)), 'foreign_evidence_path')
    const bytes = readEvidence(ref.path)
    check(Buffer.isBuffer(bytes) && hash(bytes) === ref.sha256, 'evidence_sha_mismatch')
    files.set(ref.path, bytes)
  }
  const bytes = path => { check(files.has(path), 'unbound_evidence'); used.add(path); return files.get(path) }
  const json = path => JSON.parse(bytes(path).toString('utf8'))
  const capabilities = json(attestation.capabilitiesPath)
  check(hash(files.get(attestation.capabilitiesPath)) === attestation.capabilitiesSha256 && Array.isArray(capabilities.plugins) && capabilities.plugins.length, 'capabilities_sha_mismatch')
  const initialization = json(attestation.initializationPath), ready = json(attestation.readyPath), hostProcess = json(attestation.hostProcessPath)
  check(processHealthy(hostProcess), 'unhealthy_host_process')
  check(initialization.schemaVersion === 'capybara-runtime-plugin-host-v1' && initialization.executionId === task.executionId && initialization.sessionId === session.sessionId, 'initialization_identity')
  check(ready.schemaVersion === 'gaia2-hook-host-ready-v1' && /^http:\/\/127\.0\.0\.1:\d+\/invoke$/.test(ready.endpoint) && Number.isInteger(ready.processId) && ready.processId === hostProcess.pid && ready.initializationHash === jsonHash(ready.initialization), 'ready_receipt_invalid')
  const { evidencePath, ...readyInitialization } = ready.initialization ?? {}
  check(typeof evidencePath === 'string' && portable(evidencePath).endsWith(`/${attestation.initializationPath}`) && digest(readyInitialization) === digest(initialization), 'ready_initialization_mismatch')
  check(Array.isArray(attestation.sourceFiles) && Array.isArray(initialization.plugins) && initialization.plugins.length === capabilities.plugins.length, 'source_inventory_invalid')
  const sources = new Map(), definitions = new Map(), values = {}, hooks = new Map(), harnesses = []
  for (const plugin of capabilities.plugins) {
    check(typeof plugin.id === 'string' && Array.isArray(plugin.files) && plugin.files.length, 'plugin_invalid')
    const loaded = initialization.plugins.find(item => item.id === plugin.id)
    check(loaded && digest(loaded.files) === digest(plugin.files), 'loaded_plugin_files_mismatch')
    const inventory = []
    for (const file of plugin.files) {
      const candidates = attestation.sourceFiles.filter(item => item.pluginId === plugin.id && item.relativePath === file.relativePath)
      check(pathSyntax(file.relativePath) && candidates.length === 1 && candidates[0].sha256 === file.sha256, 'plugin_source_binding')
      const candidate = candidates[0], content = bytes(candidate.path)
      check(hash(content) === file.sha256, 'plugin_source_sha')
      sources.set(`${plugin.id}/${file.relativePath}`, content.toString('utf8')); inventory.push({ relativePath: file.relativePath, sha256: file.sha256 })
    }
    check(loaded.inventoryHash === jsonHash(inventory.sort((a, b) => a.relativePath.localeCompare(b.relativePath))), 'plugin_inventory_hash')
    const source = path => { check(sources.has(`${plugin.id}/${path}`), 'plugin_resource_missing'); return sources.get(`${plugin.id}/${path}`) }
    const declaration = JSON.parse(source('capybara.plugin.json'))
    check(declaration.id === plugin.id && declaration.schemaVersion === 1 && object(declaration.resources), 'plugin_manifest_invalid')
    const resources = declaration.resources
    if (resources.variables) {
      const resource = JSON.parse(source(resources.variables))
      check(resource.version === 1 && Array.isArray(resource.variables), 'variable_resource_invalid')
      for (const entry of resource.variables) {
        const type = entry.type ?? 'text', scope = entry.scope ?? 'project'
        check(/^gaia2_[a-z][a-z0-9_]*$/.test(entry.key) && !definitions.has(entry.key) && ['text', 'object'].includes(type) && ['project', 'session'].includes(scope) && typeof (entry.show_in_status ?? false) === 'boolean' && typeof (entry.readonly ?? false) === 'boolean', 'variable_declaration_invalid')
        check(type === 'text' ? typeof entry.value === 'string' : object(entry.value), 'variable_type_invalid'); actorBlind(entry.value)
        definitions.set(entry.key, { ...entry, type, scope, readonly: entry.readonly ?? false, pluginId: plugin.id }); values[entry.key] = structuredClone(entry.value)
      }
    }
    for (const path of resources.harnesses ?? []) {
      const resource = JSON.parse(source(path))
      for (const definition of resource.harnesses ?? []) {
        const entry = posix.normalize(posix.join(posix.dirname(path), definition.entry)), text = source(entry)
        check(definition.type === 'persistent' && object(definition.activation) && Object.keys(definition.activation).length === 0 && text.trim(), 'persistent_harness_invalid')
        harnesses.push({ id: `${resource.package}:${definition.name}`, type: 'persistent', sourceSha256: hash(text) })
      }
    }
    const runtimeDirs = resources.hooks ?? [], trainingDirs = resources.trainingHooks ?? []
    for (const [mode, dirs] of [['runtime', runtimeDirs], ['training', trainingDirs]]) for (const file of plugin.files) {
      if (!file.relativePath.endsWith('.ts') || !dirs.some(dir => file.relativePath === dir || file.relativePath.startsWith(`${dir}/`))) continue
      const id = posix.basename(file.relativePath, '.ts'), items = mode === 'runtime' ? initialization.runtimeHooks : initialization.trainingHooks
      const loadedHook = items?.find(item => item.id === id)
      check(loadedHook && loadedHook.sourceSha256 === file.sha256, 'hook_source_binding')
      const sourceText = source(file.relativePath), checkpoint = sourceText.match(/\bcheckpoint\s*:\s*["']([^"']+)["']/)?.[1] ?? 'after_loop'
      check(sourceText.match(/\bname\s*:\s*["']([^"']+)["']/)?.[1] === id && loadedHook.checkpoint === checkpoint, 'hook_definition_binding')
      if (mode === 'runtime') { check(!hooks.has(id), 'duplicate_hook'); hooks.set(id, { ...loadedHook, pluginId: plugin.id }) }
    }
  }
  check(attestation.sourceFiles.length === [...capabilities.plugins].reduce((n, plugin) => n + plugin.files.length, 0), 'extra_plugin_source')
  check(definitions.size > 0 && [...definitions.values()].some(entry => entry.type === 'object') && [...definitions.values()].some(entry => entry.type === 'text'), 'missing_typed_variables')
  check(harnesses.length > 0 && digest(harnesses) === digest(initialization.harnesses) && hooks.size === initialization.runtimeHooks?.length, 'harness_or_hook_inventory')
  if (object(values.gaia2_scenario_state)) values.gaia2_scenario_state = { ...values.gaia2_scenario_state, scenario_id: task.scenarioId }
  if (object(values.gaia2_attempt_state)) values.gaia2_attempt_state = { ...values.gaia2_attempt_state, attempt_id: task.executionId, attempt_index: task.attemptIndex ?? 0, status: 'running' }
  check(jsonHash(values) === initialization.variablesHash, 'initial_variables_hash')
  let priorHash = initialization.variablesHash, previousValues = values, revision = 1
  check(Array.isArray(attestation.invocationPaths) && attestation.invocationPaths.length, 'missing_invocations')
  const invocations = attestation.invocationPaths.map(json), completions = events.map((event, index) => ({ event, index })).filter(item => item.event.type === 'live_hook_completed')
  check(invocations.length === completions.length, 'hook_event_count')
  const bound = []
  for (let i = 0; i < invocations.length; i++) {
    const receipt = invocations[i], { event, index } = completions[i], checkpoint = receipt.input?.checkpoint
    check(receipt.schemaVersion === 'capybara-runtime-plugin-invocation-v1' && receipt.executionId === task.executionId && receipt.sessionId === session.sessionId && receipt.scenarioId === task.scenarioId && receipt.sequence === i + 2, 'invocation_identity_or_sequence')
    check(['before_model', 'before_tool', 'after_tool', 'attempt_end'].includes(checkpoint), 'training_execution_not_allowed')
    actorBlind(receipt.input); actorBlind(receipt.variables); actorBlind(receipt.artifacts)
    check(receipt.beforeVariablesHash === priorHash && jsonHash(receipt.variables) === receipt.variablesHash && Number.isInteger(receipt.revision) && receipt.revision >= revision, 'variables_chain')
    check(digest(Object.keys(receipt.variables).sort()) === digest([...definitions.keys()].sort()), 'variable_set_changed')
    for (const [key, definition] of definitions) {
      check(definition.type === 'text' ? typeof receipt.variables[key] === 'string' : object(receipt.variables[key]), 'invocation_variable_type')
      if (definition.readonly || definition.scope === 'project') check(digest(receipt.variables[key]) === digest(previousValues[key]), 'frozen_variable_changed')
    }
    check(typeof receipt.context === 'string' && receipt.context.trim() && hash(receipt.context) === receipt.contextHash && Array.isArray(receipt.hookReceipts) && receipt.hookReceipts.length, 'context_or_hooks_missing')
    const seen = new Set()
    for (const hook of receipt.hookReceipts) {
      const expected = hooks.get(hook.hookId)
      check(expected && !seen.has(hook.hookId) && hook.pluginId === expected.pluginId && hook.sourceSha256 === expected.sourceSha256 && hook.checkpoint === checkpoint && expected.checkpoint === checkpoint && hook.status === 'passed' && typeof hook.matched === 'boolean' && Number.isInteger(hook.patchCount) && hook.patchCount >= 0, 'hook_receipt_invalid')
      seen.add(hook.hookId)
    }
    check(receipt.hookReceipts.some(hook => hook.matched), 'no_matched_hook')
    check(object(receipt.decision) && ['allow', 'block', 'read_back'].includes(receipt.decision.action) && typeof receipt.decision.reason === 'string', 'invalid_decision')
    const rank = { allow: 0, read_back: 1, block: 2 }
    for (const hook of receipt.hookReceipts) if (hook.decision) check(hook.matched && object(hook.decision) && typeof hook.decision.reason === 'string' && Object.hasOwn(rank, hook.decision.action) && rank[receipt.decision.action] >= rank[hook.decision.action], 'decision_weakened')
    for (const [key, definition] of definitions) if (digest(receipt.variables[key]) !== digest(previousValues[key])) check(receipt.hookReceipts.some(hook => hook.matched && hook.pluginId === definition.pluginId && hook.patchCount > 0), 'unowned_variable_change')
    check(event.checkpoint === checkpoint && event.contextHash === receipt.contextHash && event.variablesHash === receipt.variablesHash && event.hookRevision === receipt.revision && event.decision === receipt.decision.action && event.hookReceiptCount === receipt.hookReceipts.length && event.hookReceiptsHash === pythonEventHash(receipt.hookReceipts) && event.reasonHash === pythonEventHash(receipt.decision.reason), 'python_hook_binding')
    bound.push({ receipt, index }); priorHash = receipt.variablesHash; previousValues = receipt.variables; revision = receipt.revision
  }
  const injected = events.map((event, index) => ({ event, index })).filter(item => item.event.type === 'dynamic_context_injected'), models = events.map((event, index) => ({ event, index })).filter(item => item.event.type === 'model_request')
  check(injected.length > 0 && injected.length === models.length, 'missing_actor_context')
  const modelBindings = new Set()
  for (let i = 0; i < models.length; i++) {
    const item = injected[i], model = models[i], before = bound.findLast(entry => entry.index < item.index)
    check(before?.receipt.input.checkpoint === 'before_model' && !modelBindings.has(before.index) && before.receipt.decision.action === 'allow' && item.index < model.index && model.event.turn === i && item.event.turn === model.event.turn && before.receipt.input.loop?.iteration === item.event.turn && item.event.contextHash === before.receipt.contextHash && item.event.injectedContextHash === hash(before.receipt.context) && item.event.hookRevision === before.receipt.revision && HASH.test(item.event.actorInputHash ?? ''), 'actor_context_injection_mismatch')
    modelBindings.add(before.index)
  }
  const toolEvents = events.map((event, index) => ({ event, index })).filter(item => ['tool_call_started', 'tool_call_blocked'].includes(item.event.type)), usedCalls = new Set()
  for (const { event, index } of toolEvents) {
    check(typeof event.callId === 'string' && !usedCalls.has(event.callId), 'duplicate_tool_identity'); usedCalls.add(event.callId)
    const before = bound.findLast(entry => entry.index < index), action = before?.receipt.input.action
    check(before?.receipt.input.checkpoint === 'before_tool' && action?.id === event.callId && action.name === event.function && action.canonicalName === event.canonicalName && before.receipt.input.loop?.iteration === event.turn && models.findLast(item => item.index < before.index)?.event.turn === event.turn, 'missing_matching_before_tool')
    for (const id of ['gaia2-write-guard', 'gaia2-conflict-gate']) check(before.receipt.hookReceipts.some(hook => hook.hookId === id && hook.matched && hook.decision), 'missing_safety_decision')
    if (event.type === 'tool_call_started') {
      check(before.receipt.decision.action === 'allow' && event.effect === action.effect, 'unauthorized_tool_started')
      const complete = events.map((value, at) => ({ value, at })).find(item => item.at > index && item.value.type === 'tool_call_completed' && item.value.callId === event.callId)
      check(complete && complete.value.function === action.name && complete.value.canonicalName === action.canonicalName && complete.value.turn === event.turn && HASH.test(complete.value.resultHash ?? ''), 'missing_tool_completion')
      const after = bound.find(entry => entry.index > complete.at)
      check(after?.receipt.input.checkpoint === 'after_tool' && after.receipt.decision.action === 'allow' && after.receipt.input.action?.id === event.callId && after.receipt.input.action.name === action.name && after.receipt.input.action.canonicalName === action.canonicalName && after.receipt.input.outcome?.executed === true && after.receipt.input.outcome.status === complete.value.status && after.receipt.input.outcome.resultHash === complete.value.resultHash, 'missing_matching_after_tool')
    }
  }
  check(toolEvents.length > 0 && bound.filter(item => item.receipt.input.checkpoint === 'before_tool').length === toolEvents.length, 'missing_tool_gate_evidence')
  check(bound.at(-1).receipt.input.checkpoint === 'attempt_end' && bound.at(-1).receipt.input.loop?.terminal === true && events.some(event => event.type === 'attempt_execution_ended'), 'missing_attempt_end')
  check(used.size === files.size, 'unconsumed_evidence')
  const summary = { invocationCount: invocations.length, modelRequestCount: models.length, toolGateCount: toolEvents.length, typedVariableCount: definitions.size, persistentHarnessCount: harnesses.length, actorInputHashReconstructed: false, trainingHooksExecuted: false }
  check(digest(attestation.summary) === digest(summary), 'attestation_summary_mismatch')
  return { ...summary, realHooksReady: manifest.syntheticFixtureOnly !== true }
}

/** Capture original Host bytes and frozen source copies; never expose evaluation inputs to Actor. */
export function collectRuntimeEvidence({ root, manifest, task, session, events, hostProcess }) {
  root = resolve(root)
  const ref = path => ({ path: portable(relative(root, path)), sha256: fileDigest(path) })
  const hostDir = portable(join(session.outputDir, 'hook-host')), evidenceDir = portable(join(session.workspaceDir, 'plugin-runtime'))
  const hostProcessPath = `${hostDir}/process-result.json`, readyPath = `${hostDir}/ready.json`
  check(processHealthy(hostProcess) && digest(readJson(localFile(root, hostProcessPath))) === digest(hostProcess), 'host_process_mismatch')
  const receipts = readdirSync(resolve(root, evidenceDir)).sort().map(name => `${evidenceDir}/${name}`)
  receipts.forEach(path => localFile(root, path))
  const initial = receipts.filter(path => readJson(resolve(root, path)).schemaVersion === 'capybara-runtime-plugin-host-v1')
  check(initial.length === 1 && initial[0] === receipts[0], 'initialization_missing_or_duplicate')
  const capabilityRef = manifest.lockRefs?.capabilities
  check(capabilityRef && pathSyntax(portable(capabilityRef.path)), 'capabilities_unbound')
  const candidates = [resolve(root, capabilityRef.path)]
  const archiveRoot = join(root, 'locks/archive')
  if (existsSync(archiveRoot)) for (const entry of readdirSync(archiveRoot, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) candidates.push(join(archiveRoot, entry.name, posix.basename(portable(capabilityRef.path))))
  const capabilityPath = candidates.find(path => existsSync(path) && fileDigest(path) === capabilityRef.sha256)
  check(capabilityPath, 'captured_capabilities_missing')
  localFile(root, portable(relative(root, capabilityPath)))
  const copies = resolve(root, session.workspaceDir, 'plugin-runtime-sources'); check(!existsSync(copies), 'source_capture_already_exists'); mkdirSync(copies)
  const capturedCapabilities = join(copies, 'capability-inventory.json'); copyFileSync(capabilityPath, capturedCapabilities, 1)
  const capabilities = readJson(capturedCapabilities), sourceFiles = []
  for (const plugin of capabilities.plugins) {
    check(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(plugin.id), 'unsafe_plugin_id')
    for (const file of plugin.files) {
      const source = localFile(root, portable(relative(root, resolve(root, plugin.snapshotRoot, file.relativePath))))
      check(fileDigest(source) === file.sha256 && pathSyntax(file.relativePath), 'source_sha_mismatch')
      const target = join(copies, plugin.id, file.relativePath); mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target, 1)
      sourceFiles.push({ pluginId: plugin.id, relativePath: file.relativePath, ...ref(target) })
    }
  }
  const runtimeEvidence = [...receipts, hostProcessPath, readyPath, portable(relative(root, capturedCapabilities)), ...sourceFiles.map(file => file.path)].map(path => ref(localFile(root, path)))
  const invocations = receipts.slice(1).map(path => readJson(resolve(root, path)))
  const runtimeAttestation = { schemaVersion: 'gaia2-runtime-attestation-v1', runId: manifest.runId, manifestHash: manifest.manifestHash, executionId: task.executionId, sessionId: session.sessionId, scenarioId: task.scenarioId, runNumber: task.runNumber, phase: task.phase, config: task.config, capabilitiesSha256: capabilityRef.sha256, capabilitiesPath: portable(relative(root, capturedCapabilities)), initializationPath: initial[0], invocationPaths: receipts.slice(1), hostProcessPath, readyPath, sourceFiles, evidenceHash: digest(runtimeEvidence), eventsHash: digest(events), summary: { invocationCount: invocations.length, modelRequestCount: events.filter(event => event.type === 'model_request').length, toolGateCount: events.filter(event => ['tool_call_started', 'tool_call_blocked'].includes(event.type)).length, typedVariableCount: Object.keys(invocations[0]?.variables ?? {}).length, persistentHarnessCount: readJson(resolve(root, initial[0])).harnesses.length, actorInputHashReconstructed: false, trainingHooksExecuted: false } }
  validateRuntimeEvidence({ manifest, task, session, events, runtimeAttestation, runtimeEvidence, readEvidence: path => readFileSync(localFile(root, path)) })
  return { runtimeAttestation, runtimeEvidence }
}
