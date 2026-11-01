import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildFullLibraryLaunch, fullLibraryEvidenceIdentity, fullLibraryProfileOptions, fullLibraryTaskOutcome, judgeEvidenceFromEvents, verifyFullLibraryA2AEvidence } from '../scripts/full_library_task.mjs'

function fixture(phase = 'standard') {
  const root = resolve('test-full-library-pure')
  const task = { phase, config: phase === 'standard' ? 'ambiguity' : 'mini', scenarioId: 'original-1', executionId: 'once-1',
    runNumber: 1, attemptIndex: 0, correctionOrdinal: 0 }
  const manifest = { mode: 'full_library_once', dataset: { kind: 'submission', split: 'validation' },
    executionBinding: 'phase3_live_plugin_host_required', syntheticFixtureOnly: false, officialSubmissionReady: false, correctionEnabled: false,
    temporal: { enabled: true }, conflictRecovery: { enabled: true }, entitySemantics: { enabled: true }, mutationReceipts: { enabled: true }, retrieval: { enabled: true, profile: 'standard-search' },
    models: { actor: { model: 'gpt-6-luna', provider: 'local' }, judge: { model: 'gpt-6-luna', provider: 'local' } },
    settings: { minimal: false, concurrency: 1, maxActions: 300, processTimeoutMs: 480000000,
      scenarioTimeoutSeconds: 480000, modelRequestTimeoutSeconds: 60, heartbeatIntervalMs: 1000,
      modelRetry: { maxAttempts: 6, backoffBaseSeconds: 2, backoffMaxSeconds: 120, maxRetryWaitSeconds: 3600 } } }
  return { root, task, manifest, protocol: { runtime: { python: 'python/python.exe', officialPythonPath: '.official-python' } },
    session: { sessionId: 'session-1', fixtureDir: 'runs/once/task-0001/fixture', workspaceDir: 'runs/once/task-0001/workspace', outputDir: 'runs/once/task-0001/output' },
    connection: { baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'controlled-test-key' },
    entry: { path: 'controlled-entry.json', sha256: 'e'.repeat(64) },
    service: { endpoint: 'http://127.0.0.1:4444/invoke', token: 'controlled-host-token', ready: { a2a: {
      host: '127.0.0.1', port: 2345, channelId: 'a'.repeat(64), bindingHash: 'b'.repeat(64) } } }, env: {} }
}

test('Standard enables the latest four runtime capabilities; enhanced profiles enable none', () => {
  assert.deepEqual(fullLibraryProfileOptions(fixture()), { temporal: { enabled: true }, conflictRecovery: { enabled: true },
    entitySemantics: { enabled: true }, mutationReceipts: { enabled: true } })
  for (const phase of ['agent2agent', 'noise']) assert.deepEqual(fullLibraryProfileOptions(fixture(phase)), {})
})

test('Search standard profile enables the bounded retrieval controller only', () => {
  const f = fixture()
  f.task.config = 'search'
  assert.deepEqual(fullLibraryProfileOptions(f), { temporal: { enabled: true }, conflictRecovery: { enabled: true },
    entitySemantics: { enabled: true }, mutationReceipts: { enabled: true }, retrieval: { enabled: true, profile: 'standard-search' } })
  assert.equal(buildFullLibraryLaunch(f).env.GAIA2_RETRIEVAL_ENABLED, '1')
  assert.equal(buildFullLibraryLaunch(fixture()).env.GAIA2_RETRIEVAL_ENABLED, '0')
})

test('phase envelope rejects source/test, retired profiles, corrections, reruns, minimal and wrong configs', () => {
  const mutations = [f => { f.manifest.mode = 'official_submission' }, f => { f.manifest.dataset.kind = 'source' },
    f => { f.manifest.dataset.split = 'test' }, f => { f.manifest.taskContract = { enabled: true } },
    f => { f.task.runNumber = 2 }, f => { f.task.attemptIndex = 1 }, f => { f.task.correctionOrdinal = 1 },
    f => { f.task.correctionContext = {} }, f => { f.manifest.correctionContext = {} },
    f => { f.manifest.settings.minimal = true }, f => { f.manifest.settings.concurrency = 2 },
    f => { f.task.config = 'mini' }, f => { f.task.phase = 'other' }, f => { f.manifest.entitySemantics.enabled = false }]
  for (const mutate of mutations) { const f = fixture(); mutate(f); assert.throws(() => fullLibraryProfileOptions(f)) }
  for (const phase of ['agent2agent', 'noise']) { const f = fixture(phase); f.task.config = 'time'; assert.throws(() => fullLibraryProfileOptions(f)) }
})

test('all phases launch the original official entry exactly once with the frozen actor/judge configuration', () => {
  for (const phase of ['standard', 'agent2agent', 'noise']) {
    const f = fixture(phase), value = buildFullLibraryLaunch(f)
    assert.equal(value.command, resolve(f.root, f.protocol.runtime.python))
    assert.equal(value.args[0], resolve(f.root, 'scripts/temporal_official_entry.py'))
    for (const name of ['--limit', '--num_runs', '--max_concurrent_scenarios']) assert.equal(value.args[value.args.indexOf(name) + 1], '1')
    for (const name of ['--model', '--judge_model']) assert.equal(value.args[value.args.indexOf(name) + 1], 'gpt-6-luna')
    for (const name of ['--provider', '--judge_provider']) assert.equal(value.args[value.args.indexOf(name) + 1], 'openai')
    assert.equal(value.env.GAIA2_E2E_ATTEMPT_INDEX, '0'); assert.equal(value.env.GAIA2_E2E_CORRECTION_ORDINAL, '0')
    assert.equal(value.env.GAIA2_TASK_RECONCILIATION_ENABLED, '1')
    assert.equal(value.env.GAIA2_TOOL_ROUND_WORKSPACE, value.cwd)
    assert.equal(value.env.GAIA2_MODEL_HTTP_GUARD_REQUIRED, '1')
    assert.equal(value.env.GAIA2_RETRIEVAL_ENABLED, '0')
    assert.equal(value.env.GAIA2_EXECUTION_ID, f.task.executionId)
    assert.equal(value.env.GAIA2_SESSION_ID, f.session.sessionId)
  }
})

test('Standard launch has no enhanced arguments or private A2A environment', () => {
  const value = buildFullLibraryLaunch(fixture())
  assert.equal(value.args.includes('--noise'), false)
  assert.equal(value.args.some(arg => arg.startsWith('--a2a_')), false)
  assert.equal(Object.keys(value.env).some(key => key.startsWith('GAIA2_A2A_')), false)
  for (const name of ['TEMPORAL', 'CONFLICT_RECOVERY', 'ENTITY_SEMANTICS', 'MUTATION_RECEIPTS']) assert.equal(value.env[`GAIA2_${name}_ENABLED`], '1')
})

test('trusted window source is passed only through the internal bridge environment', () => {
  const f = fixture()
  const source = { schemaVersion: 'gaia2-window-obligation-source-v1', enabled: true, executionId: f.task.executionId,
    sessionId: f.session.sessionId, userRef: 'u-1', sourceHash: 'a'.repeat(64), span: { start: 0, end: 1, text: 'x' },
    sceneStart: 0, parserReceiptHash: 'b'.repeat(64), obligations: [{ id: 'w-1', mode: 'monitor_until', goal: 'wait', deadline: 60, notificationPolicy: 'allow' }] }
  const value = buildFullLibraryLaunch({ ...f, windowObligationSource: source })
  assert.deepEqual(JSON.parse(value.env.GAIA2_WINDOW_OBLIGATION_SOURCE_JSON), source)
  const pipeline = buildFullLibraryLaunch({ ...f, windowPipelineEnabled: true })
  assert.equal(pipeline.env.GAIA2_WINDOW_PIPELINE_ENABLED, '1')
  assert.equal(pipeline.env.GAIA2_WINDOW_EVIDENCE_DIR, resolve(f.root, f.session.workspaceDir, 'window-registration-evidence'))
})

test('A2A uses official augmentation flags and the verified private pipe only', () => {
  const f = fixture('agent2agent'), value = buildFullLibraryLaunch(f)
  for (const [key, expected] of [['--a2a_app_prop', '1.0'], ['--a2a_app_agent', 'default_app_agent'],
    ['--a2a_model', 'gpt-6-luna'], ['--a2a_model_provider', 'openai'], ['--a2a_endpoint', f.connection.baseUrl]]) assert.equal(value.args[value.args.indexOf(key) + 1], expected)
  assert.equal(value.args.includes('--noise'), false)
  assert.equal(value.env.GAIA2_A2A_PIPE_HOST, '127.0.0.1')
  assert.equal(value.env.GAIA2_A2A_PIPE_PORT, '2345')
  assert.equal(value.env.GAIA2_A2A_PIPE_CHANNEL, 'a'.repeat(64))
  f.service.ready.a2a.host = 'remote.example'; assert.throws(() => buildFullLibraryLaunch(f))
})

test('Noise uses official noise augmentation without A2A', () => {
  const value = buildFullLibraryLaunch(fixture('noise'))
  assert.equal(value.args.filter(arg => arg === '--noise').length, 1)
  assert.equal(value.args.some(arg => arg.startsWith('--a2a_')), false)
  assert.equal(Object.keys(value.env).some(key => key.startsWith('GAIA2_A2A_')), false)
})

test('inherited capabilities, diagnostics, credential and Python overrides cannot leak into a run', () => {
  for (const phase of ['standard', 'agent2agent', 'noise']) {
    const f = fixture(phase)
    f.env = { PATH: 'controlled-path', GAIA2_TEMPORAL_ENABLED: '1', GAIA2_ENTITY_SEMANTICS_ENABLED: '1',
      GAIA2_MUTATION_RECEIPTS_ENABLED: '1', GAIA2_TASK_CONTRACT_ENABLED: '1', GAIA2_RETRIEVAL_ENABLED: '1',
      GAIA2_A2A_PIPE_HOST: 'foreign', GAIA2_TOOL_SCHEMA_DIAGNOSTIC: '1', GAIA2_E2E_TOOL_ALLOWLIST: 'restricted',
      GAIA2_MODEL_MAX_ATTEMPTS: '99', PYTHONPATH: 'foreign', PYTHONHOME: 'foreign', OPENAI_API_KEY: 'foreign',
      OTHER_ACCESS_TOKEN: 'foreign', NODE_OPTIONS: 'foreign' }
    const value = buildFullLibraryLaunch(f)
    assert.equal(value.env.PATH, 'controlled-path')
    assert.equal(value.env.OPENAI_API_KEY, f.connection.apiKey)
    assert.equal(value.env.PYTHONPATH, resolve(f.root, '.official-python'))
    assert.equal(value.env.GAIA2_E2E_TOOL_ALLOWLIST, '')
    assert.equal(value.env.GAIA2_MODEL_MAX_ATTEMPTS, '6')
    for (const name of ['GAIA2_TASK_CONTRACT_ENABLED', 'GAIA2_TOOL_SCHEMA_DIAGNOSTIC', 'PYTHONHOME', 'OTHER_ACCESS_TOKEN', 'NODE_OPTIONS']) assert.equal(Object.hasOwn(value.env, name), false)
    assert.equal(value.env.GAIA2_RETRIEVAL_ENABLED, '0')
    if (phase !== 'standard') for (const name of ['TEMPORAL', 'CONFLICT_RECOVERY', 'ENTITY_SEMANTICS', 'MUTATION_RECEIPTS']) assert.equal(Object.hasOwn(value.env, `GAIA2_${name}_ENABLED`), false)
  }
})

test('null/incomplete and technical diagnostic zero never masquerade as scored business failure', () => {
  const clean = { exitCode: 0, childExited: true, childClosed: true }
  for (const score of [0, 1]) {
    const result = fullLibraryTaskOutcome({ actor: clean, host: clean, native: { report: { evaluationComplete: true, score } } })
    assert.equal(result.rawScore, score); assert.equal(result.evaluationComplete, true); assert.equal(result.status, 'evaluated')
  }
  const incomplete = fullLibraryTaskOutcome({ actor: clean, host: clean, native: { report: { evaluationComplete: false, score: null } } })
  assert.equal(incomplete.rawScore, null); assert.equal(incomplete.evaluationComplete, false); assert.equal(incomplete.status, 'technical_error')
  const technical = fullLibraryTaskOutcome({ actor: clean, host: clean, receiptError: 'receipt_invalid', native: { report: { evaluationComplete: true, score: 0 } } })
  assert.equal(technical.rawScore, 0); assert.equal(technical.evaluationComplete, false); assert.equal(technical.status, 'technical_error')
})

test('official score keeps independent judge reliability and legacy rows remain unknown', () => {
  const clean = { exitCode: 0, childExited: true, childClosed: true }
  const legacy = fullLibraryTaskOutcome({ actor: clean, host: clean,
    native: { report: { evaluationComplete: true, score: 0 } } })
  assert.equal(legacy.scoreReliability, 'unknown')
  assert.equal(legacy.judgeProtocolAffected, null)
  const affected = fullLibraryTaskOutcome({ actor: clean, host: clean,
    native: { report: { evaluationComplete: true, score: 0, judgeEvidence: {
      checkerPath: 'validation/utils/llm_utils.py:133', parseStatus: 'unparsed',
      rawResponse: '[[True]]', checkerResponse: '[[true]]',
      transform: { caseFoldBooleanMarkers: true },
    } } } })
  assert.equal(affected.scoreReliability, 'protocol_affected')
  assert.equal(affected.judgeProtocolAffected, true)
})

test('redacted Judge observations aggregate into reliable or protocol-affected provenance without raw text', () => {
  const base = { type: 'judge_response_observed', modelRole: 'judge', requestId: 'a'.repeat(32), requestAttempt: 1,
    rawResponseHash: 'b'.repeat(64), checkerResponseHash: 'c'.repeat(64), parseStatus: 'parsed',
    checkerPath: 'are/simulation/validation/utils/llm_utils.py', markerConflict: false,
    rawMarkers: { upper: { true: false, false: false }, lower: { true: false, false: false } },
    checkerMarkers: { upper: { true: false, false: false }, lower: { true: false, false: false } } }
  const evidence = judgeEvidenceFromEvents([base])
  assert.equal(evidence.parseStatus, 'parsed')
  assert.equal(evidence.markerConflict, false)
  const clean = { exitCode: 0, childExited: true, childClosed: true }
  assert.equal(fullLibraryTaskOutcome({ actor: clean, host: clean, judgeEvidence: evidence,
    native: { report: { evaluationComplete: true, score: 1 } } }).scoreReliability, 'reliable')
  const affected = judgeEvidenceFromEvents([{ ...base, parseStatus: 'unparsed', markerConflict: true,
    rawMarkers: { upper: { true: true, false: false }, lower: { true: false, false: false } },
    checkerMarkers: { upper: { true: false, false: false }, lower: { true: true, false: false } } }])
  assert.equal(fullLibraryTaskOutcome({ actor: clean, host: clean, judgeEvidence: affected,
    native: { report: { evaluationComplete: true, score: 0 } } }).scoreReliability, 'protocol_affected')
})

test('Boolean marker normalization clears only the evidenced case conflict', () => {
  const base = { type: 'judge_response_observed', modelRole: 'judge', requestId: 'a'.repeat(32), requestAttempt: 1,
    rawResponseHash: 'b'.repeat(64), checkerResponseHash: 'c'.repeat(64), parseStatus: 'unparsed',
    checkerPath: 'are/simulation/validation/utils/llm_utils.py', markerConflict: true,
    rawMarkers: { upper: { true: true, false: false }, lower: { true: false, false: false } },
    checkerMarkers: { upper: { true: false, false: false }, lower: { true: true, false: false } } }
  const normalized = judgeEvidenceFromEvents([base, {
    type: 'judge_protocol_normalized', modelRole: 'judge', checkerPath: base.checkerPath,
    rawResponseHash: base.checkerResponseHash, normalizedResponseHash: 'd'.repeat(64),
    caseFoldBooleanMarkers: true, normalization: 'boolean_marker_casefold_v1',
  }])
  assert.equal(normalized.markerConflict, false)
  assert.equal(normalized.rawMarkerConflict, true)
  assert.equal(normalized.parseStatus, 'parsed')
  assert.equal(normalized.protocolNormalization.applied, true)
  const clean = { exitCode: 0, childExited: true, childClosed: true }
  assert.equal(fullLibraryTaskOutcome({ actor: clean, host: clean, judgeEvidence: normalized,
    native: { report: { evaluationComplete: true, score: 0 } } }).scoreReliability, 'reliable')
})

test('Boolean marker evidence treats False case folding symmetrically', () => {
  const base = { type: 'judge_response_observed', modelRole: 'judge', requestId: 'e'.repeat(32), requestAttempt: 1,
    rawResponseHash: 'f'.repeat(64), checkerResponseHash: '1'.repeat(64), parseStatus: 'unparsed',
    checkerPath: 'are/simulation/validation/utils/llm_utils.py', markerConflict: true,
    rawMarkers: { upper: { true: false, false: true }, lower: { true: false, false: false } },
    checkerMarkers: { upper: { true: false, false: false }, lower: { true: false, false: true } } }
  const affected = judgeEvidenceFromEvents([base])
  assert.equal(affected.markerConflict, true)
  const clean = { exitCode: 0, childExited: true, childClosed: true }
  assert.equal(fullLibraryTaskOutcome({ actor: clean, host: clean, judgeEvidence: affected,
    native: { report: { evaluationComplete: true, score: 0 } } }).scoreReliability, 'protocol_affected')

  const normalized = judgeEvidenceFromEvents([base, {
    type: 'judge_protocol_normalized', modelRole: 'judge', checkerPath: base.checkerPath,
    rawResponseHash: base.checkerResponseHash, normalizedResponseHash: '2'.repeat(64),
    caseFoldBooleanMarkers: true, normalization: 'boolean_marker_casefold_v1',
  }])
  assert.equal(normalized.markerConflict, false)
  assert.equal(normalized.rawMarkerConflict, true)
  assert.equal(normalized.parseStatus, 'parsed')
  assert.equal(fullLibraryTaskOutcome({ actor: clean, host: clean, judgeEvidence: normalized,
    native: { report: { evaluationComplete: true, score: 0 } } }).scoreReliability, 'reliable')
})

test('independent HTTP identity retains the original zero-based attempt and all immutable task fields', () => {
  const f = fixture()
  Object.assign(f.manifest, { runId: 'once', manifestHash: 'f'.repeat(64) })
  Object.assign(f.task, { scenarioVersion: 'are_simulation_v1', scenarioHash: 'e'.repeat(64) })
  assert.deepEqual(fullLibraryEvidenceIdentity(f), { runId: 'once', manifestHash: 'f'.repeat(64),
    executionId: 'once-1', sessionId: 'session-1', scenarioId: 'original-1', runNumber: 1,
    phase: 'standard', config: 'ambiguity', scenarioVersion: 'are_simulation_v1', scenarioHash: 'e'.repeat(64),
    attemptIndex: 0, correctionOrdinal: 0 })
})

test('independent A2A verifier accepts a real empty pool without inventing child evidence and requires A2A phase', () => {
  const f = fixture('agent2agent')
  f.events = [{ type: 'a2a_client_pool_snapshot', executionId: f.task.executionId, sessionId: f.session.sessionId, clients: [] }]
  const result = verifyFullLibraryA2AEvidence(f)
  assert.equal(result.status, 'verified')
  assert.deepEqual(result.summary, { consumedEvidencePaths: [], childCount: 0, modelRequestCount: 0, nativeReturnCount: 0 })
  assert.deepEqual(result.consumedRefs, [])
  assert.throws(() => verifyFullLibraryA2AEvidence({ ...f, task: { ...f.task, phase: 'standard' } }))
})

test('executor calls the standalone current A2A and HTTP verifiers without legacy business validation', () => {
  const source = readFileSync(new URL('../scripts/full_library_task.mjs', import.meta.url), 'utf8')
  assert.match(source, /verifyOfficialA2ARuntimeEvidence\(\{ events,/)
  assert.match(source, /deadlineRequestTimeoutMs: Math\.max\(1, Math\.min\(2147483647, Math\.trunc\(manifest\.settings\.scenarioTimeoutSeconds \* 1000\)\)\)/)
  assert.match(source, /readFileSync\(evidenceFile\(root, path, session\.workspaceDir\)\)/)
  assert.match(source, /verifyModelHttpDispatchEvidence\(\{ journalBytes: bytes\.journal, events,/)
  assert.match(source, /verifyPhase6NativeProcessIdentity\(\{ nativeProcess,/)
  assert.match(source, /officialEntryBytes: bytes\.entry, pythonProcessId: nativeProcess\.pid/)
  assert.match(source, /modelHttpEvidence, a2aRuntimeEvidence/)
  assert.doesNotMatch(source, /collectRuntimeEvidence|informationNoiseTransitionErrors/)
})
