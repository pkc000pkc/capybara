import assert from 'node:assert/strict'
import { test } from 'node:test'

import { redactReferenceForPresentation, redactToolCallsForPresentation } from '#core/experiments/presentation'

test('experiment tool-call presentation recursively redacts sensitive values', () => {
  const [call] = redactToolCallsForPresentation([{
    callId: 'call-1',
    name: 'example',
    status: 'failed',
    arguments: {
      access_token: 'secret-token',
      nested: { password: 'secret-password', safe: 'visible' },
    },
    resultPreview: 'authorization=Bearer real-token safe=visible',
    error: { api_key: 'secret-key', message: 'failed' },
    startedAt: '2026-08-06T00:00:00.000Z',
  }])
  assert.deepEqual(call?.arguments, {
    access_token: '[REDACTED]',
    nested: { password: '[REDACTED]', safe: 'visible' },
  })
  assert.doesNotMatch(call?.resultPreview ?? '', /real-token/)
  assert.deepEqual(call?.error, { api_key: '[REDACTED]', message: 'failed' })
})

test('experiment tool-call presentation redacts structured JSON stored as text', () => {
  const [call] = redactToolCallsForPresentation([{
    callId: 'call-2',
    name: 'historical-example',
    status: 'completed',
    arguments: {},
    resultPreview: JSON.stringify({
      access_token: 'historical-token',
      nested: { cookie: 'historical-cookie', safe: 'visible' },
    }),
    error: JSON.stringify({ refresh_token: 'historical-refresh', message: 'failed' }),
    startedAt: '2026-08-06T00:00:00.000Z',
  }])
  assert.deepEqual(JSON.parse(call?.resultPreview ?? '{}'), {
    access_token: '[REDACTED]',
    nested: { cookie: '[REDACTED]', safe: 'visible' },
  })
  assert.deepEqual(JSON.parse(String(call?.error)), {
    refresh_token: '[REDACTED]',
    message: 'failed',
  })
})

test('state-diff presentation redacts sensitive field values', () => {
  const reference = redactReferenceForPresentation({
    kind: 'state',
    status: 'available',
    source: { type: 'official_evaluator' },
    requirements: [],
    actualStateChanges: [{
      application: 'fixture',
      model: 'Account',
      records: 1,
      added: 0,
      updated: 1,
      removed: 0,
      recordChanges: [{
        recordId: 7,
        operation: 'updated',
        fields: [
          { field: 'display_name', before: 'Before', after: 'After' },
          { field: 'password', before: 'old-password', after: 'new-password' },
          { field: 'payment_card_digits', before: '1111', after: '2222' },
        ],
      }],
    }],
    stateChangesStatus: 'complete',
    failureTraces: [],
    resolvedAt: '2026-08-06T00:00:00.000Z',
  })
  const fields = reference.actualStateChanges[0]?.recordChanges?.[0]?.fields
  assert.deepEqual(fields?.[0], { field: 'display_name', before: 'Before', after: 'After' })
  assert.deepEqual(fields?.[1], { field: 'password', before: '[REDACTED]', after: '[REDACTED]' })
  assert.deepEqual(fields?.[2], { field: 'payment_card_digits', before: '[REDACTED]', after: '[REDACTED]' })
})
