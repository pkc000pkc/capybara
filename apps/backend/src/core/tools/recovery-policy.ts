function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .filter(([key]) => !['max_chars', 'link_limit', 'ocr_screenshot'].includes(key))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/** Optional project-owned runtime_recovery variable, written by a runtime Hook. */
export function blockedToolRequest(state: unknown, runId: string, name: string, args: unknown, time = Date.now()): string | undefined {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return undefined
  const policy = state as Record<string, unknown>
  if (policy.run_id !== runId || !Array.isArray(policy.blocked_requests)) return undefined
  const fingerprint = canonical(args)
  for (const entry of policy.blocked_requests.slice(-256)) {
    if (!entry || entry.tool !== name || typeof entry.reason !== 'string') continue
    if (entry.until !== null && (!Number.isFinite(entry.until) || entry.until <= time)) continue
    if (entry.match && typeof entry.match === 'object' && !Array.isArray(entry.match)
      && Object.keys(entry.match).length && args && typeof args === 'object'
      && Object.entries(entry.match).every(([key, value]) => canonical((args as Record<string, unknown>)[key]) === canonical(value))) return entry.reason.slice(0, 1000)
    if (canonical(entry.arguments) === fingerprint) return entry.reason.slice(0, 1000)
  }
  return undefined
}
