import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertWorkflowValue,
  compileGeneratedWorkflow,
  parseGeneratedWorkflow,
  transformWorkflowItems,
  type WorkflowExecutionData,
} from '#core/workflows/generated-workflow'

const data: WorkflowExecutionData = { steps: {} }

test('generated workflow validates prior references and rejects unknown or forward references', () => {
  const tools = new Map([['read', 'read']])
  const valid = parseGeneratedWorkflow({ version: 1, goal: 'valid', steps: [
    { id: 'read', type: 'tool', tool: 'read', arguments: {} },
    { id: 'select', type: 'transform', operator: 'select_fields', input: { $ref: 'steps.read.output' }, fields: ['id'] },
  ] }, tools)
  assert.equal(valid.steps[1]!.type, 'transform')
  assert.throws(() => parseGeneratedWorkflow({ version: 1, goal: 'unknown', steps: [
    { id: 'select', type: 'filter', input: { $ref: 'steps.missing.output' }, expression: 'true' },
  ] }, tools), /unknown step/)
  assert.throws(() => parseGeneratedWorkflow({ version: 1, goal: 'forward', steps: [
    { id: 'select', type: 'filter', input: { $ref: 'steps.read.output' }, expression: 'true' },
    { id: 'read', type: 'tool', tool: 'read', arguments: {} },
  ] }, tools), /prior step/)
  const compiled = compileGeneratedWorkflow(valid, tools)
  assert.equal(compiled.summary.nodeCount, 2)
  assert.equal(compiled.summary.deterministicNodeCount, 1)
  assert.match(compiled.summary.graphHash, /^[a-f0-9]{64}$/)
})

test('deterministic workflow transforms map, dedupe, select fields, group and assert', async () => {
  const input = [{ id: 'a', group: 'x', value: 2 }, { id: 'b', group: 'x', value: 1 }, { id: 'a', group: 'x', value: 2 }]
  const mapped = await transformWorkflowItems(input, 'map', 'value * 2', undefined, data)
  assert.deepEqual(mapped, [4, 2, 4])
  const selected = await transformWorkflowItems(input, 'select_fields', undefined, ['id', 'value'], data)
  assert.deepEqual(selected, [{ id: 'a', value: 2 }, { id: 'b', value: 1 }, { id: 'a', value: 2 }])
  const deduped = await transformWorkflowItems(input, 'dedupe', 'id', undefined, data)
  assert.deepEqual(deduped, [input[0], input[1]])
  const grouped = await transformWorkflowItems(input, 'group_by', 'group', undefined, data)
  assert.deepEqual(grouped, [{ key: 'x', items: input }])
  assert.equal(await assertWorkflowValue({ total: 3 }, 'total = 3', data), true)
  await assert.rejects(() => assertWorkflowValue({ total: 3 }, 'total = 4', data).then(value => {
    if (!value) throw new Error('assertion failed')
  }), /assertion failed/)
})

test('deterministic workflow operators cover filtering, partitioning, pagination, reduction and normalization', async () => {
  const input = [{ id: ' a ', value: 2 }, { id: 'b', value: 1 }, { id: 'c', value: 3 }]
  assert.deepEqual(await transformWorkflowItems(input, 'filter', 'value > 1', undefined, data), [input[0], input[2]])
  assert.deepEqual(await transformWorkflowItems(input, 'partition', 'value > 1', undefined, data), { selected: [input[0], input[2]], rejected: [input[1]] })
  assert.deepEqual(await transformWorkflowItems(input, 'paginate', undefined, undefined, data, { pageSize: 2 }), [[input[0], input[1]], [input[2]]])
  assert.equal(await transformWorkflowItems([2, 1, 3], 'reduce', '$accumulator + $', undefined, data, { initial: 0 }), 6)
  assert.deepEqual(await transformWorkflowItems(input, 'normalize', undefined, undefined, data), [{ id: 'a', value: 2 }, { id: 'b', value: 1 }, { id: 'c', value: 3 }])
})
