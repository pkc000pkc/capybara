import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { readJson } from '../src/phase0_run.mjs'
import { resolveRuntimeSettings } from '../src/phase1_config.mjs'
import { modelRuntimeEnvironment, readModelConnection, resolveModelRetrySettings } from '../src/phase1_official.mjs'
import { runChildProcess } from '../src/phase1_process.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const protocol = readJson(join(root, 'config/phase0-protocol.json'))
const connection = readModelConnection(root, protocol.models)
const settings = { ...resolveRuntimeSettings({ protocol }), modelRetry: resolveModelRetrySettings() }
const outputDir = join(root, 'runs', `phase1-model-probe-${Date.now()}-${randomUUID().slice(0, 8)}`)
mkdirSync(outputDir, { recursive: true })
const reportPath = join(outputDir, 'model-probe.json')
const result = await runChildProcess({ command: resolve(root, protocol.runtime.python), args: [join(root, 'scripts', 'phase1_model_probe.py')], cwd: outputDir, env: { ...process.env, ...modelRuntimeEnvironment(settings), PYTHONPATH: resolve(root, protocol.runtime.officialPythonPath), PYTHONUTF8: '1', OPENAI_API_KEY: connection.apiKey, GAIA2_PROBE_ACTOR_MODEL: protocol.models.actor.model, GAIA2_PROBE_JUDGE_MODEL: protocol.models.judge.model, GAIA2_PROBE_ENDPOINT: connection.baseUrl, GAIA2_PROBE_REPORT: reportPath, GAIA2_RUNTIME_EVENT_FILE: join(outputDir, 'runtime-events.jsonl'), GAIA2_EXECUTION_ID: 'phase1-model-probe', GAIA2_SESSION_ID: dirname(reportPath) }, outputDir, processTimeoutMs: settings.processTimeoutMs, heartbeatIntervalMs: settings.heartbeatIntervalMs, secrets: [connection.apiKey] })
const report = existsSync(reportPath) ? readJson(reportPath) : { status: 'failed' }
if (result.exitCode !== 0 || result.timedOut || result.interrupted || result.spawnError || result.loggingError || result.heartbeatError || result.terminationErrors.length) report.status = 'failed'
console.log(JSON.stringify({ ...report, outputDir, reportPath }, null, 2))
if (report.status !== 'passed') process.exitCode = 2
