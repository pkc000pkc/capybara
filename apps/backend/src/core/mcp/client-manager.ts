import { randomUUID, createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Client, StreamableHTTPClientTransport, type Tool, type Transport } from '@modelcontextprotocol/client'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio'
import { Ajv, type ValidateFunction } from 'ajv'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { allowsMcpInput, type McpServerConfig } from '#core/mcp/config'
import type { McpOperation, McpOperationBinding } from '#core/mcp/operations'
import { readMcpInputs, type McpInputContinuation, type McpInputData } from '#core/mcp/input'
import { capabilityHash, type RuntimeCapability } from '#core/runtime-capability-projection'
import type { ToolDefinition, JsonObject, RuntimeMcpState } from '#protocol/runtime-protocol'
import type { ToolCallRequest, ToolCallResult, ToolCallErrorCode } from '#core/tools/types'

type Provenance = NonNullable<ToolCallResult['source']>
type InputHandler = { continuation?: McpInputContinuation; register: (authority: string, source: Provenance, data: McpInputData) => string;
  registerWriteDispatch?: (source: Provenance) => void }
export interface McpOperationJournal {
  loadUnknown(): Array<[string, Provenance]>
  reserve(signature: string, source: Provenance, binding?: McpOperationBinding): void
  settle(source: Provenance, output?: unknown): void
  read?(operationId: string): McpOperation | undefined
  priorCall?(taskId: string, runId: string, callId: string): McpOperation | undefined
}
export interface McpManagerState { unknownCalls: Array<[string, Provenance]>; activeToolIds?: string[] }
export interface McpServerStatus {
  id: string; transport: McpServerConfig['transport']['type']; status: 'idle' | 'connecting' | 'ready' | 'disconnected' | 'failed' | 'disabled'
  connectionId?: string; protocolVersion?: string; serverInfo?: { name: string; version: string }; toolCount: number
  errorCode?: string
}
interface RemoteTool { remote: Tool; definition: ToolDefinition; delegationVersion: string; validate: ValidateFunction; validateOutput?: ValidateFunction }
interface Connection {
  config: McpServerConfig; fingerprint: string; status: McpServerStatus; client?: Client; transport?: Transport
  tools: Map<string, RemoteTool>; dirty: boolean; catalogEpoch: number; rpcIds: Map<string, string | number>
  sources: Map<string, { source: Provenance; registerWriteDispatch?: (source: Provenance) => void }>
}

export function mcpToolName(serverId: string, toolName: string): string {
  const suffix = capabilityHash([serverId, toolName]).slice(0, 12)
  return `mcp_${serverId.replace(/-/g, '_').slice(0, 16)}_${toolName.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 24)}_${suffix}`
}

/** Bound bytes before the SDK buffers/parses a remote HTTP body. */
async function boundedMcpFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init), maximum = 5 * 1024 * 1024
  if (!response.body) return response
  if (Number(response.headers.get('content-length')) > maximum) { await response.body.cancel(); throw new Error('MCP_OUTPUT_LIMIT') }
  const reader = response.body.getReader(); let received = 0
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (chunk.done) { controller.close(); return }
        received += chunk.value.byteLength
        if (received > maximum) { await reader.cancel(); controller.error(new Error('MCP_OUTPUT_LIMIT')); return }
        controller.enqueue(chunk.value)
      } catch (error) { controller.error(error) }
    },
    cancel: reason => reader.cancel(reason),
  }), { status: response.status, statusText: response.statusText, headers: response.headers })
}

/** Real MCP connections. Discovery may reconnect; business calls never do. */
export class McpClientManager {
  private connections = new Map<string, Connection>()
  private readonly unknownCalls = new Map<string, Provenance>()
  private readonly controllers = new Set<AbortController>()
  private closed = false
  private closePromise?: Promise<void>
  private revision = 0
  constructor(private readonly projectDir: string, private readonly changed: () => void = () => {}, private readonly journal?: McpOperationJournal,
    configs: readonly McpServerConfig[] = [], private readonly supportsUrlInput = false) {
    for (const config of configs) this.connections.set(config.id, { config, fingerprint: '', status: { id: config.id, transport: config.transport.type, status: config.enabled ? 'idle' : 'disabled', toolCount: 0 },
      tools: new Map(), dirty: true, catalogEpoch: 0, rpcIds: new Map(), sources: new Map() })
  }
  private validator(schema: Record<string, unknown>): ValidateFunction {
    return (schema.$schema === 'http://json-schema.org/draft-07/schema#' ? new Ajv({ strict: false, allErrors: true }) : new Ajv2020({ strict: false, allErrors: true })).compile(schema)
  }

  private notify(): void { this.revision++; if (!this.closed) this.changed() }
  snapshot(): RuntimeMcpState {
    const pendingOperations = [...this.unknownCalls.values()].flatMap(source => {
      if (!source.operationId) return []
      const operation = this.journal?.read?.(source.operationId)
      const verifier = operation?.binding?.verification
      return [{ operationId: source.operationId, serverId: source.serverId, toolName: source.toolName,
        ...(operation?.binding ? { taskId: operation.binding.taskId, runId: operation.binding.runId } : {}),
        ...(verifier && operation?.source.rpcRequestId !== undefined ? { verificationCapabilityId: `mcp:${source.serverId}:${verifier.toolName}`,
          ...(verifier.poll ? { verificationPollIntervalMs: verifier.poll.intervalMs } : {}) } : {}) }]
    })
    return { revision: this.revision, unknownCallCount: this.unknownCalls.size, servers: [...this.connections.values()].map(c => structuredClone(c.status)),
      ...(pendingOperations.length ? { pendingOperations } : {}) }
  }
  exportState(): McpManagerState { return { unknownCalls: structuredClone([...this.unknownCalls]) } }
  restoreState(state?: McpManagerState): void {
    if (this.journal) {
      this.unknownCalls.clear()
      for (const [key, source] of this.journal.loadUnknown()) this.unknownCalls.set(key, structuredClone(source))
      return
    }
    for (const [key, source] of state?.unknownCalls ?? []) if (/^[a-f0-9]{64}$/.test(key) && source.type === 'mcp' && source.outcome === 'unknown') this.unknownCalls.set(key, structuredClone(source))
  }
  private secrets(config: McpServerConfig): Record<string, string> {
    const refs = config.transport.type === 'stdio' ? config.transport.env_refs : config.transport.header_refs
    return Object.fromEntries(Object.entries(refs).map(([name, ref]) => {
      const value = process.env[ref]
      if (value === undefined || value.includes('\r') || value.includes('\n')) throw new Error('MCP_CREDENTIAL_UNAVAILABLE')
      return [name, value]
    }))
  }
  private implementationFiles(config: McpServerConfig): Array<[string, string]> {
    const files: Array<[string, string]> = []
    if (config.transport.type === 'stdio') for (const name of [config.transport.command, ...config.transport.args]) {
      const file = path.resolve(this.projectDir, config.transport.cwd, name)
      if (fs.existsSync(file) && fs.statSync(file).isFile()) files.push([file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')])
    }
    return files
  }
  private fingerprint(config: McpServerConfig, files = this.implementationFiles(config)): string {
    // Private change detector; neither resolved credentials nor this digest leave the manager.
    return capabilityHash({ config, files, secrets: this.secrets(config) })
  }
  private async disconnect(c: Connection): Promise<void> {
    const client = c.client; c.client = undefined; c.transport = undefined; c.dirty = true
    c.status.status = c.config.enabled ? 'disconnected' : 'disabled'
    this.notify()
    try { await client?.close() } catch { /* original failure remains authoritative */ }
  }
  private async connect(c: Connection, signal: AbortSignal): Promise<void> {
    c.status = { id: c.config.id, transport: c.config.transport.type, status: 'connecting', toolCount: c.tools.size }
    this.notify()
    if (this.closed || signal.aborted) throw new Error('MCP_CLOSED')
    const policies = Object.values(c.config.tool_policies)
    const form = policies.some(policy => allowsMcpInput(policy.human_input, 'form'))
    const url = this.supportsUrlInput && policies.some(policy => allowsMcpInput(policy.human_input, 'url'))
    const client = new Client({ name: 'capybara', version: '0.2.0' }, {
      capabilities: form || url ? { elicitation: { ...(form ? { form: {} } : {}), ...(url ? { url: {} } : {}) } } : {},
      versionNegotiation: { mode: 'auto', probe: { timeoutMs: Math.min(c.config.timeout_ms, 2000), maxRetries: 0 } },
      inputRequired: { autoFulfill: false }, listMaxPages: 32,
      listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => {
        if (c.client !== client) return
        c.catalogEpoch += 1
        c.dirty = true
        this.notify()
      } } },
    })
    const t = c.config.transport
    const transport: Transport = t.type === 'stdio'
      ? new StdioClientTransport({ command: t.command === 'node' && process.versions.electron ? process.env.CAPYBARA_NODE_PATH || process.env.npm_node_execpath || 'node' : t.command,
        args: t.args, cwd: path.resolve(this.projectDir, t.cwd), env: { ...getDefaultEnvironment(), ...this.secrets(c.config) }, stderr: 'ignore', maxBufferSize: 5 * 1024 * 1024 })
      : new StreamableHTTPClientTransport(new URL(t.url), { requestInit: { headers: this.secrets(c.config), redirect: 'error' }, fetch: boundedMcpFetch,
        reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 100, maxReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 } })
    const send = transport.send.bind(transport)
    transport.send = async (message, options) => {
      if ('method' in message && message.method === 'tools/call' && 'id' in message) {
        const callId = (message.params?._meta as Record<string, unknown> | undefined)?.['io.capybara/callId']
        if (typeof callId === 'string') {
          const tracked = c.sources.get(callId), source = tracked?.source
          if (source?.dispatched) throw new Error('MCP_CALL_REPLAY_FORBIDDEN')
          c.rpcIds.set(callId, message.id)
          if (source) {
            source.rpcRequestId = message.id
            if (tracked?.registerWriteDispatch) {
              try { tracked.registerWriteDispatch(source) }
              catch { throw new Error('MCP_FORM_WRITE_DISPATCH_REJECTED') }
            }
            else if (source.operationId) this.journal?.settle(source)
            source.dispatched = true
          }
        }
      }
      await send(message, options)
    }
    c.client = client; c.transport = transport
    client.onclose = () => { if (c.client === client) { c.dirty = true; c.status.status = 'disconnected'; this.notify() } }
    client.onerror = error => {
      if (c.client !== client) return
      c.dirty = true; c.status.errorCode = /JSON|parse|schema|validat|ZodError|ValiError/i.test(`${error.name}:${error.message}`) ? 'MCP_PROTOCOL_ERROR' : 'MCP_TRANSPORT_ERROR'
      this.notify(); void this.disconnect(c)
    }
    await client.connect(transport, { signal, timeout: c.config.timeout_ms, maxTotalTimeout: c.config.timeout_ms })
    if (this.closed || signal.aborted) { await this.disconnect(c); throw new Error('MCP_CLOSED') }
    const info = client.getServerVersion()
    c.status = { id: c.config.id, transport: t.type, status: 'ready', connectionId: randomUUID(),
      protocolVersion: client.getNegotiatedProtocolVersion(), toolCount: 0,
      ...(info ? { serverInfo: { name: info.name.slice(0, 128), version: info.version.slice(0, 128) } } : {}) }
    this.notify()
  }

  async prepare(configs: readonly McpServerConfig[], signal?: AbortSignal, serverId?: string): Promise<void> {
    if (this.closed) throw new Error('MCP_CLOSED')
    signal?.throwIfAborted()
    if (this.journal) this.restoreState()
    for (const [id, c] of this.connections) if (!configs.some(config => config.id === id)) { await this.disconnect(c); this.connections.delete(id) }
    await Promise.all(configs.filter(config => !serverId || config.id === serverId).map(async config => {
      let c = this.connections.get(config.id)
      if (!c) { c = { config, fingerprint: '', status: { id: config.id, transport: config.transport.type, status: 'idle', toolCount: 0 }, tools: new Map(), dirty: true, catalogEpoch: 0, rpcIds: new Map(), sources: new Map() }; this.connections.set(config.id, c) }
      const controller = new AbortController(); this.controllers.add(controller)
      const bound = AbortSignal.any([controller.signal, AbortSignal.timeout(config.timeout_ms), ...(signal ? [signal] : [])])
      let discoveryClient: Client | undefined
      try {
        if (!config.enabled) { c.config = config; await this.disconnect(c); return }
        const files = this.implementationFiles(config)
        const fingerprint = this.fingerprint(config, files)
        if (c.fingerprint !== fingerprint || c.status.status !== 'ready') { await this.disconnect(c); c.config = config; c.fingerprint = fingerprint; await this.connect(c, bound) }
        const client = c.client!
        discoveryClient = client
        let listed: Awaited<ReturnType<Client['listTools']>>
        for (;;) {
          bound.throwIfAborted()
          const epoch = c.catalogEpoch
          listed = await client.listTools(undefined, { signal: bound, timeout: config.timeout_ms, maxTotalTimeout: config.timeout_ms, cacheMode: 'refresh' })
          if (c.client !== client || c.status.status !== 'ready') return
          bound.throwIfAborted()
          // Retry invalidated pages within the original discovery deadline.
          if (c.catalogEpoch === epoch) break
        }
        if (listed.tools.length > 2000 || Buffer.byteLength(JSON.stringify(listed)) > 2 * 1024 * 1024) throw new Error('MCP_CATALOG_LIMIT')
        const tools = new Map<string, RemoteTool>(), names = new Set<string>()
        for (const remote of listed.tools) {
          if (!/^[A-Za-z0-9_.-]{1,128}$/.test(remote.name) || names.has(remote.name)) throw new Error('MCP_TOOL_ID_INVALID')
          names.add(remote.name)
          const schema = remote.inputSchema as Record<string, unknown>
          const validate = this.validator(schema)
          const policy = config.tool_policies[remote.name] ?? { permissions: [], sideEffects: 'external' as const, replay: 'never' as const }
          const permissions = [...new Set([`mcp:${config.id}:${remote.name}`, ...policy.permissions])]
          const sourceVersion = capabilityHash({ config, connectionId: c.status.connectionId, serverInfo: c.status.serverInfo, protocolVersion: c.status.protocolVersion, remote, permissions })
          const delegationVersion = capabilityHash({ config, files, serverInfo: c.status.serverInfo, protocolVersion: c.status.protocolVersion, remote, permissions })
          const definition: ToolDefinition = { id: `mcp:${config.id}:${remote.name}`, name: mcpToolName(config.id, remote.name),
            description: (remote.description ?? remote.name).slice(0, 12000), inputSchema: structuredClone(remote.inputSchema) as JsonObject,
            ...(remote.outputSchema ? { outputSchema: structuredClone(remote.outputSchema) as JsonObject } : {}),
            permissions, sideEffects: policy.sideEffects, replay: policy.replay,
            definitionRevision: c.tools.get(mcpToolName(config.id, remote.name))?.definition.origin?.sourceVersion === sourceVersion ? c.tools.get(mcpToolName(config.id, remote.name))!.definition.definitionRevision : this.revision + 1, enabled: true,
            origin: { type: 'mcp', serverId: config.id, toolName: remote.name, connectionId: c.status.connectionId!, sourceVersion } }
          tools.set(definition.name, { remote, definition, delegationVersion, validate,
            ...(remote.outputSchema ? { validateOutput: this.validator(remote.outputSchema) } : {}) })
        }
        if (this.closed || bound.aborted || c.client !== client || c.status.status !== 'ready') throw new Error('MCP_DISCOVERY_INTERRUPTED')
        c.tools = tools; c.dirty = false; c.status.toolCount = tools.size; delete c.status.errorCode; this.notify()
      } catch {
        if (discoveryClient && c.client && c.client !== discoveryClient) return
        await this.disconnect(c)
        c.status.status = config.enabled ? 'failed' : 'disabled'; c.status.errorCode = 'MCP_DISCOVERY_FAILED'; this.notify()
      } finally { this.controllers.delete(controller) }
    }))
  }
  definitions(): ToolDefinition[] { return [...this.connections.values()].flatMap(c => [...c.tools.values()].map(tool => structuredClone(tool.definition))) }
  capabilities(configs: readonly McpServerConfig[], granted: ReadonlySet<string>, loaded: ReadonlySet<string>, child: boolean): RuntimeCapability[] {
    return [...this.connections.values()].flatMap(c => [...c.tools.values()].map(({ definition: tool, delegationVersion }): RuntimeCapability => {
      const config = configs.find(config => config.id === c.config.id)
      let current = false
      try { current = !!config?.enabled && c.fingerprint === this.fingerprint(config) } catch { /* unavailable credentials/config */ }
      const reason = !current ? 'configuration_changed' : c.status.status !== 'ready' ? 'disconnected' : c.dirty ? 'catalog_stale'
        : !loaded.has(tool.name) ? 'not_loaded' : tool.permissions!.some(p => !granted.has(p)) ? 'permission_denied'
          : child && (tool.sideEffects !== 'none' || tool.permissions!.some(p => ['filesystem:write', 'filesystem:delete', 'process:execute'].includes(p))) ? 'child_readonly' : undefined
      return { capabilityId: tool.id, name: tool.name, source: 'mcp', sourceVersion: tool.origin!.sourceVersion, delegationVersion,
        schemaHash: capabilityHash(tool.inputSchema), permissions: tool.permissions!, sideEffects: tool.sideEffects!, replay: tool.replay!,
        available: reason === undefined, ...(reason ? { unavailableReason: reason } : {}), definition: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }
    }))
  }
  private verificationAuthority(operationId: string, connection: Connection, verifier: RemoteTool): string {
    return capabilityHash([operationId, connection.fingerprint, verifier.delegationVersion])
  }

  verificationPollServer(operation: McpOperation, configs: readonly McpServerConfig[], granted: ReadonlySet<string>): McpServerConfig | undefined {
    const verification = operation.binding?.verification
    const config = configs.find(item => item.id === operation.source.serverId && item.enabled)
    if (!verification?.poll || !config) return undefined
    const policy = config.tool_policies[verification.toolName]
    if (!policy || ![`mcp:${config.id}:${verification.toolName}`, ...policy.permissions].every(permission => granted.has(permission))) return undefined
    return capabilityHash([operation.source.operationId, this.fingerprint(config)]) === verification.poll.connectionAuthority ? config : undefined
  }

  verificationTool(operation: McpOperation, readOriginal = false): string | undefined {
    const { source, binding, verification } = operation
    if ((verification && (!readOriginal || verification.outcome !== 'applied')) || source.outcome !== 'unknown'
      || !source.operationId || source.rpcRequestId === undefined || !binding?.verification) return undefined
    const connection = this.connections.get(source.serverId)
    const name = mcpToolName(source.serverId, binding.verification.toolName)
    const verifier = connection?.tools.get(name)
    if (!connection || !verifier || connection.config.tool_policies[source.toolName]?.verification_tool !== verifier.remote.name
      || verifier.definition.sideEffects !== 'none' || verifier.definition.replay !== 'safe'
      || this.verificationAuthority(source.operationId, connection, verifier) !== binding.verification.authorityVersion) return undefined
    return name
  }

  verifiedOriginalResult(operation: McpOperation, verificationResult: unknown): unknown {
    if (operation.verification?.outcome !== 'applied' || !operation.binding?.verification) return undefined
    const report = verificationResult as { structuredContent?: { original_result?: unknown } } | undefined
    const candidate = report?.structuredContent?.original_result
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
    const original = candidate as Record<string, unknown>
    if ((original.resultType !== undefined && original.resultType !== 'complete') || original.isError === true || !Array.isArray(original.content)) return undefined
    const schema = operation.binding.verification.originalOutputSchema
    return schema && !this.validator(schema)(original.structuredContent) ? undefined : original
  }

  private inputAuthority(connection: Connection, tool: RemoteTool): string | undefined {
    const policy = connection.config.tool_policies[tool.remote.name]
    if (!policy?.human_input || connection.status.protocolVersion !== '2026-07-28'
      || (policy.human_input === 'url' && !this.supportsUrlInput)) return undefined
    const verifier = policy.verification_tool ? connection.tools.get(mcpToolName(connection.config.id, policy.verification_tool)) : undefined
    if (tool.definition.sideEffects === 'none' ? tool.definition.replay !== 'safe' : !verifier || tool.definition.replay === 'safe') return undefined
    return capabilityHash([connection.fingerprint, tool.delegationVersion, ...(verifier ? [verifier.delegationVersion] : [])])
  }

  canContinueInput(continuation: Pick<McpInputContinuation, 'tool' | 'args' | 'authority'>): boolean {
    const c = [...this.connections.values()].find(connection => connection.tools.has(continuation.tool))
    const tool = c?.tools.get(continuation.tool)
    return !!(c && tool && this.inputAuthority(c, tool) === continuation.authority && tool.validate(continuation.args))
  }

  authorizesUrlInput(entry: { serverId: string; toolName: string; urlAuthority: string }, configs: readonly McpServerConfig[], granted: ReadonlySet<string>): boolean {
    const config = configs.find(config => config.id === entry.serverId && config.enabled)
    const policy = config?.tool_policies[entry.toolName]
    if (!config || !policy || !allowsMcpInput(policy.human_input, 'url') || !granted.has(`mcp:${entry.serverId}:${entry.toolName}`)
      || policy.permissions.some(permission => !granted.has(permission))) return false
    try { return entry.urlAuthority === capabilityHash([this.fingerprint(config), entry.toolName]) }
    catch { return false }
  }

  async call(request: ToolCallRequest, configs: readonly McpServerConfig[], granted: ReadonlySet<string>, signal?: AbortSignal, stepId?: string, interactive?: InputHandler): Promise<ToolCallResult> {
    const startedAt = new Date().toISOString(), started = Date.now()
    const c = [...this.connections.values()].find(c => c.tools.has(request.name)), tool = c?.tools.get(request.name)
    const expected = request.authorization?.projection.bindings.find(binding => binding.name === request.name)
    const source: Provenance | undefined = c && tool ? { type: 'mcp', serverId: c.config.id, toolName: tool.remote.name, connectionId: c.status.connectionId!,
      protocolVersion: c.status.protocolVersion, sourceVersion: tool.definition.origin!.sourceVersion, dispatched: false, outcome: 'not_dispatched' } : undefined
    const fail = (code: ToolCallErrorCode, message: string, details: Record<string, unknown> = {}): ToolCallResult => ({ id: request.id, name: request.name, ok: false,
      ...(source ? { source: { ...source } } : {}), error: { code, message, details }, startedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - started })
    if (!c || !tool || !source || !expected || expected.sourceVersion !== source.sourceVersion || !this.capabilities(configs, granted, new Set([request.name]), false).find(cap => cap.name === request.name)?.available) return fail('PERMISSION_DENIED', 'MCP capability is not currently authorized')
    if (!tool.validate(request.arguments)) return fail('INVALID_ARGUMENTS', 'MCP arguments failed the registered schema')
    const continuation = interactive?.continuation
    const inputAuthority = interactive ? this.inputAuthority(c, tool) : undefined
    const continuationOfWrite = continuation?.operationId
    if (continuation && (!inputAuthority || continuation.authority !== inputAuthority || continuation.tool !== request.name
      || capabilityHash(continuation.args) !== capabilityHash(request.arguments) || (tool.definition.sideEffects !== 'none') !== !!continuationOfWrite
      || (continuationOfWrite && (!interactive?.registerWriteDispatch || Object.values(continuation.answers).some(answer => answer.action !== 'accept'))))) {
      return fail('PERMISSION_DENIED', 'MCP form continuation authority changed')
    }
    const signature = capabilityHash([source.serverId, source.toolName, request.arguments])
    if (tool.definition.sideEffects !== 'none' && !continuationOfWrite && this.unknownCalls.has(signature)) return fail('RECOVERY_BLOCKED', 'A prior MCP side effect has an unknown outcome; verify it before retrying', { previousCall: this.unknownCalls.get(signature) })
    if (signal?.aborted || this.closed) return fail('ABORTED', 'MCP call was not dispatched')
    if (continuationOfWrite) {
      source.operationId = continuationOfWrite
      source.outcome = 'unknown'
    } else if (tool.definition.sideEffects !== 'none') {
      const original = request.authorization!.projection.request
      const previous = this.journal?.priorCall?.(original.taskId, original.runId, request.id)
      if (previous?.source.rpcRequestId !== undefined && ['unknown', 'succeeded'].includes(previous.source.outcome)) return fail('RECOVERY_BLOCKED', 'The original MCP call already has a durable operation identity; use its recorded result or propose a new authorized call.',
        { operationId: previous.source.operationId, ...(previous.verification ? { outcome: previous.verification.outcome } : {}) })
      source.operationId = randomUUID(); source.outcome = 'unknown'
      const policy = c.config.tool_policies[source.toolName]
      const verifierName = policy?.verification_tool
      const verifier = verifierName ? c.tools.get(mcpToolName(source.serverId, verifierName)) : undefined
      const binding: McpOperationBinding = { taskId: original.taskId, runId: original.runId, callId: request.id, toolName: request.name,
        ...(stepId ? { stepId } : {}), argumentHash: createHash('sha256').update(JSON.stringify(request.arguments)).digest('hex'),
        ...(verifier ? { verification: { toolName: verifier.remote.name, authorityVersion: this.verificationAuthority(source.operationId, c, verifier),
          ...(policy?.verification_poll_ms ? { poll: { intervalMs: policy.verification_poll_ms, connectionAuthority: capabilityHash([source.operationId, c.fingerprint]) } } : {}),
          ...(tool.definition.outputSchema ? { originalOutputSchema: tool.definition.outputSchema } : {}) } } : {}) }
      try { this.journal?.reserve(signature, source, binding) } catch (error) {
        source.outcome = 'not_dispatched'
        return fail(error instanceof Error && error.message === 'MCP_OUTCOME_UNKNOWN' ? 'RECOVERY_BLOCKED' : 'MCP_JOURNAL_FAILED', 'MCP operation was not dispatched because its durable reservation failed')
      }
      this.unknownCalls.set(signature, { ...source }); this.notify()
    }
    const settle = (output?: unknown): void => {
      if (!source.operationId || continuationOfWrite) return // The continuation result and receipt share the host transaction.
      try {
        this.journal?.settle(source, output)
        if (source.outcome === 'unknown') this.unknownCalls.set(signature, { ...source }); else this.unknownCalls.delete(signature)
      } catch {
        // A confirmed result remains confirmed, but an unresolved durable journal
        // still blocks completion and duplicate writes. Never fake a rollback.
        c.status.errorCode = 'MCP_OUTCOME_PERSIST_FAILED'
      }
      this.notify()
    }
    if (signal?.aborted || this.closed) { source.outcome = 'not_dispatched'; settle(); return fail('ABORTED', 'MCP call was not dispatched') }
    const controller = new AbortController(); this.controllers.add(controller)
    const bound = AbortSignal.any([controller.signal, AbortSignal.timeout(c.config.timeout_ms), ...(signal ? [signal] : [])])
    try {
      c.sources.set(request.id, { source, ...(continuationOfWrite ? { registerWriteDispatch: interactive?.registerWriteDispatch } : {}) })
      const result = await c.client!.callTool({ name: tool.remote.name, arguments: request.arguments as Record<string, unknown>,
        ...(continuation ? { inputResponses: continuation.answers, ...(continuation.requestState !== undefined ? { requestState: continuation.requestState } : {}) } : {}), _meta: {
        'io.capybara/callId': request.id, ...(source.operationId ? { 'io.capybara/operationId': source.operationId } : {}),
      } },
        { signal: bound, timeout: c.config.timeout_ms, maxTotalTimeout: c.config.timeout_ms, allowInputRequired: true,
          // callTool applies the completion schema to input_required too. Validate terminal output below while preserving SDK header handling.
          toolDefinition: inputAuthority ? { ...tool.remote, outputSchema: undefined } : tool.remote })
      source.rpcRequestId = c.rpcIds.get(request.id)
      if (Buffer.byteLength(JSON.stringify(result)) > 5 * 1024 * 1024) throw new Error('MCP_OUTPUT_LIMIT')
      if (result.resultType === 'input_required') {
        source.outcome = tool.definition.sideEffects === 'none' ? 'failed' : 'unknown'
        settle()
        let requestId: string | undefined
        let formFailure: string | undefined
        if (interactive && inputAuthority && !bound.aborted && (continuation?.round ?? 0) < 10) {
          try {
            const policy = c.config.tool_policies[tool.remote.name]?.human_input
            const data = readMcpInputs({ inputRequests: result.inputRequests,
              ...(typeof result.requestState === 'string' ? { requestState: result.requestState } : {}) },
            mode => allowsMcpInput(policy, mode) && (mode !== 'url' || this.supportsUrlInput))
            if (Object.keys(data.urls).length) data.urlAuthority = capabilityHash([c.fingerprint, tool.remote.name])
            requestId = interactive.register(inputAuthority, source, data)
          } catch (error) {
            formFailure = error instanceof Error && /^MCP_(?:FORM|URL)_[A-Z_]+$/.test(error.message) ? error.message : 'MCP_FORM_REGISTRATION_FAILED'
          }
        }
        return fail('MCP_INPUT_REQUIRED', 'MCP server requires additional input', { ...(requestId ? { requestId } : { formAvailable: false, ...(formFailure ? { formFailure } : {}) }) })
      }
      if (result.isError) { source.outcome = tool.definition.sideEffects === 'none' ? 'failed' : 'unknown'; settle(); return fail('MCP_TOOL_ERROR', 'MCP tool returned an error', { result }) }
      if (tool.validateOutput && !tool.validateOutput(result.structuredContent)) throw new Error('MCP_OUTPUT_INVALID')
      source.outcome = 'succeeded'
      settle(result)
      return { id: request.id, name: request.name, ok: true, output: result, source, startedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - started }
    } catch (error) {
      source.rpcRequestId = c.rpcIds.get(request.id)
      source.outcome = source.dispatched && tool.definition.sideEffects !== 'none' ? 'unknown' : 'failed'
      settle()
      if (error instanceof Error && error.message === 'MCP_FORM_WRITE_DISPATCH_REJECTED') {
        return fail('MCP_JOURNAL_FAILED', 'MCP write continuation was not dispatched because its authority or durable reservation could not be verified')
      }
      await this.disconnect(c)
      const protocolError = c.status.errorCode === 'MCP_PROTOCOL_ERROR' || (error instanceof Error && /schema|validat|MCP_OUTPUT|MCP_CALL_REPLAY/i.test(error.message))
      return fail(signal?.aborted || controller.signal.aborted ? 'ABORTED' : protocolError ? 'MCP_PROTOCOL_ERROR' : bound.aborted ? 'TIMEOUT' : 'MCP_DISCONNECTED', 'MCP request did not return a verified result', { outcomeUnknown: source.outcome === 'unknown' })
    } finally { c.rpcIds.delete(request.id); c.sources.delete(request.id); this.controllers.delete(controller) }
  }
  abort(): void { for (const controller of this.controllers) controller.abort() }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true; this.abort()
    this.closePromise = Promise.all([...this.connections.values()].map(c => this.disconnect(c))).then(() => undefined)
    return this.closePromise
  }
}
