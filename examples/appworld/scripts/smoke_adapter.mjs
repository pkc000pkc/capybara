import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const adapter = path.join(projectDir, 'experiments', 'appworld-adapter.mjs')

function invoke(phase, payload, environment = {}) {
  return new Promise((resolve, reject) => {
    const id = `smoke-${phase}`
    const child = spawn(process.execPath, [adapter], {
      cwd: projectDir,
      windowsHide: true,
      env: { ...process.env, ...environment },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      let response
      try { response = JSON.parse(stdout) } catch (error) {
        reject(new Error(`adapter returned invalid JSON (${code}): ${stderr || error.message}`))
        return
      }
      if (response.ok !== false && response.id !== id) {
        reject(new Error(`adapter response id mismatch: ${response.id}; raw=${stdout}`))
        return
      }
      resolve({ code, response })
    })
    child.stdin.end(JSON.stringify({ id, phase, payload }))
  })
}

const aggregate = await invoke('aggregate', {
  cases: [
    { sampleId: 'task_a_1', passed: true, metadata: { private: { appworld: { task_id: 'task_a_1', scenario_id: 'scenario_a', difficulty: 1 } } } },
    { sampleId: 'task_a_2', passed: false, metadata: { private: { appworld: { task_id: 'task_a_2', scenario_id: 'scenario_a', difficulty: 1 } } } },
    { sampleId: 'task_b_1', passed: true, metadata: { private: { appworld: { task_id: 'task_b_1', scenario_id: 'scenario_b', difficulty: 2 } } } },
  ],
})
assert.equal(aggregate.response.ok, true)
assert.equal(aggregate.response.result.tgc, 66.66666666666666)
assert.equal(aggregate.response.result.sgc, 50)
assert.equal(aggregate.response.result.numScenarios, 2)

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-appworld-smoke-'))
try {
  const appworldRoot = path.join(root, '.venv', 'appworld-root')
  const taskDir = path.join(appworldRoot, 'data', 'tasks', 'smoke_1', 'ground_truth')
  fs.mkdirSync(taskDir, { recursive: true })
  fs.writeFileSync(path.join(taskDir, 'answer.json'), '42\n', 'utf8')
  fs.writeFileSync(path.join(taskDir, 'test_data.json'), JSON.stringify([{ requirement: 'answer is 42' }]), 'utf8')
  fs.writeFileSync(path.join(taskDir, 'public_data.json'), '{}', 'utf8')
  fs.writeFileSync(path.join(taskDir, 'private_data.json'), '{}', 'utf8')
  const reference = await invoke('reference', {
    cases: [{ id: 'case-1', sampleId: 'smoke_1', experimentRunId: 'run-1', experimentCaseId: 'case-1', metadata: { private: { appworld: { task_id: 'smoke_1' } } }, evaluation: { details: { passes: [{ requirement: 'answer is 42' }], failures: [] } } }],
  }, { CAPYBARA_PROJECT_DIR: root })
  assert.equal(reference.response.ok, true)
  assert.equal(reference.response.result.items[0].reference.status, 'available', reference.response.result.items[0].reference.error)
  assert.equal(reference.response.result.items[0].reference.value, 42)
  assert.equal(reference.response.result.items[0].reference.requirements[0].status, 'passed')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}

const unsupported = await invoke('unsupported', {})
assert.equal(unsupported.code, 1)
assert.equal(unsupported.response.ok, false)
assert.match(unsupported.response.error, /unsupported adapter phase/)

console.log('AppWorld adapter smoke passed: aggregate, reference, and protocol error handling.')
