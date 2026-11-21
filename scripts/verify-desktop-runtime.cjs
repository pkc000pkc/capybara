const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createBackendRuntimeManager, loadBackendModules } = require('../apps/workbench/electron/backend-runtime-host.cjs')

function waitFor(events, predicate, timeoutMs = 90_000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      const found = events.find(predicate)
      if (found) return resolve(found)
      if (Date.now() - started >= timeoutMs) return reject(new Error('timed out waiting for runtime event'))
      setTimeout(poll, 100)
    }
    poll()
  })
}

async function main() {
  const modules = await loadBackendModules()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-desktop-live-'))
  const projectPath = path.join(root, 'project')
  fs.mkdirSync(projectPath, { recursive: true })
  modules.initializeProjectDirectory(projectPath)
  const events = []
  const manager = createBackendRuntimeManager({ emit: ({ event }) => events.push(event) })
  try {
    await manager.ready
    const webContents = {}
    const connection = await manager.connect({
      workspaceId: 'live:desktop-runtime',
      workspaceName: 'desktop-runtime-live-check',
      projectPath,
      webContents,
    })
    await manager.send({
      runtimeId: connection.runtimeId,
      webContents,
      frame: {
        version: 1,
        kind: 'command',
        id: `command:${Date.now()}`,
        type: 'chat.message.send',
        sessionId: connection.sessionId,
        timestamp: new Date().toISOString(),
        payload: {
          clientMessageId: `message:${Date.now()}`,
          content: [{ type: 'text', text: '请只回复“IPC RuntimeLoop 已连接”，不要调用工具。' }],
          autoStart: true,
        },
      },
    })
    const terminal = await waitFor(events, (event) => ['chat.assistant.completed', 'chat.assistant.failed'].includes(event.type))
    const snapshot = events.find((event) => event.type === 'runtime.snapshot')
    const trace = events.filter((event) => event.type !== 'runtime.snapshot')
    process.stdout.write(`${JSON.stringify({
      terminal: terminal.type,
      traceEvents: trace.length,
      hasContextDocument: Boolean(snapshot?.payload?.contextDocument),
      hasContextControl: Boolean(snapshot?.payload?.contextControl),
      hasCandidates: Array.isArray(snapshot?.payload?.contextCandidates),
      hasEvidenceReceipts: Array.isArray(snapshot?.payload?.contextReceipts),
      eventTypes: [...new Set(trace.map((event) => event.type))],
    })}\n`)
    if (terminal.type !== 'chat.assistant.completed') process.exitCode = 1
  } finally {
    await manager.closeAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
