import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Template } from '@huggingface/jinja'
import { Tokenizer } from '@huggingface/tokenizers'

interface ChatTokenizer {
  identity: string
  tokenizer: Tokenizer
  template: Template
  specialTokens: Record<string, string>
}

const cache = new Map<string, { files: string; implementation: ChatTokenizer }>()

function loadChatTokenizer(directory: string): ChatTokenizer {
  const folder = fs.realpathSync(directory)
  const tokenizerFile = path.join(folder, 'tokenizer.json')
  const configFile = path.join(folder, 'tokenizer_config.json')
  const templateFile = path.join(folder, 'chat_template.jinja')
  const files = [tokenizerFile, configFile, ...(fs.existsSync(templateFile) ? [templateFile] : [])]
  const version = files.map(file => {
    const stat = fs.statSync(file, { bigint: true })
    if (!stat.isFile()) throw new Error('Chat tokenizer assets must be regular files')
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
  }).join('/')
  const cached = cache.get(folder)
  if (cached?.files === version) return cached.implementation

  const [rawTokenizer, rawConfig, rawTemplate] = files.map(file => fs.readFileSync(file, 'utf8'))
  const config = JSON.parse(rawConfig!)
  const template = rawTemplate ?? config.chat_template
  if (typeof template !== 'string' || !template.trim()) throw new Error('Chat tokenizer needs a single default Hugging Face chat template')
  const entries = ['bos_token', 'eos_token', 'pad_token', 'unk_token'].flatMap(key => {
    const raw = config[key]
    const content = typeof raw === 'string' ? raw : raw?.content
    return typeof content === 'string' ? [[key, content]] : []
  })
  const implementation = {
    identity: createHash('sha256').update(JSON.stringify([rawTokenizer, rawConfig, template])).digest('hex'),
    tokenizer: new Tokenizer(JSON.parse(rawTokenizer!), config),
    template: new Template(template),
    specialTokens: Object.fromEntries(entries),
  }
  cache.delete(folder)
  if (cache.size >= 4) cache.delete(cache.keys().next().value!)
  cache.set(folder, { files: version, implementation })
  return implementation
}

/** Matches a text-only server that renders these wire messages with the same Hugging Face assets. */
export function countTextChatTokens(directory: string, serializedBody: string): { inputTokens: number; identity: string } {
  const body = JSON.parse(serializedBody)
  if ((body.tools != null && (!Array.isArray(body.tools) || body.tools.length > 0))
    || !Array.isArray(body.messages) || !body.messages.length || body.messages.some((message: unknown) => {
      if (!message || typeof message !== 'object') return true
      const item = message as Record<string, unknown>
      return !['system', 'user', 'assistant'].includes(String(item.role)) || typeof item.content !== 'string'
        || Object.keys(item).some(key => key !== 'role' && key !== 'content')
    })) throw new Error('Configured chat template tokenizer requires text messages without tools or custom message fields')

  const { identity, tokenizer, template, specialTokens } = loadChatTokenizer(directory)
  const prompt = template.render({ ...specialTokens, messages: body.messages, add_generation_prompt: true, tools: undefined })
  return { inputTokens: tokenizer.encode(prompt, { add_special_tokens: false }).ids.length, identity }
}
