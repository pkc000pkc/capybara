import { loadLlmConfig } from '#util/llm/config'
import { OpenAiCompatibleProvider } from '#util/llm/openai-compatible'
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmConfig,
  LlmProvider,
  LlmTextDeltaHandler,
} from '#util/llm/types'

export type {
  LlmChatRequest,
  LlmChatResponse,
  LlmConfig,
  LlmMessage,
  LlmProtocol,
  LlmProviderName,
  LlmRole,
  LlmToolCall,
  LlmToolDefinition,
  LlmTextDeltaHandler,
  LlmUsage,
} from '#util/llm/types'

export class LlmService {
  constructor(private readonly provider: LlmProvider) {}

  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    if (request.messages.length === 0) {
      throw new Error('LLM chat requires at least one message')
    }
    return this.provider.chat(request)
  }

  async stream(
    request: LlmChatRequest,
    onTextDelta: LlmTextDeltaHandler,
  ): Promise<LlmChatResponse> {
    if (request.messages.length === 0) {
      throw new Error('LLM chat requires at least one message')
    }
    return this.provider.stream(request, onTextDelta)
  }

  async prompt(prompt: string): Promise<LlmChatResponse> {
    return this.chat({ messages: [{ role: 'user', content: prompt }] })
  }

  getConfig(): Readonly<LlmConfig> {
    return this.provider.getConfig()
  }
}

export function createLlmService(overrides: Partial<LlmConfig> = {}): LlmService {
  const config = loadLlmConfig(overrides)
  return new LlmService(new OpenAiCompatibleProvider(config))
}
