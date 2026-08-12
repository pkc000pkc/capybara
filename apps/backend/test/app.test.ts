import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { FastifyInstance } from 'fastify'

import { buildApp } from '#app'
import {
  RuntimeLoop,
  type RuntimeLlm,
  type RuntimeLoopOptions,
  type RuntimeSkillMarketplace,
} from '#core/runtime-loop'
import type { SkillPreview } from '#core/skills/skill-marketplace'
import type { LlmChatRequest, LlmChatResponse } from '#util/llm'
import type {
  CommandPayloadMap,
  CommandType,
  EventType,
  ServerEvent,
} from '#protocol/runtime-protocol'

type EventOf<TType extends EventType> = Extract<ServerEvent, { type: TType }>

function fakeLlm(
  chat: (request: LlmChatRequest) => Promise<LlmChatResponse> = async () => ({
    provider: 'custom',
    model: 'test-model',
    text: JSON.stringify({
      status: 'completed',
      content: 'Deterministic test model response.',
    }),
    finishReason: 'stop',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 3 },
    raw: {},
  }),
) {
  return {
    chat,
    getConfig: () => ({
      provider: 'custom' as const,
      protocol: 'responses' as const,
      model: 'test-model',
      baseUrl: 'http://127.0.0.1/unused',
      timeoutMs: 1_000,
      maxRetries: 0,
    }),
  }
}

class RuntimeClient {
  readonly events: ServerEvent[] = []
  readonly closed: Promise<{ code: number; reason: string }>
  private readonly waiters = new Set<() => void>()
  private commandCounter = 0
  private sessionId?: string

  private constructor(private readonly socket: WebSocket) {
    this.closed = new Promise((resolve) => {
      socket.addEventListener('close', (event) => resolve({
        code: event.code,
        reason: event.reason,
      }), { once: true })
    })
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as ServerEvent
      this.events.push(message)
      if (message.type === 'session.attached') this.sessionId = message.sessionId
      for (const notify of this.waiters) notify()
    })
  }

  static async connect(url: string): Promise<RuntimeClient> {
    const socket = new WebSocket(url)
    const client = new RuntimeClient(socket)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener(
        'error',
        () => reject(new Error('WebSocket connection failed')),
        { once: true },
      )
    })
    await client.waitFor('runtime.snapshot')
    return client
  }

  send<TType extends CommandType>(
    type: TType,
    payload: CommandPayloadMap[TType],
    id = `command-${++this.commandCounter}`,
  ): string {
    assert.ok(this.sessionId)
    this.socket.send(
      JSON.stringify({
        version: 1,
        kind: 'command',
        id,
        type,
        sessionId: this.sessionId,
        timestamp: new Date().toISOString(),
        payload,
      }),
    )
    return id
  }

  sendRaw(value: string): void {
    this.socket.send(value)
  }

  async waitFor<TType extends EventType>(
    type: TType,
    predicate: (event: EventOf<TType>) => boolean = () => true,
    afterIndex = 0,
  ): Promise<EventOf<TType>> {
    const find = () =>
      this.events
        .slice(afterIndex)
        .find(
          (event): event is EventOf<TType> =>
            event.type === type && predicate(event as EventOf<TType>),
        )
    const existing = find()
    if (existing) return existing

    return new Promise<EventOf<TType>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(check)
        reject(
          new Error(
            `Timed out waiting for ${type}; received ${this.events
              .map((event) => event.type)
              .join(', ')}`,
          ),
        )
      }, 4_000)
      const check = () => {
        const event = find()
        if (!event) return
        clearTimeout(timeout)
        this.waiters.delete(check)
        resolve(event)
      }
      this.waiters.add(check)
    })
  }

  close(): void {
    this.socket.close()
  }
}

async function withRuntime(
  run: (client: RuntimeClient, projectDir: string, app: FastifyInstance) => Promise<void>,
  options: RuntimeLoopOptions = {},
  useProjectLlm = false,
): Promise<void> {
  const projectDir =
    options.projectDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-runtime-'))
  const ownsProject = !options.projectDir
  if (ownsProject) {
    const sourceProject = path.resolve(process.env.CAPYBARA_TEST_PROJECT_DIR ?? 'test-project')
    fs.cpSync(sourceProject, projectDir, {
      filter: (source) => {
        const relative = path.relative(sourceProject, source).replaceAll('\\', '/')
        return relative !== '.capybara/secrets.json' && !relative.startsWith('.capybara/sessions.sqlite')
      },
      recursive: true,
    })
    for (const file of ['sessions.sqlite', 'sessions.sqlite-wal', 'sessions.sqlite-shm']) {
      fs.rmSync(path.join(projectDir, '.capybara', file), { force: true })
    }
  }
  const app = await buildApp({
    runtimeLoop: {
      streamDelayMs: 1,
      stepDelayMs: 1,
      ...options,
      projectDir,
      ...(useProjectLlm ? {} : { llm: options.llm ?? fakeLlm() }),
    },
  })
  try {
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const client = await RuntimeClient.connect(
      `ws://127.0.0.1:${address.port}/ws/runtime`,
    )
    try {
      await run(client, projectDir, app)
    } finally {
      client.close()
    }
  } finally {
    await app.close()
    if (ownsProject) {
      fs.rmSync(projectDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      })
    }
  }
}

test('GET /hello returns hello', async () => {
  const app = await buildApp()
  try {
    const response = await app.inject({ method: 'GET', url: '/hello' })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { message: 'hello' })
  } finally {
    await app.close()
  }
})

test('empty project directories require confirmation and initialize a runnable project without overwriting files', async () => {
  const emptyProject = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-empty-project-'))
  const gitProject = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-empty-git-project-'))
  const nonemptyProject = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-nonempty-project-'))
  fs.mkdirSync(path.join(gitProject, '.git'))
  fs.writeFileSync(path.join(nonemptyProject, 'keep.txt'), 'keep me')
  const app = await buildApp({ runtimeLoop: { llm: fakeLlm() } })
  try {
    for (const projectDir of [emptyProject, gitProject]) {
      const inspection = await app.inject({
        method: 'POST',
        url: '/api/projects/inspect',
        payload: { path: projectDir },
      })
      assert.equal(inspection.statusCode, 200)
      assert.equal(inspection.json().status, 'empty')
      assert.deepEqual(
        fs.readdirSync(projectDir).filter((entry) => entry !== '.git'),
        [],
      )

      const initialized = await app.inject({
        method: 'POST',
        url: '/api/projects/initialize',
        payload: { path: projectDir },
      })
      assert.equal(initialized.statusCode, 200)
      assert.equal(initialized.json().status, 'ready')
      assert.deepEqual(initialized.json().files, [
        '.capybara/config.json',
        '.capybara/system-variables.json',
        'main.j2',
        'agent.md',
        '.capybara/hooks/context-compression.ts',
        '.capybara/hooks/hook-authoring.ts',
        '.capybara/harnesses/hook-authoring/manifest.json',
        '.capybara/harnesses/hook-authoring/hook-authoring.j2',
        '.capybara/harnesses/variable-authoring/manifest.json',
        '.capybara/harnesses/variable-authoring/variable-authoring.j2',
        'hooks/.gitkeep',
        'tools/files/manifest.json',
        'tools/files/runner.mjs',
        '.gitignore',
        '.gitattributes',
      ])
      assert.equal(fs.existsSync(path.join(projectDir, '.capybara', 'secrets.json')), false)
      const initializedConfig = JSON.parse(
        fs.readFileSync(path.join(projectDir, '.capybara', 'config.json'), 'utf8'),
      )
      assert.deepEqual(initializedConfig.tools, ['tools/files/manifest.json'])
      assert.deepEqual(initializedConfig.tool_permissions, [
        'filesystem:read',
        'filesystem:write',
        'filesystem:delete',
        'process:execute',
      ])

      const catalog = await app.inject({
        method: 'GET',
        url: `/api/resources/catalog?projectPath=${encodeURIComponent(projectDir)}`,
      })
      assert.equal(catalog.statusCode, 200)
      const fileTools = catalog.json().items.find((item: any) => item.package === 'project-files')
      assert.equal(catalog.json().items.some((item: any) => item.kind === 'hook'), false)
      assert.deepEqual(fileTools.tools.map((tool: any) => tool.name), [
        'read_file',
        'list_files',
        'search_file',
        'search_in_file',
        'write_file',
        'delete_file',
        'run_code',
        'run_command',
      ])

      const hookSource = `import { defineHook } from "@capybara-agent/sdk";

export default defineHook({
  name: "audit-snapshot",
  description: "Record one runtime snapshot after a Loop.",
  enabled: true,
  trigger({ status }) { return status.messageCount >= 1; },
  schedule: { priority: 5, timeoutMs: 2000, onError: "continue" },
  permissions: { artifacts: "write" },
  run({ status }) {
    return { artifacts: [{ title: "snapshot", value: { messageCount: status.messageCount } }] };
  },
});
`
      const hookUrl = `/api/resources/hooks?projectPath=${encodeURIComponent(projectDir)}`
      const auditHookUrl = `/api/resources/hooks/audit-snapshot?projectPath=${encodeURIComponent(projectDir)}`
      const createdHook = await app.inject({
        method: 'POST',
        url: hookUrl,
        payload: { name: 'audit-snapshot', content: hookSource },
      })
      assert.equal(createdHook.statusCode, 201)
      const createdHookModule = createdHook.json<any>()
      assert.equal(createdHookModule.hooks[0].checkpoint, 'after_loop')
      assert.equal(createdHookModule.hooks[0].triggerSummary, 'status')
      assert.equal(createdHookModule.source, 'hooks/audit-snapshot.ts')
      assert.equal(
        fs.existsSync(path.join(projectDir, 'hooks', 'audit-snapshot.ts')),
        true,
      )

      const savedHook = await app.inject({
        method: 'PUT',
        url: auditHookUrl,
        payload: {
          content: hookSource.replace('Record one runtime snapshot', 'Record the runtime snapshot'),
          revision: createdHookModule.revision,
        },
      })
      assert.equal(savedHook.statusCode, 200)
      const savedHookModule = savedHook.json<any>()
      assert.notEqual(savedHookModule.revision, createdHookModule.revision)

      const staleHookSave = await app.inject({
        method: 'PUT',
        url: auditHookUrl,
        payload: { content: hookSource, revision: createdHookModule.revision },
      })
      assert.equal(staleHookSave.statusCode, 409)

      const testedHook = await app.inject({
        method: 'POST',
        url: `/api/resources/hooks/audit-snapshot/test?projectPath=${encodeURIComponent(projectDir)}`,
        payload: {
          fixture: {
            status: { messageCount: 1 },
            changedVariables: ['user_message'],
            variables: {},
            messages: [{ role: 'user', content: 'test' }],
          },
        },
      })
      assert.equal(testedHook.statusCode, 200)
      assert.equal(testedHook.json().matched, true)
      assert.equal(testedHook.json().result.artifacts[0].title, 'snapshot')

      const deletedHook = await app.inject({
        method: 'DELETE',
        url: auditHookUrl,
        payload: { revision: savedHookModule.revision },
      })
      assert.equal(deletedHook.statusCode, 200)
      assert.equal(
        fs.existsSync(path.join(projectDir, 'hooks', 'audit-snapshot.ts')),
        false,
      )
      assert.equal(
        fs.existsSync(path.join(projectDir, '.capybara', 'hooks', 'context-compression.ts')),
        true,
      )

      const toolInvocation = await app.inject({
        method: 'POST',
        url: `/api/resources/tools/${encodeURIComponent('project-files:list_files')}/test?projectPath=${encodeURIComponent(projectDir)}`,
        payload: { arguments: { path: '.', recursive: false } },
      })
      assert.equal(toolInvocation.statusCode, 200)
      assert.equal(toolInvocation.json().ok, true)
      assert.ok(toolInvocation.json().output.entries.some(
        (entry: { path: string }) => entry.path === 'tools',
      ))

      const commandInvocation = await app.inject({
        method: 'POST',
        url: `/api/resources/tools/${encodeURIComponent('project-files:run_command')}/test?projectPath=${encodeURIComponent(projectDir)}`,
        payload: { arguments: { command: 'echo initialized-command' } },
      })
      assert.equal(commandInvocation.statusCode, 200)
      assert.equal(commandInvocation.json().ok, true)
      assert.match(commandInvocation.json().output.stdout, /initialized-command/)

      const ready = await app.inject({
        method: 'POST',
        url: '/api/projects/inspect',
        payload: { path: projectDir },
      })
      assert.equal(ready.statusCode, 200)
      assert.equal(ready.json().status, 'ready')

      const loop = new RuntimeLoop({ projectDir, llm: fakeLlm(), stepDelayMs: 0, streamDelayMs: 0 })
      try {
        const snapshot = loop.getSnapshot(0)
        assert.equal(snapshot.renderResult?.diagnostics.length, 0)
        assert.match(snapshot.renderResult?.messages[0]?.content ?? '', /project agent running in Capybara/)
      } finally {
        loop.close()
      }
    }

    const invalidInspection = await app.inject({
      method: 'POST',
      url: '/api/projects/inspect',
      payload: { path: nonemptyProject },
    })
    assert.equal(invalidInspection.statusCode, 400)
    const rejectedInitialization = await app.inject({
      method: 'POST',
      url: '/api/projects/initialize',
      payload: { path: nonemptyProject },
    })
    assert.equal(rejectedInitialization.statusCode, 400)
    assert.equal(fs.readFileSync(path.join(nonemptyProject, 'keep.txt'), 'utf8'), 'keep me')
    assert.deepEqual(fs.readdirSync(nonemptyProject), ['keep.txt'])
  } finally {
    await app.close()
    for (const projectDir of [emptyProject, gitProject, nonemptyProject]) {
      fs.rmSync(projectDir, { recursive: true, force: true })
    }
  }
})

test('user preferences are stored outside projects', async () => {
  const userConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-user-config-'))
  const app = await buildApp({ userConfigDir })
  try {
    const initial = await app.inject({ method: 'GET', url: '/api/preferences' })
    assert.deepEqual(initial.json(), { language: 'zh-CN', color_theme: 'system' })

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/preferences',
      payload: { language: 'en', color_theme: 'dark' },
    })
    assert.deepEqual(saved.json(), { language: 'en', color_theme: 'dark' })
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(userConfigDir, 'settings.json'), 'utf8')),
      { language: 'en', color_theme: 'dark' },
    )

    const partial = await app.inject({
      method: 'PUT',
      url: '/api/preferences',
      payload: { color_theme: 'light' },
    })
    assert.deepEqual(partial.json(), { language: 'en', color_theme: 'light' })
  } finally {
    await app.close()
    fs.rmSync(userConfigDir, { recursive: true, force: true })
  }
})

test('runtime connection publishes a complete snapshot and rejects malformed commands once', async () => {
  await withRuntime(async (client) => {
    assert.deepEqual(
      client.events.slice(0, 2).map((event) => event.type),
      ['session.attached', 'runtime.snapshot'],
    )
    assert.deepEqual(
      client.events.slice(0, 2).map((event) => event.sequence),
      [1, 2],
    )

    const snapshot = await client.waitFor('runtime.snapshot')
    assert.deepEqual(
      snapshot.payload.tools.items.map((tool) => tool.name),
      [],
    )
    assert.deepEqual(
      snapshot.payload.tools.catalog.map((tool) => tool.name),
      [
        'read_file',
        'list_files',
        'search_file',
        'search_in_file',
        'write_file',
        'delete_file',
        'run_code',
        'run_command',
      ],
    )
    assert.deepEqual(
      snapshot.payload.harnesses.items.map((item) => item.id),
      ['capybara-system:hook-authoring', 'capybara-system:variable-authoring'],
    )
    assert.match(snapshot.payload.template.source, /for harness in harnesses/)
    assert.deepEqual(
      snapshot.payload.variables.value.harnesses.map((item) => item.id),
      ['capybara-system:hook-authoring', 'capybara-system:variable-authoring'],
    )
    assert.equal(snapshot.payload.timeline.steps.length, 4)
    assert.equal(snapshot.payload.renderResult?.messages[0]?.role, 'system')
    assert.match(
      snapshot.payload.renderResult?.messages[0]?.content ?? '',
      new RegExp(snapshot.payload.variables.value.builtin.workspace_path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    )
    assert.deepEqual(
      snapshot.payload.renderResult?.diagnostics.map((item) => item.message),
      ['Variable "optionalNote" is not set'],
    )

    const malformedStart = client.events.length
    client.sendRaw('{')
    const protocolError = await client.waitFor(
      'protocol.error',
      (event) => event.payload.code === 'INVALID_JSON',
      malformedStart,
    )
    assert.equal(protocolError.payload.code, 'INVALID_JSON')

    const unknownId = 'unknown-command'
    const unknownStart = client.events.length
    client.sendRaw(
      JSON.stringify({
        version: 1,
        kind: 'command',
        id: unknownId,
        type: 'run.fly',
        sessionId: snapshot.sessionId,
        timestamp: new Date().toISOString(),
        payload: {},
      }),
    )
    const rejected = await client.waitFor(
      'command.rejected',
      (event) => event.correlationId === unknownId,
      unknownStart,
    )
    assert.equal(rejected.payload.code, 'UNKNOWN_COMMAND')
    assert.equal(
      client.events.filter(
        (event) =>
          event.correlationId === unknownId &&
          (event.type === 'command.accepted' || event.type === 'command.rejected'),
      ).length,
      1,
    )
  })
})

test('releasing a project closes its active runtime and releases directory handles', async () => {
  await withRuntime(async (client, projectDir, app) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/release',
      payload: { path: projectDir },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { released: true, path: projectDir })

    const closed = await client.closed
    assert.equal(closed.code, 1000)
    assert.equal(closed.reason, 'project closed')

    const movedProjectDir = `${projectDir}-released`
    fs.renameSync(projectDir, movedProjectDir)
    fs.renameSync(movedProjectDir, projectDir)

    const staleRequest = await app.inject({
      method: 'GET',
      url: `/api/sessions?projectPath=${encodeURIComponent(projectDir)}`,
    })
    assert.equal(staleRequest.statusCode, 400)
    assert.match(staleRequest.json().error, /project is closed/)
    fs.renameSync(projectDir, movedProjectDir)
    fs.renameSync(movedProjectDir, projectDir)

    const reopenedProject = await app.inject({
      method: 'POST',
      url: '/api/projects/open',
      payload: { path: projectDir },
    })
    assert.equal(reopenedProject.statusCode, 200)

    const reopened = await app.inject({
      method: 'GET',
      url: `/api/sessions?projectPath=${encodeURIComponent(projectDir)}`,
    })
    assert.equal(reopened.statusCode, 200)
  })
})

test('a newer client supersedes the same active session without a reconnect loop', async () => {
  await withRuntime(async (client, projectDir, app) => {
    const attached = client.events.find((event) => event.type === 'session.attached')
    assert.ok(attached)
    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const replacement = await RuntimeClient.connect(
      `ws://127.0.0.1:${address.port}/ws/runtime?projectPath=${encodeURIComponent(projectDir)}&sessionId=${attached.sessionId}`,
    )
    try {
      assert.deepEqual(await client.closed, {
        code: 4001,
        reason: 'session attached in another client',
      })
      assert.equal(replacement.events.filter((event) => event.type === 'runtime.snapshot').length, 1)
    } finally {
      replacement.close()
    }
  })
})

test('HTTP project resources are persisted and watched by the runtime', async () => {
  await withRuntime(async (client, projectDir, app) => {
    const snapshot = await client.waitFor('runtime.snapshot')
    assert.match(
      snapshot.payload.variables.value.builtin.prompts.agent_identity ?? '',
      /Capybara/,
    )
    assert.equal(
      snapshot.payload.variables.value.builtin.prompts.template_level_1,
      'level1(level2(level3(leaf-value)))',
    )
    const systemVariablesResponse = await app.inject({
      method: 'GET',
      url: '/api/resources/system-variables',
    })
    const systemVariables = systemVariablesResponse.json<{
      variables: Array<{
        key: string
        readonly: boolean
        source: string
        value: string
        show_in_status: boolean
      }>
    }>()
    assert.deepEqual(
      systemVariables.variables.slice(0, 2).map(({ key, readonly, source }) => ({
        key,
        readonly,
        source,
      })),
      [
        { key: 'resource_loading', readonly: true, source: 'builtin' },
        { key: 'completion_status', readonly: true, source: 'builtin' },
      ],
    )
    const sysMessageDefinition = systemVariables.variables.find(
      (variable) => variable.key === 'sys_message',
    )
    assert.deepEqual(sysMessageDefinition, {
      key: 'sys_message',
      type: 'text',
      label: 'LLM messages',
      description: 'Runtime-managed complete LLM message list exposed as builtin.sys_message.',
      value: '',
      required: false,
      readonly: true,
      show_in_status: true,
      source: 'builtin',
    })
    assert.deepEqual(snapshot.payload.variables.value.builtin.sys_message, [])
    assert.equal(snapshot.payload.status.messageCount, 0)

    const variablesStart = client.events.length
    const variablesResponse = await app.inject({
      method: 'PUT',
      url: '/api/resources/system-variables',
      payload: {
        version: 1,
        variables: [
          {
            key: 'agent_identity',
            label: 'Agent identity',
            description: 'Required prompt',
            value: '',
            required: true,
            show_in_status: false,
          },
          {
            key: 'execution_policy',
            label: 'Execution policy',
            description: 'Runtime policy',
            value: 'Updated through HTTP.',
            required: true,
            show_in_status: true,
          },
        ],
      },
    })
    assert.equal(variablesResponse.statusCode, 200)
    const storedVariables = JSON.parse(
      fs.readFileSync(
        path.join(projectDir, '.capybara', 'system-variables.json'),
        'utf8',
      ),
    ).variables as Array<{ key: string; value: string }>
    assert.equal(
      storedVariables.find((variable) => variable.key === 'execution_policy')?.value,
      'Updated through HTTP.',
    )
    assert.equal(storedVariables.some((variable) => variable.key === 'sys_message'), false)
    await client.waitFor(
      'variables.updated',
      (event) => event.payload.patch.some((operation) => operation.path === '/builtin/prompts'),
      variablesStart,
    )
    const warningRender = await client.waitFor(
      'render.result.updated',
      (event) => event.payload.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'MISSING_SYSTEM_VARIABLE' &&
          diagnostic.message.includes('builtin.prompts.agent_identity'),
      ),
      variablesStart,
    )
    assert.equal(
      warningRender.payload.diagnostics.some(
        (diagnostic) => diagnostic.code === 'MISSING_SYSTEM_VARIABLE_REFERENCE',
      ),
      false,
    )
    const statusUpdate = await client.waitFor(
      'runtime.status.updated',
      (event) => event.payload.variableTokens.some(
        (variable) => variable.key === 'execution_policy' && variable.tokens > 0,
      ),
      variablesStart,
    )
    assert.ok(statusUpdate.payload.variableTokens.some(
      (variable) => variable.key === 'sys_message' && variable.tokens >= 0,
    ))

    const immutableResponse = await app.inject({
      method: 'PUT',
      url: '/api/resources/system-variables',
      payload: {
        version: 1,
        variables: systemVariables.variables.map((variable) =>
          variable.key === 'completion_status'
            ? { ...variable, value: 'changed' }
            : variable,
        ),
      },
    })
    assert.equal(immutableResponse.statusCode, 400)
    assert.match(immutableResponse.json<{ error: string }>().error, /immutable/)

    const settingsStart = client.events.length
    const settingsResponse = await app.inject({
      method: 'PUT',
      url: '/api/resources/project-settings',
      payload: {
        max_messages: 2,
        llm: {
          model: 'updated-model',
          base_url: 'http://127.0.0.1:1234/v1',
          protocol: 'chat-completions',
          api_key: 'test-project-key',
        },
      },
    })
    assert.equal(settingsResponse.statusCode, 200)
    const storedSettings = JSON.parse(
      fs.readFileSync(path.join(projectDir, '.capybara', 'config.json'), 'utf8'),
    )
    assert.deepEqual(storedSettings.llm, {
      model: 'updated-model',
      base_url: 'http://127.0.0.1:1234/v1',
      protocol: 'chat-completions',
    })
    const storedSecrets = JSON.parse(
      fs.readFileSync(path.join(projectDir, '.capybara', 'secrets.json'), 'utf8'),
    )
    assert.equal(storedSecrets.llm.api_key, 'test-project-key')
    const publicSettings = settingsResponse.json<{
      llm: { api_key: string; api_key_configured: boolean }
    }>()
    assert.equal(publicSettings.llm.api_key, '')
    assert.equal(publicSettings.llm.api_key_configured, true)
    assert.equal(settingsResponse.body.includes('test-project-key'), false)
    await client.waitFor('render.result.updated', () => true, settingsStart)

    const chatStart = client.events.length
    client.send('chat.message.send', {
      clientMessageId: 'resource-limit-message',
      content: [{ type: 'text', text: 'Validate message limit' }],
      autoStart: true,
    })
    await client.waitFor(
      'run.state.changed',
      (event) => event.payload.status === 'completed',
      chatStart,
    )
    const latestRender = client.events
      .slice(chatStart)
      .filter(
        (event): event is EventOf<'render.result.updated'> =>
          event.type === 'render.result.updated',
      )
      .at(-1)
    assert.equal(latestRender?.payload.messages[0]?.role, 'system')
    assert.ok(latestRender?.payload.messages.some((message) => message.role === 'user'))
    assert.ok(latestRender?.payload.messages.some((message) => message.role === 'assistant'))
    const snapshotStart = client.events.length
    client.send('runtime.snapshot.get', {})
    const completedSnapshot = await client.waitFor('runtime.snapshot', () => true, snapshotStart)
    assert.equal(completedSnapshot.payload.status.messageCount, 3)
    assert.deepEqual(
      completedSnapshot.payload.variables.value.builtin.sys_message.map((message) => (
        typeof message === 'object' && message && !Array.isArray(message) ? message.role : undefined
      )),
      ['system', 'user', 'assistant'],
    )
    assert.ok(completedSnapshot.payload.status.variableTokens.some(
      (variable) => variable.key === 'sys_message' && variable.tokens > 0,
    ))
  })
})

test('the next model step uses project LLM settings saved immediately beforehand', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-llm-reload-'))
  const sourceProject = path.resolve(process.env.CAPYBARA_TEST_PROJECT_DIR ?? 'test-project')
  fs.cpSync(sourceProject, projectDir, {
    filter: (source) => {
      const relative = path.relative(sourceProject, source).replaceAll('\\', '/')
      return relative !== '.capybara/secrets.json' && !relative.startsWith('.capybara/sessions.sqlite')
    },
    recursive: true,
  })

  const requests: Array<{ model: string; authorization: string }> = []
  const modelServer = http.createServer((request, response) => {
    request.setEncoding('utf8')
    let body = ''
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const payload = JSON.parse(body) as { model: string }
      requests.push({
        model: payload.model,
        authorization: String(request.headers.authorization ?? ''),
      })
      const content = JSON.stringify({
        status: 'completed',
        content: `Served by ${payload.model}.`,
      })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({
        id: `response-${requests.length}`,
        model: payload.model,
        choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }],
      })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      modelServer.once('error', onError)
      modelServer.listen(0, '127.0.0.1', () => {
        modelServer.off('error', onError)
        resolve()
      })
    })
    const address = modelServer.address()
    assert.ok(address && typeof address === 'object')
    const baseUrl = `http://127.0.0.1:${address.port}/v1`
    const configFile = path.join(projectDir, '.capybara', 'config.json')
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    config.llm = {
      model: 'model-a',
      base_url: baseUrl,
      protocol: 'chat-completions',
    }
    fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    fs.writeFileSync(
      path.join(projectDir, '.capybara', 'secrets.json'),
      `${JSON.stringify({ version: 1, llm: { api_key: 'key-a' } }, null, 2)}\n`,
      'utf8',
    )

    await withRuntime(async (client, _runtimeProjectDir, app) => {
      let start = client.events.length
      client.send('chat.message.send', {
        clientMessageId: 'llm-reload-first',
        content: [{ type: 'text', text: 'Use the initial model.' }],
        autoStart: true,
      })
      await client.waitFor(
        'run.state.changed',
        (event) => event.payload.status === 'completed',
        start,
      )

      const settingsResponse = await app.inject({
        method: 'PUT',
        url: '/api/resources/project-settings',
        payload: {
          llm: {
            model: 'model-b',
            base_url: baseUrl,
            protocol: 'chat-completions',
            api_key: 'key-b',
          },
        },
      })
      assert.equal(settingsResponse.statusCode, 200)

      start = client.events.length
      client.send('chat.message.send', {
        clientMessageId: 'llm-reload-second',
        content: [{ type: 'text', text: 'Use the updated model immediately.' }],
        autoStart: true,
      })
      await client.waitFor(
        'run.state.changed',
        (event) => event.payload.status === 'completed',
        start,
      )

      const testResponse = await app.inject({
        method: 'POST',
        url: '/api/resources/project-settings/llm/test',
        payload: {
          model: 'model-b',
          base_url: baseUrl,
          protocol: 'chat-completions',
        },
      })
      assert.equal(testResponse.statusCode, 200)
      const testResult = testResponse.json<{
        ok: boolean
        model: string
        protocol: string
        prompt_variable: string
        duration_ms: number
        finish_reason: string
      }>()
      assert.equal(testResult.ok, true)
      assert.equal(testResult.model, 'model-b')
      assert.equal(testResult.protocol, 'chat-completions')
      assert.equal(testResult.prompt_variable, 'agent_identity')
      assert.equal(testResult.finish_reason, 'stop')
      assert.ok(testResult.duration_ms >= 0)
      assert.equal(testResponse.body.includes('key-b'), false)

      assert.deepEqual(requests, [
        { model: 'model-a', authorization: 'Bearer key-a' },
        { model: 'model-b', authorization: 'Bearer key-b' },
        { model: 'model-b', authorization: 'Bearer key-b' },
      ])
    }, { projectDir }, true)
  } finally {
    await new Promise<void>((resolve) => modelServer.close(() => resolve()))
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('tool manifest changes are watched and published to the runtime', async () => {
  await withRuntime(async (client, projectDir) => {
    const start = client.events.length
    const file = path.join(projectDir, 'tools', 'files', 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    manifest.tools[0].description = 'Updated file reader definition.'
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
    const updated = await client.waitFor(
      'runtime.tools.updated',
      (event) => event.payload.catalog.some(
        (tool) => tool.name === 'read_file' && tool.description === 'Updated file reader definition.',
      ),
      start,
    )
    assert.ok(updated.payload.revision > 1)
    assert.deepEqual(updated.payload.items, [])
  })
})

test('chat input drives the runtime loop, model reply, timeline, tools, and server render', async () => {
  await withRuntime(async (client) => {
    const startIndex = client.events.length
    const commandId = client.send('chat.message.send', {
      clientMessageId: 'user-message-1',
      content: [{ type: 'text', text: '检查 WebSocket 流式链路' }],
      autoStart: true,
    })

    await client.waitFor(
      'run.state.changed',
      (event) => event.payload.status === 'completed',
      startIndex,
    )

    const events = client.events.slice(startIndex)
    assert.equal(
      events.filter(
        (event) =>
          event.correlationId === commandId && event.type === 'command.accepted',
      ).length,
      1,
    )
    assert.equal(
      events.some(
        (event) =>
          event.correlationId === commandId && event.type === 'command.rejected',
      ),
      false,
    )
    assert.equal(events.filter((event) => event.type === 'chat.user.created').length, 1)
    const finalDeltas = events.filter(
      (event): event is EventOf<'chat.assistant.delta'> =>
        event.type === 'chat.assistant.delta' && event.payload.channel === 'final',
    )
    assert.ok(finalDeltas.length >= 1)
    assert.equal(
      finalDeltas.map((event) => event.payload.delta).join(''),
      'Deterministic test model response.',
    )
    assert.equal(events.some((event) => event.type === 'chat.assistant.completed'), true)

    const rendered = events
      .filter(
        (event): event is EventOf<'render.result.updated'> =>
          event.type === 'render.result.updated',
      )
      .at(-1)
    assert.match(rendered?.payload.messages[0]?.content ?? '', /检查 WebSocket 流式链路/)
    assert.deepEqual(
      rendered?.payload.messages.slice(0, 3).map((message) => message.role),
      ['system', 'user', 'assistant'],
    )
    assert.match(rendered?.payload.messages[1]?.content ?? '', /检查 WebSocket 流式链路/)

    const succeededTypes = events
      .filter(
        (event): event is EventOf<'timeline.step.upserted'> =>
          event.type === 'timeline.step.upserted' &&
          event.payload.step.status === 'success',
      )
      .map((event) => event.payload.step.type)
    assert.deepEqual(succeededTypes, [
      'context',
      'render',
      'model',
      'output',
    ])
    const modelStep = events.find(
      (event): event is EventOf<'timeline.step.upserted'> =>
        event.type === 'timeline.step.upserted' &&
        event.payload.step.type === 'model' &&
        event.payload.step.status === 'success',
    )
    assert.equal(modelStep?.payload.step.detail?.provider, 'custom')

    for (let index = 1; index < client.events.length; index += 1) {
      assert.ok(client.events[index]!.sequence > client.events[index - 1]!.sequence)
    }
  })
})

test('runtime forwards decoded content from the native LLM stream', async () => {
  const deltas = [
    '{"status":"completed","content":"First',
    ' line\\nSecond',
    ' line"}',
  ]
  const llm = {
    ...fakeLlm(),
    stream: async (
      _request: LlmChatRequest,
      onTextDelta: (delta: string) => void,
    ): Promise<LlmChatResponse> => {
      deltas.forEach(onTextDelta)
      return {
        provider: 'custom',
        model: 'stream-model',
        text: deltas.join(''),
        finishReason: 'completed',
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
        raw: {},
      }
    },
  }
  await withRuntime(async (client) => {
    const start = client.events.length
    client.send('chat.message.send', {
      clientMessageId: 'native-stream-message',
      content: [{ type: 'text', text: 'Stream the answer' }],
      autoStart: true,
    })
    await client.waitFor('chat.assistant.completed', () => true, start)
    const streamed = client.events.slice(start)
      .filter((event) => event.type === 'chat.assistant.delta')
      .map((event) => event.payload.delta)
    assert.deepEqual(streamed, ['First', ' line\nSecond', ' line'])
    assert.equal(streamed.some((delta) => delta.includes('status')), false)
  }, { llm })
})

test('interrupt aborts an active model stream and excludes partial output from context', async () => {
  const llm: RuntimeLlm = {
    chat: async () => {
      throw new Error('non-streaming chat should not be called')
    },
    stream: async (request, onTextDelta) => {
      onTextDelta('{"status":"completed","content":"partial output')
      return new Promise<LlmChatResponse>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => {
          const error = new Error('model stream aborted')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    },
    getConfig: fakeLlm().getConfig,
  }

  await withRuntime(async (client) => {
    const start = client.events.length
    client.send('chat.message.send', {
      clientMessageId: 'interrupt-model-stream',
      content: [{ type: 'text', text: 'Start a long response.' }],
      autoStart: true,
    })
    await client.waitFor(
      'chat.assistant.delta',
      (event) => event.payload.delta === 'partial output',
      start,
    )
    const interruptIndex = client.events.length
    const interruptId = client.send('run.interrupt', { reason: 'stop model stream' })
    await client.waitFor(
      'run.state.changed',
      (event) => event.correlationId === interruptId && event.payload.status === 'interrupting',
      interruptIndex,
    )
    await client.waitFor(
      'run.state.changed',
      (event) => event.correlationId === interruptId && event.payload.status === 'interrupted',
      interruptIndex,
    )
    const cancelled = await client.waitFor(
      'chat.assistant.completed',
      (event) => event.correlationId === interruptId,
      interruptIndex,
    )
    assert.equal(cancelled.payload.finishReason, 'cancelled')
    const interruptedStep = client.events.slice(start).find(
      (event): event is EventOf<'timeline.step.upserted'> =>
        event.type === 'timeline.step.upserted' &&
        event.payload.step.type === 'model' &&
        event.payload.step.status === 'interrupted',
    )
    assert.ok(interruptedStep)
    const snapshotIndex = client.events.length
    client.send('runtime.snapshot.get', {})
    const snapshot = await client.waitFor('runtime.snapshot', () => true, snapshotIndex)
    assert.doesNotMatch(
      snapshot.payload.renderResult?.messages.map((message) => message.content).join('\n') ?? '',
      /partial output/,
    )
  }, { llm })
})

test('runtime dispatches native model tool calls and returns results to the next model turn', async () => {
  const requests: LlmChatRequest[] = []
  const llm = fakeLlm(async (request) => {
    requests.push(structuredClone({ ...request, signal: undefined }))
    if (requests.length === 1) {
      assert.ok(request.tools?.some((tool) => tool.name === 'search_resources'))
      assert.equal(request.tools?.some((tool) => tool.name === 'read_file'), false)
      return {
        provider: 'custom',
        model: 'test-model',
        text: '',
        toolCalls: [{
          id: 'call-search-files',
          name: 'search_resources',
          arguments: { query: 'read file', kinds: ['tool'] },
        }],
        raw: {},
      }
    }
    if (requests.length === 2) {
      const searchResult = request.messages.find(
        (message) => message.toolCallId === 'call-search-files',
      )
      assert.match(searchResult?.content ?? '', /project-files:read_file/)
      return {
        provider: 'custom',
        model: 'test-model',
        text: '',
        toolCalls: [{
          id: 'call-load-reader',
          name: 'load_resources',
          arguments: { ids: ['project-files:read_file'] },
        }],
        raw: {},
      }
    }
    if (requests.length === 3) {
      assert.ok(request.tools?.some((tool) => tool.name === 'read_file'))
      assert.match(request.messages[0]?.content ?? '', /read_file/)
      return {
        provider: 'custom',
        model: 'test-model',
        text: '',
        toolCalls: [{
          id: 'call-read-config',
          name: 'read_file',
          arguments: { file_name: '.capybara/config.json', include_line_numbers: false },
        }],
        usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24, cacheReadTokens: 5 },
        raw: {},
      }
    }
    const toolMessage = request.messages.find(
      (message) => message.toolCallId === 'call-read-config',
    )
    assert.match(toolMessage?.content ?? '', /max_tool_rounds/)
    return {
      provider: 'custom',
      model: 'test-model',
      text: JSON.stringify({
        status: 'completed',
        content: 'The project config was read successfully.',
      }),
      finishReason: 'stop',
      usage: { inputTokens: 30, outputTokens: 6, totalTokens: 36, cacheReadTokens: 7 },
      raw: {},
    }
  })

  await withRuntime(async (client) => {
    const start = client.events.length
    client.send('chat.message.send', {
      clientMessageId: 'tool-loop-message',
      content: [{ type: 'text', text: 'Read the project configuration.' }],
      autoStart: true,
    })
    await client.waitFor(
      'run.state.changed',
      (event) => event.payload.status === 'completed',
      start,
    )
    assert.equal(requests.length, 4)
    const events = client.events.slice(start)
    const started = events.find(
      (event): event is EventOf<'tool.call.started'> =>
        event.type === 'tool.call.started' && event.payload.toolName === 'read_file',
    )
    const completed = events.find(
      (event): event is EventOf<'tool.call.completed'> =>
        event.type === 'tool.call.completed' && event.payload.toolName === 'read_file',
    )
    assert.equal(started?.payload.toolName, 'read_file')
    assert.equal(completed?.payload.callId, 'call-read-config')
    assert.match(JSON.stringify(completed?.payload.result), /main_template/)
    assert.ok((started?.sequence ?? 0) < (completed?.sequence ?? 0))

    const renderedToolCall = events.find(
      (event): event is EventOf<'render.result.updated'> =>
        event.type === 'render.result.updated' &&
        event.payload.messages.some((message) =>
          message.toolCalls?.some((call) => call.id === 'call-read-config'),
        ),
    )
    const renderedToolResult = events.find(
      (event): event is EventOf<'render.result.updated'> =>
        event.type === 'render.result.updated' &&
        event.payload.messages.some((message) =>
          message.role === 'tool' &&
          message.toolCallId === 'call-read-config' &&
          message.content.includes('max_tool_rounds'),
        ),
    )
    assert.ok(renderedToolCall)
    assert.ok(renderedToolResult)
    assert.ok((renderedToolCall.sequence ?? 0) < (renderedToolResult.sequence ?? 0))

    const succeededTypes = events
      .filter(
        (event): event is EventOf<'timeline.step.upserted'> =>
          event.type === 'timeline.step.upserted' && event.payload.step.status === 'success',
      )
      .map((event) => event.payload.step.type)
    assert.deepEqual(succeededTypes, [
      'context', 'render',
      'model', 'tool', 'model', 'tool', 'model', 'tool', 'model',
      'output',
    ])
    const assistant = events.find(
      (event): event is EventOf<'chat.assistant.completed'> =>
        event.type === 'chat.assistant.completed',
    )
    assert.equal(assistant?.payload.usage?.cacheReadTokens, 12)

    const modelSteps = events.filter(
      (event): event is EventOf<'timeline.step.upserted'> =>
        event.type === 'timeline.step.upserted' &&
        event.payload.step.type === 'model' &&
        event.payload.step.status === 'success',
    )
    const firstRequestId = modelSteps[0]?.payload.step.detail?.requestArtifactId
    assert.equal(typeof firstRequestId, 'string')
    const firstRequestIndex = client.events.length
    client.send('runtime.artifact.get', { artifactId: String(firstRequestId) })
    const firstRequest = await client.waitFor(
      'runtime.artifact.content',
      (event) => event.payload.artifact.id === firstRequestId,
      firstRequestIndex,
    )
    const requestValue = firstRequest.payload.value as unknown as {
      messages: LlmChatRequest['messages']
      tools: NonNullable<LlmChatRequest['tools']>
    }
    const searchTool = requestValue.tools.find((tool) => tool.name === 'search_resources')
    assert.equal(searchTool?.parameters.type, 'object')
    assert.ok(Object.keys(searchTool?.parameters.properties ?? {}).includes('query'))
    assert.ok(requestValue.messages.some((message) => message.role === 'user'))

    const readToolStep = events.find(
      (event): event is EventOf<'timeline.step.upserted'> =>
        event.type === 'timeline.step.upserted' &&
        event.payload.step.type === 'tool' &&
        event.payload.step.status === 'success' &&
        event.payload.step.detail?.toolName === 'read_file',
    )
    const resultArtifactId = readToolStep?.payload.step.detail?.resultArtifactId
    assert.equal(typeof resultArtifactId, 'string')
    const resultIndex = client.events.length
    client.send('runtime.artifact.get', { artifactId: String(resultArtifactId) })
    const resultArtifact = await client.waitFor(
      'runtime.artifact.content',
      (event) => event.payload.artifact.id === resultArtifactId,
      resultIndex,
    )
    assert.match(JSON.stringify(resultArtifact.payload.value), /max_tool_rounds/)

    const nextModelStep = modelSteps.find(
      (event) => event.payload.step.index > (readToolStep?.payload.step.index ?? Infinity),
    )
    const nextRequestId = nextModelStep?.payload.step.detail?.requestArtifactId
    assert.equal(typeof nextRequestId, 'string')
    const nextRequestIndex = client.events.length
    client.send('runtime.artifact.get', { artifactId: String(nextRequestId) })
    const nextRequest = await client.waitFor(
      'runtime.artifact.content',
      (event) => event.payload.artifact.id === nextRequestId,
      nextRequestIndex,
    )
    assert.match(JSON.stringify(nextRequest.payload.value), /call-read-config/)
    assert.match(JSON.stringify(nextRequest.payload.value), /max_tool_rounds/)

    const readObservation = events
      .filter(
        (event): event is EventOf<'runtime.observation.upserted'> =>
          event.type === 'runtime.observation.upserted' &&
          event.payload.observation.callId === 'call-read-config',
      )
      .at(-1)?.payload.observation
    assert.equal(readObservation?.status, 'completed')
    assert.equal(readObservation?.resultArtifactId, resultArtifactId)
    assert.equal(readObservation?.consumedByRequestArtifactId, nextRequestId)
    assert.equal(readObservation?.consumedByStepId, nextModelStep?.payload.step.id)

    const effectiveContext = events.find(
      (event): event is EventOf<'runtime.effectiveContext.created'> =>
        event.type === 'runtime.effectiveContext.created' &&
        event.payload.context.requestArtifactId === nextRequestId,
    )?.payload.context
    assert.equal(effectiveContext?.stepId, nextModelStep?.payload.step.id)
    const messagesIndex = client.events.length
    client.send('runtime.artifact.get', {
      artifactId: String(effectiveContext?.messagesArtifactId),
    })
    const effectiveMessages = await client.waitFor(
      'runtime.artifact.content',
      (event) => event.payload.artifact.id === effectiveContext?.messagesArtifactId,
      messagesIndex,
    )
    assert.match(JSON.stringify(effectiveMessages.payload.value), /call-read-config/)
    assert.match(JSON.stringify(effectiveMessages.payload.value), /max_tool_rounds/)
  }, { llm })
})

test('runtime Skill marketplace requires frontend confirmation before install and rejects reuse', async () => {
  const commit = '1234567890abcdef1234567890abcdef12345678'
  const preview: SkillPreview = {
    repo: 'example/skills',
    requestedPath: 'skills/runtime-test/SKILL.md',
    commit,
    ref: 'refs/heads/main',
    skillName: 'runtime-test',
    description: 'Runtime confirmation test Skill',
    metadata: {},
    content: '# Runtime test',
    files: [
      { path: 'SKILL.md', size: 20, kind: 'entry' },
      { path: 'scripts/check.mjs', size: 20, kind: 'script' },
    ],
    warnings: [
      'Skills are not verified by GitHub. Review their instructions and files before installation.',
      'This Skill contains executable scripts.',
    ],
  }
  let installCalls = 0
  const marketplace: RuntimeSkillMarketplace = {
    search: async () => ({ page: 1, items: [] }),
    preview: async () => preview,
    installed: () => [],
    install: async () => { installCalls += 1 },
    uninstall: async () => undefined,
  }
  let modelCalls = 0
  const llm = fakeLlm(async (request) => {
    modelCalls += 1
    if (modelCalls === 1) {
      assert.ok(request.tools?.some((tool) => tool.name === 'search_skill_marketplace'))
      assert.ok(request.tools?.some((tool) => tool.name === 'preview_skill_marketplace'))
      assert.ok(request.tools?.some((tool) => tool.name === 'list_installed_skills'))
      const requestInstall = request.tools?.find((tool) => tool.name === 'request_skill_install')
      assert.ok(requestInstall)
      assert.equal('confirmed' in (requestInstall.parameters.properties as Record<string, unknown>), false)
      return {
        provider: 'custom',
        model: 'test-model',
        text: '',
        toolCalls: [{
          id: 'request-runtime-skill-install',
          name: 'request_skill_install',
          arguments: {
            repo: preview.repo,
            path: preview.requestedPath,
            commit,
          },
        }],
        finishReason: 'tool_calls',
        raw: {},
      }
    }
    const result = request.messages.find(
      (message) => message.toolCallId === 'request-runtime-skill-install',
    )
    assert.match(result?.content ?? '', /requiresUserConfirmation/)
    assert.match(result?.content ?? '', /"projectChanged":false/)
    return {
      provider: 'custom',
      model: 'test-model',
      text: JSON.stringify({ status: 'completed', content: 'Installation awaits confirmation.' }),
      finishReason: 'stop',
      raw: {},
    }
  })

  await withRuntime(async (client) => {
    const start = client.events.length
    client.send('chat.message.send', {
      clientMessageId: 'runtime-skill-install-message',
      content: [{ type: 'text', text: 'Install the runtime test Skill.' }],
      autoStart: true,
    })
    await client.waitFor('run.state.changed', (event) => event.payload.status === 'completed', start)
    const pending = await client.waitFor(
      'runtime.skills.confirmations.updated',
      (event) => event.payload.items.some((item) => item.status === 'pending'),
      start,
    )
    const confirmation = pending.payload.items.find((item) => item.status === 'pending')
    assert.ok(confirmation)
    assert.equal(installCalls, 0)
    assert.equal(confirmation.fileCount, 2)
    assert.equal(confirmation.scriptCount, 1)

    const confirmIndex = client.events.length
    const confirmId = client.send('runtime.skills.confirm', {
      confirmationId: confirmation.id,
    })
    await client.waitFor(
      'runtime.skills.confirmations.updated',
      (event) => event.payload.items.some(
        (item) => item.id === confirmation.id && item.status === 'completed',
      ),
      confirmIndex,
    )
    assert.equal(installCalls, 1)

    const reuseIndex = client.events.length
    client.send('runtime.skills.confirm', { confirmationId: confirmation.id })
    const rejected = await client.waitFor(
      'command.rejected',
      (event) => event.payload.code === 'INVALID_STATE',
      reuseIndex,
    )
    assert.notEqual(rejected.payload.commandId, confirmId)
    assert.equal(installCalls, 1)

    const missingIndex = client.events.length
    client.send('runtime.skills.confirm', { confirmationId: 'missing-confirmation' })
    await client.waitFor(
      'command.rejected',
      (event) => event.payload.code === 'NOT_FOUND',
      missingIndex,
    )
  }, { llm, skillMarketplace: marketplace })
})

test('runtime Skill uninstall request can be cancelled without removing project files', async () => {
  let uninstallCalls = 0
  const marketplace: RuntimeSkillMarketplace = {
    search: async () => ({ page: 1, items: [] }),
    preview: async () => { throw new Error('preview should not run') },
    installed: () => [{
      id: 'local-skill',
      path: 'skills/local-skill',
      managed: true,
      repo: 'example/skills',
      requestedPath: 'skills/local-skill/SKILL.md',
      commit: '1234567890abcdef1234567890abcdef12345678',
      hasLocalChanges: true,
    }],
    install: async () => undefined,
    uninstall: async () => { uninstallCalls += 1 },
  }
  let modelCalls = 0
  const llm = fakeLlm(async (request) => {
    modelCalls += 1
    if (modelCalls === 1) {
      return {
        provider: 'custom',
        model: 'test-model',
        text: '',
        toolCalls: [{
          id: 'request-runtime-skill-uninstall',
          name: 'request_skill_uninstall',
          arguments: { skill_id: 'local-skill' },
        }],
        finishReason: 'tool_calls',
        raw: {},
      }
    }
    return {
      provider: 'custom',
      model: 'test-model',
      text: JSON.stringify({ status: 'completed', content: 'Removal awaits confirmation.' }),
      finishReason: 'stop',
      raw: {},
    }
  })

  await withRuntime(async (client) => {
    const start = client.events.length
    client.send('chat.message.send', {
      clientMessageId: 'runtime-skill-uninstall-message',
      content: [{ type: 'text', text: 'Remove the local Skill.' }],
      autoStart: true,
    })
    const pending = await client.waitFor(
      'runtime.skills.confirmations.updated',
      (event) => event.payload.items.some((item) => item.status === 'pending'),
      start,
    )
    const confirmation = pending.payload.items.find((item) => item.status === 'pending')
    assert.ok(confirmation)
    assert.equal(confirmation.hasLocalChanges, true)
    assert.equal(uninstallCalls, 0)

    const cancelIndex = client.events.length
    client.send('runtime.skills.cancelConfirmation', { confirmationId: confirmation.id })
    await client.waitFor(
      'runtime.skills.confirmations.updated',
      (event) => event.payload.items.some(
        (item) => item.id === confirmation.id && item.status === 'cancelled',
      ),
      cancelIndex,
    )
    assert.equal(uninstallCalls, 0)

    const snapshotIndex = client.events.length
    client.send('runtime.snapshot.get', {})
    const snapshot = await client.waitFor('runtime.snapshot', () => true, snapshotIndex)
    assert.equal(
      snapshot.payload.skillConfirmations.items.find((item) => item.id === confirmation.id)?.status,
      'cancelled',
    )
  }, { llm, skillMarketplace: marketplace })
})

test('model-generated workflow chains list, filter, and read without intermediate model turns', async () => {
  const requests: LlmChatRequest[] = []
  const llm = fakeLlm(async (request) => {
    requests.push(structuredClone({ ...request, signal: undefined }))
    if (requests.length === 1) {
      const workflowTool = request.tools?.find((tool) => tool.name === 'execute_workflow')
      assert.match(workflowTool?.description ?? '', /temporary workflow/i)
      return {
        provider: 'custom',
        model: 'test-model',
        text: '',
        toolCalls: [{
          id: 'load-workflow-file-tools',
          name: 'load_resources',
          arguments: {
            ids: ['project-files:list_files', 'project-files:read_file'],
          },
        }],
        finishReason: 'tool_calls',
        raw: {},
      }
    }
    if (requests.length === 2) {
      assert.ok(request.tools?.some((tool) => tool.name === 'list_files'))
      assert.ok(request.tools?.some((tool) => tool.name === 'read_file'))
      return {
        provider: 'custom',
        model: 'test-model',
        text: '',
        toolCalls: [{
          id: 'execute-document-workflow',
          name: 'execute_workflow',
          arguments: {
            version: 1,
            goal: 'List documents, select the 0.1.3 release note, and read its content.',
            steps: [
              {
                id: 'list_documents',
                type: 'tool',
                tool: 'project-files:list_files',
                arguments: { path: 'test-docs', recursive: false, max_entries: 100 },
              },
              {
                id: 'filter_target',
                type: 'filter',
                input: { $ref: 'steps.list_documents.output.entries' },
                expression: 'type = "file" and $contains(path, "release-0.1.3.md")',
              },
              {
                id: 'read_documents',
                type: 'foreach',
                input: { $ref: 'steps.filter_target.output' },
                as: 'document',
                maxItems: 3,
                tool: 'project-files:read_file',
                arguments: {
                  file_name: { $ref: 'document.path' },
                  include_line_numbers: false,
                },
              },
            ],
          },
        }],
        finishReason: 'tool_calls',
        raw: {},
      }
    }
    const workflowResult = request.messages.find(
      (message) => message.toolCallId === 'execute-document-workflow',
    )
    assert.match(workflowResult?.content ?? '', /Version 0\.1\.3 introduced three capabilities/)
    assert.equal(
      request.messages.some((message) =>
        message.role === 'tool' && ['list_files', 'read_file'].includes(message.name ?? '')),
      false,
    )
    return {
      provider: 'custom',
      model: 'test-model',
      text: JSON.stringify({
        status: 'completed',
        content: 'The 0.1.3 release note was listed, filtered, and read in one runtime workflow.',
      }),
      finishReason: 'stop',
      raw: {},
    }
  })

  await withRuntime(async (client, projectDir) => {
    const start = client.events.length
    client.send('chat.message.send', {
      clientMessageId: 'generated-workflow-message',
      content: [{
        type: 'text',
        text: 'List test-docs, filter the 0.1.3 release note, and read its contents.',
      }],
      autoStart: true,
    })
    await client.waitFor(
      'run.state.changed',
      (event) => event.payload.status === 'completed',
      start,
    )
    assert.equal(requests.length, 3)
    assert.equal(fs.existsSync(path.join(projectDir, 'workflows')), false)
    const events = client.events.slice(start)
    const workflow = events
      .filter(
        (event): event is EventOf<'runtime.workflows.updated'> =>
          event.type === 'runtime.workflows.updated',
      )
      .at(-1)?.payload.items.at(-1)
    assert.equal(workflow?.status, 'completed')
    assert.equal(workflow?.nodes.find((node) => node.id === 'filter_target')?.status, 'completed')
    assert.equal(workflow?.nodes.find((node) => node.id === 'read_documents[0]')?.status, 'completed')
    assert.ok(events.some(
      (event) => event.type === 'tool.call.started' && event.payload.toolName === 'list_files',
    ))
    assert.ok(events.some(
      (event) => event.type === 'tool.call.started' && event.payload.toolName === 'read_file',
    ))
    const snapshotIndex = client.events.length
    client.send('runtime.snapshot.get', {})
    const snapshot = await client.waitFor('runtime.snapshot', () => true, snapshotIndex)
    assert.equal(snapshot.payload.workflows.items.at(-1)?.status, 'completed')
    assert.ok(snapshot.payload.timeline.steps.some((step) =>
      step.type === 'workflow' && step.detail?.workflowNodeType === 'filter'))
  }, { llm })
})

test('starting another run replaces current trace data', async () => {
  await withRuntime(async (client) => {
    client.send('chat.message.send', {
      clientMessageId: 'first-run-message',
      content: [{ type: 'text', text: 'First run' }],
      autoStart: true,
    })
    const firstCompleted = await client.waitFor(
      'run.state.changed',
      (event) => event.payload.status === 'completed',
    )
    const start = client.events.length
    client.send('chat.message.send', {
      clientMessageId: 'second-run-message',
      content: [{ type: 'text', text: 'Second run' }],
      autoStart: true,
    })
    const trace = await client.waitFor('run.trace.started', () => true, start)
    assert.notEqual(trace.payload.run.runId, firstCompleted.payload.runId)
    assert.equal(trace.payload.timeline.steps.length, 4)
    assert.ok(trace.payload.timeline.steps.every((step) => step.status === 'pending'))
    assert.deepEqual(trace.payload.checkpoints.items, [])
    assert.deepEqual(trace.payload.effectiveContexts.items, [])
    assert.deepEqual(trace.payload.observations.items, [])
  })
})

test('model retry progress is published and cleared after success', async () => {
  const llm = fakeLlm(async (request) => {
    request.onRetry?.({
      phase: 'waiting',
      attempt: 2,
      maxAttempts: 4,
      delayMs: 1_000,
      reason: 'HTTP 503 Service Unavailable',
      statusCode: 503,
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    request.onRetry?.({
      phase: 'attempting',
      attempt: 2,
      maxAttempts: 4,
      delayMs: 0,
      reason: 'HTTP 503 Service Unavailable',
      statusCode: 503,
    })
    return {
      provider: 'custom',
      model: 'test-model',
      text: JSON.stringify({ status: 'completed', content: 'Recovered after retry.' }),
      finishReason: 'stop',
      raw: {},
    }
  })

  await withRuntime(async (client) => {
    const start = client.events.length
    client.send('chat.message.send', {
      clientMessageId: 'retry-progress-message',
      content: [{ type: 'text', text: 'Retry the model request' }],
      autoStart: true,
    })
    const completed = await client.waitFor(
      'run.state.changed',
      (event) => event.payload.status === 'completed',
      start,
    )
    const retryStates = client.events.slice(start).filter(
      (event): event is EventOf<'run.state.changed'> =>
        event.type === 'run.state.changed' && event.payload.modelRetry !== undefined,
    )
    assert.deepEqual(retryStates.map((event) => event.payload.modelRetry?.phase), [
      'waiting',
      'attempting',
    ])
    assert.equal(retryStates[0]?.payload.modelRetry?.attempt, 2)
    assert.equal(retryStates[0]?.payload.modelRetry?.maxAttempts, 4)
    assert.equal(retryStates[0]?.payload.modelRetry?.statusCode, 503)
    assert.equal(completed.payload.modelRetry, undefined)
  }, { llm })
})

test('model failures preserve phase, message, and request artifact links', async () => {
  const llm = fakeLlm(async () => {
    throw new Error('LLM request timed out')
  })
  await withRuntime(async (client) => {
    const start = client.events.length
    client.send('chat.message.send', {
      clientMessageId: 'failing-run-message',
      content: [{ type: 'text', text: 'Trigger a transport failure' }],
      autoStart: true,
    })
    const failed = await client.waitFor(
      'run.state.changed',
      (event) => event.payload.status === 'failed',
      start,
    )
    assert.equal(failed.payload.failure?.phase, 'model_transport')
    assert.equal(failed.payload.failure?.code, 'MODEL_TRANSPORT_ERROR')
    assert.match(failed.payload.failure?.message ?? '', /timed out/)
    assert.equal(failed.payload.failure?.retryable, true)
    assert.equal(typeof failed.payload.failure?.requestArtifactId, 'string')
    assert.equal(typeof failed.payload.failure?.errorArtifactId, 'string')

    const assistantFailed = client.events
      .slice(start)
      .find(
        (event): event is EventOf<'chat.assistant.failed'> =>
          event.type === 'chat.assistant.failed',
      )
    assert.deepEqual(assistantFailed?.payload.failure, failed.payload.failure)
    assert.equal(assistantFailed?.payload.code, failed.payload.failure?.code)
    assert.equal(assistantFailed?.payload.message, failed.payload.failure?.message)

    const failedStep = client.events
      .slice(start)
      .filter(
        (event): event is EventOf<'timeline.step.upserted'> =>
          event.type === 'timeline.step.upserted' && event.payload.step.status === 'error',
      )
      .at(-1)?.payload.step
    assert.equal(failedStep?.detail?.requestArtifactId, failed.payload.failure?.requestArtifactId)
    assert.equal(
      (failedStep?.detail?.error as { phase?: string } | undefined)?.phase,
      'model_transport',
    )

    const snapshotIndex = client.events.length
    const snapshotId = client.send('runtime.snapshot.get', {})
    const snapshot = await client.waitFor(
      'runtime.snapshot',
      (event) => event.correlationId === snapshotId,
      snapshotIndex,
    )
    const failedAssistant = snapshot.payload.conversation.messages.find(
      (message) => message.id === assistantFailed?.payload.messageId,
    )
    assert.equal(failedAssistant?.status, 'failed')
    assert.deepEqual(failedAssistant?.failure, failed.payload.failure)
  }, { llm })
})

test('invalid model output is classified separately from transport failures', async () => {
  const llm = fakeLlm(async () => ({
    provider: 'custom',
    model: 'test-model',
    text: 'not valid loop JSON',
    raw: {},
  }))
  await withRuntime(async (client) => {
    client.send('chat.message.send', {
      clientMessageId: 'invalid-output-message',
      content: [{ type: 'text', text: 'Trigger invalid output' }],
      autoStart: true,
    })
    const failed = await client.waitFor(
      'run.state.changed',
      (event) => event.payload.status === 'failed',
    )
    assert.equal(failed.payload.failure?.phase, 'model_output_validation')
    assert.equal(failed.payload.failure?.code, 'MODEL_OUTPUT_INVALID')
    assert.equal(failed.payload.failure?.retryable, true)
    assert.equal(typeof failed.payload.failure?.responseArtifactId, 'string')
  }, { llm })
})

test('attaching a tool automatically binds and renders its harness', async () => {
  const requests: LlmChatRequest[] = []
  const llm = fakeLlm(async (request) => {
    requests.push(structuredClone({ ...request, signal: undefined }))
    if (requests.length === 1) {
      return {
        provider: 'custom',
        model: 'test-model',
        text: '',
        toolCalls: [{
          id: 'load-read-file-tool',
          name: 'load_resources',
          arguments: { ids: ['project-files:read_file'] },
        }],
        raw: {},
      }
    }
    assert.ok(request.tools?.some((tool) => tool.name === 'read_file'))
    assert.equal(request.tools?.some((tool) => tool.name === 'delete_file'), false)
    assert.match(request.messages[0]?.content ?? '', /Inspect files progressively/)
    return {
      provider: 'custom',
      model: 'test-model',
      text: JSON.stringify({ status: 'completed', content: 'Resources are ready.' }),
      raw: {},
    }
  })

  await withRuntime(async (client) => {
    const start = client.events.length
    client.send('chat.message.send', {
      clientMessageId: 'harness-resource-message',
      content: [{ type: 'text', text: 'Inspect project files.' }],
      autoStart: true,
    })
    await client.waitFor(
      'run.state.changed',
      (event) => event.payload.status === 'completed',
      start,
    )
    const harnesses = await client.waitFor(
      'runtime.harnesses.updated',
      (event) => event.payload.items.some(
        (item) => item.id === 'filesystem-guidance:file-inspection',
      ),
      start,
    )
    const tools = await client.waitFor(
      'runtime.tools.updated',
      (event) => event.payload.items.length === 1,
      start,
    )
    const fileHarness = harnesses.payload.items.find(
      (item) => item.id === 'filesystem-guidance:file-inspection',
    )
    assert.deepEqual(harnesses.payload.items.map((item) => item.id), [
      'capybara-system:hook-authoring',
      'capybara-system:variable-authoring',
      'filesystem-guidance:file-inspection',
    ])
    assert.equal(fileHarness?.bindings[0]?.source, 'tool')
    assert.equal(tools.payload.items.length, 1)
    assert.equal(requests.length, 2)
  }, { llm })
})

test('model and matching experience harnesses bind automatically', async () => {
  const llm: RuntimeLlm = {
    ...fakeLlm(),
    getConfig: () => ({
      provider: 'custom',
      protocol: 'responses',
      model: 'gpt-5.6-sol',
      baseUrl: 'http://127.0.0.1/unused',
      timeoutMs: 1_000,
      maxRetries: 0,
    }),
  }
  await withRuntime(async (client) => {
    const snapshot = client.events.find(
      (event): event is EventOf<'runtime.snapshot'> => event.type === 'runtime.snapshot',
    )
    assert.ok(snapshot)
    const modelHarness = snapshot.payload.harnesses.items.find(
      (item) => item.id === 'model-guidance:gpt-runtime',
    )
    assert.equal(modelHarness?.bindings[0]?.source, 'model')
    assert.match(modelHarness?.content ?? '', /structured completion status/)

    const start = client.events.length
    client.send('chat.message.send', {
      clientMessageId: 'experience-retrieval-message',
      content: [{ type: 'text', text: '查看版本文档' }],
      autoStart: false,
    })
    const updated = await client.waitFor(
      'runtime.harnesses.updated',
      (event) => event.payload.items.some(
        (item) => item.id === 'document-analysis:version-summary'
          && item.bindings.some((binding) => binding.source === 'retrieval'),
      ),
      start,
    )
    const experienceHarness = updated.payload.items.find(
      (item) => item.id === 'document-analysis:version-summary',
    )
    assert.match(experienceHarness?.content ?? '', /planned work/)
  }, { llm })
})

test('test-project harness injects runtime variables and rerenders after variable changes', async () => {
  await withRuntime(async (client) => {
    const modeIndex = client.events.length
    client.send('run.mode.set', { mode: 'step' })
    await client.waitFor(
      'run.state.changed',
      (event) => event.payload.mode === 'step' && event.payload.variablesEditable,
      modeIndex,
    )

    const messageIndex = client.events.length
    client.send('chat.message.send', {
      clientMessageId: 'harness-variable-probe-message',
      content: [{ type: 'text', text: 'harness variable probe' }],
      autoStart: false,
    })
    const attached = await client.waitFor(
      'runtime.harnesses.updated',
      (event) => event.payload.items.some(
        (item) => item.id === 'variable-injection:runtime-variable-probe'
          && item.content.includes('user_message=harness variable probe'),
      ),
      messageIndex,
    )
    const initialHarness = attached.payload.items.find(
      (item) => item.id === 'variable-injection:runtime-variable-probe',
    )
    assert.match(initialHarness?.content ?? '', /request=harness variable probe/)
    assert.match(initialHarness?.content ?? '', /context_marker=missing/)

    const snapshotIndex = client.events.length
    const snapshotId = client.send('runtime.snapshot.get', {})
    const snapshot = await client.waitFor(
      'runtime.snapshot',
      (event) => event.correlationId === snapshotId,
      snapshotIndex,
    )
    const variableIndex = client.events.length
    client.send('variables.apply', {
      baseRevision: snapshot.payload.variables.revision,
      patch: [
        { op: 'replace', path: '/task/title', value: 'runtime-task-updated' },
        { op: 'add', path: '/context/harness_probe', value: 'runtime-context-updated' },
        { op: 'add', path: '/context/harness_count', value: 7 },
        { op: 'add', path: '/context/harness_enabled', value: false },
        { op: 'add', path: '/context/harness_items', value: ['runtime-a', 'runtime-b'] },
        { op: 'add', path: '/context/harness_meta', value: { source: 'runtime' } },
        { op: 'add', path: '/context/harness_empty', value: null },
      ],
    })
    const updated = await client.waitFor(
      'runtime.harnesses.updated',
      (event) => event.payload.items.some(
        (item) => item.id === 'variable-injection:runtime-variable-probe'
          && item.content.includes('task_title=runtime-task-updated')
          && item.content.includes('context_marker=runtime-context-updated')
          && item.content.includes('count=7')
          && item.content.includes('enabled=false')
          && item.content.includes('items=runtime-a,runtime-b')
          && item.content.includes('meta_source=runtime')
          && item.content.includes('empty=null'),
      ),
      variableIndex,
    )
    const rendered = await client.waitFor(
      'render.result.updated',
      (event) => event.payload.messages[0]?.content.includes('context_marker=runtime-context-updated') ?? false,
      variableIndex,
    )
    const updatedHarness = updated.payload.items.find(
      (item) => item.id === 'variable-injection:runtime-variable-probe',
    )
    assert.match(updatedHarness?.content ?? '', /user_message=harness variable probe/)
    assert.match(updatedHarness?.content ?? '', /count=7/)
    assert.match(updatedHarness?.content ?? '', /enabled=false/)
    assert.match(updatedHarness?.content ?? '', /items=runtime-a,runtime-b/)
    assert.match(updatedHarness?.content ?? '', /meta_source=runtime/)
    assert.match(updatedHarness?.content ?? '', /empty=null/)
    assert.match(rendered.payload.messages[0]?.content ?? '', /task_title=runtime-task-updated/)
  })
})

test('runtime continues on running status and exits only on completed status', async () => {
  let modelCalls = 0
  const llm = fakeLlm(async () => {
    modelCalls += 1
    return {
      provider: 'custom',
      model: 'test-model',
      text: JSON.stringify(modelCalls === 1
        ? { status: 'running', content: 'One more reasoning step is required.' }
        : { status: 'completed', content: 'The task is complete.' }),
      raw: {},
    }
  })

  await withRuntime(async (client) => {
    const start = client.events.length
    client.send('chat.message.send', {
      clientMessageId: 'status-loop-message',
      content: [{ type: 'text', text: 'Exercise status control.' }],
      autoStart: true,
    })
    await client.waitFor(
      'run.state.changed',
      (event) => event.payload.status === 'completed',
      start,
    )
    const modelSteps = client.events.slice(start).filter(
      (event): event is EventOf<'timeline.step.upserted'> =>
        event.type === 'timeline.step.upserted' &&
        event.payload.step.type === 'model' &&
        event.payload.step.status === 'success',
    )
    const deltas = client.events.slice(start).filter(
      (event): event is EventOf<'chat.assistant.delta'> => event.type === 'chat.assistant.delta',
    )
    assert.equal(modelCalls, 2)
    assert.equal(modelSteps.length, 2)
    assert.equal(deltas.map((event) => event.payload.delta).join(''), 'The task is complete.')
  }, { llm })
})

test('interrupting a tool step terminates its child process and keeps the step resumable', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-slow-tool-'))
  const sourceProject = path.resolve(process.env.CAPYBARA_TEST_PROJECT_DIR ?? 'test-project')
  fs.cpSync(sourceProject, projectDir, {
    filter: (source) => !path.relative(sourceProject, source)
      .replaceAll('\\', '/')
      .startsWith('.capybara/sessions.sqlite'),
    recursive: true,
  })
  const toolDir = path.join(projectDir, 'tools', 'slow')
  fs.mkdirSync(toolDir, { recursive: true })
  fs.writeFileSync(path.join(toolDir, 'runner.mjs'), `
    let raw = ''
    for await (const chunk of process.stdin) raw += chunk
    const request = JSON.parse(raw)
    setTimeout(() => process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: {} })), 10000)
  `)
  fs.writeFileSync(path.join(toolDir, 'manifest.json'), JSON.stringify({
    version: 1,
    package: 'slow',
    runner: { type: 'stdio', entry: 'runner.mjs' },
    tools: [{
      name: 'slow_tool',
      description: 'Wait until interrupted.',
      permissions: [],
      inputSchema: { type: 'object', additionalProperties: false },
    }],
  }))
  const configFile = path.join(projectDir, '.capybara', 'config.json')
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  config.tools = ['tools/slow/manifest.json']
  config.tool_permissions = []
  fs.writeFileSync(configFile, JSON.stringify(config))

  let modelCalls = 0
  const llm = fakeLlm(async () => {
    modelCalls += 1
    return {
      provider: 'custom',
      model: 'test-model',
      text: '',
      toolCalls: modelCalls === 1
        ? [{ id: 'load-slow', name: 'load_resources', arguments: { ids: ['slow:slow_tool'] } }]
        : [{ id: 'slow-call', name: 'slow_tool', arguments: {} }],
      raw: {},
    }
  })
  try {
    await withRuntime(async (client) => {
      const start = client.events.length
      client.send('chat.message.send', {
        clientMessageId: 'interrupt-tool-message',
        content: [{ type: 'text', text: 'Start slow tool.' }],
        autoStart: true,
      })
      await client.waitFor(
        'tool.call.started',
        (event) => event.payload.toolName === 'slow_tool',
        start,
      )
      const interruptId = client.send('run.interrupt', { reason: 'test abort' })
      await client.waitFor(
        'run.state.changed',
        (event) => event.correlationId === interruptId && event.payload.status === 'interrupted',
        start,
      )
      const failed = await client.waitFor(
        'tool.call.failed',
        (event) => event.payload.callId === 'slow-call',
        start,
      )
      assert.equal(failed.payload.code, 'ABORTED')
      const interrupted = client.events
        .slice(start)
        .filter(
          (event): event is EventOf<'timeline.step.upserted'> =>
            event.type === 'timeline.step.upserted' && event.payload.step.type === 'tool',
        )
        .at(-1)
      assert.equal(interrupted?.payload.step.status, 'interrupted')
    }, { projectDir, llm })
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('debug commands control step, pause, resume, interrupt, restore, cancel, and variable permissions', async () => {
  await withRuntime(
    async (client) => {
      const snapshot = await client.waitFor('runtime.snapshot')
      let variablesRevision = snapshot.payload.variables.revision

      const modeIndex = client.events.length
      client.send('run.mode.set', { mode: 'step' })
      await client.waitFor(
        'run.state.changed',
        (event) => event.payload.mode === 'step' && event.payload.variablesEditable,
        modeIndex,
      )

      const variableIndex = client.events.length
      client.send('variables.apply', {
        baseRevision: variablesRevision,
        patch: [{ op: 'replace', path: '/task/title', value: '调试模式变量' }],
      })
      const variableUpdate = await client.waitFor(
        'variables.updated',
        (event) => event.payload.source === 'user',
        variableIndex,
      )
      variablesRevision = variableUpdate.payload.revision
      const renderUpdate = await client.waitFor(
        'render.result.updated',
        (event) => event.payload.variablesRevision === variablesRevision,
        variableIndex,
      )
      assert.match(renderUpdate.payload.messages[0]?.content ?? '', /调试模式变量/)

      const startIndex = client.events.length
      client.send('run.start', {})
      const initialCheckpoint = await client.waitFor(
        'runtime.checkpoint.created',
        (event) => event.payload.checkpoint.currentStep === 0,
        startIndex,
      )
      await client.waitFor(
        'run.state.changed',
        (event) => event.payload.status === 'paused' && event.payload.currentStep === 0,
        startIndex,
      )

      const stepIndex = client.events.length
      client.send('run.step', {})
      await client.waitFor(
        'run.state.changed',
        (event) => event.payload.status === 'paused' && event.payload.currentStep === 1,
        stepIndex,
      )

      client.send('run.mode.set', { mode: 'continuous' })
      const resumeIndex = client.events.length
      client.send('run.resume', {})
      await client.waitFor(
        'run.state.changed',
        (event) => event.payload.status === 'running',
        resumeIndex,
      )

      const lockedId = client.send('variables.apply', {
        baseRevision: variablesRevision,
        patch: [{ op: 'replace', path: '/agent/name', value: 'locked' }],
      })
      const locked = await client.waitFor(
        'command.rejected',
        (event) => event.correlationId === lockedId,
        resumeIndex,
      )
      assert.equal(locked.payload.code, 'VARIABLES_LOCKED')

      const pauseId = client.send('run.pause', {})
      const pauseRequested = await client.waitFor(
        'run.state.changed',
        (event) =>
          event.correlationId === pauseId && event.payload.status === 'pause_requested',
        resumeIndex,
      )
      await client.waitFor(
        'run.state.changed',
        (event) =>
          event.correlationId === pauseId && event.payload.status === 'paused',
        resumeIndex,
      )
      assert.equal(pauseRequested.payload.variablesEditable, false)

      const secondResumeIndex = client.events.length
      client.send('run.resume', {})
      await client.waitFor(
        'run.state.changed',
        (event) => event.payload.status === 'running',
        secondResumeIndex,
      )
      const interruptId = client.send('run.interrupt', { reason: 'test interrupt' })
      await client.waitFor(
        'run.state.changed',
        (event) =>
          event.correlationId === interruptId && event.payload.status === 'interrupting',
        secondResumeIndex,
      )
      await client.waitFor(
        'run.state.changed',
        (event) =>
          event.correlationId === interruptId && event.payload.status === 'interrupted',
        secondResumeIndex,
      )

      const restoreIndex = client.events.length
      client.send('run.restoreCheckpoint', {
        checkpointId: initialCheckpoint.payload.checkpoint.id,
      })
      const restored = await client.waitFor(
        'run.state.changed',
        (event) => event.payload.status === 'paused' && event.payload.currentStep === 0,
        restoreIndex,
      )
      assert.equal(restored.payload.variablesEditable, true)
      await client.waitFor(
        'runtime.checkpoint.restored',
        (event) => event.payload.checkpointId === initialCheckpoint.payload.checkpoint.id,
        restoreIndex,
      )
      const restoreVariables = await client.waitFor(
        'variables.updated',
        (event) => event.payload.source === 'restore',
        restoreIndex,
      )
      variablesRevision = restoreVariables.payload.revision

      const finalResumeIndex = client.events.length
      client.send('run.resume', {})
      await client.waitFor(
        'run.state.changed',
        (event) => event.payload.status === 'running',
        finalResumeIndex,
      )
      const cancelId = client.send('run.cancel', { reason: 'test complete' })
      await client.waitFor(
        'run.state.changed',
        (event) =>
          event.correlationId === cancelId && event.payload.status === 'cancelled',
        finalResumeIndex,
      )
      assert.ok(variablesRevision > snapshot.payload.variables.revision)
    },
    { stepDelayMs: 25, streamDelayMs: 5 },
  )
})

test('before and after breakpoints pause at deterministic step boundaries', async () => {
  await withRuntime(async (client) => {
    const snapshot = await client.waitFor('runtime.snapshot')
    const step = snapshot.payload.timeline.steps[0]
    assert.ok(step)
    const before = {
      id: `before-${step.id}`,
      enabled: true,
      position: 'before' as const,
      stepId: step.id,
    }
    const after = {
      id: `after-${step.id}`,
      enabled: true,
      position: 'after' as const,
      stepId: step.id,
    }
    const breakpointIndex = client.events.length
    client.send('runtime.breakpoints.upsert', { breakpoint: before })
    await client.waitFor(
      'runtime.breakpoints.updated',
      (event) => event.payload.items.some((item) => item.id === before.id),
      breakpointIndex,
    )
    client.send('runtime.breakpoints.upsert', { breakpoint: after })
    await client.waitFor(
      'runtime.breakpoints.updated',
      (event) => event.payload.items.some((item) => item.id === after.id),
      breakpointIndex,
    )

    const runIndex = client.events.length
    client.send('run.start', {})
    const beforeHit = await client.waitFor(
      'run.breakpoint.hit',
      (event) => event.payload.breakpointId === before.id,
      runIndex,
    )
    assert.equal(beforeHit.payload.position, 'before')
    await client.waitFor(
      'run.state.changed',
      (event) => event.payload.status === 'paused' && event.payload.currentStep === 0,
      runIndex,
    )

    const resumeIndex = client.events.length
    client.send('run.resume', {})
    const afterHit = await client.waitFor(
      'run.breakpoint.hit',
      (event) => event.payload.breakpointId === after.id,
      resumeIndex,
    )
    assert.equal(afterHit.payload.position, 'after')
    await client.waitFor(
      'run.state.changed',
      (event) => event.payload.status === 'paused' && event.payload.currentStep === 1,
      resumeIndex,
    )
    client.send('run.cancel', { reason: 'breakpoint test complete' })
  })
})

test('active runs queue user input and apply pending context revisions at a debug boundary', async () => {
  const requests: LlmChatRequest[] = []
  let releaseFirst!: (response: LlmChatResponse) => void
  const firstResponse = new Promise<LlmChatResponse>((resolve) => {
    releaseFirst = resolve
  })
  const llm = fakeLlm(async (request) => {
    requests.push(structuredClone({ ...request, signal: undefined }))
    if (requests.length === 1) return firstResponse
    return {
      provider: 'custom',
      model: 'test-model',
      text: JSON.stringify({ status: 'completed', content: 'Queued input applied.' }),
      raw: {},
    }
  })

  await withRuntime(async (client) => {
    const start = client.events.length
    client.send('chat.message.send', {
      clientMessageId: 'initial-debug-input',
      content: [{ type: 'text', text: 'Start the run.' }],
      autoStart: true,
    })
    await client.waitFor(
      'runtime.artifact.created',
      (event) => event.payload.artifact.kind === 'model-request',
      start,
    )

    const updateIndex = client.events.length
    client.send('chat.message.send', {
      clientMessageId: 'queued-debug-input',
      content: [{ type: 'text', text: 'Use this additional instruction.' }],
      autoStart: false,
    })
    const contextCreated = await client.waitFor(
      'runtime.context.revision.created',
      (event) => event.payload.context.parentId !== undefined,
      updateIndex,
    )
    assert.ok(contextCreated.payload.context.diffArtifactId)

    const snapshotIndex = client.events.length
    client.send('runtime.snapshot.get', {})
    const pendingSnapshot = await client.waitFor(
      'runtime.snapshot',
      (event) => event.payload.contexts.pendingId === contextCreated.payload.context.id,
      snapshotIndex,
    )
    const pendingId = pendingSnapshot.payload.contexts.pendingId as string

    const pauseIndex = client.events.length
    const pauseId = client.send('run.pause', {})
    await client.waitFor(
      'run.state.changed',
      (event) => event.correlationId === pauseId && event.payload.status === 'pause_requested',
      pauseIndex,
    )
    releaseFirst({
      provider: 'custom',
      model: 'test-model',
      text: JSON.stringify({ status: 'running', content: 'Continue with queued input.' }),
      raw: {},
    })
    await client.waitFor(
      'run.state.changed',
      (event) => event.correlationId === pauseId && event.payload.status === 'paused',
      pauseIndex,
    )

    const applyIndex = client.events.length
    client.send('runtime.context.apply', { contextRevisionId: pendingId })
    await client.waitFor(
      'runtime.context.applied',
      (event) => event.payload.contextRevisionId === pendingId,
      applyIndex,
    )
    client.send('run.resume', {})
    await client.waitFor(
      'run.state.changed',
      (event) => event.payload.status === 'completed',
      applyIndex,
    )
    assert.equal(requests.length, 2)
    assert.ok(requests[1]?.messages.some(
      (message) => message.role === 'user' && message.content.includes('additional instruction'),
    ))

    const diffIndex = client.events.length
    client.send('runtime.artifact.get', {
      artifactId: contextCreated.payload.context.diffArtifactId as string,
    })
    const diff = await client.waitFor(
      'runtime.artifact.content',
      (event) => event.payload.artifact.id === contextCreated.payload.context.diffArtifactId,
      diffIndex,
    )
    assert.match(JSON.stringify(diff.payload.value), /additional instruction/)
  }, { llm })
})

test('restarting a side-effecting tool requires confirmation and restores its input checkpoint', async () => {
  let calls = 0
  const llm = fakeLlm(async () => {
    calls += 1
    if (calls === 1) {
      return {
        provider: 'custom',
        model: 'test-model',
        text: '',
        toolCalls: [{
          id: 'load-writer',
          name: 'load_resources',
          arguments: { ids: ['project-files:write_file'] },
        }],
        raw: {},
      }
    }
    if (calls === 2) {
      return {
        provider: 'custom',
        model: 'test-model',
        text: '',
        toolCalls: [{
          id: 'write-debug-file',
          name: 'write_file',
          arguments: { file_name: 'debug-replay.txt', content: 'checkpoint replay' },
        }],
        raw: {},
      }
    }
    return {
      provider: 'custom',
      model: 'test-model',
      text: JSON.stringify({ status: 'completed', content: 'Written.' }),
      raw: {},
    }
  })

  await withRuntime(async (client, projectDir) => {
    const start = client.events.length
    client.send('chat.message.send', {
      clientMessageId: 'side-effect-replay',
      content: [{ type: 'text', text: 'Write the debug file.' }],
      autoStart: true,
    })
    await client.waitFor(
      'run.state.changed',
      (event) => event.payload.status === 'completed',
      start,
    )
    const writeStep = client.events.slice(start).find(
      (event): event is EventOf<'timeline.step.upserted'> =>
        event.type === 'timeline.step.upserted' &&
        event.payload.step.type === 'tool' &&
        event.payload.step.status === 'success' &&
        event.payload.step.detail?.toolName === 'write_file',
    )
    assert.ok(writeStep)
    assert.equal(writeStep.payload.step.detail?.replay, 'confirm')
    assert.equal(typeof writeStep.payload.step.detail?.beforeCheckpointId, 'string')

    const rejectedIndex = client.events.length
    const rejectedId = client.send('run.restartStep', { stepId: writeStep.payload.step.id })
    const rejected = await client.waitFor(
      'command.rejected',
      (event) => event.correlationId === rejectedId,
      rejectedIndex,
    )
    assert.equal(rejected.payload.code, 'CONFIRMATION_REQUIRED')

    const restartIndex = client.events.length
    const restartId = client.send('run.restartStep', {
      stepId: writeStep.payload.step.id,
      confirmSideEffects: true,
    })
    const restartedStep = await client.waitFor(
      'timeline.step.upserted',
      (event) =>
        event.correlationId === restartId &&
        event.payload.step.id === writeStep.payload.step.id &&
        event.payload.step.status === 'success',
      restartIndex,
    )
    await client.waitFor(
      'run.state.changed',
      (event) =>
        event.correlationId === restartId &&
        event.payload.status === 'paused' &&
        event.sequence > restartedStep.sequence,
      restartIndex,
    )
    assert.equal(
      fs.readFileSync(path.join(projectDir, 'debug-replay.txt'), 'utf8'),
      'checkpoint replay',
    )
  }, { llm })
})

test('template, tool, and harness mutations use revisions and publish server results', async () => {
  await withRuntime(async (client, projectDir) => {
    const snapshot = await client.waitFor('runtime.snapshot')
    client.send('run.mode.set', { mode: 'step' })
    await client.waitFor(
      'run.state.changed',
      (event) => event.payload.mode === 'step',
      client.events.length - 1,
    )

    const templateIndex = client.events.length
    client.send('template.update', {
      templateId: snapshot.payload.template.id,
      baseRevision: snapshot.payload.template.revision,
      source: '# {{ task.title }}\n\nAgent: {{ agent.name }}',
    })
    const template = await client.waitFor('template.updated', () => true, templateIndex)
    assert.equal(
      fs.readFileSync(path.join(projectDir, 'main.j2'), 'utf8'),
      '# {{ task.title }}\n\nAgent: {{ agent.name }}',
    )
    const templateRender = await client.waitFor(
      'render.result.updated',
      (event) => event.payload.templateRevision === template.payload.revision,
      templateIndex,
    )
    assert.match(templateRender.payload.messages[0]?.content ?? '', /Agent: capybara/)
    const toolIndex = client.events.length
    client.send('runtime.tools.attach', {
      toolId: 'project-files:delete_file',
      baseRevision: snapshot.payload.tools.revision,
    })
    const firstAttached = await client.waitFor(
      'runtime.tools.updated',
      (event) => event.payload.items.some((tool) => tool.id === 'project-files:delete_file'),
      toolIndex,
    )
    assert.equal(firstAttached.payload.items.length, 1)
    const toolVariables = await client.waitFor(
      'variables.updated',
      (event) => event.payload.source === 'runtime',
      toolIndex,
    )
    assert.equal(toolVariables.payload.patch[0]?.path, '/tools')

    const detachIndex = client.events.length
    client.send('runtime.tools.detach', {
      toolId: 'project-files:delete_file',
      baseRevision: firstAttached.payload.revision,
    })
    const detached = await client.waitFor(
      'runtime.tools.updated',
      (event) => !event.payload.items.some((tool) => tool.id === 'project-files:delete_file'),
      detachIndex,
    )
    assert.equal(detached.payload.items.length, 0)

    const attachIndex = client.events.length
    client.send('runtime.tools.attach', {
      toolId: 'project-files:delete_file',
      baseRevision: detached.payload.revision,
    })
    const attached = await client.waitFor(
      'runtime.tools.updated',
      (event) => event.payload.items.some((tool) => tool.id === 'project-files:delete_file'),
      attachIndex,
    )
    assert.equal(attached.payload.items.length, 1)

    const addIndex = client.events.length
    client.send('runtime.harnesses.attach', {
      baseRevision: snapshot.payload.harnesses.revision,
      harnessId: 'document-analysis:version-summary',
    })
    const added = await client.waitFor(
      'runtime.harnesses.updated',
      (event) => event.payload.items.some((item) =>
        item.id === 'document-analysis:version-summary'
        && item.bindings.some((binding) => binding.source === 'user')),
      addIndex,
    )
    const harness = added.payload.items.find((item) => item.id === 'document-analysis:version-summary')
    assert.ok(harness)
    assert.equal(harness.status, 'active')
    assert.ok(harness.renderArtifactId)

    const removeIndex = client.events.length
    client.send('runtime.harnesses.detach', {
      baseRevision: added.payload.revision,
      harnessId: harness.id,
    })
    await client.waitFor(
      'runtime.harnesses.updated',
      (event) => !event.payload.items.some((item) => item.id === harness.id),
      removeIndex,
    )

    const conflictId = client.send('runtime.tools.attach', {
      toolId: 'project-files:delete_file',
      baseRevision: 1,
    })
    const conflict = await client.waitFor(
      'command.rejected',
      (event) => event.correlationId === conflictId,
      removeIndex,
    )
    assert.equal(conflict.payload.code, 'REVISION_CONFLICT')
    assert.equal(conflict.payload.currentRevision, attached.payload.revision)
  })
})

test('runtime skills use progressive disclosure and controlled manual resources', async () => {
  await withRuntime(async (client, projectDir) => {
    const snapshot = client.events.find((event) => event.type === 'runtime.snapshot')
    assert.ok(snapshot?.type === 'runtime.snapshot')
    assert.ok(snapshot.payload.skills.catalog.some((skill) => skill.id === 'project-files'))
    assert.equal(snapshot.payload.skills.items.length, 0)
    assert.doesNotMatch(snapshot.payload.renderResult?.messages[0]?.content ?? '', /# Project Files/)

    const attachIndex = client.events.length
    client.send('runtime.skills.attach', {
      skillId: 'project-files',
      baseRevision: snapshot.payload.skills.revision,
    })
    const attached = await client.waitFor(
      'runtime.skills.updated',
      (event) => event.payload.items.some((skill) => skill.id === 'project-files'),
      attachIndex,
    )
    assert.equal(attached.payload.items[0]?.status, 'active')
    assert.equal(attached.payload.items[0]?.requiredTools.length, 6)
    const tools = await client.waitFor(
      'runtime.tools.updated',
      (event) => event.payload.items.length >= 6,
      attachIndex,
    )
    assert.ok(tools.payload.items.some((tool) => tool.id === 'project-files:read_file'))
    const toolHarness = await client.waitFor(
      'runtime.harnesses.updated',
      (event) => event.payload.items.some((harness) => harness.id === 'filesystem-guidance:file-inspection'),
      attachIndex,
    )
    assert.equal(
      toolHarness.payload.items.find((harness) => harness.id === 'filesystem-guidance:file-inspection')?.status,
      'active',
    )
    const requiredDetachIndex = client.events.length
    client.send('runtime.tools.detach', {
      toolId: 'project-files:read_file',
      baseRevision: tools.payload.revision,
    })
    const requiredDetach = await client.waitFor('command.rejected', () => true, requiredDetachIndex)
    assert.equal(requiredDetach.payload.code, 'INVALID_STATE')
    const rendered = await client.waitFor(
      'render.result.updated',
      (event) => /# Project Files/.test(event.payload.messages[0]?.content ?? ''),
      attachIndex,
    )
    assert.match(rendered.payload.messages[0]?.content ?? '', /Registered scripts: scripts\/inventory\.mjs/)

    const referenceIndex = client.events.length
    client.send('runtime.skills.reference.load', {
      skillId: 'project-files',
      path: 'references/safety.md',
      baseRevision: attached.payload.revision,
    })
    const reference = await client.waitFor(
      'runtime.skills.updated',
      (event) => event.payload.items[0]?.resources.some(
        (resource) => resource.path === 'references/safety.md' && resource.status === 'loaded',
      ) ?? false,
      referenceIndex,
    )
    assert.match(
      reference.payload.items[0]?.resources.find((item) => item.path === 'references/safety.md')?.content ?? '',
      /workspace/i,
    )
    await client.waitFor(
      'runtime.context.revision.created',
      () => true,
      referenceIndex,
    )

    const scriptIndex = client.events.length
    client.send('runtime.skills.script.run', {
      skillId: 'project-files',
      path: 'scripts/inventory.mjs',
      argv: ['--max-depth', '0', '--max-entries', '5'],
      baseRevision: reference.payload.revision,
    })
    const script = await client.waitFor(
      'runtime.skills.updated',
      (event) => event.payload.items[0]?.resources.some(
        (resource) => resource.path === 'scripts/inventory.mjs' && resource.status === 'loaded',
      ) ?? false,
      scriptIndex,
    )
    assert.match(
      script.payload.items[0]?.resources.find((item) => item.path === 'scripts/inventory.mjs')?.content ?? '',
      /entries/,
    )
    await client.waitFor(
      'runtime.artifact.created',
      (event) => event.payload.artifact.kind === 'skill-script-result',
      scriptIndex,
    )

    const rejectedIndex = client.events.length
    client.send('runtime.skills.reference.load', {
      skillId: 'project-files',
      path: '../SKILL.md',
      baseRevision: script.payload.revision,
    })
    const rejected = await client.waitFor('command.rejected', () => true, rejectedIndex)
    assert.equal(rejected.payload.code, 'NOT_FOUND')

    const scriptRejectedIndex = client.events.length
    client.send('runtime.skills.script.run', {
      skillId: 'project-files',
      path: 'SKILL.md',
      argv: [],
      baseRevision: script.payload.revision,
    })
    const scriptRejected = await client.waitFor('command.rejected', () => true, scriptRejectedIndex)
    assert.equal(scriptRejected.payload.code, 'NOT_FOUND')

    const skillFile = path.join(projectDir, 'skills', 'project-files', 'SKILL.md')
    const hotIndex = client.events.length
    fs.appendFileSync(skillFile, '\nHot reload marker.\n')
    const hot = await client.waitFor(
      'runtime.skills.updated',
      (event) => event.payload.items[0]?.instructions.includes('Hot reload marker.') ?? false,
      hotIndex,
    )
    assert.match(hot.payload.items[0]?.instructions ?? '', /Hot reload marker/)

    client.send('run.mode.set', { mode: 'step' })
    await client.waitFor('run.state.changed', (event) => event.payload.mode === 'step')
    const traceIndex = client.events.length
    client.send('run.start', {})
    await client.waitFor('run.trace.started', () => true, traceIndex)
    const initialCheckpoint = await client.waitFor(
      'runtime.checkpoint.created',
      (event) => event.payload.checkpoint.currentStep === 0,
      traceIndex,
    )
    const checkpointId = initialCheckpoint.payload.checkpoint.id
    const detachIndex = client.events.length
    client.send('runtime.skills.detach', {
      skillId: 'project-files',
      baseRevision: hot.payload.revision,
    })
    const detached = await client.waitFor(
      'runtime.skills.updated',
      (event) => event.payload.items.length === 0,
      detachIndex,
    )
    const restoreIndex = client.events.length
    client.send('run.restoreCheckpoint', { checkpointId })
    const restored = await client.waitFor(
      'runtime.skills.updated',
      (event) => event.payload.items.some((skill) => skill.id === 'project-files'),
      restoreIndex,
    )
    assert.ok(restored.payload.revision > detached.payload.revision)
  })
})

test('model-loaded skill references and scripts reach subsequent model requests', async () => {
  const requests: LlmChatRequest[] = []
  const calls = [
    { id: 'load-skill', name: 'load_resources', arguments: { ids: ['project-files'] } },
    { id: 'read-reference', name: 'read_skill_resource', arguments: { skill_id: 'project-files', path: 'references/safety.md' } },
    { id: 'run-script', name: 'run_skill_script', arguments: { skill_id: 'project-files', path: 'scripts/inventory.mjs', argv: ['--max-depth', '0', '--max-entries', '3'] } },
  ]
  const llm = fakeLlm(async (request) => {
    requests.push(structuredClone(request))
    const toolCall = calls[requests.length - 1]
    return {
      provider: 'custom',
      model: 'test-model',
      text: toolCall ? '' : JSON.stringify({ status: 'completed', content: 'Skill flow complete.' }),
      ...(toolCall ? { toolCalls: [toolCall] } : {}),
      finishReason: toolCall ? 'tool_calls' : 'stop',
      raw: {},
    }
  })
  await withRuntime(async (client) => {
    client.send('chat.message.send', {
      clientMessageId: 'skill-flow-user',
      content: [{ type: 'text', text: 'Inspect the project safely.' }],
      autoStart: true,
    })
    await client.waitFor('chat.assistant.completed')
    assert.equal(requests.length, 4)
    assert.doesNotMatch(requests[0]?.messages[0]?.content ?? '', /# Project Files/)
    assert.match(requests[1]?.messages[0]?.content ?? '', /# Project Files/)
    assert.match(requests[2]?.messages[0]?.content ?? '', /skill reference: references\/safety\.md/)
    const scriptResult = requests[3]?.messages.find(
      (message) => message.role === 'tool' && message.name === 'run_skill_script',
    )
    assert.match(scriptResult?.content ?? '', /entries/)
    const snapshotIndex = client.events.length
    client.send('runtime.snapshot.get', {})
    const snapshot = await client.waitFor('runtime.snapshot', () => true, snapshotIndex)
    assert.equal(snapshot.payload.skills.items[0]?.id, 'project-files')
    assert.ok(snapshot.payload.contexts.items.length >= 3)
  }, { llm })
})

test('saving a loaded harness through Resources updates its j2 file and rendered context', async () => {
  let modelCalls = 0
  const llm = fakeLlm(async () => {
    modelCalls += 1
    return modelCalls === 1
      ? {
          provider: 'custom',
          model: 'test-model',
          text: '',
          toolCalls: [{
            id: 'load-developer-harness',
            name: 'load_resources',
            arguments: { ids: ['document-analysis:version-summary'] },
          }],
          raw: {},
        }
      : {
          provider: 'custom',
          model: 'test-model',
          text: JSON.stringify({ status: 'completed', content: 'Harness loaded.' }),
          raw: {},
        }
  })
  await withRuntime(async (client, projectDir, app) => {
    const loadIndex = client.events.length
    client.send('chat.message.send', {
      clientMessageId: 'load-harness-message',
      content: [{ type: 'text', text: 'Load the developer harness.' }],
      autoStart: true,
    })
    await client.waitFor(
      'run.state.changed',
      (event) => event.payload.status === 'completed',
      loadIndex,
    )
    await client.waitFor(
      'runtime.harnesses.updated',
      (event) => event.payload.items.some((item) => item.id === 'document-analysis:version-summary'),
      loadIndex,
    )
    const snapshotIndex = client.events.length
    const snapshotId = client.send('runtime.snapshot.get', {})
    const current = await client.waitFor(
      'runtime.snapshot',
      (event) => event.correlationId === snapshotId,
      snapshotIndex,
    )
    const harness = current.payload.harnesses.items.find(
      (item) => item.id === 'document-analysis:version-summary',
    )
    assert.ok(harness)

    const catalog = (await app.inject({
      method: 'GET',
      url: '/api/resources/catalog',
    })).json<any>()
    const resource = catalog.items
      .find((item: any) => item.kind === 'harness' && item.harnesses.some(
        (definition: any) => definition.id === harness.id,
      ))
      .harnesses.find((definition: any) => definition.id === harness.id)
    const startIndex = client.events.length
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/resources/harnesses/${encodeURIComponent(harness.id)}`,
      payload: {
        content: 'Harness saved through the Resource API.',
        revision: resource.entryRevision,
      },
    })
    assert.equal(saved.statusCode, 200)

    const updated = await client.waitFor(
      'runtime.harnesses.updated',
      (event) => event.payload.items.find((item) => item.id === harness.id)?.content === 'Harness saved through the Resource API.',
      startIndex,
    )
    const rendered = await client.waitFor(
      'render.result.updated',
      (event) => event.payload.messages[0]?.content.includes('Harness saved through the Resource API.') ?? false,
      startIndex,
    )

    assert.ok(updated.payload.revision > current.payload.harnesses.revision)
    assert.match(rendered.payload.messages[0]?.content ?? '', /Harness saved through the Resource API/)
    assert.equal(
      fs.readFileSync(path.join(projectDir, 'harnesses/experience/document-analysis/version-summary.j2'), 'utf8'),
      'Harness saved through the Resource API.',
    )
  }, { llm })
})

test('project sessions persist runtime requests and can be cleared', async () => {
  await withRuntime(async (client, projectDir, app) => {
    const initial = client.events.find((event) => event.type === 'runtime.snapshot')
    assert.ok(initial?.type === 'runtime.snapshot')
    client.send('runtime.skills.attach', {
      skillId: 'project-files',
      baseRevision: initial.payload.skills.revision,
    })
    await client.waitFor(
      'runtime.skills.updated',
      (event) => event.payload.items.some((skill) => skill.id === 'project-files'),
    )
    client.send('chat.message.send', {
      clientMessageId: 'persisted-user-message',
      content: [{ type: 'text', text: 'persist this request' }],
      autoStart: true,
    })
    await client.waitFor('chat.assistant.completed')
    const attached = client.events.find((event) => event.type === 'session.attached')
    assert.ok(attached)
    const sessionId = attached.sessionId
    client.close()
    await new Promise((resolve) => setTimeout(resolve, 150))

    const address = app.server.address()
    assert.ok(address && typeof address === 'object')
    const resumed = await RuntimeClient.connect(
      `ws://127.0.0.1:${address.port}/ws/runtime?projectPath=${encodeURIComponent(projectDir)}&sessionId=${sessionId}`,
    )
    try {
      const resumedAttached = resumed.events.find((event) => event.type === 'session.attached')
      assert.ok(resumedAttached?.type === 'session.attached')
      assert.equal(resumedAttached.payload.resumeMode, 'snapshot')
      const snapshot = await resumed.waitFor('runtime.snapshot')
      assert.ok(snapshot.payload.conversation.messages.some(
        (message) => message.id === 'persisted-user-message' && message.requestId,
      ))
      assert.ok(snapshot.payload.effectiveContexts.items.length > 0)
      assert.ok(snapshot.payload.artifacts.items.some((artifact) => artifact.kind === 'model-request'))
      assert.equal(snapshot.payload.skills.items[0]?.id, 'project-files')
      assert.match(snapshot.payload.renderResult?.messages[0]?.content ?? '', /# Project Files/)

      const stats = await app.inject({
        method: 'GET',
        url: `/api/sessions/storage?projectPath=${encodeURIComponent(projectDir)}`,
      })
      assert.equal(stats.statusCode, 200)
      assert.equal(stats.json().sessionCount, 1)
      assert.ok(stats.json().bytes > 0)

      const renamed = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${sessionId}`,
        payload: { projectPath: projectDir, name: '  Investigation  ' },
      })
      assert.equal(renamed.statusCode, 200)
      assert.equal(renamed.json().name, 'Investigation')

      const listed = await app.inject({
        method: 'GET',
        url: `/api/sessions?projectPath=${encodeURIComponent(projectDir)}`,
      })
      assert.equal(listed.json().items[0].name, 'Investigation')

      const rejectedRename = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${sessionId}`,
        payload: { projectPath: projectDir, name: '   ' },
      })
      assert.equal(rejectedRename.statusCode, 400)
      assert.match(rejectedRename.json().error, /session name is required/)

      const overlongRename = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${sessionId}`,
        payload: { projectPath: projectDir, name: 'x'.repeat(81) },
      })
      assert.equal(overlongRename.statusCode, 400)
      assert.match(overlongRename.json().error, /must not exceed 80 characters/)

      const cleared = await app.inject({
        method: 'DELETE',
        url: `/api/sessions?projectPath=${encodeURIComponent(projectDir)}`,
      })
      assert.equal(cleared.statusCode, 200)
      assert.equal(cleared.json().sessionCount, 0)
    } finally {
      resumed.close()
    }
  })
})

test('SQLite session restore refreshes active skills from current project files', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-session-restart-'))
  fs.cpSync(path.resolve(process.env.CAPYBARA_TEST_PROJECT_DIR ?? 'test-project'), projectDir, {
    filter: (source) => !path.basename(source).startsWith('sessions.sqlite'),
    recursive: true,
  })
  let sessionId = ''
  const firstApp = await buildApp({
    runtimeLoop: { projectDir, llm: fakeLlm(), streamDelayMs: 1, stepDelayMs: 1 },
  })
  try {
    await firstApp.listen({ host: '127.0.0.1', port: 0 })
    const address = firstApp.server.address()
    assert.ok(address && typeof address === 'object')
    const client = await RuntimeClient.connect(`ws://127.0.0.1:${address.port}/ws/runtime`)
    try {
      const attached = client.events.find((event) => event.type === 'session.attached')
      const snapshot = client.events.find((event) => event.type === 'runtime.snapshot')
      assert.ok(attached?.type === 'session.attached' && snapshot?.type === 'runtime.snapshot')
      sessionId = attached.sessionId
      client.send('runtime.skills.attach', {
        skillId: 'project-files',
        baseRevision: snapshot.payload.skills.revision,
      })
      await client.waitFor(
        'runtime.skills.updated',
        (event) => event.payload.items.some((skill) => skill.id === 'project-files'),
      )
    } finally {
      client.close()
    }
  } finally {
    await firstApp.close()
  }

  fs.appendFileSync(
    path.join(projectDir, 'skills', 'project-files', 'SKILL.md'),
    '\nLoaded after process restart.\n',
  )
  const secondApp = await buildApp({
    runtimeLoop: { projectDir, llm: fakeLlm(), streamDelayMs: 1, stepDelayMs: 1 },
  })
  try {
    await secondApp.listen({ host: '127.0.0.1', port: 0 })
    const address = secondApp.server.address()
    assert.ok(address && typeof address === 'object')
    const client = await RuntimeClient.connect(
      `ws://127.0.0.1:${address.port}/ws/runtime?projectPath=${encodeURIComponent(projectDir)}&sessionId=${sessionId}`,
    )
    try {
      const snapshot = await client.waitFor('runtime.snapshot')
      assert.match(snapshot.payload.skills.items[0]?.instructions ?? '', /Loaded after process restart/)
      assert.match(snapshot.payload.renderResult?.messages[0]?.content ?? '', /Loaded after process restart/)
      assert.equal(snapshot.payload.variables.value.builtin.config_file, path.join(projectDir, '.capybara', 'config.json'))
      assert.equal(snapshot.payload.contexts.items.at(-1)?.reason, 'restore-refresh')
    } finally {
      client.close()
    }
  } finally {
    await secondApp.close()
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
