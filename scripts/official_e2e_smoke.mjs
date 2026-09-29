import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const config = JSON.parse(readFileSync(join(root, 'gaia2-model-config.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(join(root, 'data', 'manifest.json'), 'utf8'))
const capability = process.env.GAIA2_E2E_CAPABILITY || 'execution'
const numRuns = Math.max(1, Number(process.env.GAIA2_E2E_NUM_RUNS || 1))
const source = manifest.files.find((file) => file.name === capability)
if (!source) throw new Error(`No downloaded GAIA2 source for capability ${capability}`)

const sourcePath = config.apiKeySource
const sourceLines = readFileSync(sourcePath, 'utf8').split(/\r?\n/)
const baseUrl = sourceLines.find((line) => /^base_url\s*:/i.test(line))?.replace(/^base_url\s*:\s*/i, '').trim()
const apiKey = sourceLines.find((line) => /^key\s*[:=]/i.test(line))?.replace(/^key\s*[:=]\s*/i, '').trim()
if (!baseUrl || !apiKey) throw new Error('llm-config.txt must provide base_url and key')

const officialPythonPath = process.env.GAIA2_OFFICIAL_PYTHON || join(root, '.official-python')
if (!existsSync(join(officialPythonPath, 'are'))) throw new Error(`Official ARE package is missing at ${officialPythonPath}`)
const python = process.env.GAIA2_PYTHON || 'python'

const parquetFile = await asyncBufferFromFile(source.path)
const [row] = await parquetReadObjects({ file: parquetFile, rowStart: 0, rowEnd: 1, compressors })
if (!row?.scenario_id || !row?.scenario) throw new Error(`Invalid ${capability} parquet row`)
const scenario = JSON.parse(row.scenario)
const minimal = process.env.GAIA2_E2E_MINIMAL !== '0'
if (minimal) {
  // Keep this smoke test small and deterministic while retaining the official
  // ARE scenario format, apps, environment and judge boundary.  Set
  // GAIA2_E2E_MINIMAL=0 to run the untouched first dataset row instead.
  const startTime = scenario.metadata?.definition?.start_time || 1728975600
  const scenarioId = `${row.scenario_id}_capybara_minimal`
  scenario.metadata.definition.scenario_id = scenarioId
  scenario.metadata.definition.duration = 120
  scenario.metadata.definition.tags = ['Execution']
  // MessagingAppV2 resolves recipients through the Contacts app at runtime.
  scenario.apps = scenario.apps.filter((app) => ['AgentUserInterface', 'Contacts', 'Messages'].includes(app.name))
  const userEventId = `Event-USER-capybara-${row.scenario_id}`
  scenario.events = [
    {
      class_name: 'Event',
      event_type: 'USER',
      event_time: startTime,
      event_id: userEventId,
      dependencies: [],
      event_relative_time: 0,
      action: {
        action_id: 'AgentUserInterface.send_message_to_agent-capybara-minimal',
        app: 'AgentUserInterface',
        function: 'send_message_to_agent',
        operation_type: 'READ',
        args: [
          { name: 'content', value: 'Send an individual message via Messages to phone number +3613812345678 with exactly this text: Hello from the GAIA2 smoke test.', value_type: 'str' },
          { name: 'attachments', value: '[]', value_type: 'list' },
        ],
      },
      metadata: null,
    },
    {
      class_name: 'OracleEvent',
      event_type: 'AGENT',
      event_time: startTime + 1,
      event_id: 'OracleEvent-AGENT-capybara-minimal',
      dependencies: [userEventId],
      event_relative_time: 1,
      action: {
        action_id: '',
        app: 'Messages',
        function: 'send_message',
        operation_type: null,
        args: [
          { name: 'user_id', value: '+3613812345678', value_type: 'str' },
          { name: 'content', value: 'Hello from the GAIA2 smoke test.', value_type: 'str' },
          { name: 'attachment_path', value: null, value_type: 'Optional[str]' },
        ],
      },
      metadata: null,
    },
  ]
}

const fixtureRoot = join(root, '.official-fixtures', minimal ? 'minimal' : 'dataset')
const fixtureDir = join(fixtureRoot, capability)
mkdirSync(fixtureDir, { recursive: true })
const fixtureScenarioId = scenario.metadata?.definition?.scenario_id || row.scenario_id
const fixturePath = join(fixtureDir, `${fixtureScenarioId}.json`)
writeFileSync(fixturePath, `${JSON.stringify(scenario, null, 2)}\n`)

const outputDir = join(root, 'official-results', 'capybara-e2e', capability)
mkdirSync(outputDir, { recursive: true })
const logPath = join(outputDir, 'runner.log')
const bridgeDir = join(root, 'scripts').replaceAll('\\\\', '/')
const runnerCode = "import sys, signal; signal.SIGALRM = getattr(signal, 'SIGALRM', signal.SIGTERM); signal.alarm = getattr(signal, 'alarm', lambda _seconds: 0); sys.path.insert(0, r'%s'); from capybara_official_bridge import install; install(); from are.simulation.benchmark import main; main()".replace('%s', bridgeDir)
const args = [
  '-c', runnerCode,
  'run',
  '--dataset', fixtureRoot,
  '--config', capability,
  '--agent', 'default',
  '--model', config.model,
  '--provider', 'local',
  '--endpoint', baseUrl,
  '--limit', '1',
  '--num_runs', String(numRuns),
  '--max_concurrent_scenarios', '1',
  '--scenario_timeout', process.env.GAIA2_E2E_TIMEOUT_SECONDS || '180',
  '--output_dir', outputDir,
  '--trace_dump_format', 'both',
  '--log-level', 'INFO',
]

const result = spawnSync(python, args, {
  cwd: root,
  encoding: 'utf8',
  env: {
    ...process.env,
    PYTHONPATH: officialPythonPath,
    PYTHONUTF8: '1',
    REQUEST_TIMEOUT: process.env.GAIA2_E2E_LLM_TIMEOUT_SECONDS || '60',
    OPENAI_API_KEY: apiKey,
    GAIA2_E2E_MAX_ACTIONS: process.env.GAIA2_E2E_MAX_ACTIONS || (minimal ? '1' : '24'),
    GAIA2_E2E_TOOL_ALLOWLIST: process.env.GAIA2_E2E_TOOL_ALLOWLIST || (minimal
      ? 'Messages__send_message,AgentUserInterface__send_message_to_user'
      : ''),
  },
  timeout: Number(process.env.GAIA2_E2E_PROCESS_TIMEOUT_MS || 240000),
  maxBuffer: 32 * 1024 * 1024,
})
const stdout = result.stdout || ''
const stderr = result.stderr || ''
writeFileSync(logPath, `${stdout}\n${stderr}`)

const combined = `${stdout}\n${stderr}`
const successMatches = [...combined.matchAll(/Success[^\n]*/gi)].slice(-5).map((match) => match[0].trim().slice(0, 240))
const successfulConfig = /Successful configs:\s*1/i.test(combined)
const loadedScenario = /Successfully loaded scenario/i.test(combined)
let benchmarkStats = null
const statsPath = join(outputDir, 'benchmark_stats.json')
if (existsSync(statsPath)) {
  try { benchmarkStats = JSON.parse(readFileSync(statsPath, 'utf8')) } catch { benchmarkStats = null }
}
const score = typeof benchmarkStats?.statistics?.global?.macro_success_rate === 'number'
  ? benchmarkStats.statistics.global.macro_success_rate
  : typeof benchmarkStats?.global_summary?.macro_success_rate === 'number'
    ? benchmarkStats.global_summary.macro_success_rate
    : typeof benchmarkStats?.macro_success_rate === 'number' ? benchmarkStats.macro_success_rate : null
const validationPassed = score === null ? /Success rate:\s*100\.0%/i.test(combined) : score > 0
const outputFiles = []
const outputListing = spawnSync(process.platform === 'win32' ? 'cmd' : 'find', process.platform === 'win32'
  ? ['/c', 'dir', '/b', '/s', outputDir]
  : [outputDir], { encoding: 'utf8' })
if (outputListing.status === 0) {
  for (const line of (outputListing.stdout || '').split(/\r?\n/).filter(Boolean)) {
    if (/\.(json|jsonl|parquet|yaml|yml|log)$/i.test(line)) outputFiles.push(line)
  }
}
const report = {
  status: result.error ? 'process_error' : result.status === 0 && successfulConfig && loadedScenario && validationPassed ? 'passed' : 'failed',
  mode: 'official-are-local-fixture-e2e',
  officialPackage: 'meta-agents-research-environments==1.2.0',
  capability,
  scenarioId: fixtureScenarioId,
  sourceScenarioId: row.scenario_id,
  minimal,
  model: config.model,
  provider: 'local',
  baseUrl,
  runs: numRuns,
  exitCode: result.status,
  signal: result.signal,
  error: result.error?.message,
  outputFiles,
  logPath,
  successLines: successMatches,
  loadedScenario,
  successfulConfig,
  score,
  validationPassed,
  note: 'Runs the official ARE local scenario loader, environment, default GAIA2 agent, model endpoint, tool execution and judge boundary for one scenario. The Capybara Node workspace orchestrates this boundary; it does not alter official scoring.',
  generatedAt: new Date().toISOString(),
}
const reportPath = join(root, 'reports', 'gaia2-official-e2e-smoke.json')
mkdirSync(dirname(reportPath), { recursive: true })
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (report.status !== 'passed') process.exitCode = 2
