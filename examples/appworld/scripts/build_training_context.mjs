import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const TRAINED_HARNESS = 'appworld-trained-context'

function parseArgs(argv) {
  const options = {
    backend: 'http://127.0.0.1:3005',
    project: '.',
    maxOutputTokens: 8000,
    minPassed: 10,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) throw new Error(`unexpected argument: ${argument}`)
    const key = argument.slice(2)
    if (key === 'dry-run') options.dryRun = true
    else if (key === 'help') options.help = true
    else {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
      index += 1
      if (key === 'backend') options.backend = value
      else if (key === 'project') options.project = value
      else if (key === 'run-id') options.runId = value
      else if (key === 'output') options.output = value
      else if (key === 'max-output-tokens') options.maxOutputTokens = Number(value)
      else if (key === 'min-passed') options.minPassed = Number(value)
      else throw new Error(`unknown option: ${argument}`)
    }
  }
  return options
}

function usage() {
  return `Usage:
  node scripts/build_training_context.mjs --run-id <completed-train-run>
  node scripts/build_training_context.mjs --run-id <id> --dry-run

Only passed train Cases are used. Tool outputs, arguments, credentials, answers, and
database values are never placed in the synthesis corpus.`
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(options.timeoutMs ?? 30000),
  })
  const value = await response.json().catch(() => null)
  if (!response.ok) throw new Error(value?.error ?? `${response.status} ${response.statusText}`)
  return value
}

function projectUrl(options, route) {
  const url = new URL(route, options.backend)
  url.searchParams.set('projectPath', path.resolve(options.project))
  return url
}

async function allCases(options, runId) {
  const items = []
  let offset = 0
  while (true) {
    const url = projectUrl(options, `/api/experiments/${runId}/cases`)
    url.searchParams.set('offset', String(offset))
    url.searchParams.set('limit', '500')
    const page = await request(url)
    items.push(...page.items)
    offset += page.items.length
    if (offset >= page.total || page.items.length === 0) return items
  }
}

async function mapLimit(values, limit, mapper) {
  const result = new Array(values.length)
  let cursor = 0
  async function worker() {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      result[index] = await mapper(values[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker))
  return result
}

function apiSequence(detail) {
  const sequence = []
  for (const call of detail.toolCalls ?? []) {
    if (call.name !== 'appworld_execute' || call.status !== 'completed') continue
    const code = call.arguments?.code
    if (typeof code !== 'string') continue
    const matches = code.matchAll(/\bapis\.([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)
    for (const match of matches) sequence.push(`${match[1]}.${match[2]}`)
  }
  return sequence
}

function buildCorpus(run, details) {
  const cases = details.map((detail) => ({
    question: detail.question,
    difficulty: Number(detail.metadata?.private?.appworld?.difficulty ?? 0),
    apiSequence: apiSequence(detail),
  })).filter((item) => item.apiSequence.length > 0)
  const apiCounts = {}
  const appCounts = {}
  for (const item of cases) {
    for (const api of item.apiSequence) {
      apiCounts[api] = (apiCounts[api] ?? 0) + 1
      const app = api.split('.')[0]
      appCounts[app] = (appCounts[app] ?? 0) + 1
    }
  }
  return {
    schemaVersion: 1,
    source: {
      runId: run.id,
      datasetId: run.dataset.id,
      datasetVersion: run.dataset.version,
      datasetContentHash: run.dataset.contentHash,
      projectCommit: run.project.commitSha,
      model: run.model,
      passedCases: details.length,
      totalCases: run.progress.total,
    },
    privacy: {
      includesToolOutputs: false,
      includesToolArguments: false,
      includesAnswers: false,
      includesCredentials: false,
      includesDatabaseValues: false,
    },
    appCounts: Object.fromEntries(Object.entries(appCounts).sort((left, right) => right[1] - left[1])),
    apiCounts: Object.fromEntries(Object.entries(apiCounts).sort((left, right) => right[1] - left[1])),
    cases,
  }
}

function prompt(corpus) {
  return `You are distilling reusable AppWorld agent experience from successful train trajectories.

The input is deliberately redacted. It contains only public train questions, difficulty labels,
and API method names in execution order. It contains no outputs, arguments, answers, credentials,
tokens, database values, evaluator code, or test data.

Produce a compact Markdown operational playbook for an agent that must solve unseen AppWorld tasks
closed-book. Use only patterns supported by the corpus. Do not invent API parameters or claim an API
exists unless it appears in the corpus. Explain how to discover exact documentation at runtime.

Requirements:
- Focus on reusable planning, API discovery, authentication, pagination, date handling, mutation
  verification, cross-app workflows, error recovery, and Supervisor completion.
- Include concise app-specific routing guidance only where the corpus supports it.
- Prefer invariant procedures over task-specific facts.
- Never include case IDs, exact train answers, usernames, emails, passwords, access tokens, or literal
  database values.
- State that all exact API signatures must still be read through api_docs before use.
- Do not wrap the response in a Markdown fence.
- Keep the playbook under 5,000 words.

Redacted corpus:
${JSON.stringify(corpus)}`
}

function responseText(value) {
  return (value.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n')
    .trim()
}

function assertTrainingRevision(projectDir, run) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectDir, encoding: 'utf8' }).trim()
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: projectDir, encoding: 'utf8' }).trim()
  if (head !== run.project.commitSha) {
    throw new Error(`current project commit ${head} does not match train Run ${run.project.commitSha}`)
  }
  if (status) throw new Error('project must be clean before building the frozen training context')
}

async function synthesize(projectDir, corpus, maxOutputTokens) {
  const config = JSON.parse(await fs.readFile(path.join(projectDir, '.capybara', 'config.json'), 'utf8'))
  const secrets = JSON.parse(await fs.readFile(path.join(projectDir, '.capybara', 'secrets.json'), 'utf8'))
  const apiKey = secrets?.llm?.api_key
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('project LLM API key is not configured')
  if (config?.llm?.protocol !== 'responses') throw new Error('training context builder currently requires the Responses API')
  const response = await request(`${String(config.llm.base_url).replace(/\/$/, '')}/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: config.llm.model,
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt(corpus) }] }],
      max_output_tokens: maxOutputTokens,
      stream: false,
    }),
    timeoutMs: 10 * 60_000,
  })
  const content = responseText(response)
  if (!content) throw new Error('training context model returned no text')
  if (content.includes('{% endraw %}')) throw new Error('training context contains an unsafe Nunjucks raw terminator')
  if (/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(content)) {
    throw new Error('training context unexpectedly contains a token-like value')
  }
  return { content, response }
}

async function installHarness(projectDir, content, provenance, output) {
  const harnessDir = path.join(projectDir, 'harnesses', 'tool', 'appworld')
  const outputFile = path.resolve(projectDir, output ?? path.join(harnessDir, 'trained-context.j2'))
  const outputRelative = path.relative(harnessDir, outputFile)
  if (!outputRelative || outputRelative.startsWith('..') || path.isAbsolute(outputRelative)) {
    throw new Error('training context output must be inside harnesses/tool/appworld')
  }
  const provenanceFile = path.join(harnessDir, 'trained-context.json')
  const manifestFile = path.join(harnessDir, 'manifest.json')
  const wrapped = `{% raw %}\n${content.trim()}\n{% endraw %}\n`
  await fs.writeFile(outputFile, wrapped, 'utf8')
  await fs.writeFile(provenanceFile, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8')
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'))
  const definition = {
    name: TRAINED_HARNESS,
    description: 'Frozen reusable AppWorld procedures distilled from officially passed train trajectories.',
    type: 'tool',
    entry: outputRelative.replaceAll('\\', '/'),
    priority: 90,
    activation: { tools: ['appworld_execute'] },
    inputs: ['user_message'],
    requiredTools: ['appworld_execute'],
    examples: [{ request: 'Solve an unseen AppWorld task using train-derived operational experience.' }],
  }
  const index = manifest.harnesses.findIndex((item) => item.name === TRAINED_HARNESS)
  if (index >= 0) manifest.harnesses[index] = definition
  else manifest.harnesses.push(definition)
  await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { outputFile, provenanceFile, manifestFile }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }
  if (!options.runId) throw new Error('--run-id is required')
  if (!Number.isInteger(options.minPassed) || options.minPassed < 1) throw new Error('--min-passed must be a positive integer')
  const projectDir = path.resolve(options.project)
  const run = await request(projectUrl(options, `/api/experiments/${options.runId}`))
  if (run.status !== 'completed') throw new Error(`train run must be completed, got ${run.status}`)
  if (!String(run.dataset.id).startsWith('appworld-train-')) {
    throw new Error(`training context requires an appworld-train dataset, got ${run.dataset.id}`)
  }
  assertTrainingRevision(projectDir, run)
  const cases = await allCases(options, run.id)
  const passed = cases.filter((item) => item.status === 'passed' && item.passed === true)
  if (passed.length < options.minPassed) {
    throw new Error(`train run requires at least ${options.minPassed} passed Cases, got ${passed.length}`)
  }
  const details = await mapLimit(passed, 8, (item) =>
    request(projectUrl(options, `/api/experiments/${run.id}/cases/${item.id}`)))
  const corpus = buildCorpus(run, details)
  const corpusJson = JSON.stringify(corpus)
  const corpusHash = crypto.createHash('sha256').update(corpusJson).digest('hex')
  const corpusFile = path.join(projectDir, 'experiments', 'outputs', `training-corpus-${run.id}.json`)
  await fs.mkdir(path.dirname(corpusFile), { recursive: true })
  await fs.writeFile(corpusFile, `${JSON.stringify(corpus, null, 2)}\n`, 'utf8')
  if (options.dryRun) {
    console.log(JSON.stringify({ runId: run.id, passed: passed.length, corpusHash, corpusFile }, null, 2))
    return
  }
  const { content, response } = await synthesize(projectDir, corpus, options.maxOutputTokens)
  const contentHash = crypto.createHash('sha256').update(content).digest('hex')
  const provenance = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: corpus.source,
    privacy: corpus.privacy,
    corpusHash,
    contentHash,
    synthesisModel: response.model ?? run.model.model,
    usage: response.usage ?? {},
  }
  const installed = await installHarness(projectDir, content, provenance, options.output)
  console.log(JSON.stringify({ runId: run.id, passed: passed.length, corpusHash, contentHash, ...installed }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
