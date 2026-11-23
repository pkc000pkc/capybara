import fs from 'node:fs/promises'
import path from 'node:path'
import { validateProjectContextLeak } from './validate_project_context_leak.mjs'

function parseArgs(argv) {
  const options = {
    backend: 'http://127.0.0.1:3005',
    project: '.',
    concurrency: 2,
    repetitions: 1,
    timeoutMs: 900000,
    pollMs: 10000,
    quotaSafetyMarginTokens: 250000,
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
      else if (key === 'project-context') options.projectContext = value
      else if (key === 'concurrency') options.concurrency = Number(value)
      else if (key === 'repetitions') options.repetitions = Number(value)
      else if (key === 'timeout-ms') options.timeoutMs = Number(value)
      else if (key === 'poll-ms') options.pollMs = Number(value)
      else if (key === 'quota-window-tokens') options.quotaWindowTokens = Number(value)
      else if (key === 'quota-safety-margin-tokens') options.quotaSafetyMarginTokens = Number(value)
      else if (key === 'sample-ids-file') options.sampleIdsFile = value
      else if (key === 'resume-from-report') options.resumeFromReport = value
      else throw new Error(`unknown option: ${argument}`)
    }
  }
  return options
}

function usage() {
  return `Usage:
  node scripts/run_experiment.mjs --dataset <id> [--name <name>] [--concurrency 1-4]
  node scripts/run_experiment.mjs --run-id <id>

  Add --quota-window-tokens <n> to stop before a provider token window is exhausted.
  Add --quota-safety-margin-tokens <n> to keep room for the active case to settle.
  Add --resume-from-report <path> to run only cases cancelled by an earlier run.

  Add --project-context <path> to validate the frozen project context against
  AppWorld training or test references before starting a new run.

The project must be committed and clean before a new experiment starts.`
}

async function sampleIdsFromOptions(options) {
  if (options.sampleIdsFile && options.resumeFromReport) {
    throw new Error('--sample-ids-file and --resume-from-report cannot be used together')
  }
  if (options.sampleIdsFile) {
    const text = await fs.readFile(path.resolve(options.project, options.sampleIdsFile), 'utf8')
    const values = text.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
    if (values.length === 0) throw new Error('--sample-ids-file must contain at least one sample id')
    return [...new Set(values)]
  }
  if (options.resumeFromReport) {
    const report = JSON.parse(await fs.readFile(path.resolve(options.project, options.resumeFromReport), 'utf8'))
    const values = (Array.isArray(report.cases) ? report.cases : [])
      .filter(item => item && ['cancelled', 'queued', 'running'].includes(item.status))
      .map(item => item.sampleId)
      .filter(value => typeof value === 'string' && value.trim())
    if (values.length === 0) throw new Error('--resume-from-report contains no cancelled or interrupted cases')
    return [...new Set(values)]
  }
  return undefined
}

function usageTotal(cases) {
  return cases.reduce((total, item) => total + (Number(item.usage?.totalTokens) || 0), 0)
}

function validateQuotaOptions(options) {
  if (options.quotaWindowTokens === undefined) return
  if (!Number.isSafeInteger(options.quotaWindowTokens) || options.quotaWindowTokens <= 0) {
    throw new Error('--quota-window-tokens must be a positive integer')
  }
  if (!Number.isSafeInteger(options.quotaSafetyMarginTokens) || options.quotaSafetyMarginTokens < 0) {
    throw new Error('--quota-safety-margin-tokens must be a non-negative integer')
  }
  if (options.quotaSafetyMarginTokens >= options.quotaWindowTokens) {
    throw new Error('--quota-safety-margin-tokens must be smaller than --quota-window-tokens')
  }
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

async function validateProjectContext(options) {
  if (!options.projectContext || !options.datasetId) return undefined
  const registry = JSON.parse(await fs.readFile(path.join(path.resolve(options.project), '.capybara', 'datasets.json'), 'utf8'))
  const dataset = registry.items?.find(item => item.id === options.datasetId)
  if (!dataset) throw new Error(`dataset ${options.datasetId} was not found in .capybara/datasets.json`)
  const datasetDir = path.resolve(options.project, dataset.path)
  const dataDir = path.join(datasetDir, 'data')
  const files = (await fs.readdir(dataDir)).filter(file => file.endsWith('.jsonl')).sort()
  if (files.length !== 1) throw new Error(`expected exactly one JSONL file in ${dataDir}`)
  const contextFile = path.resolve(options.project, options.projectContext)
  const result = validateProjectContextLeak({
    context: JSON.parse(await fs.readFile(contextFile, 'utf8')),
    dataset: path.join(dataDir, files[0]),
    tasksRoot: path.join(path.resolve(options.project), '.venv', 'appworld-root', 'data', 'tasks'),
  })
  console.log(JSON.stringify({ projectContext: contextFile, dataset: options.datasetId, leakCheck: result }, null, 2))
  if (!result.ok) throw new Error(`project context leak check failed with ${result.leaks.length} match(es)`)
  return result
}

async function report(options, run, quotaGuard) {
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
    ...(options.projectContextValidation ? { projectContextValidation: options.projectContextValidation } : {}),
    ...(quotaGuard ? { quotaGuard } : {}),
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
  validateQuotaOptions(options)
  if (!options.runId && !options.datasetId) throw new Error('--dataset or --run-id is required')
  await request(new URL('/hello', options.backend))
  let run
  if (options.runId) {
    run = await request(projectUrl(options, `/api/experiments/${options.runId}`))
  } else {
    options.projectContextValidation = await validateProjectContext(options)
    const sampleIds = await sampleIdsFromOptions(options)
    run = await request(projectUrl(options, '/api/experiments'), {
      method: 'POST',
      body: JSON.stringify({
        datasetId: options.datasetId,
        ...(options.name ? { name: options.name } : {}),
        concurrency: options.concurrency,
        repetitions: options.repetitions,
        timeoutMs: options.timeoutMs,
        keepWorkspaces: options.keepWorkspaces ?? false,
        ...(sampleIds ? { sampleIds } : {}),
      }),
      timeoutMs: 60000,
    })
    console.log(`started ${run.id}`)
  }

  let previous = ''
  let quotaStopRequested = false
  const quotaGuard = options.quotaWindowTokens === undefined ? undefined : {
    windowTokens: options.quotaWindowTokens,
    safetyMarginTokens: options.quotaSafetyMarginTokens,
    stopAtTokens: options.quotaWindowTokens - options.quotaSafetyMarginTokens,
    observedTokens: 0,
    stoppedAtTokens: undefined,
    reason: undefined,
  }
  while (['queued', 'running'].includes(run.status)) {
    const progress = `${run.status} ${run.progress.completed}/${run.progress.total}`
    if (progress !== previous) console.log(`${new Date().toISOString()} ${progress}`)
    previous = progress
    await new Promise((resolve) => setTimeout(resolve, options.pollMs))
    run = await request(projectUrl(options, `/api/experiments/${run.id}`))
    if (quotaGuard && run.status === 'running') {
      quotaGuard.observedTokens = usageTotal(await allCases(options, run.id))
      if (!quotaStopRequested && quotaGuard.observedTokens >= quotaGuard.stopAtTokens) {
        quotaStopRequested = true
        quotaGuard.stoppedAtTokens = quotaGuard.observedTokens
        quotaGuard.reason = 'provider_token_window_safety_margin_reached'
        console.log(JSON.stringify({ quotaGuard: { ...quotaGuard, action: 'cancel_run' } }))
        await request(projectUrl(options, `/api/experiments/${run.id}/cancel`), {
          method: 'POST',
          body: JSON.stringify({ reason: quotaGuard.reason }),
        })
      }
    }
  }
  await report(options, run, quotaGuard)
  if (run.status !== 'completed') process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
