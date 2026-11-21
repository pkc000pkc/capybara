import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { initializeProjectDirectory } from '#core/project-initializer'
import { RuntimeLoop, type RuntimeLlm } from '#core/runtime-loop'
import type { ClientCommand, ServerEvent } from '#protocol/runtime-protocol'

const llm: RuntimeLlm = {
  chat: async () => ({ provider: 'custom', model: 'test', text: '{"status":"completed","content":"ok"}', finishReason: 'stop', raw: {} }),
  getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }),
}

function command<TType extends ClientCommand['type']>(type: TType, payload: Extract<ClientCommand, { type: TType }>['payload']): ClientCommand {
  return { version: 1, kind: 'command', id: `training-${type}`, type, sessionId: 'training-session', timestamp: '2026-11-07T00:00:00.000Z', payload } as ClientCommand
}

test('RuntimeLoop export produces replayable context training input samples', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-context-training-runtime-'))
  initializeProjectDirectory(projectDir)
  const loop = new RuntimeLoop({ projectDir, llm, stepDelayMs: 0, streamDelayMs: 0 })
  try {
    const state = loop.exportState()
    assert.equal(state.contextTrainingSamples?.length, 1)
    const sample = state.contextTrainingSamples?.[0]
    assert.ok(sample)
    assert.equal(sample.scope, 'session')
    assert.equal(sample.projectId, projectDir)
    assert.equal(typeof sample.input.projectContext, 'string')
    assert.equal(sample.input.projectContextRevision, state.projectContextDocument?.revision)
    assert.equal(Array.isArray(sample.input.rawMessages), true)
    assert.equal(typeof sample.input.systemPrompt, 'string')
    assert.equal(Array.isArray(sample.input.cache), true)
    assert.equal(Array.isArray(sample.input.messages), true)
    assert.equal(sample.input.contextRevision, state.contextDocument?.revision)

    const restored = new RuntimeLoop({ projectDir, llm, stepDelayMs: 0, streamDelayMs: 0, initialState: state })
    try {
      assert.deepEqual(restored.exportState().contextTrainingSamples, state.contextTrainingSamples)
    } finally {
      restored.close()
    }
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('RuntimeLoop records a run-scoped training sample from an actual completed turn', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-context-training-run-'))
  initializeProjectDirectory(projectDir)
  const loop = new RuntimeLoop({ projectDir, llm, stepDelayMs: 0, streamDelayMs: 0 })
  try {
    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('training run timed out')), 5000)
      const unsubscribe = loop.onEvent((event) => {
        const runtimeEvent = event as ServerEvent
        if (runtimeEvent.type !== 'run.state.changed') return
        if (runtimeEvent.payload.status === 'failed') {
          clearTimeout(timer)
          unsubscribe()
          reject(new Error(runtimeEvent.payload.failure?.message ?? 'training run failed'))
        } else if (runtimeEvent.payload.status === 'completed') {
          clearTimeout(timer)
          unsubscribe()
          resolve()
        }
      })
    })
    const send = command('chat.message.send', {
      clientMessageId: 'training-run-message',
      content: [{ type: 'text', text: '记录本轮运行上下文' }],
      autoStart: true,
    })
    loop.validate(send)
    loop.execute(send, 1)
    await completed

    const state = loop.exportState()
    const sample = state.contextTrainingSamples?.find((item) => item.runId === state.snapshot.run.runId)
    assert.ok(sample)
    assert.equal(sample.scope, 'session')
    assert.equal(sample.projectId, projectDir)
    assert.equal(sample.sessionId, state.contextDocument?.sessionId)
    assert.equal(sample.input.projectContextRevision, state.projectContextDocument?.revision)
    assert.equal(Array.isArray(sample.input.rawMessages), true)
    assert.ok(sample.input.messages.some((message) => message.role === 'user'))
    assert.ok(sample.input.messages.some((message) => message.role === 'assistant'))
    assert.equal(sample.input.contextRevision, state.contextDocument?.revision)

    const restored = new RuntimeLoop({ projectDir, llm, stepDelayMs: 0, streamDelayMs: 0, initialState: state })
    try {
      assert.deepEqual(restored.getContextTrainingSamples(), state.contextTrainingSamples)
    } finally {
      restored.close()
    }
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})
