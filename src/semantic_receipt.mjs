import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { hostInvocationDigest } from './host_invocation_digest.mjs'

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const check = (value, code) => { if (!value) throw new Error(code) }
const bytesHash = value => createHash('sha256').update(value).digest('hex')
const hostHash = value => {
  // RuntimePluginHost adds trusted argument digests after admission so Hooks
  // can perform field checks. Those derived fields are not part of the caller
  // invocation identity and must not invalidate semantic receipt binding.
  if (plain(value) && plain(value.action)) {
    const { argumentHash, argumentFieldHashes, argumentFieldNumbers, argumentMetadataComplete, ...action } = value.action
    return bytesHash(JSON.stringify({ ...value, action }))
  }
  return bytesHash(JSON.stringify(value))
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
export const semanticDigest = value => bytesHash(JSON.stringify(canonical(value)))
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

// Frozen native contracts are filled only from the audited ARE implementation.
// This is an allowlist, not a tool-name heuristic or a success-text parser.
export const MUTATION_CONTRACTS = Object.freeze({
  'are-1.2.0-calendar-mutation-v1': { sourceSha256: '62ffa557068dd1e5983758f8f25423cb6e81a48f4191edace98a2e0173881c7c',
    tools: ['Calendar', 'CalendarApp', 'CalendarV2'].flatMap(app => ['add_calendar_event', 'delete_calendar_event'].map(method => `${app}__${method}`)) },
  'are-1.2.0-contacts-mutation-v1': { sourceSha256: '188862e4ba05bf06895321399c2dd1e54ef9a29fe9dc2573679abb98e5bcf47f',
    tools: ['Contacts', 'ContactsApp'].flatMap(app => ['add_new_contact', 'edit_contact', 'delete_contact'].map(method => `${app}__${method}`)) },
  'are-1.2.0-email-mutation-v1': { sourceSha256: '0da4b444925cef30e6945bff6c0d135d23fddc1c9c54c208acf889d606f24a57',
    tools: ['EmailClientV2__send_email', 'EmailClientV2__reply_to_email'] },
})

export function validateMutationEvidence(evidence, { executionId, sessionId } = {}) {
  check(plain(evidence) && evidence.schemaVersion === 'gaia2-mutation-evidence-v1'
    && evidence.kind === 'mutation_confirmed' && evidence.confirmation === 'confirmed_applied'
    && text(evidence.executionId) && text(evidence.sessionId) && text(evidence.resourceKey)
    && (!executionId || evidence.executionId === executionId) && (!sessionId || evidence.sessionId === sessionId), 'semantic_mutation_identity')
  const ref = evidence.callRef, contract = evidence.contractRef, proof = evidence.nativeProof
  check(plain(ref) && text(ref.actionId) && text(ref.canonicalName) && hash(ref.queryHash) && hash(ref.resultHash)
    && Number.isFinite(ref.observedAt) && ref.observedAt >= 0, 'semantic_mutation_reference')
  const accepted = MUTATION_CONTRACTS[contract?.id]
  check(plain(contract) && accepted && contract.sourceSha256 === accepted.sourceSha256
    && accepted.tools.includes(ref.canonicalName)
    && ['sourceSha256', 'callableSha256', 'toolUtilsSha256', 'typesSha256', 'typeUtilsSha256'].every(key => hash(contract[key])), 'semantic_mutation_contract')
  check(plain(proof) && proof.kind === 'returned_mutation' && proof.exceptionType === null
    && proof.executed === true && proof.complete === true, 'semantic_mutation_native_proof')
  const { receiptId, ...body } = evidence
  check(hash(receiptId) && semanticDigest(body) === receiptId && Buffer.byteLength(JSON.stringify(evidence)) <= 12000, 'semantic_mutation_receipt_hash')
  return evidence
}

export function validateMutationInvocation(invocation, identity) {
  const evidence = invocation.outcome?.mutationEvidence
  if (evidence === undefined) return
  validateMutationEvidence(evidence, identity)
  const action = invocation.action, outcome = invocation.outcome, ref = evidence.callRef
  check(invocation.checkpoint === 'after_tool' && plain(action) && action.effect === 'write'
    && action.authoritativeRead === false && !action.canonicalName.startsWith('Capybara')
    && action.resourceKey === evidence.resourceKey && action.id === ref.actionId
    && action.canonicalName === ref.canonicalName && action.mutationKey === ref.queryHash
    && outcome.status === 'succeeded' && outcome.complete === true && outcome.executed === true
    && outcome.resultHash === ref.resultHash && Number.isFinite(invocation.clock?.now)
    && ref.observedAt <= invocation.clock.now, 'semantic_mutation_call_binding')
  const views = (invocation.messages || []).filter(item => item.role === 'tool' && item.observation?.actionId === action.id).map(item => item.observation)
  check(views.length > 0 && views.every(view => view.resourceKey === evidence.resourceKey
    && view.canonicalName === ref.canonicalName && view.queryHash === ref.queryHash && view.resultHash === ref.resultHash
    && view.observedAt === ref.observedAt && view.complete === true && typeof view.viewComplete === 'boolean'), 'semantic_mutation_source_binding')
}

export function validateWriteState(state, identity = {}) {
  check(plain(state) && ['actions', 'unknown', 'blocked'].every(key => Array.isArray(state[key]) && state[key].length <= 8192), 'semantic_write_state_schema')
  const ids = new Set()
  for (const entry of state.actions) {
    check(plain(entry) && text(entry.actionId) && text(entry.status), 'semantic_write_action')
    check(entry.canonicalName === undefined || text(entry.canonicalName)
      && /^[A-Za-z][A-Za-z0-9_]*__[A-Za-z][A-Za-z0-9_]*$/.test(entry.canonicalName), 'semantic_write_canonical_name')
    check(entry.effect === undefined || ['write', 'finish'].includes(entry.effect), 'semantic_write_effect')
    check(entry.observedAt === undefined || Number.isFinite(entry.observedAt) && entry.observedAt >= 0, 'semantic_write_observed_at')
    check(entry.currentUserRef === undefined || text(entry.currentUserRef), 'semantic_write_user_reference')
    check(entry.executed === undefined || typeof entry.executed === 'boolean', 'semantic_write_executed')
    check(entry.complete === undefined || typeof entry.complete === 'boolean', 'semantic_write_complete')
    if (entry.mutationReceipt === undefined) continue
    const evidence = validateMutationEvidence(entry.mutationReceipt, identity), ref = evidence.callRef
    check(!ids.has(entry.actionId) && entry.status === 'succeeded' && entry.actionId === ref.actionId
      && entry.mutationKey === ref.queryHash && entry.resourceKey === evidence.resourceKey
      && entry.resultHash === ref.resultHash
      && (entry.canonicalName === undefined || entry.canonicalName === ref.canonicalName)
      && (entry.effect === undefined || entry.effect === 'write')
      && (entry.observedAt === undefined || entry.observedAt === ref.observedAt)
      && (entry.executed === undefined || entry.executed === true)
      && (entry.complete === undefined || entry.complete === true), 'semantic_write_receipt_binding')
    ids.add(entry.actionId)
  }
  check(Buffer.byteLength(JSON.stringify(state)) <= 4 * 1024 * 1024, 'semantic_write_state_bound')
  return state
}

function ownedReport(workspaceDir, evidencePath) {
  check(typeof evidencePath === 'string' && evidencePath.length > 0 && evidencePath.length <= 32768, 'semantic_receipt_path_missing')
  const root = resolve(workspaceDir), target = resolve(root, evidencePath), rel = relative(root, target)
  check(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`), 'semantic_receipt_path_escape')
  const portable = rel.split(sep).join('/')
  check(/^plugin-runtime\/\d{6}-(?:before_model|before_tool|after_tool|attempt_end)-[a-f0-9-]+\.json$/.test(portable), 'semantic_receipt_path_invalid')
  check(!lstatSync(root).isSymbolicLink() && realpathSync(root) === root, 'semantic_receipt_workspace_link')
  let current = root
  for (const part of rel.split(sep)) {
    current = resolve(current, part)
    const stat = lstatSync(current)
    check(!stat.isSymbolicLink(), 'semantic_receipt_symlink')
    check(current === target ? stat.isFile() : stat.isDirectory(), 'semantic_receipt_file_type')
  }
  return { target, portable }
}

export function validateEntityEvidence(evidence, { executionId, sessionId } = {}) {
  check(plain(evidence) && evidence.schemaVersion === 'gaia2-entity-evidence-v1'
    && ['delete_succeeded', 'entity_absent', 'entity_present'].includes(evidence.kind)
    && text(evidence.executionId) && text(evidence.sessionId)
    && (!executionId || evidence.executionId === executionId) && (!sessionId || evidence.sessionId === sessionId), 'semantic_entity_identity')
  const entity = evidence.entityRef, ref = evidence.callRef, contract = evidence.contractRef, proof = evidence.nativeProof
  check(plain(entity) && text(entity.resourceKey) && ['CalendarEvent', 'Contact'].includes(entity.entityType) && text(entity.entityId), 'semantic_entity_reference')
  check(plain(ref) && text(ref.actionId) && text(ref.canonicalName) && hash(ref.queryHash) && hash(ref.resultHash)
    && Number.isFinite(ref.observedAt) && ref.observedAt >= 0, 'semantic_native_reference')
  check(plain(contract) && text(contract.id) && ['sourceSha256', 'callableSha256', 'toolUtilsSha256', 'typesSha256', 'typeUtilsSha256'].every(key => hash(contract[key])), 'semantic_entity_contract')
  const calendar = entity.entityType === 'CalendarEvent', [app, method] = ref.canonicalName.split('__')
  check(contract.id === (calendar ? 'are-1.2.0-calendar-entity-v1' : 'are-1.2.0-contacts-entity-v1')
    && contract.sourceSha256 === (calendar ? '62ffa557068dd1e5983758f8f25423cb6e81a48f4191edace98a2e0173881c7c' : '188862e4ba05bf06895321399c2dd1e54ef9a29fe9dc2573679abb98e5bcf47f')
    && (calendar ? ['Calendar', 'CalendarApp', 'CalendarV2'] : ['Contacts', 'ContactsApp']).includes(app)
    && method === (evidence.kind === 'delete_succeeded' ? calendar ? 'delete_calendar_event' : 'delete_contact' : calendar ? 'get_calendar_event' : 'get_contact'), 'semantic_entity_contract')
  check(plain(proof), 'semantic_native_proof')
  const deleted = evidence.deleteReceiptRef
  if (evidence.kind === 'entity_present') {
    check(proof.kind === 'returned_entity' && proof.exceptionType === null && proof.branchLine === null && deleted === null, 'semantic_entity_present')
  } else {
    check(plain(deleted) && hash(deleted.receiptId) && text(deleted.actionId) && text(deleted.canonicalName)
      && hash(deleted.queryHash) && hash(deleted.resultHash) && Number.isFinite(deleted.observedAt)
      && deleted.observedAt >= 0 && deleted.observedAt <= ref.observedAt, 'semantic_delete_reference')
    if (evidence.kind === 'delete_succeeded') {
      check(proof.kind === 'returned_delete' && proof.exceptionType === null && proof.branchLine === null
        && ['actionId', 'canonicalName', 'queryHash', 'resultHash', 'observedAt'].every(key => deleted[key] === ref[key]), 'semantic_delete_self_reference')
    } else {
      check(proof.kind === 'missing_branch' && proof.exceptionType === (calendar ? 'ValueError' : 'KeyError')
        && proof.branchLine === (calendar ? 279 : 221), 'semantic_entity_missing_branch')
    }
  }
  check(Buffer.byteLength(JSON.stringify(evidence)) <= 12000, 'semantic_entity_evidence_bound')
  if (evidence.invalidatedBy !== undefined) check(plain(evidence.invalidatedBy) && text(evidence.invalidatedBy.actionId)
    && Number.isFinite(evidence.invalidatedBy.observedAt) && evidence.invalidatedBy.observedAt >= ref.observedAt
    && ['entity_present', 'new_delete_generation', 'unknown_write', 'unmapped_native_write'].includes(evidence.invalidatedBy.reason), 'semantic_entity_invalidation')
  return evidence
}

export function validateEntityState(state, identity = {}) {
  check(plain(state) && state.schemaVersion === 'gaia2-entity-state-v1' && typeof state.enabled === 'boolean', 'semantic_entity_state_schema')
  check(Object.keys(state).sort().join(',') === 'enabled,records,schemaVersion' && Array.isArray(state.records)
    && state.records.length <= 64 && (state.enabled || state.records.length === 0), 'semantic_entity_state_records')
  const ids = new Set()
  for (const record of state.records) {
    validateEntityEvidence(record, identity)
    check(!ids.has(record.callRef.actionId), 'semantic_entity_state_duplicate')
    ids.add(record.callRef.actionId)
  }
  check(Buffer.byteLength(JSON.stringify(state)) <= 131072, 'semantic_entity_state_bound')
  return state
}

export function validateTaskContractState(state, { executionId, sessionId } = {}) {
  check(plain(state) && state.schemaVersion === 'gaia2-task-contract-state-v1' && typeof state.enabled === 'boolean', 'semantic_task_state_schema')
  check(Array.isArray(state.sources) && state.sources.length <= 64 && Array.isArray(state.obligations) && state.obligations.length <= 64, 'semantic_task_state_bound')
  if (state.enabled === false) {
    check(Object.keys(state).sort().join(',') === 'enabled,obligations,schemaVersion,sources' && !state.sources.length && !state.obligations.length, 'semantic_task_state_disabled')
    return state
  }
  check(text(state.executionId) && text(state.sessionId) && (!executionId || state.executionId === executionId) && (!sessionId || state.sessionId === sessionId)
    && Number.isSafeInteger(state.revision) && state.revision >= 0 && (state.clock === null || Number.isFinite(state.clock) && state.clock >= 0)
    && (state.interruption === null || ['environment_stop', 'cancelled', 'budget_exhausted', 'clock_error', 'user_update'].includes(state.interruption)), 'semantic_task_state_identity')
  const reference = value => plain(value) && typeof value.path === 'string' && /^[a-f0-9]{24}\/[a-z-]+-[a-f0-9]{32}\.json$/.test(value.path) && hash(value.sha256)
  const sources = new Map(), ids = new Set()
  for (const source of state.sources) {
    check(plain(source) && text(source.userRef) && !sources.has(source.userRef) && hash(source.sourceHash)
      && Number.isFinite(source.arrivedAt) && source.arrivedAt >= 0 && ['registered', 'reviewed_none', 'ambiguous'].includes(source.resolution)
      && ['allow', 'forbid_until_deadline', 'forbid'].includes(source.notificationPolicy) && Array.isArray(source.obligationIds) && source.obligationIds.length <= 64
      && reference(source.evidenceRef) && (source.proposalRef === null || reference(source.proposalRef)) && (source.reviewRef === null || reference(source.reviewRef))
      && (source.resolution === 'ambiguous' || reference(source.proposalRef) && reference(source.reviewRef)), 'semantic_task_source')
    const normalizedRefs = ['rawProposalRef', 'normalizedProposalRef', 'anchoringRef', 'extractionRef']
    if (normalizedRefs.some(key => source[key] !== undefined)) {
      check(normalizedRefs.every(key => source[key] === null || reference(source[key]))
        && (source.resolution === 'ambiguous' || normalizedRefs.every(key => reference(source[key])))
        && (source.normalizedProposalRef === null || semanticDigest(source.normalizedProposalRef) === semanticDigest(source.proposalRef)), 'semantic_task_normalization_references')
    }
    if (source.resolverAttempts !== undefined) {
      check([1, 2].includes(source.resolverAttempts) && typeof source.resolverRetryable === 'boolean'
        && Array.isArray(source.attemptHistory) && source.attemptHistory.length === source.resolverAttempts - 1
        && (!source.resolverRetryable || source.resolution === 'ambiguous' && source.resolverAttempts === 1)
        && [null, 'semantic_ambiguous', 'transport_error', 'quote_error', 'protocol_error', 'integrity_or_validation_error'].includes(source.errorCategory)
        && source.attemptHistory.every(old => plain(old) && old.userRef === source.userRef && old.sourceHash === source.sourceHash
          && old.arrivedAt === source.arrivedAt && old.resolution === 'ambiguous' && old.resolverRetryable === true
          && old.resolverAttempts === 1 && semanticDigest(old.evidenceRef) === semanticDigest(source.evidenceRef)
          && [...normalizedRefs, 'proposalRef', 'reviewRef'].every(key => old[key] === null || reference(old[key]))), 'semantic_task_resolver_history')
    }
    sources.set(source.userRef, source)
  }
  for (const item of state.obligations) {
    const source = sources.get(item?.userRef), span = item?.span
    check(plain(item) && text(item.id) && !ids.has(item.id) && source?.resolution === 'registered' && item.sourceHash === source.sourceHash
      && source.obligationIds.includes(item.id) && plain(span) && Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end)
      && span.start >= 0 && span.end > span.start && typeof span.text === 'string' && span.text.length > 0
      && ['monitor_until', 'condition_once'].includes(item.mode) && Number.isFinite(item.deadline) && item.deadline >= source.arrivedAt
      && typeof item.goal === 'string' && item.goal.length > 0 && item.goal.length <= 2000
      && ['pending', 'elapsed_pending_review', 'satisfied', 'revoked', 'interrupted', 'technical_blocked'].includes(item.status)
      && (item.status === 'satisfied' ? ['condition_satisfied', 'deadline_reviewed'].includes(item.completionReason) : item.completionReason === null)
      && (item.mode !== 'monitor_until' || item.status !== 'satisfied' || item.completionReason === 'deadline_reviewed')
      && plain(item.counts) && ['watchCalls', 'nativeWaits', 'nativeScans'].every(key => Number.isSafeInteger(item.counts[key]) && item.counts[key] >= 0 && item.counts[key] <= 4096)
      && (item.lastSignal === null || typeof item.lastSignal === 'string' && item.lastSignal.length <= 64)
      && (item.lastReviewedActionId === null || text(item.lastReviewedActionId)), 'semantic_task_obligation')
    ids.add(item.id)
    if (item.recipe !== null) {
      const recipe = item.recipe, [app, method] = typeof recipe?.queryTool === 'string' ? recipe.queryTool.split('__') : []
      check(plain(recipe) && text(recipe.queryTool) && /^[A-Za-z][A-Za-z0-9_]*__[A-Za-z][A-Za-z0-9_]*$/.test(recipe.queryTool)
        && !app.startsWith('Capybara') && !['SystemApp', 'AgentUserInterface', 'AppAgent'].includes(app)
        && /^(get|list|read|search|lookup|find|fetch|query|count|has|is)(_|$)/.test(method)
        && plain(recipe.queryArguments) && Buffer.byteLength(JSON.stringify(canonical(recipe.queryArguments))) <= 4096 && hash(recipe.queryHash)
        && Number.isSafeInteger(recipe.intervalSeconds) && recipe.intervalSeconds >= 1 && recipe.intervalSeconds <= 900
        && Number.isSafeInteger(recipe.maxScans) && recipe.maxScans >= 1 && recipe.maxScans <= 1000, 'semantic_task_recipe')
    }
    if (item.pendingEvidence !== null) {
      const ref = item.pendingEvidence
      check(plain(ref) && text(ref.actionId) && text(ref.canonicalName) && hash(ref.queryHash) && hash(ref.resultHash)
        && Number.isFinite(ref.observedAt) && ref.observedAt >= source.arrivedAt && ref.complete === true && ref.viewComplete === true
        && item.recipe?.queryTool === ref.canonicalName && item.recipe?.queryHash === ref.queryHash && reference(ref.evidenceRef), 'semantic_task_native_reference')
    }
  }
  for (const source of sources.values()) check(source.obligationIds.every(id => ids.has(id)), 'semantic_task_source_coverage')
  check(Buffer.byteLength(JSON.stringify(state)) <= 131072, 'semantic_task_state_bound')
  return state
}

/** Bind trusted extraction to actual USER occurrences, never Actor control arguments. */
export function validateTaskContractInvocation(invocation, { executionId, sessionId }) {
  const state = invocation.outcome?.result?.taskContractState
  if (state === undefined) return
  check(invocation.checkpoint === 'after_tool' && invocation.action?.canonicalName === 'CapybaraTaskContract__commit'
    && invocation.action?.arguments?.op === 'state_update', 'semantic_task_control_identity')
  validateTaskContractState(state, { executionId, sessionId })
  const users = new Map((invocation.messages || []).filter(item => item.role === 'user' && item.notificationType === 'USER_MESSAGE').map(item => [item.id, item]))
  for (const source of state.sources) {
    const user = users.get(source.userRef)
    check(user && typeof user.content === 'string' && Buffer.byteLength(user.content) <= 262144 && bytesHash(user.content) === source.sourceHash, 'semantic_task_user_hash')
    for (const item of state.obligations.filter(item => item.userRef === source.userRef)) check(item.span.end <= Array.from(user.content).length
      && Array.from(user.content).slice(item.span.start, item.span.end).join('') === item.span.text, 'semantic_task_user_span')
  }
}

/** Only the project HTTP envelope is extended; the Host-owned report is immutable. */
export function createSemanticReceipt({ response, invocation, workspaceDir, executionId, sessionId, mutationReceipts = false }) {
  check(plain(response) && plain(invocation), 'semantic_receipt_input')
  const { target, portable } = ownedReport(workspaceDir, response.evidencePath)
  const bytes = readFileSync(target), report = JSON.parse(bytes.toString('utf8'))
  check(report.schemaVersion === 'capybara-runtime-plugin-invocation-v1' && report.executionId === executionId
    && report.sessionId === sessionId, 'semantic_receipt_identity')
  check(report.input?.checkpoint === invocation.checkpoint && hostInvocationDigest(report.input) === hostInvocationDigest(invocation), 'semantic_receipt_invocation')
  check(Number.isSafeInteger(report.sequence) && report.sequence >= 2
    && portable.startsWith(`plugin-runtime/${String(report.sequence).padStart(6, '0')}-`), 'semantic_receipt_sequence')
  check(report.revision === response.revision && report.variablesHash === response.variablesHash
    && report.contextHash === response.contextHash && report.context === response.context, 'semantic_receipt_response_binding')
  check(hostHash(report.variables) === report.variablesHash && bytesHash(report.context) === report.contextHash
    && hostHash(report.decision) === hostHash(response.decision) && hostHash(report.hookReceipts) === hostHash(response.hookReceipts), 'semantic_receipt_host_hash')
  const entityState = report.variables?.gaia2_entity_state
  validateEntityState(entityState, { executionId, sessionId })
  const receipt = { schemaVersion: 'gaia2-semantic-receipt-v2', executionId, sessionId, checkpoint: invocation.checkpoint,
    sequence: report.sequence, revision: report.revision, variablesHash: report.variablesHash, contextHash: report.contextHash,
    sourceReceiptRef: { path: portable, sha256: bytesHash(bytes) }, entityState: structuredClone(entityState), entityStateHash: semanticDigest(entityState) }
  if (mutationReceipts) {
    const writeState = report.variables?.gaia2_write_state
    validateWriteState(writeState, { executionId, sessionId })
    receipt.writeState = structuredClone(writeState)
    receipt.writeStateHash = semanticDigest(writeState)
  }
  check(bytesHash(readFileSync(target)) === receipt.sourceReceiptRef.sha256, 'semantic_receipt_changed_during_read')
  return receipt
}
