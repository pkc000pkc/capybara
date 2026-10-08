import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { cleanupTrainingProofFixture } from './support/training_proof_fixture.mjs'

// Every workspace in this suite is synthetic file data: no child, model,
// TrainingHost, or ARE execution is created, inspected, or terminated.
function fileFixture(t) {
  const runDirectory = mkdtempSync(join(tmpdir(), 'gaia2-cleanup-files-only-'))
  const fixtureRoot = join(runDirectory, 'phase4-training-proof-test-controlled')
  mkdirSync(fixtureRoot)
  const sentinel = join(fixtureRoot, 'diagnostic.txt')
  writeFileSync(sentinel, 'unknown-process evidence must survive')
  t.after(() => {
    assert(resolve(runDirectory).startsWith(resolve(tmpdir())))
    rmSync(runDirectory, { recursive: true, force: true })
  })
  return { runDirectory, fixtureRoot, sentinel }
}

const settled = () => ({ schemaVersion: 'gaia2-process-result-v1', childExited: true, childClosed: true,
  manualInspectionRequired: false, terminationErrors: [] })

function replay(f, name, value = settled()) {
  const host = join(f.fixtureRoot, `replay-${name}`, 'output', 'hook-host')
  mkdirSync(host, { recursive: true })
  const path = join(host, 'process-result.json')
  if (value !== undefined) writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
  return { host, path }
}

function actor(f, name, value = settled()) {
  const directory = join(f.fixtureRoot, `replay-${name}`, 'output', 'actor-process')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'process-result.json')
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
  return { directory, path }
}

function retained(f, trainingCleanupSafe = true) {
  assert.equal(cleanupTrainingProofFixture({ ...f, trainingCleanupSafe }), false)
  assert.equal(readFileSync(f.sentinel, 'utf8'), 'unknown-process evidence must survive')
}

test('file-only cleanup removes settled training with no replay', t => {
  const f = fileFixture(t)
  assert.equal(cleanupTrainingProofFixture({ ...f, trainingCleanupSafe: true }), true)
  assert.equal(existsSync(f.fixtureRoot), false)
})

test('file-only cleanup requires every replay Host to have a settled receipt', t => {
  const f = fileFixture(t)
  replay(f, 'one'); replay(f, 'two')
  assert.equal(cleanupTrainingProofFixture({ ...f, trainingCleanupSafe: true }), true)
  assert.equal(existsSync(f.fixtureRoot), false)
})

test('file-only cleanup permits a settled Actor and Host together', t => {
  const f = fileFixture(t)
  replay(f, 'one'); actor(f, 'one')
  assert.equal(cleanupTrainingProofFixture({ ...f, trainingCleanupSafe: true }), true)
  assert.equal(existsSync(f.fixtureRoot), false)
})

test('created Actor directory without a receipt preserves its healthy Host', t => {
  const f = fileFixture(t), host = replay(f, 'one'), item = actor(f, 'one')
  rmSync(item.path)
  retained(f)
  assert.equal(existsSync(host.path), true)
})

for (const [name, value] of [
  ['damaged JSON', '{not-json'],
  ['null JSON', 'null'],
  ['wrong schema', { ...settled(), schemaVersion: 'unknown' }],
  ['child not exited', { ...settled(), childExited: false }],
  ['child not closed', { ...settled(), childClosed: false }],
  ['missing child exit', { ...settled(), childExited: undefined }],
  ['missing child close', { ...settled(), childClosed: undefined }],
  ['manual inspection required', { ...settled(), manualInspectionRequired: true }],
  ['missing manual inspection status', { ...settled(), manualInspectionRequired: undefined }],
  ['termination error', { ...settled(), terminationErrors: ['Actor cleanup unresolved'] }],
  ['missing termination errors', { ...settled(), terminationErrors: undefined }],
  ['invalid termination errors', { ...settled(), terminationErrors: 'unknown' }],
]) {
  test(`Actor ${name} retains the whole fixture despite a settled Host`, t => {
    const f = fileFixture(t), host = replay(f, 'one')
    actor(f, 'one', value)
    retained(f)
    assert.equal(existsSync(host.path), true)
  })
}

for (const dangling of [false, true]) {
  test(`Actor ${dangling ? 'dangling' : 'existing'} junction does not count as absent`, t => {
    const f = fileFixture(t), host = replay(f, 'one')
    const outside = join(f.runDirectory, 'outside-actor-evidence')
    if (!dangling) mkdirSync(outside)
    const actorDirectory = join(f.fixtureRoot, 'replay-one', 'output', 'actor-process')
    symlinkSync(outside, actorDirectory, 'junction')
    retained(f)
    assert.equal(existsSync(host.path), true)
    assert.equal(existsSync(outside), !dangling)
  })
}

test('Actor receipt junction cannot authorize cleanup', t => {
  const f = fileFixture(t), host = replay(f, 'one'), item = actor(f, 'one')
  rmSync(item.path)
  const outside = join(f.runDirectory, 'outside-actor-receipt')
  mkdirSync(outside)
  symlinkSync(outside, item.path, 'junction')
  retained(f)
  assert.equal(existsSync(host.path), true)
  assert.equal(existsSync(outside), true)
})

test('unsettled training retains even completely settled replay Hosts', t => {
  const f = fileFixture(t)
  replay(f, 'one')
  retained(f, false)
})

test('created replay without a Host directory preserves the whole fixture', t => {
  const f = fileFixture(t)
  mkdirSync(join(f.fixtureRoot, 'replay-startup-failed'))
  retained(f)
})

test('missing replay receipt preserves the whole fixture', t => {
  const f = fileFixture(t), item = replay(f, 'missing')
  rmSync(item.path)
  retained(f)
})

for (const [name, value] of [
  ['damaged JSON', '{not-json'],
  ['null JSON', 'null'],
  ['wrong schema', { ...settled(), schemaVersion: 'unknown' }],
  ['child not exited', { ...settled(), childExited: false }],
  ['child not closed', { ...settled(), childClosed: false }],
  ['missing child exit', { ...settled(), childExited: undefined }],
  ['missing child close', { ...settled(), childClosed: undefined }],
  ['manual inspection required', { ...settled(), manualInspectionRequired: true }],
  ['missing manual inspection status', { ...settled(), manualInspectionRequired: undefined }],
  ['termination error', { ...settled(), terminationErrors: ['identity verification failed'] }],
  ['missing termination errors', { ...settled(), terminationErrors: undefined }],
  ['invalid termination errors', { ...settled(), terminationErrors: 'unknown' }],
]) {
  test(`replay ${name} retains healthy sibling and all diagnostics`, t => {
    const f = fileFixture(t)
    const healthy = replay(f, 'healthy')
    replay(f, 'uncertain', value)
    retained(f)
    assert.equal(existsSync(healthy.path), true)
  })
}

for (const target of ['replay', 'output', 'hook-host']) {
  test(`replay ${target} junction is retained without following it`, t => {
    const f = fileFixture(t), outside = join(f.runDirectory, 'outside-evidence')
    mkdirSync(outside)
    writeFileSync(join(outside, 'sentinel.txt'), 'outside evidence remains')
    const replayRoot = join(f.fixtureRoot, 'replay-linked'), output = join(replayRoot, 'output')
    const link = target === 'replay' ? replayRoot : target === 'output' ? output : join(output, 'hook-host')
    if (target !== 'replay') mkdirSync(target === 'output' ? replayRoot : output, { recursive: true })
    symlinkSync(outside, link, 'junction')
    retained(f)
    assert.equal(readFileSync(join(outside, 'sentinel.txt'), 'utf8'), 'outside evidence remains')
  })
}

test('fixture root junction cannot authorize deletion of its target', t => {
  const f = fileFixture(t), outside = join(f.runDirectory, 'outside-evidence')
  mkdirSync(outside)
  writeFileSync(join(outside, 'diagnostic.txt'), 'outside evidence remains')
  const linkedRoot = join(f.runDirectory, 'phase4-training-proof-test-linked')
  symlinkSync(outside, linkedRoot, 'junction')
  assert.equal(cleanupTrainingProofFixture({ ...f, fixtureRoot: linkedRoot, trainingCleanupSafe: true }), false)
  assert.equal(readFileSync(join(outside, 'diagnostic.txt'), 'utf8'), 'outside evidence remains')
})

test('cleanup rejects a workspace root or an out-of-scope target', t => {
  const f = fileFixture(t)
  for (const fixtureRoot of [f.runDirectory, resolve(f.runDirectory, '..', 'not-this-fixture')]) {
    assert.throws(() => cleanupTrainingProofFixture({ ...f, fixtureRoot, trainingCleanupSafe: true }), /assert|false == true/i)
  }
  assert.equal(existsSync(f.sentinel), true)
})
