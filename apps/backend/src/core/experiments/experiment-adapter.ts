import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { JsonObject, JsonValue } from '#protocol/runtime-protocol'

import type {
  ExperimentAdapterEvaluation,
  ExperimentAdapterSnapshot,
} from '#core/experiments/types'

export type ExperimentAdapterPhase = 'prepare' | 'evaluate' | 'cleanup' | 'aggregate'

interface ExperimentAdapterManifest {
  version: 1
  runner: {
    type: 'stdio'
    entry: string
  }
  timeout_ms?: number
  phases?: ExperimentAdapterPhase[]
}

interface AdapterResponse {
  id?: string
  ok?: boolean
  result?: unknown
  error?: string
}

const MANIFEST_PATH = '.capybara/experiment-adapter.json'
const DEFAULT_TIMEOUT_MS = 10 * 60_000
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function jsonValue(value: unknown, field: string): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue
  } catch {
    throw new Error(`${field} must be JSON serializable`)
  }
}

function manifestValue(value: unknown): ExperimentAdapterManifest {
  if (!isObject(value) || value.version !== 1 || !isObject(value.runner)) {
    throw new Error('experiment adapter manifest must contain version 1 and a runner')
  }
  if (value.runner.type !== 'stdio' || typeof value.runner.entry !== 'string' || !value.runner.entry.trim()) {
    throw new Error('experiment adapter runner must use stdio with a non-empty entry')
  }
  const timeoutMs = value.timeout_ms ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || Number(timeoutMs) < 100 || Number(timeoutMs) > 60 * 60_000) {
    throw new Error('experiment adapter timeout_ms must be an integer between 100 and 3600000')
  }
  const supported = new Set<ExperimentAdapterPhase>(['prepare', 'evaluate', 'cleanup', 'aggregate'])
  const phases = value.phases ?? ['prepare', 'evaluate', 'cleanup']
  if (!Array.isArray(phases) || phases.some((item) => typeof item !== 'string' || !supported.has(item as ExperimentAdapterPhase))) {
    throw new Error('experiment adapter phases contains an unsupported phase')
  }
  const normalizedPhases = [...new Set(phases as ExperimentAdapterPhase[])]
  if (!normalizedPhases.includes('evaluate')) throw new Error('experiment adapter must support evaluate')
  return {
    version: 1,
    runner: { type: 'stdio', entry: value.runner.entry.trim() },
    timeout_ms: Number(timeoutMs),
    phases: normalizedPhases,
  }
}

export class ExperimentAdapterRunner {
  readonly manifestFile: string
  readonly entryFile: string
  readonly timeoutMs: number
  readonly phases: ExperimentAdapterPhase[]
  readonly revision: string

  static load(projectDir: string): ExperimentAdapterRunner | undefined {
    const manifestFile = path.join(path.resolve(projectDir), MANIFEST_PATH)
    return fs.existsSync(manifestFile) ? new ExperimentAdapterRunner(projectDir) : undefined
  }

  constructor(readonly projectDir: string) {
    this.projectDir = path.resolve(projectDir)
    this.manifestFile = path.join(this.projectDir, MANIFEST_PATH)
    if (!fs.existsSync(this.manifestFile)) throw new Error(`experiment adapter manifest was not found: ${MANIFEST_PATH}`)
    const manifestSource = fs.readFileSync(this.manifestFile, 'utf8')
    const manifest = manifestValue(JSON.parse(manifestSource) as unknown)
    if (path.isAbsolute(manifest.runner.entry)) throw new Error('experiment adapter entry must be project-relative')
    const entryFile = path.resolve(this.projectDir, manifest.runner.entry)
    if (!inside(this.projectDir, entryFile)) throw new Error('experiment adapter entry leaves the project')
    const realProject = fs.realpathSync(this.projectDir)
    const realEntry = fs.realpathSync(entryFile)
    if (!inside(realProject, realEntry) || !fs.statSync(realEntry).isFile()) {
      throw new Error('experiment adapter entry must be a file inside the project')
    }
    this.entryFile = realEntry
    this.timeoutMs = manifest.timeout_ms ?? DEFAULT_TIMEOUT_MS
    this.phases = manifest.phases ?? ['prepare', 'evaluate', 'cleanup']
    this.revision = createHash('sha256')
      .update(manifestSource)
      .update('\0')
      .update(fs.readFileSync(this.entryFile))
      .digest('hex')
  }

  snapshot(): ExperimentAdapterSnapshot {
    return {
      type: 'project',
      manifest: MANIFEST_PATH,
      entry: path.relative(this.projectDir, this.entryFile).replaceAll('\\', '/'),
      revision: this.revision,
      timeoutMs: this.timeoutMs,
      phases: [...this.phases],
    }
  }

  supports(phase: ExperimentAdapterPhase): boolean {
    return this.phases.includes(phase)
  }

  async invoke(
    phase: ExperimentAdapterPhase,
    payload: JsonObject,
    options: { signal?: AbortSignal } = {},
  ): Promise<JsonValue> {
    if (!this.supports(phase)) throw new Error(`experiment adapter does not support ${phase}`)
    const id = randomUUID()
    const started = Date.now()
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('experiment adapter call aborted')
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [this.entryFile], {
        cwd: path.dirname(this.entryFile),
        env: {
          ...process.env,
          CAPYBARA_PROJECT_DIR: this.projectDir,
          CAPYBARA_EXPERIMENT_PHASE: phase,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (error?: Error, value?: JsonValue) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve(value ?? null)
      }
      const abort = () => {
        child.kill()
        finish(options.signal?.reason instanceof Error ? options.signal.reason : new Error('experiment adapter call aborted'))
      }
      const timer = setTimeout(() => {
        child.kill()
        finish(new Error(`experiment adapter ${phase} exceeded ${this.timeoutMs} ms`))
      }, this.timeoutMs)
      options.signal?.addEventListener('abort', abort, { once: true })
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk
        if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
          child.kill()
          finish(new Error(`experiment adapter ${phase} output exceeded ${MAX_OUTPUT_BYTES} bytes`))
        }
      })
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk
        if (Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) stderr = stderr.slice(-MAX_OUTPUT_BYTES)
      })
      child.once('error', (error) => finish(error))
      child.once('close', (code) => {
        if (settled) return
        if (code !== 0) {
          let response: AdapterResponse | undefined
          try {
            response = JSON.parse(stdout) as AdapterResponse
          } catch {}
          finish(new Error(
            response?.error
              || stderr.trim()
              || `experiment adapter ${phase} exited with code ${code}`,
          ))
          return
        }
        let response: AdapterResponse
        try {
          response = JSON.parse(stdout) as AdapterResponse
        } catch {
          finish(new Error(`experiment adapter ${phase} did not return valid JSON`))
          return
        }
        if (response.id !== undefined && response.id !== id) {
          finish(new Error(`experiment adapter ${phase} response id does not match`))
          return
        }
        if (response.ok !== true) {
          finish(new Error(response.error || `experiment adapter ${phase} reported an error`))
          return
        }
        try {
          finish(undefined, jsonValue(response.result ?? null, `experiment adapter ${phase} result`))
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      })
      child.stdin.end(JSON.stringify({ version: 1, id, phase, payload, startedAt: new Date(started).toISOString() }))
    })
  }

  async evaluate(payload: JsonObject, options: { signal?: AbortSignal } = {}): Promise<ExperimentAdapterEvaluation> {
    const value = await this.invoke('evaluate', payload, options)
    if (!isObject(value)) throw new Error('experiment adapter evaluate result must be an object')
    if (typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < 0 || value.score > 1) {
      throw new Error('experiment adapter score must be a number between 0 and 1')
    }
    if (typeof value.passed !== 'boolean') throw new Error('experiment adapter passed must be a boolean')
    if (typeof value.rationale !== 'string' || !value.rationale.trim()) {
      throw new Error('experiment adapter rationale must be a non-empty string')
    }
    if (value.metrics !== undefined && !isObject(value.metrics)) {
      throw new Error('experiment adapter metrics must be an object')
    }
    return {
      score: value.score,
      passed: value.passed,
      rationale: value.rationale.trim(),
      metrics: (value.metrics ?? {}) as JsonObject,
      ...(value.details === undefined ? {} : { details: jsonValue(value.details, 'experiment adapter details') }),
    }
  }
}
