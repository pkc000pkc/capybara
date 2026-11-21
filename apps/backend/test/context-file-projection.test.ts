import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ContextDocumentEngine } from '#core/context-document-engine'
import { coveredFileArtifacts, createFileEvidenceResolver, isVerifiedFileArtifactPage, projectFileHistory,
  publishedFileArtifactId, publishedFileReadLine } from '#core/context-file-projection'
import { ContextHistory, type ContextHistoryMessage } from '#core/context-history'
import { readFileExcerpts } from '#core/context-source-excerpts'
import { ContextCommitStore } from '#core/context-commit-store'
import { initializeProjectDirectory } from '#core/project-initializer'
import { ProjectResources } from '#core/project-resources'
import { RuntimeLoop, type RuntimeLlm } from '#core/runtime-loop'
import type { ClientCommand, ControlEnvelopeV2 } from '#protocol/runtime-protocol'
import type { LlmChatRequest, LlmMessage } from '#util/llm'

const { readContextEntries, readContextTree } = createRequire(import.meta.url)('./fixtures/context-model-view.cjs')

function fixture(numbered: boolean) {
  const lines = [{ line: 18, text: '交接😺：核验 "CD" 后才可启用，未确认时继续等待。'.repeat(5) }, { line: 19, text: '保留 \\ 原记录。' }]
  const content = lines.map(line => numbered ? `${line.line}: ${line.text}` : line.text).join('\n')
  const raw = { ok: true, result: { path: 'handoff.txt', start_line: 18, end_line: 19, lines, content } }
  const receipt = { kind: 'tool-execution', toolName: 'read_file', callId: 'read-call', resultArtifactId: 'original', status: 'succeeded', ok: true }
  const message: LlmMessage = { role: 'tool', name: 'read_file', toolCallId: 'read-call', content: JSON.stringify({ ...raw, runtime_receipt: receipt }) }
  const messages: LlmMessage[] = [
    { role: 'assistant', content: '', toolCalls: [{ id: 'read-call', name: 'read_file', arguments: {} }] }, message,
  ]
  const body = JSON.stringify(raw, null, 2)
  const at = '2026-11-18T00:00:00.000Z'
  const source: ContextHistoryMessage = { id: 'original-history', sequence: 2, origin: 'tool', capturedAt: at, message,
    sourceArtifactId: 'original', rawContent: JSON.stringify(raw),
    sourceArtifactMeta: { id: 'original', kind: 'tool-result', label: 'read_file', contentType: 'application/json',
      byteLength: Buffer.byteLength(body), hash: createHash('sha256').update(body).digest('hex'),
      preview: body.length > 640 ? `${body.slice(0, 640)}\n...` : body,
      createdAt: at, redacted: false },
  }
  const engine = ContextDocumentEngine.create({ sessionId: 'file-session', projectId: 'file-project', constitutionRevision: 'test' })
  const evidence = engine.addEvidence({ kind: 'artifact', referenceId: 'original', sessionId: 'file-session',
    sourceHash: source.sourceArtifactMeta!.hash, observedAt: at })
  const candidate = engine.addCandidate({ source: { actor: 'tool', sourceId: 'observation', toolName: 'read_file', capturedAt: at },
    rawArtifactId: 'original', normalizedContent: source.sourceArtifactMeta!.preview, evidenceRefs: [evidence.id] })
  return { messages, engine, source, raw, candidate, receipt }
}

test('file projection preserves numbered and plain content exactly and keeps candidate identity', () => {
  for (const numbered of [true, false]) {
    const f = fixture(numbered)
    const before = f.engine.serialize()
    const compact = projectFileHistory(f.messages, f.engine.snapshot(), () => f.source)
    assert.ok(compact.hasReferences)
    assert.deepEqual([...compact.bodyReferences], [[f.candidate.id, 'original']])
    const result = JSON.parse(compact.messages[1]!.content)
    assert.deepEqual(result.runtime_receipt, f.receipt)
    assert.deepEqual(result.result.contentRef, { field: 'lines', numbered })
    assert.equal(publishedFileArtifactId(compact.messages, 'handoff.txt', () => f.source), f.source.sourceArtifactId)
    assert.equal(publishedFileArtifactId(compact.messages, 'other.txt', () => f.source), undefined)
    assert.equal(publishedFileArtifactId([], 'handoff.txt', () => f.source), undefined)
    const unrelated = { ...compact.messages[1]!, toolCallId: 'other-call' }
    assert.equal(publishedFileArtifactId([unrelated], 'handoff.txt', () => f.source), undefined)
    assert.equal(result.result.content, undefined)
    assert.deepEqual(result.result.lines, f.raw.result.lines)
    assert.equal(result.result.lines.map((line: { line: number; text: string }) =>
      result.result.contentRef.numbered ? `${line.line}: ${line.text}` : line.text).join('\n'), f.raw.result.content)
    const rendered = f.engine.project({ id: 'model', maxCharacters: 20000,
      includeSections: ['candidates'], candidateBodyReferences: compact.bodyReferences })
    assert.ok(rendered.sourceCandidateIds.includes(f.candidate.id))
    assert.match(rendered.markdown, /正文见工具读取 original/)
    assert.ok(!rendered.markdown.includes('核验 "CD"'))
    const model = f.engine.project({ id: 'compact-file-candidate', maxCharacters: 20000, compactReferences: true,
      includeSections: ['candidates'], candidateBodyReferences: compact.bodyReferences })
    const record = JSON.parse(model.markdown.match(/<!-- capybara:candidate-ref data=(\{[^\n]+?\}) -->/)![1]!)
    assert.equal(record.id, f.candidate.id)
    assert.deepEqual(record.evidence, f.candidate.evidenceRefs.map(id => ({ id })))
    assert.equal(record.body, 'tool_result')
    assert.equal((model.markdown.match(/"original"/g) ?? []).length, 1)
    assert.equal(f.engine.serialize(), before)
    assert.deepEqual(JSON.parse(f.source.rawContent!), f.raw)
  }
})

test('a raw quote requires an exact visible line and the original receipt in the current request', () => {
  const f = fixture(true)
  const storage = () => f.source
  const resolve = (messages: readonly LlmMessage[], line = 18, file = 'handoff.txt') => publishedFileReadLine(messages, 'original', file, line, storage)
  assert.equal(resolve(f.messages)?.text, f.raw.result.lines[0]!.text)
  assert.equal(resolve(f.messages, 18, 'other.txt'), undefined)
  assert.equal(resolve([], 18), undefined)
  const altered = structuredClone(f.messages)
  const wire = JSON.parse(altered[1]!.content)
  wire.result.lines.shift()
  altered[1]!.content = JSON.stringify(wire)
  assert.equal(resolve(altered, 18), undefined)
  assert.equal(resolve(altered, 19)?.text, f.raw.result.lines[1]!.text)
  wire.result.lines[0].text = '伪造原文'
  altered[1]!.content = JSON.stringify(wire)
  assert.equal(resolve(altered, 19), undefined)
  wire.result.lines[0].text = f.raw.result.lines[1]!.text
  wire.runtime_receipt.resultArtifactId = 'unknown'
  altered[1]!.content = JSON.stringify(wire)
  assert.equal(resolve(altered, 19), undefined)
})

test('a visible persisted line page is enough to cite its original without replaying the full read', () => {
  const { source, raw } = fixture(true)
  const receipt = { kind: 'tool-execution', toolName: 'read_runtime_artifact', callId: 'page', status: 'succeeded', ok: true, resultArtifactId: 'page-result' }
  const result = { artifact_id: 'original', source_scope: 'session', source_hash: createHash('sha256').update(source.rawContent!).digest('hex'),
    mode: 'file_lines', file: 'handoff.txt', start_line: 18, end_line: 18, lines: raw.result.lines.slice(0, 1) }
  const message: LlmMessage = { role: 'tool', name: 'read_runtime_artifact', toolCallId: 'page',
    content: JSON.stringify({ ok: true, runtime_receipt: receipt, result }) }
  const value = { ok: true, result }
  const preview = JSON.stringify(value, null, 2)
  const page = { ...source, message: { ...message }, rawContent: JSON.stringify(value), sourceArtifactId: 'page-result',
    sourceArtifactMeta: { ...source.sourceArtifactMeta!, id: 'page-result', preview, hash: createHash('sha256').update(preview).digest('hex') } }
  const resolve = (messages: readonly LlmMessage[], line = 18, original = 'original', keepPage = true) =>
    publishedFileReadLine(messages, original, 'handoff.txt', line,
      id => id === 'original' ? source : id === 'page-result' && keepPage ? page : undefined)
  assert.equal(resolve([message])?.text, raw.result.lines[0]!.text)
  assert.equal(resolve([message], 19), undefined)
  assert.equal(resolve([message], 18, 'page-result'), undefined)
  assert.equal(resolve([message], 18, 'original', false), undefined)
  const different = { ...message, content: JSON.stringify({ ok: true, runtime_receipt: { ...receipt, resultArtifactId: 'other' }, result }) }
  assert.equal(resolve([different]), undefined)
})

test('only an exact successful page of an assessed file qualifies as a derived observation', () => {
  const { source } = fixture(true)
  const raw = source.rawContent!
  const receipt = { kind: 'tool-execution', toolName: 'read_runtime_artifact', callId: 'page', status: 'succeeded', ok: true, resultArtifactId: 'page-result' }
  const result = { artifact_id: 'original', offset: 12, page_limit: 168, total_characters: raw.length,
    next_offset: 180, content: raw.slice(12, 180) }
  const validate = (payload: object = result, proof: object = receipt, assessed = new Set(['original']), observation = source,
    recordedPage = true) => {
    const rawPage = { ok: true, result: payload }
    const message: LlmMessage = { role: 'tool', name: 'read_runtime_artifact', toolCallId: 'page',
      content: JSON.stringify({ ...rawPage, runtime_receipt: proof }) }
    const body = JSON.stringify(rawPage, null, 2)
    const page: ContextHistoryMessage = { ...source, message, rawContent: JSON.stringify(rawPage), sourceArtifactId: 'page-result',
      sourceArtifactMeta: { ...source.sourceArtifactMeta!, id: 'page-result', byteLength: Buffer.byteLength(body),
        hash: createHash('sha256').update(body).digest('hex'), preview: body } }
    return isVerifiedFileArtifactPage(message, assessed, id => id === 'original' ? observation : recordedPage ? page : undefined)
  }
  assert.equal(validate(), true)
  assert.equal(validate({ ...result, source_scope: 'project' }), false)
  assert.equal(validate({ ...result, offset: 11 }), false)
  assert.equal(validate({ ...result, content: 'a different page' }), false)
  assert.equal(validate({ ...result, source_hash: 'a-stale-version' }), false)
  assert.equal(validate(result, { ...receipt, callId: 'another-call' }), false)
  assert.equal(validate(result, receipt, new Set(['different-original'])), false)
  assert.equal(validate(result, receipt, undefined, { ...source, rawContent: JSON.stringify({ ok: true }) }), false)
  assert.equal(validate(result, receipt, undefined, source, false), false)
  const lineResult = { artifact_id: 'original', mode: 'file_lines', file: 'handoff.txt', start_line: 19, end_line: 19,
    source_hash: createHash('sha256').update(raw).digest('hex'),
    lines: [{ line: 19, text: '保留 \\ 原记录。' }] }
  assert.equal(validate(lineResult), true)
  assert.equal(validate({ ...lineResult, start_line: 18 }), false)
  assert.equal(validate({ ...lineResult, lines: [{ line: 19, text: '改写原文' }] }), false)
})

test('verified character pages share only published bytes and preserve a valid candidate reference', () => {
  const f = fixture(true)
  const raw = f.source.rawContent!
  const page = (id: string, start: number, limit: number) => {
    const result = { artifact_id: 'original', source_scope: 'session', offset: start, page_limit: limit,
      total_characters: raw.length, content: raw.slice(start, start + limit), next_offset: start + limit < raw.length ? start + limit : null }
    const artifactId = `artifact-${id}`
    const payload = { ok: true, result }
    const runtime_receipt = { ...f.receipt, toolName: 'read_runtime_artifact', callId: id, resultArtifactId: artifactId }
    const tool: LlmMessage = { role: 'tool', name: runtime_receipt.toolName, toolCallId: id, content: JSON.stringify({ ...payload, runtime_receipt }) }
    const messages: LlmMessage[] = [{ role: 'assistant', content: '', toolCalls: [{ id, name: tool.name!, arguments: {} }] }, tool]
    const text = JSON.stringify(payload, null, 2)
    const source: ContextHistoryMessage = { ...f.source, sourceArtifactId: artifactId, message: tool, rawContent: JSON.stringify(payload),
      sourceArtifactMeta: { ...f.source.sourceArtifactMeta!, id: artifactId, preview: text, byteLength: Buffer.byteLength(text),
        hash: createHash('sha256').update(text).digest('hex') } }
    return { artifactId, messages, result, source }
  }
  const first = page('page-one', 0, 350)
  const second = page('page-two', 100, 420)
  const meta = second.source.sourceArtifactMeta!
  const evidence = f.engine.addEvidence({ kind: 'artifact', referenceId: second.artifactId, sourceHash: meta.hash, sessionId: 'file-session' })
  const candidate = f.engine.addCandidate({ source: { actor: 'tool', toolName: 'read_runtime_artifact', sourceId: 'page-observation',
    capturedAt: f.source.capturedAt }, rawArtifactId: second.artifactId, normalizedContent: meta.preview, evidenceRefs: [evidence.id] })
  const document = f.engine.snapshot()
  const sources = new Map([['original', f.source], [first.artifactId, first.source], [second.artifactId, second.source]])
  const project = (messages: LlmMessage[], index = sources) => projectFileHistory(messages, document, id => index.get(id),
    { groups: [], project: document, hasArchivedSpan: () => false, compactPages: true })
  const all = [...first.messages, ...second.messages]
  const rendered = project(all)
  const result = JSON.parse(rendered.messages.at(-1)!.content)
  assert.equal(result.result.projection, 'verified_file_page')
  assert.deepEqual(result.result.segments, [{ offset: 100, length: 250, fromCallId: 'page-one' },
    { offset: 350, content: raw.slice(350, 520) }])
  assert.equal(first.result.content.slice(100) + result.result.segments[1].content, second.result.content)
  assert.deepEqual(rendered.messages[1], first.messages[1])
  assert.deepEqual(result.runtime_receipt, JSON.parse(second.messages[1]!.content).runtime_receipt)
  assert.equal(result.result.next_offset, second.result.next_offset)
  assert.equal(rendered.bodyReferences.get(candidate.id), second.artifactId)
  assert.equal(project(second.messages).messages.at(-1), second.messages[1], 'a source page absent from this request cannot be referenced')
  const wrongEvidence = new Map(sources)
  wrongEvidence.set(second.artifactId, { ...second.source, rawContent: '{}' })
  assert.ok(!project(all, wrongEvidence).bodyReferences.has(candidate.id))
  const firstWire = JSON.parse(first.messages[1]!.content)
  firstWire.result.content = firstWire.result.content.replace(/^./, '[')
  const corrupt = [first.messages[0]!, { ...first.messages[1]!, content: JSON.stringify(firstWire) }, ...second.messages]
  assert.equal(project(corrupt).messages.at(-1), second.messages[1], 'a corrupt earlier page cannot witness an overlap')
})

test('a verified visible tool result can supply the candidate body in the dedicated profile', () => {
  const f = fixture(true)
  const raw = { ok: true, result: { text: '子结果保留原有证据。'.repeat(80) } }
  const receipt = { ...f.receipt, toolName: 'read_child_result', callId: 'child-call', resultArtifactId: 'child-artifact' }
  const tool: LlmMessage = { role: 'tool', name: receipt.toolName, toolCallId: receipt.callId,
    content: JSON.stringify({ ...raw, runtime_receipt: receipt }) }
  const body = JSON.stringify(raw, null, 2)
  const meta = { ...f.source.sourceArtifactMeta!, id: receipt.resultArtifactId, byteLength: Buffer.byteLength(body),
    hash: createHash('sha256').update(body).digest('hex'), preview: `${body.slice(0, 640)}\n...` }
  const original = { ...f.source, message: tool, rawContent: JSON.stringify(raw), sourceArtifactId: meta.id, sourceArtifactMeta: meta }
  const evidence = f.engine.addEvidence({ kind: 'artifact', referenceId: meta.id, sourceHash: meta.hash,
    sessionId: 'file-session', observedAt: meta.createdAt })
  const candidate = f.engine.addCandidate({ source: { actor: 'tool', sourceId: 'child-observation', toolName: receipt.toolName,
    capturedAt: meta.createdAt }, rawArtifactId: meta.id, normalizedContent: meta.preview, evidenceRefs: [evidence.id] })
  const document = f.engine.snapshot()
  const header: LlmMessage = { role: 'assistant', content: '', toolCalls: [{ id: receipt.callId, name: receipt.toolName, arguments: {} }] }
  const project = (messages = [header, tool], source = original) => projectFileHistory(messages, document,
    id => id === meta.id ? source : undefined, { groups: [], project: document, hasArchivedSpan: () => false, compactPages: true })
  const result = project()
  assert.deepEqual(result.messages, [header, tool])
  assert.equal(result.bodyReferences.get(candidate.id), meta.id)
  assert.ok(!project([tool]).bodyReferences.has(candidate.id))
  assert.ok(!project([header, tool], { ...original, sourceArtifactMeta: { ...meta, redacted: true } }).bodyReferences.has(candidate.id))
})

test('an exact broad reread can reference earlier coverage in the same run', () => {
  const f = fixture(true)
  const document = f.engine.snapshot()
  const body = f.raw.result.lines[0]!.text
  document.information = [{ id: 'known-line', sectionId: 'information', headingPath: ['交接'], body, status: 'active',
    evidenceRefs: f.candidate.evidenceRefs, sourceCandidateIds: [f.candidate.id], supersedesEntryIds: [], revision: document.revision }]
  const prior = { ...f.source, runId: 'current-run' }
  const makeRead = (result = f.raw.result, runId = 'current-run') => {
    const raw = { ok: true, result }
    const content = JSON.stringify(raw, null, 2)
    const runtime_receipt = { ...f.receipt, callId: 'repeat-call', resultArtifactId: 'new-artifact' }
    return { ...f.source, runId, id: 'repeat-message', sourceArtifactId: 'new-artifact', sequence: prior.sequence + 4,
      rawContent: JSON.stringify(raw), sourceArtifactMeta: { ...f.source.sourceArtifactMeta!, id: 'new-artifact',
        preview: content, byteLength: Buffer.byteLength(content), hash: createHash('sha256').update(content).digest('hex') },
      message: { ...f.source.message, toolCallId: runtime_receipt.callId, content: JSON.stringify({ ...raw, runtime_receipt }) } }
  }
  const witness = { id: 'known-line', scope: 'session' as const, bodyHash: createHash('sha256').update(body).digest('hex') }
  const project = (current = makeRead(), args = { file_name: 'handoff.txt' } as Record<string, unknown>, session = document) =>
    projectFileHistory([{ role: 'assistant', content: '', toolCalls: [{ id: 'repeat-call', name: 'read_file', arguments: args }] }, current.message],
      session, id => id === 'original' ? prior : id === 'new-artifact' ? current : undefined,
      { groups: [], project: document, hasArchivedSpan: () => false, coveredReads: [{ artifactId: 'original', entries: [witness] }] })
  const current = makeRead()
  const compact = project(current)
  const result = JSON.parse(compact.messages[1]!.content)
  assert.equal(result.result.projection, 'verified_repeat')
  assert.equal(result.result.priorArtifactId, 'original')
  assert.equal(result.runtime_receipt.resultArtifactId, 'new-artifact')
  assert.deepEqual(result.result.contextEntryIds, ['known-line'])
  assert.deepEqual(compact.requiredEntries, [witness])
  assert.deepEqual([...compact.repeatedReadCallIds], ['repeat-call'])
  assert.deepEqual(JSON.parse(current.rawContent).result, f.raw.result)
  for (const unchanged of [
    project(makeRead({ ...f.raw.result, path: 'other-file.txt' })),
    project(makeRead(f.raw.result, 'different-run')),
    project(current, { file_name: 'handoff.txt', start_line: 18, end_line: 19 }),
    project(current, undefined, { ...document, information: [] }),
  ]) {
    assert.equal(unchanged.repeatedReadCallIds.size, 0)
    assert.deepEqual(JSON.parse(unchanged.messages[1]!.content).result.lines, f.raw.result.lines)
  }
})

test('compact document views share each verified file source while preserving entry evidence and tree bindings', () => {
  const f = fixture(false)
  const excerpts = readFileExcerpts(f.source.rawContent!, 6000)!
  const evidence = excerpts.map(excerpt => f.engine.addEvidence({ kind: 'artifact', referenceId: 'original', sessionId: 'file-session',
    sourceHash: createHash('sha256').update(f.source.rawContent!).digest('hex'), observedAt: f.source.capturedAt,
    confidence: 'medium', locator: `characters:${excerpt.start}:${excerpt.end}` }))
  const document = f.engine.snapshot()
  delete document.tree
  document.information = excerpts.map((excerpt, index) => ({ id: `entry-${index}`, sectionId: 'information', headingPath: ['交接'],
    body: excerpt.text, status: 'active', evidenceRefs: [evidence[index]!.id], sourceCandidateIds: [f.candidate.id],
    supersedesEntryIds: [], revision: document.revision }))
  const engine = new ContextDocumentEngine(document)
  const coverage = { coveredThrough: 2, retainedMessageIds: [], receiptIds: ['committed'], excerptSources: [{ artifactId: 'original',
    entries: document.information.map(entry => ({ scope: 'session' as const, id: entry.id, bodyHash: createHash('sha256').update(entry.body).digest('hex') })) }] }
  const current = engine.snapshot()
  assert.deepEqual([...coveredFileArtifacts(coverage, { project: current, session: current })], ['original'])
  const changed = { ...current, information: current.information.slice(1) }
  assert.equal(coveredFileArtifacts(coverage, { project: current, session: changed }).size, 0)
  const locateFile = createFileEvidenceResolver(() => f.source)
  const profile = { id: 'compact-shared-file', maxCharacters: 12000, includeStructure: true, compactReferences: true,
    includeSections: ['information' as const], fileEvidenceLocation: (item: typeof evidence[number]) => {
      const found = locateFile(item, document.sessionId, 'session')
      return found && { file: found.file, line: found.line }
    } }
  const view = engine.project(profile)
  assert.equal(readContextTree(view.markdown).version, 2)
  assert.deepEqual(readContextTree(view.markdown).nodes, view.treeNodes)
  assert.equal(readContextTree(view.markdown).fileSources.length, 1)
  assert.deepEqual(readContextEntries(view.markdown).flatMap((entry: { evidence: object[] }) => entry.evidence),
    evidence.map((item, index) => ({ id: item.id, kind: item.kind, referenceId: item.referenceId, file: excerpts[index]!.file,
      line: excerpts[index]!.line, observedAt: item.observedAt, confidence: item.confidence })))
  assert.deepEqual(engine.project(profile), view)
  const replay = engine.project({ ...profile, compactReferences: false })
  assert.equal(readContextTree(replay.markdown).version, 1)
  assert.deepEqual(readContextTree(replay.markdown).nodes, view.treeNodes)
})

test('only a verified successful tool load becomes a model-facing receipt reference', () => {
  for (const notFound of [[], ['missing-tool']]) {
    const f = fixture(false)
    const result = { loaded: ['files'], activeTools: ['read_file'], notFound, blockedHarnesses: [] }
    const raw = { ok: true, result }
    const artifactId = 'load-original', body = JSON.stringify(raw, null, 2)
    const source: ContextHistoryMessage = { ...f.source, sourceArtifactId: artifactId, rawContent: JSON.stringify(raw),
      message: { role: 'tool', name: 'load_resources', toolCallId: 'load-call', content: JSON.stringify({ ...raw,
        runtime_receipt: { kind: 'tool-execution', toolName: 'load_resources', ok: true, status: 'succeeded', callId: 'load-call', resultArtifactId: artifactId } }) },
      sourceArtifactMeta: { ...f.source.sourceArtifactMeta!, id: artifactId, hash: createHash('sha256').update(body).digest('hex'), preview: body, byteLength: Buffer.byteLength(body) } }
    const evidence = f.engine.addEvidence({ kind: 'artifact', referenceId: artifactId, sessionId: 'file-session', sourceHash: source.sourceArtifactMeta!.hash })
    const candidate = f.engine.addCandidate({ source: { actor: 'tool', toolName: 'load_resources', sourceId: 'load-source', capturedAt: source.capturedAt },
      rawArtifactId: artifactId, normalizedContent: body, evidenceRefs: [evidence.id] })
    const before = f.engine.serialize()
    const view = projectFileHistory([], f.engine.snapshot(), id => id === artifactId ? source : undefined)
    const projected = f.engine.project({ id: 'load-model', maxCharacters: 20000, compactReferences: true,
      includeSections: ['candidates'], resourceLoadCandidateIds: view.resourceLoadCandidateIds })
    assert.equal(view.resourceLoadCandidateIds.has(candidate.id), notFound.length === 0)
    assert.equal(projected.markdown.includes('"resource_load_receipt"'), notFound.length === 0)
    assert.equal(projected.markdown.includes('missing-tool'), notFound.length > 0)
    assert.ok(projected.sourceCandidateIds.includes(candidate.id))
    assert.equal(f.engine.serialize(), before)
  }
})

test('incomplete tool groups, changed evidence and differing text cannot produce candidate body references', () => {
  const f = fixture(false)
  const orphan = projectFileHistory(f.messages.slice(1), f.engine.snapshot(), () => f.source)
  assert.deepEqual(orphan.messages, [])
  assert.equal(orphan.bodyReferences.size, 0)
  const invalidSource = { ...f.source, sourceArtifactMeta: { ...f.source.sourceArtifactMeta!, hash: '0'.repeat(64) } }
  const fallback = projectFileHistory(f.messages, f.engine.snapshot(), () => invalidSource)
  assert.deepEqual(fallback.messages, f.messages)
  assert.equal(fallback.hasReferences, false)
  const document = f.engine.snapshot()
  document.candidates[0]!.normalizedContent += '还有一项独立解释。'
  const independentCandidate = projectFileHistory(f.messages, document, () => f.source)
  assert.equal(independentCandidate.bodyReferences.size, 0)
  assert.equal(independentCandidate.hasReferences, true, 'the exact tool result itself can still compact')
  const different = structuredClone(f.messages)
  const payload = JSON.parse(different[1]!.content)
  payload.result.content += '\n原始第 20 行未完整载入。'
  different[1]!.content = JSON.stringify(payload)
  const inconsistent = projectFileHistory(different, document, () => f.source)
  assert.deepEqual(inconsistent.messages, different)
  assert.equal(inconsistent.hasReferences, false)
})

test('readable file locations require the bound session, exact excerpt and verified original', () => {
  const f = fixture(true)
  const span = readFileExcerpts(f.source.rawContent!, Infinity)![0]!
  const evidence = { id: 'excerpt', kind: 'artifact' as const, referenceId: 'original', sessionId: 'file-session',
    sourceHash: createHash('sha256').update(f.source.rawContent!).digest('hex'), locator: `characters:${span.start}:${span.end}` }
  let lookups = 0
  const locate = createFileEvidenceResolver((id, sessionId) => {
    lookups++
    assert.equal(sessionId, 'file-session')
    if (id === 'ambiguous') throw new Error('CONTEXT_SOURCE_ID_AMBIGUOUS')
    return f.source
  })
  assert.equal(locate(evidence, 'different-session', 'session'), undefined)
  assert.equal(locate({ ...evidence, sessionId: undefined }, 'project-context', 'project'), undefined)
  assert.equal(lookups, 0)
  assert.deepEqual(locate(evidence, 'file-session', 'session'), span)
  assert.deepEqual(locate(evidence, 'project-context', 'project'), span)
  assert.equal(locate({ ...evidence, sourceHash: 'different-hash' }, 'file-session', 'session'), undefined)
  assert.equal(locate({ ...evidence, locator: `characters:${span.start + 1}:${span.end}` }, 'file-session', 'session'), undefined)
  assert.equal(lookups, 1)
  assert.equal(locate({ ...evidence, referenceId: 'ambiguous' }, 'file-session', 'session'), undefined)
  const changed = createFileEvidenceResolver(() => ({ ...f.source, sourceArtifactMeta: { ...f.source.sourceArtifactMeta!, redacted: true } }))
  assert.equal(changed(evidence, 'file-session', 'session'), undefined)
})

function chat(loop: RuntimeLoop, sessionId: string, sequence: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error('file projection run timed out')) }, 15000)
    const stop = loop.onEvent(event => {
      if (event.type !== 'run.state.changed' || !['completed', 'failed'].includes(event.payload.status)) return
      clearTimeout(timer)
      stop()
      if (event.payload.status === 'completed') resolve()
      else reject(new Error(event.payload.failure?.message))
    })
    const command: ClientCommand = { version: 1, kind: 'command', id: `file-chat-${sequence}`, sessionId, timestamp: new Date().toISOString(),
      type: 'chat.message.send', payload: { autoStart: true, clientMessageId: `file-user-${sequence}`, content: [{ type: 'text', text: '核对文件依据。' }] } }
    loop.validate(command)
    loop.execute(command, sequence)
  })
}

test('partial file views survive reopening and restore the complete group when a witness changes', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-unresolved-file-lines-'))
  initializeProjectDirectory(projectDir)
  const sessionId = 'unresolved-file-lines'
  const first = '证据甲：先核验 "东门" 和标记😺，才能在 18:15 放行。'
  const second = '证据乙：备用门尚未验收，建议等到 21:30。'
  const unresolved = '附件号缺失，适用范围待核对。'
  const noise = `无关的${'值班室茶杯、柜门、摆设和窗帘清单'.repeat(10)}已登记。`
  const files = { 'first.txt': [first, noise, unresolved], 'second.txt': [second + unresolved, noise], 'old.txt': [noise, noise] }
  for (const [name, lines] of Object.entries(files)) fs.writeFileSync(path.join(projectDir, name), lines.join('\n'))
  new ProjectResources(projectDir).saveSettings({ context_organization_version: 4 })
  const requests: LlmChatRequest[] = []
  const config: RuntimeLlm['getConfig'] = () => ({ provider: 'custom', protocol: 'responses', model: 'test',
    baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 })
  const ready = { provider: 'custom' as const, model: 'test', raw: {}, text: '{"status":"completed","content":"已核对放行条件。"}' }
  const actor: RuntimeLlm = { getConfig: config, async chat(request) {
    requests.push(request)
    const toolCalls = requests.length === 1
      ? [{ id: 'load', name: 'load_resources', arguments: { ids: ['project-files:read_file'] } }]
      : requests.length === 2 ? Object.keys(files).map(file => ({ id: file, name: 'read_file', arguments: { file_name: file } })) : []
    return { ...ready, toolCalls, text: toolCalls.length ? '' : ready.text }
  } }
  const organizer: RuntimeLlm = { getConfig: config, async chat(request) {
    const packet = JSON.parse(request.messages[1]!.content)
    assert.equal(packet.organizationVersion, 4)
    const choices = packet.sources.map((source: { text: string }) => source.text.startsWith('证据') ? 'K' : source.text === unresolved ? 'R' : 'A')
    return { ...ready, text: JSON.stringify({ batch: packet.batch, choices, heading: '放行条件' }) }
  } }
  const loop = new RuntimeLoop({ projectDir, sessionId, llm: actor, contextOrganization: { minGroups: 1, llm: organizer }, stepDelayMs: 0, streamDelayMs: 0 })
  const payload = (request: LlmChatRequest, id: string) => JSON.parse(request.messages.find(message => message.toolCallId === id)!.content)
  try {
    await chat(loop, sessionId, 1)
    assert.equal(requests.length, 3)
    const state = loop.exportState()
    const coverage = state.contextHistory!.coverage
    const originals = state.contextHistory!.messages.filter(item => item.message.name === 'read_file')
    assert.equal(originals.length, 3)
    assert.ok(originals.every(item => item.sequence > coverage.coveredThrough))
    assert.equal(coverage.partialFileGroups?.length, 1)
    const initial = requests.at(-1)!
    assert.deepEqual(payload(initial, 'first.txt').result.lines, [{ line: 3, text: unresolved }])
    assert.deepEqual(payload(initial, 'second.txt').result.lines, [{ line: 1, text: second + unresolved }])
    assert.deepEqual(payload(initial, 'old.txt').result.lines, [])
    assert.deepEqual(payload(initial, 'first.txt').result.contextLines, [1])
    assert.deepEqual(payload(initial, 'second.txt').result.contextLines, [])
    assert.deepEqual(payload(initial, 'old.txt').result.contextLines, [])
    assert.deepEqual(payload(initial, 'first.txt').result.lineDisposition, { published: 1, archived: 1, mixed: 0, visible: 1 })
    assert.deepEqual(payload(initial, 'second.txt').result.lineDisposition, { published: 0, archived: 1, mixed: 0, visible: 1 })
    assert.deepEqual(payload(initial, 'old.txt').result.lineDisposition, { published: 0, archived: 2, mixed: 0, visible: 0 })
    assert.ok(initial.messages[0]!.content.includes(first) && initial.messages[0]!.content.includes(second))
    assert.match(initial.messages[0]!.content, /`unresolved_lines`/)
    const evidenceRefs = (request: LlmChatRequest) => {
      const content = request.messages[0]!.content
      const project = content.indexOf('# Project Context'), session = content.indexOf('# Session Context')
      return [content.slice(project, session), content.slice(session)].flatMap(section =>
        section.includes('<!-- capybara:entry-ref') ? readContextEntries(section).flatMap((entry: { evidence: Array<{ referenceId?: string; file?: string; line?: number }> }) => entry.evidence) : [])
    }
    const expectedLocations = originals.slice(0, 2).map(original => ({ referenceId: original.sourceArtifactId, file: original.message.toolCallId, line: 1 }))
    const locations = (request: LlmChatRequest) => evidenceRefs(request).map(({ referenceId, file, line }) => ({ referenceId, file, line }))
    assert.deepEqual(locations(initial), expectedLocations)
    for (const original of originals) {
      const result = payload(initial, original.message.toolCallId!)
      assert.deepEqual(result.runtime_receipt, JSON.parse(original.message.content).runtime_receipt)
      assert.equal(result.result.projection, 'unresolved_lines')
    }
    loop.close()
    const archived = originals.find(item => item.message.toolCallId === 'old.txt')!
    const firstRead = originals.find(item => item.message.toolCallId === 'first.txt')!
    let pages = 0
    const sourceReader: RuntimeLlm = { getConfig: config, async chat(request) {
      assert.equal(payload(request, 'old.txt').result.projection, 'unresolved_lines')
      assert.deepEqual(locations(request), expectedLocations)
      if (++pages === 1) return { ...ready, text: '', toolCalls: [
        { id: 'read-original', name: 'read_runtime_artifact', arguments: { artifact_id: archived.sourceArtifactId, source_scope: 'session', offset: 0, limit: 2000 } },
        { id: 'read-lines', name: 'read_runtime_artifact', arguments: { artifact_id: firstRead.sourceArtifactId, source_scope: 'session', start_line: 1, end_line: 3 } },
      ] }
      assert.equal(payload(request, 'read-original').result.content, archived.rawContent)
      assert.deepEqual(payload(request, 'read-lines').result.lines, files['first.txt'].map((text, i) => ({ line: i + 1, text })))
      return ready
    } }
    const reopened = new RuntimeLoop({ projectDir, sessionId, llm: sourceReader, initialState: { ...state, artifacts: [] },
      contextOrganization: { minGroups: 1000 }, stepDelayMs: 0, streamDelayMs: 0 })
    let afterPage: ReturnType<RuntimeLoop['exportState']>
    try {
      await chat(reopened, sessionId, 2)
      assert.equal(pages, 2)
      afterPage = reopened.exportState()
    } finally { reopened.close() }
    const store = new ContextCommitStore(projectDir)
    try {
      assert.deepEqual(store.loadCoverage(sessionId)?.partialFileGroups, coverage.partialFileGroups)
      const originalHistory = new ContextHistory(state.contextHistory).project()
      const partial = { groups: coverage.partialFileGroups!, project: state.projectContextDocument! }
      const verify = (hasArchivedSpan: (messageId: string, start: number, end: number, hash: string, receiptId: string) => boolean) =>
        projectFileHistory(originalHistory, state.contextDocument!, id => store.readSource(id, sessionId), { ...partial, hasArchivedSpan })
      assert.deepEqual([...verify((messageId, start, end, hash, receiptId) =>
        store.hasArchivedSpan(sessionId, messageId, start, end, hash, receiptId)).verifiedPartialGroupIds], [partial.groups[0]!.groupId])
      const afterPageHistory = new ContextHistory(afterPage.contextHistory).project()
      const page = afterPage.contextHistory!.messages.find(item => item.message.toolCallId === 'read-lines')!
      assert.ok(page.runId)
      const projectPage = (currentRunId: string, archiveValid = true) => projectFileHistory(afterPageHistory, state.contextDocument!,
        id => store.readSource(id, sessionId), { ...partial, compactPages: true, currentRunId,
          hasArchivedSpan: (messageId, start, end, hash, receiptId) => archiveValid && store.hasArchivedSpan(sessionId, messageId, start, end, hash, receiptId) })
      const wire = (view: ReturnType<typeof projectFileHistory>) => JSON.parse(view.messages.find(message => message.toolCallId === 'read-lines')!.content)
      const laterView = projectPage('next-run')
      assert.deepEqual(wire(laterView).result.lines, [{ line: 3, text: unresolved }])
      assert.equal(wire(laterView).result.projection, 'historical_file_lines')
      assert.deepEqual(wire(laterView).runtime_receipt, JSON.parse(page.message.content).runtime_receipt)
      assert.deepEqual(wire(projectPage(page.runId)).result.lines, JSON.parse(page.rawContent!).result.lines)
      assert.deepEqual(wire(projectPage('next-run', false)).result.lines, JSON.parse(page.rawContent!).result.lines)
      const toolHeader = originalHistory.findIndex(message => message.toolCalls?.some(call => call.name === 'read_file'))
      const originalHeader = originalHistory[toolHeader]!
      const childResult: LlmMessage = { role: 'tool', name: 'read_child_result', toolCallId: 'child-result', content: '子任务的原始证据。' }
      const mixedHistory = [...originalHistory]
      mixedHistory[toolHeader] = { ...originalHeader, toolCalls: [...originalHeader.toolCalls!,
        { id: childResult.toolCallId!, name: childResult.name!, arguments: {} }] }
      const verifyMixed = () => projectFileHistory(mixedHistory, state.contextDocument!, id => store.readSource(id, sessionId),
        { ...partial, hasArchivedSpan: (...args) => store.hasArchivedSpan(sessionId, ...args) })
      assert.equal(verifyMixed().verifiedPartialGroupIds.size, 0, 'an incomplete tool group cannot project any of its results')
      mixedHistory.splice(toolHeader + 1, 0, childResult)
      const mixed = verifyMixed()
      assert.deepEqual([...mixed.verifiedPartialGroupIds], [partial.groups[0]!.groupId])
      assert.deepEqual(mixed.messages.find(message => message.toolCallId === childResult.toolCallId), childResult)
      assert.equal(JSON.parse(mixed.messages.find(message => message.toolCallId === 'first.txt')!.content).result.projection, 'unresolved_lines')
      const withheldArchive = verify(() => false)
      assert.equal(withheldArchive.hasPartialViews, false)
      assert.equal(withheldArchive.requiredEntries.length, 0)
      assert.equal(withheldArchive.verifiedPartialGroupIds.size, 0)
      const saved = store.loadDocument(sessionId)!
      const engine = new ContextDocumentEngine(saved.document, saved.receipts, saved.projections, saved.reviewReceipts, saved.evidenceReviewReceipts)
      const entry = saved.document.information.find(item => item.body === first)!
      const projection = engine.project({ id: 'withdraw', maxCharacters: 20_000, includeSections: ['information', 'candidates'],
        includeStatuses: ['accepted', 'pending'], pinnedEntryIds: [entry.id], pinnedCandidateIds: entry.sourceCandidateIds })
      const receipt = engine.apply(engine.propose({ projection, candidateId: entry.sourceCandidateIds[0]!,
        target: { section: 'information', entryId: entry.id }, operation: 'mark_status', payload: { status: 'archived' }, actor: 'system',
        idempotencyKey: 'withdraw-partial-view-witness' }))
      assert.equal(receipt.result, 'applied')
      store.saveSession(sessionId, engine.exportState())
    } finally { store.close() }
    const invalidated = new RuntimeLoop({ projectDir, sessionId, llm: actor, initialState: state, contextOrganization: { minGroups: 1000 }, stepDelayMs: 0, streamDelayMs: 0 })
    try {
      await chat(invalidated, sessionId, 3)
      const final = requests.at(-1)!
      assert.doesNotMatch(final.messages[0]!.content, /`unresolved_lines`/)
      for (const [id, lines] of Object.entries(files)) {
        const restored = payload(final, id)
        assert.equal(restored.result.projection, undefined)
        assert.deepEqual(restored.result.lines.map((line: { text: string }) => line.text), lines)
      }
    } finally { invalidated.close() }

    let unpublishedEvidenceId: string
    const projectStore = new ContextCommitStore(projectDir)
    try {
      const saved = projectStore.loadDocument()!
      const project = new ContextDocumentEngine(saved.document, saved.receipts, saved.projections, saved.reviewReceipts, saved.evidenceReviewReceipts)
      const entry = state.contextDocument!.information.find(item => item.body === first)!
      const source = state.contextDocument!.evidence.find(item => item.id === entry.evidenceRefs[0])!
      const evidence = project.addEvidence(source)
      const unpublished = state.contextDocument!.evidence.find(item => item.referenceId === originals[1]!.sourceArtifactId && item.locator?.startsWith('characters:'))!
      unpublishedEvidenceId = project.addEvidence(unpublished).id
      const candidate = project.addCandidate({ source: { actor: 'tool', toolName: 'read_file', sourceId: source.referenceId, capturedAt: source.observedAt! },
        rawArtifactId: source.referenceId, normalizedContent: entry.body, evidenceRefs: [evidence.id] })
      const receipt = project.apply(project.propose({ projection: project.project({ id: 'project-file', maxCharacters: 10_000 }),
        candidateId: candidate.id, target: { section: 'information' }, operation: 'add_entry', payload: { body: entry.body }, actor: 'system', idempotencyKey: 'project-file' }))
      assert.equal(receipt.result, 'applied')
      projectStore.saveProject(project.exportState(), saved.document.revision)
    } finally { projectStore.close() }
    fs.writeFileSync(path.join(projectDir, 'first.txt'), '该路径的现行内容已变更。')
    const nextSession = 'project-file-next-session'
    let useUnpublishedEvidence = false
    const proseReply = `原件写道：“${first}”`
    let prose = false
    let quoteOutputError: 'FILE_QUOTE_REPLY_SOURCE_MISMATCH' | 'FILE_QUOTE_REPLY_NOT_JSON' | 'FILE_QUOTE_TARGET_MUST_BE_NULL' | undefined
    const repairedErrors: string[] = []
    const projectReader: RuntimeLlm = { getConfig: config, async chat(request) {
      assert.equal(request.messages.some(message => message.name === 'read_file'), false)
      assert.deepEqual(locations(request), [expectedLocations[0]])
      const binding = JSON.parse(request.messages[0]!.content.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)![0])
      const repairMessage = request.messages.at(-1)?.content ?? ''
      const repairing = quoteOutputError && repairMessage.includes(quoteOutputError)
      if (quoteOutputError && repairing) {
        repairedErrors.push(quoteOutputError)
        assert.match(repairMessage, /only the final JSON object or array/)
      }
      const claim = { file: 'first.txt', line: !repairing && quoteOutputError === 'FILE_QUOTE_REPLY_SOURCE_MISMATCH' ? 83 : 1,
        quote: !repairing && quoteOutputError === 'FILE_QUOTE_TARGET_MUST_BE_NULL' ? `${first}（新增）` : first }
      const envelope: ControlEnvelopeV2 = { envelopeVersion: 2, binding, decision: 'finish', actions: [], planProposal: null,
        candidateDiffs: [], evidenceRequests: [], uncertainties: [], waitSpec: null,
        userMessage: JSON.stringify(useUnpublishedEvidence ? { claims: [claim, { quote: null }] } : { claims: [claim] }),
        fileQuotes: [{ scope: 'project', evidenceId: evidenceRefs(request)[0]!.id, target: '/claims/0/quote' }],
        completionCheck: { taskId: binding.taskId, requiredEvidenceRefs: [], requiredActions: [], unresolvedUncertaintyIds: [], summary: '引用项目原件' } }
      if (useUnpublishedEvidence) envelope.fileQuotes!.push({ scope: 'project', evidenceId: unpublishedEvidenceId, target: '/claims/1/quote' })
      if (prose) {
        envelope.userMessage = proseReply
        if (repairing) {
          assert.match(repairMessage, /preserve the requested text format and omit fileQuotes/)
          delete envelope.fileQuotes
        }
      } else if (!repairing && quoteOutputError === 'FILE_QUOTE_REPLY_NOT_JSON') envelope.userMessage += '\n说明：以上引文来自原件。'
      return { ...ready, text: JSON.stringify(envelope) }
    }, async stream(request, emit) {
      const response = await this.chat(request)
      emit(response.text.slice(0, 80))
      emit(response.text.slice(80))
      return response
    } }
    const crossSession = new RuntimeLoop({ projectDir, sessionId: nextSession, llm: projectReader,
      contextOrganization: { minGroups: 1000 }, stepDelayMs: 0, streamDelayMs: 0 })
    const deltas: string[] = []
    crossSession.onEvent(event => {
      if (event.type === 'chat.assistant.delta' && event.payload.channel === 'final') deltas.push(event.payload.delta)
    })
    try {
      await chat(crossSession, nextSession, 4)
      const reply = JSON.stringify({ claims: [{ file: 'first.txt', line: 1, quote: first }] })
      assert.equal(deltas.join(''), reply)
      const completed = crossSession.exportState()
      assert.ok(completed.contextHistory!.messages.some(item => item.message.role === 'assistant' && item.message.content === reply))
      const receipt = completed.snapshot.timeline.steps.find(step => step.detail?.resolvedFileQuotes)?.detail?.resolvedFileQuotes
      assert.match(JSON.stringify(receipt), /"file":"first.txt","line":1/)
      assert.match(JSON.stringify(receipt), new RegExp(createHash('sha256').update(first).digest('hex')))
      deltas.length = 0
      const errors = ['FILE_QUOTE_REPLY_SOURCE_MISMATCH', 'FILE_QUOTE_REPLY_NOT_JSON', 'FILE_QUOTE_TARGET_MUST_BE_NULL'] as const
      for (const [index, error] of errors.entries()) {
        quoteOutputError = error
        await chat(crossSession, nextSession, index + 5)
        assert.equal(deltas.join(''), reply)
        deltas.length = 0
      }
      assert.deepEqual(repairedErrors, errors)
      quoteOutputError = 'FILE_QUOTE_REPLY_NOT_JSON'
      prose = true
      await chat(crossSession, nextSession, 8)
      assert.equal(deltas.join(''), proseReply)
      deltas.length = 0
      prose = false
      quoteOutputError = undefined
      useUnpublishedEvidence = true
      await assert.rejects(chat(crossSession, nextSession, 9), /FILE_QUOTE_EVIDENCE_NOT_AVAILABLE/)
      assert.deepEqual(deltas, [])
    } finally { crossSession.close() }
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('main requests use one copy of real file results and reopening can page the full original', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-file-projection-'))
  initializeProjectDirectory(projectDir)
  const sessionId = 'file-projection-session'
  const text = ['A：审核 "东门" 后才能切换。'.repeat(8), 'B：资料尚未齐备，不得移交😺。'.repeat(8)].join('\n')
  fs.writeFileSync(path.join(projectDir, 'handoff.txt'), text)
  new ProjectResources(projectDir).saveSettings({ context_organization_version: 4,
    context: { context_window_tokens: 24000, max_input_tokens: 20000, reserved_output_tokens: 2048 } })
  const requests: LlmChatRequest[] = []
  const config: RuntimeLlm['getConfig'] = () => ({ provider: 'custom', protocol: 'responses', model: 'test',
    baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 })
  const finish = { provider: 'custom' as const, model: 'test', raw: {}, text: '{"status":"completed","content":"证据已核对。"}' }
  const actor: RuntimeLlm = { getConfig: config, async chat(request) {
    requests.push(request)
    if (requests.length === 1) return { ...finish, text: '', toolCalls: [{ id: 'load', name: 'load_resources', arguments: { ids: ['project-files:read_file'] } }] }
    if (requests.length === 2) return { ...finish, text: '', toolCalls: [
      { id: 'real-read', name: 'read_file', arguments: { file_name: 'handoff.txt', include_line_numbers: false } },
      { id: 'failed-read', name: 'read_file', arguments: { file_name: 'missing-file.txt' } },
    ] }
    const binding = JSON.parse(request.messages[0]!.content.split('\n').find(line => line.startsWith('{"sessionId":'))!)
    const read = JSON.parse(request.messages.find(message => message.toolCallId === 'real-read')!.content)
    const output: ControlEnvelopeV2 = {
      envelopeVersion: 2, binding, decision: 'finish', userMessage: '{"file":"handoff.txt","line":2,"quote":null}',
      actions: [], planProposal: null, candidateDiffs: [], evidenceRequests: [], waitSpec: null, uncertainties: [],
      fileQuotes: [{ scope: 'session', readArtifactId: read.runtime_receipt.resultArtifactId, target: '/quote' }],
      completionCheck: { taskId: binding.taskId, requiredActions: ['call:real-read'], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '按已读取原行引用' },
    }
    return { ...finish, text: JSON.stringify(output) }
  } }
  const loop = new RuntimeLoop({ projectDir, sessionId, llm: actor, contextOrganization: { minGroups: 1000 }, stepDelayMs: 0, streamDelayMs: 0 })
  try {
    await chat(loop, sessionId, 1)
    assert.equal(requests.length, 3)
    const state = loop.exportState()
    const delivered = state.snapshot.conversation.messages.filter(message => message.role === 'assistant' && message.status === 'completed').at(-1)!
    assert.deepEqual(JSON.parse(delivered.content[0]!.text!), { file: 'handoff.txt', line: 2, quote: text.split('\n')[1] })
    const quoteReceipts = state.snapshot.timeline.steps.find(step => step.detail?.resolvedFileQuotes)?.detail?.resolvedFileQuotes as Array<{ readArtifactId: string }>
    const stored = state.contextHistory!.messages.find(item => item.message.toolCallId === 'real-read')!
    assert.deepEqual(quoteReceipts?.map(receipt => receipt.readArtifactId), [stored.sourceArtifactId])
    const failed = state.contextHistory!.messages.find(item => item.message.toolCallId === 'failed-read')!
    const actual = requests[2]!.messages
    const wire = JSON.parse(actual.find(message => message.toolCallId === 'real-read')!.content)
    assert.deepEqual(wire.result.contentRef, { field: 'lines', numbered: false })
    assert.equal(wire.result.lines.map((line: { text: string }) => line.text).join('\n'), text)
    assert.deepEqual(wire.runtime_receipt, JSON.parse(stored.message.content).runtime_receipt)
    assert.equal(JSON.parse(stored.rawContent!).result.content, text)
    assert.equal(actual.find(message => message.toolCallId === 'failed-read')!.content, failed.message.content)
    const candidate = state.contextDocument!.candidates.find(item => item.rawArtifactId === stored.sourceArtifactId)!
    const reference = [...actual[0]!.content.matchAll(/<!-- capybara:candidate-ref data=(\{[^\n]+?\}) -->/g)]
      .map(match => JSON.parse(match[1]!))
      .find(item => item.id === candidate.id)
    assert.equal(reference?.body, 'tool_result')
    assert.equal(reference?.rawArtifactId, wire.runtime_receipt.resultArtifactId)
    assert.ok(!actual[0]!.content.includes(candidate.normalizedContent))
    assert.ok(actual[0]!.content.includes('文件正文在 `result.lines`'))
    assert.equal(state.contextHistory!.coverage.coveredThrough, 0)
    loop.close()
    let calls = 0
    const sourceReader: RuntimeLlm = { getConfig: config, async chat(request) {
      if (++calls === 1) {
        assert.deepEqual(JSON.parse(request.messages.find(message => message.toolCallId === 'real-read')!.content).result.contentRef,
          { field: 'lines', numbered: false })
        return { ...finish, text: '', toolCalls: [
          { id: 'path-in-artifact-id', name: 'read_runtime_artifact', arguments: { artifact_id: 'handoff.txt', source_scope: 'project' } },
          { id: 'unseen-path', name: 'read_runtime_artifact', arguments: { artifact_id: 'unseen.txt', source_scope: 'project' } },
        ] }
      }
      if (calls === 2) {
        const rejected = JSON.parse(request.messages.find(message => message.toolCallId === 'path-in-artifact-id')!.content)
        const unseen = JSON.parse(request.messages.find(message => message.toolCallId === 'unseen-path')!.content)
        assert.equal(rejected.ok, false)
        assert.equal(rejected.runtime_receipt.status, 'failed')
        assert.equal(rejected.error.code, 'INVALID_ARGUMENTS')
        assert.match(rejected.error.message, /ARTIFACT_SOURCE_REFERENCE_REQUIRED/)
        assert.ok(rejected.error.message.includes(`artifact_id ${JSON.stringify(stored.sourceArtifactId)} and source_scope "session"`))
        assert.equal(unseen.ok, false)
        assert.ok(!unseen.error.message.includes(stored.sourceArtifactId))
        assert.ok(!unseen.error.message.includes('unseen.txt'))
        return { ...finish, text: '', toolCalls: [{ id: 'read-original', name: 'read_runtime_artifact',
          arguments: { artifact_id: stored.sourceArtifactId, source_scope: 'session', offset: 0, limit: 2000 } }] }
      }
      const page = JSON.parse(request.messages.find(message => message.toolCallId === 'read-original')!.content)
      assert.equal(page.ok, true)
      assert.equal(page.result.content, stored.rawContent)
      if (calls === 3) return { ...finish, text: '', toolCalls: [
        { id: 'exact-line', name: 'read_runtime_artifact', arguments: { artifact_id: stored.sourceArtifactId, start_line: 2, end_line: 2 } },
        { id: 'wrapped-lines', name: 'read_runtime_artifact', arguments: { artifact_id: page.runtime_receipt.resultArtifactId, start_line: 2, end_line: 2 } },
        { id: 'invalid-range', name: 'read_runtime_artifact', arguments: { artifact_id: stored.sourceArtifactId, start_line: 1, end_line: 2, offset: 0 } },
        { id: 'foreign-scope', name: 'read_runtime_artifact', arguments: { artifact_id: stored.sourceArtifactId, start_line: 1, end_line: 1, source_scope: 'project' } },
      ] }
      const exact = JSON.parse(request.messages.find(message => message.toolCallId === 'exact-line')!.content)
      assert.deepEqual(exact.result.lines, [{ line: 2, text: text.split('\n')[1] }])
      assert.equal(exact.result.file, 'handoff.txt')
      assert.equal(exact.result.mode, 'file_lines')
      assert.equal(exact.result.source_scope, 'session')
      const wrapped = JSON.parse(request.messages.find(message => message.toolCallId === 'wrapped-lines')!.content)
      assert.equal(wrapped.ok, false)
      assert.match(wrapped.error.message, /FILE_PAGE_REQUIRES_ORIGINAL/)
      assert.ok(wrapped.error.message.includes(JSON.stringify(stored.sourceArtifactId)))
      for (const id of ['invalid-range', 'foreign-scope']) {
        assert.equal(JSON.parse(request.messages.find(message => message.toolCallId === id)!.content).ok, false)
      }
      return finish
    } }
    const restored = new RuntimeLoop({ projectDir, sessionId, llm: sourceReader, initialState: { ...state, artifacts: [] },
      contextOrganization: { minGroups: 1000 }, stepDelayMs: 0, streamDelayMs: 0 })
    try {
      await chat(restored, sessionId, 2)
      assert.equal(calls, 4)
      assert.equal(restored.exportState().contextDocument!.candidates.find(item => item.id === candidate.id)?.normalizedContent, candidate.normalizedContent)
    } finally { restored.close() }
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('file result duplication alone does not trigger an organizer call below the group threshold', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-file-pressure-'))
  initializeProjectDirectory(projectDir)
  const files = ['planning.txt', 'handoff.txt', 'inspection.txt', 'review.txt', 'inventory.txt', 'acceptance.txt']
  for (const file of files) {
    const lines = Array.from({ length: 10 }, (_, i) => `${i + 1} ${'交接资料由两个来源同时留档，再依照现场条件复核。'.repeat(5)}`)
    fs.writeFileSync(path.join(projectDir, file), lines.join('\n'))
  }
  const sessionId = 'file-pressure'
  const maxInputTokens = 20_000
  const pressureThreshold = maxInputTokens * 0.25
  new ProjectResources(projectDir).saveSettings({ context_organization_version: 4,
    context: { context_window_tokens: 24_000, max_input_tokens: maxInputTokens, reserved_output_tokens: 2_000 } })
  const requests: LlmChatRequest[] = []
  const config: RuntimeLlm['getConfig'] = () => ({ provider: 'custom', protocol: 'responses', model: 'test',
    baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 })
  let organizerRequests = 0
  const actor: RuntimeLlm = { getConfig: config, async chat(request) {
    requests.push(request)
    const response = { provider: 'custom' as const, model: 'test', raw: {}, text: '' }
    if (requests.length === 1) return { ...response, toolCalls: [{ id: 'load-file', name: 'load_resources', arguments: { ids: ['project-files:read_file'] } }] }
    if (requests.length === 2) return { ...response, toolCalls: files.map(file => ({
      id: `read-${file}`, name: 'read_file', arguments: { file_name: file },
    })) }
    return { ...response, text: '{"status":"completed","content":"已核对资料。"}' }
  } }
  const loop = new RuntimeLoop({ projectDir, sessionId, llm: actor, stepDelayMs: 0, streamDelayMs: 0,
    contextOrganization: { llm: { getConfig: config, async chat() { organizerRequests++; throw new Error('unexpected organizer invocation') } } } })
  try {
    await chat(loop, sessionId, 1)
    assert.equal(requests.length, 3)
    const history = new ContextHistory(loop.exportState().contextHistory)
    const measure = (messages: LlmMessage[]) => Math.ceil(JSON.stringify({ messages, tools: [] }).length / 4)
    const rawTokens = measure(history.project())
    const projectedTokens = measure(requests[2]!.messages.slice(1))
    assert.ok(rawTokens > pressureThreshold, `raw history estimate ${rawTokens} must exceed the pressure threshold`)
    assert.ok(projectedTokens < pressureThreshold, `projected history estimate ${projectedTokens} must fit below the pressure threshold`)
    assert.equal(organizerRequests, 0)
    for (const file of files) {
      const message = requests[2]!.messages.find(item => item.toolCallId === `read-${file}`)
      assert.ok(message && JSON.parse(message.content).result?.contentRef, `${file} has a reversible projection`)
    }
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})
