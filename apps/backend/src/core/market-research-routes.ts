import type { FastifyInstance } from 'fastify'

import { MarketResearchService, type MarketResearchRequest } from '#core/market-research-service'

export type MarketResearchRouteOptions = {
  serviceFactory: (request: { projectId: string; runId: string; projectPath?: string }) => MarketResearchService | Promise<MarketResearchService>
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} is required`)
  return value
}

function parseRequest(value: unknown): MarketResearchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('market research body must be an object')
  const body = value as Record<string, unknown>
  const projectId = requiredString(body.projectId, 'projectId')
  const runId = requiredString(body.runId, 'runId')
  const projectPath = typeof body.projectPath === 'string' && body.projectPath.trim() ? body.projectPath.trim() : undefined
  const ticker = requiredString(body.ticker, 'ticker')
  if (!/^\d{6}$/.test(ticker)) throw new Error('ticker must be a six-digit security code')
  if (!Array.isArray(body.reportUrls) || !body.reportUrls.every((item) => typeof item === 'string')) throw new Error('reportUrls must be a string array')
  return { projectId, runId, ticker, ...(projectPath ? { projectPath } : {}), ...(typeof body.exchange === 'string' ? { exchange: body.exchange } : {}), reportUrls: [...body.reportUrls], ...(typeof body.today === 'string' ? { today: body.today } : {}) }
}

/** Registers the user-facing research command without choosing providers. */
export async function registerMarketResearchRoutes(app: FastifyInstance, options: MarketResearchRouteOptions): Promise<void> {
  app.post('/api/work/market-research', async (request, reply) => {
    let input: MarketResearchRequest
    try { input = parseRequest(request.body) } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }) }
    try {
      const service = await options.serviceFactory({ projectId: input.projectId, runId: input.runId, projectPath: input.projectPath })
      const result = await service.run(input)
      return reply.code(result.status === 'succeeded' ? 200 : result.status === 'unknown' ? 409 : 422).send(result)
    } catch (error) {
      return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
}
