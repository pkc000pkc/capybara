import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ToolDispatcher } from '#core/tools/tool-dispatcher'
import { ToolRegistry } from '#core/tools/tool-registry'
import { toolNetworkRetrySettings, parseToolProgress } from '#core/tools/network-retry'
import { blockedToolRequest } from '#core/tools/recovery-policy'

test('network retry settings default to ten and reject invalid budgets', () => {
  assert.equal(toolNetworkRetrySettings(undefined).max_retries,10)
  assert.equal(toolNetworkRetrySettings({max_retries:-1}).max_retries,-1)
  for(const value of [{max_retries:-2},{max_retries:1.5},{request_timeout_ms:0},{initial_delay_ms:50000}]) {
    assert.throws(()=>toolNetworkRetrySettings(value))
  }
})
test('tool progress validates structured stderr without accepting arbitrary log text', () => {
  assert.equal(parseToolProgress('ordinary log'),undefined)
  assert.equal(parseToolProgress('CAPYBARA_TOOL_PROGRESS {"phase":"waiting","attempt":2,"maxAttempts":11,"delayMs":1000,"reason":"HTTP 503"}')?.attempt,2)
})
test('recovery cooldown is run scoped, ignores presentation changes, and allows changed methods', () => {
  const state={run_id:'r',blocked_requests:[{tool:'fetch',arguments:{url:'https://example.com',max_chars:1000},until:2000,reason:'exhausted'}]}
  assert.equal(blockedToolRequest(state,'r','fetch',{max_chars:5000,url:'https://example.com'},1000),'exhausted')
  assert.equal(blockedToolRequest(state,'r','fetch',{url:'https://example.com'},3000),undefined)
  assert.equal(blockedToolRequest(state,'another','fetch',{url:'https://example.com'},1000),undefined)
  assert.equal(blockedToolRequest(state,'r','fetch',{url:'https://example.org'},1000),undefined)
})

test('dispatcher passes retry configuration, resolves full artifacts, and cancels a waiting runner', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'capybara-network-runner-'))
  try {
    fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({version:1,package:'test',runner:{type:'stdio',entry:'runner.mjs'},tools:[{
      name:'network_fixture',description:'fixture',permissions:[],networkRetry:{request_timeout_ms:1000},
      inputSchema:{type:'object',properties:{input_artifact:{type:'string'},input:{},wait:{type:'boolean'}},additionalProperties:false},
    }]}))
    fs.writeFileSync(path.join(dir,'runner.mjs'),`let raw='';for await(const c of process.stdin)raw+=c;const request=JSON.parse(raw);
if(request.arguments.wait){process.stderr.write('CAPYBARA_TOOL_PROGRESS '+JSON.stringify({phase:'waiting',attempt:2,maxAttempts:11,delayMs:30000,reason:'HTTP 503'})+'\\n');setInterval(()=>{},1000)}
else process.stdout.write(JSON.stringify({ok:true,result:{policy:JSON.parse(process.env.CAPYBARA_TOOL_NETWORK_RETRY),input:request.arguments.input}}));`)
    const registry=new ToolRegistry(dir);registry.load(['manifest.json'])
    const dispatcher=new ToolDispatcher(registry,dir)
    const bound=await dispatcher.dispatch({id:'bind',name:'network_fixture',arguments:{input_artifact:'tool-result-1'}},{resolveArtifact:()=>({records:[1,2,3]})})
    assert.equal(bound.ok,true)
    assert.deepEqual((bound.output as any).input,{records:[1,2,3]})
    assert.equal((bound.output as any).policy.max_retries,10)
    assert.equal((bound.output as any).policy.request_timeout_ms,1000)
    const controller=new AbortController()
    let notified=false
    const result=await dispatcher.dispatch({id:'cancel',name:'network_fixture',arguments:{wait:true}},{signal:controller.signal,onProgress:()=>{notified=true;controller.abort()}})
    assert.equal(notified,true)
    assert.equal(result.error?.code,'ABORTED')
  } finally { fs.rmSync(dir,{recursive:true,force:true}) }
})

test('network retry policy does not expand the whole-tool timeout', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'capybara-network-timeout-'))
  try {
    fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({version:1,package:'test',runner:{type:'stdio',entry:'runner.mjs'},tools:[{
      name:'network_wait',description:'fixture',permissions:[],networkRetry:{max_retries:10,request_timeout_ms:30000,max_delay_ms:30000},
      inputSchema:{type:'object',additionalProperties:false},
    }]}))
    fs.writeFileSync(path.join(dir,'runner.mjs'),`setInterval(()=>{},1000)`)
    const registry=new ToolRegistry(dir);registry.load(['manifest.json'])
    const started=Date.now()
    const result=await new ToolDispatcher(registry,dir,{timeoutMs:100}).dispatch({id:'timeout',name:'network_wait',arguments:{}})
    assert.equal(result.error?.code,'TIMEOUT')
    assert.ok(Date.now()-started<2000)
  } finally { fs.rmSync(dir,{recursive:true,force:true}) }
})
