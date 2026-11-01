/** Isolated synthetic native semantics checks: real ARE/Host, no model/network. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { freezePluginSnapshot, inspectPluginResources } from '../src/phase0_inventory.mjs'
import { digest, fileDigest, readJson, within } from '../src/phase0_run.mjs'
import { resolveRuntimeSettings } from '../src/phase1_config.mjs'
import { writeOfficialEntryManifest } from '../src/phase1_official_entry.mjs'
import { runChildProcess } from '../src/phase1_process.mjs'
import { startRuntimeHookService } from '../src/phase3_hook_service.mjs'
import { ROOT, filesBelow, portable, processClean, save, verifyTemporalReceipts } from './temporal_e2e.mjs'
import { collectTemporalFrozenSources, supervisionSafety } from './temporal_official_ten.mjs'
import { verifyConflictPluginSnapshots, verifyConflictReceipts } from './conflict_recovery_e2e.mjs'
import { hostInvocationDigest } from '../src/host_invocation_digest.mjs'

export const DELETE_CASES = Object.freeze(['calendar_absent', 'contacts_absent', 'calendar_permission_error', 'contacts_unsupported_error', 'unknown_write_no_replay'])
export const WAIT_CASES = Object.freeze(['wait_monitor_contacts', 'wait_condition_calendar', 'wait_condition_timeout_calendar', 'wait_text_finish_contacts',
  'wait_none', 'wait_no_notify', 'wait_user_update_contacts', 'wait_cancel_contacts', 'wait_stop_contacts', 'wait_budget_contacts'])
export const SEMANTICS_CASES = Object.freeze([...DELETE_CASES, ...WAIT_CASES])
export function parseRuntimeSemanticsArgs(argv) {
  if (argv.length === 0) return { cases: [...SEMANTICS_CASES] }
  if (argv.length === 2 && argv[0] === '--case' && SEMANTICS_CASES.includes(argv[1])) return { cases: [argv[1]] }
  throw new Error('Usage: node scripts/runtime_semantics_e2e.mjs [--case <known synthetic profile>]; no model, original task, batch, or resume')
}

export async function verifyRuntimeSemanticReceipts({ root, workspace, executionId, sessionId, captures }) {
  const { semanticDigest, validateEntityState, validateTaskContractState, validateWriteState } = await import('../src/semantic_receipt.mjs')
  return captures.filter(item => item.response?.semanticReceipt).map(item => {
    const receipt = item.response.semanticReceipt
    assert.ok(['gaia2-semantic-receipt-v1', 'gaia2-semantic-receipt-v2'].includes(receipt.schemaVersion))
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
    assert.deepEqual(source.variables.gaia2_entity_state, receipt.entityState)
    validateEntityState(receipt.entityState, { executionId, sessionId })
    assert.equal(semanticDigest(receipt.entityState), receipt.entityStateHash)
    if (receipt.schemaVersion === 'gaia2-semantic-receipt-v1') {
      assert.deepEqual(source.variables.gaia2_task_contract_state, receipt.taskContractState)
      validateTaskContractState(receipt.taskContractState, { executionId, sessionId })
      assert.equal(semanticDigest(receipt.taskContractState), receipt.taskContractStateHash)
    } else {
      assert.equal(Object.hasOwn(receipt, 'taskContractState'), false)
      assert.equal(Object.hasOwn(receipt, 'taskContractStateHash'), false)
    }
    if (Object.hasOwn(receipt, 'writeState')) {
      assert.deepEqual(source.variables.gaia2_write_state, receipt.writeState)
      validateWriteState(receipt.writeState, { executionId, sessionId })
      assert.equal(semanticDigest(receipt.writeState), receipt.writeStateHash)
    } else assert.equal(Object.hasOwn(receipt, 'writeStateHash'), false)
    return { checkpoint: receipt.checkpoint, sequence: receipt.sequence, revision: receipt.revision,
      entityRecordCount: receipt.entityState.records.length, sourcePath: portable(relative(root, target)), sha256: ref.sha256 }
  })
}

export async function runRuntimeSemanticsE2E({ root = ROOT, cases = [...SEMANTICS_CASES], signal } = {}) {
  root = resolve(root)
  assert.ok(cases.length > 0 && new Set(cases).size === cases.length && cases.every(value => SEMANTICS_CASES.includes(value)))
  const protocol = readJson(join(root, 'config/phase0-protocol.json'))
  const runId = `runtime-semantics-e2e-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`
  const runRoot = `runs/${runId}`, directory = join(root, runRoot)
  assert.ok(!existsSync(directory)); mkdirSync(directory)
  const plugins = ['gaia2-runtime', 'gaia2-evaluation'].map(id => inspectPluginResources(freezePluginSnapshot({ root, id, sourceRoot: join(root, 'plugins', id) })))
  const capabilities = save(join(directory, 'capabilities.json'), { schemaVersion: 'gaia2-runtime-semantics-capabilities-v1', plugins })
  const runtimeSources = collectTemporalFrozenSources(root, protocol)
  const settings = { ...resolveRuntimeSettings({ protocol, entrypoint: 'e2e' }), processTimeoutMs: 180000, maxActions: 40 }
  const base = { schemaVersion: 'gaia2-runtime-semantics-e2e-manifest-v1', runId, runRoot, syntheticFixtureOnly: true,
    benchmarkExecuted: false, officialSubmissionReady: false, realModelRequests: 0, originalCampaignModified: false,
    executionBinding: 'phase3_live_plugin_host_required', models: protocol.models, settings,
    temporal: { enabled: true }, conflictRecovery: { enabled: true }, entitySemantics: { enabled: true },
    taskContract: { enabledProfiles: cases.filter(value => WAIT_CASES.includes(value)) }, profiles: [...cases], runtimeSources,
    lockRefs: { capabilities: { path: portable(relative(root, capabilities.path)), sha256: capabilities.sha256 } } }
  const manifest = { ...base, manifestHash: digest(base) }; save(join(directory, 'manifest.json'), manifest)
  const results = []
  for (const testCase of cases) {
    const waiting = WAIT_CASES.includes(testCase)
    const output = join(directory, testCase, 'output'), workspace = join(directory, testCase, 'workspace')
    mkdirSync(output, { recursive: true }); mkdirSync(workspace)
    const task = { executionId: `${runId}-${testCase}`, scenarioId: `runtime_semantics_${testCase}`,
      scenarioVersion: 'synthetic-v1', scenarioHash: digest({ case: testCase, source: runtimeSources.find(ref => ref.path === 'scripts/runtime_semantics_e2e_fixture.py') }),
      runNumber: 1, attemptIndex: 0, correctionOrdinal: 0, phase: 'standard', config: 'runtime-semantics' }
    const session = { sessionId: `${testCase}-${randomUUID().slice(0, 8)}`, outputDir: portable(relative(root, output)), workspaceDir: portable(relative(root, workspace)) }
    const entry = writeOfficialEntryManifest({ root, manifest, task, session })
    let service, actor = null, host = null, runnerError = null
    try {
      service = await startRuntimeHookService({ root, manifest, task, session, settings, signal, entry,
        temporal: { enabled: true }, conflictRecovery: { enabled: true }, entitySemantics: { enabled: true },
        ...(waiting ? { taskContract: { enabled: true } } : {}) })
      const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|ACCESS_TOKEN|AUTHORIZATION|HF_TOKEN|HUGGINGFACE_TOKEN|GAIA2_HOOK_|GAIA2_A2A_|GAIA2_CORRECTION_|GAIA2_RETRIEVAL_|GAIA2_TEMPORAL_|GAIA2_CONFLICT_RECOVERY_|GAIA2_ENTITY_SEMANTICS_|GAIA2_TASK_CONTRACT_|GAIA2_OFFICIAL_ENTRY_|GAIA2_MODEL_HTTP_GUARD_|GAIA2_E2E_)/i.test(key)))
      actor = await runChildProcess({ command: resolve(root, protocol.runtime.python),
        args: [join(root, 'scripts/runtime_semantics_e2e_fixture.py'), '--case', testCase, '--report', join(output, 'fixture-report.json')],
        cwd: root, outputDir: join(output, 'actor-process'), ...settings, signal, secrets: [service.token],
        env: { ...inherited, PYTHONPATH: resolve(root, protocol.runtime.officialPythonPath), PYTHONUTF8: '1',
          HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', LITELLM_LOCAL_MODEL_COST_MAP: 'True', LITELLM_TELEMETRY: 'False',
          GAIA2_EXECUTION_ID: task.executionId, GAIA2_SESSION_ID: session.sessionId, GAIA2_E2E_ATTEMPT_INDEX: '0', GAIA2_E2E_MAX_ACTIONS: '40',
          GAIA2_RUNTIME_EVENT_FILE: join(output, 'runtime-events.jsonl'), GAIA2_HOOK_URL: service.endpoint, GAIA2_HOOK_TOKEN: service.token,
          GAIA2_TEMPORAL_ENABLED: '1', GAIA2_TEMPORAL_WORKSPACE: workspace,
          GAIA2_CONFLICT_RECOVERY_ENABLED: '1', GAIA2_CONFLICT_RECOVERY_WORKSPACE: workspace,
          GAIA2_ENTITY_SEMANTICS_ENABLED: '1', GAIA2_ENTITY_SEMANTICS_WORKSPACE: workspace,
          ...(waiting ? { GAIA2_TASK_CONTRACT_ENABLED: '1', GAIA2_TASK_CONTRACT_WORKSPACE: workspace } : {}),
          GAIA2_OFFICIAL_ENTRY_REQUIRED: '1', GAIA2_OFFICIAL_ENTRY_PATH: entry.path, GAIA2_OFFICIAL_ENTRY_SHA256: entry.sha256,
          GAIA2_MODEL_HTTP_GUARD_REQUIRED: '0' } })
    } catch (error) { runnerError = { errorType: error?.name ?? 'Error' } }
    finally { if (service) host = await service.close() }
    const fixturePath = join(output, 'fixture-report.json')
    const fixture = existsSync(fixturePath) ? readJson(fixturePath) : null
    let conflictReceipts = [], temporalReceipts = [], semanticReceipts = [], receiptError = null
    try {
      const captures = readJson(join(output, 'hook-receipts.json'))
      conflictReceipts = await verifyConflictReceipts({ root, workspace, executionId: task.executionId, sessionId: session.sessionId, captures })
      temporalReceipts = verifyTemporalReceipts({ root, workspace, executionId: task.executionId, sessionId: session.sessionId, captures })
      semanticReceipts = await verifyRuntimeSemanticReceipts({ root, workspace, executionId: task.executionId, sessionId: session.sessionId, captures })
      assert.ok(conflictReceipts.length && temporalReceipts.length && semanticReceipts.length)
    } catch (error) { receiptError = error?.name ?? 'Error' }
    const checks = { actorClosed: processClean(actor), hostClosed: processClean(host), fixturePassed: fixture?.status === 'passed',
      allHostReceiptsVerified: receiptError === null && conflictReceipts.length > 0 && temporalReceipts.length > 0 && semanticReceipts.length > 0,
      runtimeSourcesUnchanged: runtimeSources.every(ref => fileDigest(resolve(root, ref.path)) === ref.sha256),
      pluginSnapshotHashesUnchanged: verifyConflictPluginSnapshots(plugins),
      noRealModelRequests: fixture?.realModelRequests === 0, noExternalNetwork: fixture?.externalAttempts === 0,
      syntheticBoundary: fixture?.syntheticFixtureOnly === true && fixture?.officialSubmissionReady === false && fixture?.benchmarkExecuted === false }
    const dispatchSafety = { actor: supervisionSafety(join(output, 'actor-process'), actor), host: supervisionSafety(join(output, 'hook-host'), host) }
    const artifacts = [...filesBelow(output), ...filesBelow(workspace)].map(path => ({ path: portable(relative(root, path)), sha256: fileDigest(path) }))
    const result = { case: testCase, status: Object.values(checks).every(Boolean) ? 'passed' : 'failed', checks, runnerError, receiptError,
      fixture, actorProcess: actor, hostProcess: host, dispatchSafety, conflictReceipts, temporalReceipts, semanticReceipts, artifacts }
    save(join(directory, testCase, 'report.json'), result); results.push(result)
    console.log(JSON.stringify({ case: testCase, status: result.status, actorRequests: fixture?.actorRequests,
      nativeDeletes: fixture?.nativeDeletes, blockedTools: fixture?.blockedTools }))
    if (signal?.aborted || !dispatchSafety.actor.safeToDispatchNext || !dispatchSafety.host.safeToDispatchNext) break
  }
  const report = { schemaVersion: 'gaia2-runtime-semantics-e2e-report-v1', runId,
    status: results.length === cases.length && results.every(item => item.status === 'passed') ? 'passed' : 'failed',
    syntheticFixtureOnly: true, benchmarkExecuted: false, officialSubmissionReady: false,
    realModelRequests: 0, originalCampaignModified: false, cases: results, runtimeSources }
  const reportPath = join(directory, 'report.json'); save(reportPath, report)
  return { ...report, reportPath: portable(reportPath) }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort())
  try {
    const result = await runRuntimeSemanticsE2E({ ...parseRuntimeSemanticsArgs(process.argv.slice(2)), signal: controller.signal })
    console.log(JSON.stringify({ status: result.status, reportPath: result.reportPath, realModelRequests: 0, benchmarkExecuted: false }))
    if (result.status !== 'passed') process.exitCode = 2
  } catch (error) { console.error(JSON.stringify({ status: 'failed', errorType: error?.name ?? 'Error' })); process.exitCode = 2 }
}
