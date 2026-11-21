import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { initializeProjectDirectory } from '#core/project-initializer'
import { RuntimeLoop, type RuntimeLlm } from '#core/runtime-loop'
import { ContextCommitStore } from '#core/context-commit-store'
import { ContextDocumentEngine } from '#core/context-document-engine'
import { ProjectResources } from '#core/project-resources'
import { validateContextTrainingSample } from '#core/context-training-recorder'
import type { ClientCommand, ControlEnvelopeV2, RuntimeContextTreeBinding, RuntimePlanTask, RuntimeRequestBinding } from '#protocol/runtime-protocol'

const { readContextTree } = createRequire(import.meta.url)('./fixtures/context-model-view.cjs') as {
  readContextTree: (markdown: string) => { version: number; nodes: RuntimeContextTreeBinding[] }
}

test('actual RuntimeLoop requests drive incremental document layout and preserve replayable training operations', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-tree-runtime-'))
  const sessionId = 'tree-runtime-session'
  initializeProjectDirectory(projectDir)
  new ProjectResources(projectDir).saveSettings({ context_organization_version: 4, max_tool_rounds: 12,
    context: { context_window_tokens: 32_000, max_input_tokens: 24_000, reserved_output_tokens: 4096 } })
  const initial = ContextDocumentEngine.create({ sessionId, projectId: projectDir, constitutionRevision: 'test' })
  const foreignSourceId = 'prior-unrelated-source'
  const capturedAt = new Date().toISOString()
  const foreignEvidence = initial.addEvidence({ kind: 'message', referenceId: foreignSourceId, sessionId, observedAt: capturedAt })
  initial.addCandidate({ source: { actor: 'user', sourceId: foreignSourceId, capturedAt }, rawArtifactId: foreignSourceId,
    normalizedContent: '这条记录属于另一份材料。', evidenceRefs: [foreignEvidence.id] })
  const fixtureStore = new ContextCommitStore(projectDir)
  try { fixtureStore.saveSession(sessionId, initial.exportState()) } finally { fixtureStore.close() }
  let calls = 0, submittedNativeEdit = false, submittedUnboundEvidence = false, submittedStaleHash = false, submittedStaleEditBinding = false
  let nativeRequestId = ''
  let rejectModelAssertion: (error: unknown) => void
  const modelAssertion = new Promise<never>((_, reject) => { rejectModelAssertion = reject })
  const reply = (request: Parameters<RuntimeLlm['chat']>[0]) => {
    calls += 1
    const round = calls - Number(submittedNativeEdit) - Number(submittedUnboundEvidence) - Number(submittedStaleHash) - Number(submittedStaleEditBinding)
    const system = request.messages[0]!.content
    const binding = JSON.parse(system.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)![0])
    const session = system.slice(system.indexOf('# Session Context'))
    const context = JSON.parse(session.match(/<!-- capybara:context-binding data=(\{[^\n]+?\}) -->/)![1]!)
    const tree = readContextTree(session)
    assert.equal(tree.version, 2)
    const { nodes } = tree
    const state = JSON.parse(system.split('\n').find(line => line.startsWith('{"taskId":'))!)
    if (round === 1) {
      if (submittedUnboundEvidence) {
        assert.deepEqual(request.tools, [])
        assert.match(request.messages.at(-1)!.content, /EVIDENCE_NOT_BOUND.*own candidate-ref.*separate edits/)
        assert.ok(state.recentContextEdits.every((edit: { result: string }) => edit.result === 'rejected'))
        assert.ok(state.recentContextEdits.some((edit: { errorCode: string }) => edit.errorCode === 'EVIDENCE_NOT_BOUND'))
        assert.ok(nodes.every(node => node.kind !== 'entry'))
      } else if (submittedNativeEdit) {
        assert.equal(state.recentContextEdits, undefined)
        assert.equal(request.responseFormat, 'text')
        assert.deepEqual(request.tools, [])
        assert.notEqual(binding.requestId, nativeRequestId)
        assert.match(request.messages.at(-1)!.content, /RUNTIME_CONTROL_TRANSPORT.*recentContextEdits.*propose_diff.*ControlEnvelopeV2/)
        assert.match(request.messages.at(-1)!.content, /one candidateDiffs array/)
      } else assert.equal(state.recentContextEdits, undefined)
    }
    else {
      const edit = state.recentContextEdits.findLast((item: { result: string }) => item.result === 'applied')
      assert.equal(edit.operation, ['add_entry', 'add_heading', 'rename_heading', 'move_node', 'reorder_children', 'reorder_children', 'reorder_children'][round - 2])
      assert.equal(edit.result, 'applied')
      assert.match(edit.receiptId, /^receipt-/)
      assert.ok(edit.nextRevision <= context.baseRevision)
      if (round === 2) {
        assert.deepEqual(edit.headingPath, ['证据', '客户邮件'])
        assert.equal(edit.changedEntryIds.length, 1)
        assert.ok(nodes.some(node => node.kind === 'entry' && node.id === edit.changedEntryIds[0]))
      }
    }
    if (round === 5 && submittedStaleHash) {
      assert.equal(state.recentContextEdits.at(-1).errorCode, 'TREE_NODE_HASH_CONFLICT')
      assert.ok(request.messages.some(message => message.content.includes('Document edit rejected (TREE_NODE_HASH_CONFLICT)')))
    }
    if (round === 3 && submittedStaleEditBinding) assert.ok(request.messages.some(message => message.content.includes('Your decision used a previous request ID')))
    if (round >= 7) assert.equal(state.recentContextEdits.at(-1).unchanged, true)
    assert.doesNotMatch(session, /capybara:(candidate|entry)-meta/)
    const candidates = [...session.matchAll(/<!-- capybara:candidate-ref data=(\{[^\n]+?\}) -->/g)].map(match => JSON.parse(match[1]!))
    const user = candidates.find((candidate) => candidate.source.sourceId === 'tree-user')
    assert.ok(user, 'the actual user source remains available during multiple accepted layout edits')
    const userEvidence = user.evidence.map((evidence: { id: string }) => evidence.id)
    assert.ok(userEvidence.length > 0)
    const envelope: ControlEnvelopeV2 = { envelopeVersion: 2, binding, decision: 'propose_diff', userMessage: '', actions: [], planProposal: null, candidateDiffs: [], evidenceRequests: [], uncertainties: [], waitSpec: null, completionCheck: null }
    if (round === 1) {
      envelope.candidateDiffs = ['A：125 USD', 'B：120 USD'].map((body, index) => ({ ...context, scope: 'session', candidateId: user.id,
        target: { section: 'information', headingPath: ['证据', index === 0 ? '订单系统' : '客户邮件'] }, operation: 'add_entry', payload: { body, evidenceRefs: userEvidence }, idempotencyKey: `facts-${index}` }))
      if (submittedNativeEdit && !submittedUnboundEvidence) {
        submittedUnboundEvidence = true
        envelope.candidateDiffs[1]!.payload.evidenceRefs = [foreignEvidence.id]
      }
    } else if (round <= 6) {
      const source = nodes.find((node) => node.title === '证据' || node.title === '双方材料')!
      const target = round === 2 ? nodes.find((node) => node.kind === 'root')! : source
      const destination = nodes.find((node) => node.title === '待核实')
      const operation = round === 2 ? 'add_heading' : round === 3 ? 'rename_heading' : round === 4 ? 'move_node' : 'reorder_children'
      const payload = round === 2 ? { title: '待核实' } : round === 3 ? { title: '双方材料' } : round === 4 ? { parentNodeId: destination!.id }
        : { childIds: round === 5 ? [...target.childIds!].reverse() : target.childIds! }
      const stale = round === 5 && !submittedStaleHash
      if (stale) submittedStaleHash = true
      envelope.candidateDiffs = [{ ...context, scope: 'session', diffVersion: 2, targetNodeHash: stale ? '0'.repeat(64) : target.hash, target: { section: 'information', nodeId: target.id },
        candidateId: user.id, operation, payload: { ...payload, evidenceRefs: userEvidence }, idempotencyKey: `layout-${calls}` }]
      if (round === 3 && !submittedStaleEditBinding) {
        submittedStaleEditBinding = true
        envelope.binding = { ...binding, requestId: state.recentContextEdits.at(-1).sourceRequestId }
      }
    } else {
      assert.ok(round === 7 || round === 8)
      if (round === 8) assert.ok(request.messages.some(message => message.content.includes('Your decision used a previous request ID')))
      const bodyA = session.indexOf('A：125 USD'), bodyB = session.indexOf('B：120 USD')
      assert.ok(bodyB >= 0 && bodyA > bodyB, `projected offsets A=${bodyA}, B=${bodyB}; headings=${nodes.filter(node => node.kind === 'heading').map(node => node.title).join(',')}`)
      const entries = [...session.matchAll(/<!-- capybara:entry-ref data=(\{[^\n]+?\}) -->/g)].map(match => JSON.parse(match[1]!))
      assert.equal(entries.length, 2)
      for (const entry of entries) {
        assert.ok(nodes.some(node => node.kind === 'entry' && node.id === entry.id))
        assert.deepEqual(entry.sourceCandidateIds, [user.id])
        assert.deepEqual(entry.evidence, user.evidence)
      }
      Object.assign(envelope, { decision: 'finish', userMessage: '双方材料已分别保留并完成章节整理。', completionCheck: { taskId: binding.taskId, requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '完成文档排版并保留两方说法' } })
      if (round === 7) envelope.binding = { ...binding, requestId: state.recentContextEdits.at(-1).sourceRequestId }
    }
    return envelope
  }
  const llm: RuntimeLlm = {
    getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }),
    async chat(request) {
      try {
        const envelope = reply(request)
        if (!submittedNativeEdit) {
          submittedNativeEdit = true
          nativeRequestId = envelope.binding.requestId
          return { provider: 'custom', model: 'test', finishReason: 'tool_calls', raw: {}, text: '',
            toolCalls: envelope.candidateDiffs.map((diff, index) => ({ id: `unprojected-edit-${index}`, name: 'propose_diff', arguments: diff })) }
        }
        return { provider: 'custom', model: 'test', finishReason: 'stop', raw: {}, text: JSON.stringify(envelope) }
      } catch (error) {
        rejectModelAssertion(error)
        return { provider: 'custom', model: 'test', finishReason: 'stop', raw: {}, text: '' }
      }
    },
  }
  const loop = new RuntimeLoop({ projectDir, sessionId, llm, contextOrganization: { minGroups: 100 }, stepDelayMs: 0, streamDelayMs: 0 })
  let store: ContextCommitStore | undefined
  try {
    const finished = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('tree run timed out')) }, 12000)
      const off = loop.onEvent((event) => {
        if (event.type !== 'run.state.changed' || !['completed', 'failed'].includes(event.payload.status)) return
        clearTimeout(timer); off()
        if (event.payload.status === 'failed') reject(new Error(event.payload.failure?.message)); else resolve()
      })
    })
    const command = { version: 1, kind: 'command', id: 'tree-command', type: 'chat.message.send', sessionId, timestamp: new Date().toISOString(),
      payload: { clientMessageId: 'tree-user', content: [{ type: 'text', text: 'A 记录 125 USD，B 记录 120 USD。分别保留，新增待核实章节、改名、移动并反转两个来源的顺序。只整理当前会话。' }], autoStart: true } } as ClientCommand
    loop.validate(command); loop.execute(command, 1); await Promise.race([finished, modelAssertion])
    const state = loop.exportState(), view = state.snapshot.contextDocumentView!
    assert.deepEqual(view.list, ['# session_context', ['## 待核实', ['### 双方材料', ['#### 客户邮件', 'B：120 USD'], ['#### 订单系统', 'A：125 USD']]]])
    assert.ok(view.nodeIdsByPath!['/1/1/1/1'])
    const samples = loop.getContextTrainingSamples().filter((sample) => sample.proposal?.operations.some((operation) => operation.diffVersion === 2))
    assert.equal(samples.length, 6)
    for (const sample of samples) assert.deepEqual(validateContextTrainingSample(sample), [])
    const applied = samples.filter(sample => sample.decision?.receipts?.some(receipt => receipt.changedNodeIds?.length))
    assert.deepEqual(applied.flatMap((sample) => sample.proposal!.operations.map((operation) => operation.action)), ['add_heading', 'rename_heading', 'move_node', 'reorder_children'])
    assert.equal(samples[3]!.decision!.receipts![0]!.errorCode, 'TREE_NODE_HASH_CONFLICT')
    const repeat = samples.at(-1)!.decision!
    assert.deepEqual(repeat.acceptedOperations, [])
    assert.deepEqual(repeat.rejectedOperations, [])
    assert.equal(repeat.receipts![0]!.unchanged, true)
    loop.close()
    store = new ContextCommitStore(projectDir)
    const committed = store.loadDocument(sessionId)!
    assert.deepEqual(committed.document.tree, view.tree)
    assert.deepEqual(committed.document.information, state.contextDocument!.information)
    const repeatedOutcome = store.readOutcomes(sessionId).at(-1)!
    assert.equal(repeatedOutcome.receipt.unchanged, true)
    assert.equal(repeatedOutcome.receipt.previousRevision, repeatedOutcome.receipt.nextRevision)
    assert.deepEqual(committed.receipts.find(([id]) => id === repeatedOutcome.proposal.idempotencyKey)?.[1], repeatedOutcome.receipt)
    const origin = repeatedOutcome.requestBinding!
    assert.equal(origin.runId, state.snapshot.run.runId)
    assert.equal(store.readRecentModelOutcomes(origin).length, 8)
    for (const key of ['sessionId', 'runId', 'taskId'] as const) {
      assert.deepEqual(store.readRecentModelOutcomes({ ...origin, [key]: 'another-binding' }), [])
    }
    assert.equal(calls, 12)
  } finally { store?.close(); loop.close(); fs.rmSync(projectDir, { recursive: true, force: true }) }
})

test('plan nodes finish with their original committed document edits after rollback, replay and reopening', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-planned-edit-'))
  const sessionId = 'planned-edit-session'
  initializeProjectDirectory(projectDir)
  new ProjectResources(projectDir).saveSettings({ context_organization_version: 4, max_tool_rounds: 16,
    context: { context_window_tokens: 30_000, max_input_tokens: 22_000, reserved_output_tokens: 4096 } })
  const tasks: RuntimePlanTask[] = ['订单材料', '邮件材料'].map((title, index) => ({ id: `edit-${index}`, title,
    dependsOn: index === 0 ? [] : ['edit-0'], completionConditions: [`新增${title}章节`], owner: 'parent', capabilityIds: [],
    requiredActions: [], evidenceRefs: [], status: 'pending', phase: 'execution' }))
  let calls = 0, origin: RuntimeRequestBinding, firstRef = '', secondRef = '', rollbackRequest = '', staleEdit = false
  let wrongReceiptSubmitted = false
  let firstDiff: ControlEnvelopeV2['candidateDiffs'][number]
  let rejectModelAssertion: (error: unknown) => void
  const modelAssertion = new Promise<never>((_, reject) => { rejectModelAssertion = reject })
  const llm: RuntimeLlm = {
    getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }),
    async chat(request) {
      try {
        calls++
        const round = calls - Number(staleEdit) - Number(wrongReceiptSubmitted)
        const system = request.messages[0]!.content
        const binding: RuntimeRequestBinding = JSON.parse(system.split('\n').find(line => line.startsWith('{"sessionId":'))!)
        const state = JSON.parse(system.split('\n').find(line => line.startsWith('{"taskId":'))!)
        const session = system.slice(system.indexOf('# Session Context'))
        const context = JSON.parse(session.match(/<!-- capybara:context-binding data=(\{[^\n]+?\}) -->/)![1]!)
        const { nodes } = readContextTree(session)
        const user = [...session.matchAll(/<!-- capybara:candidate-ref data=(\{[^\n]+?\}) -->/g)]
          .map(match => JSON.parse(match[1]!)).find(candidate => candidate.source.actor === 'user')
        assert.ok(user)
        const schema = JSON.parse(system.split('\n').find(line => line.includes('"candidateDiffs":{"type":"array"'))!)
        const scopedDiffs = schema.properties.candidateDiffs.items.properties
        assert.equal(Object.hasOwn(scopedDiffs, 'planTaskId'), round > 1 && round < 11)
        assert.equal(schema.properties.decision.enum.includes('finish'), round >= 11)
        const output: ControlEnvelopeV2 = { envelopeVersion: 2, binding, decision: 'propose_diff', userMessage: '',
          actions: [], candidateDiffs: [], planProposal: null, evidenceRequests: [], uncertainties: [], waitSpec: null, completionCheck: null }
        const propose = (nodes: RuntimePlanTask[]) => Object.assign(output, { decision: 'propose_plan',
          planProposal: { basePlanRevision: state.planRevision, goal: '整理双方材料章节', tasks: nodes } })
        const firstCompleted = (): RuntimePlanTask => ({ ...tasks[0]!, status: 'completed', requiredActions: [firstRef] })
        const add = (index: number, idempotencyKey: string): typeof firstDiff => ({ ...context, scope: 'session', diffVersion: 2,
          planTaskId: tasks[index]!.id, candidateId: user.id, operation: 'add_heading', idempotencyKey,
          target: { section: 'information', nodeId: nodes[0]!.id }, targetNodeHash: nodes[0]!.hash,
          payload: { title: tasks[index]!.title, evidenceRefs: user.evidence.map((item: { id: string }) => item.id) } })
        const last = state.recentContextEdits?.at(-1)
        if (round === 1) propose(tasks)
        else if (round === 2) {
          rollbackRequest = binding.requestId
          output.candidateDiffs = [add(0, 'rolled-back-a'), { ...add(0, 'rolled-back-b'), targetNodeHash: '0'.repeat(64) }]
        } else if (round === 3) {
          assert.deepEqual(state.completionActionRefs, [])
          assert.ok(state.recentContextEdits.every((item: { result: string }) => item.result === 'rejected'))
          assert.ok(nodes.every(node => node.kind !== 'heading'))
          origin = binding
          firstDiff = add(0, 'original-a')
          output.candidateDiffs = [firstDiff]
          if (!staleEdit) {
            staleEdit = true
            output.binding = { ...binding, requestId: rollbackRequest }
          } else assert.match(request.messages.at(-1)!.content, /previous request ID/)
        } else if (round === 4) {
          assert.equal(last.planTaskId, tasks[0]!.id)
          firstRef = last.completionActionRef
          assert.match(firstRef, /^context:receipt-/)
          assert.deepEqual(request.tools, [])
          assert.ok(request.messages.at(-1)!.content.includes(`Document edit checkpoint. These receipts were just committed: [{"planTaskId":"${tasks[0]!.id}","completionActionRef":"${firstRef}"}]`))
          output.candidateDiffs = [add(1, 'blocked-b')]
        } else if (round === 5) {
          assert.match(request.messages.at(-1)!.content, /RUNTIME_CONTEXT_PLAN_NODE_INACTIVE/)
          assert.deepEqual(state.execution.activeTaskIds, [tasks[0]!.id])
          assert.ok(nodes.every(node => node.title !== tasks[1]!.title))
          propose([firstCompleted(), tasks[1]!])
        } else if (round === 6) {
          assert.deepEqual(state.execution.activeTaskIds, [tasks[1]!.id])
          output.candidateDiffs = [{ ...firstDiff, ...context, planTaskId: tasks[1]!.id }]
        } else if (round === 7) {
          assert.equal(last.replayed, true)
          assert.equal(last.completionActionRef, undefined)
          const node = nodes.find(item => item.title === tasks[0]!.title)!
          const unchanged = add(1, 'unchanged-b')
          output.candidateDiffs = [{ ...unchanged, operation: 'rename_heading',
            target: { section: 'information', nodeId: node.id }, targetNodeHash: node.hash,
            payload: { ...unchanged.payload, title: node.title } }]
        } else if (round === 8) {
          assert.equal(last.unchanged, true)
          assert.equal(last.completionActionRef, undefined)
          assert.deepEqual(state.completionActionRefs, [firstRef])
          Object.assign(output, { decision: 'complete_plan_nodes', planProgress: {
            basePlanRevision: state.planRevision, nodes: [{ id: tasks[1]!.id, actionRefs: [firstRef], evidenceRefs: [] }],
          } })
        } else if (round === 9) {
          assert.equal(state.planRevision, 2)
          assert.equal(state.tasks[1]!.status, 'pending')
          assert.match(request.messages.at(-1)!.content, /RUNTIME_PLAN_ACTION_UNBOUND/)
          assert.ok(request.messages.at(-1)!.content.includes(`Remove "${firstRef}" from the actions of "${tasks[1]!.id}". That receipt belongs to ["${tasks[0]!.id}"].`))
          output.candidateDiffs = [add(1, 'original-b')]
        } else if (round === 10) {
          assert.equal(last.planTaskId, tasks[1]!.id)
          secondRef = last.completionActionRef
          assert.match(secondRef, /^context:receipt-/)
          assert.notEqual(firstRef, secondRef)
          assert.deepEqual(request.tools, [])
          const notice = request.messages.at(-1)!.content
          assert.ok(notice.includes(secondRef))
          if (wrongReceiptSubmitted) {
            assert.match(notice, /RUNTIME_PLAN_ACTION_UNBOUND/)
            assert.ok(notice.includes(`Remove "${firstRef}" from the actions of "${tasks[1]!.id}".`))
            assert.equal(state.tasks[1]!.status, 'pending')
          } else assert.ok(!notice.includes(firstRef))
          Object.assign(output, { decision: 'complete_plan_nodes', planProgress: {
            basePlanRevision: state.planRevision,
            nodes: [{ id: tasks[1]!.id, actionRefs: wrongReceiptSubmitted ? [secondRef] : [firstRef, secondRef], evidenceRefs: [] }],
          } })
          wrongReceiptSubmitted = true
        } else {
          assert.equal(state.planRevision, 3)
          Object.assign(output, { decision: 'finish', userMessage: '已创建两个章节。', completionCheck: {
            taskId: binding.taskId, requiredActions: [firstRef, secondRef], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '两份真实编辑回执' } })
        }
        return { provider: 'custom', model: 'test', finishReason: 'stop', raw: {}, text: JSON.stringify(output) }
      } catch (error) {
        rejectModelAssertion(error)
        throw error
      }
    },
  }
  const loop = new RuntimeLoop({ projectDir, sessionId, llm, contextOrganization: { minGroups: 1000 }, stepDelayMs: 0, streamDelayMs: 0 })
  let store: ContextCommitStore | undefined
  try {
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('planned context edit timed out')) }, 18000)
      const off = loop.onEvent(event => {
        if (event.type !== 'run.state.changed' || !['completed', 'failed'].includes(event.payload.status)) return
        clearTimeout(timer); off()
        if (event.payload.status === 'failed') reject(new Error(event.payload.failure?.message)); else resolve()
      })
    })
    const command: ClientCommand = { version: 1, kind: 'command', type: 'chat.message.send', id: 'plan-edit-command', sessionId, timestamp: new Date().toISOString(),
      payload: { autoStart: true, planningRequired: true, clientMessageId: 'planned-user', content: [{ type: 'text', text: '先规划，然后在当前会话新增订单材料和邮件材料两个章节。' }] } }
    loop.validate(command); loop.execute(command, 1); await Promise.race([done, modelAssertion])
    const final = loop.exportState()
    assert.equal(calls, 13)
    assert.deepEqual(final.snapshot.contextDocumentView?.list, ['# session_context', ['## 订单材料'], ['## 邮件材料']])
    assert.deepEqual(final.taskControl?.requiredActions, [firstRef, secondRef])
    await loop.shutdown()
    store = new ContextCommitStore(projectDir)
    assert.deepEqual([...store.readPlanEditActions(origin!)], [[firstRef, tasks[0]!.id], [secondRef, tasks[1]!.id]])
    for (const key of ['sessionId', 'taskId', 'runId'] as const) assert.equal(store.readPlanEditActions({ ...origin!, [key]: 'another' }).size, 0)
    assert.equal(store.readOutcomes(sessionId).filter(outcome => outcome.planTaskId).length, 2)
  } finally { store?.close(); await loop.shutdown(); fs.rmSync(projectDir, { recursive: true, force: true }) }
})

test('a chapter created in the current run stays addressable on the next bounded model request', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-tree-address-'))
  const sessionId = 'tree-address-session'
  initializeProjectDirectory(projectDir)
  new ProjectResources(projectDir).saveSettings({ context_organization_version: 4,
    context: { context_window_tokens: 18_000, max_input_tokens: 13_000, reserved_output_tokens: 4096 } })
  const store = new ContextCommitStore(projectDir)
  const document = ContextDocumentEngine.create({ sessionId, projectId: projectDir, constitutionRevision: 'test' }).snapshot()
  delete document.tree
  document.information = Array.from({ length: 2048 }, (_, index) => ({ id: `source-${index}`, sectionId: 'information',
    headingPath: ['发货材料'], body: `记录 ${index}。${'发货前请核对原始回执。'.repeat(12)}`, status: 'active', evidenceRefs: [],
    sourceCandidateIds: [], supersedesEntryIds: [], revision: document.revision }))
  store.saveSession(sessionId, new ContextDocumentEngine(document).exportState())
  let calls = 0
  const llm: RuntimeLlm = {
    getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }),
    async chat(request) {
      calls++
      const system = request.messages[0]!.content, session = system.slice(system.indexOf('# Session Context'))
      const binding = JSON.parse(system.split('\n').find(line => line.startsWith('{"sessionId":'))!)
      const state = JSON.parse(system.split('\n').find(line => line.startsWith('{"taskId":'))!)
      const context = JSON.parse(session.match(/<!-- capybara:context-binding data=(\{[^\n]+?\}) -->/)![1]!)
      const { nodes } = readContextTree(session)
      const source = nodes.find(node => node.title === '发货材料')
      const destination = nodes.find(node => node.title === '待核查批次')
      const current = JSON.parse(session.match(/<!-- capybara:candidate-ref data=(\{[^\n]+?\}) -->/)![1]!)
      const evidenceRefs = current.evidence.map((item: { id: string }) => item.id)
      const candidateDiffs: ControlEnvelopeV2['candidateDiffs'] = []
      if (calls === 1) candidateDiffs.push({ ...context, target: { section: 'information', nodeId: 'information' },
        operation: 'add_heading', payload: { title: '待核查批次', evidenceRefs }, targetNodeHash: nodes[0]!.hash,
        diffVersion: 2, candidateId: current.id, idempotencyKey: 'create-empty-heading' })
      if (calls === 2 && source && destination) candidateDiffs.push({ ...context, target: { section: 'information', nodeId: source.id },
        operation: 'move_node', payload: { parentNodeId: destination.id, evidenceRefs }, targetNodeHash: source.hash,
        diffVersion: 2, candidateId: current.id, idempotencyKey: 'move-using-new-heading' })
      if (calls === 3) {
        const edit = state.recentContextEdits.at(-1)
        assert.equal(edit.operation, 'move_node')
        assert.equal(edit.changedEntryIds, undefined)
      }
      const envelope: ControlEnvelopeV2 = { envelopeVersion: 2, binding, decision: candidateDiffs.length ? 'propose_diff' : 'finish',
        userMessage: candidateDiffs.length ? '' : '已整理章节。', actions: [], planProposal: null, candidateDiffs,
        evidenceRequests: [], uncertainties: [], waitSpec: null, completionCheck: candidateDiffs.length ? null : {
          taskId: binding.taskId, requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '结构整理' } }
      return { provider: 'custom', model: 'test', finishReason: 'stop', raw: {}, text: JSON.stringify(envelope) }
    },
  }
  const loop = new RuntimeLoop({ projectDir, sessionId, llm, contextOrganization: { minGroups: 100 }, stepDelayMs: 0, streamDelayMs: 0 })
  try {
    const finished = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('bounded structure run timed out')) }, 20_000)
      const off = loop.onEvent(event => {
        if (event.type !== 'run.state.changed' || !['completed', 'failed'].includes(event.payload.status)) return
        clearTimeout(timer); off()
        if (event.payload.status === 'failed') reject(new Error(event.payload.failure?.message)); else resolve()
      })
    })
    const request: ClientCommand = { version: 1, kind: 'command', id: 'tree-address', type: 'chat.message.send', sessionId,
      timestamp: new Date().toISOString(), payload: { clientMessageId: 'tree-user-address',
        content: [{ type: 'text', text: '新建一个复核栏目，将发货材料移到其下。' }], autoStart: true } }
    loop.validate(request); loop.execute(request, 1); await finished
    const outcomes = store.readOutcomes(sessionId)
    assert.deepEqual(outcomes.map(item => [item.proposal.operation, item.receipt.result]), [['add_heading', 'applied'], ['move_node', 'applied']])
    assert.equal(outcomes[1]!.receipt.changedEntryIds.length, 2048)
    const next = store.readPublications(sessionId).filter(item => item.channel === 'model' && item.scope === 'session')[1]!.projection
    const empty = next.treeNodes!.find(node => node.title === '待核查批次')!
    assert.deepEqual(empty.childIds, [])
    assert.ok(next.selectionReasons[empty.id]!.includes('pinned-heading'))
    assert.ok(next.sourceEntryIds.length < document.information.length)
    assert.deepEqual(store.loadDocument(sessionId)!.document.tree!.headings.find(node => node.id === empty.id)!.children, [outcomes[1]!.proposal.target.nodeId])
    assert.equal(calls, 3)
  } finally { await loop.shutdown(); store.close(); fs.rmSync(projectDir, { recursive: true, force: true }) }
})
