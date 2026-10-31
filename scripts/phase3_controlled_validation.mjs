import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { freezePluginSnapshot, inspectPluginResources } from '../src/phase0_inventory.mjs'
import { digest, fileDigest, readJson, within } from '../src/phase0_run.mjs'
import { runChildProcess } from '../src/phase1_process.mjs'
import { startRuntimeHookService } from '../src/phase3_hook_service.mjs'
import { collectRuntimeEvidence, pythonEventHash, validateRuntimeEvidence } from '../src/phase3_runtime_evidence.mjs'

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const CASES = ['dynamic', 'unknown', 'unverified_evidence', 'wait', 'hook_failure']
const hash = value => createHash('sha256').update(value).digest('hex')
const jsonHash = value => hash(JSON.stringify(value))
const cleanProcess = value => value?.exitCode === 0 && value.childExited === true && value.childClosed === true && !value.timedOut && !value.interrupted && !value.manualInspectionRequired && !value.spawnError && !value.loggingError && !value.heartbeatError
const normalized = value => value.replaceAll('\\', '/')

function save(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  return { path: normalized(path), sha256: fileDigest(path) }
}

function lines(path) {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

function pluginsForCase(root, runDirectory, caseName) {
  let source = join(root, 'plugins')
  if (caseName === 'hook_failure') {
    // A separate generated negative fixture, never the tracked plugin source
    // or an existing content-addressed snapshot. The fault is in hook run(),
    // so discovery still sees the real declared/scheduled TS resource.
    source = join(runDirectory, 'negative-plugin-source')
    mkdirSync(source)
    for (const id of ['gaia2-runtime', 'gaia2-evaluation']) cpSync(join(root, 'plugins', id), join(source, id), { recursive: true, errorOnExist: true, force: false })
    const hook = join(source, 'gaia2-runtime/hooks/gaia2-write-outcome.ts')
    const original = readFileSync(hook, 'utf8')
    const needle = 'run({ variables, action, outcome, loop }) {'
    assert.equal(original.split(needle).length, 2, 'controlled post-tool fault must bind an exact known hook')
    writeFileSync(hook, original.replace(needle, `${needle}\n    throw new Error("CONTROLLED_POST_TOOL_HOOK_FAILURE");`))
  }
  return ['gaia2-runtime', 'gaia2-evaluation'].map(id => inspectPluginResources(freezePluginSnapshot({ root, id, sourceRoot: join(source, id) })))
}

function inspectCaseEvidence({ root, workspace, output, fixture, capabilities, ready, processResult, serviceResult }) {
  assert.ok(cleanProcess(processResult), 'controlled ARE child must close successfully')
  assert.ok(cleanProcess(serviceResult), 'actual TS host must close successfully')
  assert.equal(fixture.schemaVersion, 'gaia2-phase3-controlled-fixture-v1')
  assert.equal(fixture.status, 'passed')
  assert.equal(fixture.realModelCalls, 0)
  assert.equal(fixture.externalNetworkAttempts, 0)
  assert.equal(fixture.benchmarkExecuted, false)
  assert.equal(fixture.syntheticFixtureOnly, true)
  assert.equal(fixture.officialSubmissionReady, false)
  for (const artifact of fixture.artifacts) {
    assert.ok(within(output, artifact.path), 'fixture artifact must stay within its new session output')
    assert.equal(fileDigest(artifact.path), artifact.sha256)
  }
  const actors = readJson(fixture.artifacts.find(item => item.path.endsWith('actor-inputs.json')).path)
  const events = lines(join(output, 'runtime-events.jsonl'))
  const evidenceRoot = join(workspace, 'plugin-runtime')
  const evidenceFiles = readdirSync(evidenceRoot).sort().map(name => join(evidenceRoot, name))
  const evidence = evidenceFiles.map(path => ({ path, value: readJson(path) }))
  const initialized = evidence.find(item => item.value.schemaVersion === 'capybara-runtime-plugin-host-v1')
  assert.ok(initialized)
  assert.equal(initialized.value.executionId, fixture.executionId)
  assert.equal(initialized.value.sessionId, fixture.sessionId)
  const expectedHooks = new Map(capabilities.plugins.flatMap(plugin => [...plugin.hooks, ...plugin.trainingHooks].map(hook => [hook.name, hook.sha256])))
  for (const plugin of ready.initialization.plugins) {
    const frozen = capabilities.plugins.find(item => item.id === plugin.id)
    assert.ok(frozen)
    assert.deepEqual(plugin.files, frozen.files)
  }
  assert.equal(ready.initialization.plugins.length, 2)
  assert.equal(ready.initialization.harnesses.length, 2)
  assert.ok(ready.initialization.runtimeHooks.some(hook => hook.id === 'gaia2-event-sync'))
  assert.ok(ready.initialization.runtimeHooks.some(hook => hook.id === 'gaia2-write-guard'))
  assert.equal(ready.initialization.trainingHooks.length, 1)
  for (const hook of [...ready.initialization.runtimeHooks, ...ready.initialization.trainingHooks]) assert.equal(hook.sourceSha256, expectedHooks.get(hook.id))
  const calls = evidence.filter(item => item.value.schemaVersion === 'capybara-runtime-plugin-invocation-v1')
  assert.ok(calls.length > 0)
  for (const { value } of calls) {
    assert.equal(value.executionId, fixture.executionId)
    assert.equal(value.sessionId, fixture.sessionId)
    assert.equal(hash(value.context), value.contextHash)
    assert.equal(jsonHash(value.variables), value.variablesHash)
    assert.ok(!['after_evaluation', 'after_replay'].includes(value.input.checkpoint), 'sealed training checkpoints cannot run')
    for (const receipt of value.hookReceipts) {
      assert.equal(receipt.sourceSha256, expectedHooks.get(receipt.hookId))
      if (fixture.case !== 'hook_failure') assert.equal(receipt.status, 'passed', `actual TS hook failed: ${receipt.hookId}`)
    }
    if (value.input.checkpoint === 'after_tool') {
      const event = events.find(event => event.type === 'tool_call_completed' && event.callId === value.input.action.id)
      assert.ok(event, 'after_tool must bind an actual ARE invocation')
      assert.equal(value.input.outcome.resultHash, event.resultHash)
      assert.equal(value.input.outcome.status, event.status)
      if (value.input.outcome.status === 'succeeded' && ['ControlledLedger__write', 'ControlledLedger__read', 'ControlledLedger__failed_read'].includes(value.input.action.name)) {
        const result = value.input.outcome.result
        assert.equal(typeof result.contact, 'string', 'official Contact must reach the strict real Host as Actor-visible text')
        assert.equal(result.nested[0].contact, result.contact)
        assert.ok(result.contact.includes('Contact ID: controlled-visible-contact'))
        assert.equal(pythonEventHash(result), value.input.outcome.resultHash, 'projected IPC result must preserve the original ARE result hash')
      }
    }
  }
  assert.equal(actors.length, fixture.fakeActorRequests)
  const injections = events.filter(event => event.type === 'dynamic_context_injected')
  assert.equal(injections.length, actors.length)
  for (const [index, actor] of actors.entries()) {
    const before = calls.find(item => item.value.input.checkpoint === 'before_model' && item.value.revision === actor.hookRevision && item.value.contextHash === actor.contextHash)
    assert.ok(before, 'real Actor input must bind a real typed-variables/render receipt')
    assert.equal(actor.context, before.value.context)
    assert.equal(actor.messages[1].content, `Live Capybara dynamic context:\n${before.value.context}`)
    assert.equal(hash(actor.context), actor.contextHash)
    assert.equal(pythonEventHash(actor.messages), injections[index].actorInputHash, 'complete observed Actor input must bind the bridge prompt hash')
    assert.equal(before.value.variables.gaia2_clock_state.authority, 'ARE')
    assert.equal(before.value.variables.gaia2_clock_state.now, before.value.input.clock.now)
    const serialized = JSON.stringify(actor.messages)
    assert.ok(!serialized.includes('HIDDEN_ORACLE_SENTINEL_8DD72D') && !serialized.includes('FUTURE_NOT_YET_VISIBLE_70FA12'))
    const sync = before.value.hookReceipts.find(receipt => receipt.hookId === 'gaia2-event-sync')
    assert.equal(sync?.status, 'passed'); assert.equal(sync?.matched, true)
    const replan = before.value.hookReceipts.find(receipt => receipt.hookId === 'gaia2-replan')
    assert.equal(replan?.status, 'passed'); assert.equal(replan?.matched, true)
  }
  const beforeTool = id => calls.find(item => item.value.input.checkpoint === 'before_tool' && item.value.input.action.id === id)?.value
  const afterTool = id => calls.find(item => item.value.input.checkpoint === 'after_tool' && item.value.input.action.id === id)?.value
  const last = calls.at(-1).value
  assert.equal(last.input.checkpoint, 'attempt_end')
  assert.equal(last.input.loop.terminationReason, fixture.terminationReason)
  if (fixture.case === 'dynamic') {
    assert.ok(events.some(event => event.type === 'tool_call_blocked' && event.callId === 'dynamic-old' && event.reason === 'stale_dynamic_context'))
    assert.equal(afterTool('dynamic-old'), undefined)
    assert.equal(beforeTool('dynamic-new').decision.action, 'allow')
    assert.equal(fixture.callbackCounts.write, 1)
    const update = actors[1]
    const receipt = calls.find(item => item.value.input.checkpoint === 'before_model' && item.value.revision === update.hookRevision).value
    assert.ok(receipt.variables.gaia2_replan_state.invalidated_steps.length > 0)
    assert.notEqual(actors[0].contextHash, update.contextHash)
  } else if (fixture.case === 'unknown') {
    const retryGate = beforeTool('unknown-retry')
    assert.equal(retryGate.decision.action, 'read_back')
    assert.ok(retryGate.hookReceipts.some(receipt => receipt.hookId === 'gaia2-write-guard' && receipt.decision?.action === 'read_back'))
    assert.equal(afterTool('unknown-retry'), undefined)
    // A different mutation key is an independent operation once read-back
    // evidence exists; only the exact unresolved write remains protected.
    const replacementGate = beforeTool('unknown-after-read')
    assert.equal(replacementGate.decision.action, 'allow')
    assert.ok(replacementGate.hookReceipts.some(receipt => receipt.hookId === 'gaia2-write-guard' && receipt.decision?.action === 'allow'))
    assert.ok(afterTool('unknown-after-read'))
    const read = afterTool('unknown-readback')
    const entry = read.variables.gaia2_write_state.unknown.find(item => item.resourceKey === 'ControlledLedger')
    assert.ok(entry?.readBackObserved)
    assert.equal(entry.readBackActionId, 'unknown-readback')
    assert.equal(entry.readBackHash, read.input.outcome.resultHash)
    assert.equal(entry.resultHash, afterTool('unknown-first').input.outcome.resultHash)
    assert.equal(fixture.callbackCounts.write, 2)
  } else if (fixture.case === 'unverified_evidence') {
    const failed = afterTool('unverified-read-failed')
    assert.equal(failed.input.action.canonicalName, 'ControlledLedger__failed_read')
    assert.equal(failed.input.outcome.status, 'failed_before_execution')
    assert.deepEqual(failed.variables.gaia2_observation_state.unverified_ids, ['obs-unverified-read-failed'])
    const firstWrite = beforeTool('unverified-write')
    assert.equal(firstWrite.decision.action, 'allow')
    assert.ok(firstWrite.hookReceipts.some(receipt => receipt.hookId === 'gaia2-conflict-gate' && receipt.decision?.action === 'allow'))
    assert.ok(firstWrite.hookReceipts.some(receipt => receipt.hookId === 'gaia2-write-guard' && receipt.decision?.action === 'allow'))
    assert.deepEqual(firstWrite.variables.gaia2_observation_state.unverified_ids, ['obs-unverified-read-failed'])
    assert.ok(afterTool('unverified-write'))
    const replayWrite = beforeTool('unverified-write-after-different-read')
    assert.equal(replayWrite.decision.action, 'block')
    assert.ok(replayWrite.hookReceipts.some(receipt => receipt.hookId === 'gaia2-conflict-gate' && receipt.decision?.action === 'allow'))
    assert.ok(replayWrite.hookReceipts.some(receipt => receipt.hookId === 'gaia2-write-guard' && receipt.decision?.action === 'block'))
    assert.deepEqual(replayWrite.variables.gaia2_observation_state.unverified_ids, ['obs-unverified-read-failed'])
    assert.equal(afterTool('unverified-write-after-different-read'), undefined)
    const different = afterTool('unverified-different-read')
    assert.equal(beforeTool('unverified-different-read').decision.action, 'allow')
    assert.equal(different.input.outcome.status, 'succeeded')
    assert.equal(different.input.action.resourceKey, failed.input.action.resourceKey)
    assert.notEqual(different.input.action.canonicalName, failed.input.action.canonicalName)
    assert.notEqual(different.input.action.mutationKey, failed.input.action.mutationKey)
    assert.deepEqual(different.variables.gaia2_observation_state.unverified_ids, ['obs-unverified-read-failed'])
    assert.ok(different.variables.gaia2_observation_state.observations.some(item => item.actionId === 'unverified-read-failed' && item.status === 'failed'))
    assert.equal(beforeTool('unverified-fresh-read').decision.action, 'allow')
    const fresh = afterTool('unverified-fresh-read')
    assert.equal(fresh.input.action.canonicalName, failed.input.action.canonicalName)
    assert.equal(fresh.input.action.resourceKey, failed.input.action.resourceKey)
    assert.equal(fresh.input.action.mutationKey, failed.input.action.mutationKey)
    assert.deepEqual(fresh.input.action.arguments, failed.input.action.arguments)
    assert.equal(fresh.input.action.authoritativeRead, true)
    assert.equal(fresh.input.outcome.status, 'succeeded')
    assert.equal(fresh.input.outcome.complete, true)
    const observation = fresh.variables.gaia2_observation_state
    assert.deepEqual(observation.unverified_ids, [])
    assert.ok(observation.observations.some(item => item.actionId === 'unverified-read-failed' && item.status === 'verified_by_fresh_read' && item.verifiedBy === 'unverified-fresh-read'))
    assert.deepEqual(fixture.callbackCounts, { write: 1, read: 1, failed_read: 2 })
    assert.equal(fixture.fakeActorRequests, 6)
  } else if (fixture.case === 'wait') {
    assert.equal(beforeTool('official-wait').input.action.canonicalName, 'SystemApp__wait_for_notification')
    assert.equal(afterTool('official-wait').decision.action, 'allow')
    assert.ok(actors[1].messages.some(message => message.role === 'user' && message.content.includes('UPDATED request')))
    assert.ok(fixture.officialClockAtEnd >= 1010)
  } else if (fixture.case === 'hook_failure') {
    const after = afterTool('failed-hook-write')
    assert.equal(after.decision.action, 'block')
    assert.ok(after.hookReceipts.some(receipt => receipt.hookId === 'gaia2-write-outcome' && receipt.status === 'failed'))
    assert.equal(fixture.expectedTechnicalFailure, 'after_tool_rejected')
    assert.equal(fixture.fakeActorRequests, 1)
    assert.equal(fixture.validationCalls, 0)
  }
  return {
    status: 'passed', case: fixture.case, executionId: fixture.executionId, sessionId: fixture.sessionId,
    realHost: true, trackedPluginProfile: fixture.case !== 'hook_failure', intentionallyFaultedHook: fixture.case === 'hook_failure',
    actorRequests: actors.length, actualToolCalls: calls.filter(item => item.value.input.checkpoint === 'after_tool').length,
    callbackCounts: fixture.callbackCounts, invocationCount: calls.length,
    hookSourceBindingsChecked: true, actorContextBindingsChecked: true, resultHashBindingsChecked: true,
    hiddenAndFutureInputsAbsent: true, trainingHooksExecuted: false,
    officialContactProjectionExercised: fixture.officialContactProjectionExercised,
    artifacts: [
      { path: normalized(relative(root, join(output, 'fixture-report.json'))), sha256: fileDigest(join(output, 'fixture-report.json')) },
      { path: normalized(relative(root, join(output, 'runtime-events.jsonl'))), sha256: fileDigest(join(output, 'runtime-events.jsonl')) },
      ...fixture.artifacts.map(item => ({ ...item, path: normalized(relative(root, item.path)) })),
      ...evidenceFiles.map(path => ({ path: normalized(relative(root, path)), sha256: fileDigest(path) })),
      { path: normalized(relative(root, join(output, 'actor-process/process-result.json'))), sha256: fileDigest(join(output, 'actor-process/process-result.json')) },
      { path: normalized(relative(root, join(output, 'hook-host/process-result.json'))), sha256: fileDigest(join(output, 'hook-host/process-result.json')) },
    ],
  }
}

export async function runPhase3ControlledValidation({ root = defaultRoot, signal } = {}) {
  root = resolve(root)
  const protocol = readJson(join(root, 'config/phase0-protocol.json'))
  const runId = `phase3-controlled-${Date.now()}-${randomUUID().slice(0, 8)}`
  const runRoot = `runs/${runId}`, runDirectory = join(root, runRoot)
  assert.ok(!existsSync(runDirectory))
  mkdirSync(runDirectory, { recursive: false })
  const bindings = [
    'scripts/capybara_official_bridge.py', 'scripts/gaia2_runtime_hooks.py',
    'scripts/phase3_controlled_fixture.py', 'scripts/phase3_controlled_validation.mjs',
    'scripts/phase3_hook_server.ts', 'src/phase3_hook_service.mjs', 'src/phase3_runtime_evidence.mjs',
  ].map(path => ({ path, sha256: fileDigest(join(root, path)) }))
  bindings.push({ path: normalized(join(protocol.runtime.backendRoot, 'src/core/plugins/runtime-plugin-host.ts')), sha256: fileDigest(join(protocol.runtime.backendRoot, 'src/core/plugins/runtime-plugin-host.ts')) })
  const reports = []
  for (const caseName of CASES) {
    const caseDirectory = join(runDirectory, caseName), output = join(caseDirectory, 'output'), workspace = join(caseDirectory, 'workspace')
    mkdirSync(output, { recursive: true }); mkdirSync(workspace)
    const plugins = pluginsForCase(root, caseDirectory, caseName)
    const capabilities = { schemaVersion: 'gaia2-phase3-controlled-capabilities-v1', syntheticFixtureOnly: true, plugins }
    const capabilityRef = save(join(caseDirectory, 'capabilities.json'), capabilities)
    const manifestBase = { schemaVersion: 'gaia2-phase3-controlled-manifest-v1', runId, runRoot, syntheticFixtureOnly: true,
      executionBinding: 'phase3_live_plugin_host_required', lockRefs: { capabilities: { path: normalized(relative(root, capabilityRef.path)), sha256: capabilityRef.sha256 } } }
    const manifest = { ...manifestBase, manifestHash: digest(manifestBase) }
    const task = { executionId: `${runId}-${caseName}`, scenarioId: `phase3_controlled_${caseName}`, attemptIndex: 0, runNumber: 1, phase: 'controlled', config: caseName }
    const session = { sessionId: `${caseName}-session-${randomUUID().slice(0, 8)}`, outputDir: normalized(relative(root, output)), workspaceDir: normalized(relative(root, workspace)) }
    const settings = { processTimeoutMs: 180000, heartbeatIntervalMs: 1000 }
    const service = await startRuntimeHookService({ root, manifest, task, session, settings, signal })
    let actorResult, hostResult
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|ACCESS_TOKEN|AUTHORIZATION|HF_TOKEN|HUGGINGFACE_TOKEN|GAIA2_HOOK_)/i.test(key)))
      actorResult = await runChildProcess({
        command: protocol.runtime.python,
        args: [join(root, 'scripts/phase3_controlled_fixture.py'), '--case', caseName, '--report', join(output, 'fixture-report.json')],
        cwd: root, outputDir: join(output, 'actor-process'), signal, ...settings, secrets: [service.token],
        env: { ...env, PYTHONPATH: join(root, protocol.runtime.officialPythonPath), PYTHONUTF8: '1', HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', LITELLM_LOCAL_MODEL_COST_MAP: 'True', LITELLM_TELEMETRY: 'False',
          GAIA2_HOOK_URL: service.endpoint, GAIA2_HOOK_TOKEN: service.token, GAIA2_EXECUTION_ID: task.executionId, GAIA2_SESSION_ID: session.sessionId,
          GAIA2_E2E_ATTEMPT_INDEX: '0', GAIA2_E2E_MAX_ACTIONS: '20', GAIA2_RUNTIME_EVENT_FILE: join(output, 'runtime-events.jsonl') },
      })
    } finally { hostResult = await service.close() }
    const fixture = readJson(join(output, 'fixture-report.json'))
    const report = inspectCaseEvidence({ root, workspace, output, fixture, capabilities, ready: service.ready, processResult: actorResult, serviceResult: hostResult })
    report.capabilities = { path: normalized(relative(root, capabilityRef.path)), sha256: capabilityRef.sha256 }
    if (caseName !== 'hook_failure') {
      const events = lines(join(output, 'runtime-events.jsonl'))
      const runtime = collectRuntimeEvidence({ root, manifest, task, session, events, hostProcess: hostResult })
      const verified = validateRuntimeEvidence({ manifest, task, session, events, ...runtime, readEvidence: path => readFileSync(resolve(root, path)) })
      assert.equal(verified.realHooksReady, false, 'synthetic Actor evidence cannot claim original-task readiness')
      assert.equal(service.ready.processId, hostResult.pid, 'ready PID must be the actual supervised Host process')
      const captured = save(join(caseDirectory, 'production-runtime-evidence.json'), { manifest, task, session, ...runtime, verified })
      report.productionAttestationVerified = true
      report.productionEvidenceSummary = verified
      report.readyPidMatchesSupervisedPid = true
      report.productionRuntimeEvidence = { path: normalized(relative(root, captured.path)), sha256: captured.sha256 }
      report.artifacts.push(...runtime.runtimeEvidence)
    } else {
      report.productionAttestationVerified = false
      report.productionAttestationExcludedReason = 'intentionally_faulted_after_tool_hook'
    }
    reports.push(report)
    save(join(caseDirectory, 'integration-audit.json'), report)
    console.log(JSON.stringify({ status: 'passed', case: caseName, actualHost: true, actorRequests: report.actorRequests, actualToolCalls: report.actualToolCalls }))
  }
  for (const binding of bindings) assert.equal(fileDigest(resolve(root, binding.path)), binding.sha256, 'bound integration source changed during execution')
  const result = { schemaVersion: 'gaia2-phase3-controlled-validation-v1', status: 'passed', runId, syntheticFixtureOnly: true,
    realModelCalls: 0, benchmarkExecuted: false, externalNetworkUsed: false, uploaded: false, officialSubmissionReady: false,
    validationScope: 'real ARE tools and bridge + authenticated loopback HTTP + actual backend RuntimePluginHost + frozen tracked TS hooks; synthetic Actor only',
    limitations: ['No real model or original benchmark task was executed.', 'Evidence diagnostics are advisory; exact unknown-write replay protection is tested, while business sufficiency remains Actor-owned.', 'One isolated negative plugin profile deliberately fails an after_tool hook.'],
    sourceBindings: bindings, cases: reports, reportPath: normalized(join(runDirectory, 'controlled-validation.json')) }
  save(result.reportPath, result)
  return result
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort())
  try {
    const result = await runPhase3ControlledValidation({ signal: controller.signal })
    console.log(JSON.stringify({ status: result.status, reportPath: result.reportPath, cases: result.cases.length, realModelCalls: 0, benchmarkExecuted: false }))
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', errorType: error?.name ?? 'Error', realModelCalls: 0, benchmarkExecuted: false }))
    process.exitCode = 1
  }
}
