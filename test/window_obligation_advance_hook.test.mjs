import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
function hook(name) {
  const source = readFileSync(join(root, 'plugins/gaia2-runtime/hooks', `${name}.ts`), 'utf8')
    .replace(/^import .*\n/, '').replace('export default defineHook(', 'module.exports = (')
  const context = { module: { exports: null } }
  vm.runInNewContext(source, context, { timeout: 1000 })
  return context.module.exports
}

const base = () => ({
  schemaVersion: 'gaia2-window-obligation-v1', enabled: true, revision: 1, areNow: 100, executionId: 'execution-1', sessionId: 'session-1',
  obligations: [{ schemaVersion: 'gaia2-window-obligation-v1', id: 'window-1', userRef: 'user-1',
    mode: 'monitor_until', goal: 'Monitor a source', notificationPolicy: 'forbid_until_deadline',
    sceneStart: 0, deadline: 100, status: 'pending', candidateEvidence: null,
    lastReviewedActionId: null, completionReason: null, terminationSignal: null,
    waitCount: 2, scanCount: 2, lastSignal: 'unchanged' }],
})

const action = { canonicalName: 'CapybaraTemporal__watch', effect: 'read', resourceKey: 'CapybaraTemporal' }
const result = { signal: { kind: 'deadline' }, state: { schemaVersion: 'gaia2-temporal-state-v1', executionId: 'execution-1', userRef: 'user-1', sessionId: 'session-1', deadline: 100 },
  observation: { actionId: 'read-final', observedAt: 100, complete: true, viewComplete: true } }

test('deadline advance closes only a bound monitor window after final complete evidence', () => {
  const vars = { gaia2_window_obligation_state: base(), gaia2_window_obligation_context: '' }
  const output = hook('gaia2-window-obligation-advance').run({
    variables: { builtin: { variables: vars } }, action,
    outcome: { status: 'succeeded', result }, clock: { now: 100 }, loop: { runId: 'execution-1' },
  })
  const patch = output.patches.find(item => item.path.endsWith('/gaia2_window_obligation_state'))
  assert.equal(patch.value.obligations[0].status, 'window_completed')
  assert.equal(patch.value.obligations[0].completionReason, 'deadline_reviewed')
  assert.equal(patch.value.obligations[0].lastReviewedActionId, 'read-final')
})

test('deadline advance closes a condition window only without a candidate; mismatched users and incomplete evidence remain conservative', () => {
  const conditionState = base();
  conditionState.obligations[0].mode = 'condition_once';
  const conditionOutput = hook('gaia2-window-obligation-advance').run({
    variables: { builtin: { variables: { gaia2_window_obligation_state: conditionState } } }, action,
    outcome: { status: 'succeeded', result }, clock: { now: 100 }, loop: { runId: 'execution-1' },
  });
  const conditionPatch = conditionOutput.patches.find(item => item.path.endsWith('/gaia2_window_obligation_state'));
  assert.equal(conditionPatch.value.obligations[0].status, 'window_completed');
  assert.equal(conditionPatch.value.obligations[0].completionReason, 'deadline_reviewed');

  for (const mutate of [
    state => { state.obligations[0].mode = 'condition_once'; state.obligations[0].candidateEvidence = { actionId: 'candidate-1' } },
    state => { result.state.userRef = 'other-user' },
    state => { result.state.sessionId = 'other-session' },
    state => { result.observation.viewComplete = false },
    state => { result.observation.observedAt = 99 },
  ]) {
    const state = base();
    const originalUser = result.state.userRef, originalSession = result.state.sessionId, originalView = result.observation.viewComplete, originalObserved = result.observation.observedAt
    mutate(state)
    const output = hook('gaia2-window-obligation-advance').run({ variables: { builtin: { variables: { gaia2_window_obligation_state: state } } }, action,
      outcome: { status: 'succeeded', result }, clock: { now: 100 }, loop: { runId: 'execution-1' } })
    assert.equal(output.patches.length, 0)
    result.state.userRef = originalUser; result.state.sessionId = originalSession; result.observation.viewComplete = originalView; result.observation.observedAt = originalObserved
  }
})

test('native notification wait can close an elapsed condition window without claiming business success', () => {
  const state = base();
  state.obligations[0].mode = 'condition_once';
  const output = hook('gaia2-window-obligation-advance').run({
    variables: { builtin: { variables: { gaia2_window_obligation_state: state } } },
    action: { canonicalName: 'SystemApp__wait_for_notification', id: 'native-wait-1' },
    outcome: { status: 'succeeded', result: { status: 'succeeded' } },
    clock: { now: 101 }, loop: { runId: 'execution-1' },
  });
  const patch = output.patches.find(item => item.path.endsWith('/gaia2_window_obligation_state'));
  assert.equal(patch.value.obligations[0].status, 'window_completed');
  assert.equal(patch.value.obligations[0].completionReason, 'deadline_reviewed');
  assert.equal(patch.value.obligations[0].lastReviewedActionId, 'native-wait-1');
  const artifact = output.artifacts[0].value;
  assert.equal(artifact.executionId, 'execution-1');
  assert.equal(Object.hasOwn(artifact, 'sessionId'), false);
})
