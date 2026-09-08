import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Ajv, type ValidateFunction } from 'ajv'

import {
  ProjectResources,
  systemVariablesRevision,
  type ProjectSettings,
  type SystemVariableDefinition,
  type SystemVariablesResource,
  type SystemVariablesState,
} from '#core/project-resources'
import {
  normalizeSystemPromptVariableTemplatePath,
  resolveSystemPromptVariables,
} from '#core/system-prompt-templates'
import type {
  PluginResource,
  PluginToolDependencyResource,
  PluginVariableDependencyResource,
  ProjectResourceModule,
  ResourceDiagnostic,
  ToolPackageResource,
  ToolResourceModule,
} from '#core/resources/types'
import { variableReferenceCount } from '#core/system-variable-references'

const PLUGIN_MANIFEST_FILE = 'capybara.plugin.json'
const SEMVER = '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$'

const PLUGIN_MANIFEST_SCHEMA = {
  type: 'object',
  required: ['schemaVersion', 'id', 'name', 'version'],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    id: { type: 'string', pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$' },
    name: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    version: { type: 'string', pattern: SEMVER },
    resources: {
      type: 'object',
      additionalProperties: false,
      properties: {
        variables: { type: 'string', minLength: 1 },
        harnesses: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
        hooks: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
        trainingHooks: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
      },
    },
    toolDependencies: {
      type: 'array',
      items: {
        type: 'object',
        required: ['package'],
        additionalProperties: false,
        properties: {
          package: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]*$' },
          version: { type: 'string', minLength: 1 },
          bundled: { type: 'string', minLength: 1 },
        },
      },
    },
  },
} as const

export interface PluginManifest {
  schemaVersion: 1
  id: string
  name: string
  description?: string
  version: string
  resources?: {
    variables?: string
    harnesses?: string[]
    hooks?: string[]
    trainingHooks?: string[]
  }
  toolDependencies?: Array<{
    package: string
    version?: string
    bundled?: string
  }>
}

export interface PluginGraph {
  revision: string
  plugins: PluginResource[]
  toolPackages: ToolPackageResource[]
}

export interface PluginRuntimeResources {
  pluginId: string
  ownerKind: PluginResource['ownerKind']
  enabled: boolean
  source: string
  variables?: string
  harnesses: string[]
  hooks: string[]
  trainingHooks: string[]
}

type ManifestRecord = {
  manifest: PluginManifest
  manifestPath: string
  source: string
  ownerKind: PluginResource['ownerKind']
  enabled: boolean
  uninstallable: boolean
}

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

function normalizeRelative(value: string, label: string): string {
  const normalized = value.trim().replace(/\\/g, '/')
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`${label} must be a project-relative path`)
  }
  return normalized
}

function semver(value: string): [number, number, number] | undefined {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.exec(value)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

function compareVersion(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

export function satisfiesToolVersion(installed: string, requested: string): boolean {
  const value = semver(installed)
  const constraint = requested.trim()
  if (!value || !constraint) return false
  if (constraint === '*') return true
  const operator: '^' | '~' | '>=' | '=' = constraint.startsWith('^') || constraint.startsWith('~')
    ? constraint[0] as '^' | '~'
    : constraint.startsWith('>=') ? '>=' : '='
  const expectedText = operator === '=' ? constraint : constraint.slice(operator.length)
  const expected = semver(expectedText)
  if (!expected) return false
  if (operator === '=') return compareVersion(value, expected) === 0
  if (operator === '>=') return compareVersion(value, expected) >= 0
  if (compareVersion(value, expected) < 0) return false
  if (operator === '~') return value[0] === expected[0] && value[1] === expected[1]
  if (expected[0] > 0) return value[0] === expected[0]
  if (expected[1] > 0) return value[0] === 0 && value[1] === expected[1]
  return value[0] === 0 && value[1] === 0 && value[2] === expected[2]
}

export class PluginRegistry {
  readonly projectDir: string
  private readonly projectRealDir: string
  private readonly resources: ProjectResources
  private readonly validateManifest: ValidateFunction

  constructor(projectDir: string) {
    this.projectDir = path.resolve(projectDir)
    this.projectRealDir = fs.realpathSync(this.projectDir)
    this.resources = new ProjectResources(this.projectDir)
    this.validateManifest = new Ajv({ allErrors: true, strict: false }).compile(PLUGIN_MANIFEST_SCHEMA)
  }

  compile(items: readonly ProjectResourceModule[]): PluginGraph {
    const settings = this.resources.readSettings()
    const records = this.manifestRecords(settings)
    if (records.length === 0) return { revision: '', plugins: [], toolPackages: [] }

    const toolModules = items.filter((item): item is ToolResourceModule => item.kind === 'tool')
    const duplicateToolPackage = toolModules.map((tool) => tool.package)
      .find((packageName, index, packages) => packages.indexOf(packageName) !== index)
    if (duplicateToolPackage) throw new Error(`duplicate tool package: ${duplicateToolPackage}`)
    const toolByPackage = new Map(toolModules.map((item) => [item.package, item]))
    const plugins = records.map((record) => this.pluginResource(record, items, toolByPackage))
    const toolPackages = toolModules.map((tool) => {
      const requiredBy = plugins.flatMap((plugin) => plugin.toolDependencies
        .filter((dependency) => dependency.package === tool.package)
        .map((dependency) => ({
          pluginId: plugin.id,
          pluginName: plugin.name,
          requestedVersion: dependency.version,
          enabled: plugin.enabled,
        })))
      return {
        package: tool.package,
        version: tool.packageVersion,
        manifestPath: tool.source,
        moduleId: tool.id,
        requiredBy,
        orphaned: requiredBy.length === 0,
        uninstallable: !tool.source.startsWith('.capybara/'),
      }
    }).sort((left, right) => left.package.localeCompare(right.package))
    const revision = createHash('sha256').update(JSON.stringify({ plugins, toolPackages })).digest('hex').slice(0, 16)
    return { revision, plugins, toolPackages }
  }

  runtimeResources(settings = this.resources.readSettings()): PluginRuntimeResources[] {
    return this.manifestRecords(settings).map((record) => ({
      pluginId: record.manifest.id,
      ownerKind: record.ownerKind,
      enabled: record.enabled,
      source: record.source,
      ...(record.manifest.resources?.variables
        ? { variables: this.resolveDeclaredPath(record, record.manifest.resources.variables) }
        : {}),
      harnesses: (record.manifest.resources?.harnesses ?? [])
        .map((entry) => this.resolveDeclaredPath(record, entry)),
      hooks: (record.manifest.resources?.hooks ?? [])
        .map((entry) => this.resolveDeclaredPath(record, entry)),
      trainingHooks: (record.manifest.resources?.trainingHooks ?? [])
        .map((entry) => this.resolveDeclaredPath(record, entry)),
    }))
  }

  effectiveHarnesses(settings = this.resources.readSettings()): string[] {
    const runtime = this.runtimeResources(settings)
    if (runtime.length === 0) return unique([...settings.harnesses, ...this.systemHarnesses()])
    const installedPrefixes = runtime
      .filter((plugin) => plugin.ownerKind === 'installed')
      .map((plugin) => `${plugin.source.replace(/\/$/, '')}/`)
    const configured = settings.harnesses.filter((entry) => {
      const normalized = entry.replace(/\\/g, '/')
      return !installedPrefixes.some((prefix) => normalized.startsWith(prefix))
    })
    return unique([
      ...configured,
      ...this.systemHarnesses(),
      ...runtime.filter((plugin) => plugin.enabled).flatMap((plugin) => plugin.harnesses),
    ])
  }

  catalogHarnesses(settings = this.resources.readSettings()): string[] {
    const runtime = this.runtimeResources(settings)
    if (runtime.length === 0) return unique([...settings.harnesses, ...this.systemHarnesses()])
    const installedPrefixes = runtime
      .filter((plugin) => plugin.ownerKind === 'installed')
      .map((plugin) => `${plugin.source.replace(/\/$/, '')}/`)
    const configured = settings.harnesses.filter((entry) => {
      const normalized = entry.replace(/\\/g, '/')
      return !installedPrefixes.some((prefix) => normalized.startsWith(prefix))
    })
    return unique([
      ...configured,
      ...this.systemHarnesses(),
      ...runtime.flatMap((plugin) => plugin.harnesses),
    ])
  }

  private systemHarnesses(): string[] {
    const root = path.join(this.projectDir, '.capybara', 'harnesses')
    if (!fs.existsSync(root)) return []
    const manifests: string[] = []
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) visit(absolute)
        else if (entry.isFile() && entry.name === 'manifest.json') manifests.push(this.relativePath(absolute))
      }
    }
    visit(root)
    return manifests.sort()
  }

  private relativePath(absolute: string): string {
    return path.relative(this.projectDir, absolute).replace(/\\/g, '/')
  }

  hookSources(mode: 'runtime' | 'training', settings = this.resources.readSettings()): Array<{
    pluginId: string
    ownerKind: PluginResource['ownerKind']
    enabled: boolean
    path: string
  }> {
    return this.runtimeResources(settings).flatMap((plugin) => (
      (mode === 'runtime' ? plugin.hooks : plugin.trainingHooks).map((resourcePath) => ({
        pluginId: plugin.pluginId,
        ownerKind: plugin.ownerKind,
        enabled: plugin.enabled,
        path: resourcePath,
      }))
    ))
  }

  effectiveSystemVariablesState(
    base = this.resources.readSystemVariables(),
    settings = this.resources.readSettings(),
  ): SystemVariablesState {
    const variables = base.variables.map((variable) => ({
      ...variable,
      owner: variable.source === 'builtin' || variable.readonly ? 'capybara-system' : 'project',
    }))
    const keys = new Map(variables.map((variable) => [variable.key, variable.owner ?? 'project']))
    for (const plugin of this.runtimeResources(settings)) {
      if (!plugin.enabled || plugin.ownerKind !== 'installed' || !plugin.variables) continue
      const resource = this.readVariableFile(plugin.variables, plugin.source)
      for (const variable of resource.variables) {
        if (variable.key === 'sys_message' || variable.key === 'cache') {
          throw new Error(`plugin ${plugin.pluginId} cannot register reserved variable ${variable.key}`)
        }
        const existingOwner = keys.get(variable.key)
        if (existingOwner) {
          throw new Error(
            `plugin variable conflict: ${plugin.pluginId}.${variable.key} is already registered by ${existingOwner}`,
          )
        }
        keys.set(variable.key, plugin.pluginId)
        variables.push({
          ...variable,
          // Preserve the plugin declaration. Session-scoped plugin variables
          // (for example correction_context) must be writable by runtime Hooks;
          // project-scoped variables remain protected by the mutation service.
          readonly: variable.readonly,
          source: 'plugin',
          owner: plugin.pluginId,
        })
      }
    }
    const resource: SystemVariablesResource = { version: 1, variables }
    // Validate the complete effective graph here so catalog reads and plugin
    // edits fail before an invalid external template reaches the runtime.
    resolveSystemPromptVariables(resource.variables)
    return { revision: systemVariablesRevision(resource), resource }
  }

  readManifest(relativeManifest: string): PluginManifest {
    const normalized = normalizeRelative(relativeManifest, 'plugin manifest path')
    const manifestFile = this.resolveProjectFile(normalized, 'plugin manifest')
    const value: unknown = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    if (!this.validateManifest(value)) {
      throw new Error(`invalid plugin manifest ${normalized}: ${schemaError(this.validateManifest)}`)
    }
    const manifest = structuredClone(value) as PluginManifest
    if (manifest.resources?.variables) {
      manifest.resources.variables = normalizeRelative(manifest.resources.variables, 'resources.variables')
    }
    for (const key of ['harnesses', 'hooks', 'trainingHooks'] as const) {
      if (!manifest.resources?.[key]) continue
      manifest.resources[key] = manifest.resources[key].map((entry, index) => (
        normalizeRelative(entry, `resources.${key}[${index}]`)
      ))
    }
    const dependencies = manifest.toolDependencies ?? []
    const packages = new Set<string>()
    for (const [index, dependency] of dependencies.entries()) {
      if (packages.has(dependency.package)) {
        throw new Error(`duplicate plugin tool dependency: ${dependency.package}`)
      }
      packages.add(dependency.package)
      const version = dependency.version ?? '*'
      if (version !== '*' && !/^(?:\^|~|>=)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
        throw new Error(`toolDependencies[${index}].version is not supported: ${version}`)
      }
      dependency.version = version
      if (dependency.bundled) dependency.bundled = normalizeRelative(dependency.bundled, `toolDependencies[${index}].bundled`)
    }
    return manifest
  }

  private manifestRecords(settings: ProjectSettings): ManifestRecord[] {
    const rootManifest = path.join(this.projectDir, PLUGIN_MANIFEST_FILE)
    const hasV2Project = settings.resource_format === 2 || fs.existsSync(rootManifest)
    if (!hasV2Project) return []
    const records: ManifestRecord[] = [{
      manifest: {
        schemaVersion: 1,
        id: 'capybara-system',
        name: 'Capybara System',
        description: 'Read-only resources installed and maintained by Capybara.',
        version: '1.0.0',
      },
      manifestPath: '',
      source: '.capybara/system',
      ownerKind: 'system',
      enabled: true,
      uninstallable: false,
    }]
    if (fs.existsSync(rootManifest)) {
      const manifest = this.readManifest(PLUGIN_MANIFEST_FILE)
      if (manifest.id !== 'project') throw new Error('root capybara.plugin.json id must be project')
      records.push({
        manifest,
        manifestPath: PLUGIN_MANIFEST_FILE,
        source: '.',
        ownerKind: 'project',
        enabled: true,
        uninstallable: false,
      })
    }

    const configuredByPath = new Map(settings.plugins.map((plugin) => [plugin.path.replace(/\/$/, ''), plugin]))
    const pluginRoot = path.join(this.projectDir, 'plugins')
    const scanned = fs.existsSync(pluginRoot)
      ? fs.readdirSync(pluginRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `plugins/${entry.name}/${PLUGIN_MANIFEST_FILE}`)
        .filter((relative) => fs.existsSync(path.join(this.projectDir, relative)))
      : []
    const manifestPaths = new Set([
      ...settings.plugins.map((plugin) => `${plugin.path.replace(/\/$/, '')}/${PLUGIN_MANIFEST_FILE}`),
      ...scanned,
    ])
    for (const manifestPath of [...manifestPaths].sort()) {
      const manifest = this.readManifest(manifestPath)
      if (manifest.id === 'project' || manifest.id === 'capybara-system') {
        throw new Error(`installed plugin uses reserved id: ${manifest.id}`)
      }
      const source = path.posix.dirname(manifestPath)
      const configuredPlugin = configuredByPath.get(source)
      if (configuredPlugin && configuredPlugin.id !== manifest.id) {
        throw new Error(
          `configured plugin id ${configuredPlugin.id} does not match manifest id ${manifest.id}: ${source}`,
        )
      }
      records.push({
        manifest,
        manifestPath,
        source,
        ownerKind: 'installed',
        enabled: configuredPlugin?.enabled ?? false,
        uninstallable: true,
      })
    }
    const duplicate = records.map((record) => record.manifest.id)
      .find((id, index, ids) => ids.indexOf(id) !== index)
    if (duplicate) throw new Error(`duplicate installed plugin id: ${duplicate}`)
    return records
  }

  private pluginResource(
    record: ManifestRecord,
    items: readonly ProjectResourceModule[],
    toolByPackage: ReadonlyMap<string, ToolResourceModule>,
  ): PluginResource {
    const ownedItems = items.filter((item) => this.ownsModule(record, item))
    const resourceModuleIds = ownedItems.map((item) => item.id)
    const diagnostics: ResourceDiagnostic[] = ownedItems.flatMap((item) => (
      item.diagnostics.map((diagnostic) => ({ ...diagnostic }))
    ))
    const declared = this.runtimeResources().find((plugin) => plugin.pluginId === record.manifest.id)
    const variables = this.pluginVariables(record, diagnostics)
    const variableDependencies = this.pluginVariableDependencies(record, ownedItems, variables)
    if (declared) {
      const declaredFiles = [
        ...(declared.variables ? [{ label: 'variables', resourcePath: declared.variables, directory: false }] : []),
        ...declared.harnesses.map((resourcePath) => ({ label: 'harness', resourcePath, directory: false })),
        ...declared.hooks.map((resourcePath) => ({ label: 'Hook', resourcePath, directory: undefined })),
        ...declared.trainingHooks.map((resourcePath) => ({ label: 'training Hook', resourcePath, directory: undefined })),
      ]
      for (const file of declaredFiles) {
        let resolved: string
        try {
          resolved = this.resolvePluginResource(record, file.resourcePath, file.label)
        } catch (error) {
          diagnostics.push({
            severity: 'error',
            code: (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? 'PLUGIN_RESOURCE_MISSING'
              : 'PLUGIN_RESOURCE_INVALID',
            message: `Plugin ${record.manifest.id} ${error instanceof Error ? error.message : String(error)}`,
          })
          continue
        }
        if (file.directory === false && !fs.statSync(resolved).isFile()) {
          diagnostics.push({
            severity: 'error',
            code: 'PLUGIN_RESOURCE_INVALID',
            message: `Plugin ${record.manifest.id} ${file.label} resource must be a file: ${file.resourcePath}`,
          })
        }
      }
    }
    const toolDependencies: PluginToolDependencyResource[] = (record.manifest.toolDependencies ?? []).map((dependency) => {
      const tool = toolByPackage.get(dependency.package)
      const requestedVersion = dependency.version ?? '*'
      const status = !tool
        ? 'missing' as const
        : satisfiesToolVersion(tool.packageVersion, requestedVersion) ? 'installed' as const : 'conflict' as const
      if (status !== 'installed') {
        diagnostics.push({
          severity: 'error',
          code: status === 'missing' ? 'PLUGIN_TOOL_MISSING' : 'PLUGIN_TOOL_VERSION_CONFLICT',
          message: status === 'missing'
            ? `Plugin ${record.manifest.id} requires missing tool package ${dependency.package} (${requestedVersion})`
            : `Plugin ${record.manifest.id} requires ${dependency.package} ${requestedVersion}, installed ${tool?.packageVersion}`,
        })
      }
      return {
        package: dependency.package,
        version: requestedVersion,
        ...(dependency.bundled ? { bundled: dependency.bundled } : {}),
        ...(tool ? { installedVersion: tool.packageVersion, manifestPath: tool.source } : {}),
        status,
      }
    })
    return {
      id: record.manifest.id,
      name: record.manifest.name,
      description: record.manifest.description ?? '',
      version: record.manifest.version,
      ownerKind: record.ownerKind,
      enabled: record.enabled,
      ...(record.manifestPath ? { manifestPath: record.manifestPath } : {}),
      source: record.source,
      uninstallable: record.uninstallable,
      resourceModuleIds,
      resources: {
        ...(declared?.variables ? { variables: declared.variables } : {}),
        harnesses: declared?.harnesses ?? [],
        hooks: declared?.hooks ?? [],
        trainingHooks: declared?.trainingHooks ?? [],
      },
      variables,
      variableDependencies,
      toolDependencies,
      diagnostics,
    }
  }

  private resolveDeclaredPath(record: ManifestRecord, entry: string): string {
    return relativeJoin(record.source === '.' ? '' : record.source, entry)
  }

  private readVariableFile(relativeFile: string, pluginSource: string): SystemVariablesResource {
    const record = { source: pluginSource } as ManifestRecord
    const variableFile = this.resolvePluginResource(record, relativeFile, 'variables resource')
    if (!fs.statSync(variableFile).isFile()) {
      throw new Error(`variables resource must be a file: ${relativeFile}`)
    }
    const value: unknown = JSON.parse(fs.readFileSync(variableFile, 'utf8'))
    const resource = this.resources.validateSystemVariables(value)
    const sourceRecord = { source: pluginSource } as ManifestRecord
    const variables = resource.variables.map((variable) => {
      if (!variable.template) return variable
      if (variable.type !== 'prompt_template') {
        throw new Error(`variable ${variable.key} template is only supported for prompt_template variables`)
      }
      const template = normalizeSystemPromptVariableTemplatePath(variable.template, `variable ${variable.key} template`)
      const templatePath = this.resolvePluginResource(
        sourceRecord,
        relativeJoin(pluginSource, template),
        `variable ${variable.key} template`,
      )
      if (!fs.statSync(templatePath).isFile()) {
        throw new Error(`variable ${variable.key} template must be a file: ${template}`)
      }
      const templateSource = fs.readFileSync(templatePath, 'utf8')
      return { ...variable, template, value: templateSource }
    })
    return { version: 1, variables }
  }

  private pluginVariables(
    record: ManifestRecord,
    diagnostics: ResourceDiagnostic[],
  ): SystemVariableDefinition[] {
    if (record.ownerKind === 'system' || !record.manifest.resources?.variables) return []
    const relativeFile = this.resolveDeclaredPath(record, record.manifest.resources.variables)
    try {
      const resource = this.readVariableFile(relativeFile, record.source)
      if (record.ownerKind === 'project') {
        return resource.variables
          .filter((variable) => !variable.readonly && variable.source !== 'builtin')
          .map((variable) => ({ ...variable, source: 'project', owner: 'project' }))
      }
      return resource.variables.map((variable) => ({
        ...variable,
        source: 'plugin',
        owner: record.manifest.id,
      }))
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        code: 'PLUGIN_VARIABLES_INVALID',
        message: error instanceof Error ? error.message : String(error),
      })
      return []
    }
  }

  private pluginVariableDependencies(
    record: ManifestRecord,
    ownedItems: readonly ProjectResourceModule[],
    ownedVariables: readonly SystemVariableDefinition[],
  ): PluginVariableDependencyResource[] {
    const ownedKeys = new Set(ownedVariables.map((variable) => variable.key))
    const candidates = this.resources.readSystemVariables().variables
      .filter((variable) => !ownedKeys.has(variable.key))
    if (candidates.length === 0) return []

    const relativeFiles = new Set(ownedItems.flatMap((item) => item.files.map((file) => file.path)))
    for (const variable of ownedVariables) {
      if (!variable.template) continue
      try {
        const template = normalizeSystemPromptVariableTemplatePath(variable.template, `variable ${variable.key} template`)
        const templatePath = relativeJoin(record.source, template)
        this.resolvePluginResource(record, templatePath, `variable ${variable.key} template`)
        relativeFiles.add(templatePath)
      } catch {
        // The variable loader already reports the missing or unsafe template.
      }
    }
    if (record.ownerKind === 'project') {
      const mainTemplate = this.resources.readSettings().main_template.replace(/\\/g, '/')
      if (mainTemplate) relativeFiles.add(mainTemplate)
    }

    const referencesByKey = new Map<string, Array<{ path: string; count: number }>>()
    for (const relativeFile of relativeFiles) {
      let absolute: string
      try {
        absolute = this.resolveProjectFile(relativeFile, 'plugin variable dependency source')
      } catch {
        continue
      }
      const buffer = fs.readFileSync(absolute)
      if (buffer.includes(0)) continue
      const content = buffer.toString('utf8')
      for (const variable of candidates) {
        const count = variableReferenceCount(content, variable.key)
        if (count === 0) continue
        referencesByKey.set(variable.key, [
          ...(referencesByKey.get(variable.key) ?? []),
          { path: relativeFile, count },
        ])
      }
    }

    return candidates.flatMap((variable) => {
      const references = referencesByKey.get(variable.key)
      return references ? [{
        variable: {
          ...variable,
          owner: variable.source === 'builtin' || variable.readonly ? 'capybara-system' : 'project',
        },
        references,
      }] : []
    })
  }

  private ownsModule(record: ManifestRecord, item: ProjectResourceModule): boolean {
    if (record.ownerKind === 'system') return item.source.startsWith('.capybara/')
    if (record.ownerKind === 'installed') return item.source.startsWith(`${record.source}/`)
    return !item.source.startsWith('.capybara/') && !item.source.startsWith('plugins/')
  }

  private resolveProjectFile(relativeFile: string, label: string): string {
    const candidate = path.resolve(this.projectDir, relativeFile)
    if (!inside(this.projectDir, candidate)) throw new Error(`${label} leaves the project workspace`)
    const realFile = fs.realpathSync(candidate)
    if (!inside(this.projectRealDir, realFile)) {
      throw new Error(`${label} symlink leaves the project workspace`)
    }
    if (!fs.statSync(realFile).isFile()) throw new Error(`${label} is not a file: ${relativeFile}`)
    return realFile
  }

  private resolvePluginResource(
    record: Pick<ManifestRecord, 'source'>,
    relativeFile: string,
    label: string,
  ): string {
    const candidate = path.resolve(this.projectDir, relativeFile)
    if (!inside(this.projectDir, candidate)) throw new Error(`${label} leaves the project workspace`)
    const realFile = fs.realpathSync(candidate)
    if (!inside(this.projectRealDir, realFile)) {
      throw new Error(`${label} symlink leaves the project workspace: ${relativeFile}`)
    }
    const sourceDir = path.resolve(this.projectDir, record.source)
    const realSourceDir = fs.realpathSync(sourceDir)
    if (!inside(realSourceDir, realFile)) {
      throw new Error(`${label} leaves the plugin directory: ${relativeFile}`)
    }
    return realFile
  }
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)]
}

function relativeJoin(...segments: string[]): string {
  return path.posix.join(...segments.map((segment) => segment.replace(/\\/g, '/')))
}

export function pluginManifestFile(): string {
  return PLUGIN_MANIFEST_FILE
}

export function isPluginManifest(value: unknown): value is PluginManifest {
  return isObject(value) && value.schemaVersion === 1 && typeof value.id === 'string'
}

export { variableReferenceCount } from '#core/system-variable-references'
