import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

import { DatasetStore } from '#core/datasets/dataset-store'
import { ExperimentManager } from '#core/experiments/experiment-manager'
import { compareTrainingRuns, createTrainingVariableDiff } from '#core/experiments/training/training-analysis'
import { TrainingManager } from '#core/experiments/training/training-manager'
import { applyUnifiedDiff } from '#core/experiments/training/unified-diff'
import { initializeProjectDirectory } from '#core/project-initializer'
import { ProjectResources } from '#core/project-resources'
import type { RuntimeLlm } from '#core/runtime-loop'

const EXPERIENCE_HOOK = `import { defineHook } from "@capybara-agent/sdk";

export default defineHook({
  name: "experience-extractor",
  description: "Training integration fixture.",
  enabled: true,
  checkpoint: "after_evaluation",
  trigger({ variables }) {
    return !variables.builtin.prompts.agent_identity.includes("learned replay rule");
  },
  schedule: { priority: 1, timeoutMs: 2000, onError: "continue" },
  permissions: { variables: "patch" },
  run({ variables, training }) {
    const before = variables.builtin.prompts.agent_identity;
    return { experiences: [{
      summary: "Persist a replayed rule",
      rationale: "Integration test with " + training.case.toolCalls.length + " tool calls and " + training.evaluation.reference.kind + " reference",
      patches: [{
        variableName: "agent_identity",
        unifiedDiff: [
          "diff --git a/variables/agent_identity.txt b/variables/agent_identity.txt",
          "--- a/variables/agent_identity.txt",
          "+++ b/variables/agent_identity.txt",
          "@@ -1,1 +1,2 @@",
          " " + before,
          "+learned replay rule",
        ].join("\\n"),
      }],
    }] };
  },
});
`

const EMPTY_EXPERIENCE_HOOK = `import { defineHook } from "@capybara-agent/sdk";

export default defineHook({
  name: "empty-extractor",
  description: "Returns no experience candidates.",
  enabled: true,
  checkpoint: "after_evaluation",
  trigger() { return true; },
  schedule: { priority: 1, timeoutMs: 2000, onError: "continue" },
  permissions: { variables: "patch" },
  run() { return { experiences: [] }; },
});
`

const TIMEOUT_EXPERIENCE_HOOK = `import { defineHook } from "@capybara-agent/sdk";

export default defineHook({
  name: "timeout-extractor",
  description: "Times out before succeeding on a retried training run.",
  enabled: true,
  checkpoint: "after_evaluation",
  trigger() { return true; },
  schedule: { priority: 1, timeoutMs: 100, onError: "retry" },
  permissions: { llm: "project" },
  async run({ llm }) {
    await llm.responses.create({ input: "learning-hook-probe" });
    return { experiences: [] };
  },
});
`

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function llm(): RuntimeLlm {
  return {
    async chat() {
      return {
        provider: 'custom',
        model: 'training-test-model',
        text: JSON.stringify({ status: 'completed', content: 'done' }),
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        raw: {},
      }
    },
    getConfig: () => ({
      provider: 'custom',
      protocol: 'responses',
      model: 'training-test-model',
      baseUrl: 'http://127.0.0.1/unused',
      timeoutMs: 1_000,
      maxRetries: 0,
    }),
  }
}

async function waitFor(
  manager: TrainingManager,
  id: string,
  statuses: string[],
): Promise<ReturnType<TrainingManager['get']>> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const run = manager.get(id)
    if (statuses.includes(run.status)) return run
    await delay(20)
  }
  throw new Error(`training run did not reach ${statuses.join(', ')}`)
}

test('Git unified diff applies context, additions, and removals', () => {
  const before = ['alpha', 'beta', 'gamma'].join('\n')
  const diff = [
    'diff --git a/value.txt b/value.txt',
    '--- a/value.txt',
    '+++ b/value.txt',
    '@@ -1,3 +1,3 @@',
    ' alpha',
    '-beta',
    '+bravo',
    ' gamma',
  ].join('\n')
  assert.equal(applyUnifiedDiff(before, diff), ['alpha', 'bravo', 'gamma'].join('\n'))
  assert.throws(() => applyUnifiedDiff('changed', diff), /context mismatch/)
})

test('training runs evaluation, Hook extraction, replay, snapshot, and held-out test', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-training-'))
  initializeProjectDirectory(projectDir)
  const resources = new ProjectResources(projectDir)
  const variables = resources.readSystemVariables()
  const initialAgentIdentity = variables.variables.find((item) => item.key === 'agent_identity')?.value ?? ''
  resources.saveSystemVariables({
    ...variables,
    variables: variables.variables.map((variable) => variable.key === 'agent_identity'
      ? { ...variable, scope: 'project', show_in_status: true }
      : variable),
  })
  fs.mkdirSync(path.join(projectDir, '.capybara', 'hooks'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'hooks', 'experience-extractor.ts'), EXPERIENCE_HOOK)
  fs.mkdirSync(path.join(projectDir, 'experiments'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.capybara', 'experiment-adapter.json'), `${JSON.stringify({
    version: 1,
    runner: { type: 'stdio', entry: 'experiments/training-adapter.mjs' },
    phases: ['evaluate'],
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(projectDir, 'experiments', 'training-adapter.mjs'), [
    "let input = '';",
    'for await (const chunk of process.stdin) input += chunk;',
    'const request = JSON.parse(input);',
    "process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { score: 1, passed: true, rationale: 'passed', metrics: {}, reference: { kind: 'text', status: 'available', source: { type: 'official_evaluator', benchmark: 'fixture' }, displayValue: 'done', value: 'done', requirements: [], actualStateChanges: [], failureTraces: [], resolvedAt: request.startedAt } } }));",
    '',
  ].join('\n'))
  const datasets = new DatasetStore(projectDir)
  const train = datasets.create({ name: 'train', storage: 'jsonl', path: 'datasets/train.jsonl', tags: ['train'], scoringPrompt: '' })
  const heldOut = datasets.create({ name: 'test', storage: 'jsonl', path: 'datasets/test.jsonl', tags: ['test'], scoringPrompt: '' })
  const challenge = datasets.create({ name: 'challenge', storage: 'jsonl', path: 'datasets/challenge.jsonl', tags: ['test_challenge'], scoringPrompt: '' })
  datasets.createRecord(train.id, { question: 'training question', thinking: 'reference thinking', answer: '' })
  datasets.createRecord(train.id, { question: 'second training question', thinking: 'reference thinking', answer: '' })
  datasets.createRecord(heldOut.id, { question: 'held-out question', thinking: 'reference thinking', answer: '' })
  datasets.createRecord(challenge.id, { question: 'challenge question', thinking: 'reference thinking', answer: '' })
  git(projectDir, 'init', '--initial-branch=main')
  git(projectDir, 'config', 'user.name', 'Capybara Test')
  git(projectDir, 'config', 'user.email', 'capybara@example.invalid')
  git(projectDir, 'add', '.')
  git(projectDir, 'commit', '-m', 'fixture')

  const experiments = new ExperimentManager(projectDir, { llm: llm(), runtimeLoop: { stepDelayMs: 0, streamDelayMs: 0 } })
  const training = new TrainingManager(projectDir, experiments)
  try {
    const created = training.create({
      name: 'AppWorld correction baseline',
      trainDatasetId: train.id,
      testDatasetId: heldOut.id,
      trainLimit: 2,
      testLimit: 1,
      learningMode: 'auto',
      reviewScope: 'failed',
      pauseOnFailure: false,
      experienceExtractorHook: { hookId: 'experience-extractor', parameters: {} },
      timeoutMs: 10_000,
    })
    assert.equal(created.name, 'AppWorld correction baseline')
    const trained = await waitFor(training, created.id, ['ready_to_freeze', 'failed'])
    assert.equal(trained.status, 'ready_to_freeze', trained.failure?.message ?? 'training did not reach ready_to_freeze')
    assert.equal(trained.progress.training.completed, 2)
    assert.equal(training.experiences(created.id).length, 1)
    assert.equal(training.experiences(created.id)[0]?.status, 'applied')
    assert.equal(resources.readSystemVariables().variables.find((item) => item.key === 'agent_identity')?.value, initialAgentIdentity)
    assert.match(training.store.runVariables(created.id).agent_identity ?? '', /learned replay rule/)
    const trainedCases = training.cases(created.id)
    const trainingCase = trainedCases.find((item) => item.phase === 'training')
    const heldOutBeforeTest = trainedCases.find((item) => item.phase === 'testing')
    assert.equal(trainingCase?.reference.status, 'available')
    assert.equal(trainingCase?.reference.kind, 'text')
    assert.equal(trainingCase?.evaluation?.reference?.displayValue, 'done')
    assert.equal(trainingCase?.expectedAnswer, '')
    assert.equal(heldOutBeforeTest?.reference.status, 'locked')
    assert.equal(heldOutBeforeTest?.expectedAnswer, '')
    assert.deepEqual(heldOutBeforeTest?.expectedTools, [])
    const learnedVariable = training.variables(created.id).items.find((item) => item.name === 'agent_identity')
    assert.equal(learnedVariable?.baselineValue, initialAgentIdentity)
    assert.match(learnedVariable?.runValue ?? '', /learned replay rule/)
    assert.equal(learnedVariable?.state, 'applied')
    assert.equal(learnedVariable?.changed, true)
    assert.equal(learnedVariable?.sourceCaseIds.length, 1)
    assert.equal(training.list().some((item) => item.id === created.id), true)
    assert.match(training.experiences(created.id)[0]?.rationale ?? '', /text reference/)

    const snapshot = training.freeze(created.id)
    assert.match(snapshot.variables.agent_identity ?? '', /learned replay rule/)
    assert.equal(training.cases(created.id).find((item) => item.phase === 'testing')?.reference.status, 'locked')
    const repeatedEvaluation = training.createSnapshotEvaluation(created.id, {
      name: 'Repeat held-out from frozen snapshot',
      testDatasetId: heldOut.id,
      testLimit: 1,
    })
    assert.equal(repeatedEvaluation.status, 'ready_for_test')
    assert.equal(repeatedEvaluation.snapshotId, snapshot.id)
    assert.equal(repeatedEvaluation.config.testDatasetId, heldOut.id)
    assert.equal(repeatedEvaluation.config.snapshotSourceRunId, created.id)
    training.startTest(created.id)
    const completed = await waitFor(training, created.id, ['completed', 'failed'])
    assert.equal(completed.status, 'completed', completed.failure?.message ?? 'held-out test did not complete')
    assert.deepEqual(completed.progress.testing, { total: 1, completed: 1 })
    const heldOutAfterTest = training.cases(created.id).find((item) => item.phase === 'testing')
    assert.equal(heldOutAfterTest?.reference.status, 'available')
    assert.equal(heldOutAfterTest?.reference.kind, 'text')
    assert.equal(heldOutAfterTest?.expectedAnswer, '')
    assert.match(training.variables(created.id).items.find((item) => item.name === 'agent_identity')?.snapshotValue ?? '', /learned replay rule/)
    assert.equal(resources.readSystemVariables().variables.find((item) => item.key === 'agent_identity')?.value, initialAgentIdentity)
    const snapshotEvaluation = training.createSnapshotEvaluation(created.id, {
      name: 'Challenge from frozen snapshot',
      testDatasetId: challenge.id,
      testLimit: 1,
    })
    assert.equal(snapshotEvaluation.status, 'ready_for_test')
    assert.equal(snapshotEvaluation.snapshotId, snapshot.id)
    assert.equal(snapshotEvaluation.config.evaluationOnly, true)
    assert.equal(snapshotEvaluation.config.snapshotSourceRunId, created.id)
    assert.deepEqual(snapshotEvaluation.progress.training, { total: 0, completed: 0 })
    assert.deepEqual(snapshotEvaluation.progress.testing, { total: 1, completed: 0 })
    assert.deepEqual(training.store.getSnapshot(snapshotEvaluation.id), snapshot)
    training.startTest(snapshotEvaluation.id)
    const evaluatedSnapshot = await waitFor(training, snapshotEvaluation.id, ['completed', 'failed'])
    assert.equal(evaluatedSnapshot.status, 'completed', evaluatedSnapshot.failure?.message ?? 'snapshot evaluation did not complete')
    assert.ok(evaluatedSnapshot.startedAt)
    assert.equal(evaluatedSnapshot.snapshotId, snapshot.id)
    assert.deepEqual(evaluatedSnapshot.progress.testing, { total: 1, completed: 1 })
    training.startTest(repeatedEvaluation.id)
    const repeatedSnapshot = await waitFor(training, repeatedEvaluation.id, ['completed', 'failed'])
    assert.equal(repeatedSnapshot.status, 'completed', repeatedSnapshot.failure?.message ?? 'repeated snapshot evaluation did not complete')
    assert.equal(repeatedSnapshot.snapshotId, snapshot.id)
    await assert.rejects(() => training.promote(snapshotEvaluation.id), /evaluation-only runs cannot promote/)
    const promoted = await training.promote(created.id)
    assert.match(promoted.variables.agent_identity ?? '', /learned replay rule/)
    assert.match(resources.readSystemVariables().variables.find((item) => item.key === 'agent_identity')?.value ?? '', /learned replay rule/)
    const currentResources = resources.readSystemVariables()
    resources.saveSystemVariables({
      ...currentResources,
      variables: currentResources.variables.map((variable) => variable.key === 'agent_identity'
        ? { ...variable, value: 'external project change' }
        : variable),
    })
    const inherited = training.create({
      name: 'Inherited baseline',
      trainDatasetId: train.id,
      testDatasetId: heldOut.id,
      trainLimit: 1,
      testLimit: 1,
      learningMode: 'auto',
      reviewScope: 'failed',
      pauseOnFailure: false,
      variableSource: 'run',
      variableSourceRunId: created.id,
      experienceExtractorHook: { hookId: 'experience-extractor', parameters: {} },
      timeoutMs: 10_000,
    })
    assert.equal(inherited.config.variableSource, 'run')
    assert.equal(inherited.config.variableSourceRunId, created.id)
    assert.match(training.store.baselineVariables(inherited.id).agent_identity ?? '', /learned replay rule/)
    training.cancel(inherited.id)
    const analysis = training.analysis(created.id)
    assert.equal(analysis.run.name, 'AppWorld correction baseline')
    assert.equal(analysis.training.evaluated, 2)
    assert.equal(analysis.testing.passRate, 1)
    assert.equal(analysis.experiences.applied, 1)
    assert.equal(analysis.variables.changed, 1)
    assert.equal(analysis.events.some((event) => event.type === 'snapshot.created'), true)
    const trend = training.trend(heldOut.id)
    assert.equal(trend.items.some((item) => item.run.id === created.id), true)
    const inheritedNode = trend.lineage.nodes.find((item) => item.run.run.id === inherited.id)
    assert.equal(inheritedNode?.sourceRunId, created.id)
    assert.equal(inheritedNode?.rootRunId, created.id)
    assert.equal(trend.lineage.edges.some((edge) => edge.sourceRunId === created.id && edge.continuationRunId === inherited.id), true)

    const baseline = {
      ...analysis,
      cases: analysis.cases.map((item) => item.phase === 'testing'
        ? { ...item, score: 0, passed: false }
        : item),
    }
    const comparison = compareTrainingRuns(baseline, analysis)
    assert.equal(comparison.comparable, true)
    assert.equal(comparison.cases.find((item) => item.sampleId === heldOutAfterTest?.sampleId)?.status, 'improved')
    const pending = {
      ...analysis,
      cases: analysis.cases.map((item) => {
        if (item.phase !== 'testing') return item
        const { score: _score, passed: _passed, ...pendingItem } = item
        return pendingItem
      }),
    }
    const pendingComparison = compareTrainingRuns(baseline, pending)
    assert.equal(pendingComparison.cases.find((item) => item.sampleId === heldOutAfterTest?.sampleId)?.status, 'pending')
    const diff = createTrainingVariableDiff('agent_identity', 'before', 'after')
    assert.equal(applyUnifiedDiff('before', diff), 'after')
  } finally {
    await training.close()
    await experiments.close()
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('historical references hydrate without changing scores and release per completed case', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-training-reference-'))
  initializeProjectDirectory(projectDir)
  fs.mkdirSync(path.join(projectDir, '.capybara', 'hooks'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.capybara', 'hooks', 'empty-extractor.ts'), EMPTY_EXPERIENCE_HOOK)
  fs.mkdirSync(path.join(projectDir, 'experiments'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.capybara', 'experiment-adapter.json'), `${JSON.stringify({
    version: 1,
    runner: { type: 'stdio', entry: 'experiments/reference-adapter.mjs' },
    phases: ['evaluate', 'reference'],
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(projectDir, 'experiments', 'reference-adapter.mjs'), [
    "let input = '';",
    'for await (const chunk of process.stdin) input += chunk;',
    'const request = JSON.parse(input);',
    "const reference = { kind: 'state', status: 'available', source: { type: 'official_evaluator', benchmark: 'fixture', resolverRevision: process.env.CAPYBARA_EXPERIMENT_ADAPTER_REVISION }, requirements: [{ ordinal: 0, status: 'failed', description: 'expected state transition' }], expectedState: { expected: true }, actualStateChanges: [{ application: 'fixture', model: 'Record', records: 1, added: 0, updated: 1, removed: 0, recordChanges: [{ recordId: 9, operation: 'updated', fields: [{ field: 'value', before: false, after: true }] }] }], stateChangesStatus: 'complete', failureTraces: ['expected true, received false'], resolvedAt: request.startedAt };",
    "const result = request.phase === 'reference' ? { items: request.payload.cases.map((item) => ({ id: item.id, reference })) } : { score: 0, passed: false, rationale: 'official failure', metrics: { passedRequirements: 0, failedRequirements: 1 }, details: { legacy: true } };",
    'process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }));',
    '',
  ].join('\n'))
  const datasets = new DatasetStore(projectDir)
  const train = datasets.create({ name: 'train', storage: 'jsonl', path: 'datasets/train.jsonl', tags: ['train'], scoringPrompt: '' })
  const heldOut = datasets.create({ name: 'test', storage: 'jsonl', path: 'datasets/test.jsonl', tags: ['test'], scoringPrompt: '' })
  datasets.createRecord(train.id, { question: 'historical training question', thinking: '', answer: '' })
  datasets.createRecord(heldOut.id, { question: 'held-out one', thinking: '', answer: '' })
  datasets.createRecord(heldOut.id, { question: 'held-out two', thinking: '', answer: '' })
  git(projectDir, 'init', '--initial-branch=main')
  git(projectDir, 'config', 'user.name', 'Capybara Test')
  git(projectDir, 'config', 'user.email', 'capybara@example.invalid')
  git(projectDir, 'add', '.')
  git(projectDir, 'commit', '-m', 'fixture')
  const experiments = new ExperimentManager(projectDir, { llm: llm(), runtimeLoop: { stepDelayMs: 0, streamDelayMs: 0 } })
  const training = new TrainingManager(projectDir, experiments)
  try {
    const run = training.create({
      trainDatasetId: train.id,
      testDatasetId: heldOut.id,
      trainLimit: 1,
      testLimit: 2,
      learningMode: 'auto',
      reviewScope: 'failed',
      pauseOnFailure: false,
      experienceExtractorHook: { hookId: 'empty-extractor', parameters: {} },
      timeoutMs: 10_000,
    })
    const ready = await waitFor(training, run.id, ['ready_to_freeze', 'failed'])
    assert.equal(ready.status, 'ready_to_freeze', ready.failure?.message ?? 'training did not finish')
    const before = training.cases(run.id).find((item) => item.phase === 'training')
    assert.equal(before?.score, 0)
    assert.equal(before?.reference.status, 'unavailable')
    await training.hydrateReferences(run.id)
    const hydrated = training.cases(run.id).find((item) => item.phase === 'training')
    assert.equal(hydrated?.score, 0)
    assert.equal(hydrated?.evaluation?.metrics.failedRequirements, 1)
    assert.ok(hydrated && hydrated.reference.status !== 'locked')
    assert.equal(hydrated.reference.kind, 'state')
    assert.deepEqual(hydrated.reference.expectedState, { expected: true })
    assert.deepEqual(hydrated.reference.actualStateChanges[0]?.recordChanges?.[0]?.fields[0], {
      field: 'value', before: false, after: true,
    })

    const heldOutCases = training.store.listCases(run.id, 'testing')
    const completedCase = heldOutCases[0]
    const lockedCase = heldOutCases[1]
    assert.ok(completedCase && lockedCase)
    training.store.recordEvaluation(completedCase.id, {
      experimentCaseId: 'manual-evaluated-case',
      actualAnswer: 'done',
      actualTools: [],
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 },
      score: 1,
      passed: true,
      rationale: 'passed',
      evaluation: {
        source: 'project',
        metrics: {},
        reference: {
          kind: 'text', status: 'available', source: { type: 'official_evaluator' },
          displayValue: 'official', value: 'official', requirements: [], actualStateChanges: [],
          failureTraces: [], resolvedAt: new Date().toISOString(),
        },
      },
    })
    training.store.setCaseStatus(completedCase.id, 'completed')
    const testingViews = training.cases(run.id).filter((item) => item.phase === 'testing')
    assert.equal(testingViews.find((item) => item.id === completedCase.id)?.reference.status, 'available')
    assert.equal(testingViews.find((item) => item.id === lockedCase.id)?.reference.status, 'locked')
  } finally {
    await training.close()
    await experiments.close()
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('failed training retries only the failed case and preserves completed work', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-training-retry-'))
  initializeProjectDirectory(projectDir)
  fs.mkdirSync(path.join(projectDir, '.capybara', 'hooks'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.capybara', 'hooks', 'empty-extractor.ts'), EMPTY_EXPERIENCE_HOOK)
  fs.mkdirSync(path.join(projectDir, 'experiments'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.capybara', 'experiment-adapter.json'), `${JSON.stringify({
    version: 1,
    runner: { type: 'stdio', entry: 'experiments/training-adapter.mjs' },
    phases: ['evaluate'],
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(projectDir, 'experiments', 'training-adapter.mjs'), [
    "let input = '';",
    'for await (const chunk of process.stdin) input += chunk;',
    'const request = JSON.parse(input);',
    "process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { score: 1, passed: true, rationale: 'passed', metrics: {} } }));",
    '',
  ].join('\n'))
  const datasets = new DatasetStore(projectDir)
  const train = datasets.create({ name: 'train', storage: 'jsonl', path: 'datasets/train.jsonl', tags: ['train'], scoringPrompt: '' })
  const heldOut = datasets.create({ name: 'test', storage: 'jsonl', path: 'datasets/test.jsonl', tags: ['test'], scoringPrompt: '' })
  datasets.createRecord(train.id, { question: 'training question', thinking: '', answer: 'done' })
  datasets.createRecord(heldOut.id, { question: 'test question', thinking: '', answer: 'done' })
  git(projectDir, 'init', '--initial-branch=main')
  git(projectDir, 'config', 'user.name', 'Capybara Test')
  git(projectDir, 'config', 'user.email', 'capybara@example.invalid')
  git(projectDir, 'add', '.')
  git(projectDir, 'commit', '-m', 'fixture')

  let invocations = 0
  const retryLlm: RuntimeLlm = {
    async chat() {
      invocations += 1
      return {
        provider: 'custom',
        model: 'retry-test-model',
        text: invocations <= 3 ? 'invalid output' : JSON.stringify({ status: 'completed', content: 'done' }),
        raw: {},
      }
    },
    getConfig: () => ({
      provider: 'custom', protocol: 'responses', model: 'retry-test-model',
      baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1_000, maxRetries: 0,
    }),
  }
  const experiments = new ExperimentManager(projectDir, { llm: retryLlm, runtimeLoop: { stepDelayMs: 0, streamDelayMs: 0 } })
  const training = new TrainingManager(projectDir, experiments)
  try {
    const created = training.create({
      trainDatasetId: train.id,
      testDatasetId: heldOut.id,
      trainLimit: 1,
      testLimit: 1,
      learningMode: 'auto',
      reviewScope: 'failed',
      pauseOnFailure: false,
      experienceExtractorHook: { hookId: 'empty-extractor', parameters: {} },
      timeoutMs: 10_000,
    })
    const failed = await waitFor(training, created.id, ['failed'])
    assert.equal(failed.progress.training.completed, 1)
    assert.equal(training.cases(created.id).find((item) => item.phase === 'training')?.attempt, 3)

    training.retry(created.id)
    const recovered = await waitFor(training, created.id, ['ready_to_freeze', 'failed'])
    assert.equal(recovered.status, 'ready_to_freeze', recovered.failure?.message ?? 'retry did not recover the run')
    const retried = training.cases(created.id).find((item) => item.phase === 'training')
    assert.equal(retried?.attempt, 4)
    assert.equal(retried?.status, 'completed')
  } finally {
    await training.close()
    await experiments.close()
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('Hook failures mark the evaluated case retryable and resume without rerunning the agent', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-training-hook-retry-'))
  initializeProjectDirectory(projectDir)
  fs.mkdirSync(path.join(projectDir, '.capybara', 'hooks'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.capybara', 'hooks', 'timeout-extractor.ts'), TIMEOUT_EXPERIENCE_HOOK)
  fs.mkdirSync(path.join(projectDir, 'experiments'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.capybara', 'experiment-adapter.json'), `${JSON.stringify({
    version: 1,
    runner: { type: 'stdio', entry: 'experiments/training-adapter.mjs' },
    phases: ['evaluate'],
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(projectDir, 'experiments', 'training-adapter.mjs'), [
    "let input = '';",
    'for await (const chunk of process.stdin) input += chunk;',
    'const request = JSON.parse(input);',
    "process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { score: 1, passed: true, rationale: 'passed', metrics: {} } }));",
    '',
  ].join('\n'))
  const datasets = new DatasetStore(projectDir)
  const train = datasets.create({ name: 'train', storage: 'jsonl', path: 'datasets/train.jsonl', tags: ['train'], scoringPrompt: '' })
  const heldOut = datasets.create({ name: 'test', storage: 'jsonl', path: 'datasets/test.jsonl', tags: ['test'], scoringPrompt: '' })
  datasets.createRecord(train.id, { question: 'training question', thinking: '', answer: 'done' })
  datasets.createRecord(heldOut.id, { question: 'test question', thinking: '', answer: 'done' })
  git(projectDir, 'init', '--initial-branch=main')
  git(projectDir, 'config', 'user.name', 'Capybara Test')
  git(projectDir, 'config', 'user.email', 'capybara@example.invalid')
  git(projectDir, 'add', '.')
  git(projectDir, 'commit', '-m', 'fixture')

  let hookInvocations = 0
  let agentInvocations = 0
  const retryLlm: RuntimeLlm = {
    async chat(request) {
      if (request.messages.some((message) => message.content.includes('learning-hook-probe'))) {
        hookInvocations += 1
        if (hookInvocations <= 2) return new Promise(() => {})
        return { provider: 'custom', model: 'hook-retry-model', text: 'ok', raw: {} }
      }
      agentInvocations += 1
      return {
        provider: 'custom',
        model: 'hook-retry-model',
        text: JSON.stringify({ status: 'completed', content: 'done' }),
        raw: {},
      }
    },
    getConfig: () => ({
      provider: 'custom', protocol: 'responses', model: 'hook-retry-model',
      baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1_000, maxRetries: 0,
    }),
  }
  const experiments = new ExperimentManager(projectDir, { llm: retryLlm, runtimeLoop: { stepDelayMs: 0, streamDelayMs: 0 } })
  const training = new TrainingManager(projectDir, experiments)
  try {
    const created = training.create({
      trainDatasetId: train.id,
      testDatasetId: heldOut.id,
      trainLimit: 1,
      testLimit: 1,
      learningMode: 'auto',
      reviewScope: 'failed',
      pauseOnFailure: false,
      experienceExtractorHook: { hookId: 'timeout-extractor', parameters: {} },
      timeoutMs: 10_000,
    })
    const failed = await waitFor(training, created.id, ['failed'])
    assert.match(failed.failure?.message ?? '', /Hook exceeded 100 ms/)
    const failedCase = training.cases(created.id).find((item) => item.phase === 'training')
    assert.equal(failedCase?.status, 'error')
    assert.equal(failedCase?.passed, true)
    assert.equal(failedCase?.attempt, 1)
    const agentCallsBeforeRetry = agentInvocations

    training.retry(created.id)
    const recovered = await waitFor(training, created.id, ['ready_to_freeze', 'failed'])
    assert.equal(recovered.status, 'ready_to_freeze', recovered.failure?.message ?? 'Hook retry did not recover the run')
    const recoveredCase = training.cases(created.id).find((item) => item.phase === 'training')
    assert.equal(recoveredCase?.status, 'completed')
    assert.equal(recoveredCase?.attempt, 1)
    assert.equal(agentInvocations, agentCallsBeforeRetry)
    assert.equal(hookInvocations, 3)
  } finally {
    await training.close()
    await experiments.close()
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
