import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRunManifest, digest, fileDigest, readJson } from '../src/phase0_run.mjs'
import { exportSubmissionPackage, packagePath, validateExportPlan } from '../src/phase2_export.mjs'
import { runSubmissionAuditCli } from '../src/phase2_cli.mjs'

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'gaia2-phase2-export-'))
  const contents = { schemaVersion: 'gaia2-phase2-fixture-manifest-v1', syntheticFixtureOnly: true, runId: 'fixture', runRoot: 'runs/fixture', stateFile: 'runs/fixture/run-state.json', mode: 'official_submission', models: { actor: { model: 'no-model', provider: 'controlled' } }, policy: { initialRunsPerScenario: 3, maxCorrections: 0 }, selection: { expectedInitialExecutions: 3, fullOfficialCoverage: false }, tasks: [1, 2, 3].map(runNumber => ({ phase: 'standard', config: 'execution', scenarioId: 'controlled', executionId: `controlled-${runNumber}`, runNumber, attemptIndex: null, correctionOrdinal: 0, outputDir: `runs/fixture/executions/${runNumber}`, fixtureDir: `runs/fixture/fixtures/${runNumber}`, workspaceDir: `runs/fixture/workspaces/${runNumber}` })) }
  const manifest = { ...contents, manifestHash: digest(contents) }, manifestPath = join(root, 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest), { flag: 'wx' })
  return { root, manifest, manifestPath }
}
const seal = manifest => { const { manifestHash, ...contents } = manifest; return { ...contents, manifestHash: digest(contents) } }

test('export paths reject traversal, Windows drive syntax, alternate streams and ambiguous segments', () => {
  const { root } = fixture()
  for (const path of ['../outside', 'a/../b', './a', 'a//b', 'a/', '/absolute', 'C:/absolute', 'C:relative', 'a\\b', 'a:b', 'bad\0path', '']) assert.throws(() => packagePath(root, path))
  assert.equal(packagePath(root, 'phase/config/hf/trace.json'), join(root, 'phase/config/hf/trace.json'))
})
test('fixture exports require explicit opt-in and an intact manifest hash', () => {
  const { root, manifest } = fixture()
  assert.throws(() => validateExportPlan(root, manifest), /explicit fixture/)
  assert.equal(validateExportPlan(root, manifest, { allowSynthetic: true }).synthetic, true)
  assert.throws(() => validateExportPlan(root, { ...manifest, runId: 'changed' }, { allowSynthetic: true }), /manifest hash/)
})
test('historical export uses the exact archived protocol after current configuration changes and rejects a missing snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'gaia2-phase2-historical-protocol-'))
  const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const protocol = readJson(join(projectRoot, 'config/phase0-protocol.json'))
  const index = protocol.datasets.source.configs.map(config => ({ datasetKind: 'source', config, id: `${config}-scenario`, path: `data/source/${config}.parquet`, rowIndex: 0, scenarioHash: digest(config), scenarioVersion: 'are_simulation_v1' }))
  const entrypoints = { entries: [{ id: 'old-entry', path: 'scripts/old.mjs', sha256: digest('old-entry') }], environmentOverrides: {} }
  const captured = { protocol, environment: { codeInputs: entrypoints.entries.map(({ path, sha256 }) => ({ path, sha256 })) }, capabilities: {}, dataset: {}, scenarioIndex: `${index.map(row => JSON.stringify(row)).join('\n')}\n` }
  const paths = { protocol: 'config/phase0-protocol.json', environment: 'locks/environment-lock.json', capabilities: 'locks/capability-inventory.json', dataset: 'locks/dataset-lock.json', scenarioIndex: '.phase0-cache/scenario-index.jsonl' }
  const lockRefs = {}
  for (const [name, value] of Object.entries(captured)) {
    const snapshot = join(root, 'locks/archive/previous', paths[name].split('/').at(-1))
    mkdirSync(dirname(snapshot), { recursive: true })
    writeFileSync(snapshot, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`)
    lockRefs[name] = { path: paths[name], sha256: fileDigest(snapshot) }
  }
  mkdirSync(join(root, 'schemas'), { recursive: true })
  writeFileSync(join(root, 'schemas/run-manifest.schema.json'), readFileSync(join(projectRoot, 'schemas/run-manifest.schema.json')))
  mkdirSync(join(root, 'config'))
  const changed = structuredClone(protocol)
  changed.models.actor.model = 'different-current-model'
  writeFileSync(join(root, paths.protocol), JSON.stringify(changed))
  const contents = buildRunManifest({ root, protocol, index, lockRefs, entrypoints, runId: 'historical-protocol' })
  const manifest = { ...contents, manifestHash: digest(contents) }
  const archivedProtocol = join(root, 'locks/archive/previous/phase0-protocol.json')
  assert.equal(validateExportPlan(root, manifest).frozenSources.protocol, archivedProtocol)
  const missingPath = `${archivedProtocol}.unavailable`
  renameSync(archivedProtocol, missingPath)
  assert.throws(() => validateExportPlan(root, manifest), /frozen protocol snapshot missing; do not substitute current locks/)
  renameSync(missingPath, archivedProtocol)
  assert.equal(fileDigest(archivedProtocol), manifest.lockRefs.protocol.sha256)
  assert.equal(validateExportPlan(root, manifest).frozenSources.protocol, archivedProtocol)
})
test('duplicate identities, unsafe layout, invalid run numbers and unconnected corrections fail closed', () => {
  const { root, manifest } = fixture()
  for (const change of [copy => { copy.tasks[1] = copy.tasks[0] }, copy => { copy.tasks[0].config = '../bad' }, copy => { copy.tasks[0].runNumber = 4 }, copy => { copy.tasks[0].runNumber = true }, copy => { copy.tasks[0].correctionOrdinal = 1 }, copy => { copy.policy.maxCorrections = 1 }]) {
    const copy = structuredClone(manifest); change(copy)
    assert.throws(() => validateExportPlan(root, seal(copy), { allowSynthetic: true }))
  }
})
test('an unexecuted plan exports problems without fabricating records, Trace, model calls or scores', async () => {
  const { root, manifestPath } = fixture(), outputDir = join(root, 'submission')
  const report = await exportSubmissionPackage({ root, manifestPath, outputDir, allowSynthetic: true })
  assert.equal(report.exportedRows, 0); assert.equal(report.missingExecutions, 3)
  assert.equal(report.noModelExecution, true); assert.equal(report.officialCheck, null)
  assert.equal(report.audit.coverage_complete, false); assert.equal(report.audit.evaluation_complete, false)
  const before = readFileSync(join(outputDir, 'export-manifest.json'))
  await assert.rejects(exportSubmissionPackage({ root, manifestPath, outputDir, allowSynthetic: true }), /already exists/)
  assert.deepEqual(readFileSync(join(outputDir, 'export-manifest.json')), before)
})
test('terminal technical failures remain missing during export and cannot become business rows', async () => {
  const { root, manifest, manifestPath } = fixture(), outputDir = join(root, 'terminal-submission')
  const runtime = { processTimeoutMs: 480000000, scenarioTimeoutSeconds: 480000, modelRequestTimeoutSeconds: 60, concurrency: 1, minimal: false }
  mkdirSync(join(root, 'runs/fixture'), { recursive: true })
  writeFileSync(join(root, 'runs/fixture/runtime-settings.json'), JSON.stringify(runtime))
  writeFileSync(join(root, manifest.stateFile), JSON.stringify({ schemaVersion: 'gaia2-run-state-v1', runId: manifest.runId, manifestHash: manifest.manifestHash, runtimeHash: digest(runtime), tasks: manifest.tasks.map((task, index) => ({ executionId: task.executionId, status: index === 0 ? 'terminal_failure' : 'pending', sessions: [], resultPath: null, resultSha256: null, failure: index === 0 ? { category: 'configuration_error', retryable: false } : null })) }))
  const report = await exportSubmissionPackage({ root, manifestPath, outputDir, allowSynthetic: true })
  assert.equal(report.exportedRows, 0)
  assert.equal(report.missingExecutions, 3)
  const problems = readJson(join(outputDir, 'problems.json'))
  assert.equal(problems.incompleteExecutions.find(item => item.executionId === 'controlled-1').status, 'terminal_failure')
  assert.equal(problems.incompleteExecutions.find(item => item.executionId === 'controlled-1').retryable, false)
})
test('export refuses existing symlink/junction ancestors before creating any package', async () => {
  const { root, manifestPath } = fixture(), real = join(root, 'real'), link = join(root, 'linked')
  mkdirSync(real); symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => packagePath(root, 'linked/file.json'), /symlink/)
  await assert.rejects(exportSubmissionPackage({ root, manifestPath, outputDir: join(link, 'submission'), allowSynthetic: true }), /symlink\/junction/)
})
test('audit CLI requires an explicit package and never overwrites a historical report', async () => {
  const { root } = fixture(), path = join(root, 'existing.json')
  writeFileSync(path, '{"historical":true}')
  await assert.rejects(runSubmissionAuditCli({ root, argv: [] }), /submission root required/)
  await assert.rejects(runSubmissionAuditCli({ root, argv: ['--input', 'missing', '--report', path] }), /already exists/)
  assert.equal(readFileSync(path, 'utf8'), '{"historical":true}')
})

test('audit CLI saves diagnostics for a malformed plan even if result rows are structurally valid', async () => {
  const { root } = fixture(), reportPath = join(root, 'diagnostic.json')
  mkdirSync(join(root, 'standard/execution/hf'), { recursive: true })
  writeFileSync(join(root, 'run-manifest.json'), '{invalid')
  writeFileSync(join(root, 'standard/execution/hf/trace.json'), JSON.stringify({ world_logs: [], apps: [], events: [], completed_events: [], version: 'are_simulation_v1', context: null, augmentation: null, metadata: { definition: { scenario_id: 'controlled', run_number: 1, config: 'execution' } } }))
  writeFileSync(join(root, 'standard/execution/output.jsonl'), `${JSON.stringify({ task_id: 'controlled', trace_id: 'standard/execution/hf/trace.json', score: 1, metadata: { scenario_id: 'controlled', run_number: 1, phase: 'standard', config: 'execution', execution_id: 'controlled-1', status: 'success', has_exception: false } })}\n`)
  const priorExit = process.exitCode, priorLog = console.log
  console.log = () => {}
  try {
    const report = await runSubmissionAuditCli({ root, argv: ['--input', root, '--report', reportPath] })
    assert.equal(report.format_valid, true); assert.equal(report.coverage_complete, false)
    assert.equal(report.evaluation_complete, false); assert.equal(report.officialCheckPassed, false)
    assert.equal(process.exitCode, 2); assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).coverage_complete, false)
    assert.ok(report.issues.some(issue => issue.code === 'missing_or_invalid_manifest'))
  } finally { process.exitCode = priorExit; console.log = priorLog }
})
