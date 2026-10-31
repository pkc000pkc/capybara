import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer, type Socket } from 'node:net'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRetrievalReceipt } from '../src/retrieval_receipt.mjs'
import { createTemporalReceipt } from '../src/temporal_receipt.mjs'
import { createConflictReceipt } from '../src/conflict_receipt.mjs'
import { createSemanticReceipt, validateMutationInvocation } from '../src/semantic_receipt.mjs'
import { createToolRoundService } from '../src/tool_round_service.mjs'

// The public Hook endpoint remains parent-session HTTP. Official A2A uses a
// separate loopback byte pipe whose channel/binding hashes are per-session;
// Actor JSON and ordinary Hook RPC can never reach its handlers.
const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--spec') throw new Error('hook host spec required')
const spec = JSON.parse(readFileSync(resolve(args[1]), 'utf8'))
if (Object.hasOwn(spec, 'taskContract')) throw new Error('task contract capability is retired')
const token = process.env.GAIA2_HOOK_TOKEN
if (!token || token.length < 32) throw new Error('session capability missing')
const expectedAuth = createHash('sha256').update(`Bearer ${token}`).digest()
const backend = spec.backendRoot
const { RuntimePluginHost } = await import(pathToFileURL(join(backend, 'src/core/plugins/runtime-plugin-host.ts')).href)
const { ToolRoundScheduler } = await import(pathToFileURL(join(backend, 'src/core/tools/tool-round-scheduler.ts')).href)
const { RuntimeDelegationPipePeer } = await import(pathToFileURL(join(backend, 'src/core/plugins/runtime-delegation-pipe.ts')).href)
const { RuntimeDelegationNativePipeBinding } = await import(pathToFileURL(join(backend, 'src/core/plugins/runtime-delegation-native-pipe.ts')).href)
const { RuntimeDelegationMultiAppHostAdapter } = await import(pathToFileURL(join(backend, 'src/core/plugins/runtime-delegation-host-adapter.ts')).href)
const entry = spec.entry
if (entry !== undefined) {
  if (!entry || entry.schemaVersion !== 'gaia2-official-entry-handshake-v1' || typeof entry.path !== 'string' || !entry.path
    || typeof entry.relativePath !== 'string' || !entry.relativePath || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)
    || !entry.value || entry.value.schemaVersion !== entry.schemaVersion || entry.value.executionId !== spec.options.executionId
    || entry.value.sessionId !== spec.options.sessionId || entry.value.scenarioId !== spec.options.scenarioId) throw new Error('official entry handshake invalid')
  const entryPath = resolve(entry.path)
  if (!existsSync(entryPath) || lstatSync(entryPath).isSymbolicLink()) throw new Error('official entry handshake missing')
  const entryBytes = readFileSync(entryPath)
  if (createHash('sha256').update(entryBytes).digest('hex') !== entry.sha256) throw new Error('official entry handshake changed')
  let parsed
  try { parsed = JSON.parse(entryBytes.toString('utf8')) } catch { throw new Error('official entry handshake malformed') }
  if (JSON.stringify(parsed) + '\n' !== entryBytes.toString('utf8') || JSON.stringify(parsed) !== JSON.stringify(entry.value)) throw new Error('official entry handshake noncanonical')
}
const host = new RuntimePluginHost(spec.options)
const initialization = await host.initialize()
const toolRounds = createToolRoundService({ Scheduler: ToolRoundScheduler, workspaceDir: spec.options.workspaceDir,
  executionId: spec.options.executionId, sessionId: spec.options.sessionId })
const retrievalEnabled = spec.retrieval?.enabled === true
if (spec.retrieval !== undefined && (!spec.retrieval || Object.keys(spec.retrieval).some(key => key !== 'enabled')
  || typeof spec.retrieval.enabled !== 'boolean')) throw new Error('retrieval diagnostic spec invalid')
if (retrievalEnabled && !initialization.plugins.some((plugin: any) => plugin.id === 'gaia2-retrieval')) throw new Error('retrieval plugin missing')
const temporalEnabled = spec.temporal?.enabled === true
if (spec.temporal !== undefined && (!spec.temporal || Object.keys(spec.temporal).some(key => key !== 'enabled')
  || typeof spec.temporal.enabled !== 'boolean')) throw new Error('temporal diagnostic spec invalid')
if (temporalEnabled && (spec.options.a2a?.enabled || !initialization.plugins.some((plugin: any) => plugin.id === 'gaia2-runtime'))) throw new Error('temporal requires a standard runtime plugin')
const conflictRecoveryEnabled = spec.conflictRecovery?.enabled === true
if (spec.conflictRecovery !== undefined && (!spec.conflictRecovery || Object.keys(spec.conflictRecovery).some(key => key !== 'enabled')
  || typeof spec.conflictRecovery.enabled !== 'boolean')) throw new Error('conflict recovery diagnostic spec invalid')
if (conflictRecoveryEnabled && (spec.options.a2a?.enabled || !initialization.plugins.some((plugin: any) => plugin.id === 'gaia2-runtime'))) throw new Error('conflict recovery requires a standard runtime plugin')
for (const name of ['entitySemantics', 'mutationReceipts']) {
  const capability = spec[name]
  if (capability !== undefined && (!capability || Object.keys(capability).some(key => key !== 'enabled') || typeof capability.enabled !== 'boolean')) throw new Error('semantic capability spec invalid')
  if (capability?.enabled === true && (spec.options.a2a?.enabled || !initialization.plugins.some((plugin: any) => plugin.id === 'gaia2-runtime'))) throw new Error('semantics require a standard runtime plugin')
}
const entitySemanticsEnabled = spec.entitySemantics?.enabled === true
const mutationReceiptsEnabled = spec.mutationReceipts?.enabled === true
let closing = false
const a2a: any = { entries: new Map(), connections: new Set(), expectedAppIds: null, adapter: null, committed: false,
  committing: false, ownerClosing: false, ownerClosed: false, ownerClosePromise: null, poisoned: false,
  childStarting: false, activeHandle: null, nativeInFlight: false, handles: new Map(), parentResponses: new Map(), areNow: 0 }
const plain = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && !Array.isArray(value)
const exact = (value: unknown, keys: string[]) => { if (!plain(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error('A2A_PRIVATE_PAYLOAD') }
const childRoot = (scope: any) => {
  if (!plain(scope) || typeof scope.childSessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(scope.childSessionId)) throw new Error('A2A_CHILD_SCOPE')
  const parent = resolve(spec.options.workspaceDir, 'plugin-runtime-children'), root = resolve(parent, scope.childSessionId)
  if (!(root === parent || root.startsWith(`${parent}/`) || root.startsWith(`${parent}\\`))) throw new Error('A2A_CHILD_PATH')
  // RuntimePluginHost validates that its workspace already exists and is a
  // regular, non-symlinked directory.  The child scope is generated by the
  // trusted registry, so create exactly that fresh directory here before the
  // child Host constructor runs; never create arbitrary Actor-selected paths.
  mkdirSync(parent, { recursive: true }); mkdirSync(root, { recursive: false }); return root
}
const appIdsFor = (value: unknown): string[] => {
  if (!Array.isArray(value) || !value.length || value.length > 64 || value.some(id => typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(id))
    || new Set(value).size !== value.length) throw new Error('A2A_APP_SET')
  return [...value].sort()
}
const assertA2AOpen = () => { if (closing || a2a.ownerClosing || a2a.ownerClosed || a2a.poisoned) throw new Error('A2A_OWNER_CLOSED') }
const acceptAREClock = (now: number) => {
  assertA2AOpen()
  if (!Number.isFinite(now) || now < 0 || now < a2a.areNow) throw new Error('A2A_CLOCK')
  a2a.areNow = now
}
const poisonA2A = () => {
  if (closing || a2a.ownerClosed || a2a.poisoned) return
  a2a.poisoned = true
  try { a2a.adapter?.transportRevoker()() } catch { /* initialization may not yet have installed the registry */ }
  for (const record of a2a.connections) {
    record.rejectReady?.(new Error('A2A_OWNER_POISONED'))
    try { record.peer?.close() } catch {}
    try { record.socket.destroy() } catch {}
  }
}
const handleFor = (record: any, value: unknown) => {
  assertA2AOpen()
  const item = typeof value === 'string' ? a2a.handles.get(value) : null
  if (!a2a.committed || !item || item.entry !== record || item.scope.appId !== record.appId) throw new Error('A2A_CHILD_HANDLE')
  return item
}
async function commitA2A(appIds: string[]): Promise<void> {
  assertA2AOpen()
  if (a2a.committed || a2a.committing || JSON.stringify(appIds) !== JSON.stringify(a2a.expectedAppIds)
    || a2a.entries.size !== appIds.length || appIds.some(id => !a2a.entries.get(id)?.binding)) throw new Error('A2A_APP_SET_NOT_PREPARED')
  a2a.committing = true
  try {
    const adapter = RuntimeDelegationMultiAppHostAdapter.install({ host, bindings: appIds.map(id => a2a.entries.get(id).binding),
      environmentGeneration: `official-${spec.options.executionId}`, now: () => a2a.areNow,
      deadlineClockUnit: 'seconds', onNativeClock: acceptAREClock,
      requestTimeoutMs: spec.options.a2a.requestTimeoutMs, maxNativeActions: spec.options.a2a.maxNativeActions,
      useNativeClock: true, createChildHost: async (scope: any) => new RuntimePluginHost({ ...spec.options,
        executionId: scope.childExecutionId, sessionId: scope.childSessionId, workspaceDir: childRoot(scope) }) })
    for (const appId of appIds) a2a.entries.get(appId).facade = adapter.facade(appId)
    a2a.adapter = adapter; a2a.committed = true
  } catch { poisonA2A(); throw new Error('A2A_OWNER_COMMIT_FAILED') }
  finally { a2a.committing = false }
}
const handlersFor = (record: any) => new Map<string, (payload: any) => any>([
  ['a2a_sync_clock', payload => { assertA2AOpen(); exact(payload, ['now']); if (!record.binding || typeof payload.now !== 'number') throw new Error('A2A_CLOCK'); acceptAREClock(payload.now); return { now: a2a.areNow } }],
  ['a2a_connect_ready', async payload => {
    assertA2AOpen()
    const legacy = payload === null
    if (!legacy) exact(payload, ['appIds'])
    await record.prepared
    assertA2AOpen()
    const appIds = legacy ? [record.appId] : appIdsFor(payload.appIds)
    if (!appIds.includes(record.appId) || (a2a.expectedAppIds && JSON.stringify(appIds) !== JSON.stringify(a2a.expectedAppIds))) throw new Error('A2A_APP_SET')
    a2a.expectedAppIds ??= appIds
    if (legacy) { await commitA2A(appIds); return { appId: record.appId } }
    return { appId: record.appId, status: 'prepared' }
  }],
  ['a2a_commit_apps', async payload => { exact(payload, ['appIds']); await record.prepared; const appIds = appIdsFor(payload.appIds); if (!appIds.includes(record.appId)) throw new Error('A2A_APP_SET'); await commitA2A(appIds); return { status: 'committed', appIds } }],
  ['a2a_close_owner', async payload => {
    if (payload !== null || !record.binding) throw new Error('A2A_CLOSE_OWNER')
    if (a2a.ownerClosed) return { status: 'closed' }
    a2a.ownerClosePromise ??= (async () => {
      a2a.ownerClosing = true
      // Keep the parent Hook alive for attempt_end and official evaluation.
      // A disconnect before successful drain is still an authority failure.
      try {
        if (a2a.adapter) await a2a.adapter.revokeAndDrain()
        a2a.ownerClosed = true
      } catch { poisonA2A(); throw new Error('A2A_OWNER_DRAIN_FAILED') }
    })()
    await a2a.ownerClosePromise
    return { status: 'closed' }
  }],
  ['a2a_begin_child', async payload => {
    assertA2AOpen(); exact(payload, ['appId', 'parentEvidencePath', 'task'])
    if (!a2a.committed || !record.facade || a2a.childStarting || a2a.activeHandle || a2a.nativeInFlight || payload.appId !== record.appId
      || typeof payload.parentEvidencePath !== 'string' || typeof payload.task !== 'string' || !payload.task) throw new Error('A2A_BEGIN')
    const parent = a2a.parentResponses.get(payload.parentEvidencePath)
    if (!parent) throw new Error('A2A_PARENT_RECEIPT')
    a2a.childStarting = true
    let handle: any = null
    try {
      handle = await record.facade.register(parent, payload.task)
      const scope = record.facade.scope(handle)
      await record.facade.startChild(handle)
      const handleToken = randomUUID()
      a2a.handles.set(handleToken, { handle, scope, entry: record }); a2a.activeHandle = handleToken
      a2a.parentResponses.delete(payload.parentEvidencePath)
      return { handleToken, scope }
    } catch {
      if (handle) { try { await record.facade.cancelChild(handle) } catch {} }
      throw new Error('A2A_CHILD_START_FAILED')
    } finally { a2a.childStarting = false }
  }],
  ['a2a_before_model', async payload => { exact(payload, ['handleToken', 'input']); const item = handleFor(record, payload.handleToken); return await record.facade.beforeModel(item.handle, payload.input) }],
  ['a2a_assert_model', payload => { exact(payload, ['handleToken', 'requestId']); const item = handleFor(record, payload.handleToken); record.facade.assertModelActive(item.handle, payload.requestId); return { ok: true } }],
  ['a2a_complete_model', payload => { exact(payload, ['handleToken', 'requestId']); const item = handleFor(record, payload.handleToken); record.facade.completeModel(item.handle, payload.requestId); return { ok: true } }],
  ['a2a_dispatch', async payload => {
    exact(payload, ['arguments', 'handleToken', 'tool'])
    const item = handleFor(record, payload.handleToken)
    // All owners share one ARE environment and clock. Cancel revokes the
    // child's authority but cannot imply that an in-flight native call has
    // returned; retain this parent-wide barrier until its await completes.
    if (a2a.nativeInFlight || a2a.activeHandle !== payload.handleToken || typeof payload.tool !== 'string' || !plain(payload.arguments)) throw new Error('A2A_DISPATCH')
    const meta = record.binding.manifest().tools.find((tool: any) => tool.toolId === payload.tool)
    if (!meta) throw new Error('A2A_TOOL')
    a2a.nativeInFlight = true
    try {
      const prepared = await record.binding.prepare(item.scope, { tool: meta.publicName, arguments: payload.arguments })
      const result = await record.facade.dispatch(item.handle, prepared.toolId, prepared.effectiveArguments)
      // A sealed before-gate rejection has already discarded its unconsumed
      // ticket. It is feedback, never an App result or child completion.
      if (result.status === 'blocked') return { ...result, toolId: prepared.toolId, toolKind: meta.toolKind, completionEvidenceRef: null }
      const completionEvidenceRef = meta.toolKind === 'child_final_answer' ? (await record.facade.completeChild(item.handle)).evidence : null
      if (completionEvidenceRef && a2a.activeHandle === payload.handleToken) a2a.activeHandle = null
      return { ...result, toolId: prepared.toolId, toolKind: meta.toolKind, completionEvidenceRef }
    } finally { a2a.nativeInFlight = false }
  }],
  ['a2a_cancel_child', async payload => { exact(payload, ['handleToken']); const item = handleFor(record, payload.handleToken); await record.facade.cancelChild(item.handle); if (a2a.activeHandle === payload.handleToken) a2a.activeHandle = null; return null }],
])
async function configureA2A(socket: Socket): Promise<void> {
  if (closing || a2a.ownerClosed || a2a.poisoned || a2a.committed || a2a.connections.size >= 64) { socket.destroy(); return }
  const record: any = { socket, appId: null, peer: null, binding: null, facade: null }
  record.prepared = new Promise<void>((resolveReady, rejectReady) => { record.resolveReady = resolveReady; record.rejectReady = rejectReady })
  // A failed inspect/handshake can reject before connect_ready attaches.
  void record.prepared.catch(() => {})
  a2a.connections.add(record)
  const peer = new RuntimeDelegationPipePeer({ reader: socket, writer: socket, channelId: spec.options.a2a.channelId, bindingHash: spec.options.a2a.bindingHash, handlers: handlersFor(record), onClosed: () => poisonA2A() })
  record.peer = peer
  try {
    const manifest: any = await peer.call('inspect_app', null, { timeoutMs: 30000 })
    assertA2AOpen()
    if (!plain(manifest) || !['gaia2-native-app-binding-v1', 'gaia2-native-app-binding-v2'].includes(manifest.schemaVersion) || typeof manifest.appId !== 'string'
      || !/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(manifest.appId) || a2a.entries.has(manifest.appId)
      || (a2a.expectedAppIds && !a2a.expectedAppIds.includes(manifest.appId))
      || !Array.isArray(manifest.sourceRefs) || typeof manifest.appType !== 'string'
      || manifest.environmentGeneration !== `official-${spec.options.executionId}` || typeof manifest.evidenceRoot !== 'string') throw new Error('A2A_MANIFEST')
    record.appId = manifest.appId; a2a.entries.set(manifest.appId, record)
    const frozenSources = manifest.sourceRefs.map((ref: any) => ({ path: ref.path, sha256: ref.sha256, bytes: ref.bytes }))
    record.binding = await RuntimeDelegationNativePipeBinding.connect({ peer, expected: { environmentGeneration: manifest.environmentGeneration, parentExecutionId: spec.options.executionId, parentSessionId: spec.options.sessionId, appId: manifest.appId, appType: manifest.appType, evidenceRoot: manifest.evidenceRoot, frozenSources, requiredSources: frozenSources.map(ref => ref.path), requireNativeAdmissionDeadline: true }, onPoison: poisonA2A })
    assertA2AOpen(); record.resolveReady()
  } catch { record.rejectReady(new Error('A2A_HANDSHAKE_FAILED')); poisonA2A() }
}
const server = createHttpServer(async (req, res) => {
  const reply = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }
  const supplied = createHash('sha256').update(req.headers.authorization ?? '').digest()
  if (!timingSafeEqual(supplied, expectedAuth)) { reply(403, { error: 'invalid_session_capability' }); return }
  if (req.method !== 'POST' || !['/invoke', '/shutdown', '/tool-round'].includes(req.url ?? '')) { reply(404, { error: 'unknown_operation' }); return }
  let length = 0; const chunks: Buffer[] = []
  try {
    for await (const chunk of req) { length += chunk.length; if (length > 4 * 1024 * 1024) throw new Error('request_size_exceeded'); chunks.push(Buffer.from(chunk)) }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (input.executionId !== spec.options.executionId || input.sessionId !== spec.options.sessionId) { reply(409, { error: 'foreign_session' }); return }
    if (req.url === '/shutdown') { if (closing) { reply(409, { error: 'already_closing' }); return }; closing = true; try { if (a2a.adapter) await a2a.adapter.close(); else await host.close() } finally { for (const record of a2a.connections) { try { record.binding?.close(); record.peer?.close() } catch {}; record.socket.destroy() } }; reply(200, { status: 'closed' }); server.close(); a2aServer?.close(); return }
    if (closing) { reply(409, { error: 'host_closing' }); return }
    if (req.url === '/tool-round') { reply(200, toolRounds.invoke(input)); return }
    const { executionId, sessionId, ...invocation } = input
    const semantic = invocation.outcome?.semanticEvidence
    if (semantic !== undefined && (!entitySemanticsEnabled || semantic?.executionId !== executionId || semantic?.sessionId !== sessionId)) throw new Error('semantic evidence not authorized')
    if (invocation.outcome?.mutationEvidence !== undefined) {
      if (!mutationReceiptsEnabled) throw new Error('mutation evidence not authorized')
      validateMutationInvocation(invocation, { executionId, sessionId })
    }
    // The legacy state-approval control remains retired. The generic
    // Actor-owned reconcile operation is a separate bounded count check
    // anchored to visible USER text and is admitted to the runtime Hook.
    if (invocation.action?.canonicalName?.startsWith('CapybaraTaskContract__')
      && !(invocation.action.canonicalName === 'CapybaraTaskContract__review' && invocation.action.arguments?.op === 'reconcile')) throw new Error('task contract control is retired')
    const result = await host.invoke(invocation)
    if (invocation.checkpoint === 'before_tool' && result?.evidencePath) a2a.parentResponses.set(result.evidencePath, result)
    // This is a project transport extension, not a mutation of the Host-owned
    // RuntimePluginResponse (also used by the independent A2A binding).
    const retrievalReceipt = retrievalEnabled ? createRetrievalReceipt({ response: result, invocation,
      workspaceDir: spec.options.workspaceDir, executionId: spec.options.executionId, sessionId: spec.options.sessionId }) : undefined
    const temporalReceipt = temporalEnabled ? createTemporalReceipt({ response: result, invocation,
      workspaceDir: spec.options.workspaceDir, executionId: spec.options.executionId, sessionId: spec.options.sessionId }) : undefined
    const conflictReceipt = conflictRecoveryEnabled ? createConflictReceipt({ response: result, invocation,
      workspaceDir: spec.options.workspaceDir, executionId: spec.options.executionId, sessionId: spec.options.sessionId }) : undefined
    const semanticReceipt = entitySemanticsEnabled || mutationReceiptsEnabled ? createSemanticReceipt({ response: result, invocation,
      workspaceDir: spec.options.workspaceDir, executionId: spec.options.executionId, sessionId: spec.options.sessionId, mutationReceipts: mutationReceiptsEnabled }) : undefined
    reply(200, retrievalReceipt || temporalReceipt || conflictReceipt || semanticReceipt ? { ...result, ...(retrievalReceipt ? { retrievalReceipt } : {}), ...(temporalReceipt ? { temporalReceipt } : {}), ...(conflictReceipt ? { conflictReceipt } : {}), ...(semanticReceipt ? { semanticReceipt } : {}) } : result)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    const code = /^[A-Za-z0-9_]{1,96}$/.test(message) ? message : 'hook_host_rejected'
    reply(422, { error: 'hook_host_rejected', code })
  }
})
const a2aServer = spec.options.a2a?.enabled ? createNetServer(socket => { void configureA2A(socket) }) : null
await new Promise<void>(resolveReady => server.listen(0, '127.0.0.1', resolveReady)); if (a2aServer) await new Promise<void>(resolveReady => a2aServer.listen(0, '127.0.0.1', resolveReady))
const address = server.address(), a2aAddress = a2aServer?.address()
if (!address || typeof address === 'string') throw new Error('loopback address missing')
if (a2aServer && (!a2aAddress || typeof a2aAddress === 'string')) throw new Error('A2A loopback address missing')
if (existsSync(spec.readyPath)) throw new Error('host ready receipt already exists')
const readyTemporary = `${spec.readyPath}.${process.pid}.tmp`, a2aReady = a2aAddress && typeof a2aAddress !== 'string' ? { schemaVersion: 'gaia2-private-listener-v1', host: '127.0.0.1', port: a2aAddress.port, channelId: spec.options.a2a.channelId, bindingHash: spec.options.a2a.bindingHash } : null
writeFileSync(readyTemporary, JSON.stringify({ schemaVersion: 'gaia2-hook-host-ready-v1', endpoint: `http://127.0.0.1:${address.port}/invoke`, processId: process.pid, initialization, initializationHash: createHash('sha256').update(JSON.stringify(initialization)).digest('hex'), ...(a2aReady ? { a2a: a2aReady } : {}), ...(entry ? { entry: { schemaVersion: entry.schemaVersion, path: entry.path, relativePath: entry.relativePath, sha256: entry.sha256 } } : {}) }) + '\n', { flag: 'wx' })
renameSync(readyTemporary, spec.readyPath)
console.log(JSON.stringify({ status: 'ready', executionId: spec.options.executionId, sessionId: spec.options.sessionId, pluginCount: spec.options.plugins.length, a2a: Boolean(a2aReady) }))
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => { if (!closing) { closing = true; try { if (a2a.adapter) await a2a.adapter.close(); else await host.close() } finally { for (const record of a2a.connections) { try { record.binding?.close(); record.peer?.close() } catch {}; record.socket.destroy() }; server.close(); a2aServer?.close() } } })
