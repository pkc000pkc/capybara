import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { RuntimeAuxiliaryRunner } from '#core/runtime-auxiliary'
import { RuntimeAuxiliaryStore, type AuxiliaryBudget } from '#core/runtime-auxiliary-store'
import { capabilityHash } from '#core/runtime-capability-projection'
import { clearSessionContexts } from '#core/context-storage-lifecycle'
import type { RuntimeLlm } from '#core/runtime-loop'
import type { LlmChatResponse } from '#util/llm'

const config = () => ({provider:'custom' as const,protocol:'responses' as const,model:'aux-test',baseUrl:'http://127.0.0.1/unused',timeoutMs:1000,maxRetries:0})
const answer = (text='{"suggestion":"核对来源"}'):LlmChatResponse=>({provider:'custom',model:'aux-test',raw:{},text})
function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'capybara-auxiliary-')),runner=new RuntimeAuxiliaryRunner(root)
  const budget:AuxiliaryBudget={maxCalls:3,maxTotalTokens:10000,maxInputTokens:1000,maxOutputTokens:100,timeoutMs:2000}
  const input={operationId:'reflect-model-2',mode:'reflection' as const,binding:{sessionId:'session',taskId:'task',runId:'run',requestId:'model-2',stateRevision:4},snapshotId:'snapshot-1',contextHash:capabilityHash('context'),
    schemaHash:capabilityHash('schema'),promptBindings:[{role:'reflection',version:'test',hash:capabilityHash('prompt')}],request:{model:'aux-test',messages:[{role:'system' as const,content:'只读辅助角色'}],maxTokens:100},inputTokens:10}
  input.inputTokens=Math.ceil(JSON.stringify(input.request).length/4)
  return{root,runner,budget,input,db:()=>new DatabaseSync(path.join(root,'.capybara/sessions.sqlite')),close(){runner.close();fs.rmSync(root,{recursive:true,force:true})}}
}

test('auxiliary reservations are idempotent, scoped, bounded and retained across a new connection',async()=>{
  const f=fixture();let calls=0
  const llm:RuntimeLlm={getConfig:config,chat:async request=>{calls++;assert.equal(request.tools,undefined);return answer()}}
  let reopened:RuntimeAuxiliaryRunner|undefined
  try{
    const first=await f.runner.invoke(f.input,f.budget,llm,value=>value)
    assert.equal(first.status,'succeeded');assert.equal(first.chargedTokens,f.input.inputTokens+100)
    assert.equal(first.modelBinding!.model,'aux-test')
    assert.equal((await f.runner.invoke(f.input,f.budget,llm,value=>value)).id,first.id)
    await assert.rejects(()=>f.runner.invoke({...f.input,snapshotId:'changed'},f.budget,llm,value=>value),/OPERATION_CONFLICT/)
    assert.throws(()=>f.runner.store.get({...f.input.binding,taskId:'other'},first.id),/BINDING_MISMATCH/)
    f.runner.close();reopened=new RuntimeAuxiliaryRunner(f.root)
    await assert.rejects(()=>reopened!.invoke({...f.input,operationId:'next'}, {...f.budget,maxCalls:1},llm,value=>value),/TOTAL_BUDGET_EXCEEDED/)
    await assert.rejects(()=>reopened!.invoke({...f.input,operationId:'oversize'}, {...f.budget,maxInputTokens:f.input.inputTokens-1},llm,value=>value),/INPUT_BUDGET_EXCEEDED/)
    await assert.rejects(()=>reopened!.invoke({...f.input,operationId:'underreported',inputTokens:1},f.budget,llm,value=>value),/RESERVATION_INVALID/)
    assert.equal(calls,1)
  }finally{reopened?.close();f.close()}
})

test('an auxiliary reservation SQL fault prevents the actual model call',async()=>{
  const f=fixture(),db=f.db();let calls=0
  try{
    db.exec("CREATE TRIGGER fail_aux BEFORE INSERT ON runtime_auxiliary_calls BEGIN SELECT RAISE(ABORT,'AUX_RESERVATION_FAULT'); END")
    await assert.rejects(()=>f.runner.invoke(f.input,f.budget,{getConfig:config,chat:async()=>{calls++;return answer()}},v=>v),/AUX_RESERVATION_FAULT/)
    assert.equal(calls,0);assert.equal(f.runner.store.list(f.input.binding).length,0)
  }finally{db.close();f.close()}
})

test('tool intent and malformed JSON produce failed auxiliary sources rather than accepted guidance',async()=>{
  const f=fixture()
  try{
    const malformed=await f.runner.invoke(f.input,f.budget,{getConfig:config,chat:async()=>answer('```json\n{}\n```')},v=>v)
    assert.equal(malformed.status,'failed');assert.equal(malformed.response!.text,'```json\n{}\n```')
    const consumed=f.runner.store.consume(f.input.binding,malformed.id,malformed.resultHash,f.input.contextHash)
    assert.equal(consumed.consumption!.decision,'failed')
    const tools=await f.runner.invoke({...f.input,operationId:'tool-intent'},f.budget,{getConfig:config,chat:async()=>({...answer(),toolCalls:[{id:'forged',name:'write_file',arguments:{}}]})},v=>v)
    assert.equal(tools.status,'failed');assert.match(tools.error!,/TOOL_INTENT_FORBIDDEN/)
    assert.equal(tools.response!.toolCalls![0]!.name,'write_file')
  }finally{f.close()}
})

test('auxiliary result consumption checks the current snapshot and cannot rewrite an issued receipt',async()=>{
  const f=fixture()
  try{
    const result=await f.runner.invoke(f.input,f.budget,{getConfig:config,chat:async()=>answer()},v=>v)
    assert.throws(()=>f.runner.store.consume(f.input.binding,result.id,'forged',f.input.contextHash),/HASH_MISMATCH/)
    const stale=f.runner.store.consume(f.input.binding,result.id,result.resultHash,capabilityHash('new-context'),'original')
    assert.equal(stale.consumption!.decision,'stale')
    assert.deepEqual(f.runner.store.consume(f.input.binding,result.id,result.resultHash,f.input.contextHash,'replacement').consumption,stale.consumption)
  }finally{f.close()}
})

test('timeout keeps the auxiliary reservation and late output cannot change its unknown outcome',async()=>{
  const f=fixture();let resolve!: (response:LlmChatResponse)=>void,calls=0
  try{
    const unknown=await f.runner.invoke(f.input,{...f.budget,timeoutMs:100},{getConfig:config,chat:async()=>{calls++;return new Promise(r=>{resolve=r})}},v=>v)
    assert.equal(unknown.status,'unknown')
    resolve(answer());await delay(30)
    assert.equal(f.runner.store.get(f.input.binding,unknown.id).status,'unknown')
    assert.equal((await f.runner.invoke(f.input,{...f.budget,timeoutMs:100},{getConfig:config,chat:async()=>{calls++;return answer()}},v=>v)).status,'unknown')
    assert.equal(calls,1)
    const db=f.db();try{assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runtime_auxiliary_events WHERE event='late_response'").get() as {n:number}).n,1)}finally{db.close()}
  }finally{f.close()}
})

test('closing an auxiliary owner preserves unknown across reopen and audits the old callback',async()=>{
  const f=fixture();let resolve!:(response:LlmChatResponse)=>void,started!:()=>void
  const actual=new Promise<void>(r=>{started=r})
  let reopened:RuntimeAuxiliaryRunner|undefined
  try{
    const pending=f.runner.invoke(f.input,f.budget,{getConfig:config,chat:async()=>{started();return new Promise(r=>{resolve=r})}},v=>v)
    const rejected=assert.rejects(pending,/ABORTED/)
    await actual;f.runner.close();await rejected
    reopened=new RuntimeAuxiliaryRunner(f.root)
    const record=await reopened.invoke(f.input,f.budget,{getConfig:config,chat:async()=>{throw new Error('must not replay')}},v=>v)
    assert.equal(record.status,'unknown');assert.equal(record.chargedTokens,f.input.inputTokens+100)
    resolve(answer());await delay(30)
    assert.equal(reopened.store.get(f.input.binding,record.id).status,'unknown')
  }finally{reopened?.close();f.close()}
})

test('settlement faults retain an uncommitted response audit and cannot manufacture auxiliary success',async()=>{
  const f=fixture(),db=f.db()
  try{
    db.exec("CREATE TRIGGER fail_aux_settle BEFORE UPDATE ON runtime_auxiliary_calls BEGIN SELECT RAISE(ABORT,'AUX_SETTLEMENT_FAULT'); END")
    await assert.rejects(()=>f.runner.invoke(f.input,f.budget,{getConfig:config,chat:async()=>answer()},v=>v),/AUX_SETTLEMENT_FAULT/)
    const record=f.runner.store.find(f.input.binding,f.input.operationId)!
    assert.equal(record.status,'running');assert.equal(record.output,undefined)
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runtime_auxiliary_events WHERE event='uncommitted_response'").get() as {n:number}).n,1)
  }finally{db.exec('DROP TRIGGER fail_aux_settle');db.close();f.close()}
})

test('session clearing removes auxiliary calls and events and rejects stale connections',async()=>{
  const f=fixture(),db=f.db()
  try{
    await f.runner.invoke(f.input,f.budget,{getConfig:config,chat:async()=>answer()},v=>v)
    db.exec('BEGIN IMMEDIATE');clearSessionContexts(db);db.exec('COMMIT')
    for(const table of ['runtime_auxiliary_calls','runtime_auxiliary_events'])assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n:number}).n,0)
    await assert.rejects(()=>f.runner.invoke({...f.input,operationId:'revive'},f.budget,{getConfig:config,chat:async()=>answer()},v=>v),/CONTEXT_SESSION_CLEARED/)
  }finally{db.close();f.close()}
})

test('closing from the reservation event stops dispatch and leaves a durable unknown call',async()=>{
  const f=fixture();let calls=0,reopened:RuntimeAuxiliaryRunner|undefined
  try{
    await assert.rejects(()=>f.runner.invoke(f.input,f.budget,{getConfig:config,chat:async()=>{calls++;return answer()}},v=>v,undefined,undefined,()=>f.runner.close()),/AUXILIARY_ABORTED/)
    reopened=new RuntimeAuxiliaryRunner(f.root)
    assert.equal(reopened.store.find(f.input.binding,f.input.operationId)!.status,'unknown');assert.equal(calls,0)
  }finally{reopened?.close();f.close()}
})
