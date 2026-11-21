import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applicationForProject,
  projectById,
  sessionById,
  workbenchApplications,
  workbenchMenus,
  workbenchProjects,
  workbenchThreadEntries,
} from '../src/app/workbench-data'

test('workbench menu and project demo data preserve the product workspace contract', () => {
  assert.deepEqual(workbenchMenus.map((menu) => menu.label), ['文件', '视图', '工具', '帮助'])
  assert.equal(new Set(workbenchProjects.map((project) => project.id)).size, workbenchProjects.length)
  assert.ok(workbenchProjects.length >= 3)

  for (const project of workbenchProjects) {
    assert.ok(projectById(project.id))
    assert.ok(project.sessions.some((session) => session.id === project.selectedSessionId))
    assert.ok(applicationForProject(project.id))
    for (const session of project.sessions) {
      assert.equal(sessionById(session.id)?.id, session.id)
      assert.ok(workbenchThreadEntries[session.id]?.length, `missing thread entries for ${session.id}`)
    }
  }
})

test('each project application has a runtime block and user-visible content', () => {
  for (const application of workbenchApplications) {
    assert.ok(application.name)
    assert.ok(application.version)
    assert.ok(application.blocks.length >= 2)
    assert.ok(application.blocks.some((block) => block.kind === 'runtime'))
  }
})
