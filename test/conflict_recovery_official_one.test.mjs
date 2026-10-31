import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { TARGET_ID, THIN_RUNTIME_MODE, REFERENCE_MANIFEST, SELECTION_RULE, assertUnchangedPublicConfiguration, assertRunnableOfficialOneProfile, parseConflictOfficialOneArgs, validateOfficialOneIdentity } from '../scripts/conflict_recovery_official_one.mjs'

test('fixed original task needs separate prepare/run/verify and rejects batch/resume/task overrides', () => {
  assert.equal(TARGET_ID, 'scenario_universe_22_9pq84p')
  assert.deepEqual(parseConflictOfficialOneArgs(['--prepare']), { mode: 'prepare' })
  assert.deepEqual(parseConflictOfficialOneArgs(['--run', 'runs/new/manifest.json']), { mode: 'run', path: 'runs/new/manifest.json' })
  assert.deepEqual(parseConflictOfficialOneArgs(['--verify', 'runs/new/manifest.json']), { mode: 'verify', path: 'runs/new/manifest.json' })
  for (const argv of [[], ['--run'], ['--run', '--prepare'], ['--prepare', '--run', 'x'], ['--batch'], ['--resume', 'x'], ['--task', TARGET_ID], ['--count', '10'], ['--runs', '5'], ['--prepare', '--case', 'confirmed']]) assert.throws(() => parseConflictOfficialOneArgs(argv))
})

function identities() {
  const original = { scenarioId: TARGET_ID, config: 'time', scenarioVersion: 'are_simulation_v1', scenarioHash: 'a'.repeat(64),
    sourcePath: 'data/time.parquet', rowIndex: 1, phase: 'standard', runNumber: 1, attemptIndex: 0, correctionOrdinal: 0 }
  const reference = { tasks: [original], models: { actor: { model: 'gpt-6-luna' }, judge: { model: 'gpt-6-luna' }, configurationSource: 'public-model-config.json' },
    settings: { minimal: false, concurrency: 1, maxActions: 300, modelRequestTimeoutSeconds: 60, modelRetry: { maxAttempts: 6 } },
    dataset: { id: 'official', revision: 'revision', split: 'validation', files: [{ path: original.sourcePath, config: 'time', sha256: 'b'.repeat(64) }] } }
  const runId = 'conflict-recovery-official-one-test'
  const manifest = { schemaVersion: 'gaia2-conflict-recovery-official-one-manifest-v1', runId, runRoot: `runs/${runId}`,
    mode: 'temporal_conflict_recovery_diagnostic',
    originalTaskCount: 1, syntheticFixtureOnly: false, officialSubmissionReady: false, selectionRule: SELECTION_RULE,
    temporal: { enabled: true }, conflictRecovery: { enabled: true }, correctionEnabled: false, originalCampaignModified: false,
    executionBinding: 'phase3_live_plugin_host_required', models: structuredClone(reference.models), settings: structuredClone(reference.settings),
    tasks: [{ ...original, executionId: `${runId}-task-02` }], dataset: { kind: 'submission', ...structuredClone(reference.dataset) },
    referenceManifest: { path: REFERENCE_MANIFEST }, modelConfigurationRef: { path: reference.models.configurationSource,
      contentNotCopied: true, credentialFileNotHashed: true } }
  return { manifest, reference }
}

test('identity authority permits only one original Standard/run1 and unchanged model/runtime settings', () => {
  const { manifest, reference } = identities()
  assert.equal(validateOfficialOneIdentity(manifest, reference), true)
  const variants = [m => m.tasks.push(structuredClone(m.tasks[0])), m => { m.originalTaskCount = 10 },
    m => { m.tasks[0].scenarioId = 'another' }, m => { m.tasks[0].scenarioHash = 'c'.repeat(64) },
    m => { m.tasks[0].rowIndex = 2 }, m => { m.tasks[0].phase = 'noise' }, m => { m.tasks[0].runNumber = 2 },
    m => { m.tasks[0].correctionOrdinal = 1 }, m => { m.settings.maxActions = 1 }, m => { m.settings.modelRetry.maxAttempts = 7 },
    m => { m.models.actor.model = 'another' }, m => { m.conflictRecovery.enabled = false },
    m => { m.temporal.enabled = false }, m => { m.syntheticFixtureOnly = true }, m => { m.officialSubmissionReady = true },
    m => { m.dataset.files.push({ path: 'other.parquet' }) }, m => { m.originalCampaignModified = true }]
  for (const mutate of variants) { const value = structuredClone(manifest); mutate(value); assert.throws(() => validateOfficialOneIdentity(value, reference)) }
})

test('thin plan keeps entity/mutation evidence without task-contract capability; legacy plan cannot execute', () => {
  const { manifest, reference } = identities()
  manifest.mode = THIN_RUNTIME_MODE
  manifest.entitySemantics = { enabled: true }
  manifest.mutationReceipts = { enabled: true }
  assert.equal(validateOfficialOneIdentity(manifest, reference), true)
  assert.equal(assertRunnableOfficialOneProfile(manifest), true)
  const legacy = { ...manifest, mode: 'temporal_conflict_entity_wait_diagnostic', taskContract: { enabled: true } }
  assert.equal(validateOfficialOneIdentity(legacy, reference), true)
  assert.throws(() => assertRunnableOfficialOneProfile(legacy), /verification-only/)
  const mismatched = { ...manifest, taskContract: { enabled: true } }
  assert.throws(() => validateOfficialOneIdentity(mismatched, reference))
})

test('runner keeps actual model/official judge path and enables both controllers without Actor scripting', () => {
  const source = readFileSync(new URL('../scripts/conflict_recovery_official_one.mjs', import.meta.url), 'utf8')
  assert.match(source, /scripts\/temporal_official_entry\.py/)
  assert.match(source, /fixtureFromScenario\(await readOriginalScenario\(root, task\), task\)/)
  assert.match(source, /temporal: \{ enabled: true \}, conflictRecovery: \{ enabled: true \}/)
  for (const name of ['GAIA2_TEMPORAL_ENABLED', 'GAIA2_TEMPORAL_WORKSPACE', 'GAIA2_CONFLICT_RECOVERY_ENABLED', 'GAIA2_CONFLICT_RECOVERY_WORKSPACE', 'GAIA2_MODEL_HTTP_GUARD_REQUIRED']) assert.ok(source.includes(name))
  assert.match(source, /readNativeResult\(/)
  assert.match(source, /verifyTemporalReceipts\(/)
  assert.match(source, /verifyConflictReceipts\(/)
  assert.match(source, /collectTemporalFrozenSources\(/)
  assert.match(source, /resolveRuntimeSettings\(\{ protocol, entrypoint: 'pilot' \}\)/)
  assert.match(source, /modelRetry: resolveModelRetrySettings\(\)/)
  assert.doesNotMatch(source, /bridge\._call_model\s*=|scriptedActor|--a2a|--noise|writeFileSync/)
})

test('fresh configuration changes fail closed with public field names only', () => {
  const { manifest, reference } = identities()
  assert.equal(assertUnchangedPublicConfiguration(manifest, reference), true)
  manifest.settings.modelRetry.maxAttempts = 7
  assert.throws(() => assertUnchangedPublicConfiguration(manifest, reference), error => {
    assert.equal(error.code, 'official_one_public_configuration_changed')
    assert.deepEqual(error.configurationDifferences, ['settings.modelRetry.maxAttempts'])
    assert.equal(JSON.stringify(error).includes('apiKey'), false)
    return true
  })
})
