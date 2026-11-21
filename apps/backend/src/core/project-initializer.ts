import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadLlmConfig } from '#util/llm/config'

const SYSTEM_PROJECT_TEMPLATE_DIR = path.resolve(import.meta.dirname, '../../templates/project')
const SYSTEM_MANAGED_PROJECT_FILES = [
  '.capybara/hooks/context-compression.ts',
  '.capybara/hooks/context-organization.ts',
  '.capybara/hooks/hook-authoring.ts',
  '.capybara/harnesses/hook-authoring/manifest.json',
  '.capybara/harnesses/hook-authoring/hook-authoring.j2',
  '.capybara/harnesses/variable-authoring/manifest.json',
  '.capybara/harnesses/variable-authoring/variable-authoring.j2',
] as const
const INITIAL_PROJECT_TEMPLATE_FILES = [
  'agent.md',
  'capybara.plugin.json',
  'hooks/.gitkeep',
  'training-hooks/.gitkeep',
] as const

const SYSTEM_RESOURCE_ROOT = path.join(os.homedir(), '.capybara')

function systemResourceTarget(relative: string, systemRoot = SYSTEM_RESOURCE_ROOT): string {
  const normalized = relative.replaceAll('\\', '/')
  const resourcePath = normalized.startsWith('.capybara/')
    ? normalized.slice('.capybara/'.length)
    : normalized
  return path.join(systemRoot, resourcePath)
}

const INITIAL_MAIN_TEMPLATE = `{{ builtin.variables.agent_identity }}
{{ builtin.variables.execution_policy }}
{{ builtin.variables.resource_loading }}
{{ builtin.variables.completion_status }}
{{ builtin.variables.workspace_boundary }}

Selected workspace root: {{ builtin.workspace_path }}

{% set _resource_search_tool_description = builtin.variables.resource_search_tool_description %}
{% set _resource_load_tool_description = builtin.variables.resource_load_tool_description %}
{% set _system_variable_read_tool_description = builtin.variables.system_variable_read_tool_description %}
{% set _system_variable_apply_tool_description = builtin.variables.system_variable_apply_tool_description %}
{% set _workflow_execution_tool_description = builtin.variables.workflow_execution_tool_description %}
{% set _skill_reference_tool_description = builtin.variables.skill_reference_tool_description %}
{% set _skill_script_tool_description = builtin.variables.skill_script_tool_description %}

Agent: {{ agent.name }}
Task: {{ task.title }}
User: {{ user_message }}

{% if context.history_summary %}
Earlier context summary:
{{ context.history_summary }}
{% endif %}

{% if context.evidence_digest %}
Evidence digest:
{{ context.evidence_digest }}
{% endif %}

{% if tools | length > 0 %}
Loaded project tools:
{% for tool in tools %}- {{ tool.name }}: {{ tool.description }}
{% endfor %}
{% else %}
Loaded project tools: none
{% endif %}

{% if harnesses | length > 0 %}
Loaded harnesses:
{% for harness in harnesses %}
--- harness: {{ harness.name }} ---
{{ harness.content }}
{% endfor %}
{% else %}
Loaded harnesses: none
{% endif %}

{% if skills.catalog | length > 0 %}
Available skills:
{% for skill in skills.catalog %}- {{ skill.id }}: {{ skill.description }}
{% endfor %}
{% else %}
Available skills: none
{% endif %}

{% if skills.active | length > 0 %}
Active skills:
{% for skill in skills.active %}
--- skill: {{ skill.name }} ---
{{ skill.instructions }}
Required tools: {% if skill.requiredTools | length > 0 %}{{ skill.requiredTools | join(', ') }}{% else %}none{% endif %}
Registered scripts: {% if skill.scripts | length > 0 %}{{ skill.scripts | join(', ') }}{% else %}none{% endif %}
{% for reference in skill.references %}
--- skill reference: {{ reference.path }} ---
{{ reference.content }}
{% endfor %}
{% endfor %}
{% else %}
Active skills: none
{% endif %}
`

export function isDefaultProjectMainTemplate(source: string): boolean {
  return source.replaceAll('\r\n', '\n') === INITIAL_MAIN_TEMPLATE.replaceAll('\r\n', '\n')
}

export function bundledAuthoringHarnessTemplate(source: unknown): string | undefined {
  if (source !== '@system/harnesses/hook-authoring/hook-authoring.j2'
    && source !== '@system/harnesses/variable-authoring/variable-authoring.j2') return undefined
  return fs.readFileSync(path.join(SYSTEM_PROJECT_TEMPLATE_DIR, '.capybara', source.slice('@system/'.length)), 'utf8')
}

const INITIAL_SYSTEM_VARIABLES = {
  version: 1,
  variables: [
    {
      key: 'resource_loading',
      type: 'text',
      label: 'Resource loading',
      description: 'Controls discovery and on-demand activation of project resources.',
      value: 'Project tools, harnesses, and skills are a searchable catalog and are not loaded by default. Search for relevant resources before loading them, and use only exact IDs returned by the search.',
      required: true,
      readonly: true,
    },
    {
      key: 'completion_status',
      type: 'text',
      label: 'Completion status',
      description: 'Defines the structured status contract used by the runtime Loop.',
      value: 'Use the current Runtime control schema for control decisions and the native tool channel for projected tools.',
      required: true,
      readonly: true,
    },
    {
      key: 'workspace_boundary',
      type: 'text',
      label: 'Workspace boundary',
      description: 'Constrains project tools to the selected workspace.',
      value: 'Tool paths must be relative to the selected workspace root. Never access a parent or sibling directory.',
      required: true,
      readonly: true,
    },
    {
      key: 'resource_search_tool_description',
      type: 'text',
      label: 'Resource search tool',
      description: 'Description injected into the built-in resource search tool.',
      value: 'Search the Agent project catalog for tools, harnesses, and skills relevant to the current task.',
      required: true,
      readonly: true,
    },
    {
      key: 'resource_load_tool_description',
      type: 'text',
      label: 'Resource load tool',
      description: 'Description injected into the built-in resource loading tool.',
      value: 'Activate Agent project tools, harnesses, or skills by exact IDs returned from search_resources.',
      required: true,
      readonly: true,
    },
    {
      key: 'system_variable_read_tool_description',
      type: 'text',
      label: 'System variable reader',
      description: 'Description injected into the built-in system variable reader.',
      value: 'Read selected system variables and their types, structured values, dependencies, and current revision before proposing a change. Typed values are available to Jinja2 as builtin.variables.<key>; prompt_template variables are resolved before the main prompt renders, while builtin.prompts remains a compatible rendered view.',
      required: true,
      readonly: true,
    },
    {
      key: 'system_variable_apply_tool_description',
      type: 'text',
      label: 'System variable change tool',
      description: 'Description injected into the built-in system variable change tool.',
      value: 'Atomically add, patch, replace, or remove typed system variables using the latest revision and return the validated diff. Supported types are text, prompt_template, boolean, integer, number, date, datetime, array, object, and secret_ref. Use text patch only for strings; use json_patch for arrays and objects. secret_ref stores only a reference and never resolves credentials.',
      required: true,
      readonly: true,
    },
    {
      key: 'workflow_execution_tool_description',
      type: 'text',
      label: 'Runtime workflow execution',
      description: 'Description injected into the temporary workflow tool.',
      value: 'Generate and execute one temporary workflow when multiple loaded Tool operations can be chained without another model decision.',
      required: true,
      readonly: true,
    },
    {
      key: 'skill_reference_tool_description',
      type: 'text',
      label: 'Skill reference reader',
      description: 'Description injected into the Skill reference reader.',
      value: 'Read one exact reference path registered by an active Skill and add its content to the next context revision.',
      required: true,
      readonly: true,
    },
    {
      key: 'skill_script_tool_description',
      type: 'text',
      label: 'Skill script runner',
      description: 'Description injected into the Skill script runner.',
      value: 'Run one exact script registered by an active Skill with an explicit argument array inside the selected workspace.',
      required: true,
      readonly: true,
    },
    {
      key: 'agent_identity',
      type: 'text',
      label: 'Agent identity',
      description: 'Base identity prepended to the rendered system message.',
      value: 'You are a project agent running in Capybara.',
      required: true,
      readonly: false,
    },
    {
      key: 'execution_policy',
      type: 'text',
      label: 'Execution policy',
      description: 'Default operating policy for this project.',
      value: 'Keep decisions explicit, preserve developer control, and report runtime state changes.',
      required: true,
      readonly: false,
    },
    {
      key: 'dynamic_context',
      type: 'prompt_template',
      label: 'Dynamic context',
      description: 'Stable root template for user-approved context assembled from dynamic variables.',
      value: '',
      required: false,
      readonly: false,
    },
  ],
}

const INITIAL_GITIGNORE = `.capybara/secrets.json
.capybara/sessions.sqlite*
.capybara/experiments.sqlite*
.capybara/worktrees/
.capybara/runtime/
.capybara/*.log
`

const INITIAL_GITATTRIBUTES = `* text=auto eol=lf

*.bat text eol=crlf
*.cmd text eol=crlf
*.ps1 text eol=crlf
`

export interface ProjectInitializationResult {
  path: string
  name: string
  files: string[]
}

export function isInitializableProjectDirectory(projectDir: string): boolean {
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) return false
  return fs.readdirSync(projectDir).every((entry) => entry === '.git' || entry === '.capybara')
}

export function installSystemProjectResources(input: string, systemRoot = SYSTEM_RESOURCE_ROOT): string[] {
  const projectDir = path.resolve(input)
  const installed: string[] = []
  for (const relative of SYSTEM_MANAGED_PROJECT_FILES) {
    const source = fs.readFileSync(path.join(SYSTEM_PROJECT_TEMPLATE_DIR, relative), 'utf8')
    const target = systemResourceTarget(relative, systemRoot)
    if (fs.existsSync(target)) continue
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, source, 'utf8')
    installed.push(`@system/${path.relative(systemRoot, target).replaceAll('\\', '/')}`)
  }
  const systemVariablesFile = path.join(projectDir, '.capybara', 'system-variables.json')
  if (fs.existsSync(systemVariablesFile)) {
    const parsed = JSON.parse(fs.readFileSync(systemVariablesFile, 'utf8')) as {
      version?: unknown
      variables?: unknown
    }
    if (parsed.version === 1 && Array.isArray(parsed.variables)) {
      const builtinVariables = INITIAL_SYSTEM_VARIABLES.variables.filter((variable) => variable.readonly)
      const builtinByKey = new Map(builtinVariables.map((variable) => [variable.key, variable]))
      const existingKeys = new Set(parsed.variables.flatMap((value) => (
        typeof value === 'object' && value !== null && !Array.isArray(value)
          && typeof (value as Record<string, unknown>).key === 'string'
          ? [String((value as Record<string, unknown>).key)]
          : []
      )))
      let changed = false
      const variables = parsed.variables.map((value) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
        const item = value as Record<string, unknown>
        if (typeof item.key !== 'string') return value
        const builtin = builtinByKey.get(item.key)
        if (!builtin) return value
        const next = { ...item, ...builtin }
        if (JSON.stringify(next) !== JSON.stringify(value)) changed = true
        return next
      })
      for (const builtin of builtinVariables) {
        if (existingKeys.has(builtin.key)) continue
        variables.push(builtin)
        changed = true
      }
      if (changed) {
        fs.writeFileSync(systemVariablesFile, `${JSON.stringify({ version: 1, variables }, null, 2)}\n`)
        installed.push('.capybara/system-variables.json')
      }
    }
  }
  return installed
}

export function initializeProjectDirectory(input: string): ProjectInitializationResult {
  const projectDir = path.resolve(input)
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    throw new Error(`project directory was not found: ${projectDir}`)
  }
  if (!isInitializableProjectDirectory(projectDir)) {
    throw new Error(`project directory is not empty: ${projectDir}`)
  }

  // System-owned Hooks and Harnesses live in the user-level resource root.
  // Seed them before the project catalog is first queried; the project itself
  // receives only project-owned files below.
  installSystemProjectResources(projectDir)

  const llm = loadLlmConfig()
  const files = new Map<string, string>([
    ['.capybara/config.json', `${JSON.stringify({
      resource_format: 2,
      main_template: 'main.j2',
      max_messages: 20,
      max_tool_rounds: 8,
      tool_timeout_ms: 15_000,
      llm: {
        provider: llm.provider,
        model: llm.model,
        base_url: llm.baseUrl,
        protocol: llm.protocol,
        max_retries: llm.maxRetries,
        active_profile: 'default',
        profiles: [{
          id: 'default',
          name: 'Default',
          provider: llm.provider,
          model: llm.model,
          base_url: llm.baseUrl,
          protocol: llm.protocol,
          max_retries: llm.maxRetries,
        }],
      },
      context: {
        context_window_tokens: 16_000,
        max_input_tokens: 16_000,
        reserved_output_tokens: 2_000,
      },
      // File tools and the project-files Skill are system resources.  The
      // project records only project-owned resources; ProjectResources adds
      // the system defaults when it builds the effective settings.
      tools: [],
      skills: [],
      harnesses: [],
      plugins: [],
      harness_policy: {
        experience_top_k: 3,
        experience_threshold: 0.35,
        experience_auto_attach: true,
      },
      tool_permissions: [
        'filesystem:read',
        'filesystem:write',
        'filesystem:delete',
        'process:execute',
      ],
    }, null, 2)}\n`],
    ['.capybara/system-variables.json', `${JSON.stringify(INITIAL_SYSTEM_VARIABLES, null, 2)}\n`],
    ['main.j2', INITIAL_MAIN_TEMPLATE],
    ...INITIAL_PROJECT_TEMPLATE_FILES.map((relative): [string, string] => [
      relative,
      fs.readFileSync(path.join(SYSTEM_PROJECT_TEMPLATE_DIR, relative), 'utf8'),
    ]),
    ['.gitignore', INITIAL_GITIGNORE],
    ['.gitattributes', INITIAL_GITATTRIBUTES],
  ])
  const createdFiles: string[] = []
  const createdDirectories: string[] = []
  const overwrittenFiles: Array<{ target: string; content: string }> = []
  const replaceableFiles = new Set<string>()
  const configTarget = path.join(projectDir, '.capybara', 'config.json')
  if (fs.existsSync(configTarget)) {
    try {
      const existingConfig = JSON.parse(fs.readFileSync(configTarget, 'utf8')) as { main_template?: unknown }
      // The runtime host can bootstrap an empty directory with a minimal
      // `.capybara/main.j2` before the full project initializer runs. Treat
      // that exact bootstrap shape as an upgradeable file instead of failing
      // with EEXIST when the user opens the project from the Workbench.
      if (existingConfig.main_template === '.capybara/main.j2' && !fs.existsSync(path.join(projectDir, 'main.j2'))) {
        replaceableFiles.add('.capybara/config.json')
      }
    } catch {
      // A malformed existing config is never overwritten implicitly.
    }
  }
  try {
    for (const [relative, content] of files) {
      const target = path.join(projectDir, relative)
      const directory = path.dirname(target)
      if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true })
        createdDirectories.push(directory)
      }
      if (fs.existsSync(target)) {
        const existing = fs.readFileSync(target, 'utf8')
        if (existing === content) continue
        if (!replaceableFiles.has(relative)) {
          throw new Error(`project initialization would overwrite existing file: ${relative}`)
        }
        overwrittenFiles.push({ target, content: existing })
        fs.writeFileSync(target, content, 'utf8')
        continue
      }
      try {
        fs.writeFileSync(target, content, { encoding: 'utf8', flag: 'wx' })
        createdFiles.push(target)
      } catch (error) {
        // Two desktop actions can initialize the same project concurrently.
        // If the other initializer won with identical content, the desired
        // state is already present and this invocation can continue.
        if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST' && fs.existsSync(target) && fs.readFileSync(target, 'utf8') === content) continue
        throw error
      }
    }
  } catch (error) {
    for (const file of createdFiles.reverse()) fs.rmSync(file, { force: true })
    for (const file of overwrittenFiles.reverse()) fs.writeFileSync(file.target, file.content, 'utf8')
    for (const directory of createdDirectories.reverse()) {
      try {
        fs.rmdirSync(directory)
      } catch {
        // Keep a directory if another process populated it while initialization was running.
      }
    }
    throw error
  }

  return {
    path: projectDir,
    name: path.basename(projectDir),
    files: [...files.keys()],
  }
}
