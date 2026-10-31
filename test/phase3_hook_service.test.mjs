import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileDigest } from '../src/phase0_run.mjs'
import { isProcessIdentityAlive } from '../src/phase1_process.mjs'
import { startRuntimeHookService } from '../src/phase3_hook_service.mjs'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gaia2-phase3-startup-'))
  const put = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value) }
  const backendRoot = join(root, 'backend')
  put('backend/node_modules/tsx/dist/loader.mjs', 'export {}\n')
  put('config/phase0-protocol.json', JSON.stringify({ runtime: { backendRoot } }))
  put('capabilities.json', JSON.stringify({ plugins: [] }))
  put('scripts/phase3_hook_server.ts', `import fs from 'node:fs';
const spec = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
fs.writeFileSync(spec.readyPath, '{malformed');
setInterval(() => {}, 1000);
`)
  mkdirSync(join(root, 'runs/startup/output'), { recursive: true })
  mkdirSync(join(root, 'runs/startup/workspace'))
  return { root, manifest: { runRoot: 'runs/startup', lockRefs: { capabilities: { path: 'capabilities.json', sha256: fileDigest(join(root, 'capabilities.json')) } } }, task: { executionId: 'startup-case', scenarioId: 'startup-fixture', runNumber: 1 }, session: { sessionId: 'startup-session', outputDir: 'runs/startup/output', workspaceDir: 'runs/startup/workspace' }, settings: { processTimeoutMs: 30000, heartbeatIntervalMs: 100 } }
}

test('malformed ready receipt fails closed and terminates the actually supervised host before returning', { timeout: 30000 }, async () => {
  const input = fixture()
  await assert.rejects(startRuntimeHookService(input), /real plugin host startup failed/)
  const spec = JSON.parse(readFileSync(join(input.root, input.session.outputDir, 'hook-host/spec.json'), 'utf8'))
  assert.equal(spec.options.hookTimeoutMs, 900000)
  assert.match(readFileSync(join(projectRoot, 'src/phase3_hook_service.mjs'), 'utf8'), /hookTimeoutMs:\s*900000/)
  assert.match(readFileSync(join(projectRoot, 'scripts/phase3_hook_server.ts'), 'utf8'), /createChildHost:\s*async[\s\S]*new RuntimePluginHost\(\{ \.\.\.spec\.options/)
  const path = join(input.root, input.session.outputDir, 'hook-host/process-result.json')
  const process = JSON.parse(readFileSync(path, 'utf8'))
  const lifecycle = JSON.parse(readFileSync(join(input.root, input.session.outputDir, 'hook-host/lifecycle-failure.json'), 'utf8'))
  assert.equal(lifecycle.phase, 'startup_failure')
  assert.equal(lifecycle.code, 'hook_host_startup_failed')
  assert.equal(lifecycle.childExited, true)
  assert.equal(process.childExited, true)
  assert.equal(process.childClosed, true)
  assert.equal(process.interrupted, true)
  assert.equal(await isProcessIdentityAlive(process.processIdentity), false)
})

test('changed capability inventory is rejected before any host is spawned', async () => {
  const input = fixture()
  writeFileSync(join(input.root, 'capabilities.json'), '{"plugins":[],"changed":true}')
  await assert.rejects(startRuntimeHookService(input), /differs from frozen plan/)
  assert.equal(existsSync(join(input.root, input.session.outputDir, 'hook-host')), false)
})

test('retired task-contract capability is rejected before any host is spawned', async () => {
  const input = fixture()
  for (const taskContract of [{ enabled: true }, { enabled: false }]) {
    await assert.rejects(startRuntimeHookService({ ...input, taskContract }), /task contract capability is retired/)
    assert.equal(existsSync(join(input.root, input.session.outputDir, 'hook-host')), false)
  }
})
