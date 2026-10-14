import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { a2aWireEvidenceHash as wire, verifyOfficialA2ARuntimeEvidence, officialA2ARuntimeEvidenceErrors } from '../src/phase5_a2a_evidence.mjs'
import { officialA2ATraceErrors } from '../src/phase2_audit.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const h = character => character.repeat(64)
const id = character => character.repeat(32)
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)

function fixture({ sourceReturn = false, failedGeneration = false, blockedBefore = false, blockedArguments,
  deadlineClock = false, scopeDeadline = 1000, clockTimeoutMs = 900000, clockUnit = 'seconds', nativeAdmission = false, nativeRefusal = false } = {}) {
  if (nativeAdmission || nativeRefusal) deadlineClock = true
  const clockVersion = nativeAdmission || nativeRefusal ? 'gaia2-official-a2a-clock-v2' : 'gaia2-official-a2a-clock-v1'
  const buffers = new Map(), refs = [], appId = sourceReturn ? 'Shopping' : 'Calendar'
  const root = 'C:/evidence/native', ledgerRoot = `${root}/generation-time/${id('a')}`
  const store = (sourcePath, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(`${JSON.stringify(value)}\n`)
    const ref = { path: `runs/fixture/workspaces/session/capture/${refs.length}.bin`, sha256: sha(bytes), sourcePath }
    refs.push(ref); buffers.set(ref.path, bytes); return { path: sourcePath, sha256: ref.sha256 }
  }
  const sourceBytes = Buffer.from(deadlineClock ? `A2A_DEADLINE_CLOCK_CONTRACT = "${clockVersion}"\n` : 'trusted source fixture'),
    source = { path: deadlineClock ? 'C:/source/scripts/gaia2_official_a2a.py' : 'C:/source/owner.py', sha256: sha(sourceBytes), bytes: sourceBytes.length }
  store(source.path, sourceBytes)
  const sources = [source]
  if (sourceReturn) {
    const bytes = readFileSync(new URL('../.official-python/are/simulation/apps/shopping.py', import.meta.url))
    const pinned = { path: 'C:/source/are/simulation/apps/shopping.py', sha256: sha(bytes), bytes: bytes.length }
    sources.push(pinned); store(pinned.path, bytes)
  }
  const final = { toolId: 'final_answer', publicName: 'final_answer', canonicalName: 'final_answer', effect: 'finish', toolKind: 'child_final_answer', resourceKey: appId, signatureHash: h('1'), formatterSourceHash: null }
  const getter = { toolId: 'native-getter', publicName: 'Shopping__get_all_discount_codes', canonicalName: 'Shopping__get_all_discount_codes', effect: 'read', toolKind: 'app_tool', resourceKey: appId, signatureHash: h('2'), formatterSourceHash: null,
    completionEvidenceKind: 'source_pinned_return', sourcePinId: 'are-1.2-shopping-discount-codes-read-v1' }
  if (sourceReturn) Object.assign(final, { completionEvidenceKind: 'child_final_answer', sourcePinId: null })
  const writer = { toolId: 'native-writer', publicName: 'Calendar__create_event', canonicalName: 'Calendar__create_event', effect: 'write', toolKind: 'app_tool', resourceKey: appId, signatureHash: h('8'), formatterSourceHash: null }
  const tools = sourceReturn ? [getter, final] : blockedBefore || nativeRefusal ? [writer, final] : [final]
  const manifest = { schemaVersion: `gaia2-native-app-binding-v${sourceReturn ? 2 : 1}`, environmentGeneration: 'official-exec', parentExecutionId: 'exec', parentSessionId: 'session', appId,
    appType: sourceReturn ? 'are.simulation.apps.shopping.Shopping' : 'fixture.Calendar', evidenceRoot: root, parentCanonicalName: 'AppAgent__expert_agent', taskArgumentKey: 'task', sourceRefs: sources, tools, toolInventoryHash: wire(tools) }
  if (nativeAdmission || nativeRefusal) manifest.nativeAdmissionDeadline = { schemaVersion: 'gaia2-native-admission-deadline-v1', unit: 'seconds', clockAuthority: 'ARE' }
  const scope = { environmentGeneration: manifest.environmentGeneration, parentExecutionId: 'exec', parentSessionId: 'session', appId, parentCanonicalName: manifest.parentCanonicalName,
    taskArgumentKey: 'task', toolInventoryHash: manifest.toolInventoryHash, taskHash: h('3'), task: 'fixture task', requestId: id('b'), parentActionId: 'parent-action', childExecutionId: 'child', childSessionId: 'child-session', deadline: scopeDeadline, maxNativeActions: 10 }
  const scopeHash = wire(scope)
  const modelScope = { modelRole: 'child_actor', delegationScopeHash: scopeHash, configHash: h('4') }
  const modelAdmission = { delegationScopeHash: scopeHash, modelScope, modelScopeHash: wire(modelScope), originalMessagesHash: h('6') }
  const genSourceHash = sha(Buffer.from(`${source.path}\0${source.sha256}\0${source.bytes}`))
  const record = { scopeHash, modelScopeHash: wire(modelScope), permitId: id('c'), requestId: id('a'), actualInputHash: h('5'), originalMessagesHash: h('6'), sdkAttempts: [], completed: !failedGeneration,
    contextHash: sha('trusted context'), variablesHash: h('a'), revision: 1,
    generationLedgerRoot: ledgerRoot, generationOwnerSourceRefs: [source] }
  record.sdkAttempts.push({ schemaVersion: 'capybara-scoped-model-sdk-attempt-v1', permitId: record.permitId, requestId: record.requestId, actualInputHash: record.actualInputHash, scopeHash, modelScopeHash: record.modelScopeHash, attempt: 1 })
  record.beforeEvidenceRef = store('C:/evidence/child-host/before.json', { schemaVersion: 'capybara-runtime-plugin-invocation-v1', executionId: 'child', sessionId: 'child-session',
    input: { checkpoint: 'before_model', ...(deadlineClock ? { clock: { now: 100, revision: 1 } } : {}) }, decision: { action: 'allow' }, trustedModelAdmission: modelAdmission,
    context: 'trusted context', contextHash: record.contextHash, variablesHash: record.variablesHash, revision: record.revision, hookReceipts: [{ status: 'passed', matched: true }] })
  const lease = { leaseId: id('d'), scopeHash, modelScopeHash: record.modelScopeHash, permitId: record.permitId, requestId: record.requestId, actualInputHash: record.actualInputHash, sourceManifestHash: genSourceHash,
    beforeNow: 100, pausedNow: 100, pausePassedTime: 100, released: false }
  record.generationOwnerAcquired = { schemaVersion: 'gaia2-generation-time-owner-v1', appId, lease }
  record.generationOwnerReleased = { ...lease, released: true, offset: failedGeneration ? 0 : 2, ...(failedGeneration ? { cleanup: true, environmentState: 'STOPPED' } : { resumeBeforeNow: 100, resumeAfterNow: 102 }) }
  const timing = { logicalElapsedSeconds: 12, sdkAttemptElapsedSeconds: 8, successfulSdkElapsedSeconds: 2, cooldownSeconds: 4 }
  const ledger = { schemaVersion: 'gaia2-generation-time-ledger-v1', sourceManifestHash: genSourceHash, scopeHash, modelScopeHash: record.modelScopeHash, permitId: record.permitId, requestId: record.requestId, actualInputHash: record.actualInputHash,
    sequence: 0, previousHash: null, phase: 'new', evidenceRefs: [] }
  const addGeneration = (kind, fields = {}) => {
    const { sequence, previousHash, phase: _phase, evidenceRefs: _refs, ...common } = ledger
    const value = { ...common, sequence: sequence + 1, previousHash, kind, ...fields }, relative = `json/${String(sequence + 1).padStart(6, '0')}-generation-time.json`
    const ref = store(`${ledgerRoot}/${relative}`, value)
    ledger.sequence++; ledger.previousHash = ref.sha256; ledger.evidenceRefs.push({ path: relative, sha256: ref.sha256 })
  }
  addGeneration('admission'); addGeneration('pause_acquired', { leaseId: lease.leaseId })
  if (failedGeneration) { addGeneration('failed', { failureCode: 'SCOPED_AGENT_NOTIFICATION_STOPPED' }); ledger.phase = 'failed'; record.generationLedgerFinal = ledger }
  else {
    addGeneration('model_returned', { outputHash: h('7'), timing, usage: null }); addGeneration('pause_released', { leaseId: lease.leaseId, offset: 2 }); addGeneration('model_finished', { outputHash: h('7'), usage: null })
    ledger.phase = 'finished'; Object.assign(record, { outputHash: h('7'), usage: null, generationTiming: timing, generationOffset: 2,
      generationOffsetMode: 'successfulSdkElapsedSeconds', generationTimingSource: 'ScopedRetryModelEngine.monotonic_clock', generationLedgerFinished: ledger })
  }
  let registrySequence = 0, registryPrevious = null
  const registry = (kind, data) => {
    const ref = store(`C:/evidence/plugin-delegation/${++registrySequence}.json`, { schemaVersion: 'capybara-runtime-delegation-receipt-v1', environmentGeneration: manifest.environmentGeneration,
      parentExecutionId: 'exec', parentSessionId: 'session', sequence: registrySequence, previousHash: registryPrevious, kind, data })
    registryPrevious = ref.sha256; return ref
  }
  registry('initialized', { apps: [{ appId, toolInventoryHash: manifest.toolInventoryHash, ...(deadlineClock ? { requestTimeoutMs: clockTimeoutMs } : {}), tools: tools.map(({ publicName: _name, signatureHash: _signature, formatterSourceHash: _formatter, ...tool }) => tool) }],
    ...(deadlineClock ? { clockContract: { schemaVersion: 'capybara-runtime-delegation-clock-v1', unit: clockUnit } } : {}) })
  registry('registered', { scope, ...(deadlineClock ? { deadlineClock: { schemaVersion: 'capybara-runtime-delegation-clock-v1', unit: clockUnit, issuedAt: 100, requestTimeoutMs: clockTimeoutMs, deadline: scopeDeadline } } : {}) }); registry('model_admitted', { scope, requestId: record.requestId, admission: modelAdmission, beforeEvidence: record.beforeEvidenceRef })
  const blockedActions = []
  if (blockedBefore) {
    const argumentsValue = blockedArguments ?? { title: 'fixture' }, argumentsHash = sha(canonical(argumentsValue))
    const { publicName: _name, signatureHash: _signature, formatterSourceHash: _formatter, ...binding } = writer
    const action = { ...binding, id: '00000000-0000-4000-8000-000000000002', dispatchId: '00000000-0000-4000-8000-000000000002', arguments: argumentsValue,
      argumentsHash, mutationKey: sha(canonical([scope.environmentGeneration, scope.appId, writer.resourceKey, writer.canonicalName, argumentsHash])) }
    const common = { sourceManifestHash: wire(manifest), scopeHash, ticketId: id('9'), dispatchId: action.dispatchId, toolId: writer.toolId,
      canonicalName: writer.canonicalName, toolKind: writer.toolKind, effect: writer.effect, rawArgumentsHash: wire(argumentsValue), effectiveArgumentsHash: wire(argumentsValue) }
    const clock = { now: 101, revision: 1 }
    const beforeClockEvidenceRef = store(`${root}/json/clock-${id('8')}.json`, { schemaVersion: 'gaia2-private-native-clock-receipt-v1', ...common,
      checkpoint: 'before_tool', clock, clockAuthority: 'ARE', revisionMeaning: 'owner_observation_sequence_not_are_revision', nativeReturnEvidenceRef: null })
    const decision = { action: 'read_back', reason: 'A fresh authoritative read is required.', resourceKey: writer.resourceKey }
    const beforeEvidence = store('C:/evidence/child-host/blocked-before.json', { schemaVersion: 'capybara-runtime-plugin-invocation-v1', sequence: 2,
      executionId: 'child', sessionId: 'child-session', input: { checkpoint: 'before_tool', clock, action: { id: action.id, name: writer.toolId,
        canonicalName: writer.canonicalName, effect: writer.effect, resourceKey: writer.resourceKey, mutationKey: action.mutationKey, arguments: argumentsValue, authoritativeRead: false } },
      decision, safetyFailure: null, hookReceipts: [{ hookId: 'gaia2-conflict-gate', status: 'passed', matched: true, decision }], trustedNativeCheckpoint: { schemaVersion: 'capybara-trusted-native-checkpoint-v1',
        scopeHash, checkpoint: 'before_tool', actionHash: wire(action), clockEvidenceRef: beforeClockEvidenceRef, hookOutcome: null } })
    const nativeDiscardEvidenceRef = store(`${root}/json/discard-${id('9')}.json`, { schemaVersion: 'gaia2-private-native-discard-v1', ...common,
      gateDecision: 'read_back', beforeClockEvidenceRef, beforeHookEvidenceRef: beforeEvidence, discarded: true, consumed: false, nativeStarted: false })
    const nativeRejectionEvidenceRef = registry('native_rejected', { scope, action, started: false, nativeReturned: false, resultHash: sha('native_outcome_unknown'),
      code: 'DELEGATION_BEFORE_BLOCKED', beforeEvidence, gateDecision: 'read_back', nativeDiscardEvidenceRef })
    blockedActions.push({ dispatchId: action.dispatchId, toolId: writer.toolId, toolKind: writer.toolKind, status: 'blocked', gateDecision: 'read_back', nativeRejectionEvidenceRef })
  }
  const actions = [], selectedTool = sourceReturn ? getter : final, value = sourceReturn ? { discountCodes: ['fixture'] } : 'done'
  let completion = null
  if (!failedGeneration && !nativeRefusal) {
    const common = { sourceManifestHash: wire(manifest), scopeHash, ticketId: id('e'), dispatchId: '00000000-0000-4000-8000-000000000001', toolId: selectedTool.toolId,
      canonicalName: selectedTool.canonicalName, toolKind: selectedTool.toolKind, effect: selectedTool.effect, rawArgumentsHash: wire({}), effectiveArgumentsHash: wire({}) }
    const dispatched = store(`${root}/json/dispatch-${id('f')}.json`, { schemaVersion: 'gaia2-private-native-dispatch-v1', ...common, status: 'pending', ownerClock: 102,
      ...(nativeAdmission ? { nativeAdmission: { schemaVersion: 'gaia2-native-admission-v1', unit: 'seconds', clockAuthority: 'ARE', checkedAt: 102, deadline: scopeDeadline, status: 'admitted' } } : {}) })
    const returned = { schemaVersion: `gaia2-private-native-return-v${sourceReturn ? 2 : 1}`, ...common, status: 'succeeded', returned: true, agentObservation: value,
      agentObservationHash: wire(value), nativeRawResultHash: wire(value), nativeCompletedEventRef: null, dispatchEvidenceRef: { ...dispatched, path: `json/dispatch-${id('f')}.json` }, errorCode: null,
      ...(sourceReturn ? { completionEvidenceKind: getter.completionEvidenceKind, sourcePinId: getter.sourcePinId, nativeRawProjection: value, ownerClock: 102 } : {}) }
    const returnRef = store(`${root}/json/return-${id('f')}.json`, returned)
    const beforeClock = store(`${root}/json/clock-${id('0')}.json`, { schemaVersion: 'gaia2-private-native-clock-receipt-v1', ...common, checkpoint: 'before_tool', clock: { now: 102, revision: 1 }, clockAuthority: 'ARE', revisionMeaning: 'owner_observation_sequence_not_are_revision', nativeReturnEvidenceRef: null })
    const afterClock = store(`${root}/json/clock-${id('1')}.json`, { schemaVersion: 'gaia2-private-native-clock-receipt-v1', ...common, checkpoint: 'after_tool', clock: { now: 103, revision: 2 }, clockAuthority: 'ARE', revisionMeaning: 'owner_observation_sequence_not_are_revision', nativeReturnEvidenceRef: { path: `json/return-${id('f')}.json`, sha256: returnRef.sha256 } })
    const { publicName: _name, signatureHash: _signature, formatterSourceHash: _formatter, ...binding } = selectedTool
    const action = { ...binding, id: common.dispatchId, dispatchId: common.dispatchId, arguments: {}, argumentsHash: sha('{}'), mutationKey: h('b') }
    const host = (checkpoint, clockRef) => store(`C:/evidence/child-host/${checkpoint}.json`, { schemaVersion: 'capybara-runtime-plugin-invocation-v1', executionId: 'child', sessionId: 'child-session',
      input: { checkpoint, action: { id: action.id, canonicalName: action.canonicalName, effect: action.effect, resourceKey: action.resourceKey, arguments: action.arguments },
        clock: { now: checkpoint === 'before_tool' ? 102 : 103, revision: checkpoint === 'before_tool' ? 1 : 2 },
        ...(checkpoint === 'after_tool' ? { outcome: { status: 'completed', executed: true, complete: true, resultHash: sha(JSON.stringify(value)) } } : {}) },
      decision: { action: 'allow' }, hookReceipts: [{ status: 'passed', matched: true }],
      trustedNativeCheckpoint: { schemaVersion: 'capybara-trusted-native-checkpoint-v1', scopeHash, checkpoint, actionHash: wire(action), clockEvidenceRef: clockRef,
        hookOutcome: checkpoint === 'before_tool' ? null : { status: 'succeeded', executed: true, complete: true, resultHash: sha(JSON.stringify(value)) } } })
    const beforeHost = host('before_tool', beforeClock), afterHost = host('after_tool', afterClock)
    const nativeReturnEvidence = registry('native_return', { scope, action, resultHash: sha(JSON.stringify(value)), value, nativeCompletedEventRef: null, ...(sourceReturn ? { sourcePinnedReturnEvidenceRef: returnRef } : {}) })
    registry('native_completed', { scope, action, beforeEvidence: beforeHost, nativeReturnEvidence, afterEvidence: afterHost })
    actions.push({ dispatchId: common.dispatchId, toolId: selectedTool.toolId, toolKind: selectedTool.toolKind, status: 'completed', childCompleted: !sourceReturn })
    if (!sourceReturn) completion = registry('completed', { scope, finalDispatchId: common.dispatchId })
  }
  if (nativeRefusal) {
    const tool = sourceReturn ? getter : writer, argumentsValue = { title: 'fixture' }, argumentsHash = sha(canonical(argumentsValue))
    const { publicName: _name, signatureHash: _signature, formatterSourceHash: _formatter, ...binding } = tool
    const action = { ...binding, id: '00000000-0000-4000-8000-000000000003', dispatchId: '00000000-0000-4000-8000-000000000003', arguments: argumentsValue,
      argumentsHash, mutationKey: sha(canonical([scope.environmentGeneration, scope.appId, tool.resourceKey, tool.canonicalName, argumentsHash])) }
    const common = { sourceManifestHash: wire(manifest), scopeHash, ticketId: id('3'), dispatchId: action.dispatchId,
      toolId: tool.toolId, canonicalName: tool.canonicalName, toolKind: tool.toolKind, effect: tool.effect,
      rawArgumentsHash: wire(argumentsValue), effectiveArgumentsHash: wire(argumentsValue) }
    const clock = { now: 102, revision: 1 }
    const clockRef = store(`${root}/json/clock-${id('3')}.json`, { schemaVersion: 'gaia2-private-native-clock-receipt-v1', ...common,
      checkpoint: 'before_tool', clock, clockAuthority: 'ARE', revisionMeaning: 'owner_observation_sequence_not_are_revision', nativeReturnEvidenceRef: null })
    const beforeEvidence = store('C:/evidence/child-host/refusal-before.json', { schemaVersion: 'capybara-runtime-plugin-invocation-v1', sequence: 2,
      executionId: 'child', sessionId: 'child-session', input: { checkpoint: 'before_tool', clock,
        action: { id: action.id, name: tool.toolId, canonicalName: tool.canonicalName, effect: tool.effect, resourceKey: tool.resourceKey,
          mutationKey: action.mutationKey, arguments: argumentsValue, authoritativeRead: tool.effect === 'read' } }, decision: { action: 'allow' }, safetyFailure: null,
      hookReceipts: [{ hookId: 'gaia2-a2a-guard', status: 'passed', matched: true, decision: { action: 'allow' } }], trustedNativeCheckpoint: {
        schemaVersion: 'capybara-trusted-native-checkpoint-v1', scopeHash, checkpoint: 'before_tool', actionHash: wire(action), clockEvidenceRef: clockRef, hookOutcome: null } })
    registry('native_started', { scope, action, beforeEvidence, mutationStatus: tool.effect === 'write' ? 'pending' : null })
    const proof = store(`${root}/json/admission-refusal-${id('3')}.json`, { schemaVersion: 'gaia2-private-native-admission-refusal-receipt-v1', ...common,
      status: 'rejected', errorCode: 'NATIVE_SCOPE_DEADLINE_EXPIRED', nativeBodyStarted: false, ticketRevoked: true, childTerminated: true,
      unit: 'seconds', clockAuthority: 'ARE', observedAt: scopeDeadline, deadline: scopeDeadline,
      beforeClockEvidenceRef: { path: `json/clock-${id('3')}.json`, sha256: clockRef.sha256 } })
    registry('native_rejected', { scope, action, started: true, nativeReturned: false, resultHash: sha('native_outcome_unknown'),
      code: 'DELEGATION_NATIVE_ADMISSION_REFUSED', reservationCharged: true, physicalNativeStarted: false,
      nativeAdmissionRefusalEvidenceRef: proof, beforeEvidence })
  }
  const failed = sourceReturn || failedGeneration || nativeRefusal
  const runner = { schemaVersion: 'gaia2-scoped-app-agent-v1', scopeHash, sourceManifestHash: wire(manifest), sourceRefs: sources,
    modelScopeHash: record.modelScopeHash, modelGateEnabled: true, notificationReaderAttached: true, notificationPumpAttached: true, deadlineOptIn: true,
    generationTimeOptIn: true, generationTimeOwnerFactoryBound: true, generationLedgerFactoryBound: true, generationTimingOffsetMode: 'successfulSdkElapsedSeconds',
    generationTimingSource: 'ScopedRetryModelEngine.monotonic_clock', modelCalls: 1, engineCalls: 1, sdkAttemptsUsed: 1, modelRequests: [record], actions, originalObservationsTaken: actions.length, ...(blockedBefore ? { blockedActions } : {}), completed: !failed, failed,
    failureCode: failed ? 'SCOPED_AGENT_NOTIFICATION_STOPPED' : null, completionEvidenceRef: completion }
  const guard = { schemaVersion: 'gaia2-official-a2a-guard-binding-v2', scopeHash, status: 'bound', admissible: true, notificationBound: true, deadlineBound: true,
    notificationPumpRequired: true, notificationPumpBound: true, generationTimeRequired: true, generationTimeBound: true }
  const client = { schemaVersion: 'gaia2-official-a2a-client-v1', executionId: 'exec', sessionId: 'session', scenarioId: 'scenario', appId,
    scopeHash: null, childActive: false, closed: false, modelRequests: 1, sdkAttempts: 1, notificationReaderFactoryBound: true, deadlineFactoryBound: true,
    notificationPumpRequired: true, generationTimeRequired: true, notificationPumpFactoryBound: true, generationTimeFactoryBound: true,
    childScopeHashes: [scopeHash], failed: false, failureCode: null, guard }
  if (deadlineClock) Object.assign(client, { deadlineClockContract: clockVersion, deadlineClockUnit: 'seconds' })
  const event = { type: 'a2a_child_runtime_snapshot', executionId: 'exec', sessionId: 'session', appId, scopeHash, childExecutionId: 'child', childSessionId: 'child-session', runnerSnapshot: runner, nativeManifest: manifest, evidenceRefs: refs }
  const pump = stage => ({ type: 'a2a_parent_notification_pumped', executionId: 'exec', sessionId: 'session', appId, scopeHash, childExecutionId: 'child', childSessionId: 'child-session', stage,
    clockNow: 104, parentRevisionBefore: 1, parentRevisionAfter: 1, publishedCount: 0, stopped: false, originRevoked: false })
  const broker = (type, fields = {}) => ({ type, schemaVersion: 'gaia2-scoped-model-event-v1', modelRole: 'child_actor', delegationScopeHash: scopeHash,
    appId, childExecutionId: 'child', childSessionId: 'child-session', parentExecutionId: 'exec', parentSessionId: 'session',
    requestId: record.requestId, permitId: record.permitId, actualInputHash: record.actualInputHash, modelScopeHash: record.modelScopeHash, ...fields })
  const events = [{ type: 'official_tool_inventory', tools: [{ canonicalName: 'AppAgent__expert_agent', appName: appId }] }, pump('pre_step'), pump('model_admission'), broker('model_logical_request_started'), pump('sdk_attempt_before'),
    broker('model_request_attempt', { requestAttempt: 1 }), pump('sdk_attempt_after'),
    ...(failedGeneration ? [broker('model_request_rejected', { failureCode: 'SCOPED_MODEL_SAFE_POINT_DENIED' })] : [broker('model_request_succeeded', { outputHash: record.outputHash })]),
    broker('model_logical_request_finished', { status: failedGeneration ? 'rejected' : 'succeeded', sdkAttempts: 1 }), pump('model_returned'), ...(blockedBefore ? [pump('native_before')] : []), ...(actions.length || nativeRefusal ? [pump('native_before')] : []), pump('child_close'), event,
    { type: 'a2a_client_pool_snapshot', schemaVersion: 'gaia2-official-a2a-client-pool-v1', executionId: 'exec', sessionId: 'session', status: 'committed', expectedAppIds: [appId], usedAppIds: [appId], clients: [client] },
    { type: 'a2a_client_snapshot', ...structuredClone(client) }]
  const identity = { phase: 'agent2agent', executionId: 'exec', scenarioId: 'scenario' }
  const rebind = () => {
    const replaceHash = (value, oldHash, newHash) => {
      if (Array.isArray(value)) for (let index = 0; index < value.length; index++) value[index] = value[index] === oldHash ? newHash : replaceHash(value[index], oldHash, newHash)
      else if (value && typeof value === 'object') for (const key of Object.keys(value)) value[key] = value[key] === oldHash ? newHash : replaceHash(value[key], oldHash, newHash)
      return value
    }
    for (let iteration = 0; iteration < refs.length + 3; iteration++) {
      let changed = false
      for (const ref of refs) {
        const actual = sha(buffers.get(ref.path))
        if (ref.sha256 === actual) continue
        const prior = ref.sha256; replaceHash(events, prior, actual); changed = true
        for (const [path, bytes] of buffers) {
          try {
            const value = JSON.parse(bytes), oldText = JSON.stringify(value)
            replaceHash(value, prior, actual)
            if (JSON.stringify(value) !== oldText) buffers.set(path, Buffer.from(`${JSON.stringify(value)}\n`))
          } catch { /* source bytes */ }
        }
      }
      if (!changed) return
    }
    throw new Error('fixture rebind failed to converge')
  }
  return { events, event, client, identity, buffers, refs, record, ledger, rebind, store, options: { readEvidence: path => { assert.ok(!/^[A-Za-z]:|^\//.test(path)); return buffers.get(path) },
    ...(deadlineClock ? { deadlineRequestTimeoutMs: 900000, environmentLock: {
      codeInputs: [{ path: 'scripts/gaia2_official_a2a.py', sha256: source.sha256, bytes: source.bytes }],
      officialCodeInputs: sources.filter(ref => ref.path.includes('/are/')).map(ref => ({ ...ref })) } } : {}) },
    replace: (schema, mutate) => { const ref = refs.find(ref => { try { return JSON.parse(buffers.get(ref.path)).schemaVersion === schema } catch { return false } }); assert.ok(ref); const value = JSON.parse(buffers.get(ref.path)); mutate(value); buffers.set(ref.path, Buffer.from(`${JSON.stringify(value)}\n`)); return ref } }
}

function mutateReceipt(value, predicate, mutate) {
  const ref = value.refs.find(ref => { try { return predicate(JSON.parse(value.buffers.get(ref.path))) } catch { return false } })
  assert.ok(ref, 'fixture receipt must exist')
  const receipt = JSON.parse(value.buffers.get(ref.path)); mutate(receipt)
  value.buffers.set(ref.path, Buffer.from(`${JSON.stringify(receipt)}\n`))
  return ref
}

function rebindManifest(value, mutate) {
  const prior = value.event.runnerSnapshot.sourceManifestHash
  mutate(value.event.nativeManifest)
  const next = wire(value.event.nativeManifest)
  const visit = item => {
    if (item === prior) return next
    if (Array.isArray(item)) return item.map(visit)
    if (item && typeof item === 'object') for (const key of Object.keys(item)) item[key] = visit(item[key])
    return item
  }
  visit(value.events)
  for (const [path, buffer] of value.buffers) {
    try { value.buffers.set(path, Buffer.from(`${JSON.stringify(visit(JSON.parse(buffer)))}\n`)) } catch { /* source bytes */ }
  }
  value.rebind()
}

test('clock-v2 requires a sealed native deadline contract and checks physical admission independently', () => {
  for (const sourceReturn of [false, true]) {
    const value = fixture({ nativeAdmission: true, sourceReturn })
    assert.deepEqual(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options), [])
    const proof = verifyOfficialA2ARuntimeEvidence({ events: value.events, identity: value.identity, ...value.options })
    assert.equal(proof.nativeAdmissionGuardedChildCount, 1)
    assert.equal(proof.nativeAdmissionRefusalCount, 0)
    assert.equal(proof.nativeReturnCount, 1)
    assert.equal(proof.consumedEvidencePaths.length, value.refs.length)
  }
  for (const deadlineClock of [false, true]) {
    const legacy = fixture({ deadlineClock })
    const proof = verifyOfficialA2ARuntimeEvidence({ events: legacy.events, identity: legacy.identity, ...legacy.options })
    assert.equal(proof.nativeAdmissionGuardedChildCount, 0)
    assert.equal(proof.nativeAdmissionRefusalCount, 0)
  }
})

test('owner expiry after allowed Hook charges the reservation but proves zero physical native body', () => {
  for (const sourceReturn of [false, true]) {
    const value = fixture({ nativeRefusal: true, sourceReturn })
    assert.deepEqual(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options), [])
    const proof = verifyOfficialA2ARuntimeEvidence({ events: value.events, identity: value.identity, ...value.options })
    assert.equal(proof.nativeAdmissionRefusalCount, 1)
    assert.equal(proof.nativeAdmissionGuardedChildCount, 1)
    assert.equal(proof.nativeReturnCount, 0)
    assert.equal(value.event.runnerSnapshot.failed, true)
    assert.equal(value.event.runnerSnapshot.completed, false)
    assert.equal(proof.consumedEvidencePaths.length, value.refs.length)
  }
})

for (const [name, mutate, expected] of [
  ['missing native manifest marker', value => rebindManifest(value, manifest => { delete manifest.nativeAdmissionDeadline }), 'a2a_native_admission_contract_missing'],
  ['manifest milliseconds downgrade', value => rebindManifest(value, manifest => { manifest.nativeAdmissionDeadline.unit = 'milliseconds' }), 'a2a_native_admission_contract_invalid'],
  ['manifest wrong authority', value => rebindManifest(value, manifest => { manifest.nativeAdmissionDeadline.clockAuthority = 'OS' }), 'a2a_native_admission_contract_invalid'],
  ['dispatch marker deleted', value => value.replace('gaia2-private-native-dispatch-v1', row => { delete row.nativeAdmission }), 'a2a_native_admission_invalid'],
  ['checked at deadline', value => value.replace('gaia2-private-native-dispatch-v1', row => { row.nativeAdmission.checkedAt = 1000; row.ownerClock = 1000 }), 'a2a_native_admission_invalid'],
  ['checked before issue', value => value.replace('gaia2-private-native-dispatch-v1', row => { row.nativeAdmission.checkedAt = 99; row.ownerClock = 99 }), 'a2a_native_admission_invalid'],
  ['checked before beforeclock', value => value.replace('gaia2-private-native-dispatch-v1', row => { row.nativeAdmission.checkedAt = 101; row.ownerClock = 101 }), 'a2a_native_admission_invalid'],
  ['owner clock differs', value => value.replace('gaia2-private-native-dispatch-v1', row => { row.ownerClock = 103 }), 'a2a_native_admission_invalid'],
  ['wrong deadline', value => value.replace('gaia2-private-native-dispatch-v1', row => { row.nativeAdmission.deadline = 1000000 }), 'a2a_native_admission_invalid'],
  ['wrong unit', value => value.replace('gaia2-private-native-dispatch-v1', row => { row.nativeAdmission.unit = 'milliseconds' }), 'a2a_native_admission_invalid'],
  ['wrong authority', value => value.replace('gaia2-private-native-dispatch-v1', row => { row.nativeAdmission.clockAuthority = 'SDK' }), 'a2a_native_admission_invalid'],
  ['wrong admitted status', value => value.replace('gaia2-private-native-dispatch-v1', row => { row.nativeAdmission.status = 'rejected' }), 'a2a_native_admission_invalid'],
  ['unknown admission permission', value => value.replace('gaia2-private-native-dispatch-v1', row => { row.nativeAdmission.permission = true }), 'a2a_native_admission_invalid'],
]) test(`source-bound native admission rejects ${name} after all SHA references rebind`, () => {
  const value = fixture({ nativeAdmission: true }); mutate(value); value.rebind()
  assert.deepEqual(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options), [expected])
})

const refusalSchema = 'gaia2-private-native-admission-refusal-receipt-v1'
const refusedDispatch = '00000000-0000-4000-8000-000000000003'
for (const [name, mutate, expected] of [
  ['not charged reservation', value => mutateReceipt(value, row => row.kind === 'native_rejected', row => { row.data.reservationCharged = false }), 'a2a_native_refusal_reservation_invalid'],
  ['physical body claimed', value => mutateReceipt(value, row => row.kind === 'native_rejected', row => { row.data.physicalNativeStarted = true }), 'a2a_native_refusal_reservation_invalid'],
  ['reservation not started', value => mutateReceipt(value, row => row.kind === 'native_rejected', row => { row.data.started = false }), 'a2a_native_refusal_reservation_invalid'],
  ['native returned', value => mutateReceipt(value, row => row.kind === 'native_rejected', row => { row.data.nativeReturned = true }), 'a2a_native_refusal_reservation_invalid'],
  ['invented native value', value => mutateReceipt(value, row => row.kind === 'native_rejected', row => { row.data.resultHash = h('0') }), 'a2a_native_refusal_reservation_invalid'],
  ['wrong registry action', value => mutateReceipt(value, row => row.kind === 'native_rejected', row => { row.data.action.arguments.title = 'changed' }), 'a2a_native_refusal_action_invalid'],
  ['Hook block mislabeled owner refusal', value => mutateReceipt(value, row => row.input?.checkpoint === 'before_tool', row => { row.decision.action = 'block' }), 'a2a_native_refusal_hook_invalid'],
  ['Hook source failure', value => mutateReceipt(value, row => row.input?.checkpoint === 'before_tool', row => { row.safetyFailure = 'HOOK_ERROR' }), 'a2a_native_refusal_hook_invalid'],
  ['wrong child Hook', value => mutateReceipt(value, row => row.input?.checkpoint === 'before_tool', row => { row.sessionId = 'foreign' }), 'a2a_native_refusal_hook_invalid'],
  ['wrong action clock join', value => mutateReceipt(value, row => row.input?.checkpoint === 'before_tool', row => { row.trustedNativeCheckpoint.actionHash = h('0') }), 'a2a_native_refusal_hook_invalid'],
  ['wrong clock scope', value => value.replace('gaia2-private-native-clock-receipt-v1', row => { row.scopeHash = h('0') }), 'a2a_native_refusal_clock_invalid'],
  ['clock at deadline', value => {
    value.replace('gaia2-private-native-clock-receipt-v1', row => { row.clock.now = 1000 })
    mutateReceipt(value, row => row.input?.checkpoint === 'before_tool', row => { row.input.clock.now = 1000 })
  }, 'a2a_authorization_after_deadline'],
  ['wrong proof identity', value => value.replace(refusalSchema, row => { row.ticketId = id('0') }), 'a2a_native_refusal_proof_invalid'],
  ['wrong dispatch identity', value => value.replace(refusalSchema, row => { row.dispatchId = '00000000-0000-4000-8000-000000000099' }), 'a2a_native_refusal_proof_invalid'],
  ['wrong scope identity', value => value.replace(refusalSchema, row => { row.scopeHash = h('0') }), 'a2a_native_refusal_proof_invalid'],
  ['wrong raw arguments', value => value.replace(refusalSchema, row => { row.rawArgumentsHash = h('0') }), 'a2a_native_refusal_proof_invalid'],
  ['wrong source manifest', value => value.replace(refusalSchema, row => { row.sourceManifestHash = h('0') }), 'a2a_native_refusal_proof_invalid'],
  ['wrong effective arguments', value => value.replace(refusalSchema, row => { row.effectiveArgumentsHash = h('0') }), 'a2a_native_refusal_proof_invalid'],
  ['wrong refusal status', value => value.replace(refusalSchema, row => { row.status = 'completed' }), 'a2a_native_refusal_proof_invalid'],
  ['ordinary native error mislabeled expiry', value => value.replace(refusalSchema, row => { row.errorCode = 'NATIVE_ACTION_FAILED' }), 'a2a_native_refusal_proof_invalid'],
  ['started body', value => value.replace(refusalSchema, row => { row.nativeBodyStarted = true }), 'a2a_native_refusal_proof_invalid'],
  ['ticket not revoked', value => value.replace(refusalSchema, row => { row.ticketRevoked = false }), 'a2a_native_refusal_proof_invalid'],
  ['child not terminated', value => value.replace(refusalSchema, row => { row.childTerminated = false }), 'a2a_native_refusal_proof_invalid'],
  ['wrong proof unit', value => value.replace(refusalSchema, row => { row.unit = 'milliseconds' }), 'a2a_native_refusal_proof_invalid'],
  ['wrong proof authority', value => value.replace(refusalSchema, row => { row.clockAuthority = 'OS' }), 'a2a_native_refusal_proof_invalid'],
  ['refused before expiry', value => value.replace(refusalSchema, row => { row.observedAt = 999 }), 'a2a_native_refusal_proof_invalid'],
  ['wrong proof deadline', value => value.replace(refusalSchema, row => { row.deadline = 1000000 }), 'a2a_native_refusal_proof_invalid'],
  ['unknown proof permission', value => value.replace(refusalSchema, row => { row.permission = true }), 'a2a_native_refusal_proof_invalid'],
  ['wrong beforeclock reference', value => value.replace(refusalSchema, row => { row.beforeClockEvidenceRef.path = 'json/foreign-clock.json' }), 'a2a_native_refusal_proof_invalid'],
  ['wrong beforeclock SHA', value => value.replace(refusalSchema, row => { row.beforeClockEvidenceRef.sha256 = h('0') }), 'a2a_native_refusal_proof_invalid'],
  ['unsafe absolute beforeclock', value => value.replace(refusalSchema, row => { row.beforeClockEvidenceRef.path = 'C:/evidence/native/json/clock.json' }), 'a2a_native_refusal_proof_invalid'],
  ['wrong intent action', value => mutateReceipt(value, row => row.kind === 'native_started', row => { row.data.action.arguments.title = 'changed' }), 'a2a_native_refusal_registry_join_invalid'],
  ['wrong intent Hook', value => mutateReceipt(value, row => row.kind === 'native_started', row => { row.data.beforeEvidence = { ...value.record.beforeEvidenceRef } }), 'a2a_native_refusal_registry_join_invalid'],
  ['after clock fabricated', value => value.store('C:/evidence/native/json/clock-fake.json', { schemaVersion: 'gaia2-private-native-clock-receipt-v1', scopeHash: value.event.scopeHash, dispatchId: refusedDispatch, checkpoint: 'after_tool' }), 'a2a_native_refusal_execution_claim'],
  ['CE fabricated', value => value.store('C:/evidence/native/json/ce-fake.json', { schemaVersion: 'gaia2-private-native-ce-v1', scopeHash: value.event.scopeHash, dispatchId: refusedDispatch }), 'a2a_native_refusal_execution_claim'],
  ['ordinary return fabricated', value => value.store('C:/evidence/native/json/return-fake.json', { schemaVersion: 'gaia2-private-native-return-v1', scopeHash: value.event.scopeHash, dispatchId: refusedDispatch }), 'a2a_native_refusal_execution_claim'],
  ['ordinary dispatch fabricated', value => value.store('C:/evidence/native/json/dispatch-fake.json', { schemaVersion: 'gaia2-private-native-dispatch-v1', scopeHash: value.event.scopeHash, dispatchId: refusedDispatch }), 'a2a_native_refusal_execution_claim'],
  ['after Hook fabricated', value => value.store('C:/evidence/child-host/refused-after.json', { schemaVersion: 'capybara-runtime-plugin-invocation-v1', executionId: 'child', sessionId: 'child-session', input: { checkpoint: 'after_tool', action: { id: refusedDispatch } } }), 'a2a_native_refusal_execution_claim'],
  ['unknown transport relabeled refusal', value => mutateReceipt(value, row => row.kind === 'native_rejected', row => { row.data.code = 'DELEGATION_NATIVE_FAILED' }), 'a2a_runtime_evidence_unconsumed'],
  ['Hook block relabeled refusal', value => mutateReceipt(value, row => row.kind === 'native_rejected', row => { row.data.code = 'DELEGATION_BEFORE_BLOCKED' }), 'a2a_native_blocked_inventory_invalid'],
  ['child fake completion', value => { value.event.runnerSnapshot.failed = false; value.event.runnerSnapshot.completed = true; value.event.runnerSnapshot.failureCode = null }, 'a2a_native_refusal_reservation_invalid'],
  ['failed child claims successful action', value => value.event.runnerSnapshot.actions.push({ dispatchId: refusedDispatch }), 'a2a_native_refusal_execution_claim'],
  ['Hook blocked history claims owner refusal', value => { value.event.runnerSnapshot.blockedActions = [{ dispatchId: refusedDispatch }] }, 'a2a_native_blocked_inventory_invalid'],
  ['native pump omitted', value => { value.events.splice(value.events.findIndex(event => event.stage === 'native_before'), 1) }, 'a2a_notification_native_pump_missing'],
]) test(`owner refusal semantic audit rejects ${name} after full SHA rebinding`, () => {
  const value = fixture({ nativeRefusal: true }); mutate(value); value.rebind()
  assert.deepEqual(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options), [expected])
})

for (const directory of ['json/nested', 'json/../json', 'foreign']) test(`owner refusal proof rejects sealed ${directory} directory aliases`, () => {
  const value = fixture({ nativeRefusal: true })
  const ref = value.refs.find(ref => ref.sourcePath.includes('/admission-refusal-'))
  const path = ref.sourcePath.replace('/json/', `/${directory}/`)
  ref.sourcePath = path
  mutateReceipt(value, row => row.kind === 'native_rejected', row => { row.data.nativeAdmissionRefusalEvidenceRef.path = path })
  value.rebind()
  assert.deepEqual(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options), ['a2a_native_refusal_reference_invalid'])
})

test('owner refusal proof cannot consume an unrelated orphan receipt', () => {
  const value = fixture({ nativeRefusal: true })
  const ref = value.refs.find(ref => ref.sourcePath.includes('/admission-refusal-'))
  const receipt = JSON.parse(value.buffers.get(ref.path))
  receipt.dispatchId = '00000000-0000-4000-8000-000000000099'; receipt.ticketId = id('9')
  value.store(`C:/evidence/native/json/admission-refusal-${id('9')}.json`, receipt)
  assert.deepEqual(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options), ['a2a_runtime_evidence_unconsumed'])
})

test('clock-v2 downgrade by deleting native markers fails even after every local SHA rebind', () => {
  const value = fixture({ nativeAdmission: true })
  rebindManifest(value, manifest => { delete manifest.nativeAdmissionDeadline })
  value.replace('gaia2-private-native-dispatch-v1', row => { delete row.nativeAdmission })
  for (const event of value.events) if (event.type === 'a2a_client_pool_snapshot') for (const client of event.clients) client.deadlineClockContract = 'gaia2-official-a2a-clock-v1'
  else if (event.type === 'a2a_client_snapshot') event.deadlineClockContract = 'gaia2-official-a2a-clock-v1'
  value.rebind()
  assert.deepEqual(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options), ['a2a_native_admission_contract_missing'])
})

test('clock-v2 source declaration removal is rejected by the external frozen source lock', () => {
  const value = fixture({ nativeAdmission: true }), source = value.refs.find(ref => ref.sourcePath.endsWith('/scripts/gaia2_official_a2a.py'))
  const bytes = Buffer.alloc(value.buffers.get(source.path).length, 32)
  Buffer.from('A2A_DEADLINE_CLOCK_CONTRACT = "gaia2-official-a2a-clock-v1"').copy(bytes)
  value.buffers.set(source.path, bytes)
  value.rebind()
  rebindManifest(value, () => {})
  assert.deepEqual(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options), ['a2a_frozen_source_mismatch'])
})

test('new frozen clock contract verifies ARE seconds while preserving a millisecond timeout policy', () => {
  const value = fixture({ deadlineClock: true })
  assert.deepEqual(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options), [])
  const verified = verifyOfficialA2ARuntimeEvidence({ events: value.events, identity: value.identity, ...value.options })
  assert.equal(verified.childCount, 1); assert.equal(verified.consumedEvidencePaths.length, value.refs.length)
})

test('a fully rebound scope deadline multiplied by 1000 fails semantics rather than merely a SHA check', () => {
  // Build every scope/wire identity/hash consistently around the wrong value.
  const value = fixture({ deadlineClock: true, scopeDeadline: 1000000 })
  value.rebind()
  assert.deepEqual(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options), ['a2a_deadline_clock_semantics_invalid'])
})

test('rebinding both timeout policy and a consistent deadline cannot change the trusted run timeout', () => {
  const value = fixture({ deadlineClock: true, scopeDeadline: 900100, clockTimeoutMs: 900000000 })
  value.rebind()
  assert.deepEqual(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options), ['a2a_deadline_clock_policy_mismatch'])
})

test('new frozen source cannot be downgraded by deleting all clock markers and rebinding every receipt SHA', () => {
  const value = fixture({ deadlineClock: true })
  for (const event of value.events) if (event.type === 'a2a_client_pool_snapshot') for (const client of event.clients) {
    delete client.deadlineClockContract; delete client.deadlineClockUnit
  } else if (event.type === 'a2a_client_snapshot') { delete event.deadlineClockContract; delete event.deadlineClockUnit }
  mutateReceipt(value, row => row.kind === 'initialized', row => { delete row.data.clockContract })
  mutateReceipt(value, row => row.kind === 'registered', row => { delete row.data.deadlineClock })
  value.rebind()
  assert.deepEqual(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options), ['a2a_deadline_clock_contract_missing'])
})

test('new frozen source cannot be downgraded into nonproduction by deleting the production flags', () => {
  const value = fixture({ deadlineClock: true })
  delete value.client.notificationPumpRequired; delete value.client.generationTimeRequired; value.client.guard = null
  value.rebind()
  assert.deepEqual(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options), ['a2a_production_pool_mixed_contract'])
})

test('new ARE source rejects a self-consistent milliseconds registration and missing trusted policy', () => {
  const milliseconds = fixture({ deadlineClock: true, clockUnit: 'milliseconds', scopeDeadline: 900100 })
  assert.deepEqual(officialA2ARuntimeEvidenceErrors(milliseconds.events, milliseconds.identity, milliseconds.options), ['a2a_deadline_clock_contract_missing'])
  const missingPolicy = fixture({ deadlineClock: true }); delete missingPolicy.options.deadlineRequestTimeoutMs
  assert.deepEqual(officialA2ARuntimeEvidenceErrors(missingPolicy.events, missingPolicy.identity, missingPolicy.options), ['a2a_deadline_clock_policy_mismatch'])
})

for (const [name, mutate] of [
  ['model admission at exact deadline', value => mutateReceipt(value, row => row.schemaVersion === 'capybara-runtime-plugin-invocation-v1' && row.input.checkpoint === 'before_model', row => { row.input.clock.now = 1000 })],
  ['native completion at exact deadline', value => mutateReceipt(value, row => row.schemaVersion === 'capybara-runtime-plugin-invocation-v1' && row.input.checkpoint === 'after_tool', row => { row.input.clock.now = 1000 })],
  ['SDK admission after exact deadline', value => { for (const event of value.events) if (event.type === 'a2a_parent_notification_pumped') event.clockNow = 1000 }],
]) test(`rebound clock evidence rejects ${name}`, () => {
  const value = fixture({ deadlineClock: true }); mutate(value); value.rebind()
  assert.deepEqual(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options), ['a2a_authorization_after_deadline'])
})

test('removing the new source declaration cannot bypass its frozen source hash', () => {
  const value = fixture({ deadlineClock: true }), source = value.refs.find(ref => ref.sourcePath.endsWith('/scripts/gaia2_official_a2a.py'))
  const bytes = Buffer.alloc(value.buffers.get(source.path).length, 32)
  Buffer.from('legacy source without declaration').copy(bytes)
  const oldManifestHash = value.event.runnerSnapshot.sourceManifestHash
  value.buffers.set(source.path, bytes); value.rebind()
  const newManifestHash = wire(value.event.nativeManifest)
  const replace = item => {
    if (item === oldManifestHash) return newManifestHash
    if (Array.isArray(item)) return item.map(replace)
    if (item && typeof item === 'object') for (const key of Object.keys(item)) item[key] = replace(item[key])
    return item
  }
  replace(value.events)
  for (const [path, buffer] of value.buffers) {
    try { value.buffers.set(path, Buffer.from(`${JSON.stringify(replace(JSON.parse(buffer)))}\n`)) } catch { /* source is not JSON */ }
  }
  value.rebind()
  assert.deepEqual(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options), ['a2a_frozen_source_mismatch'])
})

test('a sealed read_back denial discards only its untouched ticket and remains separate from later successful completion', () => {
  const value = fixture({ blockedBefore: true })
  const verified = verifyOfficialA2ARuntimeEvidence({ events: value.events, identity: value.identity, ...value.options })
  assert.equal(verified.nativeReturnCount, 1)
  assert.equal(verified.consumedEvidencePaths.length, value.refs.length)
  assert.equal(value.event.runnerSnapshot.blockedActions.length, 1)
  assert.equal(value.event.runnerSnapshot.actions.length, 1)
  assert.notEqual(value.event.runnerSnapshot.actions[0].dispatchId, value.event.runnerSnapshot.blockedActions[0].dispatchId)
  assert.equal(value.event.runnerSnapshot.completed, true)
})

test('blocked action hashes use exact registry canonical bytes for numeric keys, Unicode and small doubles', () => {
  const value = fixture({ blockedBefore: true, blockedArguments: { '2': 'later', '10': 'lexically first', nested: { '\u{1F9AB}': '中文\n', '\ue000': '\t', amount: 0.0000001, negative: -0, items: [1.5, 0.000001] } } })
  const verified = verifyOfficialA2ARuntimeEvidence({ events: value.events, identity: value.identity, ...value.options })
  assert.equal(verified.consumedEvidencePaths.length, value.refs.length)
})

const blockedDispatch = '00000000-0000-4000-8000-000000000002'
for (const [name, mutate, expected] of [
  ['missing sealed Hook reference', value => mutateReceipt(value, row => row.kind === 'native_rejected', row => { delete row.data.beforeEvidence }), 'a2a_native_blocked_receipt_invalid'],
  ['started native execution', value => mutateReceipt(value, row => row.kind === 'native_rejected', row => { row.data.started = true }), 'a2a_native_blocked_receipt_invalid'],
  ['native already returned', value => mutateReceipt(value, row => row.kind === 'native_rejected', row => { row.data.nativeReturned = true }), 'a2a_native_blocked_receipt_invalid'],
  ['invented result hash', value => mutateReceipt(value, row => row.kind === 'native_rejected', row => { row.data.resultHash = h('0') }), 'a2a_native_blocked_receipt_invalid'],
  ['allow cannot masquerade as normal rejection', value => mutateReceipt(value, row => row.kind === 'native_rejected', row => { row.data.gateDecision = 'allow' }), 'a2a_native_blocked_receipt_invalid'],
  ['discard proof is mandatory', value => mutateReceipt(value, row => row.kind === 'native_rejected', row => { delete row.data.nativeDiscardEvidenceRef }), 'a2a_native_blocked_receipt_invalid'],
  ['foreign child Hook', value => mutateReceipt(value, row => row.input?.action?.id === blockedDispatch, row => { row.sessionId = 'foreign' }), 'a2a_native_blocked_hook_invalid'],
  ['Hook actually allowed execution', value => mutateReceipt(value, row => row.input?.action?.id === blockedDispatch, row => { row.decision.action = 'allow' }), 'a2a_native_blocked_hook_invalid'],
  ['no matched nonallow safety cause', value => mutateReceipt(value, row => row.input?.action?.id === blockedDispatch, row => { row.hookReceipts[0].matched = false }), 'a2a_native_blocked_hook_invalid'],
  ['Hook error is not normal gate feedback', value => mutateReceipt(value, row => row.input?.action?.id === blockedDispatch, row => { row.safetyFailure = 'HOOK_ERROR' }), 'a2a_native_blocked_hook_invalid'],
  ['missing safety failure state', value => mutateReceipt(value, row => row.input?.action?.id === blockedDispatch, row => { delete row.safetyFailure }), 'a2a_native_blocked_hook_invalid'],
  ['ordinary Hook cannot issue safe native denial', value => mutateReceipt(value, row => row.input?.action?.id === blockedDispatch, row => { row.hookReceipts[0].hookId = 'not-a-safety-hook' }), 'a2a_native_blocked_hook_invalid'],
  ['Actor-selected read authority', value => mutateReceipt(value, row => row.input?.action?.id === blockedDispatch, row => { row.input.action.authoritativeRead = true }), 'a2a_native_blocked_hook_invalid'],
  ['wrong ARE clock scope', value => value.replace('gaia2-private-native-clock-receipt-v1', row => { row.scopeHash = h('0') }), 'a2a_native_blocked_clock_invalid'],
  ['wrong effective arguments', value => value.replace('gaia2-private-native-clock-receipt-v1', row => { row.effectiveArgumentsHash = h('0') }), 'a2a_native_blocked_clock_invalid'],
  ['unknown clock authority field', value => value.replace('gaia2-private-native-clock-receipt-v1', row => { row.permission = true }), 'a2a_native_blocked_clock_invalid'],
  ['ticket had been consumed', value => value.replace('gaia2-private-native-discard-v1', row => { row.consumed = true }), 'a2a_native_blocked_discard_invalid'],
  ['discard says native started', value => value.replace('gaia2-private-native-discard-v1', row => { row.nativeStarted = true }), 'a2a_native_blocked_discard_invalid'],
  ['ticket not actually discarded', value => value.replace('gaia2-private-native-discard-v1', row => { row.discarded = false }), 'a2a_native_blocked_discard_invalid'],
  ['discard bound to another ticket', value => value.replace('gaia2-private-native-discard-v1', row => { row.ticketId = id('0') }), 'a2a_native_blocked_discard_invalid'],
  ['discard wrong gate decision', value => value.replace('gaia2-private-native-discard-v1', row => { row.gateDecision = 'block' }), 'a2a_native_blocked_discard_invalid'],
  ['discard references another Hook', value => value.replace('gaia2-private-native-discard-v1', row => { row.beforeHookEvidenceRef.path = 'C:/evidence/other.json' }), 'a2a_native_blocked_discard_invalid'],
  ['discard references another before clock', value => value.replace('gaia2-private-native-discard-v1', row => { row.beforeClockEvidenceRef.path = 'C:/evidence/other-clock.json' }), 'a2a_native_blocked_discard_invalid'],
  ['unknown discard authority field', value => value.replace('gaia2-private-native-discard-v1', row => { row.permission = true }), 'a2a_native_blocked_discard_invalid'],
  ['missing blockedActions history', value => { value.event.runnerSnapshot.blockedActions = [] }, 'a2a_native_blocked_inventory_invalid'],
  ['duplicate blockedActions', value => { value.event.runnerSnapshot.blockedActions.push(structuredClone(value.event.runnerSnapshot.blockedActions[0])) }, 'a2a_native_blocked_inventory_invalid'],
  ['blocked history claims completion', value => { value.event.runnerSnapshot.blockedActions[0].status = 'completed' }, 'a2a_native_blocked_snapshot_invalid'],
  ['fake native return for denied dispatch', value => value.replace('gaia2-private-native-return-v1', row => { row.dispatchId = blockedDispatch }), 'a2a_native_blocked_execution_claim'],
  ['fake after_tool for denied dispatch', value => mutateReceipt(value, row => row.input?.checkpoint === 'after_tool', row => { row.input.action.id = blockedDispatch }), 'a2a_native_blocked_execution_claim'],
  ['fake completed event for denied dispatch', value => { value.store('C:/evidence/native/json/ce-denied.json', { schemaVersion: 'gaia2-private-native-ce-v1', scopeHash: value.event.scopeHash, dispatchId: blockedDispatch }) }, 'a2a_native_blocked_execution_claim'],
  ['duplicate denied before clock', value => {
    const ref = value.refs.find(ref => ref.sourcePath.endsWith(`clock-${id('8')}.json`))
    value.store('C:/evidence/native/json/clock-duplicate.json', JSON.parse(value.buffers.get(ref.path)))
  }, 'a2a_native_blocked_execution_claim'],
  ['successful action must not erase denial', value => { value.event.runnerSnapshot.actions[0].dispatchId = blockedDispatch }, 'a2a_native_blocked_execution_claim'],
  ['native notification pump missing for denial', value => { value.events.splice(value.events.findIndex(event => event.stage === 'native_before'), 1) }, 'a2a_notification_native_pump_missing'],
]) test(`blocked-before-native semantic audit rejects ${name} after SHA chains are rebound`, () => {
  const value = fixture({ blockedBefore: true }); mutate(value); value.rebind()
  assert.deepEqual(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options), [expected])
})

test('an unrelated orphan clock is still rejected beside a fully proven blocked ticket', () => {
  const value = fixture({ blockedBefore: true })
  const ref = value.refs.find(ref => ref.sourcePath.endsWith(`clock-${id('8')}.json`)), clock = JSON.parse(value.buffers.get(ref.path))
  Object.assign(clock, { dispatchId: '00000000-0000-4000-8000-000000000099', ticketId: id('7') })
  value.store('C:/evidence/native/json/clock-orphan.json', clock)
  assert.deepEqual(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options), ['a2a_runtime_evidence_unconsumed'])
})

test('same-child identity cannot consume an unbound successful after_tool write receipt', () => {
  const value = fixture()
  value.store('C:/evidence/child-host/unbound-after.json', { schemaVersion: 'capybara-runtime-plugin-invocation-v1', executionId: 'child', sessionId: 'child-session',
    input: { checkpoint: 'after_tool', action: { id: 'unbound-write', canonicalName: 'Calendar__create_event', effect: 'write' },
      outcome: { status: 'completed', executed: true, complete: true, resultHash: h('0') } }, decision: { action: 'allow' }, hookReceipts: [{ status: 'passed', matched: true }] })
  value.rebind()
  assert.deepEqual(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options), ['a2a_runtime_evidence_unconsumed'])
})

test('same-child initialization requires an exact trusted running registry reference', () => {
  const value = fixture()
  value.store('C:/evidence/child-host/unbound-init.json', { schemaVersion: 'capybara-runtime-plugin-host-v1', executionId: 'child', sessionId: 'child-session',
    plugins: [{ id: 'forged' }], harnesses: [], runtimeHooks: [], trainingHooks: [], variablesHash: h('0') })
  value.rebind()
  assert.deepEqual(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options), ['a2a_child_host_initialization_unbound'])
})

for (const count of [0, 999, -1, 1.5, null]) test(`completed child observation count ${count} must exactly match its successful actions including final`, () => {
  const value = fixture(); value.event.runnerSnapshot.originalObservationsTaken = count; value.rebind()
  assert.deepEqual(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options), ['a2a_native_observation_counter_invalid'])
})

test('failed child cannot claim more observations than actual successful native returns', () => {
  const value = fixture({ sourceReturn: true }); value.event.runnerSnapshot.originalObservationsTaken = 999; value.rebind()
  assert.deepEqual(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options), ['a2a_native_observation_counter_invalid'])
})

test('production A2A audit reads every copied source, generation ledger, native return and real pump', () => {
  const value = fixture()
  assert.deepEqual(officialA2ATraceErrors(value.events, value.identity, value.options), [])
  const result = verifyOfficialA2ARuntimeEvidence({ events: value.events, identity: value.identity, ...value.options })
  assert.equal(result.childCount, 1); assert.equal(result.modelRequestCount, 1); assert.equal(result.nativeReturnCount, 1)
  assert.equal(result.consumedEvidencePaths.length, value.refs.length)
  assert.ok(officialA2ATraceErrors(value.events, value.identity).includes('a2a_runtime_evidence_missing'))
})

test('production A2A audit cannot be replaced by bound booleans or just a successful child subset', () => {
  for (const mutate of [
    value => { value.events = value.events.filter(event => event.type !== 'a2a_child_runtime_snapshot') },
    value => { value.client.childScopeHashes.push(h('b')) },
    value => { value.events.push(structuredClone(value.event)) },
    value => { value.event.appId = 'foreign' },
    value => { value.event.runnerSnapshot.notificationPumpAttached = false },
    value => { value.events = value.events.filter(event => event.type !== 'a2a_parent_notification_pumped') },
    value => { value.events = value.events.filter(event => event.stage !== 'child_close') },
    value => { value.client.guard.schemaVersion = 'gaia2-official-a2a-guard-binding-v1' },
    value => { value.client.failed = true },
    value => { value.client.generationTimeFactoryBound = false },
  ]) {
    const value = fixture(); mutate(value)
    assert.ok(officialA2ATraceErrors(value.events, value.identity, value.options).length > 0)
  }
})

test('production A2A generation offsets exclude failed SDK attempts and cooldown and reject a stranded lease', () => {
  for (const mutate of [
    value => { value.record.generationOffset = 12 },
    value => { value.record.generationOwnerReleased.released = false },
    value => { value.record.generationOwnerReleased.offset = 8 },
    value => { value.record.generationOwnerAcquired.lease.requestId = id('b') },
    value => { value.record.generationOwnerSourceRefs = [] },
    value => { value.ledger.evidenceRefs.reverse() },
    value => { value.ledger.previousHash = h('0') },
    value => { value.ledger.phase = 'released' },
    value => { value.replace('gaia2-generation-time-ledger-v1', item => { item.requestId = id('b') }) },
  ]) {
    const value = fixture(); mutate(value)
    assert.ok(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options).length > 0)
  }
})

test('production failed child is retained only with its independently verified failed chain and zero-credit cleanup', () => {
  const value = fixture({ failedGeneration: true })
  assert.deepEqual(officialA2ATraceErrors(value.events, value.identity, value.options), [])
  value.record.generationOwnerReleased.offset = 4
  assert.ok(officialA2ATraceErrors(value.events, value.identity, value.options).length > 0)
})

test('production source-pinned Shopping return has no forged completed event and requires original file bytes', () => {
  const value = fixture({ sourceReturn: true })
  assert.deepEqual(officialA2ATraceErrors(value.events, value.identity, value.options), [])
  const ref = value.refs.find(ref => ref.sourcePath.endsWith('/are/simulation/apps/shopping.py'))
  value.buffers.set(ref.path, Buffer.from('same labeled source, different bytes'))
  assert.ok(officialA2ATraceErrors(value.events, value.identity, value.options).length > 0)
  for (const mutate of [
    item => { item.event.nativeManifest.tools[0].effect = 'write' },
    item => { item.event.nativeManifest.appType = 'unreviewed.ShoppingSubclass' },
    item => { item.event.nativeManifest.tools[0].sourcePinId = 'unreviewed' },
    item => { item.replace('gaia2-private-native-return-v2', returned => { returned.nativeCompletedEventRef = { path: 'json/fake.json', sha256: h('0') } }) },
    item => { item.replace('gaia2-private-native-return-v2', returned => { returned.ownerClock = 104 }) },
    item => { item.replace('gaia2-private-native-return-v2', returned => { returned.nativeRawProjection = { forged: true } }) },
  ]) {
    const item = fixture({ sourceReturn: true }); mutate(item)
    assert.ok(officialA2ATraceErrors(item.events, item.identity, item.options).length > 0)
  }
})

test('production notification STOP revokes admission and forbids a later SDK retry', () => {
  const value = fixture({ failedGeneration: true })
  const pump = value.events.find(event => event.stage === 'sdk_attempt_before')
  Object.assign(pump, { stopped: true, originRevoked: true })
  for (const event of value.events.filter(event => event.type === 'a2a_parent_notification_pumped')) if (value.events.indexOf(event) > value.events.indexOf(pump)) Object.assign(event, { stopped: true, originRevoked: true })
  assert.ok(officialA2ATraceErrors(value.events, value.identity, value.options).includes('a2a_sdk_attempt_after_stop'))
})

test('production copied evidence paths are sealed relative identities and extra files are not silently consumed', () => {
  for (const mutate of [
    value => { value.refs[0].path = 'C:/outside.py' },
    value => { value.refs[0].path = '../outside.py' },
    value => { value.refs[0].sourcePath = 'relative.py' },
    value => { value.refs.push(structuredClone(value.refs[0])) },
    value => { value.refs.push({ path: 'runs/extra.bin', sha256: sha('extra'), sourcePath: 'C:/extra.bin' }); value.buffers.set('runs/extra.bin', Buffer.from('extra')) },
  ]) {
    const value = fixture(); mutate(value)
    assert.ok(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options).length > 0)
  }
})

test('production source-return semantics still reject forged CE, raw value or clock after all file hashes are rebound', () => {
  for (const [mutate, expected] of [
    [value => { value.replace('gaia2-private-native-return-v2', returned => { returned.nativeCompletedEventRef = { path: 'json/forged.json', sha256: h('0') } }) }, 'a2a_native_source_return_invalid'],
    [value => { value.replace('gaia2-private-native-return-v2', returned => { returned.ownerClock = 104 }) }, 'a2a_native_source_return_invalid'],
    [value => { value.replace('gaia2-private-native-return-v2', returned => { returned.nativeRawProjection = { forged: ['result'] } }) }, 'a2a_native_source_return_invalid'],
  ]) {
    const value = fixture({ sourceReturn: true }); mutate(value); value.rebind()
    assert.deepEqual(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options), [expected])
  }
})

test('generation ledger rejects cooldown credit after rebuilding the complete hash chain', () => {
  const value = fixture()
  const ref = value.refs.find(ref => ref.sourcePath.endsWith('000004-generation-time.json'))
  const event = JSON.parse(value.buffers.get(ref.path)); event.offset = 12
  value.buffers.set(ref.path, Buffer.from(`${JSON.stringify(event)}\n`)); value.rebind()
  assert.deepEqual(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options), ['a2a_generation_offset_includes_retry_or_cooldown'])
})

test('production malformed duplicate keys cannot hide behind a rebound ledger SHA', () => {
  const value = fixture(), ref = value.refs.find(ref => ref.sourcePath.endsWith('000001-generation-time.json'))
  const raw = value.buffers.get(ref.path).toString()
  value.buffers.set(ref.path, Buffer.from(raw.replace('"kind":"admission"', '"kind":"forged","kind":"admission"')))
  ref.sha256 = sha(value.buffers.get(ref.path)); value.ledger.evidenceRefs[0].sha256 = ref.sha256
  assert.deepEqual(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options), ['a2a_evidence_json_invalid'])
})

test('production real SDK attempt events must agree with Node acknowledgements and immutable output identity', () => {
  for (const mutate of [
    value => { value.events = value.events.filter(event => event.type !== 'model_request_attempt') },
    value => { value.events.find(event => event.type === 'model_request_attempt').requestAttempt = 2 },
    value => { value.events.find(event => event.type === 'model_request_attempt').childExecutionId = 'foreign' },
    value => { value.events.find(event => event.type === 'model_request_succeeded').outputHash = h('9') },
    value => { value.events.push(structuredClone(value.events.find(event => event.type === 'model_logical_request_started'))) },
  ]) {
    const value = fixture(); mutate(value)
    assert.ok(officialA2ARuntimeEvidenceErrors(value.events, value.identity, value.options).length > 0)
  }
})
