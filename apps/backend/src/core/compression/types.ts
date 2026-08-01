import type { LlmMessage } from '#util/llm'

export interface CompressionPolicy {
  trigger_ratio: number
  target_ratio: number
  preserve_recent_turns: number
  max_source_tokens: number
  max_output_tokens: number
  retry_limit: number
  apply_mode: 'automatic' | 'debug'
}

export interface CompressionManifest {
  version: 1
  id: string
  name: string
  description: string
  entry: string
  policy: CompressionPolicy
}

export interface CompressionDiagnostic {
  severity: 'info' | 'warning' | 'error'
  code: string
  message: string
}

export interface CompressionResource {
  manifest: CompressionManifest
  prompt: string
  revision: string
  source: string
  variables: string[]
  diagnostics: CompressionDiagnostic[]
}

export interface CompressionSourceUnit {
  id: string
  messageIndexes: number[]
  messages: LlmMessage[]
  tokenCount: number
}

export interface CompressionPlan {
  baseRevision: number
  sourceHash: string
  units: CompressionSourceUnit[]
  beforeTokens: number
  targetTokens: number
}

export interface CompressionSummary {
  facts: string[]
  decisions: string[]
  user_requirements: string[]
  completed_work: string[]
  open_items: string[]
  important_evidence: string[]
}

export interface CompressionPatchOperation {
  op: 'replace_with_summary'
  source_unit_ids: string[]
  summary: CompressionSummary
}

export interface CompressionPatch {
  version: 1
  base_revision: number
  source_hash: string
  patch_status: 'complete'
  operations: CompressionPatchOperation[]
}

export interface CompressionRunResult {
  plan: CompressionPlan
  patch: CompressionPatch
  renderedPrompt: string
  responseText: string
  finishReason?: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cacheReadTokens?: number
  }
}
