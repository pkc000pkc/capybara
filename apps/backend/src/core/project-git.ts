import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export type GitChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted'

export interface ProjectGitChange {
  path: string
  originalPath?: string
  indexStatus: string
  worktreeStatus: string
  kind: GitChangeKind
  staged: boolean
  protected: boolean
  category: 'project' | 'dataset' | 'local'
  defaultSelected: boolean
}

export interface ProjectGitCommit {
  sha: string
  shortSha: string
  subject: string
  authorName: string
  committedAt: string
}

export interface ProjectGitStatus {
  gitAvailable: boolean
  initialized: boolean
  projectPath: string
  repositoryRoot: string | null
  projectSubpath: string
  branch: string | null
  head: (ProjectGitCommit & { projectTreeSha: string | null }) | null
  clean: boolean
  changes: ProjectGitChange[]
}

export interface ProjectGitDiff {
  path: string
  content: string
  truncated: boolean
}

const MAX_GIT_OUTPUT = 4 * 1024 * 1024
const MAX_DIFF_OUTPUT = 512 * 1024
const IGNORE_MARKER = '# Capybara local runtime state'
const IGNORE_PATTERNS = [
  '.capybara/secrets.json',
  '.capybara/sessions.sqlite*',
  '.capybara/experiments.sqlite*',
  '.capybara/worktrees/',
]

type GitResult = { code: number; stdout: string; stderr: string }

function runGit(cwd: string, args: string[], acceptedCodes = [0]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, shell: false, windowsHide: true })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let size = 0
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_GIT_OUTPUT) child.kill()
      else stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_GIT_OUTPUT) child.kill()
      else stderr.push(chunk)
    })
    child.on('error', (error) => reject(new Error(`Git is unavailable: ${error.message}`)))
    child.on('close', (code) => {
      if (size > MAX_GIT_OUTPUT) {
        reject(new Error('Git output exceeded the 4 MB safety limit'))
        return
      }
      const result = {
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8').trim(),
      }
      if (!acceptedCodes.includes(result.code)) {
        reject(new Error(result.stderr || `Git exited with code ${result.code}`))
        return
      }
      resolve(result)
    })
  })
}

function gitPath(value: string): string {
  return value.replaceAll('\\', '/')
}

function isProtectedPath(value: string): boolean {
  const normalized = gitPath(value).toLowerCase()
  return normalized === '.capybara/secrets.json'
    || normalized.startsWith('.capybara/sessions.sqlite')
    || normalized.startsWith('.capybara/experiments.sqlite')
    || normalized.startsWith('.capybara/worktrees/')
}

function pathCategory(value: string, protectedPath: boolean): ProjectGitChange['category'] {
  const normalized = gitPath(value).toLowerCase()
  if (protectedPath) return 'local'
  if (normalized === '.capybara/datasets.json' || normalized.startsWith('datasets/')) return 'dataset'
  return 'project'
}

function changeKind(code: string): GitChangeKind {
  if (code === '??') return 'untracked'
  if (code.includes('U') || code === 'AA' || code === 'DD') return 'conflicted'
  if (code.includes('R')) return 'renamed'
  if (code.includes('C')) return 'copied'
  if (code.includes('D')) return 'deleted'
  if (code.includes('A')) return 'added'
  return 'modified'
}

function parseStatus(output: string): ProjectGitChange[] {
  const entries = output.split('\0')
  const changes: ProjectGitChange[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry || entry.length < 4) continue
    const code = entry.slice(0, 2)
    const file = gitPath(entry.slice(3))
    const renamed = code.includes('R') || code.includes('C')
    const originalPath = renamed ? gitPath(entries[index + 1] ?? '') : undefined
    if (renamed) index += 1
    const protectedPath = isProtectedPath(file)
    const category = pathCategory(file, protectedPath)
    changes.push({
      path: file,
      ...(originalPath ? { originalPath } : {}),
      indexStatus: code[0] ?? ' ',
      worktreeStatus: code[1] ?? ' ',
      kind: changeKind(code),
      staged: code[0] !== ' ' && code[0] !== '?',
      protected: protectedPath,
      category,
      defaultSelected: !protectedPath && category === 'project',
    })
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path))
}

function parseCommit(line: string): ProjectGitCommit | null {
  const [sha, shortSha, subject, authorName, committedAt] = line.trim().split('\x1f')
  if (!sha || !shortSha || subject === undefined || authorName === undefined || !committedAt) return null
  return { sha, shortSha, subject, authorName, committedAt }
}

export class ProjectGitService {
  readonly projectDir: string

  constructor(projectDir: string) {
    this.projectDir = path.resolve(projectDir)
  }

  async status(): Promise<ProjectGitStatus> {
    try {
      await runGit(this.projectDir, ['--version'])
    } catch {
      return this.emptyStatus(false)
    }
    const rootResult = await runGit(this.projectDir, ['rev-parse', '--show-toplevel'], [0, 128])
    if (rootResult.code !== 0) return this.emptyStatus(true)
    const repositoryRoot = path.resolve(rootResult.stdout.trim())
    const projectSubpath = gitPath(path.relative(repositoryRoot, this.projectDir))
    if (projectSubpath.startsWith('../') || path.isAbsolute(projectSubpath)) {
      throw new Error('project directory is outside the detected Git repository')
    }
    const statusResult = await runGit(this.projectDir, [
      '-c',
      'status.relativePaths=true',
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--',
      '.',
    ])
    const projectPrefix = projectSubpath ? `${projectSubpath}/` : ''
    const changes = parseStatus(statusResult.stdout).map((change) => {
      const file = projectPrefix && change.path.startsWith(projectPrefix)
        ? change.path.slice(projectPrefix.length)
        : change.path
      const protectedPath = isProtectedPath(file)
      const category = pathCategory(file, protectedPath)
      return {
        ...change,
        path: file,
        ...(change.originalPath
          ? {
              originalPath: projectPrefix && change.originalPath.startsWith(projectPrefix)
                ? change.originalPath.slice(projectPrefix.length)
                : change.originalPath,
            }
          : {}),
        protected: protectedPath,
        category,
        defaultSelected: !protectedPath && category === 'project',
      }
    })
    const branchResult = await runGit(
      this.projectDir,
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      [0, 1, 128],
    )
    const headResult = await runGit(this.projectDir, ['rev-parse', '--verify', 'HEAD'], [0, 128])
    let head: ProjectGitStatus['head'] = null
    if (headResult.code === 0) {
      const commitResult = await runGit(this.projectDir, [
        'log',
        '-1',
        '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI',
      ])
      const commit = parseCommit(commitResult.stdout)
      if (commit) {
        const treeSpec = projectSubpath ? `${commit.sha}:${projectSubpath}` : `${commit.sha}^{tree}`
        const treeResult = await runGit(this.projectDir, ['rev-parse', treeSpec], [0, 128])
        head = { ...commit, projectTreeSha: treeResult.code === 0 ? treeResult.stdout.trim() : null }
      }
    }
    return {
      gitAvailable: true,
      initialized: true,
      projectPath: this.projectDir,
      repositoryRoot,
      projectSubpath,
      branch: branchResult.stdout.trim() || null,
      head,
      clean: !changes.some((change) => !change.protected),
      changes,
    }
  }

  async history(limit = 50): Promise<ProjectGitCommit[]> {
    const status = await this.status()
    if (!status.initialized || !status.head) return []
    const safeLimit = Math.min(200, Math.max(1, Math.floor(limit)))
    const result = await runGit(this.projectDir, [
      'log',
      `--max-count=${safeLimit}`,
      '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI',
      '--',
      '.',
    ])
    return result.stdout.split(/\r?\n/).map(parseCommit).filter((item): item is ProjectGitCommit => Boolean(item))
  }

  async diff(inputPath: string): Promise<ProjectGitDiff> {
    const file = this.validateProjectPath(inputPath)
    if (isProtectedPath(file)) throw new Error('protected local runtime files cannot be inspected through Git')
    const status = await this.status()
    if (!status.initialized) throw new Error('project is not a Git repository')
    const change = status.changes.find((item) => item.path === file)
    let result: GitResult
    if (change?.kind === 'untracked' || !status.head) {
      result = await runGit(
        this.projectDir,
        ['diff', '--no-index', '--no-color', '--', '/dev/null', file],
        [0, 1],
      )
    } else {
      result = await runGit(
        this.projectDir,
        ['diff', 'HEAD', '--no-ext-diff', '--no-color', '--unified=3', '--', file],
      )
    }
    const truncated = Buffer.byteLength(result.stdout, 'utf8') > MAX_DIFF_OUTPUT
    return {
      path: file,
      content: truncated ? `${result.stdout.slice(0, MAX_DIFF_OUTPUT)}\n... diff truncated ...\n` : result.stdout,
      truncated,
    }
  }

  async initialize(): Promise<ProjectGitStatus> {
    const current = await this.status()
    if (!current.gitAvailable) throw new Error('Git is not installed or unavailable')
    if (!current.initialized) {
      await runGit(this.projectDir, ['init', '--initial-branch=main', '.'])
    }
    this.ensureIgnoreRules()
    return this.status()
  }

  async commit(input: { message?: unknown; paths?: unknown }): Promise<{
    commit: ProjectGitCommit & { projectTreeSha: string | null }
    committedPaths: string[]
    status: ProjectGitStatus
  }> {
    const message = typeof input.message === 'string' ? input.message.trim() : ''
    if (!message) throw new Error('commit message is required')
    if (message.length > 500 || message.includes('\0')) throw new Error('commit message must not exceed 500 characters')
    if (!Array.isArray(input.paths) || input.paths.some((item) => typeof item !== 'string')) {
      throw new Error('paths must be an array of project-relative strings')
    }
    this.ensureIgnoreRules()
    const status = await this.status()
    if (!status.initialized) throw new Error('project is not a Git repository')
    const changes = new Map(status.changes.map((change) => [change.path, change]))
    const selected = [...new Set(input.paths.map((item) => this.validateProjectPath(item)))]
    if (changes.has('.gitignore') && !selected.includes('.gitignore')) selected.push('.gitignore')
    if (selected.length === 0) throw new Error('select at least one changed project file')
    for (const file of selected) {
      const change = changes.get(file)
      if (!change) throw new Error(`selected path is not changed: ${file}`)
      if (change.protected) throw new Error(`protected local runtime file cannot be committed: ${file}`)
      if (change.kind === 'conflicted') throw new Error(`resolve conflicts before committing: ${file}`)
    }
    await runGit(this.projectDir, ['var', 'GIT_AUTHOR_IDENT'])
    await runGit(this.projectDir, ['add', '--', ...selected])
    await runGit(this.projectDir, ['commit', '--only', '-m', message, '--', ...selected])
    const next = await this.status()
    if (!next.head) throw new Error('Git commit completed without a readable HEAD')
    return { commit: next.head, committedPaths: selected, status: next }
  }

  private emptyStatus(gitAvailable: boolean): ProjectGitStatus {
    return {
      gitAvailable,
      initialized: false,
      projectPath: this.projectDir,
      repositoryRoot: null,
      projectSubpath: '',
      branch: null,
      head: null,
      clean: true,
      changes: [],
    }
  }

  private validateProjectPath(value: string): string {
    if (typeof value !== 'string' || !value.trim() || path.isAbsolute(value)) {
      throw new Error('Git path must be a non-empty project-relative path')
    }
    const target = path.resolve(this.projectDir, value)
    const relative = path.relative(this.projectDir, target)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Git path must stay inside the project directory')
    }
    return gitPath(relative)
  }

  private ensureIgnoreRules(): void {
    const file = path.join(this.projectDir, '.gitignore')
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    if (current.includes(IGNORE_MARKER)) return
    const prefix = current && !current.endsWith('\n') ? '\n' : ''
    fs.writeFileSync(file, `${current}${prefix}${IGNORE_MARKER}\n${IGNORE_PATTERNS.join('\n')}\n`, 'utf8')
  }
}
