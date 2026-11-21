import fs from 'node:fs'
import path from 'node:path'

export const fixtureChatTemplate = '{% for message in messages %}{{ message.content }} {% endfor %}{% if add_generation_prompt %}G{% endif %}'

export function writeChatTokenizerFixture(directory: string): string {
  fs.mkdirSync(directory)
  fs.writeFileSync(path.join(directory, 'tokenizer.json'), JSON.stringify({
    added_tokens: [], normalizer: null, pre_tokenizer: { type: 'WhitespaceSplit' },
    post_processor: null, decoder: null, model: {
      type: 'BPE', vocab: { '?': 0, 中: 1, G: 2 }, merges: [], unk_token: '?',
    },
  }))
  const templateFile = path.join(directory, 'chat_template.jinja')
  fs.writeFileSync(templateFile, fixtureChatTemplate)
  fs.writeFileSync(path.join(directory, 'tokenizer_config.json'), '{}')
  return templateFile
}
