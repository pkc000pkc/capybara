import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { ToolDispatcher } from '#core/tools/tool-dispatcher'
import { ToolRegistry } from '#core/tools/tool-registry'

const projectDir = path.resolve(process.env.CAPYBARA_TEST_PROJECT_DIR ?? 'test-project')

test('registry loads project manifests and dispatcher enforces schemas and permissions', async () => {
  const registry = new ToolRegistry(projectDir)
  registry.load(['tools/files/manifest.json'])
  assert.deepEqual(
    registry.list().map((tool) => tool.name),
    ['read_file', 'list_files', 'search_file', 'search_in_file', 'write_file', 'delete_file'],
  )

  const denied = await new ToolDispatcher(registry, projectDir).dispatch({
    id: 'denied',
    name: 'read_file',
    arguments: { file_name: 'main.j2' },
  })
  assert.equal(denied.error?.code, 'PERMISSION_DENIED')

  const dispatcher = new ToolDispatcher(registry, projectDir, {
    permissions: ['filesystem:read'],
  })
  const invalid = await dispatcher.dispatch({
    id: 'invalid',
    name: 'read_file',
    arguments: {},
  })
  assert.equal(invalid.error?.code, 'INVALID_ARGUMENTS')

  const result = await dispatcher.dispatch({
    id: 'read',
    name: 'read_file',
    arguments: { file_name: '.capybara/config.json', include_line_numbers: false },
  })
  assert.equal(result.ok, true)
  assert.match(JSON.stringify(result.output), /max_tool_rounds/)
})

test('registry rejects manifests and runners that escape the project', () => {
  const registry = new ToolRegistry(projectDir)
  assert.throws(() => registry.load(['../package.json']), /leaves the project workspace/)
  assert.throws(() => registry.load([path.resolve('package.json')]), /project-relative/)
})

test('dispatcher keeps tool definitions separate from the selected workspace boundary', async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-workspace-'))
  try {
    fs.writeFileSync(path.join(workspaceDir, 'workspace.txt'), 'selected workspace')
    const registry = new ToolRegistry(projectDir)
    registry.load(['tools/files/manifest.json'])
    const dispatcher = new ToolDispatcher(registry, workspaceDir, {
      permissions: ['filesystem:read'],
    })
    const inside = await dispatcher.dispatch({
      id: 'workspace-read',
      name: 'read_file',
      arguments: { file_name: 'workspace.txt' },
    })
    assert.equal(inside.ok, true)
    assert.match(JSON.stringify(inside.output), /selected workspace/)

    const absolute = await dispatcher.dispatch({
      id: 'absolute-read',
      name: 'read_file',
      arguments: { file_name: path.resolve('package.json') },
    })
    assert.equal(absolute.ok, false)
    assert.match(absolute.error?.message ?? '', /absolute paths are not allowed/)
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true })
  }
})

test('dispatcher times out and aborts active project runners', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-tool-framework-'))
  try {
    fs.writeFileSync(path.join(dir, 'runner.mjs'), `
      let raw = ''
      for await (const chunk of process.stdin) raw += chunk
      const request = JSON.parse(raw)
      setTimeout(() => process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: {} })), 1000)
    `)
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      version: 1,
      package: 'slow',
      runner: { type: 'stdio', entry: 'runner.mjs' },
      tools: [{
        name: 'slow_tool',
        description: 'Wait before returning.',
        permissions: [],
        inputSchema: { type: 'object', additionalProperties: false },
      }],
    }))
    const registry = new ToolRegistry(dir)
    registry.load(['manifest.json'])
    const timeout = await new ToolDispatcher(registry, dir, { timeoutMs: 100 }).dispatch({
      id: 'timeout', name: 'slow_tool', arguments: {},
    })
    assert.equal(timeout.error?.code, 'TIMEOUT')

    const dispatcher = new ToolDispatcher(registry, dir, { timeoutMs: 5_000 })
    const pending = dispatcher.dispatch({ id: 'abort', name: 'slow_tool', arguments: {} })
    dispatcher.abort()
    assert.equal((await pending).error?.code, 'ABORTED')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('dispatcher validates declared tool output schemas', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-tool-output-'))
  try {
    fs.writeFileSync(path.join(dir, 'runner.mjs'), `
      let raw = ''
      for await (const chunk of process.stdin) raw += chunk
      const request = JSON.parse(raw)
      process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: {} }))
    `)
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      version: 1,
      package: 'output',
      runner: { type: 'stdio', entry: 'runner.mjs' },
      tools: [{
        name: 'validated_tool',
        description: 'Return schema-validated output.',
        permissions: [],
        inputSchema: { type: 'object' },
        outputSchema: {
          type: 'object',
          required: ['value'],
          properties: { value: { type: 'string' } },
        },
      }],
    }))
    const registry = new ToolRegistry(dir)
    registry.load(['manifest.json'])
    const result = await new ToolDispatcher(registry, dir).dispatch({
      id: 'output', name: 'validated_tool', arguments: {},
    })
    assert.equal(result.error?.code, 'INVALID_OUTPUT')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
