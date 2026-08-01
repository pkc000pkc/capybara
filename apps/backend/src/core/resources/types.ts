import type { HarnessActivation, HarnessType } from '#core/harnesses/types'

export type ResourceKind = 'tool' | 'skill' | 'harness'

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

export interface ToolResourceModule extends ResourceModule<'tool'> {
  runner: { type: 'stdio'; entry: string }
  tools: ToolResourceDefinition[]
}

export interface SkillResourceModule extends ResourceModule<'skill'> {
  skills: SkillResourceDefinition[]
}

export interface HarnessResourceModule extends ResourceModule<'harness'> {
  harnesses: HarnessResourceDefinition[]
}

export type ProjectResourceModule =
  | ToolResourceModule
  | SkillResourceModule
  | HarnessResourceModule

export interface ResourceCatalog {
  revision: string
  items: ProjectResourceModule[]
}

export interface ResourceFileContent extends ResourceFile {
  content: string
  revision: string
}
