/** Synthetic HTTP-only order comparison. No ARE, Hooks, Judge or tool executor. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readJson } from '../src/phase0_run.mjs'
import { readModelConnection } from '../src/phase1_official.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const hash = value => createHash('sha256').update(value).digest('hex')
const SAFE_ERROR_TYPES = new Set(['invalid_request_error', 'authentication_error', 'permission_error', 'rate_limit_error', 'server_error', 'api_error'])
const SAFE_ERROR_CODES = new Set(['invalid_request_error', 'invalid_message_order', 'invalid_messages', 'invalid_tool_result', 'tool_call_mismatch',
  'missing_tool_result', 'invalid_parameter', 'invalid_value', 'unsupported_parameter', 'context_length_exceeded', 'invalid_api_key',
  'insufficient_quota', 'model_not_found', 'rate_limit_exceeded', 'server_error'])

export function parseTemporalWireProbeArgs(argv) {
  if (argv.length === 0) return { mode: 'describe' }
  if (argv.length === 1 && argv[0] === '--run') return { mode: 'run' }
  throw new Error('Usage: node scripts/temporal_provider_wire_probe.mjs [--run]; default describes only, --run performs exactly two synthetic HTTP requests')
}

export function buildTemporalWireRequests(model) {
  if (typeof model !== 'string' || !model) throw new Error('invalid_model_identity')
  const before = [
    { role: 'system', content: 'Synthetic message-order diagnostic only. No real tool has run and no tool may be executed. Reply with exactly OK.' },
    { role: 'user', content: 'Read the synthetic watch result and acknowledge it.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'probe_call_temporal_1', type: 'function', function: { name: 'diagnostic_wait_watch', arguments: '{}' } }] },
  ]
  const result = { role: 'tool', tool_call_id: 'probe_call_temporal_1', name: 'diagnostic_wait_watch', content: '{"signal":"candidate_changed","synthetic":true}' }
  const notices = [
    { role: 'user', content: '[Synthetic environment notification 1] An interval completed.' },
    { role: 'user', content: '[Synthetic environment notification 2] A candidate arrived.' },
  ]
  const common = { model, stream: false, max_tokens: 16, parallel_tool_calls: false, tool_choice: 'none',
    tools: [{ type: 'function', function: { name: 'diagnostic_wait_watch', description: 'Diagnostic schema only; no executor exists.',
      parameters: { type: 'object', properties: {}, additionalProperties: false } } }] }
  return [
    { case: 'correct_tool_result_first', body: { ...structuredClone(common), messages: [...structuredClone(before), structuredClone(result), ...structuredClone(notices)] } },
    { case: 'legacy_notifications_first', body: { ...structuredClone(common), messages: [...structuredClone(before), ...structuredClone(notices), structuredClone(result)] } },
  ]
}

export function safeTemporalWireError(text) {
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* Never return raw server text. */ }
  const error = parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error === 'object' ? parsed.error : parsed
  const type = SAFE_ERROR_TYPES.has(error?.type) ? error.type : 'unclassified'
  const code = SAFE_ERROR_CODES.has(error?.code) ? error.code : null
  const param = typeof error?.param === 'string' && /^(?:messages(?:\[\d+\]|\.\d+)?(?:\.(?:role|tool_calls|tool_call_id|content))?|tools|tool_choice|max_tokens|parallel_tool_calls|model)$/.test(error.param) ? error.param : null
  const mentionsToolPairing = typeof error?.message === 'string'
    && /tool[_ -]?call|tool[_ -]?result|messages? with (?:the )?role|must be followed|function response/i.test(error.message)
  return { errorType: type, errorCode: code, errorParam: param, mentionsToolPairing }
}

export async function executeTemporalWireComparison({ model, baseUrl, apiKey, timeoutMs = 60000, fetchImpl = globalThis.fetch, clock = Date.now } = {}) {
  if (typeof baseUrl !== 'string' || typeof apiKey !== 'string' || !apiKey || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error('invalid_probe_configuration')
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/chat/completions`)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid_probe_endpoint')
  const results = []
  for (const item of buildTemporalWireRequests(model)) {
    const body = JSON.stringify(item.body), started = clock(), controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url.href, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' }, body })
      // Response text is used in memory for fixed metadata only, never saved or returned.
      const text = await response.text()
      results.push({ case: item.case, requestBodySha256: hash(body), httpStatus: response.status,
        ok: response.ok, elapsedMs: Math.max(0, clock() - started), responseBytes: Buffer.byteLength(text),
        ...(response.ok ? {} : safeTemporalWireError(text)) })
    } catch (error) {
      const errorType = ['AbortError', 'TimeoutError', 'TypeError'].includes(error?.name) ? error.name : 'Error'
      results.push({ case: item.case, requestBodySha256: hash(body), httpStatus: null, ok: false,
        elapsedMs: Math.max(0, clock() - started), errorType, errorCode: null, errorParam: null, mentionsToolPairing: false })
    } finally { clearTimeout(timer) }
  }
  const [correct, legacy] = results
  const comparison = correct.ok && legacy.httpStatus === 400 ? 'legacy_order_rejected_correct_order_accepted'
    : correct.ok && legacy.ok ? 'ordering_rejection_not_reproduced' : 'inconclusive'
  return { schemaVersion: 'gaia2-temporal-provider-wire-probe-v1', model, status: comparison,
    generatedAt: new Date().toISOString(), requestsAttempted: results.length, automaticRetries: 0,
    syntheticWireOnly: true, benchmarkExecuted: false, toolsExecuted: 0, judgeRequests: 0,
    keyRecorded: false, endpointRecorded: false, rawResponseRecorded: false, results }
}

export async function runTemporalProviderWireProbe({ root = ROOT, fetchImpl = globalThis.fetch, connectionLoader = readModelConnection } = {}) {
  root = resolve(root)
  const protocol = readJson(join(root, 'config/phase0-protocol.json'))
  const connection = connectionLoader(root, protocol.models)
  const report = await executeTemporalWireComparison({ model: protocol.models.actor.model, baseUrl: connection.baseUrl,
    apiKey: connection.apiKey, timeoutMs: 60000, fetchImpl })
  const runId = `temporal-provider-wire-probe-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`
  const directory = join(root, 'runs', runId)
  mkdirSync(directory, { recursive: false })
  const reportPath = join(directory, 'report.json')
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  return { ...report, reportPath: reportPath.replaceAll('\\', '/') }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = parseTemporalWireProbeArgs(process.argv.slice(2))
    if (args.mode === 'describe') console.log(JSON.stringify({ status: 'not_executed', command: 'node scripts/temporal_provider_wire_probe.mjs --run',
      plannedRequests: 2, syntheticWireOnly: true, benchmarkExecuted: false, toolsExecuted: 0, credentialRead: false }))
    else {
      const report = await runTemporalProviderWireProbe()
      console.log(JSON.stringify(report))
      if (report.status === 'inconclusive') process.exitCode = 2
    }
  } catch { console.error(JSON.stringify({ status: 'probe_setup_failed', keyRecorded: false, endpointRecorded: false, rawResponseRecorded: false })); process.exitCode = 2 }
}
