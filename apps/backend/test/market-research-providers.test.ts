import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { EastmoneyMarketDataProvider } from '#core/market-data-eastmoney-provider'
import { HttpReportProvider } from '#core/report-http-provider'
import { PythonLocalAnalysisExecutor } from '#core/python-local-executor'

test('Eastmoney provider builds explicit secid/date URL and parses daily bars with evidence', async () => {
  let requested = ''
  const provider = new EastmoneyMarketDataProvider({
    fetchImpl: async (url) => { requested = url; return new Response(JSON.stringify({ data: { name: 'test', code: '000682', klines: ['2026-11-06,10,10.5,11,9.8,1234'] } }), { status: 200 }) },
    now: () => '2026-11-07T12:00:00.000Z',
  })
  const result = await provider.fetchDailySeries({ ticker: '000682', exchange: 'SZ', startDate: '2026-10-09', endDate: '2026-11-07', runId: 'run-1' })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.value?.bars[0]?.close, 10.5)
  assert.equal(result.evidence?.[0]?.kind, 'market-data')
  assert.match(requested, /secid=0\.000682/)
  assert.match(requested, /beg=20261009/)
  assert.match(requested, /end=20261107/)
})

test('HTTP report provider downloads only explicit HTTPS URLs into quarantine', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capybara-report-'))
  try {
    const provider = new HttpReportProvider({ quarantineRoot: root, fetchImpl: async (url) => new Response(`report:${url}`, { status: 200, headers: { 'content-type': 'application/pdf' } }), now: () => '2026-11-07T12:00:00.000Z' })
    const result = await provider.downloadReports({ ticker: '000682', reportUrls: ['https://reports.example.test/000682.pdf'], runId: 'run-1' })
    assert.equal(result.status, 'succeeded')
    const artifact = result.artifacts?.[0]
    assert.equal(artifact?.status, 'quarantined')
    assert.match(artifact?.contentRef ?? '', /^quarantine:/)
    const files = await (await import('node:fs/promises')).readdir(root)
    assert.equal(files.length, 1)
    assert.equal(await readFile(path.join(root, files[0]!), 'utf8'), 'report:https://reports.example.test/000682.pdf')
    const blocked = await provider.downloadReports({ ticker: '000682', reportUrls: ['http://localhost/private.pdf'], runId: 'run-2' })
    assert.equal(blocked.status, 'failed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Python local executor returns structured output, unknown executable, and timeout states', async () => {
  const success = new PythonLocalAnalysisExecutor({ workspaceDir: 'C:\\workspace', scriptPath: 'C:\\workspace\\analysis.py', runProcess: async () => ({ stdout: JSON.stringify({ ticker: '000682', summary: 'ok', metrics: {}, recommendation: { disposition: 'for_review', stance: 'neutral', rationale: ['fixture'], risks: [], uncertainties: [] } }), stderr: '', exitCode: 0, timedOut: false }) })
  const result = await success.analyze({ ticker: '000682', marketData: {}, reports: {}, runId: 'run-1' })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.value?.recommendation.disposition, 'for_review')
  const unavailable = new PythonLocalAnalysisExecutor({ workspaceDir: 'C:\\workspace', scriptPath: 'C:\\workspace\\analysis.py', runProcess: async () => ({ stdout: '', stderr: 'spawn python ENOENT', exitCode: null, timedOut: false }) })
  assert.equal((await unavailable.analyze({ ticker: '000682', marketData: {}, reports: {}, runId: 'run-2' })).status, 'unknown')
  const timedOut = new PythonLocalAnalysisExecutor({ workspaceDir: 'C:\\workspace', scriptPath: 'C:\\workspace\\analysis.py', runProcess: async () => ({ stdout: '', stderr: '', exitCode: null, timedOut: true }), timeoutMs: 20 })
  assert.equal((await timedOut.analyze({ ticker: '000682', marketData: {}, reports: {}, runId: 'run-3' })).status, 'unknown')
})
