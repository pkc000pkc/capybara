import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freezeDatasets } from '../src/phase0_dataset.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const protocol = JSON.parse(await readFile(join(root, 'config', 'phase0-protocol.json'), 'utf8'))
const { report } = await freezeDatasets({ root, protocol, offline: process.argv.includes('--offline') })
process.stdout.write(`${JSON.stringify({
  status: report.status,
  sourceCount: report.source.count,
  submissionCount: report.submission.count,
  comparison: report.comparison.status,
  differentScenarioCount: report.comparison.differentScenarioCount,
  mini: report.mini,
}, null, 2)}\n`)
