import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { collectCodeInputs, freezeInventory, freezePluginSnapshot, hashTree, inspectPluginResources, inspectRuntimeBinding } from '../src/phase0_inventory.mjs'

function write(root, path, content) {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content))
  return target
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gaia2-phase0-'))
  t.after(() => {
    // Snapshots set readonly mode. Clear it only inside this test-owned temp root.
    function writable(dir) {
      if (!existsSync(dir)) return
      for (const file of hashTree(dir).files) chmodSync(join(dir, file.relativePath), 0o644)
    }
    try { writable(root) } catch { /* symlink tests unlink their own links before cleanup */ }
    rmSync(root, { recursive: true, force: true })
  })
  return root
}
function plugin(root, id = 'gaia2-runtime') {
  const source = join(root, 'source', id)
  write(source, 'capybara.plugin.json', {
    schemaVersion: 1, id, version: '1.0.0', resources: {
      variables: 'variables.json', harnesses: ['harnesses/manifest.json'], hooks: ['hooks'],
      ...(id === 'gaia2-evaluation' ? { trainingHooks: ['training-hooks'] } : {}),
    },
  })
  write(source, 'variables.json', { version: 1, variables: [
    { key: 'gaia2_context', type: 'object', value: { count: 0 }, required: true, readonly: false, scope: 'session' },
  ] })
  write(source, 'harnesses/manifest.json', { version: 1, package: id, harnesses: [
    { name: 'contract', description: 'contract', type: 'persistent', entry: 'contract.j2', activation: {}, inputs: ['builtin.variables.gaia2_context'], requiredTools: [] },
  ] })
  write(source, 'harnesses/contract.j2', '{{ builtin.variables.gaia2_context }}')
  const hook = 'import { defineHook } from "@capybara-agent/sdk";\nexport default defineHook({ name: "test-hook", checkpoint: "after_loop", run() { return {}; } });\n'
  write(source, 'hooks/test.ts', hook)
  if (id === 'gaia2-evaluation') write(source, 'training-hooks/correction.ts', hook.replace('test-hook', 'test-correction'))
  return source
}

test('tree hashes are deterministic, content sensitive, and exclude mutable Python caches', (t) => {
  const root = fixture(t)
  write(root, 'b.py', 'print(2)')
  write(root, 'a.py', 'print(1)')
  const original = hashTree(root)
  write(root, '__pycache__/a.pyc', 'mutable cache')
  write(root, 'extra.pyo', 'mutable bytecode')
  write(root, '.git/HEAD', 'git metadata')
  assert.deepEqual(hashTree(root), original)
  assert.deepEqual(original.files.map((file) => file.relativePath), ['a.py', 'b.py'])
  write(root, 'b.py', 'print(3)')
  assert.notEqual(hashTree(root).treeSha256, original.treeSha256)
})

test('plugin snapshots are independent content-addressed immutable copies', (t) => {
  const root = fixture(t)
  const sourceRoot = plugin(root)
  const frozen = freezePluginSnapshot({ root, id: 'gaia2-runtime', sourceRoot })
  assert.ok(frozen.snapshotRoot.includes(`/.phase0-cache/plugins/gaia2-runtime/${frozen.treeSha256}`))
  assert.notEqual(frozen.snapshotRoot, sourceRoot.replaceAll('\\', '/'))
  const contents = readFileSync(join(frozen.snapshotRoot, 'hooks/test.ts'), 'utf8')
  write(sourceRoot, 'hooks/test.ts', 'changed live user source')
  assert.equal(readFileSync(join(frozen.snapshotRoot, 'hooks/test.ts'), 'utf8'), contents)
  assert.equal(hashTree(frozen.snapshotRoot).treeSha256, frozen.treeSha256)
  const next = freezePluginSnapshot({ root, id: 'gaia2-runtime', sourceRoot })
  assert.notEqual(next.snapshotRoot, frozen.snapshotRoot)
  assert.equal(hashTree(frozen.snapshotRoot).treeSha256, frozen.treeSha256)
})

test('existing snapshot reuse validates contents and refuses to overwrite tampered snapshot', (t) => {
  const root = fixture(t)
  const sourceRoot = plugin(root)
  const frozen = freezePluginSnapshot({ root, id: 'gaia2-runtime', sourceRoot })
  assert.deepEqual(freezePluginSnapshot({ root, id: 'gaia2-runtime', sourceRoot }), frozen)
  const hook = join(frozen.snapshotRoot, 'hooks/test.ts')
  chmodSync(hook, 0o644)
  writeFileSync(hook, 'tampered')
  assert.throws(() => freezePluginSnapshot({ root, id: 'gaia2-runtime', sourceRoot }), /immutable snapshot integrity mismatch/)
  assert.equal(readFileSync(hook, 'utf8'), 'tampered')
})

test('typed variables, templates, hooks, and training hooks are inspected without claiming they loaded', (t) => {
  const root = fixture(t)
  for (const id of ['gaia2-runtime', 'gaia2-evaluation']) {
    const frozen = freezePluginSnapshot({ root, id, sourceRoot: plugin(root, id) })
    const result = inspectPluginResources(frozen)
    assert.equal(result.version, '1.0.0')
    assert.equal(result.resourceIntegrity.status, 'passed')
    assert.equal(result.variables.typedObjectCount, 1)
    assert.equal(result.harnesses[0].type, 'persistent')
    assert.equal(result.hooks.length, 1)
    assert.equal(result.trainingHooks.length, id === 'gaia2-evaluation' ? 1 : 0)
    assert.equal(result.pluginLoadStatus, 'not_loaded')
    assert.equal(result.runtimeBinding, 'sidecar_only')
    assert.equal(result.effectiveHookDecision, false)
  }
})

test('resource declarations cannot escape the snapshot and missing templates fail explicitly', (t) => {
  const root = fixture(t)
  const sourceRoot = plugin(root)
  const path = join(sourceRoot, 'harnesses/manifest.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  manifest.harnesses[0].entry = 'missing.j2'
  writeFileSync(path, JSON.stringify(manifest))
  let frozen = freezePluginSnapshot({ root, id: 'gaia2-runtime', sourceRoot })
  assert.throws(() => inspectPluginResources(frozen), /harness template missing/)
  manifest.harnesses[0].entry = '../../outside.j2'
  writeFileSync(path, JSON.stringify(manifest))
  frozen = freezePluginSnapshot({ root, id: 'gaia2-runtime', sourceRoot })
  assert.throws(() => inspectPluginResources(frozen), /must not traverse parents/)
})

test('unknown resource declarations and malformed variable values fail explicitly', (t) => {
  const root = fixture(t)
  const sourceRoot = plugin(root)
  const variables = JSON.parse(readFileSync(join(sourceRoot, 'variables.json'), 'utf8'))
  variables.variables[0].value = 'not an object'
  write(sourceRoot, 'variables.json', variables)
  let frozen = freezePluginSnapshot({ root, id: 'gaia2-runtime', sourceRoot })
  assert.throws(() => inspectPluginResources(frozen), /value does not match declared type/)
  const manifest = JSON.parse(readFileSync(join(sourceRoot, 'capybara.plugin.json'), 'utf8'))
  manifest.resources.unrecognized = ['unknown']
  write(sourceRoot, 'capybara.plugin.json', manifest)
  frozen = freezePluginSnapshot({ root, id: 'gaia2-runtime', sourceRoot })
  assert.throws(() => inspectPluginResources(frozen), /unknown resource declaration/)
})

test('tree hashing rejects symlinks instead of capturing mutable aliases', (t) => {
  const root = fixture(t)
  const source = join(root, 'tree')
  mkdirSync(source)
  const external = join(root, 'external')
  mkdirSync(external)
  write(external, 'test.txt', 'external')
  const link = join(source, 'link')
  try { symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('symlink creation unavailable'); throw error }
  try { assert.throws(() => hashTree(source), /symbolic link is not a frozen resource/) }
  finally { rmSync(link) }
})

test('codeInputs lock project code/config but not generated artifacts or secret configuration', (t) => {
  const root = fixture(t)
  write(root, 'src/code.mjs', 'export const code = 1')
  write(root, 'scripts/task.py', 'pass')
  write(root, 'test/code.test.mjs', 'test')
  write(root, 'schemas/input.json', { type: 'object' })
  write(root, 'config/phase0-protocol.json', { runtime: {} })
  write(root, 'config/llm-config.txt', 'secret config must not appear')
  write(root, 'config/secrets.json', 'secrets must not appear')
  write(root, 'package.json', { name: 'fixture' })
  write(root, 'package-lock.json', { packages: {} })
  write(root, 'gaia2-model-config.json', { model: 'fixture', apiKeySource: 'not-opened' })
  write(root, 'gaia2-runner-manifest.json', { runner: 'fixture' })
  write(root, 'requirements-official.txt', 'meta-agents-research-environments==1.2.0')
  write(root, 'data/input.json', 'generated data')
  write(root, 'reports/output.json', 'generated reports')
  write(root, 'locks/environment-lock.json', 'generated locks')
  write(root, '.phase0-cache/generated.json', 'generated cache')
  write(root, 'scripts/__pycache__/task.pyc', 'mutable')
  const input = collectCodeInputs(root)
  assert.equal(input.length, 10)
  assert.ok(input.every((file) => file.sha256.length === 64))
  assert.ok(input.every((file) => !/llm-config|secrets|__pycache__|^(?:data|reports|locks|\.phase0-cache)\//.test(file.path)))
  const first = collectCodeInputs(root)
  write(root, 'locks/environment-lock.json', 'changed generated locks')
  write(root, 'reports/output.json', 'changed report')
  assert.deepEqual(collectCodeInputs(root), first)
})

test('missing runtime configuration fails without invoking Python or a model', (t) => {
  const root = fixture(t)
  assert.throws(() => freezeInventory({ root, protocol: {} }), /protocol.runtime is required/)
  assert.throws(() => freezeInventory({ root, protocol: { runtime: { areVersion: '1.2.0' } } }), /runtime.python is required/)
  assert.equal(existsSync(join(root, 'locks')), false)
})

test('unknown actual runner binding is not silently labeled loaded or sidecar-only', (t) => {
  const root = fixture(t)
  const backend = join(root, 'backend')
  write(backend, 'src/main.ts', 'export {}')
  write(root, 'scripts/official_e2e_smoke.mjs', 'unknown runner')
  write(root, 'scripts/capybara_official_bridge.py', 'unknown bridge')
  write(root, 'scripts/official_integrated_pilot.mjs', 'unknown integration')
  write(root, 'src/runtime_attempt.mjs', 'unknown runtime')
  write(root, 'src/pass5_orchestrator.mjs', 'unknown orchestrator')
  assert.throws(() => inspectRuntimeBinding(root, backend), /unknown runtime binding/)
})

test('Stage 1 manifest wiring remains sidecar-only and excludes legacy orchestrators', (t) => {
  const root = fixture(t)
  const project = dirname(dirname(fileURLToPath(import.meta.url)))
  const backend = join(root, 'backend')
  write(backend, 'src/main.ts', 'export {}')
  const paths = [
    'scripts/official_e2e_smoke.mjs', 'scripts/official_all_smoke.mjs',
    'scripts/official_batch_smoke.mjs', 'scripts/official_integrated_pilot.mjs',
    'scripts/capybara_official_bridge.py', 'src/phase1_cli.mjs',
    'src/phase1_runner.mjs', 'src/phase1_official.mjs', 'src/phase1_process.mjs',
  ]
  for (const path of paths) write(root, path, readFileSync(join(project, path), 'utf8'))
  const binding = inspectRuntimeBinding(root, backend)
  assert.equal(binding.pluginLoadStatus, 'not_loaded')
  assert.equal(binding.runtimeBinding, 'sidecar_only')
  assert.equal(binding.effectiveHookDecision, false)
  assert.equal(binding.checks.length, 11)
  assert.ok(binding.checks.every(check => check.passed))
  assert.ok(binding.limitations.some(value => value.includes('Legacy Pass5Orchestrator')))
  write(root, 'scripts/official_integrated_pilot.mjs', 'unknown integration')
  assert.throws(() => inspectRuntimeBinding(root, backend), /unknown runtime binding/)
})
