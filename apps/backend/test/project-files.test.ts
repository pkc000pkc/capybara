import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { buildApp } from '#app'
import { initializeProjectDirectory } from '#core/project-initializer'

test('project file API browses, edits, creates, renames, and removes project directories', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-project-files-'))
  initializeProjectDirectory(projectDir)
  fs.writeFileSync(path.join(projectDir, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
  const app = await buildApp()
  const projectPath = encodeURIComponent(projectDir)

  try {
    const preflight = await app.inject({ method: 'OPTIONS', url: '/api/resources/files' })
    assert.equal(preflight.statusCode, 204)
    assert.match(String(preflight.headers['access-control-allow-methods']), /PATCH/)

    const root = await app.inject({
      method: 'GET',
      url: `/api/resources/files?projectPath=${projectPath}`,
    })
    assert.equal(root.statusCode, 200)
    const rootNames = root.json().entries.map((entry: { name: string }) => entry.name)
    assert.equal(rootNames.includes('.capybara'), true)
    assert.equal(rootNames.includes('binary.bin'), true)
    assert.equal(
      root.json().entries.find((entry: { name: string }) => entry.name === 'binary.bin').editable,
      false,
    )

    const initialFile = await app.inject({
      method: 'GET',
      url: `/api/resources/files/content?projectPath=${projectPath}&path=main.j2`,
    })
    assert.equal(initialFile.statusCode, 200)
    assert.match(initialFile.json().content, /builtin\.prompts\.agent_identity/)

    const saved = await app.inject({
      method: 'PUT',
      url: `/api/resources/files/content?projectPath=${projectPath}`,
      payload: {
        path: 'main.j2',
        content: 'Updated project prompt\n',
        revision: initialFile.json().revision,
      },
    })
    assert.equal(saved.statusCode, 200)
    assert.equal(saved.json().content, 'Updated project prompt\n')
    assert.equal(fs.readFileSync(path.join(projectDir, 'main.j2'), 'utf8'), 'Updated project prompt\n')

    const staleSave = await app.inject({
      method: 'PUT',
      url: `/api/resources/files/content?projectPath=${projectPath}`,
      payload: {
        path: 'main.j2',
        content: 'Stale overwrite\n',
        revision: initialFile.json().revision,
      },
    })
    assert.equal(staleSave.statusCode, 409)
    assert.match(staleSave.json().error, /changed on disk/)

    const createdDirectory = await app.inject({
      method: 'POST',
      url: `/api/resources/files?projectPath=${projectPath}`,
      payload: { parent: '', name: 'docs', type: 'directory' },
    })
    assert.equal(createdDirectory.statusCode, 201)
    assert.equal(createdDirectory.json().path, 'docs')

    const createdFile = await app.inject({
      method: 'POST',
      url: `/api/resources/files?projectPath=${projectPath}`,
      payload: { parent: 'docs', name: 'notes.md', type: 'file' },
    })
    assert.equal(createdFile.statusCode, 201)
    assert.equal(createdFile.json().path, 'docs/notes.md')

    const renamedDirectory = await app.inject({
      method: 'PATCH',
      url: `/api/resources/files?projectPath=${projectPath}`,
      payload: { path: 'docs', name: 'guides' },
    })
    assert.equal(renamedDirectory.statusCode, 200)
    assert.equal(renamedDirectory.json().path, 'guides')
    assert.equal(fs.existsSync(path.join(projectDir, 'guides', 'notes.md')), true)

    const refusedDelete = await app.inject({
      method: 'DELETE',
      url: `/api/resources/files?projectPath=${projectPath}`,
      payload: { path: 'guides', recursive: false },
    })
    assert.equal(refusedDelete.statusCode, 400)
    assert.match(refusedDelete.json().error, /recursive deletion must be confirmed/)

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/resources/files?projectPath=${projectPath}`,
      payload: { path: 'guides', recursive: true },
    })
    assert.equal(deleted.statusCode, 200)
    assert.equal(fs.existsSync(path.join(projectDir, 'guides')), false)

    const hiddenProjectFile = await app.inject({
      method: 'POST',
      url: `/api/resources/files?projectPath=${projectPath}`,
      payload: { parent: '.capybara', name: 'notes.txt', type: 'file' },
    })
    assert.equal(hiddenProjectFile.statusCode, 201)
    assert.equal(hiddenProjectFile.json().editable, true)

    const binaryRead = await app.inject({
      method: 'GET',
      url: `/api/resources/files/content?projectPath=${projectPath}&path=binary.bin`,
    })
    assert.equal(binaryRead.statusCode, 400)
    assert.match(binaryRead.json().error, /binary project files/)

    const traversal = await app.inject({
      method: 'GET',
      url: `/api/resources/files?projectPath=${projectPath}&path=${encodeURIComponent('../outside')}`,
    })
    assert.equal(traversal.statusCode, 400)
    assert.match(traversal.json().error, /leaves the project workspace/)
  } finally {
    await app.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})
