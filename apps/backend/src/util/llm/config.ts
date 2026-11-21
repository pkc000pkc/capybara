import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

function systemCredential(): string | undefined {
  const file = path.join(os.homedir(), '.capybara', 'credentials.json')
  if (!fs.existsSync(file)) return undefined
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const llm = (value as { llm?: unknown }).llm
    if (!llm || typeof llm !== 'object' || Array.isArray(llm)) return undefined
    const apiKey = (llm as { apiKey?: unknown }).apiKey
    return typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : undefined
  } catch {
    return undefined
  }
}

function systemLlmConfig(): Record<string, string> {
  const file = path.join(os.homedir(), '.capybara', 'config.json')
  if (!fs.existsSync(file)) return {}
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const llm = (value as { llm?: unknown }).llm
    if (!llm || typeof llm !== 'object' || Array.isArray(llm)) return {}
    return Object.fromEntries(
      Object.entries(llm as Record<string, unknown>)
        .filter(([, item]) => typeof item === 'string' && item.trim())
        .map(([key, item]) => [key, String(item).trim()]),
    )
  } catch {
    return {}
  }
}

function protocolFromEnv(value: string | undefined): LlmProtocol {
  if (!value) {
    return 'chat-completions'
  }
  const protocol = value.trim().toLowerCase()
  if (
    protocol === 'responses'
    || protocol === 'codex-like'
    || protocol === 'chat-completions'
  ) return protocol
  throw new Error(`Unsupported LLM protocol: ${value}`)
}

export function loadLlmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  const system = systemLlmConfig()
  const provider = overrides.provider ?? providerFromEnv(optionalEnv('LLM_PROVIDER', 'PROVIDER') ?? system.provider)
  const defaults = PROVIDER_DEFAULTS[provider]

  return {
    provider,
    protocol: overrides.protocol ?? protocolFromEnv(optionalEnv('LLM_PROTOCOL') ?? system.protocol),
    model: overrides.model ?? optionalEnv('LLM_MODEL', 'MODEL') ?? system.model ?? defaults.model,
    baseUrl: overrides.baseUrl ?? optionalEnv('LLM_BASE_URL', 'BASE_URL') ?? system.baseUrl ?? defaults.baseUrl,
    apiKey:
      overrides.apiKey
      ?? optionalEnv('LLM_API_KEY', 'API_KEY', 'OPENAI_API_KEY')
      ?? systemCredential(),
    timeoutMs:
      overrides.timeoutMs ??
      Number.parseInt(optionalEnv('LLM_TIMEOUT_MS') ?? '60000', 10),
    maxRetries:
      overrides.maxRetries ??
      Number.parseInt(optionalEnv('LLM_MAX_RETRIES') ?? '3', 10),
    headers: overrides.headers,
    ...(overrides.chatTemplateTokenizer ? { chatTemplateTokenizer: overrides.chatTemplateTokenizer } : {}),
  }
}
