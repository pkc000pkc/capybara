import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import vm from 'node:vm'
import { createSemanticReceipt, semanticDigest, validateEntityState } from '../src/semantic_receipt.mjs'
import { verifyRuntimeSemanticReceipts } from '../scripts/runtime_semantics_e2e.mjs'

const copy = value => JSON.parse(JSON.stringify(value))
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const pluginRoot = resolve('plugins/gaia2-runtime')
const variables = () => Object.fromEntries(JSON.parse(readFileSync(join(pluginRoot, 'variables.json'), 'utf8')).variables.map(row => [row.key, copy(row.value)]))
const user = { role: 'user', id: 'user-1', notificationType: 'USER_MESSAGE', content: 'Delete event-1.' }
const entity = { resourceKey: 'Calendar', entityType: 'CalendarEvent', entityId: 'event-1' }
const contract = { id: 'are-1.2.0-calendar-entity-v1', sourceSha256: '62ffa557068dd1e5983758f8f25423cb6e81a48f4191edace98a2e0173881c7c',
  callableSha256: '1'.repeat(64), toolUtilsSha256: '2'.repeat(64), typesSha256: '3'.repeat(64), typeUtilsSha256: '4'.repeat(64) }
function hook(name) {
  const source = readFileSync(join(pluginRoot, 'hooks', `${name}.ts`), 'utf8').replace(/^import .*\n/, '').replace('export default defineHook(', 'module.exports = (')
  const context = { module: { exports: null } }; vm.runInNewContext(source, context, { timeout: 1000 }); return context.module.exports
}
function apply(values, result) {
  for (const patch of result.patches || []) values[patch.path.split('/').at(-1)] = copy(patch.value)
  return result
}
function call(kind, id, now, deleteRef = null) {
  const deleted = kind === 'delete_succeeded', action = { id, name: `Calendar__${deleted ? 'delete' : 'get'}_calendar_event`,
    canonicalName: `Calendar__${deleted ? 'delete' : 'get'}_calendar_event`, effect: deleted ? 'write' : 'read',
    resourceKey: 'Calendar', mutationKey: hash([kind, id]), authoritativeRead: !deleted, idempotent: !deleted, arguments: { event_id: 'event-1' } }
  const outcome = { status: kind === 'entity_absent' ? 'failed_before_execution' : 'succeeded', complete: true, executed: true,
    resultHash: hash([id, 'raw native result']), ...(kind === 'entity_absent' ? { errorType: 'ValueError' } : { result: deleted ? 'Deleted' : { id: 'event-1' } }) }
  const ref = { actionId: id, canonicalName: action.canonicalName, queryHash: action.mutationKey, resultHash: outcome.resultHash, observedAt: now }
  outcome.semanticEvidence = { schemaVersion: 'gaia2-entity-evidence-v1', kind, executionId: 'execution-1', sessionId: 'session-1',
    entityRef: copy(entity), callRef: ref, contractRef: copy(contract),
    nativeProof: { kind: deleted ? 'returned_delete' : kind === 'entity_absent' ? 'missing_branch' : 'returned_entity', exceptionType: kind === 'entity_absent' ? 'ValueError' : null, branchLine: kind === 'entity_absent' ? 279 : null },
    deleteReceiptRef: deleted ? { receiptId: hash(['receipt', id]), ...ref } : deleteRef }
  return { action, outcome, clock: { now, revision: 1 }, loop: { runId: 'execution-1', iteration: 1 }, messages: [user] }
}
function observe(values, frame) {
  const input = { ...frame, variables: { builtin: { variables: values } } }
  apply(values, hook('gaia2-noise-classifier').run(input)); apply(values, hook('gaia2-write-outcome').run(input))
}
function deleted() {
  const values = variables(), frame = call('delete_succeeded', 'delete-1', 10); observe(values, frame)
  return { values, deletion: frame.outcome.semanticEvidence.deleteReceiptRef }
}
function fixture() {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'gaia2-semantic-receipt-')); mkdirSync(join(workspaceDir, 'plugin-runtime'))
  const { values, deletion } = deleted(); observe(values, call('entity_absent', 'missing-1', 11, deletion))
  const invocation = { checkpoint: 'before_model', messages: [user], clock: { now: 12 }, loop: { iteration: 2 } }, context = 'Verified exact entity absence'
  const report = { schemaVersion: 'capybara-runtime-plugin-invocation-v1', executionId: 'execution-1', sessionId: 'session-1', sequence: 2,
    input: copy(invocation), revision: 4, variables: values, variablesHash: hash(values), context, contextHash: hash(context), decision: { action: 'allow', reason: 'fixture' }, hookReceipts: [{ hookId: 'gaia2-noise-classifier', status: 'passed' }] }
  const path = join(workspaceDir, 'plugin-runtime', '000002-before_model-abcd-1234.json'); writeFileSync(path, JSON.stringify(report))
  const response = { evidencePath: path, ...Object.fromEntries(['revision', 'variablesHash', 'context', 'contextHash', 'decision', 'hookReceipts'].map(key => [key, copy(report[key])])) }
  return { workspaceDir, path, report, response, args: { workspaceDir, response, invocation, executionId: 'execution-1', sessionId: 'session-1' } }
}

test('trusted exact absence explains only this post-delete read while preserving raw failure and result hash', () => {
  const { values, deletion } = deleted(), frame = call('entity_absent', 'missing-1', 11, deletion), original = copy(frame)
  observe(values, frame)
  assert.deepEqual(frame, original)
  const record = values.gaia2_observation_state.observations.at(-1)
  assert.equal(record.status, 'verified_absent_after_delete'); assert.equal(record.outcomeStatus, 'failed_before_execution')
  assert.equal(record.resultHash, frame.outcome.resultHash); assert.deepEqual(values.gaia2_observation_state.unverified_ids, [])
  assert.equal(values.gaia2_entity_state.records.length, 2); assert.equal(values.gaia2_write_state.actions[0].operation, 'delete')
  assert.match(values.gaia2_entity_context, /raw error is preserved/)
  apply(values, hook('gaia2-observation-refresh').run({ variables: { builtin: { variables: values } }, messages: [user], clock: { now: 500 } }))
  assert.equal(values.gaia2_observation_state.observations.at(-1).status, 'verified_absent_after_delete')
})

test('ordinary ValueError and default-off path remain failed without semantic evidence', () => {
  const values = variables(), frame = call('entity_absent', 'unproven', 11)
  delete frame.outcome.semanticEvidence; observe(values, frame)
  assert.equal(values.gaia2_observation_state.observations[0].status, 'failed')
  assert.equal(values.gaia2_entity_state.enabled, false)
})

test('wrong entity, deletion generation, session, native branch, contract, arguments or time fail closed', () => {
  for (const mutate of [f => { f.outcome.semanticEvidence.entityRef.entityId = 'other' }, f => { f.outcome.semanticEvidence.deleteReceiptRef.receiptId = 'f'.repeat(64) },
    f => { f.outcome.semanticEvidence.sessionId = 'other' }, f => { f.outcome.semanticEvidence.nativeProof.branchLine = 280 },
    f => { f.outcome.semanticEvidence.contractRef.sourceSha256 = 'f'.repeat(64) }, f => { f.action.arguments.extra = 'x' },
    f => { f.outcome.semanticEvidence.callRef.observedAt = 12 }, f => { f.outcome.status = 'unknown' }]) {
    const { values, deletion } = deleted(), frame = call('entity_absent', 'missing-1', 11, copy(deletion)); mutate(frame)
    assert.throws(() => observe(values, frame), /ENTITY_/)
  }
})

test('entity reconstruction and a later successful delete invalidate the old deletion reference', () => {
  for (const kind of ['entity_present', 'delete_succeeded']) {
    const { values, deletion } = deleted(); observe(values, call(kind, 'new-generation', 11))
    assert.throws(() => observe(values, call('entity_absent', 'stale-proof', 12, deletion)), /ENTITY_ABSENCE_DELETE_BINDING/)
  }
})

test('unknown writes and other same-resource failed queries are never cleared by a point absence proof', () => {
  const { values, deletion } = deleted()
  values.gaia2_write_state.unknown = [{ actionId: 'uncertain', mutationKey: 'u', resourceKey: 'Calendar', status: 'unknown' }]
  const other = call('entity_absent', 'other-query', 11); delete other.outcome.semanticEvidence
  other.action.canonicalName = 'Calendar__get_calendar_events_from_to'; other.action.arguments = { limit: 10 }; observe(values, other)
  observe(values, call('entity_absent', 'missing-1', 12, deletion))
  assert.equal(values.gaia2_write_state.unknown.length, 1)
  assert.deepEqual(values.gaia2_observation_state.unverified_ids, ['obs-other-query'])
  const action = { ...call('delete_succeeded', 'new-write', 13).action, mutationKey: 'different' }
  const response = hook('gaia2-conflict-gate').run({ variables: { builtin: { variables: values } }, action, messages: [user], clock: { now: 13 } })
  assert.equal(response.decision.action, 'allow')
  assert.match(response.decision.reason, /advisory/)
  assert.equal(values.gaia2_write_state.unknown.length, 1)
})

test('unmapped and unknown native writes invalidate resource tombstones without claiming deletion', () => {
  for (const status of ['succeeded', 'unknown']) {
    const { values, deletion } = deleted(), frame = call('delete_succeeded', 'other-write', 11)
    frame.action.canonicalName = 'Calendar__add_calendar_event'; delete frame.outcome.semanticEvidence; frame.outcome.status = status
    observe(values, frame)
    assert.equal(values.gaia2_entity_state.records[0].invalidatedBy.actionId, 'other-write')
    assert.match(values.gaia2_entity_context, /invalidatedBy/)
    assert.throws(() => observe(values, call('entity_absent', 'stale-absence', 12, deletion)), /ENTITY_ABSENCE_DELETE_BINDING/)
    assert.equal(values.gaia2_write_state.unknown.length, status === 'unknown' ? 1 : 0)
  }
})

test('semantic receipt reads Host state and ignores caller-supplied response.variables', () => {
  const f = fixture()
  try {
    f.response.variables = { gaia2_entity_state: { enabled: false } }
    const receipt = createSemanticReceipt(f.args)
    assert.equal(receipt.entityState.records.length, 2); assert.equal(receipt.entityStateHash, semanticDigest(receipt.entityState))
    assert.equal(receipt.sourceReceiptRef.sha256, hash(readFileSync(f.path, 'utf8')))
    assert.equal(receipt.schemaVersion, 'gaia2-semantic-receipt-v2')
    assert.equal(Object.hasOwn(receipt, 'taskContractState'), false)
    assert.equal(Object.hasOwn(receipt, 'taskContractStateHash'), false)
  } finally { rmSync(f.workspaceDir, { recursive: true, force: true }) }
})

test('new semantic receipt does not require or validate retired task-contract state', () => {
  const f = fixture()
  try {
    delete f.report.variables.gaia2_task_contract_state
    f.report.variablesHash = hash(f.report.variables)
    f.response.variablesHash = f.report.variablesHash
    writeFileSync(f.path, JSON.stringify(f.report))
    const receipt = createSemanticReceipt(f.args)
    assert.equal(receipt.schemaVersion, 'gaia2-semantic-receipt-v2')
    assert.equal(Object.hasOwn(receipt, 'taskContractState'), false)
    assert.equal(receipt.entityStateHash, semanticDigest(receipt.entityState))
  } finally { rmSync(f.workspaceDir, { recursive: true, force: true }) }
})

test('independent verifier accepts new receipts and retains strict read-only legacy receipt validation', async () => {
  const f = fixture()
  try {
    const current = createSemanticReceipt({ ...f.args, mutationReceipts: true })
    const { checkpoint, ...request } = f.args.invocation
    const captures = [{ checkpoint, request, response: { semanticReceipt: current } }]
    const args = { root: f.workspaceDir, workspace: f.workspaceDir, executionId: 'execution-1', sessionId: 'session-1', captures }
    assert.equal((await verifyRuntimeSemanticReceipts(args)).length, 1)
    current.writeStateHash = 'f'.repeat(64)
    await assert.rejects(verifyRuntimeSemanticReceipts(args))
    current.writeStateHash = semanticDigest(current.writeState)
    const legacy = { ...current, schemaVersion: 'gaia2-semantic-receipt-v1',
      taskContractState: copy(f.report.variables.gaia2_task_contract_state),
      taskContractStateHash: semanticDigest(f.report.variables.gaia2_task_contract_state) }
    captures[0].response.semanticReceipt = legacy
    assert.equal((await verifyRuntimeSemanticReceipts(args)).length, 1)
    legacy.taskContractStateHash = 'f'.repeat(64)
    await assert.rejects(verifyRuntimeSemanticReceipts(args))
  } finally { rmSync(f.workspaceDir, { recursive: true, force: true }) }
})

test('identity, invocation, sequence, hashes, context, decision and Hook report tampering are rejected', () => {
  for (const mutate of [r => { r.executionId = 'other' }, r => { r.sessionId = 'other' }, r => { r.input.clock.now++ },
    r => { r.sequence++ }, r => { r.variables.gaia2_entity_state.enabled = false }, r => { r.context = 'tampered' }, r => { r.hookReceipts = [] }]) {
    const f = fixture()
    try { mutate(f.report); writeFileSync(f.path, JSON.stringify(f.report)); assert.throws(() => createSemanticReceipt(f.args), /semantic_/) }
    finally { rmSync(f.workspaceDir, { recursive: true, force: true }) }
  }
})

test('semantic receipt refuses escape paths and report symlinks', () => {
  const f = fixture(), outside = mkdtempSync(join(tmpdir(), 'gaia2-semantic-outside-'))
  try {
    f.response.evidencePath = join(outside, 'report.json'); assert.throws(() => createSemanticReceipt(f.args), /path_escape/)
    const link = join(f.workspaceDir, 'plugin-runtime', '000002-before_model-ffff-1234.json')
    try { symlinkSync(f.path, link, 'file') } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return; throw error }
    f.response.evidencePath = link; assert.throws(() => createSemanticReceipt(f.args), /symlink/)
  } finally { rmSync(f.workspaceDir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
})

test('state rejects foreign proof identities, duplicate calls and disabled nonempty records', () => {
  const { values } = deleted(), good = values.gaia2_entity_state
  for (const mutate of [s => { s.records[0].sessionId = 'other' }, s => { s.records.push(copy(s.records[0])) }, s => { s.enabled = false }]) {
    const state = copy(good); mutate(state)
    assert.throws(() => validateEntityState(state, { executionId: 'execution-1', sessionId: 'session-1' }), /semantic_/)
  }
})

function frozenPlugin() {
  const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)])
  return { id: 'gaia2-runtime', snapshotRoot: pluginRoot, files: walk(pluginRoot).map(path => ({ relativePath: path.slice(pluginRoot.length + 1).replaceAll('\\', '/'), sha256: hash(readFileSync(path, 'utf8')) })) }
}

test('real HTTP Host keeps raw error, binds semantic receipt and refuses semantic input when disabled', async () => {
  for (const enabled of [true, false]) {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'gaia2-semantic-http-')), backend = resolve('../..', 'capybara-backend')
    const options = { projectDir: process.cwd(), workspaceDir, executionId: 'execution-1', sessionId: 'session-1', scenarioId: 'scenario-1', plugins: [frozenPlugin()] }
    const specPath = join(workspaceDir, 'spec.json'), readyPath = join(workspaceDir, 'ready.json'), token = 'offline-semantic-capability'.repeat(3)
    writeFileSync(specPath, JSON.stringify({ backendRoot: backend, readyPath, options, ...(enabled ? { entitySemantics: { enabled: true } } : {}) }))
    const child = spawn(process.execPath, [`--import=${pathToFileURL(join(backend, 'node_modules/tsx/dist/loader.mjs')).href}`, '--conditions=development', resolve('scripts/phase3_hook_server.ts'), '--spec', specPath], { cwd: workspaceDir, env: { ...process.env, GAIA2_HOOK_TOKEN: token }, windowsHide: true })
    let closed = false, stderr = ''; child.stdout.resume(); child.stderr.on('data', chunk => { stderr += chunk.toString() })
    const closePromise = new Promise(resolveClose => child.once('close', () => { closed = true; resolveClose() }))
    try {
      let ready
      for (let i = 0; i < 600 && !closed; i++) { try { ready = JSON.parse(readFileSync(readyPath, 'utf8')); break } catch {}; await sleep(50) }
      assert.ok(ready, stderr || 'Host not ready')
      const post = async frame => {
        const { action, outcome, clock, messages } = frame
        return fetch(ready.endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ executionId: options.executionId, sessionId: options.sessionId, checkpoint: 'after_tool', action, outcome, clock, messages, loop: { iteration: 1 } }), signal: AbortSignal.timeout(10000) })
      }
      const deletion = call('delete_succeeded', 'delete-1', 10), first = await post(deletion)
      assert.equal(first.status, enabled ? 200 : 422)
      if (enabled) {
        const response = await post(call('entity_absent', 'missing-1', 11, deletion.outcome.semanticEvidence.deleteReceiptRef))
        assert.equal(response.status, 200, stderr); const result = await response.json()
        const report = JSON.parse(readFileSync(resolve(workspaceDir, result.semanticReceipt.sourceReceiptRef.path), 'utf8'))
        assert.equal(report.input.outcome.status, 'failed_before_execution')
        assert.equal(report.variables.gaia2_observation_state.observations.at(-1).status, 'verified_absent_after_delete')
        assert.match(result.context, /Exact native entity evidence:/)
        assert.equal(Object.hasOwn(report, 'semanticReceipt'), false)
        assert.equal(result.semanticReceipt.entityStateHash, semanticDigest(report.variables.gaia2_entity_state))
        assert.equal(result.semanticReceipt.schemaVersion, 'gaia2-semantic-receipt-v2')
        assert.equal(Object.hasOwn(result.semanticReceipt, 'taskContractState'), false)
        const retired = await post({ ...deletion, action: { ...deletion.action, canonicalName: 'CapybaraTaskContract__commit' } })
        assert.equal(retired.status, 422)
      }
      const response = await fetch(ready.endpoint.replace('/invoke', '/shutdown'), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ executionId: options.executionId, sessionId: options.sessionId }) })
      assert.equal(response.status, 200); await Promise.race([closePromise, sleep(10000, null, { ref: false })]); assert.equal(closed, true)
    } finally {
      if (!closed) { child.kill(); await Promise.race([closePromise, sleep(5000, null, { ref: false })]) }
      if (closed) rmSync(workspaceDir, { recursive: true, force: true })
    }
  }
})
