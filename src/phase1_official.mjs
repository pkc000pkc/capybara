import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { canonicalScenarioHash } from './phase0_dataset.mjs'
import { assertPublicConfig, digest, fileDigest, readJson, within } from './phase0_run.mjs'
import { runChildProcess } from './phase1_process.mjs'
import { startRuntimeHookService } from './phase3_hook_service.mjs'
import { collectRuntimeEvidence } from './phase3_runtime_evidence.mjs'
import { assertInitialHasNoCorrection } from './phase4_replay_authority.mjs'
import { safeEvidenceGateCode } from './phase1_diagnostics.mjs'
import { writeOfficialEntryManifest } from './phase1_official_entry.mjs'

function assert(condition, message) { if (!condition) throw new Error(`Phase 1 adapter: ${message}`) }
function portable(path) { return path.replaceAll('\\', '/') }

export function resolveModelRetrySettings(env = process.env) {
  const fields = { maxAttempts: ['GAIA2_MODEL_MAX_ATTEMPTS', 6], backoffBaseSeconds: ['GAIA2_MODEL_BACKOFF_BASE_SECONDS', 2], backoffMaxSeconds: ['GAIA2_MODEL_BACKOFF_MAX_SECONDS', 120], maxRetryWaitSeconds: ['GAIA2_MODEL_MAX_RETRY_WAIT_SECONDS', 3600] }
  const result = {}
  for (const [key, [name, fallback]] of Object.entries(fields)) {
    const value = env[name] === undefined ? fallback : Number(env[name])
    assert(env[name] === undefined || /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(env[name]), `invalid ${name}`)
    assert(Number.isFinite(value) && value >= 0 && value <= 2147483 && (key !== 'maxAttempts' || Number.isInteger(value) && value > 0), `invalid ${name}`)
    result[key] = value
  }
  return result
}

export function readModelConnection(root, models) {
  const config = readJson(resolve(root, models.configurationSource))
  const lines = readFileSync(config.apiKeySource, 'utf8').split(/\r?\n/)
  const baseUrl = lines.find(line => /^base_url\s*:/i.test(line))?.replace(/^base_url\s*:\s*/i, '').trim()
  const apiKey = lines.find(line => /^key\s*[:=]/i.test(line))?.replace(/^key\s*[:=]\s*/i, '').trim()
  assert(baseUrl && apiKey, 'external configuration must provide endpoint and key')
  assertPublicConfig({ endpoint: baseUrl })
  assert(/^https?:\/\//i.test(baseUrl), 'model endpoint must use HTTP(S)')
  return { baseUrl, apiKey }
}

export function modelRuntimeEnvironment(settings) {
  const retry = settings.modelRetry
  return { GAIA2_E2E_LLM_TIMEOUT_SECONDS: String(settings.modelRequestTimeoutSeconds), REQUEST_TIMEOUT: String(settings.modelRequestTimeoutSeconds), GAIA2_MODEL_MAX_ATTEMPTS: String(retry.maxAttempts), GAIA2_MODEL_BACKOFF_BASE_SECONDS: String(retry.backoffBaseSeconds), GAIA2_MODEL_BACKOFF_MAX_SECONDS: String(retry.backoffMaxSeconds), GAIA2_MODEL_MAX_RETRY_WAIT_SECONDS: String(retry.maxRetryWaitSeconds) }
}

// ARE manifests use ``local`` for an OpenAI-compatible endpoint.  LiteLLM
// needs the transport provider explicitly; otherwise arbitrary model names
// such as gpt-6-luna are rejected before the request reaches the endpoint.
export function resolveTransportProvider(value) {
  return value === 'local' || value == null ? 'openai' : value
}

export function fixtureFromScenario(scenario, task) {
  assert(canonicalScenarioHash(scenario) === task.scenarioHash, 'scenario content differs from frozen task')
  assert(scenario.metadata?.definition?.scenario_id === task.scenarioId && scenario.version === task.scenarioVersion, 'scenario identity/version differs')
  const fixture = structuredClone(scenario)
  // ARE num_runs=1 preserves imported run_number. Do not modify duration, events, apps, oracle or dataset seed.
  fixture.metadata.definition.run_number = task.runNumber
  return fixture
}

function walk(dir) {
  const result = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    assert(!lstatSync(path).isSymbolicLink(), 'native output contains a symbolic link')
    if (entry.isDirectory()) result.push(...walk(path))
    else if (entry.isFile()) result.push(path)
  }
  return result
}

export function readNativeResult({ root, outputDir, task, session, events = [] }) {
  const output = resolve(root, outputDir)
  const files = walk(output).filter(path => path.endsWith('output.jsonl'))
  const rows = files.flatMap(path => readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(line => ({ path, row: JSON.parse(line) })))
  assert(rows.length === 1, 'expected exactly one native result for this session')
  const { row, path } = rows[0], metadata = row.metadata ?? {}
  assert(row.task_id === task.scenarioId && metadata.scenario_id === task.scenarioId, 'native result belongs to another scenario')
  assert(typeof row.trace_id === 'string', 'native trace reference is missing')
  const tracePath = isAbsolute(row.trace_id) ? resolve(row.trace_id) : resolve(dirname(path), row.trace_id)
  assert(within(output, tracePath) && existsSync(tracePath) && !lstatSync(tracePath).isSymbolicLink(), 'native trace escapes or is missing')
  const trace = readJson(tracePath)
  const definition = trace.metadata?.definition
  assert(definition?.scenario_id === task.scenarioId && definition.run_number === task.runNumber, 'trace scenario/run metadata differs')
  if (metadata.run_number !== undefined) assert(metadata.run_number === task.runNumber, 'native run number differs')
  const ownEvents = events.filter(event => event.executionId === task.executionId && event.sessionId === session.sessionId)
  assert(ownEvents.length === events.length, 'runtime events belong to another session')
  const validation = ownEvents.findLast(event => event.type === 'official_validation_completed')
  const hasException = metadata.has_exception === true || definition.has_exception === true || Boolean(metadata.exception_type || definition.exception_type)
  const businessPassed = row.score === 1 && metadata.status === 'success' ? true : row.score === 0 && metadata.status === 'failed' ? false : null
  const evaluationComplete = !hasException && typeof businessPassed === 'boolean' && validation?.hasException === false && validation.validationSuccess === businessPassed
  return {
    report: { scenarioId: task.scenarioId, runNumber: task.runNumber, evaluationComplete, businessPassed: evaluationComplete ? businessPassed : null, score: evaluationComplete ? row.score : null, status: metadata.status, hasException, exceptionType: hasException ? String(metadata.exception_type ?? definition.exception_type ?? 'UnknownException').replace(/[^A-Za-z0-9_]/g, '').slice(0, 80) : null, nativeEnvelopeHasRunNumber: metadata.run_number !== undefined },
    artifacts: [path, tracePath].map(file => ({ path: portable(relative(root, file)), sha256: fileDigest(file) })),
  }
}

export async function executeOfficialTask({ root, manifest, task, session, settings, signal }) {
  assert(['standard', 'agent2agent', 'noise'].includes(task.phase) && settings.minimal === false, 'unsupported official task phase')
  if (task.phase !== 'standard') {
    assert(manifest.mode === 'official_submission' && task.config === 'mini', 'enhanced phases require the official mini profile')
  }
  if ((task.correctionOrdinal ?? 0) === 0) assertInitialHasNoCorrection(task)
  else assert(task.correctionOrdinal === 1 && manifest.mode === 'correction_replay' && task.correctionContext, 'correction requires a separate fresh replay plan')
  assert(!process.env.GAIA2_E2E_TOOL_ALLOWLIST, 'smoke tool allowlist cannot be inherited by original tasks')
  const protocol = readJson(join(root, 'config/phase0-protocol.json'))
  const connection = readModelConnection(root, manifest.models)
  const file = await asyncBufferFromFile(resolve(root, task.sourcePath))
  const columns = ['scenario_id', manifest.dataset.kind === 'source' ? 'scenario' : 'data']
  const [row] = await parquetReadObjects({ file, columns, rowStart: task.rowIndex, rowEnd: task.rowIndex + 1, compressors })
  assert(row?.scenario_id === task.scenarioId, 'selected Parquet row differs from plan')
  const fixture = fixtureFromScenario(JSON.parse(row[columns[1]]), task)
  const datasetRoot = resolve(root, session.fixtureDir)
  const configDir = join(datasetRoot, task.config)
  mkdirSync(configDir, { recursive: true })
  const fixturePath = join(configDir, 'scenario.json')
  writeFileSync(fixturePath, `${JSON.stringify(fixture)}\n`, { flag: 'wx' })
  const output = resolve(root, session.outputDir)
  const workspace = resolve(root, session.workspaceDir)
  // The entry receipt is written before either the official child or the
  // plugin host starts.  Both processes must consume the same immutable bytes;
  // this is an identity handshake only, never a delegation permission.
  const entry = writeOfficialEntryManifest({ root, manifest, task, session })
  let freshReplayFixture = null
  if (task.correctionOrdinal === 1) {
    const sourcePath = join(workspace, 'fixture-source.json')
    writeFileSync(sourcePath, JSON.stringify(JSON.parse(row[columns[1]])) + '\n', { flag: 'wx' })
    const ref = path => ({ path: portable(relative(root, path)), sha256: fileDigest(path) })
    freshReplayFixture = { schemaVersion: 'gaia2-phase4-fresh-fixture-v1', originalScenarioHash: task.scenarioHash, original: ref(sourcePath), executed: ref(fixturePath) }
  }
  const eventPath = join(output, 'runtime-events.jsonl')
  const scriptsRoot = join(root, 'scripts')
  const runnerCode = `import sys, signal; signal.SIGALRM = getattr(signal, 'SIGALRM', signal.SIGTERM); signal.alarm = getattr(signal, 'alarm', lambda _seconds: 0); sys.path.insert(0, ${JSON.stringify(scriptsRoot)}); from capybara_official_bridge import install; install(); from are.simulation.benchmark import main; main()`
  // ``local`` is the public ARE configuration label for an OpenAI-compatible
  // endpoint.  LiteLLM's provider selector is separate; pass its explicit
  // transport name at the process boundary while preserving the frozen
  // manifest's model/provider identity for evidence and export.
  const augmentationArgs = task.phase === 'agent2agent'
    ? ['--a2a_app_prop', '1.0', '--a2a_app_agent', 'default_app_agent', '--a2a_model', manifest.models.actor.model, '--a2a_model_provider', resolveTransportProvider(manifest.models.actor.provider), '--a2a_endpoint', connection.baseUrl]
    : task.phase === 'noise' ? ['--noise'] : []
  const args = ['-c', runnerCode, 'run', '--dataset', datasetRoot, '--config', task.config, '--agent', 'default', '--model', manifest.models.actor.model, '--provider', resolveTransportProvider(manifest.models.actor.provider), '--endpoint', connection.baseUrl, '--judge_model', manifest.models.judge.model, '--judge_provider', resolveTransportProvider(manifest.models.judge.provider), '--judge_endpoint', connection.baseUrl, '--limit', '1', '--num_runs', '1', '--max_concurrent_scenarios', '1', '--scenario_timeout', String(settings.scenarioTimeoutSeconds), '--output_dir', output, '--trace_dump_format', 'both', '--log-level', 'INFO', ...augmentationArgs]
  const hookService = await startRuntimeHookService({ root, manifest, task, session, settings, signal, entry })
  const authority = hookService.correctionAuthority
  const childEnv = { ...process.env, ...modelRuntimeEnvironment(settings), PYTHONPATH: resolve(root, protocol.runtime.officialPythonPath), PYTHONUTF8: '1', OPENAI_API_KEY: connection.apiKey, GAIA2_E2E_MINIMAL: '0', GAIA2_E2E_MAX_ACTIONS: String(settings.maxActions), GAIA2_E2E_TOOL_ALLOWLIST: '', GAIA2_E2E_ATTEMPT_INDEX: String(task.attemptIndex ?? task.runNumber), GAIA2_E2E_CORRECTION_ORDINAL: String(task.correctionOrdinal ?? 0), GAIA2_CORRECTION_STRATEGY_TEXT: authority?.initializer.value ?? '', GAIA2_CORRECTION_STRATEGY_HASH: authority?.context.strategyHash ?? '', GAIA2_CORRECTION_CONTEXT_HASH: authority ? digest(authority.context) : '', GAIA2_EXECUTION_ID: task.executionId, GAIA2_SESSION_ID: session.sessionId, GAIA2_RUNTIME_EVENT_FILE: eventPath, GAIA2_HOOK_URL: hookService.endpoint, GAIA2_HOOK_TOKEN: hookService.token, GAIA2_OFFICIAL_ENTRY_REQUIRED: '1', GAIA2_OFFICIAL_ENTRY_PATH: entry.path, GAIA2_OFFICIAL_ENTRY_SHA256: entry.sha256, TMP: workspace, TEMP: workspace, TMPDIR: workspace }
  let processResult, hostProcess
  try { processResult = await runChildProcess({ command: resolve(root, protocol.runtime.python), args, cwd: workspace, env: childEnv, outputDir: output, processTimeoutMs: settings.processTimeoutMs, heartbeatIntervalMs: settings.heartbeatIntervalMs, signal, secrets: [connection.apiKey, hookService.token] }) }
  finally { hostProcess = await hookService.close() }
  if (hostProcess?.exitCode !== 0 || hostProcess?.signal || hostProcess?.timedOut || hostProcess?.interrupted || hostProcess?.spawnError || hostProcess?.loggingError || hostProcess?.heartbeatError || hostProcess?.manualInspectionRequired || !Array.isArray(hostProcess?.terminationErrors) || hostProcess.terminationErrors.length) processResult.loggingError = 'plugin_host_termination_failed'
  let events = []
  try {
    if (existsSync(eventPath)) events = readFileSync(eventPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    if (events.some(event => event.executionId !== task.executionId || event.sessionId !== session.sessionId)) {
      processResult.loggingError = 'foreign_runtime_events'
      events = []
    }
  } catch { processResult.loggingError = 'malformed_runtime_event_log' }
  let native
  try { native = readNativeResult({ root, outputDir: session.outputDir, task, session, events }) }
  catch { return { processResult, events, report: null, artifacts: [], runtimeEvidenceRequired: true, runtimeAttestation: null, runtimeEvidence: [] } }
  try {
    const runtime = collectRuntimeEvidence({ root, manifest, task, session, events, hostProcess })
    return { processResult, events, ...native, runtimeEvidenceRequired: true, ...runtime, ...(freshReplayFixture ? { freshReplayFixture } : {}) }
  } catch (error) {
    processResult.loggingError = 'runtime_hook_evidence_invalid'
    processResult.evidenceGateCode = safeEvidenceGateCode(error)
    return { processResult, events, report: native.report, artifacts: native.artifacts, runtimeEvidenceRequired: true, runtimeAttestation: null, runtimeEvidence: [] }
  }
}
