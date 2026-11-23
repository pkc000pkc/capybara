import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const COMMON_VALUES = new Set([
  'true', 'false', 'null', 'pending', 'completed', 'failed', 'success', 'unknown',
  'available', 'unavailable', 'active', 'inactive', 'test', 'train', 'normal', 'challenge',
])

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) throw new Error(`unexpected argument: ${argument}`)
    const key = argument.slice(2)
    if (key === 'help') options.help = true
    else {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
      if (key === 'context') options.context = value
      else if (key === 'dataset') options.dataset = value
      else if (key === 'tasks-root') options.tasksRoot = value
      else if (key === 'output') options.output = value
      else throw new Error(`unknown option: ${argument}`)
    }
  }
  return options
}

function usage() {
  return `Usage:
  node scripts/validate_project_context_leak.mjs --context <project_context.json> --dataset <dataset.jsonl> [--tasks-root <appworld-root/data/tasks>]

The validator is AppWorld-specific. It checks only the frozen project context and
training/evaluation references. It never reads the active task process.`
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line))
}

function scalar(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

function sensitivePath(parts) {
  return /(answer|private|ground|task[_-]?id|order|account|amount|email|phone|contact|secret|token|credential|database|record|user[_-]?id)/iu.test(parts.join('.'))
}

function collectSensitive(value, parts = [], result = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectSensitive(item, [...parts, String(index)], result))
    return result
  }
  if (!value || typeof value !== 'object') {
    const text = scalar(value)
    if (text && sensitivePath(parts) && !COMMON_VALUES.has(text.toLocaleLowerCase()) && (text.length >= 4 || /\d{2,}/u.test(text))) {
      result.push({ value: text, source: parts.join('.') })
    }
    return result
  }
  for (const [key, child] of Object.entries(value)) collectSensitive(child, [...parts, key], result)
  return result
}

function contextText(value) {
  return JSON.stringify(value).toLocaleLowerCase()
}

function digest(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)
}

function loadReferences(datasetFile, tasksRoot) {
  const references = []
  const records = readJsonl(datasetFile)
  records.forEach((record, index) => {
    const metadata = record?.metadata?.private?.appworld ?? record?.metadata?.appworld ?? {}
    const taskId = metadata.task_id
    if (typeof taskId === 'string' && taskId.trim()) references.push({ value: taskId.trim(), source: `dataset[${index}].metadata.appworld.task_id` })
    for (const item of collectSensitive(record?.answer, [`dataset[${index}].answer`])) references.push(item)
    for (const item of collectSensitive(record?.metadata?.private, [`dataset[${index}].metadata.private`])) references.push(item)
    if (!tasksRoot || typeof taskId !== 'string' || !taskId.trim()) return
    const taskDir = path.join(tasksRoot, taskId)
    for (const file of ['ground_truth/answer.json', 'ground_truth/test_data.json', 'ground_truth/private_data.json']) {
      const target = path.join(taskDir, file)
      if (!fs.existsSync(target)) continue
      for (const item of collectSensitive(readJson(target), [`tasks/${taskId}/${file}`])) references.push(item)
    }
  })
  const unique = new Map()
  for (const item of references) {
    const normalized = item.value.toLocaleLowerCase()
    if (!unique.has(normalized)) unique.set(normalized, item)
  }
  return [...unique.values()]
}

export function validateProjectContextLeak({ context, dataset, tasksRoot }) {
  const document = context?.document ?? context?.state?.document ?? context
  if (!document || typeof document !== 'object') throw new Error('project context document is missing')
  const text = contextText(document)
  const references = loadReferences(dataset, tasksRoot)
  const leaks = references
    .filter(item => text.includes(item.value.toLocaleLowerCase()))
    .map(item => ({ source: item.source, valueHash: digest(item.value), valueLength: item.value.length }))
  return {
    ok: leaks.length === 0,
    leaks,
    scanned: { contextRevision: document.revision ?? null, references: references.length },
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) { console.log(usage()); return }
  if (!options.context || !options.dataset) throw new Error('--context and --dataset are required')
  const result = validateProjectContextLeak({
    context: readJson(path.resolve(options.context)),
    dataset: path.resolve(options.dataset),
    tasksRoot: options.tasksRoot ? path.resolve(options.tasksRoot) : undefined,
  })
  const output = `${JSON.stringify(result, null, 2)}\n`
  if (options.output) fs.writeFileSync(path.resolve(options.output), output, 'utf8')
  process.stdout.write(output)
  if (!result.ok) process.exitCode = 2
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) main()
