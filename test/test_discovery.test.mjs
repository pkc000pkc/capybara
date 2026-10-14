import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const portable = path => path.replaceAll('\\', '/')
const pattern = 'test/**/*.{js,mjs,cjs}'

test('npm test bounds discovery to the complete repository test tree', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts.test, `node --test "${pattern}"`)
})

test('bounded Node discovery retains every JS test and all support modules', () => {
  const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    assert.equal(entry.isSymbolicLink(), false)
    const path = join(directory, entry.name)
    return entry.isDirectory() ? walk(path) : entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name) ? [portable(relative(root, path))] : []
  })
  // The Node version used by the actual launcher supplies the same Glob used
  // by its test runner. This inspects paths only; no test module is evaluated.
  const script = `const { Glob } = require('internal/fs/glob'); process.stdout.write(JSON.stringify([...new Glob([${JSON.stringify(pattern)}], {}).globSync()].map(path => path.replaceAll('\\\\', '/')).sort()))`
  const found = JSON.parse(execFileSync(process.execPath, ['--expose-internals', '-e', script], { cwd: root, encoding: 'utf8', windowsHide: true }))
  assert.deepEqual(found, walk(join(root, 'test')).sort())
  assert.ok(found.length > 0)
  assert.ok(found.every(path => path.startsWith('test/')))
  for (const helper of ['correction_replay_fixture', 'runtime_evidence_fixture', 'training_proof_fixture']) assert.ok(found.includes(`test/support/${helper}.mjs`))
})
