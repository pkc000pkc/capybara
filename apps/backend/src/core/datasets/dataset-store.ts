import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type DatasetStorageType = 'jsonl' | 'sqlite' | 'huggingface'

export type DatasetFieldMapping = {
  id: string
  question: string
  thinking: string
  answer: string
  expectedTools: string
  metadata: string
}

export interface DatasetImportField {
  path: string
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null'
  examples: string[]
}

export interface DatasetImportSample {
  index: number
  values: Record<string, string>
}

export interface DatasetImportPreview {
  path: string
  sourceFile: string
  storage: DatasetStorageType
  sampleCount: number
  fields: DatasetImportField[]
  samples: DatasetImportSample[]
  suggestedMapping: DatasetFieldMapping
}

export interface DatasetRecordMetadata {
  tags: string[]
  createdAt: string
  updatedAt: string
  [key: string]: unknown
}

export interface DatasetRecord {
  id: string
  question: string
  thinking: string
  answer: string
  expectedTools: string[]
  metadata: DatasetRecordMetadata
}

export interface DatasetSummary {
  id: string
  name: string
  storage: DatasetStorageType
  path: string
  samples: number
  version: number
  tags: string[]
  scoringPrompt: string
  mapping?: DatasetFieldMapping
  createdAt: string
  updatedAt: string
}

export interface DatasetPage {
  items: DatasetRecord[]
  total: number
  offset: number
  limit: number
}

type DatasetReference = Omit<DatasetSummary, 'samples'>
type DatasetRegistryFile = { version: 1; items: DatasetReference[] }

type DatasetRecordInput = {
  id?: unknown
  question?: unknown
  thinking?: unknown
  answer?: unknown
  expectedTools?: unknown
  metadata?: unknown
}

type DatasetBackend = {
  count(): number
  list(): DatasetRecord[]
  create(record: DatasetRecord): void
  update(record: DatasetRecord): void
  delete(id: string): void
  close(): void
}

const EMPTY_REGISTRY: DatasetRegistryFile = { version: 1, items: [] }

const CANONICAL_MAPPING: DatasetFieldMapping = {
  id: '/id',
  question: '/question',
  thinking: '/thinking',
  answer: '/answer',
  expectedTools: '/expectedTools',
  metadata: '/metadata',
}

const FIELD_ALIASES: Record<keyof DatasetFieldMapping, string[]> = {
  id: ['id', '_id', 'uuid', 'sample_id', 'sampleid', 'task_id', 'taskid', 'record_id', 'recordid'],
  question: ['question', 'prompt', 'instruction', 'input', 'query', 'problem', 'user'],
  thinking: ['thinking', 'reasoning', 'rationale', 'analysis', 'chain_of_thought', 'chainofthought', 'cot', 'solution'],
  answer: ['answer', 'output', 'response', 'completion', 'target', 'label', 'chosen', 'final_answer', 'finalanswer'],
  expectedTools: ['expectedtools', 'expected_tools', 'tools', 'tool_calls', 'toolcalls', 'expected_tool_calls'],
  metadata: ['metadata', 'meta'],
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function jsonPointerSegments(pointer: string): string[] {
  if (!pointer.startsWith('/')) throw new Error(`field mapping must be a JSON Pointer: ${pointer}`)
  return pointer.slice(1).split('/').map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
}

function jsonPointer(source: unknown, pointer: string): unknown {
  let current = source
  for (const segment of jsonPointerSegments(pointer)) {
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined
      current = current[index]
    } else if (isObject(current)) {
      current = current[segment]
    } else {
      return undefined
    }
  }
  return current
}

function setJsonPointer(target: Record<string, unknown>, pointer: string, value: unknown): void {
  const segments = jsonPointerSegments(pointer)
  let current: Record<string, unknown> | unknown[] = target
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1
    if (last) {
      if (Array.isArray(current)) current[Number(segment)] = value
      else current[segment] = value
      return
    }
    const nextIsIndex = /^\d+$/.test(segments[index + 1] ?? '')
    const existing = Array.isArray(current) ? current[Number(segment)] : current[segment]
    if ((nextIsIndex && Array.isArray(existing)) || (!nextIsIndex && isObject(existing))) {
      current = existing as Record<string, unknown> | unknown[]
      return
    }
    const created: Record<string, unknown> | unknown[] = nextIsIndex ? [] : {}
    if (Array.isArray(current)) current[Number(segment)] = created
    else current[segment] = created
    current = created
  })
}

function valueType(value: unknown): DatasetImportField['type'] {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (isObject(value)) return 'object'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  return 'string'
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value, null, 2)
}

function fieldPointer(parent: string, key: string): string {
  const escaped = key.replaceAll('~', '~0').replaceAll('/', '~1')
  return `${parent}/${escaped}`
}

function collectImportFields(samples: Array<Record<string, unknown>>): DatasetImportField[] {
  const fields = new Map<string, { type: DatasetImportField['type']; examples: string[] }>()
  const visit = (value: unknown, pointer: string, depth: number) => {
    if (pointer) {
      const current = fields.get(pointer) ?? { type: valueType(value), examples: [] }
      const example = displayValue(value).trim()
      if (example && !current.examples.includes(example) && current.examples.length < 3) current.examples.push(example)
      fields.set(pointer, current)
    }
    if (depth >= 4) return
    if (Array.isArray(value)) {
      value.slice(0, 5).forEach((item, index) => visit(item, `${pointer}/${index}`, depth + 1))
    } else if (isObject(value)) {
      Object.entries(value).slice(0, 100).forEach(([key, item]) => visit(item, fieldPointer(pointer, key), depth + 1))
    }
  }
  samples.forEach((sample) => visit(sample, '', 0))
  return [...fields.entries()]
    .map(([path, value]) => ({ path, type: value.type, examples: value.examples }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

function normalizedFieldName(pointer: string): string {
  const segment = jsonPointerSegments(pointer).at(-1) ?? ''
  return segment.toLowerCase().replaceAll(/[^a-z0-9]/g, '')
}

function suggestedMapping(fields: DatasetImportField[]): DatasetFieldMapping {
  const find = (field: keyof DatasetFieldMapping): string | undefined => {
    const aliases = new Set(FIELD_ALIASES[field].map((value) => value.replaceAll(/[^a-z0-9]/g, '')))
    return fields.find((item) => aliases.has(normalizedFieldName(item.path)))?.path
  }
  const firstText = fields.find((item) => ['string', 'number', 'boolean'].includes(item.type))?.path
  return {
    id: find('id') ?? CANONICAL_MAPPING.id,
    question: find('question') ?? firstText ?? CANONICAL_MAPPING.question,
    thinking: find('thinking') ?? CANONICAL_MAPPING.thinking,
    answer: find('answer') ?? CANONICAL_MAPPING.answer,
    expectedTools: find('expectedTools') ?? CANONICAL_MAPPING.expectedTools,
    metadata: find('metadata') ?? CANONICAL_MAPPING.metadata,
  }
}

function normalizeFieldMapping(value: unknown, fallback: DatasetFieldMapping = CANONICAL_MAPPING): DatasetFieldMapping {
  if (value === undefined) return { ...fallback }
  if (!isObject(value)) throw new Error('mapping must be an object')
  return Object.fromEntries((Object.keys(CANONICAL_MAPPING) as Array<keyof DatasetFieldMapping>).map((field) => {
    const pointer = value[field] ?? fallback[field]
    if (typeof pointer !== 'string' || !pointer.startsWith('/')) {
      throw new Error(`mapping.${field} must be a JSON Pointer`)
    }
    jsonPointerSegments(pointer)
    return [field, pointer]
  })) as DatasetFieldMapping
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  return value
}

function normalizeTags(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('tags must be an array of strings')
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))]
}

function normalizeExpectedTools(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('expectedTools must be an array of strings')
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))]
}

function normalizeRecord(input: DatasetRecordInput, fallbackId?: string): DatasetRecord {
  const now = new Date().toISOString()
  const sourceMetadata = isObject(input.metadata) ? input.metadata : {}
  const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : fallbackId ?? randomUUID()
  const thinking = typeof input.thinking === 'string'
    ? input.thinking
    : input.thinking === undefined
      ? ''
      : JSON.stringify(input.thinking, null, 2)
  return {
    id,
    question: requiredString(input.question ?? '', 'question'),
    thinking,
    answer: requiredString(input.answer ?? '', 'answer'),
    expectedTools: normalizeExpectedTools(input.expectedTools),
    metadata: {
      ...sourceMetadata,
      tags: normalizeTags(sourceMetadata.tags),
      createdAt: typeof sourceMetadata.createdAt === 'string' ? sourceMetadata.createdAt : now,
      updatedAt: typeof sourceMetadata.updatedAt === 'string' ? sourceMetadata.updatedAt : now,
    },
  }
}

function stableImportedId(index: number, line: string): string {
  return `sample-${index + 1}-${createHash('sha256').update(line).digest('hex').slice(0, 8)}`
}

type JsonLineSource = { line: string; value: Record<string, unknown> }

function readJsonLineSources(file: string): JsonLineSource[] {
  if (!fs.existsSync(file)) return []
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const sources: JsonLineSource[] = []
  lines.forEach((line, index) => {
    if (!line.trim()) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      throw new Error(`invalid JSONL at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!isObject(parsed)) throw new Error(`dataset line ${index + 1} must be a JSON object`)
    sources.push({ line, value: parsed })
  })
  return sources
}

function mappedExpectedTools(value: unknown): string[] {
  if (Array.isArray(value)) return normalizeExpectedTools(value)
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed)) return normalizeExpectedTools(parsed)
  } catch {
    // Plain strings are treated as comma- or newline-separated tool names.
  }
  return normalizeExpectedTools(value.split(/[,\n]/))
}

function mappedMetadata(value: unknown): Record<string, unknown> {
  if (isObject(value)) return value
  return value === undefined || value === null || value === '' ? {} : { source: value }
}

function mappedRecord(
  source: Record<string, unknown>,
  mapping: DatasetFieldMapping,
  index: number,
  line: string,
): DatasetRecord {
  return normalizeRecord({
    id: displayValue(jsonPointer(source, mapping.id)),
    question: displayValue(jsonPointer(source, mapping.question)),
    thinking: displayValue(jsonPointer(source, mapping.thinking)),
    answer: displayValue(jsonPointer(source, mapping.answer)),
    expectedTools: mappedExpectedTools(jsonPointer(source, mapping.expectedTools)),
    metadata: mappedMetadata(jsonPointer(source, mapping.metadata)),
  }, stableImportedId(index, line))
}

function writeMappedRecord(source: Record<string, unknown>, record: DatasetRecord, mapping: DatasetFieldMapping): void {
  setJsonPointer(source, mapping.id, record.id)
  setJsonPointer(source, mapping.question, record.question)
  setJsonPointer(source, mapping.thinking, record.thinking)
  setJsonPointer(source, mapping.answer, record.answer)
  setJsonPointer(source, mapping.expectedTools, record.expectedTools)
  setJsonPointer(source, mapping.metadata, record.metadata)
}

function readJsonLines(file: string, mapping?: DatasetFieldMapping): DatasetRecord[] {
  const records: DatasetRecord[] = []
  const ids = new Set<string>()
  readJsonLineSources(file).forEach((source, index) => {
    const record = mapping
      ? mappedRecord(source.value, mapping, index, source.line)
      : normalizeRecord(source.value, stableImportedId(index, source.line))
    if (ids.has(record.id)) throw new Error(`duplicate dataset record id: ${record.id}`)
    ids.add(record.id)
    records.push(record)
  })
  return records
}

function writeJsonLines(file: string, records: DatasetRecord[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const content = records.length > 0
    ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
    : ''
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, content, 'utf8')
  fs.renameSync(temporary, file)
}

function writeJsonLineSources(file: string, sources: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const content = sources.length > 0 ? `${sources.map((source) => JSON.stringify(source)).join('\n')}\n` : ''
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, content, 'utf8')
  fs.renameSync(temporary, file)
}

class JsonlDatasetBackend implements DatasetBackend {
  constructor(readonly file: string, readonly mapping?: DatasetFieldMapping) {}

  count(): number {
    return readJsonLines(this.file, this.mapping).length
  }

  list(): DatasetRecord[] {
    return readJsonLines(this.file, this.mapping)
  }

  create(record: DatasetRecord): void {
    if (this.mapping) {
      const sources = readJsonLineSources(this.file)
      if (this.list().some((item) => item.id === record.id)) throw new Error(`dataset record already exists: ${record.id}`)
      const source: Record<string, unknown> = {}
      writeMappedRecord(source, record, this.mapping)
      writeJsonLineSources(this.file, [...sources.map((item) => item.value), source])
      return
    }
    const records = this.list()
    if (records.some((item) => item.id === record.id)) throw new Error(`dataset record already exists: ${record.id}`)
    records.push(record)
    writeJsonLines(this.file, records)
  }

  update(record: DatasetRecord): void {
    if (this.mapping) {
      const sources = readJsonLineSources(this.file)
      const index = sources.findIndex((source, ordinal) =>
        mappedRecord(source.value, this.mapping as DatasetFieldMapping, ordinal, source.line).id === record.id)
      if (index < 0) throw new Error(`dataset record was not found: ${record.id}`)
      const source = sources[index]
      if (!source) throw new Error(`dataset record was not found: ${record.id}`)
      writeMappedRecord(source.value, record, this.mapping)
      writeJsonLineSources(this.file, sources.map((item) => item.value))
      return
    }
    const records = this.list()
    const index = records.findIndex((item) => item.id === record.id)
    if (index < 0) throw new Error(`dataset record was not found: ${record.id}`)
    records[index] = record
    writeJsonLines(this.file, records)
  }

  delete(id: string): void {
    if (this.mapping) {
      const sources = readJsonLineSources(this.file)
      const next = sources.filter((source, ordinal) =>
        mappedRecord(source.value, this.mapping as DatasetFieldMapping, ordinal, source.line).id !== id)
      if (next.length === sources.length) throw new Error(`dataset record was not found: ${id}`)
      writeJsonLineSources(this.file, next.map((item) => item.value))
      return
    }
    const records = this.list()
    const next = records.filter((item) => item.id !== id)
    if (next.length === records.length) throw new Error(`dataset record was not found: ${id}`)
    writeJsonLines(this.file, next)
  }

  close(): void {}
}

class SqliteDatasetBackend implements DatasetBackend {
  private readonly database: DatabaseSync

  constructor(readonly file: string, create = false) {
    if (!create && !fs.existsSync(file)) throw new Error(`dataset file was not found: ${file}`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.database = new DatabaseSync(file)
    if (create) this.initialize()
    else this.validate()
    this.migrate()
  }

  private initialize(): void {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS qta_samples (
        id TEXT PRIMARY KEY,
        question TEXT NOT NULL,
        thinking TEXT NOT NULL,
        answer TEXT NOT NULL,
        expected_tools_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS qta_samples_updated_at ON qta_samples(updated_at DESC);
    `)
  }

  private validate(): void {
    const table = this.database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'qta_samples'
    `).get() as { name?: string } | undefined
    if (!table?.name) {
      this.database.close()
      throw new Error('SQLite file is not a Capybara QTA dataset')
    }
  }

  private migrate(): void {
    const columns = this.database.prepare('PRAGMA table_info(qta_samples)').all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'expected_tools_json')) {
      this.database.exec("ALTER TABLE qta_samples ADD COLUMN expected_tools_json TEXT NOT NULL DEFAULT '[]'")
    }
  }

  count(): number {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM qta_samples').get() as { count: number }
    return Number(row.count)
  }

  list(): DatasetRecord[] {
    const rows = this.database.prepare(`
      SELECT id, question, thinking, answer, expected_tools_json, metadata_json, created_at, updated_at
      FROM qta_samples ORDER BY updated_at DESC, id ASC
    `).all() as Array<{
      id: string
      question: string
      thinking: string
      answer: string
      expected_tools_json: string
      metadata_json: string
      created_at: string
      updated_at: string
    }>
    return rows.map((row) => {
      const metadata = isObject(JSON.parse(row.metadata_json))
        ? JSON.parse(row.metadata_json) as Record<string, unknown>
        : {}
      return normalizeRecord({
        id: row.id,
        question: row.question,
        thinking: row.thinking,
        answer: row.answer,
        expectedTools: JSON.parse(row.expected_tools_json) as unknown,
        metadata: { ...metadata, createdAt: row.created_at, updatedAt: row.updated_at },
      })
    })
  }

  create(record: DatasetRecord): void {
    try {
      this.database.prepare(`
        INSERT INTO qta_samples (id, question, thinking, answer, expected_tools_json, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.question,
        record.thinking,
        record.answer,
        JSON.stringify(record.expectedTools),
        JSON.stringify(record.metadata),
        record.metadata.createdAt,
        record.metadata.updatedAt,
      )
    } catch (error) {
      if (String(error).includes('UNIQUE constraint')) throw new Error(`dataset record already exists: ${record.id}`)
      throw error
    }
  }

  update(record: DatasetRecord): void {
    const result = this.database.prepare(`
      UPDATE qta_samples
      SET question = ?, thinking = ?, answer = ?, expected_tools_json = ?, metadata_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      record.question,
      record.thinking,
      record.answer,
      JSON.stringify(record.expectedTools),
      JSON.stringify(record.metadata),
      record.metadata.updatedAt,
      record.id,
    )
    if (Number(result.changes) === 0) throw new Error(`dataset record was not found: ${record.id}`)
  }

  delete(id: string): void {
    const result = this.database.prepare('DELETE FROM qta_samples WHERE id = ?').run(id)
    if (Number(result.changes) === 0) throw new Error(`dataset record was not found: ${id}`)
  }

  close(): void {
    this.database.close()
  }
}

function huggingFaceDataFile(directory: string): string {
  const preferred = path.join(directory, 'data', 'train.jsonl')
  if (fs.existsSync(preferred)) return preferred
  const candidates: string[] = []
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) candidates.push(target)
    }
  }
  if (fs.existsSync(directory)) visit(directory)
  const selected = candidates.sort()[0]
  if (!selected) throw new Error('Hugging Face dataset directory requires a JSONL data file')
  return selected
}

function backendFor(reference: DatasetReference, projectDir: string): DatasetBackend {
  const target = resolveReferencePath(projectDir, reference.path)
  if (reference.storage === 'sqlite') return new SqliteDatasetBackend(target)
  const mapping = reference.mapping ?? inferredMapping(target, reference.storage)
  return new JsonlDatasetBackend(
    reference.storage === 'huggingface' ? huggingFaceDataFile(target) : target,
    mapping,
  )
}

function resolveReferencePath(projectDir: string, value: string): string {
  return path.resolve(path.isAbsolute(value) ? value : path.join(projectDir, value))
}

function portableReferencePath(projectDir: string, value: string): string {
  const absolute = path.resolve(value)
  const relative = path.relative(projectDir, absolute)
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.replaceAll('\\', '/')
  }
  return absolute
}

function storageFromPath(target: string): DatasetStorageType {
  if (!fs.existsSync(target)) throw new Error(`dataset path was not found: ${target}`)
  if (fs.statSync(target).isDirectory()) {
    huggingFaceDataFile(target)
    return 'huggingface'
  }
  const extension = path.extname(target).toLowerCase()
  if (extension === '.jsonl') return 'jsonl'
  if (['.sqlite', '.sqlite3', '.db'].includes(extension)) return 'sqlite'
  throw new Error('dataset path must be a JSONL file, SQLite database, or Hugging Face dataset directory')
}

function defaultName(target: string): string {
  return path.basename(target, path.extname(target)).trim() || 'dataset'
}

function importSource(
  target: string,
  storage: DatasetStorageType,
): { sourceFile: string; samples: Array<Record<string, unknown>>; sampleCount: number } {
  if (storage === 'sqlite') {
    const backend = new SqliteDatasetBackend(target)
    try {
      const records = backend.list()
      return {
        sourceFile: target,
        samples: records.slice(0, 3).map((record) => ({ ...record })),
        sampleCount: records.length,
      }
    } finally {
      backend.close()
    }
  }
  const sourceFile = storage === 'huggingface' ? huggingFaceDataFile(target) : target
  const sources = readJsonLineSources(sourceFile)
  return {
    sourceFile,
    samples: sources.slice(0, 3).map((source) => source.value),
    sampleCount: sources.length,
  }
}

function importPreview(target: string, storage: DatasetStorageType): DatasetImportPreview {
  const source = importSource(target, storage)
  const fields = collectImportFields(source.samples)
  const samples = source.samples.map((sample, index) => ({
    index,
    values: Object.fromEntries(fields.map((field) => [field.path, displayValue(jsonPointer(sample, field.path))])),
  }))
  return {
    path: target,
    sourceFile: source.sourceFile,
    storage,
    sampleCount: source.sampleCount,
    fields,
    samples,
    suggestedMapping: storage === 'sqlite' ? { ...CANONICAL_MAPPING } : suggestedMapping(fields),
  }
}

function inferredMapping(target: string, storage: DatasetStorageType): DatasetFieldMapping {
  if (storage === 'sqlite') return { ...CANONICAL_MAPPING }
  const sourceFile = storage === 'huggingface' ? huggingFaceDataFile(target) : target
  const sources = readJsonLineSources(sourceFile).slice(0, 3)
  if (sources.length === 0) return { ...CANONICAL_MAPPING }
  return suggestedMapping(collectImportFields(sources.map((source) => source.value)))
}

export class DatasetStore {
  readonly registryFile: string

  constructor(readonly projectDir: string) {
    this.projectDir = path.resolve(projectDir)
    this.registryFile = path.join(this.projectDir, '.capybara', 'datasets.json')
  }

  list(): DatasetSummary[] {
    return this.readRegistry().items.map((reference) => {
      const backend = backendFor(reference, this.projectDir)
      try {
        return {
          ...reference,
          ...(reference.mapping ? {} : { mapping: inferredMapping(resolveReferencePath(this.projectDir, reference.path), reference.storage) }),
          path: resolveReferencePath(this.projectDir, reference.path),
          samples: backend.count(),
        }
      } finally {
        backend.close()
      }
    }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  get(id: string): DatasetSummary {
    const reference = this.reference(id)
    const backend = backendFor(reference, this.projectDir)
    try {
      return {
        ...reference,
        ...(reference.mapping ? {} : { mapping: inferredMapping(resolveReferencePath(this.projectDir, reference.path), reference.storage) }),
        path: resolveReferencePath(this.projectDir, reference.path),
        samples: backend.count(),
      }
    } finally {
      backend.close()
    }
  }

  create(input: { name?: unknown; storage?: unknown; path?: unknown; tags?: unknown; scoringPrompt?: unknown }): DatasetSummary {
    const name = requiredString(input.name, 'dataset name').trim()
    if (!name) throw new Error('dataset name is required')
    if (!['jsonl', 'sqlite', 'huggingface'].includes(String(input.storage))) {
      throw new Error('storage must be jsonl, sqlite, or huggingface')
    }
    const storage = input.storage as DatasetStorageType
    const inputPath = requiredString(input.path, 'dataset path')
    const target = resolveReferencePath(this.projectDir, inputPath)
    const registry = this.readRegistry()
    this.ensurePathAvailable(registry, target)
    if (storage === 'huggingface') {
      if (fs.existsSync(target) && fs.readdirSync(target).length > 0) throw new Error(`dataset path is not empty: ${target}`)
      fs.mkdirSync(path.join(target, 'data'), { recursive: true })
      writeJsonLines(path.join(target, 'data', 'train.jsonl'), [])
      fs.writeFileSync(path.join(target, 'README.md'), `---\nconfigs:\n- config_name: default\n  data_files:\n  - split: train\n    path: data/train.jsonl\n---\n\n# ${name}\n\nQTA dataset managed by Capybara.\n`, 'utf8')
    } else {
      if (fs.existsSync(target)) throw new Error(`dataset path already exists: ${target}`)
      if (storage === 'jsonl') writeJsonLines(target, [])
      else new SqliteDatasetBackend(target, true).close()
    }
    const now = new Date().toISOString()
    const reference: DatasetReference = {
      id: randomUUID(),
      name,
      storage,
      path: portableReferencePath(this.projectDir, target),
      version: 1,
      tags: normalizeTags(input.tags),
      scoringPrompt: requiredString(input.scoringPrompt ?? '', 'scoringPrompt'),
      createdAt: now,
      updatedAt: now,
    }
    registry.items.push(reference)
    this.writeRegistry(registry)
    return { ...reference, path: target, samples: 0 }
  }

  previewImport(input: { path?: unknown }): DatasetImportPreview {
    const inputPath = requiredString(input.path, 'dataset path')
    const target = resolveReferencePath(this.projectDir, inputPath)
    const storage = storageFromPath(target)
    return importPreview(target, storage)
  }

  import(input: { path?: unknown; mapping?: unknown }): DatasetSummary {
    const preview = this.previewImport(input)
    const target = preview.path
    const registry = this.readRegistry()
    this.ensurePathAvailable(registry, target)
    const mapping = preview.storage === 'sqlite'
      ? { ...CANONICAL_MAPPING }
      : normalizeFieldMapping(input.mapping, preview.suggestedMapping)
    const now = new Date().toISOString()
    const reference: DatasetReference = {
      id: randomUUID(),
      name: defaultName(target),
      storage: preview.storage,
      path: portableReferencePath(this.projectDir, target),
      version: 1,
      tags: [],
      scoringPrompt: '',
      mapping,
      createdAt: now,
      updatedAt: now,
    }
    const backend = backendFor(reference, this.projectDir)
    try {
      backend.list()
    } finally {
      backend.close()
    }
    registry.items.push(reference)
    this.writeRegistry(registry)
    return this.get(reference.id)
  }

  update(id: string, input: { name?: unknown; tags?: unknown; scoringPrompt?: unknown }): DatasetSummary {
    const registry = this.readRegistry()
    const reference = registry.items.find((item) => item.id === id)
    if (!reference) throw new Error(`dataset was not found: ${id}`)
    if (input.name !== undefined) {
      const name = requiredString(input.name, 'dataset name').trim()
      if (!name) throw new Error('dataset name is required')
      reference.name = name
    }
    if (input.tags !== undefined) reference.tags = normalizeTags(input.tags)
    let contentChanged = false
    if (input.scoringPrompt !== undefined) {
      const scoringPrompt = requiredString(input.scoringPrompt, 'scoringPrompt')
      contentChanged = scoringPrompt !== reference.scoringPrompt
      reference.scoringPrompt = scoringPrompt
    }
    if (contentChanged) reference.version += 1
    reference.updatedAt = new Date().toISOString()
    this.writeRegistry(registry)
    return this.get(id)
  }

  delete(id: string): { id: string; path: string; filesPreserved: true } {
    const registry = this.readRegistry()
    const index = registry.items.findIndex((item) => item.id === id)
    if (index < 0) throw new Error(`dataset was not found: ${id}`)
    const reference = registry.items[index]
    if (!reference) throw new Error(`dataset was not found: ${id}`)
    registry.items.splice(index, 1)
    this.writeRegistry(registry)
    return {
      id,
      path: resolveReferencePath(this.projectDir, reference.path),
      filesPreserved: true,
    }
  }

  listRecords(id: string, options: { query?: string; offset?: number; limit?: number } = {}): DatasetPage {
    const reference = this.reference(id)
    const backend = backendFor(reference, this.projectDir)
    try {
      const query = options.query?.trim().toLowerCase() ?? ''
      const records = backend.list().filter((record) => !query ||
        `${record.id} ${record.question} ${record.thinking} ${record.answer} ${record.expectedTools.join(' ')} ${record.metadata.tags.join(' ')}`.toLowerCase().includes(query))
      const offset = Math.max(0, Math.floor(options.offset ?? 0))
      const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 50)))
      return { items: records.slice(offset, offset + limit), total: records.length, offset, limit }
    } finally {
      backend.close()
    }
  }

  createRecord(id: string, input: DatasetRecordInput): DatasetRecord {
    const reference = this.reference(id)
    const record = normalizeRecord(input)
    const backend = backendFor(reference, this.projectDir)
    try {
      backend.create(record)
    } finally {
      backend.close()
    }
    this.touch(reference, true)
    return record
  }

  updateRecord(datasetId: string, recordId: string, input: DatasetRecordInput): DatasetRecord {
    const reference = this.reference(datasetId)
    const backend = backendFor(reference, this.projectDir)
    let existing: DatasetRecord | undefined
    try {
      existing = backend.list().find((item) => item.id === recordId)
      if (!existing) throw new Error(`dataset record was not found: ${recordId}`)
      const record = normalizeRecord({
        ...input,
        id: recordId,
        expectedTools: input.expectedTools ?? existing.expectedTools,
        metadata: {
          ...(isObject(input.metadata) ? input.metadata : {}),
          createdAt: existing.metadata.createdAt,
          updatedAt: new Date().toISOString(),
        },
      })
      backend.update(record)
      this.touch(reference, true)
      return record
    } finally {
      backend.close()
    }
  }

  deleteRecord(datasetId: string, recordId: string): void {
    const reference = this.reference(datasetId)
    const backend = backendFor(reference, this.projectDir)
    try {
      backend.delete(recordId)
    } finally {
      backend.close()
    }
    this.touch(reference, true)
  }

  private touch(reference: DatasetReference, incrementVersion = false): void {
    const registry = this.readRegistry()
    const current = registry.items.find((item) => item.id === reference.id)
    if (!current) return
    if (incrementVersion) current.version += 1
    current.updatedAt = new Date().toISOString()
    this.writeRegistry(registry)
  }

  private reference(id: string): DatasetReference {
    const reference = this.readRegistry().items.find((item) => item.id === id)
    if (!reference) throw new Error(`dataset was not found: ${id}`)
    return reference
  }

  private ensurePathAvailable(registry: DatasetRegistryFile, target: string): void {
    const key = path.normalize(target).toLowerCase()
    const duplicate = registry.items.some((item) =>
      path.normalize(resolveReferencePath(this.projectDir, item.path)).toLowerCase() === key)
    if (duplicate) throw new Error(`dataset path is already registered: ${target}`)
  }

  private readRegistry(): DatasetRegistryFile {
    if (!fs.existsSync(this.registryFile)) return structuredClone(EMPTY_REGISTRY)
    const parsed = JSON.parse(fs.readFileSync(this.registryFile, 'utf8')) as unknown
    if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.items)) {
      throw new Error('invalid dataset registry')
    }
    return {
      version: 1,
      items: parsed.items.map((item) => {
        if (!isObject(item)) throw new Error('invalid dataset registry item')
        return {
          ...item,
          scoringPrompt: typeof item.scoringPrompt === 'string' ? item.scoringPrompt : '',
          ...(item.mapping === undefined ? {} : { mapping: normalizeFieldMapping(item.mapping) }),
        } as DatasetReference
      }),
    }
  }

  private writeRegistry(registry: DatasetRegistryFile): void {
    fs.mkdirSync(path.dirname(this.registryFile), { recursive: true })
    fs.writeFileSync(this.registryFile, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
  }
}
