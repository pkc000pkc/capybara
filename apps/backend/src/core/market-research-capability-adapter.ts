import type {
  ProductCapabilityAdapter,
  ProductCapabilityDescriptor,
  ProductCapabilityExecutionContext,
  ProductCapabilityExecutionResult,
} from '#core/product-capability-registry'
import { MarketResearchService, type MarketResearchResult, type MarketResearchProviders } from '#core/market-research-service'

export type MarketResearchCapabilityInput = {
  ticker: string
  exchange?: string
  reportUrls: string[]
  today?: string
}

export function validateMarketResearchInput(value: unknown): asserts value is MarketResearchCapabilityInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('market research input must be an object')
  const input = value as Record<string, unknown>
  if (typeof input.ticker !== 'string' || !/^\d{6}$/.test(input.ticker)) throw new Error('market research ticker must be a six-digit security code')
  if (input.exchange !== undefined && (typeof input.exchange !== 'string' || input.exchange.trim().length === 0)) throw new Error('market research exchange must be a non-empty string')
  if (!Array.isArray(input.reportUrls) || !input.reportUrls.every((item) => typeof item === 'string')) throw new Error('market research reportUrls must be a string array')
  if (input.today !== undefined && (typeof input.today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.today))) throw new Error('market research today must be YYYY-MM-DD')
}

export function marketResearchCapabilityDescriptor(): ProductCapabilityDescriptor<MarketResearchCapabilityInput, MarketResearchResult> {
  return {
    id: 'market-research',
    capabilityId: 'market-research',
    kind: 'program',
    apiVersion: 'v1',
    inputSchema: 'capybara.market-research.v1',
    outputSchema: 'capybara.market-research-result.v1',
    scope: {},
    risk: 'execution',
    requiredPermission: 'L2',
    evidenceKinds: ['market-data', 'research-report', 'python-analysis', 'dashboard-build', 'dashboard-open', 'reconciliation'],
    state: 'available',
    description: 'Research a security, analyze verified data, and propose a review-only dashboard result.',
    validateInput: validateMarketResearchInput,
  }
}

export class MarketResearchCapabilityAdapter implements ProductCapabilityAdapter<MarketResearchCapabilityInput, MarketResearchResult> {
  readonly descriptor = marketResearchCapabilityDescriptor()

  constructor(readonly service: MarketResearchService) {}

  async execute(context: ProductCapabilityExecutionContext<MarketResearchCapabilityInput>): Promise<ProductCapabilityExecutionResult<MarketResearchResult>> {
    validateMarketResearchInput(context.input)
    const result = await this.service.run({ ...context.input, projectId: context.action.projectId, runId: context.action.runId })
    const evidenceRefs = result.evidence.map((item) => item.evidenceId)
    const base = { output: result, evidenceRefs, resultHash: JSON.stringify(result) }
    if (result.status === 'succeeded') return { status: 'succeeded', ...base }
    if (result.status === 'unknown') return { status: 'unknown', ...base, error: { code: 'MARKET_RESEARCH_UNKNOWN', message: 'market research is not fully verified', retryable: true } }
    return { status: 'failed', ...base, error: { code: 'MARKET_RESEARCH_FAILED', message: 'market research did not complete', retryable: false } }
  }
}

export function createMarketResearchCapabilityAdapter(providers: MarketResearchProviders = {}): MarketResearchCapabilityAdapter {
  return new MarketResearchCapabilityAdapter(new MarketResearchService({ providers }))
}
