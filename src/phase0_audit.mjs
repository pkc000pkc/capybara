import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { buildRunManifest, digest, fileDigest, inspectEntrypoints, loadRunInputs, readJson, within } from './phase0_run.mjs'

function createInventoryTreeHash(files) { return createHash('sha256').update(JSON.stringify(files)).digest('hex') }

export function validateSchema(value, schema, document = schema, path = '$') {
  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/')) throw new Error('only local schema references are supported')
    const target = schema.$ref.slice(2).split('/').reduce((object, key) => object?.[key], document)
    if (!target) throw new Error(`unknown schema reference ${schema.$ref}`)
    return validateSchema(value, target, document, path)
  }
  const errors = []
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  const matches = (type) => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : type === 'integer' ? Number.isInteger(value) : typeof value === type
  if (types.length && !types.some(matches)) return [`${path}: type must be ${types.join('|')}`]
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) errors.push(`${path}: invalid constant`)
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: invalid enum value`)
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: invalid pattern`)
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: too short`)
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`)
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: too few items`)
    if (schema.items) value.forEach((item, index) => errors.push(...validateSchema(item, schema.items, document, `${path}[${index}]`)))
  } else if (value && typeof value === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: missing`)
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...validateSchema(item, schema.properties[key], document, `${path}.${key}`))
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: unknown field`)
    }
  }
  return errors
}

export function sensitiveFields(value, path = '$') {
  const errors = []
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    try { const url = new URL(value); if (url.username || url.password || url.search) errors.push(`${path}: credential-bearing URL is not allowed`) } catch { errors.push(`${path}: malformed URL`) }
  }
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (/^(api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password|secret|token)$/i.test(key)) errors.push(`${path}.${key}: secret value is not allowed`)
    errors.push(...sensitiveFields(item, `${path}.${key}`))
  }
  return errors
}

export function validateRunManifest(root, manifest, inputs, env = process.env) {
  const errors = validateSchema(manifest, readJson(join(root, 'schemas/run-manifest.schema.json')))
  errors.push(...sensitiveFields(manifest))
  if (errors.length) return errors
  const { manifestHash, ...contents } = manifest
  if (manifestHash !== digest(contents)) errors.push('manifestHash does not match manifest contents')
  if (digest(manifest.lockRefs) !== digest(inputs.lockRefs)) errors.push('run lock references have changed')
  let expected
  try {
    expected = buildRunManifest({ root, protocol: inputs.protocol, index: inputs.index, lockRefs: inputs.lockRefs, entrypoints: inspectEntrypoints(root, env), mode: manifest.mode, runId: manifest.runId, perCapability: manifest.selection.perCapability ?? undefined, miniLimit: manifest.selection.miniLimit ?? undefined, rootSeed: manifest.rootSeed })
    for (const key of ['planFingerprint', 'dataset', 'models', 'policy', 'requestedRuntime', 'entrypoints', 'tasks', 'selection', 'runRoot', 'stateFile', 'executionBinding']) if (digest(manifest[key]) !== digest(expected[key])) errors.push(`${key} differs from frozen plan`)
  } catch (error) { errors.push(error.message) }
  const taskKeys = new Set(), outputs = new Set()
  const runRoot = resolve(root, 'runs', manifest.runId)
  if (resolve(root, manifest.runRoot) !== runRoot) errors.push('runRoot does not match run ID')
  if (!within(runRoot, resolve(root, manifest.stateFile))) errors.push('stateFile escapes run directory')
  for (const task of manifest.tasks) {
    const taskKey = [task.phase, task.config, task.scenarioId, task.runNumber].join('/')
    if (taskKeys.has(taskKey)) errors.push(`duplicate task ${taskKey}`)
    taskKeys.add(taskKey)
    const max = manifest.mode === 'internal_pass5' ? 5 : 3
    if (task.runNumber > max || (manifest.mode === 'internal_pass5' ? task.attemptIndex !== task.runNumber : task.attemptIndex !== null)) errors.push(`invalid attempt/run numbering for ${taskKey}`)
    for (const field of ['outputDir', 'fixtureDir', 'workspaceDir']) {
      const path = resolve(root, task[field])
      if (isAbsolute(task[field]) || !within(runRoot, path)) errors.push(`${field} escapes run directory for ${taskKey}`)
      if (outputs.has(path)) errors.push(`duplicate execution path ${path}`)
      outputs.add(path)
    }
  }
  if (manifest.tasks.length !== manifest.selection.expectedInitialExecutions) errors.push('initial execution count mismatch')
  return errors
}

export async function auditPhase0(root, { manifest = null, deep = true, env = process.env } = {}) {
  const inputs = loadRunInputs(root)
  const errors = [], checks = [], knownGaps = []
  const checkFile = (path, hash, label) => {
    if (!existsSync(path)) errors.push(`${label}: missing ${path}`)
    else if (fileDigest(path) !== hash) errors.push(`${label}: content changed ${path}`)
  }
  const { collectCodeInputs, hashTree } = await import('./phase0_inventory.mjs')
  try {
    const current = collectCodeInputs(root)
    if (digest(current) !== digest(inputs.environment.codeInputs) || inputs.environment.contentTreeSha256 !== createInventoryTreeHash(current)) errors.push('project code file set/tree differs from environment lock')
    const backend = collectCodeInputs(inputs.protocol.runtime.backendRoot)
    if (digest(backend) !== digest(inputs.environment.backend?.codeInputs) || inputs.environment.backend?.contentTreeSha256 !== createInventoryTreeHash(backend)) errors.push('backend code file set/tree differs from environment lock')
    const official = hashTree(resolve(root, inputs.protocol.runtime.officialPythonPath, 'are'))
    if (official.treeSha256 !== inputs.environment.are?.contentTreeSha256 || official.files.length !== inputs.environment.are?.fileCount) errors.push('official code file set/tree differs from environment lock')
    const officialFiles = official.files.map((file) => ({ path: resolve(root, inputs.protocol.runtime.officialPythonPath, 'are', file.relativePath).replaceAll('\\', '/'), relativePath: file.relativePath, sha256: file.sha256, bytes: file.bytes }))
    if (digest(officialFiles) !== digest(inputs.environment.officialCodeInputs)) errors.push('official code coverage differs from lock')
  } catch (error) { errors.push(`environment tree verification: ${error.message}`) }
  for (const input of inputs.environment.codeInputs ?? []) checkFile(resolve(root, input.path), input.sha256, 'project code')
  for (const input of inputs.environment.officialCodeInputs ?? []) checkFile(resolve(root, input.path), input.sha256, 'official code')
  for (const input of inputs.environment.python?.metadataInputs ?? []) checkFile(resolve(root, input.path), input.sha256, 'Python distribution metadata')
  for (const input of inputs.environment.backend?.codeInputs ?? []) checkFile(resolve(inputs.protocol.runtime.backendRoot, input.path), input.sha256, 'backend code')
  if (!inputs.environment.codeInputs?.length || !inputs.environment.officialCodeInputs?.length) errors.push('environment lock lacks code inputs')
  if (inputs.environment.are?.version !== inputs.protocol.runtime.areVersion) errors.push('ARE version differs from protocol')
  if (inputs.environment.node?.version !== process.versions.node) errors.push('Node version differs from frozen environment')
  if (inputs.environment.node?.executableSha256) checkFile(process.execPath, inputs.environment.node.executableSha256, 'Node executable')
  if (inputs.environment.python?.executableSha256) checkFile(resolve(root, inputs.protocol.runtime.python), inputs.environment.python.executableSha256, 'Python executable')
  if (resolve(inputs.environment.are?.root ?? '') !== resolve(root, inputs.protocol.runtime.officialPythonPath, 'are')) errors.push('ARE path differs from protocol')
  if (resolve(inputs.environment.backend?.root ?? '') !== resolve(inputs.protocol.runtime.backendRoot)) errors.push('backend path differs from protocol')
  for (const dependency of inputs.environment.node?.dependencyVersions?.installedDirect ?? []) checkFile(join(root, 'node_modules', dependency.name, 'package.json'), dependency.packageJsonSha256, 'Node dependency')
  for (const dependency of inputs.environment.backend?.dependencyVersions?.installedDirect ?? []) checkFile(join(inputs.protocol.runtime.backendRoot, 'node_modules', dependency.name, 'package.json'), dependency.packageJsonSha256, 'backend Node dependency')
  checks.push({ name: 'environment_code_hashes', checked: (inputs.environment.codeInputs?.length ?? 0) + (inputs.environment.officialCodeInputs?.length ?? 0) })
  const plugins = inputs.capabilities.plugins ?? []
  if (plugins.length !== 2 || new Set(plugins.map((plugin) => plugin.id)).size !== 2) errors.push('expected two distinct GAIA2 plugins')
  for (const plugin of plugins) {
    if (!plugin.files?.length || !plugin.snapshotRoot || !plugin.treeSha256) { errors.push(`incomplete plugin snapshot ${plugin.id}`); continue }
    const snapshotPath = resolve(root, '.phase0-cache', 'plugins', plugin.id, plugin.treeSha256)
    if (resolve(root, plugin.snapshotRoot) !== snapshotPath || resolve(plugin.sourceRoot) !== resolve(inputs.protocol.runtime.pluginSourceRoot, plugin.id)) errors.push(`plugin ${plugin.id} path differs from protocol/snapshot hash`)
    for (const file of plugin.files) {
      const path = resolve(root, plugin.snapshotRoot, file.relativePath)
      if (!within(resolve(root, plugin.snapshotRoot), path)) errors.push(`plugin snapshot path escape ${plugin.id}`)
      else checkFile(path, file.sha256, `plugin ${plugin.id}`)
    }
    try {
      const current = hashTree(resolve(root, plugin.snapshotRoot))
      if (current.treeSha256 !== plugin.treeSha256 || digest(current.files) !== digest(plugin.files)) errors.push(`plugin ${plugin.id} snapshot tree differs from lock`)
    } catch (error) { errors.push(`plugin ${plugin.id}: ${error.message}`) }
    if (plugin.pluginLoadStatus !== 'not_loaded' && inputs.capabilities.runtimeBinding === 'sidecar_only') errors.push(`inconsistent plugin loading claim ${plugin.id}`)
  }
  try {
    const { inspectRuntimeBinding } = await import('./phase0_inventory.mjs')
    const current = inspectRuntimeBinding(root, inputs.protocol.runtime.backendRoot)
    if (current.runtimeBinding !== inputs.capabilities.runtimeBinding || current.pluginLoadStatus !== inputs.capabilities.pluginLoadStatus || current.effectiveHookDecision !== inputs.capabilities.effectiveHookDecision) errors.push('runtime binding inventory differs from current source')
  } catch (error) { errors.push(`runtime binding: ${error.message}`) }
  checks.push({ name: 'plugin_snapshot_files', checked: plugins.reduce((sum, item) => sum + (item.files?.length ?? 0), 0) })
  for (const kind of ['source', 'submission']) {
    const locked = inputs.datasetLock.datasets?.[kind], configured = inputs.protocol.datasets[kind]
    if (!locked || locked.id !== configured.id || locked.revision !== configured.revision || locked.split !== configured.split || digest([...(locked.configs ?? [])].sort()) !== digest([...configured.configs].sort())) errors.push(`${kind} dataset lock differs from protocol`)
  }
  if (!inputs.datasetLock.scenarioIndex || inputs.datasetLock.scenarioIndex.sha256 !== inputs.lockRefs.scenarioIndex.sha256) errors.push('scenario index is not bound to dataset lock')
  const { verifyDatasetLock } = await import('./phase0_dataset.mjs')
  try {
    await verifyDatasetLock({ root, protocol: inputs.protocol, lock: inputs.datasetLock, index: inputs.index, deep })
  } catch (error) { errors.push(`dataset verification: ${error.message}`) }
  checks.push({ name: 'dataset_files_and_scenario_index', checked: inputs.index.length, deep })
  const modelSource = readJson(resolve(root, inputs.protocol.models.configurationSource))
  if (modelSource.model !== inputs.protocol.models.actor.model || modelSource.model !== inputs.protocol.models.judge.model || modelSource.protocol !== inputs.protocol.models.sourceProtocol) errors.push('model source and protocol disagree')
  if (!modelSource.apiKeySource || !existsSync(modelSource.apiKeySource)) errors.push('external model configuration source is missing')
  const entrypoints = inspectEntrypoints(root, env)
  for (const entry of entrypoints.entries) {
    if (entry.settings.processTimeoutMs !== 0 && entry.settings.processTimeoutMs < inputs.protocol.requestedRuntime.processTimeoutMinutes * 60000) knownGaps.push({ code: 'short_outer_timeout', entrypoint: entry.id, actualMinutes: entry.settings.processTimeoutMs / 60000, requestedMinutes: inputs.protocol.requestedRuntime.processTimeoutMinutes, phase: 1 })
  }
  const bridgeSource = readFileSync(resolve(root, 'scripts/capybara_official_bridge.py'), 'utf8')
  const officialA2ADynamicFactories = /notification_reader_factory=_a2a_notification_reader_factory/.test(bridgeSource)
    && /deadline_factory=_a2a_deadline_factory/.test(bridgeSource)
    && /_close_a2a_lifecycle/.test(bridgeSource)
  knownGaps.push(
    { code: inputs.capabilities.effectiveHookDecision ? 'per_execution_hook_receipt_required' : 'plugin_not_loaded', phase: 3 },
    { code: 'real_correction_strategy_not_bound', phase: 4 },
    { code: officialA2ADynamicFactories ? 'official_a2a_runtime_guard_receipt_required' : 'official_a2a_delegation_not_configured', phase: 5 },
    { code: 'official_noise_semantics_not_verified', phase: 5 },
    { code: 'ARE_checkpoint_resume_unavailable_clean_session_restart_only', phase: null },
  )
  knownGaps.push(...(inputs.capabilities.backendCompatibility?.gaps ?? []).map((gap) => ({ code: gap.id, description: gap.message, phase: 3 })))
  if (manifest) errors.push(...validateRunManifest(root, manifest, inputs, env))
  return { schemaVersion: 'gaia2-phase0-audit-v1', status: errors.length ? 'failed' : 'passed', phase0Passed: errors.length === 0, executionReady: false, officialSubmissionReady: false, errors, knownGaps, checks, entrypoints, runId: manifest?.runId ?? null, expectedInitialExecutions: manifest?.tasks.length ?? null, generatedAt: new Date().toISOString() }
}
