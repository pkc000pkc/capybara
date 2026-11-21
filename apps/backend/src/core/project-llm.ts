import type { ProjectSettings } from '#core/project-resources'
import {
  createFailoverLlmService,
  createLlmService,
  type LlmConfig,
  type LlmService,
} from '#util/llm'
import { isLoopbackModelHost } from '#util/llm/proxy'

type ProjectLlmSettings = ProjectSettings['llm']

function profileConfig(
  profile: ProjectLlmSettings['profiles'][number],
): Partial<LlmConfig> {
  return {
    provider: profile.provider,
    model: profile.model,
    baseUrl: profile.base_url,
    protocol: profile.protocol,
    apiKey: profile.api_key ?? (isLoopbackModelHost(new URL(profile.base_url).hostname) ? '' : undefined),
    maxRetries: profile.max_retries,
    ...(profile.chat_template_tokenizer ? { chatTemplateTokenizer: {
      directory: profile.chat_template_tokenizer.directory,
      contextWindowTokens: profile.chat_template_tokenizer.context_window_tokens,
    } } : {}),
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
