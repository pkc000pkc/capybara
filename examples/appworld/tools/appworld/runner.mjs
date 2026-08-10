import fs from 'node:fs/promises'
import path from 'node:path'

const workspaceDir = path.resolve(process.env.CAPYBARA_PROJECT_DIR ?? '')
const stateFile = path.join(workspaceDir, '.capybara', 'appworld-case-state.json')

async function readInput() {
  let source = ''
  for await (const chunk of process.stdin) source += chunk
  return JSON.parse(source)
}
async function post(endpoint, route, body) {
  const response = await fetch(`${endpoint}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(110000),
  })
  const value = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = value?.detail ?? value?.error ?? `${response.status} ${response.statusText}`
    throw new Error(`AppWorld ${route} failed: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  }
  return value?.output
}

function responseEnvelope(completed) {
  return completed
    ? 'The AppWorld task is complete. Return exactly {"status":"completed","content":"concise user-facing result"} once, with no Markdown fence or surrounding text. Stop immediately after its closing brace; never repeat or concatenate the object.'
    : 'The AppWorld task is not complete. Continue with an appworld_execute tool call. If no tool call is possible, return exactly {"status":"running","content":"brief reason more work is required"} once, with no Markdown fence or surrounding text. Stop immediately after its closing brace; never repeat or concatenate the object.'
}

function nextResponse(completed) {
  return completed
    ? { status: 'completed', content: 'concise user-facing result' }
    : { status: 'running', content: 'brief reason more work is required' }
}

function errorProtocol() {
  return 'The AppWorld tool call failed. The task is not complete. Retry with another appworld_execute call after checking the current documented state. Do not produce a non-tool response after this error.'
}

try {
  const request = await readInput()
  if (request.tool !== 'appworld_execute') throw new Error(`unsupported tool: ${request.tool}`)
  const code = request.arguments?.code
  if (typeof code !== 'string' || !code.trim()) throw new Error('code is required')
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'))
  if (state.closedAt) throw new Error('the AppWorld case is already closed')
  const output = await post(state.endpoint, '/execute', { task_id: state.taskId, code })
  if (typeof output === 'string' && output.trimStart().startsWith('Execution failed.')) {
    throw new Error(output.trim())
  }
  const completed = await post(state.endpoint, '/task_completed', { task_id: state.taskId }) === true
  process.stdout.write(JSON.stringify({
    id: request.id,
    ok: true,
    result: {
      taskId: state.taskId,
      output: typeof output === 'string' ? output : JSON.stringify(output),
      completed,
      responseEnvelope: responseEnvelope(completed),
      nextResponse: nextResponse(completed),
    },
  }))
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stdout.write(JSON.stringify({
    ok: false,
    error: `${message}\n${errorProtocol()}`,
  }))
}
