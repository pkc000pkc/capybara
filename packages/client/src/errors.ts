import type { ErrorCode, JsonObject } from '@capybara-agent/protocol'

export class CapybaraHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message)
    this.name = 'CapybaraHttpError'
  }
}

export class CapybaraConnectionError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'CapybaraConnectionError'
  }
}

export class CapybaraCommandError extends Error {
  constructor(
    readonly commandId: string | undefined,
    readonly code: ErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly details?: JsonObject,
    readonly currentRevision?: number,
  ) {
    super(message)
    this.name = 'CapybaraCommandError'
  }
}
