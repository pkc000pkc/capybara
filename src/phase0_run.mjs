import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { resolveRuntimeSettings } from './phase1_config.mjs'

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  return value
}
export function digest(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex') }
export function fileDigest(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }
export function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')) }
export function within(parent, candidate) {
  const rel = relative(resolve(parent), resolve(candidate))
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
export function writeJson(path, value, { immutable = false } = {}) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, immutable ? { flag: 'wx' } : undefined)
}
function positiveNumber(value, name, { zero = false } = {}) {
  const number = Number(value)
  if (!Number.isFinite(number) || (zero ? number < 0 : number <= 0)) throw new Error(`${name} must be ${zero ? 'non-negative' : 'positive'}`)
  return number
}
function envNumber(env, name, fallback, options) {
  return positiveNumber(env[name] === undefined || env[name] === '' ? fallback : env[name], name, options)
}
export function assertPublicConfig(value, path = '$') {
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    const url = new URL(value)
    if (url.username || url.password || url.search) throw new Error(`${path}: credential-bearing URL is not allowed`)
  }
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (/^(api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password|secret|token)$/i.test(key)) throw new Error(`${path}.${key}: secret field is not allowed`)
    assertPublicConfig(item, `${path}.${key}`)
  }
}

// Capture the shared Stage 1 defaults used by the known manifest wrappers.
// Static shape checks make a new entrypoint implementation require re-audit.
export function inspectEntrypoints(root, env = process.env) {
  const paths = {
    e2e: 'scripts/official_e2e_smoke.mjs',
    batch: 'scripts/official_batch_smoke.mjs',
    pilot: 'scripts/official_integrated_pilot.mjs',
    all: 'scripts/official_all_smoke.mjs',
  }
  for (const [id, path] of Object.entries(paths)) {
    const text = readFileSync(join(root, path), 'utf8')
    if (!/import\s*\{\s*runManifestCli\s*\}\s*from\s*['"]\.\.\/src\/phase1_cli\.mjs['"]/.test(text)
      || !new RegExp(`await\\s+runManifestCli\\(\\{\\s*root,\\s*entrypoint:\\s*['"]${id}['"]\\s*\\}\\)`).test(text)) throw new Error(`unrecognized manifest wrapper ${path}; audit entrypoint again`)
  }
  const cli = readFileSync(join(root, 'src/phase1_cli.mjs'), 'utf8')
  if (!/import\s*\{\s*resolveRuntimeSettings\s*\}\s*from\s*['"]\.\/phase1_config\.mjs['"]/.test(cli)
    || !/resolveRuntimeSettings\(\{\s*protocol:\s*\{\s*requestedRuntime:\s*manifest\.requestedRuntime\s*\},\s*entrypoint,\s*env\s*\}\)/.test(cli)) throw new Error('unrecognized shared runtime settings binding; audit phase1_cli again')
  const names = [
    'GAIA2_PROCESS_TIMEOUT_MS', 'GAIA2_PROCESS_TIMEOUT_MINUTES',
    'GAIA2_SCENARIO_TIMEOUT_SECONDS', 'GAIA2_MODEL_REQUEST_TIMEOUT_SECONDS',
    'GAIA2_CONCURRENCY', 'GAIA2_MINIMAL', 'GAIA2_MAX_ACTIONS', 'GAIA2_HEARTBEAT_INTERVAL_MS',
    'GAIA2_E2E_TIMEOUT_SECONDS', 'GAIA2_E2E_LLM_TIMEOUT_SECONDS', 'GAIA2_E2E_PROCESS_TIMEOUT_MS',
    'GAIA2_BATCH_TIMEOUT_MINUTES', 'GAIA2_BATCH_PROCESS_TIMEOUT_MINUTES', 'GAIA2_BATCH_PROCESS_TIMEOUT_MS',
    'GAIA2_PILOT_PROCESS_TIMEOUT_MS', 'GAIA2_E2E_ALL_TIMEOUT_MS', 'GAIA2_E2E_MAX_ACTIONS', 'GAIA2_E2E_MINIMAL',
    'GAIA2_MODEL_MAX_ATTEMPTS', 'GAIA2_MODEL_BACKOFF_BASE_SECONDS', 'GAIA2_MODEL_BACKOFF_MAX_SECONDS', 'GAIA2_MODEL_MAX_RETRY_WAIT_SECONDS',
  ]
  return {
    entries: Object.entries(paths).map(([id, path]) => ({ id, path, sha256: fileDigest(join(root, path)), settings: { ...resolveRuntimeSettings({ protocol: {}, entrypoint: id, env }), maxCorrections: 0 } })),
    environmentOverrides: Object.fromEntries(names.filter((name) => env[name] !== undefined).map((name) => [name, env[name]])),
  }
}

export function validateProtocol(protocol) {
  assertPublicConfig(protocol)
  if (protocol.schemaVersion !== 'gaia2-protocol-v1') throw new Error('unsupported protocol schema')
  const capabilities = ['execution', 'search', 'adaptability', 'time', 'ambiguity']
  for (const kind of ['source', 'submission']) {
    const data = protocol.datasets?.[kind]
    if (!data?.id || !/^[0-9a-f]{40}$/.test(data.revision || '') || !data.split || !Array.isArray(data.configs) || new Set(data.configs).size !== data.configs.length) throw new Error(`invalid ${kind} dataset protocol`)
    const expected = kind === 'source' ? capabilities : [...capabilities, 'mini']
    if (digest([...data.configs].sort()) !== digest(expected.sort())) throw new Error(`${kind} dataset capabilities do not match protocol`)
  }
  if (protocol.datasets.submission.id !== 'meta-agents-research-environments/gaia2' || protocol.datasets.submission.split !== 'validation') throw new Error('official submission dataset must use gaia2/validation')
  if (protocol.modes?.internal_pass5?.initialRunsPerScenario !== 5 || protocol.modes?.official_submission?.initialRunsPerScenario !== 3) throw new Error('invalid initial attempt counts')
  if (protocol.modes.official_submission.maxCorrections !== 0) throw new Error('official mode cannot enable correction')
  for (const [mode, expectedPhases, kind] of [['internal_pass5', ['standard'], 'source'], ['official_submission', ['standard', 'agent2agent', 'noise'], 'submission']]) {
    const policy = protocol.modes[mode]
    if (digest(policy.phases) !== digest(expectedPhases) || policy.datasetKind !== kind) throw new Error(`${mode} has invalid phases or dataset kind`)
    if (!Number.isInteger(policy.maxCorrections) || policy.maxCorrections < 0) throw new Error(`${mode} has invalid correction budget`)
  }
  const modelKeys = new Set(['actor', 'judge', 'configurationSource', 'endpointReference', 'credentialReference', 'sourceProtocol'])
  for (const key of Object.keys(protocol.models ?? {})) if (!modelKeys.has(key)) throw new Error(`unknown model configuration field ${key}`)
  for (const role of ['actor', 'judge']) {
    const model = protocol.models?.[role]
    if (!model?.model || model.protocol !== 'chat-completions' || model.provider !== 'local' || Object.keys(model).some((key) => !['model', 'provider', 'protocol'].includes(key))) throw new Error(`invalid ${role} model configuration`)
  }
  for (const key of ['configurationSource', 'endpointReference', 'credentialReference', 'sourceProtocol']) if (typeof protocol.models[key] !== 'string' || !protocol.models[key]) throw new Error(`missing model configuration ${key}`)
  for (const key of ['areVersion', 'python', 'officialPythonPath', 'backendRoot', 'pluginSourceRoot']) if (typeof protocol.runtime?.[key] !== 'string' || !protocol.runtime[key]) throw new Error(`missing runtime configuration ${key}`)
  positiveNumber(protocol.requestedRuntime?.processTimeoutMinutes, 'processTimeoutMinutes', { zero: true })
  positiveNumber(protocol.requestedRuntime?.scenarioTimeoutSeconds, 'scenarioTimeoutSeconds')
  positiveNumber(protocol.requestedRuntime?.modelRequestTimeoutSeconds, 'modelRequestTimeoutSeconds')
  if (!Number.isInteger(protocol.requestedRuntime?.concurrency) || protocol.requestedRuntime.concurrency < 1) throw new Error('invalid requested concurrency')
  return protocol
}

export function parseIndex(path) {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
}

function seed(rootSeed, phase, config, id, runNumber) {
  return createHash('sha256').update(JSON.stringify([rootSeed, phase, config, id, runNumber])).digest().readUInt32BE(0)
}

export function buildRunManifest({ root, protocol, index, lockRefs, entrypoints, mode = 'internal_pass5', perCapability, miniLimit, runId = randomUUID(), rootSeed = protocol.rootSeed }) {
  validateProtocol(protocol)
  if (!protocol.modes[mode]) throw new Error(`unsupported mode ${mode}`)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(runId)) throw new Error('invalid run ID')
  if (!Number.isInteger(rootSeed) || rootSeed < 0 || rootSeed > 0xffffffff) throw new Error('rootSeed must be an unsigned 32-bit integer')
  const policy = protocol.modes[mode]
  const datasetKind = policy.datasetKind
  const dataset = protocol.datasets[datasetKind]
  const capabilities = dataset.configs.filter((name) => name !== 'mini')
  const limit = perCapability ?? (mode === 'internal_pass5' ? 1 : null)
  for (const [name, value] of [['perCapability', limit], ['miniLimit', miniLimit]]) if (value !== undefined && value !== null && (!Number.isInteger(value) || value <= 0)) throw new Error(`${name} must be a positive integer`)
  const selection = []
  for (const phase of policy.phases) {
    const configs = phase === 'standard' ? capabilities : ['mini']
    for (const config of configs) {
      const rows = index.filter((item) => config === 'mini' ? item.datasetKind === 'mini' && item.config === 'mini' : item.datasetKind === datasetKind && item.config === config).sort((a, b) => a.rowIndex - b.rowIndex)
      const wanted = config === 'mini' ? miniLimit ?? rows.length : limit ?? rows.length
      if (!rows.length || wanted > rows.length) throw new Error(`insufficient scenarios for ${phase}/${config}`)
      const seenIds = new Set()
      for (const row of rows) {
        if (seenIds.has(row.id)) throw new Error(`duplicate scenario ID in ${datasetKind}/${config}: ${row.id}`)
        if (!row.id || !Number.isInteger(row.rowIndex) || !/^[0-9a-f]{64}$/.test(row.scenarioHash || '')) throw new Error(`invalid scenario index entry for ${config}`)
        seenIds.add(row.id)
      }
      for (const row of rows.slice(0, wanted)) {
        for (let runNumber = 1; runNumber <= policy.initialRunsPerScenario; runNumber++) selection.push({ phase, config, scenarioId: row.id, rowIndex: row.rowIndex, sourcePath: row.path, scenarioHash: row.scenarioHash, scenarioVersion: row.scenarioVersion, runNumber, seed: seed(rootSeed, phase, config, row.id, runNumber) })
      }
    }
  }
  const planBasis = { mode, dataset: { id: dataset.id, revision: dataset.revision, split: dataset.split }, models: protocol.models, policy, rootSeed, lockRefs, entrypoints, selection }
  const planFingerprint = digest(planBasis)
  const runRoot = join('runs', runId)
  const tasks = selection.map((task) => {
    const executionId = `${task.phase}-${task.config}-${digest([task.scenarioId, task.runNumber]).slice(0, 16)}`
    return { ...task, executionId, attemptIndex: mode === 'internal_pass5' ? task.runNumber : null, correctionOrdinal: 0, outputDir: join(runRoot, 'executions', executionId), fixtureDir: join(runRoot, 'fixtures', executionId), workspaceDir: join(runRoot, 'workspaces', executionId) }
  })
  const fullCoverage = mode === 'official_submission' && limit === null && miniLimit === undefined
  return {
    schemaVersion: 'gaia2-run-manifest-v1', runId, generatedAt: new Date().toISOString(), mode, planFingerprint,
    dataset: { kind: datasetKind, id: dataset.id, revision: dataset.revision, split: dataset.split },
    models: protocol.models, policy: { initialRunsPerScenario: policy.initialRunsPerScenario, maxCorrections: policy.maxCorrections, seedBinding: policy.seedBinding, learningPolicy: protocol.learningPolicy },
    rootSeed, requestedRuntime: protocol.requestedRuntime, entrypoints, lockRefs,
    selection: { perCapability: limit, miniLimit: miniLimit ?? null, expectedInitialExecutions: tasks.length, fullOfficialCoverage: fullCoverage },
    runRoot, tasks, stateFile: join(runRoot, 'run-state.json'),
    executionBinding: 'manifest_driven_standard_only_real_hooks_pending_phase3',
  }
}

export function loadRunInputs(root) {
  const paths = { protocol: 'config/phase0-protocol.json', environment: 'locks/environment-lock.json', capabilities: 'locks/capability-inventory.json', dataset: 'locks/dataset-lock.json', scenarioIndex: 'data/scenario-index.jsonl' }
  for (const path of Object.values(paths)) if (!existsSync(join(root, path))) throw new Error(`missing phase0 artifact: ${path}`)
  const lockRefs = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, { path, sha256: fileDigest(join(root, path)) }]))
  return { protocol: validateProtocol(readJson(join(root, paths.protocol))), environment: readJson(join(root, paths.environment)), capabilities: readJson(join(root, paths.capabilities)), datasetLock: readJson(join(root, paths.dataset)), index: parseIndex(join(root, paths.scenarioIndex)), lockRefs }
}

export function saveRunManifest(root, manifest) {
  assertPublicConfig(manifest)
  const output = resolve(root, manifest.runRoot, 'run-manifest.json')
  if (!within(join(root, 'runs'), output)) throw new Error('run path escapes output root')
  const { manifestHash, ...contents } = manifest
  writeJson(output, { ...contents, manifestHash: digest(contents) }, { immutable: true })
  return output
}
