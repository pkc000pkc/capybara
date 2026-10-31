import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { TARGET_ID, THIN_RUNTIME_MODE, parseConflictOfficialOneArgs } from '../scripts/conflict_recovery_official_one.mjs'
import { assertEntityWaitProfile } from '../scripts/entity_wait_official_one.mjs'

test('fresh rerun requires thin native semantics and exactly the same original task', () => {
  const profile = { mode: THIN_RUNTIME_MODE, entitySemantics: { enabled: true },
    mutationReceipts: { enabled: true }, originalTaskCount: 1, tasks: [{ scenarioId: TARGET_ID }] }
  assert.equal(assertEntityWaitProfile(profile), true)
  for (const mutate of [p => delete p.entitySemantics, p => delete p.mutationReceipts, p => { p.taskContract = { enabled: true } },
    p => { p.tasks[0].scenarioId = 'another' }, p => { p.tasks.push({ scenarioId: TARGET_ID }) }, p => { p.originalTaskCount = 10 }]) {
    const value = structuredClone(profile); mutate(value); assert.throws(() => assertEntityWaitProfile(value))
  }
})

test('historical contract profile is recognizable only for strict read-only verification', () => {
  const profile = { mode: 'temporal_conflict_entity_wait_diagnostic', entitySemantics: { enabled: true },
    taskContract: { enabled: true }, mutationReceipts: { enabled: true }, originalTaskCount: 1, tasks: [{ scenarioId: TARGET_ID }] }
  assert.throws(() => assertEntityWaitProfile(profile))
  assert.equal(assertEntityWaitProfile(profile, { historical: true }), true)
})

test('new thin entry retains explicit prepare/run/verify with no batch or model override', () => {
  assert.deepEqual(parseConflictOfficialOneArgs(['--prepare']), { mode: 'prepare' })
  for (const argv of [['--batch'], ['--resume', 'x'], ['--model', 'another'], ['--prepare', '--run', 'x']]) {
    assert.throws(() => parseConflictOfficialOneArgs(argv))
  }
  const source = readFileSync(new URL('../scripts/entity_wait_official_one.mjs', import.meta.url), 'utf8')
  assert.match(source, /runtimeSemantics: true/)
  assert.doesNotMatch(source, /_call_model\s*=|scriptedActor|--a2a|--noise/)
})

test('manifest-driven real Host and Bridge omit retired task controls but retain official execution and receipts', () => {
  const source = readFileSync(new URL('../scripts/conflict_recovery_official_one.mjs', import.meta.url), 'utf8')
  for (const name of ['GAIA2_ENTITY_SEMANTICS_ENABLED', 'GAIA2_ENTITY_SEMANTICS_WORKSPACE', 'GAIA2_MUTATION_RECEIPTS_ENABLED',
    'verifyRuntimeSemanticReceipts', 'contractModelRequests', 'task_obligation_signaled']) assert.ok(source.includes(name))
  assert.doesNotMatch(source, /GAIA2_TASK_CONTRACT_ENABLED|GAIA2_TASK_CONTRACT_WORKSPACE/)
  assert.match(source, /runtimeSemantics = true/)
  assert.match(source, /assertUnchangedPublicConfiguration\(/)
  assert.match(source, /temporal_official_entry\.py/)
})
