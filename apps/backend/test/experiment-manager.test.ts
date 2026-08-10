import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

import { buildApp } from '#app'
import { DatasetStore } from '#core/datasets/dataset-store'
import { ExperimentAdapterRunner } from '#core/experiments/experiment-adapter'
import type { ExperimentRunDetail } from '#core/experiments/types'
import type { RuntimeLlm } from '#core/runtime-loop'
import type { LlmChatRequest, LlmChatResponse, LlmToolCall } from '#util/llm'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function temporaryExperimentProject(): string {
  const source = path.resolve(process.env.CAPYBARA_TEST_PROJECT_DIR ?? 'test-project')
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-experiment-'))
  fs.cpSync(source, projectDir, {
    recursive: true,
    filter: (file) => {
      const relative = path.relative(source, file).replaceAll('\\', '/')
      return relative !== 'datasets'
        && !relative.startsWith('datasets/')
        && relative !== '.capybara/datasets.json'
        && relative !== '.capybara/secrets.json'
        && !relative.startsWith('.capybara/sessions.sqlite')
        && !relative.startsWith('.capybara/experiments.sqlite')
        && !relative.startsWith('.capybara/worktrees/')
    },
  })
  return projectDir
}

function response(text: string, toolCalls?: LlmToolCall[]): LlmChatResponse {
  return {
    provider: 'custom',
    model: 'experiment-test-model',
    text,
    ...(toolCalls ? { toolCalls, finishReason: 'tool_calls' } : { finishReason: 'stop' }),
    usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, cacheReadTokens: 2 },
    raw: {},
  }
}

function experimentLlm(requests: LlmChatRequest[]): RuntimeLlm {
  return {
    async chat(request) {
      requests.push(structuredClone({ ...request, signal: undefined }))
      if (request.messages.length === 1 && request.messages[0]?.content.includes('SCORER_REQUEST')) {
        return response(JSON.stringify({
          score: 0.9,
          passed: true,
          rationale: 'The answer is grounded in the file content and all expected tools were called.',
        }))
      }
      if (request.messages.some((message) => message.toolCallId === 'case-read-file')) {
        return response(JSON.stringify({
          status: 'completed',
          content: 'The project template defines the Capybara runtime prompt and resource-loading context.',
        }))
      }
      if (request.messages.some((message) => message.toolCallId === 'case-load-reader')) {
        assert.ok(request.tools?.some((tool) => tool.name === 'read_file'))
        return response('', [{
          id: 'case-read-file',
          name: 'read_file',
          arguments: { file_name: 'main.j2', start_line: 1, end_line: 8, include_line_numbers: false },
        }])
      }
      if (request.messages.some((message) => message.toolCallId === 'case-search-reader')) {
        return response('', [{
          id: 'case-load-reader',
          name: 'load_resources',
          arguments: { ids: ['project-files:read_file'] },
        }])
      }
      return response('', [{
        id: 'case-search-reader',
        name: 'search_resources',
        arguments: { query: 'read a project text file', kinds: ['tool'] },
      }])
    },
    getConfig: () => ({
      provider: 'custom',
      protocol: 'responses',
      model: 'experiment-test-model',
      baseUrl: 'http://127.0.0.1/unused',
      timeoutMs: 1_000,
      maxRetries: 0,
    }),
  }
}

function commitProject(projectDir: string, message: string): void {
  if (!fs.existsSync(path.join(projectDir, '.git'))) {
    git(projectDir, 'init', '--initial-branch=main')
    git(projectDir, 'config', 'user.name', 'Capybara Test')
    git(projectDir, 'config', 'user.email', 'capybara@example.invalid')
  }
  git(projectDir, 'add', '.')
  git(projectDir, 'commit', '-m', message)
}

function writeExperimentAdapter(projectDir: string): void {
  const manifestFile = path.join(projectDir, '.capybara', 'experiment-adapter.json')
  const entryFile = path.join(projectDir, 'experiments', 'deterministic-adapter.mjs')
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
  fs.mkdirSync(path.dirname(entryFile), { recursive: true })
  fs.writeFileSync(manifestFile, `${JSON.stringify({
    version: 1,
    runner: { type: 'stdio', entry: 'experiments/deterministic-adapter.mjs' },
    timeout_ms: 10_000,
    phases: ['prepare', 'evaluate', 'cleanup', 'aggregate'],
  }, null, 2)}\n`, 'utf8')
  fs.writeFileSync(entryFile, `import fs from 'node:fs'
import path from 'node:path'

let raw = ''
for await (const chunk of process.stdin) raw += chunk
const request = JSON.parse(raw)
const projectDir = process.env.CAPYBARA_PROJECT_DIR
fs.mkdirSync(path.join(projectDir, '.capybara'), { recursive: true })
fs.appendFileSync(path.join(projectDir, '.capybara', 'adapter-events.jsonl'), JSON.stringify({ phase: request.phase }) + '\\n')
let result
if (request.phase === 'prepare') {
  result = { endpoint: 'memory://case', taskId: request.payload.case.metadata.public.task_id }
} else if (request.phase === 'evaluate') {
  result = {
    score: 0.75,
    passed: true,
    rationale: 'Project evaluator accepted the persisted environment state.',
    metrics: { passed_tests: 3, failed_tests: 1, difficulty: 2 },
    details: { task_id: request.payload.case.metadata.public.task_id },
    reference: {
      kind: 'text',
      status: 'available',
      source: { type: 'official_evaluator', benchmark: 'fixture', taskId: request.payload.case.metadata.public.task_id },
      displayValue: 'Official fixture answer',
      value: 'Official fixture answer',
      requirements: [{ ordinal: 0, status: 'passed', description: 'fixture requirement' }],
      actualStateChanges: [],
      failureTraces: [],
      resolvedAt: request.startedAt,
    },
  }
} else if (request.phase === 'aggregate') {
  result = {
    task_goal_completion: 100,
    scenario_goal_completion: 100,
    evaluated_cases: request.payload.cases.length,
  }
} else {
  result = { cleaned: true }
}

process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }))
`, 'utf8')
}

test('experiment adapter revision includes declared helper files and reaches the adapter process', async (context) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-adapter-revision-'))
  context.after(() => fs.rmSync(projectDir, { recursive: true, force: true }))
  const manifestFile = path.join(projectDir, '.capybara', 'experiment-adapter.json')
  const entryFile = path.join(projectDir, 'experiments', 'adapter.mjs')
  const helperFile = path.join(projectDir, 'scripts', 'helper.txt')
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
  fs.mkdirSync(path.dirname(entryFile), { recursive: true })
  fs.mkdirSync(path.dirname(helperFile), { recursive: true })
  fs.writeFileSync(manifestFile, JSON.stringify({
    version: 1,
    runner: { type: 'stdio', entry: 'experiments/adapter.mjs', files: ['scripts/helper.txt'] },
    phases: ['evaluate'],
  }))
  fs.writeFileSync(entryFile, [
    "let input = '';",
    'for await (const chunk of process.stdin) input += chunk;',
    'const request = JSON.parse(input);',
    "const revision = process.env.CAPYBARA_EXPERIMENT_ADAPTER_REVISION;",
    "process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { score: 1, passed: true, rationale: 'passed', metrics: {}, reference: { kind: 'text', status: 'available', source: { type: 'official_evaluator', resolverRevision: revision }, displayValue: 'done', value: 'done', requirements: [], actualStateChanges: [], failureTraces: [], resolvedAt: request.startedAt } } }));",
  ].join('\n'))
  fs.writeFileSync(helperFile, 'first')
  const first = new ExperimentAdapterRunner(projectDir)
  const evaluation = await first.evaluate({})
  assert.equal(evaluation.reference?.source.resolverRevision, first.revision)
  fs.writeFileSync(helperFile, 'second')
  const second = new ExperimentAdapterRunner(projectDir)
  assert.notEqual(second.revision, first.revision)
})

async function waitForRun(
  app: Awaited<ReturnType<typeof buildApp>>,
  projectQuery: string,
  runId: string,
): Promise<ExperimentRunDetail> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/api/experiments/${runId}?${projectQuery}` })
    assert.equal(response.statusCode, 200)
    const run = response.json() as ExperimentRunDetail
    if (['completed', 'failed', 'cancelled'].includes(run.status)) return run
    await delay(20)
  }
  throw new Error(`experiment did not finish: ${runId}`)
}

test('experiment API runs dataset cases through tools and scoring, then persists analysis data', async (context) => {
  const projectDir = temporaryExperimentProject()
  let app: Awaited<ReturnType<typeof buildApp>> | undefined
  context.after(async () => {
    await app?.close()
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
  const datasets = new DatasetStore(projectDir)
  const dataset = datasets.create({
    name: 'Runtime file analysis',
    storage: 'jsonl',
    path: 'datasets/runtime-file-analysis.jsonl',
    tags: ['experiment', 'tools'],
    scoringPrompt: [
      'SCORER_REQUEST',
      'Return exactly one JSON object with score, passed, and rationale.',
      'Question: {{ question_json }}',
      'Reference reasoning: {{ thinking_json }}',
      'Expected answer: {{ answer_json }}',
      'Actual answer: {{ actual_json }}',
      'Expected tools: {{ expected_tools_json }}',
      'Actual tools: {{ actual_tools_json }}',
    ].join('\n'),
  })
  const sampleIds: string[] = []
  for (const question of ['Summarize the project template.', 'Explain what the project template configures.']) {
    sampleIds.push(datasets.createRecord(dataset.id, {
      question,
      thinking: 'Load the file reader, inspect main.j2, and summarize only observable content.',
      answer: 'The template defines the runtime prompt and resource-loading context.',
      expectedTools: ['search_resources', 'load_resources', 'read_file'],
      metadata: { tags: ['smoke'] },
    }).id)
  }
  commitProject(projectDir, 'test: initialize experiment project')

  const requests: LlmChatRequest[] = []
  app = await buildApp({
    runtimeLoop: {
      projectDir,
      llm: experimentLlm(requests),
      streamDelayMs: 0,
      stepDelayMs: 0,
    },
  })
  const projectQuery = `projectPath=${encodeURIComponent(projectDir)}`

  const start = async (name: string, options: { repetitions?: number; sampleIds?: string[] } = {}) => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/experiments?${projectQuery}`,
      payload: { datasetId: dataset.id, name, concurrency: 1, repetitions: options.repetitions ?? 1, timeoutMs: 10_000, ...(options.sampleIds ? { sampleIds: options.sampleIds } : {}) },
    })
    assert.equal(response.statusCode, 202, response.body)
    return waitForRun(app, projectQuery, (response.json() as ExperimentRunDetail).id)
  }

  const first = await start('baseline')
  assert.equal(first.status, 'completed', JSON.stringify(first.failure))
  assert.deepEqual(first.progress, { total: 2, completed: 2 })
  assert.equal(first.metrics.averageScore, 0.9)
  assert.equal(first.metrics.passRate, 100)
  assert.equal(first.metrics.toolRecall, 100)
  assert.equal(first.metrics.toolPrecision, 100)
  assert.equal(first.metrics.scoreBins.reduce((sum, value) => sum + value, 0), 2)
  assert.equal(first.dataset.version, 3)
  assert.equal(first.model.model, 'experiment-test-model')
  assert.match(first.dataset.contentHash, /^[a-f0-9]{64}$/)
  assert.match(first.dataset.cohortHash, /^[a-f0-9]{64}$/)
  assert.match(first.dataset.scoringPromptHash, /^[a-f0-9]{64}$/)
  assert.deepEqual(first.config.sampleIds, sampleIds)

  const casesResponse = await app.inject({
    method: 'GET',
    url: `/api/experiments/${first.id}/cases?${projectQuery}&limit=10`,
  })
  assert.equal(casesResponse.statusCode, 200)
  const cases = casesResponse.json() as { total: number; items: Array<{ id: string; status: string }> }
  assert.equal(cases.total, 2)
  assert.ok(cases.items.every((item) => item.status === 'passed'))

  const caseResponse = await app.inject({
    method: 'GET',
    url: `/api/experiments/${first.id}/cases/${cases.items[0]?.id}?${projectQuery}`,
  })
  assert.equal(caseResponse.statusCode, 200)
  const caseDetail = caseResponse.json()
  assert.deepEqual(caseDetail.actualTools, ['search_resources', 'load_resources', 'read_file'])
  assert.equal(caseDetail.toolCalls.length, 3)
  assert.match(caseDetail.toolCalls[2].resultPreview, /main\.j2/)
  assert.ok(caseDetail.trace.timeline.length > 0)
  assert.equal(caseDetail.trace.observations.length, 3)
  assert.ok(caseDetail.trace.effectiveContexts.length > 0)
  assert.match(caseDetail.trace.scoring.prompt, /SCORER_REQUEST/)
  assert.match(caseDetail.trace.scoring.response, /"score":0\.9/)

  const toolsResponse = await app.inject({
    method: 'GET',
    url: `/api/experiments/${first.id}/tools?${projectQuery}`,
  })
  assert.equal(toolsResponse.statusCode, 200)
  assert.deepEqual(
    toolsResponse.json().items.map((item: { name: string; expected: number; hit: number }) => [item.name, item.expected, item.hit]),
    [
      ['load_resources', 2, 2],
      ['read_file', 2, 2],
      ['search_resources', 2, 2],
    ],
  )

  const partial = await start('partial cohort', { sampleIds: [sampleIds[0] as string] })
  const repeated = await start('different repetitions', { repetitions: 2 })
  const second = await start('candidate')
  assert.equal(second.status, 'completed', JSON.stringify(second.failure))
  const trends = await app.inject({
    method: 'GET',
    url: `/api/experiments/trends?${projectQuery}&datasetId=${dataset.id}`,
  })
  assert.equal(trends.statusCode, 200)
  assert.deepEqual(trends.json().runs.map((run: { id: string }) => run.id), [first.id, second.id])
  assert.deepEqual(
    trends.json().excluded.map((item: { run: { id: string }; issues: string[] }) => [item.run.id, item.issues]),
    [
      [partial.id, ['sample_cohort']],
      [repeated.id, ['repetitions']],
    ],
  )

  const comparison = await app.inject({
    method: 'GET',
    url: `/api/experiments/compare?${projectQuery}&datasetId=${dataset.id}&leftId=${first.id}&rightId=${second.id}`,
  })
  assert.equal(comparison.statusCode, 200, comparison.body)
  assert.equal(comparison.json().dataset.id, dataset.id)
  assert.equal(comparison.json().samples.length, 2)
  assert.ok(comparison.json().samples.every((item: { delta: number }) => item.delta === 0))

  const partialComparison = await app.inject({
    method: 'GET',
    url: `/api/experiments/compare?${projectQuery}&datasetId=${dataset.id}&leftId=${first.id}&rightId=${partial.id}`,
  })
  assert.equal(partialComparison.statusCode, 400)
  assert.match(partialComparison.json().error, /sample_cohort/)
  const repeatedComparison = await app.inject({
    method: 'GET',
    url: `/api/experiments/compare?${projectQuery}&datasetId=${dataset.id}&leftId=${first.id}&rightId=${repeated.id}`,
  })
  assert.equal(repeatedComparison.statusCode, 400)
  assert.match(repeatedComparison.json().error, /repetitions/)

  datasets.update(dataset.id, { scoringPrompt: 'SCORER_REQUEST changed evaluator {{ actual_json }}' })
  commitProject(projectDir, 'test: change experiment evaluator')
  const rescored = await start('different evaluator')
  const evaluatorComparison = await app.inject({
    method: 'GET',
    url: `/api/experiments/compare?${projectQuery}&datasetId=${dataset.id}&leftId=${first.id}&rightId=${rescored.id}`,
  })
  assert.equal(evaluatorComparison.statusCode, 400)
  assert.match(evaluatorComparison.json().error, /evaluator/)

  const storage = await app.inject({ method: 'GET', url: `/api/experiments/storage?${projectQuery}` })
  assert.equal(storage.statusCode, 200)
  assert.equal(storage.json().runCount, 5)
  assert.ok(storage.json().bytes > 0)
  assert.equal(fs.existsSync(path.join(projectDir, '.capybara', 'experiments.sqlite')), true)
  assert.ok(requests.length >= 10)
})

test('experiment start rejects incomplete datasets and dirty projects', async (context) => {
  const projectDir = temporaryExperimentProject()
  let app: Awaited<ReturnType<typeof buildApp>> | undefined
  context.after(async () => {
    await app?.close()
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
  const datasets = new DatasetStore(projectDir)
  const dataset = datasets.create({
    name: 'Incomplete',
    storage: 'jsonl',
    path: 'datasets/incomplete.jsonl',
    scoringPrompt: '',
  })
  datasets.createRecord(dataset.id, { question: 'Q', thinking: 'T', answer: 'A' })
  commitProject(projectDir, 'test: initialize invalid experiment')
  app = await buildApp({ runtimeLoop: { projectDir, llm: experimentLlm([]) } })
  const projectQuery = `projectPath=${encodeURIComponent(projectDir)}`

  const missingScorer = await app.inject({
    method: 'POST',
    url: `/api/experiments?${projectQuery}`,
    payload: { datasetId: dataset.id },
  })
  assert.equal(missingScorer.statusCode, 400)
  assert.match(missingScorer.json().error, /scoringPrompt is required/)

  datasets.update(dataset.id, { scoringPrompt: 'SCORER_REQUEST {{ actual_json }}' })
  const dirty = await app.inject({
    method: 'POST',
    url: `/api/experiments?${projectQuery}`,
    payload: { datasetId: dataset.id },
  })
  assert.equal(dirty.statusCode, 400)
  assert.match(dirty.json().error, /project must be clean/)
})

test('project experiment adapters own case lifecycle, deterministic evaluation, and aggregate metrics', async (context) => {
  const projectDir = temporaryExperimentProject()
  let app: Awaited<ReturnType<typeof buildApp>> | undefined
  context.after(async () => {
    await app?.close()
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
  writeExperimentAdapter(projectDir)
  fs.mkdirSync(path.join(projectDir, '.venv'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.venv', 'dependency-marker.txt'), 'must not be copied', 'utf8')
  const datasets = new DatasetStore(projectDir)
  const dataset = datasets.create({
    name: 'Deterministic environment benchmark',
    storage: 'jsonl',
    path: 'datasets/deterministic.jsonl',
    scoringPrompt: '',
  })
  datasets.createRecord(dataset.id, {
    question: 'Complete the task in the isolated environment.',
    thinking: 'Private reference reasoning that must not be exposed to the runtime.',
    answer: 'Private expected answer that must not be exposed to the runtime.',
    expectedTools: [],
    metadata: {
      tags: ['adapter'],
      public: { task_id: 'scenario_1', split: 'dev', difficulty: 2 },
      private: { evaluator_secret: 'must-not-leak' },
    },
  })
  commitProject(projectDir, 'test: add deterministic experiment adapter')

  const requests: LlmChatRequest[] = []
  const llm: RuntimeLlm = {
    async chat(request) {
      requests.push(structuredClone({ ...request, signal: undefined }))
      return response(JSON.stringify({ status: 'completed', content: 'Environment task completed.' }))
    },
    getConfig: () => ({
      provider: 'custom',
      protocol: 'responses',
      model: 'adapter-test-model',
      baseUrl: 'http://127.0.0.1/unused',
      timeoutMs: 1_000,
      maxRetries: 0,
    }),
  }
  app = await buildApp({ runtimeLoop: { projectDir, llm, streamDelayMs: 0, stepDelayMs: 0 } })
  const projectQuery = `projectPath=${encodeURIComponent(projectDir)}`
  const startResponse = await app.inject({
    method: 'POST',
    url: `/api/experiments?${projectQuery}`,
    payload: { datasetId: dataset.id, concurrency: 1, repetitions: 1, timeoutMs: 10_000, keepWorkspaces: true },
  })
  assert.equal(startResponse.statusCode, 202, startResponse.body)
  const run = await waitForRun(app, projectQuery, (startResponse.json() as ExperimentRunDetail).id)
  assert.equal(run.status, 'completed', JSON.stringify(run.failure))
  assert.equal(run.evaluator.type, 'project')
  assert.equal(run.metrics.averageScore, 0.75)
  assert.equal(run.metrics.scoringUsage.totalTokens, 0)
  assert.equal(run.metrics.toolPrecision, null)
  assert.equal(run.metrics.toolRecall, null)
  assert.deepEqual(run.metrics.custom, {
    task_goal_completion: 100,
    scenario_goal_completion: 100,
    evaluated_cases: 1,
  })

  const casesResponse = await app.inject({
    method: 'GET',
    url: `/api/experiments/${run.id}/cases?${projectQuery}`,
  })
  const caseId = casesResponse.json().items[0].id as string
  const detailResponse = await app.inject({
    method: 'GET',
    url: `/api/experiments/${run.id}/cases/${caseId}?${projectQuery}`,
  })
  assert.equal(detailResponse.statusCode, 200)
  const detail = detailResponse.json()
  assert.equal(detail.metadata.private.evaluator_secret, 'must-not-leak')
  assert.equal(detail.evaluation.source, 'project')
  assert.equal(detail.evaluation.metrics.passed_tests, 3)
  assert.equal(detail.evaluation.reference.kind, 'text')
  assert.equal(detail.evaluation.reference.displayValue, 'Official fixture answer')
  assert.equal(detail.trace.adapter.prepare.taskId, 'scenario_1')
  assert.equal(detail.trace.adapter.evaluation.details.task_id, 'scenario_1')
  assert.equal(detail.trace.scoring, undefined)

  const caseFile = path.join(projectDir, '.capybara', 'worktrees', run.id, caseId, '.capybara', 'experiment-case.json')
  const caseContext = fs.readFileSync(caseFile, 'utf8')
  assert.match(caseContext, /scenario_1/)
  assert.doesNotMatch(caseContext, /must-not-leak|Private expected answer|Private reference reasoning/)
  assert.equal(fs.existsSync(path.join(path.dirname(path.dirname(caseFile)), '.venv')), false)
  const events = fs.readFileSync(path.join(path.dirname(caseFile), 'adapter-events.jsonl'), 'utf8')
  assert.match(events, /"phase":"prepare"/)
  assert.match(events, /"phase":"evaluate"/)
  assert.match(events, /"phase":"cleanup"/)
  assert.equal(requests.length, 1)
})
