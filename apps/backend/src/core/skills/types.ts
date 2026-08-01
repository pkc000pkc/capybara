export interface AgentSkillDefinition {
  name: string
  description: string
  license?: string
  compatibility?: string
  metadata: Record<string, string>
  allowedTools?: string
  body: string
}

export interface RegisteredSkill extends AgentSkillDefinition {
  id: string
  rootDir: string
  entryFile: string
  scriptFiles: string[]
  referenceFiles: string[]
  assetFiles: string[]
}
