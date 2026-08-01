import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import nunjucks from 'nunjucks'

import { DatasetStore, type DatasetRecord } from '#core/datasets/dataset-store'
import { ExperimentAdapterRunner } from '#core/experiments/experiment-adapter'
import {
  EMPTY_EXPERIMENT_METRICS,
  ExperimentStore,
  type CreateExperimentCase,
} from '#core/experiments/experiment-store'
import type {
  ExperimentCaseDetail,
  ExperimentCaseSummary,
  ExperimentCaseStatus,
  ExperimentCompatibilityIssue,
  ExperimentComparison,
  ExperimentFailure,
  ExperimentMetrics,
  ExperimentRunDetail,
  ExperimentRunSummary,
  ExperimentStatus,
  ExperimentToolCall,
  ExperimentToolStatus,
  ExperimentTrace,
  ExperimentTrend,
  ExperimentUsage,
} from '#core/experiments/types'
import { ProjectGitService } from '#core/project-git'
import { ProjectResources } from '#core/project-resources'
import { RuntimeLoop, type RuntimeLlm, type RuntimeLoopOptions } from '#core/runtime-loop'
import type { ChannelEvent, ClientCommand, RunState } from '#protocol/runtime-protocol'
import type { JsonObject, JsonValue } from '#protocol/runtime-protocol'
import { createLlmService, type LlmChatResponse, type LlmUsage } from '#util/llm'

export interface CreateExperimentInput {
  datasetId?: unknown
  name?: unknown
  concurrency?: unknown
  repetitions?: unknown
  timeoutMs?: unknown
  keepWorkspaces?: unknown
  sampleIds?: unknown
}

export interface ExperimentManagerOptions {
  llm?: RuntimeLlm
  runtimeLoop?: Omit<RuntimeLoopOptions, 'projectDir' | 'workspaceDir' | 'initialState' | 'llm'>
}

type ActiveExperiment = {
  controller: AbortController
  loops: Set<RuntimeLoop>
  llm: RuntimeLlm
  done?: Promise<void>
}

type ScoreResult = {
  score: number
  passed: boolean
  rationale: string
  response: LlmChatResponse
  prompt: string
}

const TERMINAL_RUN_STATUSES = new Set<RunState['status']>(['completed', 'failed', 'cancelled'])
const DEFAULT_TIMEOUT_MS = 10 * 60_000
const MAX_EXPERIMENT_CASES = 10_000

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`)
  return value.trim()
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, field: string): number {
  const resolved = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`)
  }
  return resolved
}

function hash(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
}

function jsonObject(value: unknown): JsonObject {
  const normalized = JSON.parse(JSON.stringify(value)) as unknown
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new Error('experiment value must be a JSON object')
  }
  return normalized as JsonObject
}

function usage(value?: LlmUsage): ExperimentUsage {
  return {
    inputTokens: value?.inputTokens ?? 0,
    outputTokens: value?.outputTokens ?? 0,
    totalTokens: value?.totalTokens ?? (value?.inputTokens ?? 0) + (value?.outputTokens ?? 0),
    cacheReadTokens: value?.cacheReadTokens ?? 0,
  }
}

function addUsage(left: ExperimentUsage, right: ExperimentUsage): ExperimentUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
  }
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * ratio) - 1))] ?? 0
}

function toolStatus(expectedTools: string[], actualTools: string[]): ExperimentToolStatus {
  const expected = new Set(expectedTools)
  const actual = new Set(actualTools)
  if (expected.size === 0 && actual.size === 0) return 'none'
  if ([...expected].some((name) => !actual.has(name))) return 'missed'
  if ([...actual].some((name) => !expected.has(name))) return 'unexpected'
  return 'hit'
}

function evaluatorKey(run: ExperimentRunSummary): string {
  return run.evaluator.type === 'project'
    ? `project:${run.evaluator.revision}`
    : `llm:${run.dataset.scoringPromptHash}`
}

function compatibilityIssues(left: ExperimentRunSummary, right: ExperimentRunSummary): ExperimentCompatibilityIssue[] {
  const issues: ExperimentCompatibilityIssue[] = []
  if (left.dataset.cohortHash !== right.dataset.cohortHash) issues.push('sample_cohort')
  if (left.config.repetitions !== right.config.repetitions) issues.push('repetitions')
  if (evaluatorKey(left) !== evaluatorKey(right)) issues.push('evaluator')
  return issues
}

function failure(error: unknown, code = 'EXPERIMENT_CASE_FAILED'): ExperimentFailure {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const candidate = error as { code?: unknown; message?: unknown; phase?: unknown; retryable?: unknown }
    return {
      code: typeof candidate.code === 'string' ? candidate.code : code,
      message: typeof candidate.message === 'string' ? candidate.message : String(error),
      ...(typeof candidate.phase === 'string' ? { phase: candidate.phase } : {}),
      ...(typeof candidate.retryable === 'boolean' ? { retryable: candidate.retryable } : {}),
    }
  }
  return { code, message: error instanceof Error ? error.message : String(error) }
}

function scoreResponse(response: LlmChatResponse): { score: number; passed: boolean; rationale: string } {
  let value: unknown
  try {
    value = JSON.parse(response.text)
  } catch {
    throw new Error('scorer response must be one JSON object')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('scorer response must be an object')
  }
  const result = value as Record<string, unknown>
  if (typeof result.score !== 'number' || !Number.isFinite(result.score) || result.score < 0 || result.score > 1) {
    throw new Error('scorer response score must be a number between 0 and 1')
  }
  if (typeof result.passed !== 'boolean') throw new Error('scorer response passed must be a boolean')
  if (typeof result.rationale !== 'string' || !result.rationale.trim()) {
    throw new Error('scorer response rationale must be a non-empty string')
  }
  return { score: result.score, passed: result.passed, rationale: result.rationale.trim() }
}

function messageText(message: { content: Array<{ type: string; text?: string }> } | undefined): string {
  return message?.content.map((item) => item.type === 'text' ? item.text ?? '' : '').join('\n').trim() ?? ''
}

export class ExperimentManager {
  readonly store: ExperimentStore
  private readonly datasets: DatasetStore
  private readonly providedLlm?: RuntimeLlm
  private readonly runtimeLoopOptions: ExperimentManagerOptions['runtimeLoop']
  private readonly active = new Map<string, ActiveExperiment>()
  private readonly scoringEnvironment = new nunjucks.Environment(undefined, {
    autoescape: false,
    throwOnUndefined: true,
  })

  constructor(readonly projectDir: string, options: ExperimentManagerOptions = {}) {
    this.projectDir = path.resolve(projectDir)
    this.store = new ExperimentStore(this.projectDir)
    this.datasets = new DatasetStore(this.projectDir)
    this.runtimeLoopOptions = options.runtimeLoop
    this.providedLlm = options.llm
  }

  async create(input: CreateExperimentInput): Promise<ExperimentRunDetail> {
    const datasetId = requiredString(input.datasetId, 'datasetId')
    const dataset = this.datasets.get(datasetId)
    const adapter = ExperimentAdapterRunner.load(this.projectDir)
    if (!adapter && !dataset.scoringPrompt.trim()) {
      throw new Error('dataset scoringPrompt is required before starting an experiment without a project adapter')
    }
    const records = this.allDatasetRecords(datasetId)
    if (records.length === 0) throw new Error('dataset must contain at least one sample')
    const sampleIds = this.sampleIds(input.sampleIds, records)
    const selected = sampleIds.length
      ? records.filter((record) => sampleIds.includes(record.id))
      : records
    const concurrency = boundedInteger(input.concurrency, 1, 1, 4, 'concurrency')
    const repetitions = boundedInteger(input.repetitions, 1, 1, 20, 'repetitions')
    const timeoutMs = boundedInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 60 * 60_000, 'timeoutMs')
    const keepWorkspaces = input.keepWorkspaces === undefined ? false : input.keepWorkspaces
    if (typeof keepWorkspaces !== 'boolean') throw new Error('keepWorkspaces must be a boolean')
    const totalCases = selected.length * repetitions
    if (totalCases > MAX_EXPERIMENT_CASES) {
      throw new Error(`experiment cannot exceed ${MAX_EXPERIMENT_CASES} cases`)
    }
    const git = await new ProjectGitService(this.projectDir).status()
    if (!git.gitAvailable || !git.initialized || !git.head?.projectTreeSha) {
      throw new Error('project must have a readable Git commit before starting an experiment')
    }
    if (!git.clean) throw new Error('project must be clean before starting an experiment')
    const llm = this.providedLlm ?? this.projectLlm()
    const config = llm.getConfig()
    const createdAt = new Date().toISOString()
    const id = randomUUID()
    const datasetContentHash = hash({
      id: dataset.id,
      version: dataset.version,
      scoringPrompt: dataset.scoringPrompt,
      records: records.map((record) => ({
        id: record.id,
        question: record.question,
        thinking: record.thinking,
        answer: record.answer,
        expectedTools: record.expectedTools,
        metadata: record.metadata,
      })),
    })
    const cohortHash = hash(selected.map((record) => ({
      id: record.id,
      question: record.question,
      thinking: record.thinking,
      answer: record.answer,
      expectedTools: record.expectedTools,
      metadata: record.metadata,
    })))
    const runConfig = { concurrency, repetitions, timeoutMs, keepWorkspaces, sampleIds: selected.map((record) => record.id) }
    const cases: CreateExperimentCase[] = []
    let ordinal = 0
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      for (const record of selected) {
        cases.push({
          id: randomUUID(),
          runId: id,
          sampleId: record.id,
          repetition,
          ordinal: ordinal++,
          question: record.question,
          thinking: record.thinking,
          expectedAnswer: record.answer,
          expectedTools: record.expectedTools,
          metadata: jsonObject(record.metadata),
          createdAt,
        })
      }
    }
    const run = this.store.createRun({
      id,
      name: typeof input.name === 'string' && input.name.trim()
        ? input.name.trim()
        : `${dataset.name} · ${git.head.shortSha}`,
      dataset: {
        id: dataset.id,
        name: dataset.name,
        version: dataset.version,
        contentHash: datasetContentHash,
        cohortHash,
        scoringPromptHash: hash(dataset.scoringPrompt),
        samples: selected.length,
      },
      scoringPrompt: dataset.scoringPrompt,
      project: {
        commitSha: git.head.sha,
        shortSha: git.head.shortSha,
        treeSha: git.head.projectTreeSha,
        branch: git.branch,
      },
      model: {
        provider: config.provider,
        protocol: config.protocol,
        model: config.model,
        baseUrl: config.baseUrl,
      },
      evaluator: adapter?.snapshot() ?? { type: 'llm' },
      config: runConfig,
      totalCases,
      createdAt,
    }, cases)
    const active: ActiveExperiment = {
      controller: new AbortController(),
      loops: new Set<RuntimeLoop>(),
      llm,
    }
    this.active.set(id, active)
    active.done = Promise.resolve().then(() => this.executeRun(run, cases, active))
    return run
  }

  list(options: { datasetId?: string; status?: ExperimentStatus; limit?: number } = {}): ExperimentRunSummary[] {
    return this.store.listRuns(options)
  }

  get(id: string): ExperimentRunDetail {
    return this.store.getRun(id)
  }

  cases(id: string, options: { status?: ExperimentCaseStatus; offset?: number; limit?: number } = {}) {
    return this.store.listCases(id, options)
  }

  case(id: string, caseId: string): ExperimentCaseDetail {
    return this.store.getCase(id, caseId)
  }

  tools(id: string) {
    this.store.getRun(id)
    return this.store.toolAggregates(id)
  }

  capabilities() {
    const adapter = ExperimentAdapterRunner.load(this.projectDir)
    return {
      evaluator: adapter?.snapshot() ?? { type: 'llm' as const },
      scoringPromptRequired: !adapter,
    }
  }

  trends(datasetId: string): ExperimentTrend {
    if (!datasetId.trim()) throw new Error('datasetId is required')
    const completed = this.store.listRuns({ datasetId, status: 'completed', limit: 500 })
    const anchor = completed[0]
    if (!anchor) return { datasetId, runs: [], excluded: [] }
    const compatible: ExperimentRunSummary[] = []
    const excluded: ExperimentTrend['excluded'] = []
    for (const run of completed) {
      const issues = compatibilityIssues(anchor, run)
      if (issues.length === 0) compatible.push(run)
      else excluded.push({ run, issues })
    }
    return {
      datasetId,
      anchorRunId: anchor.id,
      runs: compatible.reverse(),
      excluded: excluded.reverse(),
    }
  }

  compare(datasetId: string, leftId: string, rightId: string): ExperimentComparison {
    if (!datasetId.trim()) throw new Error('datasetId is required')
    const left = this.store.getRun(leftId)
    const right = this.store.getRun(rightId)
    if (left.dataset.id !== datasetId || right.dataset.id !== datasetId) {
      throw new Error('both experiments must belong to the selected dataset')
    }
    if (left.status !== 'completed' || right.status !== 'completed') {
      throw new Error('only completed experiments can be compared')
    }
    const issues = compatibilityIssues(left, right)
    if (issues.length > 0) {
      throw new Error(`experiments are not comparable: ${issues.join(', ')}`)
    }
    const leftCases = this.allCases(left.id)
    const rightCases = this.allCases(right.id)
    const keys = new Set([...leftCases, ...rightCases].map((item) => item.sampleId))
    const samples = [...keys].sort().map((sampleId) => {
      const leftMatches = leftCases.filter((item) => item.sampleId === sampleId)
      const rightMatches = rightCases.filter((item) => item.sampleId === sampleId)
      const leftScore = this.averageScore(leftMatches)
      const rightScore = this.averageScore(rightMatches)
      const leftCase = leftMatches[0]
      const rightCase = rightMatches[0]
      return {
        sampleId,
        ...(leftCase ? { left: { caseId: leftCase.id, ...(leftScore === undefined ? {} : { score: leftScore }), status: leftCase.status } } : {}),
        ...(rightCase ? { right: { caseId: rightCase.id, ...(rightScore === undefined ? {} : { score: rightScore }), status: rightCase.status } } : {}),
        ...(leftScore === undefined || rightScore === undefined ? {} : { delta: rightScore - leftScore }),
      }
    })
    const leftTools = new Map(this.store.toolAggregates(left.id).map((item) => [item.name, item]))
    const rightTools = new Map(this.store.toolAggregates(right.id).map((item) => [item.name, item]))
    const toolNames = new Set([...leftTools.keys(), ...rightTools.keys()])
    return {
      dataset: right.dataset,
      left,
      right,
      samples,
      tools: [...toolNames].sort().map((name) => ({
        name,
        ...(leftTools.get(name) ? { left: leftTools.get(name) } : {}),
        ...(rightTools.get(name) ? { right: rightTools.get(name) } : {}),
      })),
    }
  }

  cancel(id: string): ExperimentRunDetail {
    const run = this.store.getRun(id)
    if (!['queued', 'running'].includes(run.status)) throw new Error('only a queued or running experiment can be cancelled')
    const active = this.active.get(id)
    if (!active) throw new Error('experiment is not active in this process')
    active.controller.abort(new Error('experiment cancelled'))
    return this.store.getRun(id)
  }

  delete(id: string): void {
    if (this.active.has(id)) throw new Error('active experiment cannot be deleted')
    this.store.deleteRun(id)
  }

  async shutdown(): Promise<void> {
    for (const active of this.active.values()) active.controller.abort(new Error('experiment manager stopped'))
    await Promise.allSettled([...this.active.values()].flatMap((active) => active.done ? [active.done] : []))
  }

  async close(): Promise<void> {
    await this.shutdown()
    this.store.close()
  }

  private async executeRun(run: ExperimentRunDetail, cases: CreateExperimentCase[], active: ActiveExperiment): Promise<void> {
    const startedAt = new Date().toISOString()
    try {
      this.store.startRun(run.id, startedAt)
      let nextIndex = 0
      const worker = async () => {
        while (!active.controller.signal.aborted) {
          const index = nextIndex++
          const item = cases[index]
          if (!item) return
          await this.executeCase(run, item, active)
        }
      }
      await Promise.all(Array.from(
        { length: Math.min(run.config.concurrency, cases.length) },
        () => worker(),
      ))
      const completedAt = new Date().toISOString()
      if (active.controller.signal.aborted) {
        const cancelled = { code: 'EXPERIMENT_CANCELLED', message: 'Experiment was cancelled.', phase: 'runtime', retryable: true }
        this.store.cancelQueuedCases(run.id, completedAt, cancelled)
        this.store.finishRun(run.id, 'cancelled', this.calculateMetrics(run), completedAt, cancelled)
      } else {
        const metrics = await this.aggregateMetrics(run)
        this.store.finishRun(run.id, 'completed', metrics, completedAt)
      }
    } catch (error) {
      const completedAt = new Date().toISOString()
      const runFailure = failure(error, 'EXPERIMENT_RUN_FAILED')
      this.store.cancelQueuedCases(run.id, completedAt, runFailure)
      this.store.finishRun(run.id, 'failed', this.calculateMetrics(run), completedAt, runFailure)
    } finally {
      for (const loop of active.loops) loop.close()
      active.loops.clear()
      this.active.delete(run.id)
      if (!run.config.keepWorkspaces) this.removeWorkspaceRoot(run.id)
    }
  }

  private async executeCase(run: ExperimentRunDetail, item: CreateExperimentCase, active: ActiveExperiment): Promise<void> {
    const startedAt = new Date().toISOString()
    const started = Date.now()
    this.store.startCase(item.id, startedAt)
    const workspaceDir = this.prepareWorkspace(run.id, item.id)
    const loop = new RuntimeLoop({
      ...this.runtimeLoopOptions,
      projectDir: workspaceDir,
      workspaceDir,
      llm: active.llm,
    })
    active.loops.add(loop)
    let adapter: ExperimentAdapterRunner | undefined
    let adapterPrepare: JsonValue | undefined
    let adapterCleaned = false
    const adapterPayload = (additional: JsonObject = {}) => jsonObject({
      run: {
        id: run.id,
        name: run.name,
        dataset: run.dataset,
        project: run.project,
        model: run.model,
        config: run.config,
      },
      case: {
        id: item.id,
        sampleId: item.sampleId,
        repetition: item.repetition,
        ordinal: item.ordinal,
        question: item.question,
        thinking: item.thinking,
        expectedAnswer: item.expectedAnswer,
        expectedTools: item.expectedTools,
        metadata: item.metadata,
      },
      workspaceDir,
      ...(adapterPrepare === undefined ? {} : { prepare: adapterPrepare }),
      ...additional,
    })
    const cleanupAdapter = async () => {
      if (!adapter || adapterCleaned || !adapter.supports('cleanup')) return
      adapterCleaned = true
      await adapter.invoke('cleanup', adapterPayload())
    }
    let abortTimer: NodeJS.Timeout | undefined
    const timeoutController = new AbortController()
    const cancel = () => {
      timeoutController.abort(active.controller.signal.reason)
      const snapshot = loop.getSnapshot(0)
      if (snapshot.run.runId && !TERMINAL_RUN_STATUSES.has(snapshot.run.status)) {
        try {
          this.command(loop, 'run.cancel', { reason: 'experiment cancelled' })
        } catch {
          loop.close()
        }
      }
    }
    active.controller.signal.addEventListener('abort', cancel, { once: true })
    try {
      if (run.evaluator.type === 'project') {
        adapter = new ExperimentAdapterRunner(workspaceDir)
        if (adapter.revision !== run.evaluator.revision) {
          throw new Error('experiment adapter revision does not match the run snapshot')
        }
        if (adapter.supports('prepare')) {
          adapterPrepare = await adapter.invoke('prepare', adapterPayload(), {
            signal: active.controller.signal,
          })
        }
        const publicMetadata = item.metadata.public
        const caseContext = jsonObject({
          version: 1,
          run: { id: run.id, name: run.name },
          case: {
            id: item.id,
            sampleId: item.sampleId,
            repetition: item.repetition,
            question: item.question,
            metadata: publicMetadata && typeof publicMetadata === 'object' && !Array.isArray(publicMetadata)
              ? publicMetadata
              : {},
          },
          adapter: adapterPrepare ?? null,
        })
        const caseFile = path.join(workspaceDir, '.capybara', 'experiment-case.json')
        fs.mkdirSync(path.dirname(caseFile), { recursive: true })
        fs.writeFileSync(caseFile, `${JSON.stringify(caseContext, null, 2)}\n`, 'utf8')
      }
      const terminal = new Promise<RunState>((resolve, reject) => {
        const unsubscribe = loop.onEvent((event) => {
          if (event.type === 'run.state.changed' && TERMINAL_RUN_STATUSES.has(event.payload.status)) {
            unsubscribe()
            resolve(event.payload)
          }
        })
        abortTimer = setTimeout(() => {
          timeoutController.abort()
          try {
            this.command(loop, 'run.cancel', { reason: 'experiment case timed out' })
          } catch {
            loop.close()
          }
          unsubscribe()
          reject(new Error(`experiment case exceeded ${run.config.timeoutMs} ms`))
        }, run.config.timeoutMs)
      })
      this.command(loop, 'chat.message.send', {
        clientMessageId: `experiment-${item.id}`,
        content: [{ type: 'text', text: item.question }],
        autoStart: true,
      })
      const runState = await terminal
      if (abortTimer) clearTimeout(abortTimer)
      const state = loop.exportState()
      const snapshot = state.snapshot
      const runtimeRunId = runState.runId ?? undefined
      const assistant = [...snapshot.conversation.messages].reverse().find(
        (message) => message.role === 'assistant' && (!runtimeRunId || message.requestId === runtimeRunId),
      )
      const actualAnswer = messageText(assistant)
      const observations = snapshot.observations.items.filter(
        (observation) => !runtimeRunId || observation.runId === runtimeRunId,
      )
      const actualTools = observations.map((observation) => observation.toolName)
      const toolCalls: ExperimentToolCall[] = observations.map((observation) => ({
        callId: observation.callId,
        name: observation.toolName,
        status: observation.status === 'completed' ? 'completed' : 'failed',
        arguments: observation.arguments,
        ...(observation.resultPreview ? { resultPreview: observation.resultPreview } : {}),
        ...(observation.error === undefined ? {} : { error: observation.error }),
        startedAt: observation.startedAt,
        ...(observation.completedAt ? { completedAt: observation.completedAt } : {}),
        ...(observation.durationMs === undefined ? {} : { durationMs: observation.durationMs }),
      }))
      const trace: ExperimentTrace = {
        ...(runtimeRunId ? { runtimeRunId } : {}),
        ...(runState.failure ? { failure: runState.failure } : {}),
        timeline: snapshot.timeline.steps,
        observations,
        effectiveContexts: snapshot.effectiveContexts.items.filter(
          (context) => !runtimeRunId || context.runId === runtimeRunId,
        ),
        artifacts: state.artifacts
          .filter((artifact) => !runtimeRunId || artifact.meta.runId === runtimeRunId)
          .map((artifact) => ({ meta: artifact.meta, value: artifact.value })),
        renderedMessages: snapshot.renderResult?.messages ?? [],
        ...(adapter ? { adapter: { ...(adapterPrepare === undefined ? {} : { prepare: adapterPrepare }) } } : {}),
      }
      const runtimeUsage = usage(state.runUsage)
      if (runState.status !== 'completed') {
        const runtimeFailure = runState.failure
          ? failure(runState.failure, runState.failure.code)
          : { code: runState.status === 'cancelled' ? 'EXPERIMENT_CANCELLED' : 'RUNTIME_FAILED', message: `runtime finished with status ${runState.status}`, phase: 'runtime' }
        await cleanupAdapter().catch(() => undefined)
        this.store.completeCase(item.id, {
          status: runState.status === 'cancelled' ? 'cancelled' : 'error',
          actualAnswer,
          toolStatus: toolStatus(item.expectedTools, actualTools),
          actualTools,
          toolCalls,
          usage: runtimeUsage,
          agentUsage: runtimeUsage,
          scoringUsage: usage(),
          latencyMs: Date.now() - started,
          ...(runtimeRunId ? { runtimeRunId } : {}),
          failure: runtimeFailure,
          trace,
          completedAt: new Date().toISOString(),
        })
        return
      }
      if (!actualAnswer) throw new Error('runtime completed without an assistant answer')
      if (adapter) {
        const evaluation = await adapter.evaluate(adapterPayload({
          actual: jsonObject({
            answer: actualAnswer,
            tools: actualTools,
            toolCalls,
            runtimeRunId: runtimeRunId ?? null,
          }),
        }), { signal: timeoutController.signal })
        trace.adapter = { ...(trace.adapter ?? {}), evaluation }
        await cleanupAdapter()
        this.store.completeCase(item.id, {
          status: evaluation.passed ? 'passed' : 'failed',
          actualAnswer,
          score: evaluation.score,
          passed: evaluation.passed,
          rationale: evaluation.rationale,
          toolStatus: toolStatus(item.expectedTools, actualTools),
          actualTools,
          toolCalls,
          usage: runtimeUsage,
          agentUsage: runtimeUsage,
          scoringUsage: usage(),
          latencyMs: Date.now() - started,
          ...(runtimeRunId ? { runtimeRunId } : {}),
          evaluation: {
            source: 'project',
            metrics: evaluation.metrics,
            ...(evaluation.details === undefined ? {} : { details: evaluation.details }),
          },
          trace,
          completedAt: new Date().toISOString(),
        })
        return
      }
      const score = await this.score(active.llm, run, item, actualAnswer, actualTools, timeoutController.signal)
      const scoringUsage = usage(score.response.usage)
      trace.scoring = { prompt: score.prompt, response: score.response.text, usage: scoringUsage }
      this.store.completeCase(item.id, {
        status: score.passed ? 'passed' : 'failed',
        actualAnswer,
        score: score.score,
        passed: score.passed,
        rationale: score.rationale,
        toolStatus: toolStatus(item.expectedTools, actualTools),
        actualTools,
        toolCalls,
        usage: addUsage(runtimeUsage, scoringUsage),
        agentUsage: runtimeUsage,
        scoringUsage,
        latencyMs: Date.now() - started,
        ...(runtimeRunId ? { runtimeRunId } : {}),
        evaluation: { source: 'llm', metrics: {} },
        trace,
        completedAt: new Date().toISOString(),
      })
    } catch (error) {
      if (abortTimer) clearTimeout(abortTimer)
      await cleanupAdapter().catch(() => undefined)
      const state = loop.exportState()
      const snapshot = state.snapshot
      const runtimeRunId = snapshot.run.runId ?? undefined
      const observations = snapshot.observations.items.filter(
        (observation) => !runtimeRunId || observation.runId === runtimeRunId,
      )
      const actualTools = observations.map((observation) => observation.toolName)
      const caseFailure = failure(error)
      this.store.completeCase(item.id, {
        status: active.controller.signal.aborted ? 'cancelled' : 'error',
        actualAnswer: messageText([...snapshot.conversation.messages].reverse().find((message) => message.role === 'assistant')),
        toolStatus: toolStatus(item.expectedTools, actualTools),
        actualTools,
        toolCalls: observations.map((observation) => ({
          callId: observation.callId,
          name: observation.toolName,
          status: observation.status === 'completed' ? 'completed' : 'failed',
          arguments: observation.arguments,
          ...(observation.resultPreview ? { resultPreview: observation.resultPreview } : {}),
          ...(observation.error === undefined ? {} : { error: observation.error }),
          startedAt: observation.startedAt,
          ...(observation.completedAt ? { completedAt: observation.completedAt } : {}),
          ...(observation.durationMs === undefined ? {} : { durationMs: observation.durationMs }),
        })),
        usage: usage(state.runUsage),
        agentUsage: usage(state.runUsage),
        scoringUsage: usage(),
        latencyMs: Date.now() - started,
        ...(runtimeRunId ? { runtimeRunId } : {}),
        failure: caseFailure,
        trace: {
          ...(runtimeRunId ? { runtimeRunId } : {}),
          ...(snapshot.run.failure ? { failure: snapshot.run.failure } : {}),
          timeline: snapshot.timeline.steps,
          observations,
          effectiveContexts: snapshot.effectiveContexts.items.filter(
            (context) => !runtimeRunId || context.runId === runtimeRunId,
          ),
          artifacts: state.artifacts
            .filter((artifact) => !runtimeRunId || artifact.meta.runId === runtimeRunId)
            .map((artifact) => ({ meta: artifact.meta, value: artifact.value })),
          renderedMessages: snapshot.renderResult?.messages ?? [],
          ...(adapter ? { adapter: { ...(adapterPrepare === undefined ? {} : { prepare: adapterPrepare }) } } : {}),
        },
        completedAt: new Date().toISOString(),
      })
    } finally {
      await cleanupAdapter().catch(() => undefined)
      active.controller.signal.removeEventListener('abort', cancel)
      active.loops.delete(loop)
      loop.close()
      if (!run.config.keepWorkspaces) fs.rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
  }

  private async score(llm: RuntimeLlm, run: ExperimentRunDetail, item: CreateExperimentCase, actualAnswer: string, actualTools: string[], signal: AbortSignal): Promise<ScoreResult> {
    const prompt = this.scoringEnvironment.renderString(run.scoringPrompt, {
      question: item.question,
      thinking: item.thinking,
      answer: item.expectedAnswer,
      actual: actualAnswer,
      expected_tools: item.expectedTools,
      actual_tools: actualTools,
      question_json: JSON.stringify(item.question),
      thinking_json: JSON.stringify(item.thinking),
      answer_json: JSON.stringify(item.expectedAnswer),
      actual_json: JSON.stringify(actualAnswer),
      expected_tools_json: JSON.stringify(item.expectedTools),
      actual_tools_json: JSON.stringify(actualTools),
    })
    if (!prompt.trim()) throw new Error('rendered scoring prompt is empty')
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal.aborted) throw signal.reason ?? new Error('scoring cancelled')
      try {
        const response = await llm.chat({
          messages: [{ role: 'user', content: prompt }],
          responseFormat: 'json',
          maxTokens: 1_000,
          signal,
        })
        return { ...scoreResponse(response), response, prompt }
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }

  private calculateMetrics(run: ExperimentRunDetail): ExperimentMetrics {
    const cases = this.allCases(run.id)
    const finished = cases.filter((item) => ['passed', 'failed', 'error', 'cancelled'].includes(item.status))
    const scored = finished.filter((item) => item.score !== undefined)
    const passed = finished.filter((item) => item.status === 'passed').length
    const failed = finished.filter((item) => item.status === 'failed').length
    const errors = finished.filter((item) => item.status === 'error').length
    const cancelled = finished.filter((item) => item.status === 'cancelled').length
    const aggregateUsage = finished.reduce((total, item) => addUsage(total, item.usage), usage())
    const agentUsage = finished.reduce((total, item) => addUsage(total, item.agentUsage), usage())
    const scoringUsage = finished.reduce((total, item) => addUsage(total, item.scoringUsage), usage())
    const expectedCount = finished.reduce((total, item) => total + new Set(item.expectedTools).size, 0)
    const actualCount = finished.reduce((total, item) => total + new Set(item.actualTools).size, 0)
    const hits = finished.reduce((total, item) => {
      const actual = new Set(item.actualTools)
      return total + [...new Set(item.expectedTools)].filter((name) => actual.has(name)).length
    }, 0)
    const previous = this.store.listRuns({ datasetId: run.dataset.id, status: 'completed', limit: 500 })
      .find((candidate) => candidate.id !== run.id && compatibilityIssues(run, candidate).length === 0)
    const previousScores = previous ? this.store.scoreMap(previous.id) : new Map<string, number>()
    const currentScores = new Map<string, number>()
    for (const sampleId of new Set(scored.map((item) => item.sampleId))) {
      const values = scored.filter((item) => item.sampleId === sampleId).map((item) => item.score as number)
      currentScores.set(sampleId, values.reduce((sum, value) => sum + value, 0) / values.length)
    }
    const regressions = [...currentScores].filter(([sampleId, score]) => {
      const previousScore = previousScores.get(sampleId)
      return previousScore !== undefined && score < previousScore
    }).length
    const scoreBins = [0, 0, 0, 0, 0]
    for (const item of scored) {
      const score = item.score as number
      const index = Math.min(4, Math.floor(score * 5))
      scoreBins[index] = (scoreBins[index] ?? 0) + 1
    }
    return {
      ...EMPTY_EXPERIMENT_METRICS,
      ...aggregateUsage,
      agentUsage,
      scoringUsage,
      agentTokensPerCase: finished.length ? agentUsage.totalTokens / finished.length : 0,
      scoringTokensPerCase: finished.length ? scoringUsage.totalTokens / finished.length : 0,
      averageScore: scored.length ? scored.reduce((sum, item) => sum + (item.score ?? 0), 0) / scored.length : 0,
      passRate: finished.length ? passed / finished.length * 100 : 0,
      errorRate: finished.length ? errors / finished.length * 100 : 0,
      toolPrecision: actualCount ? hits / actualCount * 100 : null,
      toolRecall: expectedCount ? hits / expectedCount * 100 : null,
      p95LatencyMs: percentile(finished.map((item) => item.latencyMs), 0.95),
      passed,
      failed,
      errors,
      cancelled,
      regressions,
      scoreBins,
    }
  }

  private async aggregateMetrics(run: ExperimentRunDetail): Promise<ExperimentMetrics> {
    const metrics = this.calculateMetrics(run)
    if (run.evaluator.type !== 'project') return metrics
    const adapter = ExperimentAdapterRunner.load(this.projectDir)
    if (!adapter) throw new Error('experiment adapter disappeared before run aggregation')
    if (adapter.revision !== run.evaluator.revision) {
      throw new Error('experiment adapter revision changed before run aggregation')
    }
    if (!adapter.supports('aggregate')) return metrics
    const cases = this.allCases(run.id).map((item) => {
      const detail = this.store.getCase(run.id, item.id)
      return {
        id: detail.id,
        sampleId: detail.sampleId,
        repetition: detail.repetition,
        status: detail.status,
        score: detail.score ?? null,
        passed: detail.passed ?? null,
        metadata: detail.metadata,
        evaluation: detail.evaluation ?? null,
        actualTools: detail.actualTools,
        latencyMs: detail.latencyMs,
      }
    })
    const value = await adapter.invoke('aggregate', jsonObject({ run, cases }))
    metrics.custom = jsonObject(value)
    return metrics
  }

  private allDatasetRecords(datasetId: string): DatasetRecord[] {
    const records: DatasetRecord[] = []
    let offset = 0
    while (true) {
      const page = this.datasets.listRecords(datasetId, { offset, limit: 200 })
      records.push(...page.items)
      offset += page.items.length
      if (offset >= page.total || page.items.length === 0) return records
    }
  }

  private allCases(runId: string): ExperimentCaseSummary[] {
    const cases: ExperimentCaseSummary[] = []
    let offset = 0
    while (true) {
      const page = this.store.listCases(runId, { offset, limit: 500 })
      cases.push(...page.items)
      offset += page.items.length
      if (offset >= page.total || page.items.length === 0) return cases
    }
  }

  private sampleIds(value: unknown, records: DatasetRecord[]): string[] {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
      throw new Error('sampleIds must be an array of non-empty strings')
    }
    const ids = [...new Set(value as string[])]
    const known = new Set(records.map((record) => record.id))
    const missing = ids.filter((id) => !known.has(id))
    if (missing.length) throw new Error(`dataset samples were not found: ${missing.join(', ')}`)
    return ids
  }

  private projectLlm(): RuntimeLlm {
    const settings = new ProjectResources(this.projectDir).readSettings()
    return createLlmService({
      model: settings.llm.model,
      baseUrl: settings.llm.base_url,
      protocol: settings.llm.protocol,
      apiKey: settings.llm.api_key,
    })
  }

  private prepareWorkspace(runId: string, caseId: string): string {
    const target = path.join(this.projectDir, '.capybara', 'worktrees', runId, caseId)
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    fs.mkdirSync(target, { recursive: true })
    const excludedRoots = new Set(['.git', '.venv', 'venv', 'node_modules', '.next', 'dist', 'datasets'])
    for (const entry of fs.readdirSync(this.projectDir, { withFileTypes: true })) {
      const name = entry.name.toLowerCase()
      if (excludedRoots.has(name)) continue
      if (name === '.capybara') {
        const localTarget = path.join(target, entry.name)
        fs.mkdirSync(localTarget, { recursive: true })
        for (const localEntry of fs.readdirSync(path.join(this.projectDir, entry.name), { withFileTypes: true })) {
          const localName = localEntry.name.toLowerCase()
          if (localName === 'worktrees'
            || localName === 'datasets.json'
            || localName === 'secrets.json'
            || localName.startsWith('sessions.sqlite')
            || localName.startsWith('experiments.sqlite')) continue
          fs.cpSync(
            path.join(this.projectDir, entry.name, localEntry.name),
            path.join(localTarget, localEntry.name),
            { recursive: true },
          )
        }
        continue
      }
      fs.cpSync(path.join(this.projectDir, entry.name), path.join(target, entry.name), { recursive: true })
    }
    return target
  }

  private removeWorkspaceRoot(runId: string): void {
    fs.rmSync(path.join(this.projectDir, '.capybara', 'worktrees', runId), {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    })
  }

  private command<TType extends ClientCommand['type']>(
    loop: RuntimeLoop,
    type: TType,
    payload: Extract<ClientCommand, { type: TType }>['payload'],
  ): void {
    const command = {
      version: 1,
      kind: 'command',
      id: randomUUID(),
      type,
      sessionId: `experiment-${randomUUID()}`,
      timestamp: new Date().toISOString(),
      payload,
    } as Extract<ClientCommand, { type: TType }>
    loop.validate(command)
    loop.execute(command, 1)
  }

  private averageScore(cases: ExperimentCaseSummary[]): number | undefined {
    const scores = cases.flatMap((item) => item.score === undefined ? [] : [item.score])
    return scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : undefined
  }
}
