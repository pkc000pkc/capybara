import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { Ajv } from 'ajv'
import { acceptRuntimePlan, ControlPayloadError, emptyTaskControl, nativeControlEnvelopeSchema, parseControlEnvelopeV2, planProposalForAmendment, planProposalForProgress } from '#core/runtime-control'
import { runtimeExecutionState } from '#core/runtime-capability-projection'
import { parseModelOutput, renderFileQuotes } from '#core/runtime-loop-utils'
import { buildV2RuntimePrompt, renderV2Prompt, v2PromptManifest, V2_CONSTITUTION_PROMPT } from '#core/v2-prompts'
import { ContextDocumentEngine } from '#core/context-document-engine'
import type { ControlEnvelopeV2, RuntimePlanTask } from '#protocol/runtime-protocol'

export function envelope(overrides: Partial<ControlEnvelopeV2> = {}): ControlEnvelopeV2 {
  return {
    envelopeVersion: 2,
    binding: { sessionId: 'session-1', taskId: 'task-1', runId: 'run-1', requestId: 'request-1', stateRevision: 0 },
    decision: 'continue', userMessage: '', actions: [], planProposal: null,
    candidateDiffs: [], evidenceRequests: [], uncertainties: [], waitSpec: null, completionCheck: null,
    ...overrides,
  }
}

function task(overrides: Partial<RuntimePlanTask> = {}): RuntimePlanTask {
  return { id: 'check', title: 'Check input', dependsOn: [], completionConditions: ['input checked'], owner: 'parent', capabilityIds: [], requiredActions: ['tool:read'], evidenceRefs: [], status: 'pending', ...overrides }
}

test('V2 finish accepts disclosed nonblocking uncertainty and advertises an empty blocker list', () => {
  const value = envelope({ decision: 'finish', userMessage: '两方主张均已记录，取舍留待业务判断。',
    uncertainties: [{ id: 'knowledge-gap', statement: '两份政策的优先级未知。', blocking: false, relatedTaskIds: [], evidenceRefs: [] }],
    completionCheck: { taskId: 'task-1', requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '结果已核对' } })
  const parsed = parseModelOutput(JSON.stringify(value))
  assert.equal(parsed.status, 'completed')
  assert.equal(parsed.content, value.userMessage)
  assert.deepEqual(parsed.envelope?.sourceV2, value)
  assert.equal('verified' in value.completionCheck!, false)
  const acceptNative = new Ajv().compile(nativeControlEnvelopeSchema(['finish'], false))
  assert.ok(acceptNative(value))
  const blocked = { ...value, completionCheck: { ...value.completionCheck!, unresolvedUncertaintyIds: ['knowledge-gap'] } }
  assert.equal(acceptNative(blocked), false)
  assert.throws(() => parseControlEnvelopeV2(blocked), /finish cannot carry blocking uncertainties/)
})

test('V2 control rejects missing fields, unexpected authority and conflicting intents', () => {
  const { actions: _actions, ...missing } = envelope()
  assert.throws(() => parseControlEnvelopeV2(missing), /actions/)
  assert.throws(() => parseControlEnvelopeV2({ ...envelope(), verified: true }), /additional properties/)
  assert.throws(() => parseControlEnvelopeV2(envelope({ binding: { ...envelope().binding, stateRevision: 0.5 } })), /integer/)
  assert.throws(() => parseControlEnvelopeV2(envelope({ decision: 'ask_user', userMessage: '问题', actions: [{ kind: 'tool_call', toolName: 'read', arguments: {} }] })), /exactly one question/)
  assert.throws(() => parseControlEnvelopeV2(envelope({ decision: 'finish' })), /completionCheck/)
  assert.throws(() => parseControlEnvelopeV2(envelope({ decision: 'finish', completionCheck: { taskId: 'task-1', requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: 'summary' } })), /visible userMessage/)
  assert.throws(() => parseControlEnvelopeV2(envelope({ actions: [{ kind: 'ask_user', question: '目录？', blockingTaskIds: ['task-1'] }] })), /execution actions/)
  assert.throws(() => parseControlEnvelopeV2(envelope({ waitSpec: { reason: '信号', signalType: 'external', correlationIds: ['source-1'], condition: { eventType: 'ready' }, deadlineRef: null } })), /exclusive waitSpec/)
})

test('reasoningNextStep is bounded and old control envelopes remain readable', () => {
  const current = envelope({ reasoningNextStep: '核对时点对应的动作' })
  assert.deepEqual(parseControlEnvelopeV2(current), current)
  assert.deepEqual(parseControlEnvelopeV2(envelope()), envelope())
  const native = new Ajv().compile(nativeControlEnvelopeSchema(['continue']))
  assert.equal(native(current), true)
  assert.equal(native({ ...current, reasoningNextStep: '字'.repeat(241) }), false)
  assert.throws(() => parseControlEnvelopeV2({ ...current, reasoningNextStep: '字'.repeat(241) }), /\/reasoningNextStep/)
  assert.equal(parseControlEnvelopeV2({ ...current, reasoningNextStep: null }).reasoningNextStep, null)
})

test('file quotes are optional finish intent and fill only existing JSON null fields', () => {
  const quote = { scope: 'session' as const, evidenceId: 'source-1', target: '/claims/0/a~1b~0c' }
  const message = '{"claims":[{"a/b~c":null,"id":"R41"}]}'
  const exact = '来源 R41：包含 "双引号"、反斜杠 \\ 和 😺。'
  const value = envelope({ decision: 'finish', fileQuotes: [quote], userMessage: message,
    completionCheck: { taskId: 'task-1', requiredActions: [], requiredEvidenceRefs: [], unresolvedUncertaintyIds: [], summary: '引用原文' } })
  assert.ok(new Ajv().compile(nativeControlEnvelopeSchema(['finish'], true, true))(value))
  assert.equal(new Ajv().compile(nativeControlEnvelopeSchema(['finish']))(value), false)
  assert.throws(() => parseControlEnvelopeV2(envelope({ fileQuotes: [quote] })), /fileQuotes requires finish/)
  assert.throws(() => parseControlEnvelopeV2({ ...value, fileQuotes: [quote, quote] }), /unique reply targets/)
  assert.throws(() => parseControlEnvelopeV2({ ...value, fileQuotes: [{ ...quote, target: '/quote~2' }] }), /pattern/)
  assert.deepEqual(parseModelOutput(JSON.stringify(value)).fileQuotes, [quote])
  assert.equal(parseModelOutput(JSON.stringify({ ...value, fileQuotes: [] })).fileQuotes, undefined)
  assert.equal(parseModelOutput(JSON.stringify({ status: 'completed', content: message, fileQuotes: [quote] })).fileQuotes, undefined)
  const resolve = () => ({ text: exact, file: 'handoff.txt', line: 8 })
  assert.deepEqual(JSON.parse(renderFileQuotes(message, [quote], resolve)), { claims: [{ 'a/b~c': exact, id: 'R41' }] })
  assert.throws(() => renderFileQuotes(message, [{ ...quote, target: '/claims/0/id' }], resolve), /MUST_BE_NULL/)
  assert.throws(() => renderFileQuotes(message, [{ ...quote, target: '/claims/00/quote' }], resolve), /TARGET_INVALID/)
  assert.throws(() => renderFileQuotes('{"__proto__":{"quote":null}}', [{ ...quote, target: '/__proto__/quote' }], resolve), /unsafe variable path/)
  const claim = { file: 'handoff.txt', line: 8, quote: null }
  const cite = [{ ...quote, target: '/claims/0/quote' }]
  assert.deepEqual(JSON.parse(renderFileQuotes(JSON.stringify({ claims: [claim] }), cite, resolve)), { claims: [{ ...claim, quote: exact }] })
  assert.throws(() => renderFileQuotes(JSON.stringify({ claims: [{ ...claim, line: 83 }] }), cite, resolve), /FILE_QUOTE_REPLY_SOURCE_MISMATCH/)
  assert.throws(() => renderFileQuotes(JSON.stringify({ claims: [{ ...claim, file: 'other.txt' }] }), cite, resolve), /FILE_QUOTE_REPLY_SOURCE_MISMATCH/)
})

test('V2 diff adaptation preserves document binding and rejects invalid evidence or operations', () => {
  const value = envelope({ decision: 'propose_diff', candidateDiffs: [{
    scope: 'session', documentId: 'doc-1', baseRevision: 2, projectionId: 'p-1', projectionHash: 'a'.repeat(64),
    candidateId: 'candidate-1', target: { section: 'information' }, operation: 'add_entry',
    payload: { body: '来源 A 说 X，来源 B 说非 X。', evidenceRefs: ['a', 'b'] }, idempotencyKey: 'proposal-1',
  }] })
  assert.equal(parseModelOutput(JSON.stringify(value)).envelope?.candidateDiffs[0]?.documentId, 'doc-1')
  const missingEvidence = { ...value, candidateDiffs: [{ ...value.candidateDiffs[0], payload: { body: '无证据' } }] }
  const acceptNative = new Ajv().compile(nativeControlEnvelopeSchema(['propose_diff']))
  assert.equal(acceptNative(missingEvidence), false)
  assert.throws(() => parseModelOutput(JSON.stringify(missingEvidence)), /must have required property 'evidenceRefs'/)
  const classification = { durability: 'session', target: 'session', confidence: 'high', reason: '本次审计的召回内容' }
  const incomplete = { ...value, candidateDiffs: [{ ...value.candidateDiffs[0], classification }] }
  assert.equal(acceptNative(incomplete), false)
  assert.throws(() => parseControlEnvelopeV2(incomplete), { code: 'RUNTIME_CONTEXT_DIFF_CLASSIFICATION_SCHEMA', message: /projectAnchors/ })
  const complete = { ...incomplete, candidateDiffs: [{ ...incomplete.candidateDiffs[0], classification: { ...classification, projectAnchors: [] } }] }
  assert.equal(acceptNative(complete), true)
  assert.deepEqual(parseModelOutput(JSON.stringify(complete)).envelope?.candidateDiffs[0]?.classification?.projectAnchors, [])
  const mixed = { ...value, candidateDiffs: [{ ...value.candidateDiffs[0], diffVersion: 1,
    target: { section: 'information', headingPath: ['审计索引'], nodeId: 'heading-1' } }] }
  assert.equal(acceptNative(mixed), false)
  assert.throws(() => parseControlEnvelopeV2(mixed), { code: 'RUNTIME_CONTEXT_DIFF_TREE_BINDING_SCHEMA' })
  const heading = { ...value.candidateDiffs[0]!, operation: 'add_heading' as const, diffVersion: 1 as const,
    payload: { title: '审计索引', evidenceRefs: ['a'] } }
  const malformedTree = { ...value, candidateDiffs: [heading] }
  assert.equal(acceptNative(malformedTree), false)
  assert.throws(() => parseControlEnvelopeV2(malformedTree), { code: 'RUNTIME_CONTEXT_DIFF_TREE_BINDING_SCHEMA' })
  assert.equal(acceptNative({ ...value, candidateDiffs: [{ ...heading, diffVersion: 2, target: { section: 'information', nodeId: 'parent' }, targetNodeHash: 'b'.repeat(64) }] }), true)
})

test('a plan amendment adds work without recreating receipts, blocked branches or accepted obligations', () => {
  const initial = emptyTaskControl('task-1', '交付调查报告')
  const authorize = task({ id: 'authorize', phase: 'human_input', requiredActions: ['human:original'], status: 'completed' })
  const delegate = task({ id: 'delegate', capabilityIds: ['runtime:delegate_task'], requiredActions: [] })
  const report = task({ id: 'report', dependsOn: ['authorize', 'delegate'], requiredActions: [] })
  const current = acceptRuntimePlan(initial, { basePlanRevision: 0, goal: '调查后交付', tasks: [authorize, delegate, report] }, () => true)
  const amendment: NonNullable<ControlEnvelopeV2['planAmendment']> = {
    basePlanRevision: 1,
    addTasks: [{ id: 'edit', title: '回填原件', owner: 'parent', phase: 'execution', dependsOn: ['authorize'],
      capabilityIds: [], completionConditions: ['原文已写入'] }],
    updateTasks: [{ id: 'delegate', addCapabilityIds: ['runtime:search_resources'] }, { id: 'report', addDependsOn: ['edit'] }],
  }
  const value = envelope({ decision: 'propose_plan', planAmendment: amendment })
  const native = new Ajv().compile(nativeControlEnvelopeSchema(['propose_plan'], true, false, false, undefined, { planRevision: 1, activeTaskIds: ['delegate'] }))
  assert.equal(native(value), true)
  assert.equal(native({ ...value, planProposal: { basePlanRevision: 1, goal: '已有计划', tasks: [authorize] } }), false)
  assert.equal(new Ajv().compile(nativeControlEnvelopeSchema(['propose_plan']))(value), false)
  assert.throws(() => parseControlEnvelopeV2({ ...value, decision: 'continue' }), {
    code: 'RUNTIME_CONTROL_PAYLOAD_CONFLICT', field: 'planAmendment', repairAdvice: /use planAmendment only/i,
  })
  assert.throws(() => parseControlEnvelopeV2({ ...value, planAmendment: { basePlanRevision: 1, updateTasks: [{ id: 'delegate' }] } }), /planAmendment/)
  const planned = planProposalForAmendment(current, parseControlEnvelopeV2(value).planAmendment!)
  const next = acceptRuntimePlan(current, planned, () => true)
  assert.deepEqual(next.tasks[0], authorize)
  assert.deepEqual(next.tasks[1]!.capabilityIds, ['runtime:delegate_task', 'runtime:search_resources'])
  assert.deepEqual(next.tasks[2]!.dependsOn, ['authorize', 'delegate', 'edit'])
  assert.deepEqual(next.tasks[3], { ...amendment.addTasks![0], status: 'pending', requiredActions: [], evidenceRefs: [] })
  assert.deepEqual(next.requiredActions, ['human:original'])
  assert.deepEqual(current.tasks[1], delegate)
  assert.throws(() => planProposalForAmendment(next, amendment), /REVISION_MISMATCH/)
  assert.throws(() => planProposalForAmendment(current, { basePlanRevision: 1, updateTasks: [{ id: 'authorize', addDependsOn: ['delegate'] }] }), /NODE_NOT_PENDING/)
  assert.throws(() => planProposalForAmendment(current, { basePlanRevision: 1, updateTasks: [{ id: 'delegate', addCapabilityIds: ['runtime:delegate_task'] }] }), /PLAN_UNCHANGED/)
  const cyclic = planProposalForAmendment(current, { basePlanRevision: 1, updateTasks: [{ id: 'delegate', addDependsOn: ['report'] }] })
  assert.throws(() => acceptRuntimePlan(current, cyclic, () => true), /DEPENDENCY_CYCLE/)
  const blocked = { ...current, branchBlocks: [{ id: 'wait', kind: 'human' as const, taskIds: ['delegate'], reason: '等待确认' }] }
  assert.throws(() => acceptRuntimePlan(blocked, planned, () => true), /BLOCKED_BRANCH_CHANGED/)
})

test('runtime plan checks dependencies and completion receipts and preserves obligations', () => {
  const initial = emptyTaskControl('task-1', '检查')
  const plan = { basePlanRevision: 0, goal: '检查', tasks: [task()] }
  const accepted = acceptRuntimePlan(initial, plan, () => false)
  assert.deepEqual(initial.tasks, [])
  assert.equal(accepted.planRevision, 1)
  const refined = acceptRuntimePlan(initial, { ...plan, goal: '细化后的计划目标' }, () => true)
  assert.equal(refined.goal, initial.goal, 'a plan must not replace the original user goal')
  assert.equal(refined.planGoal, '细化后的计划目标')
  assert.throws(() => acceptRuntimePlan(accepted, plan, () => true), /REVISION_MISMATCH/)
  const unchanged = { ...plan, basePlanRevision: 1, goal: '对相同计划的另一种表述',
    tasks: plan.tasks.map(node => ({ ...node, phase: 'execution' as const })) }
  assert.throws(() => acceptRuntimePlan(accepted, unchanged, () => true), /RUNTIME_PLAN_UNCHANGED/)
  assert.equal(acceptRuntimePlan({ ...accepted, planning: { required: true, reason: 'explicit review' } }, unchanged, () => true).planRevision, 2)
  assert.throws(() => acceptRuntimePlan(accepted, { ...plan, basePlanRevision: 1, tasks: [] }, () => true), /OBLIGATION_REMOVED/)
  assert.throws(() => acceptRuntimePlan(accepted, { ...plan, basePlanRevision: 1, tasks: [task({ requiredActions: [] })] }, () => true), /OBLIGATION_REMOVED/)
  assert.throws(() => acceptRuntimePlan(initial, { ...plan, tasks: [task({ dependsOn: ['missing'] })] }, () => true), /DEPENDENCY_MISSING/)
  assert.throws(() => acceptRuntimePlan(initial, { ...plan, tasks: [task({ dependsOn: ['check'] })] }, () => true), /DEPENDENCY_CYCLE/)
  assert.throws(() => acceptRuntimePlan(initial, { ...plan, tasks: [task({ status: 'completed' })] }, () => false), /COMPLETION_UNVERIFIED/)
  const finished = acceptRuntimePlan(accepted, { ...plan, basePlanRevision: 1, tasks: [task({ status: 'completed' })] }, () => true)
  assert.deepEqual(finished.requiredActions, ['tool:read'])
  assert.equal(finished.tasks[0]?.status, 'completed')
})

test('compact plan completion is exclusive, active, atomic, and preserves planned fields', () => {
  const first = task({ id: 'read', phase: 'investigation', requiredActions: ['tool:read'] })
  const second = task({ id: 'write', phase: 'execution', requiredActions: [], dependsOn: ['read'] })
  const current = acceptRuntimePlan(emptyTaskControl('root', '核对来源'),
    { basePlanRevision: 0, goal: '先核对再写入', tasks: [first, second] }, () => false)
  const update = { id: 'read', actionRefs: ['call:actual-read'], evidenceRefs: [] }
  const progress = { basePlanRevision: 1, nodes: [update] }
  const output = envelope({ decision: 'complete_plan_nodes', planProgress: progress })
  assert.equal(parseModelOutput(JSON.stringify(output)).envelope?.sourceV2?.decision, 'complete_plan_nodes')
  assert.equal(new Ajv().compile(nativeControlEnvelopeSchema(['complete_plan_nodes']))(output), true)
  assert.equal(new Ajv().compile(nativeControlEnvelopeSchema(['propose_plan']))(output), false)
  const projected = new Ajv().compile(nativeControlEnvelopeSchema(['complete_plan_nodes'], true, false, false, undefined,
    { planRevision: current.planRevision, activeTaskIds: ['read'] }))
  assert.equal(projected(output), true)
  assert.equal(projected({ ...output, planProgress: { ...progress, basePlanRevision: 0 } }), false)
  assert.equal(projected({ ...output, planProgress: { ...progress, nodes: [{ ...update, id: 'write' }] } }), false)
  const mixedPayloads = [
    ['uncertainties', [{ id: 'previous', statement: '已登记分歧', blocking: false, relatedTaskIds: ['read'], evidenceRefs: [] }]],
    ['evidenceRequests', [{ id: 'lookup', question: '需要后续来源吗？', sourceKinds: ['memory'], relatedTaskIds: ['read'] }]],
  ] as const
  for (const [field, items] of mixedPayloads) {
    const mixed = { ...output, [field]: items }
    assert.equal(projected(mixed), false)
    assert.throws(() => parseControlEnvelopeV2(mixed), {
      code: 'RUNTIME_CONTROL_PAYLOAD_CONFLICT', field, repairAdvice: /evidenceRequests: \[\] and uncertainties: \[\]/,
    })
  }
  assert.throws(() => parseControlEnvelopeV2({ ...output, planProgress: { ...progress, nodes: [update, update] } }), {
    code: 'RUNTIME_CONTROL_PAYLOAD_CONFLICT', field: 'planProgress.nodes', repairAdvice: /each active node ID only once/,
  })
  assert.throws(() => parseControlEnvelopeV2({ ...output, decision: 'continue' }), /exclusive planProgress/)
  assert.throws(() => planProposalForProgress(current, { ...progress, basePlanRevision: 0 }, ['read']), /REVISION_MISMATCH/)
  assert.throws(() => planProposalForProgress(current, { ...progress, nodes: [update, { ...update, id: 'write' }] }, ['read']), /NODE_INACTIVE/)
  const proposal = planProposalForProgress(current, progress, ['read'])
  assert.throws(() => acceptRuntimePlan(current, proposal, () => false), /COMPLETION_UNVERIFIED/)
  assert.deepEqual(current.tasks, [first, second])
  const completed = acceptRuntimePlan(current, proposal, () => true)
  assert.deepEqual(completed.tasks, [{ ...first, status: 'completed', requiredActions: ['tool:read', update.actionRefs[0]] }, second])
  assert.equal(completed.planRevision, 2)
  assert.deepEqual(runtimeExecutionState(completed).activeTaskIds, ['write'])
})

test('published control schemas bind a payload to its decision and current phase', () => {
  const planProposal = { basePlanRevision: 0, goal: '核对来源', tasks: [task({ id: 'read' })] }
  const waitSpec = { reason: '等待事件', signalType: 'external' as const, correlationIds: ['source'], condition: { eventType: 'ready' }, deadlineRef: null }
  const plan = envelope({ decision: 'propose_plan', planProposal })
  const wait = envelope({ decision: 'wait', waitSpec })
  const inPlanning = new Ajv().compile(nativeControlEnvelopeSchema(['continue', 'propose_plan', 'ask_user', 'reflect']))
  assert.equal(inPlanning(plan), true)
  assert.equal(inPlanning(wait), false)
  assert.equal(inPlanning({ ...plan, waitSpec }), false)
  assert.equal(inPlanning({ ...plan, planProposal: null }), false)
  const initial = new Ajv().compile(nativeControlEnvelopeSchema(['propose_plan'], false))
  assert.equal(initial(plan), false)
  assert.ok(initial({ ...plan, planProposal: { ...planProposal, tasks: [{ ...planProposal.tasks[0], requiredActions: [] }] } }))
  const revise = new Ajv().compile(nativeControlEnvelopeSchema(['propose_plan'], false, false, false, undefined, undefined, 'task-1'))
  assert.ok(revise({ ...plan, planProposal: { ...planProposal, basePlanRevision: 1 } }))
  const boundRevision = new Ajv().compile(nativeControlEnvelopeSchema(['propose_plan'], true, false, false, undefined,
    { planRevision: 2, activeTaskIds: [] }, 'task-1'))
  assert.ok(!boundRevision(plan))
  assert.ok(boundRevision({ ...plan, planProposal: { ...planProposal, basePlanRevision: 2 } }))
  const inExecution = new Ajv().compile(nativeControlEnvelopeSchema(['continue', 'propose_plan', 'wait']))
  assert.equal(inExecution(plan), true)
  assert.equal(inExecution(wait), true)
  assert.equal(inExecution({ ...plan, waitSpec }), false)
  assert.equal(inExecution({ ...wait, planProposal }), false)
  assert.equal(inExecution({ ...wait, waitSpec: null }), false)
  assert.throws(() => parseControlEnvelopeV2({ ...plan, waitSpec }), {
    code: 'RUNTIME_CONTROL_PAYLOAD_CONFLICT', field: 'waitSpec', repairAdvice: /For propose_plan, set waitSpec to null/,
  })
})

test('the published completion schema rejects receipts belonging to another active node', () => {
  const validate = new Ajv().compile(nativeControlEnvelopeSchema(['complete_plan_nodes'], true, false, false, undefined, {
    planRevision: 3, activeTaskIds: ['check-a', 'check-b'],
    foreignActionRefs: new Map([['check-a', ['context:b']], ['check-b', ['call:a']]]),
  }))
  const completion = (id: string, actionRefs: string[], evidenceRefs: string[] = []) => envelope({
    decision: 'complete_plan_nodes', planProgress: { basePlanRevision: 3, nodes: [{ id, actionRefs, evidenceRefs }] },
  })
  assert.ok(validate(completion('check-a', ['call:a'])))
  assert.ok(validate(completion('check-b', ['context:b'])))
  assert.ok(validate(completion('check-b', [], ['published-fact'])))
  assert.equal(validate(completion('check-a', ['context:b'])), false)
  assert.equal(validate(completion('check-b', ['call:a'])), false)
})

test('projected questions and waits use a root task alone or plan nodes only', () => {
  const root = 'task-1'
  const projected = new Ajv().compile(nativeControlEnvelopeSchema(['ask_user', 'wait'], true, false, false,
    [root, 'review', 'publish'], undefined, root))
  const withoutVisibleQuestion = envelope({ decision: 'ask_user', userMessage: ' ',
    actions: [{ kind: 'ask_user', question: '请提供缺少的范围。', blockingTaskIds: ['review'] }] })
  assert.equal(projected(withoutVisibleQuestion), false)
  assert.throws(() => parseControlEnvelopeV2(withoutVisibleQuestion), error =>
    error instanceof ControlPayloadError && error.field === 'userMessage' && error.repairAdvice.includes('actions[0].question'))
  for (const [blockingTaskIds, valid] of [[[root], true], [['review', 'publish'], true], [[root, 'review'], false]] as const) {
    const question = '请提供缺少的范围。'
    assert.equal(projected(envelope({ decision: 'ask_user', userMessage: question,
      actions: [{ kind: 'ask_user', question, blockingTaskIds: [...blockingTaskIds] }] })), valid)
    assert.equal(projected(envelope({ decision: 'wait', waitSpec: { reason: question, signalType: 'external',
      correlationIds: ['bound-signal'], condition: { eventType: 'ready' }, deadlineRef: null, blockingTaskIds: [...blockingTaskIds] } })), valid)
  }
})

test('a human-input plan node cannot declare tools or replace its reply obligation with an unrelated action', () => {
  const initial = emptyTaskControl('root', '取得报告授权')
  const node = task({ phase: 'human_input', requiredActions: [] })
  const draft = { basePlanRevision: 0, goal: '取得报告授权', tasks: [node] }
  assert.throws(() => acceptRuntimePlan(initial, { ...draft, tasks: [{ ...node, capabilityIds: ['tool:read'] }] }, () => true), /HUMAN_INPUT_CAPABILITIES/)
  const current = acceptRuntimePlan(initial, draft, () => true)
  const completion = { ...draft, basePlanRevision: 1, tasks: [{ ...node, status: 'completed' as const, requiredActions: ['call:read'] }] }
  assert.throws(() => acceptRuntimePlan(current, completion, () => true), /COMPLETION_UNVERIFIED/)
  assert.throws(() => acceptRuntimePlan(current, { ...completion, tasks: [{ ...completion.tasks[0]!, phase: 'execution' }] }, () => true), /OBLIGATION_REMOVED/)
})

test('a node committed to delegation needs an actual child assignment and accepted result', () => {
  const delegated = task({ id: 'child', capabilityIds: ['runtime:delegate_task', 'runtime:search_resources'] })
  const chosen = acceptRuntimePlan(emptyTaskControl('task-1', '核验来源'), { basePlanRevision: 0, goal: '核验来源', tasks: [delegated] }, () => true)
  const parentResult = { ...delegated, status: 'completed' as const, requiredActions: ['call:parent-search'] }
  assert.throws(() => acceptRuntimePlan(chosen, { basePlanRevision: 1, goal: '核验来源', tasks: [parentResult] }, () => true),
    /RUNTIME_PLAN_DELEGATION_UNVERIFIED/)
  assert.throws(() => acceptRuntimePlan(chosen, { basePlanRevision: 1, goal: '核验来源',
    tasks: [{ ...delegated, capabilityIds: ['runtime:search_resources'] }] }, () => true), /RUNTIME_PLAN_OBLIGATION_REMOVED/)
  const assigned = { ...chosen, childAssignments: [{ planTaskId: 'child', childId: 'worker', state: 'accepted' as const }] }
  assert.equal(acceptRuntimePlan(assigned, { basePlanRevision: 1, goal: '核验来源',
    tasks: [{ ...delegated, status: 'completed' }] }, () => true).tasks[0]!.status, 'completed')
})

test('dependent nodes wait for an accepted child result and the original plan proof', () => {
  const tasks = [task(), task({ id: 'verify', phase: 'verification', dependsOn: ['check'] })]
  const draft = { basePlanRevision: 0, goal: '验证委派', tasks }
  const current = acceptRuntimePlan(emptyTaskControl('root', '原任务'), draft, () => false)
  const proposal = { ...draft, basePlanRevision: 1, tasks: [task({ status: 'completed' }), tasks[1]!] }
  for (const state of ['delegated', 'retryable'] as const) {
    current.childAssignments = [{ planTaskId: 'check', childId: 'child:owned', state }]
    assert.ok(!runtimeExecutionState(current).readyTaskIds.includes('verify'))
    assert.throws(() => acceptRuntimePlan(current, proposal, () => true), /COMPLETION_UNVERIFIED/)
  }
  current.childAssignments = [{ planTaskId: 'check', childId: 'child:owned', state: 'accepted' }]
  assert.throws(() => acceptRuntimePlan(current, proposal, () => false), /COMPLETION_UNVERIFIED/)
  const finished = acceptRuntimePlan(current, proposal, () => true)
  assert.deepEqual(runtimeExecutionState(finished).readyTaskIds, ['verify'])
})

test('a parent-owned fallback requires scoped action proof and cannot drop the original obligations', () => {
  const node = task()
  const proposal = { basePlanRevision: 0, goal: 'Plan', tasks: [node, task({ id: 'dependent', dependsOn: [node.id] })] }
  const current = acceptRuntimePlan(emptyTaskControl('parent', 'Plan'), proposal, () => true)
  current.childAssignments = [{ planTaskId: node.id, childId: 'child:failed', state: 'parent', takeoverId: 'parent-takeover-real' }]
  assert.deepEqual(runtimeExecutionState(current).parentTakeover, { planTaskId: node.id, childId: 'child:failed', takeoverId: 'parent-takeover-real' })
  const complete = { ...proposal, basePlanRevision: 1, tasks: [{ ...node, status: 'completed' as const }, proposal.tasks[1]!] }
  assert.throws(() => acceptRuntimePlan(current, complete, () => true, () => false), /COMPLETION_UNVERIFIED/)
  assert.throws(() => acceptRuntimePlan(current, complete, () => false, () => true), /COMPLETION_UNVERIFIED/)
  const removed = { ...complete, tasks: [{ ...complete.tasks[0]!, requiredActions: [] }, complete.tasks[1]!] }
  assert.throws(() => acceptRuntimePlan(current, removed, () => true, () => true), /OBLIGATION_REMOVED/)
  assert.deepEqual(runtimeExecutionState(acceptRuntimePlan(current, complete, () => true, () => true)).readyTaskIds, ['dependent'])
})

test('packaged prompt assets match the reviewed sources and are bound by content hash', () => {
  for (const item of v2PromptManifest()) {
    const source = fs.readFileSync(new URL(`../../../docs/prompts/v2/${item.role}.md`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    assert.equal(createHash('sha256').update(source).digest('hex'), item.hash)
    assert.ok(item.version)
  }
  assert.match(V2_CONSTITUTION_PROMPT, /session_context/)
})

test('runtime loads its own role and safely serializes data without a second template pass', () => {
  const state = { documentRevision: 1, projectionProfile: 'test', pendingCandidateCount: 0, binding: envelope().binding,
    allowedDecisions: ['continue', 'tool_call', 'wait'] as const, runtimeState: { injected: '{{ output_schema }}' }, showDelegation: true }
  const prompt = buildV2RuntimePrompt(state)
  assert.ok(prompt.includes('"injected":"{{ output_schema }}"'))
  assert.ok(prompt.includes('"envelopeVersion":{"const":2}'))
  const schema = JSON.parse(prompt.split('\n').find(line => line.startsWith('{"type":"object"') && line.includes('"envelopeVersion"'))!)
  assert.deepEqual(schema.properties.decision.enum, ['continue', 'wait'])
  assert.equal(schema.properties.actions.items.properties.kind.const, 'ask_user')
  assert.ok(!prompt.includes('# Capybara Dream Prompt'))
  assert.ok(!prompt.includes('# Capybara Reflection Prompt'))
  assert.match(prompt, /runtime:search_resources/)
  assert.doesNotMatch(prompt, /local_evidence/)
  assert.match(buildV2RuntimePrompt({ ...state, showChildReview: true }), /local_evidence/)
  assert.throws(() => renderV2Prompt('runtime', {}), /INPUT_MISSING/)
})

test('knowledge projection excludes instruction and message sections while preserving deterministic bindings', () => {
  const engine = ContextDocumentEngine.create({ sessionId: 's', projectId: 'p', constitutionRevision: 'c' })
  engine.setSectionContent('system', 'private instructions', { governance: 'runtime' })
  engine.setSectionContent('messages', 'original trace only')
  const profile = { id: 'knowledge', maxCharacters: 4096, includeSections: ['information', 'candidates'] as const }
  const first = engine.project({ ...profile, includeSections: [...profile.includeSections] })
  assert.ok(!first.markdown.includes('private instructions'))
  assert.ok(!first.markdown.includes('original trace only'))
  assert.equal(engine.project({ ...profile, includeSections: [...profile.includeSections] }).id, first.id)
})
