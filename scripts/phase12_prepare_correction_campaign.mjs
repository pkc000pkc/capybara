import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditPhase0 } from '../src/phase0_audit.mjs'
import { buildCorrectionCampaign, discoverParentResult } from '../src/phase12_correction_campaign.mjs'
import { fileDigest, readJson, writeJson } from '../src/phase0_run.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url))), values = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1]
  if (!['--decisions', '--attribution', '--manifest', '--output'].includes(key) || !value || value.startsWith('--') || values[key]) throw new Error('usage: phase12-prepare-correction-campaign --decisions reports/<file>.json --attribution reports/<file>.json --manifest runs/<run>/run-manifest.json --output reports/<file>.json')
  values[key] = value
}
for (const key of ['--decisions', '--attribution', '--manifest', '--output']) if (!values[key]) throw new Error('decisions, attribution, manifest and output are required')
const decisionsPath = resolve(root, values['--decisions']), attributionPath = resolve(root, values['--attribution']), manifestPath = resolve(root, values['--manifest'])
const decisions = readJson(decisionsPath), attribution = readJson(attributionPath), manifest = readJson(manifestPath)
const parentResults = decisions.decisions.map((decision) => discoverParentResult(root, { runId: manifest.runId, executionId: decision.parentExecutionId, sessionId: decision.parentSessionId })).filter(Boolean)
const baselineAudit = await auditPhase0(root, { manifest, deep: false })
const report = buildCorrectionCampaign({ decisions, attribution, manifest, attributionSha256: fileDigest(attributionPath), decisionSha256: fileDigest(decisionsPath), parentResults, baselineAudit })
const output = resolve(root, values['--output'])
writeJson(output, { ...report, generatedAt: new Date().toISOString() }, { immutable: true })
console.log(JSON.stringify({ output, campaignHash: report.campaignHash, queueCount: report.queue.length, pendingCount: report.pendingCount, explicitSkipCount: report.explicitSkipCount, parentEvidence: report.parentEvidence, baselineAudit: report.baselineAudit, executionReady: report.executionReady, officialSubmissionReady: false }, null, 2))
