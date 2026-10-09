import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { digest, fileDigest } from '../src/phase0_run.mjs'
import { writeOfficialEntryManifest, verifyOfficialEntryManifest } from '../src/phase1_official_entry.mjs'
import { startRuntimeHookService } from '../src/phase3_hook_service.mjs'
import { freezePluginSnapshot, inspectPluginResources } from '../src/phase0_inventory.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gaia2-official-entry-'))
  const base = { runId: 'entry-run', mode: 'official_submission', tasks: ['entry-exec'] }
  const manifest = { ...base, runRoot: 'runs/entry-run', manifestHash: digest(base) }
  const task = { phase: 'standard', config: 'execution', scenarioId: 'entry-scenario', scenarioVersion: 'are_simulation_v1', scenarioHash: 'a'.repeat(64), runNumber: 1, attemptIndex: 1, correctionOrdinal: 0, executionId: 'entry-exec' }
  const session = { sessionId: 'entry-session', outputDir: 'runs/entry-run/outputs/entry-exec', workspaceDir: 'runs/entry-run/workspaces/entry-exec' }
  return { root, manifest, task, session }
}

test('official entry manifest is immutable and binds frozen identities', () => {
  const value = fixture()
  try {
    const entry = writeOfficialEntryManifest(value)
    assert.equal(entry.schemaVersion, 'gaia2-official-entry-handshake-v1')
    assert.equal(entry.value.executionId, value.task.executionId)
    assert.equal(entry.value.sessionId, value.session.sessionId)
    assert.equal(entry.value.scenarioId, value.task.scenarioId)
    assert.equal(verifyOfficialEntryManifest({ path: entry.path, sha256: entry.sha256, expected: entry.value }).executionId, 'entry-exec')
    assert.throws(() => writeOfficialEntryManifest(value), /already exists/)
    writeFileSync(entry.path, `${readFileSync(entry.path, 'utf8')}tampered`)
    assert.throws(() => verifyOfficialEntryManifest({ path: entry.path, sha256: entry.sha256, expected: entry.value }), /bytes changed/)
  } finally { rmSync(value.root, { recursive: true, force: true }) }
})

test('official entry manifest rejects identity substitution', () => {
  const value = fixture()
  try {
    const entry = writeOfficialEntryManifest(value)
    assert.throws(() => verifyOfficialEntryManifest({ path: entry.path, sha256: entry.sha256, expected: { ...entry.value, sessionId: 'foreign-session' } }), /identity differs/)
  } finally { rmSync(value.root, { recursive: true, force: true }) }
})

test('real RuntimePluginHost startup consumes the immutable official-entry receipt and closes', { timeout: 60000 }, async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const directory = mkdtempSync(join(root, 'runs', 'phase5-2d3-entry-'))
  const portable = value => value.replaceAll('\\', '/')
  const runRoot = portable(relative(root, directory))
  const plugins = ['gaia2-runtime', 'gaia2-evaluation'].map(id => inspectPluginResources(freezePluginSnapshot({ root, id, sourceRoot: join(root, 'plugins', id) })))
  const capabilityPath = join(directory, 'capabilities.json')
  writeFileSync(capabilityPath, JSON.stringify({ syntheticFixtureOnly: true, plugins }), { flag: 'wx' })
  const manifest = { runId: 'controlled-entry', runRoot, manifestHash: digest({ runRoot }), lockRefs: { capabilities: { path: portable(relative(root, capabilityPath)), sha256: fileDigest(capabilityPath) } } }
  const task = { phase: 'standard', config: 'execution', scenarioId: 'controlled-entry', scenarioVersion: 'are_simulation_v1', scenarioHash: 'b'.repeat(64), executionId: 'controlled-entry-exec', runNumber: 1, attemptIndex: 1, correctionOrdinal: 0 }
  const session = { sessionId: 'controlled-entry-session', outputDir: `${runRoot}/output`, workspaceDir: `${runRoot}/workspace` }
  mkdirSync(join(root, session.outputDir), { recursive: true }); mkdirSync(join(root, session.workspaceDir), { recursive: true })
  const entry = writeOfficialEntryManifest({ root, manifest, task, session })
  const service = await startRuntimeHookService({ root, manifest, task, session, settings: { processTimeoutMs: 45000, heartbeatIntervalMs: 1000 }, entry })
  try {
    assert.equal(service.ready.entry.schemaVersion, entry.schemaVersion)
    assert.equal(service.ready.entry.sha256, entry.sha256)
    assert.equal(service.ready.entry.relativePath, entry.relativePath)
  } finally {
    const result = await service.close()
    assert.equal(result.exitCode, 0)
    assert.equal(result.childExited, true)
    assert.equal(result.childClosed, true)
  }
})
