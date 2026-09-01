import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { enqueueProjectWrite } from '#core/project-write-queue'
import type { HookResearchEvent } from '#core/hooks/types'
import type { JsonValue } from '#protocol/runtime-protocol'

const GENESIS_HASH = '0'.repeat(64)
const MAX_EVENTS_PER_APPEND = 100
const MAX_APPEND_BYTES = 1024 * 1024
const LEDGER_LOCK_ATTEMPTS = 200
const LEDGER_LOCK_RETRY_MS = 50
const LEDGER_LOCK_STALE_MS = 60_000

export interface ResearchLedgerSource {
  hookId: string
  runId: string
  loopIteration: number
}

export interface ResearchLedgerEvent {
  sequence: number
  event_id: string
  event_type: string
  timestamp: string
  payload: JsonValue
  previous_hash: string
  event_hash: string
  idempotency_key: string
  source: {
    hook_id: string
    run_id: string
    loop_iteration: number
  }
}

export interface ResearchLedgerAppendResult {
  path: string
  head: string
  appended: ResearchLedgerEvent[]
  duplicates: ResearchLedgerEvent[]
  totalEvents: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertJsonValue(value: unknown, name: string): asserts value is JsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) return
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${name}[${index}]`))
    return
  }
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${name}.${key}`)
    return
  }
  throw new Error(`${name} must be finite JSON data`)
}

export function canonicalResearchJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalResearchJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalResearchJson(value[key] as JsonValue)}`
  )).join(',')}}`
}

function hashEvent(event: Omit<ResearchLedgerEvent, 'event_hash'>): string {
  return createHash('sha256').update(canonicalResearchJson(event as unknown as JsonValue)).digest('hex')
}

function validateProposal(value: unknown, index: number): HookResearchEvent {
  if (!isObject(value)) throw new Error(`researchEvents[${index}] must be an object`)
  if (typeof value.eventType !== 'string' || !/^[a-z][a-z0-9_.-]{0,99}$/.test(value.eventType)) {
    throw new Error(`researchEvents[${index}].eventType must be a lowercase event name`)
  }
  if (
    typeof value.idempotencyKey !== 'string'
    || value.idempotencyKey.length < 1
    || value.idempotencyKey.length > 240
  ) {
    throw new Error(`researchEvents[${index}].idempotencyKey must contain 1-240 characters`)
  }
  assertJsonValue(value.payload, `researchEvents[${index}].payload`)
  return {
    eventType: value.eventType,
    idempotencyKey: value.idempotencyKey,
    payload: value.payload,
  }
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function objectValue(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {}
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function verifyArtifactReference(projectDir: string, value: unknown, label: string): void {
  const artifact = objectValue(value)
  if (typeof artifact.path !== 'string' || typeof artifact.sha256 !== 'string') {
    throw new Error(`${label} must contain path and sha256`)
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error(`${label}.sha256 is invalid`)
  const target = path.resolve(projectDir, artifact.path)
  if (!inside(projectDir, target)) throw new Error(`${label}.path leaves the project workspace`)
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw new Error(`${label}.path was not found: ${artifact.path}`)
  }
  const actual = createHash('sha256').update(fs.readFileSync(target)).digest('hex')
  if (actual !== artifact.sha256) throw new Error(`${label} failed SHA-256 verification: ${artifact.path}`)
}

function verifyProofCertification(
  projectDir: string,
  payload: Record<string, unknown>,
  label: string,
  events: readonly ResearchLedgerEvent[],
): void {
  const verification = objectValue(payload.verification)
  const humanApproval = objectValue(verification.human_approval)
  if (typeof humanApproval.event_id === 'string' && typeof humanApproval.token === 'string') {
    const approval = events.find((event) => event.event_id === humanApproval.event_id)
    const tokenHash = createHash('sha256').update(humanApproval.token).digest('hex')
    if (
      approval?.event_type === 'human.approved'
      && approval.source.hook_id === 'human-review'
      && objectValue(approval.payload).token_sha256 === tokenHash
    ) return
    throw new Error(`${label}.verification.human_approval is not backed by a trusted approval event`)
  }

  const checker = objectValue(verification.checker)
  if (typeof checker.type !== 'string' || !checker.type.trim()) {
    throw new Error(`${label}.verification.checker.type is required`)
  }
  if (verification.exit_code !== 0) throw new Error(`${label}.verification.exit_code must be 0`)
  if (typeof checker.version !== 'string' || !checker.version.trim()) {
    throw new Error(`${label}.verification.checker.version is required`)
  }
  verifyArtifactReference(projectDir, checker.artifact, `${label}.verification.checker.artifact`)
  verifyArtifactReference(projectDir, verification.certificate, `${label}.verification.certificate`)
}

function validateResearchProposals(
  projectDir: string,
  proposals: readonly HookResearchEvent[],
  events: readonly ResearchLedgerEvent[],
): void {
  const byId = new Map(events.map((event) => [event.event_id, event]))
  const strongEvidenceTypes = new Set(['experiment.completed', 'experiment.rerun', 'record.corrected'])
  for (const [index, proposal] of proposals.entries()) {
    const payload = objectValue(proposal.payload)
    if (proposal.eventType === 'experience.accepted') {
      const evidenceIds = stringArray(payload.evidence_ids)
      const operationalFailure = payload.kind === 'operational' && payload.outcome === 'invalid'
      if (!operationalFailure && evidenceIds.length === 0) {
        throw new Error(`researchEvents[${index}] accepted experience must cite evidence IDs`)
      }
      const cited = evidenceIds.map((eventId) => {
        const event = byId.get(eventId)
        if (!event) throw new Error(`researchEvents[${index}] cites missing evidence event: ${eventId}`)
        return event
      })
      if (!operationalFailure && !cited.some((event) => strongEvidenceTypes.has(event.event_type))) {
        throw new Error(`researchEvents[${index}] cites no completed deterministic evidence event`)
      }
      const artifactEvents = cited.filter((event) => Array.isArray(objectValue(event.payload).artifacts))
      if (!operationalFailure && artifactEvents.length === 0) {
        throw new Error(`researchEvents[${index}] cites no artifact-bearing evidence event`)
      }
      for (const event of artifactEvents) {
        const artifacts = objectValue(event.payload).artifacts as unknown[]
        artifacts.forEach((artifact, artifactIndex) => verifyArtifactReference(
          projectDir,
          artifact,
          `${event.event_id}.payload.artifacts[${artifactIndex}]`,
        ))
      }
    }
    if (proposal.eventType === 'hypothesis.observed' && payload.proof_status === 'verified') {
      verifyProofCertification(projectDir, payload, `researchEvents[${index}].payload`, events)
    }
    if (
      proposal.eventType === 'experiment.observed'
      && payload.track === 'proof'
      && payload.outcome === 'verified'
    ) {
      verifyProofCertification(projectDir, payload, `researchEvents[${index}].payload`, events)
    }
  }
}

function parseLedger(file: string): ResearchLedgerEvent[] {
  if (!fs.existsSync(file)) return []
  const source = fs.readFileSync(file, 'utf8')
  const lines = source.split(/\r?\n/).filter((line) => line.trim())
  const events: ResearchLedgerEvent[] = []
  let previousHash = GENESIS_HASH
  for (const [index, line] of lines.entries()) {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new Error(`research ledger line ${index + 1} is not valid JSON`)
    }
    if (!isObject(value)) throw new Error(`research ledger line ${index + 1} must be an object`)
    assertJsonValue(value, `research ledger line ${index + 1}`)
    const event = value as unknown as ResearchLedgerEvent
    if (
      event.sequence !== index + 1
      || event.event_id !== `EV-${String(index + 1).padStart(12, '0')}`
      || typeof event.event_type !== 'string'
      || typeof event.timestamp !== 'string'
      || Number.isNaN(Date.parse(event.timestamp))
      || typeof event.idempotency_key !== 'string'
      || event.previous_hash !== previousHash
      || typeof event.event_hash !== 'string'
      || !/^[a-f0-9]{64}$/.test(event.event_hash)
      || !isObject(event.source)
      || typeof event.source.hook_id !== 'string'
      || typeof event.source.run_id !== 'string'
      || !Number.isInteger(event.source.loop_iteration)
    ) {
      throw new Error(`research ledger line ${index + 1} has an invalid schema or chain position`)
    }
    const { event_hash: _eventHash, ...material } = event
    const expectedHash = hashEvent(material)
    if (event.event_hash !== expectedHash) {
      throw new Error(`research ledger line ${index + 1} failed SHA-256 verification`)
    }
    previousHash = event.event_hash
    events.push(event)
  }
  return events
}

async function withResearchLedgerLock<T>(file: string, task: () => T | Promise<T>): Promise<T> {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lockFile = path.join(path.dirname(file), '.events.lock')
  let handle: fs.promises.FileHandle | undefined
  for (let attempt = 0; attempt < LEDGER_LOCK_ATTEMPTS; attempt += 1) {
    try {
      handle = await fs.promises.open(lockFile, 'wx')
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const metadata = await fs.promises.stat(lockFile)
        if (Date.now() - metadata.mtimeMs > LEDGER_LOCK_STALE_MS) {
          await fs.promises.rm(lockFile, { force: true })
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError
      }
      await new Promise((resolve) => setTimeout(resolve, LEDGER_LOCK_RETRY_MS))
    }
  }
  if (!handle) throw new Error('could not acquire the research ledger lock')
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }))
    return await task()
  } finally {
    await handle.close()
    await fs.promises.rm(lockFile, { force: true })
  }
}

function appendLedgerLines(file: string, events: readonly ResearchLedgerEvent[]): void {
  if (events.length === 0) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const handle = fs.openSync(file, 'a')
  try {
    fs.writeFileSync(handle, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8')
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
}

export function readResearchLedgerEvents(projectDir: string): ResearchLedgerEvent[] {
  const file = path.join(path.resolve(projectDir), 'research', 'events.jsonl')
  return parseLedger(file)
}

export function verifyResearchLedger(projectDir: string): ResearchLedgerAppendResult {
  const file = path.join(path.resolve(projectDir), 'research', 'events.jsonl')
  const events = parseLedger(file)
  return {
    path: 'research/events.jsonl',
    head: events.at(-1)?.event_hash ?? GENESIS_HASH,
    appended: [],
    duplicates: [],
    totalEvents: events.length,
  }
}

export function appendResearchEvents(
  projectDir: string,
  proposals: readonly HookResearchEvent[],
  source: ResearchLedgerSource,
): Promise<ResearchLedgerAppendResult> {
  if (!Array.isArray(proposals) || proposals.length < 1 || proposals.length > MAX_EVENTS_PER_APPEND) {
    throw new Error(`researchEvents must contain 1-${MAX_EVENTS_PER_APPEND} events`)
  }
  const validated = proposals.map(validateProposal)
  const bytes = Buffer.byteLength(canonicalResearchJson(validated as unknown as JsonValue))
  if (bytes > MAX_APPEND_BYTES) throw new Error(`researchEvents exceed ${MAX_APPEND_BYTES} bytes`)
  if (!source.hookId.trim() || !source.runId.trim() || !Number.isInteger(source.loopIteration) || source.loopIteration < 0) {
    throw new Error('research ledger source is invalid')
  }

  const root = path.resolve(projectDir)
  const file = path.join(root, 'research', 'events.jsonl')
  return enqueueProjectWrite(root, () => withResearchLedgerLock(file, () => {
    const events = parseLedger(file)
    validateResearchProposals(root, validated, events)
    const byIdempotencyKey = new Map(events.map((event) => [event.idempotency_key, event]))
    const appended: ResearchLedgerEvent[] = []
    const duplicates: ResearchLedgerEvent[] = []
    let previousHash = events.at(-1)?.event_hash ?? GENESIS_HASH

    for (const proposal of validated) {
      const existing = byIdempotencyKey.get(proposal.idempotencyKey)
      if (existing) {
        if (
          existing.event_type !== proposal.eventType
          || canonicalResearchJson(existing.payload) !== canonicalResearchJson(proposal.payload)
        ) {
          throw new Error(`research event idempotency collision: ${proposal.idempotencyKey}`)
        }
        duplicates.push(existing)
        continue
      }
      const sequence = events.length + appended.length + 1
      const material: Omit<ResearchLedgerEvent, 'event_hash'> = {
        sequence,
        event_id: `EV-${String(sequence).padStart(12, '0')}`,
        event_type: proposal.eventType,
        timestamp: new Date().toISOString(),
        payload: proposal.payload,
        previous_hash: previousHash,
        idempotency_key: proposal.idempotencyKey,
        source: {
          hook_id: source.hookId,
          run_id: source.runId,
          loop_iteration: source.loopIteration,
        },
      }
      const event: ResearchLedgerEvent = { ...material, event_hash: hashEvent(material) }
      appended.push(event)
      byIdempotencyKey.set(event.idempotency_key, event)
      previousHash = event.event_hash
    }

    appendLedgerLines(file, appended)
    return {
      path: 'research/events.jsonl',
      head: previousHash,
      appended,
      duplicates,
      totalEvents: events.length + appended.length,
    }
  }))
}
