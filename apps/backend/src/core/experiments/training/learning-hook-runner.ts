import { HookRegistry } from '#core/hooks/hook-registry'
import { HookRunner } from '#core/hooks/hook-runner'
import type {
  HookCheckpoint,
  HookExperienceCandidate,
  HookTrainingContext,
} from '#core/hooks/types'
import { learningFixture } from '#core/experiments/training/learning-checkpoints'
import type { TrainingHookBinding } from '#core/experiments/training/training-types'
import { ProjectResources } from '#core/project-resources'
import type { RuntimeLlm } from '#core/runtime-loop'
import type { JsonValue } from '#protocol/runtime-protocol'

export interface LearningHookExecution {
  experiences: HookExperienceCandidate[]
  metadata?: JsonValue
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
  ): Promise<LearningHookExecution> {
    const hook = this.registry.get(binding.hookId)
    if (!hook) throw new Error(`training Hook was not found: ${binding.hookId}`)
    if (!hook.loadable || !hook.enabled) throw new Error(`training Hook is not enabled and loadable: ${binding.hookId}`)
    if (hook.checkpoint !== checkpoint) {
      throw new Error(`Hook ${binding.hookId} uses ${hook.checkpoint}, expected ${checkpoint}`)
    }
    const execution = await new HookRunner(this.llm).run(
      hook,
      learningFixture(
        checkpoint,
        { ...context, parameters: binding.parameters },
        this.resources.readSystemVariables().variables,
        variableValues,
      ),
      signal,
    )
    const experiences = execution.matched ? candidates(execution.result?.experiences) : []
    if (experiences.length > 0 && hook.permissions.variables !== 'patch') {
      throw new Error(`Hook ${binding.hookId} returned experiences without variables:patch permission`)
    }
    return {
      experiences,
      ...(execution.result?.metadata === undefined ? {} : { metadata: execution.result.metadata }),
    }
  }

  bindings(checkpoint: HookCheckpoint): TrainingHookBinding[] {
    return this.registry.list()
      .filter((hook) => hook.enabled && hook.loadable && hook.checkpoint === checkpoint)
      .map((hook) => ({ hookId: hook.id, parameters: {} }))
  }
}
