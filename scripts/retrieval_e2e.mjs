/** One isolated synthetic ARE retrieval rehearsal; real models are opt-in. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { freezePluginSnapshot, inspectPluginResources } from '../src/phase0_inventory.mjs'
import { digest, fileDigest, readJson, within } from '../src/phase0_run.mjs'
import { readModelConnection, modelRuntimeEnvironment, taskReconciliationEnvironment, resolveModelRetrySettings, resolveTransportProvider } from '../src/phase1_official.mjs'
import { resolveRuntimeSettings } from '../src/phase1_config.mjs'
import { writeOfficialEntryManifest } from '../src/phase1_official_entry.mjs'
import { runChildProcess } from '../src/phase1_process.mjs'
import { startRuntimeHookService } from '../src/phase3_hook_service.mjs'
import { retrievalDigest, validateRetrievalProjection } from '../src/retrieval_receipt.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const portable = value => value.replaceAll('\\', '/')
const clean = value => value?.exitCode === 0 && value.childExited === true && value.childClosed === true
  && !value.timedOut && !value.interrupted && !value.manualInspectionRequired && !value.spawnError
  && !value.loggingError && !value.heartbeatError && !value.terminationErrors?.length
function save(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
  return { path: portable(path), sha256: fileDigest(path) }
}
export function parseRetrievalE2EArgs(argv) {
  const allowed = new Set(['--real-model', '--retrieval-only'])
  if (argv.some(arg => !allowed.has(arg)) || new Set(argv).size !== argv.length)
    throw new Error('Usage: node scripts/retrieval_e2e.mjs [--real-model] [--retrieval-only]; exactly one synthetic scenario, no batch or resume')
  return { realModel: argv.includes('--real-model'), retrievalOnly: argv.includes('--retrieval-only') }
}

export async function runRetrievalE2E({ root = ROOT, realModel = false, retrievalOnly = false, signal } = {}) {
  assert.equal(typeof realModel, 'boolean')
  assert.equal(typeof retrievalOnly, 'boolean')
  const acceptanceProfile = retrievalOnly ? 'retrieval-only' : 'retrieval-with-write'
  root = resolve(root)
  const protocol = readJson(join(root, 'config/phase0-protocol.json'))
  const runId = `retrieval-e2e-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`
  const runRoot = `runs/${runId}`, runDirectory = join(root, runRoot)
  assert.ok(!existsSync(runDirectory))
  mkdirSync(runDirectory)
  const output = join(runDirectory, 'output'), workspace = join(runDirectory, 'workspace')
  mkdirSync(output); mkdirSync(workspace)
  console.log(JSON.stringify({ status: 'prepared', runId, mode: realModel ? 'real-model' : 'controlled',
    acceptanceProfile, readOnly: retrievalOnly, noBusinessWriteValidation: retrievalOnly,
    scenarioCount: 1, syntheticFixtureOnly: true, runRoot: portable(runDirectory) }))
  try {
  const plugins = ['gaia2-runtime', 'gaia2-evaluation', 'gaia2-retrieval'].map(id => inspectPluginResources(
    freezePluginSnapshot({ root, id, sourceRoot: join(root, 'plugins', id) })))
  const capabilities = { schemaVersion: 'gaia2-retrieval-controlled-capabilities-v1', syntheticFixtureOnly: true, plugins }
  const capabilityRef = save(join(runDirectory, 'capabilities.json'), capabilities)
  const sourcePaths = ['scripts/retrieval_e2e.mjs', 'scripts/retrieval_e2e_fixture.py',
    'scripts/capybara_official_bridge.py', 'scripts/gaia2_retrieval.py', 'scripts/gaia2_runtime_hooks.py',
    'scripts/phase3_hook_server.ts', 'src/retrieval_receipt.mjs',
    'src/phase3_hook_service.mjs', 'src/phase0_inventory.mjs', 'scripts/gaia2_model_retry.py', 'scripts/gaia2_model_http_guard.py']
  const sources = sourcePaths.map(path => ({ path, sha256: fileDigest(join(root, path)) }))
  const manifestBase = { schemaVersion: 'gaia2-retrieval-e2e-manifest-v1', runId, runRoot,
    syntheticFixtureOnly: true, officialSubmissionReady: false, executionBinding: 'phase3_live_plugin_host_required',
    acceptanceProfile, readOnly: retrievalOnly, noBusinessWriteValidation: retrievalOnly,
    models: protocol.models, lockRefs: { capabilities: { path: portable(relative(root, capabilityRef.path)), sha256: capabilityRef.sha256 } },
    retrieval: { enabled: true }, sources }
  const manifest = { ...manifestBase, manifestHash: digest(manifestBase) }
  save(join(runDirectory, 'manifest.json'), manifest)
  const scenarioId = retrievalOnly ? 'retrieval_e2e_contacts_25_read_only' : 'retrieval_e2e_contacts_25'
  const task = { executionId: `${runId}-single`, scenarioId, scenarioVersion: 'synthetic-v1',
    scenarioHash: digest({ scenario: scenarioId, contactCount: 25, targetIndex: 17 }),
    runNumber: 1, attemptIndex: 0, correctionOrdinal: 0, phase: 'standard', config: 'retrieval' }
  const session = { sessionId: `single-${randomUUID().slice(0, 8)}`, outputDir: portable(relative(root, output)), workspaceDir: portable(relative(root, workspace)) }
  const entry = writeOfficialEntryManifest({ root, manifest, task, session })
  const runtimeSettings = resolveRuntimeSettings({ protocol, entrypoint: 'e2e' })
  const settings = { ...runtimeSettings, processTimeoutMs: realModel ? 900000 : 180000,
    modelRetry: resolveModelRetrySettings(), maxActions: 30 }
  // Credential contents are not opened in controlled mode and never enter a report.
  const connection = realModel ? readModelConnection(root, protocol.models) : null
  const service = await startRuntimeHookService({ root, manifest, task, session, settings, signal, entry, retrieval: { enabled: true } })
  let actor, host
  try {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/(?:API_KEY|ACCESS_TOKEN|AUTHORIZATION|HF_TOKEN|HUGGINGFACE_TOKEN|GAIA2_HOOK_|GAIA2_A2A_|GAIA2_CORRECTION_|GAIA2_RETRIEVAL_|GAIA2_OFFICIAL_ENTRY_|GAIA2_MODEL_HTTP_GUARD_)/i.test(key)))
    actor = await runChildProcess({ command: resolve(root, protocol.runtime.python),
      args: [join(root, 'scripts/retrieval_e2e_fixture.py'), '--report', join(output, 'fixture-report.json'),
        ...(realModel ? ['--real-model'] : []), ...(retrievalOnly ? ['--retrieval-only'] : [])],
      cwd: root, outputDir: join(output, 'actor-process'), ...settings, signal,
      secrets: [service.token, ...(connection ? [connection.apiKey] : [])],
      env: { ...inherited, ...modelRuntimeEnvironment(settings), ...taskReconciliationEnvironment(), PYTHONPATH: join(root, protocol.runtime.officialPythonPath), PYTHONUTF8: '1',
        HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', LITELLM_LOCAL_MODEL_COST_MAP: 'True', LITELLM_TELEMETRY: 'False',
        GAIA2_EXECUTION_ID: task.executionId, GAIA2_SESSION_ID: session.sessionId, GAIA2_E2E_ATTEMPT_INDEX: '0', GAIA2_E2E_MAX_ACTIONS: '30',
        GAIA2_RUNTIME_EVENT_FILE: join(output, 'runtime-events.jsonl'), GAIA2_HOOK_URL: service.endpoint, GAIA2_HOOK_TOKEN: service.token,
        GAIA2_RETRIEVAL_ENABLED: '1', GAIA2_RETRIEVAL_WORKSPACE: workspace,
        GAIA2_OFFICIAL_ENTRY_REQUIRED: '1', GAIA2_OFFICIAL_ENTRY_PATH: entry.path, GAIA2_OFFICIAL_ENTRY_SHA256: entry.sha256,
        GAIA2_MODEL_HTTP_GUARD_REQUIRED: realModel ? '1' : '0',
        ...(connection ? { OPENAI_API_KEY: connection.apiKey, GAIA2_RETRIEVAL_E2E_ENDPOINT: connection.baseUrl,
          GAIA2_RETRIEVAL_E2E_MODEL: protocol.models.actor.model, GAIA2_RETRIEVAL_E2E_PROVIDER: resolveTransportProvider(protocol.models.actor.provider) } : {}) } })
  } finally { host = await service.close() }
  const fixturePath = join(output, 'fixture-report.json')
  const fixture = existsSync(fixturePath) ? readJson(fixturePath) : null
  const checks = { actorClosed: clean(actor), hostClosed: clean(host), fixturePassed: fixture?.status === 'passed',
    acceptanceProfileMatches: fixture?.acceptanceProfile === acceptanceProfile && fixture?.readOnly === retrievalOnly
      && fixture?.noBusinessWriteValidation === retrievalOnly,
    threePluginsLoaded: service.ready.initialization.plugins.length === 3,
    syntheticBoundary: fixture?.syntheticFixtureOnly === true && fixture?.officialSubmissionReady === false,
    sourceHashesUnchanged: sources.every(ref => fileDigest(resolve(root, ref.path)) === ref.sha256) }
  const artifacts = []
  if (fixture) {
    artifacts.push({ path: portable(relative(root, fixturePath)), sha256: fileDigest(fixturePath) })
    for (const ref of fixture.artifacts ?? []) {
      assert.ok(within(output, ref.path), 'fixture artifact escapes isolated output')
      assert.equal(fileDigest(ref.path), ref.sha256)
      artifacts.push({ path: portable(relative(root, ref.path)), sha256: ref.sha256 })
    }
  }
  const receiptArtifact = fixture?.artifacts?.find(ref => ref.path.endsWith('retrieval-receipts.json'))
  const returnedReceipts = receiptArtifact ? readJson(receiptArtifact.path) : []
  const receipts = returnedReceipts.map(receipt => {
    assert.equal(receipt.schemaVersion, 'gaia2-retrieval-receipt-v1')
    assert.equal(receipt.executionId, task.executionId); assert.equal(receipt.sessionId, session.sessionId)
    const ref = receipt.sourceReceiptRef
    assert.match(ref.path, /^plugin-runtime\/\d{6}-(?:before_model|before_tool|after_tool|attempt_end)-[a-f0-9-]+\.json$/)
    const path = resolve(workspace, ref.path)
    assert.ok(within(workspace, path)); assert.equal(fileDigest(path), ref.sha256)
    const source = readJson(path)
    assert.equal(source.executionId, task.executionId); assert.equal(source.sessionId, session.sessionId)
    assert.equal(source.sequence, receipt.sequence); assert.equal(source.revision, receipt.revision)
    assert.equal(source.contextHash, receipt.contextHash); assert.equal(source.variablesHash, receipt.variablesHash)
    assert.deepEqual(source.variables.gaia2_retrieval_scope, receipt.scope)
    assert.deepEqual(source.variables.gaia2_retrieval_projection, receipt.projection)
    validateRetrievalProjection(receipt.projection, receipt.scope)
    assert.equal(receipt.planHash, retrievalDigest(receipt.projection))
    return { checkpoint: receipt.checkpoint, sequence: receipt.sequence, revision: receipt.revision,
      planHash: receipt.planHash, path: portable(relative(root, path)), sha256: ref.sha256,
      certificateCount: receipt.projection.certificates.length }
  })
  checks.actualReturnedRetrievalReceiptsVerified = receipts.length > 0 && receipts.some(item => item.certificateCount > 0)
  const report = { schemaVersion: 'gaia2-retrieval-e2e-report-v1', status: Object.values(checks).every(Boolean) ? 'passed' : 'failed',
    runId, mode: realModel ? 'real-model' : 'controlled', syntheticFixtureOnly: true, scenarioCount: 1, benchmarkExecuted: false,
    acceptanceProfile, readOnly: retrievalOnly, noBusinessWriteValidation: retrievalOnly,
    officialSubmissionReady: false, originalCampaignModified: false, timingPolicyModified: false, checks,
    actorProcess: { exitCode: actor?.exitCode, childExited: actor?.childExited, childClosed: actor?.childClosed },
    hostProcess: { exitCode: host?.exitCode, childExited: host?.childExited, childClosed: host?.childClosed },
    fixtureSummary: fixture ? { ...fixture, artifacts: undefined } : null, sources, artifacts, retrievalReceipts: receipts }
  const reportPath = join(runDirectory, 'report.json')
  save(reportPath, report)
  return { ...report, reportPath: portable(reportPath) }
  } catch (error) {
    const diagnosticPath = join(runDirectory, 'runner-failure.json')
    save(diagnosticPath, { schemaVersion: 'gaia2-retrieval-e2e-runner-failure-v1', status: 'failed', runId,
      mode: realModel ? 'real-model' : 'controlled', scenarioCount: 1, syntheticFixtureOnly: true, officialSubmissionReady: false,
      acceptanceProfile, readOnly: retrievalOnly, noBusinessWriteValidation: retrievalOnly,
      errorType: error?.name ?? 'Error', ...(!realModel ? { controlledDiagnostic: String(error?.message ?? '').slice(0, 400) } : {}) })
    error.retrievalDiagnosticPath = portable(diagnosticPath)
    throw error
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort())
  try {
    const result = await runRetrievalE2E({ ...parseRetrievalE2EArgs(process.argv.slice(2)), signal: controller.signal })
    console.log(JSON.stringify({ status: result.status, mode: result.mode, scenarioCount: 1,
      acceptanceProfile: result.acceptanceProfile, readOnly: result.readOnly, noBusinessWriteValidation: result.noBusinessWriteValidation,
      syntheticFixtureOnly: true, officialSubmissionReady: false, reportPath: result.reportPath }))
    if (result.status !== 'passed') process.exitCode = 2
  } catch (error) {
    // Do not print endpoint-, credential- or provider-bearing exception text.
    console.error(JSON.stringify({ status: 'failed', code: 'retrieval_e2e_runner_failed', errorType: error?.name ?? 'Error',
      diagnosticPath: error?.retrievalDiagnosticPath,
      ...(!process.argv.includes('--real-model') ? { controlledDiagnostic: String(error?.message ?? '').slice(0, 400) } : {}) }))
    process.exitCode = 2
  }
}
