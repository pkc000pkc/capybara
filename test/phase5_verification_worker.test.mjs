import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const worker = join(root, 'scripts/phase5_verification_worker.mjs')
const hash = value => createHash('sha256').update(value).digest('hex')

async function controlled(t, mode, exitCode = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'gaia2-verification-worker-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const check = join(directory, 'check'); mkdirSync(check)
  const jobPath = join(check, 'job.json'), admissionPath = join(check, 'admission.json'), resultPath = join(check, 'result.json'), marker = join(check, 'native-marker')
  const job = { schemaVersion: 'gaia2-phase5-verification-job-v1', command: process.execPath,
    args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], "native body"); process.exit(Number(process.argv[2]));', marker, String(exitCode)], cwd: root }
  const jobRaw = JSON.stringify(job) + '\n', jobSha256 = hash(jobRaw)
  writeFileSync(jobPath, jobRaw, { flag: 'wx' })
  const child = spawn(process.execPath, [worker, '--job', jobPath, '--admission', admissionPath, '--result', resultPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { stderr += value })
  child.stdout.resume()
  child.once('spawn', () => {
    // This unit admission is a controlled double, not an OS identity proof.
    const admission = { schemaVersion: 'gaia2-phase5-verification-admission-v1', pid: child.pid,
      birthTime: 'controlled unit identity', jobSha256 }
    if (mode === 'wrong-hash') admission.jobSha256 = hash('wrong job')
    if (mode === 'wrong-pid') admission.pid += 1
    const raw = JSON.stringify(admission)
    writeFileSync(admissionPath, mode === 'duplicate' ? raw.replace('{', '{"pid":0,') : raw, { flag: 'wx' })
  })
  const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit) })
  return { code, stderr, marker, resultPath, jobSha256, wrapperPid: child.pid }
}

test('verification worker rejects wrong/duplicate admission with zero native body', { timeout: 15000 }, async t => {
  for (const mode of ['wrong-hash', 'wrong-pid', 'duplicate']) {
    const result = await controlled(t, mode)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /WORKER_ADMISSION_INVALID|WORKER_JSON_DUPLICATE_OR_UNSAFE_KEY/)
    assert.equal(existsSync(result.marker), false)
    assert.equal(existsSync(result.resultPath), false)
  }
})

test('verification worker records real exit/close and propagates actual nonzero exit', { timeout: 15000 }, async t => {
  for (const exitCode of [0, 7]) {
    const observed = await controlled(t, 'valid', exitCode)
    assert.equal(observed.code, exitCode)
    assert.equal(readFileSync(observed.marker, 'utf8'), 'native body')
    const result = JSON.parse(readFileSync(observed.resultPath, 'utf8'))
    assert.equal(result.jobSha256, observed.jobSha256)
    assert.equal(result.wrapperPid, observed.wrapperPid)
    assert.equal(result.childExited, true)
    assert.equal(result.childClosed, true)
    assert.equal(result.exitCode, exitCode)
    assert.equal(result.signal, null)
    assert.equal(result.spawnError, null)
    assert.ok(Number.isInteger(result.childPid) && result.childPid > 0)
  }
})
