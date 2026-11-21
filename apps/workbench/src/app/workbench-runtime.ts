import type { RuntimeSnapshot } from '@capybara-agent/protocol'

export type WorkbenchChatFrame = {
  version: 1
  kind: 'command'
  id: string
  type: 'chat.message.send'
  sessionId: string
  timestamp: string
  payload: {
    clientMessageId: string
    content: [{ type: 'text'; text: string }]
    autoStart: true
    humanRequestId?: string
  }
}

export type WorkbenchRuntimeEvent = {
  version?: number
  kind?: 'event'
  id?: string
  sessionId?: string
  sequence?: number
  timestamp?: string
  turnId?: string
  stepId?: string
  parentTurnId?: string
  type: string
  payload: unknown
}

export type WorkbenchRuntimeCommand = {
  version: 1
  kind: 'command'
  id: string
  type: 'run.pause' | 'run.resume' | 'run.interrupt' | 'run.cancel'
  sessionId: string
  timestamp: string
  payload: Record<string, unknown>
}

export function shouldHandleRuntimeClosed(currentRuntimeId: string | null, closed: { runtimeId: string; code: number; reason: string }): boolean {
  return currentRuntimeId === closed.runtimeId && !(closed.code === 1000 && closed.reason === 'closed')
}

export type WorkbenchTranscriptMessage = {
  id: string
  role: 'user' | 'agent'
  body: string
  time: string
  status: string
  turnId?: string
}

export function pendingBranchQuestions(task: RuntimeSnapshot['taskControl']) {
  return (task?.branchBlocks ?? []).filter(block => block.kind === 'human' || block.evidenceRequest?.sourceKinds.includes('user')).map(block => ({
    id: block.id,
    question: block.reason,
    taskLabels: block.taskIds.map(id => task?.tasks.find(node => node.id === id)?.title ?? id).join('、'),
  }))
}

export function createChatFrame(sessionId: string, text: string, ids: { commandId: string; clientMessageId: string; timestamp?: string; humanRequestId?: string }): WorkbenchChatFrame {
  const value = text.trim()
  if (!sessionId.trim()) throw new Error('runtime session id is required')
  if (!value) throw new Error('chat message cannot be empty')
  return {
    version: 1,
    kind: 'command',
    id: ids.commandId,
    type: 'chat.message.send',
    sessionId,
    timestamp: ids.timestamp ?? new Date().toISOString(),
    payload: {
      clientMessageId: ids.clientMessageId,
      content: [{ type: 'text', text: value }],
      autoStart: true,
      ...(ids.humanRequestId ? { humanRequestId: ids.humanRequestId } : {}),
    },
  }
}

export function createRuntimeCommandFrame(sessionId: string, type: WorkbenchRuntimeCommand['type'], payload: Record<string, unknown> = {}, commandId = crypto.randomUUID()): WorkbenchRuntimeCommand {
  if (!sessionId.trim()) throw new Error('runtime session id is required')
  return {
    version: 1,
    kind: 'command',
    id: commandId,
    type,
    sessionId,
    timestamp: new Date().toISOString(),
    payload,
  }
}

export function parseRuntimeEvent(data: string): WorkbenchRuntimeEvent {
  const value = JSON.parse(data) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('runtime event must be an object')
  const event = value as Record<string, unknown>
  if (typeof event.type !== 'string' || event.type.trim().length === 0) throw new Error('runtime event type is required')
  return value as WorkbenchRuntimeEvent
}

export function chatTextFromEvent(event: WorkbenchRuntimeEvent): string | undefined {
  if (event.type === 'chat.user.created') {
    const message = event.payload as { content?: Array<{ type?: string; text?: string }> } | undefined
    return message?.content?.filter((item) => item.type === 'text').map((item) => item.text ?? '').join('') || undefined
  }
  if (event.type === 'chat.assistant.delta') {
    const payload = event.payload as { channel?: string; delta?: string } | undefined
    return payload?.channel === 'final' ? payload.delta : undefined
  }
  return undefined
}

function messageTime(value: unknown): string {
  if (typeof value !== 'string' || !value) return '已记录'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '已记录'
  return parsed.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function transcriptMessage(value: unknown): WorkbenchTranscriptMessage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const message = value as {
    id?: unknown
    role?: unknown
    status?: unknown
    createdAt?: unknown
    completedAt?: unknown
    requestId?: unknown
    content?: Array<{ type?: unknown; text?: unknown }>
    failure?: { message?: unknown }
  }
  if (typeof message.id !== 'string' || (message.role !== 'user' && message.role !== 'assistant')) return undefined
  const body = Array.isArray(message.content)
    ? message.content.filter((item) => item?.type === 'text').map((item) => typeof item.text === 'string' ? item.text : '').join('')
    : ''
  const failureText = typeof message.failure?.message === 'string' ? message.failure.message : ''
  return {
    id: message.id,
    role: message.role === 'user' ? 'user' : 'agent',
    body: body || failureText || '（无文本内容）',
    time: messageTime(message.completedAt ?? message.createdAt),
    status: typeof message.status === 'string' ? message.status : 'completed',
    ...(typeof message.requestId === 'string' ? { turnId: `turn:${message.requestId}` } : {}),
  }
}

export function transcriptFromSnapshot(event: WorkbenchRuntimeEvent): WorkbenchTranscriptMessage[] {
  if (event.type !== 'runtime.snapshot') return []
  const payload = event.payload as { conversation?: { messages?: unknown[] } } | undefined
  return Array.isArray(payload?.conversation?.messages)
    ? payload.conversation.messages.map(transcriptMessage).filter((item): item is WorkbenchTranscriptMessage => Boolean(item))
    : []
}

export function transcriptMessageFromEvent(event: WorkbenchRuntimeEvent): WorkbenchTranscriptMessage | undefined {
  if (event.type === 'chat.user.created') return transcriptMessage(event.payload)
  if (event.type === 'chat.assistant.started') {
    const payload = event.payload as { message?: unknown } | undefined
    const message = transcriptMessage(payload?.message)
    return message ? { ...message, turnId: event.turnId || message.turnId } : undefined
  }
  if (event.type === 'chat.assistant.completed') {
    const payload = event.payload as { messageId?: string; completedAt?: string }
    return payload?.messageId ? { id: payload.messageId, role: 'agent', body: '', time: messageTime(payload.completedAt), status: 'completed', turnId: event.turnId } : undefined
  }
  if (event.type === 'chat.assistant.failed') {
    const payload = event.payload as { messageId?: unknown; message?: unknown } | undefined
    if (typeof payload?.messageId !== 'string') return undefined
    return { id: payload.messageId, role: 'agent', body: typeof payload.message === 'string' ? payload.message : '本地运行服务返回了未说明的错误。', time: '失败', status: 'failed' }
  }
  return undefined
}
