import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { RuntimeLoop, type RuntimeLlm, type RuntimeLoopOptions } from '#core/runtime-loop'
import { RuntimeAuxiliaryStore } from '#core/runtime-auxiliary-store'
import { RuntimeAuxiliaryRunner } from '#core/runtime-auxiliary'
import { capabilityHash } from '#core/runtime-capability-projection'
import { ProjectContextStore } from '#core/project-context-store'
import { initializeProjectDirectory } from '#core/project-initializer'
import type { ClientCommand, ControlEnvelopeV2, RuntimeRequestBinding } from '#protocol/runtime-protocol'
import type { LlmChatRequest, LlmChatResponse } from '#util/llm'

function binding(request:LlmChatRequest):RuntimeRequestBinding {
  const match=request.messages[0]!.content.match(/\{"sessionId":"[^"]+","runId":"[^"]+","requestId":"[^"]+","taskId":"[^"]+","stateRevision":\d+\}/)
  assert.ok(match);return JSON.parse(match[0])
}
function control(request:LlmChatRequest,decision:'reflect'|'finish'|'ask_user'):LlmChatResponse {
  const b=binding(request)
  const value:ControlEnvelopeV2={envelopeVersion:2,binding:b,decision,userMessage:decision==='finish'?'已诊断真实读取失败，保留原证据。':decision==='ask_user'?'请提供原件。':'',actions:decision==='ask_user'?[{kind:'ask_user',question:'请提供原件。',blockingTaskIds:[b.taskId]}]:[],planProposal:null,candidateDiffs:[],evidenceRequests:[],uncertainties:[],waitSpec:null,
    completionCheck:decision==='finish'?{taskId:b.taskId,requiredActions:[],requiredEvidenceRefs:[],unresolvedUncertaintyIds:[],summary:'诊断已明确，不声称读取成功。'}:null}
  return{provider:'custom',model:'main-test',raw:{},text:JSON.stringify(value)}
}
function failedRead():LlmChatResponse{return{provider:'custom',model:'main-test',raw:{},text:'',toolCalls:[{id:'missing-original',name:'read_runtime_artifact',arguments:{artifact_id:'does-not-exist'}}]}}
function reflectionView(request:LlmChatRequest):any{return JSON.parse(request.messages[0]!.content.split('\n').find(line=>line.startsWith('{"taskId":'))!).reflection}
function reflection(request:LlmChatRequest,change:Record<string,unknown>={}):LlmChatResponse{
  assert.equal(request.tools,undefined)
  assert.equal(request.clientMetadata!.sessionId,'reflection-session')
  const lines=request.messages[0]!.content.split('\n')
  const header=JSON.parse(lines.find(line=>line.startsWith('{"reflectionVersion":1,"snapshotId":'))!)
  const data=JSON.parse(lines.find(line=>line.startsWith('{"goal":'))!)
  const failure=data.sources.find((source:{kind:string})=>source.kind==='failed-step')
  assert.ok(failure)
  return{provider:'custom',model:'reflection-test',raw:{},usage:{inputTokens:100,outputTokens:20,totalTokens:120},text:JSON.stringify({reflectionVersion:1,snapshotId:header.snapshotId,
    diagnosis:[{statement:'读取未找到真实原件；不能据此宣称业务成功。',sourceRefs:[failure.id]}],correctionPlan:[{id:'request-source',description:'先取得有效原件引用。',dependsOn:[],verification:'真实读取返回原件与哈希。',sourceRefs:[failure.id]}],
    candidateDiffs:[],evidenceRequests:[{question:'需要有效原件引用。',sourceRefs:[]}],retryPreconditions:[{statement:'原件引用已核实。',sourceRefs:[failure.id]}],uncertainties:[],...change})}
}
function fixture(main:(request:LlmChatRequest)=>LlmChatResponse|Promise<LlmChatResponse>,aux:(request:LlmChatRequest)=>LlmChatResponse|Promise<LlmChatResponse>,options:Partial<RuntimeLoopOptions>={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'capybara-reflection-'));initializeProjectDirectory(root)
  const config=(model:string)=>()=>({provider:'custom' as const,protocol:'responses' as const,model,baseUrl:'http://127.0.0.1/unused',timeoutMs:1000,maxRetries:0})
  const settings={projectDir:root,sessionId:'reflection-session',streamDelayMs:0,stepDelayMs:0,contextOrganization:{minGroups:100},llm:{getConfig:config('main-test'),chat:async(request:LlmChatRequest)=>{try{return await main(request)}catch(error){console.error('REFLECTION_MAIN_ASSERTION',error instanceof Error?error.message:String(error));throw error}}} as RuntimeLlm,
    contextAssistant:{llm:{getConfig:config('reflection-test'),chat:async(request:LlmChatRequest)=>aux(request)} as RuntimeLlm},...options}
  let loop=new RuntimeLoop(settings),sequence=0
  const send=(type:ClientCommand['type'],payload:unknown)=>{const command={version:1,kind:'command',id:`reflect-command-${++sequence}`,type,sessionId:'reflection-session',timestamp:new Date().toISOString(),payload} as ClientCommand;loop.validate(command);loop.execute(command,sequence)}
  return{root,get loop(){return loop},send,
    start(){send('chat.message.send',{clientMessageId:'diagnose-source',content:[{type:'text',text:'读取给定原件；失败时诊断原因，不能编造资料。'}],autoStart:true})},
    until(status:string){return new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{off();reject(new Error(`reflection run did not reach ${status}`))},20000)
      const off=loop.onEvent(event=>{if(event.type!=='run.state.changed')return;if(event.payload.status===status){clearTimeout(timer);off();resolve()}else if(event.payload.status==='failed'){clearTimeout(timer);off();reject(new Error(event.payload.failure!.message))}})})},
    reopen(){const state=loop.exportState();loop.close();loop=new RuntimeLoop({...settings,initialState:state});return state},
    db(){return new DatabaseSync(path.join(root,'.capybara/sessions.sqlite'))},
    close(){loop.close();fs.rmSync(root,{recursive:true,force:true})}}
}

test('reflect invokes an independent readonly role and exposes guidance without changing facts or raw history',async()=>{
  let mainCalls=0,auxCalls=0
  const f=fixture(request=>{if(++mainCalls===1)return failedRead();if(mainCalls===2)return control(request,'reflect')
    assert.ok(request.messages[0]!.content.includes('读取未找到真实原件'));assert.ok(request.messages[0]!.content.includes('"guidanceOnly":true'))
    assert.equal(request.messages.filter(message=>message.role==='user').length,1);return control(request,'finish')},request=>{auxCalls++;return reflection(request)})
  try{const done=f.until('completed');f.start();await done
    assert.equal(mainCalls,3);assert.equal(auxCalls,1)
    const state=f.loop.exportState();assert.equal(state.contextDocument!.information.length,0);assert.equal(state.projectContextDocument!.information.length,0)
    assert.equal(state.runUsage.totalTokens,120)
    assert.ok(state.contextHistory!.messages.some(message=>message.message.role==='tool'&&message.message.content.includes('not found')))
    const db=f.db();try{const record=JSON.parse((db.prepare('SELECT state_json FROM runtime_auxiliary_calls').get() as {state_json:string}).state_json)
      assert.equal(record.status,'succeeded');assert.equal(record.consumption.decision,'accepted');assert.equal(record.promptBindings[1].role,'reflection');assert.ok(record.consumption.artifactId)
    }finally{db.close()}
  }finally{f.close()}
})

test('reflection rejects invented source references and preserves the failed response as a source',async()=>{
  let mainCalls=0,auxCalls=0
  const f=fixture(request=>{if(++mainCalls===1)return failedRead();if(mainCalls===2)return control(request,'reflect')
    assert.ok(request.messages[0]!.content.includes('REFLECTION_SOURCE_UNKNOWN'));return control(request,'finish')},request=>{auxCalls++;return reflection(request,{diagnosis:[{statement:'凭空归因。',sourceRefs:['not-provided']}]})})
  try{const done=f.until('completed');f.start();await done;assert.equal(auxCalls,1)
    const db=f.db();try{const record=JSON.parse((db.prepare('SELECT state_json FROM runtime_auxiliary_calls').get() as {state_json:string}).state_json)
      assert.equal(record.status,'failed');assert.equal(record.consumption.decision,'failed');assert.match(record.response.text,/not-provided/)
    }finally{db.close()}
    assert.equal(f.loop.exportState().contextDocument!.information.length,0)
  }finally{f.close()}
})

test('reflection without real failure evidence does not call an auxiliary model',async()=>{
  let mainCalls=0,auxCalls=0
  const f=fixture(request=>{if(++mainCalls===1)return control(request,'reflect');assert.ok(request.messages[0]!.content.includes('REFLECTION_FAILURE_EVIDENCE_REQUIRED'));return control(request,'ask_user')},async()=>{auxCalls++;throw new Error('must not invoke')})
  try{const paused=f.until('paused');f.start();await paused;assert.equal(auxCalls,0);assert.ok(f.loop.exportState().reflectionFailure)}finally{f.close()}
})

test('a reflection reservation fault is visible to the main role and prevents its provider call',async()=>{
  let mainCalls=0,auxCalls=0
  const f=fixture(request=>{if(++mainCalls===1)return failedRead();if(mainCalls===2)return control(request,'reflect');assert.ok(request.messages[0]!.content.includes('REFLECTION_RESERVATION_FAULT'));return control(request,'finish')},async()=>{auxCalls++;throw new Error('must not invoke')})
  const store=new RuntimeAuxiliaryStore(f.root);store.close();const db=f.db()
  try{db.exec("CREATE TRIGGER fail_reflection BEFORE INSERT ON runtime_auxiliary_calls BEGIN SELECT RAISE(ABORT,'REFLECTION_RESERVATION_FAULT'); END")
    const done=f.until('completed');f.start();await done;assert.equal(auxCalls,0);assert.equal((db.prepare('SELECT COUNT(*) AS n FROM runtime_auxiliary_calls').get() as {n:number}).n,0)
  }finally{db.close();f.close()}
})

test('a concurrent project update makes reflection stale and never applies its suggestions',async()=>{
  let mainCalls=0
  const f=fixture(request=>{if(++mainCalls===1)return failedRead();if(mainCalls===2)return control(request,'reflect');assert.ok(request.messages[0]!.content.includes('"decision":"stale"'));assert.ok(!request.messages[0]!.content.includes('先取得有效原件引用。'));return control(request,'finish')},request=>{
    const writer=new ProjectContextStore(f.root,f.root,'test')
    try{const engine=writer.load(),revision=engine.snapshot().revision;engine.observe({candidate:{source:{actor:'user',sourceId:'concurrent-user-note',capturedAt:new Date().toISOString()},rawArtifactId:'concurrent-user-note',normalizedContent:'并发增加的待审核项目材料。'},evidence:{kind:'message',referenceId:'concurrent-user-note'}});writer.save(engine,revision)}finally{writer.close()}
    return reflection(request)})
  try{const done=f.until('completed');f.start();await done;assert.equal(f.loop.exportState().projectContextDocument!.information.length,0);assert.equal(f.loop.exportState().projectContextDocument!.candidates.length,1)}finally{f.close()}
})

test('closing and reopening an in-flight reflection retains unknown and never replays its model request',async()=>{
  let mainCalls=0,auxCalls=0,started!:()=>void,resolveAux!:(response:LlmChatResponse)=>void,oldRequest!:LlmChatRequest
  const actual=new Promise<void>(resolve=>{started=resolve})
  const f=fixture(request=>{if(++mainCalls===1)return failedRead();if(mainCalls===2)return control(request,'reflect');assert.ok(request.messages[0]!.content.includes('"status":"unknown"'));return control(request,'finish')},request=>{auxCalls++;oldRequest=request;started();return new Promise(resolve=>{resolveAux=resolve})})
  try{f.start();await Promise.race([actual,delay(10000,undefined,{ref:false}).then(()=>{throw new Error('reflection did not invoke its actual provider')})]);const before=f.reopen();const done=f.until('completed');f.send('run.resume',{});await done
    assert.equal(auxCalls,1);assert.equal(mainCalls,3);assert.equal(f.loop.exportState().snapshot.run.runId,before.snapshot.run.runId)
    resolveAux(reflection(oldRequest));await delay(30)
    const db=f.db();try{const record=JSON.parse((db.prepare('SELECT state_json FROM runtime_auxiliary_calls').get() as {state_json:string}).state_json);assert.equal(record.status,'unknown');assert.equal(record.consumption.decision,'failed');assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runtime_auxiliary_events WHERE event='late_response'").get() as {n:number}).n,1)}finally{db.close()}
  }finally{f.close()}
})

test('real reflection calls remain bounded by the three-attempt gate',async()=>{
  let mainCalls=0,auxCalls=0
  const f=fixture(request=>++mainCalls===1?failedRead():control(request,'reflect'),request=>{auxCalls++;return reflection(request)})
  try{const failed=f.until('failed');f.start();await failed;assert.equal(auxCalls,3);assert.equal(mainCalls,5);assert.equal(f.loop.exportState().snapshot.run.failure!.code,'RUNTIME_REFLECTION_LIMIT')}
  finally{f.close()}
})

for(const invented of [true,false])test(`reflection ${invented?'rejects invented diff evidence':'returns a valid candidate diff without applying it'}`,async()=>{
  let mainCalls=0
  const f=fixture(request=>{if(++mainCalls===1)return failedRead();if(mainCalls===2)return control(request,'reflect')
    if(invented)assert.ok(reflectionView(request).error.includes('REFLECTION_EVIDENCE_UNKNOWN'));else assert.equal(reflectionView(request).output.candidateDiffs.length,1);return control(request,'finish')},request=>{
    const lines=request.messages[0]!.content.split('\n')
    const {publications}=JSON.parse(lines.find(line=>line.startsWith('{"publications":'))!)
    const {evidenceIndex}=JSON.parse(lines.find(line=>line.startsWith('{"runtimeState":'))!)
    const publication=publications.find((item:{scope:string})=>item.scope==='session')
    assert.ok(publication.projection.sourceCandidateIds.length);assert.ok(evidenceIndex.length)
    return reflection(request,{candidateDiffs:[{scope:'session',documentId:publication.documentId,baseRevision:publication.projection.documentRevision,projectionId:publication.projection.id,projectionHash:publication.projection.contentHash,
      target:{section:'information',headingPath:['候选修正']},candidateId:publication.projection.sourceCandidateIds[0],operation:'add_entry',payload:{body:'用户要求诊断原件读取失败。',evidenceRefs:[invented?'invented-evidence':evidenceIndex[0].id]},idempotencyKey:'reflection-candidate-only'}]})})
  try{const done=f.until('completed');f.start();await done;assert.equal(f.loop.exportState().contextDocument!.information.length,0)}finally{f.close()}
})

test('a live auxiliary owner is not stolen and its pending call blocks parent completion',async()=>{
  let mainCalls=0,external:RuntimeAuxiliaryRunner|undefined,pending:Promise<unknown>|undefined
  const f=fixture(request=>{
    if(++mainCalls===1)return failedRead()
    if(mainCalls===2){
      const b=binding(request);external=new RuntimeAuxiliaryRunner(f.root)
      const auxiliaryRequest={model:'existing-aux',messages:[{role:'system' as const,content:'Existing readonly invocation'}],maxTokens:100}
      pending=external.invoke({operationId:`reflection:${b.requestId}`,mode:'reflection',binding:b,snapshotId:'existing-host-call',contextHash:capabilityHash('existing-context'),schemaHash:capabilityHash('existing-schema'),
        promptBindings:[],request:auxiliaryRequest,inputTokens:Math.ceil(JSON.stringify(auxiliaryRequest).length/4)},
        {maxCalls:8,maxTotalTokens:60000,maxInputTokens:1000,maxOutputTokens:100,timeoutMs:30000},{getConfig:()=>({provider:'custom',protocol:'responses',model:'existing-aux',baseUrl:'http://127.0.0.1/unused',timeoutMs:1000,maxRetries:0}),chat:async()=>new Promise(()=>{})},v=>v)
      pending.catch(()=>{})
      return control(request,'reflect')
    }
    assert.ok(request.messages[0]!.content.includes('REFLECTION_REQUEST_STILL_RUNNING'));return control(request,'finish')
  },async()=>{throw new Error('must not create another auxiliary owner')})
  try{const failed=f.until('failed');f.start();await failed;assert.equal(mainCalls,3);assert.match(f.loop.exportState().snapshot.run.failure!.message,/pending_auxiliary/)
    const db=f.db();try{const record=JSON.parse((db.prepare('SELECT state_json FROM runtime_auxiliary_calls').get() as {state_json:string}).state_json);assert.equal(record.status,'running');assert.equal(record.consumption,undefined)}finally{db.close()}
  }finally{external?.close();if(pending)await assert.rejects(pending,/ABORTED/);f.close()}
})

test('a later reflection exposes its current result while the earlier reservation failure remains audited',async()=>{
  let mainCalls=0,auxCalls=0,db:DatabaseSync
  const f=fixture(request=>{
    if(++mainCalls===1)return failedRead()
    if(mainCalls===2)return control(request,'reflect')
    if(mainCalls===3){assert.ok(request.messages[0]!.content.includes('RETRYABLE_REFLECTION_RESERVATION'));db.exec('DROP TRIGGER retryable_reflection');return control(request,'reflect')}
    assert.ok(request.messages[0]!.content.includes('读取未找到真实原件'));assert.ok(!request.messages[0]!.content.includes('RETRYABLE_REFLECTION_RESERVATION'));return control(request,'finish')
  },request=>{auxCalls++;return reflection(request)})
  const store=new RuntimeAuxiliaryStore(f.root);store.close();db=f.db()
  try{
    db.exec("CREATE TRIGGER retryable_reflection BEFORE INSERT ON runtime_auxiliary_calls BEGIN SELECT RAISE(ABORT,'RETRYABLE_REFLECTION_RESERVATION'); END")
    const done=f.until('completed');f.start();await done;assert.equal(auxCalls,1);assert.equal(mainCalls,4)
    assert.ok(f.loop.exportState().artifacts.some(artifact=>JSON.stringify(artifact.value).includes('RETRYABLE_REFLECTION_RESERVATION')))
  }finally{db.close();f.close()}
})

test('the main role receives every reflection prerequisite, dependency and uncertainty without truncation',async()=>{
  let mainCalls=0,expected:Record<string,unknown>
  const f=fixture(request=>{
    if(++mainCalls===1)return failedRead();if(mainCalls===2)return control(request,'reflect')
    const view=reflectionView(request);assert.deepEqual(view.output,expected);assert.ok(view.rawArtifactId)
    assert.ok(view.output.retryPreconditions[0].statement.includes('不能重试'));assert.ok(view.output.uncertainties[0].statement.includes('尚未核对'))
    return control(request,'finish')
  },request=>{
    const response=reflection(request);const output=JSON.parse(response.text)
    output.correctionPlan.push({id:'confirm-source',description:'确认实际来源。',dependsOn:['request-source'],verification:'收到真实原件。',sourceRefs:output.diagnosis[0].sourceRefs})
    output.retryPreconditions=[{statement:'确认原件来源前不能重试。',sourceRefs:output.diagnosis[0].sourceRefs}]
    output.uncertainties=[{statement:'来源身份尚未核对，保留未知。',sourceRefs:output.diagnosis[0].sourceRefs}]
    expected=output;return{...response,text:JSON.stringify(output)}
  })
  try{const done=f.until('completed');f.start();await done;assert.equal(mainCalls,3);assert.equal(f.loop.exportState().contextDocument!.information.length,0)}finally{f.close()}
})
