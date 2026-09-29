import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dataDir = join(root, 'data')
mkdirSync(dataDir, { recursive: true })

const curl = process.platform === 'win32' ? 'curl.exe' : 'curl'
const dataset = 'meta-agents-research-environments/gaia2-cli'
const revisionApi = `https://huggingface.co/api/datasets/${dataset}/revision/main`
const revision = JSON.parse(execFileSync(curl, ['--fail', '--location', revisionApi], { encoding: 'utf8' })).sha
if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error(`invalid dataset revision returned by Hugging Face: ${revision}`)
const base = `https://huggingface.co/datasets/${dataset}/resolve/${revision}`
const files = [
  ['execution', 'data/execution-test-00000-of-00001.parquet'],
  ['search', 'data/search-test-00000-of-00001.parquet'],
  ['adaptability', 'data/adaptability-test-00000-of-00001.parquet'],
  ['time', 'data/time-test-00000-of-00001.parquet'],
  ['ambiguity', 'data/ambiguity-test-00000-of-00001.parquet'],
]

function sha256(path) {
  const hash = createHash('sha256')
  hash.update(readFileSync(path))
  return hash.digest('hex')
}

async function download(name, relativePath) {
  const target = join(dataDir, basename(relativePath))
  const url = `${base}/${relativePath}?download=true`
  if (existsSync(target) && statSync(target).size > 0) {
    return { name, url, path: target, bytes: statSync(target).size, sha256: sha256(target), reused: true }
  }

  const temporary = `${target}.part`
  execFileSync(curl, ['--fail', '--location', '--retry', '3', '--retry-delay', '2', '--output', temporary, url], {
    stdio: 'inherit',
  })
  renameSync(temporary, target)
  const bytes = statSync(target).size
  return { name, url, path: target, bytes, sha256: sha256(target), reused: false }
}

const downloaded = []
for (const [name, relativePath] of files) {
  process.stdout.write(`Downloading ${name}...\n`)
  downloaded.push(await download(name, relativePath))
}

const manifest = {
  dataset,
  revision,
  split: 'test',
  downloadedAt: new Date().toISOString(),
  files: downloaded,
}
writeFileSync(join(dataDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
process.stdout.write(`Downloaded ${downloaded.length} GAIA2 capability files.\n`)
