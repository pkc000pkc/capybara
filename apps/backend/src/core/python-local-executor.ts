import { spawn } from 'node:child_process'
import path from 'node:path'

import type { ProviderResult, PythonAnalysisExecutor, PythonAnalysisResult, ResearchEvidenceInput } from '#core/market-research-service'

export type PythonProcessResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}

export type PythonProcessRunner = (input: { executable: string; scriptPath: string; workspaceDir: string; stdin: string; timeoutMs: number }) => Promise<PythonProcessResult>

export type PythonLocalExecutorOptions = {
  workspaceDir: string
  scriptPath: string
  pythonExecutable?: string
  timeoutMs?: number
  runProcess?: PythonProcessRunner
  now?: () => string
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function defaultRunProcess(input: { executable: string; scriptPath: string; workspaceDir: string; stdin: string; timeoutMs: number }): Promise<PythonProcessResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(input.executable, [input.scriptPath], { cwd: input.workspaceDir, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve({ stdout, stderr, exitCode: null, timedOut: true })
    }, input.timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr: `${stderr}${error.message}`, exitCode: null, timedOut: false })
    })
    child.on('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode, timedOut: false })
    })
    child.stdin.end(input.stdin)
  })
}

function evidence(input: { executable: string; scriptPath: string; runId: string; result: PythonProcessResult; now: string }): ResearchEvidenceInput {
  return { kind: 'python-analysis', source: 'python-local-executor', locator: input.scriptPath, summary: `Python process exit=${input.result.exitCode ?? 'unknown'}${input.result.timedOut ? ' timeout' : ''}`, payload: { executable: input.executable, scriptPath: input.scriptPath, runId: input.runId, capturedAt: input.now, stdout: input.result.stdout, stderr: input.result.stderr, exitCode: input.result.exitCode, timedOut: input.result.timedOut } }
}

export class PythonLocalAnalysisExecutor implements PythonAnalysisExecutor {
  private readonly options: PythonLocalExecutorOptions
  private readonly runProcess: PythonProcessRunner
  private readonly now: () => string

  constructor(options: PythonLocalExecutorOptions) {
    if (!inside(options.workspaceDir, options.scriptPath)) throw new Error('python script must stay inside workspaceDir')
    this.options = options
    this.runProcess = options.runProcess ?? defaultRunProcess
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async analyze(input: { ticker: string; marketData: unknown; reports: unknown; runId: string }): Promise<ProviderResult<PythonAnalysisResult>> {
    const result = await this.runProcess({ executable: this.options.pythonExecutable ?? 'python', scriptPath: this.options.scriptPath, workspaceDir: this.options.workspaceDir, stdin: JSON.stringify(input), timeoutMs: this.options.timeoutMs ?? 30_000 })
    const proof = evidence({ executable: this.options.pythonExecutable ?? 'python', scriptPath: this.options.scriptPath, runId: input.runId, result, now: this.now() })
    if (result.timedOut) return { status: 'unknown', error: { code: 'PYTHON_TIMEOUT', message: `Python analysis exceeded ${this.options.timeoutMs ?? 30_000}ms`, retryable: true }, evidence: [proof] }
    if (result.exitCode === null) return { status: 'unknown', error: { code: 'PYTHON_UNAVAILABLE', message: result.stderr || 'Python process could not be started', retryable: true }, evidence: [proof] }
    if (result.exitCode !== 0) return { status: 'failed', error: { code: 'PYTHON_FAILED', message: result.stderr || `Python exited with ${result.exitCode}`, retryable: false }, evidence: [proof] }
    try {
      const value = JSON.parse(result.stdout) as PythonAnalysisResult
      if (value.ticker !== input.ticker || value.recommendation?.disposition !== 'for_review') throw new Error('Python output does not satisfy research result contract')
      return { status: 'succeeded', value, evidence: [proof] }
    } catch (error) {
      return { status: 'failed', error: { code: 'PYTHON_INVALID_OUTPUT', message: error instanceof Error ? error.message : String(error), retryable: false }, evidence: [proof] }
    }
  }
}

export function createPythonLocalAnalysisExecutor(options: PythonLocalExecutorOptions): PythonLocalAnalysisExecutor {
  return new PythonLocalAnalysisExecutor(options)
}
