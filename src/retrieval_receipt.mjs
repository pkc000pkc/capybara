import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { hostInvocationDigest } from './host_invocation_digest.mjs'

const HASH = /^[a-f0-9]{64}$/
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const check = (value, code) => { if (!value) throw new Error(code) }
const clone = value => structuredClone(value)
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
export function retrievalDigest(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex') }
const bytesDigest = value => createHash('sha256').update(value).digest('hex')
const hostDigest = value => bytesDigest(JSON.stringify(value))

function ownedReport(workspaceDir, evidencePath) {
  check(typeof evidencePath === 'string' && evidencePath.length > 0, 'retrieval_receipt_path_missing')
  const root = resolve(workspaceDir), target = resolve(root, evidencePath), rel = relative(root, target)
  check(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`), 'retrieval_receipt_path_escape')
  const portable = rel.split(sep).join('/')
  check(/^plugin-runtime\/\d{6}-(?:before_model|before_tool|after_tool|attempt_end)-[a-f0-9-]+\.json$/.test(portable), 'retrieval_receipt_path_invalid')
  check(!lstatSync(root).isSymbolicLink() && realpathSync(root) === root, 'retrieval_receipt_workspace_link')
  let current = root
  for (const part of rel.split(sep)) {
    current = resolve(current, part)
    const stat = lstatSync(current)
    check(!stat.isSymbolicLink(), 'retrieval_receipt_symlink')
    check(current === target ? stat.isFile() : stat.isDirectory(), 'retrieval_receipt_file_type')
  }
  return { target, portable }
}

export function validateRetrievalProjection(projection, scope) {
  check(plain(projection) && projection.schemaVersion === 'gaia2-retrieval-projection-v1', 'retrieval_projection_schema')
  check(Array.isArray(projection.certificates) && projection.certificates.length <= 128, 'retrieval_projection_bound')
  check(Number.isSafeInteger(projection.revision) && projection.revision >= 0, 'retrieval_projection_revision')
  if (scope.scopeId) check(projection.scopeId === scope.scopeId && projection.criteriaVersion === scope.criteriaVersion, 'retrieval_projection_scope')
  const actions = new Set()
  for (const cert of projection.certificates) {
    check(plain(cert) && typeof cert.actionId === 'string' && !actions.has(cert.actionId), 'retrieval_certificate_identity')
    actions.add(cert.actionId)
    check(cert.scopeId === projection.scopeId && cert.criteriaVersion === projection.criteriaVersion && cert.reviewCommitted === true, 'retrieval_certificate_scope')
    check(cert.resourceKey === 'Contacts' && cert.canonicalName === 'Contacts__get_contacts', 'retrieval_certificate_native_tool')
    check(HASH.test(cert.queryHash) && HASH.test(cert.resultHash) && Number.isFinite(cert.observedAt) && cert.observedAt >= 0, 'retrieval_certificate_source')
    check(typeof cert.complete === 'boolean' && typeof cert.beforeViewComplete === 'boolean', 'retrieval_certificate_completeness')
    check(Array.isArray(cert.retainedRecords) && Array.isArray(cert.rejectRefs) && cert.retainedRecords.length + cert.rejectRefs.length <= 40, 'retrieval_certificate_records')
    const ids = new Set()
    for (const row of cert.retainedRecords) {
      check(plain(row) && typeof row.recordRef === 'string' && !ids.has(row.recordRef)
        && typeof row.path === 'string' && typeof row.body === 'string' && ['keep', 'defer'].includes(row.decision)
        && Array.isArray(row.quotes), 'retrieval_certificate_retained')
      ids.add(row.recordRef)
    }
    for (const id of cert.rejectRefs) { check(typeof id === 'string' && !ids.has(id), 'retrieval_certificate_partition'); ids.add(id) }
    check(cert.projectionHash === retrievalDigest({ retainedRecords: cert.retainedRecords, rejectRefs: cert.rejectRefs }), 'retrieval_certificate_projection_hash')
  }
  return projection
}

/** Project-only extension. Read only the exact just-produced, immutable Host report.
 * RuntimePluginResponse itself deliberately has no variables/context-view API. */
export function createRetrievalReceipt({ response, invocation, workspaceDir, executionId, sessionId }) {
  check(plain(response) && plain(invocation), 'retrieval_receipt_input')
  const { target, portable } = ownedReport(workspaceDir, response.evidencePath)
  const bytes = readFileSync(target), report = JSON.parse(bytes.toString('utf8'))
  check(report.schemaVersion === 'capybara-runtime-plugin-invocation-v1'
    && report.executionId === executionId && report.sessionId === sessionId, 'retrieval_receipt_identity')
  check(report.input?.checkpoint === invocation.checkpoint && hostInvocationDigest(report.input) === hostInvocationDigest(invocation), 'retrieval_receipt_invocation')
  check(Number.isSafeInteger(report.sequence) && report.sequence >= 2 && portable.startsWith(`plugin-runtime/${String(report.sequence).padStart(6, '0')}-`), 'retrieval_receipt_sequence')
  check(report.revision === response.revision && report.variablesHash === response.variablesHash
    && report.contextHash === response.contextHash && report.context === response.context, 'retrieval_receipt_response_binding')
  check(hostDigest(report.variables) === report.variablesHash && bytesDigest(report.context) === report.contextHash
    && hostDigest(report.decision) === hostDigest(response.decision)
    && hostDigest(report.hookReceipts) === hostDigest(response.hookReceipts), 'retrieval_receipt_host_hash')
  const scope = report.variables?.gaia2_retrieval_scope, projection = report.variables?.gaia2_retrieval_projection
  check(plain(scope) && Number.isSafeInteger(scope.revision) && scope.revision >= 0, 'retrieval_receipt_plugin_missing')
  validateRetrievalProjection(projection, scope)
  const receipt = {
    schemaVersion: 'gaia2-retrieval-receipt-v1', executionId, sessionId, checkpoint: invocation.checkpoint,
    sequence: report.sequence, revision: report.revision, variablesHash: report.variablesHash, contextHash: report.contextHash,
    sourceReceiptRef: { path: portable, sha256: bytesDigest(bytes) }, scope: clone(scope), projection: clone(projection),
    planHash: retrievalDigest(projection),
  }
  // Guard a concurrent replacement even though Host files are normally immutable.
  check(bytesDigest(readFileSync(target)) === receipt.sourceReceiptRef.sha256, 'retrieval_receipt_changed_during_read')
  return receipt
}
