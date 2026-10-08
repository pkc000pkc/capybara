import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

const PLUGINS = ['gaia2-runtime', 'gaia2-evaluation']
const EXCLUDED = new Set(['.git', '__pycache__', 'node_modules'])
const CODE_DIRS = ['src', 'scripts', 'test', 'schemas', 'config']
const ARE_PROTOCOL_FILES = [
  'simulation/scenario_runner.py', 'simulation/scenarios/scenario.py',
  'simulation/environment.py', 'simulation/types.py', 'simulation/tools.py',
  'simulation/time_manager.py', 'simulation/notification_system.py',
  'simulation/data_handler/importer.py', 'simulation/data_handler/exporter.py',
  'simulation/validation/base.py', 'simulation/benchmark.py',
]
const normalized = (value) => value.replaceAll('\\', '/')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const secretName = (name) => /^(?:llm-config(?:\.|$)|secrets(?:\.|$)|\.env(?:\.|$))/i.test(name)
function assert(condition, message) { if (!condition) throw new Error(`Phase 0 inventory: ${message}`) }
function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch (error) { throw new Error(`Phase 0 inventory: unreadable JSON ${path}: ${error.message}`) }
}
function inside(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
function safePath(root, path, label) {
  assert(typeof path === 'string' && path.trim() && !isAbsolute(path), `${label} must be relative`)
  assert(!normalized(path).split('/').includes('..'), `${label} must not traverse parents`)
  const target = resolve(root, path)
  assert(inside(root, target), `${label} escapes root`)
  assert(existsSync(target), `${label} missing: ${path}`)
  assert(!lstatSync(target).isSymbolicLink(), `${label} must not be a symbolic link`)
  assert(inside(realpathSync(root), realpathSync(target)), `${label} resolves outside root`)
  return target
}

/** Stable content-only tree hash: no mtimes, mode bits, git metadata, or Python bytecode. */
export function hashTree(root, { excludeSecrets = false } = {}) {
  assert(existsSync(root) && lstatSync(root).isDirectory(), `tree root missing: ${root}`)
  assert(!lstatSync(root).isSymbolicLink(), `tree root must not be a symbolic link: ${root}`)
  const files = []
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (EXCLUDED.has(entry.name) || /\.py[co]$/i.test(entry.name) || (excludeSecrets && secretName(entry.name))) continue
      const path = join(dir, entry.name)
      assert(!lstatSync(path).isSymbolicLink(), `tree symbolic link is not a frozen resource: ${path}`)
      if (entry.isDirectory()) visit(path)
      else {
        assert(entry.isFile(), `unsupported tree entry: ${path}`)
        const content = readFileSync(path)
        files.push({ relativePath: normalized(relative(root, path)), sha256: sha256(content), bytes: content.length })
      }
    }
  }
  visit(root)
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'en'))
  return { treeSha256: sha256(JSON.stringify(files)), files }
}

/** Never use a live user directory as the frozen plugin's runtime path. */
export function freezePluginSnapshot({ root, id, sourceRoot }) {
  assert(PLUGINS.includes(id), `unsupported plugin id: ${id}`)
  const source = resolve(sourceRoot)
  const tree = hashTree(source)
  const cacheRoot = resolve(root, '.phase0-cache', 'plugins', id)
  const snapshotRoot = join(cacheRoot, tree.treeSha256)
  assert(!inside(source, snapshotRoot) && !inside(snapshotRoot, source), 'plugin snapshot must be isolated from its source')
  mkdirSync(cacheRoot, { recursive: true })
  assert(!lstatSync(cacheRoot).isSymbolicLink(), 'plugin cache must not be a symbolic link')
  const realCacheRoot = realpathSync(cacheRoot)
  const realSource = realpathSync(source)
  assert(inside(realpathSync(root), realCacheRoot), 'plugin cache resolves outside project')
  assert(!inside(realSource, realCacheRoot) && !inside(realCacheRoot, realSource), 'plugin cache resolves into source; snapshot isolation required')
  if (!existsSync(snapshotRoot)) {
    const staging = mkdtempSync(join(cacheRoot, '.staging-'))
    try {
      for (const file of tree.files) {
        const destination = join(staging, file.relativePath)
        mkdirSync(dirname(destination), { recursive: true })
        copyFileSync(join(source, file.relativePath), destination)
      }
      assert(hashTree(staging).treeSha256 === tree.treeSha256, `${id} source changed during snapshot copy`)
      for (const file of tree.files) chmodSync(join(staging, file.relativePath), 0o444)
      renameSync(staging, snapshotRoot)
    } catch (error) {
      // This is our fresh staging directory, never an existing snapshot or source.
      for (const file of tree.files) {
        const path = join(staging, file.relativePath)
        if (existsSync(path)) chmodSync(path, 0o644)
      }
      if (existsSync(staging)) rmSync(staging, { recursive: true })
      throw error
    }
  }
  const frozen = hashTree(snapshotRoot)
  assert(frozen.treeSha256 === tree.treeSha256, `${id} immutable snapshot integrity mismatch; refusing to overwrite`)
  assert(realpathSync(snapshotRoot) !== realpathSync(source), `${id} snapshot aliases source`)
  return {
    id, sourceRoot: normalized(source), snapshotRoot: normalized(snapshotRoot),
    treeSha256: tree.treeSha256, files: tree.files,
    immutablePolicy: 'content-addressed-readonly-files-never-overwrite-verify-before-use',
  }
}

export function inspectPluginResources(snapshot) {
  const root = snapshot.snapshotRoot
  const manifest = readJson(safePath(root, 'capybara.plugin.json', 'plugin manifest'))
  assert(manifest.schemaVersion === 1 && manifest.id === snapshot.id && manifest.version === '1.0.0', `${snapshot.id} manifest must declare schemaVersion 1 and version 1.0.0`)
  const resources = manifest.resources
  assert(isObject(resources), `${snapshot.id} resources declaration missing`)
  assert(Object.keys(resources).every((key) => ['variables', 'harnesses', 'hooks', 'trainingHooks'].includes(key)), `${snapshot.id} unknown resource declaration`)
  const variables = readJson(safePath(root, resources.variables, 'variables resource'))
  assert(variables.version === 1 && Array.isArray(variables.variables) && variables.variables.length > 0, `${snapshot.id} variables format invalid`)
  const variableKeys = new Set()
  for (const variable of variables.variables) {
    assert(isObject(variable) && /^[a-z][a-z0-9_]*$/.test(variable.key) && !variableKeys.has(variable.key), `${snapshot.id} variable key invalid or duplicate`)
    variableKeys.add(variable.key)
    assert(['text', 'object'].includes(variable.type) && typeof variable.required === 'boolean' && typeof variable.readonly === 'boolean', `${snapshot.id} typed variable shape invalid: ${variable.key}`)
    assert(variable.type === 'text' ? typeof variable.value === 'string' : isObject(variable.value), `${snapshot.id} variable value does not match declared type: ${variable.key}`)
    assert(['project', 'session'].includes(variable.scope), `${snapshot.id} variable scope invalid: ${variable.key}`)
  }
  assert(Array.isArray(resources.harnesses) && resources.harnesses.length > 0, `${snapshot.id} harness declaration missing`)
  const harnesses = []
  for (const path of resources.harnesses) {
    const manifestFile = safePath(root, path, 'harness manifest')
    const harnessManifest = readJson(manifestFile)
    assert(harnessManifest.version === 1 && harnessManifest.package === snapshot.id && Array.isArray(harnessManifest.harnesses) && harnessManifest.harnesses.length > 0, `${snapshot.id} harness manifest format invalid`)
    for (const harness of harnessManifest.harnesses) {
      assert(isObject(harness) && typeof harness.name === 'string' && typeof harness.description === 'string' && typeof harness.type === 'string' && isObject(harness.activation), `${snapshot.id} harness definition format invalid`)
      assert(Array.isArray(harness.inputs) && harness.inputs.every((input) => typeof input === 'string') && Array.isArray(harness.requiredTools), `${snapshot.id} harness inputs/tools invalid`)
      const template = safePath(dirname(manifestFile), harness.entry, 'harness template')
      assert(readFileSync(template, 'utf8').trim().length > 0, `${snapshot.id} harness template empty`)
      harnesses.push({ name: harness.name, type: harness.type, manifestPath: path, entryPath: normalized(relative(root, template)), sha256: sha256(readFileSync(template)) })
    }
  }
  const hookResources = {}
  for (const kind of ['hooks', 'trainingHooks']) {
    const declaration = resources[kind] ?? []
    assert(Array.isArray(declaration), `${snapshot.id} ${kind} must be an array`)
    if (kind === 'hooks' || snapshot.id === 'gaia2-evaluation') assert(declaration.length > 0, `${snapshot.id} ${kind} declaration missing`)
    hookResources[kind] = []
    for (const path of declaration) {
      const target = safePath(root, path, kind)
      const paths = lstatSync(target).isDirectory()
        ? hashTree(target).files.map((file) => join(target, file.relativePath)) : [target]
      assert(paths.length > 0 && paths.every((file) => file.endsWith('.ts')), `${snapshot.id} ${kind} must contain readable TypeScript files`)
      for (const file of paths) {
        const source = readFileSync(file, 'utf8')
        assert(/export\s+default\s+defineHook\s*\(/.test(source) && /from\s+["']@capybara-agent\/sdk["']/.test(source), `${snapshot.id} ${kind} lacks the expected defineHook resource shape`)
        const name = source.match(/\bname\s*:\s*["']([^"']+)["']/)?.[1]
        const checkpoint = source.match(/\bcheckpoint\s*:\s*["']([^"']+)["']/)?.[1]
        assert(name && checkpoint && /\brun\s*\(/.test(source), `${snapshot.id} ${kind} lacks name/checkpoint/run`)
        hookResources[kind].push({ name, checkpoint, path: normalized(relative(root, file)), sha256: sha256(source), inspection: 'static-resource-shape-only-not-executed' })
      }
    }
  }
  return {
    ...snapshot, version: manifest.version, manifest: { schemaVersion: manifest.schemaVersion, id: manifest.id, version: manifest.version, resources },
    resourceIntegrity: { status: 'passed', declarationComplete: true, variablesReadable: true, harnessesReadable: true, hookSourcesReadable: true },
    variables: { path: resources.variables, count: variables.variables.length, keys: [...variableKeys], typedObjectCount: variables.variables.filter((variable) => variable.type === 'object').length },
    harnesses, ...hookResources,
    pluginLoadStatus: 'not_loaded', runtimeBinding: 'sidecar_only', effectiveHookDecision: false,
  }
}

export function collectCodeInputs(root) {
  const inputs = []
  for (const directory of CODE_DIRS) {
    if (!existsSync(join(root, directory))) continue
    for (const file of hashTree(join(root, directory), { excludeSecrets: true }).files) {
      inputs.push({ path: `${directory}/${file.relativePath}`, sha256: file.sha256, bytes: file.bytes })
    }
  }
  const fixed = ['package.json', 'package-lock.json', 'gaia2-model-config.json', 'gaia2-runner-manifest.json']
  const requirements = readdirSync(root).filter((name) => /^requirements.*\.(txt|in)$/.test(name))
  for (const path of [...fixed, ...requirements]) {
    if (!existsSync(join(root, path))) continue
    assert(!lstatSync(join(root, path)).isSymbolicLink(), `code input is a symbolic link: ${path}`)
    const bytes = readFileSync(join(root, path))
    inputs.push({ path, sha256: sha256(bytes), bytes: bytes.length })
  }
  return inputs.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

function command(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true })
  assert(!result.error && result.status === 0, `${basename(command)} metadata command failed (${result.error?.code ?? result.status}); no model was started`)
  return result.stdout.trim()
}
function gitProvenance(root, { allowNoGit = false } = {}) {
  const result = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
  if (result.error || result.status !== 0) {
    assert(allowNoGit, `git provenance unavailable at ${root}`)
    return { status: 'not_git', root: normalized(root), head: null, dirty: null, contentLockedSeparately: true }
  }
  const head = command('git', ['-C', root, 'rev-parse', 'HEAD'], root)
  const porcelain = command('git', ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'], root)
  return { status: 'captured', root: normalized(resolve(result.stdout.trim())), head, gitHead: head, dirty: porcelain.length > 0, statusSha256: sha256(porcelain), dirtyEntryCount: porcelain.split('\0').filter(Boolean).length }
}
function nodeDependencies(root) {
  const lock = readJson(join(root, 'package-lock.json'))
  const manifest = readJson(join(root, 'package.json'))
  assert(isObject(lock.packages), `npm lock lacks package entries: ${root}`)
  const installed = []
  for (const name of Object.keys(manifest.dependencies ?? {}).sort()) {
    const expected = lock.packages[`node_modules/${name}`]?.version
    const pkg = readJson(join(root, 'node_modules', name, 'package.json'))
    assert(expected && pkg.version === expected, `installed npm dependency differs from lock: ${name}`)
    installed.push({ name, version: pkg.version, packageJsonSha256: sha256(readFileSync(join(root, 'node_modules', name, 'package.json'))) })
  }
  return {
    packageLockSha256: sha256(readFileSync(join(root, 'package-lock.json'))), installedDirect: installed,
    locked: Object.entries(lock.packages).filter(([path]) => path).map(([path, pkg]) => ({ path, version: pkg.version ?? null, integrity: pkg.integrity ?? null })).sort((a, b) => a.path.localeCompare(b.path, 'en')),
  }
}
function pythonMetadata(python, officialPythonPath) {
  // -I -S avoids PYTHONPATH/sitecustomize and never imports ARE, litellm or a model client.
  const code = [
    'import importlib.metadata as m, json, platform, sys',
    'rows = []',
    'for d in m.distributions(path=[sys.argv[1]]):',
    ' rows.append({"name": d.metadata["Name"], "version": d.version})',
    'print(json.dumps({"version": platform.python_version(), "executable": sys.executable, "implementation": platform.python_implementation(), "installed": sorted(rows, key=lambda x: (x["name"].lower(), x["version"]))}))',
  ].join('\n')
  let result
  try { result = JSON.parse(command(python, ['-I', '-S', '-c', code, officialPythonPath], officialPythonPath)) }
  catch (error) { throw new Error(`Phase 0 inventory: Python distribution metadata capture failed: ${error.message}`) }
  assert(typeof result.version === 'string' && Array.isArray(result.installed), 'Python metadata result has unknown format')
  const distInfo = readdirSync(officialPythonPath).filter((name) => name.endsWith('.dist-info')).sort()
  result.metadataInputs = []
  for (const dir of distInfo) for (const name of ['METADATA', 'RECORD', 'WHEEL']) {
    const path = join(officialPythonPath, dir, name)
    if (existsSync(path)) result.metadataInputs.push({ path: normalized(path), sha256: sha256(readFileSync(path)) })
  }
  return { ...result, executable: normalized(resolve(python)), executableSha256: sha256(readFileSync(python)), officialPythonPath: normalized(officialPythonPath), importPolicy: 'stdlib-metadata-only-isolated-no-site-no-ARE-import' }
}

/** The current bridge emits events; the Node sidecar consumes them after execution. */
export function inspectRuntimeBinding(root, backendRoot) {
  const paths = [
    'scripts/official_e2e_smoke.mjs', 'scripts/capybara_official_bridge.py',
    'scripts/official_integrated_pilot.mjs', 'src/runtime_attempt.mjs', 'src/pass5_orchestrator.mjs',
  ]
  const sources = paths.map((path) => readFileSync(join(root, path), 'utf8'))
  const checks = [
    { path: paths[0], check: 'installs-python-bridge-before-ARE-main', passed: /from capybara_official_bridge import install; install\(\); from are\.simulation\.benchmark import main; main\(\)/.test(sources[0]) },
    { path: paths[1], check: 'patches-ARE-ScenarioRunner-agent-method', passed: /scenario_runner\.ScenarioRunner\._run_with_agent\s*=\s*_native_run_with_agent/.test(sources[1]) },
    { path: paths[1], check: 'writes-runtime-events-to-sidecar-file', passed: /GAIA2_RUNTIME_EVENT_FILE/.test(sources[1]) && /def _emit_runtime_event\(/.test(sources[1]) },
    { path: paths[2], check: 'ingests-event-file-after-runOfficialOnce-returns', passed: /const execution = runOfficialOnce\([\s\S]*?ingestHookEventsForReport\(execution\.official\.eventPath\)/.test(sources[2]) && /attempt\.recordHookEvent\(/.test(sources[2]) },
    { path: paths[3], check: 'records-sidecar-events-without-plugin-execution', passed: /recordHookEvent\(event = \{\}\)/.test(sources[3]) },
    { path: paths[4], check: 'local-runtime-before-external-runner', passed: /await attempt\.run\([\s\S]*?await runAttempt\(/.test(sources[4]) },
  ]
  for (const check of checks) assert(check.passed, `unknown runtime binding: ${check.path}: ${check.check}`)
  const projectSources = collectCodeInputs(root).filter((file) => /^(?:src|scripts)\/.*\.(?:mjs|js|ts|py)$/.test(file.path))
  const backendSources = hashTree(join(backendRoot, 'src'), { excludeSecrets: true }).files.filter((file) => /\.(?:ts|js|mjs)$/.test(file.relativePath))
  // Search executable import/load/registration syntax, not arbitrary mention strings.
  const loaderPattern = /(?:from\s*["'][^"']*(?:@capybara-agent\/sdk|plugin-loader)[^"']*["']|import\s*\([^)]*capybara\.plugin|(?:loadPlugins|registerPlugin|PluginLoader)\s*\()/
  const projectLoaderEvidence = projectSources.filter((file) => file.path !== 'src/phase0_inventory.mjs' && loaderPattern.test(readFileSync(join(root, file.path), 'utf8'))).map((file) => file.path)
  const backendLoaderEvidence = backendSources.filter((file) => loaderPattern.test(readFileSync(join(backendRoot, 'src', file.relativePath), 'utf8'))).map((file) => `src/${file.relativePath}`)
  assert(projectLoaderEvidence.length === 0 && backendLoaderEvidence.length === 0, 'plugin loader wiring changed; manual boundary review required, not assumed loaded')
  return {
    pluginLoadStatus: 'not_loaded', runtimeBinding: 'sidecar_only', effectiveHookDecision: false,
    checks, inspectedProjectSourceCount: projectSources.length, inspectedBackendSourceCount: backendSources.length,
    projectPluginLoader: { status: 'not_present_in_inspected_wiring', evidence: projectLoaderEvidence },
    backendPluginLoader: { status: 'not_present_in_inspected_wiring', evidence: backendLoaderEvidence },
    limitations: ['Static inspection of known runner paths is not a runtime hook load test.', 'TypeScript plugin hooks do not intercept model/tool execution in the Python bridge.', 'RuntimeAttempt events are recorded after the official process returns.'],
  }
}
function backendCompatibility(backendRoot, plugins) {
  const variablesPath = join(backendRoot, 'src/core/project-resources.ts')
  const harnessPath = join(backendRoot, 'src/core/harnesses/harness-registry.ts')
  const variablesSource = readFileSync(variablesPath, 'utf8')
  const harnessSource = readFileSync(harnessPath, 'utf8')
  assert(/typeof item\.value !== 'string'/.test(variablesSource), 'unknown backend variable schema; manual review required')
  assert(/type:\s*\{\s*enum:\s*\['model', 'tool', 'experience'\]/.test(harnessSource), 'unknown backend harness schema; manual review required')
  return {
    status: 'known_gaps', resourceIntegrityFailure: false,
    schemaEvidence: [{ path: normalized(variablesPath), sha256: sha256(variablesSource) }, { path: normalized(harnessPath), sha256: sha256(harnessSource) }],
    gaps: [
      { id: 'typed-variable-values', message: 'Backend SystemVariableDefinition requires string values; GAIA2 resources intentionally contain typed object values.', affectedPlugins: plugins.filter((plugin) => plugin.variables.typedObjectCount).map((plugin) => plugin.id) },
      { id: 'persistent-harness-type', message: 'Backend HarnessRegistry accepts model/tool/experience, not the declared persistent harness type.', affectedPlugins: plugins.filter((plugin) => plugin.harnesses.some((harness) => harness.type === 'persistent')).map((plugin) => plugin.id) },
      { id: 'no-plugin-loader', message: 'The inspected main runner/backend do not load these plugin manifests or execute their TypeScript hooks.', affectedPlugins: PLUGINS },
    ],
  }
}

export function freezeInventory({ root, protocol } = {}) {
  assert(typeof root === 'string' && existsSync(root), 'root is required')
  root = resolve(root)
  const runtime = protocol?.runtime
  assert(isObject(runtime), 'protocol.runtime is required')
  for (const key of ['areVersion', 'python', 'officialPythonPath', 'backendRoot', 'pluginSourceRoot']) assert(typeof runtime[key] === 'string' && runtime[key].trim(), `protocol.runtime.${key} is required`)
  const python = resolve(root, runtime.python)
  const officialPythonPath = resolve(root, runtime.officialPythonPath)
  const backendRoot = resolve(root, runtime.backendRoot)
  const pluginSourceRoot = resolve(root, runtime.pluginSourceRoot)
  const capturedAt = new Date().toISOString()
  const py = pythonMetadata(python, officialPythonPath)
  const installedAre = py.installed.filter((dist) => dist.name.toLowerCase().replaceAll('_', '-') === 'meta-agents-research-environments')
  assert(installedAre.length === 1 && installedAre[0].version === runtime.areVersion, `ARE installed version must exactly equal ${runtime.areVersion}`)
  const areRoot = join(officialPythonPath, 'are')
  const areTree = hashTree(areRoot)
  const keyProtocols = ARE_PROTOCOL_FILES.map((path) => {
    const file = safePath(areRoot, path, 'ARE protocol file')
    return { path: normalized(file), relativePath: path, sha256: sha256(readFileSync(file)) }
  })
  const binding = inspectRuntimeBinding(root, backendRoot)
  const plugins = PLUGINS.map((id) => inspectPluginResources(freezePluginSnapshot({ root, id, sourceRoot: join(pluginSourceRoot, id) })))
  const compatibility = backendCompatibility(backendRoot, plugins)
  const codeInputs = collectCodeInputs(root)
  const backendCodeInputs = collectCodeInputs(backendRoot)
  const bridgeSha256 = sha256(readFileSync(join(root, 'scripts/capybara_official_bridge.py')))
  const environment = {
    schemaVersion: 'gaia2-environment-lock-v1', generatedAt: capturedAt,
    timeSource: 'client-system-clock-new-Date-ISO-not-authoritative-dataset-time',
    noModelExecution: true, secretConfigRead: false,
    node: { version: process.versions.node, executable: normalized(process.execPath), executableSha256: sha256(readFileSync(process.execPath)), platform: process.platform, arch: process.arch, dependencyVersions: nodeDependencies(root) },
    python: py,
    are: { distribution: installedAre[0].name, version: installedAre[0].version, requestedVersion: runtime.areVersion, root: normalized(areRoot), contentTreeSha256: areTree.treeSha256, fileCount: areTree.files.length, keyProtocols },
    packageLockSha256: sha256(readFileSync(join(root, 'package-lock.json'))), bridgeSha256,
    codeInputs, contentTreeSha256: sha256(JSON.stringify(codeInputs)),
    officialCodeInputs: areTree.files.map((file) => ({ path: normalized(join(areRoot, file.relativePath)), relativePath: file.relativePath, sha256: file.sha256, bytes: file.bytes })),
    backend: { root: normalized(backendRoot), codeInputs: backendCodeInputs, contentTreeSha256: sha256(JSON.stringify(backendCodeInputs)), dependencyVersions: nodeDependencies(backendRoot) },
    git: { project: gitProvenance(root), backend: gitProvenance(backendRoot), pluginSource: gitProvenance(pluginSourceRoot, { allowNoGit: true }) },
    hashingPolicy: { algorithm: 'sha256', treeEncoding: 'JSON.stringify(sorted [{relativePath,sha256,bytes}])', excluded: [...EXCLUDED, '*.pyc', '*.pyo', 'secret file names'], codeDirectories: CODE_DIRS, generatedArtifactsExcluded: ['locks', '.phase0-cache', 'data', 'reports', 'official-results', 'runs', '.official-fixtures'] },
  }
  const capabilities = {
    schemaVersion: 'gaia2-capability-inventory-v1', generatedAt: capturedAt, noModelExecution: true,
    plugins, runtime: binding, backendCompatibility: compatibility,
    pluginLoadStatus: binding.pluginLoadStatus, runtimeBinding: binding.runtimeBinding,
    effectiveHookDecision: binding.effectiveHookDecision,
    stage0Status: 'frozen_with_known_runtime_gaps', resourceIntegrity: 'passed',
    scope: 'inventory-and-freeze-only-not-stage3-real-hook-integration',
  }
  mkdirSync(join(root, 'locks'), { recursive: true })
  for (const [name, content] of [['environment-lock.json', environment], ['capability-inventory.json', capabilities]]) {
    writeFileSync(join(root, 'locks', name), `${JSON.stringify(content, null, 2)}\n`, 'utf8')
  }
  return { environment, capabilities }
}
