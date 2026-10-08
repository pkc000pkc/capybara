const TIMEOUT_MS = 8000 * 60 * 1000
const ENTRYPOINTS = new Set(['e2e', 'all', 'batch', 'pilot'])

function number(value, name, { zero = false, integer = false } = {}) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))) throw new Error(`${name} must be a strict numeric value`)
  const result = Number(value)
  if (!Number.isFinite(result) || result > Number.MAX_SAFE_INTEGER || (zero ? result < 0 : result <= 0) || (integer && !Number.isInteger(result))) throw new Error(`${name} must be ${zero ? 'non-negative' : 'positive'}${integer ? ' integer' : ''}`)
  return result
}

function first(env, names, fallback, options) {
  let result
  for (const name of names) {
    if (env[name] === undefined) continue
    const parsed = number(env[name], name, options)
    if (result === undefined) result = parsed
  }
  return result === undefined ? fallback : result
}

function boolean(env, names, fallback) {
  let result
  for (const name of names) {
    if (env[name] === undefined) continue
    if (!['0', '1', 0, 1].includes(env[name])) throw new Error(`${name} must be 0 or 1`)
    if (result === undefined) result = String(env[name]) === '1'
  }
  return result === undefined ? fallback : result
}

// A process ceiling and the ARE scenario wall-clock ceiling are independent. In
// particular processTimeoutMs=0 never turns a scenario timeout into zero.
export function resolveRuntimeSettings({ protocol = {}, entrypoint = 'e2e', env = process.env } = {}) {
  if (!ENTRYPOINTS.has(entrypoint)) throw new Error(`unknown runtime entrypoint: ${entrypoint}`)
  const requested = protocol.requestedRuntime ?? protocol
  const defaultProcessMs = requested.processTimeoutMs !== undefined
    ? number(requested.processTimeoutMs, 'processTimeoutMs', { zero: true, integer: true })
    : requested.processTimeoutMinutes !== undefined
      ? number(requested.processTimeoutMinutes, 'processTimeoutMinutes', { zero: true }) * 60000
      : TIMEOUT_MS
  const legacyMs = {
    e2e: ['GAIA2_E2E_PROCESS_TIMEOUT_MS'],
    all: ['GAIA2_E2E_ALL_TIMEOUT_MS', 'GAIA2_E2E_PROCESS_TIMEOUT_MS'],
    batch: ['GAIA2_BATCH_PROCESS_TIMEOUT_MS'],
    pilot: ['GAIA2_PILOT_PROCESS_TIMEOUT_MS'],
  }[entrypoint]
  const legacyMinutes = entrypoint === 'batch'
    ? ['GAIA2_BATCH_PROCESS_TIMEOUT_MINUTES', 'GAIA2_BATCH_TIMEOUT_MINUTES'] : []
  const legacyProcessMinutes = first(env, legacyMinutes, undefined, { zero: true })
  const legacyProcessMs = first(env, legacyMs, legacyProcessMinutes === undefined ? defaultProcessMs : legacyProcessMinutes * 60000, { zero: true, integer: true })
  const processMinutes = first(env, ['GAIA2_PROCESS_TIMEOUT_MINUTES'], undefined, { zero: true })
  const processTimeoutMs = first(env, ['GAIA2_PROCESS_TIMEOUT_MS'], processMinutes === undefined ? legacyProcessMs : processMinutes * 60000, { zero: true, integer: true })
  number(processTimeoutMs, 'effective processTimeoutMs', { zero: true, integer: true })
  const scenarioDefault = number(requested.scenarioTimeoutSeconds ?? 480000, 'scenarioTimeoutSeconds')
  const modelDefault = number(requested.modelRequestTimeoutSeconds ?? 60, 'modelRequestTimeoutSeconds')
  const scenarioTimeoutSeconds = first(env, ['GAIA2_SCENARIO_TIMEOUT_SECONDS', 'GAIA2_E2E_TIMEOUT_SECONDS'], scenarioDefault)
  const modelRequestTimeoutSeconds = first(env, ['GAIA2_MODEL_REQUEST_TIMEOUT_SECONDS', 'GAIA2_E2E_LLM_TIMEOUT_SECONDS'], modelDefault)
  const concurrency = first(env, ['GAIA2_CONCURRENCY'], number(requested.concurrency ?? 1, 'concurrency', { integer: true }), { integer: true })
  if (concurrency !== 1) throw new Error('Stage 1 requires concurrency=1')
  const minimal = boolean(env, ['GAIA2_MINIMAL', 'GAIA2_E2E_MINIMAL'], false)
  const defaultActions = minimal ? 1 : 300
  const maxActions = first(env, ['GAIA2_MAX_ACTIONS', 'GAIA2_E2E_MAX_ACTIONS'], defaultActions, { integer: true })
  const heartbeatIntervalMs = first(env, ['GAIA2_HEARTBEAT_INTERVAL_MS'], 1000, { integer: true })
  return { processTimeoutMs, scenarioTimeoutSeconds, modelRequestTimeoutSeconds, concurrency, maxActions, minimal, heartbeatIntervalMs }
}
