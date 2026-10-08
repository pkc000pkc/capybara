import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { finished } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = code => { throw new Error(code) }
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const text = value => typeof value === 'string' && !value.includes('\0') && !(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))

function regular(target, directory = false) {
  const absolute = resolve(target)
  for (let cursor = absolute; ; cursor = dirname(cursor)) {
    if (lstatSync(cursor).isSymbolicLink()) fail('WORKER_PATH_LINK')
    if (cursor === dirname(cursor)) break
  }
  if (pathKey(realpathSync(absolute)) !== pathKey(absolute) || (directory ? !statSync(absolute).isDirectory() : !statSync(absolute).isFile())) fail('WORKER_PATH_INVALID')
  return absolute
}

// These two tiny authority records must not use JSON.parse's last-key-wins
// behavior. Strings still use the standard parser for escape/control validation.
function strictJson(bytes) {
  if (bytes.length > 1024 * 1024) fail('WORKER_JSON_TOO_LARGE')
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  let cursor = 0
  const whitespace = () => { while (/[\x20\x09\x0a\x0d]/.test(source[cursor] ?? '') && cursor < source.length) cursor += 1 }
  function string() {
    const start = cursor++
    while (cursor < source.length) {
      const character = source[cursor++]
      if (character === '\\') { cursor += 1; continue }
      if (character === '"') {
        const value = JSON.parse(source.slice(start, cursor))
        if (!text(value)) fail('WORKER_JSON_STRING_INVALID')
        return value
      }
    }
    fail('WORKER_JSON_INVALID')
  }
  function value(depth = 0) {
    if (depth > 64) fail('WORKER_JSON_DEPTH')
    whitespace()
    if (source[cursor] === '"') return string()
    if (source[cursor] === '{') {
      cursor += 1; whitespace()
      const object = Object.create(null)
      if (source[cursor] === '}') { cursor += 1; return object }
      while (cursor < source.length) {
        if (source[cursor] !== '"') fail('WORKER_JSON_INVALID')
        const key = string()
        if (Object.hasOwn(object, key) || ['__proto__', 'prototype', 'constructor'].includes(key)) fail('WORKER_JSON_DUPLICATE_OR_UNSAFE_KEY')
        whitespace(); if (source[cursor++] !== ':') fail('WORKER_JSON_INVALID')
        object[key] = value(depth + 1); whitespace()
        const separator = source[cursor++]
        if (separator === '}') return object
        if (separator !== ',') fail('WORKER_JSON_INVALID')
        whitespace()
      }
      fail('WORKER_JSON_INVALID')
    }
    if (source[cursor] === '[') {
      cursor += 1; whitespace()
      const array = []
      if (source[cursor] === ']') { cursor += 1; return array }
      while (cursor < source.length) {
        array.push(value(depth + 1)); whitespace()
        const separator = source[cursor++]
        if (separator === ']') return array
        if (separator !== ',') fail('WORKER_JSON_INVALID')
      }
      fail('WORKER_JSON_INVALID')
    }
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]]) {
      if (source.startsWith(literal, cursor)) { cursor += literal.length; return parsed }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(cursor))
    if (!number) fail('WORKER_JSON_INVALID')
    cursor += number[0].length
    const parsed = Number(number[0]); if (!Number.isFinite(parsed)) fail('WORKER_JSON_NONFINITE')
    return parsed
  }
  const parsed = value(); whitespace()
  if (cursor !== source.length) fail('WORKER_JSON_INVALID')
  return parsed
}

function argumentsFromCli() {
  const args = process.argv.slice(2), supplied = Object.create(null)
  if (args.length !== 6) fail('WORKER_CLI_INVALID')
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], target = args[index + 1]
    if (!['--job', '--admission', '--result'].includes(flag) || Object.hasOwn(supplied, flag) || !text(target) || !isAbsolute(target)) fail('WORKER_CLI_INVALID')
    supplied[flag] = resolve(target)
  }
  const paths = ['--job', '--admission', '--result'].map(flag => supplied[flag])
  if (new Set(paths.map(pathKey)).size !== 3 || new Set(paths.map(value => pathKey(dirname(value)))).size !== 1) fail('WORKER_CHECK_DIRECTORY_INVALID')
  regular(dirname(paths[0]), true)
  if (existsSync(supplied['--result'])) fail('WORKER_RESULT_ALREADY_EXISTS')
  return { jobPath: supplied['--job'], admissionPath: supplied['--admission'], resultPath: supplied['--result'] }
}

async function admitted(paths, jobSha256) {
  const deadline = Date.now() + 30_000
  while (true) {
    try {
      const file = regular(paths.admissionPath), raw = readFileSync(file), admission = strictJson(raw)
      if (!exact(admission, ['schemaVersion', 'pid', 'birthTime', 'jobSha256']) || admission.schemaVersion !== 'gaia2-phase5-verification-admission-v1' || admission.pid !== process.pid || !Number.isInteger(admission.pid) || !text(admission.birthTime) || !admission.birthTime.trim() || admission.jobSha256 !== jobSha256) fail('WORKER_ADMISSION_INVALID')
      regular(file)
      if (!readFileSync(file).equals(raw)) fail('WORKER_ADMISSION_CHANGED')
      return
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (Date.now() >= deadline) fail('WORKER_ADMISSION_TIMEOUT')
    // Wait only for the actual admission signal; never delay a test to obtain birth.
    await delay(Math.min(25, Math.max(1, deadline - Date.now())))
  }
}

function flush(stream) {
  return new Promise((resolveFlush, reject) => stream.write('', error => error ? reject(error) : resolveFlush()))
}

async function execute(job, jobSha256, resultPath) {
  let childPid = null, exitCode = null, signal = null, childExited = false, childClosed = false, spawnError = null
  const child = spawn(job.command, job.args, { cwd: job.cwd, env: process.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  childPid = child.pid ?? null
  const pipes = [child.stdout, child.stderr].map((stream, index) => {
    if (!stream) return Promise.resolve()
    stream.pipe(index === 0 ? process.stdout : process.stderr, { end: false })
    return finished(stream, { cleanup: true })
  })
  const closed = new Promise(resolveClose => {
    child.once('error', error => { spawnError = typeof error.code === 'string' ? error.code : 'CHILD_SPAWN_ERROR' })
    child.once('exit', (code, childSignal) => { childExited = true; exitCode = code; signal = childSignal })
    child.once('close', () => { childClosed = true; resolveClose() })
  })
  // Install rejection handlers immediately, and retain real exit/close even when
  // a pipe fails. A pipe/forwarding failure remains an outer worker failure.
  const pipeCompletion = Promise.allSettled(pipes)
  await closed
  const pipeOutcomes = await pipeCompletion
  await Promise.all([flush(process.stdout), flush(process.stderr)])
  const result = { schemaVersion: 'gaia2-phase5-verification-child-result-v1', jobSha256, wrapperPid: process.pid, childPid, exitCode, signal, childExited, childClosed, spawnError }
  regular(dirname(resultPath), true)
  if (existsSync(resultPath)) fail('WORKER_RESULT_ALREADY_EXISTS')
  writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
  if (pipeOutcomes.some(value => value.status === 'rejected')) fail('WORKER_CHILD_PIPE_FAILED')
  process.exitCode = childExited && childClosed && spawnError === null && signal === null && exitCode === 0 ? 0
    : Number.isInteger(exitCode) && exitCode > 0 && exitCode <= 255 ? exitCode : 1
}

try {
  const paths = argumentsFromCli(), jobRaw = readFileSync(regular(paths.jobPath)), jobSha256 = sha(jobRaw), job = strictJson(jobRaw)
  if (!exact(job, ['schemaVersion', 'command', 'args', 'cwd']) || job.schemaVersion !== 'gaia2-phase5-verification-job-v1' || !text(job.command) || !job.command.trim() || !Array.isArray(job.args) || !job.args.every(text) || !text(job.cwd) || !isAbsolute(job.cwd)) fail('WORKER_JOB_INVALID')
  regular(job.cwd, true)
  await admitted(paths, jobSha256)
  regular(paths.jobPath)
  if (!readFileSync(paths.jobPath).equals(jobRaw)) fail('WORKER_JOB_CHANGED')
  // No child spawn, command evaluation or test body occurs above this gate.
  await execute(job, jobSha256, paths.resultPath)
} catch (error) {
  const code = error instanceof Error && /^WORKER_[A-Z_]+$/.test(error.message) ? error.message : 'WORKER_TECHNICAL_FAILURE'
  process.stderr.write(code + '\n')
  process.exitCode = 1
}
