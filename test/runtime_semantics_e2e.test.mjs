import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DELETE_CASES, WAIT_CASES, SEMANTICS_CASES, parseRuntimeSemanticsArgs } from '../scripts/runtime_semantics_e2e.mjs'

test('runtime semantics runner is controlled only and rejects model/original/batch/resume', () => {
  assert.deepEqual(parseRuntimeSemanticsArgs([]), { cases: [...SEMANTICS_CASES] })
  for (const name of SEMANTICS_CASES) assert.deepEqual(parseRuntimeSemanticsArgs(['--case', name]), { cases: [name] })
  for (const argv of [['--model', 'gpt-6-luna'], ['--prepare'], ['--run', 'old'], ['--real-model'], ['--batch'], ['--resume'], ['--case', 'all'], ['--case', DELETE_CASES[0], '--case', DELETE_CASES[1]]]) assert.throws(() => parseRuntimeSemanticsArgs(argv))
})

test('fixture preserves actual native errors, real ARE lifecycle, and strict provider checks', () => {
  const source = readFileSync(new URL('../scripts/runtime_semantics_e2e_fixture.py', import.meta.url), 'utf8')
  for (const fragment of ['bridge._validate_provider_tool_pairs(messages)', 'env.start()', 'env.stop()', 'env.join()',
    'from are.simulation.apps.contacts import Contact, Contacts', 'Contacts(name="PeopleBook")',
    'semanticEvidence', 'entity_absent', 'deleteReceiptRef', 'synthetic_storage_dict.__contains__',
    'raise PermissionError(', 'raise RuntimeError(', 'originalErrorResultsNotRewritten']) assert.ok(source.includes(fragment), fragment)
  assert.doesNotMatch(source, /Calendar\.get_calendar_event\s*=|Contacts\.get_contact\s*=|original_invoke\([^)]*\)\s*\[|status.*absent.*=/)
})

test('runner freezes actual sources and plugin trees and sanitizes opt-in flags', () => {
  const source = readFileSync(new URL('../scripts/runtime_semantics_e2e.mjs', import.meta.url), 'utf8')
  for (const fragment of ['collectTemporalFrozenSources(root, protocol)', 'verifyConflictPluginSnapshots(plugins)',
    'GAIA2_ENTITY_SEMANTICS_ENABLED', 'GAIA2_ENTITY_SEMANTICS_WORKSPACE', 'GAIA2_TASK_CONTRACT_',
    'entitySemantics: { enabled: true }', 'processClean(actor)', 'processClean(host)', 'supervisionSafety(']) assert.ok(source.includes(fragment), fragment)
  assert.match(source, /WAIT_CASES\.includes\(testCase\)/)
  assert.match(source, /waiting \? \{ taskContract: \{ enabled: true \} \}/)
  assert.ok(WAIT_CASES.length >= 7)
})

test('waiting profiles cover exact-source registration, early finish, conditions, silence, cancellation, stop and budget', () => {
  const source = readFileSync(new URL('../scripts/runtime_semantics_e2e_fixture.py', import.meta.url), 'utf8')
  for (const name of WAIT_CASES) assert.ok(source.includes(`"${name}"`), name)
  for (const fragment of ['resolver.extract_task_contract, resolver.review_task_contract = extract, review',
    'source["arrivedAt"]', 'task_contract_hash(proposal)', '"notificationVerified": True',
    '"sourceHash": source["sourceHash"]', '"op": "bind_recipe"', '"op": "review_event"',
    '"deadline_reviewed"', '"condition_satisfied"', 'content="Premature synthetic text completion"',
    'Event.from_function(control.end_scene', 'EventType.USER', 'ordinaryUserUpdateDidNotCancelMonitor',
    'neverClaimedConditionSatisfied']) assert.ok(source.includes(fragment), fragment)
  assert.match(source, /Calendar\(name="WatchCalendar"\)/)
  assert.match(source, /Contacts\(name="WatchPeople"/)
  assert.doesNotMatch(source, /_model_call\(/)
})
