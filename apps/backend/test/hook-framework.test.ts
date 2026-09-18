import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { HookRegistry } from '#core/hooks/hook-registry'
import { HookRunError, HookRunner, type HookLlmActivity } from '#core/hooks/hook-runner'
import type { HookFixture } from '#core/hooks/types'
import { initializeProjectDirectory } from '#core/project-initializer'
import { ProjectResources } from '#core/project-resources'
import { ProjectResourceRegistry } from '#core/resources/resource-registry'
import { verifyResearchLedger } from '#core/research-ledger'
import type { RuntimeLlm } from '#core/runtime-loop'
import { RuntimeLoop } from '#core/runtime-loop'
import type { ClientCommand } from '#protocol/runtime-protocol'

const SOURCE = `import { defineHook } from "@capybara-agent/sdk";

export default defineHook({
  name: "summary-hook",
  description: "Test after-Loop processing.",
  enabled: true,
  trigger({ status, changed }) {
    return status.messageCount >= 2 && changed.has("builtin.sys_message");
  },
  schedule: { priority: 10, timeoutMs: 2000, onError: "continue" },
  permissions: { llm: "project", variables: "patch", messages: "replace" },
  parameters: [{ key: "summaryTokens", label: "Summary tokens", defaultValue: "1200", input: "number", min: 100, max: 4000 }],
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
        system_variables_revision: '',
        prompts: {}, missing_prompts: [], sys_message: [],
        cache: {
          version: 1,
          summary: '',
          messages: [],
          loop: { run_id: 'run-test', iteration: 1, tool_round: 0, continuation_round: 0 },
          compression_count: 0,
          compressed_at: '',
        },
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

function generatedHookSource(name: string): string {
  return `import { defineHook } from "@capybara-agent/sdk";

export default defineHook({
  name: "${name}",
  description: "Generated test Hook.",
  enabled: true,
  trigger() { return true; },
  schedule: { priority: 0, timeoutMs: 2000, onError: "continue" },
  permissions: { artifacts: "write" },
  run() { return { artifacts: [{ title: "generated execution", value: { ok: true } }] }; },
});
`
}

async function runLoopOnce(loop: RuntimeLoop, id: string, sequence: number): Promise<void> {
  const completed = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Runtime test timed out: ${id}`)), 5000)
    const unsubscribe = loop.onEvent((event) => {
      if (event.type !== 'run.state.changed') return
      if (event.payload.status === 'completed') {
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      } else if (event.payload.status === 'failed') {
        clearTimeout(timeout)
        unsubscribe()
        reject(new Error(event.payload.failure?.message ?? 'runtime failed'))
      }
    })
  })
  const command: ClientCommand = {
    version: 1,
    kind: 'command',
    id,
    type: 'chat.message.send',
    sessionId: 'hook-authoring-session',
    timestamp: new Date().toISOString(),
    payload: {
      clientMessageId: `${id}-message`,
      content: [{ type: 'text', text: id }],
      autoStart: true,
    },
  }
  loop.validate(command)
  loop.execute(command, sequence)
  await completed
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
    assert.deepEqual(structuredClone(valid?.parameters), [{
      key: 'summaryTokens',
      label: 'Summary tokens',
      defaultValue: '1200',
      input: 'number',
      min: 100,
      max: 4000,
    }])
    assert.ok(valid?.triggerInputs.includes('changed.builtin.sys_message'))
    assert.equal(invalid?.loadable, false)
    assert.match(invalid?.diagnostics[0]?.message ?? '', /match file name/)
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('Hook registry separates read-only system Hooks from user Hooks', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-hook-levels-'))
  const systemDirectory = path.join(projectDir, '.capybara', 'hooks')
  const projectDirectory = path.join(projectDir, 'hooks')
  fs.mkdirSync(systemDirectory, { recursive: true })
  fs.mkdirSync(projectDirectory, { recursive: true })
  fs.writeFileSync(path.join(systemDirectory, 'system-hook.ts'), SOURCE.replaceAll('summary-hook', 'system-hook'))
  fs.writeFileSync(path.join(projectDirectory, 'user-hook.ts'), SOURCE.replaceAll('summary-hook', 'user-hook'))
  try {
    const registry = new HookRegistry(projectDir)
    assert.deepEqual(registry.listSystem().map((hook) => hook.id), ['system-hook'])
    assert.deepEqual(registry.listProject().map((hook) => hook.id), ['user-hook'])
    assert.deepEqual(registry.list().map((hook) => hook.id), ['system-hook', 'user-hook'])
    assert.throws(
      () => registry.save('system-hook', SOURCE, registry.listSystem()[0]?.revision ?? ''),
      /not found/,
    )
    assert.throws(
      () => registry.create('system-hook', SOURCE.replaceAll('summary-hook', 'system-hook')),
      /conflicts with system Hook/,
    )
    fs.writeFileSync(path.join(projectDirectory, 'system-hook.ts'), SOURCE.replaceAll('summary-hook', 'system-hook'))
    registry.reload()
    const conflictingHook = registry.getProject('system-hook')
    assert.equal(conflictingHook?.loadable, false)
    assert.throws(
      () => registry.save('system-hook', conflictingHook?.source ?? '', conflictingHook?.revision ?? ''),
      /conflicts with system Hook/,
    )
    assert.deepEqual(registry.list().map((hook) => hook.id), ['system-hook', 'user-hook'])
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('Hook registry validates an entire generated batch before creating files', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-hook-batch-'))
  initializeProjectDirectory(projectDir)
  try {
    const registry = new HookRegistry(projectDir)
    const privileged = generatedHookSource('privileged-hook')
      .replace('permissions: { artifacts: "write" }', 'permissions: { hooks: "write" }')
    assert.throws(
      () => registry.createMany([
        { name: 'batch-valid', source: generatedHookSource('batch-valid') },
        { name: 'privileged-hook', source: privileged },
      ]),
      /reserved for system Hooks/,
    )
    assert.equal(fs.existsSync(path.join(projectDir, 'hooks', 'batch-valid.ts')), false)
    assert.equal(fs.existsSync(path.join(projectDir, 'hooks', 'privileged-hook.ts')), false)
    const existingSource = generatedHookSource('existing-hook')
    registry.create('existing-hook', existingSource)
    assert.throws(
      () => registry.create('existing-hook', existingSource.replace('Generated test', 'Changed')),
      /already exists/,
    )
    assert.equal(
      fs.readFileSync(path.join(projectDir, 'hooks', 'existing-hook.ts'), 'utf8'),
      existingSource,
    )
    assert.throws(
      () => registry.create('hook-authoring', generatedHookSource('hook-authoring')),
      /conflicts with system Hook/,
    )
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('Runtime upgrades system Hook resources and keeps them outside the editable catalog', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-hook-upgrade-'))
  initializeProjectDirectory(projectDir)
  const authoringHook = path.join(projectDir, '.capybara', 'hooks', 'hook-authoring.ts')
  const authoringManifest = path.join(
    projectDir,
    '.capybara',
    'harnesses',
    'hook-authoring',
    'manifest.json',
  )
  fs.writeFileSync(authoringHook, 'outdated system Hook')
  fs.rmSync(authoringManifest)
  const loop = new RuntimeLoop({ projectDir, stepDelayMs: 0, streamDelayMs: 0 })
  try {
    assert.equal(new HookRegistry(projectDir).get('hook-authoring')?.loadable, true)
    assert.equal(fs.existsSync(authoringManifest), true)
    const snapshot = loop.getSnapshot(0)
    assert.ok(snapshot.harnesses.catalog.some((item) => item.id === 'capybara-system:hook-authoring'))
    assert.ok(snapshot.harnesses.items.some((item) => (
      item.id === 'capybara-system:hook-authoring' && item.status === 'active'
    )))
    const editable = new ProjectResourceRegistry(projectDir).list().items
    assert.equal(editable.some((item) => item.id.includes('capybara-system')), false)
    assert.equal(editable.some((item) => (
      item.kind === 'hook' && item.hooks.some((hook) => hook.id === 'hook-authoring')
    )), false)
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('Runtime installs a generated user Hook and executes it on the next Loop', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-hook-authoring-'))
  initializeProjectDirectory(projectDir)
  const responses = [
    `Created the Hook.\n\n\`\`\`capybara-hook name=generated-a\n${generatedHookSource('generated-a')}\`\`\``,
    'Second response without a generated file.',
  ]
  let inspectedAuthoringProtocol = false
  const llm: RuntimeLlm = {
    chat: async (request) => {
      if (!inspectedAuthoringProtocol) {
        const systemPrompt = request.messages[0]?.content ?? ''
        assert.match(systemPrompt, /durable recurring behavior/)
        assert.match(systemPrompt, /loop\.terminal/)
        assert.match(systemPrompt, /Prefer a system variable when static context is sufficient/)
        inspectedAuthoringProtocol = true
      }
      return {
        provider: 'custom',
        model: 'hook-model',
        text: JSON.stringify({ status: 'completed', content: responses.shift() ?? 'done' }),
        usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
        raw: {},
      }
    },
    getConfig: () => ({
      provider: 'custom', protocol: 'responses', model: 'hook-model',
      baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0,
    }),
  }
  const loop = new RuntimeLoop({ projectDir, llm, stepDelayMs: 0, streamDelayMs: 0 })
  const activityPhases: string[] = []
  const unsubscribe = loop.onEvent((event) => {
    if (event.type === 'runtime.status.updated' && event.payload.activity?.phase) {
      activityPhases.push(event.payload.activity.phase)
    }
  })
  try {
    await runLoopOnce(loop, 'install-generated-hook', 1)
    assert.equal(inspectedAuthoringProtocol, true)
    const generatedFile = path.join(projectDir, 'hooks', 'generated-a.ts')
    assert.equal(fs.readFileSync(generatedFile, 'utf8'), generatedHookSource('generated-a'))
    assert.equal(new HookRegistry(projectDir).getProject('generated-a')?.loadable, true)
    assert.ok(loop.getSnapshot(0).artifacts.items.some(
      (artifact) => artifact.label === 'Hook installed · generated-a',
    ))

    await runLoopOnce(loop, 'execute-generated-hook', 2)
    assert.ok(loop.getSnapshot(0).artifacts.items.some(
      (artifact) => artifact.label === 'generated execution',
    ))
    assert.ok(activityPhases.includes('hook_running'))
  } finally {
    unsubscribe()
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('parallel Runtime sessions serialize generated Hook writes in one project', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-hook-parallel-'))
  initializeProjectDirectory(projectDir)
  const authoringLlm = (name: string): RuntimeLlm => ({
    chat: async () => ({
      provider: 'custom',
      model: 'hook-model',
      text: JSON.stringify({
        status: 'completed',
        content: `\`\`\`capybara-hook name=${name}\n${generatedHookSource(name)}\`\`\``,
      }),
      usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
      raw: {},
    }),
    getConfig: () => ({
      provider: 'custom', protocol: 'responses', model: 'hook-model',
      baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0,
    }),
  })
  const first = new RuntimeLoop({
    projectDir,
    llm: authoringLlm('parallel-first'),
    stepDelayMs: 0,
    streamDelayMs: 0,
  })
  const second = new RuntimeLoop({
    projectDir,
    llm: authoringLlm('parallel-second'),
    stepDelayMs: 0,
    streamDelayMs: 0,
  })
  try {
    await Promise.all([
      runLoopOnce(first, 'parallel-first-run', 1),
      runLoopOnce(second, 'parallel-second-run', 1),
    ])
    const hooks = new HookRegistry(projectDir).listProject()
    assert.deepEqual(
      hooks.map((hook) => hook.id).sort(),
      ['parallel-first', 'parallel-second'],
    )
    assert.ok(hooks.every((hook) => hook.loadable))
  } finally {
    first.close()
    second.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('Runtime rejects invalid generated Hook source without creating a file', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-hook-invalid-'))
  initializeProjectDirectory(projectDir)
  const llm: RuntimeLlm = {
    chat: async () => ({
      provider: 'custom',
      model: 'hook-model',
      text: JSON.stringify({
        status: 'completed',
        content: '```capybara-hook name=invalid-generated\nexport default {\n```',
      }),
      usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
      raw: {},
    }),
    getConfig: () => ({
      provider: 'custom', protocol: 'responses', model: 'hook-model',
      baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0,
    }),
  }
  const loop = new RuntimeLoop({ projectDir, llm, stepDelayMs: 0, streamDelayMs: 0 })
  try {
    await runLoopOnce(loop, 'reject-invalid-hook', 1)
    assert.equal(fs.existsSync(path.join(projectDir, 'hooks', 'invalid-generated.ts')), false)
    const failure = loop.exportState().artifacts.find(
      (artifact) => artifact.meta.label === 'Hook failed · hook-authoring',
    )
    assert.match(JSON.stringify(failure?.value ?? {}), /Hook file must|expected|Declaration/)
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('Hook runner evaluates after-Loop triggers and proxies the project LLM', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-hook-runner-'))
  const registry = new HookRegistry(projectDir)
  const hook = registry.validateContent('summary-hook', SOURCE)
  const activity: HookLlmActivity[] = []
  const llm: RuntimeLlm = {
    chat: async (request) => {
      request.onRetry?.({ phase: 'waiting', attempt: 2, maxAttempts: 5, delayMs: 1000, reason: 'upstream_error' })
      request.onRetry?.({ phase: 'attempting', attempt: 2, maxAttempts: 5, delayMs: 0, reason: 'upstream_error' })
      return {
      provider: 'custom',
      model: 'hook-model',
      text: 'durable summary',
      usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
      raw: {},
      }
    },
    getConfig: () => ({
      provider: 'custom', protocol: 'responses', model: 'hook-model',
      baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0,
    }),
  }
  try {
    const result = await new HookRunner(llm).run(hook, fixture(), undefined, {
      onLlmActivity: (event) => activity.push(event),
    })
    assert.equal(result.matched, true)
    assert.equal(result.result?.patches?.[0]?.op, 'replace')
    assert.equal(result.result?.patches?.[0] && 'value' in result.result.patches[0]
      ? result.result.patches[0].value
      : undefined, 'durable summary')
    assert.equal(result.result?.messages?.length, 2)
    assert.equal(result.usage.totalTokens, 11)
    assert.deepEqual(activity.map((event) => event.phase), ['waiting', 'retrying', 'waiting', 'completed'])
    assert.equal(activity[1]?.retry?.delayMs, 1000)
    assert.equal(activity[1]?.retry?.attempt, 2)
    assert.equal(new Set(activity.map((event) => event.requestId)).size, 1)
    assert.ok(activity.every((event) => event.hookId === 'summary-hook' && event.elapsedMs >= 0))
    assert.ok(!JSON.stringify(activity).includes('durable summary'))
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('Hook model deadline allows deterministic recovery to survive a provider timeout', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-hook-deadline-'))
  const source = SOURCE.replace('const response = await llm.responses.create({ input: "summarize" });',
    'let response; try { response = await llm.responses.create({ input: "summarize", timeout_ms: 100 }); } catch { response = { output_text: "deterministic recovery" }; }')
  const hook = new HookRegistry(projectDir).validateContent('summary-hook', source)
  const llm: RuntimeLlm = {
    chat: request => new Promise((_, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('request deadline')), { once: true })
    }),
    getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'deadline-test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 60000, maxRetries: -1 }),
  }
  try {
    const result = await new HookRunner(llm).run(hook, fixture())
    const patch = result.result?.patches?.[0]
    assert.ok(patch && 'value' in patch)
    assert.equal(patch.value, 'deterministic recovery')
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }) }
})

test('Hook active-runtime timeout excludes provider retry time', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-hook-retry-time-'))
  const source = SOURCE.replace('timeoutMs: 2000', 'timeoutMs: 200')
  const hook = new HookRegistry(projectDir).validateContent('summary-hook', source)
  const llm: RuntimeLlm = {
    chat: async request => {
      request.onRetry?.({
        phase: 'waiting', attempt: 2, maxAttempts: -1, delayMs: 300,
        excludedMs: 500, reason: 'upstream timeout',
      })
      await delay(300)
      return { provider: 'custom', model: 'hook-model', text: 'recovered', raw: {} }
    },
    getConfig: () => ({
      provider: 'custom', protocol: 'responses', model: 'hook-model',
      baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: -1,
    }),
  }
  try {
    const result = await new HookRunner(llm).run(hook, fixture())
    assert.equal(result.matched, true)
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }) }
})

test('Hook model activity reports cancellation once and ignores late provider retries', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-hook-cancel-activity-'))
  const hook = new HookRegistry(projectDir).validateContent('summary-hook', SOURCE)
  const controller = new AbortController()
  const activity: HookLlmActivity[] = []
  let capturedRequest: Parameters<RuntimeLlm['chat']>[0] | undefined
  const llm: RuntimeLlm = {
    chat: async (request) => {
      capturedRequest = request
      controller.abort()
      throw new Error('aborted')
    },
    getConfig: () => ({
      provider: 'custom', protocol: 'responses', model: 'hook-model',
      baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0,
    }),
  }
  try {
    await assert.rejects(new HookRunner(llm).run(hook, fixture(), controller.signal, {
      onLlmActivity: (event) => activity.push(event),
    }), /aborted/)
    capturedRequest?.onRetry?.({ phase: 'waiting', attempt: 2, maxAttempts: -1, delayMs: 5000, reason: 'late' })
    assert.deepEqual(activity.map((event) => event.phase), ['waiting', 'failed'])
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('Hook runner preserves LLM usage from failed retry attempts', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-hook-retry-usage-'))
  const source = SOURCE
    .replace('onError: "continue"', 'onError: "retry"')
    .replace('return {\n      patches:', 'throw new Error("fail after LLM usage");\n    return {\n      patches:')
  const hook = new HookRegistry(projectDir).validateContent('summary-hook', source)
  const llm: RuntimeLlm = {
    chat: async () => ({
      provider: 'custom', model: 'hook-model', text: 'unused',
      usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11, cacheReadTokens: 2 }, raw: {},
    }),
    getConfig: () => ({
      provider: 'custom', protocol: 'responses', model: 'hook-model',
      baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0,
    }),
  }
  try {
    await assert.rejects(
      () => new HookRunner(llm).run(hook, fixture()),
      (error: unknown) => {
        assert.ok(error instanceof HookRunError)
        assert.equal(error.attempts, 2)
        assert.deepEqual(error.usage, {
          inputTokens: 16, outputTokens: 6, totalTokens: 22, cacheReadTokens: 4,
        })
        return true
      },
    )
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('Cache compression bounds escaped oversized tool results and preserves recent tool pairs', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-chunk-cache-'))
  initializeProjectDirectory(projectDir)
  const hook = new HookRegistry(projectDir).list().find((item) => item.id === 'context-compression')!
  const input = fixture()
  input.changedVariables = ['builtin.cache']
  input.variables.builtin.cache.messages = [
    { role: 'user', content: 'preserve the original task' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'old', name: 'fetch', arguments: {} }] },
    { role: 'tool', toolCallId: 'old', content: 'escaped "\\\\" content '.repeat(9000) },
    { role: 'assistant', content: 'intermediate conclusion' },
    { role: 'user', content: 'verify it' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'recent', name: 'calculate', arguments: {} }] },
    { role: 'tool', toolCallId: 'recent', content: '42' },
  ]
  const original = structuredClone(input.variables)
  input.status.context = {
    usedTokens: Math.ceil(JSON.stringify(input.variables.builtin.cache.messages).length / 4) + 1000,
    maxTokens: 16000, utilization: 1,
  }
  let requests = 0
  const llm: RuntimeLlm = {
    getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'test',
      baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }),
    chat: async (request) => {
      requests += 1
      assert.ok(Math.ceil(JSON.stringify(request.messages).length / 4) < 8000)
      return { provider: 'custom', model: 'test', text: 'Evidence summary with source references.', raw: {} }
    },
  }
  try {
    const result = await new HookRunner(llm).run(hook, input)
    assert.ok(requests > 1)
    assert.deepEqual(input.variables, original)
    const cache = (result.result!.patches![0] as unknown as { value: typeof input.variables.builtin.cache }).value
    assert.deepEqual(cache.messages, input.variables.builtin.cache.messages.slice(3))
    assert.ok(JSON.stringify(cache).length / 4 < 8000)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(new HookRunner(llm).run(hook, input, controller.signal), /aborted/)
    let failures = 0
    await assert.rejects(new HookRunner({
      ...llm, chat: async () => { failures += 1; throw new Error('gateway unavailable') },
    }).run(hook, input), /gateway unavailable/)
    assert.equal(failures, 2)
    assert.deepEqual(input.variables, original, 'failed attempts must not replace Cache')
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('Cache compression triggers before the hard input limit', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-proactive-cache-'))
  initializeProjectDirectory(projectDir)
  const hook = new HookRegistry(projectDir).list().find((item) => item.id === 'context-compression')!
  const input = fixture()
  input.changedVariables = ['builtin.cache']
  input.variables.builtin.cache.messages = [{ role: 'user', content: 'evidence '.repeat(5000) }]
  input.status.context = { usedTokens: 13000, maxTokens: 16000, utilization: 0.8125 }
  const llm: RuntimeLlm = {
    getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'test',
      baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }),
    chat: async () => ({ provider: 'custom', model: 'test', text: 'compact evidence', raw: {} }),
  }
  try {
    assert.equal((await new HookRunner(llm).run(hook, input)).matched, true)
    input.status.context.usedTokens = 12000
    assert.equal((await new HookRunner(llm).run(hook, input)).matched, false)
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('Large tool results remain readable in bounded pages without exposing other artifacts', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-artifact-pages-'))
  initializeProjectDirectory(projectDir)
  const loop = new RuntimeLoop({ projectDir })
  const access = loop as unknown as {
    createArtifact(kind: string, title: string, value: unknown, correlationId: string): { id: string }
    boundedToolContent(id: string, value: unknown): string
    readRuntimeArtifactTool(args: unknown): { content: string; next_offset: number | null }
  }
  try {
    const original = { ok: true, result: 'quoted " evidence\\n'.repeat(15000) }
    const text = JSON.stringify(original)
    const artifact = access.createArtifact('tool-result', 'Large webpage', original, 'test')
    const shortened = JSON.parse(access.boundedToolContent(artifact.id, original))
    assert.equal(shortened.abbreviated, true)
    assert.equal(shortened.artifact_id, artifact.id)
    assert.ok(JSON.stringify(shortened).length < 16000)
    let offset: number | null = 0
    let reconstructed = ''
    while (offset !== null) {
      const page = access.readRuntimeArtifactTool({ artifact_id: artifact.id, offset, limit: 8000 })
      assert.ok(page.content.length <= 8000)
      reconstructed += page.content
      offset = page.next_offset
    }
    assert.equal(reconstructed, text)
    assert.throws(() => access.readRuntimeArtifactTool({ artifact_id: artifact.id, limit: 9000 }))
    assert.throws(() => access.readRuntimeArtifactTool({ artifact_id: artifact.id, offset: -1 }))
    const privateArtifact = access.createArtifact('model-request', 'Private diagnostics', { content: 'private' }, 'test')
    assert.throws(() => access.readRuntimeArtifactTool({ artifact_id: privateArtifact.id }), /not found/)
    assert.throws(() => access.readRuntimeArtifactTool({ artifact_id: 'other-session-artifact' }), /not found/)
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('Runtime compresses only Cache after a model iteration exceeds the context limit', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-hook-runtime-'))
  initializeProjectDirectory(projectDir)
  const largeCacheMarker = `old-cache-content-${'x'.repeat(80_000)}`
  let runtimeCalls = 0
  let hookCalls = 0
  const runtimeRequests: Parameters<RuntimeLlm['chat']>[0][] = []
  const llm: RuntimeLlm = {
    chat: async (request) => {
      const hookCall = request.messages.some((message) => message.content.includes('Compress the runtime Cache'))
      if (hookCall) hookCalls += 1
      else {
        runtimeCalls += 1
        runtimeRequests.push(structuredClone({ ...request, signal: undefined }))
      }
      return {
        provider: 'custom',
        model: 'hook-model',
        text: hookCall
          ? 'compressed cache summary'
          : JSON.stringify(runtimeCalls === 1
            ? { status: 'running', content: largeCacheMarker }
            : { status: 'completed', content: 'runtime answer' }),
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
    const state = loop.exportState()
    const hookArtifacts = state.artifacts.filter((artifact) => (
      artifact.meta.kind === 'hook-result'
      && (artifact.value as { hookId?: string }).hookId === 'context-compression'
    ))
    assert.equal(runtimeCalls, 2, JSON.stringify(state.artifacts, null, 2))
    assert.ok(hookCalls > 1, 'large Cache must use multiple bounded compression requests')
    assert.ok(runtimeRequests[1]?.messages.some((message) => (
      message.name === 'capybara_cache_summary'
      && message.content.includes('compressed cache summary')
    )))
    assert.equal(JSON.stringify(runtimeRequests[1]?.messages).includes(largeCacheMarker), false)
    assert.ok(snapshot.variables.value.builtin.cache.summary.includes('compressed cache summary'))
    assert.equal(snapshot.variables.value.builtin.cache.compression_count, 1)
    assert.equal(snapshot.variables.value.context.history_summary, '')
    assert.ok(hookArtifacts.some((artifact) => (
      (artifact.value as { matched?: boolean; loopIteration?: number }).matched === true
      && (artifact.value as { loopIteration?: number }).loopIteration === 1
    )))
    const restored = new RuntimeLoop({
      projectDir,
      llm,
      initialState: loop.exportState(),
      stepDelayMs: 0,
      streamDelayMs: 0,
    })
    try {
      const restoredCache = restored.getSnapshot(0).variables.value.builtin.cache
      assert.equal(restoredCache.summary, snapshot.variables.value.builtin.cache.summary)
      assert.equal(restoredCache.compression_count, 1)
      assert.ok(restored.exportState().llmMessages.some((message) => (
        message.name === 'capybara_cache_summary'
        && message.content.includes('compressed cache summary')
      )))
    } finally {
      restored.close()
    }
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('Runtime invokes the same Cache compression Hook before a model request after its limit is lowered', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-hook-preflight-cache-'))
  initializeProjectDirectory(projectDir)
  const resources = new ProjectResources(projectDir)
  resources.saveSettings({
    ...resources.readSettings(),
    context: {
      context_window_tokens: 200_000,
      max_input_tokens: 150_000,
      reserved_output_tokens: 20_000,
    },
  })
  const largeCacheMarker = `oversized-existing-cache-${'y'.repeat(80_000)}`
  let runtimeCalls = 0
  let hookCalls = 0
  const runtimeRequests: Parameters<RuntimeLlm['chat']>[0][] = []
  const llm: RuntimeLlm = {
    chat: async (request) => {
      const hookCall = request.messages.some((message) => message.content.includes('Compress the runtime Cache'))
      if (hookCall) {
        hookCalls += 1
        return {
          provider: 'custom', model: 'hook-model', text: 'preflight cache summary', raw: {},
        }
      }
      runtimeCalls += 1
      runtimeRequests.push(structuredClone({ ...request, signal: undefined }))
      return {
        provider: 'custom', model: 'hook-model',
        text: JSON.stringify(runtimeCalls === 1
          ? { status: 'completed', content: largeCacheMarker }
          : { status: 'completed', content: 'completed after preflight compression' }),
        raw: {},
      }
    },
    getConfig: () => ({
      provider: 'custom', protocol: 'responses', model: 'hook-model',
      baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0,
    }),
  }
  const loop = new RuntimeLoop({ projectDir, llm, stepDelayMs: 0, streamDelayMs: 0 })
  try {
    await runLoopOnce(loop, 'preflight-cache-seed', 1)
    assert.equal(hookCalls, 0)
    resources.saveSettings({
      ...resources.readSettings(),
      context: {
        context_window_tokens: 16_000,
        max_input_tokens: 16_000,
        reserved_output_tokens: 2_000,
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    await runLoopOnce(loop, 'preflight-cache-after-limit-change', 2)
    assert.ok(hookCalls > 1)
    assert.equal(runtimeCalls, 2)
    assert.ok(runtimeRequests[1]?.messages.some((message) => (
      message.name === 'capybara_cache_summary'
      && message.content.includes('preflight cache summary')
    )))
    assert.equal(JSON.stringify(runtimeRequests[1]?.messages).includes(largeCacheMarker), false)
    const cache = loop.getSnapshot(0).variables.value.builtin.cache
    assert.ok(cache.summary.includes('preflight cache summary'))
    assert.equal(cache.compression_count, 1)
    assert.ok(loop.exportState().artifacts.some((artifact) => (
      artifact.meta.kind === 'hook-result'
      && (artifact.value as { hookId?: string; checkpoint?: string }).hookId === 'context-compression'
      && (artifact.value as { checkpoint?: string }).checkpoint === 'before_model_overflow'
    )))
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('System Cache compression Hook cannot replace messages or patch variables outside Cache', async () => {
  const cases = [
    {
      name: 'messages',
      permissions: '{ messages: "replace" }',
      result: 'return { messages };',
      runArguments: '{ messages }',
      expected: /may only modify builtin\.cache/,
    },
    {
      name: 'variables',
      permissions: '{ variables: "patch" }',
      result: 'return { patches: [{ op: "replace", path: "/context/history_summary", value: "forbidden" }] };',
      runArguments: '{}',
      expected: /may only patch builtin\.cache/,
    },
  ] as const
  for (const scenario of cases) {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `capybara-hook-cache-boundary-${scenario.name}-`))
    initializeProjectDirectory(projectDir)
    const llm: RuntimeLlm = {
      chat: async () => ({
        provider: 'custom', model: 'hook-model',
        text: JSON.stringify({ status: 'completed', content: 'runtime answer' }), raw: {},
      }),
      getConfig: () => ({
        provider: 'custom', protocol: 'responses', model: 'hook-model',
        baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0,
      }),
    }
    const loop = new RuntimeLoop({ projectDir, llm, stepDelayMs: 0, streamDelayMs: 0 })
    try {
      fs.writeFileSync(
        path.join(projectDir, '.capybara', 'hooks', 'context-compression.ts'),
        `import { defineHook } from "@capybara-agent/sdk";

export default defineHook({
  name: "context-compression",
  description: "Attempt a forbidden system compression mutation.",
  enabled: true,
  trigger() { return true; },
  schedule: { priority: 9000, timeoutMs: 2000, onError: "continue" },
  permissions: ${scenario.permissions},
  run(${scenario.runArguments}) { ${scenario.result} },
});
`,
      )
      await new Promise((resolve) => setTimeout(resolve, 250))
      await runLoopOnce(loop, `hook-cache-boundary-${scenario.name}`, 1)
      const errorArtifact = loop.exportState().artifacts.find((artifact) => (
        artifact.meta.kind === 'runtime-error'
        && (artifact.value as { hookId?: string }).hookId === 'context-compression'
      ))
      assert.match((errorArtifact?.value as { message?: string } | undefined)?.message ?? '', scenario.expected)
      assert.equal(loop.getSnapshot(0).variables.value.context.history_summary, '')
    } finally {
      loop.close()
      fs.rmSync(projectDir, { recursive: true, force: true })
    }
  }
})

test('Runtime runs an ordinary Hook once after a multi-tool batch and once after the final model iteration', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-hook-tool-batch-'))
  initializeProjectDirectory(projectDir)
  fs.writeFileSync(path.join(projectDir, 'hooks', 'batch-hook.ts'), generatedHookSource('batch-hook'))
  let runtimeCalls = 0
  const llm: RuntimeLlm = {
    chat: async () => {
      runtimeCalls += 1
      return runtimeCalls === 1
        ? {
            provider: 'custom',
            model: 'hook-model',
            text: '',
            toolCalls: [
              { id: 'search-tools', name: 'search_resources', arguments: { query: 'file', kinds: ['tool'] } },
              { id: 'search-hooks', name: 'search_resources', arguments: { query: 'context', kinds: ['hook'] } },
            ],
            raw: {},
          }
        : {
            provider: 'custom',
            model: 'hook-model',
            text: JSON.stringify({ status: 'completed', content: 'tool batch complete' }),
            raw: {},
          }
    },
    getConfig: () => ({
      provider: 'custom', protocol: 'responses', model: 'hook-model',
      baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0,
    }),
  }
  const loop = new RuntimeLoop({ projectDir, llm, stepDelayMs: 0, streamDelayMs: 0 })
  try {
    await runLoopOnce(loop, 'hook-tool-batch', 1)
    const hookArtifacts = loop.exportState().artifacts.filter((artifact) => (
      artifact.meta.kind === 'hook-result'
      && (artifact.value as { hookId?: string }).hookId === 'batch-hook'
    ))
    assert.equal(runtimeCalls, 2)
    assert.deepEqual(hookArtifacts.map((artifact) => (
      (artifact.value as { loopIteration?: number }).loopIteration
    )), [1, 2])
    const cache = loop.getSnapshot(0).variables.value.builtin.cache
    const messages = cache.messages as Array<{
      role?: string
      toolCalls?: Array<{ id?: string; name?: string; arguments?: unknown }>
      toolCallId?: string
    }>
    const toolCallingMessage = messages.find((message) => Array.isArray(message.toolCalls))
    assert.deepEqual(toolCallingMessage?.toolCalls?.map((call) => call.id), ['search-tools', 'search-hooks'])
    assert.deepEqual(messages.filter((message) => message.role === 'tool').map((message) => (
      message.toolCallId
    )), ['search-tools', 'search-hooks'])
    assert.equal(cache.loop.iteration, 2)
    assert.equal(cache.loop.tool_round, 1)
    assert.equal(cache.loop.continuation_round, 0)
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('Runtime exposes terminal loop state and keeps session Hook patches out of project variables', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-hook-terminal-session-'))
  initializeProjectDirectory(projectDir)
  const resources = new ProjectResources(projectDir)
  const projectValue = resources.readSystemVariables().variables.find(
    (variable) => variable.key === 'agent_identity',
  )?.value
  fs.writeFileSync(path.join(projectDir, 'hooks', 'terminal-session.ts'), `import { defineHook } from "@capybara-agent/sdk";

export default defineHook({
  name: "terminal-session",
  description: "Record terminal state and patch a session-only variable.",
  enabled: true,
  trigger() { return true; },
  schedule: { priority: 0, timeoutMs: 2000, onError: "continue" },
  permissions: { variables: "patch", artifacts: "write" },
  run({ loop }) {
    const value = "loop-" + loop.iteration + "-terminal-" + loop.terminal;
    return {
      patches: [{ op: "replace", path: "/builtin/prompts/agent_identity", value }],
      artifacts: [{ title: "terminal state", value: { iteration: loop.iteration, terminal: loop.terminal } }],
    };
  },
});
`)
  let runtimeCalls = 0
  const llm: RuntimeLlm = {
    chat: async () => {
      runtimeCalls += 1
      return {
        provider: 'custom',
        model: 'hook-model',
        text: JSON.stringify(runtimeCalls === 1
          ? { status: 'running', content: 'continue' }
          : { status: 'completed', content: 'done' }),
        raw: {},
      }
    },
    getConfig: () => ({
      provider: 'custom', protocol: 'responses', model: 'hook-model',
      baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0,
    }),
  }
  const loop = new RuntimeLoop({ projectDir, llm, stepDelayMs: 0, streamDelayMs: 0 })
  try {
    await runLoopOnce(loop, 'hook-terminal-session', 1)
    const hookArtifacts = loop.exportState().artifacts.filter((artifact) => (
      artifact.meta.kind === 'hook-result'
      && (artifact.value as { hookId?: string }).hookId === 'terminal-session'
    ))
    const executions = hookArtifacts.map((artifact) => artifact.value as {
      loopIteration?: number
      result?: { artifacts?: Array<{ value?: { terminal?: boolean } }> }
    })
    assert.equal(runtimeCalls, 2)
    assert.deepEqual(executions.map((execution) => execution.loopIteration), [1, 2])
    assert.deepEqual(executions.map((execution) => (
      execution.result?.artifacts?.[0]?.value?.terminal
    )), [false, true])
    assert.equal(
      loop.getSnapshot(0).variables.value.builtin.prompts.agent_identity,
      'loop-2-terminal-true',
    )
    assert.equal(
      resources.readSystemVariables().variables.find((variable) => variable.key === 'agent_identity')?.value,
      projectValue,
    )
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('permissioned Hook can require one bounded model continuation', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-hook-continuation-'))
  initializeProjectDirectory(projectDir)
  fs.writeFileSync(path.join(projectDir, 'hooks', 'review-continuation.ts'), `import { defineHook } from "@capybara-agent/sdk";

export default defineHook({
  name: "review-continuation",
  description: "Requires one review continuation.",
  enabled: true,
  checkpoint: "after_loop",
  trigger({ loop, variables }) {
    return loop.terminal && variables.builtin.cache.reviews.length === 0;
  },
  schedule: { priority: 1, timeoutMs: 2000, onError: "continue" },
  permissions: { variables: "patch", loop: "continue" },
  run({ loop }) {
    return {
      patches: [{ op: "replace", path: "/builtin/cache/reviews", value: [{ run_id: loop.runId, round: 1 }] }],
      loop: { action: "continue", reason: "Run one independent review." },
    };
  },
});
`, 'utf8')
  let calls = 0
  const llm: RuntimeLlm = {
    chat: async () => {
      calls += 1
      return {
        provider: 'custom',
        model: 'hook-model',
        text: JSON.stringify({ status: 'completed', content: `answer-${calls}` }),
        usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
        raw: {},
      }
    },
    getConfig: () => ({
      provider: 'custom', protocol: 'responses', model: 'hook-model',
      baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0,
    }),
  }
  const loop = new RuntimeLoop({ projectDir, llm, stepDelayMs: 0, streamDelayMs: 0 })
  try {
    await runLoopOnce(loop, 'hook-continuation', 1)
    const snapshot = loop.getSnapshot(0)
    const cache = snapshot.variables.value.builtin.cache
    assert.equal(cache.version, 2)
    if (cache.version !== 2) throw new Error('runtime cache was not upgraded')
    assert.equal(calls, 2)
    assert.equal(cache.reviews.length, 1)
    assert.equal(cache.loop.continuation_round, 1)
    assert.ok(snapshot.artifacts.items.some(
      (artifact) => artifact.label === 'Hook requested another model Loop',
    ))
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('Runtime appends permissioned Hook research events and updates the ledger head cursor', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-hook-research-ledger-'))
  initializeProjectDirectory(projectDir)
  const variablesFile = path.join(projectDir, '.capybara', 'system-variables.json')
  const variables = JSON.parse(fs.readFileSync(variablesFile, 'utf8'))
  variables.variables.push({
    key: 'research_cursor',
    type: 'object',
    label: 'Research cursor',
    description: 'Tracks the research ledger head.',
    value: { ledger_head: '' },
    required: true,
    readonly: false,
    scope: 'project',
  })
  fs.writeFileSync(variablesFile, `${JSON.stringify(variables, null, 2)}\n`)
  fs.appendFileSync(path.join(projectDir, 'main.j2'), '\n{{ builtin.variables.research_cursor.ledger_head }}\n')
  fs.writeFileSync(path.join(projectDir, 'hooks', 'research-ledger.ts'), `import { defineHook } from "@capybara-agent/sdk";

export default defineHook({
  name: "research-ledger",
  description: "Append one test research event.",
  enabled: true,
  trigger() { return true; },
  schedule: { priority: 0, timeoutMs: 2000, onError: "continue" },
  permissions: { research: "append" },
  run() {
    return {
      researchEvents: [{
        eventType: "experiment.completed",
        idempotencyKey: "experiment-E-1",
        payload: { experiment_id: "E-1", outcome: "supports" },
      }],
    };
  },
});
`)
  const llm: RuntimeLlm = {
    chat: async () => ({
      provider: 'custom', model: 'hook-model',
      text: JSON.stringify({ status: 'completed', content: 'runtime answer' }), raw: {},
    }),
    getConfig: () => ({
      provider: 'custom', protocol: 'responses', model: 'hook-model',
      baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0,
    }),
  }
  const loop = new RuntimeLoop({ projectDir, llm, stepDelayMs: 0, streamDelayMs: 0 })
  try {
    await runLoopOnce(loop, 'hook-research-ledger', 1)
    const ledger = verifyResearchLedger(projectDir)
    assert.equal(ledger.totalEvents, 1)
    assert.match(ledger.head, /^[a-f0-9]{64}$/)
    assert.equal(
      (loop.getSnapshot(0).variables.value.builtin.variables?.research_cursor as { ledger_head?: string }).ledger_head,
      ledger.head,
    )
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('Runtime runs an ordinary Hook once for a failed model iteration', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-hook-failed-iteration-'))
  initializeProjectDirectory(projectDir)
  fs.writeFileSync(path.join(projectDir, 'hooks', 'failed-iteration.ts'), `import { defineHook } from "@capybara-agent/sdk";

export default defineHook({
  name: "failed-iteration",
  description: "Observe failed Loop iterations.",
  enabled: true,
  trigger({ status }) { return status.run.status === "failed"; },
  schedule: { priority: 0, timeoutMs: 2000, onError: "continue" },
  permissions: { artifacts: "write" },
  run({ loop }) { return { artifacts: [{ title: "failed iteration", value: loop.iteration }] }; },
});
`)
  const llm: RuntimeLlm = {
    chat: async () => ({
      provider: 'custom',
      model: 'hook-model',
      text: 'invalid model output',
      raw: {},
    }),
    getConfig: () => ({
      provider: 'custom', protocol: 'responses', model: 'hook-model',
      baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0,
    }),
  }
  const loop = new RuntimeLoop({ projectDir, llm, stepDelayMs: 0, streamDelayMs: 0 })
  const failed = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('failed iteration test timed out')), 5000)
    const unsubscribe = loop.onEvent((event) => {
      if (event.type === 'run.state.changed' && event.payload.status === 'failed') {
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      }
    })
  })
  const command: ClientCommand = {
    version: 1,
    kind: 'command',
    id: 'failed-iteration-command',
    type: 'chat.message.send',
    sessionId: 'test-session',
    timestamp: new Date().toISOString(),
    payload: {
      clientMessageId: 'failed-iteration-message',
      content: [{ type: 'text', text: 'Fail this iteration.' }],
      autoStart: true,
    },
  }
  try {
    loop.validate(command)
    loop.execute(command, 1)
    await failed
    const hookArtifacts = loop.exportState().artifacts.filter((artifact) => (
      artifact.meta.kind === 'hook-result'
      && (artifact.value as { hookId?: string }).hookId === 'failed-iteration'
    ))
    assert.equal(hookArtifacts.length, 1)
    assert.equal((hookArtifacts[0]?.value as { matched?: boolean }).matched, true)
    assert.equal((hookArtifacts[0]?.value as { loopIteration?: number }).loopIteration, 1)
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('Runtime watches and hot-loads user Hook files without a restart', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-hook-watch-'))
  initializeProjectDirectory(projectDir)
  const llm: RuntimeLlm = {
    chat: async () => ({
      provider: 'custom',
      model: 'hook-model',
      text: JSON.stringify({ status: 'completed', content: 'runtime answer' }),
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      raw: {},
    }),
    getConfig: () => ({
      provider: 'custom', protocol: 'responses', model: 'hook-model',
      baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0,
    }),
  }
  const loop = new RuntimeLoop({ projectDir, llm, stepDelayMs: 0, streamDelayMs: 0 })
  let sequence = 1
  const run = async (id: string): Promise<void> => {
    const completed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('hot-load runtime test timed out')), 5000)
      const unsubscribe = loop.onEvent((event) => {
        if (event.type !== 'run.state.changed') return
        if (event.payload.status === 'completed') {
          clearTimeout(timeout)
          unsubscribe()
          resolve()
        } else if (event.payload.status === 'failed') {
          clearTimeout(timeout)
          unsubscribe()
          reject(new Error(event.payload.failure?.message ?? 'runtime failed'))
        }
      })
    })
    const command: ClientCommand = {
      version: 1,
      kind: 'command',
      id,
      type: 'chat.message.send',
      sessionId: 'test-session',
      timestamp: new Date().toISOString(),
      payload: {
        clientMessageId: `${id}-message`,
        content: [{ type: 'text', text: id }],
        autoStart: true,
      },
    }
    loop.validate(command)
    loop.execute(command, sequence)
    sequence += 1
    await completed
  }
  try {
    await run('before-user-hook')
    const reloaded = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('user Hook watch event timed out')), 3000)
      const unsubscribe = loop.onEvent((event) => {
        if (event.type !== 'runtime.status.updated' || event.correlationId !== 'resource:hooks') return
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      })
    })
    fs.writeFileSync(path.join(projectDir, 'hooks', 'hot-loaded.ts'), `import { defineHook } from "@capybara-agent/sdk";

export default defineHook({
  name: "hot-loaded",
  description: "Verify user Hook hot loading.",
  enabled: true,
  trigger() { return true; },
  schedule: { priority: 0, timeoutMs: 2000, onError: "continue" },
  permissions: { artifacts: "write" },
  run() { return { artifacts: [{ title: "hot loaded", value: { ok: true } }] }; },
});
`)
    await reloaded
    await run('after-user-hook')
    const artifacts = loop.getSnapshot(0).artifacts.items
    assert.ok(
      artifacts.some((artifact) => artifact.label === 'Hook result · hot-loaded'),
      JSON.stringify({
        hooks: new HookRegistry(projectDir).list().map((hook) => ({
          id: hook.id,
          loadable: hook.loadable,
          diagnostics: hook.diagnostics,
        })),
        artifacts,
      }, null, 2),
    )
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})
