import assert from 'node:assert/strict'
import test from 'node:test'

import { ContextDocumentEngine } from '#core/context-document-engine'
import { contextScopeForDocument, createContextScopesState, updateSessionContextScope, validateContextScopes } from '#core/context-scope'

test('project and session context scopes remain distinct and linked', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 'session-1', projectId: 'project-1', constitutionRevision: 'v2' })
  const state = createContextScopesState({ document: engine.snapshot() })
  assert.equal(state.activeScope, 'session')
  assert.equal(state.project.scope, 'project')
  assert.equal(state.session.scope, 'session')
  assert.equal(state.session.parentDocumentId, state.project.documentId)
  assert.equal(contextScopeForDocument(state, state.project.documentId)?.scope, 'project')
  validateContextScopes(state)
})

test('session revision changes do not erase the project scope identity', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 'session-2', projectId: 'project-2', constitutionRevision: 'v2' })
  const first = createContextScopesState({ document: engine.snapshot(), projectRevision: 4 })
  engine.setMessageCursor(2)
  const second = updateSessionContextScope(first, engine.snapshot())
  assert.equal(second.project.documentId, first.project.documentId)
  assert.equal(second.project.revision, 4)
  assert.ok(second.revision >= first.revision)
  assert.equal(second.session.parentRevision, 4)
})
