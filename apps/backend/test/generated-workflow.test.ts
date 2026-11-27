import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertWorkflowValue,
  compileGeneratedWorkflow,
  parseGeneratedWorkflow,
  transformWorkflowItems,
  type WorkflowExecutionData,
} from '#core/workflows/generated-workflow'
import {
  alignWorkflowRecords,
  joinWorkflowRecords,
  parseWorkflowValue,
  validateWorkflowSchema,
} from '#core/workflows/schema-alignment'

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

test('generated workflow accepts the provider string form of its numeric version constant', () => {
  const definition = parseGeneratedWorkflow({ version: '1', goal: 'string version', steps: [
    { id: 'noop', type: 'transform', operator: 'normalize', input: [] },
  ] }, new Map())
  assert.equal(definition.version, 1)
})

test('compact workflow intent is expanded into the canonical workflow definition', () => {
  const tools = new Map([['read', 'read']])
  const compact = parseGeneratedWorkflow({ version: 1, goal: 'compact chain', intent: {
    calls: [{ id: 'read', tool: 'read', args: {} }],
    operations: [
      { id: 'parse', op: 'parse', operator: 'json', input: { $ref: 'steps.read.output' } },
      { id: 'select', op: 'transform', operator: 'select_fields', input: { $ref: 'steps.parse.output.value' }, fields: ['id'] },
      { id: 'check', op: 'assert', input: { $ref: 'steps.select.output' }, expression: 'count($) >= 0' },
    ],
  } }, tools)
  assert.deepEqual(compact.steps.map(step => step.type), ['tool', 'parse', 'transform', 'assert'])
  assert.deepEqual(compact.steps[0], { id: 'read', type: 'tool', tool: 'read', arguments: {} })
  assert.equal(compileGeneratedWorkflow({ version: 1, goal: 'compact chain', intent: {
    calls: [{ id: 'read', tool: 'read', args: {} }],
    operations: [{ id: 'check', op: 'assert', input: { $ref: 'steps.read.output' }, expression: 'true' }],
  } }, tools).summary.deterministicNodeCount, 1)
  assert.throws(() => parseGeneratedWorkflow({ version: 1, goal: 'ambiguous', steps: [{ id: 'read', type: 'tool', tool: 'read', arguments: {} }], intent: { calls: [{ id: 'read2', tool: 'read', args: {} }] } }, tools), /both steps and intent/)
  assert.throws(() => parseGeneratedWorkflow({ version: 1, goal: 'unknown operation', intent: { operations: [{ id: 'x', op: 'noop' }] } }, tools), /invalid/)
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

test('schema glue parses JSON and JSON Lines while preserving raw input', () => {
  const json = parseWorkflowValue('{"id":"a","amount":"12"}', 'json')
  assert.deepEqual(json.value, { id: 'a', amount: '12' })
  assert.equal(json.raw, '{"id":"a","amount":"12"}')
  assert.deepEqual(parseWorkflowValue('{"id":1}\n{"id":2}\n', 'json_lines').value, [{ id: 1 }, { id: 2 }])
  assert.deepEqual(parseWorkflowValue(' first\n\n second ', 'lines').value, [' first', ' second '])
})

test('schema glue aligns heterogeneous records and reports unmapped fields', () => {
  const result = alignWorkflowRecords([
    { order_id: ' 1024 ', total: '12.50', ignored: 'raw' },
    { order_id: '1025', total: '3' },
  ], [
    { from: 'order_id', to: 'id', transform: 'trim', required: true },
    { from: 'total', to: 'amount', transform: 'number', required: true },
  ], { sourceSchema: 'orders.v1', targetSchema: 'canonical.order' })
  assert.deepEqual(result.records, [{ id: '1024', amount: 12.5 }, { id: '1025', amount: 3 }])
  assert.deepEqual(result.unmappedFields, [{ recordIndex: 0, fields: ['ignored'] }])
  assert.equal(result.alignment.sourceSchema, 'orders.v1')
  assert.match(result.alignment.mappingHash, /^[a-f0-9]{64}$/)
  assert.throws(() => alignWorkflowRecords({ total: '3' }, [{ from: 'order_id', to: 'id', required: true }]), /required field is missing/)
  const automatic = alignWorkflowRecords([{ filePath: 'a.txt', kind: 'file' }], [], {
    auto: true,
    targetSchema: { type: 'object', required: ['file_path', 'kind'], properties: { file_path: {}, kind: {} } },
  })
  assert.deepEqual(automatic.records, [{ file_path: 'a.txt', kind: 'file' }])
  assert.equal(automatic.alignment.mode, 'deterministic_auto')
})

test('schema glue validates canonical records and preserves join conflicts', () => {
  const schema = {
    type: 'array',
    items: { type: 'object', required: ['id', 'amount'], properties: { id: { type: 'string' }, amount: { type: 'number' } }, additionalProperties: false },
  }
  const validated = validateWorkflowSchema([{ id: '1024', amount: 12.5 }], schema, 'canonical.order.v1')
  assert.equal(validated.valid, true)
  assert.equal(validated.schemaId, 'canonical.order.v1')
  assert.throws(() => validateWorkflowSchema([{ id: '1024' }], schema), /schema validation failed/)

  const joined = joinWorkflowRecords(
    [{ id: '1024', amount: 12.5, status: 'pending' }, { id: '1025', amount: 8, status: 'paid' }],
    [{ order: '1024', amount: 10, note: 'email' }],
    { leftKey: 'id', rightKey: 'order', joinType: 'left' },
  )
  assert.equal(joined.records.length, 2)
  assert.deepEqual(joined.records[0]?.conflicts, [{ path: 'amount', left: 12.5, right: 10 }])
  assert.equal(joined.records[1]?.right, null)
  assert.equal(joined.conflicts[0]?.left, 12.5)
  assert.throws(() => joinWorkflowRecords(
    [{ id: '1024' }, { id: '1024' }],
    [{ id: '1024' }],
    { leftKey: 'id', rightKey: 'id', cardinality: 'one_to_one', onAmbiguous: 'error' },
  ), /matched by multiple left records/)
})

test('generated workflow accepts schema glue nodes and counts them as deterministic', () => {
  const tools = new Map([['read', 'read']])
  const workflow = parseGeneratedWorkflow({ version: 1, goal: 'align tool outputs', steps: [
    { id: 'read', type: 'tool', tool: 'read', arguments: {} },
    { id: 'parse', type: 'parse', operator: 'json', input: { $ref: 'steps.read.output.stdout' } },
    { id: 'align', type: 'align', input: { $ref: 'steps.parse.output.value' }, mappings: [{ from: 'order_id', to: 'id', required: true }] },
    { id: 'validate', type: 'validate_schema', input: { $ref: 'steps.align.output.records' }, schema: { type: 'array' } },
  ] }, tools)
  const compiled = compileGeneratedWorkflow(workflow, tools)
  assert.equal(compiled.summary.deterministicNodeCount, 3)
  assert.deepEqual(compiled.definition.steps.map(step => step.type), ['tool', 'parse', 'align', 'validate_schema'])
  const automatic = parseGeneratedWorkflow({ version: 1, goal: 'automatic alignment', steps: [
    { id: 'align', type: 'align', input: [{ filePath: 'a.txt' }], auto: true, targetSchema: { type: 'object', properties: { file_path: { type: 'string' } } } },
  ] }, tools)
  assert.equal(automatic.steps[0]?.type, 'align')
})
