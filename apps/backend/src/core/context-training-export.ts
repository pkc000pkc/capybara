import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { toOrganizationTrainableExamples } from '#core/context-training-recorder'
import type { RuntimeLoopState } from '#core/runtime-loop-state'
import { SessionStore } from '#core/session-store'

interface ContextTrainingExportOptions {
  projectDir: string
  dataDir?: string
  sessionIds: string[]
  output: string
}

function projectKey(directory: string): string {
  const canonical = fs.realpathSync(directory)
  if (!fs.statSync(canonical).isDirectory()) throw new Error('Expected a project directory')
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

export function exportContextTraining(options: ContextTrainingExportOptions): { sessions: number; examples: number } {
  const sessionIds = [...new Set(options.sessionIds)]
  if (sessionIds.length === 0 || sessionIds.some(id => !id.trim())) throw new Error('Select at least one session to export')
  const project = projectKey(options.projectDir)
  const projectGroup = createHash('sha256').update(project).digest('hex')
  const store = new SessionStore(options.projectDir, { directory: options.dataDir, readOnly: true })
  const output = path.resolve(options.output)
  const temporary = path.join(path.dirname(output), `.context-training-${randomUUID()}.tmp`)
  let count = 0
  let file: number | undefined
  try {
    file = fs.openSync(temporary, 'wx', 0o600)
    const exported = new Set<string>()
    for (const sessionId of sessionIds) {
      const session = store.get(sessionId)
      if (!session) throw new Error(`Session was not found: ${sessionId}`)
      const state = session.state as RuntimeLoopState | undefined
      if (state?.version !== 1) continue
      const sessionGroup = createHash('sha256').update(projectGroup).update(sessionId).digest('hex')
      for (const sample of state.contextTrainingSamples ?? []) {
        if (!sample.organization) continue
        if (sample.sessionId !== sessionId || projectKey(sample.projectId) !== project) {
          throw new Error(`Context training sample has mismatched project or session: ${sample.sampleId}`)
        }
        for (const example of toOrganizationTrainableExamples(sample)) {
          if (exported.has(example.sampleId)) throw new Error(`Duplicate context training example: ${example.sampleId}`)
          exported.add(example.sampleId)
          const row = { ...example, provenance: { ...example.provenance, projectGroup, sessionGroup } }
          fs.writeFileSync(file, `${JSON.stringify(row)}\n`)
          count += 1
        }
      }
    }
    if (count === 0) throw new Error('Selected sessions have no validated Organizer training examples')
    fs.fsyncSync(file)
    // Publish only a complete file. A same-directory hard link never overwrites an existing destination.
    fs.linkSync(temporary, output)
    return { sessions: sessionIds.length, examples: count }
  } finally {
    try {
      if (file !== undefined) {
        fs.closeSync(file)
        fs.unlinkSync(temporary)
      }
    } finally {
      store.close()
    }
  }
}
