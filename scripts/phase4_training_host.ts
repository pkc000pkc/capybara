import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createTrainingBroker } from '../src/phase4_training_broker.mjs'

const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--spec') throw new Error('training spec required')
const spec = JSON.parse(readFileSync(args[1], 'utf8'))
const { TrainingPluginHost } = await import(pathToFileURL(join(spec.backendRoot, 'src/core/plugins/training-plugin-host.ts')).href)
const { broker, operationalReceipts } = createTrainingBroker({ root: spec.projectDir, workspaceDir: spec.workspaceDir,
  models: spec.models, settings: spec.settings })
const host = new TrainingPluginHost({ ...spec.options, broker })
const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => controller.abort())
let initialization: unknown = null, result: any = null, failureCode: string | null = null
let cleanupCompleted = false, manualInspectionRequired = false
try {
  initialization = await host.initialize()
  result = await host.invoke(spec.invocation, { signal: controller.signal })
} catch { failureCode = 'training_host_or_provider_failure' }
try { await host.close(); cleanupCompleted = true }
catch { failureCode = 'training_provider_cleanup_unresolved'; manualInspectionRequired = true }
if (operationalReceipts.some(item => item.process.manualInspectionRequired || !item.process.childExited || !item.process.childClosed
  || item.process.terminationErrors?.length)) {
  cleanupCompleted = false; manualInspectionRequired = true; failureCode = 'training_provider_cleanup_unresolved'
}
const status = !failureCode && cleanupCompleted ? result?.status ?? 'failed' : 'failed'
// Always preserve actual provider attempts, including a failed/cancelled Hook.
// No raw provider exception, endpoint, credentials or error body is persisted.
writeFileSync(spec.resultPath, JSON.stringify({ schemaVersion: 'gaia2-phase4-training-host-result-v1',
  initialization, result, operationalReceipts, cleanupCompleted, manualInspectionRequired, failureCode, status }) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ status, actualTrainingHost: true, providerCalls: operationalReceipts.length,
  cleanupCompleted, manualInspectionRequired, failureCode }))
if (!['passed', 'skipped'].includes(status)) process.exitCode = 2
