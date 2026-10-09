/**
 * Read-only source of truth for the phase wiring used by the official ARE
 * `gaia2-run` command.
 *
 * This module deliberately does not invoke ARE, load a provider, or mutate a
 * runner.  It is a small guard at the boundary between our frozen protocol
 * and the official CLI.  The values mirror the pinned ARE 1.2.0
 * `handle_gaia2_run` implementation; a caller still has to pass them to the
 * official command explicitly.
 */

const STANDARD_CONFIGS = Object.freeze([
  // Keep the enum order used by ARE's CapabilityTag.gaia2_capabilities().
  'ambiguity', 'adaptability', 'execution', 'search', 'time',
])

export const OFFICIAL_SUBMISSION_PHASES = Object.freeze([
  Object.freeze({
    phase: 'standard',
    configs: STANDARD_CONFIGS,
    a2aAppProp: 0,
    noise: false,
    toolAugmentation: false,
    envEvents: null,
    numRuns: 3,
  }),
  Object.freeze({
    phase: 'agent2agent',
    configs: Object.freeze(['mini']),
    a2aAppProp: 1,
    noise: false,
    toolAugmentation: false,
    envEvents: null,
    numRuns: 3,
  }),
  Object.freeze({
    phase: 'noise',
    configs: Object.freeze(['mini']),
    a2aAppProp: 0,
    noise: true,
    toolAugmentation: true,
    envEvents: Object.freeze({ numEventsPerMinute: 10, seed: 0 }),
    numRuns: 3,
  }),
])

function fail(message) { throw new Error(`official submission config: ${message}`) }

function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]))
  return value
}

/** Validate the pinned protocol boundary without changing it. */
export function assertOfficialSubmissionProtocol(protocol) {
  if (!protocol || typeof protocol !== 'object') fail('protocol is required')
  const dataset = protocol.datasets?.submission
  if (dataset?.id !== 'meta-agents-research-environments/gaia2') fail('submission dataset ID must be the official GAIA2 dataset')
  if (dataset.split !== 'validation') fail('submission split must be validation')
  const mode = protocol.modes?.official_submission
  if (!mode || mode.datasetKind !== 'submission' || mode.initialRunsPerScenario !== 3 || mode.maxCorrections !== 0) fail('official_submission mode must be 3 runs with no corrections')
  if (JSON.stringify(mode.phases) !== JSON.stringify(['standard', 'agent2agent', 'noise'])) fail('official_submission phases are incomplete or reordered')
  return protocol
}

/**
 * Return a detached invocation plan.  It contains only public CLI options;
 * credentials and endpoint secrets are intentionally excluded.
 */
export function buildOfficialSubmissionPlan(protocol, {
  model = protocol?.models?.actor?.model,
  provider = protocol?.models?.actor?.provider,
  judgeModel = protocol?.models?.judge?.model,
  judgeProvider = protocol?.models?.judge?.provider,
} = {}) {
  assertOfficialSubmissionProtocol(protocol)
  if (!model || !provider || !judgeModel || !judgeProvider) fail('actor/judge model and provider are required')
  return {
    command: 'are-benchmark gaia2-run',
    dataset: { ...clone(protocol.datasets.submission) },
    agent: 'default',
    model,
    provider,
    judgeModel,
    judgeProvider,
    traceDumpFormat: 'both',
    hfUpload: null,
    phases: OFFICIAL_SUBMISSION_PHASES.map(clone),
  }
}

/** Ensure a generated/serialized plan still obeys the official boundary. */
export function assertOfficialSubmissionPlan(plan) {
  if (!plan || typeof plan !== 'object') fail('plan is required')
  if (plan.command !== 'are-benchmark gaia2-run') fail('unexpected command')
  if (plan.dataset?.id !== 'meta-agents-research-environments/gaia2' || plan.dataset?.split !== 'validation') fail('dataset must be the official gaia2 validation split')
  if (plan.agent !== 'default') fail('gaia2-run only supports the default agent')
  if (plan.traceDumpFormat !== 'both') fail('trace_dump_format must be both')
  if (plan.hfUpload !== null) fail('official plan must not upload')
  const phases = plan.phases
  if (!Array.isArray(phases) || JSON.stringify(phases.map((item) => ({
    phase: item.phase,
    configs: item.configs,
    a2aAppProp: item.a2aAppProp,
    noise: item.noise,
    toolAugmentation: item.toolAugmentation,
    envEvents: item.envEvents,
    numRuns: item.numRuns,
  }))) !== JSON.stringify(OFFICIAL_SUBMISSION_PHASES)) fail('phase configuration differs from ARE 1.2.0')
  return plan
}
