import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const runner = path.resolve(
  process.env.CAPYBARA_TEST_PROJECT_DIR ?? 'test-project',
  'tools/files/runner.mjs',
)

async function call(projectDir: string, tool: string, args: unknown) {
  const child = spawn(process.execPath, [runner], {
    env: { ...process.env, CAPYBARA_PROJECT_DIR: projectDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
  child.stdin.end(JSON.stringify({ id: 'test-call', tool, arguments: args }))
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve))
  assert.equal(code, 0, stderr)
  return JSON.parse(stdout) as { ok: boolean; result?: any; error?: string }
}

async function sandbox(run: (dir: string) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-file-tools-'))
  try {
    await run(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('project file runner reads, lists, searches, writes, patches, and deletes files', async () => {
  await sandbox(async (dir) => {
    fs.mkdirSync(path.join(dir, 'docs'))
    fs.writeFileSync(path.join(dir, 'docs', 'note.txt'), 'alpha\nneedle\nomega\n')

    const read = await call(dir, 'read_file', { file_name: 'docs/note.txt', start_line: 2, end_line: 2 })
    assert.equal(read.result.content, '2: needle')

    const list = await call(dir, 'list_files', { recursive: true })
    assert.deepEqual(list.result.entries.map((entry: any) => entry.path), ['docs', 'docs/note.txt'])

    const search = await call(dir, 'search_file', { query: 'needle', mode: 'content' })
    assert.equal(search.result.matches[0].line, 2)
    const inFile = await call(dir, 'search_in_file', { file_name: 'docs/note.txt', query: 'needle' })
    assert.equal(inFile.result.matches[0].before[0].text, 'alpha')

    assert.equal((await call(dir, 'write_file', { file_name: 'new.txt', content: 'one\n' })).ok, true)
    assert.equal((await call(dir, 'write_file', { file_name: 'new.txt', content: 'two\n', mode: 'append' })).ok, true)
    assert.equal(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8'), 'one\ntwo\n')

    const patch = ['--- a/new.txt', '+++ b/new.txt', '@@ -1,2 +1,2 @@', '-one', '+ONE', ' two', ''].join('\n')
    assert.equal((await call(dir, 'write_file', { file_name: 'new.txt', patch })).ok, true)
    assert.match(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8'), /^ONE/m)

    const createPatch = ['--- /dev/null', '+++ b/created.txt', '@@ -0,0 +1 @@', '+created', ''].join('\n')
    assert.equal((await call(dir, 'write_file', { file_name: 'created.txt', patch: createPatch })).ok, true)
    assert.equal(fs.readFileSync(path.join(dir, 'created.txt'), 'utf8'), 'created')

    assert.equal((await call(dir, 'delete_file', { file_name: 'new.txt' })).result.deleted, true)
    assert.equal(fs.existsSync(path.join(dir, 'new.txt')), false)
  })
})

test('project file runner rejects absolute paths, traversal, symlink escape, and binary files', async (context) => {
  await sandbox(async (dir) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-file-outside-'))
    context.after(() => fs.rmSync(outside, { recursive: true, force: true }))
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
    fs.writeFileSync(path.join(dir, 'binary.bin'), Buffer.from([0, 1, 2]))
    fs.mkdirSync(path.join(dir, '.capybara'))
    fs.writeFileSync(path.join(dir, '.capybara', 'secrets.json'), '{"secret":"value"}')

    assert.match((await call(dir, 'read_file', { file_name: path.join(outside, 'secret.txt') })).error ?? '', /absolute paths/)
    assert.match((await call(dir, 'read_file', { file_name: '../secret.txt' })).error ?? '', /inside the project/)
    assert.match((await call(dir, 'read_file', { file_name: 'binary.bin' })).error ?? '', /text files/)
    assert.match((await call(dir, 'read_file', { file_name: '.capybara/secrets.json' })).error ?? '', /private runtime configuration/)
    assert.match((await call(dir, 'write_file', { file_name: '.capybara/secrets.json', content: 'changed' })).error ?? '', /private runtime configuration/)
    assert.match((await call(dir, 'delete_file', { file_name: '.capybara/secrets.json' })).error ?? '', /private runtime configuration/)
    const listed = await call(dir, 'list_files', { recursive: true })
    assert.equal(listed.result.entries.some((entry: any) => entry.path === '.capybara/secrets.json'), false)
    const searched = await call(dir, 'search_file', { query: 'value', mode: 'content' })
    assert.equal(searched.result.matches.length, 0)

    try {
      fs.symlinkSync(outside, path.join(dir, 'escape'), 'junction')
      assert.match((await call(dir, 'read_file', { file_name: 'escape/secret.txt' })).error ?? '', /symlink target/)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    }
  })
})
