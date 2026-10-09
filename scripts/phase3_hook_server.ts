import { createServer } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// This process receives only actor-visible data and a session-scoped capability.
// It uses the currently bound backend implementation, never another workspace's host.
const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--spec') throw new Error('hook host spec required')
const spec = JSON.parse(readFileSync(resolve(args[1]), 'utf8'))
const token = process.env.GAIA2_HOOK_TOKEN
if (!token || token.length < 32) throw new Error('session capability missing')
const expectedAuth = createHash('sha256').update(`Bearer ${token}`).digest()
const { RuntimePluginHost } = await import(pathToFileURL(join(spec.backendRoot, 'src/core/plugins/runtime-plugin-host.ts')).href)
const entry = spec.entry
if (entry !== undefined) {
  if (!entry || entry.schemaVersion !== 'gaia2-official-entry-handshake-v1'
    || typeof entry.path !== 'string' || !entry.path || typeof entry.relativePath !== 'string' || !entry.relativePath
    || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)
    || !entry.value || entry.value.schemaVersion !== entry.schemaVersion
    || entry.value.executionId !== spec.options.executionId || entry.value.sessionId !== spec.options.sessionId
    || entry.value.scenarioId !== spec.options.scenarioId) throw new Error('official entry handshake invalid')
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
let closing = false
const server = createServer(async (req, res) => {
  const reply = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }
  const supplied = createHash('sha256').update(req.headers.authorization ?? '').digest()
  if (!timingSafeEqual(supplied, expectedAuth)) { reply(403, { error: 'invalid_session_capability' }); return }
  if (req.method !== 'POST' || !['/invoke', '/shutdown'].includes(req.url ?? '')) { reply(404, { error: 'unknown_operation' }); return }
  let length = 0
  const chunks: Buffer[] = []
  try {
    for await (const chunk of req) {
      length += chunk.length
      if (length > 4 * 1024 * 1024) throw new Error('request_size_exceeded')
      chunks.push(Buffer.from(chunk))
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (input.executionId !== spec.options.executionId || input.sessionId !== spec.options.sessionId) { reply(409, { error: 'foreign_session' }); return }
    if (req.url === '/shutdown') {
      if (closing) { reply(409, { error: 'already_closing' }); return }
      closing = true
      await host.close()
      reply(200, { status: 'closed' })
      server.close()
      return
    }
    if (closing) { reply(409, { error: 'host_closing' }); return }
    // Session identity authenticates the envelope, not the plugin invocation.
    // The backend deliberately rejects undeclared hook input fields.
    const { executionId, sessionId, ...invocation } = input
    reply(200, await host.invoke(invocation))
  } catch { reply(422, { error: 'hook_host_rejected' }) }
})
await new Promise<void>(resolveReady => server.listen(0, '127.0.0.1', resolveReady))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('loopback address missing')
if (existsSync(spec.readyPath)) throw new Error('host ready receipt already exists')
const readyTemporary = `${spec.readyPath}.${process.pid}.tmp`
writeFileSync(readyTemporary, JSON.stringify({ schemaVersion: 'gaia2-hook-host-ready-v1', endpoint: `http://127.0.0.1:${address.port}/invoke`, processId: process.pid, initialization, initializationHash: createHash('sha256').update(JSON.stringify(initialization)).digest('hex'), ...(entry ? { entry: { schemaVersion: entry.schemaVersion, path: entry.path, relativePath: entry.relativePath, sha256: entry.sha256 } } : {}) }) + '\n', { flag: 'wx' })
renameSync(readyTemporary, spec.readyPath)
console.log(JSON.stringify({ status: 'ready', executionId: spec.options.executionId, sessionId: spec.options.sessionId, pluginCount: spec.options.plugins.length }))
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => { if (!closing) { closing = true; await host.close(); server.close() } })
