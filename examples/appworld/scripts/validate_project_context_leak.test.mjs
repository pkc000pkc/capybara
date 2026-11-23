import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { validateProjectContextLeak } from './validate_project_context_leak.mjs'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-appworld-leak-'))
  const dataset = path.join(root, 'dataset.jsonl')
  const tasks = path.join(root, 'tasks', 'task_1')
  fs.mkdirSync(path.join(tasks, 'ground_truth'), { recursive: true })
  fs.writeFileSync(dataset, `${JSON.stringify({ metadata: { private: { appworld: { task_id: 'task_1' } } }, answer: { order_id: 'order-9981', amount: 120 } })}\n`)
  fs.writeFileSync(path.join(tasks, 'ground_truth', 'private_data.json'), JSON.stringify({ customer_email: 'private@example.invalid' }))
  return { root, dataset, tasksRoot: path.join(root, 'tasks') }
}

test('project context leak validator accepts reusable methodology', () => {
  const f = fixture()
  try {
    const result = validateProjectContextLeak({
      context: { document: { revision: 4, information: [{ body: '先读取 API 文档，再执行写操作，最后验证状态。' }] } },
      dataset: f.dataset,
      tasksRoot: f.tasksRoot,
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.leaks, [])
  } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
})

test('project context leak validator rejects task-specific answer and private values', () => {
  const f = fixture()
  try {
    const result = validateProjectContextLeak({
      context: { document: { revision: 5, information: [{ body: '订单 order-9981 的金额是 120，客户邮箱 private@example.invalid。' }] } },
      dataset: f.dataset,
      tasksRoot: f.tasksRoot,
    })
    assert.equal(result.ok, false)
    assert.equal(result.leaks.length, 3)
    assert.ok(result.leaks.every(item => /^[a-f0-9]{16}$/u.test(item.valueHash)))
  } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
})
