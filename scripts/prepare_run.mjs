import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRunManifest, digest, inspectEntrypoints, loadRunInputs, saveRunManifest } from '../src/phase0_run.mjs'
import { auditPhase0, validateRunManifest } from '../src/phase0_audit.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const values = {}
const allowed = new Set(['mode', 'per-capability', 'mini-limit', 'run-id', 'root-seed'])
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]?.replace(/^--/, '')
  const value = process.argv[index + 1]
  if (!allowed.has(key) || value === undefined || value.startsWith('--') || Object.hasOwn(values, key)) throw new Error(`invalid argument ${process.argv[index]}`)
  values[key] = value
}
const audit = await auditPhase0(root, { deep: false })
if (!audit.phase0Passed) throw new Error(`phase0 audit failed: ${audit.errors.join('; ')}`)
const inputs = loadRunInputs(root)
const manifest = buildRunManifest({ root, ...inputs, entrypoints: inspectEntrypoints(root), mode: values.mode ?? 'internal_pass5', perCapability: values['per-capability'] === undefined ? undefined : Number(values['per-capability']), miniLimit: values['mini-limit'] === undefined ? undefined : Number(values['mini-limit']), runId: values['run-id'], rootSeed: values['root-seed'] === undefined ? inputs.protocol.rootSeed : Number(values['root-seed']) })
const errors = validateRunManifest(root, { ...manifest, manifestHash: digest(manifest) }, inputs)
if (errors.length) throw new Error(`invalid run plan: ${errors.join('; ')}`)
const output = saveRunManifest(root, manifest)
console.log(JSON.stringify({ status: 'prepared', manifest: output, runId: manifest.runId, mode: manifest.mode, initialExecutions: manifest.tasks.length, planFingerprint: manifest.planFingerprint, fullOfficialCoverage: manifest.selection.fullOfficialCoverage, executionReady: audit.executionReady, knownGaps: audit.knownGaps }, null, 2))
