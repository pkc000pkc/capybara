import { HookRegistry } from '#core/hooks/hook-registry'
import { HookRunError, HookRunner } from '#core/hooks/hook-runner'
import type {
  HookAdmissionDecision,
  HookCheckpoint,
  HookCorrectionProposal,
  HookExperienceCandidate,
  HookTrainingContext,
} from '#core/hooks/types'
import type { ExperimentUsage } from '#core/experiments/types'
import { learningFixture } from '#core/experiments/training/learning-checkpoints'
import type { TrainingHookBinding } from '#core/experiments/training/training-types'
import { resolveTrainingReference } from '#core/experiments/training/training-reference'
import { ProjectResources } from '#core/project-resources'
import type { RuntimeLlm } from '#core/runtime-loop'
import type { JsonValue } from '#protocol/runtime-protocol'

export interface LearningHookExecution {
  experiences: HookExperienceCandidate[]
  correction?: HookCorrectionProposal
  admission?: HookAdmissionDecision
  metadata?: JsonValue
  usage: ExperimentUsage
}

export interface LearningHookRunOptions {
  referencePolicy?: 'required' | 'hidden'
  maxTotalTokens?: number
}

export class LearningHookExecutionError extends Error {
  constructor(
    error: unknown,
    readonly usage: ExperimentUsage,
  ) {
    super(error instanceof Error ? error.message : String(error), { cause: error })
    this.name = 'LearningHookExecutionError'
  }
}

const EMPTY_USAGE: ExperimentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
}

function experimentUsage(value: Partial<ExperimentUsage> | undefined): ExperimentUsage {
  return { ...EMPTY_USAGE, ...value }
}

function hiddenContext(
  context: Omit<HookTrainingContext, 'parameters'>,
): Omit<HookTrainingContext, 'parameters'> {
  const passed = context.evaluation.passed === true
  return {
    runId: context.runId,
    phase: context.phase,
    case: {
      ...context.case,
      thinking: '',
      expectedAnswer: '',
      expectedTools: [],
    },
    evaluation: {
      passed,
      score: passed ? 1 : 0,
      rationale: passed
        ? 'The clean execution passed.'
        : 'The clean execution was marked incorrect. Diagnose only from observable behavior.',
      metrics: {},
    },
    ...(!passed ? {
      failureEvidence: {
        outcome: 'incorrect' as const,
        message: 'The clean execution was marked incorrect; no reference answer or Judge explanation is available.',
        actualAnswer: context.case.actualAnswer,
        actualTools: context.case.actualTools,
        toolCalls: context.case.toolCalls,
      },
    } : {}),
    ...(context.candidate ? { candidate: context.candidate } : {}),
    ...(context.correctionAttempts ? {
      correctionAttempts: context.correctionAttempts.map((attempt) => ({
        ...attempt,
        score: attempt.passed ? 1 : 0,
        rationale: attempt.passed
          ? 'The clean correction attempt passed.'
          : 'The clean correction attempt was marked incorrect.',
      })),
    } : {}),
  }
}

function candidates(value: unknown): HookExperienceCandidate[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('Hook experiences must be an array')
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`Hook experiences[${index}] must be an object`)
    }
    const item = candidate as Record<string, unknown>
    if (typeof item.summary !== 'string' || !item.summary.trim()) {
      throw new Error(`Hook experiences[${index}].summary is required`)
    }
    if (typeof item.rationale !== 'string' || !item.rationale.trim()) {
      throw new Error(`Hook experiences[${index}].rationale is required`)
    }
    if (!Array.isArray(item.patches) || item.patches.length === 0) {
      throw new Error(`Hook experiences[${index}].patches must not be empty`)
    }
    const names = new Set<string>()
    const patches = item.patches.map((patch, patchIndex) => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error(`Hook experiences[${index}].patches[${patchIndex}] must be an object`)
      }
      const value = patch as Record<string, unknown>
      if (typeof value.variableName !== 'string' || !value.variableName.trim()) {
        throw new Error(`Hook patch ${patchIndex} variableName is required`)
      }
      if (names.has(value.variableName)) throw new Error(`Hook candidate repeats variable: ${value.variableName}`)
      names.add(value.variableName)
      if (value.baseHash !== undefined && (typeof value.baseHash !== 'string' || !/^[a-f0-9]{64}$/i.test(value.baseHash))) {
        throw new Error(`Hook patch ${patchIndex} baseHash must be a SHA-256 hash`)
      }
      if (typeof value.unifiedDiff !== 'string' || !value.unifiedDiff.trim()) {
        throw new Error(`Hook patch ${patchIndex} unifiedDiff is required`)
      }
      return {
        variableName: value.variableName,
        ...(typeof value.baseHash === 'string' ? { baseHash: value.baseHash } : {}),
        unifiedDiff: value.unifiedDiff,
      }
    })
    return { summary: item.summary.trim(), rationale: item.rationale.trim(), patches }
  })
}

function correction(value: unknown): HookCorrectionProposal | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Hook correction must be an object')
  const item = value as Record<string, unknown>
  if (typeof item.summary !== 'string' || !item.summary.trim()) throw new Error('Hook correction.summary is required')
  if (typeof item.strategy !== 'string' || !item.strategy.trim()) throw new Error('Hook correction.strategy is required')
  if (!item.variableOverrides || typeof item.variableOverrides !== 'object' || Array.isArray(item.variableOverrides)) {
    throw new Error('Hook correction.variableOverrides must be an object')
  }
  const variableOverrides = Object.fromEntries(Object.entries(item.variableOverrides).map(([key, value]) => {
    if (!key.trim() || typeof value !== 'string') throw new Error('Hook correction variable overrides must be strings')
    return [key, value]
  }))
  if (Object.keys(variableOverrides).length === 0) throw new Error('Hook correction.variableOverrides must not be empty')
  return { summary: item.summary.trim(), strategy: item.strategy.trim(), variableOverrides }
}

function admission(value: unknown): HookAdmissionDecision | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Hook admission must be an object')
  const item = value as Record<string, unknown>
  if (!['accept', 'reject', 'revise', 'retry_correction'].includes(String(item.verdict))) {
    throw new Error('Hook admission.verdict must be accept, reject, revise, or retry_correction')
  }
  if (!Array.isArray(item.reasons) || !item.reasons.every((reason) => typeof reason === 'string' && reason.trim())) {
    throw new Error('Hook admission.reasons must be a non-empty string array')
  }
  if (item.reasons.length === 0) throw new Error('Hook admission.reasons must not be empty')
  const revised = item.revisedCandidate === undefined ? undefined : candidates([item.revisedCandidate])[0]
  if (item.verdict === 'revise' && !revised) throw new Error('Hook admission revise verdict requires revisedCandidate')
  return {
    verdict: item.verdict as HookAdmissionDecision['verdict'],
    reasons: item.reasons.map((reason) => String(reason).trim()),
    ...(revised ? { revisedCandidate: revised } : {}),
  }
}

export class LearningHookRunner {
  private readonly registry: HookRegistry
  private readonly resources: ProjectResources

  constructor(readonly projectDir: string, private readonly llm: RuntimeLlm) {
    this.registry = new HookRegistry(projectDir)
    this.resources = new ProjectResources(projectDir)
  }

  async run(
    checkpoint: HookCheckpoint,
    binding: TrainingHookBinding,
    context: Omit<HookTrainingContext, 'parameters'>,
    variableValues: Record<string, string> = {},
    signal?: AbortSignal,
    options: LearningHookRunOptions = {},
  ): Promise<LearningHookExecution> {
    const referencePolicy = options.referencePolicy ?? 'required'
    if (checkpoint === 'after_replay' || referencePolicy === 'hidden') {
      context = hiddenContext(context)
    } else if (checkpoint === 'after_evaluation') {
      if (context.phase !== 'training') {
        throw new Error('after_evaluation Hooks are only available in training mode')
      }
      const reference = resolveTrainingReference(
        context.case.expectedAnswer,
        context.evaluation.reference,
        new Date().toISOString(),
      )
      if (!reference) {
        throw new Error('training Hook requires a correct answer or an available official state reference')
      }
      context = {
        ...context,
        evaluation: { ...context.evaluation, reference },
      }
    }
    const hook = this.registry.getTraining(binding.hookId)
    if (!hook) throw new Error(`training Hook was not found: ${binding.hookId}`)
    if (!hook.loadable || !hook.enabled) throw new Error(`training Hook is not enabled and loadable: ${binding.hookId}`)
    if (hook.checkpoint !== checkpoint) {
      throw new Error(`Hook ${binding.hookId} uses ${hook.checkpoint}, expected ${checkpoint}`)
    }
    let execution
    try {
      execution = await new HookRunner(this.llm).run(
        hook,
        learningFixture(
          checkpoint,
          { ...context, parameters: binding.parameters },
          this.resources.readSystemVariables().variables,
          variableValues,
        ),
        signal,
        options.maxTotalTokens === undefined ? {} : { maxTotalTokens: options.maxTotalTokens },
      )
    } catch (error) {
      const usage = error instanceof HookRunError ? experimentUsage(error.usage) : EMPTY_USAGE
      throw new LearningHookExecutionError(error, usage)
    }
    try {
      const experiences = execution.matched ? candidates(execution.result?.experiences) : []
      const correctionProposal = execution.matched ? correction(execution.result?.correction) : undefined
      const admissionDecision = execution.matched ? admission(execution.result?.admission) : undefined
      if (experiences.length > 0 && hook.permissions.variables !== 'patch') {
        throw new Error(`Hook ${binding.hookId} returned experiences without variables:patch permission`)
      }
      if (correctionProposal && hook.permissions.variables !== 'patch') {
        throw new Error(`Hook ${binding.hookId} returned correction without variables:patch permission`)
      }
      if (admissionDecision?.revisedCandidate && hook.permissions.variables !== 'patch') {
        throw new Error(`Hook ${binding.hookId} revised a candidate without variables:patch permission`)
      }
      return {
        experiences,
        ...(correctionProposal ? { correction: correctionProposal } : {}),
        ...(admissionDecision ? { admission: admissionDecision } : {}),
        ...(execution.result?.metadata === undefined ? {} : { metadata: execution.result.metadata }),
        usage: experimentUsage(execution.usage),
      }
    } catch (error) {
      throw new LearningHookExecutionError(error, experimentUsage(execution.usage))
    }
  }

  bindings(checkpoint: HookCheckpoint): TrainingHookBinding[] {
    return this.registry.listTraining()
      .filter((hook) => hook.enabled && hook.loadable && hook.checkpoint === checkpoint)
      .map((hook) => ({ hookId: hook.id, parameters: {} }))
  }
}
