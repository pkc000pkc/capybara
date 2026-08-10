import fs from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import type WebSocket from 'ws'

import { AgentSession } from '#core/agent-session'
import { DatasetStore } from '#core/datasets/dataset-store'
import { ExperimentManager, type CreateExperimentInput } from '#core/experiments/experiment-manager'
import { experimentCaseForPresentation } from '#core/experiments/presentation'
import { TrainingManager } from '#core/experiments/training/training-manager'
import type { CreateSnapshotEvaluationInput, CreateTrainingInput, VariableDiff } from '#core/experiments/training/training-types'
import type { ExperimentCaseStatus, ExperimentStatus } from '#core/experiments/types'
import { ProjectGitService } from '#core/project-git'
import {
  MAX_PROJECT_TEXT_FILE_BYTES,
  ProjectFileRevisionConflict,
  ProjectFileService,
} from '#core/project-files'
import {
  initializeProjectDirectory,
  isInitializableProjectDirectory,
} from '#core/project-initializer'
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
import { createLlmService } from '#util/llm'

export interface BuildAppOptions {
  runtimeLoop?: RuntimeLoopOptions
  logger?: boolean
  userConfigDir?: string
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false })
  const exampleProjectDir = path.resolve(import.meta.dirname, '../../../examples/test-project')
  const defaultProjectDir = path.resolve(
    options.runtimeLoop?.projectDir ?? process.env.CAPYBARA_PROJECT_DIR ?? exampleProjectDir,
  )
  const stores = new Map<string, SessionStore>()
  const experimentManagers = new Map<string, ExperimentManager>()
  const trainingManagers = new Map<string, TrainingManager>()
  const activeSessions = new Map<string, AgentSession>()
  const releasedProjects = new Set<string>()
  const userPreferences = new UserPreferencesStore(options.userConfigDir)

  const projectDirectory = (input: unknown) => {
    const projectDir = path.resolve(typeof input === 'string' && input.trim()
      ? input
      : defaultProjectDir)
    if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
      throw new Error(`project directory was not found: ${projectDir}`)
    }
    return projectDir
  }
  const inspectProject = (input: unknown) => {
    const projectDir = projectDirectory(input)
    const project = { path: projectDir, name: path.basename(projectDir) }
    if (isInitializableProjectDirectory(projectDir)) return { ...project, status: 'empty' as const }
    const settings = new ProjectResources(projectDir).readSettings()
    const template = path.join(projectDir, settings.main_template)
    if (!fs.existsSync(template) || !fs.statSync(template).isFile()) {
      throw new Error(`project main template was not found: ${template}`)
    }
    return { ...project, status: 'ready' as const }
  }
  const projectInfo = (input: unknown) => {
    const inspection = inspectProject(input)
    if (inspection.status === 'empty') {
      throw new Error(`project directory is empty and must be initialized: ${inspection.path}`)
    }
    return { path: inspection.path, name: inspection.name }
  }
  const requestProject = (request: { query: unknown }) => {
    const query = request.query as { projectPath?: unknown }
    const project = projectInfo(query.projectPath)
    if (releasedProjects.has(projectKey(project.path))) {
      throw new Error(`project is closed: ${project.path}`)
    }
    return project
  }
  const projectKey = (projectDir: string) => path.normalize(projectDir).toLowerCase()
  const sessionKey = (projectDir: string, sessionId: string) =>
    `${projectKey(projectDir)}:${sessionId}`
  const getStore = (projectDir: string) => {
    const key = projectKey(projectDir)
    if (releasedProjects.has(key)) throw new Error(`project is closed: ${projectDir}`)
    let store = stores.get(key)
    if (!store) {
      store = new SessionStore(projectDir)
      stores.set(key, store)
    }
    return store
  }
  const getExperimentManager = (projectDir: string) => {
    const key = projectKey(projectDir)
    if (releasedProjects.has(key)) throw new Error(`project is closed: ${projectDir}`)
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
  const getTrainingManager = (projectDir: string) => {
    const key = projectKey(projectDir)
    if (releasedProjects.has(key)) throw new Error(`project is closed: ${projectDir}`)
    let manager = trainingManagers.get(key)
    if (!manager) {
      manager = new TrainingManager(projectDir, getExperimentManager(projectDir))
      trainingManagers.set(key, manager)
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
      reply.header('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
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
      return inspectProject((request.body as { path?: unknown } | undefined)?.path)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.post('/api/projects/initialize', async (request, reply) => {
    try {
      const input = (request.body as { path?: unknown } | undefined)?.path
      if (typeof input !== 'string' || !input.trim()) throw new Error('project path is required')
      const initialized = initializeProjectDirectory(input.trim())
      return { ...initialized, status: 'ready' as const }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.post('/api/projects/open', async (request, reply) => {
    try {
      const project = projectInfo((request.body as { path?: unknown } | undefined)?.path)
      releasedProjects.delete(projectKey(project.path))
      return project
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.post('/api/projects/release', async (request, reply) => {
    try {
      const input = (request.body as { path?: unknown } | undefined)?.path
      if (typeof input !== 'string' || !input.trim()) throw new Error('project path is required')
      const projectDir = path.resolve(input.trim())
      const key = projectKey(projectDir)
      releasedProjects.add(key)
      const prefix = `${key}:`
      for (const [key, session] of [...activeSessions]) {
        if (key.startsWith(prefix)) session.shutdown(true, 1000, 'project closed')
      }
      stores.get(key)?.close()
      stores.delete(key)
      await trainingManagers.get(key)?.close()
      trainingManagers.delete(key)
      await experimentManagers.get(key)?.close()
      experimentManagers.delete(key)
      return { released: true, path: projectDir }
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
  app.patch('/api/sessions/:id', async (request, reply) => {
    try {
      const body = request.body as { projectPath?: unknown; name?: unknown } | undefined
      const project = projectInfo(body?.projectPath)
      if (typeof body?.name !== 'string') throw new Error('session name must be a string')
      return getStore(project.path).rename((request.params as { id: string }).id, body.name)
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
        (request.body ?? {}) as { path?: unknown; mapping?: unknown },
      )
      return reply.code(201).send(dataset)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.post('/api/datasets/import/preview', async (request, reply) => {
    try {
      return new DatasetStore(requestProject(request).path).previewImport(
        (request.body ?? {}) as { path?: unknown },
      )
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
  app.get('/api/experiments/training', async (request, reply) => {
    try {
      const query = request.query as { limit?: unknown }
      return { items: getTrainingManager(requestProject(request).path).list(
        query.limit === undefined ? undefined : Number(query.limit),
      ) }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.post('/api/experiments/training', async (request, reply) => {
    try {
      const run = getTrainingManager(requestProject(request).path)
        .create((request.body ?? {}) as CreateTrainingInput)
      return reply.code(202).send(run)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/api/experiments/training/capabilities', async (request, reply) => {
    try {
      return getTrainingManager(requestProject(request).path).capabilities()
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/api/experiments/training/analysis/trend', async (request, reply) => {
    try {
      const query = request.query as { testDatasetId?: unknown; trainDatasetId?: unknown; limit?: unknown }
      if (typeof query.testDatasetId !== 'string' || !query.testDatasetId.trim()) {
        throw new Error('testDatasetId query parameter is required')
      }
      if (query.trainDatasetId !== undefined && typeof query.trainDatasetId !== 'string') {
        throw new Error('trainDatasetId must be a string')
      }
      const limit = query.limit === undefined ? 50 : Number(query.limit)
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be an integer between 1 and 200')
      return getTrainingManager(requestProject(request).path).trend(
        query.testDatasetId,
        query.trainDatasetId || undefined,
        limit,
      )
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/api/experiments/training/analysis/compare', async (request, reply) => {
    try {
      const query = request.query as { leftId?: unknown; rightId?: unknown }
      if (typeof query.leftId !== 'string' || typeof query.rightId !== 'string') {
        throw new Error('leftId and rightId query parameters are required')
      }
      return getTrainingManager(requestProject(request).path).compare(query.leftId, query.rightId)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/api/experiments/training/:id', async (request, reply) => {
    try {
      return getTrainingManager(requestProject(request).path).get((request.params as { id: string }).id)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/api/experiments/training/:id/cases', async (request, reply) => {
    try {
      const manager = getTrainingManager(requestProject(request).path)
      const id = (request.params as { id: string }).id
      void manager.hydrateReferences(id).catch(() => undefined)
      return { items: manager.cases(id) }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/api/experiments/training/:id/experiences', async (request, reply) => {
    try {
      return { items: getTrainingManager(requestProject(request).path).experiences((request.params as { id: string }).id) }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/api/experiments/training/:id/variables', async (request, reply) => {
    try {
      return getTrainingManager(requestProject(request).path).variables((request.params as { id: string }).id)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/api/experiments/training/:id/analysis', async (request, reply) => {
    try {
      return getTrainingManager(requestProject(request).path).analysis((request.params as { id: string }).id)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  for (const action of ['pause', 'resume', 'retry', 'cancel'] as const) {
    app.post(`/api/experiments/training/:id/${action}`, async (request, reply) => {
      try {
        const manager = getTrainingManager(requestProject(request).path)
        const run = manager[action]((request.params as { id: string }).id)
        return reply.code(202).send(run)
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
      }
    })
  }
  app.post('/api/experiments/training/:id/freeze', async (request, reply) => {
    try {
      return getTrainingManager(requestProject(request).path).freeze((request.params as { id: string }).id)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.post('/api/experiments/training/:id/test', async (request, reply) => {
    try {
      const run = getTrainingManager(requestProject(request).path).startTest((request.params as { id: string }).id)
      return reply.code(202).send(run)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.post('/api/experiments/training/:id/snapshot-evaluations', async (request, reply) => {
    try {
      const run = getTrainingManager(requestProject(request).path).createSnapshotEvaluation(
        (request.params as { id: string }).id,
        (request.body ?? {}) as CreateSnapshotEvaluationInput,
      )
      return reply.code(201).send(run)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.post('/api/experiments/training/:id/promote', async (request, reply) => {
    try {
      const result = await getTrainingManager(requestProject(request).path)
        .promote((request.params as { id: string }).id)
      return reply.send(result)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.put('/api/experiments/training/:id/experiences/:experienceId', async (request, reply) => {
    try {
      const params = request.params as { id: string; experienceId: string }
      const patches = (request.body as { patches?: unknown } | undefined)?.patches
      if (!Array.isArray(patches)) throw new Error('patches must be an array')
      return getTrainingManager(requestProject(request).path)
        .updateExperience(params.id, params.experienceId, patches as VariableDiff[])
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  for (const action of ['replay', 'accept', 'reject'] as const) {
    app.post(`/api/experiments/training/:id/experiences/:experienceId/${action}`, async (request, reply) => {
      try {
        const params = request.params as { id: string; experienceId: string }
        const manager = getTrainingManager(requestProject(request).path)
        const candidate = action === 'replay'
          ? await manager.replayExperience(params.id, params.experienceId)
          : action === 'accept'
            ? await manager.acceptExperience(params.id, params.experienceId)
            : manager.rejectExperience(params.id, params.experienceId)
        return reply.code(action === 'replay' ? 202 : 200).send(candidate)
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
      }
    })
  }
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
      return experimentCaseForPresentation(
        getExperimentManager(requestProject(request).path).case(params.id, params.caseId),
      )
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.get('/api/resources/system-variables', async (request) =>
    new ProjectResources(requestProject(request).path).readSystemVariables())
  app.put('/api/resources/system-variables', async (request, reply) => {
    try {
      return await new ProjectResources(requestProject(request).path)
        .saveSystemVariablesQueued(request.body)
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
  app.post('/api/resources/project-settings/llm/test', async (request, reply) => {
    let settings: ReturnType<ProjectResources['readSettings']>
    let promptVariable: ReturnType<ProjectResources['readSystemVariables']>['variables'][number] | undefined
    try {
      const resources = new ProjectResources(requestProject(request).path)
      settings = resources.resolveSettings({ llm: request.body })
      const variables = resources.readSystemVariables().variables
      promptVariable = variables.find((variable) => (
        variable.key === 'llm_test_prompt' && variable.value.trim()
      )) ?? variables.find((variable) => (
        variable.key === 'agent_identity' && variable.value.trim()
      ))
      if (!promptVariable) {
        throw new Error('project system variables must define llm_test_prompt or agent_identity')
      }
    } catch (error) {
      return reply.code(400).send({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    const startedAt = Date.now()
    try {
      const llm = createLlmService({
        model: settings.llm.model,
        baseUrl: settings.llm.base_url,
        protocol: settings.llm.protocol,
        apiKey: settings.llm.api_key,
        timeoutMs: 15_000,
        maxRetries: 0,
      })
      const result = await llm.stream({
        messages: [{ role: 'user', content: promptVariable.value }],
        maxTokens: 16,
      }, () => {})
      return {
        ok: true,
        model: result.model,
        protocol: settings.llm.protocol,
        duration_ms: Date.now() - startedAt,
        finish_reason: result.finishReason,
        usage: result.usage,
        prompt_variable: promptVariable.key,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return reply.code(502).send({
        ok: false,
        error: settings.llm.api_key
          ? message.replaceAll(settings.llm.api_key, '[redacted]')
          : message,
        duration_ms: Date.now() - startedAt,
      })
    }
  })
  app.get('/api/resources/files', async (request, reply) => {
    try {
      const directory = (request.query as { path?: unknown }).path ?? ''
      return new ProjectFileService(requestProject(request).path).list(directory)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.get('/api/resources/files/content', async (request, reply) => {
    try {
      const file = (request.query as { path?: unknown }).path
      return new ProjectFileService(requestProject(request).path).read(file)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.put('/api/resources/files/content', {
    bodyLimit: MAX_PROJECT_TEXT_FILE_BYTES * 2 + 65_536,
  }, async (request, reply) => {
    try {
      return new ProjectFileService(requestProject(request).path).write(
        (request.body ?? {}) as { path?: unknown; content?: unknown; revision?: unknown },
      )
    } catch (error) {
      return reply.code(error instanceof ProjectFileRevisionConflict ? 409 : 400).send({
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
  app.post('/api/resources/files', async (request, reply) => {
    try {
      const created = new ProjectFileService(requestProject(request).path).create(
        (request.body ?? {}) as { parent?: unknown; name?: unknown; type?: unknown },
      )
      return reply.code(201).send(created)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.patch('/api/resources/files', async (request, reply) => {
    try {
      return new ProjectFileService(requestProject(request).path).rename(
        (request.body ?? {}) as { path?: unknown; name?: unknown },
      )
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.delete('/api/resources/files', async (request, reply) => {
    try {
      return new ProjectFileService(requestProject(request).path).remove(
        (request.body ?? {}) as { path?: unknown; recursive?: unknown },
      )
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
  app.post('/api/resources/hooks', async (request, reply) => {
    try {
      const created = new ProjectResourceRegistry(requestProject(request).path)
        .createHook(request.body)
      return reply.code(201).send(created)
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.post('/api/resources/hooks/:id/test', async (request, reply) => {
    try {
      const body = request.body as { fixture?: unknown } | undefined
      return await new ProjectResourceRegistry(requestProject(request).path).testHook(
        (request.params as { id: string }).id,
        body?.fixture ?? {},
      )
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  app.put('/api/resources/hooks/:id', async (request, reply) => {
    try {
      return new ProjectResourceRegistry(requestProject(request).path)
        .saveHook((request.params as { id: string }).id, request.body)
    } catch (error) {
      return reply.code(error instanceof ResourceRevisionConflict ? 409 : 400).send({
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
  app.delete('/api/resources/hooks/:id', async (request, reply) => {
    try {
      return new ProjectResourceRegistry(requestProject(request).path)
        .deleteHook((request.params as { id: string }).id, request.body)
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
    await Promise.all([...trainingManagers.values()].map((manager) => manager.close()))
    await Promise.all([...experimentManagers.values()].map((manager) => manager.close()))
  })

  return app
}
