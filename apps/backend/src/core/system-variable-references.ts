import fs from 'node:fs'
import path from 'node:path'

export interface SystemVariableReference {
  path: string
  count: number
}

const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules'])
const MAX_SCANNED_FILE_BYTES = 4 * 1024 * 1024

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function collectFiles(projectDir: string, relativeRoot: string): string[] {
  const absoluteRoot = path.resolve(projectDir, relativeRoot)
  if (!inside(projectDir, absoluteRoot) || !fs.existsSync(absoluteRoot)) return []
  const files: string[] = []
  const visit = (absolute: string) => {
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(absolute)
    } catch {
      return
    }
    if (stat.isSymbolicLink()) return
    if (stat.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(path.basename(absolute))) return
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
        visit(path.join(absolute, entry.name))
      }
      return
    }
    if (stat.isFile() && stat.size <= MAX_SCANNED_FILE_BYTES) files.push(absolute)
  }
  visit(absoluteRoot)
  return files
}

/** Count supported Jinja/runtime references without treating plain variable names as dependencies. */
export function variableReferenceCount(content: string, key: string): number {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    new RegExp(`(?<![A-Za-z0-9_.])variables\\.builtin\\.prompts\\.${escaped}(?![A-Za-z0-9_])`, 'g'),
    new RegExp(`(?<![A-Za-z0-9_.])variables\\.builtin\\.variables\\.${escaped}(?![A-Za-z0-9_])`, 'g'),
    new RegExp(`(?<![A-Za-z0-9_.])builtin\\.prompts\\.${escaped}(?![A-Za-z0-9_])`, 'g'),
    new RegExp(`(?<![A-Za-z0-9_.])builtin\\.variables\\.${escaped}(?![A-Za-z0-9_])`, 'g'),
    new RegExp(`(?<![A-Za-z0-9_.])prompts\\.${escaped}(?![A-Za-z0-9_])`, 'g'),
  ]
  return patterns.reduce((count, pattern) => count + [...content.matchAll(pattern)].length, 0)
}

export function findSystemVariableReferences(
  projectDir: string,
  key: string,
  mainTemplate = 'main.j2',
): SystemVariableReference[] {
  const absoluteProjectDir = path.resolve(projectDir)
  const roots = new Set([
    mainTemplate.replaceAll('\\', '/'),
    'plugins',
    'harnesses',
    'hooks',
    'tools',
    'skills',
    '.capybara/harnesses',
    '.capybara/hooks',
  ])
  const files = [...roots].flatMap((root) => collectFiles(absoluteProjectDir, root))
  const references = new Map<string, number>()
  for (const file of new Set(files)) {
    let buffer: Buffer
    try {
      buffer = fs.readFileSync(file)
    } catch {
      continue
    }
    if (buffer.includes(0)) continue
    const count = variableReferenceCount(buffer.toString('utf8'), key)
    if (count > 0) {
      references.set(path.relative(absoluteProjectDir, file).replaceAll('\\', '/'), count)
    }
  }
  return [...references.entries()]
    .map(([referencePath, count]) => ({ path: referencePath, count }))
    .sort((left, right) => left.path.localeCompare(right.path))
}
