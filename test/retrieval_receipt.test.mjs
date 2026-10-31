import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import vm from 'node:vm'
import { pathToFileURL } from 'node:url'
import { createRetrievalReceipt, retrievalDigest, validateRetrievalProjection } from '../src/retrieval_receipt.mjs'

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const pluginRoot = resolve('plugins/gaia2-retrieval')
const copy = value => JSON.parse(JSON.stringify(value))
function variables() {
  return Object.fromEntries(JSON.parse(readFileSync(join(pluginRoot, 'variables.json'), 'utf8')).variables.map(item => [item.key, copy(item.value)]))
}
function hook(name) {
  return sourceHook(join(pluginRoot, 'hooks', `${name}.ts`))
}
function sourceHook(path) {
  const source = readFileSync(path, 'utf8')
    .replace(/^import .*\n/, '').replace('export default defineHook(', 'module.exports = (')
  const context = { module: { exports: null } }
  vm.runInNewContext(source, context, { timeout: 1000 })
  return context.module.exports
}
function apply(values, result) {
  for (const patch of result.patches || []) values[patch.path.split('/').at(-1)] = copy(patch.value)
  return result
}
function nativePage(values, { complete = true, viewComplete = true } = {}) {
  const action = { id: 'native-1', canonicalName: 'Contacts__get_contacts', name: 'Contacts__get_contacts',
    resourceKey: 'Contacts', effect: 'read', authoritativeRead: true, mutationKey: '1'.repeat(64), arguments: { offset: 0 } }
  const result = { contacts: ['Alice; city Stockholm; role Producer', 'Bob; city Oslo; role Cook', 'Carol; city missing; role Producer'], metadata: { range: [0, 3], total: 3 } }
  const observation = { actionId: action.id, resourceKey: 'Contacts', canonicalName: action.canonicalName,
    queryHash: action.mutationKey, resultHash: '2'.repeat(64), observedAt: 10, complete, viewComplete }
  const input = { variables: { builtin: { variables: values } }, action,
    outcome: { status: 'succeeded', complete, resultHash: observation.resultHash, result },
    messages: [{ role: 'tool', observation }], clock: { now: 11 } }
  apply(values, hook('retrieval-page-register').run(input))
  return { pageRef: 'page-1', ...observation, beforeViewComplete: viewComplete, oldBlocker: false,
    records: result.contacts.map((body, index) => ({ recordRef: `record-${index}`, path: `/contacts/${index}`, body })),
    range: [0, 3], total: 3, nextOffset: 3, sourceRef: { path: 'retrieval/page-1.json', sha256: '3'.repeat(64) } }
}
function snapshot(values) {
  const page = nativePage(values)
  const scope = { scopeId: 'scope-1', criteriaVersion: 1, revision: 1, criteria: { userRef: 'user-1', predicate: 'producer in Stockholm' }, status: 'active' }
  const retainedRecords = [
    { ...page.records[0], decision: 'keep', quotes: [{ path: '/contacts/0', quote: 'Stockholm' }] },
    { ...page.records[2], decision: 'defer', quotes: [] },
  ]
  const rejectRefs = ['record-1']
  const certificate = { pageRef: page.pageRef, actionId: page.actionId, resourceKey: page.resourceKey, canonicalName: page.canonicalName,
    queryHash: page.queryHash, resultHash: page.resultHash, observedAt: page.observedAt, complete: page.complete,
    beforeViewComplete: page.beforeViewComplete, oldBlocker: false, protected: false,
    retainedRecords, rejectRefs, scopeId: scope.scopeId, criteriaVersion: 1, reviewCommitted: true,
    projectionHash: retrievalDigest({ retainedRecords, rejectRefs }) }
  return { scope, pages: [page], candidates: retainedRecords, coverage: { readRanges: [[0, 3]], reviewedRanges: [[0, 3]], total: 3 },
    projection: { schemaVersion: 'gaia2-retrieval-projection-v1', scopeId: scope.scopeId, criteriaVersion: 1, revision: 1, certificates: [certificate] },
    control: { requestId: 'request-1', op: 'begin', reviewCommitted: true, nextReadStatus: 'succeeded' } }
}
function fixture() {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'gaia2-retrieval-receipt-'))
  mkdirSync(join(workspaceDir, 'plugin-runtime'))
  const values = variables(), snap = snapshot(values)
  apply(values, hook('retrieval-review-commit').run({ variables: { builtin: { variables: values } }, outcome: { result: { retrieval: snap } } }))
  const invocation = { checkpoint: 'before_model', loop: { iteration: 1 }, messages: [], clock: { now: 12, revision: 1 } }
  const report = { schemaVersion: 'capybara-runtime-plugin-invocation-v1', executionId: 'execution-1', sessionId: 'session-1', scenarioId: 'scenario-1',
    sequence: 2, input: copy(invocation), context: 'bounded context', contextHash: hash('bounded context'), variables: values,
    variablesHash: hash(values), revision: 3, decision: { action: 'allow', reason: 'valid' }, hookReceipts: [{ hookId: 'retrieval-view-plan', status: 'passed' }] }
  const evidencePath = join(workspaceDir, 'plugin-runtime', '000002-before_model-11111111-1111-4111-8111-111111111111.json')
  writeFileSync(evidencePath, JSON.stringify(report))
  const response = { evidencePath, context: report.context, contextHash: report.contextHash, variablesHash: report.variablesHash,
    revision: report.revision, decision: copy(report.decision), hookReceipts: copy(report.hookReceipts) }
  return { workspaceDir, values, snap, report, response, invocation, evidencePath,
    args: { workspaceDir, response, invocation, executionId: 'execution-1', sessionId: 'session-1' } }
}
function cleanup(f) { rmSync(f.workspaceDir, { recursive: true, force: true }) }

test('project receipt uses exact bound report, not response.variables or dynamic context commands', () => {
  const f = fixture()
  try {
    f.response.variables = { malicious: true }
    const receipt = createRetrievalReceipt(f.args)
    assert.equal(receipt.schemaVersion, 'gaia2-retrieval-receipt-v1')
    assert.equal(receipt.scope.scopeId, 'scope-1')
    assert.equal(receipt.sourceReceiptRef.path, 'plugin-runtime/000002-before_model-11111111-1111-4111-8111-111111111111.json')
    assert.equal(receipt.sourceReceiptRef.sha256, hash(readFileSync(f.evidencePath, 'utf8')))
    assert.equal(receipt.planHash, retrievalDigest(f.snap.projection))
    assert.deepEqual(receipt.projection.certificates[0].rejectRefs, ['record-1'])
  } finally { cleanup(f) }
})

test('report identity, full invocation, context, variables and hook receipts are bound', () => {
  for (const mutate of [r => { r.executionId = 'other' }, r => { r.sessionId = 'other' }, r => { r.input.clock.now++ },
    r => { r.sequence++ }, r => { r.variables.gaia2_retrieval_scope.revision++ }, r => { r.context = 'tampered' },
    r => { r.hookReceipts[0].status = 'failed' }]) {
    const f = fixture()
    try { mutate(f.report); writeFileSync(f.evidencePath, JSON.stringify(f.report)); assert.throws(() => createRetrievalReceipt(f.args), /retrieval_receipt/) }
    finally { cleanup(f) }
  }
})

test('receipt refuses escaping paths and symlinked report entries', () => {
  const f = fixture(), other = mkdtempSync(join(tmpdir(), 'gaia2-retrieval-foreign-'))
  try {
    f.response.evidencePath = join(other, 'report.json')
    assert.throws(() => createRetrievalReceipt(f.args), /path_escape/)
    const link = join(f.workspaceDir, 'plugin-runtime', '000002-before_model-22222222-2222-4222-8222-222222222222.json')
    try { symlinkSync(f.evidencePath, link, 'file') } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return; throw error }
    f.response.evidencePath = link
    assert.throws(() => createRetrievalReceipt(f.args), /symlink/)
  } finally { cleanup(f); rmSync(other, { recursive: true, force: true }) }
})

test('certificate retains exact keep/defer data, partitions every record and binds projection hash', () => {
  const f = fixture()
  try {
    assert.equal(validateRetrievalProjection(f.snap.projection, f.snap.scope), f.snap.projection)
    const changed = copy(f.snap.projection); changed.certificates[0].retainedRecords[0].body = 'fabricated'
    assert.throws(() => validateRetrievalProjection(changed, f.snap.scope), /projection_hash/)
    const overlap = copy(f.snap.projection); overlap.certificates[0].rejectRefs.push('record-0')
    assert.throws(() => validateRetrievalProjection(overlap, f.snap.scope), /partition/)
  } finally { cleanup(f) }
})

test('review guard permits optional partial classification but rejects duplicate records, forged quotes and unseen rejects', () => {
  const values = variables(), page = nativePage(values)
  values.gaia2_retrieval_pages.items = [page]
  values.gaia2_retrieval_scope = { scopeId: 'scope-1', criteriaVersion: 1, revision: 2 }
  const entries = page.records.map((row, i) => ({ recordRef: row.recordRef, decision: i === 1 ? 'reject' : 'defer', quotes: i === 1 ? [{ path: row.path, quote: 'Oslo' }] : [] }))
  const base = { op: 'review_finish', requestId: 'request-2', scopeId: 'scope-1', criteriaVersion: 1, expectedRevision: 2,
    reviews: [{ pageRef: page.pageRef, resultHash: page.resultHash, records: entries }] }
  const run = args => copy(hook('retrieval-review-guard').run({ variables: { builtin: { variables: values } },
    action: { canonicalName: 'CapybaraRetrieval__step', resourceKey: 'CapybaraRetrieval', effect: 'read', authoritativeRead: false, arguments: args } }))
  assert.equal(run(base).decision.action, 'allow')
  const partial = copy(base); partial.reviews[0].records.pop()
  assert.equal(run(partial).decision.action, 'allow')
  const noReview = { ...base, op: 'continue_read', nextRead: { tool: 'Contacts__get_contacts', arguments: { offset: 3 }, pages: 2 } }
  delete noReview.reviews
  assert.equal(run(noReview).decision.action, 'allow')
  for (const mutate of [a => { a.reviews[0].records[0] = a.reviews[0].records[1] },
    a => { a.reviews[0].records[1].quotes[0].path = '/contacts/1/city' }, a => { a.expectedRevision-- }]) {
    const args = copy(base); mutate(args); assert.equal(run(args).decision.action, 'block')
  }
  page.beforeViewComplete = false
  assert.equal(run(base).decision.action, 'block')
  assert.equal(run({ ...base, op: 'state_update', expectedRevision: 0 }).decision.action, 'allow')
})

test('commit rejects forged source, missing mixed-page records, and rollback without touching old runtime variables', () => {
  for (const mutate of [s => { s.pages[0].records[0].body = 'made up' }, s => { s.projection.certificates[0].retainedRecords.pop() },
    s => { s.pages[0].beforeViewComplete = false }]) {
    const values = variables(), snap = snapshot(values); mutate(snap)
    assert.throws(() => hook('retrieval-review-commit').run({ variables: { builtin: { variables: values } }, outcome: { result: { retrieval: snap } } }), /RETRIEVAL_/)
  }
  const values = variables(), snap = snapshot(values)
  const result = hook('retrieval-review-commit').run({ variables: { builtin: { variables: values } }, outcome: { result: { retrieval: snap } } })
  assert.ok(result.patches.every(patch => patch.path.startsWith('/builtin/variables/gaia2_retrieval_')))
  apply(values, result)
  snap.scope.revision = 0
  assert.throws(() => hook('retrieval-review-commit').run({ variables: { builtin: { variables: values } }, outcome: { result: { retrieval: snap } } }), /ROLLBACK/)
})

test('new official user instruction invalidates certificate eligibility, not unknown/conflict evidence', () => {
  const f = fixture()
  try {
    f.values.gaia2_write_state = { unknown: [{ actionId: 'unknown-1' }] }
    f.values.gaia2_retrieval_watch.seenUserIds = ['user-1']
    apply(f.values, hook('retrieval-scope-refresh').run({ variables: { builtin: { variables: f.values } }, messages: [
      { role: 'user', notificationType: 'USER_MESSAGE', id: 'user-1' }, { role: 'user', notificationType: 'USER_MESSAGE', id: 'user-2' },
    ] }))
    assert.equal(f.values.gaia2_retrieval_watch.invalidated, true)
    assert.deepEqual(f.values.gaia2_retrieval_projection.certificates, [])
    assert.deepEqual(f.values.gaia2_write_state.unknown, [{ actionId: 'unknown-1' }])
  } finally { cleanup(f) }
})

test('actual RuntimePluginHost loads six frozen hooks and returns a bound opt-in receipt without any model calls', () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'gaia2-retrieval-real-host-'))
  const backend = resolve('../..', 'capybara-backend')
  const files = readdirSync(pluginRoot, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const absolute = join(entry.parentPath, entry.name), relativePath = absolute.slice(pluginRoot.length + 1).replaceAll('\\', '/')
    return { relativePath, sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex') }
  }).sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  const options = { projectDir: process.cwd(), workspaceDir, executionId: 'offline-retrieval-1', sessionId: 'session-1', scenarioId: 'scenario-1',
    plugins: [{ id: 'gaia2-retrieval', snapshotRoot: pluginRoot, files }] }
  const script = `(async () => {
    const {RuntimePluginHost}=await import(${JSON.stringify(pathToFileURL(join(backend, 'src/core/plugins/runtime-plugin-host.ts')).href)});
    const {createRetrievalReceipt}=await import(${JSON.stringify(pathToFileURL(resolve('src/retrieval_receipt.mjs')).href)});
    const options=${JSON.stringify(options)}; const host=new RuntimePluginHost(options);
    try { const init=await host.initialize(); const invocation={checkpoint:'before_model',messages:[{role:'user',content:'Find the contact',id:'u1',notificationType:'USER_MESSAGE'}],clock:{now:1,revision:1},loop:{iteration:0}};
      const result=await host.invoke(invocation); const receipt=createRetrievalReceipt({response:result,invocation,...options});
      console.log(JSON.stringify({hooks:init.runtimeHooks.length,decision:result.decision.action,receipt:receipt.schemaVersion,certificates:receipt.projection.certificates.length}));
    } finally { await host.close(); }
  })().catch(error => { console.error(error); process.exitCode=1; });
  `
  try {
    const result = spawnSync(process.execPath, [`--import=${pathToFileURL(join(backend, 'node_modules/tsx/dist/loader.mjs')).href}`,
      '--conditions=development', '-e', script], { encoding: 'utf8', timeout: 30000, windowsHide: true })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    assert.deepEqual(JSON.parse(result.stdout.trim()), { hooks: 6, decision: 'allow', receipt: 'gaia2-retrieval-receipt-v1', certificates: 0 })
  } finally { rmSync(workspaceDir, { recursive: true, force: true }) }
})

function gateFixture() {
  const values = Object.fromEntries(JSON.parse(readFileSync(resolve('plugins/gaia2-runtime/variables.json'), 'utf8')).variables.map(item => [item.key, copy(item.value)]))
  Object.assign(values, variables())
  const snap = snapshot(values)
  apply(values, hook('retrieval-review-commit').run({ variables: { builtin: { variables: values } }, outcome: { result: { retrieval: snap } } }))
  const cert = values.gaia2_retrieval_projection.certificates[0]
  const observation = { actionId: cert.actionId, resourceKey: cert.resourceKey, canonicalName: cert.canonicalName, queryHash: cert.queryHash,
    resultHash: cert.resultHash, observedAt: cert.observedAt, complete: cert.complete, viewComplete: false, viewIncompleteReason: 'hidden' }
  values.gaia2_observation_state.observations = [{ ...observation, observationId: `obs-${cert.actionId}`, status: 'observed',
    viewComplete: true, outcomeStatus: 'succeeded', authoritativeRead: true, provenance: { actionId: cert.actionId, observedAt: cert.observedAt } }]
  const messages = [{ role: 'tool', id: 'message-1', toolCallId: cert.actionId, observation,
    content: JSON.stringify({ contacts: cert.retainedRecords.map(row => row.body), retrievalProjectionHash: cert.projectionHash }) }]
  const action = { id: 'target-write', canonicalName: 'Contacts__add_contact', name: 'Contacts__add_contact', effect: 'write',
    resourceKey: 'Contacts', mutationKey: '4'.repeat(64), idempotent: false, arguments: { name: 'Alice' } }
  const refresh = () => apply(values, sourceHook(resolve('plugins/gaia2-runtime/hooks/gaia2-observation-refresh.ts'))
    .run({ variables: { builtin: { variables: values } }, messages, clock: { now: 12 } }))
  const gate = () => apply(values, sourceHook(resolve('plugins/gaia2-runtime/hooks/gaia2-conflict-gate.ts'))
    .run({ variables: { builtin: { variables: values } }, action, messages, clock: { now: 12 } }))
  return { values, cert, messages, action, refresh, gate }
}

test('actual old refresh and conflict hooks accept only the intact mixed-page presentation without claiming a full view', () => {
  const f = gateFixture()
  f.refresh()
  const item = f.values.gaia2_observation_state.observations[0]
  assert.equal(item.status, 'observed')
  assert.equal(item.viewComplete, false)
  assert.equal(item.presentation, 'retrieval_filtered')
  assert.deepEqual(f.values.gaia2_observation_state.unverified_ids, [])
  assert.equal(f.gate().decision.action, 'allow')
  assert.equal(f.values.gaia2_observation_state.observations[0].status, 'observed')
})

test('retrieval does not rewrite incomplete/conflict observations or resolve unknown writes', () => {
  for (const status of ['incomplete', 'conflicting', 'failed', 'stale']) {
    const f = gateFixture()
    f.values.gaia2_observation_state.observations[0].status = status
    if (status === 'incomplete') f.values.gaia2_observation_state.observations[0].viewComplete = false
    f.refresh()
    // Retrieval metadata is evidence/presentation only, not a local approval
    // prerequisite for ordinary business tools.
    assert.equal(f.gate().decision.action, 'allow', status)
    assert.notEqual(f.values.gaia2_observation_state.observations[0].status, 'verified_by_fresh_read')
  }
  const f = gateFixture(), unknown = { actionId: 'old-unknown', resourceKey: 'Contacts', mutationKey: '5'.repeat(64), readBackObserved: true }
  f.values.gaia2_write_state.unknown = [unknown]
  f.refresh(); f.gate()
  const writeResult = sourceHook(resolve('plugins/gaia2-runtime/hooks/gaia2-write-guard.ts')).run({ variables: { builtin: { variables: f.values } }, action: f.action, loop: { iteration: 1 } })
  assert.equal(writeResult.decision.action, 'allow', 'An unrelated operation is not blocked by retrieval or same-app uncertainty')
  const exactReplay = sourceHook(resolve('plugins/gaia2-runtime/hooks/gaia2-write-guard.ts')).run({ variables: { builtin: { variables: f.values } },
    action: { ...f.action, mutationKey: unknown.mutationKey }, loop: { iteration: 1 } })
  assert.equal(exactReplay.decision.action, 'read_back', 'The exact unknown operation still cannot be replayed')
  assert.deepEqual(f.values.gaia2_write_state.unknown, [unknown])
})

test('missing retained text and changed criteria lose projection eligibility without imposing a business gate', () => {
  for (const mutate of [f => {
    const body = JSON.parse(f.messages[0].content); body.contacts.pop(); f.messages[0].content = JSON.stringify(body)
  }, f => { f.values.gaia2_retrieval_watch.invalidated = true }, f => { f.cert.oldBlocker = true }]) {
    const f = gateFixture(); mutate(f); f.refresh()
    assert.equal(f.values.gaia2_observation_state.observations[0].status, 'observed')
    assert.equal(f.values.gaia2_observation_state.visibility_ids.length, 1, 'invalid projection loses presentation authority, not original native completeness')
    assert.equal(f.gate().decision.action, 'allow')
  }
})

test('optional reject cleanup stays thin in active items but preserves raw evidence for reopen and changed criteria', () => {
  const values = variables(), snap = snapshot(values)
  const rejected = snap.pages[0].records[1]
  rejected.decision = 'reject'; delete rejected.body
  snap.pages[0].reviewCommitted = true
  const outerReview = { reviews: [{ pageRef: 'page-1', resultHash: snap.pages[0].resultHash,
    records: [{ recordRef: 'record-1', decision: 'reject', quotes: [{ path: '/contacts/1', quote: 'Oslo' }] }] }] }
  const run = action => hook('retrieval-review-commit').run({ variables: { builtin: { variables: values } },
    outcome: { result: { retrieval: snap } }, action })
  assert.throws(() => run(undefined), /REJECT_PROOF_MISSING/)
  apply(values, run({ arguments: outerReview }))
  assert.equal(values.gaia2_retrieval_pages.nativeReceipts[0].records[1].body, 'Bob; city Oslo; role Cook')
  assert.equal(values.gaia2_retrieval_pages.nativeReceipts[0].records[1].rejectedVerified, true)
  assert.equal(values.gaia2_retrieval_pages.items[0].records[1].body, undefined)
  assert.ok(!JSON.stringify(values.gaia2_retrieval_pages.items).includes('Oslo'))
  apply(values, run({ arguments: { op: 'state_update' } }))
  const guard = hook('retrieval-review-guard').run({ variables: { builtin: { variables: values } }, action: {
    canonicalName: 'CapybaraRetrieval__step', resourceKey: 'CapybaraRetrieval', effect: 'read', authoritativeRead: false,
    arguments: { op: 'reopen', requestId: 'request-reopen', scopeId: 'scope-1', criteriaVersion: 1, expectedRevision: 1 },
  } })
  assert.equal(guard.decision.action, 'allow')
  // Revising criteria invalidates the old exclusion, not the original native
  // body, observation time or hash. This restoration does not claim freshness.
  const priorReceipt = copy(values.gaia2_retrieval_pages.nativeReceipts[0])
  snap.scope.criteriaVersion = 2; snap.scope.revision = 2
  snap.control = { requestId: 'changed-criteria', op: 'revise' }
  snap.pages[0].reviewCommitted = false
  snap.pages[0].criteriaVersion = 2
  snap.pages[0].records = priorReceipt.records.map((row, index) => ({
    recordRef: `record-${index}`, path: row.path, body: row.body, decision: 'defer', quotes: [], classified: false,
  }))
  snap.candidates = copy(snap.pages[0].records)
  snap.projection = { ...snap.projection, criteriaVersion: 2, revision: 2, certificates: [] }
  apply(values, run({ arguments: { op: 'revise' } }))
  assert.equal(values.gaia2_retrieval_pages.items[0].records[1].body, 'Bob; city Oslo; role Cook')
  assert.equal(values.gaia2_retrieval_pages.items[0].observedAt, priorReceipt.observedAt)
  assert.equal(values.gaia2_retrieval_pages.items[0].resultHash, priorReceipt.resultHash)
  assert.deepEqual(values.gaia2_retrieval_projection.certificates, [])
  // The previous criterion's reject approval cannot authorize a new omission.
  snap.pages[0].reviewCommitted = true
  snap.pages[0].records[1].decision = 'reject'; delete snap.pages[0].records[1].body
  assert.throws(() => run({ arguments: { op: 'state_update' } }), /REJECT_PROOF_MISSING/)
})
