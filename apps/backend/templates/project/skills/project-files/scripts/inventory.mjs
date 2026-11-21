#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'

const limits = { maxDepth: 20, maxEntries: 100_000 }

function parseInteger(value, name, maximum) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 0 and ${maximum}`)
  }
  return parsed
}

function parseArguments(argv) {
  const options = { root: process.cwd(), target: '.', maxDepth: 3, maxEntries: 500 }
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (name === '--help') return { ...options, help: true }
    const value = argv[index + 1]
    if (!value) throw new Error(`${name} requires a value`)
    if (name === '--root') options.root = value
    else if (name === '--path') options.target = value
    else if (name === '--max-depth') options.maxDepth = parseInteger(value, name, limits.maxDepth)
    else if (name === '--max-entries') options.maxEntries = parseInteger(value, name, limits.maxEntries)
    else throw new Error(`unknown option: ${name}`)
    index += 1
  }
  return options
}

function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function portable(relative) {
  return relative.split(path.sep).join('/')
}

async function directory(value, label) {
  const real = await fs.realpath(value)
  if (!(await fs.stat(real)).isDirectory()) throw new Error(`${label} must be a directory`)
  return real
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    process.stdout.write('Usage: inventory.mjs [--root DIR] [--path RELATIVE] [--max-depth N] [--max-entries N]\n')
    return
  }
  if (path.isAbsolute(options.target)) throw new Error('--path must be relative to --root')

  const root = await directory(path.resolve(options.root), '--root')
  const candidate = path.resolve(root, options.target)
  if (!isInside(root, candidate)) throw new Error('--path leaves --root')
  const start = await directory(candidate, '--path')
  if (!isInside(root, start)) throw new Error('--path resolves outside --root')

  const entries = []
  let truncated = false
  const visit = async (current, depth) => {
    for (const item of (await fs.readdir(current, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (entries.length >= options.maxEntries) {
        truncated = true
        return
      }
      const absolute = path.join(current, item.name)
      const relative = portable(path.relative(root, absolute))
      if (item.isSymbolicLink()) entries.push({ path: relative, type: 'symlink' })
      else if (item.isDirectory()) {
        entries.push({ path: `${relative}/`, type: 'directory' })
        if (depth < options.maxDepth) await visit(absolute, depth + 1)
      } else if (item.isFile()) {
        entries.push({ path: relative, type: 'file', bytes: (await fs.stat(absolute)).size })
      }
      if (truncated) return
    }
  }

  await visit(start, 0)
  process.stdout.write(`${JSON.stringify({ root, path: portable(path.relative(root, start)) || '.', entries, truncated }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
