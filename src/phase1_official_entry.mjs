import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { digest, fileDigest, within } from './phase0_run.mjs'

/**
 * Immutable hand-off between the Node manifest runner and the official ARE
 * child.  This is a run identity receipt, not an A2A permission or a model
 * input.  The child must prove that it read these exact bytes before any
 * production-like delegation is admitted.
 */
export const OFFICIAL_ENTRY_SCHEMA = 'gaia2-official-entry-handshake-v1'

function assert(condition, message) { if (!condition) throw new Error(`official entry handshake: ${message}`) }
function portable(value) { return value.replaceAll('\\', '/') }

function requiredId(value, name) {
  assert(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value), `${name} invalid`)
  return value
}

function expectedEntry({ manifest, task, session }) {
  for (const [value, name] of [[manifest?.runId, 'runId'], [task?.executionId, 'executionId'],
    [session?.sessionId, 'sessionId'], [task?.scenarioId, 'scenarioId'], [task?.scenarioVersion, 'scenarioVersion'],
    [task?.scenarioHash, 'scenarioHash'], [task?.config, 'config']]) requiredId(value, name)
  assert(typeof manifest?.manifestHash === 'string' && /^[a-f0-9]{64}$/.test(manifest.manifestHash), 'manifestHash invalid')
  assert(Number.isInteger(task.runNumber) && task.runNumber >= 1, 'runNumber invalid')
  assert(task.attemptIndex === null || (Number.isInteger(task.attemptIndex) && task.attemptIndex >= 0), 'attemptIndex invalid')
  assert(Number.isInteger(task.correctionOrdinal) && task.correctionOrdinal >= 0, 'correctionOrdinal invalid')
  return {
    schemaVersion: OFFICIAL_ENTRY_SCHEMA,
    runId: manifest.runId,
    manifestHash: manifest.manifestHash,
    executionId: task.executionId,
    sessionId: session.sessionId,
    scenarioId: task.scenarioId,
    scenarioVersion: task.scenarioVersion,
    scenarioHash: task.scenarioHash,
    config: task.config,
    runNumber: task.runNumber,
    attemptIndex: task.attemptIndex ?? task.runNumber,
    correctionOrdinal: task.correctionOrdinal,
    phase: task.phase,
    launcherProcessId: process.pid,
  }
}

/** Create a new immutable receipt under the planned output directory. */
export function writeOfficialEntryManifest({ root, manifest, task, session }) {
  const runRoot = resolve(root, manifest.runRoot)
  const output = resolve(root, session.outputDir)
  const workspace = resolve(root, session.workspaceDir)
  assert(within(runRoot, output) && within(runRoot, workspace), 'session escapes run root')
  assert(!existsSync(join(output, 'official-entry')), 'entry directory already exists')
  const entryRoot = join(output, 'official-entry')
  mkdirSync(entryRoot, { recursive: true })
  const value = expectedEntry({ manifest, task, session })
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
  const path = join(entryRoot, 'run-manifest.json')
  writeFileSync(path, bytes, { flag: 'wx' })
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return Object.freeze({
    schemaVersion: OFFICIAL_ENTRY_SCHEMA,
    path,
    relativePath: portable(relative(root, path)),
    sha256,
    value: Object.freeze(value),
    manifestHash: digest(value),
    outputDir: output,
    workspaceDir: workspace,
  })
}

/** Validate a ready receipt or another trusted consumer's manifest bytes. */
export function verifyOfficialEntryManifest({ path, sha256, expected }) {
  assert(typeof path === 'string' && path && typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256), 'receipt reference invalid')
  const absolute = resolve(path)
  assert(existsSync(absolute) && !lstatSync(absolute).isSymbolicLink(), 'receipt missing')
  const bytes = readFileSync(absolute)
  assert(createHash('sha256').update(bytes).digest('hex') === sha256, 'receipt bytes changed')
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('official entry handshake: receipt is not JSON') }
  assert(digest(value) === digest(expected), 'receipt identity differs')
  return value
}
