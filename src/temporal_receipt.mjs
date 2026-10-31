import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { hostInvocationDigest } from './host_invocation_digest.mjs'

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const check = (value, code) => { if (!value) throw new Error(code) }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
const bytesHash = value => createHash('sha256').update(value).digest('hex')
const hostHash = value => bytesHash(JSON.stringify(value))
export const temporalDigest = value => bytesHash(JSON.stringify(canonical(value)))

function ownedReport(workspaceDir, evidencePath) {
  check(typeof evidencePath === 'string' && evidencePath.length > 0, 'temporal_receipt_path_missing')
  const root = resolve(workspaceDir), target = resolve(root, evidencePath), rel = relative(root, target)
  check(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`), 'temporal_receipt_path_escape')
  const portable = rel.split(sep).join('/')
  check(/^plugin-runtime\/\d{6}-(?:before_model|before_tool|after_tool|attempt_end)-[a-f0-9-]+\.json$/.test(portable), 'temporal_receipt_path_invalid')
  check(!lstatSync(root).isSymbolicLink() && realpathSync(root) === root, 'temporal_receipt_workspace_link')
  let current = root
  for (const part of rel.split(sep)) {
    current = resolve(current, part)
    const stat = lstatSync(current)
    check(!stat.isSymbolicLink(), 'temporal_receipt_symlink')
    check(current === target ? stat.isFile() : stat.isDirectory(), 'temporal_receipt_file_type')
  }
  return { target, portable }
}

export function validateTemporalState(state, { executionId, sessionId } = {}) {
  check(plain(state) && state.schemaVersion === 'gaia2-temporal-state-v1', 'temporal_state_schema')
  if (state.enabled === false) { check(state.status === 'idle', 'temporal_state_idle'); return state }
  check(state.enabled === true && ['running', 'signaled'].includes(state.status), 'temporal_state_status')
  check(typeof state.watchId === 'string' && state.watchId.length > 0
    && typeof state.executionId === 'string' && state.executionId.length > 0
    && typeof state.sessionId === 'string' && state.sessionId.length > 0
    && (!executionId || state.executionId === executionId) && (!sessionId || state.sessionId === sessionId), 'temporal_state_identity')
  check(Number.isFinite(state.sceneStart) && state.sceneStart >= 0 && Number.isFinite(state.sceneNow) && state.sceneNow >= state.sceneStart
    && (state.deadline === null || Number.isFinite(state.deadline) && state.deadline >= 0), 'temporal_state_clock')
  check(Number.isFinite(state.intervalSeconds) && state.intervalSeconds > 0 && Number.isSafeInteger(state.maxScans) && state.maxScans >= 1 && state.maxScans <= 1000
    && Number.isSafeInteger(state.scanCount) && state.scanCount >= 0 && state.scanCount <= state.maxScans
    && Number.isSafeInteger(state.waitCount) && state.waitCount >= 0, 'temporal_state_budget')
  const signals = ['candidate_changed', 'initial_observation', 'deadline', 'deadline_approaching', 'scan_budget', 'native_error', 'incomplete_observation', 'user_update', 'environment_stop', 'clock_error']
  check(state.status === 'running' ? state.signal === null : plain(state.signal) && signals.includes(state.signal.kind), 'temporal_state_signal')
  check(Array.isArray(state.waitRefs) && state.waitRefs.length <= 64 && state.waitRefs.length <= state.waitCount, 'temporal_state_reference_bound')
  return state
}

/** Project transport extension from the exact fresh Host report, never response.variables. */
export function createTemporalReceipt({ response, invocation, workspaceDir, executionId, sessionId }) {
  check(plain(response) && plain(invocation), 'temporal_receipt_input')
  const { target, portable } = ownedReport(workspaceDir, response.evidencePath)
  const bytes = readFileSync(target), report = JSON.parse(bytes.toString('utf8'))
  check(report.schemaVersion === 'capybara-runtime-plugin-invocation-v1' && report.executionId === executionId
    && report.sessionId === sessionId, 'temporal_receipt_identity')
  check(report.input?.checkpoint === invocation.checkpoint && hostInvocationDigest(report.input) === hostInvocationDigest(invocation), 'temporal_receipt_invocation')
  check(Number.isSafeInteger(report.sequence) && report.sequence >= 2
    && portable.startsWith(`plugin-runtime/${String(report.sequence).padStart(6, '0')}-`), 'temporal_receipt_sequence')
  check(report.revision === response.revision && report.variablesHash === response.variablesHash
    && report.contextHash === response.contextHash && report.context === response.context, 'temporal_receipt_response_binding')
  check(hostHash(report.variables) === report.variablesHash && bytesHash(report.context) === report.contextHash
    && hostHash(report.decision) === hostHash(response.decision) && hostHash(report.hookReceipts) === hostHash(response.hookReceipts), 'temporal_receipt_host_hash')
  const state = report.variables?.gaia2_temporal_state
  validateTemporalState(state, { executionId, sessionId })
  const receipt = { schemaVersion: 'gaia2-temporal-receipt-v1', executionId, sessionId, checkpoint: invocation.checkpoint,
    sequence: report.sequence, revision: report.revision, variablesHash: report.variablesHash, contextHash: report.contextHash,
    sourceReceiptRef: { path: portable, sha256: bytesHash(bytes) }, state: structuredClone(state), stateHash: temporalDigest(state) }
  check(bytesHash(readFileSync(target)) === receipt.sourceReceiptRef.sha256, 'temporal_receipt_changed_during_read')
  return receipt
}
