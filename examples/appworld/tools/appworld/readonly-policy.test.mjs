import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { readonlyPolicyError } from './readonly-policy.mjs'

const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'manifest.json'), 'utf8'))

test('AppWorld readonly policy accepts documentation and read APIs', () => {
  assert.equal(readonlyPolicyError('print(apis.api_docs.show_api_doc(app_name="mail", api_name="list_threads"))'), undefined)
  assert.equal(readonlyPolicyError('print(apis.mail.list_threads(limit=10))'), undefined)
  assert.equal(readonlyPolicyError('items = apis.mail.search_messages(query="invoice")\nprint(items)'), undefined)
})

test('AppWorld readonly policy rejects writes, completion and host escape paths', () => {
  assert.match(readonlyPolicyError('apis.mail.send_message(to="x")') ?? '', /mutating API/)
  assert.match(readonlyPolicyError('apis.supervisor.complete_task()') ?? '', /unsafe syntax|host access/)
  assert.match(readonlyPolicyError('import os\nprint(os.getcwd())') ?? '', /unsafe syntax|host access/)
  assert.match(readonlyPolicyError('apis.mail.archive_threads()') ?? '', /approved read API/)
})

test('AppWorld readonly manifest declares a distinct safe capability contract', () => {
  const action = manifest.tools.find(tool => tool.name === 'appworld_execute')
  const readonly = manifest.tools.find(tool => tool.name === 'appworld_readonly_execute')
  assert.ok(action)
  assert.ok(readonly)
  assert.equal(action.sideEffects, 'external')
  assert.equal(action.replay, 'never')
  assert.equal(readonly.sideEffects, 'none')
  assert.equal(readonly.replay, 'safe')
  assert.deepEqual(readonly.permissions, ['network:appworld'])
  assert.notEqual(readonly.name, action.name)
})
