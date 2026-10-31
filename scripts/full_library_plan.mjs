/** One fresh pass over the complete locked validation library; never a 3-run submission. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { canonicalScenarioHash, scenarioIdSetSha256 } from '../src/phase0_dataset.mjs'
import { freezePluginSnapshot, hashTree, inspectPluginResources } from '../src/phase0_inventory.mjs'
import { assertPublicConfig, digest, fileDigest, parseIndex, readJson, within } from '../src/phase0_run.mjs'
import { readModelConnection, resolveModelRetrySettings } from '../src/phase1_official.mjs'
import { resolveRuntimeSettings } from '../src/phase1_config.mjs'
import { ROOT, filesBelow, portable, save } from './temporal_e2e.mjs'
import { collectTemporalFrozenSources } from './temporal_official_ten.mjs'

export const FULL_LIBRARY_SCHEMA = 'gaia2-full-library-once-manifest-v1'
export const FULL_LIBRARY_CAPABILITIES = Object.freeze(['execution', 'search', 'adaptability', 'time', 'ambiguity'])
export const FULL_LIBRARY_STOP_POLICY = Object.freeze({ firstScoredOutcomes: 40, stopIfAllScoresZero: true, technicalAndUnscoredExcluded: true })
export const FULL_LIBRARY_SELECTION_RULE = 'All 800 original non-mini submission validation rows once in Standard, all 160 original mini validation rows once in agent2agent and once in noise; no oracle, prompt, historical score or success-based selection; seven-stream coverage-balanced ordering with distinct scenario IDs in the first 40 queued executions; run1, attempt0, correction0; no resume or prior result reuse'
const BUCKETS = [...FULL_LIBRARY_CAPABILITIES.map(config => `standard/${config}`), 'agent2agent/mini', 'noise/mini']
const SHA256 = /^[0-9a-f]{64}$/

/** Pure permutation. Mini categories/oracle contents are never consulted. */
export function orderFullLibraryTasks(tasks) {
  assert.ok(Array.isArray(tasks))
  const groups = BUCKETS.map(() => [])
  for (const task of tasks) {
    const bucket = BUCKETS.indexOf(`${task.phase}/${task.config}`)
    assert.ok(bucket !== -1, 'unsupported full-library phase/config')
    groups[bucket].push(task)
  }
  for (const group of groups) group.sort((a, b) => String(a.sourcePath ?? '').localeCompare(String(b.sourcePath ?? ''))
    || (a.rowIndex ?? 0) - (b.rowIndex ?? 0) || String(a.scenarioId ?? '').localeCompare(String(b.scenarioId ?? '')))
  const ordered = [], earlyIds = new Set()
  while (groups.some(group => group.length)) {
    let advanced = false
    for (const group of groups) {
      if (!group.length) continue
      const index = earlyIds.size < 40 ? group.findIndex(task => !earlyIds.has(task.scenarioId)) : 0
      if (index === -1) continue
      const [task] = group.splice(index, 1)
      ordered.push(task); earlyIds.add(task.scenarioId); advanced = true
    }
    // Small controlled fixtures may contain fewer than 40 distinct questions.
    if (!advanced) for (const group of groups) if (group.length) ordered.push(group.shift())
  }
  assert.equal(ordered.length, tasks.length)
  assert.equal(new Set(ordered).size, tasks.length, 'duplicate task object in full-library input')
  return ordered
}

function currentSettings(protocol) {
  return { ...resolveRuntimeSettings({ protocol, entrypoint: 'pilot' }), modelRetry: resolveModelRetrySettings() }
}

/** Freeze actual public JSON bytes and the effective endpoint, but never credential-file bytes. */
function currentModelConfiguration(root, models) {
  const configurationPath = resolve(root, models.configurationSource)
  assert.ok(within(root, configurationPath), 'public model configuration must be inside the work project')
  const publicConfiguration = readJson(configurationPath)
  assertPublicConfig(publicConfiguration)
  const { baseUrl } = readModelConnection(root, models)
  const publicModelConnection = { endpoint: baseUrl }
  assertPublicConfig(publicModelConnection)
  return {
    modelConfigurationRef: { path: models.configurationSource, sha256: fileDigest(configurationPath), contentNotCopied: true, credentialFileNotHashed: true },
    publicModelConnection,
    publicModelConfigurationHash: digest({ models, publicConfiguration, publicModelConnection }),
  }
}

/** Add complete local Parquet-reader dependency trees, including binary decoders. */
export function collectFullLibraryFrozenSources(root, protocol) {
  const sources = new Map(collectTemporalFrozenSources(root, protocol).map(ref => [ref.path, ref]))
  const add = (path, category) => {
    const key = portable(relative(root, path))
    sources.set(key, { path: key, sha256: fileDigest(path), category })
  }
  for (const path of filesBelow(join(root, 'node_modules'))) add(path, 'node-parquet-reader-and-installed-dependencies')
  for (const path of [join(root, 'package.json'), join(root, 'data/scenario-index.jsonl')]) add(path, 'full-library-plan-input')
  return [...sources.values()].sort((a, b) => a.path.localeCompare(b.path))
}

function selectedRows(index, dataset) {
  const rows = index.filter(row => row.datasetKind === 'submission' && FULL_LIBRARY_CAPABILITIES.includes(row.config)
    || row.datasetKind === 'mini' && row.config === 'mini')
  assert.equal(rows.length, 960, 'complete Standard plus mini source identities required')
  const files = new Map(dataset.files.map(ref => [ref.path, ref]))
  assert.equal(files.size, dataset.files.length)
  for (const config of [...FULL_LIBRARY_CAPABILITIES, 'mini']) {
    const matching = rows.filter(row => row.config === config)
    assert.equal(matching.length, 160, `full-library ${config} must contain exactly 160 source rows`)
    assert.equal(new Set(matching.map(row => row.id)).size, 160, `duplicate ${config} scenario ID`)
  }
  for (const row of rows) {
    const ref = files.get(row.path)
    assert.equal(ref?.config, row.config, 'index source/config disagrees with locked dataset')
    assert.ok(Number.isSafeInteger(row.rowIndex) && row.rowIndex >= 0 && row.rowIndex < ref.count)
    assert.ok(typeof row.id === 'string' && row.id.length > 0)
    assert.match(row.scenarioHash, SHA256)
    assert.ok(typeof row.scenarioVersion === 'string' && row.scenarioVersion.length > 0)
  }
  for (const ref of dataset.files) {
    const matching = rows.filter(row => row.path === ref.path)
    assert.equal(matching.length, ref.count)
    assert.deepEqual(matching.map(row => row.rowIndex).sort((a, b) => a - b), Array.from({ length: ref.count }, (_, i) => i))
    assert.equal(scenarioIdSetSha256(matching.map(row => row.id)), ref.scenarioIdSetSha256)
    assert.deepEqual([...new Set(matching.map(row => row.scenarioVersion))].sort(), [...ref.scenarioVersions].sort())
  }
  const standard = rows.filter(row => row.datasetKind === 'submission')
  assert.equal(new Set(standard.map(row => row.id)).size, 800)
  assert.equal(scenarioIdSetSha256(standard.map(row => row.id)), dataset.scenarioIdSetSha256)
  return rows
}

function tasksFromIndex(index, dataset, runId) {
  const unordered = selectedRows(index, dataset).flatMap(row => {
    const identity = { config: row.config, scenarioId: row.id, sourcePath: row.path, rowIndex: row.rowIndex,
      scenarioHash: row.scenarioHash, scenarioVersion: row.scenarioVersion, runNumber: 1, attemptIndex: 0, correctionOrdinal: 0 }
    return row.datasetKind === 'submission' ? [{ ...identity, phase: 'standard' }]
      : ['agent2agent', 'noise'].map(phase => ({ ...identity, phase }))
  })
  return orderFullLibraryTasks(unordered).map((task, index) => ({ ...task, executionId: `${runId}-task-${String(index + 1).padStart(4, '0')}` }))
}

/** Pure authority: a rehashed manifest cannot change source identity or execution policy. */
export function validateFullLibraryPlanIdentity(manifest, { protocol, datasetLock, index, settings = currentSettings(protocol) }) {
  assert.equal(manifest.schemaVersion, FULL_LIBRARY_SCHEMA)
  assert.match(manifest.runId, /^full-library-once-[A-Za-z0-9-]+$/)
  assert.equal(manifest.runRoot, `runs/${manifest.runId}`)
  assert.equal(manifest.mode, 'full_library_once')
  assert.equal(manifest.officialSubmissionProtocol, 'official_submission_3runs_not_used')
  assert.equal(manifest.originalTaskCount, 800)
  assert.equal(manifest.uniqueOriginalQuestionCount, 800)
  assert.equal(manifest.plannedExecutions, 1120)
  assert.equal(manifest.enhancedRunCount, 320)
  assert.deepEqual(manifest.phaseCounts, { standard: 800, agent2agent: 160, noise: 160 })
  assert.equal(manifest.syntheticFixtureOnly, false)
  assert.equal(manifest.officialSubmissionReady, false)
  assert.equal(manifest.originalCampaignModified, false)
  assert.equal(manifest.selectionRule, FULL_LIBRARY_SELECTION_RULE)
  assert.equal(manifest.executionBinding, 'phase3_live_plugin_host_required')
  assert.equal(manifest.correctionEnabled, false)
  assert.equal(manifest.resumeEnabled, false)
  assert.equal(manifest.reusePriorResults, false)
  assert.equal(Object.hasOwn(manifest, 'taskContract'), false, 'task contract is retired')
  for (const key of ['temporal', 'conflictRecovery', 'entitySemantics', 'mutationReceipts']) assert.deepEqual(manifest[key], { enabled: true })
  assert.deepEqual(manifest.capabilityScope, { temporal: 'standard', conflictRecovery: 'standard', entitySemantics: 'standard', mutationReceipts: 'standard' })
  assert.deepEqual(manifest.stopPolicy, FULL_LIBRARY_STOP_POLICY)
  assert.deepEqual(manifest.models, protocol.models)
  assert.equal(typeof manifest.models.actor.model, 'string')
  assert.ok(manifest.models.actor.model.length > 0)
  assert.equal(typeof manifest.models.judge.model, 'string')
  assert.ok(manifest.models.judge.model.length > 0)
  assert.deepEqual(manifest.settings, settings)
  assert.equal(manifest.settings.minimal, false)
  assert.equal(manifest.settings.concurrency, 1)
  const dataset = datasetLock.datasets.submission
  assert.equal(dataset.id, protocol.datasets.submission.id)
  assert.equal(dataset.revision, protocol.datasets.submission.revision)
  assert.equal(dataset.split, 'validation')
  assert.equal(dataset.count, 800)
  assert.deepEqual([...dataset.configs].sort(), [...FULL_LIBRARY_CAPABILITIES, 'mini'].sort())
  assert.deepEqual(manifest.dataset, { kind: 'submission', id: dataset.id, revision: dataset.revision, split: dataset.split,
    standardCount: 800, miniCount: 160, files: dataset.files })
  assert.deepEqual(manifest.lockRefs.scenarioIndex, datasetLock.scenarioIndex)
  assert.equal(index.length, datasetLock.scenarioIndex.count)
  assert.deepEqual(manifest.tasks, tasksFromIndex(index, dataset, manifest.runId))
  assert.equal(manifest.tasks.length, 1120)
  assert.equal(new Set(manifest.tasks.map(task => task.executionId)).size, 1120)
  assert.equal(new Set(manifest.tasks.map(task => task.scenarioId)).size, 800)
  assert.equal(new Set(manifest.tasks.slice(0, 40).map(task => task.scenarioId)).size, 40)
  assert.equal(manifest.modelConfigurationRef.path, manifest.models.configurationSource)
  assert.equal(manifest.modelConfigurationRef.contentNotCopied, true)
  assert.equal(manifest.modelConfigurationRef.credentialFileNotHashed, true)
  assert.match(manifest.modelConfigurationRef.sha256, SHA256)
  assert.match(manifest.publicModelConfigurationHash, SHA256)
  assertPublicConfig(manifest)
  return true
}

/** Verify every live code/data/config source and both content-addressed plugin trees. */
export function assertFullLibraryFrozen(root, manifest) {
  root = resolve(root)
  const { manifestHash, ...base } = manifest
  assert.equal(digest(base), manifestHash, 'full-library manifest hash changed')
  const refs = [...manifest.sources, ...manifest.runtimeSources, ...manifest.dataset.files,
    manifest.modelConfigurationRef, ...Object.values(manifest.lockRefs)]
  for (const ref of refs) assert.equal(fileDigest(resolve(root, ref.path)), ref.sha256, `frozen full-library source changed: ${ref.path}`)
  const protocol = readJson(join(root, 'config/phase0-protocol.json'))
  const datasetLock = readJson(join(root, 'locks/dataset-lock.json'))
  const index = parseIndex(resolve(root, datasetLock.scenarioIndex.path))
  validateFullLibraryPlanIdentity(manifest, { protocol, datasetLock, index })
  assert.deepEqual(manifest.runtimeSources, collectFullLibraryFrozenSources(root, protocol), 'live source inventory changed')
  const model = currentModelConfiguration(root, manifest.models)
  for (const key of Object.keys(model)) assert.deepEqual(manifest[key], model[key], 'public model configuration or effective endpoint changed')
  const capabilities = readJson(resolve(root, manifest.lockRefs.capabilities.path))
  assert.equal(capabilities.schemaVersion, 'gaia2-full-library-capabilities-v1')
  assert.deepEqual(capabilities.plugins.map(plugin => plugin.id), ['gaia2-runtime', 'gaia2-evaluation'])
  for (const plugin of capabilities.plugins) {
    for (const path of [plugin.snapshotRoot, plugin.sourceRoot]) assert.equal(hashTree(path).treeSha256, plugin.treeSha256, 'plugin source or snapshot changed')
    assert.deepEqual(inspectPluginResources(plugin), plugin)
  }
  return capabilities
}

export function loadFullLibraryPlan({ root = ROOT, path } = {}) {
  root = resolve(root)
  const absolute = resolve(root, path)
  assert.ok(within(join(root, 'runs'), absolute), 'full-library manifest must be under runs')
  const manifest = readJson(absolute)
  assert.equal(absolute, resolve(root, manifest.runRoot, 'manifest.json'))
  assertFullLibraryFrozen(root, manifest)
  return manifest
}

/** Read original mini JSON only for ID/version/hash binding, never for categorization. */
async function verifyOriginalMini(root, dataset, index) {
  for (const ref of dataset.files.filter(item => item.config === 'mini')) {
    const expected = index.filter(row => row.datasetKind === 'mini' && row.path === ref.path).sort((a, b) => a.rowIndex - b.rowIndex)
    const file = await asyncBufferFromFile(resolve(root, ref.path))
    for (let start = 0; start < ref.count; start += 20) {
      const rows = await parquetReadObjects({ file, columns: ['scenario_id', 'data'], rowStart: start, rowEnd: Math.min(start + 20, ref.count), compressors })
      assert.equal(rows.length, Math.min(20, ref.count - start))
      for (const [offset, row] of rows.entries()) {
        const identity = expected[start + offset], scenario = JSON.parse(row.data)
        assert.equal(row.scenario_id, identity.id)
        assert.equal(scenario.metadata?.definition?.scenario_id, identity.id)
        assert.equal(scenario.version, identity.scenarioVersion)
        assert.equal(canonicalScenarioHash(scenario), identity.scenarioHash)
      }
    }
  }
}

/** Explicit only. The caller must finish all source edits before invoking prepare. */
export async function prepareFullLibrary({ root = ROOT } = {}) {
  root = resolve(root)
  const protocol = readJson(join(root, 'config/phase0-protocol.json'))
  const datasetLock = readJson(join(root, 'locks/dataset-lock.json'))
  const dataset = datasetLock.datasets.submission
  assert.equal(fileDigest(resolve(root, datasetLock.scenarioIndex.path)), datasetLock.scenarioIndex.sha256)
  const index = parseIndex(resolve(root, datasetLock.scenarioIndex.path))
  selectedRows(index, dataset)
  for (const ref of dataset.files) assert.equal(fileDigest(resolve(root, ref.path)), ref.sha256, 'original validation file differs from phase0 lock')
  await verifyOriginalMini(root, dataset, index)
  const models = structuredClone(protocol.models), settings = currentSettings(protocol)
  assert.equal(settings.minimal, false)
  assert.equal(settings.concurrency, 1)
  assert.ok(!process.env.GAIA2_E2E_TOOL_ALLOWLIST, 'original library cannot use a smoke allowlist')
  const modelConfiguration = currentModelConfiguration(root, models)
  const runId = `full-library-once-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`
  const runRoot = `runs/${runId}`, directory = join(root, runRoot)
  assert.ok(!existsSync(directory)); mkdirSync(directory, { recursive: true })
  const plugins = ['gaia2-runtime', 'gaia2-evaluation'].map(id => inspectPluginResources(freezePluginSnapshot({ root, id, sourceRoot: join(root, 'plugins', id) })))
  const capabilityRef = save(join(directory, 'capabilities.json'), { schemaVersion: 'gaia2-full-library-capabilities-v1', plugins })
  const sourcePaths = ['config/phase0-protocol.json', 'locks/dataset-lock.json', 'data/scenario-index.jsonl', 'package.json', 'package-lock.json']
  const sources = sourcePaths.map(path => ({ path, sha256: fileDigest(join(root, path)) }))
  const base = { schemaVersion: FULL_LIBRARY_SCHEMA, runId, runRoot, mode: 'full_library_once',
    officialSubmissionProtocol: 'official_submission_3runs_not_used', originalTaskCount: 800,
    uniqueOriginalQuestionCount: 800, plannedExecutions: 1120, enhancedRunCount: 320,
    phaseCounts: { standard: 800, agent2agent: 160, noise: 160 }, syntheticFixtureOnly: false, officialSubmissionReady: false,
    selectionRule: FULL_LIBRARY_SELECTION_RULE, correctionEnabled: false, resumeEnabled: false, reusePriorResults: false,
    temporal: { enabled: true }, conflictRecovery: { enabled: true }, entitySemantics: { enabled: true }, mutationReceipts: { enabled: true },
    capabilityScope: { temporal: 'standard', conflictRecovery: 'standard', entitySemantics: 'standard', mutationReceipts: 'standard' },
    stopPolicy: { ...FULL_LIBRARY_STOP_POLICY }, executionBinding: 'phase3_live_plugin_host_required', models, settings, ...modelConfiguration,
    dataset: { kind: 'submission', id: dataset.id, revision: dataset.revision, split: dataset.split, standardCount: 800, miniCount: 160, files: dataset.files },
    lockRefs: { capabilities: { path: portable(relative(root, capabilityRef.path)), sha256: capabilityRef.sha256 },
      protocol: sources.find(ref => ref.path === 'config/phase0-protocol.json'), dataset: sources.find(ref => ref.path === 'locks/dataset-lock.json'), scenarioIndex: datasetLock.scenarioIndex },
    tasks: tasksFromIndex(index, dataset, runId), sources, runtimeSources: collectFullLibraryFrozenSources(root, protocol),
    sourceFreezeCoverage: 'All current work src/scripts; backend src; ARE/model/HTTP SDK code; actual Node/Python executables; Host loader dependencies; complete installed local node dependency trees including hyparquet/compressors and binary decoders; package/protocol/dataset/index locks; current public model configuration and effective endpoint; live and content-addressed plugin trees. Revalidate before each dispatch and after execution.',
    knownJudgeDefect: 'ARE 1.2.0 Boolean marker case incompatibility retained unchanged; raw scores are diagnostic, not a corrected official result.',
    originalCampaignModified: false }
  const manifest = { ...base, manifestHash: digest(base) }
  assertFullLibraryFrozen(root, manifest)
  const manifestPath = join(directory, 'manifest.json'); save(manifestPath, manifest)
  return { status: 'prepared_not_executed', runId, manifestPath: portable(manifestPath), originalTaskCount: 800,
    uniqueOriginalQuestionCount: 800, plannedExecutions: 1120, enhancedRunCount: 320,
    phaseCounts: manifest.phaseCounts, manifest }
}
