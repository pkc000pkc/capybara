import { randomUUID } from 'node:crypto'

import { DatasetStore, type DatasetRecord } from '#core/datasets/dataset-store'
import { ExperimentManager } from '#core/experiments/experiment-manager'
import type { ExperimentCaseDetail, ExperimentFailure } from '#core/experiments/types'
import { LearningHookRunner } from '#core/experiments/training/learning-hook-runner'
import {
  aggregateTrainingCases,
  aggregateTrainingExperiences,
  compareTrainingRuns,
} from '#core/experiments/training/training-analysis'
import { ProjectVariableWriter, variableHash } from '#core/experiments/training/project-variable-writer'
import { SnapshotService } from '#core/experiments/training/snapshot-service'
import { TrainingStore } from '#core/experiments/training/training-store'
import {
  MAX_TEST_CASES,
  MAX_TRAINING_CASES,
  type CreateTrainingInput,
  type ExperienceCandidate,
  type TestSnapshot,
  type TrainingCase,
  type TrainingCaseView,
  type TrainingConfig,
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
import type { HookExperienceCandidate, HookTrainingContext } from '#core/hooks/types'
import { HookRegistry } from '#core/hooks/hook-registry'
import { ProjectResources } from '#core/project-resources'

const DEFAULT_TIMEOUT_MS = 15 * 60_000
const ACTIVE_STATUSES = new Set(['queued', 'running', 'testing'])

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

export class TrainingManager {
  readonly store: TrainingStore
  private readonly datasets: DatasetStore
  private readonly writer: ProjectVariableWriter
  private readonly snapshots: SnapshotService
  private readonly active = new Map<string, Promise<void>>()
  private readonly activeChildren = new Map<string, string>()
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
    const timeoutMs = boundedInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, 60 * 60_000, 'timeoutMs')
    const experienceExtractorHook = binding(input.experienceExtractorHook, 'experienceExtractorHook', true)
    const correctionHook = binding(input.correctionHook, 'correctionHook', false)
    this.assertHook(experienceExtractorHook, 'after_evaluation')
    if (correctionHook) this.assertHook(correctionHook, 'after_evaluation')
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
        new ProjectResources(this.projectDir).readSystemVariables().variables
          .filter((variable) => variable.scope === 'project' && !variable.readonly)
          .map((variable) => [variable.key, variable.value]),
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

  list(limit?: number): TrainingRun[] {
    return this.store.listRuns(limit)
  }

  get(id: string): TrainingRun {
    return this.store.getRun(id)
  }

  cases(id: string): TrainingCaseView[] {
    const run = this.store.getRun(id)
    const testingReferencesAvailable = ['completed', 'failed', 'cancelled'].includes(run.status)
    return this.store.listCases(id).map((item) => {
      const referenceAvailable = item.phase === 'training'
        ? !['queued', 'running'].includes(item.status)
        : testingReferencesAvailable
      return {
        ...item,
        expectedAnswer: referenceAvailable
          ? item.expectedAnswer.trim() || (item.passed ? item.actualAnswer : '')
          : '',
        expectedTools: referenceAvailable ? item.expectedTools : [],
        referenceAvailable,
      }
    })
  }

  experiences(id: string): ExperienceCandidate[] {
    return this.store.listExperiences(id)
  }

  variables(id: string): TrainingVariableReport {
    const resources = new ProjectResources(this.projectDir).readSystemVariables().variables
      .filter((variable) => variable.scope === 'project' && !variable.readonly)
    const projectValues = Object.fromEntries(resources.map((variable) => [variable.key, variable.value]))
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
    const hooks = new HookRegistry(this.projectDir).list()
      .filter((hook) => hook.enabled && hook.loadable)
      .map((hook) => ({ id: hook.id, name: hook.name, checkpoint: hook.checkpoint }))
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
    if (run.status !== 'failed') throw new Error('training run has no terminal failure to retry')
    const failedCase = this.store.listCases(id).find((item) => item.status === 'error')
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
    if (!['ready_to_freeze', 'ready_for_test', 'completed'].includes(run.status)) {
      throw new Error('training must finish before promoting variables')
    }
    const result = await this.writer.promote(this.store.baselineVariables(id), this.store.runVariables(id))
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
    await this.replay(run, candidate)
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
        const next = this.store.listCases(id, phase).find((item) => !['completed', 'error'].includes(item.status))
        if (!next) {
          this.store.setRunStatus(id, phase === 'training' ? 'ready_to_freeze' : 'completed', {
            currentCaseId: null,
            pauseReason: null,
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
      this.store.setRunStatus(id, 'failed', { failure: failure(error), currentCaseId: null })
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
    if (item.passed === false && run.config.pauseOnFailure && !item.failurePauseHandled) {
      this.store.acknowledgeFailurePause(item.id)
      this.store.setRunStatus(run.id, 'paused_failure', {
        currentCaseId: item.id,
        pauseReason: `Case ${item.sampleId} failed evaluation.`,
      })
      return false
    }
    if (item.status === 'evaluated') await this.learnFromCase(run, this.store.getCase(item.id))
    return this.store.getCase(item.id).status === 'completed'
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
  ): Promise<ExperimentCaseDetail> {
    const projectVariables = new Set(
      new ProjectResources(this.projectDir).readSystemVariables().variables
        .filter((variable) => variable.scope === 'project' && !variable.readonly)
        .map((variable) => variable.key),
    )
    const sourceVariables = variableOverrides ?? this.store.runVariables(run.id)
    const overrides = Object.fromEntries(Object.entries(sourceVariables).filter(([key]) => projectVariables.has(key)))
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const child = await this.experiments.create({
        datasetId: item.datasetId,
        name: `${run.name} · ${item.phase} ${item.ordinal + 1}`,
        concurrency: 1,
        repetitions: 1,
        timeoutMs: run.config.timeoutMs,
        keepWorkspaces: false,
        sampleIds: [item.sampleId],
      }, {
        allowDirtyProject: true,
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
      const detail = this.experiments.case(terminal.id, childCase.id)
      const shouldRetry = detail.failure?.retryable === true
        && attempt < 2
        && (!persist || ACTIVE_STATUSES.has(this.store.getRun(run.id).status))
      if (shouldRetry) {
        await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt))
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
          ...(detail.failure ? { failure: detail.failure } : {}),
        })
      }
      return detail
    }
    throw new Error('training case retry loop completed without a result')
  }

  private async learnFromCase(run: TrainingRun, item: TrainingCase): Promise<void> {
    this.store.setCaseStatus(item.id, 'learning')
    const hookRunner = new LearningHookRunner(this.projectDir, this.experiments.runtimeLlm())
    let context = this.hookContext(run, item, 'training')
    const variableValues = this.store.runVariables(run.id)
    const generated: ExperienceCandidate[] = []
    if (item.passed === false && run.config.correctionHook) {
      const correction = await hookRunner.run('after_evaluation', run.config.correctionHook, context, variableValues)
      generated.push(...correction.experiences.map((candidate) =>
        this.candidate(run, item, run.config.correctionHook?.hookId ?? '', candidate)))
      if (correction.metadata !== undefined) {
        context = { ...context, priorResults: { correction: correction.metadata } }
      }
    }
    const extraction = await hookRunner.run('after_evaluation', run.config.experienceExtractorHook, context, variableValues)
    generated.push(...extraction.experiences.map((candidate) =>
      this.candidate(run, item, run.config.experienceExtractorHook.hookId, candidate)))
    if (generated.length === 0) {
      this.store.setCaseStatus(item.id, 'completed')
      return
    }
    this.store.createExperiences(generated)
    for (const candidate of generated) {
      try {
        await this.replay(run, candidate)
      } catch {
        const latest = this.store.getExperience(candidate.id)
        this.store.setExperienceStatus(candidate.id, 'conflict', this.replayMetadata(latest))
        continue
      }
      const replayed = this.store.getExperience(candidate.id)
      const needsReview = run.config.learningMode === 'author'
        || (run.config.learningMode === 'review'
          && (run.config.reviewScope === 'all' || item.passed === false))
      if (needsReview) {
        this.store.setExperienceStatus(candidate.id, 'pending_review', this.replayMetadata(replayed))
      } else if (replayed.replayPassed) {
        await this.applyCandidate(this.store.getExperience(candidate.id))
      } else {
        this.store.setExperienceStatus(candidate.id, 'rejected', this.replayMetadata(replayed))
      }
    }
    this.refreshReviewState(run.id, item.id, false)
  }

  private async replay(run: TrainingRun, candidate: ExperienceCandidate): Promise<void> {
    const source = this.store.getCase(candidate.sourceCaseId)
    const overrides = {
      ...this.store.runVariables(run.id),
      ...this.writer.preview(candidate.patches, this.store.runVariables(run.id)),
    }
    this.store.setExperienceStatus(candidate.id, 'replaying')
    this.store.setCaseStatus(source.id, 'replaying')
    const replayCase: TrainingCase = { ...source, status: 'queued' }
    const detail = await this.executeCase(run, replayCase, overrides, false)
    const replay = {
      caseId: detail.id,
      passed: detail.passed === true,
      score: detail.score ?? 0,
      rationale: detail.rationale ?? detail.failure?.message ?? '',
    }
    this.store.setExperienceStatus(candidate.id, replay.passed ? 'accepted' : 'replay_failed', replay)
    const hooks = new LearningHookRunner(this.projectDir, this.experiments.runtimeLlm())
    for (const binding of hooks.bindings('after_replay')) {
      await hooks.run('after_replay', binding, this.hookContext(run, this.store.getCase(source.id), 'replay', {
        ...candidate,
        patches: candidate.patches.map(({ variableName, baseHash, unifiedDiff }) => ({ variableName, baseHash, unifiedDiff })),
      }), overrides)
    }
    this.store.setCaseStatus(source.id, 'evaluated')
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
    return {
      id: randomUUID(),
      runId: run.id,
      sourceCaseId: item.id,
      sourceOutcome: item.passed ? 'success' : 'failure',
      hookId,
      summary: generated.summary,
      rationale: generated.rationale,
      patches: patches.map((patch) => ({
        ...patch,
        beforeValue: values[patch.variableName] ?? '',
        afterValue: after[patch.variableName] ?? '',
      })),
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    }
  }

  private async applyCandidate(candidate: ExperienceCandidate): Promise<void> {
    try {
      this.store.setExperienceStatus(candidate.id, 'accepted', this.replayMetadata(candidate))
      const current = this.store.runVariables(candidate.runId)
      const updates = this.writer.preview(candidate.patches, current)
      this.store.replaceRunVariables(candidate.runId, { ...current, ...updates })
      this.store.setExperienceStatus(candidate.id, 'applied', this.replayMetadata(candidate))
    } catch {
      this.store.setExperienceStatus(candidate.id, 'conflict', this.replayMetadata(candidate))
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

  private refreshReviewState(runId: string, sourceCaseId: string, schedule = true): void {
    const candidates = this.store.listExperiences(runId).filter((item) => item.sourceCaseId === sourceCaseId)
    const unresolved = candidates.some((item) => !['applied', 'rejected'].includes(item.status))
    if (unresolved) {
      this.store.setCaseStatus(sourceCaseId, 'waiting_review')
      this.store.setRunStatus(runId, 'waiting_review', { currentCaseId: sourceCaseId, pauseReason: 'Experience review required.' })
      return
    }
    this.store.setCaseStatus(sourceCaseId, 'completed')
    const run = this.store.getRun(runId)
    if (run.status === 'waiting_review') this.store.setRunStatus(runId, 'running', { pauseReason: null })
    if (schedule) this.schedule(runId)
  }

  private hookContext(
    run: TrainingRun,
    item: TrainingCase,
    phase: HookTrainingContext['phase'],
    candidate?: HookTrainingContext['candidate'],
  ): Omit<HookTrainingContext, 'parameters'> {
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
      },
      evaluation: {
        passed: item.passed === true,
        score: item.score ?? 0,
        rationale: item.rationale ?? item.failure?.message ?? '',
      },
      ...(candidate ? { candidate } : {}),
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

  private records(datasetId: string, limit: number): DatasetRecord[] {
    return this.datasets.listRecords(datasetId, { offset: 0, limit }).items
  }

  private assertHook(value: TrainingHookBinding, checkpoint: 'after_evaluation'): void {
    const hook = new HookRegistry(this.projectDir).get(value.hookId)
    if (!hook || !hook.enabled || !hook.loadable) throw new Error(`training Hook is unavailable: ${value.hookId}`)
    if (hook.checkpoint !== checkpoint) throw new Error(`Hook ${value.hookId} must use ${checkpoint}`)
  }
}
