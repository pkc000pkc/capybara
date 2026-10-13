import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { digest, fileDigest, readJson, within } from './phase0_run.mjs'
import { runChildProcess } from './phase1_process.mjs'
import { assertInitialHasNoCorrection, verifyCorrectionReplayAuthority } from './phase4_replay_authority.mjs'
import { OFFICIAL_ENTRY_SCHEMA, verifyOfficialEntryManifest } from './phase1_official_entry.mjs'

const portable = value => value.replaceAll('\\', '/')

/** Copy private authority bytes, not old runtime state, into a non-Actor evidence area. */
export function prepareCorrectionReadonlyInitialization({ root, manifest, task, session }) {
  if ((task.correctionOrdinal ?? 0) === 0) {
    assertInitialHasNoCorrection(task)
    if (Object.hasOwn(manifest, 'correctionContext')) throw new Error('initial plan cannot contain correction context')
    return null
  }
  if (!task.correctionContext) throw new Error('correction execution requires verified lineage')
  const authority = verifyCorrectionReplayAuthority({ root, manifest, task })
  const directory = resolve(root, session.workspaceDir, 'correction-authority')
  if (existsSync(directory)) throw new Error('correction authority must use a new session')
  mkdirSync(directory)
  const files = [...authority.consumed].map(([originalPath, bytes], index) => {
    const path = join(directory, `${String(index).padStart(5, '0')}.bin`)
    writeFileSync(path, bytes, { flag: 'wx' })
    return { originalPath, path: portable(relative(root, path)), sha256: fileDigest(path) }
  })
  const sealed = new Map(files.map(ref => [ref.originalPath, ref]))
  const verified = verifyCorrectionReplayAuthority({ root, manifest, task, readEvidence: path => {
    const ref = sealed.get(path)
    if (!ref || fileDigest(resolve(root, ref.path)) !== ref.sha256) throw new Error('correction sealed authority changed')
    return readFileSync(resolve(root, ref.path))
  } })
  if (digest(verified.context) !== digest(authority.context) || verified.consumed.size !== files.length) throw new Error('correction authority closure differs')
  const receipt = { schemaVersion: 'gaia2-phase4-runtime-authority-v1', context: verified.context, initializer: verified.initializer, files }
  const path = join(directory, 'index.json'); writeFileSync(path, JSON.stringify(receipt) + '\n', { flag: 'wx' })
  return { ...verified, evidencePath: portable(relative(root, path)), files }
}

export async function startRuntimeHookService({ root, manifest, task, session, settings, signal, entry = null }) {
  const protocol = readJson(join(root, 'config/phase0-protocol.json'))
  const capabilityPath = resolve(root, manifest.lockRefs.capabilities.path)
  if (fileDigest(capabilityPath) !== manifest.lockRefs.capabilities.sha256) throw new Error('hook capability inventory differs from frozen plan')
  const capabilities = readJson(capabilityPath)
  const output = resolve(root, session.outputDir), workspace = resolve(root, session.workspaceDir)
  if (!within(resolve(root, manifest.runRoot), output) || !within(resolve(root, manifest.runRoot), workspace)) throw new Error('hook session escapes plan')
  if (entry !== null) {
    if (entry.schemaVersion !== OFFICIAL_ENTRY_SCHEMA || entry.value?.executionId !== task.executionId
      || entry.value?.sessionId !== session.sessionId || entry.value?.scenarioId !== task.scenarioId
      || entry.value?.manifestHash !== manifest.manifestHash) throw new Error('official entry handshake missing or mismatched')
    verifyOfficialEntryManifest({ path: entry.path, sha256: entry.sha256, expected: entry.value })
  }
  const correctionAuthority = prepareCorrectionReadonlyInitialization({ root, manifest, task, session })
  const serviceRoot = join(output, 'hook-host'); mkdirSync(serviceRoot)
  const lifecycle = (name, value) => {
    // Lifecycle receipts are immutable, redacted boundary evidence. They are
    // intentionally separate from the supervised process receipts because a
    // startup failure can happen before the child creates heartbeat/final files.
    try { writeFileSync(join(serviceRoot, name), `${JSON.stringify(value)}\n`, { flag: 'wx' }) } catch { /* preserve the original failure */ }
  }
  lifecycle('lifecycle-start.json', { schemaVersion: 'gaia2-hook-lifecycle-v1', phase: 'start', executionId: task.executionId, sessionId: session.sessionId, scenarioId: task.scenarioId, startedAt: new Date().toISOString() })
  const token = randomBytes(32).toString('hex'), readyPath = join(serviceRoot, 'ready.json'), specPath = join(serviceRoot, 'spec.json')
  const options = { projectDir: root, workspaceDir: workspace, plugins: capabilities.plugins.map(({ id, snapshotRoot, files }) => ({ id, snapshotRoot, files })), executionId: task.executionId, sessionId: session.sessionId, scenarioId: task.scenarioId, attemptIndex: task.attemptIndex ?? 0, runNumber: task.runNumber,
    // The A2A listener is a private, loopback-only transport.  It is present
    // only for the official agent2agent phase; standard/noise runs keep the
    // public Hook Host surface unchanged.
    ...(task.phase === 'agent2agent' ? { a2a: { enabled: true, channelId: randomBytes(32).toString('hex'), bindingHash: randomBytes(32).toString('hex'), requestTimeoutMs: Math.max(1, Math.min(2147483647, Math.trunc((settings.scenarioTimeoutSeconds ?? 480000) * 1000))), maxNativeActions: 100 } } : {}) }
  if (correctionAuthority) options.trustedReadonlySessionInitialValues = [correctionAuthority.initializer]
  writeFileSync(specPath, JSON.stringify({ backendRoot: protocol.runtime.backendRoot, readyPath, options,
    ...(entry ? { entry: { schemaVersion: entry.schemaVersion, path: entry.path, relativePath: entry.relativePath, sha256: entry.sha256, value: entry.value } } : {}) }) + '\n', { flag: 'wx' })
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|ACCESS_TOKEN|AUTHORIZATION|HF_TOKEN|HUGGINGFACE_TOKEN|GAIA2_HOOK_TOKEN)/i.test(key)))
  const controller = new AbortController(), abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  let ended = null, startupError = null
  const processPromise = runChildProcess({ command: process.execPath, args: [`--import=${pathToFileURL(join(protocol.runtime.backendRoot, 'node_modules/tsx/dist/loader.mjs')).href}`, '--conditions=development', join(root, 'scripts/phase3_hook_server.ts'), '--spec', specPath], cwd: workspace, env: { ...env, GAIA2_HOOK_TOKEN: token }, outputDir: serviceRoot, processTimeoutMs: settings.processTimeoutMs, heartbeatIntervalMs: settings.heartbeatIntervalMs, signal: controller.signal, secrets: [token] }).then(result => { ended = result; return result }, error => { startupError = error; return null })
  let ready
  try {
    const deadline = Date.now() + 30000
    while (!existsSync(readyPath) && !ended && !startupError && !controller.signal.aborted && Date.now() < deadline) await sleep(50)
    if (!existsSync(readyPath) || startupError) throw new Error('real plugin host did not initialize')
    ready = readJson(readyPath)
    const initialized = ready.initialization
    const valid = !ended && ready.schemaVersion === 'gaia2-hook-host-ready-v1' && /^http:\/\/127\.0\.0\.1:\d+\/invoke$/.test(ready.endpoint)
      && initialized?.schemaVersion === 'capybara-runtime-plugin-host-v1'
      && initialized.executionId === task.executionId && initialized.sessionId === session.sessionId
      && ready.initializationHash === createHash('sha256').update(JSON.stringify(initialized)).digest('hex')
      && Array.isArray(initialized.plugins) && initialized.plugins.length === options.plugins.length
      && options.plugins.every(plugin => initialized.plugins.some(loaded => loaded.id === plugin.id && digest(loaded.files) === digest(plugin.files)))
      && initialized.harnesses?.some(harness => harness.type === 'persistent')
      && (!entry || (ready.entry?.schemaVersion === entry.schemaVersion && ready.entry?.path === entry.path && ready.entry?.relativePath === entry.relativePath && ready.entry?.sha256 === entry.sha256))
      && (correctionAuthority ? digest(initialized.readonlySessionInitializations) === digest([{ ...correctionAuthority.initializer, pluginId: 'gaia2-evaluation', type: 'text', scope: 'session', readonly: true, valueHash: createHash('sha256').update(JSON.stringify(correctionAuthority.initializer.value)).digest('hex') }]) : !Object.hasOwn(initialized, 'readonlySessionInitializations'))
      && (task.phase !== 'agent2agent' || (ready.a2a?.schemaVersion === 'gaia2-private-listener-v1'
        && ready.a2a.host === '127.0.0.1' && Number.isInteger(ready.a2a.port) && ready.a2a.port > 0
        && /^[a-f0-9]{64}$/.test(ready.a2a.channelId) && /^[a-f0-9]{64}$/.test(ready.a2a.bindingHash)))
    if (!valid) throw new Error('unsafe hook host ready receipt')
    lifecycle('lifecycle-ready.json', { schemaVersion: 'gaia2-hook-lifecycle-v1', phase: 'ready', executionId: task.executionId, sessionId: session.sessionId, processId: ready.processId, endpoint: ready.endpoint, readySha256: createHash('sha256').update(JSON.stringify(ready)).digest('hex'), readyAt: new Date().toISOString() })
  } catch {
    controller.abort()
    const cleanup = await processPromise
    lifecycle('lifecycle-failure.json', { schemaVersion: 'gaia2-hook-lifecycle-v1', phase: 'startup_failure', executionId: task.executionId, sessionId: session.sessionId, code: 'hook_host_startup_failed', childExited: cleanup?.childExited === true, childClosed: cleanup?.childClosed === true, interrupted: cleanup?.interrupted === true, manualInspectionRequired: cleanup?.manualInspectionRequired === true, terminationErrors: Array.isArray(cleanup?.terminationErrors) ? cleanup.terminationErrors.length : null, failedAt: new Date().toISOString() })
    signal?.removeEventListener('abort', abort)
    if (!cleanup?.childExited || !cleanup?.childClosed || cleanup.manualInspectionRequired || cleanup.terminationErrors?.length) throw new Error('real plugin host startup failed; supervised cleanup unresolved; manual inspection required')
    throw new Error('real plugin host startup failed; supervised cleanup completed')
  }
  let closed = false
  return {
    endpoint: ready.endpoint, token, ready, correctionAuthority,
    async close() {
      if (closed) return ended; closed = true
      try {
        if (!ended && !controller.signal.aborted) {
          const response = await fetch(ready.endpoint.replace('/invoke', '/shutdown'), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ executionId: task.executionId, sessionId: session.sessionId }), signal: AbortSignal.timeout(10000) })
          if (!response.ok) controller.abort()
        }
      } catch { controller.abort() }
      const result = await Promise.race([processPromise, sleep(10000, null, { ref: false }).then(() => null)])
      if (!result) controller.abort()
      const final = result ?? await processPromise
      lifecycle('lifecycle-closed.json', { schemaVersion: 'gaia2-hook-lifecycle-v1', phase: 'closed', executionId: task.executionId, sessionId: session.sessionId, exitCode: Number.isInteger(final?.exitCode) ? final.exitCode : null, signal: typeof final?.signal === 'string' ? final.signal : null, timedOut: final?.timedOut === true, interrupted: final?.interrupted === true, childExited: final?.childExited === true, childClosed: final?.childClosed === true, manualInspectionRequired: final?.manualInspectionRequired === true, terminationErrors: Array.isArray(final?.terminationErrors) ? final.terminationErrors.length : null, closedAt: new Date().toISOString() })
      signal?.removeEventListener('abort', abort)
      return final
    },
  }
}
