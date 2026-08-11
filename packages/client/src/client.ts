import { CapybaraHttpError } from './errors.js'
import { CapybaraSession } from './session.js'
import type {
  CapybaraClientOptions,
  CreateSessionOptions,
  RunnerAgentInfo,
  RunnerHealth,
  SessionSummary,
} from './types.js'

interface ErrorResponse {
  error?: string
}

function endpointUrl(value: string): URL {
  const normalized = value.endsWith('/') ? value : `${value}/`
  const url = new URL(normalized)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Capybara endpoint must use http or https')
  }
  return url
}

export class CapybaraClient {
  private readonly endpoint: URL
  private readonly fetchImplementation: typeof globalThis.fetch
  private readonly webSocketFactory: (url: string) => WebSocket
  private readonly sessions = new Set<CapybaraSession>()

  constructor(private readonly options: CapybaraClientOptions) {
    this.endpoint = endpointUrl(options.endpoint)
    if (!options.token.trim()) throw new Error('Capybara Runner token must not be empty')
    const fetchImplementation = options.fetch ?? globalThis.fetch
    if (!fetchImplementation) throw new Error('This environment does not provide fetch')
    this.fetchImplementation = fetchImplementation.bind(globalThis)
    this.webSocketFactory = options.webSocketFactory ?? ((url) => {
      if (!globalThis.WebSocket) throw new Error('This environment does not provide WebSocket')
      return new globalThis.WebSocket(url)
    })
  }

  health(): Promise<RunnerHealth> {
    return this.request('v1/health')
  }

  agent(): Promise<RunnerAgentInfo> {
    return this.request('v1/agent')
  }

  async listSessions(): Promise<SessionSummary[]> {
    const response = await this.request<{ items: SessionSummary[] }>('v1/sessions')
    return response.items
  }

  getSession(sessionId: string): Promise<SessionSummary> {
    return this.request(`v1/sessions/${encodeURIComponent(sessionId)}`)
  }

  renameSession(sessionId: string, name: string): Promise<SessionSummary> {
    return this.request(`v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    })
  }

  async createSession(options: CreateSessionOptions = {}): Promise<CapybaraSession> {
    const summary = await this.request<SessionSummary>('v1/sessions', {
      method: 'POST',
      body: JSON.stringify(options.name ? { name: options.name } : {}),
    })
    const session = this.remoteSession(summary)
    if (options.connect ?? true) await session.connect()
    return session
  }

  async connectSession(sessionId: string): Promise<CapybaraSession> {
    const summary = await this.getSession(sessionId)
    const session = this.remoteSession(summary)
    await session.connect()
    return session
  }

  close(): void {
    for (const session of this.sessions) session.disconnect()
    this.sessions.clear()
  }

  private remoteSession(summary: SessionSummary): CapybaraSession {
    const session = new CapybaraSession(
      summary.id,
      summary.name,
      {
        websocketUrl: (sessionId) => this.websocketUrl(sessionId),
        createWebSocket: (url) => this.webSocketFactory(url),
      },
      this.options.reconnect,
      this.options.connectTimeoutMs,
    )
    this.sessions.add(session)
    return session
  }

  private websocketUrl(sessionId: string): string {
    const url = new URL(`v1/sessions/${encodeURIComponent(sessionId)}/events`, this.endpoint)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('access_token', this.options.token)
    return url.toString()
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${this.options.token}`)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    const response = await this.fetchImplementation(new URL(path, this.endpoint), {
      ...init,
      headers,
    })
    const contentType = response.headers.get('content-type') ?? ''
    const body: unknown = contentType.includes('application/json')
      ? await response.json()
      : await response.text()
    if (!response.ok) {
      const message = body && typeof body === 'object' && !Array.isArray(body)
        ? (body as ErrorResponse).error
        : undefined
      throw new CapybaraHttpError(
        response.status,
        message ?? `Capybara Runner request failed with status ${response.status}`,
        body,
      )
    }
    return body as T
  }
}
