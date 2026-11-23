import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ContextDocumentEngine } from '#core/context-document-engine'
import { ContextHistory } from '#core/context-history'
import { ContextCommitStore, type ContextCommit } from '#core/context-commit-store'
import { organizeContext } from '#core/context-organizer'
import { DatabaseSync } from 'node:sqlite'
import type { LlmChatRequest, LlmChatResponse } from '#util/llm'

function fixture(text = '来源 A：订单 1024 金额 125 美元；来源 B：金额 120 美元；两方均保留。') {
  const history = new ContextHistory()
  history.append({ id: 'user-1', origin: 'user', message: { role: 'user', content: '核对退款，保留来源。' } })
  history.append({ id: 'assistant-1', origin: 'model', message: { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'read_order', arguments: {} }] } })
  history.append({ id: 'tool-1', origin: 'tool', message: { role: 'tool', toolCallId: 'call-1', name: 'read_order', content: text }, rawContent: text })
  const project = ContextDocumentEngine.create({ sessionId: 'project-context', projectId: 'project-1', constitutionRevision: 'test' })
  const session = ContextDocumentEngine.create({ sessionId: 'session-1', projectId: 'project-1', constitutionRevision: 'test' })
  return { history, project, session }
}

function dispositionFiles(padding = 19, includeUnwitnessed = false, prefix = '') {
  const { project, session } = fixture()
  const history = new ContextHistory()
  const sources = [{ file: 'guidance.txt', fact: 'A 记录：手续完成后才接受 37 件。' },
    { file: 'handoff.txt', fact: 'B 记录：验收尚未结束，不得退回 12 件。' }]
  if (includeUnwitnessed) sources.push({ file: 'old.txt', fact: '器具展陈活动的旧记录。' })
  history.append({ id: 'instruction', origin: 'user', message: { role: 'user', content: '检查两份规定的数量及适用条件。' } })
  history.append({ id: `${prefix}read-batch`, origin: 'model', message: { role: 'assistant', content: '', toolCalls: sources.map(source => ({
    id: `${prefix}${source.file}`, name: 'read_file', arguments: { file_name: `${prefix}${source.file}` },
  })) } })
  for (const source of sources) {
    const lines = [...Array.from({ length: padding }, (_, i) => `器具展陈活动第 ${i + 1} 条记录。`), source.fact]
      .map((text, i) => ({ text, line: i + 1 }))
    const file = `${prefix}${source.file}`
    const raw = JSON.stringify({ ok: true, result: { path: file, start_line: 1, end_line: lines.length, lines,
      content: lines.map(line => line.text).join('\n') } })
    history.append({ id: file, sourceArtifactId: `artifact-${file}`, rawContent: raw, origin: 'tool',
      message: { role: 'tool', name: 'read_file', toolCallId: file, content: raw } })
  }
  return { history, project, session, facts: sources.slice(0, 2).map(source => source.fact) }
}

function dispositionResponse(request: LlmChatRequest, keepUncertain = false) {
  const input = JSON.parse(request.messages[1]!.content)
  assert.equal(input.organizationVersion, 4)
  assert.equal(input.documents, undefined)
  assert.ok(input.sources.length <= 32)
  const choices = input.sources.map(({ text }: { text: string }) => text.includes('器具展陈') ? 'A'
    : keepUncertain && text.startsWith('B 记录') ? 'R' : 'K')
  return { provider: 'custom' as const, model: 'file-model', raw: {}, text: JSON.stringify({ batch: input.batch, choices, heading: '规定对照' }) }
}

test('complete file dispositions can fold a tool group processed across multiple packets', async () => {
  const { history, project, session, facts } = dispositionFiles()
  for (const retainAll of [false, true]) {
    const result = await organizeContext({ version: 4, history: history.snapshot(), project: project.exportState(),
      session: session.exportState(), runtimeState: {}, originalSystemPrompt: '按主题排版', projectGate: () => undefined,
      chat: async request => {
        const response = dispositionResponse(request)
        if (!retainAll) return response
        const value = JSON.parse(response.text)
        return { ...response, text: JSON.stringify({ ...value, choices: value.choices.map(() => 'K') }) }
      },
    })
    assert.ok(result)
    assert.equal(result.requests.length, 2)
    const bodies = result.session.document.information.map(entry => entry.body)
    assert.ok(facts.every(fact => bodies.includes(fact)))
    assert.equal(bodies.length, retainAll ? 40 : 2)
    assert.equal(result.history.coverage.coveredThrough, 4)
    assert.equal(result.archives.filter(archive => archive.reason.includes('无关')).flatMap(archive => archive.sourceSpans ?? []).length,
      retainAll ? 0 : 38)
    assert.equal(new ContextHistory(result.history).project().filter(message => message.role === 'tool').length, 0)
  }
})

test('V4 retains verified page groups while organizing independent tool evidence', async () => {
  const { history, project, session } = fixture('账本记录显示退款仍待处理。')
  history.append({ id: 'page-header', origin: 'model', message: { role: 'assistant', content: '',
    toolCalls: [{ id: 'page-call', name: 'read_runtime_artifact', arguments: {} }] } })
  const page = { role: 'tool' as const, name: 'read_runtime_artifact', toolCallId: 'page-call', content: '此处为已核验的文件页。' }
  history.append({ id: 'derived-page', origin: 'tool', message: page })
  const result = await organizeContext({ version: 4, history: history.snapshot(), project: project.exportState(), session: session.exportState(),
    runtimeState: {}, originalSystemPrompt: '按来源整理', retainedObservationIds: new Set(['derived-page']), projectGate: () => undefined,
    chat: async request => {
      const packet = JSON.parse(request.messages.at(-1)!.content)
      assert.equal(packet.organizationVersion, 3)
      assert.ok(packet.sources.some((source: { text: string }) => source.text === '账本记录显示退款仍待处理。'))
      assert.doesNotMatch(request.messages.at(-1)!.content, /已核验的文件页/)
      return { provider: 'custom', model: 'general', raw: {}, text: JSON.stringify({ batch: packet.batch,
        observations: [{ sources: [1] }], edits: [{ observation: 1, operation: 'add_entry', scope: 'session', headingPath: ['账本'] }],
        archives: [], fold: true, uncertainties: [] }) }
    } })
  assert.ok(result?.coverageAdvanced)
  assert.equal(result.session.document.information[0]?.body, '账本记录显示退款仍待处理。')
  assert.ok(result.history.coverage.retainedMessageIds.includes('derived-page'))
  assert.deepEqual(new ContextHistory(result.history).project().slice(-2), history.project().slice(-2))
  assert.ok(!result.archives.some(archive => archive.sourceMessageIds.includes('derived-page')))
})

test('V4 keeps repair and planning metadata outside the organizer input and preserves its originals', async () => {
  const { history, project, session } = dispositionFiles(0)
  const repair = '按当前活跃分支重新提交请求。'
  history.append({ id: 'repair', origin: 'runtime', message: { role: 'user', name: 'capybara_output_repair', content: repair } })
  history.append({ id: 'planning-call', origin: 'model', message: { role: 'assistant', content: '',
    toolCalls: [{ id: 'request-plan', name: 'request_planning', arguments: { reason: '核对阶段' } }] } })
  history.append({ id: 'planning-receipt', origin: 'tool', message: { role: 'tool', toolCallId: 'request-plan', name: 'request_planning',
    content: '{"ok":true,"result":{"planningRequired":true}}' } })
  const result = await organizeContext({ version: 4, history: history.snapshot(), project: project.exportState(),
    session: session.exportState(), runtimeState: {}, originalSystemPrompt: '按主题排版', projectGate: () => undefined,
    chat: async request => {
      assert.doesNotMatch(request.messages[1]!.content, /重新提交请求|planningRequired/)
      return dispositionResponse(request)
    },
  })
  assert.ok(result)
  assert.equal(result.history.messages.find(item => item.id === 'repair')?.message.content, repair)
  assert.ok(result.history.messages.some(item => item.id === 'planning-receipt'))
})

test('file disposition packet omission rejects the transaction even after an earlier packet accepted', async () => {
  const { history, project, session } = dispositionFiles()
  let calls = 0
  await assert.rejects(organizeContext({ version: 4, history: history.snapshot(), project: project.exportState(),
    session: session.exportState(), runtimeState: {}, originalSystemPrompt: '按主题排版', projectGate: () => undefined,
    chat: async request => {
      const response = dispositionResponse(request)
      if (JSON.parse(request.messages[1]!.content).task.archiveReview) return response
      if (++calls === 1) return response
      const value = JSON.parse(response.text)
      value.choices.pop()
      return { ...response, text: JSON.stringify(value) }
    },
  }), /CONTEXT_ORGANIZATION_DISPOSITION_SCHEMA/)
  assert.equal(calls, 2)
  assert.deepEqual(session.snapshot().information, [])
  assert.equal(history.coverageSnapshot().coveredThrough, 0)
})

test('retained file fragments keep their tool group and an exact repeat reuses the existing body', async () => {
  const { history, project, session, facts } = dispositionFiles(3)
  const base = { version: 4 as const, history: history.snapshot(), project: project.exportState(),
    runtimeState: {}, originalSystemPrompt: '按主题排版', projectGate: () => undefined }
  const partial = await organizeContext({ ...base, session: session.exportState(), chat: async request => dispositionResponse(request, true) })
  assert.ok(partial)
  assert.equal(partial.history.coverage.coveredThrough, 0)
  assert.deepEqual(partial.session.document.information.map(entry => entry.body), facts.slice(0, 1))
  assert.equal(new ContextHistory(partial.history).project().filter(message => message.role === 'tool').length, 2)
  const retry = await organizeContext({ ...base, session: partial.session, chat: async request => dispositionResponse(request) })
  assert.ok(retry)
  assert.equal(retry.history.coverage.coveredThrough, 4)
  assert.deepEqual(retry.session.document.information.map(entry => entry.body), facts)
  assert.ok(retry.requests.some(packet => packet.output.diffProposals.some(edit => edit.operation === 'append_evidence')))
})

test('file-only archive disagreement preserves the original and a completely archived group remains visible', async () => {
  const { history, project, session } = dispositionFiles(3)
  const base = { version: 4 as const, history: history.snapshot(), project: project.exportState(), session: session.exportState(),
    runtimeState: {}, originalSystemPrompt: '按主题排版', projectGate: () => undefined }
  for (const recover of [false, true]) {
    const result = await organizeContext({ ...base, chat: async request => {
      const input = JSON.parse(request.messages[1]!.content)
      const response = dispositionResponse(request)
      if (recover && input.task.archiveReview) return response
      const value = JSON.parse(response.text)
      value.choices = value.choices.map(() => 'A')
      return { ...response, text: JSON.stringify(value) }
    } })
    assert.ok(result)
    assert.ok(result.requests.some(record => JSON.parse(record.input.messages[1]!.content).task.archiveReview))
    assert.equal(result.history.coverage.coveredThrough, 0)
    assert.deepEqual(result.session.document.information, [])
    assert.equal(new ContextHistory(result.history).project().filter(message => message.role === 'tool').length, 2)
    assert.equal(result.requests.some(record => record.supervisionEligible === false), recover)
  }
})

test('whole reads archive only agreed spans when two sibling files have active witnesses', async () => {
  const { history, project, session, facts } = dispositionFiles(3, true)
  for (const secondWitness of [true, false]) {
    const result = await organizeContext({ version: 4, history: history.snapshot(), project: project.exportState(), session: session.exportState(),
      runtimeState: {}, originalSystemPrompt: '按主题排版', projectGate: () => undefined, separateFileDispositions: true,
      fileDispositionBatch: { max_spans: 12, max_characters: 16000 }, chat: async request => {
        const response = dispositionResponse(request, !secondWitness)
        const input = JSON.parse(request.messages[1]!.content)
        const value = JSON.parse(response.text)
        if (input.task.archiveReview) value.choices[1] = 'R'
        return { ...response, text: JSON.stringify(value) }
      } })
    assert.ok(result)
    const original = history.snapshot().messages.find(message => message.id === 'old.txt')!
    const archived = result.archives.flatMap(archive => archive.sourceSpans ?? []).filter(span => span.messageId === original.id)
    assert.deepEqual(archived.map(span => original.rawContent!.slice(span.start, span.end)), secondWitness ? [
      '器具展陈活动第 1 条记录。', '器具展陈活动第 3 条记录。', '器具展陈活动的旧记录。',
    ] : [])
    assert.deepEqual(result.session.document.information.map(entry => entry.body), secondWitness ? facts : facts.slice(0, 1))
    assert.equal(result.history.coverage.coveredThrough, 0)
    const proof = result.history.coverage.partialFileGroups?.[0]?.files.find(file => file.messageId === original.id)
    assert.equal(proof?.spans.length, secondWitness ? 3 : undefined)
    const review = result.requests.find(record => JSON.parse(record.input.messages[1]!.content).task.archiveReview)
    assert.equal(review?.output.archiveProposals.length, secondWitness ? 1 : 0)
    assert.equal(review?.supervisionEligible, secondWitness ? undefined : false)
  }
})

test('split file windows archive only agreeing interior spans from a read with an active witness', async () => {
  const { history, project, session, facts } = dispositionFiles(7, true)
  const calls: Array<{ review: boolean; file: string; lines: number[] }> = []
  const prefixScopes: string[] = []
  let corruptReview = false
  const options = { version: 4 as const, history: history.snapshot(), project: project.exportState(), session: session.exportState(),
    runtimeState: {}, originalSystemPrompt: '按主题排版', projectGate: () => undefined, separateFileDispositions: true,
    fileDispositionBatch: { max_spans: 4, max_characters: 16000 },
    chat: async (request: LlmChatRequest) => {
      const input = JSON.parse(request.messages[1]!.content)
      const sources: Array<{ file: string; line: number }> = input.sources
      const file = sources[0]!.file
      const review = input.task.archiveReview === true
      assert.equal(input.task.archiveReviewScope, review ? 'window' : undefined)
      prefixScopes.push(input.task.prefixCacheScope)
      assert.ok(sources.every(source => source.file === file))
      calls.push({ review, file, lines: sources.map(source => source.line) })
      const response = dispositionResponse(request)
      const value = JSON.parse(response.text)
      if (file === 'guidance.txt' && sources[0]!.line === 1) value.choices[review ? 2 : 1] = 'R'
      if (corruptReview && review) value.batch = 'wrong-batch'
      return { ...response, text: JSON.stringify(value) }
    },
  }
  const result = await organizeContext(options)
  assert.ok(result)
  const firstPass = ['guidance.txt', 'handoff.txt', 'old.txt'].flatMap(file => [
    { review: false, file, lines: [1, 2, 3, 4] }, { review: false, file, lines: [5, 6, 7, 8] },
  ])
  assert.deepEqual(calls, [...firstPass, ...firstPass.slice(0, 4).map(call => ({ ...call, review: true }))])
  assert.equal(result.id, prefixScopes[0])
  assert.deepEqual(prefixScopes, Array(10).fill(result.id))
  assert.deepEqual(result.requests.map(record => JSON.parse(record.input.messages[1]!.content).task.archiveReview === true),
    calls.map(call => call.review))
  assert.deepEqual(result.session.document.information.map(entry => entry.body), facts)
  assert.equal(result.history.coverage.coveredThrough, 0)
  const group = result.history.coverage.partialFileGroups?.[0]
  assert.ok(group)
  const archivedLines = group.files.map(file => {
    const source = options.history.messages.find(message => message.id === file.messageId)!
    return file.spans.filter(span => 'archiveReceiptId' in span).map(span => {
      const text = source.rawContent!.slice(span.start, span.end)
      return Number(/第 (\d+) 条/.exec(text)?.[1])
    })
  })
  assert.deepEqual(archivedLines, [[1, 6, 7], [1, 2, 3, 6, 7], []])
  assert.equal(result.archives.flatMap(archive => archive.sourceSpans ?? []).length, 8)
  assert.ok(result.requests.every(record => record.supervisionEligible === false))

  corruptReview = true
  calls.length = 0
  await assert.rejects(organizeContext(options), /CONTEXT_ORGANIZATION_DISPOSITION/)
  assert.deepEqual(calls.slice(0, 6), firstPass)
  assert.equal(calls.length, 7)
  assert.match(prefixScopes[10]!, /^context-commit-[0-9a-f-]{36}$/)
  assert.notEqual(prefixScopes[10], result.id)
  assert.deepEqual(prefixScopes.slice(10), Array(7).fill(prefixScopes[10]))
  assert.deepEqual(session.snapshot().information, [])
  assert.equal(history.coverageSnapshot().coveredThrough, 0)
})

test('a verified file assessment frees space for newer groups without moving the coverage frontier', async () => {
  const { history, project, session } = dispositionFiles(7, true)
  const offered: string[] = []
  const options = { version: 4 as const, history: history.snapshot(), project: project.exportState(), session: session.exportState(),
    runtimeState: {}, originalSystemPrompt: '按主题排版', projectGate: () => undefined, separateFileDispositions: true,
    fileDispositionBatch: { max_spans: 4, max_characters: 16000 }, maxGroups: 2,
    fileAssessment: { profileHash: 'original-profile', verifyGroups: () => new Set<string>() },
    chat: async (request: LlmChatRequest) => {
      const packet = JSON.parse(request.messages[1]!.content)
      offered.push(...packet.sources.map((source: { file: string }) => source.file))
      return dispositionResponse(request)
    },
  }
  const assessed = await organizeContext(options)
  assert.ok(assessed)
  const proof = assessed.history.coverage.partialFileGroups?.[0]
  assert.ok(proof?.assessmentFingerprint)
  assert.equal(assessed.history.coverage.coveredThrough, 0)

  const appended = new ContextHistory(assessed.history)
  for (const message of dispositionFiles(3, false, 'new-').history.snapshot().messages.slice(1)) appended.append(message)
  const next = { ...options, history: appended.snapshot(), project: assessed.project, session: assessed.session,
    fileAssessment: { ...options.fileAssessment, verifyGroups: () => new Set([proof.groupId]) } }
  offered.length = 0
  const reused = await organizeContext(next)
  assert.ok(reused)
  assert.deepEqual([...new Set(offered)], ['new-guidance.txt', 'new-handoff.txt'])
  assert.equal(reused.history.coverage.coveredThrough, 0)
  assert.deepEqual(reused.history.coverage.partialFileGroups?.[0], proof)
  assert.equal(reused.history.coverage.partialFileGroups?.length, 2)
  assert.ok(reused.archives.every(archive => archive.sourceMessageIds.every(id => id.startsWith('new-'))))
  assert.deepEqual(new ContextHistory(reused.history).project(), appended.project())

  const newTask = new ContextHistory(next.history)
  const previousUser = next.history.messages.find(message => message.origin === 'user')!
  newTask.append({ id: 'new-instruction', message: previousUser.message, origin: 'user' })
  for (const invalidated of [
    { ...next, fileTaskInstructions: '先核对待补充证据' },
    { ...next, fileAssessment: { ...next.fileAssessment, profileHash: 'different-profile' } },
    { ...next, fileAssessment: options.fileAssessment },
    { ...next, history: newTask.snapshot(), protectedMessageIds: [previousUser.id] },
  ]) {
    offered.length = 0
    const refreshed = await organizeContext(invalidated)
    assert.ok(refreshed)
    assert.deepEqual([...new Set(offered)], ['guidance.txt', 'handoff.txt', 'old.txt'])
  }
})

test('a dedicated assessment can reach a late file group without advancing coverage over older unresolved history', async () => {
  const { history: files, project, session, facts } = dispositionFiles(0, true)
  const history = new ContextHistory()
  for (let index = 0; index < 4; index++) {
    history.append({ id: `old-${index}`, origin: 'model', message: { role: 'assistant', content: `旧记录 ${index} 仍需复核。` } })
  }
  const commentary = '已加载读取能力，下面在同一轮读取三份附件。'
  for (const message of files.snapshot().messages) {
    history.append(message.id === 'read-batch' ? { ...message, message: { ...message.message, content: commentary } } : message)
  }
  const offered: number[] = []
  const options = { version: 4 as const, history: history.snapshot(), project: project.exportState(), session: session.exportState(),
    runtimeState: {}, originalSystemPrompt: '按主题排版', projectGate: () => undefined, separateFileDispositions: true, maxGroups: 2,
    fileAssessment: { profileHash: 'dedicated', verifyGroups: () => new Set<string>() },
    chat: async (request: LlmChatRequest) => {
      const packet = JSON.parse(request.messages[1]!.content)
      offered.push(packet.organizationVersion)
      if (packet.organizationVersion === 4) return dispositionResponse(request)
      return { provider: 'custom' as const, model: 'fixture', raw: {}, text: JSON.stringify({ batch: packet.batch,
        observations: [], edits: [], archives: [], fold: false, uncertainties: [] }) }
    },
  }
  const assessed = await organizeContext(options)
  assert.ok(assessed)
  const proof = assessed.history.coverage.partialFileGroups?.[0]
  assert.ok(proof?.assessmentFingerprint)
  assert.ok(offered.length > 0 && offered.every(version => version === 4))
  assert.equal(assessed.history.coverage.coveredThrough, 0)
  assert.deepEqual(assessed.history.messages, history.snapshot().messages)
  assert.equal(new ContextHistory(assessed.history).project().find(message => message.toolCalls?.some(call => call.name === 'read_file'))?.content, commentary)
  assert.ok(facts.every(fact => assessed.session.document.information.some(entry => entry.body === fact)))
  assert.ok(assessed.archives.some(archive => archive.sourceMessageIds.includes('old.txt')))

  offered.length = 0
  const next = await organizeContext({ ...options, session: assessed.session, history: assessed.history,
    fileAssessment: { ...options.fileAssessment, verifyGroups: () => new Set([proof.groupId]) } })
  assert.ok(next)
  assert.deepEqual(offered, [3])
  assert.deepEqual(next.history.coverage.partialFileGroups?.[0], proof)

  offered.length = 0
  const mixedWindow = await organizeContext({ ...options, maxGroups: 8 })
  assert.ok(mixedWindow)
  assert.ok(offered.length > 0 && offered.every(version => version === 4))
  assert.equal(mixedWindow.history.coverage.coveredThrough, 0)
  assert.ok(mixedWindow.history.coverage.partialFileGroups?.length)
})

test('a dedicated assessment commits files from a mixed tool group before attempting earlier general organization', async () => {
  const { history: files, project, session, facts } = dispositionFiles(0, true)
  const history = new ContextHistory()
  for (let index = 0; index < 3; index++) {
    history.append({ origin: 'model', message: { role: 'assistant', content: `旧业务记录 ${index} 待核对。` } })
  }
  const childCall = { id: 'child-result', name: 'read_child_result', arguments: { child_id: 'child-1' } }
  const childOutput = '子代理证据：先核对设备注册号。'
  for (const entry of files.snapshot().messages) {
    history.append(entry.id === 'read-batch'
      ? { ...entry, message: { ...entry.message, toolCalls: [...entry.message.toolCalls!, childCall] } } : entry)
  }
  history.append({ origin: 'tool', message: { role: 'tool', toolCallId: childCall.id, name: childCall.name, content: childOutput } })
  const requests: LlmChatRequest[] = []
  const options = { version: 4 as const, history: history.snapshot(), project: project.exportState(), session: session.exportState(),
    runtimeState: {}, originalSystemPrompt: '按主题排版', projectGate: () => undefined, separateFileDispositions: true, maxGroups: 2,
    fileAssessment: { profileHash: 'dedicated', verifyGroups: () => new Set<string>() },
    chat: async (request: LlmChatRequest) => {
      requests.push(request)
      return dispositionResponse(request)
    } }
  const assessed = await organizeContext(options)
  assert.ok(assessed)
  assert.deepEqual(assessed.session.document.information.map(entry => entry.body), facts)
  assert.equal(assessed.history.coverage.coveredThrough, 0)
  assert.deepEqual(new ContextHistory(assessed.history).project(), history.project())
  assert.ok(assessed.archives.some(archive => archive.sourceMessageIds.includes('old.txt')))
  const proof = assessed.history.coverage.partialFileGroups?.[0]
  assert.deepEqual(proof?.files.map(file => file.messageId), ['guidance.txt', 'handoff.txt', 'old.txt'])
  for (const request of requests) assert.ok(!request.messages.at(-1)!.content.includes(childOutput))

  const residual = await organizeContext({ ...options, maxGroups: 8, session: assessed.session, history: assessed.history,
    fileAssessment: { ...options.fileAssessment, verifyGroups: () => new Set([proof!.groupId]) },
    chat: async request => {
      const packet = JSON.parse(request.messages.at(-1)!.content)
      assert.equal(packet.organizationVersion, 3)
      assert.ok(packet.sources.some((source: { text: string }) => source.text === childOutput))
      assert.ok(packet.sources.every((source: { file?: string }) => !source.file))
      return { provider: 'custom', model: 'general', raw: {}, text: JSON.stringify({ batch: packet.batch,
        observations: [], edits: [], archives: [], fold: false, uncertainties: [] }) }
    } })
  assert.ok(residual)
  assert.deepEqual(residual.history.coverage.partialFileGroups, [proof])
  assert.deepEqual(residual.history.messages, assessed.history.messages)

  const covered = await organizeContext({ ...options, maxGroups: 8, session: assessed.session, history: assessed.history,
    fileAssessment: { ...options.fileAssessment, verifyGroups: () => new Set([proof!.groupId]) },
    chat: async request => {
      const packet = JSON.parse(request.messages.at(-1)!.content)
      const visible = packet.sources.filter((source: { protected?: boolean }) => !source.protected)
      assert.ok(visible.some((source: { text: string }) => source.text === childOutput))
      const observations = visible.map((source: { ref: number }) => ({ sources: [source.ref] }))
      const edits = observations.map((_: unknown, index: number) => ({
        observation: index + 1, operation: 'add_entry', scope: 'session', headingPath: ['其余记录'],
      }))
      return { provider: 'custom', model: 'general', raw: {}, text: JSON.stringify({ batch: packet.batch,
        observations, edits, archives: [], fold: true, uncertainties: [] }) }
    } })
  assert.ok(covered?.coverageAdvanced)
  assert.equal(covered.history.coverage.coveredThrough, history.size)
  assert.equal(covered.history.coverage.partialFileGroups?.length ?? 0, 0)
  assert.deepEqual(covered.history.coverage.requiredEntries?.filter(witness => assessed.session.document.information
    .some(entry => entry.id === witness.id)).map(witness => witness.id), assessed.session.document.information.map(entry => entry.id))
  assert.ok(covered.session.document.information.some(entry => entry.body === childOutput))
})

test('a changed task reassesses unresolved file ranges and retains exact durable archives for recall', async () => {
  const { history, project, session, facts } = dispositionFiles(3, true)
  const options = { version: 4 as const, history: history.snapshot(), project: project.exportState(), session: session.exportState(),
    runtimeState: {}, originalSystemPrompt: '按主题排版', projectGate: () => undefined, separateFileDispositions: true,
    fileAssessment: { profileHash: 'same-profile', verifyGroups: () => new Set<string>() } }
  const unresolved = '器具展陈活动第 1 条记录。'
  const initial = await organizeContext({ ...options, chat: async request => {
    const packet = JSON.parse(request.messages[1]!.content)
    const reply = dispositionResponse(request)
    const output = JSON.parse(reply.text)
    output.choices = output.choices.map((choice: string, index: number) => {
      const source = packet.sources[index]
      return source.file === 'guidance.txt' && source.text === unresolved ? 'R' : choice
    })
    return { ...reply, text: JSON.stringify(output) }
  } })
  assert.ok(initial)
  assert.equal(initial.coverageAdvanced, false)
  assert.deepEqual(initial.session.document.information.map(entry => entry.body), facts)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-reuse-archive-'))
  const sessionId = session.snapshot().sessionId
  let store = new ContextCommitStore(root)
  try {
    store.seedProject(project.exportState())
    store.commit({ ...initial, sessionId, expectedProjectRevision: 0, expectedSessionRevision: 0, projectChanged: false,
      receiptIds: [...initial.receipts.map(receipt => receipt.id), ...initial.archives.map(archive => archive.receiptId)] })
    store.close()
    store = new ContextCommitStore(root)
    const original = initial.archives.find(archive => archive.sourceMessageIds.includes('old.txt'))!
    const span = original.sourceSpans![0]!
    assert.equal(store.archivedSpanReceipt(sessionId, span.messageId, span.start, span.end, span.sourceHash), original.receiptId)
    assert.equal(store.archivedSpanReceipt('another-session', span.messageId, span.start, span.end, span.sourceHash), undefined)
    assert.equal(store.archivedSpanReceipt(sessionId, span.messageId, span.start, span.end, '0'.repeat(64)), undefined)

    const resumed = new ContextHistory(initial.history)
    resumed.append({ id: 'reply', origin: 'user', message: { role: 'user', content: '请补查待核对条目并召回旧记录。' } })
    const offered: Array<{ file: string; text: string }> = []
    const updated = await organizeContext({ ...options, history: resumed.snapshot(), project: initial.project, session: initial.session,
      protectedMessageIds: ['instruction'],
      archivedSpanReceipt: span => store.archivedSpanReceipt(sessionId, span.messageId, span.start, span.end, span.sourceHash),
      chat: async request => {
        const packet = JSON.parse(request.messages[1]!.content)
        offered.push(...packet.sources)
        return { provider: 'custom' as const, model: 'file-model', raw: {},
          text: JSON.stringify({ batch: packet.batch, choices: packet.sources.map(() => 'K'), heading: '进一步核对' }) }
      },
    })
    assert.ok(updated)
    assert.deepEqual(offered.map(item => item.text).sort(), [...facts, unresolved].sort())
    assert.deepEqual(updated.session.document.information.map(entry => entry.body).sort(), [...facts, unresolved].sort())
    assert.ok(updated.archives.every(archive => !archive.sourceMessageIds.includes('old.txt')))
    assert.equal(store.searchArchivedSources(sessionId, ['旧记录'], 5)[0]?.archiveId, original.id)
  } finally {
    store.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function organizeResponse(request: LlmChatRequest): LlmChatResponse {
  const input = JSON.parse(request.messages.find((item) => item.role === 'user')!.content)
  const observations: unknown[] = [], diffProposals: unknown[] = [], archiveProposals: Array<{ id: string; sourceRefs: string[]; reason: string }> = []
  for (const [index, source] of input.sources.entries()) {
    if (source.origin === 'tool') {
      const id = `obs-${index}`
      observations.push({ id, sourceRefs: [source.id], normalizedContent: source.text })
      diffProposals.push({ ...input.bindings.session, scope: 'session', sourceObservationId: id, operation: 'add_entry', body: source.text, headingPath: ['退款证据'], idempotencyKey: `${input.snapshotId}:diff:${index}` })
    } else if (source.origin !== 'user') archiveProposals.push({ id: `${input.snapshotId}:archive:${index}`, sourceRefs: [source.id], reason: '执行意图保留在原始轨迹，不作为业务事实' })
  }
  const keys = [...input.previousProposalKeys, ...diffProposals.map((item: any) => item.idempotencyKey), ...archiveProposals.map((item) => item.id)]
  const output = { organizationVersion: 1, snapshotId: input.snapshotId, mode: 'organize', observations, diffProposals, archiveProposals, recallProposals: [],
    coverageProposal: input.canProposeCoverage ? { groupIds: input.coverageGroups.map((group: any) => group.id), proposalKeys: keys, retainedMessageIds: input.retainedMessageIds } : null,
    uncertainties: [] }
  return { provider: 'custom', model: 'organizer-test', text: JSON.stringify(output), raw: {} }
}

test('coverage preserves complete call groups and cannot pass pending tools or the latest user instruction', () => {
  const { history } = fixture()
  assert.equal(history.groups().length, 2)
  assert.equal(history.groups()[1]?.complete, true)
  const proposal = { groupIds: history.groups().map((group) => group.id), proposalKeys: ['p'], retainedMessageIds: ['user-1'] }
  assert.throws(() => history.proposeCoverage({ ...proposal, retainedMessageIds: [] }, 'commit', ['receipt']), /PROTECTED/)
  history.confirmCoverage(history.proposeCoverage(proposal, 'commit', ['receipt']))
  assert.deepEqual(history.project().map((message) => message.role), ['user'])
  assert.equal(history.snapshot().messages.length, 3)
  const pending = new ContextHistory()
  pending.append({ origin: 'model', message: { role: 'assistant', content: '', toolCalls: [{ id: 'pending', name: 'read', arguments: {} }] } })
  assert.throws(() => pending.proposeCoverage({ groupIds: pending.groups().map((group) => group.id), proposalKeys: ['p'], retainedMessageIds: [] }, 'commit', ['receipt']), /COMPLETE_PREFIX/)
})

test('organizer creates evidence-bound document diffs and preserves both conflicting claims', async () => {
  const { history, project, session } = fixture()
  const result = await organizeContext({ history: history.snapshot(), project: project.exportState(), session: session.exportState(), runtimeState: {}, originalSystemPrompt: '客服解题助手', chat: async (request) => organizeResponse(request), projectGate: () => undefined })
  assert.ok(result)
  assert.equal(session.snapshot().information.length, 0, 'original document remains untouched before commit')
  assert.ok(result.session.document.information.some((entry) => entry.body.includes('125') && entry.body.includes('120')))
  assert.ok(result.receipts.every((receipt) => receipt.result === 'applied'))
  assert.equal(new ContextHistory(result.history).project().length, 1)
  assert.equal(result.history.coverage.coveredThrough, 3)
  assert.equal(result.history.messages[2]?.rawContent, history.snapshot().messages[2]?.rawContent)
})

test('organizer uses the caller-provided output budget and a non-truncating default', async () => {
  const run = async (maxOutputTokens?: number) => {
    const { history, project, session } = fixture()
    let observed: number | undefined
    const result = await organizeContext({ history: history.snapshot(), project: project.exportState(), session: session.exportState(), runtimeState: {},
      originalSystemPrompt: '客服解题助手', ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      chat: async request => { observed = request.maxTokens; return organizeResponse(request) }, projectGate: () => undefined })
    assert.ok(result)
    return observed
  }
  assert.equal(await run(), 8192)
  assert.equal(await run(1234), 1234)
})

test('reference drafts resolve a heading edit from visible nodes and attach genuine source evidence', async () => {
  const { history, project, session } = fixture()
  const result = await organizeContext({ version: 2, history: history.snapshot(), project: project.exportState(),
    session: session.exportState(), runtimeState: {}, originalSystemPrompt: '按主题整理。', projectGate: () => undefined,
    chat: async request => {
      const input = JSON.parse(request.messages[1]!.content)
      const root = input.documents.session.nodes.find((node: { kind: string }) => node.kind === 'root')
      const user = input.sources.find((source: { origin: string }) => source.origin === 'user')
      const proposal = { batch: input.batch, observations: [{ sources: [user.ref], text: '把退款资料放在单独章节。' }],
        edits: [{ scope: 'session', operation: 'add_heading', observation: 1, target: root.ref, title: '退款资料' }],
        archives: [], fold: false, uncertainties: [] }
      return { provider: 'custom', model: 'test', text: JSON.stringify(proposal), raw: {} }
    },
  })
  assert.ok(result)
  const request = result.requests[0]!
  const [edit] = request.output.diffProposals
  assert.equal(edit?.diffVersion, 2)
  assert.equal(edit?.targetNodeId, 'information')
  assert.match(edit!.targetNodeHash!, /^[a-f0-9]{64}$/)
  assert.ok(request.operationEvidence.get(edit!.idempotencyKey)?.evidenceRefs.length)
  assert.ok(result.session.document.tree?.headings.some(heading => heading.title === '退款资料'))
  assert.equal(result.history.coverage.coveredThrough, 0)
  assert.ok(request.modelProposal && 'edits' in request.modelProposal)
  assert.equal('targetNodeHash' in request.modelProposal.edits[0]!, false)
})

test('reference drafts reject proposed archives of protected material', async () => {
  const { history, project, session } = fixture()
  await assert.rejects(organizeContext({ version: 2, history: history.snapshot(), project: project.exportState(),
    session: session.exportState(), runtimeState: {}, originalSystemPrompt: '客服解题助手', projectGate: () => undefined,
    chat: async request => {
      const input = JSON.parse(request.messages[1]!.content)
      const user = input.sources.find((source: { protected?: boolean }) => source.protected)
      return { provider: 'custom', model: 'test', raw: {}, text: JSON.stringify({ batch: input.batch,
        observations: [], edits: [], archives: [{ sources: [user.ref], reason: '不保留任务约束' }], fold: true, uncertainties: [] }) }
    },
  }), /ARCHIVE_PROTECTED/)
  assert.equal(history.coverageSnapshot().coveredThrough, 0)
})

test('large raw tool observations are processed in bounded source spans before coverage advances', async () => {
  const { history, project, session } = fixture('订单号 1024，金额 125，保留否定和条件。'.repeat(100))
  let calls = 0
  const result = await organizeContext({ history: history.snapshot(), project: project.exportState(), session: session.exportState(), runtimeState: {}, originalSystemPrompt: '助手', chunkCharacters: 300,
    chat: async (request) => { calls += 1; const input = JSON.parse(request.messages[1]!.content); assert.ok(input.sources.every((source: any) => source.text.length <= 300)); return organizeResponse(request) }, projectGate: () => undefined })
  assert.ok(result)
  assert.ok(calls > 3)
  assert.equal(result.history.coverage.coveredThrough, 3)
  assert.ok(result.requests.slice(0, -1).every((request) => request.output.coverageProposal === null))
})

test('uncovered source material, invented source IDs and stale projection bindings reject the proposal', async () => {
  const { history, project, session } = fixture()
  for (const mutate of [
    (output: any) => { output.observations[0].sourceRefs = ['invented-source'] },
    (output: any) => { output.diffProposals[0].projectionHash = '0'.repeat(64) },
    (output: any) => { output.diffProposals[0].idempotencyKey = 'old-successful-key' },
    (output: any) => { output.observations = []; output.diffProposals = [] },
  ]) {
    await assert.rejects(() => organizeContext({ history: history.snapshot(), project: project.exportState(), session: session.exportState(), runtimeState: {}, originalSystemPrompt: '助手',
      chat: async (request) => { const response = organizeResponse(request); const output = JSON.parse(response.text); mutate(output); return { ...response, text: JSON.stringify(output) } }, projectGate: () => undefined }), /CONTEXT_ORGANIZATION_/)
    assert.equal(history.snapshot().coverage.coveredThrough, 0)
    assert.equal(session.snapshot().information.length, 0)
  }
})

test('valid partial document updates keep the original history when coverage is not proposed', async () => {
  const { history, project, session } = fixture()
  const result = await organizeContext({ history: history.snapshot(), project: project.exportState(), session: session.exportState(), runtimeState: {}, originalSystemPrompt: '助手',
    chat: async (request) => { const response = organizeResponse(request); const output = JSON.parse(response.text); output.coverageProposal = null; return { ...response, text: JSON.stringify(output) } }, projectGate: () => undefined })
  assert.ok(result)
  assert.equal(result.coverageAdvanced, false)
  assert.equal(result.history.coverage.coveredThrough, 0)
  assert.ok(result.session.document.information.some((entry) => entry.body.includes('125')))
  assert.equal(new ContextHistory(result.history).project().length, 3)
})

test('metadata and empty edits cannot fold a source, while evidence for an exact duplicate can', async () => {
  const { history, project, session } = fixture('A 记录退款 125 美元。')
  const base = { version: 2 as const, history: history.snapshot(), project: project.exportState(), runtimeState: {},
    originalSystemPrompt: '保留可核验的退款资料。', projectGate: () => undefined }
  const add = await organizeContext({ ...base, session: session.exportState(), chat: async request => {
    const input = JSON.parse(request.messages[1]!.content)
    const tool = input.sources.find((source: { origin: string }) => source.origin === 'tool')
    return { provider: 'custom', model: 'test', raw: {}, text: JSON.stringify({ batch: input.batch,
      observations: [{ sources: [tool.ref], text: 'A 记录退款 125 美元。' }],
      edits: [{ scope: 'session', operation: 'add_entry', observation: 1, headingPath: ['退款证据'] }],
      archives: [], fold: false, uncertainties: [] }) }
  } })
  assert.ok(add)
  for (const variant of [
    { edit: { operation: 'mark_status', status: 'archived' }, observation: 'B 仍在核对另一份金额。', expectedCoverage: 0 },
    { edit: { operation: 'append_evidence' }, observation: 'B 仍在核对另一份金额。', expectedCoverage: 0 },
    { edit: { operation: 'replace_body', body: '  ' }, observation: 'B 仍在核对另一份金额。', expectedCoverage: 0 },
    { edit: { operation: 'append_evidence' }, observation: 'A 记录退款 125 美元。', expectedCoverage: 3 },
  ]) {
    const next = fixture(variant.observation)
    const result = await organizeContext({ ...base, history: next.history.snapshot(), session: add.session, chat: async request => {
      const input = JSON.parse(request.messages[1]!.content)
      const tool = input.sources.find((source: { origin: string }) => source.origin === 'tool')
      const entry = input.documents.session.nodes.find((node: { kind: string }) => node.kind === 'entry')
      return { provider: 'custom', model: 'test', raw: {}, text: JSON.stringify({ batch: input.batch,
        observations: [{ sources: [tool.ref], text: variant.observation }],
        edits: [{ scope: 'session', observation: 1, target: entry.ref, ...variant.edit }],
        archives: [], fold: true, uncertainties: [] }) }
    } })
    assert.ok(result)
    assert.equal(result.receipts[0]?.result, 'applied')
    assert.equal(result.history.coverage.coveredThrough, variant.expectedCoverage, JSON.stringify(variant.edit))
    assert.equal(result.history.messages[2]?.rawContent, variant.observation)
    assert.equal(new ContextHistory(result.history).project().some(message => message.role === 'tool'), !variant.expectedCoverage)
  }
})

test('automatic coverage archives host metadata and stops before an unhandled complete tool group', async () => {
  const { history, project, session } = fixture()
  history.append({ id: 'assistant-2', origin: 'model', message: { role: 'assistant', content: '', toolCalls: [{ id: 'call-2', name: 'read_order', arguments: {} }] } })
  history.append({ id: 'tool-2', origin: 'tool', message: { role: 'tool', toolCallId: 'call-2', name: 'read_order', content: '后续未处理的来源，条件不可丢失。' } })
  const result = await organizeContext({ history: history.snapshot(), project: project.exportState(), session: session.exportState(),
    runtimeState: {}, originalSystemPrompt: '助手', projectGate: () => undefined, chat: async request => {
      const response = organizeResponse(request)
      const output = JSON.parse(response.text)
      output.observations = output.observations.slice(0, 1)
      output.diffProposals = output.diffProposals.slice(0, 1)
      output.archiveProposals = []
      output.coverageProposal = 'auto'
      return { ...response, text: JSON.stringify(output) }
    } })
  assert.ok(result)
  assert.equal(result.history.coverage.coveredThrough, 3)
  assert.deepEqual(new ContextHistory(result.history).project().map(message => message.role), ['user', 'assistant', 'tool'])
  assert.deepEqual(result.archives.flatMap(archive => archive.sourceMessageIds), ['assistant-1'])
  assert.equal(result.history.messages.length, 5)
})

test('organizer uses actual tree bindings and layout alone cannot cover factual source material', async () => {
  const { history, project, session } = fixture()
  const layoutResponse = (request: LlmChatRequest, cover: boolean): LlmChatResponse => {
    const input = JSON.parse(request.messages[1]!.content)
    const line = request.messages[0]!.content.split('\n').find((value) => value.startsWith(`{"documentId":"${input.bindings.session.documentId}"`))!
    const projection = JSON.parse(line)
    const tree = JSON.parse(projection.markdown.match(/<!-- capybara:tree data=(\{[^\n]+?\}) -->/)[1])
    const root = tree.nodes.find((node: any) => node.kind === 'root')
    const source = input.sources.find((unit: any) => unit.origin === 'tool')
    const key = `${input.snapshotId}:layout`
    const archive = input.sources.filter((unit: any) => unit.origin === 'model').map((unit: any, index: number) => ({ id: `${input.snapshotId}:archive:${index}`, sourceRefs: [unit.id], reason: '轨迹保留原件' }))
    const output = { organizationVersion: 1, snapshotId: input.snapshotId, mode: 'organize', observations: [{ id: 'layout-source', sourceRefs: [source.id], normalizedContent: source.text }],
      diffProposals: [{ ...input.bindings.session, scope: 'session', diffVersion: 2, targetNodeId: root.id, targetNodeHash: root.hash, operation: 'add_heading', title: '退款证据', sourceObservationId: 'layout-source', idempotencyKey: key }],
      archiveProposals: archive, recallProposals: [], uncertainties: [], coverageProposal: cover ? { groupIds: input.coverageGroups.map((group: any) => group.id), proposalKeys: [key, ...archive.map((item: any) => item.id)], retainedMessageIds: input.retainedMessageIds } : null }
    return { provider: 'custom', model: 'test', raw: {}, text: JSON.stringify(output) }
  }
  const options = { history: history.snapshot(), project: project.exportState(), session: session.exportState(), runtimeState: {}, originalSystemPrompt: '退款助手', projectGate: () => undefined }
  const result = await organizeContext({ ...options, chat: async (request) => layoutResponse(request, false) })
  assert.ok(result)
  assert.equal(result.session.document.tree!.headings[0]!.title, '退款证据')
  assert.equal(result.history.coverage.coveredThrough, 0)
  assert.equal(result.session.document.information.length, 0)
  assert.ok(result.receipts[0]!.changedNodeIds!.length)
  await assert.rejects(() => organizeContext({ ...options, chat: async (request) => layoutResponse(request, true) }), /SOURCE_UNCOVERED/)
  await assert.rejects(() => organizeContext({ ...options, chat: async (request) => {
    const response = layoutResponse(request, false), output = JSON.parse(response.text)
    output.diffProposals[0].targetNodeHash = '0'.repeat(64)
    return { ...response, text: JSON.stringify(output) }
  } }), /TREE_NODE_HASH_CONFLICT/)
})

test('document pair, archives, receipts and coverage commit atomically and survive reopening', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-context-commit-'))
  const { history, project, session } = fixture()
  const result = await organizeContext({ history: history.snapshot(), project: project.exportState(), session: session.exportState(), runtimeState: {}, originalSystemPrompt: '助手', chat: async (request) => organizeResponse(request), projectGate: () => undefined })
  assert.ok(result)
  let store = new ContextCommitStore(root)
  try {
    store.seedProject(project.exportState())
    const value: ContextCommit = { ...result, sessionId: 'session-1', expectedProjectRevision: 0, expectedSessionRevision: 0, projectChanged: false,
      receiptIds: [...result.receipts.map((receipt) => receipt.id), ...result.archives.map((archive) => archive.receiptId)] }
    assert.throws(() => store.commit({ ...value, receiptIds: ['fake'] }), /BINDING_INVALID|RECEIPT_MISSING/)
    assert.equal(store.loadDocument('session-1'), undefined)
    assert.equal(store.lastCommit('session-1'), undefined)
    const injector = new DatabaseSync(store.databaseFile)
    injector.exec("CREATE TRIGGER fail_context_session BEFORE INSERT ON context_documents WHEN NEW.scope_id='session:session-1' BEGIN SELECT RAISE(ABORT, 'test session persistence failure'); END")
    const changedProject = structuredClone(value.project)
    changedProject.document.revision += 1
    assert.throws(() => store.commit({ ...value, projectChanged: true, project: changedProject }), /test session persistence failure/)
    assert.equal(store.loadDocument()?.document.revision, 0, 'project write rolls back with the failed session write')
    assert.equal(store.lastCommit('session-1'), undefined)
    assert.equal(store.readMessages('session-1').length, 0)
    injector.exec('DROP TRIGGER fail_context_session')
    injector.close()
    store.commit(value)
    store.commit(value)
    const saved = store.lastCommit('session-1')
    assert.equal(saved?.history.coverage.coveredThrough, 3)
    assert.equal(store.readMessages('session-1').length, 3)
    store.close()
    store = new ContextCommitStore(root)
    assert.deepEqual(store.loadDocument('session-1')?.document.information, result.session.document.information)
    assert.deepEqual(store.lastCommit('session-1')?.history.coverage, result.history.coverage)
    const changed = store.loadDocument()!
    changed.document.revision = 1
    store.saveProject(changed, 0)
    assert.throws(() => store.commit({ ...value, id: 'next-conflict', history: { ...value.history, coverage: { ...value.history.coverage, commitId: 'next-conflict' } } }), /PROJECT_CONTEXT_REVISION_CONFLICT/)
    assert.equal(store.lastCommit('session-1')?.id, value.id)
    const restored = store.restoreSessionCheckpoint('session-1', session.exportState())
    assert.ok(restored.document.revision > result.session.document.revision)
    assert.equal(store.loadCoverage('session-1')?.coveredThrough, 0)
    assert.equal(store.readMessages('session-1').length, 3, 'checkpoint rollback cannot rewrite raw history')
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }) }
})
