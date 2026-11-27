import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { initializeProjectDirectory } from '#core/project-initializer'
import { RuntimeLoop, type RuntimeLlm } from '#core/runtime-loop'
import type { ClientCommand, ServerEvent } from '#protocol/runtime-protocol'
import type { LlmChatRequest, LlmChatResponse } from '#util/llm'

type Strategy = 'direct' | 'dag' | 'a2a'

interface StrategyMetrics {
  strategy: Strategy
  status: string
  modelRequests: number
  estimatedInputTokens: number
  toolCalls: number
  workflowDefinitions: number
  workflowResults: number
  workflowNodes: number
  childStarted: number
  childConsumed: number
  completionGate: string | undefined
}

function toolCall(name: string, id: string, args: Record<string, unknown>): LlmChatResponse {
  return { provider: 'custom', model: 'comparison-model', text: '', raw: {}, toolCalls: [{ name, id, arguments: args }] }
}

function binding(request: LlmChatRequest): Record<string, unknown> {
  const line = request.messages[0]?.content.split('\n').find(value => value.startsWith('{"sessionId":'))
  assert.ok(line)
  return JSON.parse(line) as Record<string, unknown>
}

function finish(request: LlmChatRequest): LlmChatResponse {
  const value = binding(request)
  return {
    provider: 'custom',
    model: 'comparison-model',
    raw: {},
    text: JSON.stringify({
      envelopeVersion: 2,
      binding: value,
      decision: 'finish',
      userMessage: '本地策略对照任务已完成。',
      actions: [],
      planProposal: null,
      candidateDiffs: [],
      evidenceRequests: [],
      uncertainties: [],
      waitSpec: null,
      completionCheck: {
        taskId: value.taskId,
        requiredActions: [],
        requiredEvidenceRefs: [],
        unresolvedUncertaintyIds: [],
        summary: '只读结果已经验证。',
      },
    }),
    finishReason: 'stop',
  }
}

function readToolResult(request: LlmChatRequest, name: string): Record<string, any> | undefined {
  const message = request.messages.filter(item => item.role === 'tool' && item.name === name).at(-1)
  return message ? JSON.parse(message.content) as Record<string, any> : undefined
}

async function runStrategy(strategy: Strategy): Promise<StrategyMetrics> {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `capybara-strategy-${strategy}-`))
  initializeProjectDirectory(projectDir)
  let modelRequests = 0
  let childStarted = 0
  const events: ServerEvent[] = []
  const llm: RuntimeLlm = {
    getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'comparison-model', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }),
    chat: async (request) => {
      modelRequests += 1
      const has = (name: string) => request.messages.some(item => item.role === 'tool' && item.name === name)
      if (strategy === 'direct') {
        if (!has('load_resources')) return toolCall('load_resources', 'direct-load', { ids: ['project-files:list_files'] })
        if (!has('list_files')) return toolCall('list_files', 'direct-list', { path: 'test-docs', recursive: false, max_entries: 100 })
        return finish(request)
      }
      if (strategy === 'dag') {
        if (!has('load_resources')) return toolCall('load_resources', 'dag-load', { ids: ['project-files:list_files'] })
        if (!has('execute_workflow')) {
          return toolCall('execute_workflow', 'dag-workflow', {
            version: 1,
            goal: '读取文档目录并整理出稳定的文件字段。',
            intent: {
              calls: [{ id: 'list_documents', tool: 'project-files:list_files', args: { path: 'test-docs', recursive: false, max_entries: 100 } }],
              operations: [{ id: 'select_fields', op: 'transform', operator: 'select_fields', input: { $ref: 'steps.list_documents.output.entries' }, fields: ['path', 'type'] }],
            },
          })
        }
        return finish(request)
      }
      if (!has('delegate_task')) return toolCall('delegate_task', 'a2a-delegate', { goal: '读取文档目录', prompt: '只读返回目录事实。', mode: 'sync' })
      const delegated = readToolResult(request, 'delegate_task')?.result
      if (delegated && !has('read_child_result')) return toolCall('read_child_result', 'a2a-read', { child_id: delegated.childId })
      const read = readToolResult(request, 'read_child_result')?.result
      if (read && !has('consume_child_result')) return toolCall('consume_child_result', 'a2a-consume', {
        child_id: read.childId,
        result_hash: read.result_hash,
        read_receipt_id: read.read_receipt_id,
        decision: 'accept',
        reason: '已核对只读子代理结果。',
      })
      return finish(request)
    },
  }
  const loop = new RuntimeLoop({
    projectDir,
    sessionId: `strategy-${strategy}`,
    llm,
    childAgentEnabled: strategy === 'a2a',
    ...(strategy === 'a2a' ? { childAgentHost: async () => { childStarted += 1; return { ok: true, output: '目录事实已核对。' } } } : {}),
    contextOrganization: { minGroups: 100 },
    stepDelayMs: 0,
    streamDelayMs: 0,
  })
  const off = loop.onEvent(event => events.push(event as ServerEvent))
  try {
    const command = {
      version: 1,
      kind: 'command',
      id: `strategy-${strategy}-message`,
      type: 'chat.message.send',
      sessionId: `strategy-${strategy}`,
      timestamp: new Date().toISOString(),
      payload: { clientMessageId: `strategy-${strategy}`, content: [{ type: 'text', text: '读取文档目录并返回可核验结果。' }], autoStart: true },
    } as ClientCommand
    loop.validate(command)
    loop.execute(command, 1)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${strategy} strategy did not settle`)), 10_000)
      const unsubscribe = loop.onEvent(event => {
        if (event.type === 'run.state.changed' && (event.payload.status === 'completed' || event.payload.status === 'failed')) {
          clearTimeout(timer)
          unsubscribe()
          resolve()
        }
      })
    })
    const state = loop.exportState() as any
    const workflows = state.artifacts.filter((artifact: any) => artifact.meta.kind === 'workflow-definition' || artifact.meta.kind === 'workflow-result')
    const estimatedInputTokens = state.artifacts
      .filter((artifact: any) => artifact.meta.kind === 'hook-log' && artifact.value?.event === 'completed')
      .reduce((total: number, artifact: any) => total + Number(artifact.value?.estimatedInputTokens ?? 0), 0)
    const workflow = state.snapshot?.workflows?.items?.at(-1)
    const children = state.snapshot?.children?.items ?? []
    const consumed = children.filter((child: any) => child.consumption?.decision === 'accept').length
    const completionGate = state.snapshot?.run?.status === 'completed' ? 'passed' : 'blocked'
    return {
      strategy,
      status: state.snapshot.run.status,
      modelRequests,
      estimatedInputTokens,
      toolCalls: events.filter(event => event.type === 'tool.call.started').length,
      workflowDefinitions: workflows.filter((artifact: any) => artifact.meta.kind === 'workflow-definition').length,
      workflowResults: workflows.filter((artifact: any) => artifact.meta.kind === 'workflow-result').length,
      workflowNodes: workflow?.nodes?.length ?? 0,
      childStarted,
      childConsumed: consumed,
      completionGate,
    }
  } finally {
    off()
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
}

test('local strategy comparison records direct, DAG, and A2A paths without AppWorld quota', async () => {
  const results = await Promise.all((['direct', 'dag', 'a2a'] as const).map(runStrategy))
  assert.deepEqual(results.map(result => result.status), ['completed', 'completed', 'completed'])
  assert.deepEqual(results.map(result => result.completionGate), ['passed', 'passed', 'passed'])
  const direct = results.find(result => result.strategy === 'direct')!
  const dag = results.find(result => result.strategy === 'dag')!
  const a2a = results.find(result => result.strategy === 'a2a')!
  assert.equal(direct.workflowDefinitions, 0)
  assert.equal(direct.workflowResults, 0)
  assert.ok(dag.workflowDefinitions >= 1)
  assert.ok(dag.workflowResults >= 1)
  assert.ok(dag.workflowNodes >= 2)
  assert.equal(a2a.childStarted, 1)
  assert.equal(a2a.childConsumed, 1)
  assert.ok(results.every(result => result.modelRequests >= 2))
  console.log(`STRATEGY_COMPARISON ${JSON.stringify(results)}`)
})
