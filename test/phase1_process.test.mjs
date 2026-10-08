import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveRuntimeSettings } from '../src/phase1_config.mjs'
import { isProcessIdentityAlive, readProcessIdentity, runChildProcess } from '../src/phase1_process.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const temporary = () => mkdtemp(join(tmpdir(), 'gaia2-phase1-process-'))
const json = async (path) => JSON.parse(await readFile(path, 'utf8'))
const execFileAsync = promisify(execFile)
async function until(check, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await check()) return; await sleep(50) }
  throw new Error('condition did not become true')
}

test('all four entries default to an 8000 minute ceiling and original scenarios', () => {
  for (const [entrypoint, actions] of [['e2e', 24], ['all', 24], ['batch', 20], ['pilot', 32]]) {
    assert.deepEqual(resolveRuntimeSettings({ entrypoint, env: {} }), { processTimeoutMs: 480000000, scenarioTimeoutSeconds: 480000, modelRequestTimeoutSeconds: 60, concurrency: 1, maxActions: actions, minimal: false, heartbeatIntervalMs: 1000 })
  }
  assert.equal(resolveRuntimeSettings({ env: { GAIA2_E2E_MINIMAL: '1' } }).maxActions, 1)
  assert.equal(resolveRuntimeSettings({ env: { GAIA2_E2E_MINIMAL: '1' } }).minimal, true)
})

test('zero-safe canonical and legacy precedence never zeroes the scenario ceiling', () => {
  for (const [entrypoint, key] of [['e2e', 'GAIA2_E2E_PROCESS_TIMEOUT_MS'], ['all', 'GAIA2_E2E_ALL_TIMEOUT_MS'], ['batch', 'GAIA2_BATCH_PROCESS_TIMEOUT_MS'], ['pilot', 'GAIA2_PILOT_PROCESS_TIMEOUT_MS']]) {
    const value = resolveRuntimeSettings({ entrypoint, env: { [key]: '0' } })
    assert.equal(value.processTimeoutMs, 0)
    assert.equal(value.scenarioTimeoutSeconds, 480000)
  }
  assert.equal(resolveRuntimeSettings({ entrypoint: 'batch', env: { GAIA2_BATCH_TIMEOUT_MINUTES: '0' } }).processTimeoutMs, 0)
  assert.equal(resolveRuntimeSettings({ entrypoint: 'batch', env: { GAIA2_BATCH_PROCESS_TIMEOUT_MINUTES: '2', GAIA2_BATCH_TIMEOUT_MINUTES: '3' } }).processTimeoutMs, 120000)
  assert.equal(resolveRuntimeSettings({ entrypoint: 'pilot', env: { GAIA2_PROCESS_TIMEOUT_MS: '0', GAIA2_PROCESS_TIMEOUT_MINUTES: '1', GAIA2_PILOT_PROCESS_TIMEOUT_MS: '10' } }).processTimeoutMs, 0)
  assert.equal(resolveRuntimeSettings({ entrypoint: 'pilot', env: { GAIA2_PROCESS_TIMEOUT_MINUTES: '2', GAIA2_PILOT_PROCESS_TIMEOUT_MS: '0' } }).processTimeoutMs, 120000)
  assert.equal(resolveRuntimeSettings({ protocol: { requestedRuntime: { processTimeoutMinutes: 0, scenarioTimeoutSeconds: 999 } }, env: {} }).scenarioTimeoutSeconds, 999)
  const override = resolveRuntimeSettings({ env: { GAIA2_SCENARIO_TIMEOUT_SECONDS: '30', GAIA2_MODEL_REQUEST_TIMEOUT_SECONDS: '12', GAIA2_MAX_ACTIONS: '7' } })
  assert.equal(override.scenarioTimeoutSeconds, 30)
  assert.equal(override.modelRequestTimeoutSeconds, 12)
  assert.equal(override.maxActions, 7)
})

test('strict config validation rejects malformed, unsafe, and incompatible values', () => {
  for (const value of ['', '-1', '1e3', 'Infinity', 'NaN', ' 10', '1ms', '9007199254740992']) assert.throws(() => resolveRuntimeSettings({ env: { GAIA2_PROCESS_TIMEOUT_MS: value } }))
  for (const key of ['GAIA2_SCENARIO_TIMEOUT_SECONDS', 'GAIA2_MODEL_REQUEST_TIMEOUT_SECONDS', 'GAIA2_HEARTBEAT_INTERVAL_MS', 'GAIA2_MAX_ACTIONS']) assert.throws(() => resolveRuntimeSettings({ env: { [key]: '0' } }))
  assert.throws(() => resolveRuntimeSettings({ env: { GAIA2_CONCURRENCY: '2' } }), /concurrency/)
  assert.throws(() => resolveRuntimeSettings({ env: { GAIA2_E2E_MINIMAL: 'true' } }), /0 or 1/)
  assert.throws(() => resolveRuntimeSettings({ env: { GAIA2_PROCESS_TIMEOUT_MS: '0', GAIA2_E2E_PROCESS_TIMEOUT_MS: 'wrong' } }))
  assert.throws(() => resolveRuntimeSettings({ entrypoint: 'unknown', env: {} }))
})

test('real child logs and liveness heartbeat are visible before exit', { timeout: 30000 }, async () => {
  const directory = await temporary()
  const running = runChildProcess({ command: process.execPath, args: ['-e', "process.stdout.write('first\\n');process.stderr.write('warning\\n');setTimeout(()=>process.stdout.write('second\\n'),600);setTimeout(()=>process.exit(0),2500)"], outputDir: directory, heartbeatIntervalMs: 100 })
  await until(async () => { try { return (await readFile(join(directory, 'stdout.log'), 'utf8')).includes('first') } catch { return false } })
  await until(async () => { try { return (await json(join(directory, 'heartbeat.json'))).status === 'running' } catch { return false } })
  const during = await json(join(directory, 'heartbeat.json'))
  assert.equal(during.progress, 'unknown')
  assert.ok(during.pid > 0)
  assert.equal(during.parentPid, process.pid)
  assert.match(during.commandIdentity, /^[0-9a-f]{64}$/)
  const result = await running
  assert.equal(result.exitCode, 0)
  assert.equal(result.timedOut, false)
  assert.equal(result.spawnError, null)
  assert.equal(result.loggingError, null)
  assert.equal(result.heartbeatError, null)
  assert.equal(await readFile(result.stdoutPath, 'utf8'), 'first\nsecond\n')
  assert.equal(await readFile(result.stderrPath, 'utf8'), 'warning\n')
  assert.deepEqual(await json(result.resultPath), result)
  assert.equal((await json(result.heartbeatPath)).status, 'finished')
  assert.equal((await json(join(directory, 'process-reservation.json'))).spawnState, 'spawned')
})

test('streaming output larger than the legacy maxBuffer remains complete', { timeout: 30000 }, async () => {
  const directory = await temporary()
  const source = "const b=Buffer.alloc(65536,120);let i=0;function go(){while(i<300){i++;if(!process.stdout.write(b)){process.stdout.once('drain',go);return}}process.stderr.write('done')}go()"
  const result = await runChildProcess({ command: process.execPath, args: ['-e', source], outputDir: directory, heartbeatIntervalMs: 100 })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdoutBytes, 300 * 65536)
  assert.equal((await stat(result.stdoutPath)).size, 300 * 65536)
  assert.equal(await readFile(result.stderrPath, 'utf8'), 'done')
})

test('secrets spanning chunks and UTF-8 bytes are removed from both durable streams', { timeout: 30000 }, async () => {
  const directory = await temporary()
  const secret = 'sk-test-private-测试-123456'
  const source = "const b=Buffer.from('before|'+process.argv[1]+'|after');let i=0;const t=setInterval(()=>{if(i===b.length){clearInterval(t);return}process.stdout.write(b.subarray(i,i+1));process.stderr.write(b.subarray(i,i+1));i++},8)"
  const result = await runChildProcess({ command: process.execPath, args: ['-e', source, secret], outputDir: directory, heartbeatIntervalMs: 100, secrets: [secret] })
  assert.equal(result.exitCode, 0)
  for (const path of [result.stdoutPath, result.stderrPath]) assert.equal(await readFile(path, 'utf8'), 'before|[REDACTED]|after')
  assert.ok(!(await readFile(result.resultPath, 'utf8')).includes(secret))
})

test('zero process timeout allows a normal child to complete', { timeout: 30000 }, async () => {
  const result = await runChildProcess({ command: process.execPath, args: ['-e', "setTimeout(()=>console.log('done'),300)"], outputDir: await temporary(), processTimeoutMs: 0, heartbeatIntervalMs: 100 })
  assert.equal(result.exitCode, 0)
  assert.equal(result.timedOut, false)
  assert.equal(result.interrupted, false)
})

test('deadline kills the spawned child and its actual descendant', { timeout: 45000 }, async () => {
  const directory = await temporary()
  const source = "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log('descendant='+c.pid);setInterval(()=>{},1000)"
  const result = await runChildProcess({ command: process.execPath, args: ['-e', source], outputDir: directory, processTimeoutMs: 500, heartbeatIntervalMs: 100 })
  assert.equal(result.timedOut, true)
  const descendant = Number((await readFile(result.stdoutPath, 'utf8')).match(/descendant=(\d+)/)[1])
  assert.equal(await readProcessIdentity(result.pid), null)
  assert.equal(await readProcessIdentity(descendant), null)
  assert.equal((await json(result.heartbeatPath)).timedOut, true)
})

test('abort records interrupted and terminates a live child', { timeout: 45000 }, async () => {
  const controller = new AbortController()
  const result = await runChildProcess({ command: process.execPath, args: ['-e', "console.log('started');setInterval(()=>{},1000)"], outputDir: await temporary(), processTimeoutMs: 0, heartbeatIntervalMs: 100, signal: controller.signal, onSpawn: () => { setTimeout(() => controller.abort(), 200) } })
  assert.equal(result.interrupted, true)
  assert.equal(result.timedOut, false)
  assert.equal(await readProcessIdentity(result.pid), null)
})

test('spawn failure and pre-spawn abort both produce final evidence', { timeout: 30000 }, async () => {
  const failure = await runChildProcess({ command: 'gaia2-certainly-missing-process-20261008.exe', outputDir: await temporary(), heartbeatIntervalMs: 100 })
  assert.ok(failure.spawnError)
  assert.ok((await stat(failure.resultPath)).size > 0)
  const controller = new AbortController(); controller.abort()
  const aborted = await runChildProcess({ command: process.execPath, outputDir: await temporary(), signal: controller.signal })
  assert.equal(aborted.pid, null)
  assert.equal(aborted.interrupted, true)
  assert.equal(aborted.spawnError, 'aborted before spawn')
})

test('existing execution logs cannot be overwritten or reused', async () => {
  const directory = await temporary()
  await writeFile(join(directory, 'stdout.log'), 'preserve-me')
  await assert.rejects(() => runChildProcess({ command: process.execPath, args: ['-e', "console.log('wrong')"], outputDir: directory }), /already exists/)
  assert.equal(await readFile(join(directory, 'stdout.log'), 'utf8'), 'preserve-me')
})

test('OS identity checking distinguishes the live process and rejects unverified recovery', { timeout: 20000 }, async () => {
  const identity = await readProcessIdentity(process.pid)
  assert.equal(identity.verified, true)
  assert.equal(await isProcessIdentityAlive(identity), true)
  const altered = { ...identity, birthTime: 'different', startTicks: 'different' }
  assert.equal(await isProcessIdentityAlive(altered), false)
  await assert.rejects(() => isProcessIdentityAlive({ pid: process.pid, verified: false }), /unverified/)
})

for (const processTimeoutMs of [500, 0]) {
  test(`Windows exited root with inherited orphan pipes returns fail-closed evidence (ceiling=${processTimeoutMs})`, { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
    const directory = await temporary()
    const source = "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',windowsHide:true,detached:true});process.stdout.write('owned-descendant='+c.pid+'\\n',()=>process.exit(0))"
    let descendantIdentity
    try {
      const running = runChildProcess({ command: process.execPath, args: ['-e', source], outputDir: directory, processTimeoutMs, heartbeatIntervalMs: 100 })
      await until(async () => {
        try {
          const matched = (await readFile(join(directory, 'stdout.log'), 'utf8')).match(/owned-descendant=(\d+)/)
          if (!matched) return false
          descendantIdentity = await readProcessIdentity(Number(matched[1]))
          return !!descendantIdentity?.verified
        } catch { return false }
      }).catch(async (error) => { error.message += `\n${directory}\nstdout: ${await readFile(join(directory, 'stdout.log'), 'utf8')}\nstderr: ${await readFile(join(directory, 'stderr.log'), 'utf8')}`; throw error })
      const result = await running
      assert.equal(result.childExited, true)
      assert.equal(result.childClosed, true)
      assert.equal(result.exitCode, 0)
      assert.equal(result.manualInspectionRequired, true)
      assert.ok(result.terminationErrors.some((message) => /ownership is unresolved/.test(message)))
      assert.ok(result.elapsedMs < 10000, 'exited root must not hang on inherited pipes')
      assert.equal(result.timedOut, processTimeoutMs !== 0)
      // Closing inherited pipes can itself make the fixture exit on Windows;
      // any remaining live generation is cleaned explicitly in finally below.
      assert.equal((await json(result.heartbeatPath)).manualInspectionRequired, true)
      assert.equal((await json(result.resultPath)).manualInspectionRequired, true)
    } finally {
      // This fixture created the descendant. Cleanup is limited to its exact
      // captured PID generation; it never enumerates arbitrary targets to kill.
      if (descendantIdentity && await isProcessIdentityAlive(descendantIdentity)) {
        await execFileAsync('taskkill.exe', ['/PID', String(descendantIdentity.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 })
        assert.equal(await readProcessIdentity(descendantIdentity.pid), null)
      }
      if (descendantIdentity) assert.equal(await isProcessIdentityAlive(descendantIdentity), false)
    }
  })
}

test('fast healthy child saves strong terminal exit and close evidence', { timeout: 20000 }, async () => {
  const result = await runChildProcess({ command: process.execPath, args: ['-e', "console.log('fast-done')"], outputDir: await temporary(), heartbeatIntervalMs: 100 })
  assert.equal(result.exitCode, 0)
  assert.equal(result.childExited, true)
  assert.equal(result.childClosed, true)
  assert.equal(result.manualInspectionRequired, false)
  assert.equal(result.loggingError, null)
  assert.deepEqual(result.terminationErrors, [])
  assert.equal(await readFile(result.stdoutPath, 'utf8'), 'fast-done\n')
})
