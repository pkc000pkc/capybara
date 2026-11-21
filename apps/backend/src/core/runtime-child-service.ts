import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { RuntimeChildStore, terminalChild, type ChildBinding, type ChildRecord, type ChildSpec } from '#core/runtime-child-store'
import type { RuntimeLoopState } from '#core/runtime-loop-state'
import type { RuntimeChildAgentResult, RuntimeLlm } from '#core/runtime-loop'
import type { LlmChatRequest } from '#util/llm'
import { RuntimeModelBudgetError } from '#core/runtime-model-budget'

export interface ChildWorker {
  record: ChildRecord; signal: AbortSignal; checkpoint?: RuntimeLoopState
  assertAuthority(): void
  llm(base: RuntimeLlm): RuntimeLlm
  progress(checkpoint: RuntimeLoopState, waiting?: { question?: string; inputRequestId?: string }): void
  respond(handler: (humanRequestId: string, message: string) => void): void
}
type Active = { lease: string; controller: AbortController; timer?: ReturnType<typeof setTimeout>; respond?: (id: string, message: string) => void }
const activeServices = new Set<string>()
const parent = (record: ChildRecord): ChildBinding => ({ sessionId: record.parentSessionId, taskId: record.parentTaskId, runId: record.parentRunId })

/** One owner per worker attempt; old callbacks can only append late observations. */
export class RuntimeChildService {
  readonly store: RuntimeChildStore
  private readonly owner = randomUUID()
  private readonly active = new Map<string, Active>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly listeners = new Set<(record: ChildRecord) => void>()
  private closed = false
  constructor(private readonly projectDir: string, private readonly runWorker: (worker: ChildWorker) => Promise<RuntimeChildAgentResult>, private readonly changed: (record: ChildRecord) => void,
    private readonly failed: (error: unknown) => void) {
    this.store = new RuntimeChildStore(projectDir); activeServices.add(this.owner)
  }
  private publish(record: ChildRecord): void { this.records.set(record.id, structuredClone(record)); if (this.closed) return; this.changed(record); for (const listener of this.listeners) listener(record) }
  dispatch(binding: ChildBinding, callId: string, spec: ChildSpec, parentStepId?: string): ChildRecord {
    if (this.closed) throw new Error('CHILD_SERVICE_CLOSED')
    const result = this.store.reserve(binding, callId, spec, parentStepId)
    this.publish(result.record)
    if (result.created) this.start(result.record)
    return this.store.load(binding, result.record.id)
  }
  recover(binding: ChildBinding): void {
    for (let record of this.store.list(binding)) {
      if (!terminalChild(record.status) && record.owner && !this.active.has(record.id) && ['running', 'waiting'].includes(record.status)) {
        const service = record.owner.id.split('/')[0]!
        let ownerAlive = activeServices.has(service)
        if (record.owner.pid !== process.pid) {
          try { process.kill(record.owner.pid, 0); ownerAlive = true } catch (error) { ownerAlive = (error as { code?: string }).code === 'EPERM' }
        }
        if (!ownerAlive) record = this.store.suspend(binding, record.id, record.owner.id)
      }
      record = this.store.expire(binding, record.id)
      this.publish(record)
      if (['queued', 'unknown'].includes(record.status) && !this.active.has(record.id)) {
        const checkpoint = this.store.checkpoint(binding, record.id)
        if (record.status === 'queued' || (record.spec.runner === 'local' && (checkpoint || !record.childRunId))) this.start(record, checkpoint)
        else this.armDeadline(record)
      }
    }
  }
  private start(record: ChildRecord, checkpoint?: RuntimeLoopState): void {
    const binding = parent(record), lease = `${this.owner}/${randomUUID()}`
    record = this.store.claim(binding, record.id, lease)
    this.publish(record)
    if (terminalChild(record.status)) return
    const active: Active = { lease, controller: new AbortController() }
    this.active.set(record.id, active)
    this.armDeadline(record)
    // Return the handle to the parent before starting another model request.
    const startTimer = setTimeout(() => {
      if (this.closed || active.controller.signal.aborted) return
      const worker: ChildWorker = {
        record, signal: active.controller.signal, ...(checkpoint ? { checkpoint } : {}),
        assertAuthority: () => { this.store.assertOwner(binding, record.id, lease); if (active.controller.signal.aborted) throw new Error('CHILD_ABORTED') },
        progress: (state, waiting) => {
          if (this.closed || active.controller.signal.aborted) return
          try { this.publish(this.store.progress(binding, record.id, lease, state, waiting)) }
          catch (error) { active.controller.abort(); this.failed(error) }
        },
        respond: handler => { active.respond = handler },
        llm: base => ({ admitsTransportAttempts: base.admitsTransportAttempts, getConfig: () => base.getConfig(), chat: async request => {
          worker.assertAuthority()
          const current = this.store.load(binding, record.id)
          const estimatedInput = Math.ceil(JSON.stringify({ messages: request.messages, tools: request.tools, responseFormat: request.responseFormat }).length / 4)
          const remaining = current.spec.maxTotalTokens - current.chargedTokens
          const maxTokens = Math.min(request.maxTokens ?? 2000, remaining - estimatedInput)
          if (maxTokens < 1) throw new RuntimeModelBudgetError('CHILD_MODEL_BUDGET_EXHAUSTED', 'child has no available output tokens')
          const bounded: LlmChatRequest = { ...request, maxTokens, signal: request.signal ? AbortSignal.any([request.signal, worker.signal]) : worker.signal }
          const reserve = (tokens: number) => {
            worker.assertAuthority()
            try { this.store.reserveModel(binding, record.id, lease, tokens) }
            catch (error) {
              if (error instanceof Error && error.message === 'CHILD_MODEL_BUDGET_EXHAUSTED') {
                throw new RuntimeModelBudgetError('CHILD_MODEL_BUDGET_EXHAUSTED', 'child has reached its attempt or token limit')
              }
              throw error
            }
          }
          if (base.admitsTransportAttempts) {
            bounded.admitAttempt = input => {
              reserve(Math.ceil(input.serializedBody.length / 4) + input.maxOutputTokens)
              return request.admitAttempt?.(input) ?? (() => {})
            }
          } else {
            reserve(estimatedInput + maxTokens)
          }
          if (request.onRetry) Object.defineProperty(bounded, 'onRetry', { value: request.onRetry, enumerable: false })
          if (request.validateResponse) Object.defineProperty(bounded, 'validateResponse', { value: request.validateResponse, enumerable: false })
          const result = await base.chat(bounded)
          worker.assertAuthority()
          return result
        } }),
      }
      void this.runWorker(worker).then(result => this.complete(record, lease, result), error => this.complete(record, lease, { ok: false, error: { code: 'CHILD_WORKER_FAILED', message: error instanceof Error ? error.message : String(error) } }))
    }, 0)
    startTimer.unref()
  }
  private complete(record: ChildRecord, lease: string, result: RuntimeChildAgentResult): void {
    const binding = parent(record)
    // A late result remains auditable even after this parent connection was closed.
    if (this.closed && !fs.existsSync(path.join(this.projectDir, '.capybara/sessions.sqlite'))) return
    const store = this.closed ? new RuntimeChildStore(this.projectDir) : this.store
    try {
      const settled = store.settle(binding, record.id, lease, { ok: result.ok, output: result.output, evidence: result.evidence, error: result.error?.message })
      const active = this.active.get(record.id)
      if (active?.lease === lease) { this.active.delete(record.id); const timer = this.timers.get(record.id); if (timer) clearTimeout(timer); this.timers.delete(record.id) }
      if (!settled.late || settled.record.owner?.id === lease) this.publish(settled.record)
    } catch (error) { if (!this.closed) this.failed(error) }
    finally { if (this.closed) store.close() }
  }
  private armDeadline(record: ChildRecord): void {
    const previous = this.timers.get(record.id); if (previous) clearTimeout(previous)
    if (terminalChild(record.status) || this.closed) return
    const timer = setTimeout(() => {
      if (this.closed) return
      try {
        const expired = this.store.expire(parent(record), record.id)
        if (terminalChild(expired.status)) { this.active.get(record.id)?.controller.abort(); this.publish(expired) }
        else this.armDeadline(expired)
      } catch (error) { this.failed(error) }
    }, Math.max(1, Math.min(Date.parse(record.deadlineAt) - Date.now(), 2147483647)))
    timer.unref(); this.timers.set(record.id, timer)
  }
  async wait(binding: ChildBinding, id: string): Promise<ChildRecord> {
    const current = this.store.load(binding, id)
    if (terminalChild(current.status) || current.status === 'waiting' || current.status === 'unknown') return current
    return new Promise(resolve => {
      const listener = (record: ChildRecord) => { if (record.id === id && (terminalChild(record.status) || ['waiting', 'unknown'].includes(record.status))) { this.listeners.delete(listener); resolve(record) } }
      this.listeners.add(listener)
    })
  }
  cancel(binding: ChildBinding, id: string, reason: string): ChildRecord {
    const record = this.store.cancel(binding, id, reason)
    this.active.get(id)?.controller.abort(); this.publish(record); return record
  }
  respond(binding: ChildBinding, id: string, humanRequestId: string, message: string): void {
    const record = this.store.load(binding, id)
    if (record.status !== 'waiting' || record.inputRequestId !== humanRequestId || !this.active.get(id)?.respond) throw new Error('CHILD_INPUT_BINDING_MISMATCH')
    this.publish(this.store.beginInput(binding, id, humanRequestId))
    this.active.get(id)!.respond!(humanRequestId, message)
  }
  suspend(binding: ChildBinding): void {
    for (const record of this.store.list(binding)) {
      const active = this.active.get(record.id)
      if (!active) continue
      this.publish(this.store.suspend(binding, record.id, active.lease))
      active.controller.abort(); this.active.delete(record.id)
      const timer = this.timers.get(record.id); if (timer) clearTimeout(timer); this.timers.delete(record.id)
    }
  }
  cancelAll(binding: ChildBinding, reason: string): void { for (const record of this.store.list(binding)) if (!terminalChild(record.status)) this.cancel(binding, record.id, reason) }
  close(): void {
    if (this.closed) return
    for (const [id, active] of this.active) {
      const record = this.findActive(id)
      if (record) { try { this.store.suspend(parent(record), id, active.lease) } catch { /* Closed/tombstoned sessions cannot be revived. */ } }
    }
    this.closed = true; activeServices.delete(this.owner)
    for (const active of this.active.values()) active.controller.abort()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear(); this.store.close()
  }
  private records = new Map<string, ChildRecord>()
  private findActive(id: string): ChildRecord | undefined { return this.records.get(id) }
}
