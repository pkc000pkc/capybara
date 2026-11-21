import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { RuntimeAuxiliaryStore, type AuxiliaryBudget, type AuxiliaryRecord, type AuxiliaryScope } from '#core/runtime-auxiliary-store'
import type { RuntimeLlm } from '#core/runtime-loop'
import type { LlmChatResponse } from '#util/llm'

export const DEFAULT_AUXILIARY_BUDGET: AuxiliaryBudget = { maxCalls:8, maxTotalTokens:60000, maxInputTokens:10000, maxOutputTokens:2048, timeoutMs:30000 }
const activeOwners = new Set<string>()

/** No tools or implicit retries. Unknown calls keep their reservation across reconnection. */
export class RuntimeAuxiliaryRunner {
  readonly store: RuntimeAuxiliaryStore
  private readonly owner = `${process.pid}/${randomUUID()}`
  private readonly active = new Map<string, { scope: AuxiliaryScope; controller: AbortController }>()
  private closed = false
  constructor(private readonly projectDir: string) { this.store = new RuntimeAuxiliaryStore(projectDir);activeOwners.add(this.owner) }
  async invoke(input: Omit<AuxiliaryRecord,'id'|'createdAt'|'status'|'deadlineAt'|'chargedTokens'|'owner'>, budget: AuxiliaryBudget, llm: RuntimeLlm,
    validate: (value: unknown) => unknown, signal?: AbortSignal, onResponse?: (response:LlmChatResponse)=>void, onReserved?:(record:AuxiliaryRecord)=>void): Promise<AuxiliaryRecord> {
    if (this.closed || signal?.aborted) throw new Error('AUXILIARY_ABORTED')
    if(input.inputTokens!==Math.ceil(JSON.stringify(input.request).length/4))throw new Error('AUXILIARY_RESERVATION_INVALID')
    const config=llm.getConfig(),request={...input.request,model:input.request.model??config.model}
    const reservation = this.store.reserve({...input,request,inputTokens:Math.ceil(JSON.stringify(request).length/4),modelBinding:{provider:config.provider,protocol:config.protocol,model:request.model},owner:this.owner},budget)
    let {record} = reservation
    if(!reservation.created){
      return this.recover(record)
    }
    const controller = new AbortController(), combined = signal ? AbortSignal.any([signal,controller.signal]) : controller.signal
    this.active.set(record.id,{scope:record.binding,controller})
    try { onReserved?.(record) } catch(error) {
      if(!this.closed)this.store.suspend(record.binding,record.id,this.owner,'AUXILIARY_PUBLICATION_FAILED')
      controller.abort();this.active.delete(record.id);throw error
    }
    if (this.closed || combined.aborted) {
      if (!this.closed) this.store.suspend(record.binding, record.id, this.owner, 'AUXILIARY_ABORTED_BEFORE_DISPATCH')
      this.active.delete(record.id)
      throw new Error('AUXILIARY_ABORTED')
    }
    const timer = setTimeout(()=>controller.abort(new Error('AUXILIARY_DEADLINE_EXCEEDED')),Math.max(1,Date.parse(record.deadlineAt)-Date.now()))
    let actualResponse: AuxiliaryRecord['response']
    const invocation = Promise.resolve().then(()=>{if(combined.aborted || this.closed)throw new Error('AUXILIARY_ABORTED');this.store.audit(record.binding,record.id,'dispatched',{owner:this.owner});return llm.chat({...record.request,signal:combined})}).then(response=>{
      actualResponse = {text:response.text, ...(response.usage?{usage:response.usage}:{}),model:response.model,provider:response.provider,
        ...(response.toolCalls?{toolCalls:response.toolCalls}:{}),...(response.finishReason?{finishReason:response.finishReason}:{})}
      onResponse?.(response)
      if (combined.aborted || this.closed) { this.auditLate(record,actualResponse); throw new Error('AUXILIARY_ABORTED') }
      if (response.toolCalls?.length) throw new Error('AUXILIARY_TOOL_INTENT_FORBIDDEN')
      return validate(JSON.parse(response.text))
    })
    try {
      const aborted = new Promise<never>((_,reject)=>{
        const stop = ()=>reject(new Error('AUXILIARY_ABORTED'))
        combined.addEventListener('abort',stop,{once:true})
        invocation.finally(()=>combined.removeEventListener('abort',stop)).catch(()=>{})
        if(combined.aborted)stop()
      })
      const output = await Promise.race([invocation,aborted])
      return this.store.settle(record.binding,record.id,this.owner,{output,response:actualResponse})
    } catch(error) {
      if(this.closed) throw error
      const message = error instanceof Error ? error.message : String(error)
      if(combined.aborted) return this.store.suspend(record.binding,record.id,this.owner,combined.reason instanceof Error ? combined.reason.message : message)
      try { return this.store.settle(record.binding,record.id,this.owner,{error:message,response:actualResponse}) }
      catch(settlementError) { try { this.store.audit(record.binding,record.id,'uncommitted_response',{response:actualResponse,error:message}) } catch { /* Tombstones remain authoritative. */ }; throw settlementError }
    } finally { clearTimeout(timer); this.active.delete(record.id) }
  }
  recover(record:AuxiliaryRecord):AuxiliaryRecord {
    if(record.status!=='running')return record
    const pid=Number(record.owner.split('/')[0]);let alive=activeOwners.has(record.owner)
    if(pid!==process.pid && Number.isSafeInteger(pid) && pid>0){try{process.kill(pid,0);alive=true}catch(error){alive=(error as {code?:string}).code==='EPERM'}}
    return !alive || Date.now()>=Date.parse(record.deadlineAt)?this.store.suspend(record.binding,record.id,record.owner,'AUXILIARY_RECOVERED_UNCONFIRMED'):record
  }
  private auditLate(record:AuxiliaryRecord,response:AuxiliaryRecord['response']):void {
    if(this.closed && !fs.existsSync(path.join(this.projectDir,'.capybara/sessions.sqlite'))) return
    const store=this.closed?new RuntimeAuxiliaryStore(this.projectDir):this.store
    try { store.audit(record.binding,record.id,'late_response',response) } catch { /* No result may revive a cleared session. */ }
    finally {if(this.closed)store.close()}
  }
  close():void {
    if(this.closed)return
    for(const [id,active]of this.active){try{this.store.suspend(active.scope,id,this.owner,'AUXILIARY_OWNER_CLOSED')}catch{/* Cleared sessions stay closed. */};active.controller.abort()}
    this.active.clear();this.closed=true;activeOwners.delete(this.owner);this.store.close()
  }
}
