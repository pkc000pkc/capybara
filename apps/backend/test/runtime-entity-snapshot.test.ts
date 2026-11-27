import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { initializeProjectDirectory } from '#core/project-initializer'
import { RuntimeLoop } from '#core/runtime-loop'
import { extractRuntimeEntitySnapshots } from '#core/runtime-entity-snapshot'

test('structured tool results produce deterministic per-entity snapshots', () => {
  const snapshots = extractRuntimeEntitySnapshots({
    items: [
      { id: 'order-1024', status: 'pending', amount: 125 },
      { order_id: 1025, status: 'paid', amount: 80 },
      { status: 'unknown' },
    ],
  }, 'artifact-result-1', '2026-11-27T22:00:00.000Z', 'appworld_execute')

  assert.equal(snapshots.length, 2)
  assert.deepEqual(snapshots.map(item => item.entityId), ['order-1024', '1025'])
  assert.equal(snapshots[0]?.entityType, 'appworld_execute')
  assert.deepEqual(snapshots[1]?.fields, { order_id: 1025, status: 'paid', amount: 80 })
  assert.equal(snapshots[0]?.sourceArtifactId, 'artifact-result-1')
  assert.equal(snapshots[0]?.capturedAt, '2026-11-27T22:00:00.000Z')
  assert.match(snapshots[0]?.hash ?? '', /^[a-f0-9]{64}$/)
})

test('top-level records and nested collection records are supported without guessing text', () => {
  assert.equal(extractRuntimeEntitySnapshots({ name: 'no stable id' }, 'artifact-1', 'now', 'search_resources').length, 0)
  assert.equal(extractRuntimeEntitySnapshots('order 1024 is pending', 'artifact-2', 'now', 'search_resources').length, 0)
  assert.equal(extractRuntimeEntitySnapshots({ data: [{ uuid: 'u-1', kind: 'customer', email: 'a@example.com' }] }, 'artifact-3', 'now', 'search_resources')[0]?.entityType, 'customer')
})

test('completed observations carry snapshots and repeated upsert is idempotent', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-entity-snapshot-'))
  initializeProjectDirectory(projectDir)
  const loop = new RuntimeLoop({
    projectDir,
    llm: {
      chat: async () => ({ provider: 'custom', model: 'test', text: '', raw: {} }),
      getConfig: () => ({ provider: 'custom', protocol: 'responses', model: 'test', baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1000, maxRetries: 0 }),
    },
    contextOrganization: { minGroups: 1000 },
    streamDelayMs: 0,
    stepDelayMs: 0,
  })
  try {
    const artifact = (loop as any).createArtifact('tool-result', 'Entity result', { items: [{ id: 'item-1', status: 'ready' }] }, 'entity-test')
    const observation = {
      id: 'observation-1', runId: 'run-1', stepId: 'step-1', callId: 'call-1', toolName: 'search_resources', status: 'completed',
      arguments: {}, resultArtifactId: artifact.id, resultPreview: artifact.preview, startedAt: '2026-11-27T22:00:00.000Z', completedAt: '2026-11-27T22:00:01.000Z', durationMs: 1000,
    }
    ;(loop as any).upsertObservation(observation, 'entity-test')
    const first = loop.exportState().snapshot.observations.items[0]!
    assert.equal(first.entitySnapshots?.length, 1)
    ;(loop as any).upsertObservation(first, 'entity-test')
    const second = loop.exportState().snapshot.observations.items[0]!
    assert.equal(second.entitySnapshots?.length, 1)
  } finally {
    loop.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})
