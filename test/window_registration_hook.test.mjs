import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import vm from 'node:vm'

const plugin = resolve('plugins/gaia2-runtime')
const hook = (() => {
  const code = readFileSync(join(plugin, 'hooks', 'gaia2-window-obligation-register.ts'), 'utf8')
    .replace(/^import .*\n/, '').replace('export default defineHook(', 'module.exports = (')
  const context = { module: { exports: null } }
  vm.runInNewContext(code, context, { timeout: 1000 })
  return context.module.exports
})()
const variables = () => Object.fromEntries(JSON.parse(readFileSync(join(plugin, 'variables.json'), 'utf8')).variables.map(row => [row.key, structuredClone(row.value)]))
const sourceText = 'Wait for a reply during the next minute and do not notify me.'
const sourceHash = createHash('sha256').update(sourceText).digest('hex')
const source = (mode = 'monitor_until') => ({ schemaVersion: 'gaia2-window-obligation-source-v1', enabled: true,
  executionId: 'execution-1', sessionId: 'session-1', userRef: 'user-1', sourceHash,
  span: { start: 0, end: sourceText.length, text: sourceText }, sceneStart: 0,
  parserReceiptHash: 'a'.repeat(64), obligations: [{ id: `window-${mode}`, mode, goal: 'Monitor the reply', deadline: 60, notificationPolicy: 'forbid_until_deadline', sourceSpanHash: 'b'.repeat(64), span: { start: 0, end: sourceText.length, text: sourceText } }] })
const messages = [{ role: 'user', id: 'user-1', notificationType: 'USER_MESSAGE', content: sourceText, sourceHash }]
const run = (values, inputSource = source()) => hook.run({ variables: { builtin: { variables: values } }, messages,
  clock: { now: 0 }, action: { canonicalName: 'CapybaraWindow__register', arguments: { windowSource: inputSource } },
  loop: { runId: 'execution-1', iteration: 1 } })
const apply = (values, result) => { for (const patch of result.patches || []) values[patch.path.split('/').at(-1)] = structuredClone(patch.value); return result }

test('trusted source registration binds exact user span and registers monitor/condition windows', () => {
  for (const mode of ['monitor_until', 'condition_once']) {
    const values = variables(), result = run(values, source(mode)); apply(values, result)
    assert.equal(values.gaia2_window_obligation_state.enabled, true)
    assert.equal(values.gaia2_window_obligation_state.obligations[0].mode, mode)
    assert.equal(values.gaia2_window_obligation_state.obligations[0].deadline, 60)
    assert.equal(values.gaia2_window_obligation_state.obligations[0].notificationPolicy, 'forbid_until_deadline')
    assert.match(values.gaia2_window_obligation_context, /Candidates require Actor review/)
    assert.equal(result.artifacts[0].value.schemaVersion, 'gaia2-window-registration-receipt-v1')
  }
})

test('registration is idempotent and does not allow source rebinding', () => {
  const values = variables(), first = apply(values, run(values, source()))
  const second = run(values, source())
  assert.equal(second.patches.length, 0)
  const changed = source(); changed.obligations[0].deadline = 59
  assert.throws(() => run(values, changed), /WINDOW_SOURCE_STATE_MISMATCH/)
  assert.equal(first.artifacts[0].value.registered, true)
})

test('bad source span or parser receipt fails closed before registration', () => {
  for (const mutate of [s => { s.obligations[0].span.text = 'not the source' }, s => { s.parserReceiptHash = 'bad' }, s => { s.obligations[0].deadline = -1 }]) {
    const values = variables(), bad = source(); mutate(bad)
    assert.throws(() => run(values, bad))
    assert.equal(values.gaia2_window_obligation_state.enabled, false)
  }
})

test('forged source hash cannot register an otherwise visible window source', () => {
  const values = variables(), bad = source(); bad.sourceHash = 'f'.repeat(64)
  assert.throws(() => run(values, bad), /WINDOW_SOURCE_SPAN/)
  assert.equal(values.gaia2_window_obligation_state.enabled, false)
})
