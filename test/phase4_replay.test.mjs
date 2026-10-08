import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import test from 'node:test'
import { digest, fileDigest, readJson } from '../src/phase0_run.mjs'
import { runChildProcess } from '../src/phase1_process.mjs'
import { startRuntimeHookService, prepareCorrectionReadonlyInitialization } from '../src/phase3_hook_service.mjs'
import { collectRuntimeEvidence, pythonEventHash, validateRuntimeEvidence } from '../src/phase3_runtime_evidence.mjs'
import { assertFreshReplayProcessGeneration, createCorrectionReplayPlan, verifyCorrectionReplay } from '../src/phase4_replay.mjs'
import { verifyCorrectionReplayAuthority } from '../src/phase4_replay_authority.mjs'
import { controlledReplayFixture, controlledReplayEvidenceFixture } from './support/correction_replay_fixture.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const portable = value => value.replaceAll('\\', '/')

test('initial execution denies even empty correction context before creating a Host or evidence', () => {
  for (const correctionContext of [null, {}, { strategyText: 'free text' }]) assert.throws(() => prepareCorrectionReadonlyInitialization({ task: { correctionOrdinal: 0, correctionContext } }), /initial_attempt_has_correction/)
})

test('independent replay verifier rejects unsafe or malformed references even with a custom reader', () => {
  let reads = 0
  for (const path of ['../escape', '/absolute', 'C:/absolute', 'C:relative', 'runs/../escape', 'runs//empty', 'runs\\windows', '']) {
    assert.throws(() => verifyCorrectionReplay({ replayReportRef: { path, sha256: 'a'.repeat(64) }, readEvidence: () => { reads++; return Buffer.from('{}') } }), /unsafe_replay_evidence_path/)
  }
  assert.equal(reads, 0)
  assert.throws(() => verifyCorrectionReplay({ replayReportRef: { path: 'runs/proof.json', sha256: 'a'.repeat(64), verdict: true }, readEvidence: () => { reads++; return Buffer.from('{}') } }), /invalid_replay_evidence_ref/)
  assert.equal(reads, 0)
})

test('a score is never admitted before fresh supervised ARE process generation has been verified', () => {
  const process = { schemaVersion: 'gaia2-process-result-v1', exitCode: 0, childExited: true, childClosed: true, signal: null,
    timedOut: false, interrupted: false, terminationErrors: [], finishedAt: new Date().toISOString(),
    processIdentity: { platform: 'controlled_fixture', verified: true, pid: 111, generation: 'new' } }
  const parentProcess = { processIdentity: { platform: 'controlled_fixture', verified: true, pid: 111, generation: 'old' } }
  assert.doesNotThrow(() => assertFreshReplayProcessGeneration({ process, parentProcess }))
  for (const value of [{ ...process, processIdentity: { ...process.processIdentity, verified: false } },
    { ...process, processIdentity: parentProcess.processIdentity }, { ...process, childClosed: false },
    { ...process, finishedAt: null }, { ...process, schemaVersion: 'unbound' }]) {
    assert.throws(() => assertFreshReplayProcessGeneration({ process: value, parentProcess }), /ARE_process_generation_not_fresh/)
  }
  assert.throws(() => assertFreshReplayProcessGeneration({ process, parentProcess: { processIdentity: { verified: false } } }), /ARE_process_generation_not_fresh/)
})

export { controlledReplayFixture } from './support/correction_replay_fixture.mjs'
test('fresh correction actually initializes readonly context and every Actor consumes it; unknown writes remain blocked', async t => {
  const f = await controlledReplayFixture(t)
  const badTask = structuredClone(f.plan.task)
  badTask.correctionContext.strategyHash = '0'.repeat(64)
  assert.throws(() => verifyCorrectionReplayAuthority({ root: f.root, manifest: { ...f.plan.manifest, tasks: [badTask] }, task: badTask }), /correction_lineage_changed/)
  const value = { ...f.plan.task, correctionContext: { ...f.plan.task.correctionContext, strategyText: 'FREE_ANSWER_PAYLOAD' } }
  assert.throws(() => verifyCorrectionReplayAuthority({ root: f.root, manifest: { ...f.plan.manifest, tasks: [value] }, task: value }), /correction_context_shape/)
})

test('fresh correction dynamic update changes the actual Actor request and cancels the obsolete action', async t => {
  await controlledReplayFixture(t, { caseName: 'dynamic' })
})

test('independent replay verifier reconstructs success only from complete fresh fixtures, actual Host/ARE validation and sealed training provenance', async t => {
  const f = await controlledReplayEvidenceFixture(t)
  assert.equal(f.initialManifest.tasks.length, 25)
  assert.equal(f.replayVerified.businessPassed, true)
  assert.equal(f.replayVerified.score, 1)
  assert.equal(f.replayVerified.parentExecutionId, f.parent.task.executionId)
  assert.equal(f.replayVerified.parentSessionId, f.parent.session.sessionId)
  assert.equal(f.replayVerified.trainingReceiptHash, f.authority.context.trainingReceiptHash)
  assert.equal(f.replayVerified.initialAttemptCountDelta, 0)
  const map = new Map(f.replayVerified.evidenceRefs.map(ref => [ref.path, Buffer.from(f.readEvidence(ref.path))]))
  const relocated = verifyCorrectionReplay({ replayReportRef: f.replayReportRef, readEvidence: path => { assert.ok(map.has(path)); return Buffer.from(map.get(path)) } })
  assert.equal(relocated.sourceHash, f.replayVerified.sourceHash)
  const report = JSON.parse(map.get(f.replayReportRef.path))
  const native = f.replayResult.artifacts.find(ref => ref.path.endsWith('/output.jsonl'))
  map.set(native.path, Buffer.from('changed native result'))
  assert.throws(() => verifyCorrectionReplay({ replayReportRef: f.replayReportRef, readEvidence: path => Buffer.from(map.get(path)) }), /native_SHA_changed/)
})

test('independent replay verifier retains genuine controlled business failure and rejects a lineage grade flag', async t => {
  const f = await controlledReplayEvidenceFixture(t, { passed: false })
  assert.equal(f.replayVerified.businessPassed, false); assert.equal(f.replayVerified.score, 0)
  assert.equal(f.entry.result.businessPassed, false)
  const report = f.readEvidence(f.replayReportRef.path)
  const changed = JSON.parse(report); changed.correctionContext.parentResultHash = '0'.repeat(64)
  const bytes = Buffer.from(JSON.stringify(changed))
  assert.throws(() => verifyCorrectionReplay({ replayReportRef: { path: f.replayReportRef.path, sha256: sha(bytes) }, readEvidence: path => path === f.replayReportRef.path ? bytes : f.readEvidence(path) }), /replay_context_changed/)
})
