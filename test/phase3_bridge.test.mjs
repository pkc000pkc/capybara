import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readNativeResult } from '../src/phase1_official.mjs'
import { classifyExecutionFailure } from '../src/phase1_errors.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const python = process.env.GAIA2_PYTHON || 'C:/Users/pkc00/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'

test('live Python bridge consumes real ARE dynamics and fails closed around synchronous hook receipts offline', () => {
  const result = spawnSync(python, [join(root, 'test', 'phase3_live_bridge_test.py')], {
    cwd: root,
    env: { ...process.env, PYTHONPATH: join(root, '.official-python'), PYTHONUTF8: '1', HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', LITELLM_LOCAL_MODEL_COST_MAP: 'True', LITELLM_TELEMETRY: 'False' },
    encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /Ran 35 tests/)
  assert.match(result.stderr, /OK/)
  const auditLine = result.stdout.split(/\r?\n/).find(line => line.startsWith('MODEL_PROTOCOL_FAILURE_AUDITS:'))
  const failures = JSON.parse(auditLine.slice('MODEL_PROTOCOL_FAILURE_AUDITS:'.length))
  assert.deepEqual(failures.map(item => item.case), ['server_unsupported_parameter', 'local_unsupported_parameter'])
  // Feed the actual controlled failure events to the production reader and
  // classifier. ARE's outer runner may label an exception as success=false;
  // that numerical zero must not become a judged business failure here.
  for (const failure of failures) {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'gaia2-phase4-model-protocol-'))
    const tracePath = join(fixtureRoot, 'trace.json'), resultPath = join(fixtureRoot, 'output.jsonl')
    const task = { scenarioId: 'controlled-protocol', executionId: failure.case, runNumber: 1 }
    const session = { sessionId: `${failure.case}-session` }
    const definition = { scenario_id: task.scenarioId, run_number: task.runNumber, has_exception: true, exception_type: failure.exceptionType }
    try {
      writeFileSync(tracePath, JSON.stringify({ metadata: { definition } }))
      writeFileSync(resultPath, JSON.stringify({ task_id: task.scenarioId, trace_id: tracePath, score: 0, metadata: { ...definition, status: 'failed' } }) + '\n')
      const events = failure.events.map(event => ({ ...event, executionId: task.executionId, sessionId: session.sessionId }))
      const { report } = readNativeResult({ root: fixtureRoot, outputDir: '.', task, session, events })
      assert.equal(report.score, null)
      assert.equal(report.businessPassed, null)
      assert.equal(report.evaluationComplete, false)
      const classified = classifyExecutionFailure({ processResult: { exitCode: 0 }, report, events })
      assert.equal(classified.category, 'configuration_error')
      assert.equal(classified.retryable, false)
    } finally {
      unlinkSync(resultPath); unlinkSync(tracePath); rmdirSync(fixtureRoot)
    }
  }
})
