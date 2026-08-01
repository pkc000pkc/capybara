import { Ajv, type ValidateFunction } from 'ajv'
import jsonata from 'jsonata'

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

export type GeneratedWorkflowStep =
  | WorkflowToolStep
  | WorkflowFilterStep
  | WorkflowForeachStep

export interface GeneratedWorkflowDefinition {
  version: 1
  goal: string
  steps: GeneratedWorkflowStep[]
}

export interface WorkflowExecutionData {
  steps: Record<string, {
    status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed'
    output?: unknown
  }>
}

export const GENERATED_WORKFLOW_PARAMETERS = {
  type: 'object',
  required: ['version', 'goal', 'steps'],
  additionalProperties: false,
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
        ],
      },
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
  if (!validateDefinition(value)) {
    throw new Error(`generated workflow is invalid: ${validationMessage(validateDefinition)}`)
  }
  const definition = structuredClone(value) as GeneratedWorkflowDefinition
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
  return definition
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
