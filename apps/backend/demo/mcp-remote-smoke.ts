import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { McpClientManager } from '#core/mcp/client-manager'
import { validateMcpServers } from '#core/mcp/config'
import { configureProxyPreferences } from '#util/llm/proxy'

const endpoint = process.argv[2] ?? 'https://mcp.deepwiki.com/mcp'
const proxy = process.env.CAPYBARA_MCP_PROXY ?? ''
configureProxyPreferences(() => ({ proxy: { enabled: Boolean(proxy), url: proxy } } as any))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-remote-mcp-'))
const manager = new McpClientManager(root)
const configs = validateMcpServers([{ id: 'remote', enabled: true, transport: { type: 'streamable-http', url: endpoint, header_refs: {} }, timeout_ms: 30000, tool_policies: {} }])

try {
  await manager.prepare(configs)
  console.log(JSON.stringify({ endpoint, snapshot: manager.snapshot(), toolCount: manager.definitions().length,
    tools: manager.definitions().map(tool => tool.name) }, null, 2))
} finally {
  await manager.close()
  fs.rmSync(root, { recursive: true, force: true })
}
