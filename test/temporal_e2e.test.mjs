import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseTemporalE2EArgs, processClean } from '../scripts/temporal_e2e.mjs'
import { parseTemporalTenArgs, SELECTION, SELECTION_RULE, unsafeProcessResult, supervisionSafety } from '../scripts/temporal_official_ten.mjs'

test('controlled E2E is model-free and limited to known synthetic scenarios', () => {
  assert.deepEqual(parseTemporalE2EArgs([]), { cases: ['candidate', 'deadline', 'user_update'] })
  assert.deepEqual(parseTemporalE2EArgs(['--case', 'candidate']), { cases: ['candidate'] })
  for (const args of [['--real-model'], ['--run'], ['--case', 'all'], ['--case', 'deadline', '--case', 'candidate']]) assert.throws(() => parseTemporalE2EArgs(args))
})
test('original ten tasks need separate prepare, run and verify commands; no silent resume', () => {
  assert.deepEqual(parseTemporalTenArgs(['--prepare']), { mode: 'prepare' })
  assert.deepEqual(parseTemporalTenArgs(['--run', 'runs/new/manifest.json']), { mode: 'run', path: 'runs/new/manifest.json' })
  assert.deepEqual(parseTemporalTenArgs(['--verify', 'runs/new/manifest.json']), { mode: 'verify', path: 'runs/new/manifest.json' })
  for (const args of [[], ['--run'], ['--prepare', '--run'], ['--resume', 'old'], ['--run', '--prepare']]) assert.throws(() => parseTemporalTenArgs(args))
  assert.equal(SELECTION.reduce((n, [, count]) => n + count, 0), 10)
  assert.match(SELECTION_RULE, /no oracle/)
  assert.match(SELECTION_RULE, /1 run each, no correction/)
})
test('process success requires closed children and no termination or logging errors', () => {
  const good = { exitCode: 0, childExited: true, childClosed: true, terminationErrors: [] }
  assert.equal(processClean(good), true)
  for (const mutation of [{ childExited: false }, { childClosed: false }, { timedOut: true }, { loggingError: 'x' }, { terminationErrors: ['x'] }]) assert.equal(processClean({ ...good, ...mutation }), false)
})
test('evidence bootstrap wraps rather than replaces model and official CLI', () => {
  const text = readFileSync(new URL('../scripts/temporal_official_entry.py', import.meta.url), 'utf8')
  assert.match(text, /result = original_model\(messages, tools, model_name, provider, endpoint\)/)
  assert.match(text, /result = original_invoke\(client, checkpoint, \*\*payload\)/)
  assert.match(text, /from are\.simulation\.benchmark import main/)
  assert.doesNotMatch(text, /readModelConnection|apiKey|OPENAI_API_KEY|baseUrl/)
})
test('nonzero closed process may be isolated, but unknown or detached children stop dispatch', () => {
  const closedFailure = { pid: 123, exitCode: 2, childExited: true, childClosed: true, terminationErrors: [] }
  assert.equal(unsafeProcessResult(closedFailure), false)
  for (const patch of [{ childExited: false }, { childClosed: false }, { manualInspectionRequired: true }, { supervisionDetached: true }, { terminationErrors: ['unresolved'] }]) assert.equal(unsafeProcessResult({ ...closedFailure, ...patch }), true)
  assert.equal(unsafeProcessResult({ pid: null, spawnError: 'not spawned', childExited: false, childClosed: false }), false)
  assert.equal(supervisionSafety('this-directory-does-not-exist', closedFailure).safeToDispatchNext, true)
  assert.equal(supervisionSafety('this-directory-does-not-exist', { ...closedFailure, childClosed: false }).safeToDispatchNext, false)
  assert.equal(supervisionSafety('this-directory-does-not-exist').reason, 'no_process_was_reserved')
})
