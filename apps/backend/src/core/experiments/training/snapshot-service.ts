import { createHash, randomUUID } from 'node:crypto'

import type { TestSnapshot } from '#core/experiments/training/training-types'
import { TrainingStore } from '#core/experiments/training/training-store'
import { ProjectResources } from '#core/project-resources'

export class SnapshotService {
  constructor(
    readonly projectDir: string,
    private readonly store: TrainingStore,
  ) {}

  create(runId: string, runVariables?: Record<string, string>): TestSnapshot {
    const variables = runVariables ?? Object.fromEntries(
      new ProjectResources(this.projectDir).readSystemVariables().variables
        .filter((variable) => variable.key !== 'sys_message')
        .map((variable) => [variable.key, variable.value]),
    )
    const canonical = JSON.stringify(Object.fromEntries(Object.entries(variables).sort()))
    return this.store.createSnapshot({
      id: randomUUID(),
      runId,
      variables,
      contentHash: createHash('sha256').update(canonical).digest('hex'),
      createdAt: new Date().toISOString(),
    })
  }
}
