import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { digest, fileDigest, readJson, within } from './phase0_run.mjs'
import { runChildProcess } from './phase1_process.mjs'

export async function startRuntimeHookService({ root, manifest, task, session, settings, signal }) {
  const protocol = readJson(join(root, 'config/phase0-protocol.json'))
  const capabilityPath = resolve(root, manifest.lockRefs.capabilities.path)
  if (fileDigest(capabilityPath) !== manifest.lockRefs.capabilities.sha256) throw new Error('hook capability inventory differs from frozen plan')
  const capabilities = readJson(capabilityPath)
  const output = resolve(root, session.outputDir), workspace = resolve(root, session.workspaceDir)
  if (!within(resolve(root, manifest.runRoot), output) || !within(resolve(root, manifest.runRoot), workspace)) throw new Error('hook session escapes plan')
  const serviceRoot = join(output, 'hook-host'); mkdirSync(serviceRoot)
  const token = randomBytes(32).toString('hex'), readyPath = join(serviceRoot, 'ready.json'), specPath = join(serviceRoot, 'spec.json')
  const options = { projectDir: root, workspaceDir: workspace, plugins: capabilities.plugins.map(({ id, snapshotRoot, files }) => ({ id, snapshotRoot, files })), executionId: task.executionId, sessionId: session.sessionId, scenarioId: task.scenarioId, attemptIndex: task.attemptIndex ?? 0, runNumber: task.runNumber }
  writeFileSync(specPath, JSON.stringify({ backendRoot: protocol.runtime.backendRoot, readyPath, options }) + '\n', { flag: 'wx' })
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
    if (!valid) throw new Error('unsafe hook host ready receipt')
  } catch {
    controller.abort()
    await processPromise
    signal?.removeEventListener('abort', abort)
    throw new Error('real plugin host startup failed; supervised cleanup completed')
  }
  let closed = false
  return {
    endpoint: ready.endpoint, token, ready,
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
      signal?.removeEventListener('abort', abort)
      return final
    },
  }
}
