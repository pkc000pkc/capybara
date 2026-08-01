import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { buildApp } from '#app'
import { ProjectGitService } from '#core/project-git'

function temporaryProject(prefix = 'capybara-git-'): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.writeFileSync(path.join(directory, 'main.j2'), 'Initial prompt\n', 'utf8')
  return directory
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function configureIdentity(cwd: string): void {
  git(cwd, 'config', 'user.name', 'Capybara Test')
  git(cwd, 'config', 'user.email', 'capybara@example.invalid')
}

test('project Git initializes, protects local state, commits, diffs, and lists history', async (context) => {
  const projectDir = temporaryProject()
  context.after(() => fs.rmSync(projectDir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(projectDir, '.capybara'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.capybara', 'secrets.json'), '{"secret":true}\n', 'utf8')
  fs.writeFileSync(path.join(projectDir, '.capybara', 'sessions.sqlite'), 'runtime', 'utf8')

  const service = new ProjectGitService(projectDir)
  const before = await service.status()
  assert.equal(before.gitAvailable, true)
  assert.equal(before.initialized, false)

  const initialized = await service.initialize()
  assert.equal(initialized.initialized, true)
  assert.equal(initialized.branch, 'main')
  assert.ok(initialized.changes.some((change) => change.path === 'main.j2'))
  assert.ok(initialized.changes.some((change) => change.path === '.gitignore'))
  assert.ok(!initialized.changes.some((change) => change.path.includes('secrets.json')))
  assert.match(fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf8'), /experiments\.sqlite/)

  configureIdentity(projectDir)
  const first = await service.commit({ message: 'feat: initialize agent', paths: ['main.j2'] })
  assert.equal(first.status.clean, true)
  assert.deepEqual(first.committedPaths.sort(), ['.gitignore', 'main.j2'])
  assert.ok(first.commit.projectTreeSha)

  fs.writeFileSync(path.join(projectDir, 'main.j2'), 'Updated prompt\n', 'utf8')
  const changed = await service.status()
  assert.equal(changed.clean, false)
  assert.equal(changed.changes[0]?.kind, 'modified')
  const diff = await service.diff('main.j2')
  assert.match(diff.content, /-Initial prompt/)
  assert.match(diff.content, /\+Updated prompt/)
  await assert.rejects(() => service.diff('../outside.txt'), /stay inside/)

  const second = await service.commit({ message: 'feat: update prompt', paths: ['main.j2'] })
  assert.notEqual(second.commit.sha, first.commit.sha)
  const history = await service.history()
  assert.deepEqual(history.map((commit) => commit.subject), [
    'feat: update prompt',
    'feat: initialize agent',
  ])
})

test('project-scoped commit leaves staged files outside a nested Agent project untouched', async (context) => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-git-monorepo-'))
  context.after(() => fs.rmSync(repository, { recursive: true, force: true }))
  git(repository, 'init', '--initial-branch=main')
  configureIdentity(repository)
  const projectDir = path.join(repository, 'agent-project')
  fs.mkdirSync(projectDir)
  fs.writeFileSync(path.join(projectDir, 'main.j2'), 'Initial\n', 'utf8')
  fs.writeFileSync(path.join(repository, 'outside.txt'), 'Initial\n', 'utf8')
  git(repository, 'add', '.')
  git(repository, 'commit', '-m', 'initial repository')

  fs.writeFileSync(path.join(projectDir, 'main.j2'), 'Agent change\n', 'utf8')
  fs.writeFileSync(path.join(repository, 'outside.txt'), 'Outside change\n', 'utf8')
  git(repository, 'add', 'outside.txt')

  const service = new ProjectGitService(projectDir)
  const status = await service.status()
  assert.equal(status.projectSubpath, 'agent-project')
  assert.deepEqual(status.changes.map((change) => change.path), ['main.j2'])
  const result = await service.commit({ message: 'feat: update nested agent', paths: ['main.j2'] })
  assert.equal(result.status.clean, true)
  const committed = git(repository, 'show', '--pretty=format:', '--name-only', 'HEAD').split(/\r?\n/).filter(Boolean)
  assert.deepEqual(committed.sort(), ['agent-project/.gitignore', 'agent-project/main.j2'])
  assert.equal(git(repository, 'diff', '--cached', '--name-only'), 'outside.txt')
})

test('project Git HTTP API exposes status, diff, history, initialization, and commit', async (context) => {
  const projectDir = temporaryProject('capybara-git-http-')
  context.after(() => fs.rmSync(projectDir, { recursive: true, force: true }))
  const app = await buildApp({ runtimeLoop: { projectDir } })
  context.after(() => app.close())
  const projectQuery = `projectPath=${encodeURIComponent(projectDir)}`

  const initial = await app.inject({ method: 'GET', url: `/api/resources/git/status?${projectQuery}` })
  assert.equal(initial.statusCode, 200)
  assert.equal(initial.json().initialized, false)

  const initialized = await app.inject({ method: 'POST', url: `/api/resources/git/initialize?${projectQuery}` })
  assert.equal(initialized.statusCode, 200)
  configureIdentity(projectDir)

  const diff = await app.inject({
    method: 'GET',
    url: `/api/resources/git/diff?${projectQuery}&path=${encodeURIComponent('main.j2')}`,
  })
  assert.equal(diff.statusCode, 200)
  assert.match(diff.json().content, /Initial prompt/)

  const committed = await app.inject({
    method: 'POST',
    url: `/api/resources/git/commit?${projectQuery}`,
    payload: { message: 'feat: HTTP commit', paths: ['main.j2'] },
  })
  assert.equal(committed.statusCode, 200)
  assert.equal(committed.json().commit.subject, 'feat: HTTP commit')

  const history = await app.inject({ method: 'GET', url: `/api/resources/git/history?${projectQuery}` })
  assert.equal(history.statusCode, 200)
  assert.equal(history.json().items[0].subject, 'feat: HTTP commit')
})
