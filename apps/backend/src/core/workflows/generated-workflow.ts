import { Ajv, type ValidateFunction } from 'ajv'
import jsonata from 'jsonata'
import { createHash } from 'node:crypto'
import type { RuntimeCapabilityAuthorization } from '#protocol/runtime-protocol'

export interface WorkflowToolStep {
  id: string
  type: 'tool'
  tool: string
  arguments: Record<string, unknown>
  when?: string
}

export interface WorkflowFilterStep {
  id: string
  type: 'filter'
  input: unknown
  expression: string
  when?: string
}

export interface WorkflowForeachStep {
  id: string
  type: 'foreach'
  input: unknown
  as?: string
  maxItems?: number
  tool: string
  arguments: Record<string, unknown>
  when?: string
}

export interface WorkflowTransformStep {
  id: string
  type: 'transform'
  operator: 'map' | 'flat_map' | 'filter' | 'sort' | 'dedupe' | 'select_fields' | 'group_by' | 'partition' | 'paginate' | 'reduce' | 'normalize'
  input: unknown
  expression?: string
  fields?: string[]
  initial?: unknown
  pageSize?: number
  when?: string
}

export interface WorkflowAssertStep {
  id: string
  type: 'assert'
  input: unknown
  expression: string
  when?: string
}

export interface WorkflowParseStep {
  id: string
  type: 'parse'
  operator: 'json' | 'json_lines' | 'lines'
  input: unknown
  when?: string
}

export interface WorkflowAlignStep {
  id: string
  type: 'align'
  input: unknown
  sourceSchema?: unknown
  targetSchema?: unknown
  mappings?: Array<{
    from: string
    to: string
    transform?: 'identity' | 'trim' | 'string' | 'number' | 'boolean'
    required?: boolean
  }>
  auto?: boolean
  when?: string
}

export interface WorkflowValidateSchemaStep {
  id: string
  type: 'validate_schema'
  input: unknown
  schema: unknown
  schemaId?: string
  when?: string
}

export interface WorkflowJoinStep {
  id: string
  type: 'join'
  left: unknown
  right: unknown
  leftKey: string
  rightKey: string
  cardinality?: 'one_to_one' | 'many_to_one' | 'one_to_many' | 'many_to_many'
  joinType?: 'inner' | 'left'
  onAmbiguous?: 'error' | 'preserve'
  when?: string
}

export type GeneratedWorkflowStep =
  | WorkflowToolStep
  | WorkflowFilterStep
  | WorkflowForeachStep
  | WorkflowTransformStep
  | WorkflowAssertStep
  | WorkflowParseStep
  | WorkflowAlignStep
  | WorkflowValidateSchemaStep
  | WorkflowJoinStep

export interface GeneratedWorkflowDefinition {
  version: 1
  goal: string
  steps: GeneratedWorkflowStep[]
}

export interface CompactWorkflowCall {
  id: string
  tool: string
  args: Record<string, unknown>
  when?: string
}

export interface CompactWorkflowOperation {
  id: string
  op: 'filter' | 'transform' | 'assert' | 'parse' | 'align' | 'validate_schema' | 'join' | 'foreach'
  input?: unknown
  expression?: string
  operator?: string
  fields?: string[]
  initial?: unknown
  pageSize?: number
  schema?: Record<string, unknown>
  schemaId?: string
  sourceSchema?: unknown
  targetSchema?: unknown
  mappings?: Array<{ from: string; to: string; transform?: string; required?: boolean }>
  auto?: true
  left?: unknown
  right?: unknown
  leftKey?: string
  rightKey?: string
  cardinality?: string
  joinType?: string
  onAmbiguous?: string
  tool?: string
  args?: Record<string, unknown>
  as?: string
  maxItems?: number
  when?: string
}

export interface CompactWorkflowIntent {
  calls?: CompactWorkflowCall[]
  operations?: CompactWorkflowOperation[]
}

export interface WorkflowCompileSummary {
  graphHash: string
  nodeCount: number
  toolNodeCount: number
  deterministicNodeCount: number
  foreachNodeCount: number
  maxForeachItems: number
  semanticNodeCount: number
  estimatedModelRequests: number
}

export interface WorkflowExecutionData {
  authorization?: RuntimeCapabilityAuthorization
  steps: Record<string, {
    status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed'
    output?: unknown
    outputUnavailable?: true
  }>
}

/** Expressions can inspect the entire step map. A missing original cannot safely feed them. */
export function needsWorkflowOutput(step: GeneratedWorkflowStep, sourceId: string, expandedIteration: boolean): boolean {
  const reads = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(reads)
    if (!isObject(value)) return false
    if (Object.keys(value).length === 1 && typeof value.$expr === 'string') return true
    if (Object.keys(value).length === 1 && typeof value.$ref === 'string') {
      const [root, id, field] = value.$ref.split('.')
      return root === 'steps' && (!id || (id === sourceId && field !== 'status'))
    }
    return Object.values(value).some(reads)
  }
  if (expandedIteration) return 'arguments' in step && reads(step.arguments)
  if (step.when || step.type === 'filter') return true
  if (step.type === 'join') return reads(step.left) || reads(step.right)
  return reads('arguments' in step ? step.arguments : 'input' in step ? step.input : undefined)
}

export const GENERATED_WORKFLOW_PARAMETERS = {
  type: 'object',
  required: ['version', 'goal'],
  additionalProperties: false,
  anyOf: [{ required: ['steps'] }, { required: ['intent'] }],
  properties: {
    version: { const: 1 },
    goal: { type: 'string', minLength: 1, maxLength: 500 },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: {
        oneOf: [
          {
            type: 'object',
            required: ['id', 'type', 'tool', 'arguments'],
            additionalProperties: false,
            properties: {
              id: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$' },
              type: { const: 'tool' },
              tool: { type: 'string', minLength: 1 },
              arguments: { type: 'object' },
              when: { type: 'string', minLength: 1, maxLength: 2000 },
            },
          },
          {
            type: 'object',
            required: ['id', 'type', 'input', 'expression'],
            additionalProperties: false,
            properties: {
              id: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$' },
              type: { const: 'filter' },
              input: {},
              expression: { type: 'string', minLength: 1, maxLength: 2000 },
              when: { type: 'string', minLength: 1, maxLength: 2000 },
            },
          },
          {
            type: 'object',
            required: ['id', 'type', 'input', 'tool', 'arguments'],
            additionalProperties: false,
            properties: {
              id: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$' },
              type: { const: 'foreach' },
              input: {},
              as: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_]{0,31}$' },
              maxItems: { type: 'integer', minimum: 1, maximum: 100 },
              tool: { type: 'string', minLength: 1 },
              arguments: { type: 'object' },
              when: { type: 'string', minLength: 1, maxLength: 2000 },
            },
          },
          {
            type: 'object',
            required: ['id', 'type', 'operator', 'input'],
            additionalProperties: false,
            properties: {
              id: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$' },
              type: { const: 'transform' },
              operator: { enum: ['map', 'flat_map', 'filter', 'sort', 'dedupe', 'select_fields', 'group_by', 'partition', 'paginate', 'reduce', 'normalize'] },
              input: {},
              expression: { type: 'string', minLength: 1, maxLength: 2000 },
              fields: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 200 } },
              initial: {},
              pageSize: { type: 'integer', minimum: 1, maximum: 1000 },
              when: { type: 'string', minLength: 1, maxLength: 2000 },
            },
          },
          {
            type: 'object',
            required: ['id', 'type', 'input', 'expression'],
            additionalProperties: false,
            properties: {
              id: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$' },
              type: { const: 'assert' },
              input: {},
              expression: { type: 'string', minLength: 1, maxLength: 2000 },
              when: { type: 'string', minLength: 1, maxLength: 2000 },
            },
          },
          {
            type: 'object',
            required: ['id', 'type', 'operator', 'input'],
            additionalProperties: false,
            properties: {
              id: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$' },
              type: { const: 'parse' },
              operator: { enum: ['json', 'json_lines', 'lines'] },
              input: {},
              when: { type: 'string', minLength: 1, maxLength: 2000 },
            },
          },
          {
            type: 'object',
            required: ['id', 'type', 'input'],
            additionalProperties: false,
            properties: {
              id: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$' },
              type: { const: 'align' },
              input: {},
              sourceSchema: {},
              targetSchema: {},
              mappings: {
                type: 'array',
                maxItems: 100,
                items: {
                  type: 'object',
                  required: ['from', 'to'],
                  additionalProperties: false,
                  properties: {
                    from: { type: 'string', minLength: 1, maxLength: 1000 },
                    to: { type: 'string', minLength: 1, maxLength: 1000 },
                    transform: { enum: ['identity', 'trim', 'string', 'number', 'boolean'] },
                    required: { type: 'boolean' },
                  },
                },
              },
              auto: { const: true },
              when: { type: 'string', minLength: 1, maxLength: 2000 },
            },
            anyOf: [{ required: ['mappings'] }, { required: ['auto', 'targetSchema'] }],
          },
          {
            type: 'object',
            required: ['id', 'type', 'input', 'schema'],
            additionalProperties: false,
            properties: {
              id: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$' },
              type: { const: 'validate_schema' },
              input: {},
              schema: { type: 'object' },
              schemaId: { type: 'string', minLength: 1, maxLength: 200 },
              when: { type: 'string', minLength: 1, maxLength: 2000 },
            },
          },
          {
            type: 'object',
            required: ['id', 'type', 'left', 'right', 'leftKey', 'rightKey'],
            additionalProperties: false,
            properties: {
              id: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$' },
              type: { const: 'join' },
              left: {},
              right: {},
              leftKey: { type: 'string', minLength: 1, maxLength: 1000 },
              rightKey: { type: 'string', minLength: 1, maxLength: 1000 },
              cardinality: { enum: ['one_to_one', 'many_to_one', 'one_to_many', 'many_to_many'] },
              joinType: { enum: ['inner', 'left'] },
              onAmbiguous: { enum: ['error', 'preserve'] },
              when: { type: 'string', minLength: 1, maxLength: 2000 },
            },
          },
        ],
      },
    },
    intent: {
      type: 'object',
      additionalProperties: true,
    },
  },
} as const

const ajv = new Ajv({ allErrors: true, strict: false })
const validateDefinition = ajv.compile(GENERATED_WORKFLOW_PARAMETERS) as ValidateFunction

function validationMessage(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const COMPACT_WORKFLOW_OPS = new Set(['filter', 'transform', 'assert', 'parse', 'align', 'validate_schema', 'join', 'foreach'])

function validateCompactWorkflowIntent(intent: unknown): asserts intent is CompactWorkflowIntent {
  if (!isObject(intent)) throw new Error('generated workflow intent must be an object')
  const keys = Object.keys(intent)
  if (keys.some((key) => !['calls', 'operations'].includes(key))) throw new Error('generated workflow intent contains an unknown field')
  const calls = intent.calls
  const operations = intent.operations
  if (!Array.isArray(calls) && !Array.isArray(operations)) throw new Error('generated workflow intent requires calls or operations')
  if (Array.isArray(calls)) {
    if (calls.length < 1 || calls.length > 50) throw new Error('generated workflow intent calls must contain 1 to 50 items')
    for (const call of calls) {
      if (!isObject(call) || typeof call.id !== 'string' || typeof call.tool !== 'string' || !isObject(call.args)) {
        throw new Error('generated workflow intent call requires id, tool and args')
      }
    }
  }
  if (Array.isArray(operations)) {
    if (operations.length < 1 || operations.length > 50) throw new Error('generated workflow intent operations must contain 1 to 50 items')
    for (const operation of operations) {
      if (!isObject(operation) || typeof operation.id !== 'string' || typeof operation.op !== 'string' || !COMPACT_WORKFLOW_OPS.has(operation.op)) {
        throw new Error('invalid generated workflow intent operation: requires a supported id and op')
      }
    }
  }
}

function expandCompactWorkflowIntent(value: unknown): unknown {
  if (!isObject(value)) return value
  if (!('intent' in value)) return value.version === '1' ? { ...value, version: 1 } : value
  if ('steps' in value) throw new Error('generated workflow cannot contain both steps and intent')
  const intent = value.intent
  validateCompactWorkflowIntent(intent)
  const calls = Array.isArray(intent.calls) ? intent.calls.map((call) => {
    if (!isObject(call)) throw new Error('generated workflow intent call must be an object')
    const { args, ...rest } = call
    return { ...rest, type: 'tool', arguments: args }
  }) : []
  const operations = Array.isArray(intent.operations) ? intent.operations.map((operation) => {
    if (!isObject(operation) || typeof operation.op !== 'string') throw new Error('generated workflow intent operation must contain op')
    const { op, args, ...rest } = operation
    const expanded = { ...rest, type: op, ...(op === 'foreach' ? { arguments: args ?? {} } : {}) }
    return expanded
  }) : []
  const { intent: _intent, ...withoutIntent } = value
  return { ...withoutIntent, ...(value.version === '1' ? { version: 1 } : {}), steps: [...calls, ...operations] }
}

function pathTokens(reference: string): string[] {
  if (!reference || reference.length > 1000) throw new Error('workflow $ref must be a non-empty path')
  const tokens = reference.split('.')
  if (tokens.some((token) => !token || ['__proto__', 'prototype', 'constructor'].includes(token))) {
    throw new Error(`workflow $ref is unsafe: ${reference}`)
  }
  return tokens
}

function readPath(root: unknown, reference: string): unknown {
  let value = root
  for (const token of pathTokens(reference)) {
    if (Array.isArray(value)) {
      const index = Number(token)
      if (!Number.isInteger(index) || index < 0 || index >= value.length) {
        throw new Error(`workflow $ref was not found: ${reference}`)
      }
      value = value[index]
      continue
    }
    if (!isObject(value) || !(token in value)) {
      throw new Error(`workflow $ref was not found: ${reference}`)
    }
    value = value[token]
  }
  return value
}

export function parseGeneratedWorkflow(
  value: unknown,
  availableTools: ReadonlyMap<string, string>,
): GeneratedWorkflowDefinition {
  // Some provider-native tool decoders preserve the literal `"1"` even
  // though the schema advertises a numeric constant. This is the only
  // coercion accepted at the workflow boundary. All other fields remain
  // strictly schema-validated.
  const versionNormalized = isObject(value) && value.version === '1' ? { ...value, version: 1 } : value
  if (!validateDefinition(versionNormalized)) {
    throw new Error(`generated workflow is invalid: ${validationMessage(validateDefinition)}`)
  }
  const normalized = expandCompactWorkflowIntent(versionNormalized)
  if (!validateDefinition(normalized)) {
    throw new Error(`expanded generated workflow is invalid: ${validationMessage(validateDefinition)}`)
  }
  const definition = structuredClone(normalized) as GeneratedWorkflowDefinition
  const ids = new Set<string>()
  for (const step of definition.steps) {
    if (ids.has(step.id)) throw new Error(`generated workflow has duplicate step id: ${step.id}`)
    ids.add(step.id)
    if ('tool' in step) {
      const resolvedToolName = availableTools.get(step.tool)
      if (!resolvedToolName) {
        throw new Error(`generated workflow references a tool that is not loaded: ${step.tool}`)
      }
      step.tool = resolvedToolName
    }
  }
  const position = new Map(definition.steps.map((step, index) => [step.id, index]))
  const references = (value: unknown, result: string[] = []): string[] => {
    if (Array.isArray(value)) { for (const item of value) references(item, result); return result }
    if (!isObject(value)) return result
    if (Object.keys(value).length === 1 && typeof value.$ref === 'string') {
      const [root, id] = value.$ref.split('.')
      if (root === 'steps' && id) result.push(id)
      return result
    }
    for (const item of Object.values(value)) references(item, result)
    return result
  }
  for (const [index, step] of definition.steps.entries()) {
    const refs = references(step)
    for (const ref of refs) {
      const target = position.get(ref)
      if (target === undefined) throw new Error(`generated workflow references unknown step: ${ref}`)
      if (target >= index) throw new Error(`generated workflow reference must point to a prior step: ${step.id} -> ${ref}`)
    }
    if (step.type === 'transform' && ['map', 'flat_map', 'filter', 'sort', 'dedupe', 'group_by', 'partition', 'reduce'].includes(step.operator) && !step.expression) {
      throw new Error(`generated workflow transform ${step.id} requires expression`)
    }
    if (step.type === 'transform' && step.operator === 'select_fields' && (!step.fields || step.fields.length === 0)) {
      throw new Error(`generated workflow transform ${step.id} requires fields`)
    }
    if (step.type === 'transform' && step.operator === 'paginate' && !step.pageSize && !step.expression) {
      throw new Error(`generated workflow transform ${step.id} requires pageSize or expression`)
    }
    if (step.type === 'align' && (!step.mappings || step.mappings.length === 0) && !step.auto) {
      throw new Error(`generated workflow align ${step.id} requires mappings or auto=true`)
    }
    if (step.type === 'align' && step.auto && !isObject(step.targetSchema)) {
      throw new Error(`generated workflow align ${step.id} automatic mode requires targetSchema`)
    }
  }
  return definition
}

export function compileGeneratedWorkflow(
  value: unknown,
  availableTools: ReadonlyMap<string, string>,
): { definition: GeneratedWorkflowDefinition; summary: WorkflowCompileSummary } {
  const definition = parseGeneratedWorkflow(value, availableTools)
  const serialized = JSON.stringify(definition)
  const summary: WorkflowCompileSummary = {
    graphHash: createHash('sha256').update(serialized).digest('hex'),
    nodeCount: definition.steps.length,
    toolNodeCount: definition.steps.filter(step => step.type === 'tool' || step.type === 'foreach').length,
    deterministicNodeCount: definition.steps.filter(step => ['filter', 'transform', 'assert', 'parse', 'align', 'validate_schema', 'join'].includes(step.type)).length,
    foreachNodeCount: definition.steps.filter(step => step.type === 'foreach').length,
    maxForeachItems: definition.steps.reduce((max, step) => step.type === 'foreach' ? Math.max(max, step.maxItems ?? 20) : max, 0),
    semanticNodeCount: 0,
    estimatedModelRequests: 1,
  }
  if (summary.nodeCount > 50 || summary.maxForeachItems > 100) throw new Error('generated workflow exceeds deterministic execution limits')
  return { definition, summary }
}

export async function evaluateWorkflowExpression(
  expression: string,
  input: unknown,
  bindings: Record<string, unknown> = {},
): Promise<unknown> {
  if (!expression.trim() || expression.length > 2000) {
    throw new Error('workflow expression must contain between 1 and 2000 characters')
  }
  try {
    return await jsonata(expression).evaluate(input, bindings)
  } catch (error) {
    throw new Error(`workflow expression failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function resolveWorkflowValue(
  value: unknown,
  data: WorkflowExecutionData,
  locals: Record<string, unknown> = {},
): Promise<unknown> {
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => resolveWorkflowValue(item, data, locals)))
  }
  if (!isObject(value)) return value
  const keys = Object.keys(value)
  if (keys.length === 1 && typeof value.$ref === 'string') {
    return readPath({ ...data, ...locals }, value.$ref)
  }
  if (keys.length === 1 && typeof value.$expr === 'string') {
    return evaluateWorkflowExpression(value.$expr, { ...data, ...locals })
  }
  const resolved: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    resolved[key] = await resolveWorkflowValue(item, data, locals)
  }
  return resolved
}

export async function workflowCondition(
  expression: string | undefined,
  data: WorkflowExecutionData,
  locals: Record<string, unknown> = {},
): Promise<boolean> {
  if (!expression) return true
  return Boolean(await evaluateWorkflowExpression(expression, { ...data, ...locals }))
}

export async function filterWorkflowItems(
  items: unknown[],
  expression: string,
  data: WorkflowExecutionData,
): Promise<unknown[]> {
  const selected: unknown[] = []
  for (let index = 0; index < items.length; index += 1) {
    if (Boolean(await evaluateWorkflowExpression(expression, items[index], {
      steps: data.steps,
      index,
    }))) selected.push(items[index])
  }
  return selected
}

export async function transformWorkflowItems(
  input: unknown[],
  operator: WorkflowTransformStep['operator'],
  expression: string | undefined,
  fields: string[] | undefined,
  data: WorkflowExecutionData,
  options: Pick<WorkflowTransformStep, 'initial' | 'pageSize'> = {},
): Promise<unknown> {
  if (operator === 'select_fields') {
    return input.map(item => {
      if (!isObject(item)) return item
      return Object.fromEntries((fields ?? []).filter(field => field in item).map(field => [field, item[field]]))
    })
  }
  if (operator === 'normalize') return input.map(item => normalizeWorkflowValue(item))
  if (operator === 'paginate') {
    const evaluatedSize = expression ? Number(await evaluateWorkflowExpression(expression, input, { steps: data.steps })) : undefined
    const size = options.pageSize ?? evaluatedSize ?? 20
    if (!Number.isSafeInteger(size) || size < 1 || size > 1000) throw new Error('workflow paginate page size must be between 1 and 1000')
    const pages: unknown[][] = []
    for (let index = 0; index < input.length; index += size) pages.push(input.slice(index, index + size))
    return pages
  }
  if (!expression) throw new Error(`workflow ${operator} requires expression`)
  if (operator === 'filter') return filterWorkflowItems(input, expression, data)
  if (operator === 'map') return Promise.all(input.map((item, index) => evaluateWorkflowExpression(expression, item, { steps: data.steps, index })))
  if (operator === 'flat_map') {
    const mapped = await Promise.all(input.map((item, index) => evaluateWorkflowExpression(expression, item, { steps: data.steps, index })))
    return mapped.flatMap(item => Array.isArray(item) ? item : [item])
  }
  const keyed = await Promise.all(input.map(async (item, index) => ({ item, key: await evaluateWorkflowExpression(expression, item, { steps: data.steps, index }) })))
  if (operator === 'sort') return keyed.sort((a, b) => String(a.key).localeCompare(String(b.key), undefined, { numeric: true })).map(item => item.item)
  if (operator === 'dedupe') {
    const seen = new Set<string>()
    return keyed.filter(item => { const key = JSON.stringify(item.key); if (seen.has(key)) return false; seen.add(key); return true }).map(item => item.item)
  }
  if (operator === 'partition') {
    const selected: unknown[] = [], rejected: unknown[] = []
    for (let index = 0; index < input.length; index += 1) {
      const matches = Boolean(await evaluateWorkflowExpression(expression, input[index], { steps: data.steps, index }))
      const bucket = matches ? selected : rejected
      bucket.push(input[index])
    }
    return { selected, rejected }
  }
  if (operator === 'reduce') {
    let accumulator: unknown = options.initial ?? 0
    for (let index = 0; index < input.length; index += 1) accumulator = await evaluateWorkflowExpression(expression, input[index], { steps: data.steps, index, accumulator, value: input[index], $accumulator: accumulator, $value: input[index] })
    return accumulator
  }
  const groups = new Map<string, unknown[]>()
  for (const item of keyed) { const key = JSON.stringify(item.key); const group = groups.get(key) ?? []; group.push(item.item); groups.set(key, group) }
  return [...groups].map(([key, items]) => ({ key: JSON.parse(key), items }))
}

function normalizeWorkflowValue(value: unknown): unknown {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) return value.map(normalizeWorkflowValue)
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.trim(), normalizeWorkflowValue(item)]))
  return value
}

export async function assertWorkflowValue(input: unknown, expression: string, data: WorkflowExecutionData): Promise<boolean> {
  return Boolean(await evaluateWorkflowExpression(expression, input, { steps: data.steps }))
}
