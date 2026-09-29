import { createHash } from 'node:crypto'

function clone(value) { return structuredClone(value) }
function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function text(value) { return typeof value === 'string' ? value.trim() : '' }

const FORBIDDEN_KEYS = new Set(['expectedAnswer', 'referenceAnswer', 'oracle', 'judgeRationale', 'scorerRationale', 'benchmarkOutcome'])

function assertSealed(value, path = 'value') {
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`sealed evaluator violation: ${path}.${key}`)
    assertSealed(item, `${path}.${key}`)
  }
}

/** Project a runtime result into reusable process evidence without task truth. */
export function sanitizeGaia2Trace(runtimeResult = {}) {
  assertSealed(runtimeResult, 'runtimeResult')
  return {
    schemaVersion: 'gaia2-experience-trace-v1',
    capability: text(runtimeResult.capability) || 'unknown',
    actionKinds: [...new Set((runtimeResult.actions || []).map((action) => text(action.type)).filter(Boolean))].sort(),
    actionResults: (runtimeResult.actions || []).map((action) => text(action.result)).filter(Boolean),
    observationStatuses: [...new Set((runtimeResult.observationSummary || []).map((item) => text(item.status)).filter(Boolean))].sort(),
    oracleWithheld: Number(runtimeResult.oracleWithheld || 0),
    noise: {
      profile: text(runtimeResult.noise?.profile) || 'off',
      injected: Number(runtimeResult.noise?.injected || 0),
      blocked: Number(runtimeResult.noise?.conflicting || 0) + Number(runtimeResult.noise?.truncated || 0),
    },
  }
}

export function extractGaia2Candidate(runtimeResult = {}) {
  const trace = sanitizeGaia2Trace(runtimeResult)
  const statuses = new Set(trace.observationStatuses)
  const actions = new Set(trace.actionKinds)
  const procedures = []
  if (statuses.has('incomplete') || statuses.has('stale') || statuses.has('conflicting')) procedures.push('Treat incomplete, stale, or conflicting observations as unverified; obtain complete evidence from an authoritative source before deciding.')
  if (actions.has('write_start') || actions.has('write_fail')) procedures.push('Use a mutation key and read back the authoritative state before retrying an uncertain write.')
  if (trace.oracleWithheld > 0) procedures.push('Keep evaluator and oracle state sealed; verify only against observable tool and environment evidence.')
  if (!procedures.length) procedures.push('Record provenance for material evidence, verify the requested state, and stop when evidence is insufficient.')
  const candidate = {
    id: `gaia2-${trace.capability}-${hash(procedures).slice(0, 12)}`,
    stage: 'candidate',
    level: 1,
    scope: 'project',
    trigger: `GAIA2 ${trace.capability} task has observable evidence or mutation uncertainty.`,
    process_defect: 'The execution path may finalize from incomplete evidence or an unverified side effect.',
    procedure: procedures.join(' '),
    verification: 'A clean replay must obtain complete evidence, verify the resulting state, and preserve the sealed evaluator boundary.',
    traceHash: hash(trace),
    replayCount: 0,
  }
  assertSealed(candidate, 'candidate')
  return candidate
}

/** Promote only after two clean, answer-blind replays. */
export async function admitGaia2Candidate(candidate, replay) {
  if (!candidate || candidate.stage !== 'candidate') throw new Error('candidate stage is required')
  if (typeof replay !== 'function') throw new Error('replay callback is required')
  const current = clone(candidate)
  assertSealed(current, 'candidate')
  const first = await replay({ candidate: clone(current), stage: 'candidate', clean: true })
  assertSealed(first, 'first replay')
  if (first?.passed !== true) return { ...current, replayCount: 1, status: 'rejected', rejection: 'candidate did not pass first clean replay' }
  current.stage = 'project_experience'
  current.level = 2
  current.replayCount = 1
  const second = await replay({ candidate: clone(current), stage: 'project_experience', clean: true })
  assertSealed(second, 'second replay')
  if (second?.passed !== true) return { ...current, replayCount: 2, status: 'rejected', rejection: 'project experience did not pass shadow replay' }
  return { ...current, stage: 'plugin_stable', level: 3, replayCount: 2, status: 'admitted' }
}

export function selectGaia2Experiences(catalog, capability, limit = 3) {
  return (Array.isArray(catalog) ? catalog : [])
    .filter((item) => item?.status === 'admitted' && item.stage === 'plugin_stable')
    .filter((item) => !capability || text(item.trigger).toLowerCase().includes(String(capability).toLowerCase()))
    .slice(0, Math.max(0, Math.floor(limit)))
    .map(clone)
}
