import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

function systemHarnessManifests(projectDir: string): string[] {
  const systemRoot = path.join(os.homedir(), '.capybara')
  const root = path.join(systemRoot, 'harnesses')
  if (!fs.existsSync(root)) return []
  const manifests: string[] = []
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(target)
      if (entry.isFile() && entry.name === 'manifest.json') {
        manifests.push(`@system/${path.relative(systemRoot, target).replaceAll('\\', '/')}`)
      }
    }
  }
  visit(root)
  return manifests.sort()
}

export function loadRuntimeHarnessCatalog(
  projectDir: string,
  manifestPaths: readonly string[],
): HarnessCatalogEntry[] {
  return loadHarnessCatalog(
    projectDir,
    [...new Set([...systemHarnessManifests(projectDir), ...manifestPaths])],
  )
}
