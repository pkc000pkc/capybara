import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { initializeProjectDirectory } from '#core/project-initializer'
import { ProjectResources } from '#core/project-resources'
import { ContextCommitStore } from '#core/context-commit-store'
import { ContextDocumentEngine } from '#core/context-document-engine'
import { RuntimeLoop, type RuntimeLlm } from '#core/runtime-loop'
import { toOrganizationTrainableExamples, toTrainableContextExample, validateContextTrainingSample } from '#core/context-training-recorder'
import { SessionStore } from '#core/session-store'
import type { ClientCommand, ControlEnvelopeV2, RuntimeContextMemoryRecallResult } from '#protocol/runtime-protocol'
import type { LlmChatRequest } from '#util/llm'
import { writeChatTokenizerFixture } from './fixtures/chat-tokenizer.ts'

const config: RuntimeLlm['getConfig'] = () => ({ provider: 'custom', protocol: 'responses', model: 'test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 })
function command(type: 'chat.message.send' | 'runtime.snapshot.get' | 'runtime.context.v2.memory.recall', payload: any, sessionId = 'organization-session'): ClientCommand {
  return { version: 1, kind: 'command', type, payload, id: `${type}-${Math.random()}`, sessionId, timestamp: new Date().toISOString() } as ClientCommand
}

for (const rejectReview of [false, true]) {
  test(`the configured file classifier receives file-only packets and archive reviews (${rejectReview ? 'review failure' : 'success'})`, async () => {
    const packets: Array<{ model: string; version: number; review: boolean }> = []
    const payloadHashes: string[] = []
    const server = http.createServer(async (req, res) => {
      try {
        assert.equal(req.url, '/v1/chat/completions')
        assert.equal(Boolean(req.headers.authorization), false)
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk)
        const payload = Buffer.concat(chunks)
        const { model, messages, stream, tools } = JSON.parse(payload.toString('utf8'))
        payloadHashes.push(createHash('sha256').update(payload).digest('hex'))
        assert.equal(stream, false)
        assert.equal(tools, undefined)
        const input = JSON.parse(messages.at(-1).content)
        const review = input.task?.archiveReview === true
        packets.push({ model, version: input.organizationVersion, review })
        assert.equal(input.organizationVersion, 4)
        assert.equal(model, 'local-file-classifier')
        assert.ok(input.sources.every((source: { file?: string }) => source.file))
        if (rejectReview && review) {
          res.writeHead(503).end('classifier temporarily unavailable')
          return
        }
        const proposal = { batch: input.batch, choices: input.sources.map((source: { file: string }) => source.file.endsWith('unrelated.txt') ? 'A' : 'K'), heading: '放行条件' }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ model,
          choices: [{ message: { content: JSON.stringify(proposal) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 42, completion_tokens: 0, total_tokens: 42 } }))
      } catch (error) {
        res.writeHead(500).end(error instanceof Error ? error.message : String(error))
      }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-file-profile-'))
    const sessionId = 'file-profile'
    initializeProjectDirectory(projectDir)
    const resources = new ProjectResources(projectDir)
    const llm = resources.readSettings().llm
    const profiles = ['general-organizer', 'local-file-classifier'].map(id => ({ id, provider: 'custom', model: id,
      protocol: 'chat-completions', base_url: `http://127.0.0.1:${address.port}/v1`, max_retries: 0 }))
    assert.throws(() => resources.resolveSettings({ context_file_disposition_profile: 'unknown' }), /existing LLM profile/)
    resources.saveSettings({ context_organization_version: 4, context_assistant_profile: 'general-organizer',
      context_file_disposition_profile: 'local-file-classifier', llm: { ...llm, profiles: [...llm.profiles, ...profiles] } })
    assert.equal(resources.readSettings().context_file_disposition_profile, 'local-file-classifier')
    assert.equal(resources.resolveSettings({ context_file_disposition_profile: null }).context_file_disposition_profile, undefined)
    resources.close()
    const relevant = `调度稿要求经过东门验证之后才能放行，${'以现场签收、东门验证记录和放行许可的对应关系为据，'.repeat(16)}并保存原单。`
    const supporting = '交接单记录东门结果需由值班员确认。'
    const unrelated = '棋赛通知已发到群里。'
    fs.writeFileSync(path.join(projectDir, 'release.txt'), relevant)
    fs.writeFileSync(path.join(projectDir, 'handoff.txt'), supporting)
    fs.writeFileSync(path.join(projectDir, 'unrelated.txt'), unrelated)
    const requests: LlmChatRequest[] = []
    const actor: RuntimeLlm = { getConfig: config, async chat(request) {
      requests.push(request)
      const toolCalls = requests.length === 1 ? [{ id: 'load', name: 'load_resources', arguments: { ids: ['project-files:read_file'] } }]
        : requests.length === 2 ? [
          { id: 'query', name: 'search_resources', arguments: { query: 'read_file', limit: 1 } },
          ...['release.txt', 'handoff.txt', 'unrelated.txt'].map(file => ({ id: file, name: 'read_file', arguments: { file_name: file } })),
        ] : !rejectReview && requests.length === 3
          ? [{ id: 'reread-release', name: 'read_file', arguments: { file_name: 'release.txt', include_line_numbers: true } }]
          : requests.length === (rejectReview ? 4 : 5)
            ? [{ id: 'followup-catalog', name: 'search_resources', arguments: { query: 'read_file', limit: 1 } }] : []
      return { provider: 'custom', model: 'actor', raw: {}, toolCalls,
        text: toolCalls.length ? '' : '{"status":"completed","content":"已核对放行条件。"}' }
    } }
    const loop = new RuntimeLoop({ projectDir, sessionId, llm: actor, contextOrganization: { minGroups: 1 }, stepDelayMs: 0, streamDelayMs: 0 })
    try {
      const finished = done(loop)
      const send = command('chat.message.send', { autoStart: true, clientMessageId: 'file-profile',
        content: [{ type: 'text', text: '整理放行条件和来源。' }] }, sessionId)
      loop.validate(send); loop.execute(send, 1); await finished
      assert.equal(requests.length, rejectReview ? 3 : 4)
      const expectedPackets = [
        { model: 'local-file-classifier', version: 4, review: false },
        { model: 'local-file-classifier', version: 4, review: true },
      ]
      assert.deepEqual(packets, expectedPackets, 'catalog and load receipts do not need general organization')
      const state = loop.exportState()
      const recorded = state.contextTrainingSamples!.flatMap(sample => sample.organization?.attempts ?? [])
      assert.equal(recorded.length, expectedPackets.length)
      for (const [index, attempt] of recorded.entries()) {
        const proof = attempt.requestEvidence!
        assert.deepEqual(proof.requestedModel, { provider: 'custom', protocol: 'chat-completions', model: 'local-file-classifier' })
        assert.equal(proof.accounting, 'provider_request')
        assert.deepEqual(proof.documentView, { format: 'none' })
        assert.deepEqual(proof.promptBindings.map(binding => binding.role), ['context-organizer'])
        assert.deepEqual(proof.transportAttempts.map(transport => transport.payloadHash), [payloadHashes[index]])
        assert.ok(state.artifacts.some(artifact => artifact.meta.id === proof.artifactId))
        const failed = rejectReview && index === 1
        assert.equal(proof.transportAttempts[0]!.status, failed ? 'failed' : 'returned')
        assert.equal(proof.transportAttempts[0]!.reportedTotalTokens, failed ? null : 42)
        if (failed) assert.equal(proof.response, undefined)
        else assert.ok(state.artifacts.some(artifact => artifact.meta.id === proof.response?.artifactId))
      }
      assert.equal(state.contextDocument!.information.some(entry => entry.body === relevant), !rejectReview)
      const originals = state.contextHistory!.messages.filter(item => item.message.name === 'read_file')
      assert.deepEqual(originals.map(item => JSON.parse(item.rawContent!).result.lines[0].text),
        rejectReview ? [relevant, supporting, unrelated] : [relevant, supporting, unrelated, relevant])
      if (!rejectReview) {
        const repeated = JSON.parse(requests.at(-1)!.messages.find(message => message.toolCallId === 'reread-release')!.content)
        assert.equal(repeated.result.projection, 'verified_repeat')
        assert.equal(repeated.result.priorArtifactId, originals[0]!.sourceArtifactId)
        assert.equal(repeated.runtime_receipt.resultArtifactId, originals[3]!.sourceArtifactId)
        assert.equal(originals[0]!.rawContent, originals[3]!.rawContent)
      }
      const commits = new ContextCommitStore(projectDir)
      try {
        assert.equal(commits.searchArchivedSources(sessionId, ['棋赛通知'], 5).some(hit => hit.text === unrelated), !rejectReview)
        if (rejectReview) assert.equal(requests.at(-1)!.messages.filter(message => message.name === 'read_file').length, 3)
      } finally { commits.close() }
      const followup = done(loop)
      const beforeFollowup = loop.getContextTrainingSamples().filter(sample => sample.task === 'context_organization').length
      const ask = command('chat.message.send', { autoStart: true, clientMessageId: 'file-profile-follow-up',
        content: [{ type: 'text', text: '只用已有资料，再次说明放行条件。' }] }, sessionId)
      loop.validate(ask); loop.execute(ask, 2); await followup
      assert.equal(requests.length, rejectReview ? 5 : 6)
      assert.ok(requests.at(-1)!.messages.some(message => message.role === 'tool' && message.toolCallId === 'followup-catalog'))
      assert.equal(loop.getContextTrainingSamples().filter(sample => sample.task === 'context_organization').length, beforeFollowup)
      assert.deepEqual(packets, expectedPackets, 'a low-pressure control receipt remains visible without retriggering organization')
    } finally {
      await loop.shutdown()
      await new Promise<void>(resolve => server.close(() => resolve()))
      fs.rmSync(projectDir, { recursive: true, force: true })
    }
  })
}

test('a configured classifier preserves a long read and avoids reclassifying verified pages under pressure', async () => {
  const packets: Array<{ file: string; spans: number; review: boolean }> = []
  const models: string[] = []
  const prefixScopes: string[] = []
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const { model, messages } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    models.push(model)
    if (models.length === 1) {
      const resources = new ProjectResources(projectDir)
      try {
        const llm = resources.readSettings().llm
        resources.saveSettings({ llm: { profiles: llm.profiles.map(profile => profile.id === 'long-file-classifier'
          ? { id: profile.id, model: 'new-endpoint-model' } : profile) } })
      } finally { resources.close() }
    }
    const packet = JSON.parse(messages.at(-1).content)
    prefixScopes.push(packet.task.prefixCacheScope)
    const rows: Array<{ file: string; line: number; text: string }> = packet.sources
    packets.push({ file: rows[0]!.file, spans: rows.length, review: packet.task.archiveReview === true })
    const choices = rows.map(row => row.file === 'old.txt' || row.line > 2 ? 'A' : row.line === 2 && row.file === 'a.txt' ? 'R' : row.line === 1 ? 'K' : 'A')
    const proposal = { batch: packet.batch, choices, heading: '交接材料' }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ model,
      choices: [{ message: { content: JSON.stringify(proposal) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 42, completion_tokens: 0, total_tokens: 42 } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-long-file-profile-'))
  const sessionId = 'long-file-profile'
  let loop: RuntimeLoop | undefined
  try {
    initializeProjectDirectory(projectDir)
    const resources = new ProjectResources(projectDir)
    try {
      const llm = resources.readSettings().llm
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      const batch = { max_spans: 64, max_characters: 16_000 }
      const profile = { id: 'long-file-classifier', name: 'Long file classifier', provider: 'custom', model: 'local-file-classifier',
        protocol: 'chat-completions', base_url: `http://127.0.0.1:${address.port}/v1`, max_retries: 0, file_disposition_batch: batch }
      resources.saveSettings({ context_organization_version: 4, context_file_disposition_profile: profile.id,
        context: { context_window_tokens: 39000, max_input_tokens: 30000, reserved_output_tokens: 2048 },
        llm: { ...llm, profiles: [...llm.profiles, profile] } })
      assert.deepEqual(resources.readSettings().llm.profiles.find(item => item.id === profile.id)?.file_disposition_batch, batch)
      const partial = resources.resolveSettings({ llm: { profiles: [...llm.profiles, { id: profile.id, model: 'new-endpoint-model' }] } })
      assert.equal(partial.llm.profiles.find(item => item.id === profile.id)?.file_disposition_batch, undefined)
      assert.throws(() => resources.resolveSettings({ llm: { profiles: [...llm.profiles, { ...profile,
        file_disposition_batch: { ...batch, max_spans: 257 } }] } }), /file_disposition_batch/)
    } finally { resources.close() }
    const a = '文件甲要求复核东门后放行。'
    const b = '文件乙称备用门尚未验收。'
    const unresolved = '现场签收人仍待核对。'
    const before = (file: string, i: number) => `行政便签 ${file}-${i}。`
    const files = {
      'a.txt': [a, unresolved, ...Array.from({ length: 38 }, (_, i) => before('a', i))],
      'b.txt': [b, ...Array.from({ length: 39 }, (_, i) => before('b', i))],
      'old.txt': Array.from({ length: 40 }, (_, i) => before('old', i)),
    }
    for (const [file, lines] of Object.entries(files)) fs.writeFileSync(path.join(projectDir, file), lines.join('\n'))
    const requests: LlmChatRequest[] = []
    const actor: RuntimeLlm = { getConfig: config, async chat(request) {
      requests.push(request)
      if (requests.length === 3) {
        assert.deepEqual(request.tools, [])
        assert.match(request.messages.at(-1)!.content, /File evidence checkpoint.*visible|File evidence checkpoint.*source lines/)
        assert.match(request.messages.at(-1)!.content, /does not establish whether a condition was met, report that as unknown/)
        assert.equal(request.messages.filter(message => message.name === 'read_file').length, 3)
        const match = request.messages[0]!.content.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)
        assert.ok(match)
        const envelope: ControlEnvelopeV2 = { envelopeVersion: 2, binding: JSON.parse(match[0]), decision: 'continue',
          reasoningNextStep: '需要核查用户所需的原件逐字行，补读归档原文件。', userMessage: '', actions: [], planProposal: null,
          candidateDiffs: [], evidenceRequests: [], uncertainties: [], waitSpec: null, completionCheck: null }
        return { provider: 'custom', model: 'actor', raw: {}, text: JSON.stringify(envelope) }
      }
      if (requests.length >= 6 && requests.length <= 8) {
        assert.deepEqual(request.tools, [])
        assert.match(request.messages.at(-1)!.content, requests.length === 7 ? /finish referenced evidence IDs absent/ : /File evidence checkpoint/)
        if (requests.length === 7) assert.equal(request.messages.at(-2)!.content, `${a}\n${b}`)
        const system = request.messages[0]!.content
        assert.ok(system.includes(a) && system.includes(b))
        const binding = JSON.parse(system.split('\n').find(line => line.startsWith('{"sessionId":'))!)
        const envelope: ControlEnvelopeV2 = { envelopeVersion: 2, binding, decision: 'finish',
          userMessage: `${a}\n${b}`, actions: [], planProposal: null, candidateDiffs: [], evidenceRequests: [], uncertainties: [], waitSpec: null,
          completionCheck: { taskId: binding.taskId, requiredActions: [], requiredEvidenceRefs: requests.length === 6 ? ['unregistered-file-evidence'] : [],
            unresolvedUncertaintyIds: [], summary: '核对两份已发布原句' } }
        if (requests.length === 8) Object.assign(envelope, { decision: 'continue', userMessage: '', completionCheck: null,
          reasoningNextStep: '用户要原件 old.txt 的第 40 行，当前须补读该行。' })
        return { provider: 'custom', model: 'actor', raw: {}, text: JSON.stringify(envelope) }
      }
      if (requests.length === 9) {
        assert.ok(request.tools?.some(tool => tool.name === 'read_runtime_artifact'))
        const artifact_id = JSON.parse(request.messages.find(message => message.toolCallId === 'old.txt')!.content).runtime_receipt.resultArtifactId
        return { provider: 'custom', model: 'actor', raw: {}, text: '', toolCalls: [{ id: 'follow-up-original', name: 'read_runtime_artifact',
          arguments: { artifact_id, source_scope: 'session', start_line: 40, end_line: 40 } }] }
      }
      if (requests.length === 10) {
        const result = JSON.parse(request.messages.find(message => message.toolCallId === 'follow-up-original')!.content)
        assert.equal(result.ok, true)
        assert.equal(result.result.lines[0].text, before('old', 39))
      }
      const toolCalls = requests.length === 1 ? [{ id: 'load', name: 'load_resources', arguments: { ids: ['project-files:read_file'] } }]
        : requests.length === 2 ? Object.keys(files).map(file => ({ id: file, name: 'read_file', arguments: { file_name: file } }))
          : requests.length === 4 ? (() => {
            assert.ok(request.tools?.some(tool => tool.name === 'read_runtime_artifact'))
            const artifact_id = JSON.parse(request.messages.find(message => message.toolCallId === 'old.txt')!.content).runtime_receipt.resultArtifactId
            return [
              { id: 'checked-page', name: 'read_runtime_artifact', arguments: { artifact_id, source_scope: 'session', offset: 0, limit: 1500 } },
              { id: 'checked-overlap', name: 'read_runtime_artifact', arguments: { artifact_id, source_scope: 'session', offset: 900, limit: 500 } },
              { id: 'checked-line', name: 'read_runtime_artifact', arguments: { artifact_id, source_scope: 'session', start_line: 3, end_line: 3 } },
              { id: 'bad-page', name: 'read_runtime_artifact', arguments: { artifact_id, start_line: 1, end_line: 33 } },
              { id: 'first-partial-page', name: 'read_runtime_artifact', arguments: { artifact_id, start_line: 1, end_line: 33, allow_partial: true } },
              { id: 'known-recall', name: 'recall_context', arguments: { query: '放行', scope: 'session', source_kind: 'information' } },
              ...Array.from({ length: 23 }, (_, index) => {
                const line = index + 4
                return { id: `checked-line-${line}`, name: 'read_runtime_artifact',
                  arguments: { artifact_id, source_scope: 'session', start_line: line, end_line: line } }
              }),
            ]
          })() : []
      return { provider: 'custom', model: 'actor', raw: {}, toolCalls,
        text: toolCalls.length ? '' : '{"status":"completed","content":"已核对两份资料。"}' }
    } }
    loop = new RuntimeLoop({ projectDir, sessionId, llm: actor, contextOrganization: { minGroups: 1 }, stepDelayMs: 0, streamDelayMs: 0 })
    const finished = done(loop, 20000)
    const send = command('chat.message.send', { autoStart: true, clientMessageId: 'long-file', content: [{ type: 'text', text: '整理两份资料的放行条件。' }] }, sessionId)
    loop.validate(send); loop.execute(send, 1); await finished
    assert.equal(requests.length, 5, 'one checkpoint is enough to resume authorized reads without reclassification')
    const finalHistory = requests.at(-1)!.messages.filter(message => message.role !== 'system')
    const pageFeedback = JSON.parse(finalHistory.find(message => message.toolCallId === 'bad-page')!.content)
    assert.equal(pageFeedback.ok, false)
    assert.match(pageFeedback.error.message, /select a smaller line range.*start_line=1, end_line=32/)
    const partialPage = JSON.parse(finalHistory.find(message => message.toolCallId === 'first-partial-page')!.content)
    assert.equal(partialPage.ok, true)
    assert.equal(partialPage.result.end_line, 32)
    assert.equal(partialPage.result.requested_end_line, 33)
    assert.equal(partialPage.result.next_start_line, 33)
    const knownRecall = JSON.parse(finalHistory.find(message => message.toolCallId === 'known-recall')!.content)
    assert.deepEqual(knownRecall.result.hits.map((hit: { body: string }) => hit.body), [a])
    assert.ok(Math.ceil(JSON.stringify({ messages: finalHistory, tools: [] }).length / 4) > 7500,
      'the projected history crosses the 25% organization threshold')
    assert.deepEqual(packets, [{ file: 'a.txt', spans: 40, review: false }, { file: 'b.txt', spans: 40, review: false },
      { file: 'old.txt', spans: 40, review: false }, { file: 'old.txt', spans: 40, review: true }])
    assert.deepEqual(models, Array(4).fill('local-file-classifier'))
    assert.match(prefixScopes[0]!, /^context-commit-[0-9a-f-]{36}$/)
    assert.deepEqual(prefixScopes, Array(4).fill(prefixScopes[0]))
    assert.deepEqual(loop.exportState().contextDocument!.information.map(info => info.body), [a, b])
    const training = loop.getContextTrainingSamples().flatMap(toOrganizationTrainableExamples)
    assert.equal(training.length, 4)
    for (const [index, example] of training.entries()) {
      const packet = JSON.parse(example.messages.at(-2)!.content)
      const proposal = JSON.parse(example.messages.at(-1)!.content)
      assert.equal(proposal.batch, packet.batch)
      assert.equal(packet.sources.length, 40)
      const expected = index === 0 ? ['K', 'R'] : index === 1 ? ['K'] : []
      assert.deepEqual(proposal.choices, [...expected, ...Array(40 - expected.length).fill('A')])
    }
    const observed = requests.at(-1)!.messages.filter(message => message.name === 'read_file')
    assert.equal(observed.length, 3)
    assert.deepEqual(observed.flatMap(message => JSON.parse(message.content).result.lines), [{ line: 2, text: unresolved }])
    const page = JSON.parse(requests.at(-1)!.messages.find(message => message.toolCallId === 'checked-page')!.content)
    const original = loop.exportState().contextHistory!.messages.find(item => item.message.toolCallId === 'old.txt')!
    assert.equal(page.result.content, original.rawContent!.slice(0, 1500))
    const overlap = JSON.parse(requests.at(-1)!.messages.find(message => message.toolCallId === 'checked-overlap')!.content)
    assert.equal(overlap.result.projection, 'verified_file_page')
    assert.deepEqual(overlap.result.segments, [{ offset: 900, length: 500, fromCallId: 'checked-page' }])
    const exactLine = JSON.parse(requests.at(-1)!.messages.find(message => message.toolCallId === 'checked-line')!.content)
    assert.deepEqual(exactLine.result.lines, [{ line: 3, text: before('old', 2) }])
    const lineArtifactId = exactLine.runtime_receipt.resultArtifactId
    const lineCandidate = loop.exportState().contextDocument!.candidates
      .find(candidate => candidate.rawArtifactId === lineArtifactId)
    assert.equal(lineCandidate?.status, 'pending')
    assert.deepEqual(JSON.parse(lineCandidate!.normalizedContent).result.lines, exactLine.result.lines)
    assert.ok(!requests.at(-1)!.messages[0]!.content.includes(lineCandidate!.normalizedContent),
      'retaining a page candidate does not require reprinting its body in the system projection')
    const commits = new ContextCommitStore(projectDir)
    try {
      assert.ok(commits.searchArchivedSources(sessionId, ['old-39'], 10).some(hit => hit.text === before('old', 39)))
      for (const read of loop.exportState().contextHistory!.messages.filter(item => item.message.name === 'read_file')) {
        assert.equal(commits.readSource(read.sourceArtifactId!, sessionId)?.rawContent, read.rawContent)
      }
    } finally { commits.close() }
    const followUps = ['复核此前两份资料的原句，直接答复。', '补读 old.txt 的第 40 行。']
    for (const [index, question] of followUps.entries()) {
      const followUpDone = done(loop, 20000)
      const followUp = command('chat.message.send', { autoStart: true, clientMessageId: `long-file-${index}`, content: [{ type: 'text', text: question }] }, sessionId)
      loop.validate(followUp); loop.execute(followUp, index + 2); await followUpDone
    }
    assert.equal(requests.length, 10)
    assert.equal(requests.slice(5).filter(request => request.messages.at(-1)!.content.startsWith('File evidence checkpoint')).length, 2)
  } finally {
    await loop?.shutdown()
    await new Promise<void>(resolve => server.close(() => resolve()))
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('settled single reads leave later file observations available to the Organizer', async () => {
  const packets: Array<{ files: string[]; review: boolean }> = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk.toString()
    const { model, messages } = JSON.parse(body)
    const input = JSON.parse(messages.at(-1).content)
    let proposal: object
    if (input.organizationVersion === 4) {
      const files = input.sources.map((source: { file: string }) => source.file)
      packets.push({ files, review: input.task.archiveReview === true })
      proposal = { batch: input.batch, choices: files.map((file: string) => file === 'maintenance.txt' ? 'A' : 'K'), heading: '退款材料' }
    } else proposal = { batch: input.batch, observations: [], edits: [], archives: [], fold: false, uncertainties: [] }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ model,
      choices: [{ message: { content: JSON.stringify(proposal) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 42, completion_tokens: 0, total_tokens: 42 } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-sequential-file-profile-'))
  const sessionId = 'sequential-file-profile'
  let loop: RuntimeLoop | undefined
  try {
    initializeProjectDirectory(projectDir)
    const settings = new ProjectResources(projectDir)
    try {
      const llm = settings.readSettings().llm
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      const profiles = ['general-source-review', 'file-source-review'].map(id => ({ id, provider: 'custom', model: id,
        protocol: 'chat-completions', base_url: `http://127.0.0.1:${address.port}/v1`, max_retries: 0 }))
      settings.saveSettings({ context_organization_version: 4, context_assistant_profile: 'general-source-review',
        context_file_disposition_profile: 'file-source-review', llm: { ...llm, profiles: [...llm.profiles, ...profiles] } })
    } finally { settings.close() }
    const files = ['ledger.txt', 'mail.txt', 'maintenance.txt']
    const rows = ['账本记录 125 美元。', '邮件主张 120 美元。', '巡检登记 J-94，周末调整排班。']
    files.forEach((file, index) => fs.writeFileSync(path.join(projectDir, file), rows[index]!))
    const requests: LlmChatRequest[] = []
    const actor: RuntimeLlm = { getConfig: config, async chat(request) {
      const index = requests.push(request) - 1
      const toolCalls = index === 0 ? [{ id: 'load', name: 'load_resources', arguments: { ids: ['project-files:read_file'] } }]
        : index <= files.length ? [{ id: files[index - 1]!, name: 'read_file', arguments: { file_name: files[index - 1]! } }] : []
      return { provider: 'custom', model: 'actor', raw: {}, toolCalls,
        text: index === 0 ? '' : toolCalls.length ? '继续核对下一份原始附件。' : '{"status":"completed","content":"已读取三份资料。"}' }
    } }
    loop = new RuntimeLoop({ projectDir, sessionId, llm: actor, contextOrganization: { minGroups: 1 }, stepDelayMs: 0, streamDelayMs: 0 })
    const finished = done(loop)
    const send = command('chat.message.send', { autoStart: true, clientMessageId: 'sequential-read',
      content: [{ type: 'text', text: '核对账本和邮件的退款金额，检出与退款无关的维护记录。' }] }, sessionId)
    loop.validate(send); loop.execute(send, 1); await finished
    assert.deepEqual(packets, [{ files: ['ledger.txt'], review: false }, { files: ['mail.txt'], review: false },
      { files: ['maintenance.txt'], review: false }, { files: ['maintenance.txt'], review: true }])
    const state = loop.exportState()
    assert.deepEqual(state.contextDocument!.information.filter(entry => entry.status === 'active').map(entry => entry.body), rows.slice(0, 2))
    assert.ok(state.contextHistory!.coverage.partialFileGroups?.every(group => group.files.length === 1))
    assert.ok(requests.at(-1)!.messages.find(message => message.name === 'read_file' && message.toolCallId === 'maintenance.txt')?.content.includes(rows[2]!))
    const commits = new ContextCommitStore(projectDir)
    try { assert.ok(commits.searchArchivedSources(sessionId, ['J-94'], 5).some(hit => hit.text === rows[2])) }
    finally { commits.close() }
  } finally {
    await loop?.shutdown()
    await new Promise<void>(resolve => server.close(() => resolve()))
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

for (const variant of ['confirmed', 'vetoed', 'split-original', 'single-witness'] as const) {
  test(`file archives across organizer batches are gated by complete original reads (${variant})`, async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-organizer-file-batches-'))
    initializeProjectDirectory(projectDir)
    const sessionId = `file-batches-${variant}`
    new ProjectResources(projectDir).saveSettings({ context_organization_version: 4 })
    const primary = '调度稿 A：只在东门验证后才可在 18:15 放行。'
    const secondary = '交接单 B：备用门尚未验收，建议等到 21:30。'
    const files = {
      'primary.txt': [primary, '无关的食堂菜单改到周一。', '无关的花瓶已经入库。',
        ...(variant === 'split-original' ? Array.from({ length: 6 }, (_, i) => `无关便签 ${i + 1} 已经夹在值班夹中。`) : [])],
      'secondary.txt': [secondary, '无关的纸杯已经补齐。', '无关的读书会改为周日。'],
      'unrelated.txt': ['无关的棋赛通知已印刷。', '无关的画册发给图书室。'],
    }
    for (const [file, lines] of Object.entries(files)) fs.writeFileSync(path.join(projectDir, file), lines.join('\n'))
    const requests: LlmChatRequest[] = []
    const filePacks: string[][] = [], reviews: string[][] = []
    const actor: RuntimeLlm = { getConfig: config, async chat(request) {
      requests.push(request)
      const toolCalls = requests.length === 1
        ? [{ id: 'load', name: 'load_resources', arguments: { ids: ['project-files:read_file'] } }]
        : requests.length === 2 ? Object.keys(files).map(file => ({ id: file, name: 'read_file', arguments: { file_name: file } })) : []
      return { provider: 'custom', model: 'actor', raw: {}, toolCalls,
        text: toolCalls.length ? '' : '{"status":"completed","content":"已核对两份记录。"}' }
    } }
    const organizer: RuntimeLlm = { getConfig: config, async chat(request) {
      const packet = JSON.parse(request.messages[1]!.content)
      const offered: Array<{ file: string; text: string }> = packet.sources
      assert.equal(packet.organizationVersion, 4)
      const renderedBatches = packet.task.archiveReview ? reviews : filePacks
      renderedBatches.push(offered.map(source => source.file))
      const choices = offered.map(({ text, file }, index) => {
        if (packet.task.archiveReview && variant === 'vetoed' && file === 'unrelated.txt' && index === 0) return 'K'
        if (variant === 'single-witness' && file === 'primary.txt') return 'A'
        return text.includes('无关') ? 'A' : 'K'
      })
      return { provider: 'custom', model: 'organizer', raw: {}, text: JSON.stringify({ batch: packet.batch, choices, heading: '放行条件' }) }
    } }
    const loop = new RuntimeLoop({ projectDir, sessionId, llm: actor, contextOrganization: { minGroups: 1, chunkCharacters: 385, llm: organizer },
      stepDelayMs: 0, streamDelayMs: 0 })
    try {
      const finished = done(loop)
      const send = command('chat.message.send', { autoStart: true, clientMessageId: variant,
        content: [{ type: 'text', text: '整理两份放行建议，分别保留否定和先决条件。' }] }, sessionId)
      loop.validate(send); loop.execute(send, 1)
      await finished
      assert.equal(requests.length, 3)
      assert.ok(filePacks.length > 1)
      assert.equal(filePacks.filter(pack => pack.includes('primary.txt')).length > 1, variant === 'split-original')
      assert.deepEqual(reviews, variant === 'single-witness'
        ? [['primary.txt', 'primary.txt', 'primary.txt'], ['unrelated.txt', 'unrelated.txt']] : [['unrelated.txt', 'unrelated.txt']])
      const state = loop.exportState()
      const witnessed = variant === 'single-witness' ? [secondary] : [primary, secondary]
      assert.deepEqual(state.contextDocument!.information.map(info => info.body).sort(), witnessed.sort())
      const readInMain = requests.at(-1)!.messages.filter(message => message.name === 'read_file')
      assert.equal(readInMain.length, variant === 'confirmed' ? 0 : 3)
      for (const [file, lines] of Object.entries(files)) {
        const read = state.contextHistory!.messages.find(item => item.message.toolCallId === file)!
        assert.deepEqual(JSON.parse(read.rawContent!).result.lines.map((line: { text: string }) => line.text), lines)
        assert.equal(read.sequence <= state.contextHistory!.coverage.coveredThrough, variant === 'confirmed')
      }
      const commits = new ContextCommitStore(projectDir)
      try {
        for (const needle of ['棋赛通知', '画册']) {
          assert.equal(commits.searchArchivedSources(sessionId, [needle], 5).some(hit => hit.text.includes(needle)), variant !== 'vetoed')
        }
        assert.equal(commits.searchArchivedSources(sessionId, ['食堂菜单'], 5).some(hit => hit.text.includes('食堂菜单')), variant !== 'split-original')
      } finally { commits.close() }
    } finally {
      loop.close()
      fs.rmSync(projectDir, { recursive: true, force: true })
    }
  })
}

for (const variant of ['complete', 'positional', 'positional-custom', 'positional-dynamic', 'incomplete', 'conflicting-disposition', 'rewritten-body'] as const) {
  test(`extractive file organization governs actual main projection and recall (${variant})`, async () => {
    const positional = variant.startsWith('positional')
    const complete = variant === 'complete' || positional
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-extract-runtime-'))
    initializeProjectDirectory(projectDir)
    const sessionId = 'organization-session'
    new ProjectResources(projectDir).saveSettings({ context_organization_version: positional ? 4 : 3 })
    const customGuidance = '本项目按来源组织审批材料，保留双方的适用条件。'
    if (variant === 'positional-custom') fs.appendFileSync(path.join(projectDir, 'main.j2'), `\nLoaded harnesses: ${customGuidance}\n`)
    if (variant === 'positional-dynamic') {
      const filename = path.join(projectDir, '.capybara', 'system-variables.json')
      const resource = JSON.parse(fs.readFileSync(filename, 'utf8'))
      resource.variables.find((variable: { key: string }) => variable.key === 'dynamic_context').value = customGuidance
      fs.writeFileSync(filename, JSON.stringify(resource))
    }
    const rule = '导览记录 A：只有 "东门" 验证完成才允许 17:30 UTC。'
    const other = '交接原单 B：磁条尚未更换，不得在 16:00 UTC 重启。'
    const noise = '茶水间有挂钟。'
    fs.writeFileSync(path.join(projectDir, 'primary.txt'), rule + noise)
    fs.writeFileSync(path.join(projectDir, 'handoff.txt'), other)
    const requests: LlmChatRequest[] = []
    const actor: RuntimeLlm = { getConfig: config, async chat(request) {
      requests.push(request)
      const calls = requests.length === 1
        ? [{ id: 'load-file', name: 'load_resources', arguments: { ids: ['project-files:read_file'] } }]
        : requests.length === 2 ? ['primary.txt', 'handoff.txt'].map(file => ({ id: file, name: 'read_file', arguments: { file_name: file } })) : []
      return { provider: 'custom', model: 'actor', raw: {}, text: calls.length ? '' : '{"status":"completed","content":"两份主张分别保留。"}', toolCalls: calls }
    } }
    const organize: RuntimeLlm = { getConfig: config, async chat(request) {
      const input = JSON.parse(request.messages[1]!.content)
      if (positional) {
        assert.equal(input.organizationVersion, 4)
        assert.equal(input.documents, undefined)
        assert.deepEqual((input.sources as Array<{ text: string }>).map(item => item.text).sort(), [noise, other, rule].sort())
        return { provider: 'custom', model: 'organizer-test', raw: {}, text: JSON.stringify({ batch: input.batch,
          choices: input.sources.map((source: { text: string }) => source.text === noise ? 'A' : 'K'), heading: '审批记录' }) }
      }
      assert.equal(input.organizationVersion, 3)
      const actual: Array<{ text: string; file: string; line: number; ref: number }> = input.sources.filter((source: { file?: string }) => source.file)
      const first = actual.find(source => source.text === rule)
      const second = actual.find(source => source.text === other)
      const irrelevant = actual.find(source => source.text === noise)
      if (actual.length) {
        assert.ok(first && second && irrelevant)
        assert.deepEqual(actual.map(source => source.line), [1, 1, 1])
        assert.ok(!JSON.stringify(input.documents.session).includes(noise))
      }
      const picked = [first, ...(variant === 'incomplete' ? [] : [second])].filter(source => source !== undefined)
      const observations = picked.map(source => ({ sources: [source.ref] }))
      const edits = picked.map((_source, i) => ({ scope: 'session', operation: 'add_entry', observation: i + 1, headingPath: ['审批记录'],
        ...(variant === 'rewritten-body' ? { body: '磁条已更换。' } : {}) }))
      const archives = irrelevant ? [{ sources: [irrelevant.ref, ...(variant === 'conflicting-disposition' ? [first!.ref] : [])], reason: '当前任务无关' }] : []
      const uncertainties = variant === 'incomplete' && second ? [{ sources: [second.ref], statement: '原件继续保留' }] : []
      return { provider: 'custom', model: 'organizer-test', raw: {}, text: JSON.stringify({
        batch: input.batch, observations, edits, archives, fold: !!first && input.canFold, uncertainties,
      }) }
    } }
    const loop = new RuntimeLoop({ projectDir, sessionId, llm: actor, contextOrganization: { minGroups: 1, llm: organize }, stepDelayMs: 0, streamDelayMs: 0 })
    try {
      const finished = done(loop)
      const send = command('chat.message.send', { clientMessageId: 'extract', content: [{ type: 'text', text: '核对两份审批建议和限制。' }], autoStart: true })
      loop.validate(send); loop.execute(send, 1)
      await finished
      assert.equal(requests.length, 3)
      const state = loop.exportState()
      const document = state.contextDocument!
      const final = requests.at(-1)!
      const original = state.contextHistory!.messages.find(message => message.message.name === 'read_file' && message.rawContent?.includes(noise))!
      assert.ok(original.sourceArtifactId && original.rawContent?.includes(noise))
      assert.ok(document.candidates.some(candidate => candidate.rawArtifactId === original.sourceArtifactId && candidate.normalizedContent.includes(noise)))
      const samples = loop.getContextTrainingSamples()
      if (positional) {
        const sample = samples.find(item => item.organization?.attempts?.length)!
        const sent = JSON.parse(sample.organization!.attempts![0]!.messages[1]!.content).task.instructions
        const originalPrompt = sample.input.systemPrompt
        assert.match(originalPrompt, /Hook authoring protocol/)
        assert.match(originalPrompt, /System variable authoring protocol/)
        assert.match(originalPrompt, /read_file:/)
        if (variant === 'positional-custom') {
          assert.equal(sent, originalPrompt)
          assert.ok(sent.includes(`Loaded harnesses: ${customGuidance}`))
        } else {
          assert.doesNotMatch(sent, /^Hook authoring protocol:|^- read_file:/m)
          if (variant === 'positional-dynamic') assert.ok(sent.includes(customGuidance))
          else assert.doesNotMatch(sent, /System variable authoring protocol/)
          assert.match(sent, /Task:|User:/)
          assert.ok(originalPrompt.length > sent.length)
        }
      }
      const examples = samples.flatMap(toOrganizationTrainableExamples)
      if (complete) {
        assert.deepEqual(document.information.map(entry => entry.body).sort(), [rule, other].sort())
        assert.equal(final.messages.some(message => message.role === 'tool' && message.name === 'read_file'), false)
        assert.ok(final.messages[0]!.content.includes(rule) && final.messages[0]!.content.includes(other))
        assert.ok(!final.messages.some(message => message.content.includes(noise)))
        const evidence = document.evidence.find(item => item.id === document.information.find(entry => entry.body === rule)!.evidenceRefs[0])!
        const [, start, end] = evidence.locator!.split(':')
        assert.equal(JSON.parse(`"${original.rawContent!.slice(Number(start), Number(end))}"`), rule)
        const exported = examples.find(item => item.provenance.referenceBinding?.version === (positional ? 4 : 3)
          && (positional || JSON.parse(item.messages.at(-1)!.content).observations.length))
        assert.ok(exported)
        const view = exported.provenance.requestEvidence!.documentView
        if (positional) assert.deepEqual(view, { format: 'none' })
        else {
          assert.equal(view.format, 'references')
          if (view.format === 'references') {
            assert.deepEqual(view.bindings.project, exported.provenance.referenceBinding!.documents.project.binding)
            assert.deepEqual(view.bindings.session, exported.provenance.referenceBinding!.documents.session.binding)
          }
        }
        const target = JSON.parse(exported.messages.at(-1)!.content)
        if (positional) assert.deepEqual(target.choices.sort(), ['A', 'K', 'K'])
        else assert.ok(!target.observations.some((item: Record<string, unknown>) => item.text))
        loop.close()
        const durable = new ContextCommitStore(projectDir)
        try {
          assert.equal(durable.lastCommit(sessionId)?.history.coverage.excerptSources?.length, 2)
          assert.ok(durable.searchArchivedSources(sessionId, ['挂钟'], 5).some(hit => hit.text === noise))
          assert.deepEqual(durable.searchArchivedSources('other-session', ['挂钟'], 5), [])
        } finally { durable.close() }
        const restored = new RuntimeLoop({ projectDir, sessionId, llm: actor, initialState: state, stepDelayMs: 0, streamDelayMs: 0 })
        try {
          let recalled: RuntimeContextMemoryRecallResult | undefined
          restored.onEvent(event => { if (event.type === 'runtime.context.v2.memory.recalled') recalled = event.payload })
          const recall = command('runtime.context.v2.memory.recall', { query: '挂钟', scope: 'session' })
          restored.validate(recall); restored.execute(recall, 2)
          assert.ok(recalled?.hits.some(hit => hit.body === noise && hit.sourceKind === 'source_archive'))
        } finally { restored.close() }
        const editor = new ContextCommitStore(projectDir)
        try {
          const saved = editor.loadDocument(sessionId)!
          const engine = new ContextDocumentEngine(saved.document, saved.receipts, saved.projections, saved.reviewReceipts, saved.evidenceReviewReceipts)
          const target = saved.document.information.find(entry => entry.body === rule)!
          const projection = engine.project({ id: 'withdraw-extracted-entry', maxCharacters: 20000,
            includeSections: ['information', 'candidates'], includeStatuses: ['accepted', 'pending'], pinnedEntryIds: [target.id],
            pinnedCandidateIds: target.sourceCandidateIds })
          const receipt = engine.apply(engine.propose({ projection, candidateId: target.sourceCandidateIds[0]!,
            target: { section: 'information', entryId: target.id }, operation: 'mark_status',
            payload: { status: 'archived' }, actor: 'system', idempotencyKey: 'withdraw-first-witness' }))
          assert.equal(receipt.result, 'applied', receipt.errorCode ?? 'expected the committed witness to be archived')
          editor.saveSession(sessionId, engine.exportState())
        } finally { editor.close() }
        const afterEdit = new RuntimeLoop({ projectDir, sessionId, llm: actor, initialState: state, stepDelayMs: 0, streamDelayMs: 0 })
        try {
          const completed = done(afterEdit)
          const followUp = command('chat.message.send', { clientMessageId: 'after-archive', content: [{ type: 'text', text: '再次确认两个时间。' }], autoStart: true })
          afterEdit.validate(followUp); afterEdit.execute(followUp, 3)
          await completed
          const replayed = requests.at(-1)!.messages.filter(message => message.role === 'tool' && message.name === 'read_file')
          assert.equal(replayed.length, 2, 'when a witness changes, the original tool group reappears intact')
          assert.ok(replayed.some(message => message.content.includes('17:30 UTC')) && replayed.some(message => message.content.includes('16:00 UTC')))
          assert.deepEqual(afterEdit.exportState().contextHistory!.coverage, state.contextHistory!.coverage)
        } finally { afterEdit.close() }
      } else {
        assert.ok(final.messages.some(message => message.role === 'tool' && message.content.includes(other)))
        assert.equal(state.contextHistory!.coverage.excerptSources, undefined)
        if (variant !== 'incomplete') {
          assert.equal(document.information.length, 0)
          assert.ok(loop.getContextTrainingSamples().some(sample => sample.organization?.errorCode?.startsWith('CONTEXT_ORGANIZATION_')))
        }
      }
    } finally {
      loop.close()
      fs.rmSync(projectDir, { recursive: true, force: true })
    }
  })
}

function done(loop: RuntimeLoop, timeoutMs = 12000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('organization run timed out')) }, timeoutMs)
    const unsubscribe = loop.onEvent((event) => {
      if (event.type !== 'run.state.changed') return
      if (event.payload.status === 'completed' || event.payload.status === 'failed') {
        clearTimeout(timer); unsubscribe()
        if (event.payload.status === 'failed') reject(new Error(event.payload.failure?.message))
        else resolve()
      }
    })
  })
}

test('a large original-only file batch gets one review and can still authorize a missing read', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-raw-file-review-'))
  initializeProjectDirectory(projectDir)
  for (const [file, content] of Object.entries({ 'source-a.txt': '来源 A：仅在验证完成后放行。', 'source-b.txt': '来源 B：尚未确认交接。', 'source-c.txt': '来源 C：已经取到现场确认。' })) {
    fs.writeFileSync(path.join(projectDir, file), content)
  }
  let rounds = 0
  const native = (names: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) =>
    ({ provider: 'custom' as const, model: 'test', raw: {}, text: '', toolCalls: names })
  const actor: RuntimeLlm = { getConfig: config, async chat(request) {
    switch (++rounds) {
      case 1: return native([{ id: 'select', name: 'load_resources', arguments: { ids: ['project-files:read_file'] } }])
      case 2: return native(['source-a.txt', 'source-b.txt'].map(file => ({ id: file, name: 'read_file', arguments: { file_name: file } })))
      case 3: {
        assert.deepEqual(request.tools, [])
        assert.match(request.messages.at(-1)!.content, /File evidence checkpoint/)
        assert.equal(request.messages.filter(message => message.name === 'read_file').length, 2)
        const match = request.messages[0]!.content.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)
        assert.ok(match)
        return { provider: 'custom', model: 'test', raw: {}, text: JSON.stringify({ envelopeVersion: 2, binding: JSON.parse(match[0]),
          decision: 'continue', userMessage: '', actions: [], candidateDiffs: [], evidenceRequests: [], uncertainties: [],
          planProposal: null, waitSpec: null, completionCheck: null, reasoningNextStep: '还缺 source-c.txt 中的现场确认。' }) }
      }
      case 4:
        assert.ok(request.tools?.some(tool => tool.name === 'read_file'))
        return native([{ id: 'source-c.txt', name: 'read_file', arguments: { file_name: 'source-c.txt' } }])
      case 6: {
        assert.deepEqual(request.tools, [])
        assert.match(request.messages.at(-1)!.content, /File evidence checkpoint/)
        assert.equal(request.messages.filter(message => message.name === 'read_file').length, 3)
        const binding = JSON.parse(request.messages[0]!.content.split('\n').find(line => line.startsWith('{"sessionId":'))!)
        return { provider: 'custom', model: 'test', raw: {}, text: JSON.stringify({ envelopeVersion: 2, binding, decision: 'finish',
          userMessage: '来源 A：仅在验证完成后放行。\n来源 B：尚未确认交接。', actions: [], candidateDiffs: [], evidenceRequests: [], uncertainties: [],
          planProposal: null, waitSpec: null, completionCheck: { taskId: binding.taskId, requiredActions: [], requiredEvidenceRefs: [],
            unresolvedUncertaintyIds: [], summary: '直接使用已读的两份原件' } }) }
      }
      default:
        assert.ok(request.messages.some(message => message.name === 'read_file' && message.content.includes('已经取到现场确认')))
        return { provider: 'custom', model: 'test', raw: {}, text: '{"status":"completed","content":"三个来源均已核对。"}' }
    }
  } }
  const loop = new RuntimeLoop({ projectDir, sessionId: 'organization-session', llm: actor, stepDelayMs: 0, streamDelayMs: 0,
    contextOrganization: { minGroups: 1000, chunkCharacters: 1000 } })
  try {
    const finished = done(loop)
    const send = command('chat.message.send', { clientMessageId: 'raw-review', autoStart: true, content: [{ type: 'text', text: '核对放行规则和现场交接记录。' }] })
    loop.validate(send); loop.execute(send, 1); await finished
    assert.equal(rounds, 5)
    assert.equal(loop.exportState().snapshot.timeline.steps.filter(step => step.detail?.fileEvidenceCheckpointId).length, 1)
    const followUpDone = done(loop)
    const followUp = command('chat.message.send', { clientMessageId: 'raw-review-follow-up', autoStart: true,
      content: [{ type: 'text', text: '直接交付来源 A 与 B 的完整原句。' }] })
    loop.validate(followUp); loop.execute(followUp, 2); await followUpDone
    assert.equal(rounds, 6)
    assert.equal(loop.exportState().snapshot.timeline.steps.filter(step => step.detail?.fileEvidenceCheckpointId).length, 1)
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

function organizer(invalidSource = false, projectRule = false, autoCoverage = false): RuntimeLlm {
  return { getConfig: config, chat: async (request) => {
    assert.equal(request.tools, undefined, 'organizer cannot execute tools')
    const input = JSON.parse(request.messages[1]!.content)
    const observations: any[] = [], diffProposals: any[] = [], archiveProposals: any[] = []
    for (const [index, source] of input.sources.entries()) {
      if (autoCoverage && source.hostMetadata) continue
      if (source.origin === 'user') {
        if (projectRule) {
          const classification = { durability: 'project', target: 'project', confidence: 'high', reason: '用户明确要求跨会话保存', projectAnchors: ['project:explicit:question'] }
          observations.push({ id: `project-${index}`, sourceRefs: [source.id], normalizedContent: '本项目外部写入必须保留审计记录。', classification })
          diffProposals.push({ ...input.bindings.project, scope: 'project', sourceObservationId: `project-${index}`, operation: 'add_entry', body: '本项目外部写入必须保留审计记录。', headingPath: ['长期约束'], classification, idempotencyKey: `${input.snapshotId}:project:${index}` })
        }
        continue
      }
      if (source.origin === 'tool') {
        const text = source.text.includes('125') && source.text.includes('120')
          ? '订单 1024：来源 A 记录 125 美元；来源 B 记录 120 美元。两方并列保留，未裁决。'
          : '文件读取工具已加载，参数以实际 schema 为准。'
        observations.push({ id: `obs-${index}`, sourceRefs: [invalidSource ? 'not-in-snapshot' : source.id], normalizedContent: text })
        diffProposals.push({ scope: 'session', sourceObservationId: `obs-${index}`, operation: 'add_entry',
          headingPath: ['工作信息'], idempotencyKey: `${input.snapshotId}:diff:${index}` })
      } else archiveProposals.push({ id: `${input.snapshotId}:archive:${index}`, sourceRefs: [source.id], reason: '原始执行轨迹保持可召回' })
    }
    return { provider: 'custom', model: 'test', raw: {}, text: JSON.stringify({ organizationVersion: 1, snapshotId: input.snapshotId, mode: 'organize', observations, diffProposals, archiveProposals,
      recallProposals: [], uncertainties: [], coverageProposal: input.canProposeCoverage && autoCoverage ? 'auto' : input.canProposeCoverage ? { groupIds: input.coverageGroups.map((group: any) => group.id), retainedMessageIds: input.retainedMessageIds,
        proposalKeys: [...input.previousProposalKeys, ...diffProposals.map((proposal) => proposal.idempotencyKey), ...archiveProposals.map((proposal) => proposal.id)] } : null }) }
  } }
}

for (const failure of [undefined, 'source', 'commit', 'project', 'training', 'length', 'tokenizer-window', 'reference', 'reference-stale', 'reference-source'] as const) {
  test(`real tool rounds use committed session context and preserve raw history (${failure ?? 'success'})`, async (t) => {
    const referenceMode = failure?.startsWith('reference') ?? false
    const successfulCommit = failure === undefined || failure === 'project' || failure === 'training' || failure === 'reference'
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-organize-runtime-'))
    initializeProjectDirectory(projectDir)
    if (referenceMode) new ProjectResources(projectDir).saveSettings({ context_organization_version: 2 })
    fs.writeFileSync(path.join(projectDir, 'refund.txt'), '订单 1024。来源 A：125 美元。来源 B：120 美元。')
    let assistantRequests = 0
    const assistantServer = failure === 'tokenizer-window' ? http.createServer((_req, res) => {
      assistantRequests += 1
      res.writeHead(500).end('the over-budget request must not be sent')
    }) : undefined
    if (assistantServer) {
      await new Promise<void>(resolve => assistantServer.listen(0, '127.0.0.1', resolve))
      t.after(() => new Promise<void>(resolve => assistantServer.close(() => resolve())))
      const address = assistantServer.address()
      assert.ok(address && typeof address !== 'string')
      const directory = path.join(projectDir, 'tokenizer')
      writeChatTokenizerFixture(directory)
      const resources = new ProjectResources(projectDir)
      const settings = resources.readSettings()
      resources.saveSettings({ context: { reserved_output_tokens: 256 }, context_assistant_profile: 'bounded-organization', llm: {
        ...settings.llm, profiles: [...settings.llm.profiles, {
          id: 'bounded-organization', provider: 'custom', protocol: 'chat-completions',
          model: 'text-organizer', base_url: `http://127.0.0.1:${address.port}/v1`, max_retries: 0,
          chat_template_tokenizer: { directory, context_window_tokens: 1_024 },
        }],
      } })
    }
    const requests: LlmChatRequest[] = []
    const actor: RuntimeLlm = { getConfig: config, chat: async (request) => {
      requests.push(request)
      if (requests.length <= 2) return { provider: 'custom', model: 'test', raw: {}, text: '', finishReason: 'tool_calls', toolCalls: [{
        id: `call-${requests.length}`, name: requests.length === 1 ? 'load_resources' : 'read_file',
        arguments: requests.length === 1 ? { ids: ['project-files:read_file'] } : { file_name: 'refund.txt', start_line: 1, end_line: 10 },
      }] }
      assert.equal(requests.length, 3)
      const system = request.messages[0]!.content
      if (successfulCommit) {
        assert.match(system, /来源 A 记录 125 美元/)
        assert.match(system, /来源 B 记录 120 美元/)
        assert.equal(request.messages.some((message) => message.role === 'tool'), false, 'covered tool groups exit the model projection')
      } else {
        assert.ok(request.messages.some((message) => message.role === 'tool' && message.name === 'read_file'), 'failed compression keeps the full native group')
      }
      return { provider: 'custom', model: 'test', raw: {}, text: '{"status":"completed","content":"保留 125 与 120 美元两种来源记录。"}' }
    } }
    const organize: RuntimeLlm = referenceMode ? { getConfig: config, async chat(request) {
      const input = JSON.parse(request.messages[1]!.content)
      assert.equal(input.organizationVersion, 2)
      assert.equal(input.bindings, undefined)
      assert.equal(input.snapshotId, undefined)
      assert.ok(input.sources.every((source: any) => Number.isInteger(source.ref) && !source.id && !source.sourceHash))
      assert.doesNotMatch(request.messages[0]!.content, /capybara:candidate-meta/)
      const found = input.sources.find((source: any) => source.origin === 'tool' && source.text.includes('125') && source.text.includes('120'))
      const observations = failure === 'reference-source' ? [{ sources: [10000], text: '未知编号' }]
        : found ? [{ sources: [found.ref], text: '来源 A 记录 125 美元，来源 B 记录 120 美元。' }] : []
      return { provider: 'custom', model: 'test', raw: {}, text: JSON.stringify({
        batch: failure === 'reference-stale' ? (input.batch === '000000000000' ? '111111111111' : '000000000000') : input.batch,
        observations, edits: found ? [{ scope: 'session', operation: 'add_entry', observation: 1, headingPath: ['退款'] }] : [],
        archives: [], fold: input.canFold && !!found, uncertainties: [],
      }) }
    } } : organizer(failure === 'source', failure === 'project', failure === undefined)
    const loop = new RuntimeLoop({ projectDir, llm: actor, contextOrganization: { minGroups: 1,
      llm: failure === 'tokenizer-window' ? undefined
        : failure === 'length' ? { ...organize, chat: async request => ({ ...await organize.chat(request), finishReason: 'length' }) } : organize },
    stepDelayMs: 0, streamDelayMs: 0 })
    if (failure === 'commit') (loop as any).projectContextStore.commits.commit = () => { throw new Error('TEST_DURABLE_COMMIT_FAILED') }
    if (failure === 'training') (loop as any).contextTrainingRecorder.attachOrganization = () => { throw new Error('TEST_TRAINING_RECORD_FAILED') }
    try {
      const finished = done(loop)
      const send = command('chat.message.send', { clientMessageId: 'question', content: [{ type: 'text', text: '核对订单 1024，两种来源都保留。' }], autoStart: true })
      loop.validate(send); loop.execute(send, 1)
      await finished
      const state = loop.exportState()
      const training = loop.getContextTrainingSamples().filter((sample) => sample.organization)
      if (failure !== 'training') assert.ok(training.length >= 2)
      for (const sample of training) assert.deepEqual(validateContextTrainingSample(sample), [])
      assert.equal(requests.length, 3)
      assert.ok(state.contextHistory!.messages.some((entry) => entry.origin === 'tool' && entry.rawContent?.includes('125')), JSON.stringify(state.contextHistory!.messages).slice(-1500))
      if (successfulCommit) {
        assert.equal(state.contextHistory!.coverage.coveredThrough, 5)
        assert.ok(state.contextDocument!.information.some((entry) => entry.body.includes('125') && entry.body.includes('120')))
        assert.ok(state.artifacts.some((artifact) => artifact.meta.label === 'Context documents and coverage committed'))
        const examples = training.flatMap(toOrganizationTrainableExamples)
        if (failure !== 'training') {
          assert.ok(examples.length >= 2)
          assert.ok(training.some(sample => sample.proposal?.operations.some(operation => operation.scope === 'session'
            && operation.action === 'add' && operation.content?.includes('来源 A 记录 125 美元'))))
        }
        if (failure === undefined) {
          const folded = training.find(sample => sample.organization?.coverageAfter.coveredThrough === 5)?.organization
          assert.ok(folded?.sourceArchives?.some(archive => folded.coverageAfter.receiptIds.includes(archive.receiptId)
            && archive.sourceSpans?.some(span => !!span.sourceHash)))
          assert.ok(examples.every(example => !example.messages.at(-1)?.content.includes('宿主保留空工具调用壳')))
        }
        for (const example of examples) {
          const target = JSON.parse(example.messages.at(-1)!.content)
          assert.equal(example.schemaVersion, 3)
          if (referenceMode) {
            const input = JSON.parse(example.messages.at(-2)!.content)
            assert.equal(target.batch, input.batch)
            assert.equal(target.snapshotId, undefined)
            assert.equal(target.diffProposals, undefined)
            assert.equal(example.provenance.referenceBinding?.batch, input.batch)
            assert.equal(example.provenance.referenceBinding?.sources.length, input.sources.length)
          } else {
            assert.equal(target.organizationVersion, 1)
            assert.ok(example.messages.some((message) => message.role === 'user' && message.content.includes(target.snapshotId)))
          }
          assert.equal('receiptIds' in target || 'committed' in target || 'verified' in target, false)
        }
        const automaticSamples = loop.getContextTrainingSamples().filter((sample) => sample.task === 'context_organization')
        assert.ok(automaticSamples.length >= 2)
        assert.throws(() => toTrainableContextExample(automaticSamples[0]!), /ORGANIZATION_TRAINING_EXPORT_REQUIRED/)
        if (failure === 'training') {
          assert.deepEqual(automaticSamples.flatMap(toOrganizationTrainableExamples), [])
          assert.ok(automaticSamples.every((sample) => validateContextTrainingSample(sample).includes('ORGANIZATION_EVIDENCE_REQUIRED')))
          assert.ok(state.artifacts.some((artifact) => artifact.meta.label === 'Context training recording failed'))
          assert.equal(state.artifacts.some((artifact) => artifact.meta.label === 'Context organization kept original history'), false)
        }
        if (failure === 'project') {
          assert.ok(state.projectContextDocument!.information.some((entry) => entry.body.includes('审计记录')))
          const another = new RuntimeLoop({ projectDir, llm: actor, stepDelayMs: 0, streamDelayMs: 0 })
          try { assert.ok(another.exportState().projectContextDocument!.information.some((entry) => entry.body.includes('审计记录'))) } finally { another.close() }
        }
        const restored = new RuntimeLoop({ projectDir, llm: actor, initialState: state, stepDelayMs: 0, streamDelayMs: 0 })
        try {
          const snapshot = command('runtime.snapshot.get', {})
          restored.validate(snapshot); restored.execute(snapshot, 2)
          assert.equal(restored.exportState().contextHistory!.coverage.coveredThrough, 5)
          assert.deepEqual(restored.exportState().contextDocument!.information, state.contextDocument!.information)
        } finally { restored.close() }
      } else {
        assert.equal(state.contextHistory!.coverage.coveredThrough, 0)
        assert.equal(state.contextDocument!.information.length, 0)
        assert.ok(state.artifacts.some((artifact) => artifact.meta.label === 'Context organization kept original history'))
        assert.deepEqual(training.flatMap(toOrganizationTrainableExamples), [])
        assert.ok(training.every((sample) => sample.organization?.committed === false && Boolean(sample.organization.errorCode)))
        if (failure === 'length') assert.ok(training.every(sample => sample.organization?.errorCode === 'CONTEXT_ORGANIZATION_OUTPUT_TRUNCATED'))
        if (failure === 'tokenizer-window') {
          assert.equal(assistantRequests, 0)
          assert.ok(training.every(sample => sample.organization?.errorCode === 'RUNTIME_MODEL_CONTEXT_WINDOW'))
        }
        if (failure === 'reference-stale' || failure === 'reference-source') {
          const expected = failure === 'reference-stale' ? 'CONTEXT_ORGANIZATION_BINDING_MISMATCH' : 'CONTEXT_ORGANIZATION_REFERENCE_UNKNOWN'
          assert.ok(training.every(sample => sample.organization?.errorCode === expected && sample.organization.attempts[0]?.referenceBinding))
        }
      }
    } finally {
      loop.close()
      fs.rmSync(projectDir, { recursive: true, force: true })
    }
  })
}

test('a read-only child cannot install a project Hook through its response', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-child-hook-boundary-'))
  initializeProjectDirectory(projectDir)
  const content = '```capybara-hook name=child-escape\nimport { defineHook } from "@capybara-agent/sdk";\nexport default defineHook({name:"child-escape",enabled:true,trigger(){return true;},async run(){return {};}});\n```'
  const actor: RuntimeLlm = { getConfig: config, chat: async () => ({ provider: 'custom', model: 'test', raw: {}, text: JSON.stringify({ status: 'completed', content }) }) }
  const loop = new RuntimeLoop({ projectDir, llm: actor, childAgentMode: true, stepDelayMs: 0, streamDelayMs: 0 })
  try {
    const finished = done(loop)
    const send = command('chat.message.send', { clientMessageId: 'child-escape', content: [{ type: 'text', text: '观察并提交结果' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1)
    await finished
    assert.equal(fs.existsSync(path.join(projectDir, 'hooks', 'child-escape.ts')), false)
    assert.equal(loop.exportState().projectContextDocument?.revision, 0)
  } finally { loop.close(); fs.rmSync(projectDir, { recursive: true, force: true }) }
})

test('valid no-change organization is trainable while original history remains active', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-organize-noop-'))
  initializeProjectDirectory(projectDir)
  let calls = 0
  const actor: RuntimeLlm = { getConfig: config, chat: async () => {
    calls += 1
    return calls === 1
      ? { provider: 'custom', model: 'test', text: '', raw: {}, toolCalls: [{ id: 'search-noop', name: 'search_resources', arguments: { query: 'files', kinds: ['tool'], limit: 1 } }] }
      : { provider: 'custom', model: 'test', text: '{"status":"completed","content":"已检查工具目录。"}', raw: {} }
  } }
  const auxiliary: RuntimeLlm = { getConfig: config, chat: async (request) => {
    const input = JSON.parse(request.messages[1]!.content)
    return { provider: 'custom', model: 'test', raw: {}, text: JSON.stringify({ organizationVersion: 1, snapshotId: input.snapshotId, mode: 'organize', observations: [], diffProposals: [], archiveProposals: [], recallProposals: [], coverageProposal: null, uncertainties: [] }) }
  } }
  const loop = new RuntimeLoop({ projectDir, llm: actor, contextOrganization: { minGroups: 1, llm: auxiliary }, stepDelayMs: 0, streamDelayMs: 0 })
  try {
    const finished = done(loop)
    const send = command('chat.message.send', { clientMessageId: 'noop', content: [{ type: 'text', text: '检查目录' }], autoStart: true })
    loop.validate(send); loop.execute(send, 1)
    await finished
    assert.equal(loop.exportState().contextHistory!.coverage.coveredThrough, 0)
    const sample = loop.getContextTrainingSamples().find((item) => item.organization?.outcome === 'no_change')
    assert.ok(sample)
    assert.equal(sample.organization!.committed, false)
    const examples = toOrganizationTrainableExamples(sample)
    assert.equal(examples.length, 1)
    assert.equal(JSON.parse(examples[0]!.messages.at(-1)!.content).coverageProposal, null)
  } finally { loop.close(); fs.rmSync(projectDir, { recursive: true, force: true }) }
})

test('CLI exports only selected accepted Organizer attempts from saved runtime sessions', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-organization-export-'))
  initializeProjectDirectory(projectDir)
  fs.writeFileSync(path.join(projectDir, 'manifest-notes.txt'), '证书轮换窗口为周三 03:15 UTC。')
  const dataDir = path.join(projectDir, '.capybara', 'runtime')
  const store = new SessionStore(projectDir, { directory: dataDir })
  const run = async (name: string, invalidSource: boolean) => {
    const { id } = store.create(name)
    let calls = 0
    const actor: RuntimeLlm = { getConfig: config, async chat() {
      calls += 1
      if (calls <= 2) return { provider: 'custom', model: 'test', raw: {}, text: '', toolCalls: [{
        id: `read-${calls}`, name: calls === 1 ? 'load_resources' : 'read_file',
        arguments: calls === 1 ? { ids: ['project-files:read_file'] } : { file_name: 'manifest-notes.txt' },
      }] }
      return { provider: 'custom', model: 'test', raw: {}, text: '{"status":"completed","content":"已读取轮换窗口。"}' }
    } }
    const loop = new RuntimeLoop({ projectDir, llm: actor, contextOrganization: { minGroups: 1,
      llm: organizer(invalidSource, false, true) }, stepDelayMs: 0, streamDelayMs: 0 })
    try {
      const finished = done(loop)
      const request = command('chat.message.send', { clientMessageId: 'rotation', content: [{ type: 'text',
        text: '整理证书轮换窗口，保留时区来源。' }], autoStart: true }, id)
      loop.validate(request); loop.execute(request, 1)
      await finished
      store.save(id, loop.exportState(), calls)
      const samples = loop.getContextTrainingSamples().filter(sample => sample.organization)
      assert.ok(samples.length > 0)
      return { id, samples }
    } finally { loop.close() }
  }
  const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
  const cli = (output: string, ...ids: string[]) => promisify(execFile)(process.execPath, ['--conditions=development', '--import', 'tsx',
    cliPath, 'export-context-training', projectDir, '--data-dir', dataDir, '--output', output,
    ...ids.flatMap(id => ['--session', id])], { encoding: 'utf8', timeout: 15000 })
  try {
    const chosen = await run('chosen', false)
    const rejected = await run('rejected', true)
    const excluded = await run('excluded', false)
    const expected = chosen.samples.flatMap(toOrganizationTrainableExamples)
    assert.ok(expected.length > 0)
    const completed = chosen.samples.find(sample => toOrganizationTrainableExamples(sample).length)!
    const modified = structuredClone(completed)
    modified.organization!.attempts[0]!.messages[0]!.content += '\nUnbound input change'
    assert.throws(() => toOrganizationTrainableExamples(modified), /ORGANIZATION_REQUEST_EVIDENCE_INVALID/)
    const legacy = structuredClone(completed)
    legacy.organization!.schemaVersion = 1
    for (const attempt of legacy.organization!.attempts) delete attempt.requestEvidence
    assert.deepEqual(toOrganizationTrainableExamples(legacy).map(row => row.messages), toOrganizationTrainableExamples(completed).map(row => row.messages))
    assert.ok(excluded.samples.flatMap(toOrganizationTrainableExamples).length > 0)
    const rejectedSamples = rejected.samples.filter(sample => sample.organization?.outcome === 'rejected')
    assert.ok(rejectedSamples.length > 0)
    const expectedRejectedSessionRows = rejected.samples.flatMap(toOrganizationTrainableExamples)
    const expectedRows = [...expected, ...expectedRejectedSessionRows]
    const output = path.join(projectDir, 'examples.jsonl')
    assert.deepEqual(JSON.parse((await cli(output, chosen.id, rejected.id, chosen.id)).stdout), { sessions: 2, examples: expectedRows.length })
    const contents = fs.readFileSync(output, 'utf8')
    const rows = contents.trimEnd().split('\n').map(row => JSON.parse(row))
    assert.deepEqual(rows.map(row => row.sampleId), expectedRows.map(example => example.sampleId))
    for (const [index, row] of rows.entries()) {
      assert.deepEqual(row.messages, expectedRows[index]!.messages)
      assert.deepEqual(row.provenance.requestEvidence, expectedRows[index]!.provenance.requestEvidence)
      const proof = row.provenance.requestEvidence
      assert.equal(proof.accounting, 'request_view')
      assert.equal(proof.documentView.format, 'markdown')
      assert.deepEqual(proof.promptBindings.map((item: { role: string }) => item.role), ['constitution', 'context-organizer'])
      assert.equal(proof.actorSessionId, index < expected.length ? chosen.id : rejected.id)
      assert.match(row.provenance.projectGroup, /^[a-f0-9]{64}$/)
      assert.match(row.provenance.sessionGroup, /^[a-f0-9]{64}$/)
      assert.equal(row.provenance.projectGroup, rows[0].provenance.projectGroup)
      assert.equal(row.provenance.sessionGroup === rows[0].provenance.sessionGroup, index < expected.length)
    }
    await assert.rejects(cli(output, chosen.id), /EEXIST/)
    assert.equal(fs.readFileSync(output, 'utf8'), contents)
    const noOutput = path.join(projectDir, 'missing.jsonl')
    await assert.rejects(cli(noOutput, chosen.id, 'does-not-exist'), /Session was not found/)
    assert.equal(fs.existsSync(noOutput), false)
    const empty = store.create('empty')
    await assert.rejects(cli(noOutput, empty.id), /no validated Organizer training examples/)
    assert.equal(fs.existsSync(noOutput), false)
    assert.equal(fs.readdirSync(projectDir).some(name => name.startsWith('.context-training-')), false)
  } finally { store.close(); fs.rmSync(projectDir, { recursive: true, force: true }) }
})

test('a follow-up without new tool evidence reuses organized context below budget pressure', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-organize-follow-up-'))
  initializeProjectDirectory(projectDir)
  fs.writeFileSync(path.join(projectDir, 'refund.txt'), '订单 1024。来源 A：125 美元。来源 B：120 美元。')
  let rounds = 0, reorganizations = 0
  const actor: RuntimeLlm = { getConfig: config, async chat(request) {
    if (++rounds <= 2) return { provider: 'custom', model: 'test', raw: {}, text: '', toolCalls: [{
      id: `file-${rounds}`, name: rounds === 1 ? 'load_resources' : 'read_file',
      arguments: rounds === 1 ? { ids: ['project-files:read_file'] } : { file_name: 'refund.txt' },
    }] }
    assert.match(request.messages[0]!.content, /来源 A 记录 125 美元/)
    assert.ok(!request.messages.some(message => message.name === 'read_file'))
    return { provider: 'custom', model: 'test', raw: {}, text: '{"status":"completed","content":"两方资料保留。"}' }
  } }
  const auxiliary = organizer(false, false, true)
  const loop = new RuntimeLoop({ projectDir, llm: actor, stepDelayMs: 0, streamDelayMs: 0,
    contextOrganization: { minGroups: 1, llm: { ...auxiliary, async chat(request) {
      reorganizations++
      return auxiliary.chat(request)
    } } } })
  try {
    for (const [index, query] of ['核对订单两方资料', '补充两方依据'].entries()) {
      const finished = done(loop)
      const send = command('chat.message.send', { clientMessageId: `follow-up-${index}`, content: [{ type: 'text', text: query }], autoStart: true })
      loop.validate(send); loop.execute(send, index + 1)
      await finished
      if (index === 0) assert.equal(reorganizations, 2)
    }
    assert.equal(reorganizations, 2)
    assert.equal(rounds, 4)
  } finally { await loop.shutdown(); fs.rmSync(projectDir, { recursive: true, force: true }) }
})
