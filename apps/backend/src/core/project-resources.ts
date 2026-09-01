import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { loadLlmConfig } from '#util/llm/config'
import { enqueueProjectWrite } from '#core/project-write-queue'
import {
  resolveSystemPromptVariables,
  validateSystemPromptVariableValue,
  canonicalSystemPromptVariableValue,
  isSystemPromptVariableType,
  normalizeSystemPromptVariableTemplatePath,
  type SystemPromptVariableType,
  type SystemPromptVariableValue,
} from '#core/system-prompt-templates'

export type SystemVariableScope = 'session' | 'project'

export interface SystemVariableDefinition {
  key: string
  type: SystemPromptVariableType
  label: string
  description: string
  value: SystemPromptVariableValue
  /** Optional plugin-relative Jinja2 source for prompt_template variables. */
  template?: string
  required: boolean
  readonly: boolean
  show_in_status: boolean
  scope?: SystemVariableScope
  source: 'builtin' | 'project' | 'plugin'
  owner?: string
}

export interface SystemVariablesResource {
  version: 1
  variables: SystemVariableDefinition[]
}

type SystemVariableChangeExpectation = {
  expected_value_sha256?: string | null
}

export type SystemVariableChange = ({
  op: 'upsert'
  key: string
  type?: SystemPromptVariableType
  label?: string
  description?: string
  value: SystemPromptVariableValue
  required?: boolean
  show_in_status?: boolean
  scope?: SystemVariableScope
} | {
  op: 'patch'
  key: string
  edits: Array<{
    old_text: string
    new_text: string
  }>
} | {
  op: 'json_patch'
  key: string
  patch: Array<{
    op: 'add' | 'remove' | 'replace'
    path: string
    value?: SystemPromptVariableValue
  }>
} | {
  op: 'remove'
  key: string
}) & SystemVariableChangeExpectation

export interface SystemVariableDiff {
  op: 'add' | 'replace' | 'remove'
  key: string
  before?: SystemVariableDefinition
  after?: SystemVariableDefinition
}

export interface SystemVariablesState {
  revision: string
  resource: SystemVariablesResource
}

export interface SystemVariableChangeResult extends SystemVariablesState {
  diff: SystemVariableDiff[]
}

export interface ProjectSettings {
  resource_format: 1 | 2
  main_template: string
  max_messages: number
  max_tool_rounds: number
  tool_timeout_ms: number
  llm: {
    model: string
    base_url: string
    protocol: 'responses' | 'codex-like' | 'chat-completions'
    max_retries: number
    api_key?: string
  }
  context: {
    context_window_tokens: number
    max_input_tokens: number
    reserved_output_tokens: number
  }
  tools: string[]
  skills: string[]
  harnesses: string[]
  plugins: Array<{
    id: string
    path: string
    enabled: boolean
  }>
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
  | 'plugins'

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
const CACHE_VARIABLE: SystemVariableDefinition = {
  key: 'cache',
  type: 'object',
  label: 'Runtime cache',
  description: 'Runtime-managed temporary Loop, model, and tool-call context exposed as builtin.cache.',
  value: {
    version: 1,
    summary: '',
    messages: [],
    loop: { run_id: '', iteration: 0, tool_round: 0, continuation_round: 0 },
    compression_count: 0,
    compressed_at: '',
  },
  required: false,
  readonly: true,
  show_in_status: true,
  source: 'builtin',
}
const RUNTIME_VARIABLE_KEYS = new Set([SYS_MESSAGE_VARIABLE.key, CACHE_VARIABLE.key])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneVariableValue(value: SystemPromptVariableValue): SystemPromptVariableValue {
  return JSON.parse(JSON.stringify(value)) as SystemPromptVariableValue
}

function jsonPointerTokens(pointer: string): string[] {
  if (pointer === '') return []
  if (!pointer.startsWith('/')) throw new Error('JSON Patch paths must start with /')
  return pointer.slice(1).split('/').map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'))
}

function applyVariableJsonPatch(
  source: SystemPromptVariableValue,
  operations: Array<{ op: 'add' | 'remove' | 'replace'; path: string; value?: SystemPromptVariableValue }>,
): SystemPromptVariableValue {
  if (!Array.isArray(source) && !isObject(source)) {
    throw new Error('json_patch is only supported for array and object variables')
  }
  let result = cloneVariableValue(source)
  for (const operation of operations) {
    const tokens = jsonPointerTokens(operation.path)
    if (tokens.length === 0) {
      if (operation.op === 'remove' || operation.value === undefined) throw new Error('JSON Patch root replacement requires value')
      result = cloneVariableValue(operation.value)
      continue
    }
    const parentTokens = tokens.slice(0, -1)
    const leaf = tokens.at(-1) as string
    let parent: unknown = result
    for (const token of parentTokens) {
      if (Array.isArray(parent)) {
        const index = Number(token)
        if (!Number.isInteger(index) || index < 0 || index >= parent.length) throw new Error(`JSON Patch path not found: ${operation.path}`)
        parent = parent[index]
      } else if (isObject(parent) && token in parent) {
        parent = parent[token]
      } else throw new Error(`JSON Patch path not found: ${operation.path}`)
    }
    if (Array.isArray(parent)) {
      const index = leaf === '-' ? parent.length : Number(leaf)
      if (!Number.isInteger(index) || index < 0 || index > parent.length || (operation.op !== 'add' && index >= parent.length)) {
        throw new Error(`JSON Patch array index is invalid: ${operation.path}`)
      }
      if (operation.op === 'add') parent.splice(index, 0, cloneVariableValue(operation.value as SystemPromptVariableValue))
      else if (operation.op === 'remove') parent.splice(index, 1)
      else {
        if (operation.value === undefined) throw new Error(`JSON Patch replace requires value: ${operation.path}`)
        parent[index] = cloneVariableValue(operation.value)
      }
    } else if (isObject(parent)) {
      if (operation.op === 'remove') {
        if (!(leaf in parent)) throw new Error(`JSON Patch path not found: ${operation.path}`)
        delete parent[leaf]
      } else {
        if (operation.value === undefined) throw new Error(`JSON Patch ${operation.op} requires value: ${operation.path}`)
        if (operation.op === 'replace' && !(leaf in parent)) throw new Error(`JSON Patch path not found: ${operation.path}`)
        parent[leaf] = cloneVariableValue(operation.value)
      }
    } else throw new Error(`JSON Patch parent is not a container: ${operation.path}`)
  }
  return result
}

function persistedSystemVariables(resource: SystemVariablesResource): SystemVariablesResource {
  return {
    version: 1,
    variables: resource.variables
      .filter((variable) => !RUNTIME_VARIABLE_KEYS.has(variable.key))
      .map(({ source: _source, ...variable }) => ({ ...variable, source: 'project' as const })),
  }
}

export function systemVariablesRevision(resource: SystemVariablesResource): string {
  const persisted = persistedSystemVariables(resource)
  const value = persisted.variables.map(({ source: _source, ...variable }) => variable)
  return createHash('sha256').update(JSON.stringify({ version: 1, variables: value })).digest('hex')
}

export function systemVariableValueHash(value: SystemPromptVariableValue | undefined): string {
  if (value === undefined) throw new Error('system variable value is required')
  return createHash('sha256').update(canonicalSystemPromptVariableValue(value)).digest('hex')
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
    if (value.context !== undefined && !isObject(value.context)) {
      throw new Error('context must be an object')
    }
    const configuredContext = value.context ?? {}
    const llm = loadLlmConfig()
    if (!Number.isInteger(maxMessages) || Number(maxMessages) < 1 || Number(maxMessages) > 10_000) {
      throw new Error('max_messages must be an integer between 1 and 10000')
    }
    if (typeof mainTemplate !== 'string' || !mainTemplate.trim()) {
      throw new Error('main_template must be a non-empty string')
    }
    const configuredLlm = value.llm === undefined
      ? {
          model: llm.model,
          base_url: llm.baseUrl,
          protocol: llm.protocol,
          max_retries: llm.maxRetries,
        }
      : isObject(value.llm)
        ? { ...value.llm, max_retries: value.llm.max_retries ?? llm.maxRetries }
        : value.llm
    const secretApiKey = this.readApiKey()
    const projectLlm = secretApiKey && isObject(configuredLlm)
      ? { ...configuredLlm, api_key: secretApiKey }
      : configuredLlm
    return this.validateSettings({
      resource_format: value.resource_format ?? (Array.isArray(value.plugins) ? 2 : 1),
      main_template: mainTemplate,
      max_messages: maxMessages,
      max_tool_rounds: value.max_tool_rounds ?? 8,
      tool_timeout_ms: value.tool_timeout_ms ?? 15_000,
      llm: projectLlm,
      context: {
        context_window_tokens: configuredContext.context_window_tokens
          ?? configuredContext.max_input_tokens
          ?? 16_000,
        max_input_tokens: configuredContext.max_input_tokens ?? 16_000,
        reserved_output_tokens: configuredContext.reserved_output_tokens ?? 2_000,
      },
      tools: value.tools ?? [],
      skills: value.skills ?? [],
      harnesses: value.harnesses ?? [],
      plugins: value.plugins ?? [],
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
    if (value.context !== undefined && !isObject(value.context)) {
      throw new Error('context must be an object')
    }
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
        ...(value.llm.max_retries === undefined ? {} : { max_retries: value.llm.max_retries }),
        ...(value.llm.api_key === undefined || value.llm.api_key === '' || value.llm.api_key === null
          ? {}
          : { api_key: value.llm.api_key }),
      }
    }
    const next = {
      ...current,
      ...(value.resource_format === undefined ? {} : { resource_format: value.resource_format }),
      ...(value.max_messages === undefined ? {} : { max_messages: value.max_messages }),
      ...(value.max_tool_rounds === undefined ? {} : { max_tool_rounds: value.max_tool_rounds }),
      ...(value.tool_timeout_ms === undefined ? {} : { tool_timeout_ms: value.tool_timeout_ms }),
      llm: nextLlm,
      ...(value.context === undefined ? {} : { context: { ...current.context, ...value.context } }),
      ...(value.tools === undefined ? {} : { tools: value.tools }),
      ...(value.skills === undefined ? {} : { skills: value.skills }),
      ...(value.harnesses === undefined ? {} : { harnesses: value.harnesses }),
      ...(value.plugins === undefined ? {} : { plugins: value.plugins }),
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

  saveSkillDirectories(skillDirectories: readonly string[]): ProjectSettings {
    const settings = this.resolveSettings({ skills: [...skillDirectories] })
    const source = fs.existsSync(this.configFile) ? this.configFile : this.legacyConfigFile
    const current = this.readJson(source, {})
    if (!isObject(current)) throw new Error('.capybara/config.json must contain an object')
    this.writeJsonAtomic(this.configFile, { ...current, skills: settings.skills })
    return settings
  }

  readSystemVariables(): SystemVariablesResource {
    return this.readProjectSystemVariables()
  }

  readSystemVariablesState(): SystemVariablesState {
    const resource = this.readProjectSystemVariables()
    return { revision: systemVariablesRevision(resource), resource }
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
         canonicalSystemPromptVariableValue(variable.value) !== canonicalSystemPromptVariableValue(existing.value) ||
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

  applySystemVariableChanges(
    baseRevision: string,
    changes: readonly SystemVariableChange[],
  ): Promise<SystemVariableChangeResult> {
    return enqueueProjectWrite(this.projectDir, () => {
      const current = this.readSystemVariablesState()
      if (current.revision !== baseRevision) {
        throw new Error(`system variables revision conflict; current revision is ${current.revision}`)
      }
      if (changes.length === 0) throw new Error('system variable changes must not be empty')
      const duplicateKeys = changes
        .map((change) => change.key)
        .filter((key, index, keys) => keys.indexOf(key) !== index)
      if (duplicateKeys.length > 0) {
        throw new Error(`system variable changes contain duplicate keys: ${[...new Set(duplicateKeys)].join(', ')}`)
      }

      const before = new Map(current.resource.variables.map((variable) => [variable.key, variable]))
      const after = new Map(before)
      for (const change of changes) {
        if (!/^[a-z][a-z0-9_]*$/.test(change.key)) {
          throw new Error(`system variable key must use lowercase snake_case: ${change.key}`)
        }
        const existing = after.get(change.key)
        if (existing?.readonly) throw new Error(`system variable is read-only: ${change.key}`)
        if (change.expected_value_sha256 !== undefined) {
          const expected = change.expected_value_sha256
          if (expected === null) {
            if (existing) {
              throw new Error(`system variable already exists but absence was expected: ${change.key}`)
            }
          } else {
            if (!/^[a-f0-9]{64}$/.test(expected)) {
              throw new Error(`system variable expected_value_sha256 must be a lowercase SHA-256: ${change.key}`)
            }
            if (!existing) {
              throw new Error(`system variable was not found but an existing value was expected: ${change.key}`)
            }
            if (systemVariableValueHash(existing.value) !== expected) {
              throw new Error(`system variable value changed since it was read: ${change.key}`)
            }
          }
        }
        if (change.op === 'remove') {
          if (!existing) throw new Error(`system variable was not found: ${change.key}`)
          after.delete(change.key)
          continue
        }
        if (change.op === 'patch') {
          if (!existing) throw new Error(`system variable was not found: ${change.key}`)
          if (typeof existing.value !== 'string') throw new Error(`system variable patch is only supported for string values: ${change.key}`)
          if (change.edits.length === 0 || change.edits.length > 50) {
            throw new Error(`system variable patch requires 1-50 edits: ${change.key}`)
          }
          let value = existing.value
          for (const [index, edit] of change.edits.entries()) {
            if (!edit.old_text) {
              throw new Error(`system variable patch old_text must not be empty: ${change.key}[${index}]`)
            }
            const matchIndex = value.indexOf(edit.old_text)
            const nextMatchIndex = matchIndex < 0
              ? -1
              : value.indexOf(edit.old_text, matchIndex + 1)
            if (matchIndex < 0 || nextMatchIndex >= 0) {
              const matches = matchIndex < 0 ? 0 : 2
              throw new Error(
                `system variable patch old_text must match exactly once: ${change.key}[${index}] matched ${matches === 0 ? '0' : 'more than 1'} times`,
              )
            }
            value = `${value.slice(0, matchIndex)}${edit.new_text}${value.slice(matchIndex + edit.old_text.length)}`
          }
          after.set(change.key, { ...existing, value, source: 'project' })
          continue
        }
        if (change.op === 'json_patch') {
          if (!existing) throw new Error(`system variable was not found: ${change.key}`)
          if (!Array.isArray(existing.value) && !isObject(existing.value)) {
            throw new Error(`system variable json_patch is only supported for array or object values: ${change.key}`)
          }
          if (change.patch.length === 0 || change.patch.length > 100) {
            throw new Error(`system variable json_patch requires 1-100 operations: ${change.key}`)
          }
          const value = applyVariableJsonPatch(existing.value as SystemPromptVariableValue, change.patch)
          after.set(change.key, { ...existing, value, source: 'project' })
          continue
        }
        after.set(change.key, {
          key: change.key,
          type: change.type ?? existing?.type ?? 'text',
          label: change.label ?? existing?.label ?? change.key,
          description: change.description ?? existing?.description ?? '',
          value: change.value,
          required: change.required ?? existing?.required ?? false,
          readonly: false,
          show_in_status: change.show_in_status ?? existing?.show_in_status ?? false,
          scope: change.scope ?? existing?.scope ?? 'session',
          source: 'project',
        })
      }

      const candidate = { version: 1 as const, variables: [...after.values()] }
      resolveSystemPromptVariables(candidate.variables)
      const diff: SystemVariableDiff[] = []
      for (const change of changes) {
        const previous = before.get(change.key)
        const next = after.get(change.key)
        if (JSON.stringify(previous) === JSON.stringify(next)) continue
        if (!previous && next) {
          diff.push({ op: 'add', key: change.key, after: next })
          continue
        }
        if (previous && !next) {
          diff.push({ op: 'remove', key: change.key, before: previous })
          continue
        }
        diff.push({
          op: 'replace',
          key: change.key,
          before: previous,
          after: next,
        })
      }
      if (diff.length === 0) return { ...current, diff }
      const resource = this.saveSystemVariables(candidate)
      return { revision: systemVariablesRevision(resource), resource, diff }
    })
  }

  updateSharedSystemVariables(
    updates: readonly { key: string; value: SystemPromptVariableValue }[],
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

  updateExperimentSystemVariables(
    updates: readonly { key: string; value: SystemPromptVariableValue }[],
  ): Promise<SystemVariablesResource> {
    return enqueueProjectWrite(this.projectDir, () => {
      const current = this.readProjectSystemVariables()
      const byKey = new Map(current.variables.map((variable) => [variable.key, variable]))
      for (const update of updates) {
        const variable = byKey.get(update.key)
        if (!variable) throw new Error(`system variable was not found: ${update.key}`)
        if (variable.readonly) throw new Error(`system variable is read-only: ${update.key}`)
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
    const resourceFormat = value.resource_format
    if (resourceFormat !== 1 && resourceFormat !== 2) {
      throw new Error('resource_format must be 1 or 2')
    }
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
    if (
      !Number.isInteger(maxToolRounds)
      || (Number(maxToolRounds) !== -1 && Number(maxToolRounds) < 1)
    ) {
      throw new Error('max_tool_rounds must be -1 or a positive integer')
    }
    if (
      !Number.isInteger(toolTimeoutMs)
      || (Number(toolTimeoutMs) !== -1 && (Number(toolTimeoutMs) < 100 || Number(toolTimeoutMs) > 600_000))
    ) {
      throw new Error('tool_timeout_ms must be -1 or an integer between 100 and 600000')
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
    if (
      llm.protocol !== 'responses'
      && llm.protocol !== 'codex-like'
      && llm.protocol !== 'chat-completions'
    ) {
      throw new Error('llm.protocol must be responses, codex-like, or chat-completions')
    }
    if (
      !Number.isInteger(llm.max_retries)
      || (Number(llm.max_retries) !== -1 && Number(llm.max_retries) < 0)
    ) {
      throw new Error('llm.max_retries must be -1 or a non-negative integer')
    }
    if (llm.api_key !== undefined && (typeof llm.api_key !== 'string' || !llm.api_key.trim())) {
      throw new Error('llm.api_key must be a non-empty string')
    }
    const context = value.context
    if (!isObject(context)) throw new Error('context must be an object')
    const contextWindowTokens = context.context_window_tokens
    const maxInputTokens = context.max_input_tokens
    const reservedOutputTokens = context.reserved_output_tokens
    if (!Number.isInteger(contextWindowTokens) || Number(contextWindowTokens) < 1_024 || Number(contextWindowTokens) > 10_000_000) {
      throw new Error('context.context_window_tokens must be an integer between 1024 and 10000000')
    }
    if (!Number.isInteger(maxInputTokens) || Number(maxInputTokens) < 1_024 || Number(maxInputTokens) > 10_000_000) {
      throw new Error('context.max_input_tokens must be an integer between 1024 and 10000000')
    }
    if (Number(maxInputTokens) > Number(contextWindowTokens)) {
      throw new Error('context.max_input_tokens must not exceed context_window_tokens')
    }
    if (!Number.isInteger(reservedOutputTokens) || Number(reservedOutputTokens) < 128 || Number(reservedOutputTokens) >= Number(contextWindowTokens)) {
      throw new Error('context.reserved_output_tokens must be an integer below context_window_tokens')
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
    if (!Array.isArray(value.plugins)) throw new Error('plugins must be an array')
    const pluginIds = new Set<string>()
    const plugins = value.plugins.map((item, index) => {
      if (!isObject(item)) throw new Error(`plugins[${index}] must be an object`)
      const id = typeof item.id === 'string' ? item.id.trim() : ''
      const pluginPath = typeof item.path === 'string' ? item.path.trim().replace(/\\/g, '/') : ''
      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) {
        throw new Error(`plugins[${index}].id must use kebab-case`)
      }
      if (!pluginPath || path.isAbsolute(pluginPath) || pluginPath.split('/').includes('..')) {
        throw new Error(`plugins[${index}].path must be project-relative`)
      }
      if (typeof item.enabled !== 'boolean') throw new Error(`plugins[${index}].enabled must be boolean`)
      if (pluginIds.has(id)) throw new Error(`duplicate plugin id: ${id}`)
      pluginIds.add(id)
      return { id, path: pluginPath, enabled: item.enabled }
    })
    const duplicatePluginPath = plugins.map((plugin) => plugin.path)
      .find((pluginPath, index, paths) => paths.indexOf(pluginPath) !== index)
    if (duplicatePluginPath) throw new Error(`duplicate plugin path: ${duplicatePluginPath}`)
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
      resource_format: resourceFormat,
      main_template: mainTemplate,
      max_messages: Number(maxMessages),
      max_tool_rounds: Number(maxToolRounds),
      tool_timeout_ms: Number(toolTimeoutMs),
      llm: {
        model: llm.model.trim(),
        base_url: baseUrl.toString().replace(/\/$/, ''),
        protocol: llm.protocol,
        max_retries: Number(llm.max_retries),
        ...(typeof llm.api_key === 'string' ? { api_key: llm.api_key.trim() } : {}),
      },
      context: {
        context_window_tokens: Number(contextWindowTokens),
        max_input_tokens: Number(maxInputTokens),
        reserved_output_tokens: Number(reservedOutputTokens),
      },
      tools: [...value.tools] as string[],
      skills: [...value.skills] as string[],
      harnesses: [...value.harnesses] as string[],
      plugins,
      harness_policy: {
        experience_top_k: Number(harnessPolicy.experience_top_k),
        experience_threshold: harnessPolicy.experience_threshold,
        experience_auto_attach: harnessPolicy.experience_auto_attach,
      },
      tool_permissions: [...value.tool_permissions] as string[],
    }
  }

  validateSystemVariables(value: unknown): SystemVariablesResource {
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
      if (typeof item.required !== 'boolean') {
        throw new Error(`variables[${index}] requires a boolean required field`)
      }
      const typeValue = item.type ?? 'text'
      if (!isSystemPromptVariableType(typeValue)) {
        throw new Error(`variables[${index}].type is unsupported`)
      }
      const type: SystemPromptVariableType = typeValue
      const template = item.template === undefined
        ? undefined
        : normalizeSystemPromptVariableTemplatePath(item.template, `variables[${index}].template`)
      if (template && type !== 'prompt_template') {
        throw new Error(`variables[${index}].template is only supported for prompt_template variables`)
      }
      try {
        validateSystemPromptVariableValue(type, item.value, `variables[${index}].value`)
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error))
      }
      if (item.readonly === true && item.scope === 'project') {
        throw new Error(`variables[${index}] readonly variables must be session-scoped`)
      }
      return {
        key,
        type,
        label: typeof item.label === 'string' ? item.label : key,
        description: typeof item.description === 'string' ? item.description : '',
        value: item.value as SystemPromptVariableValue,
        ...(template ? { template } : {}),
        required: item.required,
        readonly: item.readonly === true,
        show_in_status: item.show_in_status === true,
        scope: item.scope === 'project' ? 'project' as const : 'session' as const,
        source: item.source === 'builtin'
          ? 'builtin' as const
          : item.source === 'plugin' ? 'plugin' as const : 'project' as const,
        ...(typeof item.owner === 'string' && item.owner.trim() ? { owner: item.owner.trim() } : {}),
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
          .filter((variable) => !RUNTIME_VARIABLE_KEYS.has(variable.key))
          .map((variable) => ({
            ...variable,
            source: variable.readonly ? 'builtin' as const : 'project' as const,
          })),
        { ...SYS_MESSAGE_VARIABLE },
        { ...CACHE_VARIABLE },
      ],
    }
  }

  private readJson(file: string, fallback: unknown): unknown {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback
  }

  private writeSystemVariablesFile(resource: SystemVariablesResource): void {
    const persisted = persistedSystemVariables(resource)
    this.writeJsonAtomic(this.systemVariablesFile, {
      version: persisted.version,
      variables: persisted.variables.map(({ source: _source, ...variable }) => variable),
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
    this.writeJsonAtomic(file, value)
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
          : file === 'capybara.plugin.json' || file.startsWith('plugins/')
            ? 'plugins'
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
