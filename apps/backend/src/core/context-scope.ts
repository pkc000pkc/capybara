import type { ContextDocument } from '#core/context-document-engine'
import type { RuntimeContextScopesState, RuntimeContextScopeRef } from '#protocol/runtime-protocol'

export type { RuntimeContextScopesState, RuntimeContextScopeRef }

function requireId(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} is required`)
  return value
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function validateRef(value: RuntimeContextScopeRef, name: string): void {
  if (value.scope !== 'project' && value.scope !== 'session') throw new Error(`${name}.scope is invalid`)
  requireId(value.projectId, `${name}.projectId`)
  requireId(value.documentId, `${name}.documentId`)
  if (!Number.isInteger(value.revision) || value.revision < 0) throw new Error(`${name}.revision is invalid`)
  if (value.scope === 'session') requireId(value.sessionId, `${name}.sessionId`)
  if (value.parentRevision !== undefined && (!Number.isInteger(value.parentRevision) || value.parentRevision < 0)) throw new Error(`${name}.parentRevision is invalid`)
}

export function validateContextScopes(value: unknown): asserts value is RuntimeContextScopesState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('context scopes must be an object')
  const state = value as RuntimeContextScopesState
  if (!Number.isInteger(state.revision) || state.revision < 0) throw new Error('context scopes revision is invalid')
  if (state.activeScope !== 'project' && state.activeScope !== 'session') throw new Error('context scopes activeScope is invalid')
  validateRef(state.project, 'context scopes project')
  validateRef(state.session, 'context scopes session')
  if (state.project.scope !== 'project' || state.session.scope !== 'session') throw new Error('context scopes refs have wrong scope')
  if (state.project.projectId !== state.session.projectId) throw new Error('project and session scopes must share projectId')
  if (state.session.parentDocumentId !== state.project.documentId) throw new Error('session scope must point to project document')
}

export function createContextScopesState(input: {
  document: Pick<ContextDocument, 'id' | 'sessionId' | 'projectId' | 'revision' | 'updatedAt'>
  projectDocumentId?: string
  projectRevision?: number
  activeScope?: 'project' | 'session'
}): RuntimeContextScopesState {
  const projectDocumentId = input.projectDocumentId ?? `project-context:${input.document.projectId}`
  const projectRevision = input.projectRevision ?? 0
  const project: RuntimeContextScopeRef = {
    scope: 'project', projectId: input.document.projectId, documentId: projectDocumentId, revision: projectRevision,
  }
  const session: RuntimeContextScopeRef = {
    scope: 'session', projectId: input.document.projectId, sessionId: input.document.sessionId,
    documentId: input.document.id, revision: input.document.revision,
    parentDocumentId: project.documentId, parentRevision: project.revision,
  }
  const state: RuntimeContextScopesState = {
    revision: Math.max(project.revision, session.revision), activeScope: input.activeScope ?? 'session', project, session, updatedAt: input.document.updatedAt,
  }
  validateContextScopes(state)
  return clone(state)
}

export function updateSessionContextScope(
  state: RuntimeContextScopesState,
  document: Pick<ContextDocument, 'id' | 'sessionId' | 'projectId' | 'revision' | 'updatedAt'>,
): RuntimeContextScopesState {
  if (document.projectId !== state.project.projectId) throw new Error('session document belongs to another project')
  const next = createContextScopesState({
    document,
    projectDocumentId: state.project.documentId,
    projectRevision: state.project.revision,
    activeScope: state.activeScope,
  })
  next.revision = Math.max(state.revision + 1, next.revision)
  return clone(next)
}

export function contextScopeForDocument(state: RuntimeContextScopesState, documentId: string): RuntimeContextScopeRef | undefined {
  if (state.project.documentId === documentId) return clone(state.project)
  if (state.session.documentId === documentId) return clone(state.session)
  return undefined
}
