import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import vm from 'node:vm'
import { conflictDigest, createConflictReceipt, validateConflictState } from '../src/conflict_receipt.mjs'

const pluginRoot = resolve('plugins/gaia2-runtime')
const copy = value => JSON.parse(JSON.stringify(value))
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const variables = () => Object.fromEntries(JSON.parse(readFileSync(join(pluginRoot, 'variables.json'), 'utf8')).variables.map(row => [row.key, copy(row.value)]))
const user = { role: 'user', id: 'user-1', notificationType: 'USER_MESSAGE', content: 'Clear the old events and add the new appointment.' }
const query = { start_datetime: '2024-10-18 00:00:00', end_datetime: '2024-10-21 00:00:00', limit: 100 }
const mutation = { id: 'write-1', name: 'Calendar__add_calendar_event', canonicalName: 'Calendar__add_calendar_event', effect: 'write',
  resourceKey: 'Calendar', mutationKey: '4'.repeat(64), authoritativeRead: false, idempotent: false,
  arguments: { title: 'New appointment', start_datetime: '2024-10-19 15:00:00' } }
function hook(name) {
  const source = readFileSync(join(pluginRoot, 'hooks', `${name}.ts`), 'utf8').replace(/^import .*\n/, '').replace('export default defineHook(', 'module.exports = (')
  const context = { module: { exports: null } }; vm.runInNewContext(source, context, { timeout: 1000 }); return context.module.exports
}
function apply(values, result) {
  for (const patch of result.patches || []) values[patch.path.split('/').at(-1)] = copy(patch.value)
  return result
}
function read(values, id, resultHash, args = query, queryHash = '1'.repeat(64), now = 10) {
  const action = { id, canonicalName: 'Calendar__get_calendar_events_from_to', name: 'Calendar__get_calendar_events_from_to', effect: 'read',
    resourceKey: 'Calendar', mutationKey: queryHash, authoritativeRead: true, arguments: copy(args) }
  return apply(values, hook('gaia2-noise-classifier').run({ variables: { builtin: { variables: values } }, action,
    outcome: { status: 'succeeded', complete: true, resultHash }, messages: [], clock: { now } }))
}
function gate(values, action = mutation, messages = [user], now = 15) {
  return apply(values, hook('gaia2-conflict-gate').run({ variables: { builtin: { variables: values } }, action, messages, clock: { now } }))
}
function changedObservations() {
  const values = variables(); read(values, 'read-1', '2'.repeat(64)); read(values, 'read-2', '3'.repeat(64), query, '1'.repeat(64), 11)
  return values
}
// Historical receipt fixtures only; current production never generates a recovery plan.
function legacyPlan(v2 = false) {
  const plan = { schemaVersion: 'gaia2-conflict-state-v1', status: 'blocked', userRef: user.id,
    blockedAction: { id: mutation.id, canonicalName: mutation.canonicalName, mutationKey: mutation.mutationKey, resourceKey: mutation.resourceKey },
    blockerIds: ['obs-read-1', 'obs-read-2'], requests: [{ queryTool: 'Calendar__get_calendar_events_from_to', queryArguments: copy(query),
      queryHash: '1'.repeat(64), resourceKey: 'Calendar', observationIds: ['obs-read-1', 'obs-read-2'], expectedLatestResultHash: '3'.repeat(64) }],
    reason: 'eligible_exact_query_confirmation' }
  if (v2) {
    plan.schemaVersion = 'gaia2-conflict-state-v2'; plan.reason = 'eligible_bounded_evidence_recovery'; plan.requiredResources = ['Calendar']
    Object.assign(plan.requests[0], { mode: 'native_read', sourceActionId: 'read-2', sourceObservedAt: 11 })
  }
  return plan
}

function reportFixture() {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'gaia2-conflict-receipt-')); mkdirSync(join(workspaceDir, 'plugin-runtime'))
  const values = changedObservations(); gate(values)
  const invocation = { checkpoint: 'before_model', messages: [user], clock: { now: 15, revision: 2 }, loop: { iteration: 2 } }
  const context = 'Independent conflict context'
  const report = { schemaVersion: 'capybara-runtime-plugin-invocation-v1', executionId: 'execution-1', sessionId: 'session-1', sequence: 2,
    input: copy(invocation), revision: 4, variables: values, variablesHash: hash(values), context, contextHash: hash(context),
    decision: { action: 'allow', reason: 'fixture' }, hookReceipts: [{ hookId: 'gaia2-conflict-context-refresh', status: 'passed' }] }
  const evidencePath = join(workspaceDir, 'plugin-runtime', '000002-before_model-11111111-1111-4111-8111-111111111111.json')
  writeFileSync(evidencePath, JSON.stringify(report))
  const response = { evidencePath, revision: report.revision, variablesHash: report.variablesHash, contextHash: report.contextHash,
    context, decision: copy(report.decision), hookReceipts: copy(report.hookReceipts) }
  return { workspaceDir, evidencePath, report, response, args: { workspaceDir, response, invocation, executionId: 'execution-1', sessionId: 'session-1' } }
}

test('native read provenance retains exact arguments and records changed content without a forced confirmation', () => {
  const values = changedObservations(), rows = values.gaia2_observation_state.observations
  assert.deepEqual(rows.map(row => row.queryArguments), [query, query])
  assert.deepEqual(rows.map(row => row.status), ['superseded_by_fresh_read', 'observed'])
  assert.equal(rows[1].changedFromActionId, 'read-1')
  assert.equal(gate(values).decision.action, 'allow')
  assert.equal(validateConflictState(values.gaia2_conflict_state).status, 'idle')
  assert.deepEqual(values.gaia2_conflict_state.requests, [])
  assert.equal(values.gaia2_conflict_context, '')
})

test('generic replan and advisory diagnostics do not manufacture executable recovery instructions', () => {
  const values = changedObservations(); gate(values)
  const messages = [user, { role: 'tool', id: 'feedback', content: 'native observation changed' }]
  const fixture = { variables: { builtin: { variables: values } }, messages, clock: { now: 15, revision: 2 }, loop: { iteration: 2 } }
  apply(values, hook('gaia2-event-sync').run(fixture)); apply(values, hook('gaia2-replan').run(fixture))
  assert.match(values.gaia2_runtime_context, /New visible observation IDs/)
  assert.deepEqual(values.gaia2_conflict_state.requests, [])
  assert.equal(values.gaia2_conflict_context, '')
})

test('optional same-query rereads retain provenance but never create or clear an authorization plan', () => {
  const values = changedObservations(); gate(values)
  read(values, 'optional-reread', '3'.repeat(64), query, '1'.repeat(64), 16)
  assert.deepEqual(values.gaia2_observation_state.conflict_ids, [])
  assert.equal(gate(values, { ...mutation, id: 'another-operation', mutationKey: '5'.repeat(64) }).decision.action, 'allow')
  assert.equal(gate(values, { ...mutation, id: 'original-recheck' }, [user], 17).decision.action, 'allow')
  assert.equal(values.gaia2_conflict_state.status, 'idle')
  assert.equal(values.gaia2_conflict_state.blockedAction, null)
})

test('a genuinely changed complete read is latest evidence without a redundant confirmation gate', () => {
  const values = changedObservations()
  read(values, 'changed-again', '6'.repeat(64), query, '1'.repeat(64), 16)
  assert.equal(gate(values, mutation, [user], 17).decision.action, 'allow')
  assert.equal(values.gaia2_observation_state.observations.at(-1).changedFromActionId, 'read-2')
  assert.deepEqual(values.gaia2_conflict_state.requests, [])
})

test('unknown writes protect their exact operation while missing query arguments or users do not trigger recovery', () => {
  const values = changedObservations()
  values.gaia2_write_state.unknown = [{ actionId: 'unknown-1', resourceKey: 'Calendar', mutationKey: mutation.mutationKey }]
  delete values.gaia2_observation_state.observations[0].queryArguments
  assert.equal(gate(values, mutation, []).decision.action, 'allow')
  assert.deepEqual(values.gaia2_conflict_state.requests, [])
  const guard = action => hook('gaia2-write-guard').run({ variables: { builtin: { variables: values } }, action, loop: { iteration: 1 } }).decision
  assert.equal(guard(mutation).action, 'read_back')
  assert.equal(guard({ ...mutation, mutationKey: '5'.repeat(64) }).action, 'allow')
})

test('multiple query groups remain observations and never generate bounded automatic recovery queries', () => {
  const values = changedObservations()
  read(values, 'other-old', '7'.repeat(64), { ...query, limit: 10 }, '8'.repeat(64), 12)
  read(values, 'other-new', '9'.repeat(64), { ...query, limit: 10 }, '8'.repeat(64), 13)
  assert.equal(gate(values).decision.action, 'allow')
  assert.equal(values.gaia2_observation_state.observations.length, 4)
  assert.deepEqual(values.gaia2_conflict_state.requests, [])
})

test('cross-resource dependencies are advisory metadata rather than a mandatory exact-read plan', () => {
  const values = changedObservations()
  for (const row of values.gaia2_observation_state.observations) { row.resourceKey = 'Emails'; row.canonicalName = 'EmailClientV2__list_emails'; row.status = 'failed' }
  assert.equal(gate(values, { ...mutation, resourceDependencies: ['Emails'] }).decision.action, 'allow')
  assert.deepEqual(values.gaia2_conflict_state.requests, [])
  assert.equal(values.gaia2_observation_state.unverified_ids.length, 2)
})

test('hidden views and unsupported read names remain diagnostic without synthesized native queries', () => {
  const values = variables(); read(values, 'visible', '2'.repeat(64))
  const row = values.gaia2_observation_state.observations[0]
  const observation = Object.fromEntries(['actionId', 'resourceKey', 'canonicalName', 'queryHash', 'resultHash', 'observedAt', 'complete'].map(key => [key, row[key]]))
  assert.equal(gate(values, mutation, [user, { role: 'tool', content: 'truncated', observation: { ...observation, viewComplete: false } }]).decision.action, 'allow')
  assert.deepEqual(values.gaia2_observation_state.visibility_ids, ['obs-visible'])
  assert.deepEqual(values.gaia2_conflict_state.requests, [])
  const unsupported = changedObservations()
  for (const record of unsupported.gaia2_observation_state.observations) record.canonicalName = 'Calendar__browse_events'
  assert.equal(gate(unsupported).decision.action, 'allow')
  assert.deepEqual(unsupported.gaia2_conflict_state.requests, [])
})

test('historical v2 receipt validator retains scope, duplicate, time and query-integrity protection', () => {
  const plan = legacyPlan(true)
  assert.equal(validateConflictState(plan), plan)
  for (const mutate of [
    p => { p.requiredResources = ['Elsewhere'] }, p => { p.requests[0].resourceKey = 'Elsewhere' },
    p => { p.requests[0].sourceObservedAt = -1 }, p => { p.requests[0].mode = 'execute_write' },
    p => { p.blockerIds.push('uncovered') }, p => { p.requests.push(copy(p.requests[0])) },
    p => { p.requests = Array.from({ length: 9 }, () => copy(p.requests[0])) },
    p => { p.requests[0].queryTool = 'Calendar__delete_calendar_event' }, p => { p.permissionGranted = true },
  ]) { const bad = copy(plan); mutate(bad); assert.throws(() => validateConflictState(bad)) }
  const revoked = { ...plan, requests: [], reason: 'manual_user_update' }
  assert.equal(validateConflictState(revoked), revoked)
  const values = variables(); values.gaia2_conflict_state = copy(plan)
  apply(values, hook('gaia2-conflict-context-refresh').run({ variables: { builtin: { variables: values } }, messages: [user] }))
  assert.equal(values.gaia2_conflict_state.status, 'idle', 'current production retires a historical plan rather than executing it')
  assert.deepEqual(values.gaia2_conflict_state.requests, [])
})

test('visibility loss, expiry and failed evidence remain accurately diagnosed without mandatory rereads', () => {
  for (const kind of ['hidden', 'stale', 'failed']) {
    const values = variables(); read(values, 'source', '2'.repeat(64))
    const row = values.gaia2_observation_state.observations[0]
    if (kind === 'hidden') row.viewComplete = false
    if (kind === 'failed') { row.status = 'failed'; row.outcomeStatus = 'failed_before_execution' }
    assert.equal(gate(values, mutation, [user], kind === 'stale' ? 100 : 15).decision.action, 'allow')
    assert.equal(values.gaia2_observation_state.observations[0].observedAt, 10)
    const ids = kind === 'hidden' ? 'visibility_ids' : kind === 'stale' ? 'stale_ids' : 'unverified_ids'
    assert.deepEqual(values.gaia2_observation_state[ids], ['obs-source'])
    assert.deepEqual(values.gaia2_conflict_state.requests, [])
    validateConflictState(values.gaia2_conflict_state)
  }
})

test('confirmed historical writes in three apps do not become blockers when hidden or expired', () => {
  const native = [
    ['Calendar', 'add_calendar_event', 'calendar', '62ffa557068dd1e5983758f8f25423cb6e81a48f4191edace98a2e0173881c7c'],
    ['Contacts', 'add_new_contact', 'contacts', '188862e4ba05bf06895321399c2dd1e54ef9a29fe9dc2573679abb98e5bcf47f'],
    ['EmailClientV2', 'send_email', 'email', '0da4b444925cef30e6945bff6c0d135d23fddc1c9c54c208acf889d606f24a57'],
  ]
  for (const [app, method, contract, sourceSha256] of native) {
    const values = variables()
    const action = { ...mutation, id: 'confirmed', canonicalName: app + '__' + method, resourceKey: app }
    const receipt = { schemaVersion: 'gaia2-mutation-evidence-v1', kind: 'mutation_confirmed', confirmation: 'confirmed_applied',
      receiptId: '1'.repeat(64), executionId: 'execution', sessionId: 'session', resourceKey: app,
      callRef: { actionId: action.id, canonicalName: action.canonicalName, queryHash: action.mutationKey, resultHash: '2'.repeat(64), observedAt: 10 },
      contractRef: { id: 'are-1.2.0-' + contract + '-mutation-v1', sourceSha256,
        callableSha256: '3'.repeat(64), toolUtilsSha256: '4'.repeat(64), typesSha256: '5'.repeat(64), typeUtilsSha256: '6'.repeat(64) },
      nativeProof: { kind: 'returned_mutation', exceptionType: null, executed: true, complete: true } }
    const context = { variables: { builtin: { variables: values } }, action,
      outcome: { status: 'succeeded', executed: true, complete: true, resultHash: '2'.repeat(64), mutationEvidence: receipt },
      loop: { runId: 'execution', iteration: 1 }, clock: { now: 10 }, messages: [] }
    apply(values, hook('gaia2-noise-classifier').run(context)); apply(values, hook('gaia2-write-outcome').run(context))
    const row = values.gaia2_observation_state.observations[0]
    const observation = Object.fromEntries(['actionId', 'resourceKey', 'canonicalName', 'queryHash', 'resultHash', 'observedAt', 'complete'].map(key => [key, row[key]]))
    const messages = [user, { role: 'tool', content: 'hidden', observation: { ...observation, viewComplete: false, viewIncompleteReason: 'hidden' } }]
    apply(values, hook('gaia2-observation-refresh').run({ ...context, messages, clock: { now: 1000 } }))
    assert.equal(row.status, 'confirmed_mutation')
    assert.equal(gate(values, { ...action, id: 'different', mutationKey: '9'.repeat(64) }, messages, 1000).decision.action, 'allow')
    assert.equal(hook('gaia2-write-guard').run({ ...context, action: { ...action, id: 'replay' } }).decision.action, 'block', 'historical success never permits a duplicate write')
    values.gaia2_write_state.actions[0].resultHash = 'f'.repeat(64)
    assert.throws(() => gate(values, action, messages, 1000), /MUTATION_RECEIPT_LEDGER_BINDING/)
  }
})

test('UTF-8 argument bound omits oversized provenance without creating or requiring an automatic query', () => {
  const values = variables(), oversized = { query: '汉'.repeat(2000) }
  read(values, 'large-old', '2'.repeat(64), oversized)
  read(values, 'large-new', '3'.repeat(64), oversized, '1'.repeat(64), 11)
  assert.equal(Object.hasOwn(values.gaia2_observation_state.observations[0], 'queryArguments'), false)
  assert.equal(gate(values).decision.action, 'allow')
  assert.deepEqual(values.gaia2_conflict_state.requests, [])
})

test('new user input cannot revive a legacy recovery plan or inherit its mutation authorization', () => {
  const values = variables(); values.gaia2_conflict_state = legacyPlan()
  apply(values, hook('gaia2-conflict-context-refresh').run({ variables: { builtin: { variables: values } }, messages: [user,
    { role: 'user', id: 'user-2', notificationType: 'USER_MESSAGE', content: 'Stop the old task.' }] }))
  assert.equal(values.gaia2_conflict_state.status, 'idle')
  assert.equal(values.gaia2_conflict_state.blockedAction, null)
  assert.deepEqual(values.gaia2_conflict_state.requests, [])
})

test('legacy clear state carries no approval into a new task or operation', () => {
  const values = variables()
  values.gaia2_conflict_state = { ...legacyPlan(), status: 'clear', blockerIds: [], requests: [], reason: 'evidence_gate_clear_write_not_executed' }
  apply(values, hook('gaia2-conflict-context-refresh').run({ variables: { builtin: { variables: values } }, messages: [{ ...user, id: 'new-user' }] }))
  assert.equal(validateConflictState(values.gaia2_conflict_state).status, 'idle')
  assert.equal(values.gaia2_conflict_context, '')
  assert.equal(values.gaia2_conflict_state.blockedAction, null)
})

test('receipt uses exact Host-owned report state, not arbitrary response variables', () => {
  const f = reportFixture()
  try {
    f.response.variables = { gaia2_conflict_state: { status: 'clear' } }
    const receipt = createConflictReceipt(f.args)
    assert.equal(receipt.schemaVersion, 'gaia2-conflict-receipt-v1')
    assert.equal(receipt.state.status, 'idle')
    assert.equal(receipt.stateHash, conflictDigest(receipt.state))
    assert.equal(receipt.sourceReceiptRef.sha256, hash(readFileSync(f.evidencePath, 'utf8')))
  } finally { rmSync(f.workspaceDir, { recursive: true, force: true }) }
})

test('receipt rejects forged identity, input, state, context, sequence and Hook receipts', () => {
  for (const mutate of [r => { r.executionId = 'other' }, r => { r.sessionId = 'other' }, r => { r.input.clock.now++ },
    r => { r.sequence++ }, r => { r.variables.gaia2_conflict_state.status = 'blocked' }, r => { r.context = 'tampered' }, r => { r.hookReceipts = [] }]) {
    const f = reportFixture()
    try { mutate(f.report); writeFileSync(f.evidencePath, JSON.stringify(f.report)); assert.throws(() => createConflictReceipt(f.args), /conflict_receipt/) }
    finally { rmSync(f.workspaceDir, { recursive: true, force: true }) }
  }
})

test('receipt refuses foreign paths and symlinked reports', () => {
  const f = reportFixture(), outside = mkdtempSync(join(tmpdir(), 'gaia2-conflict-foreign-'))
  try {
    f.response.evidencePath = join(outside, 'report.json'); assert.throws(() => createConflictReceipt(f.args), /path_escape/)
    const link = join(f.workspaceDir, 'plugin-runtime', '000002-before_model-22222222-2222-4222-8222-222222222222.json')
    try { symlinkSync(f.evidencePath, link, 'file') } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return; throw error }
    f.response.evidencePath = link; assert.throws(() => createConflictReceipt(f.args), /symlink/)
  } finally { rmSync(f.workspaceDir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
})

test('historical receipt state shape refuses partial blocker coverage, multiple requests, fabricated success and control queries', () => {
  const valid = legacyPlan()
  for (const mutate of [s => { s.requests[0].observationIds.pop() }, s => { s.requests.push(copy(s.requests[0])) },
    s => { s.requests[0].queryTool = 'CapybaraTemporal__watch' }, s => { s.status = 'success' }, s => { s.requests[0].queryArguments = { query: '汉'.repeat(2000) } }]) {
    const changed = copy(valid); mutate(changed); assert.throws(() => validateConflictState(changed), /conflict_/)
  }
  assert.equal(validateConflictState(variables().gaia2_conflict_state).status, 'idle')
})

function frozenPlugin(id) {
  const root = resolve('plugins', id), files = readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const absolute = join(entry.parentPath, entry.name)
    return { relativePath: absolute.slice(root.length + 1).replaceAll('\\', '/'), sha256: hash(readFileSync(absolute, 'utf8')) }
  }).sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  return { id, snapshotRoot: root, files }
}

test('actual RuntimePluginHost keeps advisory diagnostics and never produces automatic recovery plans', () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'gaia2-conflict-real-host-')), backend = resolve('../..', 'capybara-backend')
  const options = { projectDir: process.cwd(), workspaceDir, executionId: 'execution-1', sessionId: 'session-1', scenarioId: 'scenario-1', plugins: [frozenPlugin('gaia2-runtime')] }
  const script = `(async()=>{
    const {RuntimePluginHost}=await import(${JSON.stringify(pathToFileURL(join(backend, 'src/core/plugins/runtime-plugin-host.ts')).href)});
    const {createConflictReceipt}=await import(${JSON.stringify(pathToFileURL(resolve('src/conflict_receipt.mjs')).href)});
    const options=${JSON.stringify(options)},host=new RuntimePluginHost(options),mutation=${JSON.stringify(mutation)},user=${JSON.stringify(user)},query=${JSON.stringify(query)};
    try{const init=await host.initialize();
      const invoke=async(input)=>{const response=await host.invoke(input);return {response,receipt:createConflictReceipt({response,invocation:input,...options})}};
      const native=async(id,resultHash,now)=>invoke({checkpoint:'after_tool',messages:[user],clock:{now,revision:1},loop:{iteration:1},action:{id,name:'Calendar__get_calendar_events_from_to',canonicalName:'Calendar__get_calendar_events_from_to',effect:'read',resourceKey:'Calendar',authoritativeRead:true,mutationKey:'1'.repeat(64),arguments:query},outcome:{status:'succeeded',complete:true,resultHash,result:{events:[]}}});
      await native('read-1','2'.repeat(64),10);await native('read-2','3'.repeat(64),11);
      const before=()=>invoke({checkpoint:'before_tool',action:mutation,messages:[user],clock:{now:15,revision:2},loop:{iteration:2}});
      const blocked=await before();const context=await invoke({checkpoint:'before_model',messages:[user,{role:'tool',id:'blocked-feedback',content:'authoritative_read_required'}],clock:{now:15,revision:2},loop:{iteration:3}});
      const confirmation=await native('confirm','3'.repeat(64),16);const after=await invoke({checkpoint:'before_tool',action:mutation,messages:[user],clock:{now:17,revision:3},loop:{iteration:4}});
      console.log(JSON.stringify({hooks:init.runtimeHooks.length,blocked:blocked.response.decision.action,requests:blocked.receipt.state.requests.length,contextSurvives:context.response.context.includes('Conflict recovery contract:')&&context.response.context.includes(query.start_datetime),afterRead:confirmation.receipt.state.status,recheck:after.response.decision.action,final:after.receipt.state.status,writeExecuted:after.receipt.state.reason}));
    }finally{await host.close()}
  })().catch(e=>{console.error(e);process.exitCode=1})`
  try {
    const result = spawnSync(process.execPath, [`--import=${pathToFileURL(join(backend, 'node_modules/tsx/dist/loader.mjs')).href}`, '--conditions=development', '-e', script], { encoding: 'utf8', timeout: 30000, windowsHide: true })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    assert.deepEqual(JSON.parse(result.stdout.trim()), { hooks: 17, blocked: 'allow', requests: 0, contextSurvives: false,
      afterRead: 'idle', recheck: 'allow', final: 'idle', writeExecuted: null })
  } finally { rmSync(workspaceDir, { recursive: true, force: true }) }
})

test('actual HTTP conflict receipt coexists with temporal receipt and leaves Host-owned report unchanged', async () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'gaia2-conflict-http-')), backend = resolve('../..', 'capybara-backend')
  const options = { projectDir: process.cwd(), workspaceDir, executionId: 'execution-1', sessionId: 'session-1', scenarioId: 'scenario-1', plugins: [frozenPlugin('gaia2-runtime')] }
  const specPath = join(workspaceDir, 'spec.json'), readyPath = join(workspaceDir, 'ready.json'), token = 'offline-conflict-capability'.repeat(3)
  writeFileSync(specPath, JSON.stringify({ backendRoot: backend, readyPath, options, temporal: { enabled: true }, conflictRecovery: { enabled: true } }))
  const child = spawn(process.execPath, [`--import=${pathToFileURL(join(backend, 'node_modules/tsx/dist/loader.mjs')).href}`, '--conditions=development', resolve('scripts/phase3_hook_server.ts'), '--spec', specPath], { cwd: workspaceDir, env: { ...process.env, GAIA2_HOOK_TOKEN: token }, windowsHide: true })
  let closed = false, exitCode = null, stderr = ''; child.stdout.resume(); child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const closePromise = new Promise(resolveClose => child.once('close', code => { closed = true; exitCode = code; resolveClose() }))
  try {
    let ready = null
    for (let i = 0; i < 600 && !closed; i++) { try { ready = JSON.parse(readFileSync(readyPath, 'utf8')); break } catch {}; await sleep(50) }
    assert.ok(ready, stderr || 'Hook server not ready')
    const response = await fetch(ready.endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ executionId: options.executionId, sessionId: options.sessionId, checkpoint: 'before_model', messages: [user], clock: { now: 10 }, loop: { iteration: 1 } }), signal: AbortSignal.timeout(10000) })
    assert.equal(response.status, 200); const result = await response.json()
    assert.equal(result.conflictReceipt.state.status, 'idle'); assert.equal(result.temporalReceipt.state.status, 'idle')
    const report = JSON.parse(readFileSync(resolve(workspaceDir, result.conflictReceipt.sourceReceiptRef.path), 'utf8'))
    assert.equal(Object.hasOwn(report, 'conflictReceipt'), false); assert.equal(Object.hasOwn(report, 'temporalReceipt'), false)
    assert.equal(report.variablesHash, result.variablesHash); assert.equal(result.conflictReceipt.stateHash, conflictDigest(report.variables.gaia2_conflict_state))
    const shutdown = await fetch(ready.endpoint.replace('/invoke', '/shutdown'), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ executionId: options.executionId, sessionId: options.sessionId }), signal: AbortSignal.timeout(10000) })
    assert.equal(shutdown.status, 200); await Promise.race([closePromise, sleep(10000, null, { ref: false })]); assert.equal(closed, true); assert.equal(exitCode, 0, stderr)
  } finally {
    if (!closed) { child.kill(); await Promise.race([closePromise, sleep(5000, null, { ref: false })]) }
    if (closed) rmSync(workspaceDir, { recursive: true, force: true })
  }
})
