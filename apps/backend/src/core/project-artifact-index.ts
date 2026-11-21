import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { SourceRef } from '#core/product-work-ledger'

export type ProjectArtifactReviewStatus = 'produced' | 'quarantined' | 'available' | 'accepted' | 'rejected' | 'expired'

export type ProjectArtifactRecord = {
  artifactId: string
  kind: string
  contentRef: string
  contentHash?: string
  status: ProjectArtifactReviewStatus
  summary: string
  relativePath?: string
  sourceRefs: SourceRef[]
  runId?: string
  createdAt: string
  updatedAt: string
  metadata?: Record<string, unknown>
}

export type ProjectArtifactIndexState = {
  schemaVersion: 1
  revision: number
  items: ProjectArtifactRecord[]
  reviewEvents?: ProjectArtifactReviewEvent[]
}

export type ProjectArtifactReviewEvent = {
  id: string
  artifactId: string
  fromStatus: ProjectArtifactReviewStatus
  toStatus: ProjectArtifactReviewStatus
  actor: 'user' | 'system'
  createdAt: string
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function normalizeRecord(value: unknown): ProjectArtifactRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (typeof input.artifactId !== 'string' || !input.artifactId.trim()) return undefined
  if (typeof input.kind !== 'string' || !input.kind.trim()) return undefined
  if (typeof input.contentRef !== 'string' || !input.contentRef.trim()) return undefined
  if (typeof input.status !== 'string' || !['produced', 'quarantined', 'available', 'accepted', 'rejected', 'expired'].includes(input.status)) return undefined
  if (typeof input.summary !== 'string') return undefined
  if (typeof input.createdAt !== 'string' || typeof input.updatedAt !== 'string') return undefined
  return {
    artifactId: input.artifactId,
    kind: input.kind,
    contentRef: input.contentRef,
    ...(typeof input.contentHash === 'string' ? { contentHash: input.contentHash } : {}),
    status: input.status as ProjectArtifactReviewStatus,
    summary: input.summary,
    ...(typeof input.relativePath === 'string' ? { relativePath: input.relativePath } : {}),
    sourceRefs: Array.isArray(input.sourceRefs) ? clone(input.sourceRefs as SourceRef[]) : [],
    ...(typeof input.runId === 'string' ? { runId: input.runId } : {}),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    ...(input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? { metadata: clone(input.metadata as Record<string, unknown>) } : {}),
  }
}

/**
 * Durable project-level index for files and result artifacts that must remain
 * discoverable after a Runtime session is closed. The index stores project
 * relative paths only; absolute native paths never cross the API boundary.
 */
export class ProjectArtifactIndex {
  readonly projectDir: string
  readonly indexFile: string
  private readonly now: () => string

  constructor(projectDir: string, options: { now?: () => string } = {}) {
    this.projectDir = path.resolve(projectDir)
    this.indexFile = path.join(this.projectDir, '.capybara', 'runtime', 'artifacts', 'index.json')
    this.now = options.now ?? (() => new Date().toISOString())
  }

  read(): ProjectArtifactIndexState {
    if (!fs.existsSync(this.indexFile)) return { schemaVersion: 1, revision: 0, items: [], reviewEvents: [] }
    const value = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) as Partial<ProjectArtifactIndexState>
    if (value.schemaVersion !== 1 || !Array.isArray(value.items)) throw new Error('project artifact index is invalid')
    const items = value.items.map(normalizeRecord).filter((item): item is ProjectArtifactRecord => Boolean(item))
    const rawRevision = value.revision
    const revision = typeof rawRevision === 'number' && Number.isInteger(rawRevision) && rawRevision >= 0 ? rawRevision : 0
    const reviewEvents = Array.isArray(value.reviewEvents)
      ? value.reviewEvents.filter((item): item is ProjectArtifactReviewEvent => Boolean(item && typeof item === 'object' && typeof (item as ProjectArtifactReviewEvent).id === 'string' && typeof (item as ProjectArtifactReviewEvent).artifactId === 'string'))
      : []
    return { schemaVersion: 1, revision, items, reviewEvents }
  }

  list(): ProjectArtifactRecord[] {
    return clone(this.read().items).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  get(artifactId: string): ProjectArtifactRecord | undefined {
    const item = this.read().items.find((candidate) => candidate.artifactId === artifactId)
    return item ? clone(item) : undefined
  }

  upsert(input: Omit<ProjectArtifactRecord, 'createdAt' | 'updatedAt'> & Partial<Pick<ProjectArtifactRecord, 'createdAt' | 'updatedAt'>>): ProjectArtifactRecord {
    if (!input.artifactId.trim()) throw new Error('artifactId is required')
    const current = this.read()
    const previous = current.items.find((item) => item.artifactId === input.artifactId)
    const now = this.now()
    const relativePath = input.relativePath === undefined
      ? undefined
      : this.relativePath(input.relativePath)
    const next: ProjectArtifactRecord = {
      ...clone(input),
      ...(relativePath === undefined ? {} : { relativePath }),
      createdAt: previous?.createdAt ?? input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
      sourceRefs: clone(input.sourceRefs ?? []),
      ...(input.metadata === undefined ? {} : { metadata: clone(input.metadata) }),
    }
    const items = previous
      ? current.items.map((item) => item.artifactId === next.artifactId ? next : item)
      : [...current.items, next]
    this.write({ schemaVersion: 1, revision: current.revision + 1, items, reviewEvents: current.reviewEvents })
    return clone(next)
  }

  updateStatus(artifactId: string, status: ProjectArtifactReviewStatus, actor: 'user' | 'system' = 'user'): ProjectArtifactRecord {
    const current = this.read()
    const existing = current.items.find((item) => item.artifactId === artifactId)
    if (!existing) throw new Error(`project artifact was not found: ${artifactId}`)
    const next = { ...existing, status, updatedAt: this.now() }
    const event: ProjectArtifactReviewEvent = { id: `artifact-review-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, artifactId, fromStatus: existing.status, toStatus: status, actor, createdAt: next.updatedAt }
    this.write({ schemaVersion: 1, revision: current.revision + 1, items: current.items.map((item) => item.artifactId === artifactId ? next : item), reviewEvents: [...(current.reviewEvents ?? []), event] })
    return clone(next)
  }

  verify(artifactId: string): { record: ProjectArtifactRecord; exists: boolean; hashMatches: boolean; reason?: string } {
    const existing = this.get(artifactId)
    if (!existing) throw new Error(`project artifact was not found: ${artifactId}`)
    if (!existing.relativePath) return { record: existing, exists: false, hashMatches: false, reason: 'artifact has no project file path' }
    const filePath = path.resolve(this.projectDir, existing.relativePath)
    if (!inside(this.projectDir, filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      const record = this.updateStatus(artifactId, 'expired', 'system')
      return { record, exists: false, hashMatches: false, reason: 'artifact file is missing' }
    }
    const contentHash = createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
    const hashMatches = !existing.contentHash || existing.contentHash === contentHash
    const record = this.updateStatus(artifactId, hashMatches ? 'available' : 'rejected', 'system')
    return { record, exists: true, hashMatches, ...(hashMatches ? {} : { reason: 'artifact content hash does not match' }) }
  }

  private relativePath(value: string): string {
    const candidate = path.resolve(this.projectDir, value)
    if (!inside(this.projectDir, candidate)) throw new Error('artifact path leaves the project workspace')
    return path.relative(this.projectDir, candidate).replaceAll(path.sep, '/')
  }

  private write(value: ProjectArtifactIndexState): void {
    fs.mkdirSync(path.dirname(this.indexFile), { recursive: true })
    const temporary = `${this.indexFile}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(temporary, this.indexFile)
  }
}
