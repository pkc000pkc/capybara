import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'

import { buildApp } from '#app'
import { LocalDashboardHost } from '#core/local-dashboard-host'
import { LocalDashboardPublisher } from '#core/local-dashboard-publisher'
import { registerMarketResearchRoutes } from '#core/market-research-routes'
import type { ApplicationRuntimeService } from '#core/application-runtime-service'
import { MarketResearchService, type MarketResearchResult } from '#core/market-research-service'

function fakeRuntime(): ApplicationRuntimeService {
  const result = (operation: string, versionId = 'v1') => ({ ok: true, operation, versionId, action: { id: `${operation}-action` }, admission: { disposition: 'accepted', action: { id: `${operation}-action` }, checks: [], reasons: [] }, receipt: { id: `${operation}-receipt`, status: 'succeeded', sideEffect: 'none', evidenceRefs: [], observedAt: '2026-11-07T12:00:00.000Z' }, evidence: { evidenceId: `${operation}-evidence`, sourceRefs: [] }, manifest: { versions: { deployedVersionId: 'v1', runningVersionId: 'v1' } } }) as never
  return { preview: () => result('preview'), deploy: () => result('deploy'), start: () => result('start'), manifest: { appId: 'app-1' } } as unknown as ApplicationRuntimeService
}

test('LocalDashboardPublisher exposes a verified logical artifact and requires a host address to open', async () => {
  const withoutHost = new LocalDashboardPublisher({ service: fakeRuntime(), applicationId: 'app-1', versionId: 'v1' })
  const published = await withoutHost.publish({ ticker: '000682', marketData: { ticker: '000682', bars: [], asOf: '2026-11-07' }, reports: { ticker: '000682', reports: [] }, analysis: { ticker: '000682', summary: '', metrics: {}, recommendation: { disposition: 'for_review', stance: 'insufficient_evidence', rationale: [], risks: [], uncertainties: [] } }, runId: 'run-1' })
  assert.equal(published.status, 'succeeded')
  assert.equal(published.value?.status, 'published')
  assert.equal(published.artifacts?.[0]?.status, 'available')
  assert.equal((await withoutHost.open({ applicationId: 'app-1', versionId: 'v1', runId: 'run-1' })).status, 'unknown')
  const withHost = new LocalDashboardPublisher({ service: fakeRuntime(), applicationId: 'app-1', versionId: 'v1', addressFactory: () => 'workbench://app-1/v1' })
  assert.equal((await withHost.open({ applicationId: 'app-1', versionId: 'v1', runId: 'run-1' })).value?.address, 'workbench://app-1/v1')
})

test('LocalDashboardHost serves a real HTML dashboard and publisher resolves its address', async () => {
  const host = new LocalDashboardHost()
  try {
    const publisher = new LocalDashboardPublisher({ service: fakeRuntime(), applicationId: 'app-1', versionId: 'v1', host })
    const published = await publisher.publish({
      ticker: '000682',
      marketData: {
        ticker: '000682',
        bars: [{ date: '2026-11-07', open: 10, high: 11, low: 9, close: 10.5, volume: 1200 }],
        asOf: '2026-11-07',
        currency: 'CNY',
      },
      reports: { ticker: '000682', reports: [{ title: '示例研报', sourceUrl: 'https://example.com/report.pdf', artifactId: 'report-1', contentHash: 'hash-1' }] },
      analysis: {
        ticker: '000682',
        summary: '基于可验证数据的示例分析',
        metrics: { close: 10.5 },
        recommendation: { disposition: 'for_review', stance: 'neutral', rationale: ['等待更多证据'], risks: ['波动风险'], uncertainties: ['样本有限'] },
      },
      runId: 'run-1',
    })
    assert.equal(published.status, 'succeeded')
    const address = published.value?.address
    assert.ok(address)
    assert.ok(address.startsWith('http://127.0.0.1:'))
    const response = await fetch(address)
    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /000682/)
    assert.match(html, /交易建议/)
    assert.equal((await publisher.open({ applicationId: 'app-1', versionId: 'v1', runId: 'run-1' })).value?.address, address)
  } finally {
    await host.close()
  }
})

test('market research route validates input and preserves unknown service results', async () => {
  const app = Fastify()
  const unknown: MarketResearchResult = { status: 'unknown', ticker: '000682', period: { startDate: '2026-10-09', endDate: '2026-11-07' }, steps: [], evidence: [], artifacts: [] }
  await registerMarketResearchRoutes(app, { serviceFactory: async () => ({ run: async () => unknown } as never) })
  const invalid = await app.inject({ method: 'POST', url: '/api/work/market-research', payload: { projectId: 'p', runId: 'r', ticker: '682', reportUrls: [] } })
  assert.equal(invalid.statusCode, 400)
  const result = await app.inject({ method: 'POST', url: '/api/work/market-research', payload: { projectId: 'p', runId: 'r', ticker: '000682', reportUrls: [] } })
  assert.equal(result.statusCode, 409)
  assert.equal(result.json().status, 'unknown')
  await app.close()
})

test('buildApp registers and invokes the market research factory route', async () => {
  let factoryCalls = 0
  const unknown: MarketResearchResult = { status: 'unknown', ticker: '000682', period: { startDate: '2026-10-09', endDate: '2026-11-07' }, steps: [], evidence: [], artifacts: [] }
  const userConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-market-research-'))
  const app = await buildApp({
    userConfigDir,
    marketResearchFactory: async ({ projectId, runId }) => {
      factoryCalls += 1
      assert.equal(projectId, 'project-1')
      assert.equal(runId, 'run-1')
      return new MarketResearchService()
    },
  })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/work/market-research', payload: { projectId: 'project-1', runId: 'run-1', ticker: '000682', reportUrls: [] } })
    assert.equal(response.statusCode, 409)
    assert.equal(response.json().status, 'unknown')
    assert.equal(factoryCalls, 1)
  } finally {
    await app.close()
    fs.rmSync(userConfigDir, { recursive: true, force: true })
  }
})

test('buildApp executes configured market research providers through a local dashboard host', async () => {
  const userConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-market-research-e2e-'))
  let host: LocalDashboardHost | undefined
  const app = await buildApp({
    userConfigDir,
    marketResearchFactory: async () => {
      host = new LocalDashboardHost()
      const dashboard = new LocalDashboardPublisher({ service: fakeRuntime(), applicationId: 'app-1', versionId: 'v1', host })
      return new MarketResearchService({
        now: () => '2026-11-07T12:00:00.000Z',
        providers: {
          marketData: {
            fetchDailySeries: async ({ ticker, endDate }) => ({
              status: 'succeeded',
              value: { ticker, bars: [{ date: endDate, open: 10, high: 11, low: 9, close: 10.5, volume: 1200 }], asOf: endDate, currency: 'CNY' },
              evidence: [{ kind: 'market-data', source: 'integration-fixture', summary: 'fixture daily bar', payload: { ticker, endDate } }],
            }),
          },
          reports: {
            downloadReports: async ({ ticker }) => ({
              status: 'succeeded',
              value: { ticker, reports: [{ title: '示例研报', sourceUrl: 'https://example.com/report.pdf', artifactId: 'report-1', contentHash: 'hash-1' }] },
              evidence: [{ kind: 'report-source', source: 'integration-fixture', summary: 'fixture report source', payload: { ticker } }],
              artifacts: [{ kind: 'report', contentRef: 'report-1', contentHash: 'hash-1', status: 'quarantined', summary: 'fixture report artifact' }],
            }),
          },
          python: {
            analyze: async ({ ticker }) => ({
              status: 'succeeded',
              value: { ticker, summary: 'fixture analysis', metrics: { close: 10.5 }, recommendation: { disposition: 'for_review', stance: 'neutral', rationale: ['fixture'], risks: ['fixture'], uncertainties: ['fixture'] } },
              evidence: [{ kind: 'python-analysis', source: 'integration-fixture', summary: 'fixture analysis output', payload: { ticker } }],
            }),
          },
          dashboard,
        },
      })
    },
  })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/work/market-research', payload: { projectId: 'project-1', runId: 'run-1', ticker: '000682', reportUrls: [], today: '2026-11-07' } })
    assert.equal(response.statusCode, 200)
    const result = response.json() as MarketResearchResult
    assert.equal(result.status, 'succeeded')
    assert.ok(result.application?.address?.startsWith('http://127.0.0.1:'))
    assert.ok(result.application?.address)
    const html = await (await fetch(result.application.address)).text()
    assert.match(html, /000682/)
    assert.match(html, /fixture analysis/)
  } finally {
    await app.close()
    await host?.close()
    fs.rmSync(userConfigDir, { recursive: true, force: true })
  }
})
