const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { setTimeout: sleep } = require('node:timers/promises')
const { DatabaseSync } = require('node:sqlite')
const { pathToFileURL } = require('node:url')
const { createBackendRuntimeManager } = require('../electron/backend-runtime-host.cjs')
const cases = require('../../backend/test/fixtures/context-organizer-quality-cases.json')

const backend = relative => import(pathToFileURL(path.resolve(__dirname, '../../backend/dist', relative)).href)
const classifierUrl = process.env.CAPYBARA_REFUND_CLASSIFIER
const reportPath = process.env.CAPYBARA_REFUND_REPORT
const callTrace = process.env.CAPYBARA_REFUND_CAPTURE === '1'

const policy = '本项目长期退款规则：保留金额分歧的双方原句。汇报需要先取得用户的只读授权。实际退款需另获授权。'
const consent = '批准只读汇报。请一并从本会话的归档中召回巡检登记 N-41，按原句补入会话文档中名为「审计索引」的章节。实际退款仍待授权。'
const task = [
  '请排查订单 1024 的退款，分开记录账本和客户邮件的金额主张。',
  '请先拆分可以并行开展的证据查找和人工汇报授权。把授权放在就绪任务的首位，先提出只读汇报的授权问题，再继续独立的证据查找。',
  '本次已允许读取 ledger.txt、mail.txt、maintenance.txt 及查找本地只读资源。由父代理在同一轮读取这三份附件。',
  '第三份附件只需查是否涉及订单 1024 的退款。与退款无关的维护细节留存原件，当前工作记录仅列退款相关信息。',
  '另委派一名本地只读子代理，局部任务仅为在能力目录里找到 read_file 的注册 ID 和名称，并提供 search_resources 的实际搜索回执。请在委派指令中明确限定为能力目录查询。三份附件、订单与业务原文均由父代理调查。子任务计划声明委派和资源搜索两种能力，实际仅授予资源搜索。委派用 timeout_ms=180000，模型预算保留默认的 8 次请求与 128000 Token。请核对并验收子结果。',
  '两项工作完成后，交付报告，列出两份金额、来源文件、已授权范围与退款状态。等我回复授权前不要完成汇报。',
].join('\n')

function requestState(request) {
  const system = request.messages[0]?.content ?? ''
  const line = system.split('\n').find(value => value.startsWith('{"taskId":'))
  return line ? JSON.parse(line) : undefined
}

async function main() {
  if (!classifierUrl || !reportPath) throw new Error('Set CAPYBARA_REFUND_CLASSIFIER and CAPYBARA_REFUND_REPORT')
  const endpoint = new URL(classifierUrl)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'Use an isolated local file classifier')
  const [{ initializeProjectDirectory }, { ProjectResources }, { createLlmService }, { v2PromptManifest }, { ContextCommitStore }, { SessionStore }] = await Promise.all([
    backend('core/project-initializer.js'), backend('core/project-resources.js'), backend('util/llm.js'), backend('core/v2-prompts.js'),
    backend('core/context-commit-store.js'), backend('core/session-store.js'),
  ])
  const scenario = cases.test.find(item => item.id === 'refund-evidence-authorization')
  assert.ok(scenario)
  // Allow one more bounded transport attempt when the proxy drops a connection before a response.
  const model = createLlmService({ timeoutMs: 55_000, maxRetries: 2 })
  const config = model.getConfig()
  const report = { case: scenario.id, mainModel: config.model, protocol: config.protocol,
    prompts: v2PromptManifest(['constitution', 'runtime', 'child-agent', 'context-organizer']), calls: [], checkpoints: {} }
  const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-live-refund-'))
  const events = [], priorEvents = [], webContents = {}
  let host, connection, firstSessionId, refreshFirstSession, sequence = 0
  try {
    initializeProjectDirectory(projectPath)
    for (const material of scenario.materials) fs.writeFileSync(path.join(projectPath, material.file), material.text)
    const settings = new ProjectResources(projectPath)
    try {
      const llm = settings.readSettings().llm
      settings.saveSettings({ context_organization_version: 4, context_file_disposition_profile: 'live-files', max_tool_rounds: 24,
        context: { context_window_tokens: 64_000, max_input_tokens: 50_000, reserved_output_tokens: 4096,
          max_model_tokens: 900_000, max_model_attempts: 50 },
        tool_permissions: ['filesystem:read'], llm: { ...llm, profiles: [...llm.profiles, { id: 'live-files', provider: 'custom',
          protocol: 'chat-completions', model: 'qwen-span-classifier', base_url: classifierUrl, max_retries: 0,
          file_disposition_batch: { max_spans: 128, max_characters: 16000 } }] } })
    } finally { settings.close() }

    const actor = { getConfig: () => model.getConfig(), get admitsTransportAttempts() { return model.admitsTransportAttempts === true },
      async chat(request) {
        const state = requestState(request)
        const call = { role: request.messages[0]?.content.includes('Capybara A2A Child Agent Prompt') ? 'child' : state ? 'parent' : 'auxiliary',
          phase: state?.execution?.phase, activeTaskIds: state?.execution?.activeTaskIds, allowedDecisions: state?.execution?.allowedDecisions,
          branchHumanReplies: state?.branchHumanReplies,
          tools: request.tools?.map(tool => tool.name) ?? [], responseFormat: request.responseFormat,
          ...(callTrace ? { messages: request.messages } : {}) }
        report.calls.push(call)
        try {
          const response = await model.chat(request)
          Object.assign(call, { model: response.model, response: response.text, toolCalls: response.toolCalls ?? [], usage: response.usage })
          try { call.decision = JSON.parse(response.text)?.decision } catch { /* The raw response is available for protocol diagnostics. */ }
          return response
        } finally { save() }
      },
    }
    const connect = async sessionId => {
      host ??= createBackendRuntimeManager({ runtimeOptions: { llm: actor, planningRequired: true, childAgentEnabled: true,
        stepDelayMs: 0, streamDelayMs: 0, contextAssistant: { modes: [] }, contextOrganization: { minGroups: 1 } },
      emit: ({ event }) => events.push(event) })
      await host.ready
      connection = await host.connect({ workspaceId: 'project:live-refund', workspaceName: '退款审核验收', projectPath, sessionId, webContents })
    }
    const send = (type, payload) => host.send({ runtimeId: connection.runtimeId, webContents, frame: { version: 1, kind: 'command',
      id: `live-refund-${++sequence}`, type, sessionId: connection.sessionId, timestamp: new Date().toISOString(), payload } })
    const chat = (clientMessageId, text, autoStart, humanRequestId) => send('chat.message.send', { clientMessageId,
      content: [{ type: 'text', text }], autoStart, ...(humanRequestId ? { humanRequestId } : {}) })
    const waitFor = async (type, predicate = () => true, after = -1) => {
      const deadline = Date.now() + 300_000
      while (Date.now() < deadline) {
        const found = events.find((event, index) => index > after && event.type === type && predicate(event.payload))
        if (found) return found.payload
        const failed = events.find(event => event.type === 'run.state.changed' && ['failed', 'cancelled'].includes(event.payload.status))
        if (failed) throw new Error(`V2 run stopped: ${JSON.stringify(failed.payload.failure)}`)
        await sleep(100)
      }
      throw new Error(`V2 wait expired: ${type}`)
    }
    const snapshot = () => events.findLast(event => event.type === 'runtime.snapshot').payload
    const variable = name => snapshot().contextOrganization.variables.find(item => item.name === name).value

    await connect()
    const firstSession = connection.sessionId
    firstSessionId = firstSession
    refreshFirstSession = () => connect(firstSession)
    await chat('refund-policy', policy, false)
    const declaration = await waitFor('chat.user.created')
    const classification = { durability: 'project', target: 'project', confidence: 'high', reason: '用户明确声明跨会话退款规则',
      projectAnchors: ['project:explicit:refund-policy'] }
    await send('runtime.context.v2.observe', { observation: { scope: 'session', documentId: variable('session_context').meta.id,
      candidate: { source: { actor: 'user', sourceId: 'refund-policy-candidate', capturedAt: new Date().toISOString() }, rawArtifactId: declaration.id,
        normalizedContent: policy, classification }, evidence: { kind: 'message', referenceId: declaration.id } } })
    const observed = await waitFor('runtime.context.v2.observed', value => value.candidate.classification?.target === 'project')
    await send('runtime.context.v2.project', { profileId: 'refund-policy', scope: 'project', maxCharacters: 16_000 })
    const { projection } = await waitFor('runtime.context.v2.projection.created', value => value.projection.scope === 'project')
    await send('runtime.context.v2.apply', { proposal: { id: 'refund-project-policy', scope: 'project', sourceScope: 'session',
      documentId: variable('project_context').meta.id, baseRevision: projection.documentRevision, projectionId: projection.id, projectionHash: projection.contentHash,
      operation: 'add_entry', target: { section: 'information', headingPath: ['退款规则'] }, payload: { body: policy, evidenceRefs: [observed.evidence.id] },
      candidateId: observed.candidate.id, actor: 'model', classification, idempotencyKey: 'refund-project-policy', createdAt: new Date().toISOString() } })
    const { receipt } = await waitFor('runtime.context.v2.receipt.created')
    assert.equal(receipt.result, 'applied', receipt.errorCode)
    report.checkpoints.projectPolicy = receipt
    await chat('refund-task', task, true)
    // The host can pause on the async child before it has a result to review.
    const acceptedChildReview = await waitFor('tool.call.completed', value => value.toolName === 'consume_child_result'
      && value.result?.reviewReceipt?.decision === 'accept')
    const acceptedChildReviewIndex = events.findIndex(event => event.payload === acceptedChildReview)
    const paused = await waitFor('run.state.changed', value => value.status === 'paused', acceptedChildReviewIndex)
    // The desktop receives incremental activity events between snapshots. Reattach for a fresh checkpoint.
    await connect(firstSession)
    const pausedState = snapshot()
    const pending = pausedState.taskControl.branchBlocks.find(block => block.kind === 'human')
    const child = pausedState.children.items.find(item => item.consumption?.decision === 'accept')
    const asked = events.findIndex(event => event.type === 'runtime.waits.updated'
      && event.payload.subscriptions.some(wait => wait.id === pending?.id && wait.status === 'pending'))
    const reviewed = acceptedChildReview.result?.childId === child?.id ? acceptedChildReviewIndex : -1
    const originalNote = scenario.materials[2].text
    const contextStore = new ContextCommitStore(projectPath)
    let archivedBeforeConsent
    try {
      archivedBeforeConsent = contextStore.searchArchivedSources(firstSession, ['N-41'], 20)
        .filter(source => source.text === originalNote)
        .map(({ archiveId, referenceId, sourceHash, start, end }) => ({ archiveId, referenceId, sourceHash, start, end }))
    } finally { contextStore.close() }
    const activeBeforeConsent = variable('session_context').information.filter(entry => entry.status === 'active' && entry.body === originalNote).map(entry => entry.id)
    report.checkpoints.paused = { run: paused, pending, children: pausedState.children.items, plan: pausedState.taskControl, asked, reviewed,
      archivedBeforeConsent, activeBeforeConsent }
    save()
    assert.ok(pending && pending.taskIds.length > 0, 'The authorization question must block its plan branch')
    assert.ok(child && reviewed > asked && asked >= 0, 'The parent must accept the real child result while authorization is pending')
    assert.ok(report.calls.some(call => call.role === 'parent' && call.phase === 'planning' && !call.tools.length
      && call.decision === 'propose_plan'), 'A real planning call must produce the plan')
    assert.ok(report.calls.some(call => call.role === 'child' && call.tools.length === 1 && call.tools[0] === 'search_resources'
      && call.toolCalls.some(tool => tool.name === 'search_resources')), 'The real child must query its granted read-only tool')

    await host.closeAll()
    if (callTrace) {
      const sessions = new SessionStore(projectPath, { readOnly: true })
      try {
        const state = sessions.get(firstSession)?.state
        report.checkpoints.paused.fileAssessments = (state?.contextTrainingSamples ?? []).flatMap(sample => {
          const trace = sample.organization
          return (trace?.attempts ?? []).flatMap(attempt => {
            const packet = JSON.parse(attempt.messages.at(-1).content)
            if (packet.organizationVersion !== 4) return []
            let decision
            try { decision = JSON.parse(attempt.rawOutput) } catch { /* Preserve the recorded attempt without choices. */ }
            return [{ batch: packet.batch, review: packet.task?.archiveReview ?? false,
              sources: packet.sources.map(({ ref, file, line, text }) => ({ ref, file, line, text })),
              ...(decision?.batch === packet.batch && Array.isArray(decision.choices) ? { choices: decision.choices } : {}),
              committed: trace.committed, ...(trace.errorCode ? { errorCode: trace.errorCode } : {}) }]
          })
        })
      } catch (error) {
        report.checkpoints.paused.fileAssessmentTraceError = error instanceof Error ? error.message : String(error)
      } finally { sessions.close() }
    }
    priorEvents.push(...events.splice(0))
    host = undefined
    await connect(firstSession)
    assert.equal(snapshot().run.runId, paused.runId)
    assert.equal(snapshot().taskControl.branchBlocks[0].id, pending.id)
    assert.equal(snapshot().children.items.find(item => item.id === child.id)?.consumption.decision, 'accept')
    await chat('refund-consent', consent, true, pending.id)
    const terminal = await waitFor('run.state.changed', value => value.status === 'completed')
    assert.equal(terminal.runId, paused.runId)
    assert.ok(report.calls.some(call => call.branchHumanReplies?.some(reply => reply.requestId === pending.id
      && reply.replyMessageId === 'refund-consent' && reply.completionActionRef === `human:${pending.id}`)), 'The resumed model must see the bound human reply receipt')
    const assistant = await waitFor('chat.assistant.completed')
    const final = events.filter(event => event.type === 'chat.assistant.delta' && event.payload.channel === 'final'
      && event.payload.messageId === assistant.messageId).map(event => event.payload.delta).join('')
    await connect(firstSession)
    report.checkpoints.final = { terminal, text: final, plan: snapshot().taskControl }
    for (const pattern of [/125\s*美元/, /120\s*美元/, /ledger\.txt/, /mail\.txt/, /只读/, /N-41/, /(待|未)[^。\n]{0,12}授权|授权[^。\n]{0,12}(待|未)/]) assert.match(final, pattern)
    const archived = scenario.materials[2].text
    const recall = await waitFor('runtime.context.v2.memory.recalled', value => value.hits.some(hit => hit.sourceKind === 'source_archive' && hit.body === archived))
    const hit = recall.hits.find(item => item.sourceKind === 'source_archive' && item.body === archived)
    assert.ok(archivedBeforeConsent.some(source => source.archiveId === hit.sourceId && hit.rawArtifactIds.includes(source.referenceId)),
      'The recalled original must be the same durable archive recorded before authorization')
    assert.ok(recall.candidates.some(candidate => candidate.id === hit.candidateId && candidate.status === 'pending'))
    report.checkpoints.recall = { id: hit.candidateId, source: hit.sourceKind }
    const session = variable('session_context'), shared = variable('project_context')
    assert.ok(shared.list.flat(Infinity).includes(policy))
    const firstSessionEvents = events.splice(0)
    priorEvents.push(...firstSessionEvents)
    await connect()
    const nextProject = variable('project_context'), nextSession = variable('session_context')
    await send('runtime.context.v2.memory.recall', { query: 'N-41', scope: 'both', limit: 5 })
    const nextRecall = await waitFor('runtime.context.v2.memory.recalled')
    report.checkpoints.secondSession = { id: connection.sessionId, projectDocumentId: nextProject.meta.id,
      sessionDocumentId: nextSession.meta.id, projectPolicyPresent: nextProject.list.flat(Infinity).includes(policy),
      privateEntryCount: nextSession.information.length, privateRecallHits: nextRecall.hits.length }
    assert.notEqual(connection.sessionId, firstSession)
    assert.equal(nextProject.meta.id, shared.meta.id)
    assert.notEqual(nextSession.meta.id, session.meta.id)
    assert.ok(report.checkpoints.secondSession.projectPolicyPresent)
    assert.deepEqual(nextSession.information, [])
    assert.deepEqual(nextRecall.hits, [])
    const sources = scenario.materials.map(({ text }) => {
      const entries = session.information.filter(item => item.body === text && item.status === 'active')
      assert.equal(entries.length, 1, text)
      if (text === archived) assert.deepEqual(entries[0].headingPath, ['审计索引'])
      const original = session.evidence.find(item => entries[0].evidenceRefs.includes(item.id) && item.kind === 'artifact')
      assert.ok(original, text)
      return original.referenceId
    })
    assert.equal(new Set(sources).size, 3)
    const archivedEntry = session.information.find(item => item.status === 'active' && item.body === archived)
    const submittedEdit = firstSessionEvents.find(event => event.type === 'runtime.context.v2.receipt.created'
      && event.payload.receipt.result === 'applied' && event.payload.receipt.changedEntryIds.includes(archivedEntry.id))
    assert.ok(submittedEdit, 'The recalled source must have an actual edit receipt')
    const verifiedAction = `context:${submittedEdit.payload.receipt.id}`
    assert.ok(report.checkpoints.final.plan.tasks.some(node => node.status === 'completed' && node.requiredActions.includes(verifiedAction)),
      'A completed plan node must reference the original document edit receipt')
    report.checkpoints.edit = { entryId: archivedEntry.id, headingPath: archivedEntry.headingPath, completionActionRef: verifiedAction }
    assert.ok(!firstSessionEvents.some(event => event.type === 'tool.call.completed' && event.payload.toolName === 'delegate_task'))
    report.passed = true
  } catch (error) {
    report.error = error instanceof Error ? error.stack : String(error)
    if (host && refreshFirstSession && events.some(event => event.type === 'run.state.changed'
      && ['completed', 'failed', 'cancelled'].includes(event.payload.status))) {
      try { await refreshFirstSession() } catch { /* Retain the original failure and available checkpoint. */ }
    }
    throw error
  } finally {
    const last = events.findLast(event => event.type === 'runtime.snapshot')?.payload
    const latestRun = events.findLast(event => event.type === 'run.state.changed')?.payload
    if (last) report.checkpoints.last = { run: latestRun ?? last.run, task: last.taskControl, children: last.children.items }
    const trace = [...priorEvents, ...events]
    report.events = trace.filter(event => ['run.state.changed', 'tool.call.completed', 'tool.call.failed',
      'runtime.context.v2.memory.recalled', 'runtime.context.v2.receipt.created'].includes(event.type))
    report.organization = trace.flatMap(event => {
      if (event.type !== 'runtime.artifact.created') return []
      const { id, label, preview, runId, stepId } = event.payload.artifact
      if (!['Context organization kept original history', 'Context committed; follow-up recording failed',
        'Context documents and coverage committed', 'Context documents committed; history retained'].includes(label)) return []
      return [{ id, label, preview, runId, stepId }]
    })
    await host?.closeAll()
    const budgetPath = path.join(projectPath, '.capybara', 'sessions.sqlite')
    if (fs.existsSync(budgetPath)) {
      if (report.error && firstSessionId) {
        const sessions = new SessionStore(projectPath, { readOnly: true })
        try {
          const state = sessions.get(firstSessionId)?.state
          if (state?.snapshot) report.checkpoints.persistedFailure = { run: state.snapshot.run,
            task: state.taskControl, children: state.snapshot.children.items }
        } finally { sessions.close() }
      }
      const db = new DatabaseSync(budgetPath, { readOnly: true })
      try {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_model_budget_attempts'").get()) {
          report.budget = db.prepare(`SELECT role, model, status, COUNT(*) AS attempts, SUM(reported_total) AS reported_total,
            SUM(charged_tokens) AS charged_tokens FROM runtime_model_budget_attempts GROUP BY role, model, status`).all()
        }
      } finally { db.close() }
    }
    if (report.passed && !report.budget?.some(row => row.role === 'organize' && row.model === 'qwen-span-classifier' && row.status === 'returned')) {
      report.passed = false
      report.error = 'File organization completed without a measured local classifier request'
    }
    save()
    await fs.promises.rm(projectPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    if (report.passed === false) throw new Error(report.error)
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
