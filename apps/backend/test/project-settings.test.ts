import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { initializeProjectDirectory } from '#core/project-initializer'
import { ProjectResources } from '#core/project-resources'
import { RuntimeLoop, type RuntimeLlm } from '#core/runtime-loop'
import type { ClientCommand } from '#protocol/runtime-protocol'

test('legacy context settings infer the context window from max_input_tokens', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-legacy-context-'))
  try {
    initializeProjectDirectory(projectDir)
    const configFile = path.join(projectDir, '.capybara', 'config.json')
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    delete config.context.context_window_tokens
    delete config.llm.max_retries
    fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`)

    const settings = new ProjectResources(projectDir).readSettings()
    assert.equal(settings.context.context_window_tokens, settings.context.max_input_tokens)
    assert.equal(settings.llm.max_retries, 3)
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('project settings persist -1 or a non-negative integer as the model retry limit', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-model-retries-'))
  try {
    initializeProjectDirectory(projectDir)
    const resources = new ProjectResources(projectDir)
    assert.equal(resources.readSettings().llm.max_retries, 3)

    const unlimited = resources.saveSettings({
      llm: { ...resources.readSettings().llm, max_retries: -1 },
    })
    assert.equal(unlimited.llm.max_retries, -1)
    assert.equal(resources.readSettings().llm.max_retries, -1)
    const persisted = JSON.parse(fs.readFileSync(path.join(projectDir, '.capybara', 'config.json'), 'utf8'))
    assert.equal(persisted.llm.max_retries, -1)

    const disabled = resources.saveSettings({
      llm: { ...resources.readSettings().llm, max_retries: 0 },
    })
    assert.equal(disabled.llm.max_retries, 0)

    for (const value of [-2, 1.5]) {
      assert.throws(
        () => resources.saveSettings({
          llm: { ...resources.readSettings().llm, max_retries: value },
        }),
        /llm.max_retries must be -1 or a non-negative integer/,
      )
    }
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('project settings persist the codex-like model protocol', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-codex-like-'))
  try {
    initializeProjectDirectory(projectDir)
    const resources = new ProjectResources(projectDir)
    const saved = resources.saveSettings({
      llm: { ...resources.readSettings().llm, protocol: 'codex-like' },
    })
    assert.equal(saved.llm.protocol, 'codex-like')
    assert.equal(resources.readSettings().llm.protocol, 'codex-like')
    const persisted = JSON.parse(fs.readFileSync(path.join(projectDir, '.capybara', 'config.json'), 'utf8'))
    assert.equal(persisted.llm.protocol, 'codex-like')
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('project settings accept -1 or any positive integer as the Loop round limit', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-project-settings-'))
  try {
    initializeProjectDirectory(projectDir)
    const resources = new ProjectResources(projectDir)
    const unlimited = resources.saveSettings({
      ...resources.readSettings(),
      max_tool_rounds: -1,
      context: {
        ...resources.readSettings().context,
        context_window_tokens: 32_768,
        max_input_tokens: 20_000,
      },
    })
    assert.equal(unlimited.max_tool_rounds, -1)
    assert.equal(unlimited.context.context_window_tokens, 32_768)
    assert.equal(unlimited.context.max_input_tokens, 20_000)
    assert.equal(resources.readSettings().max_tool_rounds, -1)

    const largeFiniteLimit = resources.saveSettings({
      ...resources.readSettings(),
      max_tool_rounds: 1_000_000,
    })
    assert.equal(largeFiniteLimit.max_tool_rounds, 1_000_000)

    for (const value of [-2, 0, 1.5]) {
      assert.throws(
        () => resources.saveSettings({ ...resources.readSettings(), max_tool_rounds: value }),
        /max_tool_rounds must be -1 or a positive integer/,
      )
    }
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('project settings accept -1 as an unlimited project tool timeout', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-unlimited-tool-timeout-'))
  try {
    initializeProjectDirectory(projectDir)
    const resources = new ProjectResources(projectDir)
    const unlimited = resources.saveSettings({
      ...resources.readSettings(),
      tool_timeout_ms: -1,
    })
    assert.equal(unlimited.tool_timeout_ms, -1)
    assert.equal(resources.readSettings().tool_timeout_ms, -1)

    for (const value of [-2, 0, 99, 600_001]) {
      assert.throws(
        () => resources.saveSettings({ ...resources.readSettings(), tool_timeout_ms: value }),
        /tool_timeout_ms must be -1 or an integer between 100 and 600000/,
      )
    }
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('runtime does not stop continuation loops when max_tool_rounds is -1', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-unlimited-loop-'))
  let loop: RuntimeLoop | undefined
  try {
    initializeProjectDirectory(projectDir)
    const resources = new ProjectResources(projectDir)
    resources.saveSettings({ ...resources.readSettings(), max_tool_rounds: -1 })

    let modelCalls = 0
    const llm: RuntimeLlm = {
      chat: async () => {
        modelCalls += 1
        return {
          provider: 'custom',
          model: 'test-model',
          text: JSON.stringify(modelCalls === 1
            ? { status: 'running', content: 'Continue once.' }
            : { status: 'completed', content: 'Done.' }),
          raw: {},
        }
      },
      getConfig: () => ({
        provider: 'custom',
        protocol: 'responses',
        model: 'test-model',
        baseUrl: 'http://127.0.0.1/unused',
        timeoutMs: 1_000,
        maxRetries: 0,
      }),
    }
    loop = new RuntimeLoop({ projectDir, workspaceDir: projectDir, llm, streamDelayMs: 0, stepDelayMs: 0 })
    const completed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('runtime did not complete')), 5_000)
      const unsubscribe = loop?.onEvent((event) => {
        if (event.type !== 'run.state.changed') return
        if (event.payload.status === 'completed') {
          clearTimeout(timeout)
          unsubscribe?.()
          resolve()
        } else if (event.payload.status === 'failed') {
          clearTimeout(timeout)
          unsubscribe?.()
          reject(new Error(event.payload.failure?.message ?? 'runtime failed'))
        }
      })
    })
    const command: ClientCommand = {
      version: 1,
      kind: 'command',
      id: 'unlimited-loop-command',
      type: 'chat.message.send',
      sessionId: 'unlimited-loop-session',
      timestamp: new Date().toISOString(),
      payload: {
        clientMessageId: 'unlimited-loop-message',
        content: [{ type: 'text', text: 'Run through a continuation.' }],
        autoStart: true,
      },
    }
    loop.validate(command)
    loop.execute(command, 1)
    await completed
    assert.equal(modelCalls, 2)
  } finally {
    loop?.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})
