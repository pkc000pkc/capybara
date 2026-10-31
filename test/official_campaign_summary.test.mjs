import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { digest, fileDigest } from '../src/phase0_run.mjs'
import { buildOfficialCampaignSummary, writeOfficialCampaignSummary } from '../scripts/summarize_official_campaign.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gaia2-campaign-summary-'))
  const save = (path, value) => { const target = join(root, path.replaceAll('\\', '/')); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, JSON.stringify(value)); return { path, sha256: fileDigest(target) } }
  const tasks = ['execution', 'search', 'adaptability', 'time'].map((config, i) => ({ executionId: `task-${i}`, scenarioId: `scenario-${i}`,
    phase: 'standard', config, runNumber: 1, outputDir: `runs/fixture/executions/task-${i}`,
    workspaceDir: `runs/fixture/workspaces/task-${i}`, fixtureDir: `runs/fixture/fixtures/task-${i}` }))
  const manifest = { schemaVersion: 'gaia2-run-manifest-v1', runId: 'fixture', runRoot: 'runs\\fixture', stateFile: 'runs\\fixture\\run-state.json', tasks }
  manifest.manifestHash = digest(manifest)
  const runtime = { concurrency: 1 }, state = { schemaVersion: 'gaia2-run-state-v1', runId: manifest.runId,
    manifestHash: manifest.manifestHash, runtimeHash: digest(runtime), tasks: [] }
  save('runs/fixture/run-manifest.json', manifest); save('runs/fixture/runtime-settings.json', runtime)
  for (const [index, task] of tasks.entries()) {
    const sessionId = '0001-12345678-abc', session = { sessionId, sessionOrdinal: 1, parentSessionId: null,
      endedAt: '2026-10-15T00:00:00Z',
      ...Object.fromEntries(['outputDir', 'workspaceDir', 'fixtureDir'].map(key => [key, `${task[key]}/sessions/${sessionId}`])) }
    const record = { executionId: task.executionId, status: index === 3 ? 'pending' : index === 2 ? 'terminal_failure' : 'completed', sessions: index === 3 ? [] : [session], resultPath: null, resultSha256: null }
    if (index < 3) {
      const result = { schemaVersion: 'gaia2-task-result-v1', runId: manifest.runId, manifestHash: manifest.manifestHash,
        runtimeHash: state.runtimeHash, ...task, sessionId, evaluationComplete: index < 2, businessPassed: index < 2 ? index === 0 : null,
        score: index < 2 ? index === 0 ? 1 : 0 : null, failure: index === 2 ? { category: 'runtime_error', retryable: false,
          diagnostic: { causes: [{ stage: 'hook', code: 'worker_timeout' }] } } : index === 1 ? { category: 'business_failure', retryable: false } : null,
        artifacts: [], runtimeEvidence: [] }
      if (index === 0) {
        result.runtimeEvidence.push(save(`${session.workspaceDir}/plugin-runtime/000001-initialized.json`, {
          executionId: task.executionId, sessionId, schemaVersion: 'capybara-runtime-plugin-host-v1' }))
        result.runtimeEvidence.push(save(`${session.workspaceDir}/plugin-runtime/000002-before_tool.json`, { executionId: task.executionId, scenarioId: task.scenarioId,
          sessionId, sequence: 2, input: { checkpoint: 'before_tool', messages: [{ role: 'assistant', content: 'Checking the current file.' }],
            action: { id: 'call-1', name: 'Files.read', arguments: { path: '/a' } } }, decision: { action: 'allow' } }))
        result.runtimeEvidence.push(save(`${session.workspaceDir}/plugin-runtime/000003-attempt_end.json`, { executionId: task.executionId, scenarioId: task.scenarioId,
          sessionId, sequence: 3, input: { checkpoint: 'attempt_end', messages: [{ role: 'assistant', content: 'Checking the current file.' },
            { role: 'tool', name: 'Files.read', content: 'observed value' }] } }))
        result.runtimeEvidence.push(save(`${session.workspaceDir}/plugin-runtime-children/child-1234/plugin-runtime/000002-before_model.json`, {
          executionId: 'child-abcd', sessionId: 'child-1234', scenarioId: task.scenarioId, sequence: 2,
          input: { checkpoint: 'before_model', messages: [] } }))
      }
      const ref = save(`${session.workspaceDir}/task-result.json`, result)
      record.resultPath = ref.path; record.resultSha256 = ref.sha256; record.failure = result.failure
    }
    state.tasks.push(record)
  }
  const saveState = () => save(manifest.stateFile, state)
  saveState()
  return { root, manifest, state, save, saveState, summarize: () => buildOfficialCampaignSummary({ root, manifestPath: 'runs/fixture/run-manifest.json' }) }
}

test('mixed campaign preserves business grades, technical null and real visible text/action references', () => {
  const f = fixture(), report = f.summarize()
  assert.deepEqual(report.totals, { planned: 4, business_success: 1, business_failure: 1, technical_failure: 1, pending: 1, running: 0, retry_pending: 0, unverified: 0 })
  assert.equal(report.rows[2].score, null); assert.equal(report.rows[2].businessPassed, null)
  assert.equal(report.rows[3].analysis, null); assert.equal(report.judgedSuccessRate, 0.5)
  assert.equal(report.byError['runtime_error:worker_timeout'], 1)
  assert.equal(report.byCapability['standard:search'].business_failure, 1)
  assert.equal(report.rows[0].analysis.messageCount, 2)
  assert.equal(report.rows[0].analysis.assistantVisibleTextCount, 1)
  assert.equal(report.rows[0].analysis.toolActions[0].action.name, 'Files.read')
  assert.equal(report.rows[0].analysis.toolActions[0].argumentsSource.checkpoint, 'before_tool')
  assert.equal(report.rows[0].analysis.childHookEvidence[0].executionId, 'child-abcd')
  assert.equal(report.rows[0].analysis.messages, undefined)
  assert.match(report.rows[0].analysis.transcriptSource.sha256, /^[a-f0-9]{64}$/)
  assert.equal(report.rows[0].analysis.hiddenReasoningCaptured, false)
  assert.equal(report.allPlannedExecutionsAttempted, false)
  assert.equal(report.allPlannedExecutionsJudged, false)
})

test('changed evidence bytes and paths escaping the run never become verified grades', () => {
  for (const unsafe of ['hash', 'escape']) {
    const f = fixture(), record = f.state.tasks[0], result = JSON.parse(readFileSync(join(f.root, record.resultPath), 'utf8'))
    if (unsafe === 'hash') f.save(result.runtimeEvidence[0].path, { changed: true })
    else {
      result.runtimeEvidence[0] = f.save('outside/plugin-runtime/receipt.json', {})
      record.resultSha256 = f.save(record.resultPath, result).sha256; f.saveState()
    }
    const report = f.summarize()
    assert.equal(report.rows[0].outcome, 'unverified'); assert.equal(report.rows[0].score, null)
    assert.ok(report.issues.some(issue => issue.code === (unsafe === 'hash' ? 'source_hash_mismatch' : 'source_path_escape')))
  }
})

test('technical failure without sealed receipts does not infer a transcript from raw disk files', () => {
  const f = fixture(), session = f.state.tasks[2].sessions[0]
  f.save(`${session.workspaceDir}/plugin-runtime/raw.json`, { input: { messages: [{ role: 'assistant', content: 'unverified' }] } })
  const analysis = f.summarize().rows[2].analysis
  assert.equal(analysis.availability, 'unsealed_diagnostic_files_only')
  assert.equal(analysis.messageCount, null); assert.deepEqual(analysis.hookEvidence, [])
  assert.equal(analysis.unsealedDiagnostics.verified, false)
  assert.equal(analysis.unsealedDiagnostics.reason, 'missing_attestation')
  assert.equal(analysis.unsealedDiagnostics.hookFiles.length, 1)
  assert.match(analysis.unsealedDiagnostics.hookFiles[0].sha256, /^[a-f0-9]{64}$/)
})

test('summary refresh overwrites only its derived report and leaves all source state unchanged', () => {
  const f = fixture(), stateBefore = readFileSync(join(f.root, f.manifest.stateFile)), report = f.summarize()
  const outputPath = 'runs/fixture/campaign-summary.json'
  writeOfficialCampaignSummary({ root: f.root, outputPath, report })
  writeOfficialCampaignSummary({ root: f.root, outputPath, report: f.summarize() })
  assert.deepEqual(readFileSync(join(f.root, f.manifest.stateFile)), stateBefore)
  assert.equal(JSON.parse(readFileSync(join(f.root, outputPath), 'utf8')).schemaVersion, report.schemaVersion)
  assert.throws(() => writeOfficialCampaignSummary({ root: f.root, outputPath: f.manifest.stateFile, report }), /refuse_to_overwrite_source/)
  assert.throws(() => writeOfficialCampaignSummary({ root: f.root, outputPath: '../escape.json', report }), /source_path_escape/)
})
