import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { buildApp } from '#app'
import { resourceLanguage } from '#core/resources/resource-registry'

test('resource files expose editor language identifiers', () => {
  assert.deepEqual(
    ['main.j2', 'view.tsx', 'tool.py', 'config.yaml', 'run.sh', 'setup.ps1', 'notes.txt']
      .map(resourceLanguage),
    ['Jinja2', 'TSX', 'Python', 'YAML', 'Shell', 'PowerShell', 'Text'],
  )
})

test('resource HTTP API exposes tools, skills, and harnesses and executes their tests', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-resources-'))
  fs.cpSync(path.resolve(process.env.CAPYBARA_TEST_PROJECT_DIR ?? 'test-project'), projectDir, { recursive: true })
  const app = await buildApp({ runtimeLoop: { projectDir } })
  try {
    const catalogResponse = await app.inject({ method: 'GET', url: '/api/resources/catalog' })
    assert.equal(catalogResponse.statusCode, 200)
    const catalog = catalogResponse.json()
    const toolModule = catalog.items.find((item: any) => item.kind === 'tool')
    const skillModule = catalog.items.find((item: any) => item.kind === 'skill')
    const harnessModule = catalog.items.find(
      (item: any) => item.kind === 'harness' && item.package === 'document-analysis',
    )
    const hookModule = catalog.items.find((item: any) => item.kind === 'hook')
    const readFile = toolModule.tools.find((item: any) => item.id === 'project-files:read_file')
    const skill = skillModule.skills.find((item: any) => item.id === 'project-files')
    const versionHarness = harnessModule.harnesses.find(
      (item: any) => item.id === 'document-analysis:version-summary',
    )
    assert.equal(catalog.items.length, 6)
    assert.equal(hookModule.hooks[0].name, 'context-compression')
    assert.equal(toolModule.runner.entry, 'tools/files/runner.mjs')
    assert.deepEqual(toolModule.files.map((file: any) => file.role), ['manifest', 'runner'])
    assert.equal(readFile.diagnostics.length, 0)
    assert.equal(skillModule.source, 'skills/project-files/SKILL.md')
    assert.deepEqual(skillModule.files.map((file: any) => file.role), ['entry', 'script', 'reference'])
    assert.equal(skill.metadata.author, 'capybara')
    assert.equal(skill.compatibility, 'Requires project-scoped file tools provided by Capybara.')
    assert.deepEqual(skill.references, ['skills/project-files/references/safety.md'])
    assert.deepEqual(skill.scripts, ['skills/project-files/scripts/inventory.mjs'])
    assert.equal(versionHarness.type, 'experience')
    assert.equal(versionHarness.entry, 'harnesses/experience/document-analysis/version-summary.j2')

    const fileResponse = await app.inject({
      method: 'GET',
      url: `/api/resources/file?path=${encodeURIComponent(skill.entry)}`,
    })
    assert.match(fileResponse.json().content, /Project Files/)

    const toolResponse = await app.inject({
      method: 'POST',
      url: `/api/resources/tools/${encodeURIComponent(readFile.id)}/test`,
      payload: { arguments: { file_name: '.capybara/config.json', include_line_numbers: false } },
    })
    assert.equal(toolResponse.statusCode, 200)
    assert.equal(toolResponse.json().ok, true)
    assert.match(toolResponse.body, /max_tool_rounds/)

    const skillResponse = await app.inject({
      method: 'POST',
      url: `/api/resources/skills/${encodeURIComponent(skill.id)}/test`,
      payload: { context: {} },
    })
    assert.equal(skillResponse.statusCode, 200)
    assert.equal(skillResponse.json().valid, true)
    assert.equal(skillResponse.json().progressiveDisclosure.discovery.name, 'project-files')
    assert.match(skillResponse.json().progressiveDisclosure.activation.instructions, /Inspect the narrowest/)
    assert.deepEqual(skillResponse.json().progressiveDisclosure.resources.references, [
      'skills/project-files/references/safety.md',
    ])
    assert.deepEqual(skillResponse.json().progressiveDisclosure.resources.scripts, [
      'skills/project-files/scripts/inventory.mjs',
    ])
    assert.doesNotMatch(skillResponse.body, /Do not use absolute paths/)

    const harnessResponse = await app.inject({
      method: 'POST',
      url: `/api/resources/harnesses/${encodeURIComponent(versionHarness.id)}/test`,
      payload: { context: { request: '查看文档并总结版本功能' } },
    })
    assert.equal(harnessResponse.statusCode, 200)
    assert.equal(harnessResponse.json().matched, true)
    assert.match(harnessResponse.json().rendered, /planned work/)
  } finally {
    await app.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('skill updates use optimistic resource revisions', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-skill-save-'))
  fs.cpSync(path.resolve(process.env.CAPYBARA_TEST_PROJECT_DIR ?? 'test-project'), projectDir, { recursive: true })
  const app = await buildApp({ runtimeLoop: { projectDir } })
  try {
    const catalog = (await app.inject({ method: 'GET', url: '/api/resources/catalog' })).json()
    const skillModule = catalog.items.find((item: any) => item.kind === 'skill')
    const skill = skillModule.skills[0]
    const url = `/api/resources/skills/${encodeURIComponent(skill.id)}`
    const content = `${skill.content}\nSaved through the Resource API.\n`
    const saved = await app.inject({
      method: 'PUT',
      url,
      payload: { content, revision: skill.entryRevision },
    })
    assert.equal(saved.statusCode, 200)
    assert.equal(saved.json().skills[0].content, content)
    assert.match(fs.readFileSync(path.join(projectDir, skill.entry), 'utf8'), /Resource API/)

    const savedRevision = saved.json().skills[0].entryRevision
    const beforeInvalid = fs.readFileSync(path.join(projectDir, skill.entry), 'utf8')
    const invalid = await app.inject({
      method: 'PUT',
      url,
      payload: { content: '# Missing frontmatter', revision: savedRevision },
    })
    assert.equal(invalid.statusCode, 400)
    assert.match(invalid.body, /YAML frontmatter/)
    assert.equal(fs.readFileSync(path.join(projectDir, skill.entry), 'utf8'), beforeInvalid)

    const conflict = await app.inject({
      method: 'PUT',
      url,
      payload: { content: 'stale', revision: skill.entryRevision },
    })
    assert.equal(conflict.statusCode, 409)
  } finally {
    await app.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('harness updates use optimistic revisions and preserve their manifest', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-harness-save-'))
  fs.cpSync(path.resolve(process.env.CAPYBARA_TEST_PROJECT_DIR ?? 'test-project'), projectDir, { recursive: true })
  const app = await buildApp({ runtimeLoop: { projectDir } })
  try {
    const catalog = (await app.inject({ method: 'GET', url: '/api/resources/catalog' })).json()
    const module = catalog.items.find(
      (item: any) => item.kind === 'harness' && item.package === 'document-analysis',
    )
    const harness = module.harnesses[0]
    const content = `${harness.content}\nSaved through the Harness Resource API.\n`
    const url = `/api/resources/harnesses/${encodeURIComponent(harness.id)}`
    const saved = await app.inject({
      method: 'PUT',
      url,
      payload: { content, revision: harness.entryRevision },
    })
    assert.equal(saved.statusCode, 200)
    assert.equal(saved.json().harnesses[0].content, content)
    assert.match(
      fs.readFileSync(path.join(projectDir, harness.entry), 'utf8'),
      /Harness Resource API/,
    )
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(projectDir, module.source), 'utf8')).package,
      'document-analysis',
    )

    const conflict = await app.inject({
      method: 'PUT',
      url,
      payload: { content: 'stale', revision: harness.entryRevision },
    })
    assert.equal(conflict.statusCode, 409)
  } finally {
    await app.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})
