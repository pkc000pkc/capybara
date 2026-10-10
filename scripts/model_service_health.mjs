import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson } from '../src/phase0_run.mjs'
import { readModelConnection } from '../src/phase1_official.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function parseArgs(argv) {
  const values = { timeoutMs: 60000 }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--timeout-ms' && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      const value = Number(argv[++index])
      if (!Number.isInteger(value) || value < 1000 || value > 2147483647) throw new Error('invalid --timeout-ms')
      values.timeoutMs = value
    } else if (flag !== '') {
      throw new Error('usage: model-health [--timeout-ms <milliseconds>]')
    }
  }
  return values
}

function endpoint(baseUrl, suffix) {
  return `${baseUrl.replace(/\/+$/, '')}/${suffix}`
}

function safeError(error) {
  const message = String(error?.message ?? error ?? 'unknown_error')
    .replace(/[A-Za-z0-9_\-]{20,}/g, '[redacted]')
    .slice(0, 240)
  return { errorType: error?.name ?? 'Error', error: message }
}

async function request({ url, method, headers, body, timeoutMs }) {
  const started = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal })
    const text = await response.text()
    return {
      httpStatus: response.status,
      ok: response.ok,
      elapsedMs: Date.now() - started,
      responseBytes: Buffer.byteLength(text),
    }
  } catch (error) {
    return { ok: false, elapsedMs: Date.now() - started, ...safeError(error) }
  } finally {
    clearTimeout(timeout)
  }
}

export async function checkModelService({ root: projectRoot = root, timeoutMs = 60000 } = {}) {
  const protocol = readJson(join(projectRoot, 'config/phase0-protocol.json'))
  const connection = readModelConnection(projectRoot, protocol.models)
  const actorModel = protocol.models.actor.model
  const headers = { authorization: `Bearer ${connection.apiKey}`, accept: 'application/json' }
  const models = await request({ url: endpoint(connection.baseUrl, 'models'), method: 'GET', headers, timeoutMs })
  const completion = await request({
    url: endpoint(connection.baseUrl, 'chat/completions'),
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ model: actorModel, messages: [{ role: 'user', content: 'Respond with exactly OK.' }], max_tokens: 8, temperature: 0, stream: false }),
    timeoutMs,
  })
  return {
    schemaVersion: 'gaia2-model-service-health-v1',
    status: models.ok && completion.ok ? 'healthy' : 'unavailable',
    model: actorModel,
    endpoint: connection.baseUrl,
    checks: { models, chatCompletions: completion },
    keyRecorded: false,
    benchmarkExecution: false,
    noBenchmarkExecution: true,
    generatedAt: new Date().toISOString(),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await checkModelService(parseArgs(process.argv.slice(2)))
    console.log(JSON.stringify(report, null, 2))
    if (report.status !== 'healthy') process.exitCode = 2
  } catch (error) {
    console.error(JSON.stringify({ schemaVersion: 'gaia2-model-service-health-v1', status: 'configuration_error', ...safeError(error), keyRecorded: false, benchmarkExecution: false, noBenchmarkExecution: true }, null, 2))
    process.exitCode = 2
  }
}
