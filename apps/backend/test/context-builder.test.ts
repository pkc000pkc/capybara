import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ContextBuilder } from '#core/context-builder'

test('rerenders when properties select a different include', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-context-'))
  fs.mkdirSync(path.join(projectDir, 'roles'))
  fs.writeFileSync(path.join(projectDir, 'main.j2'), '{% include roleTemplate %}: {{ task }}')
  fs.writeFileSync(path.join(projectDir, 'roles', 'a.j2'), 'A')
  fs.writeFileSync(path.join(projectDir, 'roles', 'b.j2'), 'B')

  const builder = new ContextBuilder({
    projectDir,
    watch: false,
    properties: { roleTemplate: 'roles/a.j2', task: 'first' },
  })

  assert.equal(builder.build(), 'A: first')
  assert.deepEqual(builder.getIncludedFiles(), ['roles/a.j2'])
  assert.equal(builder.setProperty('roleTemplate', 'roles/b.j2'), 'B: first')
  assert.deepEqual(builder.getIncludedFiles(), ['roles/b.j2'])
  assert.equal(builder.setProperty('task', 'second'), 'B: second')
  builder.close()
  fs.rmSync(projectDir, { recursive: true, force: true })
})

test('uses null semantics for missing properties', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-context-'))
  fs.writeFileSync(
    path.join(projectDir, 'main.j2'),
    '{% if optional == null %}null{% else %}{{ optional }}{% endif %}|{{ nested.value }}',
  )

  const builder = new ContextBuilder({ projectDir, watch: false })
  let warningStatus: string | undefined
  let missingVariables: string[] = []
  builder.onRender((event) => {
    warningStatus = event.status
    missingVariables = event.missingVariables
  })

  assert.equal(builder.getProperty('optional'), null)
  assert.equal(builder.build(), 'null|')
  assert.equal(warningStatus, 'warning')
  assert.deepEqual(missingVariables, ['nested', 'optional'])
  assert.deepEqual(builder.getMissingVariables(), ['nested', 'optional'])
  assert.equal(builder.setProperty('optional', undefined), 'null|')
  assert.equal(builder.getProperty('optional'), null)
  assert.deepEqual(builder.getMissingVariables(), ['nested'])
  builder.close()
  fs.rmSync(projectDir, { recursive: true, force: true })
})

test('rerenders when an included template changes', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-context-'))
  const includeFile = path.join(projectDir, 'content.j2')
  fs.writeFileSync(path.join(projectDir, 'main.j2'), '{% include "content.j2" %}')
  fs.writeFileSync(includeFile, 'before')

  const builder = new ContextBuilder({ projectDir, debounceMs: 10 })

  try {
    assert.equal(builder.build(), 'before')

    const rendered = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for render')), 2_000)
      builder.onRender((event) => {
        if (event.reason === 'template') {
          clearTimeout(timeout)
          resolve(event.output)
        }
      })
    })

    fs.writeFileSync(includeFile, 'after')
    assert.equal(await rendered, 'after')
  } finally {
    builder.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})
