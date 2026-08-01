import { Loop } from '#core/loop'
import { WebSocketChannel } from '#transport/websocket-channel'
import {
  CommandError,
  type ChannelEvent,
  type ClientCommand,
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
  private closed = false

  constructor(
    readonly id: string,
    private readonly loop: Loop,
    private readonly channel: WebSocketChannel,
    private readonly options: AgentSessionOptions,
  ) {
    loop.onEvent((event) => {
      if (this.closed) return
      channel.publish(event)
      options.onChange?.()
    })
    channel.onCommand((command) => this.handle(command))
    channel.onClose(() => this.finish(true))

    channel.publish({
      type: 'session.attached',
      payload: {
        protocolVersion: 1,
        resumeMode: options.resumeMode ?? 'new',
        project: options.project,
        session: options.session,
        serverTime: new Date().toISOString(),
      },
    })
    channel.publish({
      type: 'runtime.snapshot',
      payload: loop.getSnapshot(channel.getNextSequence()),
    })
  }

  shutdown(persist = true, code = 1000, reason = 'session closed'): void {
    this.channel.close(code, reason)
    this.finish(persist)
  }

  private finish(persist: boolean): void {
    if (this.closed) return
    this.closed = true
    this.options.onClose?.(persist)
    this.loop.close()
  }

  private handle(command: ClientCommand): void {
    const previousOutcome = this.outcomes.get(command.id)
    if (previousOutcome) {
      this.channel.publish(previousOutcome)
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
      this.channel.publish(rejected)
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
    this.channel.publish(accepted)

    try {
      this.loop.execute(command, this.channel.getNextSequence())
    } catch (error) {
      this.channel.publish({
        type: 'protocol.error',
        correlationId: command.id,
        payload: {
          code: 'INTERNAL_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }
}
