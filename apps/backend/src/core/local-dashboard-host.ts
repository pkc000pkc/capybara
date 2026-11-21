import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type { DailyBar, PythonAnalysisResult, ReportDownloadResult } from '#core/market-research-service'

export type LocalDashboardHostOptions = {
  host?: string
  port?: number
  storageDir?: string
}

export type LocalDashboardPublishInput = {
  applicationId: string
  versionId: string
  ticker: string
  marketData: { bars?: DailyBar[]; asOf?: string; currency?: string }
  reports: ReportDownloadResult
  analysis: PythonAnalysisResult
}

export type LocalDashboardHostResult = {
  address: string
  contentRef: string
  contentHash: string
  persistentAddress?: string
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function renderDashboard(input: LocalDashboardPublishInput): string {
  const bars = (input.marketData.bars ?? []).slice(-30)
  const rows = bars.map((bar) => `<tr><td>${escapeHtml(bar.date)}</td><td>${bar.open}</td><td>${bar.high}</td><td>${bar.low}</td><td>${bar.close}</td><td>${bar.volume ?? ''}</td></tr>`).join('')
  const reports = input.reports.reports.map((report) => `<li><a href="${escapeHtml(report.sourceUrl)}" rel="noreferrer">${escapeHtml(report.title)}</a><small>${escapeHtml(report.contentHash)}</small></li>`).join('')
  const recommendation = input.analysis.recommendation
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.ticker)} 行情看板</title><style>body{font-family:Segoe UI,Microsoft YaHei,sans-serif;margin:0;background:#eef3f3;color:#18383e}main{max-width:1100px;margin:0 auto;padding:28px}header,.card{background:white;border:1px solid #d5e1e2;border-radius:10px;padding:18px;box-shadow:0 6px 20px #18383e12}header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}h1{margin:4px 0;font-size:26px}.eyebrow{color:#0c766e;font-size:12px;font-weight:700}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:14px}.card h2{font-size:15px;margin:0 0 10px}.metrics{display:flex;gap:14px;flex-wrap:wrap}.metric{background:#e5f3f0;border-radius:7px;padding:8px 10px}.metric b{display:block;font-size:16px}.muted{color:#6d7c80;font-size:12px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:right;padding:6px;border-bottom:1px solid #edf1f1}th:first-child,td:first-child{text-align:left}ul{padding-left:18px}li{margin:7px 0}li small{display:block;color:#8b999a;font-size:10px;word-break:break-all}@media(max-width:760px){.grid{grid-template-columns:1fr}main{padding:14px}}</style></head><body><main><header><div><span class="eyebrow">本地行情看板 · ${escapeHtml(input.versionId)}</span><h1>${escapeHtml(input.ticker)}</h1><p class="muted">最近 30 个交易日 · 截止 ${escapeHtml(input.marketData.asOf)} · ${escapeHtml(input.marketData.currency ?? 'CNY')}</p></div><div class="muted">本页由 Capybara Work Agent 生成<br>建议仅供人工审查</div></header><div class="grid"><section class="card"><h2>分析结论</h2><p>${escapeHtml(input.analysis.summary)}</p><div class="metrics">${Object.entries(input.analysis.metrics).map(([key,value]) => `<div class="metric"><span class="muted">${escapeHtml(key)}</span><b>${escapeHtml(value)}</b></div>`).join('')}</div></section><section class="card"><h2>交易建议（待审查）</h2><p><strong>${escapeHtml(recommendation.stance)}</strong></p><ul>${recommendation.rationale.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul><p class="muted">风险：${escapeHtml(recommendation.risks.join('；'))}</p><p class="muted">不确定性：${escapeHtml(recommendation.uncertainties.join('；'))}</p></section><section class="card"><h2>近 30 日日线</h2><table><thead><tr><th>日期</th><th>开盘</th><th>最高</th><th>最低</th><th>收盘</th><th>成交量</th></tr></thead><tbody>${rows}</tbody></table></section><section class="card"><h2>研报来源</h2><ul>${reports || '<li>没有研报来源</li>'}</ul></section></div></main></body></html>`
}

export class LocalDashboardHost {
  private readonly host: string
  private readonly port: number
  private readonly storageDir?: string
  private server?: Server
  private address?: string
  private readonly pages = new Map<string, { html: string; contentHash: string }>()

  constructor(options: LocalDashboardHostOptions = {}) {
    this.host = options.host ?? '127.0.0.1'
    this.port = options.port ?? 0
    this.storageDir = options.storageDir
  }

  async publish(input: LocalDashboardPublishInput): Promise<LocalDashboardHostResult> {
    await this.ensureServer()
    const route = `/applications/${encodeURIComponent(input.applicationId)}/${encodeURIComponent(input.versionId)}/index.html`
    const html = renderDashboard(input)
    const contentHash = createHash('sha256').update(html).digest('hex')
    this.pages.set(route, { html, contentHash })
    let persistentAddress: string | undefined
    if (this.storageDir) {
      const filePath = path.join(this.storageDir, input.applicationId, input.versionId, 'index.html')
      await mkdir(path.dirname(filePath), { recursive: true })
      await writeFile(filePath, html, 'utf8')
      persistentAddress = pathToFileURL(filePath).href
    }
    return { address: `${this.address}${route}`, contentRef: `http:${route}`, contentHash, ...(persistentAddress ? { persistentAddress } : {}) }
  }

  open(applicationId: string, versionId: string): string | undefined {
    const route = `/applications/${encodeURIComponent(applicationId)}/${encodeURIComponent(versionId)}/index.html`
    return this.pages.has(route) && this.address ? `${this.address}${route}` : undefined
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.address = undefined
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async ensureServer(): Promise<void> {
    if (this.server && this.address) return
    const server = createServer((request, response) => {
      const route = request.url?.split('?')[0] ?? '/'
      const page = this.pages.get(route)
      if (!page) { response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); response.end('Not Found'); return }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(page.html)
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.port, this.host, () => resolve()) })
    const address = server.address() as AddressInfo
    this.server = server
    this.address = `http://${this.host}:${address.port}`
  }
}
