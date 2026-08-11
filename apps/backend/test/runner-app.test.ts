import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { buildRunnerApp } from '../src/runner-app.ts'
import type { ServerEvent } from '#protocol/runtime-protocol'
import type { LlmChatResponse } from '#util/llm'

const TOKEN = 'runner-test-token'

function testLlm() {
  return {
    async chat(): Promise<LlmChatResponse> {
      return {
        provider: 'custom',
        model: 'test-model',
        text: JSON.stringify({ status: 'completed', content: 'test response' }),
        finishReason: 'stop',
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

function copyProject(): { projectDir: string; dataDir: string; close: () => void } {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-runner-project-'))
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-runner-data-'))
  const sourceProject = path.resolve(process.env.CAPYBARA_TEST_PROJECT_DIR ?? 'test-project')
  fs.cpSync(sourceProject, projectDir, {
    filter: (source) => {
      const relative = path.relative(sourceProject, source).replaceAll('\\', '/')
      return relative !== '.capybara/secrets.json'
        && !relative.startsWith('.capybara/sessions.sqlite')
        && !relative.startsWith('.capybara/runtime')
    },
    recursive: true,
  })
  return {
    projectDir,
    dataDir,
    close: () => {
      fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    },
  }
}

test('Runner exposes only authenticated runtime APIs and isolates session data', async () => {
  const fixture = copyProject()
  const app = await buildRunnerApp({
    projectDir: fixture.projectDir,
    dataDir: fixture.dataDir,
    token: TOKEN,
    allowedOrigins: ['http://localhost:3000'],
    runtimeLoop: { llm: testLlm(), streamDelayMs: 0, stepDelayMs: 0 },
  })
  try {
    const root = await app.inject({ method: 'GET', url: '/' })
    assert.equal(root.statusCode, 200)
    assert.equal(root.json().service, 'Capybara Runner')

    const health = await app.inject({ method: 'GET', url: '/v1/health' })
    assert.equal(health.statusCode, 200)
    assert.equal(health.json().status, 'healthy')

    const unauthorized = await app.inject({ method: 'GET', url: '/v1/agent' })
    assert.equal(unauthorized.statusCode, 401)

    const headers = { authorization: `Bearer ${TOKEN}` }
    const agent = await app.inject({ method: 'GET', url: '/v1/agent', headers })
    assert.equal(agent.statusCode, 200)
    assert.equal(agent.json().name, path.basename(fixture.projectDir))
    assert.deepEqual(agent.json().capabilities, [
      'sessions',
      'streaming',
      'tools',
      'hooks',
      'skills',
      'harnesses',
    ])

    const platformApi = await app.inject({ method: 'GET', url: '/api/preferences', headers })
    assert.equal(platformApi.statusCode, 404)

    const rejectedOrigin = await app.inject({
      method: 'GET',
      url: '/v1/agent',
      headers: { ...headers, origin: 'https://untrusted.example' },
    })
    assert.equal(rejectedOrigin.statusCode, 403)

    const allowedOrigin = await app.inject({
      method: 'GET',
      url: '/v1/agent',
      headers: { ...headers, origin: 'http://localhost:3000' },
    })
    assert.equal(allowedOrigin.statusCode, 200)
    assert.equal(allowedOrigin.headers['access-control-allow-origin'], 'http://localhost:3000')

    const created = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: { name: 'Local SDK session' },
    })
    assert.equal(created.statusCode, 201)
    assert.equal(created.json().name, 'Local SDK session')

    const listed = await app.inject({ method: 'GET', url: '/v1/sessions', headers })
    assert.equal(listed.statusCode, 200)
    assert.equal(listed.json().items.length, 1)
    assert.equal(listed.json().items[0].id, created.json().id)
    assert.equal(fs.existsSync(path.join(fixture.dataDir, 'sessions.sqlite')), true)
    assert.equal(fs.existsSync(path.join(fixture.projectDir, '.capybara', 'sessions.sqlite')), false)
  } finally {
    await app.close()
    fixture.close()
  }
})

test('Runner attaches and restores a session through its WebSocket endpoint', async () => {
  const fixture = copyProject()
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
    const created = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    const sessionId = created.json().id as string
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/v1/sessions/${sessionId}/events?access_token=${TOKEN}`,
    )
    const events: ServerEvent[] = []
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timed out waiting for Runner snapshot')), 4_000)
        socket.addEventListener('error', () => reject(new Error('Runner WebSocket failed')), { once: true })
        socket.addEventListener('message', (event) => {
          events.push(JSON.parse(String(event.data)) as ServerEvent)
          if (events.some((item) => item.type === 'runtime.snapshot')) {
            clearTimeout(timeout)
            resolve()
          }
        })
      })
      assert.deepEqual(events.slice(0, 2).map((event) => event.type), [
        'session.attached',
        'runtime.snapshot',
      ])
      const attached = events[0]
      assert.equal(attached?.sessionId, sessionId)
      assert.equal(attached?.type === 'session.attached' && attached.payload.resumeMode, 'new')
    } finally {
      socket.close()
      await new Promise((resolve) => setTimeout(resolve, 150))
    }

    const restoredSocket = new WebSocket(
      `ws://127.0.0.1:${address.port}/v1/sessions/${sessionId}/events?access_token=${TOKEN}`,
    )
    try {
      const attached = await new Promise<ServerEvent>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timed out waiting for restored session')), 4_000)
        restoredSocket.addEventListener('error', () => reject(new Error('Runner restore failed')), { once: true })
        restoredSocket.addEventListener('message', (event) => {
          const value = JSON.parse(String(event.data)) as ServerEvent
          if (value.type === 'session.attached') {
            clearTimeout(timeout)
            resolve(value)
          }
        })
      })
      assert.equal(attached.type === 'session.attached' && attached.payload.resumeMode, 'snapshot')
    } finally {
      restoredSocket.close()
    }
  } finally {
    await app.close()
    fixture.close()
  }
})
