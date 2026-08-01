import { createHash } from 'node:crypto'

import {
  COMPRESSION_OUTPUT_SCHEMA,
  CompressionResourceStore,
} from '#core/compression/compression-resource'
import type {
  CompressionPatch,
  CompressionPlan,
  CompressionResource,
  CompressionRunResult,
  CompressionSourceUnit,
  CompressionSummary,
} from '#core/compression/types'
import type { RuntimeLlm } from '#core/runtime-loop'
import type { LlmMessage } from '#util/llm'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function estimateTokens(value: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(value).length / 4))
}

function unitId(messages: readonly LlmMessage[]): string {
  return `unit-${createHash('sha256').update(JSON.stringify(messages)).digest('hex').slice(0, 16)}`
}

export function conversationUnits(messages: readonly LlmMessage[]): CompressionSourceUnit[] {
  const units: CompressionSourceUnit[] = []
  let indexes: number[] = []
  const flush = () => {
    if (indexes.length === 0) return
    const source = indexes.map((index) => structuredClone(messages[index] as LlmMessage))
    if (
      source[0]?.role === 'user' &&
      source.some((message) => message.role === 'assistant') &&
      source.every((message) =>
        (message.role === 'user' || message.role === 'assistant') &&
        !message.toolCalls?.length,
      )
    ) {
      units.push({
        id: unitId(source),
        messageIndexes: indexes,
        messages: source,
        tokenCount: estimateTokens(source),
      })
    }
    indexes = []
  }
  messages.forEach((message, index) => {
    if (message.role === 'system') return
    if (message.role === 'user') flush()
    indexes.push(index)
  })
  flush()
  return units
}

export function omitCompressedUnits(
  messages: readonly LlmMessage[],
  sourceUnitIds: readonly string[],
): LlmMessage[] {
  const selected = new Set(sourceUnitIds)
  const removedIndexes = new Set(conversationUnits(messages)
    .filter((unit) => selected.has(unit.id))
    .flatMap((unit) => unit.messageIndexes))
  return messages
    .filter((_message, index) => !removedIndexes.has(index))
    .map((message) => structuredClone(message))
}

export function shrinkCompressionPlan(plan: CompressionPlan): CompressionPlan | undefined {
  if (plan.units.length <= 1) return
  const units = plan.units.slice(0, Math.ceil(plan.units.length / 2))
  return {
    ...plan,
    units,
    sourceHash: createHash('sha256').update(JSON.stringify(units)).digest('hex'),
  }
}

export function createCompressionPlan(
  messages: readonly LlmMessage[],
  resource: CompressionResource,
  baseRevision: number,
  maxInputTokens: number,
  tools: unknown[] = [],
  force = false,
): CompressionPlan | undefined {
  const beforeTokens = estimateTokens({ messages, tools })
  const policy = resource.manifest.policy
  if (!force && beforeTokens < Math.floor(maxInputTokens * policy.trigger_ratio)) return
  const allUnits = conversationUnits(messages)
  const eligible = allUnits.slice(0, Math.max(0, allUnits.length - policy.preserve_recent_turns))
  if (eligible.length === 0) return
  const targetTokens = Math.floor(maxInputTokens * policy.target_ratio)
  const requiredSavings = Math.max(1, beforeTokens - targetTokens)
  const units: CompressionSourceUnit[] = []
  let selectedTokens = 0
  for (const unit of eligible) {
    if (units.length > 0 && selectedTokens + unit.tokenCount > policy.max_source_tokens) break
    units.push(unit)
    selectedTokens += unit.tokenCount
    if (selectedTokens >= requiredSavings + policy.max_output_tokens) break
  }
  if (units.length === 0) return
  const sourceHash = createHash('sha256').update(JSON.stringify(units)).digest('hex')
  return { baseRevision, sourceHash, units, beforeTokens, targetTokens }
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${path} must be an array of strings`)
  }
  return value.map((item) => item.trim()).filter(Boolean)
}

function summary(value: unknown, path: string): CompressionSummary {
  if (!isObject(value)) throw new Error(`${path} must be an object`)
  return {
    facts: stringArray(value.facts, `${path}.facts`),
    decisions: stringArray(value.decisions, `${path}.decisions`),
    user_requirements: stringArray(value.user_requirements, `${path}.user_requirements`),
    completed_work: stringArray(value.completed_work, `${path}.completed_work`),
    open_items: stringArray(value.open_items, `${path}.open_items`),
    important_evidence: stringArray(value.important_evidence, `${path}.important_evidence`),
  }
}

export function parseCompressionPatch(text: string, plan: CompressionPlan): CompressionPatch {
  const source = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error('compression model returned incomplete or invalid JSON')
  }
  if (!isObject(value) || value.version !== 1 || value.patch_status !== 'complete') {
    throw new Error('compression patch must be complete version 1')
  }
  if (value.base_revision !== plan.baseRevision || value.source_hash !== plan.sourceHash) {
    throw new Error('compression patch does not match its source revision')
  }
  if (!Array.isArray(value.operations) || value.operations.length === 0) {
    throw new Error('compression patch must contain at least one operation')
  }
  const available = new Set(plan.units.map((unit) => unit.id))
  const used = new Set<string>()
  const operations = value.operations.map((operation, index) => {
    if (!isObject(operation) || operation.op !== 'replace_with_summary') {
      throw new Error(`operations[${index}] must use replace_with_summary`)
    }
    const ids = stringArray(operation.source_unit_ids, `operations[${index}].source_unit_ids`)
    if (ids.length === 0) throw new Error(`operations[${index}] must reference source units`)
    for (const id of ids) {
      if (!available.has(id)) throw new Error(`compression patch references unknown unit: ${id}`)
      if (used.has(id)) throw new Error(`compression patch references a unit twice: ${id}`)
      used.add(id)
    }
    return {
      op: 'replace_with_summary' as const,
      source_unit_ids: ids,
      summary: summary(operation.summary, `operations[${index}].summary`),
    }
  })
  const missing = [...available].filter((id) => !used.has(id))
  if (missing.length > 0) {
    throw new Error(`compression patch must cover every planned source unit: ${missing.join(', ')}`)
  }
  return {
    version: 1,
    base_revision: plan.baseRevision,
    source_hash: plan.sourceHash,
    patch_status: 'complete',
    operations,
  }
}

export function renderCompressionPrompt(
  store: CompressionResourceStore,
  resource: CompressionResource,
  plan: CompressionPlan,
): string {
  return store.render(resource, {
    compression: {
      base_revision: plan.baseRevision,
      source_hash: plan.sourceHash,
      source_units: plan.units.map(({ messageIndexes: _indexes, ...unit }) => unit),
      current_tokens: plan.beforeTokens,
      target_tokens: plan.targetTokens,
      output_schema: COMPRESSION_OUTPUT_SCHEMA,
    },
  })
}

export async function runCompression(
  llm: RuntimeLlm,
  store: CompressionResourceStore,
  resource: CompressionResource,
  plan: CompressionPlan,
  signal?: AbortSignal,
): Promise<CompressionRunResult> {
  const renderedPrompt = renderCompressionPrompt(store, resource, plan)
  const response = await llm.chat({
    messages: [{ role: 'user', content: renderedPrompt }],
    maxTokens: resource.manifest.policy.max_output_tokens,
    responseFormat: 'json',
    signal,
  })
  if (response.finishReason && /length|incomplete|max_output/i.test(response.finishReason)) {
    throw new Error(`compression output was incomplete: ${response.finishReason}`)
  }
  const patch = parseCompressionPatch(response.text, plan)
  return {
    plan,
    patch,
    renderedPrompt,
    responseText: response.text,
    finishReason: response.finishReason,
    usage: response.usage,
  }
}

export function applyCompressionPatch(
  messages: readonly LlmMessage[],
  plan: CompressionPlan,
  patch: CompressionPatch,
): LlmMessage[] {
  const selectedIds = new Set(patch.operations.flatMap((operation) => operation.source_unit_ids))
  const removedIndexes = new Set(plan.units
    .filter((unit) => selectedIds.has(unit.id))
    .flatMap((unit) => unit.messageIndexes))
  return messages.filter((_message, index) => !removedIndexes.has(index)).map((message) => structuredClone(message))
}
