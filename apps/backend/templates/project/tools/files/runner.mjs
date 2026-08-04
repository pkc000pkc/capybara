import { spawn, spawnSync } from 'node:child_process'
import { mkdir, open, opendir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024
const DEFAULT_PROCESS_TIMEOUT_MS = 10_000
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules'])
const PRIVATE_FILES = new Set(['.capybara/secrets.json'])
const projectDir = path.resolve(process.env.CAPYBARA_PROJECT_DIR ?? '')
const projectRealDir = await realpath(projectDir)
let activeChild

function inside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function isPrivate(target) {
  return PRIVATE_FILES.has(path.relative(projectDir, target).replaceAll('\\', '/').toLowerCase())
}

async function safePath(value, allowMissing = false) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('path is required')
  if (path.isAbsolute(value)) throw new Error('absolute paths are not allowed')
  const target = path.resolve(projectDir, value)
  if (!inside(projectDir, target)) throw new Error('path must stay inside the project workspace')
  if (isPrivate(target)) throw new Error('path is private runtime configuration')
  try {
    const resolved = await realpath(target)
    if (!inside(projectRealDir, resolved)) throw new Error('symlink target leaves the project workspace')
  } catch (error) {
    if (!allowMissing || error?.code !== 'ENOENT') throw error
    let parent = path.dirname(target)
    while (!inside(projectDir, parent)) throw new Error('path must stay inside the project workspace')
    while (true) {
      try {
        const resolvedParent = await realpath(parent)
        if (!inside(projectRealDir, resolvedParent)) throw new Error('parent symlink leaves the project workspace')
        break
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        const next = path.dirname(parent)
        if (next === parent) throw error
        parent = next
      }
    }
  }
  return target
}

function relativePath(target) {
  return path.relative(projectDir, target).replaceAll('\\', '/') || '.'
}

async function safeDirectory(value = '.') {
  const target = await safePath(value)
  const metadata = await stat(target)
  if (!metadata.isDirectory()) throw new Error(`path is not a directory: ${relativePath(target)}`)
  return target
}

function childEnvironment() {
  const allowed = [
    'APPDATA',
    'COMSPEC',
    'HOME',
    'LANG',
    'LC_ALL',
    'LOCALAPPDATA',
    'NODE_PATH',
    'PATH',
    'PATHEXT',
    'Path',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'SystemRoot',
    'TEMP',
    'TMP',
    'TMPDIR',
    'USERPROFILE',
    'WINDIR',
  ]
  const environment = { CAPYBARA_PROJECT_DIR: projectDir }
  for (const key of allowed) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  return environment
}

function terminateProcessTree(child) {
  if (!child?.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    terminateProcessTree(activeChild)
    process.exit(signal === 'SIGINT' ? 130 : 143)
  })
}

function appendOutput(state, chunk) {
  const buffer = Buffer.from(chunk)
  const remaining = MAX_PROCESS_OUTPUT_BYTES - Buffer.byteLength(state.value)
  if (remaining <= 0) {
    state.truncated = true
    return
  }
  state.value += buffer.subarray(0, remaining).toString('utf8')
  if (buffer.length > remaining) state.truncated = true
}

async function runProcess(command, commandArgs, options) {
  const started = Date.now()
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS
  const stdout = { value: '', truncated: false }
  const stderr = { value: '', truncated: false }
  let timedOut = false
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      env: childEnvironment(),
      shell: options.shell === true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    activeChild = child
    const timer = setTimeout(() => {
      timedOut = true
      terminateProcessTree(child)
    }, timeoutMs)
    child.stdout.on('data', (chunk) => appendOutput(stdout, chunk))
    child.stderr.on('data', (chunk) => appendOutput(stderr, chunk))
    child.once('error', (error) => {
      clearTimeout(timer)
      if (activeChild === child) activeChild = undefined
      reject(error)
    })
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer)
      if (activeChild === child) activeChild = undefined
      resolve({ exitCode, signal })
    })
  })
  return {
    exit_code: result.exitCode,
    signal: result.signal,
    stdout: stdout.value,
    stderr: stderr.value,
    stdout_truncated: stdout.truncated,
    stderr_truncated: stderr.truncated,
    timed_out: timedOut,
    duration_ms: Date.now() - started,
  }
}

function inferredRuntime(file, requested = 'auto') {
  if (requested !== 'auto') return requested
  switch (path.extname(file).toLowerCase()) {
    case '.js':
    case '.mjs':
    case '.cjs':
    case '.ts':
    case '.mts':
    case '.cts':
      return 'node'
    case '.py':
      return 'python'
    case '.ps1':
      return 'powershell'
    case '.sh':
    case '.bash':
      return 'bash'
    default:
      throw new Error('cannot infer code runtime; specify node, python, powershell, or bash')
  }
}

function runtimeInvocation(runtime, target, args) {
  if (runtime === 'node') {
    const typeScript = ['.ts', '.mts', '.cts'].includes(path.extname(target).toLowerCase())
    return { command: process.execPath, args: [...(typeScript ? ['--experimental-strip-types'] : []), target, ...args] }
  }
  if (runtime === 'python') {
    return { command: process.platform === 'win32' ? 'python' : 'python3', args: [target, ...args] }
  }
  if (runtime === 'powershell') {
    return { command: 'pwsh', args: ['-NoLogo', '-NoProfile', '-File', target, ...args] }
  }
  if (runtime === 'bash') return { command: 'bash', args: [target, ...args] }
  throw new Error(`unsupported code runtime: ${runtime}`)
}

function parseUnifiedPatch(source) {
  const lines = source.replaceAll('\r\n', '\n').split('\n')
  const fileHeaders = lines.reduce((count, line) => count + (line.startsWith('--- ') ? 1 : 0), 0)
  if (fileHeaders !== 1 || !lines[0]?.startsWith('--- ') || !lines[1]?.startsWith('+++ ')) {
    throw new Error('write_file patch requires exactly one unified file patch')
  }
  const oldFileName = lines[0].slice(4).split('\t')[0]
  const newFileName = lines[1].slice(4).split('\t')[0]
  const hunks = []
  let index = 2
  while (index < lines.length) {
    if (!lines[index]) {
      index += 1
      continue
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index])
    if (!match) throw new Error(`invalid unified diff hunk: ${lines[index]}`)
    const hunk = { oldStart: Number(match[1]), lines: [] }
    index += 1
    while (index < lines.length && !lines[index].startsWith('@@ ')) {
      const line = lines[index]
      if (line === '' && index === lines.length - 1) break
      if (line.startsWith('\\ No newline at end of file')) {
        index += 1
        continue
      }
      if (![' ', '+', '-'].includes(line[0])) throw new Error(`invalid unified diff line: ${line}`)
      hunk.lines.push(line)
      index += 1
    }
    hunks.push(hunk)
  }
  if (hunks.length === 0) throw new Error('unified diff contains no hunks')
  return { oldFileName, newFileName, hunks }
}

function applyUnifiedPatch(source, patch) {
  const original = source === '' ? [] : source.split('\n')
  const output = []
  let sourceIndex = 0
  for (const hunk of patch.hunks) {
    const hunkIndex = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1
    if (hunkIndex < sourceIndex || hunkIndex > original.length) throw new Error('diff hunk is out of range')
    output.push(...original.slice(sourceIndex, hunkIndex))
    sourceIndex = hunkIndex
    for (const line of hunk.lines) {
      const marker = line[0]
      const text = line.slice(1)
      if (marker === '+') {
        output.push(text)
        continue
      }
      if (original[sourceIndex] !== text) throw new Error(`diff context does not match at line ${sourceIndex + 1}`)
      if (marker === ' ') output.push(text)
      sourceIndex += 1
    }
  }
  output.push(...original.slice(sourceIndex))
  return output.join('\n')
}

async function textLines(target) {
  const metadata = await stat(target)
  if (!metadata.isFile()) throw new Error(`path is not a file: ${relativePath(target)}`)
  if (metadata.size > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} bytes`)
  const buffer = await readFile(target)
  if (buffer.includes(0)) throw new Error('only text files can be read')
  return buffer.toString('utf8').split(/\r?\n/)
}

async function readFileTool(args) {
  const target = await safePath(args.file_name)
  const lines = await textLines(target)
  const start = args.start_line ?? 1
  const end = args.end_line ?? lines.length
  if (end < start) throw new Error('end_line must be greater than or equal to start_line')
  const selected = lines.slice(start - 1, end).map((text, index) => ({ line: start + index, text }))
  return {
    path: relativePath(target),
    start_line: start,
    end_line: selected.at(-1)?.line ?? start - 1,
    lines: selected,
    content: selected.map((line) => args.include_line_numbers === false ? line.text : `${line.line}: ${line.text}`).join('\n'),
  }
}

async function walkFiles(root, recursive, maxEntries) {
  const entries = []
  async function visit(directory) {
    const handle = await opendir(directory)
    const children = []
    for await (const entry of handle) children.push(entry)
    children.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of children) {
      if (entries.length >= maxEntries) return
      const target = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (isPrivate(target)) continue
      if (entry.isDirectory()) {
        entries.push({ path: relativePath(target), type: 'directory' })
        if (recursive && !IGNORED_DIRECTORIES.has(entry.name)) await visit(target)
      } else if (entry.isFile()) {
        entries.push({ path: relativePath(target), type: 'file' })
      }
    }
  }
  await visit(root)
  return entries
}

async function listFilesTool(args) {
  const target = await safePath(args.path ?? '.')
  const metadata = await stat(target)
  if (!metadata.isDirectory()) throw new Error(`path is not a directory: ${relativePath(target)}`)
  const maxEntries = args.max_entries ?? 1000
  const entries = await walkFiles(target, args.recursive === true, maxEntries)
  return { path: relativePath(target), entries, truncated: entries.length >= maxEntries }
}

function contextFor(lines, index, contextLines) {
  const beforeStart = Math.max(0, index - contextLines)
  const afterEnd = Math.min(lines.length, index + contextLines + 1)
  return {
    before: lines.slice(beforeStart, index).map((text, offset) => ({ line: beforeStart + offset + 1, text })),
    after: lines.slice(index + 1, afterEnd).map((text, offset) => ({ line: index + offset + 2, text })),
  }
}

async function searchInFileTool(args) {
  if (!args.query?.trim()) throw new Error('query must not be empty')
  const target = await safePath(args.file_name)
  const lines = await textLines(target)
  const contextLines = args.context_lines ?? 2
  const maxMatches = args.max_matches ?? 20
  const query = args.case_sensitive ? args.query : args.query.toLowerCase()
  const matches = []
  for (let index = 0; index < lines.length && matches.length < maxMatches; index += 1) {
    const candidate = args.case_sensitive ? lines[index] : lines[index].toLowerCase()
    if (!candidate.includes(query)) continue
    matches.push({ line: index + 1, text: lines[index], ...contextFor(lines, index, contextLines) })
  }
  return { path: relativePath(target), query: args.query, matches }
}

async function searchFileTool(args) {
  if (!args.query?.trim()) throw new Error('query must not be empty')
  const root = await safePath(args.dir ?? '.')
  const files = (await walkFiles(root, true, 10000)).filter((entry) => entry.type === 'file')
  const maxMatches = args.max_matches ?? 100
  const query = args.case_sensitive ? args.query : args.query.toLowerCase()
  const matches = []
  for (const entry of files) {
    if (matches.length >= maxMatches) break
    const candidatePath = args.case_sensitive ? entry.path : entry.path.toLowerCase()
    if ((args.mode ?? 'content') === 'filename') {
      if (candidatePath.includes(query)) matches.push({ path: entry.path })
      continue
    }
    try {
      const target = await safePath(entry.path)
      const lines = await textLines(target)
      for (let index = 0; index < lines.length && matches.length < maxMatches; index += 1) {
        const candidate = args.case_sensitive ? lines[index] : lines[index].toLowerCase()
        if (!candidate.includes(query)) continue
        matches.push({ path: entry.path, line: index + 1, text: lines[index], ...contextFor(lines, index, 3) })
      }
    } catch (error) {
      if (!/only text files|exceeds/.test(String(error))) throw error
    }
  }
  return { query: args.query, mode: args.mode ?? 'content', matches, truncated: matches.length >= maxMatches }
}

async function writeFileTool(args) {
  const target = await safePath(args.file_name, true)
  await mkdir(path.dirname(target), { recursive: true })
  let content
  let mode
  if (typeof args.content === 'string') {
    mode = args.mode ?? 'overwrite'
    const current = mode === 'append' ? await readFile(target, 'utf8').catch((error) => error?.code === 'ENOENT' ? '' : Promise.reject(error)) : ''
    content = `${current}${args.content}`
  } else {
    mode = 'patch'
    const patch = parseUnifiedPatch(args.patch)
    const candidates = [patch.oldFileName, patch.newFileName]
      .filter((value) => value && value !== '/dev/null')
      .map((value) => value.replace(/^[ab]\//, ''))
    if (candidates.length > 0 && !candidates.some((value) => path.resolve(projectDir, value) === target)) {
      throw new Error('diff target does not match file_name')
    }
    const current = await readFile(target, 'utf8').catch((error) => error?.code === 'ENOENT' ? '' : Promise.reject(error))
    content = applyUnifiedPatch(current, patch)
  }
  await writeFile(target, content, 'utf8')
  return { path: relativePath(target), mode, bytes: Buffer.byteLength(content) }
}

async function deleteFileTool(args) {
  const target = await safePath(args.file_name)
  const metadata = await stat(target)
  if (!metadata.isFile()) throw new Error(`path is not a file: ${relativePath(target)}`)
  await unlink(target)
  return { path: relativePath(target), deleted: true }
}

async function runCodeTool(args) {
  const target = await safePath(args.file_name)
  const metadata = await stat(target)
  if (!metadata.isFile()) throw new Error(`path is not a file: ${relativePath(target)}`)
  const cwd = await safeDirectory(args.cwd ?? '.')
  const runtime = inferredRuntime(target, args.runtime ?? 'auto')
  const invocation = runtimeInvocation(runtime, target, args.args ?? [])
  return {
    path: relativePath(target),
    runtime,
    cwd: relativePath(cwd),
    ...await runProcess(invocation.command, invocation.args, {
      cwd,
      timeoutMs: args.timeout_ms,
    }),
  }
}

async function runCommandTool(args) {
  if (!args.command?.trim()) throw new Error('command must not be empty')
  const cwd = await safeDirectory(args.cwd ?? '.')
  return {
    command: args.command,
    cwd: relativePath(cwd),
    ...await runProcess(args.command, [], {
      cwd,
      shell: true,
      timeoutMs: args.timeout_ms,
    }),
  }
}

const handlers = {
  read_file: readFileTool,
  list_files: listFilesTool,
  search_file: searchFileTool,
  search_in_file: searchInFileTool,
  write_file: writeFileTool,
  delete_file: deleteFileTool,
  run_code: runCodeTool,
  run_command: runCommandTool,
}

let raw = ''
for await (const chunk of process.stdin) raw += chunk
let response
try {
  const request = JSON.parse(raw)
  const handler = handlers[request.tool]
  if (!handler) throw new Error(`unknown tool: ${request.tool}`)
  response = { id: request.id, ok: true, result: await handler(request.arguments ?? {}) }
} catch (error) {
  response = { ok: false, error: error instanceof Error ? error.message : String(error) }
}
process.stdout.write(JSON.stringify(response))
