import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import type { ToolCallResult } from '#core/tools/types'

const OUTPUT_LIMIT = 1024 * 1024

function nodeExecutable(): string {
  if (!process.versions.electron) return process.execPath
  return process.env.CAPYBARA_NODE_PATH || process.env.npm_node_execpath || process.env.NODE || 'node'
}

export class SkillScriptRunner {
  private activeChild?: ChildProcessWithoutNullStreams
  private abortActive?: () => void

  constructor(
    private readonly workspaceDir: string,
    private readonly timeoutMs: number,
  ) {}

  run(
    request: { id: string; name: string },
    script: string,
    argv: readonly string[],
    signal?: AbortSignal,
    authorize?: () => void,
  ): Promise<ToolCallResult> {
    const started = Date.now()
    const startedAt = new Date().toISOString()
    const fail = (code: 'PERMISSION_DENIED' | 'RUNNER_FAILED' | 'OUTPUT_LIMIT' | 'TIMEOUT' | 'ABORTED', message: string) => ({
      ...request,
      ok: false,
      error: { code, message },
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    }) satisfies ToolCallResult
    if (signal?.aborted) return Promise.resolve(fail('ABORTED', 'skill script was aborted'))
    try { authorize?.() }
    catch (error) { return Promise.resolve(fail('PERMISSION_DENIED', error instanceof Error ? error.message : String(error))) }

    return new Promise((resolve) => {
      const child = spawn(nodeExecutable(), [script, ...argv], {
        cwd: this.workspaceDir,
        env: { ...process.env, CAPYBARA_PROJECT_DIR: this.workspaceDir },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      this.activeChild = child
      let stdout = ''
      let stderr = ''
      let forced: ToolCallResult | undefined
      let settled = false
      const finish = (result: ToolCallResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (this.activeChild === child) this.activeChild = undefined
        if (this.abortActive === abort) this.abortActive = undefined
        resolve(result)
      }
      const stop = (result: ToolCallResult) => {
        forced = result
        child.kill()
      }
      const abort = () => stop(fail('ABORTED', 'skill script was aborted'))
      const timer = this.timeoutMs === -1
        ? undefined
        : setTimeout(
            () => stop(fail('TIMEOUT', `skill script exceeded ${this.timeoutMs} ms`)),
            this.timeoutMs,
          )
      this.abortActive = abort
      signal?.addEventListener('abort', abort, { once: true })
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk
        if (Buffer.byteLength(stdout) > OUTPUT_LIMIT) {
          stop(fail('OUTPUT_LIMIT', `skill script output exceeded ${OUTPUT_LIMIT} bytes`))
        }
      })
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk
        if (Buffer.byteLength(stderr) > OUTPUT_LIMIT) stderr = stderr.slice(-OUTPUT_LIMIT)
      })
      child.once('error', (error) => finish(fail('RUNNER_FAILED', error.message)))
      child.once('close', (exitCode) => {
        if (forced) return finish(forced)
        if (exitCode !== 0) return finish(fail('RUNNER_FAILED', stderr.trim() || `skill script exited with code ${exitCode}`))
        finish({
          ...request,
          ok: true,
          output: { stdout, stderr, exitCode: exitCode ?? 0 },
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
        })
      })
      child.stdin.end()
    })
  }

  abort(): void {
    this.abortActive?.()
  }
}
