import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { taskReconciliationEnvironment } from '../src/phase1_official.mjs'

test('formal phase1 entrypoint explicitly enables the generic Actor-owned task contract', () => {
  assert.deepEqual(taskReconciliationEnvironment(), { GAIA2_TASK_RECONCILIATION_ENABLED: '1' })
})

test('all real model entrypoints consume the shared task-contract environment policy', () => {
  const files = [
    'src/phase1_official.mjs',
    'scripts/full_library_task.mjs',
    'scripts/retrieval_e2e.mjs',
    'scripts/temporal_official_ten.mjs',
    'scripts/conflict_recovery_official_one.mjs',
  ]
  for (const relativePath of files) {
    const source = readFileSync(resolve(relativePath), 'utf8')
    assert.match(source, /taskReconciliationEnvironment/, relativePath)
  }
})
