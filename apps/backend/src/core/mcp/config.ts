export type McpInputMode = 'form' | 'url'

export interface McpToolPolicy {
  permissions: string[]
  sideEffects: 'none' | 'workspace-write' | 'external'
  replay: 'safe' | 'confirm' | 'never'
  verification_tool?: string
  verification_poll_ms?: number
  human_input?: McpInputMode | 'form_and_url'
}

export function allowsMcpInput(policy: McpToolPolicy['human_input'], mode: McpInputMode): boolean {
  return policy === mode || policy === 'form_and_url'
}

export interface McpServerConfig {
  id: string
  enabled: boolean
  transport: { type: 'stdio'; command: string; args: string[]; cwd: string; env_refs: Record<string, string> }
    | { type: 'streamable-http'; url: string; header_refs: Record<string, string> }
  timeout_ms: number
  tool_policies: Record<string, McpToolPolicy>
}

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('MCP configuration contains an unknown field')
}
function refs(value: unknown, headers = false): Record<string, string> {
  if (value === undefined) return {}
  if (!object(value) || Object.keys(value).length > 64) throw new Error('MCP secret references must be an object with at most 64 entries')
  const result: Record<string, string> = Object.create(null)
  for (const [key, ref] of Object.entries(value)) {
    if (!(headers ? /^[A-Za-z][A-Za-z0-9-]{0,63}$/ : /^[A-Za-z_][A-Za-z0-9_]{0,127}$/).test(key)
      || typeof ref !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(ref)) throw new Error('MCP secrets must reference environment variable names')
    if (headers && ['host', 'content-length', 'mcp-session-id', 'mcp-protocol-version'].includes(key.toLowerCase())) throw new Error('MCP protocol headers cannot be overridden')
    result[key] = ref
  }
  return result
}

/** Configuration is host authority. Remote annotations never create grants. */
export function validateMcpServers(value: unknown): McpServerConfig[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 32) throw new Error('mcp_servers must contain at most 32 configured servers')
  const ids = new Set<string>()
  return value.map(entry => {
    if (!object(entry)) throw new Error('MCP server must be an object')
    keys(entry, ['id', 'enabled', 'transport', 'timeout_ms', 'tool_policies'])
    if (typeof entry.id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(entry.id) || ids.has(entry.id)) throw new Error('MCP server IDs must be unique kebab-case names')
    ids.add(entry.id)
    if (typeof entry.enabled !== 'boolean') throw new Error('MCP enabled must be explicit')
    const timeout = entry.timeout_ms ?? 15000
    if (!Number.isInteger(timeout) || Number(timeout) < 100 || Number(timeout) > 600000) throw new Error('MCP timeout_ms must be between 100 and 600000')
    const t = entry.transport
    if (!object(t)) throw new Error('MCP transport must be an object')
    let transport: McpServerConfig['transport']
    if (t.type === 'stdio') {
      keys(t, ['type', 'command', 'args', 'cwd', 'env_refs'])
      if (typeof t.command !== 'string' || !t.command.trim() || t.command.includes('\0')) throw new Error('MCP command is required')
      const args = t.args ?? [], cwd = t.cwd ?? '.'
      if (!Array.isArray(args) || args.length > 128 || args.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 8192)) throw new Error('Invalid MCP arguments')
      if (typeof cwd !== 'string' || !cwd.trim() || cwd.includes('\0')) throw new Error('Invalid MCP cwd')
      transport = { type: 'stdio', command: t.command, args: args as string[], cwd, env_refs: refs(t.env_refs) }
    } else if (t.type === 'streamable-http') {
      keys(t, ['type', 'url', 'header_refs'])
      if (typeof t.url !== 'string') throw new Error('MCP URL is required')
      const url = new URL(t.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('MCP endpoint must be HTTP(S); credentials belong in header_refs')
      transport = { type: 'streamable-http', url: url.href, header_refs: refs(t.header_refs, true) }
    } else throw new Error('Unsupported MCP transport')
    const policies = entry.tool_policies ?? {}
    if (!object(policies) || Object.keys(policies).length > 2000) throw new Error('Invalid MCP tool policies')
    const tool_policies: Record<string, McpToolPolicy> = Object.create(null)
    for (const [name, policy] of Object.entries(policies)) {
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name) || !object(policy)) throw new Error('Invalid MCP tool policy')
      keys(policy, ['permissions', 'sideEffects', 'replay', 'verification_tool', 'verification_poll_ms', 'human_input'])
      if (!Array.isArray(policy.permissions) || !policy.permissions.every(p => typeof p === 'string' && p.trim())
        || !['none', 'workspace-write', 'external'].includes(String(policy.sideEffects)) || !['safe', 'confirm', 'never'].includes(String(policy.replay))) throw new Error('MCP tool policy needs explicit permissions, sideEffects and replay')
      if (policy.verification_tool !== undefined && (policy.sideEffects === 'none' || typeof policy.verification_tool !== 'string'
        || !/^[A-Za-z0-9_.-]{1,128}$/.test(policy.verification_tool))) throw new Error('MCP verification_tool must name a tool for a side-effecting operation')
      if (policy.verification_poll_ms !== undefined && (!policy.verification_tool || typeof policy.verification_poll_ms !== 'number'
        || !Number.isSafeInteger(policy.verification_poll_ms) || policy.verification_poll_ms < 1000 || policy.verification_poll_ms > 60000))
        throw new Error('MCP verification_poll_ms requires a verification_tool and an interval from 1000 to 60000 ms')
      const humanInput = policy.human_input
      if (humanInput !== undefined && (humanInput !== 'form' && humanInput !== 'url' && humanInput !== 'form_and_url' || (policy.sideEffects === 'none'
        ? policy.replay !== 'safe' || policy.permissions.some(permission => ['filesystem:write', 'filesystem:delete', 'process:execute'].includes(String(permission)))
        : policy.replay === 'safe' || !policy.verification_tool))) {
        throw new Error('MCP human_input requires form, url or form_and_url and a safe read policy or a write policy with a dedicated verifier and no automatic replay')
      }
      tool_policies[name] = { permissions: [...new Set(policy.permissions as string[])], sideEffects: policy.sideEffects as McpToolPolicy['sideEffects'], replay: policy.replay as McpToolPolicy['replay'],
        ...(typeof policy.verification_tool === 'string' ? { verification_tool: policy.verification_tool } : {}),
        ...(typeof policy.verification_poll_ms === 'number' ? { verification_poll_ms: policy.verification_poll_ms } : {}),
        ...(humanInput ? { human_input: humanInput } : {}) }
    }
    for (const policy of Object.values(tool_policies)) {
      if (!policy.verification_tool) continue
      const verifier = tool_policies[policy.verification_tool]
      if (!verifier || verifier.sideEffects !== 'none' || verifier.replay !== 'safe'
        || verifier.permissions.some(permission => ['filesystem:write', 'filesystem:delete', 'process:execute'].includes(permission)))
        throw new Error('MCP verification_tool requires an explicit read-only, safe host policy')
    }
    return { id: entry.id, enabled: entry.enabled, transport, timeout_ms: Number(timeout), tool_policies }
  })
}
