import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProjectFileService } from '#core/project-files'
import { ProjectResources } from '#core/project-resources'
import { HookRegistry } from '#core/hooks/hook-registry'
import { ProjectResourceRegistry } from '#core/resources/resource-registry'
import { AssetWriteBlockedError, withAssetWritePolicy, type AssetWriteAudit } from '#core/asset-write-policy'
import { enqueueProjectWrite } from '#core/project-write-queue'

test('read-only asset policy blocks before mutation and stays isolated across concurrent sessions', async () => {
  const events: AssetWriteAudit[] = []
  let writes = 0
  await Promise.all([
    withAssetWritePolicy({ projectDir: '.', readonly: true, onAudit: event => events.push(event) }, async () => {
      await assert.rejects(enqueueProjectWrite('.', () => { writes += 1 }, 'variable.update'), AssetWriteBlockedError)
      await enqueueProjectWrite('../other-project', () => { writes += 1 })
    }),
    enqueueProjectWrite('.', () => { writes += 1 }),
  ])
  assert.equal(writes, 2)
  assert.deepEqual(events.map(event => [event.operation, event.status]), [['variable.update', 'blocked']])
})

test('audit distinguishes successful and failed mutations and policy expires after execution', async () => {
  const events: AssetWriteAudit[] = []
  await withAssetWritePolicy({ projectDir: '.', readonly: false, onAudit: event => events.push(event) }, async () => {
    assert.equal(await enqueueProjectWrite('.', () => 7), 7)
    await assert.rejects(enqueueProjectWrite('.', () => { throw new Error('failure') }), /failure/)
  })
  await enqueueProjectWrite('.', () => 8)
  assert.deepEqual(events.map(event => event.status), ['started', 'completed', 'started', 'failed'])
})

test('read-only project file operations protect resources while allowing task outputs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-asset-policy-'))
  try {
    fs.mkdirSync(path.join(root, 'hooks'))
    fs.mkdirSync(path.join(root, 'custom-skills'))
    fs.writeFileSync(path.join(root, 'custom-skills', 'SKILL.md'), 'original skill')
    fs.writeFileSync(path.join(root, 'main.j2'), 'original')
    fs.writeFileSync(path.join(root, 'output.txt'), 'task output')
    const files = new ProjectFileService(root)
    const events: AssetWriteAudit[] = []
    withAssetWritePolicy({ projectDir: root, readonly: true, onAudit: event => events.push(event) }, () => {
      assert.throws(() => files.write({ path: 'main.j2', content: 'changed', revision: files.read('main.j2').revision }), AssetWriteBlockedError)
      assert.throws(() => files.create({ parent: 'hooks', name: 'learn.ts', type: 'file' }), AssetWriteBlockedError)
      assert.throws(() => files.remove({ path: 'hooks', recursive: true }), AssetWriteBlockedError)
      assert.throws(() => files.rename({ path: 'output.txt', name: 'capybara.plugin.json' }), AssetWriteBlockedError)
      files.write({ path: 'output.txt', content: 'updated', revision: files.read('output.txt').revision })
    })
    assert.equal(fs.readFileSync(path.join(root, 'main.j2'), 'utf8'), 'original')
    assert.equal(fs.readFileSync(path.join(root, 'output.txt'), 'utf8'), 'updated')
    assert.equal(events.filter(event => event.status === 'blocked').length, 4)
    const allowed: AssetWriteAudit[] = []
    withAssetWritePolicy({ projectDir: root, readonly: false, onAudit: event => allowed.push(event) }, () => {
      files.write({ path: 'main.j2', content: 'new template', revision: files.read('main.j2').revision })
    })
    assert.deepEqual(allowed.map(event => event.status), ['started', 'completed'])
    assert.equal(allowed[0]?.id, allowed[1]?.id)
    withAssetWritePolicy({ projectDir: root, readonly: true, assetPaths: ['custom-skills'], onAudit: event => events.push(event) }, () => {
      assert.throws(() => files.remove({ path: 'custom-skills/SKILL.md' }), AssetWriteBlockedError)
      assert.throws(() => files.create({ parent: '', name: 'custom-template.j2', type: 'file' }), AssetWriteBlockedError)
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('direct resource writes cannot bypass the queued write policy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-resource-policy-'))
  const resources = new ProjectResources(root)
  try {
    const events: AssetWriteAudit[] = []
    withAssetWritePolicy({ projectDir: root, readonly: true, onAudit: event => events.push(event) }, () => {
      assert.throws(() => resources.saveSettings({}), AssetWriteBlockedError)
      assert.throws(() => resources.saveSystemVariables({ version: 1, variables: [] }), AssetWriteBlockedError)
      const hooks = new HookRegistry(root)
      assert.throws(() => hooks.create('blocked-hook', ''), AssetWriteBlockedError)
      assert.throws(() => hooks.save('missing', '', ''), AssetWriteBlockedError)
      assert.throws(() => hooks.remove('missing', ''), AssetWriteBlockedError)
      const registry = new ProjectResourceRegistry(root)
      assert.throws(() => registry.saveSkill('missing', {}), AssetWriteBlockedError)
      assert.throws(() => registry.saveHarness('missing', {}), AssetWriteBlockedError)
    })
    assert.equal(events.filter(event => event.status === 'blocked').length, 7)
  } finally {
    resources.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
