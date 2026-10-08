import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test, { after, before } from 'node:test'
import { digest, within, writeJson } from '../src/phase0_run.mjs'
import { loadTrainingParent, trainingEvidenceReader, verifyTrainingProbe } from '../src/phase4_training.mjs'
import { verifyTrainingProbeEvidence } from '../src/phase4_training_proof.mjs'
import { trainingProofBundle, trainingProofFixture } from './support/training_proof_fixture.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const jsonBytes = value => Buffer.from(JSON.stringify(value) + '\n')
let fixture, originalBundle
const cleanup = []
before(async () => {
  fixture = await trainingProofFixture({ after: fn => cleanup.push(fn) }, { fullInitialPlan: true })
  assert.equal(fixture.status, 'strategy_ready')
  originalBundle = trainingProofBundle(fixture)
})
after(async () => { for (const fn of cleanup.reverse()) await fn() })

function overlay(mutate) {
  const mapping = new Map([...originalBundle.mapping].map(([key, bytes]) => [key, Buffer.from(bytes)]))
  const report = JSON.parse(mapping.get(fixture.trainingReportRef.path))
  const refresh = (value, path, hash) => {
    if (!value || typeof value !== 'object') return
    if (value.path === path && Object.hasOwn(value, 'sha256')) value.sha256 = hash
    Object.values(value).forEach(child => refresh(child, path, hash))
  }
  const json = path => JSON.parse(mapping.get(path))
  const replace = (path, value) => { const bytes = Buffer.isBuffer(value) ? value : jsonBytes(value); mapping.set(path, bytes); refresh(report, path, sha(bytes)) }
  const evidenceKey = absolute => {
    const normalized = absolute.replaceAll('\\', '/')
    const matches = [...mapping.keys()].filter(key => normalized === key || normalized.endsWith(`/${key}`))
    assert.equal(matches.length, 1)
    return matches[0]
  }
  const updateHost = alter => {
    const host = json(report.hostResult.path)
    alter(host)
    const invokedPath = evidenceKey(host.result.evidencePath), invoked = json(invokedPath)
    for (const [key, value] of Object.entries(host.result)) if (key !== 'evidencePath') invoked[key] = structuredClone(value)
    replace(invokedPath, invoked); replace(report.hostResult.path, host)
    return host
  }
  mutate({ mapping, report, json, replace, evidenceKey, updateHost })
  const bytes = jsonBytes(report); mapping.set(fixture.trainingReportRef.path, bytes)
  return { trainingReportRef: { path: fixture.trainingReportRef.path, sha256: sha(bytes) }, readEvidence: path => {
    assert(mapping.has(path), `missing mutated evidence ${path}`); return Buffer.from(mapping.get(path))
  } }
}
function reject(mutate, pattern) {
  const input = overlay(mutate)
  assert.throws(() => verifyTrainingProbeEvidence(input), pattern)
}

test('actual frozen plugin 1.2 TS Host/Python/LiteLLM/local HTTP chain independently verifies without benchmark credit', () => {
  const proof = verifyTrainingProbe({ root: fixture.root, trainingReportRef: fixture.trainingReportRef })
  assert.equal(fixture.httpRequests.length, 1)
  assert.equal(fixture.httpRequests[0].url, '/v1/chat/completions')
  assert.equal(fixture.httpRequests[0].payload.model, 'gpt-6-luna')
  assert.deepEqual(fixture.httpRequests[0].payload.response_format, { type: 'json_object' })
  assert.equal(proof.hostResult.result.proposals.length, 1)
  assert.equal(proof.hostResult.result.artifacts.length, 1)
  assert.equal(proof.hostResult.operationalReceipts[0].process.childExited, true)
  assert.equal(proof.hostResult.operationalReceipts[0].process.childClosed, true)
  assert.equal(proof.hostResult.cleanupCompleted, true)
  assert.equal(proof.hostResult.manualInspectionRequired, false)
  assert.equal(proof.spec.options.providerCleanupTimeoutMs, 30000)
  assert.equal(proof.spec.settings.modelRequestTimeoutSeconds, 3)
  assert.equal(fixture.manifest.tasks.length, 25)
  assert.equal(fixture.trainingManifest.tasks.length, 25)
  assert.equal(fixture.report.liveModelRequests, 0)
  assert.equal(fixture.report.benchmarkExecutions, 0)
  assert.equal(fixture.report.initialAttemptCountDelta, 0)
  assert.equal(fixture.report.officialSubmissionReady, false)
  assert.doesNotMatch(JSON.stringify(fixture.httpRequests[0].payload), /FUTURE_USER_SENTINEL|OLD_RECORD_SENTINEL|scenario-1|execution-1|0001-aaaaaaaaaaaa/)
})

test('sealed proof verifies from an immutable byte reader and a genuinely relocated directory without old-root reads', () => {
  const proof = verifyTrainingProbeEvidence({ trainingReportRef: fixture.trainingReportRef, readEvidence: originalBundle.readEvidence })
  assert.deepEqual(proof.plan, fixture.candidate)
  const relocatedRoot = join(fixture.fixtureRoot, 'relocated-proof-bundle')
  for (const [path, bytes] of originalBundle.mapping) {
    const destination = join(relocatedRoot, path)
    assert(within(relocatedRoot, destination)); mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, bytes, { flag: 'wx' })
  }
  const relocated = verifyTrainingProbe({ root: relocatedRoot, trainingReportRef: fixture.trainingReportRef })
  assert.deepEqual(relocated.plan, proof.plan)
  assert.equal(relocated.verifiedParent.resultHash, proof.verifiedParent.resultHash)
  assert.equal(fixture.httpRequests.length, 1)
})

test('real five-lock baseline verifies a multi-row JSONL scenario index without parsing it as one JSON document', () => {
  assert.deepEqual(Object.keys(fixture.trainingManifest.lockRefs).sort(), ['capabilities', 'dataset', 'environment', 'protocol', 'scenarioIndex'])
  const baseline = fixture.report.trainingBaseline
  assert.deepEqual(baseline.locks.map(lock => lock.key).sort(), Object.keys(fixture.trainingManifest.lockRefs).sort())
  const indexLock = baseline.locks.find(lock => lock.key === 'scenarioIndex')
  const indexBytes = originalBundle.readEvidence(indexLock.path)
  const rows = indexBytes.toString('utf8').split(/\r?\n/).filter(line => line.trim()).map(JSON.parse)
  assert(rows.length >= 2)
  assert.equal(rows.length, 5)
  assert.throws(() => JSON.parse(indexBytes), SyntaxError)
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['config', 'datasetKind', 'id', 'path', 'rowIndex', 'scenarioHash', 'scenarioVersion'])
    assert.equal(row.datasetKind, 'source')
    assert.match(row.scenarioHash, /^[a-f0-9]{64}$/)
  }
  const datasetLock = baseline.locks.find(lock => lock.key === 'dataset')
  const dataset = JSON.parse(originalBundle.readEvidence(datasetLock.path))
  assert.deepEqual(dataset.scenarioIndex, { ...fixture.trainingManifest.lockRefs.scenarioIndex, count: rows.length })
  assert.equal(sha(indexBytes), indexLock.sha256)
  assert.deepEqual(verifyTrainingProbeEvidence({ trainingReportRef: fixture.trainingReportRef, readEvidence: originalBundle.readEvidence }).plan, fixture.candidate)
  assert.equal(fixture.httpRequests.length, 1)
})

test('invalid JSONL index rows fail closed even if outer baseline and manifest hashes are synchronized', () => {
  reject(({ mapping, report, json, replace }) => {
    const lock = report.trainingBaseline.locks.find(item => item.key === 'scenarioIndex')
    const malformed = Buffer.concat([mapping.get(lock.path), Buffer.from('{"invalid-final-row":\n')])
    replace(lock.path, malformed)
    const manifest = json(report.trainingManifest.path)
    manifest.lockRefs.scenarioIndex.sha256 = sha(malformed)
    const { manifestHash: ignored, ...content } = manifest
    manifest.manifestHash = digest(content)
    replace(report.trainingManifest.path, manifest)
  }, SyntaxError)
})

test('replaced scenario-index bytes and forged lock hashes cannot bypass the frozen manifest binding', () => {
  reject(({ mapping, report }) => {
    const lock = report.trainingBaseline.locks.find(item => item.key === 'scenarioIndex')
    mapping.set(lock.path, Buffer.concat([mapping.get(lock.path), Buffer.from('\n')]))
  }, /training evidence SHA/)
  reject(({ mapping, report, replace }) => {
    const lock = report.trainingBaseline.locks.find(item => item.key === 'scenarioIndex')
    replace(lock.path, Buffer.concat([mapping.get(lock.path), Buffer.from('\n')]))
  }, /training lock binding/)
  reject(({ report }) => {
    report.trainingBaseline.locks.find(item => item.key === 'scenarioIndex').sha256 = '0'.repeat(64)
  }, /training lock binding/)
})

test('report anchors, child reference hashes, missing files and traversal paths fail closed', () => {
  assert.throws(() => verifyTrainingProbeEvidence({ trainingReportRef: { ...fixture.trainingReportRef, sha256: '0'.repeat(64) }, readEvidence: originalBundle.readEvidence }), /training report SHA/)
  reject(({ report }) => { report.evidence[0].sha256 = '0'.repeat(64) }, /training evidence SHA/)
  reject(({ mapping, report }) => { mapping.delete(report.evidence[0].path) }, /missing mutated evidence/)
  reject(({ report }) => { report.evidence[0].path = '../outside.json' }, /unsafe relative path/)
  reject(({ report }) => { report.evidence.push(structuredClone(report.evidence[0])) }, /invalid training evidence identity/)
})

test('parent references and explicit source lineage cannot be substituted by updating only outer report hashes', () => {
  reject(({ report }) => { report.parentSessionId = 'other-session' }, /training parent lineage/)
  reject(({ report }) => { report.parentResultHash = 'f'.repeat(64) }, /training parent lineage/)
  reject(({ report }) => { report.parentEvidence.files[0].sha256 = 'f'.repeat(64) }, /sealed parent SHA/)
  reject(({ report }) => { report.sanitizedInput.observableSummary.counts.toolCalls += 1 }, /training parent lineage/)
})

test('frozen implementation/plugin source hashes are not merely decorative references', () => {
  reject(({ report, replace }) => {
    const source = report.trainingBaseline.sourceFiles.find(item => item.scope === 'project')
    replace(source.path, Buffer.from('tampered implementation'))
  }, /source outside frozen code inventory/)
  reject(({ report, replace }) => {
    const source = report.trainingBaseline.sourceFiles.find(item => item.scope === 'plugin:gaia2-evaluation')
    replace(source.path, Buffer.from('tampered plugin'))
  }, /plugin outside frozen inventory/)
  reject(({ report }) => { report.trainingBaseline.sourceFiles = report.trainingBaseline.sourceFiles.filter(item => item.relativePath !== 'src/core/plugins/training-plugin-host.ts') }, /missing training implementation source/)
})

test('diagnostic dependency is sealed in baseline v2 and cannot be omitted or downgraded', () => {
  const baseline = fixture.report.trainingBaseline
  assert.equal(baseline.schemaVersion, 'gaia2-phase4-training-baseline-v2')
  assert(baseline.sourceFiles.some(item => item.scope === 'project' && item.relativePath === 'scripts/gaia2_model_diagnostics.py'))
  reject(({ report }) => {
    report.trainingBaseline.sourceFiles = report.trainingBaseline.sourceFiles.filter(item => item.relativePath !== 'scripts/gaia2_model_diagnostics.py')
  }, /missing training implementation source/)
  reject(({ report }) => { report.trainingBaseline.schemaVersion = 'gaia2-phase4-training-baseline-v1' }, /diagnostic_dependency_requires_baseline_v2/)
  reject(({ report, replace }) => {
    const source = report.trainingBaseline.sourceFiles.find(item => item.relativePath === 'scripts/gaia2_model_diagnostics.py')
    replace(source.path, Buffer.from('tampered diagnostic implementation'))
  }, /source outside frozen code inventory/)
})

test('bound proposal cannot invent evidence or carry free-form strategy metadata even when Host result hashes are synchronized', () => {
  reject(({ updateHost }) => updateHost(host => {
    host.result.proposals[0].output.correction.evidenceHash = 'f'.repeat(64)
    host.result.proposals[0].outputHash = sha(JSON.stringify(host.result.proposals[0].output))
  }))
  reject(({ updateHost }) => updateHost(host => {
    host.result.proposals[0].output.metadata.rationale = 'FUTURE_FREE_TEXT_MUST_NOT_ENTER_CORRECTION'
    host.result.proposals[0].outputHash = sha(JSON.stringify(host.result.proposals[0].output))
  }), /proposal output|correction output|training strategy|candidate|contract|unsafe output fields/)
})

test('raw provider completion cannot conceal duplicate JSON root keys behind an otherwise valid parsed proposal', () => {
  reject(({ report, json, replace, evidenceKey, updateHost }) => {
    const host = json(report.hostResult.path), directory = host.operationalReceipts[0].directory
    const responsePath = evidenceKey(`${directory}/response.json`), response = json(responsePath)
    response.output_text = response.output_text.replace('{', '{"defectCode":"DUPLICATE_HIDDEN_VALUE",')
    replace(responsePath, response)
    updateHost(value => { value.result.providerReceipts[0].outputTextHash = sha(response.output_text) })
  }, /duplicate_or_nested/)
})

test('provider requests, outputs, event roles and native cleanup have independent proof bindings', () => {
  reject(({ report, json, replace, evidenceKey }) => {
    const host = json(report.hostResult.path), requestPath = evidenceKey(`${host.operationalReceipts[0].directory}/input.json`), request = json(requestPath)
    request.input += '\nchanged prompt'; replace(requestPath, request)
  }, /provider input\/output SHA/)
  reject(({ report, json, replace, evidenceKey }) => {
    const host = json(report.hostResult.path), responsePath = evidenceKey(`${host.operationalReceipts[0].directory}/response.json`), response = json(responsePath)
    response.output_text = '{}'; replace(responsePath, response)
  }, /provider input\/output SHA/)
  reject(({ report, json, replace, evidenceKey, updateHost }) => {
    const host = json(report.hostResult.path), eventPath = evidenceKey(`${host.operationalReceipts[0].directory}/model-events.jsonl`)
    const events = host.operationalReceipts[0].events.map(event => ({ ...event, modelRole: 'actor' }))
    replace(eventPath, Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n'))
    updateHost(value => { value.operationalReceipts[0].events = events })
  }, /real correction completion|event/)
  reject(({ updateHost }) => updateHost(host => { host.cleanupCompleted = false; host.manualInspectionRequired = true }), /training Host not healthy/)
  reject(({ updateHost }) => updateHost(host => { host.operationalReceipts[0].eventsReadable = false }), /provider receipt incomplete/)
  reject(({ report }) => { report.modelEventsReadable = false }, /provider receipt incomplete/)
})

test('training input extra free-text keys are rejected despite synchronized spec and invocation hashes', () => {
  reject(({ report, json, replace, evidenceKey, updateHost }) => {
    const input = json(report.trainingInput.path); input.question = 'FUTURE_QUESTION_TEXT_NOT_AUTHORIZED'
    replace(report.trainingInput.path, input); report.trainingInputHash = digest(input)
    const spec = json(report.hostSpec.path); spec.invocation.training = input; replace(report.hostSpec.path, spec)
    const host = updateHost(value => { value.result.inputHash = sha(JSON.stringify(spec.invocation)) })
    const invocationPath = evidenceKey(host.result.evidencePath), invoked = json(invocationPath)
    invoked.input = spec.invocation; replace(invocationPath, invoked)
  }, /training input binding/)
})

test('Host scenario and callback call statistics remain tied to the verified parent and actual operational events', () => {
  reject(({ report }) => { report.requestAttempts += 99 }, /count|statistic|correction completion/)
  reject(({ report }) => { report.successfulCompletions += 99 }, /count|statistic|correction completion/)
  reject(({ report }) => { report.realModelCalls += 99 }, /count|statistic|correction completion/)
  reject(({ report, json, replace, evidenceKey, updateHost }) => {
    const spec = json(report.hostSpec.path); spec.options.scenarioId = 'other-scenario'; replace(report.hostSpec.path, spec)
    const host = updateHost(value => { value.initialization.scenarioId = 'other-scenario' })
    const initPath = evidenceKey(host.initialization.evidencePath), { evidencePath: ignored, ...initialized } = host.initialization
    replace(initPath, initialized)
    const invokedPath = evidenceKey(host.result.evidencePath), invoked = json(invokedPath)
    invoked.scenarioId = 'other-scenario'; replace(invokedPath, invoked)
  }, /frozen configuration|scenario|identity/)
})

test('later mutation of the original parent state cannot alter or invalidate its sealed training verification', () => {
  const statePath = join(fixture.root, fixture.manifest.stateFile)
  assert(within(fixture.fixtureRoot, statePath))
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  state.tasks[0].status = 'interrupted'; state.tasks[0].sessions.push({ sessionId: 'later-session', outputDir: 'not-existing', workspaceDir: 'not-existing' })
  writeJson(statePath, state)
  assert.throws(() => loadTrainingParent({ root: fixture.root, manifestPath: fixture.parent.manifestPath, executionId: fixture.parent.task.executionId }))
  const verified = verifyTrainingProbe({ root: fixture.root, trainingReportRef: fixture.trainingReportRef })
  assert.equal(verified.verifiedParent.session.sessionId, fixture.parent.session.sessionId)
  assert.deepEqual(verified.plan, fixture.candidate)
  assert.equal(fixture.httpRequests.length, 1)
})

test('actual duplicate-key model response is rejected by frozen training TS before any strategy admission', async t => {
  const rejected = await trainingProofFixture(t, { rawResponse: candidate => JSON.stringify(candidate).replace('{', '{"defectCode":"DUPLICATE_RAW_MODEL_VALUE",') })
  assert.equal(rejected.httpRequests.length, 1)
  assert.equal(rejected.status, 'training_failed')
  assert.equal(rejected.hostResult.status, 'failed')
  assert.equal(rejected.hostResult.result.proposals.length, 0)
  assert.equal(rejected.hostResult.cleanupCompleted, true)
  assert.equal(rejected.hostResult.manualInspectionRequired, false)
})
