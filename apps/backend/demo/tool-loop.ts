import 'dotenv/config'

import { RuntimeLoop } from '#core/runtime-loop'
import type { ChannelEvent, ClientCommand } from '#protocol/runtime-protocol'

const loop = new RuntimeLoop({ streamDelayMs: 0, stepDelayMs: 0 })
const command: ClientCommand = {
  version: 1,
  kind: 'command',
  id: 'demo-tool-loop',
  type: 'chat.message.send',
  sessionId: 'demo',
  timestamp: new Date().toISOString(),
  payload: {
    clientMessageId: 'demo-user-message',
    content: [{
      type: 'text',
      text: 'Find and load the project file-reading capability, read .capybara/config.json, then report its max_tool_rounds value.',
    }],
    autoStart: true,
  },
}

const completed = new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('tool loop demo timed out')), 120_000)
  loop.onEvent((event: ChannelEvent) => {
    if (event.type === 'tool.call.started') {
      console.log('tool call', event.payload.toolName, event.payload.arguments)
    } else if (event.type === 'tool.call.completed') {
      console.log('tool result', event.payload.result)
    } else if (event.type === 'tool.call.failed') {
      console.error('tool error', event.payload.code, event.payload.message)
    } else if (event.type === 'chat.assistant.delta') {
      process.stdout.write(event.payload.delta)
    } else if (event.type === 'run.state.changed' && event.payload.status === 'completed') {
      clearTimeout(timeout)
      process.stdout.write('\n')
      resolve()
    } else if (event.type === 'run.state.changed' && event.payload.status === 'failed') {
      clearTimeout(timeout)
      reject(new Error('runtime loop failed'))
    }
  })
})

try {
  loop.validate(command)
  loop.execute(command, 1)
  await completed
} finally {
  loop.close()
}
