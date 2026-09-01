import { randomUUID } from 'node:crypto'
import type WebSocket from 'ws'

import { Loop } from '#core/loop'
import { WebSocketChannel } from '#transport/websocket-channel'
import {
  CommandError,
  parseClientCommand,
  type ChannelEvent,
  type ClientCommand,
  type ServerEvent,
} from '#protocol/runtime-protocol'

export interface AgentSessionOptions {
  project: { path: string; name: string }
  session: { id: string; name: string }
  resumeMode?: 'new' | 'replay' | 'snapshot'
  onChange?: () => void
  onClose?: (persist: boolean) => void
}

export class AgentSession {
  private readonly outcomes = new Map<string, ChannelEvent>()
  private readonly observers = new Set<WebSocket>()
  private closed = false

  constructor(
    readonly id: string,
    private readonly loop: Loop,
    private readonly channel: WebSocketChannel,
    private readonly options: AgentSessionOptions,
  ) {
    loop.onEvent((event) => {
      if (this.closed) return
      this.publish(event)
      options.onChange?.()
    })
    channel.onCommand((command) => this.handle(command))
    channel.onClose(() => this.finish(true))

    this.publish({
      type: 'session.attached',
      payload: {
        protocolVersion: 1,
        resumeMode: options.resumeMode ?? 'new',
        project: options.project,
        session: options.session,
        serverTime: new Date().toISOString(),
      },
    })
    this.publish({
      type: 'runtime.snapshot',
      payload: loop.getSnapshot(channel.getNextSequence()),
    })
  }

  shutdown(persist = true, code = 1000, reason = 'session closed'): void {
    this.channel.close(code, reason)
    this.finish(persist)
  }

  attachObserver(
    socket: WebSocket,
    allowedCommands?: ReadonlySet<ClientCommand['type']>,
  ): void {
    if (this.closed) {
      socket.close(1013, 'session is not active')
      return
    }
    this.observers.add(socket)
    const sequence = this.channel.getCurrentSequence()
    const snapshot: ServerEvent = {
      version: 1,
      kind: 'event',
      id: randomUUID(),
      sessionId: this.id,
      sequence,
      timestamp: new Date().toISOString(),
      type: 'runtime.snapshot',
      payload: this.loop.getSnapshot(sequence),
    }
    socket.send(JSON.stringify(snapshot))
    socket.on('message', (data) => {
      try {
        const command = parseClientCommand(JSON.parse(data.toString()) as unknown, this.id)
        if (allowedCommands && !allowedCommands.has(command.type)) {
          socket.close(1008, 'observer connection is read-only')
          return
        }
        this.handle(command)
      } catch (error) {
        socket.close(1008, error instanceof Error ? error.message : String(error))
      }
    })
    socket.once('close', () => this.observers.delete(socket))
  }

  private finish(persist: boolean): void {
    if (this.closed) return
    this.closed = true
    // Observers are passive monitoring clients. The owning Agent connection may
    // be replaced or resumed, so tell them to reconnect instead of treating the
    // close as a permanent, normal shutdown.
    for (const observer of this.observers) observer.close(1012, 'session connection restarting')
    this.observers.clear()
    this.options.onClose?.(persist)
    this.loop.close()
  }

  private handle(command: ClientCommand): void {
    const previousOutcome = this.outcomes.get(command.id)
    if (previousOutcome) {
      this.publish(previousOutcome)
      return
    }

    try {
      this.loop.validate(command)
    } catch (error) {
      const domainError =
        error instanceof CommandError
          ? error
          : new CommandError('INTERNAL_ERROR', 'command validation failed', {
              retryable: true,
            })
      const rejected: ChannelEvent = {
        type: 'command.rejected',
        correlationId: command.id,
        payload: {
          commandId: command.id,
          code: domainError.code,
          message: domainError.message,
          retryable: domainError.options.retryable ?? false,
          details: domainError.options.details,
          currentRevision: domainError.options.currentRevision,
        },
      }
      this.outcomes.set(command.id, rejected)
      this.publish(rejected)
      return
    }

    const accepted: ChannelEvent = {
      type: 'command.accepted',
      correlationId: command.id,
      payload: {
        commandId: command.id,
        acceptedAt: new Date().toISOString(),
      },
    }
    this.outcomes.set(command.id, accepted)
    this.publish(accepted)

    try {
      this.loop.execute(command, this.channel.getNextSequence())
    } catch (error) {
      this.publish({
        type: 'protocol.error',
        correlationId: command.id,
        payload: {
          code: 'INTERNAL_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  private publish(event: ChannelEvent): void {
    const published = this.channel.publish(event)
    if (!published) return
    const encoded = JSON.stringify(published)
    for (const observer of this.observers) {
      if (observer.readyState === observer.OPEN) observer.send(encoded)
    }
  }
}
