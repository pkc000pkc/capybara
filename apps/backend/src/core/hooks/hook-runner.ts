import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'

import { compileHookSource } from '#core/hooks/hook-registry'
import type {
  HookFixture,
  HookRunResult,
  RegisteredHook,
} from '#core/hooks/types'
import type { JsonValue } from '#protocol/runtime-protocol'
import type { RuntimeLlm } from '#core/runtime-loop'
import type { LlmChatRequest, LlmMessage, LlmUsage } from '#util/llm'

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const pending = new Map();
const logs = [];
let rpcCounter = 0;

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = 'rpc-' + (++rpcCounter);
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: 'rpc', id, method, params });
  });
}

parentPort.on('message', (message) => {
  if (message.type !== 'rpc-result') return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.ok) waiter.resolve(message.result);
  else waiter.reject(new Error(message.error || 'Hook RPC failed'));
});

function log(level, message, data) {
  logs.push({ level, message: String(message), ...(data === undefined ? {} : { data }) });
}

(async () => {
  const module = { exports: {} };
  const defineHook = (value) => value;
  const requireHook = (specifier) => {
    if (specifier !== '@capybara-agent/sdk') throw new Error('unsupported Hook import: ' + specifier);
    return { defineHook };
  };
  const factory = new Function('module', 'exports', 'require', workerData.compiled);
  factory(module, module.exports, requireHook);
  const hook = module.exports.default;
  if (!hook || typeof hook.trigger !== 'function' || typeof hook.run !== 'function') {
    throw new Error('Hook file must default export defineHook({...})');
  }
  const changed = new Set(workerData.fixture.changedVariables);
  const triggerContext = {
    checkpoint: workerData.fixture.checkpoint,
    status: workerData.fixture.status,
    changed,
    variables: workerData.fixture.variables,
    loop: {
      runId: workerData.runId,
      iteration: workerData.fixture.loopIteration,
      terminal: workerData.fixture.loopTerminal === true,
    },
    messages: workerData.fixture.messages,
    ...(workerData.fixture.training ? { training: workerData.fixture.training } : {}),
  };
  const matched = hook.enabled === true && hook.trigger(triggerContext);
  if (matched && typeof matched.then === 'function') throw new Error('Hook trigger must be synchronous');
  if (!matched) {
    parentPort.postMessage({ type: 'done', matched: false, logs });
    return;
  }
  const llm = workerData.permissions.llm === 'project' ? {
    defaultModel: workerData.defaultModel,
    responses: {
      create: (request) => rpc('llm.responses.create', request),
    },
  } : undefined;
  const logger = {
    debug: (message, data) => log('debug', message, data),
    info: (message, data) => log('info', message, data),
    warn: (message, data) => log('warn', message, data),
    error: (message, data) => log('error', message, data),
  };
  const controller = new AbortController();
  const result = await hook.run({
    ...triggerContext,
    llm,
    signal: controller.signal,
    logger,
  });
  parentPort.postMessage({ type: 'done', matched: true, result: result || {}, logs });
})().catch((error) => {
  parentPort.postMessage({
    type: 'error',
    error: error && error.stack ? error.stack : String(error),
    logs,
  });
});
`

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function responseMessages(value: unknown): LlmMessage[] {
  if (typeof value === 'string') return [{ role: 'user', content: value }]
  if (!Array.isArray(value)) throw new Error('llm.responses.create input must be a string or message array')
  return value.map((item, index) => {
    if (!isObject(item) || !['system', 'user', 'assistant', 'tool'].includes(String(item.role))) {
      throw new Error(`llm.responses.create input[${index}] has an invalid role`)
    }
    const content = typeof item.content === 'string'
      ? item.content
      : Array.isArray(item.content)
        ? item.content.map((part) => isObject(part) && typeof part.text === 'string' ? part.text : '').join('')
        : ''
    return { role: item.role as LlmMessage['role'], content }
  })
}

function toResponseUsage(usage?: LlmUsage) {
  return {
    input_tokens: usage?.inputTokens ?? 0,
    output_tokens: usage?.outputTokens ?? 0,
    total_tokens: usage?.totalTokens ?? 0,
    cache_read_tokens: usage?.cacheReadTokens ?? 0,
  }
}

interface WorkerDone {
  matched: boolean
  result?: unknown
  logs?: HookRunResult['logs']
}

export interface HookRunLimits {
  maxTotalTokens?: number
}

class HookAttemptError extends Error {
  constructor(
    error: unknown,
    readonly usage: LlmUsage,
  ) {
    super(error instanceof Error ? error.message : String(error), { cause: error })
    this.name = 'HookAttemptError'
  }
}

export class HookRunError extends Error {
  constructor(
    error: unknown,
    readonly usage: LlmUsage,
    readonly attempts: number,
  ) {
    super(error instanceof Error ? error.message : String(error), { cause: error })
    this.name = 'HookRunError'
  }
}

function addUsage(left: LlmUsage, right: LlmUsage): LlmUsage {
  return {
    inputTokens: (left.inputTokens ?? 0) + (right.inputTokens ?? 0),
    outputTokens: (left.outputTokens ?? 0) + (right.outputTokens ?? 0),
    totalTokens: (left.totalTokens ?? 0) + (right.totalTokens ?? 0),
    cacheReadTokens: (left.cacheReadTokens ?? 0) + (right.cacheReadTokens ?? 0),
  }
}

export class HookRunner {
  constructor(private readonly llm: RuntimeLlm) {}

  async run(
    hook: RegisteredHook,
    fixture: HookFixture,
    signal?: AbortSignal,
    limits: HookRunLimits = {},
  ): Promise<HookRunResult> {
    if (!hook.loadable) throw new Error(`Hook is not loadable: ${hook.id}`)
    const attempts = hook.schedule.onError === 'retry' ? 2 : 1
    let lastError: unknown
    let cumulativeUsage: LlmUsage = {}
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const remainingTokens = limits.maxTotalTokens === undefined
        ? undefined
        : limits.maxTotalTokens - (cumulativeUsage.totalTokens ?? 0)
      if (remainingTokens !== undefined && remainingTokens <= 0) {
        throw new HookRunError('Hook token budget was exhausted before retry.', cumulativeUsage, attempt - 1)
      }
      try {
        const result = await this.runAttempt(hook, fixture, signal, remainingTokens)
        return { ...result, attempts: attempt, usage: addUsage(cumulativeUsage, result.usage) }
      } catch (error) {
        const attemptUsage = error instanceof HookAttemptError ? error.usage : {}
        cumulativeUsage = addUsage(cumulativeUsage, attemptUsage)
        lastError = error instanceof HookAttemptError ? error.cause ?? error : error
        if (signal?.aborted) break
      }
    }
    throw new HookRunError(lastError, cumulativeUsage, attempts)
  }

  private runAttempt(
    hook: RegisteredHook,
    fixture: HookFixture,
    signal?: AbortSignal,
    maxTotalTokens?: number,
  ): Promise<Omit<HookRunResult, 'attempts'>> {
    const started = Date.now()
    const usage: LlmUsage = {}
    const compiled = compileHookSource(hook.source, hook.entryFile)
    const runId = fixture.runId || `hook-${randomUUID()}`
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Hook execution was aborted'))
      const attemptController = new AbortController()
      const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
          compiled,
          fixture,
          permissions: hook.permissions,
          defaultModel: this.llm.getConfig().model,
          runId,
        },
      })
      let settled = false
      const finish = (error?: unknown, value?: WorkerDone) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (error) attemptController.abort()
        void worker.terminate()
        if (error) return reject(new HookAttemptError(error, usage))
        resolve({
          matched: value?.matched === true,
          ...(value?.result === undefined ? {} : { result: value.result as HookRunResult['result'] }),
          durationMs: Date.now() - started,
          usage,
          logs: value?.logs ?? [],
        })
      }
      const abort = () => finish(new Error('Hook execution was aborted'))
      const timer = setTimeout(
        () => finish(new Error(`Hook exceeded ${hook.schedule.timeoutMs} ms`)),
        hook.schedule.timeoutMs,
      )
      signal?.addEventListener('abort', abort, { once: true })
      worker.on('message', (message: unknown) => {
        if (!isObject(message)) return
        if (message.type === 'rpc') {
          void this.handleRpc(message, attemptController.signal, usage, maxTotalTokens).then(
            (result) => {
              if (!settled) worker.postMessage({ type: 'rpc-result', id: message.id, ok: true, result })
            },
            (error) => {
              if (!settled) worker.postMessage({
                type: 'rpc-result',
                id: message.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              })
            },
          )
          return
        }
        if (message.type === 'done') finish(undefined, message as unknown as WorkerDone)
        if (message.type === 'error') finish(new Error(String(message.error ?? 'Hook worker failed')))
      })
      worker.once('error', (error) => finish(error))
      worker.once('exit', (code) => {
        if (!settled && code !== 0) finish(new Error(`Hook worker exited with code ${code}`))
      })
    })
  }

  private async handleRpc(
    message: Record<string, unknown>,
    signal: AbortSignal | undefined,
    usage: LlmUsage,
    maxTotalTokens?: number,
  ): Promise<JsonValue> {
    if (message.method !== 'llm.responses.create' || !isObject(message.params)) {
      throw new Error(`unsupported Hook RPC method: ${String(message.method)}`)
    }
    const remainingTokens = maxTotalTokens === undefined
      ? undefined
      : maxTotalTokens - (usage.totalTokens ?? 0)
    if (remainingTokens !== undefined && remainingTokens <= 0) {
      throw new Error('Hook token budget was exhausted.')
    }
    const requestedOutputTokens = typeof message.params.max_output_tokens === 'number'
      ? message.params.max_output_tokens
      : undefined
    const maxTokens = remainingTokens === undefined
      ? requestedOutputTokens
      : Math.max(1, Math.min(requestedOutputTokens ?? remainingTokens, remainingTokens))
    const request: LlmChatRequest = {
      messages: responseMessages(message.params.input),
      ...(typeof message.params.model === 'string' ? { model: message.params.model } : {}),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      signal,
    }
    const response = await this.llm.chat(request)
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens'] as const) {
      if (response.usage?.[key] !== undefined) usage[key] = (usage[key] ?? 0) + Number(response.usage[key])
    }
    return {
      output_text: response.text,
      model: response.model,
      provider: response.provider,
      finish_reason: response.finishReason ?? null,
      usage: toResponseUsage(response.usage),
    }
  }
}
