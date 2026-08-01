import fs from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import type WebSocket from 'ws'

import { AgentSession } from '#core/agent-session'
import {
  applyCompressionPatch,
  createCompressionPlan,
  estimateTokens,
  runCompression,
} from '#core/compression/compression-engine'
import { CompressionResourceStore } from '#core/compression/compression-resource'
import { DatasetStore } from '#core/datasets/dataset-store'
import { ExperimentManager, type CreateExperimentInput } from '#core/experiments/experiment-manager'
import type { ExperimentCaseStatus, ExperimentStatus } from '#core/experiments/types'
import { ProjectGitService } from '#core/project-git'
import { ProjectResources } from '#core/project-resources'
import {
  ProjectResourceRegistry,
  ResourceRevisionConflict,
} from '#core/resources/resource-registry'
import {
  RuntimeLoop,
  type RuntimeLoopOptions,
  type RuntimeLoopState,
} from '#core/runtime-loop'
import { SessionStore } from '#core/session-store'
import { UserPreferencesStore } from '#core/user-preferences'
import { WebSocketChannel } from '#transport/websocket-channel'
import { loadLlmConfig } from '#util/llm/config'
import { createLlmService, type LlmMessage } from '#util/llm'

export interface BuildAppOptions {
  runtimeLoop?: RuntimeLoopOptions
  logger?: boolean
  userConfigDir?: string
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false })
  const defaultProjectDir = path.resolve(
    options.runtimeLoop?.projectDir ?? process.env.CAPYBARA_PROJECT_DIR ?? 'test-project',
  )
  const stores = new Map<string, SessionStore>()
  const experimentManagers = new Map<string, ExperimentManager>()
  const activeSessions = new Map<string, AgentSession>()
  const userPreferences = new UserPreferencesStore(options.userConfigDir)

  const projectInfo = (input: unknown) => {
    const projectDir = path.resolve(typeof input === 'string' && input.trim()
      ? input
      : defaultProjectDir)
    if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
      throw new Error(`project directory was not found: ${projectDir}`)
    }
    const settings = new ProjectResources(projectDir).readSettings()
    const template = path.join(projectDir, settings.main_template)
    if (!fs.existsSync(template) || !fs.statSync(template).isFile()) {
      throw new Error(`project main template was not found: ${template}`)
    }
    return { path: projectDir, name: path.basename(projectDir) }
  }
  const requestProject = (request: { query: unknown }) => {
    const query = request.query as { projectPath?: unknown }
    return projectInfo(query.projectPath)
  }
  const projectKey = (projectDir: string) => path.normalize(projectDir).toLowerCase()
  const sessionKey = (projectDir: string, sessionId: string) =>
    `${projectKey(projectDir)}:${sessionId}`
  const getStore = (projectDir: string) => {
    const key = projectKey(projectDir)
    let store = stores.get(key)
    if (!store) {
      store = new SessionStore(projectDir)
      stores.set(key, store)
    }
    return store
  }
  const getExperimentManager = (projectDir: string) => {
    const key = projectKey(projectDir)
    let manager = experimentManagers.get(key)
    if (!manager) {
      manager = new ExperimentManager(projectDir, {
        ...(options.runtimeLoop?.llm ? { llm: options.runtimeLoop.llm } : {}),
        runtimeLoop: {
          ...(options.runtimeLoop?.streamDelayMs === undefined ? {} : { streamDelayMs: options.runtimeLoop.streamDelayMs }),
          ...(options.runtimeLoop?.stepDelayMs === undefined ? {} : { stepDelayMs: options.runtimeLoop.stepDelayMs }),
        },
      })
      experimentManagers.set(key, manager)
    }
    return manager
  }
  const publicProjectSettings = (resources: ProjectResources) => {
    const settings = resources.readSettings()
    const { api_key: apiKey, ...llm } = settings.llm
    return {
      ...settings,
      llm: {
        ...llm,
        api_key: '',
        api_key_configured: Boolean(apiKey ?? loadLlmConfig().apiKey),
      },
    }
  }

  await app.register(websocket)

  app.get('/hello', async () => {
    return { message: 'hello' }
  })

  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/')) {
      reply.header('access-control-allow-origin', '*')
      reply.header('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS')
      reply.header('access-control-allow-headers', 'content-type')
    }
    return payload
  })
  app.options('/api/*', async (_request, reply) => reply.code(204).send())

  app.get('/api/preferences', async () => userPreferences.read())
  app.put('/api/preferences', async (request, reply) => {
    try {
      return userPreferences.save(request.body)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.get('/api/projects/default', async () => projectInfo(defaultProjectDir))
  app.post('/api/projects/inspect', async (request, reply) => {
    try {
      return projectInfo((request.body as { path?: unknown } | undefined)?.path)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.post('/api/projects/release', async (request, reply) => {
    try {
      const project = projectInfo((request.body as { path?: unknown } | undefined)?.path)
      const prefix = `${projectKey(project.path)}:`
      for (const [key, session] of [...activeSessions]) {
        if (key.startsWith(prefix)) session.shutdown(true)
      }
      const key = projectKey(project.path)
      stores.get(key)?.close()
      stores.delete(key)
      await experimentManagers.get(key)?.close()
      experimentManagers.delete(key)
      return { released: true }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/api/resources/git/status', async (request, reply) => {
    try {
      return await new ProjectGitService(requestProject(request).path).status()
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/api/resources/git/history', async (request, reply) => {
    try {
      const limit = Number((request.query as { limit?: unknown }).limit ?? 50)
      return { items: await new ProjectGitService(requestProject(request).path).history(limit) }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/api/resources/git/diff', async (request, reply) => {
    try {
      const file = (request.query as { path?: unknown }).path
      if (typeof file !== 'string') throw new Error('path query parameter is required')
      return await new ProjectGitService(requestProject(request).path).diff(file)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.post('/api/resources/git/initialize', async (request, reply) => {
    try {
      return await new ProjectGitService(requestProject(request).path).initialize()
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.post('/api/resources/git/commit', async (request, reply) => {
    try {
      return await new ProjectGitService(requestProject(request).path).commit(
        (request.body ?? {}) as { message?: unknown; paths?: unknown },
      )
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/api/sessions', async (request, reply) => {
    try {
      const project = requestProject(request)
      return { project, items: getStore(project.path).list() }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.post('/api/sessions', async (request, reply) => {
    try {
      const body = request.body as { projectPath?: unknown; name?: unknown } | undefined
      const project = projectInfo(body?.projectPath)
      const name = body?.name
      if (name !== undefined && typeof name !== 'string') throw new Error('session name must be a string')
      return getStore(project.path).create(name)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/api/sessions/storage', async (request, reply) => {
    try {
      const project = requestProject(request)
      return getStore(project.path).stats()
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.delete('/api/sessions', async (request, reply) => {
    try {
      const project = requestProject(request)
      const prefix = `${projectKey(project.path)}:`
      for (const [key, session] of [...activeSessions]) {
        if (key.startsWith(prefix)) session.shutdown(false)
      }
      const store = getStore(project.path)
      store.clear()
      return store.stats()
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.get('/api/datasets', async (request, reply) => {
    try {
      return { items: new DatasetStore(requestProject(request).path).list() }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.post('/api/datasets', async (request, reply) => {
    try {
      const dataset = new DatasetStore(requestProject(request).path).create(
        (request.body ?? {}) as { name?: unknown; storage?: unknown; path?: unknown; tags?: unknown; scoringPrompt?: unknown },
      )
      return reply.code(201).send(dataset)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.post('/api/datasets/import', async (request, reply) => {
    try {
      const dataset = new DatasetStore(requestProject(request).path).import(
        (request.body ?? {}) as { path?: unknown },
      )
      return reply.code(201).send(dataset)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/api/datasets/:id', async (request, reply) => {
    try {
      return new DatasetStore(requestProject(request).path).get((request.params as { id: string }).id)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.put('/api/datasets/:id', async (request, reply) => {
    try {
      return new DatasetStore(requestProject(request).path).update(
        (request.params as { id: string }).id,
        (request.body ?? {}) as { name?: unknown; tags?: unknown; scoringPrompt?: unknown },
      )
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.delete('/api/datasets/:id', async (request, reply) => {
    try {
      return new DatasetStore(requestProject(request).path).delete((request.params as { id: string }).id)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/api/datasets/:id/records', async (request, reply) => {
    try {
      const query = request.query as {
        projectPath?: unknown
        query?: unknown
        offset?: unknown
        limit?: unknown
      }
      return new DatasetStore(requestProject(request).path).listRecords(
        (request.params as { id: string }).id,
        {
          query: typeof query.query === 'string' ? query.query : undefined,
          offset: typeof query.offset === 'string' ? Number(query.offset) : undefined,
          limit: typeof query.limit === 'string' ? Number(query.limit) : undefined,
        },
      )
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.post('/api/datasets/:id/records', async (request, reply) => {
    try {
      const record = new DatasetStore(requestProject(request).path).createRecord(
        (request.params as { id: string }).id,
        (request.body ?? {}) as Parameters<DatasetStore['createRecord']>[1],
      )
      return reply.code(201).send(record)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.put('/api/datasets/:id/records/:recordId', async (request, reply) => {
    try {
      const params = request.params as { id: string; recordId: string }
      return new DatasetStore(requestProject(request).path).updateRecord(
        params.id,
        params.recordId,
        (request.body ?? {}) as Parameters<DatasetStore['updateRecord']>[2],
      )
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.delete('/api/datasets/:id/records/:recordId', async (request, reply) => {
    try {
      const params = request.params as { id: string; recordId: string }
      new DatasetStore(requestProject(request).path).deleteRecord(params.id, params.recordId)
      return { deleted: true, id: params.recordId }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.get('/api/experiments', async (request, reply) => {
    try {
      const project = requestProject(request)
      const query = request.query as { datasetId?: unknown; status?: unknown; limit?: unknown }
      const status = typeof query.status === 'string' ? query.status : undefined
      const validStatuses: ExperimentStatus[] = ['queued', 'running', 'completed', 'failed', 'cancelled']
      if (status && !validStatuses.includes(status as ExperimentStatus)) throw new Error('invalid experiment status')
      return {
        project,
        items: getExperimentManager(project.path).list({
          ...(typeof query.datasetId === 'string' && query.datasetId ? { datasetId: query.datasetId } : {}),
          ...(status ? { status: status as ExperimentStatus } : {}),
          ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
        }),
      }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.post('/api/experiments', async (request, reply) => {
    try {
      const project = requestProject(request)
      const run = await getExperimentManager(project.path).create((request.body ?? {}) as CreateExperimentInput)
      return reply.code(202).send(run)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/api/experiments/storage', async (request, reply) => {
    try {
      const manager = getExperimentManager(requestProject(request).path)
      return { ...manager.store.stats(), ...manager.capabilities() }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/api/experiments/trends', async (request, reply) => {
    try {
      const datasetId = (request.query as { datasetId?: unknown }).datasetId
      if (typeof datasetId !== 'string') throw new Error('datasetId query parameter is required')
      return getExperimentManager(requestProject(request).path).trends(datasetId)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/api/experiments/compare', async (request, reply) => {
    try {
      const query = request.query as { datasetId?: unknown; leftId?: unknown; rightId?: unknown }
      if (typeof query.datasetId !== 'string' || typeof query.leftId !== 'string' || typeof query.rightId !== 'string') {
        throw new Error('datasetId, leftId, and rightId query parameters are required')
      }
      return getExperimentManager(requestProject(request).path).compare(query.datasetId, query.leftId, query.rightId)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/api/experiments/:id', async (request, reply) => {
    try {
      return getExperimentManager(requestProject(request).path).get((request.params as { id: string }).id)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.delete('/api/experiments/:id', async (request, reply) => {
    try {
      getExperimentManager(requestProject(request).path).delete((request.params as { id: string }).id)
      return reply.code(204).send()
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.post('/api/experiments/:id/cancel', async (request, reply) => {
    try {
      const run = getExperimentManager(requestProject(request).path).cancel((request.params as { id: string }).id)
      return reply.code(202).send(run)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/api/experiments/:id/cases', async (request, reply) => {
    try {
      const query = request.query as { status?: unknown; offset?: unknown; limit?: unknown }
      const status = typeof query.status === 'string' ? query.status : undefined
      const validStatuses: ExperimentCaseStatus[] = ['queued', 'running', 'passed', 'failed', 'error', 'cancelled']
      if (status && !validStatuses.includes(status as ExperimentCaseStatus)) throw new Error('invalid experiment case status')
      return getExperimentManager(requestProject(request).path).cases(
        (request.params as { id: string }).id,
        {
          ...(status ? { status: status as ExperimentCaseStatus } : {}),
          ...(query.offset === undefined ? {} : { offset: Number(query.offset) }),
          ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
        },
      )
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/api/experiments/:id/tools', async (request, reply) => {
    try {
      return { items: getExperimentManager(requestProject(request).path).tools((request.params as { id: string }).id) }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/api/experiments/:id/cases/:caseId', async (request, reply) => {
    try {
      const params = request.params as { id: string; caseId: string }
      return getExperimentManager(requestProject(request).path).case(params.id, params.caseId)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.get('/api/resources/system-variables', async (request) =>
    new ProjectResources(requestProject(request).path).readSystemVariables())
  app.put('/api/resources/system-variables', async (request, reply) => {
    try {
      return new ProjectResources(requestProject(request).path).saveSystemVariables(request.body)
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
  app.get('/api/resources/project-settings', async (request) =>
    publicProjectSettings(new ProjectResources(requestProject(request).path)))
  app.put('/api/resources/project-settings', async (request, reply) => {
    try {
      const resources = new ProjectResources(requestProject(request).path)
      resources.saveSettings(request.body)
      return publicProjectSettings(resources)
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
  app.get('/api/resources/compression', async (request, reply) => {
    try {
      const project = requestProject(request)
      const settings = new ProjectResources(project.path).readSettings()
      return new CompressionResourceStore(
        project.path,
        settings.context.compression.resource,
      ).read()
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.put('/api/resources/compression', async (request, reply) => {
    try {
      const project = requestProject(request)
      const settings = new ProjectResources(project.path).readSettings()
      return new CompressionResourceStore(
        project.path,
        settings.context.compression.resource,
      ).save(request.body)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.post('/api/resources/compression/test', async (request, reply) => {
    try {
      const project = requestProject(request)
      const settings = new ProjectResources(project.path).readSettings()
      const body = request.body as { messages?: unknown } | undefined
      if (!Array.isArray(body?.messages) || body.messages.length === 0) {
        throw new Error('compression test requires a non-empty messages array')
      }
      const messages = body.messages as LlmMessage[]
      const store = new CompressionResourceStore(
        project.path,
        settings.context.compression.resource,
      )
      const resource = store.read()
      const availableTokens = settings.context.max_input_tokens - settings.context.reserved_output_tokens
      const plan = createCompressionPlan(
        messages,
        resource,
        1,
        availableTokens,
        [],
        true,
      )
      if (!plan) throw new Error('test messages do not contain a completed compressible turn')
      const llm = options.runtimeLoop?.llm ?? createLlmService({
        model: settings.llm.model,
        baseUrl: settings.llm.base_url,
        protocol: settings.llm.protocol,
        apiKey: settings.llm.api_key,
      })
      const result = await runCompression(llm, store, resource, plan)
      const afterMessages = applyCompressionPatch(messages, result.plan, result.patch)
      return {
        resourceRevision: resource.revision,
        beforeTokens: result.plan.beforeTokens,
        targetTokens: result.plan.targetTokens,
        afterTokens: estimateTokens(afterMessages),
        sourceUnits: result.plan.units,
        renderedPrompt: result.renderedPrompt,
        responseText: result.responseText,
        patch: result.patch,
        afterMessages,
        usage: result.usage ?? null,
      }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/api/resources/catalog', async (request) =>
    new ProjectResourceRegistry(requestProject(request).path).list())
  app.get('/api/resources/file', async (request, reply) => {
    try {
      const file = (request.query as { path?: unknown }).path
      if (typeof file !== 'string' || !file) throw new Error('path query parameter is required')
      return new ProjectResourceRegistry(requestProject(request).path).readFile(file)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.post('/api/resources/tools/:id/test', async (request, reply) => {
    try {
      const body = request.body as { arguments?: unknown } | undefined
      return await new ProjectResourceRegistry(requestProject(request).path).testTool(
        (request.params as { id: string }).id,
        body?.arguments ?? {},
      )
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.post('/api/resources/skills/:id/test', async (request, reply) => {
    try {
      const body = request.body as { context?: unknown } | undefined
      return new ProjectResourceRegistry(requestProject(request).path).testSkill(
        (request.params as { id: string }).id,
        body?.context ?? {},
      )
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.put('/api/resources/skills/:id', async (request, reply) => {
    try {
      return new ProjectResourceRegistry(requestProject(request).path)
        .saveSkill((request.params as { id: string }).id, request.body)
    } catch (error) {
      return reply.code(error instanceof ResourceRevisionConflict ? 409 : 400).send({
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
  app.post('/api/resources/harnesses/:id/test', async (request, reply) => {
    try {
      const body = request.body as { context?: unknown } | undefined
      return new ProjectResourceRegistry(requestProject(request).path).testHarness(
        (request.params as { id: string }).id,
        body?.context ?? {},
      )
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.put('/api/resources/harnesses/:id', async (request, reply) => {
    try {
      return new ProjectResourceRegistry(requestProject(request).path)
        .saveHarness((request.params as { id: string }).id, request.body)
    } catch (error) {
      return reply.code(error instanceof ResourceRevisionConflict ? 409 : 400).send({
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  const attachRuntime = (socket: WebSocket, request: { query: unknown }) => {
    try {
      const query = request.query as { projectPath?: unknown; sessionId?: unknown }
      const project = projectInfo(query.projectPath)
      const store = getStore(project.path)
      const requestedId = typeof query.sessionId === 'string' ? query.sessionId : undefined
      const stored = requestedId ? store.get(requestedId) : undefined
      if (requestedId && !stored) throw new Error(`session was not found: ${requestedId}`)
      const session = stored?.session ?? store.create()
      const loop = new RuntimeLoop({
        ...options.runtimeLoop,
        projectDir: project.path,
        workspaceDir: project.path,
        ...(stored?.state ? { initialState: stored.state as RuntimeLoopState } : {}),
      })
      const key = sessionKey(project.path, session.id)
      activeSessions.get(key)?.shutdown(true, 4001, 'session attached in another client')

      let persistTimer: NodeJS.Timeout | undefined
      const save = () => store.save(session.id, loop.exportState(), loop.getRequestCount())
      const scheduleSave = () => {
        if (persistTimer) clearTimeout(persistTimer)
        persistTimer = setTimeout(() => {
          persistTimer = undefined
          save()
        }, 100)
      }
      const channel = new WebSocketChannel(socket, session.id)
      const agentSession = new AgentSession(session.id, loop, channel, {
        project,
        session: { id: session.id, name: session.name },
        resumeMode: stored?.state ? 'snapshot' : 'new',
        onChange: scheduleSave,
        onClose: (persist) => {
          if (persistTimer) clearTimeout(persistTimer)
          persistTimer = undefined
          if (persist) save()
          if (activeSessions.get(key) === agentSession) activeSessions.delete(key)
        },
      })
      activeSessions.set(key, agentSession)
      scheduleSave()
    } catch (error) {
      socket.close(1008, error instanceof Error ? error.message : String(error))
    }
  }

  app.get('/ws/runtime', { websocket: true }, attachRuntime)
  app.get('/ws', { websocket: true }, attachRuntime)

  app.addHook('onClose', async () => {
    for (const session of [...activeSessions.values()]) session.shutdown(true)
    for (const store of stores.values()) store.close()
    await Promise.all([...experimentManagers.values()].map((manager) => manager.close()))
  })

  return app
}
