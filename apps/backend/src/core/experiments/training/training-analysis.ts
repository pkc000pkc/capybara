import { createHash } from 'node:crypto'

import type { ExperimentUsage } from '#core/experiments/types'
import type {
  ExperienceCandidate,
  TrainingCase,
  TrainingCaseComparison,
  TrainingCaseMetrics,
  TrainingComparisonReport,
  TrainingExperienceMetrics,
  TrainingRunAnalysis,
  TrainingVariableComparison,
} from '#core/experiments/training/training-types'

const EMPTY_USAGE: ExperimentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
}

function sumUsage(items: TrainingCase[]): ExperimentUsage {
  return items.reduce((total, item) => ({
    inputTokens: total.inputTokens + item.usage.inputTokens,
    outputTokens: total.outputTokens + item.usage.outputTokens,
    totalTokens: total.totalTokens + item.usage.totalTokens,
    cacheReadTokens: total.cacheReadTokens + item.usage.cacheReadTokens,
  }), { ...EMPTY_USAGE })
}

export function aggregateTrainingCases(items: TrainingCase[]): TrainingCaseMetrics {
  const scored = items.filter((item) => item.score !== undefined)
  const evaluated = items.filter((item) => item.passed !== undefined)
  const passed = evaluated.filter((item) => item.passed).length
  const expectedTools = items.reduce((total, item) => total + new Set(item.expectedTools).size, 0)
  const matchedTools = items.reduce((total, item) => {
    const actual = new Set(item.actualTools)
    return total + [...new Set(item.expectedTools)].filter((tool) => actual.has(tool)).length
  }, 0)
  return {
    total: items.length,
    completed: items.filter((item) => ['completed', 'error'].includes(item.status)).length,
    evaluated: evaluated.length,
    passed,
    failed: evaluated.length - passed,
    errors: items.filter((item) => item.status === 'error' || item.failure).length,
    averageScore: scored.length > 0
      ? scored.reduce((total, item) => total + (item.score ?? 0), 0) / scored.length
      : 0,
    passRate: evaluated.length > 0 ? passed / evaluated.length : 0,
    usage: sumUsage(items),
    toolCalls: items.reduce((total, item) => total + item.toolCalls.length, 0),
    toolErrors: items.reduce((total, item) => total + item.toolCalls.filter((call) => call.status === 'failed').length, 0),
    expectedTools,
    matchedTools,
  }
}

export function aggregateTrainingExperiences(items: ExperienceCandidate[]): TrainingExperienceMetrics {
  const pending = new Set(['draft', 'replaying', 'pending_review', 'accepted'])
  return {
    generated: items.length,
    replayed: items.filter((item) => item.replayPassed !== undefined).length,
    replayPassed: items.filter((item) => item.replayPassed).length,
    pending: items.filter((item) => pending.has(item.status)).length,
    applied: items.filter((item) => item.status === 'applied').length,
    rejected: items.filter((item) => ['rejected', 'replay_failed'].includes(item.status)).length,
    conflicts: items.filter((item) => item.status === 'conflict').length,
    successSources: items.filter((item) => item.sourceOutcome === 'success').length,
    failureSources: items.filter((item) => item.sourceOutcome === 'failure').length,
  }
}

function comparisonValue(item: TrainingCase | undefined): number {
  return item?.score ?? (item?.passed ? 1 : 0)
}

function hasOutcome(item: TrainingCase | undefined): boolean {
  return item?.score !== undefined || item?.passed !== undefined
}

function compareCases(left: TrainingCase[], right: TrainingCase[]): TrainingCaseComparison[] {
  const leftBySample = new Map(left.map((item) => [item.sampleId, item]))
  const rightBySample = new Map(right.map((item) => [item.sampleId, item]))
  const ids = [...new Set([...leftBySample.keys(), ...rightBySample.keys()])]
  return ids.map((sampleId) => {
    const leftItem = leftBySample.get(sampleId)
    const rightItem = rightBySample.get(sampleId)
    const status: TrainingCaseComparison['status'] = !leftItem
      ? 'added'
      : !rightItem
        ? 'removed'
        : !hasOutcome(leftItem) || !hasOutcome(rightItem)
          ? 'pending'
          : comparisonValue(rightItem) > comparisonValue(leftItem)
            ? 'improved'
            : comparisonValue(rightItem) < comparisonValue(leftItem)
              ? 'regressed'
              : 'unchanged'
    return {
      sampleId,
      question: rightItem?.question ?? leftItem?.question ?? '',
      ...(leftItem ? { left: {
        ...(leftItem.score === undefined ? {} : { score: leftItem.score }),
        ...(leftItem.passed === undefined ? {} : { passed: leftItem.passed }),
        actualTools: leftItem.actualTools,
        expectedTools: leftItem.expectedTools,
      } } : {}),
      ...(rightItem ? { right: {
        ...(rightItem.score === undefined ? {} : { score: rightItem.score }),
        ...(rightItem.passed === undefined ? {} : { passed: rightItem.passed }),
        actualTools: rightItem.actualTools,
        expectedTools: rightItem.expectedTools,
      } } : {}),
      status,
    }
  })
}

function lines(value: string): string[] {
  if (!value) return []
  const normalized = value.replaceAll('\r\n', '\n')
  return normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n')
}

export function createTrainingVariableDiff(name: string, before: string, after: string): string {
  if (before === after) return ''
  const safeName = name.replaceAll(/[^a-zA-Z0-9._-]/g, '_') || 'variable'
  const beforeLines = lines(before)
  const afterLines = lines(after)
  const beforeHash = createHash('sha256').update(before).digest('hex').slice(0, 7)
  const afterHash = createHash('sha256').update(after).digest('hex').slice(0, 7)
  const oldStart = beforeLines.length === 0 ? 0 : 1
  const newStart = afterLines.length === 0 ? 0 : 1
  return [
    `diff --git a/variables/${safeName}.txt b/variables/${safeName}.txt`,
    `index ${beforeHash}..${afterHash} 100644`,
    `--- a/variables/${safeName}.txt`,
    `+++ b/variables/${safeName}.txt`,
    `@@ -${oldStart},${beforeLines.length} +${newStart},${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ].join('\n')
}

function compareVariables(left: TrainingRunAnalysis, right: TrainingRunAnalysis): TrainingVariableComparison[] {
  const leftByName = new Map(left.variableItems.map((item) => [item.name, item.snapshotValue ?? item.runValue]))
  const rightByName = new Map(right.variableItems.map((item) => [item.name, item.snapshotValue ?? item.runValue]))
  const names = [...new Set([...leftByName.keys(), ...rightByName.keys()])].sort()
  return names.map((name) => {
    const leftValue = leftByName.get(name) ?? ''
    const rightValue = rightByName.get(name) ?? ''
    return {
      name,
      leftValue,
      rightValue,
      changed: leftValue !== rightValue,
      unifiedDiff: createTrainingVariableDiff(name, leftValue, rightValue),
    }
  })
}

export function compareTrainingRuns(left: TrainingRunAnalysis, right: TrainingRunAnalysis): TrainingComparisonReport {
  const reasons: string[] = []
  if (left.run.config.testDatasetId !== right.run.config.testDatasetId) reasons.push('testing datasets differ')
  if (left.testDataset.version !== right.testDataset.version) reasons.push('testing dataset versions differ')
  const leftEvaluator = JSON.stringify(left.provenance?.evaluator ?? null)
  const rightEvaluator = JSON.stringify(right.provenance?.evaluator ?? null)
  if (leftEvaluator !== rightEvaluator) reasons.push('evaluators differ')
  return {
    comparable: reasons.length === 0,
    reasons,
    left,
    right,
    cases: compareCases(
      left.cases.filter((item) => item.phase === 'testing'),
      right.cases.filter((item) => item.phase === 'testing'),
    ),
    variables: compareVariables(left, right),
  }
}
