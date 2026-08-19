import type { ExperimentReference } from '#core/experiments/types'

function nonEmptyText(reference: ExperimentReference): boolean {
  return Boolean(
    reference.displayValue?.trim()
    || (typeof reference.value === 'string' && reference.value.trim()),
  )
}

export function usableTrainingReference(reference: ExperimentReference | undefined): reference is ExperimentReference {
  if (!reference || reference.status !== 'available') return false
  if (reference.kind === 'text') return nonEmptyText(reference)
  return reference.kind === 'state'
    && reference.source.type === 'official_evaluator'
    && (reference.requirements.length > 0 || reference.expectedState !== undefined)
}

export function resolveTrainingReference(
  expectedAnswer: string,
  reference: ExperimentReference | undefined,
  resolvedAt: string,
): ExperimentReference | undefined {
  if (usableTrainingReference(reference)) return reference
  const expected = expectedAnswer.trim()
  if (!expected) return undefined
  return {
    kind: 'text',
    status: 'available',
    source: { type: 'dataset' },
    displayValue: expected,
    value: expected,
    requirements: [],
    actualStateChanges: [],
    failureTraces: [],
    resolvedAt,
  }
}
