import type {
  RuntimeChildSession,
  RuntimeChildrenState,
  RuntimeProcessRecord,
  RuntimeProcessesState,
  RuntimeChildStatus,
  RuntimeProcessStatus,
} from '#protocol/runtime-protocol'

export type { RuntimeChildSession, RuntimeChildrenState, RuntimeProcessRecord, RuntimeProcessesState, RuntimeChildStatus, RuntimeProcessStatus }

function clone<T>(value: T): T { return structuredClone(value) }

export class RuntimeActivityState {
  private childrenState: RuntimeChildrenState = { revision: 0, items: [] }
  private processesState: RuntimeProcessesState = { revision: 0, items: [] }

  upsertChild(child: RuntimeChildSession): RuntimeChildSession {
    const items = this.childrenState.items.filter((item) => item.id !== child.id)
    items.push(clone(child))
    this.childrenState = { revision: this.childrenState.revision + 1, items }
    return clone(child)
  }

  updateChild(id: string, status: RuntimeChildStatus, patch: Partial<RuntimeChildSession> = {}): RuntimeChildSession {
    const current = this.childrenState.items.find((item) => item.id === id)
    if (!current) throw new Error(`child session not found: ${id}`)
    return this.upsertChild({ ...current, ...clone(patch), id, status })
  }

  upsertProcess(process: RuntimeProcessRecord): RuntimeProcessRecord {
    const items = this.processesState.items.filter((item) => item.id !== process.id)
    items.push(clone(process))
    this.processesState = { revision: this.processesState.revision + 1, items }
    return clone(process)
  }

  updateProcess(id: string, status: RuntimeProcessStatus, patch: Partial<RuntimeProcessRecord> = {}): RuntimeProcessRecord {
    const current = this.processesState.items.find((item) => item.id === id)
    if (!current) throw new Error(`process not found: ${id}`)
    return this.upsertProcess({ ...current, ...clone(patch), id, status })
  }

  snapshot(): { children: RuntimeChildrenState; processes: RuntimeProcessesState } {
    return { children: clone(this.childrenState), processes: clone(this.processesState) }
  }

  restore(state: { children: RuntimeChildrenState; processes: RuntimeProcessesState }): void {
    this.childrenState = clone(state.children)
    this.processesState = clone(state.processes)
  }
}
