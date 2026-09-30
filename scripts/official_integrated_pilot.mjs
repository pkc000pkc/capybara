import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { Pass5Orchestrator } from '../src/pass5_orchestrator.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'data', 'manifest.json'), 'utf8'))
const config = JSON.parse(readFileSync(join(root, 'gaia2-model-config.json'), 'utf8'))
const capabilities = (process.env.GAIA2_PILOT_CAPABILITIES || 'execution,search,adaptability,time,ambiguity')
  .split(',').map((item) => item.trim()).filter(Boolean)
const scenarioIndex = Math.max(0, Number(process.env.GAIA2_PILOT_SCENARIO_INDEX || 0))
const rootSeed = Number(process.env.GAIA2_PILOT_ROOT_SEED || 20260930)
const timeoutMs = Number(process.env.GAIA2_PILOT_PROCESS_TIMEOUT_MS || 480000)
const officialPython = process.env.GAIA2_OFFICIAL_PYTHON || join(root, '.official-python')
const apiKeySource = readFileSync(config.apiKeySource, 'utf8').split(/\r?\n/)
const baseUrl = apiKeySource.find((line) => /^base_url\s*:/i.test(line))?.replace(/^base_url\s*:\s*/i, '').trim()
const apiKey = apiKeySource.find((line) => /^key\s*[:=]/i.test(line))?.replace(/^key\s*[:=]\s*/i, '').trim()
if (!baseUrl || !apiKey) throw new Error('llm-config.txt must provide base_url and key')

async function loadScenario(capability) {
  const source = manifest.files.find((file) => file.name === capability)
  if (!source) throw new Error(`No downloaded GAIA2 source for capability ${capability}`)
  const parquetFile = await asyncBufferFromFile(source.path)
  const [row] = await parquetReadObjects({ file: parquetFile, rowStart: scenarioIndex, rowEnd: scenarioIndex + 1, compressors })
  if (!row?.scenario_id || !row?.scenario) throw new Error(`Invalid ${capability} parquet row at index ${scenarioIndex}`)
  return { row, scenario: JSON.parse(row.scenario) }
}

function toEventPlan(scenario) {
  const events = Array.isArray(scenario.events) ? scenario.events : []
  const times = events.map((event) => Number(event.event_time ?? 0)).filter(Number.isFinite)
  const base = times.length ? Math.min(...times) : 0
  return events.map((event) => ({
    id: event.event_id,
    type: event.event_type,
    scheduledAt: Math.max(0, Number(event.event_time ?? base) - base),
    dependencies: event.dependencies ?? [],
    source: 'official-scenario',
    // Oracle action arguments are deliberately omitted from the Capybara sidecar.
    payload: String(event.event_type).toUpperCase() === 'AGENT' ? null : {
      app: event.action?.app ?? null,
      function: event.action?.function ?? null,
      argumentNames: (event.action?.args ?? []).map((argument) => argument.name),
    },
  }))
}

function parseReport(stdout, outputDir) {
  const globalPath = join(root, 'reports', 'gaia2-official-e2e-smoke.json')
  if (existsSync(globalPath)) {
    try { return JSON.parse(readFileSync(globalPath, 'utf8')) } catch { /* fall through */ }
  }
  const jsonLines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('{'))
  for (let index = jsonLines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(jsonLines[index]) } catch { /* keep searching */ }
  }
  return { status: 'failed', outputDir }
}

function ingestHookEvents(attempt, eventPath) {
  if (!existsSync(eventPath)) return []
  const records = readFileSync(eventPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line) } catch { return { type: 'malformed_hook_event' } }
  })
  for (const record of records) {
    attempt.recordHookEvent({
      type: record.type,
      subject: record.function ?? record.type,
      kind: record.type === 'tool_call_started' || record.type === 'tool_call_completed' ? 'tool' : 'runtime',
      content: {
        turn: record.turn ?? null,
        callId: record.callId ?? null,
        toolCallCount: record.toolCallCount ?? null,
        ok: record.ok ?? null,
        argumentKeys: record.argumentKeys ?? [],
      },
      source: 'official-are-bridge',
    })
  }
  return records
}

function runOfficialOnce({ capability, attemptIndex, correctionOrdinal, outputDir }) {
  const eventPath = join(outputDir, 'capybara-runtime-events.jsonl')
  mkdirSync(outputDir, { recursive: true })
  const fixtureRoot = join(root, '.official-fixtures', 'integrated-pilot')
  const child = spawnSync(process.execPath, [join(root, 'scripts', 'official_e2e_smoke.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GAIA2_E2E_CAPABILITY: capability,
      GAIA2_E2E_NUM_RUNS: '1',
      GAIA2_E2E_MINIMAL: '0',
      GAIA2_E2E_SCENARIO_INDEX: String(scenarioIndex),
      GAIA2_E2E_FIXTURE_ROOT: fixtureRoot,
      GAIA2_E2E_OUTPUT_DIR: outputDir,
      GAIA2_E2E_ATTEMPT_INDEX: String(attemptIndex),
      GAIA2_E2E_CORRECTION_ORDINAL: String(correctionOrdinal),
      GAIA2_RUNTIME_EVENT_FILE: eventPath,
      GAIA2_E2E_MAX_ACTIONS: process.env.GAIA2_E2E_MAX_ACTIONS || '32',
      GAIA2_E2E_PROCESS_TIMEOUT_MS: String(timeoutMs),
      GAIA2_OFFICIAL_PYTHON: officialPython,
    },
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  })
  const stdout = child.stdout || ''
  const stderr = child.stderr || ''
  writeFileSync(join(outputDir, 'process.stdout.log'), `${stdout}\n${stderr}`)
  const report = parseReport(stdout, outputDir)
  const records = ingestHookEventsForReport(eventPath)
  const passed = child.status === 0 && report.status === 'passed' && report.validationPassed === true
  const infrastructureError = Boolean(child.error) || child.signal !== null || child.status === null
  return {
    passed,
    infrastructureError,
    failureReason: passed ? null : (child.error?.message || report.error || `official ARE status=${report.status}`),
    observableErrors: passed ? [] : [{ source: 'official-are', status: report.status, exitCode: child.status }],
    trace: records.map((record) => ({ type: record.type, function: record.function ?? null, ok: record.ok ?? null })),
    official: {
      status: report.status,
      score: report.score ?? null,
      scenarioId: report.scenarioId ?? null,
      sourceScenarioId: report.sourceScenarioId ?? null,
      outputDir,
      eventPath,
    },
  }
}

function ingestHookEventsForReport(eventPath) {
  if (!existsSync(eventPath)) return []
  return readFileSync(eventPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line) } catch { return { type: 'malformed_hook_event' } }
  })
}

const results = []
for (const capability of capabilities) {
  const { row, scenario } = await loadScenario(capability)
  const scenarioId = row.scenario_id
  const capabilityRoot = join(root, 'official-results', 'integrated-pilot', capability)
  const orchestrator = new Pass5Orchestrator({
    rootSeed,
    attempts: 5,
    noiseProfile: 'off',
    maxCorrections: Number(process.env.GAIA2_PILOT_MAX_CORRECTIONS || 0),
    correction: async ({ failureReason }) => ({ type: 'answer-blind-replan', reason: failureReason }),
    verifier: async ({ execution }) => ({
      status: 'evaluated',
      passed: execution.passed === true,
    }),
  })
  const aggregate = await orchestrator.runScenario({
    scenarioId,
    capability,
    eventPlan: toEventPlan(scenario),
    plan: { steps: [] },
    runAttempt: async ({ attempt, attemptIndex, mode }) => {
      const suffix = mode === 'correction' ? `${attemptIndex}-correction` : String(attemptIndex)
      const execution = runOfficialOnce({
        capability,
        attemptIndex,
        correctionOrdinal: mode === 'correction' ? 1 : 0,
        outputDir: join(capabilityRoot, suffix),
      })
      const eventRecords = ingestHookEventsForReport(execution.official.eventPath)
      for (const record of eventRecords) {
        // The runtime object is the authoritative Capybara hook ledger for this
        // attempt; the official process contributes only evaluator-blind events.
        attempt.recordHookEvent({
          type: record.type,
          subject: record.function ?? record.type,
          kind: record.type.startsWith('tool_call') ? 'tool' : 'runtime',
          content: { turn: record.turn ?? null, ok: record.ok ?? null, argumentKeys: record.argumentKeys ?? [] },
          source: 'official-are-bridge',
        })
      }
      return execution
    },
  })
  results.push({ capability, sourceScenarioId: scenarioId, aggregate })
}

const report = {
  schemaVersion: 'gaia2-integrated-pilot-v1',
  status: results.every((result) => result.aggregate.taskPassAt5) ? 'passed' : 'failed',
  mode: 'official-are-original-scenario-capybara-pass5',
  scenarioIndex,
  attemptsPerCapability: 5,
  capabilities: results,
  model: config.model,
  datasetRevision: manifest.revision,
  officialPython,
  generatedAt: new Date().toISOString(),
}
const reportPath = join(root, 'reports', 'gaia2-integrated-pilot.json')
mkdirSync(dirname(reportPath), { recursive: true })
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (report.status !== 'passed') process.exitCode = 2
