import { createHash } from 'node:crypto'
import type { RuntimeCapabilityAuthorization, RuntimeCapabilityBinding, RuntimeCapabilityProjection, RuntimeControlDecision, RuntimeExecutionState, RuntimeRequestBinding, RuntimeTaskControl } from '#protocol/runtime-protocol'
import type { LlmToolDefinition } from '#util/llm'

export interface RuntimeCapability extends RuntimeCapabilityBinding {
  definition: LlmToolDefinition
  available: boolean
  unavailableReason?: string
}

const decisions: RuntimeControlDecision[] = ['continue', 'propose_plan', 'tool_call', 'ask_user', 'wait', 'propose_diff', 'reflect', 'finish']
const supportTools = new Set(['get_child_task', 'read_child_result', 'consume_child_result', 'cancel_child_task', 'respond_child_task', 'create_wait_deadline', 'read_wait_signal', 'request_planning', 'search_resources', 'load_resources', 'read_runtime_artifact', 'recall_context', 'read_system_variables', 'read_skill_resource', 'submit_branch_evidence', 'take_over_child_task', 'verify_mcp_side_effect', 'resume_mcp_input', 'resume_mcp_write_input', 'resume_workflow'])
const delegationTools = new Set(['get_child_task', 'read_child_result', 'consume_child_result', 'cancel_child_task', 'respond_child_task', 'create_wait_deadline', 'read_wait_signal', 'read_runtime_artifact'])
const evidenceTools = new Set([...delegationTools, 'submit_branch_evidence', 'recall_context', 'search_resources', 'request_planning', 'verify_mcp_side_effect'])
const mutatingPermissions = new Set(['filesystem:write', 'filesystem:delete', 'process:execute'])

/** Host contracts constrain access; descriptive text and Skill allowed-tools never grant it. */
export function capabilityAccessDenial(
  contract: { permissions: readonly string[]; sideEffects?: 'none' | 'workspace-write' | 'external' },
  granted: ReadonlySet<string>,
  readOnly = false,
): 'child_readonly' | 'permission_denied' | undefined {
  if (readOnly && ((contract.sideEffects ?? 'none') !== 'none' || contract.permissions.some(permission => mutatingPermissions.has(permission)))) return 'child_readonly'
  if (contract.permissions.some(permission => !granted.has(permission))) return 'permission_denied'
  return undefined
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]))
  return value
}

export function capabilityHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

export class RuntimeCapabilityError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'RuntimeCapabilityError' }
}

export function runtimeExecutionState(task: RuntimeTaskControl): RuntimeExecutionState {
  const pending = task.tasks.filter(node => node.status !== 'completed')
  const completed = new Set(task.tasks.filter(node => node.status === 'completed').map(node => node.id))
  const branchBlocks = new Set(task.branchBlocks?.flatMap(block => block.taskIds))
  const assigned = new Set(task.childAssignments?.filter(item => item.state === 'delegated').map(item => item.planTaskId))
  const unblocked = pending.filter(node => !branchBlocks.has(node.id) && node.dependsOn.every(id => completed.has(id)))
  const ready = unblocked.filter(node => !assigned.has(node.id))
  const collecting = task.branchBlocks?.some(block => block.evidenceRequest?.sourceKinds.some(kind => ['tool', 'memory', 'child-agent'].includes(kind)))
  const phase = task.planning?.required ? 'planning' : !task.tasks.length ? 'direct' : !pending.length ? 'verification'
    : !ready.length ? collecting ? 'evidence' : unblocked.length ? 'delegation' : 'blocked' : ready[0]!.phase ?? 'execution'
  const parents = new Map(task.childAssignments?.filter(item => item.state === 'parent' && item.takeoverId).map(item => [item.planTaskId, item]))
  const first = ready[0]
  const takeover = first && (first.phase ?? 'execution') === phase ? parents.get(first.id) : undefined
  const active = takeover ? [first!] : ready.filter(node => !parents.has(node.id) && (node.phase ?? 'execution') === phase)
  const allowedDecisions: RuntimeControlDecision[] = phase === 'planning' ? ['continue', 'propose_plan', 'ask_user', 'reflect']
    : phase === 'human_input' ? ['ask_user', 'propose_plan']
      : phase === 'blocked' ? ['continue', 'propose_plan', 'ask_user', 'wait', 'reflect']
        : phase === 'delegation' || phase === 'evidence' ? ['continue', 'propose_plan', 'tool_call', 'ask_user', 'wait', 'reflect']
          : decisions.filter(decision => decision !== 'finish' || pending.length === 0)
  if (phase === 'planning' && task.tasks.length) allowedDecisions.push('resume_plan')
  if (active.length) allowedDecisions.push('complete_plan_nodes')
  return { phase, planRevision: task.planRevision, readyTaskIds: ready.map(node => node.id), activeTaskIds: active.map(node => node.id),
    blockedTaskIds: pending.filter(node => !ready.includes(node)).map(node => node.id),
    ...(takeover ? { parentTakeover: { planTaskId: takeover.planTaskId, childId: takeover.childId, takeoverId: takeover.takeoverId! } } : {}),
    allowedDecisions }
}

export function hasRunnableBranch(task: RuntimeTaskControl): boolean {
  const execution = runtimeExecutionState(task)
  return execution.readyTaskIds.length > 0 || execution.phase === 'delegation' || execution.phase === 'evidence'
}

export function runtimeHumanQuestionTargets(task: RuntimeTaskControl, execution: RuntimeExecutionState): string[] {
  if (execution.phase === 'human_input') return execution.activeTaskIds
  const blocked = new Set(task.branchBlocks?.flatMap(block => block.taskIds))
  const delegated = task.childAssignments?.filter(item => item.state === 'delegated' && !blocked.has(item.planTaskId)) ?? []
  return [...new Set([task.taskId, ...execution.activeTaskIds, ...delegated.map(item => item.planTaskId)])]
}

export function runtimeCapabilityBinding(capability: RuntimeCapability): RuntimeCapabilityBinding {
  const { definition: _definition, available: _available, unavailableReason: _reason, ...result } = capability
  return result
}

export function selectRuntimeCapabilities(task: RuntimeTaskControl, capabilities: readonly RuntimeCapability[]): RuntimeCapability[] {
  const execution = runtimeExecutionState(task)
  if (execution.phase === 'planning' || execution.phase === 'human_input' || execution.phase === 'blocked') return []
  const taskIds = new Set(execution.activeTaskIds)
  const grants = new Set(task.tasks.filter(node => taskIds.has(node.id)).flatMap(node => node.capabilityIds))
  const evidenceTasks = new Set(task.branchBlocks?.filter(block => block.evidenceRequest?.sourceKinds.includes('tool')).flatMap(block => block.taskIds))
  const evidenceGrants = new Set(task.tasks.filter(node => evidenceTasks.has(node.id)).flatMap(node => node.capabilityIds))
  return capabilities.filter(capability => {
    if (!capability.available) return false
    if (execution.parentTakeover && capability.name === 'delegate_task') return false
    if (execution.phase === 'delegation') return delegationTools.has(capability.name)
    const readonlyPhase = execution.phase === 'investigation' || execution.phase === 'verification' || execution.phase === 'evidence'
    if (readonlyPhase && (capability.sideEffects !== 'none' || capability.permissions.some(p => mutatingPermissions.has(p)))) return false
    if (execution.phase === 'evidence') return evidenceTools.has(capability.name)
      || (capability.name !== 'delegate_task' && (evidenceGrants.has(capability.capabilityId) || evidenceGrants.has(capability.name)))
    return execution.phase === 'direct' || supportTools.has(capability.name) || grants.has(capability.capabilityId) || grants.has(capability.name)
  })
}

export function projectRuntimeCapabilities(task: RuntimeTaskControl, request: RuntimeRequestBinding, capabilities: readonly RuntimeCapability[]): RuntimeCapabilityProjection {
  const body = { version: 1 as const, request, execution: runtimeExecutionState(task), bindings: selectRuntimeCapabilities(task, capabilities).map(runtimeCapabilityBinding) }
  return { ...body, id: capabilityHash(body) }
}

export function assertRuntimeDecision(projection: RuntimeCapabilityProjection, decision: RuntimeControlDecision): void {
  if (!projection.execution.allowedDecisions.includes(decision)) throw new RuntimeCapabilityError('RUNTIME_PHASE_DECISION_FORBIDDEN', `${decision} is not allowed in ${projection.execution.phase}`)
}

export function assertRuntimeCapabilityCall(input: {
  name: string
  authorization?: RuntimeCapabilityAuthorization
  request: Pick<RuntimeRequestBinding, 'sessionId' | 'taskId' | 'runId'>
  task: RuntimeTaskControl
  capabilities: readonly RuntimeCapability[]
}): RuntimeCapabilityBinding {
  const authorization = input.authorization
  if (!authorization) throw new RuntimeCapabilityError('RUNTIME_CAPABILITY_AUTHORIZATION_MISSING', 'pending action has no bound model capability projection')
  const { projection } = authorization
  const { id, ...body } = projection
  if (id !== capabilityHash(body)) throw new RuntimeCapabilityError('RUNTIME_CAPABILITY_PROJECTION_INVALID', 'capability projection integrity check failed')
  if (['sessionId', 'taskId', 'runId'].some(key => projection.request[key as keyof typeof input.request] !== input.request[key as keyof typeof input.request])) throw new RuntimeCapabilityError('RUNTIME_CAPABILITY_REQUEST_MISMATCH', 'action belongs to another task or run')
  if (authorization.admittedStateRevision !== input.task.stateRevision || capabilityHash(projection.execution) !== capabilityHash(runtimeExecutionState(input.task))) throw new RuntimeCapabilityError('RUNTIME_CAPABILITY_STATE_STALE', 'action stage, plan or admitted state has changed')
  assertRuntimeDecision(projection, 'tool_call')
  const expected = projection.bindings.find(capability => capability.name === input.name)
  if (!expected) throw new RuntimeCapabilityError('RUNTIME_ENVELOPE_TOOL_UNAUTHORIZED', `tool is outside the bound request projection: ${input.name}`)
  const current = selectRuntimeCapabilities(input.task, input.capabilities).find(capability => capability.name === input.name)
  if (!current) throw new RuntimeCapabilityError('RUNTIME_CAPABILITY_REVOKED', `tool is no longer permitted in this stage: ${input.name}`)
  if (capabilityHash(expected) !== capabilityHash(runtimeCapabilityBinding(current))) throw new RuntimeCapabilityError('RUNTIME_CAPABILITY_VERSION_STALE', `tool schema, implementation or permission contract changed: ${input.name}`)
  return expected
}
