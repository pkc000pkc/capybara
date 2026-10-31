import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { freezePluginSnapshot } from '../src/phase0_inventory.mjs'
import { validateConflictState } from '../src/conflict_receipt.mjs'

const project = resolve(fileURLToPath(new URL('..', import.meta.url)))
const config = JSON.parse(readFileSync(join(project, 'config/phase0-protocol.json')))
const backend = config.runtime.backendRoot
const exec = promisify(execFile)
const hash = text => createHash('sha256').update(text).digest('hex')
const pyJson = value => Array.isArray(value) ? '[' + value.map(pyJson).join(', ') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ': ' + pyJson(value[key])).join(', ') + '}' : JSON.stringify(value)
const nativeHash = value => hash(pyJson(value))

if (!process.argv.includes('--probe')) {
  test('three unrelated domains use real Host advisory evidence without automatic recovery', { timeout: 180000 }, async () => {
    const { stdout } = await exec(process.execPath, ['--import', pathToFileURL(join(backend, 'node_modules/tsx/dist/loader.mjs')).href,
      fileURLToPath(import.meta.url), '--probe', '--advisory'], { cwd: backend, timeout: 170000, maxBuffer: 2 * 1024 * 1024 })
    const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1))
    assert.deepEqual(result.domains.map(row => row.domain), ['Warehouse', 'AddressBook', 'Reservations'])
    assert.ok(result.domains.every(row => row.status === 'passed' && row.originalWrites === 1 && row.nativeReads === 0 && row.automaticQueries === 0))
    assert.equal(result.realModelRequests, 0)
  })

  test('80KB originals stay advisory across three domains without automatic recovery', { timeout: 180000 }, async () => {
    const { stdout } = await exec(process.execPath, ['--import', pathToFileURL(join(backend, 'node_modules/tsx/dist/loader.mjs')).href,
      fileURLToPath(import.meta.url), '--probe', '--advisory', '--large'], { cwd: backend, timeout: 170000, maxBuffer: 2 * 1024 * 1024 })
    const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1))
    assert.equal(result.largeEvidence, true)
    assert.ok(result.domains.every(row => row.status === 'passed' && row.evidenceBytes > 80 * 1024 && row.nativeReads === 0 && row.automaticQueries === 0))
    assert.equal(result.realModelRequests, 0)
  })
} else {
  const largeEvidence = process.argv.includes('--large')
  assert.ok(process.argv.includes('--advisory'), 'controlled probe must use advisory semantics')
  const { RuntimePluginHost } = await import(pathToFileURL(join(backend, 'src/core/plugins/runtime-plugin-host.ts')).href)
  const root = mkdtempSync(join(project, 'runs', 'evidence-gate-advisory-'))
  const snapshot = freezePluginSnapshot({ root, id: 'gaia2-runtime', sourceRoot: join(project, 'plugins/gaia2-runtime') })
  const domains = []

  for (const domain of ['Warehouse', 'AddressBook', 'Reservations']) {
    const workspaceDir = join(root, domain)
    mkdirSync(workspaceDir)
    const executionId = 'controlled-advisory-' + domain
    const sessionId = 'session-' + domain
    const host = new RuntimePluginHost({ projectDir: root, workspaceDir, plugins: [snapshot], executionId, sessionId, scenarioId: 'synthetic-advisory-' + domain })
    await host.initialize()
    const user = { role: 'user', id: 'user-' + domain, notificationType: 'USER_MESSAGE', content: 'Controlled generic evidence test.' }
    let frames = []
    let sequence = 0
    const toHook = frame => ({ role: 'tool', toolCallId: frame.tool_call_id, content: frame.content, observation: frame.observation })
    const invoke = (checkpoint, extra = {}, now = 12) => host.invoke({ checkpoint, clock: { now, revision: ++sequence }, loop: { iteration: sequence }, messages: [user, ...frames.map(toHook)], ...extra })
    const makeAction = (id, method, args, effect = 'read', resource = domain) => ({
      id, name: domain + '__' + method, canonicalName: domain + '__' + method, arguments: args,
      effect, mutationKey: hash(pyJson({ method, args })), resourceKey: resource, resourceDependencies: [resource],
      authoritativeRead: effect === 'read', idempotent: effect === 'read',
    })
    const seed = async (id, method, args, result, complete) => {
      const action = makeAction(id, method, args)
      const observation = { actionId: id, resourceKey: domain, canonicalName: action.canonicalName, queryHash: action.mutationKey,
        resultHash: nativeHash(result), observedAt: 10, complete, viewComplete: true }
      frames.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(result), observation })
      const response = await invoke('after_tool', { action, outcome: { status: 'succeeded', complete, executed: true, resultHash: observation.resultHash, result } })
      assert.equal(response.decision.action, 'allow')
    }
    try {
      const listResult = { rows: ['item-a', 'item-b'], range: [0, 2], total: 9, ...(largeEvidence ? { rawOriginal: 'x'.repeat(80 * 1024) } : {}) }
      await seed('list-' + domain, 'list_items', { offset: 0, limit: 2 }, listResult, false)
      await seed('point-' + domain, 'get_item', { id: 'item-a' }, { id: 'item-a', label: domain }, true)
      frames[1].observation.viewComplete = false
      frames[1].observation.viewIncompleteReason = 'hidden'
      await invoke('before_model')
      assert.deepEqual(host.snapshot().variables.gaia2_observation_state.unverified_ids, ['obs-list-' + domain])
      assert.deepEqual(host.snapshot().variables.gaia2_observation_state.visibility_ids, ['obs-point-' + domain])

      const action = makeAction('dependent', 'update_item', { id: 'item-a' }, 'write', domain)
      const before = await invoke('before_tool', { action })
      assert.equal(before.decision.action, 'allow')
      const report = JSON.parse(readFileSync(before.evidencePath))
      const plan = report.variables.gaia2_conflict_state
      validateConflictState(plan)
      assert.equal(plan.schemaVersion, 'gaia2-conflict-state-v1')
      assert.equal(plan.status, 'idle')
      assert.deepEqual(plan.requests, [])
      const advisory = report.artifacts.find(item => item.title === 'GAIA2 advisory evidence diagnostics')
      assert.ok(advisory)
      assert.equal(advisory.value.automaticQueries, 0)
      assert.equal(advisory.value.enforced, false)

      // The Actor explicitly decides to execute the write; the Hook reports
      // evidence diagnostics but does not synthesize a recovery or replay it.
      const result = { updated: true, id: 'item-a', ...(largeEvidence ? { rawOriginal: 'x'.repeat(80 * 1024) } : {}) }
      const outcome = { status: 'succeeded', complete: true, executed: true, resultHash: nativeHash(result), result }
      frames.push({ role: 'tool', tool_call_id: action.id, content: JSON.stringify(result), observation: {
        actionId: action.id, resourceKey: domain, canonicalName: action.canonicalName, queryHash: action.mutationKey,
        resultHash: outcome.resultHash, observedAt: 12, complete: true, viewComplete: true,
      } })
      const after = await invoke('after_tool', { action, outcome })
      assert.equal(after.decision.action, 'allow', JSON.stringify(after))
      assert.equal(host.snapshot().variables.gaia2_conflict_state.status, 'idle')
      domains.push({ domain, status: 'passed', originalWrites: 1, nativeReads: 0, automaticQueries: 0, evidenceBytes: JSON.stringify(listResult).length })
    } finally {
      await host.close()
    }
  }

  const result = { status: 'passed', evidenceRoot: root, domains, largeEvidence, realModelRequests: 0, benchmarkExecuted: false,
    nativeTools: 'synthetic controlled callbacks; actual Host advisory diagnostics', frozenPlugin: snapshot,
    sources: ['src/conflict_receipt.mjs', 'test/evidence_gate_controlled.test.mjs'].map(path => ({ path, sha256: hash(readFileSync(join(project, path))) })),
    backendHostSha256: hash(readFileSync(join(backend, 'src/core/plugins/runtime-plugin-host.ts'))) }
  writeFileSync(join(root, 'report.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ status: result.status, evidenceRoot: root, domains, largeEvidence, realModelRequests: 0, benchmarkExecuted: false }))
}
