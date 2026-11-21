const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { pathToFileURL } = require('node:url')

const { createBackendRuntimeManager } = require('../electron/backend-runtime-host.cjs')
const { readContextTree, readContextEntries } = require('../../backend/test/fixtures/context-model-view.cjs')

test('desktop IPC recovers published projections before a diff and preserves scoped negative outcomes', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-publication-ipc-'))
  await initializeProject(projectPath)
  const events = []
  let modelCalls = 0, sequence = 0
  const options = { runtimeOptions: { llm: { ...fakeLlm(), async chat() { modelCalls++; throw new Error('no model call expected') } }, stepDelayMs: 0, streamDelayMs: 0 }, emit: ({ event }) => events.push(event) }
  let host = createBackendRuntimeManager(options), connection
  const webContents = {}
  const connect = async () => {
    await host.ready
    connection = await host.connect({ workspaceId: 'project:publication-ipc', workspaceName: 'Publication IPC', projectPath, ...(connection ? { sessionId: connection.sessionId } : {}), webContents })
  }
  const send = async (type, payload) => host.send({ runtimeId: connection.runtimeId, webContents, frame: {
    version: 1, kind: 'command', id: `publication-ipc-${++sequence}`, type, sessionId: connection.sessionId, timestamp: new Date().toISOString(), payload,
  } })
  const latest = (type) => { const event = [...events].reverse().find(event => event.type === type); assert.ok(event, `missing ${type}`); return event.payload }
  try {
    await connect()
    const variables = latest('runtime.snapshot').contextOrganization.variables
    const proposals = []
    for (const scope of ['project', 'session']) {
      const documentId = variables.find(v => v.name === (scope === 'project' ? 'project_context' : 'session_context')).value.meta.id
      await send('runtime.context.v2.observe', { observation: { scope, documentId,
        candidate: { source: { actor: 'user', sourceId: `ipc-${scope}`, capturedAt: new Date().toISOString() }, rawArtifactId: `ipc-${scope}`, normalizedContent: `${scope} 的独立测试材料`,
          ...(scope === 'project' ? { classification: { durability: 'project', target: 'project', confidence: 'high', reason: '用户指定的项目长期规则', projectAnchors: ['project:explicit:ipc-policy'] } } : {}) },
        evidence: { kind: 'message', referenceId: `ipc-${scope}` } } })
      const observed = latest('runtime.context.v2.observed')
      await send('runtime.context.v2.project', { scope, profileId: `ipc-${scope}`, maxCharacters: 16000 })
      const { projection } = latest('runtime.context.v2.projection.created')
      proposals.push({ id: `ipc-proposal-${scope}`, scope, documentId, baseRevision: projection.documentRevision, projectionId: projection.id, projectionHash: projection.contentHash,
        target: { section: 'information' }, operation: 'add_entry', payload: { body: `${scope} 的整理内容`, evidenceRefs: [observed.evidence.id] },
        candidateId: observed.candidate.id, idempotencyKey: `ipc-${scope}`, actor: 'model', createdAt: new Date().toISOString() })
    }
    await host.closeAll(); events.length = 0
    host = createBackendRuntimeManager(options); await connect()
    assert.equal(latest('runtime.snapshot').contextOrganization.variables.find(v => v.name === 'session_context').value.information.length, 0)
    for (const proposal of proposals) {
      await send('runtime.context.v2.apply', { proposal })
      assert.equal(latest('runtime.context.v2.receipt.created').receipt.result, 'applied')
    }
    const negative = { ...proposals[0], id: 'ipc-negative', idempotencyKey: 'ipc-negative', classification: { durability: 'session', target: 'session', confidence: 'high', reason: '只属于会话', projectAnchors: [] } }
    await send('runtime.context.v2.apply', { proposal: negative })
    const rejected = latest('runtime.context.v2.receipt.created').receipt
    assert.equal(rejected.errorCode, 'PROJECT_CLASSIFICATION_MISMATCH')
    await host.closeAll(); events.length = 0
    host = createBackendRuntimeManager(options); await connect()
    const snapshot = latest('runtime.snapshot')
    assert.ok(snapshot.contextReceipts.some(r => r.id === rejected.id && r.scope === 'project'))
    for (const scope of ['project', 'session']) {
      const variable = snapshot.contextOrganization.variables.find(v => v.name === (scope === 'project' ? 'project_context' : 'session_context'))
      assert.ok(JSON.stringify(variable.value.list).includes(`${scope} 的整理内容`))
    }
    await send('runtime.context.v2.apply', { proposal: { ...negative, id: 'ipc-negative-retry' } })
    assert.deepEqual(latest('runtime.context.v2.receipt.created').receipt, rejected)
    assert.equal(modelCalls, 0)
  } finally { await host.closeAll(); fs.rmSync(projectPath, { recursive: true, force: true }) }
})

test('desktop IPC rejects an ungranted Skill script and restores imported child claims without fake completion', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-authority-ipc-'))
  await initializeProject(projectPath)
  const skillDir = path.join(projectPath, 'skills/authority-ipc')
  fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(skillDir, 'references'))
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: authority-ipc\ndescription: IPC authority fixture\nallowed-tools: run_skill_script\nmetadata:\n  capybara-required-tools: "project-files:read_file"\n---\nRead the source.\n')
  fs.writeFileSync(path.join(skillDir, 'scripts/write.mjs'), "import fs from 'node:fs'; fs.writeFileSync('ungranted.txt','must not run');")
  fs.writeFileSync(path.join(skillDir, 'references/source.md'), '真实参考原件')
  const configFile = path.join(projectPath, '.capybara/config.json')
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  config.skills = ['skills/authority-ipc']; config.tool_permissions = ['filesystem:read']
  fs.writeFileSync(configFile, JSON.stringify(config))
  const events = []
  let calls = 0, sequence = 0, connection
  const options = { runtimeOptions: { llm: { ...fakeLlm(), async chat() { calls++; throw new Error('no inference expected') } }, stepDelayMs: 0, streamDelayMs: 0 }, emit: ({ event }) => events.push(event) }
  const webContents = {}
  let host = createBackendRuntimeManager(options)
  const connect = async () => {
    await host.ready
    connection = await host.connect({ workspaceId: 'project:authority-ipc', workspaceName: 'Authority IPC', projectPath, ...(connection ? { sessionId: connection.sessionId } : {}), webContents })
  }
  const send = async (type, payload) => host.send({ runtimeId: connection.runtimeId, webContents, frame: {
    version: 1, kind: 'command', id: `authority-ipc-${++sequence}`, type, sessionId: connection.sessionId, timestamp: new Date().toISOString(), payload,
  } })
  const latest = type => { const event = [...events].reverse().find(event => event.type === type); assert.ok(event, `missing ${type}`); return event.payload }
  try {
    await connect()
    await send('runtime.skills.attach', { skillId: 'authority-ipc', baseRevision: latest('runtime.snapshot').skills.revision })
    assert.equal(latest('runtime.tools.updated').items.find(tool => tool.id === 'project-files:read_file')?.attachedBySkill, true)
    await send('runtime.skills.script.run', { skillId: 'authority-ipc', path: 'scripts/write.mjs', argv: [], baseRevision: latest('runtime.skills.updated').revision })
    assert.equal(latest('command.rejected').code, 'FORBIDDEN')
    assert.equal(fs.existsSync(path.join(projectPath, 'ungranted.txt')), false)
    await send('runtime.skills.reference.load', { skillId: 'authority-ipc', path: 'references/source.md', baseRevision: latest('runtime.skills.updated').revision })
    const activeSkill = latest('runtime.skills.updated').items.find(skill => skill.id === 'authority-ipc')
    const source = activeSkill.resources.find(resource => resource.path === 'references/source.md')
    assert.equal(source?.content, '真实参考原件')
    assert.ok(activeSkill.sourceVersion)
    const documentId = latest('runtime.snapshot').contextOrganization.variables.find(variable => variable.name === 'session_context').value.meta.id
    await send('runtime.context.v2.child.merge', { documentId, sourceId: 'claimed-child', runId: 'claimed-run', rawArtifactId: 'claimed-source', normalizedContent: '导入内容声称成功', evidenceRefs: [] })
    const candidate = latest('runtime.context.v2.child.merged').candidate
    assert.equal(candidate.status, 'pending')
    assert.ok(!events.some(event => event.type === 'runtime.children.updated'))
    await host.closeAll(); events.length = 0
    host = createBackendRuntimeManager(options); await connect()
    const snapshot = latest('runtime.snapshot')
    assert.deepEqual(snapshot.children.items, [])
    const restoredSkill = snapshot.skills.items.find(skill => skill.id === 'authority-ipc')
    assert.equal(restoredSkill.sourceVersion, activeSkill.sourceVersion)
    const restoredSource = restoredSkill.resources.find(resource => resource.path === source.path)
    assert.equal(restoredSource?.status, 'loaded')
    assert.equal(restoredSource?.hash, source.hash)
    assert.equal(restoredSource?.content, source.content)
    const context = snapshot.contextOrganization.variables.find(variable => variable.name === 'session_context').value
    assert.ok(context.candidates.some(item => item.id === candidate.id && item.status === 'pending'))
    assert.equal(context.information.length, 0); assert.equal(calls, 0)
    await host.closeAll(); events.length = 0
    fs.writeFileSync(path.join(skillDir, source.path), '新版参考正文')
    host = createBackendRuntimeManager(options); await connect()
    const changed = latest('runtime.snapshot').skills.items.find(skill => skill.id === 'authority-ipc')
    assert.equal(changed.sourceVersion, activeSkill.sourceVersion)
    assert.equal(changed.resources.find(resource => resource.path === source.path)?.status, 'unloaded')
    await send('runtime.skills.detach', { skillId: 'authority-ipc', baseRevision: latest('runtime.snapshot').skills.revision })
    assert.ok(!latest('runtime.tools.updated').items.some(tool => tool.id === 'project-files:read_file'))
  } finally { await host.closeAll(); fs.rmSync(projectPath, { recursive: true, force: true }) }
})

async function initializeProject(projectPath) {
  const module = await import(pathToFileURL(path.resolve(__dirname, '../../../apps/backend/dist/core/project-initializer.js')).href)
  module.initializeProjectDirectory(projectPath)
}

test('desktop IPC closes a refund review with project memory, local delegation, human input and archived evidence', { timeout: 75_000 }, async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-refund-context-ipc-'))
  await initializeProject(projectPath)
  const { ProjectResources } = await import(pathToFileURL(path.resolve(__dirname, '../../backend/dist/core/project-resources.js')).href)
  const settings = new ProjectResources(projectPath)
  try {
    const llm = settings.readSettings().llm
    settings.saveSettings({ context_organization_version: 4, context_file_disposition_profile: 'refund-test-files', max_tool_rounds: 24,
      context: { context_window_tokens: 48_000, max_input_tokens: 32_000, reserved_output_tokens: 4096 },
      tool_permissions: ['filesystem:read'], llm: { ...llm, profiles: [...llm.profiles, { id: 'refund-test-files',
        provider: 'custom', protocol: 'chat-completions', model: 'organizer-fixture', base_url: 'http://127.0.0.1:1/v1', max_retries: 0 }] } })
  }
  finally { settings.close() }
  const policy = '本项目长期退款规则：金额证据冲突时保留双方原句，未确认授权前只读汇报。'
  const qualityCases = require('../../backend/test/fixtures/context-organizer-quality-cases.json')
  const scenario = qualityCases.test.find(item => item.id === 'refund-evidence-authorization')
  assert.ok(scenario)
  const [ledger, mail, archived] = scenario.materials.map(item => item.text)
  const consent = '批准只读汇报。请一并补回巡检登记 N-41 作为审计索引，实际退款仍待授权。'
  const summary = '账本记录 125 美元，邮件主张 120 美元。已获准只读汇报，退款待授权。'
  const files = Object.fromEntries(scenario.materials.map(item => [item.file, item.text]))
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(projectPath, file), content)

  const tasks = [
    { id: 'sources', title: '核对账本和邮件', phase: 'investigation', capabilityIds: ['delegate_task', 'search_resources', 'load_resources', 'project-files:read_file'], completionConditions: ['核对文件和子目录回执'] },
    { id: 'authorization', title: '核对人工授权并找回归档索引', phase: 'investigation', capabilityIds: ['recall_context'], completionConditions: ['收到授权回复并找回原件'] },
    { id: 'archive', title: '补回审计索引', phase: 'execution', dependsOn: ['sources', 'authorization'], capabilityIds: [], completionConditions: ['已提交索引整理回执'] },
  ].map(task => ({ dependsOn: [], ...task, owner: 'parent', requiredActions: [], evidenceRefs: [], status: 'pending' }))
  const sourcesComplete = { ...tasks[0], status: 'completed', requiredActions: ['call:refund-consume'] }
  const authorizationComplete = { ...tasks[1], status: 'completed', requiredActions: ['call:refund-recall'] }
  const events = [], webContents = {}
  let call = 0, childCalls = 0, seq = 0, connection, childId, archiveHit
  const tool = (...toolCalls) => ({ provider: 'custom', model: 'test-model', text: '', raw: {}, finishReason: 'tool_calls', toolCalls })
  const action = (id, name, args) => ({ id, name, arguments: args })
  const result = (request, name) => {
    const message = request.messages.findLast(message => message.role === 'tool' && message.name === name)
    assert.ok(message, name)
    const value = JSON.parse(message.content)
    assert.equal(value.ok, true, message.content)
    return value.result
  }
  const llm = { ...fakeLlm(), async chat(request) {
    const system = request.messages[0].content
    const binding = JSON.parse(system.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)[0])
    const envelope = { envelopeVersion: 2, binding, decision: 'continue', userMessage: '', actions: [], planProposal: null,
      candidateDiffs: [], evidenceRequests: [], uncertainties: [], waitSpec: null, completionCheck: null }
    const plan = (basePlanRevision, tasks) => Object.assign(envelope, { decision: 'propose_plan', planProposal: { basePlanRevision, goal: '只读核对退款证据', tasks } })
    const complete = (basePlanRevision, id, actionRefs) => Object.assign(envelope,
      { decision: 'complete_plan_nodes', planProgress: { basePlanRevision, nodes: [{ id, actionRefs, evidenceRefs: [] }] } })
    const finish = (userMessage, requiredActions = []) => Object.assign(envelope, { decision: 'finish', userMessage,
      completionCheck: { taskId: binding.taskId, requiredActions, requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '原件和真实回执已核对' } })
    if (system.includes('Capybara A2A Child Agent Prompt')) {
      assert.deepEqual(request.tools.map(item => item.name), ['search_resources'])
      if (++childCalls === 1) return tool(action('refund-child-search', 'search_resources', { query: 'files' }))
      assert.equal(childCalls, 2)
      result(request, 'search_resources')
      finish('子任务已核对文件资源目录。', ['call:refund-child-search'])
    } else {
      switch (++call) {
        case 1: assert.ok(system.includes(policy)); plan(0, tasks); break
        case 2:
          Object.assign(envelope, { decision: 'ask_user', userMessage: '请确认是否只读汇报，以及是否需要补回审计索引。',
            actions: [{ kind: 'ask_user', question: '请确认是否只读汇报，以及是否需要补回审计索引。', blockingTaskIds: ['authorization'] }] })
          break
        case 3: return tool(action('refund-load-files', 'load_resources', { ids: ['project-files:read_file'] }))
        case 4: return tool(...Object.keys(files).map(file => action(`refund-read-${file}`, 'read_file', { file_name: file })))
        case 5:
          assert.ok(system.includes(ledger) && system.includes(mail))
          return tool(action('refund-dispatch', 'delegate_task', { plan_task_id: 'sources', goal: '核对只读文件资源目录',
            prompt: '通过 search_resources 查找 files。', mode: 'sync', capability_ids: ['search_resources'] }))
        case 6:
          childId = result(request, 'delegate_task').childId
          return tool(action('refund-read-child', 'read_child_result', { child_id: childId }))
        case 7: {
          const read = result(request, 'read_child_result')
          assert.match(read.output_excerpt, /已核对文件资源目录/)
          return tool(action('refund-consume', 'consume_child_result', { child_id: childId, result_hash: read.result_hash,
            read_receipt_id: read.read_receipt_id, decision: 'accept', reason: '父层核验只读目录结果' }))
        }
        case 8: complete(1, sourcesComplete.id, sourcesComplete.requiredActions); break
        case 9: {
          assert.ok(request.messages.some(message => message.content.includes(consent)))
          const state = JSON.parse(system.split('\n').find(line => line.startsWith('{"taskId":')))
          const reply = state.branchHumanReplies.find(item => item.taskIds.includes('authorization'))
          assert.equal(reply.replyMessageId, 'refund-authorized')
          assert.equal(reply.completionActionRef, `human:${reply.requestId}`)
          authorizationComplete.requiredActions.push(reply.completionActionRef)
          return tool(action('refund-recall', 'recall_context', { query: 'N-41', scope: 'session', limit: 5 }))
        }
        case 10:
          archiveHit = result(request, 'recall_context').hits.find(hit => hit.sourceKind === 'source_archive' && hit.body === archived)
          assert.ok(archiveHit)
          complete(2, authorizationComplete.id, authorizationComplete.requiredActions)
          break
        case 11:
        case 12:
        case 13: {
          const scope = JSON.parse(system.match(/<!-- capybara:context-binding data=(\{"scope":"session",[^\n]+?\}) -->/)[1])
          if (call === 12) assert.match(request.messages.at(-1).content, /RUNTIME_CONTEXT_DIFF_TREE_BINDING_SCHEMA.*add_entry/)
          if (call === 13) assert.match(request.messages.at(-1).content, /RUNTIME_CONTEXT_DIFF_CLASSIFICATION_SCHEMA.*projectAnchors/)
          Object.assign(envelope, { decision: 'propose_diff', candidateDiffs: [{ ...scope, planTaskId: 'archive', candidateId: archiveHit.candidateId,
            target: { section: 'information', headingPath: ['召回审计索引'], ...(call === 11 ? { nodeId: 'information' } : {}) },
            idempotencyKey: 'refund-recall-insert', operation: 'add_entry',
            payload: { body: archiveHit.body, evidenceRefs: archiveHit.evidenceRefs },
            ...(call === 12 ? { classification: { durability: 'session', target: 'session', confidence: 'high', reason: '本次审计的召回内容' } } : {}) }] })
          break
        }
        case 14: {
          const edit = JSON.parse(system.split('\n').find(line => line.startsWith('{"taskId":'))).recentContextEdits.at(-1)
          assert.equal(edit.result, 'applied')
          assert.ok(edit.completionActionRef)
          complete(3, tasks[2].id, [edit.completionActionRef])
          break
        }
        case 15: finish(summary); break
        default: assert.fail(`unexpected parent call ${call}`)
      }
    }
    return { provider: 'custom', model: 'test-model', text: JSON.stringify(envelope), raw: {}, finishReason: 'stop' }
  } }
  const organizer = { ...fakeLlm(), async chat(request) {
    const packet = JSON.parse(request.messages.at(-1).content)
    const relevant = new Set([ledger, mail])
    if (packet.task.latestUser === consent) relevant.add(archived)
    const value = packet.organizationVersion === 4 ? { batch: packet.batch,
      choices: packet.sources.map(item => relevant.has(item.text) ? 'K' : 'A'), heading: scenario.heading }
      : { batch: packet.batch, observations: [], edits: [], archives: [], fold: false, uncertainties: [] }
    return { provider: 'custom', model: 'organizer-fixture', text: JSON.stringify(value), raw: {}, finishReason: 'stop' }
  } }
  const options = { runtimeOptions: { llm, planningRequired: true, childAgentEnabled: true, stepDelayMs: 0, streamDelayMs: 0,
    contextOrganization: { llm: organizer, minGroups: 1 } }, emit: ({ event }) => events.push(event) }
  let host = createBackendRuntimeManager(options)
  const connect = async sessionId => {
    await host.ready
    connection = await host.connect({ workspaceId: 'project:refund-context', workspaceName: '退款排查', projectPath, sessionId, webContents })
  }
  const send = (type, payload) => host.send({ runtimeId: connection.runtimeId, webContents, frame: { version: 1, kind: 'command',
    id: `refund-context-${++seq}`, type, sessionId: connection.sessionId, timestamp: new Date().toISOString(), payload } })
  const chat = (id, text, autoStart, humanRequestId) => send('chat.message.send', { clientMessageId: id, content: [{ type: 'text', text }], autoStart, ...(humanRequestId ? { humanRequestId } : {}) })
  const snapshot = () => events.findLast(event => event.type === 'runtime.snapshot').payload
  const variable = name => snapshot().contextOrganization.variables.find(item => item.name === name).value
  try {
    await connect()
    const firstSession = connection.sessionId
    await chat('refund-project-policy', policy, false)
    const declaration = (await waitFor(events, 'chat.user.created')).payload
    const classification = { durability: 'project', target: 'project', confidence: 'high', reason: '用户明确声明跨会话退款规则', projectAnchors: ['project:explicit:refund-policy'] }
    await send('runtime.context.v2.observe', { observation: { scope: 'session', documentId: variable('session_context').meta.id,
      candidate: { source: { actor: 'user', sourceId: 'refund-policy-candidate', capturedAt: new Date().toISOString() }, rawArtifactId: declaration.id,
        normalizedContent: policy, classification }, evidence: { kind: 'message', referenceId: declaration.id } } })
    const observed = (await waitFor(events, 'runtime.context.v2.observed', event => event.payload.candidate.classification?.target === 'project')).payload
    await send('runtime.context.v2.project', { profileId: 'refund-policy', scope: 'project', maxCharacters: 16000 })
    const projection = events.findLast(event => event.type === 'runtime.context.v2.projection.created').payload.projection
    await send('runtime.context.v2.apply', { proposal: { id: 'refund-project-policy-diff', scope: 'project', sourceScope: 'session',
      documentId: variable('project_context').meta.id, baseRevision: projection.documentRevision, projectionId: projection.id, projectionHash: projection.contentHash,
      operation: 'add_entry', target: { section: 'information', headingPath: ['退款规则'] }, payload: { body: policy, evidenceRefs: [observed.evidence.id] },
      candidateId: observed.candidate.id, actor: 'model', classification, idempotencyKey: 'refund-project-policy-diff', createdAt: new Date().toISOString() } })
    const promotion = events.findLast(event => event.type === 'runtime.context.v2.receipt.created').payload.receipt
    assert.equal(promotion.result, 'applied', promotion.errorCode)
    await chat('refund-request', scenario.query, true)
    const paused = (await waitFor(events, 'run.state.changed', event => event.payload.status === 'paused')).payload
    const blocked = snapshot().taskControl.branchBlocks[0]
    assert.deepEqual(blocked.taskIds, ['authorization'])
    assert.equal(blocked.kind, 'human')
    assert.equal(call, 8)
    assert.equal(childCalls, 2)
    assert.ok(events.some(event => event.type === 'tool.call.completed' && event.payload.toolName === 'consume_child_result'))
    assert.ok(!events.some(event => event.type === 'run.state.changed' && event.payload.status === 'completed'))
    await host.closeAll(); events.length = 0
    host = createBackendRuntimeManager(options); await connect(firstSession)
    assert.equal(snapshot().run.runId, paused.runId)
    assert.equal(snapshot().taskControl.branchBlocks[0].id, blocked.id)
    assert.equal(snapshot().children.items[0].id, childId)
    assert.equal(snapshot().children.items[0].consumption.decision, 'accept')
    await chat('refund-authorized', consent, true, blocked.id)
    const terminal = (await waitFor(events, 'run.state.changed', event => event.payload.status === 'completed')).payload
    assert.equal(terminal.runId, paused.runId)
    const assistant = (await waitFor(events, 'chat.assistant.completed')).payload
    const finalText = events.filter(event => event.type === 'chat.assistant.delta' &&
      event.payload.messageId === assistant.messageId && event.payload.channel === 'final').map(event => event.payload.delta).join('')
    assert.match(finalText, /125 美元/)
    assert.match(finalText, /120 美元/)
    assert.match(finalText, /只读/)
    assert.match(finalText, /退款[^。\n]*(待|未)[^。\n]*授权/)
    const recalled = await waitFor(events, 'runtime.context.v2.memory.recalled', event => event.payload.hits.some(hit => hit.candidateId === archiveHit?.candidateId))
    assert.ok(recalled.payload.candidates.some(candidate => candidate.id === archiveHit.candidateId && candidate.status === 'pending'))
    const update = events.findLast(event => event.type === 'runtime.context.documents.updated' && event.payload.contextDocumentView.list.flat(Infinity).includes(archived))
    assert.ok(update)
    const { contextDocumentView: sessionView, projectContextDocumentView: projectView } = update.payload
    assert.deepEqual(sessionView.list.flat(Infinity).filter(text => Object.values(files).includes(text)).sort(), Object.values(files).sort())
    const fileEvidence = [ledger, mail].map(body => {
      const entry = sessionView.information.find(item => item.body === body && item.status === 'active')
      assert.ok(entry, body)
      const evidence = sessionView.evidence.find(item => entry.evidenceRefs.includes(item.id) && item.kind === 'artifact')
      assert.ok(evidence, body)
      return evidence
    })
    assert.notEqual(fileEvidence[0].referenceId, fileEvidence[1].referenceId)
    assert.ok(projectView.list.flat(Infinity).includes(policy))
    assert.ok(!events.some(event => event.type === 'tool.call.completed' && ['read_file', 'delegate_task'].includes(event.payload.toolName)))
    const projectDocumentId = projectView.meta.id
    const sessionDocumentId = sessionView.meta.id
    assert.equal(call, 15)
    assert.equal(childCalls, 2)
    events.length = 0; await connect()
    assert.notEqual(connection.sessionId, firstSession)
    assert.equal(variable('project_context').meta.id, projectDocumentId)
    assert.notEqual(variable('session_context').meta.id, sessionDocumentId)
    assert.ok(variable('project_context').list.flat(Infinity).includes(policy))
    assert.deepEqual(variable('session_context').information, [])
    assert.deepEqual(snapshot().children.items, [])
    await send('runtime.context.v2.memory.recall', { query: 'N-41', scope: 'both', limit: 5 })
    assert.deepEqual((await waitFor(events, 'runtime.context.v2.memory.recalled')).payload.hits, [])
  } finally {
    await host.closeAll()
    fs.rmSync(projectPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('desktop IPC restores a real pending wait, rejects bypass and consumes only the matching remaining signal', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-wait-ipc-'))
  await initializeProject(projectPath)
  let calls = 0, sequence = 0, connection, originalBinding
  const events = [], webContents = {}
  const llm = { ...fakeLlm(), async chat(request) {
    calls++
    const binding = JSON.parse(request.messages[0].content.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)[0])
    const envelope = { envelopeVersion: 2, binding, decision: 'wait', userMessage: '', actions: [], planProposal: null, candidateDiffs: [], evidenceRequests: [], uncertainties: [],
      waitSpec: { reason: '等待两个独立来源', signalType: 'external', correlationIds: ['A', 'B'], condition: { eventType: 'ready', status: 'ready' }, deadlineRef: null }, completionCheck: null }
    if (calls === 1) originalBinding = binding
    else {
      assert.equal(calls, 2); assert.equal(binding.taskId, originalBinding.taskId); assert.equal(binding.runId, originalBinding.runId)
      assert.ok(request.messages[0].content.includes('satisfied'))
      Object.assign(envelope, { decision: 'finish', userMessage: '两个来源已就绪并完成核对。', waitSpec: null, completionCheck: { taskId: binding.taskId, requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '真实等待已结算' } })
    }
    return { provider: 'custom', model: 'test-model', text: JSON.stringify(envelope), raw: {} }
  } }
  const options = { runtimeOptions: { llm, stepDelayMs: 0, streamDelayMs: 0 }, emit: ({ event }) => events.push(event) }
  let host = createBackendRuntimeManager(options)
  const connect = async () => { await host.ready; connection = await host.connect({ workspaceId: 'project:wait-ipc', workspaceName: 'Wait IPC', projectPath, ...(connection ? { sessionId: connection.sessionId } : {}), webContents }) }
  const send = (type, payload) => host.send({ runtimeId: connection.runtimeId, webContents, frame: { version: 1, kind: 'command', id: `wait-ipc-${++sequence}`, type, sessionId: connection.sessionId, timestamp: new Date().toISOString(), payload } })
  const signal = (id, correlationId) => ({ id, taskId: originalBinding.taskId, runId: originalBinding.runId, signalType: 'external', eventType: 'ready', status: 'ready', correlationId })
  try {
    await connect()
    await send('chat.message.send', { clientMessageId: 'wait-ipc-message', content: [{ type: 'text', text: '等两个来源就绪后再检查。' }], autoStart: true })
    await waitFor(events, 'run.state.changed', event => event.payload.status === 'paused')
    const refused = await send('run.resume', {}); assert.equal(refused.accepted, false)
    const forged = await send('runtime.wait.signal', { ...signal('forged', 'A'), signalType: 'tool' }); assert.equal(forged.accepted, false)
    await send('runtime.wait.signal', signal('first-A', 'A'))
    await host.closeAll(); events.length = 0
    host = createBackendRuntimeManager(options); await connect()
    const snapshot = events.find(event => event.type === 'runtime.snapshot').payload
    assert.equal(snapshot.contextControl.status, 'waiting')
    assert.equal(snapshot.waits.subscriptions[0].status, 'pending')
    assert.deepEqual(snapshot.waits.subscriptions[0].matchedSignalIds, ['first-A']); assert.equal(calls, 1)
    await send('runtime.wait.signal', signal('second-B', 'B'))
    await waitFor(events, 'run.state.changed', event => event.payload.status === 'completed')
    await send('runtime.wait.signal', signal('second-B', 'B'))
    assert.ok(events.some(event => event.type === 'runtime.wait.signal.recorded' && event.payload.duplicate === true))
    await host.closeAll(); events.length = 0
    host = createBackendRuntimeManager(options); await connect()
    const completed = events.find(event => event.type === 'runtime.snapshot').payload
    assert.equal(completed.run.status, 'completed'); assert.equal(completed.waits.subscriptions[0].status, 'satisfied'); assert.equal(calls, 2)
  } finally { await host.closeAll(); fs.rmSync(projectPath, { recursive: true, force: true }) }
})

test('desktop IPC restores an independent planning round and completes the original staged task', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-planning-ipc-'))
  await initializeProject(projectPath)
  let calls = 0
  const task = { id: 'search', title: '检索资源', phase: 'investigation', dependsOn: [], owner: 'parent', capabilityIds: ['search_resources'], completionConditions: ['查询成功'], requiredActions: ['call:ipc-phase-search'], evidenceRefs: [], status: 'pending' }
  const llm = { ...fakeLlm(), async chat(request) {
    calls++
    const system = request.messages[0].content
    const binding = JSON.parse(system.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)[0])
    const execution = JSON.parse(system.match(/"execution":(\{[^{}]+\})/)[1])
    const envelope = { envelopeVersion: 2, binding, decision: 'continue', userMessage: '', actions: [], planProposal: null, candidateDiffs: [], evidenceRequests: [], uncertainties: [], waitSpec: null, completionCheck: null }
    if (calls <= 2) { assert.equal(execution.phase, 'planning'); assert.deepEqual(request.tools, []) }
    if (calls === 1) Object.assign(envelope, { decision: 'ask_user', userMessage: '本次查询什么资源？', actions: [{ kind: 'ask_user', question: '本次查询什么资源？', blockingTaskIds: [binding.taskId] }] })
    else if (calls === 2 || calls === 4) Object.assign(envelope, { decision: 'propose_plan', planProposal: { basePlanRevision: calls === 2 ? 0 : 1, goal: '完成指定资源查询', tasks: [{ ...task, requiredActions: calls === 2 ? [] : task.requiredActions, status: calls === 2 ? 'pending' : 'completed' }] } })
    else if (calls === 3) {
      assert.equal(execution.phase, 'investigation')
      assert.ok(request.tools.some(tool => tool.name === 'search_resources'))
      assert.ok(!request.tools.some(tool => tool.name === 'run_skill_script'))
      return { provider: 'custom', model: 'test-model', text: '', raw: {}, finishReason: 'tool_calls', toolCalls: [{ id: 'ipc-phase-search', name: 'search_resources', arguments: { query: 'files', kinds: ['tool'], limit: 1 } }] }
    } else {
      assert.equal(calls, 5)
      Object.assign(envelope, { decision: 'finish', userMessage: '资源查询已验证。', completionCheck: { taskId: binding.taskId, requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '已验证查询收据与计划节点' } })
    }
    return { provider: 'custom', model: 'test-model', text: JSON.stringify(envelope), raw: {}, finishReason: 'stop' }
  } }
  const events = [], webContents = {}
  const options = { runtimeOptions: { llm, planningRequired: true, contextOrganization: { minGroups: 100 }, stepDelayMs: 0, streamDelayMs: 0 }, emit: ({ event }) => events.push(event) }
  let host = createBackendRuntimeManager(options)
  async function waitState(status) {
    for (let attempt = 0; attempt < 1500; attempt++) {
      const event = events.find(e => e.type === 'run.state.changed' && e.payload.status === status)
      if (event) return event.payload
      const failure = events.find(e => e.type === 'run.state.changed' && e.payload.status === 'failed')
      if (failure) throw new Error(JSON.stringify(failure.payload.failure))
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`planning IPC did not reach ${status}`)
  }
  try {
    await host.ready
    const connection = await host.connect({ workspaceId: 'project:planning-ipc', workspaceName: 'Planning IPC', projectPath, webContents })
    const frame = (id, text, humanRequestId) => ({ version: 1, kind: 'command', id, type: 'chat.message.send', sessionId: connection.sessionId, timestamp: new Date().toISOString(), payload: { clientMessageId: id, content: [{ type: 'text', text }], autoStart: true, ...(humanRequestId ? { humanRequestId } : {}) } })
    await host.send({ runtimeId: connection.runtimeId, webContents, frame: frame('planning-initial', '请先规划资源查询') })
    const paused = await waitState('paused')
    const control = events.find(e => e.type === 'runtime.context.v2.control.pending').payload.control
    await host.closeAll(); events.length = 0
    host = createBackendRuntimeManager(options); await host.ready
    const reconnected = await host.connect({ workspaceId: 'project:planning-ipc', workspaceName: 'Planning IPC', projectPath, sessionId: connection.sessionId, webContents })
    const snapshot = events.find(e => e.type === 'runtime.snapshot').payload
    assert.equal(snapshot.taskControl.planning.required, true)
    assert.equal(snapshot.taskControl.taskId, control.taskId)
    const runtime = snapshot.contextOrganization.variables.find(v => v.name === 'runtime_state').value
    assert.equal(runtime.execution.phase, 'planning')
    await host.send({ runtimeId: reconnected.runtimeId, webContents, frame: frame('planning-answer', 'files', control.humanRequestId) })
    const completed = await waitState('completed')
    assert.equal(completed.runId, paused.runId); assert.equal(calls, 5)
    assert.ok(events.some(e => e.type === 'tool.call.completed' && e.payload.receipt.capabilityBinding.phase === 'investigation'))
  } finally { await host.closeAll(); fs.rmSync(projectPath, { recursive: true, force: true }) }
})

test('desktop IPC restores a planned addition and routes duplicate edits to the original node receipt', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-plan-edit-ipc-'))
  await initializeProject(projectPath)
  const { ProjectResources } = await import(pathToFileURL(path.resolve(__dirname, '../../../apps/backend/dist/core/project-resources.js')).href)
  new ProjectResources(projectPath).saveSettings({ context_organization_version: 4 })
  const events = [], webContents = {}
  const body = '巡检登记 N-41：仅用于排班。'
  const node = { id: 'record-audit-entry', title: '提交审计条目', phase: 'execution', owner: 'parent',
    capabilityIds: [], dependsOn: [], completionConditions: ['会话文档中新增审计章节与条目'], requiredActions: [], evidenceRefs: [], status: 'pending' }
  let calls = 0, actionRef = '', initialAddition
  const llm = { ...fakeLlm(), async chat(request) {
    calls++
    const system = request.messages[0].content
    const binding = JSON.parse(system.split('\n').find(line => line.startsWith('{"sessionId":')))
    const state = JSON.parse(system.split('\n').find(line => line.startsWith('{"taskId":')))
    const envelope = { envelopeVersion: 2, binding, decision: 'propose_plan', userMessage: '', actions: [], planProposal: null,
      candidateDiffs: [], evidenceRequests: [], uncertainties: [], waitSpec: null, completionCheck: null }
    if (calls === 1) {
      envelope.planProposal = { basePlanRevision: state.planRevision, goal: '提交审计条目', tasks: [node] }
    } else if (calls === 2) {
      const session = system.slice(system.indexOf('# Session Context'))
      const document = JSON.parse(session.match(/<!-- capybara:context-binding data=(\{[^\n]+?\}) -->/)[1])
      const user = [...session.matchAll(/<!-- capybara:candidate-ref data=(\{[^\n]+?\}) -->/g)]
        .map(match => JSON.parse(match[1])).find(candidate => candidate.source.actor === 'user')
      initialAddition = { ...document, planTaskId: node.id, target: { section: 'information', headingPath: ['审计章节'] },
        operation: 'add_entry', candidateId: user.id, payload: { body, evidenceRefs: user.evidence.map(item => item.id),
          classification: { durability: 'session', target: 'session', confidence: 'high', reason: '本会话的原始记录', projectAnchors: [] } }, idempotencyKey: 'planned-ipc-edit' }
      Object.assign(envelope, { decision: 'propose_diff', candidateDiffs: [initialAddition] })
    } else if (calls === 3) {
      actionRef = state.recentContextEdits.at(-1).completionActionRef
      assert.match(actionRef, /^context:receipt-/)
      Object.assign(envelope, { decision: 'ask_user', userMessage: '审计章节已创建，请确认验收。',
        actions: [{ kind: 'ask_user', question: '审计章节已创建，请确认验收。', blockingTaskIds: [binding.taskId] }] })
    } else if (calls >= 4 && calls <= 6) {
      assert.ok(request.messages.some(message => message.role === 'user' && message.content === '确认验收'))
      assert.ok(state.recentContextEdits.some(edit => edit.planTaskId === node.id && edit.completionActionRef === actionRef))
      assert.equal(state.tasks[0].status, 'pending')
      if (calls > 4) {
        assert.deepEqual(request.tools, [])
        assert.equal(request.responseFormat, 'json')
        assert.ok(request.messages.at(-1).content.includes('RUNTIME_CONTEXT_EDIT_ALREADY_APPLIED'))
        assert.ok(request.messages.at(-1).content.includes(actionRef))
      }
      const session = system.slice(system.indexOf('# Session Context'))
      const document = JSON.parse(session.match(/<!-- capybara:context-binding data=(\{[^\n]+?\}) -->/)[1])
      const repeated = { ...initialAddition, ...document, idempotencyKey: `attempt-${calls}`,
        payload: { ...initialAddition.payload, classification: { ...initialAddition.payload.classification, reason: '原句需保存在会话审计章节' } } }
      if (calls === 6) repeated.target = { section: 'information', headingPath: ['另一章节'] }
      if (calls !== 5) return { provider: 'custom', model: 'test-model', text: '', raw: {}, toolCalls: [
        { id: `native-edit-${calls}`, name: 'propose_diff', arguments: calls === 4 ? { candidate_diffs: [repeated] } : { candidateDiffs: [repeated] } },
      ] }
      Object.assign(envelope, { decision: 'propose_diff', candidateDiffs: [repeated] })
    } else if (calls === 7) {
      assert.match(request.messages.at(-1).content, /Control rejected \(RUNTIME_CONTROL_TRANSPORT\)/)
      Object.assign(envelope, { decision: 'complete_plan_nodes', planProgress: { basePlanRevision: state.planRevision,
        nodes: [{ id: node.id, actionRefs: [actionRef], evidenceRefs: [] }] } })
    } else {
      assert.equal(calls, 8)
      assert.equal(state.tasks[0].status, 'completed')
      assert.match(system, /计划节点已经全部验收/)
      Object.assign(envelope, { decision: 'finish', userMessage: '审计章节已验收。', completionCheck: {
        taskId: binding.taskId, requiredActions: [actionRef], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '已核对原文档回执' } })
    }
    return { provider: 'custom', model: 'test-model', text: JSON.stringify(envelope), raw: {}, finishReason: 'stop' }
  } }
  const options = { runtimeOptions: { llm, planningRequired: true, contextOrganization: { minGroups: 1000 }, stepDelayMs: 0, streamDelayMs: 0 }, emit: ({ event }) => events.push(event) }
  const workspace = { workspaceId: 'project:planned-edit-ipc', workspaceName: 'Planned edit IPC', projectPath, webContents }
  let host = createBackendRuntimeManager(options)
  const send = (connection, id, text, humanRequestId) => host.send({ runtimeId: connection.runtimeId, webContents,
    frame: { version: 1, kind: 'command', id, type: 'chat.message.send', sessionId: connection.sessionId, timestamp: new Date().toISOString(),
      payload: { clientMessageId: id, content: [{ type: 'text', text }], autoStart: true, ...(humanRequestId ? { humanRequestId } : {}) } } })
  try {
    await host.ready
    const connection = await host.connect(workspace)
    await send(connection, 'edit-initial', `新建会话审计章节，保存原句「${body}」，创建后等待我确认验收。`)
    const paused = await waitFor(events, 'run.state.changed', event => ['paused', 'failed'].includes(event.payload.status))
    assert.equal(paused.payload.status, 'paused', JSON.stringify(paused.payload.failure))
    const action = events.find(event => event.type === 'runtime.context.v2.receipt.created' && event.payload.receipt.result === 'applied')
    assert.equal(actionRef, `context:${action.payload.receipt.id}`)
    const pending = events.find(event => event.type === 'runtime.context.v2.control.pending').payload.control
    await host.closeAll(); events.length = 0
    host = createBackendRuntimeManager(options); await host.ready
    const restored = await host.connect({ ...workspace, sessionId: connection.sessionId })
    const snapshot = events.find(event => event.type === 'runtime.snapshot').payload
    assert.deepEqual(snapshot.contextDocumentView.list, ['# session_context', ['## 审计章节', body]])
    assert.equal(snapshot.taskControl.tasks[0].status, 'pending')
    await send(restored, 'edit-confirmation', '确认验收', pending.humanRequestId)
    const completed = await waitFor(events, 'run.state.changed', event => ['completed', 'failed'].includes(event.payload.status))
    assert.equal(completed.payload.status, 'completed', JSON.stringify(completed.payload.failure))
    assert.equal(completed.payload.runId, paused.payload.runId)
    assert.equal(calls, 8)
    assert.ok(!events.some(event => event.type === 'runtime.context.v2.receipt.created' && event.payload.receipt.result === 'applied'))
  } finally { await host.closeAll(); fs.rmSync(projectPath, { recursive: true, force: true }) }
})

test('desktop IPC persists a capability refusal and resumes the original task after reconnecting', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-capability-recovery-ipc-'))
  await initializeProject(projectPath)
  const toolDir = path.join(projectPath, 'tools/recovery'), configPath = path.join(projectPath, '.capybara/config.json')
  fs.mkdirSync(toolDir, { recursive: true })
  fs.writeFileSync(path.join(toolDir, 'manifest.json'), JSON.stringify({ version: 1, package: 'recovery', runner: { type: 'stdio', entry: 'runner.mjs' }, tools: [
    { name: 'read_probe', description: 'Read the controlled test source', permissions: ['filesystem:read'], sideEffects: 'none', replay: 'safe', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  ] }))
  fs.writeFileSync(path.join(toolDir, 'runner.mjs'), "import fs from 'node:fs';import path from 'node:path';let raw='';for await(const part of process.stdin)raw+=part;const request=JSON.parse(raw);fs.writeFileSync(path.join(process.env.CAPYBARA_PROJECT_DIR,'unexpected-dispatch.txt'),'executed');process.stdout.write(JSON.stringify({id:request.id,ok:true,result:'probe'}));")
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  config.tools = ['tools/recovery/manifest.json']; config.tool_permissions = ['filesystem:read']; fs.writeFileSync(configPath, JSON.stringify(config))
  let calls = 0, revoked = false, sequence = 0, originalTask
  const events = [], webContents = {}
  const options = { runtimeOptions: { stepDelayMs: 0, streamDelayMs: 0, contextOrganization: { minGroups: 100 }, llm: { ...fakeLlm(), async chat(request) {
    calls++
    const binding = JSON.parse(request.messages[0].content.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)[0])
    originalTask ??= binding.taskId
    assert.equal(binding.taskId, originalTask)
    if (calls === 1) return { provider: 'custom', model: 'test-model', text: '', raw: {}, toolCalls: [{ id: 'revoked-probe', name: 'read_probe', arguments: {} }] }
    const envelope = { envelopeVersion: 2, binding, decision: 'continue', userMessage: '', actions: [], candidateDiffs: [], evidenceRequests: [], uncertainties: [], planProposal: null, waitSpec: null, completionCheck: null }
    if (calls === 2) {
      assert.ok(!request.tools.some(tool => tool.name === 'read_probe'))
      assert.ok(request.messages.some(message => message.role === 'tool' && message.content.includes('RUNTIME_CAPABILITY_REVOKED')))
      Object.assign(envelope, { decision: 'ask_user', userMessage: '读取权限已撤销，是否结束这次权限测试？', actions: [{ kind: 'ask_user', question: '读取权限已撤销，是否结束这次权限测试？', blockingTaskIds: [binding.taskId] }] })
    } else {
      assert.equal(calls, 3)
      Object.assign(envelope, { decision: 'finish', userMessage: '权限测试完成，被拒绝的读取未执行。', completionCheck: { taskId: binding.taskId, requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '已确认真实拒绝结果' } })
    }
    return { provider: 'custom', model: 'test-model', text: JSON.stringify(envelope), raw: {} }
  } } }, emit: ({ event }) => {
    events.push(event)
    if (!revoked && event.type === 'timeline.step.upserted' && event.payload.step.detail?.callId === 'revoked-probe' && event.payload.step.status === 'pending') {
      revoked = true; const current = JSON.parse(fs.readFileSync(configPath, 'utf8')); current.tool_permissions = []; fs.writeFileSync(configPath, JSON.stringify(current))
    }
  } }
  let host = createBackendRuntimeManager(options), connection
  const latest = type => [...events].reverse().find(event => event.type === type)?.payload
  async function waitState(status) {
    for (let attempt = 0; attempt < 1500; attempt++) {
      const run = latest('run.state.changed')
      if (run?.status === status) return run
      if (run?.status === 'failed') throw new Error(JSON.stringify(run.failure))
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`capability recovery IPC did not reach ${status}`)
  }
  const connect = async () => {
    await host.ready
    connection = await host.connect({ workspaceId: 'project:capability-recovery-ipc', workspaceName: 'Capability recovery IPC', projectPath, ...(connection ? { sessionId: connection.sessionId } : {}), webContents })
  }
  const send = async (type, payload) => host.send({ runtimeId: connection.runtimeId, webContents, frame: { version: 1, kind: 'command', id: `recovery-ipc-${++sequence}`, type, sessionId: connection.sessionId, timestamp: new Date().toISOString(), payload } })
  try {
    await connect()
    const tools = latest('runtime.snapshot').tools
    await send('runtime.tools.attach', { toolId: tools.catalog.find(tool => tool.name === 'read_probe').id, baseRevision: tools.revision })
    await send('chat.message.send', { clientMessageId: 'recovery-start', content: [{ type: 'text', text: '测试读取权限撤销后的恢复，然后等待我确认。' }], autoStart: true })
    const paused = await waitState('paused'), control = latest('runtime.context.v2.control.pending').control
    assert.equal(calls, 2)
    assert.equal(fs.existsSync(path.join(projectPath, 'unexpected-dispatch.txt')), false)
    await host.closeAll(); events.length = 0
    host = createBackendRuntimeManager(options); await connect()
    const snapshot = latest('runtime.snapshot')
    assert.equal(snapshot.taskControl.taskId, originalTask)
    assert.equal(snapshot.taskControl.capabilityRecovery.attempts, 1)
    const state = snapshot.contextOrganization.variables.find(variable => variable.name === 'runtime_state').value
    assert.equal(state.task.capabilityRecovery.attempts, 1)
    assert.ok(snapshot.observations.items.some(item => item.callId === 'revoked-probe' && item.status === 'failed'))
    await send('chat.message.send', { clientMessageId: 'recovery-answer', content: [{ type: 'text', text: '结束这次测试。' }], autoStart: true, humanRequestId: control.humanRequestId })
    const completed = await waitState('completed')
    assert.equal(completed.runId, paused.runId); assert.equal(calls, 3)
    assert.equal(fs.existsSync(path.join(projectPath, 'unexpected-dispatch.txt')), false)
  } finally { await host.closeAll(); fs.rmSync(projectPath, { recursive: true, force: true }) }
})

test('desktop IPC runs a real MCP server and reconnects its capabilities to the original task', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-mcp-ipc-'))
  await initializeProject(projectPath)
  const fixtureFile = path.resolve(__dirname, '../../backend/test/fixtures/mcp-fixture.mjs')
  const configPath = path.join(projectPath, '.capybara/config.json'), config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  config.mcp_servers = [{ id: 'evidence', enabled: true, transport: { type: 'stdio', command: process.execPath, args: [fixtureFile, projectPath] }, timeout_ms: 5000,
    tool_policies: { lookup: { permissions: [], sideEffects: 'none', replay: 'safe' } } }]
  config.tool_permissions = ['mcp:evidence:lookup']; fs.writeFileSync(configPath, JSON.stringify(config))
  fs.writeFileSync(path.join(projectPath, 'control.json'), '{"mode":"normal"}')
  const { mcpToolName } = await import(pathToFileURL(path.resolve(__dirname, '../../backend/dist/core/mcp/client-manager.js')).href)
  const toolName = mcpToolName('evidence', 'lookup'), events = [], webContents = {}
  let calls = 0, sequence = 0, originalTask
  const options = { runtimeOptions: { stepDelayMs: 0, streamDelayMs: 0, contextOrganization: { minGroups: 100 }, llm: { ...fakeLlm(), async chat(request) {
    calls++
    const binding = JSON.parse(request.messages[0].content.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)[0])
    originalTask ??= binding.taskId; assert.equal(binding.taskId, originalTask)
    if (calls === 1 || calls === 2) return { provider: 'custom', model: 'test-model', text: '', raw: {}, toolCalls: [{
      id: calls === 1 ? 'ipc-load-mcp' : 'ipc-real-mcp', name: calls === 1 ? 'load_resources' : toolName,
      arguments: calls === 1 ? { ids: ['mcp:evidence:lookup'] } : { key: 'source-A:125; source-B:120' },
    }] }
    const envelope = { envelopeVersion: 2, binding, decision: 'continue', userMessage: '', actions: [], candidateDiffs: [], evidenceRequests: [], uncertainties: [], planProposal: null, waitSpec: null, completionCheck: null }
    if (calls === 3) {
      const returned = JSON.parse(request.messages.find(message => message.role === 'tool' && message.toolCallId === 'ipc-real-mcp').content)
      assert.equal(returned.runtime_receipt.source.serverId, 'evidence')
      assert.equal(returned.result.structuredContent.value, 'source-A:125; source-B:120')
      Object.assign(envelope, { decision: 'ask_user', userMessage: '两份来源已保留，是否结束本次连接测试？', actions: [{ kind: 'ask_user', question: '两份来源已保留，是否结束本次连接测试？', blockingTaskIds: [binding.taskId] }] })
    } else {
      assert.equal(calls, 4); assert.ok(request.tools.some(tool => tool.name === toolName))
      Object.assign(envelope, { decision: 'finish', userMessage: 'MCP 结果与连接恢复已验证。', completionCheck: { taskId: binding.taskId, requiredActions: ['call:ipc-real-mcp'], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '保留原真实 MCP 收据，无重复读取' } })
    }
    return { provider: 'custom', model: 'test-model', text: JSON.stringify(envelope), raw: {} }
  } } }, emit: ({ event }) => events.push(event) }
  let host = createBackendRuntimeManager(options), connection
  const latest = type => [...events].reverse().find(event => event.type === type)?.payload
  const connect = async () => { await host.ready; connection = await host.connect({ workspaceId: 'project:mcp-ipc', workspaceName: 'MCP IPC', projectPath, ...(connection ? { sessionId: connection.sessionId } : {}), webContents }) }
  async function waitState(status) {
    for (let attempt = 0; attempt < 3000; attempt++) {
      const run = latest('run.state.changed'); if (run?.status === status) return run
      if (run?.status === 'failed') throw new Error(JSON.stringify(run.failure))
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`MCP IPC did not reach ${status}`)
  }
  const send = async (text, humanRequestId) => host.send({ runtimeId: connection.runtimeId, webContents, frame: { version: 1, kind: 'command', id: `mcp-ipc-${++sequence}`, type: 'chat.message.send', sessionId: connection.sessionId, timestamp: new Date().toISOString(), payload: { clientMessageId: `mcp-ipc-${sequence}`, content: [{ type: 'text', text }], autoStart: true, ...(humanRequestId ? { humanRequestId } : {}) } } })
  try {
    await connect(); assert.equal(latest('runtime.snapshot').mcp.servers[0].status, 'idle')
    await send('读取两份 MCP 来源并保留原始数值，然后等待我确认。')
    const paused = await waitState('paused'), control = latest('runtime.context.v2.control.pending').control
    const source = latest('tool.call.completed').receipt.source
    assert.equal(source.type, 'mcp'); assert.equal(source.toolName, 'lookup')
    assert.equal(source.rpcRequestId, JSON.parse(fs.readFileSync(path.join(projectPath, 'calls.jsonl'), 'utf8').trim()).rpcId)
    const oldConnection = source.connectionId
    await host.closeAll(); events.length = 0
    host = createBackendRuntimeManager(options); await connect()
    assert.equal(latest('runtime.snapshot').taskControl.taskId, originalTask)
    assert.equal(latest('runtime.snapshot').mcp.servers[0].status, 'idle')
    await send('结束测试。', control.humanRequestId)
    const completed = await waitState('completed')
    assert.equal(completed.runId, paused.runId); assert.equal(calls, 4)
    const ready = latest('runtime.mcp.updated').servers[0]
    assert.equal(ready.status, 'ready'); assert.notEqual(ready.connectionId, oldConnection)
    assert.equal(fs.readFileSync(path.join(projectPath, 'calls.jsonl'), 'utf8').trim().split('\n').length, 1)
  } finally { await host.closeAll(); fs.rmSync(projectPath, { recursive: true, force: true }) }
})

function fakeLlm() {
  return {
    getConfig() {
      return {
        provider: 'custom',
        protocol: 'chat-completions',
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'test-model',
        timeoutMs: 1_000,
        maxRetries: 0,
      }
    },
    async chat() {
      return {
        provider: 'custom',
        model: 'test-model',
        text: JSON.stringify({ status: 'completed', content: 'Backend RuntimeLoop 已通过 IPC 完成。' }),
        finishReason: 'stop',
        raw: {},
      }
    },
  }
}

function applicationLlm() {
  let calls = 0
  return {
    getConfig() {
      return {
        provider: 'custom',
        protocol: 'chat-completions',
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'test-model',
        timeoutMs: 1_000,
        maxRetries: 0,
      }
    },
    async chat() {
      calls += 1
      if (calls === 1) {
        return {
          provider: 'custom',
          model: 'test-model',
          text: '',
          toolCalls: [{ id: 'call:application', name: 'manage_application', arguments: { action: 'start' } }],
          finishReason: 'tool_calls',
          raw: {},
        }
      }
      return {
        provider: 'custom',
        model: 'test-model',
        text: JSON.stringify({ status: 'completed', content: '应用已经启动并通过健康检查。' }),
        finishReason: 'stop',
        raw: {},
      }
    },
  }
}

function delegationLlm() {
  let calls = 0
  return {
    getConfig() {
      return {
        provider: 'custom',
        protocol: 'chat-completions',
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'test-model',
        timeoutMs: 1_000,
        maxRetries: 0,
      }
    },
    async chat(request) {
      calls += 1
      const names = (request.tools || []).map((tool) => tool.name)
      if (calls === 1 && names.includes('delegate_task')) {
        return {
          provider: 'custom', model: 'test-model', text: '',
          toolCalls: [{ id: 'call:delegate', name: 'delegate_task', arguments: { goal: '核对目录', prompt: '只读列出项目根目录并报告结果', mode: 'sync' } }],
          finishReason: 'tool_calls', raw: {},
        }
      }
      if (calls === 2 && !names.includes('delegate_task') && names.includes('list_files')) {
        return {
          provider: 'custom', model: 'test-model', text: '',
          toolCalls: [{ id: 'call:child-list', name: 'list_files', arguments: { path: '.' } }],
          finishReason: 'tool_calls', raw: {},
        }
      }
      if (calls === 3 && !names.includes('delegate_task')) {
        return {
          provider: 'custom', model: 'test-model', text: JSON.stringify({ status: 'completed', content: '子智能体已核对目录。' }),
          finishReason: 'stop', raw: {},
        }
      }
      if (calls === 4) {
        const handle = JSON.parse(request.messages.findLast(message => message.role === 'tool' && message.name === 'delegate_task').content).result
        return { provider: 'custom', model: 'test-model', text: '', toolCalls: [{ id: 'call:read-child', name: 'read_child_result', arguments: { child_id: handle.childId } }], finishReason: 'tool_calls', raw: {} }
      }
      if (calls === 5) {
        const source = JSON.parse(request.messages.findLast(message => message.role === 'tool' && message.name === 'read_child_result').content).result
        return { provider: 'custom', model: 'test-model', text: '', toolCalls: [{ id: 'call:consume-child', name: 'consume_child_result', arguments: { child_id: source.childId, result_hash: source.result_hash, read_receipt_id: source.read_receipt_id, decision: 'accept', reason: '核对真实目录结果与子身份，将其作为来源使用。' } }], finishReason: 'tool_calls', raw: {} }
      }
      return {
        provider: 'custom', model: 'test-model', text: JSON.stringify({ status: 'completed', content: '父 Agent 已核对并合并子智能体结果。' }),
        finishReason: 'stop', raw: {},
      }
    },
  }
}

async function waitFor(events, type, predicate = () => true) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const event = events.find((item) => item.type === type && predicate(item))
    if (event) return event
    const failed = ['chat.assistant.completed', 'run.state.changed'].includes(type) && events.find((item) => item.type === 'run.state.changed' && item.payload.status === 'failed')
    if (failed) throw new Error(`IPC run failed: ${JSON.stringify(failed.payload.failure)}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${type}`)
}

test('Electron IPC host uses Backend RuntimeLoop context state and replays persisted trace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-backend-runtime-host-'))
  const projectPath = path.join(root, 'project')
  fs.mkdirSync(projectPath, { recursive: true })
  await initializeProject(projectPath)

  const events = []
  const host = createBackendRuntimeManager({
    runtimeOptions: { llm: fakeLlm() },
    emit: ({ event }) => events.push(event),
  })
  await host.ready
  const webContents = {}
  const connection = await host.connect({
    workspaceId: 'project:ipc-host',
    workspaceName: 'IPC Host',
    projectPath,
    webContents,
  })
  const initialSnapshot = events.find((event) => event.type === 'runtime.snapshot')
  assert.ok(initialSnapshot.payload.contextDocument)
  assert.ok(initialSnapshot.payload.contextControl)
  assert.ok(Array.isArray(initialSnapshot.payload.contextCandidates))

  await host.send({
    runtimeId: connection.runtimeId,
    webContents,
    frame: {
      version: 1,
      kind: 'command',
      id: 'command:ipc-host',
      type: 'chat.message.send',
      sessionId: connection.sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        clientMessageId: 'message:ipc-host',
        content: [{ type: 'text', text: '请回复连接成功' }],
        autoStart: true,
      },
    },
  })
  await waitFor(events, 'chat.assistant.completed')
  assert.ok(events.some((event) => event.type === 'run.state.changed'))
  assert.ok(events.every((event) => !JSON.stringify(event).includes(projectPath)))
  await host.closeAll()

  const replayEvents = []
  const restored = createBackendRuntimeManager({
    runtimeOptions: { llm: fakeLlm() },
    emit: ({ event }) => replayEvents.push(event),
  })
  await restored.ready
  await restored.connect({
    workspaceId: 'project:ipc-host',
    workspaceName: 'IPC Host',
    projectPath,
    sessionId: connection.sessionId,
    webContents: {},
  })
  const replaySnapshot = replayEvents.find((event) => event.type === 'runtime.snapshot')
  assert.ok(replaySnapshot.payload.contextDocument)
  assert.ok(replaySnapshot.payload.contextReceipts)
  assert.ok((replaySnapshot.payload.trace ?? []).length > 1)
  assert.equal((await restored.listSessions({ projectPath })).length, 1)
  await restored.closeAll()
})

test('Backend RuntimeLoop exposes the Electron application host as a governed tool', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-backend-application-host-'))
  const projectPath = path.join(root, 'project')
  fs.mkdirSync(projectPath, { recursive: true })
  await initializeProject(projectPath)
  const events = []
  const calls = []
  const host = createBackendRuntimeManager({
    runtimeOptions: { llm: applicationLlm() },
    applicationHost: async (input) => {
      calls.push(input)
      return { ok: true, output: { status: 'running', instanceId: 'instance:test', port: 4317 } }
    },
    emit: ({ event }) => events.push(event),
  })
  try {
    await host.ready
    const webContents = {}
    const connection = await host.connect({ workspaceId: 'project:application-host', workspaceName: '应用项目', projectPath, webContents })
    await host.send({
      runtimeId: connection.runtimeId,
      webContents,
      frame: {
        version: 1,
        kind: 'command',
        id: 'command:application-host',
        type: 'chat.message.send',
        sessionId: connection.sessionId,
        timestamp: new Date().toISOString(),
        payload: { clientMessageId: 'message:application-host', content: [{ type: 'text', text: '启动项目应用' }], autoStart: true },
      },
    })
    await waitFor(events, 'chat.assistant.completed')
    assert.equal(calls[0]?.action, 'start')
    assert.ok(events.some((event) => event.type === 'tool.call.started' && event.payload.toolName === 'manage_application'))
    assert.ok(events.some((event) => event.type === 'tool.call.completed' && event.payload.toolName === 'manage_application'))
  } finally {
    await host.closeAll()
  }
})

test('Backend RuntimeLoop restores legacy Electron transcript rows during session takeover', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-backend-legacy-session-'))
  const projectPath = path.join(root, 'project')
  fs.mkdirSync(projectPath, { recursive: true })
  await initializeProject(projectPath)
  const databaseFile = path.join(projectPath, '.capybara', 'sessions.sqlite')
  const database = new DatabaseSync(databaseFile)
  database.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      workspace_name TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0,
      messages_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE runtime_trace (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `)
  const createdAt = new Date().toISOString()
  const messages = [
    { id: 'legacy:user', role: 'user', status: 'completed', createdAt, content: [{ type: 'text', text: '旧消息' }] },
    { id: 'legacy:assistant', role: 'assistant', status: 'completed', createdAt, content: [{ type: 'text', text: '旧回复' }] },
  ]
  database.prepare(`INSERT INTO sessions (id, workspace_id, workspace_name, name, created_at, updated_at, request_count, revision, messages_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('session:legacy', 'project:legacy', '旧项目', '旧会话', createdAt, createdAt, 1, 1, JSON.stringify(messages))
  database.close()

  const events = []
  const host = createBackendRuntimeManager({ runtimeOptions: { llm: fakeLlm() }, emit: ({ event }) => events.push(event) })
  try {
    await host.ready
    await host.connect({ workspaceId: 'project:legacy', workspaceName: '旧项目', projectPath, sessionId: 'session:legacy', webContents: {} })
    const snapshot = events.find((event) => event.type === 'runtime.snapshot')
    assert.deepEqual(snapshot.payload.conversation.messages.map((message) => message.content[0].text), ['旧消息', '旧回复'])
  } finally {
    await host.closeAll()
  }
})

test('Backend RuntimeLoop delegates a read-only child agent through the Electron IPC host', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-backend-child-agent-'))
  const projectPath = path.join(root, 'project')
  fs.mkdirSync(projectPath, { recursive: true })
  await initializeProject(projectPath)
  const events = []
  const host = createBackendRuntimeManager({ runtimeOptions: { llm: delegationLlm() }, emit: ({ event }) => events.push(event) })
  try {
    await host.ready
    const webContents = {}
    const connection = await host.connect({ workspaceId: 'project:child-agent', workspaceName: '子智能体项目', projectPath, webContents })
    const tools = events.findLast(event => event.type === 'runtime.snapshot').payload.tools
    await host.send({ runtimeId: connection.runtimeId, webContents, frame: { version: 1, kind: 'command', id: 'command:allow-child-list', type: 'runtime.tools.attach', sessionId: connection.sessionId,
      timestamp: new Date().toISOString(), payload: { toolId: tools.catalog.find(tool => tool.name === 'list_files').id, baseRevision: tools.revision } } })
    await host.send({
      runtimeId: connection.runtimeId,
      webContents,
      frame: {
        version: 1,
        kind: 'command',
        id: 'command:child-agent',
        type: 'chat.message.send',
        sessionId: connection.sessionId,
        timestamp: new Date().toISOString(),
        payload: { clientMessageId: 'message:child-agent', content: [{ type: 'text', text: '请委派子智能体核对项目目录' }], autoStart: true },
      },
    })
    await waitFor(events, 'chat.assistant.completed')
    const childUpdates = events.filter((event) => event.type === 'runtime.children.updated')
    const latestChildren = childUpdates.at(-1)?.payload?.items || []
    assert.equal(latestChildren[0]?.status, 'succeeded')
    assert.equal(latestChildren[0]?.consumption?.decision, 'accept')
    assert.match(latestChildren[0]?.resultArtifactId || '', /^artifact-/)
    assert.ok(events.some((event) => event.type === 'tool.call.completed' && event.payload.toolName === 'delegate_task'))
    assert.ok(events.some((event) => event.type === 'tool.call.completed' && event.payload.toolName === 'list_files' && event.parentTurnId))
    assert.ok(events.some((event) => event.type === 'chat.assistant.completed' && event.payload.messageId))
  } finally {
    await host.closeAll()
  }
})

test('desktop IPC observes an async child while independent work continues and consumes its real result', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-async-child-ipc-'))
  await initializeProject(projectPath)
  const events = [], webContents = {}
  let calls = 0, childId, waitRef, resolveChild, markStarted
  const started = new Promise(resolve => { markStarted = resolve })
  const tool = (name, id, args) => ({ provider: 'custom', model: 'test-model', text: '', finishReason: 'tool_calls', raw: {}, toolCalls: [{ name, id, arguments: args }] })
  const source = (request, name) => {
    const message = request.messages.findLast(message => message.role === 'tool' && message.name === name)
    assert.ok(message)
    const parsed = JSON.parse(message.content); assert.equal(parsed.ok, true, message.content); return parsed.result
  }
  const llm = { ...fakeLlm(), async chat(request) {
    calls++
    const binding = JSON.parse(request.messages[0].content.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)[0])
    const envelope = { envelopeVersion: 2, binding, decision: 'continue', userMessage: '', actions: [], planProposal: null, candidateDiffs: [], evidenceRequests: [], uncertainties: [], waitSpec: null, completionCheck: null }
    if (calls === 1) return tool('delegate_task', 'ipc-async-delegate', { goal: '核对双方来源', prompt: '只读保留 A 与 B 的不同主张。' })
    if (calls === 2) { const handle = source(request, 'delegate_task'); childId = handle.childId; waitRef = handle.waitRef; return tool('search_resources', 'ipc-independent', { query: 'files' }) }
    if (calls === 3) { envelope.decision = 'wait'; envelope.waitSpec = { reason: '独立工作已完成，等待真实子结果。', signalType: 'runtime', correlationIds: [waitRef], condition: { eventType: 'child.ready' }, deadlineRef: null } }
    if (calls === 4) return tool('read_child_result', 'ipc-read-child', { child_id: childId })
    if (calls === 5) { const read = source(request, 'read_child_result'); assert.match(read.output_excerpt, /A 主张处理；B 主张不处理/); return tool('consume_child_result', 'ipc-consume-child', { child_id: childId, result_hash: read.result_hash, read_receipt_id: read.read_receipt_id, decision: 'conflict', reason: '两方观点作为来源保留，未将任意一方提升为事实。' }) }
    if (calls === 6) { envelope.decision = 'finish'; envelope.userMessage = '已保留双方来源，完成只读核对。'; envelope.completionCheck = { taskId: binding.taskId, requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '核对和消费已完成，未写入事实。' } }
    assert.ok(calls <= 6)
    return { provider: 'custom', model: 'test-model', text: JSON.stringify(envelope), raw: {}, finishReason: 'stop' }
  } }
  const host = createBackendRuntimeManager({ runtimeOptions: { llm, contextOrganization: { minGroups: 100 }, streamDelayMs: 0, stepDelayMs: 0,
    childAgentHost: async () => new Promise(resolve => { resolveChild = resolve; markStarted() }) }, emit: ({ event }) => events.push(event) })
  try {
    await host.ready
    const connection = await host.connect({ workspaceId: 'project:async-child', workspaceName: '异步子任务', projectPath, webContents })
    await host.send({ runtimeId: connection.runtimeId, webContents, frame: { version: 1, kind: 'command', id: 'ipc-async-chat', type: 'chat.message.send', sessionId: connection.sessionId,
      timestamp: new Date().toISOString(), payload: { clientMessageId: 'ipc-async-user', content: [{ type: 'text', text: '委派只读分析，同时检查可用资料，再核对结果。' }], autoStart: true } } })
    await waitFor(events, 'run.state.changed', event => event.payload.status === 'paused')
    await started
    assert.equal(calls, 3)
    assert.ok(events.some(event => event.type === 'tool.call.completed' && event.payload.toolName === 'search_resources'))
    assert.equal(events.findLast(event => event.type === 'runtime.children.updated').payload.items[0].status, 'running')
    resolveChild({ ok: true, output: 'A 主张处理；B 主张不处理。两方条件与来源各自保留。' })
    try { await waitFor(events, 'run.state.changed', event => event.payload.status === 'completed') }
    catch (error) {
      const failed = events.findLast(event => event.type === 'run.state.changed' && event.payload.status === 'failed')
      if (failed?.payload.failure?.errorArtifactId) {
        await host.send({ runtimeId: connection.runtimeId, webContents, frame: { version: 1, kind: 'command', id: 'ipc-read-failure', type: 'runtime.artifact.get', sessionId: connection.sessionId,
          timestamp: new Date().toISOString(), payload: { artifactId: failed.payload.failure.errorArtifactId } } })
        throw new Error(`${error.message}; ${JSON.stringify(events.findLast(event => event.type === 'runtime.artifact.content')?.payload.value)}`)
      }
      throw error
    }
    const child = events.findLast(event => event.type === 'runtime.children.updated').payload.items[0]
    assert.equal(calls, 6); assert.equal(child.id, childId); assert.equal(child.status, 'succeeded'); assert.equal(child.consumption.decision, 'conflict')
    assert.ok(child.resultArtifactId)
  } finally { await host.closeAll() }
})

test('desktop IPC invokes readonly Reflection and restores its source and receipt after reconnect', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-reflection-ipc-'))
  await initializeProject(projectPath)
  const events = [], webContents = {}
  let mainCalls = 0, auxiliaryCalls = 0, connection, host
  const llm = { ...fakeLlm(), async chat(request) {
    if (++mainCalls === 1) return { provider: 'custom', model: 'test-model', text: '', raw: {}, toolCalls: [{ id: 'ipc-missing-source', name: 'read_runtime_artifact', arguments: { artifact_id: 'missing-original' } }] }
    const binding = JSON.parse(request.messages[0].content.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)[0])
    const envelope = { envelopeVersion: 2, binding, decision: 'reflect', userMessage: '', actions: [], planProposal: null, candidateDiffs: [], evidenceRequests: [], uncertainties: [], waitSpec: null, completionCheck: null }
    if (mainCalls === 3) {
      assert.match(request.messages[0].content, /原件尚不存在/)
      assert.equal(request.messages.filter(message => message.role === 'user').length, 1)
      Object.assign(envelope, { decision: 'finish', userMessage: '已确认读取缺失，不编造原件。', completionCheck: { taskId: binding.taskId, requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '完成失败诊断，未声称成功读取。' } })
    }
    assert.ok(mainCalls <= 3)
    return { provider: 'custom', model: 'test-model', text: JSON.stringify(envelope), raw: {} }
  } }
  const auxiliary = { ...fakeLlm(), async chat(request) {
    auxiliaryCalls++
    assert.equal(request.tools, undefined)
    const lines = request.messages[0].content.split('\n')
    const header = JSON.parse(lines.find(line => line.startsWith('{"reflectionVersion":1,"snapshotId":')))
    const data = JSON.parse(lines.find(line => line.startsWith('{"goal":')))
    const source = data.sources.find(source => source.kind === 'failed-step')
    assert.ok(source)
    return { provider: 'custom', model: 'test-model', raw: {}, text: JSON.stringify({ reflectionVersion: 1, snapshotId: header.snapshotId,
      diagnosis: [{ statement: '原件尚不存在，需核实引用后再读取。', sourceRefs: [source.id] }], correctionPlan: [], candidateDiffs: [], evidenceRequests: [], retryPreconditions: [], uncertainties: [] }) }
  } }
  const options = { runtimeOptions: { llm, contextAssistant: { llm: auxiliary }, contextOrganization: { minGroups: 100 }, streamDelayMs: 0, stepDelayMs: 0 }, emit: ({ event }) => events.push(event) }
  const connect = async () => {
    await host.ready
    connection = await host.connect({ workspaceId: 'project:reflection', workspaceName: '反思验证', projectPath, ...(connection ? { sessionId: connection.sessionId } : {}), webContents })
  }
  try {
    host = createBackendRuntimeManager(options); await connect()
    await host.send({ runtimeId: connection.runtimeId, webContents, frame: { version: 1, kind: 'command', id: 'ipc-reflection-user', type: 'chat.message.send', sessionId: connection.sessionId,
      timestamp: new Date().toISOString(), payload: { clientMessageId: 'ipc-reflect', content: [{ type: 'text', text: '尝试读取原件，失败时解释原因，不编造事实。' }], autoStart: true } } })
    await waitFor(events, 'run.state.changed', event => event.payload.status === 'completed')
    assert.equal(mainCalls, 3); assert.equal(auxiliaryCalls, 1)
    const source = events.find(event => event.type === 'runtime.artifact.created' && event.payload.artifact.label === 'Reflection result (guidance only)').payload.artifact
    await host.closeAll(); host = createBackendRuntimeManager(options); await connect()
    const snapshot = events.findLast(event => event.type === 'runtime.snapshot').payload
    assert.equal(snapshot.run.status, 'completed')
    assert.equal(snapshot.contextDocumentView.information.length, 0)
    await host.send({ runtimeId: connection.runtimeId, webContents, frame: { version: 1, kind: 'command', id: 'ipc-read-reflection', type: 'runtime.artifact.get', sessionId: connection.sessionId,
      timestamp: new Date().toISOString(), payload: { artifactId: source.id } } })
    const packet = events.findLast(event => event.type === 'runtime.artifact.content').payload.value
    assert.equal(packet.kind, 'reflection-source'); assert.equal(packet.promptBindings[1].version, 'reflection-draft-0.2')
    assert.equal(packet.output.diagnosis[0].statement, '原件尚不存在，需核实引用后再读取。')
    assert.equal(packet.input.tools, undefined)
    assert.equal(auxiliaryCalls, 1)
  } finally { await host?.closeAll() }
})

test('desktop IPC exposes a model-selected Recall candidate and preserves it after reconnect', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-recall-assistant-ipc-'))
  await initializeProject(projectPath)
  const events = []
  const webContents = {}
  let assistantCalls = 0
  const llm = { ...fakeLlm(), async chat(request) {
    assistantCalls++
    assert.equal(request.tools, undefined)
    const lines = request.messages[0].content.split('\n')
    const { snapshotId } = JSON.parse(lines.find(line => line.startsWith('{"organizationVersion":1,"snapshotId":')))
    const { candidates } = JSON.parse(lines.find(line => line.startsWith('{"query":')))
    const choice = candidates.find(hit => hit.body.includes('120'))
    assert.ok(choice)
    return { provider: 'custom', model: 'test-model', raw: {}, text: JSON.stringify({
      organizationVersion: 1, snapshotId, mode: 'recall', uncertainties: [],
      recallProposals: [{ id: choice.id, reason: '核对 B 来源' }],
    }) }
  } }
  const options = { emit: ({ event }) => events.push(event), runtimeOptions: { contextAssistant: { llm, modes: ['recall'] } } }
  let host = createBackendRuntimeManager(options)
  let connection
  const connect = async () => {
    await host.ready
    connection = await host.connect({ workspaceId: 'project:assisted-recall', workspaceName: '召回验证', projectPath,
      ...(connection ? { sessionId: connection.sessionId } : {}), webContents })
  }
  let commandId = 0
  const send = async (type, payload) => host.send({ runtimeId: connection.runtimeId, webContents, frame: {
    version: 1, kind: 'command', id: `ipc-assisted-recall-${++commandId}`, type, sessionId: connection.sessionId, timestamp: new Date().toISOString(), payload,
  } })
  try {
    await connect()
    const document = events.findLast(event => event.type === 'runtime.snapshot').payload.contextDocumentView
    for (const amount of [125, 120]) {
      const sourceId = `refund-${amount}`
      await send('runtime.context.v2.observe', { observation: { documentId: document.meta.id,
        candidate: { source: { actor: 'memory', sourceId, capturedAt: new Date().toISOString() }, rawArtifactId: sourceId, normalizedContent: `退款来源记录 ${amount} 元` },
        evidence: { kind: 'message', referenceId: sourceId } } })
    }
    await send('runtime.context.v2.memory.recall', { query: '退款', limit: 1 })
    const event = await waitFor(events, 'runtime.context.v2.memory.recalled')
    assert.equal(event.payload.candidates[0].status, 'pending')
    assert.match(event.payload.hits[0].body, /120/)
    assert.equal(event.payload.hits[0].reason, '核对 B 来源')
    await host.closeAll()
    host = createBackendRuntimeManager(options)
    await connect()
    const resumed = events.findLast(event => event.type === 'runtime.snapshot').payload.contextDocumentView
    assert.deepEqual(resumed.information, [])
    assert.equal(resumed.candidates.find(candidate => candidate.id === event.payload.candidates[0].id).status, 'pending')
    assert.equal(assistantCalls, 1)
  } finally { await host.closeAll() }
})

test('desktop IPC persists a V2 human request and resumes its original task after reconnect', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-human-ipc-'))
  await initializeProject(projectPath)
  let calls = 0
  const llm = {
    ...fakeLlm(),
    async chat(request) {
      calls += 1
      const system = request.messages.find((message) => message.role === 'system')?.content || ''
      const match = system.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)
      assert.ok(match)
      const binding = JSON.parse(match[0])
      const envelope = { envelopeVersion: 2, binding, decision: 'ask_user', userMessage: '请选择数据目录。', actions: [{ kind: 'ask_user', question: '请选择数据目录。', blockingTaskIds: [binding.taskId] }], planProposal: null, candidateDiffs: [], evidenceRequests: [], uncertainties: [], waitSpec: null, completionCheck: null }
      if (calls > 1) {
        assert.ok(request.messages.some((message) => message.role === 'user' && message.content === 'input-data'))
        Object.assign(envelope, { decision: 'finish', userMessage: '收到目录。', actions: [], completionCheck: { taskId: binding.taskId, requiredEvidenceRefs: [], requiredActions: [], unresolvedUncertaintyIds: [], summary: '收到所需输入' } })
      }
      return { provider: 'custom', model: 'test-model', finishReason: 'stop', raw: {}, text: JSON.stringify(envelope) }
    },
  }
  async function waitState(events, status) {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const found = events.find((event) => event.type === 'run.state.changed' && event.payload.status === status)
      if (found) return found
      const failed = events.find((event) => event.type === 'run.state.changed' && event.payload.status === 'failed')
      if (failed) throw new Error(JSON.stringify(failed.payload.failure))
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`IPC run did not reach ${status}`)
  }
  const events = []
  const options = { runtimeOptions: { llm, stepDelayMs: 0, streamDelayMs: 0 }, emit: ({ event }) => events.push(event) }
  let host = createBackendRuntimeManager(options)
  try {
    await host.ready
    const webContents = {}
    const connection = await host.connect({ workspaceId: 'project:human-ipc', workspaceName: 'Human IPC', projectPath, webContents })
    const frame = (id, text, humanRequestId) => ({ version: 1, kind: 'command', id, type: 'chat.message.send', sessionId: connection.sessionId, timestamp: new Date().toISOString(), payload: { clientMessageId: id, content: [{ type: 'text', text }], autoStart: true, ...(humanRequestId ? { humanRequestId } : {}) } })
    await host.send({ runtimeId: connection.runtimeId, webContents, frame: frame('initial-human', '确认目录') })
    const paused = await waitState(events, 'paused')
    const pending = events.find((event) => event.type === 'runtime.context.v2.control.pending')?.payload.control
    assert.ok(pending.humanRequestId)
    assert.ok(events.some((event) => event.type === 'chat.assistant.delta' && event.payload.delta === '请选择数据目录。'))
    await host.closeAll()
    events.length = 0
    host = createBackendRuntimeManager(options)
    await host.ready
    const reconnected = await host.connect({ workspaceId: 'project:human-ipc', workspaceName: 'Human IPC', projectPath, sessionId: connection.sessionId, webContents })
    const snapshot = events.find((event) => event.type === 'runtime.snapshot')?.payload
    assert.equal(snapshot.contextControl.humanRequestId, pending.humanRequestId)
    assert.equal(snapshot.taskControl.taskId, pending.taskId)
    assert.ok(snapshot.conversation.messages.some((message) => message.role === 'assistant' && message.content.some((part) => part.text === '请选择数据目录。')))
    await host.send({ runtimeId: reconnected.runtimeId, webContents, frame: frame('answer-human', 'input-data', pending.humanRequestId) })
    const completed = await waitState(events, 'completed')
    assert.equal(completed.payload.runId, paused.payload.runId)
    assert.equal(calls, 2)
  } finally {
    await host.closeAll()
    fs.rmSync(projectPath, { recursive: true, force: true })
  }
})

for (const kind of ['human', 'evidence']) test(`desktop IPC restores a pending ${kind} branch question and its bound reply`, async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-branch-ipc-'))
  await initializeProject(projectPath)
  let calls = 0
  const task = { id: 'source', title: '核对来源', phase: 'investigation', dependsOn: [], owner: 'parent', capabilityIds: ['search_resources'],
    completionConditions: ['读取正确目录'], requiredActions: ['call:branch-ipc-read'], evidenceRefs: [], status: 'pending' }
  const llm = { ...fakeLlm(), async chat(request) {
    calls++
    const binding = JSON.parse(request.messages[0].content.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)[0])
    const envelope = { envelopeVersion: 2, binding, decision: 'continue', userMessage: '', actions: [], planProposal: null,
      candidateDiffs: [], evidenceRequests: [], uncertainties: [], waitSpec: null, completionCheck: null }
    if (calls === 1 || calls === 4) Object.assign(envelope, { decision: 'propose_plan', planProposal: {
      basePlanRevision: calls === 1 ? 0 : 1, goal: '核对来源目录', tasks: [{ ...task, requiredActions: calls === 1 ? [] : task.requiredActions, status: calls === 1 ? 'pending' : 'completed' }],
    } })
    else if (calls === 2) {
      if (kind === 'human') Object.assign(envelope, { decision: 'ask_user', userMessage: '请确认资源目录。',
        actions: [{ kind: 'ask_user', question: '请确认资源目录。', blockingTaskIds: ['source'] }] })
      else envelope.evidenceRequests = [{ id: 'directory-confirmation', question: '请提供目录来源。', sourceKinds: ['user'], relatedTaskIds: ['source'] }]
    }
    else if (calls === 3) {
      assert.ok(request.messages.some(message => message.content.includes('目录确认为 files')))
      return { provider: 'custom', model: 'test-model', text: '', raw: {}, toolCalls: [{ id: 'branch-ipc-read', name: 'search_resources', arguments: { query: 'files' } }] }
    } else {
      assert.equal(calls, 5)
      Object.assign(envelope, { decision: 'finish', userMessage: '已核对目录。', completionCheck: {
        taskId: binding.taskId, requiredEvidenceRefs: [], requiredActions: [], unresolvedUncertaintyIds: [], summary: '实际查询有回执',
      } })
    }
    return { provider: 'custom', model: 'test-model', text: JSON.stringify(envelope), raw: {}, finishReason: 'stop' }
  } }
  const events = [], webContents = {}
  const options = { runtimeOptions: { llm, planningRequired: true, stepDelayMs: 0, streamDelayMs: 0, contextOrganization: { minGroups: 100 } }, emit: ({ event }) => events.push(event) }
  let host = createBackendRuntimeManager(options)
  const connect = async (sessionId) => {
    await host.ready
    return host.connect({ workspaceId: 'project:branch-ipc', workspaceName: 'Branch IPC', projectPath, ...(sessionId ? { sessionId } : {}), webContents })
  }
  const send = (connection, id, text, humanRequestId) => host.send({ runtimeId: connection.runtimeId, webContents, frame: {
    version: 1, kind: 'command', id, type: 'chat.message.send', sessionId: connection.sessionId, timestamp: new Date().toISOString(),
    payload: { clientMessageId: id, content: [{ type: 'text', text }], autoStart: true, ...(humanRequestId ? { humanRequestId } : {}) },
  } })
  const waitForStatus = async (status) => {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const run = events.find(event => event.type === 'run.state.changed' && [status, 'failed'].includes(event.payload.status))?.payload
      if (run?.status === 'failed') throw new Error(JSON.stringify(run.failure))
      if (run) return run
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`branch IPC did not reach ${status}`)
  }
  try {
    const connection = await connect()
    await send(connection, 'branch-ipc-start', '请规划并核对目录')
    const paused = await waitForStatus('paused')
    const question = events.filter(event => event.type === 'runtime.snapshot').at(-1).payload.taskControl.branchBlocks[0]
    assert.equal(question.kind, kind)
    assert.deepEqual(question.taskIds, ['source'])
    await host.closeAll(); events.length = 0
    host = createBackendRuntimeManager(options)
    const restored = await connect(connection.sessionId)
    const snapshot = events.find(event => event.type === 'runtime.snapshot').payload
    assert.equal(snapshot.taskControl.branchBlocks[0].id, question.id)
    await send(restored, 'branch-ipc-answer', '目录确认为 files', question.id)
    assert.equal((await waitForStatus('completed')).runId, paused.runId)
    assert.equal(calls, 5)
  } finally { await host.closeAll(); fs.rmSync(projectPath, { recursive: true, force: true }) }
})

test('desktop IPC preserves a plan assignment, its local child authority, and the review after reconnect', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-child-plan-ipc-'))
  await initializeProject(projectPath)
  const task = { id: 'source', title: '子任务核对目录', phase: 'investigation', dependsOn: [], owner: 'parent',
    capabilityIds: ['delegate_task', 'search_resources'], completionConditions: ['验收真实子结果'],
    requiredActions: ['call:ipc-assigned-review'], evidenceRefs: [], status: 'pending' }
  let parentCalls = 0, childCalls = 0, childId
  const llm = { ...fakeLlm(), async chat(request) {
    const system = request.messages[0].content
    const binding = JSON.parse(system.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)[0])
    const envelope = { envelopeVersion: 2, binding, decision: 'continue', userMessage: '', actions: [], planProposal: null,
      candidateDiffs: [], evidenceRequests: [], uncertainties: [], waitSpec: null, completionCheck: null }
    const tool = (id, name, args) => ({ provider: 'custom', model: 'test-model', text: '', raw: {}, toolCalls: [{ id, name, arguments: args }] })
    const result = name => {
      const source = request.messages.filter(message => message.role === 'tool' && message.name === name).at(-1)
      assert.ok(source, name)
      const view = JSON.parse(source.content)
      assert.equal(view.ok, true)
      return view.result
    }
    const finish = (text, requiredActions) => Object.assign(envelope, { decision: 'finish', userMessage: text, completionCheck: {
      taskId: binding.taskId, requiredActions, requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '有实际回执',
    } })
    if (system.includes('Capybara A2A Child Agent Prompt')) {
      assert.match(system, /"planTaskId":"source"/)
      assert.deepEqual(request.tools.map(tool => tool.name), ['search_resources'])
      if (++childCalls === 1) return tool('ipc-assigned-lookup', 'search_resources', { query: 'files' })
      assert.equal(childCalls, 2)
      result('search_resources')
      finish('已核对目录。', ['call:ipc-assigned-lookup'])
    } else {
      parentCalls++
      if (parentCalls === 1 || parentCalls === 7) Object.assign(envelope, { decision: 'propose_plan', planProposal: {
        basePlanRevision: parentCalls === 1 ? 0 : 1, goal: '完成只读委派', tasks: [{ ...task, requiredActions: parentCalls === 1 ? [] : task.requiredActions, status: parentCalls === 1 ? 'pending' : 'completed' }],
      } })
      else if (parentCalls === 2) return tool('ipc-assigned-dispatch', 'delegate_task', { plan_task_id: 'source', goal: '核对目录', prompt: '搜索 files', mode: 'sync' })
      else if (parentCalls === 3) {
        assert.match(system, /"phase":"delegation"/)
        const delegated = result('delegate_task')
        assert.equal(delegated.planTaskId, 'source')
        childId = delegated.childId
        return tool('ipc-assigned-read', 'read_child_result', { child_id: childId })
      } else if (parentCalls === 4) {
        assert.equal(result('read_child_result').planTaskId, 'source')
        envelope.evidenceRequests = [{ id: 'child-proof', question: '绑定子来源以便父层审核', sourceKinds: ['child-agent'], relatedTaskIds: ['source'] }]
      } else if (parentCalls === 5) {
        assert.match(system, /"phase":"evidence"/)
        const evidenceId = system.match(/branch-evidence-[a-f0-9-]{36}/)[0]
        return tool('ipc-assigned-source', 'submit_branch_evidence', { request_id: evidenceId, candidate_id: result('read_child_result').candidateId })
      } else if (parentCalls === 6) {
        assert.equal(result('submit_branch_evidence').sourceKind, 'child-agent')
        const read = result('read_child_result')
        assert.equal(read.planTaskId, 'source')
        assert.match(read.output_excerpt, /已核对目录/)
        return tool('ipc-assigned-review', 'consume_child_result', { child_id: childId, result_hash: read.result_hash,
          read_receipt_id: read.read_receipt_id, decision: 'accept', reason: '已核对真实只读结果' })
      } else { assert.equal(parentCalls, 8); finish('委派已验收。', []) }
    }
    return { provider: 'custom', model: 'test-model', text: JSON.stringify(envelope), raw: {}, finishReason: 'stop' }
  } }
  const events = [], webContents = {}
  const options = { runtimeOptions: { llm, planningRequired: true, childAgentEnabled: true, stepDelayMs: 0, streamDelayMs: 0, contextOrganization: { minGroups: 100 } },
    emit: ({ event }) => events.push(event) }
  let host = createBackendRuntimeManager(options)
  const connect = async (sessionId) => {
    await host.ready
    return host.connect({ workspaceId: 'project:child-plan-ipc', workspaceName: 'Child Plan IPC', projectPath, ...(sessionId ? { sessionId } : {}), webContents })
  }
  try {
    const connection = await connect()
    await host.send({ runtimeId: connection.runtimeId, webContents, frame: { version: 1, kind: 'command', id: 'plan-ipc-start', type: 'chat.message.send',
      sessionId: connection.sessionId, timestamp: new Date().toISOString(), payload: { clientMessageId: 'plan-ipc-user', autoStart: true, content: [{ type: 'text', text: '规划并委派目录核对' }] } } })
    let terminal
    for (let attempt = 0; attempt < 1500 && !terminal; attempt++) {
      terminal = events.find(event => event.type === 'run.state.changed' && ['completed', 'failed'].includes(event.payload.status))?.payload
      if (!terminal) await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(terminal?.status, 'completed', JSON.stringify(terminal?.failure))
    await host.closeAll(); events.length = 0
    host = createBackendRuntimeManager(options)
    await connect(connection.sessionId)
    const restored = events.find(event => event.type === 'runtime.snapshot').payload
    assert.equal(restored.run.runId, terminal.runId)
    assert.deepEqual(restored.taskControl.childAssignments, [{ planTaskId: 'source', childId, state: 'accepted' }])
    assert.equal(restored.children.items[0].planTaskId, 'source')
    assert.equal(restored.children.items[0].consumption.decision, 'accept')
    assert.equal(parentCalls, 8)
    assert.equal(childCalls, 2)
  } finally { await host.closeAll(); fs.rmSync(projectPath, { recursive: true, force: true }) }
})

test('desktop IPC restores a failed child review and its parent takeover', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-takeover-ipc-'))
  await initializeProject(projectPath)
  const task = { id: 'source', title: '核对目录', phase: 'investigation', dependsOn: [], owner: 'parent',
    capabilityIds: ['delegate_task', 'search_resources'], completionConditions: ['确认目录来源'],
    requiredActions: ['call:ipc-takeover-review'], evidenceRefs: [], status: 'pending' }
  let calls = 0, childId, takeoverId
  const llm = { ...fakeLlm(), async chat(request) {
    const system = request.messages[0].content
    if (system.includes('# Capybara Context Organizer Prompt')) {
      const { organizationVersion, snapshotId, mode } = JSON.parse(request.messages[1].content)
      return { provider: 'custom', model: 'test-model', raw: {}, text: JSON.stringify({ organizationVersion, snapshotId, mode,
        observations: [], diffProposals: [], archiveProposals: [], recallProposals: [], coverageProposal: null, uncertainties: [] }) }
    }
    const binding = JSON.parse(system.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)[0])
    const respond = (fields) => ({ provider: 'custom', model: 'test-model', raw: {}, finishReason: 'stop', text: JSON.stringify({
      envelopeVersion: 2, binding, userMessage: '', actions: [], planProposal: null, candidateDiffs: [], evidenceRequests: [],
      uncertainties: [], waitSpec: null, completionCheck: null, ...fields,
    }) })
    const tool = (id, name, args) => ({ provider: 'custom', model: 'test-model', text: '', raw: {}, toolCalls: [{ id, name, arguments: args }] })
    const result = (name) => {
      const message = request.messages.filter(item => item.role === 'tool' && item.name === name).at(-1)
      assert.ok(message, name)
      const view = JSON.parse(message.content)
      assert.equal(view.ok, true)
      return view.result
    }
    const plan = (basePlanRevision, node) => respond({ decision: 'propose_plan', planProposal: { basePlanRevision, goal: '核对目录', tasks: [node] } })
    switch (++calls) {
      case 1: return plan(0, { ...task, requiredActions: [] })
      case 2: return tool('ipc-takeover-delegate', 'delegate_task', { plan_task_id: 'source', goal: '核对目录', prompt: '找目录来源。', mode: 'sync' })
      case 3: {
        const delegated = result('delegate_task')
        assert.equal(delegated.status, 'failed')
        childId = delegated.childId
        return tool('ipc-takeover-read', 'read_child_result', { child_id: childId })
      }
      case 4: {
        const read = result('read_child_result')
        return tool('ipc-takeover-review', 'consume_child_result', { child_id: childId, result_hash: read.result_hash,
          read_receipt_id: read.read_receipt_id, decision: 'reject', reason: '子任务未找到来源' })
      }
      case 5: return tool('ipc-takeover-control', 'take_over_child_task', { child_id: childId, plan_task_id: 'source',
        review_receipt_id: result('consume_child_result').reviewReceipt.receiptId, reason: '父层核对目录' })
      case 6: {
        assert.match(system, /"parentTakeover":\{"planTaskId":"source"/)
        takeoverId = result('take_over_child_task').takeover.id
        assert.ok(takeoverId)
        return tool('ipc-takeover-proof', 'search_resources', { query: 'files', limit: 1 })
      }
      case 7: {
        result('search_resources')
        return plan(1, { ...task, status: 'completed', requiredActions: [...task.requiredActions, 'call:ipc-takeover-proof'] })
      }
      case 8: return respond({ decision: 'finish', userMessage: '父层已核对目录。', completionCheck: { taskId: binding.taskId,
        requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '回执已核验' } })
      default: assert.fail(`Unexpected model round ${calls}`)
    }
  } }
  const events = [], webContents = {}
  const options = { runtimeOptions: { llm, planningRequired: true, childAgentEnabled: true, stepDelayMs: 0, streamDelayMs: 0,
    childAgentHost: async () => ({ ok: false, error: { code: 'SOURCE_UNAVAILABLE', message: '来源读取失败' } }) },
    emit: ({ event }) => events.push(event) }
  let host = createBackendRuntimeManager(options)
  const connect = async (sessionId) => {
    await host.ready
    return host.connect({ workspaceId: 'project:takeover-ipc', workspaceName: 'Takeover IPC', projectPath, ...(sessionId ? { sessionId } : {}), webContents })
  }
  try {
    const connection = await connect()
    await host.send({ runtimeId: connection.runtimeId, webContents, frame: { version: 1, kind: 'command', id: 'takeover-ipc-start', type: 'chat.message.send',
      sessionId: connection.sessionId, timestamp: new Date().toISOString(), payload: { clientMessageId: 'takeover-ipc-user', autoStart: true,
        content: [{ type: 'text', text: '核对目录。' }] } } })
    let terminal
    for (let attempt = 0; attempt < 1500 && !terminal; attempt++) {
      terminal = events.find(event => event.type === 'run.state.changed' && ['completed', 'failed'].includes(event.payload.status))?.payload
      if (!terminal) await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(terminal?.status, 'completed', JSON.stringify(terminal?.failure))
    const proof = events.find(event => event.type === 'tool.call.completed' && event.payload.callId === 'ipc-takeover-proof')?.payload.receipt
    assert.equal(proof?.status, 'succeeded')
    assert.equal(proof.parentTakeover.takeoverId, takeoverId)
    await host.closeAll(); events.length = 0
    host = createBackendRuntimeManager(options)
    await connect(connection.sessionId)
    const restored = events.find(event => event.type === 'runtime.snapshot').payload
    assert.equal(restored.run.runId, terminal.runId)
    assert.deepEqual(restored.taskControl.childAssignments, [{ planTaskId: 'source', childId, state: 'parent', takeoverId }])
    assert.equal(restored.children.items[0].status, 'failed')
    assert.equal(restored.children.items[0].consumption.decision, 'reject')
    assert.equal(restored.children.items[0].takeover.id, takeoverId)
    assert.equal(calls, 8)
  } finally { await host.closeAll(); fs.rmSync(projectPath, { recursive: true, force: true }) }
})

for (const scenario of ['direct', 'workflow', 'wait']) test(`desktop IPC restores the ${scenario} path for real MCP verification without replaying the original write`, async () => {
  const workflow = scenario === 'workflow', waiting = scenario === 'wait'
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-mcp-verification-ipc-'))
  await initializeProject(projectPath)
  fs.writeFileSync(path.join(projectPath, 'control.json'), JSON.stringify({ mode: 'normal', verification: waiting ? 'pending' : 'applied', report_original: workflow }))
  const configPath = path.join(projectPath, '.capybara', 'config.json')
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  config.context = { ...config.context, context_window_tokens: 20000, max_input_tokens: 18000 }
  config.tool_permissions = ['mcp:records:mutate', 'mcp:records:verify', ...(workflow ? ['mcp:records:lookup'] : [])]
  config.mcp_servers = [{ id: 'records', enabled: true, transport: { type: 'stdio', command: process.execPath,
    args: [path.resolve(__dirname, '../../backend/test/fixtures/mcp-fixture.mjs'), projectPath] },
    tool_policies: { mutate: { permissions: [], sideEffects: 'external', replay: 'never', verification_tool: 'verify', ...(waiting ? { verification_poll_ms: 1000 } : {}) },
      ...(workflow ? { lookup: { permissions: [], sideEffects: 'none', replay: 'safe' } } : {}),
      verify: { permissions: [], sideEffects: 'none', replay: 'safe' } } }]
  fs.writeFileSync(configPath, JSON.stringify(config))
  let round = 0, operationId = '', workflowId = ''
  const llm = { ...fakeLlm(), async chat(request) {
    const tool = (id, name, args) => ({ provider: 'custom', model: 'test-model', text: '', raw: {}, toolCalls: [{ id, name, arguments: args }] })
    const result = id => JSON.parse(request.messages.find(message => message.toolCallId === id).content)
    const binding = JSON.parse(request.messages[0].content.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)[0])
    const control = fields => ({ provider: 'custom', model: 'test-model', raw: {}, text: JSON.stringify({ envelopeVersion: 2, binding,
      userMessage: '', actions: [], planProposal: null, candidateDiffs: [], evidenceRequests: [], uncertainties: [], waitSpec: null, completionCheck: null, ...fields }) })
    if (++round === 1) return tool('ipc-load-mcp-verification', 'load_resources', { ids: config.tool_permissions })
    if (round === 2) {
      const mutation = request.tools.find(item => item.name.startsWith('mcp_records_mutate_'))
      assert.ok(mutation)
      if (workflow) return tool('ipc-mcp-write', 'execute_workflow', { version: 1, goal: '写入并读回', steps: [
        { id: 'write', type: 'tool', tool: mutation.name, arguments: { key: 'ipc-record' } },
        { id: 'read', type: 'tool', tool: 'mcp:records:lookup', arguments: { key: { $ref: 'steps.write.output.structuredContent.value' } } },
      ] })
      return tool('ipc-mcp-write', mutation.name, { key: 'ipc-record' })
    }
    if (round === 3) {
      const original = result('ipc-mcp-write')
      workflowId = original.workflowId
      operationId = workflow ? original.recovery.operationId : original.runtime_receipt.source.operationId
      assert.ok(operationId)
      assert.match(request.messages[0].content, /"verificationCapabilityId":"mcp:records:verify"/)
      return waiting ? tool('ipc-mcp-deadline', 'create_wait_deadline', { timeout_ms: 30000 })
        : tool('ipc-mcp-verify', 'verify_mcp_side_effect', { operation_id: operationId })
    }
    if (waiting && round === 4) return control({ decision: 'wait', waitSpec: { reason: '等待原写入结算', signalType: 'runtime', correlationIds: [operationId],
      condition: { eventType: 'mcp.operation.settled' }, deadlineRef: result('ipc-mcp-deadline').result.deadlineRef } })
    if (waiting) {
      assert.equal(round, 5)
      assert.match(request.messages[0].content, /"status":"satisfied"/)
      return control({ decision: 'finish', userMessage: '写入已核验。', completionCheck: { taskId: binding.taskId, requiredActions: ['call:ipc-mcp-write'],
        requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '等待收到原写入结算回执' } })
    }
    const proof = result('ipc-mcp-verify').result
    assert.equal(proof.outcome, 'applied')
    if (workflow && round === 4) return tool('ipc-mcp-resume', 'resume_workflow', { workflow_id: workflowId, verification_receipt_id: proof.id })
    assert.equal(round, workflow ? 5 : 4)
    if (workflow) assert.equal(result('ipc-mcp-resume').steps.read.output.structuredContent.value, 'ipc-record')
    return control({ decision: 'finish', userMessage: '写入已核验。',
      completionCheck: { taskId: binding.taskId, requiredActions: ['call:ipc-mcp-write', ...(workflow ? ['call:ipc-mcp-resume'] : [])], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '已核对原操作' } })
  } }
  const events = [], webContents = {}
  const options = { runtimeOptions: { llm, stepDelayMs: 0, streamDelayMs: 0, contextOrganization: { minGroups: 100 } }, emit: ({ event }) => events.push(event) }
  let host = createBackendRuntimeManager(options)
  const connect = async sessionId => {
    await host.ready
    return host.connect({ workspaceId: 'project:mcp-verification-ipc', workspaceName: 'MCP Verification IPC', projectPath, ...(sessionId ? { sessionId } : {}), webContents })
  }
  try {
    const connection = await connect()
    await host.send({ runtimeId: connection.runtimeId, webContents, frame: { version: 1, kind: 'command', id: 'mcp-ipc-start',
      type: 'chat.message.send', sessionId: connection.sessionId, timestamp: new Date().toISOString(), payload: { clientMessageId: 'ipc-mcp-user',
        autoStart: true, content: [{ type: 'text', text: '写入并核对记录。' }] } } })
    let paused
    if (waiting) {
      for (let attempt = 0; attempt < 4500 && !paused; attempt++) {
        paused = events.find(event => event.type === 'run.state.changed' && ['paused', 'failed'].includes(event.payload.status))?.payload
        if (!paused) await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.equal(paused?.status, 'paused', JSON.stringify(paused?.failure))
      assert.ok(events.some(event => event.type === 'runtime.mcp.updated' && event.payload.pendingOperations?.some(item => item.operationId === operationId)))
      const pending = events.findLast(event => event.type === 'runtime.waits.updated').payload.subscriptions[0]
      assert.deepEqual(pending.spec.correlationIds, [operationId])
      assert.equal(pending.status, 'pending')
      await host.closeAll(); events.length = 0
      fs.writeFileSync(path.join(projectPath, 'operation-records.json'), JSON.stringify({ [operationId]: 'applied' }))
      host = createBackendRuntimeManager(options); await connect(connection.sessionId)
    }
    let terminal
    for (let attempt = 0; attempt < 4500 && !terminal; attempt++) {
      terminal = events.find(event => event.type === 'run.state.changed' && ['completed', 'failed'].includes(event.payload.status))?.payload
      if (!terminal) await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(terminal?.status, 'completed', JSON.stringify(terminal?.failure))
    if (waiting) {
      assert.equal(terminal.runId, paused.runId)
      assert.ok(events.some(event => event.type === 'runtime.waits.updated' && event.payload.subscriptions[0]?.status === 'satisfied'))
    } else assert.ok(events.some(event => event.type === 'runtime.mcp.updated' && event.payload.pendingOperations?.some(item => item.operationId === operationId)))
    await host.closeAll(); events.length = 0
    host = createBackendRuntimeManager(options); await connect(connection.sessionId)
    const restored = events.find(event => event.type === 'runtime.snapshot').payload
    assert.equal(restored.run.runId, terminal.runId)
    assert.equal(restored.run.status, 'completed')
    assert.equal(restored.mcp.unknownCallCount, 0)
    if (workflow) {
      const plan = restored.workflows.items.find(item => item.id === workflowId)
      assert.equal(plan?.status, 'completed')
      assert.equal(plan.continuations[0].callId, 'ipc-mcp-resume')
      assert.ok(plan.nodes.every(node => node.status === 'completed'))
    }
    if (waiting) {
      assert.equal(restored.waits.subscriptions[0].status, 'satisfied')
      const calls = fs.readFileSync(path.join(projectPath, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      assert.equal(calls.filter(call => call.name === 'mutate').length, 1)
      assert.ok(calls.some(call => call.name === 'verify' && call.args.operation_id === operationId))
    } else assert.equal(fs.readFileSync(path.join(projectPath, 'writes.txt'), 'utf8'), 'w')
  } finally { await host.closeAll(); await fs.promises.rm(projectPath, { recursive: true, force: true, maxRetries: 6, retryDelay: 80 }) }
})

for (const mode of ['read', 'write', 'workflow']) test(`desktop IPC restores an MCP ${mode} form and submits each response without logging its values`, async () => {
  const write = mode !== 'read'
  const workflow = mode === 'workflow'
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-mcp-input-ipc-'))
  await initializeProject(projectPath)
  fs.writeFileSync(path.join(projectPath, 'control.json'), JSON.stringify(write ? { mode: 'write-form', verification: 'pending', formWrite: 'multi' } : { mode: 'form' }))
  const configPath = path.join(projectPath, '.capybara', 'config.json'), config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  config.context = { ...config.context, context_window_tokens: 22000, max_input_tokens: 19000 }
  config.tool_permissions = write ? ['mcp:records:mutate', 'mcp:records:verify'] : ['mcp:records:lookup']
  if (workflow) config.tool_permissions.push('mcp:records:lookup')
  config.mcp_servers = [{ id: 'records', enabled: true, transport: { type: 'stdio', command: process.execPath,
    args: [path.resolve(__dirname, '../../backend/test/fixtures/mcp-fixture.mjs'), projectPath] },
    tool_policies: write ? { mutate: { permissions: [], sideEffects: 'external', replay: 'never', human_input: 'form', verification_tool: 'verify' },
      verify: { permissions: [], sideEffects: 'none', replay: 'safe' },
      ...(workflow ? { lookup: { permissions: [], sideEffects: 'none', replay: 'safe' } } : {}) } :
    { lookup: { permissions: [], sideEffects: 'none', replay: 'safe', human_input: 'form' } } }]
  fs.writeFileSync(configPath, JSON.stringify(config))
  const webContents = {}, events = []
  let round = 0
  let workflowId
  let receiptId
  const llm = { ...fakeLlm(), async chat(request) {
    const binding = JSON.parse(request.messages[0].content.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)[0])
    const tool = (id, name, args) => ({ provider: 'custom', model: 'test-model', text: '', raw: {}, toolCalls: [{ id, name, arguments: args }] })
    const control = fields => ({ provider: 'custom', model: 'test-model', raw: {}, text: JSON.stringify({ envelopeVersion: 2, binding,
      userMessage: '', actions: [], planProposal: null, candidateDiffs: [], evidenceRequests: [], uncertainties: [], waitSpec: null, completionCheck: null, ...fields }) })
    assert.doesNotMatch(JSON.stringify(request), /private-mcp-token|desktop-fixture-input-value/)
    ++round
    if (round === 1) return tool('load-form', 'load_resources', { ids: config.tool_permissions })
    if (round === 2) {
      const original = request.tools.find(item => item.name.startsWith(write ? 'mcp_records_mutate_' : 'mcp_records_lookup_')).name
      if (!workflow) return tool('ipc-original-form', original, { key: 'report' })
      return tool('ipc-original-form', 'execute_workflow', { version: 1, goal: '确认报告写入并读取回执', steps: [
        { id: 'input', type: 'tool', tool: original, arguments: { key: 'report' } },
        { id: 'tail', type: 'tool', tool: request.tools.find(item => item.name.startsWith('mcp_records_lookup_')).name,
          arguments: { key: { $ref: 'steps.input.output.structuredContent.value' } } },
      ] })
    }
    const observe = id => JSON.parse(request.messages.find(message => message.toolCallId === id).content)
    if (workflow && round === 3) {
      const partial = observe('ipc-original-form')
      assert.equal(partial.status, 'awaiting_input')
      workflowId = partial.workflowId
    }
    if (workflow && round === 7) {
      receiptId = observe('ipc-resume-form-6').runtime_receipt.resultArtifactId
      return tool('ipc-resume-graph', 'resume_workflow', { workflow_id: workflowId, input_receipt_id: receiptId })
    }
    if (workflow && round === 8) {
      assert.equal(observe('ipc-resume-graph').steps.tail.output.structuredContent.value, 'write-receipt')
    }
    if (round === (workflow ? 8 : 7)) return control({ decision: 'finish', userMessage: '收到报告回执。', completionCheck: {
      taskId: binding.taskId, requiredActions: ['call:ipc-original-form', ...(workflow ? ['call:ipc-resume-graph'] : [])],
      requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '具有原调用结果' } })
    const id = events.findLast(event => event.type === 'runtime.mcp.updated' && event.payload.inputRequests?.length).payload.inputRequests[0].id
    if (round === 3 || round === 5) return control({ decision: 'wait', waitSpec: { reason: '等待报告输入', signalType: 'runtime',
      correlationIds: [id], condition: { eventType: 'mcp.input.responded' }, deadlineRef: null } })
    return tool(`ipc-resume-form-${round}`, write ? 'resume_mcp_write_input' : 'resume_mcp_input', { request_id: id })
  } }
  const options = { runtimeOptions: { llm, stepDelayMs: 0, streamDelayMs: 0, contextOrganization: { minGroups: 100 } }, emit: ({ event }) => events.push(event) }
  let host = createBackendRuntimeManager(options), connection, seq = 0
  const connect = async sessionId => {
    await host.ready
    return host.connect({ workspaceId: 'project:mcp-input-ipc', workspaceName: 'MCP Input IPC', projectPath, ...(sessionId ? { sessionId } : {}), webContents })
  }
  const send = (type, payload) => host.send({ runtimeId: connection.runtimeId, webContents, frame: { version: 1, kind: 'command',
    id: `form-command-${++seq}`, type, sessionId: connection.sessionId, timestamp: new Date().toISOString(), payload } })
  const waitFor = async (status, since = 0) => {
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      const run = events.slice(since).find(event => event.type === 'run.state.changed' && [status, 'failed'].includes(event.payload.status))?.payload
      if (run) { assert.equal(run.status, status, JSON.stringify(run.failure)); return run }
      await new Promise(resolve => setTimeout(resolve, 15))
    }
    assert.fail(`MCP input IPC did not reach ${status}`)
  }
  try {
    connection = await connect()
    await send('chat.message.send', { clientMessageId: 'form-ipc-user', autoStart: true, content: [{ type: 'text', text: '请取得报告。' }] })
    const original = await waitFor('paused')
    const form = events.findLast(event => event.type === 'runtime.mcp.updated' && event.payload.inputRequests?.length).payload.inputRequests[0]
    assert.equal(form.serverId, 'records')
    assert.equal(Boolean(form.operationId), write)
    if (workflow) assert.ok(form.workflow?.id === workflowId && form.workflow.nodeId)
    assert.equal(form.forms[0].fields[0].label, 'Report identifier')
    await host.closeAll(); events.length = 0
    host = createBackendRuntimeManager(options); connection = await connect(connection.sessionId)
    const restored = events.find(event => event.type === 'runtime.snapshot').payload
    assert.equal(restored.mcp.inputRequests[0].id, form.id)
    if (workflow) assert.equal(restored.workflows.items.find(item => item.id === workflowId)?.status, 'suspended')
    const start = events.length
    assert.equal((await send('runtime.mcp.input.reply', { requestId: form.id, responses: { report: { action: 'accept', content: { identifier: 'desktop-fixture-input-value' } } } })).accepted, true)
    await waitFor('paused', start)
    const next = events.findLast(event => event.type === 'runtime.mcp.updated' && event.payload.inputRequests?.length).payload.inputRequests[0]
    assert.equal(next.round, 2)
    if (workflow) assert.deepEqual(next.workflow, form.workflow)
    const secondReply = write ? { action: 'accept', content: { region: 'desktop-fixture-input-value' } } : { action: 'cancel' }
    assert.equal((await send('runtime.mcp.input.reply', { requestId: next.id, responses: { narrow: secondReply } })).accepted, true)
    assert.equal((await waitFor('completed')).runId, original.runId)
    assert.doesNotMatch(JSON.stringify(events), /private-mcp-token|desktop-fixture-input-value/)
    const rpcs = fs.readFileSync(path.join(projectPath, 'form-rpc.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(rpcs[1].answers.narrow.action, write ? 'accept' : 'cancel')
    if (write) {
      assert.ok(rpcs.every(item => item.operationId === form.operationId))
      assert.equal(fs.readFileSync(path.join(projectPath, 'writes.txt'), 'utf8'), 'w')
    }
    if (workflow) {
      const updates = events.filter(event => event.type === 'runtime.workflows.updated')
      const graph = updates.findLast(event => event.payload.items.some(item => item.id === workflowId)).payload.items.find(item => item.id === workflowId)
      assert.equal(graph.status, 'completed')
      assert.equal(graph.continuations[0].inputReceiptId, receiptId)
      assert.ok(graph.nodes.every(node => node.status === 'completed'))
    }
  } finally { await host.closeAll(); await fs.promises.rm(projectPath, { recursive: true, force: true, maxRetries: 6, retryDelay: 80 }) }
})

test('desktop IPC keeps an MCP URL private and resumes the original Workflow only after an explicit reply and service result', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-mcp-url-ipc-'))
  await initializeProject(projectPath)
  const address = 'https://reports.example/connect?state=private-fixture-target'
  fs.writeFileSync(path.join(projectPath, 'control.json'), JSON.stringify({ mode: 'url', url: address, mixed: true, verification: 'pending' }))
  const configPath = path.join(projectPath, '.capybara', 'config.json'), config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  config.context = { ...config.context, context_window_tokens: 23000, max_input_tokens: 20000 }
  config.tool_permissions = ['mcp:reports:mutate', 'mcp:reports:verify', 'mcp:reports:lookup']
  config.mcp_servers = [{ id: 'reports', enabled: true, transport: { type: 'stdio', command: process.execPath,
    args: [path.resolve(__dirname, '../../backend/test/fixtures/mcp-fixture.mjs'), projectPath] }, tool_policies: {
    mutate: { permissions: [], sideEffects: 'external', replay: 'never', human_input: 'form_and_url', verification_tool: 'verify' },
    verify: { permissions: [], sideEffects: 'none', replay: 'safe' }, lookup: { permissions: [], sideEffects: 'none', replay: 'safe' },
  } }]
  fs.writeFileSync(configPath, JSON.stringify(config))
  const events = [], webContents = {}, opened = []
  let round = 0, seq = 0, workflowId, release
  const latest = () => events.findLast(event => event.type === 'runtime.mcp.updated' && event.payload.inputRequests?.length).payload.inputRequests[0]
  const llm = { ...fakeLlm(), async chat(request) {
    assert.doesNotMatch(JSON.stringify(request), /private-fixture-target|private-url-state|local-form-value/)
    const binding = JSON.parse(request.messages[0].content.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)[0])
    const tool = (id, name, args) => ({ provider: 'custom', model: 'test-model', text: '', raw: {}, toolCalls: [{ id, name, arguments: args }] })
    const control = fields => ({ provider: 'custom', model: 'test-model', raw: {}, text: JSON.stringify({ envelopeVersion: 2, binding, userMessage: '',
      actions: [], planProposal: null, candidateDiffs: [], evidenceRequests: [], uncertainties: [], waitSpec: null, completionCheck: null, ...fields }) })
    const observed = id => JSON.parse(request.messages.find(message => message.toolCallId === id).content)
    ++round
    if (round === 1) return tool('url-load', 'load_resources', { ids: config.tool_permissions })
    if (round === 2) return tool('url-workflow', 'execute_workflow', { version: 1, goal: '授权后写入并核对报告', steps: [
      { id: 'external-input', type: 'tool', tool: request.tools.find(item => item.name.startsWith('mcp_reports_mutate_')).name, arguments: { key: 'report' } },
      { id: 'tail', type: 'tool', tool: request.tools.find(item => item.name.startsWith('mcp_reports_lookup_')).name,
        arguments: { key: { $ref: 'steps.external-input.output.structuredContent.value' } } },
    ] })
    if (round === 3) workflowId = observed('url-workflow').workflowId
    if ([3, 5].includes(round)) {
      assert.match(request.messages[0].content, /"hasUrlInput":true/)
      assert.equal(latest().workflow.id, workflowId)
      return control({ decision: 'wait', waitSpec: { reason: '等待用户操作', signalType: 'runtime', correlationIds: [latest().id],
        condition: { eventType: 'mcp.input.responded' }, deadlineRef: null } })
    }
    if ([4, 6].includes(round)) return tool(`url-continue-${round}`, 'resume_mcp_write_input', { request_id: latest().id })
    if (round === 7) return tool('url-resume-workflow', 'resume_workflow', { workflow_id: workflowId,
      input_receipt_id: observed('url-continue-6').runtime_receipt.resultArtifactId })
    assert.equal(observed('url-resume-workflow').steps.tail.output.structuredContent.value, 'url-report-receipt')
    return control({ decision: 'finish', userMessage: '已核对报告回执。', completionCheck: { taskId: binding.taskId,
      requiredActions: ['call:url-workflow', 'call:url-resume-workflow'], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '真实报告回执' } })
  } }
  const options = { runtimeOptions: { llm, stepDelayMs: 0, streamDelayMs: 0, contextOrganization: { minGroups: 100 } },
    emit: ({ event }) => events.push(event), openExternalMcpUrl: async url => {
      opened.push(url)
      if (opened.length === 1) throw new Error(url)
      if (opened.length === 2) await new Promise(resolve => { release = resolve })
    } }
  let host = createBackendRuntimeManager(options), connection
  const connect = async sessionId => {
    await host.ready
    return host.connect({ workspaceId: 'project:mcp-url-ipc', workspaceName: 'MCP URL IPC', projectPath, webContents, ...(sessionId ? { sessionId } : {}) })
  }
  const send = (type, payload) => host.send({ runtimeId: connection.runtimeId, webContents, frame: { version: 1, kind: 'command',
    id: `url-command-${++seq}`, type, sessionId: connection.sessionId, timestamp: new Date().toISOString(), payload } })
  const waitFor = async (status, since = 0) => {
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      const run = events.slice(since).find(event => event.type === 'run.state.changed' && [status, 'failed'].includes(event.payload.status))?.payload
      if (run) { assert.equal(run.status, status, JSON.stringify(run.failure)); return run }
      await new Promise(resolve => setTimeout(resolve, 15))
    }
    assert.fail(`MCP URL workflow did not reach ${status}`)
  }
  const reply = (input, response) => send('runtime.mcp.input.reply', { requestId: input.id, responses: { [input.urls[0].id]: response,
    ...(input.forms.length ? { report: { action: 'accept', content: { identifier: 'local-form-value' } } } : {}) } })
  try {
    connection = await connect()
    await send('chat.message.send', { clientMessageId: 'url-ipc-user', autoStart: true, content: [{ type: 'text', text: '核对报告。' }] })
    const original = await waitFor('paused')
    const first = latest()
    const ref = { runtimeId: connection.runtimeId, webContents, requestId: first.id, urlId: first.urls[0].id }
    assert.equal(first.forms.length, 1)
    assert.deepEqual(host.mcpInputUrl(ref), { url: address, host: 'reports.example', message: 'Complete authorization for report 1.' })
    assert.equal(opened.length, 0)
    assert.throws(() => host.mcpInputUrl({ ...ref, webContents: {} }), /runtime connection/)
    const other = await connect()
    assert.throws(() => host.mcpInputUrl({ ...ref, runtimeId: other.runtimeId }), /MCP_URL_REQUEST_UNAVAILABLE/)
    assert.equal((await reply(first, { action: 'accept' })).accepted, false)
    fs.writeFileSync(configPath, JSON.stringify({ ...config, tool_permissions: config.tool_permissions.slice(1) }))
    await assert.rejects(async () => host.mcpInputUrl({ ...ref, open: true }), /MCP_URL_REQUEST_NOT_AUTHORIZED/)
    fs.writeFileSync(configPath, JSON.stringify(config))
    await assert.rejects(host.mcpInputUrl({ ...ref, open: true }), error => error.message === 'MCP_URL_OPEN_FAILED')
    const opening = host.mcpInputUrl({ ...ref, open: true })
    await assert.rejects(host.mcpInputUrl({ ...ref, open: true }), /MCP_URL_OPEN_IN_PROGRESS/)
    release()
    await opening
    assert.deepEqual(await host.mcpInputUrl({ ...ref, open: true }), { opened: true })
    assert.equal(opened.length, 2)
    assert.equal(round, 3)
    assert.equal(latest().status, 'pending')
    assert.equal(fs.existsSync(path.join(projectPath, 'url-rpc.jsonl')), false)
    assert.equal((await reply(first, { action: 'accept', content: { accidental: 'value' } })).accepted, false)
    await host.closeAll(); events.length = 0
    host = createBackendRuntimeManager(options); connection = await connect(connection.sessionId)
    const restored = events.find(event => event.type === 'runtime.snapshot').payload
    assert.deepEqual(restored.mcp.inputRequests[0].urls, [{ ...first.urls[0], opened: true }])
    assert.equal(restored.run.runId, original.runId)
    const since = events.length
    assert.equal((await reply(first, { action: 'accept' })).accepted, true)
    assert.equal((await reply(first, { action: 'accept' })).accepted, false)
    await waitFor('paused', since)
    const next = latest()
    assert.equal(next.round, 2)
    assert.equal(next.operationId, first.operationId)
    assert.equal(fs.existsSync(path.join(projectPath, 'writes.txt')), false)
    await host.mcpInputUrl({ runtimeId: connection.runtimeId, webContents, requestId: next.id, urlId: next.urls[0].id, open: true })
    fs.writeFileSync(path.join(projectPath, 'external-interaction-complete'), 'service completed out-of-band interaction')
    assert.equal((await reply(next, { action: 'accept' })).accepted, true)
    assert.equal((await waitFor('completed')).runId, original.runId)
    assert.equal(fs.readFileSync(path.join(projectPath, 'writes.txt'), 'utf8'), 'w')
    const dispatches = fs.readFileSync(path.join(projectPath, 'url-rpc.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(dispatches.map(({ answers, operationId }) => [answers, operationId]), [
      [{ connect: { action: 'accept' }, report: { action: 'accept', content: { identifier: 'local-form-value' } } }, first.operationId],
      [{ connect: { action: 'accept' } }, first.operationId],
    ])
    assert.doesNotMatch(JSON.stringify({ events, restored }), /private-fixture-target|private-url-state|local-form-value/)
  } finally { release?.(); await host.closeAll(); await fs.promises.rm(projectPath, { recursive: true, force: true, maxRetries: 6, retryDelay: 80 }) }
})

test('desktop IPC recalls project memory, edits the session document tree and restores stable identities', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-recall-ipc-'))
  await initializeProject(projectPath)
  const { ContextDocumentEngine } = await import(pathToFileURL(path.resolve(__dirname, '../../../apps/backend/dist/core/context-document-engine.js')).href)
  const { ContextCommitStore } = await import(pathToFileURL(path.resolve(__dirname, '../../../apps/backend/dist/core/context-commit-store.js')).href)
  const { ProjectResources } = await import(pathToFileURL(path.resolve(__dirname, '../../../apps/backend/dist/core/project-resources.js')).href)
  new ProjectResources(projectPath).saveSettings({ context_organization_version: 4 })
  const engine = ContextDocumentEngine.create({ sessionId: 'project-context', projectId: projectPath, constitutionRevision: 'test' })
  const evidence = engine.addEvidence({ kind: 'message', referenceId: 'ipc-project-source', sessionId: 'producer', observedAt: '2026-11-01T00:00:00Z' })
  const candidate = engine.addCandidate({ source: { actor: 'user', sourceId: 'ipc-project-source', capturedAt: '2026-11-01T00:00:00Z' },
    rawArtifactId: 'ipc-project-source', normalizedContent: '项目锚点：发布前保留审计记录。', evidenceRefs: [evidence.id] })
  const added = engine.apply(engine.propose({ projection: engine.project({ id: 'ipc-add', maxCharacters: 12000 }), candidateId: candidate.id,
    target: { section: 'information' }, operation: 'add_entry', payload: { body: candidate.normalizedContent }, actor: 'system', idempotencyKey: 'ipc-memory' }))
  engine.apply(engine.propose({ projection: engine.project({ id: 'ipc-archive', maxCharacters: 12000, includeStatuses: ['accepted'] }), candidateId: candidate.id,
    target: { section: 'information', entryId: added.changedEntryIds[0] }, operation: 'mark_status', payload: { status: 'archived' }, actor: 'system', idempotencyKey: 'ipc-memory-archive' }))
  const maintenanceSource = engine.addEvidence({ kind: 'message', referenceId: 'ipc-maintenance-source', sessionId: 'producer', observedAt: '2026-11-01T00:00:00Z' })
  const maintenanceCandidate = engine.addCandidate({ source: { actor: 'user', sourceId: maintenanceSource.referenceId, capturedAt: '2026-11-01T00:00:00Z' },
    rawArtifactId: maintenanceSource.referenceId, normalizedContent: '运行前核查维护窗口。', evidenceRefs: [maintenanceSource.id] })
  const maintenance = engine.apply(engine.propose({ projection: engine.project({ id: 'ipc-maintenance', maxCharacters: 12000 }),
    candidateId: maintenanceCandidate.id, target: { section: 'information' }, operation: 'add_entry', payload: { body: maintenanceCandidate.normalizedContent }, actor: 'system', idempotencyKey: 'ipc-active-memory' }))
  assert.equal(maintenance.result, 'applied')
  const store = new ContextCommitStore(projectPath)
  store.seedProject(engine.exportState()); store.close()
  const events = []
  let calls = 0
  let expectedRootIds
  const llm = { ...fakeLlm(), async chat(request) {
    calls += 1
    if (calls === 1) {
      const prompt = request.messages[0].content
      const project = prompt.slice(prompt.indexOf('# Project Context'), prompt.indexOf('# Session Context'))
      const reference = readContextEntries(project).find(item => item.id === maintenance.changedEntryIds[0])
      assert.equal(reference.id, maintenance.changedEntryIds[0])
      assert.equal(reference.evidence[0].id, maintenanceSource.id)
      assert.ok(request.tools.some((tool) => tool.name === 'recall_context'))
      return { provider: 'custom', model: 'test-model', text: '', finishReason: 'tool_calls', raw: {},
        toolCalls: [{ id: 'recall-ipc-tool', name: 'recall_context', arguments: { query: '项目锚点', scope: 'project', limit: 2 } }] }
    }
    if (calls === 2) {
      const observed = JSON.parse(request.messages.find((message) => message.role === 'tool' && message.name === 'recall_context').content)
      assert.match(observed.result.hits[0].body, /审计记录/)
      const system = request.messages[0].content
      const binding = JSON.parse(system.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)[0])
      const context = JSON.parse(system.match(/<!-- capybara:context-binding data=(\{"scope":"session",[^\n]+?\}) -->/)[1])
      const hit = observed.result.hits[0]
      const envelope = { envelopeVersion: 2, binding, decision: 'propose_diff', userMessage: '', actions: [], planProposal: null, evidenceRequests: [], uncertainties: [], waitSpec: null, completionCheck: null,
        candidateDiffs: [{ ...context, candidateId: hit.candidateId, target: { section: 'information', headingPath: ['召回项目资料'] }, operation: 'add_entry', payload: { body: hit.body, evidenceRefs: hit.evidenceRefs }, idempotencyKey: 'ipc-recalled-entry' }] }
      return { provider: 'custom', model: 'test-model', raw: {}, finishReason: 'stop', text: JSON.stringify(envelope) }
    }
    const session = request.messages[0].content.slice(request.messages[0].content.indexOf('# Session Context'))
    const context = JSON.parse(session.match(/<!-- capybara:context-binding data=(\{[^\n]+?\}) -->/)[1])
    const { nodes } = readContextTree(session)
    const binding = JSON.parse(request.messages[0].content.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)[0])
    if (calls <= 7) {
      const candidates = [...session.matchAll(/<!-- capybara:candidate-ref data=(\{[^\n]+?\}) -->/g)].map(match => JSON.parse(match[1]))
      const user = candidates.find((candidate) => candidate.source.actor === 'user')
      assert.ok(user)
      const root = nodes.find((node) => node.kind === 'root')
      const source = nodes.find((node) => node.title === '召回项目资料' || node.title === '归档来源')
      const target = [3, 6, 7].includes(calls) ? root : source
      const operation = [3, 6].includes(calls) ? 'add_heading' : calls === 4 ? 'rename_heading' : calls === 5 ? 'move_node' : 'reorder_children'
      const payload = calls === 3 ? { title: '验收分组' } : calls === 4 ? { title: '归档来源' } : calls === 5 ? { parentNodeId: nodes.find((node) => node.title === '验收分组').id }
        : calls === 6 ? { title: '核验摘要' } : { childIds: [...root.childIds].reverse() }
      return { provider: 'custom', model: 'test-model', raw: {}, finishReason: 'stop', text: JSON.stringify({ envelopeVersion: 2, binding, decision: 'propose_diff', userMessage: '', actions: [], planProposal: null, evidenceRequests: [], uncertainties: [], waitSpec: null, completionCheck: null,
        candidateDiffs: [{ ...context, diffVersion: 2, targetNodeHash: target.hash, target: { section: 'information', nodeId: target.id }, operation, payload: { ...payload, evidenceRefs: user.evidence.map(item => item.id) }, candidateId: user.id, idempotencyKey: `ipc-tree-${calls}` }] }) }
    }
    assert.equal(calls, 8)
    expectedRootIds = nodes.find((node) => node.kind === 'root').childIds
    return { provider: 'custom', model: 'test-model', raw: {}, finishReason: 'stop', text: JSON.stringify({ status: 'completed', content: '已找回项目资料并提交到当前会话。' }) }
  } }
  const options = { runtimeOptions: { llm, contextOrganization: { minGroups: 100 }, stepDelayMs: 0, streamDelayMs: 0 }, emit: ({ event }) => events.push(event) }
  let host = createBackendRuntimeManager(options)
  try {
    await host.ready
    const webContents = {}
    const connection = await host.connect({ workspaceId: 'project:recall-ipc', workspaceName: 'Recall IPC', projectPath, webContents })
    await host.send({ runtimeId: connection.runtimeId, webContents, frame: { version: 1, kind: 'command', id: 'recall-ipc-send', type: 'chat.message.send', sessionId: connection.sessionId,
      timestamp: new Date().toISOString(), payload: { clientMessageId: 'recall-ipc-question', content: [{ type: 'text', text: '找回项目锚点说明。' }], autoStart: true } } })
    const recalled = await waitFor(events, 'runtime.context.v2.memory.recalled')
    await waitFor(events, 'chat.assistant.completed')
    const candidateId = recalled.payload.candidates[0].id
    assert.equal(recalled.payload.hits[0].scope, 'project')
    assert.equal(recalled.payload.candidates[0].status, 'pending')
    const live = events.findLast(event => event.type === 'runtime.context.documents.updated' &&
      JSON.stringify(event.payload.contextDocumentView.list).includes('归档来源'))
    assert.ok(live, 'the open workbench receives the committed tree before reconnecting')
    assert.equal(live.sessionId, connection.sessionId)
    assert.deepEqual(live.payload.contextDocumentView.tree.rootChildren, expectedRootIds)
    assert.equal(live.payload.projectContextDocumentView.meta.id, engine.snapshot().id)
    assert.equal(events.filter(event => event.type === 'runtime.snapshot').length, 1)
    await host.closeAll(); events.length = 0
    // A newer directory snapshot is recovery material, not committed knowledge.
    const { SessionStore } = await import(pathToFileURL(path.resolve(__dirname, '../../../apps/backend/dist/core/session-store.js')).href)
    const directory = new SessionStore(projectPath)
    try {
      const saved = directory.get(connection.sessionId)
      assert.equal(directory.listTrace(connection.sessionId).some(event => event.type === 'runtime.context.documents.updated'), false)
      const uncommitted = saved.state
      uncommitted.contextDocument.information[0].body = 'UNCOMMITTED_SESSION_SNAPSHOT'
      uncommitted.contextDocument.revision += 100
      uncommitted.projectContextDocument.information[0].body = 'UNCOMMITTED_PROJECT_SNAPSHOT'
      uncommitted.projectContextDocument.revision += 100
      directory.save(connection.sessionId, uncommitted, saved.session.requestCount)
    } finally { directory.close() }
    host = createBackendRuntimeManager(options); await host.ready
    await host.connect({ workspaceId: 'project:recall-ipc', workspaceName: 'Recall IPC', projectPath, sessionId: connection.sessionId, webContents })
    const snapshot = events.find((event) => event.type === 'runtime.snapshot').payload
    const variables = snapshot.contextOrganization.variables
    const project = variables.find((variable) => variable.name === 'project_context')
    const session = variables.find((variable) => variable.name === 'session_context')
    assert.equal(project.scope, 'project'); assert.equal(session.scope, 'session')
    assert.notEqual(project.value.meta.id, session.value.meta.id)
    assert.equal(project.value.information[0].status, 'archived')
    assert.ok(!JSON.stringify(project.value.information).includes('UNCOMMITTED_PROJECT_SNAPSHOT'))
    assert.ok(!JSON.stringify(session.value.information).includes('UNCOMMITTED_SESSION_SNAPSHOT'))
    assert.ok(session.value.candidates.some((item) => item.id === candidateId && item.status === 'accepted'))
    assert.equal(session.value.information.length, 1)
    const checkList = (list) => { assert.ok(Array.isArray(list)); for (const item of list) { if (Array.isArray(item)) checkList(item); else assert.equal(typeof item, 'string') } }
    checkList(project.value.list); checkList(session.value.list)
    assert.ok(JSON.stringify(session.value.list).includes('审计记录'))
    assert.deepEqual(session.value.tree.rootChildren, expectedRootIds)
    assert.deepEqual(session.value.list[1], ['## 核验摘要'])
    assert.equal(session.value.list[2][0], '## 验收分组')
    assert.equal(session.value.list[2][1][0], '### 归档来源')
    assert.equal(session.value.nodeIdsByPath['/1'], expectedRootIds[0])
    assert.equal(session.value.nodeIdsByPath['/2'], expectedRootIds[1])
    assert.ok(snapshot.contextDocumentView.tree)
    events.length = 0
    const second = await host.connect({ workspaceId: 'project:recall-ipc', workspaceName: 'Recall IPC', projectPath, webContents: {} })
    const next = events.find(event => event.type === 'runtime.snapshot').payload
    assert.notEqual(second.sessionId, connection.sessionId)
    assert.deepEqual(next.projectContextDocumentView.list, snapshot.projectContextDocumentView.list)
    assert.equal(next.projectContextDocumentView.meta.id, snapshot.projectContextDocumentView.meta.id)
    assert.notEqual(next.contextDocumentView.meta.id, snapshot.contextDocumentView.meta.id)
    assert.deepEqual(next.contextDocumentView.list, ['# session_context', '暂无正式信息条目'])
    assert.equal(calls, 8)
  } finally { await host.closeAll(); fs.rmSync(projectPath, { recursive: true, force: true }) }
})
