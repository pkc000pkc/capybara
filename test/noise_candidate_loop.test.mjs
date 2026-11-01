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
const hash = value => value.repeat(64)
const row = (status = 'observed') => ({ observationId: 'obs-read-1', actionId: 'read-1', resourceKey: 'Contacts',
  canonicalName: 'Contacts__get_contacts', queryHash: hash('a'), resultHash: hash('b'), status, outcomeStatus: 'succeeded',
  complete: true, viewComplete: true, observedAt: 10, authoritativeRead: true,
  provenance: { actionId: 'read-1', source: 'Contacts__get_contacts', observedAt: 10 } })
const base = (status = 'observed') => ({
  gaia2_observation_state: { schemaVersion: 'gaia2-observation-state-v2', observations: [row(status)] },
  gaia2_noise_state: { semanticVersion: 2, candidateLedger: { schemaVersion: 'gaia2-noise-candidate-ledger-v1', revision: 1,
    retained: [{ candidateId: 'candidate-obs-read-1', observationId: 'obs-read-1', status: 'retained', obligationIds: [] }], candidates: [], quarantined: [] } },
  gaia2_window_obligation_state: { schemaVersion: 'gaia2-window-obligation-v1', enabled: true, revision: 1, areNow: 10,
    executionId: 'execution-1', sessionId: 'session-1', obligations: [{ id: 'window-1', userRef: 'user-1', status: 'pending',
      candidateEvidence: null, lastSignal: 'unchanged', mode: 'condition_once', deadline: 100 }] },
  gaia2_window_obligation_context: '',
})
const input = (variables, result = {}) => hook('gaia2-noise-candidate-bridge').run({
  variables: { builtin: { variables } },
  action: { id: 'watch-1', canonicalName: 'CapybaraTemporal__watch' },
  outcome: { status: 'succeeded', result: { signal: { kind: 'candidate_changed' }, lastEvidenceRef: {
    actionId: 'read-1', canonicalName: 'Contacts__get_contacts', queryHash: hash('a'), resultHash: hash('b'), observedAt: 10, ...result,
  }, state: { userRef: 'user-1' } } },
  clock: { now: 11 }, loop: { runId: 'execution-1' },
})

test('candidate bridge promotes retained evidence to review-pending obligation only', () => {
  const output = input(base())
  const noise = output.patches.find(item => item.path.endsWith('/gaia2_noise_state')).value
  const window = output.patches.find(item => item.path.endsWith('/gaia2_window_obligation_state')).value
  assert.equal(noise.candidateLedger.candidates[0].status, 'candidate')
  assert.equal(window.obligations[0].status, 'candidate_pending_review')
  assert.equal(window.obligations[0].candidateEvidence.candidateId, 'candidate-obs-read-1')
  assert.notEqual(window.obligations[0].status, 'window_completed')
  assert.match(output.patches.find(item => item.path.endsWith('/gaia2_window_obligation_context')).value, /not business completion/i)
})

test('stale/conflicting evidence is quarantined and cannot reach an obligation', () => {
  for (const status of ['stale', 'conflicting']) {
    const output = input(base(status))
    const noisePatch = output.patches.find(item => item.path.endsWith('/gaia2_noise_state'))
    assert.equal(noisePatch.value.candidateLedger.quarantined[0].status, 'quarantined')
    assert.equal(output.artifacts[0].title, 'GAIA2 candidate quarantined')
    assert.equal(output.artifacts[0].value.reason, status)
  }
})

test('candidate signal does not advance progress or fabricate completion', () => {
  const output = input(base())
  assert.equal(output.patches.some(item => item.path.endsWith('/gaia2_progress_state')), false)
  assert.equal(output.artifacts[0].value.businessSuccess, 'not_inferred')
})
