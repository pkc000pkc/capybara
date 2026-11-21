export type ContextDurability = 'project' | 'session' | 'transient'
export type ContextTarget = 'project' | 'session' | 'cache'
export type ContextClassificationConfidence = 'low' | 'medium' | 'high'

export interface ContextClassification {
  durability: ContextDurability
  target: ContextTarget
  confidence: ContextClassificationConfidence
  reason: string
  projectAnchors: string[]
}

const durabilityValues = ['project', 'session', 'transient']
const targetValues = ['project', 'session', 'cache']
const confidenceValues = ['low', 'medium', 'high']
const nonBlank = { type: 'string', pattern: '\\S' }

export const CONTEXT_CLASSIFICATION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['durability', 'target', 'confidence', 'reason', 'projectAnchors'],
  properties: {
    durability: { enum: durabilityValues },
    target: { enum: targetValues },
    confidence: { enum: confidenceValues },
    reason: nonBlank,
    projectAnchors: { type: 'array', items: nonBlank },
  },
}

const PROJECT_ANCHOR_PATTERN = /^project:(?:file|prompt|config|tool|manifest|explicit|artifact):\S+$/u

export function validateContextClassification(value: unknown): asserts value is ContextClassification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CONTEXT_CLASSIFICATION_INVALID')
  const classification = value as Record<string, unknown>
  if (!durabilityValues.some(value => value === classification.durability)) throw new Error('CONTEXT_CLASSIFICATION_INVALID')
  if (!targetValues.some(value => value === classification.target)) throw new Error('CONTEXT_CLASSIFICATION_INVALID')
  if (!confidenceValues.some(value => value === classification.confidence)) throw new Error('CONTEXT_CLASSIFICATION_INVALID')
  if (typeof classification.reason !== 'string' || !classification.reason.trim()) throw new Error('CONTEXT_CLASSIFICATION_INVALID')
  if (!Array.isArray(classification.projectAnchors) || classification.projectAnchors.some((anchor) => typeof anchor !== 'string' || !anchor.trim())) throw new Error('CONTEXT_CLASSIFICATION_INVALID')
}

export function canPromoteToProject(classification: ContextClassification | undefined, evidenceRefs: readonly string[]): { ok: true } | { ok: false; errorCode: string } {
  if (!classification) return { ok: false, errorCode: 'PROJECT_CLASSIFICATION_REQUIRED' }
  try {
    validateContextClassification(classification)
  } catch {
    return { ok: false, errorCode: 'PROJECT_CLASSIFICATION_INVALID' }
  }
  if (classification.durability !== 'project' || classification.target !== 'project') {
    return { ok: false, errorCode: 'PROJECT_RELEVANCE_REQUIRED' }
  }
  if (classification.projectAnchors.length === 0 || classification.projectAnchors.some((anchor) => !PROJECT_ANCHOR_PATTERN.test(anchor))) {
    return { ok: false, errorCode: 'PROJECT_ANCHOR_REQUIRED' }
  }
  if (evidenceRefs.length === 0) return { ok: false, errorCode: 'PROJECT_EVIDENCE_REQUIRED' }
  return { ok: true }
}

export function cloneContextClassification(value: ContextClassification | undefined): ContextClassification | undefined {
  return value ? structuredClone(value) : undefined
}

export function sameContextPlacement(left: ContextClassification, right: ContextClassification): boolean {
  return left.durability === right.durability
    && left.target === right.target
    && JSON.stringify([...left.projectAnchors].sort()) === JSON.stringify([...right.projectAnchors].sort())
}

export function projectAnchorParts(anchor: string): { kind: string; value: string } | undefined {
  const match = anchor.match(/^project:([^:]+):(.+)$/u)
  return match ? { kind: match[1] as string, value: match[2] as string } : undefined
}
