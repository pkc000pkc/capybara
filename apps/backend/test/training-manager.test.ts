import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

import { DatasetStore } from '#core/datasets/dataset-store'
import { ExperimentManager } from '#core/experiments/experiment-manager'
import { EMPTY_EXPERIMENT_METRICS, ExperimentStore } from '#core/experiments/experiment-store'
import { compareTrainingRuns, createTrainingVariableDiff } from '#core/experiments/training/training-analysis'
import { TrainingManager } from '#core/experiments/training/training-manager'
import { applyUnifiedDiff } from '#core/experiments/training/unified-diff'
import { initializeProjectDirectory } from '#core/project-initializer'
import { ProjectResources } from '#core/project-resources'
import { RuntimeLoop, type RuntimeLlm } from '#core/runtime-loop'

test('training rejects datasets marked as closed-book evaluation data', async (context) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-evaluation-only-dataset-'))
  let manager: TrainingManager | undefined
  context.after(async () => {
    await manager?.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  })
  const datasets = new DatasetStore(projectDir)
  const train = datasets.create({
    name: 'Private validation benchmark',
    storage: 'jsonl',
    path: 'datasets/private-validation.jsonl',
    tags: ['closed-book-eval'],
    scoringPrompt: '',
  })
  const testDataset = datasets.create({
    name: 'Held out fixture',
    storage: 'jsonl',
    path: 'datasets/held-out.jsonl',
    tags: [],
    scoringPrompt: '',
  })
  manager = new TrainingManager(projectDir, undefined as unknown as ExperimentManager)
  assert.throws(() => manager.create({
    trainDatasetId: train.id,
    testDatasetId: testDataset.id,
  }), /evaluation-only and cannot be used for training/)
})

test('interrupted experiments retain completed cases and requeue only the active case', (context) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-experiment-resume-'))
  const store = new ExperimentStore(projectDir)
  context.after(() => {
    store.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  })
  const createdAt = '2026-09-20T00:00:00.000Z'
  store.createRun({
    id: 'resume-run', name: 'resume fixture', createdAt, totalCases: 2,
    dataset: { id: 'dataset', name: 'dataset', version: 1, contentHash: 'content', cohortHash: 'cohort', scoringPromptHash: 'prompt', samples: 2 },
    scoringPrompt: '',
    project: { commitSha: 'commit', shortSha: 'commit', treeSha: 'tree', branch: 'main' },
    model: { provider: 'test', protocol: 'responses', model: 'test', baseUrl: 'http://127.0.0.1' },
    evaluator: { type: 'llm' },
    config: { concurrency: 1, repetitions: 1, timeoutMs: 1_000, keepWorkspaces: false, sampleIds: ['one', 'two'] },
  }, [
    { id: 'case-one', runId: 'resume-run', sampleId: 'one', repetition: 1, ordinal: 0, question: 'one', thinking: '', expectedAnswer: 'one', expectedTools: [], metadata: {}, createdAt },
    { id: 'case-two', runId: 'resume-run', sampleId: 'two', repetition: 1, ordinal: 1, question: 'two', thinking: '', expectedAnswer: 'two', expectedTools: [], metadata: {}, createdAt },
  ])
  store.startRun('resume-run', createdAt)
  store.startCase('case-one', createdAt)
  store.completeCase('case-one', {
    status: 'passed', actualAnswer: 'one', score: 1, passed: true, toolStatus: 'none', actualTools: [], toolCalls: [],
    usage: EMPTY_EXPERIMENT_METRICS, agentUsage: EMPTY_EXPERIMENT_METRICS, scoringUsage: EMPTY_EXPERIMENT_METRICS,
    latencyMs: 1, completedAt: createdAt,
  })
  store.startCase('case-two', createdAt)

  const resumed = store.resumeRun('resume-run')

  assert.equal(resumed.status, 'queued')
  assert.equal(resumed.progress.completed, 1)
  assert.deepEqual(store.listCases('resume-run', { limit: 2 }).items.map((item) => item.status), ['passed', 'queued'])
  assert.deepEqual(store.runnableCases('resume-run').map((item) => item.id), ['case-two'])
})

test('correction overrides resolve plugin variables and retain scope and lock guards', async (context) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-plugin-correction-'))
  initializeProjectDirectory(projectDir)
  const resources = new ProjectResources(projectDir)
  resources.saveSettings({ ...resources.readSettings(), plugins: [
    { id: 'correction', path: 'plugins/correction', enabled: true },
  ] })
  const dir = path.join(projectDir, 'plugins', 'correction')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'capybara.plugin.json'), JSON.stringify({
    schemaVersion: 1, id: 'correction', name: 'Correction', version: '1.0.0',
    description: 'Correction fixture', resources: { variables: 'variables.json' },
  }))
  fs.writeFileSync(path.join(dir, 'variables.json'), JSON.stringify({ version: 1, variables: [
    { key: 'repair_context', type: 'text', value: '', scope: 'session', readonly: false, required: false },
    { key: 'locked_context', type: 'text', value: '', scope: 'session', readonly: true, required: false },
    { key: 'shared_context', type: 'text', value: '', scope: 'project', readonly: false, required: false },
  ] }))
  const manager = new TrainingManager(projectDir, undefined as unknown as ExperimentManager)
  context.after(async () => { await manager.close(); fs.rmSync(projectDir, { recursive: true, force: true }) })
  const validate = (overrides: Record<string, string>) => (manager as unknown as {
    assertCorrectionOverrides(value: Record<string, string>): void
  }).assertCorrectionOverrides(overrides)
  assert.doesNotThrow(() => validate({ repair_context: 'Change method' }))
  assert.throws(() => validate({ locked_context: 'x' }), /read-only/)
  assert.throws(() => validate({ shared_context: 'x' }), /session-scoped/)
  assert.throws(() => validate({ missing_context: 'x' }), /not found/)
  const loop = new RuntimeLoop({ projectDir, llm: llm(), initialVariableOverrides: { repair_context: 'Use an alternate evidence source' } })
  try {
    assert.match(JSON.stringify(loop.getSnapshot(0).variables), /Use an alternate evidence source/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'variables.json'), 'utf8')).variables[0].value, '')
  } finally { loop.close() }
})

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
    if (training.case.expectedAnswer || training.case.thinking || training.case.expectedTools.length) {
      throw new Error("experience Hook received hidden expected-case fields");
    }
    if (training.evaluation.reference || training.evaluation.details || Object.keys(training.evaluation.metrics).length) {
      throw new Error("experience Hook received hidden evaluator evidence");
    }
    const before = variables.builtin.prompts.agent_identity;
    return { experiences: [{
      summary: "Persist a replayed rule",
      rationale: "Integration test with " + training.case.toolCalls.length + " observable tool calls",
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
  schedule: { priority: 1, timeoutMs: 500, onError: "retry" },
  permissions: { llm: "project" },
  async run({ llm }) {
    await llm.responses.create({ input: "learning-hook-probe" });
    return { experiences: [] };
  },
});
`

const ITERATIVE_CORRECTION_HOOK = `import { defineHook } from "@capybara-agent/sdk";

export default defineHook({
  name: "iterative-correction",
  description: "Produces a new session-only strategy for each failed clean replay.",
  enabled: true,
  checkpoint: "after_evaluation",
  trigger({ training }) {
    return training?.phase === "training" && training.evaluation.passed === false;
  },
  schedule: { priority: 100, timeoutMs: 2000, onError: "continue" },
  permissions: { variables: "patch" },
  run({ training }) {
    if (training.case.expectedAnswer || training.case.thinking || training.case.expectedTools.length) {
      throw new Error("correction Hook received hidden expected-case fields");
    }
    if (training.evaluation.reference || training.evaluation.details || Object.keys(training.evaluation.metrics).length) {
      throw new Error("correction Hook received hidden evaluator evidence");
    }
    if (!training.failureEvidence || training.failureEvidence.outcome !== "incorrect") {
      throw new Error("correction Hook did not receive sanitized failure evidence");
    }
    if (training.failureEvidence.actualAnswer !== training.case.actualAnswer) {
      throw new Error("correction Hook received inconsistent observable evidence");
    }
    if (!training.case.transcript?.some((message) => message.role === "assistant" && message.content)) {
      throw new Error("correction Hook did not receive the actor's observable execution transcript");
    }
    if (training.correctionAttempts?.some((attempt) => ![
      "The clean correction attempt passed.",
      "The clean correction attempt was marked incorrect.",
    ].includes(attempt.rationale))) {
      throw new Error("correction Hook received a prior evaluator rationale");
    }
    const ordinal = (training.correctionAttempts?.length ?? 0) + 1;
    return { correction: {
      summary: "Correction attempt " + ordinal,
      strategy: "Use clean strategy " + ordinal,
      variableOverrides: { correction_context: "attempt-" + ordinal },
    } };
  },
});
`

const CORRECTION_EXTRACTOR_HOOK = `import { defineHook } from "@capybara-agent/sdk";

export default defineHook({
  name: "correction-extractor",
  description: "Extracts learning only from a successful corrected trajectory.",
  enabled: true,
  checkpoint: "after_evaluation",
  trigger({ training }) {
    return training?.phase === "training" && training.evaluation.passed === true;
  },
  schedule: { priority: 50, timeoutMs: 2000, onError: "continue" },
  permissions: { variables: "patch" },
  run({ variables, training }) {
    const before = variables.builtin.prompts.agent_identity;
    return { experiences: [{
      summary: "Learn from corrected execution",
      rationale: "Successful trajectory after " + (training.correctionAttempts?.length ?? 0) + " corrections",
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

const REVISING_ADMISSION_HOOK = `import { defineHook } from "@capybara-agent/sdk";

export default defineHook({
  name: "revising-admission",
  description: "Revises a replayed candidate once, then promotes only a passing replay.",
  enabled: true,
  checkpoint: "after_replay",
  trigger({ training }) { return Boolean(training?.candidate); },
  schedule: { priority: 100, timeoutMs: 2000, onError: "continue" },
  permissions: { variables: "patch" },
  run({ training }) {
    if (training.case.expectedAnswer || training.case.thinking || training.case.expectedTools.length) {
      throw new Error("admission Hook received hidden expected-case fields");
    }
    if (training.evaluation.reference || training.evaluation.details || Object.keys(training.evaluation.metrics).length) {
      throw new Error("admission Hook received hidden evaluator evidence");
    }
    const patch = training.candidate.patches[0];
    if (!patch.unifiedDiff.includes("revised")) {
      return { admission: {
        verdict: "revise",
        reasons: ["Require the replayed rule to record its admission revision."],
        revisedCandidate: {
          summary: "Revised corrected learning",
          rationale: "The first passing candidate needs an auditable revision.",
          patches: [{
            variableName: patch.variableName,
            baseHash: patch.baseHash,
            unifiedDiff: patch.unifiedDiff.replace("+learned replay rule", "+learned replay rule revised"),
          }],
          lifecycle: {
            stage: "project_experience",
            level: 2,
            contextBudgetTokens: 16384,
            requiredCleanReplays: 2,
            entryIds: training.candidate.entryIds,
          },
        },
        transition: {
          promotionId: training.candidate.id + ":l2:" + (training.candidate.revision + 1),
          expectedStage: training.candidate.stage,
          expectedRevision: training.candidate.revision,
          expectedContentHash: training.candidate.contentHash,
          targetStage: "project_experience",
          targetLevel: 2,
          contextBudgetTokens: 16384,
        },
      } };
    }
    return { admission: {
      verdict: training.evaluation.passed ? "promote" : "retry_correction",
      reasons: [training.evaluation.passed ? "Revised candidate passed replay and is ready for promotion." : "Replay still failed."],
      ...(training.evaluation.passed ? { revisedCandidate: {
        summary: "Promoted corrected learning",
        rationale: "The revised candidate passed its final clean replay.",
        patches: [{
          variableName: patch.variableName,
          baseHash: patch.baseHash,
          unifiedDiff: patch.unifiedDiff.replace("+learned replay rule revised", "+learned replay rule revised stable"),
        }],
        lifecycle: {
          stage: "plugin_stable",
          level: 3,
          contextBudgetTokens: 8192,
          requiredCleanReplays: 2,
          entryIds: training.candidate.entryIds,
        },
      } } : {}),
      ...(training.evaluation.passed ? { transition: {
        promotionId: training.candidate.id + ":l3:" + (training.candidate.revision + 1),
        expectedStage: training.candidate.stage,
        expectedRevision: training.candidate.revision,
        expectedContentHash: training.candidate.contentHash,
        targetStage: "plugin_stable",
        targetLevel: 3,
        contextBudgetTokens: 8192,
      } } : {}),
    } };
  },
});
`

function configureCorrectionFixture(projectDir: string): void {
  const resources = new ProjectResources(projectDir)
  const current = resources.readSystemVariables()
  resources.saveSystemVariables({
    ...current,
    variables: [
      ...current.variables.map((variable) => variable.key === 'agent_identity'
        ? { ...variable, scope: 'project' as const }
        : variable),
      {
        key: 'correction_context',
        type: 'text',
        label: 'Correction context',
        description: 'Session-only correction strategy used by clean training replays.',
        value: '',
        required: false,
        readonly: false,
        show_in_status: false,
        scope: 'session',
        source: 'project',
      },
    ],
  })
  fs.appendFileSync(path.join(projectDir, 'main.j2'), '\n{{ builtin.prompts.correction_context }}\n')
  fs.mkdirSync(path.join(projectDir, 'training-hooks'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'training-hooks', 'iterative-correction.ts'), ITERATIVE_CORRECTION_HOOK)
  fs.writeFileSync(path.join(projectDir, 'training-hooks', 'correction-extractor.ts'), CORRECTION_EXTRACTOR_HOOK)
  fs.writeFileSync(path.join(projectDir, 'training-hooks', 'revising-admission.ts'), REVISING_ADMISSION_HOOK)
  fs.mkdirSync(path.join(projectDir, 'experiments'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.capybara', 'experiment-adapter.json'), `${JSON.stringify({
    version: 1,
    runner: { type: 'stdio', entry: 'experiments/correction-adapter.mjs' },
    phases: ['evaluate'],
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(projectDir, 'experiments', 'correction-adapter.mjs'), [
    "let input = '';",
    'for await (const chunk of process.stdin) input += chunk;',
    'const request = JSON.parse(input);',
    "const passed = request.payload.actual.answer === 'done';",
    "process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { score: passed ? 1 : 0, passed, rationale: passed ? 'passed' : 'wrong answer', metrics: {} } }));",
    '',
  ].join('\n'))
}

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
  fs.mkdirSync(path.join(projectDir, 'training-hooks'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'training-hooks', 'experience-extractor.ts'), EXPERIENCE_HOOK)
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
    assert.equal(training.experiences(created.id)[0]?.requiredCleanReplays, 1,
      'legacy extractors without lifecycle metadata retain one-replay publication')
    assert.match(String(resources.readSystemVariables().variables.find((item) => item.key === 'agent_identity')?.value ?? ''), /learned replay rule/)
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
    assert.match(training.experiences(created.id)[0]?.rationale ?? '', /observable tool calls/)

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
    const learningEventsBeforeTest = training.analysis(created.id).events.filter((event) =>
      event.type.startsWith('correction.')
      || event.type.startsWith('admission.')
      || event.type.startsWith('experience.')).length
    training.startTest(created.id)
    const completed = await waitFor(training, created.id, ['completed', 'failed'])
    assert.equal(completed.status, 'completed', completed.failure?.message ?? 'held-out test did not complete')
    assert.deepEqual(completed.progress.testing, { total: 1, completed: 1 })
    const heldOutAfterTest = training.cases(created.id).find((item) => item.phase === 'testing')
    assert.equal(heldOutAfterTest?.reference.status, 'available')
    assert.equal(heldOutAfterTest?.reference.kind, 'text')
    assert.equal(heldOutAfterTest?.expectedAnswer, '')
    assert.equal(training.experiences(created.id).length, 1, 'testing must not run training Hooks')
    assert.equal(training.analysis(created.id).events.filter((event) =>
      event.type.startsWith('correction.')
      || event.type.startsWith('admission.')
      || event.type.startsWith('experience.')).length, learningEventsBeforeTest,
    'testing must not run correction, admission, extraction, or promotion Hooks')
    assert.match(training.variables(created.id).items.find((item) => item.name === 'agent_identity')?.snapshotValue ?? '', /learned replay rule/)
    assert.match(String(resources.readSystemVariables().variables.find((item) => item.key === 'agent_identity')?.value ?? ''), /learned replay rule/)
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
    assert.equal(training.analysis(snapshotEvaluation.id).events.some((event) =>
      event.type.startsWith('correction.')
      || event.type.startsWith('admission.')
      || event.type.startsWith('experience.')), false,
    'evaluation-only runs must not produce learning lifecycle events')
    training.startTest(repeatedEvaluation.id)
    const repeatedSnapshot = await waitFor(training, repeatedEvaluation.id, ['completed', 'failed'])
    assert.equal(repeatedSnapshot.status, 'completed', repeatedSnapshot.failure?.message ?? 'repeated snapshot evaluation did not complete')
    assert.equal(repeatedSnapshot.snapshotId, snapshot.id)
    await assert.rejects(() => training.promote(snapshotEvaluation.id), /evaluation-only runs cannot promote/)
    const promoted = await training.promote(created.id)
    assert.match(promoted.variables.agent_identity ?? '', /learned replay rule/)
    assert.match(String(resources.readSystemVariables().variables.find((item) => item.key === 'agent_identity')?.value ?? ''), /learned replay rule/)
    const projectInherited = training.create({
      name: 'Project-published baseline',
      trainDatasetId: train.id,
      testDatasetId: heldOut.id,
      trainLimit: 1,
      testLimit: 1,
      learningMode: 'auto',
      reviewScope: 'failed',
      pauseOnFailure: false,
      experienceExtractorHook: { hookId: 'experience-extractor', parameters: {} },
      timeoutMs: 10_000,
    })
    assert.equal(projectInherited.config.variableSource, 'project')
    assert.match(training.store.baselineVariables(projectInherited.id).agent_identity ?? '', /learned replay rule/)
    training.cancel(projectInherited.id)
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

test('official state references hydrate before training Hooks without changing scores', async () => {
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
    const ready = await waitFor(training, run.id, ['ready_to_freeze', 'blocked', 'failed'])
    assert.equal(ready.status, 'blocked', ready.failure?.message ?? 'training did not finish')
    const before = training.cases(run.id).find((item) => item.phase === 'training')
    assert.equal(before?.score, 0)
    assert.equal(before?.reference.status, 'available')
    assert.equal(before?.reference.kind, 'state')
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

test('training accepts a failure signal without a reference and marks a case unresolved when no correction Hook exists', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-training-no-reference-'))
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
    "process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { score: 0, passed: false, rationale: 'failed without reference', metrics: {} } }));",
    '',
  ].join('\n'))
  const datasets = new DatasetStore(projectDir)
  const train = datasets.create({ name: 'train', storage: 'jsonl', path: 'datasets/train.jsonl', tags: ['train'], scoringPrompt: '' })
  const heldOut = datasets.create({ name: 'test', storage: 'jsonl', path: 'datasets/test.jsonl', tags: ['test'], scoringPrompt: '' })
  datasets.createRecord(train.id, { question: 'state task without reference', thinking: '', answer: '' })
  datasets.createRecord(heldOut.id, { question: 'held-out', thinking: '', answer: '' })
  git(projectDir, 'init', '--initial-branch=main')
  git(projectDir, 'config', 'user.name', 'Capybara Test')
  git(projectDir, 'config', 'user.email', 'capybara@example.invalid')
  git(projectDir, 'add', '.')
  git(projectDir, 'commit', '-m', 'fixture')
  const experiments = new ExperimentManager(projectDir, { llm: llm(), runtimeLoop: { stepDelayMs: 0, streamDelayMs: 0 } })
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
    const completed = await waitFor(training, created.id, ['ready_to_freeze', 'blocked', 'failed'])
    assert.equal(completed.status, 'blocked', completed.failure?.message ?? 'training did not finish')
    assert.equal(training.cases(created.id).find((item) => item.phase === 'training')?.status, 'unresolved')
    assert.equal(training.experiences(created.id).length, 0)
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
    assert.match(failed.failure?.message ?? '', /Hook exceeded 500 ms/)
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

for (const withReference of [true, false]) {
test(`automatic training corrects in clean environments and applies replay-admitted memory (${withReference ? 'hidden reference' : 'signal only, no answer'})`, async () => {
  const successAttempt = withReference ? 2 : 5
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-training-correction-chain-'))
  initializeProjectDirectory(projectDir)
  configureCorrectionFixture(projectDir)
  const datasets = new DatasetStore(projectDir)
  const train = datasets.create({ name: 'train', storage: 'jsonl', path: 'datasets/train.jsonl', tags: ['train'], scoringPrompt: '' })
  const heldOut = datasets.create({ name: 'test', storage: 'jsonl', path: 'datasets/test.jsonl', tags: ['test'], scoringPrompt: '' })
  datasets.createRecord(train.id, { question: 'correct this state task', thinking: '', answer: withReference ? 'done' : '' })
  datasets.createRecord(heldOut.id, { question: 'held-out', thinking: '', answer: withReference ? 'done' : '' })
  git(projectDir, 'init', '--initial-branch=main')
  git(projectDir, 'config', 'user.name', 'Capybara Test')
  git(projectDir, 'config', 'user.email', 'capybara@example.invalid')
  git(projectDir, 'add', '.')
  git(projectDir, 'commit', '-m', 'fixture')

  const correctionLlm: RuntimeLlm = {
    async chat(request) {
      const prompt = request.messages.map((message) => message.content).join('\n')
      const passed = prompt.includes(`attempt-${successAttempt}`) || prompt.includes('learned replay rule')
      return {
        provider: 'custom',
        model: 'correction-test-model',
        text: JSON.stringify({ status: 'completed', content: passed ? 'done' : 'wrong' }),
        usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
        raw: {},
      }
    },
    getConfig: () => ({
      provider: 'custom', protocol: 'responses', model: 'correction-test-model',
      baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1_000, maxRetries: 0,
    }),
  }
  const experiments = new ExperimentManager(projectDir, { llm: correctionLlm, runtimeLoop: { stepDelayMs: 0, streamDelayMs: 0 } })
  const training = new TrainingManager(projectDir, experiments)
  try {
    const created = training.create({
      trainDatasetId: train.id,
      testDatasetId: heldOut.id,
      trainLimit: 1,
      testLimit: 1,
      learningMode: 'auto',
      reviewScope: 'failed',
      pauseOnFailure: true,
      correctionHook: { hookId: 'iterative-correction', parameters: {} },
      experienceExtractorHook: { hookId: 'correction-extractor', parameters: {} },
      maxCorrectionAttempts: 5,
      maxCorrectionTokens: 10_000,
      maxCorrectionWallTimeMs: 60_000,
      maxReplayRevisions: 2,
      timeoutMs: 10_000,
    })
    const completed = await waitFor(training, created.id, ['ready_to_freeze', 'failed', 'paused_failure'])
    assert.equal(completed.status, 'ready_to_freeze', completed.failure?.message ?? completed.pauseReason ?? 'training did not finish')
    const source = training.cases(created.id).find((item) => item.phase === 'training')
    assert.equal(source?.status, 'completed')
    assert.equal(source?.passed, false, 'the immutable source evaluation remains visible')
    if (!withReference) {
      assert.equal(source?.expectedAnswer, '')
      assert.equal(source?.evaluation?.reference, undefined)
    }
    const attempts = training.correctionAttempts(created.id, source?.id)
    assert.equal(attempts.length, successAttempt)
    assert.deepEqual(attempts.map((attempt) => attempt.variableOverrides.correction_context),
      Array.from({ length: successAttempt }, (_, index) => `attempt-${index + 1}`))
    assert.deepEqual(attempts.map((attempt) => attempt.passed),
      Array.from({ length: successAttempt }, (_, index) => index === successAttempt - 1))
    assert.equal(attempts.at(-1)?.terminalReason, 'succeeded')
    assert.equal(new Set(attempts.map((attempt) => attempt.experimentRunId)).size, successAttempt)
    assert.equal(attempts.every((attempt) => attempt.experimentRunId !== source?.experimentRunId), true)
    const candidates = training.experiences(created.id)
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0]?.status, 'applied')
    assert.equal(candidates[0]?.replayPassed, true)
    assert.equal(candidates[0]?.stage, 'plugin_stable')
    assert.equal(candidates[0]?.level, 3)
    assert.equal(candidates[0]?.contextBudgetTokens, 8192)
    assert.equal(candidates[0]?.replayCount, 2)
    assert.equal(candidates[0]?.revision, 3)
    assert.equal(candidates[0]?.parentRevision, 2)
    assert.match(candidates[0]?.promotionId ?? '', /:l3:3$/u)
    assert.match(candidates[0]?.rationale ?? '', new RegExp(`after ${successAttempt} corrections`))
    const transitionEventsBeforeDuplicate = training.analysis(created.id).events
      .filter((event) => event.type === 'experience.transitioned').length
    const duplicate = training.store.transitionExperience(
      candidates[0]!.id,
      candidates[0]!.patches,
      candidates[0]!,
      { stage: 'project_experience', revision: 2, contentHash: 'superseded-by-idempotency-key' },
      true,
    )
    assert.equal(duplicate.revision, 3)
    assert.equal(training.analysis(created.id).events
      .filter((event) => event.type === 'experience.transitioned').length, transitionEventsBeforeDuplicate,
    'repeating the same promotion must not emit another transition')
    assert.throws(() => training.store.transitionExperience(
      candidates[0]!.id,
      candidates[0]!.patches,
      { ...candidates[0]!, promotionId: `${candidates[0]!.id}:stale-command` },
      { stage: 'candidate', revision: 1, contentHash: 'stale-content' },
      true,
    ), /experience changed since promotion was proposed/)
    assert.match(training.store.runVariables(created.id).agent_identity ?? '', /learned replay rule revised stable/)
    assert.match(String(new ProjectResources(projectDir).readSystemVariables().variables
      .find((item) => item.key === 'agent_identity')?.value ?? ''), /learned replay rule revised stable/)
    const admissionEvents = training.analysis(created.id).events.filter((event) => event.type === 'admission.decided')
    assert.deepEqual(admissionEvents.map((event) => (event.payload as { verdict: string }).verdict), ['revise', 'promote'])
    const transitionEvents = training.analysis(created.id).events.filter((event) => event.type === 'experience.transitioned')
    assert.deepEqual(transitionEvents.map((event) => (event.payload as { to: { stage: string } }).to.stage),
      ['project_experience', 'plugin_stable'])
    assert.equal(training.analysis(created.id).events.some((event) => event.type === 'experience.published'), true)
    const nextRun = training.create({
      trainDatasetId: train.id,
      testDatasetId: heldOut.id,
      trainLimit: 1,
      testLimit: 1,
      learningMode: 'auto',
      reviewScope: 'failed',
      pauseOnFailure: false,
      correctionHook: { hookId: 'iterative-correction', parameters: {} },
      experienceExtractorHook: { hookId: 'correction-extractor', parameters: {} },
      maxCorrectionAttempts: 5,
      maxCorrectionTokens: 10_000,
      maxCorrectionWallTimeMs: 60_000,
      maxReplayRevisions: 2,
      timeoutMs: 10_000,
    })
    assert.equal(nextRun.config.variableSource, 'project')
    assert.match(training.store.baselineVariables(nextRun.id).agent_identity ?? '', /learned replay rule revised stable/)
    training.cancel(nextRun.id)
    assert.equal(training.analysis(created.id).correctionAttempts.length, successAttempt)
  } finally {
    await training.close()
    await experiments.close()
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
}

test('automatic training exhausts correction limits without human review or long-term memory', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-training-correction-exhaustion-'))
  initializeProjectDirectory(projectDir)
  configureCorrectionFixture(projectDir)
  const datasets = new DatasetStore(projectDir)
  const train = datasets.create({ name: 'train', storage: 'jsonl', path: 'datasets/train.jsonl', tags: ['train'], scoringPrompt: '' })
  const heldOut = datasets.create({ name: 'test', storage: 'jsonl', path: 'datasets/test.jsonl', tags: ['test'], scoringPrompt: '' })
  datasets.createRecord(train.id, { question: 'unresolvable state task', thinking: '', answer: 'done' })
  datasets.createRecord(heldOut.id, { question: 'held-out', thinking: '', answer: 'done' })
  git(projectDir, 'init', '--initial-branch=main')
  git(projectDir, 'config', 'user.name', 'Capybara Test')
  git(projectDir, 'config', 'user.email', 'capybara@example.invalid')
  git(projectDir, 'add', '.')
  git(projectDir, 'commit', '-m', 'fixture')

  let actorCalls = 0
  const failedLlm: RuntimeLlm = {
    async chat() {
      actorCalls += 1
      return {
        provider: 'custom', model: 'exhaustion-test-model',
        text: JSON.stringify({ status: 'completed', content: 'wrong' }),
        usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 }, raw: {},
      }
    },
    getConfig: () => ({
      provider: 'custom', protocol: 'responses', model: 'exhaustion-test-model',
      baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1_000, maxRetries: 0,
    }),
  }
  const experiments = new ExperimentManager(projectDir, { llm: failedLlm, runtimeLoop: { stepDelayMs: 0, streamDelayMs: 0 } })
  const training = new TrainingManager(projectDir, experiments)
  try {
    const created = training.create({
      trainDatasetId: train.id,
      testDatasetId: heldOut.id,
      trainLimit: 1,
      testLimit: 1,
      learningMode: 'auto',
      reviewScope: 'all',
      pauseOnFailure: true,
      correctionHook: { hookId: 'iterative-correction', parameters: {} },
      experienceExtractorHook: { hookId: 'correction-extractor', parameters: {} },
      maxCorrectionTokens: 10_000,
      maxCorrectionWallTimeMs: 60_000,
      maxReplayRevisions: 1,
      timeoutMs: 10_000,
    })
    const completed = await waitFor(training, created.id, ['ready_to_freeze', 'blocked', 'failed', 'waiting_review', 'paused_failure'])
    assert.equal(completed.status, 'blocked', completed.failure?.message ?? completed.pauseReason ?? 'training did not finish')
    const source = training.cases(created.id).find((item) => item.phase === 'training')
    assert.equal(source?.status, 'unresolved')
    const attempts = training.correctionAttempts(created.id, source?.id)
    assert.equal(created.config.maxCorrectionAttempts, 5)
    assert.equal(attempts.length, 5)
    assert.equal(actorCalls, 6, 'one initial execution plus at most five immediate correction retries')
    assert.equal(attempts[4]?.terminalReason, 'max_attempts')
    assert.equal(training.experiences(created.id).length, 0)
    assert.equal(training.analysis(created.id).experiences.generated, 0)
    assert.equal(training.analysis(created.id).events.some((event) => event.type === 'correction.unresolved'), true)
  } finally {
    await training.close()
    await experiments.close()
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('automatic training resolves admission Hook conflicts without waiting for human review', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-training-auto-conflict-'))
  initializeProjectDirectory(projectDir)
  configureCorrectionFixture(projectDir)
  const admissionPath = path.join(projectDir, 'training-hooks', 'revising-admission.ts')
  fs.writeFileSync(admissionPath, fs.readFileSync(admissionPath, 'utf8').replace(
    'run({ training }) {',
    'run({ training }) { throw new Error("admission infrastructure failed");',
  ))
  const datasets = new DatasetStore(projectDir)
  const train = datasets.create({ name: 'train', storage: 'jsonl', path: 'datasets/train.jsonl', tags: ['train'], scoringPrompt: '' })
  const heldOut = datasets.create({ name: 'test', storage: 'jsonl', path: 'datasets/test.jsonl', tags: ['test'], scoringPrompt: '' })
  datasets.createRecord(train.id, { question: 'passing source with admission conflict', thinking: '', answer: 'done' })
  datasets.createRecord(heldOut.id, { question: 'held-out', thinking: '', answer: 'done' })
  git(projectDir, 'init', '--initial-branch=main')
  git(projectDir, 'config', 'user.name', 'Capybara Test')
  git(projectDir, 'config', 'user.email', 'capybara@example.invalid')
  git(projectDir, 'add', '.')
  git(projectDir, 'commit', '-m', 'fixture')
  const llm: RuntimeLlm = {
    async chat() {
      return {
        provider: 'custom', model: 'auto-conflict-model',
        text: JSON.stringify({ status: 'completed', content: 'done' }),
        usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 }, raw: {},
      }
    },
    getConfig: () => ({
      provider: 'custom', protocol: 'responses', model: 'auto-conflict-model',
      baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1_000, maxRetries: 0,
    }),
  }
  const experiments = new ExperimentManager(projectDir, { llm, runtimeLoop: { stepDelayMs: 0, streamDelayMs: 0 } })
  const training = new TrainingManager(projectDir, experiments)
  try {
    const created = training.create({
      trainDatasetId: train.id, testDatasetId: heldOut.id, trainLimit: 1, testLimit: 1,
      learningMode: 'auto', reviewScope: 'all', pauseOnFailure: true,
      correctionHook: { hookId: 'iterative-correction', parameters: {} },
      experienceExtractorHook: { hookId: 'correction-extractor', parameters: {} },
      timeoutMs: 10_000,
    })
    const completed = await waitFor(training, created.id, ['ready_to_freeze', 'blocked', 'failed', 'waiting_review'])
    assert.equal(completed.status, 'ready_to_freeze', completed.failure?.message ?? completed.pauseReason ?? 'training did not finish')
    assert.equal(training.cases(created.id).find((item) => item.phase === 'training')?.status, 'completed')
    assert.deepEqual(training.experiences(created.id).map((item) => item.status), ['rejected'])
    assert.deepEqual(training.experiences(created.id).map((item) => ({ stage: item.stage, level: item.level })), [
      { stage: 'candidate', level: 1 },
    ])
    assert.doesNotMatch(training.store.runVariables(created.id).agent_identity ?? '', /learned replay rule/,
      'a Level 1 candidate must never be published after an admission failure')
  } finally {
    await training.close()
    await experiments.close()
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('correction token budget stops before a clean execution after the Hook exhausts it', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-training-correction-budget-'))
  initializeProjectDirectory(projectDir)
  configureCorrectionFixture(projectDir)
  const correctionPath = path.join(projectDir, 'training-hooks', 'iterative-correction.ts')
  fs.writeFileSync(correctionPath, fs.readFileSync(correctionPath, 'utf8')
    .replace('permissions: { variables: "patch" }', 'permissions: { llm: "project", variables: "patch" }')
    .replace('run({ training }) {', 'async run({ llm, training }) { await llm.responses.create({ input: "diagnose" });'))
  const datasets = new DatasetStore(projectDir)
  const train = datasets.create({ name: 'train', storage: 'jsonl', path: 'datasets/train.jsonl', tags: ['train'], scoringPrompt: '' })
  const heldOut = datasets.create({ name: 'test', storage: 'jsonl', path: 'datasets/test.jsonl', tags: ['test'], scoringPrompt: '' })
  datasets.createRecord(train.id, { question: 'budgeted failed source', thinking: '', answer: 'done' })
  datasets.createRecord(heldOut.id, { question: 'held-out', thinking: '', answer: 'done' })
  git(projectDir, 'init', '--initial-branch=main')
  git(projectDir, 'config', 'user.name', 'Capybara Test')
  git(projectDir, 'config', 'user.email', 'capybara@example.invalid')
  git(projectDir, 'add', '.')
  git(projectDir, 'commit', '-m', 'fixture')
  let llmCalls = 0
  const llm: RuntimeLlm = {
    async chat() {
      llmCalls += 1
      return {
        provider: 'custom', model: 'correction-budget-model',
        text: JSON.stringify({ status: 'completed', content: 'wrong' }),
        usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 }, raw: {},
      }
    },
    getConfig: () => ({
      provider: 'custom', protocol: 'responses', model: 'correction-budget-model',
      baseUrl: 'http://127.0.0.1/unused', timeoutMs: 1_000, maxRetries: 0,
    }),
  }
  const experiments = new ExperimentManager(projectDir, { llm, runtimeLoop: { stepDelayMs: 0, streamDelayMs: 0 } })
  const training = new TrainingManager(projectDir, experiments)
  try {
    const created = training.create({
      trainDatasetId: train.id, testDatasetId: heldOut.id, trainLimit: 1, testLimit: 1,
      learningMode: 'auto', reviewScope: 'failed', pauseOnFailure: true,
      correctionHook: { hookId: 'iterative-correction', parameters: {} },
      experienceExtractorHook: { hookId: 'correction-extractor', parameters: {} },
      maxCorrectionAttempts: 4, maxCorrectionTokens: 10, timeoutMs: 10_000,
    })
    const completed = await waitFor(training, created.id, ['ready_to_freeze', 'blocked', 'failed', 'waiting_review'])
    assert.equal(completed.status, 'blocked', completed.failure?.message ?? completed.pauseReason ?? 'training did not finish')
    const attempts = training.correctionAttempts(created.id)
    assert.equal(attempts.length, 1)
    assert.equal(attempts[0]?.terminalReason, 'max_tokens')
    assert.equal(attempts[0]?.experimentRunId, undefined)
    assert.equal(attempts[0]?.usage.totalTokens, 0)
    assert.equal(attempts[0]?.hookUsage.totalTokens, 12)
    assert.equal(llmCalls, 2, 'only the source execution and correction Hook may call the LLM')
  } finally {
    await training.close()
    await experiments.close()
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
