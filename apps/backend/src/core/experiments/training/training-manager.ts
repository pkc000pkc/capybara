import { randomUUID } from 'node:crypto'

import { DatasetStore, type DatasetRecord } from '#core/datasets/dataset-store'
import { ExperimentAdapterRunner } from '#core/experiments/experiment-adapter'
import { ExperimentManager } from '#core/experiments/experiment-manager'
import { redactReferenceForPresentation, redactToolCallsForPresentation } from '#core/experiments/presentation'
import type { ExperimentCaseDetail, ExperimentFailure, ExperimentReference } from '#core/experiments/types'
import { LearningHookExecutionError, LearningHookRunner } from '#core/experiments/training/learning-hook-runner'
import {
  aggregateTrainingCases,
  aggregateTrainingExperiences,
  compareTrainingRuns,
} from '#core/experiments/training/training-analysis'
import { ProjectVariableWriter, variableHash } from '#core/experiments/training/project-variable-writer'
import { SnapshotService } from '#core/experiments/training/snapshot-service'
import { TrainingStore } from '#core/experiments/training/training-store'
import { resolveTrainingReference } from '#core/experiments/training/training-reference'
import {
  MAX_TEST_CASES,
  MAX_TRAINING_CASES,
  type CreateSnapshotEvaluationInput,
  type CreateTrainingInput,
  type ExperienceCandidate,
  type TestSnapshot,
  type TrainingCase,
  type TrainingCaseView,
  type TrainingConfig,
  type TrainingCorrectionAttempt,
  type TrainingComparisonReport,
  type TrainingHookBinding,
  type TrainingLearningMode,
  type TrainingLineageNode,
  type TrainingLineageReport,
  type TrainingReviewScope,
  type TrainingRun,
  type TrainingRunAnalysis,
  type TrainingRunAnalysisSummary,
  type TrainingTrendReport,
  type TrainingVariableReport,
  type TrainingVariableSource,
  type VariableDiff,
} from '#core/experiments/training/training-types'
import type { HookExperienceCandidate, HookExperienceTransition, HookTrainingContext } from '#core/hooks/types'
import { HookRegistry } from '#core/hooks/hook-registry'
import { ProjectResources } from '#core/project-resources'
import { PluginRegistry } from '#core/plugins/plugin-registry'
import type { JsonObject } from '#protocol/runtime-protocol'

const DEFAULT_TIMEOUT_MS = 15 * 60_000
const MAX_TIMEOUT_MS = 3 * 60 * 60_000
const DEFAULT_MAX_CORRECTION_ATTEMPTS = 5
const DEFAULT_MAX_CORRECTION_TOKENS = 2_000_000
const DEFAULT_MAX_CORRECTION_WALL_TIME_MS = 20 * 60_000
const DEFAULT_MAX_REPLAY_REVISIONS = 2
const ACTIVE_STATUSES = new Set(['queued', 'running', 'testing'])
const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 }

function addUsage(
  left: ExperimentCaseDetail['usage'],
  right: ExperimentCaseDetail['usage'],
): ExperimentCaseDetail['usage'] {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`)
  return value.trim()
}

function boundedInteger(value: unknown, fallback: number, maximum: number, field: string): number {
  const number = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    throw new Error(`${field} must be an integer between 1 and ${maximum}`)
  }
  return number
}

function binding(value: unknown, field: string, required: true): TrainingHookBinding
function binding(value: unknown, field: string, required: false): TrainingHookBinding | undefined
function binding(value: unknown, field: string, required: boolean): TrainingHookBinding | undefined {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field} is required`)
    return undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`)
  const item = value as Record<string, unknown>
  const hookId = requiredString(item.hookId, `${field}.hookId`)
  const parametersValue = item.parameters ?? {}
  if (!parametersValue || typeof parametersValue !== 'object' || Array.isArray(parametersValue)) {
    throw new Error(`${field}.parameters must be an object`)
  }
  const parameters = Object.fromEntries(Object.entries(parametersValue).map(([key, parameter]) => {
    if (typeof parameter !== 'string') throw new Error(`${field}.parameters.${key} must be a string`)
    return [key, parameter]
  }))
  return { hookId, parameters }
}

function failure(error: unknown, code = 'TRAINING_FAILED'): ExperimentFailure {
  return { code, message: error instanceof Error ? error.message : String(error) }
}

function experienceContentHash(patches: readonly VariableDiff[]): string {
  return variableHash(JSON.stringify(patches
    .map((patch) => ({ variableName: patch.variableName, afterValue: patch.afterValue ?? '' }))
    .sort((left, right) => left.variableName.localeCompare(right.variableName))))
}

class CorrectionBudgetError extends Error {
  readonly reason = 'max_wall_time' as const
}

interface CorrectionLoopResult {
  successfulItem?: TrainingCase
  attempts: TrainingCorrectionAttempt[]
}

interface ReplayOutcome {
  verdict: 'accept' | 'reject' | 'retry_correction'
  reasons: string[]
  detail: ExperimentCaseDetail
}

function referenceForCase(item: TrainingCase, released: boolean): TrainingCaseView['reference'] {
  if (!released) return { status: 'locked' }
  if (item.evaluation?.reference?.status === 'load_failed') {
    return item.evaluation.reference
  }
  const resolved = resolveTrainingReference(
    item.expectedAnswer,
    item.evaluation?.reference,
    item.completedAt ?? item.updatedAt,
  )
  if (resolved) return resolved
  if (item.evaluation?.reference) return item.evaluation.reference
  return {
    kind: 'unavailable',
    status: 'unavailable',
    source: { type: item.evaluation?.source === 'project' ? 'official_evaluator' : 'dataset' },
    requirements: [],
    actualStateChanges: [],
    failureTraces: [],
    resolvedAt: item.completedAt ?? item.updatedAt,
  }
}

function failedReference(item: TrainingCase, revision: string, error: unknown): ExperimentReference {
  void item
  return {
    kind: 'unavailable',
    status: 'load_failed',
    source: {
      type: 'official_evaluator',
      resolverRevision: revision,
    },
    requirements: [],
    actualStateChanges: [],
    failureTraces: [],
    error: error instanceof Error ? error.message : String(error),
    resolvedAt: new Date().toISOString(),
  }
}

export class TrainingManager {
  readonly store: TrainingStore
  private readonly datasets: DatasetStore
  private readonly writer: ProjectVariableWriter
  private readonly snapshots: SnapshotService
  private readonly active = new Map<string, Promise<void>>()
  private readonly activeChildren = new Map<string, string>()
  private readonly referenceHydrations = new Map<string, Promise<void>>()
  private stopped = false

  constructor(
    readonly projectDir: string,
    private readonly experiments: ExperimentManager,
  ) {
    this.store = new TrainingStore(projectDir)
    this.datasets = new DatasetStore(projectDir)
    this.writer = new ProjectVariableWriter(projectDir)
    this.snapshots = new SnapshotService(projectDir, this.store)
  }

  create(input: CreateTrainingInput): TrainingRun {
    const trainDatasetId = requiredString(input.trainDatasetId, 'trainDatasetId')
    const testDatasetId = requiredString(input.testDatasetId, 'testDatasetId')
    if (trainDatasetId === testDatasetId) throw new Error('training and testing datasets must be different')
    const trainDataset = this.datasets.get(trainDatasetId)
    const testDataset = this.datasets.get(testDatasetId)
    if (trainDataset.tags.some((tag) => tag.toLowerCase() === 'closed-book-eval')) {
      throw new Error(`dataset is evaluation-only and cannot be used for training: ${trainDataset.id}`)
    }
    const trainLimit = boundedInteger(input.trainLimit, MAX_TRAINING_CASES, MAX_TRAINING_CASES, 'trainLimit')
    const testLimit = boundedInteger(input.testLimit, MAX_TEST_CASES, MAX_TEST_CASES, 'testLimit')
    const learningMode = (input.learningMode ?? 'review') as TrainingLearningMode
    if (!['review', 'author', 'auto'].includes(learningMode)) throw new Error('learningMode must be review, author, or auto')
    const reviewScope = (input.reviewScope ?? 'failed') as TrainingReviewScope
    if (!['all', 'failed'].includes(reviewScope)) throw new Error('reviewScope must be all or failed')
    const pauseOnFailure = input.pauseOnFailure === undefined ? true : input.pauseOnFailure
    if (typeof pauseOnFailure !== 'boolean') throw new Error('pauseOnFailure must be a boolean')
    const variableSource = (input.variableSource ?? 'project') as TrainingVariableSource
    if (!['project', 'run'].includes(variableSource)) throw new Error('variableSource must be project or run')
    const variableSourceRunId = variableSource === 'run'
      ? requiredString(input.variableSourceRunId, 'variableSourceRunId')
      : undefined
    const sourceRun = variableSourceRunId ? this.store.getRun(variableSourceRunId) : undefined
    if (sourceRun && !['ready_to_freeze', 'ready_for_test', 'completed'].includes(sourceRun.status)) {
      throw new Error('variable source run must have completed training')
    }
    const timeoutMs = boundedInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, 'timeoutMs')
    const maxCorrectionAttempts = boundedInteger(
      input.maxCorrectionAttempts, DEFAULT_MAX_CORRECTION_ATTEMPTS, 5, 'maxCorrectionAttempts',
    )
    const maxCorrectionTokens = boundedInteger(
      input.maxCorrectionTokens, DEFAULT_MAX_CORRECTION_TOKENS, 2_000_000, 'maxCorrectionTokens',
    )
    const maxCorrectionWallTimeMs = boundedInteger(
      input.maxCorrectionWallTimeMs, DEFAULT_MAX_CORRECTION_WALL_TIME_MS, 5 * MAX_TIMEOUT_MS, 'maxCorrectionWallTimeMs',
    )
    const maxReplayRevisions = boundedInteger(
      input.maxReplayRevisions, DEFAULT_MAX_REPLAY_REVISIONS, 10, 'maxReplayRevisions',
    )
    const experienceExtractorHook = this.assertHook(
      binding(input.experienceExtractorHook, 'experienceExtractorHook', true),
      'after_evaluation',
    )
    const correctionBinding = binding(input.correctionHook, 'correctionHook', false)
    const correctionHook = correctionBinding
      ? this.assertHook(correctionBinding, 'after_evaluation')
      : undefined
    const config: TrainingConfig = {
      trainDatasetId,
      testDatasetId,
      trainLimit: Math.min(trainLimit, trainDataset.samples),
      testLimit: Math.min(testLimit, testDataset.samples),
      learningMode,
      reviewScope,
      pauseOnFailure,
      variableSource,
      ...(variableSourceRunId ? { variableSourceRunId } : {}),
      ...(correctionHook ? { correctionHook } : {}),
      maxCorrectionAttempts,
      maxCorrectionTokens,
      maxCorrectionWallTimeMs,
      maxReplayRevisions,
      experienceExtractorHook,
      timeoutMs,
      concurrency: 1,
    }
    if (config.trainLimit === 0 || config.testLimit === 0) throw new Error('training and testing datasets must not be empty')
    const createdAt = new Date().toISOString()
    const id = randomUUID()
    const cases = [
      ...this.records(trainDatasetId, config.trainLimit).map((record, ordinal) =>
        this.trainingCase(id, 'training', trainDatasetId, record, ordinal, createdAt)),
      ...this.records(testDatasetId, config.testLimit).map((record, ordinal) =>
        this.trainingCase(id, 'testing', testDatasetId, record, ordinal, createdAt)),
    ]
    const baselineVariables = sourceRun
      ? (this.store.getSnapshot(sourceRun.id)?.variables ?? this.store.runVariables(sourceRun.id))
      : Object.fromEntries(
        new PluginRegistry(this.projectDir).effectiveSystemVariablesState().resource.variables
          .filter((variable) => (
            variable.scope === 'project' || variable.scope === 'session'
          ) && !variable.readonly
            && typeof variable.value === 'string'
          )
          .map((variable) => [variable.key, variable.value as string]),
      )
    const run = this.store.createRun({
      id,
      name: typeof input.name === 'string' && input.name.trim()
        ? input.name.trim()
        : `${trainDataset.name} -> ${testDataset.name}`,
      status: 'queued',
      config,
      createdAt,
      updatedAt: createdAt,
    }, cases, baselineVariables)
    this.schedule(id)
    return run
  }

  createSnapshotEvaluation(sourceRunId: string, input: CreateSnapshotEvaluationInput): TrainingRun {
    const sourceRun = this.store.getRun(requiredString(sourceRunId, 'sourceRunId'))
    if (['queued', 'running', 'testing'].includes(sourceRun.status)) {
      throw new Error('pause the active source run before reusing its frozen snapshot')
    }
    const snapshot = this.store.getSnapshot(sourceRun.id)
    if (!snapshot) throw new Error('source training run does not have a frozen snapshot')
    const testDatasetId = requiredString(input.testDatasetId, 'testDatasetId')
    const testDataset = this.datasets.get(testDatasetId)
    const testLimit = boundedInteger(input.testLimit, MAX_TEST_CASES, MAX_TEST_CASES, 'testLimit')
    const limited = Math.min(testLimit, testDataset.samples)
    if (limited === 0) throw new Error('testing dataset must not be empty')
    const createdAt = new Date().toISOString()
    const id = randomUUID()
    const config: TrainingConfig = {
      ...sourceRun.config,
      testDatasetId,
      trainLimit: 0,
      testLimit: limited,
      variableSource: 'run',
      variableSourceRunId: sourceRun.id,
      evaluationOnly: true,
      snapshotSourceRunId: sourceRun.id,
      concurrency: 1,
    }
    const cases = this.records(testDatasetId, limited).map((record, ordinal) =>
      this.trainingCase(id, 'testing', testDatasetId, record, ordinal, createdAt))
    const run = this.store.createRun({
      id,
      name: typeof input.name === 'string' && input.name.trim()
        ? input.name.trim()
        : `${sourceRun.name} -> ${testDataset.name}`,
      status: 'ready_for_test',
      config,
      snapshotId: snapshot.id,
      createdAt,
      updatedAt: createdAt,
    }, cases, snapshot.variables)
    this.store.recordEvent(id, 'snapshot.reused', {
      sourceRunId: sourceRun.id,
      snapshotId: snapshot.id,
      contentHash: snapshot.contentHash,
      testDatasetId,
    })
    return run
  }

  list(limit?: number): TrainingRun[] {
    return this.store.listRuns(limit)
  }

  get(id: string): TrainingRun {
    return this.store.getRun(id)
  }

  cases(id: string): TrainingCaseView[] {
    this.store.getRun(id)
    return this.store.listCases(id).map((item) => {
      const released = item.phase === 'training'
        ? !['queued', 'running'].includes(item.status)
        : ['completed', 'error'].includes(item.status)
      return {
        ...item,
        toolCalls: redactToolCallsForPresentation(item.toolCalls),
        expectedAnswer: released ? item.expectedAnswer : '',
        expectedTools: released ? item.expectedTools : [],
        reference: (() => {
          const reference = referenceForCase(item, released)
          return reference.status === 'locked' ? reference : redactReferenceForPresentation(reference)
        })(),
      }
    })
  }

  async hydrateReferences(id: string): Promise<void> {
    const current = this.referenceHydrations.get(id)
    if (current) return current
    const task = this.hydrateMissingReferences(id).finally(() => this.referenceHydrations.delete(id))
    this.referenceHydrations.set(id, task)
    return task
  }

  experiences(id: string): ExperienceCandidate[] {
    return this.store.listExperiences(id)
  }

  correctionAttempts(id: string, sourceCaseId?: string): TrainingCorrectionAttempt[] {
    return this.store.listCorrectionAttempts(id, sourceCaseId)
  }

  variables(id: string): TrainingVariableReport {
    const resources = new ProjectResources(this.projectDir).readSystemVariables().variables
      .filter((variable) => (
        variable.scope === 'project'
        && !variable.readonly
        && typeof variable.value === 'string'
      ))
    const projectValues = Object.fromEntries(
      resources.map((variable) => [variable.key, variable.value as string]),
    )
    const snapshot = this.store.getSnapshot(id)
    const candidates = this.store.listExperiences(id)
    const audits = this.store.listVariableAudits(id)
    const storedBaseline = this.store.baselineVariables(id)
    const runValues = this.store.runVariables(id)
    const inferredBaseline = Object.fromEntries(candidates.flatMap((candidate) =>
      candidate.patches.map((patch) => [patch.variableName, patch.beforeValue ?? ''] as const)))
    const baseline = Object.keys(storedBaseline).length > 0
      ? storedBaseline
      : { ...projectValues, ...inferredBaseline }
    const names = new Set([
      ...Object.keys(baseline),
      ...Object.keys(projectValues),
      ...candidates.flatMap((candidate) => candidate.patches.map((patch) => patch.variableName)),
    ])
    const items = [...names].sort().map((name) => {
      const variableCandidates = candidates.filter((candidate) =>
        candidate.patches.some((patch) => patch.variableName === name))
      const variableAudits = audits.filter((audit) => audit.variableName === name)
      const lastAudit = variableAudits.at(-1)
      const latestCandidate = variableCandidates.at(-1)
      const baselineValue = baseline[name] ?? lastAudit?.beforeValue ?? projectValues[name] ?? ''
      const runValue = runValues[name] ?? snapshot?.variables[name] ?? lastAudit?.afterValue ?? baselineValue
      const state: TrainingVariableReport['items'][number]['state'] = latestCandidate?.status ?? 'unchanged'
      return {
        name,
        baselineValue,
        runValue,
        projectValue: projectValues[name] ?? '',
        ...(snapshot && name in snapshot.variables ? { snapshotValue: snapshot.variables[name] } : {}),
        sourceCaseIds: [...new Set(variableCandidates.map((candidate) => candidate.sourceCaseId))],
        candidateIds: variableCandidates.map((candidate) => candidate.id),
        state,
        changed: baselineValue !== runValue,
      }
    })
    return { items }
  }

  analysis(id: string): TrainingRunAnalysis {
    const run = this.store.getRun(id)
    const cases = this.cases(id)
    const experienceCandidates = this.store.listExperiences(id)
    const variableItems = this.variables(id).items
    const training = aggregateTrainingCases(cases.filter((item) => item.phase === 'training'))
    const testing = aggregateTrainingCases(cases.filter((item) => item.phase === 'testing'))
    const snapshot = this.store.getSnapshot(id)
    const firstChildRunId = cases.find((item) => item.experimentRunId)?.experimentRunId
    let provenance: TrainingRunAnalysis['provenance']
    if (firstChildRunId) {
      try {
        const child = this.experiments.get(firstChildRunId)
        provenance = { project: child.project, model: child.model, evaluator: child.evaluator }
      } catch {
        provenance = undefined
      }
    }
    return {
      run,
      trainDataset: this.analysisDataset(run.config.trainDatasetId, training.total),
      testDataset: this.analysisDataset(run.config.testDatasetId, testing.total),
      training,
      testing,
      experiences: aggregateTrainingExperiences(experienceCandidates),
      variables: { total: variableItems.length, changed: variableItems.filter((item) => item.changed).length },
      ...(provenance ? { provenance } : {}),
      cases,
      correctionAttempts: this.store.listCorrectionAttempts(id),
      experienceCandidates,
      variableItems,
      ...(snapshot ? { snapshot } : {}),
      events: this.store.listEvents(id),
    }
  }

  trend(testDatasetId: string, trainDatasetId?: string, limit = 50): TrainingTrendReport {
    const testId = requiredString(testDatasetId, 'testDatasetId')
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)))
    const allRuns = this.store.listRuns(500)
    const matchingRuns = allRuns
      .filter((run) => run.config.testDatasetId === testId
        && (!trainDatasetId || run.config.trainDatasetId === trainDatasetId))
    const selectedRuns = matchingRuns.slice(0, boundedLimit)
    const items = selectedRuns.map((run) => this.analysisSummary(run.id))
    return {
      testDatasetId: testId,
      ...(trainDatasetId ? { trainDatasetId } : {}),
      items,
      lineage: this.buildLineage(selectedRuns, allRuns),
    }
  }

  compare(leftId: string, rightId: string): TrainingComparisonReport {
    if (leftId === rightId) throw new Error('leftId and rightId must identify different training runs')
    return compareTrainingRuns(this.analysis(leftId), this.analysis(rightId))
  }

  capabilities() {
    const hooks = new HookRegistry(this.projectDir).listTraining()
      .filter((hook) => hook.enabled && hook.loadable)
      .map((hook) => ({
        id: hook.id,
        name: hook.name,
        checkpoint: hook.checkpoint,
        parameters: hook.parameters.map((parameter) => ({ ...parameter })),
      }))
    return { maxTrainingCases: MAX_TRAINING_CASES, maxTestCases: MAX_TEST_CASES, hooks }
  }

  private analysisSummary(id: string): TrainingRunAnalysisSummary {
    const detail = this.analysis(id)
    return {
      run: detail.run,
      trainDataset: detail.trainDataset,
      testDataset: detail.testDataset,
      training: detail.training,
      testing: detail.testing,
      experiences: detail.experiences,
      variables: detail.variables,
      ...(detail.provenance ? { provenance: detail.provenance } : {}),
    }
  }

  private buildLineage(selectedRuns: TrainingRun[], allRuns: TrainingRun[]): TrainingLineageReport {
    const runsById = new Map(allRuns.map((run) => [run.id, run]))
    const summaries = new Map<string, TrainingRunAnalysisSummary>()
    const nodes = new Map<string, TrainingLineageNode>()
    const edges = new Map<string, { sourceRunId: string; continuationRunId: string }>()
    const roots = new Set<string>()
    const missing = new Set<string>()

    const summaryFor = (run: TrainingRun) => {
      const existing = summaries.get(run.id)
      if (existing) return existing
      const summary = this.analysisSummary(run.id)
      summaries.set(run.id, summary)
      return summary
    }

    for (const selected of selectedRuns) {
      const chain: TrainingRun[] = []
      const visited = new Set<string>()
      let current: TrainingRun | undefined = selected
      while (current && !visited.has(current.id)) {
        visited.add(current.id)
        chain.unshift(current)
        const sourceRunId = current.config.variableSource === 'run' ? current.config.variableSourceRunId : undefined
        if (!sourceRunId) break
        const source = runsById.get(sourceRunId)
        if (!source) {
          missing.add(sourceRunId)
          break
        }
        current = source
      }
      const rootRunId = chain[0]?.id ?? selected.id
      roots.add(rootRunId)
      chain.forEach((run, depth) => {
        const sourceRunId = run.config.variableSource === 'run' ? run.config.variableSourceRunId : undefined
        const node: TrainingLineageNode = {
          run: summaryFor(run),
          ...(sourceRunId ? { sourceRunId } : {}),
          rootRunId,
          depth,
        }
        const existing = nodes.get(run.id)
        if (!existing || depth < existing.depth) nodes.set(run.id, node)
        if (depth > 0) {
          const sourceRun = chain[depth - 1]
          if (sourceRun) edges.set(`${sourceRun.id}->${run.id}`, { sourceRunId: sourceRun.id, continuationRunId: run.id })
        }
      })
    }

    return {
      nodes: [...nodes.values()].sort((left, right) => left.depth - right.depth || left.run.run.createdAt.localeCompare(right.run.run.createdAt)),
      edges: [...edges.values()],
      rootRunIds: [...roots],
      missingRunIds: [...missing],
    }
  }

  private analysisDataset(id: string, fallbackSamples: number) {
    try {
      const dataset = this.datasets.get(id)
      return { id: dataset.id, name: dataset.name, version: dataset.version, samples: dataset.samples }
    } catch {
      return { id, name: id, version: 0, samples: fallbackSamples }
    }
  }

  pause(id: string): TrainingRun {
    const run = this.store.getRun(id)
    if (!['queued', 'running', 'testing'].includes(run.status)) throw new Error('training run is not active')
    this.store.setRunStatus(id, 'paused', { pauseReason: 'Paused by user.' })
    return this.store.getRun(id)
  }

  resume(id: string): TrainingRun {
    const run = this.store.getRun(id)
    if (!['paused', 'paused_failure'].includes(run.status)) throw new Error('training run is not paused')
    const status = run.snapshotId ? 'testing' : 'running'
    this.store.setRunStatus(id, status, { pauseReason: null })
    this.schedule(id)
    return this.store.getRun(id)
  }

  retry(id: string): TrainingRun {
    const run = this.store.getRun(id)
    if (!['failed', 'blocked'].includes(run.status)) throw new Error('training run has no terminal failure to retry')
    const cases = this.store.listCases(id)
    const failedCase = cases.find((item) => item.status === 'error')
      ?? cases.find((item) => item.status !== 'completed')
    if (!failedCase) throw new Error('training run has no failed case to retry')
    this.store.retryCase(failedCase.id)
    const status = failedCase.phase === 'testing' ? 'testing' : 'running'
    this.store.setRunStatus(id, status, {
      currentCaseId: failedCase.id,
      pauseReason: null,
      failure: null,
    })
    this.schedule(id)
    return this.store.getRun(id)
  }

  cancel(id: string): TrainingRun {
    const run = this.store.getRun(id)
    if (['completed', 'failed', 'cancelled'].includes(run.status)) throw new Error('training run is already terminal')
    this.store.setRunStatus(id, 'cancelled', { currentCaseId: null, pauseReason: null })
    const child = this.activeChildren.get(id)
    if (child) {
      try { this.experiments.cancel(child) } catch {}
    }
    return this.store.getRun(id)
  }

  freeze(id: string): TestSnapshot {
    const run = this.store.getRun(id)
    if (run.status !== 'ready_to_freeze') throw new Error('training must finish before creating a test snapshot')
    return this.snapshots.create(id, this.store.runVariables(id))
  }

  async promote(id: string): Promise<{ variables: Record<string, string>; contentHash: string }> {
    const run = this.store.getRun(id)
    if (run.config.evaluationOnly) throw new Error('evaluation-only runs cannot promote variables')
    if (!['ready_to_freeze', 'ready_for_test', 'completed'].includes(run.status)) {
      throw new Error('training must finish before promoting variables')
    }
    // Session baselines are replay inputs, never long-term project promotions.
    const sessionKeys = new Set(new PluginRegistry(this.projectDir).effectiveSystemVariablesState().resource.variables
      .filter(variable => variable.scope === 'session').map(variable => variable.key))
    const runVariables = this.store.runVariables(id)
    const projectVariables = new ProjectResources(this.projectDir).readSystemVariables().variables
    const values = Object.fromEntries(projectVariables
      .filter((variable) => !variable.readonly && variable.scope === 'project' && typeof variable.value === 'string')
      .filter((variable) => !sessionKeys.has(variable.key) && runVariables[variable.key] !== undefined)
      .map((variable) => [variable.key, runVariables[variable.key] as string]))
    const baseline = Object.fromEntries(projectVariables
      .filter((variable) => variable.key in values && typeof variable.value === 'string')
      .filter((variable) => variable.value !== values[variable.key])
      .map((variable) => [variable.key, variable.value as string]))
    const result = Object.keys(baseline).length > 0
      ? await this.writer.promote(baseline, values)
      : { variables: values, contentHash: variableHash(JSON.stringify(Object.fromEntries(Object.entries(values).sort()))) }
    this.store.recordEvent(id, 'variables.promoted', {
      contentHash: result.contentHash,
      variables: Object.keys(result.variables).sort(),
    })
    return result
  }

  startTest(id: string): TrainingRun {
    const run = this.store.getRun(id)
    if (run.status !== 'ready_for_test' || !this.store.getSnapshot(id)) {
      throw new Error('a frozen snapshot is required before testing')
    }
    this.store.setRunStatus(id, 'testing', { currentCaseId: null, pauseReason: null })
    this.schedule(id)
    return this.store.getRun(id)
  }

  updateExperience(id: string, experienceId: string, patches: VariableDiff[]): ExperienceCandidate {
    const candidate = this.store.getExperience(experienceId)
    if (candidate.runId !== id) throw new Error('experience does not belong to training run')
    this.writer.preview(patches, this.store.runVariables(id))
    return this.store.updateExperiencePatches(experienceId, patches)
  }

  async replayExperience(id: string, experienceId: string): Promise<ExperienceCandidate> {
    const run = this.store.getRun(id)
    const candidate = this.store.getExperience(experienceId)
    if (candidate.runId !== id) throw new Error('experience does not belong to training run')
    await this.replay(run, candidate, this.store.listCorrectionAttempts(run.id, candidate.sourceCaseId))
    this.refreshReviewState(run.id, candidate.sourceCaseId)
    return this.store.getExperience(experienceId)
  }

  async acceptExperience(id: string, experienceId: string): Promise<ExperienceCandidate> {
    const candidate = this.store.getExperience(experienceId)
    if (candidate.runId !== id) throw new Error('experience does not belong to training run')
    if (candidate.replayPassed !== true) throw new Error('experience must pass closed-book replay before acceptance')
    await this.applyCandidate(candidate)
    this.refreshReviewState(id, candidate.sourceCaseId)
    return this.store.getExperience(experienceId)
  }

  rejectExperience(id: string, experienceId: string): ExperienceCandidate {
    const candidate = this.store.getExperience(experienceId)
    if (candidate.runId !== id) throw new Error('experience does not belong to training run')
    if (candidate.status === 'applied') throw new Error('applied experience cannot be rejected')
    this.store.setExperienceStatus(experienceId, 'rejected', this.replayMetadata(candidate))
    this.refreshReviewState(id, candidate.sourceCaseId)
    return this.store.getExperience(experienceId)
  }

  async close(): Promise<void> {
    this.stopped = true
    for (const runId of this.active.keys()) {
      const run = this.store.getRun(runId)
      if (ACTIVE_STATUSES.has(run.status)) this.store.setRunStatus(runId, 'paused', { pauseReason: 'Backend stopped.' })
      const child = this.activeChildren.get(runId)
      if (child) {
        try { this.experiments.cancel(child) } catch {}
      }
    }
    await Promise.allSettled(this.active.values())
    this.store.close()
  }

  private schedule(id: string): void {
    if (this.stopped || this.active.has(id)) return
    const promise = Promise.resolve()
      .then(() => this.drive(id))
      .finally(() => this.active.delete(id))
    this.active.set(id, promise)
  }

  private async drive(id: string): Promise<void> {
    try {
      let run = this.store.getRun(id)
      if (run.status === 'queued') {
        this.store.setRunStatus(id, 'running', { pauseReason: null })
        run = this.store.getRun(id)
      }
      while (!this.stopped && ACTIVE_STATUSES.has(run.status)) {
        const phase = run.status === 'testing' ? 'testing' : 'training'
        const next = this.store.listCases(id, phase).find((item) => !['completed', 'unresolved', 'error'].includes(item.status))
        if (!next) {
          const phaseCases = this.store.listCases(id, phase)
          // A corrected case keeps its original failed score for auditability,
          // but is terminally completed once the correction/replay pipeline
          // succeeds. Readiness is therefore based on terminal case status,
          // while unresolved/error cases remain blocked.
          const trainingReady = phase === 'training'
            && phaseCases.length > 0
            && phaseCases.every((item) => item.status === 'completed')
          const terminalStatus = phase === 'training'
            ? (trainingReady ? 'ready_to_freeze' : 'blocked')
            : 'completed'
          this.store.setRunStatus(id, terminalStatus, {
            currentCaseId: null,
            pauseReason: terminalStatus === 'blocked' ? 'Training has unresolved, failed, or incomplete cases.' : null,
          })
          return
        }
        this.store.setRunStatus(id, run.status, { currentCaseId: next.id })
        const proceed = phase === 'training'
          ? await this.processTrainingCase(this.store.getRun(id), next)
          : await this.processTestCase(this.store.getRun(id), next)
        if (!proceed) return
        run = this.store.getRun(id)
      }
    } catch (error) {
      if (this.stopped) return
      const problem = failure(error)
      const currentCaseId = this.store.getRun(id).currentCaseId
      if (currentCaseId) {
        const currentCase = this.store.getCase(currentCaseId)
        if (!['completed', 'unresolved', 'error'].includes(currentCase.status)) this.store.failCase(currentCaseId, problem)
      }
      this.store.setRunStatus(id, 'failed', { failure: problem, currentCaseId: null })
    }
  }

  private async processTrainingCase(run: TrainingRun, input: TrainingCase): Promise<boolean> {
    let item = input
    if (item.status === 'queued') {
      await this.executeCase(run, item)
      item = this.store.getCase(item.id)
    }
    const latestRun = this.store.getRun(run.id)
    if (!ACTIVE_STATUSES.has(latestRun.status)) return false
    if (item.status === 'error') throw new Error(item.failure?.message ?? `training case failed: ${item.sampleId}`)
    if (item.passed === false && run.config.learningMode !== 'auto'
      && run.config.pauseOnFailure && !item.failurePauseHandled) {
      this.store.acknowledgeFailurePause(item.id)
      this.store.setRunStatus(run.id, 'paused_failure', {
        currentCaseId: item.id,
        pauseReason: `Case ${item.sampleId} failed evaluation.`,
      })
      return false
    }
    if (item.status === 'evaluated') {
      await this.hydrateMissingReferences(run.id)
      await this.learnFromCase(run, this.store.getCase(item.id))
    }
    return ['completed', 'unresolved'].includes(this.store.getCase(item.id).status)
  }

  private async processTestCase(run: TrainingRun, item: TrainingCase): Promise<boolean> {
    if (item.status === 'queued') await this.executeCase(run, item, this.store.getSnapshot(run.id)?.variables)
    const completed = this.store.getCase(item.id)
    if (completed.status === 'error') throw new Error(completed.failure?.message ?? `test case failed: ${item.sampleId}`)
    this.store.setCaseStatus(item.id, 'completed')
    return true
  }

  private async executeCase(
    run: TrainingRun,
    item: TrainingCase,
    variableOverrides?: Record<string, string>,
    persist = true,
    timeoutMs = run.config.timeoutMs,
    deadlineAt?: number,
    maxTotalTokens?: number,
  ): Promise<ExperimentCaseDetail> {
    const overridableVariables = new Set(
      new PluginRegistry(this.projectDir).effectiveSystemVariablesState().resource.variables
        .filter((variable) => !variable.readonly)
        .map((variable) => variable.key),
    )
    const sourceVariables = variableOverrides ?? this.store.runVariables(run.id)
    const overrides = Object.fromEntries(Object.entries(sourceVariables).filter(([key]) => overridableVariables.has(key)))
    let aggregateUsage = { ...EMPTY_USAGE }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const remainingMs = deadlineAt === undefined ? timeoutMs : deadlineAt - Date.now()
      const remainingTokens = maxTotalTokens === undefined ? undefined : maxTotalTokens - aggregateUsage.totalTokens
      if (remainingTokens !== undefined && remainingTokens < 1) throw new Error('TOKEN_BUDGET_EXHAUSTED')
      if (remainingMs < 1_000) throw new CorrectionBudgetError('Correction wall-time budget was exhausted.')
      const child = await this.experiments.create({
        datasetId: item.datasetId,
        name: `${run.name} · ${item.phase} ${item.ordinal + 1}`,
        concurrency: 1,
        repetitions: 1,
        timeoutMs: Math.min(timeoutMs, remainingMs),
        keepWorkspaces: false,
        sampleIds: [item.sampleId],
      }, {
        allowDirtyProject: true,
        ...(remainingTokens !== undefined ? { maxTotalTokens: remainingTokens } : {}),
        ...(overrides && Object.keys(overrides).length ? { variableOverrides: overrides } : {}),
      })
      if (persist) this.store.startCase(item.id, child.id)
      this.activeChildren.set(run.id, child.id)
      let terminal
      try {
        terminal = await this.experiments.waitForCompletion(child.id)
      } finally {
        this.activeChildren.delete(run.id)
      }
      const childCase = this.experiments.cases(terminal.id, { limit: 1 }).items[0]
      if (!childCase) throw new Error('child experiment completed without a case')
      const childDetail = this.experiments.case(terminal.id, childCase.id)
      aggregateUsage = addUsage(aggregateUsage, childDetail.usage)
      const detail = { ...childDetail, usage: aggregateUsage }
      const shouldRetry = detail.failure?.retryable === true
        && attempt < 2
        && (!persist || ACTIVE_STATUSES.has(this.store.getRun(run.id).status))
      if (shouldRetry) {
        const delayMs = 1_000 * 2 ** attempt
        if (deadlineAt !== undefined && deadlineAt - Date.now() < delayMs + 1_000) {
          throw new CorrectionBudgetError('Correction wall-time budget was exhausted before provider retry.')
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        continue
      }
      if (persist) {
        this.store.recordEvaluation(item.id, {
          experimentCaseId: detail.id,
          actualAnswer: detail.actualAnswer,
          actualTools: detail.actualTools,
          toolCalls: detail.toolCalls,
          usage: detail.usage,
          ...(detail.score === undefined ? {} : { score: detail.score }),
          ...(detail.passed === undefined ? {} : { passed: detail.passed }),
          ...(detail.rationale ? { rationale: detail.rationale } : {}),
          ...(detail.evaluation ? { evaluation: detail.evaluation } : {}),
          ...(detail.failure ? { failure: detail.failure } : {}),
        })
      }
      return detail
    }
    throw new Error('training case retry loop completed without a result')
  }

  private async learnFromCase(run: TrainingRun, item: TrainingCase): Promise<void> {
    if (item.phase !== 'training') {
      throw new Error(`training Hook cannot run for ${item.phase} case ${item.sampleId}`)
    }
    const reference = resolveTrainingReference(
      item.expectedAnswer,
      item.evaluation?.reference,
      item.completedAt ?? item.updatedAt,
    )
    if (typeof item.passed !== 'boolean') {
      throw new Error(`Training case ${item.sampleId} has no success/failure signal.`)
    }
    this.store.setCaseStatus(item.id, 'learning')
    const hookRunner = new LearningHookRunner(this.projectDir, this.experiments.runtimeLlm())
    const referencedItem: TrainingCase = {
      ...item,
      evaluation: {
        ...(item.evaluation ?? { source: 'llm', metrics: {} }),
        ...(reference ? { reference } : {}),
      },
    }
    const correctionStartedAt = Date.now()
    let attempts = this.store.listCorrectionAttempts(run.id, item.id)
    let extractionItem = referencedItem
    if (item.passed === false) {
      const corrected = await this.correctUntilSuccess(
        run, referencedItem, referencedItem, hookRunner, attempts, correctionStartedAt,
      )
      attempts = corrected.attempts
      if (!corrected.successfulItem) {
        this.store.setCaseStatus(item.id, 'unresolved')
        this.store.recordEvent(run.id, 'correction.unresolved', {
          sourceCaseId: item.id,
          attempts: attempts.length,
        })
        return
      }
      extractionItem = corrected.successfulItem
      this.store.recordEvaluation(item.id, {
        experimentCaseId: extractionItem.experimentCaseId ?? '',
        actualAnswer: extractionItem.actualAnswer,
        actualTools: extractionItem.actualTools,
        toolCalls: extractionItem.toolCalls,
        usage: extractionItem.usage,
        score: extractionItem.score,
        passed: true,
        rationale: extractionItem.rationale,
        ...(extractionItem.evaluation ? { evaluation: extractionItem.evaluation } : {}),
        ...(extractionItem.failure ? { failure: extractionItem.failure } : {}),
      })
    }

    while (true) {
      const context = this.hookContext(run, extractionItem, 'training', undefined, attempts)
      const variableValues = this.store.runVariables(run.id)
      let extraction
      try {
        extraction = await hookRunner.run(
          'after_evaluation', run.config.experienceExtractorHook, context, variableValues,
          undefined,
          {
            referencePolicy: 'hidden',
            onLlmActivity: (activity) => this.store.recordEvent(run.id, 'hook.llm', { sourceCaseId: item.id, ...activity }),
          },
        )
      } catch (error) {
        this.store.recordEvent(run.id, 'experience.extraction_failed', {
          sourceCaseId: item.id,
          hookId: run.config.experienceExtractorHook.hookId,
          message: error instanceof Error ? error.message : String(error),
          usage: error instanceof LearningHookExecutionError ? error.usage : { ...EMPTY_USAGE },
        })
        // Evaluation already succeeded (including any correction). Learning is
        // best-effort and must not change the case or batch outcome.
        this.store.setCaseStatus(item.id, 'completed')
        return
      }
      const generated = extraction.experiences.map((candidate) =>
        this.candidate(run, item, run.config.experienceExtractorHook.hookId, candidate))
      if (generated.length === 0) {
        this.store.setCaseStatus(item.id, 'completed')
        return
      }
      this.store.createExperiences(generated)
      const accepted: ExperienceCandidate[] = []
      let correctionSeed: TrainingCase | undefined
      for (const candidate of generated) {
        let outcome: ReplayOutcome
        try {
          outcome = await this.replay(run, candidate, attempts)
        } catch (error) {
          const latest = this.store.getExperience(candidate.id)
          this.store.setExperienceStatus(candidate.id, 'conflict', this.replayMetadata(latest))
          this.store.recordEvent(run.id, 'admission.error', {
            candidateId: candidate.id,
            message: error instanceof Error ? error.message : String(error),
          })
          continue
        }
        if (outcome.verdict === 'retry_correction') {
          correctionSeed = this.caseFromDetail(referencedItem, outcome.detail, reference)
          break
        }
        if (outcome.verdict === 'accept') accepted.push(this.store.getExperience(candidate.id))
      }
      if (correctionSeed) {
        for (const candidate of generated) {
          const latest = this.store.getExperience(candidate.id)
          if (!['rejected', 'conflict'].includes(latest.status)) {
            this.store.setExperienceStatus(candidate.id, 'rejected', this.replayMetadata(latest))
          }
        }
        const corrected = await this.correctUntilSuccess(
          run, referencedItem, correctionSeed, hookRunner, attempts, correctionStartedAt,
        )
        attempts = corrected.attempts
        if (!corrected.successfulItem) {
          this.store.recordEvent(run.id, 'correction.retry_abandoned', {
            sourceCaseId: item.id,
            attempts: attempts.length,
            reason: 'admission_requested_retry_failed',
          })
          this.refreshReviewState(run.id, item.id, false)
          return
        }
        extractionItem = corrected.successfulItem
        continue
      }

      const needsReview = run.config.learningMode === 'author'
        || (run.config.learningMode === 'review'
          && (run.config.reviewScope === 'all' || item.passed === false))
      for (const candidate of accepted) {
        if (needsReview) {
          this.store.setExperienceStatus(candidate.id, 'pending_review', this.replayMetadata(candidate))
        } else {
          await this.applyCandidate(this.store.getExperience(candidate.id))
        }
      }
      this.refreshReviewState(run.id, item.id, false)
      return
    }
  }

  private async correctUntilSuccess(
    run: TrainingRun,
    source: TrainingCase,
    seed: TrainingCase,
    hookRunner: LearningHookRunner,
    existingAttempts: TrainingCorrectionAttempt[],
    startedAt: number,
  ): Promise<CorrectionLoopResult> {
    const attempts = [...existingAttempts]
    const binding = run.config.correctionHook
    if (!binding) return { attempts }
    let failedItem = seed
    let semanticAttempts = attempts.filter((attempt) =>
      !['hook_error', 'execution_error', 'evaluation_error'].includes(attempt.terminalReason ?? '')).length
    // Every correction invocation consumes one bounded attempt, including
    // malformed Hook output and execution failures. Provider/network retries
    // remain inside executeCase and must not create an unbounded correction loop.
    while (attempts.length < run.config.maxCorrectionAttempts) {
      const elapsed = Date.now() - startedAt
      const usedTokens = attempts.reduce((total, attempt) =>
        total + (attempt.usage.totalTokens ?? 0) + (attempt.hookUsage.totalTokens ?? 0), 0)
      if (elapsed >= run.config.maxCorrectionWallTimeMs) {
        this.store.recordEvent(run.id, 'correction.budget_exhausted', {
          sourceCaseId: source.id,
          reason: elapsed >= run.config.maxCorrectionWallTimeMs ? 'max_wall_time' : 'max_tokens',
          semanticAttempts,
          totalTokens: usedTokens,
          elapsedMs: elapsed,
        })
        break
      }
      const ordinal = attempts.length + 1
      const attemptStartedAt = new Date().toISOString()
      // Each correction receives a fresh allowance, shared by its Hook and execution.
      const remainingTokens = run.config.maxCorrectionTokens
      let execution
      try {
        execution = await hookRunner.run(
          'after_evaluation',
          binding,
          this.hookContext(run, failedItem, 'training', undefined, attempts),
          this.store.runVariables(run.id),
          undefined,
          {
            referencePolicy: 'hidden', maxTotalTokens: remainingTokens,
            onLlmActivity: (activity) => this.store.recordEvent(run.id, 'hook.llm', { sourceCaseId: source.id, ...activity }),
          },
        )
      } catch (error) {
        const hookUsage = error instanceof LearningHookExecutionError ? error.usage : { ...EMPTY_USAGE }
        const attempt: TrainingCorrectionAttempt = {
          id: randomUUID(),
          runId: run.id,
          sourceCaseId: source.id,
          ordinal,
          hookId: binding.hookId,
          summary: 'Correction Hook failed',
          strategy: error instanceof Error ? error.message : String(error),
          variableOverrides: {},
          actualAnswer: failedItem.actualAnswer,
          actualTools: failedItem.actualTools,
          toolCalls: failedItem.toolCalls,
          usage: { ...EMPTY_USAGE },
          hookUsage,
          score: failedItem.score ?? 0,
          passed: false,
          rationale: error instanceof Error ? error.message : String(error),
          terminalReason: 'hook_error',
          startedAt: attemptStartedAt,
          completedAt: new Date().toISOString(),
        }
        this.store.createCorrectionAttempt(attempt)
        attempts.push(attempt)
        if (attempts.length >= run.config.maxCorrectionAttempts) return { attempts }
        continue
      }

      if (!execution.correction) {
        const attempt: TrainingCorrectionAttempt = {
          id: randomUUID(),
          runId: run.id,
          sourceCaseId: source.id,
          ordinal,
          hookId: binding.hookId,
          summary: 'Correction Hook returned no proposal',
          strategy: 'The correction Hook must return a correction proposal for a failed case.',
          variableOverrides: {},
          actualAnswer: failedItem.actualAnswer,
          actualTools: failedItem.actualTools,
          toolCalls: failedItem.toolCalls,
          usage: { ...EMPTY_USAGE },
          hookUsage: execution.usage,
          score: failedItem.score ?? 0,
          passed: false,
          rationale: 'correction Hook did not return a correction proposal',
          terminalReason: 'hook_error',
          startedAt: attemptStartedAt,
          completedAt: new Date().toISOString(),
        }
        this.store.createCorrectionAttempt(attempt)
        attempts.push(attempt)
        if (attempts.length >= run.config.maxCorrectionAttempts) return { attempts }
        continue
      }

      const proposal = execution.correction
      try {
        this.assertCorrectionOverrides(proposal.variableOverrides)
      } catch (error) {
        const attempt: TrainingCorrectionAttempt = {
          id: randomUUID(), runId: run.id, sourceCaseId: source.id, ordinal, hookId: binding.hookId,
          summary: proposal.summary,
          strategy: error instanceof Error ? error.message : String(error),
          variableOverrides: proposal.variableOverrides,
          actualAnswer: failedItem.actualAnswer,
          actualTools: failedItem.actualTools,
          toolCalls: failedItem.toolCalls,
          usage: { ...EMPTY_USAGE },
          hookUsage: execution.usage,
          score: failedItem.score ?? 0,
          passed: false,
          rationale: error instanceof Error ? error.message : String(error),
          terminalReason: 'hook_error',
          startedAt: attemptStartedAt,
          completedAt: new Date().toISOString(),
        }
        this.store.createCorrectionAttempt(attempt)
        attempts.push(attempt)
        if (attempts.length >= run.config.maxCorrectionAttempts) return { attempts }
        continue
      }

      const totalAfterHook = execution.usage.totalTokens
      const elapsedAfterHook = Date.now() - startedAt
      const budgetReason: TrainingCorrectionAttempt['terminalReason'] = totalAfterHook >= run.config.maxCorrectionTokens
        ? 'max_tokens'
        : run.config.maxCorrectionWallTimeMs - elapsedAfterHook < 1_000 ? 'max_wall_time' : undefined
      if (budgetReason) {
        const attempt: TrainingCorrectionAttempt = {
          id: randomUUID(), runId: run.id, sourceCaseId: source.id, ordinal, hookId: binding.hookId,
          summary: proposal.summary,
          strategy: proposal.strategy,
          variableOverrides: proposal.variableOverrides,
          actualAnswer: failedItem.actualAnswer,
          actualTools: failedItem.actualTools,
          toolCalls: failedItem.toolCalls,
          usage: { ...EMPTY_USAGE },
          hookUsage: execution.usage,
          score: failedItem.score ?? 0,
          passed: false,
          rationale: budgetReason === 'max_tokens'
            ? 'Correction token budget was exhausted before clean execution.'
            : 'Correction wall-time budget was exhausted before clean execution.',
          terminalReason: budgetReason,
          startedAt: attemptStartedAt,
          completedAt: new Date().toISOString(),
        }
        this.store.createCorrectionAttempt(attempt)
        attempts.push(attempt)
        if (budgetReason === 'max_tokens') { semanticAttempts += 1; continue }
        return { attempts }
      }

      const overrides = { ...this.store.runVariables(run.id), ...proposal.variableOverrides }
      let detail: ExperimentCaseDetail
      try {
        detail = await this.executeCase(
          run,
          { ...source, status: 'queued' },
          overrides,
          false,
          Math.min(run.config.timeoutMs, run.config.maxCorrectionWallTimeMs - elapsedAfterHook),
          startedAt + run.config.maxCorrectionWallTimeMs,
          run.config.maxCorrectionTokens - totalAfterHook,
        )
      } catch (error) {
        const attempt: TrainingCorrectionAttempt = {
          id: randomUUID(), runId: run.id, sourceCaseId: source.id, ordinal, hookId: binding.hookId,
          summary: proposal.summary,
          strategy: proposal.strategy,
          variableOverrides: proposal.variableOverrides,
          actualAnswer: failedItem.actualAnswer,
          actualTools: failedItem.actualTools,
          toolCalls: failedItem.toolCalls,
          usage: { ...EMPTY_USAGE },
          hookUsage: execution.usage,
          score: 0,
          passed: false,
          rationale: error instanceof Error ? error.message : String(error),
          failure: failure(error, 'CORRECTION_EXECUTION_FAILED'),
          terminalReason: error instanceof CorrectionBudgetError ? error.reason
            : String(error).includes('TOKEN_BUDGET_EXHAUSTED') ? 'max_tokens' : 'execution_error',
          startedAt: attemptStartedAt,
          completedAt: new Date().toISOString(),
        }
        this.store.createCorrectionAttempt(attempt)
        attempts.push(attempt)
        if (attempt.terminalReason === 'max_tokens') { semanticAttempts += 1; continue }
        return { attempts }
      }

      const infrastructureFailure = detail.failure || detail.passed === undefined
      const semanticOrdinal = semanticAttempts + 1
      const totalTokens = totalAfterHook + detail.usage.totalTokens
      const wallTimeReached = Date.now() - startedAt >= run.config.maxCorrectionWallTimeMs
      const tokenLimitReached = totalTokens >= run.config.maxCorrectionTokens
        || detail.failure?.message.includes('TOKEN_BUDGET_EXHAUSTED') === true
      const terminalReason: TrainingCorrectionAttempt['terminalReason'] = tokenLimitReached
        ? 'max_tokens'
        : infrastructureFailure
        ? detail.failure?.phase === 'evaluation' ? 'evaluation_error' : 'execution_error'
        : detail.passed === true
          ? 'succeeded'
          : semanticOrdinal >= run.config.maxCorrectionAttempts
            ? 'max_attempts'
            : tokenLimitReached
              ? 'max_tokens'
              : wallTimeReached ? 'max_wall_time' : undefined
      const attempt: TrainingCorrectionAttempt = {
        id: randomUUID(),
        runId: run.id,
        sourceCaseId: source.id,
        ordinal,
        hookId: binding.hookId,
        summary: proposal.summary,
        strategy: proposal.strategy,
        variableOverrides: proposal.variableOverrides,
        experimentRunId: detail.runId,
        experimentCaseId: detail.id,
        actualAnswer: detail.actualAnswer,
        actualTools: detail.actualTools,
        toolCalls: detail.toolCalls,
        usage: detail.usage,
        hookUsage: execution.usage,
        score: detail.score ?? 0,
        passed: detail.passed === true,
        rationale: detail.rationale ?? detail.failure?.message ?? '',
        ...(detail.evaluation ? { evaluation: detail.evaluation } : {}),
        ...(detail.failure ? { failure: detail.failure } : {}),
        ...(terminalReason ? { terminalReason } : {}),
        startedAt: attemptStartedAt,
        completedAt: new Date().toISOString(),
      }
      this.store.createCorrectionAttempt(attempt)
      attempts.push(attempt)
      if (tokenLimitReached) {
        semanticAttempts = semanticOrdinal
        // An exhausted attempt must not consume the next attempt's allowance.
        continue
      }
      if (infrastructureFailure) return { attempts }
      semanticAttempts = semanticOrdinal
      const replayedItem = this.caseFromDetail(source, detail, source.evaluation?.reference)
      if (attempt.passed) return { successfulItem: replayedItem, attempts }
      failedItem = replayedItem
      if (terminalReason) return { attempts }
    }
    return { attempts }
  }

  private async replay(
    run: TrainingRun,
    originalCandidate: ExperienceCandidate,
    correctionAttempts: TrainingCorrectionAttempt[],
  ): Promise<ReplayOutcome> {
    const source = this.store.getCase(originalCandidate.sourceCaseId)
    let candidate = originalCandidate
    try {
      for (let revision = 0; revision <= run.config.maxReplayRevisions; revision += 1) {
        const overrides = {
          ...this.store.runVariables(run.id),
          ...this.writer.preview(candidate.patches, this.store.runVariables(run.id)),
        }
        this.store.setExperienceStatus(candidate.id, 'replaying')
        this.store.setCaseStatus(source.id, 'replaying')
        const detail = await this.executeCase(run, { ...source, status: 'queued' }, overrides, false)
        const replay = {
          caseId: detail.id,
          passed: detail.passed === true,
          score: detail.score ?? 0,
          rationale: detail.rationale ?? detail.failure?.message ?? '',
        }
        candidate = this.store.recordExperienceReplay(candidate.id, replay)
        const hooks = new LearningHookRunner(this.projectDir, this.experiments.runtimeLlm())
        const decisions = []
        const replayItem = this.caseFromDetail(source, detail, source.evaluation?.reference)
        for (const binding of hooks.bindings('after_replay')) {
          const execution = await hooks.run(
            'after_replay',
            binding,
            this.hookContext(run, replayItem, 'replay', {
              ...candidate,
              patches: candidate.patches.map(({ variableName, baseHash, unifiedDiff, beforeValue, afterValue }) => ({
                variableName, baseHash, unifiedDiff, beforeValue, afterValue,
              })),
            }, correctionAttempts),
            overrides,
            undefined,
            { onLlmActivity: (activity) => this.store.recordEvent(run.id, 'hook.llm', { sourceCaseId: source.id, candidateId: candidate.id, ...activity }) },
          )
          if (execution.admission) decisions.push(execution.admission)
        }
        let verdict: 'accept' | 'reject' | 'revise' | 'promote' | 'retry_correction' = replay.passed ? 'accept' : 'reject'
        if (decisions.some((decision) => decision.verdict === 'reject')) verdict = 'reject'
        else if (decisions.some((decision) => decision.verdict === 'retry_correction')) verdict = 'retry_correction'
        else if (decisions.some((decision) => decision.verdict === 'revise')) verdict = 'revise'
        else if (decisions.some((decision) => decision.verdict === 'promote')) verdict = 'promote'
        else if (decisions.some((decision) => decision.verdict === 'accept')) verdict = 'accept'
        const reasons = decisions.flatMap((decision) => decision.reasons)
        if (verdict === 'accept' && !replay.passed) {
          verdict = 'reject'
          reasons.push('A failed closed-book replay cannot be admitted.')
        }
        if (verdict === 'accept' && candidate.requiredCleanReplays > 1) {
          verdict = 'reject'
          reasons.push('A managed experience must complete its structured promotion lifecycle before publication.')
        }
        this.store.recordEvent(run.id, 'admission.decided', {
          candidateId: candidate.id,
          revision,
          replayPassed: replay.passed,
          verdict,
          reasons,
          stage: candidate.stage,
          level: candidate.level,
          replayCount: candidate.replayCount,
          contentHash: candidate.contentHash,
        })
        if (verdict === 'revise') {
          const revised = decisions.find((decision) => decision.verdict === 'revise')?.revisedCandidate
          if (!revised || revision >= run.config.maxReplayRevisions) {
            this.store.setExperienceStatus(candidate.id, 'rejected', replay)
            return { verdict: 'reject', reasons: [...reasons, 'Replay revision limit reached.'], detail }
          }
          const revisedCandidate = this.candidate(run, source, candidate.hookId, revised)
          const transition = decisions.find((decision) => decision.verdict === 'revise')?.transition
          candidate = transition
            ? this.transitionCandidate(candidate, revisedCandidate, transition, false)
            : this.store.updateExperiencePatches(candidate.id, revisedCandidate.patches)
          const searchStrategyPatch = revisedCandidate.patches.find((patch) => patch.variableName === "gaia_search_strategy")
          if (searchStrategyPatch) {
            const beforeValue = searchStrategyPatch.beforeValue ?? ""
            const afterValue = searchStrategyPatch.afterValue ?? beforeValue
            await this.writer.promote(
              { gaia_search_strategy: beforeValue },
              { gaia_search_strategy: afterValue },
            )
          }
          continue
        }
        if (verdict === 'promote') {
          const promoted = decisions.find((decision) => decision.verdict === 'promote')?.revisedCandidate
          if (!promoted) {
            this.store.setExperienceStatus(candidate.id, 'rejected', replay)
            return { verdict: 'reject', reasons: [...reasons, 'Promotion did not include a finalized candidate.'], detail }
          }
          const promotedCandidate = this.candidate(run, source, candidate.hookId, promoted)
          const transition = decisions.find((decision) => decision.verdict === 'promote')?.transition
          if (!transition) throw new Error('Promotion did not include a structured transition.')
          candidate = this.transitionCandidate(candidate, promotedCandidate, transition, true)
          return { verdict: 'accept', reasons, detail }
        }
        if (verdict === 'retry_correction') {
          this.store.setExperienceStatus(candidate.id, 'replay_failed', replay)
          return { verdict, reasons, detail }
        }
        this.store.setExperienceStatus(candidate.id, verdict === 'accept' ? 'accepted' : 'rejected', replay)
        return { verdict, reasons, detail }
      }
      throw new Error('replay revision loop completed without a decision')
    } finally {
      this.store.setCaseStatus(source.id, 'evaluated')
    }
  }

  private candidate(
    run: TrainingRun,
    item: TrainingCase,
    hookId: string,
    generated: HookExperienceCandidate,
  ): ExperienceCandidate {
    const values = this.store.runVariables(run.id)
    const patches: VariableDiff[] = generated.patches.map((patch) => {
      const beforeValue = values[patch.variableName]
      if (beforeValue === undefined) throw new Error(`learnable project variable was not found: ${patch.variableName}`)
      return { ...patch, baseHash: patch.baseHash ?? variableHash(beforeValue) }
    })
    const after = this.writer.preview(patches, values)
    const now = new Date().toISOString()
    const id = randomUUID()
    const lifecycle = generated.lifecycle ?? {
      stage: 'candidate' as const,
      level: 1 as const,
      contextBudgetTokens: 32_768,
      requiredCleanReplays: 1,
      entryIds: [],
    }
    const normalizedPatches = patches.map((patch) => ({
      ...patch,
      beforeValue: values[patch.variableName] ?? '',
      afterValue: after[patch.variableName] ?? '',
    }))
    return {
      id,
      runId: run.id,
      sourceCaseId: item.id,
      sourceOutcome: item.passed ? 'success' : 'failure',
      hookId,
      summary: generated.summary,
      rationale: generated.rationale,
      patches: normalizedPatches,
      stage: lifecycle.stage,
      level: lifecycle.level,
      contextBudgetTokens: lifecycle.contextBudgetTokens,
      replayGeneration: Math.max(0, lifecycle.level - 1),
      replayCount: 0,
      requiredCleanReplays: lifecycle.requiredCleanReplays,
      revision: 1,
      contentHash: experienceContentHash(normalizedPatches),
      sourceCandidateId: id,
      entryIds: lifecycle.entryIds,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    }
  }

  private transitionCandidate(
    current: ExperienceCandidate,
    revised: ExperienceCandidate,
    transition: HookExperienceTransition,
    finalized: boolean,
  ): ExperienceCandidate {
    if (current.promotionId === transition.promotionId
      && current.stage === transition.targetStage
      && current.level === transition.targetLevel
      && current.contextBudgetTokens === transition.contextBudgetTokens) {
      return current
    }
    if (transition.expectedStage !== current.stage
      || transition.expectedRevision !== current.revision
      || transition.expectedContentHash !== current.contentHash) {
      throw new Error('Promotion command does not match the current experience revision')
    }
    if (revised.stage !== transition.targetStage
      || revised.level !== transition.targetLevel
      || revised.contextBudgetTokens !== transition.contextBudgetTokens) {
      throw new Error('Revised candidate lifecycle does not match its promotion command')
    }
    const lifecycle = {
      stage: transition.targetStage,
      level: transition.targetLevel,
      contextBudgetTokens: transition.contextBudgetTokens,
      replayGeneration: current.replayGeneration + 1,
      replayCount: current.replayCount,
      requiredCleanReplays: current.requiredCleanReplays,
      revision: current.revision + 1,
      contentHash: revised.contentHash,
      sourceCandidateId: current.sourceCandidateId || current.id,
      entryIds: current.entryIds,
      parentRevision: current.revision,
      promotionId: transition.promotionId,
    }
    return this.store.transitionExperience(
      current.id,
      revised.patches,
      lifecycle,
      {
        stage: transition.expectedStage,
        revision: transition.expectedRevision,
        contentHash: transition.expectedContentHash,
      },
      finalized,
    )
  }

  private async applyCandidate(candidate: ExperienceCandidate): Promise<void> {
    try {
      const current = this.store.runVariables(candidate.runId)
      const updates = this.writer.preview(candidate.patches, current)
      const baseline = Object.fromEntries(candidate.patches.map((patch) => {
        const beforeValue = patch.beforeValue ?? current[patch.variableName]
        if (beforeValue === undefined) throw new Error(`candidate baseline is missing: ${patch.variableName}`)
        return [patch.variableName, beforeValue]
      }))
      const published = await this.writer.promote(baseline, updates)
      this.store.publishExperience(candidate.id, { ...current, ...updates }, {
        candidateId: candidate.id,
        sourceCaseId: candidate.sourceCaseId,
        contentHash: published.contentHash,
        variables: Object.keys(published.variables).sort(),
        stage: candidate.stage,
        level: candidate.level,
        replayCount: candidate.replayCount,
        promotionId: candidate.promotionId,
      })
    } catch (error) {
      this.store.setExperienceStatus(candidate.id, 'conflict', this.replayMetadata(candidate))
      this.store.recordEvent(candidate.runId, 'experience.publish_conflict', {
        candidateId: candidate.id,
        sourceCaseId: candidate.sourceCaseId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private replayMetadata(candidate: ExperienceCandidate): {
    caseId: string
    passed: boolean
    score: number
    rationale: string
  } | undefined {
    return candidate.replayCaseId ? {
      caseId: candidate.replayCaseId,
      passed: candidate.replayPassed === true,
      score: candidate.replayScore ?? 0,
      rationale: candidate.replayRationale ?? '',
    } : undefined
  }

  private assertCorrectionOverrides(overrides: Record<string, string>): void {
    const variables = new Map(
      new PluginRegistry(this.projectDir).effectiveSystemVariablesState().resource.variables
        .map((variable) => [variable.key, variable]),
    )
    for (const key of Object.keys(overrides)) {
      const variable = variables.get(key)
      if (!variable) throw new Error(`correction variable was not found: ${key}`)
      if (variable.readonly) throw new Error(`correction variable is read-only: ${key}`)
      if (variable.scope !== 'session') {
        throw new Error(`correction variable must be session-scoped: ${key}`)
      }
    }
  }

  private caseFromDetail(
    source: TrainingCase,
    detail: ExperimentCaseDetail,
    reference?: ExperimentReference,
  ): TrainingCase {
    return {
      ...source,
      actualAnswer: detail.actualAnswer,
      actualTools: detail.actualTools,
      toolCalls: detail.toolCalls,
      usage: detail.usage,
      score: detail.score ?? 0,
      passed: detail.passed === true,
      rationale: detail.rationale ?? detail.failure?.message ?? '',
      ...(detail.evaluation
        ? { evaluation: { ...detail.evaluation, ...(reference ? { reference } : {}) } }
        : source.evaluation
          ? { evaluation: { ...source.evaluation, ...(reference ? { reference } : {}) } }
          : {}),
      experimentRunId: detail.runId,
      experimentCaseId: detail.id,
      ...(detail.failure ? { failure: detail.failure } : { failure: undefined }),
      updatedAt: detail.completedAt ?? new Date().toISOString(),
      completedAt: detail.completedAt ?? new Date().toISOString(),
    }
  }

  private refreshReviewState(runId: string, sourceCaseId: string, schedule = true): void {
    const candidates = this.store.listExperiences(runId).filter((item) => item.sourceCaseId === sourceCaseId)
    const run = this.store.getRun(runId)
    if (run.config.learningMode === 'auto') {
      const conflicted = candidates.some((item) => item.status === 'conflict')
      for (const candidate of candidates) {
        if (!['applied', 'rejected'].includes(candidate.status)) {
          this.store.setExperienceStatus(candidate.id, 'rejected', this.replayMetadata(candidate))
        }
      }
      // A correct source answer remains completed even when optional
      // experience extraction/replay fails. `unresolved` is reserved for a
      // task whose answer or correction could not be resolved.
      const sourceCase = this.store.getCase(sourceCaseId)
      this.store.setCaseStatus(sourceCaseId, conflicted && sourceCase.passed !== true ? 'unresolved' : 'completed')
      if (run.status === 'waiting_review') this.store.setRunStatus(runId, 'running', { pauseReason: null })
      if (schedule) this.schedule(runId)
      return
    }
    const unresolved = candidates.some((item) => !['applied', 'rejected'].includes(item.status))
    if (unresolved) {
      this.store.setCaseStatus(sourceCaseId, 'waiting_review')
      this.store.setRunStatus(runId, 'waiting_review', { currentCaseId: sourceCaseId, pauseReason: 'Experience review required.' })
      return
    }
    this.store.setCaseStatus(sourceCaseId, 'completed')
    if (run.status === 'waiting_review') this.store.setRunStatus(runId, 'running', { pauseReason: null })
    if (schedule) this.schedule(runId)
  }

  private hookContext(
    run: TrainingRun,
    item: TrainingCase,
    phase: HookTrainingContext['phase'],
    candidate?: HookTrainingContext['candidate'],
    correctionAttempts: TrainingCorrectionAttempt[] = [],
  ): Omit<HookTrainingContext, 'parameters'> {
    // Only actor-visible messages enter learning. Never forward the complete trace:
    // it also contains scoring prompts, reference answers and adapter evaluation.
    const transcript = item.experimentRunId && item.experimentCaseId
      ? this.experiments.case(item.experimentRunId, item.experimentCaseId).trace?.actorMessages
      : undefined
    return {
      runId: run.id,
      phase,
      case: {
        id: item.id,
        sampleId: item.sampleId,
        question: item.question,
        thinking: item.thinking,
        expectedAnswer: item.expectedAnswer,
        actualAnswer: item.actualAnswer,
        expectedTools: item.expectedTools,
        actualTools: item.actualTools,
        toolCalls: item.toolCalls,
        ...(transcript ? { transcript } : {}),
      },
      evaluation: {
        passed: item.passed === true,
        score: item.score ?? 0,
        rationale: item.rationale ?? item.failure?.message ?? '',
        ...(item.evaluation?.source ? { source: item.evaluation.source } : {}),
        metrics: item.evaluation?.metrics ?? {},
        ...(item.evaluation?.details === undefined ? {} : { details: item.evaluation.details }),
        ...(item.evaluation?.reference === undefined ? {} : { reference: item.evaluation.reference }),
      },
      ...(candidate ? { candidate } : {}),
      ...(correctionAttempts.length > 0 ? {
        correctionAttempts: correctionAttempts.map((attempt) => ({
          ordinal: attempt.ordinal,
          summary: attempt.summary,
          strategy: attempt.strategy,
          passed: attempt.passed,
          score: attempt.score,
          rationale: attempt.rationale,
          variableOverrides: attempt.variableOverrides,
          actualAnswer: attempt.actualAnswer,
          actualTools: attempt.actualTools,
          toolCalls: attempt.toolCalls,
        })),
      } : {}),
    }
  }

  private trainingCase(
    runId: string,
    phase: TrainingCase['phase'],
    datasetId: string,
    record: DatasetRecord,
    ordinal: number,
    createdAt: string,
  ): TrainingCase {
    return {
      id: randomUUID(),
      runId,
      phase,
      datasetId,
      sampleId: record.id,
      ordinal,
      status: 'queued',
      question: record.question,
      thinking: record.thinking,
      expectedAnswer: record.answer,
      actualAnswer: '',
      expectedTools: record.expectedTools,
      actualTools: [],
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 },
      failurePauseHandled: false,
      attempt: 0,
      createdAt,
      updatedAt: createdAt,
    }
  }

  private async hydrateMissingReferences(id: string): Promise<void> {
    this.store.getRun(id)
    const adapter = ExperimentAdapterRunner.load(this.projectDir)
    if (!adapter?.supports('reference')) return
    const unresolved = this.store.listCases(id).flatMap((item) => {
      if (!item.experimentRunId || !item.experimentCaseId || ['queued', 'running'].includes(item.status)) return []
      let detail: ExperimentCaseDetail
      try {
        detail = this.experiments.case(item.experimentRunId, item.experimentCaseId)
      } catch {
        return []
      }
      if (detail.evaluation?.reference?.source.resolverRevision === adapter.revision) {
        this.store.updateCaseEvaluation(item.id, detail.evaluation)
        return []
      }
      if (detail.evaluation?.source !== 'project') return []
      return [{ item, detail }]
    })
    for (let offset = 0; offset < unresolved.length; offset += 25) {
      const batch = unresolved.slice(offset, offset + 25)
      let references = new Map<string, ExperimentReference>()
      try {
        const resolved = await adapter.references({
          run: { id },
          cases: batch.map(({ item, detail }) => ({
            id: item.id,
            experimentRunId: item.experimentRunId,
            experimentCaseId: item.experimentCaseId,
            sampleId: item.sampleId,
            metadata: detail.metadata,
            evaluation: detail.evaluation ?? null,
            completedAt: item.completedAt ?? null,
          })),
        } as JsonObject)
        references = new Map(resolved.map((entry) => [entry.id, entry.reference]))
      } catch (error) {
        references = new Map(batch.map(({ item }) => [item.id, failedReference(item, adapter.revision, error)]))
      }
      for (const { item, detail } of batch) {
        const reference = references.get(item.id)
          ?? failedReference(item, adapter.revision, 'reference adapter did not return this case')
        const evaluation = { ...(detail.evaluation ?? { source: 'project' as const, metrics: {} }), reference }
        this.experiments.updateCaseEvaluation(item.experimentRunId ?? '', item.experimentCaseId ?? '', evaluation)
        this.store.updateCaseEvaluation(item.id, evaluation)
      }
    }
  }

  private records(datasetId: string, limit: number): DatasetRecord[] {
    const records: DatasetRecord[] = []
    while (records.length < limit) {
      const page = this.datasets.listRecords(datasetId, {
        offset: records.length,
        limit: Math.min(200, limit - records.length),
      })
      records.push(...page.items)
      if (page.items.length === 0 || records.length >= page.total) break
    }
    return records.slice(0, limit)
  }

  private assertHook(value: TrainingHookBinding, checkpoint: 'after_evaluation'): TrainingHookBinding {
    const hook = new HookRegistry(this.projectDir).getTraining(value.hookId)
    if (!hook || !hook.enabled || !hook.loadable) throw new Error(`training Hook is unavailable: ${value.hookId}`)
    if (hook.checkpoint !== checkpoint) throw new Error(`Hook ${value.hookId} must use ${checkpoint}`)
    const definitions = new Map(hook.parameters.map((parameter) => [parameter.key, parameter]))
    const unknown = Object.keys(value.parameters).find((key) => !definitions.has(key))
    if (unknown) throw new Error(`Hook ${value.hookId} does not define parameter: ${unknown}`)
    const parameters = Object.fromEntries(hook.parameters.map((parameter) => {
      const configured = value.parameters[parameter.key] ?? parameter.defaultValue
      if (parameter.input === 'number') {
        const numeric = Number(configured)
        if (!Number.isFinite(numeric)) throw new Error(`Hook parameter ${parameter.key} must be numeric`)
        if (parameter.min !== undefined && numeric < parameter.min) {
          throw new Error(`Hook parameter ${parameter.key} must be at least ${parameter.min}`)
        }
        if (parameter.max !== undefined && numeric > parameter.max) {
          throw new Error(`Hook parameter ${parameter.key} must not exceed ${parameter.max}`)
        }
      }
      return [parameter.key, configured]
    }))
    return { ...value, parameters }
  }
}
