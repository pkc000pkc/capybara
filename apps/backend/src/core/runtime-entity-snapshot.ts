import { createHash } from 'node:crypto'

import type { JsonObject, JsonValue, RuntimeEntitySnapshot } from '#protocol/runtime-protocol'

const RECORD_ARRAY_KEYS = ['items', 'data', 'results', 'records', 'entities'] as const
const ENTITY_ID_KEYS = ['id', 'uuid', 'entity_id'] as const

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordCandidates(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.filter(isJsonObject)
  if (!isJsonObject(value)) return []
  for (const key of RECORD_ARRAY_KEYS) {
    const nested = value[key]
    if (Array.isArray(nested)) return nested.filter(isJsonObject)
  }
  return [value]
}

function entityId(record: JsonObject): string | undefined {
  for (const key of ENTITY_ID_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  const suffixed = Object.keys(record).find(key => key.endsWith('_id'))
  const value = suffixed === undefined ? undefined : record[suffixed]
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function stableHash(value: JsonValue): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * Derive a small, deterministic index from a structured tool result.
 * The original Result Artifact remains authoritative and is never replaced.
 */
export function extractRuntimeEntitySnapshots(
  value: unknown,
  sourceArtifactId: string,
  capturedAt: string,
  toolName: string,
): RuntimeEntitySnapshot[] {
  const snapshots: RuntimeEntitySnapshot[] = []
  for (const record of recordCandidates(value)) {
    const id = entityId(record)
    if (!id) continue
    const type = typeof record.type === 'string' && record.type.trim()
      ? record.type.trim()
      : typeof record.kind === 'string' && record.kind.trim()
        ? record.kind.trim()
        : toolName
    const fields = structuredClone(record)
    snapshots.push({
      entityType: type,
      entityId: id,
      fields,
      sourceArtifactId,
      capturedAt,
      hash: stableHash(fields),
    })
  }
  return snapshots
}
