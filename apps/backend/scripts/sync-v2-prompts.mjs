import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const backend = fileURLToPath(new URL('../', import.meta.url))
const source = path.resolve(backend, '../../docs/prompts/v2')
const target = path.join(backend, 'templates/system-prompts/v2')
fs.mkdirSync(target, { recursive: true })
for (const name of ['constitution', 'runtime', 'context-organizer', 'reflection', 'dream', 'child-agent']) {
  const content = fs.readFileSync(path.join(source, `${name}.md`), 'utf8').replace(/\r\n/g, '\n')
  if (!content.includes('提示词版本：')) throw new Error(`Missing prompt version: ${name}`)
  fs.writeFileSync(path.join(target, `${name}.md`), content)
}
