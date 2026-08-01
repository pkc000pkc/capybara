import fs from 'node:fs'
import path from 'node:path'
import nunjucks from 'nunjucks'

export type RenderReason = 'manual' | 'properties' | 'template'

export interface ContextBuilderOptions {
  projectDir?: string
  mainFile?: string
  properties?: Record<string, unknown>
  watch?: boolean
  debounceMs?: number
}

export interface RenderEvent {
  output: string
  reason: RenderReason
  status: 'success' | 'warning'
  missingVariables: string[]
  includedFiles: string[]
  changedFile?: string
}

type RenderListener = (event: RenderEvent) => void
type ErrorListener = (error: Error) => void

/**
 * 加载一个 Prompt 项目，并在变量或模板变化时重新渲染入口模板。
 */
export class ContextBuilder {
  readonly projectDir: string
  readonly mainFile: string

  private readonly properties: Record<string, unknown>
  private readonly environment: nunjucks.Environment
  private readonly renderListeners = new Set<RenderListener>()
  private readonly errorListeners = new Set<ErrorListener>()
  private readonly debounceMs: number
  private readonly missingVariables = new Set<string>()
  private readonly loadedTemplateFiles = new Set<string>()
  private readonly ignoredFileEvents = new Map<string, number>()
  private lastMissingVariables: string[] = []
  private lastIncludedFiles: string[] = []
  private watcher?: fs.FSWatcher
  private debounceTimer?: NodeJS.Timeout

  constructor(options: ContextBuilderOptions = {}) {
    this.projectDir = path.resolve(options.projectDir ?? process.env.PROJECT_DIR ?? '.')
    this.mainFile = options.mainFile ?? 'main.j2'
    this.properties = this.normalizeProperties(options.properties ?? {})
    this.debounceMs = options.debounceMs ?? 50

    const loader = new nunjucks.FileSystemLoader(this.projectDir, {
      noCache: true,
      watch: false,
    })
    const getSource = loader.getSource.bind(loader)
    loader.getSource = (name) => {
      this.loadedTemplateFiles.add(this.normalizeTemplateName(name))
      return getSource(name)
    }
    this.environment = new nunjucks.Environment(loader, {
      autoescape: false,
      throwOnUndefined: false,
    })
    this.trackMissingVariables()

    if (options.watch ?? true) {
      this.watch()
    }
  }

  setProperty(key: string, value: unknown): string {
    this.properties[key] = this.trackValue(value ?? null, key)
    return this.render('properties')
  }

  setProperties(values: Record<string, unknown>, render = true): string {
    Object.assign(this.properties, this.normalizeProperties(values))
    return render ? this.render('properties') : ''
  }

  getProperty<T = unknown>(key: string): T | null {
    return (this.properties[key] ?? null) as T | null
  }

  getProperties(): Readonly<Record<string, unknown>> {
    return { ...this.properties }
  }

  getMissingVariables(): readonly string[] {
    return [...this.lastMissingVariables]
  }

  getIncludedFiles(): readonly string[] {
    return [...this.lastIncludedFiles]
  }

  build(): string {
    return this.render('manual')
  }

  saveTemplate(file: string, content: string): string {
    const name = this.normalizeTemplateName(file)
    const target = path.resolve(this.projectDir, name)
    const relative = path.relative(this.projectDir, target)
    if (relative.startsWith('..') || path.isAbsolute(relative) || path.extname(target) !== '.j2') {
      throw new Error('template path must be a .j2 file inside the project directory')
    }

    this.ignoredFileEvents.set(name, Date.now() + 500)
    fs.writeFileSync(target, content, 'utf8')
    return this.render('template', name)
  }

  onRender(listener: RenderListener): () => void {
    this.renderListeners.add(listener)
    return () => this.renderListeners.delete(listener)
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  close(): void {
    this.watcher?.close()
    this.watcher = undefined

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = undefined
    }
  }

  private render(reason: RenderReason, changedFile?: string): string {
    let output: string
    this.missingVariables.clear()
    this.loadedTemplateFiles.clear()

    try {
      output = this.environment.render(this.mainFile, this.properties)
    } catch (error) {
      const renderError = error instanceof Error ? error : new Error(String(error))
      this.errorListeners.forEach((listener) => listener(renderError))
      throw renderError
    }

    this.lastMissingVariables = [...this.missingVariables].sort()
    const normalizedMainFile = this.normalizeTemplateName(this.mainFile)
    this.lastIncludedFiles = [...this.loadedTemplateFiles]
      .filter((file) => file !== normalizedMainFile)
      .sort()
    const event: RenderEvent = {
      output,
      reason,
      status: this.lastMissingVariables.length > 0 ? 'warning' : 'success',
      missingVariables: [...this.lastMissingVariables],
      includedFiles: [...this.lastIncludedFiles],
      changedFile,
    }
    this.renderListeners.forEach((listener) => listener(event))
    return output
  }

  private normalizeProperties(values: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, this.trackValue(value ?? null, key)]),
    )
  }

  private trackValue(value: unknown, path: string): unknown {
    if (Array.isArray(value)) {
      return value.map((item, index) => this.trackValue(item, `${path}.${index}`))
    }
    if (typeof value !== 'object' || value === null) return value
    const tracked = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, this.trackValue(item, `${path}.${key}`)]),
    )
    return new Proxy(tracked, {
      get: (target, property, receiver) => {
        if (Reflect.has(target, property)) return Reflect.get(target, property, receiver)
        if (typeof property === 'string') this.missingVariables.add(`${path}.${property}`)
        return null
      },
    })
  }

  private normalizeTemplateName(name: string): string {
    return name.replaceAll('\\', '/')
  }

  /**
   * Nunjucks 会从 globals 查找上下文中不存在的变量；用代理记录这些查找并返回 null。
   */
  private trackMissingVariables(): void {
    const environment = this.environment as nunjucks.Environment & {
      globals: Record<string, unknown>
    }
    const globals = environment.globals

    environment.globals = new Proxy(globals, {
      has(target, property) {
        return typeof property === 'string' || Reflect.has(target, property)
      },
      get: (target, property, receiver) => {
        if (Reflect.has(target, property)) {
          return Reflect.get(target, property, receiver)
        }
        if (typeof property === 'string') {
          this.missingVariables.add(property)
        }
        return null
      },
    })
  }

  private watch(): void {
    this.watcher = fs.watch(
      this.projectDir,
      { recursive: true },
      (_eventType, filename) => {
        if (!filename || path.extname(filename) !== '.j2') {
          return
        }
        const name = this.normalizeTemplateName(filename)
        const ignoredUntil = this.ignoredFileEvents.get(name) ?? 0
        if (ignoredUntil > Date.now()) {
          return
        }
        this.ignoredFileEvents.delete(name)

        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer)
        }

        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = undefined
          try {
            this.render('template', name)
          } catch {
            // 文件监听回调不能抛出；错误已由 render 通知订阅者。
          }
        }, this.debounceMs)
      },
    )

    this.watcher.on('error', (error) => {
      this.errorListeners.forEach((listener) => listener(error))
    })
  }
}
