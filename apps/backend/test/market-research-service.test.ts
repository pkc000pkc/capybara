import assert from 'node:assert/strict'
import test from 'node:test'

import { MarketResearchService, type DashboardPublisher, type MarketDataProvider, type PythonAnalysisExecutor, type ReportProvider } from '#core/market-research-service'
import { ProductWorkLedger } from '#core/product-work-ledger'

const request = { projectId: 'project-682', runId: 'research-run-1', ticker: '000682', exchange: 'SZ', reportUrls: ['https://reports.example.test/000682.pdf'], today: '2026-11-07' }

function providers() {
  const marketData: MarketDataProvider = {
    async fetchDailySeries(input) {
      return { status: 'succeeded', value: { ticker: input.ticker, exchange: input.exchange, currency: 'CNY', asOf: input.endDate, bars: [{ date: input.startDate, open: 10, high: 11, low: 9, close: 10.5, volume: 1000 }] }, evidence: [{ kind: 'market-data', source: 'quote-provider', locator: '000682/daily', summary: 'verified daily series', payload: input }] }
    },
  }
  const reports: ReportProvider = {
    async downloadReports(input) {
      return { status: 'succeeded', value: { ticker: input.ticker, reports: [{ title: '000682 research report', sourceUrl: input.reportUrls[0]!, artifactId: 'report-artifact-1', contentHash: 'report-hash' }] }, artifacts: [{ kind: 'research-report', contentRef: 'quarantine:report-artifact-1', contentHash: 'report-hash', status: 'quarantined', summary: 'downloaded into quarantine' }] }
    },
  }
  const python: PythonAnalysisExecutor = {
    async analyze(input) {
      return { status: 'succeeded', value: { ticker: input.ticker, summary: 'analysis complete', metrics: { return30d: '5.0%' }, recommendation: { disposition: 'for_review', stance: 'neutral', rationale: ['price series is short in fixture'], risks: ['report freshness'], uncertainties: ['provider coverage'] } }, evidence: [{ kind: 'python-analysis', source: 'python-runner', summary: 'analysis receipt', payload: { ticker: input.ticker } }] }
    },
  }
  const dashboard: DashboardPublisher = {
    async publish(input) { return { status: 'succeeded', value: { applicationId: `app-${input.ticker}`, versionId: 'v1', status: 'published' }, evidence: [{ kind: 'dashboard-build', source: 'application-builder', summary: 'dashboard build verified' }] } },
    async open(input) { return { status: 'succeeded', value: { applicationId: input.applicationId, versionId: input.versionId, status: 'running', address: 'workbench://application/000682' }, evidence: [{ kind: 'dashboard-open', source: 'application-host', summary: 'dashboard opened' }] } },
  }
  return { marketData, reports, python, dashboard }
}

test('research orchestrates 000682 daily data, report quarantine, Python analysis, dashboard publish/open, and review-only recommendation', async () => {
  const service = new MarketResearchService({ ledger: new ProductWorkLedger({ projectId: request.projectId }), providers: providers(), now: () => '2026-11-07T12:00:00.000Z' })
  const result = await service.run(request)
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(result.period, { startDate: '2026-10-09', endDate: '2026-11-07' })
  assert.deepEqual(result.steps.map((step) => step.status), ['succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded'])
  assert.equal(result.recommendation?.disposition, 'for_review')
  assert.equal(result.application?.status, 'running')
  assert.ok(result.artifacts.some((artifact) => artifact.status === 'quarantined'))
  assert.ok(result.evidence.length >= 4)
  assert.equal(service.ledger.getReceipts(result.steps[0]!.action.id).at(-1)?.status, 'succeeded')
})

test('missing providers do not report success and blocked downstream steps remain not_executed', async () => {
  const service = new MarketResearchService({ ledger: new ProductWorkLedger({ projectId: request.projectId }) })
  const result = await service.run(request)
  assert.equal(result.status, 'unknown')
  assert.equal(result.steps[0]?.status, 'unknown')
  assert.equal(result.steps[0]?.receipt.status, 'unknown')
  assert.equal(result.steps[1]?.status, 'not_executed')
  assert.equal(result.steps[1]?.receipt.status, 'not_executed')
  assert.equal(result.recommendation, undefined)
  assert.equal(result.application, undefined)
})

test('provider unknown is preserved and does not trigger Python or application actions', async () => {
  const base = providers()
  base.marketData = { async fetchDailySeries() { return { status: 'unknown', error: { code: 'UPSTREAM_TIMEOUT', message: 'quote provider timeout', retryable: true } } } }
  const service = new MarketResearchService({ ledger: new ProductWorkLedger({ projectId: request.projectId }), providers: base })
  const result = await service.run(request)
  assert.equal(result.status, 'unknown')
  assert.equal(result.steps[0]?.receipt.status, 'unknown')
  assert.equal(result.steps[2]?.status, 'not_executed')
  assert.equal(result.steps[3]?.status, 'not_executed')
  assert.equal(result.steps[4]?.status, 'not_executed')
})
