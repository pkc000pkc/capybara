import type { RuntimeExecutionPhase, RuntimeExecutionState, RuntimeSkillPhase, RuntimeTaskControl, SkillDefinition, ToolDefinition } from '#protocol/runtime-protocol'

function isSkillPhase(phase: RuntimeExecutionPhase): phase is RuntimeSkillPhase {
  return phase === 'direct' || phase === 'investigation' || phase === 'execution' || phase === 'verification'
}

export function selectRuntimeSkills(skills: readonly SkillDefinition[], task: RuntimeTaskControl, execution: RuntimeExecutionState, catalog: readonly ToolDefinition[]): SkillDefinition[] {
  const { phase, activeTaskIds } = execution
  if (!isSkillPhase(phase)) return []
  const activeNodes = new Set(activeTaskIds)
  const grantedTools = new Set(task.tasks.filter(node => activeNodes.has(node.id)).flatMap(node => node.capabilityIds))
  for (const { id, name } of catalog) {
    if (grantedTools.has(id) || grantedTools.has(name)) { grantedTools.add(id); grantedTools.add(name) }
  }
  return skills.filter(skill => {
    if (skill.status !== 'active') return false
    if (skill.source === 'user') return true
    if (!skill.activation) return phase === 'direct' || skill.requiredTools.some(tool => grantedTools.has(tool))
    const boundNodes = skill.activation.taskId === task.taskId ? skill.activation.stages[phase] : undefined
    return boundNodes !== undefined && (phase === 'direct' || boundNodes.some(id => activeNodes.has(id)))
  }).sort((left, right) => Number(Boolean(right.activation)) - Number(Boolean(left.activation)))
}

export function bindRuntimeSkillActivation(skill: SkillDefinition, taskId: string, execution: RuntimeExecutionState): SkillDefinition {
  if (skill.source === 'user' || !isSkillPhase(execution.phase)) return skill
  const stages = skill.activation?.taskId === taskId ? skill.activation.stages : {}
  const prior = stages[execution.phase]
  const nodes = [...new Set([...(prior ?? []), ...execution.activeTaskIds])].sort()
  if (prior?.length === nodes.length) return skill
  return { ...skill, activation: { taskId, stages: { ...stages, [execution.phase]: nodes } } }
}
