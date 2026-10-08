import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { digest, fileDigest, readJson, writeJson } from '../src/phase0_run.mjs'
import { resolveRuntimeSettings } from '../src/phase1_config.mjs'
import { readNativeResult, resolveModelRetrySettings } from '../src/phase1_official.mjs'
import { runFrozenBatch } from '../src/phase1_runner.mjs'
import { exportSubmissionPackage, runOfficialConversion } from '../src/phase2_export.mjs'
import { auditSubmissionPackage } from '../src/phase2_audit.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const runId = `phase2-controlled-${Date.now()}-${randomUUID().slice(0, 8)}`, runRoot = join('runs', runId), absoluteRun = resolve(root, runRoot)
mkdirSync(absoluteRun)
const protocol = readJson(join(root, 'config/phase0-protocol.json'))
const contents = { schemaVersion: 'gaia2-phase2-fixture-manifest-v1', syntheticFixtureOnly: true, runId, runRoot, stateFile: join(runRoot, 'run-state.json'), mode: 'official_submission', dataset: { kind: 'submission', id: 'synthetic_fixture_no_benchmark', split: 'controlled' }, models: protocol.models, policy: { initialRunsPerScenario: 3, maxCorrections: 0, learningPolicy: 'freeze_before_evaluation' }, selection: { expectedInitialExecutions: 3, fullOfficialCoverage: false }, tasks: [1, 2, 3].map(runNumber => { const executionId = `standard-execution-controlled-${runNumber}`; return { phase: 'standard', config: 'execution', scenarioId: 'phase2_controlled_fixture', runNumber, attemptIndex: null, correctionOrdinal: 0, executionId, outputDir: join(runRoot, 'executions', executionId), fixtureDir: join(runRoot, 'fixtures', executionId), workspaceDir: join(runRoot, 'workspaces', executionId) } }) }
const manifest = { ...contents, manifestHash: digest(contents) }, manifestPath = join(absoluteRun, 'run-manifest.json')
writeJson(manifestPath, manifest, { immutable: true })
const settings = { ...resolveRuntimeSettings({ env: {} }), modelRetry: resolveModelRetrySettings({}) }
const executed = await runFrozenBatch({ root, manifest, settings, executeTask: async ({ task, session }) => {
  const output = resolve(root, session.outputDir), tracePath = join(output, 'trace.json')
  const fixture = await runOfficialConversion({ root, operation: 'fixture', spec: { tracePath, scenarioId: task.scenarioId, runNumber: task.runNumber, config: task.config }, diagnosticsRoot: join(absoluteRun, 'fixture-conversion'), processOutputDir: output })
  assert.equal(fixture.status, 'passed', JSON.stringify(fixture))
  const passed = task.runNumber !== 2
  const envelope = { task_id: task.scenarioId, trace_id: tracePath, score: passed ? 1 : 0, metadata: { scenario_id: task.scenarioId, run_number: task.runNumber, status: passed ? 'success' : 'failed', has_exception: false } }
  writeFileSync(join(output, 'output.jsonl'), `${JSON.stringify(envelope)}\n`, { flag: 'wx' })
  const events = [{ type: 'official_validation_completed', executionId: task.executionId, sessionId: session.sessionId, validationSuccess: passed, hasException: false, syntheticFixtureOnly: true }]
  writeFileSync(join(output, 'runtime-events.jsonl'), `${events.map(event => JSON.stringify(event)).join('\n')}\n`, { flag: 'wx' })
  return { processResult: fixture.processResult, events, ...readNativeResult({ root, outputDir: session.outputDir, task, session, events }) }
} })
assert.equal(executed.status, 'evaluation_complete')
const original = join(absoluteRun, 'original/submission')
const exported = await exportSubmissionPackage({ root, manifestPath, outputDir: original, allowSynthetic: true })
for (const gate of ['format_valid', 'coverage_complete', 'evaluation_complete']) assert.equal(exported.audit[gate], true, JSON.stringify(exported.audit))
assert.equal(exported.audit.officialSubmissionReady, false)
assert.equal(exported.officialCheck.reconstructedCount, 3); assert.equal(exported.officialCheck.successCount, 2); assert.equal(exported.officialCheck.businessFailureCount, 1)
const before = readJson(join(original, 'export-manifest.json')).files
const moved = join(absoluteRun, 'relocated/submission')
mkdirSync(dirname(moved), { recursive: true }); cpSync(original, moved, { recursive: true, errorOnExist: true, force: false })
const movedCheck = await runOfficialConversion({ root, operation: 'check', spec: { packageRoot: moved, model: protocol.models.actor.model, provider: protocol.models.actor.provider, hfRowsPath: join(moved, exported.officialCheck.hfRowsPath) }, diagnosticsRoot: join(absoluteRun, 'relocation-conversion') })
assert.equal(movedCheck.status, 'passed')
const movedAudit = auditSubmissionPackage({ packageRoot: moved, officialCheck: movedCheck })
for (const gate of ['format_valid', 'coverage_complete', 'evaluation_complete']) assert.equal(movedAudit[gate], true, JSON.stringify(movedAudit))
for (const file of before) assert.equal(fileDigest(join(moved, file.path)), file.sha256, 'moving/rebuilding must not change original evidence')
const negatives = []
function negative(name, mutate, expected) {
  const target = join(absoluteRun, 'negative', name, 'submission')
  mkdirSync(dirname(target), { recursive: true }); cpSync(original, target, { recursive: true, errorOnExist: true, force: false })
  const output = join(target, 'standard/execution/output.jsonl'), rows = readFileSync(output, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  mutate({ target, output, rows })
  const audit = auditSubmissionPackage({ packageRoot: target })
  for (const [gate, value] of Object.entries(expected)) assert.equal(audit[gate], value, `${name}: ${JSON.stringify(audit)}`)
  negatives.push({ case: name, format_valid: audit.format_valid, coverage_complete: audit.coverage_complete, evaluation_complete: audit.evaluation_complete, officialSubmissionReady: audit.officialSubmissionReady, issues: [...new Set(audit.issues.map(issue => issue.code))] })
}
const saveRows = (path, rows) => writeFileSync(path, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
negative('missing-field', ({ output, rows }) => { delete rows[0].task_id; saveRows(output, rows) }, { format_valid: false })
negative('duplicate-record', ({ output, rows }) => saveRows(output, [...rows, rows[0]]), { coverage_complete: false, evaluation_complete: false })
negative('missing-run', ({ output, rows }) => saveRows(output, rows.slice(0, 2)), { format_valid: true, coverage_complete: false, evaluation_complete: false })
negative('missing-trace', ({ target, rows }) => unlinkSync(join(target, rows[0].trace_id)), { format_valid: false, evaluation_complete: false })
negative('wrong-layout', ({ target }) => renameSync(join(target, 'standard'), join(target, 'wrong-phase')), { format_valid: false, coverage_complete: false })
negative('technical-fake-zero', ({ output, rows }) => { rows[0].metadata.has_exception = true; rows[0].metadata.exception_type = 'TimeoutError'; rows[0].metadata.status = 'failed'; rows[0].score = 0; saveRows(output, rows) }, { format_valid: false, evaluation_complete: false })
const historical = await exportSubmissionPackage({ root, manifestPath: join(root, 'runs/phase1-internal-20261008/run-manifest.json'), outputDir: join(absoluteRun, 'historical-unexecuted/submission') })
assert.equal(historical.exportedRows, 0); assert.equal(historical.missingExecutions, 25); assert.equal(historical.audit.coverage_complete, false)
const report = { schemaVersion: 'gaia2-phase2-controlled-validation-v1', status: 'passed', syntheticFixtureOnly: true, noModelExecution: true, noBenchmarkExecution: true, noUpload: true, sourceSessions: executed.totalSessions, exported: { packageRoot: original, rows: exported.exportedRows, audit: exported.audit, officialCheck: exported.officialCheck }, relocation: { packageRoot: moved, audit: movedAudit, officialCheck: movedCheck, originalEvidenceUnchanged: true }, negativeCases: negatives, historicalUnexecutedPlan: { rows: historical.exportedRows, missing: historical.missingExecutions, audit: historical.audit }, officialSubmissionReady: false, generatedAt: new Date().toISOString() }
const reportPath = join(absoluteRun, 'controlled-validation.json')
writeJson(reportPath, report, { immutable: true })
console.log(JSON.stringify({ status: report.status, reportPath, sourceSessions: executed.totalSessions, exportedRows: exported.exportedRows, movedPackagePassed: true, negativeCasesPassed: negatives.length, historicalPlanMissingExecutions: historical.missingExecutions, noModelExecution: true, noBenchmarkExecution: true, officialSubmissionReady: false }, null, 2))
