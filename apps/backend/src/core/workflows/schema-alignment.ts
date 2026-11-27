import { Ajv, type ValidateFunction } from 'ajv'
import { createHash } from 'node:crypto'

export type WorkflowParseOperator = 'json' | 'json_lines' | 'lines'
export type WorkflowFieldTransform = 'identity' | 'trim' | 'string' | 'number' | 'boolean'
export type WorkflowJoinCardinality = 'one_to_one' | 'many_to_one' | 'one_to_many' | 'many_to_many'

export interface WorkflowFieldMapping {
  from: string
  to: string
  transform?: WorkflowFieldTransform
  required?: boolean
}

export interface WorkflowParseResult {
  value: unknown
  raw: unknown
  operator: WorkflowParseOperator
  status: 'parsed' | 'already_structured'
  lineCount?: number
}

export interface WorkflowAlignmentResult {
  records: Array<Record<string, unknown>>
  alignment: {
    status: 'aligned'
    mode: 'explicit' | 'deterministic_auto'
    sourceSchema?: string
    targetSchema?: string
    mappingHash: string
  }
  unmappedFields: Array<{ recordIndex: number; fields: string[] }>
}

export interface WorkflowSchemaValidationResult {
  value: unknown
  valid: true
  schemaId?: string
}

export interface WorkflowJoinResult {
  records: Array<{
    key: unknown
    left: Record<string, unknown>
    right: Record<string, unknown> | null
    conflicts: Array<{ path: string; left: unknown; right: unknown }>
  }>
  conflicts: Array<{ recordIndex: number; path: string; left: unknown; right: unknown }>
  join: {
    leftKey: string
    rightKey: string
    cardinality: WorkflowJoinCardinality
    joinType: 'inner' | 'left'
    onAmbiguous: 'error' | 'preserve'
  }
}

const ajv = new Ajv({ allErrors: true, strict: false })

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pathTokens(path: string): string[] {
  if (!path || path.length > 1000) throw new Error('schema alignment paths must be non-empty and at most 1000 characters')
  const tokens = path.startsWith('/')
    ? path.slice(1).split('/').map(token => token.replaceAll('~1', '/').replaceAll('~0', '~'))
    : path.split('.')
  if (tokens.some(token => !token || ['__proto__', 'prototype', 'constructor'].includes(token))) {
    throw new Error(`schema alignment path is unsafe: ${path}`)
  }
  return tokens
}

function readPath(root: unknown, path: string): { found: boolean; value?: unknown } {
  let value = root
  for (const token of pathTokens(path)) {
    if (Array.isArray(value)) {
      const index = Number(token)
      if (!Number.isInteger(index) || index < 0 || index >= value.length) return { found: false }
      value = value[index]
      continue
    }
    if (!isObject(value) || !Object.hasOwn(value, token)) return { found: false }
    value = value[token]
  }
  return { found: true, value }
}

function writePath(root: Record<string, unknown>, path: string, value: unknown): void {
  const tokens = pathTokens(path)
  let target = root
  for (const token of tokens.slice(0, -1)) {
    const existing = target[token]
    if (isObject(existing)) target = existing
    else {
      const child: Record<string, unknown> = {}
      target[token] = child
      target = child
    }
  }
  target[tokens[tokens.length - 1]!] = value
}

function schemaId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value
  if (!isObject(value)) return undefined
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}

function mappingHash(mappings: readonly WorkflowFieldMapping[]): string {
  const canonical = [...mappings].map(mapping => ({
    from: mapping.from,
    to: mapping.to,
    transform: mapping.transform ?? 'identity',
    required: mapping.required === true,
  })).sort((a, b) => `${a.from}\u0000${a.to}`.localeCompare(`${b.from}\u0000${b.to}`))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function normalizedFieldName(value: string): string {
  return value.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`).replace(/[^a-z0-9]/g, '')
}

function inferMappings(input: unknown, targetSchema: unknown): WorkflowFieldMapping[] {
  if (!isObject(targetSchema) || !isObject(targetSchema.properties)) {
    throw new Error('automatic workflow alignment requires targetSchema.properties')
  }
  const records = Array.isArray(input) ? input : [input]
  const sourceKeys = [...new Set(records.flatMap(record => isObject(record) ? Object.keys(record) : []))]
  const sourceByNormalized = new Map<string, string[]>()
  for (const key of sourceKeys) {
    const normalized = normalizedFieldName(key)
    sourceByNormalized.set(normalized, [...sourceByNormalized.get(normalized) ?? [], key])
  }
  const required = new Set(Array.isArray(targetSchema.required) ? targetSchema.required.filter((item): item is string => typeof item === 'string') : [])
  const mappings: WorkflowFieldMapping[] = []
  for (const target of Object.keys(targetSchema.properties)) {
    const candidates = sourceByNormalized.get(normalizedFieldName(target)) ?? []
    if (candidates.length > 1) throw new Error(`automatic workflow alignment is ambiguous for target field: ${target}`)
    if (candidates.length === 0) {
      if (required.has(target)) throw new Error(`automatic workflow alignment cannot find required field: ${target}`)
      continue
    }
    mappings.push({ from: candidates[0]!, to: target, required: required.has(target) })
  }
  if (mappings.length === 0) throw new Error('automatic workflow alignment found no compatible fields')
  return mappings
}

function applyTransform(value: unknown, transform: WorkflowFieldTransform | undefined, path: string): unknown {
  switch (transform ?? 'identity') {
    case 'identity': return value
    case 'trim':
      if (typeof value !== 'string') throw new Error(`alignment field ${path} must be a string for trim`)
      return value.trim()
    case 'string':
      if (value === null || value === undefined) return value
      return typeof value === 'string' ? value : String(value)
    case 'number': {
      const number = typeof value === 'number' ? value : Number(typeof value === 'string' ? value.trim() : value)
      if (!Number.isFinite(number)) throw new Error(`alignment field ${path} is not a finite number`)
      return number
    }
    case 'boolean':
      if (typeof value === 'boolean') return value
      if (value === 'true' || value === '1' || value === 1) return true
      if (value === 'false' || value === '0' || value === 0) return false
      throw new Error(`alignment field ${path} is not a boolean`)
  }
}

export function parseWorkflowValue(input: unknown, operator: WorkflowParseOperator): WorkflowParseResult {
  if (typeof input !== 'string') {
    return { value: input, raw: input, operator, status: 'already_structured' }
  }
  if (operator === 'json') {
    try {
      return { value: JSON.parse(input), raw: input, operator, status: 'parsed' }
    } catch (error) {
      throw new Error(`workflow JSON parse failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const lines = input.split(/\r?\n/).filter(line => line.trim().length > 0)
  if (operator === 'lines') return { value: lines, raw: input, operator, status: 'parsed', lineCount: lines.length }
  const values: unknown[] = []
  for (const [index, line] of lines.entries()) {
    try {
      values.push(JSON.parse(line))
    } catch (error) {
      throw new Error(`workflow JSON Lines parse failed at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { value: values, raw: input, operator, status: 'parsed', lineCount: values.length }
}

export function alignWorkflowRecords(
  input: unknown,
  mappings: readonly WorkflowFieldMapping[] = [],
  options: { sourceSchema?: unknown; targetSchema?: unknown; auto?: boolean } = {},
): WorkflowAlignmentResult {
  const effectiveMappings = mappings.length > 0
    ? mappings
    : options.auto
      ? inferMappings(input, options.targetSchema)
      : (() => { throw new Error('workflow alignment requires at least one field mapping or auto=true') })()
  const records = Array.isArray(input) ? input : [input]
  const output: Array<Record<string, unknown>> = []
  const unmappedFields: Array<{ recordIndex: number; fields: string[] }> = []
  for (const [recordIndex, record] of records.entries()) {
    if (!isObject(record)) throw new Error(`workflow alignment record ${recordIndex} must be an object`)
    const aligned: Record<string, unknown> = {}
    const mapped = new Set<string>()
    for (const mapping of effectiveMappings) {
      const found = readPath(record, mapping.from)
      if (!found.found) {
        if (mapping.required) throw new Error(`workflow alignment required field is missing: ${mapping.from}`)
        continue
      }
      writePath(aligned, mapping.to, applyTransform(found.value, mapping.transform, mapping.from))
      mapped.add(mapping.from.split('.')[0]!)
    }
    const extras = Object.keys(record).filter(key => !mapped.has(key))
    if (extras.length > 0) unmappedFields.push({ recordIndex, fields: extras })
    output.push(aligned)
  }
  return {
    records: output,
    alignment: {
      status: 'aligned',
      mode: options.auto && mappings.length === 0 ? 'deterministic_auto' : 'explicit',
      ...(schemaId(options.sourceSchema) ? { sourceSchema: schemaId(options.sourceSchema) } : {}),
      ...(schemaId(options.targetSchema) ? { targetSchema: schemaId(options.targetSchema) } : {}),
      mappingHash: mappingHash(effectiveMappings),
    },
    unmappedFields,
  }
}

export function validateWorkflowSchema(input: unknown, schema: unknown, schemaIdValue?: string): WorkflowSchemaValidationResult {
  if (!isObject(schema)) throw new Error('workflow schema validation requires a JSON Schema object')
  let validate: ValidateFunction
  try {
    validate = ajv.compile(schema)
  } catch (error) {
    throw new Error(`workflow schema is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!validate(input)) {
    const details = (validate.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`).join('; ')
    throw new Error(`workflow schema validation failed: ${details}`)
  }
  return { value: input, valid: true, ...(schemaIdValue ? { schemaId: schemaIdValue } : {}) }
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function conflictsFor(left: Record<string, unknown>, right: Record<string, unknown>, prefix = ''): Array<{ path: string; left: unknown; right: unknown }> {
  const conflicts: Array<{ path: string; left: unknown; right: unknown }> = []
  for (const [key, leftValue] of Object.entries(left)) {
    if (!Object.hasOwn(right, key)) continue
    const path = prefix ? `${prefix}.${key}` : key
    if (isObject(leftValue) && isObject(right[key])) conflicts.push(...conflictsFor(leftValue, right[key] as Record<string, unknown>, path))
    else if (!valuesEqual(leftValue, right[key])) conflicts.push({ path, left: leftValue, right: right[key] })
  }
  return conflicts
}

export function joinWorkflowRecords(
  leftInput: unknown,
  rightInput: unknown,
  options: {
    leftKey: string
    rightKey: string
    cardinality?: WorkflowJoinCardinality
    joinType?: 'inner' | 'left'
    onAmbiguous?: 'error' | 'preserve'
  },
): WorkflowJoinResult {
  if (!Array.isArray(leftInput) || !Array.isArray(rightInput)) throw new Error('workflow join inputs must resolve to arrays')
  const cardinality = options.cardinality ?? 'many_to_many'
  const joinType = options.joinType ?? 'left'
  const onAmbiguous = options.onAmbiguous ?? 'preserve'
  const grouped = new Map<string, Array<Record<string, unknown>>>()
  for (const [index, item] of rightInput.entries()) {
    if (!isObject(item)) throw new Error(`workflow join right record ${index} must be an object`)
    const key = readPath(item, options.rightKey)
    if (!key.found) throw new Error(`workflow join right key is missing: ${options.rightKey}`)
    const bucket = grouped.get(JSON.stringify(key.value)) ?? []
    bucket.push(item)
    grouped.set(JSON.stringify(key.value), bucket)
  }
  const records: WorkflowJoinResult['records'] = []
  const conflicts: WorkflowJoinResult['conflicts'] = []
  const rightUsage = new Map<Record<string, unknown>, number>()
  for (const [index, item] of leftInput.entries()) {
    if (!isObject(item)) throw new Error(`workflow join left record ${index} must be an object`)
    const key = readPath(item, options.leftKey)
    if (!key.found) throw new Error(`workflow join left key is missing: ${options.leftKey}`)
    const matches = grouped.get(JSON.stringify(key.value)) ?? []
    if (matches.length > 1 && (cardinality === 'one_to_one' || cardinality === 'many_to_one') && onAmbiguous === 'error') {
      throw new Error(`workflow join found multiple right records for key ${JSON.stringify(key.value)}`)
    }
    if (matches.length === 0) {
      if (joinType === 'left') records.push({ key: key.value, left: item, right: null, conflicts: [] })
      continue
    }
    for (const right of matches) {
      const usedByLeftCount = rightUsage.get(right) ?? 0
      if (usedByLeftCount > 0 && (cardinality === 'one_to_one' || cardinality === 'one_to_many') && onAmbiguous === 'error') {
        throw new Error(`workflow join right record is matched by multiple left records for key ${JSON.stringify(key.value)}`)
      }
      rightUsage.set(right, usedByLeftCount + 1)
      const rowConflicts = conflictsFor(item, right)
      const recordIndex = records.length
      records.push({ key: key.value, left: item, right, conflicts: rowConflicts })
      for (const conflict of rowConflicts) conflicts.push({ recordIndex, ...conflict })
    }
  }
  return { records, conflicts, join: { leftKey: options.leftKey, rightKey: options.rightKey, cardinality, joinType, onAmbiguous } }
}
