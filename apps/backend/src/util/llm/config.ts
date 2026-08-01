import type { LlmConfig, LlmProtocol, LlmProviderName } from '#util/llm/types'

const PROVIDER_DEFAULTS: Record<LlmProviderName, Pick<LlmConfig, 'baseUrl' | 'model'>> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  custom: { baseUrl: '', model: 'custom-model' },
}

function providerFromEnv(value: string | undefined): LlmProviderName {
  if (!value) return 'ollama'

  switch (value?.trim().toLowerCase()) {
    case 'openai':
    case 'ollama':
    case 'deepseek':
      return value.trim().toLowerCase() as LlmProviderName
    default:
      return 'custom'
  }
}

function optionalEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim()
    if (value) return value
  }
  return undefined
}

function protocolFromEnv(value: string | undefined): LlmProtocol {
  if (!value) {
    return 'chat-completions'
  }
  const protocol = value.trim().toLowerCase()
  if (protocol === 'responses' || protocol === 'chat-completions') return protocol
  throw new Error(`Unsupported LLM protocol: ${value}`)
}

export function loadLlmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  const provider = overrides.provider ?? providerFromEnv(optionalEnv('LLM_PROVIDER', 'PROVIDER'))
  const defaults = PROVIDER_DEFAULTS[provider]

  return {
    provider,
    protocol: overrides.protocol ?? protocolFromEnv(optionalEnv('LLM_PROTOCOL')),
    model: overrides.model ?? optionalEnv('LLM_MODEL', 'MODEL') ?? defaults.model,
    baseUrl: overrides.baseUrl ?? optionalEnv('LLM_BASE_URL', 'BASE_URL') ?? defaults.baseUrl,
    apiKey: overrides.apiKey ?? optionalEnv('LLM_API_KEY', 'API_KEY'),
    timeoutMs:
      overrides.timeoutMs ??
      Number.parseInt(optionalEnv('LLM_TIMEOUT_MS') ?? '60000', 10),
    maxRetries:
      overrides.maxRetries ??
      Number.parseInt(optionalEnv('LLM_MAX_RETRIES') ?? '3', 10),
    headers: overrides.headers,
  }
}
