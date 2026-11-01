import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freezePluginSnapshot, inspectPluginResources } from '../src/phase0_inventory.mjs'
import { digest, fileDigest, readJson } from '../src/phase0_run.mjs'
import { resolveRuntimeSettings } from '../src/phase1_config.mjs'
import { writeOfficialEntryManifest } from '../src/phase1_official_entry.mjs'
import { runChildProcess } from '../src/phase1_process.mjs'
import { startRuntimeHookService } from '../src/phase3_hook_service.mjs'
import { portable, processClean, save, verifyTemporalReceipts } from '../scripts/temporal_e2e.mjs'
import { hostInvocationDigest } from '../src/host_invocation_digest.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const cases = ['calendar_batch', 'contacts_batch', 'unknown_batch', 'success_batch', 'silent_stop', 'notify_allowed']

test('precise feedback and real batch summaries cross production Bridge/Host/ARE without forcing notifications', { timeout: 240000 }, async () => {
  const protocol = readJson(join(root, 'config/phase0-protocol.json'))
  const directory = mkdtempSync(join(root, 'runs/feedback-bridge-controlled-'))
  const runId = directory.split(/[\\/]/).at(-1), runRoot = portable(relative(root, directory))
  const plugins = ['gaia2-runtime', 'gaia2-evaluation'].map(id => inspectPluginResources(freezePluginSnapshot({ root, id, sourceRoot: join(root, 'plugins', id) })))
  const capabilities = save(join(directory, 'capabilities.json'), { schemaVersion: 'gaia2-feedback-bridge-capabilities-v1', plugins })
  const settings = { ...resolveRuntimeSettings({ protocol, entrypoint: 'e2e' }), processTimeoutMs: 60000, maxActions: 20 }
  const paths = ['test/feedback_bridge_controlled.test.mjs', 'test/feedback_bridge_fixture.py', 'scripts/capybara_official_bridge.py',
    'scripts/gaia2_tool_feedback.py', 'scripts/gaia2_tool_round.py', 'scripts/gaia2_runtime_hooks.py',
    'scripts/phase3_hook_server.ts', 'src/phase3_hook_service.mjs', 'src/semantic_receipt.mjs', 'src/tool_round_service.mjs']
  const sources = paths.map(path => ({ path, sha256: fileDigest(join(root, path)) }))
  const base = { schemaVersion: 'gaia2-feedback-bridge-controlled-manifest-v1', runId, runRoot, syntheticFixtureOnly: true,
    benchmarkExecuted: false, officialSubmissionReady: false, realModelRequests: 0, executionBinding: 'phase3_live_plugin_host_required',
    models: protocol.models, sources, lockRefs: { capabilities: { path: portable(relative(root, capabilities.path)), sha256: capabilities.sha256 } } }
  const manifest = { ...base, manifestHash: digest(base) }; save(join(directory, 'manifest.json'), manifest)
  const results = []
  for (const name of cases) {
    const output = join(directory, name, 'output'), workspace = join(directory, name, 'workspace')
    mkdirSync(output, { recursive: true }); mkdirSync(workspace)
    const task = { executionId: `${runId}-${name}`, scenarioId: `feedback_${name}`, scenarioVersion: 'synthetic-v1', scenarioHash: digest({ name }),
      runNumber: 1, attemptIndex: 0, correctionOrdinal: 0, phase: 'standard', config: 'feedback-bridge-controlled' }
    const session = { sessionId: `${name}-${randomUUID().slice(0, 8)}`, outputDir: portable(relative(root, output)), workspaceDir: portable(relative(root, workspace)) }
    const entry = writeOfficialEntryManifest({ root, manifest, task, session })
    let service, actor = null, host = null, runnerError = null
    try {
      service = await startRuntimeHookService({ root, manifest, task, session, settings, entry,
        temporal: { enabled: true }, conflictRecovery: { enabled: true }, entitySemantics: { enabled: true }, mutationReceipts: { enabled: true } })
      const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|ACCESS_TOKEN|AUTHORIZATION|HF_TOKEN|HUGGINGFACE_TOKEN|GAIA2_(?:HOOK|A2A|CORRECTION|RETRIEVAL|TEMPORAL|CONFLICT_RECOVERY|ENTITY_SEMANTICS|MUTATION_RECEIPTS|TASK_CONTRACT|OFFICIAL_ENTRY|MODEL_HTTP_GUARD|E2E)_)/i.test(key)))
      actor = await runChildProcess({ command: resolve(root, protocol.runtime.python), args: [join(root, 'test/feedback_bridge_fixture.py'), '--case', name, '--report', join(output, 'fixture-report.json')],
        cwd: root, outputDir: join(output, 'actor-process'), ...settings, secrets: [service.token],
        env: { ...inherited, PYTHONPATH: resolve(root, protocol.runtime.officialPythonPath), PYTHONUTF8: '1', HF_HUB_OFFLINE: '1', LITELLM_LOCAL_MODEL_COST_MAP: 'True', LITELLM_TELEMETRY: 'False',
          GAIA2_EXECUTION_ID: task.executionId, GAIA2_SESSION_ID: session.sessionId, GAIA2_E2E_ATTEMPT_INDEX: '0', GAIA2_E2E_MAX_ACTIONS: '20',
          GAIA2_HOOK_URL: service.endpoint, GAIA2_HOOK_TOKEN: service.token, GAIA2_RUNTIME_EVENT_FILE: join(output, 'runtime-events.jsonl'),
          GAIA2_TOOL_ROUND_WORKSPACE: workspace, GAIA2_TEMPORAL_ENABLED: '1', GAIA2_TEMPORAL_WORKSPACE: workspace,
          GAIA2_CONFLICT_RECOVERY_ENABLED: '1', GAIA2_CONFLICT_RECOVERY_WORKSPACE: workspace,
          GAIA2_ENTITY_SEMANTICS_ENABLED: '1', GAIA2_ENTITY_SEMANTICS_WORKSPACE: workspace,
          GAIA2_MUTATION_RECEIPTS_ENABLED: '1', GAIA2_MUTATION_RECEIPTS_WORKSPACE: workspace,
          GAIA2_OFFICIAL_ENTRY_REQUIRED: '1', GAIA2_OFFICIAL_ENTRY_PATH: entry.path, GAIA2_OFFICIAL_ENTRY_SHA256: entry.sha256, GAIA2_MODEL_HTTP_GUARD_REQUIRED: '0' } })
    } catch (error) { runnerError = { name: error?.name, message: String(error?.message ?? '').slice(0, 400) } }
    finally { if (service) host = await service.close() }
    const fixture = existsSync(join(output, 'fixture-report.json')) ? readJson(join(output, 'fixture-report.json')) : null
    let verifiedReceipts = 0, receiptError = null
    try {
      const captures = readJson(join(output, 'hook-receipts.json'))
      verifyTemporalReceipts({ root, workspace, executionId: task.executionId, sessionId: session.sessionId, captures })
      for (const capture of captures) {
        const receipt = capture.response.semanticReceipt
        assert.equal(receipt.schemaVersion, 'gaia2-semantic-receipt-v2')
        assert.ok(!Object.hasOwn(receipt, 'taskContractState'))
        const sourcePath = resolve(workspace, receipt.sourceReceiptRef.path)
        assert.equal(fileDigest(sourcePath), receipt.sourceReceiptRef.sha256)
        const source = readJson(sourcePath)
        assert.equal(source.executionId, task.executionId); assert.equal(source.sessionId, session.sessionId)
        // Host appends derived argument evidence to the trusted receipt; the
        // verifier compares the semantic invocation projection, not those
        // Host-only fields.
        assert.equal(hostInvocationDigest(source.input), hostInvocationDigest({ ...capture.request, checkpoint: capture.checkpoint }))
        assert.deepEqual(source.variables.gaia2_write_state, receipt.writeState)
        verifiedReceipts++
      }
    } catch (error) { receiptError = { name: error?.name, message: String(error?.message ?? '').slice(0, 400) } }
    const checks = { actorClosed: processClean(actor), hostClosed: processClean(host), fixturePassed: fixture?.status === 'passed',
      verifiedReceipts: verifiedReceipts > 0 && !receiptError, noRealModel: fixture?.realModelRequests === 0, noExternalNetwork: fixture?.externalAttempts === 0 }
    const result = { case: name, status: Object.values(checks).every(Boolean) ? 'passed' : 'failed', checks, fixture, verifiedReceipts, runnerError, receiptError }
    save(join(directory, name, 'report.json'), result); results.push(result)
    console.log(JSON.stringify({ case: name, status: result.status, actorRequests: fixture?.actorRequests, verifiedReceipts }))
  }
  const sourcesUnchanged = sources.every(ref => fileDigest(join(root, ref.path)) === ref.sha256)
  const report = { schemaVersion: 'gaia2-feedback-bridge-controlled-report-v1', status: results.every(result => result.status === 'passed') && sourcesUnchanged ? 'passed' : 'failed',
    reportPath: portable(join(directory, 'report.json')), sourcesUnchanged, sources, cases: results, realModelRequests: 0, benchmarkExecuted: false }
  save(join(directory, 'report.json'), report)
  console.log(JSON.stringify({ status: report.status, reportPath: report.reportPath, cases: results.length, passed: results.filter(row => row.status === 'passed').length, sourcesUnchanged }))
  assert.equal(report.status, 'passed', `See ${report.reportPath}`)
})
