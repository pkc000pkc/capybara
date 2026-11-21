import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { exportContextTraining } from '../dist/core/context-training-export.js'
import { initializeProjectDirectory } from '../dist/core/project-initializer.js'
import { ProjectResources } from '../dist/core/project-resources.js'
import { RuntimeLoop } from '../dist/core/runtime-loop.js'
import { SessionStore } from '../dist/core/session-store.js'

const [output, ...groupIds] = process.argv.slice(2)
if (!output) throw new Error('Usage: node demo/context-span-contrast-corpus.mjs <new-output-directory> [source-group ...]')
const root = path.resolve(output)
const cases = JSON.parse(fs.readFileSync(new URL('../test/fixtures/context-span-contrast-cases.json', import.meta.url), 'utf8'))
const profile = { id: 'contrast-fixture', provider: 'custom', protocol: 'chat-completions', model: 'contrast-fixture', baseUrl: 'http://127.0.0.1:1/v1' }
const getConfig = () => ({ ...profile, maxRetries: 0, timeoutMs: 1000 })
const reply = fields => ({ provider: profile.provider, model: profile.model, raw: {}, text: '', ...fields })

async function capture(projectDir, store, query, files, topic) {
  const title = `资料核对 ${topic + 1}`
  const { id } = store.create(title)
  const expected = new Map(files.map(([file, sourceTopic, text]) => [file,
    { text, choice: sourceTopic === null ? 'R' : sourceTopic === topic ? 'K' : 'A' }]))
  const calls = [[{ name: 'load_resources', arguments: { ids: ['project-files:read_file'] } }], files.map(([file]) =>
    ({ name: 'read_file', arguments: { file_name: file } }))]
  let step = 0
  const llm = { getConfig, async chat() {
    const actions = calls[step++]
    return actions ? reply({ toolCalls: actions.map((action, i) => ({ ...action, id: `contrast-${step}-${i + 1}` })) })
      : reply({ text: '{"status":"completed","content":"已读取资料。"}' })
  } }
  const expectedChoices = packet => packet.sources.map(({ file, text }) => {
    const material = expected.get(file)
    assert.ok(material && material.text === text, `Unbound text for ${file}`)
    return material.choice
  })
  const organizer = { getConfig, async chat(request) {
    const packet = JSON.parse(request.messages.at(-1).content)
    const payload = packet.organizationVersion === 4
      ? { batch: packet.batch, choices: expectedChoices(packet), heading: title }
      : { batch: packet.batch, observations: [], edits: [], archives: [], fold: false, uncertainties: [] }
    return reply({ text: JSON.stringify(payload) })
  } }
  const loop = new RuntimeLoop({ projectDir, llm, contextOrganization: { minGroups: 1, llm: organizer }, stepDelayMs: 0, streamDelayMs: 0 })
  let timer, unsubscribe
  try {
    const finished = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Capture timed out for ${query}`)), 45_000)
      unsubscribe = loop.onEvent(event => {
        if (event.type !== 'run.state.changed') return
        if (event.payload.status === 'completed') resolve()
        if (event.payload.status === 'failed') reject(new Error(event.payload.failure?.message ?? 'Capture failed'))
      })
    })
    const command = { version: 1, kind: 'command', id: `send-${id}`, sessionId: id, timestamp: new Date().toISOString(),
      type: 'chat.message.send', payload: { autoStart: true, clientMessageId: `user-${id}`, content: [{ type: 'text', text: query }] } }
    loop.validate(command)
    loop.execute(command, 1)
    await finished
    store.save(id, loop.exportState(), step)
  } finally {
    clearTimeout(timer)
    unsubscribe?.()
    await loop.close()
  }
  const exportFile = path.join(root, `${id}.jsonl`)
  exportContextTraining({ projectDir, sessionIds: [id], output: exportFile })
  const records = fs.readFileSync(exportFile, 'utf8').trimEnd().split('\n').flatMap(line => {
    const row = JSON.parse(line)
    const packet = JSON.parse(row.messages.at(-2).content)
    if (packet.organizationVersion !== 4) return []
    assert.equal(packet.task.latestUser, query)
    const proposal = JSON.parse(row.messages.at(-1).content)
    assert.equal(proposal.batch, packet.batch)
    assert.deepEqual(proposal.choices, expectedChoices(packet))
    return [{ line, row, primary: !packet.task.archiveReview && packet.sources.length === files.length }]
  })
  assert.ok(records.some(record => record.primary), `No complete file assessment for ${query}`)
  return records
}

const allJobs = Object.entries(cases).flatMap(([split, groups]) => groups.map(group => ({ split, ...group })))
const knownGroups = new Set(allJobs.map(job => job.id))
assert.equal(knownGroups.size, allJobs.length)
assert.ok(groupIds.every(id => knownGroups.has(id)), 'Unknown source group')
const jobs = groupIds.length ? allJobs.filter(job => groupIds.includes(job.id)) : allJobs
for (const { id, split, tasks, files } of jobs) {
  assert.match(id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  assert.ok(['train', 'validation', 'test'].includes(split))
  assert.equal(tasks.length, 2)
  assert.notEqual(tasks[0], tasks[1])
  assert.equal(new Set(files.map(([file]) => file)).size, files.length)
  for (const [file, topic, text] of files) {
    assert.match(file, /^[a-z0-9]+(?:-[a-z0-9]+)*\.txt$/)
    assert.ok([0, 1, null].includes(topic) && text.trim(), file)
  }
}
fs.mkdirSync(root)
const samples = [], reviews = []
for (const { id, split, tasks, files } of jobs) {
  const projectDir = path.join(root, id)
  fs.mkdirSync(projectDir)
  initializeProjectDirectory(projectDir)
  const settings = new ProjectResources(projectDir)
  try {
    const llm = settings.readSettings().llm
    settings.saveSettings({ context_organization_version: 4, context_file_disposition_profile: profile.id, llm: { ...llm,
      profiles: [...llm.profiles, { id: profile.id, provider: profile.provider, protocol: profile.protocol, model: profile.model,
        base_url: profile.baseUrl, max_retries: 0 }] } })
  } finally { settings.close() }
  for (const [file, , text] of files) fs.writeFileSync(path.join(projectDir, file), text)
  const store = new SessionStore(projectDir)
  try {
    for (const [topic, query] of tasks.entries()) {
      for (const { line, row } of await capture(projectDir, store, query, files, topic)) {
        samples.push(line)
        reviews.push(JSON.stringify({ sampleId: row.sampleId, rowSha256: createHash('sha256').update(line).digest('hex'),
          decision: 'accept', split, sourceTaskGroup: id, reviewId: 'paired-task-contrast',
          reason: '同一批原件的两个业务任务按原句标注保留、无关或归属待核对，每对场景进入同一个数据切分。' }))
      }
    }
  } finally { store.close() }
}
fs.writeFileSync(path.join(root, 'samples.jsonl'), `${samples.join('\n')}\n`)
fs.writeFileSync(path.join(root, 'reviews.jsonl'), `${reviews.join('\n')}\n`)
console.log(JSON.stringify({ root, samples: samples.length, groups: jobs.length }))
