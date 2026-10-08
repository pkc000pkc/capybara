import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { datasetFilesFromMetadata, ensureDatasetFile, pinnedDatasetMetadata } from '../src/phase0_dataset.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dataDir = join(root, 'data')
mkdirSync(dataDir, { recursive: true })
function readJson(path) { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null }
const protocol = readJson(join(root, 'config', 'phase0-protocol.json'))
const lock = readJson(join(root, 'locks', 'dataset-lock.json'))
const runner = readJson(join(root, 'gaia2-runner-manifest.json'))
const previous = readJson(join(dataDir, 'manifest.json'))
const lockedSource = protocol?.datasets?.source ?? lock?.datasets?.source
const dataset = lockedSource?.id ?? runner?.dataset ?? previous?.dataset
const revision = lockedSource?.revision ?? runner?.resolvedDatasetRevision ?? runner?.datasetRevision ?? previous?.revision
if (!/^[0-9a-f]{40}$/.test(revision ?? '')) throw new Error('an immutable dataset revision is required in the phase0 protocol, dataset lock, runner manifest, or data manifest; main is never resolved automatically')
const spec = {
  id: dataset, revision,
  split: lockedSource?.split ?? runner?.split ?? previous?.split ?? 'test',
  configs: lockedSource?.configs ?? runner?.capabilities ?? ['execution', 'search', 'adaptability', 'time', 'ambiguity'],
  // Retain the old source-manifest/cache layout for existing scripts.
  cacheDir: 'data',
}
const files = datasetFilesFromMetadata(spec, await pinnedDatasetMetadata(spec))
const downloaded = []
for (const entry of files) {
  const result = await ensureDatasetFile({ root, spec, entry })
  downloaded.push({
    name: entry.config,
    url: `https://huggingface.co/datasets/${dataset}/resolve/${revision}/${entry.remotePath}?download=true`,
    path: join(dataDir, basename(entry.path)),
    remotePath: entry.remotePath,
    bytes: entry.bytes, sha256: entry.sha256, reused: result.reused,
  })
}
writeFileSync(join(dataDir, 'manifest.json'), `${JSON.stringify({ dataset, revision, split: spec.split, downloadedAt: new Date().toISOString(), files: downloaded }, null, 2)}\n`)
process.stdout.write(`Verified ${downloaded.length} GAIA2 source files against immutable remote LFS metadata.\n`)
