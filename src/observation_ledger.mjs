import { createHash } from 'node:crypto'

const STATUSES = new Set(['observed', 'duplicate', 'incomplete', 'stale', 'conflicting', 'failed'])

function clone(value) {
  return structuredClone(value)
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function hash(value) {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Append-only observation ledger for the legacy/pass@5 runtime.
 *
 * This compatibility ledger intentionally permits an observation whose
 * caller omitted `complete`; it classifies explicit truncation/preview/empty
 * data as incomplete. The official GAIA2 Host/Hook path has a stricter
 * contract: native success counts and evidence require `complete === true`.
 * Keep those protocols separate rather than silently changing this legacy
 * API's meaning. This class never decides task truth; it only records
 * provenance and uncertainty.
 */
export class ObservationLedger {
  #records = []
  #byFingerprint = new Map()
  #byConflictKey = new Map()

  constructor({ now = 0, staleAfterMs = null, maxRecords = 512 } = {}) {
    if (!Number.isFinite(now)) throw new Error('now must be finite')
    if (staleAfterMs !== null && (!Number.isFinite(staleAfterMs) || staleAfterMs < 0)) {
      throw new Error('staleAfterMs must be null or a non-negative number')
    }
    this.now = now
    this.staleAfterMs = staleAfterMs
    this.maxRecords = Math.max(1, Math.floor(maxRecords))
  }

  observe(input = {}) {
    const source = text(input.source) || 'unknown'
    const kind = text(input.kind) || 'tool'
    const subject = text(input.subject || input.conflictKey || input.id) || null
    const content = input.content ?? input.value ?? null
    const fingerprint = text(input.fingerprint) || hash({ kind, source, subject, content })
    const provenance = {
      source,
      sourceTimestamp: Number.isFinite(input.sourceTimestamp) ? input.sourceTimestamp : null,
      observedAt: Number.isFinite(input.observedAt) ? input.observedAt : this.now,
      requestId: text(input.requestId) || null,
      eventId: text(input.eventId) || null,
    }
    const prior = this.#byFingerprint.get(fingerprint)
    if (prior) {
      const duplicate = {
        ...clone(prior),
        status: 'duplicate',
        duplicateOf: prior.observationId,
        observationId: `${prior.observationId}:duplicate:${this.#records.length + 1}`,
      }
      this.#append(duplicate)
      return clone(duplicate)
    }

    let status = 'observed'
    const reasons = []
    const isEmpty = content === null || content === undefined
      || (typeof content === 'string' && content.trim().length === 0)
      || (Array.isArray(content) && content.length === 0)
    if (input.complete === false || input.truncated === true || input.preview === true || isEmpty) {
      status = 'incomplete'
      reasons.push(input.complete === false ? 'explicitly_incomplete' : 'empty_or_preview')
    }
    if (this.staleAfterMs !== null && provenance.sourceTimestamp !== null
      && this.now - provenance.sourceTimestamp > this.staleAfterMs) {
      status = 'stale'
      reasons.push('source_timestamp_expired')
    }
    if (input.failed === true || input.error) {
      status = 'failed'
      reasons.push(text(input.error) || 'observation_failed')
    }

    const record = {
      observationId: `${kind}-${this.#records.length + 1}`,
      kind,
      subject,
      content: clone(content),
      status,
      reasons,
      fingerprint,
      provenance,
      conflictKey: text(input.conflictKey) || subject,
    }
    const conflictKey = record.conflictKey
    if (conflictKey) {
      const siblings = this.#byConflictKey.get(conflictKey) ?? []
      const conflicting = siblings.find((item) => item.fingerprint !== fingerprint
        && item.status !== 'duplicate' && item.status !== 'failed')
      if (conflicting) {
        record.status = 'conflicting'
        record.reasons = [...new Set([...record.reasons, 'different_observation_for_same_subject'])]
        record.conflictsWith = [conflicting.observationId]
        conflicting.status = 'conflicting'
        conflicting.reasons = [...new Set([...conflicting.reasons, 'different_observation_for_same_subject'])]
        conflicting.conflictsWith = [...new Set([...(conflicting.conflictsWith ?? []), record.observationId])]
      }
      siblings.push(record)
      this.#byConflictKey.set(conflictKey, siblings)
    }
    this.#byFingerprint.set(fingerprint, record)
    this.#append(record)
    return clone(record)
  }

  setNow(now) {
    if (!Number.isFinite(now)) throw new Error('now must be finite')
    this.now = now
    return this.refreshStaleness()
  }

  refreshStaleness() {
    if (this.staleAfterMs === null) return []
    const changed = []
    for (const record of this.#records) {
      if (record.status === 'duplicate' || record.status === 'failed' || record.provenance.sourceTimestamp === null) continue
      if (this.now - record.provenance.sourceTimestamp > this.staleAfterMs && !['stale', 'conflicting'].includes(record.status)) {
        record.status = 'stale'
        record.reasons = [...new Set([...record.reasons, 'source_timestamp_expired'])]
        changed.push(clone(record))
      }
    }
    return changed
  }

  unresolved({ subject = null, affectsMutation = false } = {}) {
    const latestResolved = new Set()
    for (const record of this.#records) {
      if (record.status === 'observed' && record.subject) latestResolved.add(record.subject)
    }
    return this.#records.filter((record) => ['incomplete', 'stale', 'conflicting', 'failed'].includes(record.status)
      && !(record.subject && latestResolved.has(record.subject))
      && (!subject || record.subject === subject || record.conflictKey === subject)
      && (!affectsMutation || ['incomplete', 'stale', 'conflicting'].includes(record.status))).map(clone)
  }

  summary({ limit = 12 } = {}) {
    const recent = this.#records.slice(-Math.max(0, Math.floor(limit)))
    return recent.map((record) => ({
      observationId: record.observationId,
      kind: record.kind,
      subject: record.subject,
      status: record.status,
      reasons: record.reasons,
      source: record.provenance.source,
      sourceTimestamp: record.provenance.sourceTimestamp,
      fingerprint: record.fingerprint,
    }))
  }

  snapshot() {
    return {
      now: this.now,
      staleAfterMs: this.staleAfterMs,
      maxRecords: this.maxRecords,
      records: clone(this.#records),
    }
  }

  restore(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.records)) throw new Error('invalid observation ledger checkpoint')
    this.now = snapshot.now ?? 0
    this.staleAfterMs = snapshot.staleAfterMs ?? null
    this.maxRecords = snapshot.maxRecords ?? 512
    this.#records = []
    this.#byFingerprint.clear()
    this.#byConflictKey.clear()
    for (const record of snapshot.records) {
      if (!record || !record.observationId || !STATUSES.has(record.status)) throw new Error('invalid observation record')
      const copied = clone(record)
      this.#records.push(copied)
      if (copied.status !== 'duplicate') this.#byFingerprint.set(copied.fingerprint, copied)
      if (copied.conflictKey) this.#byConflictKey.set(copied.conflictKey, [...(this.#byConflictKey.get(copied.conflictKey) ?? []), copied])
    }
  }

  #append(record) {
    this.#records.push(record)
    while (this.#records.length > this.maxRecords) {
      const removed = this.#records.shift()
      if (removed && this.#byFingerprint.get(removed.fingerprint)?.observationId === removed.observationId) this.#byFingerprint.delete(removed.fingerprint)
    }
  }
}

export function observationHash(value) {
  return hash(value)
}
