import { spawn, execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { finished as streamFinished, pipeline } from 'node:stream/promises'
import { StringDecoder } from 'node:string_decoder'
import { createHash, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function normalizedSecrets(secrets) {
  if (!Array.isArray(secrets) || secrets.some((item) => typeof item !== 'string')) throw new Error('secrets must be an array of strings')
  return [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)
}

// Keeping raw suffixes (rather than suffixes of replaced text) also covers a
// credential split across arbitrarily many stdout/stderr chunks or UTF-8 bytes.
class RedactingStream extends Transform {
  constructor(secrets, onBytes) {
    super()
    this.secrets = secrets
    this.longest = secrets[0]?.length ?? 0
    this.pending = ''
    this.decoder = new StringDecoder('utf8')
    this.onBytes = onBytes
  }
  consume(final) {
    if (!this.longest) { if (this.pending) this.push(this.pending); this.pending = ''; return }
    const limit = final ? this.pending.length : Math.max(0, this.pending.length - this.longest + 1)
    let position = 0
    let result = ''
    while (position < limit) {
      const matched = this.secrets.find((secret) => this.pending.startsWith(secret, position))
      if (matched) { result += '[REDACTED]'; position += matched.length }
      else { result += this.pending[position]; position++ }
    }
    this.pending = this.pending.slice(position)
    if (result) this.push(result)
  }
  _transform(chunk, encoding, callback) {
    try { this.onBytes(chunk.length); this.pending += this.decoder.write(chunk); this.consume(false); callback() }
    catch (error) { callback(error) }
  }
  _flush(callback) {
    try { this.pending += this.decoder.end(); this.consume(true); callback() }
    catch (error) { callback(error) }
  }
}

async function atomicJson(path, value, { immutable = false } = {}) {
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx')
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync() }
  finally { await file.close() }
  try {
    if (immutable) { await link(temporary, path); await unlink(temporary) }
    else await rename(temporary, path)
  } catch (error) { await unlink(temporary).catch(() => {}); throw error }
}

function redact(value, secrets) {
  let result = String(value)
  for (const secret of secrets) result = result.split(secret).join('[REDACTED]')
  return result
}

async function exists(path) { try { await access(path, constants.F_OK); return true } catch { return false } }

async function windowsTree(pid) {
  // Only process IDs, parent IDs, and birth times are queried. Command lines
  // and the child's potentially credential-bearing environment are not read.
  const script = '$p=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{n="Born";e={$_.CreationDate.ToUniversalTime().ToString("o")}}; $p | ConvertTo-Json -Compress'
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 })
  const raw = JSON.parse(stdout)
  const rows = Array.isArray(raw) ? raw : [raw]
  const root = rows.find((item) => item.ProcessId === pid)
  if (!root) return []
  const owned = new Map([[pid, root]])
  for (let changed = true; changed;) {
    changed = false
    for (const item of rows) {
      const parent = owned.get(item.ParentProcessId)
      // ParentProcessId alone is not ownership: a recycled root PID can have
      // older unrelated orphans still pointing at its previous generation.
      if (parent?.Born && item.Born && item.Born >= parent.Born && !owned.has(item.ProcessId)) { owned.set(item.ProcessId, item); changed = true }
    }
  }
  return [...owned.values()]
}

export async function readProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('invalid process PID')
  if (process.platform === 'win32') {
    const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p){$p | Select-Object ProcessId,ParentProcessId,@{n="Born";e={$_.CreationDate.ToUniversalTime().ToString("o")}} | ConvertTo-Json -Compress}`
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 })
    if (!stdout.trim()) return null
    const row = JSON.parse(stdout)
    return { platform: 'win32', pid: row.ProcessId, parentPid: row.ParentProcessId, birthTime: row.Born, verified: true }
  }
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
      return { platform: 'linux', pid, parentPid: Number(fields[1]), startTicks: fields[19], verified: true }
    } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error }
  }
  try { process.kill(pid, 0); return { platform: process.platform, pid, verified: false } }
  catch (error) { if (error.code === 'ESRCH') return null; throw error }
}

export async function isProcessIdentityAlive(identity) {
  if (!identity?.verified) throw new Error('process identity is unverified; refuse automatic recovery')
  const current = await readProcessIdentity(identity.pid)
  if (!current) return false
  if (!current.verified) throw new Error('current process identity cannot be verified')
  return current.platform === identity.platform && current.pid === identity.pid
    && (identity.platform === 'win32' ? current.birthTime === identity.birthTime : current.startTicks === identity.startTicks)
}

async function taskkill(pid, force) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) throw new Error('invalid child PID for termination')
  try {
    // Kill one verified generation at a time. /T recursively follows bare
    // ParentProcessId links and could include older unrelated PID generations.
    await execFileAsync('taskkill.exe', ['/PID', String(pid), ...(force ? ['/F'] : [])], { windowsHide: true, timeout: 10000 })
    return null
  } catch (error) { return error.code ?? error.message }
}

function delay(milliseconds) { return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)) }

// Stdout and stderr are streamed to exclusive files, never accumulated in a
// child-process maxBuffer. The heartbeat is liveness evidence, not task progress.
export async function runChildProcess({ command, args = [], cwd, env = process.env, outputDir, processTimeoutMs = 480000000, heartbeatIntervalMs = 1000, signal, secrets = [], onSpawn }) {
  if (typeof command !== 'string' || !command || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new Error('invalid child command or arguments')
  if (!outputDir) throw new Error('outputDir is required')
  if (!Number.isSafeInteger(processTimeoutMs) || processTimeoutMs < 0) throw new Error('processTimeoutMs must be a non-negative safe integer')
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) throw new Error('heartbeatIntervalMs must be a positive safe integer')
  const protectedValues = normalizedSecrets(secrets)
  const directory = resolve(outputDir)
  await mkdir(directory, { recursive: true })
  const stdoutPath = join(directory, 'stdout.log')
  const stderrPath = join(directory, 'stderr.log')
  const heartbeatPath = join(directory, 'heartbeat.json')
  const resultPath = join(directory, 'process-result.json')
  for (const path of [stdoutPath, stderrPath, heartbeatPath, resultPath]) if (await exists(path)) throw new Error(`process output already exists: ${path}`)
  // This reservation is permanent evidence that the execution directory was
  // used, including when spawning fails or the supervisor itself is interrupted.
  const reservation = await open(join(directory, 'process-reservation.json'), 'wx')
  const startedAt = new Date().toISOString()
  const start = Date.now()
  try {
    await reservation.writeFile(`${JSON.stringify({ schemaVersion: 'gaia2-process-reservation-v1', spawnState: 'starting', supervisorPid: process.pid, startedAt })}\n`)
    await reservation.sync()
  } finally { await reservation.close() }
  const stdoutFile = await open(stdoutPath, 'wx')
  const stderrFile = await open(stderrPath, 'wx')
  const stdoutSink = stdoutFile.createWriteStream({ autoClose: false })
  const stderrSink = stderrFile.createWriteStream({ autoClose: false })
  let child
  let childClosed = false
  let childExited = false
  let childExitedAt = null
  let manualInspectionRequired = false
  let exitCode = null
  let exitSignal = null
  let spawnError = null
  let loggingError = null
  let heartbeatError = null
  let timedOut = false
  let interrupted = false
  let stdoutBytes = 0
  let stderrBytes = 0
  let lastOutputAt = null
  let terminationPromise = null
  let terminationErrors = []
  let heartbeatChain = Promise.resolve()
  let heartbeatWriting = false
  let deadlineTimer
  let heartbeatTimer
  let exitedPipeTimer
  let processSignal = null
  let processIdentity = null
  let waitForChild = null
  const commandIdentity = createHash('sha256').update(JSON.stringify([redact(command, protectedValues), args.map((arg) => redact(arg, protectedValues))])).digest('hex')
  const heartbeat = (status, { force = false } = {}) => {
    // Slow disks must not build an unbounded queue of timer closures. Ordinary
    // liveness ticks coalesce; the terminating/final snapshots are awaited.
    if (heartbeatWriting) return force ? heartbeatChain.then(() => heartbeat(status, { force: true })) : heartbeatChain
    heartbeatWriting = true
    heartbeatChain = heartbeatChain.then(async () => {
      // A failed/closed log stream is technical evidence, but must not suppress
      // the terminal heartbeat (especially after deliberate orphan-pipe detach).
      try { await Promise.all([stdoutFile.sync(), stderrFile.sync()]) }
      catch (error) { heartbeatError = redact(`log fsync: ${error.message}`, protectedValues) }
      await atomicJson(heartbeatPath, { schemaVersion: 'gaia2-process-heartbeat-v1', status, progress: 'unknown', pid: child?.pid ?? null, parentPid: process.pid, supervisorPid: process.pid, processIdentity, commandIdentity, childExited, childClosed, childExitedAt, manualInspectionRequired, startedAt, updatedAt: new Date().toISOString(), elapsedMs: Date.now() - start, lastOutputAt, stdoutBytes, stderrBytes, timedOut, interrupted })
    }).catch((error) => { heartbeatError = redact(error.message, protectedValues) }).finally(() => { heartbeatWriting = false })
    return heartbeatChain
  }
  const terminate = () => {
    if (terminationPromise || !child?.pid || childClosed) return terminationPromise ?? Promise.resolve()
    terminationPromise = (async () => {
      await heartbeat('terminating', { force: true })
      if (process.platform === 'win32') {
        let tree = []
        if (!childExited) {
          try { tree = await windowsTree(child.pid) } catch (error) { terminationErrors.push(redact(`PID tree snapshot: ${error.message}`, protectedValues)) }
        }
        const root = tree.find((item) => item.ProcessId === child.pid)
        // A root snapshot from a different PID generation proves nothing about
        // ownership. In particular NEVER fall back to taskkill by bare PID.
        const owned = processIdentity?.verified && root?.Born === processIdentity.birthTime
          ? tree.map((item) => ({ platform: 'win32', pid: item.ProcessId, parentPid: item.ParentProcessId, birthTime: item.Born, verified: true })) : []
        const killVerified = async (identity, force) => {
          if (identity.pid === child.pid && childExited) return
          try {
            if (!await isProcessIdentityAlive(identity) || (identity.pid === child.pid && childExited)) return
            const error = await taskkill(identity.pid, force)
            if (error && force && !childClosed) terminationErrors.push(`taskkill verified PID ${identity.pid}: ${error}`)
          } catch (error) { terminationErrors.push(redact(`PID identity verification: ${error.message}`, protectedValues)) }
        }
        if (owned.length) {
          await killVerified(processIdentity, false)
          await delay(300)
          // Birth checks retain safe ownership even when the original root
          // exits between the snapshot and the forced descendant pass.
          for (const identity of owned) await killVerified(identity, true)
        }
      } else {
        try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') terminationErrors.push(error.message) }
        await delay(300)
        try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') terminationErrors.push(error.message) }
      }
      await delay(300)
      if (!childClosed) {
        manualInspectionRequired = true
        terminationErrors.push(childExited
          ? 'root exited but inherited pipes remain open; descendant ownership is unresolved; manual inspection required'
          : 'verified process termination did not close child pipes; manual inspection required')
        // A grandchild holding inherited pipes must not hold the supervisor
        // forever, including when the outer process timeout was disabled.
        child.stdout.destroy()
        child.stderr.destroy()
      }
    })()
    return terminationPromise
  }
  const abort = () => { interrupted = true; void terminate() }
  const onSignal = (name) => { interrupted = true; processSignal = name; void terminate() }
  const onSigint = () => onSignal('SIGINT')
  const onSigterm = () => onSignal('SIGTERM')
  const armDeadline = () => {
    if (!processTimeoutMs || childClosed) return
    const remaining = processTimeoutMs - (Date.now() - start)
    if (remaining <= 0) { timedOut = true; void terminate(); return }
    deadlineTimer = setTimeout(armDeadline, Math.min(remaining, 2147483647))
  }
  try {
    if (signal?.aborted) { interrupted = true; spawnError = 'aborted before spawn'; stdoutSink.end(); stderrSink.end(); await Promise.all([streamFinished(stdoutSink), streamFinished(stderrSink)]) }
    else {
      child = spawn(command, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      waitForChild = new Promise((resolveFinished) => {
        child.once('error', (error) => { spawnError = redact(error.message, protectedValues) })
        child.once('exit', (code, name) => {
          childExited = true; childExitedAt = new Date().toISOString(); exitCode = code; exitSignal = name
          // This is post-exit pipe cleanup, not an arbitrary task deadline.
          // Normal EOF gets time to drain before orphan ownership fails closed.
          exitedPipeTimer = setTimeout(() => { if (!childClosed) void terminate() }, 1000)
        })
        child.once('close', (code, name) => { childClosed = true; clearTimeout(exitedPipeTimer); exitCode = code; exitSignal = name; resolveFinished() })
      })
      const output = [
        pipeline(child.stdout, new RedactingStream(protectedValues, (bytes) => { stdoutBytes += bytes; lastOutputAt = new Date().toISOString() }), stdoutSink),
        pipeline(child.stderr, new RedactingStream(protectedValues, (bytes) => { stderrBytes += bytes; lastOutputAt = new Date().toISOString() }), stderrSink),
      ].map((promise) => promise.catch((error) => { loggingError = redact(error.message, protectedValues); void terminate() }))
      signal?.addEventListener('abort', abort, { once: true })
      process.on('SIGINT', onSigint)
      process.on('SIGTERM', onSigterm)
      heartbeatTimer = setInterval(() => { void heartbeat(terminationPromise ? 'terminating' : 'running') }, heartbeatIntervalMs)
      armDeadline()
      processIdentity = child.pid ? { platform: process.platform, pid: child.pid, verified: false } : null
      await atomicJson(join(directory, 'process-reservation.json'), { schemaVersion: 'gaia2-process-reservation-v1', spawnState: 'spawned', supervisorPid: process.pid, parentPid: process.pid, pid: child.pid ?? null, startedAt, commandIdentity, processIdentity })
      await heartbeat('running')
      if (onSpawn) await onSpawn({ pid: child.pid ?? null, parentPid: process.pid, startedAt, commandIdentity, processIdentity })
      if (child.pid) {
        try { const identity = await readProcessIdentity(child.pid); if (identity && !childExited) processIdentity = identity }
        catch (error) { processIdentity = { platform: process.platform, pid: child.pid, verified: false }; terminationErrors.push(redact(`process identity: ${error.message}`, protectedValues)) }
      }
      await heartbeat('running')
      await waitForChild
      await terminationPromise
      await Promise.all(output)
    }
    clearTimeout(deadlineTimer)
    clearInterval(heartbeatTimer)
    await heartbeat('finished', { force: true })
    const finishedAt = new Date().toISOString()
    const result = { schemaVersion: 'gaia2-process-result-v1', exitCode, signal: exitSignal, timedOut, interrupted, processSignal, spawnError, loggingError, heartbeatError, terminationErrors, childExited, childClosed, childExitedAt, manualInspectionRequired, pid: child?.pid ?? null, parentPid: process.pid, processIdentity, commandIdentity, startedAt, finishedAt, elapsedMs: Date.now() - start, stdoutPath, stderrPath, heartbeatPath, resultPath, stdoutBytes, stderrBytes, lastOutputAt }
    await atomicJson(resultPath, result, { immutable: true })
    return result
  } finally {
    clearTimeout(deadlineTimer)
    clearInterval(heartbeatTimer)
    clearTimeout(exitedPipeTimer)
    signal?.removeEventListener('abort', abort)
    process.removeListener('SIGINT', onSigint)
    process.removeListener('SIGTERM', onSigterm)
    if (child?.pid && !childClosed) { await terminate(); await waitForChild }
    await heartbeatChain
    stdoutSink.destroy()
    stderrSink.destroy()
    await Promise.all([stdoutFile.close(), stderrFile.close()])
  }
}
