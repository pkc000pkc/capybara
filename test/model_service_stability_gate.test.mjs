import test from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, waitForStableModelService } from '../scripts/model_service_stability_gate.mjs'

test('stability gate requires consecutive healthy samples and resets after a failure', async () => {
  const statuses = ['unavailable', 'healthy', 'healthy']
  const sleeps = []
  let now = 1000
  const report = await waitForStableModelService({
    checks: 2,
    intervalMs: 25,
    maxChecks: 4,
    now: () => now,
    sleep: async milliseconds => { sleeps.push(milliseconds); now += milliseconds },
    check: async () => ({ status: statuses.shift(), checks: { models: { ok: true, httpStatus: 200 }, chatCompletions: { ok: true, httpStatus: 200, elapsedMs: 3 } } }),
  })
  assert.equal(report.status, 'stable')
  assert.equal(report.attempts, 3)
  assert.equal(report.consecutiveHealthy, 2)
  assert.deepEqual(sleeps, [25, 25])
  assert.equal(report.noBenchmarkExecution, true)
})

test('stability gate reports unstable after the bounded sample budget', async () => {
  const report = await waitForStableModelService({
    checks: 3,
    intervalMs: 0,
    maxChecks: 4,
    check: async () => ({ status: 'unavailable', checks: { models: { ok: true, httpStatus: 200 }, chatCompletions: { ok: false, httpStatus: 502 } } }),
    timeoutMs: 17,
    sleep: async () => {},
  })
  assert.equal(report.status, 'unstable')
  assert.equal(report.attempts, 4)
  assert.equal(report.consecutiveHealthy, 0)
})

test('stability gate validates bounded CLI options', () => {
  assert.deepEqual(parseArgs(['--checks', '2', '--interval-ms', '0', '--timeout-ms', '1000', '--max-checks', '4']), { checks: 2, intervalMs: 0, timeoutMs: 1000, maxChecks: 4 })
  assert.throws(() => parseArgs(['--max-checks', '1', '--checks', '2']), /greater than or equal/)
  assert.throws(() => parseArgs(['--checks', '0']), /out of range/)
})
