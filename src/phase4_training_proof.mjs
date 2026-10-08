import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, lstatSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { digest } from './phase0_run.mjs'
import { healthyTrainingProcess } from './phase4_training_broker.mjs'
import { CORRECTION_CONTRACT, deriveCorrectionEvidence, parseCorrectionPlan, renderTrustedCorrection } from './phase4_correction_contract.mjs'

const portable = value => value.replaceAll('\\', '/')
const sha = value => createHash('sha256').update(value).digest('hex')
const jsonHash = value => sha(JSON.stringify(value)) // Host preserves insertion order; digest is canonical.
const HASH = /^[a-f0-9]{64}$/
const SOURCES = {
  project: ['src/phase4_training.mjs', 'src/phase4_training_proof.mjs', 'src/phase4_training_broker.mjs', 'src/phase4_correction_contract.mjs',
    'scripts/phase4_training_host.ts', 'scripts/phase4_training_broker.py', 'scripts/gaia2_model_retry.py'],
  backend: ['src/core/plugins/training-plugin-host.ts', 'src/core/system-variable-values.ts'],
}
const DIAGNOSTIC_SOURCES = { ...SOURCES, project: [...SOURCES.project, 'scripts/gaia2_model_diagnostics.py'] }
function check(condition, code) { if (!condition) throw new Error(`Phase 4 training proof: ${code}`) }
function path(value) {
  check(typeof value === 'string' && value && !/^[\\/]|^[a-zA-Z]:/.test(value) && !/[\\\0:]/.test(value)
    && !value.split('/').some(part => !part || part === '.' || part === '..'), 'unsafe relative path')
  return value
}
function noLinks(file) { for (let at = file; ; at = dirname(at)) { check(!lstatSync(at).isSymbolicLink(), 'symbolic source'); if (at === dirname(at)) break } }

export function sealTrainingParent({ root, outputDir, parent }) {
  check(parent.evidenceBytes instanceof Map && parent.evidence.verification, 'parent must be independently loaded')
  const directory = join(outputDir, 'parent-evidence'); mkdirSync(directory)
  const files = [...parent.evidenceBytes].sort(([a], [b]) => a.localeCompare(b)).map(([originalPath, bytes], index) => {
    path(originalPath)
    const file = join(directory, `${String(index).padStart(6, '0')}.bin`)
    writeFileSync(file, bytes, { flag: 'wx' })
    return { originalPath, path: portable(relative(root, file)), sha256: sha(bytes) }
  })
  return { schemaVersion: 'gaia2-phase4-parent-evidence-v1', manifestPath: portable(relative(root, parent.manifestPath)),
    executionId: parent.task.executionId, sourceHash: parent.evidence.verification.sourceHash, files }
}
export function readSealedTrainingParent({ parentEvidence, readEvidence }) {
  check(parentEvidence?.schemaVersion === 'gaia2-phase4-parent-evidence-v1' && Array.isArray(parentEvidence.files), 'missing sealed parent')
  const files = new Map()
  for (const ref of parentEvidence.files) {
    path(ref.originalPath); check(!files.has(ref.originalPath) && HASH.test(ref.sha256), 'duplicate sealed parent identity')
    const bytes = readEvidence(path(ref.path)); check(Buffer.isBuffer(bytes) && sha(bytes) === ref.sha256, 'sealed parent SHA changed'); files.set(ref.originalPath, bytes)
  }
  const reader = key => { check(files.has(path(key)), 'unsealed parent dependency'); return Buffer.from(files.get(key)) }
  const manifest = JSON.parse(reader(parentEvidence.manifestPath)), task = manifest.tasks.find(task => task.executionId === parentEvidence.executionId)
  check(task?.correctionOrdinal === 0, 'not an initial parent')
  const state = JSON.parse(reader(portable(manifest.stateFile))), record = state.tasks.find(record => record.executionId === task.executionId)
  check(record?.resultPath && record.sessions?.length, 'sealed parent result missing')
  const session = record.sessions.at(-1), resultBytes = reader(record.resultPath), result = JSON.parse(resultBytes)
  check(sha(resultBytes) === record.resultSha256, 'sealed parent result SHA')
  const events = reader(portable(join(session.outputDir, 'runtime-events.jsonl'))).toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
  const evidence = deriveCorrectionEvidence({ manifest, task, session, result, events, readEvidence: reader })
  check(evidence.trainingAllowed === true && evidence.verification.sourceHash === parentEvidence.sourceHash, 'sealed parent independent verification failed')
  return { manifest, manifestPath: parentEvidence.manifestPath, task, session, result, resultPath: record.resultPath,
    resultHash: record.resultSha256, events, readEvidence: reader, evidence }
}

export function sealTrainingBaseline({ root, outputDir, manifest, manifestPath, protocol, readEvidence }) {
  const directory = join(outputDir, 'training-baseline'); mkdirSync(directory)
  let sequence = 0
  const copy = (bytes, suffix) => {
    const file = join(directory, `${String(++sequence).padStart(6, '0')}-${suffix}`)
    writeFileSync(file, bytes, { flag: 'wx' }); return { path: portable(relative(root, file)), sha256: sha(bytes) }
  }
  const manifestRef = copy(readEvidence(portable(relative(root, manifestPath))), 'manifest.json')
  const locks = Object.entries(manifest.lockRefs).map(([key, ref]) => {
    const bytes = readEvidence(ref.path); check(sha(bytes) === ref.sha256, 'training lock changed while sealing')
    return { key, originalPath: ref.path, ...copy(bytes, 'lock.bin') }
  })
  const env = JSON.parse(readEvidence(manifest.lockRefs.environment.path)), caps = JSON.parse(readEvidence(manifest.lockRefs.capabilities.path)), sourceFiles = []
  for (const [scope, names] of Object.entries(DIAGNOSTIC_SOURCES)) for (const relativePath of names) {
    const file = resolve(scope === 'project' ? root : protocol.runtime.backendRoot, relativePath); noLinks(file)
    const bytes = readFileSync(file), expected = (scope === 'project' ? env.codeInputs : env.backend.codeInputs).find(item => item.path === relativePath)
    check(expected?.sha256 === sha(bytes), 'training implementation changed while sealing')
    sourceFiles.push({ scope, relativePath, ...copy(bytes, 'source.bin') })
  }
  for (const plugin of caps.plugins) for (const ref of plugin.files) {
    const file = resolve(plugin.snapshotRoot, ref.relativePath); noLinks(file)
    const bytes = readFileSync(file); check(sha(bytes) === ref.sha256, 'training plugin changed while sealing')
    sourceFiles.push({ scope: `plugin:${plugin.id}`, relativePath: ref.relativePath, ...copy(bytes, 'plugin.bin') })
  }
  return { manifestRef, baseline: { schemaVersion: 'gaia2-phase4-training-baseline-v2', locks, sourceFiles } }
}

/** Pure, relocatable verification. The reader may map every path to bundle copies. */
export function verifyTrainingProbeEvidence({ trainingReportRef, readEvidence }) {
  const reportBytes = readEvidence(path(trainingReportRef.path))
  check(HASH.test(trainingReportRef.sha256) && sha(reportBytes) === trainingReportRef.sha256, 'training report SHA changed')
  const report = JSON.parse(reportBytes)
  check(report.schemaVersion === 'gaia2-phase4-training-probe-v1' && report.status === 'strategy_ready'
    && report.taskLocalOnly === true && report.projectExperiencePromoted === false && report.correctionOrdinal === 1
    && report.initialAttemptCountDelta === 0 && report.replayExecuted === false && report.officialSubmissionReady === false, 'unadmissible training report')
  check(Array.isArray(report.evidence) && report.evidence.length, 'empty training evidence')
  const evidenceRoot = trainingReportRef.path.slice(0, trainingReportRef.path.lastIndexOf('/') + 1)
  check(evidenceRoot.length > 0, 'training report has no isolated directory')
  const bound = new Map()
  for (const ref of report.evidence) {
    path(ref.path); check(ref.path.startsWith(evidenceRoot) && ref.path !== trainingReportRef.path
      && HASH.test(ref.sha256) && !bound.has(ref.path), 'invalid training evidence identity')
    const content = readEvidence(ref.path); check(Buffer.isBuffer(content) && sha(content) === ref.sha256, 'training evidence SHA changed'); bound.set(ref.path, content)
  }
  const bytes = value => { path(value); check(bound.has(value), 'unbound training evidence'); return bound.get(value) }
  const json = value => JSON.parse(bytes(value))
  const refJson = ref => { check(ref && sha(bytes(ref.path)) === ref.sha256, 'training ref SHA changed'); return json(ref.path) }
  const parent = readSealedTrainingParent({ parentEvidence: report.parentEvidence, readEvidence: bytes })
  check(report.parentExecutionId === parent.task.executionId && report.parentSessionId === parent.session.sessionId
    && report.parentResultHash === parent.resultHash && digest(report.sanitizedInput) === digest(parent.evidence.sealed), 'training parent lineage changed')
  const manifest = refJson(report.trainingManifest), { manifestHash, ...manifestContent } = manifest
  check(manifestHash === digest(manifestContent) && manifest.executionBinding === 'phase3_live_plugin_host_required'
    && manifest.mode === 'internal_pass5' && manifest.dataset.kind === 'source' && manifest.syntheticFixtureOnly !== true, 'invalid frozen training manifest')
  const baseline = report.trainingBaseline
  check(['gaia2-phase4-training-baseline-v1', 'gaia2-phase4-training-baseline-v2'].includes(baseline?.schemaVersion)
    && Array.isArray(baseline.locks) && Array.isArray(baseline.sourceFiles), 'missing training baseline')
  const locks = new Map()
  for (const item of baseline.locks) {
    check(!locks.has(item.key) && manifest.lockRefs[item.key]?.path === item.originalPath
      && manifest.lockRefs[item.key]?.sha256 === item.sha256 && sha(bytes(item.path)) === item.sha256, 'training lock binding')
    // The real five-lock baseline includes a multi-row JSONL scenario index,
    // not just the two JSON locks used by the earlier controlled fixture.
    // Every byte is still SHA-bound; parse each row without rewriting it.
    locks.set(item.key, item.key === 'scenarioIndex'
      ? bytes(item.path).toString('utf8').split(/\r?\n/).filter(line => line.trim()).map(JSON.parse)
      : json(item.path))
  }
  check(locks.size === Object.keys(manifest.lockRefs).length, 'missing training locks')
  const capabilities = locks.get('capabilities'), environment = locks.get('environment'), sources = new Map()
  for (const item of baseline.sourceFiles) {
    const id = `${item.scope}/${item.relativePath}`
    check(!sources.has(id) && sha(bytes(item.path)) === item.sha256, 'training source SHA changed')
    if (item.scope === 'project' || item.scope === 'backend') {
      const list = item.scope === 'project' ? environment.codeInputs : environment.backend.codeInputs
      check(list.some(ref => ref.path === item.relativePath && ref.sha256 === item.sha256), 'source outside frozen code inventory')
    } else {
      const plugin = capabilities.plugins.find(plugin => `plugin:${plugin.id}` === item.scope)
      check(plugin?.files.some(ref => ref.relativePath === item.relativePath && ref.sha256 === item.sha256), 'plugin outside frozen inventory')
    }
    sources.set(id, item)
  }
  const requiredSources = baseline.schemaVersion === 'gaia2-phase4-training-baseline-v2' ? DIAGNOSTIC_SOURCES : SOURCES
  for (const [scope, names] of Object.entries(requiredSources)) for (const name of names) check(sources.has(`${scope}/${name}`), 'missing training implementation source')
  if (baseline.schemaVersion === 'gaia2-phase4-training-baseline-v1') {
    // Historical v1 proofs remain readable. New diagnostics cannot downgrade
    // the sealed contract to omit their imported implementation.
    check(!environment.codeInputs.some(ref => ref.path === 'scripts/gaia2_model_diagnostics.py')
      && !bytes(sources.get('project/scripts/gaia2_model_retry.py').path).toString('utf8').includes('gaia2_model_diagnostics'), 'diagnostic_dependency_requires_baseline_v2')
  }
  for (const plugin of capabilities.plugins) for (const ref of plugin.files) check(sources.has(`plugin:${plugin.id}/${ref.relativePath}`), 'missing training plugin source')
  check(report.environmentAudit?.phase0Passed === true && report.finalEnvironmentAudit?.phase0Passed === true, 'training baseline audit failed')
  const input = refJson(report.trainingInput), spec = refJson(report.hostSpec), host = refJson(report.hostResult)
  const invocation = { checkpoint: 'after_evaluation', training: input }
  const expectedInput = { phase: 'training', evaluation: { evaluated: true, category: 'business_failure', passed: false },
    summary: parent.evidence.sealed.observableSummary,
    source: { executionId: parent.task.executionId, sessionId: parent.session.sessionId, attemptIndex: parent.task.attemptIndex },
    evidence: { runtimeAttestationHash: digest(parent.result.runtimeAttestation), resultHash: parent.resultHash, manifestHash: parent.manifest.manifestHash } }
  check(digest(input) === digest(expectedInput)
    && report.trainingInputHash === digest(input) && digest(spec.invocation) === digest(invocation), 'training input binding')
  check(digest(spec.options.contract) === digest(CORRECTION_CONTRACT) && spec.options.providerCleanupTimeoutMs === 30000
    && spec.options.scenarioId === parent.task.scenarioId && spec.options.executionId !== parent.task.executionId && spec.options.sessionId !== parent.session.sessionId
    && digest(Object.keys(spec.options).sort()) === digest(['projectDir', 'workspaceDir', 'plugins', 'executionId', 'sessionId', 'scenarioId', 'contract', 'providerCleanupTimeoutMs'].sort())
    && digest(spec.models) === digest(manifest.models) && digest(spec.options.plugins) === digest(capabilities.plugins.map(({ id, snapshotRoot, files }) => ({ id, snapshotRoot, files }))), 'training Host frozen configuration')
  check(host.schemaVersion === 'gaia2-phase4-training-host-result-v1' && host.status === 'passed' && host.result?.status === 'passed'
    && host.cleanupCompleted === true && host.manualInspectionRequired === false && host.failureCode === null, 'training Host not healthy')
  const init = host.initialization, result = host.result
  for (const field of ['executionId', 'sessionId', 'scenarioId']) check(init[field] === spec.options[field], 'training Host identity')
  check(init.schemaVersion === 'capybara-training-plugin-host-v1' && init.runtimeHooksExecuted === false && init.variablePatchesAllowed === false
    && init.contractHash === jsonHash(CORRECTION_CONTRACT) && result.contractHash === init.contractHash && result.inputHash === jsonHash(invocation), 'training Host input/contract hash')
  const evidencePath = value => {
    check(typeof value === 'string', 'missing Host evidence path')
    const normalized = portable(value), candidates = [...bound.keys()].filter(key => normalized === key || normalized.endsWith(`/${key}`))
    check(candidates.length === 1, 'Host evidence outside sealed bundle'); return candidates[0]
  }
  const { evidencePath: initializedPath, ...initValue } = init
  check(digest(json(evidencePath(initializedPath))) === digest(initValue), 'initialized evidence mismatch')
  const invoked = json(evidencePath(result.evidencePath)), { evidencePath: ignored, ...resultValue } = result
  check(invoked.schemaVersion === 'capybara-training-plugin-invocation-v1' && invoked.executionId === init.executionId
    && invoked.sessionId === init.sessionId && invoked.scenarioId === init.scenarioId && invoked.variablePatchesAllowed === false
    && invoked.runtimeHooksExecuted === false && digest(invoked.input) === digest(invocation), 'invoked evidence identity')
  for (const [key, value] of Object.entries(resultValue)) check(digest(invoked[key]) === digest(value), 'invoked result mismatch')
  check(init.plugins.length === capabilities.plugins.length, 'training plugin count')
  for (const plugin of capabilities.plugins) {
    const loaded = init.plugins.find(item => item.id === plugin.id)
    check(loaded && digest(loaded.files) === digest(plugin.files)
      && loaded.inventoryHash === jsonHash([...plugin.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))), 'training plugin identity')
  }
  check(result.proposals.length === 1 && result.artifacts.length === 1, 'training chain incomplete')
  const proposal = result.proposals[0], artifact = result.artifacts[0]
  check(proposal.hookId === 'gaia2-correction' && proposal.pluginId === 'gaia2-evaluation'
    && artifact.hookId === 'gaia2-attempt-record' && artifact.pluginId === 'gaia2-evaluation', 'training Hook identity')
  for (const [item, relativePath, declarations] of [[proposal, 'training-hooks/gaia2-correction.ts', init.trainingHooks],
    [artifact, 'hooks/gaia2-attempt-record.ts', init.artifactHooks]]) {
    check(sources.get(`plugin:${item.pluginId}/${relativePath}`)?.sha256 === item.sourceSha256
      && declarations.some(hook => hook.id === item.hookId && hook.pluginId === item.pluginId && hook.sourceSha256 === item.sourceSha256 && hook.checkpoint === 'after_evaluation')
      && result.hookReceipts.some(hook => hook.hookId === item.hookId && hook.pluginId === item.pluginId && hook.sourceSha256 === item.sourceSha256 && hook.status === 'passed' && hook.matched === true)
      && item.outputHash === jsonHash(item.output), 'training Hook receipt/source binding')
  }
  check(digest(artifact.output) === digest({ artifacts: [{ title: 'GAIA2 attempt status', value: { status: 'fail', attemptCountDelta: 0 } }],
    metadata: { answerBlind: true, artifactOnly: true, attemptCountDelta: 0 } }), 'training artifact contract')
  check(result.hookReceipts.length === 2 && result.hookReceipts.every(item => item.status === 'passed' && item.checkpoint === 'after_evaluation')
    && result.providerReceipts.length === 1 && host.operationalReceipts.length === 1, 'training Hook/provider count')
  const provider = result.providerReceipts[0], operational = host.operationalReceipts[0]
  check(provider.status === 'passed' && provider.hookId === proposal.hookId && provider.requestId === operational.requestId
    && provider.requestHash === operational.requestHash && operational.eventsReadable !== false && report.modelEventsReadable !== false
    && operational.processHealthy === true && healthyTrainingProcess(operational.process), 'provider receipt incomplete')
  const directory = portable(operational.directory), request = json(evidencePath(`${directory}/input.json`)), response = json(evidencePath(`${directory}/response.json`))
  check(jsonHash(request) === provider.requestHash && sha(response.output_text) === provider.outputTextHash, 'provider input/output SHA mismatch')
  const providerEvents = bytes(evidencePath(`${directory}/model-events.jsonl`)).toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
  const requestAttempts = providerEvents.filter(event => event.type === 'model_request_attempt').length
  const successfulCompletions = providerEvents.filter(event => event.type === 'model_request_succeeded').length
  check(digest(providerEvents) === digest(operational.events) && providerEvents.every(event => event.modelRole === 'correction')
    && successfulCompletions === 1 && requestAttempts >= 1
    && report.requestAttempts === requestAttempts && report.successfulCompletions === successfulCompletions
    && report.realModelCalls === successfulCompletions, 'missing real correction completion')
  check(digest(json(evidencePath(`${directory}/process/process-result.json`))) === digest(operational.process)
    && healthyTrainingProcess(refJson(report.hostProcess)), 'provider/Host process proof')
  const rawPlan = parseCorrectionPlan({ candidate: response.output_text, evidence: parent.evidence })
  check(digest(proposal.output) === digest({ correction: { ...rawPlan, freshReplayRequired: true, attemptCountDelta: 0 },
    metadata: { answerBlind: true, artifactOnly: true, attemptCountDelta: 0 } }), 'training proposal has unsafe output fields')
  check(proposal.output.correction.freshReplayRequired === true && proposal.output.correction.attemptCountDelta === 0, 'replay contract weakened')
  const { freshReplayRequired, attemptCountDelta, ...candidate } = proposal.output.correction
  const plan = parseCorrectionPlan({ candidate, evidence: parent.evidence }), strategy = renderTrustedCorrection(plan)
  check(digest(plan) === digest(rawPlan) && digest(report.strategy) === digest({ plan, ...strategy }), 'training strategy/source changed')
  return { report, reportRef: trainingReportRef, verifiedParent: parent, plan, strategy, trainingInput: input, spec, hostResult: host,
    evidenceRefs: [trainingReportRef, ...report.evidence] }
}
