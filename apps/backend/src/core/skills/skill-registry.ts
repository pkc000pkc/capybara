import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'yaml'

import type { AgentSkillDefinition, RegisteredSkill } from '#core/skills/types'

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/
const SKILL_NAME = /^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$/
const FRONTMATTER_FIELDS = new Set([
  'name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools',
])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function optionalString(value: unknown, field: string, maximum?: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`)
  const normalized = value.trim()
  if (maximum !== undefined && normalized.length > maximum) {
    throw new Error(`${field} must be at most ${maximum} characters`)
  }
  return normalized
}

export function parseSkillDocument(
  content: string,
  directoryName: string,
  requireDirectoryMatch = true,
): AgentSkillDefinition {
  const match = FRONTMATTER.exec(content)
  if (!match) throw new Error('SKILL.md must start with YAML frontmatter')
  const frontmatter = match[1] ?? ''
  const body = match[2] ?? ''

  let value: unknown
  try {
    value = parse(frontmatter)
  } catch (error) {
    throw new Error(`SKILL.md frontmatter is invalid YAML: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isObject(value)) throw new Error('SKILL.md frontmatter must be a YAML mapping')
  const unknown = Object.keys(value).find((field) => !FRONTMATTER_FIELDS.has(field))
  if (unknown) throw new Error(`SKILL.md frontmatter has unsupported field: ${unknown}`)

  const name = optionalString(value.name, 'name')
  const description = optionalString(value.description, 'description', 1024)
  if (!name || !SKILL_NAME.test(name) || name.length > 64) {
    throw new Error('name must use 1-64 lowercase letters, numbers, and single hyphens')
  }
  if (requireDirectoryMatch && name !== directoryName) {
    throw new Error(`name must match skill directory: ${directoryName}`)
  }
  if (!description) throw new Error('description is required')

  const license = optionalString(value.license, 'license')
  const compatibility = optionalString(value.compatibility, 'compatibility', 500)
  const allowedTools = optionalString(value['allowed-tools'], 'allowed-tools')

  const metadata: Record<string, string> = {}
  if (value.metadata !== undefined) {
    if (!isObject(value.metadata)) throw new Error('metadata must be a string mapping')
    for (const [key, item] of Object.entries(value.metadata)) {
      if (typeof item !== 'string') throw new Error(`metadata.${key} must be a string`)
      metadata[key] = item
    }
  }

  return {
    name,
    description,
    ...(license ? { license } : {}),
    ...(compatibility ? { compatibility } : {}),
    metadata,
    ...(allowedTools ? { allowedTools } : {}),
    body,
  }
}

export class SkillRegistry {
  private readonly projectDir: string
  private readonly projectRealDir: string
  private readonly systemDir: string
  private readonly systemRealDir: string
  private readonly registered = new Map<string, RegisteredSkill>()

  constructor(projectDir: string, systemDir = path.join(os.homedir(), '.capybara')) {
    this.projectDir = path.resolve(projectDir)
    this.projectRealDir = fs.realpathSync(this.projectDir)
    this.systemDir = path.resolve(systemDir)
    this.systemRealDir = fs.existsSync(this.systemDir) ? fs.realpathSync(this.systemDir) : this.systemDir
  }

  load(skillDirectories: readonly string[]): void {
    const next = new Map<string, RegisteredSkill>()
    for (const relativeDir of skillDirectories) {
      const rootDir = this.resolveSkillRoot(relativeDir)
      const entryFile = this.resolveEntry(rootDir)
      const entry = fs.readFileSync(entryFile)
      const definition = parseSkillDocument(entry.toString('utf8'), path.basename(rootDir))
      if (next.has(definition.name)) throw new Error(`duplicate project skill: ${definition.name}`)
      const entryHash = createHash('sha256').update(entry).digest('hex')
      const scriptFiles = this.filesIn(rootDir, 'scripts')
      const referenceFiles = this.filesIn(rootDir, 'references')
      const assetFiles = this.filesIn(rootDir, 'assets')
      const sourceVersion = createHash('sha256').update(JSON.stringify({ entryFile, entryHash, scriptFiles, referenceFiles, assetFiles })).digest('hex')
      next.set(definition.name, {
        ...definition,
        id: definition.name,
        rootDir,
        entryFile,
        entryHash,
        sourceVersion,
        scriptFiles,
        referenceFiles,
        assetFiles,
      })
    }
    this.registered.clear()
    next.forEach((skill, id) => this.registered.set(id, skill))
  }

  get(id: string): RegisteredSkill | undefined {
    return this.registered.get(id)
  }

  list(): RegisteredSkill[] {
    return [...this.registered.values()]
  }

  validateContent(skill: RegisteredSkill, content: string): AgentSkillDefinition {
    return parseSkillDocument(content, path.basename(skill.rootDir))
  }

  private resolveSkillRoot(relativeDir: string): string {
    if (typeof relativeDir !== 'string' || !relativeDir.trim() || path.isAbsolute(relativeDir)) {
      throw new Error('skill path must be a project-relative directory')
    }
    const projectCandidate = path.resolve(this.projectDir, relativeDir)
    const projectHasEntry = fs.existsSync(path.join(projectCandidate, 'SKILL.md'))
    const base = fs.existsSync(projectCandidate) && projectHasEntry ? this.projectDir : this.systemDir
    const candidate = path.resolve(base, relativeDir)
    if (!inside(base, candidate)) throw new Error('skill directory leaves its resource root')
    const realDir = fs.realpathSync(candidate)
    const allowedRealRoot = base === this.projectDir ? this.projectRealDir : this.systemRealDir
    if (!inside(allowedRealRoot, realDir)) throw new Error('skill symlink leaves its resource root')
    if (!fs.statSync(realDir).isDirectory()) throw new Error(`skill path is not a directory: ${relativeDir}`)
    return realDir
  }

  private resolveEntry(rootDir: string): string {
    const entryFile = path.join(rootDir, 'SKILL.md')
    if (!fs.existsSync(entryFile) || !fs.statSync(entryFile).isFile()) {
      throw new Error(`skill directory requires SKILL.md: ${path.relative(this.projectDir, rootDir)}`)
    }
    const realFile = fs.realpathSync(entryFile)
    if (!inside(rootDir, realFile)) throw new Error('skill entry leaves its directory')
    return realFile
  }

  private filesIn(rootDir: string, directory: string): string[] {
    const start = path.join(rootDir, directory)
    if (!fs.existsSync(start)) return []
    const files: string[] = []
    const visit = (current: string) => {
      for (const item of fs.readdirSync(current, { withFileTypes: true })) {
        const candidate = path.join(current, item.name)
        const real = fs.realpathSync(candidate)
        if (!inside(rootDir, real)) throw new Error(`skill resource leaves its directory: ${candidate}`)
        const stat = fs.statSync(real)
        if (stat.isDirectory()) visit(real)
        else if (stat.isFile()) files.push(real)
      }
    }
    visit(start)
    return files.sort()
  }
}
