import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { enqueueProjectWrite } from '#core/project-write-queue'
import {
  ProjectResources,
  type ProjectSettings,
  type SystemVariableDefinition,
} from '#core/project-resources'
import { normalizeSystemPromptVariableTemplatePath } from '#core/system-prompt-templates'
import {
  PluginRegistry,
  pluginManifestFile,
  satisfiesToolVersion,
  variableReferenceCount,
} from '#core/plugins/plugin-registry'
import { ProjectResourceRegistry } from '#core/resources/resource-registry'
import { HookRegistry } from '#core/hooks/hook-registry'
import type { HarnessType, ProjectHarnessDefinition } from '#core/harnesses/types'
import type {
  HarnessResourceDefinition,
  HookResourceDefinition,
  PluginResource,
  ProjectResourceModule,
  ResourceCatalog,
  ToolPackageResource,
} from '#core/resources/types'
import { ToolRegistry } from '#core/tools/tool-registry'

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function normalizeRelative(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/$/, '')
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`${label} must be a project-relative path`)
  }
  return normalized
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)]
}

function relativeJoin(...segments: string[]): string {
  return path.posix.join(...segments.map((segment) => segment.replace(/\\/g, '/')))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function atomicWrite(file: string, content: string): void {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    fs.writeFileSync(temporary, content, 'utf8')
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function persistedVariable(variable: SystemVariableDefinition): Omit<SystemVariableDefinition, 'source' | 'owner'> {
  const { source: _source, owner: _owner, ...definition } = variable
  return definition
}

function referenceNames(key: string): string[] {
  return [
    `variables.builtin.prompts.${key}`,
    `variables.builtin.variables.${key}`,
    `builtin.prompts.${key}`,
    `builtin.variables.${key}`,
    `prompts.${key}`,
    `variables.${key}`,
  ]
}

function removeJsonDependency(value: unknown, references: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item !== 'string' || !references.has(item.trim()))
      .map((item) => removeJsonDependency(item, references))
  }
  if (!isObject(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, removeJsonDependency(item, references)]),
  )
}

function removeTemplateDependency(content: string, key: string): string {
  let next = content
  for (const reference of referenceNames(key)) {
    const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    next = next
      .replace(new RegExp(`{{\\s*${escaped}\\s*}}`, 'g'), '')
      .replace(new RegExp(`^[ \\t]*{%\\s*set\\s+[A-Za-z_][A-Za-z0-9_]*\\s*=\\s*${escaped}\\s*%}[ \\t]*(?:\\r?\\n|$)`, 'gm'), '')
  }
  return next
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${label} must be a non-empty string array`)
  }
  return unique(value.map((item) => item.trim()))
}

function optionalStringList(value: unknown, label: string): string[] {
  if (value === undefined) return []
  return stringList(value, label)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function pluginId(value: unknown): string {
  const id = requiredString(value, 'plugin name')
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) {
    throw new Error('plugin name must use lowercase letters, numbers, and hyphens, and start with a letter')
  }
  if (id === 'project' || id === 'capybara-system') {
    throw new Error(`plugin id is reserved: ${id}`)
  }
  return id
}

function fileSnapshot(files: readonly string[]): Map<string, string | undefined> {
  return new Map(files.map((file) => [file, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined]))
}

function restoreFiles(snapshot: ReadonlyMap<string, string | undefined>): void {
  for (const [file, content] of [...snapshot.entries()].reverse()) {
    if (content === undefined) fs.rmSync(file, { force: true })
    else atomicWrite(file, content)
  }
}

export interface PluginInstallResult {
  plugin: PluginResource
  installedTools: ToolPackageResource[]
  reusedTools: ToolPackageResource[]
  catalog: ResourceCatalog
}

export interface PluginCreateResult {
  plugin: PluginResource
  catalog: ResourceCatalog
}

export interface PluginInstallPreview {
  plugin: {
    id: string
    name: string
    description: string
    version: string
    source: string
  }
  tools: Array<{
    package: string
    requestedVersion: string
    resolvedVersion?: string
    action: 'reuse' | 'install' | 'missing' | 'conflict'
    permissions: string[]
  }>
  valid: boolean
}

export interface PluginUninstallResult {
  removedPlugin: { id: string; trashPath: string }
  orphanedTools: ToolPackageResource[]
  catalog: ResourceCatalog
}

export interface ToolUninstallResult {
  removedTool: { package: string; trashPath: string }
  catalog: ResourceCatalog
}

export interface PluginEnableResult {
  plugin: PluginResource
  catalog: ResourceCatalog
}

export interface PluginVariableMutationResult {
  plugin: PluginResource
  catalog: ResourceCatalog
}

export interface PluginResourceMutationResult {
  plugin: PluginResource
  catalog: ResourceCatalog
}

type PluginHarnessCreateInput = {
  catalogRevision: string
  name: string
  description: string
  type: HarnessType
  activation: Record<string, unknown>
  inputs: string[]
  requiredTools: string[]
  content: string
}

type PluginResourceEditInput = {
  catalogRevision: string
  entryRevision: string
  content: string
}

type PluginHookCreateInput = {
  catalogRevision: string
  name: string
  mode: 'runtime' | 'training'
  content: string
}

type PluginResourceDeleteInput = {
  catalogRevision: string
  entryRevision: string
}

export class PluginMutationService {
  readonly projectDir: string
  private readonly resources: ProjectResources
  private readonly plugins: PluginRegistry

  constructor(projectDir: string) {
    this.projectDir = path.resolve(projectDir)
    this.resources = new ProjectResources(this.projectDir)
    this.plugins = new PluginRegistry(this.projectDir)
  }

  create(nameValue: unknown): Promise<PluginCreateResult> {
    return enqueueProjectWrite(this.projectDir, async () => {
      const id = pluginId(nameValue)
      const targetRelative = `plugins/${id}`
      const targetDir = path.resolve(this.projectDir, targetRelative)
      if (!inside(path.resolve(this.projectDir, 'plugins'), targetDir)) {
        throw new Error(`plugin target path is invalid: ${id}`)
      }
      if (fs.existsSync(targetDir)) throw new Error(`plugin already exists: ${id}`)

      const before = this.resources.readSettings()
      if (before.plugins.some((plugin) => plugin.id === id)) {
        throw new Error(`plugin is already configured: ${id}`)
      }
      const stagingDir = path.resolve(
        this.projectDir,
        '.capybara',
        'staging',
        `plugin-create-${randomUUID()}`,
      )
      let created = false
      try {
        const stagedPlugin = path.join(stagingDir, id)
        fs.mkdirSync(path.join(stagedPlugin, 'harnesses'), { recursive: true })
        fs.mkdirSync(path.join(stagedPlugin, 'hooks'), { recursive: true })
        fs.mkdirSync(path.join(stagedPlugin, 'training-hooks'), { recursive: true })
        fs.mkdirSync(path.join(stagedPlugin, 'templates', 'variables'), { recursive: true })
        atomicWrite(path.join(stagedPlugin, pluginManifestFile()), `${JSON.stringify({
          schemaVersion: 1,
          id,
          name: id,
          description: `Local ${id} plugin.`,
          version: '1.0.0',
          resources: {
            variables: 'variables.json',
            harnesses: [],
            hooks: ['hooks'],
            trainingHooks: ['training-hooks'],
          },
          toolDependencies: [],
        }, null, 2)}\n`)
        atomicWrite(path.join(stagedPlugin, 'variables.json'), `${JSON.stringify({
          version: 1,
          variables: [],
        }, null, 2)}\n`)

        fs.mkdirSync(path.dirname(targetDir), { recursive: true })
        fs.renameSync(stagedPlugin, targetDir)
        created = true
        this.resources.saveSettings({
          ...before,
          resource_format: 2,
          plugins: [...before.plugins, { id, path: targetRelative, enabled: true }],
        })

        const catalog = new ProjectResourceRegistry(this.projectDir).list()
        const plugin = catalog.plugins.find((item) => item.id === id)
        if (!plugin) throw new Error(`created plugin was not present in the compiled resource graph: ${id}`)
        if (plugin.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
          throw new Error(plugin.diagnostics.map((diagnostic) => diagnostic.message).join('; '))
        }
        this.writeLock(catalog)
        return { plugin, catalog }
      } catch (error) {
        this.resources.saveSettings(before)
        if (created) fs.rmSync(targetDir, { recursive: true, force: true })
        throw error
      } finally {
        fs.rmSync(stagingDir, { recursive: true, force: true })
      }
    })
  }

  preview(sourceValue: unknown): PluginInstallPreview {
    const source = normalizeRelative(sourceValue, 'plugin source')
    const sourceDir = path.resolve(this.projectDir, source)
    if (!inside(this.projectDir, sourceDir) || !fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      throw new Error(`plugin source directory was not found: ${source}`)
    }
    const manifest = this.plugins.readManifest(relativeJoin(source, pluginManifestFile()))
    if (manifest.id === 'project' || manifest.id === 'capybara-system') {
      throw new Error(`plugin id is reserved: ${manifest.id}`)
    }
    if (fs.existsSync(path.resolve(this.projectDir, 'plugins', manifest.id))) {
      throw new Error(`plugin is already installed: ${manifest.id}`)
    }
    const settings = this.resources.readSettings()
    const installedRegistry = new ToolRegistry(this.projectDir)
    installedRegistry.load(settings.tools)
    const installedByPackage = new Map<string, ReturnType<ToolRegistry['list']>>()
    for (const tool of installedRegistry.list()) {
      installedByPackage.set(tool.packageName, [...(installedByPackage.get(tool.packageName) ?? []), tool])
    }
    const tools = (manifest.toolDependencies ?? []).map((dependency) => {
      const requestedVersion = dependency.version ?? '*'
      const installed = installedByPackage.get(dependency.package)
      if (installed?.length) {
        const installedVersion = installed[0]?.packageVersion ?? ''
        return {
          package: dependency.package,
          requestedVersion,
          resolvedVersion: installedVersion,
          action: satisfiesToolVersion(installedVersion, requestedVersion)
            ? 'reuse' as const
            : 'conflict' as const,
          permissions: unique(installed.flatMap((tool) => tool.permissions)),
        }
      }
      if (!dependency.bundled) {
        return {
          package: dependency.package,
          requestedVersion,
          action: 'missing' as const,
          permissions: [],
        }
      }
      const bundledManifest = relativeJoin(source, dependency.bundled, 'manifest.json')
      const registry = new ToolRegistry(this.projectDir)
      registry.load([bundledManifest])
      const definitions = registry.list()
      const bundled = definitions[0]
      if (!bundled || definitions.some((tool) => tool.packageName !== dependency.package)) {
        throw new Error(`bundled tool package does not match dependency: ${dependency.package}`)
      }
      return {
        package: dependency.package,
        requestedVersion,
        resolvedVersion: bundled.packageVersion,
        action: satisfiesToolVersion(bundled.packageVersion, requestedVersion)
          ? 'install' as const
          : 'conflict' as const,
        permissions: unique(definitions.flatMap((tool) => tool.permissions)),
      }
    })
    return {
      plugin: {
        id: manifest.id,
        name: manifest.name,
        description: manifest.description ?? '',
        version: manifest.version,
        source,
      },
      tools,
      valid: tools.every((tool) => tool.action === 'reuse' || tool.action === 'install'),
    }
  }

  install(sourceValue: unknown): Promise<PluginInstallResult> {
    return enqueueProjectWrite(this.projectDir, async () => {
      const source = normalizeRelative(sourceValue, 'plugin source')
      const sourceDir = path.resolve(this.projectDir, source)
      if (!inside(this.projectDir, sourceDir) || !fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
        throw new Error(`plugin source directory was not found: ${source}`)
      }
      const manifest = this.plugins.readManifest(relativeJoin(source, pluginManifestFile()))
      if (manifest.id === 'project' || manifest.id === 'capybara-system') {
        throw new Error(`plugin id is reserved: ${manifest.id}`)
      }
      const targetRelative = `plugins/${manifest.id}`
      const targetDir = path.resolve(this.projectDir, targetRelative)
      if (fs.existsSync(targetDir)) throw new Error(`plugin is already installed: ${manifest.id}`)

      const before = this.resources.readSettings()
      const installedRegistry = new ToolRegistry(this.projectDir)
      installedRegistry.load(before.tools)
      const installedByPackage = new Map<string, ReturnType<ToolRegistry['list']>>()
      for (const tool of installedRegistry.list()) {
        installedByPackage.set(tool.packageName, [...(installedByPackage.get(tool.packageName) ?? []), tool])
      }
      const toolPlans: Array<{
        package: string
        sourceDir: string
        destinationDir: string
        manifestPath: string
      }> = []
      const reusedPackages: string[] = []
      const dependencyPermissions = new Set<string>()

      for (const dependency of manifest.toolDependencies ?? []) {
        const requested = dependency.version ?? '*'
        const installed = installedByPackage.get(dependency.package)
        if (installed?.length) {
          const installedVersion = installed[0]?.packageVersion ?? ''
          if (!satisfiesToolVersion(installedVersion, requested)) {
            throw new Error(
              `tool dependency conflict: ${dependency.package} requires ${requested}, installed ${installedVersion}`,
            )
          }
          installed.flatMap((tool) => tool.permissions).forEach((permission) => dependencyPermissions.add(permission))
          reusedPackages.push(dependency.package)
          continue
        }
        if (!dependency.bundled) {
          throw new Error(`plugin requires missing tool package without a bundled source: ${dependency.package}`)
        }
        const bundledDir = path.resolve(sourceDir, dependency.bundled)
        if (!inside(sourceDir, bundledDir) || !fs.existsSync(bundledDir) || !fs.statSync(bundledDir).isDirectory()) {
          throw new Error(`bundled tool directory was not found: ${dependency.bundled}`)
        }
        const bundledManifest = relativeJoin(source, dependency.bundled, 'manifest.json')
        const validationRegistry = new ToolRegistry(this.projectDir)
        validationRegistry.load([bundledManifest])
        const bundledTools = validationRegistry.list()
        const bundled = bundledTools[0]
        if (!bundled || bundledTools.some((tool) => tool.packageName !== dependency.package)) {
          throw new Error(`bundled tool package does not match dependency: ${dependency.package}`)
        }
        if (!satisfiesToolVersion(bundled.packageVersion, requested)) {
          throw new Error(
            `bundled tool dependency conflict: ${dependency.package} requires ${requested}, bundled ${bundled.packageVersion}`,
          )
        }
        bundledTools.flatMap((tool) => tool.permissions)
          .forEach((permission) => dependencyPermissions.add(permission))
        const destinationDir = path.resolve(this.projectDir, 'tools', dependency.package)
        if (fs.existsSync(destinationDir)) {
          throw new Error(`tool destination already exists but is not registered: tools/${dependency.package}`)
        }
        toolPlans.push({
          package: dependency.package,
          sourceDir: bundledDir,
          destinationDir,
          manifestPath: `tools/${dependency.package}/manifest.json`,
        })
      }

      const created: string[] = []
      const stagingDir = path.resolve(
        this.projectDir,
        '.capybara',
        'staging',
        `plugin-install-${randomUUID()}`,
      )
      try {
        const stagedTools = toolPlans.map((plan) => {
          const staged = path.join(stagingDir, 'tools', plan.package)
          fs.mkdirSync(path.dirname(staged), { recursive: true })
          fs.cpSync(plan.sourceDir, staged, { recursive: true, errorOnExist: true })
          return { plan, staged }
        })
        const stagedPlugin = path.join(stagingDir, 'plugin')
        fs.mkdirSync(path.dirname(stagedPlugin), { recursive: true })
        fs.cpSync(sourceDir, stagedPlugin, { recursive: true, errorOnExist: true })

        for (const { plan, staged } of stagedTools) {
          fs.mkdirSync(path.dirname(plan.destinationDir), { recursive: true })
          fs.renameSync(staged, plan.destinationDir)
          created.push(plan.destinationDir)
        }
        fs.mkdirSync(path.dirname(targetDir), { recursive: true })
        fs.renameSync(stagedPlugin, targetDir)
        created.push(targetDir)

        const pluginHarnesses = (manifest.resources?.harnesses ?? []).map(
          (entry) => relativeJoin(targetRelative, entry),
        )
        const next: ProjectSettings = {
          ...before,
          resource_format: 2,
          tools: unique([...before.tools, ...toolPlans.map((plan) => plan.manifestPath)]),
          harnesses: unique([...before.harnesses, ...pluginHarnesses]),
          tool_permissions: unique([...before.tool_permissions, ...dependencyPermissions]),
          plugins: [
            ...before.plugins.filter((plugin) => plugin.id !== manifest.id),
            { id: manifest.id, path: targetRelative, enabled: true },
          ],
        }
        this.resources.saveSettings(next)
        const catalog = new ProjectResourceRegistry(this.projectDir).list()
        const plugin = catalog.plugins.find((item) => item.id === manifest.id)
        if (!plugin) throw new Error(`installed plugin was not present in the compiled resource graph: ${manifest.id}`)
        if (plugin.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
          throw new Error(plugin.diagnostics.map((diagnostic) => diagnostic.message).join('; '))
        }
        this.writeLock(catalog)
        return {
          plugin,
          installedTools: catalog.toolPackages.filter((tool) => toolPlans.some((plan) => plan.package === tool.package)),
          reusedTools: catalog.toolPackages.filter((tool) => reusedPackages.includes(tool.package)),
          catalog,
        }
      } catch (error) {
        this.resources.saveSettings(before)
        for (const createdPath of created.reverse()) fs.rmSync(createdPath, { recursive: true, force: true })
        throw error
      } finally {
        fs.rmSync(stagingDir, { recursive: true, force: true })
      }
    })
  }

  saveVariables(
    pluginId: string,
    value: unknown,
  ): Promise<PluginVariableMutationResult> {
    return enqueueProjectWrite(this.projectDir, async () => {
      if (!isObject(value) || !Array.isArray(value.variables) || typeof value.catalogRevision !== 'string') {
        throw new Error('plugin variable update requires variables and catalogRevision')
      }
      const beforeCatalog = new ProjectResourceRegistry(this.projectDir).list()
      if (beforeCatalog.revision !== value.catalogRevision) {
        throw new Error('plugin resources changed on disk; reload before saving variables')
      }
      const plugin = beforeCatalog.plugins.find((item) => item.id === pluginId)
      if (!plugin) throw new Error(`plugin was not found: ${pluginId}`)
      if (plugin.ownerKind === 'system') throw new Error('system plugin variables cannot be edited')

      const validated = this.resources.validateSystemVariables({ version: 1, variables: value.variables })
      const variables = validated.variables.map((variable) => ({
        ...variable,
        readonly: false,
        source: plugin.ownerKind === 'project' ? 'project' as const : 'plugin' as const,
        owner: plugin.id,
      }))

      if (plugin.ownerKind === 'project') {
        if (variables.some((variable) => variable.template)) {
          throw new Error('external variable templates are currently supported for installed plugins only')
        }
        const current = this.resources.readSystemVariables()
        const preserved = current.variables.filter((variable) => variable.readonly || variable.source === 'builtin')
        this.resources.saveSystemVariables({ version: 1, variables: [...preserved, ...variables] })
        const catalog = new ProjectResourceRegistry(this.projectDir).list()
        const saved = catalog.plugins.find((item) => item.id === pluginId)
        if (!saved) throw new Error(`saved plugin was not found: ${pluginId}`)
        return { plugin: saved, catalog }
      }

      const sourceDir = path.resolve(this.projectDir, plugin.source)
      const manifestFile = path.resolve(this.projectDir, plugin.manifestPath ?? '')
      if (!inside(path.resolve(this.projectDir, 'plugins'), sourceDir) || !inside(sourceDir, manifestFile)) {
        throw new Error(`plugin variable path is invalid: ${plugin.id}`)
      }
      const manifestContent = fs.readFileSync(manifestFile, 'utf8')
      const manifestValue = JSON.parse(manifestContent) as Record<string, unknown>
      const resourcesValue = isObject(manifestValue.resources) ? { ...manifestValue.resources } : {}
      const declared = typeof resourcesValue.variables === 'string' && resourcesValue.variables.trim()
        ? resourcesValue.variables.trim().replace(/\\/g, '/')
        : 'variables.json'
      const variablesFile = path.resolve(sourceDir, declared)
      if (!inside(sourceDir, variablesFile)) throw new Error('plugin variables resource leaves the plugin directory')
      if (fs.existsSync(variablesFile)) {
        const realFile = fs.realpathSync(variablesFile)
        if (!inside(fs.realpathSync(sourceDir), realFile)) {
          throw new Error('plugin variables resource symlink leaves the plugin directory')
        }
      }
      const externalTemplates = new Map<string, string>()
      const persistedVariables = variables.map((variable) => {
        if (!variable.template) return persistedVariable(variable)
        if (variable.type !== 'prompt_template') {
          throw new Error(`variable ${variable.key} template is only supported for prompt_template variables`)
        }
        if (typeof variable.value !== 'string') {
          throw new Error(`variable ${variable.key} template content must be a string`)
        }
        const template = normalizeSystemPromptVariableTemplatePath(variable.template, `variable ${variable.key} template`)
        const target = path.resolve(sourceDir, template)
        if (!inside(sourceDir, target)) throw new Error(`variable ${variable.key} template leaves the plugin directory`)
        if (fs.existsSync(target)) {
          const realTarget = fs.realpathSync(target)
          if (!inside(fs.realpathSync(sourceDir), realTarget)) {
            throw new Error(`variable ${variable.key} template symlink leaves the plugin directory`)
          }
        }
        if (externalTemplates.has(target)) throw new Error(`duplicate external variable template: ${template}`)
        externalTemplates.set(target, variable.value)
        return { ...persistedVariable(variable), template, value: '' }
      })
      const variableContent = `${JSON.stringify({
        version: 1,
        variables: persistedVariables,
      }, null, 2)}\n`
      const snapshot = fileSnapshot([
        manifestFile,
        variablesFile,
        ...externalTemplates.keys(),
      ])

      try {
        for (const [templateFile, templateContent] of externalTemplates) atomicWrite(templateFile, templateContent)
        atomicWrite(variablesFile, variableContent)
        if (resourcesValue.variables !== declared) {
          resourcesValue.variables = declared
          manifestValue.resources = resourcesValue
          atomicWrite(manifestFile, `${JSON.stringify(manifestValue, null, 2)}\n`)
        }
        this.plugins.effectiveSystemVariablesState()
        const catalog = new ProjectResourceRegistry(this.projectDir).list()
        const saved = catalog.plugins.find((item) => item.id === pluginId)
        if (!saved) throw new Error(`saved plugin was not found: ${pluginId}`)
        return { plugin: saved, catalog }
      } catch (error) {
        restoreFiles(snapshot)
        throw error
      }
    })
  }

  removeVariableDependency(
    pluginId: string,
    variableKey: string,
    value: unknown,
  ): Promise<PluginVariableMutationResult> {
    return enqueueProjectWrite(this.projectDir, async () => {
      if (!isObject(value) || typeof value.catalogRevision !== 'string') {
        throw new Error('dependency removal requires catalogRevision')
      }
      const beforeCatalog = new ProjectResourceRegistry(this.projectDir).list()
      if (beforeCatalog.revision !== value.catalogRevision) {
        throw new Error('plugin resources changed on disk; reload before removing the dependency')
      }
      const plugin = beforeCatalog.plugins.find((item) => item.id === pluginId)
      if (!plugin) throw new Error(`plugin was not found: ${pluginId}`)
      const dependency = plugin.variableDependencies.find((item) => item.variable.key === variableKey)
      if (!dependency) throw new Error(`plugin variable dependency was not found: ${variableKey}`)

      const plans = dependency.references.map((reference) => {
        const file = path.resolve(this.projectDir, reference.path)
        if (!inside(this.projectDir, file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          throw new Error(`plugin variable dependency source was not found: ${reference.path}`)
        }
        const original = fs.readFileSync(file, 'utf8')
        let content: string
        if (path.extname(file).toLowerCase() === '.json') {
          content = `${JSON.stringify(
            removeJsonDependency(JSON.parse(original), new Set(referenceNames(variableKey))),
            null,
            2,
          )}\n`
        } else {
          content = removeTemplateDependency(original, variableKey)
        }
        if (variableReferenceCount(content, variableKey) > 0) {
          throw new Error(
            `dependency ${variableKey} is embedded in ${reference.path}; edit that resource before removing it`,
          )
        }
        return { file, original, content }
      })
      if (plans.every((plan) => plan.original === plan.content)) {
        throw new Error(`dependency ${variableKey} could not be removed automatically`)
      }

      try {
        for (const plan of plans) atomicWrite(plan.file, plan.content)
        const catalog = new ProjectResourceRegistry(this.projectDir).list()
        const saved = catalog.plugins.find((item) => item.id === pluginId)
        if (!saved) throw new Error(`saved plugin was not found: ${pluginId}`)
        if (saved.variableDependencies.some((item) => item.variable.key === variableKey)) {
          throw new Error(`dependency ${variableKey} is still referenced by the plugin`)
        }
        return { plugin: saved, catalog }
      } catch (error) {
        for (const plan of plans) atomicWrite(plan.file, plan.original)
        throw error
      }
    })
  }

  createHarness(pluginId: string, value: unknown): Promise<PluginResourceMutationResult> {
    return enqueueProjectWrite(this.projectDir, async () => {
      const input = this.harnessCreateInput(value)
      const beforeCatalog = new ProjectResourceRegistry(this.projectDir).list()
      const context = this.editablePlugin(beforeCatalog, pluginId, input.catalogRevision)
      const expectedId = `${context.plugin.id}:${input.name}`
      if (beforeCatalog.items.some((item) => (
        item.kind === 'harness' && item.harnesses.some((harness) => harness.id === expectedId)
      ))) {
        throw new Error(`Harness resource already exists: ${expectedId}`)
      }

      const declared = this.declaredResources(context.manifest, 'harnesses')
      const manifestRelative = declared[0] ?? 'harnesses/manifest.json'
      const manifestFile = this.pluginResourceFile(context, manifestRelative, 'harness manifest')
      const entryRelative = relativeJoin(path.posix.dirname(manifestRelative), `${input.name}.j2`)
      const entryFile = this.pluginResourceFile(context, entryRelative, 'harness entry')
      if (fs.existsSync(entryFile)) throw new Error(`Harness entry already exists: ${entryRelative}`)

      let harnessManifest: { version: 1; package: string; harnesses: ProjectHarnessDefinition[] }
      if (fs.existsSync(manifestFile)) {
        const existing = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as unknown
        if (!isObject(existing) || !Array.isArray(existing.harnesses) || typeof existing.package !== 'string') {
          throw new Error(`invalid harness manifest: ${manifestRelative}`)
        }
        harnessManifest = existing as { version: 1; package: string; harnesses: ProjectHarnessDefinition[] }
      } else {
        harnessManifest = { version: 1, package: context.plugin.id, harnesses: [] }
      }
      if (harnessManifest.harnesses.some((harness) => harness.name === input.name)) {
        throw new Error(`Harness resource already exists: ${input.name}`)
      }
      const definition: ProjectHarnessDefinition = {
        name: input.name,
        description: input.description,
        type: input.type,
        entry: path.posix.basename(entryRelative),
        activation: input.activation as ProjectHarnessDefinition['activation'],
        inputs: input.inputs,
        requiredTools: input.requiredTools,
      }
      harnessManifest.harnesses.push(definition)
      context.resources.harnesses = unique([...declared, manifestRelative])
      context.manifest.resources = context.resources

      const snapshot = fileSnapshot([context.manifestFile, manifestFile, entryFile])
      try {
        atomicWrite(entryFile, input.content)
        atomicWrite(manifestFile, `${JSON.stringify(harnessManifest, null, 2)}\n`)
        atomicWrite(context.manifestFile, `${JSON.stringify(context.manifest, null, 2)}\n`)
        return this.finishedResourceMutation(context.plugin, new ProjectResourceRegistry(this.projectDir).list())
      } catch (error) {
        restoreFiles(snapshot)
        throw error
      }
    })
  }

  saveHarness(pluginId: string, harnessId: string, value: unknown): Promise<PluginResourceMutationResult> {
    return enqueueProjectWrite(this.projectDir, async () => {
      const input = this.resourceEditInput(value, 'harness')
      const beforeCatalog = new ProjectResourceRegistry(this.projectDir).list()
      const context = this.editablePlugin(beforeCatalog, pluginId, input.catalogRevision)
      const harness = this.pluginHarness(beforeCatalog, context.plugin, harnessId)
      if (harness.entryRevision !== input.entryRevision) throw new Error('HARNESS_REVISION_CONFLICT')
      const entryFile = this.catalogResourceFile(context, harness.entry, 'harness entry')
      const snapshot = fileSnapshot([entryFile])
      try {
        atomicWrite(entryFile, input.content)
        return this.finishedResourceMutation(context.plugin, new ProjectResourceRegistry(this.projectDir).list())
      } catch (error) {
        restoreFiles(snapshot)
        throw error
      }
    })
  }

  deleteHarness(pluginId: string, harnessId: string, value: unknown): Promise<PluginResourceMutationResult> {
    return enqueueProjectWrite(this.projectDir, async () => {
      const input = this.resourceDeleteInput(value, 'harness')
      const beforeCatalog = new ProjectResourceRegistry(this.projectDir).list()
      const context = this.editablePlugin(beforeCatalog, pluginId, input.catalogRevision)
      const harness = this.pluginHarness(beforeCatalog, context.plugin, harnessId)
      if (harness.entryRevision !== input.entryRevision) throw new Error('HARNESS_REVISION_CONFLICT')
      const module = this.pluginModule(beforeCatalog, context.plugin, 'harness', harnessId)
      const manifestFile = this.catalogResourceFile(context, module.source, 'harness manifest')
      const declared = this.declaredResources(context.manifest, 'harnesses')
      const manifestRelative = declared.find((entry) => this.pluginResourceFile(context, entry, 'harness manifest') === manifestFile)
      if (!manifestRelative) throw new Error('Harness manifest is not declared by the plugin')
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { harnesses?: ProjectHarnessDefinition[] }
      if (!Array.isArray(manifest.harnesses)) throw new Error(`invalid harness manifest: ${manifestRelative}`)
      const remaining = manifest.harnesses.filter((definition) => definition.name !== harness.name)
      if (remaining.length === manifest.harnesses.length) throw new Error('Harness resource was not found in its manifest')
      const entryFile = this.catalogResourceFile(context, harness.entry, 'harness entry')
      const entryStillUsed = remaining.some((definition) => (
        this.pluginResourceFile(context, relativeJoin(path.posix.dirname(manifestRelative), definition.entry), 'harness entry')
          === entryFile
      ))
      if (remaining.length > 0) manifest.harnesses = remaining
      else {
        context.resources.harnesses = declared.filter((entry) => entry !== manifestRelative)
        context.manifest.resources = context.resources
      }
      const snapshot = fileSnapshot([context.manifestFile, manifestFile, entryFile])
      try {
        if (remaining.length > 0) atomicWrite(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
        else fs.rmSync(manifestFile, { force: true })
        if (!entryStillUsed) fs.rmSync(entryFile, { force: true })
        if (remaining.length === 0) atomicWrite(context.manifestFile, `${JSON.stringify(context.manifest, null, 2)}\n`)
        return this.finishedResourceMutation(context.plugin, new ProjectResourceRegistry(this.projectDir).list())
      } catch (error) {
        restoreFiles(snapshot)
        throw error
      }
    })
  }

  createHook(pluginId: string, value: unknown): Promise<PluginResourceMutationResult> {
    return enqueueProjectWrite(this.projectDir, async () => {
      const input = this.hookCreateInput(value)
      const beforeCatalog = new ProjectResourceRegistry(this.projectDir).list()
      const context = this.editablePlugin(beforeCatalog, pluginId, input.catalogRevision)
      const expectedId = context.plugin.ownerKind === 'installed' ? `${context.plugin.id}:${input.name}` : input.name
      if (beforeCatalog.items.some((item) => (
        item.kind === 'hook' && item.hooks.some((hook) => hook.id === expectedId && hook.mode === input.mode)
      ))) {
        throw new Error(`Hook resource already exists: ${expectedId}`)
      }
      const resourceKey = input.mode === 'runtime' ? 'hooks' : 'trainingHooks'
      const declared = this.declaredResources(context.manifest, resourceKey)
      const defaultDirectory = input.mode === 'runtime' ? 'hooks' : 'training-hooks'
      const directory = declared.find((entry) => {
        const candidate = this.pluginResourceFile(context, entry, 'Hook source')
        return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()
      }) ?? declared.find((entry) => !entry.endsWith('.ts')) ?? defaultDirectory
      const entryRelative = relativeJoin(directory, `${input.name}.ts`)
      const entryFile = this.pluginResourceFile(context, entryRelative, 'Hook entry')
      if (fs.existsSync(entryFile)) throw new Error(`Hook entry already exists: ${entryRelative}`)
      new HookRegistry(this.projectDir).validateExternalContent(entryFile, input.content, {
        ownerId: context.plugin.id,
        ownerKind: context.plugin.ownerKind,
        mode: input.mode,
      })
      context.resources[resourceKey] = unique([...declared, directory])
      context.manifest.resources = context.resources
      const snapshot = fileSnapshot([context.manifestFile, entryFile])
      try {
        atomicWrite(entryFile, input.content)
        atomicWrite(context.manifestFile, `${JSON.stringify(context.manifest, null, 2)}\n`)
        return this.finishedResourceMutation(context.plugin, new ProjectResourceRegistry(this.projectDir).list())
      } catch (error) {
        restoreFiles(snapshot)
        throw error
      }
    })
  }

  saveHook(pluginId: string, hookId: string, value: unknown): Promise<PluginResourceMutationResult> {
    return enqueueProjectWrite(this.projectDir, async () => {
      const input = this.resourceEditInput(value, 'Hook')
      const beforeCatalog = new ProjectResourceRegistry(this.projectDir).list()
      const context = this.editablePlugin(beforeCatalog, pluginId, input.catalogRevision)
      const hook = this.pluginHook(beforeCatalog, context.plugin, hookId)
      if (hook.entryRevision !== input.entryRevision) throw new Error('HOOK_REVISION_CONFLICT')
      const entryFile = this.catalogResourceFile(context, hook.entry, 'Hook entry')
      new HookRegistry(this.projectDir).validateExternalContent(entryFile, input.content, {
        ownerId: context.plugin.id,
        ownerKind: context.plugin.ownerKind,
        mode: hook.mode,
      })
      const snapshot = fileSnapshot([entryFile])
      try {
        atomicWrite(entryFile, input.content)
        return this.finishedResourceMutation(context.plugin, new ProjectResourceRegistry(this.projectDir).list())
      } catch (error) {
        restoreFiles(snapshot)
        throw error
      }
    })
  }

  deleteHook(pluginId: string, hookId: string, value: unknown): Promise<PluginResourceMutationResult> {
    return enqueueProjectWrite(this.projectDir, async () => {
      const input = this.resourceDeleteInput(value, 'Hook')
      const beforeCatalog = new ProjectResourceRegistry(this.projectDir).list()
      const context = this.editablePlugin(beforeCatalog, pluginId, input.catalogRevision)
      const hook = this.pluginHook(beforeCatalog, context.plugin, hookId)
      if (hook.entryRevision !== input.entryRevision) throw new Error('HOOK_REVISION_CONFLICT')
      const entryFile = this.catalogResourceFile(context, hook.entry, 'Hook entry')
      const resourceKey = hook.mode === 'runtime' ? 'hooks' : 'trainingHooks'
      const declared = this.declaredResources(context.manifest, resourceKey)
      const directEntry = declared.find((entry) => this.pluginResourceFile(context, entry, 'Hook source') === entryFile)
      if (directEntry) {
        context.resources[resourceKey] = declared.filter((entry) => entry !== directEntry)
        context.manifest.resources = context.resources
      }
      const snapshot = fileSnapshot([context.manifestFile, entryFile])
      try {
        fs.rmSync(entryFile, { force: true })
        if (directEntry) atomicWrite(context.manifestFile, `${JSON.stringify(context.manifest, null, 2)}\n`)
        return this.finishedResourceMutation(context.plugin, new ProjectResourceRegistry(this.projectDir).list())
      } catch (error) {
        restoreFiles(snapshot)
        throw error
      }
    })
  }

  uninstall(pluginId: string): Promise<PluginUninstallResult> {
    return enqueueProjectWrite(this.projectDir, async () => {
      const beforeSettings = this.resources.readSettings()
      const beforeCatalog = new ProjectResourceRegistry(this.projectDir).list()
      const plugin = beforeCatalog.plugins.find((item) => item.id === pluginId)
      if (!plugin) throw new Error(`plugin was not found: ${pluginId}`)
      if (!plugin.uninstallable || plugin.ownerKind !== 'installed') {
        throw new Error(`plugin cannot be uninstalled: ${pluginId}`)
      }
      const sourceDir = path.resolve(this.projectDir, plugin.source)
      if (!inside(path.resolve(this.projectDir, 'plugins'), sourceDir)) {
        throw new Error(`plugin installation path is invalid: ${plugin.source}`)
      }
      const trashRelative = `.capybara/trash/plugins/${Date.now()}-${randomUUID()}-${pluginId}`
      const trashDir = path.resolve(this.projectDir, trashRelative)
      fs.mkdirSync(path.dirname(trashDir), { recursive: true })
      let moved = false
      try {
        const sourcePrefix = `${plugin.source.replace(/\/$/, '')}/`
        this.resources.saveSettings({
          ...beforeSettings,
          plugins: beforeSettings.plugins.filter((item) => item.id !== pluginId),
          harnesses: beforeSettings.harnesses.filter((entry) => !entry.replace(/\\/g, '/').startsWith(sourcePrefix)),
        })
        fs.renameSync(sourceDir, trashDir)
        moved = true
        const catalog = new ProjectResourceRegistry(this.projectDir).list()
        const removedDependencies = new Set(plugin.toolDependencies.map((dependency) => dependency.package))
        const orphanedTools = catalog.toolPackages.filter(
          (tool) => removedDependencies.has(tool.package) && tool.requiredBy.length === 0,
        )
        this.writeLock(catalog)
        return {
          removedPlugin: { id: pluginId, trashPath: trashRelative },
          orphanedTools,
          catalog,
        }
      } catch (error) {
        if (moved && fs.existsSync(trashDir)) fs.renameSync(trashDir, sourceDir)
        this.resources.saveSettings(beforeSettings)
        throw error
      }
    })
  }

  setEnabled(pluginId: string, enabledValue: unknown): Promise<PluginEnableResult> {
    return enqueueProjectWrite(this.projectDir, async () => {
      if (typeof enabledValue !== 'boolean') throw new Error('plugin enabled must be a boolean')
      const before = this.resources.readSettings()
      const configured = before.plugins.find((plugin) => plugin.id === pluginId)
      if (!configured) throw new Error(`installed plugin was not found: ${pluginId}`)
      if (configured.enabled === enabledValue) {
        const catalog = new ProjectResourceRegistry(this.projectDir).list()
        const plugin = catalog.plugins.find((item) => item.id === pluginId)
        if (!plugin) throw new Error(`plugin was not found in resource graph: ${pluginId}`)
        return { plugin, catalog }
      }
      const candidate = {
        ...before,
        plugins: before.plugins.map((plugin) => (
          plugin.id === pluginId ? { ...plugin, enabled: enabledValue } : plugin
        )),
      }
      try {
        if (enabledValue) {
          const currentCatalog = new ProjectResourceRegistry(this.projectDir).list()
          const currentPlugin = currentCatalog.plugins.find((item) => item.id === pluginId)
          if (!currentPlugin) throw new Error(`plugin was not found in resource graph: ${pluginId}`)
          const errors = currentPlugin.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
          if (errors.length > 0) throw new Error(errors.map((diagnostic) => diagnostic.message).join('; '))
          this.plugins.effectiveSystemVariablesState(this.resources.readSystemVariables(), candidate)
        }
        this.resources.saveSettings(candidate)
        const catalog = new ProjectResourceRegistry(this.projectDir).list()
        const plugin = catalog.plugins.find((item) => item.id === pluginId)
        if (!plugin) throw new Error(`plugin was not found in resource graph: ${pluginId}`)
        if (enabledValue) {
          const errors = plugin.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
          if (errors.length > 0) throw new Error(errors.map((diagnostic) => diagnostic.message).join('; '))
          this.plugins.effectiveSystemVariablesState()
        }
        this.writeLock(catalog)
        return { plugin, catalog }
      } catch (error) {
        this.resources.saveSettings(before)
        throw error
      }
    })
  }

  uninstallTool(packageName: string): Promise<ToolUninstallResult> {
    return enqueueProjectWrite(this.projectDir, async () => {
      const beforeSettings = this.resources.readSettings()
      const beforeCatalog = new ProjectResourceRegistry(this.projectDir).list()
      const tool = beforeCatalog.toolPackages.find((item) => item.package === packageName)
      if (!tool) throw new Error(`tool package was not found: ${packageName}`)
      if (tool.requiredBy.length > 0) {
        throw new Error(
          `tool package is required by installed plugins: ${tool.requiredBy.map((plugin) => plugin.pluginId).join(', ')}`,
        )
      }
      if (!tool.uninstallable) throw new Error(`tool package cannot be uninstalled: ${packageName}`)
      const toolDir = path.dirname(path.resolve(this.projectDir, tool.manifestPath))
      const toolsRoot = path.resolve(this.projectDir, 'tools')
      if (toolDir === toolsRoot || !inside(toolsRoot, toolDir)) {
        throw new Error(`tool installation path is invalid: ${tool.manifestPath}`)
      }
      const trashRelative = `.capybara/trash/tools/${Date.now()}-${randomUUID()}-${packageName}`
      const trashDir = path.resolve(this.projectDir, trashRelative)
      fs.mkdirSync(path.dirname(trashDir), { recursive: true })
      let moved = false
      try {
        this.resources.saveSettings({
          ...beforeSettings,
          tools: beforeSettings.tools.filter((entry) => entry.replace(/\\/g, '/') !== tool.manifestPath),
        })
        fs.renameSync(toolDir, trashDir)
        moved = true
        const catalog = new ProjectResourceRegistry(this.projectDir).list()
        this.writeLock(catalog)
        return {
          removedTool: { package: packageName, trashPath: trashRelative },
          catalog,
        }
      } catch (error) {
        if (moved && fs.existsSync(trashDir)) fs.renameSync(trashDir, toolDir)
        this.resources.saveSettings(beforeSettings)
        throw error
      }
    })
  }

  private harnessCreateInput(value: unknown): PluginHarnessCreateInput {
    if (!isObject(value) || typeof value.catalogRevision !== 'string') {
      throw new Error('Harness creation requires catalogRevision')
    }
    const type = value.type
    if (type !== 'model' && type !== 'tool' && type !== 'experience' && type !== 'persistent') {
      throw new Error('Harness type must be model, tool, experience, or persistent')
    }
    if (!isObject(value.activation)) throw new Error('Harness activation must be an object')
    return {
      catalogRevision: value.catalogRevision,
      name: requiredString(value.name, 'Harness name'),
      description: requiredString(value.description, 'Harness description'),
      type,
      activation: structuredClone(value.activation),
      inputs: stringList(value.inputs, 'Harness inputs'),
      requiredTools: optionalStringList(value.requiredTools, 'Harness requiredTools'),
      content: typeof value.content === 'string' ? value.content : '',
    }
  }

  private hookCreateInput(value: unknown): PluginHookCreateInput {
    if (!isObject(value) || typeof value.catalogRevision !== 'string') {
      throw new Error('Hook creation requires catalogRevision')
    }
    if (value.mode !== 'runtime' && value.mode !== 'training') {
      throw new Error('Hook mode must be runtime or training')
    }
    if (typeof value.content !== 'string') throw new Error('Hook content must be a string')
    return {
      catalogRevision: value.catalogRevision,
      name: requiredString(value.name, 'Hook name'),
      mode: value.mode,
      content: value.content,
    }
  }

  private resourceEditInput(value: unknown, label: string): PluginResourceEditInput {
    if (!isObject(value) || typeof value.catalogRevision !== 'string' || typeof value.entryRevision !== 'string') {
      throw new Error(`${label} update requires catalogRevision and entryRevision`)
    }
    if (typeof value.content !== 'string') throw new Error(`${label} content must be a string`)
    return { catalogRevision: value.catalogRevision, entryRevision: value.entryRevision, content: value.content }
  }

  private resourceDeleteInput(value: unknown, label: string): PluginResourceDeleteInput {
    if (!isObject(value) || typeof value.catalogRevision !== 'string' || typeof value.entryRevision !== 'string') {
      throw new Error(`${label} deletion requires catalogRevision and entryRevision`)
    }
    return { catalogRevision: value.catalogRevision, entryRevision: value.entryRevision }
  }

  private editablePlugin(catalog: ResourceCatalog, pluginId: string, catalogRevision: string): {
    plugin: PluginResource
    sourceDir: string
    manifestFile: string
    manifest: Record<string, unknown>
    resources: Record<string, unknown>
  } {
    if (catalog.revision !== catalogRevision) {
      throw new Error('plugin resources changed on disk; reload before saving')
    }
    const plugin = catalog.plugins.find((item) => item.id === pluginId)
    if (!plugin) throw new Error(`plugin was not found: ${pluginId}`)
    if (plugin.ownerKind === 'system') throw new Error('system plugin resources cannot be edited')
    if (!plugin.manifestPath) throw new Error(`plugin manifest was not found: ${pluginId}`)
    const sourceDir = path.resolve(this.projectDir, plugin.source)
    const manifestFile = path.resolve(this.projectDir, plugin.manifestPath)
    const projectRoot = path.resolve(this.projectDir)
    if (!inside(projectRoot, sourceDir) || !inside(sourceDir, manifestFile) || !fs.existsSync(sourceDir)) {
      throw new Error(`plugin resource path is invalid: ${plugin.id}`)
    }
    if (plugin.ownerKind === 'installed' && !inside(path.resolve(this.projectDir, 'plugins'), sourceDir)) {
      throw new Error(`plugin installation path is invalid: ${plugin.source}`)
    }
    const realSource = fs.realpathSync(sourceDir)
    if (!inside(fs.realpathSync(projectRoot), realSource)) throw new Error(`plugin source symlink leaves the project workspace: ${plugin.id}`)
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as unknown
    if (!isObject(manifest)) throw new Error(`invalid plugin manifest: ${plugin.manifestPath}`)
    const resources = isObject(manifest.resources) ? { ...manifest.resources } : {}
    return { plugin, sourceDir, manifestFile, manifest, resources }
  }

  private declaredResources(
    manifest: Record<string, unknown>,
    key: 'harnesses' | 'hooks' | 'trainingHooks',
  ): string[] {
    const resources = isObject(manifest.resources) ? manifest.resources : {}
    const value = resources[key]
    if (value === undefined) return []
    if (!Array.isArray(value)) throw new Error(`plugin resources.${key} must be an array`)
    return value.map((entry, index) => normalizeRelative(entry, `plugin resources.${key}[${index}]`))
  }

  private pluginResourceFile(
    context: ReturnType<PluginMutationService['editablePlugin']>,
    relative: string,
    label: string,
  ): string {
    const normalized = normalizeRelative(relative, label)
    const target = path.resolve(context.sourceDir, normalized)
    if (!inside(context.sourceDir, target)) throw new Error(`${label} leaves the plugin directory`)
    if (fs.existsSync(target)) {
      const realTarget = fs.realpathSync(target)
      const realSource = fs.realpathSync(context.sourceDir)
      if (!inside(realSource, realTarget)) throw new Error(`${label} symlink leaves the plugin directory`)
    }
    return target
  }

  private catalogResourceFile(
    context: ReturnType<PluginMutationService['editablePlugin']>,
    relative: string,
    label: string,
  ): string {
    const normalized = normalizeRelative(relative, label)
    const target = path.resolve(this.projectDir, normalized)
    if (!inside(context.sourceDir, target)) throw new Error(`${label} does not belong to the plugin`)
    if (fs.existsSync(target)) {
      const realTarget = fs.realpathSync(target)
      const realSource = fs.realpathSync(context.sourceDir)
      if (!inside(realSource, realTarget)) throw new Error(`${label} symlink leaves the plugin directory`)
    }
    return target
  }

  private pluginModule(
    catalog: ResourceCatalog,
    plugin: PluginResource,
    kind: ProjectResourceModule['kind'],
    resourceId: string,
  ): ProjectResourceModule {
    const modules = catalog.items.filter((item) => plugin.resourceModuleIds.includes(item.id) && item.kind === kind)
    const module = modules.find((item) => (
      item.kind === 'harness'
        ? item.harnesses.some((harness) => harness.id === resourceId)
        : item.kind === 'hook'
          ? item.hooks.some((hook) => hook.id === resourceId)
          : false
    ))
    if (!module) throw new Error(`${kind} resource was not found in plugin: ${resourceId}`)
    return module
  }

  private pluginHarness(catalog: ResourceCatalog, plugin: PluginResource, id: string): HarnessResourceDefinition {
    const module = this.pluginModule(catalog, plugin, 'harness', id)
    if (module.kind !== 'harness') throw new Error(`Harness resource was not found: ${id}`)
    const harness = module.harnesses.find((item) => item.id === id)
    if (!harness) throw new Error(`Harness resource was not found: ${id}`)
    return harness
  }

  private pluginHook(catalog: ResourceCatalog, plugin: PluginResource, id: string): HookResourceDefinition {
    const module = this.pluginModule(catalog, plugin, 'hook', id)
    if (module.kind !== 'hook') throw new Error(`Hook resource was not found: ${id}`)
    const hook = module.hooks.find((item) => item.id === id)
    if (!hook) throw new Error(`Hook resource was not found: ${id}`)
    return hook
  }

  private finishedResourceMutation(previous: PluginResource, catalog: ResourceCatalog): PluginResourceMutationResult {
    const plugin = catalog.plugins.find((item) => item.id === previous.id)
    if (!plugin) throw new Error(`saved plugin was not found: ${previous.id}`)
    const knownErrors = new Set(previous.diagnostics
      .filter((diagnostic) => diagnostic.severity === 'error')
      .map((diagnostic) => `${diagnostic.code}:${diagnostic.message}`))
    const introduced = plugin.diagnostics.find((diagnostic) => (
      diagnostic.severity === 'error' && !knownErrors.has(`${diagnostic.code}:${diagnostic.message}`)
    ))
    if (introduced) throw new Error(introduced.message)
    this.writeLock(catalog)
    return { plugin, catalog }
  }

  private writeLock(catalog: ResourceCatalog): void {
    const lockFile = path.join(this.projectDir, '.capybara', 'resource-lock.json')
    const temporary = `${lockFile}.${process.pid}.${Date.now()}.tmp`
    const value = {
      version: 1,
      generatedAt: new Date().toISOString(),
      catalogRevision: catalog.revision,
      plugins: catalog.plugins.map((plugin) => ({
        id: plugin.id,
        version: plugin.version,
        source: plugin.source,
        enabled: plugin.enabled,
      })),
      tools: catalog.toolPackages.map((tool) => ({
        package: tool.package,
        version: tool.version,
        manifestPath: tool.manifestPath,
        requiredBy: tool.requiredBy.map((plugin) => plugin.pluginId),
      })),
    }
    fs.mkdirSync(path.dirname(lockFile), { recursive: true })
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      fs.renameSync(temporary, lockFile)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }
}
