import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { enqueueProjectWrite } from '#core/project-write-queue'
import { ProjectResources } from '#core/project-resources'
import { ProjectResourceRegistry } from '#core/resources/resource-registry'
import { parseSkillDocument, SkillRegistry } from '#core/skills/skill-registry'

const MAX_SEARCH_LIMIT = 30
const MAX_SKILL_FILES = 500
const MAX_SKILL_BYTES = 25 * 1024 * 1024
const MAX_SINGLE_FILE_BYTES = 5 * 1024 * 1024
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const COMMIT = /^[a-f0-9]{40}$/
const LOCK_FILE = '.capybara/skill-installs.json'
const TRASH_FILE = '.capybara/skill-trash.json'

type CommandResult = { stdout: string; stderr: string }
export type SkillCommandRunner = (argumentsValue: readonly string[]) => Promise<CommandResult>

export interface SkillSearchResult {
  description: string
  namespace: string
  path: string
  repo: string
  skillName: string
  stars: number
  installed: boolean
}

export interface SkillPreviewFile {
  path: string
  size: number
  kind: 'entry' | 'script' | 'reference' | 'asset' | 'other'
}

export interface SkillPreview {
  repo: string
  requestedPath: string
  commit: string
  ref: string
  skillName: string
  description: string
  license?: string
  compatibility?: string
  allowedTools?: string
  metadata: Record<string, string>
  content: string
  files: SkillPreviewFile[]
  warnings: string[]
}

interface InstalledFile {
  path: string
  sha256: string
  size: number
}

interface InstallRecord {
  skillId: string
  path: string
  repo: string
  requestedPath: string
  commit: string
  installedAt: string
  files: InstalledFile[]
}

interface InstallRegistry {
  version: 1
  installs: Record<string, InstallRecord>
}

interface TrashRecord {
  id: string
  skillId: string
  originalPath: string
  trashPath: string
  removedAt: string
  expiresAt: string
  configIndex: number
  hadLocalChanges: boolean
  install?: InstallRecord
}

interface TrashRegistry {
  version: 1
  entries: Record<string, TrashRecord>
}

export interface InstalledSkillSummary {
  id: string
  path: string
  managed: boolean
  repo?: string
  requestedPath?: string
  commit?: string
  installedAt?: string
  hasLocalChanges: boolean
}

function defaultRunner(argumentsValue: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile('gh', [...argumentsValue], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message).trim()
        reject(new Error(detail || 'GitHub CLI command failed'))
        return
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function normalizeRelative(file: string): string {
  return file.replaceAll('\\', '/')
}

function validateRepository(value: unknown): string {
  if (typeof value !== 'string' || !REPOSITORY.test(value.trim())) {
    throw new Error('repository must use OWNER/REPO format')
  }
  return value.trim()
}

function validateRemotePath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f\\]/.test(value)) {
    throw new Error('skill path is invalid')
  }
  const normalized = value.trim().replace(/^\/+|\/+$/g, '')
  if (normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('skill path is invalid')
  }
  return normalized
}

function previewKind(relative: string): SkillPreviewFile['kind'] {
  if (relative === 'SKILL.md') return 'entry'
  if (relative.startsWith('scripts/')) return 'script'
  if (relative.startsWith('references/')) return 'reference'
  if (relative.startsWith('assets/')) return 'asset'
  return 'other'
}

function filesIn(root: string): SkillPreviewFile[] {
  const result: SkillPreviewFile[] = []
  let bytes = 0
  const visit = (directory: string) => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, item.name)
      const stat = fs.lstatSync(candidate)
      if (stat.isSymbolicLink()) throw new Error(`skill contains an unsupported symbolic link: ${item.name}`)
      if (stat.isDirectory()) {
        visit(candidate)
        continue
      }
      if (!stat.isFile()) throw new Error(`skill contains an unsupported file type: ${item.name}`)
      if (stat.size > MAX_SINGLE_FILE_BYTES) throw new Error(`skill file exceeds 5 MB: ${item.name}`)
      bytes += stat.size
      if (bytes > MAX_SKILL_BYTES) throw new Error('skill exceeds the 25 MB installation limit')
      const relative = normalizeRelative(path.relative(root, candidate))
      result.push({ path: relative, size: stat.size, kind: previewKind(relative) })
      if (result.length > MAX_SKILL_FILES) throw new Error('skill exceeds the 500 file installation limit')
    }
  }
  visit(root)
  return result.sort((left, right) => left.path.localeCompare(right.path))
}

function installedFiles(root: string, files: readonly SkillPreviewFile[]): InstalledFile[] {
  return files.map((file) => ({
    path: file.path,
    size: file.size,
    sha256: sha256(path.join(root, file.path)),
  }))
}

function findInstalledDirectory(root: string): string {
  const candidates = fs.readdirSync(root, { withFileTypes: true })
    .filter((item) => item.isDirectory() && fs.existsSync(path.join(root, item.name, 'SKILL.md')))
  if (candidates.length !== 1) throw new Error('GitHub CLI did not produce exactly one Skill directory')
  return path.join(root, candidates[0]!.name)
}

function commitFromOutput(output: string): string {
  const matches = [...output.matchAll(/@([a-f0-9]{40})(?:\s|$)/g)]
  const commit = matches.at(-1)?.[1]
  if (!commit) throw new Error('GitHub CLI did not report the resolved commit SHA')
  return commit
}

export class SkillMarketplaceService {
  private readonly projectDir: string
  private readonly runner: SkillCommandRunner

  constructor(projectDir: string, runner: SkillCommandRunner = defaultRunner) {
    this.projectDir = fs.realpathSync(path.resolve(projectDir))
    this.runner = runner
  }

  async search(input: { query?: unknown; owner?: unknown; page?: unknown; limit?: unknown }): Promise<{ items: SkillSearchResult[]; page: number }> {
    const query = typeof input.query === 'string' ? input.query.trim() : ''
    if (!query || query.length > 120) throw new Error('search query must contain 1-120 characters')
    const owner = typeof input.owner === 'string' ? input.owner.trim() : ''
    if (owner && !/^[A-Za-z0-9_.-]+$/.test(owner)) throw new Error('owner filter is invalid')
    const page = Math.max(1, Math.floor(Number(input.page ?? 1)))
    const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(Number(input.limit ?? 15))))
    const argumentsValue = ['skill', 'search', query, '--page', String(page), '--limit', String(limit), '--json', 'description,namespace,path,repo,skillName,stars']
    if (owner) argumentsValue.push('--owner', owner)
    const result = await this.runner(argumentsValue)
    const parsed: unknown = JSON.parse(result.stdout)
    if (!Array.isArray(parsed)) throw new Error('GitHub CLI returned an invalid search response')
    const installed = this.installRegistry().installs
    const items = parsed.map((item): SkillSearchResult => {
      if (!isObject(item)) throw new Error('GitHub CLI returned an invalid search item')
      const repo = validateRepository(item.repo)
      const skillPath = validateRemotePath(item.path)
      const skillName = typeof item.skillName === 'string' ? item.skillName : ''
      return {
        description: typeof item.description === 'string' ? item.description : '',
        namespace: typeof item.namespace === 'string' ? item.namespace : '',
        path: skillPath,
        repo,
        skillName,
        stars: Number(item.stars ?? 0),
        installed: Object.values(installed).some((record) => record.repo === repo && record.requestedPath === skillPath),
      }
    })
    return { items, page }
  }

  async preview(input: { repo?: unknown; path?: unknown }): Promise<SkillPreview> {
    const repo = validateRepository(input.repo)
    const requestedPath = validateRemotePath(input.path)
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-skill-preview-'))
    try {
      const result = await this.installTo(repo, requestedPath, temporary)
      const root = findInstalledDirectory(temporary)
      return this.previewFromDirectory(repo, requestedPath, root, commitFromOutput(`${result.stdout}\n${result.stderr}`))
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true })
    }
  }

  async install(input: { repo?: unknown; path?: unknown; commit?: unknown }) {
    const repo = validateRepository(input.repo)
    const requestedPath = validateRemotePath(input.path)
    if (typeof input.commit !== 'string' || !COMMIT.test(input.commit)) {
      throw new Error('install requires the full commit SHA returned by preview')
    }
    const commit = input.commit
    const stagingRoot = path.join(this.projectDir, '.capybara', 'tmp', `skill-install-${randomUUID()}`)
    fs.mkdirSync(stagingRoot, { recursive: true })
    try {
      await this.installTo(repo, requestedPath, stagingRoot, commit)
      const stagedSkill = findInstalledDirectory(stagingRoot)
      const definition = parseSkillDocument(
        fs.readFileSync(path.join(stagedSkill, 'SKILL.md'), 'utf8'),
        path.basename(stagedSkill),
        false,
      )
      const files = filesIn(stagedSkill)
      const relativePath = `skills/${definition.name}`
      const destination = path.join(this.projectDir, ...relativePath.split('/'))
      return await enqueueProjectWrite(this.projectDir, () => {
        if (fs.existsSync(destination)) throw new Error(`project Skill already exists: ${definition.name}`)
        const resources = new ProjectResources(this.projectDir)
        const settings = resources.readSettings()
        const registryBefore = this.installRegistry()
        if (settings.skills.includes(relativePath) || registryBefore.installs[definition.name]) {
          throw new Error(`project Skill is already registered: ${definition.name}`)
        }
        fs.mkdirSync(path.dirname(destination), { recursive: true })
        fs.renameSync(stagedSkill, destination)
        try {
          new SkillRegistry(this.projectDir).load([...settings.skills, relativePath])
          resources.saveSkillDirectories([...settings.skills, relativePath])
          const record: InstallRecord = {
            skillId: definition.name,
            path: relativePath,
            repo,
            requestedPath,
            commit,
            installedAt: new Date().toISOString(),
            files: installedFiles(destination, files),
          }
          this.writeInstallRegistry({
            version: 1,
            installs: { ...registryBefore.installs, [definition.name]: record },
          })
          return {
            skill: this.installed().find((skill) => skill.id === definition.name),
            catalog: new ProjectResourceRegistry(this.projectDir).list(),
          }
        } catch (error) {
          resources.saveSkillDirectories(settings.skills)
          this.writeInstallRegistry(registryBefore)
          fs.rmSync(destination, { recursive: true, force: true })
          throw error
        }
      })
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true })
    }
  }

  installed(): InstalledSkillSummary[] {
    const resources = new ProjectResources(this.projectDir)
    const settings = resources.readSettings()
    const registry = new SkillRegistry(this.projectDir)
    registry.load(settings.skills)
    const installs = this.installRegistry().installs
    return registry.list().map((skill) => {
      const relativePath = normalizeRelative(path.relative(this.projectDir, skill.rootDir))
      const record = installs[skill.id]
      return {
        id: skill.id,
        path: relativePath,
        managed: record?.path === relativePath,
        ...(record?.repo ? { repo: record.repo } : {}),
        ...(record?.requestedPath ? { requestedPath: record.requestedPath } : {}),
        ...(record?.commit ? { commit: record.commit } : {}),
        ...(record?.installedAt ? { installedAt: record.installedAt } : {}),
        hasLocalChanges: record ? this.hasLocalChanges(skill.rootDir, record) : true,
      }
    })
  }

  async uninstall(skillId: unknown) {
    if (typeof skillId !== 'string' || !skillId.trim()) throw new Error('skill id is required')
    return enqueueProjectWrite(this.projectDir, () => {
      const resources = new ProjectResources(this.projectDir)
      const settings = resources.readSettings()
      const registry = new SkillRegistry(this.projectDir)
      registry.load(settings.skills)
      const skill = registry.get(skillId)
      if (!skill) throw new Error('project Skill was not found')
      const configIndex = settings.skills.findIndex((entry) => {
        const candidate = path.resolve(this.projectDir, entry)
        return fs.existsSync(candidate) && fs.realpathSync(candidate) === skill.rootDir
      })
      if (configIndex < 0) throw new Error('project Skill configuration was not found')
      const originalPath = normalizeRelative(settings.skills[configIndex]!)
      const absoluteOriginal = path.resolve(this.projectDir, originalPath)
      if (!inside(this.projectDir, absoluteOriginal) || originalPath.startsWith('.capybara/')) {
        throw new Error('only project-level Skills can be removed')
      }
      const installRegistry = this.installRegistry()
      const trashRegistry = this.trashRegistry()
      const install = installRegistry.installs[skill.id]
      const id = randomUUID()
      const trashPath = `.capybara/trash/skills/${id}`
      const absoluteTrash = path.join(this.projectDir, ...trashPath.split('/'))
      const hadLocalChanges = install ? this.hasLocalChanges(skill.rootDir, install) : true
      const removedAt = new Date()
      const record: TrashRecord = {
        id,
        skillId: skill.id,
        originalPath,
        trashPath,
        removedAt: removedAt.toISOString(),
        expiresAt: new Date(removedAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        configIndex,
        hadLocalChanges,
        ...(install ? { install } : {}),
      }
      fs.mkdirSync(path.dirname(absoluteTrash), { recursive: true })
      fs.renameSync(skill.rootDir, absoluteTrash)
      try {
        resources.saveSkillDirectories(settings.skills.filter((_, index) => index !== configIndex))
        const nextInstalls = { ...installRegistry.installs }
        delete nextInstalls[skill.id]
        this.writeInstallRegistry({ version: 1, installs: nextInstalls })
        this.writeTrashRegistry({
          version: 1,
          entries: { ...trashRegistry.entries, [id]: record },
        })
        return { ...record, catalog: new ProjectResourceRegistry(this.projectDir).list() }
      } catch (error) {
        resources.saveSkillDirectories(settings.skills)
        this.writeInstallRegistry(installRegistry)
        this.writeTrashRegistry(trashRegistry)
        fs.renameSync(absoluteTrash, skill.rootDir)
        throw error
      }
    })
  }

  async restore(trashId: unknown) {
    if (typeof trashId !== 'string' || !trashId.trim()) throw new Error('trash id is required')
    return enqueueProjectWrite(this.projectDir, () => {
      const trashRegistry = this.trashRegistry()
      const record = trashRegistry.entries[trashId]
      if (!record) throw new Error('removed Skill was not found in the recovery area')
      const source = path.resolve(this.projectDir, record.trashPath)
      const destination = path.resolve(this.projectDir, record.originalPath)
      if (!inside(this.projectDir, source) || !inside(this.projectDir, destination) || !fs.existsSync(source)) {
        throw new Error('removed Skill recovery data is invalid')
      }
      if (fs.existsSync(destination)) throw new Error('the original Skill path is already occupied')
      const resources = new ProjectResources(this.projectDir)
      const settings = resources.readSettings()
      const installRegistry = this.installRegistry()
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.renameSync(source, destination)
      try {
        const nextSkills = [...settings.skills]
        nextSkills.splice(Math.min(record.configIndex, nextSkills.length), 0, record.originalPath)
        new SkillRegistry(this.projectDir).load(nextSkills)
        resources.saveSkillDirectories(nextSkills)
        if (record.install) {
          this.writeInstallRegistry({
            version: 1,
            installs: { ...installRegistry.installs, [record.skillId]: record.install },
          })
        }
        const nextTrash = { ...trashRegistry.entries }
        delete nextTrash[trashId]
        this.writeTrashRegistry({ version: 1, entries: nextTrash })
        return {
          restored: true,
          skillId: record.skillId,
          catalog: new ProjectResourceRegistry(this.projectDir).list(),
        }
      } catch (error) {
        resources.saveSkillDirectories(settings.skills)
        this.writeInstallRegistry(installRegistry)
        this.writeTrashRegistry(trashRegistry)
        fs.renameSync(destination, source)
        throw error
      }
    })
  }

  private async installTo(repo: string, requestedPath: string, destination: string, pin?: string): Promise<CommandResult> {
    const argumentsValue = ['skill', 'install', repo, requestedPath, '--dir', destination]
    if (pin) argumentsValue.push('--pin', pin)
    return this.runner(argumentsValue)
  }

  private previewFromDirectory(repo: string, requestedPath: string, root: string, commit: string): SkillPreview {
    const entry = path.join(root, 'SKILL.md')
    const content = fs.readFileSync(entry, 'utf8')
    const sourceDirectory = path.basename(root)
    const definition = parseSkillDocument(content, sourceDirectory, false)
    const files = filesIn(root)
    const warnings = ['Skills are not verified by GitHub. Review their instructions and files before installation.']
    if (sourceDirectory !== definition.name) {
      warnings.push(`The source directory ${sourceDirectory} will be installed as ${definition.name} to satisfy the Agent Skills specification.`)
    }
    if (files.some((file) => file.kind === 'script')) warnings.push('This Skill contains executable scripts.')
    if (definition.allowedTools) warnings.push(`This Skill requests tools: ${definition.allowedTools}`)
    return {
      repo,
      requestedPath,
      commit,
      ref: definition.metadata['github-ref'] ?? commit,
      skillName: definition.name,
      description: definition.description,
      ...(definition.license ? { license: definition.license } : {}),
      ...(definition.compatibility ? { compatibility: definition.compatibility } : {}),
      ...(definition.allowedTools ? { allowedTools: definition.allowedTools } : {}),
      metadata: definition.metadata,
      content,
      files,
      warnings,
    }
  }

  private hasLocalChanges(root: string, record: InstallRecord): boolean {
    try {
      const current = filesIn(root)
      if (current.length !== record.files.length) return true
      const expected = new Map(record.files.map((file) => [file.path, file]))
      return current.some((file) => {
        const installed = expected.get(file.path)
        return !installed || installed.size !== file.size || installed.sha256 !== sha256(path.join(root, file.path))
      })
    } catch {
      return true
    }
  }

  private installRegistry(): InstallRegistry {
    return this.readRegistry<InstallRegistry>(LOCK_FILE, { version: 1, installs: {} })
  }

  private trashRegistry(): TrashRegistry {
    return this.readRegistry<TrashRegistry>(TRASH_FILE, { version: 1, entries: {} })
  }

  private readRegistry<T>(relative: string, fallback: T): T {
    const file = path.join(this.projectDir, ...relative.split('/'))
    if (!fs.existsSync(file)) return fallback
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  }

  private writeInstallRegistry(value: InstallRegistry): void {
    this.writeRegistry(LOCK_FILE, value)
  }

  private writeTrashRegistry(value: TrashRegistry): void {
    this.writeRegistry(TRASH_FILE, value)
  }

  private writeRegistry(relative: string, value: unknown): void {
    const file = path.join(this.projectDir, ...relative.split('/'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      try {
        fs.renameSync(temporary, file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
          && (error as NodeJS.ErrnoException).code !== 'EPERM') throw error
        fs.rmSync(file, { force: true })
        fs.renameSync(temporary, file)
      }
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }
}
