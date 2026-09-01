import type { HarnessActivation, HarnessType } from '#core/harnesses/types'
import type { HookCheckpoint, HookParameterDefinition, HookPermissions, HookSchedule } from '#core/hooks/types'
import type { SystemVariableDefinition } from '#core/project-resources'

export type ResourceKind = 'tool' | 'skill' | 'harness' | 'hook'

export interface ResourceDiagnostic {
  severity: 'info' | 'warning' | 'error'
  code: string
  message: string
}

export interface ResourceFile {
  path: string
  role: 'manifest' | 'runner' | 'entry' | 'script' | 'template' | 'reference' | 'asset'
  language: string
  editable: boolean
}

interface ResourceModule<TKind extends ResourceKind> {
  id: string
  kind: TKind
  package: string
  name: string
  version: number
  source: string
  enabled: boolean
  revision: string
  diagnostics: ResourceDiagnostic[]
  files: ResourceFile[]
}

export type PluginOwnerKind = 'system' | 'project' | 'installed'

export interface PluginToolDependencyResource {
  package: string
  version: string
  bundled?: string
  installedVersion?: string
  manifestPath?: string
  status: 'installed' | 'missing' | 'conflict'
}

export interface PluginVariableDependencyResource {
  variable: SystemVariableDefinition
  references: Array<{
    path: string
    count: number
  }>
}

export interface PluginResource {
  id: string
  name: string
  description: string
  version: string
  ownerKind: PluginOwnerKind
  enabled: boolean
  manifestPath?: string
  source: string
  uninstallable: boolean
  resourceModuleIds: string[]
  resources: {
    variables?: string
    harnesses: string[]
    hooks: string[]
    trainingHooks: string[]
  }
  variables: SystemVariableDefinition[]
  variableDependencies: PluginVariableDependencyResource[]
  toolDependencies: PluginToolDependencyResource[]
  diagnostics: ResourceDiagnostic[]
}

export interface ToolDependentPlugin {
  pluginId: string
  pluginName: string
  requestedVersion: string
  enabled: boolean
}

export interface ToolPackageResource {
  package: string
  version: string
  manifestPath: string
  moduleId: string
  requiredBy: ToolDependentPlugin[]
  orphaned: boolean
  uninstallable: boolean
}

export interface ToolResourceDefinition {
  id: string
  kind: 'tool'
  name: string
  description: string
  permissions: string[]
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  examples: Record<string, unknown>[]
  sideEffects: 'none' | 'workspace-write' | 'external'
  replay: 'safe' | 'confirm' | 'never'
  diagnostics: ResourceDiagnostic[]
}

export interface SkillResourceDefinition {
  id: string
  kind: 'skill'
  name: string
  description: string
  license?: string
  compatibility?: string
  metadata: Record<string, string>
  allowedTools?: string
  entry: string
  scripts: string[]
  references: string[]
  assets: string[]
  content: string
  entryRevision: string
  diagnostics: ResourceDiagnostic[]
}

export interface HarnessResourceDefinition {
  id: string
  kind: 'harness'
  name: string
  description: string
  type: HarnessType
  entry: string
  priority: number
  activation: HarnessActivation
  inputs: string[]
  requiredTools: string[]
  examples: Record<string, unknown>[]
  content: string
  entryRevision: string
  diagnostics: ResourceDiagnostic[]
}

export interface HookResourceDefinition {
  id: string
  kind: 'hook'
  name: string
  description: string
  entry: string
  enabled: boolean
  ownerId: string
  mode: 'runtime' | 'training'
  checkpoint: HookCheckpoint
  schedule: HookSchedule
  permissions: HookPermissions
  parameters: HookParameterDefinition[]
  triggerSummary: string
  triggerInputs: string[]
  content: string
  entryRevision: string
  diagnostics: ResourceDiagnostic[]
}

export interface ToolResourceModule extends ResourceModule<'tool'> {
  packageVersion: string
  runner: { type: 'stdio'; entry: string }
  tools: ToolResourceDefinition[]
}

export interface SkillResourceModule extends ResourceModule<'skill'> {
  skills: SkillResourceDefinition[]
}

export interface HarnessResourceModule extends ResourceModule<'harness'> {
  harnesses: HarnessResourceDefinition[]
}

export interface HookResourceModule extends ResourceModule<'hook'> {
  hooks: HookResourceDefinition[]
}

export type ProjectResourceModule =
  | ToolResourceModule
  | SkillResourceModule
  | HarnessResourceModule
  | HookResourceModule

export interface ResourceCatalog {
  revision: string
  items: ProjectResourceModule[]
  plugins: PluginResource[]
  toolPackages: ToolPackageResource[]
}

export interface ResourceFileContent extends ResourceFile {
  content: string
  revision: string
}
