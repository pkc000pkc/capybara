import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

import type {
  HookDiagnostic,
  HookCheckpoint,
  HookParameterDefinition,
  HookPermissions,
  HookSchedule,
  ProjectHookDefinition,
  RegisteredHook,
} from '#core/hooks/types'

const HOOK_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const MAX_HOOK_BYTES = 512 * 1024
const DEFAULT_SCHEDULE: HookSchedule = {
  priority: 0,
  timeoutMs: 10_000,
  onError: 'continue',
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function diagnosticText(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
}

export function compileHookSource(source: string, fileName: string): string {
  const imports = ts.preProcessFile(source, true, true).importedFiles.map((item) => item.fileName)
  const unsupported = imports.find((item) => item !== '@capybara-agent/sdk')
  if (unsupported) throw new Error(`Hook files may only import @capybara-agent/sdk: ${unsupported}`)
  const output = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      strict: true,
      esModuleInterop: true,
    },
  })
  const errors = (output.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  if (errors.length > 0) throw new Error(errors.map(diagnosticText).join('; '))
  return output.outputText
}

function loadDefinition(compiled: string, fileName: string): ProjectHookDefinition {
  const module = { exports: {} as Record<string, unknown> }
  const defineHook = <T>(value: T): T => value
  const context = vm.createContext({
    module,
    exports: module.exports,
    require: (specifier: string) => {
      if (specifier !== '@capybara-agent/sdk') throw new Error(`unsupported Hook import: ${specifier}`)
      return { defineHook }
    },
  })
  const script = new vm.Script(compiled, { filename: fileName })
  script.runInContext(context, { timeout: 200 })
  const definition = module.exports.default
  if (!isObject(definition)) throw new Error('Hook file must default export defineHook({...})')
  return definition as unknown as ProjectHookDefinition
}

function validateSchedule(value: unknown): HookSchedule {
  if (!isObject(value)) return { ...DEFAULT_SCHEDULE }
  const priority = value.priority ?? DEFAULT_SCHEDULE.priority
  const timeoutMs = value.timeoutMs ?? DEFAULT_SCHEDULE.timeoutMs
  const onError = value.onError ?? DEFAULT_SCHEDULE.onError
  if (!Number.isInteger(priority) || Number(priority) < -10_000 || Number(priority) > 10_000) {
    throw new Error('schedule.priority must be an integer between -10000 and 10000')
  }
  if (!Number.isInteger(timeoutMs) || Number(timeoutMs) < 100 || Number(timeoutMs) > 300_000) {
    throw new Error('schedule.timeoutMs must be an integer between 100 and 300000')
  }
  if (onError !== 'continue' && onError !== 'retry') {
    throw new Error('schedule.onError must be continue or retry')
  }
  return { priority: Number(priority), timeoutMs: Number(timeoutMs), onError }
}

function validatePermissions(value: unknown): HookPermissions {
  if (value === undefined) return {}
  if (!isObject(value)) throw new Error('permissions must be an object')
  const allowed = new Set(['llm', 'variables', 'messages', 'artifacts'])
  const unknown = Object.keys(value).find((key) => !allowed.has(key))
  if (unknown) throw new Error(`unsupported Hook permission: ${unknown}`)
  if (value.llm !== undefined && value.llm !== 'project') throw new Error('permissions.llm must be project')
  if (value.variables !== undefined && value.variables !== 'patch') throw new Error('permissions.variables must be patch')
  if (value.messages !== undefined && value.messages !== 'replace') throw new Error('permissions.messages must be replace')
  if (value.artifacts !== undefined && value.artifacts !== 'write') throw new Error('permissions.artifacts must be write')
  return value as HookPermissions
}

function validateParameters(value: unknown): HookParameterDefinition[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('parameters must be an array')
  const keys = new Set<string>()
  return value.map((parameter, index) => {
    if (!isObject(parameter)) throw new Error(`parameters[${index}] must be an object`)
    if (typeof parameter.key !== 'string' || !/^[a-z][a-zA-Z0-9]*$/.test(parameter.key)) {
      throw new Error(`parameters[${index}].key must use lower camelCase letters and numbers`)
    }
    if (keys.has(parameter.key)) throw new Error(`duplicate Hook parameter: ${parameter.key}`)
    keys.add(parameter.key)
    if (typeof parameter.label !== 'string' || !parameter.label.trim()) {
      throw new Error(`parameters[${index}].label must be a non-empty string`)
    }
    if (typeof parameter.defaultValue !== 'string') {
      throw new Error(`parameters[${index}].defaultValue must be a string`)
    }
    const input = parameter.input ?? 'text'
    if (input !== 'text' && input !== 'number') {
      throw new Error(`parameters[${index}].input must be text or number`)
    }
    if (parameter.description !== undefined && typeof parameter.description !== 'string') {
      throw new Error(`parameters[${index}].description must be a string`)
    }
    const min = parameter.min === undefined ? undefined : Number(parameter.min)
    const max = parameter.max === undefined ? undefined : Number(parameter.max)
    if (min !== undefined && !Number.isFinite(min)) throw new Error(`parameters[${index}].min must be finite`)
    if (max !== undefined && !Number.isFinite(max)) throw new Error(`parameters[${index}].max must be finite`)
    if (min !== undefined && max !== undefined && min > max) {
      throw new Error(`parameters[${index}].min must not exceed max`)
    }
    if (input === 'number') {
      const defaultNumber = Number(parameter.defaultValue)
      if (!Number.isFinite(defaultNumber)) throw new Error(`parameters[${index}].defaultValue must be numeric`)
      if (min !== undefined && defaultNumber < min) throw new Error(`parameters[${index}].defaultValue is below min`)
      if (max !== undefined && defaultNumber > max) throw new Error(`parameters[${index}].defaultValue exceeds max`)
    }
    return {
      key: parameter.key,
      label: parameter.label.trim(),
      ...(parameter.description ? { description: parameter.description.trim() } : {}),
      defaultValue: parameter.defaultValue,
      input,
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
    }
  })
}

function triggerInputs(source: string): string[] {
  const inputs = new Set<string>()
  for (const match of source.matchAll(/status\.([a-zA-Z][\w.]*)/g)) inputs.add(`status.${match[1]}`)
  for (const match of source.matchAll(/status\.variableTokens\s*\[\s*["']([^"']+)["']\s*\]/g)) {
    inputs.add(`status.variableTokens.${match[1]}`)
  }
  for (const match of source.matchAll(/changed\.has\(\s*["']([^"']+)["']\s*\)/g)) {
    inputs.add(`changed.${match[1]}`)
  }
  return [...inputs]
}

function summary(inputs: readonly string[]): string {
  const changed = inputs.find((item) => item.startsWith('changed.'))?.slice('changed.'.length)
  const status = inputs.some((item) => item.startsWith('status.'))
  return [status ? 'status' : undefined, changed].filter(Boolean).join(' + ') || 'after_loop'
}

function validateDefinition(
  value: ProjectHookDefinition,
  expectedName: string,
): Pick<RegisteredHook, 'name' | 'description' | 'enabled' | 'checkpoint' | 'schedule' | 'permissions' | 'parameters'> {
  if (typeof value.name !== 'string' || !HOOK_NAME.test(value.name)) {
    throw new Error('Hook name must use lowercase letters, numbers, and single hyphens')
  }
  if (value.name !== expectedName) throw new Error(`Hook name must match file name: ${expectedName}`)
  if (typeof value.description !== 'string' || !value.description.trim()) {
    throw new Error('Hook description must be a non-empty string')
  }
  if (typeof value.enabled !== 'boolean') throw new Error('Hook enabled must be a boolean')
  const checkpoint = value.checkpoint ?? 'after_loop'
  if (!(['after_loop', 'after_evaluation', 'after_replay'] satisfies HookCheckpoint[]).includes(checkpoint)) {
    throw new Error('Hook checkpoint must be after_loop, after_evaluation, or after_replay')
  }
  if (typeof value.trigger !== 'function') throw new Error('Hook trigger must be a function')
  if (typeof value.run !== 'function') throw new Error('Hook run must be a function')
  return {
    name: value.name,
    description: value.description.trim(),
    enabled: value.enabled,
    checkpoint,
    schedule: validateSchedule(value.schedule),
    permissions: validatePermissions(value.permissions),
    parameters: validateParameters(value.parameters),
  }
}

export class HookRegistry {
  readonly hooksDir: string

  constructor(readonly projectDir: string) {
    this.hooksDir = path.join(path.resolve(projectDir), '.capybara', 'hooks')
  }

  list(): RegisteredHook[] {
    if (!fs.existsSync(this.hooksDir)) return []
    return fs.readdirSync(this.hooksDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.startsWith('.'))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => this.inspect(path.join(this.hooksDir, entry.name)))
  }

  get(id: string): RegisteredHook | undefined {
    return this.list().find((hook) => hook.id === id)
  }

  validateContent(name: string, source: string): RegisteredHook {
    if (!HOOK_NAME.test(name)) throw new Error('Hook name must use kebab-case')
    if (Buffer.byteLength(source) > MAX_HOOK_BYTES) throw new Error(`Hook source exceeds ${MAX_HOOK_BYTES} bytes`)
    return this.inspectSource(path.join(this.hooksDir, `${name}.ts`), source)
  }

  create(name: string, source: string): RegisteredHook {
    const hook = this.validateContent(name, source)
    fs.mkdirSync(this.hooksDir, { recursive: true })
    fs.writeFileSync(hook.entryFile, source, { encoding: 'utf8', flag: 'wx' })
    return hook
  }

  save(id: string, source: string, revision: string): RegisteredHook {
    const current = this.get(id)
    if (!current) throw new Error('Hook resource was not found')
    if (current.revision !== revision) throw new Error('HOOK_REVISION_CONFLICT')
    const next = this.validateContent(current.name, source)
    fs.writeFileSync(current.entryFile, source, 'utf8')
    return next
  }

  remove(id: string, revision: string): void {
    const current = this.get(id)
    if (!current) throw new Error('Hook resource was not found')
    if (current.revision !== revision) throw new Error('HOOK_REVISION_CONFLICT')
    fs.unlinkSync(current.entryFile)
  }

  private inspect(file: string): RegisteredHook {
    const source = fs.readFileSync(file, 'utf8')
    if (Buffer.byteLength(source) > MAX_HOOK_BYTES) {
      return this.invalid(file, source, `Hook source exceeds ${MAX_HOOK_BYTES} bytes`)
    }
    try {
      return this.inspectSource(file, source)
    } catch (error) {
      return this.invalid(file, source, error instanceof Error ? error.message : String(error))
    }
  }

  private inspectSource(file: string, source: string): RegisteredHook {
    const expectedName = path.basename(file, '.ts')
    const compiled = compileHookSource(source, file)
    const definition = loadDefinition(compiled, file)
    const validated = validateDefinition(definition, expectedName)
    const inputs = triggerInputs(source)
    return {
      id: validated.name,
      ...validated,
      entryFile: file,
      source,
      revision: hash(source),
      triggerSummary: inputs.length ? summary(inputs) : validated.checkpoint,
      triggerInputs: inputs,
      diagnostics: [],
      loadable: true,
    }
  }

  private invalid(file: string, source: string, message: string): RegisteredHook {
    const name = path.basename(file, '.ts')
    const diagnostic: HookDiagnostic = { severity: 'error', code: 'HOOK_INVALID', message }
    return {
      id: name,
      name,
      description: 'Invalid project Hook',
      entryFile: file,
      source,
      revision: hash(source),
      enabled: false,
      checkpoint: 'after_loop',
      schedule: { ...DEFAULT_SCHEDULE },
      permissions: {},
      parameters: [],
      triggerSummary: 'invalid',
      triggerInputs: [],
      diagnostics: [diagnostic],
      loadable: false,
    }
  }
}
