import fs from 'node:fs'

import { HarnessRegistry } from '#core/harnesses/harness-registry'
import type { HarnessActivation, HarnessType } from '#core/harnesses/types'

export interface HarnessCatalogEntry {
  id: string
  name: string
  description: string
  source: string
  manifest: string
  type: HarnessType
  priority: number
  activation: HarnessActivation
  inputs: string[]
  requiredTools: string[]
  searchText: string
}

export function loadHarnessCatalog(
  projectDir: string,
  manifestPaths: readonly string[],
): HarnessCatalogEntry[] {
  const registry = new HarnessRegistry(projectDir)
  registry.load(manifestPaths)
  return registry.list().map((harness) => {
    const content = fs.readFileSync(harness.entryFile, 'utf8')
    const searchValues = Object.values(harness.activation).flatMap((value) => value ?? [])
    return {
      id: harness.id,
      name: harness.name,
      description: harness.description,
      source: harness.entryFile,
      manifest: harness.manifestFile,
      type: harness.type,
      priority: harness.priority ?? 0,
      activation: structuredClone(harness.activation),
      inputs: [...harness.inputs],
      requiredTools: [...harness.requiredTools],
      searchText: [harness.name, harness.description, ...searchValues, content]
        .join(' ')
        .toLowerCase(),
    }
  })
}
