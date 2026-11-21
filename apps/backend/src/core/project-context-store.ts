import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { ContextDocumentEngine, type ContextDocumentEngineState } from '#core/context-document-engine'
import { assertAssetWriteAllowed, auditedAssetWrite } from '#core/asset-write-policy'
import { ContextCommitStore } from '#core/context-commit-store'
import type { ContextOutcome } from '#core/context-commit-store'

const STORE_VERSION = 1
const STATE_FILE = 'project_context.json'
const MARKDOWN_FILE = 'project_context.md'

interface PersistedProjectContext {
  version: number
  markdown: string
  state: ContextDocumentEngineState
  savedAt: string
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function atomicWrite(file: string, content: string): void {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(temporary, content, 'utf8')
  fs.renameSync(temporary, file)
}

function stableProjectDocumentId(projectId: string): string {
  return `project-context-${createHash('sha256').update(projectId, 'utf8').digest('hex').slice(0, 32)}`
}

/**
 * Project-scoped ContextDocument persistence.
 *
 * SQLite retains canonical documents, receipts and projection bindings. Old
 * JSON/Markdown are imported once; both files remain human-readable exports.
 */
export class ProjectContextStore {
  readonly directory: string
  readonly stateFile: string
  readonly markdownFile: string
  readonly commits: ContextCommitStore
  mirrorError?: string

  constructor(
    readonly projectDir: string,
    readonly projectId: string,
    readonly constitutionRevision: string,
  ) {
    this.directory = path.join(projectDir, '.capybara')
    this.stateFile = path.join(this.directory, STATE_FILE)
    this.markdownFile = path.join(this.directory, MARKDOWN_FILE)
    this.commits = new ContextCommitStore(projectDir)
  }

  load(legacySnapshot?: ContextDocumentEngineState): ContextDocumentEngine {
    const state = this.commits.loadDocument()
    if (state) return new ContextDocumentEngine(state.document, state.receipts, state.projections, state.reviewReceipts, state.evidenceReviewReceipts)
    const engine = this.loadLegacy(legacySnapshot)
    const seeded = this.commits.seedProject(engine.exportState())
    return new ContextDocumentEngine(seeded.document, seeded.receipts, seeded.projections, seeded.reviewReceipts, seeded.evidenceReviewReceipts)
  }

  close(): void { this.commits.close() }

  private loadLegacy(legacySnapshot?: ContextDocumentEngineState): ContextDocumentEngine {
    fs.mkdirSync(this.directory, { recursive: true })
    if (fs.existsSync(this.stateFile)) {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<PersistedProjectContext>
      if (raw.version !== STORE_VERSION || !raw.state) throw new Error('PROJECT_CONTEXT_INVALID_STATE')
      return new ContextDocumentEngine(
        raw.state.document,
        raw.state.receipts,
        raw.state.projections,
        raw.state.reviewReceipts,
        raw.state.evidenceReviewReceipts,
      )
    }

    if (fs.existsSync(this.markdownFile)) {
      const markdown = fs.readFileSync(this.markdownFile, 'utf8')
      return ContextDocumentEngine.parse(markdown, {
        sessionId: 'project-context',
        projectId: this.projectId,
        constitutionRevision: this.constitutionRevision,
      })
    }

    if (legacySnapshot) {
      if (legacySnapshot.document.projectId !== this.projectId) throw new Error('PROJECT_CONTEXT_PROJECT_MISMATCH')
      return new ContextDocumentEngine(legacySnapshot.document, legacySnapshot.receipts, legacySnapshot.projections, legacySnapshot.reviewReceipts, legacySnapshot.evidenceReviewReceipts)
    }
    const engine = ContextDocumentEngine.create({
      sessionId: 'project-context',
      projectId: this.projectId,
      constitutionRevision: this.constitutionRevision,
    })
    const document = engine.snapshot()
    document.id = stableProjectDocumentId(this.projectId)
    return new ContextDocumentEngine(document)
  }

  readRevision(): number {
    const stored = this.commits.loadDocument(undefined, { observe: false })
    if (stored) return stored.document.revision
    if (!fs.existsSync(this.stateFile)) return 0
    const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<PersistedProjectContext>
    if (raw.version !== STORE_VERSION || !raw.state?.document) throw new Error('PROJECT_CONTEXT_INVALID_STATE')
    return raw.state.document.revision
  }

  save(engine: ContextDocumentEngine, expectedRevision?: number, sessionId?: string, outcomes: ContextOutcome[] = []): void {
    assertAssetWriteAllowed(this.projectDir, 'project-context.save')
    fs.mkdirSync(this.directory, { recursive: true })
    const currentRevision = this.readRevision()
    if (expectedRevision !== undefined && currentRevision !== expectedRevision) {
      throw new Error('PROJECT_CONTEXT_REVISION_CONFLICT')
    }
    this.commits.saveProject(engine.exportState(), currentRevision, sessionId, outcomes)
    this.exportMirrors(engine)
  }

  /** JSON/Markdown are derived exports; an export failure cannot undo a committed transaction. */
  exportMirrors(engine: ContextDocumentEngine): void {
    const state = engine.exportState()
    const persisted: PersistedProjectContext = {
      version: STORE_VERSION,
      markdown: engine.serialize(),
      state: clone(state),
      savedAt: new Date().toISOString(),
    }
    try {
      auditedAssetWrite(this.projectDir, 'project-context.export', () => {
        atomicWrite(this.stateFile, JSON.stringify(persisted, null, 2))
        atomicWrite(this.markdownFile, persisted.markdown)
      })
      this.mirrorError = undefined
    } catch (error) { this.mirrorError = error instanceof Error ? error.message : String(error) }
  }
}
