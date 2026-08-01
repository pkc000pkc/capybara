import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { buildApp } from '#app'
import { DatasetStore, type DatasetStorageType } from '#core/datasets/dataset-store'

function temporaryProject(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-datasets-'))
  fs.writeFileSync(path.join(projectDir, 'main.j2'), 'System prompt', 'utf8')
  return projectDir
}

test('dataset stores provide QTA CRUD for every supported storage type', (context) => {
  const projectDir = temporaryProject()
  context.after(() => fs.rmSync(projectDir, { recursive: true, force: true }))
  const store = new DatasetStore(projectDir)
  const cases: Array<{ storage: DatasetStorageType; target: string }> = [
    { storage: 'jsonl', target: path.join(projectDir, 'datasets', 'source.jsonl') },
    { storage: 'sqlite', target: path.join(projectDir, 'datasets', 'source.sqlite') },
    { storage: 'huggingface', target: path.join(projectDir, 'datasets', 'hugging-face') },
  ]

  for (const item of cases) {
    const dataset = store.create({
      name: `${item.storage} dataset`,
      storage: item.storage,
      path: item.target,
      tags: ['qta'],
      scoringPrompt: 'Compare {{ actual }} with {{ answer }}.',
    })
    assert.equal(dataset.storage, item.storage)
    assert.equal(dataset.samples, 0)
    assert.equal(dataset.scoringPrompt, 'Compare {{ actual }} with {{ answer }}.')
    assert.equal(dataset.version, 1)

    const record = store.createRecord(dataset.id, {
      question: 'What changed?',
      thinking: 'Inspect the observable trace.',
      answer: 'The dataset is persisted.',
      expectedTools: ['read_file', ' read_file ', 'search_files'],
      metadata: { tags: ['smoke'] },
    })
    assert.ok(record.id)
    assert.equal(store.get(dataset.id).samples, 1)
    assert.equal(store.get(dataset.id).version, 2)
    assert.equal(store.listRecords(dataset.id, { query: 'observable' }).total, 1)
    assert.deepEqual(record.expectedTools, ['read_file', 'search_files'])
    assert.equal(store.listRecords(dataset.id, { query: 'search_files' }).total, 1)

    const updated = store.updateRecord(dataset.id, record.id, {
      question: 'What changed?',
      thinking: 'Inspect and compare the observable trace.',
      answer: 'The record was updated.',
      expectedTools: ['read_file'],
      metadata: { tags: ['edited'] },
    })
    assert.equal(updated.answer, 'The record was updated.')
    assert.deepEqual(updated.metadata.tags, ['edited'])
    assert.deepEqual(updated.expectedTools, ['read_file'])
    assert.equal(store.get(dataset.id).version, 3)

    store.deleteRecord(dataset.id, record.id)
    assert.equal(store.get(dataset.id).samples, 0)
    assert.equal(store.get(dataset.id).version, 4)
    const removed = store.delete(dataset.id)
    assert.equal(removed.filesPreserved, true)
    assert.equal(fs.existsSync(item.target), true)
  }
})

test('dataset import registers a local path and normalizes missing record ids', (context) => {
  const projectDir = temporaryProject()
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-dataset-source-'))
  context.after(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
    fs.rmSync(externalDir, { recursive: true, force: true })
  })
  const source = path.join(externalDir, 'reasoning.jsonl')
  fs.writeFileSync(source, `${JSON.stringify({
    question: 'Imported question',
    thinking: 'Imported reasoning summary',
    answer: 'Imported answer',
  })}\n`, 'utf8')

  const store = new DatasetStore(projectDir)
  const dataset = store.import({ path: source })
  const records = store.listRecords(dataset.id)
  assert.equal(dataset.path, source)
  assert.equal(dataset.scoringPrompt, '')
  assert.equal(records.total, 1)
  assert.deepEqual(records.items[0]?.expectedTools, [])
  assert.match(records.items[0]?.id ?? '', /^sample-1-/)
  assert.equal(JSON.parse(fs.readFileSync(source, 'utf8').trim()).id, undefined)
  const imported = records.items[0]
  assert.ok(imported)
  store.updateRecord(dataset.id, imported.id, {
    ...imported,
    answer: 'Edited after import',
  })
  assert.equal(JSON.parse(fs.readFileSync(source, 'utf8').trim()).id, imported.id)
})

test('legacy registries and SQLite datasets gain empty evaluation defaults', (context) => {
  const projectDir = temporaryProject()
  context.after(() => fs.rmSync(projectDir, { recursive: true, force: true }))
  const datasetPath = path.join(projectDir, 'datasets', 'legacy.sqlite')
  fs.mkdirSync(path.dirname(datasetPath), { recursive: true })
  const database = new DatabaseSync(datasetPath)
  database.exec(`
    CREATE TABLE qta_samples (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      thinking TEXT NOT NULL,
      answer TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO qta_samples VALUES (
      'legacy-record', 'Legacy question', '', 'Legacy answer',
      '{"tags":[]}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
  `)
  database.close()

  const store = new DatasetStore(projectDir)
  const dataset = store.import({ path: datasetPath })
  assert.equal(dataset.scoringPrompt, '')
  assert.deepEqual(store.listRecords(dataset.id).items[0]?.expectedTools, [])
  const updated = store.updateRecord(dataset.id, 'legacy-record', {
    question: 'Legacy question',
    thinking: '',
    answer: 'Legacy answer',
    expectedTools: ['read_file'],
    metadata: { tags: [] },
  })
  assert.deepEqual(updated.expectedTools, ['read_file'])

  const registry = JSON.parse(fs.readFileSync(store.registryFile, 'utf8')) as { items: Array<Record<string, unknown>> }
  delete registry.items[0]?.scoringPrompt
  fs.writeFileSync(store.registryFile, `${JSON.stringify({ version: 1, items: registry.items }, null, 2)}\n`, 'utf8')
  assert.equal(store.get(dataset.id).scoringPrompt, '')
})

test('dataset HTTP endpoints expose list, import, dataset and record CRUD', async (context) => {
  const projectDir = temporaryProject()
  context.after(() => fs.rmSync(projectDir, { recursive: true, force: true }))
  const app = await buildApp({ runtimeLoop: { projectDir } })
  context.after(() => app.close())
  const projectQuery = `projectPath=${encodeURIComponent(projectDir)}`
  const datasetPath = path.join(projectDir, 'datasets', 'http.jsonl')

  const createdResponse = await app.inject({
    method: 'POST',
    url: `/api/datasets?${projectQuery}`,
    payload: {
      name: 'HTTP dataset',
      storage: 'jsonl',
      path: datasetPath,
      tags: ['http'],
      scoringPrompt: 'Score the actual answer against the expected answer.',
    },
  })
  assert.equal(createdResponse.statusCode, 201)
  const dataset = createdResponse.json() as { id: string; scoringPrompt: string }
  assert.equal(dataset.scoringPrompt, 'Score the actual answer against the expected answer.')

  const recordResponse = await app.inject({
    method: 'POST',
    url: `/api/datasets/${dataset.id}/records?${projectQuery}`,
    payload: { question: 'Q', thinking: 'T', answer: 'A', expectedTools: ['read_file'], metadata: { tags: [] } },
  })
  assert.equal(recordResponse.statusCode, 201)
  const record = recordResponse.json() as { id: string; expectedTools: string[] }
  assert.deepEqual(record.expectedTools, ['read_file'])

  const pageResponse = await app.inject({
    method: 'GET',
    url: `/api/datasets/${dataset.id}/records?${projectQuery}`,
  })
  assert.equal(pageResponse.statusCode, 200)
  assert.equal(pageResponse.json().total, 1)

  const updateResponse = await app.inject({
    method: 'PUT',
    url: `/api/datasets/${dataset.id}/records/${record.id}?${projectQuery}`,
    payload: { question: 'Q2', thinking: 'T2', answer: 'A2', expectedTools: ['search_files'], metadata: { tags: ['updated'] } },
  })
  assert.equal(updateResponse.statusCode, 200)
  assert.equal(updateResponse.json().answer, 'A2')
  assert.deepEqual(updateResponse.json().expectedTools, ['search_files'])

  const datasetUpdateResponse = await app.inject({
    method: 'PUT',
    url: `/api/datasets/${dataset.id}?${projectQuery}`,
    payload: { scoringPrompt: 'Updated scorer prompt.' },
  })
  assert.equal(datasetUpdateResponse.statusCode, 200)
  assert.equal(datasetUpdateResponse.json().scoringPrompt, 'Updated scorer prompt.')

  const listResponse = await app.inject({ method: 'GET', url: `/api/datasets?${projectQuery}` })
  assert.equal(listResponse.statusCode, 200)
  assert.equal(listResponse.json().items[0].samples, 1)

  assert.equal((await app.inject({
    method: 'DELETE',
    url: `/api/datasets/${dataset.id}/records/${record.id}?${projectQuery}`,
  })).statusCode, 200)
  assert.equal((await app.inject({
    method: 'DELETE',
    url: `/api/datasets/${dataset.id}?${projectQuery}`,
  })).statusCode, 200)
})
