import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const configPath = join(root, 'gaia2-model-config.json')
const datasetManifestPath = join(root, 'data', 'manifest.json')
if (!existsSync(configPath)) throw new Error('gaia2-model-config.json is missing')
if (!existsSync(datasetManifestPath)) throw new Error('data/manifest.json is missing; run npm run download first')

const modelConfig = JSON.parse(readFileSync(configPath, 'utf8'))
const sourcePath = modelConfig.apiKeySource
const sourceLines = readFileSync(sourcePath, 'utf8').split(/\r?\n/)
const baseUrl = sourceLines.find((line) => /^base_url\s*:/i.test(line))?.replace(/^base_url\s*:\s*/i, '').trim()
const apiKey = sourceLines.find((line) => /^key\s*[:=]/i.test(line))?.replace(/^key\s*[:=]\s*/i, '').trim()
if (!baseUrl || !apiKey) throw new Error('llm-config.txt must provide base_url and key')

const manifest = JSON.parse(readFileSync(datasetManifestPath, 'utf8'))
const timeoutMs = Number(process.env.GAIA2_MODEL_TIMEOUT_MS || 30000)
const maxAttempts = Math.max(1, Number(process.env.GAIA2_MODEL_MAX_ATTEMPTS || 3))
const retryBaseMs = Math.max(100, Number(process.env.GAIA2_MODEL_RETRY_BASE_MS || 1000))
const runs = []

function extractUserPrompt(scenario) {
  const events = Array.isArray(scenario.events) ? scenario.events : Object.values(scenario.events || {})
  const userEvent = events.find((event) => event.event_type === 'USER')
  const content = userEvent?.action?.args?.find((arg) => arg.name === 'content')?.value
  if (typeof content !== 'string' || !content.trim()) throw new Error('scenario has no USER content')
  return content.trim()
}

function errorSummary(errorBody) {
  if (!errorBody || typeof errorBody !== 'object') return undefined
  const error = errorBody.error
  if (typeof error === 'string') return error.slice(0, 240)
  if (error && typeof error === 'object') {
    return [error.type, error.code, error.message].filter(Boolean).join(': ').slice(0, 240)
  }
  return undefined
}

function isRetryable(status, summary) {
  return [408, 429, 500, 502, 503, 504].includes(status) || /overload|temporar|unavailable|rate.?limit/i.test(summary || '')
}

for (const file of manifest.files) {
  const parquetFile = await asyncBufferFromFile(file.path)
  const [row] = await parquetReadObjects({ file: parquetFile, rowStart: 0, rowEnd: 1, compressors })
  const scenario = JSON.parse(row.scenario)
  const prompt = extractUserPrompt(scenario)
  const requestText = [
    'You are being smoke-tested for one GAIA2 scenario.',
    'Do not claim that tools or apps were executed. Return a concise plan for how an agent would handle the request, including any clarification needed.',
    `Capability: ${file.name}`,
    `User request:\n${prompt}`,
  ].join('\n\n')
  const startedAt = Date.now()
  const attempts = []
  let result
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: modelConfig.model,
          messages: [{ role: 'user', content: requestText }],
          max_tokens: 256,
          temperature: 0,
        }),
        signal: controller.signal,
      })
      const raw = await response.text()
      let body
      try { body = JSON.parse(raw) } catch { body = undefined }
      const summary = errorSummary(body)
      const text = body?.choices?.[0]?.message?.content
      attempts.push({ attempt, httpStatus: response.status, error: summary })
      result = {
        capability: file.name,
        scenarioId: row.scenario_id,
        status: response.ok && typeof text === 'string' ? 'model_response' : 'request_failed',
        httpStatus: response.status,
        elapsedMs: Date.now() - startedAt,
        attempts,
        responseChars: typeof text === 'string' ? text.length : 0,
        responseHash: typeof text === 'string' ? createHash('sha256').update(text).digest('hex') : undefined,
        error: summary,
      }
      if (result.status === 'model_response' || !isRetryable(response.status, summary) || attempt === maxAttempts) break
    } catch (error) {
      const summary = String(error?.message || error).slice(0, 240)
      attempts.push({ attempt, error: summary })
      result = {
        capability: file.name,
        scenarioId: row.scenario_id,
        status: error?.name === 'AbortError' ? 'timeout' : 'transport_error',
        elapsedMs: Date.now() - startedAt,
        attempts,
        error: summary,
      }
      if (attempt === maxAttempts) break
    } finally {
      clearTimeout(timer)
    }
    await new Promise((resolve) => setTimeout(resolve, retryBaseMs * (2 ** (attempt - 1))))
  }
  runs.push(result)
}

const report = {
  status: runs.every((run) => run.status === 'model_response') ? 'passed' : 'blocked',
  mode: 'real-model-transport-smoke',
  model: modelConfig.model,
  protocol: 'chat-completions-adapter',
  sourceProtocol: 'responses',
  baseUrl,
  dataset: manifest.dataset,
  revision: manifest.revision,
  oneRequestPerCapability: true,
  maxAttempts,
  retryPolicy: 'exponential-backoff-on-transient-http-or-overload-errors',
  runs,
  note: 'This smoke sends the real user request to the configured model endpoint but does not execute ARE app tools or produce a benchmark score.',
  generatedAt: new Date().toISOString(),
}
const reportDir = join(root, 'reports')
mkdirSync(reportDir, { recursive: true })
writeFileSync(join(reportDir, 'gaia2-real-model-smoke.json'), `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (report.status !== 'passed') process.exitCode = 2
