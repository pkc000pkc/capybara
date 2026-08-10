import fs from 'node:fs/promises'
import path from 'node:path'

function parseArgs(argv) {
  const options = { backend: 'http://127.0.0.1:3005', project: '.' }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = argv[index + 1]
    if (!argument.startsWith('--') || !value || value.startsWith('--')) throw new Error(`invalid argument: ${argument}`)
    index += 1
    const key = argument.slice(2)
    if (key === 'backend') options.backend = value
    else if (key === 'project') options.project = value
    else if (key === 'runs') options.runIds = value.split(',').map((item) => item.trim()).filter(Boolean)
    else if (key === 'output') options.output = value
    else throw new Error(`unknown option: ${argument}`)
  }
  return options
}

async function request(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
  const value = await response.json().catch(() => null)
  if (!response.ok) throw new Error(value?.error ?? `${response.status} ${response.statusText}`)
  return value
}

function runUrl(options, runId) {
  const url = new URL(`/api/experiments/${runId}`, options.backend)
  url.searchParams.set('projectPath', path.resolve(options.project))
  return url
}

function sum(runs, selector) {
  return runs.reduce((total, run) => total + Number(selector(run) ?? 0), 0)
}

function weighted(runs, value, weight) {
  const totalWeight = sum(runs, weight)
  return totalWeight ? sum(runs, (run) => Number(value(run) ?? 0) * Number(weight(run) ?? 0)) / totalWeight : 0
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.runIds?.length) throw new Error('--runs requires comma-separated experiment Run IDs')
  const runs = await Promise.all(options.runIds.map((id) => request(runUrl(options, id))))
  if (runs.some((run) => run.status !== 'completed')) throw new Error('all benchmark runs must be completed')
  const modelKeys = new Set(runs.map((run) => `${run.model.provider}:${run.model.protocol}:${run.model.model}:${run.project.commitSha}`))
  if (modelKeys.size !== 1) throw new Error('benchmark runs do not share one model and project commit')
  const difficulty = {}
  for (const run of runs) {
    for (const [key, metrics] of Object.entries(run.metrics.custom?.byDifficulty ?? {})) {
      const target = difficulty[key] ?? { weightedTgc: 0, cases: 0 }
      target.weightedTgc += Number(metrics.taskGoalCompletion ?? 0) * Number(metrics.cases ?? 0)
      target.cases += Number(metrics.cases ?? 0)
      difficulty[key] = target
    }
  }
  const report = {
    generatedAt: new Date().toISOString(),
    benchmark: 'appworld',
    model: runs[0].model,
    project: runs[0].project,
    runs: runs.map((run) => ({
      id: run.id,
      name: run.name,
      dataset: run.dataset,
      metrics: run.metrics,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    })),
    overall: {
      taskGoalCompletion: weighted(runs, (run) => run.metrics.custom?.tgc, (run) => run.metrics.custom?.numTasks),
      scenarioGoalCompletion: weighted(runs, (run) => run.metrics.custom?.sgc, (run) => run.metrics.custom?.numScenarios),
      tasks: sum(runs, (run) => run.metrics.custom?.numTasks),
      scenarios: sum(runs, (run) => run.metrics.custom?.numScenarios),
      passed: sum(runs, (run) => run.metrics.passed),
      failed: sum(runs, (run) => run.metrics.failed),
      errors: sum(runs, (run) => run.metrics.errors),
      inputTokens: sum(runs, (run) => run.metrics.agentUsage?.inputTokens),
      outputTokens: sum(runs, (run) => run.metrics.agentUsage?.outputTokens),
      totalTokens: sum(runs, (run) => run.metrics.agentUsage?.totalTokens),
      toolPrecision: weighted(runs, (run) => run.metrics.toolPrecision, (run) => run.metrics.custom?.numTasks),
      toolRecall: weighted(runs, (run) => run.metrics.toolRecall, (run) => run.metrics.custom?.numTasks),
      byDifficulty: Object.fromEntries(Object.entries(difficulty).map(([key, value]) => [key, {
        taskGoalCompletion: value.cases ? value.weightedTgc / value.cases : 0,
        cases: value.cases,
      }])),
    },
  }
  const output = path.resolve(options.output ?? 'experiments/outputs/appworld-benchmark-summary.json')
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ...report.overall, report: output }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
