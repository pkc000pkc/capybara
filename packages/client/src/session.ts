import type {
  ChatContent,
  CommandPayloadMap,
  CommandType,
  EventType,
  RuntimeSnapshot,
  ServerEvent,
} from '@capybara-agent/protocol'

import { CapybaraCommandError, CapybaraConnectionError } from './errors.js'
import type {
  AnyProtocolEventHandler,
  ClientErrorHandler,
  CommandReceipt,
  ConnectionHandler,
  ConnectionState,
  ProtocolEvent,
  ProtocolEventHandler,
  ReconnectOptions,
  SendMessageOptions,
  SessionState,
  WaitForEventOptions,
} from './types.js'

interface SessionTransport {
  websocketUrl(sessionId: string): string
  createWebSocket(url: string): WebSocket
}

interface PendingCommand {
  resolve: (receipt: CommandReceipt) => void
  reject: (error: Error) => void
}

interface ConnectWaiter {
  resolve: (session: CapybaraSession) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const OPEN = 1

function id(prefix: string): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.()
    if (uuid) return `${prefix}-${uuid}`
  } catch {
    // Non-secure browser contexts may expose crypto without randomUUID access.
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function decodedEvent(data: unknown, sessionId: string): ServerEvent {
  if (typeof data !== 'string') {
    throw new CapybaraConnectionError('Runner WebSocket frames must contain text JSON')
  }
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch (error) {
    throw new CapybaraConnectionError('Runner returned invalid JSON', error)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CapybaraConnectionError('Runner event must be a JSON object')
  }
  const event = value as Record<string, unknown>
  if (
    event.version !== 1
    || event.kind !== 'event'
    || typeof event.id !== 'string'
    || typeof event.type !== 'string'
    || event.sessionId !== sessionId
    || !Number.isInteger(event.sequence)
    || typeof event.timestamp !== 'string'
    || !('payload' in event)
  ) {
    throw new CapybaraConnectionError('Runner returned an invalid protocol event')
  }
  return value as ServerEvent
}

export class CapybaraSession {
  private socket?: WebSocket
  private connectionState: ConnectionState = 'idle'
  private currentSnapshot?: RuntimeSnapshot
  private lastProtocolEvent?: ServerEvent
  private manualClose = false
  private reconnectAttempt = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private connectWaiter?: ConnectWaiter
  private connectPromise?: Promise<this>
  private readonly pendingCommands = new Map<string, PendingCommand>()
  private readonly eventHandlers = new Map<EventType, Set<(event: never) => void>>()
  private readonly anyEventHandlers = new Set<AnyProtocolEventHandler>()
  private readonly connectionHandlers = new Set<ConnectionHandler>()
  private readonly errorHandlers = new Set<ClientErrorHandler>()
  private readonly reconnect: Required<ReconnectOptions>

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly transport: SessionTransport,
    reconnect: ReconnectOptions = {},
    private readonly connectTimeoutMs = 10_000,
  ) {
    this.reconnect = {
      enabled: reconnect.enabled ?? true,
      maxAttempts: reconnect.maxAttempts ?? 5,
      initialDelayMs: reconnect.initialDelayMs ?? 250,
      maxDelayMs: reconnect.maxDelayMs ?? 5_000,
    }
  }

  get state(): SessionState {
    return {
      connection: this.connectionState,
      snapshot: this.currentSnapshot,
      lastEvent: this.lastProtocolEvent,
    }
  }

  get snapshot(): RuntimeSnapshot | undefined {
    return this.currentSnapshot
  }

  async connect(): Promise<this> {
    if (this.connectionState === 'open' && this.currentSnapshot) return this
    if (this.connectPromise) return this.connectPromise

    this.manualClose = false
    const reconnecting = this.connectionState === 'reconnecting'
    if (!reconnecting) this.setConnectionState('connecting')
    const promise = new Promise<this>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new CapybaraConnectionError('Timed out connecting to the Capybara Runner')
        this.manualClose = true
        this.socket?.close(1000, 'connection timeout')
        this.setConnectionState('closed')
        this.rejectConnect(error)
      }, this.connectTimeoutMs)
      this.connectWaiter = {
        resolve: (session) => resolve(session as this),
        reject,
        timeout,
      }
    })
    this.connectPromise = promise
    if (!reconnecting) this.openSocket()
    return promise
  }

  disconnect(code = 1000, reason = 'client disconnected'): void {
    this.manualClose = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.rejectPending(new CapybaraConnectionError(reason))
    this.rejectConnect(new CapybaraConnectionError(reason))
    const socket = this.socket
    this.socket = undefined
    if (socket && socket.readyState < 2) socket.close(code, reason)
    this.setConnectionState('closed')
  }

  on<TType extends EventType>(
    type: TType,
    handler: ProtocolEventHandler<TType>,
  ): () => void {
    const handlers = this.eventHandlers.get(type) ?? new Set<(event: never) => void>()
    handlers.add(handler as (event: never) => void)
    this.eventHandlers.set(type, handlers)
    return () => handlers.delete(handler as (event: never) => void)
  }

  onEvent(handler: AnyProtocolEventHandler): () => void {
    this.anyEventHandlers.add(handler)
    return () => this.anyEventHandlers.delete(handler)
  }

  onConnection(handler: ConnectionHandler): () => void {
    this.connectionHandlers.add(handler)
    return () => this.connectionHandlers.delete(handler)
  }

  onError(handler: ClientErrorHandler): () => void {
    this.errorHandlers.add(handler)
    return () => this.errorHandlers.delete(handler)
  }

  waitFor<TType extends EventType>(
    type: TType,
    predicate: (event: ProtocolEvent<TType>) => boolean = () => true,
    options: WaitForEventOptions = {},
  ): Promise<ProtocolEvent<TType>> {
    return new Promise((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        off()
        if (timeout) clearTimeout(timeout)
        options.signal?.removeEventListener('abort', aborted)
      }
      const off = this.on(type, (event) => {
        if (!predicate(event)) return
        cleanup()
        resolve(event)
      })
      const aborted = () => {
        cleanup()
        reject(options.signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'))
      }
      if (options.signal?.aborted) {
        aborted()
        return
      }
      options.signal?.addEventListener('abort', aborted, { once: true })
      timeout = setTimeout(() => {
        cleanup()
        reject(new CapybaraConnectionError(`Timed out waiting for ${type}`))
      }, options.timeoutMs ?? 30_000)
    })
  }

  send<TType extends CommandType>(
    type: TType,
    payload: CommandPayloadMap[TType],
    options: { commandId?: string; runId?: string } = {},
  ): Promise<CommandReceipt> {
    if (!this.socket || this.socket.readyState !== OPEN || this.connectionState !== 'open') {
      return Promise.reject(new CapybaraConnectionError('Capybara Session is not connected'))
    }
    const commandId = options.commandId ?? id('command')
    const command = {
      version: 1,
      kind: 'command',
      id: commandId,
      type,
      sessionId: this.id,
      ...(options.runId ? { runId: options.runId } : {}),
      timestamp: new Date().toISOString(),
      payload,
    }
    return new Promise<CommandReceipt>((resolve, reject) => {
      this.pendingCommands.set(commandId, { resolve, reject })
      try {
        this.socket?.send(JSON.stringify(command))
      } catch (error) {
        this.pendingCommands.delete(commandId)
        reject(new CapybaraConnectionError('Failed to send the Runner command', error))
      }
    })
  }

  async sendMessage(
    content: string | ChatContent[],
    options: SendMessageOptions = {},
  ): Promise<CommandReceipt & { clientMessageId: string }> {
    const clientMessageId = options.clientMessageId ?? id('message')
    const receipt = await this.send('chat.message.send', {
      clientMessageId,
      content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
      autoStart: options.autoStart ?? true,
    })
    return { ...receipt, clientMessageId }
  }

  cancel(reason?: string): Promise<CommandReceipt> {
    return this.send('run.cancel', reason ? { reason } : {})
  }

  requestSnapshot(): Promise<CommandReceipt> {
    return this.send('runtime.snapshot.get', {
      ...(this.lastProtocolEvent ? { afterSequence: this.lastProtocolEvent.sequence } : {}),
    })
  }

  private openSocket(): void {
    let socket: WebSocket
    try {
      socket = this.transport.createWebSocket(this.transport.websocketUrl(this.id))
    } catch (error) {
      this.failConnection(new CapybaraConnectionError('Failed to create the Runner WebSocket', error))
      return
    }
    this.socket = socket
    let attached = false
    let snapshotted = false

    socket.addEventListener('message', (message) => {
      try {
        const event = decodedEvent(message.data, this.id)
        this.lastProtocolEvent = event
        if (event.type === 'session.attached') attached = true
        if (event.type === 'runtime.snapshot') {
          this.currentSnapshot = event.payload
          snapshotted = true
        }
        this.handleCommandOutcome(event)
        this.publish(event)
        if (attached && snapshotted) {
          this.reconnectAttempt = 0
          this.setConnectionState('open')
          this.resolveConnect()
        }
      } catch (error) {
        this.publishError(error instanceof Error ? error : new CapybaraConnectionError(String(error)))
        socket.close(1002, 'invalid Runner event')
      }
    })
    socket.addEventListener('error', () => {
      this.publishError(new CapybaraConnectionError('Capybara Runner WebSocket error'))
    })
    socket.addEventListener('close', (event) => {
      if (this.socket === socket) this.socket = undefined
      this.rejectPending(new CapybaraConnectionError(
        `Capybara Runner connection closed (${event.code}${event.reason ? `: ${event.reason}` : ''})`,
      ))
      if (this.manualClose) {
        this.setConnectionState('closed')
        return
      }
      this.scheduleReconnect(event.code, event.reason)
    })
  }

  private scheduleReconnect(code: number, reason: string): void {
    if (!this.reconnect.enabled || this.reconnectAttempt >= this.reconnect.maxAttempts) {
      this.failConnection(new CapybaraConnectionError(
        `Capybara Runner connection closed (${code}${reason ? `: ${reason}` : ''})`,
      ))
      return
    }
    const delay = Math.min(
      this.reconnect.initialDelayMs * 2 ** this.reconnectAttempt,
      this.reconnect.maxDelayMs,
    )
    this.reconnectAttempt += 1
    this.setConnectionState('reconnecting')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.openSocket()
    }, delay)
  }

  private handleCommandOutcome(event: ServerEvent): void {
    if (event.type === 'command.accepted') {
      const pending = this.pendingCommands.get(event.payload.commandId)
      if (!pending) return
      this.pendingCommands.delete(event.payload.commandId)
      pending.resolve({
        commandId: event.payload.commandId,
        acceptedAt: event.payload.acceptedAt,
      })
      return
    }
    if (event.type !== 'command.rejected') return
    const commandId = event.payload.commandId
    const pending = commandId ? this.pendingCommands.get(commandId) : undefined
    if (!pending) return
    this.pendingCommands.delete(commandId as string)
    pending.reject(new CapybaraCommandError(
      commandId,
      event.payload.code,
      event.payload.message,
      event.payload.retryable,
      event.payload.details,
      event.payload.currentRevision,
    ))
  }

  private publish(event: ServerEvent): void {
    const handlers = this.eventHandlers.get(event.type)
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event as never)
        } catch (error) {
          this.publishError(new CapybaraConnectionError('Protocol event handler failed', error))
        }
      }
    }
    for (const handler of this.anyEventHandlers) {
      try {
        handler(event)
      } catch (error) {
        this.publishError(new CapybaraConnectionError('Protocol event handler failed', error))
      }
    }
  }

  private setConnectionState(state: ConnectionState): void {
    if (state === this.connectionState) return
    this.connectionState = state
    for (const handler of this.connectionHandlers) {
      try {
        handler(state)
      } catch (error) {
        this.publishError(new CapybaraConnectionError('Connection handler failed', error))
      }
    }
  }

  private resolveConnect(): void {
    const waiter = this.connectWaiter
    if (!waiter) return
    this.connectWaiter = undefined
    this.connectPromise = undefined
    clearTimeout(waiter.timeout)
    waiter.resolve(this)
  }

  private rejectConnect(error: Error): void {
    const waiter = this.connectWaiter
    if (!waiter) return
    this.connectWaiter = undefined
    this.connectPromise = undefined
    clearTimeout(waiter.timeout)
    waiter.reject(error)
  }

  private failConnection(error: Error): void {
    this.rejectConnect(error)
    this.setConnectionState('closed')
    this.publishError(error)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingCommands.values()) pending.reject(error)
    this.pendingCommands.clear()
  }

  private publishError(error: Error): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(error)
      } catch {
        // Consumer error handlers must not alter the transport lifecycle.
      }
    }
  }
}
