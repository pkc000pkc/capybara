export type HarnessType = 'model' | 'tool' | 'experience'

export interface ModelHarnessActivation {
  providers?: string[]
  models?: string[]
  modelFamilies?: string[]
}

export interface ToolHarnessActivation {
  tools: string[]
}

export interface ExperienceHarnessActivation {
  keywords: string[]
  tags?: string[]
}

export type HarnessActivation =
  | ModelHarnessActivation
  | ToolHarnessActivation
  | ExperienceHarnessActivation

export interface ProjectHarnessDefinition {
  name: string
  description: string
  type: HarnessType
  entry: string
  priority?: number
  activation: HarnessActivation
  inputs: string[]
  requiredTools: string[]
  examples?: Record<string, unknown>[]
}

export interface HarnessManifest {
  version: 1
  package: string
  harnesses: ProjectHarnessDefinition[]
}

export interface RegisteredHarness extends ProjectHarnessDefinition {
  id: string
  packageName: string
  manifestVersion: number
  manifestFile: string
  entryFile: string
}
