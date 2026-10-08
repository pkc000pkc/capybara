import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { digest, fileDigest, readJson, writeJson } from '../src/phase0_run.mjs'
import { resolveRuntimeSettings } from '../src/phase1_config.mjs'
import { readNativeResult, resolveModelRetrySettings } from '../src/phase1_official.mjs'
import { runChildProcess } from '../src/phase1_process.mjs'
import { runFrozenBatch } from '../src/phase1_runner.mjs'

// Controlled process/state integration only: no ARE import, model call, or benchmark question.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const runId = `phase1-controlled-${Date.now()}-${randomUUID().slice(0, 8)}`
const runRoot = join('runs', runId)
const contents = { schemaVersion: 'gaia2-controlled-fixture-plan-v1', runId, runRoot, stateFile: join(runRoot, 'run-state.json'), policy: { maxCorrections: 0 }, tasks: [0, 1].map(index => ({ phase: 'standard', config: 'execution', scenarioId: `controlled-${index}`, runNumber: 1, executionId: `controlled-${index}`, outputDir: join(runRoot, 'outputs', String(index)), fixtureDir: join(runRoot, 'fixtures', String(index)), workspaceDir: join(runRoot, 'workspaces', String(index)) })) }
const manifest = { ...contents, manifestHash: digest(contents) }
const settings = { ...resolveRuntimeSettings({ env: { GAIA2_PROCESS_TIMEOUT_MS: '0', GAIA2_HEARTBEAT_INTERVAL_MS: '100' } }), modelRetry: resolveModelRetrySettings({}) }
const calls = []
mkdirSync(resolve(root, runRoot), { recursive: true })
writeJson(resolve(root, runRoot, 'controlled-manifest.json'), manifest, { immutable: true })
const executeTask = async ({ task, session }) => {
  calls.push({ executionId: task.executionId, sessionOrdinal: session.sessionOrdinal })
  const output = resolve(root, session.outputDir)
  const controller = new AbortController()
  const interrupted = task.executionId === 'controlled-1' && session.sessionOrdinal === 1
  const payload = { output, scenarioId: task.scenarioId, runNumber: task.runNumber, executionId: task.executionId, sessionId: session.sessionId, passed: task.executionId !== 'controlled-0', interrupted }
  const code = `const fs=require('node:fs'),p=require('node:path'),x=JSON.parse(process.argv[1]); console.log('controlled child started'); setInterval(()=>console.log('controlled liveness'),150); setTimeout(()=>{if(x.interrupted)return;const trace=p.join(x.output,'trace.json');fs.writeFileSync(trace,JSON.stringify({metadata:{definition:{scenario_id:x.scenarioId,run_number:x.runNumber,has_exception:false}}}));fs.writeFileSync(p.join(x.output,'output.jsonl'),JSON.stringify({task_id:x.scenarioId,trace_id:trace,score:x.passed?1:0,metadata:{scenario_id:x.scenarioId,run_number:x.runNumber,status:x.passed?'success':'failed',has_exception:false}})+'\\n');fs.writeFileSync(p.join(x.output,'runtime-events.jsonl'),JSON.stringify({type:'official_validation_completed',executionId:x.executionId,sessionId:x.sessionId,validationSuccess:x.passed,hasException:false})+'\\n');process.exit(0)},1000);`
  const timer = interrupted ? setTimeout(() => controller.abort(), 2200) : null
  let processResult
  try { processResult = await runChildProcess({ command: process.execPath, args: ['-e', code, JSON.stringify(payload)], cwd: resolve(root, session.workspaceDir), outputDir: output, processTimeoutMs: settings.processTimeoutMs, heartbeatIntervalMs: settings.heartbeatIntervalMs, signal: controller.signal, secrets: [] }) }
  finally { clearTimeout(timer) }
  const path = join(output, 'runtime-events.jsonl')
  const events = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : []
  if (interrupted) return { processResult, report: null, events }
  return { processResult, ...readNativeResult({ root, outputDir: session.outputDir, task, session, events }), events }
}
const interrupted = await runFrozenBatch({ root, manifest, settings, executeTask })
const resumed = await runFrozenBatch({ root, manifest, settings, executeTask, resume: true })
const state = readJson(resolve(root, manifest.stateFile))
const paths = state.tasks.flatMap(task => task.sessions.flatMap(session => [session.outputDir, session.fixtureDir, session.workspaceDir]))
const passed = interrupted.counts.completed === 1 && interrupted.counts.retry_pending === 1 && resumed.status === 'evaluation_complete' && resumed.businessFailures === 1 && resumed.businessSuccesses === 1 && resumed.totalSessions === 3 && calls.length === 3 && calls.filter(call => call.executionId === 'controlled-0').length === 1 && new Set(paths).size === 9
const report = { schemaVersion: 'gaia2-phase1-controlled-validation-v1', status: passed ? 'passed' : 'failed', noModelExecution: true, noAREExecution: true, noBenchmarkExecution: true, syntheticFixtureOnly: true, interrupted, resumed, calls, uniqueSessionPaths: new Set(paths).size, state: { path: manifest.stateFile, sha256: fileDigest(resolve(root, manifest.stateFile)) }, runRoot, generatedAt: new Date().toISOString() }
writeJson(resolve(root, runRoot, 'controlled-validation.json'), report, { immutable: true })
console.log(JSON.stringify(report, null, 2))
if (!passed) process.exitCode = 2
