import type {
  EventPayloadMap,
  EventType,
  RuntimeSnapshot,
  ServerEvent,
} from '@capybara-agent/protocol'

export interface RunnerHealth {
  status: 'healthy'
  protocolVersion: number
  uptimeSeconds: number
}

export interface RunnerAgentInfo {
  name: string
  protocolVersion: number
  capabilities: string[]
}

export interface SessionSummary {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  requestCount: number
  restorable: boolean
  stateBytes: number
}

export interface CreateSessionOptions {
  name?: string
  connect?: boolean
}

export interface ReconnectOptions {
  enabled?: boolean
  maxAttempts?: number
  initialDelayMs?: number
  maxDelayMs?: number
}

export interface CapybaraClientOptions {
  endpoint: string
  token: string
  fetch?: typeof globalThis.fetch
  webSocketFactory?: (url: string) => WebSocket
  reconnect?: ReconnectOptions
  connectTimeoutMs?: number
}

export interface SendMessageOptions {
  autoStart?: boolean
  clientMessageId?: string
}

export interface CommandReceipt {
  commandId: string
  acceptedAt: string
}

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed'

export type ProtocolEvent<TType extends EventType> = Extract<ServerEvent, { type: TType }>
export type ProtocolEventHandler<TType extends EventType> = (
  event: ProtocolEvent<TType>,
) => void
export type AnyProtocolEventHandler = (event: ServerEvent) => void
export type ConnectionHandler = (state: ConnectionState) => void
export type ClientErrorHandler = (error: Error) => void

export interface WaitForEventOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export interface SessionState {
  connection: ConnectionState
  snapshot?: RuntimeSnapshot
  lastEvent?: ServerEvent
}

export type EventPayload<TType extends EventType> = EventPayloadMap[TType]
