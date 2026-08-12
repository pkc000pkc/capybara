import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { HookRegistry } from '#core/hooks/hook-registry'
import { HookRunner } from '#core/hooks/hook-runner'
import type { HookFixture } from '#core/hooks/types'
import { initializeProjectDirectory } from '#core/project-initializer'
import { ProjectResourceRegistry } from '#core/resources/resource-registry'
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
  const llm: RuntimeLlm = {
    chat: async () => ({
      provider: 'custom',
      model: 'hook-model',
      text: JSON.stringify({ status: 'completed', content: responses.shift() ?? 'done' }),
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
    await runLoopOnce(loop, 'install-generated-hook', 1)
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
  } finally {
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
  const hookFile = path.join(projectDir, 'hooks', 'test-context-compression.ts')
  const source = fs.readFileSync(
    path.join(projectDir, '.capybara', 'hooks', 'context-compression.ts'),
    'utf8',
  )
    .replaceAll('context-compression', 'test-context-compression')
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
