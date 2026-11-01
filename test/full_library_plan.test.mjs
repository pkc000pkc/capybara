import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scenarioIdSetSha256 } from '../src/phase0_dataset.mjs'
import { digest, fileDigest } from '../src/phase0_run.mjs'
import { resolveRuntimeSettings } from '../src/phase1_config.mjs'
import { resolveModelRetrySettings } from '../src/phase1_official.mjs'
import { FULL_LIBRARY_CAPABILITIES, FULL_LIBRARY_SCHEMA, FULL_LIBRARY_SCOPE_POLICY, FULL_LIBRARY_SELECTION_RULE, FULL_LIBRARY_STOP_POLICY,
  assertFullLibraryFrozen, fullLibraryScope, loadFullLibraryPlan, orderFullLibraryTasks, taskSlotIdentity, validateFullLibraryPlanIdentity } from '../scripts/full_library_plan.mjs'

function fixture() {
  const index = [], files = []
  for (const config of [...FULL_LIBRARY_CAPABILITIES, 'mini']) {
    const rows = Array.from({ length: 160 }, (_, rowIndex) => {
      // Mini deliberately shares IDs with Standard, but not hashes. Ordering
      // must not use an oracle/category or require an exact Standard hash.
      const id = config === 'mini' ? `${FULL_LIBRARY_CAPABILITIES[rowIndex % 5]}-${Math.floor(rowIndex / 5)}` : `${config}-${rowIndex}`
      return { datasetKind: config === 'mini' ? 'mini' : 'submission', config, id, rowIndex,
        path: `data/submission/${config}.parquet`, scenarioHash: digest([config, rowIndex]), scenarioVersion: 'are_simulation_v1' }
    })
    index.push(...rows)
    files.push({ config, path: rows[0].path, sha256: digest(config), count: 160,
      scenarioIdSetSha256: scenarioIdSetSha256(rows.map(row => row.id)), scenarioVersions: ['are_simulation_v1'] })
  }
  const protocol = { models: { actor: { model: 'gpt-6-luna', provider: 'local', protocol: 'chat-completions' },
    judge: { model: 'gpt-6-luna', provider: 'local', protocol: 'chat-completions' }, configurationSource: 'public-model.json' },
    datasets: { submission: { id: 'official-gaia2', revision: 'a'.repeat(40) } }, requestedRuntime: { concurrency: 1 } }
  const settings = { ...resolveRuntimeSettings({ protocol, entrypoint: 'pilot', env: {} }), modelRetry: resolveModelRetrySettings({}) }
  const dataset = { ...protocol.datasets.submission, split: 'validation', count: 800,
    configs: [...FULL_LIBRARY_CAPABILITIES, 'mini'], scenarioIdSetSha256: scenarioIdSetSha256(index.filter(row => row.datasetKind === 'submission').map(row => row.id)), files }
  const datasetLock = { datasets: { submission: dataset }, scenarioIndex: { path: 'data/scenario-index.jsonl', sha256: digest(index), count: index.length } }
  const runId = 'full-library-once-controlled'
  const candidates = index.flatMap(row => (row.datasetKind === 'mini' ? ['agent2agent', 'noise'] : ['standard']).map(phase => ({ phase,
    config: row.config, scenarioId: row.id, sourcePath: row.path, rowIndex: row.rowIndex,
    scenarioHash: row.scenarioHash, scenarioVersion: row.scenarioVersion, runNumber: 1, attemptIndex: 0, correctionOrdinal: 0 })))
  const tasks = orderFullLibraryTasks(candidates).map((task, ordinal) => ({ ...task, executionId: `${runId}-task-${String(ordinal + 1).padStart(4, '0')}` }))
  const manifest = { schemaVersion: FULL_LIBRARY_SCHEMA, runId, runRoot: `runs/${runId}`, mode: 'full_library_once',
    officialSubmissionProtocol: 'official_submission_3runs_not_used', originalTaskCount: 800,
    uniqueOriginalQuestionCount: 800, plannedExecutions: 1120, enhancedRunCount: 320,
    phaseCounts: { standard: 800, agent2agent: 160, noise: 160 }, syntheticFixtureOnly: false,
    officialSubmissionReady: false, originalCampaignModified: false, selectionRule: FULL_LIBRARY_SELECTION_RULE,
    executionBinding: 'phase3_live_plugin_host_required', correctionEnabled: false, resumeEnabled: false, reusePriorResults: false,
    temporal: { enabled: true }, conflictRecovery: { enabled: true }, entitySemantics: { enabled: true }, mutationReceipts: { enabled: true }, retrieval: { enabled: true, profile: 'standard-search' },
    capabilityScope: { temporal: 'standard', conflictRecovery: 'standard', entitySemantics: 'standard', mutationReceipts: 'standard', retrieval: 'standard-search' },
    stopPolicy: { ...FULL_LIBRARY_STOP_POLICY }, scopePolicy: { ...FULL_LIBRARY_SCOPE_POLICY }, models: structuredClone(protocol.models), settings: structuredClone(settings),
    dataset: { kind: 'submission', id: dataset.id, revision: dataset.revision, split: 'validation', standardCount: 800, miniCount: 160, files: structuredClone(files) },
    lockRefs: { scenarioIndex: structuredClone(datasetLock.scenarioIndex) }, tasks,
    modelConfigurationRef: { path: 'public-model.json', sha256: digest('public config'), contentNotCopied: true, credentialFileNotHashed: true },
    publicModelConfigurationHash: digest('effective public endpoint'), publicModelConnection: { endpoint: 'http://127.0.0.1:1234/v1' } }
  return { manifest, candidates, inputs: { protocol, datasetLock, index, settings } }
}

test('complete once-only manifest covers 800 Standard and 160 each enhanced phase, not submission3runs', () => {
  const { manifest, inputs } = fixture()
  assert.equal(validateFullLibraryPlanIdentity(manifest, inputs), true)
  assert.equal(manifest.originalTaskCount, 800)
  assert.equal(manifest.uniqueOriginalQuestionCount, 800)
  assert.equal(manifest.plannedExecutions, 1120)
  assert.equal(manifest.enhancedRunCount, 320)
  assert.equal(manifest.tasks.length, 1120)
  assert.equal(new Set(manifest.tasks.map(task => task.scenarioId)).size, 800)
  assert.equal(new Set(manifest.tasks.map(task => task.executionId)).size, 1120)
  assert.deepEqual(manifest.scopePolicy, FULL_LIBRARY_SCOPE_POLICY)
  assert.equal(new Set(manifest.tasks.map(task => `${task.phase}/${task.sourcePath}/${task.rowIndex}`)).size, 1120)
  for (const [phase, count] of Object.entries(manifest.phaseCounts)) assert.equal(manifest.tasks.filter(task => task.phase === phase).length, count)
  assert.ok(manifest.tasks.every(task => task.runNumber === 1 && task.attemptIndex === 0 && task.correctionOrdinal === 0))
  assert.equal(Object.hasOwn(manifest, 'taskContract'), false)
})

test('pure ordering exercises all seven streams immediately while first40 question IDs are distinct', () => {
  const { candidates } = fixture()
  const before = structuredClone(candidates)
  const tasks = orderFullLibraryTasks(candidates)
  assert.deepEqual(candidates, before, 'input tasks must not be mutated')
  assert.equal(new Set(tasks.slice(0, 40).map(task => task.scenarioId)).size, 40)
  const expectedBuckets = [...FULL_LIBRARY_CAPABILITIES.map(config => `standard/${config}`), 'agent2agent/mini', 'noise/mini']
  assert.deepEqual(tasks.slice(0, 7).map(task => `${task.phase}/${task.config}`), expectedBuckets)
  assert.deepEqual(new Set(tasks), new Set(candidates))
  assert.deepEqual(orderFullLibraryTasks([...candidates].reverse()), tasks, 'native source/row identity, not input order, controls each stream')
  assert.ok(tasks.slice(0, 40).filter(task => task.phase === 'agent2agent').length >= 5)
  assert.ok(tasks.slice(0, 40).filter(task => task.phase === 'noise').length >= 5)
})

test('bounded scope uses slot identity, enforces first-window coverage, and permits enhanced question reuse later', () => {
  const { candidates } = fixture()
  const tasks = orderFullLibraryTasks(candidates).map((task, index) => ({ ...task, executionId: `slot-${index}` }))
  const scope = fullLibraryScope(tasks, { taskLimit: 1120 })
  assert.equal(scope.taskLimit, 1120)
  assert.equal(scope.executionIds.length, 1120)
  assert.equal(scope.taskSlotIds.length, 1120)
  assert.equal(new Set(scope.taskSlotIds).size, 1120)
  assert.equal(new Set(scope.scenarioIds.slice(0, FULL_LIBRARY_SCOPE_POLICY.firstWindowDistinctScenarioIds)).size, 40)
  assert.ok(new Set(scope.scenarioIds).size < 1120, 'enhanced scenario IDs should be allowed to repeat after the first window')
  assert.throws(() => fullLibraryScope(tasks, { taskLimit: FULL_LIBRARY_SCOPE_POLICY.maxExecutions + 1 }), /1\.\.1120 executions/)
  const duplicateSlots = tasks.slice(0, 40).map((task, index) => ({ ...task, executionId: `duplicate-${index}` }))
  duplicateSlots[1] = { ...duplicateSlots[0], executionId: 'duplicate-reused-slot' }
  assert.throws(() => fullLibraryScope(duplicateSlots, { taskLimit: 40 }), /duplicate task slots/)
  assert.equal(taskSlotIdentity(tasks[0]), taskSlotIdentity({ ...tasks[0], executionId: 'different-ordinal' }))
  assert.notEqual(taskSlotIdentity(tasks[0]), taskSlotIdentity({ ...tasks[0], phase: 'noise' }))
})

test('small ordering fixtures retain duplicate question IDs without losing any execution', () => {
  const candidates = [{ phase: 'standard', config: 'time', scenarioId: 'same', rowIndex: 0 },
    { phase: 'agent2agent', config: 'mini', scenarioId: 'same', rowIndex: 0 },
    { phase: 'noise', config: 'mini', scenarioId: 'same', rowIndex: 0 }]
  assert.deepEqual(orderFullLibraryTasks(candidates), candidates)
  assert.throws(() => orderFullLibraryTasks([{ phase: 'other', config: 'mini' }]))
})

test('identity gate rejects changed row/config/source/hash/version and duplicated, omitted or rerun slots', () => {
  const { manifest, inputs } = fixture()
  const changes = [m => { m.tasks[0].scenarioId = 'different' }, m => { m.tasks[0].rowIndex++ },
    m => { m.tasks[0].config = 'mini' }, m => { m.tasks[0].sourcePath = 'data/source/time.parquet' },
    m => { m.tasks[0].scenarioHash = 'f'.repeat(64) }, m => { m.tasks[0].scenarioVersion = 'other-v2' },
    m => { m.tasks[0].runNumber = 2 }, m => { m.tasks[0].attemptIndex = 1 }, m => { m.tasks[0].correctionOrdinal = 1 },
    m => { m.tasks[1] = structuredClone(m.tasks[0]) }, m => { m.tasks.pop() }, m => { m.tasks[0].executionId = 'old-run-task' },
    m => { m.dataset.files[0].sha256 = 'f'.repeat(64) }, m => { m.lockRefs.scenarioIndex.sha256 = 'f'.repeat(64) },
    m => { m.dataset.revision = 'b'.repeat(40) }, m => { [m.tasks[0], m.tasks[1]] = [m.tasks[1], m.tasks[0]] }]
  for (const mutate of changes) {
    const altered = structuredClone(manifest); mutate(altered)
    assert.throws(() => validateFullLibraryPlanIdentity(altered, inputs))
  }
})

test('index source identities themselves require all locked native rows, ID sets and versions', () => {
  const { manifest, inputs } = fixture()
  const changes = [i => { i.index[0].rowIndex = 1 }, i => { i.index[0].path = 'data/other.parquet' },
    i => { i.index[0].id = 'wrong' }, i => { i.index[0].scenarioVersion = 'wrong' },
    i => { i.index[0].scenarioHash = 'not-a-sha256' }, i => { i.index.pop() },
    i => { i.datasetLock.datasets.submission.files[0].count = 159 }]
  for (const mutate of changes) {
    const altered = structuredClone(inputs); mutate(altered)
    assert.throws(() => validateFullLibraryPlanIdentity(manifest, altered))
  }
})

test('stop rule and thin current runtime are frozen; technical/unscored outcomes cannot be the first40', () => {
  const { manifest, inputs } = fixture()
  assert.deepEqual(manifest.stopPolicy, { firstScoredOutcomes: 40, stopIfAllScoresZero: true, technicalAndUnscoredExcluded: true })
  const changes = [m => { m.stopPolicy.firstScoredOutcomes = 10 }, m => { m.stopPolicy.stopIfAllScoresZero = false },
    m => { m.stopPolicy.technicalAndUnscoredExcluded = false }, m => { m.taskContract = { enabled: true } },
    m => { m.scopePolicy.maxExecutions = 1121 }, m => { m.scopePolicy.checkpointEvery = 20 },
    m => { m.entitySemantics.enabled = false }, m => { m.mutationReceipts.enabled = false },
    m => { m.settings.minimal = true }, m => { m.settings.maxActions = 1 }, m => { m.settings.concurrency = 2 },
    m => { m.settings.modelRetry.maxAttempts = 1 }, m => { m.models.actor.model = 'other' },
    m => { m.mode = 'official_submission' }, m => { m.officialSubmissionReady = true },
    m => { m.originalTaskCount = 1120 }, m => { m.plannedExecutions = 800 }, m => { m.enhancedRunCount = 160 },
    m => { m.uniqueOriginalQuestionCount = 1120 },
    m => { m.resumeEnabled = true }, m => { m.reusePriorResults = true }, m => { m.correctionEnabled = true },
    m => { m.publicModelConnection.endpoint = 'http://user:secret@127.0.0.1/v1' },
    m => { m.modelConfigurationRef.credentialFileNotHashed = false }]
  for (const mutate of changes) {
    const altered = structuredClone(manifest); mutate(altered)
    assert.throws(() => validateFullLibraryPlanIdentity(altered, inputs))
  }
})

test('frozen source/data byte changes fail closed even when manifest has a valid hash', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gaia2-full-library-frozen-'))
  try {
    const source = join(directory, 'source.mjs'), data = join(directory, 'original.parquet')
    writeFileSync(source, 'original source'); writeFileSync(data, 'original data')
    const base = { sources: [{ path: 'source.mjs', sha256: fileDigest(source) }], runtimeSources: [],
      dataset: { files: [{ path: 'original.parquet', sha256: fileDigest(data) }] }, modelConfigurationRef: {}, lockRefs: {} }
    const manifest = { ...base, manifestHash: digest(base) }
    writeFileSync(source, 'changed source')
    assert.throws(() => assertFullLibraryFrozen(directory, manifest), /frozen full-library source changed: source.mjs/)
    writeFileSync(source, 'original source'); writeFileSync(data, 'changed data')
    assert.throws(() => assertFullLibraryFrozen(directory, manifest), /frozen full-library source changed: original.parquet/)
    assert.throws(() => assertFullLibraryFrozen(directory, { ...manifest, manifestHash: '0'.repeat(64) }), /manifest hash changed/)
    assert.throws(() => loadFullLibraryPlan({ root: directory, path: '../outside.json' }), /must be under runs/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('freeze binds actual public model file plus effective endpoint, full dependencies, no credential hash or oracle classification', () => {
  const source = readFileSync(new URL('../scripts/full_library_plan.mjs', import.meta.url), 'utf8')
  assert.match(source, /sha256: fileDigest\(configurationPath\)/)
  assert.match(source, /publicModelConnection = \{ endpoint: baseUrl \}/)
  assert.match(source, /collectTemporalFrozenSources\(root, protocol\)/)
  assert.match(source, /filesBelow\(join\(root, 'node_modules'\)\)/)
  assert.match(source, /columns: \['scenario_id', 'data'\]/)
  assert.match(source, /canonicalScenarioHash\(scenario\), identity.scenarioHash/)
  assert.doesNotMatch(source, /fileDigest\([^)]*(?:apiKeySource|credential|apiKey)\b/)
  assert.doesNotMatch(source, /row\.category|scenario\.oracle|readModelConnection[^\n]*apiKey\s*\}/)
})
