import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  applyPatch,
  assertRuntimeCache,
  changedVariablePaths,
  emptyRuntimeCache,
  ModelOutputStream,
  parseModelOutput,
  textDiff,
} from '#core/runtime-loop-utils'
import { CommandError, type RuntimeVariables } from '#protocol/runtime-protocol'

function variables(): RuntimeVariables {
  return {
    builtin: {
      project_path: '',
      workspace_path: '',
      config_file: '.capybara/config.json',
      main_template: 'main.j2',
      initialized_at: '',
      system_variables_revision: '',
      prompts: {},
      variables: {},
      shared_prompts: [],
      missing_prompts: [],
      sys_message: [],
      cache: emptyRuntimeCache(),
    },
    task: { title: 'before' },
    agent: { name: 'capybara' },
    context: { files: [], history_summary: '', evidence_refs: [], evidence_digest: '' },
    user_message: '',
    tools: [],
    harnesses: [],
    skills: { catalog: [], active: [] },
  }
}

test('runtime utility diff reports nested leaf changes and a minimal text hunk', () => {
  assert.deepEqual(
    [...changedVariablePaths(
      { task: { title: 'before' }, context: { files: [] } },
      { task: { title: 'after' }, context: { files: [{ path: 'a', summary: 'A' }] } },
    )],
    ['task.title', 'context.files'],
  )
  assert.deepEqual(textDiff('one\ntwo\nthree', 'one\nchanged\nthree'), {
    startLine: 2,
    removed: ['two'],
    added: ['changed'],
  })
})

test('runtime utility JSON Patch is immutable and rejects unsafe paths', () => {
  const source = variables()
  const updated = applyPatch(source, [
    { op: 'replace', path: '/task/title', value: 'after' },
    { op: 'add', path: '/context/files/-', value: { path: 'a', summary: 'A' } },
  ])

  assert.equal(source.task.title, 'before')
  assert.equal(updated.task.title, 'after')
  assert.deepEqual(updated.context.files, [{ path: 'a', summary: 'A' }])
  assert.throws(
    () => applyPatch(source, [{ op: 'replace', path: '/__proto__/polluted', value: true }]),
    (error: unknown) => error instanceof CommandError && error.code === 'INVALID_PAYLOAD',
  )
})

test('runtime utility validates cache shape and parses model output', () => {
  const cache = emptyRuntimeCache()
  assert.equal(cache.version, 2)
  assert.deepEqual(cache.reviews, [])
  assert.doesNotThrow(() => assertRuntimeCache(cache))
  assert.doesNotThrow(() => assertRuntimeCache({
    version: 1,
    summary: '',
    messages: [],
    loop: { run_id: '', iteration: 0, tool_round: 0, continuation_round: 0 },
    compression_count: 0,
    compressed_at: '',
  }))
  assert.throws(() => assertRuntimeCache({ ...cache, loop: { ...cache.loop, iteration: -1 } }))
  assert.throws(() => assertRuntimeCache({ ...cache, reviews: null }))
  assert.deepEqual(parseModelOutput('{"status":"completed","content":"done"}'), {
    status: 'completed',
    content: 'done',
  })
  const envelopeOutput = parseModelOutput(JSON.stringify({
    status: 'completed',
    content: 'done',
    envelope: {
      envelopeVersion: 1,
      sessionId: 'session-1',
      runId: 'run-1',
      requestId: 'request-1',
      decision: 'finish',
      actions: [],
      candidateDiffs: [],
      evidenceRequests: [],
      uncertainties: [],
      completionCheck: { requiredEvidenceRefs: [], unresolvedUncertainties: [], verified: true },
    },
  }))
  assert.equal(envelopeOutput.envelope?.decision, 'finish')
  const waitOutput = parseModelOutput(JSON.stringify({
    status: 'running', content: '等待外部信号', envelope: {
      envelopeVersion: 1, sessionId: 'session-1', runId: 'run-1', requestId: 'request-1',
      decision: 'wait', actions: [], candidateDiffs: [], evidenceRequests: [], uncertainties: [],
      waitSpec: { reason: '等待工具回调', signalType: 'external', resumeCondition: '收到回调' },
    },
  }))
  assert.equal(waitOutput.envelope?.waitSpec?.signalType, 'external')
  assert.throws(() => parseModelOutput(JSON.stringify({
    status: 'running', content: '调用工具', envelope: {
      envelopeVersion: 1, sessionId: 'session-1', runId: 'run-1', requestId: 'request-1',
      decision: 'tool_call', actions: [], candidateDiffs: [], evidenceRequests: [], uncertainties: [],
    },
  })), /tool_call requires a tool_call action/)
  assert.throws(() => parseModelOutput(JSON.stringify({
    status: 'running', content: '等待', envelope: {
      envelopeVersion: 1, sessionId: 'session-1', runId: 'run-1', requestId: 'request-1',
      decision: 'wait', actions: [], candidateDiffs: [], evidenceRequests: [], uncertainties: [],
    },
  })))
  assert.throws(() => parseModelOutput(JSON.stringify({
    status: 'running', content: '请澄清', envelope: {
      envelopeVersion: 1, sessionId: 'session-1', runId: 'run-1', requestId: 'request-1',
      decision: 'ask_user', actions: [], candidateDiffs: [], evidenceRequests: [], uncertainties: [],
    },
  })))
  assert.throws(() => parseModelOutput(JSON.stringify({
    status: 'completed', content: 'done', envelope: {
      envelopeVersion: 1, sessionId: 'session-1', runId: 'run-1', requestId: 'request-1',
      decision: 'finish', actions: [], candidateDiffs: [{ baseRevision: 0, projectionId: 'p', projectionHash: '0', candidateId: 'c', operation: 'add_entry', evidenceRefs: [], idempotencyKey: 'i' }], evidenceRequests: [], uncertainties: [],
    },
  })))
  assert.throws(() => parseModelOutput(JSON.stringify({
    status: 'running', content: 'update', envelope: {
      envelopeVersion: 1, sessionId: 'session-1', runId: 'run-1', requestId: 'request-1',
      decision: 'propose_diff', actions: [], candidateDiffs: [{
        baseRevision: 0, projectionId: 'p', projectionHash: '0'.repeat(64), candidateId: 'c',
        operation: 'replace_body', evidenceRefs: ['e'], idempotencyKey: 'i',
      }], evidenceRequests: [], uncertainties: [],
    },
  })), /runtime envelope candidate diff is invalid/)
  assert.throws(() => parseModelOutput(JSON.stringify({
    status: 'running', content: 'update', envelope: {
      envelopeVersion: 1, sessionId: 'session-1', runId: 'run-1', requestId: 'request-1',
      decision: 'propose_diff', actions: [], candidateDiffs: [{
        baseRevision: 0, projectionId: 'p', projectionHash: '0'.repeat(64), candidateId: 'c',
        operation: 'append_evidence', evidenceRefs: [''], targetEntryId: 'entry', idempotencyKey: 'i',
      }], evidenceRequests: [], uncertainties: [],
    },
  })), /runtime envelope candidate diff is invalid/)
  assert.throws(() => parseModelOutput(JSON.stringify({
    status: 'completed', content: 'done', envelope: {
      envelopeVersion: 1, sessionId: 'session-1', runId: 'run-1', requestId: 'request-1',
      decision: 'finish', actions: [], candidateDiffs: [], evidenceRequests: [], uncertainties: [],
      completionCheck: { requiredEvidenceRefs: [], unresolvedUncertainties: [], verified: false },
    },
  })))
  assert.throws(() => parseModelOutput(JSON.stringify({
    status: 'completed', content: 'done', envelope: {
      envelopeVersion: 1, sessionId: 'session-1', runId: 'run-1', requestId: 'request-1',
      decision: 'finish', actions: [], candidateDiffs: [], evidenceRequests: [], uncertainties: [],
      completionCheck: { requiredEvidenceRefs: [], requiredActions: [''], unresolvedUncertainties: [], verified: true },
    },
  })), /requiredActions is invalid/)
  assert.throws(() => parseModelOutput(JSON.stringify({
    status: 'running', content: '等待证据', envelope: {
      envelopeVersion: 1, sessionId: 'session-1', runId: 'run-1', requestId: 'request-1',
      decision: 'reflect', actions: [{ kind: 'request_evidence', requestId: 'missing' }], candidateDiffs: [],
      evidenceRequests: [{ id: 'known', question: '补充来源', sourceKinds: ['tool'] }], uncertainties: [],
    },
  })), /request_evidence must reference an evidence request/)
  assert.throws(() => parseModelOutput(JSON.stringify({
    status: 'completed', content: 'done', envelope: {
      envelopeVersion: 1, sessionId: ' ', runId: 'run-1', requestId: 'request-1',
      decision: 'finish', actions: [], candidateDiffs: [], evidenceRequests: [], uncertainties: [],
      completionCheck: { requiredEvidenceRefs: [], unresolvedUncertainties: ['unknown'], verified: true },
    },
  })), /sessionId must be non-empty/)
  assert.throws(() => parseModelOutput(JSON.stringify({
    status: 'completed', content: 'done', envelope: {
      envelopeVersion: 1, sessionId: 'session-1', runId: 'run-1', requestId: 'request-1',
      decision: 'finish', actions: [], candidateDiffs: [], evidenceRequests: [],
      uncertainties: [{ id: 'same', statement: '冲突', relatedCandidateIds: [], blocking: false }, { id: 'same', statement: '重复', relatedCandidateIds: [], blocking: false }],
      completionCheck: { requiredEvidenceRefs: [], unresolvedUncertainties: [], verified: true },
    },
  })), /uncertainty ids must be unique/)
  assert.throws(() => parseModelOutput('{"status":"completed","content":""}'))
})

test('runtime utility only emits completed streamed content and detects divergence', () => {
  const deltas: string[] = []
  const stream = new ModelOutputStream((delta) => deltas.push(delta))
  stream.push('{"status":"completed","content":"hel')
  assert.deepEqual(deltas, ['hel'])
  stream.push('lo"}')
  assert.deepEqual(deltas, ['hel', 'lo'])
  stream.finish({ status: 'completed', content: 'hello' })

  const divergent = new ModelOutputStream(() => undefined)
  divergent.push('{"status":"completed","content":"hello"}')
  assert.throws(() => divergent.finish({ status: 'completed', content: 'goodbye' }))
})
