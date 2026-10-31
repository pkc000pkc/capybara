import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTemporalWireRequests, executeTemporalWireComparison, parseTemporalWireProbeArgs, safeTemporalWireError } from '../scripts/temporal_provider_wire_probe.mjs'

test('default is descriptive only and real requests need --run', () => {
  assert.deepEqual(parseTemporalWireProbeArgs([]), { mode: 'describe' })
  assert.deepEqual(parseTemporalWireProbeArgs(['--run']), { mode: 'run' })
  for (const args of [['--retry'], ['--run', '--run'], ['--model', 'other']]) assert.throws(() => parseTemporalWireProbeArgs(args))
})
test('payloads differ only in tool result and notification ordering', () => {
  const [correct, legacy] = buildTemporalWireRequests('gpt-6-luna')
  const { messages: correctMessages, ...correctRest } = correct.body
  const { messages: legacyMessages, ...legacyRest } = legacy.body
  assert.deepEqual(correctRest, legacyRest)
  assert.deepEqual(correctMessages.slice(0, 3), legacyMessages.slice(0, 3))
  assert.deepEqual(correctMessages.slice(3), [legacyMessages[5], legacyMessages[3], legacyMessages[4]])
  assert.deepEqual(correctMessages.map(m => m.role), ['system', 'user', 'assistant', 'tool', 'user', 'user'])
  assert.deepEqual(legacyMessages.map(m => m.role), ['system', 'user', 'assistant', 'user', 'user', 'tool'])
  assert.equal(correct.body.max_tokens, 16); assert.equal(correct.body.tool_choice, 'none')
  assert.equal(correct.body.tools.length, 1)
})
test('two stub HTTP requests produce safe differential result without saving response text', async () => {
  const calls = [], secret = 'FAKE_KEY_MUST_NOT_BE_REPORTED_239818'
  const report = await executeTemporalWireComparison({ model: 'gpt-6-luna', baseUrl: 'https://example.invalid/v1', apiKey: secret,
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return calls.length === 1 ? new Response(JSON.stringify({ choices: [{ message: { content: secret } }] }), { status: 200 })
        : new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'invalid_message_order', param: 'messages.4.role',
          message: 'tool_calls must be followed by tool results. ' + secret } }), { status: 400 })
    } })
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.options.redirect === 'error'))
  assert.ok(calls.every(call => call.options.headers.authorization === `Bearer ${secret}`))
  assert.equal(report.status, 'legacy_order_rejected_correct_order_accepted')
  assert.equal(report.requestsAttempted, 2); assert.equal(report.automaticRetries, 0)
  assert.equal(report.results[1].mentionsToolPairing, true)
  assert.equal(report.results[1].errorCode, 'invalid_message_order')
  const serialized = JSON.stringify(report)
  assert.ok(!serialized.includes(secret)); assert.ok(!serialized.includes('example.invalid'))
  assert.ok(!serialized.includes('choices')); assert.ok(!serialized.includes('must be followed'))
  assert.equal(report.toolsExecuted, 0); assert.equal(report.benchmarkExecuted, false)
})
test('transient errors are inconclusive with no retry and no raw exceptions returned', async () => {
  let calls = 0
  const report = await executeTemporalWireComparison({ model: 'gpt-6-luna', baseUrl: 'https://example.invalid/v1', apiKey: 'test-only',
    fetchImpl: async () => { calls += 1; if (calls === 1) throw new Error('sensitive endpoint and credential'); return new Response('opaque secret body', { status: 503 }) } })
  assert.equal(calls, 2); assert.equal(report.status, 'inconclusive')
  assert.equal(report.results[0].httpStatus, null); assert.equal(report.results[1].httpStatus, 503)
  assert.ok(!JSON.stringify(report).includes('sensitive')); assert.ok(!JSON.stringify(report).includes('opaque'))
})
test('both accepted does not falsely claim the gateway rejects ordering', async () => {
  const report = await executeTemporalWireComparison({ model: 'gpt-6-luna', baseUrl: 'https://example.invalid/v1', apiKey: 'test-only',
    fetchImpl: async () => new Response('{}', { status: 200 }) })
  assert.equal(report.status, 'ordering_rejection_not_reproduced')
})
test('untrusted error fields are whitelist-only', () => {
  const result = safeTemporalWireError(JSON.stringify({ error: { type: 'SECRET', code: 'SECRET', param: 'authorization.SECRET', message: 'SECRET' } }))
  assert.deepEqual(result, { errorType: 'unclassified', errorCode: null, errorParam: null, mentionsToolPairing: false })
  assert.equal(safeTemporalWireError('raw sensitive non-JSON body').errorType, 'unclassified')
})
test('unsafe endpoint configuration is rejected before dispatch', async () => {
  let calls = 0
  for (const baseUrl of ['file:///tmp/test', 'https://user:password@example.invalid/v1', 'https://example.invalid/v1?key=secret']) await assert.rejects(
    executeTemporalWireComparison({ model: 'gpt-6-luna', baseUrl, apiKey: 'test-only', fetchImpl: async () => { calls += 1 } }))
  assert.equal(calls, 0)
})
