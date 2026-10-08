import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditPhase0 } from '../src/phase0_audit.mjs'
import { readJson, writeJson } from '../src/phase0_run.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
let manifestPath = null
for (let index = 2; index < process.argv.length; index += 2) {
  if (process.argv[index] !== '--manifest' || !process.argv[index + 1] || manifestPath) throw new Error('usage: phase0-preflight [--manifest path]')
  manifestPath = resolve(root, process.argv[index + 1])
}
const report = await auditPhase0(root, { manifest: manifestPath ? readJson(manifestPath) : null, deep: true })
const output = manifestPath ? resolve(dirname(manifestPath), 'phase0-preflight.json') : resolve(root, 'reports/phase0-audit.json')
writeJson(output, report)
console.log(JSON.stringify({ ...report, reportPath: output }, null, 2))
if (!report.phase0Passed) process.exitCode = 2
