import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { freezePluginSnapshot } from '../src/phase0_inventory.mjs'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const backend = JSON.parse(readFileSync(join(project, 'config/phase0-protocol.json'), 'utf8')).runtime.backendRoot
const hash = value => createHash('sha256').update(value).digest('hex')
const cases = ['duplicate-ttl', 'ttl-before-model', 'native-return-time', 'future-return-time', 'failed-complete-metadata', 'successful-missing-complete', 'conflict-query', 'partial-query-recovery', 'precise-recovery-unknown-write', 'provider-view-history', 'provider-view-direct-gate', 'view-binding-negative', 'finite-progress', 'freshness-not-progress', 'known-progress-write-wait', 'notification-progress']

if (!process.argv.includes('--probe')) {
  test('phase5 information-noise contract executes through the actual frozen TS HookHost, not a model or benchmark', { timeout: 180000 }, async t => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', pathToFileURL(join(backend, 'node_modules/tsx/dist/loader.mjs')).href, fileURLToPath(import.meta.url), '--probe'], { cwd: backend, timeout: 170000, maxBuffer: 1024 * 1024 })
    const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1))
    assert.equal(result.realModelCalls, 0)
    assert.equal(result.benchmarkExecuted, false)
    assert.deepEqual(result.passed, cases)
    console.log(JSON.stringify({ informationNoiseFixtureRoot: result.fixtureRoot, passedCases: result.passed.length, realModelCalls: result.realModelCalls, benchmarkExecuted: result.benchmarkExecuted }))
    for (const name of result.passed) await t.test(name, () => assert.equal(result.evidence[name].realHost, true))
  })
} else {
  const { RuntimePluginHost } = await import(pathToFileURL(resolve(backend, 'src/core/plugins/runtime-plugin-host.ts')).href)
  const root = mkdtempSync(join(tmpdir(), 'gaia2-information-noise-'))
  const snapshot = freezePluginSnapshot({ root, id: 'gaia2-runtime', sourceRoot: join(project, 'plugins/gaia2-runtime') })
  const evidence = {}, passed = []
  for (const name of cases) {
    const workspaceDir = join(root, name)
    mkdirSync(workspaceDir)
    const host = new RuntimePluginHost({ projectDir: root, workspaceDir, plugins: [snapshot], executionId: 'noise-' + name, sessionId: 'noise-session-' + name, scenarioId: 'noise-fixture', attemptIndex: 1 })
    await host.initialize()
    let sequence = 0
    const invoke = async (checkpoint, now, extra = {}) => {
      const response = await host.invoke({ checkpoint, clock: { now, revision: ++sequence }, loop: { iteration: sequence, terminal: false }, ...extra })
      return { response, receipt: JSON.parse(readFileSync(response.evidencePath, 'utf8')), values: host.snapshot().variables }
    }
    const action = (id, query = 'query-a', resource = 'Mail', effect = 'read', canonical = 'EmailClientV2__read') => ({ id, name: canonical, canonicalName: canonical, arguments: { query }, effect, mutationKey: hash(query), resourceKey: resource, idempotent: effect === 'read', authoritativeRead: effect === 'read' })
    const read = async (id, query, value, now, { resource = 'Mail', status = 'succeeded', complete = true } = {}) => {
      const input = action(id, query, resource)
      const before = await invoke('before_tool', now, { action: input })
      assert.equal(before.response.decision.action, 'allow', id + ' must remain a safe authoritative read')
      return await invoke('after_tool', now, { action: input, outcome: { status, complete, executed: true, resultHash: hash(value) } })
    }
    const state = () => host.snapshot().variables
    const viewFor = record => ({ role: 'tool', id: 'message-' + record.actionId, toolCallId: record.actionId, content: 'opaque native observation', observation: { actionId: record.actionId, resourceKey: record.resourceKey, canonicalName: record.canonicalName, queryHash: record.queryHash, resultHash: record.resultHash, observedAt: record.observedAt, complete: record.complete, viewComplete: false, viewIncompleteReason: 'truncated' } })
    const last = () => state().gaia2_observation_state.observations.at(-1)
    try {
      if (name === 'duplicate-ttl') {
        await read('dup-a', 'query-a', 'same', 0)
        await read('dup-b', 'query-a', 'same', 10)
        assert.equal(last().status, 'duplicate'); assert.equal(last().duplicateOf, 'obs-dup-a'); assert.equal(last().observedAt, 10)
        await invoke('before_model', 70)
        assert.equal(state().gaia2_observation_state.stale_ids.length, 0, '60 seconds is not expired')
        const stale = await invoke('before_tool', 71, { action: action('mutation', 'write-a', 'Mail', 'write', 'EmailClientV2__send') })
        assert.equal(stale.response.decision.action, 'allow', 'TTL is advisory, not business approval'); assert.deepEqual(state().gaia2_observation_state.stale_ids, ['obs-dup-b'])
        await read('dup-c', 'query-a', 'same', 72)
        assert.equal(state().gaia2_observation_state.stale_ids.length, 0)
        assert.equal(state().gaia2_observation_state.observations.find(item => item.actionId === 'dup-b').verifiedBy, 'dup-c')
      }
      if (name === 'conflict-query') {
        await read('first', 'query-a', 'old', 0)
        await read('changed', 'query-a', 'new', 1)
        assert.deepEqual(state().gaia2_observation_state.conflict_ids, [])
        assert.equal(last().changedFromActionId, 'first')
        await read('other-query', 'query-b', 'different', 2)
        await read('other-app', 'query-a', 'different', 3, { resource: 'Chats' })
        assert.equal(state().gaia2_observation_state.conflict_ids.length, 0, 'changed native results do not require a confirmation query')
        const blocked = await invoke('before_tool', 4, { action: action('write-conflict', 'write-a', 'Mail', 'write', 'EmailClientV2__send') })
        assert.equal(blocked.response.decision.action, 'allow', 'evidence diagnostics do not veto business judgment')
        await read('confirmed', 'query-a', 'new', 5)
        assert.equal(last().duplicateOf, 'obs-changed'); assert.equal(state().gaia2_observation_state.conflict_ids.length, 0)
        assert.equal(state().gaia2_observation_state.observations.find(item => item.actionId === 'first').status, 'superseded_by_fresh_read')
      }
      if (name === 'ttl-before-model') {
        await read('old', 'query-a', 'same', 100)
        await invoke('before_model', 160.001)
        assert.deepEqual(state().gaia2_observation_state.stale_ids, ['obs-old'])
        const other = await invoke('before_tool', 161, { action: action('other-app', 'write', 'Chats', 'write', 'MessagingAppV2__send_message') })
        assert.equal(other.response.decision.action, 'allow', 'stale unrelated application evidence is not a global write ban')
      }
      if (name === 'native-return-time' || name === 'future-return-time') {
        const input = action('return-time', 'query-a')
        const observation = { actionId: input.id, resourceKey: input.resourceKey, canonicalName: input.canonicalName, queryHash: input.mutationKey, resultHash: hash('full'), complete: true, viewComplete: true, observedAt: name === 'native-return-time' ? 1 : 20 }
        const after = await invoke('after_tool', 10, { action: input, outcome: { status: 'succeeded', complete: true, executed: true, resultHash: hash('full') }, messages: [{ role: 'tool', toolCallId: input.id, content: 'full', observation }] })
        if (name === 'native-return-time') {
          assert.equal(last().observedAt, 1, 'the ARE collection time precedes later Hook processing')
          const before = await invoke('before_model', 12, { messages: [{ role: 'tool', toolCallId: input.id, content: 'full', observation }] })
          assert.equal(before.response.decision.action, 'allow')
        } else {
          assert.equal(after.response.decision.action, 'block')
          assert.equal(state().gaia2_observation_state.observations.length, 0, 'future collected evidence is never admitted')
        }
      }
      if (name === 'failed-complete-metadata') {
        const input = action('official-noise-error', 'query-a')
        const observation = { actionId: input.id, resourceKey: input.resourceKey, canonicalName: input.canonicalName, queryHash: input.mutationKey, resultHash: hash('native-error'), complete: true, viewComplete: true, observedAt: 1 }
        const after = await invoke('after_tool', 2, { action: input, outcome: { status: 'failed_before_execution', complete: true, executed: true, resultHash: hash('native-error') }, messages: [{ role: 'tool', toolCallId: input.id, content: 'opaque native error', observation }] })
        assert.equal(after.response.hookReceipts.find(item => item.hookId === 'gaia2-noise-classifier').status, 'passed', 'complete deterministic failure is a valid native observation')
        assert.equal(last().complete, true)
        assert.equal(last().status, 'failed')
        assert.deepEqual(state().gaia2_observation_state.unverified_ids, ['obs-official-noise-error'])
        const blocked = await invoke('before_tool', 3, { action: action('noise-write', 'mutation-a', 'Mail', 'write', 'EmailClientV2__send') })
        assert.equal(blocked.response.decision.action, 'allow', 'complete failure remains visible evidence, not a resource-wide mutation ban')
      }
      if (name === 'successful-missing-complete') {
        const input = action('successful-missing-complete', 'query-a')
        const after = await invoke('after_tool', 2, { action: input, outcome: { status: 'succeeded', executed: true, resultHash: hash('partial-success') } })
        assert.equal(after.response.hookReceipts.find(item => item.hookId === 'gaia2-noise-classifier').status, 'passed')
        assert.equal(last().status, 'incomplete')
        assert.equal(last().complete, false)
        assert.deepEqual(state().gaia2_observation_state.unverified_ids, ['obs-successful-missing-complete'])
      }
      if (name === 'partial-query-recovery') {
        await read('prior', 'query-a', 'old', 0)
        await read('changed', 'query-a', 'new', 1)
        await read('partial', 'query-a', 'new', 2, { complete: false })
        assert.equal(state().gaia2_observation_state.conflict_ids.length, 0)
        assert.deepEqual(state().gaia2_observation_state.unverified_ids, ['obs-partial'])
        await read('full', 'query-a', 'new', 3)
        assert.equal(state().gaia2_observation_state.conflict_ids.length, 0)
        assert.equal(state().gaia2_observation_state.unverified_ids.length, 0)
      }
      if (name === 'precise-recovery-unknown-write') {
        await read('failed-a', 'query-a', 'failed', 0, { status: 'failed_before_execution' })
        await read('partial-b', 'query-b', 'partial', 1, { complete: false })
        await read('fresh-b', 'query-b', 'complete', 2)
        assert.deepEqual(state().gaia2_observation_state.unverified_ids, ['obs-failed-a'])
        const write = action('unknown-write', 'mutation-a', 'Mail', 'write', 'EmailClientV2__send')
        await invoke('after_tool', 3, { action: write, outcome: { status: 'unknown', complete: false, executed: true, resultHash: hash('unknown') } })
        await read('fresh-a', 'query-a', 'complete', 4)
        assert.equal(state().gaia2_write_state.unknown.length, 1)
        assert.ok(state().gaia2_observation_state.unverified_ids.includes('obs-unknown-write'))
        const again = await invoke('before_tool', 5, { action: { ...write, id: 'unknown-replay' } })
        assert.notEqual(again.response.decision.action, 'allow', 'fresh read never permits unknown write replay')
      }
      if (name === 'provider-view-history') {
        await read('visible', 'query-a', 'full', 0)
        const oldView = viewFor(last())
        await invoke('before_model', 1, { messages: [oldView] })
        assert.deepEqual(state().gaia2_observation_state.unverified_ids, [])
        assert.deepEqual(state().gaia2_observation_state.visibility_ids, ['obs-visible'])
        assert.equal(last().status, 'observed', 'presentation loss does not corrupt native truth')
        const blocked = await invoke('before_tool', 2, { action: action('view-write', 'mutation-a', 'Mail', 'write', 'EmailClientV2__send'), messages: [oldView] })
        assert.equal(blocked.response.decision.action, 'allow', 'hidden presentation is diagnostic')
        await read('reread', 'query-a', 'full', 3)
        await invoke('before_model', 4, { messages: [oldView] })
        const recovered = await invoke('before_tool', 5, { action: action('recovered-write', 'mutation-a', 'Mail', 'write', 'EmailClientV2__send'), messages: [oldView] })
        assert.equal(recovered.response.decision.action, 'allow', 'verified old hidden messages must not reopen uncertainty')
        assert.equal(state().gaia2_observation_state.unverified_ids.length, 0)
      }
      if (name === 'view-binding-negative') {
        await read('identity', 'query-a', 'full', 0)
        const forged = viewFor(last()); forged.observation.resultHash = hash('forged')
        const blocked = await invoke('before_tool', 1, { action: action('forged-write', 'mutation-a', 'Mail', 'write', 'EmailClientV2__send'), messages: [forged] })
        assert.equal(blocked.response.decision.action, 'block')
        assert.equal(blocked.response.hookReceipts.find(item => item.hookId === 'gaia2-conflict-gate').status, 'failed')
      }
      if (name === 'provider-view-direct-gate') {
        await read('visible', 'query-a', 'full', 0)
        const hidden = viewFor(last()); hidden.observation.viewIncompleteReason = 'hidden'
        const blocked = await invoke('before_tool', 1, { action: action('hidden-write', 'mutation-a', 'Mail', 'write', 'EmailClientV2__send'), messages: [hidden] })
        assert.equal(blocked.response.decision.action, 'allow', 'direct tool gate records missing presentation without vetoing business judgment')
        assert.equal(last().viewIncompleteReason, 'hidden')
      }
      if (name === 'finite-progress') {
        await read('failure', 'query-a', 'failure', 0, { status: 'failed_before_execution' })
        const write = action('repeat-1', 'mutation-a', 'Mail', 'write', 'EmailClientV2__send')
        for (let index = 1; index <= 6; index++) assert.equal((await invoke('before_tool', index, { action: { ...write, id: 'repeat-' + index } })).response.decision.action, 'allow')
        assert.equal(state().gaia2_progress_state.consecutive_no_progress, 1, 'admission alone does not inflate business-progress counters')
        const stoppedRepeat = await invoke('before_tool', 7, { action: { ...write, id: 'repeat-last' } })
        assert.equal(stoppedRepeat.response.decision.action, 'allow')
        assert.doesNotMatch(stoppedRepeat.response.decision.reason, /no_progress_replan_required/)
        assert.equal(stoppedRepeat.response.hookReceipts.find(item => item.hookId === 'gaia2-conflict-gate').status, 'passed')
        assert.equal((await invoke('before_tool', 8, { action: action('wait-safe', 'wait', 'SystemApp', 'wait', 'SystemApp__wait_for_notification') })).response.decision.action, 'allow')
        assert.equal((await invoke('before_tool', 8, { action: action('finish-safe', 'finish', 'AgentUserInterface', 'finish', 'AgentUserInterface__send_message_to_user') })).response.decision.action, 'allow')
        await read('recovered', 'query-a', 'fresh', 9)
        assert.equal(state().gaia2_progress_state.consecutive_no_progress, 0)
        assert.equal((await invoke('before_tool', 10, { action: { ...write, id: 'after-recovery' } })).response.decision.action, 'allow')
        assert.notEqual(state().gaia2_attempt_state.status, 'agent_finished', 'no-progress never fabricates a terminal attempt')
      }
      if (name === 'notification-progress') {
        await read('first', 'query-a', 'same', 0)
        for (let index = 1; index <= 3; index++) await read('unchanged-' + index, 'query-a', 'same', index)
        assert.equal(state().gaia2_progress_state.consecutive_no_progress, 3)
        await invoke('before_model', 4, { messages: [{ role: 'user', id: 'feedback', content: 'internal feedback' }] })
        assert.equal(state().gaia2_progress_state.consecutive_no_progress, 3)
        await invoke('before_model', 5, { messages: [{ role: 'user', id: 'env', content: 'real ENV notice', notificationType: 'ENVIRONMENT_NOTIFICATION' }] })
        assert.equal(state().gaia2_progress_state.consecutive_no_progress, 3)
        await invoke('before_model', 6, { messages: [{ role: 'user', id: 'user', content: 'real USER notice', notificationType: 'USER_MESSAGE' }] })
        assert.equal(state().gaia2_progress_state.consecutive_no_progress, 0)
        assert.deepEqual(state().gaia2_progress_state.seen_user_ids, ['user'])
        await read('unchanged-after-user', 'query-a', 'same', 7)
        await invoke('before_model', 8, { messages: [{ role: 'user', id: 'user', content: 'same prior user notice', notificationType: 'USER_MESSAGE' }] })
        assert.equal(state().gaia2_progress_state.consecutive_no_progress, 1, 'the same real USER must not reset twice')
      }
      if (name === 'freshness-not-progress') {
        await read('first', 'query-a', 'same', 0)
        await read('duplicate-1', 'query-a', 'same', 1)
        await read('duplicate-2', 'query-a', 'same', 2)
        assert.equal(last().observedAt, 2)
        assert.equal(state().gaia2_progress_state.consecutive_no_progress, 2, 'fresh same-content results are not new task progress')
        await read('new-query', 'query-b', 'same', 3)
        assert.equal(state().gaia2_progress_state.consecutive_no_progress, 0)
        assert.equal(state().gaia2_observation_state.conflict_ids.length, 0)
      }
      if (name === 'known-progress-write-wait') {
        await read('first', 'query-a', 'same', 0)
        await read('dup', 'query-a', 'same', 1)
        const write = action('successful-write', 'mutation-a', 'Mail', 'write', 'EmailClientV2__send')
        assert.equal((await invoke('before_tool', 2, { action: write })).response.decision.action, 'allow')
        await invoke('after_tool', 2, { action: write, outcome: { status: 'succeeded', complete: true, executed: true, resultHash: hash('same') } })
        assert.equal(state().gaia2_progress_state.consecutive_no_progress, 0)
        assert.equal((await invoke('before_tool', 3, { action: { ...write, id: 'write-replay' } })).response.decision.action, 'block', 'successful write progress never grants duplicate write replay')
        await read('dup-again', 'query-a', 'same', 4)
        const wait = action('wait', 'waiting', 'SystemApp', 'wait', 'SystemApp__wait_for_notification')
        await invoke('after_tool', 5, { action: wait, outcome: { status: 'succeeded', complete: true, executed: true, resultHash: hash('wait') } })
        assert.equal(state().gaia2_progress_state.consecutive_no_progress, 0)
        assert.equal(state().gaia2_progress_state.last_reason, 'new_observable_progress')
      }
      evidence[name] = { realHost: true, invocationCount: sequence, observationCount: state().gaia2_observation_state.observations.length, evidenceDir: workspaceDir }
      passed.push(name)
    } finally { await host.close() }
  }
  console.log(JSON.stringify({ passed, evidence, realModelCalls: 0, benchmarkExecuted: false, fixtureRoot: root }))
}
