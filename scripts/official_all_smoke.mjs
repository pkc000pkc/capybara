import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const capabilities = (process.env.GAIA2_E2E_CAPABILITIES || 'execution,search,adaptability,time,ambiguity').split(',').map((item) => item.trim()).filter(Boolean)
const runs = Math.max(1, Number(process.env.GAIA2_E2E_NUM_RUNS || 1))
const results = []
for (const capability of capabilities) {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'official_e2e_smoke.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GAIA2_E2E_CAPABILITY: capability, GAIA2_E2E_NUM_RUNS: String(runs) },
    timeout: Number(process.env.GAIA2_E2E_ALL_TIMEOUT_MS || 900000),
    maxBuffer: 32 * 1024 * 1024,
  })
  const reportPath = join(root, 'reports', 'gaia2-official-e2e-smoke.json')
  let report = null
  if (existsSync(reportPath)) {
    try { report = JSON.parse(readFileSync(reportPath, 'utf8')) } catch { report = null }
  }
  results.push({ capability, status: report?.status || (result.status === 0 ? 'passed' : 'failed'), exitCode: result.status, error: result.error?.message, report })
}
const aggregate = { status: results.every((item) => item.status === 'passed') ? 'passed' : 'failed', mode: 'official-are-capability-smoke', runsPerCapability: runs, capabilities: results, generatedAt: new Date().toISOString() }
const reportsDir = join(root, 'reports')
mkdirSync(reportsDir, { recursive: true })
writeFileSync(join(reportsDir, 'gaia2-official-all-smoke.json'), `${JSON.stringify(aggregate, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(aggregate, null, 2)}\n`)
if (aggregate.status !== 'passed') process.exitCode = 2
