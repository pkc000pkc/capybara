import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRetrievalE2EArgs } from '../scripts/retrieval_e2e.mjs'

test('retrieval E2E defaults to controlled and real inference requires explicit opt-in', () => {
  assert.deepEqual(parseRetrievalE2EArgs([]), { realModel: false, retrievalOnly: false })
  assert.deepEqual(parseRetrievalE2EArgs(['--real-model']), { realModel: true, retrievalOnly: false })
})

test('retrieval-only diagnostics require explicit opt-in and can independently opt in to a real model', () => {
  assert.deepEqual(parseRetrievalE2EArgs(['--retrieval-only']), { realModel: false, retrievalOnly: true })
  for (const args of [['--real-model', '--retrieval-only'], ['--retrieval-only', '--real-model']])
    assert.deepEqual(parseRetrievalE2EArgs(args), { realModel: true, retrievalOnly: true })
})

test('single-case CLI rejects batch, resume, duplicate flags and implicit values', () => {
  for (const args of [['--execute'], ['--batch'], ['--real-model', '--real-model'], ['--resume'],
    ['--retrieval-only', '--retrieval-only'], ['--retrieval-only', '--batch'],
    ['--real-model', '--retrieval-only', '--real-model'], ['true'], ['--retrieval-only=true']])
    assert.throws(() => parseRetrievalE2EArgs(args), /Usage:/)
})
