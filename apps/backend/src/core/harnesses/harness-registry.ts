import fs from 'node:fs'
import os from 'node:os'
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
  return matchesModelHarnessActivation(activation, provider, model)
}

export function matchesModelHarnessActivation(
  activation: { providers?: string[]; models?: string[]; modelFamilies?: string[] },
  provider: string,
  model: string,
): boolean {
  const normalizedProvider = provider.toLowerCase()
  const normalizedModel = model.toLowerCase()
  const matches = (value: string, actual: string) => value === '*' || value.toLowerCase() === actual
  return Boolean(
    activation.providers?.some((item) => matches(item, normalizedProvider))
    || activation.models?.some((item) => matches(item, normalizedModel))
    || activation.modelFamilies?.some((item) => (
      item === '*' || normalizedModel.startsWith(item.toLowerCase())
    )),
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
          type: { enum: ['model', 'tool', 'experience', 'persistent'] },
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
  private readonly systemDir: string
  private readonly systemRealDir: string
  private readonly registered = new Map<string, RegisteredHarness>()

  constructor(projectDir: string, systemDir = path.join(os.homedir(), '.capybara')) {
    this.projectDir = path.resolve(projectDir)
    this.projectRealDir = fs.realpathSync(this.projectDir)
    this.systemDir = path.resolve(systemDir)
    fs.mkdirSync(this.systemDir, { recursive: true })
    this.systemRealDir = fs.realpathSync(this.systemDir)
  }

  load(manifestPaths: readonly string[]): void {
    const next = new Map<string, RegisteredHarness>()
    for (const manifestPath of manifestPaths) {
      const resolvedManifest = this.resolveResourceFile(manifestPath, 'harness manifest')
      const manifestFile = resolvedManifest.file
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
          entryFile: this.resolveModuleFile(manifestFile, definition.entry, resolvedManifest.root),
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
      : type === 'tool' ? ['tools'] : type === 'experience' ? ['keywords', 'tags'] : []
    const unknown = Object.keys(activation).find((key) => !allowed.includes(key))
    if (unknown) throw new Error(`harness ${id} has unsupported activation field: ${unknown}`)
    if (type === 'model') {
      if (!allowed.some((key) => stringList(activation[key]))) {
        throw new Error(`model harness ${id} requires providers, models, or modelFamilies`)
      }
      return
    }
    if (type === 'persistent') return
    const required = type === 'tool' ? 'tools' : 'keywords'
    if (!stringList(activation[required])) {
      throw new Error(`${type} harness ${id} requires activation.${required}`)
    }
    if (activation.tags !== undefined && !stringList(activation.tags)) {
      throw new Error(`experience harness ${id} activation.tags must be a non-empty string array`)
    }
  }

  private resolveResourceFile(resourcePath: string, label: string): { file: string; root: string } {
    if (typeof resourcePath !== 'string' || !resourcePath.trim()) {
      throw new Error(`${label} path must be a resource-relative file`)
    }
    const normalized = resourcePath.replaceAll('\\', '/')
    if (normalized.startsWith('@system/')) {
      const relative = normalized.slice('@system/'.length)
      return { file: this.resolveFile(this.systemDir, relative, label, this.systemDir), root: this.systemDir }
    }
    if (path.isAbsolute(resourcePath)) throw new Error(`${label} path must be relative`)
    return { file: this.resolveFile(this.projectDir, resourcePath, label, this.projectDir), root: this.projectDir }
  }

  private resolveModuleFile(manifestFile: string, relativeFile: string, root: string): string {
    const moduleDir = path.dirname(manifestFile)
    const file = this.resolveFile(moduleDir, relativeFile, 'harness entry', root)
    if (!inside(moduleDir, file)) throw new Error('harness entry leaves its module directory')
    return file
  }

  private resolveFile(base: string, relativeFile: string, label: string, root: string): string {
    if (path.isAbsolute(relativeFile)) throw new Error(`${label} path must be relative`)
    const candidate = path.resolve(base, relativeFile)
    if (!inside(root, candidate)) throw new Error(`${label} leaves its resource root`)
    const realFile = fs.realpathSync(candidate)
    const realRoot = root === this.systemDir ? this.systemRealDir : this.projectRealDir
    if (!inside(realRoot, realFile)) throw new Error(`${label} symlink leaves its resource root`)
    if (!fs.statSync(realFile).isFile()) throw new Error(`${label} is not a file: ${relativeFile}`)
    return realFile
  }
}
