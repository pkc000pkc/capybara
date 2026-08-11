import { timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import type WebSocket from 'ws'

import { AgentSession } from '#core/agent-session'
import { ProjectResources } from '#core/project-resources'
import {
  RuntimeLoop,
  type RuntimeLoopOptions,
  type RuntimeLoopState,
} from '#core/runtime-loop'
import { SessionStore } from '#core/session-store'
import { WebSocketChannel } from '#transport/websocket-channel'

export const RUNNER_PROTOCOL_VERSION = 1

export interface BuildRunnerAppOptions {
  projectDir: string
  workspaceDir?: string
  dataDir?: string
  token: string
  allowedOrigins?: string[]
  logger?: boolean
  runtimeLoop?: Omit<RuntimeLoopOptions, 'projectDir' | 'workspaceDir' | 'initialState'>
}

export interface RunnerInfo {
  name: string
  protocolVersion: number
  capabilities: string[]
}

function bearerToken(value: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(value ?? '')
  return match?.[1]
}

function equalToken(actual: string | undefined, expected: string): boolean {
  if (!actual) return false
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

function requestToken(request: { headers: { authorization?: string }; query?: unknown }): string | undefined {
  const authorization = bearerToken(request.headers.authorization)
  if (authorization) return authorization
  const query = request.query
  if (!query || typeof query !== 'object') return
  const value = (query as { access_token?: unknown }).access_token
  return typeof value === 'string' ? value : undefined
}

function existingDirectory(input: string, label: string): string {
  const resolved = path.resolve(input)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`${label} directory was not found: ${resolved}`)
  }
  return resolved
}

function projectName(projectDir: string): string {
  return path.basename(projectDir)
}

export async function buildRunnerApp(options: BuildRunnerAppOptions): Promise<FastifyInstance> {
  if (!options.token.trim()) throw new Error('runner token must not be empty')

  const projectDir = existingDirectory(options.projectDir, 'project')
  const workspaceDir = existingDirectory(options.workspaceDir ?? projectDir, 'workspace')
  const resources = new ProjectResources(projectDir)
  const settings = resources.readSettings()
  resources.close()
  const mainTemplate = path.resolve(projectDir, settings.main_template)
  if (!fs.existsSync(mainTemplate) || !fs.statSync(mainTemplate).isFile()) {
    throw new Error(`project main template was not found: ${mainTemplate}`)
  }

  const dataDir = path.resolve(options.dataDir ?? path.join(projectDir, '.capybara', 'runtime'))
  const store = new SessionStore(projectDir, { directory: dataDir })
  const activeSessions = new Map<string, AgentSession>()
  const allowedOrigins = new Set(options.allowedOrigins ?? [])
  const startedAt = Date.now()
  const info: RunnerInfo = {
    name: projectName(projectDir),
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    capabilities: ['sessions', 'streaming', 'tools', 'hooks', 'skills', 'harnesses'],
  }
  const app = Fastify({ logger: options.logger ?? false })
  await app.register(websocket)

  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin
    if (origin && !allowedOrigins.has(origin)) {
      return reply.code(403).send({ error: `origin is not allowed: ${origin}` })
    }
    if (request.method === 'OPTIONS' || request.url === '/' || request.url === '/v1/health') return
    if (!equalToken(requestToken(request), options.token)) {
      return reply.code(401).send({ error: 'invalid or missing runner token' })
    }
  })

  app.addHook('onSend', async (request, reply, payload) => {
    const origin = request.headers.origin
    if (origin && allowedOrigins.has(origin)) {
      reply.header('access-control-allow-origin', origin)
      reply.header('vary', 'origin')
      reply.header('access-control-allow-methods', 'GET,POST,PATCH,OPTIONS')
      reply.header('access-control-allow-headers', 'authorization,content-type')
    }
    return payload
  })

  app.options('/*', async (_request, reply) => reply.code(204).send())
  app.get('/', async () => ({ service: 'Capybara Runner', status: 'ready', ...info }))
  app.get('/v1/health', async () => ({
    status: 'healthy',
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1_000),
  }))
  app.get('/v1/agent', async () => info)
  app.get('/v1/sessions', async () => ({ items: store.list() }))
  app.post('/v1/sessions', async (request, reply) => {
    try {
      const body = request.body as { name?: unknown } | undefined
      const name = typeof body?.name === 'string' ? body.name : undefined
      return reply.code(201).send(store.create(name))
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/v1/sessions/:sessionId', async (request, reply) => {
    try {
      const { sessionId } = request.params as { sessionId: string }
      const stored = store.get(sessionId)
      if (!stored) return reply.code(404).send({ error: `session was not found: ${sessionId}` })
      return stored.session
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.patch('/v1/sessions/:sessionId', async (request, reply) => {
    try {
      const { sessionId } = request.params as { sessionId: string }
      const body = request.body as { name?: unknown } | undefined
      if (typeof body?.name !== 'string') throw new Error('session name is required')
      return store.rename(sessionId, body.name)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return reply.code(message.startsWith('session was not found:') ? 404 : 400).send({ error: message })
    }
  })

  app.get('/v1/sessions/:sessionId/events', { websocket: true }, (socket: WebSocket, request) => {
    if (!equalToken(requestToken(request), options.token)) {
      socket.close(1008, 'invalid or missing runner token')
      return
    }
    try {
      const { sessionId } = request.params as { sessionId: string }
      const stored = store.get(sessionId)
      if (!stored) throw new Error(`session was not found: ${sessionId}`)
      const loop = new RuntimeLoop({
        ...options.runtimeLoop,
        projectDir,
        workspaceDir,
        ...(stored.state ? { initialState: stored.state as RuntimeLoopState } : {}),
      })
      activeSessions.get(sessionId)?.shutdown(true, 4001, 'session attached in another client')

      let persistTimer: NodeJS.Timeout | undefined
      const save = () => store.save(sessionId, loop.exportState(), loop.getRequestCount())
      const scheduleSave = () => {
        if (persistTimer) clearTimeout(persistTimer)
        persistTimer = setTimeout(() => {
          persistTimer = undefined
          save()
        }, 100)
      }
      const channel = new WebSocketChannel(socket, sessionId)
      const session = new AgentSession(sessionId, loop, channel, {
        project: { path: projectDir, name: info.name },
        session: { id: sessionId, name: stored.session.name },
        resumeMode: stored.state ? 'snapshot' : 'new',
        onChange: scheduleSave,
        onClose: (persist) => {
          if (persistTimer) clearTimeout(persistTimer)
          persistTimer = undefined
          if (persist) save()
          if (activeSessions.get(sessionId) === session) activeSessions.delete(sessionId)
        },
      })
      activeSessions.set(sessionId, session)
      scheduleSave()
    } catch (error) {
      socket.close(1008, error instanceof Error ? error.message : String(error))
    }
  })

  app.addHook('onClose', async () => {
    for (const session of [...activeSessions.values()]) session.shutdown(true)
    store.close()
  })

  return app
}
