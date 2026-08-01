import fs from 'node:fs'
import path from 'node:path'
import { Ajv, type ValidateFunction } from 'ajv'

import type {
  RegisteredTool,
  ToolManifest,
} from '#core/tools/types'

const MANIFEST_SCHEMA = {
  type: 'object',
  required: ['version', 'package', 'runner', 'tools'],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    package: { type: 'string', minLength: 1 },
    runner: {
      type: 'object',
      required: ['type', 'entry'],
      additionalProperties: false,
      properties: {
        type: { const: 'stdio' },
        entry: { type: 'string', minLength: 1 },
      },
    },
    tools: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['name', 'description', 'permissions', 'inputSchema'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]*$' },
          description: { type: 'string', minLength: 1 },
          permissions: {
            type: 'array',
            uniqueItems: true,
            items: { type: 'string', minLength: 1 },
          },
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          examples: {
            type: 'array',
            items: { type: 'object' },
          },
          sideEffects: { enum: ['none', 'workspace-write', 'external'] },
          replay: { enum: ['safe', 'confirm', 'never'] },
        },
      },
    },
  },
} as const

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function schemaError(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ')
}

export class ToolRegistry {
  private readonly ajv = new Ajv({ allErrors: true, strict: false })
  private readonly validateManifest = this.ajv.compile(MANIFEST_SCHEMA)
  private readonly projectDir: string
  private readonly projectRealDir: string
  private readonly registered = new Map<string, RegisteredTool>()

  constructor(projectDir: string) {
    this.projectDir = path.resolve(projectDir)
    this.projectRealDir = fs.realpathSync(this.projectDir)
  }

  load(manifestPaths: readonly string[]): void {
    const next = new Map<string, RegisteredTool>()
    for (const manifestPath of manifestPaths) {
      const manifestFile = this.resolveProjectFile(manifestPath)
      const value: unknown = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
      if (!this.validateManifest(value)) {
        throw new Error(`invalid tool manifest ${manifestPath}: ${schemaError(this.validateManifest)}`)
      }
      const manifest = value as ToolManifest
      const runnerEntry = this.resolveFile(path.dirname(manifestFile), manifest.runner.entry)
      for (const definition of manifest.tools) {
        if (next.has(definition.name)) {
          throw new Error(`duplicate project tool name: ${definition.name}`)
        }
        const validateInput = this.compileSchema(definition.inputSchema, definition.name, 'input')
        const validateOutput = definition.outputSchema
          ? this.compileSchema(definition.outputSchema, definition.name, 'output')
          : undefined
        next.set(definition.name, {
          ...definition,
          id: `${manifest.package}:${definition.name}`,
          packageName: manifest.package,
          manifestVersion: manifest.version,
          manifestFile,
          runnerEntry,
          validateInput,
          validateOutput,
        })
      }
    }
    this.registered.clear()
    next.forEach((tool, name) => this.registered.set(name, tool))
  }

  get(name: string): RegisteredTool | undefined {
    return this.registered.get(name)
  }

  list(): RegisteredTool[] {
    return [...this.registered.values()]
  }

  private compileSchema(
    schema: Record<string, unknown>,
    toolName: string,
    kind: 'input' | 'output',
  ): ValidateFunction {
    try {
      return this.ajv.compile(schema)
    } catch (error) {
      throw new Error(
        `invalid ${kind} schema for tool ${toolName}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private resolveProjectFile(relativeFile: string): string {
    if (typeof relativeFile !== 'string' || !relativeFile.trim() || path.isAbsolute(relativeFile)) {
      throw new Error('tool manifest path must be a project-relative file')
    }
    return this.resolveFile(this.projectDir, relativeFile)
  }

  private resolveFile(base: string, relativeFile: string): string {
    if (path.isAbsolute(relativeFile)) throw new Error('tool runner path must be relative')
    const candidate = path.resolve(base, relativeFile)
    if (!inside(this.projectDir, candidate)) throw new Error('tool file leaves the project workspace')
    const realFile = fs.realpathSync(candidate)
    if (!inside(this.projectRealDir, realFile)) throw new Error('tool symlink leaves the project workspace')
    if (!fs.statSync(realFile).isFile()) throw new Error(`tool path is not a file: ${relativeFile}`)
    return realFile
  }
}
