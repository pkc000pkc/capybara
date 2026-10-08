import { resolve } from 'node:path'
import { auditPhase0, validateRunManifest } from './phase0_audit.mjs'
import { loadRunInputs, readJson } from './phase0_run.mjs'
import { resolveRuntimeSettings } from './phase1_config.mjs'
import { executeOfficialTask, resolveModelRetrySettings } from './phase1_official.mjs'
import { assertSupportedPlan, runFrozenBatch } from './phase1_runner.mjs'

export async function runManifestCli({ root, entrypoint, argv = process.argv.slice(2), env = process.env }) {
  const flags = new Set(), values = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (['--execute', '--resume', '--retry-infrastructure'].includes(arg)) { if (flags.has(arg)) throw new Error(`duplicate ${arg}`); flags.add(arg) }
    else if (['--manifest', '--max-tasks'].includes(arg) && argv[index + 1] && !argv[index + 1].startsWith('--') && !Object.hasOwn(values, arg)) values[arg] = argv[++index]
    else throw new Error(`invalid argument ${arg}`)
  }
  const path = values['--manifest'] ?? env.GAIA2_RUN_MANIFEST
  if (!path) throw new Error('Frozen manifest required: --manifest runs/<run_id>/run-manifest.json. Validation only by default; --execute starts model requests.')
  const manifest = readJson(resolve(root, path))
  const audit = await auditPhase0(root, { deep: false })
  if (!audit.phase0Passed) throw new Error(`frozen input audit failed: ${audit.errors.join('; ')}`)
  const errors = validateRunManifest(root, manifest, loadRunInputs(root), manifest.entrypoints.environmentOverrides)
  if (errors.length) throw new Error(`frozen manifest invalid: ${errors.join('; ')}`)
  assertSupportedPlan(manifest)
  if (env.GAIA2_E2E_TOOL_ALLOWLIST) throw new Error('smoke tool allowlist must be unset for original frozen tasks')
  const settings = { ...resolveRuntimeSettings({ protocol: { requestedRuntime: manifest.requestedRuntime }, entrypoint, env }), modelRetry: resolveModelRetrySettings(env) }
  if (settings.minimal) throw new Error('frozen original tasks do not permit minimal scenario mutation')
  const maxTasks = values['--max-tasks'] === undefined ? Infinity : Number(values['--max-tasks'])
  if (maxTasks !== Infinity && (!/^\d+$/.test(values['--max-tasks']) || !Number.isInteger(maxTasks) || maxTasks < 1)) throw new Error('max-tasks must be a positive integer')
  if (!flags.has('--execute')) {
    const report = { status: 'validated_not_executed', runId: manifest.runId, mode: manifest.mode, plannedInitialExecutions: manifest.tasks.length, effectiveSettings: settings, noModelExecution: true, officialSubmissionReady: false, realHooksReady: false }
    console.log(JSON.stringify(report, null, 2)); return report
  }
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
  try {
    const report = await runFrozenBatch({ root, manifest, settings, executeTask: executeOfficialTask, signal: controller.signal, resume: flags.has('--resume'), retryInfrastructure: flags.has('--retry-infrastructure'), maxTasks })
    console.log(JSON.stringify(report, null, 2))
    if (report.status !== 'evaluation_complete') process.exitCode = controller.signal.aborted ? 130 : 2
    return report
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt) }
}
