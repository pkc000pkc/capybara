import type { ProjectSettings } from '#core/project-resources'
import {
  createFailoverLlmService,
  createLlmService,
  type LlmConfig,
  type LlmService,
} from '#util/llm'

type ProjectLlmSettings = ProjectSettings['llm']

function profileConfig(
  profile: ProjectLlmSettings['profiles'][number],
): Partial<LlmConfig> {
  return {
    provider: profile.provider,
    model: profile.model,
    baseUrl: profile.base_url,
    protocol: profile.protocol,
    apiKey: profile.api_key,
    maxRetries: profile.max_retries,
  }
}

export function createProjectLlmService(settings: ProjectLlmSettings): LlmService {
  const active = settings.profiles.find((profile) => profile.id === settings.active_profile)
    ?? settings.profiles[0]
  if (!active) throw new Error('project LLM configuration requires at least one profile')

  const orderedProfiles = [
    active,
    ...settings.profiles.filter((profile) => profile.id !== active.id),
  ]
  if (!settings.failover.enabled || orderedProfiles.length === 1) {
    return createLlmService(profileConfig(active))
  }

  return createFailoverLlmService(
    orderedProfiles.map((profile) => ({
      id: profile.id,
      config: profileConfig(profile),
    })),
    {
      retriesPerCandidate: settings.failover.retries_per_profile,
      initialDelayMs: settings.failover.initial_delay_ms,
      maxDelayMs: settings.failover.max_delay_ms,
    },
  )
}
