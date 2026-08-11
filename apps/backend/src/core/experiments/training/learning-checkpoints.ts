import type { HookFixture, HookTrainingContext } from '#core/hooks/types'
import type { SystemVariableDefinition } from '#core/project-resources'
import { resolveSystemPromptVariables } from '#core/system-prompt-templates'
import type { RuntimeVariables } from '#protocol/runtime-protocol'

export function learningFixture(
  checkpoint: HookFixture['checkpoint'],
  training: HookTrainingContext,
  variables: SystemVariableDefinition[],
  variableValues: Record<string, string> = {},
): HookFixture {
  const prompts = resolveSystemPromptVariables(variables.map((variable) => ({
    ...variable,
    value: variableValues[variable.key] ?? variable.value,
  }))).prompts
  const runtimeVariables = {
    builtin: {
      project_path: '',
      workspace_path: '',
      config_file: '.capybara/config.json',
      main_template: 'main.j2',
      initialized_at: new Date().toISOString(),
      prompts,
      shared_prompts: variables.filter((item) => item.scope === 'project').map((item) => item.key),
      missing_prompts: [],
      sys_message: [],
    },
    task: { title: training.case.question },
    agent: { name: 'training' },
    context: {
      files: [],
      history_summary: '',
      evidence_refs: [],
      evidence_digest: '',
    },
    user_message: training.case.question,
    tools: [],
    harnesses: [],
    skills: { catalog: [], active: [] },
  } satisfies RuntimeVariables
  return {
    checkpoint,
    runId: training.runId,
    loopIteration: 1,
    status: {
      run: { status: training.evaluation.passed ? 'completed' : 'failed' },
      context: { usedTokens: 0, maxTokens: 0, utilization: 0 },
      queueDepth: 0,
      messageCount: 2,
      variableTokens: {},
    },
    changedVariables: [],
    variables: runtimeVariables,
    messages: [
      { role: 'user', content: training.case.question },
      { role: 'assistant', content: training.case.actualAnswer },
    ],
    training,
  }
}
