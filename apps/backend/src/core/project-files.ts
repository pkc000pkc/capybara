import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { resourceLanguage } from '#core/resources/resource-registry'

export const MAX_PROJECT_TEXT_FILE_BYTES = 5 * 1024 * 1024

export type ProjectFileEntryType = 'directory' | 'file' | 'symlink'

export interface ProjectFileEntry {
  name: string
  path: string
  type: ProjectFileEntryType
  language: string
  size: number
  modifiedAt: string
  editable: boolean
}

export interface ProjectDirectoryListing {
  path: string
  entries: ProjectFileEntry[]
}

export interface ProjectTextFile {
  name: string
  path: string
  language: string
  size: number
  modifiedAt: string
  content: string
  revision: string
}

export class ProjectFileRevisionConflict extends Error {}

function revision(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16)
}

function isText(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false
  return Buffer.from(buffer.toString('utf8'), 'utf8').equals(buffer)
}

function hasTextSample(file: string, size: number): boolean {
  const length = Math.min(size, 8_192)
  if (length === 0) return true
  const descriptor = fs.openSync(file, 'r')
  try {
    const sample = Buffer.allocUnsafe(length)
    fs.readSync(descriptor, sample, 0, length, 0)
    return !sample.includes(0)
  } finally {
    fs.closeSync(descriptor)
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function relativePath(input: unknown, allowRoot = true): string {
  if (typeof input !== 'string') throw new Error('project-relative path is required')
  if (input.includes('\0')) throw new Error('project-relative path contains an invalid character')
  const portable = input.replaceAll('\\', '/')
  if (path.posix.isAbsolute(portable) || /^[a-zA-Z]:/.test(portable)) {
    throw new Error('project path must be relative')
  }
  const normalized = path.posix.normalize(portable)
  if (normalized === '.') {
    if (allowRoot) return ''
    throw new Error('the project root cannot be changed')
  }
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('project path leaves the project workspace')
  }
  return normalized
}

function entryName(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) throw new Error('name is required')
  if (input === '.' || input === '..' || input.includes('/') || input.includes('\\') || input.includes('\0')) {
    throw new Error('name must be a single file or directory name')
  }
  return input
}

export class ProjectFileService {
  private readonly projectDir: string
  private readonly realProjectDir: string

  constructor(projectDir: string) {
    this.projectDir = path.resolve(projectDir)
    if (!fs.existsSync(this.projectDir) || !fs.statSync(this.projectDir).isDirectory()) {
      throw new Error(`project directory was not found: ${this.projectDir}`)
    }
    this.realProjectDir = fs.realpathSync(this.projectDir)
  }

  list(input: unknown = ''): ProjectDirectoryListing {
    const relative = relativePath(input)
    const directory = this.existingTarget(relative)
    if (!fs.statSync(directory).isDirectory()) throw new Error(`project directory was not found: ${relative || '.'}`)
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .map((item) => this.describe(relative ? `${relative}/${item.name}` : item.name))
      .sort((left, right) => {
        if (left.type === 'directory' && right.type !== 'directory') return -1
        if (left.type !== 'directory' && right.type === 'directory') return 1
        return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
      })
    return { path: relative, entries }
  }

  read(input: unknown): ProjectTextFile {
    const relative = relativePath(input, false)
    const file = this.existingTarget(relative)
    const stats = fs.statSync(file)
    if (!stats.isFile()) throw new Error(`project text file was not found: ${relative}`)
    if (stats.size > MAX_PROJECT_TEXT_FILE_BYTES) {
      throw new Error(`project text file exceeds ${MAX_PROJECT_TEXT_FILE_BYTES} bytes`)
    }
    const buffer = fs.readFileSync(file)
    if (!isText(buffer)) throw new Error('binary project files cannot be edited as text')
    return {
      name: path.basename(file),
      path: relative,
      language: resourceLanguage(relative),
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      content: buffer.toString('utf8'),
      revision: revision(buffer),
    }
  }

  write(input: { path?: unknown; content?: unknown; revision?: unknown }): ProjectTextFile {
    const relative = relativePath(input.path, false)
    if (typeof input.content !== 'string') throw new Error('file content must be a string')
    if (typeof input.revision !== 'string' || !input.revision) throw new Error('file revision is required')
    const bytes = Buffer.byteLength(input.content, 'utf8')
    if (bytes > MAX_PROJECT_TEXT_FILE_BYTES) {
      throw new Error(`project text file exceeds ${MAX_PROJECT_TEXT_FILE_BYTES} bytes`)
    }
    const file = this.existingTarget(relative)
    if (!fs.statSync(file).isFile()) throw new Error(`project text file was not found: ${relative}`)
    const current = fs.readFileSync(file)
    if (!isText(current)) throw new Error('binary project files cannot be edited as text')
    if (revision(current) !== input.revision) {
      throw new ProjectFileRevisionConflict('project file changed on disk; reload it before saving')
    }
    fs.writeFileSync(file, input.content, 'utf8')
    return this.read(relative)
  }

  create(input: { parent?: unknown; name?: unknown; type?: unknown }): ProjectFileEntry {
    const parent = relativePath(input.parent ?? '')
    const name = entryName(input.name)
    if (input.type !== 'file' && input.type !== 'directory') {
      throw new Error('entry type must be file or directory')
    }
    const directory = this.existingTarget(parent)
    if (!fs.statSync(directory).isDirectory()) throw new Error(`project directory was not found: ${parent || '.'}`)
    const relative = parent ? `${parent}/${name}` : name
    const target = this.lexicalTarget(relative)
    if (fs.existsSync(target)) throw new Error(`project entry already exists: ${relative}`)
    if (input.type === 'directory') fs.mkdirSync(target)
    else fs.writeFileSync(target, '', { encoding: 'utf8', flag: 'wx' })
    return this.describe(relative)
  }

  rename(input: { path?: unknown; name?: unknown }): ProjectFileEntry {
    const relative = relativePath(input.path, false)
    const name = entryName(input.name)
    const source = this.mutableTarget(relative)
    const parent = path.posix.dirname(relative)
    const destinationRelative = parent === '.' ? name : `${parent}/${name}`
    const destination = this.lexicalTarget(destinationRelative)
    this.assertParentInside(destination)
    if (fs.existsSync(destination)) throw new Error(`project entry already exists: ${destinationRelative}`)
    fs.renameSync(source, destination)
    return this.describe(destinationRelative)
  }

  remove(input: { path?: unknown; recursive?: unknown }): { deleted: true; path: string } {
    const relative = relativePath(input.path, false)
    const target = this.mutableTarget(relative)
    const stats = fs.lstatSync(target)
    if (stats.isDirectory()) {
      const recursive = input.recursive === true
      if (!recursive && fs.readdirSync(target).length > 0) {
        throw new Error('directory is not empty; recursive deletion must be confirmed')
      }
      fs.rmSync(target, { recursive, force: false })
    } else {
      fs.unlinkSync(target)
    }
    return { deleted: true, path: relative }
  }

  private describe(relative: string): ProjectFileEntry {
    const target = this.lexicalTarget(relative)
    const stats = fs.lstatSync(target)
    const type: ProjectFileEntryType = stats.isSymbolicLink()
      ? 'symlink'
      : stats.isDirectory() ? 'directory' : 'file'
    let editable = false
    if (type === 'file' && stats.size <= MAX_PROJECT_TEXT_FILE_BYTES) {
      editable = hasTextSample(target, stats.size)
    }
    return {
      name: path.basename(target),
      path: relative,
      type,
      language: type === 'file' ? resourceLanguage(relative) : 'Text',
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      editable,
    }
  }

  private lexicalTarget(relative: string): string {
    const target = path.resolve(this.projectDir, ...relative.split('/'))
    if (!isInside(this.projectDir, target)) throw new Error('project path leaves the project workspace')
    return target
  }

  private existingTarget(relative: string): string {
    const target = this.lexicalTarget(relative)
    if (!fs.existsSync(target)) throw new Error(`project entry was not found: ${relative || '.'}`)
    const realTarget = fs.realpathSync(target)
    if (!isInside(this.realProjectDir, realTarget)) throw new Error('project path leaves the project workspace')
    return target
  }

  private mutableTarget(relative: string): string {
    const target = this.lexicalTarget(relative)
    if (!fs.existsSync(target)) throw new Error(`project entry was not found: ${relative}`)
    this.assertParentInside(target)
    return target
  }

  private assertParentInside(target: string): void {
    const parent = fs.realpathSync(path.dirname(target))
    if (!isInside(this.realProjectDir, parent)) throw new Error('project path leaves the project workspace')
  }
}
