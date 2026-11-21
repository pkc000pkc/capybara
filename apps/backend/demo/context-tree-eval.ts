import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { ContextCommitStore, type ContextOutcomeAttempt } from '#core/context-commit-store'
import { ContextDocumentEngine, type ContextDocument } from '#core/context-document-engine'
import { validateContextTrainingSample } from '#core/context-training-recorder'
import { initializeProjectDirectory } from '#core/project-initializer'
import { ProjectResources } from '#core/project-resources'
import { RuntimeLoop, type RuntimeLlm } from '#core/runtime-loop'
import { V2_CONSTITUTION_REVISION, v2PromptManifest } from '#core/v2-prompts'
import type { ClientCommand, RuntimeContextDocumentView, RuntimeContextTreeBinding } from '#protocol/runtime-protocol'
import { createLlmService } from '#util/llm'

const { readContextTree } = createRequire(import.meta.url)('../test/fixtures/context-model-view.cjs') as {
  readContextTree: (markdown: string) => { version: number; nodes: RuntimeContextTreeBinding[] }
}

const sessionId = 'context-tree-eval'
const chapter = '发货材料'
const date = '2026-11-19T00:00:00Z'
const context = { context_window_tokens: 18000, max_input_tokens: 13000, reserved_output_tokens: 4096 }
const steps = [
  { operation: 'reorder_children', prompt: '实际整理当前会话文档。“发货材料”下把“财务邮件”和“仓库登记”的两个章节交换顺序，让财务邮件先展示。其他同级记录仍保留原位置。' },
  { operation: 'rename_heading', prompt: '继续整理当前会话文档，把“仓库登记”章节改名为“仓库台账”。保留章节和记录身份。' },
  { operation: 'add_heading', prompt: '继续整理当前会话文档，新增一个顶层章节“待核查批次”。暂时不放正文。' },
  { operation: 'move_node', prompt: '继续整理当前会话文档，将整个“发货材料”章节移到“待核查批次”下面，保留所有子章节和记录。' },
] as const

function initialDocument(id: string, projectId: string, count: number): ContextDocument {
  const project = id === 'project-context'
  const engine = ContextDocumentEngine.create({ sessionId: id, projectId, constitutionRevision: V2_CONSTITUTION_REVISION, now: date })
  const headingPaths = project ? [['项目总则']] : [[chapter, '仓库登记'], [chapter], [chapter, '财务邮件']]
  const bodies = project ? ['项目验收保留双方证据和原始回执。'] : [
    '仓库来源 W-61 提议先发货，金额 451.75 SGD，仅限双人复核后。',
    '已归档历史来源 H-91，本次无须恢复。',
    '财务来源 F-42 提议暂缓发货，金额 429.30 SGD，账簿尚未对平。',
  ]
  const evidence = bodies.map((_, index) => engine.addEvidence({ id: `${id}-evidence-${index}`, kind: 'external', referenceId: `${id}-source-${index}`, observedAt: date }))
  const candidates = bodies.map((normalizedContent, index) => engine.addCandidate({ id: `${id}-candidate-${index}`,
    source: { actor: 'system', sourceId: evidence[index]!.referenceId, capturedAt: date },
    rawArtifactId: evidence[index]!.referenceId, normalizedContent, evidenceRefs: [evidence[index]!.id] }))
  const document = engine.snapshot()
  for (const candidate of document.candidates) candidate.status = 'accepted'
  delete document.tree
  document.information = Array.from({ length: count }, (_, index) => {
    const base = Math.min(index, bodies.length - 1)
    return { id: `${id}-row-${index}`, sectionId: 'information', headingPath: headingPaths[index] ?? [chapter],
      body: bodies[index] ?? `历史批次记录 ${index}。待人工判定是否有重复凭据，无需影响本批次处理。`,
      status: !project && index === 1 ? 'archived' : 'active', evidenceRefs: [evidence[base]!.id],
      sourceCandidateIds: [candidates[base]!.id], supersedesEntryIds: [], revision: document.revision }
  })
  return new ContextDocumentEngine(document).snapshot()
}

function runTurn(loop: RuntimeLoop, prompt: string, index: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('TREE_EVAL_TURN_TIMEOUT')) }, 210_000)
    const off = loop.onEvent(event => {
      if (event.type !== 'run.state.changed' || !['completed', 'failed', 'cancelled', 'paused'].includes(event.payload.status)) return
      clearTimeout(timer)
      off()
      if (event.payload.status === 'completed') resolve()
      else reject(new Error(`${event.payload.status}: ${event.payload.failure?.code ?? ''} ${event.payload.failure?.message ?? ''}`))
    })
    const id = `tree-eval-${index}`
    const command: ClientCommand = { version: 1, kind: 'command', id, sessionId, timestamp: new Date().toISOString(), type: 'chat.message.send',
      payload: { clientMessageId: id, content: [{ type: 'text', text: prompt }], autoStart: true } }
    try { loop.validate(command); loop.execute(command, index) }
    catch (error) { clearTimeout(timer); off(); reject(error) }
  })
}

const rowData = ({ body, id, status, evidenceRefs, sourceCandidateIds, supersedesEntryIds }: ContextDocument['information'][number]) =>
  ({ body, id, status, evidenceRefs, sourceCandidateIds, supersedesEntryIds })

async function main() {
  const pathToReport = process.argv[2]
  const moveOnly = process.argv[3] === 'move-only'
  const limit = moveOnly ? 1 : Number(process.argv[3] ?? steps.length)
  assert.ok(Number.isInteger(limit) && limit > 0 && limit <= steps.length)
  const selectedSteps = moveOnly ? [steps[3]] : steps.slice(0, limit)
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-context-tree-eval-'))
  const count = 2048
  const before = initialDocument(sessionId, fixtureDir, count), project = initialDocument('project-context', fixtureDir, 1)
  if (moveOnly) {
    before.tree!.headings.push({ id: 'pending-batch', title: '待核查批次', children: [] })
    before.tree!.rootChildren.push('pending-batch')
  }
  const model = createLlmService({ maxRetries: 2, timeoutMs: 60_000 })
  const calls: Array<Record<string, unknown>> = [], assertions: string[] = [], outcomes: Array<Record<string, unknown>> = []
  const report = { schemaVersion: 1, model: model.getConfig().model, context, entryCount: count, scenario: moveOnly ? 'move-only' : 'layout-sequence', calls, assertions, outcomes,
    promptBindings: v2PromptManifest(['constitution', 'runtime']), error: undefined as string | undefined }
  const writeReport = () => { if (pathToReport) fs.writeFileSync(pathToReport, JSON.stringify(report, null, 2)) }
  let loop: RuntimeLoop | undefined, store: ContextCommitStore | undefined
  const heading = before.tree!.headings.find(item => item.title === chapter)!
  const warehouse = heading.children[0]!, finance = heading.children[2]!
  const expectedChildren = moveOnly ? heading.children : [finance, heading.children[1], warehouse, ...heading.children.slice(3)]
  try {
    initializeProjectDirectory(fixtureDir)
    new ProjectResources(fixtureDir).saveSettings({ context, tool_permissions: ['filesystem:read'], context_organization_version: 4 })
    store = new ContextCommitStore(fixtureDir)
    store.seedProject(new ContextDocumentEngine(project).exportState())
    store.saveSession(sessionId, new ContextDocumentEngine(before).exportState())
    const llm: RuntimeLlm = {
      getConfig: () => model.getConfig(),
      get admitsTransportAttempts() { return model.admitsTransportAttempts === true },
      async chat(request) {
        if (calls.length >= 14) throw new Error('TREE_EVAL_MODEL_LIMIT')
        const system = request.messages[0]?.content ?? ''
        const session = system.slice(system.indexOf('# Session Context'))
        const tree = session.includes('<!-- capybara:tree data=') ? readContextTree(session) : undefined
        const nodes = tree?.nodes ?? []
        const parent = nodes.find(node => node.id === heading.id)
        const runtimeState = system.split('\n').find(line => line.startsWith('{"taskId":'))
        const call: Record<string, unknown> = { index: calls.length + 1, treeVersion: tree?.version, visibleNodes: nodes.length,
          visibleChildren: parent?.childIds?.length, totalChildren: parent?.totalChildren,
          sessionCandidates: [...session.matchAll(/<!-- capybara:candidate-ref data=(\{[^\n]+?\}) -->/g)].map(match => {
            const candidate = JSON.parse(match[1]!)
            return { id: candidate.id, actor: candidate.source.actor }
          }),
          archivedSlotVisible: nodes.some(node => node.id === heading.children[1]),
          targetHeadings: nodes.filter(node => node.kind === 'heading').map(node => ({ id: node.id, title: node.title })),
          projectRuleVisible: system.includes(project.information[0]!.body), promptBytes: Buffer.byteLength(system),
          sessionBinding: JSON.parse(session.match(/<!-- capybara:context-binding data=(\{[^\n]+?\}) -->/)?.[1] ?? 'null'),
          recentContextEdits: runtimeState ? JSON.parse(runtimeState).recentContextEdits : undefined,
        }
        calls.push(call)
        writeReport()
        const reply = await model.chat(request)
        Object.assign(call, { text: reply.text, usage: reply.usage, toolCalls: reply.toolCalls?.map(item => item.name) ?? [] })
        writeReport()
        return reply
      },
    }
    loop = new RuntimeLoop({ projectDir: fixtureDir, sessionId, llm, stepDelayMs: 0, streamDelayMs: 0,
      contextAssistant: { modes: [] }, contextOrganization: { minGroups: 1_000 } })
    loop.onEvent(event => {
      if (event.type !== 'runtime.context.v2.receipt.created') return
      const { result, errorCode, previousRevision, nextRevision, proposalId, changedNodeIds, unchanged } = event.payload.receipt
      outcomes.push({ result, errorCode, previousRevision, nextRevision, proposalId, changedNodes: changedNodeIds?.length, unchanged })
      writeReport()
    })
    for (const [index, step] of selectedSteps.entries()) {
      const startCall = calls.length
      await runTurn(loop, `${step.prompt} 请通过会话文档的控制协议提交 decision=propose_diff 和一个 ${step.operation}。引用当前投影的节点及本指令的候选证据。已有 applied 回执且新投影满足目标时，直接 finish。`, index + 1)
      const attempts: ContextOutcomeAttempt[] = store.readOutcomes(sessionId)
      const outcome = attempts.filter(item => item.receipt.result === 'applied' && !item.receipt.unchanged && !item.replayed)
      for (const { receipt } of attempts.filter(item => item.receipt.unchanged)) {
        assert.equal(receipt.nextRevision, receipt.previousRevision)
        assert.deepEqual(receipt.changedNodeIds, [])
      }
      assert.deepEqual(outcome.map(item => item.proposal.operation), selectedSteps.slice(0, index + 1).map(item => item.operation))
      assert.equal(outcome.at(-1)!.scope, 'session')
      assert.equal(outcome.at(-1)!.proposal.diffVersion, 2)
      assert.ok(outcome.at(-1)!.receipt.changedNodeIds?.length)
      assert.equal(calls[startCall]?.recentContextEdits, undefined)
      const receiptId = outcome.at(-1)!.receipt.id
      assert.ok(calls.slice(startCall + 1).some(call => Array.isArray(call.recentContextEdits)
        && call.recentContextEdits.some(edit => edit.receiptId === receiptId && edit.result === 'applied')))
      assert.ok(calls.slice(startCall).some(call => Number(call.visibleChildren) >= 2 && Number(call.visibleChildren) < Number(call.totalChildren)))
      assert.ok(calls.slice(startCall).every(call => call.treeVersion === 2))
      assert.ok(calls.slice(startCall).every(call => !call.archivedSlotVisible && call.projectRuleVisible))
      const after: ContextDocument = store.loadDocument(sessionId)!.document
      const edited = after.tree!.headings.find(item => item.id === heading.id)!
      assert.deepEqual(edited.children, expectedChildren)
      assert.deepEqual(after.information.map(rowData), before.information.map(rowData))
      assert.deepEqual(store.loadDocument()!.document.information, project.information)
      assert.equal(store.loadDocument()!.document.revision, project.revision)
      if (!moveOnly && index >= 1) assert.equal(after.tree!.headings.find(item => item.id === warehouse)?.title, '仓库台账')
      if (step.operation === 'add_heading' || step.operation === 'move_node') {
        const destination = after.tree!.headings.find(item => item.title === '待核查批次')!
        assert.ok(after.tree!.rootChildren.includes(destination.id))
        assert.deepEqual(destination.children, step.operation === 'add_heading' ? [] : [heading.id])
        const requiredCall = calls[step.operation === 'add_heading' ? startCall + 1 : startCall]
        assert.ok(Array.isArray(requiredCall?.targetHeadings) && requiredCall.targetHeadings.some(node => node.id === destination.id),
          'the empty destination must be present in the first relevant model projection')
      }
      const ui: RuntimeContextDocumentView = loop.getSnapshot(0).contextDocumentView!
      assert.deepEqual(ui.tree, after.tree)
      assert.equal(ui.meta.revision, after.revision)
      assertions.push(step.operation)
      writeReport()
    }
    const samples = loop.getContextTrainingSamples().filter(sample => sample.proposal?.operations.some(item => item.diffVersion === 2))
    for (const sample of samples) assert.deepEqual(validateContextTrainingSample(sample), [])
    assert.equal(samples.filter(sample => sample.decision?.receipts?.some(receipt => receipt.changedNodeIds?.length)).length, limit)
    assertions.push('training-samples')
    const treeBeforeClose = store.loadDocument(sessionId)!.document.tree
    await loop.shutdown()
    store.close()
    store = new ContextCommitStore(fixtureDir)
    assert.deepEqual(store.loadDocument(sessionId)!.document.tree, treeBeforeClose)
    assertions.push('sqlite-reopen')
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
    process.exitCode = 1
  } finally {
    await loop?.shutdown()
    store?.close()
    await fs.promises.rm(fixtureDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 80 })
    writeReport()
    console.log(JSON.stringify(report))
  }
}

await main()
