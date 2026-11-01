/** Synthetic Calendar critical path and safety boundaries; zero model calls. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, lstatSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { freezePluginSnapshot, hashTree, inspectPluginResources } from '../src/phase0_inventory.mjs'
import { digest, fileDigest, readJson, within } from '../src/phase0_run.mjs'
import { resolveRuntimeSettings } from '../src/phase1_config.mjs'
import { writeOfficialEntryManifest } from '../src/phase1_official_entry.mjs'
import { runChildProcess } from '../src/phase1_process.mjs'
import { startRuntimeHookService } from '../src/phase3_hook_service.mjs'
import { ROOT, portable, processClean, save } from './temporal_e2e.mjs'
import { collectTemporalFrozenSources, supervisionSafety } from './temporal_official_ten.mjs'
import { hostInvocationDigest } from '../src/host_invocation_digest.mjs'

export const CONFLICT_CASES = Object.freeze(['confirmed', 'changed_budget', 'user_before_read', 'user_after_read', 'stop_before_read', 'unknown_write'])
const VISIBLE_BASE = 'runs/temporal-official-ten-20261019T154626382Z-7082b888/task-02/output/temporal-evidence'
export function parseConflictRecoveryE2EArgs(argv) {
  if (argv.length === 0) return { cases: [...CONFLICT_CASES] }
  if (argv.length === 2 && argv[0] === '--case' && CONFLICT_CASES.includes(argv[1])) return { cases: [argv[1]] }
  throw new Error('Usage: node scripts/conflict_recovery_e2e.mjs [--case confirmed|changed_budget|user_before_read|user_after_read|stop_before_read|unknown_write]; scripted only, no original task or model')
}
export function verifyConflictPluginSnapshots(plugins) {
  try {
    return plugins.length > 0 && plugins.every(plugin => {
      const actual = hashTree(plugin.snapshotRoot)
      assert.equal(actual.treeSha256, plugin.treeSha256)
      assert.deepEqual(actual.files, plugin.files)
      return true
    })
  } catch { return false }
}
export async function verifyConflictReceipts({ root, workspace, executionId, sessionId, captures }) {
  const { validateConflictState, conflictDigest } = await import('../src/conflict_receipt.mjs')
  return captures.filter(item => item.response?.conflictReceipt).map(item => {
    const receipt = item.response.conflictReceipt
    assert.equal(receipt.schemaVersion, 'gaia2-conflict-receipt-v1')
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
    assert.deepEqual(source.variables.gaia2_conflict_state, receipt.state)
    validateConflictState(receipt.state)
    assert.equal(conflictDigest(receipt.state), receipt.stateHash)
    return { checkpoint: receipt.checkpoint, sequence: receipt.sequence, revision: receipt.revision,
      stateStatus: receipt.state.status, sourcePath: portable(relative(root, target)), sha256: ref.sha256 }
  })
}
function frozenSources(root) {
  return ['scripts/conflict_recovery_e2e.mjs', 'scripts/conflict_recovery_e2e_fixture.py',
    'scripts/temporal_e2e.mjs', 'scripts/temporal_official_ten.mjs', 'src/phase1_process.mjs',
    'scripts/capybara_official_bridge.py', 'scripts/gaia2_conflict_recovery.py', 'scripts/gaia2_runtime_hooks.py',
    'scripts/phase3_hook_server.ts', 'src/conflict_receipt.mjs', 'src/phase3_hook_service.mjs',
    'src/phase0_inventory.mjs', 'src/phase0_run.mjs', 'src/phase1_config.mjs', 'src/phase1_official_entry.mjs',
    'scripts/gaia2_model_retry.py', 'scripts/gaia2_model_http_guard.py',
    `${VISIBLE_BASE}/model-000001-input.json`, `${VISIBLE_BASE}/model-000000-output.json`, `${VISIBLE_BASE}/model-000020-output.json`]
    .map(path => ({ path, sha256: fileDigest(join(root, path)) }))
}
export async function runConflictRecoveryE2E({ root = ROOT, cases = [...CONFLICT_CASES], signal } = {}) {
  root = resolve(root)
  assert.ok(cases.length > 0 && new Set(cases).size === cases.length && cases.every(item => CONFLICT_CASES.includes(item)))
  const protocol = readJson(join(root, 'config/phase0-protocol.json'))
  const runId = `conflict-recovery-e2e-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`
  const runRoot = `runs/${runId}`, directory = join(root, runRoot)
  assert.ok(!existsSync(directory)); mkdirSync(directory)
  const plugins = ['gaia2-runtime', 'gaia2-evaluation'].map(id => inspectPluginResources(freezePluginSnapshot({ root, id, sourceRoot: join(root, 'plugins', id) })))
  const capabilities = save(join(directory, 'capabilities.json'), { schemaVersion: 'gaia2-conflict-e2e-capabilities-v1', plugins })
  const sources = frozenSources(root)
  const runtimeSources = collectTemporalFrozenSources(root, protocol)
  const base = { schemaVersion: 'gaia2-conflict-recovery-e2e-manifest-v1', runId, runRoot,
    syntheticFixtureOnly: true, fullOriginalTaskExecuted: false, officialSubmissionReady: false,
    sourceVisibleTaskId: 'scenario_universe_22_9pq84p', copiedVisibleEvents: 8,
    executionBinding: 'phase3_live_plugin_host_required', models: protocol.models, conflictRecovery: { enabled: true },
    lockRefs: { capabilities: { path: portable(relative(root, capabilities.path)), sha256: capabilities.sha256 } }, sources, runtimeSources }
  const manifest = { ...base, manifestHash: digest(base) }; save(join(directory, 'manifest.json'), manifest)
  const settings = { ...resolveRuntimeSettings({ protocol, entrypoint: 'e2e' }), processTimeoutMs: 180000, maxActions: 50 }
  const results = []
  for (const testCase of cases) {
    const output = join(directory, testCase, 'output'), workspace = join(directory, testCase, 'workspace')
    mkdirSync(output, { recursive: true }); mkdirSync(workspace)
    const task = { executionId: `${runId}-${testCase}`, scenarioId: `conflict_recovery_e2e_${testCase}`, scenarioVersion: 'synthetic-v1',
      scenarioHash: digest({ case: testCase, visibleSource: sources.slice(-3) }), runNumber: 1, attemptIndex: 0, correctionOrdinal: 0, phase: 'standard', config: 'conflict-recovery' }
    const session = { sessionId: `${testCase}-${randomUUID().slice(0, 8)}`, outputDir: portable(relative(root, output)), workspaceDir: portable(relative(root, workspace)) }
    const entry = writeOfficialEntryManifest({ root, manifest, task, session })
    let actor, host, service, errorType
    try {
      service = await startRuntimeHookService({ root, manifest, task, session, settings, signal, entry, conflictRecovery: { enabled: true } })
      const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|ACCESS_TOKEN|AUTHORIZATION|HF_TOKEN|HUGGINGFACE_TOKEN|GAIA2_HOOK_|GAIA2_A2A_|GAIA2_CORRECTION_|GAIA2_RETRIEVAL_|GAIA2_TEMPORAL_|GAIA2_CONFLICT_RECOVERY_|GAIA2_OFFICIAL_ENTRY_|GAIA2_MODEL_HTTP_GUARD_)/i.test(key)))
      actor = await runChildProcess({ command: resolve(root, protocol.runtime.python),
        args: [join(root, 'scripts/conflict_recovery_e2e_fixture.py'), '--case', testCase, '--report', join(output, 'fixture-report.json')],
        cwd: root, outputDir: join(output, 'actor-process'), ...settings, signal, secrets: [service.token],
        env: { ...inherited, PYTHONPATH: join(root, protocol.runtime.officialPythonPath), PYTHONUTF8: '1',
          HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', LITELLM_LOCAL_MODEL_COST_MAP: 'True', LITELLM_TELEMETRY: 'False',
          GAIA2_EXECUTION_ID: task.executionId, GAIA2_SESSION_ID: session.sessionId, GAIA2_E2E_ATTEMPT_INDEX: '0', GAIA2_E2E_MAX_ACTIONS: '50',
          GAIA2_RUNTIME_EVENT_FILE: join(output, 'runtime-events.jsonl'), GAIA2_HOOK_URL: service.endpoint, GAIA2_HOOK_TOKEN: service.token,
          GAIA2_CONFLICT_RECOVERY_ENABLED: '1', GAIA2_CONFLICT_RECOVERY_WORKSPACE: workspace,
          GAIA2_OFFICIAL_ENTRY_REQUIRED: '1', GAIA2_OFFICIAL_ENTRY_PATH: entry.path, GAIA2_OFFICIAL_ENTRY_SHA256: entry.sha256,
          GAIA2_MODEL_HTTP_GUARD_REQUIRED: '0' } })
    } catch (error) { errorType = error?.name ?? 'Error' }
    finally { if (service) host = await service.close() }
    const fixturePath = join(output, 'fixture-report.json')
    const fixture = existsSync(fixturePath) ? readJson(fixturePath) : null
    let receipts = [], receiptError = null
    try {
      const capturePath = join(output, 'hook-receipts.json')
      if (existsSync(capturePath)) receipts = await verifyConflictReceipts({ root, workspace, executionId: task.executionId,
        sessionId: session.sessionId, captures: readJson(capturePath) })
      assert.ok(receipts.length > 0)
    } catch (error) { receiptError = error?.name ?? 'Error' }
    const checks = { actorClosed: processClean(actor), hostClosed: processClean(host), fixturePassed: fixture?.status === 'passed',
      actualHostReceiptsVerified: receipts.length > 0 && receiptError === null,
      sourceHashesUnchanged: sources.every(ref => fileDigest(join(root, ref.path)) === ref.sha256),
      runtimeSourceHashesUnchanged: runtimeSources.every(ref => fileDigest(resolve(root, ref.path)) === ref.sha256),
      pluginSnapshotHashesUnchanged: verifyConflictPluginSnapshots(plugins),
      visibleSourceHashesVerified: fixture?.sourceVisibleRefs?.length === 3 && fixture.sourceVisibleRefs.every(ref => fileDigest(ref.path) === ref.sha256),
      noRealModelRequests: fixture?.realModelRequests === 0, notOriginalBenchmarkScore: fixture?.fullOriginalTaskExecuted === false && fixture?.officialSubmissionReady === false }
    const dispatchSafety = { actor: supervisionSafety(join(output, 'actor-process'), actor), host: supervisionSafety(join(output, 'hook-host'), host) }
    const result = { case: testCase, status: Object.values(checks).every(Boolean) ? 'passed' : 'failed', checks,
      errorType, receiptError, actorProcess: actor, hostProcess: host, fixtureSummary: fixture, receipts, dispatchSafety }
    save(join(directory, testCase, 'report.json'), result); results.push(result)
    console.log(JSON.stringify({ case: testCase, status: result.status, actorRequests: fixture?.actorRequests,
      nativeActorAdds: fixture?.nativeActorAdds, automaticConfirmationReads: fixture?.automaticConfirmationReads }))
    if (signal?.aborted || !dispatchSafety.actor.safeToDispatchNext || !dispatchSafety.host.safeToDispatchNext) break
  }
  const report = { schemaVersion: 'gaia2-conflict-recovery-e2e-report-v1', runId,
    status: results.length === cases.length && results.every(result => result.status === 'passed') ? 'passed' : 'failed',
    syntheticFixtureOnly: true, benchmarkExecuted: false, fullOriginalTaskExecuted: false, officialSubmissionReady: false,
    realModelRequests: 0, originalCampaignModified: false, cases: results, sources, runtimeSources }
  const path = join(directory, 'report.json'); save(path, report)
  return { ...report, reportPath: portable(path) }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort())
  try {
    const result = await runConflictRecoveryE2E({ ...parseConflictRecoveryE2EArgs(process.argv.slice(2)), signal: controller.signal })
    console.log(JSON.stringify({ status: result.status, reportPath: result.reportPath, realModelRequests: 0, fullOriginalTaskExecuted: false }))
    if (result.status !== 'passed') process.exitCode = 2
  } catch (error) { console.error(JSON.stringify({ status: 'failed', errorType: error?.name, controlledDiagnostic: String(error?.message ?? '').slice(0, 400) })); process.exitCode = 2 }
}
