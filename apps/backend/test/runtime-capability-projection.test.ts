import assert from 'node:assert/strict'
import test from 'node:test'
import { emptyTaskControl } from '#core/runtime-control'
import { assertRuntimeCapabilityCall, assertRuntimeDecision, projectRuntimeCapabilities, runtimeExecutionState, selectRuntimeCapabilities, type RuntimeCapability } from '#core/runtime-capability-projection'
import type { RuntimeCapabilityAuthorization, RuntimeRequestBinding, RuntimeTaskControl } from '#protocol/runtime-protocol'

const request: RuntimeRequestBinding = { sessionId: 's', taskId: 't', runId: 'r', requestId: 'model-1', stateRevision: 0 }
function capability(name: string, sideEffects: RuntimeCapability['sideEffects'] = 'none'): RuntimeCapability {
  return { capabilityId: `project:${name}`, name, source: 'project', sourceVersion: 'source-v1', schemaHash: 'schema-v1', permissions: [], sideEffects, replay: 'safe',
    definition: { name, description: name, parameters: { type: 'object' } }, available: true }
}
function task(): RuntimeTaskControl {
  return { ...emptyTaskControl('t', '读取后写入'), planRevision: 1, tasks: [
    { id: 'read', title: '调查', phase: 'investigation', owner: 'parent', dependsOn: [], capabilityIds: ['project:read', 'project:write'], completionConditions: ['读到来源'], requiredActions: [], evidenceRefs: [], status: 'pending' },
    { id: 'write', title: '执行', phase: 'execution', owner: 'parent', dependsOn: ['read'], capabilityIds: ['project:write'], completionConditions: ['写入并验证'], requiredActions: [], evidenceRefs: [], status: 'pending' },
  ] }
}
const pool = [capability('read'), capability('write', 'workspace-write'), capability('other'), capability('request_planning')]

test('a required planning round has no execution tools and cannot finish or invoke a native action', () => {
  const current = task(); current.planning = { required: true, reason: '需要计划' }
  const projection = projectRuntimeCapabilities(current, request, pool)
  assert.deepEqual(projection.bindings, [])
  assert.equal(projection.execution.phase, 'planning')
  assert.doesNotThrow(() => assertRuntimeDecision(projection, 'propose_plan'))
  assert.throws(() => assertRuntimeDecision(projection, 'tool_call'), /not allowed in planning/)
  assert.throws(() => assertRuntimeDecision(projection, 'finish'), /not allowed in planning/)
})

test('the ready dependency frontier controls the phase and read phases exclude write permissions and side effects', () => {
  const current = task()
  const execution = runtimeExecutionState(current)
  assert.deepEqual(execution.activeTaskIds, ['read'])
  assert.deepEqual(execution.blockedTaskIds, ['write'])
  assert.ok(!execution.allowedDecisions.includes('finish'))
  assert.deepEqual(selectRuntimeCapabilities(current, pool).map(c => c.name), ['read', 'request_planning'])
  const disguised = capability('read'); disguised.permissions = ['process:execute']
  assert.ok(!selectRuntimeCapabilities(current, [disguised]).length)
  current.tasks[0]!.status = 'completed'; current.planRevision++
  assert.equal(runtimeExecutionState(current).phase, 'execution')
  assert.deepEqual(selectRuntimeCapabilities(current, pool).map(c => c.name), ['write', 'request_planning'])
  current.tasks[1]!.status = 'completed'; current.planRevision++
  assert.ok(runtimeExecutionState(current).allowedDecisions.includes('finish'))
})

test('authorization is bound to the actual request, plan, stage and admitted state', () => {
  const current = task(), projection = projectRuntimeCapabilities(current, request, pool)
  const authorization: RuntimeCapabilityAuthorization = { projection, admittedStateRevision: current.stateRevision }
  const check = (overrides: Partial<Parameters<typeof assertRuntimeCapabilityCall>[0]> = {}) => assertRuntimeCapabilityCall({ name: 'read', authorization, request, task: current, capabilities: pool, ...overrides })
  assert.equal(check().capabilityId, 'project:read')
  assert.throws(() => check({ name: 'write' }), /outside the bound request/)
  assert.throws(() => check({ request: { ...request, runId: 'another-run' } }), /another task or run/)
  current.stateRevision++
  assert.throws(() => check(), /admitted state has changed/)
  current.stateRevision--; current.tasks[0]!.status = 'completed'; current.planRevision++
  assert.throws(() => check(), /stage, plan/)
})

test('schema, source and permission changes revoke queued calls even when the tool name stays the same', () => {
  const current = task(), projection = projectRuntimeCapabilities(current, request, pool)
  const authorization = { projection, admittedStateRevision: current.stateRevision }
  for (const change of [{ sourceVersion: 'source-v2' }, { schemaHash: 'schema-v2' }, { permissions: ['filesystem:read'] }]) {
    const changed = pool.map(c => c.name === 'read' ? { ...c, ...change } : c)
    assert.throws(() => assertRuntimeCapabilityCall({ name: 'read', authorization, request, task: current, capabilities: changed }), /contract changed/)
  }
  assert.throws(() => assertRuntimeCapabilityCall({ name: 'read', authorization, request, task: current, capabilities: pool.map(c => ({ ...c, available: false })) }), /no longer permitted/)
})

test('unbound or tampered saved actions cannot manufacture capability grants', () => {
  const current = task(), projection = projectRuntimeCapabilities(current, request, pool)
  assert.throws(() => assertRuntimeCapabilityCall({ name: 'read', request, task: current, capabilities: pool }), /no bound model capability/)
  const forged = structuredClone(projection); forged.bindings.push({ ...forged.bindings[0]!, name: 'write', capabilityId: 'project:write' })
  assert.throws(() => assertRuntimeCapabilityCall({ name: 'write', authorization: { projection: forged, admittedStateRevision: 0 }, request, task: current, capabilities: pool }), /integrity check/)
})
