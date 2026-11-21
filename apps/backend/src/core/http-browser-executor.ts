import { createHash } from 'node:crypto'

import type { BrowserExecutor, BrowserExecutionResult } from '#core/browser-gateway-service'

export type HttpBrowserExecutorOptions = {
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
  timeoutMs?: number
  maxBytes?: number
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function titleFromHtml(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ''
  return title.replace(/\s+/g, ' ').trim()
}

function textFromHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function unsupported(actionKind: string): BrowserExecutionResult {
  return {
    status: 'unknown',
    error: {
      code: 'HTTP_BROWSER_ACTION_UNSUPPORTED',
      message: `HTTP browser executor cannot perform ${actionKind}`,
      recovery: 'use a Chromium Browser Gateway executor for interactive actions',
    },
  }
}

/**
 * Read-only browser adapter for public HTML pages. It is deliberately narrow:
 * navigation/read become evidence, while click/input/upload/screenshot remain
 * unknown until a real Chromium host is attached.
 */
export function createHttpBrowserExecutor(options: HttpBrowserExecutorOptions = {}): BrowserExecutor {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 20_000
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024
  return async (request): Promise<BrowserExecutionResult> => {
    if (!['navigate', 'read'].includes(request.action.kind)) return unsupported(request.action.kind)
    const rawUrl = request.action.target.url ?? request.action.arguments.url ?? request.tab.url
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) return { status: 'failed', error: { code: 'HTTP_BROWSER_URL_REQUIRED', message: 'browser read requires a URL' } }
    let url: URL
    try { url = new URL(rawUrl) } catch { return { status: 'failed', error: { code: 'HTTP_BROWSER_URL_INVALID', message: 'browser URL is invalid' } } }
    if (!['http:', 'https:'].includes(url.protocol)) return { status: 'failed', error: { code: 'HTTP_BROWSER_PROTOCOL', message: 'HTTP browser executor only reads http(s) pages' } }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    let html: string
    try {
      // Public research pages commonly redirect from a short or canonical
      // URL. Follow those redirects so a valid source is not reported as a
      // false browser failure; the final URL is preserved in the evidence.
      response = await fetchImpl(url.toString(), { method: 'GET', redirect: 'follow', signal: controller.signal })
      const length = response.headers.get('content-length')
      if (length && Number(length) > maxBytes) return { status: 'failed', error: { code: 'HTTP_BROWSER_TOO_LARGE', message: 'page exceeds read limit' } }
      html = await response.text()
      if (Buffer.byteLength(html, 'utf8') > maxBytes) return { status: 'failed', error: { code: 'HTTP_BROWSER_TOO_LARGE', message: 'page exceeds read limit' } }
    } catch (error) {
      return { status: 'unknown', error: { code: 'HTTP_BROWSER_NETWORK', message: error instanceof Error ? error.message : String(error), recovery: 'verify the page before retrying' } }
    } finally { clearTimeout(timer) }
    if (!response.ok) return { status: response.status >= 500 ? 'unknown' : 'failed', error: { code: 'HTTP_BROWSER_STATUS', message: `page returned HTTP ${response.status}`, recovery: response.status >= 500 ? 'retry after checking the source' : undefined } }
    const title = titleFromHtml(html)
    const text = textFromHtml(html)
    const contentHash = sha256(html)
    return {
      status: 'succeeded',
      result: { url: url.toString(), statusCode: response.status, title, textExcerpt: text.slice(0, 12_000), contentHash },
      evidence: [{ type: 'page-snapshot', status: 'captured', source: { url: url.toString() }, content: { url: url.toString(), statusCode: response.status, title, contentHash, textExcerpt: text.slice(0, 12_000) }, contentHash }],
    }
  }
}
