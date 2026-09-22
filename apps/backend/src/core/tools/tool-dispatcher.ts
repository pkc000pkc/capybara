import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'

import { ToolRegistry } from '#core/tools/tool-registry'
import { toolNetworkRetrySettings, parseToolProgress, type ToolNetworkRetrySettings, type ToolProgress } from '#core/tools/network-retry'
import type {
  ToolCallErrorCode,
  ToolCallRequest,
  ToolCallResult,
} from '#core/tools/types'

const DEFAULT_OUTPUT_LIMIT = 5 * 1024 * 1024

interface DispatchOptions {
  signal?: AbortSignal
  onProgress?: (progress: ToolProgress) => void
  resolveArtifact?: (id: string) => unknown
}

interface DispatcherOptions {
  timeoutMs?: number
  outputLimitBytes?: number
  permissions?: readonly string[]
  networkRetry?: ToolNetworkRetrySettings
}

interface RunnerResponse {
  id?: string
  ok?: boolean
  result?: unknown
  error?: string | { code?: string; message?: string; [key: string]: unknown }
}

function now(): string {
  return new Date().toISOString()
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams): void {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

export class ToolDispatcher {
  private readonly timeoutMs: number
  private readonly outputLimitBytes: number
  private readonly permissions: Set<string>
  private readonly networkRetry: ToolNetworkRetrySettings
  private activeChild?: ChildProcessWithoutNullStreams
  private abortActive?: () => void

  constructor(
    private readonly registry: ToolRegistry,
    private readonly workspaceDir: string,
    options: DispatcherOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.outputLimitBytes = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT
    this.permissions = new Set(options.permissions ?? [])
    this.networkRetry = toolNetworkRetrySettings(options.networkRetry)
  }

  dispatch(request: ToolCallRequest, options: DispatchOptions = {}): Promise<ToolCallResult> {
    const startedAt = now()
    const started = Date.now()
    const fail = (code: ToolCallErrorCode, message: string, details?: unknown) => ({
      id: request.id,
      name: request.name,
      ok: false,
      error: { code, message, ...(details === undefined ? {} : { details }) },
      startedAt,
      completedAt: now(),
      durationMs: Date.now() - started,
    }) satisfies ToolCallResult

    const tool = this.registry.get(request.name)
    if (!tool) return Promise.resolve(fail('TOOL_NOT_FOUND', `unknown tool: ${request.name}`))
    const denied = tool.permissions.filter((permission) => !this.permissions.has(permission))
    if (denied.length > 0) {
      return Promise.resolve(fail('PERMISSION_DENIED', `tool permissions not granted: ${denied.join(', ')}`))
    }
    if (!tool.validateInput(request.arguments)) {
      return Promise.resolve(fail('INVALID_ARGUMENTS', 'tool arguments failed schema validation', tool.validateInput.errors))
    }
    if (options.signal?.aborted) return Promise.resolve(fail('ABORTED', 'tool call was aborted'))

    let boundArguments = request.arguments
    if (boundArguments && typeof boundArguments === 'object' && 'input_artifact' in boundArguments) {
      const args = boundArguments as Record<string, unknown>
      if (typeof args.input_artifact !== 'string' || args.input !== undefined || args.input_file !== undefined || !options.resolveArtifact) {
        return Promise.resolve(fail('INVALID_ARGUMENTS', 'Choose one input source; input_artifact requires a runtime session'))
      }
      try {
        const { input_artifact, ...rest } = args
        boundArguments = { ...rest, input: options.resolveArtifact(input_artifact as string) }
      } catch (error) {
        return Promise.resolve(fail('INVALID_ARGUMENTS', error instanceof Error ? error.message : String(error)))
      }
    }

    const retry = toolNetworkRetrySettings({ ...this.networkRetry, ...tool.networkRetry })
    // Request retries are subordinate to the configured whole-tool wall-clock
    // budget. Expanding this timeout made a single browser navigation last up
    // to the complete theoretical retry schedule (660 seconds by default).
    const timeoutMs = this.timeoutMs
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [tool.runnerEntry], {
        cwd: path.dirname(tool.runnerEntry),
        detached: process.platform !== 'win32',
        env: { ...process.env, CAPYBARA_PROJECT_DIR: path.resolve(this.workspaceDir),
          CAPYBARA_TOOL_NETWORK_RETRY: JSON.stringify(retry) },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.activeChild = child
      let stdout = ''
      let stderr = ''
      let progressBuffer = ''
      let settled = false
      let forcedError: ToolCallResult | undefined

      const finish = (result: ToolCallResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        if (this.activeChild === child) this.activeChild = undefined
        if (this.abortActive === abort) this.abortActive = undefined
        resolve(result)
      }
      const stop = (result: ToolCallResult) => {
        forcedError = result
        terminateProcessTree(child)
      }
      const abort = () => stop(fail('ABORTED', 'tool call was aborted'))
      const timer = timeoutMs === -1
        ? undefined
        : setTimeout(
            () => stop(fail('TIMEOUT', `tool call exceeded ${timeoutMs} ms`)),
            timeoutMs,
          )
      options.signal?.addEventListener('abort', abort, { once: true })
      this.abortActive = abort

      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk
        if (Buffer.byteLength(stdout) > this.outputLimitBytes) {
          stop(fail('OUTPUT_LIMIT', `tool output exceeded ${this.outputLimitBytes} bytes`))
        }
      })
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        progressBuffer += chunk
        let newline: number
        while ((newline = progressBuffer.indexOf('\n')) >= 0) {
          const progress = parseToolProgress(progressBuffer.slice(0, newline).trim())
          progressBuffer = progressBuffer.slice(newline + 1)
          if (progress && !settled) options.onProgress?.(progress)
        }
        if (progressBuffer.length > 8192) progressBuffer = ''
        stderr += chunk
        if (Buffer.byteLength(stderr) > this.outputLimitBytes) {
          stderr = stderr.slice(-this.outputLimitBytes)
        }
      })
      child.once('error', (error) => finish(fail('RUNNER_FAILED', error.message)))
      child.once('close', (code) => {
        if (forcedError) return finish(forcedError)
        if (code !== 0) return finish(fail('RUNNER_FAILED', stderr.trim() || `tool runner exited with code ${code}`))
        let response: RunnerResponse
        try {
          response = JSON.parse(stdout) as RunnerResponse
        } catch {
          return finish(fail('INVALID_RESPONSE', 'tool runner did not return valid JSON'))
        }
        if (response.id !== undefined && response.id !== request.id) {
          return finish(fail('INVALID_RESPONSE', 'tool response id does not match the request'))
        }
        if (response.ok !== true) {
          const error = response.error
          return finish(fail('RUNNER_FAILED', typeof error === 'string' ? error : error?.message || 'tool runner reported an error',
            typeof error === 'object' ? error : undefined))
        }
        if (tool.validateOutput && !tool.validateOutput(response.result)) {
          return finish(fail('INVALID_OUTPUT', 'tool output failed schema validation', tool.validateOutput.errors))
        }
        finish({
          id: request.id,
          name: request.name,
          ok: true,
          output: response.result,
          startedAt,
          completedAt: now(),
          durationMs: Date.now() - started,
        })
      })
      child.stdin.end(JSON.stringify({
        id: request.id,
        tool: request.name,
        arguments: boundArguments,
      }))
    })
  }

  abort(): void {
    this.abortActive?.()
  }
}
