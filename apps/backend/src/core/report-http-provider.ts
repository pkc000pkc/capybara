import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { ProviderResult, ReportDownloadResult, ReportProvider, ResearchArtifactInput, ResearchEvidenceInput } from '#core/market-research-service'

export type ReportFetch = (input: string, init?: RequestInit) => Promise<Response>

export type HttpReportProviderOptions = {
  quarantineRoot: string
  projectRoot?: string
  fetchImpl?: ReportFetch
  timeoutMs?: number
  maxBytes?: number
  allowedHosts?: string[]
  allowHttp?: boolean
  now?: () => string
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function blockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.local') || host === '::1') return true
  if (/^(127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true
  return false
}

function validateUrl(value: string, options: HttpReportProviderOptions): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:' && !(options.allowHttp && url.protocol === 'http:')) throw new Error('report URL must use HTTPS')
  if (!url.hostname || blockedHost(url.hostname)) throw new Error('report URL host is not allowed')
  if (options.allowedHosts && options.allowedHosts.length > 0 && !options.allowedHosts.includes(url.hostname)) throw new Error(`report URL host is not in allowlist: ${url.hostname}`)
  return url
}

export class HttpReportProvider implements ReportProvider {
  private readonly fetchImpl: ReportFetch
  private readonly timeoutMs: number
  private readonly maxBytes: number
  private readonly now: () => string
  private readonly options: HttpReportProviderOptions

  constructor(options: HttpReportProviderOptions) {
    this.options = options
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.maxBytes = options.maxBytes ?? 20 * 1024 * 1024
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async downloadReports(input: { ticker: string; reportUrls: string[]; runId: string }): Promise<ProviderResult<ReportDownloadResult>> {
    if (!/^\d{6}$/.test(input.ticker)) return { status: 'failed', error: { code: 'INVALID_TICKER', message: 'ticker must be a six-digit security code', retryable: false } }
    if (input.reportUrls.length === 0) return { status: 'failed', error: { code: 'REPORT_URL_REQUIRED', message: 'reportUrls must contain explicit report URLs', retryable: false } }
    const reports: ReportDownloadResult['reports'] = []
    const artifacts: ResearchArtifactInput[] = []
    const evidence: ResearchEvidenceInput[] = []
    for (const reportUrl of input.reportUrls) {
      let url: URL
      try { url = validateUrl(reportUrl, this.options) } catch (error) {
        return { status: 'failed', error: { code: 'REPORT_URL_REJECTED', message: error instanceof Error ? error.message : String(error), retryable: false } }
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      let response: Response
      let bytes: Uint8Array
      try {
        response = await this.fetchImpl(url.toString(), { method: 'GET', redirect: 'error', signal: controller.signal })
        if (!response.ok) return { status: response.status >= 500 || response.status === 429 ? 'unknown' : 'failed', error: { code: 'REPORT_HTTP', message: `report returned HTTP ${response.status}`, retryable: response.status >= 500 || response.status === 429 } }
        const declared = response.headers.get('content-length')
        if (declared && Number(declared) > this.maxBytes) return { status: 'failed', error: { code: 'REPORT_TOO_LARGE', message: 'report exceeds quarantine size limit', retryable: false } }
        const buffer = await response.arrayBuffer()
        bytes = new Uint8Array(buffer)
        if (bytes.byteLength > this.maxBytes) return { status: 'failed', error: { code: 'REPORT_TOO_LARGE', message: 'report exceeds quarantine size limit', retryable: false } }
      } catch (error) {
        return { status: 'unknown', error: { code: 'REPORT_NETWORK', message: error instanceof Error ? error.message : String(error), retryable: true } }
      } finally {
        clearTimeout(timer)
      }
      const contentHash = sha256(bytes)
      const artifactId = `report-${contentHash.slice(0, 16)}-${randomUUID().slice(0, 8)}`
      await mkdir(this.options.quarantineRoot, { recursive: true })
      const storedPath = path.join(this.options.quarantineRoot, `${artifactId}.bin`)
      await writeFile(storedPath, bytes, { flag: 'wx' })
      reports.push({ title: path.basename(url.pathname) || `${input.ticker}-report`, sourceUrl: url.toString(), artifactId, contentHash })
      artifacts.push({
        kind: 'research-report',
        contentRef: `quarantine:${artifactId}`,
        contentHash,
        status: 'quarantined',
        summary: `Downloaded from explicit URL; awaiting quarantine verification`,
        ...(this.options.projectRoot ? { relativePath: path.relative(this.options.projectRoot, storedPath).replaceAll(path.sep, '/') } : {}),
      })
      evidence.push({ kind: 'research-report', source: 'http-report-provider', locator: url.toString(), summary: `Downloaded report into quarantine (${bytes.byteLength} bytes)`, payload: { sourceUrl: url.toString(), contentHash, capturedAt: this.now(), artifactId } })
    }
    return { status: 'succeeded', value: { ticker: input.ticker, reports }, artifacts, evidence }
  }
}

export function createHttpReportProvider(options: HttpReportProviderOptions): HttpReportProvider {
  return new HttpReportProvider(options)
}
