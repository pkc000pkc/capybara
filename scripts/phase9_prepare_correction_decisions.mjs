import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileDigest, readJson, writeJson } from '../src/phase0_run.mjs'
import { buildCorrectionDecisionTemplate } from '../src/phase4_correction_decisions.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url))), values = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1]
  if (!['--attribution', '--output'].includes(key) || !value || value.startsWith('--') || values[key]) throw new Error('usage: phase9-prepare-correction-decisions --attribution reports/<file>.json --output reports/<file>.json')
  values[key] = value
}
if (!values['--attribution'] || !values['--output']) throw new Error('attribution and output are required')
const attributionPath = resolve(root, values['--attribution']), attribution = readJson(attributionPath)
const report = buildCorrectionDecisionTemplate({ attribution, attributionSha256: fileDigest(attributionPath) })
writeJson(resolve(root, values['--output']), { ...report, generatedAt: new Date().toISOString() }, { immutable: true })
console.log(JSON.stringify({ output: resolve(root, values['--output']), explicitSkips: report.explicitSkips,
  pendingDecisions: report.pendingDecisions, ledgerCompatible: false, noModelExecution: true, officialSubmissionReady: false }, null, 2))
