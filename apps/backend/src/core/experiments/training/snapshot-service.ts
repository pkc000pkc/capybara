import { createHash, randomUUID } from 'node:crypto'

import type { TestSnapshot } from '#core/experiments/training/training-types'
import { TrainingStore } from '#core/experiments/training/training-store'
import { ProjectResources } from '#core/project-resources'
import { ProjectContextStore } from '#core/project-context-store'
import { V2_CONSTITUTION_REVISION } from '#core/v2-prompts'
import type { ContextDocumentEngineState } from '#core/context-document-engine'

export class SnapshotService {
  constructor(
    readonly projectDir: string,
    private readonly store: TrainingStore,
  ) {}

  create(runId: string, runVariables?: Record<string, string>, projectContext?: ContextDocumentEngineState): TestSnapshot {
    const variables = runVariables ?? Object.fromEntries(
      new ProjectResources(this.projectDir).readSystemVariables().variables
        .filter((variable) => variable.key !== 'sys_message' && typeof variable.value === 'string')
        .map((variable) => [variable.key, variable.value as string]),
    )
    let frozenProjectContext = projectContext
    if (!frozenProjectContext) {
      const projectContextStore = new ProjectContextStore(this.projectDir, this.projectDir, V2_CONSTITUTION_REVISION)
      try {
        frozenProjectContext = projectContextStore.load().exportState()
      } finally {
        projectContextStore.close()
      }
    }
    const canonical = JSON.stringify({
      projectContext: frozenProjectContext,
      variables: Object.fromEntries(Object.entries(variables).sort()),
    })
    return this.store.createSnapshot({
      id: randomUUID(),
      runId,
      variables,
      projectContext: frozenProjectContext,
      contentHash: createHash('sha256').update(canonical).digest('hex'),
      createdAt: new Date().toISOString(),
    })
  }
}
