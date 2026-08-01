import type {
  ChannelEvent,
  ClientCommand,
  RuntimeSnapshot,
} from '#protocol/runtime-protocol'

export type LoopEventListener = (event: ChannelEvent) => void

/**
 * Runtime execution contract. Implementations own all domain state and publish
 * authoritative events; transports only validate envelopes and add sequencing.
 */
export abstract class Loop {
  private readonly listeners = new Set<LoopEventListener>()

  onEvent(listener: LoopEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  protected publish(event: ChannelEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  abstract validate(command: ClientCommand): void

  abstract execute(command: ClientCommand, nextSequence: number): void

  abstract getSnapshot(lastSequence: number): RuntimeSnapshot

  close(): void {}
}
