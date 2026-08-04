import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { ProjectResources } from '#core/project-resources'
import { RuntimeLoop } from '#core/runtime-loop'
import type { ClientCommand } from '#protocol/runtime-protocol'

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
  } finally {
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
