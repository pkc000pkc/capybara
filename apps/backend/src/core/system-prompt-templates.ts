import nunjucks from 'nunjucks'

export const SYSTEM_PROMPT_VARIABLE_TYPES = [
  'text',
  'prompt_template',
  'boolean',
  'integer',
  'number',
  'date',
  'datetime',
  'array',
  'object',
  'secret_ref',
] as const

export type SystemPromptVariableType = (typeof SYSTEM_PROMPT_VARIABLE_TYPES)[number]

export type SystemPromptVariableValue =
  | string
  | boolean
  | number
  | SystemPromptVariableValue[]
  | { [key: string]: SystemPromptVariableValue }

/**
 * Normalize the optional external source for a prompt_template variable.
 * The path is intentionally POSIX-like because it is persisted in plugin
 * manifests and must behave consistently on Windows and Unix hosts.
 */
export function normalizeSystemPromptVariableTemplatePath(value: unknown, name = 'template'): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  const normalized = value.trim().replace(/\\/g, '/')
  if (
    !normalized
    || normalized.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(value.trim())
    || normalized.split('/').some((segment) => segment === '..')
    || !/\.j2$/i.test(normalized)
  ) {
    throw new Error(`${name} must be a relative .j2 path inside the plugin`)
  }
  return normalized
}

export interface SystemPromptVariableSource {
  key: string
  value: SystemPromptVariableValue
  type?: SystemPromptVariableType
}

export interface ResolvedSystemPromptVariables {
  prompts: Record<string, string>
  values: Record<string, SystemPromptVariableValue>
  dependencies: Record<string, string[]>
}

type TemplateNode = {
  typename?: string
  value?: unknown
  target?: TemplateNode
  val?: TemplateNode
  findAll(type: unknown): TemplateNode[]
}

const DEFAULT_MAX_TEMPLATE_DEPTH = 64

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isVariableValue(value: unknown): value is SystemPromptVariableValue {
  if (typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isVariableValue)
  return isPlainObject(value) && Object.values(value).every(isVariableValue)
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year = 0, month = 0, day = 0] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function validDateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false
  return Number.isFinite(Date.parse(value))
}

export function isSystemPromptVariableType(value: unknown): value is SystemPromptVariableType {
  return typeof value === 'string' && (SYSTEM_PROMPT_VARIABLE_TYPES as readonly string[]).includes(value)
}

export function validateSystemPromptVariableValue(
  type: SystemPromptVariableType,
  value: unknown,
  name = 'system variable value',
): asserts value is SystemPromptVariableValue {
  if (!isVariableValue(value)) {
    throw new Error(`${name} must be finite JSON-compatible data without null values`)
  }
  switch (type) {
    case 'text':
    case 'prompt_template':
    case 'secret_ref':
      if (typeof value !== 'string') throw new Error(`${name} must be a string for ${type}`)
      if (type === 'secret_ref' && !value.trim()) throw new Error(`${name} must be a non-empty secret reference`)
      return
    case 'boolean':
      if (typeof value !== 'boolean') throw new Error(`${name} must be boolean`)
      return
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${name} must be an integer`)
      return
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`)
      return
    case 'date':
      if (typeof value !== 'string' || !validDate(value)) throw new Error(`${name} must use a valid YYYY-MM-DD date`)
      return
    case 'datetime':
      if (typeof value !== 'string' || !validDateTime(value)) throw new Error(`${name} must use an RFC 3339 datetime with timezone`)
      return
    case 'array':
      if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
      return
    case 'object':
      if (!isPlainObject(value)) throw new Error(`${name} must be an object`)
      return
  }
}

export function canonicalSystemPromptVariableValue(value: SystemPromptVariableValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export function templateVariablePaths(source: string): Set<string> {
  const api = nunjucks as unknown as {
    parser: { parse(value: string): TemplateNode }
    nodes: { LookupVal: unknown }
  }
  const pathOf = (node: TemplateNode): string[] => {
    if (node.typename === 'Symbol' && typeof node.value === 'string') return [node.value]
    if (node.typename !== 'LookupVal' || typeof node.val?.value !== 'string') return []
    const target = node.target ? pathOf(node.target) : []
    return target.length > 0 ? [...target, node.val.value] : []
  }
  return new Set(
    api.parser.parse(source)
      .findAll(api.nodes.LookupVal)
      .map((node) => pathOf(node).join('.'))
      .filter(Boolean),
  )
}

function promptDependencies(key: string, source: string): string[] {
  let paths: Set<string>
  try {
    paths = templateVariablePaths(source)
  } catch (error) {
    throw new Error(
      `prompt_template "${key}" has invalid Jinja2 syntax: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return [...new Set(
    [...paths]
      .filter((path) => path.startsWith('builtin.prompts.') || path.startsWith('builtin.variables.'))
      .map((path) => path.split('.')[2])
      .filter((dependency): dependency is string => Boolean(dependency)),
  )]
}

export function resolveSystemPromptVariables(
  variables: readonly SystemPromptVariableSource[],
  options: { maxDepth?: number } = {},
): ResolvedSystemPromptVariables {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_TEMPLATE_DEPTH
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new Error('prompt_template maxDepth must be a positive integer')
  }

  const sources = new Map(
    variables
      .filter((variable) => variable.key !== 'sys_message')
      .map((variable) => [variable.key, variable]),
  )
  const dependencies: Record<string, string[]> = {}
  for (const variable of sources.values()) {
    const type = variable.type ?? 'text'
    if (!isSystemPromptVariableType(type)) throw new Error(`unsupported system variable type: ${String(variable.type)}`)
    validateSystemPromptVariableValue(type, variable.value, `system variable "${variable.key}" value`)
    const directDependencies = variable.type === 'prompt_template'
      ? promptDependencies(variable.key, variable.value as string)
      : []
    dependencies[variable.key] = directDependencies
    for (const dependency of directDependencies) {
      if (!sources.has(dependency)) {
        throw new Error(
          `prompt_template "${variable.key}" references unknown system variable "${dependency}"`,
        )
      }
    }
  }

  const validateDependencyChain = (key: string, chain: string[]): void => {
    const variable = sources.get(key)
    if (!variable || variable.type !== 'prompt_template') return
    const cycleStart = chain.indexOf(key)
    if (cycleStart >= 0) {
      throw new Error(
        `circular prompt_template dependency: ${[...chain.slice(cycleStart), key].join(' -> ')}`,
      )
    }
    const nextChain = [...chain, key]
    if (nextChain.length > maxDepth) {
      throw new Error(
        `prompt_template dependency depth exceeds ${maxDepth}: ${nextChain.join(' -> ')}`,
      )
    }
    for (const dependency of dependencies[key] ?? []) {
      validateDependencyChain(dependency, nextChain)
    }
  }
  for (const key of sources.keys()) validateDependencyChain(key, [])

  const environment = new nunjucks.Environment(undefined, {
    autoescape: false,
    throwOnUndefined: true,
  })
  const prompts: Record<string, string> = {}
  const values: Record<string, SystemPromptVariableValue> = Object.fromEntries(
    [...sources].map(([key, variable]) => [key, variable.value]),
  )
  const resolving = new Set<string>()

  const resolve = (key: string, chain: string[]): string => {
    const existing = prompts[key]
    if (existing !== undefined) return existing
    const variable = sources.get(key)
    if (!variable) throw new Error(`system variable was not found: ${key}`)
    if (variable.type !== 'prompt_template') {
      prompts[key] = canonicalSystemPromptVariableValue(variable.value)
      return prompts[key]
    }
    if (resolving.has(key)) {
      const cycleStart = chain.indexOf(key)
      const cycle = [...chain.slice(Math.max(0, cycleStart)), key]
      throw new Error(`circular prompt_template dependency: ${cycle.join(' -> ')}`)
    }

    resolving.add(key)
    try {
      for (const dependency of dependencies[key] ?? []) {
        resolve(dependency, [...chain, key])
      }
      const promptContext = Object.fromEntries(
        [...sources].map(([sourceKey, source]) => [sourceKey, prompts[sourceKey] ?? canonicalSystemPromptVariableValue(source.value)]),
      )
      try {
        const rendered = environment.renderString(variable.value as string, {
          builtin: { prompts: promptContext, variables: values },
        })
        prompts[key] = rendered
        values[key] = rendered
        return rendered
      } catch (error) {
        throw new Error(
          `prompt_template "${key}" could not be rendered: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    } finally {
      resolving.delete(key)
    }
  }

  for (const key of sources.keys()) resolve(key, [])
  return { prompts, values, dependencies }
}
