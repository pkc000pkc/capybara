/** Isolated scripted Actor over real ARE and live Node Host; never calls a model. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, lstatSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { freezePluginSnapshot, inspectPluginResources } from '../src/phase0_inventory.mjs'
import { digest, fileDigest, readJson, within } from '../src/phase0_run.mjs'
import { resolveRuntimeSettings } from '../src/phase1_config.mjs'
import { writeOfficialEntryManifest } from '../src/phase1_official_entry.mjs'
import { runChildProcess } from '../src/phase1_process.mjs'
import { startRuntimeHookService } from '../src/phase3_hook_service.mjs'
import { temporalDigest, validateTemporalState } from '../src/temporal_receipt.mjs'
import { hostInvocationDigest } from '../src/host_invocation_digest.mjs'

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const portable = value => value.replaceAll('\\', '/')
export const processClean = value => value?.exitCode === 0 && value.childExited === true && value.childClosed === true
  && !value.timedOut && !value.interrupted && !value.manualInspectionRequired && !value.spawnError
  && !value.loggingError && !value.heartbeatError && !value.terminationErrors?.length
export function save(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
  return { path: portable(path), sha256: fileDigest(path) }
}
export function filesBelow(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const target = join(path, entry.name)
    assert.ok(!lstatSync(target).isSymbolicLink(), 'symlink not permitted in evidence')
    return entry.isDirectory() ? filesBelow(target) : entry.isFile() ? [target] : []
  })
}
export function verifyTemporalReceipts({ root, workspace, executionId, sessionId, captures }) {
  return captures.filter(item => item.response?.temporalReceipt).map(item => {
    const receipt = item.response.temporalReceipt
    assert.equal(receipt.schemaVersion, 'gaia2-temporal-receipt-v1')
    assert.equal(receipt.executionId, executionId); assert.equal(receipt.sessionId, sessionId)
    assert.equal(receipt.checkpoint, item.checkpoint)
    const ref = receipt.sourceReceiptRef
    assert.match(ref?.path ?? '', /^plugin-runtime\/\d{6}-(?:before_model|before_tool|after_tool|attempt_end)-[a-f0-9-]+\.json$/)
    const target = resolve(workspace, ref.path)
    assert.ok(within(workspace, target)); assert.ok(!lstatSync(target).isSymbolicLink())
    assert.equal(fileDigest(target), ref.sha256)
    const source = readJson(target)
    assert.equal(source.executionId, executionId); assert.equal(source.sessionId, sessionId)
    for (const key of ['sequence', 'revision', 'contextHash', 'variablesHash']) assert.equal(source[key], receipt[key])
    assert.equal(hostInvocationDigest(source.input), hostInvocationDigest({ ...item.request, checkpoint: item.checkpoint }))
    assert.deepEqual(source.variables.gaia2_temporal_state, receipt.state)
    validateTemporalState(receipt.state, { executionId, sessionId })
    assert.equal(temporalDigest(receipt.state), receipt.stateHash)
    return { checkpoint: receipt.checkpoint, sequence: receipt.sequence, revision: receipt.revision,
      sourcePath: portable(relative(root, target)), sha256: ref.sha256 }
  })
}
export function temporalSources(root) {
  return ['scripts/temporal_e2e.mjs', 'scripts/temporal_e2e_fixture.py', 'scripts/temporal_official_ten.mjs',
    'scripts/temporal_official_entry.py', 'scripts/capybara_official_bridge.py', 'scripts/gaia2_temporal.py',
    'scripts/gaia2_runtime_hooks.py', 'scripts/phase3_hook_server.ts', 'src/phase3_hook_service.mjs', 'src/temporal_receipt.mjs',
    'scripts/gaia2_model_retry.py', 'scripts/gaia2_model_http_guard.py']
    .map(path => ({ path, sha256: fileDigest(join(root, path)) }))
}
export function parseTemporalE2EArgs(argv) {
  if (argv.length === 0) return { cases: ['candidate', 'deadline', 'user_update'] }
  if (argv.length === 2 && argv[0] === '--case' && ['candidate', 'deadline', 'user_update'].includes(argv[1])) return { cases: [argv[1]] }
  throw new Error('Usage: node scripts/temporal_e2e.mjs [--case candidate|deadline|user_update]; controlled only, no batch or model')
}
export async function runTemporalE2E({ root = ROOT, cases = ['candidate', 'deadline', 'user_update'], signal } = {}) {
  root = resolve(root)
  assert.ok(cases.length > 0 && cases.every(item => ['candidate', 'deadline', 'user_update'].includes(item)))
  const protocol = readJson(join(root, 'config/phase0-protocol.json'))
  const runId = `temporal-e2e-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`
  const runRoot = `runs/${runId}`, directory = join(root, runRoot)
  assert.ok(!existsSync(directory)); mkdirSync(directory)
  const plugins = ['gaia2-runtime', 'gaia2-evaluation'].map(id => inspectPluginResources(freezePluginSnapshot({ root, id, sourceRoot: join(root, 'plugins', id) })))
  const capabilities = save(join(directory, 'capabilities.json'), { schemaVersion: 'gaia2-temporal-capabilities-v1', plugins })
  const sources = temporalSources(root)
  const base = { schemaVersion: 'gaia2-temporal-e2e-manifest-v1', runId, runRoot,
    syntheticFixtureOnly: true, officialSubmissionReady: false, executionBinding: 'phase3_live_plugin_host_required',
    models: protocol.models, temporal: { enabled: true }, sources,
    lockRefs: { capabilities: { path: portable(relative(root, capabilities.path)), sha256: capabilities.sha256 } } }
  const manifest = { ...base, manifestHash: digest(base) }; save(join(directory, 'manifest.json'), manifest)
  const settings = { ...resolveRuntimeSettings({ protocol, entrypoint: 'e2e' }), processTimeoutMs: 180000, maxActions: 30 }
  const results = []
  for (const testCase of cases) {
    const output = join(directory, testCase, 'output'), workspace = join(directory, testCase, 'workspace')
    mkdirSync(output, { recursive: true }); mkdirSync(workspace)
    const task = { executionId: `${runId}-${testCase}`, scenarioId: `temporal_e2e_${testCase}`, scenarioVersion: 'synthetic-v1',
      scenarioHash: digest({ case: testCase }), runNumber: 1, attemptIndex: 0, correctionOrdinal: 0, phase: 'standard', config: 'temporal' }
    const session = { sessionId: `${testCase}-${randomUUID().slice(0, 8)}`, outputDir: portable(relative(root, output)), workspaceDir: portable(relative(root, workspace)) }
    const entry = writeOfficialEntryManifest({ root, manifest, task, session })
    let actor, host, service, errorType
    try {
      service = await startRuntimeHookService({ root, manifest, task, session, settings, signal, entry, temporal: { enabled: true } })
      const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|ACCESS_TOKEN|AUTHORIZATION|HF_TOKEN|HUGGINGFACE_TOKEN|GAIA2_HOOK_|GAIA2_A2A_|GAIA2_CORRECTION_|GAIA2_RETRIEVAL_|GAIA2_TEMPORAL_|GAIA2_OFFICIAL_ENTRY_|GAIA2_MODEL_HTTP_GUARD_)/i.test(key)))
      actor = await runChildProcess({ command: resolve(root, protocol.runtime.python),
        args: [join(root, 'scripts/temporal_e2e_fixture.py'), '--case', testCase, '--report', join(output, 'fixture-report.json')],
        cwd: root, outputDir: join(output, 'actor-process'), ...settings, signal, secrets: [service.token],
        env: { ...inherited, PYTHONPATH: join(root, protocol.runtime.officialPythonPath), PYTHONUTF8: '1',
          HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', LITELLM_LOCAL_MODEL_COST_MAP: 'True', LITELLM_TELEMETRY: 'False',
          GAIA2_EXECUTION_ID: task.executionId, GAIA2_SESSION_ID: session.sessionId, GAIA2_E2E_ATTEMPT_INDEX: '0', GAIA2_E2E_MAX_ACTIONS: '30',
          GAIA2_RUNTIME_EVENT_FILE: join(output, 'runtime-events.jsonl'), GAIA2_HOOK_URL: service.endpoint, GAIA2_HOOK_TOKEN: service.token,
          GAIA2_TEMPORAL_ENABLED: '1', GAIA2_TEMPORAL_WORKSPACE: workspace,
          GAIA2_OFFICIAL_ENTRY_REQUIRED: '1', GAIA2_OFFICIAL_ENTRY_PATH: entry.path, GAIA2_OFFICIAL_ENTRY_SHA256: entry.sha256,
          GAIA2_MODEL_HTTP_GUARD_REQUIRED: '0' } })
    } catch (error) { errorType = error?.name ?? 'Error' }
    finally { if (service) host = await service.close() }
    const fixturePath = join(output, 'fixture-report.json')
    const fixture = existsSync(fixturePath) ? readJson(fixturePath) : null
    const capturesPath = join(output, 'hook-receipts.json')
    const receipts = existsSync(capturesPath) ? verifyTemporalReceipts({ root, workspace, executionId: task.executionId,
      sessionId: session.sessionId, captures: readJson(capturesPath) }) : []
    const checks = { actorClosed: processClean(actor), hostClosed: processClean(host), fixturePassed: fixture?.status === 'passed',
      actualHostReceiptsVerified: receipts.length > 0, sourceHashesUnchanged: sources.every(ref => fileDigest(join(root, ref.path)) === ref.sha256) }
    const result = { case: testCase, status: Object.values(checks).every(Boolean) ? 'passed' : 'failed', checks,
      errorType, actorProcess: actor, hostProcess: host, fixtureSummary: fixture, receipts }
    save(join(directory, testCase, 'report.json'), result); results.push(result)
    console.log(JSON.stringify({ case: testCase, status: result.status, actorRequests: fixture?.actorRequests, nativeWaits: fixture?.nativeWaits, wakeSignal: fixture?.wakeSignal }))
    if (signal?.aborted) break
  }
  const report = { schemaVersion: 'gaia2-temporal-e2e-report-v1', runId, status: results.length === cases.length && results.every(r => r.status === 'passed') ? 'passed' : 'failed',
    syntheticFixtureOnly: true, benchmarkExecuted: false, officialSubmissionReady: false, realModelRequests: 0,
    originalCampaignModified: false, cases: results, sources }
  const path = join(directory, 'report.json'); save(path, report)
  return { ...report, reportPath: portable(path) }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort())
  try {
    const result = await runTemporalE2E({ ...parseTemporalE2EArgs(process.argv.slice(2)), signal: controller.signal })
    console.log(JSON.stringify({ status: result.status, reportPath: result.reportPath, realModelRequests: 0 }))
    if (result.status !== 'passed') process.exitCode = 2
  } catch (error) { console.error(JSON.stringify({ status: 'failed', errorType: error?.name, controlledDiagnostic: String(error?.message ?? '').slice(0, 400) })); process.exitCode = 2 }
}
