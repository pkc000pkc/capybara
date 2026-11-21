import type { FastifyInstance } from 'fastify'

import { createHttpBrowserExecutor } from '#core/http-browser-executor'

export async function registerBrowserHttpRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/work/browser/read', async (request, reply) => {
    const body = request.body as { url?: unknown } | undefined
    if (typeof body?.url !== 'string' || !body.url.trim()) return reply.code(400).send({ error: 'url is required' })
    const url = body.url.trim()
    try { new URL(url) } catch { return reply.code(400).send({ error: 'url is invalid' }) }
    const executor = createHttpBrowserExecutor()
    const result = await executor({
      action: { id: `browser-read:${Date.now()}`, runId: `browser-read:${Date.now()}`, sessionId: 'http-session', tabId: 'http-tab', sequence: 1, kind: 'read', target: { url }, arguments: {}, preconditions: [], risk: 'read', idempotencyKey: `browser-read:${url}`, status: 'admitted' },
      profile: {} as never,
      session: {} as never,
      tab: { id: 'http-tab', sessionId: 'http-session', index: 0, url, origin: new URL(url).origin, status: 'open' } as never,
      attempt: 1,
    })
    return reply.code(result.status === 'succeeded' ? 200 : result.status === 'unknown' ? 409 : 422).send(result)
  })
}
