import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { initializeProjectDirectory, installSystemProjectResources } from '#core/project-initializer'
import { ProjectResources } from '#core/project-resources'
import { RuntimeLoop, type RuntimeLlm } from '#core/runtime-loop'
import type { ClientCommand } from '#protocol/runtime-protocol'
import type { LlmChatRequest } from '#util/llm'

function createRuntimeProject(projectDir: string): void {
  fs.mkdirSync(path.join(projectDir, '.capybara'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.capybara', 'config.json'), JSON.stringify({
    main_template: 'main.j2',
    max_messages: 20,
    max_tool_rounds: 8,
    tool_timeout_ms: 1_000,
    llm: {
      model: 'test-model',
      base_url: 'http://127.0.0.1:1',
      protocol: 'responses',
    },
    context: { max_input_tokens: 16_000, reserved_output_tokens: 2_000 },
    tools: [],
    skills: [],
    harnesses: [],
    harness_policy: {
      experience_top_k: 3,
      experience_threshold: 0.35,
      experience_auto_attach: true,
    },
    tool_permissions: [],
  }))
  fs.writeFileSync(path.join(projectDir, '.capybara', 'system-variables.json'), JSON.stringify({
    version: 1,
    variables: ['first_value', 'second_value'].map((key) => ({
      key,
      label: key,
      description: '',
      value: '',
      required: false,
      readonly: false,
      show_in_status: false,
      scope: 'project',
    })),
  }))
  fs.writeFileSync(
    path.join(projectDir, 'main.j2'),
    '{{ builtin.prompts.first_value }}:{{ builtin.prompts.second_value }}',
  )
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for shared variables')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function sharedCommand(
  sessionId: string,
  revision: number,
  key: string,
  value: string,
): ClientCommand {
  return {
    version: 1,
    kind: 'command',
    id: `${sessionId}-${key}`,
    type: 'variables.apply',
    sessionId,
    timestamp: new Date().toISOString(),
    payload: {
      baseRevision: revision,
      patch: [{ op: 'replace', path: `/builtin/prompts/${key}`, value }],
    },
  }
}

async function runLoopOnce(loop: RuntimeLoop, id: string): Promise<void> {
  const completed = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Runtime test timed out: ${id}`)), 5_000)
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
    sessionId: 'variable-authoring-session',
    timestamp: new Date().toISOString(),
    payload: {
      clientMessageId: `${id}-message`,
      content: [{ type: 'text', text: 'Create a customer_name context variable for Ada.' }],
      autoStart: true,
    },
  }
  loop.validate(command)
  loop.execute(command, 1)
  await completed
}

test('project-scoped system variable updates are serialized and preserve concurrent changes', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-system-variables-'))
  try {
    const resources = new ProjectResources(projectDir)
    resources.saveSystemVariables({
      version: 1,
      variables: [
        {
          key: 'first_value',
          label: 'First',
          description: '',
          value: '',
          required: false,
          readonly: false,
          show_in_status: false,
          scope: 'project',
        },
        {
          key: 'second_value',
          label: 'Second',
          description: '',
          value: '',
          required: false,
          readonly: false,
          show_in_status: false,
          scope: 'project',
        },
      ],
    })

    await Promise.all([
      resources.updateSharedSystemVariables([{ key: 'first_value', value: 'one' }]),
      resources.updateSharedSystemVariables([{ key: 'second_value', value: 'two' }]),
    ])

    const values = new Map(resources.readSystemVariables().variables.map((item) => [item.key, item.value]))
    assert.equal(values.get('first_value'), 'one')
    assert.equal(values.get('second_value'), 'two')
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('system variable change batches use revisions and roll back invalid templates', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-system-variable-changes-'))
  try {
    const resources = new ProjectResources(projectDir)
    resources.saveSystemVariables({ version: 1, variables: [] })
    const initial = resources.readSystemVariablesState()
    const applied = await resources.applySystemVariableChanges(initial.revision, [
      {
        op: 'upsert',
        key: 'customer_name',
        type: 'text',
        label: 'Customer name',
        value: 'Ada',
      },
      {
        op: 'upsert',
        key: 'dynamic_context',
        type: 'prompt_template',
        label: 'Dynamic context',
        value: 'Customer: {{ builtin.prompts.customer_name }}',
      },
    ])
    assert.notEqual(applied.revision, initial.revision)
    assert.deepEqual(applied.diff.map((item) => [item.op, item.key]), [
      ['add', 'customer_name'],
      ['add', 'dynamic_context'],
    ])

    await assert.rejects(
      resources.applySystemVariableChanges(initial.revision, [{
        op: 'upsert', key: 'stale_value', value: 'stale',
      }]),
      /revision conflict/,
    )
    const beforeInvalid = fs.readFileSync(resources.systemVariablesFile, 'utf8')
    await assert.rejects(
      resources.applySystemVariableChanges(applied.revision, [{
        op: 'upsert',
        key: 'customer_name',
        type: 'prompt_template',
        value: '{{ builtin.prompts.customer_name }}',
      }]),
      /circular prompt_template dependency/,
    )
    assert.equal(fs.readFileSync(resources.systemVariablesFile, 'utf8'), beforeInvalid)

    await assert.rejects(
      resources.applySystemVariableChanges(applied.revision, [{
        op: 'remove', key: 'customer_name',
      }]),
      /references unknown system variable "customer_name"/,
    )
    const removed = await resources.applySystemVariableChanges(applied.revision, [
      {
        op: 'upsert',
        key: 'dynamic_context',
        type: 'prompt_template',
        value: '',
      },
      { op: 'remove', key: 'customer_name' },
    ])
    assert.deepEqual(removed.diff.map((item) => [item.op, item.key]), [
      ['replace', 'dynamic_context'],
      ['remove', 'customer_name'],
    ])
    await assert.rejects(
      resources.applySystemVariableChanges(removed.revision, [{
        op: 'remove', key: 'sys_message',
      }]),
      /read-only/,
    )
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('system variable patches are sequential, preserve metadata, and reject invalid batches atomically', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-system-variable-patches-'))
  try {
    const resources = new ProjectResources(projectDir)
    resources.saveSystemVariables({
      version: 1,
      variables: [
        {
          key: 'run_progress',
          type: 'text',
          label: 'Run progress',
          description: 'Durable progress state.',
          value: 'committed=5\nnext=6\nstatus=idle',
          required: true,
          readonly: false,
          show_in_status: true,
          scope: 'project',
        },
        {
          key: 'story_ledger',
          type: 'text',
          label: 'Story ledger',
          description: 'Long-form state.',
          value: 'chapter=5\nstate=stable',
          required: false,
          readonly: false,
          show_in_status: false,
          scope: 'project',
        },
      ],
    })

    const initial = resources.readSystemVariablesState()
    const applied = await resources.applySystemVariableChanges(initial.revision, [{
      op: 'patch',
      key: 'run_progress',
      edits: [
        { old_text: 'committed=5\nnext=6', new_text: 'committed=6\nnext=7' },
        { old_text: 'next=7\nstatus=idle', new_text: 'next=7\nstatus=committed' },
      ],
    }])
    const patched = applied.resource.variables.find((variable) => variable.key === 'run_progress')
    assert.equal(patched?.value, 'committed=6\nnext=7\nstatus=committed')
    assert.deepEqual(
      patched && {
        type: patched.type,
        label: patched.label,
        description: patched.description,
        required: patched.required,
        readonly: patched.readonly,
        show_in_status: patched.show_in_status,
        scope: patched.scope,
      },
      {
        type: 'text',
        label: 'Run progress',
        description: 'Durable progress state.',
        required: true,
        readonly: false,
        show_in_status: true,
        scope: 'project',
      },
    )

    const beforeInvalid = fs.readFileSync(resources.systemVariablesFile, 'utf8')
    await assert.rejects(
      resources.applySystemVariableChanges(applied.revision, [{
        op: 'patch', key: 'run_progress', edits: [{ old_text: 'missing', new_text: 'value' }],
      }]),
      /matched 0 times/,
    )
    assert.equal(fs.readFileSync(resources.systemVariablesFile, 'utf8'), beforeInvalid)

    const repeated = await resources.applySystemVariableChanges(applied.revision, [{
      op: 'upsert', key: 'repeated_text', value: 'aaaa', scope: 'project',
    }])
    const beforeAmbiguous = fs.readFileSync(resources.systemVariablesFile, 'utf8')
    await assert.rejects(
      resources.applySystemVariableChanges(repeated.revision, [{
        op: 'patch', key: 'repeated_text', edits: [{ old_text: 'aa', new_text: 'b' }],
      }]),
      /matched more than 1 times/,
    )
    assert.equal(fs.readFileSync(resources.systemVariablesFile, 'utf8'), beforeAmbiguous)

    await assert.rejects(
      resources.applySystemVariableChanges(repeated.revision, [{
        op: 'patch', key: 'missing_variable', edits: [{ old_text: 'a', new_text: 'b' }],
      }]),
      /was not found/,
    )
    await assert.rejects(
      resources.applySystemVariableChanges(repeated.revision, [{
        op: 'patch', key: 'sys_message', edits: [{ old_text: 'a', new_text: 'b' }],
      }]),
      /read-only/,
    )

    const beforeBatchFailure = fs.readFileSync(resources.systemVariablesFile, 'utf8')
    await assert.rejects(
      resources.applySystemVariableChanges(repeated.revision, [
        {
          op: 'patch',
          key: 'run_progress',
          edits: [{ old_text: 'status=committed', new_text: 'status=complete' }],
        },
        {
          op: 'patch',
          key: 'story_ledger',
          edits: [{ old_text: 'missing state', new_text: 'state=updated' }],
        },
      ]),
      /matched 0 times/,
    )
    assert.equal(fs.readFileSync(resources.systemVariablesFile, 'utf8'), beforeBatchFailure)
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('model tools author variables and inject dynamic context into the next model turn', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-variable-authoring-'))
  initializeProjectDirectory(projectDir)
  const requests: LlmChatRequest[] = []
  const llm: RuntimeLlm = {
    chat: async (request) => {
      requests.push(structuredClone(request))
      if (requests.length === 1) {
        const readTool = request.tools?.find((tool) => tool.name === 'read_system_variables')
        const applyTool = request.tools?.find((tool) => tool.name === 'apply_system_variable_changes')
        assert.ok(readTool)
        assert.ok(applyTool)
        assert.ok(JSON.stringify(readTool.parameters).includes('keys'))
        const applySchema = JSON.stringify(applyTool.parameters)
        assert.ok(applySchema.includes('oneOf'))
        assert.ok(applySchema.includes('patch'))
        assert.match(request.messages[0]?.content ?? '', /System variable authoring protocol/)
        return {
          provider: 'custom',
          model: 'variable-model',
          text: '',
          toolCalls: [{
            id: 'read-variables',
            name: 'read_system_variables',
            arguments: { keys: ['dynamic_context', 'missing_context'] },
          }],
          finishReason: 'tool_calls',
          raw: {},
        }
      }
      if (requests.length === 2) {
        const readMessage = request.messages.find(
          (message) => message.role === 'tool' && message.name === 'read_system_variables',
        )
        const readResult = JSON.parse(readMessage?.content ?? '{}') as {
          result?: {
            revision?: string
            variables?: Array<{ key: string }>
            selected_keys?: string[]
            missing_keys?: string[]
            dynamic_context?: string
          }
        }
        assert.ok(readResult.result?.revision)
        assert.deepEqual(readResult.result?.variables?.map((item) => item.key), ['dynamic_context'])
        assert.deepEqual(readResult.result?.selected_keys, ['dynamic_context', 'missing_context'])
        assert.deepEqual(readResult.result?.missing_keys, ['missing_context'])
        assert.equal(typeof readResult.result?.dynamic_context, 'string')
        return {
          provider: 'custom',
          model: 'variable-model',
          text: '',
          toolCalls: [{
            id: 'apply-variables',
            name: 'apply_system_variable_changes',
            arguments: {
              base_revision: readResult.result.revision,
              changes: [
                {
                  op: 'upsert',
                  key: 'customer_name',
                  type: 'text',
                  label: 'Customer name',
                  value: 'Ada',
                },
                {
                  op: 'upsert',
                  key: 'dynamic_context',
                  type: 'prompt_template',
                  label: 'Dynamic context',
                  value: 'Customer name: {{ builtin.prompts.customer_name }}',
                },
              ],
            },
          }],
          finishReason: 'tool_calls',
          raw: {},
        }
      }
      assert.match(request.messages[0]?.content ?? '', /Active dynamic context:\s*Customer name: Ada/)
      const applyMessage = request.messages.find(
        (message) => message.role === 'tool' && message.name === 'apply_system_variable_changes',
      )
      const applyResult = JSON.parse(applyMessage?.content ?? '{}') as {
        result?: {
          context_updated?: boolean
          diff?: Array<{
            key: string
            before?: { value_length?: number; value_sha256?: string; value?: string }
            after?: { value_length?: number; value_sha256?: string; value?: string }
          }>
        }
      }
      assert.equal(applyResult.result?.context_updated, true)
      assert.deepEqual(applyResult.result?.diff?.map((item) => item.key), [
        'customer_name',
        'dynamic_context',
      ])
      for (const item of applyResult.result?.diff ?? []) {
        assert.equal(item.before?.value, undefined)
        assert.equal(item.after?.value, undefined)
        if (item.after) {
          assert.equal(typeof item.after.value_length, 'number')
          assert.match(item.after.value_sha256 ?? '', /^[a-f0-9]{64}$/)
        }
      }
      return {
        provider: 'custom',
        model: 'variable-model',
        text: JSON.stringify({ status: 'completed', content: 'Variable created.' }),
        finishReason: 'stop',
        raw: {},
      }
    },
    getConfig: () => ({
      provider: 'custom',
      protocol: 'responses',
      model: 'variable-model',
      baseUrl: 'http://127.0.0.1/unused',
      timeoutMs: 1_000,
      maxRetries: 0,
    }),
  }
  const loop = new RuntimeLoop({ projectDir, llm, stepDelayMs: 0, streamDelayMs: 0 })
  try {
    await runLoopOnce(loop, 'author-system-variable')
    assert.equal(requests.length, 3)
    const variables = new Map(
      new ProjectResources(projectDir).readSystemVariables().variables.map((item) => [item.key, item]),
    )
    assert.equal(variables.get('customer_name')?.value, 'Ada')
    assert.equal(variables.get('dynamic_context')?.type, 'prompt_template')
    assert.equal(
      loop.getSnapshot(0).variables.value.builtin.prompts.dynamic_context,
      'Customer name: Ada',
    )
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('system resource installation upgrades only built-in variable definitions', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-system-variable-upgrade-'))
  try {
    initializeProjectDirectory(projectDir)
    const resources = new ProjectResources(projectDir)
    const initial = JSON.parse(fs.readFileSync(resources.systemVariablesFile, 'utf8')) as {
      version: number
      variables: Array<Record<string, unknown>>
    }
    fs.writeFileSync(resources.systemVariablesFile, JSON.stringify({
      ...initial,
      variables: initial.variables.map((variable) => {
        if (variable.key === 'system_variable_read_tool_description') {
          return { ...variable, value: 'stale built-in description' }
        }
        if (variable.key === 'agent_identity') {
          return { ...variable, value: 'Custom project agent identity.' }
        }
        return variable
      }),
    }))

    const installed = installSystemProjectResources(projectDir)
    assert.ok(installed.includes('.capybara/system-variables.json'))
    const upgraded = new Map(
      resources.readSystemVariables().variables.map((variable) => [variable.key, variable.value]),
    )
    assert.equal(
      upgraded.get('system_variable_read_tool_description'),
      'Read selected system prompt variables and the current revision before proposing a change.',
    )
    assert.equal(upgraded.get('agent_identity'), 'Custom project agent identity.')
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('system variable scope defaults to session for legacy files', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-system-variables-'))
  try {
    fs.mkdirSync(path.join(projectDir, '.capybara'))
    fs.writeFileSync(path.join(projectDir, '.capybara', 'system-variables.json'), JSON.stringify({
      version: 1,
      variables: [{
        key: 'legacy_prompt',
        label: 'Legacy',
        description: '',
        value: 'value',
        required: false,
        readonly: false,
        show_in_status: false,
      }],
    }))
    const variable = new ProjectResources(projectDir).readSystemVariables().variables[0]
    assert.equal(variable?.scope, 'session')
    assert.equal(variable?.type, 'text')
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('runtime resolves and refreshes nested prompt_template values with transitive required references', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-prompt-templates-runtime-'))
  createRuntimeProject(projectDir)
  fs.writeFileSync(path.join(projectDir, '.capybara', 'system-variables.json'), JSON.stringify({
    version: 1,
    variables: [
      {
        key: 'template_parameter',
        type: 'text',
        label: 'Parameter',
        description: '',
        value: 'leaf-value',
        required: true,
        readonly: false,
        show_in_status: false,
        scope: 'project',
      },
      {
        key: 'template_level_2',
        type: 'prompt_template',
        label: 'Level 2',
        description: '',
        value: 'level2({{ builtin.prompts.template_parameter }})',
        required: true,
        readonly: false,
        show_in_status: false,
      },
      {
        key: 'template_level_1',
        type: 'prompt_template',
        label: 'Level 1',
        description: '',
        value: 'level1({{ builtin.prompts.template_level_2 }})',
        required: true,
        readonly: false,
        show_in_status: false,
      },
    ],
  }))
  fs.writeFileSync(
    path.join(projectDir, 'main.j2'),
    '{{ builtin.prompts.template_level_1 }}',
  )
  const loop = new RuntimeLoop({ projectDir, workspaceDir: projectDir })
  try {
    const snapshot = loop.getSnapshot(0)
    assert.equal(
      snapshot.variables.value.builtin.prompts.template_level_1,
      'level1(level2(leaf-value))',
    )
    assert.equal(snapshot.renderResult?.messages[0]?.content, 'level1(level2(leaf-value))')
    assert.equal(
      snapshot.renderResult?.diagnostics.some(
        (diagnostic) => diagnostic.code === 'MISSING_SYSTEM_VARIABLE_REFERENCE',
      ),
      false,
    )
    await new ProjectResources(projectDir).updateSharedSystemVariables([
      { key: 'template_parameter', value: 'updated-leaf' },
    ])
    await waitFor(() => (
      loop.getSnapshot(0).variables.value.builtin.prompts.template_level_1 ===
      'level1(level2(updated-leaf))'
    ))
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('parallel sessions receive all queued project-scoped variable updates', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-system-variables-runtime-'))
  createRuntimeProject(projectDir)
  const first = new RuntimeLoop({ projectDir, workspaceDir: projectDir })
  const second = new RuntimeLoop({ projectDir, workspaceDir: projectDir })
  try {
    const firstCommand = sharedCommand(
      'first-session',
      first.getSnapshot(0).variables.revision,
      'first_value',
      'one',
    )
    const secondCommand = sharedCommand(
      'second-session',
      second.getSnapshot(0).variables.revision,
      'second_value',
      'two',
    )
    first.validate(firstCommand)
    second.validate(secondCommand)
    first.execute(firstCommand, 1)
    second.execute(secondCommand, 1)

    await waitFor(() => [first, second].every((loop) => {
      const prompts = loop.getSnapshot(0).variables.value.builtin.prompts
      return prompts.first_value === 'one' && prompts.second_value === 'two'
    }))
  } finally {
    first.close()
    second.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})
