import fs from 'node:fs'
import path from 'node:path'

import { loadLlmConfig } from '#util/llm/config'
import { enqueueProjectWrite } from '#core/project-write-queue'
import {
  resolveSystemPromptVariables,
  type SystemPromptVariableType,
} from '#core/system-prompt-templates'

export type SystemVariableScope = 'session' | 'project'

export interface SystemVariableDefinition {
  key: string
  type: SystemPromptVariableType
  label: string
  description: string
  value: string
  required: boolean
  readonly: boolean
  show_in_status: boolean
  scope?: SystemVariableScope
  source: 'builtin' | 'project'
}

export interface SystemVariablesResource {
  version: 1
  variables: SystemVariableDefinition[]
}

export interface ProjectSettings {
  main_template: string
  max_messages: number
  max_tool_rounds: number
  tool_timeout_ms: number
  llm: {
    model: string
    base_url: string
    protocol: 'responses' | 'chat-completions'
    api_key?: string
  }
  context: {
    max_input_tokens: number
    reserved_output_tokens: number
  }
  tools: string[]
  skills: string[]
  harnesses: string[]
  harness_policy: {
    experience_top_k: number
    experience_threshold: number
    experience_auto_attach: boolean
  }
  tool_permissions: string[]
}

export type ProjectResourceChange =
  | 'settings'
  | 'system-variables'
  | 'tools'
  | 'skills'
  | 'harnesses'
  | 'hooks'

const EMPTY_SYSTEM_VARIABLES: SystemVariablesResource = { version: 1, variables: [] }
const SYS_MESSAGE_VARIABLE: SystemVariableDefinition = {
  key: 'sys_message',
  type: 'text',
  label: 'LLM messages',
  description: 'Runtime-managed complete LLM message list exposed as builtin.sys_message.',
  value: '',
  required: false,
  readonly: true,
  show_in_status: true,
  source: 'builtin',
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class ProjectResources {
  readonly configFile: string
  readonly legacyConfigFile: string
  readonly secretsFile: string
  readonly systemVariablesFile: string

  private readonly listeners = new Set<(change: ProjectResourceChange) => void>()
  private watcher?: fs.FSWatcher
  private debounceTimer?: NodeJS.Timeout

  constructor(readonly projectDir: string, watch = false) {
    this.configFile = path.join(projectDir, '.capybara', 'config.json')
    this.legacyConfigFile = path.join(projectDir, 'config.json')
    this.secretsFile = path.join(projectDir, '.capybara', 'secrets.json')
    this.systemVariablesFile = path.join(projectDir, '.capybara', 'system-variables.json')
    if (watch) this.watch()
  }

  readSettings(): ProjectSettings {
    const source = fs.existsSync(this.configFile) ? this.configFile : this.legacyConfigFile
    const value = this.readJson(source, {})
    if (!isObject(value)) throw new Error('.capybara/config.json must contain an object')
    const maxMessages = value.max_messages ?? 20
    const mainTemplate = value.main_template ?? 'main.j2'
    const llm = loadLlmConfig()
    if (!Number.isInteger(maxMessages) || Number(maxMessages) < 1 || Number(maxMessages) > 10_000) {
      throw new Error('max_messages must be an integer between 1 and 10000')
    }
    if (typeof mainTemplate !== 'string' || !mainTemplate.trim()) {
      throw new Error('main_template must be a non-empty string')
    }
    const configuredLlm = value.llm ?? {
      model: llm.model,
      base_url: llm.baseUrl,
      protocol: llm.protocol,
    }
    const secretApiKey = this.readApiKey()
    const projectLlm = secretApiKey && isObject(configuredLlm)
      ? { ...configuredLlm, api_key: secretApiKey }
      : configuredLlm
    return this.validateSettings({
      main_template: mainTemplate,
      max_messages: maxMessages,
      max_tool_rounds: value.max_tool_rounds ?? 8,
      tool_timeout_ms: value.tool_timeout_ms ?? 15_000,
      llm: projectLlm,
      context: value.context ?? {
        max_input_tokens: 16_000,
        reserved_output_tokens: 2_000,
      },
      tools: value.tools ?? [],
      skills: value.skills ?? [],
      harnesses: value.harnesses ?? [],
      harness_policy: value.harness_policy ?? {
        experience_top_k: 3,
        experience_threshold: 0.35,
        experience_auto_attach: true,
      },
      tool_permissions: value.tool_permissions ?? [],
    })
  }

  resolveSettings(value: unknown): ProjectSettings {
    if (!isObject(value)) throw new Error('settings must be an object')
    const current = this.readSettings()
    let nextLlm: unknown = current.llm
    if (value.llm !== undefined) {
      if (!isObject(value.llm)) throw new Error('llm must be an object')
      const { api_key: _apiKey, ...withoutApiKey } = current.llm
      const base = value.llm.api_key === null ? withoutApiKey : current.llm
      nextLlm = {
        ...base,
        ...(value.llm.model === undefined ? {} : { model: value.llm.model }),
        ...(value.llm.base_url === undefined ? {} : { base_url: value.llm.base_url }),
        ...(value.llm.protocol === undefined ? {} : { protocol: value.llm.protocol }),
        ...(value.llm.api_key === undefined || value.llm.api_key === '' || value.llm.api_key === null
          ? {}
          : { api_key: value.llm.api_key }),
      }
    }
    const next = {
      ...current,
      ...(value.max_messages === undefined ? {} : { max_messages: value.max_messages }),
      ...(value.max_tool_rounds === undefined ? {} : { max_tool_rounds: value.max_tool_rounds }),
      ...(value.tool_timeout_ms === undefined ? {} : { tool_timeout_ms: value.tool_timeout_ms }),
      llm: nextLlm,
      ...(value.context === undefined ? {} : { context: value.context }),
      ...(value.tools === undefined ? {} : { tools: value.tools }),
      ...(value.skills === undefined ? {} : { skills: value.skills }),
      ...(value.harnesses === undefined ? {} : { harnesses: value.harnesses }),
      ...(value.harness_policy === undefined ? {} : { harness_policy: value.harness_policy }),
      ...(value.tool_permissions === undefined ? {} : { tool_permissions: value.tool_permissions }),
    }
    return this.validateSettings(next)
  }

  saveSettings(value: unknown): ProjectSettings {
    const settings = this.resolveSettings(value)
    const { api_key: apiKey, ...llm } = settings.llm
    this.writeJson(this.configFile, { ...settings, llm })
    if (apiKey) this.writeJson(this.secretsFile, { version: 1, llm: { api_key: apiKey } })
    else if (fs.existsSync(this.secretsFile)) fs.unlinkSync(this.secretsFile)
    return settings
  }

  readSystemVariables(): SystemVariablesResource {
    return this.readProjectSystemVariables()
  }

  saveSystemVariables(value: unknown): SystemVariablesResource {
    const submitted = this.validateSystemVariables(value)
    const current = this.readProjectSystemVariables()
    const readonlyVariables = current.variables.filter((variable) => variable.readonly)
    const readonlyByKey = new Map(readonlyVariables.map((variable) => [variable.key, variable]))
    for (const variable of submitted.variables) {
      const existing = readonlyByKey.get(variable.key)
      if (!existing && variable.readonly) {
        throw new Error(`readonly system variables can only be defined in the project file: ${variable.key}`)
      }
      if (existing && (
        variable.type !== existing.type ||
        variable.label !== existing.label ||
        variable.description !== existing.description ||
         variable.value !== existing.value ||
         variable.required !== existing.required ||
         variable.show_in_status !== existing.show_in_status ||
         (variable.scope ?? 'session') !== (existing.scope ?? 'session') ||
         !variable.readonly
      )) {
        throw new Error(`readonly system variable is immutable: ${variable.key}`)
      }
    }
    const submittedKeys = new Set(submitted.variables.map((variable) => variable.key))
    const projectVariables = [
      ...readonlyVariables.filter((variable) => !submittedKeys.has(variable.key)),
      ...submitted.variables,
    ]
    const resource = {
      version: 1 as const,
      variables: projectVariables.map((variable) => ({
        ...variable,
        source: variable.readonly ? 'builtin' as const : 'project' as const,
      })),
    }
    resolveSystemPromptVariables(resource.variables)
    this.writeSystemVariablesFile(resource)
    return resource
  }

  saveSystemVariablesQueued(value: unknown): Promise<SystemVariablesResource> {
    return enqueueProjectWrite(this.projectDir, () => this.saveSystemVariables(value))
  }

  updateSharedSystemVariables(
    updates: readonly { key: string; value: string }[],
  ): Promise<SystemVariablesResource> {
    return enqueueProjectWrite(this.projectDir, () => {
      const current = this.readProjectSystemVariables()
      const byKey = new Map(current.variables.map((variable) => [variable.key, variable]))
      for (const update of updates) {
        const variable = byKey.get(update.key)
        if (!variable) throw new Error(`system variable was not found: ${update.key}`)
        if (variable.readonly) throw new Error(`system variable is read-only: ${update.key}`)
        if (variable.scope !== 'project') {
          throw new Error(`system variable is session-scoped: ${update.key}`)
        }
        variable.value = update.value
      }
      const resource = { version: 1 as const, variables: [...byKey.values()] }
      resolveSystemPromptVariables(resource.variables)
      this.writeSystemVariablesFile(resource)
      return resource
    })
  }

  onChange(listener: (change: ProjectResourceChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(): void {
    this.watcher?.close()
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
  }

  private validateSettings(value: unknown): ProjectSettings {
    if (!isObject(value)) throw new Error('settings must be an object')
    const maxMessages = value.max_messages
    if (!Number.isInteger(maxMessages) || Number(maxMessages) < 1 || Number(maxMessages) > 10_000) {
      throw new Error('max_messages must be an integer between 1 and 10000')
    }
    const mainTemplate = value.main_template
    if (typeof mainTemplate !== 'string' || !mainTemplate.trim()) {
      throw new Error('main_template must be a non-empty string')
    }
    const maxToolRounds = value.max_tool_rounds
    const toolTimeoutMs = value.tool_timeout_ms
    const llm = value.llm
    if (!Number.isInteger(maxToolRounds) || Number(maxToolRounds) < 1 || Number(maxToolRounds) > 100) {
      throw new Error('max_tool_rounds must be an integer between 1 and 100')
    }
    if (!Number.isInteger(toolTimeoutMs) || Number(toolTimeoutMs) < 100 || Number(toolTimeoutMs) > 600_000) {
      throw new Error('tool_timeout_ms must be an integer between 100 and 600000')
    }
    if (!isObject(llm)) throw new Error('llm must be an object')
    if (typeof llm.model !== 'string' || !llm.model.trim()) {
      throw new Error('llm.model must be a non-empty string')
    }
    if (typeof llm.base_url !== 'string' || !llm.base_url.trim()) {
      throw new Error('llm.base_url must be a non-empty URL')
    }
    let baseUrl: URL
    try {
      baseUrl = new URL(llm.base_url)
    } catch {
      throw new Error('llm.base_url must be a valid URL')
    }
    if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
      throw new Error('llm.base_url must use http or https')
    }
    if (llm.protocol !== 'responses' && llm.protocol !== 'chat-completions') {
      throw new Error('llm.protocol must be responses or chat-completions')
    }
    if (llm.api_key !== undefined && (typeof llm.api_key !== 'string' || !llm.api_key.trim())) {
      throw new Error('llm.api_key must be a non-empty string')
    }
    const context = value.context
    if (!isObject(context)) throw new Error('context must be an object')
    const maxInputTokens = context.max_input_tokens
    const reservedOutputTokens = context.reserved_output_tokens
    if (!Number.isInteger(maxInputTokens) || Number(maxInputTokens) < 1_024 || Number(maxInputTokens) > 10_000_000) {
      throw new Error('context.max_input_tokens must be an integer between 1024 and 10000000')
    }
    if (!Number.isInteger(reservedOutputTokens) || Number(reservedOutputTokens) < 128 || Number(reservedOutputTokens) >= Number(maxInputTokens)) {
      throw new Error('context.reserved_output_tokens must be an integer below max_input_tokens')
    }
    if (!Array.isArray(value.tools) || !value.tools.every((item) => typeof item === 'string' && item.trim())) {
      throw new Error('tools must be an array of project-relative manifest paths')
    }
    if (!Array.isArray(value.skills) || !value.skills.every((item) => typeof item === 'string' && item.trim())) {
      throw new Error('skills must be an array of project-relative skill directories')
    }
    if (!Array.isArray(value.harnesses) || !value.harnesses.every((item) => typeof item === 'string' && item.trim())) {
      throw new Error('harnesses must be an array of project-relative manifest paths')
    }
    const harnessPolicy = value.harness_policy
    if (!isObject(harnessPolicy)) throw new Error('harness_policy must be an object')
    if (!Number.isInteger(harnessPolicy.experience_top_k) || Number(harnessPolicy.experience_top_k) < 1 || Number(harnessPolicy.experience_top_k) > 20) {
      throw new Error('harness_policy.experience_top_k must be an integer between 1 and 20')
    }
    if (typeof harnessPolicy.experience_threshold !== 'number' || harnessPolicy.experience_threshold < 0 || harnessPolicy.experience_threshold > 1) {
      throw new Error('harness_policy.experience_threshold must be between 0 and 1')
    }
    if (typeof harnessPolicy.experience_auto_attach !== 'boolean') {
      throw new Error('harness_policy.experience_auto_attach must be a boolean')
    }
    if (!Array.isArray(value.tool_permissions) || !value.tool_permissions.every((item) => typeof item === 'string' && item.trim())) {
      throw new Error('tool_permissions must be an array of permission names')
    }
    return {
      main_template: mainTemplate,
      max_messages: Number(maxMessages),
      max_tool_rounds: Number(maxToolRounds),
      tool_timeout_ms: Number(toolTimeoutMs),
      llm: {
        model: llm.model.trim(),
        base_url: baseUrl.toString().replace(/\/$/, ''),
        protocol: llm.protocol,
        ...(typeof llm.api_key === 'string' ? { api_key: llm.api_key.trim() } : {}),
      },
      context: {
        max_input_tokens: Number(maxInputTokens),
        reserved_output_tokens: Number(reservedOutputTokens),
      },
      tools: [...value.tools] as string[],
      skills: [...value.skills] as string[],
      harnesses: [...value.harnesses] as string[],
      harness_policy: {
        experience_top_k: Number(harnessPolicy.experience_top_k),
        experience_threshold: harnessPolicy.experience_threshold,
        experience_auto_attach: harnessPolicy.experience_auto_attach,
      },
      tool_permissions: [...value.tool_permissions] as string[],
    }
  }

  private validateSystemVariables(value: unknown): SystemVariablesResource {
    if (!isObject(value) || value.version !== 1 || !Array.isArray(value.variables)) {
      throw new Error('system variables must contain version 1 and a variables array')
    }
    const keys = new Set<string>()
    const variables = value.variables.map((item, index) => {
      if (!isObject(item)) throw new Error(`variables[${index}] must be an object`)
      const key = typeof item.key === 'string' ? item.key.trim() : ''
      if (!/^[a-z][a-z0-9_]*$/.test(key)) {
        throw new Error(`variables[${index}].key must use lowercase snake_case`)
      }
      if (keys.has(key)) throw new Error(`duplicate system variable: ${key}`)
      keys.add(key)
      if (typeof item.value !== 'string' || typeof item.required !== 'boolean') {
        throw new Error(`variables[${index}] requires string value and boolean required`)
      }
      const type: SystemPromptVariableType = item.type === 'prompt_template'
        ? 'prompt_template'
        : 'text'
      if (item.type !== undefined && item.type !== 'text' && item.type !== 'prompt_template') {
        throw new Error(`variables[${index}].type must be text or prompt_template`)
      }
      if (item.readonly === true && item.scope === 'project') {
        throw new Error(`variables[${index}] readonly variables must be session-scoped`)
      }
      return {
        key,
        type,
        label: typeof item.label === 'string' ? item.label : key,
        description: typeof item.description === 'string' ? item.description : '',
        value: item.value,
        required: item.required,
        readonly: item.readonly === true,
        show_in_status: item.show_in_status === true,
        scope: item.scope === 'project' ? 'project' as const : 'session' as const,
        source: item.source === 'builtin' ? 'builtin' as const : 'project' as const,
      }
    })
    return { version: 1, variables }
  }

  private readProjectSystemVariables(): SystemVariablesResource {
    const resource = this.validateSystemVariables(
      this.readJson(this.systemVariablesFile, EMPTY_SYSTEM_VARIABLES),
    )
    resolveSystemPromptVariables(resource.variables)
    return {
      version: 1,
      variables: [
        ...resource.variables
          .filter((variable) => variable.key !== SYS_MESSAGE_VARIABLE.key)
          .map((variable) => ({
            ...variable,
            source: variable.readonly ? 'builtin' as const : 'project' as const,
          })),
        { ...SYS_MESSAGE_VARIABLE },
      ],
    }
  }

  private readJson(file: string, fallback: unknown): unknown {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback
  }

  private writeSystemVariablesFile(resource: SystemVariablesResource): void {
    this.writeJsonAtomic(this.systemVariablesFile, {
      version: 1,
      variables: resource.variables
        .filter((variable) => variable.key !== SYS_MESSAGE_VARIABLE.key)
        .map(({ source: _source, ...variable }) => variable),
    })
  }

  private readApiKey(): string | undefined {
    if (!fs.existsSync(this.secretsFile)) return undefined
    const value = this.readJson(this.secretsFile, {})
    if (!isObject(value) || value.version !== 1 || !isObject(value.llm)) {
      throw new Error('.capybara/secrets.json must contain version 1 and an llm object')
    }
    if (typeof value.llm.api_key !== 'string' || !value.llm.api_key.trim()) {
      throw new Error('.capybara/secrets.json llm.api_key must be a non-empty string')
    }
    return value.llm.api_key.trim()
  }

  private writeJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  }

  private writeJsonAtomic(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      try {
        fs.renameSync(temporary, file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        fs.rmSync(file, { force: true })
        fs.renameSync(temporary, file)
      }
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }

  private watch(): void {
    this.watcher = fs.watch(this.projectDir, { recursive: true }, (_event, filename) => {
      if (!filename) return
      const file = filename.replaceAll('\\', '/')
      const change = file === '.capybara/config.json' || file === '.capybara/secrets.json' || file === 'config.json'
        ? 'settings'
        : file === '.capybara/system-variables.json'
          ? 'system-variables'
          : file.startsWith('tools/') && file.endsWith('/manifest.json')
            ? 'tools'
          : file.startsWith('skills/')
            ? 'skills'
          : file.startsWith('harnesses/') || file.startsWith('.capybara/harnesses/')
              ? 'harnesses'
              : (
                  file.startsWith('.capybara/hooks/') || file.startsWith('hooks/')
                ) && file.endsWith('.ts')
                ? 'hooks'
              : undefined
      if (!change) return
      if (this.debounceTimer) clearTimeout(this.debounceTimer)
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = undefined
        this.listeners.forEach((listener) => listener(change))
      }, 50)
    })
  }
}
