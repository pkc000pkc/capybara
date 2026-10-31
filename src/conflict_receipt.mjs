import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { hostInvocationDigest } from './host_invocation_digest.mjs'

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const check = (value, code) => { if (!value) throw new Error(code) }
const text = (value, limit = 200) => typeof value === 'string' && value.length > 0 && value.length <= limit
const HASH = /^[a-f0-9]{64}$/
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
const bytesHash = value => createHash('sha256').update(value).digest('hex')
const hostHash = value => bytesHash(JSON.stringify(value))
export const conflictDigest = value => bytesHash(JSON.stringify(canonical(value)))

function ownedReport(workspaceDir, evidencePath) {
  check(text(evidencePath, 32768), 'conflict_receipt_path_missing')
  const root = resolve(workspaceDir), target = resolve(root, evidencePath), rel = relative(root, target)
  check(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`), 'conflict_receipt_path_escape')
  const portable = rel.split(sep).join('/')
  check(/^plugin-runtime\/\d{6}-(?:before_model|before_tool|after_tool|attempt_end)-[a-f0-9-]+\.json$/.test(portable), 'conflict_receipt_path_invalid')
  check(!lstatSync(root).isSymbolicLink() && realpathSync(root) === root, 'conflict_receipt_workspace_link')
  let current = root
  for (const part of rel.split(sep)) {
    current = resolve(current, part)
    const stat = lstatSync(current)
    check(!stat.isSymbolicLink(), 'conflict_receipt_symlink')
    check(current === target ? stat.isFile() : stat.isDirectory(), 'conflict_receipt_file_type')
  }
  return { target, portable }
}

export function validateConflictState(state) {
  if (plain(state) && state.schemaVersion === 'gaia2-conflict-state-v2') return validateEvidenceState(state)
  check(plain(state) && state.schemaVersion === 'gaia2-conflict-state-v1'
    && ['idle', 'blocked', 'clear'].includes(state.status), 'conflict_state_schema')
  check(Object.keys(state).sort().join(',') === 'blockedAction,blockerIds,reason,requests,schemaVersion,status,userRef', 'conflict_state_fields')
  check(state.userRef === null || text(state.userRef), 'conflict_state_user')
  check(Array.isArray(state.blockerIds) && state.blockerIds.length <= 64
    && state.blockerIds.every(id => text(id, 256)) && new Set(state.blockerIds).size === state.blockerIds.length, 'conflict_state_blockers')
  check(Array.isArray(state.requests) && state.requests.length <= 1, 'conflict_state_request_bound')
  check(Buffer.byteLength(JSON.stringify(state)) <= 65536, 'conflict_state_bound')
  if (state.status === 'idle') {
    check(state.blockedAction === null && state.userRef === null && state.reason === null
      && state.requests.length === 0 && state.blockerIds.length === 0, 'conflict_state_idle')
    return state
  }
  const action = state.blockedAction
  check(plain(action) && Object.keys(action).sort().join(',') === 'canonicalName,id,mutationKey,resourceKey'
    && text(action.id) && text(action.canonicalName) && (action.mutationKey === null || text(action.mutationKey, 512))
    && (action.resourceKey === null || text(action.resourceKey)), 'conflict_state_action')
  check(text(state.reason, 200), 'conflict_state_reason')
  if (state.status === 'clear') {
    check(state.reason === 'evidence_gate_clear_write_not_executed' && state.blockerIds.length === 0
      && state.requests.length === 0 && text(state.userRef), 'conflict_state_clear')
    return state
  }
  if (!state.requests.length) {
    check(state.reason.startsWith('manual_'), 'conflict_state_manual')
    return state
  }
  check(state.reason === 'eligible_exact_query_confirmation' && text(state.userRef) && state.blockerIds.length > 0, 'conflict_state_eligible')
  const request = state.requests[0]
  check(plain(request) && Object.keys(request).sort().join(',') === 'expectedLatestResultHash,observationIds,queryArguments,queryHash,queryTool,resourceKey', 'conflict_request_fields')
  check(text(request.queryTool) && /^[A-Za-z][A-Za-z0-9_]*__[A-Za-z][A-Za-z0-9_]*$/.test(request.queryTool)
    && !request.queryTool.startsWith('Capybara') && plain(request.queryArguments)
    && Buffer.byteLength(JSON.stringify(canonical(request.queryArguments))) <= 4096, 'conflict_request_query')
  const [app, method] = request.queryTool.split('__')
  check(!['SystemApp', 'AgentUserInterface', 'AppAgent'].includes(app)
    && /^(get|list|read|search|lookup|find|fetch|query|count|has|is)(_|$)/.test(method), 'conflict_request_query')
  check(typeof request.queryHash === 'string' && HASH.test(request.queryHash) && text(request.resourceKey)
    && request.resourceKey === action.resourceKey && typeof request.expectedLatestResultHash === 'string'
    && HASH.test(request.expectedLatestResultHash), 'conflict_request_binding')
  check(Array.isArray(request.observationIds) && request.observationIds.length === state.blockerIds.length
    && new Set(request.observationIds).size === request.observationIds.length
    && request.observationIds.every(id => state.blockerIds.includes(id)), 'conflict_request_coverage')
  return state
}

function validateEvidenceState(state) {
  check(Object.keys(state).sort().join(',') === 'blockedAction,blockerIds,reason,requests,requiredResources,schemaVersion,status,userRef', 'evidence_state_fields')
  check(Array.isArray(state.requiredResources) && state.requiredResources.length > 0 && state.requiredResources.length <= 33
    && state.requiredResources.every(value => text(value)) && new Set(state.requiredResources).size === state.requiredResources.length
    && state.requiredResources.includes(state.blockedAction?.resourceKey), 'evidence_state_resources')
  const legacy = { ...state, schemaVersion: 'gaia2-conflict-state-v1' }
  delete legacy.requiredResources
  if (state.status === 'clear' || Array.isArray(state.requests) && state.requests.length === 0) return validateConflictState(legacy), state
  check(state.status === 'blocked' && state.reason === 'eligible_bounded_evidence_recovery'
    && Array.isArray(state.requests) && state.requests.length > 0 && state.requests.length <= 8, 'evidence_state_eligible')
  const covered = []
  for (const request of state.requests) {
    check(plain(request) && Object.keys(request).sort().join(',') === 'expectedLatestResultHash,mode,observationIds,queryArguments,queryHash,queryTool,resourceKey,sourceActionId,sourceObservedAt'
      && ['restore_view', 'native_read'].includes(request.mode) && text(request.sourceActionId)
      && Number.isFinite(request.sourceObservedAt) && request.sourceObservedAt >= 0
      && state.requiredResources.includes(request.resourceKey), 'evidence_request_fields')
    const { mode, sourceActionId, sourceObservedAt, ...query } = request
    validateConflictState({ ...legacy, reason: 'eligible_exact_query_confirmation',
      blockedAction: { ...state.blockedAction, resourceKey: query.resourceKey }, blockerIds: query.observationIds, requests: [query] })
    covered.push(...query.observationIds)
  }
  check(Array.isArray(state.blockerIds) && state.blockerIds.length <= 64 && covered.length === state.blockerIds.length
    && new Set(covered).size === covered.length && covered.every(id => state.blockerIds.includes(id))
    && Buffer.byteLength(JSON.stringify(state)) <= 65536, 'evidence_request_coverage')
  return state
}

/** Project-only receipt, issued from this exact immutable Host invocation. */
export function createConflictReceipt({ response, invocation, workspaceDir, executionId, sessionId }) {
  check(plain(response) && plain(invocation), 'conflict_receipt_input')
  const { target, portable } = ownedReport(workspaceDir, response.evidencePath)
  const bytes = readFileSync(target), report = JSON.parse(bytes.toString('utf8'))
  check(report.schemaVersion === 'capybara-runtime-plugin-invocation-v1' && report.executionId === executionId
    && report.sessionId === sessionId, 'conflict_receipt_identity')
  check(report.input?.checkpoint === invocation.checkpoint && hostInvocationDigest(report.input) === hostInvocationDigest(invocation), 'conflict_receipt_invocation')
  check(Number.isSafeInteger(report.sequence) && report.sequence >= 2
    && portable.startsWith(`plugin-runtime/${String(report.sequence).padStart(6, '0')}-`), 'conflict_receipt_sequence')
  check(report.revision === response.revision && report.variablesHash === response.variablesHash
    && report.contextHash === response.contextHash && report.context === response.context, 'conflict_receipt_response_binding')
  check(hostHash(report.variables) === report.variablesHash && bytesHash(report.context) === report.contextHash
    && hostHash(report.decision) === hostHash(response.decision) && hostHash(report.hookReceipts) === hostHash(response.hookReceipts), 'conflict_receipt_host_hash')
  const state = report.variables?.gaia2_conflict_state
  validateConflictState(state)
  const receipt = { schemaVersion: 'gaia2-conflict-receipt-v1', executionId, sessionId, checkpoint: invocation.checkpoint,
    sequence: report.sequence, revision: report.revision, variablesHash: report.variablesHash, contextHash: report.contextHash,
    sourceReceiptRef: { path: portable, sha256: bytesHash(bytes) }, state: structuredClone(state), stateHash: conflictDigest(state) }
  check(bytesHash(readFileSync(target)) === receipt.sourceReceiptRef.sha256, 'conflict_receipt_changed_during_read')
  return receipt
}
