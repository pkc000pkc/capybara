import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { digest, fileDigest } from '../../src/phase0_run.mjs'
import { collectRuntimeEvidence, pythonEventHash } from '../../src/phase3_runtime_evidence.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const rawHash = value => hash(JSON.stringify(value))
export function runtimeFixture({ root = mkdtempSync(join(tmpdir(), 'capybara-runtime-evidence-')), syntheticFixtureOnly = false } = {}) {
  const put = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); return { path, sha256: fileDigest(join(root, path)) } }
  const task = { executionId: 'execution-1', scenarioId: 'scenario-1', phase: 'standard', config: 'execution', runNumber: 1, attemptIndex: 1, correctionOrdinal: 0, outputDir: 'runs/fixture/executions/execution-1', fixtureDir: 'runs/fixture/fixtures/execution-1', workspaceDir: 'runs/fixture/workspaces/execution-1' }
  const sessionId = '0001-aaaaaaaaaaaa', session = { sessionId, sessionOrdinal: 1, parentSessionId: null, ...Object.fromEntries(['outputDir', 'fixtureDir', 'workspaceDir'].map(key => [key, `${task[key]}/sessions/${sessionId}`])) }
  const sourceRoot = '.phase0-cache/plugins/runtime/hash', names = { 'gaia2-event-sync': 'before_model', 'gaia2-write-guard': 'before_tool', 'gaia2-conflict-gate': 'before_tool', 'gaia2-observe': 'after_tool', 'gaia2-finalize': 'attempt_end' }
  const sourceValues = {
    'capybara.plugin.json': { schemaVersion: 1, id: 'runtime', name: 'Runtime fixture', version: '1.0.0', resources: { variables: 'variables.json', harnesses: ['harnesses/manifest.json'], hooks: ['hooks'], trainingHooks: ['training-hooks'] } },
    'variables.json': { version: 1, variables: [{ key: 'gaia2_state', type: 'object', scope: 'session', readonly: false, show_in_status: true, value: { count: 0 } }, { key: 'gaia2_runtime_context', type: 'text', scope: 'session', readonly: false, show_in_status: false, value: 'Visible context' }] },
    'harnesses/manifest.json': { version: 1, package: 'runtime', harnesses: [{ name: 'contract', type: 'persistent', activation: {}, entry: 'contract.j2' }] },
    'harnesses/contract.j2': 'Visible context',
    ...Object.fromEntries(Object.entries(names).map(([name, checkpoint]) => [`hooks/${name}.ts`, `export default { name: '${name}', checkpoint: '${checkpoint}' };\n`])),
    'training-hooks/gaia2-correction.ts': "export default { name: 'gaia2-correction', checkpoint: 'after_evaluation' };\n",
  }
  const files = Object.entries(sourceValues).sort(([a], [b]) => a.localeCompare(b)).map(([relativePath, value]) => { const ref = put(`${sourceRoot}/${relativePath}`, value); return { relativePath, sha256: ref.sha256, bytes: readFileSync(join(root, ref.path)).length } })
  const capabilitiesRef = put('locks/capability-inventory.json', { plugins: [{ id: 'runtime', snapshotRoot: sourceRoot, files }] })
  const base = { schemaVersion: 'gaia2-phase2-fixture-manifest-v1', syntheticFixtureOnly, runId: 'fixture', runRoot: 'runs/fixture', stateFile: 'runs/fixture/run-state.json', mode: 'internal_pass5', models: { actor: { model: 'no-model', provider: 'controlled' } }, policy: { initialRunsPerScenario: 5, maxCorrections: 0 }, selection: { expectedInitialExecutions: 1, fullOfficialCoverage: false }, tasks: [task], lockRefs: { capabilities: capabilitiesRef }, executionBinding: 'phase3_live_plugin_host_required' }
  const manifest = { ...base, manifestHash: digest(base) }, values = { gaia2_state: { count: 0 }, gaia2_runtime_context: 'Visible context' }
  const initialization = { schemaVersion: 'capybara-runtime-plugin-host-v1', executionId: task.executionId, sessionId, plugins: [{ id: 'runtime', files, inventoryHash: rawHash(files.map(({ relativePath, sha256 }) => ({ relativePath, sha256 }))) }], harnesses: [{ id: 'runtime:contract', type: 'persistent', sourceSha256: hash('Visible context') }], runtimeHooks: Object.entries(names).sort(([a], [b]) => a.localeCompare(b)).map(([id, checkpoint]) => ({ id, checkpoint, sourceSha256: files.find(file => file.relativePath === `hooks/${id}.ts`).sha256 })), trainingHooks: [{ id: 'gaia2-correction', checkpoint: 'after_evaluation', sourceSha256: files.find(file => file.relativePath.startsWith('training-hooks/')).sha256 }], variablesHash: rawHash(values) }
  const evidenceDir = `${session.workspaceDir}/plugin-runtime`, initialPath = `${evidenceDir}/000001-initialized.json`
  put(initialPath, initialization)
  const hostProcess = { schemaVersion: 'gaia2-process-result-v1', exitCode: 0, signal: null, timedOut: false, interrupted: false, terminationErrors: [], finishedAt: new Date().toISOString(), pid: 123 }
  put(`${session.outputDir}/hook-host/process-result.json`, hostProcess)
  const readyInitialization = { ...initialization, evidencePath: join(root, initialPath) }
  put(`${session.outputDir}/hook-host/ready.json`, { schemaVersion: 'gaia2-hook-host-ready-v1', endpoint: 'http://127.0.0.1:9000/invoke', processId: 123, initialization: readyInitialization, initializationHash: rawHash(readyInitialization) })
  const action = { id: 'call-1', name: 'tool_read', canonicalName: 'app.read', effect: 'read', arguments: {}, authoritativeRead: true }
  const events = [], invocations = []
  const emit = (type, fields = {}) => events.push({ type, executionId: task.executionId, sessionId, ...fields })
  function invoke(checkpoint, fields = {}) {
    const hookReceipts = initialization.runtimeHooks.filter(hook => hook.checkpoint === checkpoint).map(hook => ({ hookId: hook.id, pluginId: 'runtime', checkpoint, sourceSha256: hook.sourceSha256, matched: true, status: 'passed', durationMs: 1, attempts: 1, patchCount: 0, ...(checkpoint === 'before_tool' ? { decision: { action: 'allow', reason: 'Safe' } } : {}) }))
    const receipt = { schemaVersion: 'capybara-runtime-plugin-invocation-v1', executionId: task.executionId, sessionId, scenarioId: task.scenarioId, sequence: invocations.length + 2, input: { checkpoint, loop: { iteration: 0, ...(checkpoint === 'attempt_end' ? { terminal: true } : {}) }, ...fields }, beforeVariablesHash: rawHash(values), decision: { action: 'allow', reason: 'Safe' }, context: 'Visible context', contextHash: hash('Visible context'), hookReceipts, variablesHash: rawHash(values), revision: 1, variables: structuredClone(values), artifacts: [] }
    put(`${evidenceDir}/${String(receipt.sequence).padStart(6, '0')}-${checkpoint}.json`, receipt); invocations.push(receipt)
    emit('live_hook_completed', { checkpoint, decision: 'allow', reasonHash: pythonEventHash('Safe'), contextHash: receipt.contextHash, variablesHash: receipt.variablesHash, hookRevision: 1, hookReceiptCount: hookReceipts.length, hookReceiptsHash: pythonEventHash(hookReceipts) })
  }
  invoke('before_model')
  emit('dynamic_context_injected', { turn: 0, contextHash: hash('Visible context'), injectedContextHash: hash('Visible context'), actorInputHash: hash('controlled actor input'), hookRevision: 1 })
  emit('model_request', { turn: 0 })
  invoke('before_tool', { action })
  emit('tool_call_started', { turn: 0, callId: action.id, function: action.name, canonicalName: action.canonicalName, effect: action.effect })
  emit('tool_call_completed', { turn: 0, callId: action.id, function: action.name, canonicalName: action.canonicalName, status: 'succeeded', resultHash: hash('controlled tool result') })
  invoke('after_tool', { action, outcome: { status: 'succeeded', executed: true, resultHash: hash('controlled tool result') } })
  emit('attempt_execution_ended')
  invoke('attempt_end')
  emit('official_validation_completed', { hasException: false, validationSuccess: true })
  put(`${session.outputDir}/runtime-events.jsonl`, events.map(event => JSON.stringify(event)).join('\n') + '\n')
  const collected = collectRuntimeEvidence({ root, manifest, task, session, events, hostProcess })
  return { root, task, session, manifest, events, hostProcess, collected, put }
}
