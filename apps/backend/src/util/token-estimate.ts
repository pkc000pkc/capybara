export function estimateTokens(value: unknown): number {
  const source = typeof value === 'string' ? value : JSON.stringify(value)
  return Math.max(1, Math.ceil((source?.length ?? 0) / 4))
}
