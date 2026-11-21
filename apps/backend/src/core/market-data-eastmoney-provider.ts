import { createHash } from 'node:crypto'

import type { DailyBar, MarketDataProvider, MarketDataResult, ProviderResult, ResearchEvidenceInput } from '#core/market-research-service'

export type EastmoneyFetch = (input: string, init?: RequestInit) => Promise<Response>

export type EastmoneyMarketDataProviderOptions = {
  fetchImpl?: EastmoneyFetch
  timeoutMs?: number
  endpoint?: string
  now?: () => string
}

const DEFAULT_ENDPOINT = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function parseBar(value: string): DailyBar | undefined {
  const fields = value.split(',')
  if (fields.length < 6 || !validDate(fields[0]!)) return undefined
  const numbers = fields.slice(1, 6).map(Number)
  if (numbers.some((item) => !Number.isFinite(item))) return undefined
  const open = numbers[0]!
  const close = numbers[1]!
  const high = numbers[2]!
  const low = numbers[3]!
  const volume = numbers[4]!
  return { date: fields[0]!, open, high, low, close, volume }
}

function errorResult(code: string, message: string, retryable: boolean): ProviderResult<MarketDataResult> {
  return { status: retryable ? 'unknown' : 'failed', error: { code, message, retryable } }
}

export class EastmoneyMarketDataProvider implements MarketDataProvider {
  private readonly fetchImpl: EastmoneyFetch
  private readonly timeoutMs: number
  private readonly endpoint: string
  private readonly now: () => string

  constructor(options: EastmoneyMarketDataProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async fetchDailySeries(input: { ticker: string; exchange?: string; startDate: string; endDate: string; runId: string }): Promise<ProviderResult<MarketDataResult>> {
    if (!/^\d{6}$/.test(input.ticker)) return errorResult('INVALID_TICKER', 'ticker must be a six-digit security code', false)
    if (!validDate(input.startDate) || !validDate(input.endDate) || input.startDate > input.endDate) return errorResult('INVALID_DATE_RANGE', 'startDate/endDate must be an ordered YYYY-MM-DD range', false)
    const secid = `0.${input.ticker}`
    const url = new URL(this.endpoint)
    url.searchParams.set('secid', secid)
    url.searchParams.set('klt', '101')
    url.searchParams.set('fqt', '1')
    url.searchParams.set('beg', input.startDate.replaceAll('-', ''))
    url.searchParams.set('end', input.endDate.replaceAll('-', ''))
    url.searchParams.set('fields1', 'f1,f2,f3,f4,f5,f6')
    url.searchParams.set('fields2', 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let raw: string
    try {
      const response = await this.fetchImpl(url.toString(), { method: 'GET', redirect: 'error', signal: controller.signal })
      raw = await response.text()
      if (!response.ok) return errorResult('EASTMONEY_HTTP', `Eastmoney returned HTTP ${response.status}`, response.status >= 500 || response.status === 429)
    } catch (error) {
      return errorResult('EASTMONEY_NETWORK', error instanceof Error ? error.message : String(error), true)
    } finally {
      clearTimeout(timer)
    }
    let payload: { data?: { klines?: unknown; name?: unknown; code?: unknown } }
    try {
      payload = JSON.parse(raw) as typeof payload
    } catch {
      return errorResult('EASTMONEY_INVALID_JSON', 'Eastmoney returned invalid JSON', true)
    }
    const klines = payload.data?.klines
    if (!Array.isArray(klines)) return errorResult('EASTMONEY_NO_DATA', 'Eastmoney returned no daily series', false)
    const bars = klines.map((item) => typeof item === 'string' ? parseBar(item) : undefined).filter((item): item is DailyBar => Boolean(item))
    if (bars.length === 0) return errorResult('EASTMONEY_NO_VALID_BARS', 'Eastmoney returned no valid daily bars', false)
    const contentHash = hash(raw)
    const value: MarketDataResult = { ticker: input.ticker, exchange: input.exchange ?? 'SZ', currency: 'CNY', bars, asOf: input.endDate }
    const evidence: ResearchEvidenceInput[] = [{ kind: 'market-data', source: 'eastmoney', locator: url.toString(), summary: `Eastmoney daily series ${input.startDate}..${input.endDate} (${bars.length} bars)`, payload: { requestUrl: url.toString(), responseHash: contentHash, capturedAt: this.now(), ticker: input.ticker } }]
    return { status: 'succeeded', value, evidence }
  }
}

export function createEastmoneyMarketDataProvider(options: EastmoneyMarketDataProviderOptions = {}): EastmoneyMarketDataProvider {
  return new EastmoneyMarketDataProvider(options)
}
