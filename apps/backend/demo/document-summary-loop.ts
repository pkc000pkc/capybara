import 'dotenv/config'

import path from 'node:path'

import { RuntimeLoop } from '#core/runtime-loop'
import type { ChannelEvent, ClientCommand } from '#protocol/runtime-protocol'

const workspaceDir = path.resolve(
  process.env.CAPYBARA_SUMMARY_WORKSPACE
    ?? 'D:\\gitlocals\\kanli8-human\\capybara_old',
)
const prompt = '查看D:\\gitlocals\\kanli8-human\\capybara_old\\docs 中的文件，看下该项目0.1.3版本开发了那些功能'
const loop = new RuntimeLoop({
  projectDir: path.resolve(process.env.CAPYBARA_PROJECT_DIR ?? 'test-project'),
  workspaceDir,
  streamDelayMs: 0,
  stepDelayMs: 0,
})
const counters = {
  deltas: 0,
  variableUpdates: 0,
  renderUpdates: 0,
  toolUpdates: 0,
  harnessUpdates: 0,
  toolCalls: 0,
}
let failure = ''
let usage: unknown

const completed = new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error('document summary loop timed out')),
    180_000,
  )
  loop.onEvent((event: ChannelEvent) => {
    if (event.type === 'tool.call.started') {
      counters.toolCalls += 1
      console.log(`\n[tool] ${event.payload.toolName}`, event.payload.arguments)
    } else if (event.type === 'tool.call.completed') {
      const result = event.payload.result as Record<string, unknown>
      console.log('[result]', result.path ?? result.loaded ?? result.total ?? 'ok')
    } else if (event.type === 'chat.assistant.delta') {
      counters.deltas += 1
      process.stdout.write(event.payload.delta)
    } else if (event.type === 'variables.updated') {
      counters.variableUpdates += 1
    } else if (event.type === 'render.result.updated') {
      counters.renderUpdates += 1
    } else if (event.type === 'runtime.tools.updated') {
      counters.toolUpdates += 1
    } else if (event.type === 'runtime.harnesses.updated') {
      counters.harnessUpdates += 1
    } else if (event.type === 'chat.assistant.failed') {
      failure = `${event.payload.code}: ${event.payload.message}`
    } else if (event.type === 'chat.assistant.completed') {
      usage = event.payload.usage
    } else if (event.type === 'run.state.changed' && event.payload.status === 'completed') {
      clearTimeout(timeout)
      resolve()
    } else if (event.type === 'run.state.changed' && event.payload.status === 'failed') {
      clearTimeout(timeout)
      reject(new Error(failure || 'runtime loop failed'))
    }
  })
})

const command: ClientCommand = {
  version: 1,
  kind: 'command',
  id: 'demo-document-summary',
  type: 'chat.message.send',
  sessionId: 'demo',
  timestamp: new Date().toISOString(),
  payload: {
    clientMessageId: 'demo-document-summary-message',
    content: [{ type: 'text', text: prompt }],
    autoStart: true,
  },
}

try {
  loop.validate(command)
  loop.execute(command, 1)
  await completed
  const snapshot = loop.getSnapshot(0)
  if (snapshot.run.status !== 'completed') throw new Error('loop did not complete')
  if (snapshot.tools.items.length === 0) throw new Error('no project tool was loaded')
  if (!snapshot.renderResult?.messages[0]?.content.includes(snapshot.tools.items[0]!.name)) {
    throw new Error('loaded tools were not rendered back into the LLM context')
  }
  const expectedHarnesses = new Set([
    'model-guidance:gpt-runtime',
    'filesystem-guidance:file-inspection',
    'document-analysis:version-summary',
  ])
  const activeHarnesses = snapshot.harnesses.items.filter((harness) => harness.status === 'active')
  for (const harnessId of expectedHarnesses) {
    if (!activeHarnesses.some((harness) => harness.id === harnessId)) {
      throw new Error(`expected harness was not active: ${harnessId}`)
    }
  }
  console.log('\n\n[runtime]', {
    status: snapshot.run.status,
    workspace: snapshot.variables.value.builtin.workspace_path,
    activeTools: snapshot.tools.items.map((tool) => tool.name),
    activeHarnesses: activeHarnesses.map((harness) => ({
      id: harness.id,
      bindings: harness.bindings.map((binding) => binding.source),
    })),
    usage,
    ...counters,
  })
} finally {
  loop.close()
}
