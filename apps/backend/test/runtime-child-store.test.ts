import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { childAssignment, RuntimeChildStore, type ChildSpec } from '#core/runtime-child-store'
import { emptyTaskControl } from '#core/runtime-control'
import { ProjectContextStore } from '#core/project-context-store'
import { clearSessionContexts } from '#core/context-storage-lifecycle'
import { RuntimeLoop, type RuntimeLlm } from '#core/runtime-loop'
import { initializeProjectDirectory } from '#core/project-initializer'
import type { RuntimeArtifactMeta } from '#protocol/runtime-protocol'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-child-store-'))
  const store = new RuntimeChildStore(root)
  const binding = { sessionId: 'parent', taskId: 'task', runId: 'run' }
  const spec: ChildSpec = { goal: '检查来源', prompt: '只读检查。', mode: 'async', timeoutMs: 5000, capabilityIds: ['runtime:search_resources'], maxModelRounds: 2, maxToolRounds: 2, maxTotalTokens: 40000, parentContext: '{}', runner: 'host' }
  const reserve = () => store.reserve(binding, 'call-1', spec).record
  return { root, store, binding, spec, reserve, db: () => new DatabaseSync(path.join(root, '.capybara/sessions.sqlite')),
    close() { store.close(); fs.rmSync(root, { recursive: true, force: true }) } }
}

test('child dispatch is idempotent by actual parent call and rejects changed semantics', () => {
  const f = fixture()
  try {
    const job = f.reserve(), replay = f.store.reserve(f.binding, 'call-1', f.spec)
    assert.equal(replay.created, false); assert.deepEqual(replay.record, job)
    assert.throws(() => f.store.reserve(f.binding, 'call-1', { ...f.spec, prompt: '另一任务' }), /CHILD_CALL_ID_CONFLICT/)
    assert.throws(() => f.store.reserve(f.binding, 'bad-budget', { ...f.spec, timeoutMs: -1 }), /CHILD_SPEC_INVALID/)
    assert.throws(() => f.store.load({ ...f.binding, taskId: 'other-task' }, job.id), /CHILD_BINDING_MISMATCH/)
    assert.equal(f.store.list(f.binding).length, 1)
  } finally { f.close() }
})

test('one plan node holds one child assignment until a rejected result is reviewed', () => {
  const f = fixture()
  const plan = emptyTaskControl(f.binding.taskId, '检查')
  plan.planRevision = 1
  plan.tasks = [{ id: 'source', title: '检查原件', owner: 'parent', status: 'pending', dependsOn: [], requiredActions: [],
    evidenceRefs: [], capabilityIds: ['runtime:delegate_task', 'runtime:search_resources'], completionConditions: ['提交可靠的原件'] }]
  const spec: ChildSpec = { ...f.spec, assignment: {
    planTaskId: 'source', planRevision: 1, projectionId: 'a'.repeat(64), requestId: 'model-dispatch', plan,
    capabilities: [{ source: 'system', sourceVersion: 'v1', schemaHash: 'schema', capabilityId: 'runtime:search_resources',
      name: 'search_resources', permissions: [], sideEffects: 'none', replay: 'safe' }],
  } }
  try {
    const first = f.store.reserve(f.binding, 'node-1', spec).record
    const secondConnection = new RuntimeChildStore(f.root)
    try {
      assert.equal(secondConnection.reserve(f.binding, 'node-1', spec).created, false)
      assert.throws(() => secondConnection.reserve(f.binding, 'node-2', spec), /CHILD_PLAN_TASK_ALREADY_ASSIGNED/)
      f.store.claim(f.binding, first.id, 'owner-1')
      const failed = f.store.settle(f.binding, first.id, 'owner-1', { ok: false, error: '原件无法读取' }).record
      assert.throws(() => secondConnection.reserve(f.binding, 'node-2', spec), /CHILD_PLAN_TASK_ALREADY_ASSIGNED/)
      const rejected = f.store.consume(f.binding, { childId: first.id, resultHash: failed.resultHash!, decision: 'reject',
        requestId: 'model-reject', readReceiptId: f.store.issueRead(f.binding, first.id, 'model-read', 'view'), reason: '已核对失败' })
      assert.equal(childAssignment(rejected)!.state, 'retryable')
      const second = secondConnection.reserve(f.binding, 'node-2', spec).record
      assert.notEqual(second.id, first.id)
      f.store.claim(f.binding, second.id, 'owner-2')
      const result = f.store.settle(f.binding, second.id, 'owner-2', { ok: true, output: '实际读到原件' }).record
      assert.equal((result.packet as { parent: { planTaskId: string } }).parent.planTaskId, 'source')
      f.store.consume(f.binding, { childId: second.id, resultHash: result.resultHash!, decision: 'accept',
        requestId: 'model-accept', readReceiptId: f.store.issueRead(f.binding, second.id, 'model-read-2', 'view'), reason: '已核对原件' })
      assert.throws(() => secondConnection.reserve(f.binding, 'node-3', spec), /CHILD_PLAN_TASK_ALREADY_ASSIGNED/)
    } finally { secondConnection.close() }
  } finally { f.close() }
})

test('takeover is review-bound and its action journal survives another connection until clearing', () => {
  const f = fixture()
  const plan = emptyTaskControl(f.binding.taskId, '检查')
  plan.planRevision = 1
  plan.tasks = [{ id: 'source', title: '检查原件', owner: 'parent', status: 'pending', dependsOn: [],
    requiredActions: ['tool:search_resources'], evidenceRefs: [], capabilityIds: ['runtime:delegate_task', 'runtime:search_resources'], completionConditions: ['提交原件'] }]
  const grant = { source: 'system' as const, sourceVersion: 'v1', schemaHash: 'schema', capabilityId: 'runtime:search_resources',
    name: 'search_resources', permissions: [], sideEffects: 'none' as const, replay: 'safe' as const }
  const spec: ChildSpec = { ...f.spec, assignment: { planTaskId: 'source', planRevision: 1, projectionId: 'a'.repeat(64),
    requestId: 'dispatch', plan, capabilities: [grant] } }
  const reopened = new RuntimeChildStore(f.root)
  const db = f.db()
  try {
    const child = f.store.reserve(f.binding, 'dispatch', spec).record
    const change = { childId: child.id, planTaskId: 'source', callId: 'takeover', requestId: 'model-takeover', reviewReceiptId: 'invented', reason: '父层接管' }
    assert.throws(() => f.store.takeover(f.binding, change, plan), /REVIEW_REQUIRED/)
    f.store.claim(f.binding, child.id, 'owner')
    const outcome = f.store.settle(f.binding, child.id, 'owner', { ok: false, error: '原件不可用' }).record
    const reviewed = f.store.consume(f.binding, { childId: child.id, resultHash: outcome.resultHash!, requestId: 'review',
      readReceiptId: f.store.issueRead(f.binding, child.id, 'read', 'view'), decision: 'reject', reason: '缺少原件' })
    assert.throws(() => f.store.takeover(f.binding, change, plan), /REVIEW_REQUIRED/)
    const reviewReceiptId = reviewed.consumption?.receiptId
    assert.ok(reviewReceiptId)
    const bound = { ...change, reviewReceiptId }
    const accepted = f.store.takeover(f.binding, bound, plan)
    assert.deepEqual(reopened.takeover(f.binding, bound, plan).takeover, accepted.takeover)
    assert.throws(() => reopened.takeover(f.binding, { ...bound, reason: '改写历史' }, plan), /ALREADY_REGISTERED/)
    assert.throws(() => reopened.reserve(f.binding, 'new-child', spec), /ALREADY_ASSIGNED/)
    const action = { childId: child.id, takeoverId: accepted.takeover!.id, planTaskId: 'source', toolName: grant.name, capabilityId: grant.capabilityId,
      schemaHash: grant.schemaHash, sourceVersion: grant.sourceVersion, projectionId: 'b'.repeat(64), callId: 'action-1', stepId: 'step-tool',
      argumentHash: 'c'.repeat(64), resultArtifactId: 'source-original', resultHash: 'd'.repeat(64), startedAt: 't1', completedAt: 't2', durationMs: 1 }
    f.store.recordTakeoverAction(f.binding, action)
    reopened.recordTakeoverAction(f.binding, action)
    assert.deepEqual(reopened.takeoverActions(f.binding, child.id), [action])
    assert.throws(() => reopened.recordTakeoverAction(f.binding, { ...action, argumentHash: 'changed' }), /ACTION_CONFLICT/)
    assert.throws(() => reopened.recordTakeoverAction(f.binding, { ...action, planTaskId: 'elsewhere' }), /ACTION_UNBOUND/)
    clearSessionContexts(db)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM runtime_child_takeover_actions').get() as { n: number }).n, 0)
    assert.throws(() => reopened.recordTakeoverAction(f.binding, action), /CONTEXT_SESSION_CLEARED/)
  } finally { db.close(); reopened.close(); f.close() }
})

test('child worker leases fence old callbacks and retain late source observations', () => {
  const f = fixture()
  try {
    const job = f.reserve()
    f.store.claim(f.binding, job.id, 'owner-1')
    assert.throws(() => f.store.claim(f.binding, job.id, 'owner-2'), /ALREADY_OWNED/)
    f.store.suspend(f.binding, job.id, 'owner-1'); f.store.claim(f.binding, job.id, 'owner-2')
    assert.throws(() => f.store.assertOwner(f.binding, job.id, 'owner-1'), /CHILD_LEASE_REVOKED/)
    assert.equal(f.store.settle(f.binding, job.id, 'owner-1', { ok: true, output: '旧 worker 迟到的内容' }).late, true)
    assert.equal(f.store.load(f.binding, job.id).status, 'running')
    const current = f.store.settle(f.binding, job.id, 'owner-2', { ok: true, output: '当前 worker 的原始结果' }).record
    assert.equal(current.status, 'succeeded'); assert.equal(current.output, '当前 worker 的原始结果')
    assert.equal(current.error, undefined); assert.equal((current.packet as { error: unknown }).error, null)
    assert.ok(current.resultHash)
    const db = f.db(); try { assert.equal((db.prepare('SELECT COUNT(*) AS n FROM runtime_child_late_results').get() as { n: number }).n, 1) } finally { db.close() }
  } finally { f.close() }
})

test('result review requires an actual read in another model round and keeps immutable receipts', () => {
  const f = fixture()
  try {
    const job = f.reserve(); f.store.claim(f.binding, job.id, 'owner')
    const result = f.store.settle(f.binding, job.id, 'owner', { ok: true, output: '来源 A 与 B 保留分歧' }).record
    const token = f.store.issueRead(f.binding, job.id, 'model-read', 'view-hash')
    const review = { childId: job.id, resultHash: result.resultHash!, readReceiptId: token, requestId: 'model-read', decision: 'accept' as const, reason: '接受来源，事实另行审核' }
    assert.throws(() => f.store.consume(f.binding, review), /CHILD_READ_RECEIPT_REQUIRED/)
    assert.throws(() => f.store.consume(f.binding, { ...review, requestId: 'model-review', resultHash: 'changed' }), /STALE_OR_PENDING/)
    const accepted = f.store.consume(f.binding, { ...review, requestId: 'model-review' })
    assert.ok(accepted.consumption!.receiptId)
    assert.deepEqual(f.store.consume(f.binding, { ...review, requestId: 'model-review' }), accepted)
    assert.throws(() => f.store.consume(f.binding, { ...review, requestId: 'model-review', reason: '篡改原审核' }), /ID_CONFLICT/)
    assert.throws(() => f.store.consume(f.binding, { ...review, requestId: 'model-review-2' }), /ALREADY_CONSUMED/)
  } finally { f.close() }
})

test('failed results cannot be accepted; needs_more_evidence remains unresolved until a real later review', () => {
  const f = fixture()
  try {
    const job = f.reserve(); f.store.claim(f.binding, job.id, 'owner')
    const failed = f.store.settle(f.binding, job.id, 'owner', { ok: false, error: '真实来源不可用' }).record
    const token = f.store.issueRead(f.binding, job.id, 'read', 'view')
    const input = { childId: job.id, resultHash: failed.resultHash!, readReceiptId: token, requestId: 'review-1', decision: 'accept' as const, reason: '不能虚报成功' }
    assert.throws(() => f.store.consume(f.binding, input), /FAILED_RESULT_CANNOT_BE_ACCEPTED/)
    const pending = f.store.consume(f.binding, { ...input, decision: 'needs_more_evidence' })
    assert.equal(pending.consumption!.decision, 'needs_more_evidence')
    assert.equal(f.store.consume(f.binding, { ...input, requestId: 'review-2', decision: 'reject' }).consumption!.decision, 'reject')
  } finally { f.close() }
})

test('model reservations are finite and survive worker replacement', () => {
  const f = fixture()
  try {
    const job = f.reserve(); f.store.claim(f.binding, job.id, 'owner-1')
    f.store.reserveModel(f.binding, job.id, 'owner-1', 1000)
    f.store.suspend(f.binding, job.id, 'owner-1'); f.store.claim(f.binding, job.id, 'owner-2')
    f.store.reserveModel(f.binding, job.id, 'owner-2', 2000)
    assert.throws(() => f.store.reserveModel(f.binding, job.id, 'owner-2', 1), /BUDGET_EXHAUSTED/)
    assert.throws(() => f.store.reserveModel(f.binding, job.id, 'owner-2', NaN), /BUDGET_INVALID/)
    const current = f.store.load(f.binding, job.id)
    assert.equal(current.modelRounds, 2); assert.equal(current.chargedTokens, 3000)
  } finally { f.close() }
})

test('action children use one durable writer lease and retain unknown outcomes', () => {
  const f = fixture()
  try {
    const actionSpec: ChildSpec = { ...f.spec, executionMode: 'action', attemptId: 'attempt-1' }
    const first = f.store.reserve(f.binding, 'action-call-1', actionSpec).record
    f.store.claim(f.binding, first.id, 'action-owner')
    const request = { callId: 'write-1', toolName: 'update_order', capabilityId: 'project:update_order', argumentHash: 'a'.repeat(64) }
    const lease = f.store.acquireActionLease(f.binding, first.id, 'action-owner', request)
    assert.equal(lease.outcome, 'unknown')
    assert.throws(() => f.store.acquireActionLease(f.binding, first.id, 'action-owner', { ...request, callId: 'write-2' }), /LEASE_CONFLICT/)
    const second = f.store.reserve(f.binding, 'action-call-2', actionSpec).record
    f.store.claim(f.binding, second.id, 'second-owner')
    assert.throws(() => f.store.acquireActionLease(f.binding, second.id, 'second-owner', { ...request, callId: 'write-3' }), /LEASE_CONFLICT/)
    const receipt = f.store.recordActionResult(f.binding, first.id, 'action-owner', { ...request, outcome: 'succeeded', resultArtifactId: 'artifact-1', resultHash: 'b'.repeat(64) })
    assert.equal(receipt.outcome, 'succeeded')
    assert.equal(f.store.load(f.binding, first.id).actionReceipts?.[0]?.resultHash, 'b'.repeat(64))
    assert.throws(() => f.store.recordActionResult(f.binding, first.id, 'action-owner', { ...request, outcome: 'failed', resultHash: 'c'.repeat(64) }), /RESULT_IMMUTABLE/)
    const db = f.db(); try { assert.equal((db.prepare('SELECT COUNT(*) AS n FROM runtime_child_action_leases').get() as { n: number }).n, 1) } finally { db.close() }
  } finally { f.close() }
})

test('deadline expiry and cancellation retain their real primary outcome when a result arrives late', async () => {
  const f = fixture()
  try {
    const job = f.store.reserve(f.binding, 'short', { ...f.spec, timeoutMs: 100 }).record
    f.store.claim(f.binding, job.id, 'owner')
    await delay(Math.max(1, Date.parse(job.deadlineAt) - Date.now() + 10))
    const late = f.store.settle(f.binding, job.id, 'owner', { ok: true, output: '晚于期限的成功说法' })
    assert.equal(late.late, true); assert.equal(late.record.status, 'timed_out'); assert.equal(late.record.output, undefined)
    assert.equal(f.store.cancel(f.binding, job.id, '后来取消').status, 'timed_out')
    const db = f.db(); try { assert.equal((db.prepare('SELECT COUNT(*) AS n FROM runtime_child_late_results').get() as { n: number }).n, 1) } finally { db.close() }
  } finally { f.close() }
})

test('SQL failure cannot partially reserve a job or manufacture a completed result', () => {
  const f = fixture(), db = f.db()
  try {
    db.exec("CREATE TRIGGER child_reservation_fault BEFORE INSERT ON runtime_child_tasks BEGIN SELECT RAISE(ABORT,'CHILD_RESERVATION_FAULT'); END")
    assert.throws(() => f.reserve(), /CHILD_RESERVATION_FAULT/)
    assert.equal(f.store.list(f.binding).length, 0)
    db.exec('DROP TRIGGER child_reservation_fault')
    const job = f.reserve(); f.store.claim(f.binding, job.id, 'owner')
    db.exec("CREATE TRIGGER child_settlement_fault BEFORE UPDATE ON runtime_child_tasks WHEN json_extract(NEW.state_json,'$.status')='succeeded' BEGIN SELECT RAISE(ABORT,'CHILD_SETTLEMENT_FAULT'); END")
    assert.throws(() => f.store.settle(f.binding, job.id, 'owner', { ok: true, output: '未提交的结果' }), /CHILD_SETTLEMENT_FAULT/)
    assert.equal(f.store.load(f.binding, job.id).status, 'running'); assert.equal(f.store.load(f.binding, job.id).resultHash, undefined)
    db.exec('DROP TRIGGER child_settlement_fault')
    assert.equal(f.store.settle(f.binding, job.id, 'owner', { ok: true, output: '已提交的原始结果' }).record.status, 'succeeded')
  } finally { db.close(); f.close() }
})

test('project-referenced child originals survive clearing while control jobs and stale writers do not', () => {
  const f = fixture(), project = new ProjectContextStore(f.root, f.root, 'test-constitution'), db = f.db()
  try {
    const engine = project.load(), revision = engine.snapshot().revision
    const body = JSON.stringify({ kind: 'child-result-package', output: 'A 与 B 的不同主张原文' }, null, 2)
    const meta: RuntimeArtifactMeta = { id: 'child-original', kind: 'tool-result', label: 'Child original', contentType: 'application/json', byteLength: Buffer.byteLength(body), hash: createHash('sha256').update(body).digest('hex'), preview: body, redacted: false, createdAt: new Date().toISOString() }
    project.commits.saveArtifactSource(f.binding.sessionId, meta, body)
    assert.throws(() => project.commits.saveArtifactSource(f.binding.sessionId, { ...meta, label: 'changed' }, body), /IMMUTABLE/)
    engine.observe({ candidate: { source: { actor: 'child-agent', sourceId: 'verified-child-source', capturedAt: meta.createdAt }, rawArtifactId: meta.id, normalizedContent: '保留原文来源' },
      evidence: { kind: 'artifact', referenceId: meta.id, sessionId: f.binding.sessionId, sourceHash: meta.hash } })
    project.save(engine, revision)
    const job = f.reserve(); f.store.claim(f.binding, job.id, 'owner')
    db.exec('BEGIN IMMEDIATE'); clearSessionContexts(db); db.exec('COMMIT')
    for (const table of ['runtime_child_tasks', 'runtime_child_reads', 'runtime_child_reviews', 'runtime_child_late_results', 'runtime_child_action_leases']) assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0)
    assert.equal(project.commits.readArtifactSource(meta.id, f.binding.sessionId)!.body, body)
    assert.throws(() => f.store.reserve(f.binding, 'new-call', f.spec), /CONTEXT_SESSION_CLEARED/)
    assert.throws(() => project.commits.saveArtifactSource(f.binding.sessionId, meta, body), /CONTEXT_SESSION_CLEARED/)
  } finally { db.close(); project.close(); f.close() }
})

test('a new session can page a project-referenced child original through its real tool after clearing', async () => {
  const f = fixture()
  initializeProjectDirectory(f.root)
  const project = new ProjectContextStore(f.root, f.root, 'test-constitution'), db = f.db()
  let loop: RuntimeLoop | undefined, calls = 0
  const body = JSON.stringify({ kind: 'child-result-package', output: '原始双方观点及必要条件。'.repeat(300) }, null, 2)
  const meta: RuntimeArtifactMeta = { id: 'retained-child-source', kind: 'tool-result', label: 'Original child source', contentType: 'application/json', byteLength: Buffer.byteLength(body),
    hash: createHash('sha256').update(body).digest('hex'), preview: body.slice(0, 100), redacted: false, createdAt: new Date().toISOString() }
  try {
    const engine = project.load(), revision = engine.snapshot().revision
    project.commits.saveArtifactSource('previous-session', meta, body)
    engine.observe({ candidate: { source: { actor: 'child-agent', sourceId: 'actual-source', capturedAt: meta.createdAt }, rawArtifactId: meta.id, normalizedContent: '来源中的双方主张保留在原件中。' },
      evidence: { kind: 'artifact', referenceId: meta.id, sessionId: 'previous-session', sourceHash: meta.hash } })
    project.save(engine, revision)
    db.exec('BEGIN IMMEDIATE'); clearSessionContexts(db); db.exec('COMMIT')
    const llm: RuntimeLlm = { getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'source-reader', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }), chat: async request => {
      if (++calls === 1) return { provider: 'custom', model: 'source-reader', raw: {}, text: '', toolCalls: [{ id: 'read-real-source', name: 'read_runtime_artifact', arguments: { artifact_id: meta.id, source_scope: 'project', offset: 20, limit: 300 } }] }
      const result = JSON.parse(request.messages.filter(message => message.role === 'tool' && message.name === 'read_runtime_artifact').at(-1)!.content)
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.equal(result.result.content, body.slice(20, 320)); assert.equal(result.result.source_hash, meta.hash)
      assert.equal(result.result.source_scope, 'project'); assert.equal(result.result.origin, 'runtime-artifact')
      return { provider: 'custom', model: 'source-reader', raw: {}, text: JSON.stringify({ status: 'completed', content: '已核对原件与哈希。' }) }
    } }
    loop = new RuntimeLoop({ projectDir: f.root, sessionId: 'new-reader-session', llm, streamDelayMs: 0, stepDelayMs: 0 })
    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('source reader did not complete')), 20000)
      loop!.onEvent(event => { if (event.type === 'run.state.changed' && ['completed', 'failed'].includes(event.payload.status)) { clearTimeout(timer); event.payload.status === 'completed' ? resolve() : reject(new Error(event.payload.failure!.message)) } })
    })
    const command = { version: 1 as const, kind: 'command' as const, id: 'source-page', type: 'chat.message.send' as const, sessionId: 'new-reader-session', timestamp: new Date().toISOString(),
      payload: { clientMessageId: 'read-project-source', content: [{ type: 'text' as const, text: '核对项目引用的子结果原件。' }], autoStart: true } }
    loop.validate(command); loop.execute(command, 1); await completed; assert.equal(calls, 2)
    assert.equal(loop.exportState().contextHistory!.messages.filter(message => message.id === meta.id).length, 0, 'originals are not injected as fabricated history')
  } finally { await loop?.shutdown(); db.close(); project.close(); f.close() }
})
