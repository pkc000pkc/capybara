import test from 'node:test'
import assert from 'node:assert/strict'

import { loadLlmConfig } from '#util/llm/config'

test('LLM config reads the API key from the process environment', () => {
  const previous = {
    llm: process.env.LLM_API_KEY,
    api: process.env.API_KEY,
    openai: process.env.OPENAI_API_KEY,
  }
  delete process.env.LLM_API_KEY
  delete process.env.API_KEY
  process.env.OPENAI_API_KEY = 'environment-secret-key'
  try {
    const config = loadLlmConfig({ provider: 'openai', model: 'gpt-6-luna' })
    assert.equal(config.apiKey, 'environment-secret-key')
    assert.equal(config.model, 'gpt-6-luna')
  } finally {
    if (previous.llm === undefined) delete process.env.LLM_API_KEY
    else process.env.LLM_API_KEY = previous.llm
    if (previous.api === undefined) delete process.env.API_KEY
    else process.env.API_KEY = previous.api
    if (previous.openai === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previous.openai
  }
})
