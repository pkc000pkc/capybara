import { Ajv } from 'ajv'
import { CONTEXT_CLASSIFICATION_SCHEMA } from '#core/context-classification'
import { capabilityHash } from '#core/runtime-capability-projection'
import type { ControlEnvelopeV2, RuntimeControlDecision, RuntimeEnvelope, RuntimeTaskControl, RuntimePlanAmendment, RuntimePlanProgress, RuntimePlanProposal, RuntimePlanTask, RuntimeRequestBinding } from '#protocol/runtime-protocol'
import { CONTEXT_DIFF_OPERATIONS, CONTEXT_TREE_OPERATIONS } from '#protocol/runtime-protocol'

const text = { type: 'string', minLength: 1, pattern: '\\S' }
const texts = { type: 'array', items: text, uniqueItems: true }
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object', additionalProperties: false, required, properties,
})
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] })
const task = object({
  id: text, title: text, dependsOn: texts,
  completionConditions: { ...texts, minItems: 1 }, owner: text, capabilityIds: texts,
  requiredActions: texts, evidenceRefs: texts, status: { enum: ['pending', 'completed'] },
  phase: { enum: ['human_input', 'investigation', 'execution', 'verification'] },
}, ['id', 'title', 'dependsOn', 'completionConditions', 'owner', 'capabilityIds', 'requiredActions', 'evidenceRefs', 'status'])
const planProposalSchema = (requiredActions: object, revision?: number) => nullable(object({
  basePlanRevision: revision === undefined ? { type: 'integer', minimum: 0 } : { const: revision }, goal: text,
  tasks: { type: 'array', minItems: 1, items: { ...task, properties: { ...task.properties, requiredActions } } },
}))
const { requiredActions: _actions, evidenceRefs: _evidence, status: _status, ...newTaskFields } = task.properties
const nonemptyTexts = { ...texts, minItems: 1, maxItems: 16 }
const planAmendmentSchema = (revision?: number) => nullable({
  ...object({
    basePlanRevision: revision === undefined ? { type: 'integer', minimum: 1 } : { const: revision },
    addTasks: { type: 'array', minItems: 1, maxItems: 8, items: object(newTaskFields, task.required.filter(key => key in newTaskFields)) },
    updateTasks: { type: 'array', minItems: 1, maxItems: 16, items: {
      ...object({ id: text, addCapabilityIds: nonemptyTexts, addDependsOn: nonemptyTexts, addCompletionConditions: nonemptyTexts }, ['id']),
      anyOf: ['addCapabilityIds', 'addDependsOn', 'addCompletionConditions'].map(field => ({ required: [field] })),
    } },
  }, ['basePlanRevision']),
  anyOf: [{ required: ['addTasks'] }, { required: ['updateTasks'] }],
})
const classification = CONTEXT_CLASSIFICATION_SCHEMA
const documentDiffPayload = object({ body: { type: 'string' }, evidenceRefs: { ...texts, minItems: 1 }, status: { enum: ['active', 'superseded', 'archived'] }, classification,
  title: { ...text, maxLength: 200 }, parentNodeId: text, beforeNodeId: nullable(text), childIds: { ...texts, minItems: 2 } }, [])
const documentDiff = { ...object({
  diffVersion: { enum: [1, 2] },
  scope: { enum: ['project', 'session'] }, sourceScope: { enum: ['project', 'session'] },
  documentId: text, baseRevision: { type: 'integer', minimum: 0 },
  projectionId: text, projectionHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  targetEntryHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  targetNodeHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  target: object({ section: { const: 'information' }, entryId: text, headingPath: texts, nodeId: text }, ['section']),
  operation: { enum: [...CONTEXT_DIFF_OPERATIONS] },
  payload: documentDiffPayload,
  candidateId: text, classification, idempotencyKey: text,
}, ['scope', 'documentId', 'baseRevision', 'projectionId', 'projectionHash', 'target', 'operation', 'payload', 'candidateId', 'idempotencyKey']),
  allOf: [{ if: { properties: { operation: { enum: [...CONTEXT_TREE_OPERATIONS] } }, required: ['operation'] },
    then: { required: ['diffVersion', 'targetNodeHash'], properties: { diffVersion: { const: 2 },
      target: { type: 'object', required: ['nodeId'] } } },
    else: { properties: { target: { type: 'object', properties: { nodeId: false } },
      payload: { type: 'object', properties: { title: false, parentNodeId: false, beforeNodeId: false, childIds: false } } } } }],
}
export const RUNTIME_DOCUMENT_DIFF_SCHEMA = documentDiff
const modelDocumentDiff = { ...documentDiff, properties: { ...documentDiff.properties, payload: { ...documentDiffPayload, required: ['evidenceRefs'] } } }
const plannedDocumentDiff = { ...modelDocumentDiff, properties: { ...modelDocumentDiff.properties, planTaskId: text } }

const controlDecisions: RuntimeControlDecision[] = ['continue', 'propose_plan', 'resume_plan', 'complete_plan_nodes', 'tool_call', 'ask_user', 'wait', 'propose_diff', 'reflect', 'finish']
const askUserAction = object({ kind: { const: 'ask_user' }, question: text, blockingTaskIds: { ...texts, minItems: 1 } })
const completionCheckProperties = { taskId: text, requiredEvidenceRefs: texts, requiredActions: texts,
  unresolvedUncertaintyIds: texts, summary: { type: 'string' } }
const completionCheck = (requiredActions: object, unresolvedUncertaintyIds: object = texts) =>
  nullable(object({ ...completionCheckProperties, requiredActions, unresolvedUncertaintyIds }))
const quoteTarget = { type: 'string', maxLength: 512, pattern: '^/(?:[^~/]|~[01]|/)*$' }
const fileQuotes = { type: 'array', maxItems: 32, items: { oneOf: [
  object({ scope: { enum: ['project', 'session'] }, evidenceId: text, target: quoteTarget }),
  object({ scope: { const: 'session' }, readArtifactId: text, target: quoteTarget }),
] } }
const reasoningNextStep = { type: ['string', 'null'], maxLength: 240 }
export interface PlanProgressBinding {
  planRevision: number
  activeTaskIds: readonly string[]
  foreignActionRefs?: ReadonlyMap<string, readonly string[]>
}
const planProgressSchema = (binding?: PlanProgressBinding) => nullable(object({
  basePlanRevision: binding ? { const: binding.planRevision } : { type: 'integer', minimum: 0 },
  nodes: { type: 'array', minItems: 1, maxItems: Math.min(16, binding?.activeTaskIds.length ?? 16),
    items: {
      ...object({ id: binding ? { enum: binding.activeTaskIds } : text,
        actionRefs: { ...texts, maxItems: 32 }, evidenceRefs: { ...texts, maxItems: 32 } }),
      ...(binding?.foreignActionRefs?.size ? { allOf: [...binding.foreignActionRefs].map(([id, refs]) => ({
        if: { properties: { id: { const: id } } },
        then: { properties: { actionRefs: { type: 'array', items: { not: { enum: refs } } } } },
      })) } : {}),
    },
  },
}))
const planProgress = planProgressSchema()
const waitScope = { ...texts, minItems: 1, maxItems: 32 }
const waitSpec = (blockingTaskIds: object = waitScope) => nullable(object({
  reason: text, signalType: { enum: ['runtime', 'tool', 'external', 'user'] },
  correlationIds: { ...texts, minItems: 1 }, condition: object({ eventType: text, status: text }, ['eventType']),
  deadlineRef: nullable(text), blockingTaskIds,
}, ['reason', 'signalType', 'correlationIds', 'condition', 'deadlineRef']))

const envelopeProperties = {
  envelopeVersion: { const: 2 },
  binding: object({ sessionId: text, taskId: text, runId: text, requestId: text, stateRevision: { type: 'integer', minimum: 0 } }),
  decision: { enum: controlDecisions },
  userMessage: { type: 'string' },
  actions: { type: 'array', items: { oneOf: [
    object({ kind: { const: 'tool_call' }, toolName: text, arguments: { type: 'object' } }),
    askUserAction,
  ] } },
  planProposal: planProposalSchema(texts),
  candidateDiffs: { type: 'array', items: plannedDocumentDiff },
  evidenceRequests: { type: 'array', items: object({ id: text, question: text, sourceKinds: { type: 'array', uniqueItems: true, items: { enum: ['tool', 'user', 'external', 'memory', 'child-agent'] } }, relatedTaskIds: texts, targetCandidateId: text }, ['id', 'question', 'sourceKinds', 'relatedTaskIds']) },
  uncertainties: { type: 'array', items: object({ id: text, statement: text, blocking: { type: 'boolean' }, relatedTaskIds: texts, evidenceRefs: texts }) },
  waitSpec: waitSpec(),
  completionCheck: completionCheck(texts),
}
export const CONTROL_ENVELOPE_V2_SCHEMA = object({ ...envelopeProperties, fileQuotes, reasoningNextStep, planProgress,
  planAmendment: planAmendmentSchema() }, Object.keys(envelopeProperties))

const nativePayloads = [
  ['propose_plan', 'planProposal', false], ['complete_plan_nodes', 'planProgress', false],
  ['propose_diff', 'candidateDiffs', true], ['wait', 'waitSpec', false],
  ['finish', 'completionCheck', false], ['ask_user', 'actions', true],
] as const

export function nativeControlEnvelopeSchema(allowedDecisions: readonly RuntimeControlDecision[] = controlDecisions,
  hasCompletedActions = true, allowFileQuotes = false, allowPlannedDiffs = false, askUserTaskIds?: readonly string[], progressBinding?: PlanProgressBinding,
  rootTaskId?: string, requestBinding?: RuntimeRequestBinding) {
  const exclusiveScope = (schema: object) => rootTaskId ? { ...schema,
    if: { type: 'array', contains: { const: rootTaskId } }, then: { type: 'array', maxItems: 1 } } : schema
  const projectedAsk = askUserTaskIds?.length
    ? { ...askUserAction, properties: { ...askUserAction.properties,
      blockingTaskIds: exclusiveScope({ ...texts, minItems: 1, items: { enum: askUserTaskIds } }) } }
    : askUserAction
  const projectedDiff = allowPlannedDiffs ? {
    ...plannedDocumentDiff,
    required: [...plannedDocumentDiff.required, 'planTaskId'],
    properties: { ...plannedDocumentDiff.properties, planTaskId: progressBinding?.activeTaskIds.length ? { enum: progressBinding.activeTaskIds } : text },
  } : modelDocumentDiff
  const amendmentRevision = progressBinding?.planRevision
  const canAmendPlan = amendmentRevision !== undefined && amendmentRevision > 0 && allowedDecisions.includes('propose_plan')
  const properties = {
    ...envelopeProperties,
    ...(requestBinding ? { binding: { ...envelopeProperties.binding, const: requestBinding } } : {}),
    planProposal: planProposalSchema(!rootTaskId && !hasCompletedActions ? { ...texts, maxItems: 0 } : texts, progressBinding?.planRevision),
    ...(canAmendPlan ? { planAmendment: planAmendmentSchema(amendmentRevision) } : {}),
    candidateDiffs: { type: 'array', items: projectedDiff },
    ...(allowFileQuotes && allowedDecisions.includes('finish') ? { fileQuotes } : {}),
    ...(allowedDecisions.includes('continue') ? { reasoningNextStep } : {}),
    ...(allowedDecisions.includes('complete_plan_nodes') ? { planProgress: progressBinding?.activeTaskIds.length ? planProgressSchema(progressBinding) : planProgress } : {}),
    decision: { enum: allowedDecisions.filter(decision => decision !== 'tool_call') },
    actions: { type: 'array', maxItems: 1, items: projectedAsk },
    completionCheck: completionCheck(hasCompletedActions ? texts : { ...texts, maxItems: 0 }, { ...texts, maxItems: 0 }),
    ...(rootTaskId && allowedDecisions.includes('wait') ? { waitSpec: waitSpec(exclusiveScope(waitScope)) } : {}),
  }
  const allOf = []
  if (canAmendPlan) allOf.push({ if: { properties: { decision: { const: 'propose_plan' } } },
    then: { oneOf: [
      { required: ['planProposal'], properties: { planProposal: { type: 'object' }, planAmendment: { type: 'null' } } },
      { required: ['planAmendment'], properties: { planProposal: { type: 'null' }, planAmendment: { type: 'object' } } },
    ] }, else: { properties: { planProposal: { type: 'null' }, planAmendment: { type: 'null' } } } })
  for (const [decision, field, isArray] of nativePayloads) {
    if (field === 'planProposal' && canAmendPlan) continue
    const empty = isArray ? { type: 'array', maxItems: 0 } : { type: 'null' }
    if (!allowedDecisions.includes(decision)) {
      if (field === 'planProgress') continue
      Object.assign(properties, { [field]: isArray ? { ...properties[field], ...empty } : empty })
      continue
    }
    const populated = isArray ? { type: 'array', minItems: 1 } : { type: 'object' }
    allOf.push({ if: { properties: { decision: { const: decision } } },
      then: { required: [field], properties: { [field]: populated,
        ...(decision === 'ask_user' ? { userMessage: { type: 'string', pattern: '\\S' } } : {}),
        ...(decision === 'complete_plan_nodes' ? { evidenceRequests: { type: 'array', maxItems: 0 }, uncertainties: { type: 'array', maxItems: 0 } } : {}) } },
      else: { properties: { [field]: empty } } })
  }
  if (allowedDecisions.includes('resume_plan')) allOf.push({ if: { properties: { decision: { const: 'resume_plan' } } },
    then: { properties: { userMessage: { const: '' }, evidenceRequests: { type: 'array', maxItems: 0 }, uncertainties: { type: 'array', maxItems: 0 },
      reasoningNextStep: { type: 'null' } } }, else: {} })
  if (allowFileQuotes && allowedDecisions.includes('finish')) allOf.push({ if: { properties: { decision: { const: 'finish' } } },
    then: {}, else: { properties: { fileQuotes: { type: 'array', maxItems: 0 } } } })
  return { ...CONTROL_ENVELOPE_V2_SCHEMA, properties, ...(allOf.length ? { allOf } : {}) }
}

const validator = new Ajv({ allErrors: true }).compile(CONTROL_ENVELOPE_V2_SCHEMA)

const completionRepairAdvice = {
  RUNTIME_COMPLETION_CHECK_SCHEMA: `For finish, set completionCheck to an object with exactly ${Object.keys(completionCheckProperties).join(', ')}. Copy the taskId from the current binding, use registered evidence and actual action references, and set unresolvedUncertaintyIds to []. Only the runtime verifies completion. For other decisions use completionCheck: null.`,
  RUNTIME_COMPLETION_CHECK_TASK: 'Copy completionCheck.taskId from the current request_binding, and keep the accepted obligations.',
  RUNTIME_COMPLETION_CHECK_BLOCKED: 'Keep genuine blockers and choose an allowed decision that addresses them. Uncertainties the user should judge after delivery may stay in the answer with blocking: false. If nothing blocks the requested deliverable, use finish with unresolvedUncertaintyIds: [].',
} as const

export class CompletionProposalError extends Error {
  constructor(readonly code: keyof typeof completionRepairAdvice, message: string) {
    super(message)
  }

  get repairAdvice(): string { return completionRepairAdvice[this.code] }
}

const contextDiffRepairAdvice = {
  RUNTIME_CONTEXT_DIFF_CLASSIFICATION_SCHEMA: 'For a session-only diff, omit optional classification. When supplying classification, use durability, target, confidence, reason and projectAnchors; use projectAnchors: [] for session-only information. For project changes cite real project anchors and evidence.',
  RUNTIME_CONTEXT_DIFF_TREE_BINDING_SCHEMA: 'For add_entry, use target.headingPath, payload.body, the actual candidateId and payload.evidenceRefs. Use actual section titles. For content operations, omit target.nodeId and the structural payload fields. For structural edits, use diffVersion: 2 and the current visible target.nodeId and targetNodeHash.',
} as const

export class ContextDiffProposalError extends Error {
  constructor(readonly code: keyof typeof contextDiffRepairAdvice, message: string) { super(message) }
  get repairAdvice(): string { return contextDiffRepairAdvice[this.code] }
}

export class ControlPayloadError extends Error {
  readonly code = 'RUNTIME_CONTROL_PAYLOAD_CONFLICT'

  constructor(decision: RuntimeControlDecision, readonly field: string, readonly repairAdvice: string) {
    super(`${decision} requires its exclusive ${field}`)
  }
}

export class ControlEnvelopeFieldError extends Error {
  readonly code = 'RUNTIME_CONTROL_UNKNOWN_FIELD'

  constructor(message: string, readonly fields: string[]) { super(message) }

  get repairAdvice(): string {
    return `Remove unrecognized top-level fields ${JSON.stringify(this.fields)} from the control envelope. Use only top-level properties defined by the current output_schema.`
  }
}

function requireExclusivePayload(decision: RuntimeControlDecision, owner: RuntimeControlDecision, field: string, present: boolean, empty: 'null' | '[]'): void {
  if ((decision === owner) === present) return
  const advice = decision !== owner
    ? `For ${decision}, set ${field} to ${empty}. Only ${owner} uses ${field}. Keep the accepted plan and current request binding.`
    : `For ${owner}, supply ${field} from the current schema and actual runtime state. If its prerequisites are missing, choose a different allowed decision.`
  throw new ControlPayloadError(owner, field, advice)
}

export function parseControlEnvelopeV2(value: unknown): ControlEnvelopeV2 {
  if (!validator(value)) {
    const errors = validator.errors ?? []
    const message = `ControlEnvelopeV2 invalid: ${errors.map(error => `${error.instancePath} ${error.message}`).join('; ')}`
    if (errors.some(error => error.instancePath === '/completionCheck' || error.instancePath.startsWith('/completionCheck/')
      || (error.instancePath === '' && error.keyword === 'required' && error.params.missingProperty === 'completionCheck'))) {
      throw new CompletionProposalError('RUNTIME_COMPLETION_CHECK_SCHEMA', message)
    }
    if (errors.some(error => /^\/candidateDiffs\/\d+\/(?:payload\/)?classification(?:\/|$)/.test(error.instancePath))) {
      throw new ContextDiffProposalError('RUNTIME_CONTEXT_DIFF_CLASSIFICATION_SCHEMA', message)
    }
    if (errors.some(error => /^\/candidateDiffs\/\d+(?:\/|$)/.test(error.instancePath) && /\/allOf\/0\/(?:then|else)\//.test(error.schemaPath))) {
      throw new ContextDiffProposalError('RUNTIME_CONTEXT_DIFF_TREE_BINDING_SCHEMA', message)
    }
    const extra = errors.filter(error => error.instancePath === '' && error.keyword === 'additionalProperties')
    if (extra.length) {
      const fields = extra.slice(0, 8).map(error => error.params.additionalProperty)
        .filter((field): field is string => typeof field === 'string' && /^[A-Za-z][\w.-]{0,63}$/.test(field))
      if (fields.length) throw new ControlEnvelopeFieldError(message, fields)
    }
    throw new Error(message)
  }
  const envelope = value as unknown as ControlEnvelopeV2
  const { decision, actions, planProposal, planAmendment, planProgress: progress, candidateDiffs, waitSpec, completionCheck } = envelope
  if (decision === 'resume_plan' && (envelope.userMessage !== '' || envelope.evidenceRequests.length
    || envelope.uncertainties.length || envelope.reasoningNextStep != null)) {
    throw new ControlPayloadError(decision, 'resume_plan',
      'Use resume_plan with an empty userMessage, evidenceRequests: [], uncertainties: [] and no reasoningNextStep. It resumes the accepted plan without changing it.')
  }
  if (planAmendment && (decision !== 'propose_plan' || planProposal !== null)) {
    throw new ControlPayloadError('propose_plan', 'planAmendment',
      'Use planAmendment only for propose_plan, with planProposal: null. Submit one plan form per response.')
  }
  if (!planAmendment) requireExclusivePayload(decision, 'propose_plan', 'planProposal', planProposal !== null, 'null')
  requireExclusivePayload(decision, 'complete_plan_nodes', 'planProgress', progress != null, 'null')
  if (progress) {
    if (envelope.evidenceRequests.length || envelope.uncertainties.length) {
      const field = envelope.evidenceRequests.length ? 'evidenceRequests' : 'uncertainties'
      throw new ControlPayloadError(decision, field,
        'For complete_plan_nodes set evidenceRequests: [] and uncertainties: []. The host retains existing requests and uncertainties. Submit only planProgress with this plan revision and active nodes with their receipts. Handle any new request or uncertainty in a separate allowed decision.')
    }
    if (new Set(progress.nodes.map(node => node.id)).size !== progress.nodes.length) {
      throw new ControlPayloadError(decision, 'planProgress.nodes',
        'In planProgress.nodes include each active node ID only once. Put all actual actionRefs and evidenceRefs for that node in the same object.')
    }
  }
  requireExclusivePayload(decision, 'propose_diff', 'candidateDiffs', candidateDiffs.length > 0, '[]')
  requireExclusivePayload(decision, 'wait', 'waitSpec', waitSpec !== null, 'null')
  if ((decision === 'finish') !== (completionCheck !== null)) {
    throw new CompletionProposalError('RUNTIME_COMPLETION_CHECK_SCHEMA', 'finish requires its exclusive completionCheck')
  }
  if (decision === 'finish' && !envelope.userMessage.trim()) throw new Error('finish requires a visible userMessage')
  if (envelope.fileQuotes?.length && (decision !== 'finish' || new Set(envelope.fileQuotes.map(item => item.target)).size !== envelope.fileQuotes.length)) {
    throw new Error('fileQuotes requires finish and unique reply targets')
  }
  if (decision === 'tool_call') {
    if (!actions.length || actions.some((action) => action.kind !== 'tool_call')) throw new Error('tool_call requires only tool actions')
  } else if (decision === 'ask_user') {
    if (actions.length !== 1 || actions[0]?.kind !== 'ask_user') throw new Error('ask_user requires exactly one question')
    if (!envelope.userMessage.trim()) throw new ControlPayloadError('ask_user', 'userMessage',
      'For ask_user, copy actions[0].question into the nonempty top-level userMessage. Keep the one ask_user action and its blockingTaskIds. Use the current request binding.')
  } else if (actions.length) throw new Error('decision cannot carry execution actions')
  for (const field of ['uncertainties', 'evidenceRequests'] as const) {
    const ids = envelope[field].map((item) => item.id)
    if (new Set(ids).size !== ids.length) throw new Error(`${field} IDs must be unique`)
  }
  if ((decision === 'finish' || decision === 'ask_user') && envelope.evidenceRequests.length) throw new Error('decision cannot carry evidenceRequests')
  const scopedEvidence = envelope.evidenceRequests.some(request => request.relatedTaskIds.some(id => id !== envelope.binding.taskId))
  if (scopedEvidence && (decision !== 'continue' || envelope.evidenceRequests.length > 8 || envelope.evidenceRequests.some(request =>
    !request.relatedTaskIds.length || request.relatedTaskIds.length > 32 || request.relatedTaskIds.includes(envelope.binding.taskId)
    || !request.sourceKinds.length || request.id.length > 512 || request.question.length > 1000))) {
    throw new Error('scoped evidenceRequests require continue and bounded plan-node requests')
  }
  if (completionCheck?.taskId !== undefined && completionCheck.taskId !== envelope.binding.taskId) {
    throw new CompletionProposalError('RUNTIME_COMPLETION_CHECK_TASK', 'completionCheck task binding mismatch')
  }
  if (completionCheck?.unresolvedUncertaintyIds.length || (decision === 'finish' && envelope.uncertainties.some((item) => item.blocking))) {
    throw new CompletionProposalError('RUNTIME_COMPLETION_CHECK_BLOCKED', 'finish cannot carry blocking uncertainties')
  }
  return envelope
}

/** Adapt control intent once; sourceV2 retains the actual schema/binding for validation and replay. */
export function adaptControlEnvelopeV2(source: ControlEnvelopeV2): RuntimeEnvelope {
  return {
    envelopeVersion: 1,
    sessionId: source.binding.sessionId, runId: source.binding.runId, requestId: source.binding.requestId,
    decision: source.decision, actions: source.actions,
    candidateDiffs: source.candidateDiffs.map((diff) => ({
      ...diff, ...diff.payload, targetEntryId: diff.target.entryId, targetNodeId: diff.target.nodeId, headingPath: diff.target.headingPath,
      evidenceRefs: diff.payload.evidenceRefs ?? [],
    })),
    evidenceRequests: source.evidenceRequests,
    uncertainties: source.uncertainties.map((item) => ({ ...item, relatedCandidateIds: [] })),
    ...(source.waitSpec ? { waitSpec: { ...source.waitSpec, resumeCondition: JSON.stringify(source.waitSpec.condition) } } : {}),
    ...(source.completionCheck ? { completionCheck: {
      ...source.completionCheck, unresolvedUncertainties: source.completionCheck.unresolvedUncertaintyIds,
      // Legacy adapter's request flag is not a runtime verification result.
      verified: true,
    } } : {}),
    sourceV2: source,
  }
}

export function emptyTaskControl(taskId: string, goal: string): RuntimeTaskControl {
  return { taskId, stateRevision: 0, planRevision: 0, goal, tasks: [], requiredActions: [], requiredEvidenceRefs: [], uncertainties: [] }
}

export function requiresChildResult(node: RuntimePlanTask): boolean {
  return node.capabilityIds.includes('runtime:delegate_task') || node.capabilityIds.includes('delegate_task')
}

export function resumeRuntimePlan(current: RuntimeTaskControl): RuntimeTaskControl {
  if (!current.planning?.required || !current.tasks.length) throw new Error('RUNTIME_PLAN_RESUME_UNAVAILABLE')
  return { ...current, stateRevision: current.stateRevision + 1, planning: { required: false, reason: 'accepted plan resumed' } }
}

export function planProposalForProgress(current: RuntimeTaskControl, progress: RuntimePlanProgress, activeTaskIds: readonly string[]): RuntimePlanProposal {
  if (progress.basePlanRevision !== current.planRevision) throw new Error('RUNTIME_PLAN_REVISION_MISMATCH')
  const active = new Set(activeTaskIds)
  const updates = new Map(progress.nodes.map(node => [node.id, node]))
  const pending = new Set(current.tasks.filter(node => node.status === 'pending' && active.has(node.id)).map(node => node.id))
  if (updates.size !== progress.nodes.length || !updates.size || [...updates.keys()].some(id => !pending.has(id))) {
    throw new Error('RUNTIME_PLAN_PROGRESS_NODE_INACTIVE')
  }
  const tasks: RuntimePlanTask[] = current.tasks.map(node => {
    const update = updates.get(node.id)
    if (!update) return node
    return { ...node, status: 'completed', requiredActions: [...new Set([...node.requiredActions, ...update.actionRefs])],
      evidenceRefs: [...new Set([...node.evidenceRefs, ...update.evidenceRefs])] }
  })
  return { basePlanRevision: progress.basePlanRevision, goal: current.planGoal ?? current.goal, tasks }
}

export function planProposalForAmendment(current: RuntimeTaskControl, amendment: RuntimePlanAmendment): RuntimePlanProposal {
  if (amendment.basePlanRevision !== current.planRevision) throw new Error('RUNTIME_PLAN_REVISION_MISMATCH')
  if (!current.tasks.length) throw new Error('RUNTIME_PLAN_AMENDMENT_NO_PLAN')
  const items = amendment.updateTasks ?? []
  const updates = new Map(items.map(update => [update.id, update]))
  if (updates.size !== items.length) throw new Error('RUNTIME_PLAN_DUPLICATE_TASK')
  const pending = new Set(current.tasks.filter(node => node.status === 'pending').map(node => node.id))
  if (items.some(item => !pending.has(item.id))) throw new Error('RUNTIME_PLAN_AMENDMENT_NODE_NOT_PENDING')
  const append = (prior: string[], additions: string[] | undefined) => [...new Set([...prior, ...(additions ?? [])])]
  const tasks = current.tasks.map(node => {
    const update = updates.get(node.id)
    if (!update) return node
    return { ...node, capabilityIds: append(node.capabilityIds, update.addCapabilityIds),
      dependsOn: append(node.dependsOn, update.addDependsOn),
      completionConditions: append(node.completionConditions, update.addCompletionConditions) }
  })
  for (const node of amendment.addTasks ?? []) tasks.push({ ...node, status: 'pending', requiredActions: [], evidenceRefs: [] })
  if (capabilityHash(tasks) === capabilityHash(current.tasks)) throw new Error('RUNTIME_PLAN_UNCHANGED')
  return { basePlanRevision: current.planRevision, goal: current.planGoal ?? current.goal, tasks }
}

export function acceptRuntimePlan(
  current: RuntimeTaskControl,
  proposal: RuntimePlanProposal,
  verify: (actions: string[], evidence: string[]) => boolean,
  verifyTakeover?: (node: RuntimePlanTask) => boolean,
): RuntimeTaskControl {
  if (proposal.basePlanRevision !== current.planRevision) throw new Error('RUNTIME_PLAN_REVISION_MISMATCH')
  const nodes = new Map(proposal.tasks.map((item) => [item.id, item]))
  if (nodes.size !== proposal.tasks.length) throw new Error('RUNTIME_PLAN_DUPLICATE_TASK')
  if (nodes.has(current.taskId)) throw new Error('RUNTIME_PLAN_ROOT_ID_RESERVED')
  if (proposal.tasks.some(node => node.phase === 'human_input' && node.capabilityIds.length > 0)) {
    throw new Error('RUNTIME_PLAN_HUMAN_INPUT_CAPABILITIES')
  }
  const visited = new Set<string>(), visiting = new Set<string>()
  const blocked = new Set(current.branchBlocks?.flatMap(block => block.taskIds))
  const assigned = new Map(current.childAssignments?.map(item => [item.planTaskId, item.state]))
  const priorTasks = new Map(current.tasks.map(node => [node.id, node]))
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('RUNTIME_PLAN_DEPENDENCY_CYCLE')
    if (visited.has(id)) return
    const node = nodes.get(id)
    if (!node) throw new Error('RUNTIME_PLAN_DEPENDENCY_MISSING')
    visiting.add(id)
    for (const dependency of node.dependsOn) visit(dependency)
    visiting.delete(id); visited.add(id)
    const assignment = assigned.get(node.id)
    if (node.status === 'completed' && requiresChildResult(node) && !assignment && priorTasks.get(node.id)?.status !== 'completed') {
      throw new Error('RUNTIME_PLAN_DELEGATION_UNVERIFIED')
    }
    if (node.status === 'completed' && (blocked.has(node.id) || (assignment === 'parent' ? !verifyTakeover?.(node) : assignment && assignment !== 'accepted')
      || (node.phase === 'human_input' && !node.requiredActions.some(ref => ref.startsWith('human:')))
      || (!assignment && node.requiredActions.length + node.evidenceRefs.length === 0)
      || !verify(node.requiredActions, node.evidenceRefs)
      || node.dependsOn.some((dependency) => nodes.get(dependency)?.status !== 'completed'))) throw new Error('RUNTIME_PLAN_COMPLETION_UNVERIFIED')
  }
  for (const id of nodes.keys()) visit(id)
  for (const old of current.tasks) {
    const next = nodes.get(old.id)
    if (next && (blocked.has(old.id) || ['delegated', 'parent'].includes(assigned.get(old.id) ?? '')) && (next.owner !== old.owner || next.phase !== old.phase
      || JSON.stringify(next.dependsOn) !== JSON.stringify(old.dependsOn)
      || JSON.stringify(next.capabilityIds) !== JSON.stringify(old.capabilityIds))) throw new Error('RUNTIME_PLAN_BLOCKED_BRANCH_CHANGED')
    if (!next || (old.status === 'completed' && next.status !== 'completed')
      || (old.phase === 'human_input' && next.phase !== old.phase)
      || (requiresChildResult(old) && !requiresChildResult(next))
      || old.requiredActions.some((id) => !next.requiredActions.includes(id))
      || old.evidenceRefs.some((id) => !next.evidenceRefs.includes(id))
      || old.completionConditions.some((condition) => !next.completionConditions.includes(condition))) throw new Error('RUNTIME_PLAN_OBLIGATION_REMOVED')
  }
  if (current.tasks.length && !current.planning?.required) {
    const executionGraphHash = (tasks: RuntimePlanTask[]) => capabilityHash(tasks.map(node => ({ ...node, phase: node.phase ?? 'execution' })))
    if (executionGraphHash(proposal.tasks) === executionGraphHash(current.tasks)) throw new Error('RUNTIME_PLAN_UNCHANGED')
  }
  return {
    ...current, planGoal: proposal.goal, stateRevision: current.stateRevision + 1, planRevision: current.planRevision + 1,
    tasks: structuredClone(proposal.tasks), planning: { required: false, reason: 'plan accepted' },
    requiredActions: [...new Set([...current.requiredActions, ...proposal.tasks.flatMap((item) => item.requiredActions)])],
    requiredEvidenceRefs: [...new Set([...current.requiredEvidenceRefs, ...proposal.tasks.flatMap((item) => item.evidenceRefs)])],
  }
}
