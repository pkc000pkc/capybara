export interface ToolNetworkRetrySettings {
  max_retries: number
  initial_delay_ms: number
  max_delay_ms: number
  request_timeout_ms: number
}

export const DEFAULT_TOOL_NETWORK_RETRY: ToolNetworkRetrySettings = {
  max_retries: 10,
  initial_delay_ms: 1000,
  max_delay_ms: 30000,
  request_timeout_ms: 30000,
}

export function toolNetworkRetrySettings(value: unknown): ToolNetworkRetrySettings {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('tool_network_retry must be an object')
  }
  const settings = { ...DEFAULT_TOOL_NETWORK_RETRY, ...value as Partial<ToolNetworkRetrySettings> }
  for (const [key, number] of Object.entries(settings)) {
    if (!(key in DEFAULT_TOOL_NETWORK_RETRY) || !Number.isSafeInteger(number)
      || (key === 'max_retries' ? number < -1 : number < 1 || number > 600000)) {
      throw new Error(`invalid tool_network_retry.${key}`)
    }
  }
  if (settings.initial_delay_ms > settings.max_delay_ms) throw new Error('tool_network_retry initial delay exceeds maximum delay')
  return settings
}

export interface ToolProgress {
  phase: 'waiting' | 'attempting' | 'completed' | 'failed'
  attempt: number
  maxAttempts: number
  delayMs: number
  reason: string
  elapsedMs?: number
}

export const TOOL_PROGRESS_PREFIX = 'CAPYBARA_TOOL_PROGRESS '

export function parseToolProgress(line: string): ToolProgress | undefined {
  if (!line.startsWith(TOOL_PROGRESS_PREFIX) || line.length > 8192) return undefined
  try {
    const value = JSON.parse(line.slice(TOOL_PROGRESS_PREFIX.length))
    if (!['waiting', 'attempting', 'completed', 'failed'].includes(value.phase)
      || !Number.isInteger(value.attempt) || value.attempt < 1
      || !Number.isInteger(value.maxAttempts) || (value.maxAttempts !== -1 && value.maxAttempts < 1)
      || !Number.isFinite(value.delayMs) || value.delayMs < 0 || typeof value.reason !== 'string') return undefined
    return { phase: value.phase, attempt: value.attempt, maxAttempts: value.maxAttempts,
      delayMs: value.delayMs, reason: value.reason.slice(0, 500),
      ...(Number.isFinite(value.elapsedMs) ? { elapsedMs: value.elapsedMs } : {}) }
  } catch { return undefined }
}
