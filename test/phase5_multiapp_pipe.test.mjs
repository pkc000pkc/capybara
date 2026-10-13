import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freezePluginSnapshot, inspectPluginResources } from '../src/phase0_inventory.mjs'
import { fileDigest } from '../src/phase0_run.mjs'
import { runChildProcess } from '../src/phase1_process.mjs'
import { startRuntimeHookService } from '../src/phase3_hook_service.mjs'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const protocol = JSON.parse(readFileSync(join(project, 'config/phase0-protocol.json'), 'utf8'))
const python = process.env.GAIA2_PYTHON || protocol.runtime.python

function rows(directory, schema) {
  return readdirSync(directory).filter(name => name.endsWith('.json')).sort()
    .map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')))
    .filter(value => value.schemaVersion === schema)
}

for (const mode of ['serial', 'cancel-inflight', 'full-inventory']) {
test(mode === 'serial'
  ? 'official multi-App pool uses real Hook server and two ARE native pipes, A-B-A without models'
  : mode === 'cancel-inflight'
    ? 'real server rejects B after reentrant cancel A until A native dispatch returns, without models'
    : 'real official ten-App inventory commits once, supports the pinned Shopping read, and drains without models',
  { timeout: 180000 }, async () => {
  // Everything generated belongs to a fresh capture. No project locks, model
  // configuration, frozen benchmark manifest or prior run result is rewritten.
  const root = mkdtempSync(join(tmpdir(), 'gaia2-multiapp-pipe-e2e-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  mkdirSync(join(root, 'config')); mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'config/phase0-protocol.json'), JSON.stringify({ runtime: { backendRoot: protocol.runtime.backendRoot } }))
  copyFileSync(join(project, 'scripts/phase3_hook_server.ts'), join(root, 'scripts/phase3_hook_server.ts'))
  const plugins = ['gaia2-runtime', 'gaia2-evaluation'].map(id => inspectPluginResources(
    freezePluginSnapshot({ root, id, sourceRoot: join(project, 'plugins', id) })))
  const capabilityPath = join(root, 'fixture-capabilities.json')
  writeFileSync(capabilityPath, JSON.stringify({ schemaVersion: 'gaia2-multiapp-fixture-inventory-v1', syntheticFixtureOnly: true, plugins }))
  const workspace = join(root, 'runs/fixture/workspace'), output = join(root, 'runs/fixture/output')
  mkdirSync(workspace, { recursive: true }); mkdirSync(output)
  const manifest = { runRoot: 'runs/fixture', lockRefs: { capabilities: { path: 'fixture-capabilities.json', sha256: fileDigest(capabilityPath) } } }
  const task = { phase: 'agent2agent', config: 'mini', executionId: 'multiapp-offline-parent', scenarioId: 'controlled-multiapp-pipe', runNumber: 1, attemptIndex: 0 }
  const session = { sessionId: 'multiapp-offline-session', workspaceDir: 'runs/fixture/workspace', outputDir: 'runs/fixture/output' }
  const settings = { processTimeoutMs: 120000, heartbeatIntervalMs: 1000, scenarioTimeoutSeconds: 90 }
  let service
  try { service = await startRuntimeHookService({ root, manifest, task, session, settings }) }
  catch (error) {
    const log = join(output, 'hook-host/stderr.log')
    throw new Error(`hook startup capture=${root}\n${existsSync(log) ? readFileSync(log, 'utf8') : ''}`, { cause: error })
  }
  let probe, host
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|ACCESS_TOKEN|AUTHORIZATION|HF_TOKEN|HUGGINGFACE_TOKEN|GAIA2_HOOK_|GAIA2_A2A_|GAIA2_CORRECTION_)/i.test(key)))
    probe = await runChildProcess({ command: python,
      args: ['-B', join(project, 'scripts/phase5_multiapp_pipe_probe.py'), '--workspace', workspace, '--mode', mode],
      cwd: project, outputDir: join(output, 'probe'), processTimeoutMs: 75000, heartbeatIntervalMs: 1000,
      secrets: [service.token, service.ready.a2a.channelId, service.ready.a2a.bindingHash],
      env: { ...env, PYTHONPATH: join(project, '.official-python'), PYTHONUTF8: '1',
        HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
        LITELLM_LOCAL_MODEL_COST_MAP: 'True', LITELLM_TELEMETRY: 'False',
        GAIA2_HOOK_URL: service.endpoint, GAIA2_HOOK_TOKEN: service.token,
        GAIA2_EXECUTION_ID: task.executionId, GAIA2_SESSION_ID: session.sessionId,
        GAIA2_A2A_PIPE_HOST: service.ready.a2a.host, GAIA2_A2A_PIPE_PORT: String(service.ready.a2a.port),
        GAIA2_A2A_PIPE_CHANNEL: service.ready.a2a.channelId, GAIA2_A2A_PIPE_BINDING: service.ready.a2a.bindingHash },
    })
  } finally { host = await service.close() }
  const stdout = existsSync(join(output, 'probe/stdout.log')) ? readFileSync(join(output, 'probe/stdout.log'), 'utf8') : ''
  const stderr = existsSync(join(output, 'probe/stderr.log')) ? readFileSync(join(output, 'probe/stderr.log'), 'utf8') : ''
  for (const [kind, result] of [['probe', probe], ['host', host]]) {
    assert.equal(result?.exitCode, 0, `${kind} capture=${root}\n${stdout}\n${stderr}\n${JSON.stringify(result)}`)
    assert.equal(result.childExited, true); assert.equal(result.childClosed, true)
    assert.equal(result.timedOut, false); assert.equal(result.interrupted, false)
    assert.equal(result.manualInspectionRequired, false); assert.deepEqual(result.terminationErrors, [])
  }
  const line = stdout.split(/\r?\n/).find(value => value.startsWith('MULTIAPP_PIPE_PROBE:'))
  assert.ok(line, `probe report missing: capture=${root}`)
  const report = JSON.parse(line.slice('MULTIAPP_PIPE_PROBE:'.length))
  assert.equal(report.status, 'passed'); assert.equal(report.syntheticFixtureOnly, true)
  assert.equal(report.controlledPrivateOwnerProbe, true); assert.equal(report.benchmarkExecuted, false)
  assert.equal(report.realModelCalls, 0); assert.equal(report.externalNetworkAttempts, 0)
  assert.equal(report.officialSubmissionReady, false); assert.equal(report.sharedAREClock, true)
  assert.equal(report.mode, mode); assert.equal(report.parallelFixtureThreads, 0)
  assert.equal(report.poolBeforeClose.status, 'committed'); assert.equal(report.poolAfterClose.status, 'closed')
  assert.equal(report.cleanup.poolCloseAcknowledged, true)
  assert.equal(report.cleanup.parentAttemptEndAfterPoolClose, true)
  const negatives = mode === 'serial'
    ? ['foreign_parent_receipt', 'foreign_peer_handle', 'concurrent_child']
    : mode === 'cancel-inflight' ? ['begin_b_during_cancelled_a_native'] : ['duplicate_pool_commit']
  for (const name of negatives) {
    assert.equal(report.negativeCases[name]?.rejected, true, name)
    assert.equal(report.negativeCases[name].nativeEventsBefore, report.negativeCases[name].nativeEventsAfter)
  }
  const registry = rows(join(workspace, 'plugin-delegation'), 'capybara-runtime-delegation-receipt-v1')
  assert.equal(registry.at(-1).kind, 'closed')
  const parent = rows(join(workspace, 'plugin-runtime'), 'capybara-runtime-plugin-invocation-v1')
  assert.equal(parent.at(-1).input.checkpoint, 'attempt_end')
  const allows = parent.filter(row => row.input.checkpoint === 'before_tool')
  if (mode === 'serial') {
    assert.deepEqual(report.appOrder, ['Contacts', 'RentAFlat', 'Contacts'])
    assert.deepEqual(report.realNativeEventCounts, { Contacts: 2, RentAFlat: 1 })
    assert.equal(report.native.Contacts.nativeReturns, 4); assert.equal(report.native.RentAFlat.nativeReturns, 2)
    assert.deepEqual(report.native.Contacts.clockRevisions, [1, 2, 3, 4, 5, 6, 7, 8])
    assert.deepEqual(report.native.RentAFlat.clockRevisions, [1, 2, 3, 4])
    assert.equal(new Set(report.children.map(child => child.scope.childExecutionId)).size, 3)
    assert.equal(new Set(report.children.map(child => child.scope.childSessionId)).size, 3)
    assert.equal(registry.filter(row => row.kind === 'registered').length, 3)
    assert.equal(registry.filter(row => row.kind === 'completed').length, 3)
    assert.equal(registry.filter(row => row.kind === 'native_completed').length, 6)
    assert.equal(registry.filter(row => row.kind === 'native_rejected').length, 0)
    assert.equal(allows.length, 4)
    assert.deepEqual(allows.map(row => row.input.action.resourceKey), ['Contacts', 'RentAFlat', 'RentAFlat', 'Contacts'])
  } else if (mode === 'cancel-inflight') {
    assert.deepEqual(report.appOrder, [])
    assert.deepEqual(report.realNativeEventCounts, { Contacts: 1 })
    assert.equal(report.native.Contacts.nativeReturns, 1); assert.equal(report.native.RentAFlat.nativeReturns, 0)
    assert.ok(report.native.Contacts.clockRevisions.length >= 2)
    assert.deepEqual(report.native.RentAFlat.clockRevisions, [])
    assert.equal(report.interleaving.cancelAtRealCompletedEvent, true)
    assert.equal(report.interleaving.cancelAcknowledgedBeforeNativeReturn, true)
    assert.equal(report.interleaving.bBeginRejectedBeforeNativeReturn, true)
    assert.equal(report.interleaving.cancelledDispatchRejected, true)
    assert.equal(registry.filter(row => row.kind === 'registered').length, 1)
    assert.equal(registry.filter(row => row.kind === 'cancelled').length, 1)
    assert.equal(registry.filter(row => row.kind === 'completed').length, 0)
    assert.equal(registry.filter(row => row.kind === 'native_completed').length, 0)
    assert.equal(registry.filter(row => row.kind === 'native_rejected').length, 1)
    assert.equal(allows.length, 2)
    assert.deepEqual(allows.map(row => row.input.action.resourceKey), ['Contacts', 'RentAFlat'])
  } else {
    const classes = { Cabs: 'CabApp', Calendar: 'Calendar', Chats: 'MessagingAppV2', City: 'CityApp',
      Contacts: 'Contacts', Emails: 'EmailClientV2', Files: 'SandboxLocalFileSystem',
      Messages: 'MessagingAppV2', RentAFlat: 'RentAFlat', Shopping: 'Shopping' }
    const appIds = Object.keys(classes).sort()
    assert.deepEqual(report.poolBeforeClose.expectedAppIds, appIds)
    assert.deepEqual(report.poolBeforeClose.usedAppIds, appIds)
    assert.deepEqual(report.poolBeforeClose.clients.map(client => client.appId), appIds)
    assert.deepEqual(Object.keys(report.inventory).sort(), appIds)
    assert.deepEqual(report.appOrder, []); assert.deepEqual(report.realNativeEventCounts, {})
    for (const appId of appIds) {
      assert.equal(report.inventory[appId].nativeClass, classes[appId])
      assert.equal(report.inventory[appId].manifestAppId, appId)
      assert.equal(report.inventory[appId].finalAnswerTools, 1)
      assert.equal(report.native[appId].nativeReturns, 0)
      assert.deepEqual(report.native[appId].clockRevisions, [])
      assert.deepEqual(report.native[appId].callbacksAfterClose, ['environment'])
    }
    assert.equal(report.inventory.Shopping.dispatchableAppTools, 12)
    const exclusions = report.poolBeforeClose.excludedTools
    assert.deepEqual(exclusions, [])
    assert.equal(registry.filter(row => row.kind === 'registered').length, 0)
    assert.equal(registry.filter(row => row.kind === 'completed').length, 0)
    assert.equal(registry.filter(row => row.kind === 'native_started').length, 0)
    assert.equal(registry.filter(row => row.kind === 'native_completed').length, 0)
    assert.equal(allows.length, 0)
  }
  assert.ok(allows.every(row => row.decision.action === 'allow' && row.hookReceipts.every(receipt => receipt.status === 'passed')))
  assert.equal(service.ready.processId, host.pid)
  writeFileSync(join(root, 'verification-report.json'), JSON.stringify({ schemaVersion: 'gaia2-multiapp-pipe-e2e-v1',
    status: 'passed', syntheticFixtureOnly: true, realModelCalls: 0, captureRoot: root,
    probeProcess: probe, hookHostProcess: host, report }, null, 2) + '\n')
  console.log(`MULTIAPP_PIPE_CAPTURE:${root}`)
})
}
