import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import nunjucks from 'nunjucks'

import {
  experienceHarnessScore,
  HarnessRegistry,
  matchesModelHarness,
  matchesToolHarness,
} from '#core/harnesses/harness-registry'
import type { RegisteredHarness } from '#core/harnesses/types'
import { ProjectResources } from '#core/project-resources'
import type {
  HarnessResourceDefinition,
  HarnessResourceModule,
  ProjectResourceModule,
  ResourceCatalog,
  ResourceDiagnostic,
  ResourceFile,
  ResourceFileContent,
  SkillResourceDefinition,
  SkillResourceModule,
  ToolResourceDefinition,
  ToolResourceModule,
} from '#core/resources/types'
import { SkillRegistry } from '#core/skills/skill-registry'
import type { RegisteredSkill } from '#core/skills/types'
import { ToolDispatcher } from '#core/tools/tool-dispatcher'
import { ToolRegistry } from '#core/tools/tool-registry'
import type { RegisteredTool, ToolCallResult } from '#core/tools/types'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hash(...values: string[]): string {
  return createHash('sha256').update(values.join('\0')).digest('hex').slice(0, 16)
}

function fileHash(file: string): string {
  return hash(fs.readFileSync(file, 'utf8'))
}

export function resourceLanguage(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case '.json':
    case '.jsonc': return 'JSON'
    case '.md':
    case '.mdx': return 'Markdown'
    case '.j2':
    case '.jinja':
    case '.jinja2':
    case '.njk': return 'Jinja2'
    case '.ts':
    case '.mts':
    case '.cts': return 'TypeScript'
    case '.tsx': return 'TSX'
    case '.js':
    case '.mjs':
    case '.cjs': return 'JavaScript'
    case '.jsx': return 'JSX'
    case '.py': return 'Python'
    case '.yaml':
    case '.yml': return 'YAML'
    case '.html':
    case '.htm': return 'HTML'
    case '.css': return 'CSS'
    case '.sh':
    case '.bash': return 'Shell'
    case '.ps1': return 'PowerShell'
    default: return 'Text'
  }
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>()
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item])
  return [...groups.values()]
}

export class ResourceRevisionConflict extends Error {}

export class ProjectResourceRegistry {
  private readonly projectDir: string
  private readonly resources: ProjectResources

  constructor(projectDir: string) {
    this.projectDir = path.resolve(projectDir)
    this.resources = new ProjectResources(this.projectDir)
  }

  list(): ResourceCatalog {
    const settings = this.resources.readSettings()
    const tools = new ToolRegistry(this.projectDir)
    const skills = new SkillRegistry(this.projectDir)
    const harnesses = new HarnessRegistry(this.projectDir)
    tools.load(settings.tools)
    skills.load(settings.skills)
    harnesses.load(settings.harnesses)
    const toolNames = new Set(tools.list().map((tool) => tool.name))
    const items: ProjectResourceModule[] = [
      ...groupBy(tools.list(), (tool) => tool.manifestFile).map((group) => this.toolModule(group)),
      ...skills.list().map((skill) => this.skillModule(skill)),
      ...groupBy(harnesses.list(), (harness) => harness.manifestFile)
        .map((group) => this.harnessModule(group, toolNames)),
    ]
    return {
      revision: hash(...items.map((item) => `${item.id}:${item.revision}`)),
      items,
    }
  }

  readFile(relativeFile: string): ResourceFileContent {
    const file = this.list().items
      .flatMap((item) => item.files)
      .find((candidate) => candidate.path === relativeFile)
    if (!file) throw new Error('resource file was not found')
    const absolute = path.join(this.projectDir, file.path)
    const buffer = fs.readFileSync(absolute)
    if (buffer.includes(0)) throw new Error('binary resource files cannot be displayed')
    return { ...file, content: buffer.toString('utf8'), revision: fileHash(absolute) }
  }

  async testTool(id: string, argumentsValue: unknown): Promise<ToolCallResult> {
    const settings = this.resources.readSettings()
    const registry = new ToolRegistry(this.projectDir)
    registry.load(settings.tools)
    const tool = registry.list().find((item) => item.id === id)
    if (!tool) throw new Error('tool resource was not found')
    return new ToolDispatcher(registry, this.projectDir, {
      timeoutMs: settings.tool_timeout_ms,
      permissions: settings.tool_permissions,
    }).dispatch({ id: randomUUID(), name: tool.name, arguments: argumentsValue })
  }

  testSkill(id: string, contextValue: unknown) {
    if (!isObject(contextValue)) throw new Error('skill test context must be an object')
    const settings = this.resources.readSettings()
    const registry = new SkillRegistry(this.projectDir)
    registry.load(settings.skills)
    const skill = registry.get(id)
    if (!skill) throw new Error('skill resource was not found')

    return {
      valid: true,
      progressiveDisclosure: {
        discovery: {
          name: skill.name,
          description: skill.description,
        },
        activation: {
          entry: this.relative(skill.entryFile),
          instructions: skill.body,
        },
        resources: {
          scripts: skill.scriptFiles.map((file) => this.relative(file)),
          references: skill.referenceFiles.map((file) => this.relative(file)),
          assets: skill.assetFiles.map((file) => this.relative(file)),
        },
      },
      frontmatter: {
        name: skill.name,
        description: skill.description,
        ...(skill.license ? { license: skill.license } : {}),
        ...(skill.compatibility ? { compatibility: skill.compatibility } : {}),
        metadata: structuredClone(skill.metadata),
        ...(skill.allowedTools ? { allowedTools: skill.allowedTools } : {}),
      },
    }
  }

  testHarness(id: string, contextValue: unknown) {
    if (!isObject(contextValue)) throw new Error('harness test context must be an object')
    const settings = this.resources.readSettings()
    const registry = new HarnessRegistry(this.projectDir)
    registry.load(settings.harnesses)
    const harness = registry.get(id)
    if (!harness) throw new Error('harness resource was not found')
    const provider = typeof contextValue.provider === 'string' ? contextValue.provider : 'custom'
    const model = typeof contextValue.model === 'string' ? contextValue.model : settings.llm.model
    const request = typeof contextValue.request === 'string' ? contextValue.request : ''
    const tools = new Set(Array.isArray(contextValue.tools)
      ? contextValue.tools.filter((item): item is string => typeof item === 'string')
      : [])
    const matchedTools = matchesToolHarness(harness, tools)
    const score = experienceHarnessScore(harness, request)
    const matched = harness.type === 'model'
      ? matchesModelHarness(harness, provider, model)
      : harness.type === 'tool' ? matchedTools.length > 0 : score > 0
    const environment = new nunjucks.Environment(
      new nunjucks.FileSystemLoader(this.projectDir, { noCache: true }),
      { autoescape: false, throwOnUndefined: false },
    )
    return {
      matched,
      type: harness.type,
      score,
      matchedTools,
      rendered: environment.render(this.relative(harness.entryFile), contextValue).trim(),
      requiredTools: [...harness.requiredTools],
    }
  }

  saveSkill(id: string, value: unknown): SkillResourceModule {
    if (!isObject(value) || typeof value.content !== 'string' || typeof value.revision !== 'string') {
      throw new Error('skill update requires string content and revision')
    }
    const settings = this.resources.readSettings()
    const registry = new SkillRegistry(this.projectDir)
    registry.load(settings.skills)
    const skill = registry.get(id)
    if (!skill) throw new Error('skill resource was not found')
    if (fileHash(skill.entryFile) !== value.revision) {
      throw new ResourceRevisionConflict('skill changed on disk; reload before saving')
    }
    registry.validateContent(skill, value.content)
    fs.writeFileSync(skill.entryFile, value.content, 'utf8')
    const saved = this.list().items.find(
      (item): item is SkillResourceModule =>
        item.kind === 'skill' && item.skills.some((definition) => definition.id === id),
    )
    if (!saved) throw new Error('saved skill module was not found')
    return saved
  }

  saveHarness(id: string, value: unknown): HarnessResourceModule {
    if (!isObject(value) || typeof value.content !== 'string' || typeof value.revision !== 'string') {
      throw new Error('harness update requires string content and revision')
    }
    const settings = this.resources.readSettings()
    const registry = new HarnessRegistry(this.projectDir)
    registry.load(settings.harnesses)
    const harness = registry.get(id)
    if (!harness) throw new Error('harness resource was not found')
    if (fileHash(harness.entryFile) !== value.revision) {
      throw new ResourceRevisionConflict('harness changed on disk; reload before saving')
    }
    fs.writeFileSync(harness.entryFile, value.content, 'utf8')
    const saved = this.list().items.find(
      (item): item is HarnessResourceModule =>
        item.kind === 'harness' && item.harnesses.some((definition) => definition.id === id),
    )
    if (!saved) throw new Error('saved harness module was not found')
    return saved
  }

  private toolModule(tools: RegisteredTool[]): ToolResourceModule {
    const first = tools[0]
    if (!first) throw new Error('tool module contains no tools')
    const manifest = this.file(first.manifestFile, 'manifest')
    const runner = this.file(first.runnerEntry, 'runner')
    const definitions = tools.map((tool) => this.toolDefinition(tool))
    return {
      id: `tool-module:${manifest.path}`,
      kind: 'tool',
      package: first.packageName,
      name: first.packageName,
      version: first.manifestVersion,
      source: manifest.path,
      enabled: true,
      revision: hash(fileHash(first.manifestFile), fileHash(first.runnerEntry)),
      diagnostics: definitions.flatMap((tool) => tool.diagnostics),
      files: [manifest, runner],
      runner: { type: 'stdio', entry: runner.path },
      tools: definitions,
    }
  }

  private toolDefinition(tool: RegisteredTool): ToolResourceDefinition {
    const diagnostics: ResourceDiagnostic[] = tool.outputSchema ? [] : [{
      severity: 'warning',
      code: 'OUTPUT_SCHEMA_MISSING',
      message: `Tool ${tool.name} output is not schema validated`,
    }]
    return {
      id: tool.id,
      kind: 'tool',
      name: tool.name,
      description: tool.description,
      permissions: [...tool.permissions],
      inputSchema: tool.inputSchema,
      sideEffects: tool.sideEffects ?? 'none',
      replay: tool.replay ?? 'safe',
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      examples: tool.examples ?? [],
      diagnostics,
    }
  }

  private skillModule(skill: RegisteredSkill): SkillResourceModule {
    const definition = this.skillDefinition(skill)
    const files = this.uniqueFiles([
      this.file(skill.entryFile, 'entry', true),
      ...skill.scriptFiles.map((file) => this.file(file, 'script')),
      ...skill.referenceFiles.map((file) => this.file(file, 'reference')),
      ...skill.assetFiles.map((file) => this.file(file, 'asset')),
    ])
    return {
      id: `skill-module:${skill.id}`,
      kind: 'skill',
      package: skill.name,
      name: skill.name,
      version: 1,
      source: this.relative(skill.entryFile),
      enabled: true,
      revision: hash(...files.map((file) => fileHash(path.join(this.projectDir, file.path)))),
      diagnostics: definition.diagnostics,
      files,
      skills: [definition],
    }
  }

  private skillDefinition(skill: RegisteredSkill): SkillResourceDefinition {
    return {
      id: skill.id,
      kind: 'skill',
      name: skill.name,
      description: skill.description,
      ...(skill.license ? { license: skill.license } : {}),
      ...(skill.compatibility ? { compatibility: skill.compatibility } : {}),
      metadata: structuredClone(skill.metadata),
      ...(skill.allowedTools ? { allowedTools: skill.allowedTools } : {}),
      entry: this.relative(skill.entryFile),
      scripts: skill.scriptFiles.map((file) => this.relative(file)),
      references: skill.referenceFiles.map((file) => this.relative(file)),
      assets: skill.assetFiles.map((file) => this.relative(file)),
      content: fs.readFileSync(skill.entryFile, 'utf8'),
      entryRevision: fileHash(skill.entryFile),
      diagnostics: [],
    }
  }

  private harnessModule(
    harnesses: RegisteredHarness[],
    toolNames: ReadonlySet<string>,
  ): HarnessResourceModule {
    const first = harnesses[0]
    if (!first) throw new Error('harness module contains no harnesses')
    const definitions = harnesses.map((harness) => this.harnessDefinition(harness, toolNames))
    const files = this.uniqueFiles(harnesses.flatMap((harness) => [
      this.file(harness.manifestFile, 'manifest'),
      this.file(harness.entryFile, 'entry', true),
    ]))
    return {
      id: `harness-module:${this.relative(first.manifestFile)}`,
      kind: 'harness',
      package: first.packageName,
      name: first.packageName,
      version: first.manifestVersion,
      source: this.relative(first.manifestFile),
      enabled: true,
      revision: hash(...files.map((file) => fileHash(path.join(this.projectDir, file.path)))),
      diagnostics: definitions.flatMap((harness) => harness.diagnostics),
      files,
      harnesses: definitions,
    }
  }

  private harnessDefinition(
    harness: RegisteredHarness,
    toolNames: ReadonlySet<string>,
  ): HarnessResourceDefinition {
    const diagnostics: ResourceDiagnostic[] = harness.requiredTools
      .filter((tool) => !toolNames.has(tool))
      .map((tool) => ({
        severity: 'error',
        code: 'REQUIRED_TOOL_MISSING',
        message: `Harness ${harness.name} requires unregistered tool: ${tool}`,
      }))
    return {
      id: harness.id,
      kind: 'harness',
      name: harness.name,
      description: harness.description,
      type: harness.type,
      entry: this.relative(harness.entryFile),
      priority: harness.priority ?? 0,
      activation: structuredClone(harness.activation),
      inputs: [...harness.inputs],
      requiredTools: [...harness.requiredTools],
      examples: harness.examples ?? [],
      content: fs.readFileSync(harness.entryFile, 'utf8'),
      entryRevision: fileHash(harness.entryFile),
      diagnostics,
    }
  }

  private uniqueFiles(files: ResourceFile[]): ResourceFile[] {
    return [...new Map(files.map((file) => [file.path, file])).values()]
  }

  private file(
    absoluteFile: string,
    role: ResourceFile['role'],
    editable = false,
  ): ResourceFile {
    return {
      path: this.relative(absoluteFile),
      role,
      language: resourceLanguage(absoluteFile),
      editable,
    }
  }

  private relative(absoluteFile: string): string {
    return path.relative(this.projectDir, absoluteFile).replaceAll('\\', '/')
  }
}
