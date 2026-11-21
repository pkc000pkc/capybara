import type { RuntimeChildSession, RuntimeProcessRecord, TimelineStep } from '@capybara-agent/protocol'
import type { WorkbenchRuntimeEvent } from './workbench-runtime'

export type TraceEvent = WorkbenchRuntimeEvent & { id: string; timestamp?: string; turnId?: string; stepId?: string }
export type ActivityRow = {
  id: string; turnId?: string; stepId?: string; kind: 'model' | 'tool' | 'child'; label: string;
  status: string; startedAt?: string; completedAt?: string; durationMs?: number;
  summary?: string; text?: string; callId?: string; arguments?: unknown; result?: unknown;
  receipt?: unknown;
  reasoningSummary?: string;
  parentTurnId?: string;
  error?: unknown; artifactId?: string; hash?: string; consumedByStepId?: string;
  fileChanges?: unknown;
}

export function activityRows(trace: TraceEvent[], fallbackSteps: TimelineStep[] = []): ActivityRow[] {
  const rows = new Map<string, ActivityRow>()
  const ensure = (id: string, value: Partial<ActivityRow>) => {
    const row = rows.get(id) || { id, kind: 'model', label: '模型', status: 'running' }
    rows.set(id, { ...row, ...value })
    return rows.get(id)!
  }
  for (const step of fallbackSteps) ensure(step.id, { kind: step.type === 'tool' ? 'tool' : 'model', stepId: step.id, label: step.summary, status: step.status, startedAt: step.startedAt, completedAt: step.completedAt, durationMs: step.durationMs })
  for (const event of trace) {
    const p = (event.payload || {}) as Record<string, unknown>
    const key = event.stepId || `${event.turnId || 'session'}:preparing`
    if (event.type === 'timeline.step.upserted') {
      const step = p.step as TimelineStep
      ensure(step.id, { kind: step.type === 'tool' ? 'tool' : 'model', turnId: event.turnId, parentTurnId: event.parentTurnId, stepId: step.id, label: step.summary, status: step.status, startedAt: step.startedAt, completedAt: step.completedAt, durationMs: step.durationMs, ...(step.detail?.error ? { error: step.detail.error } : {}) })
    }
    if (event.type === 'chat.assistant.delta' && ['thinkingSummary', 'commentary'].includes(String(p.channel))) {
      const row = ensure(key, { turnId: event.turnId, stepId: event.stepId })
      if (p.channel === 'commentary') row.text = (row.text || '') + String(p.delta || '')
      else if (p.source === 'model') row.reasoningSummary = (row.reasoningSummary || '') + String(p.delta || '')
      else row.summary = String(p.delta || '')
    }
    if (event.type.startsWith('tool.call.')) {
      const id = `${event.turnId || ''}:${String(p.callId)}`
      const prior = [...rows.values()].find((row) => row.callId === p.callId && row.turnId === event.turnId)
      ensure(prior?.id || event.stepId || id, {
        kind: 'tool', turnId: event.turnId, parentTurnId: event.parentTurnId, stepId: event.stepId, callId: String(p.callId), label: String(p.toolName),
        status: event.type.endsWith('started') ? 'running' : event.type.endsWith('failed') ? 'error' : 'success',
        ...(p.arguments !== undefined ? { arguments: p.arguments } : {}),
        ...(p.result !== undefined ? { result: p.result } : {}),
        ...(p.receipt !== undefined ? { receipt: p.receipt } : {}),
        ...(p.message ? { error: { code: p.code, message: p.message, details: p.details } } : {}),
        startedAt: String(p.startedAt || event.timestamp || ''),
        ...(p.completedAt ? { completedAt: String(p.completedAt), durationMs: Number(p.durationMs) } : {}),
      })
    }
    if (event.type === 'runtime.observation.upserted') {
      const observation = p.observation as { callId: string; runId: string; resultArtifactId?: string; consumedByStepId?: string }
      const row = [...rows.values()].find((item) => item.callId === observation.callId && item.turnId === observation.runId)
      if (row) { row.artifactId = observation.resultArtifactId; row.consumedByStepId = observation.consumedByStepId }
    }
    if (event.type === 'runtime.artifact.created') {
      const artifact = p.artifact as { id: string; stepId?: string; hash: string }
      const row = [...rows.values()].find((item) => item.stepId === artifact.stepId)
      if (row) { row.hash = artifact.hash; row.artifactId = artifact.id }
    }
    if (event.type === 'runtime.artifact.content') {
      const value = p.value as { fileChanges?: unknown } | undefined
      const artifact = p.artifact as { stepId?: string }
      const row = [...rows.values()].find((item) => item.stepId === artifact.stepId)
      if (row && value?.fileChanges) row.fileChanges = value.fileChanges
    }
  }
  return [...rows.values()]
}

export type ActivitySnapshot = {
  trace?: TraceEvent[]; timeline?: { steps?: TimelineStep[] }; processes?: { items?: RuntimeProcessRecord[] }; children?: { items?: RuntimeChildSession[] }
}

export function readableValue(value: unknown, limit = 12000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) || ''
  return text.length > limit ? `${text.slice(0, limit)}\n…（界面预览已截断，完整结果保存在项目 Trace 中）` : text
}

export function activityTime(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function activityStatus(value: string): string {
  return ({ running: '运行中', pending: '等待中', success: '已完成', succeeded: '已完成', error: '失败', failed: '失败', interrupted: '已中断', cancelled: '已取消', unknown: '结果未知', stopped: '已停止' } as Record<string, string>)[value] || value
}
