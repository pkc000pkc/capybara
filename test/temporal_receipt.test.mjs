import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { setTimeout as sleep } from 'node:timers/promises'
import { createTemporalReceipt, temporalDigest, validateTemporalState } from '../src/temporal_receipt.mjs'

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const copy = value => JSON.parse(JSON.stringify(value))
const pluginRoot = resolve('plugins/gaia2-runtime')
const values = () => Object.fromEntries(JSON.parse(readFileSync(join(pluginRoot, 'variables.json'), 'utf8')).variables.map(item => [item.key, copy(item.value)]))
function hook(name) {
  const source = readFileSync(join(pluginRoot, 'hooks', `${name}.ts`), 'utf8').replace(/^import .*\n/, '').replace('export default defineHook(', 'module.exports = (')
  const context = { module: { exports: null } }; vm.runInNewContext(source, context, { timeout: 1000 }); return context.module.exports
}
const apply = (vars, result) => { for (const patch of result.patches || []) vars[patch.path.split('/').at(-1)] = copy(patch.value); return result }
function state(overrides = {}) {
  return { schemaVersion: 'gaia2-temporal-state-v1', enabled: true, watchId: 'watch-1', executionId: 'execution-1', sessionId: 'session-1',
    userRef: 'user-1', goal: 'Wait for a new message', status: 'running', signal: null, sceneStart: 10, sceneNow: 10, deadline: 100,
    intervalSeconds: 20, maxScans: 10, scanCount: 0, waitCount: 0, queryTool: 'Mail__get_emails', queryArguments: {},
    baselineHash: null, lastEvidenceRef: null, waitRefs: [], ...overrides }
}
const action = { id: 'control-1', name: 'capybara_wait_watch', canonicalName: 'CapybaraTemporal__watch', effect: 'read',
  resourceKey: 'CapybaraTemporal', authoritativeRead: false, mutationKey: '1'.repeat(64), arguments: { op: 'state_update' } }
function commit(vars, next, extra = {}) {
  return hook('gaia2-temporal-commit').run({ variables: { builtin: { variables: vars } }, action,
    outcome: { status: 'succeeded', result: { temporalState: next } }, clock: { now: 100, revision: 2 }, loop: { runId: 'execution-1', iteration: 1 }, ...extra })
}
function fixture() {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'gaia2-temporal-receipt-')); mkdirSync(join(workspaceDir, 'plugin-runtime'))
  const vars = values(); apply(vars, commit(vars, state()))
  const invocation = { checkpoint: 'before_model', loop: { iteration: 1 }, messages: [], clock: { now: 10, revision: 1 } }
  const report = { schemaVersion: 'capybara-runtime-plugin-invocation-v1', executionId: 'execution-1', sessionId: 'session-1',
    sequence: 2, input: copy(invocation), context: 'bounded context', contextHash: hash('bounded context'), variables: vars,
    variablesHash: hash(vars), revision: 2, decision: { action: 'allow', reason: 'valid' }, hookReceipts: [{ hookId: 'gaia2-temporal-commit', status: 'passed' }] }
  const evidencePath = join(workspaceDir, 'plugin-runtime', '000002-before_model-11111111-1111-4111-8111-111111111111.json')
  writeFileSync(evidencePath, JSON.stringify(report))
  const response = { evidencePath, context: report.context, contextHash: report.contextHash, variablesHash: report.variablesHash,
    revision: report.revision, decision: copy(report.decision), hookReceipts: copy(report.hookReceipts) }
  return { workspaceDir, report, evidencePath, response, args: { workspaceDir, response, invocation, executionId: 'execution-1', sessionId: 'session-1' } }
}

test('temporal receipt binds fresh actual report and ignores response.variables', () => {
  const f = fixture()
  try {
    f.response.variables = { gaia2_temporal_state: { forged: true } }
    const receipt = createTemporalReceipt(f.args)
    assert.equal(receipt.schemaVersion, 'gaia2-temporal-receipt-v1')
    assert.equal(receipt.state.watchId, 'watch-1'); assert.equal(receipt.stateHash, temporalDigest(receipt.state))
    assert.equal(receipt.sourceReceiptRef.sha256, hash(readFileSync(f.evidencePath, 'utf8')))
  } finally { rmSync(f.workspaceDir, { recursive: true, force: true }) }
})

test('foreign identities, invocation changes, sequence, variable, context and hook receipt tampering fail closed', () => {
  for (const mutate of [r => { r.executionId = 'foreign' }, r => { r.sessionId = 'foreign' }, r => { r.input.clock.now++ },
    r => { r.sequence++ }, r => { r.variables.gaia2_temporal_state.scanCount++ }, r => { r.context = 'changed' }, r => { r.hookReceipts = [] }]) {
    const f = fixture()
    try { mutate(f.report); writeFileSync(f.evidencePath, JSON.stringify(f.report)); assert.throws(() => createTemporalReceipt(f.args), /temporal_receipt/) }
    finally { rmSync(f.workspaceDir, { recursive: true, force: true }) }
  }
})

test('escaping and symlinked receipt paths are rejected', () => {
  const f = fixture(), outside = mkdtempSync(join(tmpdir(), 'gaia2-temporal-outside-'))
  try {
    f.response.evidencePath = join(outside, 'report.json'); assert.throws(() => createTemporalReceipt(f.args), /path_escape/)
    const link = join(f.workspaceDir, 'plugin-runtime', '000002-before_model-22222222-2222-4222-8222-222222222222.json')
    try { symlinkSync(f.evidencePath, link, 'file') } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return; throw error }
    f.response.evidencePath = link; assert.throws(() => createTemporalReceipt(f.args), /symlink/)
  } finally { rmSync(f.workspaceDir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
})

test('all signal kinds request judgment and invalid status, budget or identity is rejected', () => {
  for (const kind of ['candidate_changed', 'initial_observation', 'deadline', 'deadline_approaching', 'scan_budget', 'native_error', 'incomplete_observation', 'user_update', 'environment_stop', 'clock_error']) {
    const next = state({ status: 'signaled', signal: { kind } }); assert.equal(validateTemporalState(next), next)
  }
  for (const next of [state({ signal: { kind: 'deadline' } }), state({ scanCount: 11 }), state({ sceneNow: 9 }),
    state({ status: 'signaled', signal: { kind: 'business_success' } })]) assert.throws(() => validateTemporalState(next), /temporal_state/)
  assert.throws(() => validateTemporalState(state(), { sessionId: 'foreign' }), /identity/)
})

test('commit preserves old business gates, records pending watch, and rejects rollback or running replacement', () => {
  const vars = values(); vars.gaia2_write_state.unknown = [{ actionId: 'old-write' }]
  vars.gaia2_progress_state.blocked_repetitions = 3
  const result = apply(vars, commit(vars, state()))
  assert.equal(vars.gaia2_clock_state.pending_waits[0].watchId, 'watch-1')
  assert.deepEqual(vars.gaia2_write_state.unknown, [{ actionId: 'old-write' }]); assert.equal(vars.gaia2_progress_state.blocked_repetitions, 3)
  assert.ok(result.patches.every(patch => !/gaia2_(?:write|progress|observation|runtime_context)/.test(patch.path)))
  assert.throws(() => commit(vars, state({ watchId: 'watch-2' })), /RUNNING_WATCH_REPLACEMENT/)
  assert.throws(() => commit(vars, state({ sceneNow: 9 })), /SCHEMA/)
  assert.throws(() => commit(vars, state({ deadline: 120 })), /ROLLBACK/)
  apply(vars, commit(vars, state({ status: 'signaled', signal: { kind: 'deadline' } })))
  assert.deepEqual(vars.gaia2_clock_state.pending_waits, [])
  assert.match(vars.gaia2_temporal_context, /not a success assertion/)
})

test('native wait/query references require exact actual after-tool ledger metadata', () => {
  const vars = values()
  const wait = { actionId: 'native-wait-1', canonicalName: 'SystemApp__wait_for_notification', queryHash: '2'.repeat(64), resultHash: '3'.repeat(64), observedAt: 30 }
  const read = { actionId: 'native-read-1', canonicalName: 'Mail__get_emails', queryHash: '4'.repeat(64), resultHash: '5'.repeat(64), observedAt: 31 }
  vars.gaia2_observation_state.observations = [{ ...wait, authoritativeRead: false, resourceKey: 'SystemApp' }, { ...read, authoritativeRead: true, resourceKey: 'Mail' }]
  const next = state({ sceneNow: 31, waitCount: 1, scanCount: 1, waitRefs: [{ ...wait, complete: true }], lastEvidenceRef: { ...read, viewComplete: true } })
  assert.doesNotThrow(() => commit(vars, next))
  for (const mutate of [s => { s.waitRefs[0].resultHash = '6'.repeat(64) }, s => { s.lastEvidenceRef.actionId = 'invented' },
    s => { s.waitRefs.push(s.waitRefs[0]); s.waitCount = 2 }, s => { s.executionId = 'foreign' }]) {
    const changed = copy(next); mutate(changed); assert.throws(() => commit(vars, changed), /TEMPORAL_/)
  }
})

test('only internal state_update commits, while control does not enter business observation or progress gates', () => {
  const control = { ...action, arguments: { queryTool: 'Mail__get_emails' } }
  assert.equal(hook('gaia2-temporal-commit').trigger({ action: control, outcome: { status: 'succeeded' } }), false)
  assert.equal(hook('gaia2-noise-classifier').trigger({ action: control }), false)
  assert.equal(hook('gaia2-conflict-gate').trigger({ action: control }), false)
})

test('enabled native waiting preserves all business stall counters; default-off keeps old behavior', () => {
  for (const enabled of [false, true]) {
    const vars = values(); if (enabled) vars.gaia2_temporal_state = state()
    vars.gaia2_progress_state = { ...vars.gaia2_progress_state, consecutive_no_progress: 4, blocked_repetitions: 2, blocked_signature: 'blocked', recommendation: 'replan_with_fresh_evidence' }
    const wait = { ...action, id: 'wait-1', canonicalName: 'SystemApp__wait_for_notification', name: 'SystemApp__wait_for_notification', effect: 'wait', resourceKey: 'SystemApp', arguments: { timeout: 20 } }
    apply(vars, hook('gaia2-noise-classifier').run({ variables: { builtin: { variables: vars } }, action: wait,
      outcome: { status: 'succeeded', complete: true, resultHash: '2'.repeat(64) }, messages: [], clock: { now: 30 } }))
    assert.equal(vars.gaia2_progress_state.consecutive_no_progress, enabled ? 4 : 0)
    assert.equal(vars.gaia2_progress_state.blocked_repetitions, enabled ? 2 : 0)
    assert.equal(vars.gaia2_progress_state.blocked_signature, enabled ? 'blocked' : null)
  }
})

test('event sync preserves active opt-in watch and attempt_end marks unfinished wait without success', () => {
  const vars = values(); apply(vars, commit(vars, state()))
  apply(vars, hook('gaia2-event-sync').run({ variables: { builtin: { variables: vars } }, messages: [], clock: { now: 12, revision: 2 }, loop: { iteration: 2 } }))
  assert.equal(vars.gaia2_clock_state.pending_waits.length, 1)
  apply(vars, hook('gaia2-attempt-finalize').run({ variables: { builtin: { variables: vars } }, loop: { iteration: 3, terminationReason: 'interrupted' } }))
  assert.equal(vars.gaia2_temporal_state.signal.kind, 'environment_stop'); assert.equal(vars.gaia2_temporal_state.signal.detail, 'interrupted')
  assert.deepEqual(vars.gaia2_clock_state.pending_waits, []); assert.match(vars.gaia2_temporal_context, /unfinished/)
})

test('real Host binds native wait, preserves old watch userRef after a new user signal, and rejects forged reference', () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'gaia2-temporal-real-host-')), backend = resolve('../..', 'capybara-backend')
  const files = readdirSync(pluginRoot, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const absolute = join(entry.parentPath, entry.name); return { relativePath: absolute.slice(pluginRoot.length + 1).replaceAll('\\', '/'), sha256: hash(readFileSync(absolute, 'utf8')) }
  }).sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  const options = { projectDir: process.cwd(), workspaceDir, executionId: 'execution-1', sessionId: 'session-1', scenarioId: 'scenario-1', plugins: [{ id: 'gaia2-runtime', snapshotRoot: pluginRoot, files }] }
  const script = `(async()=>{
    const {RuntimePluginHost}=await import(${JSON.stringify(pathToFileURL(join(backend, 'src/core/plugins/runtime-plugin-host.ts')).href)});
    const {createTemporalReceipt}=await import(${JSON.stringify(pathToFileURL(resolve('src/temporal_receipt.mjs')).href)});
    const options=${JSON.stringify(options)},host=new RuntimePluginHost(options),control=${JSON.stringify(action)},initial=${JSON.stringify(state())};
    try {const init=await host.initialize();
      const invoke=async(input)=>{const response=await host.invoke(input);return {response,receipt:createTemporalReceipt({response,invocation:input,...options})}};
      const commit=async(s,messages=[])=>invoke({checkpoint:'after_tool',action:control,outcome:{status:'succeeded',result:{temporalState:s}},messages,clock:{now:35,revision:2},loop:{iteration:1}});
      const first=await commit(initial); if(first.response.decision.action!=='allow')throw new Error(JSON.stringify(first.response.hookReceipts));
      const native={id:'native-wait-1',name:'SystemApp__wait_for_notification',canonicalName:'SystemApp__wait_for_notification',effect:'wait',resourceKey:'SystemApp',mutationKey:'2'.repeat(64),authoritativeRead:false,arguments:{timeout:20}};
      await invoke({checkpoint:'after_tool',action:native,outcome:{status:'succeeded',complete:true,resultHash:'3'.repeat(64),result:'Elapsed'},clock:{now:30,revision:2},loop:{iteration:2}});
      const next={...initial,sceneNow:30,waitCount:1,waitRefs:[{actionId:native.id,canonicalName:native.canonicalName,queryHash:native.mutationKey,resultHash:'3'.repeat(64),observedAt:30}]};
      const valid=await commit(next); if(valid.response.decision.action!=='allow')throw new Error(JSON.stringify(valid.response.hookReceipts));
      const interrupted={...next,status:'signaled',signal:{kind:'user_update'}};
      const userUpdate=await commit(interrupted,[{role:'user',id:'user-1',content:'Monitor the inbox',notificationType:'USER_MESSAGE'},{role:'user',id:'user-2',content:'Stop that monitor and handle a new task',notificationType:'USER_MESSAGE'}]);
      if(userUpdate.response.decision.action!=='allow')throw new Error(JSON.stringify(userUpdate.response.hookReceipts));
      const bad=await commit({...interrupted,waitRefs:[{...next.waitRefs[0],resultHash:'4'.repeat(64)}]});
      console.log(JSON.stringify({hooks:init.runtimeHooks.length,state:first.receipt.state.status,waitCount:valid.receipt.state.waitCount,userUpdate:userUpdate.receipt.state.signal.kind,userRef:userUpdate.receipt.state.userRef,forged:bad.response.decision.action,failedHook:bad.response.hookReceipts.find(x=>x.hookId==='gaia2-temporal-commit').errorCode,context:valid.response.context.includes('Built-in waiting controller:')}));
    }finally{await host.close()}
  })().catch(e=>{console.error(e);process.exitCode=1})`
  try {
    const result = spawnSync(process.execPath, [`--import=${pathToFileURL(join(backend, 'node_modules/tsx/dist/loader.mjs')).href}`, '--conditions=development', '-e', script], { encoding: 'utf8', timeout: 30000, windowsHide: true })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    assert.deepEqual(JSON.parse(result.stdout.trim()), { hooks: 17, state: 'running', waitCount: 1, userUpdate: 'user_update', userRef: 'user-1', forged: 'block', failedHook: 'HOOK_EXECUTION_FAILED', context: true })
  } finally { rmSync(workspaceDir, { recursive: true, force: true }) }
})

test('clock_error does not silently make a last accepted scene time become the current ARE clock', () => {
  const vars = values(), old = state({ sceneNow: 1066.874960899353, sceneStart: 1000 })
  apply(vars, commit(vars, old, { clock: { now: 1067.0502300262451, revision: 21 } }))
  const stopped = { ...old, status: 'signaled', signal: { kind: 'clock_error', detail: 'ARE scene time must be nondecreasing' } }
  assert.throws(() => commit(vars, stopped, { clock: { now: 1066.1458515177765, revision: 23 } }), /TEMPORAL_SNAPSHOT_SCHEMA/)
  assert.equal(vars.gaia2_temporal_state.sceneNow, old.sceneNow)
  assert.equal(vars.gaia2_temporal_state.signal, null)
})

test('actual HTTP project extension supports temporal and retrieval together without changing Host-owned response', async () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'gaia2-temporal-http-')), backend = resolve('../..', 'capybara-backend')
  const plugins = ['gaia2-runtime', 'gaia2-retrieval'].map(id => {
    const root = resolve('plugins', id)
    const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
      const absolute = join(entry.parentPath, entry.name); return { relativePath: absolute.slice(root.length + 1).replaceAll('\\', '/'), sha256: hash(readFileSync(absolute, 'utf8')) }
    }).sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    return { id, snapshotRoot: root, files }
  })
  const options = { projectDir: process.cwd(), workspaceDir, executionId: 'execution-1', sessionId: 'session-1', scenarioId: 'scenario-1', plugins }
  const specPath = join(workspaceDir, 'spec.json'), readyPath = join(workspaceDir, 'ready.json'), token = 'test-temporal-secret-never-a-model'.repeat(2)
  writeFileSync(specPath, JSON.stringify({ backendRoot: backend, readyPath, options, temporal: { enabled: true }, retrieval: { enabled: true } }))
  const child = spawn(process.execPath, [`--import=${pathToFileURL(join(backend, 'node_modules/tsx/dist/loader.mjs')).href}`, '--conditions=development', resolve('scripts/phase3_hook_server.ts'), '--spec', specPath], { cwd: workspaceDir, env: { ...process.env, GAIA2_HOOK_TOKEN: token }, windowsHide: true })
  let stderr = '', closed = false, exitCode = null
  child.stderr.on('data', chunk => { stderr += chunk.toString() }); child.stdout.resume()
  const closePromise = new Promise(resolveClose => child.once('close', code => { closed = true; exitCode = code; resolveClose() }))
  try {
    let ready = null
    for (let round = 0; round < 600 && !closed; round++) {
      try { ready = JSON.parse(readFileSync(readyPath, 'utf8')); break } catch {}
      await sleep(50)
    }
    assert.ok(ready, stderr || 'actual Hook server not ready')
    const invocation = { checkpoint: 'before_model', messages: [], clock: { now: 10, revision: 1 }, loop: { iteration: 1 } }
    const response = await fetch(ready.endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ executionId: options.executionId, sessionId: options.sessionId, ...invocation }), signal: AbortSignal.timeout(10000) })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.temporalReceipt.schemaVersion, 'gaia2-temporal-receipt-v1')
    assert.equal(result.retrievalReceipt.schemaVersion, 'gaia2-retrieval-receipt-v1')
    assert.equal(result.temporalReceipt.state.status, 'idle')
    const report = JSON.parse(readFileSync(resolve(workspaceDir, result.temporalReceipt.sourceReceiptRef.path), 'utf8'))
    assert.equal(Object.hasOwn(report, 'temporalReceipt'), false); assert.equal(Object.hasOwn(report, 'retrievalReceipt'), false)
    assert.equal(result.variablesHash, report.variablesHash); assert.equal(result.contextHash, report.contextHash)
    const shutdown = await fetch(ready.endpoint.replace('/invoke', '/shutdown'), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ executionId: options.executionId, sessionId: options.sessionId }), signal: AbortSignal.timeout(10000) })
    assert.equal(shutdown.status, 200)
    await Promise.race([closePromise, sleep(10000, null, { ref: false })])
    assert.equal(closed, true); assert.equal(exitCode, 0, stderr)
  } finally {
    if (!closed) { child.kill(); await Promise.race([closePromise, sleep(5000, null, { ref: false })]) }
    if (closed) rmSync(workspaceDir, { recursive: true, force: true })
  }
})
