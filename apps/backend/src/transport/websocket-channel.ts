import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'

import {
  CommandError,
  parseClientCommand,
  type ChannelEvent,
  type ClientCommand,
  type ServerEvent,
} from '#protocol/runtime-protocol'

export type CommandHandler = (command: ClientCommand) => void | Promise<void>

export class WebSocketChannel {
  private sequence = 0
  private handler?: CommandHandler
  private incoming = Promise.resolve()

  constructor(
    private readonly socket: WebSocket,
    readonly sessionId: string,
  ) {
    socket.on('message', (data) => {
      // Parsing and command admission stay ordered; long loop work is detached.
      this.incoming = this.incoming.then(() => this.dispatch(data.toString()))
    })
  }

  onCommand(handler: CommandHandler): void {
    this.handler = handler
  }

  onClose(handler: () => void): void {
    this.socket.once('close', handler)
  }

  publish(event: ChannelEvent): ServerEvent | undefined {
    if (this.socket.readyState !== WebSocket.OPEN) return

    const message = {
      version: 1,
      kind: 'event',
      id: randomUUID(),
      sessionId: this.sessionId,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      ...event,
    } as ServerEvent
    this.socket.send(JSON.stringify(message))
    return message
  }

  getNextSequence(): number {
    return this.sequence + 1
  }

  close(code = 1000, reason = 'normal closure'): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close(code, reason)
  }

  private async dispatch(raw: string): Promise<void> {
    let decoded: unknown
    try {
      decoded = JSON.parse(raw)
    } catch {
      this.publish({
        type: 'protocol.error',
        payload: { code: 'INVALID_JSON', message: 'frame must contain valid JSON' },
      })
      return
    }

    try {
      const command = parseClientCommand(decoded, this.sessionId)
      await this.handler?.(command)
    } catch (error) {
      if (error instanceof CommandError && error.options.commandId) {
        this.publish({
          type: 'command.rejected',
          correlationId: error.options.commandId,
          payload: {
            commandId: error.options.commandId,
            code: error.code,
            message: error.message,
            retryable: error.options.retryable ?? false,
            details: error.options.details,
            currentRevision: error.options.currentRevision,
          },
        })
        return
      }
      this.publish({
        type: 'protocol.error',
        payload: {
          code: error instanceof CommandError ? error.code : 'INVALID_MESSAGE',
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }
}
