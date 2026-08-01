import fs from 'node:fs'
import path from 'node:path'
import { Ajv, type ValidateFunction } from 'ajv'

import type {
  HarnessManifest,
  RegisteredHarness,
} from '#core/harnesses/types'

export function matchesModelHarness(
  harness: RegisteredHarness,
  provider: string,
  model: string,
): boolean {
  if (harness.type !== 'model') return false
  const activation = harness.activation as {
    providers?: string[]
    models?: string[]
    modelFamilies?: string[]
  }
  const normalizedProvider = provider.toLowerCase()
  const normalizedModel = model.toLowerCase()
  return Boolean(
    activation.providers?.some((item) => item.toLowerCase() === normalizedProvider)
    || activation.models?.some((item) => item.toLowerCase() === normalizedModel)
    || activation.modelFamilies?.some((item) => normalizedModel.startsWith(item.toLowerCase())),
  )
}

export function matchesToolHarness(
  harness: RegisteredHarness,
  toolNames: ReadonlySet<string>,
): string[] {
  if (harness.type !== 'tool') return []
  return ((harness.activation as { tools: string[] }).tools ?? [])
    .filter((name) => toolNames.has(name))
}

export function experienceHarnessScore(
  harness: RegisteredHarness,
  query: string,
): number {
  if (harness.type !== 'experience') return 0
  const normalized = query.toLowerCase()
  const keywords = (harness.activation as { keywords: string[] }).keywords
  const matched = keywords.filter((keyword) => normalized.includes(keyword.toLowerCase()))
  return keywords.length > 0 ? matched.length / keywords.length : 0
}

const STRING_LIST = {
  type: 'array',
  uniqueItems: true,
  items: { type: 'string', minLength: 1 },
} as const

const MANIFEST_SCHEMA = {
  type: 'object',
  required: ['version', 'package', 'harnesses'],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    package: { type: 'string', minLength: 1 },
    harnesses: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: [
          'name', 'description', 'type', 'entry', 'activation',
          'inputs', 'requiredTools',
        ],
        additionalProperties: false,
        properties: {
          name: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]*$' },
          description: { type: 'string', minLength: 1 },
          type: { enum: ['model', 'tool', 'experience'] },
          entry: { type: 'string', minLength: 1 },
          priority: { type: 'integer', minimum: -10_000, maximum: 10_000 },
          activation: { type: 'object' },
          inputs: STRING_LIST,
          requiredTools: STRING_LIST,
          examples: { type: 'array', items: { type: 'object' } },
        },
      },
    },
  },
} as const

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function schemaError(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ')
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0
    && value.every((item) => typeof item === 'string' && item.trim())
}

export class HarnessRegistry {
  private readonly ajv = new Ajv({ allErrors: true, strict: false })
  private readonly validateManifest = this.ajv.compile(MANIFEST_SCHEMA)
  private readonly projectDir: string
  private readonly projectRealDir: string
  private readonly registered = new Map<string, RegisteredHarness>()

  constructor(projectDir: string) {
    this.projectDir = path.resolve(projectDir)
    this.projectRealDir = fs.realpathSync(this.projectDir)
  }

  load(manifestPaths: readonly string[]): void {
    const next = new Map<string, RegisteredHarness>()
    for (const manifestPath of manifestPaths) {
      const manifestFile = this.resolveProjectFile(manifestPath)
      const value: unknown = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
      if (!this.validateManifest(value)) {
        throw new Error(`invalid harness manifest ${manifestPath}: ${schemaError(this.validateManifest)}`)
      }
      const manifest = value as HarnessManifest
      for (const definition of manifest.harnesses) {
        const id = `${manifest.package}:${definition.name}`
        if (next.has(id)) throw new Error(`duplicate project harness: ${id}`)
        this.validateActivation(id, definition.type, definition.activation)
        next.set(id, {
          ...definition,
          priority: definition.priority ?? 0,
          id,
          packageName: manifest.package,
          manifestVersion: manifest.version,
          manifestFile,
          entryFile: this.resolveModuleFile(manifestFile, definition.entry),
        })
      }
    }
    this.registered.clear()
    next.forEach((harness, id) => this.registered.set(id, harness))
  }

  get(id: string): RegisteredHarness | undefined {
    return this.registered.get(id)
  }

  list(): RegisteredHarness[] {
    return [...this.registered.values()]
  }

  private validateActivation(
    id: string,
    type: RegisteredHarness['type'],
    activation: unknown,
  ): void {
    if (!isObject(activation)) throw new Error(`harness ${id} activation must be an object`)
    const allowed = type === 'model'
      ? ['providers', 'models', 'modelFamilies']
      : type === 'tool' ? ['tools'] : ['keywords', 'tags']
    const unknown = Object.keys(activation).find((key) => !allowed.includes(key))
    if (unknown) throw new Error(`harness ${id} has unsupported activation field: ${unknown}`)
    if (type === 'model') {
      if (!allowed.some((key) => stringList(activation[key]))) {
        throw new Error(`model harness ${id} requires providers, models, or modelFamilies`)
      }
      return
    }
    const required = type === 'tool' ? 'tools' : 'keywords'
    if (!stringList(activation[required])) {
      throw new Error(`${type} harness ${id} requires activation.${required}`)
    }
    if (activation.tags !== undefined && !stringList(activation.tags)) {
      throw new Error(`experience harness ${id} activation.tags must be a non-empty string array`)
    }
  }

  private resolveProjectFile(relativeFile: string): string {
    if (typeof relativeFile !== 'string' || !relativeFile.trim() || path.isAbsolute(relativeFile)) {
      throw new Error('harness manifest path must be a project-relative file')
    }
    return this.resolveFile(this.projectDir, relativeFile, 'harness manifest')
  }

  private resolveModuleFile(manifestFile: string, relativeFile: string): string {
    const moduleDir = path.dirname(manifestFile)
    const file = this.resolveFile(moduleDir, relativeFile, 'harness entry')
    if (!inside(moduleDir, file)) throw new Error('harness entry leaves its module directory')
    return file
  }

  private resolveFile(base: string, relativeFile: string, label: string): string {
    if (path.isAbsolute(relativeFile)) throw new Error(`${label} path must be relative`)
    const candidate = path.resolve(base, relativeFile)
    if (!inside(this.projectDir, candidate)) throw new Error(`${label} leaves the project workspace`)
    const realFile = fs.realpathSync(candidate)
    if (!inside(this.projectRealDir, realFile)) throw new Error(`${label} symlink leaves the project workspace`)
    if (!fs.statSync(realFile).isFile()) throw new Error(`${label} is not a file: ${relativeFile}`)
    return realFile
  }
}
