import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { buildReference } from './appworld-adapter.mjs'

function fixture(answerSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-appworld-reference-'))
  const taskId = 'fixture_1'
  const groundTruth = path.join(root, 'data', 'tasks', taskId, 'ground_truth')
  const dbs = path.join(root, 'experiments', 'outputs', 'capybara', 'run-1', 'case-1', 'tasks', taskId, 'dbs')
  fs.mkdirSync(groundTruth, { recursive: true })
  fs.mkdirSync(dbs, { recursive: true })
  if (answerSource !== undefined) fs.writeFileSync(path.join(groundTruth, 'answer.json'), answerSource)
  fs.writeFileSync(path.join(groundTruth, 'test_data.json'), JSON.stringify([{ requirement: 'assert result matches.' }]))
  fs.writeFileSync(path.join(groundTruth, 'public_data.json'), JSON.stringify({ note: 'expected' }))
  fs.writeFileSync(path.join(groundTruth, 'private_data.json'), JSON.stringify({ receiver_ids: [3, 7] }))
  fs.writeFileSync(path.join(dbs, 'model_hashes.json'), JSON.stringify({ venmo: { PaymentRequest: 1 } }))
  fs.writeFileSync(path.join(dbs, 'venmo.jsonl'), `${JSON.stringify(['INSERT INTO payment_requests (receiver_id) VALUES (?)', [3], false])}\n`)
  return { root, taskId }
}

function resolve(value) {
  return buildReference({
    ...value,
    experimentRunId: 'run-1',
    experimentCaseId: 'case-1',
    evaluation: { passes: [{ requirement: 'assert result matches.' }], failures: [] },
  })
}

test('loads an official textual AppWorld answer after evaluation', (context) => {
  const value = fixture('786')
  context.after(() => fs.rmSync(value.root, { recursive: true, force: true }))
  const reference = resolve(value)
  assert.equal(reference.kind, 'text')
  assert.equal(reference.status, 'available')
  assert.equal(reference.value, 786)
  assert.equal(reference.displayValue, '786')
  assert.equal(reference.requirements[0]?.status, 'passed')
})

test('loads state evidence when AppWorld answer.json is null', (context) => {
  const value = fixture('null')
  context.after(() => fs.rmSync(value.root, { recursive: true, force: true }))
  const reference = resolve(value)
  assert.equal(reference.kind, 'state')
  assert.deepEqual(reference.expectedState.private.receiver_ids, [3, 7])
  assert.equal(reference.stateChangesStatus, 'summary_only')
  assert.deepEqual(reference.actualStateChanges[0], {
    application: 'venmo', model: 'PaymentRequest', records: 1, added: 1, updated: 0, removed: 0,
    recordChanges: [], truncatedRecords: 1,
  })
})

test('rejects malformed and missing official answer files', (context) => {
  const malformed = fixture('{broken')
  const missing = fixture(undefined)
  context.after(() => {
    fs.rmSync(malformed.root, { recursive: true, force: true })
    fs.rmSync(missing.root, { recursive: true, force: true })
  })
  assert.throws(() => resolve(malformed), /JSON/)
  assert.throws(() => resolve(missing), /answer\.json was not found/)
})
