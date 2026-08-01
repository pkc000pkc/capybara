import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  applyCompressionPatch,
  conversationUnits,
  createCompressionPlan,
  parseCompressionPatch,
  shrinkCompressionPlan,
} from '#core/compression/compression-engine'
import { CompressionResourceStore } from '#core/compression/compression-resource'
import type { CompressionPatch } from '#core/compression/types'
import type { LlmMessage } from '#util/llm'

function resourceProject(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-compression-'))
  const resourceDir = path.join(projectDir, 'context', 'compression')
  fs.mkdirSync(resourceDir, { recursive: true })
  fs.writeFileSync(path.join(resourceDir, 'manifest.json'), JSON.stringify({
    version: 1,
    id: 'test-compression',
    name: 'Test compression',
    description: 'Compression test resource',
    entry: 'prompt.j2',
    policy: {
      trigger_ratio: 0.7,
      target_ratio: 0.4,
      preserve_recent_turns: 1,
      max_source_tokens: 4096,
      max_output_tokens: 512,
      retry_limit: 1,
      apply_mode: 'debug',
    },
  }, null, 2))
  fs.writeFileSync(path.join(resourceDir, 'prompt.j2'), '{{ compression.output_schema | dump }}')
  return projectDir
}

const messages: LlmMessage[] = [
  { role: 'system', content: 'System prompt' },
  { role: 'user', content: 'First request with old details.' },
  { role: 'assistant', content: 'First completed answer.' },
  { role: 'user', content: 'Second recent request.' },
  { role: 'assistant', content: 'Second recent answer.' },
]

test('compression resource saves with optimistic revisions', () => {
  const projectDir = resourceProject()
  try {
    const store = new CompressionResourceStore(projectDir, 'context/compression/manifest.json')
    const current = store.read()
    assert.deepEqual(current.variables.slice(0, 2), [
      'compression.base_revision',
      'compression.source_hash',
    ])
    const saved = store.save({
      baseRevision: current.revision,
      manifest: { ...current.manifest, name: 'Updated compression' },
      prompt: `${current.prompt}\n{{ compression.source_units | dump }}`,
    })
    assert.equal(saved.manifest.name, 'Updated compression')
    assert.notEqual(saved.revision, current.revision)
    assert.throws(() => store.save({
      baseRevision: current.revision,
      manifest: current.manifest,
      prompt: current.prompt,
    }), /revision conflict/)
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('valid compression patches apply atomically and preserve recent turns', () => {
  const projectDir = resourceProject()
  try {
    const resource = new CompressionResourceStore(
      projectDir,
      'context/compression/manifest.json',
    ).read()
    const plan = createCompressionPlan(messages, resource, 7, 100, [], true)
    assert.ok(plan)
    assert.equal(plan.units.length, 1)
    const sourceUnit = plan.units[0]
    if (!sourceUnit) throw new Error('compression plan did not select a source unit')
    const patch = parseCompressionPatch(JSON.stringify({
      version: 1,
      base_revision: 7,
      source_hash: plan.sourceHash,
      patch_status: 'complete',
      operations: [{
        op: 'replace_with_summary',
        source_unit_ids: [sourceUnit.id],
        summary: {
          facts: ['Old fact'],
          decisions: [],
          user_requirements: [],
          completed_work: ['First answer completed'],
          open_items: [],
          important_evidence: [],
        },
      }],
    }), plan)
    assert.deepEqual(
      applyCompressionPatch(messages, plan, patch).map((message) => message.content),
      ['System prompt', 'Second recent request.', 'Second recent answer.'],
    )
    assert.throws(
      () => parseCompressionPatch('{"version":1', plan),
      /incomplete or invalid JSON/,
    )
    assert.deepEqual(messages.map((message) => message.content), [
      'System prompt',
      'First request with old details.',
      'First completed answer.',
      'Second recent request.',
      'Second recent answer.',
    ])
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('tool call chains are excluded and retry plans shrink without changing source messages', () => {
  const toolChain: LlmMessage[] = [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'Read a file' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'README.md' } }],
    },
    { role: 'tool', content: 'File contents', toolCallId: 'call-1', name: 'read_file' },
    { role: 'assistant', content: 'Summary' },
  ]
  assert.deepEqual(conversationUnits(toolChain), [])

  const unit = conversationUnits(messages.slice(0, 3))[0]
  if (!unit) throw new Error('completed conversation did not produce a unit')
  const plan = {
    baseRevision: 1,
    sourceHash: 'original',
    units: [unit, { ...unit, id: `${unit.id}-2` }, { ...unit, id: `${unit.id}-3` }],
    beforeTokens: 100,
    targetTokens: 40,
  }
  const smaller = shrinkCompressionPlan(plan)
  assert.equal(smaller?.units.length, 2)
  assert.notEqual(smaller?.sourceHash, plan.sourceHash)

  const invalidPatch: CompressionPatch = {
    version: 1,
    base_revision: 1,
    source_hash: 'wrong',
    patch_status: 'complete',
    operations: [],
  }
  assert.throws(
    () => parseCompressionPatch(JSON.stringify(invalidPatch), plan),
    /source revision/,
  )
  assert.throws(
    () => parseCompressionPatch(JSON.stringify({
      ...invalidPatch,
      source_hash: plan.sourceHash,
      operations: [{
        op: 'replace_with_summary',
        source_unit_ids: [plan.units[0]?.id],
        summary: {
          facts: [],
          decisions: [],
          user_requirements: [],
          completed_work: [],
          open_items: [],
          important_evidence: [],
        },
      }],
    }), plan),
    /cover every planned source unit/,
  )
})
