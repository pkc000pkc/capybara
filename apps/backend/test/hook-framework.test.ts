import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { HookRegistry } from '#core/hooks/hook-registry'
import { HookRunner } from '#core/hooks/hook-runner'
import type { HookFixture } from '#core/hooks/types'
import { initializeProjectDirectory } from '#core/project-initializer'
import type { RuntimeLlm } from '#core/runtime-loop'
import { RuntimeLoop } from '#core/runtime-loop'
import type { ClientCommand } from '#protocol/runtime-protocol'

const SOURCE = `import { defineHook } from "@capybara/sdk";

export default defineHook({
  name: "summary-hook",
  description: "Test after-Loop processing.",
  enabled: true,
  trigger({ status, changed }) {
    return status.messageCount >= 2 && changed.has("builtin.sys_message");
  },
  schedule: { priority: 10, timeoutMs: 2000, onError: "continue" },
  permissions: { llm: "project", variables: "patch", messages: "replace" },
  async run({ llm, messages }) {
    const response = await llm.responses.create({ input: "summarize" });
    return {
      patches: [{ op: "replace", path: "/context/history_summary", value: response.output_text }],
      messages: messages.slice(-2),
    };
  },
});
`

function fixture(): HookFixture {
  return {
    checkpoint: 'after_loop',
    runId: 'run-test',
    loopIteration: 1,
    status: {
      run: { status: 'completed' },
      context: { usedTokens: 1200, maxTokens: 1600, utilization: 0.75 },
      queueDepth: 0,
      messageCount: 3,
      variableTokens: { 'builtin.sys_message': 1200 },
    },
    changedVariables: ['builtin.sys_message'],
    variables: {
      builtin: {
        project_path: '', workspace_path: '', config_file: '', main_template: '', initialized_at: '',
        prompts: {}, missing_prompts: [], sys_message: [],
      },
      task: { title: '' },
      agent: { name: 'capybara' },
      context: { files: [], history_summary: '', evidence_refs: [], evidence_digest: '' },
      user_message: '',
      tools: [],
      harnesses: [],
      skills: { catalog: [], active: [] },
    },
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'answer' },
    ],
  }
}

test('Hook registry scans single-file definitions and rejects name mismatches', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-hooks-'))
  const directory = path.join(projectDir, '.capybara', 'hooks')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'summary-hook.ts'), SOURCE)
  fs.writeFileSync(path.join(directory, 'wrong-name.ts'), SOURCE)
  try {
    const hooks = new HookRegistry(projectDir).list()
    const valid = hooks.find((hook) => hook.id === 'summary-hook')
    const invalid = hooks.find((hook) => hook.id === 'wrong-name')
    assert.equal(valid?.loadable, true)
    assert.equal(valid?.triggerSummary, 'status + builtin.sys_message')
    assert.ok(valid?.triggerInputs.includes('changed.builtin.sys_message'))
    assert.equal(invalid?.loadable, false)
    assert.match(invalid?.diagnostics[0]?.message ?? '', /match file name/)
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('Hook runner evaluates after-Loop triggers and proxies the project LLM', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-hook-runner-'))
  const registry = new HookRegistry(projectDir)
  const hook = registry.validateContent('summary-hook', SOURCE)
  const llm: RuntimeLlm = {
    chat: async () => ({
      provider: 'custom',
      model: 'hook-model',
      text: 'durable summary',
      usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
      raw: {},
    }),
    getConfig: () => ({
      provider: 'custom', protocol: 'responses', model: 'hook-model',
      baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0,
    }),
  }
  try {
    const result = await new HookRunner(llm).run(hook, fixture())
    assert.equal(result.matched, true)
    assert.equal(result.result?.patches?.[0]?.op, 'replace')
    assert.equal(result.result?.patches?.[0] && 'value' in result.result.patches[0]
      ? result.result.patches[0].value
      : undefined, 'durable summary')
    assert.equal(result.result?.messages?.length, 2)
    assert.equal(result.usage.totalTokens, 11)
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('Runtime checks Hooks once after the Loop and applies message and variable results', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-hook-runtime-'))
  initializeProjectDirectory(projectDir)
  const hookFile = path.join(projectDir, '.capybara', 'hooks', 'context-compression.ts')
  const source = fs.readFileSync(hookFile, 'utf8')
    .replace('status.context.utilization >= 0.72', 'status.context.utilization >= 0')
    .replace('status.messageCount > 10', 'status.messageCount > 1')
    .replace('conversation.slice(-6)', 'conversation.slice(-1)')
    .replace('conversation.slice(0, -6)', 'conversation.slice(0, -1)')
  fs.writeFileSync(hookFile, source)
  let calls = 0
  const llm: RuntimeLlm = {
    chat: async (request) => {
      calls += 1
      const hookCall = request.messages.some((message) => message.content.includes('Compress the earlier'))
      return {
        provider: 'custom',
        model: 'hook-model',
        text: hookCall
          ? 'summary produced by Hook'
          : JSON.stringify({ status: 'completed', content: 'runtime answer' }),
        usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
        raw: {},
      }
    },
    getConfig: () => ({
      provider: 'custom', protocol: 'responses', model: 'hook-model',
      baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0,
    }),
  }
  const loop = new RuntimeLoop({ projectDir, llm, stepDelayMs: 0, streamDelayMs: 0 })
  const command: ClientCommand = {
    version: 1,
    kind: 'command',
    id: 'hook-runtime-command',
    type: 'chat.message.send',
    sessionId: 'test-session',
    timestamp: new Date().toISOString(),
    payload: {
      clientMessageId: 'hook-runtime-user',
      content: [{ type: 'text', text: 'Run the Hook.' }],
      autoStart: true,
    },
  }
  try {
    const completed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Hook runtime test timed out')), 5000)
      loop.onEvent((event) => {
        if (event.type === 'run.state.changed' && event.payload.status === 'completed') {
          clearTimeout(timeout)
          resolve()
        }
        if (event.type === 'run.state.changed' && event.payload.status === 'failed') {
          clearTimeout(timeout)
          reject(new Error(event.payload.failure?.message ?? 'runtime failed'))
        }
      })
    })
    loop.validate(command)
    loop.execute(command, 1)
    await completed
    const snapshot = loop.getSnapshot(0)
    assert.equal(calls, 2, JSON.stringify(loop.exportState().artifacts, null, 2))
    assert.equal(snapshot.variables.value.context.history_summary, 'summary produced by Hook')
    assert.ok(snapshot.artifacts.items.some((artifact) => artifact.kind === 'hook-result'))
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})
