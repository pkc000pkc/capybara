export type SessionChoice = { id: string }

export function chooseRestoredSessionId<T extends SessionChoice>(sessions: T[], requestedId?: string, rememberedId?: string): string | undefined {
  const valid = new Set(sessions.map((item) => item.id))
  for (const candidate of [requestedId, rememberedId]) {
    if (candidate && valid.has(candidate)) return candidate
  }
  return sessions.find((item) => !item.id.startsWith('local-session:'))?.id
}

export function knownSessionId<T extends SessionChoice>(sessions: T[], candidate?: string): string | undefined {
  if (candidate && sessions.some((item) => item.id === candidate && !candidate.startsWith('local-session:'))) return candidate
  return sessions.find((item) => !item.id.startsWith('local-session:'))?.id
}
