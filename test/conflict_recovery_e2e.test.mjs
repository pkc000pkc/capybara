import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hashTree } from '../src/phase0_inventory.mjs'
import { CONFLICT_CASES, parseConflictRecoveryE2EArgs, verifyConflictPluginSnapshots } from '../scripts/conflict_recovery_e2e.mjs'

test('controlled recovery runner never accepts model, original-task or batch flags', () => {
  assert.deepEqual(parseConflictRecoveryE2EArgs([]), { cases: [...CONFLICT_CASES] })
  assert.deepEqual(parseConflictRecoveryE2EArgs(['--case', 'confirmed']), { cases: ['confirmed'] })
  for (const argv of [['--real-model'], ['--run'], ['--prepare'], ['--case', 'all'], ['--case', 'confirmed', '--case', 'unknown_write']]) assert.throws(() => parseConflictRecoveryE2EArgs(argv))
})
test('positive and negative critical boundaries have independent fixed profiles', () => {
  assert.deepEqual(CONFLICT_CASES, ['confirmed', 'changed_budget', 'user_before_read', 'user_after_read', 'stop_before_read', 'unknown_write'])
  const source = readFileSync(new URL('../scripts/conflict_recovery_e2e_fixture.py', import.meta.url), 'utf8')
  assert.match(source, /bridge\._validate_provider_tool_pairs\(messages\)/)
  assert.match(source, /env\.start\(\)/); assert.match(source, /env\.stop\(\)/); assert.match(source, /env\.join\(\)/)
  assert.match(source, /model-000001-input\.json/)
  assert.match(source, /assert str\(event\) == body/)
  assert.match(source, /originalWriteExecuted/)
  assert.match(source, /permissionGranted/)
  assert.match(source, /businessSuccess/)
})
test('receipt validation consumes the fresh Host source rather than guessed state', () => {
  const source = readFileSync(new URL('../scripts/conflict_recovery_e2e.mjs', import.meta.url), 'utf8')
  assert.match(source, /source\.variables\.gaia2_conflict_state, receipt\.state/)
  assert.match(source, /source\.input, \{ \.\.\.item\.request, checkpoint: item\.checkpoint \}/)
  assert.match(source, /conflictDigest\(receipt\.state\), receipt\.stateHash/)
})
test('plugin snapshot verification detects resource drift after freezing', () => {
  const snapshotRoot = mkdtempSync(join(tmpdir(), 'conflict-snapshot-test-'))
  try {
    const resource = join(snapshotRoot, 'hook.ts')
    writeFileSync(resource, 'original')
    const snapshot = { snapshotRoot, ...hashTree(snapshotRoot) }
    assert.equal(verifyConflictPluginSnapshots([snapshot]), true)
    writeFileSync(resource, 'changed')
    assert.equal(verifyConflictPluginSnapshots([snapshot]), false)
    assert.equal(verifyConflictPluginSnapshots([]), false)
  } finally { rmSync(snapshotRoot, { recursive: true, force: true }) }
})
