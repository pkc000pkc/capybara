import fs from 'node:fs/promises'
import path from 'node:path'

function parseArgs(argv) {
  const options = {
    backend: 'http://127.0.0.1:3005',
    project: '.',
    concurrency: 2,
    repetitions: 1,
    timeoutMs: 900000,
    pollMs: 10000,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) throw new Error(`unexpected argument: ${argument}`)
    const key = argument.slice(2)
    if (key === 'help') options.help = true
    else if (key === 'keep-workspaces') options.keepWorkspaces = true
    else {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
      index += 1
      if (key === 'backend') options.backend = value
      else if (key === 'project') options.project = value
      else if (key === 'dataset') options.datasetId = value
      else if (key === 'name') options.name = value
      else if (key === 'run-id') options.runId = value
      else if (key === 'output') options.output = value
      else if (key === 'concurrency') options.concurrency = Number(value)
      else if (key === 'repetitions') options.repetitions = Number(value)
      else if (key === 'timeout-ms') options.timeoutMs = Number(value)
      else if (key === 'poll-ms') options.pollMs = Number(value)
      else throw new Error(`unknown option: ${argument}`)
    }
  }
  return options
}

function usage() {
  return `Usage:
  node scripts/run_experiment.mjs --dataset <id> [--name <name>] [--concurrency 1-4]
  node scripts/run_experiment.mjs --run-id <id>

The project must be committed and clean before a new experiment starts.`
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(options.timeoutMs ?? 30000),
  })
  const value = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = value?.error ?? value?.message ?? `${response.status} ${response.statusText}`
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
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

async function report(options, run) {
  const cases = await allCases(options, run.id)
  const tools = await request(projectUrl(options, `/api/experiments/${run.id}/tools`))
  const statusCounts = Object.fromEntries(
    [...new Set(cases.map((item) => item.status))]
      .sort()
      .map((status) => [status, cases.filter((item) => item.status === status).length]),
  )
  const value = {
    generatedAt: new Date().toISOString(),
    run,
    statusCounts,
    cases,
    tools: tools.items,
  }
  const output = path.resolve(options.output ?? `experiments/outputs/run-${run.id}.json`)
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({
    runId: run.id,
    status: run.status,
    dataset: run.dataset,
    project: run.project,
    model: run.model,
    progress: run.progress,
    metrics: run.metrics,
    statusCounts,
    report: output,
  }, null, 2))
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }
  if (!options.runId && !options.datasetId) throw new Error('--dataset or --run-id is required')
  await request(new URL('/hello', options.backend))
  let run
  if (options.runId) {
    run = await request(projectUrl(options, `/api/experiments/${options.runId}`))
  } else {
    run = await request(projectUrl(options, '/api/experiments'), {
      method: 'POST',
      body: JSON.stringify({
        datasetId: options.datasetId,
        ...(options.name ? { name: options.name } : {}),
        concurrency: options.concurrency,
        repetitions: options.repetitions,
        timeoutMs: options.timeoutMs,
        keepWorkspaces: options.keepWorkspaces ?? false,
      }),
      timeoutMs: 60000,
    })
    console.log(`started ${run.id}`)
  }

  let previous = ''
  while (['queued', 'running'].includes(run.status)) {
    const progress = `${run.status} ${run.progress.completed}/${run.progress.total}`
    if (progress !== previous) console.log(`${new Date().toISOString()} ${progress}`)
    previous = progress
    await new Promise((resolve) => setTimeout(resolve, options.pollMs))
    run = await request(projectUrl(options, `/api/experiments/${run.id}`))
  }
  await report(options, run)
  if (run.status !== 'completed') process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
