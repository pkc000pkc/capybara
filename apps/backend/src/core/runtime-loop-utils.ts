import { CommandError } from '#protocol/runtime-protocol'
import type {
  JsonObject,
  JsonPatchOperation,
  JsonValue,
  RuntimeCache,
  RuntimeVariables,
} from '#protocol/runtime-protocol'
import type { LlmMessage, LlmToolCall } from '#util/llm'

/** Clone runtime values at the state boundary so callers cannot mutate snapshots. */
export function clone<T>(value: T): T {
  return structuredClone(value)
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue
}

/** Return leaf paths changed between two runtime variable snapshots. */
export function changedVariablePaths(
  before: JsonValue,
  after: JsonValue,
  prefix = '',
  changed = new Set<string>(),
): Set<string> {
  if (JSON.stringify(before) === JSON.stringify(after)) return changed
  if (isObject(before) && isObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      changedVariablePaths(
        before[key] ?? null,
        after[key] ?? null,
        prefix ? `${prefix}.${key}` : key,
        changed,
      )
    }
    return changed
  }
  if (prefix) changed.add(prefix)
  return changed
}

export function textDiff(before: string, after: string): JsonObject {
  const left = before.split('\n')
  const right = after.split('\n')
  let prefix = 0
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < left.length - prefix
    && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1
  }
  return {
    startLine: prefix + 1,
    removed: left.slice(prefix, suffix ? -suffix : undefined),
    added: right.slice(prefix, suffix ? -suffix : undefined),
  }
}

export function emptyRuntimeCache(): RuntimeCache {
  return {
    version: 1,
    summary: '',
    messages: [],
    loop: { run_id: '', iteration: 0, tool_round: 0, continuation_round: 0 },
    compression_count: 0,
    compressed_at: '',
  }
}

export function runtimeCacheMessages(value: unknown): LlmMessage[] {
  if (!Array.isArray(value)) throw new Error('builtin.cache.messages must be an array')
  return value.map((item, index) => {
    if (!isObject(item) || !['user', 'assistant', 'tool'].includes(String(item.role))) {
      throw new Error(`builtin.cache.messages[${index}] has an invalid role`)
    }
    if (typeof item.content !== 'string') {
      throw new Error(`builtin.cache.messages[${index}].content must be a string`)
    }
    let toolCalls: LlmToolCall[] | undefined
    if (item.toolCalls !== undefined) {
      if (!Array.isArray(item.toolCalls)) {
        throw new Error(`builtin.cache.messages[${index}].toolCalls must be an array`)
      }
      toolCalls = item.toolCalls.map((call, callIndex) => {
        if (!isObject(call) || typeof call.id !== 'string' || typeof call.name !== 'string') {
          throw new Error(`builtin.cache.messages[${index}].toolCalls[${callIndex}] is invalid`)
        }
        return { id: call.id, name: call.name, arguments: clone(call.arguments ?? null) }
      })
    }
    return {
      role: item.role as LlmMessage['role'],
      content: item.content,
      ...(typeof item.name === 'string' ? { name: item.name } : {}),
      ...(typeof item.toolCallId === 'string' ? { toolCallId: item.toolCallId } : {}),
      ...(toolCalls ? { toolCalls } : {}),
    }
  })
}

export function assertRuntimeCache(value: unknown): asserts value is RuntimeCache {
  if (
    !isObject(value)
    || value.version !== 1
    || typeof value.summary !== 'string'
    || !isObject(value.loop)
    || typeof value.loop.run_id !== 'string'
    || !Number.isInteger(value.loop.iteration)
    || Number(value.loop.iteration) < 0
    || !Number.isInteger(value.loop.tool_round)
    || Number(value.loop.tool_round) < 0
    || !Number.isInteger(value.loop.continuation_round)
    || Number(value.loop.continuation_round) < 0
    || !Number.isInteger(value.compression_count)
    || Number(value.compression_count) < 0
    || typeof value.compressed_at !== 'string'
  ) {
    throw new Error('builtin.cache has an invalid runtime cache shape')
  }
  runtimeCacheMessages(value.messages)
}

export interface ModelOutput {
  status: 'running' | 'completed'
  content: string
}

export function parseModelOutput(text: string): ModelOutput {
  let value: unknown
  try {
    value = JSON.parse(text.trim())
  } catch {
    throw new Error('LLM response must be a JSON object containing status and content')
  }
  if (
    !isObject(value)
    || (value.status !== 'running' && value.status !== 'completed')
    || typeof value.content !== 'string'
  ) {
    throw new Error('LLM response requires status "running" or "completed" and string content')
  }
  if (!value.content.trim()) throw new Error('LLM response content cannot be empty')
  return { status: value.status, content: value.content }
}

function partialJsonStringField(source: string, field: string): string | undefined {
  const match = new RegExp(`"${field}"\\s*:\\s*"`).exec(source)
  if (!match) return undefined
  let value = ''
  let index = match.index + match[0].length
  while (index < source.length) {
    const character = source[index]
    if (character === '"') return value
    if (character !== '\\') {
      value += character
      index += 1
      continue
    }
    if (index + 1 >= source.length) break
    const escape = source[index + 1] as string
    if (escape === 'u') {
      const code = source.slice(index + 2, index + 6)
      if (code.length < 4) break
      if (!/^[0-9a-f]{4}$/i.test(code)) throw new Error('LLM streamed invalid JSON escape')
      value += String.fromCharCode(Number.parseInt(code, 16))
      index += 6
      continue
    }
    const escaped: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    }
    if (!(escape in escaped)) throw new Error('LLM streamed invalid JSON escape')
    value += escaped[escape]
    index += 2
  }
  return value
}

/** Incrementally exposes only completed model content from a JSON stream. */
export class ModelOutputStream {
  private raw = ''
  private status?: ModelOutput['status']
  private content = ''
  private emitted = ''

  constructor(private readonly emit: (delta: string) => void) {}

  push(delta: string): void {
    this.raw += delta
    const status = /"status"\s*:\s*"(running|completed)"/.exec(this.raw)?.[1]
    if (status) this.status = status as ModelOutput['status']
    this.content = partialJsonStringField(this.raw, 'content') ?? this.content
    this.flush()
  }

  finish(output: ModelOutput): void {
    this.status = output.status
    this.content = output.content
    this.flush()
    if (output.status === 'completed' && this.emitted !== output.content) {
      throw new Error('streamed LLM content does not match the completed response')
    }
  }

  private flush(): void {
    if (this.status !== 'completed' || this.content === this.emitted) return
    if (!this.content.startsWith(this.emitted)) {
      throw new Error('streamed LLM content changed after it was emitted')
    }
    const delta = this.content.slice(this.emitted.length)
    this.emitted = this.content
    if (delta) this.emit(delta)
  }
}

export function escapePointerToken(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1')
}

export function decodePointer(path: string): string[] {
  if (path === '') return []
  if (!path.startsWith('/')) {
    throw new CommandError('INVALID_PAYLOAD', `invalid JSON pointer: ${path}`)
  }
  return path
    .slice(1)
    .split('/')
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'))
}

export function assertSafeToken(token: string): void {
  if (token === '__proto__' || token === 'prototype' || token === 'constructor') {
    throw new CommandError('INVALID_PAYLOAD', 'unsafe variable path')
  }
}

/** Apply guarded RFC 6902 add/remove/replace operations to a variable snapshot. */
export function applyPatch(
  source: RuntimeVariables,
  operations: JsonPatchOperation[],
): RuntimeVariables {
  const root = clone(source) as unknown as JsonValue

  for (const operation of operations) {
    const tokens = decodePointer(operation.path)
    if (tokens.length === 0) {
      throw new CommandError('INVALID_PAYLOAD', 'the variables root cannot be replaced')
    }
    tokens.forEach(assertSafeToken)
    let parent: JsonValue = root
    for (const token of tokens.slice(0, -1)) {
      if (Array.isArray(parent)) {
        const index = Number.parseInt(token, 10)
        if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
          throw new CommandError('INVALID_PAYLOAD', `variable path not found: ${operation.path}`)
        }
        parent = parent[index] as JsonValue
      } else if (typeof parent === 'object' && parent !== null && token in parent) {
        parent = parent[token] as JsonValue
      } else {
        throw new CommandError('INVALID_PAYLOAD', `variable path not found: ${operation.path}`)
      }
    }

    const finalToken = tokens.at(-1) as string
    if (Array.isArray(parent)) {
      const index = finalToken === '-' ? parent.length : Number.parseInt(finalToken, 10)
      if (!Number.isInteger(index) || index < 0 || index > parent.length) {
        throw new CommandError('INVALID_PAYLOAD', `invalid array index: ${operation.path}`)
      }
      if (operation.op === 'add') {
        parent.splice(index, 0, clone(operation.value))
      } else if (operation.op === 'replace') {
        if (index >= parent.length) {
          throw new CommandError('INVALID_PAYLOAD', `variable path not found: ${operation.path}`)
        }
        parent[index] = clone(operation.value)
      } else {
        if (index >= parent.length) {
          throw new CommandError('INVALID_PAYLOAD', `variable path not found: ${operation.path}`)
        }
        parent.splice(index, 1)
      }
      continue
    }

    if (typeof parent !== 'object' || parent === null) {
      throw new CommandError('INVALID_PAYLOAD', `variable path not found: ${operation.path}`)
    }
    if (operation.op === 'remove') {
      if (!(finalToken in parent)) {
        throw new CommandError('INVALID_PAYLOAD', `variable path not found: ${operation.path}`)
      }
      delete parent[finalToken]
    } else if (operation.op === 'replace') {
      if (!(finalToken in parent)) {
        throw new CommandError('INVALID_PAYLOAD', `variable path not found: ${operation.path}`)
      }
      parent[finalToken] = clone(operation.value)
    } else {
      parent[finalToken] = clone(operation.value)
    }
  }

  return root as RuntimeVariables
}
