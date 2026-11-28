import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { initializeProjectDirectory } from '#core/project-initializer'
import { createHttpChildAgentHost, httpChildAgentHostProtocol, type HttpChildAgentHostInput } from '#core/runtime-child-host'
import { RuntimeLoop, type RuntimeLlm } from '#core/runtime-loop'
import type { ClientCommand, ControlEnvelopeV2 } from '#protocol/runtime-protocol'
import type { LlmChatRequest, LlmChatResponse } from '#util/llm'

const input = (overrides: Partial<HttpChildAgentHostInput> = {}): HttpChildAgentHostInput => ({
  goal: '核对只读来源', prompt: '只读检查并返回证据。', projectPath: 'C:/fixture', parentContext: '{"information":[]}',
  parentSessionId: 'parent-session', parentTaskId: 'parent-task', parentRunId: 'parent-run', parentStepId: 'parent-step', planTaskId: 'source-task',
  callId: 'parent-call', childId: 'child-1', childSessionId: 'child-session', signal: new AbortController().signal,
  allowedCapabilityIds: ['runtime:search_resources'], allowedCapabilities: [], executionMode: 'readonly', attemptId: 'attempt-1',
  maxModelRounds: 4, maxToolRounds: 8, maxTotalTokens: 40_000, llm: {}, ...overrides,
})

async function startExternalHost(): Promise<{ process: ChildProcessWithoutNullStreams; url: string }> {
  const source = `
    const http = require('node:http');
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400); res.end(); return; }
      const payload = { protocol: body.protocol, requestId: body.requestId, childId: body.child.childId, childSessionId: body.child.sessionId,
        ok: true, output: '外部宿主已完成只读核对', evidence: { protocol: body.protocol, capabilityIds: body.capabilityIds, budget: body.budget } };
      res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify(payload));
    });
    server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `
  const child = spawn(process.execPath, ['-e', source], { stdio: ['pipe', 'pipe', 'pipe'] })
  const port = await new Promise<string>((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('external child host did not start')), 5000)
    child.stdout.on('data', chunk => {
      buffer += String(chunk)
      const line = buffer.split(/\r?\n/)[0]
      if (!line) return
      clearTimeout(timer); resolve(line)
    })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { if (code !== null && code !== 0) { clearTimeout(timer); reject(new Error(`external host exited ${code}`)) } })
  })
  return { process: child, url: `http://127.0.0.1:${port}/child` }
}

function stopExternalHost(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise(resolve => {
    if (child.exitCode !== null) return resolve()
    child.once('exit', () => resolve()); child.kill('SIGTERM'); setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 1000).unref()
  })
}

test('external process child host completes a readonly A2A request over the versioned HTTP contract', async () => {
  const external = await startExternalHost()
  try {
    const host = createHttpChildAgentHost({ url: external.url, timeoutMs: 5000 })
    const result = await host(input())
    assert.equal(httpChildAgentHostProtocol, 'capybara.a2a.child.v1')
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.output, '外部宿主已完成只读核对')
    assert.deepEqual(result.evidence, { protocol: 'capybara.a2a.child.v1', capabilityIds: ['runtime:search_resources'], budget: { maxModelRounds: 4, maxToolRounds: 8, maxTotalTokens: 40000 } })
  } finally { await stopExternalHost(external.process) }
})

test('external child host rejects action mode, identity mismatches, and oversized responses', async () => {
  const action = createHttpChildAgentHost({ url: 'http://127.0.0.1:1/unused' })
  assert.equal((await action(input({ executionMode: 'action' }))).error?.code, 'CHILD_HOST_ACTION_UNSUPPORTED')
  const mismatch = createHttpChildAgentHost({ url: 'http://fixture.invalid/child', fetch: async () => new Response(JSON.stringify({ protocol: httpChildAgentHostProtocol, requestId: 'other', childId: 'other', childSessionId: 'other', ok: true }), { status: 200 }) })
  assert.equal((await mismatch(input())).error?.code, 'CHILD_HOST_IDENTITY_MISMATCH')
  const oversized = createHttpChildAgentHost({ url: 'http://fixture.invalid/child', maxResponseBytes: 1024, fetch: async () => new Response('x'.repeat(2048), { status: 200 }) })
  assert.equal((await oversized(input())).error?.code, 'CHILD_HOST_RESPONSE_TOO_LARGE')
})

function runtimeBinding(request: LlmChatRequest): { sessionId: string; taskId: string; runId: string; requestId: string } {
  const match = request.messages[0]!.content.match(/\{"sessionId":"[^\"]+","runId":"[^\"]+","requestId":"[^\"]+","taskId":"[^\"]+","stateRevision":\d+\}/)
  assert.ok(match)
  return JSON.parse(match[0])
}

function runtimeResponse(request: LlmChatRequest, fields: Partial<ControlEnvelopeV2>): LlmChatResponse {
  return { provider: 'custom', model: 'external-host-test', raw: {}, text: JSON.stringify({ envelopeVersion: 2, binding: runtimeBinding(request), decision: 'continue', userMessage: '', actions: [], planProposal: null,
    candidateDiffs: [], evidenceRequests: [], uncertainties: [], waitSpec: null, completionCheck: null, ...fields }) }
}

function runtimeCall(name: string, id: string, args: Record<string, unknown>): LlmChatResponse {
  return { provider: 'custom', model: 'external-host-test', raw: {}, text: '', toolCalls: [{ name, id, arguments: args }] }
}

function toolResult(request: LlmChatRequest, name: string): any {
  const message = request.messages.filter(item => item.role === 'tool' && item.name === name).at(-1)
  assert.ok(message, `missing ${name}`)
  const parsed = JSON.parse(message.content)
  assert.equal(parsed.ok, true, message.content)
  return parsed.result
}

test('RuntimeLoop consumes the external process child result through the normal read and completion gates', async () => {
  const external = await startExternalHost()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-external-child-'))
  initializeProjectDirectory(root)
  let calls = 0
  const llm: RuntimeLlm = {
    getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'external-host-test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }),
    chat: async request => {
      calls++
      if (calls === 1) return runtimeCall('delegate_task', 'external-delegate', { goal: '核对只读来源', prompt: '交给外部宿主完成只读核对。', mode: 'sync' })
      if (calls === 2) return runtimeCall('read_child_result', 'external-read', { child_id: toolResult(request, 'delegate_task').childId })
      if (calls === 3) {
        const read = toolResult(request, 'read_child_result')
        return runtimeCall('consume_child_result', 'external-review', { child_id: read.childId, result_hash: read.result_hash, read_receipt_id: read.read_receipt_id, decision: 'accept', reason: '已核对外部宿主身份和只读证据。' })
      }
      return runtimeResponse(request, { decision: 'finish', userMessage: '外部子代理结果已读取并审核。', completionCheck: { taskId: runtimeBinding(request).taskId, requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '外部子代理结果已消费' } })
    },
  }
  const loop = new RuntimeLoop({ projectDir: root, sessionId: 'external-parent', llm, childAgentEnabled: true, childAgentHost: createHttpChildAgentHost({ url: external.url, timeoutMs: 5000 }), streamDelayMs: 0, stepDelayMs: 0 })
  const command = { version: 1, kind: 'command', id: 'external-command-1', sessionId: 'external-parent', type: 'chat.message.send', timestamp: new Date().toISOString(), payload: { clientMessageId: 'external-message-1', content: [{ type: 'text', text: '启动外部只读子代理并审核结果。' }], autoStart: true } } as ClientCommand
  const completed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`external child parent did not complete: ${JSON.stringify(loop.exportState().snapshot.run)}`)) }, 20_000)
    const off = loop.onEvent(event => {
      if (event.type !== 'run.state.changed') return
      if (event.payload.status === 'completed') { clearTimeout(timer); off(); resolve() }
      if (event.payload.status === 'failed') { clearTimeout(timer); off(); reject(new Error(event.payload.failure?.message ?? 'external child parent failed')) }
    })
  })
  try {
    loop.validate(command); loop.execute(command, 1)
    await completed
    const state = loop.exportState(), child = state.snapshot.children!.items[0]!
    assert.equal(calls, 4)
    assert.equal(child.status, 'succeeded')
    assert.equal(child.consumption?.decision, 'accept')
    assert.ok(child.resultArtifactId)
    assert.ok(state.contextDocument!.candidates.some(candidate => candidate.source.actor === 'child-agent'))
  } finally { loop.close(); fs.rmSync(root, { recursive: true, force: true }); await stopExternalHost(external.process) }
})
