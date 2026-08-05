import { createHash } from 'node:crypto'

import { applyUnifiedDiff } from '#core/experiments/training/unified-diff'
import type { VariableDiff } from '#core/experiments/training/training-types'
import { ProjectResources } from '#core/project-resources'
import { enqueueProjectWrite } from '#core/project-write-queue'

export function variableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export class ProjectVariableWriter {
  private readonly resources: ProjectResources

  constructor(readonly projectDir: string) {
    this.resources = new ProjectResources(projectDir)
  }

  preview(patches: readonly VariableDiff[], baseValues?: Record<string, string>): Record<string, string> {
    const variables = new Map(this.resources.readSystemVariables().variables.map((item) => [item.key, item]))
    const source = baseValues ?? Object.fromEntries([...variables].map(([key, variable]) => [key, variable.value]))
    const result: Record<string, string> = {}
    for (const patch of patches) {
      const variable = variables.get(patch.variableName)
      if (!variable) throw new Error(`system variable was not found: ${patch.variableName}`)
      if (variable.readonly || variable.scope !== 'project') {
        throw new Error(`system variable is not a writable project variable: ${patch.variableName}`)
      }
      const beforeValue = source[patch.variableName]
      if (beforeValue === undefined) throw new Error(`system variable was not found in the variable source: ${patch.variableName}`)
      if (variableHash(beforeValue) !== patch.baseHash) {
        throw new Error(`system variable changed since candidate creation: ${patch.variableName}`)
      }
      result[patch.variableName] = applyUnifiedDiff(beforeValue, patch.unifiedDiff)
    }
    return result
  }

  promote(
    baseline: Record<string, string>,
    values: Record<string, string>,
  ): Promise<{ variables: Record<string, string>; contentHash: string }> {
    return enqueueProjectWrite(this.projectDir, () => {
      const current = this.resources.readSystemVariables()
      const byKey = new Map(current.variables.map((item) => [item.key, item]))
      for (const [key, beforeValue] of Object.entries(baseline)) {
        const variable = byKey.get(key)
        if (!variable) throw new Error(`system variable was not found: ${key}`)
        if (variable.readonly || variable.scope !== 'project') {
          throw new Error(`system variable is not a writable project variable: ${key}`)
        }
        if (variableHash(variable.value) !== variableHash(beforeValue)) {
          throw new Error(`project variable changed since this training run started: ${key}`)
        }
      }
      const updates = Object.fromEntries(Object.entries(values).filter(([key]) => key in baseline))
      this.resources.saveSystemVariables({
        version: 1,
        variables: current.variables.map((variable) => ({
          ...variable,
          value: updates[variable.key] ?? variable.value,
        })),
      })
      const canonical = JSON.stringify(Object.fromEntries(Object.entries(updates).sort()))
      return {
        variables: updates,
        contentHash: createHash('sha256').update(canonical).digest('hex'),
      }
    })
  }

}
