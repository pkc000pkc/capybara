import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  applyPatch,
  assertRuntimeCache,
  changedVariablePaths,
  emptyRuntimeCache,
  ModelOutputStream,
  parseModelOutput,
  textDiff,
} from '#core/runtime-loop-utils'
import { CommandError, type RuntimeVariables } from '#protocol/runtime-protocol'

function variables(): RuntimeVariables {
  return {
    builtin: {
      project_path: '',
      workspace_path: '',
      config_file: '.capybara/config.json',
      main_template: 'main.j2',
      initialized_at: '',
      system_variables_revision: '',
      prompts: {},
      variables: {},
      shared_prompts: [],
      missing_prompts: [],
      sys_message: [],
      cache: emptyRuntimeCache(),
    },
    task: { title: 'before' },
    agent: { name: 'capybara' },
    context: { files: [], history_summary: '', evidence_refs: [], evidence_digest: '' },
    user_message: '',
    tools: [],
    harnesses: [],
    skills: { catalog: [], active: [] },
  }
}

test('runtime utility diff reports nested leaf changes and a minimal text hunk', () => {
  assert.deepEqual(
    [...changedVariablePaths(
      { task: { title: 'before' }, context: { files: [] } },
      { task: { title: 'after' }, context: { files: [{ path: 'a', summary: 'A' }] } },
    )],
    ['task.title', 'context.files'],
  )
  assert.deepEqual(textDiff('one\ntwo\nthree', 'one\nchanged\nthree'), {
    startLine: 2,
    removed: ['two'],
    added: ['changed'],
  })
})

test('runtime utility JSON Patch is immutable and rejects unsafe paths', () => {
  const source = variables()
  const updated = applyPatch(source, [
    { op: 'replace', path: '/task/title', value: 'after' },
    { op: 'add', path: '/context/files/-', value: { path: 'a', summary: 'A' } },
  ])

  assert.equal(source.task.title, 'before')
  assert.equal(updated.task.title, 'after')
  assert.deepEqual(updated.context.files, [{ path: 'a', summary: 'A' }])
  assert.throws(
    () => applyPatch(source, [{ op: 'replace', path: '/__proto__/polluted', value: true }]),
    (error: unknown) => error instanceof CommandError && error.code === 'INVALID_PAYLOAD',
  )
})

test('runtime utility validates cache shape and parses model output', () => {
  const cache = emptyRuntimeCache()
  assert.doesNotThrow(() => assertRuntimeCache(cache))
  assert.throws(() => assertRuntimeCache({ ...cache, loop: { ...cache.loop, iteration: -1 } }))
  assert.deepEqual(parseModelOutput('{"status":"completed","content":"done"}'), {
    status: 'completed',
    content: 'done',
  })
  assert.throws(() => parseModelOutput('{"status":"completed","content":""}'))
})

test('runtime utility only emits completed streamed content and detects divergence', () => {
  const deltas: string[] = []
  const stream = new ModelOutputStream((delta) => deltas.push(delta))
  stream.push('{"status":"completed","content":"hel')
  assert.deepEqual(deltas, ['hel'])
  stream.push('lo"}')
  assert.deepEqual(deltas, ['hel', 'lo'])
  stream.finish({ status: 'completed', content: 'hello' })

  const divergent = new ModelOutputStream(() => undefined)
  divergent.push('{"status":"completed","content":"hello"}')
  assert.throws(() => divergent.finish({ status: 'completed', content: 'goodbye' }))
})
