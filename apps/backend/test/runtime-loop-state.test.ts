import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  discardOrphanToolMessages,
  hasUnknownToolOutcome,
  interruptTimelineStep,
  MAX_RETAINED_CHECKPOINTS,
  retainRecentCheckpoints,
  RuntimeLoop,
} from '#core/runtime-loop'
import { CommandError, type ClientCommand, type TimelineStep } from '#protocol/runtime-protocol'

function copyRuntimeProject(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-runtime-state-'))
  const sourceProject = path.resolve(process.env.CAPYBARA_TEST_PROJECT_DIR ?? 'test-project')
  fs.cpSync(sourceProject, projectDir, {
    filter: (source) => {
      const relative = path.relative(sourceProject, source).replaceAll('\\', '/')
      return !relative.startsWith('.capybara/sessions.sqlite')
        && !relative.startsWith('.capybara/runtime')
        && relative !== '.capybara/secrets.json'
    },
    recursive: true,
  })
  return projectDir
}

function testLlm() {
  return {
    chat: async () => ({
      provider: 'custom' as const,
      model: 'state-test',
      text: JSON.stringify({ status: 'completed', content: 'done' }),
      raw: {},
    }),
    getConfig: () => ({
      provider: 'custom' as const,
      protocol: 'responses' as const,
      model: 'state-test',
      baseUrl: 'http://127.0.0.1/unused',
      timeoutMs: 1_000,
      maxRetries: 0,
    }),
  }
}

test('runtime persistence retains only the most recent checkpoint window', () => {
  const checkpoints = Array.from(
    { length: MAX_RETAINED_CHECKPOINTS + 7 },
    (_, index) => ({ id: `checkpoint-${index}` }),
  )

  const retained = retainRecentCheckpoints(checkpoints)

  assert.equal(retained.length, MAX_RETAINED_CHECKPOINTS)
  assert.equal(retained[0]?.id, 'checkpoint-7')
  assert.equal(retained.at(-1)?.id, `checkpoint-${checkpoints.length - 1}`)
  assert.notEqual(retained, checkpoints)
})

test('runtime persistence preserves a checkpoint array already within the window', () => {
  const checkpoints = [{ id: 'checkpoint-current' }]

  assert.equal(retainRecentCheckpoints(checkpoints), checkpoints)
})

test('runtime messages discard orphan tool outputs and preserve complete call pairs', () => {
  const messages = [
    { role: 'system' as const, content: 'system' },
    {
      role: 'assistant' as const,
      content: '',
      toolCalls: [{ id: 'call-kept', name: 'read_file', arguments: {} }],
    },
    { role: 'tool' as const, content: 'kept', toolCallId: 'call-kept' },
    { role: 'tool' as const, content: 'orphaned', toolCallId: 'call-missing' },
    { role: 'user' as const, content: 'continue' },
  ]

  assert.deepEqual(discardOrphanToolMessages(messages), [
    messages[0],
    messages[1],
    messages[2],
    messages[4],
  ])
})

test('runtime messages discard incomplete and partially completed tool call groups', () => {
  const messages = [
    { role: 'system' as const, content: 'system' },
    {
      role: 'assistant' as const,
      content: '',
      toolCalls: [{ id: 'call-missing', name: 'execute_workflow', arguments: {} }],
    },
    { role: 'user' as const, content: 'continue after failure' },
    {
      role: 'assistant' as const,
      content: '',
      toolCalls: [
        { id: 'call-partial-a', name: 'read_file', arguments: {} },
        { id: 'call-partial-b', name: 'read_file', arguments: {} },
      ],
    },
    { role: 'tool' as const, content: 'partial', toolCallId: 'call-partial-a' },
    { role: 'assistant' as const, content: 'usable response' },
  ]

  assert.deepEqual(discardOrphanToolMessages(messages), [
    messages[0],
    messages[2],
    messages[5],
  ])
})

test('runtime messages preserve complete multi-call groups in output order', () => {
  const messages = [
    {
      role: 'assistant' as const,
      content: '',
      toolCalls: [
        { id: 'call-a', name: 'read_file', arguments: {} },
        { id: 'call-b', name: 'list_directory', arguments: {} },
      ],
    },
    { role: 'tool' as const, content: 'b', toolCallId: 'call-b' },
    { role: 'tool' as const, content: 'a', toolCallId: 'call-a' },
  ]

  assert.deepEqual(discardOrphanToolMessages(messages), messages)
})

test('interrupted non-replayable tools retain an explicit unknown outcome', () => {
  const step: TimelineStep = {
    id: 'tool-step',
    index: 2,
    type: 'tool',
    status: 'running',
    summary: 'write evidence',
    detail: { replay: 'never', sideEffects: 'workspace-write' },
  }
  const interrupted = interruptTimelineStep(step, '2026-08-26T00:00:00.000Z')
  assert.equal(interrupted.status, 'interrupted')
  assert.equal(interrupted.detail?.unknownOutcome, true)
  assert.equal(interrupted.detail?.outcome, 'unknown')
  assert.equal(hasUnknownToolOutcome(interrupted), true)

  const safe = interruptTimelineStep({ ...step, detail: { replay: 'safe' } })
  assert.equal(hasUnknownToolOutcome(safe), false)
})

test('restored unknown tool outcomes block resume until side effects are confirmed', () => {
  const projectDir = copyRuntimeProject()
  let source: RuntimeLoop | undefined
  let restored: RuntimeLoop | undefined
  try {
    source = new RuntimeLoop({ projectDir, llm: testLlm(), stepDelayMs: 0, streamDelayMs: 0 })
    const state = source.exportState()
    source.close()
    source = undefined

    const toolStep: TimelineStep = {
      id: 'step-tool-unknown',
      index: 2,
      type: 'tool',
      status: 'running',
      summary: 'append research evidence',
      detail: { replay: 'confirm', sideEffects: 'workspace-write' },
    }
    state.snapshot.run = {
      ...state.snapshot.run,
      runId: 'run-unknown-tool',
      status: 'running',
      currentStep: toolStep.index,
      currentStepId: toolStep.id,
    }
    state.snapshot.timeline.steps[toolStep.index] = toolStep

    restored = new RuntimeLoop({
      projectDir,
      llm: testLlm(),
      initialState: state,
      stepDelayMs: 0,
      streamDelayMs: 0,
    })
    const snapshot = restored.getSnapshot(0)
    assert.equal(snapshot.run.status, 'interrupted')
    assert.equal(hasUnknownToolOutcome(snapshot.timeline.steps[toolStep.index]), true)

    const command = <T extends ClientCommand['type']>(
      type: T,
      payload: Extract<ClientCommand, { type: T }>['payload'],
    ) => ({
      version: 1 as const,
      kind: 'command' as const,
      id: `command-${type}`,
      type,
      sessionId: 'restored-session',
      timestamp: new Date().toISOString(),
      payload,
    }) as Extract<ClientCommand, { type: T }>

    assert.throws(
      () => restored?.validate(command('run.resume', {})),
      (error: unknown) => error instanceof CommandError && error.code === 'CONFIRMATION_REQUIRED',
    )
    assert.throws(
      () => restored?.validate(command('run.restartStep', { stepId: toolStep.id })),
      (error: unknown) => error instanceof CommandError && error.code === 'CONFIRMATION_REQUIRED',
    )
    assert.doesNotThrow(() => restored?.validate(command('run.restartStep', {
      stepId: toolStep.id,
      confirmSideEffects: true,
    })))
  } finally {
    restored?.close()
    source?.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('runtime pages artifact arrays and long variable values on demand', () => {
  const projectDir = copyRuntimeProject()
  const loop = new RuntimeLoop({ projectDir, llm: testLlm(), stepDelayMs: 0, streamDelayMs: 0 })
  const artifactId = 'artifact-test-pagination'
  const state = loop.exportState()
  const artifactValue = Array.from({ length: 5 }, (_, index) => ({ index, value: `item-${index}` }))
  const artifactMeta = {
    id: artifactId,
    kind: 'effective-messages' as const,
    label: 'Pagination fixture',
    contentType: 'application/json' as const,
    byteLength: JSON.stringify(artifactValue).length,
    hash: 'test-hash',
    preview: JSON.stringify(artifactValue),
    redacted: false,
    createdAt: new Date().toISOString(),
  }
  state.artifacts.push({ meta: artifactMeta, value: artifactValue })
  state.snapshot.artifacts.items.push(artifactMeta)
  state.snapshot.variables.value.context = {
    ...state.snapshot.variables.value.context,
    history_summary: 'abcdefghij',
  }
  loop.close()

  const restored = new RuntimeLoop({
    projectDir,
    llm: testLlm(),
    initialState: state,
    stepDelayMs: 0,
    streamDelayMs: 0,
  })
  const events: Array<{ type: string; payload: unknown }> = []
  const unsubscribe = restored.onEvent((event) => events.push(event))
  const command = <T extends ClientCommand['type']>(
    type: T,
    payload: Extract<ClientCommand, { type: T }>['payload'],
  ) => ({
    version: 1 as const,
    kind: 'command' as const,
    id: `command-${type}`,
    type,
    sessionId: 'pagination-session',
    timestamp: new Date().toISOString(),
    payload,
  }) as Extract<ClientCommand, { type: T }>

  try {
    const artifactCommand = command('runtime.artifact.page', {
      artifactId,
      page: 2,
      pageSize: 2,
    })
    restored.validate(artifactCommand)
    restored.execute(artifactCommand, 1)
    const artifactPage = events.at(-1)
    assert.equal(artifactPage?.type, 'runtime.artifact.page')
    assert.deepEqual((artifactPage?.payload as { value: unknown }).value, [
      { index: 2, value: 'item-2' },
      { index: 3, value: 'item-3' },
    ])
    assert.equal((artifactPage?.payload as { totalPages: number }).totalPages, 3)

    const variableCommand = command('runtime.variable.page', {
      path: '/context/history_summary',
      page: 2,
      pageSize: 4,
    })
    restored.validate(variableCommand)
    restored.execute(variableCommand, 2)
    const variablePage = events.at(-1)
    assert.equal(variablePage?.type, 'runtime.variable.page')
    assert.equal((variablePage?.payload as { value: string }).value, 'efgh')
    assert.equal((variablePage?.payload as { totalPages: number }).totalPages, 3)
    assert.equal((variablePage?.payload as { revision: number }).revision, restored.getSnapshot(0).variables.revision)
    assert.throws(
      () => restored.validate(command('runtime.variable.page', {
        path: '/context/missing',
        page: 1,
        pageSize: 4,
      })),
      (error: unknown) => error instanceof CommandError && error.code === 'NOT_FOUND',
    )
  } finally {
    unsubscribe()
    restored.close()
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})
