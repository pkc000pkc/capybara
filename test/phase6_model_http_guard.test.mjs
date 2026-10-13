import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeOfficialEntryManifest } from '../src/phase1_official_entry.mjs'
import { verifyModelHttpDispatchEvidence } from '../src/phase6_http_evidence.mjs'
import { runChildProcess } from '../src/phase1_process.mjs'
import { verifyPhase6NativeProcessIdentity } from '../src/phase6_process_identity.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const protocol = JSON.parse(readFileSync(join(root, 'config/phase0-protocol.json'), 'utf8'))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/(?:API_KEY|ACCESS_TOKEN|AUTHORIZATION|HF_TOKEN|HUGGINGFACE_TOKEN|GAIA2_(?:HOOK|A2A|CORRECTION|OFFICIAL_ENTRY|MODEL_HTTP)_)/i.test(key)))
Object.assign(env, { PYTHONPATH: join(root, '.official-python'), PYTHONUTF8: '1',
  LITELLM_LOCAL_MODEL_COST_MAP: 'True', LITELLM_TELEMETRY: 'False', HF_HUB_OFFLINE: '1',
  HF_DATASETS_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', OPENAI_API_KEY: 'controlled-non-secret' })

test('production HTTP guard controlled Python transport and fail-closed boundaries', { timeout: 180000 }, () => {
  const result = spawnSync(join(root, protocol.runtime.python), ['-B', 'test/phase6_model_http_guard_test.py', '-v'],
    { cwd: root, env, encoding: 'utf8', timeout: 170000, maxBuffer: 1024 * 1024 })
  assert.equal(result.status, 0, result.stderr)
  const count = result.stderr.match(/Ran (\d+) tests/)
  assert.ok(count && Number(count[1]) >= 26, 'at least 26 Python guard boundary cases must execute')
  assert.match(result.stderr, /\bOK\b/)
})

test('independent scoped pre-SDK and post-SDK rejection boundaries remain distinct', { timeout: 90000 }, () => {
  const result = spawnSync(join(root, protocol.runtime.python), ['-B', 'test/phase6_model_attempt_boundary_test.py'],
    { cwd: root, env, encoding: 'utf8', timeout: 80000, maxBuffer: 1024 * 1024 })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /Ran 3 tests/)
  assert.match(result.stderr, /\bOK\b/)
})

test('real Node entry binds supervised production model aliases and scoped child to strict HTTP journal', { timeout: 90000 }, async () => {
  const capture = mkdtempSync(join(tmpdir(), 'gaia2-http-guard-node-'))
  const output = join(capture, 'output'), workspace = join(capture, 'workspace')
  mkdirSync(output); mkdirSync(workspace)
  const task = { executionId: 'controlled-node-execution', scenarioId: 'controlled-node-scenario',
    scenarioVersion: '1', scenarioHash: 'a'.repeat(64), config: 'mini', runNumber: 1,
    attemptIndex: 1, correctionOrdinal: 0, phase: 'standard' }
  const session = { sessionId: 'controlled-node-session', outputDir: output, workspaceDir: workspace }
  const manifest = { runRoot: capture, runId: 'controlled-node-run', manifestHash: 'f'.repeat(64) }
  const entry = writeOfficialEntryManifest({ root, manifest, task, session })
  const result = await runChildProcess({ command: join(root, protocol.runtime.python),
    args: ['-B', join(root, 'test/phase6_model_http_guard_test.py'), '--node-probe'],
    cwd: root, outputDir: output, processTimeoutMs: 80000, heartbeatIntervalMs: 1000,
    secrets: ['controlled-non-secret'], env: { ...env,
      GAIA2_MODEL_HTTP_GUARD_REQUIRED: '1', GAIA2_OFFICIAL_ENTRY_REQUIRED: '1',
      GAIA2_OFFICIAL_ENTRY_PATH: entry.path, GAIA2_OFFICIAL_ENTRY_SHA256: entry.sha256,
      GAIA2_EXECUTION_ID: task.executionId, GAIA2_SESSION_ID: session.sessionId,
      GAIA2_RUNTIME_EVENT_FILE: join(output, 'runtime-events.jsonl') } })
  const stdout = readFileSync(result.stdoutPath, 'utf8'), stderr = readFileSync(result.stderrPath, 'utf8')
  assert.equal(result.exitCode, 0, stderr)
  const nativeProcess = JSON.parse(readFileSync(join(output, 'process-result.json'), 'utf8'))
  assert.deepEqual(nativeProcess, result)
  const nativeProcessIdentity = verifyPhase6NativeProcessIdentity({ nativeProcess,
    officialEntry: JSON.parse(readFileSync(entry.path, 'utf8')), pythonProcessId: result.pid })
  assert.equal(nativeProcessIdentity.parentPid, process.pid)
  assert.equal(nativeProcessIdentity.childExited, true); assert.equal(nativeProcessIdentity.childClosed, true)
  assert.equal(nativeProcessIdentity.supervisionDetached, false)
  const lines = stdout.trim().split(/\r?\n/).filter(line => line.startsWith('HTTP_GUARD_NODE_PROBE:'))
  assert.equal(lines.length, 1, 'exactly one safe controlled probe report is required')
  const report = JSON.parse(lines[0].slice('HTTP_GUARD_NODE_PROBE:'.length))
  assert.equal(report.passed, true); assert.equal(report.externalNetworkAttempts, 0)
  assert.equal(report.externalModelCalls, 0); assert.equal(report.serverReceivedRequests, 4)
  const rows = readFileSync(report.journalPath, 'utf8').trim().split('\n').map(JSON.parse)
  const starts = rows.filter(row => row.type === 'sdk_attempt_started')
  assert.deepEqual(starts.map(row => row.modelRole), ['actor', 'judge', 'correction', 'child_actor'])
  for (const row of rows) {
    assert.equal(row.entrySha256, entry.sha256); assert.equal(row.executionId, task.executionId)
    assert.equal(row.sessionId, session.sessionId)
  }
  for (const attempt of report.events.filter(event => event.type === 'model_request_attempt')) {
    assert.ok(starts.some(row => row.modelRole === attempt.modelRole && row.requestId === attempt.requestId &&
      row.requestAttempt === attempt.requestAttempt))
  }
  writeFileSync(join(capture, 'controlled-model-events.json'), JSON.stringify(report.events) + '\n', { flag: 'wx' })
  const verification = verifyModelHttpDispatchEvidence({
    journalBytes: readFileSync(report.journalPath), events: report.events,
    identity: { runId: manifest.runId, manifestHash: manifest.manifestHash, executionId: task.executionId,
      sessionId: session.sessionId, scenarioId: task.scenarioId, runNumber: task.runNumber, phase: task.phase, config: task.config },
    officialEntryBytes: readFileSync(entry.path), pythonProcessId: result.pid,
  })
  writeFileSync(join(capture, 'verification-report.json'), JSON.stringify({ ...verification,
    nativeProcessIdentity }) + '\n', { flag: 'wx' })
  console.log('HTTP_GUARD_CONTROLLED_FIXTURE:' + JSON.stringify({ capture, journalPath: report.journalPath,
    entryPath: entry.path, entrySha256: entry.sha256, nativeProcessPath: join(output, 'process-result.json'),
    nativeProcessIdentity, externalModelCalls: 0, externalNetworkAttempts: 0 }))
})
