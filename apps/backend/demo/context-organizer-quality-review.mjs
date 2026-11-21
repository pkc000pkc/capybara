import assert from 'node:assert/strict'
import fs from 'node:fs'
import { SessionStore } from '../dist/core/session-store.js'

const [scenarioId, reportPath, expandedFactsPath, pairedAnswersPath] = process.argv.slice(2)
if (!scenarioId || !reportPath) {
  throw new Error('Usage: node demo/context-organizer-quality-review.mjs <scenario ID> <runtime report path> [reviewed facts path] [paired answers path]')
}

const materialsExpected = expandedFactsPath ? JSON.parse(fs.readFileSync(expandedFactsPath, 'utf8'))
  : JSON.parse(fs.readFileSync(new URL('../test/fixtures/context-organizer-quality-cases.json', import.meta.url), 'utf8')).test.find(item => item.id === scenarioId)
assert.ok(materialsExpected, 'Select a held-out scenario or supply its reviewed facts')
assert.equal(materialsExpected.id, scenarioId)
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8').trimEnd().split(/\r?\n/u).at(-1))
const store = new SessionStore(report.projectDir)
const normalize = text => text.normalize('NFKC').replace(/\s/gu, '')

function fileResult(content) {
  try {
    return JSON.parse(content)?.result
  } catch { return undefined }
}

function visibleReadText(content) {
  const result = fileResult(content)
  if (Array.isArray(result?.lines)) return result.lines.map(line => line.text ?? '').join('\n')
  if (typeof result?.content === 'string') return result.content
  return content
}

function reviewTimedAnswers(paired, sources) {
  const reads = sources.filter(source => source.origin === 'tool' && source.message.name === 'read_file')
    .map(source => fileResult(source.rawContent)).filter(Boolean)
  const expected = materialsExpected.materials.filter(material => material.timedClaim).map(material => {
    const { match: id, timedClaim } = material
    const matched = reads.flatMap(read => read.lines.filter(line => line.text.includes(id)).map(line => ({ file: read.path, ...line })))
    assert.equal(matched.length, 1, `Expected one original line for ${id}`)
    const { file, line, text: quote } = matched[0]
    assert.ok(material.text.split(/\r?\n/u).includes(quote), `Source differs from reviewed line for ${id}`)
    return { id, file, line, quote, ...timedClaim, alternatives: material.timedClaimAlternatives ?? {} }
  })
  assert.ok(expected.length, 'Timed answer review requires independently reviewed timedClaim labels')
  const fields = ['file', 'line', 'quote', 'time', 'timeUse', 'action', 'prerequisites', 'observedStates', 'prohibitions']
  const canonical = value => Array.isArray(value) ? value.map(canonical).sort()
    : typeof value === 'string' ? normalize(value) : value
  return Object.fromEntries(['raw', 'optimized'].map(arm => {
    const structuredRound = paired[arm]?.rounds?.at(-1)
    let parsed
    try {
      const answer = structuredRound.answer.trim().replace(/^```(?:json)?\s*\n|\n```$/gu, '')
      parsed = JSON.parse(answer)
    } catch { /* Report an invalid visible answer without borrowing text from another round. */ }
    const validShape = Array.isArray(parsed?.claims) && Object.keys(parsed).length === 1
      && parsed.claims.every(claim => claim && typeof claim.id === 'string' && Object.keys(claim).every(key => key === 'id' || fields.includes(key)))
    const outputs = validShape ? parsed.claims : []
    const rows = expected.map(target => {
      const byId = outputs.filter(claim => claim.id === target.id)
      const matches = byId.length ? byId : outputs.filter(claim => claim.file === target.file && claim.line === target.line)
      const wrongFields = ['id', ...fields].filter(key => {
        if (['id', 'file', 'quote'].includes(key)) return matches[0]?.[key] !== target[key]
        const actual = JSON.stringify(canonical(matches[0]?.[key]))
        return ![target[key], ...(target.alternatives[key] ?? [])].some(allowed => actual === JSON.stringify(canonical(allowed)))
      })
      return { id: target.id, observedCount: matches.length, wrongFields, accepted: matches.length === 1 && wrongFields.length === 0 }
    })
    const unexpectedIds = outputs.filter(claim => !expected.some(target => target.id === claim.id)).map(claim => claim.id)
    return [arm, { validShape, unexpectedIds, rows, accepted: structuredRound?.status === 'completed' && validShape
      && unexpectedIds.length === 0 && rows.every(row => row.accepted) }]
  }))
}

try {
  const state = store.get(report.committed.id)?.state
  assert.ok(state?.contextDocument && state.contextHistory, 'Expected a persisted runtime session')
  const active = state.contextDocument.information.filter(entry => entry.status === 'active')
  const evidence = new Map(state.contextDocument.evidence.map(entry => [entry.id, entry]))
  const activeProject = state.projectContextDocument?.information.filter(entry => entry.status === 'active') ?? []
  const coveredThrough = state.contextHistory.coverage.coveredThrough
  const sourceArchives = (state.contextTrainingSamples ?? []).flatMap(sample => sample.organization?.sourceArchives ?? [])
  const attempts = (state.contextTrainingSamples ?? []).flatMap(sample => sample.organization?.attempts ?? [])
  const inputPackets = attempts.map(attempt => JSON.parse(attempt.messages.at(-1).content))
  const modelPacket = inputPackets.flatMap(packet => Array.isArray(packet.sources) ? packet.sources : [])
  const extractive = inputPackets.some(packet => packet.organizationVersion === 3 || packet.organizationVersion === 4)
  const mainRequest = state.artifacts.findLast(artifact => artifact.meta.kind === 'model-request'
    && artifact.value?.capabilityProjection && Array.isArray(artifact.value.messages))
  const mainMessages = mainRequest?.value.messages ?? []
  const allOutput = normalize(active.map(entry => entry.body).join('\n'))
  const materials = materialsExpected.materials.map(material => {
    const original = state.contextHistory.messages.find(entry => entry.origin === 'tool'
      && entry.message.name === 'read_file' && entry.rawContent?.includes(material.match))
    const inputSeen = modelPacket.some(source => source.origin === 'tool' && source.text.includes(material.match))
    const rawId = original?.sourceArtifactId ?? original?.id
    const sourceEntries = rawId ? active.filter(entry => entry.evidenceRefs.some(id => evidence.get(id)?.referenceId === rawId)) : []
    const evidenceText = normalize(sourceEntries.map(entry => entry.body).join('\n'))
    const rawCandidates = state.contextDocument.candidates.filter(candidate => candidate.rawArtifactId === rawId
      && candidate.source.actor === 'tool' && candidate.source.toolName === 'read_file')
    const rawInMain = mainMessages.filter(message => message.role === 'tool'
      ? message.name === 'read_file' && original?.message.toolCallId && message.toolCallId === original.message.toolCallId
      : message.role === 'system' && rawCandidates.some(candidate =>
        message.content.includes(`## ${candidate.id}\n状态：${candidate.status}\n${candidate.normalizedContent}`)))
    const fileViews = rawInMain.filter(message => message.role === 'tool').map(message => fileResult(message.content))
    const requiredMatch = (text, term) => [term, ...(material.alternatives?.[term] ?? [])].some(value => text.includes(normalize(value)))
    const required = Object.fromEntries((material.required ?? []).map(term => [term, requiredMatch(evidenceText, term)]))
    const noise = Object.fromEntries((material.noise ?? []).map(term => [term, allOutput.includes(normalize(term))]))
    const archiveSpans = original ? sourceArchives.flatMap(archive => archive.sourceSpans?.filter(span => span.messageId === original.id) ?? []) : []
    const archivedText = normalize(archiveSpans.map(span => original.rawContent.slice(span.start, span.end)).join('\n'))
    const rawTextInMain = normalize(rawInMain.map(message => message.role === 'tool' ? visibleReadText(message.content)
      : rawCandidates.filter(candidate => message.content.includes(`## ${candidate.id}\n状态：${candidate.status}\n${candidate.normalizedContent}`))
        .map(candidate => candidate.normalizedContent).join('\n')).join('\n'))
    const visibleEntryText = normalize(sourceEntries.filter(entry => mainMessages.some(message => message.role === 'system'
      && normalize(message.content).includes(normalize(entry.body)))).map(entry => entry.body).join('\n'))
    const archivedRequiredFields = Object.keys(required).filter(term => requiredMatch(archivedText, term))
    const missingFromMain = Object.keys(required).filter(term => !requiredMatch(visibleEntryText, term) && !requiredMatch(rawTextInMain, term))
    const uncertain = Object.fromEntries((material.uncertain ?? []).map(term => [term, {
      active: evidenceText.includes(normalize(term)),
      archived: archivedText.includes(normalize(term)),
      rawVisible: rawTextInMain.includes(normalize(term)),
    }]))
    const archiveExpected = Boolean(material.archiveReason || extractive && material.noise?.length)
    return {
      source: material.match,
      inputSeen,
      originalSequence: original?.sequence ?? null,
      originalKeptInHistory: Boolean(original?.rawContent),
      outsideCoveredPrefix: Boolean(original && original.sequence > coveredThrough),
      originalRolesInMainRequest: [...new Set(rawInMain.map(message => message.role))],
      originalLineCount: fileResult(original?.rawContent)?.lines?.length ?? 0,
      mainProjectedLines: fileViews.reduce((count, view) => count + (view?.lines?.length ?? 0), 0),
      partialRead: fileViews.some(view => view?.projection === 'unresolved_lines'),
      entryCountWithEvidence: sourceEntries.length,
      required,
      archivedRequiredFields,
      missingFromMain,
      uncertain,
      noise,
      archiveExpected,
      archiveRecorded: archiveSpans.length > 0,
      archiveCorrect: archiveExpected
        ? archiveSpans.length > 0 && (material.noise ?? []).every(term => archivedText.includes(normalize(term)))
          && archivedRequiredFields.length === 0
        : archiveSpans.length === 0,
    }
  })
  const everyClaimWithEvidence = materials.every(item => Object.values(item.required).every(Boolean))
  const unrelatedTextOmitted = materials.every(item => !Object.values(item.noise).some(Boolean))
  const completedSourceArchive = materials.every(item => item.archiveCorrect)
  const everyUncertaintyRetained = materials.every(item => Object.values(item.uncertain).every(term => term.rawVisible && !term.active && !term.archived))
  const eligibleMaterials = materials.length > 0 && materials.every(item => item.inputSeen && item.originalKeptInHistory)
  const structureAccepted = report.committed.outcomes.includes('committed')
  const expectedScope = activeProject.length === 0
  const modelRuns = (report.committed.generated ?? []).map(({ finishReason, usage, elapsedSeconds }) => ({ finishReason, usage, elapsedSeconds }))
  const missingRequiredFieldsFromMain = materials.reduce((count, item) => count + item.missingFromMain.length, 0)
  const answerReview = pairedAnswersPath ? reviewTimedAnswers(JSON.parse(fs.readFileSync(pairedAnswersPath, 'utf8')), state.contextHistory.messages) : undefined
  const measured = {
    scenario: scenarioId, structureAccepted, eligibleMaterials, everyClaimWithEvidence, unrelatedTextOmitted, everyUncertaintyRetained,
    completedSourceArchive, expectedScope, coveredThrough, materials,
    mainProjectedOriginalCount: materials.filter(item => item.originalRolesInMainRequest.length > 0).length,
    originalLineCount: materials.reduce((count, item) => count + item.originalLineCount, 0),
    mainProjectedLines: materials.reduce((count, item) => count + item.mainProjectedLines, 0),
    partialReadCount: materials.filter(item => item.partialRead).length,
    archivedRequiredFields: materials.reduce((count, item) => count + item.archivedRequiredFields.length, 0),
    missingRequiredFieldsFromMain,
    output: active.map(entry => ({ body: entry.body, evidenceRefs: entry.evidenceRefs })),
    modelRuns,
    errors: report.committed.errors ?? [],
    ...(answerReview ? { answerReview } : {}),
    accepted: structureAccepted && eligibleMaterials && everyClaimWithEvidence && unrelatedTextOmitted && completedSourceArchive
      && everyUncertaintyRetained && expectedScope && missingRequiredFieldsFromMain === 0 && (!answerReview || answerReview.optimized.accepted),
  }
  console.log(JSON.stringify(measured, null, 2))
  if (!measured.accepted) process.exitCode = 1
} finally {
  store.close()
}
