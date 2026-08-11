import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { buildRunnerApp } from '../../../apps/backend/src/runner-app.ts'
import type { LlmChatResponse } from '../../../apps/backend/src/util/llm/types.ts'
import {
  CapybaraClient,
  CapybaraCommandError,
  CapybaraHttpError,
} from '../src/index.ts'

const TOKEN = 'client-sdk-test-token'

function testLlm() {
  return {
    async chat(): Promise<LlmChatResponse> {
      return {
        provider: 'custom',
        model: 'test-model',
        text: JSON.stringify({ status: 'completed', content: 'SDK response' }),
        finishReason: 'stop',
        usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
        raw: {},
      }
    },
    getConfig: () => ({
      provider: 'custom' as const,
      protocol: 'responses' as const,
      model: 'test-model',
      baseUrl: 'http://127.0.0.1/unused',
      timeoutMs: 1_000,
      maxRetries: 0,
    }),
  }
}

function projectFixture() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-client-project-'))
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-client-data-'))
  const source = path.resolve(process.env.CAPYBARA_TEST_PROJECT_DIR ?? '../../examples/test-project')
  fs.cpSync(source, projectDir, {
    filter: (entry) => {
      const relative = path.relative(source, entry).replaceAll('\\', '/')
      return relative !== '.capybara/secrets.json'
        && !relative.startsWith('.capybara/sessions.sqlite')
        && !relative.startsWith('.capybara/runtime')
    },
    recursive: true,
  })
  return {
    projectDir,
    dataDir,
    close() {
      fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    },
  }
}

test('Client SDK creates, streams, rejects, and restores Runner sessions', async () => {
  const fixture = projectFixture()
  const app = await buildRunnerApp({
    projectDir: fixture.projectDir,
    dataDir: fixture.dataDir,
    token: TOKEN,
    runtimeLoop: { llm: testLlm(), streamDelayMs: 0, stepDelayMs: 0 },
  })
  try {
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const endpoint = `http://127.0.0.1:${address.port}`
    const client = new CapybaraClient({
      endpoint,
      token: TOKEN,
      reconnect: { enabled: false },
    })

    assert.equal((await client.health()).status, 'healthy')
    assert.equal((await client.agent()).protocolVersion, 1)

    const session = await client.createSession({ name: 'WebSocket SDK', connect: false })
    const [firstConnection, secondConnection] = await Promise.all([
      session.connect(),
      session.connect(),
    ])
    assert.equal(firstConnection, session)
    assert.equal(secondConnection, session)
    assert.equal(session.state.connection, 'open')
    assert.ok(session.snapshot)
    assert.equal(session.name, 'WebSocket SDK')

    const deltas: string[] = []
    const handlerErrors: Error[] = []
    const offError = session.onError((error) => handlerErrors.push(error))
    const offThrowingHandler = session.on('chat.user.created', () => {
      throw new Error('consumer render failed')
    })
    const offDelta = session.on('chat.assistant.delta', (event) => {
      if (event.payload.channel === 'final') deltas.push(event.payload.delta)
    })
    const completed = session.waitFor('chat.assistant.completed', () => true, { timeoutMs: 4_000 })
    const receipt = await session.sendMessage('Run through the TypeScript SDK')
    assert.match(receipt.commandId, /^command-/)
    assert.match(receipt.clientMessageId, /^message-/)
    const completion = await completed
    offDelta()
    offError()
    offThrowingHandler()
    assert.equal(completion.payload.finishReason, 'stop')
    assert.equal(deltas.join(''), 'SDK response')
    assert.equal(session.state.connection, 'open')
    assert.match(handlerErrors[0]?.message ?? '', /event handler failed/)

    const tool = session.snapshot?.tools.catalog[0]
    assert.ok(tool)
    await assert.rejects(
      () => session.send('runtime.tools.attach', {
        toolId: tool.id,
        baseRevision: (session.snapshot?.tools.revision ?? 0) + 100,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CapybaraCommandError)
        assert.equal(error.code, 'REVISION_CONFLICT')
        assert.equal(error.retryable, false)
        return true
      },
    )

    const sessionId = session.id
    session.disconnect()
    await new Promise((resolve) => setTimeout(resolve, 150))
    const restored = await client.connectSession(sessionId)
    assert.equal(restored.state.connection, 'open')
    assert.ok(restored.snapshot?.conversation.messages.some(
      (message) => message.id === receipt.clientMessageId,
    ))
    assert.equal((await client.listSessions())[0]?.name, 'WebSocket SDK')
    client.close()

    const unauthorized = new CapybaraClient({ endpoint, token: 'incorrect-token' })
    await assert.rejects(
      () => unauthorized.agent(),
      (error: unknown) => {
        assert.ok(error instanceof CapybaraHttpError)
        assert.equal(error.status, 401)
        return true
      },
    )
  } finally {
    await app.close()
    fixture.close()
  }
})
