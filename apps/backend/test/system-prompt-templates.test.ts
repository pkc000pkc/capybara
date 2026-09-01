import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveSystemPromptVariables, validateSystemPromptVariableValue } from '#core/system-prompt-templates'

const nestedVariables = (leafValue: string) => [
  { key: 'template_parameter', type: 'text' as const, value: leafValue },
  {
    key: 'template_level_3',
    type: 'prompt_template' as const,
    value: 'level3({{ builtin.prompts.template_parameter }})',
  },
  {
    key: 'template_level_2',
    type: 'prompt_template' as const,
    value: 'level2({{ builtin.prompts.template_level_3 }})',
  },
  {
    key: 'template_level_1',
    type: 'prompt_template' as const,
    value: 'level1({{ builtin.prompts.template_level_2 }})',
  },
]

test('prompt_template variables render nested templates and recompute after a leaf update', () => {
  const initial = resolveSystemPromptVariables(nestedVariables('leaf-value'))
  assert.equal(
    initial.prompts.template_level_1,
    'level1(level2(level3(leaf-value)))',
  )
  assert.deepEqual(initial.dependencies, {
    template_parameter: [],
    template_level_3: ['template_parameter'],
    template_level_2: ['template_level_3'],
    template_level_1: ['template_level_2'],
  })

  const updated = resolveSystemPromptVariables(nestedVariables('updated-leaf'))
  assert.equal(
    updated.prompts.template_level_1,
    'level1(level2(level3(updated-leaf)))',
  )
})

test('text variables preserve Jinja2 source literally', () => {
  const result = resolveSystemPromptVariables([{
    key: 'literal_text',
    type: 'text',
    value: '{{ builtin.prompts.not_a_dependency }}',
  }])
  assert.equal(result.prompts.literal_text, '{{ builtin.prompts.not_a_dependency }}')
  assert.deepEqual(result.dependencies.literal_text, [])
})

test('prompt_template variables reject unknown references', () => {
  assert.throws(
    () => resolveSystemPromptVariables([{
      key: 'root_template',
      type: 'prompt_template',
      value: '{{ builtin.prompts.unknown_value }}',
    }]),
    /references unknown system variable "unknown_value"/,
  )
})

test('prompt_template variables reject circular dependencies with the complete cycle', () => {
  assert.throws(
    () => resolveSystemPromptVariables([
      { key: 'first_template', type: 'prompt_template', value: '{{ builtin.prompts.second_template }}' },
      { key: 'second_template', type: 'prompt_template', value: '{{ builtin.prompts.first_template }}' },
    ]),
    /first_template -> second_template -> first_template/,
  )
})

test('prompt_template variables reject invalid Jinja2 and excessive nesting', () => {
  assert.throws(
    () => resolveSystemPromptVariables([{
      key: 'broken_template',
      type: 'prompt_template',
      value: '{% if %}',
    }]),
    /invalid Jinja2 syntax/,
  )
  assert.throws(
    () => resolveSystemPromptVariables(nestedVariables('leaf-value'), { maxDepth: 2 }),
    /dependency depth exceeds 2: template_level_1 -> template_level_2 -> template_level_3/,
  )
})

test('typed variables preserve values and expose them through builtin.variables', () => {
  const result = resolveSystemPromptVariables([
    { key: 'enabled', type: 'boolean', value: true },
    { key: 'retries', type: 'integer', value: 3 },
    { key: 'ratio', type: 'number', value: 0.5 },
    { key: 'when', type: 'date', value: '2026-08-19' },
    { key: 'at', type: 'datetime', value: '2026-08-19T12:30:00Z' },
    { key: 'labels', type: 'array', value: ['a', 'b'] },
    { key: 'metadata', type: 'object', value: { owner: 'capybara' } },
    { key: 'token', type: 'secret_ref', value: 'env://CAPYBARA_TOKEN' },
    {
      key: 'summary',
      type: 'prompt_template',
      value: '{{ builtin.variables.enabled }} {{ builtin.variables.retries }} {{ builtin.variables.labels | join(",") }} {{ builtin.variables.metadata.owner }}',
    },
  ])
  assert.deepEqual(result.values.labels, ['a', 'b'])
  assert.equal(result.values.token, 'env://CAPYBARA_TOKEN')
  assert.equal(result.prompts.summary, 'true 3 a,b capybara')
  assert.doesNotThrow(() => validateSystemPromptVariableValue('date', '2024-02-29'))
  assert.throws(() => validateSystemPromptVariableValue('date', '2025-02-29'), /valid YYYY-MM-DD/)
  assert.throws(() => validateSystemPromptVariableValue('integer', 1.5), /integer/)
})
