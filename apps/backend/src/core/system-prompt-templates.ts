import nunjucks from 'nunjucks'

export type SystemPromptVariableType = 'text' | 'prompt_template'

export interface SystemPromptVariableSource {
  key: string
  value: string
  type?: SystemPromptVariableType
}

export interface ResolvedSystemPromptVariables {
  prompts: Record<string, string>
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
      .filter((path) => path.startsWith('builtin.prompts.'))
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
    const directDependencies = variable.type === 'prompt_template'
      ? promptDependencies(variable.key, variable.value)
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
  const resolving = new Set<string>()

  const resolve = (key: string, chain: string[]): string => {
    const existing = prompts[key]
    if (existing !== undefined) return existing
    const variable = sources.get(key)
    if (!variable) throw new Error(`system variable was not found: ${key}`)
    if (variable.type !== 'prompt_template') {
      prompts[key] = variable.value
      return variable.value
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
        [...sources].map(([sourceKey, source]) => [sourceKey, prompts[sourceKey] ?? source.value]),
      )
      try {
        const rendered = environment.renderString(variable.value, {
          builtin: { prompts: promptContext },
        })
        prompts[key] = rendered
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
  return { prompts, dependencies }
}
