import { createHash } from 'node:crypto'

// Independent, read-only package verification. Absolute source paths are
// identity labels only: every read goes through a sealed relative copy map.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const HASH = /^[a-f0-9]{64}$/, ID = /^[a-f0-9]{32}$/
const PIN = 'are-1.2-shopping-discount-codes-read-v1'
const PIN_SHA = '7436b99640628ef737418396287fe8b7fb4912bd81bfee72e251a748aaeae205'
const PIN_BYTES = 25517
const CLOCK_CONTRACT = 'gaia2-official-a2a-clock-v1'
const NATIVE_CLOCK_CONTRACT = 'gaia2-official-a2a-clock-v2'
const NATIVE_DEADLINE_SCHEMA = 'gaia2-native-admission-deadline-v1'
const NATIVE_COMMON = ['sourceManifestHash', 'scopeHash', 'ticketId', 'dispatchId', 'toolId', 'canonicalName', 'toolKind', 'effect', 'rawArgumentsHash', 'effectiveArgumentsHash']
const REGISTRY_CLOCK_CONTRACT = 'capybara-runtime-delegation-clock-v1'
const portable = value => value.replaceAll('\\', '/')
const sourceKey = value => portable(value).replace(/\/$/, '').toLowerCase()
const sha = value => createHash('sha256').update(value).digest('hex')
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const uint = value => Number.isSafeInteger(value) && value >= 0
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
// RuntimePluginHost appends trusted, bounded argument metadata after the
// delegation action is admitted. Project those derived fields out before
// validating the legacy semantic action shape.
const hostActionProjection = value => {
  if (!object(value)) return value
  const { argumentHash, argumentFieldHashes, argumentFieldNumbers, argumentMetadataComplete, ...action } = value
  return action
}
const safePath = value => typeof value === 'string' && value && !/^[\\/]|^[A-Za-z]:|[\\:\0]/.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..')
const absoluteIdentity = value => typeof value === 'string' && !value.includes('\0') && (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/'))
const joinIdentity = (root, path) => { check(absoluteIdentity(root) && safePath(path), 'a2a_evidence_reference_invalid'); return `${portable(root).replace(/\/$/, '')}/${path}` }
function check(condition, code) { if (!condition) throw new Error(code) }

/** The tagged wire digest is deliberately not JSON.stringify/digest(). */
export function a2aWireEvidenceHash(value) {
  let remaining = 100000
  const ancestors = new Set()
  const string = text => { check(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text), 'a2a_wire_evidence_invalid'); return text }
  const visit = (item, depth) => {
    check(--remaining >= 0 && depth <= 64, 'a2a_wire_evidence_invalid')
    if (item === null) return ['null']
    if (typeof item === 'boolean') return ['bool', item]
    if (typeof item === 'string') return ['string', string(item)]
    if (typeof item === 'number') {
      check(Number.isFinite(item) && (!Number.isInteger(item) || Number.isSafeInteger(item)), 'a2a_wire_evidence_invalid')
      const bytes = Buffer.alloc(8); bytes.writeDoubleBE(Object.is(item, -0) ? 0 : item)
      return ['number', bytes.toString('hex')]
    }
    check(object(item) || Array.isArray(item), 'a2a_wire_evidence_invalid')
    check(!ancestors.has(item), 'a2a_wire_evidence_invalid'); ancestors.add(item)
    try {
      for (const key of Object.keys(item)) check(!['__proto__', 'prototype', 'constructor'].includes(key), 'a2a_wire_evidence_invalid')
      if (Array.isArray(item)) return ['array', item.map(child => visit(child, depth + 1))]
      const keys = Object.keys(item).sort((a, b) => Buffer.compare(Buffer.from(string(a)), Buffer.from(string(b))))
      return ['object', keys.map(key => { check(--remaining >= 0, 'a2a_wire_evidence_invalid'); return [key, visit(item[key], depth + 1)] })]
    } finally { ancestors.delete(item) }
  }
  const bytes = Buffer.from(JSON.stringify(visit(value, 0)))
  check(bytes.length <= 4 * 1024 * 1024, 'a2a_wire_evidence_invalid')
  return sha(bytes)
}
const same = (left, right) => a2aWireEvidenceHash(left) === a2aWireEvidenceHash(right)
const sameSourceRef = (left, right) => exact(left, ['path', 'sha256']) && exact(right, ['path', 'sha256'])
  && typeof left.path === 'string' && typeof right.path === 'string' && sourceKey(left.path) === sourceKey(right.path) && left.sha256 === right.sha256
const plainHash = value => {
  // Match RuntimeDelegationRegistry.canonical byte-for-byte. Building a sorted
  // object first would let JSON.stringify reorder integer-like keys again.
  const visit = item => Array.isArray(item) ? `[${item.map(visit).join(',')}]` : object(item)
    ? `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${visit(item[key])}`).join(',')}}` : JSON.stringify(item)
  return sha(visit(value))
}

function decoded(bytes) {
  check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 4 * 1024 * 1024, 'a2a_evidence_bytes_invalid')
  // Requiring exact canonical field sets downstream also rejects unknown
  // authority fields. Duplicate keys must not be silently overwritten.
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  let at = 0, nodes = 100000
  const whitespace = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at++ }
  const readString = () => {
    const start = at++
    while (at < text.length) {
      if (text[at] === '\\') { at += 2; continue }
      if (text[at++] === '"') return JSON.parse(text.slice(start, at))
    }
    throw new Error('a2a_evidence_json_invalid')
  }
  const readValue = depth => {
    check(--nodes >= 0 && depth <= 64, 'a2a_evidence_json_invalid'); whitespace()
    if (text[at] === '"') return readString()
    if (text[at] === '{' || text[at] === '[') {
      const array = text[at++] === '[', result = array ? [] : {}, seen = new Set(), end = array ? ']' : '}'
      whitespace()
      if (text[at] === end) { at++; return result }
      for (;;) {
        if (array) result.push(readValue(depth + 1))
        else {
          whitespace(); check(text[at] === '"', 'a2a_evidence_json_invalid'); const key = readString()
          check(!seen.has(key) && !['__proto__', 'prototype', 'constructor'].includes(key), 'a2a_evidence_json_invalid'); seen.add(key)
          whitespace(); check(text[at++] === ':', 'a2a_evidence_json_invalid'); result[key] = readValue(depth + 1)
        }
        whitespace(); if (text[at] === end) { at++; return result }
        check(text[at++] === ',', 'a2a_evidence_json_invalid')
      }
    }
    const match = /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at))
    check(match, 'a2a_evidence_json_invalid'); at += match[0].length
    const item = JSON.parse(match[0]); check(typeof item !== 'number' || Number.isFinite(item), 'a2a_evidence_json_invalid'); return item
  }
  const value = readValue(0); whitespace(); check(at === text.length, 'a2a_evidence_json_invalid')
  check(object(value), 'a2a_evidence_json_invalid')
  return value
}

function sourceInventory(event, reader, environmentLock) {
  const sources = [...(event.nativeManifest?.sourceRefs ?? []), ...(event.runnerSnapshot?.sourceRefs ?? []),
    ...(event.runnerSnapshot?.modelRequests ?? []).flatMap(record => record.generationOwnerSourceRefs ?? [])]
  check(sources.length > 0, 'a2a_source_inventory_missing')
  const expected = new Map()
  for (const source of sources) {
    check(exact(source, ['path', 'sha256', 'bytes']) && absoluteIdentity(source.path) && HASH.test(source.sha256) && uint(source.bytes), 'a2a_source_reference_invalid')
    const key = sourceKey(source.path), previous = expected.get(key)
    check(!previous || previous.sha256 === source.sha256 && previous.bytes === source.bytes, 'a2a_source_reference_conflict')
    expected.set(key, source)
  }
  for (const source of expected.values()) {
    const bytes = reader.absolute(source)
    check(bytes.length === source.bytes, 'a2a_source_size_mismatch')
    if (environmentLock) {
      const official = (environmentLock.officialCodeInputs ?? []).find(ref => sourceKey(ref.path) === sourceKey(source.path))
      const local = (environmentLock.codeInputs ?? []).find(ref => typeof ref.path === 'string' && sourceKey(source.path).endsWith(`/${sourceKey(ref.path)}`))
      const frozen = official ?? local
      // Third-party Python SDK modules are frozen by the native owner but are
      // not part of the project's reviewed ARE/local-code inventory.
      if (official || local || /\/are\//.test(portable(source.path)) || /\/scripts\/gaia2_|\/scripts\/capybara_official_bridge\.py$/.test(portable(source.path))) {
        check(frozen && frozen.sha256 === source.sha256 && (frozen.bytes === undefined || frozen.bytes === source.bytes), 'a2a_frozen_source_mismatch')
      }
    }
  }
  return expected
}

function manifestTools(event, reader, environmentLock) {
  const manifest = event.nativeManifest, runner = event.runnerSnapshot
  check(object(manifest) && ['gaia2-native-app-binding-v1', 'gaia2-native-app-binding-v2'].includes(manifest.schemaVersion)
    && manifest.appId === event.appId && manifest.parentExecutionId === event.executionId && manifest.parentSessionId === event.sessionId
    && absoluteIdentity(manifest.evidenceRoot) && manifest.parentCanonicalName === 'AppAgent__expert_agent' && manifest.taskArgumentKey === 'task'
    && Array.isArray(manifest.tools) && manifest.tools.length > 0 && a2aWireEvidenceHash(manifest.tools) === manifest.toolInventoryHash
    && runner.sourceManifestHash === a2aWireEvidenceHash(manifest), 'a2a_native_manifest_invalid')
  const version2 = manifest.schemaVersion === 'gaia2-native-app-binding-v2', tools = new Map(), publicNames = new Set(), canonicals = new Set()
  if (manifest.nativeAdmissionDeadline !== undefined) check(exact(manifest.nativeAdmissionDeadline, ['schemaVersion', 'unit', 'clockAuthority'])
    && manifest.nativeAdmissionDeadline.schemaVersion === NATIVE_DEADLINE_SCHEMA && manifest.nativeAdmissionDeadline.unit === 'seconds'
    && manifest.nativeAdmissionDeadline.clockAuthority === 'ARE', 'a2a_native_admission_contract_invalid')
  let finalCount = 0, pinCount = 0
  const sources = sourceInventory(event, reader, environmentLock)
  for (const tool of manifest.tools) {
    check(exact(tool, ['toolId', 'publicName', 'canonicalName', 'effect', 'toolKind', 'resourceKey', 'signatureHash', 'formatterSourceHash', ...(version2 ? ['completionEvidenceKind', 'sourcePinId'] : [])])
      && typeof tool.toolId === 'string' && tool.toolId && !tools.has(tool.toolId) && typeof tool.publicName === 'string' && tool.publicName && !publicNames.has(tool.publicName)
      && typeof tool.canonicalName === 'string' && tool.canonicalName && !canonicals.has(tool.canonicalName) && !tool.canonicalName.endsWith('__expert_agent')
      && ['read', 'write', 'finish'].includes(tool.effect) && ['app_tool', 'child_final_answer'].includes(tool.toolKind)
      && tool.resourceKey === manifest.appId && HASH.test(tool.signatureHash) && (tool.formatterSourceHash === null || HASH.test(tool.formatterSourceHash)), 'a2a_native_tool_metadata_invalid')
    if (tool.toolKind === 'child_final_answer') {
      check(tool.toolId === 'final_answer' && tool.publicName === 'final_answer' && tool.canonicalName === 'final_answer' && tool.effect === 'finish' && tool.formatterSourceHash === null, 'a2a_native_final_tool_invalid'); finalCount++
    } else check(tool.effect !== 'finish', 'a2a_native_tool_metadata_invalid')
    if (version2 && tool.completionEvidenceKind === 'source_pinned_return') {
      const className = manifest.appType === 'are.simulation.apps.shopping.Shopping' ? 'Shopping' : manifest.appType === 'are.simulation.apps.shopping.ShoppingApp' ? 'ShoppingApp' : null
      const pinned = [...sources.values()].filter(ref => portable(ref.path).endsWith('/are/simulation/apps/shopping.py'))
      check(className && tool.canonicalName === `${className}__get_all_discount_codes` && tool.effect === 'read' && tool.toolKind === 'app_tool'
        && tool.formatterSourceHash === null && tool.sourcePinId === PIN && pinned.length === 1 && pinned[0].sha256 === PIN_SHA && pinned[0].bytes === PIN_BYTES,
      'a2a_native_source_pin_invalid'); pinCount++
    } else if (version2) check(tool.sourcePinId === null && tool.completionEvidenceKind === (tool.toolKind === 'child_final_answer' ? 'child_final_answer' : 'are_completed_event'), 'a2a_native_completion_kind_invalid')
    tools.set(tool.toolId, tool); publicNames.add(tool.publicName); canonicals.add(tool.canonicalName)
  }
  check(finalCount === 1 && (!version2 || pinCount === 1), 'a2a_native_tool_inventory_invalid')
  return { manifest, tools, version2, sources, nativeAdmissionRequired: manifest.nativeAdmissionDeadline !== undefined }
}

function makeReader(event, readEvidence) {
  check(Array.isArray(event.evidenceRefs) && event.evidenceRefs.length > 0 && typeof readEvidence === 'function', 'a2a_runtime_evidence_missing')
  const refs = new Map(), originals = new Map(), used = new Set(), buffers = new Map(), jsons = new Map()
  for (const ref of event.evidenceRefs) {
    check(exact(ref, ['path', 'sha256', 'sourcePath']) && safePath(ref.path) && HASH.test(ref.sha256) && absoluteIdentity(ref.sourcePath)
      && !refs.has(ref.path) && !originals.has(sourceKey(ref.sourcePath)), 'a2a_runtime_evidence_reference_invalid')
    const bytes = readEvidence(ref.path)
    check(Buffer.isBuffer(bytes) && sha(bytes) === ref.sha256, 'a2a_runtime_evidence_hash_mismatch')
    refs.set(ref.path, ref); originals.set(sourceKey(ref.sourcePath), ref); buffers.set(ref.path, bytes)
  }
  const absolute = ref => {
    check(object(ref) && typeof ref.path === 'string' && HASH.test(ref.sha256), 'a2a_evidence_reference_invalid')
    const bound = originals.get(sourceKey(ref.path))
    check(bound && bound.sha256 === ref.sha256, 'a2a_evidence_unbound'); used.add(bound.path); return buffers.get(bound.path)
  }
  const json = ref => decoded(absolute(ref))
  const relative = (root, ref) => json({ ...ref, path: joinIdentity(root, ref.path) })
  const entries = () => [...refs.values()].map(ref => {
    let value = null
    try { value = decoded(buffers.get(ref.path)) } catch { /* frozen source bytes are not JSON receipts */ }
    if (value) jsons.set(ref.path, value)
    return { ref, value }
  })
  return { refs, used, originals, absolute, json, relative, entries, consume: ref => used.add(ref.path), pathFor: ref => originals.get(sourceKey(ref.path))?.path }
}

function generationEvidence(record, event, reader) {
  const ledger = record.generationLedgerFinished ?? record.generationLedgerFinal ?? record.generationLedgerReleased
  check(object(ledger) && ledger.schemaVersion === 'gaia2-generation-time-ledger-v1' && absoluteIdentity(record.generationLedgerRoot)
    && Array.isArray(ledger.evidenceRefs) && ledger.evidenceRefs.length > 0 && ledger.sequence === ledger.evidenceRefs.length, 'a2a_generation_ledger_missing')
  const common = ['sourceManifestHash', 'scopeHash', 'modelScopeHash', 'permitId', 'requestId', 'actualInputHash']
  check(HASH.test(ledger.sourceManifestHash) && ledger.scopeHash === event.scopeHash && ledger.modelScopeHash === event.runnerSnapshot.modelScopeHash
    && ['permitId', 'requestId', 'actualInputHash'].every(key => ledger[key] === record[key]), 'a2a_generation_identity_invalid')
  check(Array.isArray(record.generationOwnerSourceRefs) && record.generationOwnerSourceRefs.length > 0, 'a2a_generation_source_inventory_missing')
  const sortedSources = [...record.generationOwnerSourceRefs].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
  check(new Set(sortedSources.map(ref => ref.path)).size === sortedSources.length
    && same(sortedSources, record.generationOwnerSourceRefs)
    && sha(Buffer.from(sortedSources.map(ref => `${ref.path}\0${ref.sha256}\0${ref.bytes}`).join('\n'))) === ledger.sourceManifestHash,
    'a2a_generation_source_manifest_invalid')
  let phase = 'new', previousHash = null, leaseId = null, returned = null, released = null
  const extra = { admission: [], pause_acquired: ['leaseId'], model_returned: ['outputHash', 'timing', 'usage'], pause_released: ['leaseId', 'offset'], model_finished: ['outputHash', 'usage'], failed: ['failureCode'] }
  for (const [index, ref] of ledger.evidenceRefs.entries()) {
    check(exact(ref, ['path', 'sha256']) && ref.path === `json/${String(index + 1).padStart(6, '0')}-generation-time.json` && HASH.test(ref.sha256), 'a2a_generation_reference_invalid')
    const item = reader.relative(record.generationLedgerRoot, ref), kind = item.kind
    check(Object.hasOwn(extra, kind) && exact(item, ['schemaVersion', ...common, 'sequence', 'previousHash', 'kind', ...extra[kind]])
      && item.schemaVersion === ledger.schemaVersion && item.sequence === index + 1 && item.previousHash === previousHash
      && common.every(key => item[key] === ledger[key]), 'a2a_generation_chain_invalid')
    if (kind === 'admission') { check(phase === 'new', 'a2a_generation_order_invalid'); phase = 'admitted' }
    else if (kind === 'pause_acquired') { check(phase === 'admitted' && ID.test(item.leaseId), 'a2a_generation_order_invalid'); leaseId = item.leaseId; phase = 'paused' }
    else if (kind === 'model_returned') {
      check(phase === 'paused' && HASH.test(item.outputHash) && exact(item.timing, ['logicalElapsedSeconds', 'sdkAttemptElapsedSeconds', 'successfulSdkElapsedSeconds', 'cooldownSeconds'])
        && Object.values(item.timing).every(value => value === null || finite(value)), 'a2a_generation_timing_invalid')
      returned = item; phase = 'returned'
    } else if (kind === 'pause_released') {
      check(['paused', 'returned'].includes(phase) && item.leaseId === leaseId && finite(item.offset), 'a2a_generation_order_invalid')
      check(returned ? item.offset === returned.timing.successfulSdkElapsedSeconds : item.offset === 0, 'a2a_generation_offset_includes_retry_or_cooldown')
      released = item; phase = 'released'
    } else if (kind === 'model_finished') {
      check(phase === 'released' && returned && item.outputHash === returned.outputHash && same(item.usage, returned.usage), 'a2a_generation_order_invalid'); phase = 'finished'
    } else { check(!['new', 'finished', 'failed'].includes(phase) && typeof item.failureCode === 'string' && /^[A-Z0-9_]{1,80}$/.test(item.failureCode), 'a2a_generation_order_invalid'); phase = 'failed' }
    previousHash = ref.sha256
  }
  check(phase === ledger.phase && previousHash === ledger.previousHash && ['finished', 'failed'].includes(phase), 'a2a_generation_terminal_chain_invalid')
  const acquired = record.generationOwnerAcquired?.lease ?? record.generationOwnerAcquired
  const ownerReleased = record.generationOwnerReleased?.lease ?? record.generationOwnerReleased
  if (leaseId !== null) {
    check(object(acquired) && object(ownerReleased) && acquired.leaseId === leaseId && acquired.released === false
      && ownerReleased.leaseId === leaseId && ownerReleased.released === true && finite(ownerReleased.offset)
      && common.every(key => acquired[key] === ledger[key] && ownerReleased[key] === ledger[key]), 'a2a_generation_lease_not_released')
    check(finite(acquired.beforeNow) && finite(acquired.pausedNow) && acquired.pausedNow >= acquired.beforeNow
      && finite(acquired.pausePassedTime) && acquired.pausePassedTime > 0, 'a2a_generation_pause_invalid')
    check(released ? ownerReleased.offset === released.offset : phase === 'failed' && ownerReleased.offset === 0 && ownerReleased.cleanup === true,
      'a2a_generation_cleanup_invalid')
  } else check(record.sdkAttempts.length === 0 && phase === 'failed', 'a2a_generation_pause_missing')
  if (record.completed === true) {
    check(phase === 'finished' && returned && released && record.outputHash === returned.outputHash && same(record.usage, returned.usage)
      && record.generationOffsetMode === 'successfulSdkElapsedSeconds' && record.generationTimingSource === 'ScopedRetryModelEngine.monotonic_clock'
      && same(record.generationTiming, returned.timing) && record.generationOffset === released.offset, 'a2a_generation_finished_record_invalid')
    check(finite(ownerReleased.resumeBeforeNow) && finite(ownerReleased.resumeAfterNow) && ownerReleased.resumeAfterNow >= ownerReleased.resumeBeforeNow,
      'a2a_generation_resume_clock_invalid')
  } else check(phase === 'failed', 'a2a_generation_failed_record_invalid')
  return { phase, returned }
}

/** A pre-native denial is not a native return. Consume it only after proving
 * the nonallow Hook, untouched ticket and trusted discard in the same scope. */
function blockedNativeEvidence(event, reader, inventory, entries, scope) {
  const { manifest, tools, version2 } = inventory
  const rows = entries.filter(row => row.value?.schemaVersion === 'capybara-runtime-delegation-receipt-v1'
    && row.value.kind === 'native_rejected' && row.value.data?.code === 'DELEGATION_BEFORE_BLOCKED'
    && row.value.data?.scope && a2aWireEvidenceHash(row.value.data.scope) === event.scopeHash)
  const blocked = event.runnerSnapshot.blockedActions ?? []
  check(Array.isArray(blocked) && blocked.length === rows.length, 'a2a_native_blocked_inventory_invalid')
  const seen = new Set(), tickets = new Set(), registered = entries.find(row => row.value?.kind === 'registered'
    && row.value.data?.scope && same(row.value.data.scope, scope))
  const commonKeys = ['sourceManifestHash', 'scopeHash', 'ticketId', 'dispatchId', 'toolId', 'canonicalName', 'toolKind', 'effect', 'rawArgumentsHash', 'effectiveArgumentsHash']
  for (const row of rows) {
    const rejected = row.value, data = rejected.data, action = data.action, tool = tools.get(action?.toolId)
    check(exact(data, ['scope', 'action', 'started', 'nativeReturned', 'resultHash', 'code', 'beforeEvidence', 'gateDecision', 'nativeDiscardEvidenceRef'])
      && same(data.scope, scope) && data.started === false && data.nativeReturned === false
      && data.resultHash === sha('native_outcome_unknown') && ['block', 'read_back'].includes(data.gateDecision)
      && registered && registered.value.sequence < rejected.sequence, 'a2a_native_blocked_receipt_invalid')
    const bindingKeys = ['toolId', 'canonicalName', 'effect', 'toolKind', 'resourceKey', ...(version2 ? ['completionEvidenceKind', 'sourcePinId'] : [])]
    check(tool && exact(action, [...bindingKeys, 'id', 'dispatchId', 'arguments', 'argumentsHash', 'mutationKey'])
      && bindingKeys.every(key => action[key] === tool[key]) && typeof action.dispatchId === 'string'
      && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(action.dispatchId) && action.id === action.dispatchId
      && !seen.has(action.dispatchId) && object(action.arguments) && action.argumentsHash === plainHash(action.arguments)
      && action.mutationKey === plainHash([scope.environmentGeneration, scope.appId, tool.resourceKey, tool.canonicalName, action.argumentsHash]),
    'a2a_native_blocked_action_invalid')
    seen.add(action.dispatchId)
    const host = reader.json(data.beforeEvidence), admission = host.trustedNativeCheckpoint, hostAction = hostActionProjection(host.input?.action)
    check(host.schemaVersion === 'capybara-runtime-plugin-invocation-v1' && host.executionId === event.childExecutionId && host.sessionId === event.childSessionId
      && uint(host.sequence) && host.sequence > 0 && host.input?.checkpoint === 'before_tool'
      && exact(hostAction, ['id', 'name', 'canonicalName', 'arguments', 'effect', 'mutationKey', 'resourceKey', 'authoritativeRead'])
      && hostAction.authoritativeRead === (action.effect === 'read')
      && hostAction?.id === action.id && hostAction.name === action.toolId
      && ['canonicalName', 'effect', 'resourceKey', 'mutationKey'].every(key => hostAction[key] === action[key])
      && same(hostAction.arguments, action.arguments) && object(host.decision) && host.decision.action === data.gateDecision
      && host.safetyFailure === null
      && typeof host.decision.reason === 'string' && host.decision.reason.trim() && host.decision.reason.length <= 2000
      && Object.keys(host.decision).every(key => ['action', 'reason', 'mutationKey', 'resourceKey'].includes(key))
      && (host.decision.resourceKey === undefined || host.decision.resourceKey === action.resourceKey)
      && (host.decision.mutationKey === undefined || host.decision.mutationKey === action.mutationKey)
      && Array.isArray(host.hookReceipts) && host.hookReceipts.length > 0 && host.hookReceipts.every(hook => hook.status === 'passed')
      && host.hookReceipts.some(hook => ['gaia2-a2a-guard', 'gaia2-write-guard', 'gaia2-conflict-gate'].includes(hook.hookId)
        && hook.matched === true && hook.decision?.action === data.gateDecision)
      && exact(admission, ['schemaVersion', 'scopeHash', 'checkpoint', 'actionHash', 'clockEvidenceRef', 'hookOutcome'])
      && admission.schemaVersion === 'capybara-trusted-native-checkpoint-v1' && admission.scopeHash === event.scopeHash
      && admission.checkpoint === 'before_tool' && admission.actionHash === a2aWireEvidenceHash(action) && admission.hookOutcome === null,
    'a2a_native_blocked_hook_invalid')
    const clock = reader.json(admission.clockEvidenceRef)
    check(exact(clock, ['schemaVersion', ...commonKeys, 'checkpoint', 'clock', 'clockAuthority', 'revisionMeaning', 'nativeReturnEvidenceRef'])
      && clock.schemaVersion === 'gaia2-private-native-clock-receipt-v1' && clock.sourceManifestHash === a2aWireEvidenceHash(manifest)
      && clock.scopeHash === event.scopeHash && clock.dispatchId === action.dispatchId && ID.test(clock.ticketId)
      && ['toolId', 'canonicalName', 'toolKind', 'effect'].every(key => clock[key] === action[key])
      && HASH.test(clock.rawArgumentsHash) && clock.effectiveArgumentsHash === a2aWireEvidenceHash(action.arguments)
      && clock.checkpoint === 'before_tool' && clock.clockAuthority === 'ARE' && clock.revisionMeaning === 'owner_observation_sequence_not_are_revision'
      && exact(clock.clock, ['now', 'revision']) && finite(clock.clock.now) && uint(clock.clock.revision) && clock.clock.revision > 0
      && same(host.input.clock, clock.clock) && clock.nativeReturnEvidenceRef === null && !tickets.has(clock.ticketId),
    'a2a_native_blocked_clock_invalid')
    tickets.add(clock.ticketId)
    const sameAttempt = value => value?.dispatchId === action.dispatchId
      || value?.scopeHash === event.scopeHash && value?.ticketId === clock.ticketId
    const clocks = entries.filter(item => item.value?.schemaVersion === clock.schemaVersion && sameAttempt(item.value))
    const discards = entries.filter(item => item.value?.schemaVersion === 'gaia2-private-native-discard-v1' && sameAttempt(item.value))
    check(clocks.length === 1 && clocks[0].ref.path === reader.pathFor(admission.clockEvidenceRef) && discards.length === 1
      && !entries.some(item => /^gaia2-private-native-(?:dispatch|return|ce)-v[12]$/.test(item.value?.schemaVersion ?? '') && sameAttempt(item.value))
      && !entries.some(item => item.value?.schemaVersion === 'capybara-runtime-delegation-receipt-v1'
        && ['native_started', 'native_return', 'native_completed', 'unknown_after_observed'].includes(item.value.kind)
        && item.value.data?.action?.dispatchId === action.dispatchId)
      && !entries.some(item => item.value?.schemaVersion === 'capybara-runtime-plugin-invocation-v1'
        && item.value.input?.checkpoint === 'after_tool' && item.value.input.action?.id === action.dispatchId)
      && !event.runnerSnapshot.actions.some(item => item.dispatchId === action.dispatchId), 'a2a_native_blocked_execution_claim')
    const discard = reader.json(data.nativeDiscardEvidenceRef)
    check(discards[0].ref.path === reader.pathFor(data.nativeDiscardEvidenceRef)
      && exact(discard, ['schemaVersion', ...commonKeys, 'gateDecision', 'beforeClockEvidenceRef', 'beforeHookEvidenceRef', 'discarded', 'consumed', 'nativeStarted'])
      && discard.schemaVersion === 'gaia2-private-native-discard-v1' && commonKeys.every(key => discard[key] === clock[key])
      && discard.gateDecision === data.gateDecision && discard.discarded === true && discard.consumed === false && discard.nativeStarted === false
      && sameSourceRef(discard.beforeClockEvidenceRef, admission.clockEvidenceRef) && sameSourceRef(discard.beforeHookEvidenceRef, data.beforeEvidence),
    'a2a_native_blocked_discard_invalid')
    const matching = blocked.filter(item => item?.dispatchId === action.dispatchId)
    check(matching.length === 1 && exact(matching[0], ['dispatchId', 'toolId', 'toolKind', 'status', 'gateDecision', 'nativeRejectionEvidenceRef'])
      && matching[0].toolId === action.toolId && matching[0].toolKind === action.toolKind && matching[0].status === 'blocked'
      && matching[0].gateDecision === data.gateDecision && sameSourceRef(matching[0].nativeRejectionEvidenceRef, { path: row.ref.sourcePath, sha256: row.ref.sha256 }),
    'a2a_native_blocked_snapshot_invalid')
    reader.consume(row.ref)
  }
  check(new Set(blocked.map(item => item?.dispatchId)).size === blocked.length, 'a2a_native_blocked_inventory_invalid')
}

function nativeDeadlineContext(event, entries, scope) {
  const registered = entries.find(row => row.value?.schemaVersion === 'capybara-runtime-delegation-receipt-v1'
    && row.value.kind === 'registered' && same(row.value.data?.scope, scope))
  const deadline = registered?.value.data.deadlineClock
  check(exact(deadline, ['schemaVersion', 'unit', 'issuedAt', 'requestTimeoutMs', 'deadline'])
    && deadline.schemaVersion === REGISTRY_CLOCK_CONTRACT && deadline.unit === 'seconds'
    && finite(deadline.issuedAt) && finite(deadline.requestTimeoutMs) && deadline.requestTimeoutMs > 0
    && deadline.deadline === scope.deadline && scope.deadline === deadline.issuedAt + deadline.requestTimeoutMs / 1000,
  'a2a_native_admission_deadline_invalid')
  return { ...deadline, registeredSequence: registered.value.sequence }
}

/** Owner refusal follows an allowed Hook and charged TS reservation, but must
 * prove that the physical native body never began. It is not Hook feedback. */
function refusedNativeEvidence(event, reader, inventory, entries, scope) {
  const rows = entries.filter(row => row.value?.schemaVersion === 'capybara-runtime-delegation-receipt-v1'
    && row.value.kind === 'native_rejected' && row.value.data?.code === 'DELEGATION_NATIVE_ADMISSION_REFUSED'
    && row.value.data?.scope && same(row.value.data.scope, scope))
  const seen = new Set(), tickets = new Set()
  for (const row of rows) {
    check(inventory.nativeAdmissionRequired, 'a2a_native_admission_contract_missing')
    const deadline = nativeDeadlineContext(event, entries, scope), data = row.value.data, action = data.action, tool = inventory.tools.get(action?.toolId)
    check(exact(data, ['scope', 'action', 'started', 'nativeReturned', 'resultHash', 'code', 'reservationCharged', 'physicalNativeStarted', 'nativeAdmissionRefusalEvidenceRef', 'beforeEvidence'])
      && data.started === true && data.nativeReturned === false && data.resultHash === sha('native_outcome_unknown')
      && data.reservationCharged === true && data.physicalNativeStarted === false && event.runnerSnapshot.failed === true
      && event.runnerSnapshot.completed === false, 'a2a_native_refusal_reservation_invalid')
    const bindingKeys = ['toolId', 'canonicalName', 'effect', 'toolKind', 'resourceKey', ...(inventory.version2 ? ['completionEvidenceKind', 'sourcePinId'] : [])]
    check(tool && exact(action, [...bindingKeys, 'id', 'dispatchId', 'arguments', 'argumentsHash', 'mutationKey'])
      && bindingKeys.every(key => action[key] === tool[key]) && typeof action.dispatchId === 'string'
      && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(action.dispatchId) && action.id === action.dispatchId
      && !seen.has(action.dispatchId) && object(action.arguments) && action.argumentsHash === plainHash(action.arguments)
      && action.mutationKey === plainHash([scope.environmentGeneration, scope.appId, tool.resourceKey, tool.canonicalName, action.argumentsHash]),
    'a2a_native_refusal_action_invalid')
    seen.add(action.dispatchId)
    const host = reader.json(data.beforeEvidence), checkpoint = host.trustedNativeCheckpoint
    check(host.schemaVersion === 'capybara-runtime-plugin-invocation-v1' && host.executionId === event.childExecutionId && host.sessionId === event.childSessionId
      && host.input?.checkpoint === 'before_tool' && host.decision?.action === 'allow' && host.safetyFailure === null
      && host.input.action?.id === action.id && host.input.action?.name === action.toolId
      && ['canonicalName', 'effect', 'resourceKey', 'mutationKey'].every(key => host.input.action[key] === action[key])
      && same(host.input.action.arguments, action.arguments) && host.input.action.authoritativeRead === (action.effect === 'read')
      && Array.isArray(host.hookReceipts) && host.hookReceipts.length > 0 && host.hookReceipts.every(hook => hook.status === 'passed')
      && host.hookReceipts.some(hook => hook.matched === true)
      && exact(checkpoint, ['schemaVersion', 'scopeHash', 'checkpoint', 'actionHash', 'clockEvidenceRef', 'hookOutcome'])
      && checkpoint.schemaVersion === 'capybara-trusted-native-checkpoint-v1' && checkpoint.scopeHash === event.scopeHash
      && checkpoint.checkpoint === 'before_tool' && checkpoint.actionHash === a2aWireEvidenceHash(action) && checkpoint.hookOutcome === null,
    'a2a_native_refusal_hook_invalid')
    const clock = reader.json(checkpoint.clockEvidenceRef)
    check(exact(clock, ['schemaVersion', ...NATIVE_COMMON, 'checkpoint', 'clock', 'clockAuthority', 'revisionMeaning', 'nativeReturnEvidenceRef'])
      && clock.schemaVersion === 'gaia2-private-native-clock-receipt-v1' && clock.sourceManifestHash === a2aWireEvidenceHash(inventory.manifest)
      && clock.scopeHash === event.scopeHash && clock.dispatchId === action.dispatchId && ID.test(clock.ticketId) && clock.ticketId.length === 32 && !tickets.has(clock.ticketId)
      && ['toolId', 'canonicalName', 'toolKind', 'effect'].every(key => clock[key] === action[key])
      && HASH.test(clock.rawArgumentsHash) && clock.rawArgumentsHash.length === 64 && clock.effectiveArgumentsHash === a2aWireEvidenceHash(action.arguments)
      && clock.checkpoint === 'before_tool' && clock.clockAuthority === 'ARE' && clock.revisionMeaning === 'owner_observation_sequence_not_are_revision'
      && exact(clock.clock, ['now', 'revision']) && finite(clock.clock.now) && uint(clock.clock.revision) && clock.clock.revision > 0
      && clock.clock.now >= deadline.issuedAt && clock.clock.now < scope.deadline && clock.nativeReturnEvidenceRef === null
      && same(host.input.clock, clock.clock), 'a2a_native_refusal_clock_invalid')
    tickets.add(clock.ticketId)
    const proofRef = data.nativeAdmissionRefusalEvidenceRef
    check(exact(proofRef, ['path', 'sha256']) && typeof proofRef.path === 'string'
      && /^admission-refusal-[a-f0-9]{32}\.json$/.test(portable(proofRef.path).split('/').at(-1))
      && sourceKey(proofRef.path) === sourceKey(joinIdentity(inventory.manifest.evidenceRoot,
        `json/${portable(proofRef.path).split('/').at(-1)}`)), 'a2a_native_refusal_reference_invalid')
    const proof = reader.json(proofRef)
    check(exact(proof, ['schemaVersion', ...NATIVE_COMMON, 'status', 'errorCode', 'nativeBodyStarted', 'ticketRevoked', 'childTerminated', 'unit', 'clockAuthority', 'observedAt', 'deadline', 'beforeClockEvidenceRef'])
      && proof.schemaVersion === 'gaia2-private-native-admission-refusal-receipt-v1' && NATIVE_COMMON.every(key => proof[key] === clock[key])
      && proof.status === 'rejected' && proof.errorCode === 'NATIVE_SCOPE_DEADLINE_EXPIRED' && proof.nativeBodyStarted === false
      && proof.ticketRevoked === true && proof.childTerminated === true && proof.unit === 'seconds' && proof.clockAuthority === 'ARE'
      && finite(proof.observedAt) && proof.observedAt >= scope.deadline && proof.observedAt >= clock.clock.now && proof.deadline === scope.deadline
      && sameSourceRef(proof.beforeClockEvidenceRef, { path: `json/${portable(checkpoint.clockEvidenceRef.path).split('/').at(-1)}`, sha256: checkpoint.clockEvidenceRef.sha256 }),
    'a2a_native_refusal_proof_invalid')
    check(same(reader.relative(inventory.manifest.evidenceRoot, proof.beforeClockEvidenceRef), clock), 'a2a_native_refusal_before_clock_join_invalid')
    const starts = entries.filter(item => item.value?.schemaVersion === 'capybara-runtime-delegation-receipt-v1' && item.value.kind === 'native_started'
      && item.value.data?.action?.dispatchId === action.dispatchId && same(item.value.data.scope, scope))
    check(starts.length === 1 && deadline.registeredSequence < starts[0].value.sequence && starts[0].value.sequence < row.value.sequence && same(starts[0].value.data.action, action)
      && sameSourceRef(starts[0].value.data.beforeEvidence, data.beforeEvidence)
      && starts[0].value.data.mutationStatus === (['write', 'finish'].includes(action.effect) ? 'pending' : null), 'a2a_native_refusal_registry_join_invalid')
    const sameAttempt = value => value?.dispatchId === action.dispatchId || value?.scopeHash === event.scopeHash && value?.ticketId === clock.ticketId
    const attemptClocks = entries.filter(item => item.value?.schemaVersion === clock.schemaVersion && sameAttempt(item.value))
    const attemptProofs = entries.filter(item => item.value?.schemaVersion === proof.schemaVersion && sameAttempt(item.value))
    check(attemptClocks.length === 1 && attemptClocks[0].ref.path === reader.pathFor(checkpoint.clockEvidenceRef)
      && attemptProofs.length === 1 && attemptProofs[0].ref.path === reader.pathFor(proofRef)
      && !entries.some(item => /^gaia2-private-native-(?:dispatch|return|ce)-v[12]$/.test(item.value?.schemaVersion ?? '') && sameAttempt(item.value))
      && !entries.some(item => item.value?.schemaVersion === 'capybara-runtime-delegation-receipt-v1'
        && ['native_return', 'native_completed', 'unknown_after_observed'].includes(item.value.kind) && item.value.data?.action?.dispatchId === action.dispatchId)
      && !entries.some(item => item.value?.schemaVersion === 'capybara-runtime-plugin-invocation-v1' && item.value.input?.checkpoint === 'after_tool' && item.value.input.action?.id === action.dispatchId)
      && !event.runnerSnapshot.actions.some(item => item.dispatchId === action.dispatchId)
      && !(event.runnerSnapshot.blockedActions ?? []).some(item => item.dispatchId === action.dispatchId), 'a2a_native_refusal_execution_claim')
    reader.consume(row.ref)
  }
  return rows.length
}

function nativeEvidence(event, reader, inventory, entries, scope) {
  const { manifest, tools, version2 } = inventory, manifestHash = a2aWireEvidenceHash(manifest)
  const returns = entries.filter(row => row.value?.schemaVersion === `gaia2-private-native-return-v${version2 ? 2 : 1}` && row.value.scopeHash === event.scopeHash)
  const clocks = entries.filter(row => row.value?.schemaVersion === 'gaia2-private-native-clock-receipt-v1' && row.value.scopeHash === event.scopeHash)
  const actions = event.runnerSnapshot.actions
  check(Array.isArray(actions) && new Set(actions.map(action => action?.dispatchId)).size === actions.length, 'a2a_native_action_inventory_invalid')
  blockedNativeEvidence(event, reader, inventory, entries, scope)
  const refused = refusedNativeEvidence(event, reader, inventory, entries, scope)
  const commonKeys = ['sourceManifestHash', 'scopeHash', 'ticketId', 'dispatchId', 'toolId', 'canonicalName', 'toolKind', 'effect', 'rawArgumentsHash', 'effectiveArgumentsHash']
  for (const row of returns) {
    const returned = row.value, tool = tools.get(returned.toolId)
    check(tool && returned.sourceManifestHash === manifestHash && HASH.test(returned.rawArgumentsHash) && HASH.test(returned.effectiveArgumentsHash)
      && ID.test(returned.ticketId) && typeof returned.dispatchId === 'string' && returned.toolKind === tool.toolKind && returned.canonicalName === tool.canonicalName && returned.effect === tool.effect,
      'a2a_native_return_identity_invalid')
    check(exact(returned, ['schemaVersion', ...commonKeys, 'status', 'returned', 'agentObservation', 'agentObservationHash', 'nativeRawResultHash', 'nativeCompletedEventRef', 'dispatchEvidenceRef', 'errorCode', ...(version2 ? ['completionEvidenceKind', 'sourcePinId', 'nativeRawProjection', 'ownerClock'] : [])]), 'a2a_native_return_shape_invalid')
    const dispatched = reader.relative(manifest.evidenceRoot, returned.dispatchEvidenceRef)
    check(dispatched.schemaVersion === 'gaia2-private-native-dispatch-v1' && commonKeys.every(key => dispatched[key] === returned[key]) && dispatched.status === 'pending' && finite(dispatched.ownerClock), 'a2a_native_dispatch_binding_invalid')
    if (version2) check(returned.completionEvidenceKind === tool.completionEvidenceKind && returned.sourcePinId === tool.sourcePinId, 'a2a_native_completion_kind_invalid')
    const matchedClocks = clocks.filter(item => item.value.dispatchId === returned.dispatchId)
    for (const item of matchedClocks) {
      const clock = item.value
      check(commonKeys.every(key => clock[key] === returned[key]) && clock.clockAuthority === 'ARE'
        && clock.revisionMeaning === 'owner_observation_sequence_not_are_revision' && exact(clock.clock, ['now', 'revision']) && finite(clock.clock.now) && uint(clock.clock.revision) && clock.clock.revision > 0,
        'a2a_native_clock_invalid'); reader.consume(item.ref)
    }
    const before = matchedClocks.find(item => item.value.checkpoint === 'before_tool')?.value
    const after = matchedClocks.find(item => item.value.checkpoint === 'after_tool')?.value
    check(matchedClocks.filter(item => item.value.checkpoint === 'before_tool').length === 1 && before.nativeReturnEvidenceRef === null, 'a2a_native_before_clock_missing')
    if (inventory.nativeAdmissionRequired) {
      const deadline = nativeDeadlineContext(event, entries, scope), admission = dispatched.nativeAdmission
      check(exact(dispatched, ['schemaVersion', ...commonKeys, 'status', 'ownerClock', 'nativeAdmission'])
        && exact(admission, ['schemaVersion', 'unit', 'clockAuthority', 'checkedAt', 'deadline', 'status'])
        && admission.schemaVersion === 'gaia2-native-admission-v1' && admission.unit === 'seconds' && admission.clockAuthority === 'ARE'
        && admission.status === 'admitted' && admission.deadline === scope.deadline && finite(admission.checkedAt)
        && admission.checkedAt >= deadline.issuedAt && admission.checkedAt >= before.clock.now && admission.checkedAt < scope.deadline
        && dispatched.ownerClock === admission.checkedAt, 'a2a_native_admission_invalid')
      if (after) check(after.clock.now >= admission.checkedAt, 'a2a_native_admission_clock_order_invalid')
    } else check(dispatched.nativeAdmission === undefined, 'a2a_native_admission_contract_missing')
    if (returned.status === 'succeeded') {
      check(returned.returned === true && returned.errorCode === null && returned.agentObservationHash === a2aWireEvidenceHash(returned.agentObservation)
        && HASH.test(returned.nativeRawResultHash) && after && matchedClocks.length === 2 && after.clock.now >= before.clock.now && after.clock.revision > before.clock.revision
        && same(after.nativeReturnEvidenceRef, { path: `json/${portable(row.ref.sourcePath).split('/').at(-1)}`, sha256: row.ref.sha256 }), 'a2a_native_after_clock_or_return_invalid')
      const recorded = actions.find(action => action.dispatchId === returned.dispatchId)
      check(recorded && recorded.toolId === returned.toolId && recorded.status === 'completed' && recorded.toolKind === returned.toolKind
        && recorded.childCompleted === (tool.toolKind === 'child_final_answer'), 'a2a_native_return_action_missing')
      const registryReturns = entries.filter(item => item.value?.schemaVersion === 'capybara-runtime-delegation-receipt-v1' && item.value.kind === 'native_return'
        && item.value.data?.action?.dispatchId === returned.dispatchId && item.value.data?.scope && a2aWireEvidenceHash(item.value.data.scope) === event.scopeHash)
      const completedRows = entries.filter(item => item.value?.schemaVersion === 'capybara-runtime-delegation-receipt-v1' && item.value.kind === 'native_completed'
        && item.value.data?.action?.dispatchId === returned.dispatchId && item.value.data?.scope && a2aWireEvidenceHash(item.value.data.scope) === event.scopeHash)
      check(registryReturns.length === 1 && completedRows.length === 1, 'a2a_native_registry_completion_missing')
      const registryReturn = registryReturns[0], completed = completedRows[0].value.data, action = registryReturn.value.data.action
      check(same(action, completed.action) && ['toolId', 'canonicalName', 'toolKind', 'effect', 'resourceKey'].every(key => action[key] === tool[key])
        && object(action.arguments) && a2aWireEvidenceHash(action.arguments) === returned.effectiveArgumentsHash
        && same(registryReturn.value.data.value, returned.agentObservation) && registryReturn.value.data.resultHash === plainHash(returned.agentObservation)
        && sameSourceRef(completed.nativeReturnEvidence, { path: registryReturn.ref.sourcePath, sha256: registryReturn.ref.sha256 }), 'a2a_native_registry_return_invalid')
      for (const [checkpoint, ref, nativeClock] of [['before_tool', completed.beforeEvidence, before], ['after_tool', completed.afterEvidence, after]]) {
        const host = reader.json(ref), admission = host.trustedNativeCheckpoint
        check(host.schemaVersion === 'capybara-runtime-plugin-invocation-v1' && host.executionId === event.childExecutionId && host.sessionId === event.childSessionId
          && host.input?.checkpoint === checkpoint && host.decision?.action === 'allow'
          && host.input.action?.id === action.id && host.input.action?.canonicalName === action.canonicalName && host.input.action?.effect === action.effect
          && host.input.action?.resourceKey === action.resourceKey && same(host.input.action.arguments, action.arguments)
          && Array.isArray(host.hookReceipts) && host.hookReceipts.length > 0 && host.hookReceipts.every(hook => hook.status === 'passed')
          && host.hookReceipts.some(hook => hook.matched === true)
          && admission?.schemaVersion === 'capybara-trusted-native-checkpoint-v1' && admission.scopeHash === event.scopeHash && admission.checkpoint === checkpoint
          && admission.actionHash === a2aWireEvidenceHash(action) && same(reader.json(admission.clockEvidenceRef), nativeClock)
          && same(host.input.clock, nativeClock.clock), 'a2a_native_host_clock_join_invalid')
        if (checkpoint === 'after_tool') check(host.input.outcome?.status === 'completed' && host.input.outcome?.executed === true && host.input.outcome?.complete === true
          && host.input.outcome.resultHash === registryReturn.value.data.resultHash && admission.hookOutcome?.status === 'succeeded'
          && admission.hookOutcome?.executed === true && admission.hookOutcome?.complete === true && admission.hookOutcome?.resultHash === registryReturn.value.data.resultHash,
          'a2a_native_host_outcome_invalid')
        else check(admission.hookOutcome === null, 'a2a_native_host_outcome_invalid')
      }
      if (tool.completionEvidenceKind === 'source_pinned_return') {
        check(returned.nativeCompletedEventRef === null && returned.sourcePinId === PIN && tool.effect === 'read'
          && object(returned.nativeRawProjection) && same(returned.nativeRawProjection, returned.agentObservation)
          && returned.nativeRawResultHash === a2aWireEvidenceHash(returned.nativeRawProjection) && returned.nativeRawResultHash === returned.agentObservationHash
          && finite(returned.ownerClock) && returned.ownerClock >= before.clock.now && returned.ownerClock <= after.clock.now, 'a2a_native_source_return_invalid')
        const joined = entries.filter(item => item.value?.schemaVersion === 'capybara-runtime-delegation-receipt-v1' && item.value.kind === 'native_return'
          && item.value.data?.action?.dispatchId === returned.dispatchId && item.value.data?.scope && a2aWireEvidenceHash(item.value.data.scope) === event.scopeHash)
        check(joined.length === 1 && joined[0].value.data.nativeCompletedEventRef === null
          && same(joined[0].value.data.value, returned.agentObservation) && joined[0].value.data.resultHash === plainHash(returned.agentObservation)
          && sameSourceRef(joined[0].value.data.sourcePinnedReturnEvidenceRef, { path: row.ref.sourcePath, sha256: row.ref.sha256 }), 'a2a_source_return_registry_join_missing')
      } else if (tool.toolKind === 'child_final_answer') {
        check(returned.nativeCompletedEventRef === null && returned.nativeRawResultHash === returned.agentObservationHash, 'a2a_native_final_evidence_invalid')
        if (version2) check(returned.nativeRawProjection === null && returned.ownerClock === null, 'a2a_native_completion_kind_invalid')
      } else {
        const ce = reader.relative(manifest.evidenceRoot, returned.nativeCompletedEventRef)
        check(ce.schemaVersion === 'gaia2-private-native-ce-v1' && commonKeys.every(key => ce[key] === returned[key])
          && ce.completed === true && ce.exception === null && ce.nativeRawResultHash === returned.nativeRawResultHash
          && a2aWireEvidenceHash(ce.nativeRawProjection) === ce.nativeRawResultHash && ce.formatterSourceHash === tool.formatterSourceHash
          && Array.isArray(ce.observedEvents) && ce.observedEvents.length > 0, 'a2a_native_completed_event_invalid')
        if (tool.formatterSourceHash === null) check(returned.agentObservationHash === returned.nativeRawResultHash, 'a2a_native_unformatted_return_mismatch')
        if (version2) check(returned.nativeRawProjection === null && returned.ownerClock === null, 'a2a_native_completion_kind_invalid')
      }
    } else {
      check(['failed', 'unknown'].includes(returned.status) && typeof returned.errorCode === 'string' && returned.errorCode
        && returned.agentObservation === null && returned.agentObservationHash === null && returned.nativeRawResultHash === null && returned.nativeCompletedEventRef === null,
      'a2a_native_failed_return_invalid')
      if (version2) check(returned.nativeRawProjection === null && returned.ownerClock === null, 'a2a_native_failed_return_invalid')
      check(event.runnerSnapshot.failed === true, 'a2a_native_failure_not_terminal')
      check(returned.status !== 'unknown', 'a2a_native_unknown_effect_not_officially_complete')
    }
    reader.consume(row.ref)
  }
  check(actions.every(action => returns.some(row => row.value.dispatchId === action.dispatchId && row.value.status === 'succeeded')), 'a2a_native_action_return_missing')
  if (event.runnerSnapshot.completed === true) {
    check(actions.length > 0 && actions.at(-1).childCompleted === true && object(event.runnerSnapshot.completionEvidenceRef), 'a2a_native_child_completion_missing')
    const completion = reader.json(event.runnerSnapshot.completionEvidenceRef)
    check(completion.schemaVersion === 'capybara-runtime-delegation-receipt-v1' && completion.kind === 'completed'
      && a2aWireEvidenceHash(completion.data?.scope) === event.scopeHash && completion.data.finalDispatchId === actions.at(-1).dispatchId, 'a2a_native_child_completion_invalid')
  }
  return { returns: returns.length, refused }
}

function pumpEvidence(events, event, nativeRefusalCount = 0) {
  const pump = events.map((item, index) => ({ item, index })).filter(row => row.item.type === 'a2a_parent_notification_pumped' && row.item.scopeHash === event.scopeHash)
  check(pump.length > 0, 'a2a_notification_pump_evidence_missing')
  const stages = new Set(['pre_step', 'model_admission', 'sdk_attempt_before', 'sdk_attempt_after', 'cooldown_before', 'cooldown_after', 'model_returned', 'native_before', 'child_close'])
  let now = -1, revision = -1, stoppedAt = null
  for (const row of pump) {
    const item = row.item
    check(item.appId === event.appId && item.childExecutionId === event.childExecutionId && item.childSessionId === event.childSessionId
      && stages.has(item.stage) && finite(item.clockNow) && item.clockNow >= now && uint(item.parentRevisionBefore) && uint(item.parentRevisionAfter)
      && item.parentRevisionBefore >= revision && item.parentRevisionAfter >= item.parentRevisionBefore && uint(item.publishedCount)
      && item.parentRevisionAfter - item.parentRevisionBefore >= item.publishedCount && typeof item.stopped === 'boolean' && typeof item.originRevoked === 'boolean', 'a2a_notification_pump_evidence_invalid')
    if (stoppedAt !== null) check(item.stopped === true && item.originRevoked === true, 'a2a_notification_stop_revived')
    if (item.stopped) { check(item.originRevoked === true, 'a2a_notification_stop_not_revoked'); stoppedAt ??= row.index }
    now = item.clockNow; revision = item.parentRevisionAfter
  }
  const attempts = events.map((item, index) => ({ item, index })).filter(row => row.item.type === 'model_request_attempt' && row.item.modelRole === 'child_actor' && row.item.delegationScopeHash === event.scopeHash)
  let lastAttempt = -1
  for (const attempt of attempts) {
    check(stoppedAt === null || attempt.index < stoppedAt, 'a2a_sdk_attempt_after_stop')
    check(pump.some(row => row.index > lastAttempt && row.index < attempt.index && row.item.stage === 'sdk_attempt_before'), 'a2a_sdk_attempt_pump_missing')
    lastAttempt = attempt.index
  }
  const snapshot = event.runnerSnapshot
  check(pump.some(row => row.item.stage === 'child_close'), 'a2a_notification_final_drain_missing')
  if (snapshot.engineCalls > 0) check(pump.some(row => row.item.stage === 'model_admission'), 'a2a_notification_model_admission_missing')
  if (snapshot.actions.length > 0 || snapshot.blockedActions?.length > 0 || nativeRefusalCount > 0) check(pump.filter(row => row.item.stage === 'native_before').length >= snapshot.actions.length + (snapshot.blockedActions?.length ?? 0) + nativeRefusalCount, 'a2a_notification_native_pump_missing')
  if (snapshot.completed === true) check(stoppedAt === null || pump.find(row => row.index === stoppedAt).item.stage === 'child_close', 'a2a_notification_stopped_child_completed')
}

function registryEvidence(entries, event, reader) {
  const rows = entries.filter(row => row.value?.schemaVersion === 'capybara-runtime-delegation-receipt-v1').sort((a, b) => a.value.sequence - b.value.sequence)
  const kinds = new Set(['initialized', 'closing', 'closed', 'registered', 'child_initializing', 'initialization_failed', 'running', 'initialization_rejected',
    'model_admitted', 'native_started', 'native_return', 'native_completed', 'native_rejected', 'unknown_after_observed', 'completed', 'cancelled'])
  check(rows.length > 0 && rows[0].value.kind === 'initialized', 'a2a_registry_chain_missing')
  const binding = rows[0].value.data?.apps?.find(app => app.appId === event.appId)
  const projectedTools = event.nativeManifest.tools.map(({ publicName: _name, signatureHash: _signature, formatterSourceHash: _formatter, ...tool }) => tool)
  check(binding && binding.toolInventoryHash === event.nativeManifest.toolInventoryHash && same(binding.tools, projectedTools), 'a2a_registry_native_inventory_mismatch')
  let previous = null
  for (const [index, row] of rows.entries()) {
    const value = row.value
    check(exact(value, ['schemaVersion', 'environmentGeneration', 'parentExecutionId', 'parentSessionId', 'sequence', 'previousHash', 'kind', 'data'])
      && value.parentExecutionId === event.executionId && value.parentSessionId === event.sessionId
      && value.environmentGeneration === event.nativeManifest.environmentGeneration && value.sequence === index + 1 && value.previousHash === previous
      && kinds.has(value.kind) && object(value.data), 'a2a_registry_chain_invalid')
    if (value.data.scope) check(value.data.scope.parentExecutionId === event.executionId && value.data.scope.parentSessionId === event.sessionId
      && value.data.scope.environmentGeneration === value.environmentGeneration, 'a2a_registry_scope_invalid')
    previous = row.ref.sha256; reader.consume(row.ref)
  }
  return rows
}

function deadlineClockRequired(inventory, reader, environmentLock) {
  const path = '/scripts/gaia2_official_a2a.py'
  const source = [...inventory.sources.values()].find(ref => sourceKey(ref.path).endsWith(path))
  const frozen = environmentLock?.codeInputs?.find(ref => sourceKey(ref.path) === path.slice(1))
  // A new event marker is not the authority selecting the contract. Read the
  // sealed, hash-checked source, so deleting all event/receipt markers cannot
  // silently turn a new production scope into a legacy scope.
  if (frozen) check(source && source.sha256 === frozen.sha256, 'a2a_deadline_clock_source_missing')
  if (!source) return null
  const text = new TextDecoder('utf-8', { fatal: true }).decode(reader.absolute(source))
  const declaration = text.match(/^A2A_DEADLINE_CLOCK_CONTRACT\s*=\s*["']([^"']+)["']\s*$/m)
  if (!declaration) return null // Source-frozen pre-clock-contract evidence.
  check([CLOCK_CONTRACT, NATIVE_CLOCK_CONTRACT].includes(declaration[1]), 'a2a_deadline_clock_contract_invalid')
  if (declaration[1] === NATIVE_CLOCK_CONTRACT) check(inventory.nativeAdmissionRequired, 'a2a_native_admission_contract_missing')
  return declaration[1]
}

function deadlineClockEvidence(rows, event, reader, { required, deadlineRequestTimeoutMs }) {
  const initialized = rows[0].value.data, contract = initialized.clockContract
  if (!required && contract === undefined) return
  check(exact(contract, ['schemaVersion', 'unit']) && contract.schemaVersion === REGISTRY_CLOCK_CONTRACT
    && ['milliseconds', 'seconds'].includes(contract.unit) && (!required || contract.unit === 'seconds'), 'a2a_deadline_clock_contract_missing')
  const registration = rows.find(row => row.value.kind === 'registered'
    && row.value.data?.scope && a2aWireEvidenceHash(row.value.data.scope) === event.scopeHash)
  check(registration, 'a2a_runtime_registered_scope_missing')
  const scope = registration.value.data.scope, clock = registration.value.data.deadlineClock
  const binding = initialized.apps.find(app => app.appId === event.appId)
  check(exact(clock, ['schemaVersion', 'unit', 'issuedAt', 'requestTimeoutMs', 'deadline'])
    && clock.schemaVersion === REGISTRY_CLOCK_CONTRACT && clock.unit === contract.unit && finite(clock.issuedAt)
    && finite(clock.requestTimeoutMs) && clock.requestTimeoutMs > 0 && clock.requestTimeoutMs === binding.requestTimeoutMs
    && finite(scope.deadline) && scope.deadline > clock.issuedAt && clock.deadline === scope.deadline
    && scope.deadline === clock.issuedAt + (clock.unit === 'seconds' ? clock.requestTimeoutMs / 1000 : clock.requestTimeoutMs),
  'a2a_deadline_clock_semantics_invalid')
  if (!required) return
  check(Number.isSafeInteger(deadlineRequestTimeoutMs) && deadlineRequestTimeoutMs > 0
    && deadlineRequestTimeoutMs <= 2147483647 && clock.requestTimeoutMs === deadlineRequestTimeoutMs, 'a2a_deadline_clock_policy_mismatch')
  const allowedClock = ref => {
    const host = reader.json(ref)
    check(finite(host.input?.clock?.now) && host.input.clock.now >= clock.issuedAt
      && host.input.clock.now < scope.deadline, 'a2a_authorization_after_deadline')
  }
  for (const row of rows.filter(row => row.value.data?.scope && a2aWireEvidenceHash(row.value.data.scope) === event.scopeHash)) {
    if (row.value.kind === 'model_admitted' || row.value.kind === 'native_started') allowedClock(row.value.data.beforeEvidence)
    if (row.value.kind === 'native_completed') allowedClock(row.value.data.afterEvidence)
  }
}

function brokerEvidence(events, event, record, generation) {
  const rows = events.filter(item => item.modelRole === 'child_actor' && item.delegationScopeHash === event.scopeHash && item.requestId === record.requestId)
  for (const item of rows) check(item.schemaVersion === 'gaia2-scoped-model-event-v1' && item.appId === event.appId
    && item.childExecutionId === event.childExecutionId && item.childSessionId === event.childSessionId
    && item.parentExecutionId === event.executionId && item.parentSessionId === event.sessionId
    && ['permitId', 'requestId', 'actualInputHash', 'modelScopeHash'].every(key => item[key] === record[key]), 'a2a_broker_event_identity_invalid')
  const attempts = rows.filter(item => item.type === 'model_request_attempt'), started = rows.filter(item => item.type === 'model_logical_request_started')
  const finished = rows.filter(item => item.type === 'model_logical_request_finished'), successes = rows.filter(item => item.type === 'model_request_succeeded')
  check(attempts.length === record.sdkAttempts.length && attempts.every((item, index) => item.requestAttempt === index + 1), 'a2a_sdk_event_receipt_mismatch')
  if (attempts.length || rows.length) check(started.length === 1 && finished.length === 1 && finished[0].sdkAttempts === attempts.length
    && ['succeeded', 'failed', 'rejected'].includes(finished[0].status), 'a2a_broker_logical_lifecycle_invalid')
  if (record.completed || generation.returned) check(successes.length === 1 && successes[0].outputHash === (record.completed ? record.outputHash : generation.returned.outputHash)
    && finished[0]?.status === 'succeeded', 'a2a_broker_success_evidence_missing')
  else check(successes.length <= 1, 'a2a_broker_success_duplicate')
  if (record.completed) check(attempts.length > 0, 'a2a_broker_success_without_sdk')
}

/** Verify all production scopes, including failed/cancelled children. No fs,
 * network, model calls, absolute-path reads, or mutations are permitted here. */
export function verifyOfficialA2ARuntimeEvidence({ events, identity, readEvidence, environmentLock = null, deadlineRequestTimeoutMs = null }) {
  check(Array.isArray(events), 'a2a_events_invalid')
  const pools = events.filter(event => event.type === 'a2a_client_pool_snapshot')
  check(pools.length === 1 && Array.isArray(pools[0].clients), pools.length ? 'a2a_client_pool_duplicate' : 'a2a_client_pool_missing')
  const pool = pools[0]
  const children = events.filter(event => event.type === 'a2a_child_runtime_snapshot')
  const clockContracts = new Map(), childEvidence = new Map()
  for (const event of children) {
    const reader = makeReader(event, readEvidence), inventory = manifestTools(event, reader, environmentLock)
    childEvidence.set(event, { reader, inventory })
    clockContracts.set(event.scopeHash, deadlineClockRequired(inventory, reader, environmentLock))
  }
  const requiredClockContract = [...clockContracts.values()].some(Boolean)
  const production = pool.clients.filter(client => client.notificationPumpRequired === true || client.generationTimeRequired === true || client.guard?.schemaVersion === 'gaia2-official-a2a-guard-binding-v2')
  if (!production.length && !requiredClockContract) return { consumedEvidencePaths: [], childCount: 0, modelRequestCount: 0, nativeReturnCount: 0 }
  check(production.length === pool.clients.length, 'a2a_production_pool_mixed_contract')
  const sourceContracts = new Set([...clockContracts.values()].filter(Boolean))
  check(sourceContracts.size <= 1, 'a2a_deadline_clock_contract_invalid')
  if (requiredClockContract) check(pool.clients.every(client => client.deadlineClockContract === [...sourceContracts][0]
    && client.deadlineClockUnit === 'seconds'), 'a2a_deadline_clock_contract_missing')
  const expected = production.flatMap(client => (client.childScopeHashes ?? []).map(scopeHash => ({ scopeHash, appId: client.appId })))
  check(children.length === expected.length && new Set(children.map(event => event.scopeHash)).size === children.length
    && children.every(event => expected.some(item => item.scopeHash === event.scopeHash && item.appId === event.appId)), 'a2a_runtime_scope_inventory_mismatch')
  const consumed = new Set(), allRequests = new Set(), allPermits = new Set(), counts = new Map()
  let nativeReturnCount = 0, nativeAdmissionRefusalCount = 0, nativeAdmissionGuardedChildCount = 0
  for (const event of children) {
    const runner = event.runnerSnapshot
    check(event.executionId === pool.executionId && event.sessionId === pool.sessionId && (!identity?.executionId || event.executionId === identity.executionId)
      && HASH.test(event.scopeHash) && typeof event.childExecutionId === 'string' && event.childExecutionId && typeof event.childSessionId === 'string' && event.childSessionId
      && object(runner) && runner.schemaVersion === 'gaia2-scoped-app-agent-v1' && runner.scopeHash === event.scopeHash
      && runner.notificationReaderAttached === true && runner.notificationPumpAttached === true && runner.deadlineOptIn === true
      && runner.generationTimeOptIn === true && runner.generationTimeOwnerFactoryBound === true && runner.generationLedgerFactoryBound === true
      && runner.generationTimingOffsetMode === 'successfulSdkElapsedSeconds' && runner.generationTimingSource === 'ScopedRetryModelEngine.monotonic_clock'
      && runner.modelGateEnabled === true && HASH.test(runner.modelScopeHash) && Array.isArray(runner.modelRequests)
      && uint(runner.modelCalls) && uint(runner.engineCalls) && uint(runner.sdkAttemptsUsed) && Array.isArray(runner.actions)
      && typeof runner.completed === 'boolean' && typeof runner.failed === 'boolean' && (runner.completed !== runner.failed)
      && (runner.completed ? runner.failureCode === null : typeof runner.failureCode === 'string' && /^[A-Z0-9_]{1,80}$/.test(runner.failureCode)), 'a2a_runtime_child_snapshot_invalid')
    const { reader, inventory } = childEvidence.get(event), entries = reader.entries()
    const registryRows = registryEvidence(entries, event, reader)
    deadlineClockEvidence(registryRows, event, reader, { required: clockContracts.get(event.scopeHash), deadlineRequestTimeoutMs })
    const registered = entries.filter(row => row.value?.schemaVersion === 'capybara-runtime-delegation-receipt-v1' && row.value.kind === 'registered' && row.value.data?.scope && a2aWireEvidenceHash(row.value.data.scope) === event.scopeHash)
    check(registered.length === 1, 'a2a_runtime_registered_scope_missing')
    const scope = registered[0].value.data.scope
    check(scope.appId === event.appId && scope.childExecutionId === event.childExecutionId && scope.childSessionId === event.childSessionId
      && scope.parentExecutionId === event.executionId && scope.parentSessionId === event.sessionId && scope.toolInventoryHash === inventory.manifest.toolInventoryHash,
      'a2a_runtime_registered_scope_invalid')
    let sdkCount = 0
    for (const record of runner.modelRequests) {
      check(object(record) && ID.test(record.requestId) && ID.test(record.permitId) && HASH.test(record.actualInputHash)
        && record.scopeHash === event.scopeHash && record.modelScopeHash === runner.modelScopeHash && Array.isArray(record.sdkAttempts)
        && !allRequests.has(record.requestId) && !allPermits.has(record.permitId), 'a2a_model_receipt_identity_invalid')
      allRequests.add(record.requestId); allPermits.add(record.permitId)
      const before = reader.json(record.beforeEvidenceRef)
      check(before.schemaVersion === 'capybara-runtime-plugin-invocation-v1' && before.executionId === event.childExecutionId && before.sessionId === event.childSessionId
        && before.input?.checkpoint === 'before_model' && before.decision?.action === 'allow' && before.trustedModelAdmission?.delegationScopeHash === event.scopeHash
        && before.trustedModelAdmission?.modelScopeHash === runner.modelScopeHash && before.trustedModelAdmission.originalMessagesHash === record.originalMessagesHash,
        'a2a_model_gate_evidence_invalid')
      check(a2aWireEvidenceHash(before.trustedModelAdmission.modelScope) === runner.modelScopeHash
        && before.trustedModelAdmission.modelScope?.delegationScopeHash === event.scopeHash && before.trustedModelAdmission.modelScope?.modelRole === 'child_actor'
        && typeof before.context === 'string' && before.context.trim() && sha(before.context) === before.contextHash
        && before.contextHash === record.contextHash && before.variablesHash === record.variablesHash && before.revision === record.revision
        && Array.isArray(before.hookReceipts) && before.hookReceipts.length > 0 && before.hookReceipts.every(hook => hook.status === 'passed')
        && before.hookReceipts.some(hook => hook.matched === true), 'a2a_model_gate_binding_invalid')
      const admissions = entries.filter(row => row.value?.schemaVersion === 'capybara-runtime-delegation-receipt-v1' && row.value.kind === 'model_admitted'
        && row.value.data?.requestId === record.requestId && row.value.data?.scope && a2aWireEvidenceHash(row.value.data.scope) === event.scopeHash)
      check(admissions.length === 1 && same(admissions[0].value.data.admission, before.trustedModelAdmission)
        && sameSourceRef(admissions[0].value.data.beforeEvidence, record.beforeEvidenceRef), 'a2a_model_registry_admission_missing')
      for (const [index, ack] of record.sdkAttempts.entries()) check(ack.schemaVersion === 'capybara-scoped-model-sdk-attempt-v1'
        && ['permitId', 'requestId', 'actualInputHash', 'scopeHash', 'modelScopeHash'].every(key => ack[key] === record[key]) && ack.attempt === index + 1,
      'a2a_sdk_receipt_invalid')
      sdkCount += record.sdkAttempts.length
      const generation = generationEvidence(record, event, reader)
      brokerEvidence(events, event, record, generation)
    }
    check(runner.sdkAttemptsUsed === sdkCount && runner.modelRequests.length <= runner.modelCalls
      && (runner.failed || runner.modelRequests.length === runner.modelCalls && runner.engineCalls === runner.modelCalls), 'a2a_model_runtime_counter_mismatch')
    const native = nativeEvidence(event, reader, inventory, entries, scope)
    nativeReturnCount += native.returns; nativeAdmissionRefusalCount += native.refused
    if (inventory.nativeAdmissionRequired) nativeAdmissionGuardedChildCount++
    const successfulNativeReturns = entries.filter(row => /^gaia2-private-native-return-v[12]$/.test(row.value?.schemaVersion ?? '')
      && row.value.scopeHash === event.scopeHash && row.value.status === 'succeeded').length
    check(uint(runner.originalObservationsTaken) && (runner.completed
      ? runner.originalObservationsTaken === runner.actions.length
      : runner.originalObservationsTaken >= runner.actions.length && runner.originalObservationsTaken <= successfulNativeReturns), 'a2a_native_observation_counter_invalid')
    pumpEvidence(events, event, native.refused)
    if (clockContracts.get(event.scopeHash)) {
      const scopeDeadline = scope.deadline
      const attempts = events.map((item, index) => ({ item, index })).filter(row => row.item.type === 'model_request_attempt'
        && row.item.modelRole === 'child_actor' && row.item.delegationScopeHash === event.scopeHash)
      for (const attempt of attempts) {
        const before = events.slice(0, attempt.index).findLast(item => item.type === 'a2a_parent_notification_pumped'
          && item.scopeHash === event.scopeHash && item.stage === 'sdk_attempt_before')
        check(before && finite(before.clockNow) && before.clockNow < scopeDeadline, 'a2a_authorization_after_deadline')
      }
    }
    // Every bundled non-source file must be a source-bound receipt; arbitrary
    // attachments cannot become an unconsumed-evidence exception.
    for (const row of entries) {
      const value = row.value
      if (reader.used.has(row.ref.path)) continue
      if (value?.schemaVersion === 'capybara-runtime-delegation-receipt-v1') {
        check(value.parentExecutionId === event.executionId && value.parentSessionId === event.sessionId && uint(value.sequence) && value.sequence > 0
          && (value.previousHash === null || HASH.test(value.previousHash)) && typeof value.kind === 'string', 'a2a_delegation_evidence_identity_invalid'); reader.consume(row.ref)
      } else if (value?.schemaVersion === 'capybara-runtime-plugin-host-v1') {
        check(value.executionId === event.childExecutionId && value.sessionId === event.childSessionId, 'a2a_child_host_evidence_identity_invalid')
        const initialized = entries.filter(item => item.value?.schemaVersion === 'capybara-runtime-delegation-receipt-v1'
          && item.value.kind === 'running' && item.value.data?.scope && a2aWireEvidenceHash(item.value.data.scope) === event.scopeHash
          && sameSourceRef(item.value.data.initializationEvidence, { path: row.ref.sourcePath, sha256: row.ref.sha256 }))
        check(initialized.length === 1 && Array.isArray(value.plugins) && value.plugins.length > 0 && Array.isArray(value.harnesses)
          && Array.isArray(value.runtimeHooks) && Array.isArray(value.trainingHooks) && HASH.test(value.variablesHash), 'a2a_child_host_initialization_unbound')
        reader.consume(row.ref)
      }
    }
    check(reader.used.size === reader.refs.size, 'a2a_runtime_evidence_unconsumed')
    reader.used.forEach(path => consumed.add(path))
    const count = counts.get(event.appId) ?? { models: 0, sdk: 0 }; count.models += runner.modelRequests.length; count.sdk += sdkCount; counts.set(event.appId, count)
  }
  for (const client of production) {
    const count = counts.get(client.appId) ?? { models: 0, sdk: 0 }
    check(client.modelRequests === count.models && client.sdkAttempts === count.sdk, 'a2a_client_runtime_counter_mismatch')
  }
  return { consumedEvidencePaths: [...consumed].sort(), childCount: children.length, modelRequestCount: allRequests.size, nativeReturnCount,
    nativeAdmissionRefusalCount, nativeAdmissionGuardedChildCount }
}

export function officialA2ARuntimeEvidenceErrors(events, identity, options = {}) {
  try { verifyOfficialA2ARuntimeEvidence({ events, identity, ...options }); return [] }
  catch (error) { return [typeof error?.message === 'string' && /^a2a_[a-z_]+$/.test(error.message) ? error.message : 'a2a_runtime_evidence_invalid'] }
}
