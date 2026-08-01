import 'dotenv/config'

import { createLlmService } from '#util/llm'

async function main(): Promise<void> {
  const llm = createLlmService()
  let chunks = 0
  const response = await llm.stream({
    messages: [
      {
        role: 'user',
        content: 'Reply with exactly: LLM demo works',
      },
    ],
    maxTokens: 64,
  }, (delta) => {
    chunks += 1
    process.stdout.write(delta)
  })

  process.stdout.write('\n')
  console.log({
    provider: response.provider,
    protocol: llm.getConfig().protocol,
    model: response.model,
    streamChunks: chunks,
    usage: response.usage,
  })
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
