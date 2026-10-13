import { checkModelService } from './model_service_health.mjs'

const DEFAULTS = Object.freeze({ checks: 3, intervalMs: 30000, timeoutMs: 60000, maxChecks: 12 })

function positiveInteger(value, name, { allowZero = false } = {}) {
  if (!/^\d+$/.test(String(value))) throw new Error(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed < 1)) throw new Error(`${name} is out of range`)
  return parsed
}

export function parseArgs(argv) {
  const values = { ...DEFAULTS }
  const flags = new Set(['--checks', '--interval-ms', '--timeout-ms', '--max-checks'])
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!flags.has(flag) || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('usage: model-stability-gate [--checks N] [--interval-ms N] [--timeout-ms N] [--max-checks N]')
    const value = argv[++index]
    if (flag === '--checks') values.checks = positiveInteger(value, 'checks')
    if (flag === '--interval-ms') values.intervalMs = positiveInteger(value, 'interval-ms', { allowZero: true })
    if (flag === '--timeout-ms') values.timeoutMs = positiveInteger(value, 'timeout-ms')
    if (flag === '--max-checks') values.maxChecks = positiveInteger(value, 'max-checks')
  }
  if (values.maxChecks < values.checks) throw new Error('max-checks must be greater than or equal to checks')
  return values
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function sampleOf(report, attempt) {
  return {
    attempt,
    status: report?.status ?? 'invalid',
    modelsHttpStatus: report?.checks?.models?.httpStatus ?? null,
    chatHttpStatus: report?.checks?.chatCompletions?.httpStatus ?? null,
    modelsOk: report?.checks?.models?.ok === true,
    chatOk: report?.checks?.chatCompletions?.ok === true,
    elapsedMs: report?.checks?.chatCompletions?.elapsedMs ?? null,
    generatedAt: report?.generatedAt ?? null,
  }
}

/**
 * Require consecutive healthy model-service samples before a run is resumed.
 * This is a gate only: it never starts an ARE or benchmark execution.
 */
export async function waitForStableModelService({
  checks = DEFAULTS.checks,
  intervalMs = DEFAULTS.intervalMs,
  timeoutMs = DEFAULTS.timeoutMs,
  maxChecks = DEFAULTS.maxChecks,
  check = checkModelService,
  sleep = delay,
  now = () => Date.now(),
} = {}) {
  checks = positiveInteger(checks, 'checks')
  intervalMs = positiveInteger(intervalMs, 'interval-ms', { allowZero: true })
  timeoutMs = positiveInteger(timeoutMs, 'timeout-ms')
  maxChecks = positiveInteger(maxChecks, 'max-checks')
  if (maxChecks < checks) throw new Error('max-checks must be greater than or equal to checks')

  const startedAtMs = now()
  const samples = []
  let consecutiveHealthy = 0
  for (let attempt = 1; attempt <= maxChecks; attempt += 1) {
    const report = await check({ timeoutMs })
    const sample = sampleOf(report, attempt)
    samples.push(sample)
    if (report?.status === 'healthy') consecutiveHealthy += 1
    else consecutiveHealthy = 0
    if (consecutiveHealthy >= checks) {
      return {
        schemaVersion: 'gaia2-model-service-stability-v1',
        status: 'stable',
        requiredChecks: checks,
        consecutiveHealthy,
        attempts: attempt,
        elapsedMs: now() - startedAtMs,
        samples,
        noBenchmarkExecution: true,
        generatedAt: new Date().toISOString(),
      }
    }
    if (attempt < maxChecks) await sleep(intervalMs)
  }
  return {
    schemaVersion: 'gaia2-model-service-stability-v1',
    status: 'unstable',
    requiredChecks: checks,
    consecutiveHealthy,
    attempts: samples.length,
    elapsedMs: now() - startedAtMs,
    samples,
    noBenchmarkExecution: true,
    generatedAt: new Date().toISOString(),
  }
}

if (process.argv[1] && process.argv[1].endsWith('model_service_stability_gate.mjs')) {
  try {
    const report = await waitForStableModelService(parseArgs(process.argv.slice(2)))
    console.log(JSON.stringify(report, null, 2))
    if (report.status !== 'stable') process.exitCode = 2
  } catch (error) {
    console.error(JSON.stringify({ schemaVersion: 'gaia2-model-service-stability-v1', status: 'configuration_error', errorType: error?.name ?? 'Error', error: String(error?.message ?? error).slice(0, 240), noBenchmarkExecution: true }, null, 2))
    process.exitCode = 2
  }
}
