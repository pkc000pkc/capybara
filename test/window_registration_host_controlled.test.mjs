import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const plugin = resolve('plugins/gaia2-runtime')
const backend = resolve('../..', 'capybara-backend')
const sourceText = 'Wait for a reply during the next minute and do not notify me.'
const sourceHash = createHash('sha256').update(sourceText).digest('hex')
const user = { role: 'user', id: 'user-1', notificationType: 'USER_MESSAGE', content: sourceText, sourceHash }
const source = (mode) => ({ schemaVersion: 'gaia2-window-obligation-source-v1', enabled: true,
  executionId: 'execution-1', sessionId: 'session-1', userRef: 'user-1', sourceHash,
  span: { start: 0, end: sourceText.length, text: sourceText }, sceneStart: 0, parserReceiptHash: 'a'.repeat(64),
  obligations: [{ id: `window-${mode}`, mode, goal: 'Monitor the reply', deadline: 60, notificationPolicy: 'forbid_until_deadline',
    sourceSpanHash: 'b'.repeat(64), span: { start: 0, end: sourceText.length, text: sourceText } }] })
const hash = value => createHash('sha256').update(value).digest('hex')

async function runCase(mode) {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'gaia2-window-host-'))
  const files = readdirSync(plugin, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const path = join(entry.parentPath, entry.name)
    return { relativePath: path.slice(plugin.length + 1).replaceAll('\\', '/'), sha256: hash(readFileSync(path)) }
  })
  const options = { projectDir: process.cwd(), workspaceDir, executionId: 'execution-1', sessionId: 'session-1', scenarioId: `scenario-${mode}`,
    plugins: [{ id: 'gaia2-runtime', snapshotRoot: plugin, files }] }
  const specPath = join(workspaceDir, 'spec.json'), readyPath = join(workspaceDir, 'ready.json'), token = (`window-${mode}-token-`).repeat(4)
  writeFileSync(specPath, JSON.stringify({ backendRoot: backend, readyPath, options }))
  const child = spawn(process.execPath, [`--import=${pathToFileURL(join(backend, 'node_modules/tsx/dist/loader.mjs')).href}`, '--conditions=development', resolve('scripts/phase3_hook_server.ts'), '--spec', specPath], { cwd: workspaceDir, env: { ...process.env, GAIA2_HOOK_TOKEN: token }, windowsHide: true })
  let closed = false; let stderr = ''
  child.stdout.resume(); child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const closePromise = new Promise(resolveClose => child.once('close', () => { closed = true; resolveClose() }))
  try {
    let ready
    for (let i = 0; i < 300 && !closed; i++) { try { ready = JSON.parse(readFileSync(readyPath, 'utf8')); break } catch {} await sleep(20) }
    assert.ok(ready, stderr || 'Host not ready')
    const post = async input => {
      const response = await fetch(ready.endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ executionId: options.executionId, sessionId: options.sessionId, loop: { iteration: 1 }, messages: [user], ...input }) })
      assert.equal(response.status, 200, stderr + ' ' + await response.clone().text())
      return response.json()
    }
    const registration = await post({ checkpoint: 'before_model', clock: { now: 0 }, action: { id: 'window-register-1', name: 'window', canonicalName: 'CapybaraWindow__register', effect: 'read', authoritativeRead: false, arguments: { windowSource: source(mode) } } })
    assert.equal(registration.decision.action, 'allow')
    const finish = await post({ checkpoint: 'before_tool', clock: { now: 0 }, action: { id: 'finish-1', name: 'send', canonicalName: 'AgentUserInterface__send_message_to_user', effect: 'finish', resourceKey: 'AgentUserInterface', authoritativeRead: false, mutationKey: 'c'.repeat(64), idempotent: false, arguments: { message: 'Finished' } } })
    assert.equal(finish.decision.action, 'block')
    assert.equal(finish.decision.reason, 'window_obligation_pending')
    const report = JSON.parse(readFileSync(registration.evidencePath, 'utf8'))
    assert.equal(report.variables.gaia2_window_obligation_state.obligations[0].mode, mode)
    assert.equal(report.variables.gaia2_window_obligation_state.obligations[0].status, 'pending')
    return { mode, registered: true, blockedReason: finish.decision.reason }
  } finally {
    if (!closed) { await fetch((() => { try { return JSON.parse(readFileSync(readyPath, 'utf8')).endpoint.replace('/invoke', '/shutdown') } catch { return '' } })(), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ executionId: options.executionId, sessionId: options.sessionId }) }).catch(() => {}); await Promise.race([closePromise, sleep(5000)]) }
    if (closed) rmSync(workspaceDir, { recursive: true, force: true })
  }
}

test('formal Host registration blocks completion for monitor and condition windows', async () => {
  const results = await Promise.all(['monitor_until', 'condition_once'].map(runCase))
  assert.deepEqual(results.map(item => item.blockedReason), ['window_obligation_pending', 'window_obligation_pending'])
})
