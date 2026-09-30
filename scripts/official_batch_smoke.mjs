import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const capabilities = (process.env.GAIA2_BATCH_CAPABILITIES || 'execution,search,adaptability,time,ambiguity')
  .split(',').map((item) => item.trim()).filter(Boolean)
const indices = (process.env.GAIA2_BATCH_INDICES || '0,1')
  .split(',').map((item) => Math.max(0, Number(item.trim()))).filter(Number.isInteger)
const timeoutMs = Number(process.env.GAIA2_BATCH_PROCESS_TIMEOUT_MS || 180000)
const outputRoot = join(root, 'official-results', 'batch-10')

function reportFromChild(stdout, outputDir) {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    if (!line.trim().startsWith('{')) continue
    try { return JSON.parse(line) } catch { /* keep scanning */ }
  }
  const statsPath = join(outputDir, 'benchmark_stats.json')
  if (existsSync(statsPath)) {
    try {
      const stats = JSON.parse(readFileSync(statsPath, 'utf8'))
      const score = stats.statistics?.global?.macro_success_rate ?? null
      return { status: score !== null && score > 0 ? 'passed' : 'failed', score }
    } catch { /* use fallback */ }
  }
  return { status: 'failed', error: 'missing child report', outputDir }
}

const results = []
for (const capability of capabilities) {
  for (const scenarioIndex of indices) {
    const outputDir = join(outputRoot, capability, String(scenarioIndex))
    const eventPath = join(outputDir, 'capybara-runtime-events.jsonl')
    mkdirSync(outputDir, { recursive: true })
    const child = spawnSync(process.execPath, [join(root, 'scripts', 'official_e2e_smoke.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GAIA2_E2E_CAPABILITY: capability,
        GAIA2_E2E_MINIMAL: '0',
        GAIA2_E2E_SCENARIO_INDEX: String(scenarioIndex),
        GAIA2_E2E_NUM_RUNS: '1',
        GAIA2_E2E_OUTPUT_DIR: outputDir,
        GAIA2_E2E_FIXTURE_ROOT: join(root, '.official-fixtures', 'batch-10'),
        GAIA2_E2E_ATTEMPT_INDEX: '1',
        GAIA2_RUNTIME_EVENT_FILE: eventPath,
        GAIA2_E2E_MAX_ACTIONS: process.env.GAIA2_E2E_MAX_ACTIONS || '20',
        GAIA2_E2E_PROCESS_TIMEOUT_MS: String(timeoutMs),
      },
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    })
    const stdout = `${child.stdout || ''}\n${child.stderr || ''}`
    writeFileSync(join(outputDir, 'process.stdout.log'), stdout)
    const report = reportFromChild(stdout, outputDir)
    const infrastructureError = Boolean(child.error) || child.signal !== null || child.status === null
    const runnerLogPath = join(outputDir, 'runner.log')
    const runnerLog = existsSync(runnerLogPath) ? readFileSync(runnerLogPath, 'utf8') : ''
    const diagnosticText = `${stdout}\n${runnerLog}`
    const rateLimited = /HTTP\/1\.1 429|usage_limit_reached|model_cooldown/i.test(diagnosticText)
    const providerMisconfigured = /LLM Provider NOT provided|BadRequestError/i.test(diagnosticText)
    const fixtureDir = join(root, '.official-fixtures', 'batch-10', capability)
    const fixtureScenarioId = existsSync(fixtureDir)
      ? readdirSync(fixtureDir).filter((name) => name.endsWith('.json')).sort()[scenarioIndex]?.replace(/\.json$/, '')
      : null
    const eventCount = existsSync(eventPath)
      ? readFileSync(eventPath, 'utf8').split(/\r?\n/).filter(Boolean).length
      : 0
    results.push({
      capability,
      scenarioIndex,
      scenarioId: fixtureScenarioId || report.sourceScenarioId || report.scenarioId || null,
      status: infrastructureError || rateLimited
        ? 'infrastructure_error'
        : providerMisconfigured ? 'configuration_error' : report.status,
      failureClass: infrastructureError
        ? (child.error?.code === 'ETIMEDOUT' ? 'timeout' : 'process_error')
        : rateLimited ? 'model_rate_limit' : providerMisconfigured ? 'provider_configuration' : (report.status === 'passed' ? null : 'judge_failure'),
      score: infrastructureError ? null : (report.score ?? null),
      validationPassed: report.validationPassed ?? false,
      eventCount,
      exitCode: child.status,
      error: child.error?.message || report.error || (rateLimited ? 'model usage limit/cooldown' : providerMisconfigured ? 'LLM provider configuration error' : null),
      outputDir,
    })
  }
}

const report = {
  schemaVersion: 'gaia2-official-batch-v1',
  status: results.every((result) => result.status === 'passed') ? 'passed' : 'failed',
  mode: 'official-are-original-scenario-full-batch',
  model: 'gpt-6-luna',
  scenarios: results.length,
  attemptsPerScenario: 1,
  capabilities,
  indices,
  results,
  generatedAt: new Date().toISOString(),
}
const reportPath = join(root, 'reports', 'gaia2-official-batch-10.json')
mkdirSync(dirname(reportPath), { recursive: true })
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (report.status !== 'passed') process.exitCode = 2
